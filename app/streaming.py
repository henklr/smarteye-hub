from __future__ import annotations
from typing import Generator, Optional
import time

import cv2
from fastapi import HTTPException
from starlette.responses import StreamingResponse

from .config import settings


def mjpeg_stream(rtsp_uri: str) -> Generator[bytes, None, None]:
    cap = cv2.VideoCapture(rtsp_uri)
    if not cap.isOpened():
        raise HTTPException(status_code=502, detail="Failed to open RTSP stream")

    frame_interval = 1.0 / max(1, settings.mjpeg_fps)

    try:
        while True:
            start = time.time()
            ok, frame = cap.read()
            if not ok or frame is None:
                # brief backoff; some cameras jitter
                time.sleep(0.2)
                continue

            encode_params = [int(cv2.IMWRITE_JPEG_QUALITY), int(settings.mjpeg_jpeg_quality)]
            ok2, jpg = cv2.imencode(".jpg", frame, encode_params)
            if not ok2:
                continue

            chunk = jpg.tobytes()
            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: " + str(len(chunk)).encode() + b"\r\n\r\n" +
                chunk + b"\r\n"
            )

            elapsed = time.time() - start
            sleep_for = frame_interval - elapsed
            if sleep_for > 0:
                time.sleep(sleep_for)
    finally:
        cap.release()


def mjpeg_response(rtsp_uri: str) -> StreamingResponse:
    return StreamingResponse(
        mjpeg_stream(rtsp_uri),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )
