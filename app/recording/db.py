"""SQLite schema and connection for the recording engine."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator

from .config import DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS active_recordings (
    event_id TEXT PRIMARY KEY,
    camera TEXT NOT NULL,
    trigger_start_ts INTEGER NOT NULL,
    pre_buffer_seconds INTEGER NOT NULL,
    max_duration_seconds INTEGER NOT NULL,
    metadata_json TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    camera TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    thumbnail_path TEXT,
    file_size_bytes INTEGER NOT NULL,
    metadata_json TEXT,
    kind TEXT NOT NULL DEFAULT 'triggered',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS clips_camera_started ON clips(camera, started_at DESC);
CREATE INDEX IF NOT EXISTS clips_kind_started ON clips(kind, started_at);
CREATE INDEX IF NOT EXISTS active_camera ON active_recordings(camera);
"""


def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript(_SCHEMA)
        conn.commit()


@contextmanager
def db_connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
    finally:
        conn.close()
