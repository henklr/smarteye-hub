"""DVR/NVR-style playback.

On-disk layout (NVMe-preferred):
  <base>/recordings/<device_id>/<YYYYMMDDTHHMMSSZ>.ts      mpegts segments
  <base>/index/<device_id>.sqlite                           segment index
  <base>/clips/<event_id>.mp4                               on-demand exports
  <base>/.recorder.lock                                     fcntl lock

`<base>` resolves to `/mnt/nvme/smarteye` if that mount exists and is writable,
else to `DATA_DIR` (/app/data). An explicit `recording_path` in settings.json
overrides the base.

Recording: one ffmpeg subprocess per camera, stream-copy the H.264 sub-stream
into segmented MPEG-TS. A cross-process fcntl lock guarantees a single recorder
owner across the HTTP/HTTPS uvicorn workers.

Indexing: a background thread polls the recordings tree, ffprobes closed segments,
and upserts rows into SQLite. The index is rebuildable from the filesystem.

Playback: a dynamic HLS playlist is generated from SQLite over any [from, to]
window; gaps become `#EXT-X-DISCONTINUITY`. Raw `.ts` segments are served
directly (byte-range via FastAPI FileResponse). Event markers remain small
JSON records; an event "clip" is just a HLS window bounded by clip_start/end,
or a single MP4 built on demand for download.
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse

_log_recording = logging.getLogger("recording")
_log_playback = logging.getLogger("playback")
_log_index = logging.getLogger("playback.index")

# ---------------------------------------------------------------------------
# Paths and configuration
# ---------------------------------------------------------------------------

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

STATIC_DIR = Path(__file__).resolve().parent / "static"
DEVICES_JSON = DATA_DIR / "devices.json"
FLOWS_JSON = DATA_DIR / "flows.json"
SETTINGS_JSON = DATA_DIR / "settings.json"

# Candidate NVMe roots checked in order. The first writable directory wins.
_NVME_CANDIDATES = [
    Path(os.getenv("NVME_BASE", "/mnt/nvme/smarteye")),
]

MEDIAMTX_RTSP_BASE = os.getenv("MEDIAMTX_RTSP_BASE", "rtsp://mediamtx:8554").rstrip("/")
RECORDING_SEGMENT_SECONDS = max(10, int(os.getenv("RECORDING_SEGMENT_SECONDS", "60") or "60"))
RECORDER_POLL_SECONDS = max(2.0, float(os.getenv("RECORDER_POLL_SECONDS", "5") or "5"))
INDEXER_POLL_SECONDS = max(1.0, float(os.getenv("INDEXER_POLL_SECONDS", "3") or "3"))
MIN_SEGMENT_BYTES = max(0, int(os.getenv("MIN_SEGMENT_BYTES", "65536") or "65536"))
SEGMENT_FINALIZE_GRACE_SECONDS = max(2.0, RECORDER_POLL_SECONDS)
READINESS_GAP_TOLERANCE_SECONDS = 0.5

# Maximum span of a single HLS playlist request. Guards the server from
# pathological ranges (e.g. from=1970..to=2099). 24h is plenty for a day view.
HLS_MAX_WINDOW_SECONDS = 24 * 3600

# Target durations we expose in the playlist header. Real durations come from
# ffprobe; this is the hint the player uses for buffering.
HLS_TARGET_DURATION = RECORDING_SEGMENT_SECONDS

PLAYBACK_CLIP_MODE = str(os.getenv("PLAYBACK_CLIP_MODE", "copy-first") or "copy-first").strip().lower()
CLIP_ENCODING_PRESET = os.getenv("PLAYBACK_CLIP_PRESET", "ultrafast")
CLIP_ENCODING_THREADS = max(1, int(os.getenv("PLAYBACK_CLIP_THREADS", "1") or "1"))
PLAYBACK_CLIP_CACHE_LIMIT = max(0, int(os.getenv("PLAYBACK_CLIP_CACHE_LIMIT", "8") or "8"))
PLAYBACK_RECORDING_SCOPE = str(os.getenv("PLAYBACK_RECORDING_SCOPE", "all") or "all").strip().lower()


def _load_settings() -> Dict[str, Any]:
    try:
        return json.loads(SETTINGS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_settings(settings: Dict[str, Any]) -> None:
    SETTINGS_JSON.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def _is_writable_dir(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".write-test-{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def _resolve_base_dir() -> Path:
    """Pick the storage root. Honors explicit `recording_path` in settings, else
    prefers NVMe, falls back to DATA_DIR."""
    settings = _load_settings()
    override = str(settings.get("recording_path") or "").strip()
    if override:
        p = Path(override)
        if _is_writable_dir(p):
            return p
        _log_recording.warning("Configured recording_path %s is not writable — ignoring", p)

    for candidate in _NVME_CANDIDATES:
        if candidate.exists() and _is_writable_dir(candidate):
            return candidate

    return DATA_DIR


def _base_dir() -> Path:
    base = _resolve_base_dir()
    base.mkdir(parents=True, exist_ok=True)
    (base / "recordings").mkdir(parents=True, exist_ok=True)
    (base / "index").mkdir(parents=True, exist_ok=True)
    (base / "clips").mkdir(parents=True, exist_ok=True)
    return base


def _recordings_root() -> Path:
    return _base_dir() / "recordings"


def _index_root() -> Path:
    return _base_dir() / "index"


def _clips_root() -> Path:
    return _base_dir() / "clips"


def _lock_path() -> Path:
    return _base_dir() / ".recorder.lock"


def _events_json_path() -> Path:
    """Recording events remain co-located with data, not on NVMe, so that user
    markers survive an NVMe swap."""
    return DATA_DIR / "recording_events.json"


def _system_tz() -> ZoneInfo:
    try:
        tz_name = _load_settings().get("timezone", "UTC") or "UTC"
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo("UTC")


def get_retention_days() -> int:
    value = _load_settings().get("retention_days", 0)
    try:
        return max(0, int(value))
    except Exception:
        return 0


def set_retention_days(days: int) -> int:
    days = max(0, int(days))
    settings = _load_settings()
    settings["retention_days"] = days
    _save_settings(settings)
    return days


_SAFE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_SEGMENT_NAME_RE = re.compile(r"^(\d{8}T\d{6})Z?\.ts$")


def _validate_id(value: str, label: str = "ID") -> str:
    value = (value or "").strip()
    if not _SAFE_ID_RE.match(value):
        raise HTTPException(status_code=400, detail=f"Invalid {label}")
    return value


def _device_recordings_dir(device_id: str) -> Path:
    device_id = _validate_id(device_id, "device_id")
    p = _recordings_root() / device_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def _parse_segment_name(name: str) -> Optional[datetime]:
    m = _SEGMENT_NAME_RE.match(name)
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_us() -> int:
    return int(_utc_now().timestamp() * 1_000_000)


def _dt_from_us(value: int) -> datetime:
    return datetime.fromtimestamp(value / 1_000_000, tz=timezone.utc)


def _us_from_dt(value: datetime) -> int:
    return int(value.timestamp() * 1_000_000)


def _parse_iso(value: Any) -> datetime:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("Missing datetime")
    return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)


def _to_local(dt_utc: datetime) -> str:
    try:
        return dt_utc.astimezone(_system_tz()).isoformat()
    except Exception:
        return dt_utc.isoformat()


# ---------------------------------------------------------------------------
# Segment record + SQLite index
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Segment:
    device_id: str
    filename: str
    started_at: datetime
    ended_at: datetime
    duration_seconds: float
    size_bytes: int
    finalized: bool
    has_audio: bool

    @property
    def path(self) -> Path:
        return _device_recordings_dir(self.device_id) / self.filename


_index_db_locks: Dict[str, threading.Lock] = {}
_index_db_locks_lock = threading.Lock()


def _index_db_path(device_id: str) -> Path:
    return _index_root() / f"{_validate_id(device_id, 'device_id')}.sqlite"


def _index_db_lock(device_id: str) -> threading.Lock:
    with _index_db_locks_lock:
        lock = _index_db_locks.get(device_id)
        if lock is None:
            lock = threading.Lock()
            _index_db_locks[device_id] = lock
        return lock


@contextmanager
def _index_connect(device_id: str):
    """Serialize writes per device via an in-process lock. SQLite's WAL mode
    permits concurrent readers."""
    path = _index_db_path(device_id)
    lock = _index_db_lock(device_id)
    lock.acquire()
    try:
        conn = sqlite3.connect(str(path), timeout=5.0, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=3000")
            _index_migrate(conn)
            yield conn
        finally:
            conn.close()
    finally:
        lock.release()


def _index_migrate(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS segments (
          filename         TEXT PRIMARY KEY,
          started_at_us    INTEGER NOT NULL,
          ended_at_us      INTEGER NOT NULL,
          duration_seconds REAL    NOT NULL,
          size_bytes       INTEGER NOT NULL,
          finalized        INTEGER NOT NULL,
          has_audio        INTEGER NOT NULL,
          indexed_at_us    INTEGER NOT NULL
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_segments_started ON segments(started_at_us)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_segments_finalized ON segments(finalized)")


def _row_to_segment(device_id: str, row: sqlite3.Row | Tuple[Any, ...]) -> Segment:
    if isinstance(row, sqlite3.Row):
        d = dict(row)
    else:
        d = {
            "filename": row[0],
            "started_at_us": row[1],
            "ended_at_us": row[2],
            "duration_seconds": row[3],
            "size_bytes": row[4],
            "finalized": row[5],
            "has_audio": row[6],
        }
    return Segment(
        device_id=device_id,
        filename=d["filename"],
        started_at=_dt_from_us(int(d["started_at_us"])),
        ended_at=_dt_from_us(int(d["ended_at_us"])),
        duration_seconds=float(d["duration_seconds"]),
        size_bytes=int(d["size_bytes"]),
        finalized=bool(d["finalized"]),
        has_audio=bool(d["has_audio"]),
    )


def _index_upsert(conn: sqlite3.Connection, seg: Segment) -> None:
    conn.execute(
        """
        INSERT INTO segments
            (filename, started_at_us, ended_at_us, duration_seconds,
             size_bytes, finalized, has_audio, indexed_at_us)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(filename) DO UPDATE SET
            started_at_us = excluded.started_at_us,
            ended_at_us = excluded.ended_at_us,
            duration_seconds = excluded.duration_seconds,
            size_bytes = excluded.size_bytes,
            finalized = excluded.finalized,
            has_audio = excluded.has_audio,
            indexed_at_us = excluded.indexed_at_us
        """,
        (
            seg.filename,
            _us_from_dt(seg.started_at),
            _us_from_dt(seg.ended_at),
            seg.duration_seconds,
            seg.size_bytes,
            1 if seg.finalized else 0,
            1 if seg.has_audio else 0,
            _utc_now_us(),
        ),
    )


def _index_delete_many(conn: sqlite3.Connection, filenames: Iterable[str]) -> int:
    names = list(filenames)
    if not names:
        return 0
    conn.executemany("DELETE FROM segments WHERE filename = ?", [(n,) for n in names])
    return len(names)


def _index_query_range(
    device_id: str, started_at: datetime, ended_at: datetime, finalized_only: bool = False
) -> List[Segment]:
    with _index_connect(device_id) as conn:
        conn.row_factory = sqlite3.Row
        where = "ended_at_us > ? AND started_at_us < ?"
        params: List[Any] = [_us_from_dt(started_at), _us_from_dt(ended_at)]
        if finalized_only:
            where += " AND finalized = 1"
        rows = conn.execute(
            f"SELECT * FROM segments WHERE {where} ORDER BY started_at_us",
            params,
        ).fetchall()
    return [_row_to_segment(device_id, r) for r in rows]


def _index_all(device_id: str) -> List[Segment]:
    with _index_connect(device_id) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM segments ORDER BY started_at_us").fetchall()
    return [_row_to_segment(device_id, r) for r in rows]


def _index_latest_started_at(device_id: str) -> Optional[datetime]:
    with _index_connect(device_id) as conn:
        row = conn.execute("SELECT MAX(started_at_us) FROM segments").fetchone()
    if not row or row[0] is None:
        return None
    return _dt_from_us(int(row[0]))


# ---------------------------------------------------------------------------
# ffprobe / segment reconciliation
# ---------------------------------------------------------------------------


def _ffprobe_segment(path: Path) -> Optional[Tuple[float, int, bool]]:
    """Return (duration_seconds, size_bytes, has_audio) for a segment, or None
    if the file is missing or unreadable."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration,size",
                "-show_entries",
                "stream=codec_type",
                "-of",
                "json",
                str(path),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return None

    try:
        data = json.loads(result.stdout or "{}")
    except Exception:
        return None

    fmt = data.get("format") or {}
    duration = float(fmt.get("duration") or 0.0)
    size = int(float(fmt.get("size") or 0))
    has_audio = any(str(s.get("codec_type") or "") == "audio" for s in (data.get("streams") or []))
    if duration <= 0.0 and size <= 0:
        return None
    return duration, size, has_audio


def _segment_from_filesystem(
    device_dir: Path, filename: str, is_tip: bool
) -> Optional[Segment]:
    started_at = _parse_segment_name(filename)
    if started_at is None:
        return None
    path = device_dir / filename
    try:
        stat = path.stat()
    except OSError:
        return None

    size_bytes = stat.st_size
    probe = _ffprobe_segment(path)
    if probe is None:
        # Un-probeable: for a tip file still being written by ffmpeg it is
        # normal during the first couple of seconds. Represent it as
        # non-finalized with a best-guess duration from wall clock.
        if is_tip:
            duration = max(0.0, _utc_now().timestamp() - started_at.timestamp())
            return Segment(
                device_id=device_dir.name,
                filename=filename,
                started_at=started_at,
                ended_at=started_at + timedelta(seconds=duration),
                duration_seconds=duration,
                size_bytes=size_bytes,
                finalized=False,
                has_audio=False,
            )
        return None

    duration, probed_size, has_audio = probe
    size_bytes = probed_size or size_bytes
    finalized = not is_tip and size_bytes >= MIN_SEGMENT_BYTES

    return Segment(
        device_id=device_dir.name,
        filename=filename,
        started_at=started_at,
        ended_at=started_at + timedelta(seconds=max(duration, 0.0)),
        duration_seconds=duration,
        size_bytes=size_bytes,
        finalized=finalized,
        has_audio=has_audio,
    )


def reconcile_device_index(device_id: str) -> Dict[str, int]:
    """Walk the filesystem and sync the SQLite index for `device_id`.

    - Add rows for segments on disk but not in the index.
    - Remove rows whose file disappeared.
    - Re-probe segments whose file size changed since last indexing (handles
      a segment that was open last time we saw it).
    """
    device_dir = _device_recordings_dir(device_id)
    disk_files = sorted(
        [p.name for p in device_dir.iterdir() if p.is_file() and p.suffix == ".ts" and _parse_segment_name(p.name)]
    )
    tip = disk_files[-1] if disk_files else None

    added = 0
    updated = 0
    removed = 0
    skipped_corrupt = 0

    with _index_connect(device_id) as conn:
        conn.row_factory = sqlite3.Row
        existing_rows = {
            row["filename"]: row
            for row in conn.execute(
                "SELECT filename, size_bytes, finalized FROM segments"
            ).fetchall()
        }

        missing_from_disk = [name for name in existing_rows if name not in disk_files]
        removed = _index_delete_many(conn, missing_from_disk)

        for name in disk_files:
            path = device_dir / name
            try:
                stat = path.stat()
            except OSError:
                continue

            row = existing_rows.get(name)
            is_tip = name == tip
            needs_reprobe = True
            if row is not None and bool(row["finalized"]) and int(row["size_bytes"]) == stat.st_size and not is_tip:
                needs_reprobe = False

            if not needs_reprobe:
                continue

            seg = _segment_from_filesystem(device_dir, name, is_tip=is_tip)
            if seg is None:
                # Corrupt, too-small, or just-created. For a very small non-tip
                # segment we drop the file entirely so it never pollutes HLS.
                if not is_tip and stat.st_size < MIN_SEGMENT_BYTES:
                    try:
                        path.unlink(missing_ok=True)
                        _log_index.info(
                            "Dropped undersized segment %s/%s (%d bytes)",
                            device_id, name, stat.st_size,
                        )
                        if row is not None:
                            _index_delete_many(conn, [name])
                            removed += 1
                    except Exception:
                        pass
                skipped_corrupt += 1
                continue

            _index_upsert(conn, seg)
            if row is None:
                added += 1
            else:
                updated += 1

    if added or updated or removed or skipped_corrupt:
        _log_index.info(
            "Reconciled %s: +%d ~%d -%d skip=%d",
            device_id, added, updated, removed, skipped_corrupt,
        )
    return {"added": added, "updated": updated, "removed": removed, "corrupt": skipped_corrupt}


# ---------------------------------------------------------------------------
# Event records (user-facing markers)
# ---------------------------------------------------------------------------

_events_lock = threading.RLock()


def _load_events() -> List[Dict[str, Any]]:
    try:
        payload = json.loads(_events_json_path().read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict)]


def _save_events(items: List[Dict[str, Any]]) -> None:
    _events_json_path().write_text(json.dumps(items, indent=2), encoding="utf-8")


def _event_is_open(event: Dict[str, Any]) -> bool:
    try:
        _parse_iso(event.get("clip_end"))
    except Exception:
        return True
    return False


def _clip_end_after(started_at: datetime, ended_at: datetime) -> datetime:
    minimum_end = started_at + timedelta(milliseconds=100)
    return ended_at if ended_at > minimum_end else minimum_end


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


def _event_trigger_at(event: Dict[str, Any], fallback: datetime) -> datetime:
    try:
        return _parse_iso(event.get("triggered_at"))
    except Exception:
        return fallback


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


def _normalize_tag_segment(
    segment: Dict[str, Any], event: Optional[Dict[str, Any]] = None
) -> Optional[Dict[str, Any]]:
    if not isinstance(segment, dict):
        return None
    source = event if isinstance(event, dict) else {}
    preset_name = str(
        segment.get("preset_name") or source.get("preset_name") or source.get("title") or "Recording"
    ).strip() or "Recording"
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


def _event_tag_segments(event: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw_segments = event.get("tag_segments") if isinstance(event.get("tag_segments"), list) else None
    collected: List[Dict[str, Any]] = []
    if raw_segments:
        for seg in raw_segments:
            norm = _normalize_tag_segment(seg, event)
            if norm is not None:
                collected.append(norm)
    if collected:
        return _merge_tag_segments(collected)
    fallback = _normalize_tag_segment({}, event)
    return [fallback] if fallback is not None else []


def _merge_tag_segments(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    segments = [s for s in segments if s]
    segments.sort(
        key=lambda item: (
            str(item.get("preset_key") or ""),
            str(item.get("color") or ""),
            str(item.get("clip_start") or ""),
        )
    )
    merged: List[Dict[str, Any]] = []
    for item in segments:
        if not merged:
            merged.append(dict(item))
            continue
        prev = merged[-1]
        same = (
            str(prev.get("preset_key") or "") == str(item.get("preset_key") or "")
            and str(prev.get("color") or "") == str(item.get("color") or "")
        )
        if not same:
            merged.append(dict(item))
            continue
        prev_start = _parse_iso(prev["clip_start"])
        prev_end = _parse_iso(prev["clip_end"])
        item_start = _parse_iso(item["clip_start"])
        item_end = _parse_iso(item["clip_end"])
        if item_start > prev_end:
            merged.append(dict(item))
            continue
        prev["clip_start"] = min(prev_start, item_start).isoformat()
        prev["clip_end"] = max(prev_end, item_end).isoformat()
        prev["triggered_at"] = min(
            _parse_iso(prev["triggered_at"]),
            _parse_iso(item["triggered_at"]),
        ).isoformat()
    return merged


def _continuous_coverage(
    segments: List[Segment], started_at: datetime, ended_at: datetime
) -> Optional[Tuple[datetime, datetime]]:
    overlaps: List[Tuple[datetime, datetime]] = []
    for seg in sorted(segments, key=lambda s: s.started_at):
        overlap_start = max(seg.started_at, started_at)
        overlap_end = min(seg.ended_at, ended_at)
        if overlap_end > overlap_start:
            overlaps.append((overlap_start, overlap_end))
    if not overlaps:
        return None
    tolerance = timedelta(seconds=READINESS_GAP_TOLERANCE_SECONDS)
    cov_start, cov_end = overlaps[0]
    for start, end in overlaps[1:]:
        if start > cov_end + tolerance:
            break
        cov_end = max(cov_end, end)
        if cov_end >= ended_at - tolerance:
            break
    return cov_start, min(cov_end, ended_at)


def _segments_cover(segments: List[Segment], started_at: datetime, ended_at: datetime) -> bool:
    coverage = _continuous_coverage(segments, started_at, ended_at)
    if coverage is None:
        return False
    tolerance = timedelta(seconds=READINESS_GAP_TOLERANCE_SECONDS)
    return coverage[0] <= started_at + tolerance and coverage[1] >= ended_at - tolerance


def _trim_event_to_coverage(event: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
    if _event_is_open(event):
        return dict(event), False
    try:
        started_at, ended_at = _event_clip_bounds(event)
    except Exception:
        return dict(event), False
    device_id = str(event.get("device_id") or "").strip()
    if not device_id:
        return dict(event), False

    segments = _index_query_range(device_id, started_at, ended_at)
    coverage = _continuous_coverage(segments, started_at, ended_at)
    if coverage is None:
        return dict(event), False
    cov_start, cov_end = coverage
    tolerance = timedelta(seconds=READINESS_GAP_TOLERANCE_SECONDS)
    if cov_start <= started_at + tolerance and cov_end >= ended_at - tolerance:
        return dict(event), False

    updated = dict(event)
    updated["clip_start"] = cov_start.isoformat()
    updated["clip_end"] = cov_end.isoformat()
    trigger_at = _event_trigger_at(event, cov_start)
    updated["before_seconds"] = max(0.0, (trigger_at - cov_start).total_seconds())
    updated["after_seconds"] = max(0.0, (cov_end - trigger_at).total_seconds())
    trimmed_segments: List[Dict[str, Any]] = []
    for seg in _event_tag_segments(event):
        ss = _parse_iso(seg["clip_start"])
        se = _parse_iso(seg["clip_end"])
        ts = max(ss, cov_start)
        te = min(se, cov_end)
        if te > ts:
            s = dict(seg)
            s["clip_start"] = ts.isoformat()
            s["clip_end"] = te.isoformat()
            trimmed_segments.append(s)
    updated["tag_segments"] = _merge_tag_segments(trimmed_segments)
    return updated, True


def _ranges_overlap(
    a_start: datetime,
    a_end: Optional[datetime],
    b_start: datetime,
    b_end: Optional[datetime],
) -> bool:
    if a_end is None:
        return b_end is None or b_end > a_start
    if b_end is None:
        return a_end > b_start
    return a_start < b_end and b_start < a_end


def _merge_event_records(primary: Dict[str, Any], secondary: Dict[str, Any]) -> Dict[str, Any]:
    p_start, p_end = _event_compare_bounds(primary)
    s_start, s_end = _event_compare_bounds(secondary)
    p_trig = _event_trigger_at(primary, p_start)
    s_trig = _event_trigger_at(secondary, s_start)
    merged_start = min(p_start, s_start)
    merged_trig = min(p_trig, s_trig)
    merged_end = None if p_end is None or s_end is None else max(p_end, s_end)

    def _merge_str(a: Any, b: Any) -> str:
        a_s, b_s = str(a or "").strip(), str(b or "").strip()
        if a_s and a_s.lower() != "recording":
            return a_s
        if b_s and b_s.lower() != "recording":
            return b_s
        return a_s or b_s or "Recording"

    merged = dict(primary)
    merged["clip_start"] = merged_start.isoformat()
    merged["triggered_at"] = merged_trig.isoformat()
    merged["clip_end"] = merged_end.isoformat() if merged_end is not None else None
    merged["before_seconds"] = max(0.0, (merged_trig - merged_start).total_seconds())
    merged["after_seconds"] = None if merged_end is None else max(0.0, (merged_end - merged_trig).total_seconds())
    merged["title"] = _merge_str(primary.get("title"), secondary.get("title"))
    merged["color"] = _clamp_color(primary.get("color") if _clamp_color(primary.get("color")) != "#c6a14b" else secondary.get("color"))
    merged["preset_name"] = _merge_str(_event_preset_name(primary), _event_preset_name(secondary))
    merged["preset_key"] = _recording_preset_key(merged["preset_name"])
    merged["tag_segments"] = _merge_tag_segments([*_event_tag_segments(primary), *_event_tag_segments(secondary)])
    merged["flow_id"] = primary.get("flow_id") or secondary.get("flow_id") or None
    merged["flow_name"] = primary.get("flow_name") or secondary.get("flow_name") or None
    merged["node_id"] = primary.get("node_id") or secondary.get("node_id") or None
    return merged


def _merge_overlapping_events(items: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], set[str], bool]:
    passthrough: List[Dict[str, Any]] = []
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    invalidated: set[str] = set()
    changed = False
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

    merged: List[Dict[str, Any]] = []
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
            c_start, c_end = _event_compare_bounds(current)
            i_start, i_end = _event_compare_bounds(item)
            if (
                c_end is not None
                and i_end is not None
                and _ranges_overlap(c_start, c_end, i_start, i_end)
            ):
                for ev in (current, item):
                    eid = str(ev.get("id") or "").strip()
                    if eid:
                        invalidated.add(eid)
                current = _merge_event_records(current, item)
                changed = True
                continue
            merged.append(current)
            current = item
        merged.append(current)

    out = [*passthrough, *merged]
    out.sort(
        key=lambda item: (
            str(item.get("device_id") or ""),
            str(item.get("triggered_at") or item.get("clip_start") or ""),
            str(item.get("id") or ""),
        )
    )
    if len(out) != len(items) or any(l != r for l, r in zip(out, items)):
        changed = True
    return out, invalidated, changed


def _delete_clip_cache(event_ids: Iterable[str]) -> None:
    for eid in {str(i or "").strip() for i in event_ids if str(i or "").strip()}:
        try:
            (_clips_root() / f"{eid}.mp4").unlink(missing_ok=True)
        except Exception:
            pass


def _load_events_normalized() -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    changed = False
    for item in _load_events():
        normalized, item_changed = _trim_event_to_coverage(item)
        items.append(normalized)
        if item_changed:
            changed = True
    merged_items, invalidated, merge_changed = _merge_overlapping_events(items)
    if changed or merge_changed:
        _save_events(merged_items)
        _delete_clip_cache(invalidated)
    return merged_items


def _find_matching_event(items: List[Dict[str, Any]], probe: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    probe_id = str(probe.get("id") or "").strip()
    if probe_id:
        exact = next((i for i in items if str(i.get("id") or "").strip() == probe_id), None)
        if exact is not None:
            return exact
    device_id = str(probe.get("device_id") or "").strip()
    if not device_id:
        return None
    try:
        p_start, p_end = _event_compare_bounds(probe)
    except Exception:
        return None
    for item in items:
        if str(item.get("device_id") or "").strip() != device_id:
            continue
        i_start, i_end = _event_compare_bounds(item)
        if _ranges_overlap(i_start, i_end, p_start, p_end):
            return item
    return None


def _event_state(event: Dict[str, Any]) -> str:
    if _event_is_open(event):
        return "recording"
    try:
        started_at, ended_at = _event_clip_bounds(event)
    except Exception:
        return "finalizing"
    if ended_at > _utc_now():
        return "recording"
    device_id = str(event.get("device_id") or "").strip()
    segments = _index_query_range(device_id, started_at, ended_at)
    if not _segments_cover(segments, started_at, ended_at):
        missing_grace = timedelta(seconds=max(SEGMENT_FINALIZE_GRACE_SECONDS, RECORDER_POLL_SECONDS))
        if _utc_now() >= ended_at + missing_grace:
            return "missing"
        return "finalizing"
    finalized = [s for s in segments if s.finalized]
    if _segments_cover(finalized, started_at, ended_at):
        return "ready"
    return "finalizing"


def _event_by_id(event_id: str) -> Dict[str, Any]:
    with _events_lock:
        items = _load_events()
    event = next((i for i in items if str(i.get("id")) == event_id), None)
    if event is None:
        raise HTTPException(status_code=404, detail="Recording event not found")
    return event


def _serialize_event(event: Dict[str, Any]) -> Dict[str, Any]:
    state = _event_state(event)
    local_tags: List[Dict[str, Any]] = []
    for tag in _event_tag_segments(event):
        t = dict(tag)
        for k in ("clip_start", "clip_end", "triggered_at"):
            if t.get(k):
                try:
                    t[k] = _to_local(_parse_iso(t[k]))
                except Exception:
                    pass
        local_tags.append(t)
    return {
        "id": event.get("id"),
        "device_id": event.get("device_id"),
        "title": event.get("title") or "Recording",
        "color": _clamp_color(event.get("color")),
        "preset_key": _event_preset_key(event),
        "preset_name": _event_preset_name(event),
        "triggered_at": _to_local(_parse_iso(event.get("triggered_at"))) if event.get("triggered_at") else None,
        "clip_start": _to_local(_parse_iso(event.get("clip_start"))) if event.get("clip_start") else None,
        "clip_end": _to_local(_parse_iso(event.get("clip_end"))) if event.get("clip_end") else None,
        "before_seconds": float(event.get("before_seconds") or 0),
        "after_seconds": float(event.get("after_seconds") or 0),
        "flow_id": event.get("flow_id"),
        "flow_name": event.get("flow_name"),
        "node_id": event.get("node_id"),
        "tag_segments": local_tags,
        "state": state,
        "ready": state == "ready",
    }


def _serialize_segment(seg: Segment) -> Dict[str, Any]:
    return {
        "path": seg.filename,
        "started_at": _to_local(seg.started_at),
        "ended_at": _to_local(seg.ended_at),
        "duration_seconds": seg.duration_seconds,
        "size_bytes": seg.size_bytes,
        "finalized": seg.finalized,
        "has_audio": seg.has_audio,
    }


# ---------------------------------------------------------------------------
# Devices / flow inspection
# ---------------------------------------------------------------------------


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


def _load_flows() -> List[Dict[str, Any]]:
    try:
        payload = json.loads(FLOWS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return []
    items = payload.get("items") if isinstance(payload, dict) else []
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _recording_device_ids_from_flows() -> set[str]:
    ids: set[str] = set()
    for flow in _load_flows():
        if not bool(flow.get("enabled", True)):
            continue
        for node in flow.get("nodes") or []:
            if not isinstance(node, dict) or str(node.get("type") or "") != "action.record":
                continue
            cfg = node.get("config") if isinstance(node.get("config"), dict) else {}
            device_id = str(cfg.get("device_id") or "").strip()
            if device_id:
                ids.add(device_id)
    return ids


def _desired_recorder_ids(devices: List[Dict[str, Any]]) -> set[str]:
    configured = {
        str(d.get("id") or "").strip()
        for d in devices
        if str(d.get("profile_token") or "").strip()
    }
    configured.discard("")
    if PLAYBACK_RECORDING_SCOPE == "all":
        return configured
    return configured & _recording_device_ids_from_flows()


def _recording_source_url(device_id: str) -> str:
    """Return the RTSP URL the recorder should pull from for this device.

    Pulls *directly* from the camera (using `recording_rtsp_url` populated by
    `_refresh_device_stream`) so MediaMTX is not in the recording path. That
    cuts MediaMTX's CPU/RTP-handling load roughly proportionally to the
    main-stream bitrate and stops upstream RTP fragmentation losses from
    corrupting recorded segments.

    Falls back to the MediaMTX live path if the direct URL hasn't been
    populated yet (legacy device records from before this change).

    Note: the recording profile determines the stored codec. H.264 plays in
    any browser. HEVC profiles record fine but Chrome/Firefox can't decode
    them in the playback UI.
    """
    device_id = _validate_id(device_id, "device_id")
    devices = _load_devices()
    device = next((d for d in devices if str(d.get("id") or "").strip() == device_id), None)
    if device:
        url = str(device.get("recording_rtsp_url") or "").strip()
        if url.startswith("rtsp://"):
            return url
    return f"{MEDIAMTX_RTSP_BASE}/cam-{device_id}"


def _ffmpeg_command(device_id: str) -> List[str]:
    source = _recording_source_url(device_id)
    pattern = str(_device_recordings_dir(device_id) / "%Y%m%dT%H%M%SZ.ts")
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
        "0:a:0?",
        # Copy H.264 video. Transcode audio to AAC because MSE/hls.js cannot
        # play PCM/G.711 that ONVIF sub-streams usually carry — without AAC,
        # playback errors out as soon as the audio track appears.
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-ac",
        "1",
        "-f",
        "segment",
        "-segment_format",
        "mpegts",
        "-segment_time",
        str(RECORDING_SEGMENT_SECONDS),
        "-segment_atclocktime",
        "1",
        "-reset_timestamps",
        "1",
        "-strftime",
        "1",
        pattern,
    ]


# ---------------------------------------------------------------------------
# Recorder lifecycle (fcntl lock + per-device subprocess + indexer)
# ---------------------------------------------------------------------------

_recorders_lock = threading.RLock()
_recorders: Dict[str, subprocess.Popen] = {}
_recorder_sources: Dict[str, str] = {}
_recorder_stop = threading.Event()
_recorder_kick = threading.Event()
_recorder_pause = threading.Event()
_recorder_thread: Optional[threading.Thread] = None
_indexer_thread: Optional[threading.Thread] = None
_indexer_stop = threading.Event()
_path_refresher: Optional[Callable[[str], Any]] = None
_recorder_lock_fd: Optional[int] = None


def _try_acquire_recorder_lock() -> bool:
    """Grab an exclusive fcntl lock on the recorder lock file. Returns True if
    this process becomes the active recorder, False if another uvicorn worker
    already holds the lock."""
    global _recorder_lock_fd
    if _recorder_lock_fd is not None:
        return True
    lock_path = _lock_path()
    fd = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return False
    os.ftruncate(fd, 0)
    os.write(fd, f"{os.getpid()}\n".encode())
    _recorder_lock_fd = fd
    return True


def _release_recorder_lock() -> None:
    global _recorder_lock_fd
    if _recorder_lock_fd is None:
        return
    try:
        fcntl.flock(_recorder_lock_fd, fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        os.close(_recorder_lock_fd)
    except OSError:
        pass
    _recorder_lock_fd = None


def set_recording_path_refresher(callback: Optional[Callable[[str], Any]]) -> None:
    global _path_refresher
    _path_refresher = callback


def request_recorders_refresh() -> None:
    _recorder_kick.set()


def _stop_recorder(device_id: str) -> None:
    with _recorders_lock:
        proc = _recorders.pop(device_id, None)
        _recorder_sources.pop(device_id, None)
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=5)
        _log_recording.info("Stopped ffmpeg recorder for %s", device_id)
    except Exception:
        _log_recording.warning("Killing recorder for %s", device_id)
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
    source = _recording_source_url(device_id)
    proc = subprocess.Popen(
        _ffmpeg_command(device_id),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "TZ": "UTC"},
    )
    _log_recording.info("Started ffmpeg recorder for %s (pid=%d) source=%s", device_id, proc.pid, source)
    with _recorders_lock:
        _recorders[device_id] = proc
        _recorder_sources[device_id] = source


def _prune_old_recordings() -> None:
    days = get_retention_days()
    if days <= 0:
        return
    cutoff_us = _us_from_dt(_utc_now() - timedelta(days=days))
    rec_root = _recordings_root()
    if not rec_root.exists():
        return
    for device_dir in rec_root.iterdir():
        if not device_dir.is_dir():
            continue
        device_id = device_dir.name
        if not _SAFE_ID_RE.match(device_id):
            continue
        try:
            with _index_connect(device_id) as conn:
                rows = conn.execute(
                    "SELECT filename FROM segments WHERE started_at_us < ?",
                    (cutoff_us,),
                ).fetchall()
                names = [r[0] for r in rows]
                _index_delete_many(conn, names)
        except Exception:
            names = []
        for name in names:
            try:
                (device_dir / name).unlink(missing_ok=True)
            except Exception:
                pass
        # Also sweep on-disk orphans not in the index (defensive).
        for path in device_dir.iterdir():
            if not path.is_file() or path.suffix != ".ts":
                continue
            started_at = _parse_segment_name(path.name)
            if started_at is None:
                continue
            if _us_from_dt(started_at) < cutoff_us:
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass


def _prune_cached_clips() -> None:
    clips = _clips_root()
    if not clips.exists():
        return
    with _events_lock:
        active = {
            str(e.get("id") or "").strip()
            for e in _load_events()
            if str(e.get("id") or "").strip()
        }
    for path in clips.glob("*.mp4"):
        if path.stem not in active:
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass
    if PLAYBACK_CLIP_CACHE_LIMIT <= 0:
        return
    live = sorted(
        (p for p in clips.glob("*.mp4") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for p in live[PLAYBACK_CLIP_CACHE_LIMIT:]:
        try:
            p.unlink(missing_ok=True)
        except Exception:
            pass


def _recorders_loop() -> None:
    prune_counter = 0
    prune_every = max(1, int(3600 / RECORDER_POLL_SECONDS))
    while not _recorder_stop.is_set():
        if _recorder_pause.is_set():
            _recorder_kick.wait(timeout=RECORDER_POLL_SECONDS)
            _recorder_kick.clear()
            continue

        if not _try_acquire_recorder_lock():
            # Another worker owns the recording role. Sleep and keep trying.
            _log_recording.debug("Recorder lock held by another process; skipping cycle")
            _recorder_kick.wait(timeout=RECORDER_POLL_SECONDS)
            _recorder_kick.clear()
            continue

        devices = _load_devices()
        desired = _desired_recorder_ids(devices)
        with _recorders_lock:
            active = set(_recorders.keys())
        for device_id in sorted(active - desired):
            _stop_recorder(device_id)
        for device_id in sorted(desired):
            with _recorders_lock:
                proc = _recorders.get(device_id)
                alive = bool(proc and proc.poll() is None)
                current_src = _recorder_sources.get(device_id)
            new_src = _recording_source_url(device_id)
            if alive and current_src and current_src != new_src:
                _log_recording.info(
                    "Recorder source changed for %s; restarting (%s -> %s)",
                    device_id, current_src, new_src,
                )
                _stop_recorder(device_id)
                alive = False
            if not alive:
                _start_recorder(device_id)

        prune_counter += 1
        if prune_counter >= prune_every:
            prune_counter = 0
            try:
                _prune_old_recordings()
                _prune_cached_clips()
            except Exception as exc:
                _log_recording.warning("Prune cycle failed: %s", exc)

        _recorder_kick.wait(timeout=RECORDER_POLL_SECONDS)
        _recorder_kick.clear()

    # Shutting down.
    with _recorders_lock:
        ids = list(_recorders.keys())
    for device_id in ids:
        _stop_recorder(device_id)
    _release_recorder_lock()


def _indexer_loop() -> None:
    """Reconcile each configured device's SQLite index with the filesystem."""
    startup_reconciled = False
    while not _indexer_stop.is_set():
        try:
            rec_root = _recordings_root()
            device_ids: List[str] = []
            if rec_root.exists():
                for child in rec_root.iterdir():
                    if child.is_dir() and _SAFE_ID_RE.match(child.name):
                        device_ids.append(child.name)

            if not startup_reconciled:
                _log_index.info("Startup reconciliation over %d device(s)", len(device_ids))
                startup_reconciled = True

            for device_id in device_ids:
                try:
                    reconcile_device_index(device_id)
                except Exception as exc:
                    _log_index.warning("Reconcile failed for %s: %s", device_id, exc)
        except Exception as exc:
            _log_index.warning("Indexer cycle failed: %s", exc)

        _indexer_stop.wait(timeout=INDEXER_POLL_SECONDS)


def start_recording_service() -> None:
    global _recorder_thread, _indexer_thread
    if _recorder_thread and _recorder_thread.is_alive():
        request_recorders_refresh()
        return
    _recorder_stop.clear()
    _recorder_kick.clear()
    _recorder_thread = threading.Thread(
        target=_recorders_loop, name="playback-recorders", daemon=True
    )
    _recorder_thread.start()

    if not _indexer_thread or not _indexer_thread.is_alive():
        _indexer_stop.clear()
        _indexer_thread = threading.Thread(
            target=_indexer_loop, name="playback-indexer", daemon=True
        )
        _indexer_thread.start()


_load_snapshot_lock = threading.Lock()


def _read_proc_cpu_jiffies(pid: int) -> Optional[int]:
    try:
        with open(f"/proc/{pid}/stat", "r") as fh:
            data = fh.read()
    except Exception:
        return None
    # field 14 = utime, 15 = stime; comm field can contain spaces wrapped in ().
    rparen = data.rfind(")")
    if rparen < 0:
        return None
    fields = data[rparen + 2:].split()
    try:
        return int(fields[11]) + int(fields[12])
    except (IndexError, ValueError):
        return None


def _scan_recorder_pids() -> Dict[str, int]:
    """Map device_id -> ffmpeg pid by scanning /proc.

    The recorder lock guarantees only one uvicorn worker spawns ffmpeg
    subprocesses, but every worker shares the container's PID namespace, so
    any worker can find the recorders this way. That's important for the
    load endpoint, which must work whichever worker handles the request.
    """
    out: Dict[str, int] = {}
    rec_root = str(_recordings_root().resolve()) + "/"
    try:
        entries = os.listdir("/proc")
    except Exception:
        return out
    for name in entries:
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            with open(f"/proc/{pid}/comm", "r") as fh:
                comm = fh.read().strip()
        except Exception:
            continue
        if comm != "ffmpeg":
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                cmdline = fh.read().decode("utf-8", errors="replace")
        except Exception:
            continue
        # cmdline is NUL-separated; segment output path is the last arg
        # and contains the device id as the parent directory.
        for arg in cmdline.split("\x00"):
            if not arg.startswith(rec_root):
                continue
            tail = arg[len(rec_root):]
            did = tail.split("/", 1)[0]
            if did and _SAFE_ID_RE.match(did):
                out[did] = pid
                break
    return out


def _sample_recorder_metrics(
    device_pids: Dict[str, int],
    sleep_seconds: float = 0.4,
) -> Dict[str, Dict[str, Optional[float]]]:
    """Self-contained two-phase sample of CPU% and recording bitrate.

    Reads jiffies + latest segment size for every alive recorder, sleeps,
    reads again, and returns concrete deltas. This avoids relying on a
    cross-worker cache — every call is its own baseline.
    """
    try:
        clk = os.sysconf("SC_CLK_TCK")
    except (ValueError, OSError):
        clk = 100

    def latest_segment(did: str) -> Optional[Path]:
        try:
            recdir = _device_recordings_dir(did)
            files = sorted(recdir.glob("*.ts"), key=lambda p: p.stat().st_mtime)
            return files[-1] if files else None
        except Exception:
            return None

    first_jiffies: Dict[str, Optional[int]] = {}
    first_size: Dict[str, Optional[int]] = {}
    first_seg_name: Dict[str, Optional[str]] = {}
    for did, pid in device_pids.items():
        first_jiffies[did] = _read_proc_cpu_jiffies(pid)
        seg = latest_segment(did)
        if seg is not None:
            try:
                first_size[did] = seg.stat().st_size
                first_seg_name[did] = seg.name
            except Exception:
                first_size[did] = None
                first_seg_name[did] = None
        else:
            first_size[did] = None
            first_seg_name[did] = None

    t0 = time.monotonic()
    time.sleep(max(0.05, sleep_seconds))
    elapsed = max(0.05, time.monotonic() - t0)

    out: Dict[str, Dict[str, Optional[float]]] = {}
    for did, pid in device_pids.items():
        cpu_pct: Optional[float] = None
        j2 = _read_proc_cpu_jiffies(pid)
        j1 = first_jiffies.get(did)
        if j1 is not None and j2 is not None and j2 >= j1:
            cpu_seconds = (j2 - j1) / clk
            cpu_pct = 100.0 * cpu_seconds / elapsed

        mbps: Optional[float] = None
        seg = latest_segment(did)
        if seg is not None:
            try:
                size2 = seg.stat().st_size
            except Exception:
                size2 = None
            size1 = first_size.get(did)
            seg_name1 = first_seg_name.get(did)
            if size2 is not None:
                if seg_name1 == seg.name and size1 is not None:
                    delta_bytes = max(0, size2 - size1)
                else:
                    # rotated to a new segment mid-window — treat the new
                    # file's size as bytes-since-rotation.
                    delta_bytes = size2
                mbps = (delta_bytes * 8.0) / 1_000_000.0 / elapsed

        out[did] = {"cpu_pct": cpu_pct, "mbps": mbps}
    return out


def system_load_snapshot() -> Dict[str, Any]:
    with _load_snapshot_lock:
        cpu_count = os.cpu_count() or 1
        load_1 = load_5 = load_15 = 0.0
        try:
            load_1, load_5, load_15 = os.getloadavg()
        except (OSError, AttributeError):
            try:
                with open("/proc/loadavg", "r") as fh:
                    parts = fh.read().split()
                load_1 = float(parts[0])
                load_5 = float(parts[1])
                load_15 = float(parts[2])
            except Exception:
                pass

        mem_total_kb = 0
        mem_available_kb = 0
        try:
            with open("/proc/meminfo", "r") as fh:
                for line in fh:
                    if line.startswith("MemTotal:"):
                        mem_total_kb = int(line.split()[1])
                    elif line.startswith("MemAvailable:"):
                        mem_available_kb = int(line.split()[1])
                    if mem_total_kb and mem_available_kb:
                        break
        except Exception:
            pass

        devices = _load_devices()
        scanned_pids = _scan_recorder_pids()
        with _recorders_lock:
            local_pids = {
                did: proc.pid
                for did, proc in _recorders.items()
                if proc and proc.poll() is None
            }
        device_pids: Dict[str, int] = {}
        for d in devices:
            did = str(d.get("id") or "").strip()
            if not did:
                continue
            pid = local_pids.get(did) or scanned_pids.get(did)
            if pid is not None:
                device_pids[did] = pid

        metrics = _sample_recorder_metrics(device_pids) if device_pids else {}

        cameras: List[Dict[str, Any]] = []
        for d in devices:
            did = str(d.get("id") or "").strip()
            if not did:
                continue
            pid = device_pids.get(did)
            alive = pid is not None
            sample = metrics.get(did) or {}
            cameras.append({
                "device_id": did,
                "name": str(d.get("name") or did),
                "recorder_alive": alive,
                "recorder_pid": pid,
                "recorder_cpu_pct": sample.get("cpu_pct") if alive else None,
                "recording_mbps": sample.get("mbps") if alive else None,
            })
        cameras.sort(key=lambda c: (-(c.get("recorder_cpu_pct") or 0), c["name"]))

        return {
            "cpu_count": cpu_count,
            "load": {"1m": load_1, "5m": load_5, "15m": load_15},
            "load_pct_1m": (load_1 / cpu_count) if cpu_count else 0.0,
            "memory": {
                "total_kb": mem_total_kb,
                "available_kb": mem_available_kb,
                "used_pct": (
                    (1 - mem_available_kb / mem_total_kb) if mem_total_kb else 0.0
                ),
            },
            "cameras": cameras,
        }


def stop_recording_service() -> None:
    global _recorder_thread, _indexer_thread
    _recorder_stop.set()
    _indexer_stop.set()
    _recorder_kick.set()
    if _recorder_thread and _recorder_thread.is_alive():
        _recorder_thread.join(timeout=5)
    _recorder_thread = None
    if _indexer_thread and _indexer_thread.is_alive():
        _indexer_thread.join(timeout=5)
    _indexer_thread = None
    with _recorders_lock:
        ids = list(_recorders.keys())
    for device_id in ids:
        _stop_recorder(device_id)
    _release_recorder_lock()


# ---------------------------------------------------------------------------
# Event marker creation (flows call these)
# ---------------------------------------------------------------------------


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
    before = max(0.0, float(before_seconds or 0))
    after = None if after_seconds is None else max(0.0, float(after_seconds or 0))
    clip_start = trigger_at - timedelta(seconds=before)
    clip_end = None if after is None else _clip_end_after(clip_start, trigger_at + timedelta(seconds=after))
    event = {
        "id": uuid.uuid4().hex[:12],
        "device_id": str(device_id or "").strip(),
        "title": str(title or "Recording").strip() or "Recording",
        "color": _clamp_color(color),
        "preset_name": str(preset_name or title or "Recording").strip() or "Recording",
        "preset_key": str(preset_key or "").strip() or _recording_preset_key(preset_name or title),
        "before_seconds": before,
        "after_seconds": after,
        "triggered_at": trigger_at.isoformat(),
        "clip_start": clip_start.isoformat(),
        "clip_end": clip_end.isoformat() if clip_end is not None else None,
        "flow_id": str(flow_id or "").strip() or None,
        "flow_name": str(flow_name or "").strip() or None,
        "node_id": str(node_id or "").strip() or None,
    }
    event["tag_segments"] = _event_tag_segments(event)
    if after is not None:
        event, _ = _trim_event_to_coverage(event)

    with _events_lock:
        items = _load_events_normalized()
        items.append(event)
        items, invalidated, _ = _merge_overlapping_events(items)
        _save_events(items)
        _delete_clip_cache(invalidated)
        final = _find_matching_event(items, event) or event
    _log_recording.info(
        "Recording marker created: device=%s id=%s title=%s",
        final.get("device_id"), final.get("id"), final.get("title"),
    )
    return final


def stop_recording_marker(*, device_id: str) -> Dict[str, Any]:
    device_id = str(device_id or "").strip()
    if not device_id:
        raise ValueError("Recording stop action needs a device")
    stop_at = _utc_now()
    with _events_lock:
        items = _load_events_normalized()
        for index in range(len(items) - 1, -1, -1):
            event = items[index]
            if str(event.get("device_id") or "").strip() != device_id:
                continue
            if not _event_is_open(event):
                continue
            trigger_at = _parse_iso(event.get("triggered_at"))
            clip_start = _parse_iso(event.get("clip_start"))
            clip_end = _clip_end_after(clip_start, max(stop_at, trigger_at))
            event["clip_end"] = clip_end.isoformat()
            event["after_seconds"] = max(0.0, (clip_end - trigger_at).total_seconds())
            event, _ = _trim_event_to_coverage(event)
            items[index] = event
            items, invalidated, _ = _merge_overlapping_events(items)
            invalidated.add(str(event.get("id") or "").strip())
            _save_events(items)
            _delete_clip_cache(invalidated)
            stopped = _find_matching_event(items, event) or event
            _log_recording.info(
                "Recording marker stopped: device=%s id=%s", stopped.get("device_id"), stopped.get("id")
            )
            return stopped
    _log_recording.warning("No active recording found for device %s", device_id)
    raise LookupError(f"No active recording found for device {device_id}")


# ---------------------------------------------------------------------------
# Clear all
# ---------------------------------------------------------------------------


def _clear_directory_contents(root: Path) -> int:
    if not root.exists():
        return 0
    temp = root.with_name(root.name + "_deleting_" + uuid.uuid4().hex[:8])
    try:
        root.rename(temp)
    except OSError:
        return 0
    root.mkdir(parents=True, exist_ok=True)
    threading.Thread(
        target=lambda: shutil.rmtree(temp, ignore_errors=True),
        name=f"cleanup-{root.name}",
        daemon=True,
    ).start()
    return -1


def clear_all_recordings() -> Dict[str, int]:
    _log_recording.warning("Clearing all recordings, indexes, and clips")
    cleared_events = 0
    _recorder_pause.set()
    try:
        with _recorders_lock:
            ids = list(_recorders.keys())
        for device_id in ids:
            _stop_recorder(device_id)

        acquired = _events_lock.acquire(timeout=5)
        try:
            items = _load_events()
            cleared_events = len(items)
            _save_events([])
        finally:
            if acquired:
                _events_lock.release()

        _clear_directory_contents(_recordings_root())
        _clear_directory_contents(_clips_root())
        _clear_directory_contents(_index_root())
    finally:
        _recorder_pause.clear()
        start_recording_service()
        request_recorders_refresh()

    return {
        "deleted_recording_files": -1,
        "deleted_clip_files": -1,
        "cleared_events": cleared_events,
    }


# ---------------------------------------------------------------------------
# HLS playlist generation
# ---------------------------------------------------------------------------


def _build_hls_playlist(device_id: str, started_at: datetime, ended_at: datetime) -> str:
    """Return an HLS VOD-style media playlist covering [started_at, ended_at]."""
    if (ended_at - started_at).total_seconds() > HLS_MAX_WINDOW_SECONDS:
        raise HTTPException(status_code=400, detail="HLS window too large")

    segments = _index_query_range(device_id, started_at, ended_at)
    # Sort; drop any not ready for playback (very small or zero-duration).
    segments = [s for s in segments if s.duration_seconds > 0.0 and s.size_bytes >= MIN_SEGMENT_BYTES]
    segments.sort(key=lambda s: s.started_at)

    max_dur = max((s.duration_seconds for s in segments), default=float(HLS_TARGET_DURATION))
    target = max(1, int(round(max_dur + 0.5)))

    lines: List[str] = [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        f"#EXT-X-TARGETDURATION:{target}",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-INDEPENDENT-SEGMENTS",
    ]

    prev_end: Optional[datetime] = None
    for seg in segments:
        if prev_end is not None:
            gap = (seg.started_at - prev_end).total_seconds()
            if gap > READINESS_GAP_TOLERANCE_SECONDS:
                lines.append("#EXT-X-DISCONTINUITY")
        # HLS program-date-time lets the player map wall clock to playback time.
        lines.append(f"#EXT-X-PROGRAM-DATE-TIME:{seg.started_at.isoformat()}")
        lines.append(f"#EXTINF:{seg.duration_seconds:.3f},")
        lines.append(f"seg/{seg.filename}")
        prev_end = seg.ended_at

    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Event clip (MP4 download)
# ---------------------------------------------------------------------------


def _clip_path_for_event(event_id: str) -> Path:
    event_id = _validate_id(event_id, "event_id")
    return _clips_root() / f"{event_id}.mp4"


def _build_event_clip(event: Dict[str, Any]) -> Path:
    event_id = str(event.get("id") or "").strip()
    if not event_id:
        raise HTTPException(status_code=400, detail="Invalid recording event")
    clip_path = _clip_path_for_event(event_id)
    if clip_path.exists() and clip_path.stat().st_size > 1024:
        return clip_path

    device_id = str(event.get("device_id") or "").strip()
    try:
        started_at, ended_at = _event_clip_bounds(event)
    except ValueError:
        raise HTTPException(status_code=400, detail="Recording event has an invalid time range")

    segments = _index_query_range(device_id, started_at, ended_at, finalized_only=True)
    if not segments:
        raise HTTPException(status_code=404, detail="No recorded video found for this event")

    first_start = segments[0].started_at
    offset_seconds = max(0.0, (started_at - first_start).total_seconds())
    duration_seconds = max(0.1, (ended_at - started_at).total_seconds())

    manifest = tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, dir=_clips_root(), encoding="utf-8")
    try:
        for seg in segments:
            manifest.write(f"file '{seg.path.as_posix()}'\n")
        manifest.flush()
        manifest_path = Path(manifest.name)
    finally:
        manifest.close()

    tmp_clip = clip_path.with_suffix(f".{uuid.uuid4().hex}.tmp.mp4")
    base = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", str(manifest_path),
        "-ss", f"{offset_seconds:.3f}",
        "-t", f"{duration_seconds:.3f}",
        "-map", "0:v:0?", "-map", "0:a:0?",
    ]
    copy_cmd = [
        *base,
        "-c", "copy",
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        str(tmp_clip),
    ]
    transcode_cmd = [
        *base,
        "-threads", str(CLIP_ENCODING_THREADS),
        "-c:v", "libx264", "-preset", CLIP_ENCODING_PRESET, "-crf", "23", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-movflags", "+faststart",
        str(tmp_clip),
    ]

    try:
        if PLAYBACK_CLIP_MODE != "transcode-only":
            try:
                subprocess.run(copy_cmd, check=True, capture_output=True)
                tmp_clip.replace(clip_path)
                _prune_cached_clips()
                _log_playback.info("Built copy-mode clip for event %s", event_id)
                return clip_path
            except subprocess.CalledProcessError as exc:
                _log_playback.warning("Copy-mode clip failed for %s, retrying with transcode", event_id)
                try:
                    tmp_clip.unlink(missing_ok=True)
                except Exception:
                    pass
                if PLAYBACK_CLIP_MODE == "copy-only":
                    raise HTTPException(status_code=500, detail=f"Clip generation failed: {exc}")
        try:
            subprocess.run(transcode_cmd, check=True, capture_output=True)
            tmp_clip.replace(clip_path)
            _prune_cached_clips()
            _log_playback.info("Built transcoded clip for event %s", event_id)
        except subprocess.CalledProcessError as exc:
            _log_playback.error("Clip generation failed for event %s: %s", event_id, exc)
            raise HTTPException(status_code=500, detail=f"Clip generation failed: {exc}")
    finally:
        try:
            manifest_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            tmp_clip.unlink(missing_ok=True)
        except Exception:
            pass

    return clip_path


# ---------------------------------------------------------------------------
# HTTP router
# ---------------------------------------------------------------------------

router = APIRouter(tags=["playback"])


def _timeline_day_bounds(day_value: Optional[str]) -> Tuple[date, datetime, datetime]:
    tz = _system_tz()
    if day_value:
        try:
            selected_day = date.fromisoformat(day_value)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid day")
    else:
        selected_day = _utc_now().astimezone(tz).date()
    start = datetime.combine(selected_day, datetime_time.min, tzinfo=tz).astimezone(timezone.utc)
    end = start + timedelta(days=1)
    return selected_day, start, end


@router.get("/api/settings/retention")
def get_retention() -> Dict[str, Any]:
    settings = _load_settings()
    return {
        "retention_days": get_retention_days(),
        "recording_path": settings.get("recording_path") or "",
    }


@router.put("/api/settings/retention")
def put_retention(body: Dict[str, Any]) -> Dict[str, Any]:
    try:
        days = max(0, int(body.get("retention_days", 0)))
    except (TypeError, ValueError):
        days = 0
    set_retention_days(days)
    return {"ok": True, "retention_days": days}


@router.get("/api/settings/recording-path")
def get_recording_path() -> Dict[str, Any]:
    settings = _load_settings()
    return {
        "recording_path": settings.get("recording_path") or "",
        "active_base": str(_resolve_base_dir()),
    }


@router.put("/api/settings/recording-path")
def put_recording_path(body: Dict[str, Any]) -> Dict[str, Any]:
    raw = str(body.get("recording_path") or "").strip()
    if raw and not re.fullmatch(r"/[a-zA-Z0-9_/\-]+", raw):
        raise HTTPException(status_code=400, detail="Invalid path")
    if raw:
        test = Path(raw)
        if not _is_writable_dir(test):
            raise HTTPException(status_code=400, detail=f"Path {raw} is not writable")
    settings = _load_settings()
    settings["recording_path"] = raw
    _save_settings(settings)
    return {"ok": True, "recording_path": raw, "active_base": str(_resolve_base_dir())}


@router.get("/playback", response_class=HTMLResponse)
def playback_page() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "playback.html").read_text(encoding="utf-8"))


@router.get("/api/playback/timeline")
def playback_timeline(
    device_id: str = Query(..., min_length=1),
    day: Optional[str] = None,
) -> Dict[str, Any]:
    selected_day, started_at, ended_at = _timeline_day_bounds(day)
    device_id = _validate_id(device_id, "device_id")
    segments = _index_query_range(device_id, started_at, ended_at)

    with _events_lock:
        raw = _load_events()

    filtered: List[Dict[str, Any]] = []
    for item in raw:
        if str(item.get("device_id") or "").strip() != device_id:
            continue
        normalized, _ = _trim_event_to_coverage(item)
        filtered.append(normalized)
    merged, _, _ = _merge_overlapping_events(filtered)

    events_out: List[Dict[str, Any]] = []
    for item in merged:
        try:
            e_start, e_end = _event_clip_bounds(item)
        except Exception:
            continue
        if e_start < ended_at and e_end > started_at:
            events_out.append(_serialize_event(item))
    events_out.sort(key=lambda e: str(e.get("triggered_at") or ""))

    return {
        "device_id": device_id,
        "day": selected_day.isoformat(),
        "segments": [_serialize_segment(s) for s in segments],
        "events": events_out,
    }


@router.get("/api/playback/events/{event_id}")
def playback_event(event_id: str) -> Dict[str, Any]:
    return {"event": _serialize_event(_event_by_id(event_id))}


@router.get("/api/playback/events/{event_id}/clip")
def playback_event_clip(event_id: str):
    event = _event_by_id(event_id)
    state = _event_state(event)
    if state == "missing":
        raise HTTPException(
            status_code=404,
            detail="Recording clip is unavailable because recorded video does not cover the requested time range",
        )
    if state != "ready":
        raise HTTPException(status_code=409, detail="Recording clip is still being finalized")
    clip_path = _build_event_clip(event)
    return FileResponse(clip_path, media_type="video/mp4", filename=clip_path.name)


@router.get("/api/playback/hls/{device_id}/index.m3u8", response_class=PlainTextResponse)
def playback_hls_playlist(
    device_id: str,
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
    event_id: Optional[str] = None,
) -> PlainTextResponse:
    device_id = _validate_id(device_id, "device_id")
    if event_id:
        event = _event_by_id(event_id)
        if str(event.get("device_id") or "").strip() != device_id:
            raise HTTPException(status_code=400, detail="Event does not belong to this device")
        try:
            started_at, ended_at = _event_clip_bounds(event)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid event bounds")
    else:
        if not from_ or not to:
            raise HTTPException(status_code=400, detail="from and to (or event_id) are required")
        try:
            started_at = _parse_iso(from_)
            ended_at = _parse_iso(to)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid from/to")
        if ended_at <= started_at:
            raise HTTPException(status_code=400, detail="to must be after from")

    playlist = _build_hls_playlist(device_id, started_at, ended_at)
    return PlainTextResponse(
        playlist,
        media_type="application/vnd.apple.mpegurl",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/playback/hls/{device_id}/seg/{filename}")
def playback_hls_segment(device_id: str, filename: str):
    device_id = _validate_id(device_id, "device_id")
    if not _SEGMENT_NAME_RE.match(filename):
        raise HTTPException(status_code=400, detail="Invalid segment name")
    path = _device_recordings_dir(device_id) / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Segment not found")
    return FileResponse(path, media_type="video/mp2t")


@router.delete("/api/playback/recordings")
def playback_clear_recordings() -> Dict[str, Any]:
    summary = clear_all_recordings()
    return {"ok": True, **summary}


@router.post("/api/playback/reindex")
def playback_reindex(device_id: Optional[str] = None) -> Dict[str, Any]:
    """Manually trigger a reconcile. Optional device_id to scope."""
    if device_id:
        device_id = _validate_id(device_id, "device_id")
        return {"ok": True, "device_id": device_id, **reconcile_device_index(device_id)}
    rec_root = _recordings_root()
    results: Dict[str, Any] = {}
    if rec_root.exists():
        for child in rec_root.iterdir():
            if child.is_dir() and _SAFE_ID_RE.match(child.name):
                try:
                    results[child.name] = reconcile_device_index(child.name)
                except Exception as exc:
                    results[child.name] = {"error": str(exc)}
    return {"ok": True, "results": results}
