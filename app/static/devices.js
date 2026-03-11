const tbody = document.getElementById("devTbody");
const listStatus = document.getElementById("listStatus");
const formStatus = document.getElementById("formStatus");
const formTitle = document.getElementById("formTitle");

const nameEl = document.getElementById("name");
const ipEl = document.getElementById("ip");
const portEl = document.getElementById("onvif_port");
const userEl = document.getElementById("username");
const passEl = document.getElementById("password");

const fetchBtn = document.getElementById("fetchProfiles");
const profilesSel = document.getElementById("profiles");

const saveBtn = document.getElementById("save");
const newBtn = document.getElementById("new");
const delBtn = document.getElementById("delete");
const clearBtn = document.getElementById("clear");
const refreshBtn = document.getElementById("refresh");
const refreshTop = document.getElementById("refreshTop");

let devices = [];
let editingId = null;
let lastProfiles = [];
let statusMap = new Map();
let pollTimer = null;

function setListStatus(t) {
  listStatus.textContent = t;
}

function setFormStatus(t) {
  formStatus.textContent = t;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const detail = data?.detail || text || res.statusText;
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  if (data === null) throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  return data;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function profileLabel(p) {
  const parts = [];
  if (p.name) parts.push(p.name);
  if (p.encoding) parts.push(String(p.encoding));
  if (p.width && p.height) parts.push(`${p.width}x${p.height}`);
  if (p.recommended) parts.push("recommended");
  else if (p.browser_compatible === false) parts.push("not browser-safe");
  return parts.length ? parts.join(" • ") : p.token;
}

function clearProfilesUI(msg = "Fetch profiles first…") {
  lastProfiles = [];
  profilesSel.disabled = true;
  profilesSel.innerHTML = `<option>${escapeHtml(msg)}</option>`;
}

function clearRowSelection() {
  tbody.querySelectorAll("tr[data-id]").forEach((tr) => tr.classList.remove("active"));
}

function selectRow(deviceId) {
  clearRowSelection();
  const tr = tbody.querySelector(`tr[data-id="${CSS.escape(deviceId)}"]`);
  if (tr) tr.classList.add("active");
}

function clearForm() {
  editingId = null;
  formTitle.textContent = "Create device";
  nameEl.value = "";
  ipEl.value = "";
  portEl.value = "80";
  userEl.value = "";
  passEl.value = "";
  delBtn.disabled = true;
  clearProfilesUI();
  clearRowSelection();
  setFormStatus("Fill details, then Fetch profiles.");
}

function fillForm(d) {
  editingId = d.id;
  formTitle.textContent = `Edit device (${d.name || d.ip})`;

  nameEl.value = d.name || "";
  ipEl.value = d.ip || "";
  portEl.value = String(d.onvif_port ?? 80);
  userEl.value = d.username || "";
  passEl.value = d.password || "";
  delBtn.disabled = false;

  clearProfilesUI("Fetch profiles to select…");

  if (d.profile_token) {
    profilesSel.innerHTML = `<option value="${escapeHtml(d.profile_token)}">${escapeHtml(d.profile_label || d.profile_token)}</option>`;
    profilesSel.disabled = false;
  }

  selectRow(d.id);

  setFormStatus(
    d.profile_token
      ? "Loaded (ready). Fetch profiles to confirm you are using an H264 profile."
      : "Loaded. Fetch profiles to select one."
  );
}

function streamStatusHtml(d) {
  const st = statusMap.get(d.id);

  if (!d.profile_token) {
    return `<span class="statusChip"><span class="statusDot unknown"></span><span class="muted">N/A</span></span>`;
  }

  if (!st) {
    return `<span class="statusChip"><span class="statusDot unknown"></span><span class="muted">Checking…</span></span>`;
  }

  switch (st.status) {
    case "live":
      return `<span class="statusChip"><span class="statusDot up"></span><span class="okTag">LIVE</span></span>`;

    case "idle":
      return `<span class="statusChip"><span class="statusDot unknown"></span><span class="muted">IDLE</span></span>`;

    case "not_configured":
      return `<span class="statusChip"><span class="statusDot unknown"></span><span class="muted">N/A</span></span>`;

    case "down":
    default:
      return `<span class="statusChip"><span class="statusDot down"></span><span class="badTag">DOWN</span></span>`;
  }
}

function rowHtml(d) {
  const ready = !!d.profile_token;
  const readyTag = ready
    ? `<span class="okTag">YES</span>`
    : `<span class="badTag">NO</span>`;

  return `
    <tr data-id="${escapeHtml(d.id)}" role="button" tabindex="0">
      <td>${escapeHtml(d.name || "")}</td>
      <td>${escapeHtml(d.ip || "")}</td>
      <td>${readyTag}</td>
      <td>${streamStatusHtml(d)}</td>
    </tr>
  `;
}

function renderTable() {
  if (!devices.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No devices yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = devices.map(rowHtml).join("");

  if (editingId && devices.some((d) => d.id === editingId)) {
    selectRow(editingId);
  }
}

async function loadStatuses() {
  try {
    const data = await api("/api/device-status", { method: "GET" });
    const items = data.items || [];
    statusMap = new Map(items.map((x) => [x.device_id, x]));
    renderTable();

    const live = items.filter((x) => x.status === "live").length;
    const down = items.filter((x) => x.status === "down").length;

    setListStatus(`Loaded ${devices.length} device(s). ${live} live, ${down} down.`);
  } catch (e) {
    setListStatus(`Status check failed: ${String(e.message || e)}`);
  }
}

async function load() {
  setListStatus("Loading…");
  tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;

  try {
    const data = await api("/api/devices", { method: "GET" });
    devices = data.devices || [];

    if (!devices.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">No devices yet.</td></tr>`;
      setListStatus("No devices.");
      clearForm();
      return;
    }

    renderTable();
    setListStatus(`Loaded ${devices.length} device(s). Checking status…`);
    await loadStatuses();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Failed to load: ${escapeHtml(e.message || e)}</td></tr>`;
    setListStatus("Load failed.");
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (!devices.length) return;
    loadStatuses().catch(() => {});
  }, 5000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPolling();
  else startPolling();
});

clearForm();
load().then(startPolling);