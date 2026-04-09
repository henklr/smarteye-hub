"""
cloud_connector.py — SmartEye Pi → Cloud relay client

Connects OUTBOUND to the cloud dashboard server via WebSocket.
No inbound ports needed on the Pi.

Protocol (over a single persistent WebSocket):
  Pi → Cloud text:   {"type": "register", "device_id": "...", "cameras": [...]}
  Pi → Cloud binary: <36-byte ASCII stream_id> + <fMP4 video data>
  Cloud → Pi text:   {"type": "start_stream", "stream_id": "...", "camera_id": "..."}
  Cloud → Pi text:   {"type": "stop_stream",  "stream_id": "..."}

Environment variables:
  CLOUD_WS_URL    — ws(s)://host/pi/connect          (default: ws://localhost:5000/pi/connect)
  CLOUD_TOKEN     — shared secret matching PiToken in server appsettings.json
  HUB_DEVICE_ID   — identifier shown in the dashboard  (default: smarteye-pi)
  MEDIAMTX_RTSP   — base RTSP URL of local MediaMTX   (default: rtsp://localhost:8554)
  DATA_DIR        — path to data/ folder               (default: /app/data)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import threading
from pathlib import Path

import websockets
import websockets.exceptions

log = logging.getLogger("cloud_connector")

# ── Configuration ─────────────────────────────────────────────────────────────
CLOUD_WS_URL  = os.environ.get("CLOUD_WS_URL",   "ws://172.16.0.10:5000/pi/connect")
CLOUD_TOKEN   = os.environ.get("CLOUD_TOKEN",     "changeme-secret-token")
HUB_DEVICE_ID = os.environ.get("HUB_DEVICE_ID",  "smarteye-pi")
MEDIAMTX_RTSP = os.environ.get("MEDIAMTX_RTSP",  "rtsp://localhost:8554")
DATA_DIR      = Path(os.environ.get("DATA_DIR",   "/app/data"))

CHUNK_SIZE    = 32 * 1024   # bytes read per ffmpeg stdout read
RECONNECT_SEC = 5


# ── Camera streaming ──────────────────────────────────────────────────────────

async def _stream_camera(ws: websockets.WebSocketClientProtocol,
                         stream_id: str,
                         camera_id: str) -> None:
    """
    Spawn ffmpeg to pull RTSP from MediaMTX and push fragmented-MP4 chunks
    to the cloud as binary WebSocket frames.

    Binary frame layout: [36-byte ASCII stream_id][fMP4 data]
    """
    cam_path = camera_id if str(camera_id).startswith("cam-") else f"cam-{camera_id}"
    rtsp_url = f"{MEDIAMTX_RTSP}/{cam_path}"
    # 36-byte header: UUID is always exactly 36 ASCII chars
    header   = stream_id[:36].encode("ascii")

    log.info("Stream %s: starting ffmpeg for %s", stream_id, rtsp_url)

    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-i", rtsp_url,
        # Copy H.264 as-is (no transcoding = fast, no quality loss)
        "-c:v", "copy",
        "-an",                        # drop audio for simplicity
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    try:
        while True:
            chunk = await proc.stdout.read(CHUNK_SIZE)   # type: ignore[union-attr]
            if not chunk:
                log.info("Stream %s: ffmpeg ended (camera gone?)", stream_id)
                break
            await ws.send(header + chunk)
    except asyncio.CancelledError:
        log.info("Stream %s: cancelled", stream_id)
    except websockets.exceptions.ConnectionClosed:
        log.warning("Stream %s: WebSocket closed while sending", stream_id)
    finally:
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=3)
        except Exception:
            pass


# ── Main connector loop ───────────────────────────────────────────────────────

async def run_connector() -> None:
    """
    Persistent outbound connection to the cloud dashboard.
    Automatically reconnects on failure.
    """
    # Load camera list from devices.json
    cameras: list[dict] = []
    try:
        devices = json.loads((DATA_DIR / "devices.json").read_text())["devices"]
        cameras = [{"id": d["id"], "name": d["name"]} for d in devices]
        log.info("Loaded %d camera(s) from devices.json", len(cameras))
    except Exception as exc:
        log.warning("Could not read devices.json: %s", exc)

    while True:
        stream_tasks: dict[str, asyncio.Task] = {}
        url = f"{CLOUD_WS_URL}?token={CLOUD_TOKEN}"

        try:
            log.info("Connecting to %s ...", CLOUD_WS_URL)
            async with websockets.connect(
                url,
                ping_interval=20,
                ping_timeout=10,
                close_timeout=5,
            ) as ws:
                # Register this device with the cloud
                await ws.send(json.dumps({
                    "type":      "register",
                    "device_id": HUB_DEVICE_ID,
                    "cameras":   cameras,
                }))
                log.info("Registered as '%s' with %d camera(s)", HUB_DEVICE_ID, len(cameras))

                async for raw in ws:
                    if not isinstance(raw, str):
                        continue   # we only send binary; cloud only sends text commands
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    t = msg.get("type")

                    if t == "start_stream":
                        sid = msg["stream_id"]
                        cid = msg["camera_id"]
                        log.info("start_stream: %s  camera=%s", sid, cid)
                        # Cancel any prior task for this stream_id (shouldn't happen)
                        if sid in stream_tasks:
                            stream_tasks[sid].cancel()
                        stream_tasks[sid] = asyncio.create_task(
                            _stream_camera(ws, sid, cid),
                            name=f"stream-{sid[:8]}",
                        )

                    elif t == "stop_stream":
                        sid = msg["stream_id"]
                        log.info("stop_stream: %s", sid)
                        task = stream_tasks.pop(sid, None)
                        if task:
                            task.cancel()

                    elif t == "pong":
                        pass   # keepalive acknowledgement

        except websockets.exceptions.ConnectionClosed as exc:
            log.warning("Connection closed: %s", exc)
        except OSError as exc:
            log.warning("Connection failed: %s", exc)
        except Exception as exc:
            log.exception("Unexpected error: %s", exc)
        finally:
            # Cancel all running stream tasks before reconnecting
            for task in stream_tasks.values():
                task.cancel()
            if stream_tasks:
                await asyncio.gather(*stream_tasks.values(), return_exceptions=True)
            stream_tasks.clear()

        log.info("Reconnecting in %ds …", RECONNECT_SEC)
        await asyncio.sleep(RECONNECT_SEC)


# ── Integration with main FastAPI app ─────────────────────────────────────────

_connector_thread: threading.Thread | None = None


def configure_connector(
    *,
    cloud_ws_url: str,
    cloud_token: str,
    hub_device_id: str,
    mediamtx_rtsp: str,
) -> None:
    """Update connector runtime config for future connects/reconnects."""
    global CLOUD_WS_URL, CLOUD_TOKEN, HUB_DEVICE_ID, MEDIAMTX_RTSP

    CLOUD_WS_URL = cloud_ws_url.strip()
    CLOUD_TOKEN = cloud_token.strip()
    HUB_DEVICE_ID = hub_device_id.strip()
    MEDIAMTX_RTSP = mediamtx_rtsp.strip()

    # Keep env in sync so child processes and diagnostics reflect active settings.
    os.environ["CLOUD_WS_URL"] = CLOUD_WS_URL
    os.environ["CLOUD_TOKEN"] = CLOUD_TOKEN
    os.environ["HUB_DEVICE_ID"] = HUB_DEVICE_ID
    os.environ["MEDIAMTX_RTSP"] = MEDIAMTX_RTSP


def is_connector_running() -> bool:
    return bool(_connector_thread and _connector_thread.is_alive())


def start_cloud_connector() -> None:
    """
    Start the cloud connector in a background daemon thread with its own
    asyncio event loop.  Call from main.py startup if CLOUD_WS_URL is set.
    """
    global _connector_thread
    if _connector_thread and _connector_thread.is_alive():
        return

    def _run() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(run_connector())
        finally:
            loop.close()

    _connector_thread = threading.Thread(target=_run, name="cloud-connector", daemon=True)
    _connector_thread.start()
    log.info("Cloud connector started (background thread)")


# ── Standalone entry-point ────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    loop = asyncio.new_event_loop()

    def _shutdown(*_):
        loop.stop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _shutdown)
        except NotImplementedError:
            pass   # Windows

    try:
        loop.run_until_complete(run_connector())
    finally:
        loop.close()
