from fastapi import FastAPI, Body, HTTPException
from fastapi.staticfiles import StaticFiles
from config import load_settings, save_settings
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

@app.on_event("startup")
def startup():
    start_alarm_process()

@app.on_event("shutdown")
def shutdown():
    stop_alarm_process()

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/api/settings")
def get_settings():
    return load_settings()

@app.post("/api/settings")
def update_settings(new_settings: dict = Body(...)):
    saved = save_settings(new_settings)
    return {"ok": True, "settings": saved}

@app.post("/api/alarm/restart")
def restart_alarm_listener():
    try:
        stop_alarm_process()
        start_alarm_process()
        return {"ok": True, "message": "Alarm listener restarted"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# mount static LAST
app.mount("/", StaticFiles(directory="static", html=True), name="static")
