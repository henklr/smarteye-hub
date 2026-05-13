"""Per-camera ffmpeg segmenter: stream-copy 2s mp4 fragments with auto-restart."""
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
from .paths import buffer_dir

log = logging.getLogger("recording.segmenter")


class Segmenter:
    """One ffmpeg subprocess per camera, pulled from MediaMTX, stream-copy only.

    The subprocess is restarted on exit (whatever the cause) after a short
    backoff, until `stop()` is awaited. ffmpeg stderr is forwarded line-by-line
    to the python logger so docker logs surfaces any encoder/network issues.
    """

    def __init__(self, camera: str):
        self.camera = camera
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._proc: Optional[asyncio.subprocess.Process] = None
        self.restarts = 0

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop.clear()
            self._task = asyncio.create_task(
                self._run(), name=f"segmenter:{self.camera}"
            )

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
        bdir = buffer_dir(self.camera)
        bdir.mkdir(parents=True, exist_ok=True)
        rtsp_url = f"rtsp://{MEDIAMTX_RTSP_HOST}:{MEDIAMTX_RTSP_PORT}/{self.camera}"
        pattern = str(bdir / "%Y%m%d_%H%M%S_%s.mp4")

        # -c copy: stream-copy, never re-encode (Pi 5 CPU budget would not survive otherwise).
        # -f segment with -segment_format mp4: writes self-contained fragmented mp4s
        #   sized by SEGMENT_SECONDS so clip assembly can pick exact range boundaries.
        # frag_keyframe + empty_moov + faststart: each segment is playable as soon as
        #   it's written, so the assembler doesn't need to wait for a finalization.
        # -map 0:v + -an: only the H.264 video track is written. Our cameras
        # advertise G.711 A-law audio, which the mp4 container cannot carry
        # without transcoding, and re-encoding is banned by spec. Dropping
        # audio is the safe default; if audio is needed later, switch the
        # segment format to .mkv/.ts (native G.711 support) or allow AAC
        # transcode (cheap on CPU).
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

        while not self._stop.is_set():
            attempt = self.restarts + 1
            log.info("segmenter[%s]: ffmpeg start attempt=%d", self.camera, attempt)
            try:
                self._proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT,
                )
            except Exception:
                log.exception("segmenter[%s]: spawn failed", self.camera)
                if await self._wait_or_stop(SEGMENT_RESTART_BACKOFF_SECONDS):
                    break
                self.restarts += 1
                continue

            drain_task = asyncio.create_task(
                self._drain_output(self._proc), name=f"drain:{self.camera}"
            )
            try:
                rc = await self._proc.wait()
            finally:
                drain_task.cancel()
                try:
                    await drain_task
                except (asyncio.CancelledError, Exception):
                    pass
            log.warning("segmenter[%s]: ffmpeg exited rc=%s", self.camera, rc)

            if self._stop.is_set():
                break
            self.restarts += 1
            if await self._wait_or_stop(SEGMENT_RESTART_BACKOFF_SECONDS):
                break

        log.info("segmenter[%s]: stopped (restarts=%d)", self.camera, self.restarts)

    async def _drain_output(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            log.info(
                "segmenter[%s]: %s",
                self.camera,
                line.decode(errors="ignore").rstrip(),
            )

    async def _wait_or_stop(self, seconds: float) -> bool:
        """Sleep `seconds` or return True early if stop was requested."""
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
            return True
        except asyncio.TimeoutError:
            return False
