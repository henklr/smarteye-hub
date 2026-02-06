import json
import time
import re
import requests
from pathlib import Path
from analyze import run_scene
from config import load_settings
from time_utils import make_clock

AUTOMATIONS_PATH = Path("data/automations.json")
RUNS_PATH = Path("data/automation_runs.jsonl")
AUTOMATIONS_PATH.parent.mkdir(parents=True, exist_ok=True)

SETTINGS = load_settings()
CLOCK = make_clock(SETTINGS)

DEFAULT_AUTOMATIONS = [
    {
        "id": "log-face-detection",
        "name": "Log Face Detection Start",
        "enabled": True,
        "conditions": [
            {"field": "code", "op": "equals", "value": "FaceDetection"},
            {"field": "action", "op": "equals", "value": "Start"},
        ],
        "actions": [
            {"type": "log", "message": "Face detected on {{camera_ip}} at {{locale_time}}"}
        ],
    }
]

def ensure_automations_file():
    if not AUTOMATIONS_PATH.exists():
        save_automations(DEFAULT_AUTOMATIONS)

def load_automations():
    ensure_automations_file()
    with AUTOMATIONS_PATH.open("r", encoding="utf-8") as f:
        automations = json.load(f)
    return [normalize_automation(a) for a in (automations or [])]

def save_automations(automations):
    AUTOMATIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUTOMATIONS_PATH.open("w", encoding="utf-8") as f:
        json.dump(automations, f, indent=2)

def normalize_automation(a: dict) -> dict:
    a = dict(a)

    conds = a.get("conditions") or []
 
    # Ensure lists exist
    a["conditions"] = conds
    a["actions"] = a.get("actions") or []
    a["enabled"] = bool(a.get("enabled", False))

    # Optional defaults
    a["id"] = a.get("id") or f"auto-{int(time.time())}"
    a["name"] = a.get("name") or "New automation"

    return a

def log_run(run_obj):
    RUNS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with RUNS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(run_obj, ensure_ascii=False) + "\n")

def render_template(template: str, event: dict) -> str:
    def repl(match):
        key = match.group(1).strip()
        val = get_by_path(event, key)
        return "" if val is None else str(val)
    return re.sub(r"\{\{(.*?)\}\}", repl, template)

def get_by_path(obj, path: str):
    """Get nested values using dot paths, e.g. 'analysis.category'."""
    cur = obj
    for part in (path or "").split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur

def coerce_value_for_compare(actual, value):
    # If value is already same type (or actual is None), leave it
    if actual is None:
        return value

    # bool: allow "true"/"false"
    if isinstance(actual, bool) and isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "false"):
            return (v == "true")

    # int: allow "123"
    if isinstance(actual, int) and not isinstance(actual, bool) and isinstance(value, str):
        s = value.strip()
        if re.fullmatch(r"[+-]?\d+", s):
            try:
                return int(s)
            except ValueError:
                pass

    # float: allow "12.3" or "12" (convert to float)
    if isinstance(actual, float) and isinstance(value, str):
        s = value.strip()
        if re.fullmatch(r"[+-]?(\d+(\.\d*)?|\.\d+)", s):
            try:
                return float(s)
            except ValueError:
                pass

    return value

# ------------------
# Conditions
# ------------------

def check_condition(cond: dict, event: dict) -> bool:
    field = cond.get("field")
    op = cond.get("op")
    value = cond.get("value")
    actual = get_by_path(event, field)

    if op == "equals":
        value2 = coerce_value_for_compare(actual, value)
        return actual == value2

    if op == "not_equals":
        value2 = coerce_value_for_compare(actual, value)
        return actual != value2
    if op == "contains" and isinstance(actual, str) and isinstance(value, str):
        return value in actual
    if op == "in":
        return actual in value if isinstance(value, list) else False
    if op == "exists":
        return actual is not None
    return False

def matches_automation(automation: dict, event: dict) -> bool:
    if not automation.get("enabled", False):
        return False

    conds = automation.get("conditions") or []

    # No conditions = never matches (recommended)
    if not conds:
        return False

    # AND logic across all conditions
    for cond in conds:
        if not check_condition(cond, event):
            return False

    return True

# ------------------
# Actions
# ------------------

def run_action(action: dict, event: dict):
    t = action.get("type")

    if t == "log":
        msg = render_template(action.get("message", ""), event)
        print(f"[AUTO] {msg}", flush=True)
        return {"ok": True, "type": "log", "message": msg}

    if t == "webhook":
        url = action.get("url")
        method = (action.get("method") or "POST").upper()
        payload = action.get("payload", event)
        payload = payload if isinstance(payload, dict) else event

        # allow templating in payload strings
        payload = {
            k: render_template(v, event) if isinstance(v, str) else v
            for k, v in payload.items()
        }

        try:
            resp = requests.request(method, url, json=payload, timeout=5)
            return {"ok": resp.ok, "type": "webhook", "status": resp.status_code, "text": resp.text[:300]}
        except Exception as e:
            return {"ok": False, "type": "webhook", "error": str(e)}

    if t == "analyze":
        scene_id = action.get("scene_id")
        if not scene_id:
            return {"ok": False, "type": "analyze", "error": "Missing scene_id"}

        result = run_scene(scene_id, event)
        return {"ok": result.get("ok", False), "type": "analyze", "scene_id": scene_id, "result": result}

    return {"ok": False, "type": t, "error": "Unknown action type"}

# ------------------
# Main entry point
# ------------------

def handle_event(event: dict):
    """
    Called by the alarm listener / event generator.
    """
    automations = load_automations()

    for a in automations:
        if not matches_automation(a, event):
            continue
        
        clock = make_clock(load_settings())
        run_id = f"{a.get('id')}:{clock.utc_iso()}"
        results = []

        for action in a.get("actions", []) or []:
            results.append(run_action(action, event))

        run_obj = {
            "run_id": run_id,
            "automation_id": a.get("id"),
            "automation_name": a.get("name"),
            "event_id": event.get("id"),
            "timestamp": clock.utc_iso(),
            "event": event,
            "results": results,
        }
        log_run(run_obj)
