import json
import os
import re
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ONVIF / WS-Discovery
from wsdiscovery.discovery import ThreadedWSDiscovery as WSDiscovery
from wsdiscovery import QName
from onvif import ONVIFCamera

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout
_executor = ThreadPoolExecutor(max_workers=6)

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

DATA_DIR = Path("/app/data")  # your docker run mounts this
DATA_DIR.mkdir(parents=True, exist_ok=True)

HLS_ROOT = DATA_DIR / "hls"
HLS_ROOT.mkdir(parents=True, exist_ok=True)

DEVICES_FILE = DATA_DIR / "devices.json"

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten later if needed
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/hls", StaticFiles(directory=HLS_ROOT), name="hls")


@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/health")
def health():
    return {"ok": True}


# -------------------------
# Models
# -------------------------

class ConnectRequest(BaseModel):
    xaddr: str
    username: str
    password: str


class StartStreamRequest(BaseModel):
    device_id: str
    profile_token: str
    transport: str = "RTSP"  # keep simple for now


@dataclass
class StoredDevice:
    device_id: str
    xaddr: str
    host: str
    port: int
    username: str
    password: str
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    name: Optional[str] = None


# -------------------------
# Storage
# -------------------------

_devices_lock = threading.RLock()
_devices: Dict[str, StoredDevice] = {}  # device_id -> StoredDevice


def _safe_id(s: str) -> str:
    # stable-ish id from xaddr
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s[-64:] if len(s) > 64 else s


def load_devices():
    global _devices
    if DEVICES_FILE.exists():
        try:
            data = json.loads(DEVICES_FILE.read_text(encoding="utf-8"))
            out = {}
            for item in data:
                d = StoredDevice(**item)
                out[d.device_id] = d
            _devices = out
        except Exception:
            # if corrupted, keep empty (don’t crash)
            _devices = {}


def save_devices():
    with _devices_lock:
        DEVICES_FILE.write_text(
            json.dumps([asdict(d) for d in _devices.values()], indent=2),
            encoding="utf-8"
        )


load_devices()


# -------------------------
# ONVIF helpers
# -------------------------

def parse_xaddr(xaddr: str):
    # typical: http://192.168.1.10:8899/onvif/device_service
    m = re.match(r"^https?://([^/:]+)(?::(\d+))?/", xaddr)
    if not m:
        raise ValueError(f"Invalid xaddr: {xaddr}")
    host = m.group(1)
    port = int(m.group(2) or "80")
    return host, port


def onvif_camera_from(stored: StoredDevice) -> ONVIFCamera:
    # ONVIFCamera(host, port, username, password)
    return ONVIFCamera(stored.host, stored.port, stored.username, stored.password)


# -------------------------
# Stream manager (ffmpeg -> HLS)
# -------------------------

_streams_lock = threading.Lock()
_streams: Dict[str, subprocess.Popen] = {}  # device_id -> ffmpeg process


def _kill_process_tree(p: subprocess.Popen):
    try:
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
            try:
                p.wait(timeout=4)
            except subprocess.TimeoutExpired:
                p.kill()
    except Exception:
        pass


def stop_stream(device_id: str):
    with _streams_lock:
        p = _streams.get(device_id)
        if p:
            _kill_process_tree(p)
            _streams.pop(device_id, None)

    # cleanup HLS files
    out_dir = HLS_ROOT / device_id
    if out_dir.exists():
        shutil.rmtree(out_dir, ignore_errors=True)


def start_hls_stream(device_id: str, rtsp_url: str):
    # Stop existing stream + remove old HLS dir FIRST
    stop_stream(device_id)

    out_dir = HLS_ROOT / device_id
    out_dir.mkdir(parents=True, exist_ok=True)

    playlist = out_dir / "index.m3u8"
    segment_pattern = str(out_dir / "seg_%05d.ts")
    log_file = out_dir / "ffmpeg.log"

    ffmpeg_bin = shutil.which("ffmpeg") or "/usr/bin/ffmpeg"
    if not os.path.exists(ffmpeg_bin):
        raise HTTPException(
            status_code=500,
            detail=f"ffmpeg binary not found. which(ffmpeg)={shutil.which('ffmpeg')}, tried={ffmpeg_bin}"
        )

    cmd = [
        ffmpeg_bin,
        "-hide_banner",
        "-loglevel", "warning",
        "-rtsp_transport", "tcp",
        "-fflags", "+genpts",
        "-i", rtsp_url,
        "-an",
        # Strongly recommended for browser compatibility:
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        "-g", "50",
        "-sc_threshold", "0",
        "-f", "hls",
        "-hls_time", "1",
        "-hls_list_size", "6",
        "-hls_flags", "delete_segments+append_list+program_date_time",
        "-hls_segment_filename", segment_pattern,
        str(playlist),
    ]

    try:
        lf = open(log_file, "w", encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to open ffmpeg log file '{log_file}': {e}")

    try:
        p = subprocess.Popen(cmd, stdout=lf, stderr=lf)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Failed to execute ffmpeg at '{ffmpeg_bin}': {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start ffmpeg: {e}")

    with _streams_lock:
        _streams[device_id] = p

    # Wait for playlist to appear (and confirm ffmpeg didn't die)
    deadline = time.time() + 6.0
    while time.time() < deadline:
        if p.poll() is not None:
            try:
                tail = log_file.read_text(encoding="utf-8")[-2000:]
            except Exception:
                tail = "(unable to read ffmpeg log)"
            raise HTTPException(status_code=500, detail=f"ffmpeg exited early.\n{tail}")
        if playlist.exists() and playlist.stat().st_size > 0:
            return f"/hls/{device_id}/index.m3u8"
        time.sleep(0.15)

    try:
        tail = log_file.read_text(encoding="utf-8")[-2000:]
    except Exception:
        tail = "(unable to read ffmpeg log)"
    raise HTTPException(status_code=504, detail=f"HLS playlist was not created in time.\n{tail}")


# -------------------------
# API
# -------------------------

@app.get("/api/devices/saved")
def list_saved():
    with _devices_lock:
        return {"devices": [
            {
                "device_id": d.device_id,
                "xaddr": d.xaddr,
                "host": d.host,
                "port": d.port,
                "manufacturer": d.manufacturer,
                "model": d.model,
                "name": d.name,
            }
            for d in _devices.values()
        ]}


@app.get("/api/devices/discover")
def discover(timeout: float = 3.0):
    """
    WS-Discovery probe for ONVIF devices.
    Returns xaddrs we can connect to.
    """
    wsd = WSDiscovery()
    wsd.start()

    # ONVIF type
    onvif_type = QName("http://www.onvif.org/ver10/network/wsdl", "NetworkVideoTransmitter")

    services = wsd.searchServices(types=[onvif_type], timeout=timeout)
    wsd.stop()

    found = []
    for s in services:
        xaddrs = getattr(s, "getXAddrs", None)
        if not xaddrs:
            continue
        for xaddr in s.getXAddrs():
            try:
                host, port = parse_xaddr(xaddr)
            except Exception:
                continue
            device_id = _safe_id(xaddr)
            found.append({
                "device_id": device_id,
                "xaddr": xaddr,
                "host": host,
                "port": port,
            })

    # de-dupe by xaddr
    uniq = {f["xaddr"]: f for f in found}
    return {"devices": list(uniq.values())}


@app.post("/api/devices/connect")
def connect(req: ConnectRequest):
    try:
        host, port = parse_xaddr(req.xaddr)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    device_id = _safe_id(req.xaddr)
    stored = StoredDevice(
        device_id=device_id,
        xaddr=req.xaddr,
        host=host,
        port=port,
        username=req.username,
        password=req.password,
    )

    with _devices_lock:
        _devices[device_id] = stored
        save_devices()

    # IMPORTANT: do NOT call ONVIF here (prevents hanging)
    return {"device_id": device_id, "ok": True}


@app.get("/api/devices/{device_id}/profiles")
def get_profiles(device_id: str):
    with _devices_lock:
        d = _devices.get(device_id)
    if not d:
        raise HTTPException(status_code=404, detail="Unknown device_id. Connect it first.")

    def _work():
        cam = onvif_camera_from(d)
        media = cam.create_media_service()
        return media.GetProfiles()

    fut = _executor.submit(_work)
    try:
        profiles = fut.result(timeout=4.0)
    except FuturesTimeout:
        raise HTTPException(status_code=504, detail="Timeout talking to camera (profiles).")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get profiles: {e}")

    return {"profiles": [{"token": getattr(p, "token", None), "name": getattr(p, "Name", None)} for p in profiles]}


@app.post("/api/stream/start")
def api_start_stream(req: StartStreamRequest):
    with _devices_lock:
        d = _devices.get(req.device_id)
    if not d:
        raise HTTPException(status_code=404, detail="Unknown device_id. Connect it first.")

    # Build RTSP URL via ONVIF
    try:
        cam = onvif_camera_from(d)
        media = cam.create_media_service()

        # Many cameras require StreamSetup structure:
        stream_setup = {
            "Stream": "RTP-Unicast",
            "Transport": {"Protocol": "RTSP"},
        }
        resp = media.GetStreamUri({
            "StreamSetup": stream_setup,
            "ProfileToken": req.profile_token,
        })
        rtsp_url = resp.Uri
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to obtain RTSP URI from ONVIF: {e}")

    # Some devices return rtsp://host/... without creds. Embed creds if absent.
    if rtsp_url.startswith("rtsp://") and "@" not in rtsp_url:
        # rtsp://host/path -> rtsp://user:pass@host/path
        rtsp_url = rtsp_url.replace("rtsp://", f"rtsp://{d.username}:{d.password}@", 1)

    playlist_url = start_hls_stream(req.device_id, rtsp_url)
    return {"hls": playlist_url, "rtsp": rtsp_url}


@app.post("/api/stream/stop")
def api_stop_stream(device_id: str):
    stop_stream(device_id)
    return {"ok": True}


@app.get("/api/stream/status")
def api_stream_status():
    with _streams_lock:
        running = []
        for device_id, p in _streams.items():
            running.append({"device_id": device_id, "running": (p.poll() is None)})
    return {"streams": running}


@app.get("/api/stream/log")
def stream_log(device_id: str):
    log_file = (HLS_ROOT / device_id / "ffmpeg.log")
    if not log_file.exists():
        raise HTTPException(status_code=404, detail="No ffmpeg log for that device.")
    txt = log_file.read_text(encoding="utf-8")
    return {"log_tail": txt[-4000:]}


@app.get("/api/debug/ffmpeg")
def debug_ffmpeg():
    return {
        "path_env": os.environ.get("PATH"),
        "which_ffmpeg": shutil.which("ffmpeg"),
        "exists_usr_bin_ffmpeg": os.path.exists("/usr/bin/ffmpeg"),
    }