from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import secrets
import threading
import uuid


ALLOWED_ISSUE_TYPES = {
    "loose_rug",
    "floor_clutter",
    "cable_crossing",
    "narrow_path",
    "missing_grab_bar",
    "sharp_corner",
    "low_lighting",
    "unstable_support",
    "high_reach_item",
    "bedside_obstruction",
}
ALLOWED_STATES = {"tentative", "confirmed", "dismissed", "resolved"}


@dataclass
class SessionRecord:
    id: str
    room_type: str | None
    profiles: list[str]
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    issues: dict[str, dict] = field(default_factory=dict)
    completed: bool = False


@dataclass
class ShareRecord:
    session_id: str
    expires_at: datetime


class SessionService:
    """Thread-safe, in-memory MVP store. It intentionally does not retain images."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionRecord] = {}
        self._shares: dict[str, ShareRecord] = {}
        self._lock = threading.RLock()

    def create_session(self, payload: dict) -> SessionRecord:
        record = SessionRecord(
            id=str(uuid.uuid4()),
            room_type=payload.get("room_type"),
            profiles=[str(value) for value in payload.get("profiles", [])][:8],
        )
        with self._lock:
            self._sessions[record.id] = record
        return record

    def get_session(self, session_id: str) -> SessionRecord | None:
        with self._lock:
            return self._sessions.get(session_id)

    def record_analysis(self, session_id: str, frame_id: str, issues: list[dict]) -> list[dict]:
        record = self.get_session(session_id)
        if record is None:
            raise KeyError(session_id)
        accepted: list[dict] = []
        with self._lock:
            for value in issues[:5]:
                issue_type = value.get("type")
                bbox = value.get("bbox")
                if issue_type not in ALLOWED_ISSUE_TYPES or not _valid_bbox(bbox):
                    continue
                issue_id = str(uuid.uuid4())
                issue = {
                    "id": issue_id,
                    "frame_id": frame_id,
                    "type": issue_type,
                    "state": "tentative" if value.get("needs_manual_check", True) else "confirmed",
                    "bbox": bbox,
                    "title": _bounded_text(value.get("title"), 18),
                    "observation": _bounded_text(value.get("observation"), 80),
                    "recommendation": _bounded_text(value.get("recommendation"), 36),
                    "needs_manual_check": bool(value.get("needs_manual_check", True)),
                    "confidence": _safe_confidence(value.get("confidence")),
                    "rule_ids": [str(item)[:40] for item in value.get("rule_ids", [])][:5],
                }
                record.issues[issue_id] = issue
                accepted.append(issue)
        return accepted

    def update_issue(self, session_id: str, issue_id: str, state: str) -> dict:
        if state not in ALLOWED_STATES:
            raise ValueError("invalid state")
        record = self.get_session(session_id)
        if record is None or issue_id not in record.issues:
            raise KeyError(issue_id)
        with self._lock:
            record.issues[issue_id]["state"] = state
            return dict(record.issues[issue_id])

    def complete(self, session_id: str) -> dict:
        record = self.get_session(session_id)
        if record is None:
            raise KeyError(session_id)
        with self._lock:
            record.completed = True
            issues = [item for item in record.issues.values() if item["state"] != "dismissed"]
        return {"session_id": session_id, "issues": issues, "partial": False}

    def create_share(self, session_id: str, lifetime: timedelta = timedelta(hours=24)) -> tuple[str, datetime]:
        if self.get_session(session_id) is None:
            raise KeyError(session_id)
        token = secrets.token_urlsafe(24)
        expires_at = datetime.now(timezone.utc) + lifetime
        with self._lock:
            self._shares[token] = ShareRecord(session_id=session_id, expires_at=expires_at)
        return token, expires_at

    def shared_report(self, token: str) -> dict | None:
        with self._lock:
            share = self._shares.get(token)
            if share is None or share.expires_at <= datetime.now(timezone.utc):
                self._shares.pop(token, None)
                return None
        return self.complete(share.session_id)


def empty_analysis(frame_id: str) -> dict:
    return {"frame_id": frame_id, "issues": []}


def demo_analysis(frame_id: str) -> dict:
    """Explicit local fixture; never enabled unless ANJU_MOCK_ANALYSIS=1."""
    return {
        "frame_id": frame_id,
        "issues": [
            {
                "type": "floor_clutter",
                "bbox": [0.2, 0.55, 0.72, 0.94],
                "title": "通道上有杂物",
                "observation": "从这张照片看，物品占用了常走的区域。",
                "recommendation": "先清出一条连续、无遮挡的通道。",
                "needs_manual_check": True,
                "confidence": 0.8,
                "rule_ids": ["PATH-001"],
            }
        ],
    }


def _valid_bbox(value: object) -> bool:
    if not isinstance(value, list) or len(value) != 4:
        return False
    if not all(isinstance(item, (int, float)) and 0 <= item <= 1 for item in value):
        return False
    return value[0] < value[2] and value[1] < value[3]


def _bounded_text(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _safe_confidence(value: object) -> float | None:
    if not isinstance(value, (int, float)):
        return None
    return min(1.0, max(0.0, float(value)))
