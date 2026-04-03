const el = (id) => document.getElementById(id);

const DAY_MINUTES = 24 * 60;
const MIN_VISIBLE_MINUTES = 5;
const CLICK_SUPPRESSION_MS = 250;
const PAN_DRAG_THRESHOLD_PX = 6;

const state = {
  devices: [],
  selectedDeviceId: "",
  selectedDay: "",
  timeline: { segments: [], events: [] },
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

function showVideoEmpty(title, text) {
  const video = el("playbackVideo");
  const empty = el("playbackVideoEmpty");
  const emptyText = el("playbackVideoEmptyText");
  const titleNode = empty?.querySelector(".playbackVideoEmptyTitle");

  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.classList.add("hidden");
  }

  if (titleNode) titleNode.textContent = title || "No clip selected";
  if (emptyText) emptyText.textContent = text || "Choose a colored marker from the timeline below to load a recording.";
  empty?.classList.remove("hidden");
}

function todayString() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function clockLabel(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return String(value || "");
  }
}

function deviceName(deviceId) {
  return state.devices.find((item) => item.id === deviceId)?.name || deviceId || "camera";
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
  const startMinute = clamp(minutesIntoDay(startedAt), 0, DAY_MINUTES);
  const endCandidate = clamp(minutesIntoDay(endedAt), 0, DAY_MINUTES);
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
  if (selected) {
    const range = eventRange(selected);
    if (minute >= range.startMinute && minute <= range.endMinute) {
      return selected;
    }
  }

  return state.timeline.events.find((event) => {
    const range = eventRange(event);
    return minute >= range.startMinute && minute <= range.endMinute;
  }) || null;
}

function nextTimelineEvent(currentEventId) {
  const currentIndex = state.timeline.events.findIndex((event) => event.id === currentEventId);
  if (currentIndex < 0) {
    return null;
  }

  return state.timeline.events[currentIndex + 1] || null;
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

function visibleTimelinePercent(minute) {
  const duration = currentTimelineDuration() || DAY_MINUTES;
  return clamp(((minute - state.timelineView.startMinute) / duration) * 100, 0, 100);
}

function isVisibleRange(startMinute, endMinute) {
  return endMinute >= state.timelineView.startMinute && startMinute <= state.timelineView.endMinute;
}

function chooseTimelineStep(duration) {
  const steps = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720];
  return steps.find((step) => duration / step <= 8) || DAY_MINUTES;
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
  const track = el("playbackTimelineTrack");
  if (!scale) return;

  const duration = currentTimelineDuration();
  const step = chooseTimelineStep(duration);
  const labels = [];
  const firstTick = Math.ceil(state.timelineView.startMinute / step) * step;
  const tickMinutes = [];

  for (let minute = firstTick; minute <= state.timelineView.endMinute; minute += step) {
    tickMinutes.push(minute);
  }

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

  if (track) {
    track.style.setProperty("--timeline-grid-width", `${Math.max((step / duration) * 100, 6)}%`);
  }
}

function renderTimeline() {
  const track = el("playbackTimelineTrack");
  const list = el("playbackMarkerList");
  const sub = el("playbackTimelineSub");
  if (!track || !list || !sub) return;

  renderTimelineScale();

  const { segments, events } = state.timeline;
  const selectedDay = state.selectedDay || todayString();
  const selectedDeviceName = deviceName(state.selectedDeviceId);
  const viewLabel = `${minuteLabel(state.timelineView.startMinute)}-${minuteLabel(state.timelineView.endMinute)}`;
  sub.textContent = `${selectedDeviceName} · ${selectedDay} · ${events.length} marker${events.length === 1 ? "" : "s"} · view ${viewLabel} · mouse wheel to zoom, drag to pan`;

  track.innerHTML = `
    <div class="playbackTimelineBase"></div>
    <div class="playbackTimelineCursor hidden" data-playback-cursor>
      <span class="playbackTimelineCursorLabel" data-playback-cursor-label></span>
    </div>
    ${segments.map((segment) => {
      const range = dayRange(segment.started_at, segment.ended_at);
      if (!isVisibleRange(range.startMinute, range.endMinute)) {
        return "";
      }

      const clippedStart = clamp(range.startMinute, state.timelineView.startMinute, state.timelineView.endMinute);
      const clippedEnd = clamp(range.endMinute, state.timelineView.startMinute, state.timelineView.endMinute);
      const left = visibleTimelinePercent(clippedStart);
      const width = Math.max(0.25, visibleTimelinePercent(clippedEnd) - left);
      return `<div class="playbackCoverageBar" style="left:${left}%; width:${width}%;"></div>`;
    }).join("")}
    ${events.map((event) => {
      const range = dayRange(event.clip_start, event.clip_end);
      if (!isVisibleRange(range.startMinute, range.endMinute)) {
        return "";
      }

      const clippedStart = clamp(range.startMinute, state.timelineView.startMinute, state.timelineView.endMinute);
      const clippedEnd = clamp(range.endMinute, state.timelineView.startMinute, state.timelineView.endMinute);
      const left = visibleTimelinePercent(clippedStart);
      const width = Math.max(0.6, visibleTimelinePercent(clippedEnd) - left);
      const active = event.id === state.selectedEventId ? "is-active" : "";
      return `<button class="playbackMarker ${active}" type="button" data-event-id="${escapeHtml(event.id)}" style="left:${left}%; width:${width}%; background:${escapeHtml(event.color)};" title="${escapeHtml(`${event.title} · ${clockLabel(event.triggered_at)}`)}"></button>`;
    }).join("")}
  `;

  list.innerHTML = events.length
    ? events.map((event) => `
      <button class="playbackMarkerRow ${event.id === state.selectedEventId ? "is-active" : ""}" type="button" data-event-id="${escapeHtml(event.id)}">
        <span class="playbackMarkerSwatch" style="background:${escapeHtml(event.color)};"></span>
        <span class="playbackMarkerMeta">
          <span class="playbackMarkerTitle">${escapeHtml(event.title)}</span>
          <span class="playbackMarkerSub">${escapeHtml(clockLabel(event.triggered_at))} · ${escapeHtml(deviceName(event.device_id))}</span>
        </span>
      </button>
    `).join("")
    : `<div class="emptyState">No recording markers on this day yet.</div>`;

  syncPlaybackCursor();

  list.querySelectorAll("[data-event-id]").forEach((node) => {
    node.addEventListener("click", () => selectEvent(node.dataset.eventId));
  });
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

  const range = dayRange(event.clip_start, event.clip_end);
  ensureTimelineRangeVisible(range.startMinute, range.endMinute);

  const seekSeconds = clamp(Number(options.seekSeconds) || 0, 0, eventDurationSeconds(event));
  const shouldAutoplay = options.autoplay !== false;

  const video = el("playbackVideo");
  const empty = el("playbackVideoEmpty");
  if (!video || !empty) return;

  const isSameEvent = state.selectedEventId === eventId && !!video.currentSrc;

  state.selectedEventId = eventId;
  renderTimeline();
  updatePlaybackHeader(event);
  stopPlaybackCursorLoop();
  setPlaybackCursor({ minute: range.startMinute + (seekSeconds / 60), label: clockLabel(Date.parse(event.clip_start) + (seekSeconds * 1000)) });

  if (isSameEvent) {
    await seekVideoToSeconds(video, seekSeconds);
    updatePlaybackCursorFromVideo();
    const started = shouldAutoplay ? await startVideoPlayback(video) : false;
    setStatus(started ? `Playing ${event.title}.` : `Loaded ${event.title}.`);
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

  const started = shouldAutoplay ? await startVideoPlayback(video) : false;
  setStatus(started ? `Playing ${event.title}.` : `Loaded ${event.title}. Click play if playback does not start automatically.`);
}

async function loadTimeline() {
  if (!state.selectedDeviceId) {
    state.timeline = { segments: [], events: [] };
    state.selectedEventId = null;
    stopPlaybackCursorLoop();
    setPlaybackCursor(null);
    renderTimeline();
    setStatus("Select a configured camera to see recordings.");
    return;
  }

  setStatus("Loading timeline…");
  const query = new URLSearchParams({ device_id: state.selectedDeviceId, day: state.selectedDay || todayString() });
  const data = await api(`/api/playback/timeline?${query.toString()}`);
  state.timeline = {
    segments: Array.isArray(data?.segments) ? data.segments : [],
    events: Array.isArray(data?.events) ? data.events : [],
  };

  if (!state.timeline.events.some((item) => item.id === state.selectedEventId)) {
    state.selectedEventId = state.timeline.events.at(-1)?.id || null;
  }

  renderTimeline();

  if (state.selectedEventId) {
    await selectEvent(state.selectedEventId);
  } else {
    stopPlaybackCursorLoop();
    setPlaybackCursor(null);
    updatePlaybackHeader(null);
    showVideoEmpty("No clip selected", "Choose a colored marker from the timeline below to load a recording.");
    setStatus(state.timeline.segments.length ? "No markers for this day yet, but recorded video is available." : "No recorded video available for this day.");
  }
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
    stopPlaybackCursorLoop();
    setPlaybackCursor(null);
    showVideoEmpty("No clip selected", "Choose a colored marker from the timeline below to load a recording.");
    updatePlaybackHeader(null);
    state.selectedEventId = null;
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

  el("playbackDayInput").value = todayString();
  state.selectedDay = el("playbackDayInput").value;

  bindTimelineInteractions();
  renderTimeline();

  video?.addEventListener("loadedmetadata", () => {
    updatePlaybackCursorFromVideo();
  });

  video?.addEventListener("play", () => {
    startPlaybackCursorLoop();
  });

  video?.addEventListener("pause", () => {
    stopPlaybackCursorLoop();
    updatePlaybackCursorFromVideo();
  });

  video?.addEventListener("timeupdate", () => {
    updatePlaybackCursorFromVideo();
  });

  video?.addEventListener("seeking", () => {
    updatePlaybackCursorFromVideo();
  });

  video?.addEventListener("seeked", () => {
    updatePlaybackCursorFromVideo();
  });

  video?.addEventListener("ended", async () => {
    stopPlaybackCursorLoop();
    updatePlaybackCursorFromVideo();

    const currentEvent = selectedEvent();
    const nextEvent = currentEvent ? nextTimelineEvent(currentEvent.id) : null;
    if (!currentEvent || !nextEvent) {
      setStatus(currentEvent ? `Finished ${currentEvent.title}.` : "Playback ended.");
      return;
    }

    setStatus(`Finished ${currentEvent.title}. Loading ${nextEvent.title}…`);
    await selectEvent(nextEvent.id, { autoplay: true });
  });

  video?.addEventListener("emptied", () => {
    stopPlaybackCursorLoop();
  });

  video?.addEventListener("loadeddata", async (event) => {
    const video = event.currentTarget;
    if (!(video instanceof HTMLVideoElement) || !state.selectedEventId) {
      return;
    }

    if (!video.paused) {
      return;
    }

    const currentEvent = state.timeline.events.find((item) => item.id === state.selectedEventId);
    const started = await startVideoPlayback(video);
    if (started && currentEvent) {
      setStatus(`Playing ${currentEvent.title}.`);
    }
  });

  video?.addEventListener("error", () => {
    stopPlaybackCursorLoop();
    setPlaybackCursor(null);
    const event = state.timeline.events.find((item) => item.id === state.selectedEventId);
    showVideoEmpty(
      "Clip unavailable",
      event
        ? `The clip for ${event.title} could not be loaded. This usually means there was no recorded video yet for that marker.`
        : "The selected clip could not be loaded."
    );
    setStatus("Clip could not be loaded.");
  });

  el("playbackDeviceSelect")?.addEventListener("change", async (event) => {
    state.selectedDeviceId = event.target.value;
    state.selectedEventId = null;
    await loadTimeline();
  });

  el("playbackDayInput")?.addEventListener("change", async (event) => {
    state.selectedDay = event.target.value || todayString();
    state.selectedEventId = null;
    await loadTimeline();
  });

  el("playbackRefreshBtn")?.addEventListener("click", refreshAll);
  el("playbackClearBtn")?.addEventListener("click", clearAllRecordings);
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
      const targetEvent = target
        ? state.timeline.events.find((item) => item.id === target.dataset.eventId) || null
        : eventAtTimelineMinute(minute);

      if (!targetEvent) {
        return;
      }

      const seekSeconds = eventSeekSecondsForMinute(targetEvent, minute);
      await selectEvent(targetEvent.id, { seekSeconds, autoplay: true });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }, true);

}

bindUi();
refreshAll();