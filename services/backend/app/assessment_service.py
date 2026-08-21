from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import threading
import uuid

from .advisor import AdvisorService
from .knowledge_advisor import KnowledgeAdvisorService
from .providers import KnowledgeAdvisorProvider, ProviderError, RenovationProvider, VisionProvider, provider_from_environment, renovation_provider_from_environment
from .providers.renovation import RENOVATION_PROMPT_VERSION
from .repositories import SQLiteRepository, decode_json_row, token_hash, utc_now
from .rules import RuleStore
from .scoring import calculate_coverage, score_risks


ALLOWED_INPUT_MODES = {"photo", "video_frame"}
ALLOWED_MEDIA_SOURCES = {"photo", "video_frame", "h5_camera_frame", "ios_camera_frame", "ios_ar_frame"}
ALLOWED_ORIENTATIONS = {"up", "right", "down", "left"}
ALLOWED_ROOMS = {"bathroom", "bedroom", "living_room", "kitchen", "corridor", "balcony"}
SUPPORTED_ROOMS = set(ALLOWED_ROOMS)
ALLOWED_FEEDBACK = {"not_a_risk", "location_inaccurate", "photo_unclear", "already_resolved", "other", "confirmed"}
MIME_SIGNATURES = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),
}
UNVERIFIED_MEASUREMENT_PATTERN = re.compile(
    r"(?:约|大约|仅|达到|为)?\s*\d+(?:\.\d+)?\s*(lux|lx|cm|mm|厘米|毫米)",
    re.IGNORECASE,
)


class AssessmentError(RuntimeError):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class AssessmentService:
    def __init__(
        self,
        repository: SQLiteRepository,
        media_root: Path,
        rules: RuleStore | None = None,
        provider: VisionProvider | None = None,
        renovation_provider: RenovationProvider | None = None,
        knowledge_advisor_provider: KnowledgeAdvisorProvider | None = None,
    ) -> None:
        self.repository = repository
        self.media_root = media_root
        self.media_root.mkdir(parents=True, exist_ok=True)
        self.rules = rules or RuleStore()
        self._provider = provider
        self._renovation_provider = renovation_provider
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="anju-assessment")
        self._camera_lock = threading.Lock()
        self._provider_lock = threading.Lock()
        self._camera_inflight: set[str] = set()
        self.turbo_max_concurrency = self._positive_int_env("ANJU_TURBO_MAX_CONCURRENCY", 2)
        self.pro_max_concurrency = self._positive_int_env("ANJU_PRO_MAX_CONCURRENCY", 1)
        self._turbo_slots = threading.BoundedSemaphore(self.turbo_max_concurrency)
        self._pro_slots = threading.BoundedSemaphore(self.pro_max_concurrency)
        self.advisor = AdvisorService(self)
        self.knowledge_advisor = KnowledgeAdvisorService(self, repository, knowledge_advisor_provider)
        self._recover_interrupted_analyses()
        self._recover_interrupted_renovation_previews()
        self.advisor.recover_interrupted_confirmations()

    def close(self) -> None:
        self.knowledge_advisor.close()
        self._executor.shutdown(wait=False, cancel_futures=True)

    @staticmethod
    def error(code: str, status: int = 400) -> AssessmentError:
        return AssessmentError(code, status)

    def create_assessment(self, payload: dict) -> dict:
        input_mode = payload.get("input_mode", "photo")
        if input_mode not in ALLOWED_INPUT_MODES:
            raise AssessmentError("invalid_input_mode")
        if input_mode == "video_frame" and os.environ.get("ANJU_ENABLE_H5_VIDEO", "0") != "1":
            raise AssessmentError("video_not_enabled", 404)
        assessment_id = str(uuid.uuid4())
        access_token = secrets.token_urlsafe(32)
        now = utc_now()
        planned_rooms = payload.get("planned_rooms", [])
        if not isinstance(planned_rooms, list) or any(item not in ALLOWED_ROOMS for item in planned_rooms):
            planned_rooms = []
        self.repository.insert("assessments", {
            "id": assessment_id, "token_hash": token_hash(access_token), "input_mode": input_mode,
            "status": "draft", "profile_json": "{}", "planned_rooms_json": json.dumps(planned_rooms),
            "rule_set_version": self.rules.rule_set_version, "price_rule_version": self.rules.price_rule_version,
            "created_at": now, "updated_at": now,
        })
        self.event(assessment_id, None, "assessment_started", {"input_mode": input_mode})
        return {"assessment_id": assessment_id, "access_token": access_token, "status": "draft", "rule_set_version": self.rules.rule_set_version, "price_rule_version": self.rules.price_rule_version}

    def authorize(self, assessment_id: str, token: str) -> None:
        if not self.repository.authorize(assessment_id, token):
            raise AssessmentError("assessment_access_denied", 404)

    def assessment(self, assessment_id: str) -> dict:
        row = self.repository.fetchone("SELECT * FROM assessments WHERE id=?", (assessment_id,))
        if not row:
            raise AssessmentError("assessment_not_found", 404)
        value = decode_json_row(row, ("profile_json", "planned_rooms_json"))
        rooms = self.repository.fetchall("SELECT * FROM rooms WHERE assessment_id=? ORDER BY created_at", (assessment_id,))
        value["assessment_id"] = value.pop("id")
        value["planned_rooms"] = list(value.get("planned_rooms", value.get("planned_rooms_json", [])))
        value["rooms"] = [self._room_summary(item) for item in rooms]
        value.pop("token_hash", None)
        return value

    def save_profile(self, assessment_id: str, payload: dict) -> dict:
        profile = {
            "mobility": payload.get("mobility"),
            "fall_history": payload.get("fall_history"),
            "living_status": payload.get("living_status"),
            "profile_version": "profile_v1",
        }
        profile_rules = self.rules.profile_document
        for key in ("mobility", "fall_history", "living_status"):
            if profile[key] not in profile_rules[key]:
                raise AssessmentError("profile_incomplete")
        self.repository.execute("UPDATE assessments SET profile_json=?, status='profile_completed', updated_at=? WHERE id=?", (json.dumps(profile), utc_now(), assessment_id))
        self.event(assessment_id, None, "profile_completed", {})
        return profile

    def save_planned_rooms(self, assessment_id: str, planned_rooms: list[str]) -> dict:
        if not isinstance(planned_rooms, list) or not planned_rooms:
            raise AssessmentError("invalid_room_type")
        unique_rooms = list(dict.fromkeys(planned_rooms))
        if len(unique_rooms) != len(planned_rooms) or any(item not in ALLOWED_ROOMS for item in unique_rooms):
            raise AssessmentError("invalid_room_type")
        self.repository.execute(
            "UPDATE assessments SET planned_rooms_json=?, updated_at=? WHERE id=?",
            (json.dumps(unique_rooms), utc_now(), assessment_id),
        )
        self.event(assessment_id, None, "planned_rooms_saved", {"room_types": unique_rooms})
        return {"planned_rooms": unique_rooms}

    def create_room(self, assessment_id: str, payload: dict) -> dict:
        room_type = payload.get("room_type")
        if room_type not in ALLOWED_ROOMS:
            raise AssessmentError("invalid_room_type")
        existing = self.repository.fetchone("SELECT * FROM rooms WHERE assessment_id=? AND room_type=? ORDER BY created_at DESC LIMIT 1", (assessment_id, room_type))
        if existing and existing["status"] != "completed":
            return self._room_summary(existing)
        room_id = str(uuid.uuid4())
        now = utc_now()
        self.repository.insert("rooms", {"id": room_id, "assessment_id": assessment_id, "room_type": room_type, "status": "collecting_media", "coverage_percent": 0, "score": None, "result_json": "{}", "created_at": now, "updated_at": now})
        self.repository.execute("UPDATE assessments SET status='collecting_media', updated_at=? WHERE id=?", (now, assessment_id))
        self.event(assessment_id, room_id, "room_selected", {"room_type": room_type})
        created = self.repository.fetchone("SELECT * FROM rooms WHERE id=?", (room_id,))
        return self._room_summary(created)

    def upload_media(
        self, assessment_id: str, room_id: str, body: bytes, mime_type: str, width: int, height: int,
        metadata: dict | None = None,
    ) -> dict:
        room = self._owned_room(assessment_id, room_id)
        if room["room_type"] not in SUPPORTED_ROOMS:
            raise AssessmentError("room_rules_not_ready", 409)
        if mime_type not in MIME_SIGNATURES or not any(body.startswith(signature) for signature in MIME_SIGNATURES[mime_type]):
            raise AssessmentError("invalid_image_format")
        if mime_type == "image/webp" and body[8:12] != b"WEBP":
            raise AssessmentError("invalid_image_format")
        if not (1 <= width <= 8192 and 1 <= height <= 8192):
            raise AssessmentError("invalid_image_dimensions")
        count = self.repository.fetchone("SELECT COUNT(*) AS value FROM media WHERE room_id=?", (room_id,))["value"]
        if count >= 6:
            raise AssessmentError("too_many_images")
        source = self._validate_media_metadata(metadata or {})
        media_id = str(uuid.uuid4())
        extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime_type]
        directory = self.media_root / assessment_id
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{media_id}{extension}"
        path.write_bytes(body)
        media_input = {"media_id": media_id, "path": str(path), "mime_type": mime_type, "room_type": room["room_type"]}
        try:
            with self._model_slot("pro", assessment_id, room_id, "media_quality"):
                quality, usage = self.provider().quality(assessment_id, media_input)
            quality = self._validate_quality(quality, room["room_type"])
            self.event(assessment_id, room_id, "ai_call_completed", {"skill_name": "media_quality", **usage})
        except ProviderError as error:
            quality = {"usable": False, "clear": False, "floor_visible": False, "path_visible": False, "lighting_sufficient": False, "major_occlusion": False, "scene_elements": [], "missing_element_ids": [], "missing_views": [], "error": error.code}
            self.event(assessment_id, room_id, "ai_call_failed", {"skill_name": "media_quality", "error_type": error.code})
        self.repository.insert("media", {
            "id": media_id, "assessment_id": assessment_id, "room_id": room_id, "mime_type": mime_type,
            "path": str(path), "width": width, "height": height, "quality_json": json.dumps(quality, ensure_ascii=False),
            **source, "created_at": utc_now(),
        })
        self.event(assessment_id, room_id, "media_upload_completed", {"media_id": media_id, "usable": quality["usable"], "source_kind": source["source_kind"]})
        return {"media_id": media_id, "mime_type": mime_type, "width": width, "height": height, "quality": quality, **source, "content_path": f"/api/v2/assessments/{assessment_id}/media/{media_id}/content"}

    def delete_media(self, assessment_id: str, room_id: str, media_id: str) -> None:
        row = self.repository.fetchone("SELECT * FROM media WHERE id=? AND room_id=? AND assessment_id=?", (media_id, room_id, assessment_id))
        if not row:
            raise AssessmentError("media_not_found", 404)
        Path(row["path"]).unlink(missing_ok=True)
        self.repository.execute("DELETE FROM media WHERE id=?", (media_id,))

    def media_content(self, assessment_id: str, media_id: str) -> tuple[Path, str]:
        row = self.repository.fetchone("SELECT path,mime_type FROM media WHERE id=? AND assessment_id=?", (media_id, assessment_id))
        if not row or not Path(row["path"]).is_file():
            raise AssessmentError("media_not_found", 404)
        return Path(row["path"]), row["mime_type"]

    def start_analysis(self, assessment_id: str, room_id: str) -> dict:
        room = self._owned_room(assessment_id, room_id)
        assessment = self.repository.fetchone("SELECT profile_json FROM assessments WHERE id=?", (assessment_id,))
        profile = json.loads(assessment["profile_json"] or "{}") if assessment else {}
        if any(not profile.get(key) for key in ("mobility", "fall_history", "living_status")):
            raise AssessmentError("profile_incomplete", 409)
        if room["room_type"] not in SUPPORTED_ROOMS:
            raise AssessmentError("room_rules_not_ready", 409)
        media = self._media(room_id)
        if not any(item["quality"].get("usable") for item in media):
            raise AssessmentError("no_usable_media")
        job_id = str(uuid.uuid4())
        now = utc_now()
        with self.repository.transaction() as connection:
            active = connection.execute(
                "SELECT * FROM jobs WHERE room_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
                (room_id,),
            ).fetchone()
            if active:
                return {
                    "job_id": active["id"], "status": active["status"],
                    "stage": active["stage"], "reused": True,
                }
            connection.execute(
                "INSERT INTO jobs (id,assessment_id,room_id,status,stage,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (job_id, assessment_id, room_id, "queued", "quality_checked", None, now, now),
            )
            connection.execute("UPDATE rooms SET status='analyzing', updated_at=? WHERE id=?", (now, room_id))
            connection.execute("UPDATE assessments SET status='analyzing', updated_at=? WHERE id=?", (now, assessment_id))
        self._best_effort_event(assessment_id, room_id, "analysis_started", {"job_id": job_id})
        try:
            self._executor.submit(self._analyze, assessment_id, room_id, job_id)
        except Exception:
            self._fail_analysis(assessment_id, room_id, job_id, "analysis_start_failed")
            raise AssessmentError("analysis_start_failed", 503)
        return {"job_id": job_id, "status": "queued", "stage": "quality_checked", "reused": False}

    def analysis_status(self, assessment_id: str, room_id: str) -> dict:
        self._owned_room(assessment_id, room_id)
        row = self.repository.fetchone("SELECT * FROM jobs WHERE room_id=? ORDER BY created_at DESC LIMIT 1", (room_id,))
        if not row:
            return {"status": "not_started", "stage": "collecting_media", "error": None}
        return {"job_id": row["id"], "status": row["status"], "stage": row["stage"], "error": row["error"], "updated_at": row["updated_at"]}

    def room_result(self, assessment_id: str, room_id: str) -> dict:
        room = self._owned_room(assessment_id, room_id)
        if room["status"] not in {"result_ready", "completed"}:
            raise AssessmentError("result_not_ready", 409)
        return self._compute_result(assessment_id, room_id)

    def feedback(self, assessment_id: str, risk_id: str, payload: dict) -> dict:
        risk = self._owned_risk(assessment_id, risk_id)
        feedback = payload.get("feedback")
        if feedback not in ALLOWED_FEEDBACK:
            raise AssessmentError("invalid_feedback")
        states = {"not_a_risk": "rejected", "already_resolved": "resolved_pending_recheck", "confirmed": "confirmed"}
        state = states.get(feedback, risk["state"])
        now = utc_now()
        self.repository.execute("UPDATE risks SET feedback=?, state=?, updated_at=? WHERE id=?", (feedback, state, now, risk_id))
        self.event(assessment_id, risk["room_id"], "risk_feedback_submitted", {"risk_id": risk_id, "feedback": feedback})
        result = self._compute_result(assessment_id, risk["room_id"])
        return {"risk_id": risk_id, "state": state, "feedback": feedback, "score": result["score"]}

    def update_region(self, assessment_id: str, risk_id: str, region: dict) -> dict:
        risk = self._owned_risk(assessment_id, risk_id)
        value = self._validate_region(region)
        self.repository.execute("UPDATE risks SET region_json=?, feedback='location_inaccurate', updated_at=? WHERE id=?", (json.dumps(value), utc_now(), risk_id))
        self.event(assessment_id, risk["room_id"], "risk_region_adjusted", {"risk_id": risk_id})
        return {"risk_id": risk_id, "region": value}

    def risk_solutions(self, assessment_id: str, risk_id: str) -> dict:
        risk = self._owned_risk(assessment_id, risk_id)
        selected = self.repository.fetchone("SELECT solution_package_id FROM selected_solutions WHERE risk_id=?", (risk_id,))
        return {"risk_id": risk_id, "solutions": self.rules.solutions_for(risk["risk_code"]), "selected_solution_package_id": selected["solution_package_id"] if selected else None, "price_disclaimer": self.rules.price_document["disclaimer"]}

    def select_solution(self, assessment_id: str, risk_id: str, solution_id: str) -> dict:
        risk = self._owned_risk(assessment_id, risk_id)
        allowed = {item["solution_package_id"] for item in self.rules.solutions_for(risk["risk_code"])}
        if solution_id not in allowed:
            raise AssessmentError("solution_not_allowed")
        now = utc_now()
        self.repository.execute(
            "INSERT INTO selected_solutions (id,assessment_id,risk_id,solution_package_id,status,created_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT(risk_id) DO UPDATE SET "
            "solution_package_id=excluded.solution_package_id,status=excluded.status,created_at=excluded.created_at",
            (str(uuid.uuid4()), assessment_id, risk_id, solution_id, "todo", now),
        )
        self.event(assessment_id, risk["room_id"], "solution_added_to_plan", {"risk_id": risk_id, "solution_package_id": solution_id})
        return self.report(assessment_id)

    def remove_solution(self, assessment_id: str, risk_id: str) -> None:
        self._owned_risk(assessment_id, risk_id)
        self.repository.execute("DELETE FROM selected_solutions WHERE risk_id=?", (risk_id,))

    def renovation_preview_context(self, assessment_id: str, room_id: str) -> dict:
        if os.environ.get("ANJU_ENABLE_RENOVATION_PREVIEW", "0") != "1":
            raise AssessmentError("renovation_preview_not_enabled", 404)
        room = self._owned_room(assessment_id, room_id)
        snapshot, selection_hash = self._renovation_selection_snapshot(assessment_id, room_id)
        media = [item for item in self._media(room_id) if item["quality"].get("usable") and item.get("source_kind") in {"photo", "h5_camera_frame", "ios_camera_frame"}]
        selected_risks = {item["risk_id"]: item for item in snapshot}
        evidence_counts: dict[str, int] = {item["media_id"]: 0 for item in media}
        total_counts: dict[str, int] = {item["media_id"]: 0 for item in media}
        for risk in self._risks(room_id):
            evidence_ids = list(dict.fromkeys([risk["media_id"], *risk.get("evidence_media_ids", [])]))
            for media_id in evidence_ids:
                if media_id in total_counts:
                    total_counts[media_id] += 1
                    if risk["risk_id"] in selected_risks:
                        evidence_counts[media_id] += 1
        media.sort(key=lambda item: (
            -evidence_counts[item["media_id"]], -total_counts[item["media_id"]],
            -(int(item.get("width") or 0) * int(item.get("height") or 0)), item["media_id"],
        ))
        candidates = [{
            "media_id": item["media_id"], "mime_type": item["mime_type"], "width": item["width"], "height": item["height"],
            "content_path": item["content_path"], "recommended": index == 0,
            "selected_risk_evidence_count": evidence_counts[item["media_id"]],
        } for index, item in enumerate(media)]
        previews = [self._serialize_renovation_preview(row, selection_hash) for row in self.repository.fetchall(
            "SELECT * FROM renovation_previews WHERE assessment_id=? AND room_id=? ORDER BY created_at DESC LIMIT 3",
            (assessment_id, room_id),
        )]
        return {
            "room_id": room_id, "room_type": room["room_type"], "selection_hash": selection_hash,
            "selected_solutions": self._public_renovation_snapshot(snapshot), "eligible_media": candidates, "previews": previews,
            "disclaimer": self._renovation_disclaimer(),
        }

    def create_renovation_preview(self, assessment_id: str, room_id: str, source_media_id: str) -> dict:
        if os.environ.get("ANJU_ENABLE_RENOVATION_PREVIEW", "0") != "1":
            raise AssessmentError("renovation_preview_not_enabled", 404)
        self._owned_room(assessment_id, room_id)
        source = self.repository.fetchone(
            "SELECT * FROM media WHERE id=? AND assessment_id=? AND room_id=?",
            (source_media_id, assessment_id, room_id),
        )
        if not source:
            raise AssessmentError("renovation_source_not_found", 404)
        quality = json.loads(source["quality_json"] or "{}")
        if not quality.get("usable") or source.get("source_kind") not in {"photo", "h5_camera_frame", "ios_camera_frame"}:
            raise AssessmentError("renovation_source_not_usable", 422)
        snapshot, selection_hash = self._renovation_selection_snapshot(assessment_id, room_id)
        if not snapshot:
            raise AssessmentError("renovation_no_selected_solutions", 409)
        visualized = [action for item in snapshot for action in item["visualizable_actions"]]
        if not visualized:
            raise AssessmentError("renovation_no_visualizable_actions", 422)
        active = self.repository.fetchone(
            "SELECT id FROM renovation_previews WHERE room_id=? AND status IN ('queued','running') LIMIT 1",
            (room_id,),
        )
        if active:
            raise AssessmentError("renovation_preview_in_progress", 409)
        daily_limit = self._positive_int_env("ANJU_RENOVATION_PREVIEW_DAILY_LIMIT", 3)
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        recent = self.repository.fetchone(
            "SELECT COUNT(*) AS value FROM renovation_previews WHERE room_id=? AND created_at>=?",
            (room_id, cutoff),
        )
        if recent and int(recent["value"]) >= daily_limit:
            raise AssessmentError("renovation_preview_daily_limit", 429)
        self._trim_renovation_previews(assessment_id, room_id, keep=2)
        preview_id = str(uuid.uuid4())
        now = utc_now()
        skipped = [action for item in snapshot if not item["visualizable_actions"] for action in item["actions"]]
        try:
            self.repository.insert("renovation_previews", {
                "id": preview_id, "assessment_id": assessment_id, "room_id": room_id, "source_media_id": source_media_id,
                "selection_snapshot_json": json.dumps(snapshot, ensure_ascii=False), "selection_hash": selection_hash,
                "status": "queued", "stage": "preparing_source", "error": None, "provider": None, "model": None,
                "prompt_version": RENOVATION_PROMPT_VERSION, "rule_set_version": self.rules.rule_set_version,
                "visualized_actions_json": json.dumps(visualized, ensure_ascii=False), "skipped_actions_json": json.dumps(skipped, ensure_ascii=False),
                "output_path": None, "output_mime_type": None, "selected_for_report": 0,
                "created_at": now, "updated_at": now,
            })
        except sqlite3.IntegrityError as error:
            raise AssessmentError("renovation_preview_in_progress", 409) from error
        self._best_effort_event(assessment_id, room_id, "renovation_preview_started", {
            "preview_id": preview_id, "source_media_id": source_media_id,
            "action_codes": [item["action_code"] for item in visualized],
        })
        try:
            self._executor.submit(self._generate_renovation_preview, preview_id)
        except RuntimeError:
            self._fail_renovation_preview(preview_id, "renovation_preview_start_failed")
        row = self.repository.fetchone("SELECT * FROM renovation_previews WHERE id=?", (preview_id,))
        return self._serialize_renovation_preview(row, selection_hash)

    def renovation_preview(self, assessment_id: str, room_id: str, preview_id: str) -> dict:
        if os.environ.get("ANJU_ENABLE_RENOVATION_PREVIEW", "0") != "1":
            raise AssessmentError("renovation_preview_not_enabled", 404)
        self._owned_room(assessment_id, room_id)
        row = self.repository.fetchone(
            "SELECT * FROM renovation_previews WHERE id=? AND assessment_id=? AND room_id=?",
            (preview_id, assessment_id, room_id),
        )
        if not row:
            raise AssessmentError("renovation_preview_not_found", 404)
        _, current_hash = self._renovation_selection_snapshot(assessment_id, room_id)
        return self._serialize_renovation_preview(row, current_hash)

    def select_renovation_preview(self, assessment_id: str, room_id: str, preview_id: str) -> dict:
        preview = self.renovation_preview(assessment_id, room_id, preview_id)
        if preview["status"] != "completed":
            raise AssessmentError("renovation_preview_not_ready", 409)
        if preview["stale"]:
            raise AssessmentError("renovation_preview_stale", 409)
        with self.repository.transaction() as connection:
            connection.execute("UPDATE renovation_previews SET selected_for_report=0,updated_at=? WHERE room_id=?", (utc_now(), room_id))
            connection.execute("UPDATE renovation_previews SET selected_for_report=1,updated_at=? WHERE id=?", (utc_now(), preview_id))
        self._best_effort_event(assessment_id, room_id, "renovation_preview_selected", {"preview_id": preview_id})
        return self.renovation_preview(assessment_id, room_id, preview_id)

    def renovation_preview_content(self, assessment_id: str, room_id: str, preview_id: str) -> tuple[Path, str]:
        if os.environ.get("ANJU_ENABLE_RENOVATION_PREVIEW", "0") != "1":
            raise AssessmentError("renovation_preview_not_enabled", 404)
        row = self.repository.fetchone(
            "SELECT output_path,output_mime_type,status FROM renovation_previews WHERE id=? AND assessment_id=? AND room_id=?",
            (preview_id, assessment_id, room_id),
        )
        if not row or row["status"] != "completed" or not row["output_path"] or not Path(row["output_path"]).is_file():
            raise AssessmentError("renovation_preview_not_found", 404)
        return Path(row["output_path"]), str(row["output_mime_type"])

    def complete(self, assessment_id: str) -> dict:
        self.repository.execute("UPDATE assessments SET status='completed', updated_at=? WHERE id=?", (utc_now(), assessment_id))
        return self.report(assessment_id)

    def report(self, assessment_id: str) -> dict:
        assessment = self.assessment(assessment_id)
        rooms = self.repository.fetchall("SELECT * FROM rooms WHERE assessment_id=? AND status IN ('result_ready','completed')", (assessment_id,))
        room_results = [self._compute_result(assessment_id, item["id"]) for item in rooms]
        weights = self.rules.coverage_document["room_weights"]
        coverage = round(sum(weights.get(item["room_type"], 0) * item["coverage"]["percent"] / 100 for item in room_results))
        weighted_score = sum(item["score"] * weights.get(item["room_type"], 0) for item in room_results)
        weight_sum = sum(weights.get(item["room_type"], 0) for item in room_results)
        assessed_score = round(weighted_score / weight_sum) if weight_sum else None
        selections = self.repository.fetchall("SELECT ss.*,r.title AS risk_title,r.severity,r.room_id FROM selected_solutions ss JOIN risks r ON r.id=ss.risk_id WHERE ss.assessment_id=?", (assessment_id,))
        selected_items: list[dict] = []
        selected_by_risk: dict[str, str] = {}
        groups: dict[str, dict] = {}
        gain_groups: dict[str, tuple[int, int]] = {}
        for row in selections:
            solution = self.rules.solution_for_output(row["solution_package_id"])
            price = dict(self.rules.prices[solution["price_rule_id"]])
            item = {"selected_solution_id": row["id"], "risk_id": row["risk_id"], "risk_title": row["risk_title"], "severity": row["severity"], "status": row["status"], "solution": {**solution, "price": price}}
            selected_items.append(item)
            selected_by_risk[row["risk_id"]] = row["solution_package_id"]
            groups.setdefault(solution["budget_group_id"], price)
            gain_groups.setdefault(solution["budget_group_id"], (solution["expected_score_gain_min"], solution["expected_score_gain_max"]))
        budget = {
            "currency": "CNY", "total_min": sum(item["total_min"] for item in groups.values()), "total_max": sum(item["total_max"] for item in groups.values()),
            "material_min": sum(item["material_min"] for item in groups.values()), "material_max": sum(item["material_max"] for item in groups.values()),
            "labor_min": sum(item["labor_min"] for item in groups.values()), "labor_max": sum(item["labor_max"] for item in groups.values()), "unknown_items": [],
        }
        gain_min = sum(item[0] for item in gain_groups.values())
        gain_max = sum(item[1] for item in gain_groups.values())
        projected = None if assessed_score is None else {"current": assessed_score, "min": min(100, assessed_score + gain_min), "max": min(100, assessed_score + gain_max), "display": min(100, assessed_score + gain_min)}
        recommendations = []
        for room_result in room_results:
            for risk in room_result["risks"]:
                recommendations.append({
                    "risk_id": risk["risk_id"],
                    "risk_title": risk["title"],
                    "room_id": room_result["room_id"],
                    "room_type": room_result["room_type"],
                    "selected_solution_package_id": selected_by_risk.get(risk["risk_id"]),
                    "solutions": self.rules.solutions_for(risk["risk_code"]),
                })
        planned_rooms = assessment.get("planned_rooms", assessment.get("planned_rooms_json", []))
        planned_room_count = len(planned_rooms) if planned_rooms else len(assessment.get("rooms", []))
        return {
            "assessment_id": assessment_id, "status": assessment["status"], "checked_room_count": len(room_results), "planned_room_count": planned_room_count,
            "coverage_percent": coverage, "score_title": "家庭安全参考分" if coverage >= 80 else "当前已检查区域安全参考分",
            "assessed_area_score": assessed_score, "household_score": assessed_score if coverage >= 80 else None,
            "rooms": room_results, "selected_items": selected_items, "recommendations": recommendations, "budget": budget, "projected_score": projected,
            "renovation_previews": self._report_renovation_previews(assessment_id),
            "price_disclaimer": self.rules.price_document["disclaimer"], "rule_set_version": self.rules.rule_set_version, "price_rule_version": self.rules.price_rule_version,
        }

    def create_share(self, assessment_id: str) -> dict:
        token = secrets.token_urlsafe(24)
        hours = max(1, min(168, int(os.environ.get("ANJU_SHARE_TTL_HOURS", "24"))))
        expires = datetime.now(timezone.utc) + timedelta(hours=hours)
        self.repository.insert("shares", {"token_hash": token_hash(token), "assessment_id": assessment_id, "expires_at": expires.isoformat(), "revoked": 0, "created_at": utc_now()})
        self.event(assessment_id, None, "report_shared", {})
        return {"token": token, "path": f"/#/share/{token}", "expires_at": expires.isoformat()}

    def shared_report(self, token: str) -> dict:
        row = self.repository.fetchone("SELECT * FROM shares WHERE token_hash=? AND revoked=0", (token_hash(token),))
        if not row or datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc):
            raise AssessmentError("share_expired", 404)
        report = self.report(row["assessment_id"])
        value = {key: report[key] for key in ("status", "checked_room_count", "planned_room_count", "coverage_percent", "score_title", "assessed_area_score", "household_score", "rooms", "selected_items", "recommendations", "budget", "projected_score", "renovation_previews", "price_disclaimer")}
        for preview in value["renovation_previews"]:
            base = f"/api/v2/shared-reports/{token}/renovation-previews/{preview['preview_id']}"
            preview["before_content_path"] = f"{base}/before"
            preview["after_content_path"] = f"{base}/after"
        return value

    def shared_renovation_preview_content(self, token: str, preview_id: str, kind: str) -> tuple[Path, str]:
        if os.environ.get("ANJU_ENABLE_RENOVATION_PREVIEW", "0") != "1":
            raise AssessmentError("renovation_preview_not_enabled", 404)
        share = self.repository.fetchone("SELECT * FROM shares WHERE token_hash=? AND revoked=0", (token_hash(token),))
        if not share or datetime.fromisoformat(share["expires_at"]) <= datetime.now(timezone.utc):
            raise AssessmentError("share_expired", 404)
        preview = self.repository.fetchone(
            "SELECT * FROM renovation_previews WHERE id=? AND assessment_id=? AND selected_for_report=1 AND status='completed'",
            (preview_id, share["assessment_id"]),
        )
        if not preview:
            raise AssessmentError("renovation_preview_not_found", 404)
        _, current_hash = self._renovation_selection_snapshot(share["assessment_id"], preview["room_id"])
        if preview["selection_hash"] != current_hash:
            raise AssessmentError("renovation_preview_stale", 404)
        if kind == "after":
            path, mime_type = preview["output_path"], preview["output_mime_type"]
        elif kind == "before":
            source = self.repository.fetchone("SELECT path,mime_type FROM media WHERE id=? AND assessment_id=?", (preview["source_media_id"], share["assessment_id"]))
            path, mime_type = (source["path"], source["mime_type"]) if source else (None, None)
        else:
            raise AssessmentError("renovation_preview_not_found", 404)
        if not path or not Path(path).is_file():
            raise AssessmentError("renovation_preview_not_found", 404)
        return Path(path), str(mime_type)

    def delete_assessment(self, assessment_id: str) -> None:
        self.repository.execute("DELETE FROM assessments WHERE id=?", (assessment_id,))
        directory = self.media_root / assessment_id
        if directory.exists():
            shutil.rmtree(directory)

    def event(self, assessment_id: str | None, room_id: str | None, name: str, payload: dict) -> None:
        safe_payload = {key: value for key, value in payload.items() if key not in {"image", "api_key", "profile", "prompt"}}
        self.repository.insert("analytics_events", {"id": str(uuid.uuid4()), "assessment_id": assessment_id, "room_id": room_id, "event_name": name, "payload_json": json.dumps(safe_payload, ensure_ascii=False), "created_at": utc_now()})

    def _best_effort_event(self, assessment_id: str | None, room_id: str | None, name: str, payload: dict) -> None:
        """Keep analytics failures from changing a completed user-facing operation."""
        try:
            self.event(assessment_id, room_id, name, payload)
        except Exception:
            return

    def provider(self) -> VisionProvider:
        with self._provider_lock:
            if self._provider is None:
                self._provider = provider_from_environment()
        return self._provider

    def renovation_provider(self) -> RenovationProvider:
        with self._provider_lock:
            if self._renovation_provider is None:
                self._renovation_provider = renovation_provider_from_environment()
        return self._renovation_provider

    @staticmethod
    def _positive_int_env(name: str, default: int) -> int:
        try:
            value = int(os.environ.get(name, str(default)))
        except ValueError:
            return default
        return value if value > 0 else default

    @contextmanager
    def _model_slot(self, lane: str, assessment_id: str, room_id: str | None, skill_name: str):
        semaphore = self._turbo_slots if lane == "turbo" else self._pro_slots
        limit = self.turbo_max_concurrency if lane == "turbo" else self.pro_max_concurrency
        if lane == "turbo":
            acquired = semaphore.acquire(blocking=False)
            if not acquired:
                self.event(assessment_id, room_id, "ai_call_rejected", {
                    "skill_name": skill_name, "error_type": "provider_capacity_busy",
                    "capacity_lane": lane, "capacity_limit": limit,
                })
                raise ProviderError("provider_capacity_busy", True)
        else:
            acquired = semaphore.acquire(blocking=False)
            if not acquired:
                self.event(assessment_id, room_id, "ai_call_queued", {
                    "skill_name": skill_name, "capacity_lane": lane, "capacity_limit": limit,
                })
                semaphore.acquire()
                acquired = True
        try:
            yield
        finally:
            if acquired:
                semaphore.release()

    def inspect_camera_frame(
        self, assessment_id: str, body: bytes, mime_type: str, width: int, height: int, payload: dict,
        *, room_id: str | None = None, native: bool = False,
    ) -> dict:
        enabled_variable = "ANJU_ENABLE_IOS_HOME_CAMERA" if native else "ANJU_ENABLE_H5_CAMERA"
        if os.environ.get(enabled_variable, "0") != "1":
            raise AssessmentError("ios_home_camera_not_enabled" if native else "camera_not_enabled", 404)
        if room_id:
            room_type = self._owned_room(assessment_id, room_id)["room_type"]
        else:
            room_type = payload.get("room_type")
        if room_type not in ALLOWED_ROOMS:
            raise AssessmentError("invalid_room_type")
        if mime_type not in MIME_SIGNATURES or not any(body.startswith(signature) for signature in MIME_SIGNATURES[mime_type]):
            raise AssessmentError("invalid_image_format")
        if not (1 <= width <= 1920 and 1 <= height <= 1920):
            raise AssessmentError("invalid_image_dimensions")
        frame_id = str(payload.get("frame_id") or "")
        if not frame_id or len(frame_id) > 80:
            raise AssessmentError("invalid_camera_frame")
        with self._camera_lock:
            if assessment_id in self._camera_inflight:
                raise AssessmentError("camera_request_in_progress", 409)
            self._camera_inflight.add(assessment_id)
        suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime_type]
        temporary = self.media_root / ".camera-tmp" / f"{uuid.uuid4()}{suffix}"
        temporary.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_bytes(body)
        try:
            assessment = self.repository.fetchone("SELECT profile_json FROM assessments WHERE id=?", (assessment_id,))
            profile = json.loads(assessment["profile_json"] or "{}") if assessment else {}
            camera_rules = self.rules.live_camera_rules_for("h5_home", room_type)
            rule_catalog = {item["risk_code"]: item for item in camera_rules}
            media = {
                "media_id": frame_id, "path": str(temporary), "mime_type": mime_type, "room_type": room_type,
                "source_kind": payload.get("source_kind", "ios_camera_frame" if native else "h5_camera_frame"),
            }
            with self._model_slot("turbo", assessment_id, room_id, "camera_inspection"):
                response, usage = self.provider().inspect_camera(
                    assessment_id, room_type, media, camera_rules,
                    {key: profile.get(key) for key in ("mobility", "fall_history", "living_status") if profile.get(key)},
                    [str(item)[:80] for item in payload.get("previous_summary", []) if isinstance(item, str)][:5],
                )
            suggestions = self._validate_camera_response(response, frame_id, rule_catalog)
            if room_id:
                self.advisor.record_camera_suggestions(
                    assessment_id, room_id, payload.get("camera_session_id"), frame_id, suggestions,
                )
            raw_suggestions = response.get("suggestions", []) if isinstance(response, dict) else []
            raw_count = len(raw_suggestions) if isinstance(raw_suggestions, list) else 0
            raw_region_count = sum(
                1 for item in raw_suggestions[:5]
                if isinstance(item, dict) and item.get("region") is not None
            ) if isinstance(raw_suggestions, list) else 0
            validated_region_count = sum(1 for item in suggestions if item.get("region") is not None)
            self.event(assessment_id, room_id, "ai_call_completed", {
                "skill_name": "camera_inspection", **usage,
                "source_kind": payload.get("source_kind", "ios_camera_frame" if native else "h5_camera_frame"),
                "quality_usable": bool(response.get("quality_usable")),
                "candidate_count_raw": raw_count,
                "candidate_count_validated": len(suggestions),
                "candidate_count_rejected": max(0, raw_count - len(suggestions)),
                "candidate_count_region_raw": raw_region_count,
                "candidate_count_region_validated": validated_region_count,
                "candidate_count_region_rejected": max(0, raw_region_count - validated_region_count),
                "camera_rule_version": self.rules.live_camera_rule_version,
            })
            return {
                "frame_id": frame_id, "temporary": True, "quality_usable": bool(response.get("quality_usable")),
                "scene_elements": [
                    item for item in response.get("scene_elements", [])
                    if item in {element["id"] for element in self.rules.coverage_document["rooms"][room_type]["elements"]}
                ],
                "suggestions": suggestions, "save_as_evidence_recommended": bool(response.get("save_as_evidence_recommended") and suggestions),
                "prompt_version": usage.get("prompt_version", "anju_home_camera_discovery_v1"),
                "rule_version": self.rules.live_camera_rule_version,
            }
        except ProviderError as error:
            self.event(assessment_id, room_id, "ai_call_failed", {"skill_name": "camera_inspection", "error_type": error.code})
            raise
        finally:
            temporary.unlink(missing_ok=True)
            with self._camera_lock:
                self._camera_inflight.discard(assessment_id)

    def inspect_room_camera_frame(
        self, assessment_id: str, room_id: str, body: bytes, mime_type: str, width: int, height: int, payload: dict,
    ) -> dict:
        source_kind = str(payload.get("source_kind") or "h5_camera_frame")
        if source_kind not in {"h5_camera_frame", "ios_camera_frame"}:
            raise AssessmentError("invalid_camera_frame")
        orientation = str(payload.get("orientation") or "up")
        if orientation not in ALLOWED_ORIENTATIONS:
            raise AssessmentError("invalid_camera_frame")
        return self.inspect_camera_frame(
            assessment_id, body, mime_type, width, height, payload,
            room_id=room_id, native=source_kind == "ios_camera_frame",
        )

    def _validate_camera_response(self, value: dict, frame_id: str, rule_catalog: dict[str, dict]) -> list[dict]:
        if not isinstance(value, dict) or value.get("media_id") != frame_id or not isinstance(value.get("suggestions"), list):
            raise ProviderError("provider_invalid_response")
        accepted: list[dict] = []
        for item in value["suggestions"][:5]:
            if not isinstance(item, dict) or item.get("risk_code") not in rule_catalog or not str(item.get("evidence", "")).strip():
                continue
            confidence = item.get("confidence")
            if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
                continue
            region = item.get("region")
            try:
                region = self._validate_region(region) if region else None
            except AssessmentError:
                region = None
            rule = rule_catalog[item["risk_code"]]
            evidence = self._sanitize_unverified_measurements(str(item["evidence"]))[:240]
            accepted.append({
                "suggestion_id": str(uuid.uuid4()), "risk_code": item["risk_code"], "title": rule["title"],
                "short_advice": rule["short_advice"],
                "evidence": evidence, "confidence": float(confidence), "needs_manual_check": bool(item.get("needs_manual_check")),
                "possible_repeat": bool(item.get("possible_repeat")), "region": region, "temporary": True,
                "save_as_evidence_recommended": True,
            })
        return accepted

    @staticmethod
    def _sanitize_unverified_measurements(value: str) -> str:
        def replacement(match: re.Match[str]) -> str:
            unit = match.group(1).lower()
            return "照度需现场测量" if unit in {"lux", "lx"} else "尺寸需现场测量"

        return UNVERIFIED_MEASUREMENT_PATTERN.sub(replacement, value).strip()

    def _analyze(self, assessment_id: str, room_id: str, job_id: str) -> None:
        try:
            self._job(job_id, "running", "scene_understood")
            room = self._owned_room(assessment_id, room_id)
            media = [item for item in self._media(room_id) if item["quality"].get("usable")]
            allowed = [code for code, rule in self.rules.risk_rules.items() if room["room_type"] in rule["room_types"]]
            self._job(job_id, "running", "risks_detecting")
            with self._model_slot("pro", assessment_id, room_id, "risk_analysis"):
                response, usage = self.provider().analyze(assessment_id, room["room_type"], media, allowed)
            self._job(job_id, "running", "regions_grounded")
            candidates = self._validate_analysis(response, {item["media_id"] for item in media}, set(allowed))
            now = utc_now()
            normalized = self._merge_cross_frame_candidates(candidates, media)
            seen: set[tuple[str, str]] = set()
            with self.repository.transaction() as connection:
                existing_rows = connection.execute("SELECT * FROM risks WHERE room_id=?", (room_id,)).fetchall()
                existing = {(row["risk_code"], row["media_id"]): row for row in existing_rows}
                active_ids: list[str] = []
                for candidate in normalized:
                    key = (candidate["risk_code"], candidate["media_id"])
                    if key in seen:
                        continue
                    seen.add(key)
                    rule = self.rules.risk_rules[candidate["risk_code"]]
                    current = existing.get(key)
                    region_json = json.dumps(candidate["region"]) if candidate["region"] else None
                    if current:
                        risk_id = current["id"]
                        # Preserve user feedback, selections, and manually redrawn regions
                        # when a room is analyzed again with the same evidence identity.
                        if current["feedback"] == "location_inaccurate":
                            region_json = current["region_json"]
                        connection.execute(
                            "UPDATE risks SET title=?,evidence=?,confidence=?,region_json=?,severity=?,evidence_media_ids_json=?,updated_at=? WHERE id=?",
                            (
                                str(candidate.get("title") or rule["title"])[:40],
                                str(candidate["evidence"])[:240], candidate["confidence"], region_json,
                                rule["default_severity"], json.dumps(candidate["evidence_media_ids"]), now, risk_id,
                            ),
                        )
                    else:
                        risk_id = str(uuid.uuid4())
                        connection.execute(
                            "INSERT INTO risks (id,assessment_id,room_id,media_id,risk_code,state,feedback,title,evidence,confidence,region_json,severity,evidence_media_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (
                                risk_id, assessment_id, room_id, candidate["media_id"], candidate["risk_code"],
                                "unreviewed", None, str(candidate.get("title") or rule["title"])[:40],
                                str(candidate["evidence"])[:240], candidate["confidence"], region_json,
                                rule["default_severity"], json.dumps(candidate["evidence_media_ids"]), now, now,
                            ),
                        )
                    active_ids.append(risk_id)
                stale_ids = [row["id"] for row in existing_rows if row["id"] not in active_ids]
                if stale_ids:
                    connection.executemany("DELETE FROM risks WHERE id=?", [(risk_id,) for risk_id in stale_ids])
            self._job(job_id, "running", "rules_applied")
            scene_elements = set(response.get("scene_elements", []))
            for item in media:
                scene_elements.update(item["quality"].get("scene_elements", []))
            coverage = calculate_coverage(list(scene_elements), self.rules.coverage_document["rooms"][room["room_type"]])
            self.repository.execute("UPDATE rooms SET coverage_percent=?, status='result_ready', updated_at=? WHERE id=?", (coverage["percent"], utc_now(), room_id))
            self._job(job_id, "running", "score_calculated")
            self._compute_result(assessment_id, room_id)
            self.repository.execute("UPDATE assessments SET status='in_progress', updated_at=? WHERE id=?", (utc_now(), assessment_id))
            self._best_effort_event(assessment_id, room_id, "ai_call_completed", {"skill_name": "risk_analysis", **usage})
            self._best_effort_event(assessment_id, room_id, "analysis_completed", {"risk_count": len(seen), "candidate_count": len(candidates), "merged_count": len(candidates) - len(normalized)})
            # Publish the terminal state only after all bookkeeping writes have
            # finished. Callers use this state as the signal that media and DB
            # resources are no longer being touched by the worker.
            self._job(job_id, "completed", "solutions_ready")
        except Exception as error:
            code = error.code if isinstance(error, (ProviderError, AssessmentError)) else "analysis_failed"
            self._fail_analysis(assessment_id, room_id, job_id, code)
            self._best_effort_event(assessment_id, room_id, "ai_call_failed", {"skill_name": "risk_analysis", "error_type": code})

    def _generate_renovation_preview(self, preview_id: str) -> None:
        row = self.repository.fetchone("SELECT * FROM renovation_previews WHERE id=?", (preview_id,))
        if not row:
            return
        assessment_id, room_id = row["assessment_id"], row["room_id"]
        try:
            self.repository.execute(
                "UPDATE renovation_previews SET status='running',stage='editing_image',updated_at=? WHERE id=?",
                (utc_now(), preview_id),
            )
            source = self.repository.fetchone("SELECT * FROM media WHERE id=? AND assessment_id=?", (row["source_media_id"], assessment_id))
            if not source or not Path(source["path"]).is_file():
                raise AssessmentError("renovation_source_not_found", 404)
            snapshot = json.loads(row["selection_snapshot_json"])
            visualized_actions = json.loads(row["visualized_actions_json"])
            provider = self.renovation_provider()
            prompt = self._renovation_prompt(self._owned_room(assessment_id, room_id)["room_type"], snapshot, visualized_actions)
            with self._model_slot("pro", assessment_id, room_id, "renovation_visualization"):
                generated = provider.edit(assessment_id, source, prompt)
            extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}.get(generated.mime_type)
            if not extension:
                raise ProviderError("provider_invalid_response", False)
            directory = self.media_root / assessment_id / "renovation-previews"
            directory.mkdir(parents=True, exist_ok=True)
            output_path = directory / f"{preview_id}{extension}"
            temporary_path = directory / f".{preview_id}.tmp"
            temporary_path.write_bytes(generated.body)
            temporary_path.replace(output_path)
            grounded_actions = visualized_actions
            try:
                self.repository.execute(
                    "UPDATE renovation_previews SET stage='grounding_changes',updated_at=? WHERE id=?",
                    (utc_now(), preview_id),
                )
                after_media = {
                    "media_id": preview_id, "path": str(output_path), "mime_type": generated.mime_type,
                }
                with self._model_slot("pro", assessment_id, room_id, "renovation_region_grounding"):
                    grounding, grounding_usage = self.provider().ground_renovation_changes(
                        assessment_id, source, after_media, visualized_actions,
                    )
                grounded_actions = self._validated_renovation_action_regions(visualized_actions, grounding)
                self._best_effort_event(assessment_id, room_id, "ai_call_completed", {
                    "skill_name": "renovation_region_grounding", "preview_id": preview_id,
                    "action_codes": [item["action_code"] for item in grounded_actions if item.get("region")],
                    **grounding_usage,
                })
            except Exception as grounding_error:
                error_code = grounding_error.code if isinstance(grounding_error, (ProviderError, AssessmentError)) else "provider_invalid_response"
                self._best_effort_event(assessment_id, room_id, "ai_call_failed", {
                    "skill_name": "renovation_region_grounding", "preview_id": preview_id, "error_type": error_code,
                })
            self.repository.execute(
                "UPDATE renovation_previews SET status='completed',stage='ready',error=NULL,provider=?,model=?,prompt_version=?,visualized_actions_json=?,output_path=?,output_mime_type=?,updated_at=? WHERE id=?",
                (provider.provider_name, provider.model_name, provider.prompt_version, json.dumps(grounded_actions, ensure_ascii=False), str(output_path), generated.mime_type, utc_now(), preview_id),
            )
            self._best_effort_event(assessment_id, room_id, "ai_call_completed", {
                "skill_name": "renovation_visualization", "preview_id": preview_id,
                "provider": provider.provider_name, "model": provider.model_name,
                "prompt_version": provider.prompt_version, **generated.usage,
            })
        except AssessmentError as error:
            self._fail_renovation_preview(preview_id, self._renovation_error_code(error.code))
        except ProviderError as error:
            self._best_effort_event(assessment_id, room_id, "ai_call_failed", {
                "skill_name": "renovation_visualization", "preview_id": preview_id, "error_type": error.code,
            })
            self._fail_renovation_preview(preview_id, error.code)
        except Exception:
            self._fail_renovation_preview(preview_id, "renovation_preview_invalid_response")

    def _renovation_selection_snapshot(self, assessment_id: str, room_id: str) -> tuple[list[dict], str]:
        rows = self.repository.fetchall(
            "SELECT ss.solution_package_id,r.id AS risk_id,r.title AS risk_title,r.evidence "
            "FROM selected_solutions ss JOIN risks r ON r.id=ss.risk_id "
            "WHERE ss.assessment_id=? AND r.room_id=? ORDER BY r.id,ss.solution_package_id",
            (assessment_id, room_id),
        )
        snapshot: list[dict] = []
        for row in rows:
            solution = self.rules.solutions.get(row["solution_package_id"])
            if not solution:
                continue
            visual_actions = [{
                "action_code": action["action_code"], "label": action["label"], "prompt": action["prompt"],
                "risk_id": row["risk_id"], "risk_title": row["risk_title"], "target_evidence": row["evidence"],
            } for action in solution.get("visualizable_actions", [])]
            snapshot.append({
                "risk_id": row["risk_id"], "risk_title": row["risk_title"],
                "solution_package_id": solution["solution_package_id"], "tier": solution["tier"],
                "title": solution["title"], "summary": solution["summary"], "actions": list(solution.get("actions", [])),
                "visualizable_actions": visual_actions,
            })
        hash_input = {
            "rule_set_version": self.rules.rule_set_version,
            "visualization_rule_version": self.rules.renovation_visualization_document["version"],
            "selections": [{"risk_id": item["risk_id"], "solution_package_id": item["solution_package_id"]} for item in snapshot],
        }
        selection_hash = hashlib.sha256(json.dumps(hash_input, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        return snapshot, selection_hash

    @staticmethod
    def _renovation_prompt(room_type: str, snapshot: list[dict], visualized_actions: list[dict]) -> str:
        room_names = {"bathroom": "卫生间", "bedroom": "卧室", "living_room": "客厅", "kitchen": "厨房", "corridor": "玄关走廊", "balcony": "阳台"}
        action_lines = "\n".join(
            f"{index}. 针对“{action['risk_title']}”：{action['prompt']}。可见依据：{action['target_evidence']}"
            for index, action in enumerate(visualized_actions, 1)
        )
        selected_titles = "、".join(f"{item['tier']}档 {item['title']}" for item in snapshot)
        return (
            f"以输入的{room_names.get(room_type, '房间')}照片为唯一视觉基准，生成同一空间完成已选适老化方案后的写实效果图。"
            "严格保持原图的相机位置、焦距、透视、构图、房间尺寸、门窗、墙地面、固定设施、已有家具、光线、色温和画面风格不变。"
            f"当前已选结构化方案为：{selected_titles}。只允许执行以下可视化动作：\n{action_lines}\n"
            "新增设施必须尺度真实、位置合理、固定关系可信，并与原空间风格协调。若某项动作在原图中没有可靠可见的安装面或目标区域，宁可跳过该项，不要猜测画面外信息。"
            "不要移动、删除或重绘无关物体；不要改变墙体、门窗、管线、防水、排水或空间结构；不要添加未列出的设施。"
            "不要生成人物、文字、数字文案、标注、箭头、Logo 或施工结论，不要声称承重、防水、安装位置或工程可行性已经确认。"
            "输出自然、真实、可直接与原图对比的室内摄影效果图；除明确列出的改造外，其余区域尽可能保持一致。"
        )

    def _serialize_renovation_preview(self, row: dict, current_selection_hash: str) -> dict:
        stale = row["selection_hash"] != current_selection_hash
        selected_solutions = self._public_renovation_snapshot(json.loads(row["selection_snapshot_json"] or "[]"))
        visualized_actions = [{key: action[key] for key in ("action_code", "label", "risk_id", "risk_title", "region", "confidence") if key in action} for action in json.loads(row["visualized_actions_json"] or "[]")]
        return {
            "preview_id": row["id"], "assessment_id": row["assessment_id"], "room_id": row["room_id"],
            "source_media_id": row["source_media_id"], "selection_hash": row["selection_hash"],
            "selected_solutions": selected_solutions,
            "status": row["status"], "stage": row["stage"], "error": row["error"],
            "provider": row["provider"], "model": row["model"], "prompt_version": row["prompt_version"],
            "rule_set_version": row["rule_set_version"],
            "visualized_actions": visualized_actions,
            "skipped_actions": json.loads(row["skipped_actions_json"] or "[]"),
            "before_content_path": f"/api/v2/assessments/{row['assessment_id']}/media/{row['source_media_id']}/content",
            "after_content_path": f"/api/v2/assessments/{row['assessment_id']}/rooms/{row['room_id']}/renovation-previews/{row['id']}/content" if row["status"] == "completed" else None,
            "selected_for_report": bool(row["selected_for_report"]) and not stale,
            "stale": stale, "created_at": row["created_at"], "updated_at": row["updated_at"],
            "disclaimer": self._renovation_disclaimer(),
        }

    @staticmethod
    def _validated_renovation_action_regions(actions: list[dict], response: dict) -> list[dict]:
        if not isinstance(response, dict) or not isinstance(response.get("action_regions"), list):
            raise ProviderError("provider_invalid_response", False)
        allowed = {str(item.get("action_code")): item for item in actions if item.get("action_code")}
        regions: dict[str, dict] = {}
        for item in response["action_regions"]:
            if not isinstance(item, dict):
                raise ProviderError("provider_invalid_response", False)
            action_code = str(item.get("action_code", ""))
            bbox = item.get("bbox")
            confidence = item.get("confidence")
            if action_code not in allowed or action_code in regions:
                continue
            if not isinstance(bbox, list) or len(bbox) != 4 or not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in bbox):
                raise ProviderError("provider_invalid_response", False)
            x_min, y_min, x_max, y_max = (float(value) for value in bbox)
            if not (0 <= x_min < x_max <= 1 and 0 <= y_min < y_max <= 1):
                raise ProviderError("provider_invalid_response", False)
            if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= float(confidence) <= 1:
                raise ProviderError("provider_invalid_response", False)
            if float(confidence) < .55:
                continue
            regions[action_code] = {
                "region": {"type": "bbox", "x": x_min, "y": y_min, "width": x_max - x_min, "height": y_max - y_min},
                "confidence": round(float(confidence), 3),
            }
        return [{**action, **regions.get(str(action.get("action_code")), {})} for action in actions]

    @staticmethod
    def _public_renovation_snapshot(snapshot: list[dict]) -> list[dict]:
        result: list[dict] = []
        for item in snapshot:
            value = {key: item[key] for key in ("risk_id", "risk_title", "solution_package_id", "tier", "title", "summary", "actions")}
            value["visualizable_actions"] = [
                {key: action[key] for key in ("action_code", "label", "risk_id", "risk_title") if key in action}
                for action in item.get("visualizable_actions", [])
            ]
            result.append(value)
        return result

    def _report_renovation_previews(self, assessment_id: str) -> list[dict]:
        if os.environ.get("ANJU_ENABLE_RENOVATION_PREVIEW", "0") != "1":
            return []
        rows = self.repository.fetchall(
            "SELECT * FROM renovation_previews WHERE assessment_id=? AND selected_for_report=1 AND status='completed' ORDER BY created_at",
            (assessment_id,),
        )
        values: list[dict] = []
        for row in rows:
            _, selection_hash = self._renovation_selection_snapshot(assessment_id, row["room_id"])
            value = self._serialize_renovation_preview(row, selection_hash)
            if not value["stale"]:
                values.append(value)
        return values

    def _trim_renovation_previews(self, assessment_id: str, room_id: str, keep: int) -> None:
        rows = self.repository.fetchall(
            "SELECT id,output_path,selected_for_report,created_at FROM renovation_previews WHERE assessment_id=? AND room_id=? ORDER BY selected_for_report DESC,created_at DESC",
            (assessment_id, room_id),
        )
        for row in rows[keep:]:
            if row["output_path"]:
                Path(row["output_path"]).unlink(missing_ok=True)
            self.repository.execute("DELETE FROM renovation_previews WHERE id=?", (row["id"],))

    def _fail_renovation_preview(self, preview_id: str, code: str) -> None:
        self.repository.execute(
            "UPDATE renovation_previews SET status='failed',stage='failed',error=?,updated_at=? WHERE id=?",
            (code, utc_now(), preview_id),
        )

    @staticmethod
    def _renovation_error_code(provider_code: str) -> str:
        return {
            "provider_timeout": "renovation_preview_timeout",
            "provider_http_429": "renovation_preview_capacity_busy",
            "provider_capacity_busy": "renovation_preview_capacity_busy",
            "provider_refusal": "renovation_preview_refusal",
            "provider_invalid_response": "renovation_preview_invalid_response",
        }.get(provider_code, "renovation_preview_failed")

    def _recover_interrupted_renovation_previews(self) -> None:
        self.repository.execute(
            "UPDATE renovation_previews SET status='failed',stage='interrupted',error='renovation_preview_interrupted',updated_at=? "
            "WHERE status IN ('queued','running')",
            (utc_now(),),
        )

    @staticmethod
    def _renovation_disclaimer() -> str:
        return "AI 改造效果示意，仅用于方案沟通。安装位置、尺寸、墙体、防水与施工可行性须现场确认；实际安全改善需整改后重新拍摄复查。"

    def _recover_interrupted_analyses(self) -> None:
        now = utc_now()
        with self.repository.transaction() as connection:
            interrupted = connection.execute(
                "SELECT DISTINCT assessment_id,room_id FROM jobs WHERE status IN ('queued','running')"
            ).fetchall()
            if not interrupted:
                return
            connection.execute(
                "UPDATE jobs SET status='failed', stage='interrupted', error='analysis_interrupted', updated_at=? "
                "WHERE status IN ('queued','running')",
                (now,),
            )
            connection.executemany(
                "UPDATE rooms SET status='analysis_failed', updated_at=? WHERE id=?",
                [(now, row["room_id"]) for row in interrupted],
            )
            connection.executemany(
                "UPDATE assessments SET status='in_progress', updated_at=? WHERE id=?",
                [(now, assessment_id) for assessment_id in {row["assessment_id"] for row in interrupted}],
            )

    def _fail_analysis(self, assessment_id: str, room_id: str, job_id: str, code: str) -> None:
        now = utc_now()
        with self.repository.transaction() as connection:
            connection.execute(
                "UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?",
                (code, now, job_id),
            )
            connection.execute("UPDATE rooms SET status='analysis_failed', updated_at=? WHERE id=?", (now, room_id))
            connection.execute("UPDATE assessments SET status='in_progress', updated_at=? WHERE id=?", (now, assessment_id))

    def _job(self, job_id: str, status: str, stage: str, error: str | None = None) -> None:
        self.repository.execute("UPDATE jobs SET status=?,stage=?,error=?,updated_at=? WHERE id=?", (status, stage, error, utc_now(), job_id))

    def _compute_result(self, assessment_id: str, room_id: str) -> dict:
        assessment = self.repository.fetchone("SELECT profile_json FROM assessments WHERE id=?", (assessment_id,))
        room = self._owned_room(assessment_id, room_id)
        risks = self._risks(room_id)
        score = score_risks(risks, json.loads(assessment["profile_json"]), self.rules.risk_rules)
        counts = {"high": 0, "medium": 0, "low": 0}
        for risk in risks:
            if risk["state"] != "rejected":
                counts[risk["severity"]] += 1
        coverage = calculate_coverage(self._scene_elements(room_id), self.rules.coverage_document["rooms"][room["room_type"]])
        for risk in risks:
            match = next((item for item in score["breakdown"] if item["risk_id"] == risk["risk_id"]), None)
            risk["score_deduction"] = match["deduction"] if match else 0
        result = {
            "room_id": room_id, "room_type": room["room_type"], "status": room["status"], "score": score["score"], "score_label": score["label"],
            "coverage": coverage, "counts": counts, "risks": risks, "score_breakdown": score["breakdown"],
            "main_deductions": sorted(score["breakdown"], key=lambda item: item["deduction"], reverse=True)[:3],
            "rule_set_version": self.rules.rule_set_version,
        }
        self.repository.execute("UPDATE rooms SET score=?,coverage_percent=?,result_json=?,updated_at=? WHERE id=?", (score["score"], coverage["percent"], json.dumps(result, ensure_ascii=False), utc_now(), room_id))
        return result

    def _scene_elements(self, room_id: str) -> list[str]:
        values: set[str] = set()
        for item in self._media(room_id):
            values.update(item["quality"].get("scene_elements", []))
        return list(values)

    def _media(self, room_id: str) -> list[dict]:
        rows = self.repository.fetchall("SELECT * FROM media WHERE room_id=? ORDER BY created_at", (room_id,))
        return [{
            "media_id": row["id"], "mime_type": row["mime_type"], "path": row["path"], "width": row["width"], "height": row["height"],
            "quality": json.loads(row["quality_json"]), "source_kind": row["source_kind"], "source_id": row["source_id"],
            "frame_index": row["frame_index"], "captured_at_ms": row["captured_at_ms"], "orientation": row["orientation"],
            "perceptual_hash": row["perceptual_hash"], "zone_id": row["zone_id"],
            "content_path": f"/api/v2/assessments/{row['assessment_id']}/media/{row['id']}/content",
        } for row in rows]

    def _risks(self, room_id: str) -> list[dict]:
        rows = self.repository.fetchall("SELECT * FROM risks WHERE room_id=? ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at", (room_id,))
        return [{"risk_id": row["id"], "room_id": row["room_id"], "media_id": row["media_id"], "evidence_media_ids": json.loads(row["evidence_media_ids_json"] or "[]"), "risk_code": row["risk_code"], "state": row["state"], "feedback": row["feedback"], "title": row["title"], "evidence": row["evidence"], "confidence": row["confidence"], "region": json.loads(row["region_json"]) if row["region_json"] else None, "severity": row["severity"]} for row in rows]

    def _validate_media_metadata(self, value: dict) -> dict:
        source_kind = str(value.get("source_kind") or "photo")
        if source_kind not in ALLOWED_MEDIA_SOURCES:
            raise AssessmentError("invalid_media_metadata")
        orientation = str(value.get("orientation") or "up")
        if orientation not in ALLOWED_ORIENTATIONS:
            raise AssessmentError("invalid_media_metadata")
        source_id = value.get("source_id")
        if source_id is not None and (not isinstance(source_id, str) or not 1 <= len(source_id) <= 80):
            raise AssessmentError("invalid_media_metadata")
        perceptual_hash = value.get("perceptual_hash")
        if perceptual_hash is not None and (not isinstance(perceptual_hash, str) or len(perceptual_hash) > 128):
            raise AssessmentError("invalid_media_metadata")
        integers: dict[str, int | None] = {}
        for key in ("frame_index", "captured_at_ms"):
            item = value.get(key)
            if item is not None and (not isinstance(item, int) or item < 0):
                raise AssessmentError("invalid_media_metadata")
            integers[key] = item
        zone_id = value.get("zone_id")
        if zone_id is not None and (not isinstance(zone_id, str) or len(zone_id) > 40):
            raise AssessmentError("invalid_media_metadata")
        return {"source_kind": source_kind, "source_id": source_id, **integers, "orientation": orientation, "perceptual_hash": perceptual_hash, "zone_id": zone_id}

    def _merge_cross_frame_candidates(self, candidates: list[dict], media: list[dict]) -> list[dict]:
        """Conservatively merge the same risk across adjacent frames from one source."""
        media_by_id = {item["media_id"]: item for item in media}
        merged: list[dict] = []
        for candidate in sorted(candidates, key=lambda item: float(item.get("confidence", 0)), reverse=True):
            candidate = dict(candidate)
            candidate["evidence_media_ids"] = [candidate["media_id"]]
            match = next((item for item in merged if self._same_physical_risk(item, candidate, media_by_id)), None)
            if match is None:
                merged.append(candidate)
                continue
            match["evidence_media_ids"].append(candidate["media_id"])
            if candidate["evidence"] not in match["evidence"]:
                match["evidence"] = f"{match['evidence']}；另一个画面也观察到相同位置的候选"[:240]
        return merged

    @staticmethod
    def _same_physical_risk(left: dict, right: dict, media_by_id: dict[str, dict]) -> bool:
        if left["risk_code"] != right["risk_code"]:
            return False
        left_media = media_by_id.get(left["media_id"], {})
        right_media = media_by_id.get(right["media_id"], {})
        source_id = left_media.get("source_id")
        if not source_id or source_id != right_media.get("source_id"):
            return False
        left_time, right_time = left_media.get("captured_at_ms"), right_media.get("captured_at_ms")
        if isinstance(left_time, int) and isinstance(right_time, int) and abs(left_time - right_time) > 8_000:
            return False
        left_region, right_region = left.get("region"), right.get("region")
        if not left_region or not right_region or left_region.get("type") != "bbox" or right_region.get("type") != "bbox":
            return False
        x1, y1 = max(left_region["x"], right_region["x"]), max(left_region["y"], right_region["y"])
        x2 = min(left_region["x"] + left_region["width"], right_region["x"] + right_region["width"])
        y2 = min(left_region["y"] + left_region["height"], right_region["y"] + right_region["height"])
        intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        union = left_region["width"] * left_region["height"] + right_region["width"] * right_region["height"] - intersection
        return union > 0 and intersection / union >= 0.35

    def _room_summary(self, row: dict) -> dict:
        return {"room_id": row["id"], "room_type": row["room_type"], "status": row["status"], "coverage_percent": row["coverage_percent"], "score": row["score"], "supported": row["room_type"] in SUPPORTED_ROOMS, "media": self._media(row["id"])}

    def _owned_room(self, assessment_id: str, room_id: str) -> dict:
        row = self.repository.fetchone("SELECT * FROM rooms WHERE id=? AND assessment_id=?", (room_id, assessment_id))
        if not row:
            raise AssessmentError("room_not_found", 404)
        return row

    def _owned_risk(self, assessment_id: str, risk_id: str) -> dict:
        row = self.repository.fetchone("SELECT * FROM risks WHERE id=? AND assessment_id=?", (risk_id, assessment_id))
        if not row:
            raise AssessmentError("risk_not_found", 404)
        return row

    def _validate_quality(self, value: dict, room_type: str) -> dict:
        required = {"usable", "clear", "floor_visible", "path_visible", "lighting_sufficient", "major_occlusion", "scene_elements", "missing_element_ids"}
        if not isinstance(value, dict) or not required.issubset(value):
            raise ProviderError("provider_invalid_response")
        allowed_elements = {item["id"] for item in self.rules.coverage_document["rooms"][room_type]["elements"]}
        value["scene_elements"] = [item for item in value["scene_elements"] if item in allowed_elements]
        value["missing_element_ids"] = [item for item in value["missing_element_ids"] if item in allowed_elements][:6]
        labels = {item["id"]: item["label"] for item in self.rules.coverage_document["rooms"][room_type]["elements"]}
        value["missing_views"] = [labels[item] for item in value["missing_element_ids"]]
        return value

    def _validate_analysis(self, value: dict, media_ids: set[str], allowed_risks: set[str]) -> list[dict]:
        if not isinstance(value, dict) or not isinstance(value.get("risk_candidates"), list):
            raise ProviderError("provider_invalid_response")
        accepted: list[dict] = []
        for item in value["risk_candidates"][:12]:
            if not isinstance(item, dict) or item.get("risk_code") not in allowed_risks or item.get("media_id") not in media_ids:
                continue
            if not str(item.get("evidence", "")).strip():
                continue
            confidence = item.get("confidence")
            if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
                continue
            region = item.get("region")
            try:
                region = self._validate_region(region) if region is not None else None
            except AssessmentError:
                region = None
            item["region"] = region
            accepted.append(item)
        return accepted

    def _validate_region(self, value: dict) -> dict:
        if not isinstance(value, dict) or value.get("type") not in {"bbox", "polygon"}:
            raise AssessmentError("invalid_region")
        if value["type"] == "bbox":
            coordinates = [value.get(key) for key in ("x", "y", "width", "height")]
            if not all(isinstance(item, (int, float)) and 0 <= item <= 1 for item in coordinates):
                raise AssessmentError("invalid_region")
            x, y, width, height = [float(item) for item in coordinates]
            if width <= 0 or height <= 0 or x + width > 1 or y + height > 1:
                raise AssessmentError("invalid_region")
            return {"type": "bbox", "x": x, "y": y, "width": width, "height": height}
        points = value.get("points")
        if not isinstance(points, list) or not 3 <= len(points) <= 16:
            raise AssessmentError("invalid_region")
        normalized = []
        for point in points:
            if not isinstance(point, list) or len(point) != 2 or not all(isinstance(item, (int, float)) and 0 <= item <= 1 for item in point):
                raise AssessmentError("invalid_region")
            normalized.append([float(point[0]), float(point[1])])
        return {"type": "polygon", "points": normalized}
