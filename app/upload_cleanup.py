import os
import time
from pathlib import Path

# ---------------- CONFIG ---------------- #
MAX_TOTAL_MB = int(os.getenv("UPLOAD_MAX_MB", "2048"))
MAX_TOTAL_BYTES = MAX_TOTAL_MB * 1024 * 1024

MIN_FILE_AGE_SECONDS = int(os.getenv("UPLOAD_MIN_AGE_SECONDS", "60"))
DELETE_EMPTY_DIRS = os.getenv("UPLOAD_DELETE_EMPTY_DIRS", "true").lower() == "true"

LOCK_FILE = "/tmp/upload_cleanup.lock"
# ---------------------------------------- #


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


def get_all_files(root: Path):
    now = time.time()
    files = []

    for path in root.rglob("*"):
        if path.is_file():
            try:
                stat = path.stat()
                age = now - stat.st_mtime
                if age < MIN_FILE_AGE_SECONDS:
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
    uploads_dir = get_upload_dir()

    print(f"[CLEANUP] Script path: {Path(__file__).resolve()}", flush=True)
    print(f"[CLEANUP] Upload dir: {uploads_dir}", flush=True)
    print(f"[CLEANUP] Upload dir exists? {uploads_dir.exists()}", flush=True)
    print(f"[CLEANUP] Threshold: {MAX_TOTAL_MB} MB", flush=True)

    if not acquire_lock():
        return

    try:
        if not uploads_dir.exists():
            print(f"[CLEANUP] ❌ Upload directory does not exist: {uploads_dir}", flush=True)
            return

        files = get_all_files(uploads_dir)

        total_size = sum(size for _, _, size in files)
        total_mb = total_size / (1024 * 1024)

        print(f"[CLEANUP] Found {len(files)} files. Total size: {total_mb:.2f} MB", flush=True)

        if total_size <= MAX_TOTAL_BYTES:
            print("[CLEANUP] ✅ No cleanup needed.", flush=True)
            return

        files.sort(key=lambda x: x[1])  # oldest first

        bytes_to_free = total_size - MAX_TOTAL_BYTES
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

        if DELETE_EMPTY_DIRS:
            remove_empty_dirs(uploads_dir)

    finally:
        release_lock()


if __name__ == "__main__":
    cleanup()
