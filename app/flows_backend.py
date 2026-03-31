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


DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DEVICES_JSON = DATA_DIR / "devices.json"
FLOWS_JSON = DATA_DIR / "flows.json"
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
    label: Optional[str] = None
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
        "category": "operator",
        "label": "Set variable",
        "description": "Updates a flow variable for later conditions or actions.",
        "color": "#17b978",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {
            "variable_key": "",
            "value_source": "literal",
            "value": "",
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
        "type": "action.activate_output_relay",
        "category": "action",
        "label": "Activate output relay",
        "description": "Placeholder relay action compatible with your existing backend.",
        "color": "#ff8c42",
        "ports": {"inputs": ["in"], "outputs": ["out"]},
        "defaults": {"mode": "pulse", "activation_seconds": 2, "name": ""},
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



def _load_runtime_state() -> Dict[str, Any]:
    payload = _load_json(FLOW_STATE_JSON, {"flows": {}})
    if not isinstance(payload, dict):
        return {"flows": {}}
    flows = payload.get("flows")
    if not isinstance(flows, dict):
        flows = {}
    return {"flows": flows}



def _save_runtime_state(payload: Dict[str, Any]) -> None:
    _atomic_save_json(FLOW_STATE_JSON, payload)



def _delete_runtime_state_for_flow(flow_id: str) -> None:
    with _runtime_lock:
        payload = _load_runtime_state()
        payload.setdefault("flows", {}).pop(flow_id, None)
        _save_runtime_state(payload)



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

    variables: List[Dict[str, Any]] = []
    seen_variable_keys: set[str] = set()
    for raw in list(data.get("variables") or []):
        if not isinstance(raw, dict):
            continue
        key = str(raw.get("key") or "").strip()
        if not key:
            continue
        if key in seen_variable_keys:
            raise HTTPException(status_code=400, detail=f"Duplicate variable key: {key}")
        seen_variable_keys.add(key)
        vtype = str(raw.get("type") or "string").strip().lower()
        if vtype not in {"string", "number", "boolean", "json"}:
            vtype = "string"
        variables.append(
            {
                "key": key,
                "label": str(raw.get("label") or key).strip() or key,
                "type": vtype,
                "value": _coerce_runtime_value(raw.get("value"), vtype),
            }
        )

    nodes: List[Dict[str, Any]] = []
    node_ids: set[str] = set()
    for raw in list(data.get("nodes") or []):
        if not isinstance(raw, dict):
            continue
        node = _normalize_node_payload(raw, seen_variable_keys)
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
        "variables": variables,
        "nodes": nodes,
        "edges": edges,
        "created_at": created_at or _utc_now_iso(),
        "updated_at": _utc_now_iso(),
    }



def _normalize_node_payload(raw: Dict[str, Any], variable_keys: set[str]) -> Dict[str, Any]:
    node_type = str(raw.get("type") or "").strip()
    node_id = str(raw.get("id") or "").strip() or uuid.uuid4().hex[:10]
    if node_type not in NODE_LIBRARY_BY_TYPE:
        raise HTTPException(status_code=400, detail=f"Unsupported node type: {node_type}")

    definition = NODE_LIBRARY_BY_TYPE[node_type]
    category = definition["category"]
    label = str(raw.get("label") or definition["label"]).strip() or definition["label"]
    config = deepcopy(definition.get("defaults") or {})
    config.update(raw.get("config") or {})
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

    if node_type == "condition.compare":
        cfg["left_source"] = _normalize_source_type(cfg.get("left_source"), allow_trigger=True)
        cfg["right_source"] = _normalize_source_type(cfg.get("right_source"), allow_trigger=True)
        cfg["operator"] = str(cfg.get("operator") or "equals").strip()
        cfg["cast"] = str(cfg.get("cast") or "auto").strip()
        cfg["left_value"] = str(cfg.get("left_value") or "")
        cfg["right_value"] = str(cfg.get("right_value") or "")
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
        cfg["value_source"] = _normalize_source_type(cfg.get("value_source"), allow_trigger=True)
        cfg["value"] = str(cfg.get("value") or "")
        if not cfg["variable_key"]:
            raise HTTPException(status_code=400, detail="Set variable needs a variable key")
        if cfg["variable_key"] not in variable_keys:
            raise HTTPException(status_code=400, detail=f"Unknown variable key: {cfg['variable_key']}")
        return cfg

    if node_type == "operator.template":
        cfg["variable_key"] = str(cfg.get("variable_key") or "").strip()
        cfg["template"] = str(cfg.get("template") or "")
        if not cfg["variable_key"]:
            raise HTTPException(status_code=400, detail="Template node needs a variable key")
        if cfg["variable_key"] not in variable_keys:
            raise HTTPException(status_code=400, detail=f"Unknown variable key: {cfg['variable_key']}")
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

    if node_type == "action.activate_output_relay":
        cfg["mode"] = str(cfg.get("mode") or "pulse").strip().lower()
        if cfg["mode"] not in {"on", "off", "pulse"}:
            raise HTTPException(status_code=400, detail="Relay mode must be on, off or pulse")
        try:
            cfg["activation_seconds"] = float(cfg.get("activation_seconds") or 2)
        except Exception:
            raise HTTPException(status_code=400, detail="Relay activation_seconds must be numeric")
        if cfg["mode"] == "pulse" and cfg["activation_seconds"] <= 0:
            raise HTTPException(status_code=400, detail="Relay activation_seconds must be greater than 0")
        return cfg

    if node_type == "action.log_message":
        cfg["message"] = str(cfg.get("message") or "")
        return cfg

    return cfg



def _normalize_source_type(value: Any, allow_trigger: bool) -> str:
    source = str(value or "literal").strip().lower()
    allowed = {"literal", "variable"}
    if allow_trigger:
        allowed.add("trigger")
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



def _flow_variable_defaults(flow: Dict[str, Any]) -> Dict[str, Any]:
    return {item["key"]: deepcopy(item.get("value")) for item in flow.get("variables", [])}



def _get_runtime_variables(flow: Dict[str, Any]) -> Dict[str, Any]:
    defaults = _flow_variable_defaults(flow)
    with _runtime_lock:
        state = _load_runtime_state()
        saved = (state.get("flows") or {}).get(flow["id"], {}).get("variables") or {}
    merged = dict(defaults)
    merged.update(saved)
    return merged



def _save_runtime_variables(flow: Dict[str, Any], variables: Dict[str, Any]) -> None:
    with _runtime_lock:
        payload = _load_runtime_state()
        flows = payload.setdefault("flows", {})
        flow_state = flows.setdefault(flow["id"], {})
        flow_state["variables"] = variables
        flow_state["updated_at"] = _utc_now_iso()
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

    if persist_runtime:
        _save_runtime_variables(flow, variables)

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
        value = _resolve_value(cfg.get("value_source"), cfg.get("value"), context)
        context["variables"][key] = value
        result["variable_key"] = key
        result["value"] = value
        result["next_handles"] = ["out"]
        return result

    if node_type == "operator.template":
        key = str(cfg.get("variable_key") or "").strip()
        value = _render_template(str(cfg.get("template") or ""), context)
        context["variables"][key] = value
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
        except Exception as exc:
            result["ok"] = False
            result["error"] = str(exc)
        result["request"] = {"method": method, "url": url, "headers": headers, "body": body}
        result["next_handles"] = ["out"]
        return result

    if node_type == "action.activate_output_relay":
        result["relay"] = {
            "mode": cfg.get("mode"),
            "activation_seconds": cfg.get("activation_seconds"),
            "placeholder": True,
        }
        result["message"] = "Relay action accepted. Wire this to your hardware implementation."
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
