const el = (id) => document.getElementById(id);

let devices = [];
let currentDevice = null;
let eventSources = new Map();

let logEntries = [];
let logLevelFilters = new Set(["event", "debug", "ok", "warn", "bad"]);
let logSearchText = "";

// ---------- utils ----------
function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setPill(state, text) {
  const dot = el("dot");
  const pillText = el("pillText");
  if (!dot || !pillText) return;

  pillText.textContent = text;
  dot.classList.remove("ok", "bad");
  if (state === "ok") dot.classList.add("ok");
  if (state === "bad") dot.classList.add("bad");
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts
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

function setDeviceChip() {
  const chip = el("deviceChip");
  if (!chip) return;

  if (!currentDevice) {
    chip.textContent = devices.length ? "All cameras" : "No device";
    return;
  }
  chip.textContent = `${currentDevice.name} (${currentDevice.id})`;
}

// ---------- log ----------
function makeLogSearchText(entry) {
  return [
    entry.ts || "",
    entry.deviceName || "",
    entry.deviceId || "",
    entry.level || "",
    entry.msg || "",
    entry.obj ? JSON.stringify(entry.obj) : ""
  ].join(" ").toLowerCase();
}

function isLogVisible(entry) {
  const level = entry.level || "event";
  if (!logLevelFilters.has(level)) return false;
  if (!logSearchText) return true;
  return makeLogSearchText(entry).includes(logSearchText);
}

function renderLog() {
  const box = el("log");
  const shownEl = el("logShownCount");
  const totalEl = el("logTotalCount");
  if (!box || !shownEl || !totalEl) return;

  box.innerHTML = "";

  let shown = 0;
  for (const entry of logEntries) {
    if (!isLogVisible(entry)) continue;
    shown += 1;

    const div = document.createElement("div");
    div.className = "logLine";

    const lvlClass =
      entry.level === "ok" ? "ok" :
      entry.level === "warn" ? "warn" :
      entry.level === "bad" ? "bad" :
      entry.level === "debug" ? "debug" :
      entry.level === "event" ? "event" : "";

    const deviceChunk = entry.deviceName
      ? ` <span class="k">(${escapeHtml(entry.deviceName)}${entry.deviceId ? " / " + escapeHtml(entry.deviceId) : ""})</span>`
      : "";

    div.innerHTML =
      `<span class="k">[${escapeHtml(entry.ts)}]</span> ` +
      `<span class="lvl ${lvlClass}">${escapeHtml(entry.level)}</span>` +
      deviceChunk + " " +
      `<span class="v">${escapeHtml(entry.msg)}</span>` +
      (entry.obj ? ` <span class="k">${escapeHtml(JSON.stringify(entry.obj))}</span>` : "");

    box.appendChild(div);
  }

  shownEl.textContent = String(shown);
  totalEl.textContent = String(logEntries.length);

  syncFilterChips();
}

function addLogEntry(level, msg, obj, deviceMeta = null, explicitTs = null) {
  const entry = {
    ts: explicitTs || new Date().toISOString(),
    level: level || "event",
    msg: msg || "",
    obj: obj || null,
    deviceId: deviceMeta?.deviceId || "",
    deviceName: deviceMeta?.deviceName || ""
  };

  logEntries.push(entry);

  if (logEntries.length > 3000) {
    logEntries = logEntries.slice(-3000);
  }

  renderLog();
}

function clearLog() {
  logEntries = [];
  renderLog();
}

function syncFilterChips() {
  const allChip = el("chip-all");
  const allLevels = ["event", "debug", "ok", "warn", "bad"];
  const allOn = allLevels.every((lvl) => logLevelFilters.has(lvl));

  if (allChip) allChip.classList.toggle("active", allOn);

  for (const lvl of allLevels) {
    const chip = document.querySelector(`.filterChip[data-level="${lvl}"]`);
    chip?.classList.toggle("active", logLevelFilters.has(lvl));
  }
}

function toggleLogLevel(level) {
  const allLevels = ["event", "debug", "ok", "warn", "bad"];

  if (level === "all") {
    const allOn = allLevels.every((lvl) => logLevelFilters.has(lvl));
    logLevelFilters = allOn ? new Set() : new Set(allLevels);
    renderLog();
    return;
  }

  if (logLevelFilters.has(level)) {
    logLevelFilters.delete(level);
  } else {
    logLevelFilters.add(level);
  }

  renderLog();
}

// ---------- SSE ----------
function stopSSE() {
  for (const src of eventSources.values()) {
    try { src.close(); } catch {}
  }
  eventSources.clear();
}

function connectionSummaryText() {
  if (!eventSources.size) return "Idle";
  return eventSources.size === 1 ? "Connected" : `Connected (${eventSources.size})`;
}

function onSsePayload(payload, device) {
  const lvl = payload.level || "event";
  const msg = payload.message || "event";
  const ts = payload.ts || new Date().toISOString();

  addLogEntry(
    lvl,
    msg,
    payload.extra || null,
    { deviceId: device.id, deviceName: device.name },
    ts
  );
}

function attachSSEForDevice(device) {
  const src = new EventSource(`/api/events/stream/${encodeURIComponent(device.id)}`);
  eventSources.set(device.id, src);

  src.onopen = () => {
    setPill("ok", connectionSummaryText());
    addLogEntry("ok", "SSE connected", null, { deviceId: device.id, deviceName: device.name });
  };

  src.onmessage = (ev) => {
    try {
      const p = JSON.parse(ev.data);
      onSsePayload(p, device);
    } catch {
      addLogEntry("warn", "bad SSE message", { data: ev.data }, { deviceId: device.id, deviceName: device.name });
    }
  };

  src.onerror = () => {
    setPill("bad", "Disconnected");
    addLogEntry("warn", "SSE disconnected / reconnecting", null, { deviceId: device.id, deviceName: device.name });
  };
}

function startSSEForSelection() {
  stopSSE();

  if (!devices.length) {
    setPill("warn", "Idle");
    return;
  }

  setPill("warn", "Connecting…");

  if (currentDevice) {
    attachSSEForDevice(currentDevice);
    return;
  }

  for (const device of devices) {
    attachSSEForDevice(device);
  }
}

// ---------- load / select ----------
async function selectDevice(deviceId) {
  currentDevice = devices.find((d) => d.id === deviceId) || null;
  setDeviceChip();
  startSSEForSelection();

  if (!currentDevice) {
    addLogEntry("ok", "Listening to all cameras.");
  } else {
    addLogEntry("ok", "Listening to one camera.", null, {
      deviceId: currentDevice.id,
      deviceName: currentDevice.name
    });
  }
}

async function loadDevices() {
  addLogEntry("debug", "Loading devices…");
  const out = await api("/api/devices");
  devices = out.devices || [];

  const sel = el("deviceSelect");
  if (!sel) throw new Error("deviceSelect element not found");

  sel.innerHTML = "";

  if (!devices.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No devices saved";
    sel.appendChild(opt);
    currentDevice = null;
    setDeviceChip();
    stopSSE();
    setPill("warn", "Idle");
    addLogEntry("warn", "No devices returned from /api/devices");
    return;
  }

  const allOpt = document.createElement("option");
  allOpt.value = "__all__";
  allOpt.textContent = "All cameras";
  sel.appendChild(allOpt);

  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.id})`;
    sel.appendChild(opt);
  }

  sel.value = "__all__";
  addLogEntry("ok", `Loaded ${devices.length} device(s).`);
  await selectDevice("__all__");
}

// ---------- UI wiring ----------
function wireUi() {
  const deviceSelect = el("deviceSelect");
  const btnRefresh = el("btnRefresh");
  const btnClearLog = el("btnClearLog");
  const logSearch = el("logSearch");

  if (!deviceSelect) throw new Error("Missing #deviceSelect");
  if (!btnRefresh) throw new Error("Missing #btnRefresh");
  if (!btnClearLog) throw new Error("Missing #btnClearLog");
  if (!logSearch) throw new Error("Missing #logSearch");

  deviceSelect.addEventListener("change", async (e) => {
    try {
      await selectDevice(e.target.value === "__all__" ? "" : e.target.value);
    } catch (err) {
      addLogEntry("bad", err.message);
    }
  });

  btnRefresh.addEventListener("click", async () => {
    try {
      await loadDevices();
    } catch (err) {
      addLogEntry("bad", err.message);
    }
  });

  btnClearLog.addEventListener("click", () => {
    clearLog();
  });

  logSearch.addEventListener("input", (e) => {
    logSearchText = (e.target.value || "").trim().toLowerCase();
    renderLog();
  });

  document.querySelectorAll(".filterChip").forEach((chip) => {
    chip.addEventListener("click", () => {
      toggleLogLevel(chip.dataset.level);
    });
  });

  window.addEventListener("beforeunload", () => {
    stopSSE();
  });
}

async function init() {
  try {
    wireUi();
    addLogEntry("ok", "Events page initialized.");
    await loadDevices();
  } catch (err) {
    console.error("events.js init failed", err);
    addLogEntry("bad", `Init failed: ${err.message || err}`);
    setPill("bad", "Init failed");
  }
}

init();