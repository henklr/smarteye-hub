"""Internal start/stop entry points shared by HTTP API and the flows shim."""
from __future__ import annotations

import datetime as _dt
import json
import logging
import time
import uuid
from typing import Any, Dict, Optional

from .assembler import assemble_clip
from .config import trigger_max_duration_setting
from .db import db_connect
from .device_config import device_record_variants
from .paths import VARIANT_HD, VARIANT_SD, clip_path, sd_sibling_path

log = logging.getLogger("recording.triggers")

# Stop trims a couple of seconds into the future so the on-disk segment that
# contains "now" makes it into the clip.
_STOP_TRAIL_SECONDS = 2


def _now() -> int:
    return int(time.time())


def _clamp_max_duration(requested: Optional[int]) -> int:
    """Clamp to the current setting cap; 0/None means cap-as-max."""
    cap = trigger_max_duration_setting()
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
    # Continuous chunks are system-managed and have their own duration knob
    # (CONTINUOUS_CHUNK_SECONDS). They must bypass the user-facing trigger
    # cap — otherwise a small cap silently fragments continuous coverage
    # into many tiny chunks (chunk_seconds < cap → clamp(chunk)=chunk_seconds;
    # chunk_seconds > cap → silently truncated to cap, which is wrong).
    is_continuous = bool(metadata and metadata.get("_kind") == "continuous")
    if is_continuous and max_duration_seconds and max_duration_seconds > 0:
        max_dur = int(max_duration_seconds)
    else:
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

    # Decide which variant becomes the primary `.mp4` and whether a
    # `.sd.mp4` sibling should be assembled too. When both variants are
    # recorded the primary is HD (file_path column references the HD file);
    # when only one variant is recorded that variant is primary regardless.
    variants = device_record_variants().get(camera) or [VARIANT_HD]
    primary_variant = VARIANT_HD if VARIANT_HD in variants else VARIANT_SD

    try:
        clip = assemble_clip(
            camera=camera,
            start_ts=start_ts,
            end_ts=end_ts,
            output_path=out_path,
            variant=primary_variant,
        )
    except Exception:
        log.exception(
            "trigger.stop: assemble primary (%s) failed event_id=%s camera=%s",
            primary_variant, event_id, camera,
        )
        raise

    # Assemble the SD sibling only when *both* variants were recorded —
    # otherwise the primary already IS the SD variant (or HD only).
    sd_sibling: Optional[Any] = None
    if VARIANT_HD in variants and VARIANT_SD in variants:
        sd_path = sd_sibling_path(out_path)
        try:
            sd_sibling = assemble_clip(
                camera=camera,
                start_ts=start_ts,
                end_ts=end_ts,
                output_path=sd_path,
                variant=VARIANT_SD,
                make_thumbnail=False,
            )
        except FileNotFoundError:
            log.warning(
                "trigger.stop: no SD segments for event_id=%s camera=%s — "
                "SD sibling skipped",
                event_id, camera,
            )
        except Exception:
            log.exception(
                "trigger.stop: assemble SD sibling failed event_id=%s camera=%s",
                event_id, camera,
            )

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
        "trigger.stop: event_id=%s camera=%s primary=%s duration=%ds size=%db "
        "segs=%d gaps=%d sd_sibling=%s",
        event_id, camera, primary_variant, clip.duration_seconds, clip.file_size_bytes,
        clip.segments_used, len(clip.gaps),
        (sd_sibling.file_path.name if sd_sibling else "no"),
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
    """Atomically claim the most-recent open *user-triggered* recording for
    `camera` and finish it.

    Excludes continuous chunks: a flow's Stop recording should never end the
    always-on 24/7 chunk that the watchdog owns. Without this filter, the
    pre-started next continuous chunk (created by `_stop_expired` to avoid
    inter-chunk gaps) is the "most recent" entry and gets killed by every
    Stop recording call, which spawns another within seconds and produces
    a choppy, broken-up Continuous strip on the timeline.

    Concurrency: this used to be SELECT-then-DELETE in two statements,
    which let two concurrent flow runs target the same event_id. The
    DELETE…WHERE event_id = (SELECT…LIMIT 1) RETURNING pattern lets each
    caller claim a *distinct* row — SQLite serialises write transactions,
    so concurrent callers each pick a different most-recent open
    recording.
    """
    with db_connect() as conn:
        cur = conn.execute(
            "DELETE FROM active_recordings WHERE event_id = ("
            "  SELECT event_id FROM active_recordings"
            "   WHERE camera = ?"
            "     AND COALESCE(json_extract(metadata_json, '$._kind'), '') <> 'continuous'"
            "   ORDER BY created_at DESC LIMIT 1"
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
