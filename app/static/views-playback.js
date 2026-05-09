// Views: playback module.
// Wall-clock cursor model: a single UTC milliseconds cursor drives every tile;
// each device runs one HLS playlist covering a window around the cursor and is
// reloaded only when the cursor approaches the edge. Timeline is a continuous
// wall-clock ruler with zoom presets (5m/1h/6h/24h/7d), coverage bars per
// device, gap hatching, and event markers as overlay bookmarks.
(function () {

const el = (id) => document.getElementById(id);

// ── Constants ─────────────────────────────────────────────────────────
const STORAGE_KEY = "sei.playback.v3";
const STATE_VERSION = 3;
const STATE_SAVE_DELAY_MS = 400;
const TILE_MUTE_STORAGE_KEY = "sei.playback.tileMuted";

const ZOOM_PRESETS_MS = [300_000, 3_600_000, 21_600_000, 86_400_000, 604_800_000];
const DEFAULT_ZOOM_MS = 3_600_000;        // 1h
const MIN_ZOOM_MS = 60_000;               // 1 min
const MAX_ZOOM_MS = 30 * 24 * 3_600_000;  // 30d
const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8, 16];
const MAX_SPEED = 16;

const PLAYBACK_LEAD_MS = 5 * 60 * 1000;   // load 5 min ahead of cursor
// Trail kept short so the first segment a player downloads is close to the
// cursor — large segments (4K cameras at 2880×1620 hit ~5 MB each) make this
// matter for click-to-first-frame latency. 10s still gives instant short
// rewinds without forcing a playlist reload.
const PLAYBACK_TRAIL_MS = 10 * 1000;
const RELOAD_MARGIN_MS = 20 * 1000;       // reload when within 20s of edge
const RELOAD_CHECK_INTERVAL_MS = 1500;
const TIMELINE_DATA_REFRESH_LIVE_MS = 5000;
const TIMELINE_DATA_REFRESH_IDLE_MS = 30_000;
const FRAME_STEP_MS = 1000 / 30;          // ~1 frame at 30fps
const LIVE_THRESHOLD_MS = 5000;
const PAN_DRAG_THRESHOLD_PX = 6;
const CLICK_SUPPRESSION_MS = 250;

const HLS_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  // No `startPosition` override: the server emits EXT-X-START with the
  // cursor's offset, so hls.js fetches the right segment first.
  startFragPrefetch: true,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  manifestLoadingTimeOut: 10_000,
  manifestLoadingMaxRetry: 2,
  levelLoadingTimeOut: 10_000,
  fragLoadingTimeOut: 20_000,
};

// ── State ─────────────────────────────────────────────────────────────
const state = {
  devices: [],
  activeDeviceIds: [],
  cursorMs: Date.now() - 30_000,
  zoomMs: DEFAULT_ZOOM_MS,
  viewportStartMs: 0,
  viewportEndMs: 0,
  speed: 1,
  isPlaying: false,
  followLive: false,
  coverage: new Map(),     // deviceId → [{startMs, endMs}]
  thumbnails: new Map(),   // deviceId → [{startMs, endMs, url}]
  events: [],              // bookmarks, drawn as marker overlay only
  hiddenPresetKeys: [],
  pageDisposed: false,
  abortController: new AbortController(),
  saveTimer: 0,
  dataRefreshTimer: 0,
  reloadCheckTimer: 0,
  liveTickRafId: 0,
  liveTickLastMs: 0,
  scrub: { active: false, pointerId: null, wasPlaying: false, pendingMs: null, rafId: 0 },
  pan: { active: false, pointerId: null, dragOriginX: 0, dragOriginStartMs: 0, isDragging: false, suppressClickUntil: 0 },
  dataRequestId: 0,
};
function recenterViewportOnCursor() {
  const half = state.zoomMs / 2;
  state.viewportStartMs = state.cursorMs - half;
  state.viewportEndMs = state.cursorMs + half;
}
recenterViewportOnCursor();

// Map<deviceId, {tileEl, video, hls, audioBtn, overlayEl, loadToken,
//   loadedStartMs, loadedEndMs, playlistStartMs, pendingSeekMs, lastReloadAt,
//   suppressErrorUntil, deviceId, lastUrl}>
const tiles = new Map();

let _initialized = false;

// ── Utilities ─────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function abortSignal() { return state.abortController.signal; }
function isAbortError(err) { return err?.name === "AbortError"; }

async function api(url, opts = {}) {
  const requestOpts = { ...opts };
  if (!requestOpts.signal && !requestOpts.keepalive) requestOpts.signal = abortSignal();
  const res = await fetch(url, requestOpts);
  if (res.status === 401) { window.location.href = "/login"; return; }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.detail) ? data.detail : (text || res.statusText));
  return data;
}

function setStatus(message) {
  const node = el("playbackStatus");
  if (node) node.textContent = message || "";
}

function deviceName(deviceId) {
  return state.devices.find((d) => d.id === deviceId)?.name || deviceId || "camera";
}

function isLive(ms = state.cursorMs) {
  return Math.abs(Date.now() - ms) <= LIVE_THRESHOLD_MS;
}

function isLiveCursor() {
  // The user is "looking at the live edge" when the cursor is within ~30s of
  // wall-clock now. Looser than `isLive` (which is for the LIVE button glow);
  // used to gate live-tail refresh so we don't poll while reviewing the past.
  return Math.abs(Date.now() - state.cursorMs) <= 30_000;
}

// ── Time formatting ──────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, "0"); }
function pad4(n) { return String(n).padStart(4, "0"); }

function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtClockMs(ms) {
  const d = new Date(ms);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${tenths}`;
}

function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtClock(ms)}`;
}

function dayString(ms) {
  const d = new Date(ms);
  return `${pad4(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function parseISOms(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ── Persistence ──────────────────────────────────────────────────────

function loadStored() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== STATE_VERSION) return null;
    return obj;
  } catch { return null; }
}

function snapshotState() {
  // Only persist device IDs that are still in the device list — keeps the
  // restored state from referencing deleted cameras.
  const knownIds = new Set(state.devices.map((d) => d.id));
  const liveActiveIds = state.devices.length
    ? state.activeDeviceIds.filter((id) => knownIds.has(id))
    : [...state.activeDeviceIds];
  return {
    version: STATE_VERSION,
    activeDeviceIds: liveActiveIds,
    cursorMs: Number(state.cursorMs) || Date.now(),
    zoomMs: state.zoomMs,
    speed: state.speed,
    followLive: !!state.followLive,
    hiddenPresetKeys: [...state.hiddenPresetKeys],
    savedAt: new Date().toISOString(),
  };
}

function saveNow() {
  if (state.saveTimer) { window.clearTimeout(state.saveTimer); state.saveTimer = 0; }
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshotState())); } catch {}
}

function saveSoon() {
  if (state.saveTimer) return;
  state.saveTimer = window.setTimeout(() => { state.saveTimer = 0; saveNow(); }, STATE_SAVE_DELAY_MS);
}

function loadTileMuted(deviceId) {
  try {
    const raw = window.localStorage.getItem(TILE_MUTE_STORAGE_KEY);
    if (!raw) return true;
    const map = JSON.parse(raw);
    return map && Object.prototype.hasOwnProperty.call(map, deviceId) ? !!map[deviceId] : true;
  } catch { return true; }
}

function saveTileMuted(deviceId, muted) {
  try {
    const raw = window.localStorage.getItem(TILE_MUTE_STORAGE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[deviceId] = !!muted;
    window.localStorage.setItem(TILE_MUTE_STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

// ── Event helpers ────────────────────────────────────────────────────

function eventState(ev) { return String(ev?.state || "ready").trim().toLowerCase() || "ready"; }
function eventIsLive(ev) { return ev?.live === true || eventState(ev) === "recording"; }
function eventIsReady(ev) { return eventState(ev) === "ready"; }
function eventIsPlayable(ev) { return eventIsReady(ev) || eventIsLive(ev); }

function normalizeColor(value) {
  const raw = String(value || "#c6a14b").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : "#c6a14b";
}

function eventPresetName(ev) {
  return String(ev?.preset_name || ev?.title || "Recording").trim() || "Recording";
}

function eventPresetKey(ev) {
  const explicit = String(ev?.preset_key || "").trim();
  if (explicit) return explicit;
  return eventPresetName(ev).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "recording";
}

function eventTagSegments(ev) {
  const raw = Array.isArray(ev?.tag_segments) ? ev.tag_segments : [];
  const live = eventIsLive(ev);
  const fromList = raw.map((seg) => {
    const cs = seg?.clip_start || ev?.clip_start;
    const ce = seg?.clip_end || ev?.clip_end;
    const csMs = parseISOms(cs);
    const ceMs = parseISOms(ce);
    if (csMs == null || ceMs == null) return null;
    return {
      eventId: String(ev?.id || "").trim(),
      deviceId: String(ev?.device_id || "").trim(),
      title: String(seg?.title || ev?.title || eventPresetName(ev)).trim() || eventPresetName(ev),
      color: normalizeColor(seg?.color || ev?.color),
      presetName: String(seg?.preset_name || eventPresetName(ev)).trim() || eventPresetName(ev),
      presetKey: String(seg?.preset_key || eventPresetKey(ev)).trim() || eventPresetKey(ev),
      startMs: csMs,
      endMs: Math.max(ceMs, csMs + 250),
      state: eventState(ev),
      ready: eventIsReady(ev),
      live,
      playable: eventIsPlayable(ev),
    };
  }).filter(Boolean);
  if (fromList.length) return fromList;
  const csMs = parseISOms(ev?.clip_start);
  const ceMs = parseISOms(ev?.clip_end);
  if (csMs == null || ceMs == null) return [];
  return [{
    eventId: String(ev?.id || "").trim(),
    deviceId: String(ev?.device_id || "").trim(),
    title: String(ev?.title || eventPresetName(ev)).trim() || eventPresetName(ev),
    color: normalizeColor(ev?.color),
    presetName: eventPresetName(ev),
    presetKey: eventPresetKey(ev),
    startMs: csMs,
    endMs: Math.max(ceMs, csMs + 250),
    state: eventState(ev),
    ready: eventIsReady(ev),
    live,
    playable: eventIsPlayable(ev),
  }];
}

function timelinePresetRows() {
  const rows = new Map();
  for (const ev of state.events) {
    for (const seg of eventTagSegments(ev)) {
      if (!rows.has(seg.presetKey)) {
        rows.set(seg.presetKey, { key: seg.presetKey, name: seg.presetName, color: seg.color, segments: [] });
      }
      rows.get(seg.presetKey).segments.push(seg);
    }
  }
  return [...rows.values()].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.key.localeCompare(b.key));
}

function visibleEventSegments() {
  const hidden = new Set(state.hiddenPresetKeys);
  return timelinePresetRows()
    .filter((row) => !hidden.has(row.key))
    .flatMap((row) => row.segments);
}

// ── Tiles ────────────────────────────────────────────────────────────

function videoGridEl() { return el("playbackVideoGrid"); }

function makeTileElement(device) {
  const node = document.createElement("div");
  node.className = "tile";
  node.setAttribute("data-id", device.id);
  node.innerHTML = `
    <div class="tilePlayer">
      <video playsinline preload="metadata" muted></video>
      <button class="tileCloseBtn" type="button" aria-label="Close tile" title="Close tile">×</button>
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
      <div class="tileOverlay" data-state="">
        <span class="tileOverlaySpinner" aria-hidden="true"></span>
        <span class="tileOverlayText"></span>
      </div>
    </div>`;
  return node;
}

function setTileOverlay(tile, text, visible, options = {}) {
  if (!tile?.overlayEl) return;
  const overlay = tile.overlayEl;
  const textEl = overlay.querySelector(".tileOverlayText");
  if (textEl) textEl.textContent = text || "";
  const show = visible ?? !!(text || options.state === "loading");
  overlay.dataset.state = options.state || "";
  overlay.style.display = show ? "flex" : "none";
}

function syncTileAspectFromVideo(tileEl, videoEl) {
  if (!tileEl || !videoEl) return;
  const w = videoEl.videoWidth || 0;
  const h = videoEl.videoHeight || 0;
  if (!w || !h) return;
  tileEl.style.setProperty("--tile-ar", `${w} / ${h}`);
}

function chunkTilesEvenly(tileEls, rows) {
  const out = []; let i = 0;
  for (let r = 0; r < rows; r++) {
    const remaining = tileEls.length - i;
    const remainingRows = rows - r;
    const count = Math.ceil(remaining / remainingRows);
    out.push(tileEls.slice(i, i + count));
    i += count;
  }
  return out;
}

function getTileAspectRatio(tileEl) {
  const raw = tileEl.style.getPropertyValue("--tile-ar") || "16 / 9";
  const [num, den] = raw.split("/").map((s) => Number(s.trim()));
  return (num && den) ? num / den : 16 / 9;
}

function getOptimalRowCount(tileEls, w, h, gap) {
  const n = tileEls.length;
  if (n <= 1) return 1;
  let best = 1, bestArea = 0;
  for (let r = 1; r <= n; r++) {
    const rows = chunkTilesEvenly(tileEls, r);
    const totalGapH = (r - 1) * gap;
    const rowHeight = Math.max(40, (h - totalGapH) / r);
    let area = 0;
    for (const row of rows) {
      const ars = row.map(getTileAspectRatio);
      const totalGapW = (row.length - 1) * gap;
      const sumAr = ars.reduce((a, b) => a + b, 0);
      const tentativeWidth = sumAr * rowHeight;
      const widthLimit = w - totalGapW;
      const usedHeight = tentativeWidth > widthLimit ? widthLimit / sumAr : rowHeight;
      area += usedHeight * (sumAr * usedHeight + totalGapW);
    }
    if (area > bestArea) { bestArea = area; best = r; }
  }
  return best;
}

function recomputeGrid() {
  const grid = videoGridEl();
  if (!grid) return;
  const tileEls = Array.from(grid.querySelectorAll(".tile[data-id]"));
  if (!tileEls.length) return;
  const styles = getComputedStyle(grid);
  const gap = Number.parseFloat(styles.rowGap || styles.gap || "0") || 0;
  const cw = grid.clientWidth, ch = grid.clientHeight;
  if (cw < 50 || ch < 50) return;
  const rowCount = getOptimalRowCount(tileEls, cw, ch, gap);
  const rows = chunkTilesEvenly(tileEls, rowCount);
  const totalGapH = (rowCount - 1) * gap;
  const rowHeight = Math.max(60, (ch - totalGapH) / rowCount);
  const frag = document.createDocumentFragment();
  rows.forEach((row) => {
    const rowEl = document.createElement("div");
    rowEl.className = "videoRow";
    const ars = row.map(getTileAspectRatio);
    const sumAr = ars.reduce((a, b) => a + b, 0);
    const totalGapW = (row.length - 1) * gap;
    const tentativeWidth = sumAr * rowHeight;
    const widthLimit = cw - totalGapW;
    const usedHeight = tentativeWidth > widthLimit ? widthLimit / sumAr : rowHeight;
    row.forEach((tileEl, i) => {
      const width = ars[i] * usedHeight;
      tileEl.style.aspectRatio = "";
      tileEl.style.height = `${Math.round(usedHeight)}px`;
      tileEl.style.width = `${width}px`;
      rowEl.appendChild(tileEl);
    });
    frag.appendChild(rowEl);
  });
  grid.replaceChildren(frag);
}

function suppressTileError(tile, ms) {
  const until = Date.now() + Math.max(0, ms | 0);
  if (until > tile.suppressErrorUntil) tile.suppressErrorUntil = until;
}

function isIgnorableTileError(tile) {
  if (Date.now() < tile.suppressErrorUntil) return true;
  const v = tile.video;
  if (!v || !v.currentSrc) return true;
  const e = v.error;
  return !e || e.code === 1; // MEDIA_ERR_ABORTED
}

function destroyTilePlaylist(tile) {
  if (!tile) return;
  tile.loadToken += 1;
  suppressTileError(tile, 1500);
  if (tile.hls) {
    try { tile.hls.destroy(); } catch {}
    tile.hls = null;
  }
  if (tile.video) {
    try { tile.video.pause(); } catch {}
    try { tile.video.removeAttribute("src"); } catch {}
    try { tile.video.load(); } catch {}
  }
  tile.loadedStartMs = null;
  tile.loadedEndMs = null;
  tile.playlistStartMs = null;
  tile.pendingSeekMs = null;
  tile.lastUrl = null;
}

function getOrCreateTile(deviceId) {
  if (tiles.has(deviceId)) return tiles.get(deviceId);
  const device = state.devices.find((d) => d.id === deviceId);
  if (!device) return null;

  const tileEl = makeTileElement(device);
  const video = tileEl.querySelector("video");
  const audioBtn = tileEl.querySelector(".tileAudioBtn");
  const closeBtn = tileEl.querySelector(".tileCloseBtn");
  const overlayEl = tileEl.querySelector(".tileOverlay");

  closeBtn?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleActiveDevice(deviceId);
  });

  const tile = {
    tileEl, video, hls: null, audioBtn, overlayEl, deviceId,
    loadToken: 0, loadedStartMs: null, loadedEndMs: null,
    playlistStartMs: null, pendingSeekMs: null,
    lastReloadAt: 0, lastErrorAt: 0,
    suppressErrorUntil: 0, lastUrl: null, disposed: false,
  };
  tiles.set(deviceId, tile);

  let muted = loadTileMuted(deviceId);
  function applyMuted() {
    video.muted = muted;
    audioBtn.setAttribute("data-muted", muted ? "1" : "0");
    audioBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    audioBtn.setAttribute("title", muted ? "Unmute" : "Mute");
  }
  applyMuted();
  audioBtn.addEventListener("click", (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    muted = !muted; applyMuted(); saveTileMuted(deviceId, muted);
  });

  video.addEventListener("loadedmetadata", () => {
    if (tile.disposed) return;
    syncTileAspectFromVideo(tileEl, video);
    requestAnimationFrame(recomputeGrid);
    if (tile.pendingSeekMs != null) {
      const target = tile.pendingSeekMs;
      tile.pendingSeekMs = null;
      seekTileToCursor(tile, target);
    }
  });
  video.addEventListener("loadeddata", () => {
    if (tile.disposed) return;
    syncTileAspectFromVideo(tileEl, video);
  });
  video.addEventListener("playing", () => {
    if (tile.disposed) return;
    syncTileAspectFromVideo(tileEl, video);
  });
  video.addEventListener("error", () => {
    if (tile.disposed) return;
    if (isIgnorableTileError(tile)) return;
    setTileOverlay(tile, "Stream error", true, { state: "error" });
  });

  return tile;
}

function destroyTile(deviceId) {
  const tile = tiles.get(deviceId);
  if (!tile) return;
  tile.disposed = true;
  destroyTilePlaylist(tile);
  if (tile.tileEl?.parentElement) tile.tileEl.parentElement.removeChild(tile.tileEl);
  tiles.delete(deviceId);
}

function destroyAllTiles() {
  for (const id of [...tiles.keys()]) destroyTile(id);
}

function syncTilesToActive() {
  for (const id of [...tiles.keys()]) {
    if (!state.activeDeviceIds.includes(id)) destroyTile(id);
  }
  const grid = videoGridEl();
  if (!grid) return;
  for (const id of state.activeDeviceIds) {
    const tile = getOrCreateTile(id);
    if (tile && tile.tileEl.parentElement !== grid && tile.tileEl.parentElement?.parentElement !== grid) {
      grid.appendChild(tile.tileEl);
    }
  }
  // Mirror the sidebar order so playback's tile order matches the camera list.
  const sidebar = el("viewsCameraList");
  const order = sidebar
    ? Array.from(sidebar.querySelectorAll(".liveSidebarRow[data-id]")).map((r) => r.getAttribute("data-id"))
    : [];
  const seen = new Set(); const ordered = [];
  for (const id of order) if (tiles.has(id) && !seen.has(id)) { seen.add(id); ordered.push(id); }
  for (const id of state.activeDeviceIds) if (tiles.has(id) && !seen.has(id)) { seen.add(id); ordered.push(id); }
  if (ordered.length) grid.replaceChildren(...ordered.map((id) => tiles.get(id).tileEl));
  refreshEmptyState();
  requestAnimationFrame(recomputeGrid);
}

function refreshEmptyState() {
  const empty = el("playbackVideoEmpty");
  const shell = el("playbackVideoShell");
  const badge = el("playbackVideoEmptyBadge");
  const titleNode = empty?.querySelector(".playbackVideoEmptyTitle");
  const textNode = el("playbackVideoEmptyText");
  if (!empty || !shell) return;
  if (state.activeDeviceIds.length) {
    // Cameras selected — clear the empty-state attributes so the grid isn't
    // hidden by the `[data-empty-state="empty"] .playbackVideoGrid` CSS rule.
    delete shell.dataset.emptyState;
    delete empty.dataset.state;
    empty.classList.add("hidden");
    empty.setAttribute("aria-busy", "false");
    return;
  }
  shell.dataset.emptyState = "empty";
  empty.dataset.state = "empty";
  empty.classList.remove("hidden");
  empty.setAttribute("aria-busy", "false");
  if (badge) badge.textContent = "Camera";
  if (titleNode) titleNode.textContent = "Select a camera";
  if (textNode) textNode.textContent = "Choose one or more cameras from the sidebar to start reviewing recordings.";
}

// ── Playlist windows (per tile) ──────────────────────────────────────

function tileWindowAroundCursor(cursorMs) {
  return {
    startMs: cursorMs - PLAYBACK_TRAIL_MS,
    endMs: cursorMs + PLAYBACK_LEAD_MS,
  };
}

function urlForWindow(deviceId, startMs, endMs, seekMs) {
  const params = new URLSearchParams({
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
    ts: String(Date.now()),
  });
  // Tell the server where the cursor is so it can emit EXT-X-START. Without
  // this, hls.js fetches segment 0 first then has to seek + re-fetch the
  // segment containing the cursor, doubling the time-to-first-frame.
  if (Number.isFinite(seekMs)) {
    params.set("seek_at", new Date(seekMs).toISOString());
  }
  return `/api/playback/hls/${encodeURIComponent(deviceId)}/index.m3u8?${params.toString()}`;
}

function tileNeedsReload(tile, cursorMs) {
  if (!tile.loadedStartMs || !tile.loadedEndMs) return true;
  // Cursor jumped before the window's start — full reload required to fetch
  // earlier segments. No margin here: the trail buffer is intentionally short
  // (PLAYBACK_TRAIL_MS), so a margin would force a reload immediately after
  // every load, which is the bug class that produced the play/black-screen
  // loop.
  if (cursorMs < tile.loadedStartMs) return true;
  // Cursor advancing into the lead margin — reload to extend the window.
  // Margin gives us headroom so the reload completes before the player
  // actually runs out of buffered media.
  if (cursorMs > tile.loadedEndMs - RELOAD_MARGIN_MS) return true;
  return false;
}

function tileHasCoverageAtCursor(tile, cursorMs = state.cursorMs) {
  // Per-camera coverage check. Coverage runs come from /api/playback/window;
  // each entry is a continuous span where this device has recorded video.
  // Used to decide whether a tile should display video (in-coverage) or a
  // "No recording" overlay (in a recording gap for this camera) — letting
  // each camera's tile go black independently while the master cursor
  // advances at wall-clock real time.
  const runs = state.coverage.get(tile.deviceId);
  if (!runs || !runs.length) return false;
  for (const r of runs) {
    if (cursorMs >= r.startMs && cursorMs <= r.endMs) return true;
  }
  return false;
}

// Per-tile sync: brings a single tile in line with the master cursor —
// overlay if no coverage, reload if playlist doesn't cover the cursor,
// seek + play otherwise. The single source of truth for "what should this
// tile be doing right now."
function syncOneTileToCursor(tile, cursorMs, opts = {}) {
  if (!tile?.video || tile.disposed) return;
  const inCoverage = tileHasCoverageAtCursor(tile, cursorMs);
  if (!inCoverage) {
    if (!tile.video.paused) {
      try { tile.video.pause(); } catch {}
    }
    setTileOverlay(tile, "No recording at this time", true, { state: "nodata" });
    return;
  }
  // In coverage. Hide the overlay (loading state will re-set it if a reload
  // is pending).
  setTileOverlay(tile, "", false);
  // Need a playlist that actually covers the cursor?
  if (opts.allowReload !== false && tileNeedsReload(tile, cursorMs)) {
    const sinceError = tile.lastErrorAt ? Date.now() - tile.lastErrorAt : Infinity;
    if (sinceError >= 4000) loadTilePlaylist(tile);
    return;  // FRAG_BUFFERED handler will seek + play once buffered
  }
  seekTileToCursor(tile, cursorMs);
  if (state.isPlaying && tile.video.paused) {
    tile.video.playbackRate = state.speed;
    Promise.resolve(tile.video.play()).catch(() => {});
  }
}

function syncAllTilesToCursor(cursorMs = state.cursorMs, opts = {}) {
  for (const tile of tiles.values()) syncOneTileToCursor(tile, cursorMs, opts);
}

function loadTilePlaylist(tile, opts = {}) {
  if (!tile) return;
  const cursor = state.cursorMs;
  const win = tileWindowAroundCursor(cursor);
  const url = urlForWindow(tile.deviceId, win.startMs, win.endMs, cursor);

  destroyTilePlaylist(tile);
  tile.loadToken += 1;
  const myToken = tile.loadToken;
  tile.loadedStartMs = win.startMs;
  tile.loadedEndMs = win.endMs;
  tile.playlistStartMs = null;
  tile.lastReloadAt = Date.now();
  tile.lastErrorAt = 0;
  tile.lastUrl = url;
  tile.pendingSeekMs = opts.seekMs != null ? opts.seekMs : cursor;

  setTileOverlay(tile, "", true, { state: "loading" });

  const video = tile.video;

  const finishOverlay = () => setTileOverlay(tile, "", false);

  if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
    const hls = new window.Hls(HLS_CONFIG);
    tile.hls = hls;
    // playlistStartMs is the wall-clock anchor for video.currentTime=0 in
    // this MediaSource. We set it from the FIRST playlist's first fragment
    // and never touch it again for the lifetime of the hls instance —
    // subsequent loadSource() calls (live-tail refresh) just shift the
    // window forward and may drop earlier fragments, but the buffered
    // media stays where it is so the anchor must too.
    hls.on(window.Hls.Events.LEVEL_LOADED, (_e, data) => {
      if (tile.loadToken !== myToken) return;
      const fragments = data?.details?.fragments || [];
      // Empty playlist (no segments in this window) is a normal "no recording"
      // condition, not an error per se — but the player would silently sit on
      // a black frame, so flag it with an overlay so the user knows there's
      // simply nothing to play here.
      if (!fragments.length) {
        setTileOverlay(tile, "No recording in this range", true, { state: "error" });
        return;
      }
      const segStartMs = fragments[0]?.programDateTime;
      if (Number.isFinite(segStartMs) && tile.playlistStartMs == null) {
        tile.playlistStartMs = segStartMs;
      }
      if (tile.pendingSeekMs != null && video.readyState >= 1 && tile.playlistStartMs != null) {
        const target = tile.pendingSeekMs;
        tile.pendingSeekMs = null;
        seekTileToCursor(tile, target);
      }
    });
    hls.on(window.Hls.Events.FRAG_BUFFERED, () => {
      if (tile.loadToken !== myToken) return;
      finishOverlay();
      // If the user started playback before the manifest loaded, the initial
      // video.play() rejected (no source). Pick up where they left off here.
      if (state.isPlaying && video.paused) {
        video.playbackRate = state.speed;
        Promise.resolve(video.play()).catch(() => {});
      }
    });
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data?.fatal) return;
      if (tile.disposed || tile.loadToken !== myToken) return;
      const errDetails = String(data?.details || "");
      const playlistEmpty = errDetails === "manifestParsingError"
        || errDetails === "levelEmptyError"
        || errDetails === "manifestLoadError";
      if (playlistEmpty) {
        setTileOverlay(tile, "No recording in this range", true, { state: "error" });
      } else {
        setTileOverlay(tile, "Reconnecting…", true, { state: "loading" });
      }
      // Force a fresh reload on the next reload-check tick. The throttle on
      // `tile.lastErrorAt` prevents a tight loop if the problem persists.
      // Tear down the broken hls instance so the retry starts clean.
      try { hls.destroy(); } catch {}
      if (tile.hls === hls) tile.hls = null;
      tile.loadedStartMs = null;
      tile.loadedEndMs = null;
      tile.playlistStartMs = null;
      tile.lastErrorAt = Date.now();
    });
    video.addEventListener("playing", finishOverlay, { once: true });
    video.addEventListener("loadeddata", finishOverlay, { once: true });
    hls.attachMedia(video);
    hls.loadSource(url);
    try { hls.startLoad(); } catch {}
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.addEventListener("loadedmetadata", () => {
      const startDate = video.getStartDate?.();
      const segStartMs = startDate?.getTime?.();
      if (Number.isFinite(segStartMs) && tile.loadToken === myToken) {
        tile.playlistStartMs = segStartMs;
        if (tile.pendingSeekMs != null) {
          const target = tile.pendingSeekMs;
          tile.pendingSeekMs = null;
          seekTileToCursor(tile, target);
        }
      }
    }, { once: true });
    video.addEventListener("loadeddata", finishOverlay, { once: true });
    try { video.load(); } catch {}
  } else {
    setTileOverlay(tile, "HLS not supported in this browser", true, { state: "error" });
  }
}

function seekTileToCursor(tile, cursorMs = state.cursorMs) {
  if (!tile?.video) return;
  if (tile.playlistStartMs == null) {
    tile.pendingSeekMs = cursorMs;
    return;
  }
  const offsetSec = (cursorMs - tile.playlistStartMs) / 1000;
  if (!Number.isFinite(offsetSec) || offsetSec < 0) {
    try { tile.video.currentTime = 0; } catch {}
    return;
  }
  const dur = Number(tile.video.duration);
  const safe = Number.isFinite(dur) && dur > 0 ? Math.min(offsetSec, Math.max(0, dur - 0.05)) : offsetSec;
  try { tile.video.currentTime = Math.max(0, safe); } catch {}
}

function ensureTilePlaylistsForCursor() {
  for (const tile of tiles.values()) {
    if (tileNeedsReload(tile, state.cursorMs)) {
      loadTilePlaylist(tile);
    } else {
      seekTileToCursor(tile);
    }
  }
}

function reloadAllTilesForCursor() {
  for (const tile of tiles.values()) loadTilePlaylist(tile);
}

// Hot-swap the tile's playlist URL in-place, without destroying the hls.js
// instance or the MediaSource buffer. Used for live-tail refresh: keeps
// playback going while the new playlist (with newly-finalized segments)
// is parsed and appended.
function refreshTilePlaylist(tile) {
  if (!tile?.hls) {
    loadTilePlaylist(tile);
    return;
  }
  const cursor = state.cursorMs;
  const win = tileWindowAroundCursor(cursor);
  const url = urlForWindow(tile.deviceId, win.startMs, win.endMs, cursor);
  tile.loadedStartMs = win.startMs;
  tile.loadedEndMs = win.endMs;
  tile.lastReloadAt = Date.now();
  tile.lastUrl = url;
  // Don't touch playlistStartMs — it's the anchor for the existing buffer.
  // Don't touch pendingSeekMs — we're not seeking, just refreshing.
  try {
    tile.hls.loadSource(url);
  } catch {
    loadTilePlaylist(tile);
  }
}

function startReloadCheck() {
  stopReloadCheck();
  state.reloadCheckTimer = window.setInterval(() => {
    if (state.pageDisposed) return;
    let needCoverageRefresh = false;
    for (const tile of tiles.values()) {
      // Skip tiles whose camera has no recording at the current cursor — no
      // amount of reloading will produce video where there is none, and the
      // overlay-on-no-coverage UX doesn't need a playlist anyway.
      if (!tileHasCoverageAtCursor(tile, state.cursorMs)) continue;

      // Hard reload: cursor moved outside (or near edge of) the loaded window.
      // Throttled by lastErrorAt so a permanently-broken stream doesn't
      // reload-loop every 1.5s.
      if (tileNeedsReload(tile, state.cursorMs)) {
        const sinceError = tile.lastErrorAt ? Date.now() - tile.lastErrorAt : Infinity;
        if (sinceError < 4000) continue;
        loadTilePlaylist(tile);
        continue;
      }
      // Live tail: hot-swap the playlist (in-place, no MediaSource teardown)
      // only when the buffer is genuinely about to run dry, and only when the
      // cursor is actually near now() — past playback doesn't need polling
      // because finalized segments don't change.
      if (state.isPlaying && isLiveCursor() && tile.video && tile.hls) {
        const buf = tile.video.buffered;
        const playheadAhead = buf.length
          ? buf.end(buf.length - 1) - tile.video.currentTime
          : 0;
        const sinceLastReload = Date.now() - tile.lastReloadAt;
        if (playheadAhead < 4 && sinceLastReload > 6000) {
          refreshTilePlaylist(tile);
          needCoverageRefresh = true;
        }
      }
    }
    if (needCoverageRefresh) loadDataForViewportSoon();
  }, RELOAD_CHECK_INTERVAL_MS);
}

function stopReloadCheck() {
  if (state.reloadCheckTimer) {
    window.clearInterval(state.reloadCheckTimer);
    state.reloadCheckTimer = 0;
  }
}

// ── Cursor / wall-clock loop ─────────────────────────────────────────

function setCursor(ms, opts = {}) {
  const next = Math.max(0, Math.round(ms));
  if (next === state.cursorMs && !opts.force) {
    syncCursorUI(); return;
  }
  state.cursorMs = next;
  // If user moved cursor away from "now", drop live-follow.
  if (opts.userInitiated) {
    state.followLive = isLive(next);
  }
  syncCursorUI();
  syncTransport();
  saveSoon();
  // Per-tile sync — each camera independently decides whether to show video
  // (in coverage) or a "No recording" overlay (in a gap). The cursor itself
  // advances continuously regardless.
  syncAllTilesToCursor(next, { allowReload: opts.reloadIfNeeded !== false });
}

function syncCursorUI() {
  const display = el("playbackTimeDisplay");
  if (display) display.textContent = fmtDateTime(state.cursorMs);
  const cursorEl = el("playbackTimelineCursor");
  if (cursorEl) {
    if (state.cursorMs < state.viewportStartMs || state.cursorMs > state.viewportEndMs) {
      cursorEl.classList.add("hidden");
    } else {
      cursorEl.classList.remove("hidden");
      cursorEl.style.left = `${pctOfMs(state.cursorMs)}%`;
      const labelEl = cursorEl.querySelector("[data-playback-cursor-label]");
      if (labelEl) labelEl.textContent = fmtClock(state.cursorMs);
    }
  }
}

function startLiveTick() {
  // The cursor is the master clock: it advances at real-time × speed
  // independently of any specific tile's currentTime. Each tile then syncs
  // to the cursor — playing the segment covering that wall-clock instant if
  // it has one, or showing a "No recording" overlay if it doesn't. This is
  // the only model that survives heterogeneous coverage (camera A recorded,
  // camera B didn't, at the same wall-clock time) without desyncing.
  stopLiveTick();
  state.liveTickLastMs = performance.now();
  const tick = (ts) => {
    if (state.pageDisposed) return;
    if (!state.isPlaying) { state.liveTickRafId = 0; return; }
    const dt = ts - state.liveTickLastMs;
    state.liveTickLastMs = ts;
    // Cap dt so a long backgrounded tab doesn't make the cursor jump
    // hours forward in a single frame when it returns.
    const safeDt = Math.min(dt, 1000);
    setCursor(state.cursorMs + safeDt * state.speed, { reloadIfNeeded: false });
    state.liveTickRafId = requestAnimationFrame(tick);
  };
  state.liveTickRafId = requestAnimationFrame(tick);
}

function stopLiveTick() {
  if (state.liveTickRafId) {
    cancelAnimationFrame(state.liveTickRafId);
    state.liveTickRafId = 0;
  }
}


// ── Transport ────────────────────────────────────────────────────────

function syncTransport() {
  const playBtn = el("playbackPlayPauseBtn");
  const liveBtn = el("playbackLiveBtn");
  const speedSelect = el("playbackSpeedSelect");
  const hasTiles = state.activeDeviceIds.length > 0;
  if (playBtn) {
    playBtn.disabled = !hasTiles;
    const playing = state.isPlaying;
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    playBtn.title = playing ? "Pause" : "Play";
    playBtn.innerHTML = playing
      ? '<span class="playbackTransportGlyph" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><rect x="6.5" y="6" width="4" height="12" rx="1"></rect><rect x="13.5" y="6" width="4" height="12" rx="1"></rect></svg></span>'
      : '<span class="playbackTransportGlyph" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M8 6.5V17.5L17 12L8 6.5Z"></path></svg></span>';
  }
  if (liveBtn) {
    liveBtn.classList.toggle("is-live", state.followLive && isLive());
    liveBtn.disabled = !hasTiles;
  }
  if (speedSelect && Number(speedSelect.value) !== state.speed) {
    speedSelect.value = String(state.speed);
  }
  for (const tile of tiles.values()) {
    if (tile.video) {
      tile.video.playbackRate = state.speed;
      tile.video.defaultPlaybackRate = state.speed;
    }
  }
}

async function play() {
  if (!state.activeDeviceIds.length) return;
  // Set flag BEFORE we kick off async work so the FRAG_BUFFERED handler can
  // see "should be playing" and resume tiles whose initial play() rejected
  // (no source attached yet). Without this, freshly-loaded tiles stay paused.
  state.isPlaying = true;
  syncTransport();
  startLiveTick();

  // Ensure each tile is muted (autoplay policy) before the sync function
  // fires play() on them.
  for (const tile of tiles.values()) {
    if (tile.video && !tile.video.muted) tile.video.muted = true;
  }
  // Sync drives playlist load + play() for in-coverage tiles, and pause +
  // overlay for out-of-coverage tiles.
  syncAllTilesToCursor(state.cursorMs, { allowReload: true });
}

function pause() {
  for (const tile of tiles.values()) {
    if (tile.video && !tile.video.paused) {
      try { tile.video.pause(); } catch {}
    }
  }
  state.isPlaying = false;
  syncTransport();
  stopLiveTick();
}

function togglePlay() {
  if (state.isPlaying) pause();
  else play();
}

function setSpeed(value) {
  const num = Number(value);
  state.speed = SPEED_OPTIONS.includes(num) ? num : 1;
  for (const tile of tiles.values()) {
    if (tile.video) {
      tile.video.playbackRate = state.speed;
      tile.video.defaultPlaybackRate = state.speed;
    }
  }
  syncTransport();
  saveSoon();
}

function jumpRelative(deltaMs, opts = {}) {
  setCursor(state.cursorMs + deltaMs, { userInitiated: true, ...opts });
}

function frameStep(forward) {
  pause();
  jumpRelative(forward ? FRAME_STEP_MS : -FRAME_STEP_MS);
}

function jumpToLive() {
  state.followLive = true;
  setCursor(Date.now() - 1500, { userInitiated: false });
  // Center the viewport on now if cursor would be off-screen.
  if (Date.now() < state.viewportStartMs || Date.now() > state.viewportEndMs) {
    centerViewportOnCursor();
    renderTimeline();
  }
  if (!state.isPlaying) play();
}

// ── Viewport / zoom ──────────────────────────────────────────────────

function setZoomMs(zoomMs, opts = {}) {
  const next = clamp(zoomMs, MIN_ZOOM_MS, MAX_ZOOM_MS);
  state.zoomMs = next;
  if (opts.center !== false) centerViewportOnCursor();
  syncZoomPresets();
  renderTimeline();
  loadDataForViewport().catch(() => {});
  saveSoon();
}

function centerViewportOnCursor() {
  const half = state.zoomMs / 2;
  state.viewportStartMs = state.cursorMs - half;
  state.viewportEndMs = state.cursorMs + half;
}

function setViewport(startMs, durationMs, opts = {}) {
  const dur = clamp(durationMs, MIN_ZOOM_MS, MAX_ZOOM_MS);
  const nextStart = Math.round(startMs);
  const nextEnd = Math.round(startMs + dur);
  if (nextStart === state.viewportStartMs && nextEnd === state.viewportEndMs) {
    return;
  }
  state.viewportStartMs = nextStart;
  state.viewportEndMs = nextEnd;
  state.zoomMs = dur;
  if (opts.render !== false) scheduleRenderTimeline();
  if (opts.persist !== false) saveSoon();
}

let _renderTimelineRafId = 0;
function scheduleRenderTimeline() {
  if (_renderTimelineRafId) return;
  _renderTimelineRafId = requestAnimationFrame(() => {
    _renderTimelineRafId = 0;
    renderTimeline();
  });
}

function pctOfMs(ms) {
  const dur = state.viewportEndMs - state.viewportStartMs || 1;
  return clamp(((ms - state.viewportStartMs) / dur) * 100, 0, 100);
}

function widthPct(startMs, endMs) {
  return Math.max(0, pctOfMs(endMs) - pctOfMs(startMs));
}

function syncZoomPresets() {
  const host = el("playbackZoomPresets");
  if (!host) return;
  for (const btn of host.querySelectorAll("[data-zoom-ms]")) {
    btn.classList.toggle("is-active", Number(btn.dataset.zoomMs) === state.zoomMs);
  }
}

// ── Timeline rendering ───────────────────────────────────────────────

function chooseTickStepMs(durationMs) {
  // Aim for 6–10 ticks across the viewport.
  const target = durationMs / 8;
  const candidates = [
    1000, 5000, 10_000, 30_000,
    60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
    3_600_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
    24 * 3_600_000, 2 * 24 * 3_600_000, 7 * 24 * 3_600_000, 14 * 24 * 3_600_000,
  ];
  for (const c of candidates) if (target <= c) return c;
  return candidates[candidates.length - 1];
}

function tickLabel(ms, stepMs) {
  if (stepMs >= 24 * 3_600_000) return dayString(ms);
  if (stepMs >= 3_600_000) return `${pad2(new Date(ms).getHours())}:00`;
  return fmtClock(ms);
}

function tickStartMs(stepMs) {
  // Snap first tick to the step boundary in local time
  const start = state.viewportStartMs;
  if (stepMs >= 24 * 3_600_000) {
    return startOfLocalDay(start) + (start > startOfLocalDay(start) ? 24 * 3_600_000 : 0);
  }
  const offset = stepMs >= 3_600_000 ? new Date(start).getTimezoneOffset() * 60_000 : 0;
  const adjusted = start - offset;
  const remainder = adjusted % stepMs;
  const next = adjusted - remainder + (remainder === 0 ? 0 : stepMs);
  return next + offset;
}

function renderTimelineScale() {
  const scale = el("playbackTimelineScale");
  if (!scale) return;
  const dur = state.viewportEndMs - state.viewportStartMs;
  const stepMs = chooseTickStepMs(dur);
  const labels = [];
  let t = tickStartMs(stepMs);
  while (t <= state.viewportEndMs) {
    labels.push(`<span class="playbackTimelineTick" style="left:${pctOfMs(t)}%;">${escapeHtml(tickLabel(t, stepMs))}</span>`);
    t += stepMs;
  }
  // Edge labels (start + end)
  labels.unshift(`<span class="playbackTimelineTick is-edge" style="left:0%;">${escapeHtml(fmtClock(state.viewportStartMs))}</span>`);
  labels.push(`<span class="playbackTimelineTick is-edge is-end" style="left:100%;">${escapeHtml(fmtClock(state.viewportEndMs))}</span>`);
  scale.innerHTML = labels.join("");
}

function renderCoverageLane(deviceId) {
  const runs = state.coverage.get(deviceId) || [];
  const visible = runs.filter((r) => r.endMs >= state.viewportStartMs && r.startMs <= state.viewportEndMs);
  const visStart = state.viewportStartMs, visEnd = state.viewportEndMs;
  // Build gap stripes by inverting coverage within viewport.
  const cursorMs = visStart;
  let walker = visStart;
  const gaps = [];
  for (const run of visible) {
    if (run.startMs > walker + 250) gaps.push({ startMs: walker, endMs: run.startMs });
    walker = Math.max(walker, run.endMs);
  }
  if (walker < visEnd - 250) gaps.push({ startMs: walker, endMs: visEnd });

  const gapHtml = gaps.map((g) => {
    const left = pctOfMs(g.startMs);
    const width = widthPct(g.startMs, g.endMs);
    return `<span class="playbackTimelineGapStripe" style="left:${left}%; width:${width}%;"></span>`;
  }).join("");

  const coverageHtml = visible.map((r) => {
    const left = pctOfMs(Math.max(r.startMs, visStart));
    const width = widthPct(Math.max(r.startMs, visStart), Math.min(r.endMs, visEnd));
    return `<span class="playbackTimelineCoverage" style="left:${left}%; width:${width}%;"></span>`;
  }).join("");

  return `${gapHtml}${coverageHtml}<span class="playbackTimelineLaneLabel">${escapeHtml(deviceName(deviceId))}</span>`;
}

function renderEventLane(row) {
  const visStart = state.viewportStartMs, visEnd = state.viewportEndMs;
  const segs = row.segments.filter((s) => s.endMs >= visStart && s.startMs <= visEnd);
  const html = segs.map((seg) => {
    const left = pctOfMs(Math.max(seg.startMs, visStart));
    const width = Math.max(0.2, widthPct(Math.max(seg.startMs, visStart), Math.min(seg.endMs, visEnd)));
    const playable = seg.playable ? "" : "is-pending";
    const camLabel = seg.deviceId ? ` · ${deviceName(seg.deviceId)}` : "";
    const tooltip = `${seg.presetName}${camLabel} · ${fmtClock(seg.startMs)}`;
    return `<button class="playbackMarker ${playable}" type="button"
      data-event-id="${escapeHtml(seg.eventId)}"
      data-start-ms="${seg.startMs}"
      style="left:${left}%; width:${width}%; background:${escapeHtml(seg.color)};"
      title="${escapeHtml(tooltip)}"></button>`;
  }).join("");
  return `${html}<span class="playbackTimelineLaneLabel">${escapeHtml(row.name)}</span>`;
}

function renderTimeline() {
  const track = el("playbackTimelineTrack");
  if (!track) return;
  renderTimelineScale();
  renderTimelineFilters();
  syncZoomPresets();

  const stepMs = chooseTickStepMs(state.viewportEndMs - state.viewportStartMs);
  const tickHtml = [];
  let t = tickStartMs(stepMs);
  while (t <= state.viewportEndMs) {
    tickHtml.push(`<span class="playbackTimelineGuide" style="left:${pctOfMs(t)}%;" aria-hidden="true"></span>`);
    t += stepMs;
  }

  // Coverage lanes — one per active camera.
  const coverageLanes = state.activeDeviceIds.map((id) => `
    <div class="playbackTimelineLane" data-coverage-device="${escapeHtml(id)}">
      ${renderCoverageLane(id)}
    </div>`).join("");

  // Event lanes — one per visible preset.
  const hidden = new Set(state.hiddenPresetKeys);
  const eventRows = timelinePresetRows().filter((row) => !hidden.has(row.key));
  const eventLanes = eventRows.map((row) => `
    <div class="playbackTimelineLane" data-preset-key="${escapeHtml(row.key)}">
      ${renderEventLane(row)}
    </div>`).join("");

  let body = "";
  if (state.activeDeviceIds.length) {
    body = `<div class="playbackTimelineRows">${coverageLanes}${eventLanes}</div>`;
  } else {
    body = `<div class="playbackTimelineEmpty">Select a camera to see recording coverage.</div>`;
  }

  // Preserve the thumb preview node — it's the only piece that survives across renders.
  const preview = el("playbackThumbPreview");
  const previewHtml = preview ? preview.outerHTML : '<div class="playbackThumbPreview hidden" id="playbackThumbPreview" aria-hidden="true"><img id="playbackThumbPreviewImg" alt=""/><div class="playbackThumbPreviewLabel" id="playbackThumbPreviewLabel"></div></div>';

  track.innerHTML = `${tickHtml.join("")}${body}
    <div class="playbackTimelineCursor hidden" id="playbackTimelineCursor">
      <span class="playbackTimelineCursorLabel" data-playback-cursor-label></span>
    </div>
    ${previewHtml}`;

  syncCursorUI();
}

// ── Filters (preset chips) ───────────────────────────────────────────

function renderTimelineFilters() {
  const host = el("playbackTimelineFilters");
  if (!host) return;
  const rows = timelinePresetRows();
  if (!rows.length) { host.innerHTML = ""; host.classList.add("hidden"); return; }
  host.classList.remove("hidden");
  const hidden = new Set(state.hiddenPresetKeys);
  host.innerHTML = `
    <div class="playbackTimelineFilterBar">
      <div class="playbackTimelineFilterLabel">Tags</div>
      <div class="playbackTimelineFilterChips">
        ${rows.map((row) => {
          const sel = !hidden.has(row.key);
          return `<button class="playbackTimelineFilterChip ${sel ? "is-selected" : ""}"
            type="button" data-preset-key="${escapeHtml(row.key)}"
            aria-pressed="${sel ? "true" : "false"}"
            ><span class="playbackTimelineFilterSwatch" style="background:${escapeHtml(row.color)};"></span><span>${escapeHtml(row.name)}</span></button>`;
        }).join("")}
      </div>
    </div>`;
}

function togglePresetKey(key) {
  const k = String(key || "").trim();
  if (!k) return;
  const hidden = new Set(state.hiddenPresetKeys);
  if (hidden.has(k)) hidden.delete(k); else hidden.add(k);
  state.hiddenPresetKeys = [...hidden];
  renderTimeline();
  saveSoon();
}

// ── Data loading ─────────────────────────────────────────────────────

function setProgressActive(active) {
  const node = el("playbackTimelineProgress");
  if (!node) return;
  node.dataset.active = active ? "true" : "false";
  node.setAttribute("aria-hidden", active ? "false" : "true");
}

async function loadDevices() {
  if (state.pageDisposed) return;
  const out = await api("/api/devices");
  state.devices = Array.isArray(out?.devices) ? out.devices : [];
  state.activeDeviceIds = state.activeDeviceIds.filter((id) =>
    state.devices.some((d) => d.id === id && d.profile_token));
}

async function fetchWindow(deviceId) {
  const params = new URLSearchParams({
    from: new Date(state.viewportStartMs).toISOString(),
    to: new Date(state.viewportEndMs).toISOString(),
    ts: String(Date.now()),
  });
  return api(`/api/playback/window?device_id=${encodeURIComponent(deviceId)}&${params.toString()}`,
    { cache: "no-store" });
}

async function fetchTimelineDay(deviceId, day) {
  const params = new URLSearchParams({ device_id: deviceId, day, ts: String(Date.now()) });
  return api(`/api/playback/timeline?${params.toString()}`, { cache: "no-store" });
}

// Snapshot of which day-buckets we last fetched events for, keyed by device.
// Used so a wheel-zoom that doesn't cross a day boundary doesn't re-fetch the
// (potentially large) per-day event lists.
const _eventDaysFetched = new Map(); // deviceId → Set<dayString>

function viewportDaySet() {
  const days = new Set();
  const dayMs = 24 * 3_600_000;
  for (let t = startOfLocalDay(state.viewportStartMs); t <= state.viewportEndMs + dayMs; t += dayMs) {
    days.add(dayString(t));
  }
  return days;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

async function loadDataForViewport(opts = {}) {
  if (state.pageDisposed || !state.activeDeviceIds.length) {
    state.coverage = new Map();
    state.thumbnails = new Map();
    state.events = [];
    _eventDaysFetched.clear();
    if (!opts.background) renderTimeline();
    return;
  }
  if (!opts.background) setProgressActive(true);
  const reqId = ++state.dataRequestId;

  // Coverage + thumbnails: cheap, always refetched for the precise window.
  // Events: heavier (per-day buckets), only refetched when day-set changes
  // for any active device, or when caller explicitly forces it.
  const days = viewportDaySet();
  const force = opts.forceEventRefresh === true;

  try {
    const windowResults = await Promise.all(
      state.activeDeviceIds.map((id) => fetchWindow(id).catch(() => null)),
    );
    if (reqId !== state.dataRequestId) return;

    const dayFetchPlan = state.activeDeviceIds.flatMap((id) => {
      const prev = _eventDaysFetched.get(id);
      if (!force && prev && setsEqual(prev, days)) return [];
      return [...days].map((d) => ({ id, day: d }));
    });
    const dayResults = dayFetchPlan.length
      ? await Promise.all(dayFetchPlan.map(({ id, day }) => fetchTimelineDay(id, day).catch(() => null)))
      : [];
    if (reqId !== state.dataRequestId) return;
    if (dayFetchPlan.length) {
      // Update the cache so we don't re-fetch the same day-set on every wheel tick.
      for (const id of state.activeDeviceIds) _eventDaysFetched.set(id, new Set(days));
    }

    // Coverage + thumbnails per device
    const coverage = new Map();
    const thumbs = new Map();
    state.activeDeviceIds.forEach((id, i) => {
      const w = windowResults[i];
      if (!w) return;
      const runs = (w.coverage || []).map((r) => ({
        startMs: parseISOms(r.start), endMs: parseISOms(r.end),
      })).filter((r) => r.startMs != null && r.endMs != null);
      coverage.set(id, runs);
      const thumbList = (w.thumbnails || []).map((t) => ({
        startMs: parseISOms(t.start),
        endMs: parseISOms(t.end),
        url: t.url,
        filename: t.filename,
      })).filter((t) => t.startMs != null && t.endMs != null);
      thumbs.set(id, thumbList);
    });
    state.coverage = coverage;
    state.thumbnails = thumbs;

    // Events — only refresh the list if we actually fetched any days. Otherwise
    // the cached state.events is still correct for the visible viewport.
    if (dayFetchPlan.length) {
      const seen = new Set();
      const events = [];
      for (const result of dayResults) {
        if (!result?.events) continue;
        for (const ev of result.events) {
          const id = String(ev?.id || "").trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          events.push(ev);
        }
      }
      state.events = events.sort((a, b) =>
        String(a?.triggered_at || "").localeCompare(String(b?.triggered_at || "")));
    }

    renderTimeline();
    // Coverage just changed — re-evaluate each tile's visibility. A tile that
    // was showing "No recording" because its old coverage didn't include the
    // cursor may now be in coverage (or vice versa).
    syncAllTilesToCursor(state.cursorMs, { allowReload: true });
  } finally {
    if (!opts.background) setProgressActive(false);
  }
}

// Debounced background reload, used by wheel/pan handlers that can fire many
// times per second. Drops everything but the trailing edge.
let _loadDataDebounceTimer = 0;
function loadDataForViewportSoon(opts = {}) {
  if (_loadDataDebounceTimer) window.clearTimeout(_loadDataDebounceTimer);
  _loadDataDebounceTimer = window.setTimeout(() => {
    _loadDataDebounceTimer = 0;
    loadDataForViewport({ background: true, ...opts }).catch(() => {});
  }, 200);
}

function startDataRefresh() {
  stopDataRefresh();
  // Live edge moves with wall-clock; viewing the past is static. Poll fast
  // when following live, slow otherwise.
  const tick = () => {
    if (state.pageDisposed) return;
    if (document.visibilityState === "visible") {
      loadDataForViewport({ background: true }).catch(() => {});
    }
    const interval = (state.followLive || isLive())
      ? TIMELINE_DATA_REFRESH_LIVE_MS
      : TIMELINE_DATA_REFRESH_IDLE_MS;
    state.dataRefreshTimer = window.setTimeout(tick, interval);
  };
  state.dataRefreshTimer = window.setTimeout(tick, TIMELINE_DATA_REFRESH_LIVE_MS);
}

function stopDataRefresh() {
  if (state.dataRefreshTimer) {
    window.clearTimeout(state.dataRefreshTimer);
    state.dataRefreshTimer = 0;
  }
}

// ── Active device set ────────────────────────────────────────────────

async function setActiveDeviceIds(ids, opts = {}) {
  const seen = new Set(); const next = [];
  for (const id of ids) {
    const t = String(id || "").trim();
    if (!t || seen.has(t)) continue;
    if (!state.devices.find((d) => d.id === t && d.profile_token)) continue;
    seen.add(t); next.push(t);
  }
  // Drop the day-cache only for devices the user removed — keeps existing
  // devices' caches warm so adding/removing a single camera doesn't trigger
  // a full event refetch across the whole active set.
  const nextSet = new Set(next);
  for (const id of [..._eventDaysFetched.keys()]) {
    if (!nextSet.has(id)) _eventDaysFetched.delete(id);
  }
  state.activeDeviceIds = next;
  if (window.views?.selectedDevices) {
    window.views.selectedDevices.clear();
    for (const id of next) window.views.selectedDevices.add(id);
  }
  if (typeof window.viewsPlayback?.afterSidebarRender === "function") {
    window.viewsPlayback.afterSidebarRender();
  }
  syncTilesToActive();
  saveSoon();

  if (opts.reloadData !== false) await loadDataForViewport().catch(() => {});

  // Bring up playlists for newly added tiles.
  for (const tile of tiles.values()) {
    if (!tile.lastUrl) loadTilePlaylist(tile);
  }
  if (state.isPlaying) play();
}

async function toggleActiveDevice(deviceId) {
  const idx = state.activeDeviceIds.indexOf(deviceId);
  const next = idx === -1
    ? [...state.activeDeviceIds, deviceId]
    : state.activeDeviceIds.filter((id) => id !== deviceId);
  await setActiveDeviceIds(next);
}

// ── Thumbnail preview ────────────────────────────────────────────────

function findThumbnailForMs(ms) {
  // Only consider active devices to avoid scanning thumbnails from cameras
  // the user removed but whose data still lingers in state.thumbnails.
  for (const id of state.activeDeviceIds) {
    const list = state.thumbnails.get(id);
    if (!list) continue;
    const hit = list.find((t) => ms >= t.startMs && ms < t.endMs);
    if (hit) return hit;
  }
  return null;
}

function showThumbPreview(ms, clientX, trackRect) {
  const preview = el("playbackThumbPreview");
  if (!preview) return;
  const thumb = findThumbnailForMs(ms);
  if (!thumb) { preview.classList.add("hidden"); return; }
  const img = el("playbackThumbPreviewImg");
  const label = el("playbackThumbPreviewLabel");
  if (img && img.src !== thumb.url && img.dataset.url !== thumb.url) {
    img.src = thumb.url;
    img.dataset.url = thumb.url;
  }
  if (label) label.textContent = fmtClock(ms);
  // Clamp to track rect so the preview doesn't overflow off-screen.
  const half = 130; // approximate half-width of preview
  const trackWidth = trackRect.width || 1;
  const x = clamp(clientX - trackRect.left, half, trackWidth - half);
  preview.style.left = `${x}px`;
  preview.classList.remove("hidden");
}

function hideThumbPreview() {
  const preview = el("playbackThumbPreview");
  if (preview) preview.classList.add("hidden");
}

// ── Timeline interactions ────────────────────────────────────────────

function timelineMsFromClientX(clientX, rect) {
  const w = rect.width || 1;
  const ratio = clamp((clientX - rect.left) / w, 0, 1);
  return state.viewportStartMs + ratio * (state.viewportEndMs - state.viewportStartMs);
}

function bindTimelineInteractions() {
  const track = el("playbackTimelineTrack");
  if (!track) return;

  // Wheel: zoom centered on the cursor's pointer position; horizontal delta = pan
  track.addEventListener("wheel", (event) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    event.preventDefault();
    const dur = state.viewportEndMs - state.viewportStartMs;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.2) {
      const deltaMs = (event.deltaX / rect.width) * dur;
      setViewport(state.viewportStartMs + deltaMs, dur);
      return;
    }
    const pointerRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const focusMs = state.viewportStartMs + pointerRatio * dur;
    const nextDur = clamp(dur * Math.exp(event.deltaY * 0.0025), MIN_ZOOM_MS, MAX_ZOOM_MS);
    const nextStart = focusMs - pointerRatio * nextDur;
    setViewport(nextStart, nextDur);
    syncZoomPresets();
    loadDataForViewportSoon();
  }, { passive: false });

  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    // Cursor grab — start scrub
    if (target?.closest("#playbackTimelineCursor")) {
      event.preventDefault(); event.stopPropagation();
      state.scrub.active = true;
      state.scrub.pointerId = event.pointerId;
      state.scrub.wasPlaying = state.isPlaying;
      state.scrub.pendingMs = null;
      pause();
      track.setPointerCapture(event.pointerId);
      target.closest("#playbackTimelineCursor")?.classList.add("is-scrubbing");
      return;
    }
    // Marker click is handled by click handler — don't start a pan
    if (target?.closest(".playbackMarker")) return;

    state.pan.pointerId = event.pointerId;
    state.pan.dragOriginX = event.clientX;
    state.pan.dragOriginStartMs = state.viewportStartMs;
    state.pan.dragOriginDuration = state.viewportEndMs - state.viewportStartMs;
    state.pan.isDragging = false;
    track.setPointerCapture(event.pointerId);
  });

  track.addEventListener("pointermove", (event) => {
    const rect = track.getBoundingClientRect();
    const ms = timelineMsFromClientX(event.clientX, rect);
    showThumbPreview(ms, event.clientX, rect);

    if (state.scrub.active && event.pointerId === state.scrub.pointerId) {
      state.scrub.pendingMs = ms;
      if (!state.scrub.rafId) {
        state.scrub.rafId = requestAnimationFrame(() => {
          state.scrub.rafId = 0;
          if (!state.scrub.active || state.scrub.pendingMs == null) return;
          const target = state.scrub.pendingMs;
          state.scrub.pendingMs = null;
          // During the drag we just move the cursor + seek tiles whose
          // playlists already cover the new position. We do NOT trigger a
          // reload per scrub tick — at 60fps that would be 60 playlist fetches
          // per second across every camera. The single reload happens on
          // pointer release (finishScrub) via play() / setCursor().
          setCursor(target, { userInitiated: true, reloadIfNeeded: false });
        });
      }
      return;
    }
    if (event.pointerId !== state.pan.pointerId) return;
    const dx = event.clientX - state.pan.dragOriginX;
    if (!state.pan.isDragging && Math.abs(dx) < PAN_DRAG_THRESHOLD_PX) return;
    state.pan.isDragging = true;
    track.classList.add("is-dragging");
    if (!rect.width) return;
    const dur = state.pan.dragOriginDuration;
    const deltaMs = (dx / rect.width) * dur;
    setViewport(state.pan.dragOriginStartMs - deltaMs, dur);
  });

  const finishScrub = (event) => {
    if (!state.scrub.active || event.pointerId !== state.scrub.pointerId) return false;
    if (state.scrub.rafId) {
      cancelAnimationFrame(state.scrub.rafId);
      state.scrub.rafId = 0;
    }
    document.querySelector("#playbackTimelineCursor")?.classList.remove("is-scrubbing");
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
    const wasPlaying = state.scrub.wasPlaying;
    const finalMs = state.cursorMs;
    state.scrub.active = false; state.scrub.pointerId = null;
    state.scrub.wasPlaying = false; state.scrub.pendingMs = null;
    // Force a final reload-aware setCursor — scrub-RAF was using
    // reloadIfNeeded:false, so any tile whose loaded window doesn't cover
    // the drop point hasn't loaded yet. This fixes that.
    setCursor(finalMs, { userInitiated: true, reloadIfNeeded: true, force: true });
    if (wasPlaying) play();
    return true;
  };

  const finishPan = (event) => {
    if (finishScrub(event)) return;
    if (event.pointerId !== state.pan.pointerId) return;
    if (state.pan.isDragging) {
      state.pan.suppressClickUntil = Date.now() + CLICK_SUPPRESSION_MS;
      loadDataForViewportSoon();
    }
    state.pan.pointerId = null;
    state.pan.isDragging = false;
    track.classList.remove("is-dragging");
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };

  track.addEventListener("pointerup", finishPan);
  track.addEventListener("pointercancel", finishPan);
  track.addEventListener("pointerleave", () => hideThumbPreview());
  track.addEventListener("mouseleave", () => hideThumbPreview());

  track.addEventListener("click", (event) => {
    if (Date.now() < state.pan.suppressClickUntil) return;
    // Always seek to the wall-clock position under the pointer, regardless of
    // whether the click landed on an event marker, the coverage bar, or the
    // empty lane. Markers are visual bookmarks, not jump-to-start triggers.
    const rect = track.getBoundingClientRect();
    const ms = timelineMsFromClientX(event.clientX, rect);
    setCursor(ms, { userInitiated: true });
    if (!state.isPlaying) play();
  });
}

// ── UI bindings ──────────────────────────────────────────────────────

function applyDayInputFromViewport() {
  const day = el("playbackDayInput");
  if (day) day.value = dayString(state.cursorMs);
}

function jumpToDay(dayStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return;
  const [y, m, d] = dayStr.split("-").map(Number);
  const startOfDay = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  // Place cursor at noon of that day (or now() if today)
  const target = dayString(Date.now()) === dayStr
    ? Date.now() - 1500
    : startOfDay + 12 * 3_600_000;
  state.followLive = isLive(target);
  state.cursorMs = target;
  centerViewportOnCursor();
  applyDayInputFromViewport();
  syncCursorUI();
  syncTransport();
  renderTimeline();
  saveSoon();
  loadDataForViewport().catch(() => {});
  reloadAllTilesForCursor();
}

function bindUi() {
  const stored = loadStored();
  if (stored) {
    // Clamp restored cursor to a sane window — guards against corrupted
    // localStorage (e.g., year 2099 timestamp) that would put the cursor
    // outside any possible recording.
    const rawCursor = Number(stored.cursorMs);
    const minCursor = Date.now() - 365 * 24 * 3_600_000;       // 1 year ago
    const maxCursor = Date.now() + 24 * 3_600_000;             // 24h ahead
    state.cursorMs = Number.isFinite(rawCursor)
      ? clamp(rawCursor, minCursor, maxCursor)
      : (Date.now() - 30_000);

    const rawZoom = Number(stored.zoomMs);
    state.zoomMs = Number.isFinite(rawZoom)
      ? clamp(rawZoom, MIN_ZOOM_MS, MAX_ZOOM_MS)
      : DEFAULT_ZOOM_MS;

    state.speed = SPEED_OPTIONS.includes(Number(stored.speed)) ? Number(stored.speed) : 1;
    state.followLive = !!stored.followLive;
    state.activeDeviceIds = Array.isArray(stored.activeDeviceIds)
      ? stored.activeDeviceIds.filter((id) => typeof id === "string" && id)
      : [];
    state.hiddenPresetKeys = Array.isArray(stored.hiddenPresetKeys)
      ? stored.hiddenPresetKeys.filter((k) => typeof k === "string" && k)
      : [];
    centerViewportOnCursor();
  }

  applyDayInputFromViewport();
  bindTimelineInteractions();
  renderTimeline();

  // Sidebar (shared with views-live.js)
  el("viewsCameraList")?.addEventListener("click", async (event) => {
    if (window.views?.mode !== "playback") return;
    const row = event.target instanceof Element ? event.target.closest(".liveSidebarRow[data-id]") : null;
    if (!row) return;
    if (event.target.closest(".liveSidebarDragHandle")) return;
    const id = row.getAttribute("data-id");
    if (!id) return;
    await toggleActiveDevice(id);
  });

  el("playbackSidebarSelectAll")?.addEventListener("click", async () => {
    const all = state.devices.filter((d) => d.profile_token).map((d) => d.id);
    await setActiveDeviceIds(all);
  });

  el("playbackSidebarClearAll")?.addEventListener("click", async () => {
    await setActiveDeviceIds([]);
  });

  el("playbackDayInput")?.addEventListener("change", (event) => {
    jumpToDay(event.target.value || dayString(Date.now()));
  });

  el("playbackPrevDayBtn")?.addEventListener("click", () => {
    const target = state.cursorMs - 24 * 3_600_000;
    state.cursorMs = target;
    state.followLive = false;
    centerViewportOnCursor();
    applyDayInputFromViewport();
    syncCursorUI(); syncTransport(); renderTimeline(); saveSoon();
    loadDataForViewport().catch(() => {});
    reloadAllTilesForCursor();
  });

  el("playbackNextDayBtn")?.addEventListener("click", () => {
    const target = Math.min(Date.now(), state.cursorMs + 24 * 3_600_000);
    state.cursorMs = target;
    state.followLive = isLive(target);
    centerViewportOnCursor();
    applyDayInputFromViewport();
    syncCursorUI(); syncTransport(); renderTimeline(); saveSoon();
    loadDataForViewport().catch(() => {});
    reloadAllTilesForCursor();
  });

  el("playbackTodayBtn")?.addEventListener("click", () => jumpToLive());

  el("playbackPlayPauseBtn")?.addEventListener("click", () => togglePlay());

  el("playbackReplay30Btn")?.addEventListener("click", () => jumpRelative(-30_000));
  el("playbackReplay5Btn")?.addEventListener("click", () => jumpRelative(-5_000));
  el("playbackFwd5Btn")?.addEventListener("click", () => jumpRelative(5_000));
  el("playbackFwd30Btn")?.addEventListener("click", () => jumpRelative(30_000));
  el("playbackFrameBackBtn")?.addEventListener("click", () => frameStep(false));
  el("playbackFrameFwdBtn")?.addEventListener("click", () => frameStep(true));
  el("playbackLiveBtn")?.addEventListener("click", () => jumpToLive());

  el("playbackSpeedSelect")?.addEventListener("change", (event) => setSpeed(event.target.value));

  el("playbackTimelineFilters")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-preset-key]") : null;
    if (target) togglePresetKey(target.getAttribute("data-preset-key"));
  });

  el("playbackZoomPresets")?.addEventListener("click", (event) => {
    const btn = event.target instanceof Element ? event.target.closest("[data-zoom-ms]") : null;
    if (!btn) return;
    setZoomMs(Number(btn.dataset.zoomMs));
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (event) => {
    if (window.views?.mode !== "playback") return;
    if (event.target instanceof HTMLElement) {
      const tag = event.target.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    }
    switch (event.key) {
      case " ": event.preventDefault(); togglePlay(); break;
      case "ArrowLeft": event.preventDefault(); jumpRelative(event.shiftKey ? -30_000 : -5_000); break;
      case "ArrowRight": event.preventDefault(); jumpRelative(event.shiftKey ? 30_000 : 5_000); break;
      case ",": event.preventDefault(); frameStep(false); break;
      case ".": event.preventDefault(); frameStep(true); break;
      case "l": case "L": event.preventDefault(); jumpToLive(); break;
    }
  });

  window.addEventListener("pagehide", () => disposePlaybackPage());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && state.pageDisposed) window.location.reload();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // Tab returned. Two things may have drifted while it was hidden:
      // (1) coverage data is stale, and (2) if the user was following live,
      // the cursor froze (RAF was throttled) so we should jump back to "now".
      if (state.followLive && state.isPlaying) {
        setCursor(Date.now() - 1500, { userInitiated: false });
      }
      loadDataForViewport({ background: true }).catch(() => {});
    }
  });

  window.addEventListener("resize", () => {
    requestAnimationFrame(recomputeGrid);
    renderTimeline();
  });

  syncTransport();
  syncCursorUI();
}

// ── Mount/unmount ────────────────────────────────────────────────────

async function refreshAll() {
  try {
    await loadDevices();
    syncTilesToActive();
    // Mirror our selection onto the shared sidebar (rendered by views-live.js).
    // Sidebar render happens before our state.activeDeviceIds is finalized, so
    // we re-decorate after we know which cameras are active.
    if (typeof window.viewsPlayback?.afterSidebarRender === "function") {
      window.viewsPlayback.afterSidebarRender();
    }
    await loadDataForViewport();
    reloadAllTilesForCursor();
    if (state.followLive) {
      jumpToLive();
    }
  } catch (error) {
    if (isAbortError(error) || state.pageDisposed) return;
    setStatus(error.message || String(error));
  }
}

async function enterPlaybackMode() {
  const sharedIds = Array.from(window.views?.selectedDevices ?? []);
  if (!_initialized) {
    _initialized = true;
    if (sharedIds.length) state.activeDeviceIds = sharedIds;
    await refreshAll();
    if (!sharedIds.length && window.views?.selectedDevices) {
      for (const id of state.activeDeviceIds) window.views.selectedDevices.add(id);
    }
  } else {
    try {
      await loadDevices();
      await setActiveDeviceIds(sharedIds, { reloadData: false });
      await loadDataForViewport({ background: true });
    } catch (error) {
      setStatus(error.message || String(error));
    }
  }
  startDataRefresh();
  startReloadCheck();
}

function pauseAllTileVideos() {
  for (const tile of tiles.values()) {
    if (tile.video && !tile.video.paused) {
      try { tile.video.pause(); } catch {}
    }
  }
}

function disposePlaybackPage() {
  if (state.pageDisposed) return;
  state.pageDisposed = true;
  state.abortController.abort();
  stopDataRefresh();
  stopReloadCheck();
  stopLiveTick();
  pauseAllTileVideos();
  destroyAllTiles();
  saveNow();
}

// ── External integration points (views-live.js) ─────────────────────

window.viewsPlayback = {
  afterSidebarRender() {
    if (window.views?.mode !== "playback") return;
    const list = el("viewsCameraList");
    if (!list) return;
    const selected = new Set(state.activeDeviceIds);
    list.querySelectorAll(".liveSidebarRow[data-id]").forEach((row) => {
      const id = row.getAttribute("data-id");
      const isSel = selected.has(id);
      row.classList.toggle("active", isSel);
      row.classList.remove("is-starting", "is-error");
    });
  },
  onSidebarReorder(orderedIds) {
    if (!Array.isArray(orderedIds) || !orderedIds.length) return;
    const byId = new Map(state.devices.map((d) => [d.id, d]));
    const reordered = [];
    for (const id of orderedIds) {
      const d = byId.get(id);
      if (d) { reordered.push(d); byId.delete(id); }
    }
    for (const d of state.devices) if (byId.has(d.id)) { reordered.push(d); byId.delete(d.id); }
    state.devices = reordered;
    const activeSet = new Set(state.activeDeviceIds);
    const orderedActive = []; const seen = new Set();
    for (const id of orderedIds) if (activeSet.has(id) && !seen.has(id)) { orderedActive.push(id); seen.add(id); }
    for (const id of state.activeDeviceIds) if (!seen.has(id)) { orderedActive.push(id); seen.add(id); }
    state.activeDeviceIds = orderedActive;
    if (window.views?.mode === "playback") syncTilesToActive();
  },
  async onModeChange(next, prev) {
    if (next === "playback") {
      await enterPlaybackMode();
      this.afterSidebarRender();
    } else if (prev === "playback") {
      stopDataRefresh();
      stopReloadCheck();
      stopLiveTick();
      pauseAllTileVideos();
    }
  },
};

// Wire UI handlers (must be ready when user enters playback mode).
bindUi();

// Auto-init only if we're starting in playback mode.
if (window.views?.mode === "playback") {
  enterPlaybackMode().catch((e) => console.error("playback init failed:", e));
}

})();
