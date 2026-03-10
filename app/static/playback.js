// static/playback.js

const dot = document.getElementById("dot");
const pillText = document.getElementById("pillText");
const statusPill = document.getElementById("statusPill");

const reloadBtn = document.getElementById("reloadBtn");
const cameraSelect = document.getElementById("cameraSelect");
const eventNameInput = document.getElementById("eventName");
const snapshotBtn = document.getElementById("snapshotBtn");
const snapshotList = document.getElementById("snapshotList");
const snapshotStatusText = document.getElementById("snapshotStatusText");

let devices = [];
let snapshots = [];
let lastStatusMessage = "Idle.";

function setPill(state, text) {
  pillText.textContent = text;
  dot.className = "dot";
  if (state === "ok") dot.classList.add("ok");
  else if (state === "bad") dot.classList.add("bad");
}

function setStatus(msg, state = "warn") {
  lastStatusMessage = String(msg ?? "");
  setPill(state, lastStatusMessage.slice(0, 40));
}

statusPill?.addEventListener("click", () => {
  if (!lastStatusMessage) return;
  alert(lastStatusMessage);
});

function setSnapshotStatus(text) {
  snapshotStatusText.textContent = text;
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

function formatTs(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts || "";
  }
}

function renderDeviceOptions() {
  const usable = devices.filter((d) => d.profile_token);
  if (!usable.length) {
    cameraSelect.innerHTML = `<option value="">No configured cameras</option>`;
    cameraSelect.disabled = true;
    snapshotBtn.disabled = true;
    return;
  }

  cameraSelect.disabled = false;
  snapshotBtn.disabled = false;

  cameraSelect.innerHTML = usable.map((d) => {
    const label = d.name || d.ip || d.id;
    return `<option value="${escapeHtml(d.id)}">${escapeHtml(label)}</option>`;
  }).join("");
}

function renderSnapshots() {
  if (!snapshots.length) {
    snapshotList.innerHTML = `<div class="muted">No snapshots yet.</div>`;
    return;
  }

  snapshotList.innerHTML = snapshots.map((item) => {
    const label = item.device_name || item.device_id;
    return `
      <div class="card" style="padding:12px; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; margin-bottom:10px;">
          <div>
            <div style="font-weight:900; font-size:13px;">${escapeHtml(label)}</div>
            <div class="subtitle">${escapeHtml(item.event || "manual")} · ${escapeHtml(formatTs(item.ts))}</div>
          </div>
          <a class="btn btn-mini" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>
        <img
          src="${escapeHtml(item.url)}"
          alt="${escapeHtml(label)}"
          style="width:100%; display:block; border-radius:8px; border:1px solid rgba(255,255,255,.08); background:#000;"
        />
      </div>
    `;
  }).join("");
}

async function loadDevices() {
  const data = await api("/api/devices", { method: "GET" });
  devices = data.devices || [];
  renderDeviceOptions();
}

async function loadSnapshots() {
  const deviceId = cameraSelect.value || "";
  const url = deviceId
    ? `/api/playback/snapshots?device_id=${encodeURIComponent(deviceId)}`
    : "/api/playback/snapshots";

  const data = await api(url, { method: "GET" });
  snapshots = data.items || [];
  renderSnapshots();
}

async function reloadAll() {
  setStatus("Loading playback…", "warn");
  try {
    await loadDevices();
    await loadSnapshots();
    setSnapshotStatus("Ready.");
    setStatus("Playback ready.", "ok");
  } catch (e) {
    snapshotList.innerHTML = `<div class="muted">Failed to load: ${escapeHtml(e.message || e)}</div>`;
    setSnapshotStatus(`Load error: ${e?.message || e}`);
    setStatus(`Load error: ${e?.message || e}`, "bad");
  }
}

snapshotBtn.addEventListener("click", async () => {
  const deviceId = cameraSelect.value;
  const eventName = (eventNameInput.value || "").trim() || "manual_button";

  if (!deviceId) {
    setSnapshotStatus("Pick a camera first.");
    setStatus("Pick a camera first.", "bad");
    return;
  }

  snapshotBtn.disabled = true;
  setSnapshotStatus("Taking snapshot…");
  setStatus("Taking snapshot…", "warn");

  try {
    const data = await api(`/api/playback/snapshot/${encodeURIComponent(deviceId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: eventName }),
    });

    const item = data.item;
    snapshots = [item, ...snapshots];
    renderSnapshots();

    setSnapshotStatus(`Snapshot saved: ${item.filename}`);
    setStatus("Snapshot saved.", "ok");
  } catch (e) {
    setSnapshotStatus(`Snapshot failed: ${e?.message || e}`);
    setStatus(`Snapshot failed: ${e?.message || e}`, "bad");
  } finally {
    snapshotBtn.disabled = false;
  }
});

cameraSelect.addEventListener("change", () => {
  loadSnapshots().catch((e) => {
    setSnapshotStatus(`Load error: ${e?.message || e}`);
    setStatus(`Load error: ${e?.message || e}`, "bad");
  });
});

reloadBtn.addEventListener("click", () => {
  reloadAll().catch((e) => {
    setSnapshotStatus(`Load error: ${e?.message || e}`);
    setStatus(`Load error: ${e?.message || e}`, "bad");
  });
});

setStatus("Loading…", "warn");
reloadAll().catch((e) => {
  setSnapshotStatus(`Load error: ${e?.message || e}`);
  setStatus(`Load error: ${e?.message || e}`, "bad");
});