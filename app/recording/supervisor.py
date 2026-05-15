"""Supervises one Segmenter per cam-* path discovered in MediaMTX.

The supervisor holds an exclusive flock on $NVME_BASE/.segmenter.lock so that
when two uvicorn processes (HTTP :80 + HTTPS :443) both start the engine, only
the lock-holder actually spawns ffmpeg segmenters. The loser still answers
HTTP requests and queries the same SQLite — it just doesn't own the recording
side.
"""
from __future__ import annotations

import asyncio
import base64
import fcntl
import json
import logging
import re
import urllib.error
import urllib.request
from typing import Optional, Set, TextIO

from .config import (
    LOCK_PATH,
    MEDIAMTX_API_PASS,
    MEDIAMTX_API_URL,
    MEDIAMTX_API_USER,
    STORAGE_MOUNT,
    SUPERVISOR_POLL_SECONDS,
    is_storage_mounted,
)
from .device_config import (
    continuous_cameras_from_devices,
    device_recording_urls,
)
from .flow_config import cameras_in_flows
from .janitor import Janitor
from .segmenter import Segmenter
from .watchdog import Watchdog

log = logging.getLogger("recording.supervisor")

_CAM_RE = re.compile(r"^cam-.+$")


class Supervisor:
    def __init__(self) -> None:
        self._segmenters: dict[str, Segmenter] = {}
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._lock_file: Optional[TextIO] = None
        self.is_leader: bool = False
        self._janitor: Optional[Janitor] = None
        self._watchdog: Optional[Watchdog] = None
        # camera path → max `before_seconds` requested by any enabled flow.
        # Re-read each poll. The janitor reads from here too.
        self.flow_cameras: dict[str, int] = {}

    def try_acquire_lock(self) -> bool:
        """Non-blocking flock attempt. Returns True iff we became the leader."""
        LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
        f = open(LOCK_PATH, "w")
        try:
            fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            f.close()
            return False
        self._lock_file = f
        self.is_leader = True
        return True

    def release_lock(self) -> None:
        if self._lock_file is not None:
            try:
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                self._lock_file.close()
            except Exception:
                pass
            self._lock_file = None
        self.is_leader = False

    async def start_async(self) -> None:
        if not self.is_leader:
            return
        self._stop.clear()
        self._janitor = Janitor()
        await self._janitor.start_async()
        self._watchdog = Watchdog()
        await self._watchdog.start_async()
        self._task = asyncio.create_task(self._run(), name="recording.supervisor")

    async def stop_async(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        if self._watchdog is not None:
            await self._watchdog.stop_async()
            self._watchdog = None
        if self._janitor is not None:
            await self._janitor.stop_async()
            self._janitor = None
        await asyncio.gather(
            *(s.stop() for s in self._segmenters.values()),
            return_exceptions=True,
        )
        self._segmenters.clear()
        self.release_lock()

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if not is_storage_mounted():
                    # Storage disappeared mid-run (manual umount, drive failure, ...).
                    # Drop every segmenter so we don't write into the container's
                    # overlay fs. The format/mount endpoint restarts the engine
                    # when the disk comes back.
                    if self._segmenters:
                        log.warning(
                            "supervisor: %s no longer mounted; stopping all segmenters",
                            STORAGE_MOUNT,
                        )
                        await self._reconcile(set())
                else:
                    desired = await asyncio.to_thread(self._discover_cameras)
                    await self._reconcile(desired)
            except Exception:
                log.exception("supervisor: reconcile error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=SUPERVISOR_POLL_SECONDS)
            except asyncio.TimeoutError:
                pass

    async def _reconcile(self, desired: Set[str]) -> None:
        current = set(self._segmenters)
        urls = device_recording_urls()  # {cam: recording_rtsp_url}
        for cam in desired - current:
            log.info("supervisor: starting segmenter for %s", cam)
            seg = Segmenter(cam, rtsp_url=urls.get(cam))
            self._segmenters[cam] = seg
            seg.start()
        # Push URL changes to existing segmenters so a fresh recording-profile
        # selection in device settings takes effect within ~one supervisor tick
        # without restarting the engine.
        for cam in current & desired:
            self._segmenters[cam].update_rtsp_url(urls.get(cam))
        gone = current - desired
        if gone:
            stops = []
            for cam in gone:
                log.info("supervisor: stopping segmenter for %s", cam)
                seg = self._segmenters.pop(cam)
                stops.append(seg.stop())
            await asyncio.gather(*stops, return_exceptions=True)

    def _discover_cameras(self) -> Set[str]:
        # Re-read flow + device config each poll so the segmenter set follows
        # user edits live (no engine restart needed).
        self.flow_cameras = cameras_in_flows()
        flow_cams = set(self.flow_cameras.keys())
        # Cameras flagged for 24/7 continuous recording in device settings.
        # These need a segmenter even when no flow records them.
        continuous_cams = continuous_cameras_from_devices()
        # Cameras with a resolved direct-from-camera recording URL. We can
        # record these without MediaMTX being involved — the segmenter
        # pulls straight from the camera using `recording_rtsp_url`.
        direct_urls = set(device_recording_urls().keys())

        url = f"{MEDIAMTX_API_URL}/v3/paths/list"
        auth = base64.b64encode(
            f"{MEDIAMTX_API_USER}:{MEDIAMTX_API_PASS}".encode("utf-8")
        ).decode("ascii")
        req = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})
        ready_cams: Set[str] = set()
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="ignore"))
            for item in data.get("items", []):
                name = item.get("name") or ""
                if _CAM_RE.match(name) and item.get("ready"):
                    ready_cams.add(name)
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
            log.warning("supervisor: mediamtx paths query failed: %s", e)
            # Fall through: a camera with a direct URL can still record
            # even if MediaMTX is unreachable.

        # A camera is recordable if EITHER MediaMTX has its live path ready
        # (legacy/preload path) OR we have a direct recording URL for it.
        # The old code required MediaMTX-ready, which silently dropped any
        # continuous-flagged camera whose live stream wasn't currently
        # being pulled by a viewer.
        available = ready_cams | direct_urls
        return available & (flow_cams | continuous_cams)

    def status(self) -> dict:
        return {
            "is_leader": self.is_leader,
            "cameras": sorted(self._segmenters.keys()),
            "restarts": {c: s.restarts for c, s in self._segmenters.items()},
        }
