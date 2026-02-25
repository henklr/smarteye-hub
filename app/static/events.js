// static/events.js
const el = (id) => document.getElementById(id);

let devices = [];
let currentDevice = null;

let learned = null;     // { device_id, seen: { topicKey: {...} } }
let allowTopics = [];   // [topicKey, ...]

let es = null;

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

  dot.classList.remove("ok","bad");
  if (state === "ok") dot.classList.add("ok");
  if (state === "bad") dot.classList.add("bad");
}

function logLine(level, msg, obj) {
  const box = el("log");
  const ts = new Date().toISOString();

  const div = document.createElement("div");
  div.className = "logLine";

  const lvlClass =
    level === "ok" ? "ok" :
    level === "warn" ? "warn" :
    level === "bad" ? "bad" : "";

  div.innerHTML =
    `<span class="k">[${escapeHtml(ts)}]</span> ` +
    `<span class="lvl ${lvlClass}">${escapeHtml(level)}</span> ` +
    `<span class="v">${escapeHtml(msg)}</span>` +
    (obj ? ` <span class="k">${escapeHtml(JSON.stringify(obj))}</span>` : "");

  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) throw new Error((data && data.detail) ? data.detail : (txt || res.statusText));
  return data;
}

// ---------- time: "3s ago" ----------
function parseIsoSafe(s) {
  if (!s) return null;
  const d = new Date(s);
  if (!isFinite(d.getTime())) return null;
  return d;
}

function fmtAgo(iso) {
  const d = parseIsoSafe(iso);
  if (!d) return "";
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function refreshTimeAgo() {
  document.querySelectorAll?.(".timeAgo[data-ts]")?.forEach((node) => {
    const iso = node.getAttribute("data-ts");
    node.textContent = fmtAgo(iso);
  });
}

// ---------- SSE ----------
function stopSSE() {
  if (es) { es.close(); es = null; }
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
      logLine(lvl, p.message || "event", p.extra || null);
    } catch {
      logLine("warn", "bad SSE message", { data: ev.data });
    }
  };

  es.onerror = () => setPill("bad", "Disconnected");
}

// ---------- state UI ----------
function updateCounts() {
  const learnedCount = learned?.seen ? Object.keys(learned.seen).length : 0;
  el("learnedCount").textContent = String(learnedCount);
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

// title from topicKey (clean)
function prettyTitle(topicKey) {
  const m = topicKey.match(/data\[(.*?)\]/i);
  if (m && m[1]) return m[1];
  return topicKey.length > 36 ? topicKey.slice(0, 36) + "…" : topicKey;
}

// summary preview (monospace, short)
function previewSig(s) {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > 90 ? one.slice(0, 90) + "…" : one;
}

function makeRow({ title, count, last, preview, detailsText, buttonText, buttonClass, disabled, onClick }) {
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

  const meta = document.createElement("div");
  meta.className = "eventMeta";

  if (typeof count === "number") {
    const badge = document.createElement("span");
    badge.className = "countBadge";
    badge.innerHTML = `<span class="countDot"></span><span>${escapeHtml(String(count))}</span>`;
    meta.appendChild(badge);
  }

  if (last) {
    const ago = document.createElement("span");
    ago.className = "timeAgo";
    ago.setAttribute("data-ts", last);
    ago.textContent = fmtAgo(last);
    meta.appendChild(ago);
  }

  if (meta.childNodes.length) left.appendChild(meta);

  // compact details
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
      count: null,
      last: null,
      preview: previewSig(t),
      detailsText: `Signature:\n${t}`,
      buttonText: "Remove",
      buttonClass: "btn-danger",
      disabled: false,
      onClick: () => {
        allowTopics = allowTopics.filter(x => x !== t);
        renderAllowList();
        renderLearnedList();
      }
    });

    box.appendChild(row);
  }

  updateCounts();
}

function renderLearnedList() {
  const box = el("learnedList");
  box.innerHTML = "";

  const seen = learned?.seen || {};
  const q = el("filterInput").value.trim().toLowerCase();

  const entries = Object.entries(seen)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (b.count || 0) - (a.count || 0));

  const filtered = q ? entries.filter(it => it.key.toLowerCase().includes(q)) : entries;

  if (!filtered.length) {
    box.innerHTML = `<div class="muted" style="padding:10px 2px;">No topics yet. Click “Start learning”.</div>`;
    updateCounts();
    return;
  }

  for (const it of filtered) {
    const already = allowTopics.includes(it.key);

    const sourceKeys = (it.keys?.source || []).join(", ") || "(none)";
    const dataKeys = (it.keys?.data || []).join(", ") || "(none)";

    const detailsText =
      `Source keys:\n${sourceKeys}\n\n` +
      `Data keys:\n${dataKeys}\n\n` +
      `Signature:\n${it.key}`;

    const row = makeRow({
      title: prettyTitle(it.key),
      count: typeof it.count === "number" ? it.count : 0,
      last: it.last_seen || "",
      preview: previewSig(it.key),
      detailsText,
      buttonText: already ? "Added" : "Add",
      buttonClass: already ? "btn-muted" : "btn-primary",
      disabled: already,
      onClick: () => {
        if (!allowTopics.includes(it.key)) {
          allowTopics.push(it.key);
          renderAllowList();
          renderLearnedList();
        }
      }
    });

    box.appendChild(row);
  }

  updateCounts();
  refreshTimeAgo();
}

// ---------- load / select ----------
async function refreshLearnedAndAllow() {
  if (!currentDevice) return;

  learned = await api(`/api/events/learned/${encodeURIComponent(currentDevice.id)}`);
  const a = await api(`/api/events/allowlist/${encodeURIComponent(currentDevice.id)}`);
  allowTopics = (a.allow_topics || []).slice();

  renderAllowList();
  renderLearnedList();

  logLine("ok", "Refreshed learned topics + allowlist", {
    learned_topics: Object.keys(learned.seen || {}).length,
    allow: allowTopics.length
  });
}

async function selectDevice(deviceId) {
  currentDevice = devices.find(d => d.id === deviceId) || null;

  el("log").innerHTML = "";
  learned = null;
  allowTopics = [];
  renderAllowList();
  renderLearnedList();

  setDeviceChip();

  if (!currentDevice) {
    stopSSE();
    setPill("warn", "Idle");
    return;
  }

  // Backend workers are always running. We only connect/disconnect the SSE stream per device in the UI.
  startSSE(currentDevice.id);
  await refreshLearnedAndAllow();
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
async function startLearn() {
  if (!currentDevice) return;

  await api("/api/events/learn/start", {
    method: "POST",
    body: JSON.stringify({
      device_id: currentDevice.id,
      ip: currentDevice.ip,
      onvif_port: currentDevice.onvif_port,
      username: currentDevice.username,
      password: currentDevice.password
    })
  });

  logLine("ok", "Learning started (unfiltered).");
}

async function saveAllowlist() {
  if (!currentDevice) return;

  await api(`/api/events/allowlist/${encodeURIComponent(currentDevice.id)}`, {
    method: "PUT",
    body: JSON.stringify({ allow_topics: allowTopics })
  });

  logLine("ok", "Allowlist saved to device.", { allow: allowTopics.length });
}

// ---------- UI wiring ----------
el("deviceSelect").addEventListener("change", async (e) => {
  try { await selectDevice(e.target.value); }
  catch (err) { logLine("bad", err.message); }
});

el("btnRefresh").addEventListener("click", async () => {
  try { await refreshLearnedAndAllow(); }
  catch (err) { logLine("bad", err.message); }
});

el("btnLearnStart").addEventListener("click", async () => {
  try { await startLearn(); }
  catch (err) { logLine("bad", err.message); }
});

el("btnSaveAllow").addEventListener("click", async () => {
  try { await saveAllowlist(); }
  catch (err) { logLine("bad", err.message); }
});

el("btnClearAllow").addEventListener("click", () => {
  allowTopics = [];
  renderAllowList();
  renderLearnedList();
});

el("btnClearLog").addEventListener("click", () => {
  el("log").innerHTML = "";
});

el("filterInput").addEventListener("input", () => renderLearnedList());

// boot
loadDevices().catch(err => logLine("bad", err.message));

// keep "x ago" fresh
setInterval(refreshTimeAgo, 1000);