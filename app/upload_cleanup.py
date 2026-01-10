import os
import time
import json
from pathlib import Path

# ---------------- CONFIG ---------------- #
LOCK_FILE = "/tmp/upload_cleanup.lock"
# ---------------------------------------- #

SETTINGS_PATH = Path("data/settings.json")
DEFAULT_UPLOAD_SETTINGS = {
    "enabled": True,
    "max_total_mb": 4096,
    "min_file_age_seconds": 60,
    "delete_empty_dirs": True
}

def load_upload_settings():
    settings = {}
    try:
        if SETTINGS_PATH.exists():
            settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        settings = {}

    upload = settings.get("upload_cleanup", {}) or {}
    merged = {**DEFAULT_UPLOAD_SETTINGS, **upload}

    # Optional env overrides
    merged["max_total_mb"] = int(os.getenv("UPLOAD_MAX_MB", merged["max_total_mb"]))
    merged["min_file_age_seconds"] = int(os.getenv("UPLOAD_MIN_AGE_SECONDS", merged["min_file_age_seconds"]))
    merged["delete_empty_dirs"] = os.getenv("UPLOAD_DELETE_EMPTY_DIRS", str(merged["delete_empty_dirs"])).lower() == "true"

    return merged

def get_upload_dir():
    """
    Priority:
      1) UPLOAD_DIR env var
      2) /app/uploads (docker layout)
      3) ../uploads (host layout)
    """
    env_dir = os.getenv("UPLOAD_DIR")
    if env_dir:
        return Path(env_dir)

    app_dir = Path(__file__).resolve().parent  # /app OR /home/.../app

    # Docker layout: /app/uploads
    docker_candidate = app_dir / "uploads"
    if docker_candidate.exists():
        return docker_candidate

    # Host layout: project_root/uploads
    host_candidate = app_dir.parent / "uploads"
    return host_candidate


def acquire_lock():
    if os.path.exists(LOCK_FILE):
        if time.time() - os.path.getmtime(LOCK_FILE) > 3600:
            print("[CLEANUP] Stale lock detected, removing", flush=True)
            os.remove(LOCK_FILE)
        else:
            print("[CLEANUP] Cleanup already running (lock exists). Exiting.", flush=True)
            return False

    with open(LOCK_FILE, "w") as f:
        f.write(str(os.getpid()))
    return True


def release_lock():
    if os.path.exists(LOCK_FILE):
        os.remove(LOCK_FILE)


def get_all_files(root: Path, min_age_seconds: int):
    now = time.time()
    files = []
    for path in root.rglob("*"):
        if path.is_file():
            try:
                stat = path.stat()
                age = now - stat.st_mtime
                if age < min_age_seconds:
                    continue
                files.append((path, stat.st_mtime, stat.st_size))
            except FileNotFoundError:
                continue
    return files

def remove_empty_dirs(root: Path):
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        if not dirnames and not filenames:
            try:
                os.rmdir(dirpath)
                print(f"[CLEANUP] Removed empty dir: {dirpath}", flush=True)
            except OSError:
                pass


def cleanup():
    cfg = load_upload_settings()

    if not cfg["enabled"]:
        print("[CLEANUP] Upload cleanup disabled in settings.", flush=True)
        return

    max_total_bytes = cfg["max_total_mb"] * 1024 * 1024
    min_age = cfg["min_file_age_seconds"]
    delete_empty_dirs = cfg["delete_empty_dirs"]

    uploads_dir = get_upload_dir()

    print(f"[CLEANUP] Upload dir: {uploads_dir}", flush=True)
    print(f"[CLEANUP] Threshold: {cfg['max_total_mb']} MB", flush=True)
    print(f"[CLEANUP] Min file age: {min_age}s", flush=True)

    if not acquire_lock():
        return

    try:
        if not uploads_dir.exists():
            print(f"[CLEANUP] ❌ Upload directory does not exist: {uploads_dir}", flush=True)
            return

        files = get_all_files(uploads_dir, min_age)

        total_size = sum(size for _, _, size in files)
        total_mb = total_size / (1024 * 1024)

        print(f"[CLEANUP] Found {len(files)} files. Total size: {total_mb:.2f} MB", flush=True)

        if total_size <= max_total_bytes:
            print("[CLEANUP] ✅ No cleanup needed.", flush=True)
            return

        files.sort(key=lambda x: x[1])  # oldest first

        bytes_to_free = total_size - max_total_bytes
        freed = 0
        deleted = 0

        for path, _, size in files:
            if freed >= bytes_to_free:
                break

            try:
                path.unlink()
                freed += size
                deleted += 1
                print(f"[CLEANUP] Deleted: {path} ({size / (1024*1024):.2f} MB)", flush=True)
            except Exception as e:
                print(f"[CLEANUP] ⚠️ Failed to delete {path}: {e}", flush=True)

        print(f"[CLEANUP] ✅ Deleted {deleted} files. Freed {freed / (1024*1024):.2f} MB", flush=True)

        if delete_empty_dirs:
            remove_empty_dirs(uploads_dir)

    finally:
        release_lock()


if __name__ == "__main__":
    cleanup()
