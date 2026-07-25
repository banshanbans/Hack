from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import shutil
import threading
import uuid

from .providers import ProviderError, VisionProvider, provider_from_environment
from .repositories import SQLiteRepository, decode_json_row, token_hash, utc_now
from .rules import RuleStore
from .scoring import calculate_coverage, score_risks


ALLOWED_INPUT_MODES = {"photo", "video_frame"}
ALLOWED_MEDIA_SOURCES = {"photo", "video_frame", "h5_camera_frame", "ios_ar_frame"}
ALLOWED_ORIENTATIONS = {"up", "right", "down", "left"}
FAIR_ZONES = {"entrance", "main_aisle", "booth", "rest_area"}
FAIR_RISK_RULES = {
    "floor_clutter": {"severity": "high", "deduction": 16, "title": "通行区域有杂物"},
    "cable_crossing": {"severity": "high", "deduction": 14, "title": "线缆横跨通道"},
    "narrow_path": {"severity": "high", "deduction": 12, "title": "主要通道偏窄"},
    "loose_rug": {"severity": "medium", "deduction": 10, "title": "临时铺设物可能绊脚"},
    "unstable_support": {"severity": "medium", "deduction": 8, "title": "现场物体稳定性待确认"},
    "low_lighting": {"severity": "medium", "deduction": 6, "title": "通行区域照明不足"},
    "sharp_corner": {"severity": "low", "deduction": 5, "title": "人员动线附近有突出尖角"},
}
ALLOWED_ROOMS = {"bathroom", "bedroom", "living_room", "kitchen", "corridor", "balcony"}
SUPPORTED_ROOMS = set(ALLOWED_ROOMS)
ALLOWED_FEEDBACK = {"not_a_risk", "location_inaccurate", "photo_unclear", "already_resolved", "other", "confirmed"}
MIME_SIGNATURES = {
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/webp": (b"RIFF",),
}


class AssessmentError(RuntimeError):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


class AssessmentService:
    def __init__(self, repository: SQLiteRepository, media_root: Path, rules: RuleStore | None = None, provider: VisionProvider | None = None) -> None:
        self.repository = repository
        self.media_root = media_root
        self.media_root.mkdir(parents=True, exist_ok=True)
        self.rules = rules or RuleStore()
        self._provider = provider
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="anju-assessment")
        self._camera_lock = threading.Lock()
        self._camera_inflight: set[str] = set()
        self._fair_inflight: set[str] = set()
        now = utc_now()
        self.repository.execute("UPDATE jobs SET status='failed', stage='interrupted', error='analysis_interrupted', updated_at=? WHERE status IN ('queued','running')", (now,))

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

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
        if room["room_type"] not in SUPPORTED_ROOMS:
            raise AssessmentError("room_rules_not_ready", 409)
        media = self._media(room_id)
        if not any(item["quality"].get("usable") for item in media):
            raise AssessmentError("no_usable_media")
        job_id = str(uuid.uuid4())
        now = utc_now()
        self.repository.insert("jobs", {"id": job_id, "assessment_id": assessment_id, "room_id": room_id, "status": "queued", "stage": "quality_checked", "error": None, "created_at": now, "updated_at": now})
        self.repository.execute("UPDATE rooms SET status='analyzing', updated_at=? WHERE id=?", (now, room_id))
        self.repository.execute("UPDATE assessments SET status='analyzing', updated_at=? WHERE id=?", (now, assessment_id))
        self.event(assessment_id, room_id, "analysis_started", {"job_id": job_id})
        self._executor.submit(self._analyze, assessment_id, room_id, job_id)
        return {"job_id": job_id, "status": "queued", "stage": "quality_checked"}

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
        self.repository.execute("DELETE FROM selected_solutions WHERE risk_id=?", (risk_id,))
        self.repository.insert("selected_solutions", {"id": str(uuid.uuid4()), "assessment_id": assessment_id, "risk_id": risk_id, "solution_package_id": solution_id, "status": "todo", "created_at": utc_now()})
        self.event(assessment_id, risk["room_id"], "solution_added_to_plan", {"risk_id": risk_id, "solution_package_id": solution_id})
        return self.report(assessment_id)

    def remove_solution(self, assessment_id: str, risk_id: str) -> None:
        self._owned_risk(assessment_id, risk_id)
        self.repository.execute("DELETE FROM selected_solutions WHERE risk_id=?", (risk_id,))

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
            solution = dict(self.rules.solutions[row["solution_package_id"]])
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
        return {key: report[key] for key in ("status", "checked_room_count", "planned_room_count", "coverage_percent", "score_title", "assessed_area_score", "household_score", "rooms", "selected_items", "recommendations", "budget", "projected_score", "price_disclaimer")}

    def delete_assessment(self, assessment_id: str) -> None:
        self.repository.execute("DELETE FROM assessments WHERE id=?", (assessment_id,))
        directory = self.media_root / assessment_id
        if directory.exists():
            shutil.rmtree(directory)

    def event(self, assessment_id: str | None, room_id: str | None, name: str, payload: dict) -> None:
        safe_payload = {key: value for key, value in payload.items() if key not in {"image", "api_key", "profile", "prompt"}}
        self.repository.insert("analytics_events", {"id": str(uuid.uuid4()), "assessment_id": assessment_id, "room_id": room_id, "event_name": name, "payload_json": json.dumps(safe_payload, ensure_ascii=False), "created_at": utc_now()})

    def provider(self) -> VisionProvider:
        if self._provider is None:
            self._provider = provider_from_environment()
        return self._provider

    def inspect_camera_frame(self, assessment_id: str, body: bytes, mime_type: str, width: int, height: int, payload: dict) -> dict:
        if os.environ.get("ANJU_ENABLE_H5_CAMERA", "0") != "1":
            raise AssessmentError("camera_not_enabled", 404)
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
            allowed = [code for code, rule in self.rules.risk_rules.items() if room_type in rule["room_types"]]
            media = {"media_id": frame_id, "path": str(temporary), "mime_type": mime_type, "room_type": room_type}
            response, usage = self.provider().inspect_camera(
                assessment_id, room_type, media, allowed,
                {key: profile.get(key) for key in ("mobility", "fall_history", "living_status") if profile.get(key)},
                [str(item)[:80] for item in payload.get("previous_summary", []) if isinstance(item, str)][:5],
            )
            suggestions = self._validate_camera_response(response, frame_id, set(allowed))
            self.event(assessment_id, None, "ai_call_completed", {"skill_name": "camera_inspection", **usage})
            return {
                "frame_id": frame_id, "temporary": True, "quality_usable": bool(response.get("quality_usable")),
                "scene_elements": [
                    item for item in response.get("scene_elements", [])
                    if item in {element["id"] for element in self.rules.coverage_document["rooms"][room_type]["elements"]}
                ],
                "suggestions": suggestions, "save_as_evidence_recommended": bool(response.get("save_as_evidence_recommended") and suggestions),
                "prompt_version": usage.get("prompt_version", "anju_h5_camera_adaptive_v1"),
            }
        except ProviderError as error:
            self.event(assessment_id, None, "ai_call_failed", {"skill_name": "camera_inspection", "error_type": error.code})
            raise
        finally:
            temporary.unlink(missing_ok=True)
            with self._camera_lock:
                self._camera_inflight.discard(assessment_id)

    def create_fair_scan(self) -> dict:
        if os.environ.get("ANJU_ENABLE_IOS_FAIR_AR", "0") != "1":
            raise AssessmentError("fair_ar_not_enabled", 404)
        scan_id = str(uuid.uuid4())
        access_token = secrets.token_urlsafe(32)
        now = utc_now()
        self.repository.insert("fair_scans", {"id": scan_id, "token_hash": token_hash(access_token), "status": "scanning", "result_json": "{}", "created_at": now, "updated_at": now})
        return {"scan_id": scan_id, "access_token": access_token, "assessment_context": "venue_fair", "zones": sorted(FAIR_ZONES), "status": "scanning"}

    def authorize_fair_scan(self, scan_id: str, token: str) -> None:
        row = self.repository.fetchone("SELECT token_hash FROM fair_scans WHERE id=?", (scan_id,))
        if not row or not token or row["token_hash"] != token_hash(token):
            raise AssessmentError("fair_scan_access_denied", 404)

    def analyze_fair_frame(self, scan_id: str, zone_id: str, frame_id: str, body: bytes, mime_type: str, width: int, height: int, orientation: str) -> dict:
        if zone_id not in FAIR_ZONES or orientation not in ALLOWED_ORIENTATIONS:
            raise AssessmentError("invalid_fair_frame")
        if not frame_id or len(frame_id) > 80 or mime_type not in MIME_SIGNATURES or not any(body.startswith(signature) for signature in MIME_SIGNATURES[mime_type]):
            raise AssessmentError("invalid_fair_frame")
        if not (1 <= width <= 1920 and 1 <= height <= 1920):
            raise AssessmentError("invalid_image_dimensions")
        with self._camera_lock:
            if scan_id in self._fair_inflight:
                raise AssessmentError("camera_request_in_progress", 409)
            self._fair_inflight.add(scan_id)
        directory = self.media_root / "fair" / scan_id
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{frame_id}.jpg"
        path.write_bytes(body)
        try:
            media = {"media_id": frame_id, "path": str(path), "mime_type": mime_type, "zone_id": zone_id}
            response, usage = self.provider().fair_turbo(scan_id, zone_id, media, list(FAIR_RISK_RULES))
            candidates = self._validate_fair_turbo(response, frame_id, zone_id)
            self.repository.insert("fair_frames", {
                "id": frame_id, "scan_id": scan_id, "zone_id": zone_id, "path": str(path), "mime_type": mime_type,
                "width": width, "height": height, "orientation": orientation, "candidates_json": json.dumps(candidates, ensure_ascii=False), "created_at": utc_now(),
            })
            self._prune_fair_frames(scan_id, zone_id)
            self.event(scan_id, None, "ai_call_completed", {"skill_name": "fair_turbo", "zone_id": zone_id, **usage})
            return {"frame_id": frame_id, "zone_id": zone_id, "candidates": candidates, "temporary": True, "prompt_version": usage.get("prompt_version", "anju_ios_fair_turbo_v1")}
        except Exception:
            if not self.repository.fetchone("SELECT id FROM fair_frames WHERE id=?", (frame_id,)):
                path.unlink(missing_ok=True)
            raise
        finally:
            with self._camera_lock:
                self._fair_inflight.discard(scan_id)

    def review_fair_zone(self, scan_id: str, zone_id: str) -> dict:
        if zone_id not in FAIR_ZONES:
            raise AssessmentError("invalid_fair_zone")
        rows = self.repository.fetchall("SELECT * FROM fair_frames WHERE scan_id=? AND zone_id=? ORDER BY created_at", (scan_id, zone_id))
        media = [{"media_id": row["id"], "path": row["path"], "mime_type": row["mime_type"]} for row in rows if Path(row["path"]).is_file()]
        candidates = [item for row in rows for item in json.loads(row["candidates_json"])]
        if not candidates or not media:
            result = {"zone_id": zone_id, "score": 100, "coverage_limited": True, "risks": [], "prompt_version": "anju_ios_fair_review_pro_v1"}
        else:
            try:
                response, usage = self.provider().fair_review(scan_id, zone_id, media, candidates, list(FAIR_RISK_RULES))
                reviews = self._validate_fair_reviews(response, zone_id, candidates)
                review_status = "reviewed"
                prompt_version = usage.get("prompt_version", "anju_ios_fair_review_pro_v1")
                self.event(scan_id, None, "ai_call_completed", {"skill_name": "fair_pro_review", "zone_id": zone_id, **usage})
            except ProviderError as error:
                reviews = [{
                    "candidate_id": item["candidate_id"], "status": "manual_check", "risk_code": item["risk_code"],
                    "evidence": item["evidence"], "bbox": item["bbox"], "merged_into_candidate_id": None,
                } for item in candidates]
                review_status = "review_failed"
                prompt_version = "anju_ios_fair_review_pro_v1"
                self.event(scan_id, None, "ai_call_failed", {"skill_name": "fair_pro_review", "zone_id": zone_id, "error_type": error.code})
            risks = self._fair_formal_risks(reviews, candidates)
            deductions: dict[str, int] = {}
            for risk in risks:
                deductions[risk["risk_code"]] = min(FAIR_RISK_RULES[risk["risk_code"]]["deduction"] * 2, deductions.get(risk["risk_code"], 0) + FAIR_RISK_RULES[risk["risk_code"]]["deduction"])
            result = {"zone_id": zone_id, "status": review_status, "score": max(0, 100 - sum(deductions.values())) if review_status == "reviewed" else None, "coverage_limited": len(media) < 2 or review_status != "reviewed", "risks": risks, "prompt_version": prompt_version}
        now = utc_now()
        self.repository.execute("DELETE FROM fair_zones WHERE scan_id=? AND zone_id=?", (scan_id, zone_id))
        self.repository.insert("fair_zones", {"id": str(uuid.uuid4()), "scan_id": scan_id, "zone_id": zone_id, "status": "reviewed", "result_json": json.dumps(result, ensure_ascii=False), "updated_at": now})
        self.repository.execute("UPDATE fair_scans SET updated_at=? WHERE id=?", (now, scan_id))
        return result

    def fair_report(self, scan_id: str) -> dict:
        rows = self.repository.fetchall("SELECT * FROM fair_zones WHERE scan_id=? AND status='reviewed' ORDER BY zone_id", (scan_id,))
        zones = [json.loads(row["result_json"]) for row in rows]
        scores = [item["score"] for item in zones if isinstance(item.get("score"), int)]
        selected_prices = [risk["solutions"][1] for zone in zones for risk in zone["risks"] if len(risk["solutions"]) > 1]
        report = {
            "scan_id": scan_id, "status": "reviewed" if zones else "scanning",
            "assessed_area_score": round(sum(scores) / len(scores)) if scores else None,
            "coverage_percent": round(len({item["zone_id"] for item in zones}) / len(FAIR_ZONES) * 100),
            "zones": zones,
            "budget": {"currency": "CNY", "total_min": sum(item["total_min"] for item in selected_prices), "total_max": sum(item["total_max"] for item in selected_prices)},
            "prompt_version": "anju_ios_fair_review_pro_v1",
            "disclaimer": "仅为游园会现场辅助筛查参考，不代表场馆验收或施工报价。",
        }
        self.repository.execute("UPDATE fair_scans SET status=?,result_json=?,updated_at=? WHERE id=?", (report["status"], json.dumps(report, ensure_ascii=False), utc_now(), scan_id))
        return report

    def _validate_fair_turbo(self, value: dict, frame_id: str, zone_id: str) -> list[dict]:
        if not isinstance(value, dict) or value.get("frame_id") != frame_id or value.get("zone_id") != zone_id or not isinstance(value.get("candidates"), list):
            raise ProviderError("provider_invalid_response")
        accepted = []
        for item in value["candidates"][:5]:
            if not isinstance(item, dict) or item.get("risk_code") not in FAIR_RISK_RULES or not str(item.get("evidence", "")).strip():
                continue
            confidence, bbox = item.get("confidence"), item.get("bbox")
            if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1 or not self._valid_xyxy(bbox):
                continue
            accepted.append({"candidate_id": str(uuid.uuid4()), "frame_id": frame_id, "zone_id": zone_id, "risk_code": item["risk_code"], "bbox": [float(number) for number in bbox], "evidence": str(item["evidence"])[:240], "confidence": float(confidence), "needs_manual_check": bool(item.get("needs_manual_check"))})
        return accepted

    def _validate_fair_reviews(self, value: dict, zone_id: str, candidates: list[dict]) -> list[dict]:
        if not isinstance(value, dict) or value.get("zone_id") != zone_id or not isinstance(value.get("reviews"), list):
            raise ProviderError("provider_invalid_response")
        by_id = {item["candidate_id"]: item for item in candidates}
        accepted = []
        for item in value["reviews"]:
            if not isinstance(item, dict) or item.get("candidate_id") not in by_id or item.get("risk_code") not in FAIR_RISK_RULES or item.get("status") not in {"confirmed", "rejected", "merged", "region_corrected", "manual_check"}:
                continue
            bbox = item.get("bbox")
            if bbox is not None and not self._valid_xyxy(bbox):
                continue
            accepted.append({**item, "bbox": [float(number) for number in bbox] if bbox else None, "evidence": str(item.get("evidence") or by_id[item["candidate_id"]]["evidence"])[:240]})
        reviewed_ids = {item["candidate_id"] for item in accepted}
        for candidate in candidates:
            if candidate["candidate_id"] not in reviewed_ids:
                accepted.append({
                    "candidate_id": candidate["candidate_id"], "status": "manual_check", "risk_code": candidate["risk_code"],
                    "evidence": candidate["evidence"], "bbox": candidate["bbox"], "merged_into_candidate_id": None,
                })
        return accepted

    def _fair_formal_risks(self, reviews: list[dict], candidates: list[dict]) -> list[dict]:
        source = {item["candidate_id"]: item for item in candidates}
        risks = []
        for review in reviews:
            if review["status"] in {"rejected", "merged"}:
                continue
            candidate = source[review["candidate_id"]]
            rule = FAIR_RISK_RULES[review["risk_code"]]
            risks.append({
                "candidate_id": review["candidate_id"], "frame_id": candidate["frame_id"], "risk_code": review["risk_code"],
                "status": review["status"], "severity": rule["severity"], "title": rule["title"], "evidence": review["evidence"],
                "bbox": review.get("bbox") or candidate["bbox"], "solutions": self._fair_solutions(review["risk_code"]),
            })
        return risks

    @staticmethod
    def _valid_xyxy(value: object) -> bool:
        return isinstance(value, list) and len(value) == 4 and all(isinstance(item, (int, float)) and 0 <= item <= 1 for item in value) and value[0] < value[2] and value[1] < value[3]

    @staticmethod
    def _fair_solutions(risk_code: str) -> list[dict]:
        titles = {
            "floor_clutter": ("立即移出通道", "设置现场收纳边界", "调整展位与通道布局"),
            "cable_crossing": ("临时固定并醒目标识", "加装过线板", "重新规划供电走线"),
            "narrow_path": ("立即移开占道物", "调整桌椅和排队线", "重新划分主通道"),
            "loose_rug": ("移除或固定四角", "更换防滑临时地垫", "专业处理地面衔接"),
            "unstable_support": ("暂停使用并隔离", "加固现场物体", "由专业人员复核安装"),
            "low_lighting": ("增加临时照明", "补充连续引导灯", "重新设计区域照明"),
            "sharp_corner": ("加装软质防撞条", "调整物体避开动线", "更换或改造突出构件"),
        }[risk_code]
        prices = ((0, 80), (80, 500), (500, 3000))
        return [{"tier": tier, "title": title, "total_min": price[0], "total_max": price[1]} for tier, title, price in zip(("A", "B", "C"), titles, prices)]

    def _prune_fair_frames(self, scan_id: str, zone_id: str) -> None:
        rows = self.repository.fetchall("SELECT id,path FROM fair_frames WHERE scan_id=? AND zone_id=? ORDER BY created_at DESC", (scan_id, zone_id))
        for row in rows[6:]:
            Path(row["path"]).unlink(missing_ok=True)
            self.repository.execute("DELETE FROM fair_frames WHERE id=?", (row["id"],))

    def _validate_camera_response(self, value: dict, frame_id: str, allowed_risks: set[str]) -> list[dict]:
        if not isinstance(value, dict) or value.get("media_id") != frame_id or not isinstance(value.get("suggestions"), list):
            raise ProviderError("provider_invalid_response")
        accepted: list[dict] = []
        for item in value["suggestions"][:5]:
            if not isinstance(item, dict) or item.get("risk_code") not in allowed_risks or not str(item.get("evidence", "")).strip():
                continue
            confidence = item.get("confidence")
            if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
                continue
            region = item.get("region")
            try:
                region = self._validate_region(region) if region else None
            except AssessmentError:
                region = None
            accepted.append({
                "suggestion_id": str(uuid.uuid4()), "risk_code": item["risk_code"], "title": str(item.get("title") or "待确认提示")[:40],
                "evidence": str(item["evidence"])[:240], "confidence": float(confidence), "needs_manual_check": bool(item.get("needs_manual_check")),
                "possible_repeat": bool(item.get("possible_repeat")), "region": region, "temporary": True,
                "save_as_evidence_recommended": True,
            })
        return accepted

    def _analyze(self, assessment_id: str, room_id: str, job_id: str) -> None:
        try:
            self._job(job_id, "running", "scene_understood")
            room = self._owned_room(assessment_id, room_id)
            media = [item for item in self._media(room_id) if item["quality"].get("usable")]
            allowed = [code for code, rule in self.rules.risk_rules.items() if room["room_type"] in rule["room_types"]]
            self._job(job_id, "running", "risks_detecting")
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
            self._job(job_id, "completed", "solutions_ready")
            self.repository.execute("UPDATE assessments SET status='in_progress', updated_at=? WHERE id=?", (utc_now(), assessment_id))
            self.event(assessment_id, room_id, "ai_call_completed", {"skill_name": "risk_analysis", **usage})
            self.event(assessment_id, room_id, "analysis_completed", {"risk_count": len(seen), "candidate_count": len(candidates), "merged_count": len(candidates) - len(normalized)})
        except (ProviderError, AssessmentError, ValueError) as error:
            code = error.code if hasattr(error, "code") else "analysis_failed"
            self._job(job_id, "failed", "failed", code)
            self.repository.execute("UPDATE rooms SET status='analysis_failed', updated_at=? WHERE id=?", (utc_now(), room_id))
            self.event(assessment_id, room_id, "ai_call_failed", {"skill_name": "risk_analysis", "error_type": code})

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
