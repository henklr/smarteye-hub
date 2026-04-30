"""
auth.py — PAM-based authentication for SmartEye Hub

Authenticates users against the Linux OS user database via PAM.
Uses signed, HttpOnly session cookies for session management.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import hashlib
import hmac
import json
import logging
import os
import secrets
import struct
import threading
import time
from typing import Any, Dict, Optional, Tuple

from fastapi import HTTPException, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, RedirectResponse

_log = logging.getLogger("auth")

# ── Configuration ─────────────────────────────────────────────────────────────

SESSION_MAX_AGE = int(os.getenv("SESSION_MAX_AGE", "86400"))        # 24 hours
LOGIN_RATE_WINDOW = int(os.getenv("LOGIN_RATE_WINDOW", "300"))      # 5 min window
LOGIN_RATE_MAX = int(os.getenv("LOGIN_RATE_MAX", "10"))             # max attempts
AUTH_COOKIE_NAME = "smarteye_session"

# Secret key for signing cookies — generated once per process start
_COOKIE_SECRET = os.getenv("COOKIE_SECRET", "").encode() or secrets.token_bytes(32)

# Internal token used by `dashboard_connector` to call the hub's own API on
# 127.0.0.1 without a session cookie. The middleware accepts the bypass only
# when the request originates locally AND carries this exact token, so it
# cannot be exercised from the LAN.
#
# The container launches two uvicorn instances, so a per-process random
# value would diverge between them and leave the connector hitting an
# instance with a different token (→ 401). Derive deterministically from
# COOKIE_SECRET, which the Dockerfile exports before forking either uvicorn,
# so both processes end up with the same value.
INTERNAL_BYPASS_HEADER = "X-Connector-Internal"
INTERNAL_BYPASS_TOKEN = hashlib.sha256(_COOKIE_SECRET + b"connector-internal-bypass").hexdigest()

# ── PAM authentication ────────────────────────────────────────────────────────

def _load_libpam():
    """Load the PAM shared library."""
    lib_name = ctypes.util.find_library("pam")
    if not lib_name:
        for path in ("/lib/x86_64-linux-gnu/libpam.so.0",
                     "/lib/aarch64-linux-gnu/libpam.so.0",
                     "/lib/arm-linux-gnueabihf/libpam.so.0",
                     "libpam.so.0", "libpam.so"):
            try:
                return ctypes.CDLL(path)
            except OSError:
                continue
        return None
    return ctypes.CDLL(lib_name)


def _load_libc():
    """Load libc for malloc/free/strdup."""
    lib_name = ctypes.util.find_library("c")
    if lib_name:
        return ctypes.CDLL(lib_name, use_errno=True)
    return ctypes.CDLL("libc.so.6", use_errno=True)


_libpam = _load_libpam()
_libc = _load_libc()

# PAM constants
PAM_PROMPT_ECHO_OFF = 1
PAM_SUCCESS = 0

# sizeof(struct pam_response) = pointer + int (+ padding)
_RESP_STRUCT_SIZE = ctypes.sizeof(ctypes.c_char_p) + ctypes.sizeof(ctypes.c_int)
# Align to pointer size
_RESP_STRUCT_SIZE = ((_RESP_STRUCT_SIZE + ctypes.sizeof(ctypes.c_void_p) - 1)
                     // ctypes.sizeof(ctypes.c_void_p)
                     * ctypes.sizeof(ctypes.c_void_p))


class _PamConv(ctypes.Structure):
    """struct pam_conv."""
    _fields_ = [
        ("conv", ctypes.c_void_p),
        ("appdata_ptr", ctypes.c_void_p),
    ]


# Conversation callback C type:
#   int (*)(int, const struct pam_message **, struct pam_response **, void *)
_CONV_FUNC = ctypes.CFUNCTYPE(
    ctypes.c_int,                               # return
    ctypes.c_int,                               # num_msg
    ctypes.POINTER(ctypes.c_void_p),            # msg array
    ctypes.POINTER(ctypes.c_void_p),            # resp pointer-to-pointer
    ctypes.c_void_p,                            # appdata
)


def _make_pam_conv(password: bytes):
    """Build a PAM conversation struct that answers prompts with *password*.

    PAM will call free() on the response buffer and each resp string,
    so we must allocate them with libc calloc/strdup — NOT Python memory.
    """

    @_CONV_FUNC
    def _converse(num_msg, _msg_pp, resp_pp, _appdata):
        try:
            # Allocate num_msg pam_response structs with calloc (zero-filled)
            resp_array = _libc.calloc(num_msg, _RESP_STRUCT_SIZE)
            if not resp_array:
                return 1  # PAM_BUF_ERR

            for i in range(num_msg):
                # strdup the password so PAM can free() it later
                pwd_copy = _libc.strdup(password)
                if not pwd_copy:
                    _libc.free(resp_array)
                    return 1
                # Write the pointer into resp_array[i].resp  (first field)
                offset = i * _RESP_STRUCT_SIZE
                ctypes.memmove(resp_array + offset,
                               ctypes.byref(ctypes.c_void_p(pwd_copy)),
                               ctypes.sizeof(ctypes.c_void_p))
                # resp_retcode stays 0 (calloc zeroed it)

            # Hand the array to PAM
            resp_pp[0] = resp_array
            return 0  # PAM_SUCCESS
        except Exception:
            return 1

    conv_struct = _PamConv()
    conv_struct.conv = ctypes.cast(_converse, ctypes.c_void_p).value
    conv_struct.appdata_ptr = None
    return conv_struct, _converse          # keep _converse alive


def pam_authenticate(username: str, password: str) -> bool:
    """Authenticate a user against Linux PAM.

    Returns True if authentication succeeded.
    """
    if _libpam is None:
        _log.error("libpam not available, authentication cannot proceed")
        return False

    if not username or not password:
        return False

    username_b = username.encode("utf-8")
    password_b = password.encode("utf-8")

    # Set up libc function signatures
    _libc.calloc.restype = ctypes.c_void_p
    _libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
    _libc.strdup.restype = ctypes.c_void_p
    _libc.strdup.argtypes = [ctypes.c_char_p]
    _libc.free.restype = None
    _libc.free.argtypes = [ctypes.c_void_p]

    conv_struct, _keep_alive = _make_pam_conv(password_b)

    pam_handle = ctypes.c_void_p()
    retval = _libpam.pam_start(
        b"login",
        username_b,
        ctypes.byref(conv_struct),
        ctypes.byref(pam_handle),
    )
    if retval != PAM_SUCCESS:
        return False

    try:
        retval = _libpam.pam_authenticate(pam_handle, 0)
        if retval != PAM_SUCCESS:
            return False
        retval = _libpam.pam_acct_mgmt(pam_handle, 0)
        return retval == PAM_SUCCESS
    finally:
        _libpam.pam_end(pam_handle, retval)


# ── Signed cookie sessions ───────────────────────────────────────────────────

def _sign(payload: bytes) -> bytes:
    """Create HMAC-SHA256 signature."""
    return hmac.new(_COOKIE_SECRET, payload, hashlib.sha256).digest()


def _create_session_cookie(username: str) -> str:
    """Create a signed session cookie value."""
    data = json.dumps({
        "user": username,
        "exp": int(time.time()) + SESSION_MAX_AGE,
        "jti": secrets.token_hex(8),
    }).encode("utf-8")
    sig = _sign(data)
    import base64
    token = base64.urlsafe_b64encode(data + sig).decode("ascii")
    return token


def _verify_session_cookie(cookie: str) -> Optional[str]:
    """Verify and decode a session cookie. Returns username or None."""
    try:
        import base64
        raw = base64.urlsafe_b64decode(cookie.encode("ascii"))
        if len(raw) < 32:
            return None
        data = raw[:-32]
        sig = raw[-32:]
        expected = _sign(data)
        if not hmac.compare_digest(sig, expected):
            return None
        payload = json.loads(data.decode("utf-8"))
        if payload.get("exp", 0) < time.time():
            return None
        return payload.get("user")
    except Exception:
        return None


# ── Rate limiting ────────────────────────────────────────────────────────────

_rate_lock = threading.Lock()
_rate_buckets: Dict[str, list] = {}  # ip -> [timestamp, ...]


def _check_rate_limit(client_ip: str) -> bool:
    """Returns True if the request is allowed, False if rate-limited."""
    now = time.time()
    cutoff = now - LOGIN_RATE_WINDOW
    with _rate_lock:
        bucket = _rate_buckets.get(client_ip, [])
        bucket = [t for t in bucket if t > cutoff]
        if len(bucket) >= LOGIN_RATE_MAX:
            _rate_buckets[client_ip] = bucket
            return False
        bucket.append(now)
        _rate_buckets[client_ip] = bucket
        return True


def _record_attempt(client_ip: str) -> None:
    """Record a failed login attempt for rate limiting."""
    now = time.time()
    cutoff = now - LOGIN_RATE_WINDOW
    with _rate_lock:
        bucket = _rate_buckets.get(client_ip, [])
        bucket = [t for t in bucket if t > cutoff]
        bucket.append(now)
        _rate_buckets[client_ip] = bucket


# ── Authentication middleware ────────────────────────────────────────────────

# Paths that don't require authentication
_PUBLIC_PATHS = frozenset({
    "/login",
    "/api/auth/login",
    "/health",
})

_PUBLIC_PREFIXES = (
    "/static/",
)


def _is_public_path(path: str) -> bool:
    """Check if a path is publicly accessible without authentication."""
    if path in _PUBLIC_PATHS:
        return True
    for prefix in _PUBLIC_PREFIXES:
        if path.startswith(prefix):
            return True
    return False


def get_client_ip(request: Request) -> str:
    """Extract client IP from the direct connection (ignores X-Forwarded-For
    since the app is not behind a trusted reverse proxy)."""
    return request.client.host if request.client else "unknown"


class AuthMiddleware(BaseHTTPMiddleware):
    """Middleware that enforces PAM-based authentication on all routes."""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Allow public paths
        if _is_public_path(path):
            return await call_next(request)

        # Internal bypass: the in-process dashboard_connector passes our
        # per-process token from a 127.0.0.1 connection. This is how the
        # connector forwards dashboard-originated requests through to local
        # API handlers without inventing a parallel auth path.
        client_host = request.client.host if request.client else ""
        if client_host in ("127.0.0.1", "::1") and \
                request.headers.get(INTERNAL_BYPASS_HEADER) == INTERNAL_BYPASS_TOKEN:
            request.state.user = "_connector_"
            return await call_next(request)

        # Check session cookie
        cookie = request.cookies.get(AUTH_COOKIE_NAME)
        if cookie:
            username = _verify_session_cookie(cookie)
            if username:
                request.state.user = username
                return await call_next(request)

        # Not authenticated
        if path.startswith("/api/"):
            return JSONResponse(
                status_code=401,
                content={"detail": "Authentication required"},
            )

        # For page requests, redirect to login
        return RedirectResponse(url="/login", status_code=303)
