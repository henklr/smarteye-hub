"""Recording engine public entry points.

`start_recording_engine()` and `stop_recording_engine()` are sync-callable and
drive an internal asyncio loop in a dedicated daemon thread. This isolates the
ffmpeg subprocess supervision from FastAPI's event loop (which may invoke our
on_event hooks from a threadpool executor depending on the version), and keeps
the segmenter pool alive across reloads of the API.
"""
from __future__ import annotations

import asyncio
import logging
import threading
from typing import Optional

from typing import Any, Dict

from .api import router
from .config import BUFFER_DIR, CLIPS_DIR, NVME_BASE, STORAGE_MOUNT, is_storage_mounted
from .db import init_db
from .supervisor import Supervisor
from .triggers import (
    list_active,
    start_recording,
    stop_recording,
    stop_recording_by_camera,
)

log = logging.getLogger("recording")

_loop: Optional[asyncio.AbstractEventLoop] = None
_thread: Optional[threading.Thread] = None
_supervisor: Optional[Supervisor] = None


def start_recording_engine() -> None:
    """Start the recording engine. Safe to call once; idempotent after start.

    Refuses to start if STORAGE_MOUNT is not a real mount point: without it
    we'd write recordings to the container's overlay fs (the SD card), which
    fills up quickly and is wiped on container recreation.
    """
    global _loop, _thread, _supervisor

    if _supervisor is not None:
        return

    if not is_storage_mounted():
        log.warning(
            "recording engine: %s is not a mount point; engine NOT started "
            "(recordings would otherwise spill onto the SD card)",
            STORAGE_MOUNT,
        )
        return

    for d in (NVME_BASE, BUFFER_DIR, CLIPS_DIR):
        d.mkdir(parents=True, exist_ok=True)
    init_db()

    sup = Supervisor()
    if not sup.try_acquire_lock():
        log.info("recording engine: another process holds the segmenter lock; not running supervisor here")
        # We still want this process to be able to read the DB and serve clip
        # endpoints, but no segmenters/janitor/watchdog run here.
        _supervisor = sup  # remember the (non-leader) supervisor for status reporting
        return

    new_loop = asyncio.new_event_loop()
    ready = threading.Event()

    def _thread_main() -> None:
        asyncio.set_event_loop(new_loop)
        new_loop.call_soon(ready.set)
        try:
            new_loop.run_forever()
        finally:
            try:
                new_loop.close()
            except Exception:
                pass

    t = threading.Thread(target=_thread_main, daemon=True, name="recording-engine")
    t.start()
    if not ready.wait(timeout=5):
        log.error("recording engine: loop thread failed to start")
        sup.release_lock()
        return

    asyncio.run_coroutine_threadsafe(sup.start_async(), new_loop).result(timeout=10)

    _loop = new_loop
    _thread = t
    _supervisor = sup
    log.info("recording engine started (leader=%s)", sup.is_leader)


def stop_recording_engine() -> None:
    """Stop the recording engine. Joins the loop thread (5s timeout)."""
    global _loop, _thread, _supervisor

    if _supervisor is None:
        return

    sup = _supervisor
    loop = _loop
    thread = _thread

    if loop is not None:
        try:
            asyncio.run_coroutine_threadsafe(sup.stop_async(), loop).result(timeout=30)
        except Exception:
            log.exception("recording engine: stop_async failed")
        loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout=5)
    else:
        # Non-leader path: no loop, just drop the lock file (which we never held).
        sup.release_lock()

    _supervisor = None
    _loop = None
    _thread = None
    log.info("recording engine stopped")


def engine_status() -> dict:
    mounted = is_storage_mounted()
    if _supervisor is None:
        return {"running": False, "storage_mounted": mounted}
    s = _supervisor.status()
    s["running"] = True
    s["storage_mounted"] = mounted
    return s


# ---------------------------------------------------------------------------
# flows.py back-compat shim.
# flows.py calls create_recording_marker / stop_recording_marker with the old
# kwargs and expects the old dict shape (id, device_id, clip_start, clip_end,
# color, preset_key, title). The shim adapts to the new triggers API.
# ---------------------------------------------------------------------------


def _marker_metadata_from_kwargs(kwargs: Dict[str, Any]) -> Dict[str, Any]:
    """Filter the well-known marker fields into a metadata dict."""
    keys = ("title", "color", "preset_key", "preset_name", "flow_id", "flow_name", "node_id")
    return {k: kwargs.get(k) for k in keys if kwargs.get(k) is not None}


def _camera_name(device_id: str) -> str:
    """Translate flows' device_id (`<mac>`) to the MediaMTX path (`cam-<mac>`)."""
    did = (device_id or "").strip()
    return did if did.startswith("cam-") else f"cam-{did}"


def _device_id_from_camera(camera: str) -> str:
    """Inverse of _camera_name, for the legacy dict shape flows expects."""
    return camera[len("cam-"):] if camera.startswith("cam-") else camera


def create_recording_marker(
    *,
    device_id: str,
    before_seconds: float = 0,
    max_duration_seconds: int = 0,
    color: str = "",
    title: str = "Recording",
    preset_key: str = "",
    preset_name: str = "",
    flow_id: Any = None,
    flow_name: Any = None,
    node_id: Any = None,
    record_variants_override: Any = None,
    **extra: Any,
) -> Dict[str, Any]:
    meta = _marker_metadata_from_kwargs(
        {
            "title": title, "color": color,
            "preset_key": preset_key, "preset_name": preset_name,
            "flow_id": flow_id, "flow_name": flow_name, "node_id": node_id,
        }
    )
    # The per-node variant override travels with the recording's metadata
    # and is consumed by `_finalise_stopped_recording` to pick which
    # variants to assemble. Stored under a leading-underscore key so it
    # isn't surfaced in the regular metadata payload to clients.
    if isinstance(record_variants_override, list):
        valid = [v for v in record_variants_override if v in ("hd", "sd")]
        if valid:
            meta["_record_variants"] = valid
    camera = _camera_name(device_id)
    # 0 / negative → fall back to the engine's safety cap; any positive value
    # is honoured, still clamped by the cap inside start_recording.
    try:
        max_dur = int(max_duration_seconds)
    except (TypeError, ValueError):
        max_dur = 0
    started = start_recording(
        camera=camera,
        pre_buffer_seconds=int(max(0, float(before_seconds))),
        max_duration_seconds=max_dur if max_dur > 0 else None,
        metadata=meta,
    )
    return {
        "id": started["event_id"],
        "device_id": device_id,
        "clip_start": started["trigger_start_ts"] - started["pre_buffer_seconds"],
        "clip_end": None,
        "color": color,
        "preset_key": preset_key,
        "title": title,
    }


def stop_recording_marker(*, device_id: str, **_extra: Any) -> Dict[str, Any]:
    camera = _camera_name(device_id)
    clip = stop_recording_by_camera(camera)
    if clip is None:
        log.info("stop_recording_marker: no open recording for camera=%s", camera)
        return {"id": None, "device_id": device_id, "clip_start": None, "clip_end": None, "title": ""}
    meta = clip.get("metadata") or {}
    return {
        "id": clip["id"],
        "device_id": _device_id_from_camera(clip["camera"]),
        "clip_start": clip["started_at"],
        "clip_end": clip["ended_at"],
        "title": meta.get("title", ""),
    }


# Compatibility no-op stubs for callsites that used to talk to the old
# playback recorder. Removing all callsites from main.py would touch too
# many lines; these are intentionally inert.
def request_recorders_refresh() -> None:
    return None


def set_recording_path_refresher(_cb: Any) -> None:
    return None


def system_load_snapshot() -> Dict[str, Any]:
    return engine_status()


def start_recording_service() -> None:
    return None


def stop_recording_service() -> None:
    return None
