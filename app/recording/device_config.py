"""Read devices.json from the recording engine.

Mirrors the read-only-from-disk pattern of flow_config.py so the engine can
re-poll device settings each supervisor tick without going through main.py.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Set

log = logging.getLogger("recording.device_config")

_DEVICES_JSON = Path(os.getenv("DATA_DIR", "/app/data")) / "devices.json"


def _normalise_camera(device_id: str) -> str:
    did = (device_id or "").strip()
    if not did:
        return ""
    return did if did.startswith("cam-") else f"cam-{did}"


def _load_devices_list() -> List[dict]:
    try:
        with open(_DEVICES_JSON, "r") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return []
    except (json.JSONDecodeError, OSError) as e:
        log.warning("device_config: failed to read %s: %s", _DEVICES_JSON, e)
        return []
    if isinstance(data, list):
        return data
    return data.get("devices") or data.get("items") or []


def continuous_cameras_from_devices() -> Set[str]:
    """Return the set of `cam-<id>` paths flagged for continuous recording.

    Returns an empty set when devices.json is missing/malformed — same fail-safe
    posture as flow_config: no segmenters spawn for unknown cameras.
    """
    out: Set[str] = set()
    for dev in _load_devices_list():
        if not isinstance(dev, dict):
            continue
        if not dev.get("continuous_recording"):
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if cam:
            out.add(cam)
    return out


def device_recording_urls() -> Dict[str, str]:
    """Return `{cam_path: recording_rtsp_url}` for devices that have a
    resolved recording URL.

    The URL is set by main.py's `_preload_stream_for_device` whenever a
    device is created/updated; it points directly at the camera (bypassing
    MediaMTX) so the segmenter can pull the user-chosen *recording* profile
    instead of always falling back to the live-stream profile that MediaMTX
    serves at `cam-<id>`.

    Cameras without a stored URL get omitted — the segmenter then falls back
    to MediaMTX for backward compat.
    """
    out: Dict[str, str] = {}
    for dev in _load_devices_list():
        if not isinstance(dev, dict):
            continue
        url = str(dev.get("recording_rtsp_url") or "").strip()
        if not url:
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if cam:
            out[cam] = url
    return out
