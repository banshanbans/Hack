from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import re
import secrets
import threading
import time
import uuid

from .providers import (
    KNOWLEDGE_PROMPT_VERSION,
    KnowledgeAdvisorProvider,
    ProviderError,
    VoiceConnection,
    VoiceProviderError,
    VolcengineVoiceProvider,
    build_rtc_token,
    knowledge_provider_from_environment,
)
from .repositories import SQLiteRepository, token_hash, utc_now


LOGGER = logging.getLogger("anjuguard.knowledge_advisor")
KNOWLEDGE_PATH = Path(__file__).resolve().parent.parent / "rules" / "advisor_knowledge.zh-CN.json"
SESSION_HOURS = 24
MAX_USER_MESSAGES = 50
QUICK_PROMPTS = [
    "卫生间为什么容易跌倒？",
    "夜间照明怎样更安全？",
    "家中哪些位置最需要扶手？",
    "卫生间扶手怎么选？",
    "卧室起夜动线怎么改？",
    "防滑地面有哪些低成本方案？",
]
WELCOME_TITLE = "我是长者友好家AI居家顾问，有任何适老化改造问题都可以问我"
WELCOME_TEXT = (
    "我是长者友好家AI居家顾问，有任何适老化改造问题都可以问我。"
    "我可以帮你了解居家环境中的行动风险，并把适老化改造建议讲得更清楚。"
    "你可以问我扶手、防滑、照明、通行动线等适老化知识；如果想判断自己家里的具体情况，"
    "我会引导你上传照片或开始检查。"
)


class KnowledgeAdvisorService:
    def __init__(
        self,
        owner,
        repository: SQLiteRepository,
        provider: KnowledgeAdvisorProvider | None = None,
    ) -> None:
        self.owner = owner
        self.repository = repository
        self._provider = provider
        self._provider_lock = threading.Lock()
        self._inflight: set[str] = set()
        self._janitor_stop = threading.Event()
        self._janitor: threading.Thread | None = None
        try:
            payload = json.loads(KNOWLEDGE_PATH.read_text(encoding="utf-8"))
            self.knowledge_version = str(payload["knowledge_version"])
            self.topics = list(payload["topics"])
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise RuntimeError("advisor knowledge configuration is invalid") from error
        if self.feature_enabled():
            self._purge_expired_sessions()
            self._janitor = threading.Thread(
                target=self._janitor_loop, name="anju-knowledge-advisor-expiry", daemon=True,
            )
            self._janitor.start()

    def close(self) -> None:
        self._janitor_stop.set()
        if self._janitor and self._janitor.is_alive():
            self._janitor.join(timeout=.2)

    @staticmethod
    def feature_enabled() -> bool:
        return os.environ.get("ANJU_ENABLE_KNOWLEDGE_ADVISOR", "0") == "1"

    @classmethod
    def capability(cls) -> bool:
        if not cls.feature_enabled():
            return False
        if os.environ.get("ANJU_MOCK_ANALYSIS") == "1":
            return True
        provider = os.environ.get("ANJU_VISION_PROVIDER", "openai").strip().lower()
        if provider == "ark":
            return bool(os.environ.get("ARK_API_KEY", "").strip() and os.environ.get("ANJU_KNOWLEDGE_ADVISOR_MODEL", os.environ.get("ANJU_ARK_MODEL", "")).strip())
        return bool(os.environ.get("OPENAI_API_KEY", "").strip() and os.environ.get("ANJU_KNOWLEDGE_ADVISOR_MODEL", os.environ.get("ANJU_OPENAI_MODEL", "gpt-5.6-sol")).strip())

    def available(self) -> bool:
        return self.feature_enabled() and (self._provider is not None or self.capability())

    def create_session(self) -> dict:
        self._require_available()
        self._purge_expired_sessions()
        session_id = str(uuid.uuid4())
        access_token = secrets.token_urlsafe(32)
        now = utc_now()
        expires_at = self._next_expiry()
        self.repository.insert("knowledge_advisor_sessions", {
            "id": session_id,
            "token_hash": token_hash(access_token),
            "status": "active",
            "provider_task_id": None,
            "rtc_room_id": None,
            "rtc_user_id": None,
            "rtc_bot_user_id": None,
            "client_instance_id": None,
            "device_lease_expires_at": None,
            "created_at": now,
            "updated_at": now,
            "last_activity_at": now,
            "expires_at": expires_at,
        })
        welcome = self._insert_turn(session_id, "assistant", "welcome", WELCOME_TEXT)
        result = self._bootstrap(session_id)
        result.update({"access_token": access_token, "welcome_turn": welcome})
        return result

    def authorize(self, session_id: str, access_token: str) -> dict:
        self._require_enabled()
        row = self.repository.fetchone("SELECT * FROM knowledge_advisor_sessions WHERE id=?", (session_id,))
        if not row or not access_token or not secrets.compare_digest(row["token_hash"], token_hash(access_token)):
            raise self.owner.error("knowledge_advisor_access_denied", 401)
        if row["status"] != "active" or row["expires_at"] <= utc_now():
            self._expire_session(row)
            raise self.owner.error("knowledge_advisor_session_expired", 410)
        return row

    def get_session(self, session_id: str) -> dict:
        self._owned_session(session_id)
        self._touch(session_id)
        return self._bootstrap(session_id)

    def delete_session(self, session_id: str) -> None:
        session = self._owned_session(session_id)
        self._stop_voice(session)
        self.repository.execute("DELETE FROM knowledge_advisor_sessions WHERE id=?", (session_id,))

    def add_message(self, session_id: str, text: str) -> dict:
        self._owned_session(session_id)
        try:
            question = self._clean_input(text, 500)
        except ValueError as error:
            raise self.owner.error("knowledge_advisor_message_invalid") from error
        count = self.repository.fetchone(
            "SELECT COUNT(*) AS value FROM knowledge_advisor_turns WHERE session_id=? AND role='user'",
            (session_id,),
        )
        if int(count["value"]) >= MAX_USER_MESSAGES:
            raise self.owner.error("knowledge_advisor_message_limit", 429)
        with self._provider_lock:
            if session_id in self._inflight:
                raise self.owner.error("knowledge_advisor_request_in_progress", 409)
            self._inflight.add(session_id)
        self._touch(session_id)
        history = self._history(session_id, include_welcome=False)[-20:]
        matched = self._match_knowledge(question)
        started = time.monotonic()
        try:
            provider = self._provider_instance()
            answer, metadata = provider.answer(session_id, history, question, matched)
            answer_text = self._clean_output(answer.get("answer"), 800)
            suggestions = self._suggestions(answer.get("suggested_questions"))
            user_turn = self._insert_turn(session_id, "user", "text", question)
            assistant_turn = self._insert_turn(
                session_id, "assistant", "text", answer_text, suggested_questions=suggestions,
            )
            self._record_provider_call(session_id, metadata)
            self._touch(session_id)
            return {"user_turn": user_turn, "assistant_turn": assistant_turn, "expires_at": self._owned_session(session_id)["expires_at"]}
        except ProviderError as error:
            self._record_provider_call(session_id, {
                "provider": getattr(self._provider, "provider_name", None),
                "model": getattr(self._provider, "model_name", None),
                "prompt_version": KNOWLEDGE_PROMPT_VERSION,
                "latency_ms": int((time.monotonic() - started) * 1000),
                "schema_result": "invalid" if error.code == "provider_invalid_response" else "not_available",
                "error_type": error.code,
            })
            raise
        except Exception as error:
            self._record_provider_call(session_id, {
                "provider": getattr(self._provider, "provider_name", None),
                "model": getattr(self._provider, "model_name", None),
                "prompt_version": KNOWLEDGE_PROMPT_VERSION,
                "latency_ms": int((time.monotonic() - started) * 1000),
                "schema_result": "invalid", "error_type": "provider_internal_error",
            })
            LOGGER.warning(
                "knowledge advisor provider returned an unexpected error",
                extra={"session_hash": token_hash(session_id)[:12], "error_class": type(error).__name__},
            )
            raise ProviderError("provider_invalid_response", True) from error
        finally:
            with self._provider_lock:
                self._inflight.discard(session_id)

    def add_transcript(self, session_id: str, role: str, text: str, provider_event_id: str) -> dict:
        self._owned_session(session_id)
        if role not in {"user", "assistant"}:
            raise self.owner.error("invalid_request")
        event_id = str(provider_event_id or "").strip()
        if not event_id or len(event_id) > 120:
            raise self.owner.error("invalid_request")
        existing = self.repository.fetchone(
            "SELECT * FROM knowledge_advisor_turns WHERE session_id=? AND provider_event_id=?",
            (session_id, event_id),
        )
        if existing:
            return self._turn_payload(existing)
        if role == "user":
            count = self.repository.fetchone(
                "SELECT COUNT(*) AS value FROM knowledge_advisor_turns WHERE session_id=? AND role='user'",
                (session_id,),
            )
            if int(count["value"]) >= MAX_USER_MESSAGES:
                raise self.owner.error("knowledge_advisor_message_limit", 429)
        limit = 500 if role == "user" else 800
        try:
            value = self._clean_input(text, limit) if role == "user" else self._clean_output(text, limit)
        except ValueError as error:
            raise self.owner.error("knowledge_advisor_message_invalid") from error
        turn = self._insert_turn(session_id, role, "voice", value, provider_event_id=event_id)
        self._touch(session_id)
        return turn

    def enqueue_rtc(self, session_id: str, client_instance_id: str, mode: str) -> dict:
        self._owned_session(session_id)
        if not VolcengineVoiceProvider.configured():
            raise self.owner.error("advisor_capacity_busy", 503)
        client_id = self._client_id(client_instance_id)
        if mode != "audio":
            raise self.owner.error("invalid_request")
        self._cleanup_queue()
        now = utc_now()
        queue_expires = (datetime.now(timezone.utc) + timedelta(seconds=self._setting("ANJU_ADVISOR_QUEUE_TTL_SECONDS", 180, 30, 900))).isoformat()
        with self.repository.transaction() as connection:
            existing = connection.execute(
                "SELECT id FROM knowledge_advisor_rtc_queue WHERE session_id=? AND client_instance_id=? "
                "AND status IN ('queued','granted','active','draining') ORDER BY created_at DESC LIMIT 1",
                (session_id, client_id),
            ).fetchone()
            if existing:
                ticket_id = existing["id"]
            else:
                waiting = int(connection.execute(
                    "SELECT COUNT(*) AS value FROM knowledge_advisor_rtc_queue WHERE status='queued' AND expires_at>?",
                    (now,),
                ).fetchone()["value"])
                if waiting >= self._setting("ANJU_ADVISOR_MAX_QUEUED", 50, 1, 500):
                    raise self.owner.error("advisor_capacity_busy", 429)
                ticket_id = str(uuid.uuid4())
                connection.execute(
                    "INSERT INTO knowledge_advisor_rtc_queue "
                    "(id,session_id,client_instance_id,mode,status,enqueued_at,granted_at,activated_at,heartbeat_at,lease_expires_at,expires_at,released_at,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,NULL,?,?)",
                    (ticket_id, session_id, client_id, "audio", "queued", now, queue_expires, now, now),
                )
            connection.execute(
                "UPDATE knowledge_advisor_sessions SET client_instance_id=?,device_lease_expires_at=?,updated_at=? WHERE id=?",
                (client_id, queue_expires, now, session_id),
            )
            self._promote_queue(connection, now)
        self._touch(session_id, device_lease=queue_expires)
        return self._queue_payload(ticket_id, session_id, client_id)

    def queue_status(self, session_id: str, ticket_id: str, client_instance_id: str) -> dict:
        self._owned_session(session_id)
        client_id = self._client_id(client_instance_id)
        self._cleanup_queue()
        return self._queue_payload(ticket_id, session_id, client_id)

    def heartbeat_queue(self, session_id: str, ticket_id: str, client_instance_id: str) -> dict:
        self._owned_session(session_id)
        client_id = self._client_id(client_instance_id)
        self._cleanup_queue()
        now = utc_now()
        lease = (datetime.now(timezone.utc) + timedelta(seconds=self._setting("ANJU_ADVISOR_DEVICE_LEASE_SECONDS", 90, 30, 300))).isoformat()
        with self.repository.transaction() as connection:
            row = connection.execute(
                "SELECT status FROM knowledge_advisor_rtc_queue WHERE id=? AND session_id=? AND client_instance_id=?",
                (ticket_id, session_id, client_id),
            ).fetchone()
            if not row or row["status"] != "active":
                raise self.owner.error("advisor_queue_expired", 410)
            connection.execute(
                "UPDATE knowledge_advisor_rtc_queue SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=?",
                (now, lease, now, ticket_id),
            )
        self._touch(session_id, device_lease=lease)
        return self._queue_payload(ticket_id, session_id, client_id)

    def cancel_queue(self, session_id: str, ticket_id: str, client_instance_id: str) -> None:
        session = self._owned_session(session_id)
        client_id = self._client_id(client_instance_id)
        row = self.repository.fetchone(
            "SELECT * FROM knowledge_advisor_rtc_queue WHERE id=? AND session_id=? AND client_instance_id=?",
            (ticket_id, session_id, client_id),
        )
        if not row:
            return
        if row["status"] == "active":
            self._stop_voice(session)
        now = utc_now()
        self.repository.execute(
            "UPDATE knowledge_advisor_rtc_queue SET status='released',released_at=?,updated_at=? WHERE id=?",
            (now, now, ticket_id),
        )
        self.repository.execute(
            "UPDATE knowledge_advisor_sessions SET client_instance_id=NULL,device_lease_expires_at=NULL,updated_at=? WHERE id=? AND client_instance_id=?",
            (now, session_id, client_id),
        )
        self._cleanup_queue()

    def start_voice(self, session_id: str, client_instance_id: str, ticket_id: str) -> dict:
        session = self._owned_session(session_id)
        client_id = self._client_id(client_instance_id)
        self._cleanup_queue()
        now = utc_now()
        lease = (datetime.now(timezone.utc) + timedelta(seconds=self._setting("ANJU_ADVISOR_DEVICE_LEASE_SECONDS", 90, 30, 300))).isoformat()
        with self.repository.transaction() as connection:
            ticket = connection.execute(
                "SELECT * FROM knowledge_advisor_rtc_queue WHERE id=? AND session_id=? AND client_instance_id=?",
                (ticket_id, session_id, client_id),
            ).fetchone()
            if not ticket or ticket["status"] not in {"granted", "active"}:
                raise self.owner.error("advisor_queue_required", 409)
            connection.execute(
                "UPDATE knowledge_advisor_rtc_queue SET status='active',activated_at=COALESCE(activated_at,?),heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=?",
                (now, now, lease, now, ticket_id),
            )
            connection.execute(
                "UPDATE knowledge_advisor_sessions SET client_instance_id=?,device_lease_expires_at=?,updated_at=? WHERE id=?",
                (client_id, lease, now, session_id),
            )
        if session.get("provider_task_id"):
            return self._rtc_payload(session)
        provider = VolcengineVoiceProvider()
        if not provider.configured():
            raise self.owner.error("advisor_capacity_busy", 503)
        started = time.monotonic()
        try:
            connection = provider.start(
                session_id,
                "你好，我是长者友好家的 AI 适老顾问。你想了解哪方面的适老化知识？",
                json.dumps({"knowledge_version": self.knowledge_version, "topics": self.topics}, ensure_ascii=False),
                video_enabled=False,
                tools=None,
                advisor_mode="knowledge",
            )
        except VoiceProviderError as error:
            self._record_provider_call(session_id, {
                "provider": "volcengine", "model": os.environ.get("ANJU_VOLC_VOICE_MODEL_ID", "configured_voice_model"),
                "prompt_version": "anju_knowledge_advisor_voice_v1", "latency_ms": int((time.monotonic() - started) * 1000),
                "schema_result": "not_applicable", "error_type": str(error),
            })
            self.cancel_queue(session_id, ticket_id, client_id)
            return {"available": False, "reason": "provider_unavailable"}
        self.repository.execute(
            "UPDATE knowledge_advisor_sessions SET provider_task_id=?,rtc_room_id=?,rtc_user_id=?,rtc_bot_user_id=?,updated_at=? WHERE id=?",
            (connection.task_id, connection.room_id, connection.user_id, connection.bot_user_id, utc_now(), session_id),
        )
        self._record_provider_call(session_id, {
            "provider": "volcengine", "model": os.environ.get("ANJU_VOLC_VOICE_MODEL_ID", "configured_voice_model"),
            "prompt_version": "anju_knowledge_advisor_voice_v1", "latency_ms": int((time.monotonic() - started) * 1000),
            "schema_result": "not_applicable", "error_type": None,
        })
        return self._connection_payload(connection)

    def _bootstrap(self, session_id: str) -> dict:
        session = self._owned_session(session_id)
        return {
            "session_id": session_id,
            "expires_at": session["expires_at"],
            "welcome_title": WELCOME_TITLE,
            "turns": self._history(session_id),
            "quick_prompts": QUICK_PROMPTS,
            "knowledge_version": self.knowledge_version,
            "prompt_version": KNOWLEDGE_PROMPT_VERSION,
            "rtc": {
                "available": VolcengineVoiceProvider.configured(),
                "provider": "volcengine" if VolcengineVoiceProvider.configured() else None,
                "requires_start": True,
                "media_mode": "audio",
                "video_available": False,
            },
        }

    def _owned_session(self, session_id: str) -> dict:
        row = self.repository.fetchone("SELECT * FROM knowledge_advisor_sessions WHERE id=?", (session_id,))
        if not row or row["status"] != "active":
            raise self.owner.error("knowledge_advisor_session_not_found", 404)
        if row["expires_at"] <= utc_now():
            self._expire_session(row)
            raise self.owner.error("knowledge_advisor_session_expired", 410)
        return row

    def _expire_session(self, session: dict) -> None:
        self._stop_voice(session)
        self.repository.execute("DELETE FROM knowledge_advisor_sessions WHERE id=?", (session["id"],))

    def _janitor_loop(self) -> None:
        while not self._janitor_stop.wait(300):
            self._purge_expired_sessions()

    def _purge_expired_sessions(self) -> None:
        try:
            expired = self.repository.fetchall(
                "SELECT * FROM knowledge_advisor_sessions WHERE expires_at<=?", (utc_now(),),
            )
            for session in expired:
                self._expire_session(session)
        except Exception as error:
            LOGGER.warning("knowledge advisor expiry cleanup failed", extra={"error_class": type(error).__name__})

    def _touch(self, session_id: str, device_lease: str | None = None) -> None:
        now = utc_now()
        expiry = self._next_expiry()
        if device_lease:
            self.repository.execute(
                "UPDATE knowledge_advisor_sessions SET last_activity_at=?,expires_at=?,device_lease_expires_at=?,updated_at=? WHERE id=? AND status='active'",
                (now, expiry, device_lease, now, session_id),
            )
        else:
            self.repository.execute(
                "UPDATE knowledge_advisor_sessions SET last_activity_at=?,expires_at=?,updated_at=? WHERE id=? AND status='active'",
                (now, expiry, now, session_id),
            )

    def _provider_instance(self) -> KnowledgeAdvisorProvider:
        if self._provider is None:
            self._provider = knowledge_provider_from_environment()
        return self._provider

    def _match_knowledge(self, question: str) -> list[dict]:
        scored: list[tuple[int, dict]] = []
        for topic in self.topics:
            score = sum(1 for alias in topic.get("aliases", []) if alias and alias.lower() in question.lower())
            if score:
                scored.append((score, topic))
        if not scored:
            product = next((item for item in self.topics if item.get("topic_id") == "product"), None)
            return [product] if product else []
        return [item for _, item in sorted(scored, key=lambda pair: pair[0], reverse=True)[:3]]

    def _history(self, session_id: str, include_welcome: bool = True) -> list[dict]:
        rows = self.repository.fetchall(
            "SELECT * FROM knowledge_advisor_turns WHERE session_id=? ORDER BY created_at,id",
            (session_id,),
        )
        return [self._turn_payload(row) for row in rows if include_welcome or row["kind"] != "welcome"]

    def _insert_turn(
        self,
        session_id: str,
        role: str,
        kind: str,
        text: str,
        *,
        suggested_questions: list[str] | None = None,
        provider_event_id: str | None = None,
    ) -> dict:
        turn_id = str(uuid.uuid4())
        created = utc_now()
        self.repository.insert("knowledge_advisor_turns", {
            "id": turn_id,
            "session_id": session_id,
            "role": role,
            "kind": kind,
            "text": text,
            "status": "final",
            "suggested_questions_json": json.dumps(suggested_questions or [], ensure_ascii=False),
            "provider_event_id": provider_event_id,
            "created_at": created,
        })
        return {
            "turn_id": turn_id, "role": role, "kind": kind, "text": text, "status": "final",
            "suggested_questions": suggested_questions or [], "provider_event_id": provider_event_id,
            "created_at": created,
        }

    @staticmethod
    def _turn_payload(row: dict) -> dict:
        return {
            "turn_id": row["id"], "role": row["role"], "kind": row["kind"], "text": row["text"],
            "status": row["status"], "suggested_questions": json.loads(row.get("suggested_questions_json") or "[]"),
            "provider_event_id": row.get("provider_event_id"), "created_at": row["created_at"],
        }

    def _record_provider_call(self, session_id: str, metadata: dict) -> None:
        self.repository.insert("knowledge_advisor_provider_calls", {
            "id": str(uuid.uuid4()), "session_id": session_id,
            "provider": metadata.get("provider"), "model": metadata.get("model"),
            "prompt_version": metadata.get("prompt_version") or KNOWLEDGE_PROMPT_VERSION,
            "latency_ms": metadata.get("latency_ms"), "schema_result": metadata.get("schema_result") or "unknown",
            "error_type": metadata.get("error_type"), "created_at": utc_now(),
        })
        LOGGER.info("knowledge advisor provider call completed", extra={
            "session_hash": token_hash(session_id)[:12], "provider": metadata.get("provider"),
            "prompt_version": metadata.get("prompt_version") or KNOWLEDGE_PROMPT_VERSION,
            "schema_result": metadata.get("schema_result"), "error_type": metadata.get("error_type"),
        })

    def _cleanup_queue(self) -> None:
        now = utc_now()
        self.repository.execute(
            "UPDATE knowledge_advisor_rtc_queue SET status='expired',updated_at=? WHERE status IN ('queued','granted') AND COALESCE(lease_expires_at,expires_at)<=?",
            (now, now),
        )
        expired = self.repository.fetchall(
            "SELECT * FROM knowledge_advisor_rtc_queue WHERE status='active' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",
            (now,),
        )
        for ticket in expired:
            session = self.repository.fetchone("SELECT * FROM knowledge_advisor_sessions WHERE id=?", (ticket["session_id"],))
            if session:
                self._stop_voice(session)
            self.repository.execute(
                "UPDATE knowledge_advisor_rtc_queue SET status='expired',released_at=?,updated_at=? WHERE id=?",
                (now, now, ticket["id"]),
            )
        with self.repository.transaction() as connection:
            self._promote_queue(connection, now)

    def _promote_queue(self, connection, now: str) -> None:
        maximum = self._setting("ANJU_ADVISOR_MAX_ACTIVE_RTC", 8, 1, 8)
        general = int(connection.execute(
            "SELECT COUNT(*) AS value FROM knowledge_advisor_rtc_queue WHERE status IN ('granted','active','draining')",
        ).fetchone()["value"])
        formal = int(connection.execute(
            "SELECT COUNT(*) AS value FROM advisor_rtc_queue WHERE status IN ('granted','active','draining')",
        ).fetchone()["value"])
        slots = max(0, maximum - general - formal)
        if not slots:
            return
        rows = connection.execute(
            "SELECT id,session_id,client_instance_id FROM knowledge_advisor_rtc_queue WHERE status='queued' AND expires_at>? ORDER BY enqueued_at,id LIMIT ?",
            (now, slots),
        ).fetchall()
        grant_expiry = (datetime.now(timezone.utc) + timedelta(seconds=self._setting("ANJU_ADVISOR_QUEUE_GRANT_SECONDS", 20, 5, 60))).isoformat()
        for row in rows:
            connection.execute(
                "UPDATE knowledge_advisor_rtc_queue SET status='granted',granted_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='queued'",
                (now, grant_expiry, now, row["id"]),
            )
            connection.execute(
                "UPDATE knowledge_advisor_sessions SET client_instance_id=?,device_lease_expires_at=?,updated_at=? WHERE id=?",
                (row["client_instance_id"], grant_expiry, now, row["session_id"]),
            )

    def _queue_payload(self, ticket_id: str, session_id: str, client_id: str) -> dict:
        row = self.repository.fetchone(
            "SELECT * FROM knowledge_advisor_rtc_queue WHERE id=? AND session_id=? AND client_instance_id=?",
            (ticket_id, session_id, client_id),
        )
        if not row or row["status"] in {"expired", "released"}:
            raise self.owner.error("advisor_queue_expired", 410)
        position = 0
        if row["status"] == "queued":
            position = 1 + int(self.repository.fetchone(
                "SELECT COUNT(*) AS value FROM knowledge_advisor_rtc_queue WHERE status='queued' AND (enqueued_at<? OR (enqueued_at=? AND id<?))",
                (row["enqueued_at"], row["enqueued_at"], row["id"]),
            )["value"])
        return {
            "ticket_id": row["id"], "status": row["status"], "position": position,
            "expires_at": row.get("lease_expires_at") or row["expires_at"], "poll_after_ms": 2000, "mode": "audio",
        }

    def _stop_voice(self, session: dict) -> None:
        if session.get("provider_task_id"):
            try:
                VolcengineVoiceProvider().stop(VoiceConnection(
                    os.environ.get("ANJU_VOLC_RTC_APP_ID", ""), session.get("rtc_room_id") or "",
                    session.get("rtc_user_id") or "", session.get("rtc_bot_user_id") or "",
                    session["provider_task_id"], "", utc_now(),
                ))
            except VoiceProviderError:
                LOGGER.warning("knowledge advisor voice stop failed", extra={"session_hash": token_hash(session["id"])[:12]})
        self.repository.execute(
            "UPDATE knowledge_advisor_sessions SET provider_task_id=NULL,rtc_room_id=NULL,rtc_user_id=NULL,rtc_bot_user_id=NULL,updated_at=? WHERE id=?",
            (utc_now(), session["id"]),
        )

    def _rtc_payload(self, session: dict) -> dict:
        if not session.get("provider_task_id"):
            return {"available": True, "provider": "volcengine", "requires_start": True, "media_mode": "audio", "video_available": False}
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
            "media_mode": "audio", "video_available": False,
        }

    @staticmethod
    def _connection_payload(connection: VoiceConnection) -> dict:
        return {
            "available": True, "provider": "volcengine", "app_id": connection.app_id,
            "room_id": connection.room_id, "user_id": connection.user_id,
            "bot_user_id": connection.bot_user_id, "token": connection.token,
            "expires_at": connection.expires_at, "media_mode": "audio", "video_available": False,
        }

    def _require_enabled(self) -> None:
        if not self.feature_enabled():
            raise self.owner.error("knowledge_advisor_not_enabled", 404)

    def _require_available(self) -> None:
        if not self.available():
            raise self.owner.error("knowledge_advisor_not_enabled", 404)

    def _client_id(self, value: str) -> str:
        client_id = str(value or "").strip()
        try:
            uuid.UUID(client_id)
        except (ValueError, AttributeError) as error:
            raise self.owner.error("invalid_request") from error
        if len(client_id) > 80:
            raise self.owner.error("invalid_request")
        return client_id

    @staticmethod
    def _clean_input(value: object, maximum: int) -> str:
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", str(value or "")).strip()
        if not text or len(text) > maximum:
            raise ValueError("invalid message")
        return text

    @staticmethod
    def _clean_output(value: object, maximum: int) -> str:
        text = str(value or "")
        text = re.sub(r"<\s*(script|style)[^>]*>.*?<\s*/\s*\1\s*>", "", text, flags=re.IGNORECASE | re.DOTALL)
        text = re.sub(r"<[^>]+>", "", text)
        text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text).strip()
        if not text:
            raise ProviderError("provider_invalid_response", True)
        return text[:maximum]

    def _suggestions(self, values: object) -> list[str]:
        if not isinstance(values, list):
            raise ProviderError("provider_invalid_response", True)
        result: list[str] = []
        for value in values[:4]:
            try:
                result.append(self._clean_input(value, 80))
            except ValueError as error:
                raise ProviderError("provider_invalid_response", True) from error
        return result

    @staticmethod
    def _next_expiry() -> str:
        return (datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)).isoformat()

    @staticmethod
    def _setting(name: str, default: int, minimum: int, maximum: int) -> int:
        try:
            return max(minimum, min(maximum, int(os.environ.get(name, str(default)))))
        except ValueError:
            return default
