import time
import subprocess
import os
import sys
from pathlib import Path

CLEANUP_INTERVAL_SECONDS = 10

def main():
    base_dir = Path(__file__).resolve().parent
    cleanup_path = base_dir / "upload_cleanup.py"

    print("[SCHEDULER] Cleanup scheduler started", flush=True)

    while True:
        try:
            subprocess.run([sys.executable, str(cleanup_path)], cwd=str(base_dir))
        except Exception as e:
            print(f"[SCHEDULER] ⚠️ Cleanup run failed: {e}", flush=True)

        time.sleep(CLEANUP_INTERVAL_SECONDS)

if __name__ == "__main__":
    main()
