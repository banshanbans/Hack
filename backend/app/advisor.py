from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
import secrets
import time
import uuid

from .providers.voice import VoiceConnection, VoiceProviderError, VolcengineVoiceProvider, build_rtc_token
from .repositories import token_hash, utc_now


ROOM_NAMES = {
    "bathroom": "卫生间", "bedroom": "卧室", "living_room": "客厅",
    "kitchen": "厨房", "corridor": "玄关走廊", "balcony": "阳台",
}
SEVERITY_NAMES = {"high": "高风险", "medium": "中风险", "low": "低风险"}
QUICK_PROMPTS = [
    "这个地方可能有什么问题？", "这里能不能加一个扶手？", "先做哪一项最重要？",
    "有没有低成本方案？", "预算大概多少？", "还需要补拍哪里？",
]
SCAN_QUICK_PROMPTS = ["这个地方可能有什么问题？", "这里能不能加扶手？", "还需要拍哪里？"]
WRITE_TOOLS = {"select_solution", "remove_solution", "start_formal_analysis"}
SCAN_RTC_TOOLS = {
    "record_camera_suggestions", "get_scan_guidance",
    "explain_camera_suggestion", "locate_camera_suggestion",
}
FORBIDDEN_SUGGESTION_FIELDS = {
    "severity", "score", "price", "duration", "measurement_value", "formal_risk_id",
}
ORIENTATIONS = {"up", "right", "down", "left"}
CAMERA_SUGGESTION_FIELDS = {
    "risk_code", "title", "region_label", "bbox", "polygon",
    "confidence", "short_advice", "capture_guidance",
}


class AdvisorService:
    """Room-scoped deterministic advisor orchestration.

    The language layer can explain data, but formal risks, severity, prices and
    mutations always come from the owning AssessmentService.
    """

    def __init__(self, owner) -> None:
        self.owner = owner
        self.repository = owner.repository

    def create_camera_session(self, assessment_id: str, room_id: str) -> dict:
        self.owner._owned_room(assessment_id, room_id)
        self._expire_camera_sessions()
        session_id = str(uuid.uuid4())
        now = utc_now()
        expires = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        self.repository.insert("camera_discovery_sessions", {
            "id": session_id, "assessment_id": assessment_id, "room_id": room_id,
            "status": "active", "media_ids_json": "[]", "expires_at": expires,
            "created_at": now, "updated_at": now,
        })
        self.owner.event(assessment_id, room_id, "camera_discovery_session_started", {"camera_session_id": session_id})
        return {"camera_session_id": session_id, "expires_at": expires}

    def record_camera_suggestions(
        self, assessment_id: str, room_id: str, camera_session_id: str | None,
        frame_id: str, suggestions: list[dict],
    ) -> None:
        if not camera_session_id:
            return
        session = self._owned_camera_session(assessment_id, room_id, camera_session_id)
        if session["status"] != "active" or datetime.fromisoformat(session["expires_at"]) <= datetime.now(timezone.utc):
            return
        for suggestion in suggestions[:8]:
            suggestion_id = str(suggestion.get("suggestion_id") or uuid.uuid4())
            stored = {**suggestion, "suggestion_id": suggestion_id, "frame_id": frame_id}
            self.repository.execute(
                "INSERT OR IGNORE INTO camera_suggestions "
                "(id,camera_session_id,assessment_id,room_id,frame_id,risk_code,suggestion_json,created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    suggestion_id, camera_session_id, assessment_id, room_id, frame_id,
                    str(suggestion.get("risk_code", "")), json.dumps(stored, ensure_ascii=False), utc_now(),
                ),
            )

    def prepare_camera_inspection(
        self, assessment_id: str, room_id: str, camera_session_id: str, payload: dict,
    ) -> dict:
        session = self._owned_camera_session(assessment_id, room_id, camera_session_id)
        if session["status"] != "active" or session["expires_at"] <= utc_now():
            raise self.owner.error("camera_session_not_found", 404)
        frame_id = str(payload.get("frame_id") or "")
        try:
            uuid.UUID(frame_id)
        except (ValueError, AttributeError):
            raise self.owner.error("invalid_camera_frame")
        width = int(payload.get("width") or 0)
        height = int(payload.get("height") or 0)
        captured_at_ms = int(payload.get("captured_at_ms") or 0)
        orientation = str(payload.get("orientation") or "")
        quality = payload.get("quality") or {}
        if (
            not 1 <= width <= 1920 or not 1 <= height <= 1920 or captured_at_ms <= 0
            or orientation not in ORIENTATIONS or not isinstance(quality, dict)
            or any(not isinstance(quality.get(key, 0), (int, float)) for key in ("brightness", "sharpness", "motion"))
        ):
            raise self.owner.error("invalid_camera_frame")
        existing = self.repository.fetchone(
            "SELECT * FROM camera_session_frames WHERE id=? AND camera_session_id=?",
            (frame_id, camera_session_id),
        )
        if existing:
            return self._prepared_inspection_payload(existing)
        inspection_id = str(uuid.uuid4())
        now = utc_now()
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()
        with self.repository.transaction() as connection:
            row = connection.execute(
                "SELECT COALESCE(MAX(group_id),100) AS value FROM camera_session_frames WHERE camera_session_id=?",
                (camera_session_id,),
            ).fetchone()
            group_id = int(row["value"]) + 1
            connection.execute(
                "INSERT INTO camera_session_frames "
                "(id,inspection_id,camera_session_id,assessment_id,room_id,captured_at_ms,width,height,orientation,"
                "perceptual_hash,quality_json,group_id,status,media_id,expires_at,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    frame_id, inspection_id, camera_session_id, assessment_id, room_id,
                    captured_at_ms, width, height, orientation,
                    str(payload.get("perceptual_hash") or "")[:128],
                    json.dumps(quality, ensure_ascii=False), group_id, "prepared", None,
                    expires_at, now, now,
                ),
            )
        self.owner.event(assessment_id, room_id, "advisor_rtc_inspection_prepared", {
            "camera_session_id": camera_session_id, "frame_id": frame_id,
        })
        return self._prepared_inspection_payload(self.repository.fetchone(
            "SELECT * FROM camera_session_frames WHERE id=?", (frame_id,),
        ))

    @staticmethod
    def _prepared_inspection_payload(frame: dict) -> dict:
        message = (
            f"仅分析本轮显式上传的稳定画面。inspection_id={frame['inspection_id']}。"
            "忽略历史画面；如有可靠可见线索，调用 record_camera_suggestions；"
            "不得输出风险等级、分数、价格、工期或测量数值；画面不清时只给一个补拍动作。"
        )
        return {
            "inspection_id": frame["inspection_id"], "frame_id": frame["id"],
            "group_id": frame["group_id"], "rtc_message": message,
            "expires_at": frame["expires_at"], "max_chunk_bytes": 60_000,
        }

    def complete_camera_session(
        self, assessment_id: str, room_id: str, camera_session_id: str, media_ids: list[str],
    ) -> dict:
        session = self._owned_camera_session(assessment_id, room_id, camera_session_id)
        if session["status"] not in {"active", "completed"}:
            raise self.owner.error("camera_session_not_found", 404)
        unique_ids = list(dict.fromkeys(media_ids))[:6]
        if unique_ids:
            placeholders = ",".join("?" for _ in unique_ids)
            rows = self.repository.fetchall(
                f"SELECT id,source_id FROM media WHERE assessment_id=? AND room_id=? AND id IN ({placeholders})",
                (assessment_id, room_id, *unique_ids),
            )
            if {item["id"] for item in rows} != set(unique_ids):
                raise self.owner.error("invalid_camera_session")
            for item in rows:
                if item.get("source_id"):
                    self.repository.execute(
                        "UPDATE camera_session_frames SET status='representative',media_id=?,updated_at=? "
                        "WHERE id=? AND camera_session_id=?",
                        (item["id"], utc_now(), item["source_id"], camera_session_id),
                    )
        self.repository.execute(
            "UPDATE camera_discovery_sessions SET status='completed',media_ids_json=?,updated_at=? WHERE id=?",
            (json.dumps(unique_ids), utc_now(), camera_session_id),
        )
        self.owner.event(assessment_id, room_id, "camera_discovery_session_completed", {
            "camera_session_id": camera_session_id, "representative_frame_count": len(unique_ids),
        })
        return {"camera_session_id": camera_session_id, "status": "completed", "media_ids": unique_ids}

    def create_session(
        self, assessment_id: str, room_id: str, camera_session_id: str | None = None,
        context_refs: dict | None = None,
    ) -> dict:
        room = self.owner._owned_room(assessment_id, room_id)
        self._expire_advisor_sessions()
        if camera_session_id:
            self._owned_camera_session(assessment_id, room_id, camera_session_id)
        refs = context_refs or {}
        initial_text, initial_cards = self._initial_message(
            assessment_id, room, scanning=bool(camera_session_id),
        )
        created = False
        with self.repository.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM advisor_sessions WHERE assessment_id=? AND room_id=? AND status='active' "
                "ORDER BY created_at DESC LIMIT 1",
                (assessment_id, room_id),
            ).fetchone()
            if row:
                session = dict(row)
                updates: list[str] = []
                values: list[str | None] = []
                now = utc_now()
                if not session.get("expires_at"):
                    updates.extend(["expires_at=?", "last_activity_at=?"])
                    values.extend([
                        (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(), now,
                    ])
                if camera_session_id and session.get("camera_session_id") != camera_session_id:
                    updates.append("camera_session_id=?")
                    values.append(camera_session_id)
                if updates:
                    updates.append("updated_at=?")
                    values.extend([now, session["id"]])
                    connection.execute(
                        f"UPDATE advisor_sessions SET {','.join(updates)} WHERE id=?",
                        tuple(values),
                    )
                    session = dict(connection.execute(
                        "SELECT * FROM advisor_sessions WHERE id=?", (session["id"],),
                    ).fetchone())
            else:
                created = True
                session_id = str(uuid.uuid4())
                now = utc_now()
                expires = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
                connection.execute(
                    "INSERT INTO advisor_sessions "
                    "(id,assessment_id,room_id,camera_session_id,status,provider_task_id,rtc_room_id,"
                    "rtc_user_id,rtc_bot_user_id,created_at,updated_at,ended_at,last_activity_at,expires_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        session_id, assessment_id, room_id, camera_session_id, "active", None, None,
                        None, None, now, now, None, now, expires,
                    ),
                )
                turn_id = str(uuid.uuid4())
                connection.execute(
                    "INSERT INTO advisor_turns "
                    "(id,session_id,assessment_id,room_id,role,kind,text,status,context_json,cards_json,"
                    "provider_event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        turn_id, session_id, assessment_id, room_id, "assistant", "message",
                        initial_text, "final", json.dumps(refs, ensure_ascii=False),
                        json.dumps(initial_cards, ensure_ascii=False), None, now,
                    ),
                )
                stale_turns = connection.execute(
                    "SELECT id FROM advisor_turns WHERE assessment_id=? AND room_id=? "
                    "ORDER BY created_at DESC,id DESC LIMIT -1 OFFSET 200",
                    (assessment_id, room_id),
                ).fetchall()
                if stale_turns:
                    connection.executemany(
                        "DELETE FROM advisor_turns WHERE id=?",
                        [(item["id"],) for item in stale_turns],
                    )
                session = dict(connection.execute(
                    "SELECT * FROM advisor_sessions WHERE id=?", (session_id,),
                ).fetchone())
        if created:
            self.owner.event(assessment_id, room_id, "advisor_session_started", {})
        return self._bootstrap(session["id"], refs)

    def enqueue_rtc(
        self, assessment_id: str, room_id: str, session_id: str,
        client_instance_id: str, mode: str,
    ) -> dict:
        session = self._owned_session(assessment_id, room_id, session_id)
        if not VolcengineVoiceProvider.configured():
            return {"status": "unavailable", "reason": "not_configured", "poll_after_ms": 2_000}
        client_id = self._validate_client_instance_id(client_instance_id)
        if mode not in {"audio", "audio_video"}:
            raise self.owner.error("invalid_request")
        self._cleanup_rtc_queue()
        now = utc_now()
        queue_expires = (
            datetime.now(timezone.utc) + timedelta(seconds=self._queue_setting("ANJU_ADVISOR_QUEUE_TTL_SECONDS", 180, 30, 900))
        ).isoformat()
        with self.repository.transaction() as connection:
            session_row = connection.execute(
                "SELECT * FROM advisor_sessions WHERE id=? AND assessment_id=? AND room_id=? AND status='active'",
                (session_id, assessment_id, room_id),
            ).fetchone()
            if not session_row:
                raise self.owner.error("advisor_session_not_found", 404)
            bound_client = session_row["client_instance_id"]
            bound_until = session_row["device_lease_expires_at"]
            if bound_client and bound_client != client_id and bound_until and bound_until > now:
                raise self.owner.error("advisor_room_in_use", 409)
            room_binding = connection.execute(
                "SELECT id FROM advisor_sessions WHERE assessment_id=? AND room_id=? "
                "AND client_instance_id IS NOT NULL AND client_instance_id<>? "
                "AND device_lease_expires_at IS NOT NULL AND device_lease_expires_at>? LIMIT 1",
                (assessment_id, room_id, client_id, now),
            ).fetchone()
            if room_binding:
                raise self.owner.error("advisor_room_in_use", 409)
            existing = connection.execute(
                "SELECT id FROM advisor_rtc_queue WHERE session_id=? AND client_instance_id=? "
                "AND status IN ('queued','granted','active','draining') ORDER BY created_at DESC LIMIT 1",
                (session_id, client_id),
            ).fetchone()
            if existing:
                ticket_id = existing["id"]
            else:
                queued_count = connection.execute(
                    "SELECT COUNT(*) AS value FROM advisor_rtc_queue WHERE status='queued' AND expires_at>?",
                    (now,),
                ).fetchone()["value"]
                if int(queued_count) >= self._queue_setting("ANJU_ADVISOR_MAX_QUEUED", 50, 1, 500):
                    raise self.owner.error("advisor_capacity_busy", 429)
                ticket_id = str(uuid.uuid4())
                connection.execute(
                    "INSERT INTO advisor_rtc_queue "
                    "(id,session_id,assessment_id,room_id,client_instance_id,mode,status,enqueued_at,granted_at,"
                    "activated_at,heartbeat_at,lease_expires_at,expires_at,released_at,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?, ?,NULL,NULL,NULL,NULL,?,NULL,?,?)",
                    (
                        ticket_id, session_id, assessment_id, room_id, client_id, mode, "queued",
                        now, queue_expires, now, now,
                    ),
                )
            connection.execute(
                "UPDATE advisor_sessions SET client_instance_id=?,device_lease_expires_at=?,updated_at=? WHERE id=?",
                (client_id, queue_expires, now, session_id),
            )
            self._promote_rtc_queue(connection, now)
        self.owner.event(assessment_id, room_id, "advisor_rtc_queue_joined", {"mode": mode})
        return self._queue_payload(ticket_id, session_id, client_id)

    def rtc_queue_status(
        self, assessment_id: str, room_id: str, session_id: str,
        ticket_id: str, client_instance_id: str,
    ) -> dict:
        self._owned_session(assessment_id, room_id, session_id)
        client_id = self._validate_client_instance_id(client_instance_id)
        self._cleanup_rtc_queue()
        payload = self._queue_payload(ticket_id, session_id, client_id)
        if payload["status"] == "queued":
            self.repository.execute(
                "UPDATE advisor_sessions SET device_lease_expires_at=?,updated_at=? "
                "WHERE id=? AND client_instance_id=?",
                (payload["expires_at"], utc_now(), session_id, client_id),
            )
        return payload

    def heartbeat_rtc_queue(
        self, assessment_id: str, room_id: str, session_id: str,
        ticket_id: str, client_instance_id: str,
    ) -> dict:
        self._owned_session(assessment_id, room_id, session_id)
        client_id = self._validate_client_instance_id(client_instance_id)
        self._cleanup_rtc_queue()
        now = utc_now()
        lease_expires = (
            datetime.now(timezone.utc) + timedelta(seconds=self._queue_setting("ANJU_ADVISOR_DEVICE_LEASE_SECONDS", 90, 30, 300))
        ).isoformat()
        with self.repository.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM advisor_rtc_queue WHERE id=? AND session_id=? AND client_instance_id=?",
                (ticket_id, session_id, client_id),
            ).fetchone()
            if not row or row["status"] != "active":
                raise self.owner.error("advisor_queue_expired", 410)
            connection.execute(
                "UPDATE advisor_rtc_queue SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=?",
                (now, lease_expires, now, ticket_id),
            )
            connection.execute(
                "UPDATE advisor_sessions SET last_activity_at=?,device_lease_expires_at=?,updated_at=? WHERE id=?",
                (now, lease_expires, now, session_id),
            )
        return self._queue_payload(ticket_id, session_id, client_id)

    def cancel_rtc_queue(
        self, assessment_id: str, room_id: str, session_id: str,
        ticket_id: str, client_instance_id: str,
    ) -> None:
        self._owned_session(assessment_id, room_id, session_id)
        client_id = self._validate_client_instance_id(client_instance_id)
        row = self.repository.fetchone(
            "SELECT * FROM advisor_rtc_queue WHERE id=? AND session_id=? AND client_instance_id=?",
            (ticket_id, session_id, client_id),
        )
        if not row:
            return
        if row["status"] == "active":
            self._drain_or_release_ticket(row)
        elif row["status"] in {"queued", "granted"}:
            now = utc_now()
            self.repository.execute(
                "UPDATE advisor_rtc_queue SET status='released',released_at=?,updated_at=? WHERE id=?",
                (now, now, ticket_id),
            )
            self._clear_device_binding_if_unused(session_id, client_id)
        self._cleanup_rtc_queue()

    def start_voice(
        self, assessment_id: str, room_id: str, session_id: str,
        client_instance_id: str | None = None, queue_ticket_id: str | None = None,
    ) -> dict:
        session = self._owned_session(assessment_id, room_id, session_id)
        room = self.owner._owned_room(assessment_id, room_id)
        ticket = self._activate_rtc_ticket(session, client_instance_id, queue_ticket_id, request_video=False)
        self._touch_session(session_id)
        result = self._ensure_rtc(session, room, request_video=False)
        if ticket and not result.get("available"):
            self.cancel_rtc_queue(assessment_id, room_id, session_id, ticket["id"], ticket["client_instance_id"])
        return result

    def start_realtime(
        self, assessment_id: str, room_id: str, session_id: str,
        client_instance_id: str | None = None, queue_ticket_id: str | None = None,
    ) -> dict:
        session = self._owned_session(assessment_id, room_id, session_id)
        room = self.owner._owned_room(assessment_id, room_id)
        ticket = self._activate_rtc_ticket(session, client_instance_id, queue_ticket_id, request_video=True)
        self._touch_session(session_id)
        result = self._ensure_rtc(session, room, request_video=True)
        if ticket and not result.get("available"):
            self.cancel_rtc_queue(assessment_id, room_id, session_id, ticket["id"], ticket["client_instance_id"])
        return result

    def _activate_rtc_ticket(
        self, session: dict, client_instance_id: str | None,
        queue_ticket_id: str | None, *, request_video: bool,
    ) -> dict | None:
        if not VolcengineVoiceProvider.configured():
            return None
        if not client_instance_id or not queue_ticket_id:
            raise self.owner.error("advisor_queue_required", 409)
        client_id = self._validate_client_instance_id(client_instance_id)
        self._cleanup_rtc_queue()
        now = utc_now()
        lease_expires = (
            datetime.now(timezone.utc) + timedelta(seconds=self._queue_setting("ANJU_ADVISOR_DEVICE_LEASE_SECONDS", 90, 30, 300))
        ).isoformat()
        with self.repository.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM advisor_rtc_queue WHERE id=? AND session_id=? AND assessment_id=? AND room_id=?",
                (queue_ticket_id, session["id"], session["assessment_id"], session["room_id"]),
            ).fetchone()
            if not row or row["client_instance_id"] != client_id:
                raise self.owner.error("advisor_queue_expired", 410)
            if row["status"] == "queued":
                raise self.owner.error("advisor_queue_required", 409)
            if row["status"] not in {"granted", "active"}:
                raise self.owner.error("advisor_queue_expired", 410)
            if request_video and row["mode"] != "audio_video":
                raise self.owner.error("advisor_queue_required", 409)
            session_row = connection.execute(
                "SELECT client_instance_id,device_lease_expires_at FROM advisor_sessions WHERE id=?",
                (session["id"],),
            ).fetchone()
            if (
                session_row["client_instance_id"]
                and session_row["client_instance_id"] != client_id
                and session_row["device_lease_expires_at"]
                and session_row["device_lease_expires_at"] > now
            ):
                raise self.owner.error("advisor_room_in_use", 409)
            room_binding = connection.execute(
                "SELECT id FROM advisor_sessions WHERE assessment_id=? AND room_id=? AND id<>? "
                "AND client_instance_id IS NOT NULL AND client_instance_id<>? "
                "AND device_lease_expires_at IS NOT NULL AND device_lease_expires_at>? LIMIT 1",
                (session["assessment_id"], session["room_id"], session["id"], client_id, now),
            ).fetchone()
            if room_binding:
                raise self.owner.error("advisor_room_in_use", 409)
            connection.execute(
                "UPDATE advisor_rtc_queue SET status='active',activated_at=COALESCE(activated_at,?),"
                "heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=?",
                (now, now, lease_expires, now, queue_ticket_id),
            )
            connection.execute(
                "UPDATE advisor_sessions SET client_instance_id=?,device_lease_expires_at=?,"
                "last_activity_at=?,updated_at=? WHERE id=?",
                (client_id, lease_expires, now, now, session["id"]),
            )
        return self.repository.fetchone("SELECT * FROM advisor_rtc_queue WHERE id=?", (queue_ticket_id,))

    def _cleanup_rtc_queue(self) -> None:
        now = utc_now()
        self.repository.execute(
            "UPDATE advisor_rtc_queue SET status='expired',updated_at=? "
            "WHERE status='queued' AND expires_at<=?",
            (now, now),
        )
        self.repository.execute(
            "UPDATE advisor_rtc_queue SET status='expired',updated_at=? "
            "WHERE status='granted' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",
            (now, now),
        )
        expired_active = self.repository.fetchall(
            "SELECT * FROM advisor_rtc_queue WHERE status='active' "
            "AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",
            (now,),
        )
        for row in expired_active:
            draining_until = (
                datetime.now(timezone.utc) + timedelta(
                    seconds=self._queue_setting("ANJU_ADVISOR_DEVICE_LEASE_SECONDS", 90, 30, 300)
                )
            ).isoformat()
            self.repository.execute(
                "UPDATE advisor_rtc_queue SET status='draining',lease_expires_at=?,updated_at=? "
                "WHERE id=? AND status='active'",
                (draining_until, now, row["id"]),
            )
            self.repository.execute(
                "UPDATE advisor_sessions SET device_lease_expires_at=?,updated_at=? WHERE id=?",
                (draining_until, now, row["session_id"]),
            )
            if self._stop_provider_task(row["session_id"]):
                self._mark_ticket_released(row["id"], "expired")
                self._clear_device_binding_if_unused(row["session_id"], row["client_instance_id"])
        expired_draining = self.repository.fetchall(
            "SELECT id,session_id,client_instance_id FROM advisor_rtc_queue "
            "WHERE status='draining' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",
            (now,),
        )
        for row in expired_draining:
            self._mark_ticket_released(row["id"], "expired")
            self._clear_device_binding_if_unused(row["session_id"], row["client_instance_id"])
        with self.repository.transaction() as connection:
            self._promote_rtc_queue(connection, utc_now())

    def _promote_rtc_queue(self, connection, now: str) -> None:
        maximum = self._queue_setting("ANJU_ADVISOR_MAX_ACTIVE_RTC", 8, 1, 8)
        occupied = int(connection.execute(
            "SELECT COUNT(*) AS value FROM advisor_rtc_queue "
            "WHERE status IN ('granted','active','draining')",
        ).fetchone()["value"])
        slots = max(0, maximum - occupied)
        if slots == 0:
            return
        rows = connection.execute(
            "SELECT id,session_id,client_instance_id FROM advisor_rtc_queue "
            "WHERE status='queued' AND expires_at>? ORDER BY enqueued_at,id LIMIT ?",
            (now, slots),
        ).fetchall()
        grant_expires = (
            datetime.now(timezone.utc) + timedelta(seconds=self._queue_setting("ANJU_ADVISOR_QUEUE_GRANT_SECONDS", 20, 5, 60))
        ).isoformat()
        for row in rows:
            connection.execute(
                "UPDATE advisor_rtc_queue SET status='granted',granted_at=?,lease_expires_at=?,updated_at=? "
                "WHERE id=? AND status='queued'",
                (now, grant_expires, now, row["id"]),
            )
            connection.execute(
                "UPDATE advisor_sessions SET client_instance_id=?,device_lease_expires_at=?,updated_at=? WHERE id=?",
                (row["client_instance_id"], grant_expires, now, row["session_id"]),
            )

    def _queue_payload(self, ticket_id: str, session_id: str, client_instance_id: str) -> dict:
        row = self.repository.fetchone(
            "SELECT * FROM advisor_rtc_queue WHERE id=? AND session_id=? AND client_instance_id=?",
            (ticket_id, session_id, client_instance_id),
        )
        if not row or row["status"] in {"expired", "released"}:
            raise self.owner.error("advisor_queue_expired", 410)
        position = 0
        if row["status"] == "queued":
            position = 1 + int(self.repository.fetchone(
                "SELECT COUNT(*) AS value FROM advisor_rtc_queue WHERE status='queued' "
                "AND (enqueued_at<? OR (enqueued_at=? AND id<?))",
                (row["enqueued_at"], row["enqueued_at"], row["id"]),
            )["value"])
        return {
            "ticket_id": row["id"], "status": row["status"], "position": position,
            "expires_at": row.get("lease_expires_at") or row["expires_at"],
            "poll_after_ms": 2_000, "mode": row["mode"],
        }

    def _drain_or_release_ticket(self, ticket: dict) -> None:
        now = utc_now()
        draining_until = (
            datetime.now(timezone.utc) + timedelta(seconds=self._queue_setting("ANJU_ADVISOR_DEVICE_LEASE_SECONDS", 90, 30, 300))
        ).isoformat()
        self.repository.execute(
            "UPDATE advisor_rtc_queue SET status='draining',lease_expires_at=?,updated_at=? "
            "WHERE id=? AND status='active'",
            (draining_until, now, ticket["id"]),
        )
        self.repository.execute(
            "UPDATE advisor_sessions SET device_lease_expires_at=?,updated_at=? WHERE id=?",
            (draining_until, now, ticket["session_id"]),
        )
        if self._stop_provider_task(ticket["session_id"]):
            self._mark_ticket_released(ticket["id"], "released")
            self._clear_device_binding_if_unused(ticket["session_id"], ticket["client_instance_id"])

    def _mark_ticket_released(self, ticket_id: str, status: str) -> None:
        now = utc_now()
        self.repository.execute(
            "UPDATE advisor_rtc_queue SET status=?,released_at=?,updated_at=? WHERE id=?",
            (status, now, now, ticket_id),
        )

    def _stop_provider_task(self, session_id: str) -> bool:
        session = self.repository.fetchone("SELECT * FROM advisor_sessions WHERE id=?", (session_id,))
        if not session or not session.get("provider_task_id"):
            return True
        try:
            VolcengineVoiceProvider().stop(VoiceConnection(
                os.environ.get("ANJU_VOLC_RTC_APP_ID", ""), session.get("rtc_room_id") or "",
                session.get("rtc_user_id") or "", session.get("rtc_bot_user_id") or "",
                session["provider_task_id"], "", utc_now(),
            ))
        except VoiceProviderError:
            return False
        self.repository.execute(
            "UPDATE advisor_sessions SET provider_task_id=NULL,rtc_room_id=NULL,rtc_user_id=NULL,"
            "rtc_bot_user_id=NULL,rtc_media_mode='audio',rtc_vision_mode=NULL,updated_at=? WHERE id=?",
            (utc_now(), session_id),
        )
        return True

    def _clear_device_binding_if_unused(self, session_id: str, client_instance_id: str) -> None:
        live = self.repository.fetchone(
            "SELECT id FROM advisor_rtc_queue WHERE session_id=? AND client_instance_id=? "
            "AND status IN ('queued','granted','active','draining') LIMIT 1",
            (session_id, client_instance_id),
        )
        if not live:
            self.repository.execute(
                "UPDATE advisor_sessions SET client_instance_id=NULL,device_lease_expires_at=NULL,updated_at=? "
                "WHERE id=? AND client_instance_id=?",
                (utc_now(), session_id, client_instance_id),
            )

    @staticmethod
    def _queue_setting(name: str, default: int, minimum: int, maximum: int) -> int:
        try:
            return max(minimum, min(maximum, int(os.environ.get(name, str(default)))))
        except ValueError:
            return default

    def _validate_client_instance_id(self, value: str) -> str:
        client_id = str(value or "").strip()
        try:
            parsed = uuid.UUID(client_id)
        except (ValueError, AttributeError):
            parsed = None
        if len(client_id) > 80 or parsed is None:
            raise self.owner.error("invalid_request")
        return client_id

    def handle_function_callback(self, payload: dict) -> dict:
        expected = os.environ.get("ANJU_VOLC_FC_CALLBACK_SIGNATURE", "").strip()
        supplied = str(payload.get("Signature") or "")
        if not expected or not secrets.compare_digest(expected, supplied):
            raise self.owner.error("rtc_callback_denied", 401)
        if str(payload.get("AppId") or "") != os.environ.get("ANJU_VOLC_RTC_APP_ID", "").strip():
            raise self.owner.error("rtc_callback_denied", 401)
        event_type = str(payload.get("Type") or "")
        if event_type == "information":
            return {"status": "acknowledged"}
        if event_type != "tool_calls":
            raise self.owner.error("rtc_callback_invalid")
        room_id = str(payload.get("RoomID") or payload.get("RoomId") or "")
        task_id = str(payload.get("TaskID") or payload.get("TaskId") or "")
        session = self.repository.fetchone(
            "SELECT * FROM advisor_sessions WHERE rtc_room_id=? AND provider_task_id=? AND status='active'",
            (room_id, task_id),
        )
        if not session:
            raise self.owner.error("rtc_callback_denied", 401)
        try:
            calls = json.loads(str(payload.get("Message") or "[]"))
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise self.owner.error("rtc_callback_invalid") from error
        if isinstance(calls, dict):
            calls = calls.get("tool_calls")
        if not isinstance(calls, list) or not 1 <= len(calls) <= 4:
            raise self.owner.error("rtc_callback_invalid")
        results = [self._execute_provider_tool(session, call) for call in calls]
        return {"status": "completed", "results": results}

    def _execute_provider_tool(self, session: dict, call: dict) -> dict:
        if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
            raise self.owner.error("rtc_callback_invalid")
        provider_call_id = str(call.get("id") or "")[:160]
        tool_name = str(call["function"].get("name") or "")
        if not provider_call_id or tool_name not in SCAN_RTC_TOOLS:
            raise self.owner.error("advisor_tool_not_allowed")
        existing = self.repository.fetchone(
            "SELECT session_id,result_json,status FROM advisor_tool_calls WHERE provider_call_id=?", (provider_call_id,),
        )
        if existing:
            if existing["session_id"] != session["id"]:
                raise self.owner.error("rtc_callback_denied", 401)
            return json.loads(existing["result_json"] or "{}")
        try:
            arguments = json.loads(str(call["function"].get("arguments") or "{}"))
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise self.owner.error("rtc_callback_invalid") from error
        if not isinstance(arguments, dict):
            raise self.owner.error("rtc_callback_invalid")
        started = time.monotonic()
        now = utc_now()
        self.repository.insert("advisor_tool_calls", {
            "id": str(uuid.uuid4()), "session_id": session["id"],
            "assessment_id": session["assessment_id"], "room_id": session["room_id"],
            "provider_call_id": provider_call_id, "provider_response_id": None,
            "tool_name": tool_name, "arguments_json": json.dumps(arguments, ensure_ascii=False),
            "result_json": "{}", "status": "running", "schema_result": "pending",
            "latency_ms": None, "error_type": None, "created_at": now, "completed_at": None,
        })
        error_type: str | None = None
        try:
            result = self._run_scan_tool(session, tool_name, arguments)
            status, schema_result = "completed", "valid"
        except Exception as error:
            error_type = getattr(error, "code", "tool_execution_failed")
            result = {"ok": False, "error": error_type, "message": "当前画面还不能可靠记录，请停稳后再试。"}
            status, schema_result = "failed", "rejected"
        latency_ms = int((time.monotonic() - started) * 1000)
        self.repository.execute(
            "UPDATE advisor_tool_calls SET result_json=?,status=?,schema_result=?,latency_ms=?,error_type=?,completed_at=? "
            "WHERE provider_call_id=?",
            (json.dumps(result, ensure_ascii=False), status, schema_result, latency_ms, error_type, utc_now(), provider_call_id),
        )
        try:
            VolcengineVoiceProvider().update_function_result(
                app_id=os.environ.get("ANJU_VOLC_RTC_APP_ID", ""),
                room_id=session.get("rtc_room_id") or "", task_id=session.get("provider_task_id") or "",
                tool_call_id=provider_call_id, result=result,
            )
        except VoiceProviderError:
            pass
        if tool_name == "record_camera_suggestions" and schema_result == "valid" and result.get("ok"):
            VolcengineVoiceProvider.mark_video_probe_success()
        self.owner.event(session["assessment_id"], session["room_id"], "advisor_rtc_tool_call", {
            "provider": "volcengine", "tool_name": tool_name, "schema_result": schema_result,
            "latency_ms": latency_ms, "error_type": error_type,
        })
        return result

    def _run_scan_tool(self, session: dict, tool_name: str, arguments: dict) -> dict:
        if tool_name == "record_camera_suggestions":
            return self._record_rtc_suggestions(session, arguments)
        if tool_name == "get_scan_guidance" and arguments:
            raise self.owner.error("rtc_tool_schema_invalid")
        if tool_name in {"locate_camera_suggestion", "explain_camera_suggestion"} and set(arguments) != {"camera_suggestion_id"}:
            raise self.owner.error("rtc_tool_schema_invalid")
        suggestions = self._suggestions_for_session(session.get("camera_session_id")) if session.get("camera_session_id") else []
        if tool_name == "get_scan_guidance":
            return {
                "ok": True,
                "guidance": suggestions[-1].get("capture_guidance") if suggestions else "缓慢移动，拍清地面、通道和常用借力位置。",
            }
        suggestion_id = str(arguments.get("camera_suggestion_id") or "")
        selected = next((item for item in suggestions if item.get("suggestion_id") == suggestion_id), None)
        if not selected:
            raise self.owner.error("camera_suggestion_not_found", 404)
        if tool_name == "locate_camera_suggestion":
            return {"ok": True, "frame_id": selected.get("frame_id"), "region": selected.get("region")}
        return {
            "ok": True, "title": selected.get("title"), "evidence": selected.get("evidence"),
            "short_advice": selected.get("short_advice"), "temporary": True,
        }

    def _record_rtc_suggestions(self, session: dict, arguments: dict) -> dict:
        if set(arguments) != {"inspection_id", "suggestions"} or FORBIDDEN_SUGGESTION_FIELDS.intersection(arguments):
            raise self.owner.error("rtc_tool_schema_invalid")
        inspection_id = str(arguments.get("inspection_id") or "")
        frame = self.repository.fetchone(
            "SELECT * FROM camera_session_frames WHERE inspection_id=? AND assessment_id=? AND room_id=? AND camera_session_id=?",
            (inspection_id, session["assessment_id"], session["room_id"], session.get("camera_session_id")),
        )
        if not frame or frame["status"] != "prepared" or frame["expires_at"] <= utc_now():
            raise self.owner.error("camera_inspection_expired")
        candidates = arguments.get("suggestions")
        if not isinstance(candidates, list) or len(candidates) > 4:
            raise self.owner.error("rtc_tool_schema_invalid")
        room = self.owner._owned_room(session["assessment_id"], session["room_id"])
        catalog = {
            item["risk_code"]: item
            for item in self.owner.rules.live_camera_rules_for("h5_home", room["room_type"])
        }
        accepted: list[dict] = []
        for item in candidates:
            if (
                not isinstance(item, dict)
                or FORBIDDEN_SUGGESTION_FIELDS.intersection(item)
                or not set(item).issubset(CAMERA_SUGGESTION_FIELDS)
            ):
                raise self.owner.error("rtc_tool_schema_invalid")
            code = str(item.get("risk_code") or "")
            confidence = item.get("confidence")
            if code not in catalog or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
                continue
            bbox = item.get("bbox")
            polygon = item.get("polygon")
            if (bbox is None) == (polygon is None):
                continue
            region = {"type": "bbox", **bbox} if isinstance(bbox, dict) else {"type": "polygon", "points": polygon}
            try:
                region = self.owner._validate_region(region)
            except Exception:
                continue
            rule = catalog[code]
            region_label = self.owner._sanitize_unverified_measurements(str(item.get("region_label") or "画面中的可见位置"))[:160]
            guidance = self.owner._sanitize_unverified_measurements(str(item.get("capture_guidance") or "请保持镜头稳定，再拍一个清晰角度。"))[:160]
            accepted.append({
                "suggestion_id": str(uuid.uuid4()), "risk_code": code, "title": rule["title"],
                "short_advice": rule["short_advice"], "evidence": region_label,
                "confidence": float(confidence), "needs_manual_check": True,
                "possible_repeat": True, "region": region, "temporary": True,
                "save_as_evidence_recommended": True, "capture_guidance": guidance,
            })
        self.record_camera_suggestions(
            session["assessment_id"], session["room_id"], session.get("camera_session_id"), frame["id"], accepted,
        )
        self.repository.execute(
            "UPDATE camera_session_frames SET status=?,updated_at=? WHERE inspection_id=?",
            ("suggested" if accepted else "inspected", utc_now(), inspection_id),
        )
        return {
            "ok": True, "inspection_id": inspection_id, "frame_id": frame["id"],
            "recorded": len(accepted), "suggestions": accepted,
            "message": "已记录为待确认提示，正式分析会重新判断。" if accepted else "这张画面没有足够可靠的待确认提示。",
        }

    def list_turns(self, assessment_id: str, room_id: str, session_id: str) -> dict:
        session = self._owned_session(assessment_id, room_id, session_id)
        self._touch_session(session_id)
        turns = self._room_turns(assessment_id, room_id)
        return {"turns": turns, "next_cursor": None}

    def add_message(
        self, assessment_id: str, room_id: str, session_id: str, text: str,
        context_refs: dict | None = None, requested_action: dict | None = None,
    ) -> dict:
        session = self._owned_session(assessment_id, room_id, session_id)
        self._touch_session(session_id)
        clean_text = " ".join(str(text).split())[:500]
        if not clean_text:
            raise self.owner.error("advisor_message_invalid")
        refs = self._validate_context_refs(assessment_id, room_id, context_refs or {})
        user_turn = self._insert_turn(session, "user", "message", clean_text, [], refs)
        if requested_action:
            assistant_turn = self._request_confirmation(session, clean_text, refs, requested_action)
        else:
            answer, cards = self._answer(assessment_id, room_id, clean_text, refs, session)
            assistant_turn = self._insert_turn(session, "assistant", "message", answer, cards, refs)
        self._trim_turns(session_id)
        return {"user_turn": user_turn, "assistant_turn": assistant_turn}

    def add_transcript(
        self, assessment_id: str, room_id: str, session_id: str, role: str, text: str,
        provider_event_id: str, context_refs: dict | None = None,
    ) -> dict:
        session = self._owned_session(assessment_id, room_id, session_id)
        self._touch_session(session_id)
        if role not in {"user", "assistant"} or not provider_event_id or len(provider_event_id) > 120:
            raise self.owner.error("advisor_message_invalid")
        existing = self.repository.fetchone(
            "SELECT * FROM advisor_turns WHERE session_id=? AND provider_event_id=?",
            (session_id, provider_event_id),
        )
        if existing:
            return self._serialize_turn(existing)
        clean_text = " ".join(str(text).split())[:500]
        if not clean_text:
            raise self.owner.error("advisor_message_invalid")
        refs = self._validate_context_refs(assessment_id, room_id, context_refs or {})
        turn = self._insert_turn(session, role, "transcript", clean_text, [], refs, provider_event_id)
        self._trim_turns(session_id)
        return turn

    def decide_confirmation(
        self, assessment_id: str, room_id: str, session_id: str,
        confirmation_id: str, approved: bool,
    ) -> dict:
        session = self._owned_session(assessment_id, room_id, session_id)
        self._touch_session(session_id)
        confirmation = self.repository.fetchone(
            "SELECT * FROM advisor_confirmations WHERE id=? AND session_id=? AND assessment_id=? AND room_id=?",
            (confirmation_id, session_id, assessment_id, room_id),
        )
        if not confirmation or confirmation["status"] != "pending":
            raise self.owner.error("advisor_confirmation_not_found", 404)
        if not approved:
            self.repository.execute(
                "UPDATE advisor_confirmations SET status='rejected',decided_at=? WHERE id=?",
                (utc_now(), confirmation_id),
            )
            turn = self._insert_turn(session, "assistant", "system", "好的，这次没有修改检查结果。", [], {})
            self._trim_turns(session_id)
            return {"confirmation_id": confirmation_id, "status": "rejected", "turn": turn}
        tool = confirmation["tool_name"]
        arguments = json.loads(confirmation["arguments_json"])
        result: dict | None = None
        if tool == "start_formal_analysis":
            result = self.owner.start_analysis(assessment_id, room_id)
            message = "已开始正式分析。完成后会回到顾问页展示规则确认的风险。"
        elif tool == "select_solution":
            self._validate_solution_reference(assessment_id, room_id, arguments)
            result = self.owner.select_solution(assessment_id, arguments["risk_id"], arguments["solution_package_id"])
            message = "已把这个方案加入改造清单，预算会按结构化价格规则重新汇总。"
        elif tool == "remove_solution":
            risk = self.owner._owned_risk(assessment_id, arguments.get("risk_id", ""))
            if risk["room_id"] != room_id:
                raise self.owner.error("risk_not_found", 404)
            self.owner.remove_solution(assessment_id, risk["id"])
            message = "已从改造清单移除这项方案。"
        else:
            raise self.owner.error("advisor_tool_not_allowed")
        self.repository.execute(
            "UPDATE advisor_confirmations SET status='approved',decided_at=? WHERE id=?",
            (utc_now(), confirmation_id),
        )
        turn = self._insert_turn(session, "assistant", "system", message, [], {})
        self._trim_turns(session_id)
        self.owner.event(assessment_id, room_id, "advisor_action_confirmed", {"tool_name": tool})
        return {"confirmation_id": confirmation_id, "status": "approved", "turn": turn, "result": result}

    def end_session(self, assessment_id: str, room_id: str, session_id: str) -> None:
        session = self._owned_session(assessment_id, room_id, session_id)
        tickets = self.repository.fetchall(
            "SELECT * FROM advisor_rtc_queue WHERE session_id=? "
            "AND status IN ('queued','granted','active','draining')",
            (session_id,),
        )
        for ticket in tickets:
            if ticket["status"] == "active":
                self._drain_or_release_ticket(ticket)
            elif ticket["status"] in {"queued", "granted"}:
                self._mark_ticket_released(ticket["id"], "released")
        if session.get("provider_task_id") and not any(item["status"] == "active" for item in tickets):
            self._stop_provider_task(session_id)
        self.repository.execute(
            "UPDATE advisor_sessions SET status='ended',ended_at=?,updated_at=? WHERE id=?",
            (utc_now(), utc_now(), session_id),
        )
        self._cleanup_rtc_queue()
        self.owner.event(assessment_id, room_id, "advisor_session_ended", {})

    def _bootstrap(self, session_id: str, context_refs: dict, rtc: dict | None = None) -> dict:
        session = self.repository.fetchone("SELECT * FROM advisor_sessions WHERE id=?", (session_id,))
        room = self.owner._owned_room(session["assessment_id"], session["room_id"])
        phase = self._session_phase(room, session)
        media = self.owner._media(room["id"])
        risks = self.owner._risks(room["id"]) if phase == "formal" else []
        camera = self._camera_context(session)
        return {
            "session_id": session_id,
            "phase": phase,
            "room": {"room_id": room["id"], "room_type": room["room_type"], "room_name": ROOM_NAMES[room["room_type"]], "status": room["status"]},
            "current_media": media[-1] if media else None,
            "media": media,
            "suggestions": camera["suggestions"] if phase != "formal" else [],
            "camera_session_id": camera["camera_session_id"],
            "risks": risks,
            "quick_prompts": QUICK_PROMPTS if phase == "formal" else SCAN_QUICK_PROMPTS,
            "turns": self._room_turns(session["assessment_id"], session["room_id"]),
            "context_refs": context_refs,
            "rtc": rtc if rtc is not None else self._rtc_payload(session),
            "events": self._issue_event_token(session),
            "prompt_version": "anju_voice_advisor_v1",
        }

    def consume_event_token(self, assessment_id: str, room_id: str, session_id: str, token: str) -> bool:
        if not token:
            return False
        now = utc_now()
        with self.repository.transaction() as connection:
            row = connection.execute(
                "SELECT status,event_token_hash,event_token_expires_at,event_token_used_at FROM advisor_sessions "
                "WHERE id=? AND assessment_id=? AND room_id=?",
                (session_id, assessment_id, room_id),
            ).fetchone()
            if not row or row["status"] != "active" or row["event_token_used_at"]:
                return False
            if not row["event_token_hash"] or row["event_token_hash"] != token_hash(token):
                return False
            if not row["event_token_expires_at"] or row["event_token_expires_at"] <= now:
                return False
            updated = connection.execute(
                "UPDATE advisor_sessions SET event_token_used_at=? WHERE id=? AND event_token_used_at IS NULL",
                (now, session_id),
            )
            return updated.rowcount == 1

    def _issue_event_token(self, session: dict) -> dict:
        token = secrets.token_urlsafe(32)
        expires = (datetime.now(timezone.utc) + timedelta(minutes=2)).isoformat()
        self.repository.execute(
            "UPDATE advisor_sessions SET event_token_hash=?,event_token_expires_at=?,event_token_used_at=NULL WHERE id=?",
            (token_hash(token), expires, session["id"]),
        )
        return {
            "websocket_path": (
                f"/api/v2/assessments/{session['assessment_id']}/rooms/{session['room_id']}"
                f"/advisor/sessions/{session['id']}/events"
            ),
            "token": token,
            "expires_at": expires,
        }

    def _initial_message(self, assessment_id: str, room: dict, scanning: bool = False) -> tuple[str, list[dict]]:
        phase = "draft" if scanning else self._phase(room)
        room_name = ROOM_NAMES[room["room_type"]]
        if phase == "formal":
            risks = self.owner._risks(room["id"])
            if not risks:
                return f"{room_name}的正式检查已完成，当前已检查区域暂未发现明确风险。你也可以问我还需要补拍哪里。", []
            text = f"您好，我是您的 AI 适老顾问。{room_name}的正式检查已完成，共发现 {len(risks)} 项有证据支持的风险。"
            return text, [self._risk_summary_card(risks)]
        text = (
            f"我会在{room_name}扫描时提醒你放慢移动，拍清地面、通道和常用借力位置。"
            "扫描中的内容只是待确认提示，不计分，也不提供预算。"
        )
        return text, [{"type": "system_state", "state": "scanning", "label": "扫描中指引", "media_count": 0}]

    def _answer(self, assessment_id: str, room_id: str, text: str, refs: dict, session: dict) -> tuple[str, list[dict]]:
        room = self.owner._owned_room(assessment_id, room_id)
        phase = self._session_phase(room, session)
        risks = self.owner._risks(room_id) if phase == "formal" else []
        selected_risk = next((item for item in risks if item["risk_id"] == refs.get("risk_id")), risks[0] if risks else None)
        if "补拍" in text or "没拍" in text:
            missing = []
            for media in self.owner._media(room_id):
                missing.extend(media["quality"].get("missing_views", []))
            values = list(dict.fromkeys(missing))[:4]
            if values:
                return "建议再补拍：" + "、".join(values) + "。请保持地面和主要通道清晰。", []
            return "目前没有明确的补拍项。若要提高覆盖度，可以从门口、地面和常用起身位置各补一张清晰照片。", []
        if phase != "formal":
            suggestions = self._latest_suggestions(assessment_id, room_id)
            selected = next(
                (item for item in suggestions if item.get("suggestion_id") == refs.get("camera_suggestion_id")),
                None,
            )
            if "预算" in text or "价格" in text or "多少钱" in text:
                return "现在只是扫描中的待确认提示，不能据此给出预算。结束扫描后会直接进入正式分析，价格将来自结构化规则区间。", []
            refers_to_place = any(value in text for value in ("这个地方", "这里", "这处"))
            if refers_to_place and suggestions and not selected:
                return "请先点选画面上的编号，或在底部提示列表中选一处，我再说明你指的位置。", []
            if "扶手" in text:
                prefix = f"你选中的位置可能与“{selected['title']}”有关。" if selected else "目前只能根据画面判断是否存在需要借力的使用场景。"
                return (
                    prefix + "墙体基层、防水和管线条件仍需现场确认；正式方案以扫描结束后的分析结果为准。",
                    [self._suggestion_card([selected])] if selected else [],
                )
            if selected:
                advice = selected.get("short_advice") or "建议换个角度继续确认"
                return (
                    f"你选中的位置可能存在“{selected['title']}”。{selected.get('evidence', '')}。{advice}。"
                    "这仍是待确认提示，不会直接进入评分。",
                    [self._suggestion_card([selected])],
                )
            if suggestions:
                return "本次扫描发现了以下待确认提示。它们不会进入评分，正式结论以分析结果为准。", [self._suggestion_card(suggestions)]
            return "当前还没有可靠提示。请缓慢移动相机，并拍清地面、门槛、通道和常用借力位置。", []
        if not risks:
            return "当前已检查区域暂未发现明确风险。你可以继续补拍其他角度来提高覆盖度。", []
        if any(value in text for value in ("这个地方", "这里", "这处")) and not refs.get("risk_id"):
            return "请先选中一张参考画面中的风险，或从风险详情进入顾问，我再说明你指的位置。", []
        if "预算" in text or "价格" in text or "多少钱" in text:
            report = self.owner.report(assessment_id)
            budget = report["budget"]
            if not report["selected_items"]:
                return "还没有选择改造方案，所以暂时没有总预算。先选择某项风险的 A、B 或 C 方案，我会按规则汇总价格区间。", []
            return "已按去重后的结构化价格规则汇总当前改造清单。实际费用仍需结合地区和现场条件确认。", [{"type": "budget", **budget, "disclaimer": report["price_disclaimer"]}]
        if "怎么改" in text or "方案" in text or "低成本" in text or "扶手" in text:
            solutions = self.owner.risk_solutions(assessment_id, selected_risk["risk_id"])
            prefix = "针对这项正式风险，可以从立即止险、推荐改造和专业改造三档选择。"
            if "扶手" in text:
                prefix += "扶手安装前还要现场确认墙体基层、防水和管线。"
            return prefix, [self._solutions_card(selected_risk, solutions)]
        if "先做" in text or "重要" in text:
            return f"建议先处理“{selected_risk['title']}”。这是当前排序最靠前的风险，先查看证据，再选择适合家庭条件的方案。", [{"type": "risk_evidence", "risk": selected_risk}]
        return "本次正式检查发现了以下风险。点击任一项可以查看证据位置，也可以继续问我具体怎么改。", [self._risk_summary_card(risks)]

    def _request_confirmation(self, session: dict, text: str, refs: dict, requested_action: dict) -> dict:
        tool = str(requested_action.get("tool_name") or "")
        if tool not in WRITE_TOOLS:
            raise self.owner.error("advisor_tool_not_allowed")
        arguments = dict(requested_action.get("arguments") or {})
        if tool == "select_solution":
            self._validate_solution_reference(session["assessment_id"], session["room_id"], arguments)
            label = "把这个方案加入改造清单"
        elif tool == "remove_solution":
            risk = self.owner._owned_risk(session["assessment_id"], arguments.get("risk_id", ""))
            if risk["room_id"] != session["room_id"]:
                raise self.owner.error("risk_not_found", 404)
            label = "从改造清单移除这项方案"
        else:
            label = "确认代表画面并开始正式分析"
        confirmation_id = str(uuid.uuid4())
        self.repository.insert("advisor_confirmations", {
            "id": confirmation_id, "session_id": session["id"], "assessment_id": session["assessment_id"],
            "room_id": session["room_id"], "tool_name": tool, "arguments_json": json.dumps(arguments),
            "status": "pending", "created_at": utc_now(), "decided_at": None,
        })
        return self._insert_turn(session, "assistant", "confirmation", f"请确认：{label}。", [{
            "type": "confirmation", "confirmation_id": confirmation_id, "tool_name": tool,
            "label": label, "status": "pending",
        }], refs)

    def _validate_solution_reference(self, assessment_id: str, room_id: str, arguments: dict) -> None:
        risk = self.owner._owned_risk(assessment_id, str(arguments.get("risk_id") or ""))
        if risk["room_id"] != room_id:
            raise self.owner.error("risk_not_found", 404)
        allowed = {item["solution_package_id"] for item in self.owner.rules.solutions_for(risk["risk_code"])}
        if arguments.get("solution_package_id") not in allowed:
            raise self.owner.error("solution_not_allowed")

    def _validate_context_refs(self, assessment_id: str, room_id: str, refs: dict) -> dict:
        value = {"room_id": room_id}
        media_id = refs.get("media_id")
        if media_id:
            media = self.repository.fetchone("SELECT id FROM media WHERE id=? AND assessment_id=? AND room_id=?", (media_id, assessment_id, room_id))
            if not media:
                raise self.owner.error("media_not_found", 404)
            value["media_id"] = media_id
        risk_id = refs.get("risk_id")
        if risk_id:
            risk = self.owner._owned_risk(assessment_id, risk_id)
            if risk["room_id"] != room_id:
                raise self.owner.error("risk_not_found", 404)
            value["risk_id"] = risk_id
        solution_id = refs.get("solution_package_id")
        if solution_id:
            if not risk_id:
                raise self.owner.error("solution_not_allowed")
            self._validate_solution_reference(assessment_id, room_id, {"risk_id": risk_id, "solution_package_id": solution_id})
            value["solution_package_id"] = solution_id
        camera_session_id = refs.get("camera_session_id")
        if camera_session_id:
            self._owned_camera_session(assessment_id, room_id, camera_session_id)
            value["camera_session_id"] = camera_session_id
        suggestion_id = refs.get("camera_suggestion_id")
        if suggestion_id:
            row = self.repository.fetchone(
                "SELECT camera_session_id,frame_id FROM camera_suggestions "
                "WHERE id=? AND assessment_id=? AND room_id=?",
                (suggestion_id, assessment_id, room_id),
            )
            if not row or (camera_session_id and row["camera_session_id"] != camera_session_id):
                raise self.owner.error("camera_suggestion_not_found", 404)
            value["camera_session_id"] = row["camera_session_id"]
            value["camera_suggestion_id"] = suggestion_id
            frame_id = refs.get("frame_id")
            if frame_id and frame_id != row["frame_id"]:
                raise self.owner.error("camera_suggestion_not_found", 404)
            value["frame_id"] = row["frame_id"]
        elif refs.get("frame_id"):
            raise self.owner.error("camera_suggestion_not_found", 404)
        return value

    def _ensure_rtc(self, session: dict, room: dict, *, request_video: bool) -> dict:
        provider = VolcengineVoiceProvider()
        if not provider.configured():
            return {"available": False, "reason": "not_configured"}
        if session.get("provider_task_id"):
            return self._rtc_payload(session)
        video_enabled = bool(request_video and session.get("camera_session_id") and provider.video_configured())
        started_at = time.monotonic()
        try:
            initial, _ = self._initial_message(session["assessment_id"], room, scanning=self._session_phase(room, session) == "draft")
            context = self._voice_context(session["assessment_id"], room["id"], session)
            connection = provider.start(
                session["id"], initial, context,
                video_enabled=video_enabled,
                tools=self._scan_tool_declarations(room["room_type"]) if video_enabled else None,
            )
        except VoiceProviderError as error:
            self.owner.event(session["assessment_id"], room["id"], "advisor_voice_provider_call", {
                "provider": "volcengine", "model": os.environ.get("ANJU_VOLC_VOICE_MODEL_ID", "configured_voice_model"),
                "prompt_version": "anju_voice_advisor_v1", "schema_result": "not_applicable",
                "latency_ms": int((time.monotonic() - started_at) * 1000), "error_type": str(error),
            })
            return {"available": False, "reason": "provider_unavailable"}
        self.repository.execute(
            "UPDATE advisor_sessions SET provider_task_id=?,rtc_room_id=?,rtc_user_id=?,rtc_bot_user_id=?,"
            "rtc_media_mode=?,rtc_vision_mode=?,updated_at=? WHERE id=?",
            (
                connection.task_id, connection.room_id, connection.user_id, connection.bot_user_id,
                "audio_video" if video_enabled else "audio", "rtc_snapshot" if video_enabled else None,
                utc_now(), session["id"],
            ),
        )
        self.owner.event(session["assessment_id"], room["id"], "advisor_voice_provider_call", {
            "provider": "volcengine", "model": os.environ.get("ANJU_VOLC_VOICE_MODEL_ID", "configured_voice_model"),
            "prompt_version": "anju_voice_advisor_v1", "schema_result": "not_applicable",
            "latency_ms": int((time.monotonic() - started_at) * 1000), "error_type": None,
        })
        return {
            "available": True, "provider": "volcengine", "app_id": connection.app_id,
            "room_id": connection.room_id, "user_id": connection.user_id,
            "bot_user_id": connection.bot_user_id, "token": connection.token,
            "expires_at": connection.expires_at,
            **self._rtc_media_fields(video_enabled),
        }

    def _rtc_payload(self, session: dict) -> dict:
        if not VolcengineVoiceProvider.configured():
            return {"available": False, "reason": "not_configured"}
        if not session.get("provider_task_id"):
            return {
                "available": True, "provider": "volcengine", "requires_start": True,
                **self._rtc_media_fields(bool(session.get("camera_session_id") and VolcengineVoiceProvider.video_configured())),
            }
        expires_epoch = int(datetime.now(timezone.utc).timestamp()) + 15 * 60
        try:
            token = build_rtc_token(
                os.environ["ANJU_VOLC_RTC_APP_ID"], os.environ["ANJU_VOLC_RTC_APP_KEY"],
                session["rtc_room_id"], session["rtc_user_id"], expires_epoch,
            )
        except VoiceProviderError:
            return {"available": False, "reason": "provider_unavailable"}
        return {
            "available": True, "provider": "volcengine", "app_id": os.environ["ANJU_VOLC_RTC_APP_ID"],
            "room_id": session["rtc_room_id"], "user_id": session["rtc_user_id"],
            "bot_user_id": session["rtc_bot_user_id"], "token": token,
            "expires_at": datetime.fromtimestamp(expires_epoch, tz=timezone.utc).isoformat(),
            **self._rtc_media_fields(session.get("rtc_media_mode") == "audio_video"),
        }

    @staticmethod
    def _rtc_media_fields(video_enabled: bool) -> dict:
        return {
            "media_mode": "audio_video" if video_enabled else "audio",
            "video_available": video_enabled,
            "vision_mode": "rtc_snapshot" if video_enabled else None,
            "snapshot_interval_ms": 900 if video_enabled else None,
            "snapshot_height": 720 if video_enabled else None,
            "image_detail": "low" if video_enabled else None,
        }

    def _scan_tool_declarations(self, room_type: str) -> list[dict]:
        risk_codes = sorted(
            item["risk_code"]
            for item in self.owner.rules.live_camera_rules_for("h5_home", room_type)
        )
        bbox_schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "x": {"type": "number", "minimum": 0, "maximum": 1},
                "y": {"type": "number", "minimum": 0, "maximum": 1},
                "width": {"type": "number", "minimum": 0, "maximum": 1},
                "height": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["x", "y", "width", "height"],
        }
        polygon_schema = {
            "type": "array", "minItems": 3, "maxItems": 16,
            "items": {
                "type": "array", "minItems": 2, "maxItems": 2,
                "items": {"type": "number", "minimum": 0, "maximum": 1},
            },
        }
        return [
            {
                "type": "function",
                "function": {
                    "name": "record_camera_suggestions",
                    "description": "仅为带 inspection_id 的显式稳定画面记录不计分的待确认提示；看不清时返回空数组。",
                    "parameters": {
                        "type": "object", "additionalProperties": False,
                        "properties": {
                            "inspection_id": {"type": "string"},
                            "suggestions": {
                                "type": "array", "maxItems": 4,
                                "items": {
                                    "type": "object", "additionalProperties": False,
                                    "properties": {
                                        "risk_code": {"type": "string", "enum": risk_codes},
                                        "title": {"type": "string", "maxLength": 80},
                                        "region_label": {"type": "string", "maxLength": 160},
                                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                                        "bbox": bbox_schema,
                                        "polygon": polygon_schema,
                                        "short_advice": {"type": "string", "maxLength": 160},
                                        "capture_guidance": {"type": "string", "maxLength": 160},
                                    },
                                    "required": [
                                        "risk_code", "title", "region_label", "confidence",
                                        "short_advice", "capture_guidance",
                                    ],
                                    "oneOf": [{"required": ["bbox"]}, {"required": ["polygon"]}],
                                },
                            },
                        },
                        "required": ["inspection_id", "suggestions"],
                    },
                },
            },
            *[
                {
                    "type": "function",
                    "function": {
                        "name": name,
                        "description": description,
                        "parameters": {
                            "type": "object", "additionalProperties": False,
                            "properties": ({"camera_suggestion_id": {"type": "string"}} if needs_id else {}),
                            "required": (["camera_suggestion_id"] if needs_id else []),
                        },
                    },
                }
                for name, description, needs_id in (
                    ("get_scan_guidance", "获取当前扫描的一个简短补拍动作。", False),
                    ("explain_camera_suggestion", "解释一条已经记录的待确认提示。", True),
                    ("locate_camera_suggestion", "获取待确认提示对应的帧和规范化位置。", True),
                )
            ],
        ]

    def _voice_context(self, assessment_id: str, room_id: str, session: dict) -> str:
        room = self.owner._owned_room(assessment_id, room_id)
        phase = self._session_phase(room, session)
        if phase == "formal":
            risks = [{"title": item["title"], "severity": item["severity"], "evidence": item["evidence"]} for item in self.owner._risks(room_id)]
            return json.dumps({"phase": "formal", "room": ROOM_NAMES[room["room_type"]], "risks": risks}, ensure_ascii=False)
        suggestions = [{"title": item["title"], "evidence": item["evidence"]} for item in self._latest_suggestions(assessment_id, room_id)]
        return json.dumps({"phase": "draft", "room": ROOM_NAMES[room["room_type"]], "temporary_suggestions": suggestions}, ensure_ascii=False)

    def _insert_turn(
        self, session: dict, role: str, kind: str, text: str, cards: list[dict], context: dict,
        provider_event_id: str | None = None,
    ) -> dict:
        turn_id = str(uuid.uuid4())
        created = utc_now()
        self.repository.insert("advisor_turns", {
            "id": turn_id, "session_id": session["id"], "assessment_id": session["assessment_id"],
            "room_id": session["room_id"], "role": role, "kind": kind, "text": text,
            "status": "final", "context_json": json.dumps(context, ensure_ascii=False),
            "cards_json": json.dumps(cards, ensure_ascii=False), "provider_event_id": provider_event_id,
            "created_at": created,
        })
        return {
            "turn_id": turn_id, "role": role, "kind": kind, "text": text, "status": "final",
            "context_refs": context, "cards": cards, "created_at": created,
        }

    def _turns(self, session_id: str) -> list[dict]:
        rows = self.repository.fetchall(
            "SELECT * FROM advisor_turns WHERE session_id=? ORDER BY created_at,id LIMIT 200", (session_id,),
        )
        return [self._serialize_turn(row) for row in rows]

    def _room_turns(self, assessment_id: str, room_id: str) -> list[dict]:
        rows = self.repository.fetchall(
            "SELECT * FROM advisor_turns WHERE assessment_id=? AND room_id=? ORDER BY created_at,id LIMIT 200",
            (assessment_id, room_id),
        )
        return [self._serialize_turn(row) for row in rows]

    @staticmethod
    def _serialize_turn(row: dict) -> dict:
        return {
            "turn_id": row["id"], "role": row["role"], "kind": row["kind"], "text": row["text"],
            "status": row["status"], "context_refs": json.loads(row["context_json"] or "{}"),
            "cards": json.loads(row["cards_json"] or "[]"), "created_at": row["created_at"],
        }

    def _trim_turns(self, session_id: str) -> None:
        session = self.repository.fetchone("SELECT assessment_id,room_id FROM advisor_sessions WHERE id=?", (session_id,))
        if not session:
            return
        rows = self.repository.fetchall(
            "SELECT id FROM advisor_turns WHERE assessment_id=? AND room_id=? ORDER BY created_at DESC,id DESC",
            (session["assessment_id"], session["room_id"]),
        )
        for row in rows[200:]:
            self.repository.execute("DELETE FROM advisor_turns WHERE id=?", (row["id"],))

    def _camera_context(self, session: dict) -> dict:
        camera_session_id = session.get("camera_session_id")
        if not camera_session_id:
            latest = self.repository.fetchone(
                "SELECT id FROM camera_discovery_sessions WHERE assessment_id=? AND room_id=? ORDER BY created_at DESC LIMIT 1",
                (session["assessment_id"], session["room_id"]),
            )
            camera_session_id = latest["id"] if latest else None
        suggestions = self._suggestions_for_session(camera_session_id) if camera_session_id else []
        return {"camera_session_id": camera_session_id, "suggestions": suggestions}

    def _latest_suggestions(self, assessment_id: str, room_id: str) -> list[dict]:
        latest = self.repository.fetchone(
            "SELECT id FROM camera_discovery_sessions WHERE assessment_id=? AND room_id=? ORDER BY created_at DESC LIMIT 1",
            (assessment_id, room_id),
        )
        return self._suggestions_for_session(latest["id"]) if latest else []

    def _suggestions_for_session(self, camera_session_id: str) -> list[dict]:
        rows = self.repository.fetchall(
            "SELECT s.id,s.frame_id,s.suggestion_json,f.inspection_id "
            "FROM camera_suggestions s LEFT JOIN camera_session_frames f ON f.id=s.frame_id "
            "WHERE s.camera_session_id=? ORDER BY s.created_at LIMIT 30",
            (camera_session_id,),
        )
        values = [
            {
                **json.loads(row["suggestion_json"]),
                "suggestion_id": row["id"],
                "frame_id": row["frame_id"],
                "inspection_id": row.get("inspection_id"),
            }
            for row in rows
        ]
        deduplicated: dict[str, dict] = {}
        for value in values:
            code = value.get("risk_code", "")
            if code not in deduplicated or float(value.get("confidence", 0)) > float(deduplicated[code].get("confidence", 0)):
                deduplicated[code] = value
        return list(deduplicated.values())[:8]

    def _owned_camera_session(self, assessment_id: str, room_id: str, session_id: str) -> dict:
        row = self.repository.fetchone(
            "SELECT * FROM camera_discovery_sessions WHERE id=? AND assessment_id=? AND room_id=?",
            (session_id, assessment_id, room_id),
        )
        if not row:
            raise self.owner.error("camera_session_not_found", 404)
        return row

    def _owned_session(self, assessment_id: str, room_id: str, session_id: str) -> dict:
        row = self.repository.fetchone(
            "SELECT * FROM advisor_sessions WHERE id=? AND assessment_id=? AND room_id=?",
            (session_id, assessment_id, room_id),
        )
        if not row or row["status"] != "active":
            raise self.owner.error("advisor_session_not_found", 404)
        if row.get("expires_at") and datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc):
            self._expire_session_row(row)
            raise self.owner.error("advisor_session_not_found", 404)
        return row

    def _touch_session(self, session_id: str) -> None:
        self.repository.execute(
            "UPDATE advisor_sessions SET last_activity_at=?,updated_at=? WHERE id=?",
            (utc_now(), utc_now(), session_id),
        )

    def _expire_advisor_sessions(self) -> None:
        now = utc_now()
        rows = self.repository.fetchall(
            "SELECT * FROM advisor_sessions WHERE status='active' "
            "AND expires_at IS NOT NULL AND expires_at<=?",
            (now,),
        )
        for row in rows:
            self._expire_session_row(row, cleanup=False)
        if rows:
            self._cleanup_rtc_queue()

    def _expire_session_row(self, session: dict, *, cleanup: bool = True) -> None:
        tickets = self.repository.fetchall(
            "SELECT * FROM advisor_rtc_queue WHERE session_id=? "
            "AND status IN ('queued','granted','active','draining')",
            (session["id"],),
        )
        runtime_ticket = False
        for ticket in tickets:
            if ticket["status"] == "active":
                runtime_ticket = True
                self._drain_or_release_ticket(ticket)
            elif ticket["status"] == "draining":
                runtime_ticket = True
            else:
                self._mark_ticket_released(ticket["id"], "expired")
                self._clear_device_binding_if_unused(ticket["session_id"], ticket["client_instance_id"])
        if session.get("provider_task_id") and not runtime_ticket:
            self._stop_provider_task(session["id"])
        now = utc_now()
        self.repository.execute(
            "UPDATE advisor_sessions SET status='ended',ended_at=?,updated_at=? WHERE id=?",
            (now, now, session["id"]),
        )
        if cleanup:
            self._cleanup_rtc_queue()

    def _expire_camera_sessions(self) -> None:
        now = utc_now()
        self.repository.execute(
            "UPDATE camera_discovery_sessions SET status='expired',updated_at=? WHERE status='active' AND expires_at<=?",
            (now, now),
        )
        self.repository.execute(
            "UPDATE camera_session_frames SET status='expired',updated_at=? "
            "WHERE status IN ('prepared','inspected') AND expires_at<=?",
            (now, now),
        )

    @staticmethod
    def _phase(room: dict) -> str:
        if room["status"] in {"result_ready", "completed"}:
            return "formal"
        if room["status"] == "analyzing":
            return "analyzing"
        return "draft"

    def _session_phase(self, room: dict, session: dict) -> str:
        camera_session_id = session.get("camera_session_id")
        if camera_session_id:
            camera = self.repository.fetchone(
                "SELECT status FROM camera_discovery_sessions WHERE id=? AND assessment_id=? AND room_id=?",
                (camera_session_id, session["assessment_id"], session["room_id"]),
            )
            if camera and camera["status"] == "active":
                return "draft"
        return self._phase(room)

    @staticmethod
    def _risk_summary_card(risks: list[dict]) -> dict:
        return {"type": "risk_summary", "risks": [{**risk, "severity_label": SEVERITY_NAMES.get(risk["severity"], "待确认")} for risk in risks]}

    @staticmethod
    def _suggestion_card(suggestions: list[dict]) -> dict:
        return {"type": "temporary_suggestions", "suggestions": suggestions, "disclaimer": "临时建议，不计分，需正式分析确认"}

    @staticmethod
    def _solutions_card(risk: dict, value: dict) -> dict:
        return {
            "type": "solution_options", "risk_id": risk["risk_id"], "risk_title": risk["title"],
            "solutions": value["solutions"], "selected_solution_package_id": value["selected_solution_package_id"],
            "price_disclaimer": value["price_disclaimer"],
        }
