"""
dashboard_connector.py — SmartEye Pi → SmartEye Dashboard (.NET) client.

Two responsibilities:

  1. **Registration** with the dotnet backend at `{backend_url}/Device/RegisterDevice`.
     The user enters the registration key (generated on the dashboard via
     InternalController.GetRegisterDeviceKey) on the Pi settings page; we POST
     the device's MAC address along with the key and receive a long-lived
     device password back which we persist on disk.

  2. **Streaming**: an OUTBOUND, persistent WebSocket to
     `{backend_url}/Device/Stream` authenticated via the `X-Device-MAC` and
     `X-Device-Password` headers.  ffmpeg pulls the local camera RTSP from
     MediaMTX and we forward fragmented MP4 chunks as binary frames so that
     `DeviceController.Stream` can broadcast them to all dashboard viewers
     calling `Device/WatchStream/{siteId}`.

The connector reconnects automatically with a fixed back-off whenever the
WebSocket drops, ffmpeg dies, or the Pi reboots.

Persisted state lives in `${DATA_DIR}/dashboard_credentials.json`:

    {
      "backend_url":  "https://dashboard.smarteye.dk",
      "mac_address":  "dc:a6:32:xx:xx:xx",
      "device_password": "<base64 password from server>",
      "site_id": "<optional>"
    }
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Optional

import websockets
import websockets.exceptions

try:
    import fcntl  # POSIX only; the Pi container is Linux so this is fine.
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

# Set CONNECTOR_INSECURE_TLS=1 when testing against a dev dashboard with a
# self-signed cert (e.g. ASP.NET Core's localhost dev cert). Never enable in
# production — it disables both cert verification and hostname checks.
INSECURE_TLS = os.getenv("CONNECTOR_INSECURE_TLS", "").lower() in ("1", "true", "yes")


def _make_ssl_context() -> Optional[ssl.SSLContext]:
    if not INSECURE_TLS:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx

log = logging.getLogger("dashboard_connector")

# Local API server the connector forwards dashboard requests to. The hub binds
# its FastAPI app on port 80 inside its container (see Dockerfile). Override
# with CONNECTOR_LOCAL_API to test against a different bind.
LOCAL_API_BASE = os.getenv("CONNECTOR_LOCAL_API", "http://127.0.0.1:80").rstrip("/")

# mediamtx exposes HLS for each "cam-*" path on port 8888 by default; the
# dashboard routes its multi-camera grid traffic through us under the
# `/_hls/` prefix so we can forward it to mediamtx instead of the hub API.
MEDIAMTX_HLS_BASE = os.getenv("CONNECTOR_MEDIAMTX_HLS", "http://mediamtx:8888").rstrip("/")
HLS_PATH_PREFIX = "/_hls/"
RPC_REQUEST_TIMEOUT = 30.0

# ── Configuration ─────────────────────────────────────────────────────────────

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
CREDENTIALS_FILE = DATA_DIR / "dashboard_credentials.json"
DEFAULT_BACKEND_URL = os.getenv("DASHBOARD_BACKEND_URL", "https://dashboard.smarteye.dk")

MEDIAMTX_RTSP = os.environ.get("MEDIAMTX_RTSP", "rtsp://mediamtx:8554")
DASHBOARD_CAMERA_ID = os.environ.get("DASHBOARD_CAMERA_ID", "").strip()

CHUNK_SIZE = 32 * 1024
RECONNECT_MIN_SEC = 2
RECONNECT_MAX_SEC = 60
# How long ws.send() may stall before we treat the connection as dead.
SEND_TIMEOUT_SEC = 15


# ── MAC address ───────────────────────────────────────────────────────────────

def get_mac_address() -> str:
    """Return the MAC address of the primary network interface."""
    for interface in ("eth0", "wlan0", "en0", "wlan1"):
        try:
            mac_path = f"/sys/class/net/{interface}/address"
            if os.path.exists(mac_path):
                with open(mac_path, "r", encoding="utf-8") as f:
                    mac = f.read().strip()
                if mac and mac != "00:00:00:00:00:00":
                    return mac
        except Exception:
            continue
    try:
        node = uuid.getnode()
        return ":".join(f"{(node >> shift) & 0xff:02x}"
                        for shift in range(40, -1, -8))
    except Exception:
        return "00:00:00:00:00:01"


# ── Credentials persistence ───────────────────────────────────────────────────

def load_credentials() -> Optional[dict[str, str]]:
    try:
        if CREDENTIALS_FILE.exists():
            return json.loads(CREDENTIALS_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        log.warning("Failed to load credentials: %s", exc)
    return None


def save_credentials(creds: dict[str, str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CREDENTIALS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(creds, indent=2), encoding="utf-8")
    tmp.replace(CREDENTIALS_FILE)
    log.info("Saved dashboard credentials")


def clear_credentials() -> None:
    try:
        if CREDENTIALS_FILE.exists():
            CREDENTIALS_FILE.unlink()
            log.info("Cleared dashboard credentials")
    except Exception as exc:
        log.warning("Failed to clear credentials: %s", exc)


def is_registered() -> bool:
    creds = load_credentials() or {}
    return bool(creds.get("device_password") and creds.get("backend_url"))


# ── URL helpers ───────────────────────────────────────────────────────────────

def _normalize_backend_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    return url


def _backend_to_ws_url(backend_url: str, path: str) -> str:
    backend_url = _normalize_backend_url(backend_url)
    if backend_url.startswith("https://"):
        return "wss://" + backend_url[len("https://"):] + path
    if backend_url.startswith("http://"):
        return "ws://" + backend_url[len("http://"):] + path
    return backend_url + path


# ── Registration ──────────────────────────────────────────────────────────────

def register_device(backend_url: str, registration_key: str) -> dict[str, Any]:
    """Call `{backend_url}/Device/RegisterDevice` and persist the password."""
    backend_url = _normalize_backend_url(backend_url)
    if not backend_url:
        raise ValueError("backend_url is required")
    if not registration_key:
        raise ValueError("registration key is required")

    mac_address = get_mac_address()
    register_url = f"{backend_url}/Device/RegisterDevice"
    payload = json.dumps({
        "MacAddress": mac_address,
        "Key": registration_key,
    }).encode("utf-8")

    req = urllib.request.Request(
        register_url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "SmartEye-Pi/1.0",
        },
        method="POST",
    )

    ssl_ctx = _make_ssl_context()
    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl_ctx) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8") if exc.fp else ""
        except Exception:
            pass
        raise RuntimeError(f"Registration rejected by server ({exc.code}): {detail or exc.reason}")
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Network error contacting {register_url}: {exc.reason}")

    try:
        result = json.loads(body)
    except json.JSONDecodeError:
        raise RuntimeError(f"Unexpected non-JSON response: {body[:200]}")

    # The dotnet API returns RegisterDeviceResponse { DevicePassword } as JSON,
    # serialised with the default camelCase contract.
    password = (result or {}).get("devicePassword") or (result or {}).get("DevicePassword")
    if not password:
        raise RuntimeError(f"Server response missing devicePassword: {body[:200]}")

    creds = {
        "backend_url": backend_url,
        "mac_address": mac_address,
        "device_password": password,
    }
    save_credentials(creds)
    log.info("Device registered with %s as %s", backend_url, mac_address)
    return creds


def get_status() -> dict[str, Any]:
    """Public registration + connector status used by the settings UI."""
    creds = load_credentials() or {}
    return {
        "registered": is_registered(),
        "backend_url": creds.get("backend_url", ""),
        "mac_address": creds.get("mac_address") or get_mac_address(),
        "running": is_running(),
        "default_backend_url": DEFAULT_BACKEND_URL,
    }


# ── Streaming ─────────────────────────────────────────────────────────────────

def _pick_camera_id() -> Optional[str]:
    """Return the camera id whose stream is forwarded to the dashboard."""
    if DASHBOARD_CAMERA_ID:
        return DASHBOARD_CAMERA_ID
    try:
        devices_file = DATA_DIR / "devices.json"
        if devices_file.exists():
            data = json.loads(devices_file.read_text(encoding="utf-8"))
            for d in data.get("devices", []) or []:
                if d.get("id"):
                    return d["id"]
    except Exception as exc:
        log.warning("Could not read devices.json: %s", exc)
    return None


async def _spawn_ffmpeg(camera_id: str) -> asyncio.subprocess.Process:
    cam_path = camera_id if str(camera_id).startswith("cam-") else f"cam-{camera_id}"
    rtsp_url = f"{MEDIAMTX_RTSP}/{cam_path}"
    log.info("Starting ffmpeg for %s", rtsp_url)
    # ``-nostdin`` (and stdin=DEVNULL for belt-and-braces) stops ffmpeg from
    # reading stdin to look for keystrokes like 'q'. Under Docker, uvicorn's
    # stdin is /dev/null and ffmpeg interprets the immediate EOF as a clean
    # quit before any packets are processed — the connector then sees rc=0
    # plus "Output file is empty, nothing was encoded".
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-loglevel", "warning",
        "-rtsp_transport", "tcp",
        "-i", rtsp_url,
        "-map", "0:v:0",
        "-c:v", "copy",
        "-an",
        "-f", "mp4",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
        "pipe:1",
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    # Grow the kernel pipe buffer so ffmpeg can keep writing while the WS
    # send loop is slow. Default is 64 KB; with HD-ish video that fills
    # within a single keyframe interval, ffmpeg blocks on write, and after
    # a while it gives up and exits cleanly with rc=0 (no error logged).
    # 1 MB is the per-process limit on Linux without /proc/sys tweaks.
    if fcntl is not None and proc.stdout is not None:
        try:
            F_SETPIPE_SZ = 1031  # not in fcntl module on all builds
            transport = proc.stdout._transport  # type: ignore[attr-defined]
            pipe = transport.get_extra_info("pipe")
            if pipe is not None:
                fcntl.fcntl(pipe.fileno(), F_SETPIPE_SZ, 1024 * 1024)
        except Exception as exc:
            log.debug("Couldn't grow ffmpeg stdout pipe buffer: %s", exc)
    return proc


async def _drain_ffmpeg_stderr(proc: asyncio.subprocess.Process) -> None:
    """Stream ffmpeg's stderr to our log so failures aren't silent."""
    if proc.stderr is None:
        return
    try:
        while True:
            line = await proc.stderr.readline()
            if not line:
                return
            text = line.decode("utf-8", errors="replace").rstrip()
            if text:
                log.warning("ffmpeg: %s", text)
    except asyncio.CancelledError:
        raise
    except Exception:
        pass


async def _stream_session(creds: dict[str, str]) -> None:
    """One full WebSocket session: connect → stream until either side drops."""
    ws_url = _backend_to_ws_url(creds["backend_url"], "/Device/Stream")
    headers = {
        "X-Device-MAC": creds["mac_address"],
        "X-Device-Password": creds["device_password"],
    }

    camera_id = _pick_camera_id()
    if not camera_id:
        log.warning("No camera configured; will retry shortly")
        await asyncio.sleep(RECONNECT_MIN_SEC)
        return

    log.info("Connecting to dashboard %s", ws_url)
    # Aggressive keepalives so we detect a half-open / restarted server fast.
    # ``additional_headers`` is the modern websockets API; older versions used
    # ``extra_headers``.  Fall back transparently.
    connect_kwargs = dict(ping_interval=10, ping_timeout=10, close_timeout=5,
                          open_timeout=15, max_size=None)
    ssl_ctx = _make_ssl_context()
    if ssl_ctx is not None and ws_url.startswith("wss://"):
        connect_kwargs["ssl"] = ssl_ctx
    try:
        ws_ctx = websockets.connect(ws_url, additional_headers=headers,
                                    **connect_kwargs)
    except TypeError:
        ws_ctx = websockets.connect(ws_url, extra_headers=headers,
                                    **connect_kwargs)

    proc: Optional[asyncio.subprocess.Process] = None
    async with ws_ctx as ws:
        log.info("Dashboard stream connected")
        proc = await _spawn_ffmpeg(camera_id)

        # Drain ffmpeg's stderr in parallel so failures (rtsp errors, codec
        # mismatches, etc.) surface in our log instead of dying silently.
        stderr_task = asyncio.create_task(_drain_ffmpeg_stderr(proc))

        # A sentinel task that resolves the moment the peer closes the WS or
        # any protocol-level error occurs.  When it resolves, we cancel the
        # ffmpeg pump so the session tears down immediately instead of
        # blocking on a doomed ws.send().
        async def _wait_close() -> None:
            try:
                async for _ in ws:
                    # We don't expect inbound frames; ignore anything received.
                    pass
            except Exception:
                pass

        closer = asyncio.create_task(_wait_close())

        # Decouple "read from ffmpeg" from "send over WS": a bounded queue
        # between the two means the reader can always drain ffmpeg's stdout
        # at line speed (preventing pipe-full → ffmpeg-clean-exit), while the
        # sender feeds the WS at whatever rate it can. If the WS truly can't
        # keep up, the queue eventually fills and only THEN does the reader
        # back off — but with a 256-slot queue that's ~8 MB of buffer.
        send_queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=256)

        async def _read_into_queue() -> int:
            """Drain ffmpeg's stdout into the queue. Returns the chunk count."""
            assert proc and proc.stdout is not None
            chunks = 0
            total = 0
            while True:
                chunk = await proc.stdout.read(CHUNK_SIZE)
                if not chunk:
                    log.info("ffmpeg ended after %d chunks/%d bytes (rc=%s)",
                             chunks, total,
                             proc.returncode if proc.returncode is not None else "?")
                    await send_queue.put(None)  # sentinel
                    return chunks
                chunks += 1
                total += len(chunk)
                if chunks <= 3 or chunks % 200 == 0:
                    log.info("ffmpeg pumped chunk #%d (%d bytes; running total %d; queue=%d)",
                             chunks, len(chunk), total, send_queue.qsize())
                await send_queue.put(chunk)

        async def _send_from_queue() -> None:
            chunks = 0
            while True:
                chunk = await send_queue.get()
                if chunk is None:
                    return  # EOF sentinel — reader is done
                chunks += 1
                try:
                    await asyncio.wait_for(ws.send(chunk), timeout=SEND_TIMEOUT_SEC)
                except Exception as exc:
                    log.warning("ws.send failed at chunk #%d: %s: %s",
                                chunks, type(exc).__name__, exc)
                    raise

        async def _pump() -> None:
            reader = asyncio.create_task(_read_into_queue())
            sender = asyncio.create_task(_send_from_queue())
            try:
                done, pending = await asyncio.wait(
                    {reader, sender}, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                for t in done:
                    if t.exception():
                        raise t.exception()  # type: ignore[misc]
            finally:
                for t in (reader, sender):
                    if not t.done():
                        t.cancel()
                        try: await t
                        except BaseException: pass

        pump = asyncio.create_task(_pump())
        try:
            done, pending = await asyncio.wait(
                {pump, closer},
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            # Surface any exception from whichever task finished first.
            for t in done:
                exc = t.exception()
                if exc:
                    raise exc
        finally:
            for t in (pump, closer, stderr_task):
                if not t.done():
                    t.cancel()
                    try:
                        await t
                    except BaseException:
                        pass
            try:
                if proc and proc.returncode is None:
                    proc.terminate()
                    await asyncio.wait_for(proc.wait(), timeout=3)
            except Exception:
                pass


# ── RPC tunnel ────────────────────────────────────────────────────────────────
#
# A second outbound WebSocket to `{backend_url}/Device/Rpc` over which the
# dashboard forwards hub-bound HTTP requests as JSON envelopes:
#
#   request : {"id", "method", "path", "headers"?, "body"?, "body_b64"?}
#   response: {"id", "status", "headers"?, "body"?, "body_b64"?}
#
# We hit our own FastAPI app at 127.0.0.1 with the auth-bypass header so the
# hub's existing routes serve us without us re-implementing every endpoint.

def _local_request(method: str, path: str, headers: dict[str, str],
                   body: Optional[bytes]) -> tuple[int, dict[str, str], bytes]:
    """Issue a blocking HTTP call to a local backend. Returns (status, headers, body).

    Routing:
      * paths under `/_hls/` go to mediamtx (no auth bypass header — mediamtx
        has its own auth and doesn't speak our internal token).
      * everything else goes to the hub's FastAPI app with the auth-bypass
        header so the hub's own routes serve us.
    """
    # Lazy import so a circular import (auth.py → ... → connector) is impossible.
    from auth import INTERNAL_BYPASS_HEADER, INTERNAL_BYPASS_TOKEN

    if not path.startswith("/"):
        path = "/" + path

    is_hls = path.startswith(HLS_PATH_PREFIX)
    if is_hls:
        # /_hls/cam-aabbcc/index.m3u8  →  http://mediamtx:8888/cam-aabbcc/index.m3u8
        url = f"{MEDIAMTX_HLS_BASE}/{path[len(HLS_PATH_PREFIX):].lstrip('/')}"
    else:
        url = f"{LOCAL_API_BASE}{path}"

    out_headers = {k: v for k, v in (headers or {}).items() if k.lower() not in
                   {"host", "content-length", "transfer-encoding"}}
    if not is_hls:
        out_headers[INTERNAL_BYPASS_HEADER] = INTERNAL_BYPASS_TOKEN
    out_headers.setdefault("User-Agent", "SmartEye-Connector/1.0")

    req = urllib.request.Request(url, data=body, headers=out_headers,
                                 method=method.upper())
    try:
        with urllib.request.urlopen(req, timeout=RPC_REQUEST_TIMEOUT) as resp:
            data = resp.read()
            resp_headers = {k: v for k, v in resp.headers.items()
                            if k.lower() not in {"transfer-encoding", "connection"}}
            return resp.status, resp_headers, data
    except urllib.error.HTTPError as exc:
        try:
            data = exc.read() if exc.fp else b""
        except Exception:
            data = b""
        resp_headers = dict(exc.headers.items()) if exc.headers else {}
        return exc.code, resp_headers, data


def _encode_body(data: bytes, content_type: str) -> dict[str, Any]:
    """Pick text vs base64 based on Content-Type so JSON stays JSON over the wire."""
    if not data:
        return {"body": ""}
    ct = (content_type or "").lower()
    is_text = ct.startswith("text/") or "json" in ct or "xml" in ct or \
              ct.startswith("application/javascript") or ct == ""
    if is_text:
        try:
            return {"body": data.decode("utf-8")}
        except UnicodeDecodeError:
            pass
    return {"body_b64": base64.b64encode(data).decode("ascii")}


def _decode_body(envelope: dict[str, Any]) -> bytes:
    if envelope.get("body_b64"):
        return base64.b64decode(envelope["body_b64"])
    body = envelope.get("body")
    if isinstance(body, str):
        return body.encode("utf-8")
    return b""


async def _handle_rpc_envelope(env: dict[str, Any]) -> dict[str, Any]:
    req_id = env.get("id")
    method = (env.get("method") or "GET").upper()
    path = env.get("path") or "/"
    headers = env.get("headers") or {}
    body = _decode_body(env)

    try:
        status, resp_headers, resp_body = await asyncio.to_thread(
            _local_request, method, path, headers, body if body else None
        )
        content_type = resp_headers.get("Content-Type") or resp_headers.get("content-type", "")
        return {"id": req_id, "status": status, "headers": resp_headers,
                **_encode_body(resp_body, content_type)}
    except Exception as exc:
        log.exception("RPC handler failed for %s %s", method, path)
        return {"id": req_id, "status": 502,
                "headers": {"Content-Type": "application/json"},
                "body": json.dumps({"detail": f"connector error: {exc}"})}


async def _rpc_session(creds: dict[str, str]) -> None:
    """One full RPC WebSocket session: receive request envelopes, respond."""
    ws_url = _backend_to_ws_url(creds["backend_url"], "/Device/Rpc")
    headers = {
        "X-Device-MAC": creds["mac_address"],
        "X-Device-Password": creds["device_password"],
    }

    connect_kwargs = dict(ping_interval=10, ping_timeout=10, close_timeout=5,
                          open_timeout=15, max_size=8 * 1024 * 1024)
    ssl_ctx = _make_ssl_context()
    if ssl_ctx is not None and ws_url.startswith("wss://"):
        connect_kwargs["ssl"] = ssl_ctx
    try:
        ws_ctx = websockets.connect(ws_url, additional_headers=headers,
                                    **connect_kwargs)
    except TypeError:
        ws_ctx = websockets.connect(ws_url, extra_headers=headers,
                                    **connect_kwargs)

    async with ws_ctx as ws:
        log.info("Dashboard RPC connected")
        send_lock = asyncio.Lock()

        async def _serve(env: dict[str, Any]) -> None:
            response = await _handle_rpc_envelope(env)
            payload = json.dumps(response)
            async with send_lock:
                await asyncio.wait_for(ws.send(payload), timeout=SEND_TIMEOUT_SEC)

        async for raw in ws:
            if isinstance(raw, bytes):
                # We don't expect binary on the RPC channel.
                continue
            try:
                env = json.loads(raw)
            except (TypeError, ValueError):
                log.warning("RPC: invalid JSON envelope, dropping")
                continue
            # Run each request in its own task so a slow handler doesn't block
            # the receive loop or other concurrent requests.
            asyncio.create_task(_serve(env))


async def _rpc_loop(stop_event: asyncio.Event) -> None:
    """Background loop that keeps the RPC WS connected with backoff."""
    backoff = RECONNECT_MIN_SEC
    while not stop_event.is_set():
        creds = load_credentials()
        if not creds or not creds.get("device_password"):
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=RECONNECT_MAX_SEC)
            except asyncio.TimeoutError:
                pass
            continue

        connected_ok = False
        try:
            await _rpc_session(creds)
            connected_ok = True
        except asyncio.CancelledError:
            raise
        except websockets.exceptions.InvalidStatusCode as exc:
            log.warning("Dashboard RPC rejected: %s", exc)
        except websockets.exceptions.ConnectionClosed as exc:
            log.warning("Dashboard RPC closed: %s", exc)
            connected_ok = True
        except (OSError, asyncio.TimeoutError, websockets.exceptions.WebSocketException) as exc:
            log.warning("Dashboard RPC connection failed: %s", exc)
        except Exception:
            log.exception("Unexpected error in dashboard RPC loop")

        if connected_ok:
            backoff = RECONNECT_MIN_SEC
        else:
            backoff = min(backoff * 2, RECONNECT_MAX_SEC)

        log.info("Reconnecting RPC in %ds", backoff)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=backoff)
        except asyncio.TimeoutError:
            pass


async def _connector_loop(stop_event: asyncio.Event) -> None:
    backoff = RECONNECT_MIN_SEC
    while not stop_event.is_set():
        creds = load_credentials()
        if not creds or not creds.get("device_password"):
            log.info("No dashboard credentials; connector idle")
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=RECONNECT_MAX_SEC)
            except asyncio.TimeoutError:
                pass
            continue

        connected_ok = False
        try:
            await _stream_session(creds)
            # _stream_session returning normally means we did at least connect
            # successfully (e.g., ffmpeg ended) — reset backoff.
            connected_ok = True
        except asyncio.CancelledError:
            raise
        except websockets.exceptions.InvalidStatusCode as exc:
            # 401/403/404 → bad credentials; do not hammer the server, but keep
            # the loop alive so the user can re-register without restarting.
            log.warning("Dashboard rejected connection: %s", exc)
        except websockets.exceptions.ConnectionClosed as exc:
            log.warning("Dashboard connection closed: %s", exc)
            connected_ok = True  # reached the server; quick retry is fine
        except (OSError, asyncio.TimeoutError, websockets.exceptions.WebSocketException) as exc:
            log.warning("Dashboard connection failed: %s", exc)
        except Exception:
            log.exception("Unexpected error in dashboard connector")

        if connected_ok:
            backoff = RECONNECT_MIN_SEC
        else:
            backoff = min(backoff * 2, RECONNECT_MAX_SEC)

        log.info("Reconnecting to dashboard in %ds", backoff)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=backoff)
        except asyncio.TimeoutError:
            pass


# ── Single-process gate ───────────────────────────────────────────────────────
#
# The container's CMD launches two uvicorn instances (port 80 and 443) that
# both load this module and both fire the FastAPI startup event. Without a
# gate, each one would spin up its own connector → both would race, each
# displacing the other's WebSocket on the dashboard side, and we'd see a
# tight reconnect loop. An exclusive fcntl lock on a per-container file lets
# the first uvicorn process win and the second one stand down cleanly.

SINGLETON_LOCK_PATH = os.getenv("CONNECTOR_LOCK_PATH",
                                "/tmp/smarteye-dashboard-connector.lock")
_singleton_fd: Optional[int] = None


def _acquire_singleton_lock() -> bool:
    global _singleton_fd
    if _singleton_fd is not None:
        return True
    if fcntl is None:
        return True  # Non-POSIX host; nothing to gate on.
    try:
        fd = os.open(SINGLETON_LOCK_PATH, os.O_WRONLY | os.O_CREAT, 0o644)
    except OSError as exc:
        log.warning("Could not open singleton lock %s: %s",
                    SINGLETON_LOCK_PATH, exc)
        return True  # Fail open — better to risk a duplicate than be silent.
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError):
        os.close(fd)
        return False
    _singleton_fd = fd
    return True


def _release_singleton_lock() -> None:
    global _singleton_fd
    if _singleton_fd is None:
        return
    try:
        if fcntl is not None:
            fcntl.flock(_singleton_fd, fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        os.close(_singleton_fd)
    except OSError:
        pass
    _singleton_fd = None


# ── Background thread management ──────────────────────────────────────────────

_thread: Optional[threading.Thread] = None
_loop: Optional[asyncio.AbstractEventLoop] = None
_stop_event: Optional[asyncio.Event] = None
_lock = threading.Lock()


def is_running() -> bool:
    return bool(_thread and _thread.is_alive())


def start_connector() -> None:
    """Start the background connector thread (idempotent).

    Stands down silently if another process in the same container already
    holds the singleton lock, so only one uvicorn instance runs the loops.
    """
    global _thread, _loop, _stop_event
    with _lock:
        if _thread and _thread.is_alive():
            return
        if not _acquire_singleton_lock():
            log.info("Dashboard connector: another process owns the lock; "
                     "this uvicorn instance will not run the connector loops")
            return

        loop = asyncio.new_event_loop()
        stop_event = asyncio.Event()

        def _run() -> None:
            asyncio.set_event_loop(loop)
            try:
                # Run the stream and RPC loops concurrently so a stall on one
                # WebSocket doesn't block the other from delivering / serving.
                async def _both() -> None:
                    await asyncio.gather(
                        _connector_loop(stop_event),
                        _rpc_loop(stop_event),
                    )
                loop.run_until_complete(_both())
            except Exception:
                log.exception("Dashboard connector loop crashed")
            finally:
                try:
                    pending = asyncio.all_tasks(loop)
                    for t in pending:
                        t.cancel()
                    loop.run_until_complete(asyncio.gather(*pending,
                                                           return_exceptions=True))
                except Exception:
                    pass
                loop.close()

        _loop = loop
        _stop_event = stop_event
        _thread = threading.Thread(target=_run, name="dashboard-connector",
                                   daemon=True)
        _thread.start()
        log.info("Dashboard connector thread started")


def stop_connector(timeout: float = 5.0) -> None:
    """Signal the connector loop to stop and wait for the thread to exit."""
    global _thread, _loop, _stop_event
    with _lock:
        thread = _thread
        loop = _loop
        stop_event = _stop_event
        _thread = None
        _loop = None
        _stop_event = None

    if not thread:
        _release_singleton_lock()
        return

    if loop and stop_event and loop.is_running():
        loop.call_soon_threadsafe(stop_event.set)

    deadline = time.time() + timeout
    thread.join(timeout=max(0.1, deadline - time.time()))
    _release_singleton_lock()
    log.info("Dashboard connector thread stopped")


# ── Standalone entry-point (debugging) ────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    start_connector()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        stop_connector()
