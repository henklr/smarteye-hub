#!/usr/bin/env python3
"""
events.py

Central event pipeline:
- normalize/build event objects
- log to JSONL
- dispatch to automations.handle_event(event)

Supports:
- alarm events (from NVR/alarm_listener)
- analysis events (from GPT scene run output)
"""

import json
import uuid
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, Optional

from config import load_settings

settings = load_settings()["alarm_listener"]

EVENTS_PATH = Path(settings.get("events_path", "data/events.jsonl"))
EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)


def _now_utc() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _new_id() -> str:
    return uuid.uuid4().hex


def log_event(event: Dict[str, Any]) -> None:
    with EVENTS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def dispatch_event(event: Dict[str, Any]) -> None:
    from automations import handle_event
    handle_event(event)


# ----------------------------
# Alarm event (raw NVR)
# ----------------------------

def build_alarm_event(alarm: Dict[str, Any]) -> Dict[str, Any]:
    action = alarm.get("Action")
    code = alarm.get("Code")
    data = alarm.get("Data", {}) or {}

    return {
        "id": _new_id(),
        "event_type": "alarm",
        "timestamp": _now_utc(),
        "camera_ip": data.get("IP"),
        "action": action,
        "code": code,
        "event_seq": data.get("EventSeq"),
        "locale_time": data.get("LocaleTime"),
        "raw": alarm,
    }


def record_and_dispatch_alarm(alarm: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        event = build_alarm_event(alarm)
        log_event(event)
        dispatch_event(event)
        return event
    except Exception as e:
        print(f"[EVENTS] Failed to record/dispatch alarm event: {e}", flush=True)
        return None


# ----------------------------
# Analysis event (GPT output)
# ----------------------------

def build_analysis_event(
    parent_event: Dict[str, Any],
    scene_result: Dict[str, Any],
) -> Dict[str, Any]:
    """
    parent_event is the original alarm event (or any event)
    scene_result is whatever run_scene() returns
    """
    return {
        "id": _new_id(),
        "event_type": "analysis",
        "timestamp": _now_utc(),

        "ok": bool(scene_result.get("ok")),
        "error": scene_result.get("error"),
        "snapshot_count": scene_result.get("snapshot_count", 0),

        # Traceability
        "parent_event_id": parent_event.get("id"),
        "scene_id": scene_result.get("scene_id"),
        "scene_name": scene_result.get("scene_name"),

        # Camera context
        "camera_ip": scene_result.get("camera_ip") or parent_event.get("camera_ip"),
        "channel": scene_result.get("channel") or parent_event.get("channel"),
        "alarm_time": scene_result.get("alarm_time"),

        # What was analyzed
        "snapshots": scene_result.get("snapshots", []),
        "snapshot_count": scene_result.get("snapshot_count", 0),
        "model": scene_result.get("model"),

        # GPT output / structured JSON
        "analysis": scene_result.get("result"),

        # Keep full raw result for debugging if needed
        "raw_scene_result": scene_result,
    }


def record_and_dispatch_analysis(
    parent_event: Dict[str, Any],
    scene_result: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    try:
        event = build_analysis_event(parent_event, scene_result)
        log_event(event)
        dispatch_event(event)
        return event
    except Exception as e:
        print(f"[EVENTS] Failed to record/dispatch analysis event: {e}", flush=True)
        return None
