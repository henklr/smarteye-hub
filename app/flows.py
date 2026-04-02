from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from physical_io import (
    activate_physical_output,
    activate_physical_relay,
    physical_channels,
    physical_io_catalog,
    physical_io_state,
    read_physical_input,
    read_physical_value,
)


DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DEVICES_JSON = DATA_DIR / "devices.json"
FLOWS_JSON = DATA_DIR / "flows.json"
PUBLIC_VARIABLES_JSON = DATA_DIR / "public_variables.json"
FLOW_STATE_JSON = DATA_DIR / "flow_state.json"
FLOW_LOG_FILE = Path(os.getenv("FLOW_LOG_FILE", str(DATA_DIR / "flows.log")))
FLOW_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

STATIC_DIR = Path(__file__).resolve().parent / "static"

_VALID_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}
_MAX_RUN_STEPS = 200

_storage_lock = threading.RLock()
_runtime_lock = threading.RLock()

router = APIRouter(tags=["flows"])


class FlowVariableModel(BaseModel):
    key: str = Field(..., min_length=1)
    type: str = "string"
    value: Any = ""


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
    

NODE_LIBRARY: List[Dict[str, Any]] = [
    {
        "type": "trigger.onvif_event",
        "category": "trigger",
        "label": "ONVIF event",
        "description": "Starts the flow when a selected ONVIF topic is emitted.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"device_id": "", "topic": "", "name": ""},
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
        "type": "trigger.digital_input_changed",
        "category": "trigger",
        "label": "Digital input changed",
        "description": "Starts when a selected Automation HAT Mini digital input changes.",
        "color": "#4f8cff",
        "ports": {"inputs": [], "outputs": ["out"]},
        "defaults": {"channel": "1", "name": ""},
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
        "type": "operator.delay",
        "category": "operator",
        "label": "Delay",
        "description": "Waits for the configured number of seconds.",
        "color": "#17b978",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"seconds": 2, "name": ""},
    },
    {
        "type": "operator.set_variable",
        "category": "action",
        "label": "Set variable",
        "description": "Updates a shared variable for later conditions or actions.",
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
        "type": "operator.template",
        "category": "operator",
        "label": "Template",
        "description": "Builds a text value and stores it on a variable.",
        "color": "#17b978",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {
            "variable_key": "message",
            "template": "Triggered by {{trigger.kind}}",
            "name": "",
        },
    },
    {
        "type": "operator.physical_input",
        "category": "operator",
        "label": "Physical input",
        "description": "Reads the current value from a selected Automation HAT Mini digital or analog input.",
        "color": "#17b978",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"input_kind": "digital", "channel": "1", "name": ""},
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
        "type": "action.log_message",
        "category": "action",
        "label": "Log message",
        "description": "Writes a formatted message to the flow log.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"message": "Flow {{flow.name}} ran.", "name": ""},
    },
]

NODE_LIBRARY_BY_TYPE = {item["type"]: item for item in NODE_LIBRARY}


@router.get("/flows", response_class=HTMLResponse)
def flows_page() -> HTMLResponse:
    return HTMLResponse((STATIC_DIR / "flows.html").read_text(encoding="utf-8"))


@router.get("/api/flows/catalog")
def flows_catalog() -> Dict[str, Any]:
    return {
        "nodes": NODE_LIBRARY,
        "devices": _load_devices(),
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

    _reconcile_public_variable_runtime_values(items)
    return {"ok": True, **_public_variables_response()}


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
        _delete_runtime_state_for_flow(flow_id)
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
    public_variables = _merge_public_variable_definitions(legacy_variables) if legacy_variables else _load_public_variable_definitions()
    public_variable_keys = {item["key"] for item in public_variables}

    nodes: List[Dict[str, Any]] = []
    node_ids: set[str] = set()
    for raw in list(data.get("nodes") or []):
        if not isinstance(raw, dict):
            continue
        node = _normalize_node_payload(raw, public_variable_keys)
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



def _normalize_node_payload(raw: Dict[str, Any], variable_keys: set[str]) -> Dict[str, Any]:
    source_node_type = str(raw.get("type") or "").strip()
    node_type = source_node_type
    node_id = str(raw.get("id") or "").strip() or uuid.uuid4().hex[:10]
    raw_label = str(raw.get("label") or "").strip()
    raw_config = deepcopy(raw.get("config") or {})

    if node_type in {"action.activate_output_relay", "action.activate_physical_relay"}:
        node_type = "action.activate_physical_output"
        raw_config.setdefault("target_kind", "relay")
        if raw_label in {"Activate output relay", "Activate physical relay"}:
            raw_label = ""
        if "pulse_seconds" not in raw_config and "activation_seconds" in raw_config:
            raw_config["pulse_seconds"] = raw_config.get("activation_seconds")

    if node_type not in NODE_LIBRARY_BY_TYPE:
        raise HTTPException(status_code=400, detail=f"Unsupported node type: {node_type}")

    definition = NODE_LIBRARY_BY_TYPE[node_type]
    category = definition["category"]
    label = raw_label or definition["label"]
    config = deepcopy(definition.get("defaults") or {})
    config.update(raw_config)
    config = _normalize_node_config(node_type, config, variable_keys)

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



def _normalize_node_config(node_type: str, config: Dict[str, Any], variable_keys: set[str]) -> Dict[str, Any]:
    cfg = dict(config)

    if node_type == "trigger.onvif_event":
        cfg["device_id"] = str(cfg.get("device_id") or "").strip()
        cfg["topic"] = _normalize_topic(cfg.get("topic"))
        if not cfg["device_id"]:
            raise HTTPException(status_code=400, detail="ONVIF trigger needs a device")
        if not cfg["topic"]:
            raise HTTPException(status_code=400, detail="ONVIF trigger needs a topic")
        return cfg

    if node_type in {"trigger.device_offline", "trigger.device_back_online"}:
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

    if node_type == "trigger.digital_input_changed":
        cfg["channel"] = _normalize_physical_channel(cfg.get("channel"), "digital")
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
        cfg["left_source"] = _normalize_source_type(cfg.get("left_source"), allow_trigger=True)
        cfg["right_source"] = _normalize_source_type(cfg.get("right_source"), allow_trigger=True)
        cfg["operator"] = str(cfg.get("operator") or "equals").strip()
        cfg["cast"] = str(cfg.get("cast") or "auto").strip()
        cfg["left_value"] = str(cfg.get("left_value") or "").strip()
        cfg["right_value"] = str(cfg.get("right_value") or "").strip()
        if cfg["left_source"] == "variable" and cfg["left_value"] and cfg["left_value"] not in variable_keys:
            raise HTTPException(status_code=400, detail=f"Unknown variable key: {cfg['left_value']}")
        if cfg["right_source"] == "variable" and cfg["right_value"] and cfg["right_value"] not in variable_keys:
            raise HTTPException(status_code=400, detail=f"Unknown variable key: {cfg['right_value']}")
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
        if cfg["variable_key"] not in variable_keys:
            raise HTTPException(status_code=400, detail=f"Unknown variable key: {cfg['variable_key']}")
        if cfg["value_source"] == "variable" and cfg["value"] and cfg["value"] not in variable_keys:
            raise HTTPException(status_code=400, detail=f"Unknown variable key: {cfg['value']}")
        if cfg["value_source"] == "physical_input":
            cfg["value_channel"] = _normalize_physical_channel(cfg.get("value_channel"), cfg["value_input_kind"])
        return cfg

    if node_type == "operator.template":
        cfg["variable_key"] = str(cfg.get("variable_key") or "").strip()
        cfg["template"] = str(cfg.get("template") or "")
        if not cfg["variable_key"]:
            raise HTTPException(status_code=400, detail="Template node needs a variable key")
        if cfg["variable_key"] not in variable_keys:
            raise HTTPException(status_code=400, detail=f"Unknown variable key: {cfg['variable_key']}")
        return cfg

    if node_type == "operator.physical_input":
        cfg["input_kind"] = _normalize_physical_input_kind(cfg.get("input_kind"))
        cfg["channel"] = _normalize_physical_channel(cfg.get("channel"), cfg["input_kind"])
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

    if node_type == "action.log_message":
        cfg["message"] = str(cfg.get("message") or "")
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
    return "" if value is None else str(value)


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
        variable_type = str(raw.get("type") or "string").strip().lower()
        if variable_type not in {"string", "number", "boolean", "json"}:
            variable_type = "string"

        variables.append(
            {
                "key": key,
                "type": variable_type,
                "value": _coerce_runtime_value(raw.get("value"), variable_type),
            }
        )

    return variables



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
    if isinstance(saved, dict):
        for key, value in saved.items():
            definition = definitions_by_key.get(key)
            if definition is None:
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



def _reconcile_public_variable_runtime_values(items: Optional[List[Dict[str, Any]]] = None) -> None:
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
            merged[key] = _coerce_runtime_value(saved.get(key, item.get("value")), item["type"])

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



def _describe_public_variable_usages(variable_keys: set[str]) -> List[str]:
    if not variable_keys:
        return []

    usages: List[str] = []
    for flow in _load_flows():
        hits = sorted(_flow_variable_references(flow) & variable_keys)
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
            saved[key] = _coerce_runtime_value(variables.get(key), definitions_by_key[key]["type"])

        public_state["values"] = {key: saved[key] for key in definitions_by_key if key in saved}
        public_state["updated_at"] = _utc_now_iso()
        _save_runtime_state(payload)



def _trigger_matches_node(node: Dict[str, Any], trigger: Dict[str, Any]) -> bool:
    node_type = node.get("type")
    cfg = node.get("config") or {}
    kind = trigger.get("kind")

    if node_type == "trigger.manual":
        return kind == "manual"

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
        return bool(wanted and got and (got == wanted or got.startswith(wanted + "/") or wanted.startswith(got + "/")))

    if node_type == "trigger.device_offline":
        return kind == "device_offline" and str(cfg.get("device_id") or "") == str(trigger.get("device_id") or "")

    if node_type == "trigger.device_back_online":
        return kind == "device_back_online" and str(cfg.get("device_id") or "") == str(trigger.get("device_id") or "")

    if node_type == "trigger.incoming_http_request":
        if kind != "incoming_http_request":
            return False
        path_ok = _normalize_http_path(cfg.get("path")) == _normalize_http_path(trigger.get("path"))
        wanted_method = _normalize_http_method(cfg.get("method"), allow_any=True) or "ANY"
        got_method = _normalize_http_method(trigger.get("method"), allow_any=False)
        method_ok = wanted_method == "ANY" or wanted_method == got_method
        return path_ok and method_ok

    if node_type == "trigger.digital_input_changed":
        return kind == "digital_input_changed" and str(cfg.get("channel") or "") == str(trigger.get("channel") or "")

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
    return matched



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
        left = _resolve_value(cfg.get("left_source"), cfg.get("left_value"), context)
        right = _resolve_value(cfg.get("right_source"), cfg.get("right_value"), context)
        passed = _evaluate_compare(left, cfg.get("operator"), right, cfg.get("cast") or "auto")
        result["left"] = left
        result["right"] = right
        result["passed"] = passed
        result["next_handles"] = ["true" if passed else "false"]
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

    if node_type == "operator.physical_input":
        input_kind = _normalize_physical_input_kind(cfg.get("input_kind"))
        channel = _normalize_physical_channel(cfg.get("channel"), input_kind)
        try:
            reading = read_physical_input(input_kind, int(channel))
            result["input_kind"] = input_kind
            result["channel"] = channel
            result["input_label"] = reading.get("label")
            result["value"] = reading.get("value")
            result["updated_at"] = reading.get("updated_at")
            result["message"] = f"{reading.get('label') or f'{input_kind} {channel}'} = {_format_physical_value(input_kind, reading.get('value'))}"
        except Exception as exc:
            result["ok"] = False
            result["error"] = str(exc)
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
        except Exception as exc:
            result["ok"] = False
            result["error"] = str(exc)
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
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.log_message":
        result["message"] = _render_template(str(cfg.get("message") or ""), context)
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
