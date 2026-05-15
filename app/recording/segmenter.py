"""Per-(camera, variant) ffmpeg segmenter: stream-copy 2s mp4 fragments with auto-restart."""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

from .config import (
    MEDIAMTX_RTSP_HOST,
    MEDIAMTX_RTSP_PORT,
    SEGMENT_RESTART_BACKOFF_SECONDS,
    SEGMENT_SECONDS,
)
from .paths import VARIANT_HD, buffer_dir

log = logging.getLogger("recording.segmenter")


class Segmenter:
    """One ffmpeg subprocess per (camera, variant). Stream-copy only.

    A camera can have one or two segmenters running in parallel — one
    pulling the main RTSP profile ("hd") and one pulling the substream
    ("sd"). They write to separate buffer subdirs so segments don't collide.

    The subprocess is restarted on exit (whatever the cause) after a short
    backoff, until `stop()` is awaited. ffmpeg stderr is forwarded line-by-line
    to the python logger so docker logs surfaces any encoder/network issues.
    """

    def __init__(
        self,
        camera: str,
        rtsp_url: Optional[str] = None,
        variant: str = VARIANT_HD,
    ):
        self.camera = camera
        self.variant = variant
        # Per-device RTSP URL (with embedded creds) resolved at device-edit
        # time. When None we fall back to MediaMTX's `cam-<id>` path —
        # which serves whatever the *live* (SD) profile is. That fallback
        # only makes sense for the SD variant; an HD segmenter without an
        # override URL would silently record the SD substream instead.
        self._rtsp_url_override = rtsp_url
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._proc: Optional[asyncio.subprocess.Process] = None
        self.restarts = 0

    def _label(self) -> str:
        return f"{self.camera}/{self.variant}"

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop.clear()
            self._task = asyncio.create_task(
                self._run(), name=f"segmenter:{self._label()}"
            )

    def update_rtsp_url(self, url: Optional[str]) -> None:
        """Swap the RTSP URL the segmenter pulls from.

        Called by the supervisor when devices.json changes (user picked a
        different profile for this variant). If the URL actually changed we
        kill the running ffmpeg so the supervisor's restart loop picks up
        the new URL on the next iteration — no engine restart required.
        """
        if url == self._rtsp_url_override:
            return
        log.info("segmenter[%s]: rtsp url changed; restarting ffmpeg", self._label())
        self._rtsp_url_override = url
        proc = self._proc
        if proc and proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass

    async def stop(self) -> None:
        self._stop.set()
        proc = self._proc
        if proc and proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2)
                except asyncio.TimeoutError:
                    pass
        if self._task:
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    async def _run(self) -> None:
        bdir = buffer_dir(self.camera, self.variant)
        bdir.mkdir(parents=True, exist_ok=True)
        pattern = str(bdir / "%Y%m%d_%H%M%S_%s.mp4")

        while not self._stop.is_set():
            attempt = self.restarts + 1
            # Resolve the source URL on every (re)spawn so a config-driven
            # URL change picks up the new value as soon as ffmpeg restarts.
            # The override is the camera's per-variant profile RTSP (set
            # by main.py from the user-picked profile); without it we
            # fall back to the MediaMTX `cam-<id>` path which serves the
            # live profile — same as the legacy behaviour, which works for
            # the SD variant since the live profile *is* the SD substream.
            rtsp_url = self._rtsp_url_override or (
                f"rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}/{self.camera}"
            )
            cmd = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel", "warning",
                "-rtsp_transport", "tcp",
                "-i", rtsp_url,
                "-map", "0:v:0",
                "-an",
                "-c:v", "copy",
                "-f", "segment",
                "-segment_time", str(SEGMENT_SECONDS),
                "-reset_timestamps", "1",
                "-strftime", "1",
                "-segment_format", "mp4",
                "-movflags", "+faststart+frag_keyframe+empty_moov",
                pattern,
            ]
            log.info("segmenter[%s]: ffmpeg start attempt=%d", self._label(), attempt)
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
            except Exception:
                log.exception("segmenter[%s]: spawn failed", self._label())
                if await self._wait_or_stop(SEGMENT_RESTART_BACKOFF_SECONDS):
                    break
                self.restarts += 1
                continue

            drain_task = asyncio.create_task(
                self._drain_output(self._proc), name=f"drain:{self._label()}"
            )
            try:
                rc = await self._proc.wait()
            finally:
                drain_task.cancel()
                try:
                    await drain_task
                except (asyncio.CancelledError, Exception):
                    pass
            log.warning("segmenter[%s]: ffmpeg exited rc=%s", self._label(), rc)

            if self._stop.is_set():
                break
            self.restarts += 1
            if await self._wait_or_stop(SEGMENT_RESTART_BACKOFF_SECONDS):
                break

        log.info("segmenter[%s]: stopped (restarts=%d)", self._label(), self.restarts)

    async def _drain_output(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            log.info(
                "segmenter[%s]: %s",
                self._label(),
                line.decode(errors="ignore").rstrip(),
            )

    async def _wait_or_stop(self, seconds: float) -> bool:
        """Sleep `seconds` or return True early if stop was requested."""
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
            return True
        except asyncio.TimeoutError:
            return False
