from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
from typing import Iterator


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class SQLiteRepository:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._migrate()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def execute(self, sql: str, parameters: tuple = ()) -> None:
        with self._lock, self.connection() as connection:
            connection.execute(sql, parameters)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Run related repository changes atomically under the process lock."""
        with self._lock, self.connection() as connection:
            yield connection

    def fetchone(self, sql: str, parameters: tuple = ()) -> dict | None:
        with self._lock, self.connection() as connection:
            row = connection.execute(sql, parameters).fetchone()
            return dict(row) if row else None

    def fetchall(self, sql: str, parameters: tuple = ()) -> list[dict]:
        with self._lock, self.connection() as connection:
            return [dict(row) for row in connection.execute(sql, parameters).fetchall()]

    def insert(self, table: str, values: dict) -> None:
        keys = list(values)
        placeholders = ",".join("?" for _ in keys)
        columns = ",".join(keys)
        self.execute(f"INSERT INTO {table} ({columns}) VALUES ({placeholders})", tuple(values[key] for key in keys))

    def authorize(self, assessment_id: str, token: str) -> bool:
        row = self.fetchone("SELECT token_hash FROM assessments WHERE id = ?", (assessment_id,))
        return bool(row and token and row["token_hash"] == token_hash(token))

    def _migrate(self) -> None:
        with self._lock, self.connection() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS assessments (
                    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, input_mode TEXT NOT NULL,
                    status TEXT NOT NULL, profile_json TEXT NOT NULL DEFAULT '{}', planned_rooms_json TEXT NOT NULL DEFAULT '[]',
                    rule_set_version TEXT NOT NULL, price_rule_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS rooms (
                    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_type TEXT NOT NULL, status TEXT NOT NULL, coverage_percent INTEGER NOT NULL DEFAULT 0,
                    score INTEGER, result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS media (
                    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, mime_type TEXT NOT NULL, path TEXT NOT NULL,
                    width INTEGER NOT NULL, height INTEGER NOT NULL, quality_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, status TEXT NOT NULL, stage TEXT NOT NULL,
                    error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS risks (
                    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                    risk_code TEXT NOT NULL, state TEXT NOT NULL, feedback TEXT, title TEXT NOT NULL, evidence TEXT NOT NULL,
                    confidence REAL NOT NULL, region_json TEXT, severity TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS selected_solutions (
                    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    risk_id TEXT NOT NULL UNIQUE REFERENCES risks(id) ON DELETE CASCADE, solution_package_id TEXT NOT NULL,
                    status TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS renovation_previews (
                    id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    source_media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                    selection_snapshot_json TEXT NOT NULL, selection_hash TEXT NOT NULL,
                    status TEXT NOT NULL, stage TEXT NOT NULL, error TEXT,
                    provider TEXT, model TEXT, prompt_version TEXT NOT NULL, rule_set_version TEXT NOT NULL,
                    visualized_actions_json TEXT NOT NULL DEFAULT '[]', skipped_actions_json TEXT NOT NULL DEFAULT '[]',
                    output_path TEXT, output_mime_type TEXT, selected_for_report INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_renovation_previews_room_created
                    ON renovation_previews(room_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_renovation_previews_assessment
                    ON renovation_previews(assessment_id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_renovation_previews_one_active_room
                    ON renovation_previews(room_id) WHERE status IN ('queued','running');
                CREATE TABLE IF NOT EXISTS shares (
                    token_hash TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS analytics_events (
                    id TEXT PRIMARY KEY, assessment_id TEXT, room_id TEXT, event_name TEXT NOT NULL,
                    payload_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS camera_discovery_sessions (
                    id TEXT PRIMARY KEY,
                    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    status TEXT NOT NULL,
                    media_ids_json TEXT NOT NULL DEFAULT '[]',
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS camera_suggestions (
                    id TEXT PRIMARY KEY,
                    camera_session_id TEXT NOT NULL REFERENCES camera_discovery_sessions(id) ON DELETE CASCADE,
                    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    frame_id TEXT NOT NULL,
                    risk_code TEXT NOT NULL,
                    suggestion_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_camera_suggestions_session_created
                    ON camera_suggestions(camera_session_id, created_at);
                CREATE TABLE IF NOT EXISTS camera_session_frames (
                    id TEXT PRIMARY KEY,
                    inspection_id TEXT NOT NULL UNIQUE,
                    camera_session_id TEXT NOT NULL REFERENCES camera_discovery_sessions(id) ON DELETE CASCADE,
                    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    captured_at_ms INTEGER NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    orientation TEXT NOT NULL,
                    perceptual_hash TEXT,
                    quality_json TEXT NOT NULL DEFAULT '{}',
                    group_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
                    expires_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_camera_session_frames_session_created
                    ON camera_session_frames(camera_session_id, created_at);
                CREATE TABLE IF NOT EXISTS advisor_sessions (
                    id TEXT PRIMARY KEY,
                    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    camera_session_id TEXT REFERENCES camera_discovery_sessions(id) ON DELETE SET NULL,
                    status TEXT NOT NULL,
                    provider_task_id TEXT,
                    rtc_room_id TEXT,
                    rtc_user_id TEXT,
                    rtc_bot_user_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    ended_at TEXT,
                    last_activity_at TEXT,
                    expires_at TEXT,
                    event_token_hash TEXT,
                    event_token_expires_at TEXT,
                    event_token_used_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_one_active_room
                    ON advisor_sessions(room_id) WHERE status='active';
                CREATE TABLE IF NOT EXISTS advisor_turns (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
                    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    status TEXT NOT NULL,
                    context_json TEXT NOT NULL DEFAULT '{}',
                    cards_json TEXT NOT NULL DEFAULT '[]',
                    provider_event_id TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_turn_provider_event
                    ON advisor_turns(session_id, provider_event_id) WHERE provider_event_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_advisor_turns_session_created
                    ON advisor_turns(session_id, created_at);
                CREATE TABLE IF NOT EXISTS advisor_confirmations (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
                    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    tool_name TEXT NOT NULL,
                    arguments_json TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    decided_at TEXT
                );
                CREATE TABLE IF NOT EXISTS advisor_tool_calls (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
                    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    provider_call_id TEXT NOT NULL UNIQUE,
                    provider_response_id TEXT,
                    tool_name TEXT NOT NULL,
                    arguments_json TEXT NOT NULL DEFAULT '{}',
                    result_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL,
                    schema_result TEXT NOT NULL,
                    latency_ms INTEGER,
                    error_type TEXT,
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_advisor_tool_calls_session_created
                    ON advisor_tool_calls(session_id, created_at);
                CREATE TABLE IF NOT EXISTS advisor_rtc_queue (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES advisor_sessions(id) ON DELETE CASCADE,
                    assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
                    client_instance_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    enqueued_at TEXT NOT NULL,
                    granted_at TEXT,
                    activated_at TEXT,
                    heartbeat_at TEXT,
                    lease_expires_at TEXT,
                    expires_at TEXT NOT NULL,
                    released_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_advisor_rtc_queue_fifo
                    ON advisor_rtc_queue(status,enqueued_at,id);
                CREATE INDEX IF NOT EXISTS idx_advisor_rtc_queue_session
                    ON advisor_rtc_queue(session_id,status);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_advisor_rtc_one_live_client
                    ON advisor_rtc_queue(session_id,client_instance_id)
                    WHERE status IN ('queued','granted','active','draining');
                CREATE TABLE IF NOT EXISTS knowledge_advisor_sessions (
                    id TEXT PRIMARY KEY,
                    token_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    provider_task_id TEXT,
                    rtc_room_id TEXT,
                    rtc_user_id TEXT,
                    rtc_bot_user_id TEXT,
                    client_instance_id TEXT,
                    device_lease_expires_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_activity_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_advisor_sessions_expiry
                    ON knowledge_advisor_sessions(status,expires_at);
                CREATE TABLE IF NOT EXISTS knowledge_advisor_turns (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES knowledge_advisor_sessions(id) ON DELETE CASCADE,
                    role TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    text TEXT NOT NULL,
                    status TEXT NOT NULL,
                    suggested_questions_json TEXT NOT NULL DEFAULT '[]',
                    provider_event_id TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_advisor_turns_session_created
                    ON knowledge_advisor_turns(session_id,created_at,id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_advisor_turn_event
                    ON knowledge_advisor_turns(session_id,provider_event_id)
                    WHERE provider_event_id IS NOT NULL;
                CREATE TABLE IF NOT EXISTS knowledge_advisor_provider_calls (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES knowledge_advisor_sessions(id) ON DELETE CASCADE,
                    provider TEXT,
                    model TEXT,
                    prompt_version TEXT NOT NULL,
                    latency_ms INTEGER,
                    schema_result TEXT NOT NULL,
                    error_type TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_advisor_calls_session_created
                    ON knowledge_advisor_provider_calls(session_id,created_at);
                CREATE TABLE IF NOT EXISTS knowledge_advisor_rtc_queue (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES knowledge_advisor_sessions(id) ON DELETE CASCADE,
                    client_instance_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    enqueued_at TEXT NOT NULL,
                    granted_at TEXT,
                    activated_at TEXT,
                    heartbeat_at TEXT,
                    lease_expires_at TEXT,
                    expires_at TEXT NOT NULL,
                    released_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_advisor_rtc_fifo
                    ON knowledge_advisor_rtc_queue(status,enqueued_at,id);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_advisor_rtc_live_client
                    ON knowledge_advisor_rtc_queue(session_id,client_instance_id)
                    WHERE status IN ('queued','granted','active','draining');
                INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
            """)
            self._add_column(connection, "media", "source_kind", "TEXT NOT NULL DEFAULT 'photo'")
            self._add_column(connection, "media", "source_id", "TEXT")
            self._add_column(connection, "media", "frame_index", "INTEGER")
            self._add_column(connection, "media", "captured_at_ms", "INTEGER")
            self._add_column(connection, "media", "orientation", "TEXT NOT NULL DEFAULT 'up'")
            self._add_column(connection, "media", "perceptual_hash", "TEXT")
            self._add_column(connection, "media", "zone_id", "TEXT")
            self._add_column(connection, "risks", "evidence_media_ids_json", "TEXT NOT NULL DEFAULT '[]'")
            self._add_column(connection, "camera_suggestions", "frame_id", "TEXT")
            self._add_column(connection, "advisor_sessions", "camera_session_id", "TEXT")
            self._add_column(connection, "advisor_sessions", "provider_task_id", "TEXT")
            self._add_column(connection, "advisor_sessions", "rtc_room_id", "TEXT")
            self._add_column(connection, "advisor_sessions", "rtc_user_id", "TEXT")
            self._add_column(connection, "advisor_sessions", "rtc_bot_user_id", "TEXT")
            self._add_column(connection, "advisor_sessions", "last_activity_at", "TEXT")
            self._add_column(connection, "advisor_sessions", "expires_at", "TEXT")
            self._add_column(connection, "advisor_sessions", "event_token_hash", "TEXT")
            self._add_column(connection, "advisor_sessions", "event_token_expires_at", "TEXT")
            self._add_column(connection, "advisor_sessions", "event_token_used_at", "TEXT")
            self._add_column(connection, "advisor_sessions", "rtc_media_mode", "TEXT NOT NULL DEFAULT 'audio'")
            self._add_column(connection, "advisor_sessions", "rtc_vision_mode", "TEXT")
            self._add_column(connection, "advisor_sessions", "client_instance_id", "TEXT")
            self._add_column(connection, "advisor_sessions", "device_lease_expires_at", "TEXT")
            connection.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'))")
            connection.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, datetime('now'))")
            connection.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (4, datetime('now'))")
            connection.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (5, datetime('now'))")
            connection.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (6, datetime('now'))")
            connection.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (7, datetime('now'))")

    @staticmethod
    def _add_column(connection: sqlite3.Connection, table: str, name: str, declaration: str) -> None:
        columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
        if name not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")


def decode_json_row(row: dict, fields: tuple[str, ...]) -> dict:
    value = dict(row)
    for field in fields:
        value[field.removesuffix("_json")] = json.loads(value.pop(field) or "null")
    return value
