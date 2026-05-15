"""Watchdog: auto-stops any active recording past its max_duration_seconds.

Also drives the continuous-recording loop: for each camera flagged with
`continuous_recording=true` in devices.json that doesn't already have an
open active recording, start a new chunk; when chunks hit
CONTINUOUS_CHUNK_SECONDS, the watchdog auto-stops them (which produces a
clip, then a fresh chunk is started on the next tick).

A retention sweep runs periodically. Two modes, switched by the
`retention_days` setting (read each tick from settings.json):

- `retention_days > 0`: delete clips whose `ended_at` is older than the
  cutoff. Applies to every clip kind.
- `retention_days == 0` (default): disk-fullness sweep. When free space
  drops below DISK_FULL_TRIGGER_FREE_PCT, delete the oldest clips until
  we're back above DISK_FULL_TARGET_FREE_PCT.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from typing import Optional

from .config import (
    CONTINUOUS_CHUNK_SECONDS,
    DISK_FULL_TARGET_FREE_PCT,
    DISK_FULL_TRIGGER_FREE_PCT,
    STORAGE_MOUNT,
    is_storage_mounted,
    retention_days_setting,
)
from .db import db_connect
from .device_config import continuous_cameras_from_devices
from .triggers import start_recording, stop_recording

log = logging.getLogger("recording.watchdog")

WATCHDOG_INTERVAL_SECONDS = 5
CONTINUOUS_KIND = "continuous"
RETENTION_SWEEP_INTERVAL_SECONDS = 60


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
            "watchdog: starting (chunk=%ds retention=%dd, 0=disk-full; "
            "continuous cameras read live from devices.json)",
            CONTINUOUS_CHUNK_SECONDS, retention_days_setting(),
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
        if now - self._last_retention_sweep >= RETENTION_SWEEP_INTERVAL_SECONDS:
            self._last_retention_sweep = float(now)
            try:
                self._sweep_retention(now)
            except Exception:
                log.exception("watchdog: retention sweep failed")

    def _stop_expired(self, now: int) -> None:
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT event_id, camera, trigger_start_ts, max_duration_seconds, metadata_json "
                "FROM active_recordings"
            ).fetchall()
        continuous_cams = continuous_cameras_from_devices()
        for r in rows:
            elapsed = now - int(r["trigger_start_ts"])
            if elapsed < int(r["max_duration_seconds"]):
                continue
            log.info(
                "watchdog: auto-stop event_id=%s camera=%s elapsed=%ds",
                r["event_id"], r["camera"], elapsed,
            )
            # If this is a continuous chunk for a still-flagged camera,
            # pre-start the next chunk BEFORE stopping the current one.
            # `stop_recording` runs `assemble_clip` synchronously (ffmpeg
            # concat over ~5 min of segments takes 20-60 s); without
            # pre-starting, the next chunk's trigger_start_ts lands at
            # `now + assembly_seconds`, leaving a visible gap on the
            # timeline. With pre-start the chunks overlap by exactly the
            # assembly duration and the strip stays unbroken.
            kind = None
            try:
                meta = json.loads(r["metadata_json"] or "{}")
                kind = str(meta.get("_kind") or "")
            except (json.JSONDecodeError, TypeError):
                pass
            if kind == "continuous" and r["camera"] in continuous_cams:
                try:
                    start_recording(
                        camera=r["camera"],
                        pre_buffer_seconds=0,
                        max_duration_seconds=CONTINUOUS_CHUNK_SECONDS,
                        metadata={"_kind": "continuous"},
                    )
                except Exception:
                    log.exception(
                        "watchdog: pre-start next continuous chunk failed for %s",
                        r["camera"],
                    )
            try:
                stop_recording(event_id=r["event_id"])
            except Exception:
                log.exception("watchdog: auto-stop failed for %s", r["event_id"])

    def _ensure_continuous(self, now: int) -> None:
        cams = sorted(continuous_cameras_from_devices())
        if not cams:
            return
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT camera FROM active_recordings WHERE camera IN ("
                + ",".join("?" * len(cams)) + ")",
                cams,
            ).fetchall()
        running = {r["camera"] for r in rows}
        for cam in cams:
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

    def _sweep_retention(self, now: int) -> None:
        """Either time-based or disk-fullness-based clip pruning."""
        if not is_storage_mounted():
            # Nothing to prune if the disk vanished; supervisor handles that path.
            return
        days = retention_days_setting()
        if days > 0:
            self._prune_time_based(now, days)
        else:
            self._prune_disk_full()

    def _prune_time_based(self, now: int, days: int) -> None:
        cutoff = now - (days * 86400)
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT id, file_path, thumbnail_path FROM clips WHERE ended_at < ?",
                (cutoff,),
            ).fetchall()
            for r in rows:
                _unlink_clip_files(r["file_path"], r["thumbnail_path"])
                conn.execute("DELETE FROM clips WHERE id = ?", (r["id"],))
        if rows:
            log.info("retention: pruned %d clips older than %dd", len(rows), days)

    def _prune_disk_full(self) -> None:
        try:
            usage = shutil.disk_usage(str(STORAGE_MOUNT))
        except OSError as e:
            log.warning("retention: disk_usage(%s) failed: %s", STORAGE_MOUNT, e)
            return
        total = max(usage.total, 1)
        free_pct = usage.free / total
        if free_pct >= DISK_FULL_TRIGGER_FREE_PCT:
            return
        log.warning(
            "retention: free space %.1f%% below trigger %.0f%%; pruning oldest clips",
            free_pct * 100, DISK_FULL_TRIGGER_FREE_PCT * 100,
        )
        deleted = 0
        # Walk oldest → newest. Re-check disk usage after every delete so we
        # stop as soon as we're back above the target.
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT id, file_path, thumbnail_path FROM clips ORDER BY started_at ASC"
            ).fetchall()
            for r in rows:
                try:
                    usage = shutil.disk_usage(str(STORAGE_MOUNT))
                except OSError:
                    break
                if usage.free / total >= DISK_FULL_TARGET_FREE_PCT:
                    break
                _unlink_clip_files(r["file_path"], r["thumbnail_path"])
                conn.execute("DELETE FROM clips WHERE id = ?", (r["id"],))
                deleted += 1
        if deleted:
            log.warning("retention: pruned %d oldest clips to free disk space", deleted)
        else:
            log.warning("retention: no clips left to prune but disk still under target")


def _unlink_clip_files(file_path: Optional[str], thumbnail_path: Optional[str]) -> None:
    for p in (file_path, thumbnail_path):
        if not p:
            continue
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass
        except OSError as e:
            log.warning("retention: unlink %s failed: %s", p, e)
    # Also remove the cached low-quality variant (built lazily by
    # /api/clips/{id}/video?q=low) if present, so retention sweeps don't
    # leave orphaned `.low.mp4` files behind.
    if file_path:
        from pathlib import Path as _Path
        orig = _Path(file_path)
        low = orig.with_name(orig.stem + ".low.mp4")
        try:
            low.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            log.warning("retention: unlink low variant %s failed: %s", low, e)
