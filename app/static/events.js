const el = (id) => document.getElementById(id);

let devices = [];
let currentDevice = null;
let eventSources = new Map();

let debugEntries = [];
let feedEntries = [];

let logLevelFilters = new Set(["event", "debug", "ok", "warn", "bad"]);
let searchText = "";
let currentView = "feed";

// ---------- utils ----------
function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function prettyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj ?? "");
  }
}

function setPill(state, text) {
  const dot = el("dot");
  const pillText = el("pillText");
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
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }

  if (!res.ok) {
    throw new Error((data && data.detail) ? data.detail : (txt || res.statusText));
  }
  return data;
}

function setDeviceChip() {
  const chip = el("deviceChip");
  if (!currentDevice) {
    chip.textContent = devices.length ? "All cameras" : "No device";
    return;
  }
  chip.textContent = `${currentDevice.name} (${currentDevice.id})`;
}

function formatWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

// ---------- event feed ----------
function feedSearchText(item) {
  return JSON.stringify(item).toLowerCase();
}

function isFeedVisible(item) {
  if (!searchText) return true;
  return feedSearchText(item).includes(searchText);
}

function renderFeed() {
  const box = el("feedBody");
  const visible = feedEntries.filter(isFeedVisible);

  if (!visible.length) {
    box.innerHTML = `<div class="feedEmpty">No action log events found.</div>`;
  } else {
    box.innerHTML = visible.map((item) => {
      const trigger = item.trigger || {};
      const condition = item.condition || {};
      const results = Array.isArray(item.results) ? item.results : [];
      const okResults = results.filter((r) => r && r.ok !== false && r.type);
      const failedResults = results.filter((r) => r && r.ok === false && r.type);

      return `
        <div class="eventItem">
          <div class="eventItemTop">
            <div>
              <div class="eventItemTitle">${escapeHtml(item.message || item.action_rule_name || "Action event")}</div>
              <div class="eventItemMeta">
                ${item.device_name ? `${escapeHtml(item.device_name)} · ` : ""}
                ${item.action_rule_name ? `Rule: ${escapeHtml(item.action_rule_name)} · ` : ""}
                ${escapeHtml(formatWhen(item.ts))}
              </div>
            </div>
            <div class="eventItemTime">${escapeHtml(trigger.kind || item.kind || "event")}</div>
          </div>

          <div class="eventTags">
            ${condition.type ? `<span class="eventTag">${escapeHtml(condition.type)}</span>` : ""}
            ${okResults.map((r) => `<span class="eventTag">${escapeHtml(r.type)}</span>`).join("")}
            ${failedResults.map((r) => `<span class="eventTag">${escapeHtml(r.type)} failed</span>`).join("")}
          </div>

          <details class="eventDetails">
            <summary>Details</summary>
            <div class="eventJson">${escapeHtml(prettyJson(item))}</div>
          </details>
        </div>
      `;
    }).join("");
  }

  el("shownCount").textContent = String(visible.length);
  el("totalCount").textContent = String(feedEntries.length);
}

async function loadFeed() {
  const did = currentDevice ? currentDevice.id : "";
  const url = did
    ? `/api/action-events?device_id=${encodeURIComponent(did)}&limit=300`
    : `/api/action-events?limit=300`;

  const out = await api(url);
  feedEntries = Array.isArray(out.items) ? out.items : [];
  if (currentView === "feed") renderFeed();
}

// ---------- debug log ----------
function makeDebugSearchText(entry) {
  return [
    entry.ts || "",
    entry.deviceName || "",
    entry.deviceId || "",
    entry.level || "",
    entry.msg || "",
    entry.obj ? JSON.stringify(entry.obj) : ""
  ].join(" ").toLowerCase();
}

function isDebugVisible(entry) {
  const level = entry.level || "event";
  if (!logLevelFilters.has(level)) return false;
  if (!searchText) return true;
  return makeDebugSearchText(entry).includes(searchText);
}

function renderDebugLog() {
  const box = el("logBody");
  box.innerHTML = "";

  let shown = 0;
  for (const entry of debugEntries) {
    if (!isDebugVisible(entry)) continue;
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

  el("shownCount").textContent = String(shown);
  el("totalCount").textContent = String(debugEntries.length);
  syncFilterChips();
}

function addDebugEntry(level, msg, obj, deviceMeta = null, explicitTs = null) {
  const entry = {
    ts: explicitTs || new Date().toISOString(),
    level: level || "event",
    msg: msg || "",
    obj: obj || null,
    deviceId: deviceMeta?.deviceId || "",
    deviceName: deviceMeta?.deviceName || ""
  };

  debugEntries.push(entry);

  if (debugEntries.length > 3000) {
    debugEntries = debugEntries.slice(-3000);
  }

  if (currentView === "debug") renderDebugLog();
}

function syncFilterChips() {
  const allChip = el("chip-all");
  const allLevels = ["event", "debug", "ok", "warn", "bad"];
  const allOn = allLevels.every((lvl) => logLevelFilters.has(lvl));

  allChip.classList.toggle("active", allOn);

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
    if (currentView === "debug") renderDebugLog();
    return;
  }

  if (logLevelFilters.has(level)) {
    logLevelFilters.delete(level);
  } else {
    logLevelFilters.add(level);
  }

  if (currentView === "debug") renderDebugLog();
}

// ---------- current view ----------
function clearCurrentView() {
  if (currentView === "feed") {
    feedEntries = [];
    renderFeed();
  } else {
    debugEntries = [];
    renderDebugLog();
  }
}

function setView(view) {
  currentView = view;

  const isFeed = view === "feed";

  el("btnShowFeed").classList.toggle("active", isFeed);
  el("btnShowDebug").classList.toggle("active", !isFeed);

  el("feedBody").style.display = isFeed ? "" : "none";
  el("logBody").style.display = isFeed ? "none" : "";
  el("debugFilters").style.display = isFeed ? "none" : "";

  el("viewTitle").textContent = isFeed ? "Event feed" : "Debug log";
  el("viewSub").textContent = isFeed
    ? "Action-created log events only."
    : "Raw worker messages + ONVIF event/debug output.";

  if (isFeed) renderFeed();
  else renderDebugLog();
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

  addDebugEntry(
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
    addDebugEntry("ok", "SSE connected", null, { deviceId: device.id, deviceName: device.name });
  };

  src.onmessage = (ev) => {
    try {
      const p = JSON.parse(ev.data);
      onSsePayload(p, device);
    } catch {
      addDebugEntry("warn", "bad SSE message", { data: ev.data }, { deviceId: device.id, deviceName: device.name });
    }
  };

  src.onerror = () => {
    setPill("bad", "Disconnected");
    addDebugEntry("warn", "SSE disconnected / reconnecting", null, { deviceId: device.id, deviceName: device.name });
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

  await loadFeed();
  startSSEForSelection();

  if (!currentDevice) {
    addDebugEntry("ok", "Listening to all cameras.");
  } else {
    addDebugEntry("ok", "Listening to one camera.", null, {
      deviceId: currentDevice.id,
      deviceName: currentDevice.name
    });
  }
}

async function loadDevices() {
  const out = await api("/api/devices");
  devices = out.devices || [];

  const sel = el("deviceSelect");
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
    feedEntries = [];
    renderFeed();
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
  await selectDevice("__all__");
}

// ---------- UI ----------
el("deviceSelect").addEventListener("change", async (e) => {
  try {
    await selectDevice(e.target.value === "__all__" ? "" : e.target.value);
  } catch (err) {
    addDebugEntry("bad", err.message);
  }
});

el("btnRefresh").addEventListener("click", async () => {
  try {
    await loadDevices();
  } catch (err) {
    addDebugEntry("bad", err.message);
  }
});

el("btnClearLog").addEventListener("click", () => {
  clearCurrentView();
});

el("searchInput").addEventListener("input", (e) => {
  searchText = (e.target.value || "").trim().toLowerCase();
  if (currentView === "feed") renderFeed();
  else renderDebugLog();
});

el("btnShowFeed").addEventListener("click", () => {
  setView("feed");
});

el("btnShowDebug").addEventListener("click", () => {
  setView("debug");
});

document.querySelectorAll(".filterChip[data-level]").forEach((chip) => {
  chip.addEventListener("click", () => {
    toggleLogLevel(chip.dataset.level);
  });
});

window.addEventListener("beforeunload", () => {
  stopSSE();
});

// boot
setView("feed");
loadDevices().catch((err) => addDebugEntry("bad", err.message));