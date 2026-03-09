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
from xml.etree import ElementTree as ET

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
    allow_topics: Optional[List[str]] = None


class Device(DeviceIn):
    id: str


# -------------------------
# Device storage
# -------------------------
def _load_devices() -> List[Device]:
    if not DEVICES_JSON.exists():
        return []
    try:
        raw = json.loads(DEVICES_JSON.read_text(encoding="utf-8"))
        items = raw.get("devices", [])
        return [Device(**d) for d in items]
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


def _xml_to_str(elem, limit=6000):
    if elem is None:
        return None
    try:
        return ET.tostring(elem, encoding="unicode")[:limit]
    except Exception:
        return str(elem)[:limit]


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
# Events API
# -------------------------
class EventsStartRequest(OnvifBase):
    device_id: str


class AllowListRequest(BaseModel):
    allow_topics: List[str] = Field(default_factory=list)


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

    req = EventsStartRequest(
        device_id=new.id,
        ip=new.ip,
        onvif_port=new.onvif_port,
        username=new.username,
        password=new.password,
    )
    _start_event_worker(new.id, req, mode="filtered")

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

    req = EventsStartRequest(
        device_id=device_id,
        ip=updated.ip,
        onvif_port=updated.onvif_port,
        username=updated.username,
        password=updated.password,
    )
    _start_event_worker(device_id, req, mode="filtered")

    return {"ok": True, "device": _dump(updated)}


@app.delete("/api/devices/{device_id}")
def delete_device(device_id: str):
    devs = _load_devices()
    new_devs = [d for d in devs if d.id != device_id]
    if len(new_devs) == len(devs):
        raise HTTPException(status_code=404, detail="Device not found")
    _save_devices(new_devs)
    _delete_mediamtx_path(device_id)
    return {"ok": True}


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


def _ensure_mediamtx_path(device_id: str, source_rtsp: str) -> dict:
    name = _path_for(device_id)
    payload = {
        "source": source_rtsp,
        "sourceOnDemand": True,
        "sourceOnDemandStartTimeout": "10s",
        "sourceOnDemandCloseAfter": "10s",
    }

    try:
        return _mediamtx_api_request("POST", f"/v3/config/paths/add/{name}", payload)
    except Exception:
        return _mediamtx_api_request("PATCH", f"/v3/config/paths/edit/{name}", payload)


def _delete_mediamtx_path(device_id: str) -> None:
    name = _path_for(device_id)
    try:
        _mediamtx_api_request("DELETE", f"/v3/config/paths/delete/{name}")
    except Exception:
        pass


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
    }


@app.post("/api/start")
async def start(req: StartRequest):
    if not req.profile_token:
        raise HTTPException(status_code=400, detail="Missing profile_token.")

    device_id = req.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id.")

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
        await asyncio.to_thread(_ensure_mediamtx_path, device_id, rtsp)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"MediaMTX path setup failed: {e}")

    return {"ok": True, "device_id": device_id, "path": _path_for(device_id)}


@app.post("/api/stop/{device_id}")
async def stop_one(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    await asyncio.to_thread(_delete_mediamtx_path, device_id)
    return {"ok": True}


@app.post("/api/stop")
async def stop_all():
    devs = _load_devices()
    for d in devs:
        await asyncio.to_thread(_delete_mediamtx_path, d.id)
    return {"ok": True}


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
    except Exception:
        pass


@app.on_event("shutdown")
def _on_shutdown():
    with _event_worker_lock:
        for _, w in list(_event_workers.items()):
            w.stop_flag.set()