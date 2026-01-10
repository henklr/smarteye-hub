import base64
import json
from pathlib import Path
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

from openai import OpenAI

#client = OpenAI()

UPLOAD_ROOT = Path("uploads")
SCENES_PATH = Path("data/scenes.json")
SCENES_PATH.parent.mkdir(parents=True, exist_ok=True)

DEFAULT_MODEL = "gpt-5.1"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".tiff"}


# ---------------------------
# Scenes storage
# ---------------------------

def load_scenes() -> list:
    if not SCENES_PATH.exists():
        save_scenes([])
    with SCENES_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)

def save_scenes(scenes: list) -> None:
    SCENES_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SCENES_PATH.open("w", encoding="utf-8") as f:
        json.dump(scenes, f, indent=2)

def get_scene(scene_id: str) -> dict:
    scenes = load_scenes()
    for s in scenes:
        if s.get("id") == scene_id:
            return s
    raise ValueError(f"Scene not found: {scene_id}")


# ---------------------------
# Snapshot selection
# ---------------------------

def is_image_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_EXTS

def parse_snapshot_time(filename: str) -> Optional[datetime]:
    """
    Extract timestamp from filename like:
      NVR_ch6_20260109202903_E.jpg
    """
    parts = filename.split("_")
    if len(parts) < 3:
        return None
    ts_str = parts[2]
    try:
        return datetime.strptime(ts_str, "%Y%m%d%H%M%S")
    except ValueError:
        return None

def find_snapshots(
    camera_ip: str,
    channel: int,
    alarm_time: datetime,
    before_seconds: int,
    after_seconds: int,
) -> List[Path]:
    """
    Return snapshots within window [alarm_time-before, alarm_time+after]
    """
    date_str = alarm_time.strftime("%Y-%m-%d")
    day_dir = UPLOAD_ROOT / camera_ip / date_str
    if not day_dir.exists():
        return []

    start = alarm_time - timedelta(seconds=before_seconds)
    end = alarm_time + timedelta(seconds=after_seconds)

    pattern = f"*ch{channel}_*"
    matches = []

    for p in day_dir.glob(pattern):
        if not is_image_file(p):
            continue
        snap_time = parse_snapshot_time(p.name)
        if not snap_time:
            continue
        if start <= snap_time <= end:
            matches.append((snap_time, p))

    matches.sort(key=lambda x: x[0])
    return [p for _, p in matches]

def pick_snapshots(strategy: str, snapshots: List[Path], count: int) -> List[Path]:
    """
    Reduce list of snapshots to `count` items
    strategy:
      - "latest": pick last N
      - "earliest": pick first N
      - "evenly_spread": spread across window
    """
    if count <= 0:
        return []
    if len(snapshots) <= count:
        return snapshots

    if strategy == "latest":
        return snapshots[-count:]
    if strategy == "earliest":
        return snapshots[:count]

    # evenly_spread default
    idxs = []
    for i in range(count):
        idx = round(i * (len(snapshots) - 1) / (count - 1))
        idxs.append(idx)
    return [snapshots[i] for i in idxs]


# ---------------------------
# OpenAI image helper
# ---------------------------

def encode_image_data_url(path: Path) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode("utf-8")
    mime = "image/jpeg"
    if path.suffix.lower() == ".png":
        mime = "image/png"
    return f"data:{mime};base64,{b64}"


# ---------------------------
# Main entry: run a scene
# ---------------------------

def run_scene(scene_id: str, event: Dict[str, Any]) -> Dict[str, Any]:
    from events import record_and_dispatch_analysis

    scene = get_scene(scene_id)

    print(f"[ANALYZE] ===== RUN SCENE =====")
    print(f"[ANALYZE] scene_id={scene_id} name={scene.get('name')} enabled={scene.get('enabled', True)}")

    if not scene.get("enabled", True):
        out = {
            "ok": False,
            "scene_id": scene_id,
            "scene_name": scene.get("name"),
            "error": "Scene disabled",
            "camera_ip": scene.get("camera_ip") or event.get("camera_ip"),
            "channel": int(scene.get("channel") or event.get("channel") or 1),
            "alarm_time": event.get("timestamp") or event.get("locale_time"),
        }
        record_and_dispatch_analysis(event, out)
        return out


    alarm_time_str = event.get("timestamp") or event.get("locale_time")
    if not alarm_time_str:
        out = {
            "ok": False,
            "scene_id": scene_id,
            "scene_name": scene.get("name"),
            "error": "Event missing timestamp/locale_time",
            "camera_ip": scene.get("camera_ip") or event.get("camera_ip"),
            "channel": int(scene.get("channel") or event.get("channel") or 1),
            "alarm_time": None,
        }
        record_and_dispatch_analysis(event, out)
        return out

    # Parse alarm time
    try:
        alarm_time = datetime.fromisoformat(alarm_time_str.replace("Z",""))
    except Exception:
        alarm_time = datetime.strptime(alarm_time_str, "%Y-%m-%d %H:%M:%S")

    camera_ip = scene.get("camera_ip") or event.get("camera_ip")
    channel = int(scene.get("channel") or event.get("channel") or 1)

    prompt = scene.get("prompt", "Analyze these frames. Return JSON.")
    model = scene.get("model", DEFAULT_MODEL)

    snap_cfg = scene.get("snapshots", {}) or {}
    count = int(snap_cfg.get("count", 5))
    before_s = int(snap_cfg.get("before_seconds", 5))
    after_s = int(snap_cfg.get("after_seconds", 20))
    strategy = snap_cfg.get("strategy", "evenly_spread")

    print(f"[ANALYZE] event time={alarm_time_str} parsed={alarm_time}")
    print(f"[ANALYZE] camera_ip={camera_ip} channel={channel}")
    print(f"[ANALYZE] snapshot settings: count={count} before={before_s}s after={after_s}s strategy={strategy}")

    all_snaps = find_snapshots(camera_ip, channel, alarm_time, before_s, after_s)
    selected = pick_snapshots(strategy, all_snaps, count)

    print(f"[ANALYZE] found snapshots total={len(all_snaps)} selected={len(selected)}")
    if selected:
        for p in selected:
            print(f"[ANALYZE] selected -> {p}")

    if not selected:
        out = {
            "ok": False,
            "scene_id": scene_id,
            "scene_name": scene.get("name"),
            "error": "No snapshots found",
            "camera_ip": camera_ip,
            "channel": channel,
            "alarm_time": alarm_time_str,
            "snapshot_count": 0,
            "snapshots": [],
            "model": model,
            "result": None,
        }

        print("[ANALYZE] RESULT:", json.dumps(out, indent=2, ensure_ascii=False))
        record_and_dispatch_analysis(event, out)
        return out

    print(f"[ANALYZE] model={model}")
    print(f"[ANALYZE] prompt preview:\n{prompt[:500]}")
    print("[ANALYZE] sending request to OpenAI...")

    metadata = {
        "scene_id": scene_id,
        "scene_name": scene.get("name"),
        "alarm_time": alarm_time_str,
        "camera_ip": camera_ip,
        "channel": channel,
        "snapshots": [str(p) for p in selected],
        "event": event,
    }

    content = [
        {"type": "input_text", "text": prompt + "\n\nMetadata:\n" + json.dumps(metadata, ensure_ascii=False)}
    ]
    for p in selected:
        content.append({"type": "input_image", "image_url": encode_image_data_url(p)})

    client = OpenAI()

    response = client.responses.create(
        model=model,
        input=[{"role": "user", "content": content}],
        max_output_tokens=1024,
    )

    text = response.output_text

    try:
        parsed = json.loads(text)
    except Exception:
        parsed = {"raw_output": text}

    out = {
        "ok": True,
        "scene_id": scene_id,
        "scene_name": scene.get("name"),
        "camera_ip": camera_ip,
        "channel": channel,
        "alarm_time": alarm_time_str,
        "snapshot_count": len(selected),
        "snapshots": [str(p) for p in selected],
        "model": model,
        "result": parsed,
    }

    print("[ANALYZE] RESULT:", json.dumps(out, indent=2, ensure_ascii=False))
    print(f"[ANALYZE] ===== DONE =====")

    record_and_dispatch_analysis(event, out)

    return out
