#!/usr/bin/env python3
"""
events.py

Responsible for:
- Normalizing an alarm payload into an event dict
- Logging event to data/events.jsonl
- Triggering automations.handle_event(event)
"""

import json
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, Optional

from config import load_settings

settings = load_settings()["alarm_listener"]

EVENTS_PATH = Path(settings.get("events_path", "data/events.jsonl"))
EVENTS_PATH.parent.mkdir(parents=True, exist_ok=True)


def build_event(alarm: Dict[str, Any]) -> Dict[str, Any]:
    """
    Convert raw alarm payload into normalized event schema used internally.
    """
    action = alarm.get("Action")
    code = alarm.get("Code")
    data = alarm.get("Data", {}) or {}

    return {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "camera_ip": data.get("IP"),
        "action": action,
        "code": code,
        "event_seq": data.get("EventSeq"),
        "locale_time": data.get("LocaleTime"),
        "raw": alarm,
    }


def log_event(event: Dict[str, Any]) -> None:
    """
    Append a JSONL record to EVENTS_PATH.
    """
    with EVENTS_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def dispatch_event(event: Dict[str, Any]) -> None:
    """
    Trigger automation handling for the event.
    """
    from automations import handle_event
    handle_event(event)


def record_and_dispatch(alarm: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Main entry point: builds, logs and dispatches an event.
    Returns the event dict if successful, otherwise None.
    """
    try:
        event = build_event(alarm)
        log_event(event)
        dispatch_event(event)
        return event
    except Exception as e:
        print(f"[EVENTS] Failed to record/dispatch event: {e}", flush=True)
        return None
