"""Watchdog: auto-stops any active recording past its max_duration_seconds.

Also drives the continuous-recording loop: for each cam in CONTINUOUS_CAMERAS
without an open active recording, start a new chunk; when chunks hit
CONTINUOUS_CHUNK_SECONDS, the watchdog auto-stops them (which produces a
clip, then a fresh chunk is started on the next tick). A separate sweep
deletes continuous clips older than the retention window.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Optional

from .config import (
    CONTINUOUS_CAMERAS,
    CONTINUOUS_CHUNK_SECONDS,
    CONTINUOUS_RETENTION_DAYS,
)
from .db import db_connect
from .triggers import start_recording, stop_recording

log = logging.getLogger("recording.watchdog")

WATCHDOG_INTERVAL_SECONDS = 5
CONTINUOUS_KIND = "continuous"


class Watchdog:
    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._last_retention_sweep: float = 0.0

    async def start_async(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="recording.watchdog")

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
            "watchdog: starting (continuous_cameras=%s chunk=%ds retention=%dd)",
            CONTINUOUS_CAMERAS, CONTINUOUS_CHUNK_SECONDS, CONTINUOUS_RETENTION_DAYS,
        )
        while not self._stop.is_set():
            try:
                await asyncio.to_thread(self._tick)
            except Exception:
                log.exception("watchdog: tick error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=WATCHDOG_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass

    def _tick(self) -> None:
        now = int(time.time())
        self._stop_expired(now)
        self._ensure_continuous(now)
        if now - self._last_retention_sweep > 300:
            self._last_retention_sweep = float(now)
            self._sweep_continuous_retention(now)

    def _stop_expired(self, now: int) -> None:
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT event_id, camera, trigger_start_ts, max_duration_seconds "
                "FROM active_recordings"
            ).fetchall()
        for r in rows:
            elapsed = now - int(r["trigger_start_ts"])
            if elapsed >= int(r["max_duration_seconds"]):
                log.info(
                    "watchdog: auto-stop event_id=%s camera=%s elapsed=%ds",
                    r["event_id"], r["camera"], elapsed,
                )
                try:
                    stop_recording(event_id=r["event_id"])
                except Exception:
                    log.exception("watchdog: auto-stop failed for %s", r["event_id"])

    def _ensure_continuous(self, now: int) -> None:
        if not CONTINUOUS_CAMERAS:
            return
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT camera FROM active_recordings WHERE camera IN ("
                + ",".join("?" * len(CONTINUOUS_CAMERAS)) + ")",
                CONTINUOUS_CAMERAS,
            ).fetchall()
        running = {r["camera"] for r in rows}
        for cam in CONTINUOUS_CAMERAS:
            if cam in running:
                continue
            log.info("watchdog: starting continuous chunk for %s", cam)
            try:
                start_recording(
                    camera=cam,
                    pre_buffer_seconds=0,
                    max_duration_seconds=CONTINUOUS_CHUNK_SECONDS,
                    metadata={"_kind": "continuous"},
                )
            except Exception:
                log.exception("watchdog: failed to start continuous chunk for %s", cam)

    def _sweep_continuous_retention(self, now: int) -> None:
        if CONTINUOUS_RETENTION_DAYS <= 0:
            return
        cutoff = now - (CONTINUOUS_RETENTION_DAYS * 86400)
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT id, file_path, thumbnail_path FROM clips "
                "WHERE kind = ? AND ended_at < ?",
                (CONTINUOUS_KIND, cutoff),
            ).fetchall()
            for r in rows:
                for p in (r["file_path"], r["thumbnail_path"]):
                    if p:
                        try:
                            os.unlink(p)
                        except FileNotFoundError:
                            pass
                        except OSError as e:
                            log.warning("retention: unlink %s failed: %s", p, e)
                conn.execute("DELETE FROM clips WHERE id = ?", (r["id"],))
        if rows:
            log.info("retention: pruned %d continuous clips older than %dd",
                     len(rows), CONTINUOUS_RETENTION_DAYS)
