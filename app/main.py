# main.py
from __future__ import annotations

from pathlib import Path
import os
import socket
import subprocess
import time
import json
import uuid
import threading
import signal
import asyncio
from typing import Optional, Dict, Any, List

from fastapi import FastAPI, HTTPException, BackgroundTasks
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

MEDIAMTX_BASE_URL = os.getenv("MEDIAMTX_BASE_URL", "rtsp://mediamtx:8554").rstrip("/")
MEDIAMTX_HOST = os.getenv("MEDIAMTX_HOST", "mediamtx")
MEDIAMTX_RTSP_PORT = int(os.getenv("MEDIAMTX_RTSP_PORT", "8554"))

# One ffmpeg per device_id
_ffmpegs: Dict[str, subprocess.Popen] = {}
_ffmpeg_lock = threading.RLock()

# readiness cache (so /api/start can return immediately without blocking)
_stream_ready: Dict[str, bool] = {}
_ready_lock = threading.RLock()


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


# device_id -> list of subscriber queues (one per browser tab)
_event_subscribers: Dict[str, List[asyncio.Queue]] = {}
_event_sub_lock = threading.RLock()

# device_id -> worker
_event_workers: Dict[str, EventWorker] = {}
_event_worker_lock = threading.RLock()

# device_id -> last seen values for change detection
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
    with _ffmpeg_lock:
        streams = list(_ffmpegs.keys())
    with _event_worker_lock:
        workers = {k: v.mode for k, v in _event_workers.items()}
    return {"ok": True, "streams": streams, "event_workers": workers}


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
    # per-device list of "topic keys" the user selected to subscribe to
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
    """
    Persist learned events per camera.
    Returns True if it's a "new topic" never seen before.
    """
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
    # keep last 5
    ent["examples"] = exs[-5:]

    _save_learned(device_id, learned)
    return is_new


# -------------------------
# Events helpers
# -------------------------
def _broadcast_event(device_id: str, payload: dict) -> None:
    # Push to all subscribers (async queues) without blocking worker thread
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
    """
    Tries to get a usable ONVIF topic string. If camera doesn't provide it,
    fall back to a stable "signature" based on fields in Source/Data.
    """
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
        # Many cams: Topic is an object whose str() is useless. Try a couple more.
        try:
            if isinstance(topic_obj, str) and topic_obj.strip():
                topic_str = topic_obj.strip()
        except Exception:
            pass

    # If still not good, signature fallback
    if not topic_str or "Dialect" in str(topic_obj) and "_value_1" in str(topic_obj):
        src_keys = ",".join(sorted(items.get("source", {}).keys()))
        data_keys = ",".join(sorted(items.get("data", {}).keys()))
        topic_str = f"sig:source[{src_keys}] data[{data_keys}]"

    # Include "which thing" (token) to disambiguate
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
    """
    PullPoint worker:
      - mode="learn": no filter, save topic keys/examples per device
      - mode="filtered": only forward events that match allowlist for device
    """
    with _event_worker_lock:
        stop_flag = _event_workers[device_id].stop_flag

    allow = _get_allowlist_snapshot(device_id) if mode == "filtered" else []
    allow_set = set(allow)

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
            emit("ok", f"Subscribed to ONVIF events (filtered). allow_topics={len(allow_set)}")

        while not stop_flag.is_set():
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

                    # LEARN MODE: save, optionally emit only "new topic"
                    if mode == "learn":
                        is_new = _learn_record(device_id, topic_key, utc, op, items)
                        if is_new:
                            emit("event", "New topic discovered", {
                                "topic_key": topic_key,
                                "utc": utc,
                                "op": op,
                                "items": items,
                            })
                        continue

                    # FILTERED MODE:
                    if allow_set and topic_key not in allow_set:
                        continue

                    # change detection (avoid noise)
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

                    # Look at everything in data; compare per-topic per-key
                    changed: Dict[str, str] = {}
                    with _event_last_lock:
                        last = _event_last.setdefault(device_id, {})
                        for k, v0 in data.items():
                            v = str(v0)
                            kfull = kk(k)
                            if last.get(kfull) != v:
                                changed[k] = v
                                last[kfull] = v

                    # If Initialized and nothing changed, skip
                    if op == "Initialized" and not changed:
                        continue

                    emit("event", "ONVIF event", {
                        "op": op,
                        "utc": utc,
                        "topic_key": topic_key,
                        "changed": changed,
                        "items": items,
                        # keep xml out by default (less spam); UI can request learned examples instead
                    })

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
            # already running
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
    """
    Start FILTERED events worker for device_id.
    Uses allow_topics stored on the device. If allowlist is empty, it will still run (but will be noisy).
    """
    device_id = req.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    _start_event_worker(device_id, req, mode="filtered")
    return {"ok": True, "device_id": device_id, "running": True, "mode": "filtered"}


@app.post("/api/events/learn/start")
async def events_learn_start(req: EventsStartRequest):
    """
    Start LEARN worker for device_id.
    It records topic keys and examples to /app/data/events-learned-<device_id>.json
    """
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

    with _event_worker_lock:
        w = _event_workers.get(device_id)
        if not w:
            return {"ok": True, "device_id": device_id, "running": False}
        w.stop_flag.set()

    return {"ok": True, "device_id": device_id, "running": False}


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

    # de-dup / stable order
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
    return {"ok": True, "device": _dump(updated)}


@app.delete("/api/devices/{device_id}")
def delete_device(device_id: str):
    devs = _load_devices()
    new_devs = [d for d in devs if d.id != device_id]
    if len(new_devs) == len(devs):
        raise HTTPException(status_code=404, detail="Device not found")
    _save_devices(new_devs)
    return {"ok": True}


# -------------------------
# Streaming helpers
# -------------------------
def _path_for(device_id: str) -> str:
    return f"cam-{device_id}"


def _log_path_for(device_id: str) -> Path:
    return DATA_DIR / f"ffmpeg-{device_id}.log"


def _log_tail(device_id: str, n: int = 4000) -> str:
    p = _log_path_for(device_id)
    if not p.exists():
        return "(no ffmpeg log yet)"
    try:
        return p.read_text(errors="ignore")[-n:]
    except Exception:
        return "(failed to read ffmpeg log)"


def _popen_kwargs() -> dict:
    if os.name == "posix":
        return {"preexec_fn": os.setsid}
    return {}


def _stop_ffmpeg(device_id: str):
    with _ffmpeg_lock:
        p = _ffmpegs.get(device_id)
        if not p:
            return

        try:
            if p.poll() is None:
                if os.name == "posix":
                    os.killpg(os.getpgid(p.pid), signal.SIGTERM)
                else:
                    p.terminate()
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    if os.name == "posix":
                        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                    else:
                        p.kill()
        finally:
            _ffmpegs.pop(device_id, None)

    with _ready_lock:
        _stream_ready[device_id] = False


def _stop_all_ffmpeg():
    with _ffmpeg_lock:
        ids = list(_ffmpegs.keys())
    for device_id in ids:
        _stop_ffmpeg(device_id)


def _profile_summary(p) -> Dict[str, Any]:
    out = {"token": getattr(p, "token", None), "name": getattr(p, "Name", None)}
    try:
        vec = getattr(p, "VideoEncoderConfiguration", None)
        if vec:
            out["encoding"] = getattr(vec, "Encoding", None)
            res = getattr(vec, "Resolution", None)
            if res:
                out["width"] = getattr(res, "Width", None)
                out["height"] = getattr(res, "Height", None)
    except Exception:
        pass
    return out


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


def _rtsp_describe_ok(path: str, timeout_s: float = 1.0) -> bool:
    req = (
        f"DESCRIBE rtsp://{MEDIAMTX_HOST}:{MEDIAMTX_RTSP_PORT}/{path} RTSP/1.0\r\n"
        f"CSeq: 1\r\n"
        f"User-Agent: sei-raspi\r\n"
        f"Accept: application/sdp\r\n"
        f"\r\n"
    ).encode("utf-8")

    try:
        with socket.create_connection((MEDIAMTX_HOST, MEDIAMTX_RTSP_PORT), timeout=timeout_s) as s:
            s.settimeout(timeout_s)
            s.sendall(req)
            resp = s.recv(4096).decode("utf-8", errors="ignore")
        return "RTSP/1.0 200" in resp
    except Exception:
        return False


def _start_ffmpeg(rtsp_in: str, device_id: str, path: str):
    _stop_ffmpeg(device_id)

    publish_url = f"{MEDIAMTX_BASE_URL}/{path}"

    log_path = _log_path_for(device_id)
    log_path.write_text("", encoding="utf-8")
    log_f = open(log_path, "a")

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "info",
        "-rtsp_transport", "tcp",
        "-rtsp_flags", "prefer_tcp",
        "-i", rtsp_in,
        "-map", "0:v:0",
        "-an",
        "-vf", "scale=1280:-2,format=yuv420p",
        "-c:v", "libx264",
        "-profile:v", "baseline",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-g", "50",
        "-keyint_min", "50",
        "-sc_threshold", "0",
        "-f", "rtsp",
        "-rtsp_transport", "tcp",
        publish_url,
    ]

    p = subprocess.Popen(cmd, stdout=log_f, stderr=log_f, **_popen_kwargs())
    with _ffmpeg_lock:
        _ffmpegs[device_id] = p
    with _ready_lock:
        _stream_ready[device_id] = False


def _mark_ready_when_online(device_id: str, path: str, max_wait_s: float = 8.0):
    deadline = time.time() + max_wait_s
    while time.time() < deadline:
        with _ffmpeg_lock:
            p = _ffmpegs.get(device_id)
        if not p:
            with _ready_lock:
                _stream_ready[device_id] = False
            return
        if p.poll() is not None:
            with _ready_lock:
                _stream_ready[device_id] = False
            return

        if _rtsp_describe_ok(path):
            with _ready_lock:
                _stream_ready[device_id] = True
            return

        time.sleep(0.1)

    with _ready_lock:
        _stream_ready[device_id] = False


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
        return out

    try:
        out = await asyncio.to_thread(_work)
        return {"profiles": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF profiles failed: {e}")


@app.get("/api/streams")
def streams():
    with _ffmpeg_lock:
        ids = list(_ffmpegs.keys())
    return {"streams": ids}


@app.get("/api/status/{device_id}")
def status(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    with _ffmpeg_lock:
        p = _ffmpegs.get(device_id)

    running = bool(p and p.poll() is None)
    exit_code = None if not p else p.poll()

    with _ready_lock:
        ready = bool(_stream_ready.get(device_id, False))

    return {
        "device_id": device_id,
        "path": _path_for(device_id),
        "running": running,
        "ready": ready,
        "exit_code": exit_code,
        "log_tail": _log_tail(device_id),
    }


@app.post("/api/start")
async def start(req: StartRequest, bg: BackgroundTasks):
    if not req.profile_token:
        raise HTTPException(status_code=400, detail="Missing profile_token.")

    device_id = req.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id.")

    path = _path_for(device_id)

    try:
        rtsp = await asyncio.to_thread(_get_stream_uri, req, req.profile_token)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF stream uri failed: {e}")

    try:
        await asyncio.to_thread(_start_ffmpeg, rtsp, device_id, path)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffmpeg not found in container.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg failed to start: {e}")

    bg.add_task(_mark_ready_when_online, device_id, path)
    return {"ok": True, "device_id": device_id, "path": path}


@app.post("/api/stop/{device_id}")
async def stop_one(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    await asyncio.to_thread(_stop_ffmpeg, device_id)
    return {"ok": True}


@app.post("/api/stop")
async def stop_all():
    await asyncio.to_thread(_stop_all_ffmpeg)
    return {"ok": True}


@app.on_event("shutdown")
def _on_shutdown():
    _stop_all_ffmpeg()
    # stop event workers
    with _event_worker_lock:
        for _, w in list(_event_workers.items()):
            w.stop_flag.set()