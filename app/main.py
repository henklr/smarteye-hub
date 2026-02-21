from pathlib import Path
import subprocess
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from onvif import ONVIFCamera

app = FastAPI()

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# publish into MediaMTX over the docker network
MEDIAMTX_PUBLISH_URL = "rtsp://mediamtx:8554/cam1"

_ffmpeg: Optional[subprocess.Popen] = None


@app.get("/", response_class=HTMLResponse)
def index():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/health")
def health():
    return {"ok": True}


class ConnectRequest(BaseModel):
    ip: str
    port: int = 80          # ONVIF port
    rtsp_port: int = 554    # RTSP port (some cameras embed it in URI already, but keep it handy)
    username: str
    password: str


def _stop_ffmpeg():
    global _ffmpeg
    if _ffmpeg and _ffmpeg.poll() is None:
        _ffmpeg.terminate()
        try:
            _ffmpeg.wait(timeout=3)
        except subprocess.TimeoutExpired:
            _ffmpeg.kill()
    _ffmpeg = None


def _get_rtsp_uri(req: ConnectRequest) -> str:
    cam = ONVIFCamera(req.ip, req.port, req.username, req.password)
    media = cam.create_media_service()
    profiles = media.GetProfiles()
    if not profiles:
        raise RuntimeError("No ONVIF media profiles found.")

    token = profiles[0].token
    uri_resp = media.GetStreamUri(
        {
            "StreamSetup": {"Stream": "RTP-Unicast", "Transport": {"Protocol": "RTSP"}},
            "ProfileToken": token,
        }
    )
    rtsp = uri_resp.Uri
    if not rtsp or not rtsp.lower().startswith("rtsp"):
        raise RuntimeError(f"Unexpected RTSP URI: {rtsp}")

    # add credentials if absent
    if "@" not in rtsp:
        rtsp = rtsp.replace("rtsp://", f"rtsp://{req.username}:{req.password}@", 1)

    return rtsp


def _start_ffmpeg(rtsp_in: str):
    """
    Pull RTSP from camera, transcode to H264 baseline, push RTSP to MediaMTX path 'cam1'.
    This makes WebRTC broadly compatible with browsers.  [oai_citation:6‡mediamtx.org](https://mediamtx.org/docs/usage/webrtc-specific-features)
    """
    global _ffmpeg
    _stop_ffmpeg()

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "warning",

        "-rtsp_transport", "tcp",
        "-i", rtsp_in,

        "-an",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "baseline",
        "-level", "3.1",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-g", "50",
        "-keyint_min", "50",
        "-sc_threshold", "0",

        "-f", "rtsp",
        "-rtsp_transport", "tcp",
        MEDIAMTX_PUBLISH_URL,
    ]

    _ffmpeg = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@app.post("/api/connect")
def connect(req: ConnectRequest):
    try:
        rtsp = _get_rtsp_uri(req)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF failed: {e}")

    try:
        _start_ffmpeg(rtsp)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffmpeg not found in container.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ffmpeg start failed: {e}")

    # tiny delay so the publisher appears
    time.sleep(0.3)
    return {"ok": True}


@app.post("/api/stop")
def stop():
    _stop_ffmpeg()
    return {"ok": True}