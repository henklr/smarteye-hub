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
    """Register an active recording. Does not touch ffmpeg.

    Two storage-saving rules for *non-continuous* triggers:

    1. If a continuous chunk is currently recording this camera, the
       chunk's clip file already contains this exact time window. We
       still create a row so the timeline shows a pill for the trigger,
       but we flag it `_marker_only` so the assembler skips writing a
       second on-disk copy of the same bytes.

    2. Otherwise, if another non-continuous trigger is already open for
       this camera, the new trigger piggybacks on it — we extend the
       existing recording's `max_duration_seconds` to cover the new
       window and return the existing event_id. A chatty motion flow
       therefore produces one continuous clip per burst instead of N
       overlapping ones.
    """
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

    if not is_continuous:
        # What variants will the assembler use for this trigger? Default
        # "hd" — matches the Record-node default; flow nodes can pass an
        # explicit list via metadata to override.
        trigger_variants = set()
        meta_override = (metadata or {}).get("_record_variants")
        if isinstance(meta_override, list):
            for v in meta_override:
                if v in (VARIANT_HD, VARIANT_SD):
                    trigger_variants.add(v)
        if not trigger_variants:
            trigger_variants.add(VARIANT_HD)

        with db_connect() as conn:
            continuous_row = conn.execute(
                "SELECT metadata_json FROM active_recordings WHERE camera = ?"
                " AND COALESCE(json_extract(metadata_json, '$._kind'), '') = 'continuous'"
                " LIMIT 1",
                (camera,),
            ).fetchone()
            sibling = conn.execute(
                "SELECT event_id, trigger_start_ts, pre_buffer_seconds, max_duration_seconds, metadata_json"
                " FROM active_recordings WHERE camera = ?"
                " AND COALESCE(json_extract(metadata_json, '$._kind'), '') <> 'continuous'"
                " ORDER BY trigger_start_ts DESC LIMIT 1",
                (camera,),
            ).fetchone()

        # Decide whether the continuous chunk fully covers this trigger.
        # Only true when continuous's variant set is a superset of what
        # the trigger wants. SD continuous + HD trigger does NOT cover —
        # we must write a real HD clip alongside the SD continuous chunk.
        continuous_covers = False
        if continuous_row is not None:
            try:
                cont_meta = json.loads(continuous_row["metadata_json"] or "{}")
            except (json.JSONDecodeError, TypeError):
                cont_meta = {}
            cont_variants = cont_meta.get("_record_variants")
            cont_set = set()
            if isinstance(cont_variants, list):
                cont_set = {v for v in cont_variants if v in (VARIANT_HD, VARIANT_SD)}
            if not cont_set:
                # Legacy continuous chunk with no explicit variants — it
                # used to default to HD primary + SD sibling when both
                # were recorded. Conservative: treat as covering both.
                cont_set = {VARIANT_HD, VARIANT_SD}
            continuous_covers = trigger_variants.issubset(cont_set)

        # Rule 2: coalesce into an existing non-continuous recording on
        # the same camera. Only when continuous doesn't cover us — if it
        # does, the marker path below is cheaper than extending a clip.
        if sibling is not None and not continuous_covers:
            old_start = int(sibling["trigger_start_ts"])
            old_pre = int(sibling["pre_buffer_seconds"])
            new_end = trigger_start + max_dur
            old_end = old_start + int(sibling["max_duration_seconds"])
            effective_end = max(new_end, old_end)
            new_max_dur = _clamp_max_duration(effective_end - old_start)
            with db_connect() as conn:
                conn.execute(
                    "UPDATE active_recordings SET max_duration_seconds = ?"
                    " WHERE event_id = ?",
                    (new_max_dur, sibling["event_id"]),
                )
            log.info(
                "trigger.start: coalesced into existing event_id=%s "
                "camera=%s new_max=%ds (was %ds)",
                sibling["event_id"], camera, new_max_dur,
                int(sibling["max_duration_seconds"]),
            )
            return {
                "event_id": sibling["event_id"],
                "camera": camera,
                "trigger_start_ts": old_start,
                "pre_buffer_seconds": old_pre,
                "max_duration_seconds": new_max_dur,
            }

        # Rule 1: continuous chunk owns this time window AND its variants
        # cover what the trigger wants — record a marker (no clip file).
        if continuous_covers:
            metadata = dict(metadata or {})
            metadata["_marker_only"] = True

    meta_json = json.dumps(metadata) if metadata else None
    with db_connect() as conn:
        conn.execute(
            "INSERT INTO active_recordings (event_id, camera, trigger_start_ts, "
            "pre_buffer_seconds, max_duration_seconds, metadata_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (eid, camera, trigger_start, pre, max_dur, meta_json, trigger_start),
        )
    log.info(
        "trigger.start: event_id=%s camera=%s pre=%ds max=%ds marker=%s",
        eid, camera, pre, max_dur,
        bool(metadata and metadata.get("_marker_only")),
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
    marker_only = bool(meta.pop("_marker_only", False))

    # Marker-only triggers: a continuous chunk was already recording
    # this exact time window, so the bytes are already on disk under
    # the continuous clip. Skip assembly entirely and insert a marker
    # row with an empty file_path. The timeline lane still shows the
    # tag pill; the playback engine ignores the row for video lookup
    # and the user's tile plays the continuous chunk instead.
    if marker_only:
        meta_json = json.dumps(meta) if meta else None
        duration = max(1, end_ts - start_ts)
        with db_connect() as conn:
            conn.execute(
                "INSERT INTO clips (id, camera, started_at, ended_at, duration_seconds, "
                "file_path, thumbnail_path, file_size_bytes, metadata_json, kind, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    event_id, camera, start_ts, end_ts, duration,
                    "", None, 0, meta_json, kind, _now(),
                ),
            )
        log.info(
            "trigger.stop: marker-only event_id=%s camera=%s "
            "(continuous chunk covers this window — no clip file written)",
            event_id, camera,
        )
        return {
            "id": event_id,
            "camera": camera,
            "started_at": start_ts,
            "ended_at": end_ts,
            "duration_seconds": duration,
            "file_path": "",
            "thumbnail_path": None,
            "file_size_bytes": 0,
            "metadata": meta,
            "kind": kind,
            "is_marker": True,
        }

    now_dt = _dt.datetime.fromtimestamp(start_ts)
    primary_out_path = clip_path(camera, now_dt.year, now_dt.month, now_dt.day, event_id)

    # Decide which variant becomes the primary `.mp4` and whether a
    # `.sd.mp4` sibling should be assembled too. When both variants are
    # recorded the primary is HD (file_path column references the HD file);
    # when only one variant is recorded that variant is primary regardless.
    device_variants = list(device_record_variants().get(camera) or [VARIANT_HD])
    # Per-Record-node override (set by flows.py from the inspector). The
    # override can only NARROW what the device is recording — we can't
    # produce SD if the SD segmenter isn't running. If the override has
    # no overlap with device_variants we fall back to the device default
    # and log a warning.
    override = meta.pop("_record_variants", None)
    variants = device_variants
    if isinstance(override, list) and override:
        desired = [v for v in override if v in (VARIANT_HD, VARIANT_SD)]
        intersection = [v for v in desired if v in device_variants]
        if intersection:
            variants = intersection
        else:
            log.warning(
                "trigger.stop: record_variants override %s has no overlap "
                "with device variants %s for camera=%s — using device default",
                override, device_variants, camera,
            )
    primary_variant = VARIANT_HD if VARIANT_HD in variants else VARIANT_SD

    # Encode the primary's variant into the filename so the playback
    # side knows what's HD vs SD without a separate column. HD primary
    # uses `<event>.mp4`; SD primary uses `<event>.sd.mp4`. When both
    # variants are recorded we still use the `.mp4` / `.sd.mp4` pair —
    # primary file lives at .mp4 (HD), sibling at .sd.mp4 (SD).
    out_path = primary_out_path if primary_variant == VARIANT_HD else sd_sibling_path(primary_out_path)

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
        sd_path = sd_sibling_path(primary_out_path)
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
