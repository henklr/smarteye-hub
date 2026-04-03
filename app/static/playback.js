const el = (id) => document.getElementById(id);

const state = {
  devices: [],
  selectedDeviceId: "",
  selectedDay: "",
  timeline: { segments: [], events: [] },
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

function timelinePercent(value) {
  return Math.max(0, Math.min(100, (minutesIntoDay(value) / (24 * 60)) * 100));
}

function eventDurationPercent(startedAt, endedAt) {
  return Math.max(0.4, timelinePercent(endedAt) - timelinePercent(startedAt));
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
  const labels = [];
  for (let hour = 0; hour < 24; hour += 2) {
    labels.push(`<span>${String(hour).padStart(2, "0")}:00</span>`);
  }
  scale.innerHTML = labels.join("");
}

function renderTimeline() {
  const track = el("playbackTimelineTrack");
  const list = el("playbackMarkerList");
  const sub = el("playbackTimelineSub");
  if (!track || !list || !sub) return;

  const { segments, events } = state.timeline;
  const selectedDay = state.selectedDay || todayString();
  const selectedDeviceName = deviceName(state.selectedDeviceId);
  sub.textContent = `${selectedDeviceName} · ${selectedDay} · ${events.length} marker${events.length === 1 ? "" : "s"}`;

  track.innerHTML = `
    <div class="playbackTimelineBase"></div>
    ${segments.map((segment) => {
      const left = timelinePercent(segment.started_at);
      const width = Math.max(0.25, timelinePercent(segment.ended_at) - left);
      return `<div class="playbackCoverageBar" style="left:${left}%; width:${width}%;"></div>`;
    }).join("")}
    ${events.map((event) => {
      const left = timelinePercent(event.clip_start);
      const width = eventDurationPercent(event.clip_start, event.clip_end);
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

  track.querySelectorAll("[data-event-id]").forEach((node) => {
    node.addEventListener("click", () => selectEvent(node.dataset.eventId));
  });

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

async function selectEvent(eventId) {
  const event = state.timeline.events.find((item) => item.id === eventId);
  if (!event) return;
  state.selectedEventId = eventId;
  renderTimeline();
  updatePlaybackHeader(event);

  const video = el("playbackVideo");
  const empty = el("playbackVideoEmpty");
  if (!video || !empty) return;

  setStatus(`Loading ${event.title}…`);
  empty.classList.add("hidden");
  video.classList.remove("hidden");
  video.pause();
  video.currentTime = 0;
  video.src = `/api/playback/events/${encodeURIComponent(eventId)}/clip?ts=${Date.now()}`;
  video.load();

  const started = await startVideoPlayback(video);
  setStatus(started ? `Playing ${event.title}.` : `Loaded ${event.title}. Click play if playback does not start automatically.`);
}

async function loadTimeline() {
  if (!state.selectedDeviceId) {
    state.timeline = { segments: [], events: [] };
    state.selectedEventId = null;
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
  renderTimelineScale();
  el("playbackDayInput").value = todayString();
  state.selectedDay = el("playbackDayInput").value;

  el("playbackVideo")?.addEventListener("loadeddata", async (event) => {
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

  el("playbackVideo")?.addEventListener("error", () => {
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

bindUi();
refreshAll();