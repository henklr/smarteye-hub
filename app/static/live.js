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
const LS_GRID_KEY = "live.gridState";

const RETRY_DELAY_MS = 4000;

let devices = [];
const streams = new Map();
const ptzCapsCache = new Map();
let lastStatusMessage = "Idle.";

let restoringGrid = false;
let desiredTileOrder = [];

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

function getTileOrder() {
  return Array.from(videoGrid.querySelectorAll(".tile[data-id]"))
    .map((el) => el.getAttribute("data-id"))
    .filter(Boolean);
}

function loadGridState() {
  try {
    const raw = localStorage.getItem(LS_GRID_KEY);
    const parsed = raw ? JSON.parse(raw) : null;

    if (Array.isArray(parsed)) {
      const ids = parsed.filter(Boolean);
      return { openIds: ids, order: ids };
    }

    const openIds = Array.isArray(parsed?.openIds) ? parsed.openIds.filter(Boolean) : [];
    const order = Array.isArray(parsed?.order) ? parsed.order.filter(Boolean) : openIds.slice();

    return { openIds, order };
  } catch {
    return { openIds: [], order: [] };
  }
}

function saveGridState() {
  const ids = getTileOrder();
  localStorage.setItem(
    LS_GRID_KEY,
    JSON.stringify({
      openIds: ids,
      order: ids,
    })
  );
}

function applyTileOrder(orderIds) {
  if (!Array.isArray(orderIds) || !orderIds.length) return;

  const tilesById = new Map(
    Array.from(videoGrid.querySelectorAll(".tile[data-id]")).map((el) => [
      el.getAttribute("data-id"),
      el,
    ])
  );

  for (const id of orderIds) {
    const tile = tilesById.get(id);
    if (tile) videoGrid.appendChild(tile);
  }
}

function applySavedTileOrder() {
  const { order } = loadGridState();
  applyTileOrder(order);
}

function recomputeGrid() {
  // CSS auto-fit handles layout now.
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

function clearRetryTimer(entry) {
  if (!entry?.retryTimer) return;
  clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
}

function setEntryState(deviceId, state, errorMessage = "") {
  const entry = getEntry(deviceId);
  if (!entry) return;

  entry.state = state;
  entry.errorMessage = errorMessage || "";

  if (state === STREAM_STATE.LIVE) {
    setTileOverlay(entry, "", false);
  } else if (state === STREAM_STATE.STARTING) {
    const label = entry.retryCount > 0
      ? `Retrying${entry.retryCount > 1 ? ` (${entry.retryCount})` : ""}…`
      : (entry.restore ? "Restoring…" : "Starting…");
    setTileOverlay(entry, label, true);
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
      badge: entry.retryCount > 0 ? "RETRYING" : "STARTING",
      subtitle: entry.retryCount > 0 ? "Retrying…" : "Starting…",
    };
  }

  if (entry.state === STREAM_STATE.ERROR) {
    return {
      className: "is-error",
      badge: "ERROR",
      subtitle: entry.retryScheduled
        ? `${entry.errorMessage || "Stream error"} — retrying soon`
        : (entry.errorMessage || "Stream error"),
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

  let lastError = "Unknown WHEP error";

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(getWhepUrl(deviceId), {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: pc.localDescription.sdp,
    });

    if (res.ok) {
      const answerSdp = await res.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      return pc;
    }

    const t = await res.text().catch(() => "");
    lastError = `WHEP failed (${res.status}): ${t || res.statusText}`;

    if (res.status !== 404) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  try {
    pc.close();
  } catch {}

  throw new Error(lastError);
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

async function toggleTileFullscreen(tile) {
  if (!tile) return;

  const fullscreenEl = document.fullscreenElement;
  if (fullscreenEl === tile) {
    await document.exitFullscreen?.().catch(() => {});
    return;
  }

  if (fullscreenEl && fullscreenEl !== tile) {
    await document.exitFullscreen?.().catch(() => {});
  }

  await tile.requestFullscreen?.().catch(() => {});
}

function canToggleTileFullscreen(target) {
  if (!target) return false;

  return !target.closest(
    ".tilePtzPanel, .tilePtzJoystick, .tilePtzZoomBtn, .tileCloseBtn"
  );
}

function installTileFullscreen(tile) {
  let lastTapAt = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  const maxDelay = 320;
  const maxMove = 24;

  tile.addEventListener("dblclick", (ev) => {
    if (!canToggleTileFullscreen(ev.target)) return;
    ev.preventDefault();
    toggleTileFullscreen(tile).catch(() => {});
  });

  tile.addEventListener("pointerup", (ev) => {
    if (ev.pointerType !== "touch") return;
    if (!canToggleTileFullscreen(ev.target)) return;

    const now = Date.now();
    const dx = ev.clientX - lastTapX;
    const dy = ev.clientY - lastTapY;
    const closeEnough = Math.hypot(dx, dy) <= maxMove;
    const quickEnough = now - lastTapAt <= maxDelay;

    if (quickEnough && closeEnough) {
      lastTapAt = 0;
      lastTapX = 0;
      lastTapY = 0;
      ev.preventDefault();
      toggleTileFullscreen(tile).catch(() => {});
      return;
    }

    lastTapAt = now;
    lastTapX = ev.clientX;
    lastTapY = ev.clientY;
  });
}

function makeTile(device) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.setAttribute("data-id", device.id);
  tile.draggable = true;

  tile.innerHTML = `
    <div class="tilePlayer">
      <video autoplay playsinline muted></video>

      <button class="tileCloseBtn" type="button" aria-label="Close stream" title="Close stream">×</button>

      <div class="tileHud">
        <div class="tileName">${escapeHtml(device.name || device.ip || device.id)}</div>
      </div>

      <div class="tilePtzPanel hidden" draggable="false">
        <div class="tilePtzJoystickWrap">
          <div class="tilePtzJoystick" data-role="joystick" draggable="false">
            <div class="tilePtzCross"></div>
            <div class="tilePtzKnob"></div>
          </div>
        </div>

        <div class="tilePtzZoom">
          <button class="btn btn-mini tilePtzZoomBtn" data-zoom="0.45" type="button" draggable="false">＋</button>
          <button class="btn btn-mini tilePtzZoomBtn" data-zoom="-0.45" type="button" draggable="false">－</button>
        </div>
      </div>

      <div class="tileOverlay">Starting…</div>
    </div>
  `;

  const videoEl = tile.querySelector("video");
  const overlayEl = tile.querySelector(".tileOverlay");
  const closeBtn = tile.querySelector(".tileCloseBtn");

  videoEl.addEventListener("loadedmetadata", () => {
    const w = videoEl.videoWidth || 16;
    const h = videoEl.videoHeight || 9;
    tile.style.aspectRatio = `${w} / ${h}`;
  });

  return { tile, videoEl, overlayEl, closeBtn };
}

function canStartTileDrag(ev) {
  const target = ev.target;
  if (!target) return false;

  return !target.closest(
    ".tilePtzPanel, .tilePtzJoystick, .tilePtzZoomBtn, .tileOverlay, video, .tileCloseBtn"
  );
}

function installTileDnD(tile) {
  tile.addEventListener("dragstart", (ev) => {
    if (!canStartTileDrag(ev)) {
      ev.preventDefault();
      return;
    }

    tile.classList.add("is-dragging");

    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", tile.getAttribute("data-id") || "");
    }
  });

  tile.addEventListener("dragend", () => {
    tile.classList.remove("is-dragging");
    tile.classList.remove("drag-armed");
    saveGridState();
  });

  tile.addEventListener("dragover", (ev) => {
    ev.preventDefault();

    const dragging = videoGrid.querySelector(".tile.is-dragging");
    if (!dragging || dragging === tile) return;

    const rect = tile.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;

    if (before) {
      videoGrid.insertBefore(dragging, tile);
    } else {
      videoGrid.insertBefore(dragging, tile.nextSibling);
    }
  });

  tile.addEventListener("drop", (ev) => {
    ev.preventDefault();
    saveGridState();
  });

  tile.addEventListener("pointerdown", (ev) => {
    if (canStartTileDrag(ev)) {
      tile.classList.add("drag-armed");
    } else {
      tile.classList.remove("drag-armed");
    }
  });

  tile.addEventListener("pointerup", () => {
    tile.classList.remove("drag-armed");
  });

  tile.addEventListener("pointercancel", () => {
    tile.classList.remove("drag-armed");
  });

  tile.addEventListener("mouseleave", () => {
    if (!tile.classList.contains("is-dragging")) {
      tile.classList.remove("drag-armed");
    }
  });
}

function scheduleRetry(device, entry) {
  if (!entry || entry.cancelled || entry.retryTimer || entry.connecting) return;

  entry.retryScheduled = true;
  clearRetryTimer(entry);

  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    entry.retryScheduled = false;

    if (entry.cancelled) return;
    connectEntry(device, entry).catch(() => {});
  }, RETRY_DELAY_MS);

  renderList();
}

function handleEntryFailure(device, entry, error) {
  if (!entry || entry.cancelled) return;

  stopPc(entry.pc, entry.videoEl);
  entry.pc = null;
  entry.connecting = false;

  const message = error?.message || String(error) || "Stream failed";
  setEntryState(device.id, STREAM_STATE.ERROR, message);

  if (!restoringGrid) {
    saveGridState();
  }

  scheduleRetry(device, entry);
  updateOverallStatusForGrid();
}

async function connectEntry(device, entry) {
  if (!entry || entry.cancelled || entry.connecting) return;
  if (!profileReady(device)) return;

  clearRetryTimer(entry);
  entry.retryScheduled = false;
  entry.connecting = true;
  entry.retryCount += 1;

  stopPc(entry.pc, entry.videoEl);
  entry.pc = null;

  setEntryState(device.id, STREAM_STATE.STARTING);

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
      if (!curAfterApi.ptzInstalled) {
        installPtzControls(device, curAfterApi, caps);
        curAfterApi.ptzInstalled = true;
      }
    } catch (e) {
      console.error("PTZ init failed", device.id, e);
    }

    setTileOverlay(curAfterApi, "Connecting WebRTC…", true);

    const pc = await startWhep(device.id, entry.videoEl, (st) => {
      const cur = getEntry(device.id);
      if (!cur || cur.cancelled) return;

      if (st === "connected") {
        cur.retryCount = 0;
        clearRetryTimer(cur);
        cur.retryScheduled = false;
        setEntryState(device.id, STREAM_STATE.LIVE);
        updateOverallStatusForGrid();
        if (!restoringGrid) saveGridState();
      } else if (st === "failed" || st === "disconnected" || st === "closed") {
        handleEntryFailure(device, cur, new Error(`WebRTC ${st}`));
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
    cur.connecting = false;
  } catch (e) {
    handleEntryFailure(device, entry, e);
  } finally {
    const cur = getEntry(device.id);
    if (cur) {
      cur.connecting = false;
      cur.startingPromise = null;
    }
  }
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

    joystick.addEventListener("dragstart", (ev) => {
      ev.preventDefault();
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
      btn.addEventListener("dragstart", (ev) => {
        ev.preventDefault();
      });
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
  try {
    const data = await api("/api/devices", { method: "GET" });
    devices = data.devices || devices;
    const fresh = devices.find((d) => d.id === device.id);
    if (fresh) device = fresh;
  } catch {}

  ptzCapsCache.delete(device.id);

  const existing = getEntry(device.id);
  if (existing?.startingPromise) return existing.startingPromise;
  if (existing) return Promise.resolve();
  if (!profileReady(device)) return Promise.resolve();

  const { tile, videoEl, overlayEl, closeBtn } = makeTile(device);
  videoGrid.appendChild(tile);
  installTileDnD(tile);
  installTileFullscreen(tile);

  closeBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    stopDevice(device.id).catch(() => {});
  });

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
    retryTimer: null,
    retryCount: 0,
    retryScheduled: false,
    connecting: false,
    ptzInstalled: false,
  };

  streams.set(device.id, entry);

  if (desiredTileOrder.length) applyTileOrder(desiredTileOrder);

  applyTileStateClasses(entry);
  recomputeGrid();
  renderList();
  updateOverallStatusForGrid();

  if (!restoringGrid) {
    saveGridState();
  }

  entry.startingPromise = connectEntry(device, entry);
  return entry.startingPromise;
}

async function stopDevice(deviceId) {
  const entry = getEntry(deviceId);
  if (!entry) return;

  entry.cancelled = true;
  clearRetryTimer(entry);
  entry.retryScheduled = false;

  try {
    entry.stopPtz?.();
  } catch {}

  try {
    entry.cleanupPtzListeners?.();
  } catch {}

  const { pc, tileEl, videoEl } = entry;
  stopPc(pc, videoEl);

  try {
    await api(`/api/stop/${encodeURIComponent(deviceId)}`, {
      method: "POST",
    });
  } catch (e) {
    console.warn("Failed to stop backend stream", deviceId, e);
  }

  try {
    tileEl?.remove?.();
  } catch {}

  streams.delete(deviceId);

  recomputeGrid();
  renderList();
  updateOverallStatusForGrid();

  if (!restoringGrid) {
    saveGridState();
  }
}

async function restoreGrid() {
  const { openIds, order } = loadGridState();
  if (!openIds.length) return;

  const byId = new Map(devices.map((d) => [d.id, d]));
  const toRestore = openIds
    .map((id) => byId.get(id))
    .filter((d) => d && profileReady(d));

  if (!toRestore.length) return;

  restoringGrid = true;
  desiredTileOrder = order.length ? order.slice() : openIds.slice();

  setStatus(`Restoring ${toRestore.length} camera(s)…`, "warn");

  try {
    await Promise.allSettled(
      toRestore.map((d) => startDevice(d, { restore: true }))
    );
  } finally {
    restoringGrid = false;
    applyTileOrder(desiredTileOrder);
    desiredTileOrder = [];
    saveGridState();
  }

  updateOverallStatusForGrid(`Restored ${toRestore.length} camera(s).`);
}

camListEl.addEventListener("click", async (ev) => {
  const btn = ev.target.closest?.("button[data-id]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const d = devices.find((x) => x.id === id);
  if (!d) return;

  if (isStreaming(d.id)) {
    await stopDevice(d.id);
  } else {
    await startDevice(d);
  }
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

  saveGridState();
  updateOverallStatusForGrid(`Showing ${streams.size} camera(s).`);
});

stopAllBtn.addEventListener("click", async () => {
  setStatus("Stopping all…", "warn");

  await Promise.allSettled(
    Array.from(streams.keys()).map((id) => stopDevice(id))
  );

  saveGridState();
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
  window.addEventListener("focus", loadDevices);
})();