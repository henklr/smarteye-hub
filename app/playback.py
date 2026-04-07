from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse


DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

STATIC_DIR = Path(__file__).resolve().parent / "static"
DEVICES_JSON = DATA_DIR / "devices.json"
FLOWS_JSON = DATA_DIR / "flows.json"
RECORDINGS_DIR = DATA_DIR / "recordings"
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
PLAYBACK_CLIPS_DIR = DATA_DIR / "playback_clips"
PLAYBACK_CLIPS_DIR.mkdir(parents=True, exist_ok=True)
RECORDING_EVENTS_JSON = DATA_DIR / "recording_events.json"

MEDIAMTX_RTSP_BASE = os.getenv("MEDIAMTX_RTSP_BASE", "rtsp://mediamtx:8554").rstrip("/")
RECORDING_SEGMENT_SECONDS = max(15, int(os.getenv("RECORDING_SEGMENT_SECONDS", "60") or "60"))
RECORDING_RETENTION_DAYS = max(1, int(os.getenv("RECORDING_RETENTION_DAYS", "7") or "7"))
RECORDER_POLL_SECONDS = max(2.0, float(os.getenv("RECORDER_POLL_SECONDS", "5") or "5"))
PLAYBACK_RECORDING_SCOPE = str(os.getenv("PLAYBACK_RECORDING_SCOPE", "flow_cameras") or "flow_cameras").strip().lower()
PLAYBACK_CLIP_MODE = str(os.getenv("PLAYBACK_CLIP_MODE", "copy-first") or "copy-first").strip().lower()
CLIP_ENCODING_PRESET = os.getenv("PLAYBACK_CLIP_PRESET", "ultrafast")
CLIP_ENCODING_THREADS = max(1, int(os.getenv("PLAYBACK_CLIP_THREADS", "1") or "1"))
PLAYBACK_CLIP_CACHE_LIMIT = max(0, int(os.getenv("PLAYBACK_CLIP_CACHE_LIMIT", "8") or "8"))
SEGMENT_FINALIZE_GRACE_SECONDS = max(2.0, RECORDER_POLL_SECONDS)
READINESS_GAP_TOLERANCE_SECONDS = 0.25

router = APIRouter(tags=["playback"])

_events_lock = threading.RLock()
_recorders_lock = threading.RLock()
_recorders: Dict[str, subprocess.Popen] = {}
_recorder_stop = threading.Event()
_recorder_kick = threading.Event()
_recorder_pause = threading.Event()
_recorder_thread: Optional[threading.Thread] = None
_path_refresher: Optional[Callable[[str], Any]] = None
_prune_counter = 0


@dataclass(frozen=True)
class RecordingSegment:
    path: Path
    started_at: datetime
    ended_at: datetime
    finalized: bool


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return _utc_now().isoformat()


def _parse_iso(value: Any) -> datetime:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Missing datetime")
    return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)


def _path_for(device_id: str) -> str:
    return f"cam-{device_id.strip()}"


def _recordings_dir_for_device(device_id: str) -> Path:
    path = RECORDINGS_DIR / device_id.strip()
    path.mkdir(parents=True, exist_ok=True)
    return path


def _clip_path_for_event(event_id: str) -> Path:
    return PLAYBACK_CLIPS_DIR / f"{event_id}.mp4"


def _clip_probe_command(path: Path) -> List[str]:
    return [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration,size",
        "-of",
        "json",
        str(path),
    ]


def _load_devices() -> List[Dict[str, Any]]:
    try:
        payload = json.loads(DEVICES_JSON.read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(payload, dict):
        items = payload.get("devices")
    else:
        items = payload
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _load_events() -> List[Dict[str, Any]]:
    try:
        payload = json.loads(RECORDING_EVENTS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


def _save_events(items: List[Dict[str, Any]]) -> None:
    RECORDING_EVENTS_JSON.write_text(json.dumps(items, indent=2), encoding="utf-8")


def _delete_clip_cache(event_ids: set[str]) -> None:
    for event_id in sorted({str(item or "").strip() for item in event_ids if str(item or "").strip()}):
        try:
            _clip_path_for_event(event_id).unlink(missing_ok=True)
        except Exception:
            pass


def _clip_end_after(started_at: datetime, ended_at: datetime) -> datetime:
    minimum_end = started_at + timedelta(milliseconds=100)
    return ended_at if ended_at > minimum_end else minimum_end


def _event_is_open(event: Dict[str, Any]) -> bool:
    try:
        _parse_iso(event.get("clip_end"))
    except Exception:
        return True
    return False


def _event_clip_bounds(event: Dict[str, Any]) -> Tuple[datetime, datetime]:
    started_at = _parse_iso(event.get("clip_start"))
    ended_at = _parse_iso(event.get("clip_end"))
    if ended_at <= started_at:
        raise ValueError("Recording event has an invalid time range")
    return started_at, ended_at


def _event_compare_bounds(event: Dict[str, Any]) -> Tuple[datetime, Optional[datetime]]:
    started_at = _parse_iso(event.get("clip_start"))
    try:
        ended_at = _parse_iso(event.get("clip_end"))
    except Exception:
        ended_at = None
    return started_at, ended_at


def _event_trigger_at(event: Dict[str, Any], fallback_started_at: datetime) -> datetime:
    try:
        return _parse_iso(event.get("triggered_at"))
    except Exception:
        return fallback_started_at


def _ranges_overlap(
    started_at: datetime,
    ended_at: Optional[datetime],
    other_started_at: datetime,
    other_ended_at: Optional[datetime],
) -> bool:
    if ended_at is None:
        return other_ended_at is None or other_ended_at > started_at
    if other_ended_at is None:
        return ended_at > other_started_at
    return started_at < other_ended_at and other_started_at < ended_at


def _merge_title(primary: Any, secondary: Any) -> str:
    primary_text = str(primary or "").strip()
    secondary_text = str(secondary or "").strip()
    if primary_text and primary_text.lower() != "recording":
        return primary_text
    if secondary_text and secondary_text.lower() != "recording":
        return secondary_text
    return primary_text or secondary_text or "Recording"


def _merge_color(primary: Any, secondary: Any) -> str:
    primary_color = _clamp_color(primary)
    secondary_color = _clamp_color(secondary)
    if primary_color != "#c6a14b":
        return primary_color
    if secondary_color != "#c6a14b":
        return secondary_color
    return primary_color


def _normalize_tag_segment(segment: Dict[str, Any], event: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    if not isinstance(segment, dict):
        return None

    source = event if isinstance(event, dict) else {}
    preset_name = str(segment.get("preset_name") or source.get("preset_name") or source.get("title") or "Recording").strip() or "Recording"
    title = str(segment.get("title") or source.get("title") or preset_name).strip() or preset_name
    clip_start = segment.get("clip_start") or source.get("clip_start")
    clip_end = segment.get("clip_end") or source.get("clip_end")
    triggered_at = segment.get("triggered_at") or source.get("triggered_at") or clip_start

    if not clip_start or not clip_end:
        return None

    try:
        started_at = _parse_iso(clip_start)
        ended_at = _parse_iso(clip_end)
        triggered = _parse_iso(triggered_at)
    except Exception:
        return None

    if ended_at <= started_at:
        return None

    preset_key = str(segment.get("preset_key") or source.get("preset_key") or "").strip() or _recording_preset_key(preset_name)
    return {
        "preset_name": preset_name,
        "preset_key": preset_key,
        "title": title,
        "color": _clamp_color(segment.get("color") or source.get("color")),
        "clip_start": started_at.isoformat(),
        "clip_end": ended_at.isoformat(),
        "triggered_at": triggered.isoformat(),
    }


def _merge_tag_segments(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    for segment in segments:
        item = _normalize_tag_segment(segment)
        if item is not None:
            normalized.append(item)

    normalized.sort(
        key=lambda item: (
            str(item.get("preset_key") or ""),
            str(item.get("color") or ""),
            str(item.get("clip_start") or ""),
            str(item.get("clip_end") or ""),
            str(item.get("triggered_at") or ""),
        )
    )

    merged: List[Dict[str, Any]] = []
    for item in normalized:
        if not merged:
            merged.append(dict(item))
            continue

        previous = merged[-1]
        if (
            str(previous.get("preset_key") or "") != str(item.get("preset_key") or "")
            or str(previous.get("color") or "") != str(item.get("color") or "")
        ):
            merged.append(dict(item))
            continue

        previous_start = _parse_iso(previous.get("clip_start"))
        previous_end = _parse_iso(previous.get("clip_end"))
        item_start = _parse_iso(item.get("clip_start"))
        item_end = _parse_iso(item.get("clip_end"))

        if item_start > previous_end:
            merged.append(dict(item))
            continue

        previous["clip_start"] = min(previous_start, item_start).isoformat()
        previous["clip_end"] = max(previous_end, item_end).isoformat()
        previous["triggered_at"] = min(_parse_iso(previous.get("triggered_at")), _parse_iso(item.get("triggered_at"))).isoformat()
        if not str(previous.get("title") or "").strip():
            previous["title"] = item.get("title") or item.get("preset_name") or "Recording"
        if not str(previous.get("preset_name") or "").strip():
            previous["preset_name"] = item.get("preset_name") or "Recording"

    return merged


def _event_tag_segments(event: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_segments = event.get("tag_segments") if isinstance(event.get("tag_segments"), list) else None
    if raw_segments:
        return _merge_tag_segments([
            item
            for item in (_normalize_tag_segment(segment, event) for segment in raw_segments)
            if item is not None
        ])

    fallback = _normalize_tag_segment({}, event)
    return [fallback] if fallback is not None else []


def _continuous_segment_coverage(
    segments: List[RecordingSegment],
    started_at: datetime,
    ended_at: datetime,
) -> Optional[Tuple[datetime, datetime]]:
    overlaps: List[Tuple[datetime, datetime]] = []
    for segment in sorted(segments, key=lambda item: item.started_at):
        overlap_start = max(segment.started_at, started_at)
        overlap_end = min(segment.ended_at, ended_at)
        if overlap_end <= overlap_start:
            continue
        overlaps.append((overlap_start, overlap_end))

    if not overlaps:
        return None

    tolerance = timedelta(seconds=READINESS_GAP_TOLERANCE_SECONDS)
    coverage_start, coverage_end = overlaps[0]
    for overlap_start, overlap_end in overlaps[1:]:
        if overlap_start > coverage_end + tolerance:
            break
        if overlap_end > coverage_end:
            coverage_end = overlap_end
        if coverage_end >= ended_at - tolerance:
            break

    return coverage_start, min(coverage_end, ended_at)


def _trim_event_to_available_coverage(event: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
    if _event_is_open(event):
        return dict(event), False

    try:
        started_at, ended_at = _event_clip_bounds(event)
    except Exception:
        return dict(event), False

    device_id = str(event.get("device_id") or "").strip()
    if not device_id:
        return dict(event), False

    coverage = _continuous_segment_coverage(_segments_for_range(device_id, started_at, ended_at), started_at, ended_at)
    if coverage is None:
        return dict(event), False

    available_start, available_end = coverage
    tolerance = timedelta(seconds=READINESS_GAP_TOLERANCE_SECONDS)
    if available_start <= started_at + tolerance and available_end >= ended_at - tolerance:
        return dict(event), False

    updated = dict(event)
    updated["clip_start"] = available_start.isoformat()
    updated["clip_end"] = available_end.isoformat()

    trigger_at = _event_trigger_at(event, available_start)
    updated["before_seconds"] = max(0.0, (trigger_at - available_start).total_seconds())
    updated["after_seconds"] = max(0.0, (available_end - trigger_at).total_seconds())

    trimmed_segments: List[Dict[str, Any]] = []
    for segment in _event_tag_segments(event):
        segment_start = _parse_iso(segment.get("clip_start"))
        segment_end = _parse_iso(segment.get("clip_end"))
        trimmed_start = max(segment_start, available_start)
        trimmed_end = min(segment_end, available_end)
        if trimmed_end <= trimmed_start:
            continue
        trimmed = dict(segment)
        trimmed["clip_start"] = trimmed_start.isoformat()
        trimmed["clip_end"] = trimmed_end.isoformat()
        trimmed_segments.append(trimmed)
    updated["tag_segments"] = _merge_tag_segments(trimmed_segments)
    return updated, True


def _merge_event_records(primary: Dict[str, Any], secondary: Dict[str, Any]) -> Dict[str, Any]:
    primary_started_at, primary_ended_at = _event_compare_bounds(primary)
    secondary_started_at, secondary_ended_at = _event_compare_bounds(secondary)
    primary_trigger_at = _event_trigger_at(primary, primary_started_at)
    secondary_trigger_at = _event_trigger_at(secondary, secondary_started_at)

    merged_started_at = min(primary_started_at, secondary_started_at)
    merged_trigger_at = min(primary_trigger_at, secondary_trigger_at)
    merged_ended_at = None
    if primary_ended_at is not None and secondary_ended_at is not None:
        merged_ended_at = max(primary_ended_at, secondary_ended_at)

    merged = dict(primary)
    merged["clip_start"] = merged_started_at.isoformat()
    merged["triggered_at"] = merged_trigger_at.isoformat()
    merged["clip_end"] = merged_ended_at.isoformat() if merged_ended_at is not None else None
    merged["before_seconds"] = max(0.0, (merged_trigger_at - merged_started_at).total_seconds())
    merged["after_seconds"] = (
        None
        if merged_ended_at is None
        else max(0.0, (merged_ended_at - merged_trigger_at).total_seconds())
    )
    merged["title"] = _merge_title(primary.get("title"), secondary.get("title"))
    merged["color"] = _merge_color(primary.get("color"), secondary.get("color"))
    merged["preset_name"] = _merge_title(_event_preset_name(primary), _event_preset_name(secondary))
    merged["preset_key"] = _recording_preset_key(merged["preset_name"])
    merged["tag_segments"] = _merge_tag_segments([*_event_tag_segments(primary), *_event_tag_segments(secondary)])
    merged["flow_id"] = primary.get("flow_id") or secondary.get("flow_id") or None
    merged["flow_name"] = primary.get("flow_name") or secondary.get("flow_name") or None
    merged["node_id"] = primary.get("node_id") or secondary.get("node_id") or None
    return merged


def _merge_overlapping_events(items: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], set[str], bool]:
    passthrough: List[Dict[str, Any]] = []
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    changed = False
    invalidated_clip_ids: set[str] = set()

    for item in items:
        device_id = str(item.get("device_id") or "").strip()
        if not device_id:
            passthrough.append(dict(item))
            continue
        try:
            _event_compare_bounds(item)
        except Exception:
            passthrough.append(dict(item))
            continue
        grouped.setdefault(device_id, []).append(dict(item))

    merged_items: List[Dict[str, Any]] = []
    for device_id, group in grouped.items():
        group.sort(
            key=lambda item: (
                _event_compare_bounds(item)[0],
                _event_trigger_at(item, _event_compare_bounds(item)[0]),
                str(item.get("id") or ""),
            )
        )
        current = group[0]

        for item in group[1:]:
            current_started_at, current_ended_at = _event_compare_bounds(current)
            item_started_at, item_ended_at = _event_compare_bounds(item)
            if (
                current_ended_at is not None
                and item_ended_at is not None
                and _ranges_overlap(current_started_at, current_ended_at, item_started_at, item_ended_at)
            ):
                current_id = str(current.get("id") or "").strip()
                item_id = str(item.get("id") or "").strip()
                if current_id:
                    invalidated_clip_ids.add(current_id)
                if item_id:
                    invalidated_clip_ids.add(item_id)
                current = _merge_event_records(current, item)
                changed = True
                continue
            merged_items.append(current)
            current = item

        merged_items.append(current)

    out = [*passthrough, *merged_items]
    out.sort(key=lambda item: (str(item.get("device_id") or ""), str(item.get("triggered_at") or item.get("clip_start") or ""), str(item.get("id") or "")))

    if len(out) != len(items) or any(left != right for left, right in zip(out, items)):
        changed = True

    return out, invalidated_clip_ids, changed


def _load_events_normalized() -> List[Dict[str, Any]]:
    items = []
    changed = False
    for item in _load_events():
        normalized_item, item_changed = _trim_event_to_available_coverage(item)
        items.append(normalized_item)
        if item_changed:
            changed = True
    merged_items, invalidated_clip_ids, merge_changed = _merge_overlapping_events(items)
    if changed or merge_changed:
        _save_events(merged_items)
        _delete_clip_cache(invalidated_clip_ids)
    return merged_items


def _find_matching_event(items: List[Dict[str, Any]], probe: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    probe_id = str(probe.get("id") or "").strip()
    if probe_id:
        exact = next((item for item in items if str(item.get("id") or "").strip() == probe_id), None)
        if exact is not None:
            return exact

    device_id = str(probe.get("device_id") or "").strip()
    if not device_id:
        return None

    try:
        probe_started_at, probe_ended_at = _event_compare_bounds(probe)
    except Exception:
        return None

    for item in items:
        if str(item.get("device_id") or "").strip() != device_id:
            continue
        item_started_at, item_ended_at = _event_compare_bounds(item)
        if _ranges_overlap(item_started_at, item_ended_at, probe_started_at, probe_ended_at):
            return item
    return None


def _load_flows() -> List[Dict[str, Any]]:
    try:
        payload = json.loads(FLOWS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return []

    items = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _segment_start_from_name(path: Path) -> Optional[datetime]:
    try:
        stamp = path.stem
        return datetime.strptime(stamp, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _segment_end_time(path: Path, started_at: datetime, next_started_at: Optional[datetime]) -> datetime:
    if next_started_at is not None and next_started_at > started_at:
        return next_started_at

    fallback_end = started_at + timedelta(seconds=RECORDING_SEGMENT_SECONDS)
    try:
        modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    except Exception:
        modified_at = fallback_end

    return max(fallback_end, modified_at)


def _segment_is_finalized(path: Path, started_at: datetime, next_started_at: Optional[datetime]) -> bool:
    if next_started_at is not None and next_started_at > started_at:
        return True

    now = _utc_now()
    finalize_at = started_at + timedelta(seconds=RECORDING_SEGMENT_SECONDS + SEGMENT_FINALIZE_GRACE_SECONDS)
    try:
        modified_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    except Exception:
        modified_at = now

    return now >= finalize_at and modified_at <= now - timedelta(seconds=max(1.0, RECORDER_POLL_SECONDS / 2))


def _recording_device_ids_from_flows() -> set[str]:
    device_ids: set[str] = set()
    for flow in _load_flows():
        if not bool(flow.get("enabled", True)):
            continue
        for node in flow.get("nodes") or []:
            if not isinstance(node, dict) or str(node.get("type") or "") != "action.record":
                continue
            config = node.get("config") if isinstance(node.get("config"), dict) else {}
            device_id = str(config.get("device_id") or "").strip()
            if device_id:
                device_ids.add(device_id)
    return device_ids


def _desired_recorder_ids(devices: List[Dict[str, Any]]) -> set[str]:
    configured_ids = {
        str(item.get("id") or "").strip()
        for item in devices
        if str(item.get("profile_token") or "").strip()
    }
    configured_ids.discard("")

    if PLAYBACK_RECORDING_SCOPE == "all":
        return configured_ids

    return configured_ids & _recording_device_ids_from_flows()


def _list_segments(device_id: str) -> List[RecordingSegment]:
    raw_segments: List[Tuple[Path, datetime]] = []
    recordings_dir = _recordings_dir_for_device(device_id)
    for path in sorted(recordings_dir.iterdir()) if recordings_dir.exists() else []:
        if path.suffix.lower() not in {".mp4", ".ts"} or not path.is_file():
            continue
        started_at = _segment_start_from_name(path)
        if started_at is None:
            continue
        raw_segments.append((path, started_at))

    out: List[RecordingSegment] = []
    for index, (path, started_at) in enumerate(raw_segments):
        next_started_at = raw_segments[index + 1][1] if index + 1 < len(raw_segments) else None
        ended_at = _segment_end_time(path, started_at, next_started_at)

        out.append(
            RecordingSegment(
                path=path,
                started_at=started_at,
                ended_at=ended_at,
                finalized=_segment_is_finalized(path, started_at, next_started_at),
            )
        )
    return out


def _segments_for_range(device_id: str, started_at: datetime, ended_at: datetime) -> List[RecordingSegment]:
    return [
        segment
        for segment in _list_segments(device_id)
        if segment.started_at < ended_at and segment.ended_at > started_at
    ]


def _segments_cover_range(segments: List[RecordingSegment], started_at: datetime, ended_at: datetime) -> bool:
    if ended_at <= started_at:
        return False

    cursor = started_at
    tolerance = timedelta(seconds=READINESS_GAP_TOLERANCE_SECONDS)
    for segment in sorted(segments, key=lambda item: item.started_at):
        overlap_start = max(segment.started_at, started_at)
        overlap_end = min(segment.ended_at, ended_at)
        if overlap_end <= overlap_start:
            continue
        if overlap_start > cursor + tolerance:
            return False
        if overlap_end > cursor:
            cursor = overlap_end
        if cursor >= ended_at - tolerance:
            return True

    return cursor >= ended_at - tolerance


def _event_state(event: Dict[str, Any]) -> str:
    if _event_is_open(event):
        return "recording"

    try:
        started_at, ended_at = _event_clip_bounds(event)
    except Exception:
        return "finalizing"

    if ended_at > _utc_now():
        return "recording"

    segments = _segments_for_range(str(event.get("device_id") or "").strip(), started_at, ended_at)
    if not _segments_cover_range(segments, started_at, ended_at):
        missing_grace = timedelta(seconds=max(SEGMENT_FINALIZE_GRACE_SECONDS, RECORDER_POLL_SECONDS))
        if _utc_now() >= ended_at + missing_grace:
            return "missing"
        return "finalizing"

    finalized_segments = [segment for segment in segments if segment.finalized]
    if _segments_cover_range(finalized_segments, started_at, ended_at):
        return "ready"

    return "finalizing"


def _event_is_ready(event: Dict[str, Any]) -> bool:
    return _event_state(event) == "ready"


def _event_by_id(event_id: str) -> Dict[str, Any]:
    with _events_lock:
        items = _load_events_normalized()
    event = next((item for item in items if str(item.get("id")) == event_id), None)
    if event is None:
        raise HTTPException(status_code=404, detail="Recording event not found")
    return event


def _clamp_color(value: Any) -> str:
    raw = str(value or "#c6a14b").strip()
    if len(raw) == 7 and raw.startswith("#"):
        try:
            int(raw[1:], 16)
            return raw.lower()
        except Exception:
            pass
    return "#c6a14b"


def _slugify_preset_name(value: Any) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return slug or "recording"


def _recording_preset_key(name: Any) -> str:
    return _slugify_preset_name(name)


def _event_preset_name(event: Dict[str, Any]) -> str:
    return str(event.get("preset_name") or event.get("title") or "Recording").strip() or "Recording"


def _event_preset_key(event: Dict[str, Any]) -> str:
    preset_key = str(event.get("preset_key") or "").strip()
    if preset_key:
        return preset_key
    return _recording_preset_key(_event_preset_name(event))


def _recording_ffmpeg_command(device_id: str) -> List[str]:
    source = f"{MEDIAMTX_RTSP_BASE}/{_path_for(device_id)}"
    pattern = str(_recordings_dir_for_device(device_id) / "%Y%m%dT%H%M%S.ts")
    return [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-rtsp_transport",
        "tcp",
        "-i",
        source,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-f",
        "segment",
        "-segment_format",
        "mpegts",
        "-segment_time",
        str(RECORDING_SEGMENT_SECONDS),
        "-reset_timestamps",
        "1",
        "-strftime",
        "1",
        pattern,
    ]


def set_recording_path_refresher(callback: Optional[Callable[[str], Any]]) -> None:
    global _path_refresher
    _path_refresher = callback


def request_recorders_refresh() -> None:
    _recorder_kick.set()


def _stop_recorder(device_id: str) -> None:
    proc: Optional[subprocess.Popen] = None
    with _recorders_lock:
        proc = _recorders.pop(device_id, None)
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _start_recorder(device_id: str) -> None:
    with _recorders_lock:
        existing = _recorders.get(device_id)
        if existing and existing.poll() is None:
            return
        if existing is not None:
            _recorders.pop(device_id, None)

    proc = subprocess.Popen(
        _recording_ffmpeg_command(device_id),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with _recorders_lock:
        _recorders[device_id] = proc


def _prune_cached_clips() -> None:
    if not PLAYBACK_CLIPS_DIR.exists():
        return

    with _events_lock:
        active_event_ids = {
            str(item.get("id") or "").strip()
            for item in _load_events_normalized()
            if str(item.get("id") or "").strip()
        }

    for path in PLAYBACK_CLIPS_DIR.glob("*.mp4"):
        if not path.is_file() or path.stem in active_event_ids:
            continue
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass

    if PLAYBACK_CLIP_CACHE_LIMIT <= 0:
        return

    clips = [path for path in PLAYBACK_CLIPS_DIR.glob("*.mp4") if path.is_file()]
    clips.sort(key=lambda path: path.stat().st_mtime, reverse=True)

    for path in clips[PLAYBACK_CLIP_CACHE_LIMIT:]:
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass


def _prune_old_recordings() -> None:
    cutoff = _utc_now() - timedelta(days=RECORDING_RETENTION_DAYS)
    for device_dir in RECORDINGS_DIR.iterdir() if RECORDINGS_DIR.exists() else []:
        if not device_dir.is_dir():
            continue
        for path in device_dir.iterdir():
            if path.suffix.lower() not in {".mp4", ".ts"} or not path.is_file():
                continue
            started_at = _segment_start_from_name(path)
            if started_at is None:
                continue
            if started_at < cutoff:
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass


def _recorders_loop() -> None:
    global _prune_counter
    while not _recorder_stop.is_set():
        if _recorder_pause.is_set():
            _recorder_kick.wait(timeout=RECORDER_POLL_SECONDS)
            _recorder_kick.clear()
            continue

        devices = _load_devices()
        desired_ids = _desired_recorder_ids(devices)

        with _recorders_lock:
            active_ids = set(_recorders.keys())

        for device_id in sorted(active_ids - desired_ids):
            _stop_recorder(device_id)

        for device_id in sorted(desired_ids):
            with _recorders_lock:
                proc = _recorders.get(device_id)
                alive = bool(proc and proc.poll() is None)
            if not alive:
                _start_recorder(device_id)

        _prune_counter += 1
        if _prune_counter >= max(1, int(3600 / RECORDER_POLL_SECONDS)):
            _prune_counter = 0
            _prune_old_recordings()
            _prune_cached_clips()

        _recorder_kick.wait(timeout=RECORDER_POLL_SECONDS)
        _recorder_kick.clear()


def start_recording_service() -> None:
    global _recorder_thread
    if _recorder_thread and _recorder_thread.is_alive():
        request_recorders_refresh()
        return
    _recorder_stop.clear()
    _recorder_kick.clear()
    _recorder_thread = threading.Thread(target=_recorders_loop, name="playback-recorders", daemon=True)
    _recorder_thread.start()


def stop_recording_service() -> None:
    global _recorder_thread
    _recorder_stop.set()
    _recorder_kick.set()
    if _recorder_thread and _recorder_thread.is_alive():
        _recorder_thread.join(timeout=5)
    _recorder_thread = None

    with _recorders_lock:
        active_ids = list(_recorders.keys())
    for device_id in active_ids:
        _stop_recorder(device_id)


def create_recording_marker(
    *,
    device_id: str,
    before_seconds: float,
    after_seconds: Optional[float],
    color: str,
    title: str,
    preset_key: Optional[str] = None,
    preset_name: Optional[str] = None,
    flow_id: Optional[str] = None,
    flow_name: Optional[str] = None,
    node_id: Optional[str] = None,
) -> Dict[str, Any]:
    trigger_at = _utc_now()
    normalized_before = max(0.0, float(before_seconds or 0))
    normalized_after = None if after_seconds is None else max(0.0, float(after_seconds or 0))
    clip_start = trigger_at - timedelta(seconds=normalized_before)
    clip_end = None
    if normalized_after is not None:
        clip_end = _clip_end_after(clip_start, trigger_at + timedelta(seconds=normalized_after))

    event = {
        "id": uuid.uuid4().hex[:12],
        "device_id": str(device_id or "").strip(),
        "title": str(title or "Recording").strip() or "Recording",
        "color": _clamp_color(color),
        "preset_name": str(preset_name or title or "Recording").strip() or "Recording",
        "preset_key": str(preset_key or "").strip() or _recording_preset_key(preset_name or title),
        "before_seconds": normalized_before,
        "after_seconds": normalized_after,
        "triggered_at": trigger_at.isoformat(),
        "clip_start": clip_start.isoformat(),
        "clip_end": clip_end.isoformat() if clip_end is not None else None,
        "flow_id": str(flow_id or "").strip() or None,
        "flow_name": str(flow_name or "").strip() or None,
        "node_id": str(node_id or "").strip() or None,
    }
    event["tag_segments"] = _event_tag_segments(event)
    if normalized_after is not None:
        event, _ = _trim_event_to_available_coverage(event)

    with _events_lock:
        items = _load_events_normalized()
        items.append(event)
        items, invalidated_clip_ids, _ = _merge_overlapping_events(items)
        _save_events(items)
        _delete_clip_cache(invalidated_clip_ids)
        merged_event = _find_matching_event(items, event)

    return merged_event or event


def stop_recording_marker(*, device_id: str) -> Dict[str, Any]:
    normalized_device_id = str(device_id or "").strip()
    if not normalized_device_id:
        raise ValueError("Recording stop action needs a device")

    stop_at = _utc_now()

    with _events_lock:
        items = _load_events_normalized()
        for index in range(len(items) - 1, -1, -1):
            event = items[index]
            if str(event.get("device_id") or "").strip() != normalized_device_id:
                continue
            if not _event_is_open(event):
                continue

            trigger_at = _parse_iso(event.get("triggered_at"))
            clip_start = _parse_iso(event.get("clip_start"))
            clip_end = _clip_end_after(clip_start, max(stop_at, trigger_at))
            event["clip_end"] = clip_end.isoformat()
            event["after_seconds"] = max(0.0, (clip_end - trigger_at).total_seconds())
            event, _ = _trim_event_to_available_coverage(event)
            items[index] = event
            items, invalidated_clip_ids, _ = _merge_overlapping_events(items)
            invalidated_clip_ids.add(str(event.get("id") or "").strip())
            _save_events(items)
            _delete_clip_cache(invalidated_clip_ids)
            return _find_matching_event(items, event) or event

    raise LookupError(f"No active recording found for device {normalized_device_id}")


def _serialize_segment(segment: RecordingSegment) -> Dict[str, Any]:
    return {
        "path": segment.path.name,
        "started_at": segment.started_at.isoformat(),
        "ended_at": segment.ended_at.isoformat(),
        "finalized": bool(segment.finalized),
    }


def _serialize_event(event: Dict[str, Any]) -> Dict[str, Any]:
    state = _event_state(event)
    return {
        "id": event.get("id"),
        "device_id": event.get("device_id"),
        "title": event.get("title") or "Recording",
        "color": _clamp_color(event.get("color")),
        "preset_key": _event_preset_key(event),
        "preset_name": _event_preset_name(event),
        "triggered_at": event.get("triggered_at"),
        "clip_start": event.get("clip_start"),
        "clip_end": event.get("clip_end"),
        "before_seconds": float(event.get("before_seconds") or 0),
        "after_seconds": float(event.get("after_seconds") or 0),
        "flow_id": event.get("flow_id"),
        "flow_name": event.get("flow_name"),
        "node_id": event.get("node_id"),
        "tag_segments": _event_tag_segments(event),
        "state": state,
        "ready": state == "ready",
    }


def _timeline_day_bounds(day_value: Optional[str]) -> Tuple[date, datetime, datetime]:
    if day_value:
        try:
            selected_day = date.fromisoformat(day_value)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid day")
    else:
        selected_day = _utc_now().date()
    start = datetime.combine(selected_day, datetime_time.min, tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    return selected_day, start, end


def _build_event_clip(event: Dict[str, Any]) -> Path:
    event_id = str(event.get("id") or "").strip()
    if not event_id:
        raise HTTPException(status_code=400, detail="Invalid recording event")

    clip_path = _clip_path_for_event(event_id)
    if clip_path.exists():
        try:
            probe = subprocess.run(
                _clip_probe_command(clip_path),
                check=True,
                capture_output=True,
                text=True,
            )
            payload = json.loads(probe.stdout or "{}")
            fmt = payload.get("format") if isinstance(payload, dict) else {}
            duration = float((fmt or {}).get("duration") or 0)
            size = int(float((fmt or {}).get("size") or 0))
            if duration > 0.05 and size > 1024:
                return clip_path
        except Exception:
            pass

        try:
            clip_path.unlink(missing_ok=True)
        except Exception:
            pass

    device_id = str(event.get("device_id") or "").strip()
    try:
        started_at, ended_at = _event_clip_bounds(event)
    except ValueError:
        raise HTTPException(status_code=400, detail="Recording event has an invalid time range")

    segments = _segments_for_range(device_id, started_at, ended_at)
    if not segments:
        raise HTTPException(status_code=404, detail="No recorded video found for this event")

    first_start = segments[0].started_at
    offset_seconds = max(0.0, (started_at - first_start).total_seconds())
    duration_seconds = max(0.1, (ended_at - started_at).total_seconds())

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, dir=PLAYBACK_CLIPS_DIR, encoding="utf-8") as manifest:
        manifest_path = Path(manifest.name)
        for segment in segments:
            manifest.write(f"file '{segment.path.as_posix()}'\n")

    temp_clip_path = clip_path.with_suffix(f".{uuid.uuid4().hex}.tmp.mp4")

    try:
        base_cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(manifest_path),
            "-ss",
            f"{offset_seconds:.3f}",
            "-t",
            f"{duration_seconds:.3f}",
            "-map",
            "0:v:0?",
            "-map",
            "0:a:0?",
        ]

        copy_cmd = [
            *base_cmd,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-avoid_negative_ts",
            "make_zero",
            str(temp_clip_path),
        ]

        transcode_cmd = [
            *base_cmd,
            "-threads",
            str(CLIP_ENCODING_THREADS),
            "-c:v",
            "libx264",
            "-preset",
            CLIP_ENCODING_PRESET,
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            str(temp_clip_path),
        ]

        last_error: Optional[subprocess.CalledProcessError] = None

        if PLAYBACK_CLIP_MODE != "transcode-only":
            try:
                subprocess.run(copy_cmd, check=True)
                temp_clip_path.replace(clip_path)
                _prune_cached_clips()
                return clip_path
            except subprocess.CalledProcessError as exc:
                last_error = exc
                try:
                    temp_clip_path.unlink(missing_ok=True)
                except Exception:
                    pass
                if PLAYBACK_CLIP_MODE == "copy-only":
                    raise HTTPException(status_code=500, detail=f"Clip generation failed: {exc}")

        try:
            subprocess.run(transcode_cmd, check=True)
            temp_clip_path.replace(clip_path)
            _prune_cached_clips()
        except subprocess.CalledProcessError as exc:
            raise HTTPException(status_code=500, detail=f"Clip generation failed: {exc if exc else last_error}")
    finally:
        try:
            manifest_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            temp_clip_path.unlink(missing_ok=True)
        except Exception:
            pass

    return clip_path


def _clear_directory_contents(root: Path) -> int:
    deleted = 0
    if not root.exists():
        return deleted

    for path in sorted(root.rglob("*"), reverse=True):
        try:
            if path.is_file() or path.is_symlink():
                path.unlink(missing_ok=True)
                deleted += 1
            elif path.is_dir():
                path.rmdir()
        except Exception:
            continue

    return deleted


def clear_all_recordings() -> Dict[str, int]:
    deleted_recording_files = 0
    deleted_clip_files = 0
    cleared_events = 0
    _recorder_pause.set()

    try:
        with _recorders_lock:
            active_ids = list(_recorders.keys())
        for device_id in active_ids:
            _stop_recorder(device_id)

        with _events_lock:
            items = _load_events_normalized()
            cleared_events = len(items)
            _save_events([])

        deleted_recording_files = _clear_directory_contents(RECORDINGS_DIR)
        deleted_clip_files = _clear_directory_contents(PLAYBACK_CLIPS_DIR)
    finally:
        _recorder_pause.clear()
        start_recording_service()
        request_recorders_refresh()

    return {
        "deleted_recording_files": deleted_recording_files,
        "deleted_clip_files": deleted_clip_files,
        "cleared_events": cleared_events,
    }


@router.get("/playback", response_class=HTMLResponse)
def playback_page() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "playback.html").read_text(encoding="utf-8"))


@router.get("/api/playback/timeline")
def playback_timeline(device_id: str = Query(..., min_length=1), day: Optional[str] = None) -> Dict[str, Any]:
    selected_day, started_at, ended_at = _timeline_day_bounds(day)
    device_id = device_id.strip()
    segments = _segments_for_range(device_id, started_at, ended_at)

    with _events_lock:
        events = []
        for item in _load_events_normalized():
            if str(item.get("device_id") or "").strip() != device_id:
                continue
            try:
                event_started_at, event_ended_at = _event_clip_bounds(item)
            except Exception:
                continue
            if event_started_at < ended_at and event_ended_at > started_at:
                events.append(_serialize_event(item))

    events.sort(key=lambda item: str(item.get("triggered_at") or ""))
    return {
        "device_id": device_id,
        "day": selected_day.isoformat(),
        "segments": [_serialize_segment(item) for item in segments],
        "events": events,
    }


@router.get("/api/playback/events/{event_id}")
def playback_event(event_id: str) -> Dict[str, Any]:
    return {"event": _serialize_event(_event_by_id(event_id))}


@router.get("/api/playback/events/{event_id}/clip")
def playback_event_clip(event_id: str):
    event = _event_by_id(event_id)
    state = _event_state(event)
    if state == "missing":
        raise HTTPException(status_code=404, detail="Recording clip is unavailable because recorded video does not cover the requested time range")
    if state != "ready":
        raise HTTPException(status_code=409, detail="Recording clip is still being finalized")
    clip_path = _build_event_clip(event)
    return FileResponse(clip_path, media_type="video/mp4", filename=clip_path.name)


@router.delete("/api/playback/recordings")
def playback_clear_recordings() -> Dict[str, Any]:
    summary = clear_all_recordings()
    return {
        "ok": True,
        **summary,
    }