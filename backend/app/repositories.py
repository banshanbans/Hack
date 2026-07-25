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
                CREATE TABLE IF NOT EXISTS shares (
                    token_hash TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
                    expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS analytics_events (
                    id TEXT PRIMARY KEY, assessment_id TEXT, room_id TEXT, event_name TEXT NOT NULL,
                    payload_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS fair_scans (
                    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, status TEXT NOT NULL,
                    result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS fair_frames (
                    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES fair_scans(id) ON DELETE CASCADE,
                    zone_id TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
                    orientation TEXT NOT NULL, candidates_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS fair_zones (
                    id TEXT PRIMARY KEY, scan_id TEXT NOT NULL REFERENCES fair_scans(id) ON DELETE CASCADE,
                    zone_id TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
                    UNIQUE(scan_id, zone_id)
                );
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
            connection.execute("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'))")

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
