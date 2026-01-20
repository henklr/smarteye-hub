import time
import subprocess
import os
import sys
import json
from pathlib import Path

SETTINGS_PATH = Path("data/settings.json")
DEFAULT_INTERVAL = 60
MIN_INTERVAL = 5  # safety: avoid accidental 0 or 1 spam


def load_upload_config():
    try:
        if SETTINGS_PATH.exists():
            settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            return (settings.get("upload_cleanup") or {})
    except Exception:
        pass
    return {}


def get_interval_seconds():
    cfg = load_upload_config()
    interval = int(cfg.get("interval_seconds", DEFAULT_INTERVAL))
    return max(interval, MIN_INTERVAL)


def should_run():
    cfg = load_upload_config()
    return bool(cfg.get("enabled", True))


def run_cleanup(cleanup_path, base_dir):
    try:
        subprocess.run([sys.executable, str(cleanup_path)], cwd=str(base_dir))
    except Exception as e:
        print(f"[SCHEDULER] ⚠️ Cleanup run failed: {e}", flush=True)


def main():
    base_dir = Path(__file__).resolve().parent
    cleanup_path = base_dir / "upload_cleanup.py"

    print("[SCHEDULER] Cleanup scheduler started", flush=True)

    next_run_at = time.time()

    while True:
        # Respect enabled toggle
        if should_run() and time.time() >= next_run_at:
            print("[SCHEDULER] Running cleanup...", flush=True)
            run_cleanup(cleanup_path, base_dir)
            next_run_at = time.time() + get_interval_seconds()

        # The key: wake up frequently so interval changes apply immediately
        time.sleep(1)

        # If interval was shortened, don't wait unnecessarily
        interval = get_interval_seconds()
        if next_run_at - time.time() > interval:
            next_run_at = time.time() + interval


if __name__ == "__main__":
    main()
