// devices.js
const tbody = document.getElementById("devTbody");
const listStatus = document.getElementById("listStatus");
const formStatus = document.getElementById("formStatus");
const formTitle = document.getElementById("formTitle");

const nameEl = document.getElementById("name");
const ipEl = document.getElementById("ip");
const portEl = document.getElementById("onvif_port");
const userEl = document.getElementById("username");
const passEl = document.getElementById("password");

const saveBtn = document.getElementById("save");
const newBtn = document.getElementById("new");
const delBtn = document.getElementById("delete");
const refreshBtn = document.getElementById("refresh");

let devices = [];
let editingId = null;

function setListStatus(t) { listStatus.textContent = t; }
function setFormStatus(t) { formStatus.textContent = t; }

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail || res.statusText);
  return data;
}

function clearForm() {
  editingId = null;
  formTitle.textContent = "Add device";
  nameEl.value = "";
  ipEl.value = "";
  portEl.value = "80";
  userEl.value = "";
  passEl.value = "";
  delBtn.disabled = true;
  setFormStatus("Ready.");
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
  setFormStatus("Loaded.");
}

function rowHtml(d) {
  const safe = (s) => String(s ?? "");
  return `
    <tr data-id="${safe(d.id)}">
      <td>${safe(d.name)}</td>
      <td>${safe(d.ip)}</td>
      <td>${safe(d.onvif_port ?? 80)}</td>
      <td>
        <div class="actions">
          <button class="btn btn-mini" data-act="edit" data-id="${safe(d.id)}">Edit</button>
          <button class="btn btn-mini btn-danger" data-act="del" data-id="${safe(d.id)}">Delete</button>
        </div>
      </td>
    </tr>
  `;
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
      return;
    }

    tbody.innerHTML = devices.map(rowHtml).join("");
    setListStatus(`Loaded ${devices.length} device(s).`);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Failed to load: ${String(e.message || e)}</td></tr>`;
    setListStatus("Load failed.");
  }
}

function readForm() {
  const name = nameEl.value.trim();
  const ip = ipEl.value.trim();
  const onvif_port = parseInt((portEl.value || "80").trim(), 10);
  const username = userEl.value.trim();
  const password = passEl.value;

  if (!name) throw new Error("Name is required.");
  if (!ip) throw new Error("IP is required.");
  if (!username) throw new Error("Username is required.");
  if (!password) throw new Error("Password is required.");
  if (!Number.isFinite(onvif_port) || onvif_port <= 0) throw new Error("Invalid ONVIF port.");

  return { name, ip, onvif_port, username, password };
}

saveBtn.addEventListener("click", async () => {
  try {
    setFormStatus("Saving…");
    const payload = readForm();

    if (editingId) {
      await api(`/api/devices/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setFormStatus("Updated.");
    } else {
      await api("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setFormStatus("Created.");
    }

    await load();
    clearForm();
  } catch (e) {
    setFormStatus(`Error: ${String(e.message || e)}`);
  }
});

newBtn.addEventListener("click", () => clearForm());

delBtn.addEventListener("click", async () => {
  if (!editingId) return;
  try {
    setFormStatus("Deleting…");
    await api(`/api/devices/${editingId}`, { method: "DELETE" });
    setFormStatus("Deleted.");
    await load();
    clearForm();
  } catch (e) {
    setFormStatus(`Error: ${String(e.message || e)}`);
  }
});

refreshBtn.addEventListener("click", () => load());

tbody.addEventListener("click", (ev) => {
  const btn = ev.target?.closest?.("button");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const act = btn.getAttribute("data-act");
  const d = devices.find(x => x.id === id);
  if (!d) return;

  if (act === "edit") fillForm(d);
  if (act === "del") {
    fillForm(d);
    delBtn.click();
  }
});

// initial
clearForm();
load();