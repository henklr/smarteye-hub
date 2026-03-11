// actions.js
const el = (id) => document.getElementById(id);

let devices = [];
let rules = [];
let selectedRuleId = null;
const topicCache = new Map();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) throw new Error((data && data.detail) ? data.detail : (txt || res.statusText));
  return data;
}

function setStatus(msg, isBad = false) {
  const n = el("formStatus");
  n.textContent = msg || "";
  n.style.color = isBad ? "var(--danger)" : "var(--muted)";
}

function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function deviceOptionsHtml(selected = "") {
  return devices.map((d) => `<option value="${escapeHtml(d.id)}" ${d.id === selected ? "selected" : ""}>${escapeHtml(d.name)} (${escapeHtml(d.id)})</option>`).join("");
}

function prettyCondition(c) {
  if (c.type === "onvif_event") return `ONVIF event · ${c.device_id} · ${c.topic || "(topic missing)"}`;
  if (c.type === "device_offline") return `Device offline · ${c.device_id}`;
  if (c.type === "device_back_online") return `Device back online · ${c.device_id}`;
  return c.type || "condition";
}

function prettyAction(a) {
  if (a.type === "take_snapshot") return `Take snapshot · ${a.camera_device_id}`;
  if (a.type === "create_log_event") return "Create log event";
  return a.type || "action";
}

async function loadTopics(deviceId) {
  if (!deviceId) return [];
  if (topicCache.has(deviceId)) return topicCache.get(deviceId);
  const data = await api(`/api/events/properties/${encodeURIComponent(deviceId)}`);
  const items = data.topics || [];
  topicCache.set(deviceId, items);
  return items;
}

function syncConditionTopicUi(card) {
  const typeSel = card.querySelector(".condType");
  const picker = card.querySelector(".topicPicker");
  picker.classList.toggle("open", typeSel.value === "onvif_event");
}

async function renderTopicsInto(card) {
  const typeSel = card.querySelector(".condType");
  const deviceSel = card.querySelector(".condDevice");
  const list = card.querySelector(".topicList");
  const search = card.querySelector(".topicSearch");
  const selectedText = card.querySelector(".selectedTopicText");
  if (typeSel.value !== "onvif_event") {
    list.innerHTML = "";
    selectedText.textContent = "No topic needed for this condition.";
    return;
  }
  const selectedTopic = card.dataset.topic || "";
  selectedText.textContent = selectedTopic ? `Selected topic: ${selectedTopic}` : "No topic selected.";
  list.innerHTML = `<div class="empty">Loading topics…</div>`;
  try {
    const topics = await loadTopics(deviceSel.value);
    const q = (search.value || "").trim().toLowerCase();
    const filtered = q ? topics.filter((t) => (t.path || "").toLowerCase().includes(q) || (t.name || "").toLowerCase().includes(q)) : topics;
    if (!filtered.length) {
      list.innerHTML = `<div class="empty">No topics found.</div>`;
      return;
    }
    list.innerHTML = filtered.map((t) => {
      const active = (t.path || "") === selectedTopic;
      return `<div class="topicItem ${active ? "active" : ""}" data-topic="${escapeHtml(t.path || "")}"><div style="font-weight:800">${escapeHtml(t.name || t.path || "")}</div><div class="mini">${escapeHtml(t.path || "")}</div></div>`;
    }).join("");
    list.querySelectorAll(".topicItem").forEach((node) => {
      node.addEventListener("click", () => {
        card.dataset.topic = node.dataset.topic || "";
        renderTopicsInto(card);
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty">Failed to load topics: ${escapeHtml(e.message || e)}</div>`;
  }
}

function addConditionRow(data = {}) {
  const node = el("conditionTemplate").content.firstElementChild.cloneNode(true);
  node.querySelector(".condDevice").innerHTML = deviceOptionsHtml(data.device_id || devices[0]?.id || "");
  node.querySelector(".condType").value = data.type || "onvif_event";
  node.dataset.topic = data.topic || "";
  node.querySelector(".btnRemoveCondition").addEventListener("click", () => node.remove());
  node.querySelector(".condType").addEventListener("change", async () => {
    syncConditionTopicUi(node);
    await renderTopicsInto(node);
  });
  node.querySelector(".condDevice").addEventListener("change", async () => {
    node.dataset.topic = "";
    await renderTopicsInto(node);
  });
  node.querySelector(".topicSearch").addEventListener("input", async () => renderTopicsInto(node));
  node.querySelector(".btnLoadTopics").addEventListener("click", async () => {
    topicCache.delete(node.querySelector(".condDevice").value);
    await renderTopicsInto(node);
  });
  syncConditionTopicUi(node);
  el("conditionsList").appendChild(node);
  renderTopicsInto(node);
}

function syncActionUi(card) {
  const wrap = card.querySelector(".snapshotDeviceWrap");
  wrap.style.display = card.querySelector(".actionType").value === "take_snapshot" ? "block" : "none";
}

function addActionRow(data = {}) {
  const node = el("actionTemplate").content.firstElementChild.cloneNode(true);
  node.querySelector(".snapshotDevice").innerHTML = deviceOptionsHtml(data.camera_device_id || devices[0]?.id || "");
  node.querySelector(".actionType").value = data.type || "create_log_event";
  node.querySelector(".btnRemoveAction").addEventListener("click", () => node.remove());
  node.querySelector(".actionType").addEventListener("change", () => syncActionUi(node));
  syncActionUi(node);
  el("actionsList").appendChild(node);
}

function clearEditor() {
  selectedRuleId = null;
  el("ruleName").value = "";
  el("ruleEnabled").checked = true;
  el("conditionsList").innerHTML = "";
  el("actionsList").innerHTML = "";
  addConditionRow();
  addActionRow();
  setStatus("New rule");
  syncDeleteButton();
  renderRules();
}

function getEditorPayload() {
  const name = el("ruleName").value.trim();
  const enabled = el("ruleEnabled").checked;
  const conditions = [...el("conditionsList").children].map((card) => {
    const type = card.querySelector(".condType").value;
    const device_id = card.querySelector(".condDevice").value;
    const out = { type, device_id };
    if (type === "onvif_event") out.topic = card.dataset.topic || "";
    return out;
  });
  const actions = [...el("actionsList").children].map((card) => {
    const type = card.querySelector(".actionType").value;
    const out = { type };
    if (type === "take_snapshot") out.camera_device_id = card.querySelector(".snapshotDevice").value;
    return out;
  });
  return { name, enabled, conditions, actions };
}

function fillEditor(rule) {
  selectedRuleId = rule?.id || null;
  el("ruleName").value = rule?.name || "";
  el("ruleEnabled").checked = !!rule?.enabled;
  el("conditionsList").innerHTML = "";
  el("actionsList").innerHTML = "";
  (rule?.conditions || []).forEach(addConditionRow);
  (rule?.actions || []).forEach(addActionRow);
  if (!rule?.conditions?.length) addConditionRow();
  if (!rule?.actions?.length) addActionRow();
  setStatus(rule ? `Editing ${rule.name}` : "New rule");
  syncDeleteButton();
  renderRules();
}

function syncDeleteButton() {
  el("btnDelete").disabled = !selectedRuleId;
}

function renderRules() {
  const box = el("rulesList");
  if (!rules.length) {
    box.innerHTML = `<div class="empty">No rules saved yet.</div>`;
    return;
  }
  box.innerHTML = rules.map((r) => `
    <div class="ruleCard" data-id="${escapeHtml(r.id)}" style="${r.id === selectedRuleId ? 'outline:1px solid rgba(124,156,255,.45)' : ''}">
      <div class="ruleMeta">
        <div>
          <div class="ruleTitle">${escapeHtml(r.name || r.id)}</div>
          <div class="mini">${r.enabled ? 'Enabled' : 'Disabled'} · ${escapeHtml(r.id)}</div>
        </div>
        <button class="btn btn-primary btnEdit" type="button">Edit</button>
      </div>
      <div class="tagRow">${(r.conditions || []).map((c) => `<span class="tag">${escapeHtml(prettyCondition(c))}</span>`).join('')}</div>
      <div class="tagRow">${(r.actions || []).map((a) => `<span class="tag">${escapeHtml(prettyAction(a))}</span>`).join('')}</div>
    </div>
  `).join("");
  box.querySelectorAll(".ruleCard").forEach((card) => {
    const id = card.dataset.id;
    card.querySelector(".btnEdit").addEventListener("click", () => {
      const rule = rules.find((r) => r.id === id);
      fillEditor(rule || null);
    });
  });
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
  if (!payload.name) throw new Error("Rule name is required.");
  if (!payload.conditions.length) throw new Error("Add at least one condition.");
  if (!payload.actions.length) throw new Error("Add at least one action.");
  for (const c of payload.conditions) {
    if (!c.device_id) throw new Error("Each condition must select a device.");
    if (c.type === "onvif_event" && !c.topic) throw new Error("Each ONVIF event condition must select a topic.");
  }
  for (const a of payload.actions) {
    if (a.type === "take_snapshot" && !a.camera_device_id) throw new Error("Snapshot action must select a camera.");
  }
  const out = selectedRuleId
    ? await api(`/api/actions/${encodeURIComponent(selectedRuleId)}`, { method: "PUT", body: JSON.stringify(payload) })
    : await api("/api/actions", { method: "POST", body: JSON.stringify(payload) });
  await refreshRules();
  fillEditor(out.item);
  setStatus("Rule saved.");
}

async function deleteSelected() {
  if (!selectedRuleId) return;
  await api(`/api/actions/${encodeURIComponent(selectedRuleId)}`, { method: "DELETE" });
  await refreshRules();
  clearEditor();
  setStatus("Rule deleted.");
}

async function init() {
  try {
    await loadDevices();
    await refreshRules();
    clearEditor();
  } catch (e) {
    setStatus(e.message || String(e), true);
  }
}

el("btnAddCondition").addEventListener("click", () => addConditionRow());
el("btnAddAction").addEventListener("click", () => addActionRow());
el("btnNew").addEventListener("click", clearEditor);
el("btnSave").addEventListener("click", async () => { try { await saveRule(); } catch (e) { setStatus(e.message || String(e), true); } });
el("btnDelete").addEventListener("click", async () => { try { await deleteSelected(); } catch (e) { setStatus(e.message || String(e), true); } });

init();