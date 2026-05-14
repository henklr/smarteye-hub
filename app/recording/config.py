"""Recording engine configuration: read environment variables once at import."""
from __future__ import annotations

import json
import os
import os.path
from pathlib import Path


NVME_BASE = Path(os.getenv("NVME_BASE", "/mnt/nvme/smarteye"))
BUFFER_DIR = NVME_BASE / "buffer"
CLIPS_DIR = NVME_BASE / "clips"
DB_PATH = NVME_BASE / "recordings.db"
LOCK_PATH = NVME_BASE / ".segmenter.lock"

# Path of the runtime settings file written by main.py. Read each sweep so a
# UI change takes effect on the next watchdog tick — no engine restart needed.
SETTINGS_JSON_PATH = Path(os.getenv("DATA_DIR", "/app/data")) / "settings.json"


def retention_days_setting() -> int:
    """Days to keep clips before automatic deletion.

    Returns 0 when retention is disabled — in that case the watchdog falls
    back to disk-fullness-based pruning (delete oldest when the drive is
    nearly full). Always re-read from disk so the UI's PUT takes effect on
    the next sweep without an engine restart.
    """
    try:
        raw = json.loads(SETTINGS_JSON_PATH.read_text(encoding="utf-8")).get("retention_days")
    except Exception:
        return 0
    try:
        return max(0, int(raw or 0))
    except (TypeError, ValueError):
        return 0


# Disk-full pruning thresholds when retention is disabled. Tuned so we leave
# enough room for a couple of GB of new recordings between sweeps before
# the next prune cycle has to run.
DISK_FULL_TRIGGER_FREE_PCT = 0.05  # start pruning when free space drops below 5%
DISK_FULL_TARGET_FREE_PCT = 0.10   # stop pruning once back above 10%

# Recordings live under NVME_BASE (.../smarteye). The parent (e.g. /mnt/nvme)
# is the actual filesystem mount we expect. If it isn't a real mount point we
# refuse to record: writing would fall through to the container's overlay fs
# (i.e. the SD card), which is small and ephemeral.
STORAGE_MOUNT = NVME_BASE.parent


def is_storage_mounted() -> bool:
    """True iff STORAGE_MOUNT is a real filesystem mount point."""
    try:
        return os.path.ismount(str(STORAGE_MOUNT))
    except OSError:
        return False

SEGMENT_SECONDS = int(os.getenv("RECORDING_SEGMENT_SECONDS", "2"))
MAX_PREBUFFER_SECONDS = int(os.getenv("RECORDING_MAX_PREBUFFER_SECONDS", "600"))
BUFFER_MARGIN_SECONDS = int(os.getenv("RECORDING_BUFFER_MARGIN_SECONDS", "60"))
# Env-var fallback for the trigger cap. The authoritative value lives in
# settings.json (see `trigger_max_duration_setting`), so admins can tune it
# from the UI without redeploying. This value applies only when the setting
# is absent or invalid.
TRIGGER_MAX_DURATION_SECONDS = int(os.getenv("RECORDING_TRIGGER_MAX_DURATION_SECONDS", "1800"))
# Hard ceiling on the UI-configurable cap, just to keep an admin from
# accidentally setting it to MAX_INT and disabling the safety net entirely.
TRIGGER_MAX_DURATION_HARD_CEILING = 24 * 3600  # 24 hours


def trigger_max_duration_setting() -> int:
    """Effective max duration (seconds) for a single triggered recording.

    UI-configurable via settings.json's `trigger_max_duration_seconds`. Falls
    back to the env-var default if unset/invalid. Re-read on every call so
    a UI change takes effect on the next clamp without an engine restart.
    """
    try:
        raw = json.loads(SETTINGS_JSON_PATH.read_text(encoding="utf-8")).get(
            "trigger_max_duration_seconds"
        )
    except Exception:
        raw = None
    try:
        if raw is None or raw == "":
            return TRIGGER_MAX_DURATION_SECONDS
        v = int(raw)
    except (TypeError, ValueError):
        return TRIGGER_MAX_DURATION_SECONDS
    if v < 1:
        return TRIGGER_MAX_DURATION_SECONDS
    return min(v, TRIGGER_MAX_DURATION_HARD_CEILING)

# Each continuous chunk rolls over after this many seconds and becomes a
# finalized clip. Shorter = more clips/DB rows but quicker visual feedback
# ("yes, the camera is recording"); longer = bigger files / fewer rows but
# you wait the full chunk length to see the first clip.
CONTINUOUS_CHUNK_SECONDS = int(os.getenv("RECORDING_CONTINUOUS_CHUNK_SECONDS", "300"))

MEDIAMTX_RTSP_HOST = os.getenv("MEDIAMTX_RTSP_HOST", "mediamtx")
MEDIAMTX_RTSP_PORT = int(os.getenv("MEDIAMTX_RTSP_PORT", "8554"))
MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://mediamtx:9997")
MEDIAMTX_API_USER = os.getenv("MEDIAMTX_API_USER", "apiuser")
MEDIAMTX_API_PASS = os.getenv("MEDIAMTX_API_PASS", "apipass")

SUPERVISOR_POLL_SECONDS = 10
SEGMENT_RESTART_BACKOFF_SECONDS = 2.0
