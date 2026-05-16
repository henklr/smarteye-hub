"""SQLite schema and connection for the recording engine."""
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import DB_PATH


class FormatInProgressError(RuntimeError):
    """Raised when something tries to open the recording DB while a
    Format & mount cycle has the partition reserved.

    The recording DB lives on the NVMe mount we're about to wipe.
    Allowing a connection to open during format would create a WAL
    write FD that pins `/dev/nvme0n1p1` and makes mkfs fail with EBUSY.
    """


# Sentinel file path — same as `_FORMAT_IN_PROGRESS_PATH` in main.py.
# Lives on /app/data (the host bind), visible to BOTH uvicorn workers.
_FORMAT_SENTINEL_PATH = Path(os.getenv("DATA_DIR", "/app/data")) / ".format_in_progress"

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
    # Refuse to open a new connection while a Format & mount cycle is
    # in progress. The DB + its WAL/SHM files live on the partition
    # mkfs is about to wipe, and even a brief read holds writable FDs
    # that show up in `fuser` and break the format with EBUSY. Affects
    # every caller — HTTP request handlers, flow execution, ONVIF
    # event workers, etc. — gating at the connection door catches them
    # all without needing route-level middleware everywhere.
    try:
        if _FORMAT_SENTINEL_PATH.exists():
            raise FormatInProgressError(
                "recording DB is unavailable: storage maintenance in progress"
            )
    except FileNotFoundError:
        pass
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
    finally:
        conn.close()
