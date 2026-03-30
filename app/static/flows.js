const el = (id) => document.getElementById(id);

const state = {
  catalog: null,
  devices: [],
  flows: [],
  draft: null,
  selectedSavedFlowId: null,
  selectedNodeId: null,
  selectedEdgeId: null,
  dirty: false,
  connecting: null,
  connectionCursor: null,
  drag: null,
  topicCache: new Map(),
};

const CATEGORY_META = {
  trigger: { label: "Trigger", color: "#4f8cff" },
  condition: { label: "Condition", color: "#9c6bff" },
  operator: { label: "Operator", color: "#17b978" },
  action: { label: "Action", color: "#ff8c42" },
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });

  const txt = await res.text();
  let data = null;

  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }

  if (!res.ok) {
    throw new Error((data && data.detail) ? data.detail : (txt || res.statusText));
  }

  return data;
}

function escapeHtml(value) {
  return (value ?? "")
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, bad = false) {
  const node = el("boardStatus");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = bad ? "var(--danger)" : "var(--muted)";
}

function setTestStatus(message, bad = false) {
  const node = el("testStatus");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = bad ? "var(--danger)" : "var(--muted)";
}

function clearTestResult() {
  const box = el("testResult");
  if (!box) return;
  box.textContent = "";
  box.classList.add("hidden");
}

function showTestResult(value) {
  const box = el("testResult");
  if (!box) return;
  box.classList.remove("hidden");
  box.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function markDirty() {
  state.dirty = true;
  syncHeader();
}

function clearDirty() {
  state.dirty = false;
  syncHeader();
}

function nodeDef(type) {
  return (state.catalog?.nodes || []).find((item) => item.type === type) || null;
}

function currentFlow() {
  return state.draft;
}

function makeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function deviceOptionsHtml(selected = "") {
  const options = [`<option value="">Select device</option>`];
  for (const device of state.devices) {
    options.push(
      `<option value="${escapeHtml(device.id)}" ${device.id === selected ? "selected" : ""}>${escapeHtml(device.name)}</option>`
    );
  }
  return options.join("");
}

function variableKeyOptionsHtml(selected = "") {
  const vars = currentFlow()?.variables || [];
  const options = [`<option value="">Select variable</option>`];
  for (const variable of vars) {
    options.push(
      `<option value="${escapeHtml(variable.key)}" ${variable.key === selected ? "selected" : ""}>${escapeHtml(variable.key)}</option>`
    );
  }
  return options.join("");
}

function sourceOptionsHtml(selected = "literal") {
  const options = [
    ["literal", "Literal"],
    ["variable", "Variable"],
    ["trigger", "Trigger path"],
  ];

  return options
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function compareOperatorOptionsHtml(selected = "equals") {
  const options = state.catalog?.operators || [];
  return options
    .map((item) => `<option value="${item.value}" ${item.value === selected ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");
}

function castOptionsHtml(selected = "auto") {
  return [
    ["auto", "Auto"],
    ["string", "String"],
    ["number", "Number"],
    ["boolean", "Boolean"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function methodOptionsHtml(selected = "POST", allowAny = false) {
  const out = [];
  if (allowAny) {
    out.push(`<option value="ANY" ${selected === "ANY" ? "selected" : ""}>Any</option>`);
  }
  for (const method of (state.catalog?.http_methods || ["GET", "POST", "PUT", "PATCH", "DELETE"])) {
    out.push(`<option value="${method}" ${selected === method ? "selected" : ""}>${method}</option>`);
  }
  return out.join("");
}

function flowSummary(flow) {
  const nodes = flow.nodes || [];
  const triggers = nodes.filter((node) => node.category === "trigger").length;
  const conditions = nodes.filter((node) => node.category === "condition").length;
  const operators = nodes.filter((node) => node.category === "operator").length;
  const actions = nodes.filter((node) => node.category === "action").length;
  return `${triggers} trigger${triggers === 1 ? "" : "s"} · ${conditions} condition${conditions === 1 ? "" : "s"} · ${operators} operator${operators === 1 ? "" : "s"} · ${actions} action${actions === 1 ? "" : "s"}`;
}

function nodePreview(node) {
  const cfg = node.config || {};
  switch (node.type) {
    case "trigger.onvif_event": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `${device?.name || cfg.device_id || "device"} → ${cfg.topic || "topic"}`;
    }
    case "trigger.device_offline": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `When ${device?.name || cfg.device_id || "device"} goes offline`;
    }
    case "trigger.device_back_online": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `When ${device?.name || cfg.device_id || "device"} comes back online`;
    }
    case "trigger.incoming_http_request":
      return `${cfg.method || "ANY"} ${cfg.path || "/"}`;
    case "trigger.manual":
      return "Run this node manually from the editor";
    case "condition.compare":
      return `${cfg.left_source || "literal"}:${cfg.left_value || ""} ${cfg.operator || "equals"} ${cfg.right_source || "literal"}:${cfg.right_value || ""}`;
    case "operator.delay":
      return `Wait ${cfg.seconds ?? 0}s`;
    case "operator.set_variable":
      return `${cfg.variable_key || "variable"} ← ${cfg.value_source || "literal"}:${cfg.value || ""}`;
    case "operator.template":
      return `${cfg.variable_key || "variable"} ← template`;
    case "action.send_http_request":
      return `${cfg.method || "POST"} ${cfg.url || ""}`;
    case "action.activate_output_relay":
      return `${cfg.mode || "pulse"}${cfg.mode === "pulse" ? ` for ${cfg.activation_seconds || 0}s` : ""}`;
    case "action.log_message":
      return cfg.message || "Log message";
    default:
      return node.label;
  }
}

function starterFlow() {
  return {
    id: null,
    name: "New flow",
    enabled: true,
    variables: [],
    nodes: [],
    edges: [],
  };
}

function syncHeader() {
  const flow = currentFlow();
  const title = flow?.name || "New flow";

  if (el("flowHeading")) {
    el("flowHeading").textContent = title;
  }

  if (el("flowMetaText")) {
    el("flowMetaText").textContent = flow?.id
      ? (state.dirty ? "Editing saved flow · unsaved changes" : "Editing saved flow")
      : (state.dirty ? "Unsaved draft · changes pending" : "Unsaved draft");
  }

  if (el("btnDeleteFlow")) {
    el("btnDeleteFlow").disabled = !flow?.id;
  }
}

function confirmDiscard() {
  if (!state.dirty) return true;
  return window.confirm("You have unsaved changes. Discard them?");
}

function renderFlowList() {
  const q = (el("flowSearch")?.value || "").trim().toLowerCase();
  const items = state.flows.filter((flow) => {
    if (!q) return true;
    return [flow.name, flowSummary(flow)].join(" ").toLowerCase().includes(q);
  });

  const box = el("flowList");
  if (!box) return;

  if (!items.length) {
    box.innerHTML = `<div class="emptyState">No flows found.</div>`;
    return;
  }

  box.innerHTML = items.map((flow) => `
    <div class="flowListItem ${flow.id === state.selectedSavedFlowId ? "active" : ""}" data-id="${escapeHtml(flow.id)}">
      <div class="flowListItemTop">
        <div>
          <div class="flowListItemName">${escapeHtml(flow.name)}</div>
          <div class="flowListItemMeta">${escapeHtml(flowSummary(flow))}</div>
        </div>
        <div class="miniPill ${flow.enabled ? "enabled" : ""}">${flow.enabled ? "Enabled" : "Disabled"}</div>
      </div>
      <div class="chipRow">
        <span class="miniPill">${flow.nodes.length} nodes</span>
        <span class="miniPill">${flow.edges.length} links</span>
        <span class="miniPill">${flow.variables.length} vars</span>
      </div>
    </div>
  `).join("");

  box.querySelectorAll(".flowListItem").forEach((node) => {
    node.addEventListener("click", () => {
      const flow = state.flows.find((item) => item.id === node.dataset.id);
      if (!flow) return;
      if (!confirmDiscard()) return;

      state.selectedSavedFlowId = flow.id;
      state.draft = deepClone(flow);
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      state.connecting = null;
      state.connectionCursor = null;

      clearDirty();
      clearTestResult();
      renderAll();
      setStatus(`Loaded flow "${flow.name}".`);
    });
  });
}

function renderPalette() {
  const q = (el("paletteSearch")?.value || "").trim().toLowerCase();
  const groups = new Map();

  for (const item of state.catalog?.nodes || []) {
    const haystack = [
      item.label,
      item.type,
      item.category,
      item.description || "",
    ].join(" ").toLowerCase();

    if (q && !haystack.includes(q)) continue;

    const list = groups.get(item.category) || [];
    list.push(item);
    groups.set(item.category, list);
  }

  const box = el("paletteGroups");
  if (!box) return;

  if (!groups.size) {
    box.innerHTML = `<div class="emptyState">No palette blocks found.</div>`;
    return;
  }

  box.innerHTML = [...groups.entries()].map(([category, items]) => `
    <div class="paletteGroup">
      <div class="paletteGroupHead">${escapeHtml(category)}</div>
      <div class="paletteGroupBody">
        ${items.map((item) => `
          <button class="paletteItem" type="button" data-type="${escapeHtml(item.type)}">
            <div class="paletteItemTitle">${escapeHtml(item.label)}</div>
            <div class="paletteItemSub">${escapeHtml(item.description || "")}</div>
          </button>
        `).join("")}
      </div>
    </div>
  `).join("");

  box.querySelectorAll(".paletteItem").forEach((button) => {
    button.addEventListener("click", () => addNodeFromPalette(button.dataset.type));
  });
}

function addNodeFromPalette(type) {
  const flow = currentFlow();
  const def = nodeDef(type);
  if (!flow || !def) return;

  const boardScroller = el("flowBoardScroller");
  const x = (boardScroller?.scrollLeft || 0) + 220;
  const y = (boardScroller?.scrollTop || 0) + 150;

  const node = {
    id: makeId("node"),
    type: def.type,
    category: def.category,
    label: def.label,
    x,
    y,
    config: deepClone(def.defaults || {}),
  };

  flow.nodes.push(node);
  state.selectedNodeId = node.id;
  state.selectedEdgeId = null;

  markDirty();
  renderAll();
}

function renderCanvas() {
  const flow = currentFlow();
  const nodesBox = el("flowNodes");
  const hint = el("emptyBoardHint");

  if (!nodesBox || !hint) return;

  if (!flow) {
    nodesBox.innerHTML = "";
    hint.classList.remove("hidden");
    drawEdges();
    return;
  }

  hint.classList.toggle("hidden", flow.nodes.length > 0);

  nodesBox.innerHTML = flow.nodes.map((node) => {
    const def = nodeDef(node.type);
    const ports = def?.ports || { inputs: [], outputs: [] };
    const meta = CATEGORY_META[node.category] || CATEGORY_META.action;

    return `
      <div class="flowNode ${node.category} ${node.id === state.selectedNodeId ? "selected" : ""}" data-node-id="${escapeHtml(node.id)}" style="left:${Number(node.x) || 0}px; top:${Number(node.y) || 0}px;">
        <div class="flowNodeTop">
          <div>
            <div class="flowNodeLabel">${escapeHtml(node.label)}</div>
            <div class="flowNodeType">${escapeHtml(meta.label)}</div>
          </div>
          <span class="nodeBadge">${escapeHtml(meta.label)}</span>
        </div>

        <div class="flowNodePreview">${escapeHtml(nodePreview(node))}</div>

        ${node.type === "trigger.manual" ? `
          <div class="mt-10">
            <button class="btn flowNodeRunBtn" type="button" data-run-node-id="${escapeHtml(node.id)}">Run</button>
          </div>
        ` : ""}

        <div class="flowNodePorts">
          <div class="portStack inputs">
            ${ports.inputs.map((port) => `
              <button class="flowPort ${state.connecting && state.connecting.nodeId === node.id && state.connecting.handle === port && state.connecting.kind === "input" ? "active" : ""}" type="button" data-port-kind="input" data-port-handle="${escapeHtml(port)}" data-node-id="${escapeHtml(node.id)}">
                <span class="flowPortLabel">${escapeHtml(port)}</span>
              </button>
            `).join("")}
          </div>
          <div class="portStack outputs">
            ${ports.outputs.map((port) => `
              <button class="flowPort ${state.connecting && state.connecting.nodeId === node.id && state.connecting.handle === port && state.connecting.kind === "output" ? "active" : ""}" type="button" data-port-kind="output" data-port-handle="${escapeHtml(port)}" data-node-id="${escapeHtml(node.id)}">
                <span class="flowPortLabel">${escapeHtml(port)}</span>
              </button>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }).join("");

  nodesBox.querySelectorAll(".flowNode").forEach((nodeEl) => {
    const nodeId = nodeEl.dataset.nodeId;

    nodeEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (ev.target.closest(".flowPort")) return;
      if (ev.target.closest(".flowNodeRunBtn")) return;

      state.selectedNodeId = nodeId;
      state.selectedEdgeId = null;
      renderInspector();
      renderCanvas();
      drawEdges();
    });

    nodeEl.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest(".flowPort")) return;
      if (ev.target.closest(".flowNodeRunBtn")) return;

      const node = currentFlow().nodes.find((item) => item.id === nodeId);
      if (!node) return;

      state.selectedNodeId = nodeId;
      state.selectedEdgeId = null;
      state.drag = {
        nodeId,
        startX: ev.clientX,
        startY: ev.clientY,
        originX: node.x,
        originY: node.y,
      };

      nodeEl.classList.add("dragging");
      renderInspector();
      ev.preventDefault();
    });
  });

  nodesBox.querySelectorAll(".flowPort").forEach((portEl) => {
    portEl.addEventListener("click", (ev) => {
      ev.stopPropagation();

      const kind = portEl.dataset.portKind;
      const nodeId = portEl.dataset.nodeId;
      const handle = portEl.dataset.portHandle || (kind === "input" ? "in" : "out");

      const board = el("flowBoard");
      let cursor = null;

      if (board) {
        const rect = board.getBoundingClientRect();
        cursor = {
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        };
      }

      if (!state.connecting) {
        state.connecting = { nodeId, handle, kind };
        state.connectionCursor = cursor;
        state.selectedNodeId = nodeId;
        state.selectedEdgeId = null;
        renderAll();
        setStatus(
          kind === "input"
            ? `Connection started from input "${handle}". Click an output port to finish.`
            : `Connection started from output "${handle}". Click an input port to finish.`
        );
        return;
      }

      if (
        state.connecting.nodeId === nodeId &&
        state.connecting.handle === handle &&
        state.connecting.kind === kind
      ) {
        state.connecting = null;
        state.connectionCursor = null;
        renderAll();
        setStatus("Connection cancelled.");
        return;
      }

      if (state.connecting.kind === kind) {
        state.connecting = { nodeId, handle, kind };
        state.connectionCursor = cursor;
        state.selectedNodeId = nodeId;
        state.selectedEdgeId = null;
        renderAll();
        setStatus(
          kind === "input"
            ? `Connection restarted from input "${handle}". Click an output port to finish.`
            : `Connection restarted from output "${handle}". Click an input port to finish.`
        );
        return;
      }

      const sourceNodeId = state.connecting.kind === "output" ? state.connecting.nodeId : nodeId;
      const sourceHandle = state.connecting.kind === "output" ? state.connecting.handle : handle;
      const targetNodeId = state.connecting.kind === "input" ? state.connecting.nodeId : nodeId;
      const targetHandle = state.connecting.kind === "input" ? state.connecting.handle : handle;

      const duplicate = currentFlow().edges.some((edge) =>
        edge.source === sourceNodeId &&
        edge.source_handle === sourceHandle &&
        edge.target === targetNodeId &&
        edge.target_handle === targetHandle
      );

      if (!duplicate) {
        currentFlow().edges.push({
          id: makeId("edge"),
          source: sourceNodeId,
          source_handle: sourceHandle,
          target: targetNodeId,
          target_handle: targetHandle,
        });
        markDirty();
      }

      state.connecting = null;
      state.connectionCursor = null;
      renderAll();
      setStatus(duplicate ? "Connection already exists." : "Connection created.");
    });
  });

  nodesBox.querySelectorAll(".flowNodeRunBtn").forEach((button) => {
    button.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        await triggerManualNode(button.dataset.runNodeId);
      } catch { }
    });

    button.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
    });
  });

  window.requestAnimationFrame(drawEdges);
}

function makeBezierPath(sx, sy, tx, ty) {
  const dx = Math.max(80, Math.abs(tx - sx) * 0.5);
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
}

function drawEdges() {
  const svg = el("flowEdges");
  const board = el("flowBoard");
  const flow = currentFlow();

  if (!svg || !board) return;

  svg.innerHTML = "";

  if (!flow) return;

  const boardRect = board.getBoundingClientRect();

  for (const edge of flow.edges) {
    const sourcePort = board.querySelector(
      `.flowPort[data-node-id="${CSS.escape(edge.source)}"][data-port-kind="output"][data-port-handle="${CSS.escape(edge.source_handle || "out")}"]`
    );
    const targetPort = board.querySelector(
      `.flowPort[data-node-id="${CSS.escape(edge.target)}"][data-port-kind="input"][data-port-handle="${CSS.escape(edge.target_handle || "in")}"]`
    );

    if (!sourcePort || !targetPort) continue;

    const sourceRect = sourcePort.getBoundingClientRect();
    const targetRect = targetPort.getBoundingClientRect();

    const sx = sourceRect.left - boardRect.left + sourceRect.width / 2;
    const sy = sourceRect.top - boardRect.top + sourceRect.height / 2;
    const tx = targetRect.left - boardRect.left + targetRect.width / 2;
    const ty = targetRect.top - boardRect.top + targetRect.height / 2;

    const d = makeBezierPath(sx, sy, tx, ty);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `flowEdgePath ${edge.id === state.selectedEdgeId ? "active" : ""}`);
    path.dataset.edgeId = edge.id;

    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "flowEdgeHitArea");
    hit.dataset.edgeId = edge.id;

    const hoverOn = () => path.classList.add("hovered");
    const hoverOff = () => path.classList.remove("hovered");

    const removeEdge = (ev) => {
      ev.stopPropagation();

      const liveFlow = currentFlow();
      if (!liveFlow) return;

      liveFlow.edges = liveFlow.edges.filter((item) => item.id !== edge.id);

      if (state.selectedEdgeId === edge.id) {
        state.selectedEdgeId = null;
      }

      markDirty();
      renderInspector();
      drawEdges();
      setStatus("Connection deleted.");
    };

    hit.addEventListener("pointerenter", hoverOn);
    hit.addEventListener("pointerleave", hoverOff);
    hit.addEventListener("click", removeEdge);

    svg.appendChild(path);
    svg.appendChild(hit);
  }

  if (state.connecting && state.connectionCursor) {
    const portKind = state.connecting.kind || "output";
    const portHandle = state.connecting.handle || (portKind === "input" ? "in" : "out");

    const anchorPort = board.querySelector(
      `.flowPort[data-node-id="${CSS.escape(state.connecting.nodeId)}"][data-port-kind="${CSS.escape(portKind)}"][data-port-handle="${CSS.escape(portHandle)}"]`
    );

    if (anchorPort) {
      const anchorRect = anchorPort.getBoundingClientRect();

      const ax = anchorRect.left - boardRect.left + anchorRect.width / 2;
      const ay = anchorRect.top - boardRect.top + anchorRect.height / 2;
      const cx = state.connectionCursor.x;
      const cy = state.connectionCursor.y;

      const ghost = document.createElementNS("http://www.w3.org/2000/svg", "path");
      ghost.setAttribute(
        "d",
        portKind === "input"
          ? makeBezierPath(cx, cy, ax, ay)
          : makeBezierPath(ax, ay, cx, cy)
      );
      ghost.setAttribute("class", "flowEdgePath flowEdgeGhost");
      svg.appendChild(ghost);
    }
  }
}

function renderInspector() {
  const box = el("inspectorBody");
  const flow = currentFlow();

  if (!box) return;

  if (!flow) {
    box.innerHTML = `<div class="inspectorHint">No flow selected.</div>`;
    return;
  }

  if (state.selectedEdgeId) {
    const edge = flow.edges.find((item) => item.id === state.selectedEdgeId);
    if (!edge) {
      state.selectedEdgeId = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = "Connection settings";
    }

    box.innerHTML = `
      <div class="inspectorCard dangerZone">
        <div class="inspectorTitle">Connection</div>
        <div class="inspectorHint">${escapeHtml(edge.source)}:${escapeHtml(edge.source_handle)} → ${escapeHtml(edge.target)}:${escapeHtml(edge.target_handle)}</div>
        <div class="row2 mt-10">
          <button class="btn btn-danger" id="btnDeleteEdge" type="button">Delete connection</button>
        </div>
      </div>
    `;

    el("btnDeleteEdge")?.addEventListener("click", () => {
      flow.edges = flow.edges.filter((item) => item.id !== edge.id);
      state.selectedEdgeId = null;
      markDirty();
      renderAll();
      setStatus("Connection deleted.");
    });

    return;
  }

  if (state.selectedNodeId) {
    const node = flow.nodes.find((item) => item.id === state.selectedNodeId);
    if (!node) {
      state.selectedNodeId = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${node.label} settings`;
    }

    box.innerHTML = renderNodeInspector(node);
    bindNodeInspector(node);
    return;
  }

  if (el("inspectorSubtext")) {
    el("inspectorSubtext").textContent = "Flow settings and reusable variables.";
  }

  box.innerHTML = renderFlowInspector(flow);
  bindFlowInspector(flow);
}

function renderFlowInspector(flow) {
  return `
    <div class="inspectorCard">
      <div class="inspectorTitle">Flow</div>
      <div class="fieldGrid">
        <div class="full">
          <label for="flowNameInput">Flow name</label>
          <input id="flowNameInput" value="${escapeHtml(flow.name || "")}" placeholder="Front door automation" />
        </div>
        <div class="full">
          <label class="enableRow m-0">
            <input id="flowEnabledInput" type="checkbox" ${flow.enabled ? "checked" : ""} />
            <span>${flow.enabled ? "Enabled" : "Disabled"}</span>
          </label>
        </div>
      </div>
    </div>

    <div class="inspectorCard">
      <div class="rowSplit">
        <div class="inspectorTitle" style="margin-bottom:0;">Variables</div>
        <button class="btn" id="btnAddVariable" type="button">Add variable</button>
      </div>
      <div class="inspectorHint mt-8">Conditions and operators can read and update these variables.</div>
      <div class="variableList mt-10">
        ${(flow.variables || []).length ? flow.variables.map((variable, idx) => `
          <div class="variableRow" data-variable-index="${idx}">
            <div class="variableRowHead">
              <div>
                <div class="variableLabel">${escapeHtml(variable.key || `var_${idx + 1}`)}</div>
                <div class="inlineMeta">${escapeHtml(variable.type || "string")}</div>
              </div>
              <button class="btn btn-danger btnRemoveVariable" type="button">Remove</button>
            </div>
            <div class="fieldGrid">
              <div>
                <label>Key</label>
                <input class="jsVarKey" value="${escapeHtml(variable.key || "")}" placeholder="armed" />
              </div>
              <div>
                <label>Label</label>
                <input class="jsVarLabel" value="${escapeHtml(variable.label || "")}" placeholder="Armed" />
              </div>
              <div>
                <label>Type</label>
                <select class="jsVarType">
                  <option value="string" ${(variable.type || "string") === "string" ? "selected" : ""}>String</option>
                  <option value="number" ${(variable.type || "string") === "number" ? "selected" : ""}>Number</option>
                  <option value="boolean" ${(variable.type || "string") === "boolean" ? "selected" : ""}>Boolean</option>
                  <option value="json" ${(variable.type || "string") === "json" ? "selected" : ""}>JSON</option>
                </select>
              </div>
              <div>
                <label>Default value</label>
                <input class="jsVarValue" value="${escapeHtml(formatVariableValue(variable.value, variable.type))}" placeholder="value" />
              </div>
            </div>
          </div>
        `).join("") : `<div class="emptyState">No variables yet.</div>`}
      </div>
    </div>
  `;
}

function formatVariableValue(value, type) {
  if (type === "json") {
    try {
      return JSON.stringify(value ?? {}, null, 0);
    } catch {
      return "{}";
    }
  }
  if (type === "boolean") return value ? "true" : "false";
  return value == null ? "" : String(value);
}

function bindFlowInspector(flow) {
  el("flowNameInput")?.addEventListener("input", () => {
    flow.name = el("flowNameInput").value;
    markDirty();
    renderFlowList();
    syncHeader();
  });

  el("flowEnabledInput")?.addEventListener("change", () => {
    flow.enabled = el("flowEnabledInput").checked;
    markDirty();
    renderFlowList();
    renderInspector();
  });

  el("btnAddVariable")?.addEventListener("click", () => {
    flow.variables.push({
      key: `var_${flow.variables.length + 1}`,
      label: "",
      type: "string",
      value: "",
    });
    markDirty();
    renderInspector();
  });

  boxBindVariableRows(flow);
}

function boxBindVariableRows(flow) {
  document.querySelectorAll(".variableRow").forEach((row) => {
    const idx = Number(row.dataset.variableIndex || -1);
    const variable = flow.variables[idx];
    if (!variable) return;

    row.querySelector(".btnRemoveVariable")?.addEventListener("click", () => {
      flow.variables.splice(idx, 1);
      markDirty();
      renderInspector();
    });

    row.querySelector(".jsVarKey")?.addEventListener("input", (ev) => {
      variable.key = ev.target.value.trim();
      markDirty();
      const label = row.querySelector(".variableLabel");
      if (label) label.textContent = variable.key || `var_${idx + 1}`;
    });

    row.querySelector(".jsVarLabel")?.addEventListener("input", (ev) => {
      variable.label = ev.target.value;
      markDirty();
    });

    row.querySelector(".jsVarType")?.addEventListener("change", (ev) => {
      variable.type = ev.target.value;
      markDirty();
      renderInspector();
    });

    row.querySelector(".jsVarValue")?.addEventListener("input", (ev) => {
      variable.value = ev.target.value;
      markDirty();
    });
  });
}

function renderNodeInspector(node) {
  const cfg = node.config || {};
  const common = `
    <div class="inspectorCard">
      <div class="rowSplit">
        <div class="inspectorTitle" style="margin-bottom:0;">${escapeHtml(node.label)}</div>
        <button class="btn btn-danger" id="btnDeleteNode" type="button">Delete node</button>
      </div>
      <div class="fieldGrid mt-10">
        <div class="full">
          <label>Display label</label>
          <input id="nodeLabelInput" value="${escapeHtml(node.label || "")}" />
        </div>
      </div>
    </div>
  `;

  let body = "";

  switch (node.type) {
    case "trigger.onvif_event":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Trigger details</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Front door motion" />
            </div>
            <div class="full">
              <label>Device</label>
              <select id="cfg_device_id">${deviceOptionsHtml(cfg.device_id || "")}</select>
            </div>
            <div class="full">
              <label>Topic</label>
              <select id="cfg_topic"><option value="">Select topic</option></select>
            </div>
            <div class="full row2 mt-0">
              <button class="btn" id="btnRefreshTopics" type="button">Refresh topics</button>
            </div>
          </div>
        </div>
      `;
      break;

    case "trigger.device_offline":
    case "trigger.device_back_online":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Trigger details</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Device</label>
              <select id="cfg_device_id">${deviceOptionsHtml(cfg.device_id || "")}</select>
            </div>
          </div>
        </div>
      `;
      break;

    case "trigger.incoming_http_request":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Webhook trigger</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Webhook trigger" />
            </div>
            <div>
              <label>Method</label>
              <select id="cfg_method">${methodOptionsHtml(cfg.method || "ANY", true)}</select>
            </div>
            <div>
              <label>Path</label>
              <input id="cfg_path" value="${escapeHtml(cfg.path || "")}" placeholder="/flow-hook/order" />
            </div>
            <div class="full">
              <label>URL</label>
              <input value="${escapeHtml(buildWebhookUrl(cfg.path || ""))}" readonly />
            </div>
          </div>
        </div>
      `;
      break;

    case "trigger.manual":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Manual trigger</div>
          <div class="inspectorHint">Run this flow path manually from the editor.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Manual trigger" />
            </div>
            <div class="full row2 mt-0">
              <button class="btn btn-primary" id="btnRunManualNode" type="button">Run manual trigger</button>
            </div>
          </div>
        </div>
      `;
      break;

    case "condition.compare":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Compare</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Left source</label>
              <select id="cfg_left_source">${sourceOptionsHtml(cfg.left_source || "variable")}</select>
            </div>
            <div>
              <label>Left value</label>
              <input id="cfg_left_value" value="${escapeHtml(cfg.left_value || "")}" placeholder="armed or extra.changed.IsMotion" list="variableKeysList" />
            </div>
            <div>
              <label>Operator</label>
              <select id="cfg_operator">${compareOperatorOptionsHtml(cfg.operator || "equals")}</select>
            </div>
            <div>
              <label>Cast</label>
              <select id="cfg_cast">${castOptionsHtml(cfg.cast || "auto")}</select>
            </div>
            <div>
              <label>Right source</label>
              <select id="cfg_right_source">${sourceOptionsHtml(cfg.right_source || "literal")}</select>
            </div>
            <div>
              <label>Right value</label>
              <input id="cfg_right_value" value="${escapeHtml(cfg.right_value || "")}" placeholder="true" list="variableKeysList" />
            </div>
          </div>
        </div>
      `;
      break;

    case "operator.delay":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Delay</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Seconds</label>
              <input id="cfg_seconds" type="number" min="0" step="0.1" value="${escapeHtml(cfg.seconds ?? 0)}" />
            </div>
          </div>
        </div>
      `;
      break;

    case "operator.set_variable":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Set variable</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Variable</label>
              <select id="cfg_variable_key">${variableKeyOptionsHtml(cfg.variable_key || "")}</select>
            </div>
            <div>
              <label>Value source</label>
              <select id="cfg_value_source">${sourceOptionsHtml(cfg.value_source || "literal")}</select>
            </div>
            <div class="full">
              <label>Value</label>
              <input id="cfg_value" value="${escapeHtml(cfg.value || "")}" placeholder="literal, variable key, or trigger path" list="variableKeysList" />
            </div>
          </div>
        </div>
      `;
      break;

    case "operator.template":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Template</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Store result in variable</label>
              <select id="cfg_variable_key">${variableKeyOptionsHtml(cfg.variable_key || "")}</select>
            </div>
            <div class="full">
              <label>Template</label>
              <textarea id="cfg_template" rows="6">${escapeHtml(cfg.template || "")}</textarea>
            </div>
            <div class="full inlineMeta">Use placeholders like {{flow.name}}, {{trigger.kind}}, {{variables.armed}}, or {{last.message}}.</div>
          </div>
        </div>
      `;
      break;

    case "action.send_http_request":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">HTTP request</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Method</label>
              <select id="cfg_method">${methodOptionsHtml(cfg.method || "POST")}</select>
            </div>
            <div>
              <label>Timeout (seconds)</label>
              <input id="cfg_timeout_seconds" type="number" min="0.1" step="0.1" value="${escapeHtml(cfg.timeout_seconds ?? 10)}" />
            </div>
            <div class="full">
              <label>URL</label>
              <input id="cfg_url" value="${escapeHtml(cfg.url || "")}" placeholder="http://example.local/hook" />
            </div>
            <div class="full">
              <label>Headers (JSON)</label>
              <textarea id="cfg_headers" rows="5">${escapeHtml(cfg.headers || "{}")}</textarea>
            </div>
            <div class="full">
              <label>Body</label>
              <textarea id="cfg_body" rows="6">${escapeHtml(cfg.body || "")}</textarea>
            </div>
          </div>
        </div>
      `;
      break;

    case "action.activate_output_relay":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Relay action</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Mode</label>
              <select id="cfg_mode">
                <option value="on" ${cfg.mode === "on" ? "selected" : ""}>On</option>
                <option value="off" ${cfg.mode === "off" ? "selected" : ""}>Off</option>
                <option value="pulse" ${cfg.mode === "pulse" ? "selected" : ""}>Pulse</option>
              </select>
            </div>
            <div>
              <label>Activation seconds</label>
              <input id="cfg_activation_seconds" type="number" min="0.1" step="0.1" value="${escapeHtml(cfg.activation_seconds ?? 2)}" />
            </div>
          </div>
        </div>
      `;
      break;

    case "action.log_message":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Log message</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Message</label>
              <textarea id="cfg_message" rows="6">${escapeHtml(cfg.message || "")}</textarea>
            </div>
          </div>
        </div>
      `;
      break;

    default:
      body = `<div class="inspectorCard"><div class="inspectorHint">No editor available for this node yet.</div></div>`;
      break;
  }

  return `${common}
    <datalist id="variableKeysList">
      ${(currentFlow().variables || []).map((variable) => `<option value="${escapeHtml(variable.key)}"></option>`).join("")}
    </datalist>
    ${body}
  `;
}

function bindNodeInspector(node) {
  document.getElementById("btnDeleteNode")?.addEventListener("click", () => {
    const flow = currentFlow();
    flow.nodes = flow.nodes.filter((item) => item.id !== node.id);
    flow.edges = flow.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
    state.selectedNodeId = null;
    markDirty();
    renderAll();
    setStatus("Node deleted.");
  });

  document.getElementById("nodeLabelInput")?.addEventListener("input", (ev) => {
    node.label = ev.target.value;
    markDirty();
    renderCanvas();
  });

  for (const element of document.querySelectorAll("#inspectorBody input, #inspectorBody select, #inspectorBody textarea")) {
    if (element.id === "nodeLabelInput") continue;
    element.addEventListener("input", () => applyNodeInspector(node));
    element.addEventListener("change", () => applyNodeInspector(node));
  }

  if (node.type === "trigger.onvif_event") {
    hydrateTopicSelect(node, false);

    document.getElementById("cfg_device_id")?.addEventListener("change", async () => {
      node.config.device_id = document.getElementById("cfg_device_id").value;
      node.config.topic = "";
      await hydrateTopicSelect(node, false);
      markDirty();
      renderCanvas();
    });

    document.getElementById("btnRefreshTopics")?.addEventListener("click", async () => {
      await hydrateTopicSelect(node, true);
    });
  }

  if (node.type === "trigger.manual") {
    document.getElementById("btnRunManualNode")?.addEventListener("click", async () => {
      try {
        await triggerManualNode(node.id);
      } catch { }
    });
  }
}

function applyNodeInspector(node) {
  const cfg = node.config || {};

  const set = (key, fallback = "") => {
    const input = document.getElementById(`cfg_${key}`);
    if (!input) return;
    cfg[key] = input.value ?? fallback;
  };

  switch (node.type) {
    case "trigger.onvif_event":
      set("name");
      set("device_id");
      set("topic");
      break;
    case "trigger.device_offline":
    case "trigger.device_back_online":
      set("name");
      set("device_id");
      break;
    case "trigger.incoming_http_request":
      set("name");
      set("method");
      set("path");
      break;
    case "trigger.manual":
      set("name");
      break;
    case "condition.compare":
      set("name");
      set("left_source");
      set("left_value");
      set("operator");
      set("cast");
      set("right_source");
      set("right_value");
      break;
    case "operator.delay":
      set("name");
      set("seconds");
      break;
    case "operator.set_variable":
      set("name");
      set("variable_key");
      set("value_source");
      set("value");
      break;
    case "operator.template":
      set("name");
      set("variable_key");
      set("template");
      break;
    case "action.send_http_request":
      set("name");
      set("method");
      set("timeout_seconds");
      set("url");
      set("headers");
      set("body");
      break;
    case "action.activate_output_relay":
      set("name");
      set("mode");
      set("activation_seconds");
      break;
    case "action.log_message":
      set("name");
      set("message");
      break;
  }

  if (node.type === "trigger.incoming_http_request") {
    cfg.path = normalizePath(cfg.path || "");
  }

  markDirty();
  renderCanvas();
  drawEdges();
}

function normalizePath(value) {
  let raw = (value || "").trim();
  if (!raw) return "";
  raw = raw.split("?", 1)[0].trim();
  if (!raw.startsWith("/")) raw = `/${raw}`;
  const parts = raw.split("/").filter(Boolean);
  return parts.length ? `/${parts.join("/")}` : "/";
}

function buildWebhookUrl(path) {
  const clean = normalizePath(path);
  if (!clean) return "";
  if (clean === "/") return `${window.location.origin}/flow-hook`;
  return `${window.location.origin}/flow-hook${clean}`;
}

async function hydrateTopicSelect(node, force = false) {
  const select = document.getElementById("cfg_topic");
  const deviceId = document.getElementById("cfg_device_id")?.value || node.config.device_id || "";

  node.config.device_id = deviceId;

  if (!select) return;

  if (!deviceId) {
    select.innerHTML = `<option value="">Select device first</option>`;
    return;
  }

  try {
    const topics = await loadTopics(deviceId, force);
    const chosen = node.config.topic || "";
    select.innerHTML = `<option value="">Select topic</option>${topics.map((topic) => `
      <option value="${escapeHtml(topic.path)}" ${topic.path === chosen ? "selected" : ""}>
        ${escapeHtml(topic.name || topic.path)}
      </option>
    `).join("")}`;
  } catch (err) {
    select.innerHTML = `<option value="">Failed to load topics</option>`;
    setStatus(err.message || String(err), true);
  }
}

async function loadTopics(deviceId, force = false) {
  if (!force && state.topicCache.has(deviceId)) {
    return state.topicCache.get(deviceId);
  }

  const data = await api(`/api/events/properties/${encodeURIComponent(deviceId)}`);
  const topics = Array.isArray(data?.topics) ? data.topics : [];
  state.topicCache.set(deviceId, topics);
  return topics;
}

function renderAll() {
  syncHeader();
  renderFlowList();
  renderCanvas();
  renderInspector();
}

async function saveFlow() {
  const flow = currentFlow();
  if (!flow) return;

  validateDraft(flow);
  const payload = serializeFlow(flow);

  const out = flow.id
    ? await api(`/api/flows/${encodeURIComponent(flow.id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    })
    : await api(`/api/flows`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

  const saved = out.item;
  state.selectedSavedFlowId = saved.id;
  state.draft = deepClone(saved);

  await refreshFlows();
  clearDirty();
  setStatus("Flow saved.");
  renderAll();
}

function serializeFlow(flow) {
  return {
    name: flow.name,
    enabled: !!flow.enabled,
    variables: (flow.variables || []).map((variable) => ({
      key: (variable.key || "").trim(),
      label: variable.label || variable.key,
      type: variable.type || "string",
      value: variable.value,
    })),
    nodes: (flow.nodes || []).map((node) => ({
      id: node.id,
      type: node.type,
      category: node.category,
      label: node.label,
      x: Number(node.x) || 0,
      y: Number(node.y) || 0,
      config: node.config || {},
    })),
    edges: deepClone(flow.edges || []),
  };
}

function validateDraft(flow) {
  if (!(flow.name || "").trim()) {
    throw new Error("Flow name is required.");
  }

  const variableKeys = new Set();
  for (const variable of flow.variables || []) {
    const key = (variable.key || "").trim();
    if (!key) throw new Error("Every variable needs a key.");
    if (variableKeys.has(key)) throw new Error(`Duplicate variable key: ${key}`);
    variableKeys.add(key);
  }

  if (!(flow.nodes || []).length) {
    throw new Error("Add at least one node.");
  }

  if (!(flow.nodes || []).some((node) => node.category === "trigger")) {
    throw new Error("Add at least one trigger node.");
  }
}

async function refreshFlows() {
  const data = await api("/api/flows");
  state.flows = Array.isArray(data?.items) ? data.items : [];
}

async function triggerManualNode(nodeId) {
  const flow = currentFlow();
  if (!flow) {
    setTestStatus("No flow loaded.", true);
    setStatus("No flow loaded.", true);
    return;
  }

  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) {
    setTestStatus("Manual trigger node not found.", true);
    return;
  }

  if (node.type !== "trigger.manual") {
    setTestStatus("Selected node is not a manual trigger.", true);
    return;
  }

  try {
    validateDraft(flow);

    const out = await api(`/api/flows/test`, {
      method: "POST",
      body: JSON.stringify({
        flow_id: flow.id || null,
        flow: serializeFlow(flow),
        trigger_node_id: node.id,
        trigger_payload: {},
      }),
    });

    showTestResult(out.result);
    setTestStatus(`Manual trigger "${node.label}" executed against the current draft.`);
    setStatus(`Manual trigger "${node.label}" executed against the current draft.`);
  } catch (err) {
    setTestStatus(err.message || String(err), true);
    setStatus(err.message || String(err), true);
    throw err;
  }
}

function duplicateDraft() {
  const flow = currentFlow();
  if (!flow) return;

  const copy = deepClone(flow);
  copy.id = null;
  copy.name = `${flow.name || "Flow"} copy`;

  state.selectedSavedFlowId = null;
  state.draft = copy;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.connecting = null;
  state.connectionCursor = null;

  markDirty();
  clearTestResult();
  renderAll();
  setStatus("Flow duplicated into a new draft.");
}

async function deleteDraft() {
  const flow = currentFlow();
  if (!flow?.id) return;

  await api(`/api/flows/${encodeURIComponent(flow.id)}`, { method: "DELETE" });
  await refreshFlows();

  state.selectedSavedFlowId = null;
  state.draft = starterFlow();
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.connecting = null;
  state.connectionCursor = null;

  clearDirty();
  clearTestResult();
  renderAll();
  setStatus("Flow deleted.");
}

function bindGlobalEvents() {
  el("btnNewFlow")?.addEventListener("click", () => {
    if (!confirmDiscard()) return;

    state.selectedSavedFlowId = null;
    state.draft = starterFlow();
    state.selectedNodeId = null;
    state.selectedEdgeId = null;
    state.connecting = null;
    state.connectionCursor = null;

    clearDirty();
    clearTestResult();
    renderAll();
    setStatus("Started a new flow.");
  });

  el("btnSaveFlow")?.addEventListener("click", async () => {
    try {
      await saveFlow();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  el("btnDuplicateFlow")?.addEventListener("click", duplicateDraft);

  el("btnDeleteFlow")?.addEventListener("click", async () => {
    if (!currentFlow()?.id) return;
    if (!window.confirm("Delete this flow?")) return;

    try {
      await deleteDraft();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  el("flowSearch")?.addEventListener("input", renderFlowList);
  el("paletteSearch")?.addEventListener("input", renderPalette);
  
  const board = el("flowBoard");
  board?.addEventListener("click", () => {
    if (state.connecting) {
      state.connecting = null;
      state.connectionCursor = null;
      renderCanvas();
      setStatus("Connection cancelled.");
      return;
    }

    state.selectedNodeId = null;
    state.selectedEdgeId = null;
    renderInspector();
    renderCanvas();
    drawEdges();
  });

  window.addEventListener("mouseup", () => {
    if (!state.drag) return;
    state.drag = null;
    drawEdges();
  });

  el("flowBoardScroller")?.addEventListener("scroll", drawEdges);
  window.addEventListener("resize", drawEdges);

  window.addEventListener("beforeunload", (ev) => {
    if (!state.dirty) return;
    ev.preventDefault();
    ev.returnValue = "";
  });

  window.addEventListener("mousemove", (ev) => {
    if (state.connecting) {
      const board = el("flowBoard");
      if (board) {
        const rect = board.getBoundingClientRect();
        state.connectionCursor = {
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        };
        drawEdges();
      }
    }

    if (!state.drag) return;

    const flow = currentFlow();
    const node = flow?.nodes.find((item) => item.id === state.drag.nodeId);
    if (!node) return;

    const dx = ev.clientX - state.drag.startX;
    const dy = ev.clientY - state.drag.startY;
    node.x = Math.max(20, state.drag.originX + dx);
    node.y = Math.max(20, state.drag.originY + dy);

    markDirty();
    renderCanvas();
  });
}

async function init() {
  bindGlobalEvents();

  try {
    const catalog = await api("/api/flows/catalog");
    state.catalog = catalog;
    state.devices = Array.isArray(catalog?.devices) ? catalog.devices : [];

    await refreshFlows();

    state.draft = state.flows.length ? deepClone(state.flows[0]) : starterFlow();
    state.selectedSavedFlowId = state.draft.id || null;

    clearDirty();
    clearTestResult();
    renderPalette();
    renderAll();
  } catch (err) {
    setStatus(err.message || String(err), true);
    if (el("inspectorBody")) {
      el("inspectorBody").innerHTML = `<div class="emptyState">Failed to load flows UI: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

init();