from fastapi import FastAPI, Body, HTTPException
from fastapi.staticfiles import StaticFiles
from config import load_settings, save_settings
from automations import load_automations, save_automations, handle_event
from analyze import load_scenes, save_scenes, run_scene
import subprocess
import os
import sys
import signal

app = FastAPI()

alarm_proc = None

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

# mount static LAST
app.mount("/", StaticFiles(directory="static", html=True), name="static")
