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
    summarize(data) {
      const device = deviceLabel(data.device_id);
      if (data.name) return data.name;
      return `When ${device} goes offline`;
    },
  },

  device_back_online: {
    label: "Device back online",
    needsTopic: false,
    summarize(data) {
      const device = deviceLabel(data.device_id);
      if (data.name) return data.name;
      return `When ${device} comes back online`;
    },
  },
};

const ACTION_DEFS = {
  activate_output_relay: {
    label: "Activate output relay",
    summarize(data) {
      if (data.name) return data.name;
      if (data.mode === "on") return "Activate output relay · turn on";
      if (data.mode === "off") return "Activate output relay · turn off";
      if (data.mode === "pulse") {
        return `Activate output relay · pulse ${data.activation_seconds ?? "?"}s`;
      }
      return "Activate output relay";
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
  const right = (rule.actions || []).map(summarizeAction).join(" and ");
  return right ? `${left}, log the trigger, then ${right}.` : `${left}, log the trigger.`;
}

function confirmDiscardIfDirty() {
  if (!state.isDirty) return true;
  return window.confirm("You have unsaved changes. Discard them?");
}

function setItemCollapsed(card, open) {
  const btn = card.querySelector(".itemCollapseBtn");
  const body = card.querySelector(".itemCollapseBody");
  if (!btn || !body) return;

  btn.classList.toggle("open", open);
  btn.setAttribute("aria-expanded", String(open));
  body.classList.toggle("open", open);
}

function bindItemCollapse(card) {
  const btn = card.querySelector(".itemCollapseBtn");
  if (!btn) return;

  const toggle = () => {
    const isOpen = btn.classList.contains("open");
    setItemCollapsed(card, !isOpen);
  };

  btn.addEventListener("click", (ev) => {
    if (ev.target.closest(".btnRemoveCondition, .btnRemoveAction")) return;
    toggle();
  });

  btn.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    toggle();
  });

  setItemCollapsed(card, true);
}

function getConditionErrors(card) {
  const type = card.querySelector(".condType").value;
  const deviceId = card.querySelector(".condDevice").value;
  const topic = card.dataset.topic || "";
  const def = getTriggerDef(type);
  const errors = [];

  if (!deviceId) errors.push("Select a device.");
  if (def.needsTopic && !topic) errors.push("Select an ONVIF topic.");

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

  return errors;
}

function createConditionPayloadFromCard(card) {
  const type = card.querySelector(".condType").value;
  const name = card.querySelector(".condName").value.trim();
  const device_id = card.querySelector(".condDevice").value;
  const out = { type, device_id };

  if (name) out.name = name;
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

function syncConditionTopicUi(card) {
  const type = card.querySelector(".condType").value;
  const picker = card.querySelector(".topicPicker");
  if (!picker) return;

  picker.classList.toggle("open", getTriggerDef(type).needsTopic);
}

function syncActionModeUi(card) {
  const mode = card.querySelector(".relayMode").value;
  const wrap = card.querySelector(".relaySecondsWrap");
  if (!wrap) return;
  wrap.classList.toggle("hidden", mode !== "pulse");
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

function addConditionRow(data = {}) {
  const node = el("conditionTemplate").content.firstElementChild.cloneNode(true);
  const condName = node.querySelector(".condName");
  const condType = node.querySelector(".condType");
  const condDevice = node.querySelector(".condDevice");
  const btnRemove = node.querySelector(".btnRemoveCondition");
  const btnLoadTopics = node.querySelector(".btnLoadTopics");
  const topicSearch = node.querySelector(".topicSearch");

  condName.value = data.name || "";
  condType.value = data.type || "onvif_event";
  condDevice.innerHTML = deviceOptionsHtml(data.device_id || "");
  node.dataset.topic = data.topic || "";

  bindItemCollapse(node);

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
    syncConditionTopicUi(node);
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

  topicSearch.addEventListener("input", async () => {
    await renderTopicsInto(node);
  });

  btnLoadTopics.addEventListener("click", async () => {
    await renderTopicsInto(node, { force: true });
    setStatus("Device topics refreshed.");
  });

  syncConditionTopicUi(node);
  el("conditionsList").appendChild(node);
  renderTopicsInto(node);
  updateConditionCardUi(node);
}

function addActionRow(data = {}) {
  const node = el("actionTemplate").content.firstElementChild.cloneNode(true);
  const actionName = node.querySelector(".actionName");
  const actionType = node.querySelector(".actionType");
  const relayMode = node.querySelector(".relayMode");
  const relaySeconds = node.querySelector(".relaySeconds");
  const btnRemove = node.querySelector(".btnRemoveAction");

  actionName.value = data.name || "";
  actionType.value = data.type || "activate_output_relay";
  relayMode.value = data.mode || "on";
  relaySeconds.value = data.activation_seconds ?? "";

  bindItemCollapse(node);

  btnRemove.addEventListener("click", (ev) => {
    ev.stopPropagation();
    node.remove();
    refreshBuilderCards();
    markDirty();
  });

  bindFieldDirty(node, ".actionName");
  bindFieldDirty(node, ".actionType", async () => {
    syncActionModeUi(node);
  });
  bindFieldDirty(node, ".relayMode", async () => {
    syncActionModeUi(node);
  });
  bindFieldDirty(node, ".relaySeconds");

  syncActionModeUi(node);
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

  for (const condition of payload.conditions) {
    if (!condition.device_id) errors.push("Each trigger must have a device.");

    const def = getTriggerDef(condition.type);
    if (def.needsTopic && !condition.topic) {
      errors.push("Each ONVIF event trigger must have a topic.");
    }
  }

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
    conditions.forEach(addConditionRow);
  } else {
    addConditionRow();
  }

  actions.forEach(addActionRow);

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
        No rules yet. Create your first rule for device state changes or ONVIF events.
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

    const conditionTags = (rule.conditions || []).slice(0, 3).map((condition) => {
      if (condition.type === "onvif_event") return `<span class="miniTag">ONVIF</span>`;
      if (condition.type === "device_offline") return `<span class="miniTag">Offline</span>`;
      if (condition.type === "device_back_online") return `<span class="miniTag">Back online</span>`;
      return `<span class="miniTag">${escapeHtml(condition.type || "Trigger")}</span>`;
    }).join("");

    const actionTags = (rule.actions || []).slice(0, 3).map((action) => {
      if (action.type === "activate_output_relay") return `<span class="miniTag">Relay</span>`;
      return `<span class="miniTag">${escapeHtml(action.type || "Action")}</span>`;
    }).join("");

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

        <div class="ruleMeta">
          ${conditionTags}
          ${actionTags}
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

  setStatus(out?.message || "Manual test logged.");
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
    addConditionRow();
    markDirty();
  });

  el("btnAddAction").addEventListener("click", () => {
    addActionRow();
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