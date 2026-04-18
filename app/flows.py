from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from playback import create_recording_marker, stop_recording_marker

from physical_io import (
    activate_physical_output,
    activate_physical_relay,
    physical_channels,
    physical_io_catalog,
    physical_io_state,
    read_physical_value,
)

import logging

_log_flows    = logging.getLogger("flows")
_log_schedule = logging.getLogger("schedule")

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DEVICES_JSON = DATA_DIR / "devices.json"
FLOWS_JSON = DATA_DIR / "flows.json"
PUBLIC_VARIABLES_JSON = DATA_DIR / "public_variables.json"
SCHEDULES_JSON = DATA_DIR / "schedules.json"
RECORDING_PRESETS_JSON = DATA_DIR / "recording_presets.json"
FLOW_STATE_JSON = DATA_DIR / "flow_state.json"
FLOW_LOG_FILE = Path(os.getenv("FLOW_LOG_FILE", str(DATA_DIR / "flows.log")))
FLOW_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

# ── Contribution buffer (in-memory, keyed by target entity id) ─────────────────
_contribution_buffers: Dict[str, Dict[str, Any]] = {}
_contribution_buffers_lock = threading.RLock()
_CONTRIBUTION_BUFFER_TTL = 600  # 10 minutes


def _get_contribution_buffer(key: str) -> Dict[str, Any]:
    """Return or create a contribution buffer entry, pruning expired ones."""
    now = time.time()
    with _contribution_buffers_lock:
        expired = [k for k, v in _contribution_buffers.items() if now - v.get("ts", 0) > _CONTRIBUTION_BUFFER_TTL]
        for k in expired:
            del _contribution_buffers[k]
        if key not in _contribution_buffers:
            _contribution_buffers[key] = {
                "texts": [], "images": [], "snapshots": [],
                "count": 0, "ts": now, "first_ts": 0,
            }
        buf = _contribution_buffers[key]
        buf["ts"] = now
        return buf


def _flush_contribution_buffer(key: str) -> None:
    with _contribution_buffers_lock:
        _contribution_buffers.pop(key, None)
    _cancel_contribution_timer(key)


def _consume_contribution_buffer(key: str) -> Dict[str, Any]:
    """Return and remove a contribution buffer. Returns empty structure if not found."""
    _cancel_contribution_timer(key)
    with _contribution_buffers_lock:
        return _contribution_buffers.pop(
            key,
            {"texts": [], "images": [], "snapshots": [], "count": 0},
        )


# ── Contribution buffer timers (auto-fire after max_seconds) ──────────────────
_contribution_timers: Dict[str, threading.Timer] = {}


def _cancel_contribution_timer(key: str) -> None:
    timer = _contribution_timers.pop(key, None)
    if timer is not None:
        timer.cancel()


def _schedule_contribution_timer(
    key: str,
    max_seconds: float,
    target_type: str,
    target_id: str,
) -> None:
    """Schedule a background timer that auto-fires the event/scenario after max_seconds."""
    _cancel_contribution_timer(key)

    def _on_timeout():
        _contribution_timers.pop(key, None)
        with _contribution_buffers_lock:
            if key not in _contribution_buffers:
                return
        _log_flows.info("Contribution buffer '%s' max_seconds expired, auto-firing", key)
        _auto_fire_target(target_type, target_id)

    timer = threading.Timer(max_seconds, _on_timeout)
    timer.daemon = True
    _contribution_timers[key] = timer
    timer.start()


def _auto_fire_target(target_type: str, target_id: str) -> None:
    """Auto-fire a scenario when max_seconds/max_contributions is reached."""
    try:
        _auto_fire_scenario(target_id)
    except Exception as exc:
        _log_flows.error("Auto-fire scenario %s failed: %s", target_id, exc)


def _auto_fire_scenario(scenario_id: str) -> None:
    """Fire a scenario from its definition using accumulated contributions."""
    from main import (
        _get_scenario, _analyze_with_gpt_structured, _render_template_simple,
    )
    scenario = _get_scenario(scenario_id)
    if scenario is None:
        _log_flows.warning("Auto-fire scenario: %s not found", scenario_id)
        return
    buf = _consume_contribution_buffer(scenario_id)
    context = {"contributions": buf}
    rendered_prompt = _render_template_simple(scenario.get("prompt", ""), context)
    if buf.get("texts"):
        extra = "\n\n".join(buf["texts"])
        rendered_prompt = f"{rendered_prompt}\n\nAdditional context:\n{extra}" if rendered_prompt else extra
    image_uris = list(buf.get("images") or [])
    response_type = scenario.get("response_type", "text")
    choices = scenario.get("choices") or []
    gpt_result = _analyze_with_gpt_structured(rendered_prompt, image_uris, response_type, choices)
    # Write result to variable if configured
    result_variable = scenario.get("result_variable", "").strip()
    if result_variable and gpt_result.get("result") is not None:
        _set_public_variable_value(result_variable, gpt_result["result"])
    _log_flows.info(
        "Auto-fired scenario '%s': result=%s, reasoning=%s",
        scenario.get("name"), gpt_result.get("result"), gpt_result.get("reasoning", "")[:100],
    )

STATIC_DIR = Path(__file__).resolve().parent / "static"

_VALID_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
_MAX_RUN_STEPS = 200
_SCHEDULE_POLL_SEC = max(5.0, float(os.getenv("SCHEDULE_POLL_SEC", "30") or "30"))
_WEEKDAY_KEYS: Tuple[str, ...] = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)
_HOLIDAY_DAY_KEY = "holidays"
_SCHEDULE_DAY_KEYS: Tuple[str, ...] = _WEEKDAY_KEYS + (_HOLIDAY_DAY_KEY,)
_SPECIAL_DAY_ROW_PREFIX = "special:"
_SPECIAL_DAY_KEY_PREFIX = "special_day_"
_DEFAULT_HOLIDAY_CALENDAR = "DK"
_HOLIDAY_CALENDAR_ALIASES: Dict[str, str] = {
    "DK": "DK",
    "DENMARK": "DK",
    "SE": "SE",
    "SWEDEN": "SE",
    "NO": "NO",
    "NORWAY": "NO",
    "DE": "DE",
    "GERMANY": "DE",
    "GB": "GB",
    "UK": "GB",
    "UNITEDKINGDOM": "GB",
    "GREATBRITAIN": "GB",
    "US": "US",
    "USA": "US",
    "UNITEDSTATES": "US",
    "NONE": "NONE",
    "DISABLED": "NONE",
    "OFF": "NONE",
}
_holiday_cache: Dict[Tuple[str, int], Any] = {}

_storage_lock = threading.RLock()
_runtime_lock = threading.RLock()
_schedule_monitor_lock = threading.RLock()
_schedule_monitor_stop = threading.Event()
_schedule_monitor_thread: Optional[threading.Thread] = None
_schedule_monitor_state: Dict[str, bool] = {}

router = APIRouter(tags=["flows"])


class FlowVariableModel(BaseModel):
    key: str = Field(..., min_length=1)
    type: str = "string"
    value: Any = ""
    source: str = "manual"
    input_kind: Optional[str] = None
    channel: Optional[str] = None


class FlowNodeModel(BaseModel):
    id: str = Field(..., min_length=1)
    type: str = Field(..., min_length=1)
    category: str = Field(..., min_length=1)
    label: str = Field(..., min_length=1)
    x: float = 80
    y: float = 80
    config: Dict[str, Any] = Field(default_factory=dict)


class FlowEdgeModel(BaseModel):
    id: str = Field(..., min_length=1)
    source: str = Field(..., min_length=1)
    target: str = Field(..., min_length=1)
    source_handle: str = "out"
    target_handle: str = "in"


class FlowIn(BaseModel):
    name: str = Field(..., min_length=1)
    enabled: bool = True
    variables: List[FlowVariableModel] = Field(default_factory=list)
    nodes: List[FlowNodeModel] = Field(default_factory=list)
    edges: List[FlowEdgeModel] = Field(default_factory=list)


class Flow(FlowIn):
    id: str
    created_at: str
    updated_at: str


class FlowTestRequest(BaseModel):
    flow_id: Optional[str] = None
    flow: Optional[FlowIn] = None
    trigger_node_id: Optional[str] = None
    trigger_payload: Dict[str, Any] = Field(default_factory=dict)


class PublicVariablesIn(BaseModel):
    items: List[FlowVariableModel] = Field(default_factory=list)


class SchedulePeriodModel(BaseModel):
    start: str = "09:00"
    end: str = "17:00"


class ScheduleSpecialDayModel(BaseModel):
    key: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    dates: List[str] = Field(default_factory=list)
    periods: List[SchedulePeriodModel] = Field(default_factory=list)


class ScheduleModel(BaseModel):
    key: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    holiday_calendar: str = _DEFAULT_HOLIDAY_CALENDAR
    days: Dict[str, List[SchedulePeriodModel]] = Field(default_factory=dict)
    special_days: List[ScheduleSpecialDayModel] = Field(default_factory=list)


class SchedulesIn(BaseModel):
    items: List[ScheduleModel] = Field(default_factory=list)


class RecordingPresetIn(BaseModel):
    name: str = Field(..., min_length=1)
    color: str = "#c6a14b"
    

_ONVIF_TRANSITION_BY_LEGACY_TRIGGER = {
    "trigger.onvif_motion_started": "became_active",
    "trigger.onvif_motion_stopped": "became_inactive",
    "trigger.onvif_objects_entered": "became_active",
    "trigger.onvif_objects_left": "became_inactive",
}


NODE_LIBRARY: List[Dict[str, Any]] = [
    {
        "type": "trigger.onvif_event",
        "category": "trigger",
        "label": "ONVIF event",
        "description": "Starts the flow when a selected ONVIF topic is emitted, optionally filtered by active or inactive state transitions.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"device_id": "", "topic": "", "transition": "any", "name": ""},
    },
    {
        "type": "trigger.device_offline",
        "category": "trigger",
        "label": "Device offline",
        "description": "Starts when a device stops reporting stream progress.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"device_id": "", "name": ""},
    },
    {
        "type": "trigger.device_back_online",
        "category": "trigger",
        "label": "Device back online",
        "description": "Starts when a device resumes stream progress.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"device_id": "", "name": ""},
    },
    {
        "type": "trigger.ptz_manual_control_started",
        "category": "trigger",
        "label": "PTZ manual control started",
        "description": "Starts when manual PTZ control begins for a selected device.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"device_id": "", "name": ""},
    },
    {
        "type": "trigger.ptz_manual_control_stopped",
        "category": "trigger",
        "label": "PTZ manual control stopped",
        "description": "Starts when manual PTZ control stops for a selected device.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"device_id": "", "name": ""},
    },
    {
        "type": "trigger.incoming_http_request",
        "category": "trigger",
        "label": "Incoming webhook",
        "description": "Starts when an HTTP request hits the configured path.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"method": "ANY", "path": "/flow-hook/example", "name": ""},
    },
    {
        "type": "trigger.manual",
        "category": "trigger",
        "label": "Manual trigger",
        "description": "Used for manual tests from the editor.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"name": ""},
    },
    {
        "type": "trigger.schedule_active",
        "category": "trigger",
        "label": "Schedule becomes active",
        "description": "Starts when a schedule enters its active hours.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"schedule_key": "", "name": ""},
    },
    {
        "type": "trigger.schedule_inactive",
        "category": "trigger",
        "label": "Schedule becomes inactive",
        "description": "Starts when a schedule leaves its active hours.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"schedule_key": "", "name": ""},
    },
    {
        "type": "trigger.digital_input_changed",
        "category": "trigger",
        "label": "Digital input changed",
        "description": "Starts when a selected Automation HAT Mini digital input changes.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"channel": "1", "changed_to": "any", "name": ""},
    },
    {
        "type": "trigger.analog_input_above",
        "category": "trigger",
        "label": "Analog input goes above",
        "description": "Starts when a selected Automation HAT Mini analog input crosses above the threshold.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"channel": "1", "threshold": 1.0, "name": ""},
    },
    {
        "type": "trigger.analog_input_below",
        "category": "trigger",
        "label": "Analog input goes below",
        "description": "Starts when a selected Automation HAT Mini analog input crosses below the threshold.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"channel": "1", "threshold": 1.0, "name": ""},
    },
    {
        "type": "trigger.physical_output_changed",
        "category": "trigger",
        "label": "Physical output changed",
        "description": "Starts when a selected Automation HAT Mini output or relay changes state.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"target_kind": "output", "channel": "1", "name": ""},
    },
    {
        "type": "condition.compare",
        "category": "condition",
        "label": "Compare",
        "description": "Compares variables, literals, or trigger payload values.",
        "color": "#9c6bff",
        "ports": {"inputs": ["in"], "outputs": ["true", "false"]},
        "defaults": {
            "left_source": "variable",
            "left_value": "",
            "operator": "equals",
            "right_source": "literal",
            "right_value": "",
            "cast": "auto",
            "name": "",
        },
    },
    {
        "type": "condition.schedule_active",
        "category": "condition",
        "label": "Schedule active",
        "description": "Checks whether a selected schedule is currently inside its active hours.",
        "color": "#9c6bff",
        "ports": {"inputs": ["in"], "outputs": ["true", "false"]},
        "defaults": {"schedule_key": "", "name": ""},
    },
    {
        "type": "operator.delay",
        "category": "action",
        "label": "Delay",
        "description": "Waits for the configured number of seconds.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"seconds": 2, "name": ""},
    },
    {
        "type": "operator.set_variable",
        "category": "action",
        "label": "Set variable",
        "description": "Updates a shared variable from a literal, template, variable, trigger path, or physical input.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {
            "variable_key": "",
            "value_source": "literal",
            "value": "",
            "value_input_kind": "digital",
            "value_channel": "1",
            "name": "",
        },
    },
    {
        "type": "action.send_http_request",
        "category": "action",
        "label": "Send HTTP request",
        "description": "Makes an outbound HTTP request with templated values.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {
            "method": "POST",
            "url": "",
            "headers": "{}",
            "body": "",
            "timeout_seconds": 10,
            "name": "",
        },
    },
    {
        "type": "action.activate_physical_output",
        "category": "action",
        "label": "Activate physical output",
        "description": "Turns an Automation HAT Mini output or relay on, off, or pulses it for a number of seconds.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"target_kind": "output", "channel": "1", "mode": "pulse", "pulse_seconds": 2, "name": ""},
    },
    {
        "type": "action.record",
        "category": "action",
        "label": "Start recording",
        "description": "Starts a colored playback marker for the selected camera.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {
            "device_id": "",
            "before_seconds": 10,
            "color": "#c6a14b",
            "name": "",
        },
    },
    {
        "type": "action.stop_recording",
        "category": "action",
        "label": "Stop recording",
        "description": "Stops the most recent in-progress recording marker for the selected camera.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {
            "device_id": "",
        },
    },
    {
        "type": "action.log_message",
        "category": "action",
        "label": "Log message",
        "description": "Writes a formatted message to the flow log.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"message": "Flow {{flow.name}} ran.", "name": ""},
    },
    {
        "type": "action.contribute",
        "category": "action",
        "label": "Take Snapshot",
        "description": "Takes camera snapshots and contributes them to a scenario's buffer.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"target_id": "", "snapshot_entries": [], "name": ""},
    },
    {
        "type": "action.fire",
        "category": "action",
        "label": "Analyse Scenario",
        "description": "Sends the contribution buffer to the AI scenario for analysis.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"target_id": "", "name": ""},
    },
    {
        "type": "action.flush",
        "category": "action",
        "label": "Flush Scenario",
        "description": "Clears a scenario's contribution buffer without analysing.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"target_id": "", "name": ""},
    },
    {
        "type": "action.submit_event",
        "category": "action",
        "label": "Generate event",
        "description": "Submits an event to the events page with a name, priority, and details.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {
            "event_name": "Event",
            "priority": "medium",
            "details": "",
            "snapshot_entries": [],
            "name": "",
        },
    },
]

NODE_LIBRARY_BY_TYPE = {item["type"]: item for item in NODE_LIBRARY}


@router.get("/flows", response_class=HTMLResponse)
def flows_page() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "flows.html").read_text(encoding="utf-8"))


@router.get("/api/flows/catalog")
def flows_catalog() -> Dict[str, Any]:
    recording_presets = _merge_recording_presets(_collect_recording_presets_from_flows(_load_flows()))
    return {
        "nodes": NODE_LIBRARY,
        "devices": _load_devices(),
        "recording_presets": recording_presets,
        "physical_io": physical_io_catalog(),
        "http_methods": sorted(_VALID_HTTP_METHODS),
        "operators": [
            {"value": "equals", "label": "Equals"},
            {"value": "not_equals", "label": "Does not equal"},
            {"value": "contains", "label": "Contains"},
            {"value": "not_contains", "label": "Does not contain"},
            {"value": "greater_than", "label": "Greater than"},
            {"value": "greater_than_or_equal", "label": "Greater than or equal"},
            {"value": "less_than", "label": "Less than"},
            {"value": "less_than_or_equal", "label": "Less than or equal"},
            {"value": "is_true", "label": "Is true"},
            {"value": "is_false", "label": "Is false"},
        ],
    }


@router.get("/api/physical-io/state")
def get_physical_io_state() -> Dict[str, Any]:
    return physical_io_state(refresh=False)


@router.get("/api/public-variables")
def list_public_variables() -> Dict[str, Any]:
    _migrate_legacy_flow_variables()
    return _public_variables_response()


@router.put("/api/public-variables")
def save_public_variables(req: PublicVariablesIn) -> Dict[str, Any]:
    _migrate_legacy_flow_variables()

    items = _normalize_variable_items((_dump(req) or {}).get("items") or [])
    _validate_schedule_variable_values(items)
    existing_keys = {item["key"] for item in _load_public_variable_definitions()}
    next_keys = {item["key"] for item in items}
    usages = _describe_public_variable_usages(existing_keys - next_keys)
    if usages:
        raise HTTPException(
            status_code=400,
            detail="Cannot remove public variables still used by saved flows: " + "; ".join(usages),
        )

    with _storage_lock:
        _save_public_variable_definitions(items)

    _reconcile_public_variable_runtime_values(items, prefer_definition_values=True)
    return {"ok": True, **_public_variables_response()}


@router.get("/api/schedules")
def list_schedules() -> Dict[str, Any]:
    return _schedules_response()


@router.put("/api/schedules")
def save_schedules(req: SchedulesIn) -> Dict[str, Any]:
    items = _normalize_schedule_items((_dump(req) or {}).get("items") or [])
    existing_keys = {item["key"] for item in _load_schedule_definitions()}
    next_keys = {item["key"] for item in items}
    usages = _describe_schedule_usages(existing_keys - next_keys)
    if usages:
        raise HTTPException(
            status_code=400,
            detail="Cannot remove schedules still used by saved flows or variables: " + "; ".join(usages),
        )

    with _storage_lock:
        _save_schedule_definitions(items)

    return {"ok": True, **_schedules_response()}


@router.get("/api/recording-presets")
def list_recording_presets() -> Dict[str, Any]:
    return {"items": _merge_recording_presets(_collect_recording_presets_from_flows(_load_flows()))}


@router.post("/api/recording-presets")
def create_recording_preset(req: RecordingPresetIn) -> Dict[str, Any]:
    preset = _normalize_recording_preset_item(_dump(req))
    if preset is None:
        raise HTTPException(status_code=400, detail="Recording tag is invalid")

    with _storage_lock:
        items = _load_recording_presets()
        if _find_recording_preset(preset["name"], items) is not None:
            raise HTTPException(status_code=400, detail=f"Recording tag already exists: {preset['name']}")
        items.append(preset)
        items = _sort_recording_presets(items)
        _save_recording_presets(items)

    return {"ok": True, "item": preset, "items": items}


@router.put("/api/recording-presets/{preset_name}")
def update_recording_preset(preset_name: str, req: RecordingPresetIn) -> Dict[str, Any]:
    preset = _normalize_recording_preset_item(_dump(req))
    if preset is None:
        raise HTTPException(status_code=400, detail="Recording tag is invalid")

    with _storage_lock:
        items = _load_recording_presets()
        existing = _find_recording_preset(preset_name, items)
        if existing is None:
            raise HTTPException(status_code=404, detail="Recording tag not found")

        duplicate = _find_recording_preset(preset["name"], items)
        if duplicate is not None and _recording_preset_identity(duplicate.get("name")) != _recording_preset_identity(existing.get("name")):
            raise HTTPException(status_code=400, detail=f"Recording tag already exists: {preset['name']}")

        updated_items = [
            preset if _recording_preset_identity(item.get("name")) == _recording_preset_identity(existing.get("name")) else item
            for item in items
        ]
        updated_items = _sort_recording_presets(updated_items)
        _save_recording_presets(updated_items)

        flows = _load_flows()
        synced_flows, changed_nodes = _rewrite_recording_preset_references(flows, existing, preset)
        if changed_nodes:
            _save_flows(synced_flows)

    return {"ok": True, "item": preset, "items": updated_items, "updated_nodes": changed_nodes}


@router.delete("/api/recording-presets/{preset_name}")
def delete_recording_preset(preset_name: str) -> Dict[str, Any]:
    with _storage_lock:
        items = _load_recording_presets()
        existing = _find_recording_preset(preset_name, items)
        if existing is None:
            raise HTTPException(status_code=404, detail="Recording tag not found")

        updated_items = [
            item for item in items
            if _recording_preset_identity(item.get("name")) != _recording_preset_identity(existing.get("name"))
        ]
        _save_recording_presets(_sort_recording_presets(updated_items))

        flows = _load_flows()
        synced_flows, changed_nodes = _rewrite_recording_preset_references(flows, existing, None)
        if changed_nodes:
            _save_flows(synced_flows)

    return {"ok": True, "items": _sort_recording_presets(updated_items), "removed": existing, "updated_nodes": changed_nodes}


@router.get("/api/flows")
def list_flows() -> Dict[str, Any]:
    return {"items": _load_flows()}


@router.get("/api/flows/{flow_id}")
def get_flow(flow_id: str) -> Dict[str, Any]:
    flow = _find_flow(flow_id)
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    return {"item": flow}


@router.post("/api/flows")
def create_flow(req: FlowIn) -> Dict[str, Any]:
    with _storage_lock:
        items = _load_flows()
        item = _normalize_flow_payload(_dump(req))
        items.append(item)
        _save_flows(items)
        _merge_recording_presets(_collect_recording_presets_from_flows(items))
    _log_flows.info("Flow created: '%s' (%s)", item.get("name"), item.get("id"))
    return {"ok": True, "item": item}


@router.put("/api/flows/{flow_id}")
def update_flow(flow_id: str, req: FlowIn) -> Dict[str, Any]:
    with _storage_lock:
        items = _load_flows()
        for idx, item in enumerate(items):
            if item["id"] == flow_id:
                items[idx] = _normalize_flow_payload(
                    _dump(req),
                    existing_id=flow_id,
                    created_at=item["created_at"],
                )
                _save_flows(items)
                _merge_recording_presets(_collect_recording_presets_from_flows(items))
                _log_flows.info("Flow updated: '%s' (%s)", items[idx].get("name"), flow_id)
                return {"ok": True, "item": items[idx]}
    raise HTTPException(status_code=404, detail="Flow not found")


@router.delete("/api/flows/{flow_id}")
def delete_flow(flow_id: str) -> Dict[str, Any]:
    with _storage_lock:
        items = _load_flows()
        new_items = [item for item in items if item["id"] != flow_id]
        if len(new_items) == len(items):
            raise HTTPException(status_code=404, detail="Flow not found")
        _save_flows(new_items)
        _merge_recording_presets(_collect_recording_presets_from_flows(new_items))
        _delete_runtime_state_for_flow(flow_id)
    _log_flows.info("Flow deleted: %s", flow_id)
    return {"ok": True}


@router.get("/api/flows/runtime/{flow_id}")
def get_flow_runtime(flow_id: str) -> Dict[str, Any]:
    flow = _find_flow(flow_id)
    if not flow:
        raise HTTPException(status_code=404, detail="Flow not found")
    return {"variables": _get_runtime_variables(flow)}


@router.post("/api/flows/test")
def test_flow_draft(req: FlowTestRequest) -> Dict[str, Any]:
    return _test_flow_impl(req)


@router.post("/api/flows/test/{flow_id}")
def test_flow(flow_id: str, req: FlowTestRequest) -> Dict[str, Any]:
    req = req.model_copy(update={"flow_id": flow_id})
    return _test_flow_impl(req)


@router.post("/api/flows/run-manual/{flow_id}")
def run_manual_flow(flow_id: str, req: FlowTestRequest) -> Dict[str, Any]:
    flow = _find_flow(flow_id)
    if flow is None:
        raise HTTPException(status_code=404, detail="Flow not found")

    if req.trigger_node_id:
        trigger_node = _node_by_id(flow, req.trigger_node_id)
        if trigger_node is None:
            raise HTTPException(status_code=404, detail="Trigger node not found")
        if trigger_node.get("type") != "trigger.manual":
            raise HTTPException(status_code=400, detail="Selected node is not a manual trigger")
    else:
        trigger_node = next(
            (n for n in flow.get("nodes", []) if n.get("type") == "trigger.manual"),
            None,
        )
        if trigger_node is None:
            raise HTTPException(status_code=400, detail="Flow has no manual trigger node")

    trigger = _manual_trigger_from_node(flow, trigger_node, req.trigger_payload)

    result = _run_flow_from_trigger(
        flow,
        trigger,
        start_node_id=trigger_node["id"],
        manual=True,
        persist_runtime=True,
        append_log=True,
    )

    return {"ok": True, "result": result}


def _test_flow_impl(req: FlowTestRequest) -> Dict[str, Any]:
    saved_flow = None

    if req.flow_id:
        saved_flow = _find_flow(req.flow_id)
        if saved_flow is None and req.flow is None:
            raise HTTPException(status_code=404, detail="Flow not found")

    if req.flow is not None:
        flow = _normalize_flow_payload(
            _dump(req.flow),
            existing_id=(saved_flow or {}).get("id") or req.flow_id,
            created_at=(saved_flow or {}).get("created_at"),
        )
    else:
        flow = saved_flow

    if flow is None:
        raise HTTPException(status_code=400, detail="Flow payload is required")

    trigger_node = None

    if req.trigger_node_id:
        trigger_node = _node_by_id(flow, req.trigger_node_id)
        if trigger_node is None:
            raise HTTPException(status_code=404, detail="Trigger node not found")
        if trigger_node.get("type") != "trigger.manual":
            raise HTTPException(status_code=400, detail="Selected node is not a manual trigger")
    else:
        trigger_node = next(
            (n for n in flow.get("nodes", []) if n.get("type") == "trigger.manual"),
            None,
        )
        if trigger_node is None:
            raise HTTPException(status_code=400, detail="Flow has no manual trigger node")

    trigger = _manual_trigger_from_node(flow, trigger_node, req.trigger_payload)
    result = _run_flow_from_trigger(
        flow,
        trigger,
        start_node_id=trigger_node["id"],
        manual=True,
        persist_runtime=False,
        append_log=False,
    )
    return {"ok": True, "result": result}


def _dump(model: Any) -> Dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()



def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")



def _load_json(path: Path, default: Any) -> Any:
    try:
        if not path.exists():
            return deepcopy(default)
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return deepcopy(default)



def _atomic_save_json(path: Path, payload: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)



def _load_devices() -> List[Dict[str, Any]]:
    payload = _load_json(DEVICES_JSON, {"devices": []})
    items = payload.get("devices") if isinstance(payload, dict) else []
    out: List[Dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "id": str(item.get("id") or "").strip(),
                "name": str(item.get("name") or item.get("id") or "Unnamed device").strip(),
            }
        )
    return [item for item in out if item["id"]]



def _load_flows() -> List[Dict[str, Any]]:
    _migrate_legacy_flow_variables()
    payload = _load_json(FLOWS_JSON, {"items": []})
    items = payload.get("items") if isinstance(payload, dict) else []
    out: List[Dict[str, Any]] = []
    for item in items or []:
        cleaned = _sanitize_loaded_flow(item)
        if cleaned is not None:
            out.append(cleaned)
    return out



def _save_flows(items: List[Dict[str, Any]]) -> None:
    _atomic_save_json(FLOWS_JSON, {"items": items})


def _load_public_variable_definitions() -> List[Dict[str, Any]]:
    payload = _load_json(PUBLIC_VARIABLES_JSON, {"items": []})
    items = payload.get("items") if isinstance(payload, dict) else []
    return _normalize_variable_items(items)


def _save_public_variable_definitions(items: List[Dict[str, Any]]) -> None:
    _atomic_save_json(PUBLIC_VARIABLES_JSON, {"items": items})


def _load_schedule_definitions() -> List[Dict[str, Any]]:
    payload = _load_json(SCHEDULES_JSON, {"items": []})
    items = payload.get("items") if isinstance(payload, dict) else []
    return _normalize_schedule_items(items)


def _save_schedule_definitions(items: List[Dict[str, Any]]) -> None:
    _atomic_save_json(SCHEDULES_JSON, {"items": items})


def _slugify_recording_preset_name(value: Any) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower()).strip("-")
    return slug or "recording"


def _recording_preset_identity(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_record_color(value: Any) -> str:
    raw = str(value or "#c6a14b").strip().lower()
    if len(raw) == 7 and raw.startswith("#"):
        try:
            int(raw[1:], 16)
            return raw
        except Exception:
            pass
    return "#c6a14b"


def _recording_preset_key(name: Any) -> str:
    return _slugify_recording_preset_name(name)


def _normalize_recording_preset_item(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    name = str(item.get("name") or "").strip() or "Recording"
    color = _normalize_record_color(item.get("color"))
    return {
        "key": _recording_preset_key(name),
        "name": name,
        "color": color,
    }


def _recording_preset_from_fields(name: Any, color: Any) -> Dict[str, Any]:
    return _normalize_recording_preset_item({"name": name, "color": color}) or {
        "key": _recording_preset_key("Recording"),
        "name": "Recording",
        "color": "#c6a14b",
    }


def _load_recording_presets() -> List[Dict[str, Any]]:
    payload = _load_json(RECORDING_PRESETS_JSON, {"items": []})
    items = payload.get("items") if isinstance(payload, dict) else []
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for raw in items or []:
        preset = _normalize_recording_preset_item(raw)
        identity = _recording_preset_identity((preset or {}).get("name")) if preset is not None else ""
        if preset is None or not identity or identity in seen:
            continue
        seen.add(identity)
        out.append(preset)
    return out


def _save_recording_presets(items: List[Dict[str, Any]]) -> None:
    _atomic_save_json(RECORDING_PRESETS_JSON, {"items": items})


def _collect_recording_presets_from_flows(flows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for flow in flows:
        for node in flow.get("nodes") or []:
            if str(node.get("type") or "") != "action.record":
                continue
            cfg = node.get("config") if isinstance(node.get("config"), dict) else {}
            preset_name = str(cfg.get("preset_name") or cfg.get("name") or "").strip() or "Recording"
            preset = _recording_preset_from_fields(preset_name, cfg.get("color"))
            identity = _recording_preset_identity(preset["name"])
            if identity in seen:
                continue
            seen.add(identity)
            out.append(preset)
    return out


def _sort_recording_presets(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for raw in items:
        preset = _normalize_recording_preset_item(raw)
        identity = _recording_preset_identity((preset or {}).get("name")) if preset is not None else ""
        if preset is None or not identity or identity in seen:
            continue
        seen.add(identity)
        normalized.append(preset)
    return sorted(normalized, key=lambda item: (str(item.get("name") or "").lower(), item["key"]))


def _find_recording_preset(name: Any, items: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    identity = _recording_preset_identity(name)
    if not identity:
        return None
    for item in items if items is not None else _load_recording_presets():
        if _recording_preset_identity(item.get("name")) == identity:
            return dict(item)
    return None


def _rewrite_recording_preset_references(
    flows: List[Dict[str, Any]],
    previous_preset: Dict[str, Any],
    next_preset: Optional[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], int]:
    previous_name = str(previous_preset.get("name") or "").strip()
    previous_identity = _recording_preset_identity(previous_name)
    changed_nodes = 0
    updated_flows: List[Dict[str, Any]] = []

    for flow in flows:
        flow_copy = deepcopy(flow)
        flow_changed = False
        for node in flow_copy.get("nodes") or []:
            if str(node.get("type") or "") != "action.record":
                continue
            cfg = node.get("config") if isinstance(node.get("config"), dict) else {}
            current_identity = _recording_preset_identity(cfg.get("preset_name") or cfg.get("name"))
            if current_identity != previous_identity:
                continue
            if next_preset is None:
                cfg.pop("preset_name", None)
                cfg["name"] = str(cfg.get("name") or previous_name).strip() or previous_name or "Recording"
                cfg["color"] = _normalize_record_color(cfg.get("color") or previous_preset.get("color"))
                cfg["preset_key"] = _recording_preset_key(cfg["name"])
            else:
                cfg["preset_name"] = next_preset["name"]
                cfg["name"] = next_preset["name"]
                cfg["color"] = next_preset["color"]
                cfg["preset_key"] = next_preset["key"]
            node["config"] = cfg
            flow_changed = True
            changed_nodes += 1
        if flow_changed:
            flow_copy["updated_at"] = _utc_now_iso()
        updated_flows.append(flow_copy)

    return updated_flows, changed_nodes


def _merge_recording_presets(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    current = _load_recording_presets()
    by_identity = {_recording_preset_identity(item.get("name")): item for item in current}
    changed = False

    for raw in items:
        preset = _normalize_recording_preset_item(raw)
        if preset is None:
            continue
        identity = _recording_preset_identity(preset.get("name"))
        if not identity:
            continue
        existing = by_identity.get(identity)
        if existing == preset:
            continue
        if existing is not None:
            continue
        by_identity[identity] = preset
        changed = True

    merged = _sort_recording_presets(list(by_identity.values()))
    if changed or len(merged) != len(current):
        _save_recording_presets(merged)
    return merged


def _schedule_days_template() -> Dict[str, List[Dict[str, str]]]:
    return {day: [] for day in _SCHEDULE_DAY_KEYS}


def _normalize_schedule_date(value: Any, label: str) -> str:
    raw = str(value or "").strip()
    matched = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if matched is None:
        raise HTTPException(status_code=400, detail=f"{label} must use YYYY-MM-DD date")

    year = int(matched.group(1))
    month = int(matched.group(2))
    day = int(matched.group(3))
    try:
        normalized = date(year, month, day)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{label} must use a valid calendar date") from exc
    return normalized.isoformat()


def _normalize_schedule_special_day_key(value: Any, index: int) -> str:
    raw = re.sub(r"[^a-z0-9_-]+", "_", str(value or "").strip().lower())
    raw = re.sub(r"^[_-]+|[_-]+$", "", raw)
    return raw or f"{_SPECIAL_DAY_KEY_PREFIX}{index + 1}"


def _normalize_schedule_special_days(items: Any) -> List[Dict[str, Any]]:
    special_days: List[Dict[str, Any]] = []
    seen_keys: set[str] = set()
    seen_dates: Dict[str, str] = {}

    for index, raw in enumerate(list(items or [])):
        if not isinstance(raw, dict):
            continue

        key = _normalize_schedule_special_day_key(raw.get("key"), index)
        name = str(raw.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail=f"Special day group '{key}' needs a name")
        if key in seen_keys:
            raise HTTPException(status_code=400, detail=f"Duplicate special day group key: {key}")
        seen_keys.add(key)

        dates: List[str] = []
        group_dates: set[str] = set()
        for raw_date in list(raw.get("dates") or []):
            normalized_date = _normalize_schedule_date(raw_date, f"{name} date")
            if normalized_date in group_dates:
                continue
            owner = seen_dates.get(normalized_date)
            if owner is not None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Special day date {normalized_date} is already assigned to '{owner}'",
                )
            group_dates.add(normalized_date)
            seen_dates[normalized_date] = name
            dates.append(normalized_date)
        dates.sort()

        periods: List[Dict[str, str]] = []
        seen_periods: set[Tuple[str, str]] = set()
        for period in list(raw.get("periods") or []):
            if not isinstance(period, dict):
                continue
            start = _normalize_schedule_time(period.get("start"), f"{name} start time")
            end = _normalize_schedule_time(period.get("end"), f"{name} end time")
            if start == end:
                raise HTTPException(
                    status_code=400,
                    detail=f"{name} active hours cannot start and end at the same time",
                )
            pair = (start, end)
            if pair in seen_periods:
                continue
            seen_periods.add(pair)
            periods.append({"start": start, "end": end})

        periods.sort(key=lambda item: (_schedule_time_to_minutes(item["start"]), _schedule_time_to_minutes(item["end"])))
        special_days.append({
            "key": key,
            "name": name,
            "dates": dates,
            "periods": periods,
        })

    return special_days


def _normalize_holiday_calendar(value: Any) -> str:
    raw = re.sub(r"[\s_-]+", "", str(value or _DEFAULT_HOLIDAY_CALENDAR).strip().upper())
    if not raw:
        return _DEFAULT_HOLIDAY_CALENDAR

    normalized = _HOLIDAY_CALENDAR_ALIASES.get(raw)
    if normalized is None:
        raise HTTPException(status_code=400, detail=f"Unsupported holiday calendar: {value}")
    return normalized


def _schedule_holiday_country(schedule: Dict[str, Any]) -> Optional[str]:
    normalized = _normalize_holiday_calendar(schedule.get("holiday_calendar"))
    return None if normalized == "NONE" else normalized


def _load_holidays_module() -> Any:
    try:
        import holidays as holidays_module
    except ImportError:
        return None
    return holidays_module


def _holiday_dates(country: str, year: int) -> Any:
    key = (country, year)
    cached = _holiday_cache.get(key)
    if cached is not None:
        return cached

    holidays_module = _load_holidays_module()
    if holidays_module is None:
        raise RuntimeError("holidays dependency is not installed")

    calendar = holidays_module.country_holidays(country, years=year)
    _holiday_cache[key] = calendar
    return calendar


def _is_schedule_holiday_date(schedule: Dict[str, Any], day_value: date) -> bool:
    country = _schedule_holiday_country(schedule)
    if not country:
        return False
    try:
        return day_value in _holiday_dates(country, day_value.year)
    except Exception:
        return False


def _schedule_special_day_for_date(schedule: Dict[str, Any], day_value: date) -> Optional[Dict[str, Any]]:
    wanted = day_value.isoformat()
    for item in list(schedule.get("special_days") or []):
        if not isinstance(item, dict):
            continue
        if wanted in list(item.get("dates") or []):
            return item
    return None


def _schedule_row_periods(schedule: Dict[str, Any], row_key: str) -> List[Dict[str, str]]:
    if str(row_key).startswith(_SPECIAL_DAY_ROW_PREFIX):
        special_key = str(row_key)[len(_SPECIAL_DAY_ROW_PREFIX):]
        for item in list(schedule.get("special_days") or []):
            if not isinstance(item, dict):
                continue
            if str(item.get("key") or "").strip() == special_key:
                return list(item.get("periods") or [])
        return []

    days = schedule.get("days") if isinstance(schedule.get("days"), dict) else {}
    return list(days.get(row_key) or [])


def _effective_schedule_row_key(schedule: Dict[str, Any], day_value: date) -> str:
    special_day = _schedule_special_day_for_date(schedule, day_value)
    if special_day is not None:
        return f"{_SPECIAL_DAY_ROW_PREFIX}{special_day.get('key')}"

    weekday_key = _WEEKDAY_KEYS[day_value.weekday()]
    holiday_periods = _schedule_row_periods(schedule, _HOLIDAY_DAY_KEY)
    if holiday_periods and _is_schedule_holiday_date(schedule, day_value):
        return _HOLIDAY_DAY_KEY
    return weekday_key


def _normalize_schedule_time(value: Any, label: str) -> str:
    raw = str(value or "").strip()
    matched = re.fullmatch(r"(\d{1,2}):(\d{2})", raw)
    if matched is None:
        raise HTTPException(status_code=400, detail=f"{label} must use HH:MM time")

    hour = int(matched.group(1))
    minute = int(matched.group(2))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise HTTPException(status_code=400, detail=f"{label} must use a valid 24-hour time")
    return f"{hour:02d}:{minute:02d}"


def _schedule_time_to_minutes(value: Any) -> int:
    normalized = _normalize_schedule_time(value, "Schedule time")
    hour, minute = normalized.split(":", 1)
    return int(hour) * 60 + int(minute)


def _normalize_schedule_items(items: Any) -> List[Dict[str, Any]]:
    schedules: List[Dict[str, Any]] = []
    seen_keys: set[str] = set()

    for raw in list(items or []):
        if not isinstance(raw, dict):
            continue

        key = str(raw.get("key") or "").strip()
        name = str(raw.get("name") or "").strip()
        if not key:
            continue
        if not name:
            raise HTTPException(status_code=400, detail=f"Schedule '{key}' needs a name")
        if key in seen_keys:
            raise HTTPException(status_code=400, detail=f"Duplicate schedule key: {key}")
        seen_keys.add(key)

        raw_days = raw.get("days") if isinstance(raw.get("days"), dict) else {}
        days = _schedule_days_template()
        holiday_calendar = _normalize_holiday_calendar(raw.get("holiday_calendar"))
        special_days = _normalize_schedule_special_days(raw.get("special_days") if isinstance(raw.get("special_days"), list) else [])

        for day in _SCHEDULE_DAY_KEYS:
            periods: List[Dict[str, str]] = []
            seen_periods: set[Tuple[str, str]] = set()
            for period in list(raw_days.get(day) or []):
                if not isinstance(period, dict):
                    continue
                start = _normalize_schedule_time(period.get("start"), f"{day.title()} start time")
                end = _normalize_schedule_time(period.get("end"), f"{day.title()} end time")
                if start == end:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{day.title()} active hours cannot start and end at the same time",
                    )
                pair = (start, end)
                if pair in seen_periods:
                    continue
                seen_periods.add(pair)
                periods.append({"start": start, "end": end})

            periods.sort(key=lambda item: (_schedule_time_to_minutes(item["start"]), _schedule_time_to_minutes(item["end"])))
            days[day] = periods

        schedules.append(
            {
                "key": key,
                "name": name,
                "holiday_calendar": holiday_calendar,
                "days": days,
                "special_days": special_days,
            }
        )

    return schedules


def _schedule_by_key(key: Any, items: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    wanted = str(key or "").strip()
    if not wanted:
        return None
    for item in items if items is not None else _load_schedule_definitions():
        if str(item.get("key") or "").strip() == wanted:
            return deepcopy(item)
    return None


def _is_schedule_active_at(schedule: Dict[str, Any], when: Optional[datetime] = None) -> bool:
    now = when or datetime.now()
    current_date = now.date()
    previous_date = current_date - timedelta(days=1)
    current_day = _effective_schedule_row_key(schedule, current_date)
    previous_day = _effective_schedule_row_key(schedule, previous_date)
    minute_of_day = now.hour * 60 + now.minute

    for period in _schedule_row_periods(schedule, current_day):
        if not isinstance(period, dict):
            continue
        start = _schedule_time_to_minutes(period.get("start"))
        end = _schedule_time_to_minutes(period.get("end"))
        if start < end and start <= minute_of_day < end:
            return True
        if start > end and minute_of_day >= start:
            return True

    for period in _schedule_row_periods(schedule, previous_day):
        if not isinstance(period, dict):
            continue
        start = _schedule_time_to_minutes(period.get("start"))
        end = _schedule_time_to_minutes(period.get("end"))
        if start > end and minute_of_day < end:
            return True

    return False


def _schedules_response() -> Dict[str, Any]:
    items = _load_schedule_definitions()
    now = datetime.now()
    return {
        "items": [
            {
                **item,
                "is_active": _is_schedule_active_at(item, now),
            }
            for item in items
        ],
        "evaluated_at": _utc_now_iso(),
    }



def _load_runtime_state() -> Dict[str, Any]:
    payload = _load_json(FLOW_STATE_JSON, {"flows": {}, "public_variables": {"values": {}, "updated_at": None}})
    if not isinstance(payload, dict):
        return {"flows": {}, "public_variables": {"values": {}, "updated_at": None}}

    flows = payload.get("flows")
    if not isinstance(flows, dict):
        flows = {}

    public_state = payload.get("public_variables")
    if not isinstance(public_state, dict):
        public_state = {}

    public_values = public_state.get("values")
    if not isinstance(public_values, dict):
        public_values = {}

    updated_at = str(public_state.get("updated_at") or "").strip() or None

    return {
        "flows": flows,
        "public_variables": {
            "values": public_values,
            "updated_at": updated_at,
        },
    }



def _save_runtime_state(payload: Dict[str, Any]) -> None:
    _atomic_save_json(FLOW_STATE_JSON, payload)



def _delete_runtime_state_for_flow(flow_id: str) -> None:
    with _runtime_lock:
        payload = _load_runtime_state()
        payload.setdefault("flows", {}).pop(flow_id, None)
        _save_runtime_state(payload)


def _migrate_legacy_flow_variables() -> None:
    changed_public = False
    changed_flows = False

    with _storage_lock:
        public_payload = _load_json(PUBLIC_VARIABLES_JSON, {"items": []})
        public_items = _normalize_variable_items(public_payload.get("items") if isinstance(public_payload, dict) else [])
        public_keys = {item["key"] for item in public_items}

        flows_payload = _load_json(FLOWS_JSON, {"items": []})
        raw_items = flows_payload.get("items") if isinstance(flows_payload, dict) else []
        if not isinstance(raw_items, list):
            raw_items = []

        for raw_flow in raw_items:
            if not isinstance(raw_flow, dict):
                continue

            legacy_items = _normalize_variable_items(raw_flow.get("variables") or [])
            for item in legacy_items:
                if item["key"] in public_keys:
                    continue
                public_items.append(item)
                public_keys.add(item["key"])
                changed_public = True

            if raw_flow.get("variables"):
                raw_flow["variables"] = []
                changed_flows = True

        if changed_public:
            _save_public_variable_definitions(public_items)

        if changed_flows:
            _atomic_save_json(FLOWS_JSON, {"items": raw_items})

    if changed_public:
        _reconcile_public_variable_runtime_values(public_items)


def _merge_public_variable_definitions(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    incoming = _normalize_variable_items(items)
    if not incoming:
        return _load_public_variable_definitions()

    changed = False
    with _storage_lock:
        current = _load_public_variable_definitions()
        current_keys = {item["key"] for item in current}
        for item in incoming:
            if item["key"] in current_keys:
                continue
            current.append(item)
            current_keys.add(item["key"])
            changed = True

        if changed:
            _save_public_variable_definitions(current)

    if changed:
        _reconcile_public_variable_runtime_values(current)

    return current



def _find_flow(flow_id: str) -> Optional[Dict[str, Any]]:
    for flow in _load_flows():
        if flow["id"] == flow_id:
            return flow
    return None



def _node_by_id(flow: Dict[str, Any], node_id: str) -> Optional[Dict[str, Any]]:
    for node in flow.get("nodes", []):
        if node["id"] == node_id:
            return node
    return None



def _sanitize_loaded_flow(item: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(item, dict):
        return None
    try:
        return _normalize_flow_payload(
            item,
            existing_id=str(item.get("id") or "").strip() or None,
            created_at=str(item.get("created_at") or "").strip() or None,
        )
    except Exception:
        return None



def _normalize_flow_payload(
    data: Dict[str, Any],
    existing_id: Optional[str] = None,
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    name = str(data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Flow name is required")

    legacy_variables = _normalize_variable_items(data.get("variables") or [])
    _validate_schedule_variable_values(legacy_variables)
    public_variables = _merge_public_variable_definitions(legacy_variables) if legacy_variables else _load_public_variable_definitions()
    public_variable_definitions = {item["key"]: item for item in public_variables}
    schedule_keys = {item["key"] for item in _load_schedule_definitions()}

    nodes: List[Dict[str, Any]] = []
    node_ids: set[str] = set()
    for raw in list(data.get("nodes") or []):
        if not isinstance(raw, dict):
            continue
        node = _normalize_node_payload(raw, public_variable_definitions, schedule_keys)
        if node["id"] in node_ids:
            raise HTTPException(status_code=400, detail=f"Duplicate node id: {node['id']}")
        node_ids.add(node["id"])
        nodes.append(node)

    if not nodes:
        raise HTTPException(status_code=400, detail="Add at least one node")

    if not any(node["category"] == "trigger" for node in nodes):
        raise HTTPException(status_code=400, detail="A flow needs at least one trigger node")

    edges: List[Dict[str, Any]] = []
    edge_ids: set[str] = set()
    seen_pairs: set[Tuple[str, str, str, str]] = set()
    for raw in list(data.get("edges") or []):
        if not isinstance(raw, dict):
            continue
        edge = _normalize_edge_payload(raw, node_ids)
        if edge["id"] in edge_ids:
            raise HTTPException(status_code=400, detail=f"Duplicate edge id: {edge['id']}")
        pair = (edge["source"], edge["source_handle"], edge["target"], edge["target_handle"])
        if pair in seen_pairs:
            continue
        edge_ids.add(edge["id"])
        seen_pairs.add(pair)
        edges.append(edge)

    return {
        "id": existing_id or uuid.uuid4().hex[:12],
        "name": name,
        "enabled": bool(data.get("enabled", True)),
        "variables": [],
        "nodes": nodes,
        "edges": edges,
        "created_at": created_at or _utc_now_iso(),
        "updated_at": _utc_now_iso(),
    }



def _normalize_node_payload(
    raw: Dict[str, Any],
    variable_definitions: Dict[str, Dict[str, Any]],
    schedule_keys: set[str],
) -> Dict[str, Any]:
    source_node_type = str(raw.get("type") or "").strip()
    node_type = source_node_type
    node_id = str(raw.get("id") or "").strip() or uuid.uuid4().hex[:10]
    raw_label = str(raw.get("label") or "").strip()
    raw_config = deepcopy(raw.get("config") or {})

    if node_type == "operator.physical_input":
        raise HTTPException(
            status_code=400,
            detail="Physical input nodes are no longer supported. Bind the physical I/O to a variable instead.",
        )

    if node_type == "operator.template":
        node_type = "operator.set_variable"
        raw_config = {
            **raw_config,
            "value_source": "literal",
            "value": str(raw_config.get("template") or ""),
        }
        raw_config.pop("template", None)
        if raw_label == "Template":
            raw_label = "Set variable"

    if node_type in {"action.activate_output_relay", "action.activate_physical_relay"}:
        node_type = "action.activate_physical_output"
        raw_config.setdefault("target_kind", "relay")
        if raw_label in {"Activate output relay", "Activate physical relay"}:
            raw_label = ""
        if "pulse_seconds" not in raw_config and "activation_seconds" in raw_config:
            raw_config["pulse_seconds"] = raw_config.get("activation_seconds")

    if node_type in _ONVIF_TRANSITION_BY_LEGACY_TRIGGER:
        raw_config.setdefault("transition", _ONVIF_TRANSITION_BY_LEGACY_TRIGGER[node_type])
        node_type = "trigger.onvif_event"
        if raw_label in {"Motion started", "Motion stopped", "Objects entered", "Objects left"}:
            raw_label = ""

    if node_type not in NODE_LIBRARY_BY_TYPE:
        raise HTTPException(status_code=400, detail=f"Unsupported node type: {node_type}")

    definition = NODE_LIBRARY_BY_TYPE[node_type]
    category = definition["category"]
    label = raw_label or definition["label"]
    config = deepcopy(definition.get("defaults") or {})
    config.update(raw_config)
    config = _normalize_node_config(node_type, config, variable_definitions, schedule_keys)

    return {
        "id": node_id,
        "type": node_type,
        "category": category,
        "label": label,
        "x": float(raw.get("x") or 80),
        "y": float(raw.get("y") or 80),
        "config": config,
    }



def _normalize_edge_payload(raw: Dict[str, Any], node_ids: set[str]) -> Dict[str, Any]:
    source = str(raw.get("source") or "").strip()
    target = str(raw.get("target") or "").strip()
    if source not in node_ids or target not in node_ids:
        raise HTTPException(status_code=400, detail="Edges must connect existing nodes")
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:10]).strip(),
        "source": source,
        "target": target,
        "source_handle": str(raw.get("source_handle") or "out").strip() or "out",
        "target_handle": str(raw.get("target_handle") or "in").strip() or "in",
    }



def _normalize_node_config(
    node_type: str,
    config: Dict[str, Any],
    variable_definitions: Dict[str, Dict[str, Any]],
    schedule_keys: set[str],
) -> Dict[str, Any]:
    cfg = dict(config)
    variable_keys = set(variable_definitions)

    if node_type == "trigger.onvif_event":
        cfg["device_id"] = str(cfg.get("device_id") or "").strip()
        cfg["topic"] = _normalize_topic(cfg.get("topic"))
        cfg["transition"] = _normalize_onvif_transition(cfg.get("transition"))
        if not cfg["device_id"]:
            raise HTTPException(status_code=400, detail="ONVIF trigger needs a device")
        if not cfg["topic"]:
            raise HTTPException(status_code=400, detail="ONVIF trigger needs a topic")
        return cfg

    if node_type in {
        "trigger.device_offline",
        "trigger.device_back_online",
        "trigger.ptz_manual_control_started",
        "trigger.ptz_manual_control_stopped",
    }:
        cfg["device_id"] = str(cfg.get("device_id") or "").strip()
        if not cfg["device_id"]:
            raise HTTPException(status_code=400, detail="Device trigger needs a device")
        return cfg

    if node_type == "trigger.incoming_http_request":
        cfg["method"] = _normalize_http_method(cfg.get("method"), allow_any=True) or "ANY"
        cfg["path"] = _normalize_http_path(cfg.get("path"))
        if not cfg["path"]:
            raise HTTPException(status_code=400, detail="Webhook trigger needs a path")
        return cfg

    if node_type == "trigger.manual":
        return cfg

    if node_type in {"trigger.schedule_active", "trigger.schedule_inactive"}:
        cfg["schedule_key"] = str(cfg.get("schedule_key") or "").strip()
        if not cfg["schedule_key"]:
            raise HTTPException(status_code=400, detail="Schedule trigger needs a schedule")
        return cfg

    if node_type == "trigger.digital_input_changed":
        cfg["channel"] = _normalize_physical_channel(cfg.get("channel"), "digital")
        cfg["changed_to"] = str(cfg.get("changed_to") or "any").strip().lower()
        if cfg["changed_to"] not in {"any", "high", "low"}:
            cfg["changed_to"] = "any"
        return cfg

    if node_type in {"trigger.analog_input_above", "trigger.analog_input_below"}:
        cfg["channel"] = _normalize_physical_channel(cfg.get("channel"), "analog")
        try:
            cfg["threshold"] = float(cfg.get("threshold") or 0)
        except Exception:
            raise HTTPException(status_code=400, detail="Analog threshold must be numeric")
        return cfg

    if node_type == "trigger.physical_output_changed":
        cfg["target_kind"] = _normalize_physical_switch_kind(cfg.get("target_kind"))
        cfg["channel"] = _normalize_physical_channel(cfg.get("channel"), cfg["target_kind"])
        return cfg

    if node_type == "condition.compare":
        cfg["left_source"] = _normalize_source_type(cfg.get("left_source"), allow_trigger=True, allow_physical_input=True)
        cfg["right_source"] = _normalize_source_type(cfg.get("right_source"), allow_trigger=True, allow_physical_input=True)
        cfg["operator"] = str(cfg.get("operator") or "equals").strip()
        cfg["cast"] = str(cfg.get("cast") or "auto").strip()
        cfg["left_value"] = str(cfg.get("left_value") or "").strip()
        cfg["right_value"] = str(cfg.get("right_value") or "").strip()
        cfg["left_input_kind"] = _normalize_physical_value_kind(cfg.get("left_input_kind"))
        cfg["right_input_kind"] = _normalize_physical_value_kind(cfg.get("right_input_kind"))
        cfg["left_channel"] = str(cfg.get("left_channel") or "1").strip() or "1"
        cfg["right_channel"] = str(cfg.get("right_channel") or "1").strip() or "1"
        if cfg["left_source"] == "physical_input":
            cfg["left_channel"] = _normalize_physical_channel(cfg.get("left_channel"), cfg["left_input_kind"])
            cfg["left_value"] = f"{cfg['left_input_kind']}:{cfg['left_channel']}"
        if cfg["right_source"] == "physical_input":
            cfg["right_channel"] = _normalize_physical_channel(cfg.get("right_channel"), cfg["right_input_kind"])
            cfg["right_value"] = f"{cfg['right_input_kind']}:{cfg['right_channel']}"
        return cfg

    if node_type == "condition.schedule_active":
        cfg["schedule_key"] = str(cfg.get("schedule_key") or "").strip()
        if not cfg["schedule_key"]:
            raise HTTPException(status_code=400, detail="Schedule condition needs a schedule")
        return cfg

    if node_type == "operator.delay":
        try:
            cfg["seconds"] = float(cfg.get("seconds") or 0)
        except Exception:
            raise HTTPException(status_code=400, detail="Delay seconds must be numeric")
        if cfg["seconds"] < 0:
            raise HTTPException(status_code=400, detail="Delay seconds cannot be negative")
        return cfg

    if node_type == "operator.set_variable":
        cfg["variable_key"] = str(cfg.get("variable_key") or "").strip()
        cfg["value_source"] = _normalize_source_type(
            cfg.get("value_source"),
            allow_trigger=True,
            allow_physical_input=True,
        )
        cfg["value"] = str(cfg.get("value") or "").strip()
        cfg["value_input_kind"] = _normalize_physical_value_kind(cfg.get("value_input_kind"))
        cfg["value_channel"] = str(cfg.get("value_channel") or "1").strip() or "1"
        if not cfg["variable_key"]:
            raise HTTPException(status_code=400, detail="Set variable needs a variable key")
        if cfg["value_source"] == "physical_input":
            cfg["value_channel"] = _normalize_physical_channel(cfg.get("value_channel"), cfg["value_input_kind"])
        return cfg

    if node_type == "operator.template":
        cfg["variable_key"] = str(cfg.get("variable_key") or "").strip()
        cfg["template"] = str(cfg.get("template") or "")
        if not cfg["variable_key"]:
            raise HTTPException(status_code=400, detail="Template node needs a variable key")
        return cfg

    if node_type == "action.send_http_request":
        cfg["method"] = _normalize_http_method(cfg.get("method"), allow_any=False)
        cfg["url"] = str(cfg.get("url") or "").strip()
        cfg["headers"] = str(cfg.get("headers") or "{}")
        cfg["body"] = str(cfg.get("body") or "")
        try:
            cfg["timeout_seconds"] = float(cfg.get("timeout_seconds") or 10)
        except Exception:
            raise HTTPException(status_code=400, detail="HTTP timeout must be numeric")
        if not cfg["method"] or not cfg["url"]:
            raise HTTPException(status_code=400, detail="HTTP action needs method and URL")
        if cfg["timeout_seconds"] <= 0:
            raise HTTPException(status_code=400, detail="HTTP timeout must be greater than 0")
        _parse_headers_json(cfg["headers"])
        return cfg

    if node_type == "action.activate_physical_output":
        physical_kind = str(cfg.get("target_kind") or "output").strip().lower()
        if physical_kind not in {"output", "relay"}:
            physical_kind = "output"
        cfg["target_kind"] = physical_kind
        label = "Physical output" if physical_kind == "output" else "Physical relay"
        cfg["channel"] = _normalize_physical_channel(cfg.get("channel"), physical_kind)
        cfg["mode"] = str(cfg.get("mode") or "pulse").strip().lower()
        if cfg["mode"] not in {"on", "off", "pulse"}:
            raise HTTPException(status_code=400, detail=f"{label} mode must be on, off or pulse")
        try:
            cfg["pulse_seconds"] = float(cfg.get("pulse_seconds") or 2)
        except Exception:
            raise HTTPException(status_code=400, detail=f"{label} pulse_seconds must be numeric")
        if cfg["mode"] == "pulse" and cfg["pulse_seconds"] <= 0:
            raise HTTPException(status_code=400, detail=f"{label} pulse_seconds must be greater than 0")
        return cfg

    if node_type == "action.record":
        cfg["device_id"] = str(cfg.get("device_id") or "").strip()
        if not cfg["device_id"]:
            raise HTTPException(status_code=400, detail="Record action needs a device")
        cfg["preset_name"] = str(cfg.get("preset_name") or "").strip()
        cfg["name"] = str(cfg.get("name") or cfg.get("preset_name") or "").strip()
        try:
            cfg["before_seconds"] = float(cfg.get("before_seconds") or 0)
        except Exception:
            raise HTTPException(status_code=400, detail="Record seconds before must be numeric")
        if cfg["before_seconds"] < 0:
            raise HTTPException(status_code=400, detail="Record seconds before cannot be negative")
        if cfg.get("after_seconds") in {None, ""}:
            cfg.pop("after_seconds", None)
        else:
            try:
                cfg["after_seconds"] = float(cfg.get("after_seconds") or 0)
            except Exception:
                raise HTTPException(status_code=400, detail="Record seconds after must be numeric")
            if cfg["after_seconds"] < 0:
                raise HTTPException(status_code=400, detail="Record seconds after cannot be negative")
        color = _normalize_record_color(cfg.get("color"))
        if str(cfg.get("color") or "").strip() and color != str(cfg.get("color") or "").strip().lower():
            raw_color = str(cfg.get("color") or "").strip().lower()
            if len(raw_color) != 7 or not raw_color.startswith("#"):
                raise HTTPException(status_code=400, detail="Record color must be a hex value like #c6a14b")
            try:
                int(raw_color[1:], 16)
            except Exception:
                raise HTTPException(status_code=400, detail="Record color must be a hex value like #c6a14b")
        elif len(color) != 7 or not color.startswith("#"):
            raise HTTPException(status_code=400, detail="Record color must be a hex value like #c6a14b")
        preset = _find_recording_preset(cfg.get("preset_name") or cfg.get("name"))
        if preset is not None:
            cfg["preset_name"] = preset["name"]
            cfg["name"] = preset["name"]
            cfg["color"] = preset["color"]
            cfg["preset_key"] = preset["key"]
        else:
            cfg["color"] = color
            cfg["preset_name"] = str(cfg.get("preset_name") or "").strip() or None
            cfg["name"] = cfg["name"] or cfg["preset_name"] or "Recording"
            cfg["preset_key"] = _recording_preset_key(cfg["preset_name"] or cfg["name"])
        return cfg

    if node_type == "action.stop_recording":
        cfg["device_id"] = str(cfg.get("device_id") or "").strip()
        if not cfg["device_id"]:
            raise HTTPException(status_code=400, detail="Stop recording action needs a device")
        return cfg

    if node_type == "action.log_message":
        cfg["message"] = str(cfg.get("message") or "")
        return cfg

    if node_type == "action.contribute":
        cfg["target_type"] = str(cfg.get("target_type") or "event").strip().lower()
        if cfg["target_type"] not in {"event", "scenario"}:
            cfg["target_type"] = "event"
        cfg["target_id"] = str(cfg.get("target_id") or "").strip()
        cfg["text"] = str(cfg.get("text") or "")
        entries = cfg.get("snapshot_entries")
        out: list = []
        for entry in (entries if isinstance(entries, list) else []):
            if not isinstance(entry, dict):
                continue
            did = str(entry.get("device_id") or "").strip()
            if not did:
                continue
            out.append({"device_id": did})
        cfg["snapshot_entries"] = out
        return cfg

    if node_type == "action.fire":
        cfg["target_type"] = str(cfg.get("target_type") or "event").strip().lower()
        if cfg["target_type"] not in {"event", "scenario"}:
            cfg["target_type"] = "event"
        cfg["target_id"] = str(cfg.get("target_id") or "").strip()
        return cfg

    if node_type == "action.flush":
        cfg["target_type"] = str(cfg.get("target_type") or "event").strip().lower()
        if cfg["target_type"] not in {"event", "scenario"}:
            cfg["target_type"] = "event"
        cfg["target_id"] = str(cfg.get("target_id") or "").strip()
        return cfg

    if node_type == "action.submit_event":
        cfg["event_name"] = str(cfg.get("event_name") or "Event").strip() or "Event"
        cfg["priority"] = str(cfg.get("priority") or "medium").strip().lower()
        if cfg["priority"] not in {"critical", "high", "medium", "low", "info"}:
            cfg["priority"] = "medium"
        cfg["details"] = str(cfg.get("details") or "")
        entries = cfg.get("snapshot_entries")
        out: list = []
        for entry in (entries if isinstance(entries, list) else []):
            if not isinstance(entry, dict):
                continue
            did = str(entry.get("device_id") or "").strip()
            if not did:
                continue
            out.append({"device_id": did})
        cfg["snapshot_entries"] = out
        return cfg

    return cfg



def _normalize_source_type(value: Any, allow_trigger: bool, allow_physical_input: bool = False) -> str:
    source = str(value or "literal").strip().lower()
    allowed = {"literal", "variable"}
    if allow_trigger:
        allowed.add("trigger")
    if allow_physical_input:
        allowed.add("physical_input")
    if source not in allowed:
        source = "literal"
    return source



def _normalize_http_method(value: Any, allow_any: bool = False) -> str:
    method = str(value or "").strip().upper()
    if not method:
        return "ANY" if allow_any else ""
    if allow_any and method == "ANY":
        return "ANY"
    return method if method in _VALID_HTTP_METHODS else ""



def _normalize_http_path(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    raw = raw.split("?", 1)[0].strip()
    if not raw.startswith("/"):
        raw = f"/{raw}"
    parts = [part for part in raw.split("/") if part]
    return f"/{'/'.join(parts)}" if parts else "/"



def _normalize_topic(value: Any) -> str:
    raw = str(value or "").strip().strip("/")
    if not raw:
        return ""
    parts = [part.strip() for part in raw.split("/") if part.strip()]
    cleaned: List[str] = []
    for part in parts:
        if ":" in part:
            part = part.split(":", 1)[1]
        cleaned.append(part)
    return "/".join(cleaned)


def _normalize_onvif_transition(value: Any) -> str:
    raw = str(value or "any").strip().lower()
    aliases = {
        "": "any",
        "any": "any",
        "all": "any",
        "started": "became_active",
        "entered": "became_active",
        "active": "became_active",
        "true": "became_active",
        "became_true": "became_active",
        "became_active": "became_active",
        "stopped": "became_inactive",
        "left": "became_inactive",
        "inactive": "became_inactive",
        "false": "became_inactive",
        "became_false": "became_inactive",
        "became_inactive": "became_inactive",
    }
    return aliases.get(raw, "any")


def _normalize_physical_input_kind(value: Any) -> str:
    kind = str(value or "digital").strip().lower()
    return kind if kind in {"digital", "analog"} else "digital"


def _normalize_physical_switch_kind(value: Any) -> str:
    kind = str(value or "output").strip().lower()
    return kind if kind in {"output", "relay"} else "output"


def _normalize_physical_value_kind(value: Any) -> str:
    kind = str(value or "digital").strip().lower()
    return kind if kind in {"digital", "analog", "output", "relay"} else "digital"


def _normalize_physical_channel(value: Any, kind: str) -> str:
    label = {
        "digital": "digital input",
        "analog": "analog input",
        "output": "output",
        "relay": "relay",
    }.get(kind, kind)

    try:
        channel = int(str(value or "").strip())
    except Exception:
        raise HTTPException(status_code=400, detail=f"Select a valid {label} channel")

    if channel not in physical_channels(kind):
        raise HTTPException(status_code=400, detail=f"Select a valid {label} channel")

    return str(channel)


def _format_physical_value(kind: str, value: Any) -> str:
    if value is None:
        return "Unavailable"
    if kind == "analog":
        try:
            return f"{float(value):.2f} V"
        except Exception:
            return str(value)
    if kind == "output":
        return "On" if _to_bool(value) else "Off"
    return "High" if _to_bool(value) else "Low"



def _parse_headers_json(raw: str) -> Dict[str, str]:
    try:
        parsed = json.loads(raw or "{}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Headers must be valid JSON: {exc}")
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Headers must be a JSON object")
    return {str(key): str(value) for key, value in parsed.items()}



def _coerce_runtime_value(value: Any, variable_type: str) -> Any:
    if variable_type == "number":
        try:
            return float(value) if value not in (None, "") else 0.0
        except Exception:
            return 0.0
    if variable_type == "boolean":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}
    if variable_type == "json":
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value) if value not in (None, "") else {}
        except Exception:
            return {}
    if variable_type == "schedule":
        return "" if value is None else str(value).strip()
    return "" if value is None else str(value)


def _normalize_variable_source(value: Any) -> str:
    source = str(value or "manual").strip().lower()
    if source not in {"manual", "physical_input"}:
        source = "manual"
    return source


def _physical_variable_type(kind: str) -> str:
    return "number" if kind == "analog" else "boolean"


def _physical_variable_default(kind: str) -> Any:
    return 0.0 if kind == "analog" else False


def _normalize_variable_items(items: Any) -> List[Dict[str, Any]]:
    variables: List[Dict[str, Any]] = []
    seen_variable_keys: set[str] = set()

    for raw in list(items or []):
        if not isinstance(raw, dict):
            continue

        key = str(raw.get("key") or "").strip()
        if not key:
            continue

        if key in seen_variable_keys:
            raise HTTPException(status_code=400, detail=f"Duplicate variable key: {key}")

        seen_variable_keys.add(key)
        source = _normalize_variable_source(raw.get("source"))
        input_kind = ""
        channel = ""

        if source == "physical_input":
            input_kind = _normalize_physical_value_kind(raw.get("input_kind"))
            channel = _normalize_physical_channel(raw.get("channel"), input_kind)
            variable_type = _physical_variable_type(input_kind)
            default_value = _physical_variable_default(input_kind)
        else:
            variable_type = str(raw.get("type") or "string").strip().lower()
            if variable_type not in {"string", "number", "boolean", "json", "schedule"}:
                variable_type = "string"
            default_value = raw.get("value")

        variables.append(
            {
                "key": key,
                "type": variable_type,
                "value": _coerce_runtime_value(default_value, variable_type),
                "source": source,
                "input_kind": input_kind,
                "channel": channel,
            }
        )

    return variables


def _validate_schedule_variable_values(items: List[Dict[str, Any]]) -> None:
    pass



def get_flow_topics_for_device(device_id: str) -> List[str]:
    topics: set[str] = set()
    try:
        for flow in _load_flows():
            if not flow.get("enabled", True):
                continue
            for node in flow.get("nodes", []):
                if node.get("type") != "trigger.onvif_event":
                    continue
                cfg = node.get("config") or {}
                if str(cfg.get("device_id") or "").strip() != device_id:
                    continue
                topic = _normalize_topic(cfg.get("topic"))
                if topic:
                    topics.add(topic)
    except Exception:
        return []
    return sorted(topics)



def _build_adjacency(flow: Dict[str, Any]) -> Dict[str, Dict[str, List[Dict[str, Any]]]]:
    nodes = {node["id"]: node for node in flow.get("nodes", [])}
    out: Dict[str, Dict[str, List[Dict[str, Any]]]] = {node_id: {} for node_id in nodes}
    for edge in flow.get("edges", []):
        out.setdefault(edge["source"], {}).setdefault(edge.get("source_handle") or "out", []).append(edge)
    return out



def _public_variable_definitions_by_key(items: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Dict[str, Any]]:
    definitions = items if items is not None else _load_public_variable_definitions()
    return {item["key"]: item for item in definitions}



def _public_variable_defaults(items: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    definitions = items if items is not None else _load_public_variable_definitions()
    return {item["key"]: deepcopy(item.get("value")) for item in definitions}



def _public_variable_values(items: Optional[List[Dict[str, Any]]] = None) -> Tuple[Dict[str, Any], Optional[str]]:
    definitions = items if items is not None else _load_public_variable_definitions()
    defaults = _public_variable_defaults(definitions)
    definitions_by_key = _public_variable_definitions_by_key(definitions)

    with _runtime_lock:
        state = _load_runtime_state()
        public_state = state.get("public_variables") or {}
        saved = public_state.get("values") or {}
        updated_at = str(public_state.get("updated_at") or "").strip() or None

    merged = dict(defaults)
    for item in definitions:
        if item.get("source") != "physical_input":
            continue

        input_kind = _normalize_physical_value_kind(item.get("input_kind"))
        channel = _normalize_physical_channel(item.get("channel"), input_kind)

        try:
            reading = read_physical_value(input_kind, int(channel))
        except Exception:
            continue

        merged[item["key"]] = _coerce_runtime_value(reading.get("value"), item["type"])

    if isinstance(saved, dict):
        for key, value in saved.items():
            definition = definitions_by_key.get(key)
            if definition is None:
                continue
            if definition.get("source") == "physical_input":
                continue
            merged[key] = _coerce_runtime_value(value, definition["type"])

    return merged, updated_at



def _public_variables_response() -> Dict[str, Any]:
    definitions = _load_public_variable_definitions()
    current_values, updated_at = _public_variable_values(definitions)
    return {
        "items": [
            {
                **item,
                "current_value": deepcopy(current_values.get(item["key"], item.get("value"))),
            }
            for item in definitions
        ],
        "updated_at": updated_at,
    }



def _reconcile_public_variable_runtime_values(
    items: Optional[List[Dict[str, Any]]] = None,
    prefer_definition_values: bool = False,
) -> None:
    definitions = items if items is not None else _load_public_variable_definitions()

    with _runtime_lock:
        payload = _load_runtime_state()
        public_state = payload.setdefault("public_variables", {})
        saved = public_state.get("values")
        if not isinstance(saved, dict):
            saved = {}

        merged: Dict[str, Any] = {}
        for item in definitions:
            key = item["key"]
            if item.get("source") == "physical_input":
                continue
            source_value = item.get("value") if prefer_definition_values else saved.get(key, item.get("value"))
            merged[key] = _coerce_runtime_value(source_value, item["type"])

        public_state["values"] = merged
        public_state["updated_at"] = _utc_now_iso()
        _save_runtime_state(payload)



def _flow_variable_references(flow: Dict[str, Any]) -> set[str]:
    references: set[str] = set()

    for node in flow.get("nodes", []):
        cfg = node.get("config") or {}
        node_type = node.get("type")

        if node_type in {"operator.set_variable", "operator.template"}:
            key = str(cfg.get("variable_key") or "").strip()
            if key:
                references.add(key)

        if node_type == "operator.set_variable" and str(cfg.get("value_source") or "").strip() == "variable":
            key = str(cfg.get("value") or "").strip()
            if key:
                references.add(key)

        if node_type == "condition.compare":
            if str(cfg.get("left_source") or "").strip() == "variable":
                key = str(cfg.get("left_value") or "").strip()
                if key:
                    references.add(key)

            if str(cfg.get("right_source") or "").strip() == "variable":
                key = str(cfg.get("right_value") or "").strip()
                if key:
                    references.add(key)

    return references


def _schedule_references_in_variable_definitions(items: List[Dict[str, Any]]) -> set[str]:
    references: set[str] = set()
    for item in items:
        if item.get("source") == "physical_input":
            continue
        if str(item.get("type") or "") != "schedule":
            continue
        key = str(item.get("value") or "").strip()
        if key:
            references.add(key)
    return references


def _flow_schedule_references(flow: Dict[str, Any]) -> set[str]:
    references: set[str] = set()
    variable_definitions = _public_variable_definitions_by_key()

    for node in flow.get("nodes", []):
        cfg = node.get("config") or {}
        node_type = node.get("type")

        if node_type in {"trigger.schedule_active", "trigger.schedule_inactive"}:
            key = str(cfg.get("schedule_key") or "").strip()
            if key:
                references.add(key)

        if node_type == "operator.set_variable":
            target_key = str(cfg.get("variable_key") or "").strip()
            target_definition = variable_definitions.get(target_key) or {}
            if target_definition.get("type") == "schedule" and str(cfg.get("value_source") or "").strip() == "literal":
                value = str(cfg.get("value") or "").strip()
                if value:
                    references.add(value)

        if node_type == "condition.compare":
            left_source = str(cfg.get("left_source") or "").strip()
            right_source = str(cfg.get("right_source") or "").strip()
            if left_source == "variable" and right_source == "literal":
                left_definition = variable_definitions.get(str(cfg.get("left_value") or "").strip()) or {}
                value = str(cfg.get("right_value") or "").strip()
                if left_definition.get("type") == "schedule" and value:
                    references.add(value)
            if right_source == "variable" and left_source == "literal":
                right_definition = variable_definitions.get(str(cfg.get("right_value") or "").strip()) or {}
                value = str(cfg.get("left_value") or "").strip()
                if right_definition.get("type") == "schedule" and value:
                    references.add(value)

        if node_type == "condition.schedule_active":
            key = str(cfg.get("schedule_key") or "").strip()
            if key:
                references.add(key)

    return references



def _describe_public_variable_usages(variable_keys: set[str]) -> List[str]:
    if not variable_keys:
        return []

    usages: List[str] = []
    for flow in _load_flows():
        hits = sorted(_flow_variable_references(flow) & variable_keys)
        if hits:
            usages.append(f"{flow['name']}: {', '.join(hits)}")

    return usages


def _describe_schedule_usages(schedule_keys: set[str]) -> List[str]:
    if not schedule_keys:
        return []

    usages: List[str] = []
    variable_hits = sorted(_schedule_references_in_variable_definitions(_load_public_variable_definitions()) & schedule_keys)
    if variable_hits:
        usages.append(f"Variables: {', '.join(variable_hits)}")

    for flow in _load_flows():
        hits = sorted(_flow_schedule_references(flow) & schedule_keys)
        if hits:
            usages.append(f"{flow['name']}: {', '.join(hits)}")

    return usages



def _get_runtime_variables(flow: Dict[str, Any]) -> Dict[str, Any]:
    values, _ = _public_variable_values()
    return values



def _save_runtime_variables(flow: Dict[str, Any], variables: Dict[str, Any], changed_keys: Optional[set[str]] = None) -> None:
    definitions = _load_public_variable_definitions()
    definitions_by_key = _public_variable_definitions_by_key(definitions)
    keys_to_save = {key for key in (changed_keys or set(definitions_by_key)) if key in definitions_by_key}
    if not keys_to_save:
        return

    with _runtime_lock:
        payload = _load_runtime_state()
        public_state = payload.setdefault("public_variables", {})
        saved = public_state.get("values")
        if not isinstance(saved, dict):
            saved = {}

        for key in keys_to_save:
            if definitions_by_key[key].get("source") == "physical_input":
                continue
            saved[key] = _coerce_runtime_value(variables.get(key), definitions_by_key[key]["type"])

        public_state["values"] = {key: saved[key] for key in definitions_by_key if key in saved}
        public_state["updated_at"] = _utc_now_iso()
        _save_runtime_state(payload)


def _set_public_variable_value(key: str, value: Any) -> None:
    """Set a single public variable's runtime value (for auto-fire scenarios)."""
    definitions = _load_public_variable_definitions()
    definitions_by_key = _public_variable_definitions_by_key(definitions)
    defn = definitions_by_key.get(key)
    if not defn:
        _log_flows.warning("Cannot set variable '%s': not defined", key)
        return
    if defn.get("source") == "physical_input":
        _log_flows.warning("Cannot set variable '%s': bound to physical I/O", key)
        return
    coerced = _coerce_runtime_value(value, defn.get("type", "string"))
    with _runtime_lock:
        payload = _load_runtime_state()
        public_state = payload.setdefault("public_variables", {})
        saved = public_state.get("values")
        if not isinstance(saved, dict):
            saved = {}
        saved[key] = coerced
        public_state["values"] = saved
        public_state["updated_at"] = _utc_now_iso()
        _save_runtime_state(payload)



def _trigger_matches_node(node: Dict[str, Any], trigger: Dict[str, Any]) -> bool:
    node_type = node.get("type")
    cfg = node.get("config") or {}
    kind = trigger.get("kind")

    if node_type == "trigger.manual":
        return kind == "manual"

    if node_type == "trigger.schedule_active":
        return (
            kind == "schedule_active_changed"
            and bool(trigger.get("active")) is True
            and str(cfg.get("schedule_key") or "") == str(trigger.get("schedule_key") or "")
        )

    if node_type == "trigger.schedule_inactive":
        return (
            kind == "schedule_active_changed"
            and bool(trigger.get("active")) is False
            and str(cfg.get("schedule_key") or "") == str(trigger.get("schedule_key") or "")
        )

    if node_type == "trigger.onvif_event":
        if kind != "onvif_event":
            return False
        if str(cfg.get("device_id") or "") != str(trigger.get("device_id") or ""):
            return False
        wanted = _normalize_topic(cfg.get("topic"))
        got = _normalize_topic(
            trigger.get("topic")
            or ((trigger.get("extra") or {}).get("matched_by"))
            or ((trigger.get("extra") or {}).get("topic_path"))
            or ((trigger.get("extra") or {}).get("guessed_topic"))
        )
        if not (wanted and got and (got == wanted or got.startswith(wanted + "/") or wanted.startswith(got + "/"))):
            return False

        transition = _normalize_onvif_transition(cfg.get("transition"))
        if transition == "any":
            return True

        if _normalize_onvif_transition(trigger.get("state_transition")) == transition:
            return True

        state_changes = trigger.get("state_changes") or ((trigger.get("extra") or {}).get("state_changes")) or []
        if isinstance(state_changes, list):
            return any(
                isinstance(item, dict)
                and _normalize_onvif_transition(item.get("transition")) == transition
                for item in state_changes
            )
        return False

    if node_type == "trigger.device_offline":
        return kind == "device_offline" and str(cfg.get("device_id") or "") == str(trigger.get("device_id") or "")

    if node_type == "trigger.device_back_online":
        return kind == "device_back_online" and str(cfg.get("device_id") or "") == str(trigger.get("device_id") or "")

    if node_type == "trigger.ptz_manual_control_started":
        return kind == "ptz_manual_control_started" and str(cfg.get("device_id") or "") == str(trigger.get("device_id") or "")

    if node_type == "trigger.ptz_manual_control_stopped":
        return kind == "ptz_manual_control_stopped" and str(cfg.get("device_id") or "") == str(trigger.get("device_id") or "")

    if node_type == "trigger.incoming_http_request":
        if kind != "incoming_http_request":
            return False
        path_ok = _normalize_http_path(cfg.get("path")) == _normalize_http_path(trigger.get("path"))
        wanted_method = _normalize_http_method(cfg.get("method"), allow_any=True) or "ANY"
        got_method = _normalize_http_method(trigger.get("method"), allow_any=False)
        method_ok = wanted_method == "ANY" or wanted_method == got_method
        return path_ok and method_ok

    if node_type == "trigger.digital_input_changed":
        if kind != "digital_input_changed":
            return False
        if str(cfg.get("channel") or "") != str(trigger.get("channel") or ""):
            return False
        changed_to = str(cfg.get("changed_to") or "any").strip().lower()
        if changed_to != "any":
            cur = trigger.get("value")
            expected_cur = changed_to == "high"
            if cur != expected_cur:
                return False
        return True

    if node_type in {"trigger.analog_input_above", "trigger.analog_input_below"}:
        if kind != "analog_input_changed":
            return False
        if str(cfg.get("channel") or "") != str(trigger.get("channel") or ""):
            return False

        try:
            threshold = float(cfg.get("threshold") or 0)
            previous_value = float(trigger.get("previous_value"))
            current_value = float(trigger.get("value"))
        except Exception:
            return False

        if node_type == "trigger.analog_input_above":
            return previous_value <= threshold < current_value

        return previous_value >= threshold > current_value

    if node_type == "trigger.physical_output_changed":
        if kind != "physical_output_changed":
            return False
        return (
            _normalize_physical_switch_kind(cfg.get("target_kind"))
            == _normalize_physical_switch_kind(trigger.get("target_kind"))
            and str(cfg.get("channel") or "") == str(trigger.get("channel") or "")
        )

    return False



def dispatch_flow_trigger(trigger: Dict[str, Any]) -> int:
    matched = 0
    for flow in _load_flows():
        if not flow.get("enabled", True):
            continue
        flow_matched = False
        for node in flow.get("nodes", []):
            if node.get("category") != "trigger":
                continue
            if _trigger_matches_node(node, trigger):
                _run_flow_from_trigger(flow, trigger, start_node_id=node["id"], manual=(trigger.get("kind") == "manual"))
                matched += 1
                flow_matched = True
                break
        if flow_matched:
            continue
    if matched:
        _log_flows.info("Flow trigger dispatched: kind=%s, matched %d flow(s)", trigger.get("kind"), matched)
    return matched


def _scan_schedule_state_changes(emit_transitions: bool) -> None:
    schedules = _load_schedule_definitions()
    now = datetime.now()
    next_state: Dict[str, bool] = {}

    with _schedule_monitor_lock:
        previous_state = dict(_schedule_monitor_state)

    for schedule in schedules:
        key = str(schedule.get("key") or "").strip()
        if not key:
            continue

        active = _is_schedule_active_at(schedule, now)
        next_state[key] = active

        if not emit_transitions:
            continue

        previous = previous_state.get(key)
        if previous is None or previous == active:
            continue

        _log_schedule.info("Schedule '%s' became %s", str(schedule.get("name") or key).strip() or key, "active" if active else "inactive")
        dispatch_flow_trigger(
            {
                "kind": "schedule_active_changed",
                "schedule_key": key,
                "schedule_name": str(schedule.get("name") or key).strip() or key,
                "active": active,
                "previous_active": previous,
                "message": "Schedule became active" if active else "Schedule became inactive",
                "weekday": _WEEKDAY_KEYS[now.weekday()],
                "local_time": f"{now.hour:02d}:{now.minute:02d}",
                "ts": _utc_now_iso(),
            }
        )

    with _schedule_monitor_lock:
        _schedule_monitor_state.clear()
        _schedule_monitor_state.update(next_state)


def _poll_schedule_state_changes() -> None:
    _scan_schedule_state_changes(emit_transitions=False)
    while not _schedule_monitor_stop.wait(_SCHEDULE_POLL_SEC):
        try:
            _scan_schedule_state_changes(emit_transitions=True)
        except Exception as e:
            _log_schedule.error("Schedule poll error: %s", e)
            continue


def start_schedule_monitor() -> None:
    global _schedule_monitor_thread
    with _schedule_monitor_lock:
        if _schedule_monitor_thread is not None and _schedule_monitor_thread.is_alive():
            return
        _schedule_monitor_state.clear()
        _schedule_monitor_stop.clear()
        _schedule_monitor_thread = threading.Thread(
            target=_poll_schedule_state_changes,
            daemon=True,
            name="schedule-monitor",
        )
        _schedule_monitor_thread.start()


def stop_schedule_monitor() -> None:
    global _schedule_monitor_thread
    _schedule_monitor_stop.set()
    thread = _schedule_monitor_thread
    _schedule_monitor_thread = None
    if thread is not None and thread.is_alive():
        try:
            thread.join(timeout=1.0)
        except Exception:
            pass



def _manual_trigger_from_node(flow: Dict[str, Any], node: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    if node.get("type") != "trigger.manual":
        raise HTTPException(status_code=400, detail="Only manual trigger nodes can be run manually")

    cfg = node.get("config") or {}

    return {
        "kind": "manual",
        "manual_kind": "manual",
        "trigger_node_id": node["id"],
        "ts": _utc_now_iso(),
        "extra": dict(payload or {}),
        "device_id": cfg.get("device_id") or (payload or {}).get("device_id"),
        "method": (payload or {}).get("method"),
        "path": (payload or {}).get("path"),
        "topic": (payload or {}).get("topic"),
        "flow_id": flow["id"],
    }


def _run_flow_from_trigger(
    flow: Dict[str, Any],
    trigger: Dict[str, Any],
    start_node_id: Optional[str] = None,
    manual: bool = False,
    persist_runtime: bool = True,
    append_log: bool = True,
) -> Dict[str, Any]:
    nodes_by_id = {node["id"]: node for node in flow.get("nodes", [])}
    adjacency = _build_adjacency(flow)
    variables = _get_runtime_variables(flow)
    variable_definitions = _public_variable_definitions_by_key()
    node_results: List[Dict[str, Any]] = []

    if start_node_id is None:
        trigger_node = next((node for node in flow.get("nodes", []) if node.get("category") == "trigger" and _trigger_matches_node(node, trigger)), None)
        if not trigger_node:
            return {"flow_id": flow["id"], "matched": False, "steps": [], "variables": variables}
        start_node_id = trigger_node["id"]

    queue: List[Tuple[str, str]] = [(start_node_id, "out")]
    steps = 0

    context: Dict[str, Any] = {
        "flow": flow,
        "trigger": trigger,
        "variables": variables,
        "variable_definitions": variable_definitions,
        "changed_variables": set(),
        "results": node_results,
        "manual": manual,
        "started_at": _utc_now_iso(),
    }

    _log_flows.info("Running flow '%s' (%s) from trigger %s", flow.get("name"), flow.get("id"), trigger.get("kind"))

    while queue and steps < _MAX_RUN_STEPS:
        node_id, incoming_handle = queue.pop(0)
        node = nodes_by_id.get(node_id)
        if node is None:
            continue
        result = _execute_node(node, incoming_handle, context)
        node_results.append(result)
        steps += 1
        for next_handle in result.get("next_handles") or []:
            for edge in adjacency.get(node_id, {}).get(next_handle, []):
                queue.append((edge["target"], edge.get("target_handle") or "in"))

    changed_variables = context.get("changed_variables") or set()
    if persist_runtime and changed_variables:
        _save_runtime_variables(flow, variables, changed_keys=changed_variables)

    summary = {
        "flow_id": flow["id"],
        "flow_name": flow["name"],
        "matched": True,
        "manual": manual,
        "steps": node_results,
        "variables": variables,
        "truncated": steps >= _MAX_RUN_STEPS,
        "finished_at": _utc_now_iso(),
    }

    if steps >= _MAX_RUN_STEPS:
        _log_flows.warning("Flow '%s' truncated after %d steps", flow.get("name"), steps)

    if append_log:
        _append_flow_log(flow, trigger, summary)

    return summary



def _execute_node(node: Dict[str, Any], incoming_handle: str, context: Dict[str, Any]) -> Dict[str, Any]:
    node_type = node.get("type")
    cfg = node.get("config") or {}
    result: Dict[str, Any] = {
        "node_id": node["id"],
        "node_type": node_type,
        "label": node.get("label"),
        "ok": True,
        "incoming_handle": incoming_handle,
        "next_handles": [],
    }

    if node.get("category") == "trigger":
        result["message"] = "Trigger matched"
        result["next_handles"] = ["out"]
        return result

    if node_type == "condition.compare":
        left_source = _normalize_source_type(cfg.get("left_source"), allow_trigger=True, allow_physical_input=True)
        right_source = _normalize_source_type(cfg.get("right_source"), allow_trigger=True, allow_physical_input=True)

        if left_source == "physical_input":
            left_input_kind = _normalize_physical_value_kind(cfg.get("left_input_kind"))
            left_channel = _normalize_physical_channel(cfg.get("left_channel"), left_input_kind)
            left = read_physical_value(left_input_kind, int(left_channel)).get("value")
            result["left_input_kind"] = left_input_kind
            result["left_channel"] = left_channel
        else:
            left = _resolve_value(left_source, cfg.get("left_value"), context)

        if right_source == "physical_input":
            right_input_kind = _normalize_physical_value_kind(cfg.get("right_input_kind"))
            right_channel = _normalize_physical_channel(cfg.get("right_channel"), right_input_kind)
            right = read_physical_value(right_input_kind, int(right_channel)).get("value")
            result["right_input_kind"] = right_input_kind
            result["right_channel"] = right_channel
        else:
            right = _resolve_value(right_source, cfg.get("right_value"), context)

        passed = _evaluate_compare(left, cfg.get("operator"), right, cfg.get("cast") or "auto")
        result["left"] = left
        result["right"] = right
        result["passed"] = passed
        result["next_handles"] = ["true" if passed else "false"]
        return result

    if node_type == "condition.schedule_active":
        schedule_key = str(cfg.get("schedule_key") or "").strip()
        schedule = _schedule_by_key(schedule_key)
        active = _is_schedule_active_at(schedule) if schedule else False
        result["schedule_key"] = schedule_key
        result["passed"] = active
        result["next_handles"] = ["true" if active else "false"]
        return result

    if node_type == "operator.delay":
        seconds = float(cfg.get("seconds") or 0)
        if seconds > 0:
            time.sleep(seconds)
        result["seconds"] = seconds
        result["message"] = f"Waited {seconds:.3f}s"
        result["next_handles"] = ["out"]
        return result

    if node_type == "operator.set_variable":
        key = str(cfg.get("variable_key") or "").strip()
        definition = (context.get("variable_definitions") or {}).get(key) or {}
        if definition.get("source") == "physical_input":
            result["ok"] = False
            result["error"] = f"Variable '{key}' is bound to physical I/O and cannot be written."
            result["variable_key"] = key
            result["next_handles"] = ["out"]
            return result
        value_source = _normalize_source_type(
            cfg.get("value_source"),
            allow_trigger=True,
            allow_physical_input=True,
        )
        if value_source == "physical_input":
            input_kind = _normalize_physical_value_kind(cfg.get("value_input_kind"))
            channel = _normalize_physical_channel(cfg.get("value_channel"), input_kind)
            try:
                reading = read_physical_value(input_kind, int(channel))
            except Exception as exc:
                result["ok"] = False
                result["error"] = str(exc)
                result["value_source"] = value_source
                result["value_input_kind"] = input_kind
                result["value_channel"] = channel
                result["next_handles"] = ["out"]
                return result
            resolved_value = reading.get("value")
            result["value_source"] = value_source
            result["value_input_kind"] = input_kind
            result["value_channel"] = channel
            result["input_label"] = reading.get("label")
            result["input_updated_at"] = reading.get("updated_at")
        else:
            if value_source == "literal":
                resolved_value = _auto_literal(_render_template(str(cfg.get("value") or ""), context))
            else:
                resolved_value = _resolve_value(value_source, cfg.get("value"), context)
            result["value_source"] = value_source
        value = _coerce_variable_assignment(
            key,
            resolved_value,
            context,
        )
        context["variables"][key] = value
        context.setdefault("changed_variables", set()).add(key)
        result["variable_key"] = key
        result["value"] = value
        result["next_handles"] = ["out"]
        return result

    if node_type == "operator.template":
        key = str(cfg.get("variable_key") or "").strip()
        value = _coerce_variable_assignment(
            key,
            _render_template(str(cfg.get("template") or ""), context),
            context,
        )
        context["variables"][key] = value
        context.setdefault("changed_variables", set()).add(key)
        result["variable_key"] = key
        result["value"] = value
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.send_http_request":
        method = _normalize_http_method(cfg.get("method"), allow_any=False)
        url = _render_template(str(cfg.get("url") or ""), context)
        headers = {
            key: _render_template(value, context)
            for key, value in _parse_headers_json(str(cfg.get("headers") or "{}")).items()
        }
        body = _render_template(str(cfg.get("body") or ""), context)
        payload = body.encode("utf-8") if body and method not in {"GET", "DELETE"} else None
        if payload and not any(key.lower() == "content-type" for key in headers):
            headers["Content-Type"] = "text/plain; charset=utf-8"
        req = urllib.request.Request(url, data=payload, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=float(cfg.get("timeout_seconds") or 10)) as resp:
                response_text = resp.read(2048).decode("utf-8", errors="replace")
                result["status_code"] = int(getattr(resp, "status", 200))
                result["response_preview"] = response_text
        except urllib.error.HTTPError as exc:
            result["ok"] = False
            result["status_code"] = int(exc.code)
            try:
                result["response_preview"] = exc.read(2048).decode("utf-8", errors="replace")
            except Exception:
                result["response_preview"] = ""
            result["error"] = f"HTTP {exc.code}"
            _log_flows.warning("HTTP request failed in flow: %s %s → HTTP %d", method, url, exc.code)
        except Exception as exc:
            result["ok"] = False
            result["error"] = str(exc)
            _log_flows.warning("HTTP request failed in flow: %s %s: %s", method, url, exc)
        result["request"] = {"method": method, "url": url, "headers": headers, "body": body}
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.activate_physical_output":
        physical_kind = str(cfg.get("target_kind") or "output").strip().lower()
        if physical_kind not in {"output", "relay"}:
            physical_kind = "output"
        channel = _normalize_physical_channel(cfg.get("channel"), physical_kind)
        mode = str(cfg.get("mode") or "pulse").strip().lower()
        pulse_seconds = float(cfg.get("pulse_seconds") or 2)
        try:
            switch_result = (
                activate_physical_output(int(channel), mode, pulse_seconds)
                if physical_kind == "output"
                else activate_physical_relay(int(channel), mode, pulse_seconds)
            )
            result["channel"] = channel
            result["mode"] = mode
            result["pulse_seconds"] = pulse_seconds
            result["target_kind"] = physical_kind
            result[physical_kind] = switch_result
            result["message"] = switch_result.get("message")
        except Exception as exc:
            result["ok"] = False
            result["error"] = str(exc)
            _log_flows.warning("Physical output action failed in flow: %s", exc)
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.log_message":
        result["message"] = _render_template(str(cfg.get("message") or ""), context)
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.contribute":
        from main import _grab_snapshot, _load_devices, _get_scenario
        target_id = str(cfg.get("target_id") or "").strip()
        if not target_id:
            result["ok"] = False
            result["error"] = "No scenario selected"
            result["next_handles"] = ["out"]
            return result

        buf = _get_contribution_buffer(target_id)

        # Track first contribution time
        if buf["count"] == 0:
            buf["first_ts"] = time.time()

        # Collect and append snapshots
        entries = cfg.get("snapshot_entries") or []
        devices = _load_devices()
        device_map = {d.id: d.name for d in devices}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            did = str(entry.get("device_id") or "").strip()
            if not did:
                continue
            data_uri = _grab_snapshot(did)
            if data_uri:
                buf["images"].append(data_uri)
                buf["snapshots"].append({
                    "device_id": did,
                    "device_name": device_map.get(did, did),
                    "snapshot": data_uri,
                })

        buf["count"] += 1

        result["target_id"] = target_id
        result["contribution_count"] = buf["count"]
        result["message"] = f"Contributed to scenario (#{buf['count']})"

        # Check auto-fire conditions
        scenario = _get_scenario(target_id)
        max_contributions = int((scenario or {}).get("max_contributions") or 0)
        max_seconds = float((scenario or {}).get("max_seconds") or 0)

        if max_contributions > 0 and buf["count"] >= max_contributions:
            _auto_fire_target("scenario", target_id)
            result["message"] += " — auto-fired (max contributions reached)"
        elif max_seconds > 0 and buf["count"] == 1:
            _schedule_contribution_timer(target_id, max_seconds, "scenario", target_id)
            result["message"] += f" — timer started ({max_seconds}s)"

        result["next_handles"] = ["out"]
        return result

    if node_type == "action.fire":
        from main import (
            _get_scenario, create_event,
            _analyze_with_gpt_structured, _render_template_simple,
        )
        target_id = str(cfg.get("target_id") or "").strip()
        if not target_id:
            result["ok"] = False
            result["error"] = "No scenario selected"
            result["next_handles"] = ["out"]
            return result

        buf = _consume_contribution_buffer(target_id)
        contrib_context = {"contributions": buf}

        scenario = _get_scenario(target_id)
        if not scenario:
            result["ok"] = False
            result["error"] = "Scenario not found"
            result["next_handles"] = ["out"]
            return result

        image_uris = list(buf.get("images") or [])
        if not image_uris:
            _log_flows.info("Analyse skipped for scenario '%s': no snapshots in buffer", scenario.get("name", target_id))
            result["ok"] = True
            result["message"] = "Skipped: no snapshots in buffer"
            result["next_handles"] = ["out"]
            return result

        rendered_prompt = _render_template(
            _render_template_simple(scenario.get("prompt", ""), contrib_context),
            context,
        )
        if buf.get("texts"):
            extra = "\n\n".join(buf["texts"])
            rendered_prompt = f"{rendered_prompt}\n\nAdditional context:\n{extra}" if rendered_prompt else extra
        response_type = scenario.get("response_type", "text")
        choices = scenario.get("choices") or []
        gpt_result = _analyze_with_gpt_structured(
            rendered_prompt, image_uris, response_type, choices,
        )
        # Write result to variable if configured
        result_variable = scenario.get("result_variable", "").strip()
        if result_variable and gpt_result.get("result") is not None:
            _set_public_variable_value(result_variable, gpt_result["result"])
            context["variables"][result_variable] = gpt_result["result"]
            context.setdefault("changed_variables", set()).add(result_variable)
        result["message"] = f"Scenario analysed: {scenario.get('name', '')}"
        result["scenario_result"] = gpt_result.get("result")
        result["scenario_reasoning"] = gpt_result.get("reasoning", "")
        result["scenario_error"] = gpt_result.get("error", "")

        # Auto-event: submit result as event if configured
        if scenario.get("auto_event_enabled") and gpt_result.get("result") is not None:
            ae_priority = scenario.get("auto_event_priority", "medium").strip() or "medium"
            ae_on = scenario.get("auto_event_on_result", "true").strip()
            should_submit = False
            if ae_on == "any":
                should_submit = True
            elif ae_on == "true" and gpt_result["result"] is True:
                should_submit = True
            elif ae_on == "false" and gpt_result["result"] is False:
                should_submit = True
            elif ae_on == gpt_result.get("result"):
                should_submit = True  # choice match

            if should_submit:
                ae_reasoning = gpt_result.get("reasoning", "")
                ae_snapshots = list(buf.get("snapshots") or [])
                create_event(
                    name=scenario.get("name", "Event"),
                    priority=ae_priority,
                    details=ae_reasoning or "",
                    snapshots=ae_snapshots,
                    flow_id=str((context.get("flow") or {}).get("id") or "").strip() or None,
                    flow_name=str((context.get("flow") or {}).get("name") or "").strip() or None,
                    node_id=str(node.get("id") or "").strip() or None,
                )
                result["auto_event_submitted"] = True

        # Determine output handle based on response type and result
        gpt_value = gpt_result.get("result")
        if response_type == "boolean" and isinstance(gpt_value, bool):
            result["next_handles"] = ["true" if gpt_value else "false"]
        elif response_type == "choice" and isinstance(gpt_value, str) and gpt_value in choices:
            result["next_handles"] = [f"choice:{gpt_value}"]
        else:
            result["next_handles"] = ["out"]
        return result

    if node_type == "action.flush":
        target_id = str(cfg.get("target_id") or "").strip()
        if target_id:
            _flush_contribution_buffer(target_id)
            result["message"] = f"Flushed scenario buffer"
        else:
            result["ok"] = False
            result["error"] = "No scenario selected"
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.submit_event":
        from main import create_event, _grab_snapshot, _load_devices
        event_name = _render_template(str(cfg.get("event_name") or "Event"), context)
        priority = str(cfg.get("priority") or "medium").strip().lower()
        details = _render_template(str(cfg.get("details") or ""), context)

        snapshots = []
        entries = cfg.get("snapshot_entries") or []
        devices = _load_devices()
        device_map = {d.id: d.name for d in devices}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            did = str(entry.get("device_id") or "").strip()
            if not did:
                continue
            data_uri = _grab_snapshot(did)
            if data_uri:
                snapshots.append({
                    "device_id": did,
                    "device_name": device_map.get(did, did),
                    "snapshot": data_uri,
                })

        create_event(
            name=event_name,
            priority=priority,
            details=details,
            snapshots=snapshots,
            flow_id=str((context.get("flow") or {}).get("id") or "").strip() or None,
            flow_name=str((context.get("flow") or {}).get("name") or "").strip() or None,
            node_id=str(node.get("id") or "").strip() or None,
        )
        result["message"] = f"Event submitted: {event_name}"
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.record":
        preset = _find_recording_preset(cfg.get("preset_name") or cfg.get("name"))
        preset_name = str((preset or {}).get("name") or cfg.get("preset_name") or cfg.get("name") or "").strip() or "Recording"
        title = preset_name
        color = str((preset or {}).get("color") or _normalize_record_color(cfg.get("color")))
        preset_key = str((preset or {}).get("key") or cfg.get("preset_key") or _recording_preset_key(preset_name)).strip()
        try:
            event = create_recording_marker(
                device_id=str(cfg.get("device_id") or "").strip(),
                before_seconds=float(cfg.get("before_seconds") or 0),
                after_seconds=(
                    float(cfg.get("after_seconds"))
                    if cfg.get("after_seconds") not in {None, ""}
                    else None
                ),
                color=color,
                title=title,
                preset_key=preset_key,
                preset_name=preset_name,
                flow_id=str((context.get("flow") or {}).get("id") or "").strip() or None,
                flow_name=str((context.get("flow") or {}).get("name") or "").strip() or None,
                node_id=str(node.get("id") or "").strip() or None,
            )
            result["message"] = f"Started recording for {title}"
            result["event_id"] = event.get("id")
            result["device_id"] = event.get("device_id")
            result["clip_start"] = event.get("clip_start")
            result["clip_end"] = event.get("clip_end")
            result["color"] = event.get("color")
            result["preset_key"] = event.get("preset_key")
        except Exception as exc:
            result["ok"] = False
            result["error"] = str(exc)
            _log_flows.warning("Record action failed in flow: %s", exc)
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.stop_recording":
        try:
            event = stop_recording_marker(device_id=str(cfg.get("device_id") or "").strip())
            result["message"] = f"Stopped recording for {event.get('title') or 'Recording'}"
            result["event_id"] = event.get("id")
            result["device_id"] = event.get("device_id")
            result["clip_start"] = event.get("clip_start")
            result["clip_end"] = event.get("clip_end")
        except Exception as exc:
            result["ok"] = False
            result["error"] = str(exc)
            _log_flows.warning("Stop recording action failed in flow: %s", exc)
        result["next_handles"] = ["out"]
        return result

    result["ok"] = False
    result["error"] = "Unsupported node"
    return result



def _resolve_value(source: Any, value: Any, context: Dict[str, Any]) -> Any:
    source_type = _normalize_source_type(source, allow_trigger=True)
    raw = str(value or "")
    if source_type == "literal":
        return _auto_literal(raw)
    if source_type == "variable":
        return context.get("variables", {}).get(raw)
    if source_type == "trigger":
        return _get_by_path(context.get("trigger") or {}, raw)
    return raw



def _coerce_variable_assignment(variable_key: str, value: Any, context: Dict[str, Any]) -> Any:
    definitions = context.get("variable_definitions") or {}
    definition = definitions.get(variable_key) if isinstance(definitions, dict) else None
    if not isinstance(definition, dict):
        return value
    return _coerce_runtime_value(value, str(definition.get("type") or "string"))



def _auto_literal(value: str) -> Any:
    raw = value.strip()
    if raw == "":
        return ""
    lower = raw.lower()
    if lower in {"true", "false"}:
        return lower == "true"
    try:
        if "." in raw:
            return float(raw)
        return int(raw)
    except Exception:
        return raw



def _get_by_path(data: Any, path: str) -> Any:
    cur = data
    for part in [segment for segment in str(path or "").split(".") if segment]:
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except Exception:
                return None
        else:
            return None
    return cur



def _coerce_pair(left: Any, right: Any, cast: str) -> Tuple[Any, Any]:
    mode = str(cast or "auto").strip().lower()
    if mode == "string":
        return "" if left is None else str(left), "" if right is None else str(right)
    if mode == "number":
        try:
            return float(left), float(right)
        except Exception:
            return left, right
    if mode == "boolean":
        return _to_bool(left), _to_bool(right)

    # auto
    try:
        return float(left), float(right)
    except Exception:
        pass
    if isinstance(left, bool) or isinstance(right, bool):
        return _to_bool(left), _to_bool(right)
    return "" if left is None else str(left), "" if right is None else str(right)



def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}



def _evaluate_compare(left: Any, operator: Any, right: Any, cast: str) -> bool:
    op = str(operator or "equals").strip()
    if op == "is_true":
        return _to_bool(left) is True
    if op == "is_false":
        return _to_bool(left) is False

    left_val, right_val = _coerce_pair(left, right, cast)
    if op == "equals":
        return left_val == right_val
    if op == "not_equals":
        return left_val != right_val
    if op == "contains":
        return str(right_val) in str(left_val)
    if op == "not_contains":
        return str(right_val) not in str(left_val)
    if op == "greater_than":
        return left_val > right_val
    if op == "greater_than_or_equal":
        return left_val >= right_val
    if op == "less_than":
        return left_val < right_val
    if op == "less_than_or_equal":
        return left_val <= right_val
    return False



def _render_template(template: str, context: Dict[str, Any]) -> str:
    out = str(template or "")
    replacements = []
    for scope_name, scope_value in {
        "flow": context.get("flow") or {},
        "trigger": context.get("trigger") or {},
        "variables": context.get("variables") or {},
        "last": (context.get("results") or [{}])[-1] if context.get("results") else {},
    }.items():
        for key, value in _flatten(scope_value).items():
            replacements.append((f"{{{{{scope_name}.{key}}}}}", "" if value is None else str(value)))
    for needle, value in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        out = out.replace(needle, value)
    return out



def _flatten(value: Any, prefix: str = "") -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if isinstance(value, dict):
        for key, child in value.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            out.update(_flatten(child, child_prefix))
        return out
    if isinstance(value, list):
        for idx, child in enumerate(value):
            child_prefix = f"{prefix}.{idx}" if prefix else str(idx)
            out.update(_flatten(child, child_prefix))
        return out
    out[prefix] = value
    return out



def _append_flow_log(flow: Dict[str, Any], trigger: Dict[str, Any], summary: Dict[str, Any]) -> None:
    line = json.dumps(
        {
            "ts": _utc_now_iso(),
            "flow_id": flow.get("id"),
            "flow_name": flow.get("name"),
            "trigger": trigger,
            "summary": summary,
        },
        ensure_ascii=False,
    )
    with _storage_lock:
        with FLOW_LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
