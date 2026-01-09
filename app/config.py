import json
from pathlib import Path

SETTINGS_PATH = Path("data/settings.json")

DEFAULT_SETTINGS = {
    "alarm_listener": {
        "only_start_events": True,
        "log_raw_payload": True,
        "max_payload_bytes": 131072,  # protect against huge payloads
        "listen_host": "0.0.0.0",
        "listen_port": 15000
    }
}

def load_settings():
    if SETTINGS_PATH.exists():
        try:
            with SETTINGS_PATH.open("r", encoding="utf-8") as f:
                data = json.load(f)
            # deep merge defaults with file values
            settings = DEFAULT_SETTINGS.copy()
            settings["alarm_listener"] = {
                **DEFAULT_SETTINGS["alarm_listener"],
                **data.get("alarm_listener", {})
            }
            return settings
        except Exception:
            return DEFAULT_SETTINGS
    return DEFAULT_SETTINGS
