from __future__ import annotations

from pathlib import Path
import os
import json
import re as _re
import uuid
import importlib
import subprocess
import tempfile
import threading
import asyncio
import time
import urllib.request
import urllib.error
import urllib.parse
import base64
from typing import Optional, Dict, Any, List
from urllib.parse import urlsplit, urlunsplit

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel, Field
from onvif import ONVIFCamera
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from auth import (
    AuthMiddleware,
    pam_authenticate,
    _create_session_cookie,
    _verify_session_cookie,
    _check_rate_limit,
    _record_attempt,
    get_client_ip,
    AUTH_COOKIE_NAME,
    SESSION_MAX_AGE,
)

from flows import (
    router as flows_router,
    dispatch_flow_trigger,
    get_flow_topics_for_device,
    start_schedule_monitor,
    stop_schedule_monitor,
)
from playback import (
    router as playback_router,
    request_recorders_refresh,
    set_recording_path_refresher,
    start_recording_service,
    stop_recording_service,
    _list_segments as _playback_list_segments,
    _recordings_dir_for_device as _playback_recordings_dir,
)
from physical_io import start_physical_io_monitor, stop_physical_io_monitor

app = FastAPI()


# ── Security headers middleware ────────────────────────────────────────────────

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(self), camera=(self)"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        host = request.headers.get("host", "").split(":")[0] or "localhost"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            f"connect-src 'self' ws: wss:; "
            "media-src 'self' blob:; "
            "frame-src 'self'"
        )
        return response


class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

# Middleware is applied in reverse order (last added = first executed)
app.add_middleware(NoCacheStaticMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(AuthMiddleware)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(flows_router)
app.include_router(playback_router)

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DEVICES_JSON = DATA_DIR / "devices.json"
CLOUD_CONNECTOR_JSON = DATA_DIR / "cloud_connector.json"

MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://mediamtx:9997").rstrip("/")
MEDIAMTX_API_USER = os.getenv("MEDIAMTX_API_USER", "apiuser")
MEDIAMTX_API_PASS = os.getenv("MEDIAMTX_API_PASS", "apipass")

PTZ_WATCHDOG_SEC = float(os.getenv("PTZ_WATCHDOG_SEC", "0.25"))

EVENT_DEBUG = str(os.getenv("EVENT_DEBUG", "1")).strip().lower() in {"1", "true", "yes", "on"}

STREAM_STALE_SEC = float(os.getenv("STREAM_STALE_SEC", "8"))
PATH_PROGRESS_POLL_SEC = float(os.getenv("PATH_PROGRESS_POLL_SEC", "1.0"))

_VALID_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}

# ── System log ring buffer ─────────────────────────────────────────────────────

import logging
import collections

_LOG_BUFFER_SIZE = int(os.getenv("LOG_BUFFER_SIZE", "500"))
_log_buffer: collections.deque = collections.deque(maxlen=_LOG_BUFFER_SIZE)


_LOG_CATEGORIES = {
    "system", "devices", "streams", "onvif", "ptz", "cloud",
    "flows", "recording", "playback", "physical_io", "schedule",
    "uvicorn", "uvicorn.error", "uvicorn.access", "cloud_connector",
}


def _category_from_logger_name(name: str) -> str:
    if name.startswith("uvicorn"):
        return "server"
    return name


class _RingBufferHandler(logging.Handler):
    """Captures log records into an in-memory ring buffer."""

    _IGNORED_LOGGERS = {"uvicorn.access"}

    def emit(self, record: logging.LogRecord) -> None:
        if record.name in self._IGNORED_LOGGERS:
            return
        try:
            entry = {
                "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
                "level": record.levelname,
                "cat": _category_from_logger_name(record.name),
                "message": self.format(record),
            }
            _log_buffer.append(entry)
        except Exception:
            pass


_ring_handler = _RingBufferHandler()
_ring_handler.setLevel(logging.DEBUG)
_ring_handler.setFormatter(logging.Formatter("%(message)s"))

# Attach to root logger so all app + uvicorn messages are captured
logging.getLogger().addHandler(_ring_handler)
logging.getLogger().setLevel(logging.INFO)

# ── Named loggers for main.py ──────────────────────────────────────────────────

_log_system    = logging.getLogger("system")
_log_devices   = logging.getLogger("devices")
_log_streams   = logging.getLogger("streams")
_log_onvif     = logging.getLogger("onvif")
_log_ptz       = logging.getLogger("ptz")
_log_cloud     = logging.getLogger("cloud")


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

_ptz_manual_control_state: Dict[str, bool] = {}
_ptz_manual_control_lock = threading.RLock()


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

_flow_monitor_stop = threading.Event()
_flow_monitor_thread: Optional[threading.Thread] = None

_path_monitor_lock = threading.RLock()
_path_monitor_state: Dict[str, Dict[str, Any]] = {}


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


def _clear_ptz_watchdog(device_id: str) -> None:
    with _ptz_watchdog_lock:
        timer = _ptz_watchdogs.pop(device_id, None)
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass


def _dispatch_ptz_manual_control_trigger(
    device_id: str,
    active: bool,
    *,
    reason: str,
    pan: Optional[float] = None,
    tilt: Optional[float] = None,
    zoom: Optional[float] = None,
) -> None:
    with _ptz_manual_control_lock:
        previous = bool(_ptz_manual_control_state.get(device_id))
        if previous == active:
            return
        if active:
            _ptz_manual_control_state[device_id] = True
        else:
            _ptz_manual_control_state.pop(device_id, None)

    trigger = {
        "kind": "ptz_manual_control_started" if active else "ptz_manual_control_stopped",
        "device_id": device_id,
        "message": "PTZ manual control started" if active else "PTZ manual control stopped",
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "extra": {"reason": reason},
    }
    if pan is not None:
        trigger["pan"] = float(pan)
    if tilt is not None:
        trigger["tilt"] = float(tilt)
    if zoom is not None:
        trigger["zoom"] = float(zoom)
    dispatch_flow_trigger(trigger)


def _ptz_watchdog_stop(device_id: str) -> None:
    with _ptz_watchdog_lock:
        _ptz_watchdogs.pop(device_id, None)
    _ptz_stop(device_id, reason="watchdog")


# ── Authentication endpoints ──────────────────────────────────────────────────

@app.get("/login", response_class=HTMLResponse)
def login_page():
    return (STATIC_DIR / "login.html").read_text(encoding="utf-8")


@app.post("/api/auth/login")
def auth_login(body: Dict[str, Any], request: Request):
    client_ip = get_client_ip(request)

    if not _check_rate_limit(client_ip):
        _log_system.warning("Login rate-limited for %s", client_ip)
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")

    username = str(body.get("username") or "").strip()
    password = str(body.get("password") or "")

    if not username or not password:
        _record_attempt(client_ip)
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # Validate username format (prevent injection)
    if not _re.match(r'^[a-zA-Z0-9._-]{1,64}$', username):
        _record_attempt(client_ip)
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not pam_authenticate(username, password):
        _record_attempt(client_ip)
        _log_system.warning("Failed login attempt for user '%s' from %s", username, client_ip)
        raise HTTPException(status_code=401, detail="Invalid credentials")

    _log_system.info("User '%s' logged in from %s", username, client_ip)
    cookie_value = _create_session_cookie(username)
    response = JSONResponse(content={"ok": True, "user": username})
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=cookie_value,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="strict",
        path="/",
    )
    return response


@app.post("/api/auth/logout")
def auth_logout():
    response = JSONResponse(content={"ok": True})
    response.delete_cookie(key=AUTH_COOKIE_NAME, path="/")
    return response


@app.post("/api/auth/change-password")
def auth_change_password(body: Dict[str, Any], request: Request):
    username = getattr(request.state, "user", None)
    if not username:
        raise HTTPException(status_code=401, detail="Authentication required")

    current_password = str(body.get("current_password") or "")
    new_password = str(body.get("new_password") or "")

    if not current_password or not new_password:
        raise HTTPException(status_code=400, detail="Current and new passwords are required")

    if len(new_password) < 4:
        raise HTTPException(status_code=400, detail="New password must be at least 4 characters")

    # Verify current password
    if not pam_authenticate(username, current_password):
        raise HTTPException(status_code=403, detail="Current password is incorrect")

    # Change the password on the host via nsenter (shadow is mounted read-only,
    # so we must write through the host's PID-1 namespace).
    import subprocess
    try:
        proc = subprocess.run(
            ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "chpasswd"],
            input=f"{username}:{new_password}\n",
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode != 0:
            _log_system.error("chpasswd failed: %s", proc.stderr.strip())
            raise HTTPException(status_code=500, detail="Failed to change password")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Password change timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="nsenter/chpasswd utility not available")

    # chpasswd replaces /etc/shadow (new inode), making the bind-mount stale.
    # Remount rw, copy the host's updated shadow into the bind-mount, then
    # leave it rw (remount ro while open fails with EBUSY).
    try:
        subprocess.run(["mount", "-o", "remount,rw", "/etc/shadow"],
                        capture_output=True, timeout=5)
        subprocess.run(
            "nsenter -t 1 -m -- cat /etc/shadow > /etc/shadow",
            shell=True, capture_output=True, timeout=5,
        )
    except Exception as exc:
        _log_system.warning("Shadow sync error: %s", exc)

    _log_system.info("User '%s' changed their password", username)
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(request: Request):
    username = getattr(request.state, "user", None)
    return {"user": username}


@app.get("/", response_class=HTMLResponse)
def index_page():
    return (STATIC_DIR / "index.html").read_text(encoding="utf-8")


@app.get("/live", response_class=HTMLResponse)
def live_page():
    return (STATIC_DIR / "live.html").read_text(encoding="utf-8")


@app.get("/devices", response_class=HTMLResponse)
def devices_page():
    return (STATIC_DIR / "devices.html").read_text(encoding="utf-8")


@app.get("/settings", response_class=HTMLResponse)
def settings_page():
    return (STATIC_DIR / "settings.html").read_text(encoding="utf-8")


@app.get("/events", response_class=HTMLResponse)
def events_page():
    return (STATIC_DIR / "events.html").read_text(encoding="utf-8")


@app.post("/api/system/reboot")
def system_reboot():
    _log_system.warning("System reboot initiated")
    import subprocess as _sp
    _sp.run(["sync"], timeout=5)
    try:
        with open("/proc/sysrq-trigger", "w") as f:
            f.write("b")
    except Exception:
        _sp.Popen(["/sbin/reboot"], stdout=_sp.DEVNULL, stderr=_sp.DEVNULL)
    return {"ok": True, "message": "Reboot initiated"}


_DEFAULT_FILES = {
    "settings.json":          '{\n  "retention_days": 0,\n  "timezone": "UTC",\n  "ntp_server": "pool.ntp.org"\n}',
    "devices.json":           '{\n  "devices": []\n}',
    "cloud_connector.json":   '{}',
    "flows.json":             '{\n  "items": []\n}',
    "schedules.json":         '{\n  "items": []\n}',
    "recording_presets.json":  '{}',
    "flow_state.json":        '{}',
    "recording_events.json":  '[]',
    "public_variables.json":  '{}',
    "events.json":            '{"items": []}',
    "scenarios.json":          '{"items": []}',
}


@app.post("/api/system/restore-defaults")
def restore_defaults():
    _log_system.warning("Restoring all settings to factory defaults")
    import shutil
    for fname, content in _DEFAULT_FILES.items():
        (DATA_DIR / fname).write_text(content, encoding="utf-8")
    for subdir in ("recordings", "playback_clips"):
        p = DATA_DIR / subdir
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
            p.mkdir(parents=True, exist_ok=True)
    _log_system.warning("All settings restored to defaults")
    return {"ok": True, "message": "All settings restored to defaults. Please reboot."}


# ── Date / Time / NTP / Timezone ───────────────────────────────────────────────

_ZONEINFO_DIR = Path("/usr/share/zoneinfo")
_SETTINGS_JSON = Path(os.getenv("DATA_DIR", "/app/data")) / "settings.json"

def _load_settings_json() -> dict:
    try:
        return json.loads(_SETTINGS_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}

def _save_settings_json(settings: dict) -> None:
    _SETTINGS_JSON.write_text(json.dumps(settings, indent=2), encoding="utf-8")

def _current_timezone() -> str:
    link = Path("/etc/localtime")
    if link.is_symlink():
        target = str(link.resolve())
        zoneinfo_prefix = str(_ZONEINFO_DIR) + "/"
        if target.startswith(zoneinfo_prefix):
            return target[len(zoneinfo_prefix):]
    settings = _load_settings_json()
    return settings.get("timezone") or "UTC"

def _restore_timezone() -> None:
    settings = _load_settings_json()
    tz_name = settings.get("timezone") or ""
    if not tz_name:
        return
    tz_path = _ZONEINFO_DIR / tz_name
    if not tz_path.is_file():
        return
    localtime = Path("/etc/localtime")
    try:
        if localtime.exists() or localtime.is_symlink():
            localtime.unlink()
        localtime.symlink_to(tz_path)
        os.environ["TZ"] = tz_name
        if hasattr(time, "tzset"):
            time.tzset()
    except Exception:
        pass

def _list_timezones() -> list:
    zones = []
    if not _ZONEINFO_DIR.exists():
        return zones
    skip = {"posix", "right", "__pycache__"}
    for root, dirs, files in os.walk(str(_ZONEINFO_DIR)):
        dirs[:] = [d for d in dirs if d not in skip]
        rel = os.path.relpath(root, str(_ZONEINFO_DIR))
        for f in files:
            full = os.path.join(rel, f) if rel != "." else f
            if "/" in full and not full.startswith("."):
                zones.append(full)
    return sorted(zones)


@app.get("/api/system/datetime")
def get_datetime():
    from datetime import datetime as dt, timezone as tz
    now = dt.now(tz.utc)
    tz_name = _current_timezone()
    try:
        import zoneinfo
        local_now = now.astimezone(zoneinfo.ZoneInfo(tz_name))
        local_str = local_now.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        local_str = now.strftime("%Y-%m-%d %H:%M:%S")
    return {
        "utc": now.isoformat(),
        "local": local_str,
        "timezone": tz_name,
    }


@app.put("/api/system/datetime")
def set_datetime(body: Dict[str, Any]):
    import subprocess as _sp
    date_str = str(body.get("datetime") or "").strip()
    if not date_str:
        raise HTTPException(status_code=400, detail="datetime is required (ISO 8601 format)")
    try:
        from datetime import datetime as dt, timezone as tz
        import zoneinfo as _zi
        parsed = dt.fromisoformat(date_str)
        if parsed.tzinfo is None:
            try:
                local_tz = _zi.ZoneInfo(_current_timezone())
            except Exception:
                local_tz = tz.utc
            parsed = parsed.replace(tzinfo=local_tz)
        formatted = parsed.astimezone(tz.utc).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid datetime format. Use ISO 8601 (e.g. 2026-04-12T15:30:00)")
    result = _sp.run(["date", "-u", "-s", formatted], capture_output=True, text=True)
    if result.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Failed to set date: {result.stderr.strip()}")
    try:
        _sp.run(["hwclock", "-w"], capture_output=True, text=True, timeout=5)
    except Exception:
        pass
    from datetime import datetime as dt2, timezone as tz2
    now = dt2.now(tz2.utc)
    tz_name = _current_timezone()
    try:
        import zoneinfo
        local_now = now.astimezone(zoneinfo.ZoneInfo(tz_name))
        local_str = local_now.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        local_str = now.strftime("%Y-%m-%d %H:%M:%S")
    return {"ok": True, "utc": now.isoformat(), "local": local_str, "timezone": tz_name}


@app.get("/api/system/timezones")
def list_timezones():
    return {"timezones": _list_timezones()}


@app.put("/api/system/timezone")
def set_timezone(body: Dict[str, Any]):
    tz_name = str(body.get("timezone") or "").strip()
    if not tz_name:
        raise HTTPException(status_code=400, detail="timezone is required")
    # Whitelist validation: must be in the known timezones list
    allowed = _list_timezones()
    if tz_name not in allowed:
        raise HTTPException(status_code=400, detail=f"Unknown timezone: {tz_name}")
    tz_path = _ZONEINFO_DIR / tz_name
    localtime = Path("/etc/localtime")
    try:
        if localtime.exists() or localtime.is_symlink():
            localtime.unlink()
        localtime.symlink_to(tz_path)
    except OSError as e:
        _log_system.error("Failed to set timezone to %s: %s", tz_name, e)
        raise HTTPException(status_code=500, detail=f"Failed to set timezone: {e}")
    os.environ["TZ"] = tz_name
    time.tzset() if hasattr(time, "tzset") else None
    settings = _load_settings_json()
    settings["timezone"] = tz_name
    _save_settings_json(settings)
    _log_system.info("Timezone changed to %s", tz_name)
    return {"ok": True, "timezone": tz_name}


@app.post("/api/system/ntp-sync")
def ntp_sync(body: Dict[str, Any] = None):
    import ntplib
    import subprocess as _sp
    from datetime import datetime as dt, timezone as tz
    body = body or {}
    server = str(body.get("server") or "pool.ntp.org").strip()
    if not server:
        server = "pool.ntp.org"
    # Validate NTP server: must be a valid hostname or IP
    if not _re.match(r'^[a-zA-Z0-9._-]{1,253}$', server):
        raise HTTPException(status_code=400, detail="Invalid NTP server hostname")
    try:
        client = ntplib.NTPClient()
        response = client.request(server, version=3, timeout=5)
        ntp_time = dt.fromtimestamp(response.tx_time, tz=tz.utc)
    except Exception as e:
        _log_system.error("NTP sync failed from %s: %s", server, e)
        raise HTTPException(status_code=502, detail=f"NTP sync failed: {e}")
    formatted = ntp_time.strftime("%Y-%m-%d %H:%M:%S")
    result = _sp.run(["date", "-u", "-s", formatted], capture_output=True, text=True)
    if result.returncode != 0:
        _log_system.error("Failed to set date after NTP sync: %s", result.stderr.strip())
        raise HTTPException(status_code=500, detail=f"Failed to set date: {result.stderr.strip()}")
    _log_system.info("NTP sync from %s: set time to %s", server, formatted)
    try:
        _sp.run(["hwclock", "-w"], capture_output=True, text=True, timeout=5)
    except Exception:
        pass
    settings = _load_settings_json()
    settings["ntp_server"] = server
    _save_settings_json(settings)
    now = dt.now(tz.utc)
    tz_name = _current_timezone()
    try:
        import zoneinfo
        local_now = now.astimezone(zoneinfo.ZoneInfo(tz_name))
        local_str = local_now.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        local_str = now.strftime("%Y-%m-%d %H:%M:%S")
    return {"ok": True, "utc": now.isoformat(), "local": local_str, "timezone": tz_name, "server": server}


@app.get("/api/system/ntp")
def get_ntp_settings():
    settings = _load_settings_json()
    return {"ntp_server": settings.get("ntp_server") or "pool.ntp.org"}


@app.get("/api/system/logs")
def get_system_logs(limit: int = 500, level: str = "", cat: str = ""):
    """Return the most recent system log entries from the ring buffer."""
    limit = max(1, min(limit, _LOG_BUFFER_SIZE))
    entries = list(_log_buffer)

    level_filter = {l.strip().upper() for l in level.split(",") if l.strip()} if level else set()
    cat_filter = {c.strip().lower() for c in cat.split(",") if c.strip()} if cat else set()

    if level_filter or cat_filter:
        filtered = []
        for e in entries:
            if level_filter and e.get("level", "") not in level_filter:
                continue
            if cat_filter and e.get("cat", "") not in cat_filter:
                continue
            filtered.append(e)
        entries = filtered

    if len(entries) > limit:
        entries = entries[-limit:]

    tz_name = _current_timezone()
    local_tz = None
    try:
        import zoneinfo
        local_tz = zoneinfo.ZoneInfo(tz_name)
    except Exception:
        pass

    if local_tz:
        for e in entries:
            try:
                utc_dt = datetime.fromisoformat(e["ts"])
                local_dt = utc_dt.astimezone(local_tz)
                e["ts"] = local_dt.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass

    categories = sorted({e.get("cat", "") for e in list(_log_buffer) if e.get("cat")})
    return {"entries": entries, "categories": categories}


@app.post("/api/system/logs/clear")
def clear_system_logs():
    """Clear all buffered log entries."""
    _log_buffer.clear()
    return {"ok": True}


# ── Storage (NVMe) ─────────────────────────────────────────────────────────────

def _host_cmd(args: list[str], *, timeout: int = 30, input_data: str | None = None) -> subprocess.CompletedProcess:
    """Run a command on the host via nsenter."""
    return subprocess.run(
        ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--"] + args,
        capture_output=True, text=True, timeout=timeout,
        input=input_data,
    )

def _parse_lsblk_json() -> list[dict]:
    proc = _host_cmd(["lsblk", "-J", "-b", "-o", "NAME,SIZE,FSTYPE,FSUSED,FSAVAIL,MOUNTPOINT,TYPE,MODEL,SERIAL"])
    if proc.returncode != 0:
        return []
    try:
        return json.loads(proc.stdout).get("blockdevices", [])
    except Exception:
        return []

def _find_nvme_devices() -> list[dict]:
    """Return list of NVMe block devices from lsblk."""
    devices = _parse_lsblk_json()
    nvme = []
    for dev in devices:
        if dev.get("type") == "disk" and (dev.get("name") or "").startswith("nvme"):
            parts = []
            for child in dev.get("children", []):
                parts.append({
                    "name": child.get("name"),
                    "size": int(child.get("size") or 0),
                    "fstype": child.get("fstype"),
                    "mountpoint": child.get("mountpoint"),
                    "fsused": int(child.get("fsused") or 0) if child.get("fsused") is not None else None,
                    "fsavail": int(child.get("fsavail") or 0) if child.get("fsavail") is not None else None,
                })
            nvme.append({
                "name": dev.get("name"),
                "size": int(dev.get("size") or 0),
                "model": (dev.get("model") or "").strip(),
                "serial": (dev.get("serial") or "").strip(),
                "partitions": parts,
            })
    return nvme


@app.get("/api/storage/devices")
def storage_devices():
    """List NVMe storage devices and their partitions."""
    return {"devices": _find_nvme_devices()}


@app.post("/api/storage/format")
def storage_format(request: Request, body: dict = None):
    """Wipe an NVMe device, create a single ext4 partition, and mount it."""
    if body is None:
        body = {}
    device = str(body.get("device") or "")
    mount_path = str(body.get("mount_path") or "/mnt/nvme")

    # Validate device name strictly
    if not _re.fullmatch(r"nvme\d+n\d+", device):
        raise HTTPException(status_code=400, detail="Invalid device name")

    dev_path = f"/dev/{device}"

    # Verify the device actually exists
    check = _host_cmd(["test", "-b", dev_path])
    if check.returncode != 0:
        raise HTTPException(status_code=404, detail=f"Device {dev_path} not found")

    # Validate mount_path
    if not _re.fullmatch(r"/[a-zA-Z0-9_/\-]+", mount_path):
        raise HTTPException(status_code=400, detail="Invalid mount path")

    _log_system.warning("Formatting %s and mounting to %s", dev_path, mount_path)

    # Unmount any existing partitions
    devs = _find_nvme_devices()
    for d in devs:
        if d["name"] == device:
            for p in d["partitions"]:
                if p["mountpoint"]:
                    _host_cmd(["umount", f"/dev/{p['name']}"])

    # Create partition table + single partition
    fdisk_input = "o\nn\np\n1\n\n\nw\n"
    proc = _host_cmd(["fdisk", dev_path], input_data=fdisk_input, timeout=30)
    if proc.returncode not in (0, 1):  # fdisk may return 1 with re-read warning
        _log_system.error("fdisk failed: %s", proc.stderr)
        raise HTTPException(status_code=500, detail=f"Partitioning failed: {proc.stderr.strip()}")

    # Wait for kernel to re-read partition table
    _host_cmd(["partprobe", dev_path], timeout=10)
    import time as _time
    _time.sleep(2)

    part_path = f"{dev_path}p1"

    # Format as ext4
    proc = _host_cmd(["mkfs.ext4", "-F", part_path], timeout=120)
    if proc.returncode != 0:
        _log_system.error("mkfs.ext4 failed: %s", proc.stderr)
        raise HTTPException(status_code=500, detail=f"Formatting failed: {proc.stderr.strip()}")

    # Create mount point and mount
    _host_cmd(["mkdir", "-p", mount_path])
    proc = _host_cmd(["mount", part_path, mount_path])
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Mount failed: {proc.stderr.strip()}")

    # Add to fstab if not already present
    fstab_check = _host_cmd(["grep", "-q", part_path, "/etc/fstab"])
    if fstab_check.returncode != 0:
        fstab_line = f"\n{part_path}  {mount_path}  ext4  defaults,nofail  0  2\n"
        _host_cmd(["sh", "-c", f"echo '{fstab_line}' >> /etc/fstab"])

    _log_system.info("NVMe %s formatted and mounted at %s", device, mount_path)
    return {"ok": True, "device": device, "partition": f"{device}p1", "mount_path": mount_path}


@app.post("/api/storage/mount")
def storage_mount(body: dict = None):
    """Mount an existing NVMe partition."""
    if body is None:
        body = {}
    partition = str(body.get("partition") or "")
    mount_path = str(body.get("mount_path") or "/mnt/nvme")

    if not _re.fullmatch(r"nvme\d+n\d+p\d+", partition):
        raise HTTPException(status_code=400, detail="Invalid partition name")
    if not _re.fullmatch(r"/[a-zA-Z0-9_/\-]+", mount_path):
        raise HTTPException(status_code=400, detail="Invalid mount path")

    part_path = f"/dev/{partition}"
    _host_cmd(["mkdir", "-p", mount_path])
    proc = _host_cmd(["mount", part_path, mount_path])
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Mount failed: {proc.stderr.strip()}")

    return {"ok": True, "partition": partition, "mount_path": mount_path}


@app.post("/api/storage/unmount")
def storage_unmount(body: dict = None):
    """Unmount an NVMe partition."""
    if body is None:
        body = {}
    mount_path = str(body.get("mount_path") or "")
    if not mount_path or not _re.fullmatch(r"/[a-zA-Z0-9_/\-]+", mount_path):
        raise HTTPException(status_code=400, detail="Invalid mount path")

    proc = _host_cmd(["umount", mount_path])
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=f"Unmount failed: {proc.stderr.strip()}")

    return {"ok": True, "mount_path": mount_path}


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
    recording_profile_token: Optional[str] = None
    recording_profile_label: Optional[str] = None
    preload_stream: bool = True
    snapshot_uri: Optional[str] = None


class Device(DeviceIn):
    id: str


# ── AXIS Speaker models ───────────────────────────────────────────────────────

class SpeakerIn(BaseModel):
    name: str = Field(..., min_length=1)
    ip: str = Field(..., min_length=1)
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class Speaker(SpeakerIn):
    id: str


SPEAKERS_JSON = DATA_DIR / "speakers.json"
AUDIO_CLIPS_DIR = DATA_DIR / "audio_clips"
AUDIO_CLIPS_DIR.mkdir(parents=True, exist_ok=True)

_log_speakers = logging.getLogger("speakers")


def _load_speakers() -> List[Speaker]:
    try:
        raw = json.loads(SPEAKERS_JSON.read_text(encoding="utf-8"))
        items = raw.get("speakers", [])
        if not isinstance(items, list):
            return []
        return [Speaker(**d) for d in items]
    except Exception:
        return []


def _save_speakers(speakers: List[Speaker]) -> None:
    payload = {"speakers": [_dump(s) for s in speakers]}
    tmp = SPEAKERS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(SPEAKERS_JSON)


def _get_speaker(speaker_id: str) -> Speaker:
    for s in _load_speakers():
        if s.id == speaker_id:
            return s
    raise HTTPException(status_code=404, detail="Speaker not found")


def _axis_auth_opener(base_url: str, username: str, password: str):
    """Build a urllib opener with digest + basic auth for AXIS devices."""
    password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    password_mgr.add_password(None, base_url, username, password)
    digest_handler = urllib.request.HTTPDigestAuthHandler(password_mgr)
    basic_handler = urllib.request.HTTPBasicAuthHandler(password_mgr)
    return urllib.request.build_opener(digest_handler, basic_handler)


def _convert_audio_to_axis_format(audio_bytes: bytes, src_ext: str = ".mp3") -> bytes:
    """Convert audio to 16-bit 8 kHz mono mu-law WAV using ffmpeg.

    AXIS speakers accept G.711 mu-law via the transmit API.
    """
    with tempfile.NamedTemporaryFile(suffix=src_ext, delete=False) as src:
        src.write(audio_bytes)
        src_path = src.name
    out_path = src_path + ".ul"
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-y", "-i", src_path,
                "-ar", "16000",       # 16 kHz for axis-mulaw-128 (128 kbps)
                "-ac", "1",           # mono
                "-f", "mulaw",        # raw G.711 mu-law
                out_path,
            ],
            capture_output=True, timeout=30,
        )
        if proc.returncode != 0:
            _log_speakers.warning("ffmpeg conversion failed: %s", proc.stderr.decode(errors="replace")[:500])
            return b""
        return Path(out_path).read_bytes()
    except Exception as exc:
        _log_speakers.warning("ffmpeg conversion error: %s", exc)
        return b""
    finally:
        try:
            os.unlink(src_path)
        except OSError:
            pass
        try:
            os.unlink(out_path)
        except OSError:
            pass


def play_audio_on_speaker(speaker_ip: str, username: str, password: str,
                          audio_bytes: bytes, clip_name: str = "smarteye_clip") -> dict:
    """Play an audio clip on an AXIS speaker via the transmit API.

    Converts the source audio to G.711 mu-law (8 kHz mono) with ffmpeg,
    then streams it to /axis-cgi/audio/transmit.cgi.
    """
    ext = Path(clip_name).suffix.lower() if "." in clip_name else ".mp3"
    if not ext:
        ext = ".mp3"

    mulaw_bytes = _convert_audio_to_axis_format(audio_bytes, ext)
    if not mulaw_bytes:
        return {"ok": False, "error": "Failed to convert audio to speaker format"}

    url = f"http://{speaker_ip}/axis-cgi/audio/transmit.cgi"
    opener = _axis_auth_opener(url, username, password)

    req = urllib.request.Request(
        url,
        data=mulaw_bytes,
        method="POST",
        headers={
            "Content-Type": "audio/axis-mulaw-128",
            "Content-Length": str(len(mulaw_bytes)),
        },
    )
    try:
        with opener.open(req, timeout=120) as resp:
            body = resp.read(2048).decode("utf-8", errors="replace")
            _log_speakers.info(
                "Audio played on %s (%d bytes mu-law from %d bytes source)",
                speaker_ip, len(mulaw_bytes), len(audio_bytes),
            )
            return {"ok": True, "status": int(getattr(resp, "status", 200)), "response": body}
    except urllib.error.HTTPError as exc:
        err_body = ""
        try:
            err_body = exc.read(2048).decode("utf-8", errors="replace")
        except Exception:
            pass
        _log_speakers.warning(
            "Transmit API failed on %s: HTTP %d — %s", speaker_ip, exc.code, err_body[:200],
        )
        return {"ok": False, "status": int(exc.code), "error": f"HTTP {exc.code}: {err_body[:200]}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


class EventsStartRequest(OnvifBase):
    device_id: str


class PTZMoveRequest(BaseModel):
    pan: float = 0.0
    tilt: float = 0.0
    zoom: float = 0.0


class CloudConnectorConfigIn(BaseModel):
    cloud_ws_url: str = Field(..., min_length=1)
    cloud_token: str = Field(..., min_length=1)
    hub_device_id: str = Field(..., min_length=1)
    

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


def _humanize_topic_segment(segment: str) -> str:
    raw = str(segment or "").strip().replace("_", " ").replace("-", " ")
    if not raw:
        return ""

    out: List[str] = []
    prev_is_lower = False
    prev_is_alpha = False

    for ch in raw:
        if ch == " ":
            if out and out[-1] != " ":
                out.append(" ")
            prev_is_lower = False
            prev_is_alpha = False
            continue

        is_upper = ch.isupper()
        is_lower = ch.islower()
        is_digit = ch.isdigit()

        if out:
            prev = out[-1]
            prev_is_digit = prev.isdigit()
            if is_upper and prev_is_lower:
                out.append(" ")
            elif is_digit and prev_is_alpha:
                out.append(" ")
            elif is_lower and prev_is_digit:
                out.append(" ")

        out.append(ch)
        prev_is_lower = is_lower
        prev_is_alpha = is_upper or is_lower

    return " ".join("".join(out).split())


_TOPIC_SCHEMA_STOP_NODES = {
    "MessageDescription",
    "Source",
    "Data",
    "Key",
    "SimpleItemDescription",
    "ElementItemDescription",
    "MessageContentFilter",
}


def _normalize_http_method(value: Optional[str], allow_any: bool = False) -> str:
    method = str(value or "").strip().upper()
    if not method:
        return "ANY" if allow_any else ""

    if allow_any and method == "ANY":
        return "ANY"

    if method not in _VALID_HTTP_METHODS:
        return ""

    return method


def _normalize_http_path(value: Optional[str]) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""

    raw = raw.split("?", 1)[0].strip()

    if not raw.startswith("/"):
        raw = "/" + raw

    parts = [p for p in raw.split("/") if p]
    return "/" + "/".join(parts) if parts else "/"


def _normalize_http_headers(value: Any) -> Dict[str, str]:
    if value is None:
        return {}

    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="HTTP headers must be an object")

    out: Dict[str, str] = {}
    for k, v in value.items():
        key = str(k or "").strip()
        if not key:
            continue
        out[key] = str(v if v is not None else "")
    return out


def _normalize_device_dict(d: dict) -> dict:
    out = dict(d)
    if "preload_stream" not in out:
        out["preload_stream"] = True
    out.pop("allow_topics", None)
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
            _log_devices.info("Device updated: %s (%s)", devs[i].name, device_id)
            _invalidate_ptz_cache(device_id)
            req = EventsStartRequest(
                device_id=device_id,
                ip=dev_in.ip,
                onvif_port=dev_in.onvif_port,
                username=dev_in.username,
                password=dev_in.password,
            )
            _start_event_worker(device_id, req)

            if devs[i].profile_token:
                try:
                    _refresh_device_stream(device_id)
                except Exception:
                    pass

            return devs[i]
    raise HTTPException(status_code=404, detail="Device not found")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _default_cloud_connector_config() -> Dict[str, str]:
    return {
        "cloud_ws_url": str(os.getenv("CLOUD_WS_URL", "ws://localhost:5000/pi/connect")).strip(),
        "cloud_token": str(os.getenv("CLOUD_TOKEN", "")).strip(),
        "hub_device_id": str(os.getenv("HUB_DEVICE_ID", "smarteye-pi")).strip(),
    }


def _normalize_cloud_connector_config(payload: Dict[str, Any]) -> Dict[str, str]:
    cfg = {
        "cloud_ws_url": str(payload.get("cloud_ws_url") or "").strip(),
        "cloud_token": str(payload.get("cloud_token") or "").strip(),
        "hub_device_id": str(payload.get("hub_device_id") or "").strip(),
    }

    if not cfg["cloud_ws_url"]:
        raise HTTPException(status_code=400, detail="cloud_ws_url is required")
    if not cfg["cloud_ws_url"].startswith(("ws://", "wss://")):
        raise HTTPException(status_code=400, detail="cloud_ws_url must start with ws:// or wss://")
    if not cfg["cloud_token"]:
        raise HTTPException(status_code=400, detail="cloud_token is required")
    if not cfg["hub_device_id"]:
        raise HTTPException(status_code=400, detail="hub_device_id is required")

    return cfg


def _load_cloud_connector_config() -> Dict[str, str]:
    defaults = _default_cloud_connector_config()

    if not CLOUD_CONNECTOR_JSON.exists():
        return defaults

    try:
        raw = json.loads(CLOUD_CONNECTOR_JSON.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return defaults
        merged = {**defaults, **{k: str(v) for k, v in raw.items() if isinstance(k, str)}}
        return _normalize_cloud_connector_config(merged)
    except HTTPException:
        return defaults
    except Exception:
        return defaults


def _save_cloud_connector_config(cfg: Dict[str, str]) -> None:
    tmp = CLOUD_CONNECTOR_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    tmp.replace(CLOUD_CONNECTOR_JSON)


def _cloud_connector_module():
    try:
        return importlib.import_module("cloud_connector")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cloud connector module unavailable: {e}")


def _apply_cloud_connector_config(cfg: Dict[str, str]) -> bool:
    module = _cloud_connector_module()
    module.configure_connector(
        cloud_ws_url=cfg["cloud_ws_url"],
        cloud_token=cfg["cloud_token"],
        hub_device_id=cfg["hub_device_id"],
    )
    return bool(module.is_connector_running())


def _canonical_topic_aliases(topic: Optional[str]) -> set[str]:
    t = _normalize_allow_topic(topic)
    if not t:
        return set()

    aliases = {t}
    low = t.lower()

    if (
        "motion" in low
        or "ismotion" in low
        or "motionalarm" in low
        or "cellmotiondetector" in low
        or "motiondetector" in low
        or t == "VideoSource/MotionAlarm"
    ):
        aliases.update({
            "VideoSource/MotionAlarm",
            "RuleEngine/CellMotionDetector/Motion",
            "VideoSource/MotionDetector/Motion",
            "IsMotion/Rule/VideoAnalyticsConfigurationToken/VideoSourceConfigurationToken",
        })

    if (
        "objectsinside" in low
        or "objectinside" in low
        or "fielddetector" in low
        or "isinside" in low
    ):
        aliases.update({
            "RuleEngine/FieldDetector/ObjectsInside",
            "RuleEngine/FieldDetector/ObjectInside",
            "VideoSource/ObjectInside",
            "IsInside/Rule/VideoAnalyticsConfigurationToken/VideoSourceConfigurationToken",
        })

    if "digitalinput" in low or "inputtoken" in low:
        aliases.update({
            "Device/Trigger/DigitalInput",
        })

    if "relay" in low or "relaytoken" in low:
        aliases.update({
            "Device/Trigger/Relay",
        })

    if "tamper" in low:
        aliases.update({
            "VideoSource/ImageTooDark/Tamper",
            "VideoSource/TamperDetector/Tamper",
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


def _matching_allow_topic(candidate: str, allow_set: set[str]) -> Optional[str]:
    for allow_topic in sorted(allow_set):
        if _topic_matches_allowlist(candidate, {allow_topic}):
            return allow_topic
    return None


def _known_event_topic_groups() -> List[dict]:
    return [
        {
            "path": "VideoSource/MotionAlarm",
            "label": "Motion detected",
            "category": "Analytics",
            "keywords": ["motion", "movement", "motion alarm", "cell motion"],
            "aliases": sorted(_canonical_topic_aliases("VideoSource/MotionAlarm")),
            "recommended": True,
        },
        {
            "path": "RuleEngine/FieldDetector/ObjectsInside",
            "label": "Objects inside area",
            "category": "Analytics",
            "keywords": ["object inside", "objects inside", "field detector", "intrusion"],
            "aliases": sorted(_canonical_topic_aliases("RuleEngine/FieldDetector/ObjectsInside")),
            "recommended": True,
        },
        {
            "path": "Device/Trigger/DigitalInput",
            "label": "Digital input changed",
            "category": "Inputs",
            "keywords": ["digital input", "input trigger", "input state"],
            "aliases": sorted(_canonical_topic_aliases("Device/Trigger/DigitalInput")),
            "recommended": True,
        },
        {
            "path": "Device/Trigger/Relay",
            "label": "Relay changed",
            "category": "Outputs",
            "keywords": ["relay", "relay output", "output state"],
            "aliases": sorted(_canonical_topic_aliases("Device/Trigger/Relay")),
            "recommended": True,
        },
        {
            "path": "VideoSource/ImageTooDark/Tamper",
            "label": "Tamper detected",
            "category": "Video",
            "keywords": ["tamper", "scene blocked", "image too dark"],
            "aliases": ["VideoSource/ImageTooDark/Tamper"],
            "recommended": True,
        },
    ]


def _topic_category_from_path(path: str) -> str:
    normalized = _normalize_allow_topic(path)
    if not normalized:
        return "Other"

    parts = [part for part in normalized.split("/") if part]
    head = parts[0] if parts else ""

    if head == "RuleEngine":
        return "Analytics"
    if normalized.startswith("Device/Trigger/DigitalInput"):
        return "Inputs"
    if normalized.startswith("Device/Trigger/Relay"):
        return "Outputs"
    if head == "VideoSource":
        return "Video"
    if head == "Device":
        return "Device"
    return "Other"


def _topic_label_from_path(path: str) -> str:
    parts = [part for part in _normalize_allow_topic(path).split("/") if part]
    if not parts:
        return ""

    leaf = _humanize_topic_segment(parts[-1]) or parts[-1]
    if len(parts) == 1:
        return leaf

    parent = _humanize_topic_segment(parts[-2]) or parts[-2]
    if parent and parent.lower() not in leaf.lower():
        return f"{leaf} ({parent})"
    return leaf


def _event_topic_profile(path: str) -> Optional[dict]:
    normalized = _normalize_allow_topic(path)
    if not normalized:
        return None

    for group in _known_event_topic_groups():
        if _topic_matches_allowlist(normalized, {group["path"]}):
            return group
    return None


def _format_event_topics(raw_paths: List[str]) -> List[dict]:
    groups: Dict[str, dict] = {}
    category_order = {
        "Analytics": 0,
        "Inputs": 1,
        "Outputs": 2,
        "Video": 3,
        "Device": 4,
        "Other": 5,
    }

    for raw_path in raw_paths:
        normalized = _normalize_allow_topic(raw_path)
        if not normalized:
            continue

        profile = _event_topic_profile(normalized)
        canonical_path = profile["path"] if profile else normalized

        entry = groups.setdefault(
            canonical_path,
            {
                "path": canonical_path,
                "label": (profile or {}).get("label") or _topic_label_from_path(canonical_path) or canonical_path,
                "category": (profile or {}).get("category") or _topic_category_from_path(canonical_path),
                "recommended": bool((profile or {}).get("recommended")),
                "aliases": set((profile or {}).get("aliases") or []),
                "source_paths": set(),
                "keywords": set((profile or {}).get("keywords") or []),
            },
        )

        entry["source_paths"].add(normalized)
        entry["aliases"].add(normalized)

    out: List[dict] = []
    for entry in groups.values():
        path = entry["path"]
        aliases = sorted({_normalize_allow_topic(x) for x in entry["aliases"] if _normalize_allow_topic(x)})
        source_paths = sorted({_normalize_allow_topic(x) for x in entry["source_paths"] if _normalize_allow_topic(x)})
        search_terms = [
            entry["label"],
            path,
            entry["category"],
            *sorted(entry["keywords"]),
            *aliases,
            *source_paths,
        ]
        search_text = " ".join(str(term).strip().lower() for term in search_terms if str(term).strip())
        out.append(
            {
                "path": path,
                "name": entry["label"],
                "label": entry["label"],
                "category": entry["category"],
                "recommended": bool(entry["recommended"]),
                "aliases": aliases,
                "source_paths": source_paths,
                "search_text": search_text,
            }
        )

    out.sort(
        key=lambda item: (
            0 if item.get("recommended") else 1,
            category_order.get(str(item.get("category") or "Other"), 99),
            str(item.get("label") or item.get("path") or "").lower(),
            str(item.get("path") or "").lower(),
        )
    )
    return out


def _get_effective_event_allowlist(device_id: str) -> set[str]:
    return {t for t in get_flow_topics_for_device(device_id) if t}



def _poll_device_state_changes() -> None:
    while not _flow_monitor_stop.wait(PATH_PROGRESS_POLL_SEC):
        try:
            devs = _load_devices()
            _ensure_event_workers(devs)
            snapshot = _mediamtx_paths_snapshot()

            for d in devs:
                row = _path_row_for_device(snapshot, d.id)
                monitor = _update_path_monitor_state(d.id, row)

                prev = monitor["previous_online"]
                curr = monitor["current_online"]

                if prev is None:
                    if EVENT_DEBUG:
                        _emit_event(
                            d.id,
                            "debug",
                            "Initialized device state tracker",
                            {
                                "current_online": curr,
                                "no_progress_count": monitor["no_progress_count"],
                                "seconds_since_progress": monitor["seconds_since_progress"],
                                "bytes_received": monitor["bytes_received"],
                                "readers": monitor["readers"],
                            },
                        )
                    continue

                if prev == curr:
                    continue

                st = _device_stream_status_from_snapshot(d, snapshot)

                if prev and not curr:
                    if EVENT_DEBUG:
                        _emit_event(
                            d.id,
                            "debug",
                            "Detected device offline transition",
                            {
                                "previous_online": prev,
                                "current_online": curr,
                                "status": st,
                            },
                        )

                    trigger = {
                        "kind": "device_offline",
                        "device_id": d.id,
                        "message": "Device offline",
                        "status": st,
                    }
                    _log_devices.info("Device offline: %s", d.id)
                    dispatch_flow_trigger(trigger)

                elif (not prev) and curr:
                    if EVENT_DEBUG:
                        _emit_event(
                            d.id,
                            "debug",
                            "Detected device back online transition",
                            {
                                "previous_online": prev,
                                "current_online": curr,
                                "status": st,
                            },
                        )

                    trigger = {
                        "kind": "device_back_online",
                        "device_id": d.id,
                        "message": "Device back online",
                        "status": st,
                    }
                    _log_devices.info("Device back online: %s", d.id)
                    dispatch_flow_trigger(trigger)

        except Exception as e:
            if EVENT_DEBUG:
                try:
                    _broadcast_event("system", {
                        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                        "device_id": "system",
                        "level": "warn",
                        "message": f"Flow monitor poll failed: {e}",
                        "extra": {},
                    })
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


def _collect_topic_leaf_paths(topic_set_obj) -> List[str]:
    results: List[str] = []
    seen: set[str] = set()

    def add_path(path: str) -> None:
        normalized = _normalize_allow_topic(path)
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        results.append(normalized)

    def walk_elem(elem, prefix: str = "") -> None:
        if elem is None:
            return

        tag = getattr(elem, "tag", None)
        name = _strip_ns(tag) if tag else None

        if name in _TOPIC_SCHEMA_STOP_NODES:
            add_path(prefix)
            return

        current = f"{prefix}/{name}" if prefix and name else (name or prefix)

        try:
            children = [child for child in list(elem) if hasattr(child, "tag")]
        except Exception:
            children = []

        if current and not children:
            add_path(current)
            return

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

    if "ismotion" in keys and (has_vs_token or has_va_token or has_rule):
        return "RuleEngine/CellMotionDetector/Motion"

    if "isinside" in keys and (has_vs_token or has_va_token or has_rule):
        return "RuleEngine/FieldDetector/ObjectsInside"

    if "inputtoken" in keys:
        return "Device/Trigger/DigitalInput"

    if "relaytoken" in keys:
        return "Device/Trigger/Relay"

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
    raw_topics = _collect_topic_leaf_paths(getattr(props, "TopicSet", None))
    topics = _format_event_topics(raw_topics)
    return {
        "topics": topics,
        "fixed_topic_set": bool(raw_topics),
        "raw_topic_set": _serialize_zeep_obj(getattr(props, "TopicSet", None)),
        "raw": _serialize_zeep_obj(props),
    }


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
        def event_topic(extra_payload: dict) -> str:
            return (
                extra_payload.get("matched_allow_topic")
                or extra_payload.get("matched_by")
                or extra_payload.get("topic_path")
                or extra_payload.get("guessed_topic")
                or ""
            )

        def parse_onvif_bool(value: Any) -> Optional[bool]:
            if isinstance(value, bool):
                return value
            text = str(value or "").strip().lower()
            if text in {"1", "true", "yes", "on"}:
                return True
            if text in {"0", "false", "no", "off"}:
                return False
            return None

        def onvif_state_changes(extra_payload: dict) -> List[dict]:
            changed = extra_payload.get("changed") or {}
            if not isinstance(changed, dict) or not changed:
                return []

            out: List[dict] = []
            for key, raw_value in changed.items():
                state_value = parse_onvif_bool(raw_value)
                if state_value is None:
                    continue
                out.append(
                    {
                        "key": str(key),
                        "state_value": state_value,
                        "transition": "became_active" if state_value else "became_inactive",
                    }
                )
            return out

        extra_payload = dict(extra or {})
        state_changes = onvif_state_changes(extra_payload)
        if state_changes:
            extra_payload["state_changes"] = state_changes
        primary_state = state_changes[0] if state_changes else {}

        trigger = {
            "kind": "onvif_event",
            "device_id": device_id,
            "message": msg,
            "extra": extra_payload,
            "ts": payload["ts"],
            "topic": event_topic(extra_payload),
            "state_key": primary_state.get("key"),
            "state_value": primary_state.get("state_value"),
            "state_transition": primary_state.get("transition"),
            "state_changes": state_changes,
        }
        dispatch_flow_trigger(trigger)
        
ALLOW_REFRESH_S = 2.0


def _onvif_event_worker(device_id: str, req: OnvifBase, stop_flag: threading.Event, fingerprint: str) -> None:
    allow_set = _get_effective_event_allowlist(device_id)
    last_allow_refresh = 0.0
    max_messages = 20

    try:
        def connect_pullpoint(*, reconnect: bool = False):
            cam = _cam(req)
            events = cam.create_events_service()

            last_error: Optional[Exception] = None
            for payload in ({}, {"InitialTerminationTime": "PT5M"}):
                try:
                    events.CreatePullPointSubscription(payload)
                    pullpoint = cam.create_pullpoint_service()
                    _log_onvif.info("Subscribed to ONVIF events for device %s", device_id)
                    _emit_event(
                        device_id,
                        "ok",
                        "Re-subscribed to ONVIF events after pull-point reset."
                        if reconnect
                        else "Subscribed to ONVIF events (flow-aware filtering enabled).",
                    )
                    return pullpoint
                except Exception as exc:
                    last_error = exc

            raise last_error or RuntimeError("CreatePullPointSubscription failed")

        connected_once = False
        retry_delay = 1.0

        while not stop_flag.is_set():
            try:
                pullpoint = connect_pullpoint(reconnect=connected_once)
                connected_once = True
                retry_delay = 1.0

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
                            matched_allow_topic = None

                            if not allow_set:
                                matched = False
                            else:
                                for candidate in match_candidates:
                                    allow_topic = _matching_allow_topic(candidate, allow_set)
                                    if allow_topic:
                                        matched = True
                                        matched_by = candidate
                                        matched_allow_topic = allow_topic
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
                                        "matched_allow_topic": matched_allow_topic,
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
                                        "Dropped event because it did not match flow topics",
                                        {
                                            "topic_text": topic_text,
                                            "topic_path": topic_path,
                                            "guessed_topic": guessed_topic,
                                            "fallback_key": fallback_key,
                                            "match_candidates": match_candidates,
                                            "allow_topics": sorted(list(allow_set)),
                                            "expanded_allow_topics": sorted(list(_expanded_allow_topics(allow_set))),
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
                                    "matched_allow_topic": matched_allow_topic,
                                    "changed": changed,
                                    "items": items,
                                },
                            )

                    except Exception as e:
                        error_text = str(e)
                        normalized_error = error_text.strip().lower()
                        should_resubscribe = (
                            "resource unknown" in normalized_error
                            or "unknown resource" in normalized_error
                            or "subscription" in normalized_error and "unknown" in normalized_error
                        )

                        if should_resubscribe:
                            _log_onvif.warning("PullMessages lost subscription for %s: %s", device_id, e)
                            _emit_event(device_id, "warn", f"PullMessages lost pull-point subscription: {e}")
                            break

                        _log_onvif.warning("PullMessages error for %s: %s", device_id, e)
                        _emit_event(device_id, "warn", f"PullMessages error: {e}")
                        time.sleep(0.5)

            except Exception as e:
                _log_onvif.error("Event subscription failed for %s: %s", device_id, e)
                _emit_event(device_id, "bad", f"Event subscription failed: {e}")

            if stop_flag.wait(retry_delay):
                break
            retry_delay = min(retry_delay * 1.5, 10.0)

    except Exception as e:
        _log_onvif.error("Event subscription failed for %s: %s", device_id, e)
        _emit_event(device_id, "bad", f"Event subscription failed: {e}")
    finally:
        with _event_worker_lock:
            cur = _event_workers.get(device_id)
            if cur and cur.fingerprint == fingerprint:
                _event_workers.pop(device_id, None)
        _log_onvif.info("ONVIF event worker stopped for %s", device_id)
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
        _log_onvif.info("ONVIF event worker started for %s", device_id)

    if old_worker:
        _log_onvif.info("Restarted event worker for %s (settings changed)", device_id)
        _emit_event(device_id, "warn", "Restarted event worker due to device settings change.")


def _ensure_event_workers(devs: Optional[List[Device]] = None) -> None:
    devices = devs if devs is not None else _load_devices()

    for device in devices:
        if not str(device.ip or "").strip():
            continue
        if not str(device.username or "").strip():
            continue
        if not str(device.password or "").strip():
            continue

        req = EventsStartRequest(
            device_id=device.id,
            ip=device.ip,
            onvif_port=device.onvif_port,
            username=device.username,
            password=device.password,
        )
        _start_event_worker(device.id, req)


def _stop_event_worker(device_id: str) -> None:
    with _event_worker_lock:
        cur = _event_workers.pop(device_id, None)
    if cur:
        cur.stop_flag.set()


def _path_for(device_id: str) -> str:
    return f"cam-{device_id}"


def _rec_path_for(device_id: str) -> str:
    return f"cam-rec-{device_id}"


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

    snapshot = _mediamtx_paths_snapshot()
    items = list(snapshot.get("items") or [])
    existing = next((x for x in items if x.get("name") == name), None)

    if existing:
        current_source = existing.get("source")
        current_on_demand = existing.get("sourceOnDemand")
        desired_on_demand = not preload

        if current_source == source_rtsp and current_on_demand == desired_on_demand:
            return {"ok": True, "exists": True, "name": name}

        try:
            return _mediamtx_api_request("PATCH", f"/v3/config/paths/edit/{name}", payload)
        except Exception:
            try:
                _mediamtx_delete_path(device_id)
            except Exception:
                pass
            return _mediamtx_api_request("POST", f"/v3/config/paths/add/{name}", payload)

    return _mediamtx_api_request("POST", f"/v3/config/paths/add/{name}", payload)


def _mediamtx_delete_path(device_id: str) -> dict:
    name = _path_for(device_id)
    try:
        return _mediamtx_api_request("DELETE", f"/v3/config/paths/delete/{name}")
    except Exception as e:
        msg = str(e)
        if "404" in msg or "not found" in msg.lower():
            return {"ok": True, "missing": True}
        raise


def _ensure_mediamtx_rec_path(device_id: str, source_rtsp: str, preload: bool = False) -> dict:
    name = _rec_path_for(device_id)

    payload = {
        "source": source_rtsp,
        "sourceOnDemand": not preload,
        "sourceOnDemandStartTimeout": "10s",
        "sourceOnDemandCloseAfter": "10s",
    }

    snapshot = _mediamtx_paths_snapshot()
    items = list(snapshot.get("items") or [])
    existing = next((x for x in items if x.get("name") == name), None)

    if existing:
        current_source = existing.get("source")
        current_on_demand = existing.get("sourceOnDemand")
        desired_on_demand = not preload

        if current_source == source_rtsp and current_on_demand == desired_on_demand:
            return {"ok": True, "exists": True, "name": name}

        try:
            return _mediamtx_api_request("PATCH", f"/v3/config/paths/edit/{name}", payload)
        except Exception:
            try:
                _mediamtx_delete_rec_path(device_id)
            except Exception:
                pass
            return _mediamtx_api_request("POST", f"/v3/config/paths/add/{name}", payload)

    return _mediamtx_api_request("POST", f"/v3/config/paths/add/{name}", payload)


def _mediamtx_delete_rec_path(device_id: str) -> dict:
    name = _rec_path_for(device_id)
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


def _refresh_device_stream(device_id: str) -> dict:
    d = _get_device(device_id)

    if not d.profile_token:
        try:
            _mediamtx_delete_path(device_id)
        except Exception:
            pass
        try:
            _mediamtx_delete_rec_path(device_id)
        except Exception:
            pass
        return {"ok": True, "device_id": device_id, "removed": True, "reason": "no_profile"}

    req = _device_req(d)
    source_uri = _get_stream_uri(req, d.profile_token)
    source_rtsp = _rtsp_with_auth(source_uri, d.username, d.password)
    result = _ensure_mediamtx_path(device_id, source_rtsp, preload=bool(d.preload_stream))

    # Refresh recording path if separate recording profile is set
    rec_token = getattr(d, 'recording_profile_token', None)
    if rec_token and rec_token != d.profile_token:
        try:
            rec_uri = _get_stream_uri(req, rec_token)
            rec_rtsp = _rtsp_with_auth(rec_uri, d.username, d.password)
            _ensure_mediamtx_rec_path(device_id, rec_rtsp, preload=bool(d.preload_stream))
        except Exception:
            pass
    else:
        # No separate recording profile — clean up any stale rec path
        try:
            _mediamtx_delete_rec_path(device_id)
        except Exception:
            pass

    return result


def _path_bytes_from_snapshot_row(row: Optional[dict]) -> int:
    if not row:
        return 0
    for key in ("bytesReceived", "bytes_received", "bytesreceived"):
        if key in row:
            try:
                return int(row.get(key) or 0)
            except Exception:
                return 0
    return 0


def _path_readers_from_snapshot_row(row: Optional[dict]) -> int:
    if not row:
        return 0
    readers_raw = row.get("readers", [])
    if isinstance(readers_raw, list):
        return len(readers_raw)
    try:
        return int(readers_raw or 0)
    except Exception:
        return 0


def _path_row_for_device(snapshot: dict, device_id: str) -> Optional[dict]:
    path_name = _path_for(device_id)
    for row in list(snapshot.get("items") or []):
        if row.get("name") == path_name:
            return row
    return None


def _update_path_monitor_state(device_id: str, row: Optional[dict]) -> dict:
    now = time.time()

    bytes_received = _path_bytes_from_snapshot_row(row)
    readers = _path_readers_from_snapshot_row(row)

    with _path_monitor_lock:
        st = _path_monitor_state.get(device_id)
        if st is None:
            st = {
                "last_bytes": int(bytes_received),
                "last_progress_ts": now,
                "no_progress_count": 0,
                "is_online": bool(row is not None and int(bytes_received) > 0),
            }
            _path_monitor_state[device_id] = st
            return {
                "progressed": True,
                "previous_online": None,
                "current_online": bool(st["is_online"]),
                "no_progress_count": int(st["no_progress_count"]),
                "seconds_since_progress": 0.0,
                "bytes_received": int(bytes_received),
                "readers": int(readers),
            }

        prev_bytes = int(st.get("last_bytes", 0))
        progressed = int(bytes_received) > prev_bytes

        if progressed:
            st["last_bytes"] = int(bytes_received)
            st["last_progress_ts"] = now
            st["no_progress_count"] = 0
        else:
            st["no_progress_count"] = int(st.get("no_progress_count", 0)) + 1

        previous_online = bool(st.get("is_online", False))
        seconds_since_progress = now - float(st.get("last_progress_ts", now))

        current_online = bool(
            row is not None and (
                progressed
                or int(readers) > 0
                or seconds_since_progress < STREAM_STALE_SEC
            )
        )

        st["is_online"] = current_online

        return {
            "progressed": progressed,
            "previous_online": previous_online,
            "current_online": current_online,
            "no_progress_count": int(st["no_progress_count"]),
            "seconds_since_progress": round(seconds_since_progress, 1),
            "bytes_received": int(bytes_received),
            "readers": int(readers),
        }


def _device_stream_status_from_snapshot(device: Device, snapshot: dict) -> dict:
    row = _path_row_for_device(snapshot, device.id)
    path_name = _path_for(device.id)

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
        out["online"] = False
        out["available"] = False
        out["ready"] = False
        out["source_ready"] = False
        out["bytes_received"] = 0
        out["readers"] = 0
        out["stalled"] = True
        out["seconds_since_progress"] = None
        out["no_progress_count"] = None
        return out

    def g(d, *names, default=None):
        for name in names:
            if name in d:
                return d[name]
        return default

    source_ready = bool(g(row, "sourceReady", "source_ready", default=False))
    ready = bool(g(row, "ready", default=False))
    online = bool(g(row, "online", default=False))
    available = bool(g(row, "available", default=False))
    source_on_demand = g(row, "sourceOnDemand", "source_on_demand", default=None)
    source = g(row, "source", default=None)
    bytes_received = _path_bytes_from_snapshot_row(row)
    readers = _path_readers_from_snapshot_row(row)

    monitor = _update_path_monitor_state(device.id, row)
    stream_up = bool(monitor["current_online"])
    seconds_since_progress = monitor["seconds_since_progress"]

    healthy_backend = bool(
        row is not None and (
            source_ready
            or (
                bool(device.preload_stream)
                and bool(source)
                and not bool(source_on_demand)
                and ready
            )
        )
    )

    recent_grace = (
        seconds_since_progress is not None and
        seconds_since_progress < 3.0
    )

    stalled = not stream_up and not healthy_backend

    status = "down"
    if readers > 0:
        status = "live"
    elif healthy_backend or recent_grace:
        status = "idle"

    out.update({
        "source_ready": source_ready,
        "ready": ready,
        "online": online,
        "available": available,
        "source_on_demand": source_on_demand,
        "source": source,
        "bytes_received": bytes_received,
        "readers": readers,
        "seconds_since_progress": monitor["seconds_since_progress"],
        "no_progress_count": monitor["no_progress_count"],
        "stalled": stalled,
        "stream_up": stream_up,
        "status": status,
    })

    return out


def _preload_stream_for_device(device: Device) -> None:
    if not device.profile_token or not device.preload_stream:
        return
    req = _device_req(device)
    source_uri = _get_stream_uri(req, device.profile_token)
    source_rtsp = _rtsp_with_auth(source_uri, device.username, device.password)
    _ensure_mediamtx_path(device.id, source_rtsp, preload=True)
    # Also preload recording stream if a separate recording profile is set
    rec_token = getattr(device, 'recording_profile_token', None)
    if rec_token and rec_token != device.profile_token:
        try:
            rec_uri = _get_stream_uri(req, rec_token)
            rec_rtsp = _rtsp_with_auth(rec_uri, device.username, device.password)
            _ensure_mediamtx_rec_path(device.id, rec_rtsp, preload=True)
        except Exception:
            pass


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
    pan = float(pan)
    tilt = float(tilt)
    zoom = float(zoom)
    if abs(pan) < 0.001 and abs(tilt) < 0.001 and abs(zoom) < 0.001:
        _clear_ptz_watchdog(device_id)
        return _ptz_stop(device_id, reason="zero_velocity")

    d = _get_device(device_id)
    req = _device_req(d)
    ctx = _get_ptz_context(req, d.profile_token)
    if not ctx.has_ptz:
        raise RuntimeError("Device has no PTZ")

    velocity = {}
    if ctx.has_pan_tilt:
        velocity["PanTilt"] = {"x": pan, "y": tilt}
        if ctx.pan_tilt_space:
            velocity["PanTilt"]["space"] = ctx.pan_tilt_space
    if ctx.has_zoom:
        velocity["Zoom"] = {"x": zoom}
        if ctx.zoom_space:
            velocity["Zoom"]["space"] = ctx.zoom_space

    lock = _ptz_device_lock(device_id)
    with lock:
        req_move = {"ProfileToken": ctx.profile_token, "Velocity": velocity}
        ctx.ptz.ContinuousMove(req_move)

    _dispatch_ptz_manual_control_trigger(
        device_id,
        True,
        reason="move",
        pan=pan,
        tilt=tilt,
        zoom=zoom,
    )

    return {"ok": True, "device_id": device_id}


def _ptz_stop(device_id: str, reason: str = "stop") -> dict:
    d = _get_device(device_id)
    req = _device_req(d)
    ctx = _get_ptz_context(req, d.profile_token)
    if not ctx.has_ptz:
        _dispatch_ptz_manual_control_trigger(device_id, False, reason=reason)
        return {"ok": True, "device_id": device_id}

    lock = _ptz_device_lock(device_id)
    with lock:
        try:
            ctx.ptz.Stop({"ProfileToken": ctx.profile_token, "PanTilt": True, "Zoom": True})
        except Exception:
            pass
    _dispatch_ptz_manual_control_trigger(device_id, False, reason=reason)
    return {"ok": True, "device_id": device_id}


def _schedule_ptz_watchdog_stop(device_id: str) -> None:
    _clear_ptz_watchdog(device_id)

    with _ptz_watchdog_lock:
        t = threading.Timer(PTZ_WATCHDOG_SEC, lambda: _ptz_watchdog_stop(device_id))
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


@app.post("/api/devices/{device_id}/refresh-stream")
async def refresh_device_stream(device_id: str):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    try:
        out = await asyncio.to_thread(_refresh_device_stream, device_id)
        request_recorders_refresh()
        return {"ok": True, "device_id": device_id, "result": out}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Refresh stream failed: {e}")


@app.get("/api/cloud/config")
def cloud_config_get():
    cfg = _load_cloud_connector_config()
    running = False

    try:
        running = _apply_cloud_connector_config(cfg)
    except HTTPException:
        pass

    return {"ok": True, **cfg, "running": running}


@app.post("/api/cloud/config")
def cloud_config_save(req: CloudConnectorConfigIn):
    cfg = _normalize_cloud_connector_config(_dump(req))
    _save_cloud_connector_config(cfg)
    _log_cloud.info("Cloud connector config saved")

    running = False
    try:
        running = _apply_cloud_connector_config(cfg)
    except HTTPException:
        pass

    return {"ok": True, **cfg, "running": running}


@app.post("/api/cloud/connect")
def cloud_connect(req: CloudConnectorConfigIn):
    cfg = _normalize_cloud_connector_config(_dump(req))
    _save_cloud_connector_config(cfg)

    module = _cloud_connector_module()
    module.configure_connector(
        cloud_ws_url=cfg["cloud_ws_url"],
        cloud_token=cfg["cloud_token"],
        hub_device_id=cfg["hub_device_id"],
    )
    module.start_cloud_connector()
    _log_cloud.info("Cloud connector started with URL %s", cfg["cloud_ws_url"])

    return {"ok": True, **cfg, "running": bool(module.is_connector_running())}


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
    _log_devices.info("Device added: %s (%s)", new.name, new.id)
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

    request_recorders_refresh()

    return {"ok": True, "device": _dump(new)}


@app.put("/api/devices/{device_id}")
def update_device(device_id: str, dev_in: DeviceIn):
    device_id = device_id.strip()
    if not device_id:
        raise HTTPException(status_code=400, detail="Missing device_id")

    dev = _update_device(device_id, dev_in)
    request_recorders_refresh()
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
    _log_devices.info("Device deleted: %s", device_id)
    _invalidate_ptz_cache(device_id)
    _stop_event_worker(device_id)

    with _path_monitor_lock:
        _path_monitor_state.pop(device_id, None)

    try:
        _mediamtx_delete_path(device_id)
    except Exception:
        pass

    try:
        _mediamtx_delete_rec_path(device_id)
    except Exception:
        pass

    request_recorders_refresh()

    return {"ok": True}


# ── Speaker CRUD ───────────────────────────────────────────────────────────────

@app.get("/api/speakers")
def list_speakers():
    return {"speakers": [_dump(s) for s in _load_speakers()]}


@app.post("/api/speakers")
def create_speaker(spk: SpeakerIn):
    speakers = _load_speakers()
    new = Speaker(id=uuid.uuid4().hex[:12], **_dump(spk))
    speakers.append(new)
    _save_speakers(speakers)
    _log_speakers.info("Speaker added: %s (%s)", new.name, new.id)
    return {"ok": True, "speaker": _dump(new)}


@app.put("/api/speakers/{speaker_id}")
def update_speaker(speaker_id: str, spk_in: SpeakerIn):
    speaker_id = speaker_id.strip()
    if not speaker_id:
        raise HTTPException(status_code=400, detail="Missing speaker_id")
    speakers = _load_speakers()
    for i, s in enumerate(speakers):
        if s.id == speaker_id:
            speakers[i] = Speaker(id=speaker_id, **_dump(spk_in))
            _save_speakers(speakers)
            _log_speakers.info("Speaker updated: %s (%s)", speakers[i].name, speaker_id)
            return {"ok": True, "speaker": _dump(speakers[i])}
    raise HTTPException(status_code=404, detail="Speaker not found")


@app.delete("/api/speakers/{speaker_id}")
def delete_speaker(speaker_id: str):
    speaker_id = speaker_id.strip()
    if not speaker_id:
        raise HTTPException(status_code=400, detail="Missing speaker_id")
    speakers = _load_speakers()
    new_speakers = [s for s in speakers if s.id != speaker_id]
    if len(new_speakers) == len(speakers):
        raise HTTPException(status_code=404, detail="Speaker not found")
    _save_speakers(new_speakers)
    _log_speakers.info("Speaker deleted: %s", speaker_id)
    return {"ok": True}


@app.post("/api/speakers/{speaker_id}/test")
async def test_speaker(speaker_id: str):
    """Play a short test tone on the speaker to verify connectivity."""
    spk = _get_speaker(speaker_id)
    # Try to reach the speaker with a simple GET to verify connectivity
    url = f"http://{spk.ip}/axis-cgi/param.cgi?action=list&group=Brand"
    password_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    password_mgr.add_password(None, url, spk.username, spk.password)
    digest_handler = urllib.request.HTTPDigestAuthHandler(password_mgr)
    basic_handler = urllib.request.HTTPBasicAuthHandler(password_mgr)
    opener = urllib.request.build_opener(digest_handler, basic_handler)
    req = urllib.request.Request(url)
    try:
        def _work():
            with opener.open(req, timeout=10) as resp:
                return resp.read(2048).decode("utf-8", errors="replace")
        body = await asyncio.to_thread(_work)
        return {"ok": True, "response": body}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Speaker connection failed: {exc}")


def _check_speaker_online(spk: Speaker) -> dict:
    """Check if a speaker is reachable by hitting its param API."""
    url = f"http://{spk.ip}/axis-cgi/param.cgi?action=list&group=Brand"
    opener = _axis_auth_opener(url, spk.username, spk.password)
    req = urllib.request.Request(url)
    try:
        with opener.open(req, timeout=5) as resp:
            resp.read(512)
        return {"speaker_id": spk.id, "name": spk.name, "ip": spk.ip, "status": "online"}
    except Exception:
        return {"speaker_id": spk.id, "name": spk.name, "ip": spk.ip, "status": "offline"}


@app.get("/api/speaker-status")
async def all_speaker_status():
    spks = _load_speakers()
    if not spks:
        return {"items": []}

    import concurrent.futures
    def _work():
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(spks), 8)) as pool:
            return list(pool.map(_check_speaker_online, spks))

    items = await asyncio.to_thread(_work)
    return {"items": items}


# ── Audio clips ────────────────────────────────────────────────────────────────

_ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg"}
_MAX_AUDIO_CLIP_SIZE = 50 * 1024 * 1024  # 50 MB


@app.get("/api/audio-clips")
def list_audio_clips():
    clips = []
    if AUDIO_CLIPS_DIR.is_dir():
        for f in sorted(AUDIO_CLIPS_DIR.iterdir()):
            if f.is_file() and f.suffix.lower() in _ALLOWED_AUDIO_EXTENSIONS:
                clips.append({"filename": f.name, "size": f.stat().st_size})
    return {"clips": clips}


@app.post("/api/audio-clips")
async def upload_audio_clip(request: Request):
    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" not in content_type:
        raise HTTPException(status_code=400, detail="Expected multipart/form-data")

    from starlette.formparsers import MultiPartParser
    form = await request.form()
    upload = form.get("file")
    if upload is None:
        raise HTTPException(status_code=400, detail="No file uploaded")

    filename = getattr(upload, "filename", None) or "clip.mp3"
    # Sanitize filename — only allow safe characters
    safe_name = _re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
    if not safe_name or safe_name.startswith("."):
        safe_name = "clip.mp3"
    ext = Path(safe_name).suffix.lower()
    if ext not in _ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}. Allowed: {', '.join(_ALLOWED_AUDIO_EXTENSIONS)}")

    data = await upload.read()
    if len(data) > _MAX_AUDIO_CLIP_SIZE:
        raise HTTPException(status_code=400, detail=f"File too large (max {_MAX_AUDIO_CLIP_SIZE // (1024*1024)} MB)")
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    dest = AUDIO_CLIPS_DIR / safe_name
    dest.write_bytes(data)
    _log_speakers.info("Audio clip uploaded: %s (%d bytes)", safe_name, len(data))
    return {"ok": True, "filename": safe_name, "size": len(data)}


@app.delete("/api/audio-clips/{filename}")
def delete_audio_clip(filename: str):
    safe_name = _re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
    target = AUDIO_CLIPS_DIR / safe_name
    if not target.is_file() or not str(target.resolve()).startswith(str(AUDIO_CLIPS_DIR.resolve())):
        raise HTTPException(status_code=404, detail="Audio clip not found")
    target.unlink()
    _log_speakers.info("Audio clip deleted: %s", safe_name)
    return {"ok": True}


@app.post("/api/speakers/{speaker_id}/play")
async def play_audio_clip_on_speaker(speaker_id: str, request: Request):
    """Play an audio clip on a speaker. Body: {"filename": "clip.mp3"}"""
    spk = _get_speaker(speaker_id)
    body = await request.json()
    filename = str(body.get("filename") or "").strip()
    if not filename:
        raise HTTPException(status_code=400, detail="Missing filename")
    safe_name = _re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
    clip_path = AUDIO_CLIPS_DIR / safe_name
    if not clip_path.is_file() or not str(clip_path.resolve()).startswith(str(AUDIO_CLIPS_DIR.resolve())):
        raise HTTPException(status_code=404, detail="Audio clip not found")

    audio_bytes = clip_path.read_bytes()

    def _work():
        return play_audio_on_speaker(spk.ip, spk.username, spk.password, audio_bytes, safe_name)

    result = await asyncio.to_thread(_work)
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=result.get("error", "Playback failed"))
    return result


@app.post("/api/speakers/{speaker_id}/voice")
async def voice_to_speaker(speaker_id: str, request: Request):
    """Send recorded voice audio to a speaker. Accepts raw audio blob (webm/ogg)."""
    spk = _get_speaker(speaker_id)

    content_type = request.headers.get("content-type", "")
    audio_bytes = await request.body()
    if not audio_bytes or len(audio_bytes) < 100:
        raise HTTPException(status_code=400, detail="No audio data received")
    if len(audio_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Audio too large (max 10 MB)")

    ext = ".webm"
    if "ogg" in content_type:
        ext = ".ogg"
    elif "wav" in content_type:
        ext = ".wav"

    def _work():
        return play_audio_on_speaker(spk.ip, spk.username, spk.password, audio_bytes, f"voice{ext}")

    result = await asyncio.to_thread(_work)
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=result.get("error", "Voice playback failed"))
    return result


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


@app.api_route("/api/whep/{path:path}", methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"])
async def whep_proxy(path: str, request: Request):
    """Proxy WHEP requests to MediaMTX so HTTPS pages can reach it."""
    host = request.headers.get("host", "").split(":")[0] or "localhost"
    target_url = f"http://{host}:8889/{path}"
    body = await request.body()
    headers = {}
    for k, v in request.headers.items():
        lk = k.lower()
        if lk in ("content-type", "accept", "authorization"):
            headers[k] = v
    req = urllib.request.Request(
        target_url,
        data=body if body else None,
        method=request.method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp_body = resp.read()
            resp_headers = {}
            for h in ("content-type", "location", "etag"):
                val = resp.getheader(h)
                if val:
                    resp_headers[h] = val
            return Response(
                content=resp_body,
                status_code=resp.status,
                headers=resp_headers,
            )
    except urllib.error.HTTPError as exc:
        resp_body = b""
        try:
            resp_body = exc.read(8192)
        except Exception:
            pass
        return Response(content=resp_body, status_code=exc.code)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


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
        try:
            snapshot = await asyncio.to_thread(_mediamtx_paths_snapshot)
            st = _device_stream_status_from_snapshot(device, snapshot)

            if st.get("status") in {"idle", "live"}:
                return {
                    "ok": True,
                    "device_id": device_id,
                    "path": _path_for(device_id),
                    "preloaded": True,
                    "skipped_onvif": True,
                }
        except Exception:
            pass

    try:
        encoding = await asyncio.to_thread(_find_profile_encoding, req, req.profile_token)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ONVIF profile check failed: {e}")

    if (encoding or "").upper() != "H264":
        _log_streams.warning("Profile uses %s (not H264) for device %s", encoding or "unknown", device_id)
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
        await asyncio.to_thread(
            _ensure_mediamtx_path,
            device_id,
            source_rtsp,
            bool(device.preload_stream) if device else False,
        )
        request_recorders_refresh()
    except Exception as e:
        _log_streams.error("MediaMTX path setup failed for %s: %s", device_id, e)
        raise HTTPException(status_code=500, detail=f"MediaMTX path setup failed: {e}")

    _log_streams.info("Started stream for device %s", device_id)
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
        _clear_ptz_watchdog(device_id)
        return await asyncio.to_thread(_ptz_stop, device_id, "api_stop")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"PTZ stop failed: {e}")


# ── Scenarios (AI analysis presets) ─────────────────────────────────────────────

SCENARIOS_JSON = DATA_DIR / "scenarios.json"
_scenarios_lock = threading.RLock()

_VALID_SCENARIO_RESPONSE_TYPES = {"boolean", "number", "text", "choice"}


def _normalize_scenario(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize a scenario dict, ensuring all fields have valid defaults."""
    response_type = str(raw.get("response_type") or "text").strip().lower()
    if response_type not in _VALID_SCENARIO_RESPONSE_TYPES:
        response_type = "text"
    choices_raw = raw.get("choices") or []
    choices = [str(c).strip() for c in choices_raw if str(c).strip()] if response_type == "choice" else []
    return {
        "id": str(raw.get("id") or "").strip(),
        "name": str(raw.get("name") or "").strip(),
        "prompt": str(raw.get("prompt") or "").strip(),
        "response_type": response_type,
        "choices": choices,
        "result_variable": str(raw.get("result_variable") or "").strip(),
        "max_contributions": max(0, int(raw.get("max_contributions") or 0)),
        "max_seconds": max(0.0, float(raw.get("max_seconds") or 0)),
        "auto_event_enabled": bool(raw.get("auto_event_enabled")),
        "auto_event_priority": str(raw.get("auto_event_priority") or "medium").strip(),
        "auto_event_on_result": str(raw.get("auto_event_on_result") or "true").strip(),
    }


def _load_scenarios() -> List[Dict[str, Any]]:
    try:
        if not SCENARIOS_JSON.exists():
            return []
        payload = json.loads(SCENARIOS_JSON.read_text(encoding="utf-8"))
        items = payload.get("items") if isinstance(payload, dict) else []
        return [_normalize_scenario(s) for s in items if isinstance(s, dict)]
    except Exception:
        return []


def _save_scenarios(items: List[Dict[str, Any]]) -> None:
    tmp = SCENARIOS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}, indent=2), encoding="utf-8")
    tmp.replace(SCENARIOS_JSON)


def _get_scenario(scenario_id: str) -> Optional[Dict[str, Any]]:
    for s in _load_scenarios():
        if s.get("id") == scenario_id:
            return s
    return None


@app.get("/api/scenarios")
def api_scenarios_list():
    return {"items": _load_scenarios()}


@app.post("/api/scenarios")
def api_scenario_create(body: dict):
    name = str(body.get("name") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")
    scenario = _normalize_scenario({**body, "id": uuid.uuid4().hex[:12], "name": name, "prompt": prompt})
    with _scenarios_lock:
        items = _load_scenarios()
        items.append(scenario)
        _save_scenarios(items)
    return scenario


@app.put("/api/scenarios/{scenario_id}")
def api_scenario_update(scenario_id: str, body: dict):
    name = str(body.get("name") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")
    with _scenarios_lock:
        items = _load_scenarios()
        for idx, item in enumerate(items):
            if item.get("id") == scenario_id:
                items[idx] = _normalize_scenario({**body, "id": scenario_id, "name": name, "prompt": prompt})
                _save_scenarios(items)
                return items[idx]
    raise HTTPException(status_code=404, detail="Scenario not found")


@app.delete("/api/scenarios/{scenario_id}")
def api_scenario_delete(scenario_id: str):
    with _scenarios_lock:
        items = _load_scenarios()
        before = len(items)
        items = [s for s in items if s.get("id") != scenario_id]
        if len(items) == before:
            raise HTTPException(status_code=404, detail="Scenario not found")
        _save_scenarios(items)
    return {"ok": True}


# ── Event definitions (sidebar templates) ──────────────────────────────────────

EVENT_DEFINITIONS_JSON = DATA_DIR / "event_definitions.json"
_event_definitions_lock = threading.RLock()

EVENT_PRIORITIES = ["critical", "high", "medium", "low", "info"]


def _normalize_event_definition(raw: Dict[str, Any]) -> Dict[str, Any]:
    priority = str(raw.get("priority") or "medium").strip().lower()
    if priority not in EVENT_PRIORITIES:
        priority = "medium"
    return {
        "id": str(raw.get("id") or "").strip(),
        "name": str(raw.get("name") or "").strip(),
        "priority": priority,
        "details": str(raw.get("details") or "").strip(),
        "max_contributions": max(0, int(raw.get("max_contributions") or 0)),
        "max_seconds": max(0.0, float(raw.get("max_seconds") or 0)),
    }


def _load_event_definitions() -> List[Dict[str, Any]]:
    try:
        if not EVENT_DEFINITIONS_JSON.exists():
            return []
        payload = json.loads(EVENT_DEFINITIONS_JSON.read_text(encoding="utf-8"))
        items = payload.get("items") if isinstance(payload, dict) else []
        return [_normalize_event_definition(e) for e in items if isinstance(e, dict)]
    except Exception:
        return []


def _save_event_definitions(items: List[Dict[str, Any]]) -> None:
    tmp = EVENT_DEFINITIONS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}, indent=2), encoding="utf-8")
    tmp.replace(EVENT_DEFINITIONS_JSON)


def _get_event_definition(definition_id: str) -> Optional[Dict[str, Any]]:
    for e in _load_event_definitions():
        if e.get("id") == definition_id:
            return e
    return None


@app.get("/api/event-definitions")
def api_event_definitions_list():
    return {"items": _load_event_definitions()}


@app.post("/api/event-definitions")
def api_event_definition_create(body: dict):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    defn = _normalize_event_definition({**body, "id": uuid.uuid4().hex[:12], "name": name})
    with _event_definitions_lock:
        items = _load_event_definitions()
        items.append(defn)
        _save_event_definitions(items)
    return defn


@app.put("/api/event-definitions/{definition_id}")
def api_event_definition_update(definition_id: str, body: dict):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    with _event_definitions_lock:
        items = _load_event_definitions()
        for idx, item in enumerate(items):
            if item.get("id") == definition_id:
                items[idx] = _normalize_event_definition({**body, "id": definition_id, "name": name})
                _save_event_definitions(items)
                return items[idx]
    raise HTTPException(status_code=404, detail="Event definition not found")


@app.delete("/api/event-definitions/{definition_id}")
def api_event_definition_delete(definition_id: str):
    with _event_definitions_lock:
        items = _load_event_definitions()
        before = len(items)
        items = [e for e in items if e.get("id") != definition_id]
        if len(items) == before:
            raise HTTPException(status_code=404, detail="Event definition not found")
        _save_event_definitions(items)
    return {"ok": True}


# ── OpenAI API key management ─────────────────────────────────────────────────

OPENAI_ENV_PATH = Path("/app/secrets/openai.env")


@app.get("/api/settings/openai-key")
async def get_openai_key():
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key or key == "your_openai_api_key_here":
        return {"configured": False, "masked_key": ""}
    masked = key[:3] + "…" + key[-4:] if len(key) > 10 else "***"
    return {"configured": True, "masked_key": masked}


@app.put("/api/settings/openai-key")
async def set_openai_key(req: Request):
    body = await req.json()
    key = str(body.get("key") or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="API key is required")

    # Persist to env file
    try:
        OPENAI_ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
        OPENAI_ENV_PATH.write_text(f"OPENAI_API_KEY={key}\n", encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write key file: {exc}")

    # Update in-process so it takes effect immediately
    os.environ["OPENAI_API_KEY"] = key
    return {"ok": True, "configured": True}


# ── Template rendering helper (no flow context needed) ─────────────────────────

def _render_template_simple(template: str, context: Dict[str, Any] = None) -> str:
    """Lightweight template renderer for contribution contexts.
    Supports {{contributions.count}}, {{contributions.texts}}, etc.
    """
    out = str(template or "")
    if not context:
        return out
    contributions = context.get("contributions") or {}
    texts_list = contributions.get("texts") or []
    out = out.replace("{{contributions.count}}", str(contributions.get("count", len(texts_list))))
    out = out.replace("{{contributions.texts}}", "\n".join(texts_list))
    out = out.replace("{{contributions.images_count}}", str(len(contributions.get("images") or [])))
    return out


# ── GPT vision analysis ───────────────────────────────────────────────────────

def _analyze_with_gpt(prompt: str, snapshot_data_uris: List[str]) -> str:
    """Send prompt + base64 images to GPT-4o for analysis. Returns the response text."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key or api_key == "your_openai_api_key_here":
        _log_events.warning("OpenAI API key not configured – skipping AI analysis")
        return "[Error: OpenAI API key is not configured. Add your key to secrets/openai.env and restart.]"
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        content: list = [{"type": "text", "text": prompt}]
        for uri in snapshot_data_uris:
            if uri:
                content.append({"type": "image_url", "image_url": {"url": uri}})
        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": content}],
            max_tokens=1024,
        )
        return (resp.choices[0].message.content or "").strip()
    except Exception as exc:
        _log_events.warning("GPT analysis failed: %s", exc)
        exc_msg = str(exc)
        if "auth" in exc_msg.lower() or "api key" in exc_msg.lower() or "invalid" in exc_msg.lower():
            return "[Error: OpenAI API key is invalid. Check your key in secrets/openai.env and restart.]"
        return f"[Error: AI analysis failed — {exc_msg}]"


def _build_structured_schema(response_type: str, choices: List[str]) -> Optional[Dict[str, Any]]:
    """Build a JSON schema for structured GPT output based on response type."""
    if response_type == "boolean":
        result_schema = {"type": "boolean"}
    elif response_type == "number":
        result_schema = {"type": "number"}
    elif response_type == "choice":
        if not choices:
            return None
        result_schema = {"type": "string", "enum": choices}
    elif response_type == "text":
        result_schema = {"type": "string"}
    else:
        return None
    return {
        "type": "object",
        "properties": {
            "reasoning": {"type": "string", "description": "Brief explanation of your analysis"},
            "result": result_schema,
        },
        "required": ["reasoning", "result"],
        "additionalProperties": False,
    }


def _analyze_with_gpt_structured(
    prompt: str,
    snapshot_data_uris: List[str],
    response_type: str,
    choices: List[str],
) -> Dict[str, Any]:
    """Send prompt + images to GPT-4o with structured output. Returns {reasoning, result, raw, error}."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key or api_key == "your_openai_api_key_here":
        _log_events.warning("OpenAI API key not configured – skipping AI analysis")
        return {"reasoning": "", "result": None, "raw": "", "error": "OpenAI API key is not configured."}

    schema = _build_structured_schema(response_type, choices)
    if schema is None:
        return {"reasoning": "", "result": None, "raw": "", "error": f"Invalid response type: {response_type}"}

    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key)
        content: list = [{"type": "text", "text": prompt}]
        for uri in snapshot_data_uris:
            if uri:
                content.append({"type": "image_url", "image_url": {"url": uri}})

        resp = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": content}],
            max_tokens=1024,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "scenario_response",
                    "strict": True,
                    "schema": schema,
                },
            },
        )
        raw_text = (resp.choices[0].message.content or "").strip()
        parsed = json.loads(raw_text)
        return {
            "reasoning": str(parsed.get("reasoning") or ""),
            "result": parsed.get("result"),
            "raw": raw_text,
            "error": None,
        }
    except json.JSONDecodeError as exc:
        _log_events.warning("GPT structured output parse failed: %s", exc)
        return {"reasoning": "", "result": None, "raw": raw_text, "error": f"Failed to parse response: {exc}"}
    except Exception as exc:
        _log_events.warning("GPT structured analysis failed: %s", exc)
        exc_msg = str(exc)
        return {"reasoning": "", "result": None, "raw": "", "error": f"AI analysis failed: {exc_msg}"}


# ── Events (operator events) ───────────────────────────────────────────────────

EVENTS_JSON = DATA_DIR / "events.json"
ARCHIVED_EVENTS_JSON = DATA_DIR / "archived_events.json"
_events_lock = threading.RLock()
_MAX_EVENTS = 500
_MAX_ARCHIVED = 2000

_log_events = logging.getLogger("events")

_event_page_subscribers: List[asyncio.Queue] = []
_event_page_sub_lock = threading.RLock()


def _load_events() -> List[Dict[str, Any]]:
    try:
        if not EVENTS_JSON.exists():
            return []
        payload = json.loads(EVENTS_JSON.read_text(encoding="utf-8"))
        items = payload.get("items") if isinstance(payload, dict) else []
        return list(items) if isinstance(items, list) else []
    except Exception:
        return []


def _save_events(items: List[Dict[str, Any]]) -> None:
    items = items[-_MAX_EVENTS:]
    tmp = EVENTS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}, indent=2), encoding="utf-8")
    tmp.replace(EVENTS_JSON)


def _load_archived_events() -> List[Dict[str, Any]]:
    try:
        if not ARCHIVED_EVENTS_JSON.exists():
            return []
        payload = json.loads(ARCHIVED_EVENTS_JSON.read_text(encoding="utf-8"))
        items = payload.get("items") if isinstance(payload, dict) else []
        return list(items) if isinstance(items, list) else []
    except Exception:
        return []


def _save_archived_events(items: List[Dict[str, Any]]) -> None:
    items = items[-_MAX_ARCHIVED:]
    tmp = ARCHIVED_EVENTS_JSON.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"items": items}, indent=2), encoding="utf-8")
    tmp.replace(ARCHIVED_EVENTS_JSON)


def _archive_events(events_to_archive: List[Dict[str, Any]]) -> None:
    """Move events to the archived store."""
    if not events_to_archive:
        return
    archived = _load_archived_events()
    for ev in events_to_archive:
        ev["archived_at"] = datetime.now(timezone.utc).isoformat()
    archived.extend(events_to_archive)
    _save_archived_events(archived)


def _broadcast_page_event(event: Dict[str, Any]) -> None:
    with _event_page_sub_lock:
        for q in _event_page_subscribers:
            try:
                q.put_nowait(event)
            except Exception:
                pass


def create_event(
    *,
    name: str = "",
    priority: str = "medium",
    details: str = "",
    trigger_info: str = "",
    scenario_name: str = "",
    scenario_prompt: str = "",
    analysis: str = "",
    snapshots: Optional[List[Dict[str, Any]]] = None,
    recording_refs: Optional[List[Dict[str, Any]]] = None,
    contributions: Optional[List[str]] = None,
    flow_id: Optional[str] = None,
    flow_name: Optional[str] = None,
    node_id: Optional[str] = None,
    event_definition_id: Optional[str] = None,
) -> Dict[str, Any]:
    if priority not in EVENT_PRIORITIES:
        priority = "medium"
    event = {
        "id": uuid.uuid4().hex[:12],
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "name": name or "Event",
        "priority": priority,
        "details": details,
        "trigger_info": trigger_info,
        "scenario_name": scenario_name,
        "scenario_prompt": scenario_prompt,
        "analysis": analysis,
        "snapshots": snapshots or [],
        "recording_refs": recording_refs or [],
        "contributions": contributions or [],
        "flow_id": flow_id,
        "flow_name": flow_name,
        "node_id": node_id,
        "event_definition_id": event_definition_id,
        "acknowledged": False,
    }
    with _events_lock:
        items = _load_events()
        items.append(event)
        _save_events(items)
    _log_events.info("Event created: %s", name)
    # Broadcast a lightweight version (no base64 snapshot data) over SSE
    light_event = {k: v for k, v in event.items() if k != "snapshots"}
    light_event["snapshots"] = []
    for idx, snap in enumerate(event.get("snapshots") or []):
        s = {k: v for k, v in snap.items() if k != "snapshot"}
        if snap.get("snapshot"):
            s["snapshot"] = f"/api/events/{event['id']}/snapshot/{idx}"
        else:
            s["snapshot"] = None
        light_event["snapshots"].append(s)
    _broadcast_page_event(light_event)
    return event


# ── Camera snapshot via HTTP ──────────────────────────────────────────────────

_snapshot_uri_cache: Dict[str, str] = {}


def _discover_snapshot_uri(device: Device) -> Optional[str]:
    """Use ONVIF GetSnapshotUri to discover the camera's snapshot endpoint."""
    profile_token = device.profile_token
    if not profile_token:
        return None
    try:
        req = _device_req(device)
        cam = _cam(req)
        media = cam.create_media_service()
        resp = media.GetSnapshotUri({"ProfileToken": profile_token})
        uri = getattr(resp, "Uri", None)
        if uri:
            return str(uri)
    except Exception as exc:
        _log_events.warning("GetSnapshotUri failed for %s: %s", device.id, exc)
    return None


def _resolve_snapshot_uri(device: Device) -> Optional[str]:
    """Return the snapshot URI for a device, discovering via ONVIF if needed."""
    # Check in-memory cache first
    cached = _snapshot_uri_cache.get(device.id)
    if cached:
        return cached

    # Check persisted value on device
    if device.snapshot_uri:
        _snapshot_uri_cache[device.id] = device.snapshot_uri
        return device.snapshot_uri

    # Discover via ONVIF
    uri = _discover_snapshot_uri(device)
    if uri:
        _snapshot_uri_cache[device.id] = uri
        # Persist to device so we don't re-discover every restart
        try:
            devs = _load_devices()
            for d in devs:
                if d.id == device.id:
                    d.snapshot_uri = uri
                    break
            _save_devices(devs)
        except Exception as exc:
            _log_events.warning("Failed to persist snapshot_uri for %s: %s", device.id, exc)
        return uri

    return None


def _fetch_snapshot_image(uri: str, username: str, password: str) -> Optional[bytes]:
    """Fetch a JPEG image from a camera snapshot URI with digest/basic auth."""
    import ssl
    # Local cameras typically use self-signed certs
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    # Try digest auth first (handles 401 challenge automatically), then basic
    for attempt in range(2):
        try:
            if attempt == 0:
                # Digest auth — the handler automatically responds to 401 challenges
                pwd_mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
                pwd_mgr.add_password(None, uri, username, password)
                digest_handler = urllib.request.HTTPDigestAuthHandler(pwd_mgr)
                basic_handler = urllib.request.HTTPBasicAuthHandler(pwd_mgr)
                opener = urllib.request.build_opener(
                    urllib.request.HTTPSHandler(context=ctx),
                    digest_handler,
                    basic_handler,
                )
                req = urllib.request.Request(uri)
                with opener.open(req, timeout=10) as resp:
                    return resp.read()
            else:
                # Explicit basic auth header (some cameras don't send WWW-Authenticate)
                auth_raw = f"{username}:{password}".encode("utf-8")
                auth_b64 = base64.b64encode(auth_raw).decode("ascii")
                req = urllib.request.Request(uri, headers={"Authorization": f"Basic {auth_b64}"})
                with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                    return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 401 and attempt < 1:
                continue
            _log_events.warning("Snapshot HTTP %d from %s", e.code, uri)
            return None
        except Exception as exc:
            if attempt < 1:
                continue
            _log_events.warning("Snapshot fetch failed from %s: %s", uri, exc)
            return None
    return None


def _grab_snapshot(device_id: str) -> Optional[str]:
    """Fetch a live JPEG snapshot directly from the camera's HTTP API.

    The snapshot URI is discovered via ONVIF GetSnapshotUri and cached.
    Returns a ``data:image/jpeg;base64,...`` string or *None* on failure.
    """
    try:
        device = _get_device(device_id)
    except HTTPException:
        _log_events.warning("Snapshot failed: device %s not found", device_id)
        return None

    uri = _resolve_snapshot_uri(device)
    if not uri:
        _log_events.warning("No snapshot URI available for device %s", device_id)
        return None

    img_bytes = _fetch_snapshot_image(uri, device.username, device.password)
    if not img_bytes:
        return None

    b64 = base64.b64encode(img_bytes).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


@app.get("/api/events")
def api_events_list():
    items = _load_events()
    # Strip heavy base64 snapshot data from the list response;
    # the frontend loads snapshots lazily via /api/events/{id}/snapshot/{idx}
    light_items = []
    for item in items:
        ev = {k: v for k, v in item.items() if k != "snapshots"}
        snaps = item.get("snapshots") or []
        ev["snapshots"] = []
        for idx, snap in enumerate(snaps):
            s = {k: v for k, v in snap.items() if k != "snapshot"}
            if snap.get("snapshot"):
                s["snapshot"] = f"/api/events/{item['id']}/snapshot/{idx}"
            else:
                s["snapshot"] = None
            ev["snapshots"].append(s)
        light_items.append(ev)
    return {"items": light_items}


@app.get("/api/events/{event_id}/snapshot/{index}")
def api_event_snapshot(event_id: str, index: int):
    items = _load_events()
    for item in items:
        if item.get("id") == event_id:
            snaps = item.get("snapshots") or []
            if 0 <= index < len(snaps):
                data_uri = snaps[index].get("snapshot")
                if data_uri and data_uri.startswith("data:image/"):
                    # Parse "data:image/jpeg;base64,<payload>"
                    header, b64 = data_uri.split(",", 1)
                    media = header.split(";")[0].split(":")[1]
                    img_bytes = base64.b64decode(b64)
                    return Response(content=img_bytes, media_type=media,
                                    headers={"Cache-Control": "public, max-age=86400"})
            raise HTTPException(status_code=404, detail="Snapshot not found")
    raise HTTPException(status_code=404, detail="Event not found")


@app.post("/api/events/{event_id}/acknowledge")
def api_event_acknowledge(event_id: str):
    with _events_lock:
        items = _load_events()
        for item in items:
            if item.get("id") == event_id:
                item["acknowledged"] = True
                _save_events(items)
                # Return lightweight version (no heavy snapshot data)
                ev = {k: v for k, v in item.items() if k != "snapshots"}
                ev["snapshots"] = []
                for idx, snap in enumerate(item.get("snapshots") or []):
                    s = {k: v for k, v in snap.items() if k != "snapshot"}
                    s["snapshot"] = f"/api/events/{item['id']}/snapshot/{idx}" if snap.get("snapshot") else None
                    ev["snapshots"].append(s)
                return {"ok": True, "event": ev}
    raise HTTPException(status_code=404, detail="Event not found")


@app.post("/api/events/acknowledge-all")
def api_events_acknowledge_all():
    with _events_lock:
        items = _load_events()
        for item in items:
            item["acknowledged"] = True
        _save_events(items)
    return {"ok": True}


@app.post("/api/events/{event_id}/archive")
def api_event_archive(event_id: str):
    with _events_lock:
        items = _load_events()
        archived_item = None
        remaining = []
        for item in items:
            if item.get("id") == event_id:
                archived_item = item
            else:
                remaining.append(item)
        if archived_item is None:
            raise HTTPException(status_code=404, detail="Event not found")
        _archive_events([archived_item])
        _save_events(remaining)
    return {"ok": True}


@app.post("/api/events/archive-all")
def api_events_archive_all():
    with _events_lock:
        items = _load_events()
        _archive_events(items)
        _save_events([])
    return {"ok": True}


# Keep DELETE endpoints for backward compat but they now archive
@app.delete("/api/events/{event_id}")
def api_event_delete(event_id: str):
    return api_event_archive(event_id)


@app.delete("/api/events")
def api_events_clear():
    return api_events_archive_all()


@app.get("/api/events/archived")
def api_events_archived_list():
    items = _load_archived_events()
    # Strip heavy snapshot data; return lightweight list
    light_items = []
    for item in items:
        ev = {k: v for k, v in item.items() if k != "snapshots"}
        ev["snapshots"] = []
        for idx, snap in enumerate(item.get("snapshots") or []):
            s = {k: v for k, v in snap.items() if k != "snapshot"}
            s["snapshot"] = None  # archived snapshots not served
            ev["snapshots"].append(s)
        light_items.append(ev)
    return {"items": light_items}


@app.post("/api/events/archived/{event_id}/restore")
def api_event_restore(event_id: str):
    with _events_lock:
        archived = _load_archived_events()
        restored_item = None
        remaining = []
        for item in archived:
            if item.get("id") == event_id:
                restored_item = item
            else:
                remaining.append(item)
        if restored_item is None:
            raise HTTPException(status_code=404, detail="Archived event not found")
        restored_item.pop("archived_at", None)
        _save_archived_events(remaining)
        items = _load_events()
        items.append(restored_item)
        _save_events(items)
    return {"ok": True}


@app.delete("/api/events/archived/{event_id}")
def api_archived_event_delete(event_id: str):
    with _events_lock:
        archived = _load_archived_events()
        before = len(archived)
        archived = [item for item in archived if item.get("id") != event_id]
        if len(archived) == before:
            raise HTTPException(status_code=404, detail="Archived event not found")
        _save_archived_events(archived)
    return {"ok": True}


@app.get("/api/events/stream")
async def api_events_stream():
    queue: asyncio.Queue = asyncio.Queue()
    with _event_page_sub_lock:
        _event_page_subscribers.append(queue)
    async def generate():
        try:
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event)}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            with _event_page_sub_lock:
                try:
                    _event_page_subscribers.remove(queue)
                except ValueError:
                    pass
    return StreamingResponse(generate(), media_type="text/event-stream")


@app.get("/api/devices/{device_id}/snapshot")
def api_device_snapshot(device_id: str):
    data_uri = _grab_snapshot(device_id)
    if not data_uri:
        raise HTTPException(status_code=502, detail="Could not capture snapshot")
    return {"snapshot": data_uri, "device_id": device_id}


@app.on_event("startup")
def _on_startup():
    _log_system.info("SmartEye Hub starting up")
    try:
        _restore_timezone()
        _log_system.info("Restored timezone: %s", _current_timezone())
    except Exception as e:
        _log_system.warning("Failed to restore timezone: %s", e)

    devs = _load_devices()
    _log_system.info("Loaded %d device(s)", len(devs))

    try:
        set_recording_path_refresher(_refresh_device_stream)
        start_recording_service()
        _log_system.info("Recording service started")
    except Exception as e:
        _log_system.error("Failed to start recording service: %s", e)

    try:
        global _flow_monitor_thread
        _flow_monitor_stop.clear()
        _flow_monitor_thread = threading.Thread(
            target=_poll_device_state_changes,
            daemon=True,
            name="flow-monitor",
        )
        _flow_monitor_thread.start()
        _log_system.info("Flow monitor thread started")
    except Exception as e:
        _log_system.error("Failed to start flow monitor: %s", e)

    try:
        start_schedule_monitor()
        _log_system.info("Schedule monitor started")
    except Exception as e:
        _log_system.error("Failed to start schedule monitor: %s", e)

    try:
        start_physical_io_monitor(dispatch_flow_trigger)
        _log_system.info("Physical I/O monitor started")
    except Exception as e:
        _log_system.error("Failed to start physical I/O monitor: %s", e)

    try:
        _ensure_event_workers(devs)
        _log_system.info("Event workers initialized for %d device(s)", len(devs))
    except Exception as e:
        _log_system.error("Failed to initialize event workers: %s", e)

    def _preload_all():
        for d in devs:
            try:
                _preload_stream_for_device(d)
            except Exception:
                pass
        request_recorders_refresh()
        _log_system.info("Preload streams finished for %d device(s)", len(devs))

    threading.Thread(target=_preload_all, daemon=True, name="preload-streams").start()


@app.on_event("shutdown")
def _on_shutdown():
    _log_system.info("SmartEye Hub shutting down")
    with _event_worker_lock:
        workers = list(_event_workers.values())
        _event_workers.clear()
    _log_system.info("Stopping %d event worker(s)", len(workers))

    for w in workers:
        try:
            w.stop_flag.set()
        except Exception:
            pass

    _flow_monitor_stop.set()
    stop_schedule_monitor()
    stop_physical_io_monitor()
    stop_recording_service()

    with _ptz_watchdog_lock:
        timers = list(_ptz_watchdogs.values())
        _ptz_watchdogs.clear()

    for t in timers:
        try:
            t.cancel()
        except Exception:
            pass