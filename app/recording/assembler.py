"""Clip assembler: stream-copy concat of buffer segments + thumbnail extract."""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

from .config import SEGMENT_SECONDS
from .paths import VARIANT_HD, buffer_dir, parse_segment_epoch, thumbnail_path_for_clip

log = logging.getLogger("recording.assembler")


@dataclass
class AssembledClip:
    file_path: Path
    thumbnail_path: Optional[Path]
    started_at: int
    ended_at: int
    duration_seconds: int
    file_size_bytes: int
    segments_used: int
    gaps: List[Tuple[int, int]]  # list of (gap_start_epoch, gap_end_epoch) between consecutive segments


def _list_range_segments(
    camera: str, start_ts: int, end_ts: int, variant: str = VARIANT_HD,
) -> List[Tuple[int, Path]]:
    """Return [(epoch, path), ...] sorted by epoch, for segments that overlap the range.

    A segment whose START epoch is in [start_ts - SEGMENT_SECONDS, end_ts] is
    considered relevant; we include the segment that *starts before* start_ts
    so the resulting clip covers the requested t=0 frame.
    """
    bdir = buffer_dir(camera, variant)
    if not bdir.exists():
        return []
    lower = start_ts - SEGMENT_SECONDS
    upper = end_ts
    segs: List[Tuple[int, Path]] = []
    for entry in bdir.iterdir():
        if not entry.is_file():
            continue
        epoch = parse_segment_epoch(entry.name)
        if epoch is None:
            continue
        if lower <= epoch <= upper:
            segs.append((epoch, entry))
    segs.sort(key=lambda t: t[0])
    return segs


def _find_gaps(segments: List[Tuple[int, Path]]) -> List[Tuple[int, int]]:
    """A gap is any inter-segment delta longer than 1.5x the segment size."""
    if not segments:
        return []
    threshold = int(SEGMENT_SECONDS * 1.5)
    gaps: List[Tuple[int, int]] = []
    for i in range(1, len(segments)):
        prev_epoch = segments[i - 1][0]
        cur_epoch = segments[i][0]
        delta = cur_epoch - prev_epoch
        if delta > threshold:
            gaps.append((prev_epoch + SEGMENT_SECONDS, cur_epoch))
    return gaps


def assemble_clip(
    *,
    camera: str,
    start_ts: int,
    end_ts: int,
    output_path: Path,
    variant: str = VARIANT_HD,
    make_thumbnail: bool = True,
) -> AssembledClip:
    """Assemble [start_ts, end_ts] from buffer segments into a single MP4.

    Pure stream-copy via ffmpeg concat demuxer. Any missing segments produce
    logged gaps but never trigger re-encoding. If no segments are available,
    raises FileNotFoundError.

    `variant` picks the buffer subdir (hd vs sd). `make_thumbnail` is False
    for the secondary SD sibling — only the primary clip needs a thumbnail.
    """
    segs = _list_range_segments(camera, start_ts, end_ts, variant=variant)
    if not segs:
        raise FileNotFoundError(f"no {variant} buffer segments for {camera} in [{start_ts}, {end_ts}]")

    gaps = _find_gaps(segs)
    if gaps:
        log.warning(
            "assembler[%s]: %d gap(s) in range [%d, %d]: %s",
            camera, len(gaps), start_ts, end_ts, gaps,
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as fh:
        list_path = Path(fh.name)
        for _epoch, seg in segs:
            # ffmpeg concat list syntax: escape single quotes by closing/opening
            fh.write(f"file '{str(seg).replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n")

    try:
        # `-avoid_negative_ts make_zero` and `-fflags +genpts` clean up
        # the duplicate-DTS hiccups that the concat demuxer produces at
        # segment boundaries. The buffer segments are written with
        # `-reset_timestamps 1`, so each one starts at PTS=0; the
        # concat demuxer chains them by offsetting subsequent segments
        # by the previous one's duration, which occasionally produces
        # two frames on the same DTS at the boundary. ffmpeg's null
        # muxer just logs a warning, but Chrome's H.264 decoder stalls
        # for ~1 s when it hits that mid-stream — felt as a "playback
        # pause" at a specific timestamp on the browser side.
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-y",
            "-fflags", "+genpts",
            "-avoid_negative_ts", "make_zero",
            "-f", "concat",
            "-safe", "0",
            "-i", str(list_path),
            "-c", "copy",
            "-movflags", "+faststart",
            str(output_path),
        ]
        log.info(
            "assembler[%s]: concat %d segs → %s",
            camera, len(segs), output_path.name,
        )
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            log.error(
                "assembler[%s]: ffmpeg concat rc=%d stderr=%s",
                camera, result.returncode, result.stderr.strip()[:500],
            )
            raise RuntimeError(f"ffmpeg concat failed (rc={result.returncode})")
    finally:
        try:
            os.unlink(list_path)
        except OSError:
            pass

    file_size = output_path.stat().st_size
    duration = max(1, end_ts - start_ts)

    thumb_path = _make_thumbnail(output_path) if make_thumbnail else None

    return AssembledClip(
        file_path=output_path,
        thumbnail_path=thumb_path,
        started_at=start_ts,
        ended_at=end_ts,
        duration_seconds=duration,
        file_size_bytes=file_size,
        segments_used=len(segs),
        gaps=gaps,
    )


def _make_thumbnail(clip_path: Path) -> Optional[Path]:
    """Single-frame decode at t=1s. Pure libavcodec, ~negligible CPU."""
    thumb = thumbnail_path_for_clip(clip_path)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-ss", "1",
        "-i", str(clip_path),
        "-frames:v", "1",
        "-q:v", "5",
        str(thumb),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0 or not thumb.exists() or thumb.stat().st_size == 0:
        log.warning(
            "assembler: thumbnail failed for %s (rc=%d) stderr=%s",
            clip_path.name, result.returncode, result.stderr.strip()[:200],
        )
        return None
    return thumb
