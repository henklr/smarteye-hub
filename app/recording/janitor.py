"""Janitor: prunes buffer segments per-camera based on flow needs.

Runs every 30s on the leader process. Never touches $NVME_BASE/clips/.

For each camera the keep window is sized to (max `before_seconds` of any
enabled flow that records this camera) + BUFFER_MARGIN_SECONDS. Cameras
*not* used by any flow get every buffer segment deleted — including stale
files left behind by a previous configuration. A segment's epoch (parsed
from its filename) is its *start* time; a segment is deleted once its
*end* time (epoch + SEGMENT_SECONDS) is older than the keep window.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from typing import Dict, Optional

from .config import (
    BUFFER_DIR,
    BUFFER_MARGIN_SECONDS,
    MAX_PREBUFFER_SECONDS,
    SEGMENT_SECONDS,
)
from .flow_config import cameras_in_flows
from .paths import parse_segment_epoch

log = logging.getLogger("recording.janitor")

JANITOR_INTERVAL_SECONDS = 30


class Janitor:
    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

    async def start_async(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="recording.janitor")

    async def stop_async(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None

    async def _run(self) -> None:
        log.info(
            "janitor: starting (per-camera keep = max before_seconds + margin=%ds; "
            "cameras not in any flow are pruned to zero)",
            BUFFER_MARGIN_SECONDS,
        )
        while not self._stop.is_set():
            try:
                deleted, kept, dropped_cams = await asyncio.to_thread(self._sweep)
                if deleted or dropped_cams:
                    log.info(
                        "janitor: deleted=%d kept=%d dropped_cams=%d",
                        deleted, kept, dropped_cams,
                    )
            except Exception:
                log.exception("janitor: sweep error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=JANITOR_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass

    def _sweep(self) -> tuple[int, int, int]:
        now = int(time.time())
        flow_cams: Dict[str, int] = cameras_in_flows()
        # Per-camera cutoff: now - (before_seconds + margin). Clamp to the
        # global MAX_PREBUFFER_SECONDS so a misconfigured flow can't ask for
        # a buffer larger than the engine is willing to keep.
        cutoffs: Dict[str, int] = {}
        for cam, before in flow_cams.items():
            keep = min(MAX_PREBUFFER_SECONDS, max(0, int(before))) + BUFFER_MARGIN_SECONDS
            cutoffs[cam] = now - keep

        deleted = 0
        kept = 0
        dropped_cams = 0
        if not BUFFER_DIR.exists():
            return 0, 0, 0
        for cam_dir in BUFFER_DIR.iterdir():
            if not cam_dir.is_dir():
                continue
            cam = cam_dir.name
            if cam not in cutoffs:
                # Camera no longer referenced by any enabled flow → wipe all
                # buffer segments. The segmenter has already been stopped by
                # the supervisor's reconcile loop.
                try:
                    for entry in cam_dir.iterdir():
                        if entry.is_file():
                            try:
                                os.unlink(entry)
                                deleted += 1
                            except FileNotFoundError:
                                pass
                            except OSError as e:
                                log.warning("janitor: unlink %s failed: %s", entry, e)
                    # Try to remove the now-empty directory too.
                    try:
                        cam_dir.rmdir()
                        dropped_cams += 1
                    except OSError:
                        pass
                except FileNotFoundError:
                    pass
                continue

            cutoff = cutoffs[cam]
            try:
                entries = list(cam_dir.iterdir())
            except FileNotFoundError:
                continue
            for entry in entries:
                if not entry.is_file():
                    continue
                start_epoch = parse_segment_epoch(entry.name)
                if start_epoch is None:
                    continue
                end_epoch = start_epoch + SEGMENT_SECONDS
                if end_epoch < cutoff:
                    try:
                        os.unlink(entry)
                        deleted += 1
                    except FileNotFoundError:
                        pass
                    except OSError as e:
                        log.warning("janitor: unlink %s failed: %s", entry, e)
                else:
                    kept += 1
        return deleted, kept, dropped_cams
