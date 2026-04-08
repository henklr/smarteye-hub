const el = (id) => document.getElementById(id);

const state = {
  catalog: null,
  devices: [],
  flows: [],
  draft: null,
  sidebarSections: {
    saved: { expanded: true, touched: false },
    presets: { expanded: true, touched: false },
    schedules: { expanded: true, touched: false },
    variables: { expanded: true, touched: false },
    palette: { expanded: true, touched: false },
  },
  recordingPresets: [],
  schedules: [],
  schedulesDirty: false,
  schedulesInteracting: false,
  schedulesUpdatedAt: null,
  schedulesTimer: null,
  scheduleDrag: null,
  selectedScheduleDay: null,
  selectedSchedulePeriod: null,
  scheduleViewportScrollTop: null,
  scheduleViewportScrollLeft: null,
  scheduleBlockResizeObserver: null,
  publicVariables: [],
  publicVariablesDirty: false,
  publicVariablesInteracting: false,
  publicVariablesUpdatedAt: null,
  publicVariablesTimer: null,
  physicalState: null,
  physicalStateTimer: null,
  selectedSavedFlowId: null,
  selectedNodeId: null,
  selectedEdgeId: null,
  selectedRecordingPresetIndex: null,
  selectedScheduleIndex: null,
  selectedPublicVariableIndex: null,
  dirty: false,
  connecting: null,
  connectionCursor: null,
  drag: null,
  pan: null,
  justPanned: false,
  topicCache: new Map(),
};

const SIDEBAR_SECTION_STATE_KEY = "flows.sidebarSections";

const CATEGORY_META = {
  trigger: { label: "Trigger", color: "#4f8cff" },
  condition: { label: "Condition", color: "#9c6bff" },
  operator: { label: "Operator", color: "#17b978" },
  action: { label: "Action", color: "#ff8c42" },
};

const DEFAULT_PHYSICAL_IO = {
  supported: false,
  available: false,
  error: null,
  digital_inputs: [1, 2, 3].map((channel) => ({ kind: "digital", channel: String(channel), label: `Digital input ${channel}` })),
  analog_inputs: [1, 2, 3].map((channel) => ({ kind: "analog", channel: String(channel), label: `Analog input ${channel}` })),
  outputs: [1, 2, 3].map((channel) => ({ kind: "output", channel: String(channel), label: `Output ${channel}` })),
  relays: [1].map((channel) => ({ kind: "relay", channel: String(channel), label: `Relay ${channel}` })),
};

const WEEKDAY_META = [
  ["monday", "Monday"],
  ["tuesday", "Tuesday"],
  ["wednesday", "Wednesday"],
  ["thursday", "Thursday"],
  ["friday", "Friday"],
  ["saturday", "Saturday"],
  ["sunday", "Sunday"],
];

const HOLIDAY_DAY_KEY = "holidays";
const SCHEDULE_DAY_META = [...WEEKDAY_META, [HOLIDAY_DAY_KEY, "Holidays"]];
const HOLIDAY_CALENDAR_OPTIONS = [
  ["DK", "Denmark"],
  ["SE", "Sweden"],
  ["NO", "Norway"],
  ["DE", "Germany"],
  ["GB", "United Kingdom"],
  ["US", "United States"],
  ["NONE", "Disabled"],
];

const SCHEDULE_SNAP_MINUTES = 15;
const SCHEDULE_MIN_DURATION_MINUTES = 15;
const SCHEDULE_RESIZE_SNAP_MINUTES = 1;
const SCHEDULE_MAX_MINUTE = 23 * 60 + 59;
const SCHEDULE_DAY_MINUTES = 24 * 60;
const SCHEDULE_HOUR_WIDTH = 96;
const SCHEDULE_INITIAL_SCROLL_HOUR = 7;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });

  const txt = await res.text();
  let data = null;

  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = txt;
  }

  if (!res.ok) {
    throw new Error((data && data.detail) ? data.detail : (txt || res.statusText));
  }

  return data;
}

function escapeHtml(value) {
  return (value ?? "")
    .toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, bad = false) {
  const node = el("boardStatus");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = bad ? "var(--danger)" : "var(--muted)";
}

function setTestStatus(message, bad = false) {
  const node = el("testStatus");
  if (!node) return;
  node.textContent = message || "";
  node.style.color = bad ? "var(--danger)" : "var(--muted)";
}

function clearTestResult() {
  const box = el("testResult");
  if (!box) return;
  box.textContent = "";
  box.classList.add("hidden");
}

function showTestResult(value) {
  const box = el("testResult");
  if (!box) return;
  box.classList.remove("hidden");
  box.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function markDirty() {
  state.dirty = true;
  syncHeader();
}

function clearDirty() {
  state.dirty = false;
  syncHeader();
}

function nodeDef(type) {
  return (state.catalog?.nodes || []).find((item) => item.type === type) || null;
}

function currentFlow() {
  return state.draft;
}

function currentSchedules() {
  return state.schedules || [];
}

function currentPublicVariables() {
  return state.publicVariables || [];
}

function currentRecordingPresets() {
  return state.recordingPresets || [];
}

function currentSelectedRecordingPreset() {
  const idx = state.selectedRecordingPresetIndex;
  if (!Number.isInteger(idx) || idx < 0) return null;
  return currentRecordingPresets()[idx] || null;
}

function currentSelectedSchedule() {
  const idx = state.selectedScheduleIndex;
  if (!Number.isInteger(idx) || idx < 0) return null;
  return currentSchedules()[idx] || null;
}

function currentSelectedScheduleDayEntry(index = state.selectedScheduleIndex) {
  const selection = state.selectedScheduleDay;
  if (!selection || selection.scheduleIndex !== index || !selection.dayKey) return null;

  const schedule = currentSchedules()[index];
  if (!schedule) return null;

  const dayMeta = SCHEDULE_DAY_META.find(([dayKey]) => dayKey === selection.dayKey);
  if (!dayMeta) return null;

  return {
    schedule,
    selection,
    dayKey: dayMeta[0],
    dayLabel: dayMeta[1],
    periods: schedule.days?.[selection.dayKey] || [],
  };
}

function currentSelectedSchedulePeriodEntry(index = state.selectedScheduleIndex) {
  const selection = state.selectedSchedulePeriod;
  if (!selection || selection.scheduleIndex !== index) return null;

  const schedule = currentSchedules()[index];
  if (!schedule) return null;

  const periods = schedule.days?.[selection.dayKey];
  const period = periods?.[selection.periodIndex];
  if (!period) return null;

  return { schedule, selection, period };
}

function currentSelectedPublicVariable() {
  const idx = state.selectedPublicVariableIndex;
  if (!Number.isInteger(idx) || idx < 0) return null;
  return currentPublicVariables()[idx] || null;
}

function clearEditorSelection() {
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
  renderRecordingPresetSidebar();
  renderScheduleSidebar();
  renderPublicVariablesSidebar();
}

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  state.selectedEdgeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
  renderRecordingPresetSidebar();
  renderScheduleSidebar();
  renderPublicVariablesSidebar();
}

function selectEdge(edgeId) {
  state.selectedEdgeId = edgeId;
  state.selectedNodeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
  renderRecordingPresetSidebar();
  renderScheduleSidebar();
  renderPublicVariablesSidebar();
}

function selectRecordingPreset(index) {
  state.selectedRecordingPresetIndex = Number.isInteger(index) && index >= 0 ? index : null;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
  state.connecting = null;
  state.connectionCursor = null;
}

function selectSchedule(index) {
  state.selectedScheduleIndex = Number.isInteger(index) && index >= 0 ? index : null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedPublicVariableIndex = null;
  state.connecting = null;
  state.connectionCursor = null;
}

function selectScheduleDay(scheduleIndex, dayKey) {
  if (!Number.isInteger(scheduleIndex) || scheduleIndex < 0 || !SCHEDULE_DAY_META.some(([key]) => key === dayKey)) {
    state.selectedScheduleDay = null;
    state.selectedSchedulePeriod = null;
    return;
  }

  state.selectedScheduleDay = { scheduleIndex, dayKey };
  if (state.selectedSchedulePeriod?.scheduleIndex !== scheduleIndex || state.selectedSchedulePeriod?.dayKey !== dayKey) {
    state.selectedSchedulePeriod = null;
  }
}

function selectSchedulePeriod(scheduleIndex, dayKey, periodIndex) {
  if (!Number.isInteger(scheduleIndex) || scheduleIndex < 0 || !dayKey || !Number.isInteger(periodIndex) || periodIndex < 0) {
    state.selectedSchedulePeriod = null;
    return;
  }

  selectScheduleDay(scheduleIndex, dayKey);
  state.selectedSchedulePeriod = { scheduleIndex, dayKey, periodIndex };
}

function selectPublicVariable(index) {
  state.selectedPublicVariableIndex = Number.isInteger(index) && index >= 0 ? index : null;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.connecting = null;
  state.connectionCursor = null;
}

function normalizeVariableType(value) {
  const type = String(value || "string").trim().toLowerCase();
  return ["string", "number", "boolean", "json", "schedule"].includes(type) ? type : "string";
}

function parseBooleanLike(value) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function publicVariableByKey(key) {
  const wanted = String(key || "").trim();
  return currentPublicVariables().find((item) => String(item.key || "").trim() === wanted) || null;
}

function normalizeVariableSource(value) {
  const source = String(value || "manual").trim().toLowerCase();
  return source === "physical_input" ? "physical_input" : "manual";
}

function normalizePublicVariableRecord(item = {}) {
  const normalized = { ...item };

  normalized.source = normalizeVariableSource(normalized.source);
  if (normalized.source === "physical_input") {
    normalized.input_kind = String(normalized.input_kind || "digital").trim().toLowerCase();
    if (!["digital", "analog", "output", "relay"].includes(normalized.input_kind)) {
      normalized.input_kind = "digital";
    }
    normalized.channel = normalizePhysicalChannelSelection(normalized.input_kind, normalized.channel || "1");
    normalized.type = normalized.input_kind === "analog" ? "number" : "boolean";
  } else {
    normalized.type = normalizeVariableType(normalized.type);
    normalized.input_kind = "";
    normalized.channel = "";
  }

  normalized.current_value = Object.prototype.hasOwnProperty.call(normalized, "current_value")
    ? normalized.current_value
    : normalized.value;

  if (normalized.source !== "physical_input") {
    normalized.value = normalized.current_value;
  }

  return normalized;
}

function normalizePublicVariableRecords(items = []) {
  return (items || []).map((item) => normalizePublicVariableRecord(item));
}

function normalizeHolidayCalendar(value) {
  const raw = String(value || "DK").trim().toUpperCase().replace(/[\s_-]+/g, "");
  const aliases = {
    DK: "DK",
    DENMARK: "DK",
    SE: "SE",
    SWEDEN: "SE",
    NO: "NO",
    NORWAY: "NO",
    DE: "DE",
    GERMANY: "DE",
    GB: "GB",
    UK: "GB",
    UNITEDKINGDOM: "GB",
    GREATBRITAIN: "GB",
    US: "US",
    USA: "US",
    UNITEDSTATES: "US",
    NONE: "NONE",
    DISABLED: "NONE",
    OFF: "NONE",
  };
  const normalized = aliases[raw] || "DK";
  return HOLIDAY_CALENDAR_OPTIONS.some(([code]) => code === normalized) ? normalized : "DK";
}

function holidayCalendarLabel(value) {
  const code = normalizeHolidayCalendar(value);
  return HOLIDAY_CALENDAR_OPTIONS.find(([optionCode]) => optionCode === code)?.[1] || "Denmark";
}

function scheduleDayDisabled(schedule, dayKey) {
  return dayKey === HOLIDAY_DAY_KEY && normalizeHolidayCalendar(schedule?.holiday_calendar) === "NONE";
}

function emptyScheduleDays() {
  return Object.fromEntries(SCHEDULE_DAY_META.map(([key]) => [key, []]));
}

function normalizeScheduleTime(value, fallback = "09:00") {
  const raw = String(value || fallback).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeSchedulePeriods(periods = []) {
  const seen = new Set();
  const out = [];

  for (const period of periods || []) {
    if (!period || typeof period !== "object") continue;
    const start = normalizeScheduleTime(period.start, "09:00");
    const end = normalizeScheduleTime(period.end, "17:00");
    if (start === end) continue;
    const key = `${start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start, end });
  }

  out.sort((left, right) => left.start.localeCompare(right.start) || left.end.localeCompare(right.end));
  return out;
}

function normalizeScheduleRecord(item = {}) {
  const days = emptyScheduleDays();
  const incomingDays = item.days && typeof item.days === "object" ? item.days : {};

  for (const [dayKey] of SCHEDULE_DAY_META) {
    days[dayKey] = normalizeSchedulePeriods(incomingDays[dayKey] || []);
  }

  return {
    key: String(item.key || "").trim(),
    name: String(item.name || item.key || "").trim() || "Schedule",
    holiday_calendar: normalizeHolidayCalendar(item.holiday_calendar),
    days,
    is_active: Boolean(item.is_active),
  };
}

function normalizeScheduleRecords(items = []) {
  return (items || []).map((item) => normalizeScheduleRecord(item));
}

function scheduleByKey(key) {
  const wanted = String(key || "").trim();
  return currentSchedules().find((item) => String(item.key || "").trim() === wanted) || null;
}

function scheduleNameForKey(key) {
  const schedule = scheduleByKey(key);
  return schedule?.name || String(key || "").trim();
}

function scheduleSummary(schedule) {
  const totalPeriods = SCHEDULE_DAY_META.reduce((count, [dayKey]) => count + ((schedule?.days?.[dayKey] || []).length), 0);
  if (!totalPeriods) return "No active hours";
  return totalPeriods === 1 ? "1 active period" : `${totalPeriods} active periods`;
}

function scheduleStatusLabel(schedule) {
  return schedule?.is_active ? "Active now" : "Inactive now";
}

function scheduleOptionsHtml(selected = "") {
  const options = [`<option value="">Select schedule</option>`];
  for (const schedule of currentSchedules()) {
    options.push(
      `<option value="${escapeHtml(schedule.key)}" ${schedule.key === selected ? "selected" : ""}>${escapeHtml(schedule.name)}</option>`
    );
  }
  if (selected && !scheduleByKey(selected)) {
    options.push(`<option value="${escapeHtml(selected)}" selected>[Missing schedule] ${escapeHtml(selected)}</option>`);
  }
  return options.join("");
}

function nextScheduleKey() {
  const existing = new Set(currentSchedules().map((item) => String(item.key || "").trim()).filter(Boolean));
  let idx = currentSchedules().length + 1;
  while (existing.has(`schedule_${idx}`)) {
    idx += 1;
  }
  return `schedule_${idx}`;
}

function isScheduleEditing() {
  return state.selectedScheduleIndex != null && !!currentSelectedSchedule();
}

function syncScheduleEditingLayout() {
  const shell = document.querySelector(".flowsShell");
  if (!shell) return;
  shell.classList.toggle("is-schedule-editing", isScheduleEditing());
}

function scheduleTimeToMinutes(value) {
  const normalized = normalizeScheduleTime(value, "00:00");
  const [hour, minute] = normalized.split(":").map((item) => Number(item));
  return Math.max(0, Math.min(SCHEDULE_MAX_MINUTE, hour * 60 + minute));
}

function scheduleMinutesToTime(value) {
  const clamped = Math.max(0, Math.min(SCHEDULE_MAX_MINUTE, Math.round(Number(value) || 0)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function scheduleSnapMinutes(value, snapMinutes = SCHEDULE_SNAP_MINUTES) {
  const step = Math.max(1, Math.round(Number(snapMinutes) || 1));
  const snapped = Math.round((Number(value) || 0) / step) * step;
  return Math.max(0, Math.min(SCHEDULE_MAX_MINUTE, snapped));
}

function schedulePeriodDurationMinutes(period) {
  const start = scheduleTimeToMinutes(period?.start || "00:00");
  const end = scheduleTimeToMinutes(period?.end || "00:00");
  return end > start ? end - start : 0;
}

function normalizeScheduleDayPeriods(periods = []) {
  const daytime = [];
  const overnight = [];

  for (const period of periods || []) {
    if (!period || typeof period !== "object") continue;
    const start = scheduleTimeToMinutes(period.start);
    const end = scheduleTimeToMinutes(period.end);
    if (end > start) {
      daytime.push({ start, end });
    } else {
      overnight.push({ start: scheduleMinutesToTime(start), end: scheduleMinutesToTime(end) });
    }
  }

  daytime.sort((left, right) => left.start - right.start || left.end - right.end);

  const merged = [];
  for (const period of daytime) {
    const current = merged[merged.length - 1];
    if (!current || period.start > current.end) {
      merged.push({ ...period });
      continue;
    }
    current.end = Math.max(current.end, period.end);
  }

  return [
    ...merged.map((period) => ({
      start: scheduleMinutesToTime(period.start),
      end: scheduleMinutesToTime(period.end),
    })),
    ...overnight,
  ];
}

function schedulePreviousDayKey(dayKey) {
  const dayIndex = WEEKDAY_META.findIndex(([key]) => key === dayKey);
  if (dayIndex < 0) return null;
  return WEEKDAY_META[(dayIndex - 1 + WEEKDAY_META.length) % WEEKDAY_META.length][0];
}

function scheduleDraftForIndex(index) {
  return state.scheduleDrag && state.scheduleDrag.scheduleIndex === index ? state.scheduleDrag : null;
}

function buildScheduleSegments(schedule, scheduleIndex, dayKey) {
  const segments = [];
  const draft = scheduleDraftForIndex(scheduleIndex);
  const currentDayPeriods = schedule?.days?.[dayKey] || [];
  const previousDayKey = schedulePreviousDayKey(dayKey);
  const previousDayPeriods = previousDayKey ? (schedule?.days?.[previousDayKey] || []) : [];

  previousDayPeriods.forEach((period, periodIndex) => {
    const start = scheduleTimeToMinutes(period.start);
    const end = scheduleTimeToMinutes(period.end);
    if (end <= start) {
      segments.push({
        dayKey,
        sourceDayKey: previousDayKey,
        sourcePeriodIndex: periodIndex,
        startMinutes: 0,
        endMinutes: end,
        editable: false,
        overnight: true,
        continuation: true,
        draft: false,
      });
    }
  });

  currentDayPeriods.forEach((period, periodIndex) => {
    if (draft && draft.sourceDayKey === dayKey && draft.sourcePeriodIndex === periodIndex) {
      return;
    }

    const start = scheduleTimeToMinutes(period.start);
    const end = scheduleTimeToMinutes(period.end);
    if (end > start) {
      segments.push({
        dayKey,
        sourceDayKey: dayKey,
        sourcePeriodIndex: periodIndex,
        startMinutes: start,
        endMinutes: end,
        editable: true,
        overnight: false,
        continuation: false,
        draft: false,
      });
      return;
    }

    segments.push({
      dayKey,
      sourceDayKey: dayKey,
      sourcePeriodIndex: periodIndex,
      startMinutes: start,
      endMinutes: SCHEDULE_MAX_MINUTE,
      editable: false,
      overnight: true,
      continuation: false,
      draft: false,
    });
  });

  if (draft && draft.targetDayKey === dayKey) {
    segments.push({
      dayKey,
      sourceDayKey: draft.sourceDayKey,
      sourcePeriodIndex: draft.sourcePeriodIndex,
      startMinutes: draft.startMinutes,
      endMinutes: draft.endMinutes,
      editable: true,
      overnight: false,
      continuation: false,
      draft: true,
    });
  }

  return segments
    .filter((segment) => segment.endMinutes > segment.startMinutes)
    .sort((left, right) => left.startMinutes - right.startMinutes || left.endMinutes - right.endMinutes);
}

function scheduleMinuteToPercent(minutes) {
  return (Math.max(0, Math.min(SCHEDULE_MAX_MINUTE, minutes)) / SCHEDULE_DAY_MINUTES) * 100;
}

function renderScheduleHourLabels() {
  return Array.from({ length: 13 }, (_, index) => {
    const hour = index * 2;
    const left = (hour / 24) * 100;
    const edgeClass = hour === 0 ? " is-start" : (hour === 24 ? " is-end" : "");
    return `<div class="scheduleTimeLabel${edgeClass}" style="left:${left}%">${hour === 24 ? "24:00" : `${String(hour).padStart(2, "0")}:00`}</div>`;
  }).join("");
}

function renderScheduleDayLane(schedule, scheduleIndex, dayKey, label) {
  const selectedDay = currentSelectedScheduleDayEntry(scheduleIndex)?.selection || null;
  const segments = buildScheduleSegments(schedule, scheduleIndex, dayKey);
  const selectedPeriod = currentSelectedSchedulePeriodEntry(scheduleIndex)?.selection || null;
  const disabled = scheduleDayDisabled(schedule, dayKey);
  return `
    <div class="scheduleDayRow ${disabled ? "is-disabled" : ""} ${selectedDay?.dayKey === dayKey ? "is-selected" : ""}" data-schedule-day-row="${dayKey}">
      <div class="scheduleDayLabelCell">
        <button class="scheduleDayLabelButton" type="button" data-schedule-day-select="${dayKey}" aria-pressed="${selectedDay?.dayKey === dayKey ? "true" : "false"}">
          <span class="scheduleDayLabel">${escapeHtml(label)}</span>
        </button>
      </div>
      <div class="scheduleDayTrackWrap">
        <div class="scheduleDayTrack ${disabled ? "is-disabled" : ""}" data-schedule-track="${dayKey}" data-schedule-disabled="${disabled ? "true" : "false"}">
          ${segments.map((segment) => {
            const left = scheduleMinuteToPercent(segment.startMinutes);
            const rawWidth = scheduleMinuteToPercent(segment.endMinutes) - scheduleMinuteToPercent(segment.startMinutes);
            const width = Math.max(0.6, Math.min(100 - left, Math.max(1.4, rawWidth)));
            const startLabel = scheduleMinutesToTime(segment.startMinutes);
            const endLabel = scheduleMinutesToTime(segment.endMinutes);
            const editable = segment.editable && !disabled;
            const showTime = editable || disabled;
            const isSelected = !!(
              editable
              && selectedPeriod
              && selectedPeriod.dayKey === segment.sourceDayKey
              && selectedPeriod.periodIndex === segment.sourcePeriodIndex
            );
            const meta = segment.continuation
              ? `Continues until ${endLabel}`
              : (segment.overnight ? `Overnight from ${startLabel}` : `${startLabel} to ${endLabel}`);

            return `
              <button
                class="scheduleBlock ${segment.draft ? "is-draft" : ""} ${segment.overnight ? "is-overnight" : ""} ${segment.continuation ? "is-continuation" : ""} ${isSelected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}"
                type="button"
                style="left:${left}%;width:${width}%"
                data-schedule-block="true"
                data-schedule-day="${dayKey}"
                data-schedule-period-index="${segment.sourcePeriodIndex}"
                data-schedule-editable="${editable ? "true" : "false"}"
                title="${escapeHtml(meta)}"
              >
                ${showTime ? `
                  <span class="scheduleBlockTime">${escapeHtml(startLabel)} - ${escapeHtml(endLabel)}</span>
                  ${editable ? `
                    <span class="scheduleBlockDelete" data-schedule-delete="true" data-schedule-source-day="${segment.sourceDayKey}" data-schedule-period-index="${segment.sourcePeriodIndex}" aria-label="Delete period">&times;</span>
                    <span class="scheduleBlockHandle is-start" data-schedule-resize="start"></span>
                    <span class="scheduleBlockHandle is-end" data-schedule-resize="end"></span>
                  ` : ""}
                ` : `<span class="scheduleBlockBadge">${segment.continuation ? `Carry-over until ${escapeHtml(endLabel)}` : `Overnight until ${escapeHtml(endLabel)}`}</span>`}
              </button>
            `;
          }).join("")}
        </div>
      </div>
    </div>
  `;
}

function syncScheduleBlockTimeVisibility(root = document) {
  const scope = root instanceof Element || root instanceof Document ? root : document;

  scope.querySelectorAll("[data-schedule-block]").forEach((block) => {
    const label = block.querySelector(".scheduleBlockTime");
    if (!(label instanceof HTMLElement) || !(block instanceof HTMLElement)) return;

    const deleteButton = block.querySelector(".scheduleBlockDelete");
    const reservedWidth = (deleteButton instanceof HTMLElement ? deleteButton.offsetWidth : 0) + 42;
    const availableWidth = Math.max(0, block.clientWidth - reservedWidth);
    const shouldHide = availableWidth <= 0 || label.scrollWidth > availableWidth;

    block.classList.toggle("is-time-hidden", shouldHide);
    label.setAttribute("aria-hidden", shouldHide ? "true" : "false");
  });
}

function scheduleTrackDayKeyFromPoint(clientX, clientY) {
  const lane = document.elementFromPoint(clientX, clientY)?.closest?.("[data-schedule-track]");
  return lane?.dataset?.scheduleTrack || null;
}

function scheduleTrackMinutesFromClient(dayKey, clientX, snapMinutes = SCHEDULE_SNAP_MINUTES) {
  const lane = document.querySelector(`[data-schedule-track="${CSS.escape(dayKey)}"]`);
  if (!lane) return 0;
  const rect = lane.getBoundingClientRect();
  const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  return scheduleSnapMinutes(Math.max(0, Math.min(SCHEDULE_MAX_MINUTE, ratio * SCHEDULE_DAY_MINUTES)), snapMinutes);
}

function startScheduleDrag(dragState) {
  state.scheduleDrag = dragState;
  setSchedulesInteracting(true);
  renderCanvas();
}

function commitScheduleDrag() {
  const drag = state.scheduleDrag;
  const schedule = currentSchedules()[drag?.scheduleIndex ?? -1];
  if (!drag || !schedule) {
    state.scheduleDrag = null;
    return;
  }

  const unchanged = drag.mode !== "create"
    && drag.targetDayKey === drag.sourceDayKey
    && drag.startMinutes === (drag.originalStartMinutes ?? drag.startMinutes)
    && drag.endMinutes === (drag.originalEndMinutes ?? drag.endMinutes);

  if (unchanged) {
    state.scheduleDrag = null;
    renderCanvas();
    return;
  }

  const sourceDay = drag.sourceDayKey;
  const targetDay = drag.targetDayKey;
  const start = scheduleMinutesToTime(drag.startMinutes);
  const end = scheduleMinutesToTime(drag.endMinutes);

  if (sourceDay && Number.isInteger(drag.sourcePeriodIndex) && drag.sourcePeriodIndex >= 0) {
    schedule.days[sourceDay].splice(drag.sourcePeriodIndex, 1);
    schedule.days[sourceDay] = normalizeScheduleDayPeriods(schedule.days[sourceDay]);
  }

  schedule.days[targetDay].push({ start, end });
  schedule.days[targetDay] = normalizeScheduleDayPeriods(schedule.days[targetDay]);

  const nextPeriodIndex = schedule.days[targetDay].findIndex((period) => period.start === start && period.end === end);
  selectSchedulePeriod(drag.scheduleIndex, targetDay, nextPeriodIndex);

  state.scheduleDrag = null;
  markSchedulesDirty();
  renderScheduleSidebar();
  renderCanvas();
  renderInspector();
}

function updateScheduleDrag(event) {
  const drag = state.scheduleDrag;
  if (!drag) return;

  if (drag.mode === "create") {
    const minute = scheduleTrackMinutesFromClient(drag.targetDayKey, event.clientX);
    let startMinutes = Math.min(drag.anchorMinutes, minute);
    let endMinutes = Math.max(drag.anchorMinutes, minute);
    if (endMinutes - startMinutes < SCHEDULE_MIN_DURATION_MINUTES) {
      if (minute >= drag.anchorMinutes) {
        endMinutes = Math.min(SCHEDULE_MAX_MINUTE, startMinutes + SCHEDULE_MIN_DURATION_MINUTES);
      } else {
        startMinutes = Math.max(0, endMinutes - SCHEDULE_MIN_DURATION_MINUTES);
      }
    }
    drag.startMinutes = startMinutes;
    drag.endMinutes = endMinutes;
    renderCanvas();
    return;
  }

  if (drag.mode === "move") {
    const dayKey = scheduleTrackDayKeyFromPoint(event.clientX, event.clientY) || drag.targetDayKey || drag.sourceDayKey;
    const minute = scheduleTrackMinutesFromClient(dayKey, event.clientX);
    const startMinutes = Math.max(0, Math.min(SCHEDULE_MAX_MINUTE - drag.durationMinutes, minute - drag.pointerOffsetMinutes));
    drag.targetDayKey = dayKey;
    drag.startMinutes = startMinutes;
    drag.endMinutes = Math.min(SCHEDULE_MAX_MINUTE, startMinutes + drag.durationMinutes);
    renderCanvas();
    return;
  }

  if (drag.mode === "resize-start") {
    const minute = scheduleTrackMinutesFromClient(drag.targetDayKey, event.clientX, SCHEDULE_RESIZE_SNAP_MINUTES);
    drag.startMinutes = Math.max(0, Math.min(drag.endMinutes - SCHEDULE_MIN_DURATION_MINUTES, minute));
    renderCanvas();
    return;
  }

  if (drag.mode === "resize-end") {
    const minute = scheduleTrackMinutesFromClient(drag.targetDayKey, event.clientX, SCHEDULE_RESIZE_SNAP_MINUTES);
    drag.endMinutes = Math.min(SCHEDULE_MAX_MINUTE, Math.max(drag.startMinutes + SCHEDULE_MIN_DURATION_MINUTES, minute));
    renderCanvas();
  }
}

function normalizeRecordingPresetColor(value) {
  const raw = String(value || "#c6a14b").trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(raw)) {
    return raw;
  }
  return "#c6a14b";
}

function normalizeRecordingPresetName(value) {
  return String(value || "").trim() || "Recording";
}

function slugifyRecordingPresetName(value) {
  return normalizeRecordingPresetName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "recording";
}

function recordingPresetIdentity(name) {
  return normalizeRecordingPresetName(name).toLowerCase();
}

function recordingPresetKey(name) {
  return slugifyRecordingPresetName(name);
}

function normalizeRecordingPresetRecord(item = {}) {
  const name = normalizeRecordingPresetName(item.name);
  const color = normalizeRecordingPresetColor(item.color);
  return {
    key: String(item.key || "").trim() || recordingPresetKey(name),
    name,
    color,
    _original_name: String(item._original_name ?? item.name ?? "").trim(),
  };
}

function recordingPresetByName(name) {
  const wanted = recordingPresetIdentity(name);
  return currentRecordingPresets().find((item) => recordingPresetIdentity(item.name) === wanted) || null;
}

function recordingPresetOptionsHtml(selected = "") {
  const options = [`<option value="">Select tag</option>`];
  for (const preset of currentRecordingPresets()) {
    options.push(
      `<option value="${escapeHtml(preset.name)}" ${recordingPresetIdentity(preset.name) === recordingPresetIdentity(selected) ? "selected" : ""}>${escapeHtml(preset.name)}</option>`
    );
  }
  if (selected && !recordingPresetByName(selected)) {
    options.push(`<option value="${escapeHtml(selected)}" selected>[Missing tag] ${escapeHtml(selected)}</option>`);
  }
  return options.join("");
}

function nextRecordingPresetName() {
  const existing = new Set(currentRecordingPresets().map((item) => recordingPresetIdentity(item.name)));
  let idx = currentRecordingPresets().length + 1;
  while (existing.has(recordingPresetIdentity(`Tag ${idx}`))) {
    idx += 1;
  }
  return `Tag ${idx}`;
}

function applyRecordingPresetToDraft(previousName, nextPreset) {
  const flow = currentFlow();
  if (!flow) return;
  const previousIdentity = recordingPresetIdentity(previousName);

  for (const node of (flow.nodes || [])) {
    if (node?.type !== "action.record") continue;
    const cfg = node.config || {};
    const currentIdentity = recordingPresetIdentity(cfg.preset_name || cfg.name);
    if (currentIdentity !== previousIdentity) continue;

    if (nextPreset) {
      cfg.preset_name = nextPreset.name;
      cfg.preset_key = nextPreset.key;
      cfg.name = nextPreset.name;
      cfg.color = nextPreset.color;
    } else {
      delete cfg.preset_name;
      cfg.preset_key = recordingPresetKey(cfg.name || previousName || "Recording");
    }
  }
}

function recordNodeTag(node) {
  if (node?.type !== "action.record") return null;
  const cfg = node.config || {};
  const preset = recordingPresetByName(cfg.preset_name || cfg.name);
  const name = String(preset?.name || cfg.preset_name || cfg.name || "").trim();
  const color = normalizeRecordingPresetColor(preset?.color || cfg.color || "#c6a14b");
  if (!name) return null;
  return { name, color };
}

function makeId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function deviceOptionsHtml(selected = "") {
  const options = [`<option value="">Select device</option>`];
  for (const device of state.devices) {
    options.push(
      `<option value="${escapeHtml(device.id)}" ${device.id === selected ? "selected" : ""}>${escapeHtml(device.name)}</option>`
    );
  }
  return options.join("");
}

function variableKeyOptionsHtml(selected = "", { includePhysical = true } = {}) {
  const vars = currentPublicVariables().filter((variable) => includePhysical || normalizeVariableSource(variable.source) !== "physical_input");
  const options = [`<option value="">Select variable</option>`];
  for (const variable of vars) {
    options.push(
      `<option value="${escapeHtml(variable.key)}" ${variable.key === selected ? "selected" : ""}>${escapeHtml(variable.key)}</option>`
    );
  }
  return options.join("");
}

function normalizeVariableTypeChoice(value) {
  const selected = String(value || "string").trim().toLowerCase();
  return ["string", "number", "boolean", "json", "schedule", "physical_input"].includes(selected)
    ? selected
    : "string";
}

function physicalKindFromVariableTypeChoice(value) {
  const selected = normalizeVariableTypeChoice(value);
  return selected === "physical_input" ? "digital" : "";
}

function publicVariableTypeChoice(variable = {}) {
  const source = normalizeVariableSource(variable.source);
  if (source !== "physical_input") {
    return normalizeVariableTypeChoice(variable.type);
  }

  return "physical_input";
}

function variableTypeOptionsHtml(selected = "string") {
  return [
    ["string", "String"],
    ["number", "Number"],
    ["boolean", "Boolean"],
    ["json", "JSON"],
    ["schedule", "Schedule"],
    ["physical_input", "Physical I/O"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === normalizeVariableTypeChoice(selected) ? "selected" : ""}>${label}</option>`)
    .join("");
}

function sourceOptionsHtml(selected = "literal", allowPhysicalInput = false, literalLabel = "Literal") {
  const options = [
    ["literal", literalLabel],
    ["variable", "Variable"],
    ["trigger", "Trigger path"],
  ];

  if (allowPhysicalInput) {
    options.push(["physical_input", "Physical I/O"]);
  }

  return options
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function compareOperatorOptionsHtml(selected = "equals") {
  const options = state.catalog?.operators || [];
  return options
    .map((item) => `<option value="${item.value}" ${item.value === selected ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");
}

function castOptionsHtml(selected = "auto") {
  return [
    ["auto", "Auto"],
    ["string", "String"],
    ["number", "Number"],
    ["boolean", "Boolean"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function methodOptionsHtml(selected = "POST", allowAny = false) {
  const out = [];
  if (allowAny) {
    out.push(`<option value="ANY" ${selected === "ANY" ? "selected" : ""}>Any</option>`);
  }
  for (const method of (state.catalog?.http_methods || ["GET", "POST", "PUT", "PATCH", "DELETE"])) {
    out.push(`<option value="${method}" ${selected === method ? "selected" : ""}>${method}</option>`);
  }
  return out.join("");
}

function physicalCatalog() {
  return state.catalog?.physical_io || DEFAULT_PHYSICAL_IO;
}

function physicalStateKey(kind) {
  const normalized = String(kind || "digital").trim().toLowerCase();
  if (normalized === "analog") return "analog_inputs";
  if (normalized === "output") return "outputs";
  if (normalized === "relay") return "relays";
  return "digital_inputs";
}

function physicalChannels(kind) {
  const key = physicalStateKey(kind);
  const items = physicalCatalog()?.[key];
  return Array.isArray(items) && items.length ? items : DEFAULT_PHYSICAL_IO[key];
}

function physicalInputKindOptionsHtml(selected = "digital") {
  return [
    ["digital", "Digital input"],
    ["analog", "Analog input"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function physicalValueSourceKindOptionsHtml(selected = "digital") {
  return [
    ["digital", "Digital input"],
    ["analog", "Analog input"],
    ["output", "Output"],
    ["relay", "Relay"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function physicalChannelOptionsHtml(kind, selected = "") {
  return physicalChannels(kind)
    .map((item) => `<option value="${escapeHtml(item.channel)}" ${String(item.channel) === String(selected) ? "selected" : ""}>${escapeHtml(item.label)}</option>`)
    .join("");
}

function physicalInputChannelOptionsHtml(kind, selected = "") {
  return physicalChannelOptionsHtml(kind, selected);
}

function physicalOutputOptionsHtml(selected = "") {
  return physicalChannelOptionsHtml("output", selected);
}

function physicalRelayOptionsHtml(selected = "") {
  return physicalChannelOptionsHtml("relay", selected);
}

function physicalTargetKindOptionsHtml(selected = "output") {
  return [
    ["output", "Output"],
    ["relay", "Relay"],
  ]
    .map(([value, label]) => `<option value="${value}" ${value === selected ? "selected" : ""}>${label}</option>`)
    .join("");
}

function normalizePhysicalChannelSelection(kind, value) {
  const options = physicalChannels(kind);
  if (!options.length) return "";
  const wanted = String(value || "");
  const match = options.find((item) => String(item.channel) === wanted);
  return String((match || options[0]).channel);
}

function physicalEntry(kind, channel) {
  const key = physicalStateKey(kind);
  const items = state.physicalState?.[key];
  if (!Array.isArray(items)) return null;
  return items.find((item) => String(item.channel) === String(channel)) || null;
}

function physicalLabel(kind, channel) {
  return physicalEntry(kind, channel)?.label
    || physicalChannels(kind).find((item) => String(item.channel) === String(channel))?.label
    || `${kind} ${channel}`;
}

function formatPhysicalValue(kind, value) {
  if (value == null || value === "") {
    if (state.physicalState?.available === false && state.physicalState?.error) return "Unavailable";
    return "Loading...";
  }

  if (kind === "analog") {
    const number = Number(value);
    return Number.isFinite(number) ? `${number.toFixed(2)} V` : String(value);
  }

  if (kind === "output" || kind === "relay") {
    return Number(value) ? "On" : "Off";
  }

  return Number(value) ? "High" : "Low";
}

function formatPhysicalUpdatedTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return String(value);
  }
}

function physicalMetaText() {
  if (!state.physicalState) return "Loading physical I/O...";
  if (state.physicalState.available) {
    const updated = formatPhysicalUpdatedTime(state.physicalState.updated_at);
    return updated ? `Live value updated ${updated}` : "Live value available";
  }
  return state.physicalState.error || "Physical I/O unavailable.";
}

function physicalLiveValueText(kind, channel) {
  return formatPhysicalValue(kind, physicalEntry(kind, channel)?.value);
}

function formatAnalogThreshold(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

function formatSecondsLabel(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "0s";
  if (Math.abs(seconds - Math.round(seconds)) < 0.001) return `${Math.round(seconds)}s`;
  return `${seconds.toFixed(1)}s`;
}

function flowSummary(flow) {
  const nodes = flow.nodes || [];
  const triggers = nodes.filter((node) => node.category === "trigger").length;
  const conditions = nodes.filter((node) => node.category === "condition").length;
  const operators = nodes.filter((node) => node.category === "operator").length;
  const actions = nodes.filter((node) => node.category === "action").length;
  return `${triggers} trigger${triggers === 1 ? "" : "s"} · ${conditions} condition${conditions === 1 ? "" : "s"} · ${operators} operator${operators === 1 ? "" : "s"} · ${actions} action${actions === 1 ? "" : "s"}`;
}

function flowVariableLabel(key) {
  const raw = String(key || "").trim();
  return raw || "variable";
}

function displayNodeTitle(node) {
  if (!node) return "";
  const raw = String(node.label || "").trim();

  if (node.type === "condition.compare" && (!raw || raw === "Compare" || raw === "If")) {
    return "Compare";
  }

   if (node.type === "condition.schedule_active" && (!raw || raw === "Schedule active")) {
    return "Schedule active";
  }

  return raw || "";
}

function compareOperatorLabel(value) {
  const map = {
    equals: "is",
    not_equals: "is not",
    contains: "contains",
    not_contains: "does not contain",
    greater_than: "is greater than",
    greater_than_or_equal: "is greater than or equal to",
    less_than: "is less than",
    less_than_or_equal: "is less than or equal to",
    is_true: "is true",
    is_false: "is false",
  };

  return map[value] || String(value || "is");
}

function compareSideLabel(source, value) {
  const src = String(source || "literal").trim().toLowerCase();
  const raw = String(value ?? "").trim();

  if (src === "variable") {
    return flowVariableLabel(raw);
  }

  if (src === "trigger") {
    return raw ? `trigger ${raw}` : "trigger value";
  }

   if (src === "physical_input") {
    const parts = String(value || "digital:1").split(":");
    const inputKind = (parts[0] || "digital").trim().toLowerCase() || "digital";
    const channel = normalizePhysicalChannelSelection(inputKind, parts[1] || "1");
    return `${physicalLabel(inputKind, channel)} (${physicalLiveValueText(inputKind, channel)})`;
  }

  if (!raw) return "empty value";
  if (scheduleByKey(raw)) return scheduleNameForKey(raw);
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase();
  if (!Number.isNaN(Number(raw))) return raw;

  return `"${raw}"`;
}

function renderCompareSourceValueControl(prefix, source, value) {
  const sourceType = String(source || "literal").trim().toLowerCase();

  if (sourceType === "physical_input") {
    const [rawKind = "digital", rawChannel = "1"] = String(value || "digital:1").split(":");
    const inputKind = String(rawKind || "digital").trim().toLowerCase() || "digital";
    const channel = normalizePhysicalChannelSelection(inputKind, rawChannel || "1");
    const currentLabel = inputKind === "analog" ? "Current value" : (inputKind === "output" ? "Current output state" : (inputKind === "relay" ? "Current relay state" : "Current state"));

    return `
      <div class="fieldGrid comparePhysicalSourceFields">
        <div>
          <label>Physical source</label>
          <select id="cfg_${prefix}_input_kind">${physicalValueSourceKindOptionsHtml(inputKind)}</select>
        </div>
        <div>
          <label>Channel</label>
          <select id="cfg_${prefix}_channel">${physicalInputChannelOptionsHtml(inputKind, channel)}</select>
        </div>
        ${renderPhysicalLiveField(inputKind, channel, currentLabel, `${prefix}PhysicalCurrent`)}
      </div>
    `;
  }

  const placeholder = sourceType === "variable"
    ? "armed"
    : (sourceType === "trigger" ? "extra.changed.IsMotion" : "true");

  return `<input id="cfg_${prefix}_value" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder)}" list="variableKeysList" />`;
}

function setVariableSourcePreview(cfg) {
  const source = String(cfg.value_source || "literal").trim().toLowerCase();

  if (source === "variable") {
    return flowVariableLabel(cfg.value || "");
  }

  if (source === "trigger") {
    return cfg.value ? `trigger ${cfg.value}` : "trigger value";
  }

  if (source === "physical_input") {
    const inputKind = String(cfg.value_input_kind || "digital").trim().toLowerCase();
    const channel = normalizePhysicalChannelSelection(inputKind, cfg.value_channel || "1");
    return `${physicalLabel(inputKind, channel)} (${physicalLiveValueText(inputKind, channel)})`;
  }

  if (/{{\s*[^}]+\s*}}/.test(String(cfg.value || ""))) {
    return "template";
  }

  const target = publicVariableByKey(cfg.variable_key || "");
  return compareSideLabel("literal", formatVariableValue(cfg.value, target?.type || "string"));
}

function setVariableTemplateExamples() {
  const variableExamples = currentPublicVariables()
    .slice(0, 3)
    .map((item) => `{{variables.${item.key}}}`);

  return [
    "{{flow.name}}",
    "{{flow.id}}",
    "{{flow.enabled}}",
    "{{trigger.kind}}",
    "{{trigger.trigger_node_id}}",
    "{{trigger.device_id}}",
    "{{trigger.topic}}",
    "{{trigger.path}}",
    "{{trigger.method}}",
    "{{trigger.extra.some_key}}",
    ...variableExamples,
    "{{last.message}}",
    "{{last.value}}",
  ];
}

function renderSetVariableTemplateHelp(cfg) {
  if (String(cfg.value_source || "literal").trim().toLowerCase() !== "literal") {
    return "";
  }

  const target = publicVariableByKey(cfg.variable_key || "");
  if (normalizeVariableType(target?.type || "") !== "string") {
    return "";
  }

  const examples = setVariableTemplateExamples();
  return `
    <div class="full setVariableTemplateHelp">
      <div class="setVariableTemplateHelpTitle">Available placeholders</div>
      <div class="setVariableTemplateHelpText">String literals can include runtime values and render them before assignment.</div>
      <div class="setVariableTemplateHelpChips">
        ${examples.map((item) => `<span class="setVariableTemplateChip">${escapeHtml(item)}</span>`).join("")}
      </div>
    </div>
  `;
}

function displayPortLabel(node, kind, port) {
  if ((node?.type === "condition.compare" || node?.type === "condition.schedule_active") && kind === "output") {
    if (port === "true") return "THEN";
    if (port === "false") return "ELSE";
  }

  return "";
}

function portUiLabel(nodeId, kind, handle) {
  const node = currentFlow()?.nodes.find((item) => item.id === nodeId);
  return displayPortLabel(node, kind, handle) || handle;
}

function nodePreview(node) {
  const cfg = node.config || {};

  switch (node.type) {
    case "trigger.onvif_event": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `${device?.name || cfg.device_id || "device"} → ${cfg.topic || "topic"}`;
    }

    case "trigger.device_offline": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `When ${device?.name || cfg.device_id || "device"} goes offline`;
    }

    case "trigger.device_back_online": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `When ${device?.name || cfg.device_id || "device"} comes back online`;
    }

    case "trigger.ptz_manual_control_started": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `When manual PTZ starts on ${device?.name || cfg.device_id || "device"}`;
    }

    case "trigger.ptz_manual_control_stopped": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `When manual PTZ stops on ${device?.name || cfg.device_id || "device"}`;
    }

    case "trigger.incoming_http_request":
      return `${cfg.method || "ANY"} ${cfg.path || "/"}`;

    case "trigger.manual":
      return "Run this node manually from the editor";

    case "trigger.schedule_active": {
      const schedule = scheduleByKey(cfg.schedule_key || "");
      return `When ${(schedule?.name || cfg.schedule_key || "schedule")} becomes active${schedule ? ` · ${schedule.is_active ? "active now" : "inactive now"}` : ""}`;
    }

    case "trigger.schedule_inactive": {
      const schedule = scheduleByKey(cfg.schedule_key || "");
      return `When ${(schedule?.name || cfg.schedule_key || "schedule")} becomes inactive${schedule ? ` · ${schedule.is_active ? "active now" : "inactive now"}` : ""}`;
    }

    case "trigger.digital_input_changed":
      return `When ${physicalLabel("digital", cfg.channel || "1")} changes · now ${physicalLiveValueText("digital", cfg.channel || "1")}`;

    case "trigger.analog_input_above":
      return `${physicalLabel("analog", cfg.channel || "1")} > ${formatAnalogThreshold(cfg.threshold)} V · now ${physicalLiveValueText("analog", cfg.channel || "1")}`;

    case "trigger.analog_input_below":
      return `${physicalLabel("analog", cfg.channel || "1")} < ${formatAnalogThreshold(cfg.threshold)} V · now ${physicalLiveValueText("analog", cfg.channel || "1")}`;

    case "trigger.physical_output_changed": {
      const targetKind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      const channel = cfg.channel || "1";
      return `When ${physicalLabel(targetKind, channel)} changes · now ${physicalLiveValueText(targetKind, channel)}`;
    }

    case "condition.compare": {
      const left = compareSideLabel(cfg.left_source || "variable", cfg.left_value || "");
      const operator = compareOperatorLabel(cfg.operator || "equals");

      if (cfg.operator === "is_true" || cfg.operator === "is_false") {
        return `If ${left} ${operator}`;
      }

      const right = compareSideLabel(cfg.right_source || "literal", cfg.right_value || "");
      return `If ${left} ${operator} ${right}`;
    }

    case "condition.schedule_active": {
      const schedule = scheduleByKey(cfg.schedule_key || "");
      return `If ${(schedule?.name || cfg.schedule_key || "schedule")} is active${schedule ? ` · ${schedule.is_active ? "active now" : "inactive now"}` : ""}`;
    }

    case "operator.delay":
      return `Wait ${cfg.seconds ?? 0}s`;

    case "operator.set_variable":
      return `${cfg.variable_key || "variable"} ← ${setVariableSourcePreview(cfg)}`;

    case "action.send_http_request":
      return `${cfg.method || "POST"} ${cfg.url || ""}`;

    case "action.activate_physical_output": {
      const targetKind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      const channel = cfg.channel || "1";
      return `${physicalLabel(targetKind, channel)} · ${cfg.mode || "pulse"}${cfg.mode === "pulse" ? ` for ${cfg.pulse_seconds || 0}s` : ""} · now ${physicalLiveValueText(targetKind, channel)}`;
    }

    case "action.activate_physical_relay":
      return `${physicalLabel("relay", cfg.channel || "1")} · ${cfg.mode || "pulse"}${cfg.mode === "pulse" ? ` for ${cfg.pulse_seconds || 0}s` : ""} · now ${physicalLiveValueText("relay", cfg.channel || "1")}`;

    case "action.record": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      const label = device?.name || cfg.device_id || "camera";
      return `${label} · start · -${formatSecondsLabel(cfg.before_seconds ?? 0)}`;
    }

    case "action.stop_recording": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      const label = device?.name || cfg.device_id || "camera";
      return `${label} · stop`;
    }

    case "action.log_message":
      return cfg.message || "Log message";

    default:
      return node.label;
  }
}

function starterFlow() {
  return {
    id: null,
    name: "New flow",
    enabled: true,
    nodes: [],
    edges: [],
  };
}

function centerBoardViewport() {
  const scroller = el("flowBoardScroller");
  const board = el("flowBoard");
  const nodesBox = el("flowNodes");

  if (!scroller || !board || !nodesBox) return;

  const nodeEls = [...nodesBox.querySelectorAll(".flowNode")];

  if (!nodeEls.length) {
    const left = Math.max(0, (board.scrollWidth - scroller.clientWidth) / 2);
    const top = Math.max(0, (board.scrollHeight - scroller.clientHeight) / 2);

    scroller.scrollLeft = left;
    scroller.scrollTop = top;
    drawEdges();
    return;
  }

  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;

  for (const nodeEl of nodeEls) {
    const left = nodeEl.offsetLeft;
    const top = nodeEl.offsetTop;
    const right = left + nodeEl.offsetWidth;
    const bottom = top + nodeEl.offsetHeight;

    if (left < minLeft) minLeft = left;
    if (top < minTop) minTop = top;
    if (right > maxRight) maxRight = right;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  const padding = 120;
  const contentCenterX = (minLeft + maxRight) / 2;
  const contentCenterY = (minTop + maxBottom) / 2;

  const maxScrollLeft = Math.max(0, board.scrollWidth - scroller.clientWidth);
  const maxScrollTop = Math.max(0, board.scrollHeight - scroller.clientHeight);

  const targetLeft = Math.min(
    maxScrollLeft,
    Math.max(0, contentCenterX - scroller.clientWidth / 2)
  );
  const targetTop = Math.min(
    maxScrollTop,
    Math.max(0, contentCenterY - scroller.clientHeight / 2)
  );

  scroller.scrollLeft = Math.max(
    0,
    Math.min(maxScrollLeft, targetLeft - padding / 2)
  );
  scroller.scrollTop = Math.max(
    0,
    Math.min(maxScrollTop, targetTop - padding / 2)
  );

  drawEdges();
}

function syncHeader() {
  const flow = currentFlow();
  const title = flow?.name || "New flow";

  if (el("flowHeading")) {
    el("flowHeading").textContent = title;
  }

  if (el("flowMetaText")) {
    el("flowMetaText").textContent = flow?.id
      ? (state.dirty ? "Editing saved flow · unsaved changes" : "Editing saved flow")
      : (state.dirty ? "Unsaved draft · changes pending" : "Unsaved draft");
  }

  for (const buttonId of ["btnDeleteFlow", "btnInspectorDeleteFlow"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = !flow?.id;
    }
  }

  for (const buttonId of ["btnSaveFlow", "btnInspectorSaveFlow"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = !flow || !state.dirty;
    }
  }
}

function confirmDiscard() {
  if (!state.dirty) return true;
  return window.confirm("You have unsaved changes. Discard them?");
}

function loadSidebarSectionState() {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_SECTION_STATE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    for (const [sectionId, section] of Object.entries(state.sidebarSections)) {
      if (typeof parsed[sectionId] !== "boolean") continue;
      section.expanded = parsed[sectionId];
      section.touched = true;
    }
  } catch {
    // Ignore invalid or unavailable local storage.
  }
}

function persistSidebarSectionState() {
  try {
    const payload = Object.fromEntries(
      Object.entries(state.sidebarSections).map(([sectionId, section]) => [sectionId, !!section.expanded])
    );
    window.localStorage.setItem(SIDEBAR_SECTION_STATE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore unavailable local storage.
  }
}

function sidebarSectionExpanded(sectionId, hasItems = true) {
  const section = state.sidebarSections[sectionId];
  if (!section) return true;
  return section.touched ? !!section.expanded : true;
}

function syncSidebarSection(sectionId, hasItems = true) {
  const block = document.querySelector(`[data-sidebar-section="${sectionId}"]`);
  if (!block) return;

  const expanded = sidebarSectionExpanded(sectionId, hasItems);
  block.dataset.hasItems = hasItems ? "true" : "false";
  block.classList.toggle("is-collapsed", !expanded);

  const toggle = block.querySelector("[data-sidebar-toggle]");
  if (!toggle) return;

  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function setSidebarSectionExpanded(sectionId, expanded) {
  const section = state.sidebarSections[sectionId];
  if (!section) return;
  section.expanded = !!expanded;
  section.touched = true;
  persistSidebarSectionState();
  syncSidebarSection(sectionId, document.querySelector(`[data-sidebar-section="${sectionId}"]`)?.dataset.hasItems !== "false");
}

function renderFlowList() {
  const q = (el("flowSearch")?.value || "").trim().toLowerCase();
  const activeFlow = currentFlow();
  const items = state.flows.filter((flow) => {
    if (!q) return true;
    return [flow.name, flowSummary(flow)].join(" ").toLowerCase().includes(q);
  });

  const box = el("flowList");
  if (!box) return;

  syncSidebarSection("saved", Boolean(activeFlow) || items.length > 0);

  const neutralCard = !activeFlow?.id ? `
    <div class="flowListItem flowListCurrent active" data-current-flow="true">
      <div class="flowListItemTop">
        <div>
          <div class="flowListItemName">${escapeHtml(activeFlow?.name || "New flow")}</div>
          <div class="flowListItemMeta">Unsaved draft</div>
        </div>
        <div class="miniPill ${(activeFlow?.enabled ?? true) ? "enabled" : "disabled"}">${(activeFlow?.enabled ?? true) ? "Enabled" : "Disabled"}</div>
      </div>
      <div class="chipRow">
        <span class="miniPill">${activeFlow?.nodes?.length || 0} nodes</span>
        <span class="miniPill">${activeFlow?.edges?.length || 0} links</span>
      </div>
      <div class="flowListActions">
        <button class="btn btn-primary btn-compact" id="btnNewFlow" type="button">New</button>
        <button class="btn btn-compact" id="btnSaveFlow" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeleteFlow" type="button">Delete</button>
        <button class="btn btn-compact" id="btnDuplicateFlow" type="button">Duplicate</button>
        <button class="btn btn-compact" id="btnExportFlows" type="button">Export</button>
        <button class="btn btn-compact" id="btnImportFlows" type="button">Import</button>
      </div>
    </div>` : "";

  box.innerHTML = `
    ${neutralCard}
    ${items.length ? items.map((flow) => `
    <div class="flowListItem ${flow.id === state.selectedSavedFlowId ? "active flowListCurrent" : ""}" ${flow.id === state.selectedSavedFlowId ? 'data-current-flow="true"' : ""} data-id="${escapeHtml(flow.id)}">
      <div class="flowListItemTop">
        <div>
          <div class="flowListItemName">${escapeHtml(flow.name)}</div>
          <div class="flowListItemMeta">${escapeHtml(flowSummary(flow))}</div>
        </div>
        <div class="miniPill ${flow.enabled ? "enabled" : ""}">${flow.enabled ? "Enabled" : "Disabled"}</div>
      </div>
      <div class="chipRow">
        <span class="miniPill">${flow.nodes.length} nodes</span>
        <span class="miniPill">${flow.edges.length} links</span>
      </div>
      ${flow.id === state.selectedSavedFlowId ? `
      <div class="flowListActions">
        <button class="btn btn-primary btn-compact" id="btnNewFlow" type="button">New</button>
        <button class="btn btn-compact" id="btnSaveFlow" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeleteFlow" type="button">Delete</button>
        <button class="btn btn-compact" id="btnDuplicateFlow" type="button">Duplicate</button>
        <button class="btn btn-compact" id="btnExportFlows" type="button">Export</button>
        <button class="btn btn-compact" id="btnImportFlows" type="button">Import</button>
      </div>` : ""}
    </div>
  `).join("") : ""}
  `;

  bindFlowActionButtons();
  syncHeader();

  box.querySelector(".flowListCurrent")?.addEventListener("click", () => {
    clearEditorSelection();
    renderInspector();
    renderCanvas();
    drawEdges();
  });

  box.querySelectorAll(".flowListItem[data-id]:not(.flowListCurrent)").forEach((node) => {
    node.addEventListener("click", () => {
      const flow = state.flows.find((item) => item.id === node.dataset.id);
      if (!flow) return;
      if (!confirmDiscard()) return;

      state.selectedSavedFlowId = flow.id;
      state.draft = deepClone(flow);
      clearEditorSelection();
      state.connecting = null;
      state.connectionCursor = null;

      clearDirty();
      clearTestResult();
      renderAll();
      window.requestAnimationFrame(centerBoardViewport);
      setStatus(`Loaded flow "${flow.name}".`);
    });
  });
}

function handleNewFlow() {
  if (!confirmDiscard()) return;

  state.selectedSavedFlowId = null;
  state.draft = starterFlow();
  clearEditorSelection();
  state.connecting = null;
  state.connectionCursor = null;

  clearDirty();
  clearTestResult();
  renderAll();
  window.requestAnimationFrame(centerBoardViewport);
  setStatus("Started a new flow.");
}

function draftHasExportableContent(flow) {
  if (!flow) return false;
  const name = String(flow.name || "").trim();
  return (flow.nodes || []).length > 0
    || (flow.edges || []).length > 0
    || (name && name !== starterFlow().name);
}

function normalizedFlowName(name) {
  return String(name || "").trim().toLowerCase();
}

function makeUniqueFlowName(baseName, { excludeId = null, reservedNames = null } = {}) {
  const base = String(baseName || "").trim() || "New flow";
  const used = reservedNames instanceof Set
    ? new Set([...reservedNames].map((name) => normalizedFlowName(name)))
    : new Set();

  for (const flow of state.flows || []) {
    if (excludeId && flow.id === excludeId) continue;
    used.add(normalizedFlowName(flow.name));
  }

  if (!used.has(normalizedFlowName(base))) {
    return base;
  }

  let index = 2;
  while (used.has(normalizedFlowName(`${base} ${index}`))) {
    index += 1;
  }
  return `${base} ${index}`;
}

function importedFlowName(name, index, reservedNames) {
  const base = String(name || "").trim() || `Imported flow ${index + 1}`;
  const nextName = makeUniqueFlowName(`${base} (imported)`, { reservedNames });
  reservedNames?.add(nextName);
  return nextName;
}

function exportedFlowItem() {
  const draft = currentFlow();
  if (!draft) return null;

  return {
    ...(draft.id ? { id: draft.id } : {}),
    ...serializeFlow(draft),
  };
}

function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function buildFlowImportPayload(item, index, reservedNames) {
  if (!item || typeof item !== "object") {
    throw new Error(`Imported flow ${index + 1} is not an object.`);
  }

  return serializeFlow({
    name: importedFlowName(item.name, index, reservedNames),
    enabled: item.enabled !== false,
    nodes: Array.isArray(item.nodes) ? item.nodes : [],
    edges: Array.isArray(item.edges) ? item.edges : [],
  });
}

function pickJsonFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const [file] = Array.from(input.files || []);
      input.remove();
      resolve(file || null);
    }, { once: true });

    input.click();
  });
}

async function readTextFile(file) {
  return await file.text();
}

function importableFlowItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.flows)) return payload.flows;
  return [];
}

function importSelectionTarget(importedIds = []) {
  const preferredId = importedIds.find((id) => id && state.flows.some((flow) => flow.id === id));
  if (preferredId) return state.flows.find((flow) => flow.id === preferredId) || null;

  const currentId = currentFlow()?.id;
  if (currentId) {
    const existing = state.flows.find((flow) => flow.id === currentId);
    if (existing) return existing;
  }

  return state.flows[0] || null;
}

function exportFlows() {
  const item = exportedFlowItem();
  if (!item) {
    setStatus("No flow selected to export.", true);
    return;
  }

  const exportName = String(item.name || "flow").trim() || "flow";
  const safeName = exportName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";

  downloadJsonFile(`${safeName}-export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`, {
    version: 1,
    exported_at: new Date().toISOString(),
    items: [item],
  });
  setStatus(`Exported flow "${item.name}".`);
}

async function importFlows() {
  if (!confirmDiscard()) return;

  const file = await pickJsonFile();
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await readTextFile(file));
  } catch {
    setStatus("Failed to read flows import file.", true);
    return;
  }

  const rawItems = importableFlowItems(payload);
  if (!rawItems.length) {
    setStatus("No flows found in the import file.", true);
    return;
  }

  const reservedNames = new Set((state.flows || []).map((flow) => flow.name));
  const prepared = rawItems.map((item, index) => buildFlowImportPayload(item, index, reservedNames));

  try {
    const importedIds = [];

    for (const item of prepared) {
      const out = await api(`/api/flows`, {
        method: "POST",
        body: JSON.stringify(item),
      });
      if (out?.item?.id) importedIds.push(out.item.id);
    }

    await refreshFlows();
    const nextFlow = importSelectionTarget(importedIds);
    state.selectedSavedFlowId = nextFlow?.id || null;
    state.draft = nextFlow ? deepClone(nextFlow) : starterFlow();
    clearEditorSelection();
    state.connecting = null;
    state.connectionCursor = null;
    clearDirty();
    clearTestResult();
    renderAll();
    window.requestAnimationFrame(centerBoardViewport);
    setStatus(`Imported ${prepared.length} flow${prepared.length === 1 ? "" : "s"}.`);
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

async function handleSaveFlow() {
  try {
    await saveFlow();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

async function handleDeleteFlow() {
  if (!currentFlow()?.id) return;
  if (!window.confirm("Delete this flow?")) return;

  try {
    await deleteDraft();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function bindFlowActionButtons() {
  el("btnNewFlow")?.addEventListener("click", (event) => {
    event.stopPropagation();
    handleNewFlow();
  });

  el("btnSaveFlow")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handleSaveFlow();
  });

  el("btnDuplicateFlow")?.addEventListener("click", (event) => {
    event.stopPropagation();
    duplicateDraft();
  });

  el("btnDeleteFlow")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handleDeleteFlow();
  });

  el("btnExportFlows")?.addEventListener("click", (event) => {
    event.stopPropagation();
    exportFlows();
  });

  el("btnImportFlows")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await importFlows();
  });
}

function renderPalette() {
  const q = (el("paletteSearch")?.value || "").trim().toLowerCase();
  const groups = new Map();

  for (const item of state.catalog?.nodes || []) {
    const haystack = [
      item.label,
      item.type,
      item.category,
      item.description || "",
    ].join(" ").toLowerCase();

    if (q && !haystack.includes(q)) continue;

    const list = groups.get(item.category) || [];
    list.push(item);
    groups.set(item.category, list);
  }

  const box = el("paletteGroups");
  if (!box) return;

  syncSidebarSection("palette", groups.size > 0);

  if (!groups.size) {
    box.innerHTML = `<div class="emptyState">No palette blocks found.</div>`;
    return;
  }

  box.innerHTML = [...groups.entries()].map(([category, items]) => `
    <div class="paletteGroup">
      <div class="paletteGroupHead">${escapeHtml(category)}</div>
      <div class="paletteGroupBody">
        ${items.map((item) => `
          <button class="paletteItem" type="button" data-type="${escapeHtml(item.type)}">
            <div class="paletteItemTitle">${escapeHtml(item.label)}</div>
            <div class="paletteItemSub">${escapeHtml(item.description || "")}</div>
          </button>
        `).join("")}
      </div>
    </div>
  `).join("");

  box.querySelectorAll(".paletteItem").forEach((button) => {
    button.addEventListener("click", () => addNodeFromPalette(button.dataset.type));
  });
}

function addNodeFromPalette(type) {
  const flow = currentFlow();
  const def = nodeDef(type);
  if (!flow || !def) return;

  const boardScroller = el("flowBoardScroller");
  const x = (boardScroller?.scrollLeft || 0) + 220;
  const y = (boardScroller?.scrollTop || 0) + 150;

  const node = {
    id: makeId("node"),
    type: def.type,
    category: def.category,
    label: def.label,
    x,
    y,
    config: deepClone(def.defaults || {}),
  };

  flow.nodes.push(node);
  selectNode(node.id);

  markDirty();
  renderAll();
}

function renderCanvas() {
  const flow = currentFlow();
  const nodesBox = el("flowNodes");
  const hint = el("emptyBoardHint");
  const boardWrap = document.querySelector(".flowBoardWrap");
  const scheduleWorkspace = el("scheduleWorkspace");
  const boardStatusLine = el("boardStatusLine");
  const scheduleViewport = document.getElementById("schedulePlannerViewport");

  if (scheduleViewport) {
    state.scheduleViewportScrollTop = scheduleViewport.scrollTop;
    state.scheduleViewportScrollLeft = scheduleViewport.scrollLeft;
  }

  if (!nodesBox || !hint) return;

  const schedule = currentSelectedSchedule();
  if (isScheduleEditing() && schedule && scheduleWorkspace) {
    state.scheduleBlockResizeObserver?.disconnect();
    state.scheduleBlockResizeObserver = null;
    boardWrap?.classList.add("hidden");
    boardStatusLine?.classList.add("hidden");
    scheduleWorkspace.classList.remove("hidden");
    scheduleWorkspace.innerHTML = renderSchedulePlannerWorkspace(schedule, state.selectedScheduleIndex);
    bindScheduleWorkspace(state.selectedScheduleIndex);
    return;
  }

  boardWrap?.classList.remove("hidden");
  boardStatusLine?.classList.remove("hidden");
  state.scheduleBlockResizeObserver?.disconnect();
  state.scheduleBlockResizeObserver = null;
  if (scheduleWorkspace) {
    scheduleWorkspace.classList.add("hidden");
    scheduleWorkspace.innerHTML = "";
  }

  if (!flow) {
    nodesBox.innerHTML = "";
    hint.classList.remove("hidden");
    drawEdges();
    return;
  }

  hint.classList.toggle("hidden", flow.nodes.length > 0);

  nodesBox.innerHTML = flow.nodes.map((node) => {
    const def = nodeDef(node.type);
    const ports = def?.ports || { inputs: [], outputs: [] };
    const meta = CATEGORY_META[node.category] || CATEGORY_META.action;
    const tag = recordNodeTag(node);

    return `
      <div class="flowNode ${node.category} ${node.id === state.selectedNodeId ? "selected" : ""}" data-node-id="${escapeHtml(node.id)}" style="left:${Number(node.x) || 0}px; top:${Number(node.y) || 0}px;">
        <div class="flowNodeTop">
          <div>
            <div class="flowNodeLabel">${escapeHtml(displayNodeTitle(node) || node.label)}</div>
            <div class="flowNodeType">${escapeHtml(meta.label)}</div>
          </div>
          <span class="nodeBadge">${escapeHtml(meta.label)}</span>
        </div>

        ${tag ? `
          <div class="flowNodeTagRow">
            <span class="flowNodeTagChip">
              <span class="flowNodeTagSwatch" style="background:${escapeHtml(tag.color)};"></span>
              <span class="flowNodeTagText">${escapeHtml(tag.name)}</span>
            </span>
          </div>
        ` : ""}

        <div class="flowNodePreview" data-node-preview-id="${escapeHtml(node.id)}">${escapeHtml(nodePreview(node))}</div>

        ${node.type === "trigger.manual" ? `
          <div class="mt-10">
            <button class="btn flowNodeRunBtn" type="button" data-run-node-id="${escapeHtml(node.id)}">Run</button>
          </div>
        ` : ""}

        <div class="flowNodePorts">
          <div class="portStack inputs">
            ${ports.inputs.map((port) => `
              <div class="flowPortRow input">
                <button class="flowPort ${state.connecting && state.connecting.nodeId === node.id && state.connecting.handle === port && state.connecting.kind === "input" ? "active" : ""}" type="button" data-port-kind="input" data-port-handle="${escapeHtml(port)}" data-node-id="${escapeHtml(node.id)}"></button>
                ${displayPortLabel(node, "input", port) ? `
                  <span class="flowBranchLabel neutral">${escapeHtml(displayPortLabel(node, "input", port))}</span>
                ` : ""}
              </div>
            `).join("")}
          </div>

          <div class="portStack outputs">
            ${ports.outputs.map((port) => `
              <div class="flowPortRow output">
                ${displayPortLabel(node, "output", port) ? `
                  <span class="flowBranchLabel ${port === "true" ? "then" : port === "false" ? "else" : "neutral"}">
                    ${escapeHtml(displayPortLabel(node, "output", port))}
                  </span>
                ` : ""}
                <button class="flowPort ${state.connecting && state.connecting.nodeId === node.id && state.connecting.handle === port && state.connecting.kind === "output" ? "active" : ""}" type="button" data-port-kind="output" data-port-handle="${escapeHtml(port)}" data-node-id="${escapeHtml(node.id)}"></button>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }).join("");

  nodesBox.querySelectorAll(".flowNode").forEach((nodeEl) => {
    const nodeId = nodeEl.dataset.nodeId;

    nodeEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (ev.target.closest(".flowPort")) return;
      if (ev.target.closest(".flowNodeRunBtn")) return;

      selectNode(nodeId);
      renderInspector();
      renderCanvas();
      drawEdges();
    });

    nodeEl.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest(".flowPort")) return;
      if (ev.target.closest(".flowNodeRunBtn")) return;

      const node = currentFlow().nodes.find((item) => item.id === nodeId);
      if (!node) return;

      selectNode(nodeId);
      state.drag = {
        nodeId,
        startX: ev.clientX,
        startY: ev.clientY,
        originX: node.x,
        originY: node.y,
      };

      nodeEl.classList.add("dragging");
      renderInspector();
      ev.preventDefault();
    });
  });

  nodesBox.querySelectorAll(".flowPort").forEach((portEl) => {
    portEl.addEventListener("click", (ev) => {
      ev.stopPropagation();

      const kind = portEl.dataset.portKind;
      const nodeId = portEl.dataset.nodeId;
      const handle = portEl.dataset.portHandle || (kind === "input" ? "in" : "out");

      const board = el("flowBoard");
      let cursor = null;

      if (board) {
        const rect = board.getBoundingClientRect();
        cursor = {
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        };
      }

      if (!state.connecting) {
        state.connecting = { nodeId, handle, kind };
        state.connectionCursor = cursor;
        selectNode(nodeId);
        renderAll();

        const uiHandle = portUiLabel(nodeId, kind, handle);
        setStatus(
          kind === "input"
            ? `Connection started from input "${uiHandle}". Click an output port to finish.`
            : `Connection started from output "${uiHandle}". Click an input port to finish.`
        );
        return;
      }

      if (
        state.connecting.nodeId === nodeId &&
        state.connecting.handle === handle &&
        state.connecting.kind === kind
      ) {
        state.connecting = null;
        state.connectionCursor = null;
        renderAll();
        setStatus("Connection cancelled.");
        return;
      }

      if (state.connecting.kind === kind) {
        state.connecting = { nodeId, handle, kind };
        state.connectionCursor = cursor;
        selectNode(nodeId);
        renderAll();

        const uiHandle = portUiLabel(nodeId, kind, handle);
        setStatus(
          kind === "input"
            ? `Connection restarted from input "${uiHandle}". Click an output port to finish.`
            : `Connection restarted from output "${uiHandle}". Click an input port to finish.`
        );
        return;
      }

      const sourceNodeId = state.connecting.kind === "output" ? state.connecting.nodeId : nodeId;
      const sourceHandle = state.connecting.kind === "output" ? state.connecting.handle : handle;
      const targetNodeId = state.connecting.kind === "input" ? state.connecting.nodeId : nodeId;
      const targetHandle = state.connecting.kind === "input" ? state.connecting.handle : handle;

      const duplicate = currentFlow().edges.some((edge) =>
        edge.source === sourceNodeId &&
        edge.source_handle === sourceHandle &&
        edge.target === targetNodeId &&
        edge.target_handle === targetHandle
      );

      if (!duplicate) {
        currentFlow().edges.push({
          id: makeId("edge"),
          source: sourceNodeId,
          source_handle: sourceHandle,
          target: targetNodeId,
          target_handle: targetHandle,
        });
        markDirty();
      }

      state.connecting = null;
      state.connectionCursor = null;
      renderAll();
      setStatus(duplicate ? "Connection already exists." : "Connection created.");
    });
  });

  nodesBox.querySelectorAll(".flowNodeRunBtn").forEach((button) => {
    button.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        await triggerManualNode(button.dataset.runNodeId);
      } catch { }
    });

    button.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
    });
  });

  window.requestAnimationFrame(drawEdges);
}

function makeBezierPath(sx, sy, tx, ty) {
  const dx = Math.max(80, Math.abs(tx - sx) * 0.5);
  return `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`;
}

function drawEdges() {
  const svg = el("flowEdges");
  const board = el("flowBoard");
  const flow = currentFlow();

  if (!svg || !board) return;

  svg.innerHTML = "";

  if (!flow) return;

  const boardRect = board.getBoundingClientRect();

  for (const edge of flow.edges) {
    const sourcePort = board.querySelector(
      `.flowPort[data-node-id="${CSS.escape(edge.source)}"][data-port-kind="output"][data-port-handle="${CSS.escape(edge.source_handle || "out")}"]`
    );
    const targetPort = board.querySelector(
      `.flowPort[data-node-id="${CSS.escape(edge.target)}"][data-port-kind="input"][data-port-handle="${CSS.escape(edge.target_handle || "in")}"]`
    );

    if (!sourcePort || !targetPort) continue;

    const sourceRect = sourcePort.getBoundingClientRect();
    const targetRect = targetPort.getBoundingClientRect();

    const sx = sourceRect.left - boardRect.left + sourceRect.width / 2;
    const sy = sourceRect.top - boardRect.top + sourceRect.height / 2;
    const tx = targetRect.left - boardRect.left + targetRect.width / 2;
    const ty = targetRect.top - boardRect.top + targetRect.height / 2;

    const d = makeBezierPath(sx, sy, tx, ty);

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `flowEdgePath ${edge.id === state.selectedEdgeId ? "active" : ""}`);
    path.dataset.edgeId = edge.id;

    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "flowEdgeHitArea");
    hit.dataset.edgeId = edge.id;

    const hoverOn = () => path.classList.add("hovered");
    const hoverOff = () => path.classList.remove("hovered");

    const removeEdge = (ev) => {
      ev.stopPropagation();

      const liveFlow = currentFlow();
      if (!liveFlow) return;

      liveFlow.edges = liveFlow.edges.filter((item) => item.id !== edge.id);

      if (state.selectedEdgeId === edge.id) {
        state.selectedEdgeId = null;
      }

      markDirty();
      renderInspector();
      drawEdges();
      setStatus("Connection deleted.");
    };

    hit.addEventListener("pointerenter", hoverOn);
    hit.addEventListener("pointerleave", hoverOff);
    hit.addEventListener("click", removeEdge);

    svg.appendChild(path);
    svg.appendChild(hit);
  }

  if (state.connecting && state.connectionCursor) {
    const portKind = state.connecting.kind || "output";
    const portHandle = state.connecting.handle || (portKind === "input" ? "in" : "out");

    const anchorPort = board.querySelector(
      `.flowPort[data-node-id="${CSS.escape(state.connecting.nodeId)}"][data-port-kind="${CSS.escape(portKind)}"][data-port-handle="${CSS.escape(portHandle)}"]`
    );

    if (anchorPort) {
      const anchorRect = anchorPort.getBoundingClientRect();

      const ax = anchorRect.left - boardRect.left + anchorRect.width / 2;
      const ay = anchorRect.top - boardRect.top + anchorRect.height / 2;
      const cx = state.connectionCursor.x;
      const cy = state.connectionCursor.y;

      const ghost = document.createElementNS("http://www.w3.org/2000/svg", "path");
      ghost.setAttribute(
        "d",
        portKind === "input"
          ? makeBezierPath(cx, cy, ax, ay)
          : makeBezierPath(ax, ay, cx, cy)
      );
      ghost.setAttribute("class", "flowEdgePath flowEdgeGhost");
      svg.appendChild(ghost);
    }
  }
}

function renderInspector() {
  const box = el("inspectorBody");
  const flow = currentFlow();
  const focusState = captureInspectorFocusState();
  const scheduleViewport = document.getElementById("schedulePlannerViewport");

  if (scheduleViewport) {
    state.scheduleViewportScrollTop = scheduleViewport.scrollTop;
    state.scheduleViewportScrollLeft = scheduleViewport.scrollLeft;
  }

  if (!box) return;

  syncScheduleEditingLayout();
  setSchedulesInteracting(!!state.scheduleDrag);
  setPublicVariablesInteracting(false);

  if (state.selectedEdgeId) {
    if (!flow) {
      state.selectedEdgeId = null;
      renderInspector();
      return;
    }

    const edge = flow.edges.find((item) => item.id === state.selectedEdgeId);
    if (!edge) {
      state.selectedEdgeId = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = "Connection settings";
    }

    box.innerHTML = `
      <div class="inspectorCard dangerZone">
        <div class="inspectorTitle">Connection</div>
        <div class="inspectorHint">${escapeHtml(edge.source)}:${escapeHtml(edge.source_handle)} → ${escapeHtml(edge.target)}:${escapeHtml(edge.target_handle)}</div>
        <div class="row2 mt-10">
          <button class="btn btn-danger" id="btnDeleteEdge" type="button">Delete connection</button>
        </div>
      </div>
    `;

    el("btnDeleteEdge")?.addEventListener("click", () => {
      flow.edges = flow.edges.filter((item) => item.id !== edge.id);
      state.selectedEdgeId = null;
      markDirty();
      renderAll();
      setStatus("Connection deleted.");
    });

    restoreInspectorFocusState(focusState);
    return;
  }

  if (state.selectedNodeId) {
    if (!flow) {
      state.selectedNodeId = null;
      renderInspector();
      return;
    }

    const node = flow.nodes.find((item) => item.id === state.selectedNodeId);
    if (!node) {
      state.selectedNodeId = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${displayNodeTitle(node) || node.label} settings`;
    }

    box.innerHTML = renderNodeInspector(node);
    bindNodeInspector(node);
    restoreInspectorFocusState(focusState);
    return;
  }

  if (state.selectedRecordingPresetIndex != null) {
    const preset = currentSelectedRecordingPreset();
    if (!preset) {
      state.selectedRecordingPresetIndex = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${preset.name} tag`;
    }

    box.innerHTML = renderRecordingPresetInspector(preset, state.selectedRecordingPresetIndex);
    bindRecordingPresetInspector(state.selectedRecordingPresetIndex);
    restoreInspectorFocusState(focusState);
    return;
  }

  if (state.selectedScheduleIndex != null) {
    const schedule = currentSelectedSchedule();
    if (!schedule) {
      state.selectedScheduleIndex = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${schedule.name} schedule`;
    }

    box.innerHTML = renderScheduleInspector(schedule, state.selectedScheduleIndex);
    bindScheduleInspector(state.selectedScheduleIndex);
    refreshScheduleRuntimeUi();
    restoreInspectorFocusState(focusState);
    return;
  }

  if (state.selectedPublicVariableIndex != null) {
    const variable = currentSelectedPublicVariable();
    if (!variable) {
      state.selectedPublicVariableIndex = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${flowVariableLabel(variable.key || `var_${state.selectedPublicVariableIndex + 1}`)} settings`;
    }

    box.innerHTML = renderPublicVariableInspector(variable, state.selectedPublicVariableIndex);
    bindPublicVariableInspector(state.selectedPublicVariableIndex);
    refreshPublicVariableRuntimeUi();
    restoreInspectorFocusState(focusState);
    return;
  }

  if (!flow) {
    box.innerHTML = `<div class="inspectorHint">No flow selected.</div>`;
    restoreInspectorFocusState(focusState);
    return;
  }

  if (el("inspectorSubtext")) {
    el("inspectorSubtext").textContent = "Flow settings.";
  }

  box.innerHTML = renderFlowInspector(flow);
  bindFlowInspector(flow);
  restoreInspectorFocusState(focusState);
}

function renderPhysicalLiveField(kind, channel, label = "Current value", idBase = "physicalCurrent") {
  const normalizedKind = String(kind || "digital").trim().toLowerCase();
  const normalizedChannel = normalizePhysicalChannelSelection(normalizedKind, channel || "1");
  return `
    <div class="full">
      <label>${escapeHtml(label)}</label>
      <input id="${escapeHtml(`${idBase}Value`)}" data-physical-live-kind="${escapeHtml(normalizedKind)}" data-physical-live-channel="${escapeHtml(normalizedChannel)}" value="${escapeHtml(physicalLiveValueText(normalizedKind, normalizedChannel))}" readonly />
    </div>
    <div class="full inlineMeta" id="${escapeHtml(`${idBase}Meta`)}" data-physical-live-meta="true">${escapeHtml(physicalMetaText())}</div>
  `;
}

function renderPhysicalSwitchActionInspector({
  title,
  targetKind = "output",
  channel,
  name,
  mode = "pulse",
  pulseSeconds = 2,
} = {}) {
  const selectedKind = targetKind === "relay" ? "relay" : "output";
  const selectedChannel = normalizePhysicalChannelSelection(selectedKind, channel || "1");
  const options = selectedKind === "relay"
    ? physicalRelayOptionsHtml(selectedChannel)
    : physicalOutputOptionsHtml(selectedChannel);
  const selectionLabel = selectedKind === "relay" ? "Relay" : "Output";
  const currentLabel = selectedKind === "relay" ? "Current relay state" : "Current output state";

  return `
    <div class="inspectorCard">
      <div class="inspectorTitle">${escapeHtml(title)}</div>
      <div class="fieldGrid">
        <div class="full">
          <label>Name</label>
          <input id="cfg_name" value="${escapeHtml(name || "")}" placeholder="Optional label" />
        </div>
        <div>
          <label>Target type</label>
          <select id="cfg_target_kind">${physicalTargetKindOptionsHtml(selectedKind)}</select>
        </div>
        <div>
          <label>${escapeHtml(selectionLabel)}</label>
          <select id="cfg_channel">${options}</select>
        </div>
        <div>
          <label>Mode</label>
          <select id="cfg_mode">
            <option value="on" ${mode === "on" ? "selected" : ""}>On</option>
            <option value="off" ${mode === "off" ? "selected" : ""}>Off</option>
            <option value="pulse" ${mode === "pulse" ? "selected" : ""}>Pulse</option>
          </select>
        </div>
        <div>
          <label>Pulse seconds</label>
          <input id="cfg_pulse_seconds" type="number" min="0.1" step="0.1" value="${escapeHtml(cfgValueOrDefault(pulseSeconds, 2))}" />
        </div>
        ${renderPhysicalLiveField(selectedKind, selectedChannel, currentLabel)}
      </div>
    </div>
  `;
}

function cfgValueOrDefault(value, fallback) {
  return value == null || value === "" ? fallback : value;
}

function renderFlowInspector(flow) {
  return `
    <div class="inspectorCard">
      <div class="inspectorTitle">Flow</div>
      <div class="fieldGrid">
        <div class="full">
          <label for="flowNameInput">Flow name</label>
          <input id="flowNameInput" value="${escapeHtml(flow.name || "")}" placeholder="Front door automation" />
        </div>
        <div class="full">
          <label class="enableRow m-0">
            <input id="flowEnabledInput" type="checkbox" ${flow.enabled ? "checked" : ""} />
            <span>${flow.enabled ? "Enabled" : "Disabled"}</span>
          </label>
        </div>
      </div>
    </div>
    <div class="inspectorCard inspectorActionsCard">
      <div class="inspectorActionHeader">
        <div class="inspectorTitle">Flow actions</div>
        <div class="inspectorHint">Create, save, duplicate, import, export, or remove this flow.</div>
      </div>
      <div class="inspectorActionGrid inspectorActionGrid--twoUp">
        <button class="btn btn-primary" id="btnInspectorNewFlow" type="button">New</button>
        <button class="btn" id="btnInspectorSaveFlow" type="button">Save</button>
        <button class="btn" id="btnInspectorDuplicateFlow" type="button">Duplicate</button>
        <button class="btn btn-danger" id="btnInspectorDeleteFlow" type="button">Delete</button>
        <button class="btn" id="btnInspectorExportFlows" type="button">Export</button>
        <button class="btn" id="btnInspectorImportFlows" type="button">Import</button>
      </div>
    </div>
  `;
}

function renderSchedulePlannerWorkspace(schedule, index) {
  return `
    <div id="scheduleWorkspaceBody" class="scheduleWorkspaceSurface" data-schedule-index="${index}">
      <div class="schedulePlannerViewport" id="schedulePlannerViewport">
        <div class="schedulePlannerHeader">
          <div class="schedulePlannerCorner">Day</div>
          <div class="scheduleTimeHeader">${renderScheduleHourLabels()}</div>
        </div>
        <div class="schedulePlannerRows">
          ${SCHEDULE_DAY_META.map(([dayKey, label]) => renderScheduleDayLane(schedule, index, dayKey, label)).join("")}
        </div>
      </div>
    </div>
  `;
}

function renderScheduleManualEditInspector(index) {
  const selectedDay = currentSelectedScheduleDayEntry(index);
  const selectedPeriod = currentSelectedSchedulePeriodEntry(index);
  if (!selectedDay) {
    return `
      <div class="inspectorCard">
        <div class="inspectorTitle">Manual edit</div>
        <div class="inspectorHint">Select a day or time block to edit that day.</div>
      </div>
    `;
  }

  const { dayKey, dayLabel, periods, schedule } = selectedDay;
  const selectedPeriodIndex = selectedPeriod?.selection?.dayKey === dayKey ? selectedPeriod.selection.periodIndex : null;
  const isHolidayDay = dayKey === HOLIDAY_DAY_KEY;

  return `
    <div class="inspectorCard ${selectedPeriodIndex != null ? "is-active" : ""}">
      <div class="inspectorTitle">Manual edit</div>
      <div class="inspectorHint">${escapeHtml(dayLabel)}${selectedPeriodIndex != null ? ` · Entry ${selectedPeriodIndex + 1} selected` : " · Select an entry to focus it"}</div>
      ${isHolidayDay ? `
        <div class="fieldGrid mt-10">
          <div>
            <label>Holiday calendar</label>
            <select id="scheduleHolidayCalendarInput">
              ${HOLIDAY_CALENDAR_OPTIONS.map(([code, label]) => `<option value="${code}" ${normalizeHolidayCalendar(schedule.holiday_calendar) === code ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
            </select>
          </div>
        </div>
      ` : ""}
      ${periods.length ? `
        <div class="scheduleDayEditList mt-10">
          ${periods.map((period, periodIndex) => `
            <div class="scheduleDayEditItem ${selectedPeriodIndex === periodIndex ? "is-selected" : ""}" data-schedule-day-edit-item="${periodIndex}" data-schedule-day-edit-select="${periodIndex}">
              ${selectedPeriodIndex === periodIndex ? "" : `
                <div class="rowSplit scheduleDayEditHeader">
                  <div class="scheduleDayEditTitle">Entry ${periodIndex + 1}</div>
                  <div class="scheduleDayEditMeta">
                    <span class="miniPill">${escapeHtml(period.start)} - ${escapeHtml(period.end)}</span>
                  </div>
                </div>
              `}
              ${selectedPeriodIndex === periodIndex ? `
                <div class="fieldGrid schedulePeriodGrid mt-10">
                  <div class="schedulePeriodField schedulePeriodField--start">
                    <label>Start</label>
                    <input class="scheduleTimeInput" lang="en-GB" type="time" step="60" value="${escapeHtml(normalizeScheduleTime(period.start, "09:00"))}" data-schedule-day-edit-start="${periodIndex}" />
                  </div>
                  <div class="schedulePeriodField schedulePeriodField--end">
                    <label>End</label>
                    <input class="scheduleTimeInput" lang="en-GB" type="time" step="60" value="${escapeHtml(normalizeScheduleTime(period.end, "17:00"))}" data-schedule-day-edit-end="${periodIndex}" />
                  </div>
                </div>
                <div class="inspectorActionGrid schedulePeriodActions mt-10">
                  <button class="btn btn-danger" type="button" data-schedule-day-edit-delete="${periodIndex}">Delete</button>
                </div>
              ` : ""}
            </div>
          `).join("")}
        </div>
      ` : `<div class="emptyState">No manual edits for ${escapeHtml(dayLabel.toLowerCase())}. Drag on the timeline to add one.</div>`}
    </div>
  `;
}

function renderScheduleInspector(schedule, index) {
  return `
    <div id="scheduleInspectorBody" class="scheduleInspectorPanel" data-schedule-index="${index}">
      <div class="inspectorCard schedulePlannerMetaCard">
        <div class="rowSplit">
          <div>
            <div class="inspectorTitle schedulePlannerTitle">${escapeHtml(schedule.name || schedule.key || `schedule_${index + 1}`)}</div>
            <div class="inspectorHint">Weekly schedule details. The timeline editor is shown in the main panel.</div>
          </div>
          <span id="scheduleInspectorStatus" class="miniPill scheduleStatusPill ${schedule.is_active ? "is-active" : "is-inactive"}">${escapeHtml(scheduleStatusLabel(schedule))}</span>
        </div>
        <div class="schedulePlannerMetaGrid mt-10">
          <div>
            <label>Key</label>
            <input id="scheduleKeyInput" value="${escapeHtml(schedule.key || "")}" placeholder="schedule_1" />
          </div>
          <div>
            <label>Name</label>
            <input id="scheduleNameInput" value="${escapeHtml(schedule.name || "")}" placeholder="Office hours" />
          </div>
        </div>
        <div class="inspectorHint mt-10">Select a day on the planner to edit that day. The Holidays day uses its selected calendar when it has periods.</div>
      </div>

      ${renderScheduleManualEditInspector(index)}

      <div class="inspectorCard inspectorActionsCard">
        <div class="inspectorActionHeader">
          <div class="inspectorTitle">Schedule actions</div>
          <div class="inspectorHint">Create a new schedule, save this one, or delete it.</div>
        </div>
        <div class="schedulePlannerToolbarActions">
            <button class="btn btn-primary" id="btnInspectorAddSchedule" type="button">New</button>
            <button class="btn" id="btnInspectorSaveSchedules" type="button">Save</button>
            <button class="btn btn-danger" id="btnInspectorDeleteSchedule" type="button">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function renderPublicVariableInspector(variable, index) {
  const selectedType = publicVariableTypeChoice(variable);
  const variableType = normalizeVariableType(variable.type);
  const variableValue = variable.current_value ?? variable.value;
  const isPhysical = normalizeVariableSource(variable.source) === "physical_input";
  const inputKind = isPhysical ? String(variable.input_kind || "digital").trim().toLowerCase() : "digital";
  const channel = isPhysical ? normalizePhysicalChannelSelection(inputKind, variable.channel || "1") : "1";
  const liveLabel = inputKind === "analog" ? "Current value" : "Current state";

  return `
    <div class="inspectorCard">
      <div class="rowSplit">
        <div>
          <div class="inspectorTitle publicVariableInspectorName" style="margin-bottom:4px;">${escapeHtml(variable.key || `var_${index + 1}`)}</div>
          <div class="inspectorHint">${isPhysical ? "This variable mirrors live physical I/O and cannot be edited manually." : "Shared variable"}</div>
        </div>
      </div>
      <div id="publicVariableInspectorBody" class="fieldGrid mt-10" data-public-variable-index="${index}">
        <div>
          <label>Key</label>
          <input id="publicVariableKeyInput" value="${escapeHtml(variable.key || "")}" placeholder="var_1" />
        </div>
        <div>
          <label>Type</label>
          <select id="publicVariableTypeInput">${variableTypeOptionsHtml(selectedType)}</select>
        </div>
        ${isPhysical ? `
        <div>
          <label>Physical source</label>
          <select id="publicVariableInputKind">${physicalValueSourceKindOptionsHtml(inputKind)}</select>
        </div>
        <div>
          <label>Channel</label>
          <select id="publicVariableChannelInput">${physicalInputChannelOptionsHtml(inputKind, channel)}</select>
        </div>
        <div class="full">
          <label>Live value</label>
          <input id="publicVariableValueInput" value="${escapeHtml(formatVariableValue(variableValue, variableType))}" readonly />
          <div class="inlineMeta">${escapeHtml(physicalLabel(inputKind, channel))} · ${escapeHtml(liveLabel)} · ${escapeHtml(physicalMetaText())}</div>
        </div>` : `
        <div>
          <label>Value</label>
          ${renderVariableValueEditor({
            inputId: "publicVariableValueInput",
            value: variableValue,
            type: variableType,
            placeholder: variableType === "json" ? '{"key":"value"}' : "value",
            rows: 5,
          })}
        </div>`}
      </div>
    </div>
    <div class="inspectorCard inspectorActionsCard">
      <div class="inspectorActionHeader">
        <div class="inspectorTitle">Variable actions</div>
        <div class="inspectorHint">Create a new variable, save changes, or remove the selected variable.</div>
      </div>
      <div class="inspectorActionGrid">
        <button class="btn btn-primary" id="btnInspectorAddPublicVariable" type="button">New</button>
        <button class="btn" id="btnInspectorSavePublicVariables" type="button">Save</button>
        <button class="btn btn-danger" id="btnInspectorDeletePublicVariable" type="button">Delete</button>
      </div>
    </div>
  `;
}

function formatVariableValue(value, type) {
  const normalizedType = normalizeVariableType(type);

  if (normalizedType === "schedule") {
    return value == null ? "" : String(value);
  }

  if (normalizedType === "json") {
    if (typeof value === "string") {
      try {
        return JSON.stringify(JSON.parse(value), null, 0);
      } catch {
        return value;
      }
    }

    try {
      return JSON.stringify(value ?? {}, null, 0);
    } catch {
      return "{}";
    }
  }

  if (normalizedType === "boolean") return parseBooleanLike(value) ? "true" : "false";
  return value == null ? "" : String(value);
}

function summarizeVariableValue(value, type) {
  if (normalizeVariableType(type) === "schedule") {
    const key = String(value || "").trim();
    if (!key) return "No schedule";
    const schedule = scheduleByKey(key);
    if (!schedule) return `[Missing] ${key}`;
    return `${schedule.name} · ${schedule.is_active ? "Active" : "Inactive"}`;
  }

  const compact = formatVariableValue(value, type).replace(/\s+/g, " ").trim();
  if (!compact) return "Empty";
  return compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;
}

function renderVariableValueEditor({ inputId = "", inputClass = "", value = "", type = "string", placeholder = "value", readOnly = false, rows = 4 } = {}) {
  const normalizedType = normalizeVariableType(type);
  const idAttr = inputId ? ` id="${escapeHtml(inputId)}"` : "";
  const classAttr = inputClass ? ` class="${escapeHtml(inputClass)}"` : "";
  const readOnlyAttr = readOnly ? " readonly" : "";
  const disabledAttr = readOnly ? " disabled" : "";

  if (normalizedType === "boolean" && !readOnly) {
    const normalizedValue = formatVariableValue(value, normalizedType);
    return `
      <select${idAttr}${classAttr}>
        <option value="true" ${normalizedValue === "true" ? "selected" : ""}>True</option>
        <option value="false" ${normalizedValue === "false" ? "selected" : ""}>False</option>
      </select>
    `;
  }

  if (normalizedType === "number" && !readOnly) {
    return `<input${idAttr}${classAttr} type="number" step="any" value="${escapeHtml(formatVariableValue(value, normalizedType))}" placeholder="${escapeHtml(placeholder)}" />`;
  }

  if (normalizedType === "schedule" && !readOnly) {
    return `<select${idAttr}${classAttr}>${scheduleOptionsHtml(formatVariableValue(value, normalizedType))}</select>`;
  }

  if (normalizedType === "json") {
    return `<textarea${idAttr}${classAttr} rows="${rows}" placeholder="${escapeHtml(placeholder)}"${readOnlyAttr}>${escapeHtml(formatVariableValue(value, normalizedType))}</textarea>`;
  }

  return `<input${idAttr}${classAttr} value="${escapeHtml(formatVariableValue(value, normalizedType))}" placeholder="${escapeHtml(placeholder)}"${readOnlyAttr}${disabledAttr} />`;
}

function renderSetVariableValueControl(cfg) {
  const target = publicVariableByKey(cfg.variable_key || "");
  const targetType = normalizeVariableType(target?.type || "string");
  const valueSource = String(cfg.value_source || "literal").trim().toLowerCase();

  if (valueSource === "variable") {
    return `<select id="cfg_value">${variableKeyOptionsHtml(cfg.value || "")}</select>`;
  }

  if (valueSource === "trigger") {
    return `<input id="cfg_value" value="${escapeHtml(cfg.value || "")}" placeholder="trigger.path.to.value" list="variableKeysList" />`;
  }

  if (valueSource === "physical_input") {
    const inputKind = String(cfg.value_input_kind || "digital").trim().toLowerCase();
    const channel = normalizePhysicalChannelSelection(inputKind, cfg.value_channel || "1");
    const currentLabel = inputKind === "analog" ? "Current value" : "Current state";

    return `
      <div class="fieldGrid">
        <div>
          <label>Physical source</label>
          <select id="cfg_value_input_kind">${physicalValueSourceKindOptionsHtml(inputKind)}</select>
        </div>
        <div>
          <label>Channel</label>
          <select id="cfg_value_channel">${physicalInputChannelOptionsHtml(inputKind, channel)}</select>
        </div>
        ${renderPhysicalLiveField(inputKind, channel, currentLabel)}
      </div>
    `;
  }

  return renderVariableValueEditor({
    inputId: "cfg_value",
    value: cfg.value,
    type: targetType,
    placeholder: targetType === "json" ? '{"key":"value"}' : "literal value",
    rows: 5,
  });
}

function publicVariablesDefinitionFingerprint(items = []) {
  return JSON.stringify(
    (items || []).map((item) => [
      (item?.key || "").trim(),
      normalizeVariableSource(item?.source),
      item?.type || "string",
      item?.input_kind || "",
      item?.channel || "",
    ])
  );
}

function inspectorHasFocus() {
  const inspector = document.getElementById("inspectorBody");
  return !!(inspector && document.activeElement instanceof Node && inspector.contains(document.activeElement));
}

function captureInspectorFocusState() {
  const inspector = document.getElementById("inspectorBody");
  const active = document.activeElement;

  if (!(inspector && active instanceof HTMLElement && inspector.contains(active) && active.id)) {
    return null;
  }

  const focusState = {
    id: active.id,
    scrollLeft: typeof active.scrollLeft === "number" ? active.scrollLeft : null,
    scrollTop: typeof active.scrollTop === "number" ? active.scrollTop : null,
  };

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    focusState.selectionStart = typeof active.selectionStart === "number" ? active.selectionStart : null;
    focusState.selectionEnd = typeof active.selectionEnd === "number" ? active.selectionEnd : null;
    focusState.selectionDirection = active.selectionDirection || "none";
  }

  return focusState;
}

function restoreInspectorFocusState(focusState) {
  if (!focusState?.id) return;

  const target = document.getElementById(focusState.id);
  if (!(target instanceof HTMLElement)) return;

  target.focus({ preventScroll: true });

  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
    && typeof focusState.selectionStart === "number"
    && typeof focusState.selectionEnd === "number") {
    const length = target.value?.length ?? 0;
    const start = Math.max(0, Math.min(focusState.selectionStart, length));
    const end = Math.max(0, Math.min(focusState.selectionEnd, length));
    target.setSelectionRange(start, end, focusState.selectionDirection || "none");
  }

  if (typeof focusState.scrollLeft === "number") {
    target.scrollLeft = focusState.scrollLeft;
  }

  if (typeof focusState.scrollTop === "number") {
    target.scrollTop = focusState.scrollTop;
  }
}

function schedulesDefinitionFingerprint(items = []) {
  return JSON.stringify(
    (items || []).map((item) => [
      (item?.key || "").trim(),
      (item?.name || "").trim(),
      normalizeHolidayCalendar(item?.holiday_calendar),
      ...SCHEDULE_DAY_META.map(([dayKey]) => ((item?.days?.[dayKey] || []).map((period) => `${period.start}-${period.end}`).join(","))),
    ])
  );
}

function syncSchedulesHeader() {
  for (const buttonId of ["btnSaveSchedules", "btnInspectorSaveSchedules"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = !state.schedulesDirty;
    }
  }

  for (const buttonId of ["btnDeleteSchedule", "btnInspectorDeleteSchedule"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = currentSelectedSchedule() == null;
    }
  }
}

function markSchedulesDirty() {
  state.schedulesDirty = true;
  syncSchedulesHeader();
}

function clearSchedulesDirty() {
  state.schedulesDirty = false;
  syncSchedulesHeader();
}

function setSchedulesInteracting(active) {
  state.schedulesInteracting = !!active;
}

function syncPublicVariablesHeader() {
  for (const buttonId of ["btnSavePublicVariables", "btnInspectorSavePublicVariables"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = !state.publicVariablesDirty;
    }
  }

  for (const buttonId of ["btnDeletePublicVariable", "btnInspectorDeletePublicVariable"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = currentSelectedPublicVariable() == null;
    }
  }
}

function markPublicVariablesDirty() {
  state.publicVariablesDirty = true;
  syncPublicVariablesHeader();
}

function clearPublicVariablesDirty() {
  state.publicVariablesDirty = false;
  syncPublicVariablesHeader();
}

function setPublicVariablesInteracting(active) {
  state.publicVariablesInteracting = !!active;
}

function nextPublicVariableKey() {
  const existing = new Set(currentPublicVariables().map((item) => (item.key || "").trim()).filter(Boolean));
  let idx = currentPublicVariables().length + 1;
  while (existing.has(`var_${idx}`)) {
    idx += 1;
  }
  return `var_${idx}`;
}

function syncRecordingPresetsHeader() {
  for (const buttonId of ["btnSaveRecordingPreset", "btnInspectorSaveRecordingPreset"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = currentSelectedRecordingPreset() == null;
    }
  }

  for (const buttonId of ["btnDeleteRecordingPreset", "btnInspectorDeleteRecordingPreset"]) {
    if (el(buttonId)) {
      el(buttonId).disabled = currentSelectedRecordingPreset() == null;
    }
  }
}

function addRecordingPreset() {
  state.recordingPresets.push(normalizeRecordingPresetRecord({
    name: nextRecordingPresetName(),
    color: "#c6a14b",
    _original_name: "",
  }));
  if (el("presetSearch")) {
    el("presetSearch").value = "";
  }
  selectRecordingPreset(currentRecordingPresets().length - 1);
  setSidebarSectionExpanded("presets", true);
  renderRecordingPresetSidebar();
  renderInspector();
}

function removeLocalRecordingPreset(index) {
  if (!currentRecordingPresets()[index]) return;
  state.recordingPresets.splice(index, 1);
  if (!currentRecordingPresets().length) {
    state.selectedRecordingPresetIndex = null;
  } else {
    state.selectedRecordingPresetIndex = Math.min(index, currentRecordingPresets().length - 1);
  }
  renderRecordingPresetSidebar();
  renderInspector();
}

function renderRecordingPresetSidebar() {
  const box = el("recordingPresetList");
  if (!box) return;

  const q = (el("presetSearch")?.value || "").trim().toLowerCase();
  const selectedPreset = currentSelectedRecordingPreset();
  const items = currentRecordingPresets().map((preset, idx) => ({ preset, idx })).filter(({ preset }) => {
    if (!q) return true;
    return [preset.name, preset.color].join(" ").toLowerCase().includes(q);
  });

  syncSidebarSection("presets", currentRecordingPresets().length > 0);
  syncRecordingPresetsHeader();

  const currentCard = !selectedPreset ? `
    <div class="varCard varCardActionsOnly">
      <div class="sidebarCardActions is-standalone">
        <button class="btn btn-primary btn-compact" id="btnAddRecordingPreset" type="button">New</button>
        <button class="btn btn-compact" id="btnSaveRecordingPreset" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeleteRecordingPreset" type="button">Delete</button>
      </div>
    </div>` : "";

  box.innerHTML = `
    ${currentCard}
    ${currentRecordingPresets().length ? "" : `<div class="emptyState">No recording tags yet.</div>`}
    ${items.length ? items.map(({ preset, idx }) => {
      const isActive = idx === state.selectedRecordingPresetIndex;
      return `
        <${isActive ? "div" : "button"} class="varCard is-preview ${isActive ? "active varCardCurrent" : ""}" ${isActive ? "" : 'type="button"'} data-recording-preset-index="${idx}" aria-pressed="${isActive ? "true" : "false"}">
          <div class="varCardTop">
            <div class="varCardName">${escapeHtml(preset.name)}</div>
            <span class="recordingPresetSwatch" style="background:${escapeHtml(preset.color)};"></span>
          </div>
          ${isActive ? `
          <div class="sidebarCardActions">
            <button class="btn btn-primary btn-compact" id="btnAddRecordingPreset" type="button">New</button>
            <button class="btn btn-compact" id="btnSaveRecordingPreset" type="button">Save</button>
            <button class="btn btn-danger btn-compact" id="btnDeleteRecordingPreset" type="button">Delete</button>
          </div>` : ""}
        </${isActive ? "div" : "button"}>
      `;
    }).join("") : ""}
  `;

  bindRecordingPresetActionButtons();
  syncRecordingPresetsHeader();

  box.querySelectorAll("[data-recording-preset-index]").forEach((card) => {
    if (card.classList.contains("varCardCurrent")) return;
    card.addEventListener("click", () => {
      const index = Number(card.dataset.recordingPresetIndex || -1);
      if (!currentRecordingPresets()[index]) return;
      selectRecordingPreset(index);
      renderRecordingPresetSidebar();
      renderInspector();
      renderCanvas();
      drawEdges();
    });
  });
}

function renderRecordingPresetInspector(preset, index) {
  return `
    <div class="inspectorCard">
      <div class="rowSplit">
        <div>
          <div class="inspectorTitle" style="margin-bottom:4px;">${escapeHtml(preset.name)}</div>
          <div class="inspectorHint">Shared recording tag</div>
        </div>
      </div>
      <div id="recordingPresetInspectorBody" class="fieldGrid mt-10" data-recording-preset-index="${index}">
        <div class="full">
          <label>Name</label>
          <input id="recordingPresetNameInput" value="${escapeHtml(preset.name)}" placeholder="Driveway event" />
        </div>
        <div class="full">
          <label>Tag color</label>
          <div class="recordingPresetColorRow recordingTagColorPreview is-editable">
            <label class="recordingTagColorSwatchButton" for="recordingPresetColorInput">
              <span id="recordingPresetColorSwatch" class="recordingTagColorSwatch is-large" style="background:${escapeHtml(preset.color)};"></span>
              <input id="recordingPresetColorInput" class="recordingTagColorInput" type="color" value="${escapeHtml(preset.color)}" aria-label="Tag color" />
            </label>
            <span id="recordingPresetColorValue" class="miniPill">${escapeHtml(preset.color)}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="inspectorCard inspectorActionsCard">
      <div class="inspectorActionHeader">
        <div class="inspectorTitle">Tag actions</div>
        <div class="inspectorHint">Create, save, or remove the selected recording tag.</div>
      </div>
      <div class="inspectorActionGrid">
        <button class="btn btn-primary" id="btnInspectorAddRecordingPreset" type="button">New</button>
        <button class="btn" id="btnInspectorSaveRecordingPreset" type="button">Save</button>
        <button class="btn btn-danger" id="btnInspectorDeleteRecordingPreset" type="button">Delete</button>
      </div>
    </div>
  `;
}

async function refreshRecordingPresets(silent = true) {
  try {
    const data = await api("/api/recording-presets");
    const selected = currentSelectedRecordingPreset();
    const selectedName = selected?.name || "";
    state.recordingPresets = (Array.isArray(data?.items) ? data.items : []).map((item) => normalizeRecordingPresetRecord({
      ...item,
      _original_name: item?.name || "",
    }));

    if (selectedName) {
      const nextIndex = state.recordingPresets.findIndex((item) => recordingPresetIdentity(item.name) === recordingPresetIdentity(selectedName));
      state.selectedRecordingPresetIndex = nextIndex >= 0 ? nextIndex : null;
    } else if (!state.recordingPresets.length) {
      state.selectedRecordingPresetIndex = null;
    }

    renderRecordingPresetSidebar();
    if (!inspectorHasFocus()) {
      renderInspector();
    }
  } catch (err) {
    if (!silent) {
      setStatus(err.message || String(err), true);
    }
  }
}

async function saveRecordingPreset() {
  const preset = currentSelectedRecordingPreset();
  if (!preset) return;

  preset.name = normalizeRecordingPresetName(preset.name);
  preset.color = normalizeRecordingPresetColor(preset.color);

  const duplicate = currentRecordingPresets().find((item, index) => {
    if (index === state.selectedRecordingPresetIndex) return false;
    return recordingPresetIdentity(item.name) === recordingPresetIdentity(preset.name);
  });
  if (duplicate) {
    throw new Error(`Duplicate tag name: ${preset.name}`);
  }

  const previousName = preset._original_name || preset.name;
  const method = preset._original_name ? "PUT" : "POST";
  const path = preset._original_name
    ? `/api/recording-presets/${encodeURIComponent(preset._original_name)}`
    : "/api/recording-presets";

  const out = await api(path, {
    method,
    body: JSON.stringify({ name: preset.name, color: preset.color }),
  });

  const saved = normalizeRecordingPresetRecord({
    ...(out?.item || preset),
    _original_name: (out?.item || preset).name,
  });
  applyRecordingPresetToDraft(previousName, saved);
  await refreshFlows();
  state.recordingPresets = (Array.isArray(out?.items) ? out.items : []).map((item) => normalizeRecordingPresetRecord({
    ...item,
    _original_name: item?.name || "",
  }));
  state.selectedRecordingPresetIndex = state.recordingPresets.findIndex((item) => recordingPresetIdentity(item.name) === recordingPresetIdentity(saved.name));

  const catalog = await api("/api/flows/catalog");
  state.catalog = catalog;
  state.devices = Array.isArray(catalog?.devices) ? catalog.devices : [];
  renderRecordingPresetSidebar();
  renderCanvas();
  renderInspector();
  setStatus(`Recording tag saved: ${saved.name}.`);
}

async function deleteRecordingPreset() {
  const preset = currentSelectedRecordingPreset();
  if (!preset) return;

  if (preset._original_name) {
    const out = await api(`/api/recording-presets/${encodeURIComponent(preset._original_name)}`, {
      method: "DELETE",
    });
    applyRecordingPresetToDraft(preset._original_name, null);
    await refreshFlows();
    state.recordingPresets = (Array.isArray(out?.items) ? out.items : []).map((item) => normalizeRecordingPresetRecord({
      ...item,
      _original_name: item?.name || "",
    }));
  } else {
    removeLocalRecordingPreset(state.selectedRecordingPresetIndex);
    return;
  }

  if (!state.recordingPresets.length) {
    state.selectedRecordingPresetIndex = null;
  } else {
    state.selectedRecordingPresetIndex = Math.min(state.selectedRecordingPresetIndex ?? 0, state.recordingPresets.length - 1);
  }

  const catalog = await api("/api/flows/catalog");
  state.catalog = catalog;
  state.devices = Array.isArray(catalog?.devices) ? catalog.devices : [];
  renderRecordingPresetSidebar();
  renderCanvas();
  renderInspector();
  setStatus(`Recording tag deleted: ${preset.name}.`);
}

function bindRecordingPresetActionButtons() {
  el("btnAddRecordingPreset")?.addEventListener("click", (event) => {
    event.stopPropagation();
    addRecordingPreset();
  });

  el("btnSaveRecordingPreset")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await saveRecordingPreset();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  el("btnDeleteRecordingPreset")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await deleteRecordingPreset();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });
}

function bindRecordingPresetInspector(index) {
  const getPreset = () => currentRecordingPresets()[index];

  document.getElementById("btnInspectorAddRecordingPreset")?.addEventListener("click", () => {
    addRecordingPreset();
  });

  document.getElementById("btnInspectorSaveRecordingPreset")?.addEventListener("click", async () => {
    try {
      await saveRecordingPreset();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  document.getElementById("btnInspectorDeleteRecordingPreset")?.addEventListener("click", async () => {
    try {
      await deleteRecordingPreset();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  document.getElementById("recordingPresetNameInput")?.addEventListener("input", (ev) => {
    const preset = getPreset();
    if (!preset) return;
    preset.name = normalizeRecordingPresetName(ev.target.value);
    renderRecordingPresetSidebar();

    const title = document.querySelector("#inspectorBody .inspectorCard .inspectorTitle");
    if (title) title.textContent = preset.name;
    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${preset.name} tag`;
    }
  });

  document.getElementById("recordingPresetColorInput")?.addEventListener("input", (ev) => {
    const preset = getPreset();
    if (!preset) return;
    preset.color = normalizeRecordingPresetColor(ev.target.value);
    const swatch = document.getElementById("recordingPresetColorSwatch");
    if (swatch) swatch.style.background = preset.color;
    const colorValue = document.getElementById("recordingPresetColorValue");
    if (colorValue) colorValue.textContent = preset.color;
    renderRecordingPresetSidebar();
  });
}

function validateSchedules() {
  const keys = new Set();

  for (const schedule of currentSchedules()) {
    const key = (schedule.key || "").trim();
    const name = (schedule.name || "").trim();
    if (!key) {
      throw new Error("Every schedule needs a key.");
    }
    if (!name) {
      throw new Error(`Schedule '${key}' needs a name.`);
    }
    if (keys.has(key)) {
      throw new Error(`Duplicate schedule key: ${key}`);
    }
    keys.add(key);

    for (const [dayKey, dayLabel] of SCHEDULE_DAY_META) {
      for (const period of schedule.days?.[dayKey] || []) {
        const start = normalizeScheduleTime(period.start, "09:00");
        const end = normalizeScheduleTime(period.end, "17:00");
        if (start === end) {
          throw new Error(`${dayLabel} active hours cannot start and end at the same time.`);
        }
      }
    }

    schedule.holiday_calendar = normalizeHolidayCalendar(schedule.holiday_calendar);
  }
}

function serializeSchedules() {
  return {
    items: currentSchedules().map((schedule) => ({
      key: String(schedule.key || "").trim(),
      name: String(schedule.name || "").trim(),
      holiday_calendar: normalizeHolidayCalendar(schedule.holiday_calendar),
      days: Object.fromEntries(
        SCHEDULE_DAY_META.map(([dayKey]) => [
          dayKey,
          normalizeSchedulePeriods(schedule.days?.[dayKey] || []),
        ])
      ),
    })),
  };
}

function addSchedule() {
  state.schedules.push(normalizeScheduleRecord({
    key: nextScheduleKey(),
    name: `Schedule ${currentSchedules().length + 1}`,
    holiday_calendar: "DK",
    days: emptyScheduleDays(),
    is_active: false,
  }));

  if (el("scheduleSearch")) {
    el("scheduleSearch").value = "";
  }

  selectSchedule(currentSchedules().length - 1);
  setSidebarSectionExpanded("schedules", true);
  markSchedulesDirty();
  renderScheduleSidebar();
  renderInspector();
}

function removeSchedule(index) {
  if (!currentSchedules()[index]) return;

  state.schedules.splice(index, 1);
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;

  if (!currentSchedules().length) {
    state.selectedScheduleIndex = null;
  } else {
    state.selectedScheduleIndex = Math.min(index, currentSchedules().length - 1);
  }

  markSchedulesDirty();
  renderScheduleSidebar();
  renderInspector();
  renderCanvas();
}

function renderScheduleSidebar() {
  const box = el("scheduleList");
  if (!box) return;

  const query = (el("scheduleSearch")?.value || "").trim().toLowerCase();
  const selectedSchedule = currentSelectedSchedule();
  const items = currentSchedules().map((schedule, idx) => ({ schedule, idx })).filter(({ schedule }) => {
    if (!query) return true;
    const haystack = [schedule.key || "", schedule.name || "", scheduleSummary(schedule), scheduleStatusLabel(schedule)].join(" ").toLowerCase();
    return haystack.includes(query);
  });

  syncSchedulesHeader();
  syncSidebarSection("schedules", currentSchedules().length > 0);

  const currentCard = !selectedSchedule ? `
    <div class="varCard varCardActionsOnly">
      <div class="sidebarCardActions is-standalone">
        <button class="btn btn-primary btn-compact" id="btnAddSchedule" type="button">New</button>
        <button class="btn btn-compact" id="btnSaveSchedules" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeleteSchedule" type="button">Delete</button>
      </div>
    </div>` : "";

  box.innerHTML = `
    ${currentCard}
    ${currentSchedules().length ? "" : `<div class="emptyState">No schedules yet.</div>`}
    ${items.length ? items.map(({ schedule, idx }) => {
      const isActive = idx === state.selectedScheduleIndex;
      return `
        <${isActive ? "div" : "button"} class="varCard is-preview ${isActive ? "active varCardCurrent" : ""}" ${isActive ? "" : 'type="button"'} data-schedule-index="${idx}" aria-pressed="${isActive ? "true" : "false"}">
          <div class="varCardTop">
            <div class="varCardName">${escapeHtml(schedule.name || schedule.key || `schedule_${idx + 1}`)}</div>
          </div>
          <div class="chipRow">
            <span class="miniPill">${escapeHtml(schedule.key || `schedule_${idx + 1}`)}</span>
            <span class="miniPill scheduleStatusPill ${schedule.is_active ? "is-active" : "is-inactive"} jsScheduleStatusPreview">${escapeHtml(scheduleStatusLabel(schedule))}</span>
          </div>
          <div class="flowListItemMeta">${escapeHtml(scheduleSummary(schedule))}</div>
          ${isActive ? `
            <div class="sidebarCardActions">
              <button class="btn btn-primary btn-compact" id="btnAddSchedule" type="button">New</button>
              <button class="btn btn-compact" id="btnSaveSchedules" type="button">Save</button>
              <button class="btn btn-danger btn-compact" id="btnDeleteSchedule" type="button">Delete</button>
            </div>` : ""}
        </${isActive ? "div" : "button"}>
      `;
    }).join("") : ""}
  `;

  bindScheduleActionButtons();
  syncSchedulesHeader();

  box.querySelectorAll(".varCard.is-preview").forEach((card) => {
    if (card.classList.contains("varCardCurrent")) return;
    card.addEventListener("click", () => {
      const index = Number(card.dataset.scheduleIndex || -1);
      if (!currentSchedules()[index]) return;
      selectSchedule(index);
      renderScheduleSidebar();
      renderInspector();
      renderCanvas();
      drawEdges();
    });
  });

  refreshScheduleRuntimeUi();
}

function handleAddSchedule() {
  addSchedule();
}

async function handleSaveSchedules() {
  try {
    await saveSchedules();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function handleDeleteSchedule() {
  if (state.selectedScheduleIndex == null) return;
  const schedule = currentSchedules()[state.selectedScheduleIndex];
  if (!schedule) return;
  if (!window.confirm(`Delete schedule '${schedule.name || schedule.key || `schedule_${state.selectedScheduleIndex + 1}`}'?`)) return;
  removeSchedule(state.selectedScheduleIndex);
}

function bindScheduleActionButtons() {
  el("btnAddSchedule")?.addEventListener("click", (event) => {
    event.stopPropagation();
    handleAddSchedule();
  });

  el("btnSaveSchedules")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handleSaveSchedules();
  });

  el("btnDeleteSchedule")?.addEventListener("click", (event) => {
    event.stopPropagation();
    handleDeleteSchedule();
  });
}

function bindScheduleInspector(index) {
  const inspector = document.getElementById("scheduleInspectorBody");
  const getSchedule = () => currentSchedules()[index];
  const getSelectedDayEntry = () => currentSelectedScheduleDayEntry(index);
  const getSelectedPeriodEntry = () => currentSelectedSchedulePeriodEntry(index);

  document.getElementById("btnInspectorAddSchedule")?.addEventListener("click", () => {
    handleAddSchedule();
  });

  document.getElementById("btnInspectorSaveSchedules")?.addEventListener("click", async () => {
    await handleSaveSchedules();
  });

  document.getElementById("btnInspectorDeleteSchedule")?.addEventListener("click", () => {
    handleDeleteSchedule();
  });

  inspector?.addEventListener("focusin", () => {
    setSchedulesInteracting(true);
  });

  inspector?.addEventListener("focusout", (ev) => {
    const nextTarget = ev.relatedTarget;
    const currentTarget = ev.currentTarget;
    if (nextTarget instanceof Node && currentTarget instanceof Node && currentTarget.contains(nextTarget)) {
      return;
    }
    setSchedulesInteracting(false);
  });

  document.getElementById("scheduleKeyInput")?.addEventListener("input", (ev) => {
    const schedule = getSchedule();
    if (!schedule) return;
    schedule.key = ev.target.value.trim();
    markSchedulesDirty();
    renderScheduleSidebar();
    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${schedule.name || schedule.key || `schedule_${index + 1}`} schedule`;
    }
  });

  document.getElementById("scheduleNameInput")?.addEventListener("input", (ev) => {
    const schedule = getSchedule();
    if (!schedule) return;
    schedule.name = ev.target.value.trim();
    markSchedulesDirty();
    renderScheduleSidebar();
    const title = document.querySelector("#inspectorBody .inspectorCard .inspectorTitle");
    if (title) title.textContent = schedule.name || schedule.key || `schedule_${index + 1}`;
    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${schedule.name || schedule.key || `schedule_${index + 1}`} schedule`;
    }
  });

  document.getElementById("scheduleHolidayCalendarInput")?.addEventListener("change", (ev) => {
    const schedule = getSchedule();
    if (!schedule) return;
    schedule.holiday_calendar = normalizeHolidayCalendar(ev.target.value);
    if (scheduleDayDisabled(schedule, HOLIDAY_DAY_KEY)
      && state.selectedSchedulePeriod?.scheduleIndex === index
      && state.selectedSchedulePeriod?.dayKey === HOLIDAY_DAY_KEY) {
      state.selectedSchedulePeriod = null;
    }
    markSchedulesDirty();
    renderScheduleSidebar();
    renderCanvas();
    renderInspector();
    setStatus(`Holiday calendar set to ${holidayCalendarLabel(schedule.holiday_calendar)}.`);
  });

  const applyDayPeriodEdit = (periodIndex) => {
    const selectedDay = getSelectedDayEntry();
    if (!selectedDay) return;

    const currentPeriod = selectedDay.periods?.[periodIndex];
    if (!currentPeriod) return;

    const start = normalizeScheduleTime(
      inspector?.querySelector(`[data-schedule-day-edit-start="${periodIndex}"]`)?.value || currentPeriod.start,
      currentPeriod.start,
    );
    const end = normalizeScheduleTime(
      inspector?.querySelector(`[data-schedule-day-edit-end="${periodIndex}"]`)?.value || currentPeriod.end,
      currentPeriod.end,
    );
    const startMinutes = scheduleTimeToMinutes(start);
    const endMinutes = scheduleTimeToMinutes(end);

    if (endMinutes - startMinutes < SCHEDULE_MIN_DURATION_MINUTES) {
      setStatus(`Schedule periods must be at least ${SCHEDULE_MIN_DURATION_MINUTES} minutes long.`, true);
      return;
    }

    if (currentPeriod.start === start && currentPeriod.end === end) {
      return;
    }

    const schedule = selectedDay.schedule;
    schedule.days[selectedDay.dayKey].splice(periodIndex, 1);
    schedule.days[selectedDay.dayKey].push({ start, end });
    schedule.days[selectedDay.dayKey] = normalizeScheduleDayPeriods(schedule.days[selectedDay.dayKey]);

    const nextPeriodIndex = schedule.days[selectedDay.dayKey].findIndex((period) => period.start === start && period.end === end);
    selectScheduleDay(index, selectedDay.dayKey);
    selectSchedulePeriod(index, selectedDay.dayKey, nextPeriodIndex);
    markSchedulesDirty();
    renderScheduleSidebar();
    renderCanvas();
    renderInspector();
    setStatus("Schedule period updated.");
  };

  inspector?.querySelectorAll("[data-schedule-day-edit-item]").forEach((item) => {
    item.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-schedule-day-edit-delete], input, select, textarea")) {
        return;
      }
      const selectedDay = getSelectedDayEntry();
      const periodIndex = Number(item.dataset.scheduleDayEditSelect || -1);
      if (!selectedDay || periodIndex < 0) return;
      selectSchedulePeriod(index, selectedDay.dayKey, periodIndex);
      renderCanvas();
      renderInspector();
    });
  });

  inspector?.querySelectorAll("[data-schedule-day-edit-start], [data-schedule-day-edit-end]").forEach((input) => {
    input.addEventListener("change", () => {
      const item = input.closest("[data-schedule-day-edit-item]");
      const periodIndex = Number(item?.dataset.scheduleDayEditItem || -1);
      if (periodIndex < 0) return;
      applyDayPeriodEdit(periodIndex);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const item = input.closest("[data-schedule-day-edit-item]");
      const periodIndex = Number(item?.dataset.scheduleDayEditItem || -1);
      if (periodIndex < 0) return;
      applyDayPeriodEdit(periodIndex);
    });
  });

  inspector?.querySelectorAll("[data-schedule-day-edit-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedDay = getSelectedDayEntry();
      const periodIndex = Number(button.dataset.scheduleDayEditDelete || -1);
      if (!selectedDay || periodIndex < 0) return;

      selectedDay.schedule.days[selectedDay.dayKey].splice(periodIndex, 1);
      selectedDay.schedule.days[selectedDay.dayKey] = normalizeScheduleDayPeriods(selectedDay.schedule.days[selectedDay.dayKey]);
      if (state.selectedSchedulePeriod?.scheduleIndex === index
        && state.selectedSchedulePeriod?.dayKey === selectedDay.dayKey
        && state.selectedSchedulePeriod?.periodIndex === periodIndex) {
        state.selectedSchedulePeriod = null;
      }
      selectScheduleDay(index, selectedDay.dayKey);
      markSchedulesDirty();
      renderScheduleSidebar();
      renderCanvas();
      renderInspector();
    });
  });

}

function bindScheduleWorkspace(index) {
  const workspace = document.getElementById("scheduleWorkspaceBody");
  const viewport = document.getElementById("schedulePlannerViewport");
  const getSchedule = () => currentSchedules()[index];

  window.requestAnimationFrame(() => syncScheduleBlockTimeVisibility(workspace || document));

  state.scheduleBlockResizeObserver?.disconnect();
  state.scheduleBlockResizeObserver = null;
  if (typeof ResizeObserver === "function" && viewport) {
    state.scheduleBlockResizeObserver = new ResizeObserver(() => {
      syncScheduleBlockTimeVisibility(workspace || document);
    });
    state.scheduleBlockResizeObserver.observe(viewport);
  }

  if (viewport) {
    const restoreTop = state.scheduleViewportScrollTop ?? 0;
    const restoreLeft = state.scheduleViewportScrollLeft ?? (SCHEDULE_INITIAL_SCROLL_HOUR * SCHEDULE_HOUR_WIDTH);
    viewport.scrollTop = restoreTop;
    viewport.scrollLeft = restoreLeft;
    viewport.addEventListener("scroll", () => {
      state.scheduleViewportScrollTop = viewport.scrollTop;
      state.scheduleViewportScrollLeft = viewport.scrollLeft;
    });
  }

  workspace?.addEventListener("focusin", () => {
    setSchedulesInteracting(true);
  });

  workspace?.addEventListener("focusout", (ev) => {
    const nextTarget = ev.relatedTarget;
    const currentTarget = ev.currentTarget;
    if (nextTarget instanceof Node && currentTarget instanceof Node && currentTarget.contains(nextTarget)) {
      return;
    }
    setSchedulesInteracting(false);
  });

  workspace?.querySelectorAll(".scheduleDayTrack").forEach((track) => {
    track.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest("[data-schedule-block]")) return;

      const dayKey = track.dataset.scheduleTrack;
      if (!dayKey) return;
      selectScheduleDay(index, dayKey);
      if (track.dataset.scheduleDisabled === "true") {
        renderCanvas();
        renderInspector();
        return;
      }

      const anchorMinutes = scheduleTrackMinutesFromClient(dayKey, event.clientX);
      startScheduleDrag({
        mode: "create",
        scheduleIndex: index,
        sourceDayKey: null,
        sourcePeriodIndex: null,
        targetDayKey: dayKey,
        anchorMinutes,
        startMinutes: anchorMinutes,
        endMinutes: Math.min(SCHEDULE_MAX_MINUTE, anchorMinutes + SCHEDULE_MIN_DURATION_MINUTES),
      });
      event.preventDefault();
    });
  });

  workspace?.querySelectorAll("[data-schedule-day-select]").forEach((button) => {
    button.addEventListener("click", () => {
      const dayKey = button.dataset.scheduleDaySelect;
      if (!dayKey) return;
      selectScheduleDay(index, dayKey);
      renderCanvas();
      renderInspector();
    });
  });

  workspace?.querySelectorAll("[data-schedule-delete]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const schedule = getSchedule();
      if (!schedule) return;

      const dayKey = button.dataset.scheduleSourceDay;
      const periodIndex = Number(button.dataset.schedulePeriodIndex || -1);
      if (!dayKey || periodIndex < 0) return;

      const selected = state.selectedSchedulePeriod;
      if (selected && selected.scheduleIndex === index && selected.dayKey === dayKey && selected.periodIndex === periodIndex) {
        state.selectedSchedulePeriod = null;
      }

      selectScheduleDay(index, dayKey);

      schedule.days[dayKey].splice(periodIndex, 1);
      schedule.days[dayKey] = normalizeScheduleDayPeriods(schedule.days[dayKey]);
      markSchedulesDirty();
      renderScheduleSidebar();
      renderCanvas();
      renderInspector();
      event.preventDefault();
      event.stopPropagation();
    });
  });

  workspace?.querySelectorAll("[data-schedule-block]").forEach((block) => {
    block.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("[data-schedule-delete]")) return;

      const schedule = getSchedule();
      if (!schedule) return;

      const dayKey = block.dataset.scheduleDay;
      const periodIndex = Number(block.dataset.schedulePeriodIndex || -1);
      const editable = block.dataset.scheduleEditable === "true";
      if (!dayKey || periodIndex < 0 || !editable) return;

      selectScheduleDay(index, dayKey);
      selectSchedulePeriod(index, dayKey, periodIndex);
      renderInspector();

      const period = schedule.days?.[dayKey]?.[periodIndex];
      if (!period) return;

      const startMinutes = scheduleTimeToMinutes(period.start);
      const endMinutes = scheduleTimeToMinutes(period.end);
      if (endMinutes <= startMinutes) return;

      const resizeHandle = event.target.closest("[data-schedule-resize]");
      if (resizeHandle) {
        startScheduleDrag({
          mode: resizeHandle.dataset.scheduleResize === "start" ? "resize-start" : "resize-end",
          scheduleIndex: index,
          sourceDayKey: dayKey,
          sourcePeriodIndex: periodIndex,
          targetDayKey: dayKey,
          originalStartMinutes: startMinutes,
          originalEndMinutes: endMinutes,
          startMinutes,
          endMinutes,
        });
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const pointerMinutes = scheduleTrackMinutesFromClient(dayKey, event.clientX);
      startScheduleDrag({
        mode: "move",
        scheduleIndex: index,
        sourceDayKey: dayKey,
        sourcePeriodIndex: periodIndex,
        targetDayKey: dayKey,
        originalStartMinutes: startMinutes,
        originalEndMinutes: endMinutes,
        startMinutes,
        endMinutes,
        durationMinutes: endMinutes - startMinutes,
        pointerOffsetMinutes: Math.max(0, Math.min(endMinutes - startMinutes, pointerMinutes - startMinutes)),
      });
      event.preventDefault();
      event.stopPropagation();
    });
  });
}

function validatePublicVariables() {
  const keys = new Set();

  for (const variable of currentPublicVariables()) {
    const key = (variable.key || "").trim();
    if (!key) {
      throw new Error("Every public variable needs a key.");
    }
    if (keys.has(key)) {
      throw new Error(`Duplicate variable key: ${key}`);
    }
    keys.add(key);

    if (normalizeVariableSource(variable.source) !== "physical_input" && normalizeVariableType(variable.type) === "schedule") {
      const scheduleKey = String(variable.value || "").trim();
      if (scheduleKey && !scheduleByKey(scheduleKey)) {
        throw new Error(`Variable '${key}' references an unknown schedule: ${scheduleKey}`);
      }
    }
  }
}

function serializePublicVariables() {
  return {
    items: currentPublicVariables().map((variable) => ({
      key: (variable.key || "").trim(),
      type: normalizeVariableType(variable.type),
      source: normalizeVariableSource(variable.source),
      input_kind: normalizeVariableSource(variable.source) === "physical_input"
        ? String(variable.input_kind || "digital").trim().toLowerCase()
        : null,
      channel: normalizeVariableSource(variable.source) === "physical_input"
        ? normalizePhysicalChannelSelection(variable.input_kind || "digital", variable.channel || "1")
        : null,
      value: variable.value,
    })),
  };
}

function addPublicVariable() {
  state.publicVariables.push({
    key: nextPublicVariableKey(),
    source: "manual",
    type: "string",
    value: "",
    current_value: "",
    input_kind: "",
    channel: "",
  });

  if (el("variableSearch")) {
    el("variableSearch").value = "";
  }

  selectPublicVariable(currentPublicVariables().length - 1);
  setSidebarSectionExpanded("variables", true);
  markPublicVariablesDirty();
  renderPublicVariablesSidebar();
  renderInspector();
}

function removePublicVariable(index) {
  if (!currentPublicVariables()[index]) return;

  state.publicVariables.splice(index, 1);

  if (!currentPublicVariables().length) {
    state.selectedPublicVariableIndex = null;
  } else {
    state.selectedPublicVariableIndex = Math.min(index, currentPublicVariables().length - 1);
  }

  markPublicVariablesDirty();
  renderPublicVariablesSidebar();
  renderInspector();
}

function renderPublicVariablesSidebar() {
  const box = el("publicVariableList");
  if (!box) return;

  const q = (el("variableSearch")?.value || "").trim().toLowerCase();
  const selectedVariable = currentSelectedPublicVariable();
  const items = currentPublicVariables().map((variable, idx) => ({ variable, idx })).filter(({ variable }) => {
    if (!q) return true;

    const type = normalizeVariableType(variable.type);
    const haystack = [
      variable.key || "",
      type,
      normalizeVariableSource(variable.source),
      physicalLabel(variable.input_kind || "digital", variable.channel || "1"),
      scheduleNameForKey(variable.current_value ?? variable.value),
      formatVariableValue(variable.current_value ?? variable.value, type),
    ].join(" ").toLowerCase();

    return haystack.includes(q);
  });

  syncPublicVariablesHeader();
  syncSidebarSection("variables", currentPublicVariables().length > 0);

  const currentCard = !selectedVariable ? `
    <div class="varCard varCardActionsOnly">
      <div class="sidebarCardActions is-standalone">
        <button class="btn btn-primary btn-compact" id="btnAddPublicVariable" type="button">New</button>
        <button class="btn btn-compact" id="btnSavePublicVariables" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeletePublicVariable" type="button">Delete</button>
      </div>
    </div>` : "";

  box.innerHTML = `
    ${currentCard}
    ${currentPublicVariables().length ? "" : `<div class="emptyState">No shared variables yet.</div>`}
    ${items.length ? items.map(({ variable, idx }) => {
    const variableType = normalizeVariableType(variable.type);
    const isActive = idx === state.selectedPublicVariableIndex;
    const currentValue = summarizeVariableValue(variable.current_value ?? variable.value, variableType);
    const source = normalizeVariableSource(variable.source);
    const sourceLabel = source === "physical_input"
      ? physicalLabel(variable.input_kind || "digital", variable.channel || "1")
      : variableType;

    return `
      <${isActive ? "div" : "button"} class="varCard is-preview ${isActive ? "active varCardCurrent" : ""}" ${isActive ? "" : 'type="button"'} data-public-variable-index="${idx}" aria-pressed="${isActive ? "true" : "false"}">
        <div class="varCardTop">
          <div class="varCardName">${escapeHtml(variable.key || `var_${idx + 1}`)}</div>
        </div>
        <div class="chipRow">
          <span class="miniPill">${escapeHtml(sourceLabel)}</span>
          <span class="miniPill jsPublicVarCurrentPreview">${escapeHtml(currentValue)}</span>
        </div>
        ${isActive ? `
        <div class="sidebarCardActions">
          <button class="btn btn-primary btn-compact" id="btnAddPublicVariable" type="button">New</button>
          <button class="btn btn-compact" id="btnSavePublicVariables" type="button">Save</button>
          <button class="btn btn-danger btn-compact" id="btnDeletePublicVariable" type="button">Delete</button>
        </div>` : ""}
      </${isActive ? "div" : "button"}>
    `;
  }).join("") : ""}
  `;

  bindPublicVariableActionButtons();
  syncPublicVariablesHeader();

  box.querySelectorAll(".varCard.is-preview").forEach((card) => {
    if (card.classList.contains("varCardCurrent")) return;
    card.addEventListener("click", () => {
      const index = Number(card.dataset.publicVariableIndex || -1);
      if (!currentPublicVariables()[index]) return;
      selectPublicVariable(index);
      renderPublicVariablesSidebar();
      renderInspector();
      renderCanvas();
      drawEdges();
    });
  });

  refreshPublicVariableRuntimeUi();
}

function handleAddPublicVariable() {
  addPublicVariable();
}

async function handleSavePublicVariables() {
  try {
    await savePublicVariables();
  } catch (err) {
    setStatus(err.message || String(err), true);
  }
}

function handleDeletePublicVariable() {
  if (state.selectedPublicVariableIndex == null) return;
  removePublicVariable(state.selectedPublicVariableIndex);
}

function bindPublicVariableActionButtons() {
  el("btnAddPublicVariable")?.addEventListener("click", (event) => {
    event.stopPropagation();
    handleAddPublicVariable();
  });

  el("btnSavePublicVariables")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handleSavePublicVariables();
  });

  el("btnDeletePublicVariable")?.addEventListener("click", (event) => {
    event.stopPropagation();
    handleDeletePublicVariable();
  });
}

function bindPublicVariableInspector(index) {
  const inspector = document.getElementById("publicVariableInspectorBody");
  const getVariable = () => currentPublicVariables()[index];

  document.getElementById("btnInspectorAddPublicVariable")?.addEventListener("click", () => {
    handleAddPublicVariable();
  });

  document.getElementById("btnInspectorSavePublicVariables")?.addEventListener("click", async () => {
    await handleSavePublicVariables();
  });

  document.getElementById("btnInspectorDeletePublicVariable")?.addEventListener("click", () => {
    handleDeletePublicVariable();
  });

  inspector?.addEventListener("focusin", () => {
    setPublicVariablesInteracting(true);
  });

  inspector?.addEventListener("focusout", (ev) => {
    const nextTarget = ev.relatedTarget;
    const currentTarget = ev.currentTarget;
    if (nextTarget instanceof Node && currentTarget instanceof Node && currentTarget.contains(nextTarget)) {
      return;
    }
    setPublicVariablesInteracting(false);
  });

  document.getElementById("publicVariableKeyInput")?.addEventListener("input", (ev) => {
    const variable = getVariable();
    if (!variable) return;
    variable.key = ev.target.value.trim();
    markPublicVariablesDirty();
    renderPublicVariablesSidebar();

    const title = document.querySelector(".publicVariableInspectorName");
    if (title) title.textContent = variable.key || `var_${index + 1}`;
    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${flowVariableLabel(variable.key || `var_${index + 1}`)} settings`;
    }
  });

  const syncVariableType = (value) => {
    const variable = getVariable();
    if (!variable) return;
    const nextTypeChoice = normalizeVariableTypeChoice(value);
    const nextPhysicalKind = physicalKindFromVariableTypeChoice(nextTypeChoice);
    const isPhysical = normalizeVariableSource(variable.source) === "physical_input";

    if (nextPhysicalKind) {
      const nextPrimitiveType = nextPhysicalKind === "analog" ? "number" : "boolean";
      const channel = normalizePhysicalChannelSelection(nextPhysicalKind, variable.channel || "1");
      const nextValue = nextPrimitiveType === "number" ? 0 : false;
      if (
        isPhysical &&
        String(variable.input_kind || "").trim().toLowerCase() === nextPhysicalKind &&
        variable.channel === channel &&
        normalizeVariableType(variable.type) === nextPrimitiveType
      ) {
        return;
      }

      variable.source = "physical_input";
      variable.input_kind = isPhysical ? String(variable.input_kind || "digital").trim().toLowerCase() || "digital" : nextPhysicalKind;
      variable.channel = isPhysical ? normalizePhysicalChannelSelection(variable.input_kind, variable.channel || "1") : channel;
      variable.type = variable.input_kind === "analog" ? "number" : "boolean";
      variable.value = variable.type === "number" ? 0 : false;
      variable.current_value = variable.value;
    } else {
      const nextType = normalizeVariableType(nextTypeChoice);
      if (!isPhysical && normalizeVariableType(variable.type) === nextType) return;

      variable.source = "manual";
      variable.input_kind = "";
      variable.channel = "";
      variable.type = nextType;
      if (isPhysical) {
        variable.value = "";
        variable.current_value = "";
      } else if (nextType === "schedule") {
        variable.value = "";
        variable.current_value = "";
      }
    }

    markPublicVariablesDirty();
    renderPublicVariablesSidebar();
    renderInspector();
  };

  document.getElementById("publicVariableTypeInput")?.addEventListener("input", (ev) => {
    syncVariableType(ev.target.value);
  });

  document.getElementById("publicVariableTypeInput")?.addEventListener("change", (ev) => {
    syncVariableType(ev.target.value);
  });

  const syncPhysicalBinding = () => {
    const variable = getVariable();
    if (!variable || normalizeVariableSource(variable.source) !== "physical_input") return;

    variable.input_kind = String(document.getElementById("publicVariableInputKind")?.value || variable.input_kind || "digital").trim().toLowerCase();
    if (!["digital", "analog", "output", "relay"].includes(variable.input_kind)) {
      variable.input_kind = "digital";
    }
    variable.channel = normalizePhysicalChannelSelection(variable.input_kind, document.getElementById("publicVariableChannelInput")?.value || variable.channel || "1");
    variable.type = variable.input_kind === "analog" ? "number" : "boolean";
    variable.value = variable.type === "number" ? 0 : false;
    variable.current_value = variable.value;
    markPublicVariablesDirty();
    renderPublicVariablesSidebar();
    renderInspector();
  };

  document.getElementById("publicVariableInputKind")?.addEventListener("change", syncPhysicalBinding);
  document.getElementById("publicVariableChannelInput")?.addEventListener("change", syncPhysicalBinding);

  const applyDefaultValue = (value) => {
    const variable = getVariable();
    if (!variable) return;
    if (normalizeVariableSource(variable.source) === "physical_input") return;
    variable.value = value;
    variable.current_value = value;
    markPublicVariablesDirty();
    renderPublicVariablesSidebar();
  };

  document.getElementById("publicVariableValueInput")?.addEventListener("input", (ev) => {
    applyDefaultValue(ev.target.value);
  });

  document.getElementById("publicVariableValueInput")?.addEventListener("change", (ev) => {
    applyDefaultValue(ev.target.value);
  });
}

function refreshPublicVariableRuntimeUi() {
  syncPublicVariablesHeader();

  document.querySelectorAll("#publicVariableList .varCard").forEach((row) => {
    const idx = Number(row.dataset.publicVariableIndex || -1);
    const variable = currentPublicVariables()[idx];
    if (!variable) return;

    const currentPreview = row.querySelector(".jsPublicVarCurrentPreview");
    if (currentPreview) {
      currentPreview.textContent = summarizeVariableValue(variable.current_value ?? variable.value, variable.type);
    }
  });

  if (state.publicVariablesInteracting) {
    return;
  }

  const selectedVariable = currentSelectedPublicVariable();
  const valueInput = document.getElementById("publicVariableValueInput");
  if (selectedVariable && valueInput) {
    valueInput.value = formatVariableValue(selectedVariable.current_value ?? selectedVariable.value, selectedVariable.type);
  }

  const channelInput = document.getElementById("publicVariableChannelInput");
  const physicalKindInput = document.getElementById("publicVariableInputKind");
  if (selectedVariable && physicalKindInput && normalizeVariableSource(selectedVariable.source) === "physical_input") {
    physicalKindInput.value = String(selectedVariable.input_kind || "digital").trim().toLowerCase() || "digital";
  }

  if (selectedVariable && channelInput && normalizeVariableSource(selectedVariable.source) === "physical_input") {
    const inputKind = String(selectedVariable.input_kind || "digital").trim().toLowerCase();
    const selectedChannel = normalizePhysicalChannelSelection(inputKind, selectedVariable.channel || "1");
    channelInput.innerHTML = physicalInputChannelOptionsHtml(inputKind, selectedChannel);
    channelInput.value = selectedChannel;
  }
}

function refreshScheduleRuntimeUi() {
  syncSchedulesHeader();

  document.querySelectorAll("#scheduleList .varCard").forEach((row) => {
    const idx = Number(row.dataset.scheduleIndex || -1);
    const schedule = currentSchedules()[idx];
    if (!schedule) return;

    const statusPreview = row.querySelector(".jsScheduleStatusPreview");
    if (statusPreview) {
      statusPreview.textContent = scheduleStatusLabel(schedule);
      statusPreview.classList.toggle("is-active", schedule.is_active);
      statusPreview.classList.toggle("is-inactive", !schedule.is_active);
    }
  });

  if (state.schedulesInteracting) {
    return;
  }

  const selectedSchedule = currentSelectedSchedule();
  const statusPill = document.getElementById("scheduleInspectorStatus");
  if (selectedSchedule && statusPill) {
    statusPill.textContent = scheduleStatusLabel(selectedSchedule);
    statusPill.classList.toggle("is-active", selectedSchedule.is_active);
    statusPill.classList.toggle("is-inactive", !selectedSchedule.is_active);
  }
}

async function refreshSchedules(silent = true) {
  try {
    const data = await api("/api/schedules");
    const incoming = normalizeScheduleRecords(Array.isArray(data?.items) ? data.items : []);
    const incomingFingerprint = schedulesDefinitionFingerprint(incoming);
    const currentFingerprint = schedulesDefinitionFingerprint(state.schedules);

    state.schedulesUpdatedAt = data?.evaluated_at || null;

    const activeByKey = new Map(incoming.map((item) => [item.key, item.is_active]));

    if (state.schedulesDirty || state.schedulesInteracting) {
      for (const schedule of state.schedules) {
        if (activeByKey.has(schedule.key)) {
          schedule.is_active = Boolean(activeByKey.get(schedule.key));
        }
      }
      refreshScheduleRuntimeUi();
      return;
    }

    if (incomingFingerprint !== currentFingerprint) {
      state.schedules = incoming;
      renderScheduleSidebar();
      if (!inspectorHasFocus()) {
        renderInspector();
      }
      return;
    }

    for (const schedule of state.schedules) {
      if (activeByKey.has(schedule.key)) {
        schedule.is_active = Boolean(activeByKey.get(schedule.key));
      }
    }

    refreshScheduleRuntimeUi();
  } catch (err) {
    if (!silent) {
      setStatus(err.message || String(err), true);
    }
  }
}

function startSchedulesPolling() {
  if (state.schedulesTimer) {
    window.clearInterval(state.schedulesTimer);
  }

  state.schedulesTimer = window.setInterval(() => {
    refreshSchedules(true).catch(() => { });
  }, 30000);
}

async function saveSchedules() {
  validateSchedules();

  const out = await api("/api/schedules", {
    method: "PUT",
    body: JSON.stringify(serializeSchedules()),
  });

  state.schedules = normalizeScheduleRecords(Array.isArray(out?.items) ? out.items : []);
  state.schedulesUpdatedAt = out?.evaluated_at || null;
  clearSchedulesDirty();
  renderScheduleSidebar();
  renderInspector();
  setStatus("Schedules saved.");
}

function bindFlowInspector(flow) {
  document.getElementById("btnInspectorNewFlow")?.addEventListener("click", () => {
    handleNewFlow();
  });

  document.getElementById("btnInspectorSaveFlow")?.addEventListener("click", async () => {
    await handleSaveFlow();
  });

  document.getElementById("btnInspectorDeleteFlow")?.addEventListener("click", async () => {
    await handleDeleteFlow();
  });

  document.getElementById("btnInspectorDuplicateFlow")?.addEventListener("click", () => {
    duplicateDraft();
  });

  document.getElementById("btnInspectorExportFlows")?.addEventListener("click", () => {
    exportFlows();
  });

  document.getElementById("btnInspectorImportFlows")?.addEventListener("click", async () => {
    await importFlows();
  });

  el("flowNameInput")?.addEventListener("input", () => {
    flow.name = el("flowNameInput").value;
    markDirty();
    renderFlowList();
    syncHeader();
  });

  el("flowEnabledInput")?.addEventListener("change", () => {
    flow.enabled = el("flowEnabledInput").checked;
    markDirty();
    renderFlowList();
    renderInspector();
  });
}

function renderNodeInspector(node) {
  const cfg = node.config || {};
  const common = `
    <div class="inspectorCard">
      <div class="inspectorTitle">${escapeHtml(displayNodeTitle(node) || node.label)}</div>
      <div class="fieldGrid mt-10">
        <div class="full">
          <label>Display label</label>
          <input id="nodeLabelInput" value="${escapeHtml(node.label || "")}" />
        </div>
      </div>
    </div>
  `;

  let body = "";

  switch (node.type) {
    case "trigger.onvif_event":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Trigger details</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Front door motion" />
            </div>
            <div class="full">
              <label>Device</label>
              <select id="cfg_device_id">${deviceOptionsHtml(cfg.device_id || "")}</select>
            </div>
            <div class="full">
              <label>Topic</label>
              <input id="cfg_topic_search" class="topicPickerSearch" data-inspector-transient="true" placeholder="Search motion, relay, input, tamper..." />
              <div class="inlineMeta topicPickerMeta" id="cfg_topic_meta">Load topics for this device to search them.</div>
              <input id="cfg_topic" type="hidden" value="${escapeHtml(cfg.topic || "")}" />
              <div id="cfg_topic_list" class="topicPickerList"></div>
            </div>
            <div class="full row2 mt-0">
              <button class="btn" id="btnRefreshTopics" type="button">Refresh topics</button>
            </div>
          </div>
        </div>
      `;
      break;

    case "trigger.device_offline":
    case "trigger.device_back_online":
    case "trigger.ptz_manual_control_started":
    case "trigger.ptz_manual_control_stopped":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Trigger details</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Device</label>
              <select id="cfg_device_id">${deviceOptionsHtml(cfg.device_id || "")}</select>
            </div>
          </div>
        </div>
      `;
      break;

    case "trigger.incoming_http_request":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Webhook trigger</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Webhook trigger" />
            </div>
            <div>
              <label>Method</label>
              <select id="cfg_method">${methodOptionsHtml(cfg.method || "ANY", true)}</select>
            </div>
            <div>
              <label>Path</label>
              <input id="cfg_path" value="${escapeHtml(cfg.path || "")}" placeholder="/flow-hook/order" />
            </div>
            <div class="full">
              <label>URL</label>
              <input value="${escapeHtml(buildWebhookUrl(cfg.path || ""))}" readonly />
            </div>
          </div>
        </div>
      `;
      break;

    case "trigger.manual":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Manual trigger</div>
          <div class="inspectorHint">Run this flow path manually from the editor.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Manual trigger" />
            </div>
            <div class="full row2 mt-0">
              <button class="btn btn-primary" id="btnRunManualNode" type="button">Run manual trigger</button>
            </div>
          </div>
        </div>
      `;
      break;

    case "trigger.schedule_active":
    case "trigger.schedule_inactive": {
      const schedule = scheduleByKey(cfg.schedule_key || "");
      const title = node.type === "trigger.schedule_active" ? "Schedule becomes active" : "Schedule becomes inactive";
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">${escapeHtml(title)}</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Schedule</label>
              <select id="cfg_schedule_key">${scheduleOptionsHtml(cfg.schedule_key || "")}</select>
            </div>
            <div class="full inlineMeta">${escapeHtml(schedule ? `${scheduleStatusLabel(schedule)} · ${scheduleSummary(schedule)}` : "Select a schedule to watch for active-hour changes.")}</div>
          </div>
        </div>
      `;
      break;
    }

    case "condition.schedule_active": {
      const schedule = scheduleByKey(cfg.schedule_key || "");
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Schedule active</div>
          <div class="inspectorHint">Checks a schedule and follows THEN when it is active or ELSE when it is inactive.</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Schedule</label>
              <select id="cfg_schedule_key">${scheduleOptionsHtml(cfg.schedule_key || "")}</select>
            </div>
            <div class="full inlineMeta">${escapeHtml(schedule ? `${scheduleStatusLabel(schedule)} · ${scheduleSummary(schedule)}` : "Select a schedule to evaluate.")}</div>
          </div>
        </div>
      `;
      break;
    }

    case "trigger.digital_input_changed":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Digital input trigger</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Input</label>
              <select id="cfg_channel">${physicalChannelOptionsHtml("digital", cfg.channel || "1")}</select>
            </div>
            ${renderPhysicalLiveField("digital", cfg.channel || "1", "Current state")}
          </div>
        </div>
      `;
      break;

    case "trigger.analog_input_above":
    case "trigger.analog_input_below":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Analog threshold trigger</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Input</label>
              <select id="cfg_channel">${physicalChannelOptionsHtml("analog", cfg.channel || "1")}</select>
            </div>
            <div>
              <label>Threshold (V)</label>
              <input id="cfg_threshold" type="number" step="0.01" value="${escapeHtml(cfg.threshold ?? 1)}" />
            </div>
            ${renderPhysicalLiveField("analog", cfg.channel || "1", "Current voltage")}
          </div>
        </div>
      `;
      break;

    case "trigger.physical_output_changed": {
      const targetKind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      const channel = normalizePhysicalChannelSelection(targetKind, cfg.channel || "1");
      const channelLabel = targetKind === "relay" ? "Relay" : "Output";
      const currentLabel = targetKind === "relay" ? "Current relay state" : "Current output state";

      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Physical output trigger</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Target type</label>
              <select id="cfg_target_kind">${physicalTargetKindOptionsHtml(targetKind)}</select>
            </div>
            <div>
              <label>${channelLabel}</label>
              <select id="cfg_channel">${targetKind === "relay" ? physicalRelayOptionsHtml(channel) : physicalOutputOptionsHtml(channel)}</select>
            </div>
            ${renderPhysicalLiveField(targetKind, channel, currentLabel)}
          </div>
        </div>
      `;
      break;
    }

    case "condition.compare":
      const leftSource = cfg.left_source || "variable";
      const rightSource = cfg.right_source || "literal";
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Compare</div>
          <div class="inspectorHint">Checks a condition, then follows THEN when it passes or ELSE when it fails.</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Compare source</label>
              <select id="cfg_left_source">${sourceOptionsHtml(leftSource, true)}</select>
            </div>
            <div class="${leftSource === "physical_input" ? "full" : ""}">
              <label>Compare value / path</label>
              ${renderCompareSourceValueControl("left", leftSource, cfg.left_value || "")}
            </div>
            <div>
              <label>Operator</label>
              <select id="cfg_operator">${compareOperatorOptionsHtml(cfg.operator || "equals")}</select>
            </div>
            <div>
              <label>Cast as</label>
              <select id="cfg_cast">${castOptionsHtml(cfg.cast || "auto")}</select>
            </div>
            <div>
              <label>Compare to source</label>
              <select id="cfg_right_source">${sourceOptionsHtml(rightSource, true)}</select>
            </div>
            <div class="${rightSource === "physical_input" ? "full" : ""}">
              <label>Compare to value / path</label>
              ${renderCompareSourceValueControl("right", rightSource, cfg.right_value || "")}
            </div>
          </div>
        </div>
      `;
      break;

    case "operator.delay":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Delay</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Seconds</label>
              <input id="cfg_seconds" type="number" min="0" step="0.1" value="${escapeHtml(cfg.seconds ?? 0)}" />
            </div>
          </div>
        </div>
      `;
      break;

    case "operator.set_variable":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Set variable</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Variable</label>
              <select id="cfg_variable_key">${variableKeyOptionsHtml(cfg.variable_key || "", { includePhysical: false })}</select>
            </div>
            <div>
              <label>Value source</label>
              <select id="cfg_value_source">${sourceOptionsHtml(cfg.value_source || "literal", true, "Literal")}</select>
            </div>
            <div class="full">
              <label>Value</label>
              ${renderSetVariableValueControl(cfg)}
            </div>
            ${renderSetVariableTemplateHelp(cfg)}
          </div>
        </div>
      `;
      break;

    case "action.send_http_request":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">HTTP request</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div>
              <label>Method</label>
              <select id="cfg_method">${methodOptionsHtml(cfg.method || "POST")}</select>
            </div>
            <div>
              <label>Timeout (seconds)</label>
              <input id="cfg_timeout_seconds" type="number" min="0.1" step="0.1" value="${escapeHtml(cfg.timeout_seconds ?? 10)}" />
            </div>
            <div class="full">
              <label>URL</label>
              <input id="cfg_url" value="${escapeHtml(cfg.url || "")}" placeholder="http://example.local/hook" />
            </div>
            <div class="full">
              <label>Headers (JSON)</label>
              <textarea id="cfg_headers" rows="5">${escapeHtml(cfg.headers || "{}")}</textarea>
            </div>
            <div class="full">
              <label>Body</label>
              <textarea id="cfg_body" rows="6">${escapeHtml(cfg.body || "")}</textarea>
            </div>
          </div>
        </div>
      `;
      break;

    case "action.activate_physical_output":
    case "action.activate_physical_relay":
      body = renderPhysicalSwitchActionInspector({
        title: "Physical output",
        targetKind: node.type === "action.activate_physical_relay"
          ? "relay"
          : (String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output"),
        channel: cfg.channel || "1",
        name: cfg.name || "",
        mode: cfg.mode || "pulse",
        pulseSeconds: cfg.pulse_seconds ?? 2,
      });
      break;

    case "action.record":
      {
        const selectedPreset = recordingPresetByName(cfg.preset_name || cfg.name);
        const tagColor = selectedPreset?.color || cfg.color || "#c6a14b";
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Start recording</div>
          <div class="inspectorHint">Starts a colored playback marker for the selected camera using a shared recording tag. Use a Stop recording node later in the flow to end it.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Tag</label>
              <select id="cfg_preset_name">${recordingPresetOptionsHtml(cfg.preset_name || cfg.name || "")}</select>
            </div>
            <div class="full">
              <label>Camera</label>
              <select id="cfg_device_id">${deviceOptionsHtml(cfg.device_id || "")}</select>
            </div>
            <div>
              <label>Seconds before</label>
              <input id="cfg_before_seconds" type="number" min="0" step="1" value="${escapeHtml(cfg.before_seconds ?? 10)}" />
            </div>
            <div class="full">
              <label>Tag color</label>
              <div class="recordingPresetColorRow recordingTagColorPreview is-readonly">
                <span class="recordingTagColorSwatch is-large" style="background:${escapeHtml(tagColor)};"></span>
                <span class="miniPill">${escapeHtml(tagColor)}</span>
              </div>
            </div>
          </div>
        </div>
      `;
      }
      break;

    case "action.stop_recording":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Stop recording</div>
          <div class="inspectorHint">Stops the most recent in-progress recording marker for the selected camera.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Camera</label>
              <select id="cfg_device_id">${deviceOptionsHtml(cfg.device_id || "")}</select>
            </div>
          </div>
        </div>
      `;
      break;

    case "action.log_message":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Log message</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Message</label>
              <textarea id="cfg_message" rows="6">${escapeHtml(cfg.message || "")}</textarea>
            </div>
          </div>
        </div>
      `;
      break;

    default:
      body = `<div class="inspectorCard"><div class="inspectorHint">No editor available for this node yet.</div></div>`;
      break;
  }

  return `${common}
    <datalist id="variableKeysList">
      ${currentPublicVariables().map((variable) => `<option value="${escapeHtml(variable.key)}"></option>`).join("")}
    </datalist>
    ${body}
    <div class="inspectorCard inspectorActionsCard inspectorActionsCard--danger">
      <div class="inspectorActionHeader">
        <div class="inspectorTitle">Node actions</div>
        <div class="inspectorHint">Remove this node and its connections from the flow.</div>
      </div>
      <div class="inspectorActionGrid inspectorActionGrid--single">
        <button class="btn btn-danger" id="btnDeleteNode" type="button">Delete node</button>
      </div>
    </div>
  `;
}

function bindNodeInspector(node) {
  document.getElementById("btnDeleteNode")?.addEventListener("click", () => {
    const flow = currentFlow();
    flow.nodes = flow.nodes.filter((item) => item.id !== node.id);
    flow.edges = flow.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
    state.selectedNodeId = null;
    markDirty();
    renderAll();
    setStatus("Node deleted.");
  });

  document.getElementById("nodeLabelInput")?.addEventListener("input", (ev) => {
    node.label = ev.target.value;
    markDirty();
    renderCanvas();

    const title = document.querySelector("#inspectorBody .inspectorCard .inspectorTitle");
    if (title) {
      title.textContent = displayNodeTitle(node) || node.label;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${displayNodeTitle(node) || node.label} settings`;
    }
  });

  for (const element of document.querySelectorAll("#inspectorBody input, #inspectorBody select, #inspectorBody textarea")) {
    if (element.id === "nodeLabelInput" || element.dataset.inspectorTransient === "true") continue;
    element.addEventListener("input", () => applyNodeInspector(node));
    element.addEventListener("change", () => applyNodeInspector(node));
  }

  if (node.type === "trigger.onvif_event") {
    hydrateTopicSelect(node, false);

    document.getElementById("cfg_topic_search")?.addEventListener("input", () => {
      renderTopicPicker(node);
    });

    document.getElementById("cfg_device_id")?.addEventListener("change", async () => {
      node.config.device_id = document.getElementById("cfg_device_id").value;
      node.config.topic = "";
      if (document.getElementById("cfg_topic_search")) {
        document.getElementById("cfg_topic_search").value = "";
      }
      await hydrateTopicSelect(node, false);
      markDirty();
      renderCanvas();
    });

    document.getElementById("btnRefreshTopics")?.addEventListener("click", async () => {
      await hydrateTopicSelect(node, true);
    });
  }

  if (node.type === "trigger.manual") {
    document.getElementById("btnRunManualNode")?.addEventListener("click", async () => {
      try {
        await triggerManualNode(node.id);
      } catch { }
    });
  }

  if (node.type === "trigger.physical_output_changed") {
    document.getElementById("cfg_target_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (node.type === "action.activate_physical_output" || node.type === "action.activate_physical_relay") {
    document.getElementById("cfg_target_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (node.type === "condition.compare") {
    document.getElementById("cfg_left_source")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_right_source")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_left_input_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_right_input_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_left_channel")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_right_channel")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (node.type === "condition.schedule_active") {
    document.getElementById("cfg_schedule_key")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (node.type === "operator.set_variable") {
    document.getElementById("cfg_variable_key")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_value_source")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_value_input_kind")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });

    document.getElementById("cfg_value_channel")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (["trigger.digital_input_changed", "trigger.analog_input_above", "trigger.analog_input_below", "trigger.physical_output_changed", "action.activate_physical_output", "action.activate_physical_relay"].includes(node.type)) {
    document.getElementById("cfg_channel")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }

  if (node.type === "action.record") {
    document.getElementById("cfg_preset_name")?.addEventListener("change", (event) => {
      const selectedName = String(event.target?.value || "").trim();
      const preset = recordingPresetByName(selectedName);
      if (preset) {
        node.config.preset_name = preset.name;
        node.config.name = preset.name;
        node.config.color = preset.color;
        node.config.preset_key = preset.key;
        if (document.getElementById("cfg_color")) {
          document.getElementById("cfg_color").value = preset.color;
        }
      } else {
        delete node.config.preset_name;
        node.config.preset_key = recordingPresetKey(node.config.name || "Recording");
      }
      markDirty();
      renderCanvas();
      renderInspector();
    });
  }
}

function applyNodeInspector(node) {
  const cfg = node.config || {};

  const set = (key, fallback = "") => {
    const input = document.getElementById(`cfg_${key}`);
    if (!input) return;
    cfg[key] = input.value ?? fallback;
  };

  switch (node.type) {
    case "trigger.onvif_event":
      set("name");
      set("device_id");
      set("topic");
      break;
    case "trigger.device_offline":
    case "trigger.device_back_online":
    case "trigger.ptz_manual_control_started":
    case "trigger.ptz_manual_control_stopped":
      set("name");
      set("device_id");
      break;
    case "trigger.incoming_http_request":
      set("name");
      set("method");
      set("path");
      break;
    case "trigger.manual":
      set("name");
      break;
    case "trigger.schedule_active":
    case "trigger.schedule_inactive":
      set("name");
      set("schedule_key");
      break;
    case "trigger.digital_input_changed":
      set("name");
      set("channel");
      break;
    case "trigger.analog_input_above":
    case "trigger.analog_input_below":
      set("name");
      set("channel");
      set("threshold");
      break;
    case "trigger.physical_output_changed":
      set("name");
      set("target_kind");
      set("channel");
      break;
    case "condition.compare":
      set("name");
      set("left_source");
      set("left_value");
      set("left_input_kind");
      set("left_channel");
      set("operator");
      set("cast");
      set("right_source");
      set("right_value");
      set("right_input_kind");
      set("right_channel");
      break;
    case "condition.schedule_active":
      set("name");
      set("schedule_key");
      break;
    case "operator.delay":
      set("name");
      set("seconds");
      break;
    case "operator.set_variable":
      set("name");
      set("variable_key");
      set("value_source");
      set("value");
      set("value_input_kind");
      set("value_channel");
      break;
    case "action.send_http_request":
      set("name");
      set("method");
      set("timeout_seconds");
      set("url");
      set("headers");
      set("body");
      break;
    case "action.activate_physical_output":
    case "action.activate_physical_relay":
      set("name");
      set("target_kind");
      set("channel");
      set("mode");
      set("pulse_seconds");
      break;
    case "action.record":
      set("preset_name");
      set("device_id");
      set("before_seconds");
      {
        const preset = recordingPresetByName(cfg.preset_name);
        if (preset) {
          cfg.preset_name = preset.name;
          cfg.name = preset.name;
          cfg.color = preset.color;
          cfg.preset_key = preset.key;
        } else {
          delete cfg.preset_name;
          cfg.name = normalizeRecordingPresetName(cfg.name || "Recording");
          cfg.color = normalizeRecordingPresetColor(cfg.color);
          cfg.preset_key = recordingPresetKey(cfg.name || "Recording");
        }
      }
      if (document.getElementById("cfg_preset_name")) {
        document.getElementById("cfg_preset_name").value = cfg.preset_name || "";
      }
      break;
    case "action.stop_recording":
      set("device_id");
      break;
    case "action.log_message":
      set("name");
      set("message");
      break;
  }

  if (node.type === "trigger.incoming_http_request") {
    cfg.path = normalizePath(cfg.path || "");
  }

  if (node.type === "condition.compare") {
    if (cfg.left_source === "physical_input") {
      cfg.left_input_kind = String(cfg.left_input_kind || "digital").trim().toLowerCase() || "digital";
      cfg.left_channel = normalizePhysicalChannelSelection(cfg.left_input_kind, cfg.left_channel || "1");
      cfg.left_value = `${cfg.left_input_kind}:${cfg.left_channel}`;
    }

    if (cfg.right_source === "physical_input") {
      cfg.right_input_kind = String(cfg.right_input_kind || "digital").trim().toLowerCase() || "digital";
      cfg.right_channel = normalizePhysicalChannelSelection(cfg.right_input_kind, cfg.right_channel || "1");
      cfg.right_value = `${cfg.right_input_kind}:${cfg.right_channel}`;
    }
  }

  if (node.type === "operator.set_variable" && cfg.value_source === "physical_input") {
    cfg.value_input_kind = cfg.value_input_kind || "digital";
    cfg.value_channel = normalizePhysicalChannelSelection(cfg.value_input_kind, cfg.value_channel || "1");
  }

  if (node.type === "trigger.digital_input_changed") {
    cfg.channel = normalizePhysicalChannelSelection("digital", cfg.channel || "1");
  }

  if (node.type === "trigger.analog_input_above" || node.type === "trigger.analog_input_below") {
    cfg.channel = normalizePhysicalChannelSelection("analog", cfg.channel || "1");
  }

  if (node.type === "trigger.physical_output_changed") {
    cfg.target_kind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
    cfg.channel = normalizePhysicalChannelSelection(cfg.target_kind, cfg.channel || "1");
  }

  if (node.type === "action.activate_physical_output") {
    cfg.target_kind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
    cfg.channel = normalizePhysicalChannelSelection(cfg.target_kind, cfg.channel || "1");
  }

  if (node.type === "action.activate_physical_relay") {
    cfg.target_kind = "relay";
    cfg.channel = normalizePhysicalChannelSelection("relay", cfg.channel || "1");
  }

  if (node.type === "action.record") {
    cfg.before_seconds = Math.max(0, Number(cfg.before_seconds || 0));
    delete cfg.after_seconds;
    const color = String(cfg.color || "#c6a14b").trim().toLowerCase();
    cfg.color = /^#[0-9a-f]{6}$/.test(color) ? color : "#c6a14b";
  }

  markDirty();
  renderCanvas();
  drawEdges();
  refreshPhysicalUi();
}

function normalizePath(value) {
  let raw = (value || "").trim();
  if (!raw) return "";
  raw = raw.split("?", 1)[0].trim();
  if (!raw.startsWith("/")) raw = `/${raw}`;
  const parts = raw.split("/").filter(Boolean);
  return parts.length ? `/${parts.join("/")}` : "/";
}

function buildWebhookUrl(path) {
  const clean = normalizePath(path);
  if (!clean) return "";
  if (clean === "/") return `${window.location.origin}/flow-hook`;
  return `${window.location.origin}/flow-hook${clean}`;
}

function normalizeTopicSearchQuery(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTopicCatalogEntry(raw) {
  const path = String(raw?.path || "").trim();
  if (!path) return null;

  const label = String(raw?.label || raw?.name || path).trim() || path;
  const category = String(raw?.category || "Other").trim() || "Other";
  const aliases = [...new Set(
    (Array.isArray(raw?.aliases) ? raw.aliases : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )];
  const sourcePaths = [...new Set(
    (Array.isArray(raw?.source_paths) ? raw.source_paths : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
  )];
  const searchText = normalizeTopicSearchQuery(
    raw?.search_text || [label, path, category, ...aliases, ...sourcePaths].join(" ")
  );

  return {
    path,
    name: label,
    label,
    category,
    aliases,
    source_paths: sourcePaths,
    recommended: !!raw?.recommended,
    search_text: searchText,
  };
}

function topicCategoryOrder(category) {
  switch (String(category || "Other").trim()) {
    case "Current selection":
      return -1;
    case "Analytics":
      return 0;
    case "Inputs":
      return 1;
    case "Outputs":
      return 2;
    case "Video":
      return 3;
    case "Device":
      return 4;
    default:
      return 5;
  }
}

function topicMatchesQuery(topic, query) {
  if (!query) return true;
  return normalizeTopicSearchQuery(topic?.search_text).includes(query);
}

function topicDisplayLabel(topic) {
  const path = String(topic?.path || "").trim();
  return String(topic?.label || topic?.name || path).trim() || path;
}

function topicDisplayHint(topic) {
  const aliases = Array.isArray(topic?.source_paths) ? topic.source_paths : [];
  if (aliases.length > 1) {
    return `${aliases.length} variants merged`;
  }
  if (topic?.recommended) {
    return "Recommended";
  }
  return "";
}

function topicMetaText(topics, visibleCount, query) {
  if (!topics.length) {
    return "No event topics were returned by this camera.";
  }

  if (query && !visibleCount) {
    return `No topics match "${query}".`;
  }

  const mergedCount = topics.filter((topic) => (topic.source_paths || []).length > 1).length;
  const base = query
    ? `Showing ${visibleCount} of ${topics.length} topics.`
    : `${topics.length} topics available.`;

  return mergedCount
    ? `${base} ${mergedCount} duplicate topic variants were merged automatically.`
    : base;
}

function renderTopicPicker(node) {
  const valueInput = document.getElementById("cfg_topic");
  const list = document.getElementById("cfg_topic_list");
  const meta = document.getElementById("cfg_topic_meta");
  const searchInput = document.getElementById("cfg_topic_search");
  const deviceId = document.getElementById("cfg_device_id")?.value || node.config.device_id || "";

  if (!valueInput || !list) return;

  const topics = state.topicCache.get(deviceId) || [];
  const chosen = String(node.config.topic || "").trim();
  const query = normalizeTopicSearchQuery(searchInput?.value || "");
  const filtered = topics.filter((topic) => topicMatchesQuery(topic, query));
  const selectedTopic = chosen
    ? topics.find((topic) => topic.path === chosen) || normalizeTopicCatalogEntry({
      path: chosen,
      label: chosen,
      category: "Current selection",
      source_paths: [chosen],
    })
    : null;
  const visible = [...filtered];

  if (selectedTopic && !visible.some((topic) => topic.path === selectedTopic.path)) {
    visible.unshift(selectedTopic);
  }

  if (!topics.length) {
    list.innerHTML = `<div class="emptyState">No event topics were returned by this camera.</div>`;
    if (meta) meta.textContent = topicMetaText(topics, 0, query);
    return;
  }

  if (!visible.length) {
    list.innerHTML = `<div class="emptyState">No topics match this search.</div>`;
    if (meta) meta.textContent = topicMetaText(topics, 0, query);
    return;
  }

  const groups = new Map();
  for (const topic of visible) {
    const category = String(topic?.category || "Other").trim() || "Other";
    const list = groups.get(category) || [];
    list.push(topic);
    groups.set(category, list);
  }

  const groupHtml = [...groups.entries()]
    .sort(([left], [right]) => {
      const orderDelta = topicCategoryOrder(left) - topicCategoryOrder(right);
      if (orderDelta !== 0) return orderDelta;
      return left.localeCompare(right);
    })
    .map(([category, items]) => {
      const options = items
        .sort((left, right) => {
          if (!!left?.recommended !== !!right?.recommended) {
            return left?.recommended ? -1 : 1;
          }
          return topicDisplayLabel(left).localeCompare(topicDisplayLabel(right));
        })
        .map((topic) => {
          const hint = topicDisplayHint(topic);
          return `
            <button
              class="topicPickerItem ${topic.path === chosen ? "active" : ""}"
              type="button"
              data-topic-path="${escapeHtml(topic.path)}"
            >
              <span class="topicPickerItemTop">
                <span class="topicPickerItemLabel">${escapeHtml(topicDisplayLabel(topic))}</span>
                ${hint ? `<span class="miniPill">${escapeHtml(hint)}</span>` : ""}
              </span>
              <span class="topicPickerItemPath">${escapeHtml(topic.path)}</span>
            </button>
          `;
        })
        .join("");
      return `
        <section class="topicPickerGroup">
          <div class="topicPickerGroupTitle">${escapeHtml(category)}</div>
          <div class="topicPickerGroupItems">${options}</div>
        </section>
      `;
    })
    .join("");

  list.innerHTML = groupHtml;

  list.querySelectorAll("[data-topic-path]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextTopic = String(button.dataset.topicPath || "").trim();
      valueInput.value = nextTopic;
      node.config.topic = nextTopic;
      applyNodeInspector(node);
      renderTopicPicker(node);
    });
  });

  if (meta) {
    meta.textContent = topicMetaText(topics, filtered.length, query);
  }
}

async function hydrateTopicSelect(node, force = false) {
  const valueInput = document.getElementById("cfg_topic");
  const list = document.getElementById("cfg_topic_list");
  const meta = document.getElementById("cfg_topic_meta");
  const searchInput = document.getElementById("cfg_topic_search");
  const deviceId = document.getElementById("cfg_device_id")?.value || node.config.device_id || "";

  node.config.device_id = deviceId;

  if (!valueInput || !list) return;

  if (!deviceId) {
    valueInput.value = "";
    list.innerHTML = `<div class="emptyState">Select a device to load event topics.</div>`;
    if (searchInput) searchInput.disabled = true;
    if (meta) meta.textContent = "Select a device to load event topics.";
    return;
  }

  try {
    list.innerHTML = `<div class="emptyState">Loading event topics...</div>`;
    if (searchInput) searchInput.disabled = true;
    if (meta) meta.textContent = "Loading event topics from the camera...";
    await loadTopics(deviceId, force);
    if (searchInput) searchInput.disabled = false;
    renderTopicPicker(node);
  } catch (err) {
    list.innerHTML = `<div class="emptyState">Failed to load topics.</div>`;
    if (searchInput) searchInput.disabled = true;
    if (meta) meta.textContent = "Could not load event topics for this device.";
    setStatus(err.message || String(err), true);
  }
}

async function loadTopics(deviceId, force = false) {
  if (!force && state.topicCache.has(deviceId)) {
    return state.topicCache.get(deviceId);
  }

  const data = await api(`/api/events/properties/${encodeURIComponent(deviceId)}`);
  const topics = Array.isArray(data?.topics)
    ? data.topics.map((topic) => normalizeTopicCatalogEntry(topic)).filter(Boolean)
    : [];
  state.topicCache.set(deviceId, topics);
  return topics;
}

function refreshPhysicalNodePreviews() {
  const flow = currentFlow();
  if (!flow) return;

  for (const node of flow.nodes || []) {
    const preview = document.querySelector(`.flowNodePreview[data-node-preview-id="${CSS.escape(node.id)}"]`);
    if (!preview) continue;
    preview.textContent = nodePreview(node);
  }
}

function refreshPhysicalInspectorLiveValues() {
  document.querySelectorAll("#inspectorBody [data-physical-live-kind]").forEach((input) => {
    const kind = String(input.dataset.physicalLiveKind || "digital").trim().toLowerCase() || "digital";
    const channel = normalizePhysicalChannelSelection(kind, input.dataset.physicalLiveChannel || "1");
    input.dataset.physicalLiveChannel = channel;
    input.value = physicalLiveValueText(kind, channel);
  });

  document.querySelectorAll("#inspectorBody [data-physical-live-meta]").forEach((meta) => {
    meta.textContent = physicalMetaText();
  });
}

function refreshPhysicalUi() {
  refreshPhysicalNodePreviews();
  refreshPhysicalInspectorLiveValues();
}

async function refreshPublicVariables(silent = true) {
  try {
    const data = await api("/api/public-variables");
    const incoming = normalizePublicVariableRecords(Array.isArray(data?.items) ? data.items : []);
    const incomingFingerprint = publicVariablesDefinitionFingerprint(incoming);
    const currentFingerprint = publicVariablesDefinitionFingerprint(state.publicVariables);

    state.publicVariablesUpdatedAt = data?.updated_at || null;

    const liveByKey = new Map(
      incoming.map((item) => [item.key, item.current_value])
    );

    if (state.publicVariablesDirty || state.publicVariablesInteracting) {
      refreshPublicVariableRuntimeUi();
      return;
    }

    if (incomingFingerprint !== currentFingerprint) {
      state.publicVariables = incoming;
      renderPublicVariablesSidebar();
      if (!inspectorHasFocus()) {
        renderInspector();
      }
      return;
    }

    // Same definitions, only refresh runtime values in place.
    // Keeping the same objects avoids stale event-handler references.
    for (const item of state.publicVariables) {
      if (liveByKey.has(item.key)) {
        const nextValue = liveByKey.get(item.key);
        item.current_value = nextValue;
        item.value = nextValue;
      }
    }

    refreshPublicVariableRuntimeUi();
  } catch (err) {
    if (!silent) {
      setStatus(err.message || String(err), true);
    }
  }
}

function startPublicVariablesPolling() {
  if (state.publicVariablesTimer) {
    window.clearInterval(state.publicVariablesTimer);
  }

  state.publicVariablesTimer = window.setInterval(() => {
    refreshPublicVariables(true).catch(() => { });
  }, 1000);
}

async function savePublicVariables() {
  validatePublicVariables();

  const out = await api("/api/public-variables", {
    method: "PUT",
    body: JSON.stringify(serializePublicVariables()),
  });

  state.publicVariables = normalizePublicVariableRecords(Array.isArray(out?.items) ? out.items : []);
  state.publicVariablesUpdatedAt = out?.updated_at || null;
  clearPublicVariablesDirty();
  renderPublicVariablesSidebar();
  renderInspector();
  setStatus("Public variables saved.");
}

async function refreshPhysicalState(silent = true) {
  try {
    state.physicalState = await api("/api/physical-io/state");
    refreshPhysicalUi();
  } catch (err) {
    state.physicalState = {
      ...DEFAULT_PHYSICAL_IO,
      available: false,
      error: err.message || String(err),
    };
    refreshPhysicalUi();
    if (!silent) {
      setStatus(err.message || String(err), true);
    }
  }
}

function startPhysicalStatePolling() {
  if (state.physicalStateTimer) {
    window.clearInterval(state.physicalStateTimer);
  }

  state.physicalStateTimer = window.setInterval(() => {
    refreshPhysicalState(true).catch(() => { });
  }, 1000);
}

function renderAll() {
  renderFlowList();
  syncHeader();
  renderRecordingPresetSidebar();
  renderScheduleSidebar();
  renderPublicVariablesSidebar();
  renderCanvas();
  renderInspector();
  refreshPhysicalUi();
  refreshScheduleRuntimeUi();
  refreshPublicVariableRuntimeUi();
}

async function saveFlow() {
  const flow = currentFlow();
  if (!flow) return;

  validateDraft(flow);
  const payload = serializeFlow(flow);

  const out = flow.id
    ? await api(`/api/flows/${encodeURIComponent(flow.id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    })
    : await api(`/api/flows`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

  const saved = out.item;
  state.selectedSavedFlowId = saved.id;
  state.draft = deepClone(saved);

  await refreshFlows();
  await refreshRecordingPresets(true);
  const catalog = await api("/api/flows/catalog");
  state.catalog = catalog;
  state.devices = Array.isArray(catalog?.devices) ? catalog.devices : [];
  clearDirty();
  setStatus("Flow saved.");
  renderAll();
}

function serializeFlow(flow) {
  return {
    name: flow.name,
    enabled: !!flow.enabled,
    nodes: (flow.nodes || []).map((node) => ({
      id: node.id,
      type: node.type,
      category: node.category,
      label: node.label,
      x: Number(node.x) || 0,
      y: Number(node.y) || 0,
      config: node.config || {},
    })),
    edges: deepClone(flow.edges || []),
  };
}

function validateDraft(flow) {
  const name = String(flow.name || "").trim();

  if (!name) {
    throw new Error("Flow name is required.");
  }

  const duplicate = (state.flows || []).some((item) => item.id !== flow.id && normalizedFlowName(item.name) === normalizedFlowName(name));
  if (duplicate) {
    throw new Error("Flow name must be unique.");
  }

  if (!(flow.nodes || []).length) {
    throw new Error("Add at least one node.");
  }

  if (!(flow.nodes || []).some((node) => node.category === "trigger")) {
    throw new Error("Add at least one trigger node.");
  }
}

async function refreshFlows() {
  const data = await api("/api/flows");
  state.flows = Array.isArray(data?.items) ? data.items : [];
}

async function triggerManualNode(nodeId) {
  const flow = currentFlow();
  if (!flow) {
    setTestStatus("No flow loaded.", true);
    setStatus("No flow loaded.", true);
    return;
  }

  const node = flow.nodes.find((item) => item.id === nodeId);
  if (!node) {
    setTestStatus("Manual trigger node not found.", true);
    return;
  }

  if (node.type !== "trigger.manual") {
    setTestStatus("Selected node is not a manual trigger.", true);
    return;
  }

  try {
    validateDraft(flow);

    let out = null;

    if (flow.id) {
      out = await api(`/api/flows/run-manual/${encodeURIComponent(flow.id)}`, {
        method: "POST",
        body: JSON.stringify({
          trigger_node_id: node.id,
          trigger_payload: {},
        }),
      });

      showTestResult(out.result);
      await refreshPublicVariables(true);
      setTestStatus(`Manual trigger "${node.label}" executed with persisted runtime state.`);
      setStatus(`Manual trigger "${node.label}" executed with persisted runtime state.`);
      return;
    }

    out = await api(`/api/flows/test`, {
      method: "POST",
      body: JSON.stringify({
        flow_id: null,
        flow: serializeFlow(flow),
        trigger_node_id: node.id,
        trigger_payload: {},
      }),
    });

    showTestResult(out.result);
    setTestStatus(`Manual trigger "${node.label}" executed against the current draft (stateless test).`);
    setStatus(`Manual trigger "${node.label}" executed against the current draft (stateless test).`);
  } catch (err) {
    setTestStatus(err.message || String(err), true);
    setStatus(err.message || String(err), true);
    throw err;
  }
}

function duplicateDraft() {
  const flow = currentFlow();
  if (!flow) return;

  const copy = deepClone(flow);
  copy.id = null;
  copy.name = makeUniqueFlowName(`${flow.name || "Flow"} copy`);

  state.selectedSavedFlowId = null;
  state.draft = copy;
  clearEditorSelection();
  state.connecting = null;
  state.connectionCursor = null;

  markDirty();
  clearTestResult();
  renderAll();
  setStatus("Flow duplicated into a new draft.");
}

async function deleteDraft() {
  const flow = currentFlow();
  if (!flow?.id) return;

  await api(`/api/flows/${encodeURIComponent(flow.id)}`, { method: "DELETE" });
  await refreshFlows();

  state.selectedSavedFlowId = null;
  state.draft = starterFlow();
  clearEditorSelection();
  state.connecting = null;
  state.connectionCursor = null;

  clearDirty();
  clearTestResult();
  renderAll();
  setStatus("Flow deleted.");
}

function bindGlobalEvents() {
  document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const sectionId = button.dataset.sidebarToggle;
      const block = sectionId ? document.querySelector(`[data-sidebar-section="${sectionId}"]`) : null;
      const hasItems = block?.dataset.hasItems !== "false";
      if (!sectionId || !block) return;
      setSidebarSectionExpanded(sectionId, !sidebarSectionExpanded(sectionId, hasItems));
    });
  });

  el("flowSearch")?.addEventListener("input", renderFlowList);
  el("presetSearch")?.addEventListener("input", renderRecordingPresetSidebar);
  el("scheduleSearch")?.addEventListener("input", renderScheduleSidebar);
  el("variableSearch")?.addEventListener("input", renderPublicVariablesSidebar);
  el("paletteSearch")?.addEventListener("input", renderPalette);

  const boardScroller = el("flowBoardScroller");
  boardScroller?.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (state.connecting) return;

    if (
      ev.target.closest?.(".flowNode") ||
      ev.target.closest?.(".flowPort") ||
      ev.target.closest?.(".flowNodeRunBtn") ||
      ev.target.closest?.(".flowEdgeHitArea")
    ) {
      return;
    }

    state.pan = {
      startX: ev.clientX,
      startY: ev.clientY,
      scrollLeft: boardScroller.scrollLeft,
      scrollTop: boardScroller.scrollTop,
      moved: false,
    };

    boardScroller.classList.add("panning");
    ev.preventDefault();
  });

  const board = el("flowBoard");
  board?.addEventListener("click", () => {
    if (state.justPanned) {
      state.justPanned = false;
      return;
    }

    if (state.connecting) {
      state.connecting = null;
      state.connectionCursor = null;
      renderCanvas();
      setStatus("Connection cancelled.");
      return;
    }

    clearEditorSelection();
    renderPublicVariablesSidebar();
    renderInspector();
    renderCanvas();
    drawEdges();
  });

  window.addEventListener("mouseup", () => {
    const boardScroller = el("flowBoardScroller");

    if (state.scheduleDrag) {
      commitScheduleDrag();
      setSchedulesInteracting(false);
      return;
    }

    if (state.pan) {
      const moved = state.pan.moved;
      state.pan = null;
      boardScroller?.classList.remove("panning");

      if (moved) {
        state.justPanned = true;
        window.setTimeout(() => {
          state.justPanned = false;
        }, 0);
      }

      drawEdges();
      return;
    }

    if (!state.drag) return;
    state.drag = null;
    drawEdges();
  });

  el("flowBoardScroller")?.addEventListener("scroll", drawEdges);
  window.addEventListener("resize", drawEdges);

  window.addEventListener("beforeunload", (ev) => {
    if (!state.dirty && !state.publicVariablesDirty && !state.schedulesDirty) return;
    ev.preventDefault();
    ev.returnValue = "";
  });

  window.addEventListener("mousemove", (ev) => {
    if (state.scheduleDrag) {
      updateScheduleDrag(ev);
      return;
    }

    if (state.pan) {
      const boardScroller = el("flowBoardScroller");
      if (!boardScroller) return;

      const dx = ev.clientX - state.pan.startX;
      const dy = ev.clientY - state.pan.startY;

      boardScroller.scrollLeft = state.pan.scrollLeft - dx;
      boardScroller.scrollTop = state.pan.scrollTop - dy;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        state.pan.moved = true;
      }

      drawEdges();
      return;
    }

    if (state.connecting) {
      const board = el("flowBoard");
      if (board) {
        const rect = board.getBoundingClientRect();
        state.connectionCursor = {
          x: ev.clientX - rect.left,
          y: ev.clientY - rect.top,
        };
        drawEdges();
      }
    }

    if (!state.drag) return;

    const flow = currentFlow();
    const node = flow?.nodes.find((item) => item.id === state.drag.nodeId);
    if (!node) return;

    const dx = ev.clientX - state.drag.startX;
    const dy = ev.clientY - state.drag.startY;
    node.x = Math.max(20, state.drag.originX + dx);
    node.y = Math.max(20, state.drag.originY + dy);

    markDirty();
    renderCanvas();
  });
}

async function init() {
  loadSidebarSectionState();
  bindGlobalEvents();

  try {
    const catalog = await api("/api/flows/catalog");
    state.catalog = catalog;
    state.devices = Array.isArray(catalog?.devices) ? catalog.devices : [];

    await refreshFlows();
    await refreshRecordingPresets(true);
    await refreshSchedules(true);
    await refreshPublicVariables(true);
    await refreshPhysicalState(true);
    startSchedulesPolling();
    startPublicVariablesPolling();
    startPhysicalStatePolling();

    state.draft = state.flows.length ? deepClone(state.flows[0]) : starterFlow();
    state.selectedSavedFlowId = state.draft.id || null;

    clearDirty();
    clearSchedulesDirty();
    clearPublicVariablesDirty();
    clearTestResult();
    renderPalette();
    renderAll();
    window.requestAnimationFrame(centerBoardViewport);
  } catch (err) {
    setStatus(err.message || String(err), true);
    if (el("inspectorBody")) {
      el("inspectorBody").innerHTML = `<div class="emptyState">Failed to load flows UI: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

init();