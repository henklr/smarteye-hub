"""Buffer/clip path helpers and segment filename parsing."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from .config import BUFFER_DIR, CLIPS_DIR

# Segment filename pattern: 20260512_193045_1715541045.mp4
# (local YMD_HMS for human inspection, then epoch seconds which we parse for range queries)
_SEGMENT_RE = re.compile(r"^(\d{8})_(\d{6})_(\d+)\.mp4$")


def buffer_dir(camera: str) -> Path:
    return BUFFER_DIR / camera


def clip_path(camera: str, year: int, month: int, day: int, event_id: str) -> Path:
    return CLIPS_DIR / camera / f"{year:04d}" / f"{month:02d}" / f"{day:02d}" / f"{event_id}.mp4"


def thumbnail_path_for_clip(clip_file: Path) -> Path:
    return clip_file.with_suffix(".jpg")


def parse_segment_epoch(name: str) -> Optional[int]:
    """Parse epoch seconds from a segment filename. Returns None for non-matches."""
    m = _SEGMENT_RE.match(name)
    if not m:
        return None
    try:
        return int(m.group(3))
    except ValueError:
        return None
