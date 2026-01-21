from fastapi import FastAPI, Body, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from typing import Any, Dict, List, Optional
from time_utils import make_clock
import subprocess
import json
import os
import subprocess
import sys
import signal

from config import load_settings, save_settings
from automations import load_automations, save_automations, handle_event
from analyze import load_scenes, save_scenes, run_scene

app = FastAPI()

alarm_proc = None

EVENTS_PATH = os.environ.get("EVENTS_PATH", "data/events.jsonl")

def start_alarm_process():
    global alarm_proc
    base_dir = os.path.dirname(os.path.abspath(__file__))
    alarm_path = os.path.join(base_dir, "alarm_listener.py")

    alarm_proc = subprocess.Popen(
        [sys.executable, alarm_path],
        cwd=base_dir,
    )
    print("[MAIN] Alarm listener process started", flush=True)

def stop_alarm_process():
    global alarm_proc
    if alarm_proc and alarm_proc.poll() is None:
        alarm_proc.terminate()
        try:
            alarm_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            alarm_proc.kill()
        print("[MAIN] Alarm listener process stopped", flush=True)

cleanup_proc = None

def start_cleanup_scheduler():
    global cleanup_proc
    base_dir = os.path.dirname(os.path.abspath(__file__))
    scheduler_path = os.path.join(base_dir, "cleanup_scheduler.py")

    cleanup_proc = subprocess.Popen(
        [sys.executable, scheduler_path],
        cwd=base_dir,
    )
    print("[MAIN] Cleanup scheduler started", flush=True)

def stop_cleanup_scheduler():
    global cleanup_proc
    if cleanup_proc and cleanup_proc.poll() is None:
        cleanup_proc.terminate()
        try:
            cleanup_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cleanup_proc.kill()
        print("[MAIN] Cleanup scheduler stopped", flush=True)

@app.on_event("startup")
def startup():
    start_alarm_process()
    start_cleanup_scheduler()

@app.on_event("shutdown")
def shutdown():
    stop_alarm_process()
    stop_cleanup_scheduler()
    
@app.get("/api/health")
def health():
    return {"status": "ok"}

#--------------------------------settings.py----------------------------------#

@app.get("/api/settings")
def get_settings():
    return load_settings()

@app.post("/api/settings")
def update_settings(new_settings: dict = Body(...)):
    return save_settings(new_settings)

@app.post("/api/alarm/restart")
def restart_alarm_listener():
    try:
        stop_alarm_process()
        start_alarm_process()
        return {"ok": True, "message": "Alarm listener restarted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
#----------------------------------settings.py----------------------------------#

#---------------------------------automations.py--------------------------------#
@app.get("/api/automations")
def get_automations():
    return load_automations()

@app.post("/api/automations")
def update_automations(new_automations: list = Body(...)):
    save_automations(new_automations)
    return {"ok": True}

@app.post("/api/automations/test")
def test_automation(event: dict = Body(...)):
    handle_event(event)
    return {"ok": True}
#---------------------------------automations.py--------------------------------#

#----------------------------------analyze.py----------------------------------#
@app.get("/api/scenes")
def get_scenes():
    return load_scenes()

@app.post("/api/scenes")
def update_scenes(new_scenes: list = Body(...)):
    save_scenes(new_scenes)
    return {"ok": True}

@app.post("/api/scenes/test/{scene_id}")
def test_scene(scene_id: str, event: dict = Body(...)):
    return run_scene(scene_id, event)
#----------------------------------analyze.py----------------------------------#

#----------------------------------events.py----------------------------------#
def get_by_path(obj: Any, path: str) -> Any:
    """Dot-path getter for nested fields. Returns None if missing."""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def pick_fields(event: Dict[str, Any], fields: Optional[List[str]]) -> Dict[str, Any]:
    if not fields:
        return event
    return {f: get_by_path(event, f) for f in fields}


def iter_events_jsonl(path: str):
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Events file not found: {path}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    # Skip bad lines rather than failing the whole request
                    continue
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to read events file: {e}")


@app.get("/api/events")
def get_events(
    fields: Optional[str] = Query(
        default=None,
        description="Comma-separated fields to return. Supports dot paths (e.g. analysis.category, raw.Data.EventSeq).",
    ),
    limit: int = Query(default=100, ge=1, le=5000),

    event_type: Optional[str] = None,
    camera_ip: Optional[str] = None,
    code: Optional[str] = None,
    action: Optional[str] = None,

    ok: Optional[bool] = None,
    parent_event_id: Optional[str] = None,
    scene_id: Optional[str] = None,

    since: Optional[str] = Query(default=None, description="Timestamp. Parsed by time_utils.Clock."),
    until: Optional[str] = Query(default=None, description="Timestamp. Parsed by time_utils.Clock."),
):
    # Build clock from your configured timezone
    clock = make_clock(load_settings())

    selected_fields = [f.strip() for f in fields.split(",") if f.strip()] if fields else None

    # Parse time filters (convert to UTC for consistent comparisons)
    try:
        since_dt_utc = clock.parse_datetime(since).astimezone(clock.now_utc().tzinfo) if since else None
        until_dt_utc = clock.parse_datetime(until).astimezone(clock.now_utc().tzinfo) if until else None
        # clock.now_utc().tzinfo is UTC; avoids importing timezone here
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    out: List[Dict[str, Any]] = []
    scanned = 0

    for ev in iter_events_jsonl(EVENTS_PATH):
        scanned += 1

        # Field filters
        if event_type is not None and ev.get("event_type") != event_type:
            continue
        if camera_ip is not None and ev.get("camera_ip") != camera_ip:
            continue
        if code is not None and ev.get("code") != code:
            continue
        if action is not None and ev.get("action") != action:
            continue
        if ok is not None and ev.get("ok") != ok:
            continue
        if parent_event_id is not None and ev.get("parent_event_id") != parent_event_id:
            continue
        if scene_id is not None and ev.get("scene_id") != scene_id:
            continue

        # Time filter uses top-level "timestamp" if present
        if (since_dt_utc or until_dt_utc) and isinstance(ev.get("timestamp"), str):
            try:
                ev_dt_utc = clock.parse_datetime(ev["timestamp"]).astimezone(clock.now_utc().tzinfo)
            except ValueError:
                # If timestamp is malformed, skip the line
                continue

            if since_dt_utc and ev_dt_utc < since_dt_utc:
                continue
            if until_dt_utc and ev_dt_utc > until_dt_utc:
                continue

        out.append(pick_fields(ev, selected_fields))
        if len(out) >= limit:
            break

    return {
        "ok": True,
        "timezone": clock.timezone_name,
        "path": EVENTS_PATH,
        "returned": len(out),
        "limit": limit,
        "scanned": scanned,
        "events": out,
    }
#----------------------------------events.py----------------------------------#

# mount static LAST
app.mount("/", StaticFiles(directory="static", html=True), name="static")
