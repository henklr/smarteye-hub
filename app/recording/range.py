"""Range-aware file response: Chrome/Safari scrubbing needs HTTP 206 Partial Content.

starlette's FileResponse does not parse Range headers, so we implement the
classic chunked-streaming pattern. This is the only file-serving primitive
the clip endpoints need.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import AsyncGenerator, Optional, Tuple

from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
_CHUNK_SIZE = 1024 * 1024  # 1 MiB


def _parse_range(header: str, file_size: int) -> Optional[Tuple[int, int]]:
    """Return (start, end_inclusive) or None for unsatisfiable/malformed."""
    m = _RANGE_RE.match(header.strip())
    if not m:
        return None
    s_str, e_str = m.group(1), m.group(2)
    if s_str == "" and e_str == "":
        return None
    if s_str == "":
        # suffix-byte-range: last N bytes
        n = int(e_str)
        if n <= 0:
            return None
        start = max(0, file_size - n)
        end = file_size - 1
    else:
        start = int(s_str)
        end = int(e_str) if e_str else file_size - 1
        if start >= file_size or start > end:
            return None
        end = min(end, file_size - 1)
    return start, end


async def _stream_range(path: Path, start: int, end: int) -> AsyncGenerator[bytes, None]:
    remaining = end - start + 1
    with open(path, "rb") as fh:
        fh.seek(start)
        while remaining > 0:
            chunk = fh.read(min(_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def range_file_response(
    request: Request,
    path: Path,
    media_type: str,
    filename: Optional[str] = None,
) -> Response:
    """Serve a file with HTTP Range support. Returns 200 or 206 as appropriate."""
    if not path.exists() or not path.is_file():
        return Response(status_code=404, content="not found")
    stat = path.stat()
    size = stat.st_size

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": media_type,
        "Last-Modified": _http_date(stat.st_mtime),
        "ETag": f'"{stat.st_mtime_ns:x}-{size:x}"',
        "Cache-Control": "public, max-age=300",
    }
    if filename:
        headers["Content-Disposition"] = f'inline; filename="{filename}"'

    range_header = request.headers.get("range")
    if range_header:
        parsed = _parse_range(range_header, size)
        if parsed is None:
            return Response(
                status_code=416,
                headers={"Content-Range": f"bytes */{size}", **headers},
            )
        start, end = parsed
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        headers["Content-Length"] = str(end - start + 1)
        return StreamingResponse(
            _stream_range(path, start, end),
            status_code=206,
            headers=headers,
            media_type=media_type,
        )

    headers["Content-Length"] = str(size)
    return StreamingResponse(
        _stream_range(path, 0, size - 1),
        status_code=200,
        headers=headers,
        media_type=media_type,
    )


def _http_date(ts: float) -> str:
    import email.utils
    return email.utils.formatdate(ts, usegmt=True)
