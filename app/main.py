from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
import subprocess
import os
import sys

app = FastAPI()

alarm_proc = None

@app.on_event("startup")
def start_alarm_listener():
    global alarm_proc

    base_dir = os.path.dirname(os.path.abspath(__file__))
    alarm_path = os.path.join(base_dir, "alarm_listener.py")

    alarm_proc = subprocess.Popen(
        [sys.executable, alarm_path],
        cwd=base_dir,
    )
    print("[MAIN] Alarm listener process started")

@app.on_event("shutdown")
def stop_alarm_listener():
    global alarm_proc
    if alarm_proc and alarm_proc.poll() is None:
        alarm_proc.terminate()
        try:
            alarm_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            alarm_proc.kill()
        print("[MAIN] Alarm listener process stopped")

@app.get("/api/health")
def health():
    return {"status": "ok"}

# mount static LAST
app.mount("/", StaticFiles(directory="static", html=True), name="static")
