import json
from pathlib import Path

SETTINGS_PATH = Path("data/settings.json")

DEFAULT_SETTINGS = {
    "alarm_listener": {
        "only_start_events": True,
        "log_raw_payload": False,
        "listen_host": "0.0.0.0",
        "listen_port": 15000,
        "max_payload_bytes": 131072
    }
}

def merge_settings(user: dict) -> dict:
    merged = DEFAULT_SETTINGS.copy()
    merged["alarm_listener"] = {
        **DEFAULT_SETTINGS["alarm_listener"],
        **(user.get("alarm_listener", {}) or {})
    }
    return merged

def load_settings() -> dict:
    user = {}
    if SETTINGS_PATH.exists():
        try:
            with SETTINGS_PATH.open("r", encoding="utf-8") as f:
                user = json.load(f) or {}
        except Exception:
            user = {}

    settings = merge_settings(user)

    # Ensure file exists (so UI always has something to edit)
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SETTINGS_PATH.open("w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)

    return settings

def save_settings(new_settings: dict) -> dict:
    settings = merge_settings(new_settings)
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with SETTINGS_PATH.open("w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
    return settings
