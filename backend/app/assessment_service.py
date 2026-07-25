from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import shutil
import uuid

from .providers import ProviderError, VisionProvider, provider_from_environment
from .repositories import SQLiteRepository, decode_json_row, token_hash, utc_now
from .rules import RuleStore
from .scoring import calculate_coverage, score_risks


ALLOWED_INPUT_MODES = {"photo", "video_frame"}
ALLOWED_ROOMS = {"bathroom", "bedroom", "living_room", "kitchen", "corridor", "balcony"}
SUPPORTED_ROOMS = {"bathroom"}
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
        now = utc_now()
        self.repository.execute("UPDATE jobs SET status='failed', stage='interrupted', error='analysis_interrupted', updated_at=? WHERE status IN ('queued','running')", (now,))

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    def create_assessment(self, payload: dict) -> dict:
        input_mode = payload.get("input_mode", "photo")
        if input_mode not in ALLOWED_INPUT_MODES:
            raise AssessmentError("invalid_input_mode")
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
        return {"room_id": room_id, "room_type": room_type, "status": "collecting_media", "supported": room_type in SUPPORTED_ROOMS}

    def upload_media(self, assessment_id: str, room_id: str, body: bytes, mime_type: str, width: int, height: int) -> dict:
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
        media_id = str(uuid.uuid4())
        extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[mime_type]
        directory = self.media_root / assessment_id
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{media_id}{extension}"
        path.write_bytes(body)
        media_input = {"media_id": media_id, "path": str(path), "mime_type": mime_type}
        try:
            quality, usage = self.provider().quality(assessment_id, media_input)
            quality = self._validate_quality(quality)
            self.event(assessment_id, room_id, "ai_call_completed", {"skill_name": "media_quality", **usage})
        except ProviderError as error:
            quality = {"usable": False, "clear": False, "floor_visible": False, "path_visible": False, "lighting_sufficient": False, "major_occlusion": False, "scene_elements": [], "missing_views": [], "error": error.code}
            self.event(assessment_id, room_id, "ai_call_failed", {"skill_name": "media_quality", "error_type": error.code})
        self.repository.insert("media", {"id": media_id, "assessment_id": assessment_id, "room_id": room_id, "mime_type": mime_type, "path": str(path), "width": width, "height": height, "quality_json": json.dumps(quality, ensure_ascii=False), "created_at": utc_now()})
        self.event(assessment_id, room_id, "media_upload_completed", {"media_id": media_id, "usable": quality["usable"]})
        return {"media_id": media_id, "mime_type": mime_type, "width": width, "height": height, "quality": quality, "content_path": f"/api/v2/assessments/{assessment_id}/media/{media_id}/content"}

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
        groups: dict[str, dict] = {}
        gain_groups: dict[str, tuple[int, int]] = {}
        for row in selections:
            solution = dict(self.rules.solutions[row["solution_package_id"]])
            price = dict(self.rules.prices[solution["price_rule_id"]])
            item = {"selected_solution_id": row["id"], "risk_id": row["risk_id"], "risk_title": row["risk_title"], "severity": row["severity"], "status": row["status"], "solution": {**solution, "price": price}}
            selected_items.append(item)
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
        return {
            "assessment_id": assessment_id, "status": assessment["status"], "checked_room_count": len(room_results), "planned_room_count": 6,
            "coverage_percent": coverage, "score_title": "家庭安全参考分" if coverage >= 80 else "当前已检查区域安全参考分",
            "assessed_area_score": assessed_score, "household_score": assessed_score if coverage >= 80 else None,
            "rooms": room_results, "selected_items": selected_items, "budget": budget, "projected_score": projected,
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
        return {key: report[key] for key in ("status", "checked_room_count", "planned_room_count", "coverage_percent", "score_title", "assessed_area_score", "household_score", "rooms", "selected_items", "budget", "projected_score", "price_disclaimer")}

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
            seen: set[tuple[str, str]] = set()
            with self.repository.transaction() as connection:
                existing_rows = connection.execute("SELECT * FROM risks WHERE room_id=?", (room_id,)).fetchall()
                existing = {(row["risk_code"], row["media_id"]): row for row in existing_rows}
                active_ids: list[str] = []
                for candidate in candidates:
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
                            "UPDATE risks SET title=?,evidence=?,confidence=?,region_json=?,severity=?,updated_at=? WHERE id=?",
                            (
                                str(candidate.get("title") or rule["title"])[:40],
                                str(candidate["evidence"])[:240], candidate["confidence"], region_json,
                                rule["default_severity"], now, risk_id,
                            ),
                        )
                    else:
                        risk_id = str(uuid.uuid4())
                        connection.execute(
                            "INSERT INTO risks (id,assessment_id,room_id,media_id,risk_code,state,feedback,title,evidence,confidence,region_json,severity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (
                                risk_id, assessment_id, room_id, candidate["media_id"], candidate["risk_code"],
                                "unreviewed", None, str(candidate.get("title") or rule["title"])[:40],
                                str(candidate["evidence"])[:240], candidate["confidence"], region_json,
                                rule["default_severity"], now, now,
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
            self.event(assessment_id, room_id, "analysis_completed", {"risk_count": len(seen)})
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
        return [{"media_id": row["id"], "mime_type": row["mime_type"], "path": row["path"], "width": row["width"], "height": row["height"], "quality": json.loads(row["quality_json"]), "content_path": f"/api/v2/assessments/{row['assessment_id']}/media/{row['id']}/content"} for row in rows]

    def _risks(self, room_id: str) -> list[dict]:
        rows = self.repository.fetchall("SELECT * FROM risks WHERE room_id=? ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at", (room_id,))
        return [{"risk_id": row["id"], "room_id": row["room_id"], "media_id": row["media_id"], "risk_code": row["risk_code"], "state": row["state"], "feedback": row["feedback"], "title": row["title"], "evidence": row["evidence"], "confidence": row["confidence"], "region": json.loads(row["region_json"]) if row["region_json"] else None, "severity": row["severity"]} for row in rows]

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

    def _validate_quality(self, value: dict) -> dict:
        required = {"usable", "clear", "floor_visible", "path_visible", "lighting_sufficient", "major_occlusion", "scene_elements", "missing_views"}
        if not isinstance(value, dict) or not required.issubset(value):
            raise ProviderError("provider_invalid_response")
        allowed_elements = {item["id"] for item in self.rules.coverage_document["rooms"]["bathroom"]["elements"]}
        value["scene_elements"] = [item for item in value["scene_elements"] if item in allowed_elements]
        value["missing_views"] = [str(item)[:80] for item in value["missing_views"]][:6]
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
