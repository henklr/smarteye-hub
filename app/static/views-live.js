const videoGrid = document.getElementById("videoGrid");

const liveSidebarList = document.getElementById("viewsCameraList");
const sidebarStartAll = document.getElementById("sidebarStartAll");
const sidebarStopAll = document.getElementById("sidebarStopAll");

const LS_GRID_KEY = "live.gridState";
const LS_DEVICE_ORDER_KEY = "live.deviceOrder";
const LS_AUDIO_KEY = "live.audioState";
// Per-device live-stream quality (hd|sd) picked by the user from the
// sidebar badge. Persisted so the choice survives page reloads.
const LS_QUALITY_KEY = "live.qualityState";

function loadTileQuality(deviceId) {
  try {
    const raw = localStorage.getItem(LS_QUALITY_KEY);
    if (!raw) return "sd";
    const obj = JSON.parse(raw);
    return obj?.[deviceId] === "hd" ? "hd" : "sd";
  } catch {
    return "sd";
  }
}

function saveTileQuality(deviceId, quality) {
  try {
    const raw = localStorage.getItem(LS_QUALITY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    if (quality === "hd") {
      obj[deviceId] = "hd";
    } else {
      // SD is the default — drop the key to keep storage tidy.
      delete obj[deviceId];
    }
    localStorage.setItem(LS_QUALITY_KEY, JSON.stringify(obj));
  } catch {}
}

function deviceLiveVariants(device) {
  const raw = device?.live_variants;
  if (!Array.isArray(raw)) return ["sd"];
  const valid = raw.filter((v) => v === "hd" || v === "sd");
  return valid.length ? valid : ["sd"];
}

function effectiveLiveQuality(device) {
  // If the device is opted into only one live variant, that's what we
  // serve — the user's per-tile pick only matters when BOTH are enabled.
  const variants = deviceLiveVariants(device);
  const pref = loadTileQuality(device.id);
  if (!variants.includes(pref)) return variants[0];
  return pref;
}

function loadTileMuted(deviceId) {
  try {
    const raw = localStorage.getItem(LS_AUDIO_KEY);
    if (!raw) return true;
    const obj = JSON.parse(raw);
    return obj?.[deviceId] !== false;
  } catch {
    return true;
  }
}

function saveTileMuted(deviceId, muted) {
  try {
    const raw = localStorage.getItem(LS_AUDIO_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    obj[deviceId] = !!muted;
    localStorage.setItem(LS_AUDIO_KEY, JSON.stringify(obj));
  } catch {}
}

const RETRY_DELAY_MS = 4000;

let devices = [];

const streams = new Map();
const ptzCapsCache = new Map();

let restoringGrid = false;
let desiredTileOrder = [];

let maximizedTile = null;

const deviceStatusMap = new Map();
let statusPollTimer = null;
const STATUS_POLL_MS = 5000;

const STREAM_STATE = {
  STARTING: "starting",
  LIVE: "live",
  ERROR: "error",
};

let livePageDisposed = false;
let livePageAbortController = new AbortController();

function liveAbortSignal() {
  return livePageAbortController.signal;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function throwAbortError() {
  throw new DOMException("Page is unloading", "AbortError");
}

function abortableDelay(ms, signal = liveAbortSignal()) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Page is unloading", "AbortError"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Page is unloading", "AbortError"));
    }

    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function getWhepUrl(deviceId) {
  // Proxy WHEP through our server to avoid mixed-content issues on HTTPS.
  // SD lives at `cam-<id>` (matches the existing MediaMTX path); HD lives
  // at the sibling `cam-<id>-hd` path provisioned by main.py when the
  // device is opted into HD live viewing.
  const device = devices.find((d) => d.id === deviceId);
  const suffix = device && effectiveLiveQuality(device) === "hd" ? "-hd" : "";
  return `/api/whep/cam-${encodeURIComponent(deviceId)}${suffix}/whep`;
}

async function api(url, opts = {}) {
  const requestOpts = { ...opts };
  if (!requestOpts.signal && !requestOpts.keepalive) requestOpts.signal = liveAbortSignal();
  const res = await fetch(url, requestOpts);
  if (res.status === 401) { window.location.href = "/login"; return; }
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

async function ptzPost(url, body = null, opts = {}) {
  const requestOpts = { ...opts };
  if (!requestOpts.signal && !requestOpts.keepalive) requestOpts.signal = liveAbortSignal();
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    ...requestOpts,
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

// No-op stubs left over from the old in-page devices overlay; living callers
// in stream lifecycle / load paths invoke these but the UI now lives on /settings.
function setListStatus() {}
function updateListStatusSummary() {}
function ensureDevicesVisibleWhenNoStreams() {}
// renderList used to repaint the overlay's device list; with the overlay gone,
// the sidebar is the visible list, so existing callers just trigger a sidebar
// refresh.
function renderList() { renderSidebar(); }

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
  // Mirror the engaged-camera set so playback mode picks up the same selection.
  if (window.views?.selectedDevices) {
    window.views.selectedDevices.clear();
    for (const id of streams.keys()) window.views.selectedDevices.add(id);
  }
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

function getOptimalRowCount(tiles, containerWidth, containerHeight, gap) {
  const n = tiles.length;
  if (n <= 0) return 0;
  if (n === 1) return 1;

  if (!containerWidth || !containerHeight) {
    const cols = Math.ceil(Math.sqrt(n));
    return Math.ceil(n / cols);
  }

  let bestRowCount = 1;
  let bestMinHeight = 0;

  for (let rowCount = 1; rowCount <= n; rowCount++) {
    const rows = chunkTilesEvenly(tiles, rowCount);
    const vertGaps = gap * Math.max(0, rows.length - 1);
    const maxFromHeight = (containerHeight - vertGaps) / rows.length;

    let worstRowHeight = Infinity;

    for (const row of rows) {
      const rowRatios = row.map(getTileAspectRatio);
      const ratioSum = rowRatios.reduce((a, b) => a + b, 0);
      const horzGaps = gap * Math.max(0, row.length - 1);
      const fromWidth = (containerWidth - horzGaps) / ratioSum;
      const rowHeight = Math.min(fromWidth, maxFromHeight);
      if (rowHeight < worstRowHeight) worstRowHeight = rowHeight;
    }

    if (worstRowHeight > bestMinHeight) {
      bestMinHeight = worstRowHeight;
      bestRowCount = rowCount;
    }
  }

  return bestRowCount;
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

  const containerHeight = videoGrid.clientHeight;
  const rowCount = getOptimalRowCount(tiles, containerWidth, containerHeight, gap);
  const rows = chunkTilesEvenly(tiles, rowCount);

  const totalGapHeight = gap * Math.max(0, rows.length - 1);
  const maxRowHeight = containerHeight
    ? Math.floor((containerHeight - totalGapHeight) / rows.length)
    : 420;

  const frag = document.createDocumentFragment();

  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "videoRow";

    const rowRatios = row.map(getTileAspectRatio);
    const ratioSum = rowRatios.reduce((a, b) => a + b, 0);
    const gapsWidth = gap * Math.max(0, row.length - 1);

    const naturalRowHeight = (containerWidth - gapsWidth) / ratioSum;
    const rowHeight = Math.min(maxRowHeight, naturalRowHeight);

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

function syncTileAspectFromVideo(tile, videoEl) {
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (!w || !h) return false;

  const ar = `${w} / ${h}`;
  const prev = tile.style.getPropertyValue("--tile-ar");

  if (prev === ar) return true;

  tile.style.setProperty("--tile-ar", ar);

  const isMobile = window.matchMedia("(max-width: 980px)").matches;
  if (isMobile) {
    tile.style.width = "100%";
    tile.style.height = "auto";
    tile.style.aspectRatio = ar;
  } else {
    tile.style.aspectRatio = "";
    recomputeGrid();
  }

  return true;
}

function profileReady(d) {
  return !!d.profile_token;
}

function isStreaming(deviceId) {
  return streams.has(deviceId);
}

function getDeviceOnlineStatus(deviceId) {
  const st = deviceStatusMap.get(deviceId);
  if (!st) return null;
  return st.status;
}

async function pollDeviceStatus() {
  if (livePageDisposed) return;
  try {
    const data = await api("/api/device-status", { method: "GET" });
    const items = data?.items || [];
    for (const item of items) {
      deviceStatusMap.set(item.device_id, item);
    }
    renderList();
  } catch (e) {
    console.warn("Failed to poll device status", e);
  }
}

function startStatusPoll() {
  if (livePageDisposed) return;
  stopStatusPoll();
  pollDeviceStatus();
  statusPollTimer = setInterval(pollDeviceStatus, STATUS_POLL_MS);
}

function stopStatusPoll() {
  if (statusPollTimer) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
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

  // Clear any pending long-stall hint timer — state just changed.
  if (entry.longStallTimer) {
    clearTimeout(entry.longStallTimer);
    entry.longStallTimer = null;
  }

  if (state === STREAM_STATE.LIVE) {
    setTileOverlay(entry, "", false);
  } else if (state === STREAM_STATE.STARTING) {
    const label = entry.retryCount > 0
      ? `Retrying${entry.retryCount > 1 ? ` (${entry.retryCount})` : ""}…`
      : (entry.restore ? "Restoring…" : "Starting…");
    setTileOverlay(entry, label, true);
    // If we're still stuck in STARTING after 12 s on HD with HD also
    // being recorded for this camera, the most likely cause is a
    // single-HD-connection camera that's already holding its slot for
    // the recording engine. Swap the overlay to a concrete hint so the
    // user knows to switch to SD or change the device settings.
    entry.longStallTimer = setTimeout(() => {
      const cur = getEntry(deviceId);
      if (!cur || cur.state !== STREAM_STATE.STARTING) return;
      const device = devices.find((d) => d.id === deviceId);
      if (!device) return;
      const wantsHd = effectiveLiveQuality(device) === "hd";
      const recordsHd = Array.isArray(device.record_variants)
        ? device.record_variants.includes("hd")
        : false;
      if (wantsHd && recordsHd) {
        setTileOverlay(
          cur,
          "HD live can't connect. This camera may only support one HD stream while recording — switch this tile to SD, or change Settings → Record.",
          true,
        );
      }
    }, 12000);
  } else if (state === STREAM_STATE.ERROR) {
    setTileOverlay(entry, entry.errorMessage || "Stream failed", true);
  }

  applyTileStateClasses(entry);
  renderList();
}

function getVisualState(entry, ready, deviceId) {
  const backendStatus = deviceId ? getDeviceOnlineStatus(deviceId) : null;
  const isDown = backendStatus === "down";

  if (!entry) {
    return {
      className: isDown ? "is-offline" : "",
      badge: !ready ? "SETUP" : (isDown ? "OFFLINE" : "ONLINE"),
      subtitle: ready ? (isDown ? "Camera unreachable" : null) : "Not ready (fetch and save a profile)",
    };
  }

  if (entry.state === STREAM_STATE.LIVE) {
    return {
      className: "is-live",
      badge: "ONLINE",
      subtitle: "Streaming",
    };
  }

  if (entry.state === STREAM_STATE.STARTING) {
    return {
      className: "is-starting",
      badge: "ONLINE",
      subtitle: entry.retryCount > 0 ? "Retrying…" : "Starting…",
    };
  }

  if (entry.state === STREAM_STATE.ERROR) {
    return {
      className: "is-error",
      badge: isDown ? "OFFLINE" : "ERROR",
      subtitle: entry.retryScheduled
        ? `${entry.errorMessage || "Stream error"} — retrying soon`
        : (entry.errorMessage || "Stream error"),
    };
  }

  return {
    className: isDown ? "is-offline" : "",
    badge: !ready ? "SETUP" : (isDown ? "OFFLINE" : "ONLINE"),
    subtitle: ready ? (isDown ? "Camera unreachable" : null) : "Not ready (fetch and save a profile)",
  };
}

function applyTileStateClasses(entry) {
  if (!entry?.tileEl) return;

  entry.tileEl.classList.remove("is-live", "is-starting", "is-error");

  if (entry.state === STREAM_STATE.LIVE) entry.tileEl.classList.add("is-live");
  if (entry.state === STREAM_STATE.STARTING) entry.tileEl.classList.add("is-starting");
  if (entry.state === STREAM_STATE.ERROR) entry.tileEl.classList.add("is-error");
}

function renderSidebar() {
  if (!liveSidebarList) return;

  if (!devices.length) {
    liveSidebarList.innerHTML = '<div class="liveSidebarEmpty">No devices configured</div>';
    return;
  }

  liveSidebarList.innerHTML = devices.map((d) => {
    const entry = getEntry(d.id);
    const active = !!entry;
    const stateClass = entry
      ? (entry.state === STREAM_STATE.LIVE ? 'active'
        : entry.state === STREAM_STATE.STARTING ? 'is-starting'
        : entry.state === STREAM_STATE.ERROR ? 'is-error' : '')
      : '';
    const badge = entry
      ? (entry.state === STREAM_STATE.LIVE ? 'LIVE'
        : entry.state === STREAM_STATE.STARTING ? '…'
        : entry.state === STREAM_STATE.ERROR ? '!' : '')
      : '';

    const onlineStatus = getDeviceOnlineStatus(d.id);
    const camDotClass = (onlineStatus === 'live' || onlineStatus === 'idle') ? 'dot-online' : onlineStatus === 'down' ? 'dot-offline' : 'dot-unknown';

    // HD/SD chip. Three modes:
    //   - both variants → clickable toggle that swaps between HD and SD
    //   - one variant → non-interactive label showing which one is in use
    //   - zero variants → no chip
    // The "one variant" case still surfaces the badge so the user can
    // tell at a glance which quality this camera is locked to.
    const variants = deviceLiveVariants(d);
    let qualityChip = '';
    if (variants.length) {
      const hasBoth = variants.includes('hd') && variants.includes('sd');
      if (hasBoth) {
        const q = effectiveLiveQuality(d);
        const cls = q === 'sd' ? 'liveQualityToggle is-sd' : 'liveQualityToggle';
        const title = q === 'sd'
          ? 'Playing the substream (SD). Click to switch this camera to HD.'
          : 'Playing the main stream (HD). Click to switch this camera to SD.';
        qualityChip = `<button class="${cls}" type="button" draggable="false" data-id="${escapeHtml(d.id)}" data-quality-toggle="1" title="${escapeHtml(title)}">${q === 'sd' ? 'SD' : 'HD'}</button>`;
      } else {
        const q = variants[0];
        const cls = q === 'sd' ? 'liveQualityToggle is-sd is-locked' : 'liveQualityToggle is-locked';
        const title = q === 'sd'
          ? 'This camera is configured for SD live only. Enable HD in Settings → Show on Live to switch.'
          : 'This camera is configured for HD live only. Enable SD in Settings → Show on Live to switch.';
        qualityChip = `<span class="${cls}" title="${escapeHtml(title)}">${q === 'sd' ? 'SD' : 'HD'}</span>`;
      }
    }

    return `<div class="liveSidebarRow ${active ? 'active' : ''} ${stateClass}" data-id="${escapeHtml(d.id)}" draggable="true" data-live-active="${active ? '1' : '0'}" data-live-state="${stateClass}">
      <button class="liveSidebarDragHandle" type="button" draggable="false" aria-label="Reorder" title="Drag to reorder">⋮⋮</button>
      <span class="liveSidebarName">${escapeHtml(d.name || d.ip || d.id)}</span>
      ${qualityChip}
      <span class="statusDot ${camDotClass}"></span>
    </div>`;
  }).join('');

  // Let the playback module decorate the shared sidebar for its mode.
  if (typeof window.viewsPlayback?.afterSidebarRender === "function") {
    window.viewsPlayback.afterSidebarRender();
  }
}

async function loadDevices() {
  if (livePageDisposed) return;
  try {
    const data = await api("/api/devices", { method: "GET" });
    devices = data.devices || [];
    applyDeviceOrder(loadDeviceOrder());
    saveDeviceOrder();
    renderSidebar();
  } catch (e) {
    console.error("Failed to load devices", e);
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
    // We wait for the FIRST candidate (host candidate, which appears
    // within tens of ms on a LAN) and then send the offer immediately
    // — MediaMTX accepts non-trickle WHEP with just host candidates on
    // the same subnet. Waiting for "complete" used to add up to 2 s
    // per tile because STUN/srflx gathering can drag, even though
    // those candidates aren't needed for a local MediaMTX.
    let firstCandidateSeen = false;
    const finish = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      pc.removeEventListener("icecandidate", onCandidate);
      clearTimeout(hardTimer);
      clearTimeout(graceTimer);
      resolve();
    };
    // Hard cap matches the original timeout behaviour as a backstop.
    const hardTimer = setTimeout(finish, timeoutMs);
    // After the first candidate, give a short grace window for any
    // additional host candidates on multi-interface hosts, then send.
    let graceTimer = 0;
    function onCandidate(ev) {
      if (firstCandidateSeen) return;
      // The null candidate signals end-of-gathering.
      if (!ev.candidate) {
        finish();
        return;
      }
      firstCandidateSeen = true;
      graceTimer = setTimeout(finish, 80);
    }
    function onChange() {
      if (pc.iceGatheringState === "complete") finish();
    }
    pc.addEventListener("icegatheringstatechange", onChange);
    pc.addEventListener("icecandidate", onCandidate);
  });
}

async function startWhep(deviceId, videoEl, onState, opts = {}) {
  const { max404Retries = 5, retryDelayMs = 700, signal = liveAbortSignal() } = opts;
  if (signal?.aborted) throwAbortError();

  const pc = new RTCPeerConnection();
  let returnedPc = false;
  const closeOnAbort = () => {
    try { pc.close(); } catch {}
  };
  signal?.addEventListener?.("abort", closeOnAbort, { once: true });

  pc.ontrack = (e) => {
    videoEl.srcObject = e.streams[0];
  };
  pc.onconnectionstatechange = () => onState?.(pc.connectionState);

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  const offer = await pc.createOffer();
  if (signal?.aborted) throwAbortError();
  await pc.setLocalDescription(offer);
  // Trickle ICE-ish: we cap at 600 ms instead of the original 2 s. The
  // first host candidate is enough for a same-subnet MediaMTX; longer
  // STUN gathering buys us nothing here and just delays the offer.
  await waitIceGatheringComplete(pc, 600);
  if (signal?.aborted) throwAbortError();

  let lastError = "Unknown WHEP error";

  try {
    for (let attempt = 0; attempt <= max404Retries; attempt += 1) {
      if (signal?.aborted) throwAbortError();
      const res = await fetch(getWhepUrl(deviceId), {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: pc.localDescription.sdp,
        signal,
      });

      if (res.ok) {
        const answerSdp = await res.text();
        if (signal?.aborted) throwAbortError();
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
        returnedPc = true;
        return pc;
      }

      const t = await res.text().catch(() => "");
      lastError = `WHEP failed (${res.status}): ${t || res.statusText}`;

      if (res.status !== 404 || attempt === max404Retries) {
        break;
      }

      await abortableDelay(retryDelayMs, signal);
    }
  } finally {
    signal?.removeEventListener?.("abort", closeOnAbort);
    if (!returnedPc) {
      try { pc.close(); } catch {}
    }
  }

  throw new Error(lastError);
}

function isWhep404Error(error) {
  return /WHEP failed \(404\)/.test(String(error?.message || error || ""));
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
  const labelEl = entry.overlayEl.querySelector(".tileOverlayLabel");
  if (labelEl) labelEl.textContent = text || "";
  else entry.overlayEl.textContent = text || "";
  entry.overlayEl.style.display = visible ? "flex" : "none";
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
    ".tilePtzPanel, .tilePtzJoystick, .tilePtzZoomBtn, .tileCloseBtn, .tileAudioBtn"
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
  if (ev.key !== "Escape") return;
  if (maximizedTile) {
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

      <button class="tileAudioBtn" type="button" data-muted="1" aria-label="Unmute" title="Unmute">
        <svg class="tileAudioIcon" data-icon="on" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4z"></path>
          <path d="M16.5 12a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12z"></path>
          <path d="M14 3.23v2.06A7 7 0 0 1 14 18.71v2.06A9 9 0 0 0 14 3.23z"></path>
        </svg>
        <svg class="tileAudioIcon" data-icon="muted" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 9v6h4l5 4V5L8 9H4z"></path>
          <path d="M22 9l-1.4-1.4L18 10.2l-2.6-2.6L14 9l2.6 2.6L14 14.2l1.4 1.4L18 13l2.6 2.6L22 14.2 19.4 11.6z"></path>
        </svg>
      </button>

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

      <div class="tileOverlay">
        <div class="tileOverlaySpinner" aria-hidden="true"></div>
        <span class="tileOverlayLabel">Starting…</span>
      </div>
    </div>
  `;

  const videoEl = tile.querySelector("video");
  const overlayEl = tile.querySelector(".tileOverlay");
  const closeBtn = tile.querySelector(".tileCloseBtn");
  const audioBtn = tile.querySelector(".tileAudioBtn");

  let tileMuted = loadTileMuted(device.id);

  function applyTileMuted() {
    videoEl.muted = tileMuted;
    audioBtn.setAttribute("data-muted", tileMuted ? "1" : "0");
    audioBtn.setAttribute("aria-label", tileMuted ? "Unmute" : "Mute");
    audioBtn.setAttribute("title", tileMuted ? "Unmute" : "Mute");
  }

  applyTileMuted();

  audioBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    tileMuted = !tileMuted;
    applyTileMuted();
    if (!tileMuted) {
      const p = videoEl.play?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
    saveTileMuted(device.id, tileMuted);
  });

  let aspectPollTimer = null;
  let aspectPollCount = 0;

  function refreshAspect() {
    syncTileAspectFromVideo(tile, videoEl);
  }

  function stopAspectPoll() {
    if (!aspectPollTimer) return;
    clearInterval(aspectPollTimer);
    aspectPollTimer = null;
  }

  function startAspectPoll() {
    stopAspectPoll();
    aspectPollCount = 0;

    aspectPollTimer = setInterval(() => {
      refreshAspect();
      aspectPollCount += 1;

      if (aspectPollCount >= 16) {
        stopAspectPoll();
      }
    }, 250);
  }

  const aspectEvents = ["loadedmetadata", "loadeddata", "canplay", "playing", "resize"];

  for (const evt of aspectEvents) {
    videoEl.addEventListener(evt, refreshAspect);
  }

  videoEl.addEventListener("playing", startAspectPoll);
  videoEl.addEventListener("emptied", stopAspectPoll);
  videoEl.addEventListener("abort", stopAspectPoll);
  videoEl.addEventListener("ended", stopAspectPoll);

  return {
    tile,
    videoEl,
    overlayEl,
    closeBtn,
    cleanupVideoAspect() {
      stopAspectPoll();

      for (const evt of aspectEvents) {
        videoEl.removeEventListener(evt, refreshAspect);
      }

      videoEl.removeEventListener("playing", startAspectPoll);
      videoEl.removeEventListener("emptied", stopAspectPoll);
      videoEl.removeEventListener("abort", stopAspectPoll);
      videoEl.removeEventListener("ended", stopAspectPoll);
    },
  };
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
  if (livePageDisposed || isAbortError(error)) return;

  clearDisconnectTimer(entry);
  entry.retryCount = (entry.retryCount || 0) + 1;

  stopPc(entry.pc, entry.videoEl);
  entry.pc = null;
  entry.connecting = false;

  const message = error?.message || String(error) || "Stream failed";
  setEntryState(device.id, STREAM_STATE.ERROR, message);
  saveGridState();

  scheduleRetry(device, entry);
}

async function connectEntry(device, entry) {
  if (!entry || entry.cancelled || entry.connecting) return;
  if (livePageDisposed) return;
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
      // WebRTC "connected" only means the transport is up — the camera
      // hasn't necessarily delivered the first keyframe yet, so the video
      // element will still be black for a beat. Keep the spinner up until
      // the <video> actually starts decoding frames (its `playing` event
      // fires), or fall back after 8 s in case the event never lands.
      setTileOverlay(cur, "Waiting for video…", true);
      const goLive = () => {
        const latest = getEntry(device.id);
        if (!latest || latest.cancelled) return;
        if (latest.state === STREAM_STATE.LIVE) return;
        cleanupGoLive();
        setEntryState(device.id, STREAM_STATE.LIVE);
        saveGridState();
      };
      const cleanupGoLive = () => {
        try { cur.videoEl?.removeEventListener("playing", goLive); } catch {}
        if (cur.firstFrameTimer) {
          clearTimeout(cur.firstFrameTimer);
          cur.firstFrameTimer = null;
        }
      };
      // If frames are already flowing (rare but possible if the listener
      // attaches after the event), skip the wait.
      if (cur.videoEl && !cur.videoEl.paused && cur.videoEl.readyState >= 2) {
        goLive();
        return;
      }
      cur.videoEl?.addEventListener("playing", goLive, { once: true });
      cur.firstFrameTimer = setTimeout(goLive, 8000);
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
    if (livePageDisposed || isAbortError(e)) return;
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
      console.error("PTZ error", e);
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
  if (livePageDisposed) return Promise.resolve();
  if (restore) {
    try {
      const data = await api("/api/devices", { method: "GET" });
      devices = data.devices || devices;
      applyDeviceOrder(loadDeviceOrder());
      const fresh = devices.find((d) => d.id === device.id);
      if (fresh) device = fresh;
      renderList();
    } catch {}
  }

  const existing = getEntry(device.id);
  if (existing?.startingPromise) return existing.startingPromise;
  if (existing) return Promise.resolve();
  if (!profileReady(device)) return Promise.resolve();

  const { tile, videoEl, overlayEl, closeBtn, cleanupVideoAspect } = makeTile(device);
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
    cleanupVideoAspect,
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
    firstFrameTimer: null,
    longStallTimer: null,
  };

  streams.set(device.id, entry);

  const targetOrder = desiredTileOrder.length
    ? desiredTileOrder
    : devices.map((d) => d.id);

  applyTileOrder(targetOrder);
  applyTileStateClasses(entry);
  recomputeGrid();
  renderList();
  saveGridState();

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
  if (entry.firstFrameTimer) {
    clearTimeout(entry.firstFrameTimer);
    entry.firstFrameTimer = null;
  }
  if (entry.longStallTimer) {
    clearTimeout(entry.longStallTimer);
    entry.longStallTimer = null;
  }
  entry.retryScheduled = false;

  try {
    entry.stopPtz?.();
  } catch {}

  try {
    entry.cleanupPtzListeners?.();
  } catch {}

  try {
    entry.cleanupVideoAspect?.();
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

  // Clean up empty videoRow wrappers so #videoGrid:empty works
  videoGrid.querySelectorAll(".videoRow").forEach((row) => {
    if (!row.children.length) row.remove();
  });

  streams.delete(deviceId);

  recomputeGrid();
  renderList();
  saveGridState();
  ensureDevicesVisibleWhenNoStreams();
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
}

sidebarStartAll?.addEventListener("click", async () => {
  const ready = devices.filter(profileReady);
  const toStart = ready.filter((d) => !isStreaming(d.id));
  if (!toStart.length) return;

  await Promise.allSettled(
    toStart.map((d) => startDevice(d))
  );

  syncTileOrderToDeviceOrder();
  saveGridState();
});

sidebarStopAll?.addEventListener("click", async () => {
  await Promise.allSettled(
    Array.from(streams.keys()).map((id) => stopDevice(id, { force: true }))
  );

  saveGridState();
});

liveSidebarList?.addEventListener("click", async (ev) => {
  if (Date.now() < suppressSidebarClickUntil) return;
  if (ev.target.closest(".liveSidebarDragHandle")) return;

  // HD/SD chip: swap the per-device quality preference and, if the stream
  // is currently up, restart it on the new MediaMTX path so the change is
  // visible immediately.
  const qBtn = ev.target.closest(".liveQualityToggle[data-quality-toggle]");
  if (qBtn) {
    ev.stopPropagation();
    if (window.views?.mode && window.views.mode !== "live") return;
    const id = qBtn.getAttribute("data-id");
    const d = devices.find((x) => x.id === id);
    if (!d) return;
    const current = effectiveLiveQuality(d);
    const next = current === "hd" ? "sd" : "hd";
    saveTileQuality(d.id, next);
    renderSidebar();
    if (isStreaming(d.id)) {
      try {
        await stopDevice(d.id);
        await startDevice(d);
      } catch {}
    }
    return;
  }

  const row = ev.target.closest(".liveSidebarRow[data-id]");
  if (!row) return;

  // Sidebar is shared with playback mode; only handle clicks in live mode.
  if (window.views?.mode && window.views.mode !== "live") return;

  const id = row.getAttribute("data-id");
  const d = devices.find((x) => x.id === id);
  if (!d) return;

  if (isStreaming(d.id)) {
    await stopDevice(d.id);
  } else {
    await startDevice(d);
  }
});

// ── Sidebar DnD ──
let draggedSidebarId = null;
let lastSidebarDropId = null;
let originalSidebarOrder = [];
let suppressSidebarClickUntil = 0;

function getSidebarRowFromTarget(target) {
  return target?.closest?.(".liveSidebarRow[data-id]") || null;
}

function clearSidebarDropMarkers() {
  liveSidebarList?.querySelectorAll(".liveSidebarRow.drop-before, .liveSidebarRow.drop-after").forEach((el) => {
    el.classList.remove("drop-before", "drop-after");
  });
}

function clearSidebarDraggingState() {
  liveSidebarList?.querySelectorAll(".liveSidebarRow.is-list-dragging").forEach((el) => {
    el.classList.remove("is-list-dragging");
  });
  clearSidebarDropMarkers();
  draggedSidebarId = null;
  lastSidebarDropId = null;
}

function getSidebarDropTarget(clientY, draggingEl) {
  const items = Array.from(liveSidebarList.querySelectorAll(".liveSidebarRow[data-id]"))
    .filter((el) => el !== draggingEl);
  if (!items.length) return null;

  let best = null;
  let bestScore = Infinity;

  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const cy = rect.top + rect.height / 2;
    const score = Math.abs(clientY - cy);
    if (score < bestScore) {
      bestScore = score;
      best = { item, rect };
    }
  }

  if (!best) return null;
  const midY = best.rect.top + best.rect.height / 2;
  return { item: best.item, before: clientY < midY };
}

function installSidebarDnD() {
  if (!liveSidebarList) return;

  liveSidebarList.addEventListener("dragstart", (ev) => {
    const item = getSidebarRowFromTarget(ev.target);
    if (!item) return;

    draggedSidebarId = item.getAttribute("data-id");
    lastSidebarDropId = draggedSidebarId;
    originalSidebarOrder = devices.map((d) => d.id);
    item.classList.add("is-list-dragging");

    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", draggedSidebarId || "");
    }
  });

  liveSidebarList.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    const draggingEl = liveSidebarList.querySelector(".liveSidebarRow.is-list-dragging");
    if (!draggingEl) return;

    const target = getSidebarDropTarget(ev.clientY, draggingEl);
    if (!target) return;

    clearSidebarDropMarkers();
    target.item.classList.add(target.before ? "drop-before" : "drop-after");

    const dragId = draggingEl.getAttribute("data-id");
    const targetId = target.item.getAttribute("data-id");
    if (!dragId || !targetId || dragId === targetId) return;

    const sig = `${targetId}:${target.before ? "b" : "a"}`;
    if (sig === lastSidebarDropId) return;

    if (target.before) {
      liveSidebarList.insertBefore(draggingEl, target.item);
    } else {
      liveSidebarList.insertBefore(draggingEl, target.item.nextSibling);
    }

    lastSidebarDropId = sig;

    const orderedIds = Array.from(liveSidebarList.querySelectorAll(".liveSidebarRow[data-id]"))
      .map((el) => el.getAttribute("data-id"))
      .filter(Boolean);

    if (orderedIds.length) {
      applyDeviceOrder(orderedIds);
      syncTileOrderToDeviceOrder(false);
      // Real-time mirror to playback so its tiles reorder during the drag too.
      window.viewsPlayback?.onSidebarReorder?.(orderedIds);
    }
  });

  liveSidebarList.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const draggingEl = liveSidebarList.querySelector(".liveSidebarRow.is-list-dragging");
    if (!draggingEl || !draggedSidebarId) {
      clearSidebarDraggingState();
      return;
    }

    const orderedIds = Array.from(liveSidebarList.querySelectorAll(".liveSidebarRow[data-id]"))
      .map((el) => el.getAttribute("data-id"))
      .filter(Boolean);

    if (orderedIds.length) {
      applyDeviceOrder(orderedIds);
      saveDeviceOrder();
      syncTileOrderToDeviceOrder(false);
      saveGridState();
      // Notify playback so it can reorder its own tiles + state.
      window.viewsPlayback?.onSidebarReorder?.(orderedIds);
    }

    originalSidebarOrder = [];
    suppressSidebarClickUntil = Date.now() + 250;
    clearSidebarDraggingState();
    renderList();
  });

  liveSidebarList.addEventListener("dragend", () => {
    requestAnimationFrame(() => {
      if (originalSidebarOrder.length) {
        applyDeviceOrder(originalSidebarOrder);
        renderList();
        syncTileOrderToDeviceOrder(false);
      }

      originalSidebarOrder = [];
      suppressSidebarClickUntil = Date.now() + 250;
      clearSidebarDraggingState();
    });
  });
}

window.addEventListener("resize", () => {
  recomputeGrid();
});

recomputeGrid();
installSidebarDnD();

// ── Speaker / Audio clip sidebar ──────────────────────────────────────────────

const speakerSidebarList = document.getElementById("speakerSidebarList");

let speakers = [];
let audioClips = [];
let playingSpeakerId = null;
const speakerStatusMap = new Map();
let speakerStatusTimer = null;
const SPEAKER_STATUS_POLL_MS = 10000;

let recordingSpeakerId = null;
let mediaRecorder = null;
let recordedChunks = [];

async function loadSpeakers() {
  if (livePageDisposed) return;
  try {
    const data = await api("/api/speakers", { method: "GET" });
    speakers = data.speakers || [];
  } catch { speakers = []; }
  renderSpeakerSidebar();
}

async function loadAudioClips() {
  if (livePageDisposed) return;
  try {
    const data = await api("/api/audio-clips", { method: "GET" });
    audioClips = data.clips || [];
  } catch { audioClips = []; }
  renderSpeakerSidebar();
}

// Map to track selected clip per speaker
const speakerClipSelections = {};

function renderSpeakerSidebar() {
  if (!speakerSidebarList) return;

  if (!speakers.length) {
    speakerSidebarList.innerHTML = '<div class="liveSidebarEmpty">No speakers configured</div>';
    return;
  }

  const clipsOptions = audioClips.length
    ? audioClips.map((c) => `<option value="${escapeHtml(c.filename)}">${escapeHtml(c.filename)}</option>`).join("")
    : '<option value="">No audio clips</option>';

  // Check if we can do an in-place update (same speaker set)
  const existingItems = speakerSidebarList.querySelectorAll('.speakerItem[data-speaker-id]');
  const existingIds = Array.from(existingItems).map(el => el.getAttribute('data-speaker-id'));
  const canPatch = existingIds.length === speakers.length && speakers.every((s, i) => s.id === existingIds[i]);

  if (canPatch) {
    // In-place update: only touch what changed (dots, buttons, clips, classes)
    speakers.forEach((s) => {
      const el = speakerSidebarList.querySelector(`.speakerItem[data-speaker-id="${CSS.escape(s.id)}"]`);
      if (!el) return;
      const st = speakerStatusMap.get(s.id);
      const isOnline = st === "online";
      const isOffline = st === "offline";
      el.className = `speakerItem ${isOnline ? 'speaker-online' : isOffline ? 'speaker-offline' : ''}`;
      const dot = el.querySelector('.statusDot');
      if (dot) dot.className = `statusDot ${isOnline ? 'dot-online' : isOffline ? 'dot-offline' : 'dot-unknown'}`;
      const isPlaying = playingSpeakerId === s.id;
      const playBtn = el.querySelector('.speakerPlayBtn');
      if (playBtn) {
        playBtn.disabled = isPlaying || !audioClips.length;
        playBtn.innerHTML = isPlaying ? '…' : '&#9654;';
      }
      const sel = el.querySelector('.speakerClipSelect');
      if (sel) {
        const saved = sel.value;
        sel.innerHTML = clipsOptions;
        sel.disabled = !audioClips.length;
        if (saved && audioClips.some(c => c.filename === saved)) sel.value = saved;
      }
      const micBtn = el.querySelector('.speakerMicBtn');
      if (micBtn) {
        micBtn.classList.toggle('is-recording', recordingSpeakerId === s.id);
        micBtn.title = recordingSpeakerId === s.id ? 'Stop & send' : 'Push to talk';
      }
    });
    return;
  }

  speakerSidebarList.innerHTML = speakers.map((s) => {
    const isPlaying = playingSpeakerId === s.id;
    const st = speakerStatusMap.get(s.id);
    const isOnline = st === "online";
    const isOffline = st === "offline";
    const statusClass = isOnline ? "speaker-online" : isOffline ? "speaker-offline" : "";
    const dotClass = isOnline ? "dot-online" : isOffline ? "dot-offline" : "dot-unknown";

    return `<div class="speakerItem ${statusClass}" data-speaker-id="${escapeHtml(s.id)}">
      <div class="speakerItemHeader">
        <div class="speakerItemName">${escapeHtml(s.name || s.ip)}</div>
        <span class="statusDot ${dotClass}"></span>
      </div>
      <div class="speakerItemControls">
        <select class="speakerClipSelect" ${!audioClips.length ? 'disabled' : ''}>${clipsOptions}</select>
        <button class="btn speakerPlayBtn" type="button" ${isPlaying || !audioClips.length ? 'disabled' : ''}>${isPlaying ? '…' : '&#9654;'}</button>
        <button class="btn speakerMicBtn ${recordingSpeakerId === s.id ? 'is-recording' : ''}" type="button" title="${recordingSpeakerId === s.id ? 'Stop & send' : 'Push to talk'}"><svg class="speakerMicIcon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm-1-9a1 1 0 1 1 2 0v6a1 1 0 1 1-2 0V5zm6 6a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.93V20H8v2h8v-2h-3v-2.07A7 7 0 0 0 19 11h-2z"/></svg></button>
      </div>
    </div>`;
  }).join("");

  // Restore saved dropdown selections after full rebuild
  speakerSidebarList.querySelectorAll('.speakerItem[data-speaker-id]').forEach((el) => {
    const id = el.getAttribute('data-speaker-id');
    const sel = el.querySelector('.speakerClipSelect');
    if (id && sel && speakerClipSelections[id]) sel.value = speakerClipSelections[id];
  });
}

async function pollSpeakerStatus() {
  if (livePageDisposed) return;
  try {
    const data = await api("/api/speaker-status", { method: "GET" });
    const items = data?.items || [];
    for (const item of items) {
      speakerStatusMap.set(item.speaker_id, item.status);
    }
    renderSpeakerSidebar();
  } catch (e) {
    console.warn("Failed to poll speaker status", e);
  }
}

function startSpeakerStatusPoll() {
  if (livePageDisposed) return;
  if (speakerStatusTimer) clearInterval(speakerStatusTimer);
  pollSpeakerStatus();
  speakerStatusTimer = setInterval(pollSpeakerStatus, SPEAKER_STATUS_POLL_MS);
}

function stopSpeakerStatusPoll() {
  if (speakerStatusTimer) {
    clearInterval(speakerStatusTimer);
    speakerStatusTimer = null;
  }
}

async function playClipOnSpeaker(speakerId, filename) {
  if (playingSpeakerId || !filename) return;
  playingSpeakerId = speakerId;
  renderSpeakerSidebar();

  try {
    await api(`/api/speakers/${encodeURIComponent(speakerId)}/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename }),
    });
  } catch (e) {
    console.error("Failed to play clip:", e);
  } finally {
    playingSpeakerId = null;
    renderSpeakerSidebar();
  }
}

if (speakerSidebarList) {
  speakerSidebarList.addEventListener("change", (ev) => {
    const sel = ev.target.closest(".speakerClipSelect");
    if (!sel) return;
    const item = sel.closest(".speakerItem[data-speaker-id]");
    if (item) speakerClipSelections[item.getAttribute("data-speaker-id")] = sel.value;
  });

  speakerSidebarList.addEventListener("click", (ev) => {
    const playBtn = ev.target.closest(".speakerPlayBtn");
    if (playBtn) {
      const item = playBtn.closest(".speakerItem[data-speaker-id]");
      if (!item) return;
      const speakerId = item.getAttribute("data-speaker-id");
      const sel = item.querySelector(".speakerClipSelect");
      const clip = sel ? sel.value : "";
      if (speakerId && clip) playClipOnSpeaker(speakerId, clip);
      return;
    }

    const micBtn = ev.target.closest(".speakerMicBtn");
    if (micBtn) {
      const item = micBtn.closest(".speakerItem[data-speaker-id]");
      if (!item) return;
      const speakerId = item.getAttribute("data-speaker-id");
      if (recordingSpeakerId === speakerId) {
        stopVoiceRecording();
      } else {
        startVoiceRecording(speakerId);
      }
    }
  });
}

async function startVoiceRecording(speakerId) {
  if (recordingSpeakerId) stopVoiceRecording();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Microphone access requires HTTPS. Please access this site over HTTPS.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : "";
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      if (!recordedChunks.length) {
        recordingSpeakerId = null;
        renderSpeakerSidebar();
        return;
      }
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      recordedChunks = [];
      const sid = recordingSpeakerId;
      recordingSpeakerId = null;
      playingSpeakerId = sid;
      renderSpeakerSidebar();

      try {
        const res = await fetch(`/api/speakers/${encodeURIComponent(sid)}/voice`, {
          method: "POST",
          headers: { "Content-Type": blob.type },
          body: blob,
        });
        if (res.status === 401) { window.location.href = "/login"; return; }
        if (!res.ok) {
          const text = await res.text();
          console.error("Voice playback failed:", text);
        }
      } catch (e) {
        console.error("Voice send error:", e);
      } finally {
        playingSpeakerId = null;
        renderSpeakerSidebar();
      }
    };

    recordingSpeakerId = speakerId;
    mediaRecorder.start();
    renderSpeakerSidebar();
  } catch (e) {
    console.error("Microphone access denied:", e);
    alert(e.name === "NotAllowedError"
      ? "Microphone permission denied. Please allow microphone access in your browser settings."
      : "Could not access microphone. Ensure the site is served over HTTPS.");
    recordingSpeakerId = null;
    renderSpeakerSidebar();
  }
}

function stopVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

let _liveGridRestored = false;

async function restoreLiveGridOnce() {
  if (_liveGridRestored) return;
  _liveGridRestored = true;
  // Cross-mode handoff: if the shared engagement set is non-empty (e.g. user
  // had cameras selected in playback before switching here), prefer that over
  // the LS-restored grid.
  const sharedIds = Array.from(window.views?.selectedDevices ?? []);
  if (sharedIds.length) {
    await reconcileLiveStreamsToIds(sharedIds);
  } else {
    await restoreGrid();
  }
}

async function reconcileLiveStreamsToIds(targetIds) {
  const target = new Set(targetIds);
  const startPromises = [];
  for (const id of target) {
    if (isStreaming(id)) continue;
    const d = devices.find((x) => x.id === id);
    if (d) startPromises.push(startDevice(d));
  }
  const stopPromises = [];
  for (const id of Array.from(streams.keys())) {
    if (!target.has(id)) stopPromises.push(stopDevice(id));
  }
  await Promise.allSettled([...startPromises, ...stopPromises]);
  // Re-align tile order to current devices order (which reflects sidebar order).
  syncTileOrderToDeviceOrder(false);
}

window.viewsLive = {
  async onModeChange(next, _prev) {
    if (next === "live") {
      if (!_liveGridRestored) {
        await restoreLiveGridOnce();
      } else {
        const sharedIds = Array.from(window.views?.selectedDevices ?? []);
        await reconcileLiveStreamsToIds(sharedIds);
      }
      ensureDevicesVisibleWhenNoStreams();
    }
    // Streams stay alive when leaving live mode (the grid is just hidden).
  },
};

(async function init() {
  await loadDevices();
  if (livePageDisposed) return;
  startStatusPoll();
  loadSpeakers();
  loadAudioClips();
  startSpeakerStatusPoll();

  if (window.views?.mode === "live") {
    await restoreLiveGridOnce();
  }

  window.addEventListener("focus", () => {
    loadDevices().catch(() => {});
  });
})();

// Stop polling, media, and in-flight requests as navigation begins.
// Normal teardown can leave WHEP/fetch work occupying connection slots while
// the next page is trying to load.
function notifyBackendStreamStop(deviceId) {
  const url = `/api/stop/${encodeURIComponent(deviceId)}`;
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([], { type: "application/json" }));
    return;
  }
  fetch(url, { method: "POST", keepalive: true }).catch(() => {});
}

function disposeLiveEntry(deviceId, entry) {
  if (!entry) return;
  entry.cancelled = true;
  clearRetryTimer(entry);
  clearDisconnectTimer(entry);
  if (entry.firstFrameTimer) {
    clearTimeout(entry.firstFrameTimer);
    entry.firstFrameTimer = null;
  }
  if (entry.longStallTimer) {
    clearTimeout(entry.longStallTimer);
    entry.longStallTimer = null;
  }
  entry.retryScheduled = false;
  entry.connecting = false;
  try { entry.cleanupPtzListeners?.(); } catch {}
  try { entry.cleanupVideoAspect?.(); } catch {}
  try { stopPc(entry.pc, entry.videoEl); } catch {}
  notifyBackendStreamStop(deviceId);
}

window.addEventListener("pagehide", () => {
  if (livePageDisposed) return;
  livePageDisposed = true;
  livePageAbortController.abort();
  try { stopStatusPoll(); } catch {}
  try { stopSpeakerStatusPoll(); } catch {}
  for (const [id, entry] of Array.from(streams.entries())) {
    disposeLiveEntry(id, entry);
  }
  streams.clear();
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted && livePageDisposed) window.location.reload();
});
