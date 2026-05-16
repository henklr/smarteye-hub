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

from .flow_config import variants_in_flows
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
    """Variants offered for live viewing.

    Auto-derived from which profiles are picked on the device:
      • `profile_token` set (SD profile) → SD is available on live
      • `recording_profile_token` set (HD profile) → HD is available on live
    The standalone `live_variants` field is no longer the source of
    truth — if both profiles are configured the live tile gets the
    HD/SD chip; if only one, only that variant is shown.
    """
    out: List[str] = []
    if str(dev.get("profile_token") or "").strip():
        out.append(VARIANT_SD)
    if str(dev.get("recording_profile_token") or "").strip():
        out.append(VARIANT_HD)
    return out


def continuous_cameras_from_devices() -> Set[str]:
    """Return the set of `cam-<id>` paths flagged for continuous recording.

    "Flagged" = non-empty `continuous_variants` OR legacy `continuous_recording=True`.
    The new combined dropdown writes both fields together; older devices.json
    entries may only have the boolean and we honour that as before. Returns
    an empty set when devices.json is missing/malformed.
    """
    out: Set[str] = set()
    for dev in _load_devices_list():
        if not isinstance(dev, dict):
            continue
        has_variants = bool(
            isinstance(dev.get("continuous_variants"), list)
            and dev.get("continuous_variants")
        )
        if not (has_variants or dev.get("continuous_recording")):
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if cam:
            out.add(cam)
    return out


def device_record_variants() -> Dict[str, List[str]]:
    """Return `{cam_path: [variants…]}` describing which streams to record.

    Auto-derived from the union of:
      • the device's `continuous_variants` (what continuous chunks should
        be saved as — empty means continuous is off for this camera), and
      • the Quality choices from every enabled flow Record node targeting
        the camera (read live from flows.json).

    A camera referenced by neither gets an empty list — no segmenter
    spawned, no camera RTSP pull. As soon as continuous is enabled OR a
    flow node targets the camera, the supervisor reconciles within ~1
    tick and the relevant segmenter starts.
    """
    flow_variants = variants_in_flows()
    out: Dict[str, List[str]] = {}
    for dev in _load_devices_list():
        if not isinstance(dev, dict):
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if not cam:
            continue
        wanted: Set[str] = set()
        # Continuous-side contribution.
        raw_cont = dev.get("continuous_variants")
        if isinstance(raw_cont, list) and raw_cont:
            for v in raw_cont:
                if v in ALL_VARIANTS:
                    wanted.add(v)
        elif dev.get("continuous_recording"):
            # Legacy entry: continuous toggled on but no explicit variant
            # list. Honour the previous record_variants setting if present
            # so a pre-deploy 'continuous=on, record=HD' device keeps
            # recording HD. Falls back to HD when nothing's there.
            legacy = dev.get("record_variants")
            if isinstance(legacy, list):
                for v in legacy:
                    if v in ALL_VARIANTS:
                        wanted.add(v)
            if not wanted:
                wanted.add(VARIANT_HD)
        # Flow-side contribution.
        for v in flow_variants.get(cam, []) or []:
            if v in ALL_VARIANTS:
                wanted.add(v)
        # Preserve a stable HD-before-SD ordering.
        out[cam] = [v for v in (VARIANT_HD, VARIANT_SD) if v in wanted]
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


def device_continuous_variants() -> Dict[str, List[str]]:
    """Return `{cam_path: [variants…]}` for continuous-chunk output.

    Empty list means "follow `record_variants`" — the watchdog passes
    nothing in the metadata and the assembler uses the device defaults.
    """
    out: Dict[str, List[str]] = {}
    for dev in _load_devices_list():
        if not isinstance(dev, dict):
            continue
        cam = _normalise_camera(str(dev.get("id") or ""))
        if not cam:
            continue
        raw = dev.get("continuous_variants")
        if isinstance(raw, list):
            cleaned = [v for v in raw if v in ALL_VARIANTS]
            seen: Set[str] = set()
            deduped: List[str] = []
            for v in cleaned:
                if v in seen:
                    continue
                seen.add(v)
                deduped.append(v)
            out[cam] = deduped
        else:
            out[cam] = []
    return out


def device_variant_urls() -> Dict[Tuple[str, str], str]:
    """Return `{(cam_path, variant): rtsp_url}` for each recordable variant.

    The recording segmenter pulls DIRECT from the camera (not through
    MediaMTX). We tried routing through MediaMTX to consolidate to one
    camera connection per variant, but it broke recording integrity:
    MediaMTX forwards mid-GOP frames to a subscribing reader, so the
    segmenter started writing pre-IDR data and every assembled clip had
    H.264 bytestream-corruption errors that made browsers refuse to play.

    Cameras themselves push a clean IDR on a fresh RTSP subscriber, which
    is what we need. The downside is that MediaMTX (for live viewers)
    also opens its own connection — so cameras with a 1-concurrent-HD
    limit will see HD live stall until they release the recording slot.
    Most IP cameras accept ≥2 concurrent connections; the trade-off is
    worth it for reliable recordings.
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
            out[(cam, VARIANT_HD)] = hd_direct
        if sd_direct:
            out[(cam, VARIANT_SD)] = sd_direct
    return out


# Backwards-compat alias for older callers expecting `{cam: hd_url}`.
def device_recording_urls() -> Dict[str, str]:
    pairs = device_variant_urls()
    return {cam: url for (cam, variant), url in pairs.items() if variant == VARIANT_HD}
