// static/devices.js
// devices.js — click row to edit; refresh button inside card; no per-item edit/delete buttons

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

// (optional hidden top refresh)
const refreshTop = document.getElementById("refreshTop");

let devices = [];
let editingId = null;
let lastProfiles = [];

function setListStatus(t) { listStatus.textContent = t; }
function setFormStatus(t) { formStatus.textContent = t; }

async function api(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const detail = data?.detail || text || res.statusText;
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  if (data === null) throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  return data;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function profileLabel(p) {
  const parts = [];
  if (p.name) parts.push(p.name);
  if (p.encoding) parts.push(String(p.encoding));
  if (p.width && p.height) parts.push(`${p.width}x${p.height}`);
  return parts.length ? parts.join(" • ") : p.token;
}

function clearProfilesUI(msg = "Fetch profiles first…") {
  lastProfiles = [];
  profilesSel.disabled = true;
  profilesSel.innerHTML = `<option>${escapeHtml(msg)}</option>`;
}

function clearRowSelection() {
  tbody.querySelectorAll("tr[data-id]").forEach(tr => tr.classList.remove("active"));
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
    // show saved profile immediately, even before fetching
    profilesSel.innerHTML = `<option value="${escapeHtml(d.profile_token)}">${escapeHtml(d.profile_label || d.profile_token)}</option>`;
    profilesSel.disabled = false;
  }

  selectRow(d.id);

  setFormStatus(
    d.profile_token
      ? "Loaded (ready). You can Fetch profiles to change it."
      : "Loaded. Fetch profiles to select one."
  );
}

function rowHtml(d) {
  const ready = !!d.profile_token;
  const readyTag = ready
    ? `<span class="okTag">YES</span>`
    : `<span class="badTag">NO</span>`;

  return `
    <tr data-id="${escapeHtml(d.id)}" role="button" tabindex="0" title="Click to edit">
      <td>${escapeHtml(d.name || "")}</td>
      <td>${escapeHtml(d.ip || "")}</td>
      <td>${readyTag}</td>
    </tr>
  `;
}

async function load() {
  setListStatus("Loading…");
  tbody.innerHTML = `<tr><td colspan="3" class="muted">Loading…</td></tr>`;

  try {
    const data = await api("/api/devices", { method: "GET" });
    devices = data.devices || [];

    if (!devices.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted">No devices yet.</td></tr>`;
      setListStatus("No devices.");
      clearForm();
      return;
    }

    tbody.innerHTML = devices.map(rowHtml).join("");
    setListStatus(`Loaded ${devices.length} device(s).`);

    // keep selection if editingId still exists
    if (editingId && devices.some(d => d.id === editingId)) {
      selectRow(editingId);
    } else {
      // don’t auto-select; user clicks to edit
      clearRowSelection();
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">Failed to load: ${escapeHtml(e.message || e)}</td></tr>`;
    setListStatus("Load failed.");
  }
}

function readCredsOnly() {
  const ip = ipEl.value.trim();
  const onvif_port = parseInt((portEl.value || "80").trim(), 10);
  const username = userEl.value.trim();
  const password = passEl.value;

  if (!ip) throw new Error("IP is required.");
  if (!username) throw new Error("Username is required.");
  if (!password) throw new Error("Password is required.");
  if (!Number.isFinite(onvif_port) || onvif_port <= 0) throw new Error("Invalid ONVIF port.");

  return { ip, onvif_port, username, password };
}

function readFormFull() {
  const name = nameEl.value.trim();
  if (!name) throw new Error("Name is required.");

  const creds = readCredsOnly();

  const profile_token = profilesSel.disabled ? null : (profilesSel.value || null);
  const selected = lastProfiles.find(p => p.token === profile_token);
  const profile_label = profile_token
    ? (selected ? profileLabel(selected) : (profilesSel.selectedOptions?.[0]?.textContent || profile_token))
    : null;

  return { name, ...creds, profile_token, profile_label };
}

async function fetchProfiles() {
  setFormStatus("Fetching profiles…");
  clearProfilesUI("Loading…");

  const creds = readCredsOnly();

  const data = await api("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });

  const profs = data.profiles || [];
  if (!profs.length) throw new Error("No profiles returned.");

  lastProfiles = profs;

  profilesSel.innerHTML = "";
  for (const p of profs) {
    const opt = document.createElement("option");
    opt.value = p.token;
    opt.textContent = profileLabel(p);
    profilesSel.appendChild(opt);
  }
  profilesSel.disabled = false;

  // keep existing saved token selected if possible
  if (editingId) {
    const d = devices.find(x => x.id === editingId);
    if (d?.profile_token) profilesSel.value = d.profile_token;
  }

  setFormStatus(`Profiles loaded (${profs.length}). Select one, then Save.`);
}

fetchBtn.addEventListener("click", async () => {
  try {
    if (!editingId && !ipEl.value.trim()) {
      throw new Error("Click a device row (or fill fields) before Fetch profiles.");
    }
    await fetchProfiles();
  } catch (e) {
    clearProfilesUI("Fetch failed");
    setFormStatus(`Error: ${String(e.message || e)}`);
  }
});

saveBtn.addEventListener("click", async () => {
  try {
    setFormStatus("Saving…");
    const payload = readFormFull();

    if (!payload.profile_token) {
      throw new Error("Select a profile before saving (Fetch profiles → choose one).");
    }

    if (editingId) {
      await api(`/api/devices/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setFormStatus("Updated (ready).");
    } else {
      await api("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setFormStatus("Created (ready).");
    }

    await load();
    clearForm();
  } catch (e) {
    setFormStatus(`Error: ${String(e.message || e)}`);
  }
});

newBtn.addEventListener("click", () => {
  editingId = null;
  formTitle.textContent = "Create device";
  delBtn.disabled = true;

  // DO NOT clear fields
  // DO clear profile selection so user explicitly selects for new device
  clearProfilesUI("Fetch profiles to select…");

  clearRowSelection();
  setFormStatus("Creating new device (fields copied). Select profile and Save.");
});

clearBtn.addEventListener("click", () => {
  clearForm();
  setFormStatus("Form cleared.");
});

delBtn.addEventListener("click", async () => {
  if (!editingId) return;
  try {
    setFormStatus("Deleting…");
    await api(`/api/devices/${encodeURIComponent(editingId)}`, { method: "DELETE" });
    setFormStatus("Deleted.");
    await load();
    clearForm();
  } catch (e) {
    setFormStatus(`Error: ${String(e.message || e)}`);
  }
});

refreshBtn.addEventListener("click", () => load());
if (refreshTop) refreshTop.addEventListener("click", () => load());

// Click row to edit (no edit/delete buttons in rows)
tbody.addEventListener("click", (ev) => {
  const tr = ev.target?.closest?.("tr[data-id]");
  if (!tr) return;
  const id = tr.getAttribute("data-id");
  const d = devices.find(x => x.id === id);
  if (!d) return;
  fillForm(d);
});

// Keyboard accessibility (Enter/Space)
tbody.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const tr = ev.target?.closest?.("tr[data-id]");
  if (!tr) return;
  ev.preventDefault();
  const id = tr.getAttribute("data-id");
  const d = devices.find(x => x.id === id);
  if (!d) return;
  fillForm(d);
});

clearForm();
load();