"""Read devices.json from the recording engine.

Mirrors the read-only-from-disk pattern of flow_config.py so the engine can
re-poll device settings each supervisor tick without going through main.py.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Set, Tuple

from .config import MEDIAMTX_RTSP_HOST, MEDIAMTX_RTSP_PORT
from .paths import ALL_VARIANTS, VARIANT_HD, VARIANT_SD

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


def _record_variants_for(dev: dict) -> List[str]:
    """Variants the user opted into recording for this device.

    Defaults preserve old behaviour: if `record_variants` is missing,
    treat any device that has a configured HD profile/URL as HD-only. If
    *also* missing an HD profile, fall back to SD-only (since the live
    profile feeds MediaMTX and we know that URL works). Empty list means
    "do not record this camera".
    """
    raw = dev.get("record_variants")
    if isinstance(raw, list):
        out = [v for v in raw if v in ALL_VARIANTS]
        # Deduplicate while preserving order.
        seen: Set[str] = set()
        deduped: List[str] = []
        for v in out:
            if v in seen:
                continue
            seen.add(v)
            deduped.append(v)
        return deduped
    # Backwards-compat fallback for old devices.json entries.
    has_hd = bool(str(dev.get("recording_rtsp_url") or "").strip())
    return [VARIANT_HD] if has_hd else [VARIANT_SD]


def _live_variants_for(dev: dict) -> List[str]:
    """Variants the user opted into for live viewing."""
    raw = dev.get("live_variants")
    if isinstance(raw, list):
        out = [v for v in raw if v in ALL_VARIANTS]
        seen: Set[str] = set()
        deduped: List[str] = []
        for v in out:
            if v in seen:
                continue
            seen.add(v)
            deduped.append(v)
        return deduped
    # Default: SD only (matches the existing one-MediaMTX-path-per-camera setup).
    return [VARIANT_SD]


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


def device_record_variants() -> Dict[str, List[str]]:
    """Return `{cam_path: [variants…]}` describing which streams to record."""
    out: Dict[str, List[str]] = {}
    for dev in _load_devices_list():
        if not isinstance(dev, dict):
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if not cam:
            continue
        out[cam] = _record_variants_for(dev)
    return out


def device_live_variants() -> Dict[str, List[str]]:
    """Return `{cam_path: [variants…]}` describing which streams to expose live."""
    out: Dict[str, List[str]] = {}
    for dev in _load_devices_list():
        if not isinstance(dev, dict):
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if not cam:
            continue
        out[cam] = _live_variants_for(dev)
    return out


def device_variant_urls() -> Dict[Tuple[str, str], str]:
    """Return `{(cam_path, variant): rtsp_url}` for every (camera, variant)
    pair the recording engine should record.

    Each URL points at MediaMTX (not the camera directly). This is the
    deliberate choice that lets ONE camera RTSP connection serve both the
    recording segmenter AND any live viewers — many IP cameras only allow
    one concurrent HD connection, and pulling direct from the recorder
    while a live viewer also tried to open HD made handshakes timeout.

    MediaMTX itself is configured by main.py with the direct-from-camera
    RTSP URL as the path's `source`, and the recording engine just
    subscribes to MediaMTX. As long as at least one of (recording, live)
    is active, MediaMTX keeps the single camera link open and fans it out.
    """
    out: Dict[Tuple[str, str], str] = {}
    for dev in _load_devices_list():
        if not isinstance(dev, dict):
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if not cam:
            continue
        hd_direct = str(dev.get("recording_rtsp_url") or "").strip()
        sd_direct = str(dev.get("live_rtsp_url") or "").strip()
        if hd_direct:
            out[(cam, VARIANT_HD)] = (
                f"rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}/{cam}-hd"
            )
        if sd_direct:
            out[(cam, VARIANT_SD)] = (
                f"rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}/{cam}"
            )
    return out


# Backwards-compat alias for older callers expecting `{cam: hd_url}`.
def device_recording_urls() -> Dict[str, str]:
    pairs = device_variant_urls()
    return {cam: url for (cam, variant), url in pairs.items() if variant == VARIANT_HD}
