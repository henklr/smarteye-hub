const el = (id) => document.getElementById(id);

const DAY_MINUTES = 24 * 60;
const MIN_VISIBLE_MINUTES = 5;
const CLICK_SUPPRESSION_MS = 250;
const PAN_DRAG_THRESHOLD_PX = 6;
const MAX_NATIVE_PLAYBACK_RATE = 16;
const PLAYBACK_STORAGE_KEY = "sei.playback.timelineState";
const PLAYBACK_STATE_VERSION = 1;
const PLAYBACK_STATE_SAVE_DELAY_MS = 400;
const PENDING_TIMELINE_POLL_MS = 5000;

const state = {
  devices: [],
  selectedDeviceId: "",
  selectedDay: "",
  timeline: { segments: [], events: [] },
  transport: {
    speed: 1,
    direction: "forward",
    advancingToNextClip: false,
    forwardBoundaryTimer: 0,
    forwardPlayback: {
      active: false,
      rafId: 0,
      lastTs: 0,
    },
    reversePlayback: {
      active: false,
      rafId: 0,
      lastTs: 0,
    },
  },
  playbackCursor: {
    minute: null,
    label: "",
    rafId: 0,
  },
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
    pendingRefreshTimer: 0,
  },
};

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

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

function setStatus(message) {
  const node = el("playbackStatus");
  if (node) node.textContent = message || "";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizePlaybackSpeed(value) {
  return clamp(Number(value) || 1, 0.25, 25);
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

function reversePlaybackState() {
  return state.transport.reversePlayback;
}

function forwardPlaybackState() {
  return state.transport.forwardPlayback;
}

function isReverseDirection() {
  return playbackDirectionLabel() === "backward";
}

function isReversePlaybackActive() {
  return !!reversePlaybackState().active;
}

function shouldSimulateForwardPlayback(speed = state.transport.speed, direction = state.transport.direction) {
  return normalizePlaybackDirection(direction) !== "backward" && normalizePlaybackSpeed(speed) > MAX_NATIVE_PLAYBACK_RATE;
}

function isSimulatedForwardPlaybackActive() {
  return !!forwardPlaybackState().active;
}

function playbackTransportIcon(icon) {
  const icons = {
    play: '<span class="playbackTransportGlyph" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M8 6.5V17.5L17 12L8 6.5Z"></path></svg></span>',
    pause: '<span class="playbackTransportGlyph" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><rect x="6.5" y="6" width="4" height="12" rx="1"></rect><rect x="13.5" y="6" width="4" height="12" rx="1"></rect></svg></span>',
  };

  return icons[icon] || icons.play;
}

function showVideoEmpty(title, text) {
  const video = el("playbackVideo");
  const empty = el("playbackVideoEmpty");
  const emptyText = el("playbackVideoEmptyText");
  const titleNode = empty?.querySelector(".playbackVideoEmptyTitle");

  stopPlaybackCursorLoop();
  stopSimulatedForwardPlayback();
  stopReversePlayback();

  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.classList.add("hidden");
  }

  if (titleNode) titleNode.textContent = title || "No clip selected";
  if (emptyText) emptyText.textContent = text || "Choose a colored marker from the timeline below to load a recording.";
  empty?.classList.remove("hidden");
  syncPlaybackTransport();
}

function todayString() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeStoredDay(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : todayString();
}

function loadStoredPlaybackState() {
  try {
    const raw = window.localStorage.getItem(PLAYBACK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (Number(parsed.version || 0) !== PLAYBACK_STATE_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function snapshotPlaybackState() {
  const event = selectedEvent();
  const video = el("playbackVideo");
  const seekSeconds = event
    ? clamp(Number.isFinite(video?.currentTime) ? video.currentTime : 0, 0, eventDurationSeconds(event))
    : 0;

  return {
    version: PLAYBACK_STATE_VERSION,
    selectedDeviceId: String(state.selectedDeviceId || "").trim(),
    selectedDay: normalizeStoredDay(state.selectedDay),
    selectedEventId: typeof state.selectedEventId === "string" && state.selectedEventId ? state.selectedEventId : null,
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
  } catch {
    // Ignore storage failures; playback should continue working without persistence.
  }
}

function schedulePlaybackStateSave(delay = PLAYBACK_STATE_SAVE_DELAY_MS) {
  if (state.persistence.saveTimer) {
    return;
  }

  state.persistence.saveTimer = window.setTimeout(() => {
    state.persistence.saveTimer = 0;
    savePlaybackStateNow();
  }, delay);
}

function playbackRestoreState() {
  const saved = loadStoredPlaybackState();
  if (!saved) {
    return null;
  }

  const savedDeviceId = String(saved.selectedDeviceId || "").trim();
  const savedDay = normalizeStoredDay(saved.selectedDay);
  if (savedDeviceId !== String(state.selectedDeviceId || "").trim() || savedDay !== normalizeStoredDay(state.selectedDay)) {
    return null;
  }

  return saved;
}

function clockLabel(value) {
  try {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      return String(value || "");
    }

    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}`;
  } catch {
    return String(value || "");
  }
}

function deviceName(deviceId) {
  return state.devices.find((item) => item.id === deviceId)?.name || deviceId || "camera";
}

function eventState(event) {
  return String(event?.state || "ready").trim().toLowerCase() || "ready";
}

function eventIsReady(event) {
  return eventState(event) === "ready";
}

function eventIsPending(event) {
  return !eventIsReady(event);
}

function pendingEventCount() {
  return state.timeline.events.filter((event) => eventIsPending(event)).length;
}

function eventStateLabel(event) {
  const value = eventState(event);
  if (value === "recording") return "Recording";
  if (value === "finalizing") return "Saving";
  if (value === "missing") return "Unavailable";
  return "Ready";
}

function clearPendingTimelineRefresh() {
  if (state.persistence.pendingRefreshTimer) {
    window.clearTimeout(state.persistence.pendingRefreshTimer);
    state.persistence.pendingRefreshTimer = 0;
  }
}

function schedulePendingTimelineRefresh() {
  clearPendingTimelineRefresh();
  if (!pendingEventCount()) {
    return;
  }

  state.persistence.pendingRefreshTimer = window.setTimeout(() => {
    state.persistence.pendingRefreshTimer = 0;
    loadTimeline().catch((error) => {
      setStatus(error.message || String(error));
    });
  }, PENDING_TIMELINE_POLL_MS);
}

function minutesIntoDay(value) {
  const date = new Date(value);
  return (date.getUTCHours() * 60) + date.getUTCMinutes() + (date.getUTCSeconds() / 60);
}

function minuteLabel(totalMinutes) {
  const rounded = Math.round(totalMinutes);
  if (rounded >= DAY_MINUTES) {
    return "24:00";
  }

  const safe = clamp(rounded, 0, DAY_MINUTES - 1);
  const hours = String(Math.floor(safe / 60)).padStart(2, "0");
  const minutes = String(safe % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function dayRange(startedAt, endedAt = startedAt) {
  const safeEnd = endedAt || startedAt;
  const startMinute = clamp(minutesIntoDay(startedAt), 0, DAY_MINUTES);
  const endCandidate = clamp(minutesIntoDay(safeEnd), 0, DAY_MINUTES);
  const endMinute = endCandidate < startMinute ? DAY_MINUTES : endCandidate;

  return {
    startMinute,
    endMinute: Math.max(startMinute, endMinute),
  };
}

function currentTimelineDuration() {
  return state.timelineView.endMinute - state.timelineView.startMinute;
}

function selectedEvent() {
  return state.timeline.events.find((item) => item.id === state.selectedEventId) || null;
}

function eventRange(event) {
  return dayRange(event?.clip_start, event?.clip_end);
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

function normalizeEventPresetColor(value) {
  const raw = String(value || "#c6a14b").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : "#c6a14b";
}

function eventPresetName(event) {
  return String(event?.preset_name || event?.title || "Recording").trim() || "Recording";
}

function eventPresetKey(event) {
  const explicit = String(event?.preset_key || "").trim();
  if (explicit) {
    return explicit;
  }
  return eventPresetName(event).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "recording";
}

function eventTagSegments(event) {
  const raw = Array.isArray(event?.tag_segments) ? event.tag_segments : [];
  const normalized = raw.map((segment) => {
    const clipStart = segment?.clip_start || event?.clip_start || null;
    const clipEnd = segment?.clip_end || event?.clip_end || null;
    if (!clipStart || !clipEnd) {
      return null;
    }
    return {
      eventId: String(event?.id || "").trim(),
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

  if (normalized.length) {
    return normalized;
  }

  if (!event?.clip_start || !event?.clip_end) {
    return [];
  }

  return [{
    eventId: String(event?.id || "").trim(),
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
        rows.set(key, {
          key,
          name: segment.presetName,
          color: segment.color,
          events: [],
        });
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

function timelineMinuteFromClientX(clientX, rect) {
  const width = rect?.width || 0;
  if (!width) {
    return state.timelineView.startMinute;
  }

  const ratio = clamp((clientX - rect.left) / width, 0, 1);
  return state.timelineView.startMinute + (ratio * currentTimelineDuration());
}

function eventAtTimelineMinute(minute) {
  const selected = selectedEvent();
  if (selected && eventIsReady(selected)) {
    const range = eventRange(selected);
    if (minute >= range.startMinute && minute <= range.endMinute) {
      return selected;
    }
  }

  return state.timeline.events.find((event) => {
    if (!eventIsReady(event)) {
      return false;
    }
    const range = eventRange(event);
    return minute >= range.startMinute && minute <= range.endMinute;
  }) || null;
}

function nextEventAtTimelineMinute(minute) {
  return state.timeline.events.find((event) => eventIsReady(event) && eventRange(event).startMinute >= minute) || null;
}

function timelineBaseSelection(minute) {
  const exactEvent = eventAtTimelineMinute(minute);
  if (exactEvent) {
    return {
      event: exactEvent,
      seekSeconds: eventSeekSecondsForMinute(exactEvent, minute),
    };
  }

  const nextEvent = nextEventAtTimelineMinute(minute);
  if (nextEvent) {
    return {
      event: nextEvent,
      seekSeconds: 0,
    };
  }

  return null;
}

function nextTimelineEvent(currentEventId) {
  const currentIndex = state.timeline.events.findIndex((event) => event.id === currentEventId);
  if (currentIndex < 0) {
    return null;
  }

  return state.timeline.events.slice(currentIndex + 1).find((event) => eventIsReady(event)) || null;
}

function previousTimelineEvent(currentEventId) {
  const currentIndex = state.timeline.events.findIndex((event) => event.id === currentEventId);
  if (currentIndex <= 0) {
    return null;
  }

  return [...state.timeline.events.slice(0, currentIndex)].reverse().find((event) => eventIsReady(event)) || null;
}

function eventSeekSecondsForMinute(event, minute) {
  const range = eventRange(event);
  const durationSeconds = eventDurationSeconds(event);
  if (durationSeconds <= 0) {
    return 0;
  }

  return clamp((minute - range.startMinute) * 60, 0, durationSeconds);
}

async function seekVideoToSeconds(video, seconds) {
  const target = Math.max(0, Number(seconds) || 0);

  if (video.readyState >= 1) {
    video.currentTime = target;
    return;
  }

  await new Promise((resolve) => {
    const applySeek = () => {
      video.currentTime = target;
      resolve();
    };

    video.addEventListener("loadedmetadata", applySeek, { once: true });
  });
}

function playbackDurationSeconds(video, event = selectedEvent()) {
  if (Number.isFinite(video?.duration) && video.duration > 0) {
    return video.duration;
  }

  return eventDurationSeconds(event);
}

function playbackResetSeconds(video, event = selectedEvent()) {
  return isReverseDirection() ? playbackDurationSeconds(video, event) : 0;
}

function isPlaybackRunning(video = el("playbackVideo")) {
  if (!selectedEvent()) {
    return false;
  }

  if (isReverseDirection()) {
    return isReversePlaybackActive();
  }

  if (isSimulatedForwardPlaybackActive()) {
    return true;
  }

  return !!(video && video.currentSrc && !video.paused && !video.ended);
}

function syncPlaybackTransport() {
  const video = el("playbackVideo");
  const playPauseBtn = el("playbackPlayPauseBtn");
  const stopBtn = el("playbackStopBtn");
  const backwardBtn = el("playbackDirectionBackwardBtn");
  const forwardBtn = el("playbackDirectionForwardBtn");
  const speedInput = el("playbackSpeedInput");
  const speedValue = el("playbackSpeedValue");
  const hasEvent = !!selectedEvent();
  const running = isPlaybackRunning(video);

  if (playPauseBtn) {
    playPauseBtn.innerHTML = playbackTransportIcon(running ? "pause" : "play");
    playPauseBtn.setAttribute("aria-label", running ? "Pause" : "Play");
    playPauseBtn.title = running ? "Pause" : "Play";
    playPauseBtn.disabled = !hasEvent;
  }

  if (stopBtn) {
    stopBtn.setAttribute("aria-label", "Stop");
    stopBtn.title = "Stop";
    stopBtn.disabled = !hasEvent;
  }

  if (backwardBtn) {
    backwardBtn.disabled = !hasEvent;
    backwardBtn.classList.toggle("is-active", isReverseDirection());
    backwardBtn.setAttribute("aria-pressed", isReverseDirection() ? "true" : "false");
    backwardBtn.setAttribute("aria-label", "Backward");
    backwardBtn.title = "Backward";
  }

  if (forwardBtn) {
    forwardBtn.disabled = !hasEvent;
    forwardBtn.classList.toggle("is-active", !isReverseDirection());
    forwardBtn.setAttribute("aria-pressed", !isReverseDirection() ? "true" : "false");
    forwardBtn.setAttribute("aria-label", "Forward");
    forwardBtn.title = "Forward";
  }

  if (speedInput) {
    speedInput.value = String(normalizePlaybackSpeed(state.transport.speed));
  }

  if (speedValue) {
    speedValue.value = formatPlaybackSpeed(state.transport.speed);
    speedValue.textContent = formatPlaybackSpeed(state.transport.speed);
  }

  if (video) {
    const speed = normalizePlaybackSpeed(state.transport.speed);
    const nativeSpeed = shouldSimulateForwardPlayback(speed, state.transport.direction)
      ? MAX_NATIVE_PLAYBACK_RATE
      : speed;
    video.playbackRate = nativeSpeed;
    video.defaultPlaybackRate = nativeSpeed;
  }
}

function stopSimulatedForwardPlayback() {
  const forward = forwardPlaybackState();
  forward.active = false;
  forward.lastTs = 0;

  if (forward.rafId) {
    cancelAnimationFrame(forward.rafId);
    forward.rafId = 0;
  }
}

function stopReversePlayback() {
  const reverse = reversePlaybackState();
  reverse.active = false;
  reverse.lastTs = 0;

  if (reverse.rafId) {
    cancelAnimationFrame(reverse.rafId);
    reverse.rafId = 0;
  }
}

function pauseCurrentPlayback() {
  const video = el("playbackVideo");
  clearForwardPlaybackBoundarySchedule();
  stopSimulatedForwardPlayback();
  stopReversePlayback();
  stopPlaybackCursorLoop();
  state.transport.advancingToNextClip = false;

  if (video && !video.paused) {
    video.pause();
  }

  updatePlaybackCursorFromVideo();
  syncPlaybackTransport();
}

async function handleReversePlaybackBoundary(event) {
  const video = el("playbackVideo");
  if (!event) {
    syncPlaybackTransport();
    return;
  }

  const previousEvent = previousTimelineEvent(event.id);
  if (!previousEvent) {
    if (video) {
      await seekVideoToSeconds(video, 0);
      updatePlaybackCursorFromVideo();
    }
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
    const video = el("playbackVideo");
    stopPlaybackCursorLoop();
    stopSimulatedForwardPlayback();
    stopReversePlayback();
    if (video && !video.paused) {
      video.pause();
    }
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
  if (!video || !event || isReverseDirection() || state.transport.advancingToNextClip) {
    return false;
  }

  const duration = playbackDurationSeconds(video, event);
  if (!(Number.isFinite(duration) && duration > 0)) {
    return false;
  }

  return (Number(video.currentTime) || 0) >= Math.max(0, duration - 0.05);
}

function queueForwardPlaybackBoundaryCheck(event = selectedEvent()) {
  const video = el("playbackVideo");
  if (!playbackReachedEnd(video, event)) {
    return;
  }

  if (state.transport.forwardBoundaryTimer) {
    return;
  }

  state.transport.forwardBoundaryTimer = window.setTimeout(() => {
    state.transport.forwardBoundaryTimer = 0;
    handleForwardPlaybackBoundary(event).catch((error) => {
      setStatus(error.message || String(error));
    });
  }, 0);
}

async function startReversePlayback(video, event) {
  if (!video || !event) {
    return false;
  }

  stopPlaybackCursorLoop();
  stopSimulatedForwardPlayback();
  stopReversePlayback();
  video.pause();

  if (video.currentTime <= 0.05) {
    await seekVideoToSeconds(video, playbackDurationSeconds(video, event));
  }

  const reverse = reversePlaybackState();
  reverse.active = true;
  reverse.lastTs = 0;
  syncPlaybackTransport();

  const tick = (timestamp) => {
    if (!reverse.active) {
      reverse.rafId = 0;
      return;
    }

    if (!reverse.lastTs) {
      reverse.lastTs = timestamp;
    }

    const elapsedSeconds = clamp((timestamp - reverse.lastTs) / 1000, 0, 0.25);
    reverse.lastTs = timestamp;

    const nextTime = Math.max(0, (Number(video.currentTime) || 0) - (elapsedSeconds * normalizePlaybackSpeed(state.transport.speed)));
    video.currentTime = nextTime;
    updatePlaybackCursorFromVideo();

    if (nextTime <= 0.001) {
      stopReversePlayback();
      syncPlaybackTransport();
      handleReversePlaybackBoundary(event).catch((error) => {
        setStatus(error.message || String(error));
      });
      return;
    }

    reverse.rafId = requestAnimationFrame(tick);
  };

  reverse.rafId = requestAnimationFrame(tick);
  return true;
}

async function startSimulatedForwardPlayback(video, event) {
  if (!video || !event) {
    return false;
  }

  clearForwardPlaybackBoundarySchedule();
  stopPlaybackCursorLoop();
  stopSimulatedForwardPlayback();
  stopReversePlayback();
  video.pause();

  const forward = forwardPlaybackState();
  forward.active = true;
  forward.lastTs = 0;
  syncPlaybackTransport();

  const tick = (timestamp) => {
    if (!forward.active || state.selectedEventId !== event.id) {
      forward.rafId = 0;
      return;
    }

    if (!forward.lastTs) {
      forward.lastTs = timestamp;
    }

    const duration = playbackDurationSeconds(video, event);
    if (!(Number.isFinite(duration) && duration > 0)) {
      stopSimulatedForwardPlayback();
      syncPlaybackTransport();
      return;
    }

    const elapsedSeconds = clamp((timestamp - forward.lastTs) / 1000, 0, 0.25);
    forward.lastTs = timestamp;

    const nextTime = Math.min(
      duration,
      (Number(video.currentTime) || 0) + (elapsedSeconds * normalizePlaybackSpeed(state.transport.speed))
    );

    video.currentTime = nextTime;
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

async function startConfiguredPlayback(video, event) {
  if (!video || !event) {
    return false;
  }

  if (isReverseDirection()) {
    return await startReversePlayback(video, event);
  }

  if (shouldSimulateForwardPlayback()) {
    const started = await startSimulatedForwardPlayback(video, event);
    syncPlaybackTransport();
    return started;
  }

  stopSimulatedForwardPlayback();
  stopReversePlayback();
  video.playbackRate = normalizePlaybackSpeed(state.transport.speed);
  video.defaultPlaybackRate = normalizePlaybackSpeed(state.transport.speed);
  const started = await startVideoPlayback(video);
  syncPlaybackTransport();
  return started;
}

function playbackStatusText(event, started) {
  if (!event) {
    return started ? "Playing." : "Loaded.";
  }

  if (!started) {
    return `Loaded ${event.title}.`;
  }

  return `Playing ${event.title} ${playbackDirectionLabel()} at ${formatPlaybackSpeed(state.transport.speed)}.`;
}

function setPlaybackSpeed(value) {
  const video = el("playbackVideo");
  const event = selectedEvent();
  const previousSpeed = state.transport.speed;
  const wasRunning = isPlaybackRunning(video);

  state.transport.speed = normalizePlaybackSpeed(value);
  syncPlaybackTransport();

  const crossedNativeLimit = !isReverseDirection()
    && shouldSimulateForwardPlayback(previousSpeed) !== shouldSimulateForwardPlayback(state.transport.speed);

  if (event && video && wasRunning && crossedNativeLimit) {
    startConfiguredPlayback(video, event)
      .then((started) => {
        setStatus(playbackStatusText(event, started));
      })
      .catch((error) => {
        setStatus(error.message || String(error));
      });
    return;
  }

  if (event && wasRunning) {
    setStatus(`Playing ${event.title} ${playbackDirectionLabel()} at ${formatPlaybackSpeed(state.transport.speed)}.`);
  }
}

function resetPlaybackSpeed() {
  if (Math.abs(normalizePlaybackSpeed(state.transport.speed) - 1) < 0.001) {
    syncPlaybackTransport();
    return;
  }

  setPlaybackSpeed(1);
}

async function setPlaybackDirection(direction) {
  const nextDirection = normalizePlaybackDirection(direction);
  const currentDirection = playbackDirectionLabel();
  const video = el("playbackVideo");
  const event = selectedEvent();
  const wasRunning = isPlaybackRunning(video);

  if (nextDirection === currentDirection) {
    syncPlaybackTransport();
    return;
  }

  state.transport.direction = nextDirection;
  syncPlaybackTransport();

  if (video && event && nextDirection === "backward" && video.currentSrc && video.currentTime <= 0.05) {
    await seekVideoToSeconds(video, playbackDurationSeconds(video, event));
  }

  if (wasRunning && video && event) {
    const started = await startConfiguredPlayback(video, event);
    setStatus(playbackStatusText(event, started));
    return;
  }

  if (event) {
    updatePlaybackCursorFromVideo();
    setStatus(`Playback direction set to ${nextDirection}.`);
  }
}

async function togglePlayback() {
  const video = el("playbackVideo");
  const event = selectedEvent();

  if (!video || !event) {
    return;
  }

  if (isPlaybackRunning(video)) {
    pauseCurrentPlayback();
    setStatus(`Paused ${event.title}.`);
    return;
  }

  if (!video.currentSrc) {
    await selectEvent(event.id, {
      seekSeconds: playbackResetSeconds(video, event),
      autoplay: true,
    });
    return;
  }

  const started = await startConfiguredPlayback(video, event);
  setStatus(playbackStatusText(event, started));
}

async function stopPlayback() {
  const video = el("playbackVideo");
  const event = selectedEvent();

  if (!event) {
    return;
  }

  if (!video || !video.currentSrc) {
    await selectEvent(event.id, {
      seekSeconds: playbackResetSeconds(video, event),
      autoplay: false,
    });
    return;
  }

  pauseCurrentPlayback();
  await seekVideoToSeconds(video, playbackResetSeconds(video, event));
  updatePlaybackCursorFromVideo();
  syncPlaybackTransport();
  setStatus(`Stopped ${event.title}.`);
}

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

  if (changed && options.render !== false) {
    renderTimeline();
  }

  if (changed && options.persist !== false) {
    schedulePlaybackStateSave();
  }
}

function ensureTimelineRangeVisible(startMinute, endMinute) {
  const duration = currentTimelineDuration();
  const padding = Math.max(duration * 0.12, 2);
  const inView = startMinute >= (state.timelineView.startMinute + padding)
    && endMinute <= (state.timelineView.endMinute - padding);

  if (inView) {
    return;
  }

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
  if (!event) {
    return null;
  }

  const video = el("playbackVideo");
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

    const video = el("playbackVideo");
    if (video && !video.paused && !video.ended) {
      state.playbackCursor.rafId = requestAnimationFrame(tick);
      return;
    }

    state.playbackCursor.rafId = 0;
  };

  tick();
}

function renderDeviceOptions() {
  const select = el("playbackDeviceSelect");
  if (!select) return;

  const configured = state.devices.filter((device) => device.profile_token);
  select.innerHTML = configured.length
    ? configured.map((device) => `<option value="${escapeHtml(device.id)}" ${device.id === state.selectedDeviceId ? "selected" : ""}>${escapeHtml(device.name)}</option>`).join("")
    : `<option value="">No configured cameras</option>`;

  select.disabled = configured.length === 0;
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

  renderTimelineScale();

  const { tickMinutes } = timelineTickLayout();
  const rows = timelinePresetRows();

  track.innerHTML = `
    ${tickMinutes.map((minute) => `<span class="playbackTimelineGuide" style="left:${visibleTimelinePercent(minute)}%;" aria-hidden="true"></span>`).join("")}
    <div class="playbackTimelineRows">
      ${rows.length ? rows.map((row) => `
        <div class="playbackTimelineLane" data-preset-key="${escapeHtml(row.key)}">
          <div class="playbackTimelineLaneHeader">
            <span class="playbackTimelineLaneSwatch" style="background:${escapeHtml(row.color)};"></span>
            <span class="playbackTimelineLaneLabel">${escapeHtml(row.name)}</span>
          </div>
          <div class="playbackTimelineBase" data-playback-track-base></div>
          ${row.events.map((segment) => {
            const range = dayRange(segment.clip_start, segment.clip_end);
            if (!isVisibleRange(range.startMinute, range.endMinute)) {
              return "";
            }

            const clippedStart = clamp(range.startMinute, state.timelineView.startMinute, state.timelineView.endMinute);
            const clippedEnd = clamp(range.endMinute, state.timelineView.startMinute, state.timelineView.endMinute);
            const left = visibleTimelinePercent(clippedStart);
            const width = visibleTimelineWidth(clippedStart, clippedEnd);
            const active = segment.eventId === state.selectedEventId ? "is-active" : "";
            const pending = !segment.ready ? `is-pending is-${escapeHtml(segment.state)}` : "";
            const readiness = !segment.ready ? ` · ${eventStateLabel(segment)}` : "";
            return `<button class="playbackMarker ${active} ${pending}" type="button" data-event-id="${escapeHtml(segment.eventId)}" aria-disabled="${segment.ready ? "false" : "true"}" style="left:${left}%; width:${width}%; background:${escapeHtml(segment.color)};" title="${escapeHtml(`${segment.presetName} · ${clockLabel(segment.triggeredAt)}${readiness}`)}"></button>`;
          }).join("")}
        </div>
      `).join("") : `<div class="playbackTimelineEmpty">No recordings in this range.</div>`}
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
    sub.textContent = "Select a camera and marker to load a recorded clip.";
    return;
  }
  sub.textContent = `${event.title} · ${clockLabel(event.triggered_at)} · ${deviceName(event.device_id)}`;
}

async function startVideoPlayback(video) {
  if (!video) return false;
  try {
    const playResult = video.play();
    if (playResult && typeof playResult.then === "function") {
      await playResult;
    }
    return true;
  } catch {
    return false;
  }
}

async function selectEvent(eventId, options = {}) {
  const event = state.timeline.events.find((item) => item.id === eventId);
  if (!event) return;
  if (!eventIsReady(event) && options.allowPending !== true) {
    return;
  }

  clearForwardPlaybackBoundarySchedule();
  const range = dayRange(event.clip_start, event.clip_end);
  if (options.ensureVisible !== false) {
    ensureTimelineRangeVisible(range.startMinute, range.endMinute);
  }

  const seekSeconds = clamp(Number(options.seekSeconds) || 0, 0, eventDurationSeconds(event));
  const shouldAutoplay = options.autoplay !== false;

  const video = el("playbackVideo");
  const empty = el("playbackVideoEmpty");
  if (!video || !empty) return;

  const isSameEvent = state.selectedEventId === eventId && !!video.currentSrc;

  state.selectedEventId = eventId;
  renderTimeline();
  updatePlaybackHeader(event);
  syncPlaybackTransport();
  stopPlaybackCursorLoop();
  stopReversePlayback();
  stopSimulatedForwardPlayback();
  setPlaybackCursor({ minute: range.startMinute + (seekSeconds / 60), label: clockLabel(Date.parse(event.clip_start) + (seekSeconds * 1000)) });
  schedulePlaybackStateSave();

  if (isSameEvent) {
    await seekVideoToSeconds(video, seekSeconds);
    updatePlaybackCursorFromVideo();

    if (!shouldAutoplay) {
      pauseCurrentPlayback();
      setStatus(`Loaded ${event.title}.`);
      return;
    }

    const started = await startConfiguredPlayback(video, event);
    setStatus(playbackStatusText(event, started));
    return;
  }

  setStatus(`Loading ${event.title}…`);
  empty.classList.add("hidden");
  video.classList.remove("hidden");
  video.pause();
  video.currentTime = 0;
  video.src = `/api/playback/events/${encodeURIComponent(eventId)}/clip?ts=${Date.now()}`;
  video.load();

  await seekVideoToSeconds(video, seekSeconds);

  if (!shouldAutoplay) {
    pauseCurrentPlayback();
    setStatus(`Loaded ${event.title}.`);
    return;
  }

  const started = await startConfiguredPlayback(video, event);
  setStatus(started ? playbackStatusText(event, true) : `Loaded ${event.title}. Click play if playback does not start automatically.`);
}

async function loadTimeline() {
  clearForwardPlaybackBoundarySchedule();
  clearPendingTimelineRefresh();

  if (!state.selectedDeviceId) {
    state.timeline = { segments: [], events: [] };
    state.selectedEventId = null;
    stopPlaybackCursorLoop();
    stopReversePlayback();
    stopSimulatedForwardPlayback();
    setPlaybackCursor(null);
    renderTimeline();
    syncPlaybackTransport();
    setStatus("Select a configured camera to see recordings.");
    savePlaybackStateNow();
    return;
  }

  setStatus("Loading timeline…");
  const query = new URLSearchParams({ device_id: state.selectedDeviceId, day: state.selectedDay || todayString() });
  const data = await api(`/api/playback/timeline?${query.toString()}`);
  const restore = playbackRestoreState();
  state.timeline = {
    segments: Array.isArray(data?.segments) ? data.segments : [],
    events: Array.isArray(data?.events) ? data.events : [],
  };

  const restoreStartMinute = Number(restore?.timelineView?.startMinute);
  const restoreDurationMinutes = Number(restore?.timelineView?.durationMinutes);
  if (Number.isFinite(restoreStartMinute) && Number.isFinite(restoreDurationMinutes)) {
    setTimelineViewport(restoreStartMinute, restoreDurationMinutes, { render: false, persist: false });
  }

  const restoreEventId = typeof restore?.selectedEventId === "string" && restore.selectedEventId ? restore.selectedEventId : null;
  const restoreSeekSeconds = Number(restore?.seekSeconds);
  if (restoreEventId && state.timeline.events.some((item) => item.id === restoreEventId && eventIsReady(item))) {
    state.selectedEventId = restoreEventId;
  }

  if (!state.timeline.events.some((item) => item.id === state.selectedEventId && eventIsReady(item))) {
    state.selectedEventId = [...state.timeline.events].reverse().find((item) => eventIsReady(item))?.id || null;
  }

  renderTimeline();

  if (state.selectedEventId) {
    const shouldRestoreSeek = restoreEventId === state.selectedEventId && Number.isFinite(restoreSeekSeconds) && restoreSeekSeconds >= 0;
    await selectEvent(
      state.selectedEventId,
      shouldRestoreSeek
        ? { seekSeconds: restoreSeekSeconds, autoplay: false, ensureVisible: false }
        : undefined,
    );
  } else {
    stopPlaybackCursorLoop();
    stopReversePlayback();
    stopSimulatedForwardPlayback();
    setPlaybackCursor(null);
    updatePlaybackHeader(null);
    showVideoEmpty(
      pendingEventCount()
        ? "Recording still saving"
        : "No clip selected",
      pendingEventCount()
        ? "Grayed markers are still being finalized and will become playable automatically once recording is safely saved."
        : "Choose a colored marker from the timeline below to load a recording."
    );
    syncPlaybackTransport();
    setStatus(
      pendingEventCount()
        ? `Waiting for ${pendingEventCount()} recording${pendingEventCount() === 1 ? "" : "s"} to finish saving.`
        : (state.timeline.segments.length ? "No markers for this day yet, but recorded video is available." : "No recorded video available for this day.")
    );
  }

  schedulePlaybackStateSave();
  schedulePendingTimelineRefresh();
}

async function loadDevices() {
  const out = await api("/api/devices");
  state.devices = Array.isArray(out?.devices) ? out.devices : [];
  const configured = state.devices.filter((device) => device.profile_token);
  state.selectedDeviceId = configured.find((device) => device.id === state.selectedDeviceId)?.id || configured[0]?.id || "";
  renderDeviceOptions();
}

async function refreshAll() {
  try {
    await loadDevices();
    await loadTimeline();
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function clearAllRecordings() {
  const confirmed = window.confirm("Clear all recordings, generated clips, and playback markers? This cannot be undone.");
  if (!confirmed) return;

  const button = el("playbackClearBtn");
  if (button) button.disabled = true;

  try {
    clearForwardPlaybackBoundarySchedule();
    stopPlaybackCursorLoop();
    stopReversePlayback();
    stopSimulatedForwardPlayback();
    setPlaybackCursor(null);
    showVideoEmpty("No clip selected", "Choose a colored marker from the timeline below to load a recording.");
    updatePlaybackHeader(null);
    state.selectedEventId = null;
    syncPlaybackTransport();
    setStatus("Clearing recordings…");

    const result = await api("/api/playback/recordings", { method: "DELETE" });
    state.timeline = { segments: [], events: [] };
    renderTimeline();
    await refreshAll();

    const markerLabel = Number(result?.cleared_events || 0);
    const recordingLabel = Number(result?.deleted_recording_files || 0);
    const clipLabel = Number(result?.deleted_clip_files || 0);
    setStatus(`Cleared ${recordingLabel} recording file${recordingLabel === 1 ? "" : "s"}, ${clipLabel} clip${clipLabel === 1 ? "" : "s"}, and ${markerLabel} marker${markerLabel === 1 ? "" : "s"}.`);
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    if (button) button.disabled = false;
  }
}

function bindUi() {
  const video = el("playbackVideo");
  const saved = loadStoredPlaybackState();

  state.selectedDeviceId = String(saved?.selectedDeviceId || "").trim();
  state.selectedDay = normalizeStoredDay(saved?.selectedDay);
  state.selectedEventId = typeof saved?.selectedEventId === "string" && saved.selectedEventId ? saved.selectedEventId : null;
  el("playbackDayInput").value = state.selectedDay;

  const savedStartMinute = Number(saved?.timelineView?.startMinute);
  const savedDurationMinutes = Number(saved?.timelineView?.durationMinutes);
  if (Number.isFinite(savedStartMinute) && Number.isFinite(savedDurationMinutes)) {
    setTimelineViewport(savedStartMinute, savedDurationMinutes, { render: false, persist: false });
  }

  bindTimelineInteractions();
  renderTimeline();

  video?.addEventListener("loadedmetadata", () => {
    syncPlaybackTransport();
    updatePlaybackCursorFromVideo();
    schedulePlaybackStateSave();
  });

  video?.addEventListener("play", () => {
    if (isReverseDirection()) {
      video.pause();
      return;
    }

    startPlaybackCursorLoop();
    syncPlaybackTransport();
  });

  video?.addEventListener("pause", () => {
    stopPlaybackCursorLoop();
    if (!isReversePlaybackActive()) {
      updatePlaybackCursorFromVideo();
      queueForwardPlaybackBoundaryCheck();
    }
    syncPlaybackTransport();
    schedulePlaybackStateSave();
  });

  video?.addEventListener("timeupdate", () => {
    updatePlaybackCursorFromVideo();
    queueForwardPlaybackBoundaryCheck();
    schedulePlaybackStateSave();
  });

  video?.addEventListener("seeking", () => {
    updatePlaybackCursorFromVideo();
    schedulePlaybackStateSave();
  });

  video?.addEventListener("seeked", () => {
    updatePlaybackCursorFromVideo();
    queueForwardPlaybackBoundaryCheck();
    schedulePlaybackStateSave();
  });

  video?.addEventListener("ended", async () => {
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

  video?.addEventListener("emptied", () => {
    clearForwardPlaybackBoundarySchedule();
    stopPlaybackCursorLoop();
    stopReversePlayback();
    stopSimulatedForwardPlayback();
    syncPlaybackTransport();
  });

  video?.addEventListener("error", () => {
    clearForwardPlaybackBoundarySchedule();
    stopPlaybackCursorLoop();
    stopReversePlayback();
    stopSimulatedForwardPlayback();
    setPlaybackCursor(null);
    const event = state.timeline.events.find((item) => item.id === state.selectedEventId);
    showVideoEmpty(
      "Clip unavailable",
      event
        ? `The clip for ${event.title} could not be loaded. This usually means there was no recorded video yet for that marker.`
        : "The selected clip could not be loaded."
    );
    syncPlaybackTransport();
    setStatus("Clip could not be loaded.");
    schedulePendingTimelineRefresh();
  });

  el("playbackDeviceSelect")?.addEventListener("change", async (event) => {
    state.selectedDeviceId = event.target.value;
    state.selectedEventId = null;
    savePlaybackStateNow();
    await loadTimeline();
  });

  el("playbackDayInput")?.addEventListener("change", async (event) => {
    state.selectedDay = event.target.value || todayString();
    state.selectedEventId = null;
    savePlaybackStateNow();
    await loadTimeline();
  });

  el("playbackRefreshBtn")?.addEventListener("click", refreshAll);
  el("playbackClearBtn")?.addEventListener("click", clearAllRecordings);
  el("playbackPlayPauseBtn")?.addEventListener("click", async () => {
    await togglePlayback();
  });
  el("playbackStopBtn")?.addEventListener("click", async () => {
    await stopPlayback();
  });
  el("playbackDirectionBackwardBtn")?.addEventListener("click", async () => {
    await setPlaybackDirection("backward");
  });
  el("playbackDirectionForwardBtn")?.addEventListener("click", async () => {
    await setPlaybackDirection("forward");
  });
  el("playbackSpeedInput")?.addEventListener("input", (event) => {
    setPlaybackSpeed(event.target.value);
  });
  el("playbackSpeedInput")?.addEventListener("change", () => {
    resetPlaybackSpeed();
  });
  el("playbackSpeedInput")?.addEventListener("pointerup", () => {
    resetPlaybackSpeed();
  });

  window.addEventListener("pagehide", () => {
    clearPendingTimelineRefresh();
    savePlaybackStateNow();
  });

  syncPlaybackTransport();
}

function bindTimelineInteractions() {
  const track = el("playbackTimelineTrack");
  if (!track) return;

  track.addEventListener("wheel", (event) => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) {
      return;
    }

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
    if (event.button !== 0) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-event-id]") || target?.closest("[data-playback-track-base]")) {
      return;
    }

    state.timelineView.pointerId = event.pointerId;
    state.timelineView.dragOriginX = event.clientX;
    state.timelineView.dragOriginStartMinute = state.timelineView.startMinute;
    state.timelineView.dragOriginDuration = currentTimelineDuration();
    state.timelineView.isDragging = false;
    track.setPointerCapture(event.pointerId);
  });

  track.addEventListener("pointermove", (event) => {
    if (event.pointerId !== state.timelineView.pointerId) {
      return;
    }

    const rect = track.getBoundingClientRect();
    if (!rect.width) {
      return;
    }

    const deltaX = event.clientX - state.timelineView.dragOriginX;
    if (!state.timelineView.isDragging && Math.abs(deltaX) < PAN_DRAG_THRESHOLD_PX) {
      return;
    }

    state.timelineView.isDragging = true;
    track.classList.add("is-dragging");

    const deltaMinutes = (deltaX / rect.width) * state.timelineView.dragOriginDuration;
    setTimelineViewport(state.timelineView.dragOriginStartMinute - deltaMinutes, state.timelineView.dragOriginDuration);
  });

  const finishDrag = (event) => {
    if (event.pointerId !== state.timelineView.pointerId) {
      return;
    }

    if (state.timelineView.isDragging) {
      state.timelineView.suppressClickUntil = Date.now() + CLICK_SUPPRESSION_MS;
    }

    state.timelineView.pointerId = null;
    state.timelineView.isDragging = false;
    track.classList.remove("is-dragging");

    if (track.hasPointerCapture(event.pointerId)) {
      track.releasePointerCapture(event.pointerId);
    }
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
        if (!targetEvent) {
          return;
        }
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

      if (!base) {
        return;
      }

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