// Playback page — multi-camera timeline scrubber.
//
// Model: a single wall-clock cursor (state.cursorMs) drives every tile in
// sync. Each selected camera owns one <video> element inside the grid, and
// one lane on the timeline below.
//
// While playing, an rAF loop advances state.cursorMs at (real-time × speed)
// and lets each tile's <video> play naturally at the same playbackRate. The
// loop only seeks a tile's video when:
//   • the cursor crossed the boundary into a different clip for that camera
//   • the tile drifted more than 0.5 s from where the cursor says it should be
//
// While scrubbing/panning, everything is paused and tiles re-seek every
// pointermove. The same input model as before — scrub on cursor handle,
// pan on empty track, ctrl/⌘+wheel or pinch to zoom, plain wheel pans on
// trackpads and zooms on a mouse wheel.

(() => {
  "use strict";

  const STORAGE_KEY = "smarteye.playback.v6";
  const DRAG_THRESHOLD_PX = 4;
  const PAN_INERTIA_FRICTION = 0.92;
  const MIN_ZOOM_MS = 60_000;
  const MAX_ZOOM_MS = 30 * 24 * 3_600_000;
  const SYNC_DRIFT_TOLERANCE_S = 0.5;

  // ── State ──────────────────────────────────────────────────────────

  const state = {
    devices: [],                  // [{id, name, …}]
    deviceNames: {},              // "cam-<id>" → friendly name
    cameras: [],                  // [{camera, n, last_at}] from /api/clips/cameras
    selectedCameras: [],          // ordered list of camera path names
    clipsByCamera: {},            // camera → [clip…]
    activeByCamera: {},           // camera → [active_recording…] (in-progress)
    activeRefreshTimer: 0,
    hiddenTags: new Set(),        // tag strings filtered out of the timeline
    maximizedTile: null,          // tile element when in fullscreen-style maximize
    // Per-camera manual quality override. Cameras present in this set
    // request the 480p variant via `?q=low`. Default = empty = HD for all.
    lowQualityCameras: new Set(),
    tiles: {},                    // camera → { el, video, currentClipId, currentClip, overlay }
    cursorMs: Date.now(),
    zoomMs: 3_600_000,
    viewportStartMs: 0,
    viewportEndMs: 0,
    isPlaying: false,
    speed: 1,
    fetchToken: 0,
    refetchTimer: 0,
    pan: { active: false, kind: null, pointerId: null, dragOriginX: 0, dragOriginViewportStart: 0, moved: false, wasPlaying: false, lastClientX: 0, lastT: 0, vx: 0 },
    inertiaRaf: 0,
    playRaf: 0,
    playLastT: 0,
    autoRefreshTimer: 0,
    lastLastAt: {},               // camera → last_at we've seen
  };

  function cameraDisplayName(camera) {
    return state.deviceNames[camera] || camera;
  }

  // ── DOM ────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  const els = {};
  function resolveEls() {
    els.cameraList = $("pbCameraList");
    els.selectAllBtn = $("pbSelectAllBtn");
    els.clearAllBtn = $("pbClearAllBtn");
    els.videoGrid = $("pbVideoGrid");
    els.gridEmpty = $("pbGridEmpty");
    els.prevDayBtn = $("pbPrevDayBtn");
    els.nextDayBtn = $("pbNextDayBtn");
    els.dayInput = $("pbDayInput");
    els.todayBtn = $("pbTodayBtn");
    els.zoomBtns = Array.from(document.querySelectorAll(".pbZoomBtn"));
    els.scale = $("pbTimelineScale");
    els.track = $("pbTimelineTrack");
    els.lanes = $("pbTimelineLanes");
    els.nowLine = $("pbNowLine");
    els.cursor = $("pbCursor");
    els.cursorLabel = $("pbCursorLabel");
    els.stepBackBtn = $("pbStepBackBtn");
    els.rewindBtn = $("pbRewindBtn");
    els.playPauseBtn = $("pbPlayPauseBtn");
    els.playGlyph = $("pbPlayGlyph");
    els.pauseGlyph = $("pbPauseGlyph");
    els.forwardBtn = $("pbForwardBtn");
    els.stepFwdBtn = $("pbStepFwdBtn");
    els.transportTime = $("pbTransportTime");
    els.speedSelect = $("pbSpeedSelect");
    els.tagList = $("pbTagList");
    els.tagShowAllBtn = $("pbTagShowAllBtn");
    els.tagHideAllBtn = $("pbTagHideAllBtn");
    return !!els.track;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const escapeHtml = (s) => String(s ?? "").replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" }[c]));

  const fmtClock = (ms) => new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
  });
  const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
  });
  const dayInputValue = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const parseDayInputValue = (v) => {
    const [y, m, d] = v.split("-").map(Number);
    const dt = new Date(); dt.setFullYear(y, m - 1, d); dt.setHours(12, 0, 0, 0);
    return dt.getTime();
  };

  function clipMetaColor(clip) {
    const c = clip && clip.metadata && clip.metadata.color;
    return (typeof c === "string" && c.trim()) ? c.trim() : null;
  }
  function clipMetaTag(clip) {
    const m = (clip && clip.metadata) || {};
    return m.title || m.preset_name || m.flow_name || "";
  }
  // Sidebar-filter key for a clip — matches the keys collectTagsInView()
  // uses so state.hiddenTags lookups line up.
  function clipFilterKey(clip) {
    if (clip.kind === "continuous") return "__continuous__";
    return clipMetaTag(clip) || "Untitled";
  }
  function isClipVisible(clip) {
    return !state.hiddenTags.has(clipFilterKey(clip));
  }

  function clipForCameraAt(camera, ts) {
    const list = state.clipsByCamera[camera] || [];
    return list.find((c) =>
      c.started_at <= ts && ts <= c.ended_at && isClipVisible(c)) || null;
  }
  function nextClipForCameraAfter(camera, ts) {
    const list = state.clipsByCamera[camera] || [];
    let best = null;
    for (const c of list) {
      if (!isClipVisible(c)) continue;
      if (c.started_at > ts && (!best || c.started_at < best.started_at)) best = c;
    }
    return best;
  }
  function prevClipForCameraBefore(camera, ts) {
    const list = state.clipsByCamera[camera] || [];
    let best = null;
    for (const c of list) {
      if (!isClipVisible(c)) continue;
      if (c.ended_at < ts && (!best || c.ended_at > best.ended_at)) best = c;
    }
    return best;
  }

  // Find the closest clip across ALL selected cameras whose start > ts (or whose end < ts for prev).
  function nextClipAnyAfter(ts) {
    let best = null;
    for (const cam of state.selectedCameras) {
      const c = nextClipForCameraAfter(cam, ts);
      if (c && (!best || c.started_at < best.started_at)) best = c;
    }
    return best;
  }
  function prevClipAnyBefore(ts) {
    let best = null;
    for (const cam of state.selectedCameras) {
      const c = prevClipForCameraBefore(cam, ts);
      if (c && (!best || c.ended_at > best.ended_at)) best = c;
    }
    return best;
  }

  // ── Persistence ────────────────────────────────────────────────────

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        selectedCameras: state.selectedCameras,
        zoomMs: state.zoomMs,
        cursorMs: state.cursorMs,
        speed: state.speed,
        hiddenTags: Array.from(state.hiddenTags),
        lowQualityCameras: Array.from(state.lowQualityCameras),
      }));
    } catch (_) {}
  }
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!s) return;
      if (Array.isArray(s.selectedCameras)) state.selectedCameras = s.selectedCameras;
      if (typeof s.zoomMs === "number") state.zoomMs = clamp(s.zoomMs, MIN_ZOOM_MS, MAX_ZOOM_MS);
      if (typeof s.cursorMs === "number") state.cursorMs = s.cursorMs;
      if (typeof s.speed === "number" && s.speed > 0) state.speed = s.speed;
      if (Array.isArray(s.hiddenTags)) state.hiddenTags = new Set(s.hiddenTags);
      if (Array.isArray(s.lowQualityCameras)) state.lowQualityCameras = new Set(s.lowQualityCameras);
    } catch (_) {}
  }

  // ── Data fetching ──────────────────────────────────────────────────

  async function fetchJson(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  async function loadDevices() {
    try {
      const d = await fetchJson("/api/devices");
      state.devices = d.devices || [];
      for (const dev of state.devices) {
        if (dev && dev.id) {
          state.deviceNames[`cam-${dev.id}`] = (dev.name && String(dev.name).trim()) || dev.id;
        }
      }
    } catch (e) {
      console.warn("loadDevices failed", e);
    }
  }

  async function loadCameras() {
    try {
      const d = await fetchJson("/api/clips/cameras");
      state.cameras = d.items || [];
    } catch (e) {
      console.warn("loadCameras failed", e);
      state.cameras = [];
    }
  }

  function scheduleClipFetch(delayMs = 80) {
    if (state.refetchTimer) clearTimeout(state.refetchTimer);
    state.refetchTimer = setTimeout(() => {
      state.refetchTimer = 0;
      loadClipsForViewport();
    }, delayMs);
  }

  async function loadClipsForViewport() {
    if (state.selectedCameras.length === 0) {
      state.clipsByCamera = {};
      renderLanes();
      return;
    }
    const token = ++state.fetchToken;
    const pad = state.zoomMs * 0.5;
    const from = Math.floor((state.viewportStartMs - pad) / 1000);
    const to = Math.ceil((state.viewportEndMs + pad) / 1000);
    // limit must stay ≤ the API's `le` constraint (currently 5000). If a busy
    // camera has more clips in the viewport than that, the rest are dropped;
    // we'd page or compress server-side at that point.
    const fetches = state.selectedCameras.map(async (cam) => {
      const params = new URLSearchParams({
        camera: cam, from: String(from), to: String(to), limit: "5000",
      });
      try {
        const d = await fetchJson("/api/clips?" + params.toString());
        return [cam, d.items || []];
      } catch (e) {
        console.warn(`loadClips(${cam}) failed`, e);
        return [cam, []];
      }
    });
    const results = await Promise.all(fetches);
    if (token !== state.fetchToken) return;
    const next = {};
    for (const [cam, list] of results) next[cam] = list;
    state.clipsByCamera = next;
    // Active recordings are independent of clip fetching but we kick them
    // off here so an initial render of in-progress strips happens alongside
    // the first paint of completed clips.
    loadActiveRecordings();
    renderLanes();
    syncAllTiles();
    refreshSidebarStatus();
    renderTagFilter();
  }

  async function loadActiveRecordings() {
    if (state.selectedCameras.length === 0) {
      state.activeByCamera = {};
      return;
    }
    const fetches = state.selectedCameras.map(async (cam) => {
      const params = new URLSearchParams({ camera: cam });
      try {
        const d = await fetchJson("/api/record/active?" + params.toString());
        return [cam, d.items || []];
      } catch (e) {
        return [cam, []];
      }
    });
    const results = await Promise.all(fetches);
    const next = {};
    for (const [cam, list] of results) next[cam] = list;
    state.activeByCamera = next;
    renderLanes();
  }

  function ensureActiveRecordingsTimer() {
    if (state.activeRefreshTimer) return;
    // Re-poll the active set every 15s so the in-progress strip both extends
    // to the new "now" and disappears within ~15s of the chunk closing /
    // continuous toggle being turned off.
    state.activeRefreshTimer = setInterval(() => {
      loadActiveRecordings();
    }, 15_000);
  }

  // If the current viewport has no clips for any selected camera, hop the
  // cursor to the most recent last_at across the selected cameras.
  async function ensureCursorNearClips() {
    if (state.selectedCameras.length === 0) return;
    const anyHere = state.selectedCameras.some(
      (c) => (state.clipsByCamera[c] || []).length > 0);
    if (anyHere) return;
    let latest = 0;
    for (const c of state.selectedCameras) {
      const cam = state.cameras.find((x) => x.camera === c);
      if (cam && cam.last_at && cam.last_at > latest) latest = cam.last_at;
    }
    if (!latest) return;
    state.cursorMs = latest * 1000;
    recomputeViewportAroundCursor();
    await loadClipsForViewport();
  }

  // ── Viewport math ──────────────────────────────────────────────────

  function recomputeViewportAroundCursor() {
    const half = state.zoomMs / 2;
    state.viewportStartMs = state.cursorMs - half;
    state.viewportEndMs = state.cursorMs + half;
  }
  function msAtClientX(clientX) {
    const rect = els.track.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    return state.viewportStartMs + (x / rect.width) * state.zoomMs;
  }

  // ── Sidebar ────────────────────────────────────────────────────────

  function renderSidebar() {
    if (!state.devices.length) {
      els.cameraList.innerHTML = '<div class="liveSidebarEmpty">No cameras configured</div>';
      return;
    }
    // Sort by friendly name (numeric-aware).
    const sorted = state.devices.slice().sort((a, b) => {
      const an = (a.name || a.id).toString();
      const bn = (b.name || b.id).toString();
      return an.localeCompare(bn, undefined, { numeric: true });
    });
    els.cameraList.innerHTML = sorted.map((d) => {
      const camera = `cam-${d.id}`;
      const hasClips = !!state.cameras.find((c) => c.camera === camera);
      const isActive = state.selectedCameras.includes(camera);
      const low = state.lowQualityCameras.has(camera);
      const qLabel = low ? "SD" : "HD";
      const qCls = low ? "pbQualityToggle is-low" : "pbQualityToggle";
      const qTitle = low
        ? "Playing the 480p variant for this camera — click to switch back to original quality."
        : "Playing the original-quality stream — click to switch this camera to a 480p variant.";
      return `<div class="liveSidebarRow ${isActive ? "active" : ""} ${hasClips ? "has-clips" : ""}" data-camera="${escapeHtml(camera)}">
        <button class="liveSidebarDragHandle" type="button" tabindex="-1" aria-hidden="true">⋮⋮</button>
        <span class="liveSidebarName">${escapeHtml(d.name || d.id)}</span>
        <button class="${qCls}" type="button" data-camera="${escapeHtml(camera)}" title="${escapeHtml(qTitle)}">${qLabel}</button>
        <span class="statusDot"></span>
      </div>`;
    }).join("");
  }

  function refreshSidebarStatus() {
    // Update green-dot indicators in case selection or clip data changed.
    for (const row of els.cameraList.querySelectorAll(".liveSidebarRow")) {
      const camera = row.dataset.camera;
      const hasClips = !!state.cameras.find((c) => c.camera === camera);
      row.classList.toggle("has-clips", hasClips);
      row.classList.toggle("active", state.selectedCameras.includes(camera));
    }
  }

  // Sentinel "tag" key for the Continuous lane so it can be filtered in
  // the same sidebar list as user-defined triggered tags. The leading
  // underscores avoid colliding with any real preset name.
  const CONTINUOUS_TAG_KEY = "__continuous__";

  // Build the list of distinct tag rows currently in view. Triggered clips
  // contribute their tag (display name from metadata); continuous clips +
  // active in-progress recordings collapse into one Continuous entry.
  // Returns rows in display order, with the Continuous row pinned first.
  function collectTagsInView() {
    const map = new Map(); // key → { key, name, color, count }
    let continuousCount = 0;
    for (const cam of state.selectedCameras) {
      const list = state.clipsByCamera[cam] || [];
      for (const c of list) {
        if (c.kind === "continuous") {
          continuousCount++;
          continue;
        }
        const tag = clipMetaTag(c) || "Untitled";
        const cur = map.get(tag);
        if (cur) {
          cur.count++;
          if (!cur.color) cur.color = clipMetaColor(c);
        } else {
          map.set(tag, { key: tag, name: tag, color: clipMetaColor(c), count: 1 });
        }
      }
      // Active in-progress chunks count as continuous "in view" too.
      for (const a of (state.activeByCamera[cam] || [])) {
        if (a.kind === "continuous") continuousCount++;
      }
    }
    const triggered = Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }));
    const rows = [];
    if (continuousCount > 0) {
      rows.push({
        key: CONTINUOUS_TAG_KEY,
        name: "Continuous",
        color: null,        // rendered with a neutral grey swatch
        count: continuousCount,
      });
    }
    rows.push(...triggered);
    return rows;
  }

  function renderTagFilter() {
    if (!els.tagList) return;
    const tags = collectTagsInView();
    if (tags.length === 0) {
      els.tagList.innerHTML = '<div class="liveSidebarEmpty">No tags in view</div>';
      return;
    }
    els.tagList.innerHTML = tags.map((t) => {
      const hidden = state.hiddenTags.has(t.key);
      const swatch = t.color
        ? `<span class="pbTagSwatch" style="background:${escapeHtml(t.color)};"></span>`
        : '<span class="pbTagSwatch pbTagSwatchEmpty"></span>';
      return `<div class="liveSidebarRow pbTagRow${hidden ? "" : " active"}" data-tag="${escapeHtml(t.key)}" title="${t.count} clip${t.count === 1 ? "" : "s"}">
        ${swatch}
        <span class="liveSidebarName">${escapeHtml(t.name)}</span>
        <span class="pbTagCount muted">${t.count}</span>
      </div>`;
    }).join("");
  }

  function toggleTag(key) {
    if (state.hiddenTags.has(key)) state.hiddenTags.delete(key);
    else state.hiddenTags.add(key);
    saveState();
    renderTagFilter();
    renderLanes();
    // The tile lookups (clipForCameraAt etc.) now skip hidden-tag clips,
    // so a tile playing a freshly-hidden clip needs to drop it / find a
    // visible one. Without this re-sync, video keeps playing until the
    // hidden clip ends naturally.
    syncAllTiles();
  }

  function setAllTagsHidden(hidden) {
    const tags = collectTagsInView();
    if (hidden) {
      for (const t of tags) state.hiddenTags.add(t.key);
    } else {
      state.hiddenTags.clear();
    }
    saveState();
    renderTagFilter();
    renderLanes();
    syncAllTiles();
  }

  function toggleCamera(camera) {
    const i = state.selectedCameras.indexOf(camera);
    if (i >= 0) state.selectedCameras.splice(i, 1);
    else state.selectedCameras.push(camera);
    onSelectionChanged();
  }

  function toggleCameraQuality(camera) {
    if (state.lowQualityCameras.has(camera)) {
      state.lowQualityCameras.delete(camera);
    } else {
      state.lowQualityCameras.add(camera);
    }
    saveState();
    // Re-render the sidebar row so the badge text/colour updates.
    renderSidebar();
    refreshSidebarStatus();
    // Force this tile to drop its current clip and re-fetch at the new
    // quality. No reason to wait for the next clip boundary.
    const t = state.tiles[camera];
    if (t) {
      t.currentClipId = null;
      t.currentClip = null;
      try { t.video.removeAttribute("src"); t.video.load(); } catch (_) {}
      syncTile(camera);
    }
  }
  function selectAllCameras() {
    state.selectedCameras = state.devices.map((d) => `cam-${d.id}`);
    onSelectionChanged();
  }
  function clearAllCameras() {
    state.selectedCameras = [];
    onSelectionChanged();
  }

  async function onSelectionChanged() {
    refreshSidebarStatus();
    renderGrid();
    renderLanes();
    saveState();
    await loadClipsForViewport();
    if (state.selectedCameras.length > 0) await ensureCursorNearClips();
    renderAll();
  }

  // ── Tile grid ──────────────────────────────────────────────────────

  function makeTile(camera) {
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.camera = camera;
    // Live uses --tile-ar as the source of truth for aspect ratio. Updated
    // when the <video>'s metadata reveals its real dimensions.
    el.style.setProperty("--tile-ar", "16 / 9");
    el.innerHTML = `
      <div class="tilePlayer">
        <video preload="metadata" playsinline muted></video>
        <div class="tileBufferSpinner" aria-hidden="true"></div>
      </div>
      <div class="tileHud">
        <div class="tileName"></div>
        <div class="tileMeta" hidden><span class="tileMetaSwatch"></span><span class="tileMetaLabel"></span></div>
      </div>
      <div class="tileOverlay" data-state="nodata"><div>No recording</div></div>
    `;
    const video = el.querySelector("video");
    const overlay = el.querySelector(".tileOverlay");
    const tileName = el.querySelector(".tileName");
    const tileMeta = el.querySelector(".tileMeta");
    const tileMetaSwatch = el.querySelector(".tileMetaSwatch");
    const tileMetaLabel = el.querySelector(".tileMetaLabel");

    tileName.textContent = cameraDisplayName(camera);

    // Buffer-state tracking for the rate-matched play loop. Without this,
    // state.cursorMs advances on wall-clock × state.speed regardless of
    // whether the video element is actually playing frames. On slow links
    // (or above-16x speeds where the decoder can't keep up) the cursor
    // races off into the future while video is frozen, the re-seek loop
    // keeps triggering more fetching, and you never catch up. With it,
    // the cursor pauses while ANY active tile is buffering/stalled.
    //
    // The same flag drives a spinning-wheel overlay so the user knows the
    // tile is waiting on data — we debounce the spinner by ~250 ms so a
    // brief sub-second hiccup doesn't flash a spinner across the screen.
    const stallState = { stalled: false, spinnerTimer: 0 };
    const markStalled = () => {
      stallState.stalled = true;
      if (stallState.spinnerTimer) return;
      stallState.spinnerTimer = setTimeout(() => {
        stallState.spinnerTimer = 0;
        if (stallState.stalled) el.classList.add("is-buffering");
      }, 250);
    };
    const markPlaying = () => {
      stallState.stalled = false;
      if (stallState.spinnerTimer) {
        clearTimeout(stallState.spinnerTimer);
        stallState.spinnerTimer = 0;
      }
      el.classList.remove("is-buffering");
    };
    video.addEventListener("waiting", markStalled);
    video.addEventListener("stalled", markStalled);
    video.addEventListener("playing", markPlaying);
    video.addEventListener("canplay", markPlaying);
    video.addEventListener("pause", markPlaying);  // ignored if we paused intentionally

    // Double-click toggles a fullscreen-style maximize. Reuses the same
    // `.tileMaximized` / `body.tileMaximizedMode` classes Live uses, plus
    // playback-specific CSS that floats the timeline card over the bottom
    // of the maximized video.
    el.addEventListener("dblclick", (e) => {
      if (e.target.closest("button, input, select, textarea, a")) return;
      togglePlaybackTileMaximized(el);
    });

    // When the first frame's metadata loads, sync the tile's aspect ratio to
    // the actual video so the justified layout knows true proportions.
    video.addEventListener("loadedmetadata", () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        const ar = `${w} / ${h}`;
        if (el.style.getPropertyValue("--tile-ar") !== ar) {
          el.style.setProperty("--tile-ar", ar);
          recomputeGrid();
        }
      }
    });

    return { camera, el, video, overlay, tileMeta, tileMetaSwatch, tileMetaLabel, stallState, currentClipId: null, currentClip: null };
  }

  function togglePlaybackTileMaximized(tile) {
    if (!tile || !els.videoGrid) return;
    const allTiles = Array.from(els.videoGrid.querySelectorAll(".tile"));
    if (state.maximizedTile === tile) {
      tile.classList.remove("tileMaximized");
      document.body.classList.remove("tileMaximizedMode", "pbTileMaximized");
      for (const t of allTiles) t.classList.remove("tileHiddenForMax");
      state.maximizedTile = null;
      return;
    }
    if (state.maximizedTile) state.maximizedTile.classList.remove("tileMaximized");
    document.body.classList.add("tileMaximizedMode", "pbTileMaximized");
    for (const t of allTiles) t.classList.toggle("tileHiddenForMax", t !== tile);
    tile.classList.add("tileMaximized");
    state.maximizedTile = tile;
  }

  // Escape clears the maximize. Bound once at module init.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.maximizedTile) {
      togglePlaybackTileMaximized(state.maximizedTile);
    }
  });

  function renderGrid() {
    const existing = new Set(Object.keys(state.tiles));
    const wanted = new Set(state.selectedCameras);
    // Remove tiles that are no longer selected.
    for (const cam of existing) {
      if (!wanted.has(cam)) {
        const t = state.tiles[cam];
        if (t) {
          if (state.maximizedTile === t.el) {
            document.body.classList.remove("tileMaximizedMode", "pbTileMaximized");
            state.maximizedTile = null;
          }
          try { t.video.pause(); t.video.removeAttribute("src"); t.video.load(); } catch (_) {}
          t.el.remove();
        }
        delete state.tiles[cam];
      }
    }
    // Add new tiles.
    for (const cam of state.selectedCameras) {
      if (!state.tiles[cam]) state.tiles[cam] = makeTile(cam);
    }
    // Re-attach in selection order.
    for (const cam of state.selectedCameras) {
      els.videoGrid.appendChild(state.tiles[cam].el);
    }
    els.gridEmpty.hidden = state.selectedCameras.length > 0;
    recomputeGrid();
  }

  // ── Justified gallery layout (ported from views-live.js) ───────────
  // Pack N tiles into the row-count that maximises the smallest row's height
  // given the grid's bounding box. Each row becomes a `.videoRow` flex
  // container; tiles get exact pixel width/height so they tile cleanly.

  const GRID_MOBILE_BREAKPOINT_PX = 980;

  function tileAspectRatio(tile) {
    const raw = tile.style.getPropertyValue("--tile-ar") || "16 / 9";
    const [w, h] = raw.split("/").map((x) => Number(x.trim()));
    return (w && h) ? (w / h) : (16 / 9);
  }

  function chunkTilesEvenly(tiles, rows) {
    const out = [];
    let i = 0;
    for (let r = 0; r < rows; r++) {
      const remainingTiles = tiles.length - i;
      const remainingRows = rows - r;
      const count = Math.ceil(remainingTiles / remainingRows);
      out.push(tiles.slice(i, i + count));
      i += count;
    }
    return out;
  }

  function getOptimalRowCount(tiles, w, h, gap) {
    const n = tiles.length;
    if (n <= 1) return n;
    if (!w || !h) {
      const cols = Math.ceil(Math.sqrt(n));
      return Math.ceil(n / cols);
    }
    let bestRowCount = 1, bestMinHeight = 0;
    for (let rowCount = 1; rowCount <= n; rowCount++) {
      const rows = chunkTilesEvenly(tiles, rowCount);
      const vertGaps = gap * Math.max(0, rows.length - 1);
      const maxRowHeight = (h - vertGaps) / rows.length;
      let worst = Infinity;
      for (const row of rows) {
        const ratios = row.map(tileAspectRatio);
        const ratioSum = ratios.reduce((a, b) => a + b, 0);
        const horzGaps = gap * Math.max(0, row.length - 1);
        const fromWidth = (w - horzGaps) / ratioSum;
        const rowHeight = Math.min(fromWidth, maxRowHeight);
        if (rowHeight < worst) worst = rowHeight;
      }
      if (worst > bestMinHeight) {
        bestMinHeight = worst;
        bestRowCount = rowCount;
      }
    }
    return bestRowCount;
  }

  function flattenVideoRows() {
    const rows = Array.from(els.videoGrid.querySelectorAll(".videoRow"));
    if (!rows.length) return;
    const frag = document.createDocumentFragment();
    rows.forEach((row) => Array.from(row.children).forEach((c) => frag.appendChild(c)));
    els.videoGrid.replaceChildren(frag);
  }

  function layoutTilesMobile() {
    const tiles = Array.from(els.videoGrid.querySelectorAll(".tile"));
    if (!tiles.length) return;
    if (els.videoGrid.querySelector(".videoRow")) flattenVideoRows();
    tiles.forEach((tile) => {
      const ar = tile.style.getPropertyValue("--tile-ar") || "16 / 9";
      tile.style.width = "100%";
      tile.style.height = "auto";
      tile.style.aspectRatio = ar;
    });
  }

  function layoutTilesJustified() {
    const tiles = Array.from(els.videoGrid.querySelectorAll(".tile"));
    if (!tiles.length) {
      flattenVideoRows();
      return;
    }
    const cs = getComputedStyle(els.videoGrid);
    const gap = parseFloat(cs.gap || "8") || 8;
    const w = els.videoGrid.clientWidth;
    const h = els.videoGrid.clientHeight;
    if (!w) return;
    const rowCount = getOptimalRowCount(tiles, w, h, gap);
    const rows = chunkTilesEvenly(tiles, rowCount);
    const totalGapH = gap * Math.max(0, rows.length - 1);
    const maxRowH = h ? Math.floor((h - totalGapH) / rows.length) : 420;

    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "videoRow";
      const ratios = row.map(tileAspectRatio);
      const ratioSum = ratios.reduce((a, b) => a + b, 0);
      const gapsW = gap * Math.max(0, row.length - 1);
      const natural = (w - gapsW) / ratioSum;
      const rowH = Math.min(maxRowH, natural);
      row.forEach((tile, i) => {
        const width = Math.round(rowH * ratios[i]);
        tile.style.aspectRatio = "";
        tile.style.height = `${Math.round(rowH)}px`;
        tile.style.width = `${width}px`;
        rowEl.appendChild(tile);
      });
      frag.appendChild(rowEl);
    }
    els.videoGrid.replaceChildren(frag);
  }

  let _gridRecomputeRaf = 0;
  function recomputeGrid() {
    if (_gridRecomputeRaf) return;
    _gridRecomputeRaf = requestAnimationFrame(() => {
      _gridRecomputeRaf = 0;
      const isMobile = window.matchMedia(`(max-width: ${GRID_MOBILE_BREAKPOINT_PX}px)`).matches;
      if (isMobile) layoutTilesMobile();
      else layoutTilesJustified();
    });
  }

  function syncTile(camera) {
    const tile = state.tiles[camera];
    if (!tile) return;
    const ts = state.cursorMs / 1000;
    const clip = clipForCameraAt(camera, ts);

    // Tile classes + clip-meta badge.
    tile.el.classList.toggle("is-current", !!clip);

    if (!clip) {
      tile.currentClipId = null;
      tile.currentClip = null;
      try {
        if (!tile.video.paused) tile.video.pause();
        tile.video.removeAttribute("src");
        tile.video.load();
      } catch (_) {}
      // Pick the friendliest placeholder copy we can. When the cursor is
      // near NOW and the camera has an in-progress continuous chunk, "No
      // recording" is misleading — the segment for this exact moment just
      // hasn't been finalized to disk yet. Show "Recording in progress"
      // until the chunk closes (~30 min) and the clip becomes playable.
      const overlayText = tile.overlay.querySelector("div");
      if (overlayText) {
        const activeContinuous = (state.activeByCamera[camera] || [])
          .some((a) => a.kind === "continuous");
        const nearNow = Math.abs(Date.now() - state.cursorMs) < 5 * 60_000;
        overlayText.textContent = (activeContinuous && nearNow)
          ? "Recording in progress…"
          : "No recording";
      }
      tile.overlay.style.display = "flex";
      tile.tileMeta.hidden = true;
      return;
    }

    tile.overlay.style.display = "none";

    // Update meta badge to reflect this clip's flow tag/color, if any.
    const tag = clipMetaTag(clip);
    const color = clipMetaColor(clip);
    if (tag) {
      tile.tileMetaLabel.textContent = tag;
      tile.tileMetaSwatch.style.background = color || "var(--accent)";
      tile.tileMeta.hidden = false;
    } else if (clip.kind === "continuous") {
      tile.tileMetaLabel.textContent = "continuous";
      tile.tileMetaSwatch.style.background = "rgba(160,160,170,0.7)";
      tile.tileMeta.hidden = false;
    } else {
      tile.tileMeta.hidden = true;
    }

    if (clip.id !== tile.currentClipId) {
      tile.currentClipId = clip.id;
      tile.currentClip = clip;
      // SD playback comes straight from the camera substream recording
      // (`<event>.sd.mp4` sibling). The backend serves the sibling when
      // present and falls back to the primary file otherwise — so we just
      // ask for `?q=sd` and let the backend decide.
      const qParam = state.lowQualityCameras.has(camera) ? "?q=sd" : "";
      tile.video.src = `/api/clips/${encodeURIComponent(clip.id)}/video${qParam}`;
      const onLoaded = () => {
        tile.video.removeEventListener("loadedmetadata", onLoaded);
        const offset = state.cursorMs / 1000 - clip.started_at;
        const dur = tile.video.duration;
        tile.video.currentTime = Number.isFinite(dur) && dur > 0
          ? clamp(offset, 0, Math.max(0, dur - 0.01))
          : Math.max(0, offset);
        if (state.isPlaying) {
          safePlay(tile.video, state.speed);
        } else {
          // Not currently playing — just store the requested rate so a later
          // play() picks it up.
          try {
            tile.video.defaultPlaybackRate = state.speed;
            tile.video.playbackRate = state.speed;
          } catch (_) {}
        }
      };
      tile.video.addEventListener("loadedmetadata", onLoaded);
    } else {
      // Same clip — only correct currentTime if the drift exceeds tolerance.
      const target = state.cursorMs / 1000 - clip.started_at;
      const drift = Math.abs(tile.video.currentTime - target);
      if (drift > SYNC_DRIFT_TOLERANCE_S) tile.video.currentTime = target;
    }
  }

  function syncAllTiles() {
    for (const cam of state.selectedCameras) syncTile(cam);
  }

  // Browsers (Chrome notably) reject `play()` when playbackRate is set
  // above ~16 BEFORE the video is playing — the call resolves with no error
  // logged but the video never starts. Setting the rate AFTER play() resolves
  // works fine. So always start playback at a safe rate, then ramp to the
  // requested rate once the video is actually playing.
  const BROWSER_INITIAL_RATE_CAP = 16;
  function safePlay(videoEl, targetRate) {
    if (!videoEl) return Promise.resolve();
    const safeRate = Math.min(Math.max(targetRate || 1, 0.0625), BROWSER_INITIAL_RATE_CAP);
    try {
      videoEl.defaultPlaybackRate = safeRate;
      videoEl.playbackRate = safeRate;
    } catch (_) {}
    return videoEl.play().then(() => {
      if (videoEl.playbackRate !== targetRate) {
        try {
          videoEl.defaultPlaybackRate = targetRate;
          videoEl.playbackRate = targetRate;
        } catch (_) {}
      }
    }).catch(() => {});
  }

  function applySpeedToAllTiles() {
    for (const cam of state.selectedCameras) {
      const t = state.tiles[cam];
      if (!t) continue;
      t.video.defaultPlaybackRate = state.speed;
      t.video.playbackRate = state.speed;
    }
  }

  // ── Timeline lanes ─────────────────────────────────────────────────

  function renderLanes() {
    const w = els.track.clientWidth || 1;
    const innerWidth = w - 12;
    const z = state.zoomMs;
    const padMs = z * 0.05;

    if (state.selectedCameras.length === 0) {
      els.lanes.innerHTML = `<div class="pbLane"><span class="pbLaneLabel">Select cameras to see recordings</span></div>`;
      els.track.style.minHeight = "56px";
      return;
    }

    // Collect all clips in viewport across selected cameras. Each clip
    // gets an `_camera` annotation so per-camera info survives the merge
    // (the lane no longer identifies the camera — tag does).
    const allClips = [];
    for (const cam of state.selectedCameras) {
      for (const c of (state.clipsByCamera[cam] || [])) {
        if (c.ended_at * 1000 > state.viewportStartMs - padMs &&
            c.started_at * 1000 < state.viewportEndMs + padMs) {
          allClips.push(Object.assign({}, c, { _camera: cam }));
        }
      }
    }
    allClips.sort((a, b) => a.started_at - b.started_at);

    // In-progress continuous recordings from active_recordings (one per cam).
    const allActive = [];
    for (const cam of state.selectedCameras) {
      for (const a of (state.activeByCamera[cam] || [])) {
        if (a.kind === "continuous") {
          allActive.push(Object.assign({}, a, { _camera: cam }));
        }
      }
    }

    // Group clips into lanes keyed by tag. Continuous lives in a single
    // synthetic "__continuous__" lane regardless of which cameras
    // contribute. Triggered clips are bucketed by their tag identity.
    const continuousClips = [];
    const tagToClips = new Map();
    const continuousHidden = state.hiddenTags.has(CONTINUOUS_TAG_KEY);
    for (const c of allClips) {
      if (c.kind === "continuous") {
        continuousClips.push(c);
      } else {
        const tag = clipMetaTag(c) || "Untitled";
        if (state.hiddenTags.has(tag)) continue;
        if (!tagToClips.has(tag)) tagToClips.set(tag, []);
        tagToClips.get(tag).push(c);
      }
    }

    // Stable lane order: continuous first (always-on coverage), then tag
    // lanes alphabetically. The Continuous lane is omitted entirely when
    // the user has hidden it via the tag filter.
    const laneDefs = [];
    if (!continuousHidden && (continuousClips.length > 0 || allActive.length > 0)) {
      laneDefs.push({ key: CONTINUOUS_TAG_KEY, label: "Continuous", kind: "continuous" });
    }
    const sortedTags = Array.from(tagToClips.keys()).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }));
    for (const tag of sortedTags) {
      laneDefs.push({ key: `tag:${tag}`, label: tag, kind: "tag" });
    }

    if (laneDefs.length === 0) {
      els.lanes.innerHTML = `<div class="pbLane"><span class="pbLaneLabel">No recordings in view</span></div>`;
      els.track.style.minHeight = "56px";
      return;
    }

    const mergeGapPx = 2;
    const mergeGapSec = innerWidth > 0
      ? (mergeGapPx / innerWidth) * (z / 1000)
      : 0;
    const continuousMergeGapSec = Math.max(mergeGapSec, 15);
    const nowMs = Date.now();

    // Merge adjacent clips into coverage spans. When `respectIdentity` is
    // on, also require matching tag+color+camera — different events
    // from different cameras must stay as separate spans so the sub-row
    // packer can stack them visibly within the same tag lane.
    function mergeRuns(clips, opts) {
      const respectIdentity = !!(opts && opts.respectIdentity);
      const gapSec = (opts && typeof opts.gapSec === "number") ? opts.gapSec : mergeGapSec;
      const out = [];
      for (const c of clips) {
        const last = out[out.length - 1];
        const tag = clipMetaTag(c);
        const col = clipMetaColor(c);
        const cam = c._camera || c.camera;
        const adjacent = last && c.started_at <= last.end + gapSec;
        const sameIdentity = respectIdentity
          ? (last &&
             (last.tag || "") === (tag || "") &&
             (last.color || "") === (col || "") &&
             last.camera === cam)
          : true;
        if (adjacent && sameIdentity) {
          last.end = Math.max(last.end, c.ended_at);
          last.clipIds.push(c.id);
          last.count++;
          if (col) last.color = col;
          if (tag) last.tag = tag;
        } else {
          out.push({
            start: c.started_at,
            end: c.ended_at,
            clipIds: [c.id],
            count: 1,
            color: col,
            tag: tag,
            kind: c.kind,
            camera: cam,
            firstClip: c,
          });
        }
      }
      return out;
    }

    function packSubRows(spans) {
      const rowEnds = [];
      const subRowFor = new Map();
      for (const s of spans) {
        let placed = false;
        for (let i = 0; i < rowEnds.length; i++) {
          if (rowEnds[i] <= s.start) {
            rowEnds[i] = s.end;
            subRowFor.set(s, i);
            placed = true;
            break;
          }
        }
        if (!placed) {
          subRowFor.set(s, rowEnds.length);
          rowEnds.push(s.end);
        }
      }
      return { subRowFor, subRowCount: Math.max(1, rowEnds.length) };
    }

    function continuousLaneHtml() {
      // Treat all selected cameras as one. The merge ignores camera
      // identity — we only care that *something* was recording, not
      // which something. This keeps the lane a clean unbroken strip.
      const spans = mergeRuns(continuousClips, { gapSec: continuousMergeGapSec });
      const bars = spans.map((s) => {
        const startMs = s.start * 1000;
        const endMs = s.end * 1000;
        const left = ((startMs - state.viewportStartMs) / z) * innerWidth;
        const naturalWidth = ((endMs - startMs) / z) * innerWidth;
        const widthPx = Math.max(2, naturalWidth - 1);
        const durS = Math.max(1, Math.round(s.end - s.start));
        const camLabel = cameraDisplayName(s.camera || "");
        const title = `Continuous · ${camLabel} · ${fmtClock(startMs)} → ${fmtClock(endMs)} (${durS}s)`;
        return `<div class="pbCoverageBar is-continuous" data-clip-id="${escapeHtml(s.firstClip.id)}" data-clip-count="${s.count}" style="left:${left.toFixed(1)}px;width:${widthPx.toFixed(1)}px;" title="${escapeHtml(title)}"></div>`;
      }).join("");
      // Render ONE in-progress bar for the whole Continuous lane regardless
      // of how many cameras are currently recording — multiple translucent
      // strips stacked on each other read as a darker patch and break the
      // "uniform coverage" look. We also clip it to start no earlier than
      // the latest finalized chunk end so it doesn't double-paint there.
      const inProgressBars = (() => {
        if (allActive.length === 0) return "";
        const earliestActive = Math.min.apply(null, allActive.map((a) => a.started_at));
        const finalizedFloor = spans.length
          ? Math.max.apply(null, spans.map((s) => s.end))
          : 0;
        const startSec = Math.max(earliestActive, finalizedFloor);
        const startMs = startSec * 1000;
        const endMs = nowMs;
        if (endMs <= startMs) return "";
        if (endMs < state.viewportStartMs - padMs ||
            startMs > state.viewportEndMs + padMs) return "";
        const left = ((startMs - state.viewportStartMs) / z) * innerWidth;
        const naturalWidth = ((endMs - startMs) / z) * innerWidth;
        const widthPx = Math.max(2, naturalWidth);
        const who = allActive.length === 1
          ? cameraDisplayName(allActive[0]._camera || allActive[0].camera)
          : `${allActive.length} cameras`;
        const title = `Recording now · ${who}`;
        return `<div class="pbCoverageBar is-continuous is-in-progress" style="left:${left.toFixed(1)}px;width:${widthPx.toFixed(1)}px;" title="${escapeHtml(title)}"></div>`;
      })();
      return `<div class="pbLane pbLaneContinuous" data-lane-key="__continuous__" style="height:18px;">
        <span class="pbLaneLabel">Continuous</span>
        ${inProgressBars}${bars}
      </div>`;
    }

    function tagLaneHtml(tag) {
      const clips = tagToClips.get(tag) || [];
      // Single-row layout within a tag lane: all events sit on the same
      // sub-row regardless of overlap. The tag lane already represents
      // "this tag fired here"; overlapping events of the same tag still
      // mean the same thing, so we don't split them into stacked rows.
      const spans = mergeRuns(clips, { respectIdentity: true });

      const tagH = 12;
      const padTop = 3;
      const laneHeight = 18;

      const bars = spans.map((s) => {
        const startMs = s.start * 1000;
        const endMs = s.end * 1000;
        const left = ((startMs - state.viewportStartMs) / z) * innerWidth;
        const naturalWidth = ((endMs - startMs) / z) * innerWidth;
        const widthPx = Math.max(2, naturalWidth - 1);
        const styleParts = [
          `left:${left.toFixed(1)}px`,
          `width:${widthPx.toFixed(1)}px`,
          `top:${padTop}px`,
          `height:${tagH}px`,
          `bottom:auto`,
        ];
        if (s.color) styleParts.push(`--coverage-color:${s.color}`);
        const camLabel = cameraDisplayName(s.camera || "");
        const durS = Math.max(1, Math.round(s.end - s.start));
        const title = s.count > 1
          ? `${tag} · ${camLabel} · ${s.count} clips · ${fmtClock(startMs)} → ${fmtClock(endMs)} (${durS}s)`
          : `${tag} · ${camLabel} · ${fmtClock(startMs)} → ${fmtClock(endMs)} (${s.firstClip.duration_seconds}s)`;
        return `<div class="pbCoverageBar is-triggered" data-clip-id="${escapeHtml(s.firstClip.id)}" data-clip-count="${s.count}" style="${styleParts.join(";")}" title="${escapeHtml(title)}"></div>`;
      }).join("");

      // Lane label uses the tag's representative color as a swatch so the
      // viewer can match label → bar at a glance.
      const swatchColor = spans.length && spans[0].color
        ? spans[0].color
        : null;
      const swatch = swatchColor
        ? `<span class="pbLaneTagSwatch" style="background:${escapeHtml(swatchColor)};"></span>`
        : "";
      return `<div class="pbLane pbLaneTag" data-lane-key="tag:${escapeHtml(tag)}" style="height:${laneHeight}px;">
        <span class="pbLaneLabel">${swatch}${escapeHtml(tag)}</span>
        ${bars}
      </div>`;
    }

    const html = laneDefs.map((lane) => {
      if (lane.kind === "continuous") return continuousLaneHtml();
      return tagLaneHtml(lane.label);
    }).join("");

    els.lanes.innerHTML = html;
    els.track.style.minHeight = "";
  }

  // ── Scale + cursor + now line ──────────────────────────────────────

  function renderScale() {
    const w = els.scale.clientWidth || 1;
    const z = state.zoomMs;
    const candidates = [
      1000, 5000, 15000, 30000,
      60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
      3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000,
      24 * 3_600_000, 2 * 24 * 3_600_000, 7 * 24 * 3_600_000,
    ];
    const target = z / 7;
    let step = candidates[candidates.length - 1];
    for (const c of candidates) { if (c >= target) { step = c; break; } }
    const start = Math.ceil(state.viewportStartMs / step) * step;
    const showDate = step >= 24 * 3_600_000;
    const out = [];
    for (let t = start; t < state.viewportEndMs; t += step) {
      const x = ((t - state.viewportStartMs) / z) * w;
      out.push(`<span class="pbScaleTick" style="left:${x.toFixed(1)}px">${showDate ? fmtDate(t) : fmtClock(t)}</span>`);
    }
    els.scale.innerHTML = out.join("");
  }

  function renderCursor() {
    const w = els.track.clientWidth || 1;
    const innerWidth = w - 12;
    const xRelInner = ((state.cursorMs - state.viewportStartMs) / state.zoomMs) * innerWidth;
    els.cursor.style.left = `${(6 + xRelInner).toFixed(1)}px`;
    els.cursorLabel.textContent = fmtClock(state.cursorMs);
    els.transportTime.textContent = `${fmtDay(state.cursorMs)} · ${fmtClock(state.cursorMs)}`;
  }

  function renderNowLine() {
    const now = Date.now();
    if (now < state.viewportStartMs || now > state.viewportEndMs) {
      els.nowLine.hidden = true;
      return;
    }
    const w = els.track.clientWidth || 1;
    const innerWidth = w - 12;
    const xRelInner = ((now - state.viewportStartMs) / state.zoomMs) * innerWidth;
    els.nowLine.style.left = `${(6 + xRelInner).toFixed(1)}px`;
    els.nowLine.hidden = false;
  }

  function renderAll() {
    renderScale();
    renderLanes();
    renderCursor();
    renderNowLine();
    els.dayInput.value = dayInputValue(state.cursorMs);
  }

  // ── Master cursor + playback ───────────────────────────────────────

  function setCursor(ms, opts = {}) {
    state.cursorMs = ms;
    if (opts.recomputeViewport) recomputeViewportAroundCursor();
    renderScale();
    renderLanes();
    renderCursor();
    renderNowLine();
    if (!opts.skipSeek) syncAllTiles();
    saveState();
  }

  function startPlayLoop() {
    cancelPlayLoop();
    state.playLastT = performance.now();
    const tick = (t) => {
      if (!state.isPlaying) { state.playRaf = 0; return; }

      // Rate-match: if any active tile's video is buffering or its
      // decoder hasn't caught up (readyState < HAVE_FUTURE_DATA), hold
      // the cursor instead of advancing on wall-clock × speed. Makes
      // remote/slow-connection playback honest (cursor moves only when
      // frames are actually playing) and stops the cursor running away
      // at 32x/64x when the browser can't decode that fast.
      let anyBuffering = false;
      for (const cam of state.selectedCameras) {
        const tile = state.tiles[cam];
        if (!tile || !tile.currentClip) continue;
        const buffering = tile.stallState && tile.stallState.stalled;
        const notReady = tile.video.readyState < 3; // HAVE_FUTURE_DATA
        if (buffering || notReady) { anyBuffering = true; break; }
      }

      const dt = anyBuffering ? 0 : (t - state.playLastT) * state.speed;
      state.playLastT = t;
      state.cursorMs += dt;
      // Auto-pan viewport when cursor approaches the right edge.
      const edge = state.zoomMs * 0.1;
      if (state.cursorMs > state.viewportEndMs - edge) {
        const shift = state.cursorMs - (state.viewportEndMs - edge);
        state.viewportStartMs += shift;
        state.viewportEndMs += shift;
        renderScale();
        renderLanes();
        renderNowLine();
      }
      renderCursor();
      // For each tile, detect clip boundary cross.
      let anyClipUnderCursor = false;
      for (const cam of state.selectedCameras) {
        const tile = state.tiles[cam];
        if (!tile) continue;
        const ts = state.cursorMs / 1000;
        if (tile.currentClip && ts >= tile.currentClip.started_at && ts <= tile.currentClip.ended_at) {
          anyClipUnderCursor = true;
          // Trust the video's natural advance; only correct hard drift.
          const target = ts - tile.currentClip.started_at;
          if (Math.abs(tile.video.currentTime - target) > SYNC_DRIFT_TOLERANCE_S * 2) {
            tile.video.currentTime = target;
          }
        } else {
          // Crossed a boundary — load the appropriate clip (or none).
          syncTile(cam);
          if (tile.currentClip) anyClipUnderCursor = true;
        }
      }
      // If no tile has a clip and there's a later one, jump to it.
      if (!anyClipUnderCursor) {
        const next = nextClipAnyAfter(state.cursorMs / 1000);
        if (next) {
          state.cursorMs = next.started_at * 1000;
          syncAllTiles();
          renderCursor();
        } else {
          // Nothing more to play.
          pause();
          return;
        }
      }
      state.playRaf = requestAnimationFrame(tick);
    };
    state.playRaf = requestAnimationFrame(tick);
  }
  function cancelPlayLoop() {
    if (state.playRaf) { cancelAnimationFrame(state.playRaf); state.playRaf = 0; }
  }

  function play() {
    if (state.selectedCameras.length === 0) return;
    // If cursor isn't under any clip, hop to the next one across the selection.
    const ts = state.cursorMs / 1000;
    const anyHere = state.selectedCameras.some((cam) => !!clipForCameraAt(cam, ts));
    if (!anyHere) {
      const next = nextClipAnyAfter(ts);
      if (!next) return;
      setCursor(next.started_at * 1000, { recomputeViewport: true });
    }
    state.isPlaying = true;
    els.playGlyph.hidden = true;
    els.pauseGlyph.hidden = false;
    // Each tile gets its own safePlay so an above-16x target rate doesn't
    // make the initial play() promise reject silently in Chrome. The helper
    // starts the video at a clamped safe rate, then bumps to state.speed
    // once playback is actually rolling.
    for (const cam of state.selectedCameras) {
      const t = state.tiles[cam];
      if (t && t.currentClipId) safePlay(t.video, state.speed);
    }
    startPlayLoop();
  }
  function pause() {
    state.isPlaying = false;
    els.playGlyph.hidden = false;
    els.pauseGlyph.hidden = true;
    cancelPlayLoop();
    for (const cam of state.selectedCameras) {
      const t = state.tiles[cam];
      if (t) try { t.video.pause(); } catch (_) {}
    }
  }
  function togglePlay() { state.isPlaying ? pause() : play(); }

  function stepNext() {
    const ts = state.cursorMs / 1000;
    // Jump to the closest clip start across selected cameras that's strictly after cursor.
    const next = nextClipAnyAfter(ts);
    if (next) setCursor(next.started_at * 1000, { recomputeViewport: true });
  }
  function stepPrev() {
    const prev = prevClipAnyBefore(state.cursorMs / 1000);
    if (prev) setCursor(prev.started_at * 1000, { recomputeViewport: true });
  }

  // ── Zoom ───────────────────────────────────────────────────────────

  function setZoom(newZoomMs, anchorMs) {
    newZoomMs = clamp(newZoomMs, MIN_ZOOM_MS, MAX_ZOOM_MS);
    if (newZoomMs === state.zoomMs) return;
    let frac = 0.5;
    if (typeof anchorMs === "number" && state.viewportEndMs > state.viewportStartMs) {
      frac = (anchorMs - state.viewportStartMs) / (state.viewportEndMs - state.viewportStartMs);
      frac = clamp(frac, 0, 1);
    } else {
      anchorMs = (state.viewportStartMs + state.viewportEndMs) / 2;
    }
    state.zoomMs = newZoomMs;
    state.viewportStartMs = anchorMs - frac * newZoomMs;
    state.viewportEndMs = anchorMs + (1 - frac) * newZoomMs;
    activateZoomButton(newZoomMs);
    renderScale();
    renderLanes();
    renderCursor();
    renderNowLine();
    saveState();
    scheduleClipFetch();
  }
  function activateZoomButton(zoomMs) {
    els.zoomBtns.forEach((b) => b.classList.toggle("is-active", Number(b.dataset.zoomMs) === zoomMs));
  }
  function panBy(deltaMs) {
    state.viewportStartMs += deltaMs;
    state.viewportEndMs += deltaMs;
    renderScale();
    renderLanes();
    renderCursor();
    renderNowLine();
    scheduleClipFetch(120);
  }

  // ── Track pointer/wheel ────────────────────────────────────────────

  function isCursorTarget(target) {
    return target === els.cursor || (target && els.cursor.contains(target));
  }
  function isCoverageBar(target) {
    return target && target.classList && target.classList.contains("pbCoverageBar");
  }

  function onTrackPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (!els.track.setPointerCapture) return;
    els.track.setPointerCapture(e.pointerId);
    cancelInertia();
    const onCursor = isCursorTarget(e.target);
    state.pan.active = true;
    state.pan.pointerId = e.pointerId;
    state.pan.dragOriginX = e.clientX;
    state.pan.dragOriginViewportStart = state.viewportStartMs;
    state.pan.moved = false;
    state.pan.wasPlaying = state.isPlaying;
    state.pan.kind = onCursor ? "scrub" : "pending";
    state.pan.lastClientX = e.clientX;
    state.pan.lastT = performance.now();
    state.pan.vx = 0;
    if (onCursor) {
      els.track.classList.add("is-scrubbing");
      els.cursor.classList.add("is-scrubbing");
      if (state.isPlaying) for (const c of state.selectedCameras) { const t = state.tiles[c]; if (t) try { t.video.pause(); } catch (_) {} }
    }
  }
  function onTrackPointerMove(e) {
    if (!state.pan.active || e.pointerId !== state.pan.pointerId) return;
    const dx = e.clientX - state.pan.dragOriginX;
    if (!state.pan.moved && Math.abs(dx) >= DRAG_THRESHOLD_PX) state.pan.moved = true;
    if (state.pan.kind === "pending" && state.pan.moved) {
      state.pan.kind = "pan";
      els.track.classList.add("is-panning");
      if (state.isPlaying) for (const c of state.selectedCameras) { const t = state.tiles[c]; if (t) try { t.video.pause(); } catch (_) {} }
    }
    if (state.pan.kind === "scrub") {
      setCursor(msAtClientX(e.clientX));
    } else if (state.pan.kind === "pan") {
      const w = els.track.clientWidth || 1;
      const innerWidth = w - 12;
      const deltaMs = -(dx / innerWidth) * state.zoomMs;
      state.viewportStartMs = state.pan.dragOriginViewportStart + deltaMs;
      state.viewportEndMs = state.viewportStartMs + state.zoomMs;
      renderScale();
      renderLanes();
      renderCursor();
      renderNowLine();
      const t = performance.now();
      const ddx = e.clientX - state.pan.lastClientX;
      const ddt = t - state.pan.lastT;
      if (ddt > 0) state.pan.vx = ddx / ddt;
      state.pan.lastClientX = e.clientX;
      state.pan.lastT = t;
    }
  }
  function onTrackPointerUp(e) {
    if (!state.pan.active || e.pointerId !== state.pan.pointerId) return;
    const wasScrub = state.pan.kind === "scrub";
    const wasPan = state.pan.kind === "pan";
    const movedEnough = state.pan.moved;
    const wasPlaying = state.pan.wasPlaying;
    const tgt = e.target;
    state.pan.active = false;
    state.pan.pointerId = null;
    els.track.classList.remove("is-scrubbing", "is-panning");
    els.cursor.classList.remove("is-scrubbing");

    if (state.pan.kind === "pending" || !movedEnough) {
      if (!isCoverageBar(tgt)) setCursor(msAtClientX(e.clientX), { recomputeViewport: false });
    } else if (wasPan) {
      scheduleClipFetch(80);
      startInertia();
    } else if (wasScrub) {
      syncAllTiles();
    }
    if ((wasScrub || wasPan) && wasPlaying) play();
  }

  function startInertia() {
    if (Math.abs(state.pan.vx) < 0.05) return;
    let vx = state.pan.vx;
    const tick = () => {
      const w = els.track.clientWidth || 1;
      const innerWidth = w - 12;
      const deltaMs = -(vx * 16) / innerWidth * state.zoomMs;
      panBy(deltaMs);
      vx *= PAN_INERTIA_FRICTION;
      if (Math.abs(vx) > 0.02) state.inertiaRaf = requestAnimationFrame(tick);
      else state.inertiaRaf = 0;
    };
    state.inertiaRaf = requestAnimationFrame(tick);
  }
  function cancelInertia() {
    if (state.inertiaRaf) { cancelAnimationFrame(state.inertiaRaf); state.inertiaRaf = 0; }
  }

  function onTrackWheel(e) {
    e.preventDefault();
    cancelInertia();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const w = els.track.clientWidth || 1;
      const innerWidth = w - 12;
      panBy((e.deltaX / innerWidth) * state.zoomMs);
      return;
    }
    const anchorMs = msAtClientX(e.clientX);
    const factor = Math.exp((e.deltaY || 0) * 0.0025);
    setZoom(state.zoomMs * factor, anchorMs);
  }

  // ── Wiring ─────────────────────────────────────────────────────────

  function bind() {
    els.cameraList.addEventListener("click", (e) => {
      const qBtn = e.target.closest(".pbQualityToggle");
      if (qBtn) {
        e.stopPropagation();
        toggleCameraQuality(qBtn.dataset.camera);
        return;
      }
      const row = e.target.closest(".liveSidebarRow");
      if (!row) return;
      toggleCamera(row.dataset.camera);
    });
    els.selectAllBtn.addEventListener("click", selectAllCameras);
    els.clearAllBtn.addEventListener("click", clearAllCameras);

    if (els.tagList) {
      els.tagList.addEventListener("click", (e) => {
        const row = e.target.closest(".pbTagRow");
        if (!row) return;
        toggleTag(row.dataset.tag);
      });
    }
    els.tagShowAllBtn?.addEventListener("click", () => setAllTagsHidden(false));
    els.tagHideAllBtn?.addEventListener("click", () => setAllTagsHidden(true));

    els.zoomBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        const z = Number(btn.dataset.zoomMs);
        if (z) setZoom(z, state.cursorMs);
      });
    });

    els.todayBtn.addEventListener("click", () => {
      setCursor(Date.now(), { recomputeViewport: true });
      scheduleClipFetch(0);
    });
    els.prevDayBtn.addEventListener("click", () => {
      setCursor(state.cursorMs - 86_400_000, { recomputeViewport: true });
      scheduleClipFetch(0);
    });
    els.nextDayBtn.addEventListener("click", () => {
      setCursor(state.cursorMs + 86_400_000, { recomputeViewport: true });
      scheduleClipFetch(0);
    });
    els.dayInput.addEventListener("change", () => {
      if (!els.dayInput.value) return;
      setCursor(parseDayInputValue(els.dayInput.value), { recomputeViewport: true });
      scheduleClipFetch(0);
    });

    els.playPauseBtn.addEventListener("click", togglePlay);
    els.rewindBtn.addEventListener("click", () => setCursor(state.cursorMs - 10_000));
    els.forwardBtn.addEventListener("click", () => setCursor(state.cursorMs + 10_000));
    els.stepBackBtn.addEventListener("click", stepPrev);
    els.stepFwdBtn.addEventListener("click", stepNext);
    els.speedSelect.addEventListener("change", () => {
      const v = Number(els.speedSelect.value);
      if (Number.isFinite(v) && v > 0) {
        state.speed = v;
        applySpeedToAllTiles();
        saveState();
      }
    });


    // Coverage bar click → jump to start.
    els.lanes.addEventListener("click", (e) => {
      const bar = e.target.closest(".pbCoverageBar");
      if (!bar) return;
      e.stopPropagation();
      const id = bar.dataset.clipId;
      // Find clip across cameras.
      for (const cam of state.selectedCameras) {
        const c = (state.clipsByCamera[cam] || []).find((x) => x.id === id);
        if (c) { setCursor(c.started_at * 1000); return; }
      }
    });

    els.track.addEventListener("pointerdown", onTrackPointerDown);
    els.track.addEventListener("pointermove", onTrackPointerMove);
    els.track.addEventListener("pointerup", onTrackPointerUp);
    els.track.addEventListener("pointercancel", onTrackPointerUp);
    els.track.addEventListener("wheel", onTrackWheel, { passive: false });

    // Keyboard shortcuts.
    window.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowLeft") { setCursor(state.cursorMs - 10_000); }
      else if (e.key === "ArrowRight") { setCursor(state.cursorMs + 10_000); }
      else if (e.key === ",") { stepPrev(); }
      else if (e.key === ".") { stepNext(); }
      else if (e.key === "Home") { setCursor(Date.now(), { recomputeViewport: true }); }
    });

    let resizeRaf = 0;
    window.addEventListener("resize", () => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        renderScale(); renderLanes(); renderCursor(); renderNowLine();
        recomputeGrid();
      });
    });
  }

  // Now-line periodic refresh while the user is idle.
  function startNowTicker() {
    setInterval(() => renderNowLine(), 1000);
  }

  // Poll /api/clips/cameras every 8 s. If any selected camera's `last_at`
  // has advanced past what we last saw, refetch clips for the viewport so
  // newly-created clips show up without the user touching anything. The
  // poll is cheap (single tiny endpoint, returns a few rows). Skipped while
  // the user is actively scrubbing or panning to keep input snappy.
  function startAutoRefresh() {
    if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = setInterval(async () => {
      if (document.hidden) return;
      if (state.pan.active) return;
      try {
        const d = await fetchJson("/api/clips/cameras");
        const items = d.items || [];
        let anyAdvanced = false;
        for (const it of items) {
          const prev = state.lastLastAt[it.camera] || 0;
          if (it.last_at && it.last_at > prev) {
            state.lastLastAt[it.camera] = it.last_at;
            if (state.selectedCameras.includes(it.camera)) anyAdvanced = true;
          }
        }
        // Refresh the cameras summary too — sidebar dots may need to update,
        // and the cameras list might gain a new entry on first clip.
        state.cameras = items;
        refreshSidebarStatus();
        if (anyAdvanced) await loadClipsForViewport();
      } catch (_) {
        // Silent — transient errors during navigation are fine.
      }
    }, 8000);
  }

  // ── Init ───────────────────────────────────────────────────────────

  let mounted = false;
  async function mount() {
    if (mounted) return;
    if (!resolveEls()) return;
    mounted = true;

    loadState();
    bind();
    activateZoomButton(state.zoomMs);
    if (state.speed) {
      const opt = Array.from(els.speedSelect.options).find((o) => Number(o.value) === state.speed);
      if (opt) els.speedSelect.value = String(state.speed);
    }
    if (!state.cursorMs) state.cursorMs = Date.now();
    recomputeViewportAroundCursor();

    await Promise.all([loadDevices(), loadCameras()]);
    renderSidebar();

    const camsWithClips = state.cameras.map((c) => c.camera);

    // Drop any persisted selection entries that no longer correspond to a
    // configured device.
    state.selectedCameras = state.selectedCameras.filter((cam) =>
      state.devices.some((d) => `cam-${d.id}` === cam));

    // First-load default: pick every camera that has at least one clip.
    if (state.selectedCameras.length === 0) {
      state.selectedCameras = camsWithClips.slice();
    } else if (camsWithClips.length > 0 &&
               !state.selectedCameras.some((c) => camsWithClips.includes(c))) {
      // The persisted selection is all "empty" cameras while OTHER cameras
      // have recordings — without this fallback, the page would render an
      // empty timeline and look broken. Auto-include the cameras with clips
      // and remember the new selection.
      state.selectedCameras = Array.from(new Set([...state.selectedCameras, ...camsWithClips]));
      saveState();
    }

    // If still empty (no devices have any clips), the page will show the
    // "No cameras selected" placeholder — that's the truthful state.

    refreshSidebarStatus();
    renderGrid();
    // Seed last_at baseline so we don't immediately re-fetch on first poll.
    for (const c of state.cameras) state.lastLastAt[c.camera] = c.last_at || 0;

    await loadClipsForViewport();
    await ensureCursorNearClips();
    renderAll();
    startNowTicker();
    startAutoRefresh();
    ensureActiveRecordingsTimer();

    // Deep-link: #<clip_id>.
    const hash = location.hash.replace(/^#/, "");
    if (hash) {
      for (const cam of state.selectedCameras) {
        const c = (state.clipsByCamera[cam] || []).find((x) => x.id === hash);
        if (c) { setCursor(c.started_at * 1000, { recomputeViewport: true }); break; }
      }
    }
  }

  // Expose the mount hook so views.js can drive us when the user switches to
  // playback mode. Mount on first activation only.
  window.viewsPlayback = {
    onModeChange(mode) {
      if (mode === "playback") mount();
    },
  };

  // If the page loaded directly in playback mode, mount immediately.
  if (document.body?.dataset?.viewsMode === "playback") {
    mount();
  }
})();
