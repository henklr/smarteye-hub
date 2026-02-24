from pathlib import Path
import os
import socket
import subprocess
import time
import json
import uuid
from typing import Optional, Dict, Any, List

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from onvif import ONVIFCamera

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DEVICES_JSON = DATA_DIR / "devices.json"

MEDIAMTX_BASE_URL = os.getenv("MEDIAMTX_BASE_URL", "rtsp://mediamtx:8554")
MEDIAMTX_HOST = os.getenv("MEDIAMTX_HOST", "mediamtx")
MEDIAMTX_RTSP_PORT = int(os.getenv("MEDIAMTX_RTSP_PORT", "8554"))

# One ffmpeg per device_id
_ffmpegs: Dict[str, subprocess.Popen] = {}


def _dump(model) -> dict:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


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


@app.get("/health")
def health():
    return {"ok": True, "streams": list(_ffmpegs.keys())}


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


def _stop_ffmpeg(device_id: str):
    p = _ffmpegs.get(device_id)
    if not p:
        return
    if p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()
    _ffmpegs.pop(device_id, None)


def _stop_all_ffmpeg():
    for device_id in list(_ffmpegs.keys()):
        _stop_ffmpeg(device_id)


def _cam(req: OnvifBase) -> ONVIFCamera:
    return ONVIFCamera(req.ip, req.onvif_port, req.username, req.password)


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
    # stop existing for this device (idempotent)
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

    _ffmpegs[device_id] = subprocess.Popen(cmd, stdout=log_f, stderr=log_f)


# -------------------------
# Streaming API
# -------------------------

@app.post("/api/profiles")
def profiles(req: OnvifBase):
    try:
        cam = _cam(req)
        media = cam.create_media_service()
        profs = media.GetProfiles()
        out = [_profile_summary(p) for p in profs if getattr(p, "token", None)]
        if not out:
            raise RuntimeError("No profiles returned.")
        return {"profiles": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF profiles failed: {e}")


@app.get("/api/streams")
def streams():
    return {"streams": list(_ffmpegs.keys())}


@app.post("/api/start")
def start(req: StartRequest):
    if not req.profile_token:
        raise HTTPException(status_code=400, detail="Missing profile_token.")

    device_id = req.device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id.")

    path = f"cam-{device_id}"

    try:
        rtsp = _get_stream_uri(req, req.profile_token)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF stream uri failed: {e}")

    try:
        _start_ffmpeg(rtsp, device_id=device_id, path=path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg failed to start: {e}")

    for _ in range(80):
        p = _ffmpegs.get(device_id)
        if p and p.poll() is not None:
            raise HTTPException(status_code=500, detail="ffmpeg exited:\n\n" + _log_tail(device_id))
        if _rtsp_describe_ok(path):
            return {"ok": True, "path": path}
        time.sleep(0.1)

    raise HTTPException(status_code=500, detail="Timed out waiting for stream.\n\n" + _log_tail(device_id))


@app.post("/api/stop/{device_id}")
def stop_one(device_id: str):
    _stop_ffmpeg(device_id)
    return {"ok": True}


@app.post("/api/stop")
def stop_all():
    _stop_all_ffmpeg()
    return {"ok": True}