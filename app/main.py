from __future__ import annotations

from pathlib import Path
import os
import json
import uuid
import threading
import asyncio
import time
import urllib.request
import urllib.error
import urllib.parse
import base64
from typing import Optional, Dict, Any, List
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, StreamingResponse
from pydantic import BaseModel, Field
from onvif import ONVIFCamera
from dataclasses import dataclass
from datetime import datetime, timezone

from flows import (
    router as flows_router,
    dispatch_flow_trigger,
    get_flow_topics_for_device,
)
from playback import (
    router as playback_router,
    request_recorders_refresh,
    set_recording_path_refresher,
    start_recording_service,
    stop_recording_service,
)
from physical_io import start_physical_io_monitor, stop_physical_io_monitor

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(flows_router)
app.include_router(playback_router)

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DEVICES_JSON = DATA_DIR / "devices.json"

MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://mediamtx:9997").rstrip("/")
MEDIAMTX_API_USER = os.getenv("MEDIAMTX_API_USER", "apiuser")
MEDIAMTX_API_PASS = os.getenv("MEDIAMTX_API_PASS", "apipass")

PTZ_WATCHDOG_SEC = float(os.getenv("PTZ_WATCHDOG_SEC", "0.25"))

EVENT_DEBUG = str(os.getenv("EVENT_DEBUG", "1")).strip().lower() in {"1", "true", "yes", "on"}

STREAM_STALE_SEC = float(os.getenv("STREAM_STALE_SEC", "8"))
PATH_PROGRESS_POLL_SEC = float(os.getenv("PATH_PROGRESS_POLL_SEC", "1.0"))

_VALID_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}


def _dump(model) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


@dataclass
class EventWorker:
    device_id: str
    fingerprint: str
    stop_flag: threading.Event
    thread: threading.Thread


_event_subscribers: Dict[str, List[asyncio.Queue]] = {}
_event_sub_lock = threading.RLock()

_event_workers: Dict[str, EventWorker] = {}
_event_worker_lock = threading.RLock()

_event_last: Dict[str, Dict[str, str]] = {}
_event_last_lock = threading.RLock()

_ptz_watchdogs: Dict[str, threading.Timer] = {}
_ptz_watchdog_lock = threading.RLock()

_ptz_manual_control_state: Dict[str, bool] = {}
_ptz_manual_control_lock = threading.RLock()


@dataclass
class PTZContextCache:
    fingerprint: str
    profile_token: str
    ptz: Any
    pan_tilt_space: Optional[str]
    zoom_space: Optional[str]
    has_ptz: bool
    has_pan_tilt: bool
    has_zoom: bool


_ptz_context_cache: Dict[str, PTZContextCache] = {}
_ptz_context_cache_lock = threading.RLock()

_ptz_command_locks: Dict[str, threading.Lock] = {}
_ptz_command_locks_lock = threading.RLock()

_flow_monitor_stop = threading.Event()
_flow_monitor_thread: Optional[threading.Thread] = None

_path_monitor_lock = threading.RLock()
_path_monitor_state: Dict[str, Dict[str, Any]] = {}


def _ptz_device_lock(device_id: str) -> threading.Lock:
    with _ptz_command_locks_lock:
        lock = _ptz_command_locks.get(device_id)
        if lock is None:
            lock = threading.Lock()
            _ptz_command_locks[device_id] = lock
        return lock


def _invalidate_ptz_cache(device_id: str) -> None:
    with _ptz_context_cache_lock:
        _ptz_context_cache.pop(device_id, None)


def _clear_ptz_watchdog(device_id: str) -> None:
    with _ptz_watchdog_lock:
        timer = _ptz_watchdogs.pop(device_id, None)
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass


def _dispatch_ptz_manual_control_trigger(
    device_id: str,
    active: bool,
    *,
    reason: str,
    pan: Optional[float] = None,
    tilt: Optional[float] = None,
    zoom: Optional[float] = None,
) -> None:
    with _ptz_manual_control_lock:
        previous = bool(_ptz_manual_control_state.get(device_id))
        if previous == active:
            return
        if active:
            _ptz_manual_control_state[device_id] = True
        else:
            _ptz_manual_control_state.pop(device_id, None)

    trigger = {
        "kind": "ptz_manual_control_started" if active else "ptz_manual_control_stopped",
        "device_id": device_id,
        "message": "PTZ manual control started" if active else "PTZ manual control stopped",
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "extra": {"reason": reason},
    }
    if pan is not None:
        trigger["pan"] = float(pan)
    if tilt is not None:
        trigger["tilt"] = float(tilt)
    if zoom is not None:
        trigger["zoom"] = float(zoom)
    dispatch_flow_trigger(trigger)


def _ptz_watchdog_stop(device_id: str) -> None:
    with _ptz_watchdog_lock:
        _ptz_watchdogs.pop(device_id, None)
    _ptz_stop(device_id, reason="watchdog")


@app.get("/", response_class=HTMLResponse)
def index_page():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/live", response_class=HTMLResponse)
def live_page():
    return (STATIC_DIR / "live.html").read_text(encoding="utf-8")


@app.get("/devices", response_class=HTMLResponse)
def devices_page():
    return (STATIC_DIR / "devices.html").read_text(encoding="utf-8")


@app.get("/health")
def health():
    with _event_worker_lock:
        workers = {
            k: {
                "fingerprint": v.fingerprint,
                "alive": bool(v.thread and v.thread.is_alive()),
            }
            for k, v in _event_workers.items()
        }
    return {
        "ok": True,
        "event_workers": workers,
        "event_debug": EVENT_DEBUG,
    }


class OnvifBase(BaseModel):
    ip: str
    onvif_port: int = 80
    username: str
    password: str


class StartRequest(OnvifBase):
    profile_token: str
    device_id: str


class DeviceIn(BaseModel):
    name: str = Field(..., min_length=1)
    ip: str = Field(..., min_length=1)
    onvif_port: int = 80
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)
    profile_token: Optional[str] = None
    profile_label: Optional[str] = None
    profile_encoding: Optional[str] = None
    preload_stream: bool = True


class Device(DeviceIn):
    id: str


class EventsStartRequest(OnvifBase):
    device_id: str


class PTZMoveRequest(BaseModel):
    pan: float = 0.0
    tilt: float = 0.0
    zoom: float = 0.0
    

def _normalize_allow_topic(s: Optional[str]) -> str:
    s = (s or "").strip().strip("/")
    if not s:
        return ""
    parts = [p.strip() for p in s.split("/") if p.strip()]
    cleaned = []
    for p in parts:
        if ":" in p:
            p = p.split(":", 1)[1]
        if p:
            cleaned.append(p)
    return "/".join(cleaned)


def _humanize_topic_segment(segment: str) -> str:
    raw = str(segment or "").strip().replace("_", " ").replace("-", " ")
    if not raw:
        return ""

    out: List[str] = []
    prev_is_lower = False
    prev_is_alpha = False

    for ch in raw:
        if ch == " ":
            if out and out[-1] != " ":
                out.append(" ")
            prev_is_lower = False
            prev_is_alpha = False
            continue

        is_upper = ch.isupper()
        is_lower = ch.islower()
        is_digit = ch.isdigit()

        if out:
            prev = out[-1]
            prev_is_digit = prev.isdigit()
            if is_upper and prev_is_lower:
                out.append(" ")
            elif is_digit and prev_is_alpha:
                out.append(" ")
            elif is_lower and prev_is_digit:
                out.append(" ")

        out.append(ch)
        prev_is_lower = is_lower
        prev_is_alpha = is_upper or is_lower

    return " ".join("".join(out).split())


_TOPIC_SCHEMA_STOP_NODES = {
    "MessageDescription",
    "Source",
    "Data",
    "Key",
    "SimpleItemDescription",
    "ElementItemDescription",
    "MessageContentFilter",
}


def _normalize_http_method(value: Optional[str], allow_any: bool = False) -> str:
    method = str(value or "").strip().upper()
    if not method:
        return "ANY" if allow_any else ""

    if allow_any and method == "ANY":
        return "ANY"

    if method not in _VALID_HTTP_METHODS:
        return ""

    return method


def _normalize_http_path(value: Optional[str]) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""

    raw = raw.split("?", 1)[0].strip()

    if not raw.startswith("/"):
        raw = "/" + raw

    parts = [p for p in raw.split("/") if p]
    return "/" + "/".join(parts) if parts else "/"


def _normalize_http_headers(value: Any) -> Dict[str, str]:
    if value is None:
        return {}

    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="HTTP headers must be an object")

    out: Dict[str, str] = {}
    for k, v in value.items():
        key = str(k or "").strip()
        if not key:
            continue
        out[key] = str(v if v is not None else "")
    return out


def _normalize_device_dict(d: dict) -> dict:
    out = dict(d)
    if "preload_stream" not in out:
        out["preload_stream"] = True
    out.pop("allow_topics", None)
    return out


def _load_devices() -> List[Device]:
    if not DEVICES_JSON.exists():
        return []
    try:
        raw = json.loads(DEVICES_JSON.read_text(encoding="utf-8"))
        items = raw.get("devices", [])
        if not isinstance(items, list):
            return []
        return [Device(**_normalize_device_dict(d)) for d in items]
    except Exception:
        return []


def _save_devices(devs: List[Device]) -> None:
    payload = {"devices": [_dump(d) for d in devs]}
    tmp = DEVICES_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(DEVICES_JSON)


def _get_device(device_id: str) -> Device:
    devs = _load_devices()
    for d in devs:
        if d.id == device_id:
            return d
    raise HTTPException(status_code=404, detail="Device not found")


def _update_device(device_id: str, dev_in: DeviceIn) -> Device:
    devs = _load_devices()
    for i, d in enumerate(devs):
        if d.id == device_id:
            devs[i] = Device(id=device_id, **_dump(dev_in))
            _save_devices(devs)
            _invalidate_ptz_cache(device_id)
            req = EventsStartRequest(
                device_id=device_id,
                ip=dev_in.ip,
                onvif_port=dev_in.onvif_port,
                username=dev_in.username,
                password=dev_in.password,
            )
            _start_event_worker(device_id, req)

            if devs[i].profile_token:
                try:
                    _refresh_device_stream(device_id)
                except Exception:
                    pass

            return devs[i]
    raise HTTPException(status_code=404, detail="Device not found")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _canonical_topic_aliases(topic: Optional[str]) -> set[str]:
    t = _normalize_allow_topic(topic)
    if not t:
        return set()

    aliases = {t}
    low = t.lower()

    if (
        "motion" in low
        or "ismotion" in low
        or "motionalarm" in low
        or "cellmotiondetector" in low
        or "motiondetector" in low
        or t == "VideoSource/MotionAlarm"
    ):
        aliases.update({
            "VideoSource/MotionAlarm",
            "RuleEngine/CellMotionDetector/Motion",
            "VideoSource/MotionDetector/Motion",
            "IsMotion/Rule/VideoAnalyticsConfigurationToken/VideoSourceConfigurationToken",
        })

    if (
        "objectsinside" in low
        or "objectinside" in low
        or "fielddetector" in low
        or "isinside" in low
    ):
        aliases.update({
            "RuleEngine/FieldDetector/ObjectsInside",
            "RuleEngine/FieldDetector/ObjectInside",
            "VideoSource/ObjectInside",
            "IsInside/Rule/VideoAnalyticsConfigurationToken/VideoSourceConfigurationToken",
        })

    if "digitalinput" in low or "inputtoken" in low:
        aliases.update({
            "Device/Trigger/DigitalInput",
        })

    if "relay" in low or "relaytoken" in low:
        aliases.update({
            "Device/Trigger/Relay",
        })

    if "tamper" in low:
        aliases.update({
            "VideoSource/ImageTooDark/Tamper",
            "VideoSource/TamperDetector/Tamper",
        })

    return {_normalize_allow_topic(x) for x in aliases if _normalize_allow_topic(x)}


def _expanded_allow_topics(allow_set: set[str]) -> set[str]:
    out = set()
    for topic in allow_set:
        out.update(_canonical_topic_aliases(topic))
    return out


def _topic_matches_allowlist(candidate: str, allow_set: set[str]) -> bool:
    c = _normalize_allow_topic(candidate)
    if not c:
        return False

    expanded_allow = _expanded_allow_topics(allow_set)
    candidate_aliases = _canonical_topic_aliases(c)

    for cand in candidate_aliases:
        parts = cand.split("/")
        prefixes = ["/".join(parts[:i]) for i in range(1, len(parts) + 1)]
        for p in prefixes:
            if p in expanded_allow:
                return True

    return False


def _matching_allow_topic(candidate: str, allow_set: set[str]) -> Optional[str]:
    for allow_topic in sorted(allow_set):
        if _topic_matches_allowlist(candidate, {allow_topic}):
            return allow_topic
    return None


def _known_event_topic_groups() -> List[dict]:
    return [
        {
            "path": "VideoSource/MotionAlarm",
            "label": "Motion detected",
            "category": "Analytics",
            "keywords": ["motion", "movement", "motion alarm", "cell motion"],
            "aliases": sorted(_canonical_topic_aliases("VideoSource/MotionAlarm")),
            "recommended": True,
        },
        {
            "path": "RuleEngine/FieldDetector/ObjectsInside",
            "label": "Objects inside area",
            "category": "Analytics",
            "keywords": ["object inside", "objects inside", "field detector", "intrusion"],
            "aliases": sorted(_canonical_topic_aliases("RuleEngine/FieldDetector/ObjectsInside")),
            "recommended": True,
        },
        {
            "path": "Device/Trigger/DigitalInput",
            "label": "Digital input changed",
            "category": "Inputs",
            "keywords": ["digital input", "input trigger", "input state"],
            "aliases": sorted(_canonical_topic_aliases("Device/Trigger/DigitalInput")),
            "recommended": True,
        },
        {
            "path": "Device/Trigger/Relay",
            "label": "Relay changed",
            "category": "Outputs",
            "keywords": ["relay", "relay output", "output state"],
            "aliases": sorted(_canonical_topic_aliases("Device/Trigger/Relay")),
            "recommended": True,
        },
        {
            "path": "VideoSource/ImageTooDark/Tamper",
            "label": "Tamper detected",
            "category": "Video",
            "keywords": ["tamper", "scene blocked", "image too dark"],
            "aliases": ["VideoSource/ImageTooDark/Tamper"],
            "recommended": True,
        },
    ]


def _topic_category_from_path(path: str) -> str:
    normalized = _normalize_allow_topic(path)
    if not normalized:
        return "Other"

    parts = [part for part in normalized.split("/") if part]
    head = parts[0] if parts else ""

    if head == "RuleEngine":
        return "Analytics"
    if normalized.startswith("Device/Trigger/DigitalInput"):
        return "Inputs"
    if normalized.startswith("Device/Trigger/Relay"):
        return "Outputs"
    if head == "VideoSource":
        return "Video"
    if head == "Device":
        return "Device"
    return "Other"


def _topic_label_from_path(path: str) -> str:
    parts = [part for part in _normalize_allow_topic(path).split("/") if part]
    if not parts:
        return ""

    leaf = _humanize_topic_segment(parts[-1]) or parts[-1]
    if len(parts) == 1:
        return leaf

    parent = _humanize_topic_segment(parts[-2]) or parts[-2]
    if parent and parent.lower() not in leaf.lower():
        return f"{leaf} ({parent})"
    return leaf


def _event_topic_profile(path: str) -> Optional[dict]:
    normalized = _normalize_allow_topic(path)
    if not normalized:
        return None

    for group in _known_event_topic_groups():
        if _topic_matches_allowlist(normalized, {group["path"]}):
            return group
    return None


def _format_event_topics(raw_paths: List[str]) -> List[dict]:
    groups: Dict[str, dict] = {}
    category_order = {
        "Analytics": 0,
        "Inputs": 1,
        "Outputs": 2,
        "Video": 3,
        "Device": 4,
        "Other": 5,
    }

    for raw_path in raw_paths:
        normalized = _normalize_allow_topic(raw_path)
        if not normalized:
            continue

        profile = _event_topic_profile(normalized)
        canonical_path = profile["path"] if profile else normalized

        entry = groups.setdefault(
            canonical_path,
            {
                "path": canonical_path,
                "label": (profile or {}).get("label") or _topic_label_from_path(canonical_path) or canonical_path,
                "category": (profile or {}).get("category") or _topic_category_from_path(canonical_path),
                "recommended": bool((profile or {}).get("recommended")),
                "aliases": set((profile or {}).get("aliases") or []),
                "source_paths": set(),
                "keywords": set((profile or {}).get("keywords") or []),
            },
        )

        entry["source_paths"].add(normalized)
        entry["aliases"].add(normalized)

    out: List[dict] = []
    for entry in groups.values():
        path = entry["path"]
        aliases = sorted({_normalize_allow_topic(x) for x in entry["aliases"] if _normalize_allow_topic(x)})
        source_paths = sorted({_normalize_allow_topic(x) for x in entry["source_paths"] if _normalize_allow_topic(x)})
        search_terms = [
            entry["label"],
            path,
            entry["category"],
            *sorted(entry["keywords"]),
            *aliases,
            *source_paths,
        ]
        search_text = " ".join(str(term).strip().lower() for term in search_terms if str(term).strip())
        out.append(
            {
                "path": path,
                "name": entry["label"],
                "label": entry["label"],
                "category": entry["category"],
                "recommended": bool(entry["recommended"]),
                "aliases": aliases,
                "source_paths": source_paths,
                "search_text": search_text,
            }
        )

    out.sort(
        key=lambda item: (
            0 if item.get("recommended") else 1,
            category_order.get(str(item.get("category") or "Other"), 99),
            str(item.get("label") or item.get("path") or "").lower(),
            str(item.get("path") or "").lower(),
        )
    )
    return out


def _get_effective_event_allowlist(device_id: str) -> set[str]:
    return {t for t in get_flow_topics_for_device(device_id) if t}



def _poll_device_state_changes() -> None:
    while not _flow_monitor_stop.wait(PATH_PROGRESS_POLL_SEC):
        try:
            devs = _load_devices()
            _ensure_event_workers(devs)
            snapshot = _mediamtx_paths_snapshot()

            for d in devs:
                row = _path_row_for_device(snapshot, d.id)
                monitor = _update_path_monitor_state(d.id, row)

                prev = monitor["previous_online"]
                curr = monitor["current_online"]

                if prev is None:
                    if EVENT_DEBUG:
                        _emit_event(
                            d.id,
                            "debug",
                            "Initialized device state tracker",
                            {
                                "current_online": curr,
                                "no_progress_count": monitor["no_progress_count"],
                                "seconds_since_progress": monitor["seconds_since_progress"],
                                "bytes_received": monitor["bytes_received"],
                                "readers": monitor["readers"],
                            },
                        )
                    continue

                if prev == curr:
                    continue

                st = _device_stream_status_from_snapshot(d, snapshot)

                if prev and not curr:
                    if EVENT_DEBUG:
                        _emit_event(
                            d.id,
                            "debug",
                            "Detected device offline transition",
                            {
                                "previous_online": prev,
                                "current_online": curr,
                                "status": st,
                            },
                        )

                    trigger = {
                        "kind": "device_offline",
                        "device_id": d.id,
                        "message": "Device offline",
                        "status": st,
                    }
                    dispatch_flow_trigger(trigger)

                elif (not prev) and curr:
                    if EVENT_DEBUG:
                        _emit_event(
                            d.id,
                            "debug",
                            "Detected device back online transition",
                            {
                                "previous_online": prev,
                                "current_online": curr,
                                "status": st,
                            },
                        )

                    trigger = {
                        "kind": "device_back_online",
                        "device_id": d.id,
                        "message": "Device back online",
                        "status": st,
                    }
                    dispatch_flow_trigger(trigger)

        except Exception as e:
            if EVENT_DEBUG:
                try:
                    _broadcast_event("system", {
                        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "device_id": "system",
                        "level": "warn",
                        "message": f"Flow monitor poll failed: {e}",
                        "extra": {},
                    })
                except Exception:
                    pass


def _cam(req: OnvifBase) -> ONVIFCamera:
    return ONVIFCamera(req.ip, req.onvif_port, req.username, req.password)


def _device_req(device: Device) -> OnvifBase:
    return OnvifBase(
        ip=device.ip,
        onvif_port=device.onvif_port,
        username=device.username,
        password=device.password,
    )


def _req_fingerprint(req: OnvifBase) -> str:
    return "|".join([req.ip, str(req.onvif_port), req.username, req.password])


def _strip_ns(tag: str) -> str:
    if not tag:
        return tag
    if "}" in tag:
        return tag.split("}", 1)[1]
    if ":" in tag:
        return tag.split(":", 1)[1]
    return tag


def _serialize_zeep_obj(obj):
    try:
        if obj is None:
            return None
        if isinstance(obj, (str, int, float, bool)):
            return obj
        if isinstance(obj, (list, tuple)):
            return [_serialize_zeep_obj(x) for x in obj]
        if isinstance(obj, dict):
            return {str(k): _serialize_zeep_obj(v) for k, v in obj.items()}
        if hasattr(obj, "tag"):
            return {
                "tag": _strip_ns(getattr(obj, "tag", "")),
                "children": [_serialize_zeep_obj(child) for child in list(obj)],
                "attributes": dict(getattr(obj, "attrib", {}) or {}),
                "text": (getattr(obj, "text", None) or "").strip() or None,
            }
        if hasattr(obj, "__values__"):
            return {str(k): _serialize_zeep_obj(v) for k, v in obj.__values__.items()}
        if hasattr(obj, "__dict__"):
            return {
                str(k): _serialize_zeep_obj(v)
                for k, v in obj.__dict__.items()
                if not str(k).startswith("_")
            }
        return str(obj)
    except Exception:
        return str(obj)


def _collect_topic_leaf_paths(topic_set_obj) -> List[str]:
    results: List[str] = []
    seen: set[str] = set()

    def add_path(path: str) -> None:
        normalized = _normalize_allow_topic(path)
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        results.append(normalized)

    def walk_elem(elem, prefix: str = "") -> None:
        if elem is None:
            return

        tag = getattr(elem, "tag", None)
        name = _strip_ns(tag) if tag else None

        if name in _TOPIC_SCHEMA_STOP_NODES:
            add_path(prefix)
            return

        current = f"{prefix}/{name}" if prefix and name else (name or prefix)

        try:
            children = [child for child in list(elem) if hasattr(child, "tag")]
        except Exception:
            children = []

        if current and not children:
            add_path(current)
            return

        for child in children:
            walk_elem(child, current)

    if topic_set_obj is None:
        return results

    try:
        nodes = getattr(topic_set_obj, "_value_1", None)
        if isinstance(nodes, list):
            for node in nodes:
                if hasattr(node, "tag"):
                    walk_elem(node, "")
    except Exception:
        pass

    if not results:
        try:
            for node in list(topic_set_obj):
                if hasattr(node, "tag"):
                    walk_elem(node, "")
        except Exception:
            pass

    return results


def _guess_topic_from_items(items: dict) -> str:
    data = items.get("data", {}) or {}
    src = items.get("source", {}) or {}
    merged = {**src, **data}
    keys = {str(k).lower(): str(v) for k, v in merged.items()}

    has_vs_token = (
        "videosourcetoken" in keys
        or "videosourceconfigurationtoken" in keys
    )
    has_va_token = (
        "videoanalyticstoken" in keys
        or "videoanalyticsconfigurationtoken" in keys
    )
    has_rule = "rule" in keys

    if "ismotion" in keys and (has_vs_token or has_va_token or has_rule):
        return "RuleEngine/CellMotionDetector/Motion"

    if "isinside" in keys and (has_vs_token or has_va_token or has_rule):
        return "RuleEngine/FieldDetector/ObjectsInside"

    if "inputtoken" in keys:
        return "Device/Trigger/DigitalInput"

    if "relaytoken" in keys:
        return "Device/Trigger/Relay"

    if "tamper" in "".join(keys.keys()).lower():
        return "VideoSource/ImageTooDark/Tamper"

    return ""


def _topic_fallback_key(items: dict) -> str:
    data = items.get("data", {}) or {}
    src = items.get("source", {}) or {}
    keys = sorted([str(k) for k in [*src.keys(), *data.keys()] if str(k)])
    return "/".join(keys)


def _normalize_topic_for_match(topic_text: Optional[str]) -> str:
    topic_text = (topic_text or "").strip().strip("/")
    if not topic_text:
        return ""

    if "Dialect" in topic_text and "ConcreteSet" in topic_text:
        return ""

    parts = [p.strip() for p in topic_text.split("/") if p.strip()]
    cleaned = []
    for p in parts:
        if ":" in p:
            p = p.split(":", 1)[1]
        if p:
            cleaned.append(p)
    return "/".join(cleaned)


def _topic_obj_to_text(topic_obj) -> str:
    if topic_obj is None:
        return ""

    text = getattr(topic_obj, "_value_1", None)
    if isinstance(text, str) and text.strip():
        return text.strip()

    if isinstance(text, list):
        parts = []
        for x in text:
            try:
                sx = str(x).strip()
            except Exception:
                sx = ""
            if sx:
                parts.append(sx)
        if parts:
            return "/".join(parts)

    return ""


def _extract_simple_items(msg_elem) -> dict:
    out = {"source": {}, "data": {}}
    if msg_elem is None:
        return out

    def walk(elem):
        tag = _strip_ns(getattr(elem, "tag", ""))
        if tag == "Source":
            for child in list(elem):
                name = child.attrib.get("Name") or _strip_ns(child.tag)
                value = child.attrib.get("Value") or (child.text or "")
                out["source"][str(name)] = str(value)
        elif tag == "Data":
            for child in list(elem):
                name = child.attrib.get("Name") or _strip_ns(child.tag)
                value = child.attrib.get("Value") or (child.text or "")
                out["data"][str(name)] = str(value)
        else:
            for child in list(elem):
                walk(child)

    try:
        walk(msg_elem)
    except Exception:
        pass
    return out


def _get_event_properties(req: OnvifBase) -> dict:
    cam = _cam(req)
    events = cam.create_events_service()
    props = events.GetEventProperties()
    raw_topics = _collect_topic_leaf_paths(getattr(props, "TopicSet", None))
    topics = _format_event_topics(raw_topics)
    return {
        "topics": topics,
        "fixed_topic_set": bool(raw_topics),
        "raw_topic_set": _serialize_zeep_obj(getattr(props, "TopicSet", None)),
        "raw": _serialize_zeep_obj(props),
    }


def _broadcast_event(device_id: str, payload: dict) -> None:
    with _event_sub_lock:
        subs = list(_event_subscribers.get(device_id, []))
    for q in subs:
        try:
            q.put_nowait(payload)
        except Exception:
            pass


def _emit_event(device_id: str, level: str, msg: str, extra: Optional[dict] = None) -> None:
    payload = {
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "device_id": device_id,
        "level": level,
        "message": msg,
        "extra": extra or {},
    }
    _broadcast_event(device_id, payload)
    if level == "event" and msg == "ONVIF event":
        trigger = {
            "kind": "onvif_event",
            "device_id": device_id,
            "message": msg,
            "extra": extra or {},
            "ts": payload["ts"],
            "topic": (
                (extra or {}).get("matched_allow_topic")
                or (extra or {}).get("matched_by")
                or (extra or {}).get("topic_path")
                or (extra or {}).get("guessed_topic")
            ),
        }
        dispatch_flow_trigger(trigger)
        
ALLOW_REFRESH_S = 2.0


def _onvif_event_worker(device_id: str, req: OnvifBase, stop_flag: threading.Event, fingerprint: str) -> None:
    allow_set = _get_effective_event_allowlist(device_id)
    last_allow_refresh = 0.0
    max_messages = 20

    try:
        def connect_pullpoint(*, reconnect: bool = False):
            cam = _cam(req)
            events = cam.create_events_service()

            last_error: Optional[Exception] = None
            for payload in ({}, {"InitialTerminationTime": "PT5M"}):
                try:
                    events.CreatePullPointSubscription(payload)
                    pullpoint = cam.create_pullpoint_service()
                    _emit_event(
                        device_id,
                        "ok",
                        "Re-subscribed to ONVIF events after pull-point reset."
                        if reconnect
                        else "Subscribed to ONVIF events (flow-aware filtering enabled).",
                    )
                    return pullpoint
                except Exception as exc:
                    last_error = exc

            raise last_error or RuntimeError("CreatePullPointSubscription failed")

        connected_once = False
        retry_delay = 1.0

        while not stop_flag.is_set():
            try:
                pullpoint = connect_pullpoint(reconnect=connected_once)
                connected_once = True
                retry_delay = 1.0

                while not stop_flag.is_set():
                    now = time.time()
                    if (now - last_allow_refresh) >= ALLOW_REFRESH_S:
                        allow_set = _get_effective_event_allowlist(device_id)
                        last_allow_refresh = now
                        if EVENT_DEBUG:
                            _emit_event(
                                device_id,
                                "debug",
                                "Allowlist refreshed",
                                {
                                    "allow_count": len(allow_set),
                                    "allow_topics": sorted(list(allow_set)),
                                },
                            )

                    try:
                        resp = pullpoint.PullMessages({"Timeout": "PT2S", "MessageLimit": max_messages})
                        msgs = getattr(resp, "NotificationMessage", None)
                        if not msgs:
                            continue
                        if not isinstance(msgs, list):
                            msgs = [msgs]

                        for m in msgs:
                            topic_obj = getattr(m, "Topic", None)
                            topic_text = _topic_obj_to_text(topic_obj)
                            topic_path = _normalize_topic_for_match(topic_text)

                            msg_elem = None
                            try:
                                msg_elem = getattr(getattr(m, "Message", None), "_value_1", None)
                            except Exception:
                                msg_elem = None

                            items = _extract_simple_items(msg_elem)

                            op = None
                            utc = None
                            try:
                                msg_attrib = getattr(msg_elem, "attrib", {}) or {}
                                op = msg_attrib.get("PropertyOperation")
                                utc = msg_attrib.get("UtcTime")
                            except Exception:
                                pass

                            fallback_key = _topic_fallback_key(items)
                            guessed_topic = _guess_topic_from_items(items)

                            match_candidates: List[str] = []
                            if topic_path:
                                match_candidates.append(topic_path)
                            if guessed_topic and guessed_topic not in match_candidates:
                                match_candidates.append(guessed_topic)
                            if fallback_key and fallback_key not in match_candidates:
                                match_candidates.append(fallback_key)

                            matched = False
                            matched_by = None
                            matched_allow_topic = None

                            if not allow_set:
                                matched = False
                            else:
                                for candidate in match_candidates:
                                    allow_topic = _matching_allow_topic(candidate, allow_set)
                                    if allow_topic:
                                        matched = True
                                        matched_by = candidate
                                        matched_allow_topic = allow_topic
                                        break

                            if EVENT_DEBUG:
                                _emit_event(
                                    device_id,
                                    "debug",
                                    "Camera emitted event",
                                    {
                                        "topic_text": topic_text,
                                        "topic_path": topic_path,
                                        "guessed_topic": guessed_topic,
                                        "fallback_key": fallback_key,
                                        "match_candidates": match_candidates,
                                        "match_key": matched_by,
                                        "matched_allowlist": matched,
                                        "matched_by": matched_by,
                                        "matched_allow_topic": matched_allow_topic,
                                        "allow_count": len(allow_set),
                                        "op": op,
                                        "utc": utc,
                                        "source": items.get("source", {}),
                                        "data": items.get("data", {}),
                                    },
                                )

                            if not matched:
                                if EVENT_DEBUG:
                                    _emit_event(
                                        device_id,
                                        "warn",
                                        "Dropped event because it did not match flow topics",
                                        {
                                            "topic_text": topic_text,
                                            "topic_path": topic_path,
                                            "guessed_topic": guessed_topic,
                                            "fallback_key": fallback_key,
                                            "match_candidates": match_candidates,
                                            "allow_topics": sorted(list(allow_set)),
                                            "expanded_allow_topics": sorted(list(_expanded_allow_topics(allow_set))),
                                        },
                                    )
                                continue

                            data = items.get("data", {})
                            src = items.get("source", {})
                            src_id = (
                                src.get("InputToken")
                                or src.get("RelayToken")
                                or src.get("Source")
                                or src.get("Token")
                                or src.get("VideoSource")
                                or ""
                            )

                            def kk(k: str) -> str:
                                base = matched_by or (match_candidates[0] if match_candidates else "event")
                                return f"{base}::{k}::{src_id}" if src_id else f"{base}::{k}"

                            changed: Dict[str, str] = {}
                            with _event_last_lock:
                                last = _event_last.setdefault(device_id, {})
                                for k, v0 in data.items():
                                    v = str(v0)
                                    kfull = kk(k)
                                    if last.get(kfull) != v:
                                        changed[k] = v
                                        last[kfull] = v

                            if op == "Initialized" and not changed:
                                if EVENT_DEBUG:
                                    _emit_event(
                                        device_id,
                                        "debug",
                                        "Skipped initialized event with no changes",
                                        {
                                            "topic_text": topic_text,
                                            "topic_path": topic_path,
                                            "guessed_topic": guessed_topic,
                                            "matched_by": matched_by,
                                            "items": items,
                                        },
                                    )
                                continue

                            _emit_event(
                                device_id,
                                "event",
                                "ONVIF event",
                                {
                                    "op": op,
                                    "utc": utc,
                                    "topic_text": topic_text,
                                    "topic_path": topic_path,
                                    "guessed_topic": guessed_topic,
                                    "fallback_key": fallback_key,
                                    "match_candidates": match_candidates,
                                    "matched_by": matched_by,
                                    "matched_allow_topic": matched_allow_topic,
                                    "changed": changed,
                                    "items": items,
                                },
                            )

                    except Exception as e:
                        error_text = str(e)
                        normalized_error = error_text.strip().lower()
                        should_resubscribe = (
                            "resource unknown" in normalized_error
                            or "unknown resource" in normalized_error
                            or "subscription" in normalized_error and "unknown" in normalized_error
                        )

                        if should_resubscribe:
                            _emit_event(device_id, "warn", f"PullMessages lost pull-point subscription: {e}")
                            break

                        _emit_event(device_id, "warn", f"PullMessages error: {e}")
                        time.sleep(0.5)

            except Exception as e:
                _emit_event(device_id, "bad", f"Event subscription failed: {e}")

            if stop_flag.wait(retry_delay):
                break
            retry_delay = min(retry_delay * 1.5, 10.0)

    except Exception as e:
        _emit_event(device_id, "bad", f"Event subscription failed: {e}")
    finally:
        with _event_worker_lock:
            cur = _event_workers.get(device_id)
            if cur and cur.fingerprint == fingerprint:
                _event_workers.pop(device_id, None)
        _emit_event(device_id, "warn", "Event worker stopped.")


def _start_event_worker(device_id: str, req: OnvifBase) -> None:
    fingerprint = _req_fingerprint(req)
    old_worker: Optional[EventWorker] = None

    with _event_worker_lock:
        cur = _event_workers.get(device_id)
        if cur and cur.fingerprint == fingerprint and cur.thread and cur.thread.is_alive():
            return

        if cur:
            cur.stop_flag.set()
            old_worker = cur

        stop_flag = threading.Event()
        thread = threading.Thread(
            target=_onvif_event_worker,
            args=(device_id, req, stop_flag, fingerprint),
            daemon=True,
            name=f"onvif-events-{device_id}",
        )
        worker = EventWorker(
            device_id=device_id,
            fingerprint=fingerprint,
            stop_flag=stop_flag,
            thread=thread,
        )
        _event_workers[device_id] = worker
        thread.start()

    if old_worker:
        _emit_event(device_id, "warn", "Restarted event worker due to device settings change.")


def _ensure_event_workers(devs: Optional[List[Device]] = None) -> None:
    devices = devs if devs is not None else _load_devices()

    for device in devices:
        if not str(device.ip or "").strip():
            continue
        if not str(device.username or "").strip():
            continue
        if not str(device.password or "").strip():
            continue

        req = EventsStartRequest(
            device_id=device.id,
            ip=device.ip,
            onvif_port=device.onvif_port,
            username=device.username,
            password=device.password,
        )
        _start_event_worker(device.id, req)


def _stop_event_worker(device_id: str) -> None:
    with _event_worker_lock:
        cur = _event_workers.pop(device_id, None)
    if cur:
        cur.stop_flag.set()


def _path_for(device_id: str) -> str:
    return f"cam-{device_id}"


def _profile_summary(p) -> Dict[str, Any]:
    out = {
        "token": getattr(p, "token", None),
        "name": getattr(p, "Name", None),
        "encoding": None,
        "width": None,
        "height": None,
        "browser_compatible": False,
        "recommended": False,
    }

    try:
        vec = getattr(p, "VideoEncoderConfiguration", None)
        if vec:
            encoding = getattr(vec, "Encoding", None)
            if encoding is not None:
                encoding = str(encoding).upper()
            out["encoding"] = encoding

            res = getattr(vec, "Resolution", None)
            if res:
                out["width"] = getattr(res, "Width", None)
                out["height"] = getattr(res, "Height", None)
    except Exception:
        pass

    out["browser_compatible"] = out.get("encoding") == "H264"
    return out


def _find_profile_encoding(req: OnvifBase, profile_token: str) -> Optional[str]:
    cam = _cam(req)
    media = cam.create_media_service()
    profiles = media.GetProfiles() or []
    for p in profiles:
        if getattr(p, "token", None) == profile_token:
            vec = getattr(p, "VideoEncoderConfiguration", None)
            if vec:
                enc = getattr(vec, "Encoding", None)
                return str(enc).upper() if enc is not None else None
            return None
    raise RuntimeError("Profile token not found")


def _get_stream_uri(req: OnvifBase, profile_token: str) -> str:
    cam = _cam(req)
    media = cam.create_media_service()
    resp = media.GetStreamUri({
        "StreamSetup": {
            "Stream": "RTP-Unicast",
            "Transport": {"Protocol": "RTSP"},
        },
        "ProfileToken": profile_token,
    })
    uri = getattr(resp, "Uri", None)
    if not uri:
        raise RuntimeError("Camera did not provide RTSP stream URI.")
    return str(uri)


def _rtsp_with_auth(uri: str, username: str, password: str) -> str:
    parts = urlsplit(uri)
    if parts.scheme.lower() != "rtsp":
        return uri
    host = parts.hostname or ""
    port = f":{parts.port}" if parts.port else ""
    user = urllib.parse.quote(username, safe="")
    pwd = urllib.parse.quote(password, safe="")
    netloc = f"{user}:{pwd}@{host}{port}"
    return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def _mediamtx_api_request(method: str, path: str, body: Optional[dict] = None) -> dict:
    url = f"{MEDIAMTX_API_URL}{path}"
    data = None
    auth_raw = f"{MEDIAMTX_API_USER}:{MEDIAMTX_API_PASS}".encode("utf-8")
    auth_b64 = base64.b64encode(auth_raw).decode("ascii")

    headers = {
        "Authorization": f"Basic {auth_b64}",
    }

    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, method=method, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode("utf-8", errors="ignore")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"MediaMTX API {method} {path} failed: {e.code} {detail}")
    except Exception as e:
        raise RuntimeError(f"MediaMTX API {method} {path} failed: {e}")


def _ensure_mediamtx_path(device_id: str, source_rtsp: str, preload: bool = False) -> dict:
    name = _path_for(device_id)

    payload = {
        "source": source_rtsp,
        "sourceOnDemand": not preload,
        "sourceOnDemandStartTimeout": "10s",
        "sourceOnDemandCloseAfter": "10s",
    }

    snapshot = _mediamtx_paths_snapshot()
    items = list(snapshot.get("items") or [])
    existing = next((x for x in items if x.get("name") == name), None)

    if existing:
        current_source = existing.get("source")
        current_on_demand = existing.get("sourceOnDemand")
        desired_on_demand = not preload

        if current_source == source_rtsp and current_on_demand == desired_on_demand:
            return {"ok": True, "exists": True, "name": name}

        try:
            return _mediamtx_api_request("PATCH", f"/v3/config/paths/edit/{name}", payload)
        except Exception:
            try:
                _mediamtx_delete_path(device_id)
            except Exception:
                pass
            return _mediamtx_api_request("POST", f"/v3/config/paths/add/{name}", payload)

    return _mediamtx_api_request("POST", f"/v3/config/paths/add/{name}", payload)


def _mediamtx_delete_path(device_id: str) -> dict:
    name = _path_for(device_id)
    try:
        return _mediamtx_api_request("DELETE", f"/v3/config/paths/delete/{name}")
    except Exception as e:
        msg = str(e)
        if "404" in msg or "not found" in msg.lower():
            return {"ok": True, "missing": True}
        raise


def _mediamtx_paths_snapshot() -> dict:
    try:
        return _mediamtx_api_request("GET", "/v3/paths/list")
    except Exception:
        return {}


def _refresh_device_stream(device_id: str) -> dict:
    d = _get_device(device_id)

    if not d.profile_token:
        try:
            _mediamtx_delete_path(device_id)
        except Exception:
            pass
        return {"ok": True, "device_id": device_id, "removed": True, "reason": "no_profile"}

    req = _device_req(d)
    source_uri = _get_stream_uri(req, d.profile_token)
    source_rtsp = _rtsp_with_auth(source_uri, d.username, d.password)

    return _ensure_mediamtx_path(device_id, source_rtsp, preload=bool(d.preload_stream))


def _path_bytes_from_snapshot_row(row: Optional[dict]) -> int:
    if not row:
        return 0
    for key in ("bytesReceived", "bytes_received", "bytesreceived"):
        if key in row:
            try:
                return int(row.get(key) or 0)
            except Exception:
                return 0
    return 0


def _path_readers_from_snapshot_row(row: Optional[dict]) -> int:
    if not row:
        return 0
    readers_raw = row.get("readers", [])
    if isinstance(readers_raw, list):
        return len(readers_raw)
    try:
        return int(readers_raw or 0)
    except Exception:
        return 0


def _path_row_for_device(snapshot: dict, device_id: str) -> Optional[dict]:
    path_name = _path_for(device_id)
    for row in list(snapshot.get("items") or []):
        if row.get("name") == path_name:
            return row
    return None


def _update_path_monitor_state(device_id: str, row: Optional[dict]) -> dict:
    now = time.time()

    bytes_received = _path_bytes_from_snapshot_row(row)
    readers = _path_readers_from_snapshot_row(row)

    with _path_monitor_lock:
        st = _path_monitor_state.get(device_id)
        if st is None:
            st = {
                "last_bytes": int(bytes_received),
                "last_progress_ts": now,
                "no_progress_count": 0,
                "is_online": bool(row is not None and int(bytes_received) > 0),
            }
            _path_monitor_state[device_id] = st
            return {
                "progressed": True,
                "previous_online": None,
                "current_online": bool(st["is_online"]),
                "no_progress_count": int(st["no_progress_count"]),
                "seconds_since_progress": 0.0,
                "bytes_received": int(bytes_received),
                "readers": int(readers),
            }

        prev_bytes = int(st.get("last_bytes", 0))
        progressed = int(bytes_received) > prev_bytes

        if progressed:
            st["last_bytes"] = int(bytes_received)
            st["last_progress_ts"] = now
            st["no_progress_count"] = 0
        else:
            st["no_progress_count"] = int(st.get("no_progress_count", 0)) + 1

        previous_online = bool(st.get("is_online", False))
        seconds_since_progress = now - float(st.get("last_progress_ts", now))

        current_online = bool(
            row is not None and (
                progressed
                or int(readers) > 0
                or seconds_since_progress < STREAM_STALE_SEC
            )
        )

        st["is_online"] = current_online

        return {
            "progressed": progressed,
            "previous_online": previous_online,
            "current_online": current_online,
            "no_progress_count": int(st["no_progress_count"]),
            "seconds_since_progress": round(seconds_since_progress, 1),
            "bytes_received": int(bytes_received),
            "readers": int(readers),
        }


def _device_stream_status_from_snapshot(device: Device, snapshot: dict) -> dict:
    row = _path_row_for_device(snapshot, device.id)
    path_name = _path_for(device.id)

    out = {
        "device_id": device.id,
        "device_name": device.name,
        "path": path_name,
        "configured": bool(device.profile_token),
        "profile_encoding": (device.profile_encoding or "").upper() or None,
        "preload_stream": bool(device.preload_stream),
        "status": "down",
        "stream_up": False,
    }

    if not device.profile_token:
        out["status"] = "not_configured"
        return out

    if row is None:
        out["status"] = "down"
        out["online"] = False
        out["available"] = False
        out["ready"] = False
        out["source_ready"] = False
        out["bytes_received"] = 0
        out["readers"] = 0
        out["stalled"] = True
        out["seconds_since_progress"] = None
        out["no_progress_count"] = None
        return out

    def g(d, *names, default=None):
        for name in names:
            if name in d:
                return d[name]
        return default

    source_ready = bool(g(row, "sourceReady", "source_ready", default=False))
    ready = bool(g(row, "ready", default=False))
    online = bool(g(row, "online", default=False))
    available = bool(g(row, "available", default=False))
    source_on_demand = g(row, "sourceOnDemand", "source_on_demand", default=None)
    source = g(row, "source", default=None)
    bytes_received = _path_bytes_from_snapshot_row(row)
    readers = _path_readers_from_snapshot_row(row)

    monitor = _update_path_monitor_state(device.id, row)
    stream_up = bool(monitor["current_online"])
    seconds_since_progress = monitor["seconds_since_progress"]

    healthy_backend = bool(
        row is not None and (
            source_ready
            or (
                bool(device.preload_stream)
                and bool(source)
                and not bool(source_on_demand)
                and ready
            )
        )
    )

    recent_grace = (
        seconds_since_progress is not None and
        seconds_since_progress < 3.0
    )

    stalled = not stream_up and not healthy_backend

    status = "down"
    if readers > 0:
        status = "live"
    elif healthy_backend or recent_grace:
        status = "idle"

    out.update({
        "source_ready": source_ready,
        "ready": ready,
        "online": online,
        "available": available,
        "source_on_demand": source_on_demand,
        "source": source,
        "bytes_received": bytes_received,
        "readers": readers,
        "seconds_since_progress": monitor["seconds_since_progress"],
        "no_progress_count": monitor["no_progress_count"],
        "stalled": stalled,
        "stream_up": stream_up,
        "status": status,
    })

    return out


def _preload_stream_for_device(device: Device) -> None:
    if not device.profile_token or not device.preload_stream:
        return
    req = _device_req(device)
    source_uri = _get_stream_uri(req, device.profile_token)
    source_rtsp = _rtsp_with_auth(source_uri, device.username, device.password)
    _ensure_mediamtx_path(device.id, source_rtsp, preload=True)


def _ptz_status(device_id: str) -> dict:
    d = _get_device(device_id)
    req = _device_req(d)
    lock = _ptz_device_lock(device_id)
    with lock:
        ctx = _get_ptz_context(req, d.profile_token)
        out = {
            "device_id": device_id,
            "has_ptz": bool(ctx.has_ptz),
            "has_pan_tilt": bool(ctx.has_pan_tilt),
            "has_zoom": bool(ctx.has_zoom),
            "move_status": {"pan_tilt": None, "zoom": None},
        }

        if not ctx.has_ptz:
            return out

        try:
            status = ctx.ptz.GetStatus({"ProfileToken": ctx.profile_token})
        except Exception:
            return out

        pos = getattr(status, "Position", None)
        move = getattr(status, "MoveStatus", None)

        try:
            if pos and getattr(pos, "PanTilt", None) is not None:
                out["pan_tilt"] = {
                    "x": float(getattr(pos.PanTilt, "x", 0.0)),
                    "y": float(getattr(pos.PanTilt, "y", 0.0)),
                    "space": getattr(pos.PanTilt, "space", None),
                }
            else:
                out["pan_tilt"] = None
        except Exception:
            out["pan_tilt"] = None

        try:
            if pos and getattr(pos, "Zoom", None) is not None:
                out["zoom"] = {
                    "x": float(getattr(pos.Zoom, "x", 0.0)),
                    "space": getattr(pos.Zoom, "space", None),
                }
            else:
                out["zoom"] = None
        except Exception:
            out["zoom"] = None

    try:
        out["move_status"]["pan_tilt"] = getattr(move, "PanTilt", None)
        out["move_status"]["zoom"] = getattr(move, "Zoom", None)
    except Exception:
        pass

    return out


def _ptz_capabilities(device_id: str) -> dict:
    d = _get_device(device_id)
    req = _device_req(d)
    ctx = _get_ptz_context(req, d.profile_token)
    return {
        "device_id": device_id,
        "has_ptz": bool(ctx.has_ptz),
        "has_pan_tilt": bool(ctx.has_pan_tilt),
        "has_zoom": bool(ctx.has_zoom),
        "profile_token": ctx.profile_token,
        "pan_tilt_space": ctx.pan_tilt_space,
        "zoom_space": ctx.zoom_space,
    }


def _get_ptz_context(req: OnvifBase, profile_token: Optional[str]) -> PTZContextCache:
    fingerprint = _req_fingerprint(req)
    token = profile_token or ""

    with _ptz_context_cache_lock:
        cached = _ptz_context_cache.get(fingerprint)
        if cached and cached.profile_token == token:
            return cached

    cam = _cam(req)
    media = cam.create_media_service()
    profiles = media.GetProfiles() or []
    ptoken = token or (getattr(profiles[0], "token", None) if profiles else None)
    if not ptoken:
        raise RuntimeError("No media profile available.")

    ptz = None
    try:
        ptz = cam.create_ptz_service()
    except Exception:
        ctx = PTZContextCache(
            fingerprint=fingerprint,
            profile_token=ptoken,
            ptz=None,
            pan_tilt_space=None,
            zoom_space=None,
            has_ptz=False,
            has_pan_tilt=False,
            has_zoom=False,
        )
        with _ptz_context_cache_lock:
            _ptz_context_cache[fingerprint] = ctx
        return ctx

    pan_tilt_space = None
    zoom_space = None
    has_pan_tilt = False
    has_zoom = False

    try:
        profile_obj = next((p for p in profiles if getattr(p, "token", None) == ptoken), None)
        ptz_cfg = getattr(profile_obj, "PTZConfiguration", None) if profile_obj is not None else None
        ptz_cfg_token = getattr(ptz_cfg, "token", None)
        if ptz_cfg_token:
            opts = ptz.GetConfigurationOptions({"ConfigurationToken": ptz_cfg_token})
            pan_spaces = getattr(getattr(opts, "Spaces", None), "ContinuousPanTiltVelocitySpace", None) or []
            zoom_spaces = getattr(getattr(opts, "Spaces", None), "ContinuousZoomVelocitySpace", None) or []
            if pan_spaces:
                has_pan_tilt = True
                pan_tilt_space = getattr(pan_spaces[0], "URI", None)
            if zoom_spaces:
                has_zoom = True
                zoom_space = getattr(zoom_spaces[0], "URI", None)
    except Exception:
        pass

    ctx = PTZContextCache(
        fingerprint=fingerprint,
        profile_token=ptoken,
        ptz=ptz,
        pan_tilt_space=pan_tilt_space,
        zoom_space=zoom_space,
        has_ptz=True,
        has_pan_tilt=has_pan_tilt,
        has_zoom=has_zoom,
    )
    with _ptz_context_cache_lock:
        _ptz_context_cache[fingerprint] = ctx
    return ctx


def _ptz_continuous_move(device_id: str, pan: float, tilt: float, zoom: float) -> dict:
    pan = float(pan)
    tilt = float(tilt)
    zoom = float(zoom)
    if abs(pan) < 0.001 and abs(tilt) < 0.001 and abs(zoom) < 0.001:
        _clear_ptz_watchdog(device_id)
        return _ptz_stop(device_id, reason="zero_velocity")

    d = _get_device(device_id)
    req = _device_req(d)
    ctx = _get_ptz_context(req, d.profile_token)
    if not ctx.has_ptz:
        raise RuntimeError("Device has no PTZ")

    velocity = {}
    if ctx.has_pan_tilt:
        velocity["PanTilt"] = {"x": pan, "y": tilt}
        if ctx.pan_tilt_space:
            velocity["PanTilt"]["space"] = ctx.pan_tilt_space
    if ctx.has_zoom:
        velocity["Zoom"] = {"x": zoom}
        if ctx.zoom_space:
            velocity["Zoom"]["space"] = ctx.zoom_space

    lock = _ptz_device_lock(device_id)
    with lock:
        req_move = {"ProfileToken": ctx.profile_token, "Velocity": velocity}
        ctx.ptz.ContinuousMove(req_move)

    _dispatch_ptz_manual_control_trigger(
        device_id,
        True,
        reason="move",
        pan=pan,
        tilt=tilt,
        zoom=zoom,
    )

    return {"ok": True, "device_id": device_id}


def _ptz_stop(device_id: str, reason: str = "stop") -> dict:
    d = _get_device(device_id)
    req = _device_req(d)
    ctx = _get_ptz_context(req, d.profile_token)
    if not ctx.has_ptz:
        _dispatch_ptz_manual_control_trigger(device_id, False, reason=reason)
        return {"ok": True, "device_id": device_id}

    lock = _ptz_device_lock(device_id)
    with lock:
        try:
            ctx.ptz.Stop({"ProfileToken": ctx.profile_token, "PanTilt": True, "Zoom": True})
        except Exception:
            pass
    _dispatch_ptz_manual_control_trigger(device_id, False, reason=reason)
    return {"ok": True, "device_id": device_id}


def _schedule_ptz_watchdog_stop(device_id: str) -> None:
    _clear_ptz_watchdog(device_id)

    with _ptz_watchdog_lock:
        t = threading.Timer(PTZ_WATCHDOG_SEC, lambda: _ptz_watchdog_stop(device_id))
        t.daemon = True
        _ptz_watchdogs[device_id] = t
        t.start()


@app.get("/api/events/stream/{device_id}")
async def events_stream(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    q: asyncio.Queue = asyncio.Queue(maxsize=500)

    with _event_sub_lock:
        _event_subscribers.setdefault(device_id, []).append(q)

    async def gen():
        yield f"event: hello\ndata: {json.dumps({'device_id': device_id, 'event_debug': EVENT_DEBUG})}\n\n"
        try:
            while True:
                item = await q.get()
                yield f"data: {json.dumps(item)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            with _event_sub_lock:
                lst = _event_subscribers.get(device_id, [])
                if q in lst:
                    lst.remove(q)
                if not lst:
                    _event_subscribers.pop(device_id, None)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/events/start")
async def events_start(req: EventsStartRequest):
    device_id = req.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    _start_event_worker(device_id, req)
    return {"ok": True, "device_id": device_id, "running": True}


@app.post("/api/events/stop/{device_id}")
async def events_stop(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    _stop_event_worker(device_id)
    return {"ok": True, "device_id": device_id, "running": False}


@app.get("/api/events/properties/{device_id}")
async def events_properties(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    d = _get_device(device_id)
    req = _device_req(d)

    try:
        data = await asyncio.to_thread(_get_event_properties, req)
        return {"ok": True, "device_id": device_id, **data}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"GetEventProperties failed: {e}")


@app.post("/api/devices/{device_id}/refresh-stream")
async def refresh_device_stream(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    try:
        out = await asyncio.to_thread(_refresh_device_stream, device_id)
        request_recorders_refresh()
        return {"ok": True, "device_id": device_id, "result": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Refresh stream failed: {e}")


@app.get("/api/devices")
def list_devices():
    devs = _load_devices()
    return {"devices": [_dump(d) for d in devs]}


@app.post("/api/devices")
def create_device(dev: DeviceIn):
    devs = _load_devices()
    new = Device(id=uuid.uuid4().hex[:12], **_dump(dev))
    devs.append(new)
    _save_devices(devs)
    _invalidate_ptz_cache(new.id)

    req = EventsStartRequest(
        device_id=new.id,
        ip=new.ip,
        onvif_port=new.onvif_port,
        username=new.username,
        password=new.password,
    )
    _start_event_worker(new.id, req)

    if new.preload_stream and new.profile_token:
        try:
            _preload_stream_for_device(new)
        except Exception:
            pass

    request_recorders_refresh()

    return {"ok": True, "device": _dump(new)}


@app.put("/api/devices/{device_id}")
def update_device(device_id: str, dev_in: DeviceIn):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    dev = _update_device(device_id, dev_in)
    request_recorders_refresh()
    return {"ok": True, "device": _dump(dev)}


@app.delete("/api/devices/{device_id}")
def delete_device(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    devs = _load_devices()
    new_devs = [d for d in devs if d.id != device_id]
    if len(new_devs) == len(devs):
        raise HTTPException(status_code=404, detail="Device not found")

    _save_devices(new_devs)
    _invalidate_ptz_cache(device_id)
    _stop_event_worker(device_id)

    with _path_monitor_lock:
        _path_monitor_state.pop(device_id, None)

    try:
        _mediamtx_delete_path(device_id)
    except Exception:
        pass

    request_recorders_refresh()

    return {"ok": True}


@app.post("/api/profiles")
async def profiles(req: OnvifBase):
    def _work():
        cam = _cam(req)
        media = cam.create_media_service()
        profiles = media.GetProfiles() or []
        out = [_profile_summary(p) for p in profiles]
        for i, p in enumerate(out):
            p["recommended"] = i == 0 and bool(p.get("browser_compatible"))
        return out

    try:
        out = await asyncio.to_thread(_work)
        return {"profiles": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF profiles failed: {e}")


@app.get("/api/streams")
def streams():
    devs = _load_devices()
    return {"streams": [_path_for(d.id) for d in devs if d.profile_token]}


@app.get("/api/status/{device_id}")
def status(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    d = _get_device(device_id)
    return {
        "device_id": device_id,
        "path": _path_for(device_id),
        "configured": bool(d.profile_token),
        "ready": bool(d.profile_token),
        "running": None,
        "exit_code": None,
        "log_tail": None,
        "profile_encoding": (d.profile_encoding or "").upper() or None,
        "preload_stream": bool(d.preload_stream),
    }


@app.post("/api/start")
async def start(req: StartRequest):
    if not req.profile_token:
        raise HTTPException(status_code=400, detail="Missing profile_token.")

    device_id = req.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id.")

    device = None
    try:
        device = _get_device(device_id)
    except Exception:
        pass

    if device and device.preload_stream and device.profile_token == req.profile_token:
        try:
            snapshot = await asyncio.to_thread(_mediamtx_paths_snapshot)
            st = _device_stream_status_from_snapshot(device, snapshot)

            if st.get("status") in {"idle", "live"}:
                return {
                    "ok": True,
                    "device_id": device_id,
                    "path": _path_for(device_id),
                    "preloaded": True,
                    "skipped_onvif": True,
                }
        except Exception:
            pass

    try:
        encoding = await asyncio.to_thread(_find_profile_encoding, req, req.profile_token)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF profile check failed: {e}")

    if (encoding or "").upper() != "H264":
        raise HTTPException(
            status_code=400,
            detail=(
                f"Selected profile uses {encoding or 'unknown'}; browser playback needs H264. "
                f"Pick an H264 profile in Devices."
            ),
        )

    try:
        source_uri = await asyncio.to_thread(_get_stream_uri, req, req.profile_token)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF stream uri failed: {e}")

    source_rtsp = _rtsp_with_auth(source_uri, req.username, req.password)

    try:
        await asyncio.to_thread(
            _ensure_mediamtx_path,
            device_id,
            source_rtsp,
            bool(device.preload_stream) if device else False,
        )
        request_recorders_refresh()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MediaMTX path setup failed: {e}")

    return {"ok": True, "device_id": device_id, "path": _path_for(device_id)}


@app.post("/api/stop/{device_id}")
async def stop(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    try:
        d = _get_device(device_id)
    except Exception:
        d = None

    if d and d.preload_stream:
        return {"ok": True, "device_id": device_id, "kept_preloaded_path": True}

    try:
        await asyncio.to_thread(_mediamtx_delete_path, device_id)
        return {"ok": True, "device_id": device_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Stop failed: {e}")


@app.get("/api/device-status/{device_id}")
def device_status(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    d = _get_device(device_id)
    snapshot = _mediamtx_paths_snapshot()
    return _device_stream_status_from_snapshot(d, snapshot)


@app.get("/api/device-status")
def all_device_status():
    snapshot = _mediamtx_paths_snapshot()
    devs = _load_devices()
    items = [_device_stream_status_from_snapshot(d, snapshot) for d in devs]
    return {"items": items}


@app.get("/api/ptz/capabilities/{device_id}")
async def ptz_capabilities(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    try:
        return await asyncio.to_thread(_ptz_capabilities, device_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PTZ capabilities failed: {e}")


@app.get("/api/ptz/status/{device_id}")
async def ptz_status(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    try:
        return await asyncio.to_thread(_ptz_status, device_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PTZ status failed: {e}")


@app.post("/api/ptz/move/{device_id}")
async def ptz_move(device_id: str, req: PTZMoveRequest):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    try:
        out = await asyncio.to_thread(_ptz_continuous_move, device_id, req.pan, req.tilt, req.zoom)
        _schedule_ptz_watchdog_stop(device_id)
        return out
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PTZ move failed: {e}")


@app.post("/api/ptz/stop/{device_id}")
async def ptz_stop(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    try:
        _clear_ptz_watchdog(device_id)
        return await asyncio.to_thread(_ptz_stop, device_id, "api_stop")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PTZ stop failed: {e}")


@app.on_event("startup")
def _on_startup():
    devs = _load_devices()

    try:
        set_recording_path_refresher(_refresh_device_stream)
        start_recording_service()
    except Exception:
        pass

    try:
        global _flow_monitor_thread
        _flow_monitor_stop.clear()
        _flow_monitor_thread = threading.Thread(
            target=_poll_device_state_changes,
            daemon=True,
            name="flow-monitor",
        )
        _flow_monitor_thread.start()
    except Exception:
        pass

    try:
        start_physical_io_monitor(dispatch_flow_trigger)
    except Exception:
        pass

    try:
        _ensure_event_workers(devs)
    except Exception:
        pass

    for d in devs:
        try:
            _preload_stream_for_device(d)
        except Exception:
            pass

    request_recorders_refresh()


@app.on_event("shutdown")
def _on_shutdown():
    with _event_worker_lock:
        workers = list(_event_workers.values())
        _event_workers.clear()

    for w in workers:
        try:
            w.stop_flag.set()
        except Exception:
            pass

    _flow_monitor_stop.set()
    stop_physical_io_monitor()
    stop_recording_service()

    with _ptz_watchdog_lock:
        timers = list(_ptz_watchdogs.values())
        _ptz_watchdogs.clear()

    for t in timers:
        try:
            t.cancel()
        except Exception:
            pass