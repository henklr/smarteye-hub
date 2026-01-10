import json
from pathlib import Path
from datetime import datetime

EVENTS_PATH = Path("data/events.jsonl")
EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)

def append_event(obj: dict):
    """
    Append one JSON object as a JSONL line.
    """
    obj = dict(obj)

    # Always add a server timestamp for debugging
    obj.setdefault("server_time", datetime.utcnow().isoformat() + "Z")

    with EVENTS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")
