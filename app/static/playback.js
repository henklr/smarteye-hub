const el = (id) => document.getElementById(id);

const DAY_MINUTES = 24 * 60;
const MIN_VISIBLE_MINUTES = 5;
const CLICK_SUPPRESSION_MS = 250;
const PAN_DRAG_THRESHOLD_PX = 6;
const MAX_NATIVE_PLAYBACK_RATE = 16;
const PLAYBACK_STORAGE_KEY = "sei.playback.timelineState";
const PLAYBACK_STATE_VERSION = 2;
const PLAYBACK_STATE_SAVE_DELAY_MS = 400;
const ACTIVE_TIMELINE_REFRESH_MS = 5000;
const IDLE_TIMELINE_REFRESH_MS = 30000;
const TILE_MUTE_STORAGE_KEY = "sei.playback.tileMuted";

const SHUTTLE_MAX = 16;
const SHUTTLE_DEADZONE = 0.25;
const SHUTTLE_REST_VALUE = 1;
const SHUTTLE_SNAP_DURATION_MS = 260;
const SHUTTLE_CURVE = 2;
const SHUTTLE_SNAP_TARGETS = [1, -1];
const SHUTTLE_SNAP_RADIUS = 0.15;

const state = {
  devices: [],
  activeDeviceIds: [],
  selectedDay: "",
  deviceTimelines: new Map(),
  timeline: { segments: [], events: [] },
  timelineFilters: { hiddenPresetKeys: [] },
  transport: {
    speed: 1,
    direction: "forward",
    advancingToNextClip: false,
    forwardBoundaryTimer: 0,
    forwardPlayback: { active: false, rafId: 0, lastTs: 0 },
    reversePlayback: { active: false, rafId: 0, lastTs: 0 },
  },
  playbackCursor: { minute: null, label: "", rafId: 0 },
  timelineView: {
    startMinute: 0,
    endMinute: DAY_MINUTES,
    pointerId: null,
    dragOriginX: 0,
    dragOriginStartMinute: 0,
    dragOriginDuration: DAY_MINUTES,
    isDragging: false,
    suppressClickUntil: 0,
  },
  selectedEventId: null,
  persistence: {
    saveTimer: 0,
    timelineRefreshTimer: 0,
    timelineRequestId: 0,
  },
};

// Map<deviceId, { tile, video, hls, audioBtn, overlayEl, deviceId, loadToken, suppressErrorUntil }>
const tiles = new Map();

let _shuttleDragging = false;
let _shuttleAnimRafId = 0;

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = "/login"; return; }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    throw new Error((data && data.detail) ? data.detail : (text || res.statusText));
  }
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setStatus(message) {
  const node = el("playbackStatus");
  if (node) node.textContent = message || "";
}

// ── Tile mute persistence (per device) ─────────────────────────────────

function loadTileMuted(deviceId) {
  try {
    const raw = window.localStorage.getItem(TILE_MUTE_STORAGE_KEY);
    if (!raw) return true;
    const map = JSON.parse(raw);
    if (map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, deviceId)) {
      return !!map[deviceId];
    }
  } catch {}
  return true;
}

function saveTileMuted(deviceId, muted) {
  try {
    const raw = window.localStorage.getItem(TILE_MUTE_STORAGE_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[deviceId] = !!muted;
    window.localStorage.setItem(TILE_MUTE_STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

// ── Shuttle helpers ────────────────────────────────────────────────────

function shuttlePosToValue(pos) {
  const p = clamp(Number(pos) || 0, -1, 1);
  const sign = p < 0 ? -1 : 1;
  return sign * Math.pow(Math.abs(p), SHUTTLE_CURVE) * SHUTTLE_MAX;
}

function shuttleValueToPos(value) {
  const v = clamp(Number(value) || 0, -SHUTTLE_MAX, SHUTTLE_MAX);
  const sign = v < 0 ? -1 : 1;
  return sign * Math.pow(Math.abs(v) / SHUTTLE_MAX, 1 / SHUTTLE_CURVE);
}

function applyShuttleSnap(value) {
  for (const target of SHUTTLE_SNAP_TARGETS) {
    if (Math.abs(value - target) <= SHUTTLE_SNAP_RADIUS) return target;
  }
  return value;
}

function cancelShuttleAnim() {
  if (_shuttleAnimRafId) {
    cancelAnimationFrame(_shuttleAnimRafId);
    _shuttleAnimRafId = 0;
  }
}

function updateShuttleFillFromPos(pos) {
  const p = clamp(Number(pos) || 0, -1, 1);
  const thumbPct = ((p + 1) / 2) * 100;
  const fill = document.querySelector("[data-shuttle-fill]");
  if (fill) {
    if (thumbPct >= 50) {
      fill.style.left = "50%";
      fill.style.width = `${thumbPct - 50}%`;
    } else {
      fill.style.left = `${thumbPct}%`;
      fill.style.width = `${50 - thumbPct}%`;
    }
  }
  const label = document.querySelector("[data-shuttle-value]");
  if (label) label.style.left = `${thumbPct}%`;
}

function normalizePlaybackSpeed(value) {
  return clamp(Number(value) || 1, 0.25, SHUTTLE_MAX);
}

function signedShuttleValue() {
  const speed = normalizePlaybackSpeed(state.transport.speed);
  return isReverseDirection() ? -speed : speed;
}

function formatShuttleValue(signed) {
  const v = Number(signed) || 0;
  if (Math.abs(v) < SHUTTLE_DEADZONE) return "0x";
  const rounded = Math.round(v * 100) / 100;
  const trimmed = Math.abs(rounded) === Math.round(Math.abs(rounded))
    ? String(Math.round(rounded))
    : rounded.toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  return `${trimmed}x`;
}

function formatPlaybackSpeed(value) {
  return `${normalizePlaybackSpeed(value).toFixed(2).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1")}x`;
}

function normalizePlaybackDirection(value) {
  return String(value || "forward").trim().toLowerCase() === "backward" ? "backward" : "forward";
}

function playbackDirectionLabel() {
  return normalizePlaybackDirection(state.transport.direction);
}

function reversePlaybackState() { return state.transport.reversePlayback; }
function forwardPlaybackState() { return state.transport.forwardPlayback; }

function isReverseDirection() { return playbackDirectionLabel() === "backward"; }
function isReversePlaybackActive() { return !!reversePlaybackState().active; }

function shouldSimulateForwardPlayback(speed = state.transport.speed, direction = state.transport.direction) {
  return normalizePlaybackDirection(direction) !== "backward" && normalizePlaybackSpeed(speed) > MAX_NATIVE_PLAYBACK_RATE;
}

function isSimulatedForwardPlaybackActive() { return !!forwardPlaybackState().active; }

function playbackTransportIcon(icon) {
  const icons = {
    play: '<span class="playbackTransportGlyph" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M8 6.5V17.5L17 12L8 6.5Z"></path></svg></span>',
    pause: '<span class="playbackTransportGlyph" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><rect x="6.5" y="6" width="4" height="12" rx="1"></rect><rect x="13.5" y="6" width="4" height="12" rx="1"></rect></svg></span>',
  };
  return icons[icon] || icons.play;
}

// ── Empty/loading state UI ─────────────────────────────────────────────

function normalizePlaybackEmptyDisplayState(value) {
  const normalized = String(value || "empty").trim().toLowerCase();
  if (normalized === "loading" || normalized === "waiting" || normalized === "error") return normalized;
  return "empty";
}

function playbackEmptyBadgeLabel(value) {
  if (value === "loading") return "Loading";
  if (value === "waiting") return "Saving";
  if (value === "error") return "Unavailable";
  return "Ready";
}

function showVideoEmpty(title, text, options = {}) {
  const empty = el("playbackVideoEmpty");
  const emptyBadge = el("playbackVideoEmptyBadge");
  const emptyText = el("playbackVideoEmptyText");
  const titleNode = empty?.querySelector(".playbackVideoEmptyTitle");
  const emptyState = normalizePlaybackEmptyDisplayState(options.state);

  stopPlaybackCursorLoop();
  stopSimulatedForwardPlayback();
  stopReversePlayback();

  for (const tile of tiles.values()) {
    detachTileSource(tile);
    setTileOverlay(tile, "");
  }

  if (empty) {
    empty.dataset.state = emptyState;
    empty.setAttribute("aria-busy", emptyState === "loading" ? "true" : "false");
  }
  if (emptyBadge) emptyBadge.textContent = options.badge || playbackEmptyBadgeLabel(emptyState);
  if (titleNode) titleNode.textContent = title || "No clip selected";
  if (emptyText) emptyText.textContent = text || "Choose a colored marker from the timeline below to load a recording.";
  empty?.classList.remove("hidden");
  syncPlaybackTransport();
}

function hideVideoEmpty() {
  const empty = el("playbackVideoEmpty");
  if (empty) {
    empty.classList.add("hidden");
    empty.setAttribute("aria-busy", "false");
  }
}

// ── Date helpers ───────────────────────────────────────────────────────

function todayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeStoredDay(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : todayString();
}

let _tzOffsetMs = 0;

function _extractTzOffset(isoStr) {
  const m = String(isoStr || "").match(/([+-])(\d{2}):(\d{2})$/);
  if (m) {
    const sign = m[1] === "+" ? 1 : -1;
    _tzOffsetMs = sign * (Number(m[2]) * 3600000 + Number(m[3]) * 60000);
  }
}

function _localParts(value) {
  const s = String(value || "");
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    _extractTzOffset(s);
    return { h: Number(m[4]), m: Number(m[5]), s: Number(m[6]) };
  }
  const d = new Date(typeof value === "number" ? value + _tzOffsetMs : value);
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

function clockLabel(value) {
  try {
    const p = _localParts(value);
    return `${String(p.h).padStart(2,"0")}:${String(p.m).padStart(2,"0")}:${String(p.s).padStart(2,"0")}`;
  } catch {
    return String(value || "");
  }
}

function deviceName(deviceId) {
  return state.devices.find((item) => item.id === deviceId)?.name || deviceId || "camera";
}

// ── Persistence ────────────────────────────────────────────────────────

function loadStoredPlaybackState() {
  try {
    const raw = window.localStorage.getItem(PLAYBACK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (Number(parsed.version || 0) !== PLAYBACK_STATE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function snapshotPlaybackState() {
  const event = selectedEvent();
  const video = primaryVideoEl();
  const seekSeconds = event
    ? clamp(Number.isFinite(video?.currentTime) ? video.currentTime : 0, 0, eventDurationSeconds(event))
    : 0;

  return {
    version: PLAYBACK_STATE_VERSION,
    activeDeviceIds: [...state.activeDeviceIds],
    selectedDay: normalizeStoredDay(state.selectedDay),
    selectedEventId: typeof state.selectedEventId === "string" && state.selectedEventId ? state.selectedEventId : null,
    hiddenPresetKeys: [...new Set((state.timelineFilters.hiddenPresetKeys || []).map((value) => String(value || "").trim()).filter(Boolean))],
    seekSeconds,
    timelineView: {
      startMinute: Number(state.timelineView.startMinute) || 0,
      durationMinutes: currentTimelineDuration(),
    },
    savedAt: new Date().toISOString(),
  };
}

function savePlaybackStateNow() {
  if (state.persistence.saveTimer) {
    window.clearTimeout(state.persistence.saveTimer);
    state.persistence.saveTimer = 0;
  }
  try {
    window.localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(snapshotPlaybackState()));
  } catch {}
}

function schedulePlaybackStateSave(delay = PLAYBACK_STATE_SAVE_DELAY_MS) {
  if (state.persistence.saveTimer) return;
  state.persistence.saveTimer = window.setTimeout(() => {
    state.persistence.saveTimer = 0;
    savePlaybackStateNow();
  }, delay);
}

// ── Event helpers ─────────────────────────────────────────────────────

function eventState(event) {
  return String(event?.state || "ready").trim().toLowerCase() || "ready";
}
function eventIsReady(event) { return eventState(event) === "ready"; }
function eventIsPending(event) { return !eventIsReady(event); }
function pendingEventCount() {
  return state.timeline.events.filter((event) => eventIsPending(event)).length;
}
function selectedDayIsToday() { return normalizeStoredDay(state.selectedDay) === todayString(); }
function eventStateLabel(event) {
  const value = eventState(event);
  if (value === "recording") return "Recording";
  if (value === "finalizing") return "Saving";
  if (value === "missing") return "Unavailable";
  return "Ready";
}

function selectedEvent() {
  return state.timeline.events.find((item) => item.id === state.selectedEventId) || null;
}

function eventDurationSeconds(event) {
  const startedAt = Date.parse(event?.clip_start);
  const endedAt = Date.parse(event?.clip_end);
  if (Number.isFinite(startedAt) && Number.isFinite(endedAt) && endedAt >= startedAt) {
    return (endedAt - startedAt) / 1000;
  }
  const range = eventRange(event);
  return Math.max(0, (range.endMinute - range.startMinute) * 60);
}

function eventRange(event) {
  return dayRange(event?.clip_start, event?.clip_end);
}

function dayRange(startedAt, endedAt = startedAt) {
  const safeEnd = endedAt || startedAt;
  const startMinute = clamp(minutesIntoDay(startedAt), 0, DAY_MINUTES);
  const endCandidate = clamp(minutesIntoDay(safeEnd), 0, DAY_MINUTES);
  const endMinute = endCandidate < startMinute ? DAY_MINUTES : endCandidate;
  return { startMinute, endMinute: Math.max(startMinute, endMinute) };
}

function minutesIntoDay(value) {
  const p = _localParts(value);
  return (p.h * 60) + p.m + (p.s / 60);
}

function minuteLabel(totalMinutes) {
  const rounded = Math.round(totalMinutes);
  if (rounded >= DAY_MINUTES) return "24:00";
  const safe = clamp(rounded, 0, DAY_MINUTES - 1);
  const hours = String(Math.floor(safe / 60)).padStart(2, "0");
  const minutes = String(safe % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function currentTimelineDuration() {
  return state.timelineView.endMinute - state.timelineView.startMinute;
}

function upsertTimelineEvent(event) {
  if (!event?.id) return null;
  const index = state.timeline.events.findIndex((item) => item.id === event.id);
  if (index === -1) {
    state.timeline.events.push(event);
    sortTimelineEvents();
    return event;
  }
  state.timeline.events[index] = { ...state.timeline.events[index], ...event };
  return state.timeline.events[index];
}

function sortTimelineEvents() {
  state.timeline.events.sort((left, right) => String(left?.triggered_at || "").localeCompare(String(right?.triggered_at || "")));
}

async function refreshEventFromServer(eventId) {
  const payload = await api(`/api/playback/events/${encodeURIComponent(eventId)}`);
  const event = payload?.event;
  return event ? upsertTimelineEvent(event) : null;
}

// ── Timeline filters / preset rows ────────────────────────────────────

function hiddenTimelinePresetKeys() {
  return new Set((state.timelineFilters.hiddenPresetKeys || []).map((value) => String(value || "").trim()).filter(Boolean));
}

function timelineVisibleRows() {
  const hidden = hiddenTimelinePresetKeys();
  return timelinePresetRows().filter((row) => !hidden.has(row.key));
}

function visibleTimelineSegments() {
  return timelineVisibleRows().flatMap((row) => row.events || []);
}

function visibleTimelineSegmentsOrdered() {
  return [...visibleTimelineSegments()].sort((left, right) => {
    const leftStart = Date.parse(left?.clip_start || "");
    const rightStart = Date.parse(right?.clip_start || "");
    if (Number.isFinite(leftStart) && Number.isFinite(rightStart) && leftStart !== rightStart) {
      return leftStart - rightStart;
    }
    return String(left?.eventId || "").localeCompare(String(right?.eventId || ""));
  });
}

function setHiddenTimelinePresetKeys(keys, options = {}) {
  state.timelineFilters.hiddenPresetKeys = [...new Set((Array.isArray(keys) ? keys : []).map((value) => String(value || "").trim()).filter(Boolean))];
  renderTimelineFilters();
  renderTimeline();
  if (options.persist !== false) schedulePlaybackStateSave();
}

function toggleTimelinePresetKey(key) {
  const normalized = String(key || "").trim();
  if (!normalized) return;
  const hidden = hiddenTimelinePresetKeys();
  if (hidden.has(normalized)) hidden.delete(normalized);
  else hidden.add(normalized);
  setHiddenTimelinePresetKeys([...hidden]);
}

function normalizeEventPresetColor(value) {
  const raw = String(value || "#c6a14b").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : "#c6a14b";
}

function eventPresetName(event) {
  return String(event?.preset_name || event?.title || "Recording").trim() || "Recording";
}

function eventPresetKey(event) {
  const explicit = String(event?.preset_key || "").trim();
  if (explicit) return explicit;
  return eventPresetName(event).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "recording";
}

function eventTagSegments(event) {
  const raw = Array.isArray(event?.tag_segments) ? event.tag_segments : [];
  const normalized = raw.map((segment) => {
    const clipStart = segment?.clip_start || event?.clip_start || null;
    const clipEnd = segment?.clip_end || event?.clip_end || null;
    if (!clipStart || !clipEnd) return null;
    return {
      eventId: String(event?.id || "").trim(),
      deviceId: String(event?.device_id || "").trim(),
      title: String(segment?.title || event?.title || eventPresetName(event)).trim() || eventPresetName(event),
      color: normalizeEventPresetColor(segment?.color || event?.color),
      presetName: String(segment?.preset_name || eventPresetName(event)).trim() || eventPresetName(event),
      presetKey: String(segment?.preset_key || eventPresetKey(event)).trim() || eventPresetKey(event),
      triggeredAt: segment?.triggered_at || event?.triggered_at || clipStart,
      clip_start: clipStart,
      clip_end: clipEnd,
      state: eventState(event),
      ready: eventIsReady(event),
    };
  }).filter(Boolean);

  if (normalized.length) return normalized;
  if (!event?.clip_start || !event?.clip_end) return [];

  return [{
    eventId: String(event?.id || "").trim(),
    deviceId: String(event?.device_id || "").trim(),
    title: String(event?.title || eventPresetName(event)).trim() || eventPresetName(event),
    color: normalizeEventPresetColor(event?.color),
    presetName: eventPresetName(event),
    presetKey: eventPresetKey(event),
    triggeredAt: event?.triggered_at || event?.clip_start,
    clip_start: event.clip_start,
    clip_end: event.clip_end,
    state: eventState(event),
    ready: eventIsReady(event),
  }];
}

function timelinePresetRows() {
  const rows = new Map();
  for (const event of (state.timeline?.events || [])) {
    for (const segment of eventTagSegments(event)) {
      const key = segment.presetKey;
      if (!rows.has(key)) {
        rows.set(key, { key, name: segment.presetName, color: segment.color, events: [] });
      }
      rows.get(key).events.push(segment);
    }
  }
  return [...rows.values()].sort((left, right) => {
    const leftName = String(left.name || "").toLowerCase();
    const rightName = String(right.name || "").toLowerCase();
    if (leftName !== rightName) return leftName.localeCompare(rightName);
    return String(left.key || "").localeCompare(String(right.key || ""));
  });
}

function renderTimelineFilters() {
  const host = el("playbackTimelineFilters");
  if (!host) return;
  const rows = timelinePresetRows();
  const hidden = hiddenTimelinePresetKeys();
  if (!rows.length) {
    host.innerHTML = "";
    host.classList.add("hidden");
    return;
  }
  host.classList.remove("hidden");
  host.innerHTML = `
    <div class="playbackTimelineFilterBar">
      <div class="playbackTimelineFilterLabel">Tags</div>
      <div class="playbackTimelineFilterChips">
        ${rows.map((row) => {
          const selected = !hidden.has(row.key);
          return `<button class="playbackTimelineFilterChip ${selected ? "is-selected" : ""}" type="button" data-preset-key="${escapeHtml(row.key)}" aria-pressed="${selected ? "true" : "false"}"><span class="playbackTimelineFilterSwatch" style="background:${escapeHtml(row.color)};"></span><span>${escapeHtml(row.name)}</span></button>`;
        }).join("")}
      </div>
    </div>
  `;
}

// ── Timeline navigation helpers ───────────────────────────────────────

function timelineMinuteFromClientX(clientX, rect) {
  const width = rect?.width || 0;
  if (!width) return state.timelineView.startMinute;
  const ratio = clamp((clientX - rect.left) / width, 0, 1);
  return state.timelineView.startMinute + (ratio * currentTimelineDuration());
}

function eventAtTimelineMinute(minute) {
  const selected = selectedEvent();
  if (selected && eventIsReady(selected)) {
    const visibleSelectedSegment = visibleTimelineSegments().find((segment) => segment.eventId === selected.id);
    if (visibleSelectedSegment) {
      const range = dayRange(visibleSelectedSegment.clip_start, visibleSelectedSegment.clip_end);
      if (minute >= range.startMinute && minute <= range.endMinute) return selected;
    }
  }
  const matchingSegment = visibleTimelineSegmentsOrdered().find((segment) => {
    if (!segment.ready) return false;
    const range = dayRange(segment.clip_start, segment.clip_end);
    return minute >= range.startMinute && minute <= range.endMinute;
  }) || null;
  if (!matchingSegment) return null;
  return state.timeline.events.find((event) => event.id === matchingSegment.eventId) || null;
}

function nextEventAtTimelineMinute(minute) {
  const nextSegment = visibleTimelineSegmentsOrdered().find((segment) => segment.ready && dayRange(segment.clip_start, segment.clip_end).startMinute >= minute) || null;
  if (!nextSegment) return null;
  return state.timeline.events.find((event) => event.id === nextSegment.eventId) || null;
}

function timelineBaseSelection(minute) {
  const exactEvent = eventAtTimelineMinute(minute);
  if (exactEvent) return { event: exactEvent, seekSeconds: eventSeekSecondsForMinute(exactEvent, minute) };
  const nextEvent = nextEventAtTimelineMinute(minute);
  if (nextEvent) return { event: nextEvent, seekSeconds: 0 };
  return null;
}

function nextTimelineEvent(currentEventId) {
  const currentIndex = state.timeline.events.findIndex((event) => event.id === currentEventId);
  if (currentIndex < 0) return null;
  return state.timeline.events.slice(currentIndex + 1).find((event) => eventIsReady(event)) || null;
}

function previousTimelineEvent(currentEventId) {
  const currentIndex = state.timeline.events.findIndex((event) => event.id === currentEventId);
  if (currentIndex <= 0) return null;
  return [...state.timeline.events.slice(0, currentIndex)].reverse().find((event) => eventIsReady(event)) || null;
}

function eventSeekSecondsForMinute(event, minute) {
  const range = eventRange(event);
  const durationSeconds = eventDurationSeconds(event);
  if (durationSeconds <= 0) return 0;
  return clamp((minute - range.startMinute) * 60, 0, durationSeconds);
}

// ── Timeline auto-refresh ─────────────────────────────────────────────

function clearTimelineAutoRefresh() {
  if (state.persistence.timelineRefreshTimer) {
    window.clearTimeout(state.persistence.timelineRefreshTimer);
    state.persistence.timelineRefreshTimer = 0;
  }
}

function nextTimelineAutoRefreshDelay() {
  if (pendingEventCount()) return ACTIVE_TIMELINE_REFRESH_MS;
  return selectedDayIsToday() ? ACTIVE_TIMELINE_REFRESH_MS : IDLE_TIMELINE_REFRESH_MS;
}

function scheduleTimelineAutoRefresh() {
  clearTimelineAutoRefresh();
  if (!state.activeDeviceIds.length) return;
  const delay = document.visibilityState === "visible"
    ? nextTimelineAutoRefreshDelay()
    : Math.max(IDLE_TIMELINE_REFRESH_MS, nextTimelineAutoRefreshDelay());
  state.persistence.timelineRefreshTimer = window.setTimeout(() => {
    state.persistence.timelineRefreshTimer = 0;
    loadTimeline({ background: true, preservePlayback: true, autoSelectLatest: false }).catch((error) => {
      setStatus(error.message || String(error));
      scheduleTimelineAutoRefresh();
    });
  }, delay);
}

// ── Tile management ───────────────────────────────────────────────────

function videoGridEl() { return el("playbackVideoGrid"); }

function primaryTile() {
  for (const id of state.activeDeviceIds) {
    const t = tiles.get(id);
    if (t) return t;
  }
  return null;
}

function primaryVideoEl() {
  return primaryTile()?.video || null;
}

function eachTileVideo(cb) {
  for (const tile of tiles.values()) cb(tile.video, tile);
}

function setTileOverlay(tile, text, visible, options = {}) {
  if (!tile?.overlayEl) return;
  const overlay = tile.overlayEl;
  const textEl = overlay.querySelector(".tileOverlayText");
  if (textEl) textEl.textContent = text || "";
  else overlay.textContent = text || "";
  const show = visible ?? !!(text || options.state === "loading");
  overlay.dataset.state = options.state || "";
  overlay.style.display = show ? "flex" : "none";
}

function suppressTileError(tile, ms) {
  const until = Date.now() + Math.max(0, ms | 0);
  if (until > tile.suppressErrorUntil) tile.suppressErrorUntil = until;
}

function isIgnorableTileError(tile) {
  if (Date.now() < tile.suppressErrorUntil) return true;
  const video = tile.video;
  if (!video || !video.currentSrc) return true;
  const err = video.error;
  if (!err) return true;
  return err.code === 1; // MEDIA_ERR_ABORTED
}

function detachTileSource(tile) {
  if (!tile) return;
  tile.loadToken += 1;
  suppressTileError(tile, 1500);
  if (tile.hls) {
    try { tile.hls.destroy(); } catch {}
    tile.hls = null;
  }
  if (tile.video) {
    try { tile.video.pause(); } catch {}
    try { tile.video.src = ""; } catch {}
  }
}

function hlsPlaylistUrlForRange(deviceId, fromIso, toIso) {
  if (!deviceId || !fromIso || !toIso) return null;
  const params = new URLSearchParams({ from: fromIso, to: toIso, ts: String(Date.now()) });
  return `/api/playback/hls/${encodeURIComponent(deviceId)}/index.m3u8?${params.toString()}`;
}

function attachTileSource(tile, event) {
  if (!tile || !event) return;
  detachTileSource(tile);
  tile.loadToken += 1;

  const url = hlsPlaylistUrlForRange(tile.deviceId, event.clip_start, event.clip_end);
  if (!url) {
    setTileOverlay(tile, "No source", true);
    return;
  }

  const video = tile.video;
  setTileOverlay(tile, "", true, { state: "loading" });

  const hideOverlay = () => setTileOverlay(tile, "", false);
  const showError = (msg) => setTileOverlay(tile, msg, true, { state: "error" });

  if (window.Hls && window.Hls.isSupported && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
    tile.hls = hls;
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
    // First decoded frame is the most reliable "video is actually showing" signal.
    video.addEventListener("playing", hideOverlay, { once: true });
    video.addEventListener("loadeddata", hideOverlay, { once: true });
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (data?.fatal) showError("No recording in this range");
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.addEventListener("loadeddata", hideOverlay, { once: true });
    video.addEventListener("error", () => {
      if (!isIgnorableTileError(tile)) showError("No recording in this range");
    });
    try { video.load(); } catch {}
  } else {
    showError("HLS not supported in this browser");
  }
}

function makeTileElement(device) {
  const tileEl = document.createElement("div");
  tileEl.className = "tile";
  tileEl.setAttribute("data-id", device.id);
  tileEl.innerHTML = `
    <div class="tilePlayer">
      <video playsinline preload="metadata" muted></video>
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
    </div>
  `;
  return tileEl;
}

function syncTileAspectFromVideo(tileEl, videoEl) {
  if (!tileEl || !videoEl) return;
  const w = videoEl.videoWidth || 0;
  const h = videoEl.videoHeight || 0;
  if (!w || !h) return;
  const ar = `${w} / ${h}`;
  tileEl.style.setProperty("--tile-ar", ar);
}

function chunkTilesEvenly(tileEls, rows) {
  const out = [];
  let index = 0;
  for (let r = 0; r < rows; r += 1) {
    const remaining = tileEls.length - index;
    const remainingRows = rows - r;
    const count = Math.ceil(remaining / remainingRows);
    out.push(tileEls.slice(index, index + count));
    index += count;
  }
  return out;
}

function getTileAspectRatio(tileEl) {
  const raw = tileEl.style.getPropertyValue("--tile-ar") || "16 / 9";
  const [num, den] = raw.split("/").map((s) => Number(String(s).trim()));
  if (!num || !den) return 16 / 9;
  return num / den;
}

function getOptimalRowCount(tileEls, containerWidth, containerHeight, gap) {
  const n = tileEls.length;
  if (n <= 1) return 1;
  let bestRows = 1;
  let bestArea = 0;
  for (let rowCount = 1; rowCount <= n; rowCount += 1) {
    const rows = chunkTilesEvenly(tileEls, rowCount);
    const totalGapH = (rowCount - 1) * gap;
    const rowHeight = Math.max(40, (containerHeight - totalGapH) / rowCount);
    let totalArea = 0;
    for (const row of rows) {
      const ars = row.map(getTileAspectRatio);
      const totalGapW = (row.length - 1) * gap;
      const sumAr = ars.reduce((a, b) => a + b, 0);
      const tentativeWidth = sumAr * rowHeight;
      const widthLimit = containerWidth - totalGapW;
      const usedHeight = tentativeWidth > widthLimit ? widthLimit / sumAr : rowHeight;
      totalArea += usedHeight * (sumAr * usedHeight + totalGapW);
    }
    if (totalArea > bestArea) { bestArea = totalArea; bestRows = rowCount; }
  }
  return bestRows;
}

function recomputeGrid() {
  const grid = videoGridEl();
  if (!grid) return;
  const tileEls = Array.from(grid.querySelectorAll(".tile[data-id]"));
  if (!tileEls.length) return;
  const styles = getComputedStyle(grid);
  const gap = Number.parseFloat(styles.rowGap || styles.gap || "0") || 0;
  const containerWidth = grid.clientWidth;
  const containerHeight = grid.clientHeight;
  if (containerWidth < 50 || containerHeight < 50) return;
  const rowCount = getOptimalRowCount(tileEls, containerWidth, containerHeight, gap);
  const rows = chunkTilesEvenly(tileEls, rowCount);
  const totalGapH = (rowCount - 1) * gap;
  const rowHeight = Math.max(60, (containerHeight - totalGapH) / rowCount);
  const frag = document.createDocumentFragment();
  rows.forEach((row) => {
    const rowEl = document.createElement("div");
    rowEl.className = "videoRow";
    const ars = row.map(getTileAspectRatio);
    const sumAr = ars.reduce((a, b) => a + b, 0);
    const totalGapW = (row.length - 1) * gap;
    const tentativeWidth = sumAr * rowHeight;
    const widthLimit = containerWidth - totalGapW;
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

function getOrCreateTile(deviceId) {
  if (tiles.has(deviceId)) return tiles.get(deviceId);
  const device = state.devices.find((d) => d.id === deviceId);
  if (!device) return null;

  const tileEl = makeTileElement(device);
  const video = tileEl.querySelector("video");
  const audioBtn = tileEl.querySelector(".tileAudioBtn");
  const overlayEl = tileEl.querySelector(".tileOverlay");

  const tile = {
    tile: tileEl,
    video,
    hls: null,
    audioBtn,
    overlayEl,
    deviceId,
    loadToken: 0,
    suppressErrorUntil: 0,
  };
  tiles.set(deviceId, tile);

  let muted = loadTileMuted(deviceId);
  function applyTileMuted() {
    video.muted = muted;
    audioBtn.setAttribute("data-muted", muted ? "1" : "0");
    audioBtn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    audioBtn.setAttribute("title", muted ? "Unmute" : "Mute");
  }
  applyTileMuted();
  audioBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    muted = !muted;
    applyTileMuted();
    saveTileMuted(deviceId, muted);
  });

  video.addEventListener("loadedmetadata", () => {
    syncTileAspectFromVideo(tileEl, video);
    if (tile === primaryTile()) {
      syncPlaybackTransport();
      updatePlaybackCursorFromVideo();
      schedulePlaybackStateSave();
    }
    requestAnimationFrame(recomputeGrid);
  });
  video.addEventListener("loadeddata", () => syncTileAspectFromVideo(tileEl, video));
  video.addEventListener("playing", () => syncTileAspectFromVideo(tileEl, video));
  video.addEventListener("play", () => {
    if (tile !== primaryTile()) return;
    if (isReverseDirection()) { video.pause(); return; }
    startPlaybackCursorLoop();
    syncPlaybackTransport();
  });
  video.addEventListener("pause", () => {
    if (tile !== primaryTile()) return;
    stopPlaybackCursorLoop();
    if (!isReversePlaybackActive()) {
      updatePlaybackCursorFromVideo();
      queueForwardPlaybackBoundaryCheck();
    }
    syncPlaybackTransport();
    schedulePlaybackStateSave();
  });
  video.addEventListener("timeupdate", () => {
    if (tile !== primaryTile()) return;
    updatePlaybackCursorFromVideo();
    queueForwardPlaybackBoundaryCheck();
    schedulePlaybackStateSave();
  });
  video.addEventListener("seeked", () => {
    if (tile !== primaryTile()) return;
    updatePlaybackCursorFromVideo();
    queueForwardPlaybackBoundaryCheck();
    schedulePlaybackStateSave();
  });
  video.addEventListener("ended", async () => {
    if (tile !== primaryTile()) return;
    updatePlaybackCursorFromVideo();
    const currentEvent = selectedEvent();
    if (!currentEvent) {
      stopPlaybackCursorLoop();
      stopReversePlayback();
      stopSimulatedForwardPlayback();
      syncPlaybackTransport();
      setStatus("Playback ended.");
      schedulePlaybackStateSave();
      return;
    }
    await handleForwardPlaybackBoundary(currentEvent);
    schedulePlaybackStateSave();
  });
  video.addEventListener("error", () => {
    if (isIgnorableTileError(tile)) return;
    setTileOverlay(tile, "No recording in this range", true);
  });

  return tile;
}

function destroyTile(deviceId) {
  const tile = tiles.get(deviceId);
  if (!tile) return;
  detachTileSource(tile);
  if (tile.tile?.parentElement) tile.tile.parentElement.removeChild(tile.tile);
  tiles.delete(deviceId);
}

function syncTilesToActive() {
  for (const id of [...tiles.keys()]) {
    if (!state.activeDeviceIds.includes(id)) destroyTile(id);
  }
  const grid = videoGridEl();
  if (!grid) return;
  for (const id of state.activeDeviceIds) {
    const tile = getOrCreateTile(id);
    if (tile && tile.tile.parentElement !== grid && tile.tile.parentElement?.parentElement !== grid) {
      grid.appendChild(tile.tile);
    }
  }
  const ordered = state.activeDeviceIds.map((id) => tiles.get(id)?.tile).filter(Boolean);
  if (ordered.length) grid.replaceChildren(...ordered);

  if (!state.activeDeviceIds.length) {
    showVideoEmpty(
      "Select a camera",
      "Choose one or more cameras from the sidebar to load recorded clips.",
      { state: "empty", badge: "Camera" },
    );
  } else if (!selectedEvent()) {
    const empty = timelineEmptyState();
    showVideoEmpty(empty.title, empty.text, { state: empty.state });
  } else {
    hideVideoEmpty();
  }
  requestAnimationFrame(recomputeGrid);
}

// ── Sidebar ───────────────────────────────────────────────────────────

function getDeviceOnlineStatus(deviceId) {
  if (!window.eventNotify) return "unknown";
  const cached = window.eventNotify.getDeviceStatusCache?.();
  return cached?.[deviceId] || "unknown";
}

function renderSidebar() {
  const list = el("playbackSidebarList");
  if (!list) return;
  const configured = state.devices.filter((d) => d.profile_token);
  if (!configured.length) {
    list.innerHTML = '<div class="liveSidebarEmpty">No cameras configured</div>';
    return;
  }
  list.innerHTML = configured.map((d) => {
    const active = state.activeDeviceIds.includes(d.id);
    const onlineStatus = getDeviceOnlineStatus(d.id);
    const camDotClass = (onlineStatus === "live" || onlineStatus === "idle") ? "dot-online"
      : onlineStatus === "down" ? "dot-offline" : "dot-unknown";
    return `<div class="liveSidebarRow ${active ? "active" : ""}" data-id="${escapeHtml(d.id)}">
      <span class="liveSidebarName">${escapeHtml(d.name || d.ip || d.id)}</span>
      <span class="statusDot ${camDotClass}"></span>
    </div>`;
  }).join("");
}

async function setActiveDeviceIds(ids, options = {}) {
  const seen = new Set();
  const next = [];
  for (const id of ids) {
    const trimmed = String(id || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    if (!state.devices.find((d) => d.id === trimmed && d.profile_token)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  state.activeDeviceIds = next;
  renderSidebar();
  syncTilesToActive();
  schedulePlaybackStateSave();

  if (options.reloadTimeline !== false) {
    await loadTimeline({ background: false, preservePlayback: true, autoSelectLatest: false });
  }

  const event = selectedEvent();
  if (event) reloadAllTileSourcesForEvent(event);
}

async function toggleActiveDevice(deviceId) {
  const idx = state.activeDeviceIds.indexOf(deviceId);
  const next = idx === -1
    ? [...state.activeDeviceIds, deviceId]
    : state.activeDeviceIds.filter((id) => id !== deviceId);
  await setActiveDeviceIds(next);
}

// ── Master event source loading across tiles ──────────────────────────

function reloadAllTileSourcesForEvent(event) {
  if (!event) return;
  for (const tile of tiles.values()) attachTileSource(tile, event);
}

// ── Transport (across all tiles) ──────────────────────────────────────

async function seekVideoToSeconds(video, seconds) {
  if (!video) return;
  const target = Math.max(0, Number(seconds) || 0);
  if (video.readyState >= 1) { video.currentTime = target; return; }
  await new Promise((resolve) => {
    const apply = () => { video.currentTime = target; resolve(); };
    video.addEventListener("loadedmetadata", apply, { once: true });
  });
}

async function seekAllTilesToSeconds(seconds) {
  await Promise.all([...tiles.values()].map((tile) => seekVideoToSeconds(tile.video, seconds)));
}

async function startVideoPlayback(video) {
  if (!video) return false;
  try {
    const r = video.play();
    if (r && typeof r.then === "function") await r;
    return true;
  } catch { return false; }
}

async function startAllTilesPlayback() {
  const results = await Promise.all([...tiles.values()].map((tile) => startVideoPlayback(tile.video)));
  return results.some(Boolean);
}

function pauseAllTiles() {
  for (const tile of tiles.values()) {
    try { if (!tile.video.paused) tile.video.pause(); } catch {}
  }
}

function setAllTilesPlaybackRate(rate) {
  for (const tile of tiles.values()) {
    tile.video.playbackRate = rate;
    tile.video.defaultPlaybackRate = rate;
  }
}

function playbackDurationSeconds(video, event = selectedEvent()) {
  if (Number.isFinite(video?.duration) && video.duration > 0) return video.duration;
  return eventDurationSeconds(event);
}

function playbackResetSeconds(video, event = selectedEvent()) {
  return isReverseDirection() ? playbackDurationSeconds(video, event) : 0;
}

function isPlaybackRunning(video = primaryVideoEl()) {
  if (!selectedEvent()) return false;
  if (isReverseDirection()) return isReversePlaybackActive();
  if (isSimulatedForwardPlaybackActive()) return true;
  return !!(video && video.currentSrc && !video.paused && !video.ended);
}

function syncPlaybackTransport() {
  const video = primaryVideoEl();
  const playPauseBtn = el("playbackPlayPauseBtn");
  const stopBtn = el("playbackStopBtn");
  const shuttleInput = el("playbackShuttleInput");
  const shuttleValue = el("playbackShuttleValue");
  const hasEvent = !!selectedEvent();
  const hasTiles = state.activeDeviceIds.length > 0;
  const running = isPlaybackRunning(video);

  if (playPauseBtn) {
    playPauseBtn.innerHTML = playbackTransportIcon(running ? "pause" : "play");
    playPauseBtn.setAttribute("aria-label", running ? "Pause" : "Play");
    playPauseBtn.title = running ? "Pause" : "Play";
    playPauseBtn.disabled = !hasEvent || !hasTiles;
  }
  if (stopBtn) {
    stopBtn.setAttribute("aria-label", "Stop");
    stopBtn.title = "Stop";
    stopBtn.disabled = !hasEvent || !hasTiles;
  }

  const effectiveSigned = running ? signedShuttleValue() : 0;
  if (shuttleInput) {
    if (!_shuttleDragging && !_shuttleAnimRafId) {
      shuttleInput.value = String(shuttleValueToPos(effectiveSigned));
    }
    shuttleInput.disabled = !hasEvent || !hasTiles;
  }
  const displayPos = shuttleInput ? Number(shuttleInput.value) : shuttleValueToPos(effectiveSigned);
  const displayValue = shuttlePosToValue(displayPos);
  updateShuttleFillFromPos(displayPos);
  if (shuttleValue) {
    const label = formatShuttleValue(displayValue);
    shuttleValue.value = label;
    shuttleValue.textContent = label;
  }

  const speed = normalizePlaybackSpeed(state.transport.speed);
  const nativeSpeed = shouldSimulateForwardPlayback(speed, state.transport.direction)
    ? MAX_NATIVE_PLAYBACK_RATE
    : speed;
  setAllTilesPlaybackRate(nativeSpeed);
}

function stopSimulatedForwardPlayback() {
  const f = forwardPlaybackState();
  f.active = false;
  f.lastTs = 0;
  if (f.rafId) { cancelAnimationFrame(f.rafId); f.rafId = 0; }
}

function stopReversePlayback() {
  const r = reversePlaybackState();
  r.active = false;
  r.lastTs = 0;
  if (r.rafId) { cancelAnimationFrame(r.rafId); r.rafId = 0; }
}

function pauseCurrentPlayback() {
  clearForwardPlaybackBoundarySchedule();
  stopSimulatedForwardPlayback();
  stopReversePlayback();
  stopPlaybackCursorLoop();
  state.transport.advancingToNextClip = false;
  pauseAllTiles();
  updatePlaybackCursorFromVideo();
  syncPlaybackTransport();
}

async function handleReversePlaybackBoundary(event) {
  if (!event) { syncPlaybackTransport(); return; }
  const previousEvent = previousTimelineEvent(event.id);
  if (!previousEvent) {
    await seekAllTilesToSeconds(0);
    updatePlaybackCursorFromVideo();
    syncPlaybackTransport();
    setStatus(`Reached beginning of ${event.title}.`);
    return;
  }
  setStatus(`Reached start of ${event.title}. Loading ${previousEvent.title}…`);
  await selectEvent(previousEvent.id, {
    seekSeconds: eventDurationSeconds(previousEvent),
    autoplay: true,
  });
}

function clearForwardPlaybackBoundarySchedule() {
  if (state.transport.forwardBoundaryTimer) {
    window.clearTimeout(state.transport.forwardBoundaryTimer);
    state.transport.forwardBoundaryTimer = 0;
  }
}

async function handleForwardPlaybackBoundary(event) {
  clearForwardPlaybackBoundarySchedule();
  if (!event || state.selectedEventId !== event.id || state.transport.advancingToNextClip) {
    syncPlaybackTransport();
    return;
  }
  state.transport.advancingToNextClip = true;
  try {
    stopPlaybackCursorLoop();
    stopSimulatedForwardPlayback();
    stopReversePlayback();
    pauseAllTiles();
    syncPlaybackTransport();
    const nextEvent = nextTimelineEvent(event.id);
    if (!nextEvent) {
      setStatus(`Finished ${event.title}.`);
      return;
    }
    setStatus(`Finished ${event.title}. Loading ${nextEvent.title}…`);
    await selectEvent(nextEvent.id, { autoplay: true });
  } finally {
    state.transport.advancingToNextClip = false;
  }
}

function playbackReachedEnd(video, event) {
  if (!video || !event || isReverseDirection() || state.transport.advancingToNextClip) return false;
  const duration = playbackDurationSeconds(video, event);
  if (!(Number.isFinite(duration) && duration > 0)) return false;
  return (Number(video.currentTime) || 0) >= Math.max(0, duration - 0.05);
}

function queueForwardPlaybackBoundaryCheck(event = selectedEvent()) {
  const video = primaryVideoEl();
  if (!playbackReachedEnd(video, event)) return;
  if (state.transport.forwardBoundaryTimer) return;
  state.transport.forwardBoundaryTimer = window.setTimeout(() => {
    state.transport.forwardBoundaryTimer = 0;
    handleForwardPlaybackBoundary(event).catch((error) => setStatus(error.message || String(error)));
  }, 0);
}

async function startReversePlayback(event) {
  const video = primaryVideoEl();
  if (!video || !event) return false;
  stopPlaybackCursorLoop();
  stopSimulatedForwardPlayback();
  stopReversePlayback();
  pauseAllTiles();

  if (video.currentTime <= 0.05) {
    await seekAllTilesToSeconds(playbackDurationSeconds(video, event));
  }

  const reverse = reversePlaybackState();
  reverse.active = true;
  reverse.lastTs = 0;
  syncPlaybackTransport();

  const tick = (timestamp) => {
    if (!reverse.active) { reverse.rafId = 0; return; }
    if (!reverse.lastTs) reverse.lastTs = timestamp;
    const elapsedSeconds = clamp((timestamp - reverse.lastTs) / 1000, 0, 0.25);
    reverse.lastTs = timestamp;
    const nextTime = Math.max(0, (Number(video.currentTime) || 0) - (elapsedSeconds * normalizePlaybackSpeed(state.transport.speed)));
    eachTileVideo((v) => { v.currentTime = nextTime; });
    updatePlaybackCursorFromVideo();
    if (nextTime <= 0.001) {
      stopReversePlayback();
      syncPlaybackTransport();
      handleReversePlaybackBoundary(event).catch((error) => setStatus(error.message || String(error)));
      return;
    }
    reverse.rafId = requestAnimationFrame(tick);
  };
  reverse.rafId = requestAnimationFrame(tick);
  return true;
}

async function startSimulatedForwardPlayback(event) {
  const video = primaryVideoEl();
  if (!video || !event) return false;
  clearForwardPlaybackBoundarySchedule();
  stopPlaybackCursorLoop();
  stopSimulatedForwardPlayback();
  stopReversePlayback();
  pauseAllTiles();

  const forward = forwardPlaybackState();
  forward.active = true;
  forward.lastTs = 0;
  syncPlaybackTransport();

  const tick = (timestamp) => {
    if (!forward.active || state.selectedEventId !== event.id) { forward.rafId = 0; return; }
    if (!forward.lastTs) forward.lastTs = timestamp;
    const duration = playbackDurationSeconds(video, event);
    if (!(Number.isFinite(duration) && duration > 0)) {
      stopSimulatedForwardPlayback();
      syncPlaybackTransport();
      return;
    }
    const elapsedSeconds = clamp((timestamp - forward.lastTs) / 1000, 0, 0.25);
    forward.lastTs = timestamp;
    const nextTime = Math.min(duration, (Number(video.currentTime) || 0) + (elapsedSeconds * normalizePlaybackSpeed(state.transport.speed)));
    eachTileVideo((v) => { v.currentTime = nextTime; });
    updatePlaybackCursorFromVideo();
    if (nextTime >= Math.max(0, duration - 0.001)) {
      stopSimulatedForwardPlayback();
      syncPlaybackTransport();
      queueForwardPlaybackBoundaryCheck(event);
      return;
    }
    forward.rafId = requestAnimationFrame(tick);
  };
  forward.rafId = requestAnimationFrame(tick);
  return true;
}

async function startConfiguredPlayback(event) {
  if (!event) return false;
  if (isReverseDirection()) return await startReversePlayback(event);
  if (shouldSimulateForwardPlayback()) {
    const started = await startSimulatedForwardPlayback(event);
    syncPlaybackTransport();
    return started;
  }
  stopSimulatedForwardPlayback();
  stopReversePlayback();
  const speed = normalizePlaybackSpeed(state.transport.speed);
  setAllTilesPlaybackRate(speed);
  const started = await startAllTilesPlayback();
  syncPlaybackTransport();
  return started;
}

function playbackStatusText(event, started) {
  if (!event) return started ? "Playing." : "Loaded.";
  if (!started) return `Loaded ${event.title}.`;
  return `Playing ${event.title} ${playbackDirectionLabel()} at ${formatPlaybackSpeed(state.transport.speed)}.`;
}

function setPlaybackSpeed(value) {
  const event = selectedEvent();
  const previousSpeed = state.transport.speed;
  const wasRunning = isPlaybackRunning();
  state.transport.speed = normalizePlaybackSpeed(value);
  syncPlaybackTransport();
  const crossedNativeLimit = !isReverseDirection()
    && shouldSimulateForwardPlayback(previousSpeed) !== shouldSimulateForwardPlayback(state.transport.speed);
  if (event && wasRunning && crossedNativeLimit) {
    startConfiguredPlayback(event)
      .then((started) => setStatus(playbackStatusText(event, started)))
      .catch((error) => setStatus(error.message || String(error)));
    return;
  }
  if (event && wasRunning) {
    setStatus(`Playing ${event.title} ${playbackDirectionLabel()} at ${formatPlaybackSpeed(state.transport.speed)}.`);
  }
}

async function setShuttle(signedValue) {
  const value = clamp(Number(signedValue) || 0, -SHUTTLE_MAX, SHUTTLE_MAX);
  const event = selectedEvent();
  if (Math.abs(value) < SHUTTLE_DEADZONE) {
    pauseCurrentPlayback();
    syncPlaybackTransport();
    return;
  }
  const nextDirection = value < 0 ? "backward" : "forward";
  const nextSpeed = Math.min(SHUTTLE_MAX, Math.abs(value));
  if (nextDirection !== playbackDirectionLabel()) await setPlaybackDirection(nextDirection);
  setPlaybackSpeed(nextSpeed);
  if (event && !isPlaybackRunning()) startConfiguredPlayback(event).catch(() => {});
}

function _easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function animateShuttleTo(targetValue, durationMs = SHUTTLE_SNAP_DURATION_MS) {
  cancelShuttleAnim();
  const input = el("playbackShuttleInput");
  if (!input) { setShuttle(targetValue); return; }
  const startPos = clamp(Number(input.value) || 0, -1, 1);
  const endPos = shuttleValueToPos(targetValue);
  if (Math.abs(endPos - startPos) < 0.002) {
    input.value = String(endPos);
    setShuttle(shuttlePosToValue(endPos));
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / durationMs);
    const p = startPos + (endPos - startPos) * _easeOutCubic(t);
    input.value = String(p);
    updateShuttleFillFromPos(p);
    setShuttle(shuttlePosToValue(p));
    if (t < 1) {
      _shuttleAnimRafId = requestAnimationFrame(step);
    } else {
      _shuttleAnimRafId = 0;
      input.value = String(endPos);
      updateShuttleFillFromPos(endPos);
      setShuttle(shuttlePosToValue(endPos));
    }
  };
  _shuttleAnimRafId = requestAnimationFrame(step);
}

function resetShuttleToRest() { animateShuttleTo(SHUTTLE_REST_VALUE); }

async function setPlaybackDirection(direction) {
  const nextDirection = normalizePlaybackDirection(direction);
  const currentDirection = playbackDirectionLabel();
  const event = selectedEvent();
  const wasRunning = isPlaybackRunning();
  if (nextDirection === currentDirection) { syncPlaybackTransport(); return; }
  state.transport.direction = nextDirection;
  syncPlaybackTransport();
  const video = primaryVideoEl();
  if (video && event && nextDirection === "backward" && video.currentSrc && video.currentTime <= 0.05) {
    await seekAllTilesToSeconds(playbackDurationSeconds(video, event));
  }
  if (wasRunning && event) {
    const started = await startConfiguredPlayback(event);
    setStatus(playbackStatusText(event, started));
    return;
  }
  if (event) {
    updatePlaybackCursorFromVideo();
    setStatus(`Playback direction set to ${nextDirection}.`);
  }
}

async function togglePlayback() {
  const event = selectedEvent();
  if (!event) return;
  if (isPlaybackRunning()) {
    pauseCurrentPlayback();
    setStatus(`Paused ${event.title}.`);
    return;
  }
  const video = primaryVideoEl();
  if (!video || !video.currentSrc) {
    await selectEvent(event.id, { seekSeconds: playbackResetSeconds(video, event), autoplay: true });
    return;
  }
  const started = await startConfiguredPlayback(event);
  setStatus(playbackStatusText(event, started));
}

async function stopPlayback() {
  const event = selectedEvent();
  if (!event) return;
  const video = primaryVideoEl();
  if (!video || !video.currentSrc) {
    await selectEvent(event.id, { seekSeconds: playbackResetSeconds(video, event), autoplay: false });
    return;
  }
  pauseCurrentPlayback();
  await seekAllTilesToSeconds(playbackResetSeconds(video, event));
  updatePlaybackCursorFromVideo();
  syncPlaybackTransport();
  setStatus(`Stopped ${event.title}.`);
}

// ── Timeline rendering ────────────────────────────────────────────────

function visibleTimelinePercent(minute) {
  const duration = currentTimelineDuration() || DAY_MINUTES;
  return clamp(((minute - state.timelineView.startMinute) / duration) * 100, 0, 100);
}

function visibleTimelineWidth(startMinute, endMinute) {
  return Math.max(0, visibleTimelinePercent(endMinute) - visibleTimelinePercent(startMinute));
}

function isVisibleRange(startMinute, endMinute) {
  return endMinute >= state.timelineView.startMinute && startMinute <= state.timelineView.endMinute;
}

function chooseTimelineStep(duration) {
  const steps = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720];
  return steps.find((step) => duration / step <= 8) || DAY_MINUTES;
}

function timelineTickLayout() {
  const step = chooseTimelineStep(currentTimelineDuration());
  const firstTick = Math.ceil(state.timelineView.startMinute / step) * step;
  const tickMinutes = [];
  for (let minute = firstTick; minute <= state.timelineView.endMinute; minute += step) {
    tickMinutes.push(minute);
  }
  return { tickMinutes };
}

function setTimelineViewport(startMinute, durationMinutes, options = {}) {
  const duration = clamp(durationMinutes, MIN_VISIBLE_MINUTES, DAY_MINUTES);
  const start = clamp(startMinute, 0, DAY_MINUTES - duration);
  const changed = Math.abs(state.timelineView.startMinute - start) > 0.01 || Math.abs(currentTimelineDuration() - duration) > 0.01;
  state.timelineView.startMinute = start;
  state.timelineView.endMinute = start + duration;
  if (changed && options.render !== false) renderTimeline();
  if (changed && options.persist !== false) schedulePlaybackStateSave();
}

function ensureTimelineRangeVisible(startMinute, endMinute) {
  const duration = currentTimelineDuration();
  const padding = Math.max(duration * 0.12, 2);
  const inView = startMinute >= (state.timelineView.startMinute + padding)
    && endMinute <= (state.timelineView.endMinute - padding);
  if (inView) return;
  const targetDuration = clamp(Math.max(duration, endMinute - startMinute + (padding * 2)), MIN_VISIBLE_MINUTES, DAY_MINUTES);
  const midpoint = (startMinute + endMinute) / 2;
  setTimelineViewport(midpoint - (targetDuration / 2), targetDuration);
}

function shouldSuppressTimelineClick() {
  return Date.now() < state.timelineView.suppressClickUntil;
}

function syncPlaybackCursor() {
  const track = el("playbackTimelineTrack");
  const cursor = track?.querySelector("[data-playback-cursor]");
  const label = track?.querySelector("[data-playback-cursor-label]");
  if (!track || !cursor || !label) return;
  if (!Number.isFinite(state.playbackCursor.minute) || !isVisibleRange(state.playbackCursor.minute, state.playbackCursor.minute)) {
    cursor.classList.add("hidden");
    label.textContent = "";
    return;
  }
  cursor.classList.remove("hidden");
  cursor.style.left = `${visibleTimelinePercent(state.playbackCursor.minute)}%`;
  label.textContent = state.playbackCursor.label || minuteLabel(state.playbackCursor.minute);
}

function setPlaybackCursor(position = null) {
  state.playbackCursor.minute = Number.isFinite(position?.minute) ? clamp(position.minute, 0, DAY_MINUTES) : null;
  state.playbackCursor.label = position?.label || "";
  syncPlaybackCursor();
}

function stopPlaybackCursorLoop() {
  if (state.playbackCursor.rafId) {
    cancelAnimationFrame(state.playbackCursor.rafId);
    state.playbackCursor.rafId = 0;
  }
}

function playbackCursorPosition() {
  const event = selectedEvent();
  if (!event) return null;
  const video = primaryVideoEl();
  const offsetSeconds = Number.isFinite(video?.currentTime) ? Math.max(video.currentTime, 0) : 0;
  const range = dayRange(event.clip_start, event.clip_end);
  const minute = clamp(range.startMinute + (offsetSeconds / 60), range.startMinute, range.endMinute);
  const startMs = Date.parse(event.clip_start);
  return {
    minute,
    label: Number.isFinite(startMs) ? clockLabel(startMs + (offsetSeconds * 1000)) : minuteLabel(minute),
  };
}

function updatePlaybackCursorFromVideo() {
  setPlaybackCursor(playbackCursorPosition());
}

function startPlaybackCursorLoop() {
  stopPlaybackCursorLoop();
  const tick = () => {
    updatePlaybackCursorFromVideo();
    queueForwardPlaybackBoundaryCheck();
    const video = primaryVideoEl();
    if (video && !video.paused && !video.ended) {
      state.playbackCursor.rafId = requestAnimationFrame(tick);
      return;
    }
    state.playbackCursor.rafId = 0;
  };
  tick();
}

function renderTimelineScale() {
  const scale = el("playbackTimelineScale");
  if (!scale) return;
  const { tickMinutes } = timelineTickLayout();
  const labels = [];
  if (!tickMinutes.length || Math.abs(tickMinutes[0] - state.timelineView.startMinute) > 0.5) {
    labels.push(`<span class="playbackTimelineTick is-edge" style="left:0%;">${minuteLabel(state.timelineView.startMinute)}</span>`);
  }
  tickMinutes.forEach((minute) => {
    labels.push(`<span class="playbackTimelineTick" style="left:${visibleTimelinePercent(minute)}%;">${minuteLabel(minute)}</span>`);
  });
  const lastTick = tickMinutes.at(-1);
  if (lastTick == null || Math.abs(lastTick - state.timelineView.endMinute) > 0.5) {
    labels.push(`<span class="playbackTimelineTick is-edge is-end" style="left:100%;">${minuteLabel(state.timelineView.endMinute)}</span>`);
  }
  scale.innerHTML = labels.join("");
}

function renderTimeline() {
  const track = el("playbackTimelineTrack");
  if (!track) return;
  renderTimelineFilters();
  renderTimelineScale();
  const { tickMinutes } = timelineTickLayout();
  const rows = timelineVisibleRows();
  track.innerHTML = `
    ${tickMinutes.map((minute) => `<span class="playbackTimelineGuide" style="left:${visibleTimelinePercent(minute)}%;" aria-hidden="true"></span>`).join("")}
    <div class="playbackTimelineRows">
      ${rows.length ? rows.map((row) => `
        <div class="playbackTimelineLane" data-preset-key="${escapeHtml(row.key)}">
          <div class="playbackTimelineBase" data-playback-track-base></div>
          ${row.events.map((segment) => {
            const range = dayRange(segment.clip_start, segment.clip_end);
            if (!isVisibleRange(range.startMinute, range.endMinute)) return "";
            const clippedStart = clamp(range.startMinute, state.timelineView.startMinute, state.timelineView.endMinute);
            const clippedEnd = clamp(range.endMinute, state.timelineView.startMinute, state.timelineView.endMinute);
            const left = visibleTimelinePercent(clippedStart);
            const width = visibleTimelineWidth(clippedStart, clippedEnd);
            const active = segment.eventId === state.selectedEventId ? "is-active" : "";
            const pending = !segment.ready ? `is-pending is-${escapeHtml(segment.state)}` : "";
            const readiness = !segment.ready ? ` · ${eventStateLabel(segment)}` : "";
            const camLabel = segment.deviceId ? ` · ${deviceName(segment.deviceId)}` : "";
            return `<button class="playbackMarker ${active} ${pending}" type="button" data-event-id="${escapeHtml(segment.eventId)}" aria-disabled="${segment.ready ? "false" : "true"}" style="left:${left}%; width:${width}%; background:${escapeHtml(segment.color)};" title="${escapeHtml(`${segment.presetName}${camLabel} · ${clockLabel(segment.triggeredAt)}${readiness}`)}"></button>`;
          }).join("")}
        </div>
      `).join("") : `<div class="playbackTimelineEmpty">${timelinePresetRows().length ? "No tags selected." : "No recordings in this range."}</div>`}
    </div>
    <div class="playbackTimelineCursor hidden" data-playback-cursor>
      <span class="playbackTimelineCursorLabel" data-playback-cursor-label></span>
    </div>
  `;
  syncPlaybackCursor();
}

function updatePlaybackHeader(event = null) {
  const sub = el("playbackHeaderSub");
  if (!sub) return;
  if (!event) {
    sub.textContent = state.activeDeviceIds.length
      ? "Pick a marker on the timeline to load recorded clips across all selected cameras."
      : "Pick cameras from the sidebar and a marker on the timeline to load recorded clips.";
    return;
  }
  sub.textContent = `${event.title} · ${clockLabel(event.triggered_at)} · ${deviceName(event.device_id)}`;
}

// ── Loading: devices + per-device timelines (merged) ──────────────────

async function loadDevices() {
  const out = await api("/api/devices");
  state.devices = Array.isArray(out?.devices) ? out.devices : [];
  state.activeDeviceIds = state.activeDeviceIds.filter((id) => state.devices.some((d) => d.id === id && d.profile_token));
  renderSidebar();
}

function applyTimelineData(merged, options = {}) {
  state.timeline = {
    segments: Array.isArray(merged?.segments) ? merged.segments : [],
    events: Array.isArray(merged?.events) ? merged.events : [],
  };
  sortTimelineEvents();

  const firstSeg = state.timeline.segments[0] || state.timeline.events[0];
  if (firstSeg) _extractTzOffset(firstSeg.started_at || firstSeg.clip_start || firstSeg.triggered_at);

  const hiddenPresetKeys = Array.isArray(options.hiddenPresetKeys)
    ? options.hiddenPresetKeys
    : state.timelineFilters.hiddenPresetKeys;
  const availablePresetKeys = new Set(timelinePresetRows().map((row) => row.key));
  state.timelineFilters.hiddenPresetKeys = [...new Set((hiddenPresetKeys || [])
    .map((value) => String(value || "").trim())
    .filter((value) => availablePresetKeys.has(value)))];
}

async function fetchTimelineForDevice(deviceId, day) {
  const query = new URLSearchParams({ device_id: deviceId, day: day || todayString() });
  query.set("ts", String(Date.now()));
  return await api(`/api/playback/timeline?${query.toString()}`, { cache: "no-store" });
}

function mergeTimelines(payloads) {
  const segments = [];
  const events = [];
  const seenEventIds = new Set();
  for (const payload of payloads) {
    if (!payload) continue;
    if (Array.isArray(payload.segments)) segments.push(...payload.segments);
    if (Array.isArray(payload.events)) {
      for (const ev of payload.events) {
        const id = String(ev?.id || "").trim();
        if (!id || seenEventIds.has(id)) continue;
        seenEventIds.add(id);
        events.push(ev);
      }
    }
  }
  return { segments, events };
}

function syncTimelineSelection(options = {}) {
  const preferredEventId = typeof options.preferredEventId === "string" ? options.preferredEventId : "";
  const preferredEvent = state.timeline.events.find((item) => item.id === preferredEventId && eventIsReady(item)) || null;
  if (preferredEvent) {
    state.selectedEventId = preferredEvent.id;
    return preferredEvent;
  }
  const currentSelected = state.timeline.events.find((item) => item.id === state.selectedEventId) || null;
  if (currentSelected && eventIsReady(currentSelected)) return currentSelected;
  if (options.autoSelectLatest) {
    const latestReady = [...state.timeline.events].reverse().find((item) => eventIsReady(item)) || null;
    state.selectedEventId = latestReady?.id || null;
    return latestReady;
  }
  state.selectedEventId = null;
  return null;
}

function timelineEmptyState() {
  const pending = pendingEventCount();
  if (pending) {
    return {
      state: "waiting",
      title: "Recording still saving",
      text: "Grayed markers are still being finalized and will become playable automatically once recording is safely saved.",
      status: `Waiting for ${pending} recording${pending === 1 ? "" : "s"} to finish saving.`,
    };
  }
  if (state.timeline.segments.length) {
    return {
      state: "empty",
      title: "No clip selected",
      text: "Choose a colored marker from the timeline below to load a recording.",
      status: "No markers for this day yet, but recorded video is available.",
    };
  }
  return {
    state: "empty",
    title: "No clip selected",
    text: "Choose a colored marker from the timeline below to load a recording.",
    status: "No recorded video available for this day.",
  };
}

function renderPlaybackEmptyState() {
  const emptyState = timelineEmptyState();
  stopPlaybackCursorLoop();
  stopReversePlayback();
  stopSimulatedForwardPlayback();
  setPlaybackCursor(null);
  updatePlaybackHeader(null);
  showVideoEmpty(emptyState.title, emptyState.text, { state: emptyState.state });
  syncPlaybackTransport();
  setStatus(emptyState.status);
}

async function selectEvent(eventId, options = {}) {
  let event = state.timeline.events.find((item) => item.id === eventId);
  if (!event) return;

  try {
    const refreshed = await refreshEventFromServer(eventId);
    if (refreshed) event = refreshed;
  } catch {}

  if (!eventIsReady(event) && options.allowPending !== true) {
    renderTimeline();
    renderPlaybackEmptyState();
    scheduleTimelineAutoRefresh();
    return;
  }

  clearForwardPlaybackBoundarySchedule();
  const range = dayRange(event.clip_start, event.clip_end);
  if (options.ensureVisible !== false) ensureTimelineRangeVisible(range.startMinute, range.endMinute);

  const seekSeconds = clamp(Number(options.seekSeconds) || 0, 0, eventDurationSeconds(event));
  const shouldAutoplay = options.autoplay !== false;

  if (event.device_id && !state.activeDeviceIds.includes(event.device_id)) {
    await setActiveDeviceIds([...state.activeDeviceIds, event.device_id], { reloadTimeline: false });
  }

  const wasSameEvent = state.selectedEventId === eventId;
  state.selectedEventId = eventId;
  renderTimeline();
  updatePlaybackHeader(event);
  syncPlaybackTransport();
  stopPlaybackCursorLoop();
  stopReversePlayback();
  stopSimulatedForwardPlayback();
  setPlaybackCursor({
    minute: range.startMinute + (seekSeconds / 60),
    label: clockLabel(Date.parse(event.clip_start) + (seekSeconds * 1000)),
  });
  schedulePlaybackStateSave();

  hideVideoEmpty();

  if (!wasSameEvent || ![...tiles.values()].some((t) => t.video.currentSrc)) {
    setStatus(`Loading ${event.title}…`);
    reloadAllTileSourcesForEvent(event);
  }

  await seekAllTilesToSeconds(seekSeconds);

  if (!shouldAutoplay) {
    pauseCurrentPlayback();
    setStatus(`Loaded ${event.title}.`);
    return;
  }

  const started = await startConfiguredPlayback(event);
  setStatus(started ? playbackStatusText(event, true) : `Loaded ${event.title}. Click play if playback does not start automatically.`);
}

async function loadTimeline(options = {}) {
  const background = options.background === true;
  const preservePlayback = options.preservePlayback === true;
  const autoSelectLatest = options.autoSelectLatest !== false;

  clearForwardPlaybackBoundarySchedule();
  clearTimelineAutoRefresh();

  if (!state.activeDeviceIds.length) {
    state.timeline = { segments: [], events: [] };
    state.selectedEventId = null;
    stopPlaybackCursorLoop();
    stopReversePlayback();
    stopSimulatedForwardPlayback();
    setPlaybackCursor(null);
    updatePlaybackHeader(null);
    showVideoEmpty(
      "Select a camera",
      "Choose one or more cameras from the sidebar to load recorded clips.",
      { state: "empty", badge: "Camera" },
    );
    renderTimeline();
    syncPlaybackTransport();
    setStatus("Select cameras to see recordings.");
    savePlaybackStateNow();
    return;
  }

  const currentSelectedEventId = state.selectedEventId;
  const preserveCurrentPlayback = background && preservePlayback && !!currentSelectedEventId;

  if (!background) {
    setPlaybackCursor(null);
    updatePlaybackHeader(null);
    showVideoEmpty("Loading playback...", "Fetching recorded clips for the selected cameras and day.", { state: "loading" });
    setStatus("Loading timeline…");
  }

  const requestId = ++state.persistence.timelineRequestId;
  const day = state.selectedDay || todayString();
  const payloads = await Promise.all(state.activeDeviceIds.map((id) =>
    fetchTimelineForDevice(id, day).catch(() => null),
  ));
  if (requestId !== state.persistence.timelineRequestId) return;

  const restore = background ? null : loadStoredPlaybackState();
  applyTimelineData(mergeTimelines(payloads), {
    hiddenPresetKeys: Array.isArray(restore?.hiddenPresetKeys) ? restore.hiddenPresetKeys : state.timelineFilters.hiddenPresetKeys,
  });

  if (!background) {
    const restoreStartMinute = Number(restore?.timelineView?.startMinute);
    const restoreDurationMinutes = Number(restore?.timelineView?.durationMinutes);
    if (Number.isFinite(restoreStartMinute) && Number.isFinite(restoreDurationMinutes)) {
      setTimelineViewport(restoreStartMinute, restoreDurationMinutes, { render: false, persist: false });
    }
  }

  const restoreEventId = !background && typeof restore?.selectedEventId === "string" && restore.selectedEventId
    ? restore.selectedEventId
    : null;
  const restoreSeekSeconds = !background ? Number(restore?.seekSeconds) : Number.NaN;
  const nextSelectedEvent = syncTimelineSelection({
    preferredEventId: restoreEventId || currentSelectedEventId,
    autoSelectLatest,
  });

  renderTimeline();

  if (preserveCurrentPlayback && nextSelectedEvent && nextSelectedEvent.id === currentSelectedEventId) {
    updatePlaybackHeader(nextSelectedEvent);
    syncPlaybackTransport();
    updatePlaybackCursorFromVideo();
  } else if (nextSelectedEvent) {
    const shouldRestoreSeek = restoreEventId === nextSelectedEvent.id && Number.isFinite(restoreSeekSeconds) && restoreSeekSeconds >= 0;
    await selectEvent(
      nextSelectedEvent.id,
      shouldRestoreSeek
        ? { seekSeconds: restoreSeekSeconds, autoplay: false, ensureVisible: false }
        : undefined,
    );
  } else {
    renderPlaybackEmptyState();
  }

  schedulePlaybackStateSave();
  scheduleTimelineAutoRefresh();
}

async function refreshAll() {
  try {
    await loadDevices();
    syncTilesToActive();
    await loadTimeline();
  } catch (error) {
    showVideoEmpty("Playback unavailable", "Playback data could not be loaded right now. Try again in a moment.", { state: "error" });
    setStatus(error.message || String(error));
  }
}

// ── UI bindings ───────────────────────────────────────────────────────

function bindUi() {
  const saved = loadStoredPlaybackState();

  const savedActive = Array.isArray(saved?.activeDeviceIds)
    ? saved.activeDeviceIds.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  state.activeDeviceIds = savedActive;
  state.selectedDay = normalizeStoredDay(saved?.selectedDay);
  state.selectedEventId = typeof saved?.selectedEventId === "string" && saved.selectedEventId ? saved.selectedEventId : null;
  state.timelineFilters.hiddenPresetKeys = Array.isArray(saved?.hiddenPresetKeys)
    ? saved.hiddenPresetKeys.map((value) => String(value || "").trim()).filter(Boolean)
    : [];

  const dayInput = el("playbackDayInput");
  if (dayInput) dayInput.value = state.selectedDay;

  const savedStartMinute = Number(saved?.timelineView?.startMinute);
  const savedDurationMinutes = Number(saved?.timelineView?.durationMinutes);
  if (Number.isFinite(savedStartMinute) && Number.isFinite(savedDurationMinutes)) {
    setTimelineViewport(savedStartMinute, savedDurationMinutes, { render: false, persist: false });
  }

  bindTimelineInteractions();
  renderTimeline();

  el("playbackSidebarList")?.addEventListener("click", async (event) => {
    const row = event.target instanceof Element ? event.target.closest(".liveSidebarRow[data-id]") : null;
    if (!row) return;
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

  el("playbackDayInput")?.addEventListener("change", async (event) => {
    state.selectedDay = event.target.value || todayString();
    state.selectedEventId = null;
    savePlaybackStateNow();
    await loadTimeline();
  });

  el("playbackPlayPauseBtn")?.addEventListener("click", async () => { await togglePlayback(); });
  el("playbackStopBtn")?.addEventListener("click", async () => { await stopPlayback(); });

  el("playbackShuttleInput")?.addEventListener("pointerdown", () => {
    cancelShuttleAnim();
    _shuttleDragging = true;
  });
  el("playbackShuttleInput")?.addEventListener("input", (event) => {
    const input = event.target;
    const rawPos = Number(input.value) || 0;
    const rawValue = shuttlePosToValue(rawPos);
    const snappedValue = applyShuttleSnap(rawValue);
    const effectivePos = shuttleValueToPos(snappedValue);
    input.value = String(effectivePos);
    updateShuttleFillFromPos(effectivePos);
    setShuttle(snappedValue);
  });
  const _shuttleRelease = () => {
    _shuttleDragging = false;
    resetShuttleToRest();
  };
  el("playbackShuttleInput")?.addEventListener("pointerup", _shuttleRelease);
  el("playbackShuttleInput")?.addEventListener("pointercancel", _shuttleRelease);
  el("playbackShuttleInput")?.addEventListener("blur", _shuttleRelease);
  el("playbackShuttleInput")?.addEventListener("keyup", (event) => {
    if (event.key === "Enter" || event.key === "Escape") _shuttleRelease();
  });

  el("playbackTimelineFilters")?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-preset-key]") : null;
    if (!target) return;
    const key = target.getAttribute("data-preset-key");
    if (key) toggleTimelinePresetKey(key);
  });

  window.addEventListener("pagehide", () => {
    clearTimelineAutoRefresh();
    savePlaybackStateNow();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      loadTimeline({ background: true, preservePlayback: true, autoSelectLatest: false }).catch((error) => {
        setStatus(error.message || String(error));
      });
      return;
    }
    scheduleTimelineAutoRefresh();
  });

  window.addEventListener("resize", () => requestAnimationFrame(recomputeGrid));

  syncPlaybackTransport();
}

function bindTimelineInteractions() {
  const track = el("playbackTimelineTrack");
  if (!track) return;

  track.addEventListener("wheel", (event) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    event.preventDefault();
    const duration = currentTimelineDuration();
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.2) {
      const deltaMinutes = (event.deltaX / rect.width) * duration;
      setTimelineViewport(state.timelineView.startMinute + deltaMinutes, duration);
      return;
    }
    const pointerRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const focusMinute = state.timelineView.startMinute + (pointerRatio * duration);
    const nextDuration = clamp(duration * Math.exp(event.deltaY * 0.0025), MIN_VISIBLE_MINUTES, DAY_MINUTES);
    const nextStart = focusMinute - (pointerRatio * nextDuration);
    setTimelineViewport(nextStart, nextDuration);
  }, { passive: false });

  track.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-event-id]") || target?.closest("[data-playback-track-base]")) return;
    state.timelineView.pointerId = event.pointerId;
    state.timelineView.dragOriginX = event.clientX;
    state.timelineView.dragOriginStartMinute = state.timelineView.startMinute;
    state.timelineView.dragOriginDuration = currentTimelineDuration();
    state.timelineView.isDragging = false;
    track.setPointerCapture(event.pointerId);
  });

  track.addEventListener("pointermove", (event) => {
    if (event.pointerId !== state.timelineView.pointerId) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    const deltaX = event.clientX - state.timelineView.dragOriginX;
    if (!state.timelineView.isDragging && Math.abs(deltaX) < PAN_DRAG_THRESHOLD_PX) return;
    state.timelineView.isDragging = true;
    track.classList.add("is-dragging");
    const deltaMinutes = (deltaX / rect.width) * state.timelineView.dragOriginDuration;
    setTimelineViewport(state.timelineView.dragOriginStartMinute - deltaMinutes, state.timelineView.dragOriginDuration);
  });

  const finishDrag = (event) => {
    if (event.pointerId !== state.timelineView.pointerId) return;
    if (state.timelineView.isDragging) {
      state.timelineView.suppressClickUntil = Date.now() + CLICK_SUPPRESSION_MS;
    }
    state.timelineView.pointerId = null;
    state.timelineView.isDragging = false;
    track.classList.remove("is-dragging");
    if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
  };

  track.addEventListener("pointerup", finishDrag);
  track.addEventListener("pointercancel", finishDrag);

  track.addEventListener("click", async (event) => {
    if (!shouldSuppressTimelineClick()) {
      const trackRect = track.getBoundingClientRect();
      const minute = timelineMinuteFromClientX(event.clientX, trackRect);
      const target = event.target instanceof Element ? event.target.closest("[data-event-id]") : null;
      const base = event.target instanceof Element ? event.target.closest("[data-playback-track-base]") : null;

      if (target) {
        const targetEvent = state.timeline.events.find((item) => item.id === target.dataset.eventId) || null;
        if (!targetEvent) return;
        if (!eventIsReady(targetEvent)) {
          setStatus(
            eventState(targetEvent) === "missing"
              ? `${targetEvent.title} is unavailable because recorded video does not cover that time range.`
              : `${targetEvent.title} is still being finalized.`
          );
          return;
        }
        const seekSeconds = eventSeekSecondsForMinute(targetEvent, minute);
        await selectEvent(targetEvent.id, { seekSeconds, autoplay: true });
        return;
      }

      if (!base) return;

      const selection = timelineBaseSelection(minute);
      if (!selection?.event) {
        setStatus("No recording starts at or after this point.");
        return;
      }
      await selectEvent(selection.event.id, { seekSeconds: selection.seekSeconds, autoplay: true });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

bindUi();
refreshAll();
