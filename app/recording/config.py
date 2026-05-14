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
TRIGGER_MAX_DURATION_SECONDS = int(os.getenv("RECORDING_TRIGGER_MAX_DURATION_SECONDS", "1800"))

_continuous_raw = os.getenv("RECORDING_CONTINUOUS_CAMERAS", "").strip()
CONTINUOUS_CAMERAS = [c.strip() for c in _continuous_raw.split(",") if c.strip()]
CONTINUOUS_CHUNK_SECONDS = int(os.getenv("RECORDING_CONTINUOUS_CHUNK_SECONDS", "3600"))

MEDIAMTX_RTSP_HOST = os.getenv("MEDIAMTX_RTSP_HOST", "mediamtx")
MEDIAMTX_RTSP_PORT = int(os.getenv("MEDIAMTX_RTSP_PORT", "8554"))
MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://mediamtx:9997")
MEDIAMTX_API_USER = os.getenv("MEDIAMTX_API_USER", "apiuser")
MEDIAMTX_API_PASS = os.getenv("MEDIAMTX_API_PASS", "apipass")

SUPERVISOR_POLL_SECONDS = 10
SEGMENT_RESTART_BACKOFF_SECONDS = 2.0
