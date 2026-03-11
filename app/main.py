# main.py
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
import ssl
from mimetypes import guess_extension
from typing import Optional, Dict, Any, List
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from onvif import ONVIFCamera
from dataclasses import dataclass
from datetime import datetime, timezone

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")

DEVICES_JSON = DATA_DIR / "devices.json"

MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://mediamtx:9997").rstrip("/")
MEDIAMTX_API_USER = os.getenv("MEDIAMTX_API_USER", "apiuser")
MEDIAMTX_API_PASS = os.getenv("MEDIAMTX_API_PASS", "apipass")

PTZ_WATCHDOG_SEC = float(os.getenv("PTZ_WATCHDOG_SEC", "0.25"))

EVENT_DEBUG = str(os.getenv("EVENT_DEBUG", "1")).strip().lower() in {"1", "true", "yes", "on"}

SNAPSHOTS_DIR = DATA_DIR / "snapshots"
SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
SNAPSHOTS_INDEX_JSON = DATA_DIR / "snapshots.json"
ACTIONS_JSON = DATA_DIR / "actions.json"
ACTION_EVENTS_JSON = DATA_DIR / "action_events.json"


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

_snapshots_lock = threading.RLock()
_actions_lock = threading.RLock()
_action_events_lock = threading.RLock()
_action_runtime_lock = threading.RLock()
_last_device_states: Dict[str, bool] = {}
_action_monitor_stop = threading.Event()
_action_monitor_thread: Optional[threading.Thread] = None


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


@app.get("/", response_class=HTMLResponse)
def index_page():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/live", response_class=HTMLResponse)
def live_page():
    return (STATIC_DIR / "live.html").read_text(encoding="utf-8")


@app.get("/devices", response_class=HTMLResponse)
def devices_page():
    return (STATIC_DIR / "devices.html").read_text(encoding="utf-8")


@app.get("/events", response_class=HTMLResponse)
def events_page():
    return (STATIC_DIR / "events.html").read_text(encoding="utf-8")


@app.get("/actions", response_class=HTMLResponse)
def actions_page():
    return (STATIC_DIR / "actions.html").read_text(encoding="utf-8")


@app.get("/playback", response_class=HTMLResponse)
def playback_page():
    return (STATIC_DIR / "playback.html").read_text(encoding="utf-8")


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
    allow_topics: Optional[List[str]] = None
    preload_stream: bool = True


class Device(DeviceIn):
    id: str


class EventsStartRequest(OnvifBase):
    device_id: str


class AllowListRequest(BaseModel):
    allow_topics: List[str] = Field(default_factory=list)


class PTZMoveRequest(BaseModel):
    pan: float = 0.0
    tilt: float = 0.0
    zoom: float = 0.0


class SnapshotRequest(BaseModel):
    event: str = Field(default="manual", min_length=1)


class ActionConditionModel(BaseModel):
    type: str = Field(..., min_length=1)
    device_id: str = Field(..., min_length=1)
    topic: Optional[str] = None


class ActionTargetModel(BaseModel):
    type: str = Field(..., min_length=1)
    camera_device_id: Optional[str] = None


class ActionRuleIn(BaseModel):
    name: str = Field(..., min_length=1)
    enabled: bool = True
    conditions: List[ActionConditionModel] = Field(default_factory=list)
    actions: List[ActionTargetModel] = Field(default_factory=list)


class ActionRule(ActionRuleIn):
    id: str
    created_at: str
    updated_at: str


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


def _normalize_device_dict(d: dict) -> dict:
    out = dict(d)
    if "preload_stream" not in out:
        out["preload_stream"] = True
    if "allow_topics" not in out or out["allow_topics"] is None:
        out["allow_topics"] = []
    out["allow_topics"] = [_normalize_allow_topic(x) for x in out["allow_topics"] if _normalize_allow_topic(x)]
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
            return devs[i]
    raise HTTPException(status_code=404, detail="Device not found")


def _update_device_allowlist(device_id: str, allow_topics: List[str]) -> None:
    devs = _load_devices()
    idx = None
    for i, d in enumerate(devs):
        if d.id == device_id:
            idx = i
            break
    if idx is None:
        raise HTTPException(status_code=404, detail="Device not found")

    d = devs[idx]
    normalized: List[str] = []
    seen = set()
    for t in allow_topics:
        t2 = _normalize_allow_topic(t)
        if t2 and t2 not in seen:
            seen.add(t2)
            normalized.append(t2)

    devs[idx] = Device(**{**_dump(d), "id": d.id, "allow_topics": normalized})
    _save_devices(devs)


def _load_snapshot_index() -> dict:
    if not SNAPSHOTS_INDEX_JSON.exists():
        return {"items": []}
    try:
        raw = json.loads(SNAPSHOTS_INDEX_JSON.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("items"), list):
            return raw
    except Exception:
        pass
    return {"items": []}


def _save_snapshot_index(data: dict) -> None:
    tmp = SNAPSHOTS_INDEX_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(SNAPSHOTS_INDEX_JSON)


def _append_snapshot_item(item: dict) -> None:
    with _snapshots_lock:
        data = _load_snapshot_index()
        items = list(data.get("items", []))
        items.insert(0, item)
        data["items"] = items[:1000]
        _save_snapshot_index(data)


def _list_snapshot_items(device_id: Optional[str] = None) -> List[dict]:
    with _snapshots_lock:
        items = list(_load_snapshot_index().get("items", []))
    if device_id:
        items = [x for x in items if x.get("device_id") == device_id]
    return items


def _snapshot_rel_url(path: Path) -> str:
    rel = path.relative_to(DATA_DIR).as_posix()
    return f"/data/{rel}"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _load_actions() -> List[dict]:
    if not ACTIONS_JSON.exists():
        return []
    try:
        raw = json.loads(ACTIONS_JSON.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("items"), list):
            return list(raw.get("items", []))
    except Exception:
        pass
    return []


def _save_actions(items: List[dict]) -> None:
    tmp = ACTIONS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}, indent=2), encoding="utf-8")
    tmp.replace(ACTIONS_JSON)


def _load_action_events() -> List[dict]:
    if not ACTION_EVENTS_JSON.exists():
        return []
    try:
        raw = json.loads(ACTION_EVENTS_JSON.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("items"), list):
            return list(raw.get("items", []))
    except Exception:
        pass
    return []


def _save_action_events(items: List[dict]) -> None:
    tmp = ACTION_EVENTS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}, indent=2), encoding="utf-8")
    tmp.replace(ACTION_EVENTS_JSON)


def _append_action_event(item: dict) -> dict:
    with _action_events_lock:
        items = _load_action_events()
        items.insert(0, item)
        _save_action_events(items[:2000])
    return item


def _list_action_events(device_id: Optional[str] = None, limit: int = 200) -> List[dict]:
    items = _load_action_events()
    if device_id:
        items = [x for x in items if x.get("device_id") == device_id or x.get("source_device_id") == device_id]
    return items[:max(1, min(int(limit or 200), 1000))]


def _normalize_action_condition(c: dict) -> dict:
    ctype = (c.get("type") or "").strip()
    did = (c.get("device_id") or "").strip()
    topic = _normalize_allow_topic(c.get("topic")) if ctype == "onvif_event" else None
    if ctype not in {"onvif_event", "device_offline", "device_back_online"}:
        raise HTTPException(status_code=400, detail=f"Unsupported condition type: {ctype}")
    if not did:
        raise HTTPException(status_code=400, detail="Condition device_id is required")
    _get_device(did)
    out = {"type": ctype, "device_id": did}
    if ctype == "onvif_event":
        if not topic:
            raise HTTPException(status_code=400, detail="ONVIF event condition requires topic")
        out["topic"] = topic
    return out


def _normalize_action_target(a: dict) -> dict:
    atype = (a.get("type") or "").strip()
    if atype == "create_log_event":
        return {"type": atype}
    if atype == "take_snapshot":
        cam = (a.get("camera_device_id") or "").strip()
        if not cam:
            raise HTTPException(status_code=400, detail="Snapshot action requires camera_device_id")
        _get_device(cam)
        return {"type": atype, "camera_device_id": cam}
    raise HTTPException(status_code=400, detail=f"Unsupported action type: {atype}")


def _normalize_action_rule_payload(data: dict, existing_id: Optional[str] = None, created_at: Optional[str] = None) -> dict:
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Action name is required")
    conditions = [_normalize_action_condition(x or {}) for x in list(data.get("conditions") or [])]
    actions = [_normalize_action_target(x or {}) for x in list(data.get("actions") or [])]
    if not conditions:
        raise HTTPException(status_code=400, detail="At least one condition is required")
    if not actions:
        raise HTTPException(status_code=400, detail="At least one action is required")
    return {
        "id": existing_id or uuid.uuid4().hex[:12],
        "name": name,
        "enabled": bool(data.get("enabled", True)),
        "conditions": conditions,
        "actions": actions,
        "created_at": created_at or _utc_now_iso(),
        "updated_at": _utc_now_iso(),
    }


def _canonical_topic_aliases(topic: Optional[str]) -> set[str]:
    t = _normalize_allow_topic(topic)
    if not t:
        return set()

    aliases = {t}

    low = t.lower()

    # Motion
    if (
        "motion" in low
        or "ismotion" in low
        or "cellmotiondetector" in low
        or t == "VideoSource/MotionAlarm"
    ):
        aliases.update({
            "VideoSource/MotionAlarm",
            "RuleEngine/CellMotionDetector/Motion",
            "IsMotion/Rule/VideoAnalyticsConfigurationToken/VideoSourceConfigurationToken",
        })

    # Objects inside / field detector
    if (
        "objectsinside" in low
        or "fielddetector" in low
        or "isinside" in low
    ):
        aliases.update({
            "RuleEngine/FieldDetector/ObjectsInside",
            "IsInside/Rule/VideoAnalyticsConfigurationToken/VideoSourceConfigurationToken",
        })

    # Digital input
    if "digitalinput" in low or "inputtoken" in low:
        aliases.update({
            "Device/Trigger/DigitalInput",
        })

    # Relay
    if "relay" in low or "relaytoken" in low:
        aliases.update({
            "Device/Trigger/Relay",
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


def _get_action_topic_allowlist(device_id: str) -> set[str]:
    allow = set()
    try:
        with _actions_lock:
            items = _load_actions()
        for rule in items:
            if not rule.get("enabled", True):
                continue
            for condition in rule.get("conditions", []):
                if condition.get("type") != "onvif_event":
                    continue
                if condition.get("device_id") != device_id:
                    continue
                topic = _normalize_allow_topic(condition.get("topic"))
                if topic:
                    allow.add(topic)
    except Exception:
        pass
    return allow


def _get_effective_event_allowlist(device_id: str) -> set[str]:
    topics = set(_get_action_topic_allowlist(device_id))
    return {t for t in topics if t}

def _match_onvif_condition(condition: dict, event_payload: dict) -> bool:
    extra = event_payload.get("extra") or {}
    if (condition.get("device_id") or "") != (event_payload.get("device_id") or ""):
        return False
    candidates = [
        extra.get("matched_by"),
        extra.get("topic_path"),
        extra.get("guessed_topic"),
        extra.get("fallback_key"),
    ]
    allow = _normalize_allow_topic(condition.get("topic"))
    for c in candidates:
        c2 = _normalize_allow_topic(c)
        if c2 and _topic_matches_allowlist(c2, {allow}):
            return True
    return False


def _run_action_rule(rule: dict, trigger: dict) -> None:
    action_results = []
    for action in rule.get("actions", []):
        atype = action.get("type")
        if atype == "create_log_event":
            action_results.append({"type": atype, "ok": True})
        elif atype == "take_snapshot":
            cam = action.get("camera_device_id")
            try:
                snap = _take_snapshot(cam, f"action:{rule.get('name') or rule.get('id')}")
                action_results.append({"type": atype, "ok": True, "camera_device_id": cam, "snapshot": snap})
            except Exception as e:
                action_results.append({"type": atype, "ok": False, "camera_device_id": cam, "error": str(e)})
    device_name = None
    try:
        device_name = _get_device(trigger.get("device_id") or trigger.get("source_device_id")).name
    except Exception:
        pass
    item = {
        "id": uuid.uuid4().hex[:12],
        "ts": _utc_now_iso(),
        "kind": trigger.get("kind") or "action",
        "message": trigger.get("message") or rule.get("name") or "Action event",
        "action_rule_id": rule.get("id"),
        "action_rule_name": rule.get("name"),
        "device_id": trigger.get("device_id") or trigger.get("source_device_id"),
        "device_name": device_name,
        "source_device_id": trigger.get("source_device_id") or trigger.get("device_id"),
        "condition": trigger.get("condition"),
        "trigger": trigger,
        "results": action_results,
    }
    _append_action_event(item)


def _evaluate_actions_for_trigger(trigger: dict) -> None:
    try:
        with _actions_lock:
            rules = _load_actions()
        for rule in rules:
            if not rule.get("enabled", True):
                continue
            matched = False
            for condition in rule.get("conditions", []):
                ctype = condition.get("type")
                if ctype == "onvif_event" and trigger.get("kind") == "onvif_event":
                    matched = _match_onvif_condition(condition, trigger)
                elif ctype == "device_offline" and trigger.get("kind") == "device_offline":
                    matched = condition.get("device_id") == trigger.get("device_id")
                elif ctype == "device_back_online" and trigger.get("kind") == "device_back_online":
                    matched = condition.get("device_id") == trigger.get("device_id")
                if matched:
                    _run_action_rule(rule, {"condition": condition, **trigger})
                    break
    except Exception:
        pass


def _poll_device_state_changes() -> None:
    while not _action_monitor_stop.wait(5.0):
        try:
            devs = _load_devices()
            snapshot = _mediamtx_paths_snapshot()
            for d in devs:
                st = _device_stream_status_from_snapshot(d, snapshot)
                is_online = bool(st.get("stream_up"))
                with _action_runtime_lock:
                    prev = _last_device_states.get(d.id)
                    _last_device_states[d.id] = is_online
                if prev is None:
                    continue
                if prev and not is_online:
                    _evaluate_actions_for_trigger({"kind": "device_offline", "device_id": d.id, "message": "Device offline"})
                elif (not prev) and is_online:
                    _evaluate_actions_for_trigger({"kind": "device_back_online", "device_id": d.id, "message": "Device back online"})
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


def _collect_topic_paths(topic_set_obj) -> List[dict]:
    results: List[dict] = []
    seen: set[str] = set()

    def add_path(path: str) -> None:
        path = _normalize_allow_topic(path)
        if not path or path in seen:
            return
        seen.add(path)
        parts = [p for p in path.split("/") if p]
        results.append({
            "path": path,
            "name": parts[-1] if parts else path,
        })

    def walk_elem(elem, prefix: str = "") -> None:
        if elem is None:
            return

        tag = getattr(elem, "tag", None)
        name = _strip_ns(tag) if tag else None

        current = prefix
        if name:
            current = f"{prefix}/{name}" if prefix else name
            add_path(current)

        try:
            children = list(elem)
        except Exception:
            children = []

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

    # Motion
    if "ismotion" in keys and (has_vs_token or has_va_token or has_rule):
        return "RuleEngine/CellMotionDetector/Motion"

    # Objects inside / field detector
    if "isinside" in keys and (has_vs_token or has_va_token or has_rule):
        return "RuleEngine/FieldDetector/ObjectsInside"

    # Digital input
    if "inputtoken" in keys:
        return "Device/Trigger/DigitalInput"

    # Relay
    if "relaytoken" in keys:
        return "Device/Trigger/Relay"

    # Tamper
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

    # Ignore zeep / object repr junk
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

    # Do not fall back to str(topic_obj) because that produces a zeep object repr,
    # not an actual topic path.
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
    topics = _collect_topic_paths(getattr(props, "TopicSet", None))
    return {
        "topics": topics,
        "fixed_topic_set": bool(topics),
        "raw_topic_set": _serialize_zeep_obj(getattr(props, "TopicSet", None)),
        "raw": _serialize_zeep_obj(props),
    }


def _get_allowlist_snapshot(device_id: str) -> List[str]:
    try:
        d = _get_device(device_id)
        return list(d.allow_topics or [])
    except Exception:
        return []


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
        _evaluate_actions_for_trigger({"kind": "onvif_event", "device_id": device_id, "message": msg, "extra": extra or {}, "ts": payload["ts"]})


ALLOW_REFRESH_S = 2.0


def _onvif_event_worker(device_id: str, req: OnvifBase, stop_flag: threading.Event, fingerprint: str) -> None:
    allow_set = _get_effective_event_allowlist(device_id)
    last_allow_refresh = 0.0
    max_messages = 20

    try:
        cam = _cam(req)
        events = cam.create_events_service()

        try:
            events.CreatePullPointSubscription({})
        except Exception:
            events.CreatePullPointSubscription({"InitialTerminationTime": "PT5M"})

        pullpoint = cam.create_pullpoint_service()

        _emit_event(device_id, "ok", "Subscribed to ONVIF events (actions-aware filtering enabled).")

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

                    # If no topics are referenced by Actions for this device,
                    # do not pass any ONVIF events through.
                    if not allow_set:
                        matched = False
                    else:
                        for candidate in match_candidates:
                            if _topic_matches_allowlist(candidate, allow_set):
                                matched = True
                                matched_by = candidate
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
                                "Dropped event because it did not match action topics",
                                {
                                    "topic_text": topic_text,
                                    "topic_path": topic_path,
                                    "guessed_topic": guessed_topic,
                                    "fallback_key": fallback_key,
                                    "match_candidates": match_candidates,
                                    "allow_topics": sorted(list(allow_set)),
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
                            "changed": changed,
                            "items": items,
                        },
                    )

            except Exception as e:
                _emit_event(device_id, "warn", f"PullMessages error: {e}")
                time.sleep(0.5)

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


def _get_snapshot_uri(req: OnvifBase, profile_token: Optional[str]) -> str:
    cam = _cam(req)
    media = cam.create_media_service()
    profiles = media.GetProfiles() or []
    token = profile_token or (getattr(profiles[0], "token", None) if profiles else None)
    if not token:
        raise RuntimeError("No media profile available.")
    resp = media.GetSnapshotUri({"ProfileToken": token})
    uri = getattr(resp, "Uri", None)
    if not uri:
        raise RuntimeError("Camera did not provide snapshot URI.")
    return str(uri)


def _http_get_bytes_with_auth(url: str, username: str, password: str) -> tuple[bytes, Optional[str]]:
    insecure_ctx = ssl.create_default_context()
    insecure_ctx.check_hostname = False
    insecure_ctx.verify_mode = ssl.CERT_NONE

    password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    password_mgr.add_password(None, url, username, password)

    basic_handler = urllib.request.HTTPBasicAuthHandler(password_mgr)
    digest_handler = urllib.request.HTTPDigestAuthHandler(password_mgr)
    https_handler = urllib.request.HTTPSHandler(context=insecure_ctx)

    opener = urllib.request.build_opener(digest_handler, basic_handler, https_handler)

    req = urllib.request.Request(url, method="GET")
    with opener.open(req, timeout=10) as resp:
        return resp.read(), resp.headers.get("Content-Type")
        

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


def _take_snapshot(device_id: str, event_name: str = "manual") -> dict:
    device = _get_device(device_id)
    req = _device_req(device)

    snapshot_uri = _get_snapshot_uri(req, device.profile_token)
    content, content_type = _http_get_bytes_with_auth(
        snapshot_uri,
        device.username,
        device.password,
    )

    ext = ".jpg"
    if content_type:
        guessed = guess_extension(content_type.split(";")[0].strip().lower())
        if guessed:
            ext = ".jpg" if guessed == ".jpe" else guessed

    ts = datetime.now(timezone.utc)
    stamp = ts.strftime("%Y%m%dT%H%M%S.%fZ")
    device_dir = SNAPSHOTS_DIR / device_id
    device_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{stamp}-{uuid.uuid4().hex[:8]}{ext}"
    path = device_dir / filename
    path.write_bytes(content)

    item = {
        "id": uuid.uuid4().hex[:12],
        "device_id": device_id,
        "device_name": device.name,
        "event": (event_name or "manual").strip() or "manual",
        "ts": ts.isoformat().replace("+00:00", "Z"),
        "filename": filename,
        "content_type": content_type or "image/jpeg",
        "url": _snapshot_rel_url(path),
        "size_bytes": len(content),
    }
    _append_snapshot_item(item)
    return item


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

    try:
        return _mediamtx_api_request("POST", f"/v3/config/paths/add/{name}", payload)
    except Exception as add_err:
        msg = str(add_err).lower()

        # If the path already exists, leave it alone.
        # Do not delete/recreate it, because that briefly breaks WHEP viewers.
        if "already exists" in msg or "path already exists" in msg:
            return {"ok": True, "exists": True, "name": name}

        raise
    

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


def _path_row_to_status(row: Optional[dict]) -> dict:
    if not row:
        return {
            "source_ready": False,
            "ready": False,
            "source_on_demand": None,
            "source": None,
            "bytes_received": None,
            "readers": 0,
        }

    source = row.get("source")
    source_ready = bool(row.get("sourceReady"))
    ready = bool(row.get("ready"))
    source_on_demand = row.get("sourceOnDemand")
    bytes_received = row.get("bytesReceived")
    readers = row.get("readers") or []
    readers_count = len(readers) if isinstance(readers, list) else 0

    return {
        "source_ready": source_ready,
        "ready": ready,
        "source_on_demand": source_on_demand,
        "source": source,
        "bytes_received": bytes_received,
        "readers": readers_count,
    }


def _device_stream_status_from_snapshot(device: Device, snapshot: dict) -> dict:
    path_name = _path_for(device.id)
    items = list(snapshot.get("items") or [])

    row = None
    for x in items:
        if x.get("name") == path_name:
            row = x
            break

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
        return out

    def g(d, *names, default=None):
        for name in names:
            if name in d:
                return d[name]
        return default

    source_ready = bool(g(row, "sourceReady", "source_ready", default=False))
    ready = bool(g(row, "ready", default=False))
    source_on_demand = g(row, "sourceOnDemand", "source_on_demand", default=None)
    source = g(row, "source", default=None)
    bytes_received = g(row, "bytesReceived", "bytes_received", "bytesreceived", default=0) or 0
    readers_raw = g(row, "readers", default=[])
    readers = len(readers_raw) if isinstance(readers_raw, list) else int(readers_raw or 0)

    out.update({
        "source_ready": source_ready,
        "ready": ready,
        "source_on_demand": source_on_demand,
        "source": source,
        "bytes_received": bytes_received,
        "readers": readers,
    })

    stream_up = any([
        source_ready,
        ready,
        bytes_received > 0,
        readers > 0,
        bool(source),
    ])

    out["stream_up"] = stream_up
    out["status"] = "live" if stream_up else ("idle" if bool(device.preload_stream) else "down")
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
    d = _get_device(device_id)
    req = _device_req(d)
    ctx = _get_ptz_context(req, d.profile_token)
    if not ctx.has_ptz:
        raise RuntimeError("Device has no PTZ")

    velocity = {}
    if ctx.has_pan_tilt:
        velocity["PanTilt"] = {"x": float(pan), "y": float(tilt)}
        if ctx.pan_tilt_space:
            velocity["PanTilt"]["space"] = ctx.pan_tilt_space
    if ctx.has_zoom:
        velocity["Zoom"] = {"x": float(zoom)}
        if ctx.zoom_space:
            velocity["Zoom"]["space"] = ctx.zoom_space

    lock = _ptz_device_lock(device_id)
    with lock:
        req_move = {"ProfileToken": ctx.profile_token, "Velocity": velocity}
        ctx.ptz.ContinuousMove(req_move)

    return {"ok": True, "device_id": device_id}


def _ptz_stop(device_id: str) -> dict:
    d = _get_device(device_id)
    req = _device_req(d)
    ctx = _get_ptz_context(req, d.profile_token)
    if not ctx.has_ptz:
        return {"ok": True, "device_id": device_id}

    lock = _ptz_device_lock(device_id)
    with lock:
        try:
            ctx.ptz.Stop({"ProfileToken": ctx.profile_token, "PanTilt": True, "Zoom": True})
        except Exception:
            pass
    return {"ok": True, "device_id": device_id}


def _schedule_ptz_watchdog_stop(device_id: str) -> None:
    with _ptz_watchdog_lock:
        old = _ptz_watchdogs.pop(device_id, None)
        if old:
            try:
                old.cancel()
            except Exception:
                pass

        t = threading.Timer(PTZ_WATCHDOG_SEC, lambda: _ptz_stop(device_id))
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


@app.get("/api/events/allowlist/{device_id}")
def events_allowlist_get(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    d = _get_device(device_id)
    return {"device_id": device_id, "allow_topics": list(d.allow_topics or [])}


@app.put("/api/events/allowlist/{device_id}")
def events_allowlist_set(device_id: str, req: AllowListRequest):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    allow: List[str] = []
    seen = set()
    for t in req.allow_topics:
        t2 = _normalize_allow_topic(t)
        if not t2:
            continue
        if t2 not in seen:
            seen.add(t2)
            allow.append(t2)

    _update_device_allowlist(device_id, allow)
    return {"ok": True, "device_id": device_id, "allow_topics": allow}


@app.get("/api/actions")
def actions_list():
    with _actions_lock:
        items = _load_actions()
    return {"items": items}


@app.post("/api/actions")
def actions_create(req: ActionRuleIn):
    with _actions_lock:
        items = _load_actions()
        item = _normalize_action_rule_payload(_dump(req))
        items.append(item)
        _save_actions(items)
    return {"ok": True, "item": item}


@app.put("/api/actions/{action_id}")
def actions_update(action_id: str, req: ActionRuleIn):
    with _actions_lock:
        items = _load_actions()
        for i, item in enumerate(items):
            if item.get("id") == action_id:
                new_item = _normalize_action_rule_payload(_dump(req), existing_id=action_id, created_at=item.get("created_at"))
                items[i] = new_item
                _save_actions(items)
                return {"ok": True, "item": new_item}
    raise HTTPException(status_code=404, detail="Action not found")


@app.delete("/api/actions/{action_id}")
def actions_delete(action_id: str):
    with _actions_lock:
        items = _load_actions()
        new_items = [x for x in items if x.get("id") != action_id]
        if len(new_items) == len(items):
            raise HTTPException(status_code=404, detail="Action not found")
        _save_actions(new_items)
    return {"ok": True}


@app.get("/api/action-events")
def action_events(device_id: Optional[str] = None, limit: int = 200):
    did = device_id.strip() if device_id else None
    return {"items": _list_action_events(device_id=did, limit=limit)}


@app.get("/api/playback/snapshots")
def playback_snapshots(device_id: Optional[str] = None):
    items = _list_snapshot_items(device_id=device_id.strip() if device_id else None)
    return {"items": items}


@app.post("/api/playback/snapshot/{device_id}")
async def playback_snapshot(device_id: str, req: SnapshotRequest):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    try:
        item = await asyncio.to_thread(_take_snapshot, device_id, req.event)
        return {"ok": True, "item": item}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Snapshot failed: {e}")


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

    return {"ok": True, "device": _dump(new)}


@app.put("/api/devices/{device_id}")
def update_device(device_id: str, dev_in: DeviceIn):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    dev = _update_device(device_id, dev_in)

    if dev.preload_stream and dev.profile_token:
        try:
            _preload_stream_for_device(dev)
        except Exception:
            pass
    else:
        try:
            _mediamtx_delete_path(device_id)
        except Exception:
            pass

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

    try:
        _mediamtx_delete_path(device_id)
    except Exception:
        pass

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

    # If this device is marked as preloaded and uses the same profile,
    # only skip setup if the MediaMTX path actually exists.
    if device and device.preload_stream and device.profile_token == req.profile_token:
        snapshot = await asyncio.to_thread(_mediamtx_paths_snapshot)
        path_name = _path_for(device_id)
        items = list(snapshot.get("items") or [])
        exists = any((x.get("name") == path_name) for x in items)
        if exists:
            return {"ok": True, "device_id": device_id, "path": path_name}

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
        await asyncio.to_thread(_ensure_mediamtx_path, device_id, source_rtsp, bool(device.preload_stream) if device else False)
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

    # For preloaded devices, Live-stop should not remove the backend path.
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
        return await asyncio.to_thread(_ptz_stop, device_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PTZ stop failed: {e}")


@app.on_event("startup")
def _on_startup():
    try:
        devs = _load_devices()

        snapshot = _mediamtx_paths_snapshot()
        with _action_runtime_lock:
            _last_device_states.clear()
            for d in devs:
                st = _device_stream_status_from_snapshot(d, snapshot)
                _last_device_states[d.id] = bool(st.get("stream_up"))

        global _action_monitor_thread
        _action_monitor_stop.clear()
        _action_monitor_thread = threading.Thread(target=_poll_device_state_changes, daemon=True, name="action-monitor")
        _action_monitor_thread.start()

        for d in devs:
            req = EventsStartRequest(
                device_id=d.id,
                ip=d.ip,
                onvif_port=d.onvif_port,
                username=d.username,
                password=d.password,
            )
            _start_event_worker(d.id, req)

        for d in devs:
            try:
                _preload_stream_for_device(d)
            except Exception:
                pass
    except Exception:
        pass


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

    _action_monitor_stop.set()

    with _ptz_watchdog_lock:
        timers = list(_ptz_watchdogs.values())
        _ptz_watchdogs.clear()

    for t in timers:
        try:
            t.cancel()
        except Exception:
            pass