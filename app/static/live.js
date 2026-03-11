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

const LS_KEY = "live.sidebarHidden";
const LS_GRID_KEY = "live.gridDeviceIds";

let devices = [];
const streams = new Map();
const ptzCapsCache = new Map();
let lastStatusMessage = "Idle.";

const STREAM_STATE = {
  STARTING: "starting",
  LIVE: "live",
  ERROR: "error",
};

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

async function ptzPost(url, body = null) {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text || res.statusText;
    try {
      const parsed = text ? JSON.parse(text) : null;
      if (parsed?.detail) detail = parsed.detail;
    } catch {}
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
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

function saveGridState() {
  const ids = Array.from(streams.keys());
  localStorage.setItem(LS_GRID_KEY, JSON.stringify(ids));
}

function loadGridState() {
  try {
    const raw = localStorage.getItem(LS_GRID_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function recomputeGrid() {
  const n = streams.size;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n || 1)));
  videoGrid.style.setProperty("--cols", String(cols));
}

function profileReady(d) {
  return !!d.profile_token;
}

function isStreaming(deviceId) {
  return streams.has(deviceId);
}

function getEntry(deviceId) {
  return streams.get(deviceId) || null;
}

function setEntryState(deviceId, state, errorMessage = "") {
  const entry = getEntry(deviceId);
  if (!entry) return;

  entry.state = state;
  entry.errorMessage = errorMessage || "";

  if (state === STREAM_STATE.LIVE) {
    setTileOverlay(entry, "", false);
  } else if (state === STREAM_STATE.STARTING) {
    setTileOverlay(entry, entry.restore ? "Restoring…" : "Starting…", true);
  } else if (state === STREAM_STATE.ERROR) {
    setTileOverlay(entry, entry.errorMessage || "Stream failed", true);
  }

  applyTileStateClasses(entry);
  renderList();
}

function getVisualState(entry, ready) {
  if (!entry) {
    return {
      className: "",
      badge: ready ? "READY" : "SETUP",
      subtitle: ready ? null : "Not ready (select profile in Devices)",
    };
  }

  if (entry.state === STREAM_STATE.LIVE) {
    return {
      className: "is-live",
      badge: "LIVE",
      subtitle: "Streaming",
    };
  }

  if (entry.state === STREAM_STATE.STARTING) {
    return {
      className: "is-starting",
      badge: "STARTING",
      subtitle: "Starting…",
    };
  }

  if (entry.state === STREAM_STATE.ERROR) {
    return {
      className: "is-error",
      badge: "ERROR",
      subtitle: entry.errorMessage || "Stream error",
    };
  }

  return {
    className: "",
    badge: ready ? "READY" : "SETUP",
    subtitle: ready ? null : "Not ready (select profile in Devices)",
  };
}

function applyTileStateClasses(entry) {
  if (!entry?.tileEl) return;

  entry.tileEl.classList.remove("is-live", "is-starting", "is-error");

  if (entry.state === STREAM_STATE.LIVE) entry.tileEl.classList.add("is-live");
  if (entry.state === STREAM_STATE.STARTING) entry.tileEl.classList.add("is-starting");
  if (entry.state === STREAM_STATE.ERROR) entry.tileEl.classList.add("is-error");
}

function renderList() {
  if (!devices.length) {
    camListEl.innerHTML = `<div class="muted" style="padding:10px 2px;">No devices. Add some in Devices.</div>`;
    return;
  }

  camListEl.innerHTML = devices.map((d) => {
    const ready = profileReady(d);
    const entry = getEntry(d.id);
    const present = !!entry;

    const visual = getVisualState(entry, ready);
    const subtitle = visual.subtitle ?? (d.profile_label || d.profile_token);

    const cls = [
      "camItem",
      ready ? "ready" : "notReady",
      present ? "active" : "",
      visual.className,
    ].join(" ");

    return `
      <button class="${cls}" data-id="${d.id}" ${ready ? "" : "disabled"}>
        <div class="camItemTop">
          <div class="camName">${escapeHtml(d.name || d.ip || d.id)}</div>
          <div class="camBadge">${escapeHtml(visual.badge)}</div>
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

function normalizePtzCaps(raw) {
  return {
    ptz: !!(raw?.ptz ?? raw?.has_ptz),
    pan_tilt: !!(raw?.pan_tilt ?? raw?.has_pan_tilt),
    zoom: !!(raw?.zoom ?? raw?.has_zoom),
    profile_token: raw?.profile_token || null,
    pan_tilt_space: raw?.pan_tilt_space || null,
    zoom_space: raw?.zoom_space || null,
    raw,
  };
}

async function getPtzCaps(deviceId) {
  if (ptzCapsCache.has(deviceId)) return ptzCapsCache.get(deviceId);
  const raw = await api(`/api/ptz/capabilities/${encodeURIComponent(deviceId)}`, { method: "GET" });
  const caps = normalizePtzCaps(raw);
  ptzCapsCache.set(deviceId, caps);
  return caps;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function shapeAxis(v, deadzone = 0.14, expo = 1.35) {
  const s = Math.sign(v);
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const n = (a - deadzone) / (1 - deadzone);
  return s * Math.pow(n, expo);
}

function setTileOverlay(entry, text, visible = true) {
  if (!entry?.overlayEl) return;
  entry.overlayEl.textContent = text || "";
  entry.overlayEl.style.display = visible ? "flex" : "none";
}

function summarizeGridState() {
  const values = Array.from(streams.values());
  const liveCount = values.filter((x) => x.state === STREAM_STATE.LIVE).length;
  const errorCount = values.filter((x) => x.state === STREAM_STATE.ERROR).length;
  const startingCount = values.filter((x) => x.state === STREAM_STATE.STARTING).length;
  return { liveCount, errorCount, startingCount, total: values.length };
}

function updateOverallStatusForGrid(defaultOkMessage = null) {
  const { liveCount, errorCount, startingCount, total } = summarizeGridState();

  if (startingCount > 0) {
    setStatus(`Starting ${startingCount} camera(s)…`, "warn");
    return;
  }

  if (errorCount > 0 && liveCount === 0 && total > 0) {
    setStatus(`Showing ${total} tile(s), all failed.`, "bad");
    return;
  }

  if (errorCount > 0) {
    setStatus(`Showing ${total} tile(s): ${liveCount} live, ${errorCount} error.`, "bad");
    return;
  }

  if (total > 0) {
    setStatus(defaultOkMessage || `Showing ${total} camera(s).`, "ok");
    return;
  }

  setStatus("Stopped.", "warn");
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
        <button class="btn btn-mini btn-danger tileStopBtn" type="button">Remove</button>
      </div>

      <div class="tilePtzPanel hidden">
        <div class="tilePtzJoystickWrap">
          <div class="tilePtzJoystick" data-role="joystick">
            <div class="tilePtzCross"></div>
            <div class="tilePtzKnob"></div>
          </div>
        </div>

        <div class="tilePtzZoom">
          <button class="btn btn-mini tilePtzZoomBtn" data-zoom="0.45" type="button">＋</button>
          <button class="btn btn-mini tilePtzZoomBtn" data-zoom="-0.45" type="button">－</button>
        </div>
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

function installPtzControls(device, entry, caps) {
  const panel = entry.tileEl.querySelector(".tilePtzPanel");
  const joystick = entry.tileEl.querySelector(".tilePtzJoystick");
  const knob = entry.tileEl.querySelector(".tilePtzKnob");
  const zoomBtns = Array.from(entry.tileEl.querySelectorAll(".tilePtzZoomBtn"));

  if (!caps?.ptz) {
    panel?.classList.add("hidden");
    return;
  }

  if (!panel) return;
  panel.classList.remove("hidden");

  if (!caps.pan_tilt) {
    const wrap = entry.tileEl.querySelector(".tilePtzJoystickWrap");
    wrap?.remove();
  }

  if (!caps.zoom) {
    zoomBtns.forEach((btn) => btn.classList.add("hidden"));
  }

  let desired = { pan: 0, tilt: 0, zoom: 0 };
  let lastSent = { pan: 999, tilt: 999, zoom: 999 };
  let sending = false;
  let needsFlush = false;
  let activeJoystick = false;
  let keepAliveTimer = null;
  let keepAliveUntil = 0;
  let activeMode = "idle";
  let zoomPressCount = 0;

  function roundedDesired() {
    return {
      pan: Number(clamp(desired.pan, -1, 1).toFixed(3)),
      tilt: Number(clamp(desired.tilt, -1, 1).toFixed(3)),
      zoom: Number(clamp(desired.zoom, -1, 1).toFixed(3)),
    };
  }

  function sameCmd(a, b) {
    return a.pan === b.pan && a.tilt === b.tilt && a.zoom === b.zoom;
  }

  function isZeroCmd(cmd) {
    return Math.abs(cmd.pan) < 0.001 && Math.abs(cmd.tilt) < 0.001 && Math.abs(cmd.zoom) < 0.001;
  }

  function clearKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    keepAliveUntil = 0;
  }

  function ensureKeepAlive() {
    const current = roundedDesired();
    if (isZeroCmd(current)) {
      clearKeepAlive();
      return;
    }

    keepAliveUntil = Date.now() + 450;

    if (keepAliveTimer) return;

    keepAliveTimer = setInterval(() => {
      if (entry.cancelled || entry.state !== STREAM_STATE.LIVE) {
        clearKeepAlive();
        return;
      }

      const cmd = roundedDesired();
      if (isZeroCmd(cmd)) {
        clearKeepAlive();
        return;
      }

      if (Date.now() > keepAliveUntil) {
        clearKeepAlive();
        return;
      }

      flushMove(true).catch(() => {});
    }, 120);
  }

  async function flushMove(force = false) {
    if (entry.cancelled) return;
    if (entry.state !== STREAM_STATE.LIVE) return;

    const next = roundedDesired();

    if (!force && sameCmd(next, lastSent)) return;

    if (sending) {
      needsFlush = true;
      return;
    }

    sending = true;
    needsFlush = false;

    try {
      if (isZeroCmd(next)) {
        clearKeepAlive();
        await ptzPost(`/api/ptz/stop/${encodeURIComponent(device.id)}`);
      } else {
        ensureKeepAlive();
        await ptzPost(`/api/ptz/move/${encodeURIComponent(device.id)}`, next);
      }
      lastSent = next;
    } catch (e) {
      setStatus(`PTZ error: ${e?.message || e}`, "bad");
    } finally {
      sending = false;
      const latest = roundedDesired();
      if (needsFlush || !sameCmd(latest, lastSent)) {
        needsFlush = false;
        queueMicrotask(() => {
          flushMove(false).catch(() => {});
        });
      }
    }
  }

  function queueMove(pan, tilt, zoom = 0, force = false) {
    desired = {
      pan: clamp(pan, -1, 1),
      tilt: clamp(tilt, -1, 1),
      zoom: clamp(zoom, -1, 1),
    };
    flushMove(force).catch(() => {});
  }

  function resetKnob() {
    if (knob) knob.style.transform = "translate(-50%, -50%)";
  }

  function stopNow() {
    activeMode = "idle";
    desired = { pan: 0, tilt: 0, zoom: 0 };
    clearKeepAlive();
    resetKnob();
    flushMove(true).catch(() => {});
  }

  entry.stopPtz = stopNow;

  if (caps.pan_tilt && joystick && knob) {
    joystick.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      activeJoystick = true;
      activeMode = "joystick";

      try {
        joystick.setPointerCapture(ev.pointerId);
      } catch {}

      const rect = joystick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const maxRadius = rect.width * 0.34;

      function applyPointer(clientX, clientY, force = false) {
        const dx = clientX - cx;
        const dy = clientY - cy;
        const dist = Math.hypot(dx, dy);

        let px = 0;
        let py = 0;
        if (dist > 0) {
          const clampedDist = Math.min(dist, maxRadius);
          px = (dx / dist) * clampedDist;
          py = (dy / dist) * clampedDist;
        }

        knob.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;

        const nx = shapeAxis(px / maxRadius);
        const ny = shapeAxis((-py) / maxRadius);
        const currentZoom = activeMode === "zoom" ? desired.zoom : 0;

        queueMove(nx, ny, currentZoom, force);
      }

      function onMove(moveEv) {
        if (!activeJoystick) return;
        applyPointer(moveEv.clientX, moveEv.clientY, true);
      }

      function onUp(upEv) {
        if (!activeJoystick) return;
        activeJoystick = false;
        if (activeMode === "joystick") activeMode = "idle";
        try {
          joystick.releasePointerCapture(upEv.pointerId);
        } catch {}
        joystick.removeEventListener("pointermove", onMove);
        joystick.removeEventListener("pointerup", onUp);
        joystick.removeEventListener("pointercancel", onUp);
        joystick.removeEventListener("lostpointercapture", onUp);

        if (Math.abs(desired.zoom) > 0.001) {
          desired.pan = 0;
          desired.tilt = 0;
          resetKnob();
          flushMove(true).catch(() => {});
        } else {
          stopNow();
        }
      }

      joystick.addEventListener("pointermove", onMove);
      joystick.addEventListener("pointerup", onUp);
      joystick.addEventListener("pointercancel", onUp);
      joystick.addEventListener("lostpointercapture", onUp);

      applyPointer(ev.clientX, ev.clientY, true);
    });
  }

  if (caps.zoom) {
    zoomBtns.forEach((btn) => {
      const speed = Number(btn.getAttribute("data-zoom") || "0");

      function applyZoomStart() {
        activeMode = "zoom";
        zoomPressCount += 1;
        queueMove(desired.pan, desired.tilt, speed, true);
      }

      function applyZoomStop() {
        zoomPressCount = Math.max(0, zoomPressCount - 1);
        if (zoomPressCount > 0) return;

        if (activeJoystick) {
          desired.zoom = 0;
          flushMove(true).catch(() => {});
        } else {
          stopNow();
        }
      }

      function onDown(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        applyZoomStart();
      }

      function onUp(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        applyZoomStop();
      }

      btn.addEventListener("pointerdown", onDown);
      btn.addEventListener("pointerup", onUp);
      btn.addEventListener("pointercancel", onUp);
      btn.addEventListener("pointerleave", onUp);
      btn.addEventListener("lostpointercapture", onUp);
    });
  }

  const globalStop = () => {
    if (entry.cancelled) return;
    stopNow();
  };

  window.addEventListener("blur", globalStop);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) globalStop();
  });

  entry.cleanupPtzListeners = () => {
    clearKeepAlive();
    window.removeEventListener("blur", globalStop);
  };
}

async function startDevice(device, { restore = false } = {}) {
  const existing = getEntry(device.id);
  if (existing?.startingPromise) return existing.startingPromise;
  if (existing) return Promise.resolve();
  if (!profileReady(device)) return Promise.resolve();

  const { tile, videoEl, overlayEl } = makeTile(device);
  videoGrid.appendChild(tile);

  const entry = {
    pc: null,
    tileEl: tile,
    videoEl,
    overlayEl,
    startingPromise: null,
    cancelled: false,
    stopPtz: null,
    cleanupPtzListeners: null,
    state: STREAM_STATE.STARTING,
    errorMessage: "",
    restore,
  };

  streams.set(device.id, entry);
  applyTileStateClasses(entry);
  saveGridState();
  recomputeGrid();
  renderList();
  updateOverallStatusForGrid();

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

      const curAfterApi = getEntry(device.id);
      if (!curAfterApi || curAfterApi.cancelled) return;

      try {
        const caps = await getPtzCaps(device.id);
        console.log("PTZ caps", device.id, caps);
        installPtzControls(device, curAfterApi, caps);
      } catch (e) {
        console.error("PTZ init failed", device.id, e);
      }

      setTileOverlay(curAfterApi, "Connecting WebRTC…", true);

      const pc = await startWhep(device.id, videoEl, (st) => {
        const cur = getEntry(device.id);
        if (!cur || cur.cancelled) return;

        if (st === "connected") {
          setEntryState(device.id, STREAM_STATE.LIVE);
          updateOverallStatusForGrid();
        } else if (st === "failed" || st === "disconnected") {
          setEntryState(device.id, STREAM_STATE.ERROR, `WebRTC ${st}`);
          updateOverallStatusForGrid();
        }
      });

      const cur = getEntry(device.id);
      if (!cur || cur.cancelled) {
        try {
          pc.close();
        } catch {}
        return;
      }

      cur.pc = pc;
      setEntryState(device.id, STREAM_STATE.LIVE);
      saveGridState();
      updateOverallStatusForGrid();
    } catch (e) {
      const cur = getEntry(device.id);
      if (cur && !cur.cancelled) {
        stopPc(cur.pc, cur.videoEl);
        cur.pc = null;
        setEntryState(device.id, STREAM_STATE.ERROR, e?.message || String(e));
        saveGridState();
        updateOverallStatusForGrid();
      }
    } finally {
      const cur = getEntry(device.id);
      if (cur) cur.startingPromise = null;
    }
  })();

  return entry.startingPromise;
}

async function stopDevice(deviceId, { skipApiStop } = { skipApiStop: false }) {
  const entry = getEntry(deviceId);
  if (!entry) return;

  entry.cancelled = true;

  try {
    entry.stopPtz?.();
  } catch {}

  try {
    entry.cleanupPtzListeners?.();
  } catch {}

  const { pc, tileEl, videoEl } = entry;
  stopPc(pc, videoEl);

  try {
    tileEl?.remove?.();
  } catch {}

  streams.delete(deviceId);
  saveGridState();

  recomputeGrid();
  renderList();

  if (!skipApiStop) {
    fetch(`/api/stop/${encodeURIComponent(deviceId)}`, { method: "POST" }).catch(() => {});
  }

  updateOverallStatusForGrid();
}

async function restoreGrid() {
  const savedIds = loadGridState();
  if (!savedIds.length) return;

  const byId = new Map(devices.map((d) => [d.id, d]));
  const toRestore = savedIds
    .map((id) => byId.get(id))
    .filter((d) => d && profileReady(d));

  if (!toRestore.length) return;

  setStatus(`Restoring ${toRestore.length} camera(s)…`, "warn");

  await Promise.allSettled(
    toRestore.map((d) => startDevice(d, { restore: true }))
  );

  updateOverallStatusForGrid(`Restored ${toRestore.length} camera(s).`);
}

camListEl.addEventListener("click", (ev) => {
  const btn = ev.target.closest?.("button[data-id]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const d = devices.find((x) => x.id === id);
  if (!d) return;

  if (isStreaming(d.id)) stopDevice(d.id).catch(() => {});
  else startDevice(d).catch(() => {});
});

reloadBtn.addEventListener("click", () => loadDevices());

startAllBtn.addEventListener("click", async () => {
  const ready = devices.filter(profileReady);
  const toStart = ready.filter((d) => !isStreaming(d.id));
  if (!toStart.length) return;

  setStatus(`Starting ${toStart.length} camera(s)…`, "warn");

  await Promise.allSettled(
    toStart.map((d) => startDevice(d))
  );

  updateOverallStatusForGrid(`Showing ${streams.size} camera(s).`);
});

stopAllBtn.addEventListener("click", async () => {
  setStatus("Stopping all…", "warn");
  await Promise.allSettled(
    Array.from(streams.keys()).map((id) => stopDevice(id))
  );
  setStatus("Stopped.", "warn");
});

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

(async function init() {
  await loadDevices();
  await restoreGrid();
})();