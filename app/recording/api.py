"""FastAPI router for /api/record/* and /api/clips/*."""
from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .db import db_connect
from .range import range_file_response
from .triggers import list_active, start_recording, stop_recording

log = logging.getLogger("recording.api")

router = APIRouter()


class StartBody(BaseModel):
    camera: str
    event_id: Optional[str] = None
    pre_buffer_seconds: int = Field(0, ge=0, le=3600)
    max_duration_seconds: Optional[int] = Field(None, ge=0)
    metadata: Optional[Dict[str, Any]] = None


class StopBody(BaseModel):
    event_id: str
    metadata: Optional[Dict[str, Any]] = None


@router.post("/api/record/start")
def post_record_start(body: StartBody) -> Dict[str, Any]:
    return start_recording(
        camera=body.camera,
        event_id=body.event_id,
        pre_buffer_seconds=body.pre_buffer_seconds,
        max_duration_seconds=body.max_duration_seconds,
        metadata=body.metadata,
    )


@router.post("/api/record/stop")
def post_record_stop(body: StopBody) -> Dict[str, Any]:
    result = stop_recording(event_id=body.event_id, metadata=body.metadata)
    if result is None:
        raise HTTPException(status_code=404, detail=f"no active recording with event_id={body.event_id}")
    return result


@router.get("/api/record/active")
def get_active(camera: Optional[str] = None) -> Dict[str, Any]:
    """Currently-open recordings, with metadata parsed + kind/started_at
    surfaced so the timeline can render in-progress strips alongside
    finalised `/api/clips`.
    """
    rows = list_active(camera=camera)
    items: List[Dict[str, Any]] = []
    for r in rows:
        meta: Dict[str, Any] = {}
        raw_meta = r.get("metadata_json")
        if raw_meta:
            try:
                meta = json.loads(raw_meta)
            except (json.JSONDecodeError, TypeError):
                meta = {}
        kind = str(meta.get("_kind") or "triggered")
        trigger_start = int(r.get("trigger_start_ts") or 0)
        pre_buffer = int(r.get("pre_buffer_seconds") or 0)
        items.append({
            "event_id": r.get("event_id"),
            "camera": r.get("camera"),
            "kind": kind,
            "started_at": trigger_start - pre_buffer,
            "trigger_start_ts": trigger_start,
            "pre_buffer_seconds": pre_buffer,
            "max_duration_seconds": int(r.get("max_duration_seconds") or 0),
            "metadata": meta,
        })
    return {"items": items}


# ---------------------------------------------------------------------------
# Clip listing / metadata / video / thumbnail / delete
# ---------------------------------------------------------------------------


def _clip_row_to_dict(row) -> Dict[str, Any]:
    meta: Dict[str, Any] = {}
    if row["metadata_json"]:
        try:
            meta = json.loads(row["metadata_json"])
        except (json.JSONDecodeError, TypeError):
            meta = {}
    return {
        "id": row["id"],
        "camera": row["camera"],
        "started_at": int(row["started_at"]),
        "ended_at": int(row["ended_at"]),
        "duration_seconds": int(row["duration_seconds"]),
        "file_size_bytes": int(row["file_size_bytes"]),
        "kind": row["kind"],
        "created_at": int(row["created_at"]),
        "metadata": meta,
        "has_thumbnail": bool(row["thumbnail_path"]),
    }


@router.get("/api/clips")
def list_clips(
    camera: Optional[str] = None,
    from_: Optional[int] = Query(default=None, alias="from"),
    to: Optional[int] = None,
    kind: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
) -> Dict[str, Any]:
    conds: List[str] = []
    args: List[Any] = []
    if camera:
        conds.append("camera = ?")
        args.append(camera)
    # Range filter uses interval-overlap semantics: include any clip whose
    # [started_at, ended_at] intersects [from, to]. The naive
    # `started_at >= from AND started_at <= to` filter excluded long-running
    # clips (e.g. 30-min continuous chunks) when the viewport landed inside
    # them — the chunk's started_at was before `from` even though the clip
    # covered the viewport, and the timeline lane went blank on zoom-in.
    if from_ is not None:
        conds.append("ended_at >= ?")
        args.append(int(from_))
    if to is not None:
        conds.append("started_at <= ?")
        args.append(int(to))
    if kind:
        conds.append("kind = ?")
        args.append(kind)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    with db_connect() as conn:
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM clips" + where, args
        ).fetchone()["n"]
        rows = conn.execute(
            "SELECT * FROM clips" + where +
            " ORDER BY started_at DESC LIMIT ? OFFSET ?",
            args + [limit, offset],
        ).fetchall()
    return {
        "items": [_clip_row_to_dict(r) for r in rows],
        "total": int(total),
        "limit": limit,
        "offset": offset,
    }


@router.get("/api/clips/cameras")
def list_clip_cameras() -> Dict[str, Any]:
    """Distinct camera list (handy for UI grouping). Declared above the
    `/{clip_id}` route so FastAPI's first-match ordering matches this first.
    """
    with db_connect() as conn:
        rows = conn.execute(
            "SELECT camera, COUNT(*) AS n, MAX(started_at) AS last_at "
            "FROM clips GROUP BY camera ORDER BY camera"
        ).fetchall()
    return {"items": [dict(r) for r in rows]}


def _fetch_clip(clip_id: str) -> Optional[Dict[str, Any]]:
    with db_connect() as conn:
        row = conn.execute(
            "SELECT * FROM clips WHERE id = ?", (clip_id,)
        ).fetchone()
    if row is None:
        return None
    d = _clip_row_to_dict(row)
    d["_file_path"] = row["file_path"]
    d["_thumbnail_path"] = row["thumbnail_path"]
    return d


@router.get("/api/clips/{clip_id}")
def get_clip(clip_id: str) -> Dict[str, Any]:
    d = _fetch_clip(clip_id)
    if d is None:
        raise HTTPException(status_code=404, detail="clip not found")
    d.pop("_file_path", None)
    d.pop("_thumbnail_path", None)
    return d


def _low_variant_path(original: Path) -> Path:
    # Sit next to the original so it's wiped by the same delete-clip path.
    # Suffix is `.low.mp4` so a glob can find/clean them if needed.
    return original.with_name(original.stem + ".low.mp4")


def _ensure_low_variant(original_path: Path) -> Path:
    """Return the path to a 480p / ultrafast / crf-28 variant of the clip.

    Transcodes on first request and caches on disk. Subsequent requests
    serve the cached file via the same range_file_response path. CPU is
    only spent for clips someone actually views remotely; nothing happens
    in the background.
    """
    low = _low_variant_path(original_path)
    if low.exists() and low.stat().st_mtime >= original_path.stat().st_mtime:
        return low
    tmp = low.with_suffix(".tmp.mp4")
    # ultrafast keeps the Pi from saturating its cores; -crf 28 + 480p
    # turns a ~200 MB 5-min clip into roughly 8-20 MB which streams over
    # a few-hundred-kbit/s uplink.
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(original_path),
        "-vf", "scale=-2:480",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
        "-an",
        "-movflags", "+faststart",
        str(tmp),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if result.returncode != 0 or not tmp.exists():
        try: tmp.unlink()
        except FileNotFoundError: pass
        raise RuntimeError(f"transcode failed rc={result.returncode}: {result.stderr.strip()}")
    tmp.replace(low)
    return low


@router.get("/api/clips/{clip_id}/video")
def get_clip_video(
    clip_id: str,
    request: Request,
    q: Optional[str] = None,
) -> Response:
    d = _fetch_clip(clip_id)
    if d is None:
        raise HTTPException(status_code=404, detail="clip not found")
    src = Path(d["_file_path"])
    # Optional low-bitrate variant for slow-connection remote viewers.
    # Cached on disk on first request; subsequent requests are fast.
    if q == "low":
        try:
            src = _ensure_low_variant(src)
        except Exception:
            log.exception("low-quality variant build failed for clip %s", clip_id)
            # Fall back to the original; better than 500.
            src = Path(d["_file_path"])
    return range_file_response(
        request,
        src,
        media_type="video/mp4",
        filename=f"{clip_id}{'.low' if q == 'low' else ''}.mp4",
    )


@router.get("/api/clips/{clip_id}/thumbnail")
def get_clip_thumbnail(clip_id: str, request: Request) -> Response:
    d = _fetch_clip(clip_id)
    if d is None or not d.get("_thumbnail_path"):
        raise HTTPException(status_code=404, detail="thumbnail not found")
    return range_file_response(
        request,
        Path(d["_thumbnail_path"]),
        media_type="image/jpeg",
        filename=f"{clip_id}.jpg",
    )


def _delete_clip_files(file_path: Optional[str], thumb_path: Optional[str]) -> None:
    """Delete the original clip, its thumbnail, and the cached low-quality
    variant (built on demand by /api/clips/{id}/video?q=low) if present.
    """
    for p in (file_path, thumb_path):
        if not p:
            continue
        try:
            os.unlink(p)
        except FileNotFoundError:
            pass
        except OSError as e:
            log.warning("clip cleanup: unlink %s failed: %s", p, e)
    if file_path:
        low = _low_variant_path(Path(file_path))
        try:
            low.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            log.warning("clip cleanup: unlink low variant %s failed: %s", low, e)


@router.delete("/api/clips/{clip_id}")
def delete_clip(clip_id: str) -> Dict[str, Any]:
    d = _fetch_clip(clip_id)
    if d is None:
        raise HTTPException(status_code=404, detail="clip not found")
    _delete_clip_files(d.get("_file_path"), d.get("_thumbnail_path"))
    with db_connect() as conn:
        conn.execute("DELETE FROM clips WHERE id = ?", (clip_id,))
    return {"ok": True, "id": clip_id}


@router.delete("/api/clips")
def delete_all_clips(camera: Optional[str] = None) -> Dict[str, Any]:
    """Bulk delete. Pass `?camera=cam-X` to limit to one camera; otherwise wipe."""
    with db_connect() as conn:
        if camera:
            rows = conn.execute(
                "SELECT id, file_path, thumbnail_path FROM clips WHERE camera = ?",
                (camera,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, file_path, thumbnail_path FROM clips"
            ).fetchall()
        deleted = 0
        for r in rows:
            _delete_clip_files(r["file_path"], r["thumbnail_path"])
            deleted += 1
        if camera:
            conn.execute("DELETE FROM clips WHERE camera = ?", (camera,))
        else:
            conn.execute("DELETE FROM clips")
    log.info("delete_all_clips: removed %d (camera=%s)", deleted, camera or "*")
    return {"ok": True, "deleted": deleted, "camera": camera}


