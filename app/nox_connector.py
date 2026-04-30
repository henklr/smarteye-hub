"""
nox_connector.py — Phase 1 NOX (Securiton) integration for smarteye-hub.

Provides:
  • Modbus TCP poller — reads NOX input registers and decodes the per-bit
    status word (open / sabotage / deactivated / alarm / defined).
  • TIO ASCII listener — TCP server that accepts pipe-delimited messages
    pushed from a NOX TIO virtual output, parsing INP and AREA frames.

Both feed change events into flows.dispatch_flow_trigger so NOX inputs,
areas and alarms can drive flows alongside Automation HAT I/O.

Phase 2 (control / arm / disarm) is stubbed; the right register/REST
addresses come from the NOX integration manual once available.

Modbus register layout (community-derived, NoxConfig-driven):
    address = MMMMI   (4-digit module ID + 1-digit input index)
    16-bit value:
        bit 0  = open(1) / closed(0)
        bit 1  = sabotage
        bit 2  = deactivated
        bit 3  = alarm
        bit 15 = detector defined

TIO ASCII:
    INP<id>|<module-input>|<description>|<state>
    AREA<id>|<name>|<state>|<flags>
"""
from __future__ import annotations

import json
import logging
import os
import socket
import threading
import time
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

_log = logging.getLogger("nox")

try:
    from pymodbus.client import ModbusTcpClient  # type: ignore
    _PYMODBUS_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover — surfaced in state.error
    ModbusTcpClient = None  # type: ignore[assignment]
    _PYMODBUS_IMPORT_ERROR = str(exc)


DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
NOX_CONFIG_FILE = DATA_DIR / "nox_config.json"

DEFAULT_MODBUS_PORT = 502
DEFAULT_MODBUS_UNIT = 1
DEFAULT_MODBUS_POLL_SEC = 1.0
DEFAULT_TIO_LISTEN_HOST = "0.0.0.0"
DEFAULT_TIO_LISTEN_PORT = 9760
DEFAULT_TIO_SEND_PORT = 9761          # used as a default if user enables send without specifying
TIO_RECENT_MESSAGE_LIMIT = 100         # ring buffer size for diagnostics
TIO_SEND_TIMEOUT_SEC = 3.0
RECONNECT_BACKOFF_MIN = 2.0
RECONNECT_BACKOFF_MAX = 30.0


# ── Bit decoding ───────────────────────────────────────────────────────────────

def _decode_status_word(value: int) -> Dict[str, bool]:
    return {
        "open":         bool(value & 0x0001),
        "sabotage":     bool(value & 0x0002),
        "deactivated":  bool(value & 0x0004),
        "alarm":        bool(value & 0x0008),
        "defined":      bool(value & 0x8000),
    }


def _modbus_register_address(module: int, input_index: int) -> int:
    """NOX input address scheme: 4-digit module ID + 1-digit input → MMMMI."""
    return int(module) * 10 + int(input_index)


# Area state codes — official codes 0-6 per NOX Modbus Server doc (ARAS, v8.60+).
# Codes 7-9 are documented as "Customized" (install-specific). The 7+ entries
# below match the user's NOX ONE / R9 install (verified empirically).
NOX_AREA_STATE_NAMES: Dict[int, str] = {
    # Official (NOX doc) — these are universal:
    0: "unknown",
    1: "disarmed",            # Frakoblet
    2: "disarmed_exit",       # transitional
    3: "disarmed_exit_wait",  # transitional
    4: "disarmed_entry",      # transitional
    5: "armed",               # Tilkoblet
    6: "partly_armed",        # auto-only, not user-writable
    # Customized (7-9 per doc) — the values below match user's panel; may differ
    # on other installations:
    7: "on",                  # Til
    8: "off",                 # Fra
    9: "door_held_open",      # Dør fast åben
    10: "door_closed",        # Dør lukket
    11: "access_granted",     # Adgang godkendt
    12: "door_held_warning",  # Dør Holdt Advarsel
    13: "forced_open",        # Tvangsåbning
    14: "door_open",          # Dør åben
    15: "door_held_alarm",    # Dør Holdt Alarm
    16: "pending",            # Afventer
}

# State categories for UI colouring and "is this an alarm?" decisions.
NOX_AREA_ALARM_STATES = {"forced_open", "door_held_alarm"}
NOX_AREA_ARMED_STATES = {"armed", "partly_armed"}
NOX_AREA_TRANSITIONAL_STATES = {"disarmed_exit", "disarmed_exit_wait", "disarmed_entry", "pending"}
NOX_AREA_WARNING_STATES = {"door_held_open", "door_open", "door_held_warning", "off"}


def _decode_area_word(value: int) -> Dict[str, Any]:
    """Decode a NOX area register per the Modbus Server documentation.

    Bits 0-9: state code (decimal value, NOX 9.71+).
    Bit 10:   last setting failed (blocking time).
    Bit 11:   last setting failed (no rights).
    Bit 12:   last setting failed (active detectors in area).
    Bit 13:   last setting failed (active alarms in area).
    Bit 14:   active alarms in this area.
    Bit 15:   area defined / used by NOX.
    """
    code = value & 0x03FF
    return {
        "code": code,
        "state": NOX_AREA_STATE_NAMES.get(code, f"code:{code}"),
        "fail_blocking_time":     bool(value & (1 << 10)),
        "fail_no_rights":         bool(value & (1 << 11)),
        "fail_active_detectors":  bool(value & (1 << 12)),
        "fail_active_alarms":     bool(value & (1 << 13)),
        "alarm_active":           bool(value & (1 << 14)),
        "defined":                bool(value & (1 << 15)),
    }


def _area_failure_flags(decoded: Dict[str, Any]) -> List[str]:
    flags: List[str] = []
    if decoded.get("fail_blocking_time"):    flags.append("blocking_time")
    if decoded.get("fail_no_rights"):        flags.append("no_rights")
    if decoded.get("fail_active_detectors"): flags.append("active_detectors")
    if decoded.get("fail_active_alarms"):    flags.append("active_alarms")
    return flags


# ── State / config ─────────────────────────────────────────────────────────────

_state_lock = threading.RLock()
_config_lock = threading.RLock()

_state: Dict[str, Any] = {
    "supported": ModbusTcpClient is not None,
    "enabled": False,
    "modbus": {
        "enabled": False,
        "connected": False,
        "host": "",
        "port": DEFAULT_MODBUS_PORT,
        "unit_id": DEFAULT_MODBUS_UNIT,
        "poll_seconds": DEFAULT_MODBUS_POLL_SEC,
        "last_poll_at": None,
        "error": _PYMODBUS_IMPORT_ERROR or None,
        "inputs": [],   # list of {module, input, label, address, raw, flags{...}, updated_at}
        "areas": [],    # list of {area_id, label, address, raw, code, state, defined, updated_at}
    },
    "tio": {
        "enabled": False,
        "listening": False,
        "listen_host": DEFAULT_TIO_LISTEN_HOST,
        "listen_port": DEFAULT_TIO_LISTEN_PORT,
        "send_target_host": "",
        "send_target_port": 0,
        "last_message_at": None,
        "last_message": None,
        "last_send_at": None,
        "last_send": None,
        "error": None,
        "inputs": {},          # id -> {label, state, last_seen, raw, module_input, count}
        "areas": {},           # id -> {label, state, flags, last_seen, raw, count}
        "recent_messages": [], # bounded ring buffer of last RECENT_MESSAGE_LIMIT parsed frames
    },
}

_modbus_stop = threading.Event()
_modbus_thread: Optional[threading.Thread] = None
_modbus_paused = threading.Event()  # set → poller skips reads (used during write tests)
_tio_stop = threading.Event()
_tio_thread: Optional[threading.Thread] = None
_tio_server_socket: Optional[socket.socket] = None

_dispatch_trigger: Optional[Callable[[Dict[str, Any]], int]] = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_dispatch(event: Dict[str, Any]) -> None:
    cb = _dispatch_trigger
    if cb is None:
        return
    try:
        cb(event)
    except Exception as exc:
        _log.warning("Flow dispatch failed for %s: %s", event.get("kind"), exc)


# ── Configuration persistence ──────────────────────────────────────────────────

def _default_config() -> Dict[str, Any]:
    return {
        "enabled": False,
        "modbus": {
            "enabled": False,
            "host": "",
            "port": DEFAULT_MODBUS_PORT,
            "unit_id": DEFAULT_MODBUS_UNIT,
            "poll_seconds": DEFAULT_MODBUS_POLL_SEC,
            "inputs": [],   # [{module:int, input:int, label:str}]
            "areas": [],    # [{area_id:int, label:str}]
        },
        "tio": {
            "enabled": False,
            "listen_host": DEFAULT_TIO_LISTEN_HOST,
            "listen_port": DEFAULT_TIO_LISTEN_PORT,
            "send_enabled": False,
            "send_target_host": "",
            "send_target_port": DEFAULT_TIO_SEND_PORT,
        },
    }


def _validate_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    base = _default_config()
    cfg = cfg or {}
    base["enabled"] = bool(cfg.get("enabled", False))

    raw_mb = cfg.get("modbus") or {}
    mb = base["modbus"]
    mb["enabled"] = bool(raw_mb.get("enabled", False))
    mb["host"] = str(raw_mb.get("host") or "").strip()
    try:
        mb["port"] = int(raw_mb.get("port") or DEFAULT_MODBUS_PORT)
    except Exception:
        mb["port"] = DEFAULT_MODBUS_PORT
    try:
        mb["unit_id"] = int(raw_mb.get("unit_id") or DEFAULT_MODBUS_UNIT)
    except Exception:
        mb["unit_id"] = DEFAULT_MODBUS_UNIT
    try:
        mb["poll_seconds"] = max(0.2, float(raw_mb.get("poll_seconds") or DEFAULT_MODBUS_POLL_SEC))
    except Exception:
        mb["poll_seconds"] = DEFAULT_MODBUS_POLL_SEC

    inputs: List[Dict[str, Any]] = []
    seen: set = set()
    for raw in raw_mb.get("inputs") or []:
        try:
            module = int(raw.get("module"))
            input_idx = int(raw.get("input"))
        except Exception:
            continue
        if not (0 < module <= 9999) or not (0 <= input_idx <= 9):
            continue
        key = (module, input_idx)
        if key in seen:
            continue
        seen.add(key)
        inputs.append({
            "module": module,
            "input": input_idx,
            "label": str(raw.get("label") or f"Module {module} input {input_idx}").strip(),
        })
    mb["inputs"] = inputs

    areas: List[Dict[str, Any]] = []
    seen_areas: set = set()
    for raw in raw_mb.get("areas") or []:
        try:
            area_id = int(raw.get("area_id"))
        except Exception:
            continue
        if not (0 < area_id <= 9999):
            continue
        if area_id in seen_areas:
            continue
        seen_areas.add(area_id)
        areas.append({
            "area_id": area_id,
            "label": str(raw.get("label") or f"Area {area_id}").strip(),
        })
    mb["areas"] = areas

    raw_tio = cfg.get("tio") or {}
    tio = base["tio"]
    tio["enabled"] = bool(raw_tio.get("enabled", False))
    tio["listen_host"] = str(raw_tio.get("listen_host") or DEFAULT_TIO_LISTEN_HOST).strip() or DEFAULT_TIO_LISTEN_HOST
    try:
        tio["listen_port"] = int(raw_tio.get("listen_port") or DEFAULT_TIO_LISTEN_PORT)
    except Exception:
        tio["listen_port"] = DEFAULT_TIO_LISTEN_PORT
    tio["send_enabled"] = bool(raw_tio.get("send_enabled", False))
    tio["send_target_host"] = str(raw_tio.get("send_target_host") or "").strip()
    try:
        tio["send_target_port"] = int(raw_tio.get("send_target_port") or DEFAULT_TIO_SEND_PORT)
    except Exception:
        tio["send_target_port"] = DEFAULT_TIO_SEND_PORT

    return base


def load_nox_config() -> Dict[str, Any]:
    with _config_lock:
        if NOX_CONFIG_FILE.exists():
            try:
                raw = json.loads(NOX_CONFIG_FILE.read_text(encoding="utf-8"))
                return _validate_config(raw)
            except Exception as exc:
                _log.warning("Failed to parse NOX config (%s); returning defaults", exc)
        return _default_config()


def save_nox_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    validated = _validate_config(cfg)
    with _config_lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = NOX_CONFIG_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(validated, indent=2), encoding="utf-8")
        tmp.replace(NOX_CONFIG_FILE)
    _log.info(
        "NOX config saved (enabled=%s, modbus=%s/%d inputs, tio=%s)",
        validated["enabled"],
        validated["modbus"]["enabled"], len(validated["modbus"]["inputs"]),
        validated["tio"]["enabled"],
    )
    return validated


def nox_state() -> Dict[str, Any]:
    with _state_lock:
        return deepcopy(_state)


def _classify_area_kind(state_code: Optional[int]) -> str:
    """Categorise an area by its last-seen state code.

    - "intrusion"   : codes 0-6 — user-writable to 1 (disarm) or 5 (arm)
    - "virtual"     : codes 7-8 — virtual indicator (not user-writable)
    - "adk"         : codes 9-15 — door / access-control (not state-writable)
    - "unknown"     : we haven't seen a state yet
    """
    if state_code is None:
        return "unknown"
    if 0 <= state_code <= 6:
        return "intrusion"
    if state_code in (7, 8):
        return "virtual"
    return "adk"


def nox_catalog() -> Dict[str, Any]:
    """Return configured NOX inputs and areas for use in flow node UIs.

    Each input/area entry includes the most recent live state (from the poller
    snapshot) so the UI can categorise writable vs read-only areas without
    needing a separate API call.
    """
    cfg = load_nox_config()
    mb = cfg.get("modbus") or {}

    # Snapshot live state once for the join below.
    snap = nox_state()
    snap_inputs = {
        (e.get("module"), e.get("input")): e
        for e in (snap.get("modbus") or {}).get("inputs") or []
    }
    snap_areas = {
        e.get("area_id"): e
        for e in (snap.get("modbus") or {}).get("areas") or []
    }

    inputs: List[Dict[str, Any]] = []
    for entry in mb.get("inputs") or []:
        try:
            module = int(entry.get("module"))
            input_idx = int(entry.get("input"))
        except Exception:
            continue
        live = snap_inputs.get((module, input_idx)) or {}
        inputs.append({
            "module": module,
            "input": input_idx,
            "address": _modbus_register_address(module, input_idx),
            "label": str(entry.get("label") or "").strip(),
            "live": {
                "raw": live.get("raw"),
                "flags": live.get("flags") or {},
                "updated_at": live.get("updated_at"),
            },
        })

    areas: List[Dict[str, Any]] = []
    for entry in mb.get("areas") or []:
        try:
            area_id = int(entry.get("area_id"))
        except Exception:
            continue
        live = snap_areas.get(area_id) or {}
        code = live.get("code")
        kind = _classify_area_kind(code if isinstance(code, int) else None)
        areas.append({
            "area_id": area_id,
            "address": area_id,
            "label": str(entry.get("label") or "").strip(),
            "kind": kind,
            "writable": kind == "intrusion",
            "live": {
                "raw": live.get("raw"),
                "code": code,
                "state": live.get("state"),
                "alarm_active": live.get("alarm_active"),
                "updated_at": live.get("updated_at"),
            },
        })
    # TIO-discovered entities — these may exist even when no Modbus inputs are
    # configured. They're populated as messages arrive from the panel.
    tio_inputs: List[Dict[str, Any]] = []
    tio_areas: List[Dict[str, Any]] = []
    tio_state = (snap.get("tio") or {})
    for tid, info in (tio_state.get("inputs") or {}).items():
        tio_inputs.append({
            "id": tid,
            "label": info.get("label") or "",
            "state": info.get("state"),
            "module_input": info.get("module_input"),
            "last_seen": info.get("last_seen"),
        })
    for tid, info in (tio_state.get("areas") or {}).items():
        tio_areas.append({
            "id": tid,
            "label": info.get("label") or "",
            "state": info.get("state"),
            "last_seen": info.get("last_seen"),
        })
    tio_inputs.sort(key=lambda e: int(e["id"]) if str(e["id"]).isdigit() else 999999)
    tio_areas.sort(key=lambda e: int(e["id"]) if str(e["id"]).isdigit() else 999999)

    return {
        "inputs": inputs,
        "areas": areas,
        "tio_inputs": tio_inputs,
        "tio_areas": tio_areas,
        "configured": bool(cfg.get("enabled")) and (bool(inputs) or bool(areas) or bool(tio_inputs) or bool(tio_areas)),
    }


# ── Modbus polling ─────────────────────────────────────────────────────────────

def _set_modbus_runtime(**fields) -> None:
    with _state_lock:
        _state["modbus"].update(fields)


def _set_modbus_inputs(entries: List[Dict[str, Any]]) -> None:
    with _state_lock:
        _state["modbus"]["inputs"] = entries


def _set_modbus_areas(entries: List[Dict[str, Any]]) -> None:
    with _state_lock:
        _state["modbus"]["areas"] = entries


def _build_modbus_input_entry(module: int, input_idx: int, label: str) -> Dict[str, Any]:
    return {
        "module": module,
        "input": input_idx,
        "label": label,
        "address": _modbus_register_address(module, input_idx),
        "raw": None,
        "flags": _decode_status_word(0),
        "updated_at": None,
    }


def _build_modbus_area_entry(area_id: int, label: str) -> Dict[str, Any]:
    decoded = _decode_area_word(0)
    return {
        "area_id": area_id,
        "label": label,
        "address": area_id,
        "raw": None,
        "code": decoded["code"],
        "state": decoded["state"],
        "defined": decoded["defined"],
        "updated_at": None,
    }


def _modbus_loop(cfg_modbus: Dict[str, Any]) -> None:
    if ModbusTcpClient is None:
        _set_modbus_runtime(connected=False, error=f"pymodbus not available: {_PYMODBUS_IMPORT_ERROR}")
        return

    host = cfg_modbus["host"]
    port = int(cfg_modbus["port"])
    unit = int(cfg_modbus["unit_id"])
    poll = float(cfg_modbus["poll_seconds"])
    inputs_cfg: List[Dict[str, Any]] = list(cfg_modbus.get("inputs") or [])
    areas_cfg: List[Dict[str, Any]] = list(cfg_modbus.get("areas") or [])

    if not host or (not inputs_cfg and not areas_cfg):
        _set_modbus_runtime(
            connected=False,
            error="No host or nothing to poll" if host else "No host configured",
        )
        return

    entries = [_build_modbus_input_entry(i["module"], i["input"], i.get("label", "")) for i in inputs_cfg]
    area_entries = [_build_modbus_area_entry(a["area_id"], a.get("label", "")) for a in areas_cfg]
    _set_modbus_inputs(entries)
    _set_modbus_areas(area_entries)

    previous: Dict[int, int] = {}      # address -> last raw value
    previous_flags: Dict[int, Dict[str, bool]] = {}
    previous_area: Dict[int, int] = {}             # area_id -> last raw
    previous_area_state: Dict[int, str] = {}       # area_id -> last state name
    previous_area_alarm: Dict[int, bool] = {}      # area_id -> last alarm_active flag
    backoff = RECONNECT_BACKOFF_MIN
    client: Optional[Any] = None

    while not _modbus_stop.is_set():
        if _modbus_paused.is_set():
            # Pause requested (e.g. during a write test). Sleep briefly and re-check.
            if _modbus_stop.wait(0.1):
                break
            continue
        try:
            if client is None:
                client = ModbusTcpClient(host, port=port, timeout=3.0)
                if not client.connect():
                    raise ConnectionError(f"Could not connect to NOX Modbus at {host}:{port}")
                _set_modbus_runtime(connected=True, error=None)
                _log.info("NOX Modbus connected to %s:%d (unit %d)", host, port, unit)
                backoff = RECONNECT_BACKOFF_MIN

            ts = _utc_now_iso()
            updated_entries: List[Dict[str, Any]] = []
            had_error = False

            for entry in entries:
                addr = entry["address"]
                try:
                    rr = _read_registers(client, "holding", addr, 1, unit)
                except Exception as exc:
                    _log.debug("NOX Modbus read at %d failed: %s", addr, exc)
                    rr = None

                if rr is None or getattr(rr, "isError", lambda: True)():
                    had_error = True
                    new_entry = dict(entry)
                    new_entry["updated_at"] = ts
                    updated_entries.append(new_entry)
                    continue

                raw = int(rr.registers[0]) & 0xFFFF
                flags = _decode_status_word(raw)
                new_entry = dict(entry)
                new_entry["raw"] = raw
                new_entry["flags"] = flags
                new_entry["updated_at"] = ts
                updated_entries.append(new_entry)

                prev_raw = previous.get(addr)
                prev_flags = previous_flags.get(addr)

                if prev_raw is not None and prev_raw != raw:
                    _safe_dispatch({
                        "kind": "nox_input_changed",
                        "source": "modbus",
                        "module": entry["module"],
                        "input": entry["input"],
                        "address": addr,
                        "label": entry["label"],
                        "raw": raw,
                        "previous_raw": prev_raw,
                        "flags": flags,
                        "previous_flags": prev_flags,
                        "ts": ts,
                        "extra": {
                            "module": entry["module"],
                            "input": entry["input"],
                            "address": addr,
                            "raw": raw,
                            "flags": flags,
                        },
                    })

                    if prev_flags and prev_flags.get("alarm") != flags["alarm"]:
                        _safe_dispatch({
                            "kind": "nox_alarm_changed",
                            "source": "modbus",
                            "scope": "input",
                            "module": entry["module"],
                            "input": entry["input"],
                            "address": addr,
                            "label": entry["label"],
                            "alarm": flags["alarm"],
                            "previous_alarm": prev_flags.get("alarm"),
                            "ts": ts,
                            "extra": {
                                "scope": "input",
                                "module": entry["module"],
                                "input": entry["input"],
                                "alarm": flags["alarm"],
                            },
                        })

                previous[addr] = raw
                previous_flags[addr] = flags

            _set_modbus_inputs(updated_entries)
            entries = updated_entries

            updated_areas: List[Dict[str, Any]] = []
            for area_entry in area_entries:
                area_id = area_entry["area_id"]
                try:
                    rr = _read_registers(client, "holding", area_id, 1, unit)
                except Exception as exc:
                    _log.debug("NOX area read at %d failed: %s", area_id, exc)
                    rr = None

                if rr is None or getattr(rr, "isError", lambda: True)():
                    had_error = True
                    new_area = dict(area_entry)
                    new_area["updated_at"] = ts
                    updated_areas.append(new_area)
                    continue

                raw = int(rr.registers[0]) & 0xFFFF
                decoded = _decode_area_word(raw)
                new_area = dict(area_entry)
                new_area["raw"] = raw
                new_area["code"] = decoded["code"]
                new_area["state"] = decoded["state"]
                new_area["defined"] = decoded["defined"]
                new_area["updated_at"] = ts
                updated_areas.append(new_area)

                prev_raw = previous_area.get(area_id)
                prev_state = previous_area_state.get(area_id)
                prev_alarm = previous_area_alarm.get(area_id)
                cur_alarm = bool(decoded.get("alarm_active"))

                if prev_state is not None and prev_state != decoded["state"]:
                    _safe_dispatch({
                        "kind": "nox_area_changed",
                        "source": "modbus",
                        "id": str(area_id),
                        "area_id": area_id,
                        "label": area_entry["label"],
                        "raw": raw,
                        "previous_raw": prev_raw,
                        "code": decoded["code"],
                        "state": decoded["state"],
                        "previous_state": prev_state,
                        "alarm_active": cur_alarm,
                        "ts": ts,
                        "extra": {
                            "area_id": area_id,
                            "raw": raw,
                            "state": decoded["state"],
                            "code": decoded["code"],
                            "alarm_active": cur_alarm,
                        },
                    })

                # Independent alarm-bit (14) tracking: this can flip without the
                # state code changing — e.g. an area enters alarm while armed.
                if prev_alarm is not None and prev_alarm != cur_alarm:
                    _safe_dispatch({
                        "kind": "nox_alarm_changed",
                        "source": "modbus_area",
                        "scope": "area",
                        "id": str(area_id),
                        "area_id": area_id,
                        "label": area_entry["label"],
                        "alarm": cur_alarm,
                        "previous_alarm": prev_alarm,
                        "state": decoded["state"],
                        "raw": raw,
                        "ts": ts,
                        "extra": {
                            "scope": "area",
                            "area_id": area_id,
                            "alarm": cur_alarm,
                            "state": decoded["state"],
                        },
                    })

                previous_area[area_id] = raw
                previous_area_state[area_id] = decoded["state"]
                previous_area_alarm[area_id] = cur_alarm

            _set_modbus_areas(updated_areas)
            area_entries = updated_areas

            _set_modbus_runtime(last_poll_at=ts, error=None if not had_error else "Some registers returned errors")

        except Exception as exc:
            _log.warning("NOX Modbus error: %s", exc)
            _set_modbus_runtime(connected=False, error=str(exc))
            try:
                if client is not None:
                    client.close()
            except Exception:
                pass
            client = None
            if _modbus_stop.wait(backoff):
                return
            backoff = min(RECONNECT_BACKOFF_MAX, backoff * 2)
            continue

        if _modbus_stop.wait(poll):
            break

    try:
        if client is not None:
            client.close()
    except Exception:
        pass
    _set_modbus_runtime(connected=False)


# ── TIO ASCII listener ─────────────────────────────────────────────────────────

def _set_tio_runtime(**fields) -> None:
    with _state_lock:
        _state["tio"].update(fields)


def _record_tio_input(frame_id: str, payload: Dict[str, Any], ts: str) -> Tuple[Optional[str], Optional[str]]:
    """Upsert a TIO input entity. Returns (previous_state, current_state) for change detection."""
    with _state_lock:
        bucket = _state["tio"].setdefault("inputs", {})
        existing = bucket.get(frame_id) or {}
        prev_state = existing.get("state")
        cur_state = payload.get("state")
        bucket[frame_id] = {
            "id": frame_id,
            "label": payload.get("description") or existing.get("label") or "",
            "module_input": payload.get("module_input") or existing.get("module_input") or "",
            "state": cur_state,
            "previous_state": prev_state,
            "raw": payload.get("raw"),
            "first_seen": existing.get("first_seen") or ts,
            "last_seen": ts,
            "count": int(existing.get("count") or 0) + 1,
        }
    return prev_state, cur_state


def _record_tio_area(frame_id: str, payload: Dict[str, Any], ts: str) -> Tuple[Optional[str], Optional[str]]:
    with _state_lock:
        bucket = _state["tio"].setdefault("areas", {})
        existing = bucket.get(frame_id) or {}
        prev_state = existing.get("state")
        cur_state = payload.get("state")
        bucket[frame_id] = {
            "id": frame_id,
            "label": payload.get("name") or existing.get("label") or "",
            "state": cur_state,
            "previous_state": prev_state,
            "flags": payload.get("flags"),
            "raw": payload.get("raw"),
            "first_seen": existing.get("first_seen") or ts,
            "last_seen": ts,
            "count": int(existing.get("count") or 0) + 1,
        }
    return prev_state, cur_state


def _record_tio_recent(payload: Dict[str, Any]) -> None:
    """Append to the bounded ring buffer of recent messages (newest last)."""
    with _state_lock:
        buf = _state["tio"].setdefault("recent_messages", [])
        buf.append(payload)
        excess = len(buf) - TIO_RECENT_MESSAGE_LIMIT
        if excess > 0:
            del buf[:excess]


def _parse_tio_message(line: str) -> Optional[Dict[str, Any]]:
    line = line.strip()
    if not line:
        return None
    parts = line.split("|")
    head = parts[0].strip()
    rest = parts[1:]

    if head.startswith("INP"):
        return {
            "type": "input",
            "id": head[3:].strip(),
            "module_input": rest[0].strip() if len(rest) > 0 else "",
            "description": rest[1].strip() if len(rest) > 1 else "",
            "state": rest[2].strip() if len(rest) > 2 else "",
            "extra": rest[3:],
            "raw": line,
        }

    if head.startswith("AREA"):
        return {
            "type": "area",
            "id": head[4:].strip(),
            "name": rest[0].strip() if len(rest) > 0 else "",
            "state": rest[1].strip() if len(rest) > 1 else "",
            "flags": rest[2].strip() if len(rest) > 2 else "",
            "extra": rest[3:],
            "raw": line,
        }

    return {"type": "unknown", "raw": line}


def _handle_tio_client(conn: socket.socket, addr: Tuple[str, int]) -> None:
    _log.info("NOX TIO client connected from %s", addr)
    buffer = b""
    try:
        conn.settimeout(60.0)
        while not _tio_stop.is_set():
            try:
                chunk = conn.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if not chunk:
                break

            buffer += chunk
            # NOX may use \r\n or \n or \r as separators
            while True:
                idx = -1
                for sep in (b"\r\n", b"\n", b"\r"):
                    found = buffer.find(sep)
                    if found != -1 and (idx == -1 or found < idx):
                        idx = found
                        sep_len = len(sep)
                if idx == -1:
                    break

                line_bytes = buffer[:idx]
                buffer = buffer[idx + sep_len:]
                try:
                    line = line_bytes.decode("utf-8", errors="replace")
                except Exception:
                    continue

                parsed = _parse_tio_message(line)
                if not parsed:
                    continue

                ts = _utc_now_iso()
                parsed["ts"] = ts
                parsed["from"] = f"{addr[0]}:{addr[1]}"
                _set_tio_runtime(last_message_at=ts, last_message=parsed)
                _record_tio_recent(parsed)

                if parsed["type"] == "input":
                    frame_id = parsed["id"] or parsed["raw"]
                    prev_state, cur_state = _record_tio_input(frame_id, parsed, ts)
                    # Always dispatch (even if state didn't change) — it's an explicit
                    # status push from the panel and downstream flows can choose to
                    # filter on previous_state vs state.
                    _safe_dispatch({
                        "kind": "nox_input_changed",
                        "source": "tio",
                        "id": parsed["id"],
                        "module_input": parsed.get("module_input"),
                        "label": parsed.get("description"),
                        "state": cur_state,
                        "previous_state": prev_state,
                        "ts": ts,
                        "extra": {
                            "id": parsed["id"],
                            "module_input": parsed.get("module_input"),
                            "state": cur_state,
                            "previous_state": prev_state,
                        },
                    })
                elif parsed["type"] == "area":
                    frame_id = parsed["id"] or parsed["raw"]
                    prev_state, cur_state = _record_tio_area(frame_id, parsed, ts)
                    _safe_dispatch({
                        "kind": "nox_area_changed",
                        "source": "tio",
                        "id": parsed["id"],
                        "label": parsed.get("name"),
                        "state": cur_state,
                        "previous_state": prev_state,
                        "flags": parsed.get("flags"),
                        "ts": ts,
                        "extra": {
                            "id": parsed["id"],
                            "name": parsed.get("name"),
                            "state": cur_state,
                            "previous_state": prev_state,
                            "flags": parsed.get("flags"),
                        },
                    })
                else:
                    _log.debug("NOX TIO unrecognized line: %s", line)
    finally:
        try:
            conn.close()
        except Exception:
            pass
        _log.info("NOX TIO client disconnected from %s", addr)


def _tio_loop(cfg_tio: Dict[str, Any]) -> None:
    global _tio_server_socket
    listen_host = cfg_tio["listen_host"]
    listen_port = int(cfg_tio["listen_port"])

    backoff = RECONNECT_BACKOFF_MIN
    while not _tio_stop.is_set():
        srv: Optional[socket.socket] = None
        try:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind((listen_host, listen_port))
            srv.listen(4)
            srv.settimeout(1.0)
            _tio_server_socket = srv
            _set_tio_runtime(listening=True, error=None)
            _log.info("NOX TIO listener bound to %s:%d", listen_host, listen_port)
            backoff = RECONNECT_BACKOFF_MIN

            while not _tio_stop.is_set():
                try:
                    conn, addr = srv.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                threading.Thread(
                    target=_handle_tio_client,
                    args=(conn, addr),
                    daemon=True,
                    name="nox-tio-client",
                ).start()
        except Exception as exc:
            _log.warning("NOX TIO listener error: %s", exc)
            _set_tio_runtime(listening=False, error=str(exc))
            if _tio_stop.wait(backoff):
                break
            backoff = min(RECONNECT_BACKOFF_MAX, backoff * 2)
        finally:
            try:
                if srv is not None:
                    srv.close()
            except Exception:
                pass
            _tio_server_socket = None

    _set_tio_runtime(listening=False)


# ── Lifecycle ──────────────────────────────────────────────────────────────────

def start_nox_connector(dispatch_trigger: Callable[[Dict[str, Any]], int]) -> None:
    """Start Modbus poller and TIO listener according to current config."""
    global _dispatch_trigger, _modbus_thread, _tio_thread

    _dispatch_trigger = dispatch_trigger
    cfg = load_nox_config()

    with _state_lock:
        _state["enabled"] = bool(cfg.get("enabled"))
        _state["modbus"]["enabled"] = bool(cfg["modbus"].get("enabled"))
        _state["modbus"]["host"] = cfg["modbus"].get("host", "")
        _state["modbus"]["port"] = cfg["modbus"].get("port", DEFAULT_MODBUS_PORT)
        _state["modbus"]["unit_id"] = cfg["modbus"].get("unit_id", DEFAULT_MODBUS_UNIT)
        _state["modbus"]["poll_seconds"] = cfg["modbus"].get("poll_seconds", DEFAULT_MODBUS_POLL_SEC)
        _state["modbus"]["inputs"] = [
            _build_modbus_input_entry(i["module"], i["input"], i.get("label", ""))
            for i in cfg["modbus"].get("inputs", [])
        ]
        _state["modbus"]["areas"] = [
            _build_modbus_area_entry(a["area_id"], a.get("label", ""))
            for a in cfg["modbus"].get("areas", [])
        ]
        _state["modbus"]["error"] = None if ModbusTcpClient is not None else f"pymodbus not available: {_PYMODBUS_IMPORT_ERROR}"
        _state["tio"]["enabled"] = bool(cfg["tio"].get("enabled"))
        _state["tio"]["listen_host"] = cfg["tio"].get("listen_host", DEFAULT_TIO_LISTEN_HOST)
        _state["tio"]["listen_port"] = cfg["tio"].get("listen_port", DEFAULT_TIO_LISTEN_PORT)
        _state["tio"]["send_target_host"] = cfg["tio"].get("send_target_host", "")
        _state["tio"]["send_target_port"] = cfg["tio"].get("send_target_port", DEFAULT_TIO_SEND_PORT)
        _state["tio"]["error"] = None

    if not cfg["enabled"]:
        _log.info("NOX connector disabled in config — not starting")
        return

    if cfg["modbus"]["enabled"]:
        if ModbusTcpClient is None:
            _log.warning("NOX Modbus enabled but pymodbus is not installed (%s)", _PYMODBUS_IMPORT_ERROR)
        elif not cfg["modbus"]["host"]:
            _log.warning("NOX Modbus enabled but no host configured")
        else:
            _modbus_stop.clear()
            _modbus_thread = threading.Thread(
                target=_modbus_loop,
                args=(deepcopy(cfg["modbus"]),),
                daemon=True,
                name="nox-modbus",
            )
            _modbus_thread.start()
            _log.info("NOX Modbus poller starting (%s:%d)",
                      cfg["modbus"]["host"], cfg["modbus"]["port"])

    if cfg["tio"]["enabled"]:
        _tio_stop.clear()
        _tio_thread = threading.Thread(
            target=_tio_loop,
            args=(deepcopy(cfg["tio"]),),
            daemon=True,
            name="nox-tio",
        )
        _tio_thread.start()
        _log.info("NOX TIO listener starting on %s:%d",
                  cfg["tio"]["listen_host"], cfg["tio"]["listen_port"])


def stop_nox_connector() -> None:
    global _modbus_thread, _tio_thread, _tio_server_socket

    _modbus_stop.set()
    _tio_stop.set()

    srv = _tio_server_socket
    if srv is not None:
        try:
            srv.close()
        except Exception:
            pass

    for thread in (_modbus_thread, _tio_thread):
        if thread is not None and thread.is_alive():
            try:
                thread.join(timeout=2.0)
            except Exception:
                pass

    _modbus_thread = None
    _tio_thread = None
    _tio_server_socket = None

    with _state_lock:
        _state["modbus"]["connected"] = False
        _state["tio"]["listening"] = False


def restart_nox_connector(dispatch_trigger: Callable[[Dict[str, Any]], int]) -> None:
    stop_nox_connector()
    # Allow OS time to release the listening socket before rebinding.
    time.sleep(0.2)
    start_nox_connector(dispatch_trigger)


# ── TIO outbound send ──────────────────────────────────────────────────────────


def tio_send(
    message: str,
    host: Optional[str] = None,
    port: Optional[int] = None,
    append_newline: bool = True,
    encoding: str = "utf-8",
) -> Dict[str, Any]:
    """Send a single ASCII message to a NOX TIO virtual-input listener.

    NOX TIO can be configured with virtual *inputs* on the panel side that
    accept incoming TCP messages and trigger NoxConfig-side logic. The exact
    message format is whatever the installer configured in NoxConfig — this
    function is intentionally format-agnostic and just ships the raw string.

    By default appends `\\n` so the panel sees a complete line. The connection
    is closed immediately after the send.
    """
    cfg = load_nox_config()
    tio_cfg = cfg.get("tio") or {}
    host = (host if host is not None else tio_cfg.get("send_target_host", "")).strip()
    try:
        port = int(port if port is not None else tio_cfg.get("send_target_port", DEFAULT_TIO_SEND_PORT))
    except Exception:
        port = DEFAULT_TIO_SEND_PORT

    if not host:
        raise ValueError("TIO send target host is not configured")
    if not (0 < port < 65536):
        raise ValueError("TIO send target port is invalid")

    payload = message
    if append_newline and not payload.endswith(("\n", "\r\n", "\r")):
        payload = payload + "\n"

    ts = _utc_now_iso()
    sock: Optional[socket.socket] = None
    sent_ok = False
    error: Optional[str] = None
    try:
        sock = socket.create_connection((host, port), timeout=TIO_SEND_TIMEOUT_SEC)
        sock.settimeout(TIO_SEND_TIMEOUT_SEC)
        sock.sendall(payload.encode(encoding, errors="replace"))
        sent_ok = True
    except Exception as exc:
        error = str(exc)
        _log.warning("TIO send to %s:%d failed: %s", host, port, exc)
    finally:
        try:
            if sock is not None:
                sock.close()
        except Exception:
            pass

    record = {
        "host": host,
        "port": port,
        "message": message,
        "sent_ok": sent_ok,
        "error": error,
        "ts": ts,
    }
    with _state_lock:
        _state["tio"]["last_send_at"] = ts
        _state["tio"]["last_send"] = record

    if sent_ok:
        _log.info("TIO sent to %s:%d (%d bytes)", host, port, len(payload))
    return record


# ── Discovery scan ─────────────────────────────────────────────────────────────

MODBUS_MAX_READ = 125  # Modbus FC03/FC04 spec max registers per request
SCAN_MODULE_LIMIT = 2000  # safety cap (~20,000 registers)

MODBUS_EXCEPTION_NAMES = {
    1: "ILLEGAL_FUNCTION",
    2: "ILLEGAL_DATA_ADDRESS",
    3: "ILLEGAL_DATA_VALUE",
    4: "SLAVE_DEVICE_FAILURE",
    5: "ACKNOWLEDGE",
    6: "SLAVE_DEVICE_BUSY",
    8: "MEMORY_PARITY_ERROR",
    10: "GATEWAY_PATH_UNAVAILABLE",
    11: "GATEWAY_TARGET_DEVICE_FAILED_TO_RESPOND",
}


_modbus_unit_kw: Optional[str] = None  # "device_id" | "slave" | "unit" | "_positional_"
_modbus_unit_kw_lock = threading.Lock()


def _read_registers(client, function_code: str, address: int, count: int, unit_id: int):
    """Call read_holding_registers / read_input_registers across pymodbus versions.

    pymodbus has churned the unit-id keyword name across versions:
      - very old:  unit=
      - 3.0-3.6:   slave=
      - 3.7+:      device_id=
    Probe each, cache whichever works for subsequent calls, fall back to
    positional-only (no unit_id) as a last resort.
    """
    global _modbus_unit_kw
    method = client.read_input_registers if function_code == "input" else client.read_holding_registers

    cached = _modbus_unit_kw
    if cached is not None:
        try:
            if cached == "_positional_":
                return method(address, count)
            return method(address, count=count, **{cached: unit_id})
        except TypeError:
            with _modbus_unit_kw_lock:
                _modbus_unit_kw = None  # invalidate

    last_exc: Optional[Exception] = None
    for kw in ("device_id", "slave", "unit"):
        try:
            result = method(address, count=count, **{kw: unit_id})
            with _modbus_unit_kw_lock:
                _modbus_unit_kw = kw
            return result
        except TypeError as exc:
            last_exc = exc
            continue

    try:
        result = method(address, count)
        with _modbus_unit_kw_lock:
            _modbus_unit_kw = "_positional_"
        return result
    except TypeError as exc:
        last_exc = exc

    raise last_exc if last_exc else RuntimeError("Modbus read: no known signature accepted")


def _call_with_unit_kw(method, *args, unit_id: int):
    """Run `method(*args, <unit_kw>=unit_id)` across pymodbus version variants."""
    global _modbus_unit_kw

    cached = _modbus_unit_kw
    if cached is not None and cached != "_positional_":
        try:
            return method(*args, **{cached: unit_id})
        except TypeError:
            with _modbus_unit_kw_lock:
                _modbus_unit_kw = None

    last_exc: Optional[Exception] = None
    for kw in ("device_id", "slave", "unit"):
        try:
            result = method(*args, **{kw: unit_id})
            with _modbus_unit_kw_lock:
                _modbus_unit_kw = kw
            return result
        except TypeError as exc:
            last_exc = exc
            continue

    try:
        result = method(*args)
        with _modbus_unit_kw_lock:
            _modbus_unit_kw = "_positional_"
        return result
    except TypeError as exc:
        last_exc = exc

    raise last_exc if last_exc else RuntimeError("Modbus call: no known signature accepted")


def _write_register(client, address: int, value: int, unit_id: int):
    """FC06 (write_single_register)."""
    return _call_with_unit_kw(client.write_register, address, value, unit_id=unit_id)


def _write_registers(client, address: int, values: List[int], unit_id: int):
    """FC16 (write_multiple_registers)."""
    return _call_with_unit_kw(client.write_registers, address, values, unit_id=unit_id)


def _write_coil(client, address: int, value: bool, unit_id: int):
    """FC05 (write_single_coil)."""
    return _call_with_unit_kw(client.write_coil, address, bool(value), unit_id=unit_id)


def _write_coils(client, address: int, values: List[bool], unit_id: int):
    """FC15 (write_multiple_coils)."""
    return _call_with_unit_kw(client.write_coils, address, [bool(v) for v in values], unit_id=unit_id)


def _mask_write_register(client, address: int, and_mask: int, or_mask: int, unit_id: int):
    """FC22 (mask_write_register).

    new_value = (current & and_mask) | (or_mask & ~and_mask)

    Used by NOX for: setting/clearing bit 7 (input deactivation) and bit 6
    (single-alarm acknowledge) per the official doc.
    """
    return _call_with_unit_kw(
        client.mask_write_register,
        address, int(and_mask) & 0xFFFF, int(or_mask) & 0xFFFF,
        unit_id=unit_id,
    )


def _format_modbus_error(rr) -> str:
    if rr is None:
        return "no response"
    try:
        code = getattr(rr, "exception_code", None)
        if code is not None:
            name = MODBUS_EXCEPTION_NAMES.get(int(code), "UNKNOWN")
            return f"exception {code} ({name})"
    except Exception:
        pass
    return str(rr)


def _probe_function_code(client, address: int, unit_id: int) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    """Try one register at `address` with FC03 then FC04. Return whichever
    works (or None) plus the diagnostics for both attempts.
    """
    diagnostics: List[Dict[str, Any]] = []
    for fc in ("holding", "input"):
        try:
            rr = _read_registers(client, fc, address, 1, unit_id)
        except Exception as exc:
            diagnostics.append({"function_code": fc, "ok": False, "error": str(exc)})
            continue
        if rr is None or getattr(rr, "isError", lambda: True)():
            diagnostics.append({
                "function_code": fc,
                "ok": False,
                "error": _format_modbus_error(rr),
            })
            continue
        diagnostics.append({"function_code": fc, "ok": True})
        return fc, diagnostics
    return None, diagnostics


def scan_modbus_range(
    host: Optional[str] = None,
    port: Optional[int] = None,
    unit_id: Optional[int] = None,
    start_module: int = 1001,
    end_module: int = 1020,
    only_defined: bool = True,
    function_code: str = "auto",
) -> Dict[str, Any]:
    """One-shot scan of NOX Modbus registers across a module-ID range.

    function_code:
      "auto"    — probe FC03 (holding) then FC04 (input), use whichever works.
      "holding" — force FC03.
      "input"   — force FC04.

    Returns a list of inputs the panel reports as defined (or all if
    only_defined=False), each annotated with current flags. Opens its own
    short-lived TCP connection so it works whether or not the live poller
    is running.
    """
    if ModbusTcpClient is None:
        raise RuntimeError(f"pymodbus not available: {_PYMODBUS_IMPORT_ERROR}")

    cfg = load_nox_config()
    mb = cfg.get("modbus") or {}
    host = (host if host is not None else mb.get("host", "")).strip()
    port = int(port if port is not None else mb.get("port", DEFAULT_MODBUS_PORT))
    unit_id = int(unit_id if unit_id is not None else mb.get("unit_id", DEFAULT_MODBUS_UNIT))

    if not host:
        raise ValueError("NOX Modbus host is not configured")

    try:
        start_module = int(start_module)
        end_module = int(end_module)
    except Exception:
        raise ValueError("start_module and end_module must be integers")

    if start_module < 1 or end_module < start_module:
        raise ValueError("Invalid module range")
    if end_module - start_module + 1 > SCAN_MODULE_LIMIT:
        raise ValueError(f"Module range too large (max {SCAN_MODULE_LIMIT} modules per scan)")

    if function_code not in ("auto", "holding", "input"):
        raise ValueError("function_code must be auto, holding or input")

    start_addr = start_module * 10
    end_addr = end_module * 10 + 9

    found: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    diagnostics: List[Dict[str, Any]] = []
    ts = _utc_now_iso()

    client = ModbusTcpClient(host, port=port, timeout=3.0)
    try:
        if not client.connect():
            raise ConnectionError(f"Could not connect to NOX Modbus at {host}:{port}")

        # Decide which function code to use.
        fc_used: Optional[str]
        if function_code == "auto":
            fc_used, probe_diag = _probe_function_code(client, start_addr, unit_id)
            diagnostics = probe_diag
            if fc_used is None:
                # Try a second probe at end_addr in case start_addr was unmapped.
                fc_used, probe2_diag = _probe_function_code(client, end_addr, unit_id)
                for d in probe2_diag:
                    d["address"] = end_addr
                    diagnostics.append(d)
                if fc_used is None:
                    return {
                        "host": host, "port": port, "unit_id": unit_id,
                        "start_module": start_module, "end_module": end_module,
                        "ts": ts,
                        "function_code_used": None,
                        "found": [], "errors": [],
                        "diagnostics": diagnostics,
                        "warning": (
                            "Auto-detect could not find a working function code. "
                            "Connection succeeded but neither FC03 (holding) nor FC04 (input) "
                            "returned valid data at the start or end of the range."
                        ),
                    }
        else:
            fc_used = function_code

        addr = start_addr
        while addr <= end_addr:
            chunk = min(MODBUS_MAX_READ, end_addr - addr + 1)
            try:
                rr = _read_registers(client, fc_used, addr, chunk, unit_id)
            except Exception as exc:
                errors.append({"address": addr, "count": chunk, "error": str(exc)})
                addr += chunk
                continue

            if rr is None or getattr(rr, "isError", lambda: True)():
                # Whole chunk failed — common when the range hits unmapped modules.
                errors.append({
                    "address": addr,
                    "count": chunk,
                    "error": _format_modbus_error(rr),
                })
                addr += chunk
                continue

            for offset, raw in enumerate(rr.registers):
                this_addr = addr + offset
                module = this_addr // 10
                input_idx = this_addr % 10
                value = int(raw) & 0xFFFF
                flags = _decode_status_word(value)
                if only_defined and not flags["defined"]:
                    continue
                found.append({
                    "module": module,
                    "input": input_idx,
                    "address": this_addr,
                    "raw": value,
                    "flags": flags,
                })

            addr += chunk
    finally:
        try:
            client.close()
        except Exception:
            pass

    _log.info(
        "NOX Modbus scan %s:%d modules %d-%d FC=%s → %d defined input(s), %d chunk error(s)",
        host, port, start_module, end_module, fc_used, len(found), len(errors),
    )

    return {
        "host": host,
        "port": port,
        "unit_id": unit_id,
        "start_module": start_module,
        "end_module": end_module,
        "ts": ts,
        "function_code_used": fc_used,
        "found": found,
        "errors": errors,
        "diagnostics": diagnostics,
    }


PROBE_ADDRESS_LIMIT = 5000  # safety cap for raw-register probe


def discover_areas(
    host: Optional[str] = None,
    port: Optional[int] = None,
    unit_id: Optional[int] = None,
    max_area_id: int = 64,
) -> Dict[str, Any]:
    """Scan area registers 1..max_area_id and return defined areas (bit 15 set)."""
    if ModbusTcpClient is None:
        raise RuntimeError(f"pymodbus not available: {_PYMODBUS_IMPORT_ERROR}")

    cfg = load_nox_config()
    mb = cfg.get("modbus") or {}
    host = (host if host is not None else mb.get("host", "")).strip()
    port = int(port if port is not None else mb.get("port", DEFAULT_MODBUS_PORT))
    unit_id = int(unit_id if unit_id is not None else mb.get("unit_id", DEFAULT_MODBUS_UNIT))
    max_area_id = max(1, min(int(max_area_id), 1024))

    if not host:
        raise ValueError("NOX Modbus host is not configured")

    found: List[Dict[str, Any]] = []
    ts = _utc_now_iso()

    client = ModbusTcpClient(host, port=port, timeout=3.0)
    try:
        if not client.connect():
            raise ConnectionError(f"Could not connect to NOX Modbus at {host}:{port}")

        addr = 1
        end = max_area_id
        while addr <= end:
            chunk = min(MODBUS_MAX_READ, end - addr + 1)
            try:
                rr = _read_registers(client, "holding", addr, chunk, unit_id)
            except Exception:
                addr += chunk
                continue
            if rr is None or getattr(rr, "isError", lambda: True)():
                addr += chunk
                continue
            for offset, raw in enumerate(rr.registers):
                area_id = addr + offset
                value = int(raw) & 0xFFFF
                decoded = _decode_area_word(value)
                if not decoded["defined"]:
                    continue
                found.append({
                    "area_id": area_id,
                    "address": area_id,
                    "raw": value,
                    "code": decoded["code"],
                    "state": decoded["state"],
                })
            addr += chunk
    finally:
        try:
            client.close()
        except Exception:
            pass

    _log.info("NOX area discover %s:%d 1-%d → %d defined", host, port, max_area_id, len(found))
    return {
        "host": host, "port": port, "unit_id": unit_id,
        "max_area_id": max_area_id, "ts": ts, "found": found,
    }


def probe_registers(
    host: Optional[str] = None,
    port: Optional[int] = None,
    unit_id: Optional[int] = None,
    start_addr: int = 0,
    end_addr: int = 100,
    function_code: str = "holding",
    only_nonzero: bool = True,
) -> Dict[str, Any]:
    """Read a raw range of registers (no decoding) for register-block discovery.

    Used to hunt for the NOX area-state block, alarm-acknowledge register,
    etc. Opens its own short-lived TCP connection.
    """
    if ModbusTcpClient is None:
        raise RuntimeError(f"pymodbus not available: {_PYMODBUS_IMPORT_ERROR}")

    cfg = load_nox_config()
    mb = cfg.get("modbus") or {}
    host = (host if host is not None else mb.get("host", "")).strip()
    port = int(port if port is not None else mb.get("port", DEFAULT_MODBUS_PORT))
    unit_id = int(unit_id if unit_id is not None else mb.get("unit_id", DEFAULT_MODBUS_UNIT))

    if not host:
        raise ValueError("NOX Modbus host is not configured")

    try:
        start_addr = int(start_addr)
        end_addr = int(end_addr)
    except Exception:
        raise ValueError("start_addr and end_addr must be integers")

    if start_addr < 0 or end_addr < start_addr:
        raise ValueError("Invalid address range")
    if end_addr - start_addr + 1 > PROBE_ADDRESS_LIMIT:
        raise ValueError(f"Address range too large (max {PROBE_ADDRESS_LIMIT} per probe)")

    if function_code not in ("holding", "input"):
        raise ValueError("function_code must be holding or input")

    values: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    ts = _utc_now_iso()

    client = ModbusTcpClient(host, port=port, timeout=3.0)
    try:
        if not client.connect():
            raise ConnectionError(f"Could not connect to NOX Modbus at {host}:{port}")

        addr = start_addr
        while addr <= end_addr:
            chunk = min(MODBUS_MAX_READ, end_addr - addr + 1)
            try:
                rr = _read_registers(client, function_code, addr, chunk, unit_id)
            except Exception as exc:
                errors.append({"address": addr, "count": chunk, "error": str(exc)})
                addr += chunk
                continue

            if rr is None or getattr(rr, "isError", lambda: True)():
                errors.append({
                    "address": addr,
                    "count": chunk,
                    "error": _format_modbus_error(rr),
                })
                addr += chunk
                continue

            for offset, raw in enumerate(rr.registers):
                value = int(raw) & 0xFFFF
                if only_nonzero and value == 0:
                    continue
                values.append({"address": addr + offset, "value": value})

            addr += chunk
    finally:
        try:
            client.close()
        except Exception:
            pass

    _log.info(
        "NOX probe %s:%d FC=%s addr %d-%d → %d non-zero value(s), %d chunk error(s)",
        host, port, function_code, start_addr, end_addr, len(values), len(errors),
    )

    return {
        "host": host,
        "port": port,
        "unit_id": unit_id,
        "start_addr": start_addr,
        "end_addr": end_addr,
        "function_code": function_code,
        "only_nonzero": only_nonzero,
        "ts": ts,
        "values": values,
        "errors": errors,
    }


# ── Diagnostic: ack-all-alarms write (per doc: write 1 to register 1000) ───────

def ack_all_alarms(
    host: Optional[str] = None,
    port: Optional[int] = None,
    unit_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Write 1 to register 1000 (per NOX doc §1.8: 'Acknowledging all alarms').

    Used as a separate-code-path diagnostic when area writes silently fail —
    if THIS write works, we know the FC16 path is functional and the area-arm
    rejection is specifically about area permissions, not Modbus writes overall.
    """
    if ModbusTcpClient is None:
        raise RuntimeError(f"pymodbus not available: {_PYMODBUS_IMPORT_ERROR}")

    cfg = load_nox_config()
    mb = cfg.get("modbus") or {}
    host = (host if host is not None else mb.get("host", "")).strip()
    port = int(port if port is not None else mb.get("port", DEFAULT_MODBUS_PORT))
    unit_id = int(unit_id if unit_id is not None else mb.get("unit_id", DEFAULT_MODBUS_UNIT))

    if not host:
        raise ValueError("NOX Modbus host is not configured")

    poller_was_running = _modbus_thread is not None and _modbus_thread.is_alive()
    if poller_was_running:
        _modbus_paused.set()
        time.sleep(0.15)

    ok = False
    error: Optional[str] = None
    response_info: Dict[str, Any] = {}

    client = ModbusTcpClient(host, port=port, timeout=3.0)
    try:
        if not client.connect():
            raise ConnectionError(f"Could not connect to NOX Modbus at {host}:{port}")
        try:
            wr = _write_registers(client, 1000, [1], unit_id)
        except Exception as exc:
            error = f"raised: {exc}"
            wr = None
        response_info = _describe_modbus_response(wr)
        if wr is None or getattr(wr, "isError", lambda: True)():
            error = error or _format_modbus_error(wr)
        else:
            ok = True
    finally:
        try:
            client.close()
        except Exception:
            pass
        if poller_was_running:
            _modbus_paused.clear()

    _log.info("NOX ack_all_alarms write_ok=%s error=%s", ok, error)
    return {
        "host": host,
        "port": port,
        "unit_id": unit_id,
        "register": 1000,
        "value": 1,
        "write_ok": ok,
        "error": error,
        "response": response_info,
        "ts": _utc_now_iso(),
    }


# ── Phase 2 — area arm/disarm (production-facing) ──────────────────────────────


def _set_area_state(area_id: int, code: int) -> Dict[str, Any]:
    """Internal helper: write a code to an area register and verify by read-back.

    Returns a dict like write_area_state but stripped to the production essentials.
    Pauses the live poller during the write so transient failure bits aren't lost.
    """
    result = write_area_state(
        area_id=area_id,
        code=code,
        enforce_allowlist=True,
    )
    # Trim diagnostic noise for callers that just want a yes/no.
    return {
        "area_id": result["area_id"],
        "code_written": result["code_written"],
        "write_ok": result["write_ok"],
        "before": result["before"],
        "after": result["after"],
        "captured_failure_flags": result["captured_failure_flags"],
        "ts": result["ts"],
    }


def arm_area(area_id: int) -> Dict[str, Any]:
    """Arm a NOX area (write code 5)."""
    return _set_area_state(int(area_id), 5)


def disarm_area(area_id: int) -> Dict[str, Any]:
    """Disarm a NOX area (write code 1)."""
    return _set_area_state(int(area_id), 1)


# ── Input activate / deactivate / pulse (NOX command channel) ──────────────────

INPUT_DEACTIVATE_BIT = 7   # per NOX doc §1.6
INPUT_ACK_ALARM_BIT = 6    # per NOX doc §1.7


def set_input_active(
    module: int,
    input_idx: int,
    active: bool,
    host: Optional[str] = None,
    port: Optional[int] = None,
    unit_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Activate or deactivate a NOX detector input via FC22 mask-write of bit 7.

    Per NOX doc §1.6:
      bit 7 = 1 → deactivated
      bit 7 = 0 → activated

    NoxConfig can be configured so that flipping bit 7 of a 'command' input
    triggers panel-side actions (door release, toggle a virtual indicator, etc.).
    This is the primary mechanism for controlling ADK doors and virtual on/off
    areas via Modbus.
    """
    if ModbusTcpClient is None:
        raise RuntimeError(f"pymodbus not available: {_PYMODBUS_IMPORT_ERROR}")

    cfg = load_nox_config()
    mb = cfg.get("modbus") or {}
    host = (host if host is not None else mb.get("host", "")).strip()
    port = int(port if port is not None else mb.get("port", DEFAULT_MODBUS_PORT))
    unit_id = int(unit_id if unit_id is not None else mb.get("unit_id", DEFAULT_MODBUS_UNIT))

    if not host:
        raise ValueError("NOX Modbus host is not configured")

    try:
        module = int(module)
        input_idx = int(input_idx)
    except Exception:
        raise ValueError("module and input must be integers")

    if not (0 < module <= 9999):
        raise ValueError("module out of range")
    if not (0 <= input_idx <= 9):
        raise ValueError("input index must be 0-9")

    address = _modbus_register_address(module, input_idx)
    bit_mask = 1 << INPUT_DEACTIVATE_BIT  # 0x0080

    # To DEACTIVATE (set bit 7=1): and_mask = 0xFFFF, or_mask = 0x0080
    # To ACTIVATE   (clear bit 7):  and_mask = ~0x0080 & 0xFFFF, or_mask = 0
    if active:
        and_mask = (~bit_mask) & 0xFFFF
        or_mask = 0x0000
    else:
        and_mask = 0xFFFF
        or_mask = bit_mask

    poller_was_running = _modbus_thread is not None and _modbus_thread.is_alive()
    if poller_was_running:
        _modbus_paused.set()
        time.sleep(0.15)

    before = None
    after = None
    write_ok = False
    error: Optional[str] = None
    response_info: Dict[str, Any] = {}

    client = ModbusTcpClient(host, port=port, timeout=3.0)
    try:
        if not client.connect():
            raise ConnectionError(f"Could not connect to NOX Modbus at {host}:{port}")

        # Read current
        try:
            rr = _read_registers(client, "holding", address, 1, unit_id)
            if rr is not None and not getattr(rr, "isError", lambda: True)():
                raw = int(rr.registers[0]) & 0xFFFF
                before = {"raw": raw, "deactivated": bool(raw & bit_mask), "flags": _decode_status_word(raw)}
        except Exception as exc:
            error = f"read-before failed: {exc}"

        # Mask-write
        try:
            wr = _mask_write_register(client, address, and_mask, or_mask, unit_id)
        except Exception as exc:
            error = (error + "; " if error else "") + f"mask-write raised: {exc}"
            wr = None
        response_info = _describe_modbus_response(wr)
        if wr is None or getattr(wr, "isError", lambda: True)():
            error = (error + "; " if error else "") + (_format_modbus_error(wr) or "mask-write failed")
        else:
            write_ok = True

        # Brief pause then read back
        if write_ok:
            time.sleep(0.2)
        try:
            rr = _read_registers(client, "holding", address, 1, unit_id)
            if rr is not None and not getattr(rr, "isError", lambda: True)():
                raw = int(rr.registers[0]) & 0xFFFF
                after = {"raw": raw, "deactivated": bool(raw & bit_mask), "flags": _decode_status_word(raw)}
        except Exception:
            pass
    finally:
        try:
            client.close()
        except Exception:
            pass
        if poller_was_running:
            _modbus_paused.clear()

    _log.info(
        "NOX set_input_active module=%d input=%d active=%s write_ok=%s",
        module, input_idx, active, write_ok,
    )
    return {
        "module": module,
        "input": input_idx,
        "address": address,
        "requested_active": active,
        "write_ok": write_ok,
        "before": before,
        "after": after,
        "response": response_info,
        "error": error,
        "ts": _utc_now_iso(),
    }


def pulse_input(
    module: int,
    input_idx: int,
    pulse_seconds: float = 1.0,
    deactivate_first: bool = True,
    host: Optional[str] = None,
    port: Optional[int] = None,
    unit_id: Optional[int] = None,
) -> Dict[str, Any]:
    """Toggle bit 7 of an input for `pulse_seconds`, then toggle it back.

    Useful for momentary triggers: e.g. configure NoxConfig so deactivating a
    'command' input releases a door for a few seconds; this pulses the bit and
    restores it automatically.

    deactivate_first=True  → set bit 7 to 1 (deactivate), wait, clear it.
    deactivate_first=False → clear bit 7 (activate),     wait, set it.

    Always returns a consistent shape with `first` and `second` populated
    (second may be None if the first write failed).
    """
    pulse_seconds = max(0.05, min(60.0, float(pulse_seconds)))

    first = set_input_active(
        module, input_idx,
        active=not deactivate_first,
        host=host, port=port, unit_id=unit_id,
    )

    second: Optional[Dict[str, Any]] = None
    if first.get("write_ok"):
        time.sleep(pulse_seconds)
        second = set_input_active(
            module, input_idx,
            active=deactivate_first,
            host=host, port=port, unit_id=unit_id,
        )

    return {
        "module": module,
        "input": input_idx,
        "pulse_seconds": pulse_seconds,
        "deactivate_first": deactivate_first,
        "ok": bool(first.get("write_ok") and second and second.get("write_ok")),
        "first": first,
        "second": second,
        "error": first.get("error") or (second.get("error") if second else None),
        "ts": _utc_now_iso(),
    }


# ── Phase 2 (writes) ───────────────────────────────────────────────────────────

# Codes accepted by the test-write endpoint. Conservative allowlist to avoid
# accidentally writing arbitrary values during testing — extend as we verify
# more codes work.
NOX_AREA_WRITE_ALLOWED_CODES = {1, 5}  # In practice only disarm (1) and arm (5) are
                                       # useful direct writes. Codes 2/3/4 are
                                       # transitional and panel-managed (you write 5
                                       # and the panel cycles through them automatically).
                                       # 6 = partly_armed is auto-only.


def _read_one_area(client, address: int, unit_id: int) -> Optional[Dict[str, Any]]:
    try:
        rr = _read_registers(client, "holding", address, 1, unit_id)
    except Exception:
        return None
    if rr is None or getattr(rr, "isError", lambda: True)():
        return None
    raw = int(rr.registers[0]) & 0xFFFF
    decoded = _decode_area_word(raw)
    return {"raw": raw, **decoded}


def _describe_modbus_response(rr) -> Dict[str, Any]:
    """Capture useful diagnostic fields from a pymodbus response object."""
    if rr is None:
        return {"present": False}
    info: Dict[str, Any] = {
        "present": True,
        "type": type(rr).__name__,
        "is_error": bool(getattr(rr, "isError", lambda: True)()),
    }
    for attr in ("function_code", "exception_code", "registers", "address", "count"):
        if hasattr(rr, attr):
            try:
                info[attr] = getattr(rr, attr)
            except Exception:
                pass
    return info


def _try_write_strategy(client, strategy: str, address: int, code: int, unit_id: int) -> Tuple[bool, Optional[str], Dict[str, Any]]:
    """Apply a write strategy. Returns (succeeded_at_protocol_level, error_message, response_info)."""
    value_full = (code & 0x00FF) | 0x8000
    arm_intent = code != 1
    wr = None
    try:
        if strategy == "fc06":
            wr = _write_register(client, address, code, unit_id)
        elif strategy == "fc06_marked":
            wr = _write_register(client, address, value_full, unit_id)
        elif strategy == "fc16":
            wr = _write_registers(client, address, [code], unit_id)
        elif strategy == "fc16_marked":
            wr = _write_registers(client, address, [value_full], unit_id)
        elif strategy == "fc05":
            wr = _write_coil(client, address, arm_intent, unit_id)
        elif strategy == "fc15":
            wr = _write_coils(client, address, [arm_intent], unit_id)
        elif strategy == "fc05_inverse":
            wr = _write_coil(client, address, not arm_intent, unit_id)
        elif strategy == "fc15_inverse":
            wr = _write_coils(client, address, [not arm_intent], unit_id)
        else:
            return (False, f"unknown strategy {strategy!r}", {})
    except Exception as exc:
        return (False, f"raised: {exc}", {})
    response_info = _describe_modbus_response(wr)
    if wr is None or getattr(wr, "isError", lambda: True)():
        return (False, _format_modbus_error(wr), response_info)
    return (True, None, response_info)


def write_area_state(
    area_id: int,
    code: int,
    host: Optional[str] = None,
    port: Optional[int] = None,
    unit_id: Optional[int] = None,
    enforce_allowlist: bool = True,
    readback_delay_sec: float = 0.4,
    strategies: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Write a state code to a NOX area register, trying multiple strategies.

    NOX panels vary on whether they accept FC06 (write_single_register) or only
    FC16 (write_multiple_registers), and whether the value should be the bare
    state code or with bit 15 set. We try strategies in order and stop as soon
    as one produces a value change in the read-back, reporting all attempts so
    you can see which one the panel accepted.
    """
    if ModbusTcpClient is None:
        raise RuntimeError(f"pymodbus not available: {_PYMODBUS_IMPORT_ERROR}")

    cfg = load_nox_config()
    mb = cfg.get("modbus") or {}
    host = (host if host is not None else mb.get("host", "")).strip()
    port = int(port if port is not None else mb.get("port", DEFAULT_MODBUS_PORT))
    unit_id = int(unit_id if unit_id is not None else mb.get("unit_id", DEFAULT_MODBUS_UNIT))

    if not host:
        raise ValueError("NOX Modbus host is not configured")

    try:
        area_id = int(area_id)
        code = int(code)
    except Exception:
        raise ValueError("area_id and code must be integers")

    if not (0 < area_id <= 9999):
        raise ValueError("area_id out of range")
    if not (0 <= code <= 0xFFFF):
        raise ValueError("code must fit in a 16-bit unsigned integer")
    if enforce_allowlist and code not in NOX_AREA_WRITE_ALLOWED_CODES:
        raise ValueError(
            f"code {code} is not in the safe allowlist {sorted(NOX_AREA_WRITE_ALLOWED_CODES)}; "
            "pass enforce_allowlist=false to override"
        )

    if not strategies:
        # NOX Modbus server only supports FC03 (read holding) + FC16 (write
        # multiple) per the official ARAS Modbus Server doc. Other write FCs
        # silently time out. Default to FC16 only; keep alternates available
        # via explicit strategies= for diagnostics.
        strategies = ["fc16"]

    ts = _utc_now_iso()
    before = None
    after = None
    attempts: List[Dict[str, Any]] = []
    successful_strategy: Optional[str] = None
    captured_failures: List[str] = []

    # Pause the live poller so its concurrent reads don't clear the panel's
    # transient failure bits before we get to read them.
    poller_was_running = _modbus_thread is not None and _modbus_thread.is_alive()
    if poller_was_running:
        _modbus_paused.set()
        # Give the poller a moment to notice the pause flag.
        time.sleep(0.15)

    client = ModbusTcpClient(host, port=port, timeout=3.0)
    try:
        if not client.connect():
            raise ConnectionError(f"Could not connect to NOX Modbus at {host}:{port}")

        before = _read_one_area(client, area_id, unit_id)

        for strategy in strategies:
            ok, err, response_info = _try_write_strategy(client, strategy, area_id, code, unit_id)
            attempt: Dict[str, Any] = {
                "strategy": strategy,
                "protocol_ok": ok,
                "error": err,
                "response": response_info,
            }

            # Rapid sequential readbacks on the SAME connection so we catch
            # the failure bits before NOX clears them on the next read (per doc:
            # the failure bits are cleared after first query). The live poller
            # may also clear them — we can't fully prevent that race, but
            # reading immediately maximises our chances.
            readbacks: List[Dict[str, Any]] = []
            captured_failure: Optional[List[str]] = None
            captured_state_match = False
            target_code = code & 0x03FF

            if ok:
                for i in range(6):
                    rb = _read_one_area(client, area_id, unit_id)
                    if rb is None:
                        break
                    readbacks.append(rb)
                    flags = _area_failure_flags(rb)
                    if flags and captured_failure is None:
                        captured_failure = flags
                    if rb.get("code") == target_code and rb.get("code") != (before or {}).get("code"):
                        captured_state_match = True
                        break
                    if i < 5:
                        time.sleep(0.05)

            attempt["readbacks"] = readbacks
            attempt["readback"] = readbacks[-1] if readbacks else None
            attempt["failure_flags"] = captured_failure or []
            attempts.append(attempt)

            if captured_failure:
                captured_failures = captured_failure  # propagate to top-level result

            if captured_state_match:
                successful_strategy = strategy
                after = readbacks[-1]
                break

        if after is None:
            after = _read_one_area(client, area_id, unit_id)
    finally:
        try:
            client.close()
        except Exception:
            pass
        if poller_was_running:
            _modbus_paused.clear()

    _log.info(
        "NOX write area %d ← code %d on %s:%d: strategy=%s, before=%s, after=%s",
        area_id, code, host, port,
        successful_strategy or "none",
        before.get("state") if before else None,
        after.get("state") if after else None,
    )

    return {
        "host": host,
        "port": port,
        "unit_id": unit_id,
        "area_id": area_id,
        "address": area_id,
        "code_written": code,
        "write_ok": successful_strategy is not None,
        "successful_strategy": successful_strategy,
        "captured_failure_flags": captured_failures,
        "attempts": attempts,
        "before": before,
        "after": after,
        "ts": ts,
    }
