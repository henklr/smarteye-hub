const el = (id) => document.getElementById(id);

let devices = [];
let rules = [];
let selectedRuleId = null;
let isDirty = false;
let suspendDirty = false;
const topicCache = new Map();

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

function escapeHtml(s) {
  return (s ?? "").toString()
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
  if (suspendDirty) return;
  isDirty = true;
  syncEditorMode();
}

function clearDirty() {
  isDirty = false;
  syncEditorMode();
}

function syncEditorMode() {
  const title = el("formTitle");
  const mode = el("editorModeText");

  if (title) title.textContent = selectedRuleId ? "Edit rule" : "New rule";

  if (mode) {
    if (selectedRuleId) {
      mode.textContent = isDirty ? "Editing existing rule · unsaved changes." : "Editing existing rule.";
    } else {
      mode.textContent = isDirty ? "New rule · unsaved changes." : "Create a new rule.";
    }
  }

  const del = el("btnDelete");
  if (del) del.disabled = !selectedRuleId;
}

function syncRuleEnabledLabel() {
  const label = el("ruleEnabledText");
  const input = el("ruleEnabled");
  if (!label || !input) return;
  label.textContent = input.checked ? "Enabled" : "Disabled";
}

function deviceById(id) {
  return devices.find((d) => d.id === id) || null;
}

function deviceLabel(id) {
  const d = deviceById(id);
  return d ? d.name : (id || "Unknown device");
}

function deviceOptionsHtml(selected = "") {
  return devices.map((d) => `
    <option value="${escapeHtml(d.id)}" ${d.id === selected ? "selected" : ""}>
      ${escapeHtml(d.name)}
    </option>
  `).join("");
}

function summarizeCondition(c) {
  if (c?.name) return c.name;

  const device = deviceLabel(c.device_id);

  if (c.type === "onvif_event") {
    return c.topic
      ? `When ${device} emits ${c.topic}`
      : `When ${device} emits a selected ONVIF topic`;
  }
  if (c.type === "device_offline") return `When ${device} goes offline`;
  if (c.type === "device_back_online") return `When ${device} comes back online`;
  return c.type || "Unknown trigger";
}

function summarizeAction(a) {
  if (a?.name) return a.name;

  if (a.type === "create_log_event") return "Create log event";
  if (a.type === "take_snapshot") return `Take snapshot on ${deviceLabel(a.camera_device_id)}`;
  return a.type || "Unknown action";
}

function ruleSentence(rule) {
  const conds = (rule.conditions || []).map(summarizeCondition);
  const acts = (rule.actions || []).map(summarizeAction);
  const left = conds.length ? conds.join(" or ") : "When something happens";
  const right = acts.length ? acts.join(" and ") : "do something";
  return `${left}, then ${right}.`;
}

function getConditionErrors(card) {
  const type = card.querySelector(".condType").value;
  const deviceId = card.querySelector(".condDevice").value;
  const topic = card.dataset.topic || "";
  const errors = [];

  if (!deviceId) errors.push("Select a device.");
  if (type === "onvif_event" && !topic) errors.push("Select an ONVIF topic.");
  return errors;
}

function getActionErrors(card) {
  const type = card.querySelector(".actionType").value;
  const cameraDeviceId = card.querySelector(".snapshotDevice").value;
  const errors = [];

  if (type === "take_snapshot" && !cameraDeviceId) {
    errors.push("Select a camera for snapshots.");
  }
  return errors;
}

function updateConditionCardUi(card, index) {
  const title = card.querySelector(".itemTitle");
  const name = card.querySelector(".condName")?.value.trim() || "";
  const type = card.querySelector(".condType").value;
  const deviceId = card.querySelector(".condDevice").value;
  const topic = card.dataset.topic || "";
  const preview = card.querySelector(".previewText");
  const validation = card.querySelector(".validationText");
  const errors = getConditionErrors(card);

  const summary = summarizeCondition({
    name,
    type,
    device_id: deviceId,
    topic,
  });

  if (title) {
    title.textContent = summary;
  }

  if (preview) {
    preview.innerHTML = `Trigger: <strong>${escapeHtml(summary)}</strong>`;
  }

  card.classList.toggle("invalid", errors.length > 0);
  if (validation) {
    validation.classList.toggle("hidden", errors.length === 0);
    validation.textContent = errors.join(" ");
  }
}

function updateActionCardUi(card, index) {
  const title = card.querySelector(".itemTitle");
  const name = card.querySelector(".actionName")?.value.trim() || "";
  const type = card.querySelector(".actionType").value;
  const cameraDeviceId = card.querySelector(".snapshotDevice").value;
  const preview = card.querySelector(".previewText");
  const validation = card.querySelector(".validationText");
  const errors = getActionErrors(card);

  const summary = summarizeAction({
    name,
    type,
    camera_device_id: cameraDeviceId,
  });

  if (title) {
    title.textContent = summary;
  }

  if (preview) {
    preview.innerHTML = `Action: <strong>${escapeHtml(summary)}</strong>`;
  }

  card.classList.toggle("invalid", errors.length > 0);
  if (validation) {
    validation.classList.toggle("hidden", errors.length === 0);
    validation.textContent = errors.join(" ");
  }
}

function refreshBuilderIndices() {
  [...el("conditionsList").children].forEach((card, index) => updateConditionCardUi(card, index));
  [...el("actionsList").children].forEach((card, index) => updateActionCardUi(card, index));
}

function bindDirtyTracking(node) {
  node.querySelectorAll("input, select").forEach((field) => {
    field.addEventListener("input", () => {
      markDirty();
      refreshBuilderIndices();
    });
    field.addEventListener("change", () => {
      markDirty();
      refreshBuilderIndices();
    });
  });
}

function syncActionUi(card) {
  const wrap = card.querySelector(".snapshotDeviceWrap");
  const isSnapshot = card.querySelector(".actionType").value === "take_snapshot";
  if (wrap) wrap.classList.toggle("hidden", !isSnapshot);
}

function syncConditionTopicUi(card) {
  const typeSel = card.querySelector(".condType");
  const picker = card.querySelector(".topicPicker");
  if (picker) picker.classList.toggle("open", typeSel.value === "onvif_event");
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

async function loadTopics(deviceId, force = false) {
  if (!deviceId) return [];
  if (!force && topicCache.has(deviceId)) return topicCache.get(deviceId);

  const data = await api(`/api/events/properties/${encodeURIComponent(deviceId)}`);
  const items = data.topics || [];
  topicCache.set(deviceId, items);
  return items;
}

async function renderTopicsInto(card, opts = {}) {
  const typeSel = card.querySelector(".condType");
  const deviceSel = card.querySelector(".condDevice");
  const list = card.querySelector(".topicList");
  const search = card.querySelector(".topicSearch");
  const selectedText = card.querySelector(".selectedTopicText");
  const countText = card.querySelector(".topicCountText");

  if (!typeSel || !deviceSel || !list || !search || !selectedText || !countText) return;

  if (typeSel.value !== "onvif_event") {
    list.innerHTML = "";
    selectedText.textContent = "No topic is needed for this trigger.";
    countText.textContent = "";
    updateConditionCardUi(card, [...el("conditionsList").children].indexOf(card));
    return;
  }

  const selectedTopic = card.dataset.topic || "";
  selectedText.innerHTML = selectedTopic
    ? `Selected topic: <strong>${escapeHtml(selectedTopic)}</strong>`
    : `Select an ONVIF topic to trigger this rule.`;

  list.innerHTML = `<div class="emptyState">Loading topics…</div>`;

  try {
    const topics = await loadTopics(deviceSel.value, !!opts.force);
    const q = (search.value || "").trim().toLowerCase();

    const filtered = q
      ? topics.filter((t) =>
          (t.path || "").toLowerCase().includes(q) ||
          (t.name || "").toLowerCase().includes(q)
        )
      : topics;

    countText.textContent = filtered.length
      ? `${filtered.length} topic${filtered.length === 1 ? "" : "s"} shown`
      : "No topics match your filter";

    if (!filtered.length) {
      list.innerHTML = `<div class="emptyState">No topics found.</div>`;
      updateConditionCardUi(card, [...el("conditionsList").children].indexOf(card));
      return;
    }

    list.innerHTML = filtered.map((t) => {
      const path = t.path || "";
      const name = t.name || t.path || "Unnamed topic";
      const active = path === selectedTopic;
      return `
        <div class="topicItem ${active ? "active" : ""}" data-topic="${escapeHtml(path)}">
          <div class="topicName">${escapeHtml(name)}</div>
          <div class="topicPath">${escapeHtml(path)}</div>
        </div>
      `;
    }).join("");

    list.querySelectorAll(".topicItem").forEach((node) => {
      node.addEventListener("click", () => {
        card.dataset.topic = node.dataset.topic || "";
        renderTopicsInto(card);
        markDirty();
      });
    });
  } catch (e) {
    countText.textContent = "";
    list.innerHTML = `<div class="emptyState">Failed to load topics: ${escapeHtml(e.message || String(e))}</div>`;
  }

  updateConditionCardUi(card, [...el("conditionsList").children].indexOf(card));
}

function createConditionPayloadFromCard(card) {
  const type = card.querySelector(".condType").value;
  const device_id = card.querySelector(".condDevice").value;
  const name = card.querySelector(".condName")?.value.trim() || "";

  const out = { type, device_id };
  if (name) out.name = name;
  if (type === "onvif_event") out.topic = card.dataset.topic || "";
  return out;
}

function createActionPayloadFromCard(card) {
  const type = card.querySelector(".actionType").value;
  const name = card.querySelector(".actionName")?.value.trim() || "";

  const out = { type };
  if (name) out.name = name;
  if (type === "take_snapshot") out.camera_device_id = card.querySelector(".snapshotDevice").value;
  return out;
}

function addConditionRow(data = {}) {
  const node = el("conditionTemplate").content.firstElementChild.cloneNode(true);
  const deviceSelect = node.querySelector(".condDevice");
  const typeSelect = node.querySelector(".condType");
  const condName = node.querySelector(".condName");

  if (condName) condName.value = data.name || "";

  deviceSelect.innerHTML = deviceOptionsHtml(data.device_id || devices[0]?.id || "");
  typeSelect.value = data.type || "onvif_event";
  node.dataset.topic = data.topic || "";

  bindItemCollapse(node);

  node.querySelector(".btnRemoveCondition").addEventListener("click", (ev) => {
    ev.stopPropagation();
    node.remove();
    refreshBuilderIndices();
    markDirty();
    if (!el("conditionsList").children.length) addConditionRow();
  });

  typeSelect.addEventListener("change", async () => {
    syncConditionTopicUi(node);
    if (typeSelect.value !== "onvif_event") node.dataset.topic = "";
    await renderTopicsInto(node);
    refreshBuilderIndices();
  });

  deviceSelect.addEventListener("change", async () => {
    if (typeSelect.value === "onvif_event") {
      const hadTopic = !!node.dataset.topic;
      node.dataset.topic = "";
      await renderTopicsInto(node);
      if (hadTopic) setStatus("Topic reset because the trigger device changed.");
    } else {
      refreshBuilderIndices();
    }
  });

  node.querySelector(".topicSearch").addEventListener("input", async () => {
    await renderTopicsInto(node);
  });

  node.querySelector(".btnLoadTopics").addEventListener("click", async () => {
    await renderTopicsInto(node, { force: true });
    setStatus("Device topics refreshed.");
  });

  bindDirtyTracking(node);
  syncConditionTopicUi(node);
  el("conditionsList").appendChild(node);
  renderTopicsInto(node);
  refreshBuilderIndices();
}

function addActionRow(data = {}) {
  const node = el("actionTemplate").content.firstElementChild.cloneNode(true);
  const actionName = node.querySelector(".actionName");

  node.querySelector(".snapshotDevice").innerHTML = deviceOptionsHtml(data.camera_device_id || devices[0]?.id || "");
  node.querySelector(".actionType").value = data.type || "create_log_event";

  if (actionName) actionName.value = data.name || "";

  bindItemCollapse(node);

  node.querySelector(".btnRemoveAction").addEventListener("click", (ev) => {
    ev.stopPropagation();
    node.remove();
    refreshBuilderIndices();
    markDirty();
    if (!el("actionsList").children.length) addActionRow();
  });

  node.querySelector(".actionType").addEventListener("change", () => {
    syncActionUi(node);
    refreshBuilderIndices();
  });

  node.querySelector(".snapshotDevice").addEventListener("change", () => {
    refreshBuilderIndices();
  });

  bindDirtyTracking(node);
  syncActionUi(node);
  el("actionsList").appendChild(node);
  refreshBuilderIndices();
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
  if (!payload.actions.length) errors.push("Add at least one action.");

  for (const c of payload.conditions) {
    if (!c.device_id) errors.push("Each trigger must have a device.");
    if (c.type === "onvif_event" && !c.topic) errors.push("Each ONVIF event trigger must have a topic.");
  }

  for (const a of payload.actions) {
    if (a.type === "take_snapshot" && !a.camera_device_id) {
      errors.push("Each snapshot action must have a camera.");
    }
  }

  return errors;
}

function confirmDiscardIfDirty() {
  if (!isDirty) return true;
  return window.confirm("You have unsaved changes. Discard them?");
}

function applyRuleToEditor(rule) {
  suspendDirty = true;

  selectedRuleId = rule?.id || null;
  el("ruleName").value = rule?.name || "";
  el("ruleEnabled").checked = !!rule?.enabled;
  syncRuleEnabledLabel();

  el("conditionsList").innerHTML = "";
  el("actionsList").innerHTML = "";

  (rule?.conditions || []).forEach(addConditionRow);
  (rule?.actions || []).forEach(addActionRow);

  if (!rule?.conditions?.length) addConditionRow();
  if (!rule?.actions?.length) addActionRow();

  suspendDirty = false;
  clearDirty();
  renderRules();
  refreshBuilderIndices();

  if (rule && rule.id) {
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
  const source = selectedRuleId ? rules.find((r) => r.id === selectedRuleId) : null;
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
  selectedRuleId = null;
  isDirty = true;
  syncEditorMode();
  renderRules();
  setStatus("Rule duplicated into a new draft.");
}

function filterRules() {
  const q = el("rulesSearch").value.trim().toLowerCase();
  const status = el("rulesFilterStatus").value;

  return rules.filter((r) => {
    if (status === "enabled" && !r.enabled) return false;
    if (status === "disabled" && r.enabled) return false;

    if (!q) return true;

    const haystack = [
      r.name,
      r.id,
      ...(r.conditions || []).map((c) => JSON.stringify(c)),
      ...(r.actions || []).map((a) => JSON.stringify(a)),
      ruleSentence(r),
    ].join(" ").toLowerCase();

    return haystack.includes(q);
  });
}

function renderRules() {
  const box = el("rulesList");
  const items = filterRules();

  if (!rules.length) {
    box.innerHTML = `
      <div class="emptyState">
        No rules yet. Create your first automation for device state changes, ONVIF events, log events or snapshots.
      </div>
    `;
    setListStatus("No rules saved yet.");
    return;
  }

  if (!items.length) {
    box.innerHTML = `<div class="emptyState">No matching rules.</div>`;
    setListStatus("No rules match the current filter.");
    return;
  }

  box.innerHTML = items.map((r) => {
    const active = r.id === selectedRuleId;

    const conditionTags = (r.conditions || []).slice(0, 3).map((c) => {
      if (c.type === "onvif_event") return `<span class="miniTag">ONVIF</span>`;
      if (c.type === "device_offline") return `<span class="miniTag">Offline</span>`;
      if (c.type === "device_back_online") return `<span class="miniTag">Back online</span>`;
      return `<span class="miniTag">${escapeHtml(c.type || "Trigger")}</span>`;
    }).join("");

    const actionTags = (r.actions || []).slice(0, 3).map((a) => {
      if (a.type === "take_snapshot") return `<span class="miniTag">Snapshot</span>`;
      if (a.type === "create_log_event") return `<span class="miniTag">Log event</span>`;
      return `<span class="miniTag">${escapeHtml(a.type || "Action")}</span>`;
    }).join("");

    return `
      <div class="ruleItem ${active ? "active" : ""}" data-id="${escapeHtml(r.id)}">
        <div class="ruleTop">
          <div>
            <div class="ruleName">${escapeHtml(r.name || r.id)}</div>
            <div class="ruleSummary">${escapeHtml(ruleSentence(r))}</div>
          </div>

          <label class="statusChip jsRuleToggleWrap" style="margin:0; cursor:pointer;">
            <input class="jsRuleToggle" type="checkbox" ${r.enabled ? "checked" : ""} style="width:auto; margin:0;" />
            <span>${r.enabled ? "Enabled" : "Disabled"}</span>
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
    const id = card.dataset.id;
    const rule = rules.find((r) => r.id === id);
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
        const payload = {
          name: rule.name,
          enabled: toggle.checked,
          conditions: rule.conditions || [],
          actions: rule.actions || [],
        };

        await api(`/api/actions/${encodeURIComponent(rule.id)}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });

        await refreshRules();

        if (selectedRuleId === rule.id) {
          const updated = rules.find((x) => x.id === rule.id);
          if (updated) applyRuleToEditor(updated);
        }

        setListStatus(`Rule ${payload.enabled ? "enabled" : "disabled"}.`);
      } catch (e) {
        toggle.checked = !toggle.checked;
        if (toggleLabel) toggleLabel.textContent = toggle.checked ? "Enabled" : "Disabled";
        setListStatus(e.message || String(e), true);
      }
    });
  });

  setListStatus(`${items.length} rule${items.length === 1 ? "" : "s"} shown.`);
}

async function refreshRules() {
  const data = await api("/api/actions");
  rules = data.items || [];
  renderRules();
}

async function loadDevices() {
  const data = await api("/api/devices");
  devices = data.devices || [];
  if (!devices.length) throw new Error("No devices found. Add devices first.");
}

async function saveRule() {
  const payload = getEditorPayload();
  const errors = validatePayload(payload);

  refreshBuilderIndices();

  if (errors.length) {
    setStatus(errors[0], true);
    throw new Error(errors[0]);
  }

  const out = selectedRuleId
    ? await api(`/api/actions/${encodeURIComponent(selectedRuleId)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
    : await api("/api/actions", {
        method: "POST",
        body: JSON.stringify(payload),
      });

  await refreshRules();
  applyRuleToEditor(out.item);
  clearDirty();
  setStatus("Rule saved.");
}

async function deleteSelected() {
  if (!selectedRuleId) return;

  await api(`/api/actions/${encodeURIComponent(selectedRuleId)}`, { method: "DELETE" });
  await refreshRules();
  applyRuleToEditor(null);
  setStatus("Rule deleted.");
}

async function init() {
  try {
    await loadDevices();
    await refreshRules();
    applyRuleToEditor(null);
    syncRuleEnabledLabel();
    syncEditorMode();
  } catch (e) {
    setStatus(e.message || String(e), true);
    setListStatus(e.message || String(e), true);
  }
}

window.addEventListener("beforeunload", (e) => {
  if (!isDirty) return;
  e.preventDefault();
  e.returnValue = "";
});

el("btnAddCondition").addEventListener("click", () => {
  addConditionRow();
  markDirty();
});

el("btnAddAction").addEventListener("click", () => {
  addActionRow();
  markDirty();
});

el("btnNew").addEventListener("click", () => clearEditor(false));

el("btnSave").addEventListener("click", async () => {
  try {
    await saveRule();
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
});

el("btnDelete").addEventListener("click", async () => {
  if (!selectedRuleId) return;
  if (!window.confirm("Delete the selected rule?")) return;

  try {
    await deleteSelected();
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
});

el("btnDuplicate").addEventListener("click", duplicateSelectedRule);

el("ruleName").addEventListener("input", markDirty);
el("ruleEnabled").addEventListener("change", () => {
  syncRuleEnabledLabel();
  markDirty();
});

el("rulesSearch").addEventListener("input", renderRules);
el("rulesFilterStatus").addEventListener("change", renderRules);

init();
