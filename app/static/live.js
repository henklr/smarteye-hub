// live.js — left-side camera list with toggle + auto-switch
const dot = document.getElementById('dot');
const pillText = document.getElementById('pillText');
const statusText = document.getElementById('statusText');

const video = document.getElementById('video');
const stopBtn = document.getElementById('stop');

const camListEl = document.getElementById('camList');
const reloadBtn = document.getElementById('reload');

const activeNameEl = document.getElementById('activeName');
const pathCodeEl = document.getElementById('pathCode');
const whepEl = document.getElementById('whepUrl');
const playerEl = document.getElementById('playerUrl');

// sidebar toggle controls
const layoutEl = document.getElementById('liveLayout');
const sidebarEl = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggleSidebar');
const showSidebarBtn = document.getElementById('showSidebar');

let pc = null;
let devices = [];
let activeDevice = null;     // device object currently streaming (or null)
let isStarting = false;

function setPill(state, text) {
  pillText.textContent = text;
  dot.className = "dot";
  if (state === "ok") dot.classList.add("ok");
  else if (state === "bad") dot.classList.add("bad");
}

function setStatus(msg, state = "warn") {
  statusText.textContent = msg;
  setPill(state, msg.slice(0, 40));
}

function getWhepUrl(deviceId) {
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return `${proto}//${host}:8889/cam-${encodeURIComponent(deviceId)}/whep`;
}

function updateUrls() {
  if (!activeDevice?.id) {
    activeNameEl.textContent = "(none)";
    pathCodeEl.textContent = "(none)";
    whepEl.textContent = "(select a camera)";
    playerEl.textContent = "(select a camera)";
    return;
  }
  const whepUrl = getWhepUrl(activeDevice.id);
  activeNameEl.textContent = activeDevice.name || activeDevice.ip || activeDevice.id;
  pathCodeEl.textContent = `cam-${activeDevice.id}`;
  whepEl.textContent = whepUrl;
  playerEl.textContent = whepUrl.replace(/\/whep$/, '');
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const detail = data?.detail || text || res.statusText;
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return data;
}

function stopWhepOnly() {
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
  if (video.srcObject) {
    try { video.srcObject.getTracks().forEach(t => t.stop()); } catch {}
    video.srcObject = null;
  }
}

async function stopAll() {
  stopWhepOnly();
  try { await fetch("/api/stop", { method: "POST" }); } catch {}
  stopBtn.disabled = true;
  setStatus("Stopped.", "warn");
}

function waitIceGatheringComplete(pc, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);

    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

async function startWhep(deviceId) {
  stopWhepOnly();
  pc = new RTCPeerConnection();

  pc.ontrack = (e) => { video.srcObject = e.streams[0]; };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") setStatus("Streaming.", "ok");
    else if (st === "failed" || st === "disconnected") setStatus(`WebRTC ${st}.`, "bad");
  };

  pc.addTransceiver("video", { direction: "recvonly" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGatheringComplete(pc, 2000);

  const res = await fetch(getWhepUrl(deviceId), {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription.sdp,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`WHEP failed (${res.status}): ${t || res.statusText}`);
  }

  const answerSdp = await res.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function renderList() {
  if (!devices.length) {
    camListEl.innerHTML = `<div class="muted" style="padding:10px 2px;">No devices. Add some in Devices.</div>`;
    return;
  }

  camListEl.innerHTML = devices.map(d => {
    const ready = !!d.profile_token;
    const active = activeDevice?.id === d.id;
    const cls = [
      "camItem",
      ready ? "ready" : "notReady",
      active ? "active" : ""
    ].join(" ");

    const subtitle = ready
      ? (d.profile_label || d.profile_token)
      : "Not ready (select profile in Devices)";

    return `
      <button class="${cls}" data-id="${d.id}" ${ready ? "" : "disabled"}>
        <div class="camItemTop">
          <div class="camName">${escapeHtml(d.name || d.ip || d.id)}</div>
          <div class="camBadge">${active ? "LIVE" : (ready ? "READY" : "SETUP")}</div>
        </div>
        <div class="camSub">${escapeHtml(subtitle)}</div>
      </button>
    `;
  }).join("");
}

async function loadDevices() {
  setStatus("Loading devices…", "warn");
  try {
    const data = await api("/api/devices", { method: "GET" });
    devices = data.devices || [];
    renderList();

    if (!activeDevice) setStatus("Select a camera to start.", "warn");
    else renderList();
  } catch (e) {
    camListEl.innerHTML = `<div class="muted" style="padding:10px 2px;">Failed to load devices: ${escapeHtml(e.message || e)}</div>`;
    setStatus(`Device load error: ${e?.message || e}`, "bad");
  }
}

async function toggleDevice(device) {
  if (isStarting) return;
  if (!device?.profile_token) return;

  // Clicking active camera toggles off
  if (activeDevice?.id === device.id) {
    setStatus(`Stopping ${device.name || device.ip}…`, "warn");
    activeDevice = null;
    updateUrls();
    renderList();
    await stopAll();
    return;
  }

  // Switching cameras: stop then start new
  isStarting = true;
  setStatus(`Switching to ${device.name || device.ip}…`, "warn");

  try {
    await stopAll();

    await api("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ip: device.ip,
        onvif_port: device.onvif_port ?? 80,
        username: device.username,
        password: device.password,
        profile_token: device.profile_token,
        device_id: device.id
      })
    });

    activeDevice = device;
    updateUrls();
    renderList();

    await startWhep(device.id);

    stopBtn.disabled = false;
    setStatus(`Streaming: ${device.name || device.ip}`, "ok");
  } catch (e) {
    activeDevice = null;
    updateUrls();
    renderList();
    stopWhepOnly();
    setStatus(`Error: ${e?.message || e}`, "bad");
  } finally {
    isStarting = false;
  }
}

camListEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest?.("button[data-id]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const d = devices.find(x => x.id === id);
  if (!d) return;
  toggleDevice(d);
});

reloadBtn.addEventListener("click", () => loadDevices());

stopBtn.addEventListener("click", async () => {
  if (!activeDevice) return;
  await toggleDevice(activeDevice);
});

// ---- Sidebar hide/show ----
const LS_KEY = "live.sidebarHidden";

function setSidebarHidden(hidden) {
  layoutEl.classList.toggle("sidebarHidden", !!hidden);
  // show the small "Show cameras" button when hidden
  showSidebarBtn.style.display = hidden ? "inline-flex" : "none";
  localStorage.setItem(LS_KEY, hidden ? "1" : "0");
}

toggleSidebarBtn.addEventListener("click", () => setSidebarHidden(true));
showSidebarBtn.addEventListener("click", () => setSidebarHidden(false));

// init state from localStorage
setSidebarHidden(localStorage.getItem(LS_KEY) === "1");

updateUrls();
setStatus("Loading…", "warn");
stopBtn.disabled = true;
loadDevices();