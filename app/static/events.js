// events.js
const el = (id) => document.getElementById(id);
let devices = [];
let items = [];

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) throw new Error((data && data.detail) ? data.detail : (txt || res.statusText));
  return data;
}

function escapeHtml(s) {
  return (s ?? "").toString().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatJson(x) {
  try { return JSON.stringify(x, null, 2); } catch { return String(x ?? ""); }
}

function currentDeviceFilter() {
  return el("deviceFilter").value || "";
}

function searchText() {
  return (el("searchInput").value || "").trim().toLowerCase();
}

function matches(item) {
  const did = currentDeviceFilter();
  if (did && item.device_id !== did && item.source_device_id !== did) return false;
  const q = searchText();
  if (!q) return true;
  return JSON.stringify(item).toLowerCase().includes(q);
}

function render() {
  const box = el("list");
  const visible = items.filter(matches);
  if (!visible.length) {
    box.innerHTML = `<div class="empty">No events found.</div>`;
    return;
  }
  box.innerHTML = visible.map((item) => {
    const trigger = item.trigger || {};
    const condition = item.condition || {};
    const results = item.results || [];
    return `
      <div class="eventCard">
        <div class="row">
          <div>
            <div class="title">${escapeHtml(item.message || item.action_rule_name || item.id)}</div>
            <div class="mini">${escapeHtml(item.ts || "")} · rule ${escapeHtml(item.action_rule_name || item.action_rule_id || "")}</div>
          </div>
          <div class="mini">${escapeHtml(item.device_name || item.device_id || "")}</div>
        </div>
        <div class="tagRow">
          <span class="tag">${escapeHtml(trigger.kind || item.kind || "event")}</span>
          <span class="tag">${escapeHtml(condition.type || "condition")}</span>
          ${results.map((r) => `<span class="tag">${escapeHtml(r.type || "action")}${r.ok === false ? " · failed" : ""}</span>`).join("")}
        </div>
        <div class="mono">${escapeHtml(formatJson(item))}</div>
      </div>
    `;
  }).join("");
}

async function loadDevices() {
  const data = await api("/api/devices");
  devices = data.devices || [];
  const sel = el("deviceFilter");
  sel.innerHTML = `<option value="">All devices</option>` + devices.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)} (${escapeHtml(d.id)})</option>`).join("");
}

async function loadEvents() {
  const did = currentDeviceFilter();
  const url = did ? `/api/action-events?device_id=${encodeURIComponent(did)}&limit=300` : `/api/action-events?limit=300`;
  const data = await api(url);
  items = data.items || [];
  render();
}

async function init() {
  await loadDevices();
  await loadEvents();
}

el("deviceFilter").addEventListener("change", () => loadEvents().catch(console.error));
el("searchInput").addEventListener("input", render);
el("btnRefresh").addEventListener("click", () => loadEvents().catch(console.error));

init().catch((e) => {
  el("list").innerHTML = `<div class="empty">Failed to load events: ${escapeHtml(e.message || e)}</div>`;
});