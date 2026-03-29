const el = (id) => document.getElementById(id);

const state = {
  devices: [],
  rules: [],
  selectedRuleId: null,
  isDirty: false,
  suspendDirty: false,
  topicCache: new Map(),
};

const TRIGGER_DEFS = {
  onvif_event: {
    label: "ONVIF event",
    needsTopic: true,
    needsDevice: true,
    summarize(data) {
      const device = deviceLabel(data.device_id);
      if (data.name) return data.name;
      if (data.topic) return `When ${device} emits ${data.topic}`;
      return `When ${device} emits a selected ONVIF topic`;
    },
  },

  device_offline: {
    label: "Device offline",
    needsTopic: false,
    needsDevice: true,
    summarize(data) {
      const device = deviceLabel(data.device_id);
      if (data.name) return data.name;
      return `When ${device} goes offline`;
    },
  },

  device_back_online: {
    label: "Device back online",
    needsTopic: false,
    needsDevice: true,
    summarize(data) {
      const device = deviceLabel(data.device_id);
      if (data.name) return data.name;
      return `When ${device} comes back online`;
    },
  },

  incoming_http_request: {
    label: "Incoming HTTP request",
    needsTopic: false,
    needsDevice: false,
    summarize(data) {
      if (data.name) return data.name;
      const method = data.method || "ANY";
      const path = normalizeWebhookPath(data.path || "/");
      return `When HTTP ${method} ${path} is received`;
    },
  },
};

const ACTION_DEFS = {
  activate_output_relay: {
    label: "Activate local output relay",
    summarize(data) {
      if (data.name) return data.name;
      if (data.mode === "on") return "Turn on local output relay";
      if (data.mode === "off") return "Turn off local output relay";
      if (data.mode === "pulse") {
        return `Activate local output relay for ${data.activation_seconds ?? "?"}s`;
      }
      return "Activate local output relay";
    },
  },

  wait_for: {
    label: "Wait for",
    summarize(data) {
      if (data.name) return data.name;
      return `Wait for ${data.seconds ?? "?"}s`;
    },
  },

  send_http_request: {
    label: "Send HTTP request",
    summarize(data) {
      if (data.name) return data.name;
      return `Send ${data.method || "POST"} request to ${data.url || "?"}`;
    },
  },
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

function setStatus(message, isBad = false) {
  const node = el("formStatus");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isBad ? "var(--danger)" : "var(--muted)";
}

function setListStatus(message, isBad = false) {
  const node = el("listStatus");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = isBad ? "var(--danger)" : "var(--muted)";
}

function markDirty() {
  if (state.suspendDirty) return;
  state.isDirty = true;
  syncEditorMode();
}

function clearDirty() {
  state.isDirty = false;
  syncEditorMode();
}

function syncEditorMode() {
  const title = el("formTitle");
  const mode = el("editorModeText");
  const del = el("btnDelete");

  if (title) {
    title.textContent = state.selectedRuleId ? "Edit rule" : "New rule";
  }

  if (mode) {
    if (state.selectedRuleId) {
      mode.textContent = state.isDirty
        ? "Editing existing rule · unsaved changes."
        : "Editing existing rule.";
    } else {
      mode.textContent = state.isDirty
        ? "New rule · unsaved changes."
        : "Create a new rule.";
    }
  }

  if (del) {
    del.disabled = !state.selectedRuleId;
  }
}

function syncRuleEnabledLabel() {
  const input = el("ruleEnabled");
  const label = el("ruleEnabledText");
  if (!input || !label) return;
  label.textContent = input.checked ? "Enabled" : "Disabled";
}

function deviceById(id) {
  return state.devices.find((d) => d.id === id) || null;
}

function deviceLabel(id) {
  const device = deviceById(id);
  if (device) return device.name;
  return id || "Unknown device";
}

function deviceOptionsHtml(selected = "") {
  const options = [
    `<option value="">Select device</option>`,
    ...state.devices.map((d) => `
      <option value="${escapeHtml(d.id)}" ${d.id === selected ? "selected" : ""}>
        ${escapeHtml(d.name)}
      </option>
    `),
  ];

  return options.join("");
}

function getTriggerDef(type) {
  return TRIGGER_DEFS[type] || {
    label: type || "Unknown trigger",
    needsTopic: false,
    needsDevice: false,
    summarize(data) {
      return data?.name || data?.type || "Unknown trigger";
    },
  };
}

function getActionDef(type) {
  return ACTION_DEFS[type] || {
    label: type || "Unknown action",
    summarize(data) {
      return data?.name || data?.type || "Unknown action";
    },
  };
}

function summarizeCondition(condition) {
  return getTriggerDef(condition?.type).summarize(condition || {});
}

function summarizeAction(action) {
  return getActionDef(action?.type).summarize(action || {});
}

function ruleSentence(rule) {
  const left = (rule.conditions || []).map(summarizeCondition).join(" or ") || "When something happens";
  const right = (rule.actions || []).map(summarizeAction).join(", then ");
  return right ? `${left}, then ${right}.` : `${left}.`;
}

function confirmDiscardIfDirty() {
  if (!state.isDirty) return true;
  return window.confirm("You have unsaved changes. Discard them?");
}

function setItemOpen(card, open) {
  const btn = card.querySelector(".itemCollapseBtn");
  const body = card.querySelector(".itemCollapseBody");
  if (!btn || !body) return;

  btn.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", String(open));
  body.classList.toggle("open", open);
}

function bindItemCollapse(card, initialOpen = false) {
  const btn = card.querySelector(".itemCollapseBtn");
  if (!btn) return;

  const toggle = () => {
    const isOpen = btn.classList.contains("open");
    setItemOpen(card, !isOpen);
  };

  btn.addEventListener("click", (ev) => {
    if (ev.target.closest(".itemHeadActions .btn")) return;
    toggle();
  });

  btn.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    toggle();
  });

  setItemOpen(card, initialOpen);
}

function parseHeadersJson(text) {
  const raw = (text || "").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }
  return parsed;
}

function randomWebhookToken() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function generateWebhookPath() {
  return `/webhook/${randomWebhookToken()}`;
}

function normalizeWebhookPath(value) {
  let raw = (value || "").trim();
  if (!raw) return "";
  raw = raw.split("?", 1)[0].trim();
  if (!raw.startsWith("/")) raw = `/${raw}`;
  const parts = raw.split("/").filter(Boolean);
  return parts.length ? `/${parts.join("/")}` : "/";
}

function buildWebhookUrl(path) {
  const clean = normalizeWebhookPath(path);
  if (!clean) return "";
  if (clean === "/") return `${window.location.origin}/hook`;
  return `${window.location.origin}/hook${clean}`;
}

async function copyTextToClipboard(text) {
  if (!text) return false;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const temp = document.createElement("textarea");
  temp.value = text;
  temp.setAttribute("readonly", "");
  temp.style.position = "absolute";
  temp.style.left = "-9999px";
  document.body.appendChild(temp);
  temp.select();

  let ok = false;
  try {
    ok = document.execCommand("copy");
  } finally {
    document.body.removeChild(temp);
  }

  return ok;
}

function ensureGeneratedWebhookPath(card) {
  const type = card.querySelector(".condType")?.value;
  const input = card.querySelector(".httpPath");
  if (!input || type !== "incoming_http_request") return;

  if (!(input.value || "").trim()) {
    input.value = generateWebhookPath();
  }
}

function updateConditionWebhookUi(card) {
  const pathInput = card.querySelector(".httpPath");
  const urlPreview = card.querySelector(".httpUrlPreview");
  const copyBtn = card.querySelector(".btnCopyHttpUrl");
  if (!pathInput || !urlPreview) return;

  const url = buildWebhookUrl(pathInput.value);
  urlPreview.value = url;
  if (copyBtn) copyBtn.disabled = !url;
}

function getConditionErrors(card) {
  const type = card.querySelector(".condType").value;
  const def = getTriggerDef(type);
  const deviceId = card.querySelector(".condDevice").value;
  const topic = card.dataset.topic || "";
  const errors = [];

  if (def.needsDevice && !deviceId) errors.push("Select a device.");
  if (def.needsTopic && !topic) errors.push("Select an ONVIF topic.");

  if (type === "incoming_http_request") {
    const path = normalizeWebhookPath(card.querySelector(".httpPath").value || "");
    if (!path) errors.push("Webhook path is required.");
  }

  return errors;
}

function getActionErrors(card) {
  const type = card.querySelector(".actionType").value;
  const errors = [];

  if (type === "activate_output_relay") {
    const mode = card.querySelector(".relayMode").value;
    const rawSeconds = (card.querySelector(".relaySeconds").value || "").trim();

    if (!mode) {
      errors.push("Select a relay action.");
    }

    if (mode === "pulse") {
      const seconds = Number(rawSeconds);
      if (!rawSeconds || !Number.isFinite(seconds) || seconds <= 0) {
        errors.push("Activation time must be greater than 0 seconds.");
      }
    }
  }

  if (type === "wait_for") {
    const rawSeconds = (card.querySelector(".waitSeconds").value || "").trim();
    const seconds = Number(rawSeconds);

    if (!rawSeconds || !Number.isFinite(seconds) || seconds <= 0) {
      errors.push("Wait time must be greater than 0 seconds.");
    }
  }

  if (type === "send_http_request") {
    const url = (card.querySelector(".httpActionUrl").value || "").trim();
    const headersRaw = card.querySelector(".httpActionHeaders").value || "";
    const timeoutRaw = (card.querySelector(".httpActionTimeout").value || "").trim();

    if (!url) {
      errors.push("HTTP request URL is required.");
    }

    if (timeoutRaw) {
      const timeout = Number(timeoutRaw);
      if (!Number.isFinite(timeout) || timeout <= 0) {
        errors.push("HTTP request timeout must be greater than 0 seconds.");
      }
    }

    try {
      parseHeadersJson(headersRaw);
    } catch (err) {
      errors.push(err.message || String(err));
    }
  }

  return errors;
}

function createConditionPayloadFromCard(card) {
  const type = card.querySelector(".condType").value;
  const name = card.querySelector(".condName").value.trim();
  const out = { type };

  if (name) out.name = name;

  if (type === "incoming_http_request") {
    out.method = card.querySelector(".httpMethod").value || "ANY";
    out.path = normalizeWebhookPath(card.querySelector(".httpPath").value || "");
    return out;
  }

  out.device_id = card.querySelector(".condDevice").value;

  if (getTriggerDef(type).needsTopic) {
    out.topic = card.dataset.topic || "";
  }

  return out;
}

function createActionPayloadFromCard(card) {
  const type = card.querySelector(".actionType").value;
  const name = card.querySelector(".actionName").value.trim();
  const out = { type };

  if (name) out.name = name;

  if (type === "activate_output_relay") {
    const mode = card.querySelector(".relayMode").value;
    out.mode = mode;

    if (mode === "pulse") {
      const seconds = Number(card.querySelector(".relaySeconds").value || "");
      if (Number.isFinite(seconds)) {
        out.activation_seconds = seconds;
      }
    }
  }

  if (type === "wait_for") {
    const seconds = Number(card.querySelector(".waitSeconds").value || "");
    if (Number.isFinite(seconds)) {
      out.seconds = seconds;
    }
  }

  if (type === "send_http_request") {
    out.method = card.querySelector(".httpActionMethod").value || "POST";
    out.url = (card.querySelector(".httpActionUrl").value || "").trim();

    try {
      out.headers = parseHeadersJson(card.querySelector(".httpActionHeaders").value || "");
    } catch {
      out.headers = {};
    }

    const body = card.querySelector(".httpActionBody").value;
    const timeoutRaw = (card.querySelector(".httpActionTimeout").value || "").trim();

    if (body.trim()) out.body = body;
    if (timeoutRaw) out.timeout_seconds = Number(timeoutRaw);
  }

  return out;
}

function updateConditionCardUi(card) {
  const payload = createConditionPayloadFromCard(card);
  const title = card.querySelector(".itemTitle");
  const preview = card.querySelector(".previewText");
  const validation = card.querySelector(".validationText");
  const errors = getConditionErrors(card);
  const summary = summarizeCondition(payload);

  if (title) title.textContent = summary;
  if (preview) preview.innerHTML = `Trigger: <strong>${escapeHtml(summary)}</strong>`;

  card.classList.toggle("invalid", errors.length > 0);

  if (validation) {
    validation.classList.toggle("hidden", errors.length === 0);
    validation.textContent = errors.join(" ");
  }
}

function updateActionCardUi(card) {
  const payload = createActionPayloadFromCard(card);
  const title = card.querySelector(".itemTitle");
  const preview = card.querySelector(".previewText");
  const validation = card.querySelector(".validationText");
  const errors = getActionErrors(card);
  const summary = summarizeAction(payload);

  if (title) title.textContent = summary;
  if (preview) preview.innerHTML = `Action: <strong>${escapeHtml(summary)}</strong>`;

  card.classList.toggle("invalid", errors.length > 0);

  if (validation) {
    validation.classList.toggle("hidden", errors.length === 0);
    validation.textContent = errors.join(" ");
  }
}

function refreshBuilderCards() {
  [...el("conditionsList").children].forEach(updateConditionCardUi);
  [...el("actionsList").children].forEach(updateActionCardUi);
}

function syncConditionTypeUi(card) {
  const type = card.querySelector(".condType").value;
  const def = getTriggerDef(type);

  const deviceWrap = card.querySelector(".condDeviceWrap");
  const topicPicker = card.querySelector(".topicPicker");
  const httpWraps = card.querySelectorAll(".httpTriggerWrap");

  if (deviceWrap) deviceWrap.classList.toggle("hidden", !def.needsDevice);

  if (topicPicker) {
    topicPicker.classList.toggle("open", !!def.needsTopic);
  }

  httpWraps.forEach((node) => {
    node.classList.toggle("hidden", type !== "incoming_http_request");
  });

  updateConditionWebhookUi(card);
}

function syncActionModeUi(card) {
  const mode = card.querySelector(".relayMode").value;
  const wrap = card.querySelector(".relaySecondsWrap");
  if (!wrap) return;
  wrap.classList.toggle("hidden", mode !== "pulse");
}

function syncActionTypeUi(card) {
  const type = card.querySelector(".actionType").value;
  const relayModeWrap = card.querySelector(".relayModeWrap");
  const relaySecondsWrap = card.querySelector(".relaySecondsWrap");
  const waitSecondsWrap = card.querySelector(".waitSecondsWrap");
  const httpActionWraps = card.querySelectorAll(".httpActionWrap");

  const isRelay = type === "activate_output_relay";
  const isWait = type === "wait_for";
  const isHttp = type === "send_http_request";

  if (relayModeWrap) relayModeWrap.classList.toggle("hidden", !isRelay);
  if (waitSecondsWrap) waitSecondsWrap.classList.toggle("hidden", !isWait);
  httpActionWraps.forEach((node) => {
    node.classList.toggle("hidden", !isHttp);
  });

  if (isRelay) {
    syncActionModeUi(card);
  } else if (relaySecondsWrap) {
    relaySecondsWrap.classList.add("hidden");
  }
}

function moveItem(card, direction) {
  const parent = card.parentElement;
  if (!parent) return;

  if (direction < 0) {
    const prev = card.previousElementSibling;
    if (!prev) return;
    parent.insertBefore(card, prev);
  } else {
    const next = card.nextElementSibling;
    if (!next) return;
    parent.insertBefore(next, card);
  }

  markDirty();
  refreshBuilderCards();
}

async function loadTopics(deviceId, force = false) {
  if (!deviceId) return [];
  if (!force && state.topicCache.has(deviceId)) {
    return state.topicCache.get(deviceId);
  }

  const data = await api(`/api/events/properties/${encodeURIComponent(deviceId)}`);
  const topics = Array.isArray(data?.topics) ? data.topics : [];
  state.topicCache.set(deviceId, topics);
  return topics;
}

async function renderTopicsInto(card, opts = {}) {
  const typeSel = card.querySelector(".condType");
  const deviceSel = card.querySelector(".condDevice");
  const search = card.querySelector(".topicSearch");
  const list = card.querySelector(".topicList");
  const selectedText = card.querySelector(".selectedTopicText");
  const countText = card.querySelector(".topicCountText");

  if (!typeSel || !deviceSel || !search || !list || !selectedText || !countText) {
    return;
  }

  const def = getTriggerDef(typeSel.value);

  if (!def.needsTopic) {
    list.innerHTML = "";
    selectedText.textContent = "No topic is needed for this trigger.";
    countText.textContent = "";
    updateConditionCardUi(card);
    return;
  }

  const deviceId = deviceSel.value;
  const selectedTopic = card.dataset.topic || "";

  if (!deviceId) {
    list.innerHTML = `<div class="emptyState">Select a device first.</div>`;
    selectedText.textContent = "Select an ONVIF topic for this trigger.";
    countText.textContent = "";
    updateConditionCardUi(card);
    return;
  }

  selectedText.innerHTML = selectedTopic
    ? `Selected topic: <strong>${escapeHtml(selectedTopic)}</strong>`
    : `Select an ONVIF topic for this trigger.`;

  list.innerHTML = `<div class="emptyState">Loading topics…</div>`;

  try {
    const topics = await loadTopics(deviceId, !!opts.force);
    const q = (search.value || "").trim().toLowerCase();

    const filtered = q
      ? topics.filter((topic) =>
          (topic.path || "").toLowerCase().includes(q) ||
          (topic.name || "").toLowerCase().includes(q)
        )
      : topics;

    countText.textContent = filtered.length
      ? `${filtered.length} topic${filtered.length === 1 ? "" : "s"} shown`
      : "No topics match your filter";

    if (!filtered.length) {
      list.innerHTML = `<div class="emptyState">No topics found.</div>`;
      updateConditionCardUi(card);
      return;
    }

    list.innerHTML = filtered.map((topic) => {
      const path = topic.path || "";
      const name = topic.name || topic.path || "Unnamed topic";
      const active = path === selectedTopic;

      return `
        <div class="topicItem ${active ? "active" : ""}" data-topic="${escapeHtml(path)}">
          <div class="topicName">${escapeHtml(name)}</div>
          <div class="topicPath">${escapeHtml(path)}</div>
        </div>
      `;
    }).join("");

    list.querySelectorAll(".topicItem").forEach((node) => {
      node.addEventListener("click", async () => {
        card.dataset.topic = node.dataset.topic || "";
        markDirty();
        await renderTopicsInto(card);
        updateConditionCardUi(card);
      });
    });
  } catch (err) {
    countText.textContent = "";
    list.innerHTML = `<div class="emptyState">Failed to load topics: ${escapeHtml(err.message || String(err))}</div>`;
  }

  updateConditionCardUi(card);
}

function bindFieldDirty(card, selector, fn = null) {
  const node = card.querySelector(selector);
  if (!node) return;

  node.addEventListener("input", async () => {
    markDirty();
    if (fn) await fn();
    refreshBuilderCards();
  });

  node.addEventListener("change", async () => {
    markDirty();
    if (fn) await fn();
    refreshBuilderCards();
  });
}

function ensureAtLeastOneConditionRow() {
  if (!el("conditionsList").children.length) addConditionRow();
}

function addConditionRow(data = {}, opts = {}) {
  const { open = true } = opts;

  const node = el("conditionTemplate").content.firstElementChild.cloneNode(true);
  const condName = node.querySelector(".condName");
  const condType = node.querySelector(".condType");
  const condDevice = node.querySelector(".condDevice");
  const btnRemove = node.querySelector(".btnRemoveCondition");
  const btnLoadTopics = node.querySelector(".btnLoadTopics");
  const topicSearch = node.querySelector(".topicSearch");
  const httpMethod = node.querySelector(".httpMethod");
  const httpPath = node.querySelector(".httpPath");
  const btnGenerateHttpPath = node.querySelector(".btnGenerateHttpPath");
  const btnCopyHttpUrl = node.querySelector(".btnCopyHttpUrl");

  condName.value = data.name || "";
  condType.value = data.type || "onvif_event";
  condDevice.innerHTML = deviceOptionsHtml(data.device_id || "");
  node.dataset.topic = data.topic || "";
  httpMethod.value = data.method || "ANY";
  httpPath.value = normalizeWebhookPath(data.path || "");

  if (condType.value === "incoming_http_request" && !httpPath.value) {
    httpPath.value = generateWebhookPath();
  }

  bindItemCollapse(node, open);

  btnRemove.addEventListener("click", (ev) => {
    ev.stopPropagation();
    node.remove();
    ensureAtLeastOneConditionRow();
    refreshBuilderCards();
    markDirty();
  });

  bindFieldDirty(node, ".condName");
  bindFieldDirty(node, ".condType", async () => {
    const def = getTriggerDef(condType.value);
    if (!def.needsTopic) {
      node.dataset.topic = "";
    }
    if (condType.value === "incoming_http_request" && !(httpPath.value || "").trim()) {
      httpPath.value = generateWebhookPath();
    }
    syncConditionTypeUi(node);
    await renderTopicsInto(node);
  });

  bindFieldDirty(node, ".condDevice", async () => {
    const def = getTriggerDef(condType.value);
    if (def.needsTopic) {
      const hadTopic = !!node.dataset.topic;
      node.dataset.topic = "";
      await renderTopicsInto(node);
      if (hadTopic) {
        setStatus("Topic reset because the trigger device changed.");
      }
    }
  });

  bindFieldDirty(node, ".httpMethod");
  bindFieldDirty(node, ".httpPath", async () => {
    httpPath.value = normalizeWebhookPath(httpPath.value || "");
    updateConditionWebhookUi(node);
  });

  btnGenerateHttpPath.addEventListener("click", (ev) => {
    ev.stopPropagation();
    httpPath.value = generateWebhookPath();
    updateConditionWebhookUi(node);
    refreshBuilderCards();
    markDirty();
    setStatus("Generated a new webhook path.");
  });

  btnCopyHttpUrl.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const url = buildWebhookUrl(httpPath.value || "");
    if (!url) {
      setStatus("Webhook URL is empty.", true);
      return;
    }

    try {
      const ok = await copyTextToClipboard(url);
      if (!ok) throw new Error("Copy failed");
      setStatus("Webhook URL copied.");
    } catch {
      setStatus("Failed to copy webhook URL.", true);
    }
  });

  topicSearch.addEventListener("input", async () => {
    await renderTopicsInto(node);
  });

  btnLoadTopics.addEventListener("click", async () => {
    await renderTopicsInto(node, { force: true });
    setStatus("Device topics refreshed.");
  });

  syncConditionTypeUi(node);
  updateConditionWebhookUi(node);
  el("conditionsList").appendChild(node);
  renderTopicsInto(node);
  updateConditionCardUi(node);
}

function addActionRow(data = {}, opts = {}) {
  const { open = true } = opts;

  const node = el("actionTemplate").content.firstElementChild.cloneNode(true);
  const actionName = node.querySelector(".actionName");
  const actionType = node.querySelector(".actionType");
  const relayMode = node.querySelector(".relayMode");
  const relaySeconds = node.querySelector(".relaySeconds");
  const waitSeconds = node.querySelector(".waitSeconds");
  const httpActionMethod = node.querySelector(".httpActionMethod");
  const httpActionUrl = node.querySelector(".httpActionUrl");
  const httpActionHeaders = node.querySelector(".httpActionHeaders");
  const httpActionBody = node.querySelector(".httpActionBody");
  const httpActionTimeout = node.querySelector(".httpActionTimeout");
  const btnRemove = node.querySelector(".btnRemoveAction");
  const btnMoveUp = node.querySelector(".btnMoveUpAction");
  const btnMoveDown = node.querySelector(".btnMoveDownAction");

  actionName.value = data.name || "";
  actionType.value = data.type || "activate_output_relay";
  relayMode.value = data.mode || "on";
  relaySeconds.value = data.activation_seconds ?? "";
  waitSeconds.value = data.seconds ?? "";
  httpActionMethod.value = data.method || "POST";
  httpActionUrl.value = data.url || "";
  httpActionHeaders.value = data.headers ? JSON.stringify(data.headers, null, 2) : "";
  httpActionBody.value = data.body || "";
  httpActionTimeout.value = data.timeout_seconds ?? "";

  bindItemCollapse(node, open);

  btnRemove.addEventListener("click", (ev) => {
    ev.stopPropagation();
    node.remove();
    refreshBuilderCards();
    markDirty();
  });

  btnMoveUp.addEventListener("click", (ev) => {
    ev.stopPropagation();
    moveItem(node, -1);
  });

  btnMoveDown.addEventListener("click", (ev) => {
    ev.stopPropagation();
    moveItem(node, 1);
  });

  bindFieldDirty(node, ".actionName");
  bindFieldDirty(node, ".actionType", async () => {
    syncActionTypeUi(node);
  });
  bindFieldDirty(node, ".relayMode", async () => {
    syncActionModeUi(node);
  });
  bindFieldDirty(node, ".relaySeconds");
  bindFieldDirty(node, ".waitSeconds");
  bindFieldDirty(node, ".httpActionMethod");
  bindFieldDirty(node, ".httpActionUrl");
  bindFieldDirty(node, ".httpActionHeaders");
  bindFieldDirty(node, ".httpActionBody");
  bindFieldDirty(node, ".httpActionTimeout");

  syncActionTypeUi(node);
  el("actionsList").appendChild(node);
  updateActionCardUi(node);
}

function getEditorPayload() {
  const name = el("ruleName").value.trim();
  const enabled = el("ruleEnabled").checked;
  const conditions = [...el("conditionsList").children].map(createConditionPayloadFromCard);
  const actions = [...el("actionsList").children].map(createActionPayloadFromCard);

  return { name, enabled, conditions, actions };
}

function validatePayload(payload) {
  const errors = [];

  if (!payload.name) errors.push("Rule name is required.");
  if (!payload.conditions.length) errors.push("Add at least one trigger.");

  [...el("conditionsList").children].forEach((card) => {
    errors.push(...getConditionErrors(card));
  });

  [...el("actionsList").children].forEach((card) => {
    errors.push(...getActionErrors(card));
  });

  return errors;
}

function applyRuleToEditor(rule) {
  state.suspendDirty = true;

  state.selectedRuleId = rule?.id || null;

  el("ruleName").value = rule?.name || "";
  el("ruleEnabled").checked = rule ? !!rule.enabled : true;
  syncRuleEnabledLabel();

  el("conditionsList").innerHTML = "";
  el("actionsList").innerHTML = "";

  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const actions = Array.isArray(rule?.actions) ? rule.actions : [];

  if (conditions.length) {
    conditions.forEach((condition) => addConditionRow(condition, { open: false }));
  } else {
    addConditionRow({}, { open: true });
  }

  actions.forEach((action) => addActionRow(action, { open: false }));

  state.suspendDirty = false;
  clearDirty();
  refreshBuilderCards();
  renderRules();

  if (rule?.id) {
    setStatus(`Editing "${rule.name}".`);
  } else {
    setStatus("Ready.");
  }
}

function clearEditor(force = false) {
  if (!force && !confirmDiscardIfDirty()) return;
  applyRuleToEditor(null);
}

function fillEditor(rule) {
  if (!confirmDiscardIfDirty()) return;
  applyRuleToEditor(rule || null);
}

function duplicateSelectedRule() {
  const source = state.selectedRuleId
    ? state.rules.find((rule) => rule.id === state.selectedRuleId)
    : null;

  if (!source) {
    setStatus("Select a rule to duplicate.", true);
    return;
  }

  if (!confirmDiscardIfDirty()) return;

  const copy = JSON.parse(JSON.stringify(source));
  delete copy.id;
  delete copy.created_at;
  delete copy.updated_at;
  copy.name = `${source.name} copy`;

  applyRuleToEditor(copy);
  state.selectedRuleId = null;
  state.isDirty = true;
  syncEditorMode();
  renderRules();
  setStatus("Rule duplicated into a new draft.");
}

function filterRules() {
  const q = el("rulesSearch").value.trim().toLowerCase();
  const status = el("rulesFilterStatus").value;

  return state.rules.filter((rule) => {
    if (status === "enabled" && !rule.enabled) return false;
    if (status === "disabled" && rule.enabled) return false;

    if (!q) return true;

    const haystack = [
      rule.name || "",
      rule.id || "",
      ruleSentence(rule),
      ...(rule.conditions || []).map((c) => JSON.stringify(c)),
      ...(rule.actions || []).map((a) => JSON.stringify(a)),
    ].join(" ").toLowerCase();

    return haystack.includes(q);
  });
}

function renderRules() {
  const box = el("rulesList");
  const visibleRules = filterRules();

  if (!state.rules.length) {
    box.innerHTML = `
      <div class="emptyState">
        No rules yet. Create your first rule for device events, webhook triggers, waits, and HTTP actions.
      </div>
    `;
    setListStatus("No rules saved yet.");
    return;
  }

  if (!visibleRules.length) {
    box.innerHTML = `<div class="emptyState">No matching rules.</div>`;
    setListStatus("No rules match the current filter.");
    return;
  }

  box.innerHTML = visibleRules.map((rule) => {
    const active = rule.id === state.selectedRuleId;

    return `
      <div class="ruleItem ${active ? "active" : ""}" data-id="${escapeHtml(rule.id)}">
        <div class="ruleTop">
          <div>
            <div class="ruleName">${escapeHtml(rule.name || rule.id)}</div>
            <div class="ruleSummary">${escapeHtml(ruleSentence(rule))}</div>
          </div>

          <label class="statusChip jsRuleToggleWrap" style="margin:0; cursor:pointer;">
            <input class="jsRuleToggle" type="checkbox" ${rule.enabled ? "checked" : ""} style="width:auto; margin:0;" />
            <span>${rule.enabled ? "Enabled" : "Disabled"}</span>
          </label>
        </div>
      </div>
    `;
  }).join("");

  box.querySelectorAll(".ruleItem").forEach((card) => {
    const ruleId = card.dataset.id;
    const rule = state.rules.find((item) => item.id === ruleId);
    if (!rule) return;

    const toggle = card.querySelector(".jsRuleToggle");
    const toggleLabel = card.querySelector(".jsRuleToggleWrap span");

    card.addEventListener("click", (ev) => {
      if (ev.target.closest(".jsRuleToggleWrap")) return;
      fillEditor(rule);
    });

    toggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });

    toggle.addEventListener("change", async () => {
      try {
        await api(`/api/actions/${encodeURIComponent(rule.id)}`, {
          method: "PUT",
          body: JSON.stringify({
            name: rule.name,
            enabled: toggle.checked,
            conditions: rule.conditions || [],
            actions: rule.actions || [],
          }),
        });

        await refreshRules();

        const updated = state.rules.find((item) => item.id === rule.id);

        if (
          updated &&
          state.selectedRuleId === updated.id &&
          !state.isDirty
        ) {
          applyRuleToEditor(updated);
        }

        setListStatus(`Rule ${toggle.checked ? "enabled" : "disabled"}.`);
      } catch (err) {
        toggle.checked = !toggle.checked;
        if (toggleLabel) {
          toggleLabel.textContent = toggle.checked ? "Enabled" : "Disabled";
        }
        setListStatus(err.message || String(err), true);
      }
    });
  });

  setListStatus(`${visibleRules.length} rule${visibleRules.length === 1 ? "" : "s"} shown.`);
}

async function refreshRules() {
  const data = await api("/api/actions");
  state.rules = Array.isArray(data?.items) ? data.items : [];
  renderRules();
}

async function loadDevices() {
  const data = await api("/api/devices");
  state.devices = Array.isArray(data?.devices) ? data.devices : [];
}

async function saveRule() {
  const payload = getEditorPayload();
  const errors = validatePayload(payload);

  refreshBuilderCards();

  if (errors.length) {
    setStatus(errors[0], true);
    throw new Error(errors[0]);
  }

  const out = state.selectedRuleId
    ? await api(`/api/actions/${encodeURIComponent(state.selectedRuleId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
    : await api("/api/actions", {
        method: "POST",
        body: JSON.stringify(payload),
      });

  await refreshRules();

  const saved = out?.item || out;
  const actualRule = saved?.id
    ? state.rules.find((rule) => rule.id === saved.id) || saved
    : saved;

  applyRuleToEditor(actualRule);
  clearDirty();
  setStatus("Rule saved.");
}

async function testRule() {
  const payload = getEditorPayload();
  const errors = validatePayload(payload);

  refreshBuilderCards();

  if (errors.length) {
    setStatus(errors[0], true);
    throw new Error(errors[0]);
  }

  const out = await api("/api/actions/test", {
    method: "POST",
    body: JSON.stringify({
      name: payload.name,
      conditions: payload.conditions,
      actions: payload.actions,
    }),
  });

  setStatus(out?.message || "Manual test executed.");
}

async function deleteSelected() {
  if (!state.selectedRuleId) return;

  await api(`/api/actions/${encodeURIComponent(state.selectedRuleId)}`, {
    method: "DELETE",
  });

  await refreshRules();
  applyRuleToEditor(null);
  setStatus("Rule deleted.");
}

function bindGlobalEvents() {
  el("btnAddCondition").addEventListener("click", () => {
    addConditionRow({}, { open: true });
    markDirty();
  });

  el("btnAddAction").addEventListener("click", () => {
    addActionRow({}, { open: true });
    markDirty();
  });

  el("btnNew").addEventListener("click", () => {
    clearEditor(false);
  });

  el("btnSave").addEventListener("click", async () => {
    try {
      await saveRule();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  el("btnTest").addEventListener("click", async () => {
    try {
      await testRule();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  el("btnDelete").addEventListener("click", async () => {
    if (!state.selectedRuleId) return;
    if (!window.confirm("Delete the selected rule?")) return;

    try {
      await deleteSelected();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  el("btnDuplicate").addEventListener("click", duplicateSelectedRule);

  el("ruleName").addEventListener("input", () => {
    markDirty();
  });

  el("ruleEnabled").addEventListener("change", () => {
    syncRuleEnabledLabel();
    markDirty();
  });

  el("rulesSearch").addEventListener("input", renderRules);
  el("rulesFilterStatus").addEventListener("change", renderRules);

  window.addEventListener("beforeunload", (ev) => {
    if (!state.isDirty) return;
    ev.preventDefault();
    ev.returnValue = "";
  });
}

async function init() {
  bindGlobalEvents();
  syncRuleEnabledLabel();
  syncEditorMode();

  try {
    await loadDevices();
    await refreshRules();
    applyRuleToEditor(null);
  } catch (err) {
    setStatus(err.message || String(err), true);
    setListStatus(err.message || String(err), true);
    applyRuleToEditor(null);
  }
}

init();