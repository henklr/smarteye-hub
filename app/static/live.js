const dot = document.getElementById("dot");
const pillText = document.getElementById("pillText");
const statusPill = document.getElementById("statusPill");

const camListEl = document.getElementById("camList");

const startAllBtn = document.getElementById("startAll");
const stopAllBtn = document.getElementById("stopAll");

const videoGrid = document.getElementById("videoGrid");

const LS_KEY = "live.sidebarHidden";
const LS_GRID_KEY = "live.gridState";
const LS_DEVICE_ORDER_KEY = "live.deviceOrder";

const RETRY_DELAY_MS = 4000;

let devices = [];
const streams = new Map();
const ptzCapsCache = new Map();
let lastStatusMessage = "Idle.";

let restoringGrid = false;
let desiredTileOrder = [];

let originalListOrder = [];

let draggedListId = null;
let lastListDropId = null;
let suppressListClickUntil = 0;

let maximizedTile = null;

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

function loadDeviceOrder() {
  try {
    const raw = localStorage.getItem(LS_DEVICE_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveDeviceOrder() {
  localStorage.setItem(
    LS_DEVICE_ORDER_KEY,
    JSON.stringify(devices.map((d) => d.id))
  );
}

function applyDeviceOrder(savedIds) {
  if (!Array.isArray(savedIds) || !savedIds.length) return;

  const byId = new Map(devices.map((d) => [d.id, d]));
  const ordered = [];

  for (const id of savedIds) {
    const d = byId.get(id);
    if (d) {
      ordered.push(d);
      byId.delete(id);
    }
  }

  for (const d of devices) {
    if (byId.has(d.id)) {
      ordered.push(d);
      byId.delete(d.id);
    }
  }

  devices = ordered;
}

function applyTileOrder(orderIds) {
  if (!Array.isArray(orderIds) || !orderIds.length) return;

  const tiles = Array.from(videoGrid.querySelectorAll(".tile[data-id]"));
  const byId = new Map(
    tiles.map((el) => [el.getAttribute("data-id"), el])
  );

  const ordered = [];

  for (const id of orderIds) {
    const tile = byId.get(id);
    if (tile) {
      ordered.push(tile);
      byId.delete(id);
    }
  }

  for (const tile of tiles) {
    const id = tile.getAttribute("data-id");
    if (byId.has(id)) {
      ordered.push(tile);
      byId.delete(id);
    }
  }

  const frag = document.createDocumentFragment();
  ordered.forEach((tile) => frag.appendChild(tile));
  videoGrid.replaceChildren(frag);
}

function syncTileOrderToDeviceOrder(save = true) {
  applyTileOrder(devices.map((d) => d.id));
  recomputeGrid();
  if (save) saveGridState();
}

function getTileAspectRatio(tile) {
  const raw = tile.style.getPropertyValue("--tile-ar") || "16 / 9";
  const parts = raw.split("/").map((x) => Number(x.trim()));
  const w = parts[0] || 16;
  const h = parts[1] || 9;
  return w / h;
}

function chunkTilesEvenly(tiles, rows) {
  const out = [];
  let index = 0;

  for (let r = 0; r < rows; r += 1) {
    const remainingTiles = tiles.length - index;
    const remainingRows = rows - r;
    const count = Math.ceil(remainingTiles / remainingRows);
    out.push(tiles.slice(index, index + count));
    index += count;
  }

  return out;
}

function getBalancedRowCount(tileCount) {
  if (tileCount <= 0) return 0;

  const isMobile = window.matchMedia("(max-width: 980px)").matches;
  if (isMobile) return tileCount;

  const sideBySide = Math.ceil(Math.sqrt(tileCount));
  return Math.ceil(tileCount / sideBySide);
}

function flattenVideoGridRows() {
  const rows = Array.from(videoGrid.querySelectorAll(".videoRow"));
  if (!rows.length) return;

  const frag = document.createDocumentFragment();

  rows.forEach((row) => {
    Array.from(row.children).forEach((child) => frag.appendChild(child));
  });

  videoGrid.replaceChildren(frag);
}

function layoutTilesMobile() {
  const tiles = Array.from(videoGrid.querySelectorAll(".tile[data-id]"));
  if (!tiles.length) return;

  if (videoGrid.querySelector(".videoRow")) {
    flattenVideoGridRows();
  }

  tiles.forEach((tile) => {
    const raw = tile.style.getPropertyValue("--tile-ar") || "16 / 9";
    tile.style.width = "100%";
    tile.style.height = "auto";
    tile.style.aspectRatio = raw;
  });
}

function layoutTilesJustified() {
  const tiles = Array.from(videoGrid.querySelectorAll(".tile[data-id]"));
  if (!tiles.length) return;

  const styles = getComputedStyle(videoGrid);
  const gap = parseFloat(styles.gap || "8") || 8;
  const containerWidth = videoGrid.clientWidth;
  if (!containerWidth) return;

  const rowCount = getBalancedRowCount(tiles.length);
  const rows = chunkTilesEvenly(tiles, rowCount);

  const frag = document.createDocumentFragment();

  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "videoRow";

    const rowRatios = row.map(getTileAspectRatio);
    const ratioSum = rowRatios.reduce((a, b) => a + b, 0);
    const gapsWidth = gap * Math.max(0, row.length - 1);

    const naturalRowHeight = (containerWidth - gapsWidth) / ratioSum;
    const rowHeight = Math.max(140, Math.min(420, naturalRowHeight));

    row.forEach((tile, i) => {
      const width = Math.round(rowHeight * rowRatios[i]);
      tile.style.aspectRatio = "";
      tile.style.height = `${Math.round(rowHeight)}px`;
      tile.style.width = `${width}px`;
      rowEl.appendChild(tile);
    });

    frag.appendChild(rowEl);
  }

  videoGrid.replaceChildren(frag);
}

function recomputeGrid() {
  if (maximizedTile) return;

  const isMobile = window.matchMedia("(max-width: 980px)").matches;
  if (isMobile) {
    layoutTilesMobile();
    return;
  }

  layoutTilesJustified();
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

function clearDisconnectTimer(entry) {
  if (!entry?.disconnectTimer) return;
  clearTimeout(entry.disconnectTimer);
  entry.disconnectTimer = null;
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
      <div class="${cls}" data-id="${d.id}" draggable="true">
        <div class="camItemTop">
          <div class="camItemTitleRow">
            <button
              class="camDragHandle"
              type="button"
              draggable="false"
              aria-label="Reorder camera"
              title="Drag to reorder"
            >⋮⋮</button>
            <div class="camName">${escapeHtml(d.name || d.ip || d.id)}</div>
          </div>
          <div class="camBadge">${escapeHtml(visual.badge)}</div>
        </div>
        <div class="camSub">${escapeHtml(subtitle)}</div>
      </div>
    `;
  }).join("");
}

async function loadDevices() {
  setStatus("Loading devices…", "warn");
  try {
    const data = await api("/api/devices", { method: "GET" });
    devices = data.devices || [];
    applyDeviceOrder(loadDeviceOrder());
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

async function startWhep(deviceId, videoEl, onState, opts = {}) {
  const { max404Retries = 5, retryDelayMs = 700 } = opts;

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

  for (let attempt = 0; attempt <= max404Retries; attempt += 1) {
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

    if (res.status !== 404 || attempt === max404Retries) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  try {
    pc.close();
  } catch {}

  throw new Error(lastError);
}

function isWhep404Error(error) {
  return /WHEP failed \(404\)/.test(String(error?.message || error || ""));
}

function warmPtzControls(device) {
  const entry = getEntry(device.id);
  if (!entry || entry.cancelled || entry.ptzInstalled) return;

  getPtzCaps(device.id)
    .then((caps) => {
      const cur = getEntry(device.id);
      if (!cur || cur.cancelled || cur.ptzInstalled) return;

      installPtzControls(device, cur, caps);
      cur.ptzInstalled = true;
    })
    .catch((e) => {
      console.error("PTZ init failed", device.id, e);
    });
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

function isMobileViewport() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function toggleTileMaximized(tile) {
  if (!tile) return;
  if (isMobileViewport()) return;

  const isSameTile = maximizedTile === tile;
  const allTiles = Array.from(videoGrid.querySelectorAll(".tile[data-id]"));

  if (isSameTile) {
    tile.classList.remove("tileMaximized");
    document.body.classList.remove("tileMaximizedMode");

    allTiles.forEach((t) => {
      t.classList.remove("tileHiddenForMax");
    });

    maximizedTile = null;
    requestAnimationFrame(recomputeGrid);
    return;
  }

  if (maximizedTile) {
    maximizedTile.classList.remove("tileMaximized");
  }

  document.body.classList.add("tileMaximizedMode");

  allTiles.forEach((t) => {
    if (t === tile) t.classList.remove("tileHiddenForMax");
    else t.classList.add("tileHiddenForMax");
  });

  tile.classList.add("tileMaximized");
  maximizedTile = tile;
}

function canToggleTileFullscreen(target) {
  if (!target) return false;
  if (isMobileViewport()) return false;

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
    if (isMobileViewport()) return;
    if (!canToggleTileFullscreen(ev.target)) return;
    ev.preventDefault();
    ev.stopPropagation();
    toggleTileMaximized(tile);
  });

  tile.addEventListener("pointerup", (ev) => {
    if (isMobileViewport()) return;
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
      ev.stopPropagation();
      toggleTileMaximized(tile);
      return;
    }

    lastTapAt = now;
    lastTapX = ev.clientX;
    lastTapY = ev.clientY;
  });
}

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && maximizedTile) {
    toggleTileMaximized(maximizedTile);
  }
});

function makeTile(device) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.setAttribute("data-id", device.id);

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
    tile.style.setProperty("--tile-ar", `${w} / ${h}`);

    const isMobile = window.matchMedia("(max-width: 980px)").matches;
    if (isMobile) {
      tile.style.aspectRatio = `${w} / ${h}`;
      tile.style.width = "100%";
      tile.style.height = "auto";
      return;
    }

    recomputeGrid();
  });

  return { tile, videoEl, overlayEl, closeBtn };
}

function getListItemFromEventTarget(target) {
  return target?.closest?.(".camItem[data-id]") || null;
}

function clearListDropMarkers() {
  camListEl.querySelectorAll(".camItem.drop-before, .camItem.drop-after").forEach((el) => {
    el.classList.remove("drop-before", "drop-after");
  });
}

function clearListDraggingState() {
  camListEl.querySelectorAll(".camItem.is-list-dragging").forEach((el) => {
    el.classList.remove("is-list-dragging");
  });
  clearListDropMarkers();
  draggedListId = null;
  lastListDropId = null;
}

function getListDropTarget(clientY, draggingEl) {
  const items = Array.from(camListEl.querySelectorAll(".camItem[data-id]"))
    .filter((el) => el !== draggingEl);

  if (!items.length) return null;

  let best = null;
  let bestScore = Infinity;

  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const cy = rect.top + rect.height / 2;
    const dy = clientY - cy;
    const score = Math.abs(dy);

    if (score < bestScore) {
      bestScore = score;
      best = { item, rect };
    }
  }

  if (!best) return null;

  const { item, rect } = best;
  const midY = rect.top + rect.height / 2;

  return {
    item,
    before: clientY < midY,
  };
}

function installListDnD() {
  camListEl.addEventListener("dragstart", (ev) => {
    const item = getListItemFromEventTarget(ev.target);
    if (!item) return;

    draggedListId = item.getAttribute("data-id");
    lastListDropId = draggedListId;
    originalListOrder = devices.map((d) => d.id);

    item.classList.add("is-list-dragging");

    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", draggedListId || "");
    }
  });

  camListEl.addEventListener("dragover", (ev) => {
    ev.preventDefault();

    const draggingEl = camListEl.querySelector(".camItem.is-list-dragging");
    if (!draggingEl) return;

    const target = getListDropTarget(ev.clientY, draggingEl);
    if (!target) return;

    clearListDropMarkers();
    target.item.classList.add(target.before ? "drop-before" : "drop-after");

    const dragId = draggingEl.getAttribute("data-id");
    const targetId = target.item.getAttribute("data-id");
    if (!dragId || !targetId || dragId === targetId) return;

    const signature = `${targetId}:${target.before ? "b" : "a"}`;
    if (signature === lastListDropId) return;

    if (target.before) {
      camListEl.insertBefore(draggingEl, target.item);
    } else {
      camListEl.insertBefore(draggingEl, target.item.nextSibling);
    }

    lastListDropId = signature;

    const orderedIds = Array.from(camListEl.querySelectorAll(".camItem[data-id]"))
      .map((el) => el.getAttribute("data-id"))
      .filter(Boolean);

    if (orderedIds.length) {
      applyDeviceOrder(orderedIds);
      syncTileOrderToDeviceOrder(false);
    }
  });

  camListEl.addEventListener("drop", (ev) => {
    ev.preventDefault();

    const draggingEl = camListEl.querySelector(".camItem.is-list-dragging");
    if (!draggingEl || !draggedListId) {
      clearListDraggingState();
      return;
    }

    const orderedIds = Array.from(camListEl.querySelectorAll(".camItem[data-id]"))
      .map((el) => el.getAttribute("data-id"))
      .filter(Boolean);

    if (orderedIds.length) {
      applyDeviceOrder(orderedIds);
      saveDeviceOrder();
      syncTileOrderToDeviceOrder(false);
      saveGridState();
    }

    originalListOrder = [];
    suppressListClickUntil = Date.now() + 250;
    clearListDraggingState();
  });

  camListEl.addEventListener("dragend", () => {
    requestAnimationFrame(() => {
      if (originalListOrder.length) {
        applyDeviceOrder(originalListOrder);
        renderList();
        syncTileOrderToDeviceOrder(false);
      }

      originalListOrder = [];
      suppressListClickUntil = Date.now() + 250;
      clearListDraggingState();
    });
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

  clearDisconnectTimer(entry);
  entry.retryCount = (entry.retryCount || 0) + 1;

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
  clearDisconnectTimer(entry);
  entry.retryScheduled = false;
  entry.connecting = true;

  stopPc(entry.pc, entry.videoEl);
  entry.pc = null;

  setEntryState(device.id, STREAM_STATE.STARTING);

  const onPcState = (st) => {
    const cur = getEntry(device.id);
    if (!cur || cur.cancelled) return;

    if (st === "connected") {
      clearDisconnectTimer(cur);
      cur.retryCount = 0;
      clearRetryTimer(cur);
      cur.retryScheduled = false;
      setEntryState(device.id, STREAM_STATE.LIVE);
      updateOverallStatusForGrid();
      if (!restoringGrid) saveGridState();
      return;
    }

    if (st === "disconnected") {
      clearDisconnectTimer(cur);
      cur.disconnectTimer = setTimeout(() => {
        const latest = getEntry(device.id);
        if (!latest || latest.cancelled) return;
        if (latest.pc?.connectionState === "disconnected") {
          handleEntryFailure(device, latest, new Error("WebRTC disconnected"));
        }
      }, 3000);
      return;
    }

    if (st === "failed") {
      clearDisconnectTimer(cur);
      handleEntryFailure(device, cur, new Error("WebRTC failed"));
      return;
    }

    if (st === "closed" && !cur.cancelled) {
      clearDisconnectTimer(cur);
      handleEntryFailure(device, cur, new Error("WebRTC closed"));
    }
  };

  try {
    warmPtzControls(device);

    let pc = null;

    if (device.preload_stream) {
      setTileOverlay(entry, "Connecting WebRTC…", true);

      try {
        pc = await startWhep(device.id, entry.videoEl, onPcState, {
          max404Retries: 0,
        });
      } catch (e) {
        if (!isWhep404Error(e)) throw e;

        const cur = getEntry(device.id);
        if (!cur || cur.cancelled) return;

        setTileOverlay(cur, "Waking stream…", true);

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

        const cur2 = getEntry(device.id);
        if (!cur2 || cur2.cancelled) return;

        setTileOverlay(cur2, "Connecting WebRTC…", true);

        pc = await startWhep(device.id, cur2.videoEl, onPcState, {
          max404Retries: 2,
          retryDelayMs: 250,
        });
      }
    } else {
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

      const cur = getEntry(device.id);
      if (!cur || cur.cancelled) return;

      setTileOverlay(cur, "Connecting WebRTC…", true);

      pc = await startWhep(device.id, cur.videoEl, onPcState, {
        max404Retries: 5,
        retryDelayMs: 400,
      });
    }

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

  const onVisibilityChange = () => {
    if (document.hidden) globalStop();
  };

  window.addEventListener("blur", globalStop);
  document.addEventListener("visibilitychange", onVisibilityChange);

  entry.cleanupPtzListeners = () => {
    clearKeepAlive();
    window.removeEventListener("blur", globalStop);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

async function startDevice(device, { restore = false } = {}) {
  if (restore) {
    try {
      const data = await api("/api/devices", { method: "GET" });
      devices = data.devices || devices;
      applyDeviceOrder(loadDeviceOrder());
      const fresh = devices.find((d) => d.id === device.id);
      if (fresh) device = fresh;
    } catch {}
  }

  const existing = getEntry(device.id);
  if (existing?.startingPromise) return existing.startingPromise;
  if (existing) return Promise.resolve();
  if (!profileReady(device)) return Promise.resolve();

  const { tile, videoEl, overlayEl, closeBtn } = makeTile(device);
  videoGrid.appendChild(tile);
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
    disconnectTimer: null,
  };

  streams.set(device.id, entry);

  const targetOrder = desiredTileOrder.length
    ? desiredTileOrder
    : devices.map((d) => d.id);

  applyTileOrder(targetOrder);

  applyTileStateClasses(entry);
  recomputeGrid();
  renderList();
  updateOverallStatusForGrid();
  updateSidebarCollapseAvailability();

  if (!restoringGrid) {
    saveGridState();
  }

  entry.startingPromise = connectEntry(device, entry);
  return entry.startingPromise;
}

async function stopDevice(deviceId, { force = false } = {}) {
  const entry = getEntry(deviceId);
  if (!entry) return;

  const { tileEl } = entry;

  if (!force && maximizedTile === tileEl) {
    toggleTileMaximized(tileEl);
    return;
  }

  entry.cancelled = true;
  clearRetryTimer(entry);
  clearDisconnectTimer(entry);
  entry.retryScheduled = false;

  try {
    entry.stopPtz?.();
  } catch {}

  try {
    entry.cleanupPtzListeners?.();
  } catch {}

  const { pc, videoEl } = entry;

  if (maximizedTile === tileEl) {
    maximizedTile = null;
    document.body.classList.remove("tileMaximizedMode");
  }

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
  updateSidebarCollapseAvailability();

  if (!restoringGrid) {
    saveGridState();
  }
}

async function restoreGrid() {
  const { openIds } = loadGridState();
  if (!openIds.length) return;

  const byId = new Map(devices.map((d) => [d.id, d]));
  const toRestore = openIds
    .map((id) => byId.get(id))
    .filter((d) => d && profileReady(d));

  if (!toRestore.length) return;

  restoringGrid = true;
  desiredTileOrder = devices.map((d) => d.id);

  setStatus(`Restoring ${toRestore.length} camera(s)…`, "warn");

  try {
    await Promise.allSettled(
      toRestore.map((d) => startDevice(d, { restore: true }))
    );
  } finally {
    restoringGrid = false;
    syncTileOrderToDeviceOrder();
    desiredTileOrder = [];
    saveGridState();
    recomputeGrid();
  }

  updateOverallStatusForGrid(`Restored ${toRestore.length} camera(s).`);
  updateSidebarCollapseAvailability();
}

camListEl.addEventListener("click", async (ev) => {
  if (Date.now() < suppressListClickUntil) return;

  const item = getListItemFromEventTarget(ev.target);
  if (!item) return;

  const id = item.getAttribute("data-id");
  const d = devices.find((x) => x.id === id);
  if (!d) return;

  if (isStreaming(d.id)) {
    await stopDevice(d.id);
  } else {
    await startDevice(d);
  }
});

startAllBtn.addEventListener("click", async () => {
  const ready = devices.filter(profileReady);
  const toStart = ready.filter((d) => !isStreaming(d.id));
  if (!toStart.length) return;

  setStatus(`Starting ${toStart.length} camera(s)…`, "warn");

  await Promise.allSettled(
    toStart.map((d) => startDevice(d))
  );

  syncTileOrderToDeviceOrder();
  saveGridState();
  updateOverallStatusForGrid(`Showing ${streams.size} camera(s).`);
});

stopAllBtn.addEventListener("click", async () => {
  setStatus("Stopping all…", "warn");

  await Promise.allSettled(
    Array.from(streams.keys()).map((id) => stopDevice(id, { force: true }))
  );

  saveGridState();
  setStatus("Stopped.", "warn");
  updateSidebarCollapseAvailability();
});

function updateSidebarCollapseAvailability() {
  const hasStreams = streams.size > 0;

  if (!hasStreams && layoutEl.classList.contains("sidebarHidden")) {
    layoutEl.classList.remove("sidebarHidden");
    localStorage.setItem(LS_KEY, "0");
  }

  if (sidebarCollapseBtn) {
    sidebarCollapseBtn.disabled = !hasStreams;
    sidebarCollapseBtn.style.opacity = hasStreams ? "" : "0.45";
    sidebarCollapseBtn.style.cursor = hasStreams ? "pointer" : "not-allowed";
    sidebarCollapseBtn.title = hasStreams ? sidebarCollapseBtn.title : "No active streams";
    sidebarCollapseBtn.setAttribute(
      "aria-label",
      hasStreams ? sidebarCollapseBtn.getAttribute("aria-label") || "Hide cameras" : "No active streams"
    );
  }

  const hidden = layoutEl.classList.contains("sidebarHidden");
  if (sidebarCollapseRailIcon) {
    const isMobile = window.matchMedia("(max-width: 980px)").matches;
    sidebarCollapseRailIcon.textContent = isMobile
      ? (hidden ? "▾" : "▴")
      : (hidden ? "❯" : "❮");
  }
}

const layoutEl = document.getElementById("liveLayout");
const sidebarCollapseBtn = document.getElementById("sidebarCollapseBtn");
const sidebarCollapseRailIcon = sidebarCollapseBtn?.querySelector(".sidebarCollapseRailIcon");

function setSidebarHidden(hidden) {
  const isMobile = window.matchMedia("(max-width: 980px)").matches;

  layoutEl.classList.toggle("sidebarHidden", !!hidden);

  if (sidebarCollapseRailIcon) {
    sidebarCollapseRailIcon.textContent = isMobile
      ? (hidden ? "▾" : "▴")
      : (hidden ? "❯" : "❮");
  }

  if (sidebarCollapseBtn) {
    const label = hidden ? "Show cameras" : "Hide cameras";
    sidebarCollapseBtn.title = label;
    sidebarCollapseBtn.setAttribute("aria-label", label);
  }

  localStorage.setItem(LS_KEY, hidden ? "1" : "0");
  requestAnimationFrame(recomputeGrid);
}

sidebarCollapseBtn?.addEventListener("click", () => {
  if (streams.size === 0) return;
  const hidden = layoutEl.classList.contains("sidebarHidden");
  setSidebarHidden(!hidden);
});

window.addEventListener("resize", () => {
  const hidden = layoutEl.classList.contains("sidebarHidden");
  setSidebarHidden(hidden);
  recomputeGrid();
});

setSidebarHidden(localStorage.getItem(LS_KEY) === "1");
updateSidebarCollapseAvailability();

recomputeGrid();
setStatus("Loading…", "warn");
installListDnD();

(async function init() {
  await loadDevices();
  await restoreGrid();
  window.addEventListener("focus", loadDevices);
})();