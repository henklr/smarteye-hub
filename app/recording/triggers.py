"""Internal start/stop entry points shared by HTTP API and the flows shim."""
from __future__ import annotations

import datetime as _dt
import json
import logging
import time
import uuid
from typing import Any, Dict, Optional

from .assembler import assemble_clip
from .config import TRIGGER_MAX_DURATION_SECONDS
from .db import db_connect
from .paths import clip_path

log = logging.getLogger("recording.triggers")

# Stop trims a couple of seconds into the future so the on-disk segment that
# contains "now" makes it into the clip.
_STOP_TRAIL_SECONDS = 2


def _now() -> int:
    return int(time.time())


def _clamp_max_duration(requested: Optional[int]) -> int:
    """Clamp to env cap; 0/None means cap-as-max (continuous handled separately)."""
    cap = TRIGGER_MAX_DURATION_SECONDS
    if requested is None or requested <= 0:
        return cap
    return min(int(requested), cap)


def start_recording(
    *,
    camera: str,
    event_id: Optional[str] = None,
    pre_buffer_seconds: int = 0,
    max_duration_seconds: Optional[int] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Register an active recording. Does not touch ffmpeg."""
    eid = event_id or uuid.uuid4().hex
    trigger_start = _now()
    pre = max(0, int(pre_buffer_seconds))
    max_dur = _clamp_max_duration(max_duration_seconds)
    meta_json = json.dumps(metadata) if metadata else None
    with db_connect() as conn:
        conn.execute(
            "INSERT INTO active_recordings (event_id, camera, trigger_start_ts, "
            "pre_buffer_seconds, max_duration_seconds, metadata_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (eid, camera, trigger_start, pre, max_dur, meta_json, trigger_start),
        )
    log.info(
        "trigger.start: event_id=%s camera=%s pre=%ds max=%ds",
        eid, camera, pre, max_dur,
    )
    return {
        "event_id": eid,
        "camera": camera,
        "trigger_start_ts": trigger_start,
        "pre_buffer_seconds": pre,
        "max_duration_seconds": max_dur,
    }


def stop_recording(
    *,
    event_id: str,
    metadata: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Atomically claim by event_id, then assemble, then persist a clip row.

    Returns the inserted clip row as a dict, or None if no active recording
    with that event_id exists (already claimed by another caller).
    """
    with db_connect() as conn:
        cur = conn.execute(
            "DELETE FROM active_recordings WHERE event_id = ? RETURNING "
            "event_id, camera, trigger_start_ts, pre_buffer_seconds, metadata_json",
            (event_id,),
        )
        row = cur.fetchone()
    if row is None:
        log.info("trigger.stop: event_id=%s not found (already stopped or never existed)", event_id)
        return None
    return _finalise_stopped_recording(row, metadata)


def _finalise_stopped_recording(
    row: Any,
    metadata: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Assemble the clip + insert into `clips` for a row that has already
    been atomically DELETEd from active_recordings. Caller must ensure no
    other code path will see this event_id in active_recordings."""
    event_id = row["event_id"]
    camera = row["camera"]
    start_ts = int(row["trigger_start_ts"]) - int(row["pre_buffer_seconds"])
    end_ts = _now() + _STOP_TRAIL_SECONDS

    meta: Dict[str, Any] = {}
    if row["metadata_json"]:
        try:
            meta = json.loads(row["metadata_json"])
        except (json.JSONDecodeError, TypeError):
            meta = {}
    if metadata:
        meta.update(metadata)

    kind = str(meta.pop("_kind", "triggered"))

    now_dt = _dt.datetime.fromtimestamp(start_ts)
    out_path = clip_path(camera, now_dt.year, now_dt.month, now_dt.day, event_id)

    try:
        clip = assemble_clip(
            camera=camera,
            start_ts=start_ts,
            end_ts=end_ts,
            output_path=out_path,
        )
    except Exception:
        log.exception(
            "trigger.stop: assemble failed event_id=%s camera=%s",
            event_id, camera,
        )
        raise

    thumb_str = str(clip.thumbnail_path) if clip.thumbnail_path else None
    meta_json = json.dumps(meta) if meta else None
    with db_connect() as conn:
        conn.execute(
            "INSERT INTO clips (id, camera, started_at, ended_at, duration_seconds, "
            "file_path, thumbnail_path, file_size_bytes, metadata_json, kind, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                event_id, camera, clip.started_at, clip.ended_at, clip.duration_seconds,
                str(clip.file_path), thumb_str, clip.file_size_bytes, meta_json,
                kind, _now(),
            ),
        )

    log.info(
        "trigger.stop: event_id=%s camera=%s duration=%ds size=%db segs=%d gaps=%d",
        event_id, camera, clip.duration_seconds, clip.file_size_bytes,
        clip.segments_used, len(clip.gaps),
    )
    return {
        "id": event_id,
        "camera": camera,
        "started_at": clip.started_at,
        "ended_at": clip.ended_at,
        "duration_seconds": clip.duration_seconds,
        "file_path": str(clip.file_path),
        "thumbnail_path": thumb_str,
        "file_size_bytes": clip.file_size_bytes,
        "metadata": meta,
        "kind": kind,
        "segments_used": clip.segments_used,
        "gap_count": len(clip.gaps),
    }


def stop_recording_by_camera(camera: str) -> Optional[Dict[str, Any]]:
    """Atomically claim the most-recent open recording for `camera` and finish it.

    This used to do SELECT then DELETE in two statements, which let two
    concurrent flow runs both target the same event_id and only one of them
    actually claim a row — the other's start_recording row was then orphaned
    until the watchdog auto-stopped it at max_duration (causing the
    "mysterious 30-minute clip" the user was seeing under rapid-fire flow
    triggers). The DELETE…WHERE event_id = (SELECT…LIMIT 1) RETURNING
    pattern lets each caller claim a *distinct* row — SQLite serialises
    write transactions, so concurrent callers each pick a different
    most-recent open recording.
    """
    with db_connect() as conn:
        cur = conn.execute(
            "DELETE FROM active_recordings WHERE event_id = ("
            "  SELECT event_id FROM active_recordings WHERE camera = ?"
            "  ORDER BY created_at DESC LIMIT 1"
            ") RETURNING event_id, camera, trigger_start_ts, pre_buffer_seconds, metadata_json",
            (camera,),
        )
        row = cur.fetchone()
    if row is None:
        return None
    return _finalise_stopped_recording(row, None)


def list_active(camera: Optional[str] = None) -> list:
    with db_connect() as conn:
        if camera:
            rows = conn.execute(
                "SELECT * FROM active_recordings WHERE camera = ?", (camera,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM active_recordings").fetchall()
    return [dict(r) for r in rows]
