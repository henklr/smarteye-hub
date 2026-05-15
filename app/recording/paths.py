"""Buffer/clip path helpers and segment filename parsing.

Each camera now has up to TWO parallel segmenter pipelines — `hd` (main RTSP
profile) and `sd` (substream RTSP profile). The buffer directory grows a
variant subdirectory so segments from the two pipelines don't collide.

Clip file layout on disk:
    <cam>/<Y>/<M>/<D>/<event>.mp4       — primary clip (HD when both
                                          variants recorded; otherwise
                                          whatever single variant ran)
    <cam>/<Y>/<M>/<D>/<event>.sd.mp4    — SD sibling (only when both
                                          variants recorded)
    <cam>/<Y>/<M>/<D>/<event>.jpg       — thumbnail (extracted from primary)

Backward compat: existing clips were recorded HD-only and live at the
primary `.mp4` path. The playback API serves them as HD; `?q=sd` falls
back to the primary when no `.sd.mp4` sibling exists.

NOTE: the older "low-bitrate transcode" feature wrote a `.low.mp4` sibling
populated by a CPU-burning ffmpeg pass. That code path is gone — SD now
comes straight from the camera's substream. Any leftover `.low.mp4` files
are sweep-able as orphans (the retention loop cleans them up when the
parent clip is deleted).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from .config import BUFFER_DIR, CLIPS_DIR

VARIANT_HD = "hd"
VARIANT_SD = "sd"
ALL_VARIANTS = (VARIANT_HD, VARIANT_SD)

# Segment filename pattern: 20260512_193045_1715541045.mp4
# (local YMD_HMS for human inspection, then epoch seconds which we parse for range queries)
_SEGMENT_RE = re.compile(r"^(\d{8})_(\d{6})_(\d+)\.mp4$")


def buffer_dir(camera: str, variant: str = VARIANT_HD) -> Path:
    """Per-(camera, variant) buffer directory.

    The variant subdir keeps HD and SD segments from colliding when both
    pipelines run in parallel for the same camera. Callers that don't pass
    a variant get HD — that matches the legacy single-pipeline layout, so
    code paths that haven't been variant-aware yet stay correct for HD.
    """
    return BUFFER_DIR / camera / variant


def buffer_dir_root(camera: str) -> Path:
    """Camera-level buffer root (parent of the variant subdirs).

    Used by the janitor when walking the whole buffer tree.
    """
    return BUFFER_DIR / camera


def clip_path(
    camera: str,
    year: int,
    month: int,
    day: int,
    event_id: str,
    variant: str = VARIANT_HD,
    is_primary: bool = True,
) -> Path:
    """Filesystem path for a clip file.

    `is_primary=True` always lives at `<event>.mp4` regardless of variant
    — that's the path stored in the `clips.file_path` column, and the path
    the thumbnail sits next to. The secondary variant (only present when
    both HD and SD are recorded for the camera) gets a `.sd` suffix.
    """
    base = CLIPS_DIR / camera / f"{year:04d}" / f"{month:02d}" / f"{day:02d}"
    if is_primary:
        return base / f"{event_id}.mp4"
    # Only the SD variant can be a non-primary sibling (HD is always primary
    # when both variants are recorded).
    return base / f"{event_id}.{variant}.mp4"


def sd_sibling_path(primary: Path) -> Path:
    """Return the `<event>.sd.mp4` sibling next to a primary clip file."""
    return primary.with_name(primary.stem + ".sd.mp4")


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
