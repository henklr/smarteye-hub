"""Read flows.json and tell the recording engine which cameras are in-use,
and how much pre-buffer each needs.

The engine should only spin up a segmenter for a camera that an enabled
`action.record` node references, and only keep enough buffer for the
longest `before_seconds` any flow asks of that camera (plus a safety
margin). Cameras not used by any flow get no segmenter and no buffer.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Dict

log = logging.getLogger("recording.flow_config")

_FLOWS_JSON = Path(os.getenv("DATA_DIR", "/app/data")) / "flows.json"


def _normalise_camera(device_id: str) -> str:
    did = (device_id or "").strip()
    if not did:
        return ""
    return did if did.startswith("cam-") else f"cam-{did}"


def cameras_in_flows() -> Dict[str, int]:
    """Return `{camera_path: max_before_seconds}` for cameras referenced
    by any enabled `action.record` node in any enabled flow.

    Returns an empty dict if flows.json is missing, malformed, or has no
    record actions — meaning "no cameras should be recording right now."
    """
    try:
        with open(_FLOWS_JSON, "r") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, OSError) as e:
        log.warning("flow_config: failed to read %s: %s", _FLOWS_JSON, e)
        return {}

    if isinstance(data, list):
        flows = data
    else:
        flows = data.get("items") or data.get("flows") or []

    out: Dict[str, int] = {}
    for flow in flows:
        if not isinstance(flow, dict):
            continue
        # `enabled` defaults to True if the field is absent (matches the
        # behaviour of flows.py runtime evaluation).
        if flow.get("enabled", True) is False:
            continue
        for node in flow.get("nodes", []) or []:
            if not isinstance(node, dict):
                continue
            if node.get("type") != "action.record":
                continue
            cfg = node.get("config") or {}
            try:
                before = int(float(cfg.get("before_seconds") or 0))
            except (TypeError, ValueError):
                before = 0
            before = max(0, before)

            device_ids = cfg.get("device_ids")
            if not isinstance(device_ids, list):
                legacy = str(cfg.get("device_id") or "").strip()
                device_ids = [legacy] if legacy else []
            for did in device_ids:
                cam = _normalise_camera(str(did))
                if not cam:
                    continue
                if cam in out:
                    out[cam] = max(out[cam], before)
                else:
                    out[cam] = before
    return out
