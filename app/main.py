# app.py
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
import base64
from typing import Optional, Dict, Any, List

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from onvif import ONVIFCamera
from dataclasses import dataclass
from datetime import datetime

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DEVICES_JSON = DATA_DIR / "devices.json"

MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://mediamtx:9997").rstrip("/")
MEDIAMTX_API_USER = os.getenv("MEDIAMTX_API_USER", "apiuser")
MEDIAMTX_API_PASS = os.getenv("MEDIAMTX_API_PASS", "apipass")

PTZ_WATCHDOG_SEC = float(os.getenv("PTZ_WATCHDOG_SEC", "0.25"))


def _dump(model) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


# -------------------------
# Events subsystem
# -------------------------
@dataclass
class EventWorker:
    stop_flag: threading.Event
    thread: threading.Thread
    mode: str  # "learn" or "filtered"


_event_subscribers: Dict[str, List[asyncio.Queue]] = {}
_event_sub_lock = threading.RLock()

_event_workers: Dict[str, EventWorker] = {}
_event_worker_lock = threading.RLock()

_event_last: Dict[str, Dict[str, str]] = {}
_event_last_lock = threading.RLock()

# PTZ watchdog timers
_ptz_watchdogs: Dict[str, threading.Timer] = {}
_ptz_watchdog_lock = threading.RLock()


# -------------------------
# PTZ runtime cache
# -------------------------
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


# -------------------------
# Pages
# -------------------------
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


@app.get("/health")
def health():
    with _event_worker_lock:
        workers = {k: v.mode for k, v in _event_workers.items()}
    return {"ok": True, "event_workers": workers}


# -------------------------
# Models
# -------------------------
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


# -------------------------
# Device storage
# -------------------------
def _normalize_device_dict(d: dict) -> dict:
    out = dict(d)
    if "preload_stream" not in out:
        out["preload_stream"] = True
    return out


def _load_devices() -> List[Device]:
    if not DEVICES_JSON.exists():
        return []
    try:
        raw = json.loads(DEVICES_JSON.read_text(encoding="utf-8"))
        items = raw.get("devices", [])
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
    d = next((x for x in devs if x.id == device_id), None)
    if not d:
        raise HTTPException(status_code=404, detail="Device not found")
    return d


def _update_device_allowlist(device_id: str, allow_topics: List[str]) -> None:
    devs = _load_devices()
    idx = next((i for i, d in enumerate(devs) if d.id == device_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Device not found")
    d = devs[idx]
    devs[idx] = Device(**{**_dump(d), "id": d.id, "allow_topics": allow_topics})
    _save_devices(devs)


# -------------------------
# Events: learned topics storage
# -------------------------
def _learned_path_for(device_id: str) -> Path:
    return DATA_DIR / f"events-learned-{device_id}.json"


def _load_learned(device_id: str) -> dict:
    p = _learned_path_for(device_id)
    if not p.exists():
        return {"device_id": device_id, "seen": {}}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {"device_id": device_id, "seen": {}}


def _save_learned(device_id: str, data: dict) -> None:
    p = _learned_path_for(device_id)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)


def _learn_record(device_id: str, topic_key: str, utc: Optional[str], op: Optional[str], items: dict) -> bool:
    learned = _load_learned(device_id)
    seen: dict = learned.setdefault("seen", {})
    now = datetime.utcnow().isoformat() + "Z"

    ent = seen.get(topic_key)
    is_new = ent is None
    if ent is None:
        ent = {
            "count": 0,
            "first_seen": now,
            "last_seen": now,
            "keys": {"source": [], "data": []},
            "examples": [],
        }
        seen[topic_key] = ent

    ent["count"] = int(ent.get("count", 0)) + 1
    ent["last_seen"] = now

    src_keys = sorted(list(items.get("source", {}).keys()))
    data_keys = sorted(list(items.get("data", {}).keys()))
    ent["keys"]["source"] = sorted(list(set(ent["keys"].get("source", [])) | set(src_keys)))
    ent["keys"]["data"] = sorted(list(set(ent["keys"].get("data", [])) | set(data_keys)))

    ex = {
        "utc": utc,
        "op": op,
        "source": items.get("source", {}),
        "data": items.get("data", {}),
    }
    exs = ent.get("examples", [])
    exs.append(ex)
    ent["examples"] = exs[-5:]

    _save_learned(device_id, learned)
    return is_new


# -------------------------
# Events helpers
# -------------------------
def _broadcast_event(device_id: str, payload: dict) -> None:
    with _event_sub_lock:
        qs = list(_event_subscribers.get(device_id, []))

    for q in qs:
        try:
            q.put_nowait(payload)
        except Exception:
            pass


def _extract_simple_items(message_elem) -> dict:
    out = {"source": {}, "data": {}}
    if message_elem is None:
        return out

    for si in message_elem.findall(".//{*}Source//{*}SimpleItem"):
        name = si.attrib.get("Name")
        val = si.attrib.get("Value")
        if name:
            out["source"][name] = val

    for si in message_elem.findall(".//{*}Data//{*}SimpleItem"):
        name = si.attrib.get("Name")
        val = si.attrib.get("Value")
        if name:
            out["data"][name] = val

    return out


def _topic_to_key(topic_obj, items: dict) -> str:
    topic_str = None
    try:
        v = getattr(topic_obj, "_value_1", None)
        if isinstance(v, str) and v.strip():
            topic_str = v.strip()
        elif isinstance(v, list) and v:
            topic_str = str(v[0])
    except Exception:
        pass

    if not topic_str:
        try:
            if isinstance(topic_obj, str) and topic_obj.strip():
                topic_str = topic_obj.strip()
        except Exception:
            pass

    if not topic_str or ("Dialect" in str(topic_obj) and "_value_1" in str(topic_obj)):
        src_keys = ",".join(sorted(items.get("source", {}).keys()))
        data_keys = ",".join(sorted(items.get("data", {}).keys()))
        topic_str = f"sig:source[{src_keys}] data[{data_keys}]"

    src = items.get("source", {})
    src_id = (
        src.get("InputToken")
        or src.get("RelayToken")
        or src.get("Source")
        or src.get("Token")
        or src.get("VideoSource")
        or ""
    )
    if src_id:
        return f"{topic_str} :: {src_id}"
    return topic_str


def _cam(req: OnvifBase) -> ONVIFCamera:
    return ONVIFCamera(req.ip, req.onvif_port, req.username, req.password)


def _device_req(device: Device) -> OnvifBase:
    return OnvifBase(
        ip=device.ip,
        onvif_port=device.onvif_port,
        username=device.username,
        password=device.password,
    )


def _device_fingerprint(device: Device) -> str:
    return "|".join(
        [
            device.ip,
            str(device.onvif_port),
            device.username,
            device.password,
            str(device.profile_token or ""),
        ]
    )


def _get_allowlist_snapshot(device_id: str) -> List[str]:
    try:
        d = _get_device(device_id)
        return list(d.allow_topics or [])
    except Exception:
        return []


def _onvif_event_worker(device_id: str, req: OnvifBase, mode: str, max_messages: int = 20):
    with _event_worker_lock:
        stop_flag = _event_workers[device_id].stop_flag

    allow_set: set[str] = set()
    last_allow_refresh = 0.0
    ALLOW_REFRESH_S = 2.0

    def emit(level: str, msg: str, extra: Optional[dict] = None):
        payload = {
            "ts": datetime.utcnow().isoformat() + "Z",
            "level": level,
            "device_id": device_id,
            "message": msg,
        }
        if extra is not None:
            payload["extra"] = extra
        _broadcast_event(device_id, payload)

    try:
        cam = _cam(req)
        events = cam.create_events_service()

        try:
            events.CreatePullPointSubscription({})
        except Exception:
            events.CreatePullPointSubscription({"InitialTerminationTime": "PT5M"})

        pullpoint = cam.create_pullpoint_service()

        if mode == "learn":
            emit("ok", "Learning ONVIF topics (unfiltered).")
        else:
            emit("ok", "Subscribed to ONVIF events (filtered, allowlist hot-reload enabled).")

        while not stop_flag.is_set():
            if mode == "filtered":
                now = time.time()
                if (now - last_allow_refresh) >= ALLOW_REFRESH_S:
                    allow_set = set(_get_allowlist_snapshot(device_id))
                    last_allow_refresh = now

            try:
                resp = pullpoint.PullMessages({"Timeout": "PT2S", "MessageLimit": max_messages})
                msgs = getattr(resp, "NotificationMessage", None)
                if not msgs:
                    continue
                if not isinstance(msgs, list):
                    msgs = [msgs]

                for m in msgs:
                    topic_obj = getattr(m, "Topic", None)

                    msg_elem = None
                    try:
                        msg_elem = getattr(getattr(m, "Message", None), "_value_1", None)
                    except Exception:
                        msg_elem = None

                    items = _extract_simple_items(msg_elem)

                    op = None
                    utc = None
                    try:
                        op = getattr(msg_elem, "attrib", {}).get("PropertyOperation")
                        utc = getattr(msg_elem, "attrib", {}).get("UtcTime")
                    except Exception:
                        pass

                    topic_key = _topic_to_key(topic_obj, items)

                    if mode == "learn":
                        is_new = _learn_record(device_id, topic_key, utc, op, items)
                        if is_new:
                            emit(
                                "event",
                                "New topic discovered",
                                {
                                    "topic_key": topic_key,
                                    "utc": utc,
                                    "op": op,
                                    "items": items,
                                },
                            )
                        continue

                    if not allow_set:
                        continue
                    if topic_key not in allow_set:
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
                        return f"{topic_key}::{k}::{src_id}" if src_id else f"{topic_key}::{k}"

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
                        continue

                    emit(
                        "event",
                        "ONVIF event",
                        {
                            "op": op,
                            "utc": utc,
                            "topic_key": topic_key,
                            "changed": changed,
                            "items": items,
                        },
                    )

            except Exception as e:
                emit("warn", f"PullMessages error: {e}")
                time.sleep(0.5)

    except Exception as e:
        emit("bad", f"Event subscription failed: {e}")
    finally:
        with _event_worker_lock:
            _event_workers.pop(device_id, None)
        emit("warn", "Event worker stopped.")


# -------------------------
# Streaming helpers
# -------------------------
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

    out["browser_compatible"] = out["encoding"] == "H264"
    return out


def _find_profile_encoding(req: OnvifBase, profile_token: str) -> Optional[str]:
    cam = _cam(req)
    media = cam.create_media_service()
    profs = media.GetProfiles()

    for p in profs:
        if getattr(p, "token", None) != profile_token:
            continue
        try:
            vec = getattr(p, "VideoEncoderConfiguration", None)
            if vec:
                encoding = getattr(vec, "Encoding", None)
                if encoding is not None:
                    return str(encoding).upper()
        except Exception:
            pass
        return None

    raise RuntimeError(f"Profile not found: {profile_token}")


def _get_stream_uri(req: OnvifBase, profile_token: str) -> str:
    cam = _cam(req)
    media = cam.create_media_service()
    resp = media.GetStreamUri(
        {
            "StreamSetup": {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}},
            "ProfileToken": profile_token,
        }
    )

    rtsp = getattr(resp, "Uri", None)
    if not rtsp or not rtsp.lower().startswith("rtsp://"):
        raise RuntimeError(f"Unexpected RTSP URI returned: {rtsp}")

    if "@" not in rtsp:
        rtsp = rtsp.replace("rtsp://", f"rtsp://{req.username}:{req.password}@", 1)

    return rtsp


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
        msg = str(add_err)

        if "already exists" in msg or "409" in msg:
            try:
                return _mediamtx_api_request("PATCH", f"/v3/config/paths/edit/{name}", payload)
            except Exception as edit_err:
                raise RuntimeError(
                    f"MediaMTX add said path exists, but edit failed. "
                    f"add_error={add_err}; edit_error={edit_err}"
                ) from edit_err

        raise RuntimeError(f"MediaMTX path add failed: {add_err}") from add_err


def _delete_mediamtx_path(device_id: str) -> None:
    name = _path_for(device_id)
    try:
        _mediamtx_api_request("DELETE", f"/v3/config/paths/delete/{name}")
    except Exception:
        pass


def _preload_stream_for_device(device: Device) -> None:
    if not device.profile_token:
        return
    if not device.preload_stream:
        return

    req = _device_req(device)
    encoding = _find_profile_encoding(req, device.profile_token)
    if (encoding or "").upper() != "H264":
        raise RuntimeError(
            f"Selected profile uses {encoding or 'unknown'}; browser playback needs H264."
        )

    rtsp = _get_stream_uri(req, device.profile_token)
    _ensure_mediamtx_path(device.id, rtsp, preload=True)


def _mediamtx_paths_snapshot() -> dict:
    try:
        data = _mediamtx_api_request("GET", "/v3/paths/list")
        raw_items = data.get("items") or data.get("paths") or []

        items_by_name = {}
        for item in raw_items:
            name = item.get("name")
            if name:
                items_by_name[name] = item

        return {
            "ok": True,
            "items": items_by_name,
            "error": None,
        }
    except Exception as e:
        return {
            "ok": False,
            "items": {},
            "error": str(e),
        }


def _path_row_to_status(row: Optional[dict]) -> dict:
    if not row:
        return {
            "exists": False,
            "ready": False,
            "readers": 0,
            "source_ready": False,
            "raw": None,
        }

    readers = (
        row.get("readersCount")
        if isinstance(row.get("readersCount"), int)
        else row.get("numReaders")
        if isinstance(row.get("numReaders"), int)
        else row.get("readers")
        if isinstance(row.get("readers"), int)
        else 0
    )

    ready_val = row.get("ready", None)
    source_ready_val = row.get("sourceReady", None)

    source_ready = False
    if isinstance(source_ready_val, bool):
        source_ready = source_ready_val
    elif isinstance(ready_val, bool):
        source_ready = ready_val

    return {
        "exists": True,
        "ready": source_ready,
        "readers": readers,
        "source_ready": source_ready,
        "raw": row,
    }


def _device_stream_status_from_snapshot(device: Device, snapshot: dict) -> dict:
    out = {
        "device_id": device.id,
        "configured": bool(device.profile_token),
        "preload_stream": bool(getattr(device, "preload_stream", False)),
        "stream_up": False,
        "status": "down",
        "detail": None,
    }

    if not device.profile_token:
        out["status"] = "not_configured"
        return out

    if not snapshot.get("ok"):
        out["status"] = "unknown"
        out["detail"] = snapshot.get("error")
        return out

    row = snapshot["items"].get(_path_for(device.id))
    st = _path_row_to_status(row)

    if not device.preload_stream and not st.get("exists"):
        out["status"] = "idle"
        out["detail"] = {
            "exists": False,
            "source_ready": False,
            "readers": 0,
        }
        return out

    out["stream_up"] = bool(st.get("ready"))
    out["status"] = "up" if out["stream_up"] else "down"
    out["detail"] = {
        "exists": st.get("exists"),
        "source_ready": st.get("source_ready"),
        "readers": st.get("readers", 0),
    }
    return out


# -------------------------
# PTZ helpers
# -------------------------
def _clamp_speed(v: float) -> float:
    try:
        v = float(v)
    except Exception:
        return 0.0
    return max(-1.0, min(1.0, v))


def _cancel_ptz_watchdog(device_id: str) -> None:
    with _ptz_watchdog_lock:
        t = _ptz_watchdogs.pop(device_id, None)
        if t:
            try:
                t.cancel()
            except Exception:
                pass


def _schedule_ptz_watchdog(device_id: str) -> None:
    _cancel_ptz_watchdog(device_id)

    def _timeout_stop():
        try:
            _ptz_stop(device_id)
        except Exception:
            pass

    t = threading.Timer(PTZ_WATCHDOG_SEC, _timeout_stop)
    t.daemon = True
    with _ptz_watchdog_lock:
        _ptz_watchdogs[device_id] = t
    t.start()


def _build_ptz_context(device_id: str) -> PTZContextCache:
    device = _get_device(device_id)
    if not device.profile_token:
        raise RuntimeError("Device has no saved profile_token")

    req = _device_req(device)
    cam = _cam(req)
    media = cam.create_media_service()
    ptz = cam.create_ptz_service()

    profiles = media.GetProfiles()
    profile = next((p for p in profiles if getattr(p, "token", None) == device.profile_token), None)
    if not profile:
        raise RuntimeError("Saved profile_token not found on camera")

    ptz_cfg = getattr(profile, "PTZConfiguration", None)
    if not ptz_cfg:
        raise RuntimeError("Selected profile has no PTZ configuration")

    cfg_token = getattr(ptz_cfg, "token", None)
    opts = None
    try:
        if cfg_token:
            opts = ptz.GetConfigurationOptions({"ConfigurationToken": cfg_token})
    except Exception:
        opts = None

    pan_tilt_space = None
    zoom_space = None
    has_pan_tilt = False
    has_zoom = False

    try:
        spaces = getattr(opts, "Spaces", None) if opts is not None else None

        pt_spaces = getattr(spaces, "ContinuousPanTiltVelocitySpace", None) if spaces is not None else None
        if pt_spaces:
            first = pt_spaces[0]
            pan_tilt_space = getattr(first, "URI", None)
            has_pan_tilt = True

        zoom_spaces = getattr(spaces, "ContinuousZoomVelocitySpace", None) if spaces is not None else None
        if zoom_spaces:
            first = zoom_spaces[0]
            zoom_space = getattr(first, "URI", None)
            has_zoom = True
    except Exception:
        pass

    if not has_pan_tilt:
        try:
            if getattr(ptz_cfg, "DefaultContinuousPanTiltVelocitySpace", None):
                has_pan_tilt = True
                pan_tilt_space = getattr(ptz_cfg, "DefaultContinuousPanTiltVelocitySpace", None)
        except Exception:
            pass

    if not has_zoom:
        try:
            if getattr(ptz_cfg, "DefaultContinuousZoomVelocitySpace", None):
                has_zoom = True
                zoom_space = getattr(ptz_cfg, "DefaultContinuousZoomVelocitySpace", None)
        except Exception:
            pass

    return PTZContextCache(
        fingerprint=_device_fingerprint(device),
        profile_token=device.profile_token,
        ptz=ptz,
        pan_tilt_space=pan_tilt_space,
        zoom_space=zoom_space,
        has_ptz=True,
        has_pan_tilt=has_pan_tilt,
        has_zoom=has_zoom,
    )


def _ptz_context(device_id: str, force_refresh: bool = False) -> PTZContextCache:
    device = _get_device(device_id)
    fingerprint = _device_fingerprint(device)

    if not force_refresh:
        with _ptz_context_cache_lock:
            cached = _ptz_context_cache.get(device_id)
            if cached and cached.fingerprint == fingerprint:
                return cached

    with _ptz_context_cache_lock:
        cached = _ptz_context_cache.get(device_id)
        if cached and cached.fingerprint == fingerprint and not force_refresh:
            return cached

        ctx = _build_ptz_context(device_id)
        _ptz_context_cache[device_id] = ctx
        return ctx


def _ptz_move(device_id: str, pan: float, tilt: float, zoom: float) -> dict:
    pan = _clamp_speed(pan)
    tilt = _clamp_speed(tilt)
    zoom = _clamp_speed(zoom)

    with _ptz_device_lock(device_id):
        ctx = _ptz_context(device_id)

        velocity: Dict[str, Any] = {}

        if ctx.has_pan_tilt and (abs(pan) > 0.0001 or abs(tilt) > 0.0001):
            payload = {"x": pan, "y": tilt}
            if ctx.pan_tilt_space:
                payload["space"] = ctx.pan_tilt_space
            velocity["PanTilt"] = payload

        if ctx.has_zoom and abs(zoom) > 0.0001:
            payload = {"x": zoom}
            if ctx.zoom_space:
                payload["space"] = ctx.zoom_space
            velocity["Zoom"] = payload

        if not velocity:
            return _ptz_stop(device_id)

        try:
            ctx.ptz.ContinuousMove(
                {
                    "ProfileToken": ctx.profile_token,
                    "Velocity": velocity,
                }
            )
        except Exception:
            _invalidate_ptz_cache(device_id)
            ctx = _ptz_context(device_id, force_refresh=True)
            ctx.ptz.ContinuousMove(
                {
                    "ProfileToken": ctx.profile_token,
                    "Velocity": velocity,
                }
            )

        _schedule_ptz_watchdog(device_id)
        return {"ok": True, "moving": True, "pan": pan, "tilt": tilt, "zoom": zoom}


def _ptz_stop(device_id: str) -> dict:
    _cancel_ptz_watchdog(device_id)

    with _ptz_device_lock(device_id):
        ctx = _ptz_context(device_id)
        try:
            ctx.ptz.Stop(
                {
                    "ProfileToken": ctx.profile_token,
                    "PanTilt": True,
                    "Zoom": True,
                }
            )
        except Exception:
            _invalidate_ptz_cache(device_id)
            ctx = _ptz_context(device_id, force_refresh=True)
            ctx.ptz.Stop(
                {
                    "ProfileToken": ctx.profile_token,
                    "PanTilt": True,
                    "Zoom": True,
                }
            )

    return {"ok": True, "moving": False}


def _ptz_status(device_id: str) -> dict:
    with _ptz_device_lock(device_id):
        ctx = _ptz_context(device_id)
        try:
            st = ctx.ptz.GetStatus({"ProfileToken": ctx.profile_token})
        except Exception:
            _invalidate_ptz_cache(device_id)
            ctx = _ptz_context(device_id, force_refresh=True)
            st = ctx.ptz.GetStatus({"ProfileToken": ctx.profile_token})

    pos = getattr(st, "Position", None)
    move = getattr(st, "MoveStatus", None)

    out = {
        "ok": True,
        "position": {
            "pan": None,
            "tilt": None,
            "zoom": None,
        },
        "move_status": {
            "pan_tilt": None,
            "zoom": None,
        },
    }

    try:
        pt = getattr(pos, "PanTilt", None)
        if pt is not None:
            out["position"]["pan"] = getattr(pt, "x", None)
            out["position"]["tilt"] = getattr(pt, "y", None)
    except Exception:
        pass

    try:
        z = getattr(pos, "Zoom", None)
        if z is not None:
            out["position"]["zoom"] = getattr(z, "x", None)
    except Exception:
        pass

    try:
        out["move_status"]["pan_tilt"] = getattr(move, "PanTilt", None)
        out["move_status"]["zoom"] = getattr(move, "Zoom", None)
    except Exception:
        pass

    return out


# -------------------------
# Events API
# -------------------------
@app.get("/api/events/stream/{device_id}")
async def events_stream(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    q: asyncio.Queue = asyncio.Queue(maxsize=200)

    with _event_sub_lock:
        _event_subscribers.setdefault(device_id, []).append(q)

    async def gen():
        yield f"event: hello\ndata: {json.dumps({'device_id': device_id})}\n\n"
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

    return StreamingResponse(gen(), media_type="text/event-stream")


def _start_event_worker(device_id: str, req: OnvifBase, mode: str) -> None:
    with _event_worker_lock:
        if device_id in _event_workers:
            return
        stop_flag = threading.Event()
        worker = EventWorker(stop_flag=stop_flag, thread=None, mode=mode)

        _event_workers[device_id] = worker

        t = threading.Thread(
            target=_onvif_event_worker,
            args=(device_id, req, mode),
            daemon=True,
            name=f"onvif-events-{mode}-{device_id}",
        )
        worker.thread = t
        t.start()


@app.post("/api/events/start")
async def events_start(req: EventsStartRequest):
    device_id = req.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    _start_event_worker(device_id, req, mode="filtered")
    return {"ok": True, "device_id": device_id, "running": True, "mode": "filtered"}


@app.post("/api/events/learn/start")
async def events_learn_start(req: EventsStartRequest):
    device_id = req.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    _start_event_worker(device_id, req, mode="learn")
    return {"ok": True, "device_id": device_id, "running": True, "mode": "learn"}


@app.post("/api/events/stop/{device_id}")
async def events_stop(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    return {"ok": True, "device_id": device_id, "running": True, "note": "stop disabled"}


@app.get("/api/events/learned/{device_id}")
def events_learned(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    return _load_learned(device_id)


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

    allow = []
    seen = set()
    for t in req.allow_topics:
        t = (t or "").strip()
        if not t:
            continue
        if t not in seen:
            seen.add(t)
            allow.append(t)

    _update_device_allowlist(device_id, allow)
    return {"ok": True, "device_id": device_id, "allow_topics": allow}


# -------------------------
# Devices API
# -------------------------
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
    _start_event_worker(new.id, req, mode="filtered")

    try:
        _preload_stream_for_device(new)
    except Exception:
        pass

    return {"ok": True, "device": _dump(new)}


@app.put("/api/devices/{device_id}")
def update_device(device_id: str, dev: DeviceIn):
    devs = _load_devices()
    idx = next((i for i, d in enumerate(devs) if d.id == device_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Device not found")

    updated = Device(id=device_id, **_dump(dev))
    devs[idx] = updated
    _save_devices(devs)
    _invalidate_ptz_cache(device_id)
    _cancel_ptz_watchdog(device_id)

    req = EventsStartRequest(
        device_id=device_id,
        ip=updated.ip,
        onvif_port=updated.onvif_port,
        username=updated.username,
        password=updated.password,
    )
    _start_event_worker(device_id, req, mode="filtered")

    if updated.preload_stream and updated.profile_token:
        try:
            _preload_stream_for_device(updated)
        except Exception:
            pass
    else:
        _delete_mediamtx_path(device_id)

    return {"ok": True, "device": _dump(updated)}


@app.delete("/api/devices/{device_id}")
def delete_device(device_id: str):
    devs = _load_devices()
    new_devs = [d for d in devs if d.id != device_id]
    if len(new_devs) == len(devs):
        raise HTTPException(status_code=404, detail="Device not found")
    _save_devices(new_devs)
    _delete_mediamtx_path(device_id)
    _cancel_ptz_watchdog(device_id)
    _invalidate_ptz_cache(device_id)
    with _ptz_command_locks_lock:
        _ptz_command_locks.pop(device_id, None)
    return {"ok": True}


# -------------------------
# Streaming API
# -------------------------
@app.post("/api/profiles")
async def profiles(req: OnvifBase):
    def _work():
        cam = _cam(req)
        media = cam.create_media_service()
        profs = media.GetProfiles()
        out = [_profile_summary(p) for p in profs if getattr(p, "token", None)]
        if not out:
            raise RuntimeError("No profiles returned.")

        out.sort(
            key=lambda p: (
                0 if p.get("browser_compatible") else 1,
                (p.get("width") or 999999) * (p.get("height") or 999999),
                str(p.get("name") or ""),
            )
        )
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
        return {"ok": True, "device_id": device_id, "path": _path_for(device_id)}

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
        rtsp = await asyncio.to_thread(_get_stream_uri, req, req.profile_token)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF stream uri failed: {e}")

    try:
        await asyncio.to_thread(_ensure_mediamtx_path, device_id, rtsp, False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MediaMTX path setup failed: {e}")

    return {"ok": True, "device_id": device_id, "path": _path_for(device_id)}


@app.post("/api/stop/{device_id}")
async def stop_one(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    keep_hot = False
    try:
        d = _get_device(device_id)
        keep_hot = bool(d.preload_stream and d.profile_token)
    except Exception:
        keep_hot = False

    if not keep_hot:
        await asyncio.to_thread(_delete_mediamtx_path, device_id)

    try:
        await asyncio.to_thread(_ptz_stop, device_id)
    except Exception:
        pass

    return {"ok": True, "kept_preloaded": keep_hot}


@app.post("/api/stop")
async def stop_all():
    devs = _load_devices()
    for d in devs:
        if not (d.preload_stream and d.profile_token):
            await asyncio.to_thread(_delete_mediamtx_path, d.id)
        try:
            await asyncio.to_thread(_ptz_stop, d.id)
        except Exception:
            pass
    return {"ok": True}


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
    devs = _load_devices()
    snapshot = _mediamtx_paths_snapshot()
    items = [_device_stream_status_from_snapshot(d, snapshot) for d in devs]
    return {"items": items}


# -------------------------
# PTZ API
# -------------------------
@app.get("/api/ptz/capabilities/{device_id}")
async def ptz_capabilities(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")
    try:
        ctx = await asyncio.to_thread(_ptz_context, device_id)
        return {
            "ok": True,
            "ptz": bool(ctx.has_ptz),
            "pan_tilt": bool(ctx.has_pan_tilt),
            "zoom": bool(ctx.has_zoom),
        }
    except Exception as e:
        return {
            "ok": True,
            "ptz": False,
            "pan_tilt": False,
            "zoom": False,
            "detail": str(e),
        }


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
        return await asyncio.to_thread(_ptz_move, device_id, req.pan, req.tilt, req.zoom)
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


# -------------------------
# Startup / shutdown
# -------------------------
@app.on_event("startup")
def _on_startup():
    try:
        devs = _load_devices()
        for d in devs:
            req = EventsStartRequest(
                device_id=d.id,
                ip=d.ip,
                onvif_port=d.onvif_port,
                username=d.username,
                password=d.password,
            )
            _start_event_worker(d.id, req, mode="filtered")

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
        for _, w in list(_event_workers.items()):
            w.stop_flag.set()
    with _ptz_watchdog_lock:
        timers = list(_ptz_watchdogs.values())
        _ptz_watchdogs.clear()
    for t in timers:
        try:
            t.cancel()
        except Exception:
            pass