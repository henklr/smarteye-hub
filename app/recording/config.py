"""Recording engine configuration: read environment variables once at import."""
from __future__ import annotations

import os
from pathlib import Path


NVME_BASE = Path(os.getenv("NVME_BASE", "/mnt/nvme/smarteye"))
BUFFER_DIR = NVME_BASE / "buffer"
CLIPS_DIR = NVME_BASE / "clips"
DB_PATH = NVME_BASE / "recordings.db"
LOCK_PATH = NVME_BASE / ".segmenter.lock"

SEGMENT_SECONDS = int(os.getenv("RECORDING_SEGMENT_SECONDS", "2"))
MAX_PREBUFFER_SECONDS = int(os.getenv("RECORDING_MAX_PREBUFFER_SECONDS", "600"))
BUFFER_MARGIN_SECONDS = int(os.getenv("RECORDING_BUFFER_MARGIN_SECONDS", "60"))
TRIGGER_MAX_DURATION_SECONDS = int(os.getenv("RECORDING_TRIGGER_MAX_DURATION_SECONDS", "1800"))

_continuous_raw = os.getenv("RECORDING_CONTINUOUS_CAMERAS", "").strip()
CONTINUOUS_CAMERAS = [c.strip() for c in _continuous_raw.split(",") if c.strip()]
CONTINUOUS_CHUNK_SECONDS = int(os.getenv("RECORDING_CONTINUOUS_CHUNK_SECONDS", "3600"))
CONTINUOUS_RETENTION_DAYS = int(os.getenv("RECORDING_CONTINUOUS_RETENTION_DAYS", "7"))

MEDIAMTX_RTSP_HOST = os.getenv("MEDIAMTX_RTSP_HOST", "mediamtx")
MEDIAMTX_RTSP_PORT = int(os.getenv("MEDIAMTX_RTSP_PORT", "8554"))
MEDIAMTX_API_URL = os.getenv("MEDIAMTX_API_URL", "http://mediamtx:9997")
MEDIAMTX_API_USER = os.getenv("MEDIAMTX_API_USER", "apiuser")
MEDIAMTX_API_PASS = os.getenv("MEDIAMTX_API_PASS", "apipass")

SUPERVISOR_POLL_SECONDS = 10
SEGMENT_RESTART_BACKOFF_SECONDS = 2.0
