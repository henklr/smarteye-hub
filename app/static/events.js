const el = (id) => document.getElementById(id);

let devices = [];
let currentDevice = null;

let supported = null;   // full /api/events/properties payload
let allowTopics = [];   // [topicPath, ...]

let es = null;

// log state
let logEntries = [];
let logLevelFilters = new Set(["event", "debug", "ok", "warn", "bad"]);
let logSearchText = "";

// ---------- utils ----------
function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;");
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

function prettyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj ?? "");
  }
}

function previewSig(s) {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > 90 ? one.slice(0, 90) + "…" : one;
}

function prettyTitle(topicPath) {
  const parts = String(topicPath || "").split("/");
  return parts[parts.length - 1] || topicPath || "";
}

function updateCounts() {
  const supportedCount = supported?.topics ? supported.topics.length : 0;
  el("supportedCount").textContent = String(supportedCount);
  el("selCount").textContent = String(allowTopics.length);
}

function setDeviceChip() {
  const chip = el("deviceChip");
  if (!currentDevice) {
    chip.textContent = "No device";
    return;
  }
  chip.textContent = `${currentDevice.name} (${currentDevice.id})`;
}

function getRawTopicsText() {
  return prettyJson(supported?.raw_topic_set ?? supported?.raw ?? "(nothing loaded yet)");
}

function renderRawTopicsDialogBody() {
  el("rawTopicsBody").textContent = getRawTopicsText();
}

// ---------- log ----------
function makeLogSearchText(entry) {
  return [
    entry.ts || "",
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

    div.innerHTML =
      `<span class="k">[${escapeHtml(entry.ts)}]</span> ` +
      `<span class="lvl ${lvlClass}">${escapeHtml(entry.level)}</span> ` +
      `<span class="v">${escapeHtml(entry.msg)}</span>` +
      (entry.obj ? ` <span class="k">${escapeHtml(JSON.stringify(entry.obj))}</span>` : "");

    box.appendChild(div);
  }

  el("logShownCount").textContent = String(shown);
  el("logTotalCount").textContent = String(logEntries.length);

  syncFilterChips();
}

function addLogEntry(level, msg, obj) {
  const entry = {
    ts: new Date().toISOString(),
    level: level || "event",
    msg: msg || "",
    obj: obj || null
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

async function copyVisibleLog() {
  const visible = logEntries
    .filter(isLogVisible)
    .map((entry) => {
      const extra = entry.obj ? ` ${JSON.stringify(entry.obj)}` : "";
      return `[${entry.ts}] ${entry.level} ${entry.msg}${extra}`;
    })
    .join("\n");

  try {
    await navigator.clipboard.writeText(visible);
    addLogEntry("ok", "Copied visible log.");
  } catch (err) {
    addLogEntry("warn", "Copy visible log failed.", { error: String(err?.message || err) });
  }
}

// ---------- raw topics dialog ----------
function openRawTopicsDialog() {
  renderRawTopicsDialogBody();
  const dlg = el("rawTopicsDialog");
  if (typeof dlg.showModal === "function") dlg.showModal();
}

function closeRawTopicsDialog() {
  el("rawTopicsDialog").close();
}

// ---------- SSE ----------
function stopSSE() {
  if (es) {
    es.close();
    es = null;
  }
}

function startSSE(deviceId) {
  stopSSE();
  setPill("warn", "Connecting…");

  es = new EventSource(`/api/events/stream/${encodeURIComponent(deviceId)}`);

  es.onopen = () => setPill("ok", "Connected");

  es.onmessage = (ev) => {
    try {
      const p = JSON.parse(ev.data);
      const lvl = p.level || "event";
      addLogEntry(lvl, p.message || "event", p.extra || null);
    } catch {
      addLogEntry("warn", "bad SSE message", { data: ev.data });
    }
  };

  es.onerror = () => setPill("bad", "Disconnected");
}

// ---------- row builder ----------
function makeRow({ title, preview, detailsText, buttonText, buttonClass, disabled, onClick }) {
  const row = document.createElement("div");
  row.className = "eventRow";

  const left = document.createElement("div");
  left.className = "eventLeft";

  const top = document.createElement("div");
  top.className = "eventTop";

  const titleDiv = document.createElement("div");
  titleDiv.className = "eventTitle";
  titleDiv.textContent = title || "";

  top.appendChild(titleDiv);
  left.appendChild(top);

  const details = document.createElement("details");
  details.className = "sigDetails";

  const summary = document.createElement("summary");
  summary.innerHTML = `
    <span class="sigPill">
      <span class="sigChevron">▾</span>
      <span class="sigPreview">${escapeHtml(preview || "")}</span>
    </span>
  `;

  const body = document.createElement("div");
  body.className = "sigBody";
  body.textContent = detailsText || "";

  details.appendChild(summary);
  details.appendChild(body);
  left.appendChild(details);

  const actions = document.createElement("div");
  actions.className = "eventActions";

  const btn = document.createElement("button");
  btn.className = `btn ${buttonClass || ""}`.trim();
  btn.textContent = buttonText || "";
  btn.disabled = !!disabled;

  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick?.();
  });

  actions.appendChild(btn);

  row.appendChild(left);
  row.appendChild(actions);
  return row;
}

// ---------- render ----------
function renderAllowList() {
  const box = el("allowList");
  box.innerHTML = "";

  if (!allowTopics.length) {
    box.innerHTML = `<div class="muted" style="padding:10px 2px;">No allowlisted topics yet.</div>`;
    updateCounts();
    return;
  }

  for (const t of allowTopics) {
    const row = makeRow({
      title: prettyTitle(t),
      preview: previewSig(t),
      detailsText: `Topic path:\n${t}`,
      buttonText: "Remove",
      buttonClass: "btn-danger",
      disabled: false,
      onClick: () => {
        allowTopics = allowTopics.filter((x) => x !== t);
        renderAllowList();
        renderSupportedList();
      }
    });

    box.appendChild(row);
  }

  updateCounts();
}

function renderSupportedList() {
  const box = el("supportedList");
  box.innerHTML = "";

  const q = el("filterInput").value.trim().toLowerCase();
  const entries = (supported?.topics || []).slice();

  const filtered = q
    ? entries.filter((it) =>
        (it.path || "").toLowerCase().includes(q) ||
        (it.name || "").toLowerCase().includes(q)
      )
    : entries;

  if (!filtered.length) {
    box.innerHTML = `<div class="muted" style="padding:10px 2px;">No supported topics loaded yet. Click “Load topics”.</div>`;
    updateCounts();
    return;
  }

  for (const it of filtered) {
    const key = it.path || "";
    const already = allowTopics.includes(key);

    const detailsText =
      `Topic name:\n${it.name || "(unknown)"}\n\n` +
      `Topic path:\n${key}`;

    const row = makeRow({
      title: it.name || key,
      preview: previewSig(key),
      detailsText,
      buttonText: already ? "Added" : "Add",
      buttonClass: already ? "btn-muted" : "btn-primary",
      disabled: already,
      onClick: () => {
        if (!allowTopics.includes(key)) {
          allowTopics.push(key);
          renderAllowList();
          renderSupportedList();
        }
      }
    });

    box.appendChild(row);
  }

  updateCounts();
}

// ---------- load / select ----------
async function refreshSupportedAndAllow() {
  if (!currentDevice) return;

  supported = await api(`/api/events/properties/${encodeURIComponent(currentDevice.id)}`);
  const allow = await api(`/api/events/allowlist/${encodeURIComponent(currentDevice.id)}`);
  allowTopics = (allow.allow_topics || []).slice();

  renderSupportedList();
  renderAllowList();
  renderRawTopicsDialogBody();

  addLogEntry("ok", "Loaded ONVIF event properties + allowlist", {
    supported_topics: supported?.topics?.length || 0,
    allow: allowTopics.length,
    fixed_topic_set: supported?.fixed_topic_set ?? null
  });
}

async function selectDevice(deviceId) {
  currentDevice = devices.find((d) => d.id === deviceId) || null;

  clearLog();
  supported = null;
  allowTopics = [];
  renderSupportedList();
  renderAllowList();
  renderRawTopicsDialogBody();
  setDeviceChip();

  if (!currentDevice) {
    stopSSE();
    setPill("warn", "Idle");
    return;
  }

  startSSE(currentDevice.id);
  await refreshSupportedAndAllow();
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
    await selectDevice("");
    return;
  }

  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.id})`;
    sel.appendChild(opt);
  }

  sel.value = devices[0].id;
  await selectDevice(devices[0].id);
}

// ---------- actions ----------
async function saveAllowlist() {
  if (!currentDevice) return;

  await api(`/api/events/allowlist/${encodeURIComponent(currentDevice.id)}`, {
    method: "PUT",
    body: JSON.stringify({ allow_topics: allowTopics })
  });

  addLogEntry("ok", "Allowlist saved to device.", { allow: allowTopics.length });
}

// ---------- UI wiring ----------
el("deviceSelect").addEventListener("change", async (e) => {
  try { await selectDevice(e.target.value); }
  catch (err) { addLogEntry("bad", err.message); }
});

el("btnRefresh").addEventListener("click", async () => {
  try { await refreshSupportedAndAllow(); }
  catch (err) { addLogEntry("bad", err.message); }
});

el("btnLoadTopics").addEventListener("click", async () => {
  try { await refreshSupportedAndAllow(); }
  catch (err) { addLogEntry("bad", err.message); }
});

el("btnSaveAllow").addEventListener("click", async () => {
  try { await saveAllowlist(); }
  catch (err) { addLogEntry("bad", err.message); }
});

el("btnClearAllow").addEventListener("click", () => {
  allowTopics = [];
  renderAllowList();
  renderSupportedList();
});

el("btnClearLog").addEventListener("click", () => {
  clearLog();
});

el("btnExportLog").addEventListener("click", async () => {
  await copyVisibleLog();
});

el("btnShowRawTopics").addEventListener("click", () => {
  openRawTopicsDialog();
});

el("btnCloseRawTopics").addEventListener("click", () => {
  closeRawTopicsDialog();
});

el("filterInput").addEventListener("input", () => renderSupportedList());

el("logSearch").addEventListener("input", (e) => {
  logSearchText = (e.target.value || "").trim().toLowerCase();
  renderLog();
});

document.querySelectorAll(".filterChip").forEach((chip) => {
  chip.addEventListener("click", () => {
    toggleLogLevel(chip.dataset.level);
  });
});

el("rawTopicsDialog").addEventListener("click", (e) => {
  const dlg = el("rawTopicsDialog");
  const rect = dlg.getBoundingClientRect();
  const inside =
    e.clientX >= rect.left &&
    e.clientX <= rect.right &&
    e.clientY >= rect.top &&
    e.clientY <= rect.bottom;
  if (!inside) dlg.close();
});

// boot
loadDevices().catch((err) => addLogEntry("bad", err.message));