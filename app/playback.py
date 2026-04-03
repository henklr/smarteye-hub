from __future__ import annotations

import json
import os
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

router = APIRouter(tags=["playback"])

_events_lock = threading.RLock()
_recorders_lock = threading.RLock()
_recorders: Dict[str, subprocess.Popen] = {}
_recorder_stop = threading.Event()
_recorder_kick = threading.Event()
_recorder_thread: Optional[threading.Thread] = None
_path_refresher: Optional[Callable[[str], Any]] = None
_prune_counter = 0


@dataclass(frozen=True)
class RecordingSegment:
    path: Path
    started_at: datetime
    ended_at: datetime


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
            )
        )
    return out


def _segments_for_range(device_id: str, started_at: datetime, ended_at: datetime) -> List[RecordingSegment]:
    return [
        segment
        for segment in _list_segments(device_id)
        if segment.started_at < ended_at and segment.ended_at > started_at
    ]


def _event_by_id(event_id: str) -> Dict[str, Any]:
    with _events_lock:
        items = _load_events()
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

    if _path_refresher is not None:
        try:
            _path_refresher(device_id)
        except Exception:
            return

    proc = subprocess.Popen(
        _recording_ffmpeg_command(device_id),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with _recorders_lock:
        _recorders[device_id] = proc


def _prune_cached_clips() -> None:
    if PLAYBACK_CLIP_CACHE_LIMIT <= 0 or not PLAYBACK_CLIPS_DIR.exists():
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
    after_seconds: float,
    color: str,
    title: str,
    flow_id: Optional[str] = None,
    flow_name: Optional[str] = None,
    node_id: Optional[str] = None,
) -> Dict[str, Any]:
    trigger_at = _utc_now()
    clip_start = trigger_at - timedelta(seconds=max(0.0, float(before_seconds or 0)))
    clip_end = trigger_at + timedelta(seconds=max(0.0, float(after_seconds or 0)))

    event = {
        "id": uuid.uuid4().hex[:12],
        "device_id": str(device_id or "").strip(),
        "title": str(title or "Recording").strip() or "Recording",
        "color": _clamp_color(color),
        "before_seconds": max(0.0, float(before_seconds or 0)),
        "after_seconds": max(0.0, float(after_seconds or 0)),
        "triggered_at": trigger_at.isoformat(),
        "clip_start": clip_start.isoformat(),
        "clip_end": clip_end.isoformat(),
        "flow_id": str(flow_id or "").strip() or None,
        "flow_name": str(flow_name or "").strip() or None,
        "node_id": str(node_id or "").strip() or None,
    }

    with _events_lock:
        items = _load_events()
        items.append(event)
        items.sort(key=lambda item: str(item.get("triggered_at") or ""))
        _save_events(items)

    return event


def _serialize_segment(segment: RecordingSegment) -> Dict[str, Any]:
    return {
        "path": segment.path.name,
        "started_at": segment.started_at.isoformat(),
        "ended_at": segment.ended_at.isoformat(),
    }


def _serialize_event(event: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": event.get("id"),
        "device_id": event.get("device_id"),
        "title": event.get("title") or "Recording",
        "color": _clamp_color(event.get("color")),
        "triggered_at": event.get("triggered_at"),
        "clip_start": event.get("clip_start"),
        "clip_end": event.get("clip_end"),
        "before_seconds": float(event.get("before_seconds") or 0),
        "after_seconds": float(event.get("after_seconds") or 0),
        "flow_id": event.get("flow_id"),
        "flow_name": event.get("flow_name"),
        "node_id": event.get("node_id"),
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
        return clip_path

    device_id = str(event.get("device_id") or "").strip()
    started_at = _parse_iso(event.get("clip_start"))
    ended_at = _parse_iso(event.get("clip_end"))
    if ended_at <= started_at:
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
            str(clip_path),
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
            str(clip_path),
        ]

        last_error: Optional[subprocess.CalledProcessError] = None

        if PLAYBACK_CLIP_MODE != "transcode-only":
            try:
                subprocess.run(copy_cmd, check=True)
                _prune_cached_clips()
                return clip_path
            except subprocess.CalledProcessError as exc:
                last_error = exc
                try:
                    clip_path.unlink(missing_ok=True)
                except Exception:
                    pass
                if PLAYBACK_CLIP_MODE == "copy-only":
                    raise HTTPException(status_code=500, detail=f"Clip generation failed: {exc}")

        try:
            subprocess.run(transcode_cmd, check=True)
            _prune_cached_clips()
        except subprocess.CalledProcessError as exc:
            raise HTTPException(status_code=500, detail=f"Clip generation failed: {exc if exc else last_error}")
    finally:
        try:
            manifest_path.unlink(missing_ok=True)
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
    stop_recording_service()
    deleted_recording_files = 0
    deleted_clip_files = 0
    cleared_events = 0

    try:
        with _events_lock:
            items = _load_events()
            cleared_events = len(items)
            _save_events([])

        deleted_recording_files = _clear_directory_contents(RECORDINGS_DIR)
        deleted_clip_files = _clear_directory_contents(PLAYBACK_CLIPS_DIR)
    finally:
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
        events = [
            _serialize_event(item)
            for item in _load_events()
            if str(item.get("device_id") or "").strip() == device_id
            and _parse_iso(item.get("clip_start")) < ended_at
            and _parse_iso(item.get("clip_end")) > started_at
        ]

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
    clip_path = _build_event_clip(event)
    return FileResponse(clip_path, media_type="video/mp4", filename=clip_path.name)


@router.delete("/api/playback/recordings")
def playback_clear_recordings() -> Dict[str, Any]:
    summary = clear_all_recordings()
    return {
        "ok": True,
        **summary,
    }