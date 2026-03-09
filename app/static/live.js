// static/live.js

const dot = document.getElementById("dot");
const pillText = document.getElementById("pillText");
const statusPill = document.getElementById("statusPill");

const camListEl = document.getElementById("camList");
const reloadBtn = document.getElementById("reload");

const startAllBtn = document.getElementById("startAll");
const stopAllBtn = document.getElementById("stopAll");

const videoGrid = document.getElementById("videoGrid");

const layoutEl = document.getElementById("liveLayout");
const toggleSidebarBtn = document.getElementById("toggleSidebar");
const showSidebarBtn = document.getElementById("showSidebar");

let devices = [];
const streams = new Map();
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

function getWhepUrl(deviceId) {
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return `${proto}//${host}:8889/cam-${encodeURIComponent(deviceId)}/whep`;
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

function recomputeGrid() {
  const n = streams.size;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  videoGrid.style.setProperty("--cols", String(cols));
}

function profileReady(d) {
  return !!d.profile_token;
}

function isStreaming(deviceId) {
  return streams.has(deviceId);
}

function renderList() {
  if (!devices.length) {
    camListEl.innerHTML = `<div class="muted" style="padding:10px 2px;">No devices. Add some in Devices.</div>`;
    return;
  }

  camListEl.innerHTML = devices.map((d) => {
    const ready = profileReady(d);
    const active = isStreaming(d.id);

    const cls = [
      "camItem",
      ready ? "ready" : "notReady",
      active ? "active" : "",
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
    setStatus("Ready.", "ok");
  } catch (e) {
    camListEl.innerHTML = `<div class="muted" style="padding:10px 2px;">Failed to load devices: ${escapeHtml(e.message || e)}</div>`;
    setStatus(`Device load error: ${e?.message || e}`, "bad");
  }
}

function stopPc(pc, videoEl) {
  try {
    pc?.close?.();
  } catch {}

  if (videoEl?.srcObject) {
    try {
      videoEl.srcObject.getTracks().forEach((t) => t.stop());
    } catch {}
  }

  if (videoEl) videoEl.srcObject = null;
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

async function startWhep(deviceId, videoEl, onState) {
  const pc = new RTCPeerConnection();

  pc.ontrack = (e) => {
    videoEl.srcObject = e.streams[0];
  };
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);

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
  return pc;
}

function makeTile(device) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.setAttribute("data-id", device.id);

  tile.innerHTML = `
    <div class="tilePlayer">
      <video autoplay playsinline muted></video>

      <div class="tileHud">
        <div class="tileName">${escapeHtml(device.name || device.ip || device.id)}</div>
        <button class="btn btn-mini btn-danger tileStopBtn" type="button">Stop</button>
      </div>

      <div class="tileOverlay">Starting…</div>
    </div>
  `;

  const videoEl = tile.querySelector("video");
  const overlayEl = tile.querySelector(".tileOverlay");
  const stopBtn = tile.querySelector(".tileStopBtn");

  stopBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    stopDevice(device.id).catch(() => {});
  });

  return { tile, videoEl, overlayEl };
}

async function startDevice(device) {
  const existing = streams.get(device.id);
  if (existing?.startingPromise) return existing.startingPromise;
  if (streams.has(device.id) && existing?.pc) return;
  if (!profileReady(device)) return;

  const { tile, videoEl, overlayEl } = makeTile(device);
  videoGrid.appendChild(tile);

  const entry = {
    pc: null,
    tileEl: tile,
    videoEl,
    overlayEl,
    startingPromise: null,
    cancelled: false,
  };
  streams.set(device.id, entry);

  recomputeGrid();
  renderList();

  overlayEl.textContent = "Starting…";
  overlayEl.style.display = "flex";

  entry.startingPromise = (async () => {
    try {
      await api("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ip: device.ip,
          onvif_port: device.onvif_port ?? 80,
          username: device.username,
          password: device.password,
          profile_token: device.profile_token,
          device_id: device.id,
        }),
      });

      if (streams.get(device.id)?.cancelled) return;

      overlayEl.textContent = "Connecting WebRTC…";
      const pc = await startWhep(device.id, videoEl, (st) => {
        if (st === "connected") {
          overlayEl.style.display = "none";
        } else if (st === "failed" || st === "disconnected") {
          overlayEl.textContent = `WebRTC ${st}`;
          overlayEl.style.display = "flex";
        }
      });

      const cur = streams.get(device.id);
      if (!cur || cur.cancelled) {
        try {
          pc.close();
        } catch {}
        return;
      }

      cur.pc = pc;
      setStatus(`Streaming ${streams.size} camera(s).`, "ok");
    } catch (e) {
      await stopDevice(device.id, { skipApiStop: false });
      setStatus(`Error: ${e?.message || e}`, "bad");
      throw e;
    } finally {
      const cur = streams.get(device.id);
      if (cur) cur.startingPromise = null;
    }
  })();

  return entry.startingPromise;
}

async function stopDevice(deviceId, { skipApiStop } = { skipApiStop: false }) {
  const entry = streams.get(deviceId);
  if (!entry) return;

  entry.cancelled = true;

  const { pc, tileEl, videoEl } = entry;
  stopPc(pc, videoEl);

  try {
    tileEl?.remove?.();
  } catch {}

  streams.delete(deviceId);

  recomputeGrid();
  renderList();

  if (!skipApiStop) {
    fetch(`/api/stop/${encodeURIComponent(deviceId)}`, { method: "POST" }).catch(() => {});
  }

  setStatus(
    streams.size ? `Streaming ${streams.size} camera(s).` : "Stopped.",
    streams.size ? "ok" : "warn",
  );
}

camListEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest?.("button[data-id]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const d = devices.find((x) => x.id === id);
  if (!d) return;

  if (streams.has(d.id)) stopDevice(d.id).catch(() => {});
  else startDevice(d).catch(() => {});
});

reloadBtn.addEventListener("click", () => loadDevices());

startAllBtn.addEventListener("click", async () => {
  const ready = devices.filter(profileReady);
  const toStart = ready.filter((d) => !streams.has(d.id));
  if (!toStart.length) return;

  setStatus(`Starting ${toStart.length} camera(s)…`, "warn");
  const jobs = toStart.map((d) => startDevice(d));
  await Promise.allSettled(jobs);
  setStatus(`Streaming ${streams.size} camera(s).`, streams.size ? "ok" : "warn");
});

stopAllBtn.addEventListener("click", () => {
  for (const [id] of streams) stopDevice(id).catch(() => {});
  setStatus("Stopping all…", "warn");
});

const LS_KEY = "live.sidebarHidden";

function setSidebarHidden(hidden) {
  layoutEl.classList.toggle("sidebarHidden", !!hidden);
  showSidebarBtn.style.display = hidden ? "inline-flex" : "none";
  localStorage.setItem(LS_KEY, hidden ? "1" : "0");
}

toggleSidebarBtn.addEventListener("click", () => setSidebarHidden(true));
showSidebarBtn.addEventListener("click", () => setSidebarHidden(false));
setSidebarHidden(localStorage.getItem(LS_KEY) === "1");

recomputeGrid();
setStatus("Loading…", "warn");
loadDevices();