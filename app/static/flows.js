const el = (id) => document.getElementById(id);

const state = {
  catalog: null,
  devices: [],
  flows: [],
  draft: null,
  sidebarSections: {
    saved: { expanded: true, touched: false },
    variables: { expanded: true, touched: false },
    palette: { expanded: true, touched: false },
  },
  publicVariables: [],
  publicVariablesDirty: false,
  publicVariablesInteracting: false,
  publicVariablesUpdatedAt: null,
  publicVariablesTimer: null,
  physicalState: null,
  physicalStateTimer: null,
  selectedSavedFlowId: null,
  selectedNodeId: null,
  selectedEdgeId: null,
  selectedPublicVariableIndex: null,
  dirty: false,
  connecting: null,
  connectionCursor: null,
  drag: null,
  pan: null,
  justPanned: false,
  topicCache: new Map(),
};

const SIDEBAR_SECTION_STATE_KEY = "flows.sidebarSections";

const CATEGORY_META = {
  trigger: { label: "Trigger", color: "#4f8cff" },
  condition: { label: "Condition", color: "#9c6bff" },
  operator: { label: "Operator", color: "#17b978" },
  action: { label: "Action", color: "#ff8c42" },
};

const DEFAULT_PHYSICAL_IO = {
  supported: false,
  available: false,
  error: null,
  digital_inputs: [1, 2, 3].map((channel) => ({ kind: "digital", channel: String(channel), label: `Digital input ${channel}` })),
  analog_inputs: [1, 2, 3].map((channel) => ({ kind: "analog", channel: String(channel), label: `Analog input ${channel}` })),
  outputs: [1, 2, 3].map((channel) => ({ kind: "output", channel: String(channel), label: `Output ${channel}` })),
  relays: [1].map((channel) => ({ kind: "relay", channel: String(channel), label: `Relay ${channel}` })),
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

function currentPublicVariables() {
  return state.publicVariables || [];
}

function currentSelectedPublicVariable() {
  const idx = state.selectedPublicVariableIndex;
  if (!Number.isInteger(idx) || idx < 0) return null;
  return currentPublicVariables()[idx] || null;
}

function clearEditorSelection() {
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedPublicVariableIndex = null;
  renderPublicVariablesSidebar();
}

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  state.selectedEdgeId = null;
  state.selectedPublicVariableIndex = null;
  renderPublicVariablesSidebar();
}

function selectEdge(edgeId) {
  state.selectedEdgeId = edgeId;
  state.selectedNodeId = null;
  state.selectedPublicVariableIndex = null;
  renderPublicVariablesSidebar();
}

function selectPublicVariable(index) {
  state.selectedPublicVariableIndex = Number.isInteger(index) && index >= 0 ? index : null;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.connecting = null;
  state.connectionCursor = null;
}

function normalizeVariableType(value) {
  const type = String(value || "string").trim().toLowerCase();
  return ["string", "number", "boolean", "json"].includes(type) ? type : "string";
}

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function publicVariableByKey(key) {
  const wanted = String(key || "").trim();
  return currentPublicVariables().find((item) => String(item.key || "").trim() === wanted) || null;
}

function normalizePublicVariableRecord(item = {}) {
  const normalized = { ...item };
  if (Object.prototype.hasOwnProperty.call(normalized, "current_value")) {
    normalized.value = normalized.current_value;
  }
  return normalized;
}

function normalizePublicVariableRecords(items = []) {
  return (items || []).map((item) => normalizePublicVariableRecord(item));
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
  const vars = currentPublicVariables();
  const options = [`<option value="">Select variable</option>`];
  for (const variable of vars) {
    options.push(
      `<option value="${escapeHtml(variable.key)}" ${variable.key === selected ? "selected" : ""}>${escapeHtml(variable.key)}</option>`
    );
  }
  return options.join("");
}

function variableTypeOptionsHtml(selected = "string") {
  return [
    ["string", "String"],
    ["number", "Number"],
    ["boolean", "Boolean"],
    ["json", "JSON"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === (selected || "string") ? "selected" : ""}>${label}</option>`)
    .join("");
}

function sourceOptionsHtml(selected = "literal", allowPhysicalInput = false) {
  const options = [
    ["literal", "Literal"],
    ["variable", "Variable"],
    ["trigger", "Trigger path"],
  ];

  if (allowPhysicalInput) {
    options.push(["physical_input", "Physical I/O"]);
  }

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

function physicalCatalog() {
  return state.catalog?.physical_io || DEFAULT_PHYSICAL_IO;
}

function physicalStateKey(kind) {
  const normalized = String(kind || "digital").trim().toLowerCase();
  if (normalized === "analog") return "analog_inputs";
  if (normalized === "output") return "outputs";
  if (normalized === "relay") return "relays";
  return "digital_inputs";
}

function physicalChannels(kind) {
  const key = physicalStateKey(kind);
  const items = physicalCatalog()?.[key];
  return Array.isArray(items) && items.length ? items : DEFAULT_PHYSICAL_IO[key];
}

function physicalInputKindOptionsHtml(selected = "digital") {
  return [
    ["digital", "Digital input"],
    ["analog", "Analog input"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function physicalValueSourceKindOptionsHtml(selected = "digital") {
  return [
    ["digital", "Digital input"],
    ["analog", "Analog input"],
    ["output", "Output"],
    ["relay", "Relay"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function physicalChannelOptionsHtml(kind, selected = "") {
  return physicalChannels(kind)
    .map((item) => `<option value="${escapeHtml(item.channel)}" ${String(item.channel) === String(selected) ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");
}

function physicalInputChannelOptionsHtml(kind, selected = "") {
  return physicalChannelOptionsHtml(kind, selected);
}

function physicalOutputOptionsHtml(selected = "") {
  return physicalChannelOptionsHtml("output", selected);
}

function physicalRelayOptionsHtml(selected = "") {
  return physicalChannelOptionsHtml("relay", selected);
}

function physicalTargetKindOptionsHtml(selected = "output") {
  return [
    ["output", "Output"],
    ["relay", "Relay"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function normalizePhysicalChannelSelection(kind, value) {
  const options = physicalChannels(kind);
  if (!options.length) return "";
  const wanted = String(value || "");
  const match = options.find((item) => String(item.channel) === wanted);
  return String((match || options[0]).channel);
}

function physicalEntry(kind, channel) {
  const key = physicalStateKey(kind);
  const items = state.physicalState?.[key];
  if (!Array.isArray(items)) return null;
  return items.find((item) => String(item.channel) === String(channel)) || null;
}

function physicalLabel(kind, channel) {
  return physicalEntry(kind, channel)?.label
    || physicalChannels(kind).find((item) => String(item.channel) === String(channel))?.label
    || `${kind} ${channel}`;
}

function formatPhysicalValue(kind, value) {
  if (value == null || value === "") {
    if (state.physicalState?.available === false && state.physicalState?.error) return "Unavailable";
    return "Loading...";
  }

  if (kind === "analog") {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)} V` : String(value);
  }

  if (kind === "output" || kind === "relay") {
    return Number(value) ? "On" : "Off";
  }

  return Number(value) ? "High" : "Low";
}

function formatPhysicalUpdatedTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return String(value);
  }
}

function physicalMetaText() {
  if (!state.physicalState) return "Loading physical I/O...";
  if (state.physicalState.available) {
    const updated = formatPhysicalUpdatedTime(state.physicalState.updated_at);
    return updated ? `Live value updated ${updated}` : "Live value available";
  }
  return state.physicalState.error || "Physical I/O unavailable.";
}

function physicalLiveValueText(kind, channel) {
  return formatPhysicalValue(kind, physicalEntry(kind, channel)?.value);
}

function formatAnalogThreshold(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function flowSummary(flow) {
  const nodes = flow.nodes || [];
  const triggers = nodes.filter((node) => node.category === "trigger").length;
  const conditions = nodes.filter((node) => node.category === "condition").length;
  const operators = nodes.filter((node) => node.category === "operator").length;
  const actions = nodes.filter((node) => node.category === "action").length;
  return `${triggers} trigger${triggers === 1 ? "" : "s"} · ${conditions} condition${conditions === 1 ? "" : "s"} · ${operators} operator${operators === 1 ? "" : "s"} · ${actions} action${actions === 1 ? "" : "s"}`;
}

function flowVariableLabel(key) {
  const raw = String(key || "").trim();
  return raw || "variable";
}

function displayNodeTitle(node) {
  if (!node) return "";
  const raw = String(node.label || "").trim();

  if (node.type === "condition.compare" && (!raw || raw === "Compare" || raw === "If")) {
    return "Compare";
  }

  return raw || "";
}

function compareOperatorLabel(value) {
  const map = {
    equals: "is",
    not_equals: "is not",
    contains: "contains",
    not_contains: "does not contain",
    greater_than: "is greater than",
    greater_than_or_equal: "is greater than or equal to",
    less_than: "is less than",
    less_than_or_equal: "is less than or equal to",
    is_true: "is true",
    is_false: "is false",
  };

  return map[value] || String(value || "is");
}

function compareSideLabel(source, value) {
  const src = String(source || "literal").trim().toLowerCase();
  const raw = String(value ?? "").trim();

  if (src === "variable") {
    return flowVariableLabel(raw);
  }

  if (src === "trigger") {
    return raw ? `trigger ${raw}` : "trigger value";
  }

  if (!raw) return "empty value";
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase();
  if (!Number.isNaN(Number(raw))) return raw;

  return `"${raw}"`;
}

function setVariableSourcePreview(cfg) {
  const source = String(cfg.value_source || "literal").trim().toLowerCase();

  if (source === "variable") {
    return flowVariableLabel(cfg.value || "");
  }

  if (source === "trigger") {
    return cfg.value ? `trigger ${cfg.value}` : "trigger value";
  }

  if (source === "physical_input") {
    const inputKind = String(cfg.value_input_kind || "digital").trim().toLowerCase();
    const channel = normalizePhysicalChannelSelection(inputKind, cfg.value_channel || "1");
    return `${physicalLabel(inputKind, channel)} (${physicalLiveValueText(inputKind, channel)})`;
  }

  const target = publicVariableByKey(cfg.variable_key || "");
  return compareSideLabel("literal", formatVariableValue(cfg.value, target?.type || "string"));
}

function displayPortLabel(node, kind, port) {
  if (node?.type === "condition.compare" && kind === "output") {
    if (port === "true") return "THEN";
    if (port === "false") return "ELSE";
  }

  return "";
}

function portUiLabel(nodeId, kind, handle) {
  const node = currentFlow()?.nodes.find((item) => item.id === nodeId);
  return displayPortLabel(node, kind, handle) || handle;
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

    case "trigger.digital_input_changed":
      return `When ${physicalLabel("digital", cfg.channel || "1")} changes · now ${physicalLiveValueText("digital", cfg.channel || "1")}`;

    case "trigger.analog_input_above":
      return `${physicalLabel("analog", cfg.channel || "1")} > ${formatAnalogThreshold(cfg.threshold)} V · now ${physicalLiveValueText("analog", cfg.channel || "1")}`;

    case "trigger.analog_input_below":
      return `${physicalLabel("analog", cfg.channel || "1")} < ${formatAnalogThreshold(cfg.threshold)} V · now ${physicalLiveValueText("analog", cfg.channel || "1")}`;

    case "trigger.physical_output_changed": {
      const targetKind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      const channel = cfg.channel || "1";
      return `When ${physicalLabel(targetKind, channel)} changes · now ${physicalLiveValueText(targetKind, channel)}`;
    }

    case "condition.compare": {
      const left = compareSideLabel(cfg.left_source || "variable", cfg.left_value || "");
      const operator = compareOperatorLabel(cfg.operator || "equals");

      if (cfg.operator === "is_true" || cfg.operator === "is_false") {
        return `If ${left} ${operator}`;
      }

      const right = compareSideLabel(cfg.right_source || "literal", cfg.right_value || "");
      return `If ${left} ${operator} ${right}`;
    }

    case "operator.delay":
      return `Wait ${cfg.seconds ?? 0}s`;

    case "operator.set_variable":
      return `${cfg.variable_key || "variable"} ← ${setVariableSourcePreview(cfg)}`;

    case "operator.template":
      return `${cfg.variable_key || "variable"} ← template`;

    case "operator.physical_input":
      return `${physicalLabel(cfg.input_kind || "digital", cfg.channel || "1")} = ${physicalLiveValueText(cfg.input_kind || "digital", cfg.channel || "1")}`;

    case "action.send_http_request":
      return `${cfg.method || "POST"} ${cfg.url || ""}`;

    case "action.activate_physical_output": {
      const targetKind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      const channel = cfg.channel || "1";
      return `${physicalLabel(targetKind, channel)} · ${cfg.mode || "pulse"}${cfg.mode === "pulse" ? ` for ${cfg.pulse_seconds || 0}s` : ""} · now ${physicalLiveValueText(targetKind, channel)}`;
    }

    case "action.activate_physical_relay":
      return `${physicalLabel("relay", cfg.channel || "1")} · ${cfg.mode || "pulse"}${cfg.mode === "pulse" ? ` for ${cfg.pulse_seconds || 0}s` : ""} · now ${physicalLiveValueText("relay", cfg.channel || "1")}`;

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
    nodes: [],
    edges: [],
  };
}

function centerBoardViewport() {
  const scroller = el("flowBoardScroller");
  const board = el("flowBoard");
  const nodesBox = el("flowNodes");

  if (!scroller || !board || !nodesBox) return;

  const nodeEls = [...nodesBox.querySelectorAll(".flowNode")];

  if (!nodeEls.length) {
    const left = Math.max(0, (board.scrollWidth - scroller.clientWidth) / 2);
    const top = Math.max(0, (board.scrollHeight - scroller.clientHeight) / 2);

    scroller.scrollLeft = left;
    scroller.scrollTop = top;
    drawEdges();
    return;
  }

  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;

  for (const nodeEl of nodeEls) {
    const left = nodeEl.offsetLeft;
    const top = nodeEl.offsetTop;
    const right = left + nodeEl.offsetWidth;
    const bottom = top + nodeEl.offsetHeight;

    if (left < minLeft) minLeft = left;
    if (top < minTop) minTop = top;
    if (right > maxRight) maxRight = right;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  const padding = 120;
  const contentCenterX = (minLeft + maxRight) / 2;
  const contentCenterY = (minTop + maxBottom) / 2;

  const maxScrollLeft = Math.max(0, board.scrollWidth - scroller.clientWidth);
  const maxScrollTop = Math.max(0, board.scrollHeight - scroller.clientHeight);

  const targetLeft = Math.min(
    maxScrollLeft,
    Math.max(0, contentCenterX - scroller.clientWidth / 2)
  );
  const targetTop = Math.min(
    maxScrollTop,
    Math.max(0, contentCenterY - scroller.clientHeight / 2)
  );

  scroller.scrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, targetLeft - padding / 2)
  );
  scroller.scrollTop = Math.max(
    0,
    Math.min(maxScrollTop, targetTop - padding / 2)
  );

  drawEdges();
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

  for (const buttonId of ["btnDeleteFlow", "btnInspectorDeleteFlow"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = !flow?.id;
    }
  }

  for (const buttonId of ["btnSaveFlow", "btnInspectorSaveFlow"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = !flow || !state.dirty;
    }
  }
}

function confirmDiscard() {
  if (!state.dirty) return true;
  return window.confirm("You have unsaved changes. Discard them?");
}

function loadSidebarSectionState() {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SECTION_STATE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    for (const [sectionId, section] of Object.entries(state.sidebarSections)) {
      if (typeof parsed[sectionId] !== "boolean") continue;
      section.expanded = parsed[sectionId];
      section.touched = true;
    }
  } catch {
    // Ignore invalid or unavailable local storage.
  }
}

function persistSidebarSectionState() {
  try {
    const payload = Object.fromEntries(
      Object.entries(state.sidebarSections).map(([sectionId, section]) => [sectionId, !!section.expanded])
    );
    window.localStorage.setItem(SIDEBAR_SECTION_STATE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore unavailable local storage.
  }
}

function sidebarSectionExpanded(sectionId, hasItems = true) {
  const section = state.sidebarSections[sectionId];
  if (!section) return true;
  return section.touched ? !!section.expanded : true;
}

function syncSidebarSection(sectionId, hasItems = true) {
  const block = document.querySelector(`[data-sidebar-section="${sectionId}"]`);
  if (!block) return;

  const expanded = sidebarSectionExpanded(sectionId, hasItems);
  block.dataset.hasItems = hasItems ? "true" : "false";
  block.classList.toggle("is-collapsed", !expanded);

  const toggle = block.querySelector("[data-sidebar-toggle]");
  if (!toggle) return;

  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function setSidebarSectionExpanded(sectionId, expanded) {
  const section = state.sidebarSections[sectionId];
  if (!section) return;
  section.expanded = !!expanded;
  section.touched = true;
  persistSidebarSectionState();
  syncSidebarSection(sectionId, document.querySelector(`[data-sidebar-section="${sectionId}"]`)?.dataset.hasItems !== "false");
}

function renderFlowList() {
  const q = (el("flowSearch")?.value || "").trim().toLowerCase();
  const activeFlow = currentFlow();
  const items = state.flows.filter((flow) => {
    if (!q) return true;
    return [flow.name, flowSummary(flow)].join(" ").toLowerCase().includes(q);
  }).filter((flow) => flow.id !== activeFlow?.id);

  const box = el("flowList");
  if (!box) return;

  syncSidebarSection("saved", Boolean(activeFlow) || items.length > 0);

  const activeSummary = activeFlow ? flowSummary(activeFlow) : "No flow selected.";
  const activeStatus = activeFlow?.enabled ? "Enabled" : "Disabled";
  const activeStatusClass = activeFlow?.enabled ? "enabled" : "disabled";
  const activeName = activeFlow?.name || "New flow";
  const activeId = activeFlow?.id ? `<div class="flowListItemMeta">${escapeHtml(activeSummary)}</div>` : `<div class="flowListItemMeta">Unsaved draft</div>`;

  box.innerHTML = `
    <div class="flowListItem flowListCurrent active" data-current-flow="true">
      <div class="flowListItemTop">
        <div>
          <div class="flowListItemName">${escapeHtml(activeName)}</div>
          ${activeId}
        </div>
        <div class="miniPill ${activeStatusClass}">${activeStatus}</div>
      </div>
      <div class="chipRow">
        <span class="miniPill">${activeFlow?.nodes?.length || 0} nodes</span>
        <span class="miniPill">${activeFlow?.edges?.length || 0} links</span>
      </div>
      <div class="flowListActions">
        <button class="btn btn-primary btn-compact" id="btnNewFlow" type="button">New</button>
        <button class="btn btn-compact" id="btnSaveFlow" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeleteFlow" type="button">Delete</button>
        <button class="btn btn-compact" id="btnDuplicateFlow" type="button">Duplicate</button>
      </div>
    </div>
    ${items.length ? items.map((flow) => `
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
      </div>
    </div>
  `).join("") : ""}
  `;

  bindFlowActionButtons();
  syncHeader();

  box.querySelector(".flowListCurrent")?.addEventListener("click", () => {
    clearEditorSelection();
    renderInspector();
    renderCanvas();
    drawEdges();
  });

  box.querySelectorAll(".flowListItem[data-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const flow = state.flows.find((item) => item.id === node.dataset.id);
      if (!flow) return;
      if (!confirmDiscard()) return;

      state.selectedSavedFlowId = flow.id;
      state.draft = deepClone(flow);
      clearEditorSelection();
      state.connecting = null;
      state.connectionCursor = null;

      clearDirty();
      clearTestResult();
      renderAll();
      window.requestAnimationFrame(centerBoardViewport);
      setStatus(`Loaded flow "${flow.name}".`);
    });
  });
}

function handleNewFlow() {
  if (!confirmDiscard()) return;

  state.selectedSavedFlowId = null;
  state.draft = starterFlow();
  clearEditorSelection();
  state.connecting = null;
  state.connectionCursor = null;

  clearDirty();
  clearTestResult();
  renderAll();
  window.requestAnimationFrame(centerBoardViewport);
  setStatus("Started a new flow.");
}

async function handleSaveFlow() {
  try {
    await saveFlow();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

async function handleDeleteFlow() {
  if (!currentFlow()?.id) return;
  if (!window.confirm("Delete this flow?")) return;

  try {
    await deleteDraft();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function bindFlowActionButtons() {
  el("btnNewFlow")?.addEventListener("click", (event) => {
    event.stopPropagation();
    handleNewFlow();
  });

  el("btnSaveFlow")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handleSaveFlow();
  });

  el("btnDuplicateFlow")?.addEventListener("click", (event) => {
    event.stopPropagation();
    duplicateDraft();
  });

  el("btnDeleteFlow")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handleDeleteFlow();
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

  syncSidebarSection("palette", groups.size > 0);

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
  selectNode(node.id);

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
            <div class="flowNodeLabel">${escapeHtml(displayNodeTitle(node) || node.label)}</div>
            <div class="flowNodeType">${escapeHtml(meta.label)}</div>
          </div>
          <span class="nodeBadge">${escapeHtml(meta.label)}</span>
        </div>

        <div class="flowNodePreview" data-node-preview-id="${escapeHtml(node.id)}">${escapeHtml(nodePreview(node))}</div>

        ${node.type === "trigger.manual" ? `
          <div class="mt-10">
            <button class="btn flowNodeRunBtn" type="button" data-run-node-id="${escapeHtml(node.id)}">Run</button>
          </div>
        ` : ""}

        <div class="flowNodePorts">
          <div class="portStack inputs">
            ${ports.inputs.map((port) => `
              <div class="flowPortRow input">
                <button class="flowPort ${state.connecting && state.connecting.nodeId === node.id && state.connecting.handle === port && state.connecting.kind === "input" ? "active" : ""}" type="button" data-port-kind="input" data-port-handle="${escapeHtml(port)}" data-node-id="${escapeHtml(node.id)}"></button>
                ${displayPortLabel(node, "input", port) ? `
                  <span class="flowBranchLabel neutral">${escapeHtml(displayPortLabel(node, "input", port))}</span>
                ` : ""}
              </div>
            `).join("")}
          </div>

          <div class="portStack outputs">
            ${ports.outputs.map((port) => `
              <div class="flowPortRow output">
                ${displayPortLabel(node, "output", port) ? `
                  <span class="flowBranchLabel ${port === "true" ? "then" : port === "false" ? "else" : "neutral"}">
                    ${escapeHtml(displayPortLabel(node, "output", port))}
                  </span>
                ` : ""}
                <button class="flowPort ${state.connecting && state.connecting.nodeId === node.id && state.connecting.handle === port && state.connecting.kind === "output" ? "active" : ""}" type="button" data-port-kind="output" data-port-handle="${escapeHtml(port)}" data-node-id="${escapeHtml(node.id)}"></button>
              </div>
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

      selectNode(nodeId);
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

      selectNode(nodeId);
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
        selectNode(nodeId);
        renderAll();

        const uiHandle = portUiLabel(nodeId, kind, handle);
        setStatus(
          kind === "input"
            ? `Connection started from input "${uiHandle}". Click an output port to finish.`
            : `Connection started from output "${uiHandle}". Click an input port to finish.`
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
        selectNode(nodeId);
        renderAll();

        const uiHandle = portUiLabel(nodeId, kind, handle);
        setStatus(
          kind === "input"
            ? `Connection restarted from input "${uiHandle}". Click an output port to finish.`
            : `Connection restarted from output "${uiHandle}". Click an input port to finish.`
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

  setPublicVariablesInteracting(false);

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
      el("inspectorSubtext").textContent = `${displayNodeTitle(node) || node.label} settings`;
    }

    box.innerHTML = renderNodeInspector(node);
    bindNodeInspector(node);
    return;
  }

  if (state.selectedPublicVariableIndex != null) {
    const variable = currentSelectedPublicVariable();
    if (!variable) {
      state.selectedPublicVariableIndex = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${flowVariableLabel(variable.key || `var_${state.selectedPublicVariableIndex + 1}`)} settings`;
    }

    box.innerHTML = renderPublicVariableInspector(variable, state.selectedPublicVariableIndex);
    bindPublicVariableInspector(state.selectedPublicVariableIndex);
    refreshPublicVariableRuntimeUi();
    return;
  }

  if (el("inspectorSubtext")) {
    el("inspectorSubtext").textContent = "Flow settings.";
  }

  box.innerHTML = renderFlowInspector(flow);
  bindFlowInspector(flow);
}

function renderPhysicalLiveField(kind, channel, label = "Current value") {
  return `
    <div class="full">
      <label>${escapeHtml(label)}</label>
      <input id="physicalCurrentValue" value="${escapeHtml(physicalLiveValueText(kind, channel))}" readonly />
    </div>
    <div class="full inlineMeta" id="physicalCurrentMeta">${escapeHtml(physicalMetaText())}</div>
  `;
}

function renderPhysicalSwitchActionInspector({
  title,
  targetKind = "output",
  channel,
  name,
  mode = "pulse",
  pulseSeconds = 2,
} = {}) {
  const selectedKind = targetKind === "relay" ? "relay" : "output";
  const selectedChannel = normalizePhysicalChannelSelection(selectedKind, channel || "1");
  const options = selectedKind === "relay"
    ? physicalRelayOptionsHtml(selectedChannel)
    : physicalOutputOptionsHtml(selectedChannel);
  const selectionLabel = selectedKind === "relay" ? "Relay" : "Output";
  const currentLabel = selectedKind === "relay" ? "Current relay state" : "Current output state";

  return `
    <div class="inspectorCard">
      <div class="inspectorTitle">${escapeHtml(title)}</div>
      <div class="fieldGrid">
        <div class="full">
          <label>Name</label>
          <input id="cfg_name" value="${escapeHtml(name || "")}" placeholder="Optional label" />
        </div>
        <div>
          <label>Target type</label>
          <select id="cfg_target_kind">${physicalTargetKindOptionsHtml(selectedKind)}</select>
        </div>
        <div>
          <label>${escapeHtml(selectionLabel)}</label>
          <select id="cfg_channel">${options}</select>
        </div>
        <div>
          <label>Mode</label>
          <select id="cfg_mode">
            <option value="on" ${mode === "on" ? "selected" : ""}>On</option>
            <option value="off" ${mode === "off" ? "selected" : ""}>Off</option>
            <option value="pulse" ${mode === "pulse" ? "selected" : ""}>Pulse</option>
          </select>
        </div>
        <div>
          <label>Pulse seconds</label>
          <input id="cfg_pulse_seconds" type="number" min="0.1" step="0.1" value="${escapeHtml(cfgValueOrDefault(pulseSeconds, 2))}" />
        </div>
        ${renderPhysicalLiveField(selectedKind, selectedChannel, currentLabel)}
      </div>
    </div>
  `;
}

function cfgValueOrDefault(value, fallback) {
  return value == null || value === "" ? fallback : value;
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
    <div class="inspectorCard inspectorActionsCard">
      <div class="inspectorActionHeader">
        <div class="inspectorTitle">Flow actions</div>
        <div class="inspectorHint">Create, save, duplicate, or remove this flow.</div>
      </div>
      <div class="inspectorActionGrid inspectorActionGrid--twoUp">
        <button class="btn btn-primary" id="btnInspectorNewFlow" type="button">New</button>
        <button class="btn" id="btnInspectorSaveFlow" type="button">Save</button>
        <button class="btn" id="btnInspectorDuplicateFlow" type="button">Duplicate</button>
        <button class="btn btn-danger" id="btnInspectorDeleteFlow" type="button">Delete</button>
      </div>
    </div>
  `;
}

function renderPublicVariableInspector(variable, index) {
  const variableType = normalizeVariableType(variable.type);
  const variableValue = variable.current_value ?? variable.value;

  return `
    <div class="inspectorCard">
      <div class="rowSplit">
        <div>
          <div class="inspectorTitle publicVariableInspectorName" style="margin-bottom:4px;">${escapeHtml(variable.key || `var_${index + 1}`)}</div>
          <div class="inspectorHint">Shared variable</div>
        </div>
      </div>
      <div id="publicVariableInspectorBody" class="fieldGrid mt-10" data-public-variable-index="${index}">
        <div>
          <label>Key</label>
          <input id="publicVariableKeyInput" value="${escapeHtml(variable.key || "")}" placeholder="var_1" />
        </div>
        <div>
          <label>Type</label>
          <select id="publicVariableTypeInput">${variableTypeOptionsHtml(variableType)}</select>
        </div>
        <div>
          <label>Value</label>
          ${renderVariableValueEditor({
            inputId: "publicVariableValueInput",
            value: variableValue,
            type: variableType,
            placeholder: variableType === "json" ? '{"key":"value"}' : "value",
            rows: 5,
          })}
        </div>
      </div>
    </div>
    <div class="inspectorCard inspectorActionsCard">
      <div class="inspectorActionHeader">
        <div class="inspectorTitle">Variable actions</div>
        <div class="inspectorHint">Create a new variable, save changes, or remove the selected variable.</div>
      </div>
      <div class="inspectorActionGrid">
        <button class="btn btn-primary" id="btnInspectorAddPublicVariable" type="button">New</button>
        <button class="btn" id="btnInspectorSavePublicVariables" type="button">Save</button>
        <button class="btn btn-danger" id="btnInspectorDeletePublicVariable" type="button">Delete</button>
      </div>
    </div>
  `;
}

function formatVariableValue(value, type) {
  const normalizedType = normalizeVariableType(type);

  if (normalizedType === "json") {
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value), null, 0);
      } catch {
        return value;
      }
    }

    try {
      return JSON.stringify(value ?? {}, null, 0);
    } catch {
      return "{}";
    }
  }

  if (normalizedType === "boolean") return parseBooleanLike(value) ? "true" : "false";
  return value == null ? "" : String(value);
}

function summarizeVariableValue(value, type) {
  const compact = formatVariableValue(value, type).replace(/\s+/g, " ").trim();
  if (!compact) return "Empty";
  return compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;
}

function renderVariableValueEditor({ inputId = "", inputClass = "", value = "", type = "string", placeholder = "value", readOnly = false, rows = 4 } = {}) {
  const normalizedType = normalizeVariableType(type);
  const idAttr = inputId ? ` id="${escapeHtml(inputId)}"` : "";
  const classAttr = inputClass ? ` class="${escapeHtml(inputClass)}"` : "";
  const readOnlyAttr = readOnly ? " readonly" : "";
  const disabledAttr = readOnly ? " disabled" : "";

  if (normalizedType === "boolean" && !readOnly) {
    const normalizedValue = formatVariableValue(value, normalizedType);
    return `
      <select${idAttr}${classAttr}>
        <option value="true" ${normalizedValue === "true" ? "selected" : ""}>True</option>
        <option value="false" ${normalizedValue === "false" ? "selected" : ""}>False</option>
      </select>
    `;
  }

  if (normalizedType === "number" && !readOnly) {
    return `<input${idAttr}${classAttr} type="number" step="any" value="${escapeHtml(formatVariableValue(value, normalizedType))}" placeholder="${escapeHtml(placeholder)}" />`;
  }

  if (normalizedType === "json") {
    return `<textarea${idAttr}${classAttr} rows="${rows}" placeholder="${escapeHtml(placeholder)}"${readOnlyAttr}>${escapeHtml(formatVariableValue(value, normalizedType))}</textarea>`;
  }

  return `<input${idAttr}${classAttr} value="${escapeHtml(formatVariableValue(value, normalizedType))}" placeholder="${escapeHtml(placeholder)}"${readOnlyAttr}${disabledAttr} />`;
}

function renderSetVariableValueControl(cfg) {
  const target = publicVariableByKey(cfg.variable_key || "");
  const targetType = normalizeVariableType(target?.type || "string");
  const valueSource = String(cfg.value_source || "literal").trim().toLowerCase();

  if (valueSource === "variable") {
    return `<select id="cfg_value">${variableKeyOptionsHtml(cfg.value || "")}</select>`;
  }

  if (valueSource === "trigger") {
    return `<input id="cfg_value" value="${escapeHtml(cfg.value || "")}" placeholder="trigger.path.to.value" list="variableKeysList" />`;
  }

  if (valueSource === "physical_input") {
    const inputKind = String(cfg.value_input_kind || "digital").trim().toLowerCase();
    const channel = normalizePhysicalChannelSelection(inputKind, cfg.value_channel || "1");
    const currentLabel = inputKind === "analog" ? "Current value" : "Current state";

    return `
      <div class="fieldGrid">
        <div>
          <label>Physical source</label>
          <select id="cfg_value_input_kind">${physicalValueSourceKindOptionsHtml(inputKind)}</select>
        </div>
        <div>
          <label>Channel</label>
          <select id="cfg_value_channel">${physicalInputChannelOptionsHtml(inputKind, channel)}</select>
        </div>
        ${renderPhysicalLiveField(inputKind, channel, currentLabel)}
      </div>
    `;
  }

  return renderVariableValueEditor({
    inputId: "cfg_value",
    value: cfg.value,
    type: targetType,
    placeholder: targetType === "json" ? '{"key":"value"}' : "literal value",
    rows: 5,
  });
}

function publicVariablesDefinitionFingerprint(items = []) {
  return JSON.stringify(
    (items || []).map((item) => [
      (item?.key || "").trim(),
      item?.type || "string",
      formatVariableValue(item?.value, item?.type),
    ])
  );
}

function syncPublicVariablesHeader() {
  for (const buttonId of ["btnSavePublicVariables", "btnInspectorSavePublicVariables"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = !state.publicVariablesDirty;
    }
  }

  for (const buttonId of ["btnDeletePublicVariable", "btnInspectorDeletePublicVariable"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = currentSelectedPublicVariable() == null;
    }
  }
}

function markPublicVariablesDirty() {
  state.publicVariablesDirty = true;
  syncPublicVariablesHeader();
}

function clearPublicVariablesDirty() {
  state.publicVariablesDirty = false;
  syncPublicVariablesHeader();
}

function setPublicVariablesInteracting(active) {
  state.publicVariablesInteracting = !!active;
}

function nextPublicVariableKey() {
  const existing = new Set(currentPublicVariables().map((item) => (item.key || "").trim()).filter(Boolean));
  let idx = currentPublicVariables().length + 1;
  while (existing.has(`var_${idx}`)) {
    idx += 1;
  }
  return `var_${idx}`;
}

function validatePublicVariables() {
  const keys = new Set();

  for (const variable of currentPublicVariables()) {
    const key = (variable.key || "").trim();
    if (!key) {
      throw new Error("Every public variable needs a key.");
    }
    if (keys.has(key)) {
      throw new Error(`Duplicate variable key: ${key}`);
    }
    keys.add(key);
  }
}

function serializePublicVariables() {
  return {
    items: currentPublicVariables().map((variable) => ({
      key: (variable.key || "").trim(),
      type: normalizeVariableType(variable.type),
      value: variable.value,
    })),
  };
}

function addPublicVariable() {
  state.publicVariables.push({
    key: nextPublicVariableKey(),
    type: "string",
    value: "",
    current_value: "",
  });

  if (el("variableSearch")) {
    el("variableSearch").value = "";
  }

  selectPublicVariable(currentPublicVariables().length - 1);
  setSidebarSectionExpanded("variables", true);
  markPublicVariablesDirty();
  renderPublicVariablesSidebar();
  renderInspector();
}

function removePublicVariable(index) {
  if (!currentPublicVariables()[index]) return;

  state.publicVariables.splice(index, 1);

  if (!currentPublicVariables().length) {
    state.selectedPublicVariableIndex = null;
  } else {
    state.selectedPublicVariableIndex = Math.min(index, currentPublicVariables().length - 1);
  }

  markPublicVariablesDirty();
  renderPublicVariablesSidebar();
  renderInspector();
}

function renderPublicVariablesSidebar() {
  const box = el("publicVariableList");
  if (!box) return;

  const q = (el("variableSearch")?.value || "").trim().toLowerCase();
  const selectedVariable = currentSelectedPublicVariable();
  const items = currentPublicVariables().map((variable, idx) => ({ variable, idx })).filter(({ variable, idx }) => {
    if (!q) return true;

    const type = normalizeVariableType(variable.type);
    const haystack = [
      variable.key || "",
      type,
      formatVariableValue(variable.current_value ?? variable.value, type),
    ].join(" ").toLowerCase();

    return haystack.includes(q);
  }).filter(({ idx }) => idx !== state.selectedPublicVariableIndex);

  syncPublicVariablesHeader();
  syncSidebarSection("variables", currentPublicVariables().length > 0);

  const currentType = normalizeVariableType(selectedVariable?.type);
  const currentValue = selectedVariable
    ? summarizeVariableValue(selectedVariable.current_value ?? selectedVariable.value, currentType)
    : "";
  const currentCard = selectedVariable
    ? `
    <div class="varCard is-preview varCardCurrent active">
      <div class="varCardTop">
        <div class="varCardName">${escapeHtml(flowVariableLabel(selectedVariable.key || `var_${state.selectedPublicVariableIndex + 1}`))}</div>
      </div>
      <div class="chipRow">
        <span class="miniPill">${escapeHtml(currentType)}</span>
        <span class="miniPill jsPublicVarCurrentPreview">${escapeHtml(currentValue)}</span>
      </div>
      <div class="sidebarCardActions">
        <button class="btn btn-primary btn-compact" id="btnAddPublicVariable" type="button">New</button>
        <button class="btn btn-compact" id="btnSavePublicVariables" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeletePublicVariable" type="button">Delete</button>
      </div>
    </div>`
    : `
    <div class="varCard varCardActionsOnly">
      <div class="sidebarCardActions is-standalone">
        <button class="btn btn-primary btn-compact" id="btnAddPublicVariable" type="button">New</button>
        <button class="btn btn-compact" id="btnSavePublicVariables" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeletePublicVariable" type="button">Delete</button>
      </div>
    </div>`;

  box.innerHTML = `
    ${currentCard}
    ${currentPublicVariables().length ? "" : `<div class="emptyState">No shared variables yet.</div>`}
    ${items.length ? items.map(({ variable, idx }) => {
    const variableType = normalizeVariableType(variable.type);
    const isActive = idx === state.selectedPublicVariableIndex;
    const currentValue = summarizeVariableValue(variable.current_value ?? variable.value, variableType);

    return `
      <button class="varCard is-preview ${isActive ? "active" : ""}" type="button" data-public-variable-index="${idx}" aria-pressed="${isActive ? "true" : "false"}">
        <div class="varCardTop">
          <div class="varCardName">${escapeHtml(variable.key || `var_${idx + 1}`)}</div>
        </div>
        <div class="chipRow">
          <span class="miniPill">${escapeHtml(variableType)}</span>
          <span class="miniPill jsPublicVarCurrentPreview">${escapeHtml(currentValue)}</span>
        </div>
      </button>
    `;
  }).join("") : ""}
  `;

  bindPublicVariableActionButtons();
  syncPublicVariablesHeader();

  box.querySelectorAll(".varCard.is-preview").forEach((card) => {
    if (card.classList.contains("varCardCurrent")) return;
    card.addEventListener("click", () => {
      const index = Number(card.dataset.publicVariableIndex || -1);
      if (!currentPublicVariables()[index]) return;
      selectPublicVariable(index);
      renderPublicVariablesSidebar();
      renderInspector();
      renderCanvas();
      drawEdges();
    });
  });

  refreshPublicVariableRuntimeUi();
}

function handleAddPublicVariable() {
  addPublicVariable();
}

async function handleSavePublicVariables() {
  try {
    await savePublicVariables();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function handleDeletePublicVariable() {
  if (state.selectedPublicVariableIndex == null) return;
  removePublicVariable(state.selectedPublicVariableIndex);
}

function bindPublicVariableActionButtons() {
  el("btnAddPublicVariable")?.addEventListener("click", (event) => {
    event.stopPropagation();
    handleAddPublicVariable();
  });

  el("btnSavePublicVariables")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handleSavePublicVariables();
  });

  el("btnDeletePublicVariable")?.addEventListener("click", (event) => {
    event.stopPropagation();
    handleDeletePublicVariable();
  });
}

function bindPublicVariableInspector(index) {
  const inspector = document.getElementById("publicVariableInspectorBody");
  const getVariable = () => currentPublicVariables()[index];

  document.getElementById("btnInspectorAddPublicVariable")?.addEventListener("click", () => {
    handleAddPublicVariable();
  });

  document.getElementById("btnInspectorSavePublicVariables")?.addEventListener("click", async () => {
    await handleSavePublicVariables();
  });

  document.getElementById("btnInspectorDeletePublicVariable")?.addEventListener("click", () => {
    handleDeletePublicVariable();
  });

  inspector?.addEventListener("focusin", () => {
    setPublicVariablesInteracting(true);
  });

  inspector?.addEventListener("focusout", (ev) => {
    const nextTarget = ev.relatedTarget;
    const currentTarget = ev.currentTarget;
    if (nextTarget instanceof Node && currentTarget instanceof Node && currentTarget.contains(nextTarget)) {
      return;
    }
    setPublicVariablesInteracting(false);
  });

  document.getElementById("publicVariableKeyInput")?.addEventListener("input", (ev) => {
    const variable = getVariable();
    if (!variable) return;
    variable.key = ev.target.value.trim();
    markPublicVariablesDirty();
    renderPublicVariablesSidebar();

    const title = document.querySelector(".publicVariableInspectorName");
    if (title) title.textContent = variable.key || `var_${index + 1}`;
    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${flowVariableLabel(variable.key || `var_${index + 1}`)} settings`;
    }
  });

  const syncVariableType = (value) => {
    const variable = getVariable();
    if (!variable) return;

    const nextType = normalizeVariableType(value);
    if (normalizeVariableType(variable.type) === nextType) return;

    variable.type = nextType;
    markPublicVariablesDirty();
    renderPublicVariablesSidebar();
    renderInspector();
  };

  document.getElementById("publicVariableTypeInput")?.addEventListener("input", (ev) => {
    syncVariableType(ev.target.value);
  });

  document.getElementById("publicVariableTypeInput")?.addEventListener("change", (ev) => {
    syncVariableType(ev.target.value);
  });

  const applyDefaultValue = (value) => {
    const variable = getVariable();
    if (!variable) return;
    variable.value = value;
    variable.current_value = value;
    markPublicVariablesDirty();
    renderPublicVariablesSidebar();
  };

  document.getElementById("publicVariableValueInput")?.addEventListener("input", (ev) => {
    applyDefaultValue(ev.target.value);
  });

  document.getElementById("publicVariableValueInput")?.addEventListener("change", (ev) => {
    applyDefaultValue(ev.target.value);
  });
}

function refreshPublicVariableRuntimeUi() {
  syncPublicVariablesHeader();

  document.querySelectorAll("#publicVariableList .varCard").forEach((row) => {
    const idx = Number(row.dataset.publicVariableIndex || -1);
    const variable = currentPublicVariables()[idx];
    if (!variable) return;

    const currentPreview = row.querySelector(".jsPublicVarCurrentPreview");
    if (currentPreview) {
      currentPreview.textContent = summarizeVariableValue(variable.current_value ?? variable.value, variable.type);
    }
  });

  if (state.publicVariablesInteracting) {
    return;
  }

  const selectedVariable = currentSelectedPublicVariable();
  const valueInput = document.getElementById("publicVariableValueInput");
  if (selectedVariable && valueInput) {
    valueInput.value = formatVariableValue(selectedVariable.current_value ?? selectedVariable.value, selectedVariable.type);
  }
}

function bindFlowInspector(flow) {
  document.getElementById("btnInspectorNewFlow")?.addEventListener("click", () => {
    handleNewFlow();
  });

  document.getElementById("btnInspectorSaveFlow")?.addEventListener("click", async () => {
    await handleSaveFlow();
  });

  document.getElementById("btnInspectorDeleteFlow")?.addEventListener("click", async () => {
    await handleDeleteFlow();
  });

  document.getElementById("btnInspectorDuplicateFlow")?.addEventListener("click", () => {
    duplicateDraft();
  });

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
}

function renderNodeInspector(node) {
  const cfg = node.config || {};
  const common = `
    <div class="inspectorCard">
      <div class="inspectorTitle">${escapeHtml(displayNodeTitle(node) || node.label)}</div>
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

    case "trigger.digital_input_changed":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Digital input trigger</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Input</label>
              <select id="cfg_channel">${physicalChannelOptionsHtml("digital", cfg.channel || "1")}</select>
            </div>
            ${renderPhysicalLiveField("digital", cfg.channel || "1", "Current state")}
          </div>
        </div>
      `;
      break;

    case "trigger.analog_input_above":
    case "trigger.analog_input_below":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Analog threshold trigger</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Input</label>
              <select id="cfg_channel">${physicalChannelOptionsHtml("analog", cfg.channel || "1")}</select>
            </div>
            <div>
              <label>Threshold (V)</label>
              <input id="cfg_threshold" type="number" step="0.01" value="${escapeHtml(cfg.threshold ?? 1)}" />
            </div>
            ${renderPhysicalLiveField("analog", cfg.channel || "1", "Current voltage")}
          </div>
        </div>
      `;
      break;

    case "trigger.physical_output_changed": {
      const targetKind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      const channel = normalizePhysicalChannelSelection(targetKind, cfg.channel || "1");
      const channelLabel = targetKind === "relay" ? "Relay" : "Output";
      const currentLabel = targetKind === "relay" ? "Current relay state" : "Current output state";

      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Physical output trigger</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Target type</label>
              <select id="cfg_target_kind">${physicalTargetKindOptionsHtml(targetKind)}</select>
            </div>
            <div>
              <label>${channelLabel}</label>
              <select id="cfg_channel">${targetKind === "relay" ? physicalRelayOptionsHtml(channel) : physicalOutputOptionsHtml(channel)}</select>
            </div>
            ${renderPhysicalLiveField(targetKind, channel, currentLabel)}
          </div>
        </div>
      `;
      break;
    }

    case "condition.compare":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Compare</div>
          <div class="inspectorHint">Checks a condition, then follows THEN when it passes or ELSE when it fails.</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Compare source</label>
              <select id="cfg_left_source">${sourceOptionsHtml(cfg.left_source || "variable")}</select>
            </div>
            <div>
              <label>Compare value / path</label>
              <input id="cfg_left_value" value="${escapeHtml(cfg.left_value || "")}" placeholder="armed or extra.changed.IsMotion" list="variableKeysList" />
            </div>
            <div>
              <label>Operator</label>
              <select id="cfg_operator">${compareOperatorOptionsHtml(cfg.operator || "equals")}</select>
            </div>
            <div>
              <label>Cast as</label>
              <select id="cfg_cast">${castOptionsHtml(cfg.cast || "auto")}</select>
            </div>
            <div>
              <label>Compare to source</label>
              <select id="cfg_right_source">${sourceOptionsHtml(cfg.right_source || "literal")}</select>
            </div>
            <div>
              <label>Compare to value / path</label>
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
              <select id="cfg_value_source">${sourceOptionsHtml(cfg.value_source || "literal", true)}</select>
            </div>
            <div class="full">
              <label>Value</label>
              ${renderSetVariableValueControl(cfg)}
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

    case "operator.physical_input":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Physical input</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Input type</label>
              <select id="cfg_input_kind">${physicalInputKindOptionsHtml(cfg.input_kind || "digital")}</select>
            </div>
            <div>
              <label>Input</label>
              <select id="cfg_channel">${physicalInputChannelOptionsHtml(cfg.input_kind || "digital", cfg.channel || "1")}</select>
            </div>
            ${renderPhysicalLiveField(cfg.input_kind || "digital", cfg.channel || "1")}
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

    case "action.activate_physical_output":
    case "action.activate_physical_relay":
      body = renderPhysicalSwitchActionInspector({
        title: "Physical output",
        targetKind: node.type === "action.activate_physical_relay"
          ? "relay"
          : (String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output"),
        channel: cfg.channel || "1",
        name: cfg.name || "",
        mode: cfg.mode || "pulse",
        pulseSeconds: cfg.pulse_seconds ?? 2,
      });
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
      ${currentPublicVariables().map((variable) => `<option value="${escapeHtml(variable.key)}"></option>`).join("")}
    </datalist>
    ${body}
    <div class="inspectorCard inspectorActionsCard inspectorActionsCard--danger">
      <div class="inspectorActionHeader">
        <div class="inspectorTitle">Node actions</div>
        <div class="inspectorHint">Remove this node and its connections from the flow.</div>
      </div>
      <div class="inspectorActionGrid inspectorActionGrid--single">
        <button class="btn btn-danger" id="btnDeleteNode" type="button">Delete node</button>
      </div>
    </div>
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
    renderInspector();
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

  if (node.type === "operator.physical_input") {
    document.getElementById("cfg_input_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (node.type === "trigger.physical_output_changed") {
    document.getElementById("cfg_target_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (node.type === "action.activate_physical_output" || node.type === "action.activate_physical_relay") {
    document.getElementById("cfg_target_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (node.type === "operator.set_variable") {
    document.getElementById("cfg_variable_key")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_value_source")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_value_input_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
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
    case "trigger.digital_input_changed":
      set("name");
      set("channel");
      break;
    case "trigger.analog_input_above":
    case "trigger.analog_input_below":
      set("name");
      set("channel");
      set("threshold");
      break;
    case "trigger.physical_output_changed":
      set("name");
      set("target_kind");
      set("channel");
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
      set("value_input_kind");
      set("value_channel");
      break;
    case "operator.template":
      set("name");
      set("variable_key");
      set("template");
      break;
    case "operator.physical_input":
      set("name");
      set("input_kind");
      set("channel");
      break;
    case "action.send_http_request":
      set("name");
      set("method");
      set("timeout_seconds");
      set("url");
      set("headers");
      set("body");
      break;
    case "action.activate_physical_output":
    case "action.activate_physical_relay":
      set("name");
      set("target_kind");
      set("channel");
      set("mode");
      set("pulse_seconds");
      break;
    case "action.log_message":
      set("name");
      set("message");
      break;
  }

  if (node.type === "trigger.incoming_http_request") {
    cfg.path = normalizePath(cfg.path || "");
  }

  if (node.type === "operator.physical_input") {
    cfg.input_kind = cfg.input_kind || "digital";
    cfg.channel = normalizePhysicalChannelSelection(cfg.input_kind, cfg.channel || "1");
  }

  if (node.type === "operator.set_variable" && cfg.value_source === "physical_input") {
    cfg.value_input_kind = cfg.value_input_kind || "digital";
    cfg.value_channel = normalizePhysicalChannelSelection(cfg.value_input_kind, cfg.value_channel || "1");
  }

  if (node.type === "trigger.digital_input_changed") {
    cfg.channel = normalizePhysicalChannelSelection("digital", cfg.channel || "1");
  }

  if (node.type === "trigger.analog_input_above" || node.type === "trigger.analog_input_below") {
    cfg.channel = normalizePhysicalChannelSelection("analog", cfg.channel || "1");
  }

  if (node.type === "trigger.physical_output_changed") {
    cfg.target_kind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
    cfg.channel = normalizePhysicalChannelSelection(cfg.target_kind, cfg.channel || "1");
  }

  if (node.type === "action.activate_physical_output") {
    cfg.target_kind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
    cfg.channel = normalizePhysicalChannelSelection(cfg.target_kind, cfg.channel || "1");
  }

  if (node.type === "action.activate_physical_relay") {
    cfg.target_kind = "relay";
    cfg.channel = normalizePhysicalChannelSelection("relay", cfg.channel || "1");
  }

  markDirty();
  renderCanvas();
  drawEdges();
  refreshPhysicalUi();
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

function refreshPhysicalNodePreviews() {
  const flow = currentFlow();
  if (!flow) return;

  for (const node of flow.nodes || []) {
    const preview = document.querySelector(`.flowNodePreview[data-node-preview-id="${CSS.escape(node.id)}"]`);
    if (!preview) continue;
    preview.textContent = nodePreview(node);
  }
}

function refreshPhysicalInspectorLiveValues() {
  const flow = currentFlow();
  if (!flow || !state.selectedNodeId) return;

  const node = flow.nodes.find((item) => item.id === state.selectedNodeId);
  if (!node) return;

  let kind = null;
  let channel = null;
  let labelText = "Current value";
  const cfg = node.config || {};

  switch (node.type) {
    case "operator.physical_input":
      kind = cfg.input_kind || "digital";
      channel = cfg.channel || "1";
      labelText = "Current value";
      break;
    case "operator.set_variable":
      if (cfg.value_source === "physical_input") {
        kind = cfg.value_input_kind || "digital";
        channel = cfg.value_channel || "1";
        labelText = kind === "analog" ? "Current value" : "Current state";
      }
      break;
    case "trigger.digital_input_changed":
      kind = "digital";
      channel = cfg.channel || "1";
      labelText = "Current state";
      break;
    case "trigger.analog_input_above":
    case "trigger.analog_input_below":
      kind = "analog";
      channel = cfg.channel || "1";
      labelText = "Current voltage";
      break;
    case "trigger.physical_output_changed":
      kind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      channel = cfg.channel || "1";
      labelText = kind === "relay" ? "Current relay state" : "Current output state";
      break;
    case "action.activate_physical_output":
      kind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      channel = cfg.channel || "1";
      labelText = kind === "relay" ? "Current relay state" : "Current output state";
      break;
    default:
      break;
  }

  const input = document.getElementById("physicalCurrentValue");
  if (input && kind && channel) {
    input.value = physicalLiveValueText(kind, channel);
    input.setAttribute("aria-label", labelText);
  }

  const meta = document.getElementById("physicalCurrentMeta");
  if (meta) {
    meta.textContent = physicalMetaText();
  }
}

function refreshPhysicalUi() {
  refreshPhysicalNodePreviews();
  refreshPhysicalInspectorLiveValues();
}

async function refreshPublicVariables(silent = true) {
  try {
    const data = await api("/api/public-variables");
    const incoming = normalizePublicVariableRecords(Array.isArray(data?.items) ? data.items : []);
    const incomingFingerprint = publicVariablesDefinitionFingerprint(incoming);
    const currentFingerprint = publicVariablesDefinitionFingerprint(state.publicVariables);

    state.publicVariablesUpdatedAt = data?.updated_at || null;

    const liveByKey = new Map(
      incoming.map((item) => [item.key, item.current_value])
    );

    if (state.publicVariablesDirty || state.publicVariablesInteracting) {
      refreshPublicVariableRuntimeUi();
      return;
    }

    if (incomingFingerprint !== currentFingerprint) {
      state.publicVariables = incoming;
      renderPublicVariablesSidebar();
      renderInspector();
      return;
    }

    // Same definitions, only refresh runtime values in place.
    // Keeping the same objects avoids stale event-handler references.
    for (const item of state.publicVariables) {
      if (liveByKey.has(item.key)) {
        const nextValue = liveByKey.get(item.key);
        item.current_value = nextValue;
        item.value = nextValue;
      }
    }

    refreshPublicVariableRuntimeUi();
  } catch (err) {
    if (!silent) {
      setStatus(err.message || String(err), true);
    }
  }
}

function startPublicVariablesPolling() {
  if (state.publicVariablesTimer) {
    window.clearInterval(state.publicVariablesTimer);
  }

  state.publicVariablesTimer = window.setInterval(() => {
    refreshPublicVariables(true).catch(() => { });
  }, 1000);
}

async function savePublicVariables() {
  validatePublicVariables();

  const out = await api("/api/public-variables", {
    method: "PUT",
    body: JSON.stringify(serializePublicVariables()),
  });

  state.publicVariables = normalizePublicVariableRecords(Array.isArray(out?.items) ? out.items : []);
  state.publicVariablesUpdatedAt = out?.updated_at || null;
  clearPublicVariablesDirty();
  renderPublicVariablesSidebar();
  renderInspector();
  setStatus("Public variables saved.");
}

async function refreshPhysicalState(silent = true) {
  try {
    state.physicalState = await api("/api/physical-io/state");
    refreshPhysicalUi();
  } catch (err) {
    state.physicalState = {
      ...DEFAULT_PHYSICAL_IO,
      available: false,
      error: err.message || String(err),
    };
    refreshPhysicalUi();
    if (!silent) {
      setStatus(err.message || String(err), true);
    }
  }
}

function startPhysicalStatePolling() {
  if (state.physicalStateTimer) {
    window.clearInterval(state.physicalStateTimer);
  }

  state.physicalStateTimer = window.setInterval(() => {
    refreshPhysicalState(true).catch(() => { });
  }, 1000);
}

function renderAll() {
  renderFlowList();
  syncHeader();
  renderPublicVariablesSidebar();
  renderCanvas();
  renderInspector();
  refreshPhysicalUi();
  refreshPublicVariableRuntimeUi();
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

    let out = null;

    if (flow.id) {
      out = await api(`/api/flows/run-manual/${encodeURIComponent(flow.id)}`, {
        method: "POST",
        body: JSON.stringify({
          trigger_node_id: node.id,
          trigger_payload: {},
        }),
      });

      showTestResult(out.result);
      await refreshPublicVariables(true);
      setTestStatus(`Manual trigger "${node.label}" executed with persisted runtime state.`);
      setStatus(`Manual trigger "${node.label}" executed with persisted runtime state.`);
      return;
    }

    out = await api(`/api/flows/test`, {
      method: "POST",
      body: JSON.stringify({
        flow_id: null,
        flow: serializeFlow(flow),
        trigger_node_id: node.id,
        trigger_payload: {},
      }),
    });

    showTestResult(out.result);
    setTestStatus(`Manual trigger "${node.label}" executed against the current draft (stateless test).`);
    setStatus(`Manual trigger "${node.label}" executed against the current draft (stateless test).`);
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
  clearEditorSelection();
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
  clearEditorSelection();
  state.connecting = null;
  state.connectionCursor = null;

  clearDirty();
  clearTestResult();
  renderAll();
  setStatus("Flow deleted.");
}

function bindGlobalEvents() {
  document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const sectionId = button.dataset.sidebarToggle;
      const block = sectionId ? document.querySelector(`[data-sidebar-section="${sectionId}"]`) : null;
      const hasItems = block?.dataset.hasItems !== "false";
      if (!sectionId || !block) return;
      setSidebarSectionExpanded(sectionId, !sidebarSectionExpanded(sectionId, hasItems));
    });
  });

  el("flowSearch")?.addEventListener("input", renderFlowList);
  el("variableSearch")?.addEventListener("input", renderPublicVariablesSidebar);
  el("paletteSearch")?.addEventListener("input", renderPalette);

  const boardScroller = el("flowBoardScroller");
  boardScroller?.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (state.connecting) return;

    if (
      ev.target.closest?.(".flowNode") ||
      ev.target.closest?.(".flowPort") ||
      ev.target.closest?.(".flowNodeRunBtn") ||
      ev.target.closest?.(".flowEdgeHitArea")
    ) {
      return;
    }

    state.pan = {
      startX: ev.clientX,
      startY: ev.clientY,
      scrollLeft: boardScroller.scrollLeft,
      scrollTop: boardScroller.scrollTop,
      moved: false,
    };

    boardScroller.classList.add("panning");
    ev.preventDefault();
  });

  const board = el("flowBoard");
  board?.addEventListener("click", () => {
    if (state.justPanned) {
      state.justPanned = false;
      return;
    }

    if (state.connecting) {
      state.connecting = null;
      state.connectionCursor = null;
      renderCanvas();
      setStatus("Connection cancelled.");
      return;
    }

    clearEditorSelection();
    renderPublicVariablesSidebar();
    renderInspector();
    renderCanvas();
    drawEdges();
  });

  window.addEventListener("mouseup", () => {
    const boardScroller = el("flowBoardScroller");

    if (state.pan) {
      const moved = state.pan.moved;
      state.pan = null;
      boardScroller?.classList.remove("panning");

      if (moved) {
        state.justPanned = true;
        window.setTimeout(() => {
          state.justPanned = false;
        }, 0);
      }

      drawEdges();
      return;
    }

    if (!state.drag) return;
    state.drag = null;
    drawEdges();
  });

  el("flowBoardScroller")?.addEventListener("scroll", drawEdges);
  window.addEventListener("resize", drawEdges);

  window.addEventListener("beforeunload", (ev) => {
    if (!state.dirty && !state.publicVariablesDirty) return;
    ev.preventDefault();
    ev.returnValue = "";
  });

  window.addEventListener("mousemove", (ev) => {
    if (state.pan) {
      const boardScroller = el("flowBoardScroller");
      if (!boardScroller) return;

      const dx = ev.clientX - state.pan.startX;
      const dy = ev.clientY - state.pan.startY;

      boardScroller.scrollLeft = state.pan.scrollLeft - dx;
      boardScroller.scrollTop = state.pan.scrollTop - dy;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        state.pan.moved = true;
      }

      drawEdges();
      return;
    }

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
  loadSidebarSectionState();
  bindGlobalEvents();

  try {
    const catalog = await api("/api/flows/catalog");
    state.catalog = catalog;
    state.devices = Array.isArray(catalog?.devices) ? catalog.devices : [];

    await refreshFlows();
    await refreshPublicVariables(true);
    await refreshPhysicalState(true);
    startPublicVariablesPolling();
    startPhysicalStatePolling();

    state.draft = state.flows.length ? deepClone(state.flows[0]) : starterFlow();
    state.selectedSavedFlowId = state.draft.id || null;

    clearDirty();
    clearPublicVariablesDirty();
    clearTestResult();
    renderPalette();
    renderAll();
    window.requestAnimationFrame(centerBoardViewport);
  } catch (err) {
    setStatus(err.message || String(err), true);
    if (el("inspectorBody")) {
      el("inspectorBody").innerHTML = `<div class="emptyState">Failed to load flows UI: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

init();