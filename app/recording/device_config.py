"""Read devices.json from the recording engine.

Mirrors the read-only-from-disk pattern of flow_config.py so the engine can
re-poll device settings each supervisor tick without going through main.py.
The only field we currently care about is `continuous_recording`.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Set

log = logging.getLogger("recording.device_config")

_DEVICES_JSON = Path(os.getenv("DATA_DIR", "/app/data")) / "devices.json"


def _normalise_camera(device_id: str) -> str:
    did = (device_id or "").strip()
    if not did:
        return ""
    return did if did.startswith("cam-") else f"cam-{did}"


def continuous_cameras_from_devices() -> Set[str]:
    """Return the set of `cam-<id>` paths flagged for continuous recording.

    Returns an empty set when devices.json is missing/malformed — same fail-safe
    posture as flow_config: no segmenters spawn for unknown cameras.
    """
    try:
        with open(_DEVICES_JSON, "r") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return set()
    except (json.JSONDecodeError, OSError) as e:
        log.warning("device_config: failed to read %s: %s", _DEVICES_JSON, e)
        return set()

    if isinstance(data, list):
        devices = data
    else:
        devices = data.get("devices") or data.get("items") or []

    out: Set[str] = set()
    for dev in devices:
        if not isinstance(dev, dict):
            continue
        if not dev.get("continuous_recording"):
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if cam:
            out.add(cam)
    return out
