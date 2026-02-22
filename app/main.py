from pathlib import Path
import os
import socket
import subprocess
import time
from typing import Optional, Dict, Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from onvif import ONVIFCamera

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

FFMPEG_LOG = DATA_DIR / "ffmpeg.log"

MEDIAMTX_PUBLISH_URL = os.getenv("MEDIAMTX_PUBLISH_URL", "rtsp://mediamtx:8554/cam1")
MEDIAMTX_HOST = "mediamtx"
MEDIAMTX_RTSP_PORT = 8554

_ffmpeg: Optional[subprocess.Popen] = None


@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/health")
def health():
    return {"ok": True}


class OnvifBase(BaseModel):
    ip: str
    onvif_port: int = 80
    username: str
    password: str


class StartRequest(OnvifBase):
    profile_token: str


def _stop_ffmpeg():
    global _ffmpeg
    if _ffmpeg and _ffmpeg.poll() is None:
        _ffmpeg.terminate()
        try:
            _ffmpeg.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _ffmpeg.kill()
    _ffmpeg = None


def _log_tail(n: int = 4000) -> str:
    if not FFMPEG_LOG.exists():
        return "(no ffmpeg.log yet)"
    try:
        return FFMPEG_LOG.read_text(errors="ignore")[-n:]
    except Exception:
        return "(failed to read ffmpeg.log)"


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

    # add credentials if absent
    if "@" not in rtsp:
        rtsp = rtsp.replace("rtsp://", f"rtsp://{req.username}:{req.password}@", 1)

    return rtsp


def _rtsp_describe_ok_for_cam1(timeout_s: float = 1.0) -> bool:
    """
    Check if MediaMTX has a stream available on path 'cam1' via RTSP DESCRIBE.
    Doesn't require MediaMTX API and works even if API auth is enabled.
    """
    req = (
        f"DESCRIBE rtsp://{MEDIAMTX_HOST}:{MEDIAMTX_RTSP_PORT}/cam1 RTSP/1.0\r\n"
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


def _start_ffmpeg(rtsp_in: str):
    global _ffmpeg
    _stop_ffmpeg()

    FFMPEG_LOG.write_text("", encoding="utf-8")
    log_f = open(FFMPEG_LOG, "a")

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "info",

        "-rtsp_transport", "tcp",
        "-rtsp_flags", "prefer_tcp",
        "-i", rtsp_in,

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
        MEDIAMTX_PUBLISH_URL,
    ]

    _ffmpeg = subprocess.Popen(cmd, stdout=log_f, stderr=log_f)


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


@app.post("/api/start")
def start(req: StartRequest):
    try:
        rtsp = _get_stream_uri(req, req.profile_token)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF stream uri failed: {e}")

    try:
        _start_ffmpeg(rtsp)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffmpeg not found in container.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg failed to start: {e}")

    # Wait up to ~8s for publisher to appear on cam1
    for _ in range(80):
        if _ffmpeg and _ffmpeg.poll() is not None:
            raise HTTPException(status_code=500, detail="ffmpeg exited:\n\n" + _log_tail())
        if _rtsp_describe_ok_for_cam1():
            return {"ok": True}
        time.sleep(0.1)

    raise HTTPException(status_code=500, detail="Timed out waiting for cam1 to become online.\n\n" + _log_tail())


@app.post("/api/stop")
def stop():
    _stop_ffmpeg()
    return {"ok": True}


@app.get("/api/debug/ffmpeg-log")
def ffmpeg_log():
    return {"tail": _log_tail()}