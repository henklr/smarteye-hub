from __future__ import annotations

import os
import threading
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple


try:
    import automationhat  # type: ignore

    _AUTOMATIONHAT_IMPORT_ERROR = ""
except Exception as exc:
    automationhat = None  # type: ignore[assignment]
    _AUTOMATIONHAT_IMPORT_ERROR = str(exc)


PHYSICAL_INPUT_KINDS = {"digital", "analog"}
PHYSICAL_DIGITAL_CHANNELS: Tuple[int, ...] = (1, 2, 3)
PHYSICAL_ANALOG_CHANNELS: Tuple[int, ...] = (1, 2, 3)
PHYSICAL_OUTPUT_CHANNELS: Tuple[int, ...] = (1, 2, 3)
PHYSICAL_RELAY_CHANNELS: Tuple[int, ...] = (1,)

_PHYSICAL_IO_POLL_SEC = max(0.1, float(os.getenv("PHYSICAL_IO_POLL_SEC", "0.5")))
_ANALOG_PRECISION = 2
_GPIO_MODEL_PATH = "/sys/firmware/devicetree/base/model"

_hardware_lock = threading.RLock()
_state_lock = threading.RLock()
_output_timer_lock = threading.RLock()
_relay_timer_lock = threading.RLock()

_monitor_stop = threading.Event()
_monitor_thread: Optional[threading.Thread] = None
_output_timers: Dict[int, threading.Timer] = {}
_relay_timers: Dict[int, threading.Timer] = {}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _future_iso(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def physical_channels(kind: str) -> Tuple[int, ...]:
    normalized = str(kind or "").strip().lower()
    if normalized == "digital":
        return PHYSICAL_DIGITAL_CHANNELS
    if normalized == "analog":
        return PHYSICAL_ANALOG_CHANNELS
    if normalized == "output":
        return PHYSICAL_OUTPUT_CHANNELS
    if normalized == "relay":
        return PHYSICAL_RELAY_CHANNELS
    return ()


def _catalog_entries(kind: str, channels: Tuple[int, ...], prefix: str) -> List[Dict[str, Any]]:
    return [
        {
            "kind": kind,
            "channel": str(channel),
            "label": f"{prefix} {channel}",
        }
        for channel in channels
    ]


def _blank_entries(kind: str, channels: Tuple[int, ...], prefix: str) -> List[Dict[str, Any]]:
    return [
        {
            "kind": kind,
            "channel": str(channel),
            "label": f"{prefix} {channel}",
            "value": None,
        }
        for channel in channels
    ]


def _blank_state(error: Optional[str]) -> Dict[str, Any]:
    return {
        "supported": automationhat is not None,
        "available": False,
        "error": error,
        "updated_at": None,
        "digital_inputs": _blank_entries("digital", PHYSICAL_DIGITAL_CHANNELS, "Digital input"),
        "analog_inputs": _blank_entries("analog", PHYSICAL_ANALOG_CHANNELS, "Analog input"),
        "outputs": _blank_entries("output", PHYSICAL_OUTPUT_CHANNELS, "Output"),
        "relays": _blank_entries("relay", PHYSICAL_RELAY_CHANNELS, "Relay"),
    }


_state: Dict[str, Any] = _blank_state(_AUTOMATIONHAT_IMPORT_ERROR or None)


def _read_pi_model() -> str:
    try:
        with open(_GPIO_MODEL_PATH, "r", encoding="utf-8", errors="ignore") as handle:
            return handle.read().replace("\x00", "").strip()
    except Exception:
        return ""


def _missing_hardware_requirements() -> List[str]:
    missing: List[str] = []

    if not any(os.path.exists(f"/dev/gpiochip{idx}") for idx in (0, 4)):
        missing.append("/dev/gpiochip*")

    if not os.path.exists("/dev/i2c-1"):
        missing.append("/dev/i2c-1")

    if not _read_pi_model().startswith("Raspberry Pi"):
        missing.append(_GPIO_MODEL_PATH)

    return missing


def _friendly_runtime_error(exc: Exception) -> str:
    message = str(exc).strip() or exc.__class__.__name__
    missing = _missing_hardware_requirements()

    if missing:
        detail = ", ".join(missing)
        if os.path.exists("/.dockerenv"):
            return (
                "Automation HAT is installed but this container cannot access Raspberry Pi hardware. "
                f"Missing: {detail}. Add `privileged: true`, mount `/sys/firmware/devicetree/base`, "
                "then recreate the container."
            )
        return f"Automation HAT hardware is unavailable. Missing: {detail}."

    if message in {"No compatible platform detected!", "'NoneType' object has no attribute 'line_offset_from_id'"}:
        return "Automation HAT GPIO setup failed. Raspberry Pi GPIO platform detection did not complete."

    if message == "'NoneType' object has no attribute 'get_voltage'":
        return "Automation HAT ADC setup failed. The I2C ADC could not be initialized."

    return message


def physical_io_catalog() -> Dict[str, Any]:
    snapshot = physical_io_state(refresh=False)
    return {
        "supported": automationhat is not None,
        "available": bool(snapshot.get("available")),
        "error": snapshot.get("error"),
        "digital_inputs": _catalog_entries("digital", PHYSICAL_DIGITAL_CHANNELS, "Digital input"),
        "analog_inputs": _catalog_entries("analog", PHYSICAL_ANALOG_CHANNELS, "Analog input"),
        "outputs": _catalog_entries("output", PHYSICAL_OUTPUT_CHANNELS, "Output"),
        "relays": _catalog_entries("relay", PHYSICAL_RELAY_CHANNELS, "Relay"),
    }


def _group_object(group_name: str, channel: int) -> Any:
    if automationhat is None:
        raise RuntimeError(_AUTOMATIONHAT_IMPORT_ERROR or "automationhat is unavailable")

    group = getattr(automationhat, group_name, None)
    if group is None:
        raise RuntimeError(f"automationhat.{group_name} is unavailable")

    try:
        return group[int(channel) - 1]
    except Exception as exc:
        raise RuntimeError(f"Unable to access {group_name} channel {channel}: {exc}") from exc


def _read_bool_channel(group_name: str, channel: int) -> int:
    obj = _group_object(group_name, channel)
    if hasattr(obj, "read"):
        return 1 if bool(obj.read()) else 0
    if hasattr(obj, "is_on"):
        return 1 if bool(obj.is_on()) else 0
    raise RuntimeError(f"automationhat.{group_name}[{channel - 1}] has no readable boolean state")


def _read_analog_channel(channel: int) -> float:
    obj = _group_object("analog", channel)
    if not hasattr(obj, "read"):
        raise RuntimeError(f"automationhat.analog[{channel - 1}] has no read() method")
    return round(float(obj.read()), _ANALOG_PRECISION)


def _write_output_channel(channel: int, enabled: bool) -> None:
    obj = _group_object("output", channel)
    if enabled and hasattr(obj, "on"):
        obj.on()
        return
    if (not enabled) and hasattr(obj, "off"):
        obj.off()
        return
    if hasattr(obj, "write"):
        obj.write(1 if enabled else 0)
        return
    raise RuntimeError(f"automationhat.output[{channel - 1}] cannot be controlled")


def _write_relay_channel(channel: int, enabled: bool) -> None:
    obj = _group_object("relay", channel)
    if enabled and hasattr(obj, "on"):
        obj.on()
        return
    if (not enabled) and hasattr(obj, "off"):
        obj.off()
        return
    if hasattr(obj, "write"):
        obj.write(1 if enabled else 0)
        return
    raise RuntimeError(f"automationhat.relay[{channel - 1}] cannot be controlled")


def _build_state_snapshot() -> Dict[str, Any]:
    snapshot = _blank_state(_AUTOMATIONHAT_IMPORT_ERROR or None)
    snapshot["updated_at"] = _utc_now_iso()

    if automationhat is None:
        return snapshot

    missing = _missing_hardware_requirements()
    if missing:
        snapshot["error"] = _friendly_runtime_error(RuntimeError("hardware access missing"))
        return snapshot

    try:
        with _hardware_lock:
            snapshot["digital_inputs"] = [
                {
                    "kind": "digital",
                    "channel": str(channel),
                    "label": f"Digital input {channel}",
                    "value": _read_bool_channel("input", channel),
                }
                for channel in PHYSICAL_DIGITAL_CHANNELS
            ]
            snapshot["analog_inputs"] = [
                {
                    "kind": "analog",
                    "channel": str(channel),
                    "label": f"Analog input {channel}",
                    "value": _read_analog_channel(channel),
                }
                for channel in PHYSICAL_ANALOG_CHANNELS
            ]
            snapshot["outputs"] = [
                {
                    "kind": "output",
                    "channel": str(channel),
                    "label": f"Output {channel}",
                    "value": _read_bool_channel("output", channel),
                }
                for channel in PHYSICAL_OUTPUT_CHANNELS
            ]
            snapshot["relays"] = [
                {
                    "kind": "relay",
                    "channel": str(channel),
                    "label": f"Relay {channel}",
                    "value": _read_bool_channel("relay", channel),
                }
                for channel in PHYSICAL_RELAY_CHANNELS
            ]
        snapshot["available"] = True
        snapshot["error"] = None
    except Exception as exc:
        snapshot["error"] = _friendly_runtime_error(exc)

    return snapshot


def refresh_physical_io_state() -> Dict[str, Any]:
    snapshot = _build_state_snapshot()
    with _state_lock:
        global _state
        _state = snapshot
    return deepcopy(snapshot)


def physical_io_state(refresh: bool = False) -> Dict[str, Any]:
    with _state_lock:
        needs_refresh = refresh or _state.get("updated_at") is None
        snapshot = deepcopy(_state)

    if needs_refresh:
        return refresh_physical_io_state()

    return snapshot


def _group_key(kind: str) -> str:
    normalized = str(kind or "").strip().lower()
    if normalized == "digital":
        return "digital_inputs"
    if normalized == "analog":
        return "analog_inputs"
    if normalized == "output":
        return "outputs"
    if normalized == "relay":
        return "relays"
    raise ValueError(f"Unsupported physical I/O kind: {kind}")


def _find_entry(snapshot: Dict[str, Any], kind: str, channel: int) -> Optional[Dict[str, Any]]:
    key = _group_key(kind)
    wanted = str(channel)
    for entry in snapshot.get(key, []):
        if str(entry.get("channel") or "") == wanted:
            return deepcopy(entry)
    return None


def read_physical_input(kind: str, channel: int) -> Dict[str, Any]:
    normalized = str(kind or "").strip().lower()
    if normalized not in PHYSICAL_INPUT_KINDS:
        raise ValueError(f"Unsupported physical input kind: {kind}")

    snapshot = refresh_physical_io_state()
    if not snapshot.get("available"):
        raise RuntimeError(snapshot.get("error") or "Physical I/O is unavailable")

    entry = _find_entry(snapshot, normalized, int(channel))
    if entry is None:
        raise ValueError(f"Physical {normalized} channel {channel} is unavailable")

    entry["updated_at"] = snapshot.get("updated_at")
    return entry


def _cancel_output_timer(channel: int) -> None:
    with _output_timer_lock:
        timer = _output_timers.pop(channel, None)
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass


def _finish_output_pulse(channel: int) -> None:
    with _output_timer_lock:
        _output_timers.pop(channel, None)

    try:
        with _hardware_lock:
            _write_output_channel(channel, False)
    except Exception:
        pass

    try:
        refresh_physical_io_state()
    except Exception:
        pass


def _cancel_relay_timer(channel: int) -> None:
    with _relay_timer_lock:
        timer = _relay_timers.pop(channel, None)
    if timer is not None:
        try:
            timer.cancel()
        except Exception:
            pass


def _finish_relay_pulse(channel: int) -> None:
    with _relay_timer_lock:
        _relay_timers.pop(channel, None)

    try:
        with _hardware_lock:
            _write_relay_channel(channel, False)
    except Exception:
        pass

    try:
        refresh_physical_io_state()
    except Exception:
        pass


def activate_physical_output(channel: int, mode: str, pulse_seconds: float) -> Dict[str, Any]:
    normalized_mode = str(mode or "").strip().lower()
    if normalized_mode not in {"on", "off", "pulse"}:
        raise ValueError("Physical output mode must be on, off or pulse")

    channel = int(channel)
    if normalized_mode == "pulse" and float(pulse_seconds) <= 0:
        raise ValueError("Physical output pulse_seconds must be greater than 0")

    _cancel_output_timer(channel)

    with _hardware_lock:
        if normalized_mode == "on":
            _write_output_channel(channel, True)
        elif normalized_mode == "off":
            _write_output_channel(channel, False)
        else:
            _write_output_channel(channel, True)

    if normalized_mode == "pulse":
        timer = threading.Timer(float(pulse_seconds), _finish_output_pulse, args=(channel,))
        timer.daemon = True
        with _output_timer_lock:
            _output_timers[channel] = timer
        timer.start()

    snapshot = refresh_physical_io_state()
    entry = _find_entry(snapshot, "output", channel)

    result = {
        "channel": str(channel),
        "mode": normalized_mode,
        "pulse_seconds": float(pulse_seconds),
        "state": entry,
        "updated_at": snapshot.get("updated_at"),
        "message": f"Output {channel} {normalized_mode}{f' for {float(pulse_seconds):.2f}s' if normalized_mode == 'pulse' else ''}",
    }
    if normalized_mode == "pulse":
        result["scheduled_off_at"] = _future_iso(float(pulse_seconds))
    return result


def activate_physical_relay(channel: int, mode: str, pulse_seconds: float) -> Dict[str, Any]:
    normalized_mode = str(mode or "").strip().lower()
    if normalized_mode not in {"on", "off", "pulse"}:
        raise ValueError("Physical relay mode must be on, off or pulse")

    channel = int(channel)
    if normalized_mode == "pulse" and float(pulse_seconds) <= 0:
        raise ValueError("Physical relay pulse_seconds must be greater than 0")

    _cancel_relay_timer(channel)

    with _hardware_lock:
        if normalized_mode == "on":
            _write_relay_channel(channel, True)
        elif normalized_mode == "off":
            _write_relay_channel(channel, False)
        else:
            _write_relay_channel(channel, True)

    if normalized_mode == "pulse":
        timer = threading.Timer(float(pulse_seconds), _finish_relay_pulse, args=(channel,))
        timer.daemon = True
        with _relay_timer_lock:
            _relay_timers[channel] = timer
        timer.start()

    snapshot = refresh_physical_io_state()
    entry = _find_entry(snapshot, "relay", channel)

    result = {
        "channel": str(channel),
        "mode": normalized_mode,
        "pulse_seconds": float(pulse_seconds),
        "state": entry,
        "updated_at": snapshot.get("updated_at"),
        "message": f"Relay {channel} {normalized_mode}{f' for {float(pulse_seconds):.2f}s' if normalized_mode == 'pulse' else ''}",
    }
    if normalized_mode == "pulse":
        result["scheduled_off_at"] = _future_iso(float(pulse_seconds))
    return result


def _monitor_loop(dispatch_trigger: Callable[[Dict[str, Any]], int]) -> None:
    snapshot = refresh_physical_io_state()
    previous_digital = {
        str(entry.get("channel") or ""): entry.get("value")
        for entry in snapshot.get("digital_inputs", [])
    }
    previous_analog = {
        str(entry.get("channel") or ""): entry.get("value")
        for entry in snapshot.get("analog_inputs", [])
    }

    while not _monitor_stop.wait(_PHYSICAL_IO_POLL_SEC):
        snapshot = refresh_physical_io_state()
        if not snapshot.get("available"):
            continue

        ts = snapshot.get("updated_at") or _utc_now_iso()

        for entry in snapshot.get("digital_inputs", []):
            channel = str(entry.get("channel") or "")
            current = entry.get("value")
            previous = previous_digital.get(channel)

            if previous is not None and current is not None and current != previous:
                dispatch_trigger(
                    {
                        "kind": "digital_input_changed",
                        "input_kind": "digital",
                        "channel": channel,
                        "value": current,
                        "previous_value": previous,
                        "label": entry.get("label"),
                        "ts": ts,
                        "extra": {
                            "channel": channel,
                            "value": current,
                            "previous_value": previous,
                        },
                    }
                )

            previous_digital[channel] = current

        for entry in snapshot.get("analog_inputs", []):
            channel = str(entry.get("channel") or "")
            current = entry.get("value")
            previous = previous_analog.get(channel)

            if previous is not None and current is not None and current != previous:
                dispatch_trigger(
                    {
                        "kind": "analog_input_changed",
                        "input_kind": "analog",
                        "channel": channel,
                        "value": current,
                        "previous_value": previous,
                        "delta": round(float(current) - float(previous), _ANALOG_PRECISION),
                        "label": entry.get("label"),
                        "ts": ts,
                        "extra": {
                            "channel": channel,
                            "value": current,
                            "previous_value": previous,
                        },
                    }
                )

            previous_analog[channel] = current


def start_physical_io_monitor(dispatch_trigger: Callable[[Dict[str, Any]], int]) -> None:
    refresh_physical_io_state()

    if automationhat is None:
        return

    global _monitor_thread
    if _monitor_thread is not None and _monitor_thread.is_alive():
        return

    _monitor_stop.clear()
    _monitor_thread = threading.Thread(
        target=_monitor_loop,
        args=(dispatch_trigger,),
        daemon=True,
        name="physical-io-monitor",
    )
    _monitor_thread.start()


def stop_physical_io_monitor() -> None:
    global _monitor_thread

    _monitor_stop.set()

    thread = _monitor_thread
    _monitor_thread = None
    if thread is not None and thread.is_alive():
        try:
            thread.join(timeout=1.0)
        except Exception:
            pass

    with _output_timer_lock:
        timers = list(_output_timers.items())
        _output_timers.clear()

    with _relay_timer_lock:
        relay_timers = list(_relay_timers.items())
        _relay_timers.clear()

    for channel, timer in timers:
        try:
            timer.cancel()
        except Exception:
            pass
        try:
            if automationhat is not None:
                with _hardware_lock:
                    _write_output_channel(channel, False)
        except Exception:
            pass

    for channel, timer in relay_timers:
        try:
            timer.cancel()
        except Exception:
            pass
        try:
            if automationhat is not None:
                with _hardware_lock:
                    _write_relay_channel(channel, False)
        except Exception:
            pass

    try:
        refresh_physical_io_state()
    except Exception:
        pass