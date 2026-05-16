const el = (id) => document.getElementById(id);

const state = {
  catalog: null,
  devices: [],
  speakers: [],
  audioClips: [],
  flows: [],
  draft: null,
  sidebarSections: {
    saved: { expanded: true, touched: false },
    presets: { expanded: true, touched: false },
    schedules: { expanded: true, touched: false },
    variables: { expanded: true, touched: false },
    events: { expanded: true, touched: false },
    scenarios: { expanded: true, touched: false },
    palette: { expanded: true, touched: false },
  },
  recordingPresets: [],
  // Engine-wide caps used by Record node inspector. Refreshed by
  // loadRecordingLimits(); falls back to safe defaults until the API responds.
  recordingLimits: {
    trigger_max_duration_seconds: 1800,
    trigger_max_duration_ceiling: 86400,
  },
  schedules: [],
  schedulesDirty: false,
  schedulesInteracting: false,
  schedulesUpdatedAt: null,
  schedulesTimer: null,
  scheduleDrag: null,
  selectedScheduleDay: null,
  selectedSchedulePeriod: null,
  scheduleSpecialDayCalendarMonths: {},
  scheduleSpecialDayCalendarViews: {},
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
  selectedScenarioIndex: null,
  selectedPaletteType: null,
  dirty: false,
  connecting: null,
  connectionCursor: null,
  drag: null,
  paletteDrag: null,
  pan: null,
  panX: 0,
  panY: 0,
  zoom: 1,
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
const SPECIAL_DAY_ROW_PREFIX = "special:";
const SPECIAL_DAY_KEY_PREFIX = "special_day_";
const SCHEDULE_CALENDAR_WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SCHEDULE_CALENDAR_MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
  if (res.status === 401) { window.location.href = "/login"; return; }

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

function nodeEffectivePorts(node, def) {
  const basePorts = def?.ports || { inputs: [], outputs: [] };
  if (node.type !== "action.fire") return basePorts;
  const cfg = node.config || {};
  const scenario = _scenariosCache.find(s => s.id === cfg.target_id);
  if (!scenario) return basePorts;
  const rt = scenario.response_type || "text";
  if (rt === "boolean") {
    return { inputs: ["in"], outputs: ["true", "false"] };
  }
  if (rt === "choice" && Array.isArray(scenario.choices) && scenario.choices.length > 0) {
    return { inputs: ["in"], outputs: scenario.choices.map(c => `choice:${c}`) };
  }
  return basePorts;
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

  const row = scheduleRowEntry(schedule, selection.dayKey);
  if (!row) return null;

  return {
    schedule,
    selection,
    dayKey: row.rowKey,
    dayLabel: row.label,
    periods: row.periods,
    row,
  };
}

function currentSelectedSchedulePeriodEntry(index = state.selectedScheduleIndex) {
  const selection = state.selectedSchedulePeriod;
  if (!selection || selection.scheduleIndex !== index) return null;

  const schedule = currentSchedules()[index];
  if (!schedule) return null;

  const row = scheduleRowEntry(schedule, selection.dayKey);
  if (!row) return null;

  const periods = row.periods;
  const period = periods?.[selection.periodIndex];
  if (!period) return null;

  return { schedule, selection, period, row };
}

function currentSelectedPublicVariable() {
  const idx = state.selectedPublicVariableIndex;
  if (!Number.isInteger(idx) || idx < 0) return null;
  return currentPublicVariables()[idx] || null;
}

function currentSelectedScenario() {
  const idx = state.selectedScenarioIndex;
  if (!Number.isInteger(idx) || idx < 0) return null;
  return _scenariosCache[idx] || null;
}

function clearEditorSelection() {
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
  state.selectedScenarioIndex = null;
  state.selectedPaletteType = null;
  renderRecordingPresetSidebar();
  renderScheduleSidebar();
  renderPublicVariablesSidebar();
  renderScenarioSidebar();
}

function selectNode(nodeId) {
  state.selectedNodeId = nodeId;
  state.selectedEdgeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
  state.selectedScenarioIndex = null;
  state.selectedPaletteType = null;
  renderRecordingPresetSidebar();
  renderScheduleSidebar();
  renderPublicVariablesSidebar();
  renderScenarioSidebar();
}

function selectEdge(edgeId) {
  state.selectedEdgeId = edgeId;
  state.selectedNodeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
  state.selectedScenarioIndex = null;
  state.selectedPaletteType = null;
  renderRecordingPresetSidebar();
  renderScheduleSidebar();
  renderPublicVariablesSidebar();
  renderScenarioSidebar();
}

function selectRecordingPreset(index) {
  state.selectedRecordingPresetIndex = Number.isInteger(index) && index >= 0 ? index : null;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
  state.selectedScenarioIndex = null;
  state.connecting = null;
  state.connectionCursor = null;
}

function selectSchedule(index) {
  state.selectedScheduleIndex = Number.isInteger(index) && index >= 0 ? index : null;
  if (state.selectedScheduleIndex != null) {
    state.selectedSavedFlowId = null;
  }
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedPublicVariableIndex = null;
  state.selectedScenarioIndex = null;
  state.connecting = null;
  state.connectionCursor = null;
}

function selectScheduleDay(scheduleIndex, dayKey) {
  const schedule = currentSchedules()[scheduleIndex];
  if (!Number.isInteger(scheduleIndex) || scheduleIndex < 0 || !schedule || !scheduleRowEntry(schedule, dayKey)) {
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
  state.selectedScenarioIndex = null;
  state.connecting = null;
  state.connectionCursor = null;
}

function selectScenario(index) {
  state.selectedScenarioIndex = Number.isInteger(index) && index >= 0 ? index : null;
  state.selectedNodeId = null;
  state.selectedEdgeId = null;
  state.selectedRecordingPresetIndex = null;
  state.selectedScheduleIndex = null;
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;
  state.selectedPublicVariableIndex = null;
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

function normalizeScheduleDate(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) {
    return "";
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeScheduleSpecialDayKey(value, fallbackIndex = 0) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return slug || `${SPECIAL_DAY_KEY_PREFIX}${fallbackIndex + 1}`;
}

function scheduleSpecialDayDisplayName(item = {}, fallbackIndex = 0) {
  return String(item?.name || "").trim() || `Special day ${fallbackIndex + 1}`;
}

function normalizeScheduleSpecialDayDates(values = []) {
  const seen = new Set();
  const out = [];

  for (const value of values || []) {
    const normalized = normalizeScheduleDate(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out.sort((left, right) => left.localeCompare(right));
}

function normalizeScheduleSpecialDayRecord(item = {}, fallbackIndex = 0) {
  return {
    key: normalizeScheduleSpecialDayKey(item.key, fallbackIndex),
    name: scheduleSpecialDayDisplayName(item, fallbackIndex),
    dates: normalizeScheduleSpecialDayDates(item.dates || []),
    periods: normalizeSchedulePeriods(item.periods || []),
  };
}

function normalizeScheduleSpecialDays(items = []) {
  const out = [];
  const seen = new Set();

  for (const [index, item] of (items || []).entries()) {
    if (!item || typeof item !== "object") continue;
    const normalized = normalizeScheduleSpecialDayRecord(item, index);
    let nextKey = normalized.key;
    let suffix = 2;
    while (seen.has(nextKey)) {
      nextKey = `${normalized.key}_${suffix}`;
      suffix += 1;
    }
    normalized.key = nextKey;
    seen.add(nextKey);
    out.push(normalized);
  }

  return out;
}

function scheduleSpecialDays(schedule) {
  return Array.isArray(schedule?.special_days) ? schedule.special_days : [];
}

function scheduleRowEntry(schedule, rowKey) {
  const builtIn = SCHEDULE_DAY_META.find(([dayKey]) => dayKey === rowKey);
  if (builtIn) {
    return {
      rowKey: builtIn[0],
      sourceKey: builtIn[0],
      label: builtIn[1],
      kind: "built-in",
      periods: schedule?.days?.[builtIn[0]] || [],
      disabled: scheduleDayDisabled(schedule, builtIn[0]),
      specialDay: null,
      specialIndex: -1,
    };
  }

  const normalizedKey = String(rowKey || "");
  if (!normalizedKey.startsWith(SPECIAL_DAY_ROW_PREFIX)) return null;

  const specialKey = normalizedKey.slice(SPECIAL_DAY_ROW_PREFIX.length);
  const specialIndex = scheduleSpecialDays(schedule).findIndex((item) => item.key === specialKey);
  if (specialIndex < 0) return null;

  const specialDay = scheduleSpecialDays(schedule)[specialIndex];
  return {
    rowKey: normalizedKey,
    sourceKey: specialKey,
    label: scheduleSpecialDayDisplayName(specialDay, specialIndex),
    kind: "special",
    periods: specialDay.periods || [],
    disabled: false,
    specialDay,
    specialIndex,
  };
}

function scheduleRowsForSchedule(schedule) {
  return [
    ...SCHEDULE_DAY_META.map(([dayKey]) => scheduleRowEntry(schedule, dayKey)).filter(Boolean),
    ...scheduleSpecialDays(schedule).map((item) => scheduleRowEntry(schedule, `${SPECIAL_DAY_ROW_PREFIX}${item.key}`)).filter(Boolean),
  ];
}

function scheduleRowPeriods(schedule, rowKey) {
  return scheduleRowEntry(schedule, rowKey)?.periods || [];
}

function setScheduleRowPeriods(schedule, rowKey, periods) {
  const row = scheduleRowEntry(schedule, rowKey);
  if (!row) return [];

  const normalized = normalizeScheduleDayPeriods(periods || []);
  if (row.kind === "special") {
    row.specialDay.periods = normalized;
  } else {
    schedule.days[row.rowKey] = normalized;
  }
  return normalized;
}

function nextScheduleSpecialDayKey(schedule) {
  const existing = new Set(scheduleSpecialDays(schedule).map((item) => String(item.key || "").trim()).filter(Boolean));
  let index = scheduleSpecialDays(schedule).length + 1;
  while (existing.has(`${SPECIAL_DAY_KEY_PREFIX}${index}`)) {
    index += 1;
  }
  return `${SPECIAL_DAY_KEY_PREFIX}${index}`;
}

function nextScheduleSpecialDayName(schedule) {
  const existing = new Set(scheduleSpecialDays(schedule).map((item) => scheduleSpecialDayDisplayName(item).toLowerCase()));
  let index = scheduleSpecialDays(schedule).length + 1;
  while (existing.has(`special day ${index}`)) {
    index += 1;
  }
  return `Special day ${index}`;
}

function scheduleDateAssignedElsewhere(schedule, dateValue, specialDayKey) {
  const normalized = normalizeScheduleDate(dateValue);
  if (!normalized) return null;

  return scheduleSpecialDays(schedule).find((item) => item.key !== specialDayKey && (item.dates || []).includes(normalized)) || null;
}

function currentScheduleMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function currentScheduleDateValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function normalizeScheduleMonthKey(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  if (!match) return currentScheduleMonthKey();
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return currentScheduleMonthKey();
  return `${match[1]}-${match[2]}`;
}

function scheduleMonthKeyForDate(value) {
  const normalized = normalizeScheduleDate(value);
  return normalized ? normalized.slice(0, 7) : "";
}

function scheduleMonthDateFromKey(monthKey) {
  const normalized = normalizeScheduleMonthKey(monthKey);
  const [year, month] = normalized.split("-").map((item) => Number(item));
  return new Date(Date.UTC(year, month - 1, 1));
}

function scheduleShiftMonthKey(monthKey, offset) {
  const monthDate = scheduleMonthDateFromKey(monthKey);
  monthDate.setUTCMonth(monthDate.getUTCMonth() + Number(offset || 0));
  return `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, "0")}`;
}

function scheduleMonthLabel(monthKey) {
  return scheduleMonthDateFromKey(monthKey).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function scheduleMonthName(monthKey) {
  return scheduleMonthDateFromKey(monthKey).toLocaleDateString(undefined, {
    month: "long",
    timeZone: "UTC",
  });
}

function scheduleDateShortLabel(dateValue) {
  const normalized = normalizeScheduleDate(dateValue);
  if (!normalized) return "";
  return new Date(`${normalized}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function scheduleSpecialDayCalendarStateKey(scheduleIndex, rowKey) {
  return `${scheduleIndex}:${rowKey}`;
}

function scheduleSpecialDayCalendarView(scheduleIndex, rowKey) {
  return state.scheduleSpecialDayCalendarViews?.[scheduleSpecialDayCalendarStateKey(scheduleIndex, rowKey)] || "days";
}

function setScheduleSpecialDayCalendarView(scheduleIndex, rowKey, view) {
  const nextView = ["days", "months", "years"].includes(view) ? view : "days";
  state.scheduleSpecialDayCalendarViews[scheduleSpecialDayCalendarStateKey(scheduleIndex, rowKey)] = nextView;
}

function scheduleSpecialDayCalendarMonth(scheduleIndex, rowKey, selectedDates = []) {
  const stateKey = scheduleSpecialDayCalendarStateKey(scheduleIndex, rowKey);
  const fromState = normalizeScheduleMonthKey(state.scheduleSpecialDayCalendarMonths?.[stateKey] || "");
  if (state.scheduleSpecialDayCalendarMonths?.[stateKey]) return fromState;

  const latestSelectedDate = [...selectedDates].sort().at(-1);
  return normalizeScheduleMonthKey(scheduleMonthKeyForDate(latestSelectedDate) || currentScheduleMonthKey());
}

function setScheduleSpecialDayCalendarMonth(scheduleIndex, rowKey, monthKey) {
  state.scheduleSpecialDayCalendarMonths[scheduleSpecialDayCalendarStateKey(scheduleIndex, rowKey)] = normalizeScheduleMonthKey(monthKey);
}

function scheduleCalendarYearRange(yearValue) {
  const centerYear = Math.round(Number(yearValue) || new Date().getFullYear());
  const startYear = centerYear - 5;
  return Array.from({ length: 12 }, (_, index) => startYear + index);
}

function renderScheduleSpecialDayCalendarDays(schedule, scheduleIndex, rowKey, specialDay, monthKey, selectedDates) {
  const monthDate = scheduleMonthDateFromKey(monthKey);
  const year = monthDate.getUTCFullYear();
  const monthIndex = monthDate.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const monthStartsAt = (monthDate.getUTCDay() + 6) % 7;
  const totalCells = Math.ceil((monthStartsAt + daysInMonth) / 7) * 7;
  const selectedDateSet = new Set(selectedDates);
  const todayValue = currentScheduleDateValue();

  const cells = Array.from({ length: totalCells }, (_, cellIndex) => {
    const dayNumber = cellIndex - monthStartsAt + 1;
    const cellDate = new Date(Date.UTC(year, monthIndex, dayNumber));
    const cellMonthMatches = cellDate.getUTCMonth() === monthIndex;
    const cellDateValue = `${cellDate.getUTCFullYear()}-${String(cellDate.getUTCMonth() + 1).padStart(2, "0")}-${String(cellDate.getUTCDate()).padStart(2, "0")}`;
    const isWeekend = [0, 6].includes(cellDate.getUTCDay());

    if (!cellMonthMatches) {
      return `
        <div class="scheduleCalendarDay is-outside ${isWeekend ? "is-weekend" : ""}" aria-hidden="true">
          <span class="scheduleCalendarDayNumber">${cellDate.getUTCDate()}</span>
        </div>
      `;
    }

    const dateValue = cellDateValue;
    const isSelected = selectedDateSet.has(dateValue);
    const otherOwner = scheduleDateAssignedElsewhere(schedule, dateValue, specialDay?.key || "");
    const isDisabled = !!otherOwner;
    const isToday = dateValue === todayValue;
    const title = isDisabled
      ? `${dateValue} is already used by ${scheduleSpecialDayDisplayName(otherOwner)}.`
      : (isSelected ? `Remove ${dateValue}` : `Add ${dateValue}`);

    return `
      <button
        class="scheduleCalendarDay ${isSelected ? "is-selected" : ""} ${isDisabled ? "is-disabled" : ""} ${isToday ? "is-today" : ""} ${isWeekend ? "is-weekend" : ""}"
        type="button"
        data-schedule-special-calendar-date="${dateValue}"
        aria-pressed="${isSelected ? "true" : "false"}"
        ${isDisabled ? "disabled" : ""}
        title="${escapeHtml(isToday ? `${title} Today.` : title)}"
      >
        <span class="scheduleCalendarDayNumber">${dayNumber}</span>
        <span class="scheduleCalendarDayDot" aria-hidden="true"></span>
      </button>
    `;
  }).join("");

  return `
    <div class="scheduleCalendarWeekdays">
      ${SCHEDULE_CALENDAR_WEEKDAY_LABELS.map((label) => `<div class="scheduleCalendarWeekday">${label}</div>`).join("")}
    </div>
    <div class="scheduleCalendarGrid">
      ${cells}
    </div>
  `;
}

function renderScheduleSpecialDayCalendarMonths(monthKey) {
  const monthDate = scheduleMonthDateFromKey(monthKey);
  const activeMonthIndex = monthDate.getUTCMonth();

  return `
    <div class="scheduleCalendarPickerGrid scheduleCalendarPickerGrid--months">
      ${SCHEDULE_CALENDAR_MONTH_LABELS.map((label, monthIndex) => `
        <button
          class="scheduleCalendarPickerButton ${monthIndex === activeMonthIndex ? "is-selected" : ""}"
          type="button"
          data-schedule-special-calendar-month="${monthIndex}"
        >
          ${label}
        </button>
      `).join("")}
    </div>
  `;
}

function renderScheduleSpecialDayCalendarYears(monthKey) {
  const monthDate = scheduleMonthDateFromKey(monthKey);
  const activeYear = monthDate.getUTCFullYear();
  const years = scheduleCalendarYearRange(activeYear);

  return `
    <div class="scheduleCalendarPickerGrid scheduleCalendarPickerGrid--years">
      ${years.map((yearValue) => `
        <button
          class="scheduleCalendarPickerButton ${yearValue === activeYear ? "is-selected" : ""}"
          type="button"
          data-schedule-special-calendar-year="${yearValue}"
        >
          ${yearValue}
        </button>
      `).join("")}
    </div>
  `;
}

function renderScheduleSpecialDayCalendar(schedule, scheduleIndex, rowKey, specialDay) {
  const selectedDates = normalizeScheduleSpecialDayDates(specialDay?.dates || []);
  const monthKey = scheduleSpecialDayCalendarMonth(scheduleIndex, rowKey, selectedDates);
  const monthDate = scheduleMonthDateFromKey(monthKey);
  const year = monthDate.getUTCFullYear();
  const monthIndex = monthDate.getUTCMonth();
  const calendarView = scheduleSpecialDayCalendarView(scheduleIndex, rowKey);
  const selectedPreview = selectedDates.slice(0, 6);
  const bodyMarkup = calendarView === "months"
    ? renderScheduleSpecialDayCalendarMonths(monthKey)
    : (calendarView === "years"
      ? renderScheduleSpecialDayCalendarYears(monthKey)
      : renderScheduleSpecialDayCalendarDays(schedule, scheduleIndex, rowKey, specialDay, monthKey, selectedDates));
  const headerMeta = calendarView === "days"
    ? `Click a day to toggle it for this group. ${selectedDates.length ? `${selectedDates.length} selected.` : "No dates selected yet."}`
    : (calendarView === "months" ? "Choose a month to return to the day grid." : "Choose a year, then pick a month.");
  const yearRange = scheduleCalendarYearRange(year);

  return `
    <div class="scheduleCalendar mt-10">
      <div class="rowSplit scheduleCalendarHeader">
        <div>
          <div class="inspectorTitle">Selected dates</div>
          <div class="inlineMeta">${escapeHtml(headerMeta)}</div>
        </div>
        <div class="scheduleCalendarNav">
          <button
            class="btn"
            type="button"
            data-schedule-special-calendar-nav="${calendarView === "years" ? "-12" : "-1"}"
            data-schedule-special-calendar-nav-mode="${calendarView === "years" ? "years" : (calendarView === "months" ? "year" : "month")}"
            aria-label="${calendarView === "years" ? "Previous years" : (calendarView === "months" ? "Previous year" : "Previous month")}"
          >&lsaquo;</button>
          <div class="scheduleCalendarTitleGroup">
            ${calendarView === "years" ? `
              <button class="scheduleCalendarTitleButton is-static" type="button" disabled>${yearRange[0]}-${yearRange[yearRange.length - 1]}</button>
            ` : calendarView === "months" ? `
              <button class="scheduleCalendarTitleButton is-active" type="button" data-schedule-special-calendar-view="years">${year}</button>
            ` : `
              <button class="scheduleCalendarTitleButton" type="button" data-schedule-special-calendar-view="months">${escapeHtml(scheduleMonthName(monthKey))}</button>
            `}
          </div>
          <button class="btn" type="button" data-schedule-special-calendar-today="true">Today</button>
          <button
            class="btn"
            type="button"
            data-schedule-special-calendar-nav="${calendarView === "years" ? "12" : "1"}"
            data-schedule-special-calendar-nav-mode="${calendarView === "years" ? "years" : (calendarView === "months" ? "year" : "month")}"
            aria-label="${calendarView === "years" ? "Next years" : (calendarView === "months" ? "Next year" : "Next month")}"
          >&rsaquo;</button>
        </div>
      </div>
      ${bodyMarkup}
      ${selectedPreview.length ? `
        <div class="scheduleCalendarSelection">
          ${selectedPreview.map((dateValue) => `<span class="miniPill">${escapeHtml(scheduleDateShortLabel(dateValue))}</span>`).join("")}
          ${selectedDates.length > selectedPreview.length ? `<span class="miniPill">+${selectedDates.length - selectedPreview.length} more</span>` : ""}
        </div>
      ` : ""}
    </div>
  `;
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
    special_days: normalizeScheduleSpecialDays(item.special_days || []),
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
  const totalPeriods = scheduleRowsForSchedule(schedule).reduce((count, row) => count + (row.periods || []).length, 0);
  const specialDayCount = scheduleSpecialDays(schedule).length;
  const periodSummary = !totalPeriods ? "No active hours" : (totalPeriods === 1 ? "1 active period" : `${totalPeriods} active periods`);
  if (!specialDayCount) return periodSummary;
  return `${periodSummary} · ${specialDayCount} special day ${specialDayCount === 1 ? "group" : "groups"}`;
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
  const row = scheduleRowEntry(schedule, dayKey);
  if (!row) return segments;

  const currentDayPeriods = row.periods || [];
  const previousDayKey = row.kind === "built-in" ? schedulePreviousDayKey(dayKey) : null;
  const previousDayPeriods = previousDayKey ? scheduleRowPeriods(schedule, previousDayKey) : [];

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
  const row = typeof dayKey === "object" ? dayKey : scheduleRowEntry(schedule, dayKey);
  if (!row) return "";

  const rowKey = row.rowKey;
  const selectedDay = currentSelectedScheduleDayEntry(scheduleIndex)?.selection || null;
  const segments = buildScheduleSegments(schedule, scheduleIndex, rowKey);
  const selectedPeriod = currentSelectedSchedulePeriodEntry(scheduleIndex)?.selection || null;
  const disabled = row.disabled;
  return `
    <div class="scheduleDayRow ${disabled ? "is-disabled" : ""} ${selectedDay?.dayKey === rowKey ? "is-selected" : ""}" data-schedule-day-row="${rowKey}">
      <div class="scheduleDayLabelCell">
        <button class="scheduleDayLabelButton" type="button" data-schedule-day-select="${rowKey}" aria-pressed="${selectedDay?.dayKey === rowKey ? "true" : "false"}">
          <span class="scheduleDayLabel">${escapeHtml(row.label)}</span>
        </button>
      </div>
      <div class="scheduleDayTrackWrap">
        <div class="scheduleDayTrack ${disabled ? "is-disabled" : ""}" data-schedule-track="${rowKey}" data-schedule-disabled="${disabled ? "true" : "false"}">
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
                data-schedule-day="${rowKey}"
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
    const sourcePeriods = [...scheduleRowPeriods(schedule, sourceDay)];
    sourcePeriods.splice(drag.sourcePeriodIndex, 1);
    setScheduleRowPeriods(schedule, sourceDay, sourcePeriods);
  }

  const targetPeriods = [...scheduleRowPeriods(schedule, targetDay), { start, end }];
  const normalizedTargetPeriods = setScheduleRowPeriods(schedule, targetDay, targetPeriods);

  const nextPeriodIndex = normalizedTargetPeriods.findIndex((period) => period.start === start && period.end === end);
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

let _scenariosCache = [];
let _scenariosCacheTs = 0;

async function loadScenarios(force = false) {
  if (!force && Date.now() - _scenariosCacheTs < 5000 && _scenariosCache.length) return _scenariosCache;
  try {
    const resp = await fetch("/api/scenarios");
    if (!resp.ok) return _scenariosCache;
    const data = await resp.json();
    _scenariosCache = data.items || [];
    _scenariosCacheTs = Date.now();
  } catch {}
  return _scenariosCache;
}

function scenarioOptionsHtml(selected = "") {
  const options = [`<option value="">No scenario (basic event)</option>`];
  for (const s of _scenariosCache) {
    options.push(
      `<option value="${escapeHtml(s.id)}" ${s.id === selected ? "selected" : ""}>${escapeHtml(s.name)}</option>`
    );
  }
  return options.join("");
}

function addScenario() {
  const newScenario = { id: "", name: "New scenario", prompt: "", _isNew: true };
  _scenariosCache.push(newScenario);
  if (el("scenarioSearch")) {
    el("scenarioSearch").value = "";
  }
  selectScenario(_scenariosCache.length - 1);
  setSidebarSectionExpanded("scenarios", true);
  renderScenarioSidebar();
  renderInspector();
}

async function saveScenario() {
  const scenario = currentSelectedScenario();
  if (!scenario) return;

  const name = (scenario.name || "").trim();
  const prompt = (scenario.prompt || "").trim();
  if (!name) throw new Error("Scenario name is required.");
  if (!prompt) throw new Error("Scenario prompt is required.");

  const payload = {
    name,
    prompt,
    response_type: scenario.response_type || "text",
    choices: scenario.choices || [],
    result_variable: scenario.result_variable || "",
    max_contributions: parseInt(scenario.max_contributions) || 0,
    max_seconds: parseFloat(scenario.max_seconds) || 0,
    auto_event_enabled: !!scenario.auto_event_enabled,
    auto_event_priority: scenario.auto_event_priority || "medium",
    auto_event_on_result: scenario.auto_event_on_result || "true",
  };

  if (scenario._isNew || !scenario.id) {
    const out = await api("/api/scenarios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadScenarios(true);
    const saved = _scenariosCache.find(s => s.name === name);
    state.selectedScenarioIndex = saved ? _scenariosCache.indexOf(saved) : null;
  } else {
    await api(`/api/scenarios/${encodeURIComponent(scenario.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadScenarios(true);
    const saved = _scenariosCache.find(s => s.id === scenario.id);
    state.selectedScenarioIndex = saved ? _scenariosCache.indexOf(saved) : null;
  }

  renderScenarioSidebar();
  renderInspector();
  setStatus(`Scenario saved: ${name}.`);
}

async function deleteScenario() {
  const scenario = currentSelectedScenario();
  if (!scenario) return;

  if (scenario._isNew || !scenario.id) {
    _scenariosCache.splice(state.selectedScenarioIndex, 1);
  } else {
    await api(`/api/scenarios/${encodeURIComponent(scenario.id)}`, { method: "DELETE" });
    await loadScenarios(true);
  }

  if (!_scenariosCache.length) {
    state.selectedScenarioIndex = null;
  } else {
    state.selectedScenarioIndex = Math.min(state.selectedScenarioIndex ?? 0, _scenariosCache.length - 1);
  }

  renderScenarioSidebar();
  renderInspector();
  setStatus(`Scenario deleted: ${scenario.name}.`);
}

function bindScenarioActionButtons() {
  el("btnAddScenario")?.addEventListener("click", (event) => {
    event.stopPropagation();
    addScenario();
  });

  el("btnSaveScenario")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await saveScenario();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  el("btnDeleteScenario")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    try {
      await deleteScenario();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });
}

function renderScenarioSidebar() {
  const box = el("scenarioList");
  if (!box) return;

  const q = (el("scenarioSearch")?.value || "").trim().toLowerCase();
  const selectedScenario = currentSelectedScenario();
  const items = _scenariosCache
    .map((scenario, idx) => ({ scenario, idx }))
    .filter(({ scenario }) => {
      if (!q) return true;
      return [scenario.name, scenario.prompt].join(" ").toLowerCase().includes(q);
    });

  syncSidebarSection("scenarios", _scenariosCache.length > 0);

  const currentCard = !selectedScenario ? `
    <div class="varCard varCardActionsOnly">
      <div class="sidebarCardActions is-standalone">
        <button class="btn btn-primary btn-compact" id="btnAddScenario" type="button">New</button>
        <button class="btn btn-compact" id="btnSaveScenario" type="button">Save</button>
        <button class="btn btn-danger btn-compact" id="btnDeleteScenario" type="button">Delete</button>
      </div>
    </div>` : "";

  box.innerHTML = `
    ${currentCard}
    ${_scenariosCache.length ? "" : `<div class="emptyState">No scenarios yet.</div>`}
    ${items.length ? items.map(({ scenario, idx }) => {
      const isActive = idx === state.selectedScenarioIndex;
      return `
        <${isActive ? "div" : "button"} class="varCard is-preview ${isActive ? "active varCardCurrent" : ""}" ${isActive ? "" : 'type="button"'} data-scenario-index="${idx}" aria-pressed="${isActive ? "true" : "false"}">
          <div class="varCardTop">
            <div class="varCardName">${escapeHtml(scenario.name)}</div>
          </div>
          <div class="scenarioSidebarPrompt">${escapeHtml((scenario.prompt || "").substring(0, 80))}${(scenario.prompt || "").length > 80 ? "\u2026" : ""}</div>
          ${isActive ? `
          <div class="sidebarCardActions">
            <button class="btn btn-primary btn-compact" id="btnAddScenario" type="button">New</button>
            <button class="btn btn-compact" id="btnSaveScenario" type="button">Save</button>
            <button class="btn btn-danger btn-compact" id="btnDeleteScenario" type="button">Delete</button>
          </div>` : ""}
        </${isActive ? "div" : "button"}>
      `;
    }).join("") : ""}
  `;

  bindScenarioActionButtons();

  box.querySelectorAll("[data-scenario-index]").forEach((card) => {
    if (card.classList.contains("varCardCurrent")) return;
    card.addEventListener("click", () => {
      const index = Number(card.dataset.scenarioIndex || -1);
      if (!_scenariosCache[index]) return;
      selectScenario(index);
      renderScenarioSidebar();
      renderInspector();
      renderCanvas();
      drawEdges();
    });
  });
}

function renderScenarioInspector(scenario, index) {
  const responseType = scenario.response_type || "text";
  const choices = (scenario.choices || []).join(", ");
  const choicesVisible = responseType === "choice" ? "" : " hidden";
  return `
    <div class="inspectorCard">
      <div class="rowSplit">
        <div>
          <div class="inspectorTitle scenarioInspectorName" style="margin-bottom:4px;">${escapeHtml(scenario.name || `scenario_${index + 1}`)}</div>
          <div class="inspectorHint">AI analysis scenario</div>
        </div>
      </div>
      <div id="scenarioInspectorBody" class="fieldGrid mt-10" data-scenario-index="${index}">
        <div class="full">
          <label>Name</label>
          <input id="scenarioNameInput" value="${escapeHtml(scenario.name || "")}" placeholder="e.g. Perimeter Security" />
        </div>
        <div class="full">
          <label>Prompt</label>
          <textarea id="scenarioPromptInput" rows="6" placeholder="Describe the rules for the AI to evaluate.">${escapeHtml(scenario.prompt || "")}</textarea>
        </div>
        <div class="full">
          <label>Response type</label>
          <select id="scenarioResponseType">
            <option value="boolean" ${responseType === "boolean" ? "selected" : ""}>Boolean (true / false)</option>
            <option value="number" ${responseType === "number" ? "selected" : ""}>Number</option>
            <option value="text" ${responseType === "text" ? "selected" : ""}>Text</option>
            <option value="choice" ${responseType === "choice" ? "selected" : ""}>Choice (pick one)</option>
          </select>
        </div>
        <div class="full${choicesVisible}" id="scenarioChoicesRow">
          <label>Choices (comma-separated)</label>
          <input id="scenarioChoicesInput" value="${escapeHtml(choices)}" placeholder="e.g. yes, no, maybe" />
        </div>
        <div class="full">
          <label>Result variable</label>
          <select id="scenarioResultVariable">
            ${variableKeyOptionsHtml(scenario.result_variable || "", { includePhysical: false })}
          </select>
        </div>
        <div class="half">
          <label>Max contributions</label>
          <input id="scenarioMaxContributions" type="number" min="0" value="${scenario.max_contributions || 0}" placeholder="0 = unlimited" />
        </div>
        <div class="half">
          <label>Max seconds</label>
          <input id="scenarioMaxSeconds" type="number" min="0" step="0.1" value="${scenario.max_seconds || 0}" placeholder="0 = no timer" />
        </div>

        <div class="full" style="margin-top:12px; border-top:1px solid var(--stroke, #333); padding-top:12px;">
          <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:4px;">
            <input id="scenarioAutoEventEnabled" type="checkbox" style="width:18px; height:18px; flex-shrink:0;" ${scenario.auto_event_enabled ? "checked" : ""} />
            <span style="font-weight:600;">Auto-submit as event</span>
          </label>
          <div class="inspectorHint">When enabled, the AI result is automatically submitted as an event with the reasoning text and snapshots.</div>
        </div>
        <div class="full${scenario.auto_event_enabled ? "" : " hidden"}" id="scenarioAutoEventFields">
          <label>Event priority</label>
          <select id="scenarioAutoEventPriority">
            ${EVENT_PRIORITIES.map(p => `<option value="${p}" ${(scenario.auto_event_priority || "medium") === p ? "selected" : ""}>${p}</option>`).join("")}
          </select>
          <label class="mt-10">Submit when result is</label>
          <select id="scenarioAutoEventOnResult">
            <option value="true" ${(scenario.auto_event_on_result || "true") === "true" ? "selected" : ""}>True</option>
            <option value="false" ${scenario.auto_event_on_result === "false" ? "selected" : ""}>False</option>
            <option value="any" ${scenario.auto_event_on_result === "any" ? "selected" : ""}>Any result</option>
          </select>
        </div>

        <div class="full inlineMeta">The prompt is sent to GPT-4o along with camera snapshots. You can reference flow templates like {{trigger.path}}, {{variables.key}}.</div>
      </div>
    </div>
    <div class="inspectorCard inspectorActionsCard">
      <div class="inspectorActionHeader">
        <div class="inspectorTitle">Scenario actions</div>
        <div class="inspectorHint">Create, save, or remove the selected scenario.</div>
      </div>
      <div class="inspectorActionGrid">
        <button class="btn btn-primary" id="btnInspectorAddScenario" type="button">New</button>
        <button class="btn" id="btnInspectorSaveScenario" type="button">Save</button>
        <button class="btn btn-danger" id="btnInspectorDeleteScenario" type="button">Delete</button>
      </div>
    </div>
  `;
}

function bindScenarioInspector(index) {
  const getScenario = () => _scenariosCache[index];

  document.getElementById("btnInspectorAddScenario")?.addEventListener("click", () => {
    addScenario();
  });

  document.getElementById("btnInspectorSaveScenario")?.addEventListener("click", async () => {
    try {
      await saveScenario();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  document.getElementById("btnInspectorDeleteScenario")?.addEventListener("click", async () => {
    try {
      await deleteScenario();
    } catch (err) {
      setStatus(err.message || String(err), true);
    }
  });

  document.getElementById("scenarioNameInput")?.addEventListener("input", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.name = ev.target.value.trim();
    renderScenarioSidebar();

    const title = document.querySelector(".scenarioInspectorName");
    if (title) title.textContent = scenario.name || `scenario_${index + 1}`;
    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${scenario.name || "scenario"} settings`;
    }
  });

  document.getElementById("scenarioPromptInput")?.addEventListener("input", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.prompt = ev.target.value;
    renderScenarioSidebar();
  });

  document.getElementById("scenarioResponseType")?.addEventListener("change", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.response_type = ev.target.value;
    const choicesRow = document.getElementById("scenarioChoicesRow");
    if (choicesRow) choicesRow.classList.toggle("hidden", ev.target.value !== "choice");
  });

  document.getElementById("scenarioChoicesInput")?.addEventListener("input", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.choices = ev.target.value.split(",").map(s => s.trim()).filter(Boolean);
  });

  document.getElementById("scenarioResultVariable")?.addEventListener("change", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.result_variable = ev.target.value;
  });

  document.getElementById("scenarioMaxContributions")?.addEventListener("input", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.max_contributions = parseInt(ev.target.value) || 0;
  });

  document.getElementById("scenarioMaxSeconds")?.addEventListener("input", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.max_seconds = parseFloat(ev.target.value) || 0;
  });

  document.getElementById("scenarioAutoEventEnabled")?.addEventListener("change", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.auto_event_enabled = ev.target.checked;
    const fields = document.getElementById("scenarioAutoEventFields");
    if (fields) fields.classList.toggle("hidden", !ev.target.checked);
  });

  document.getElementById("scenarioAutoEventPriority")?.addEventListener("change", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.auto_event_priority = ev.target.value;
  });

  document.getElementById("scenarioAutoEventOnResult")?.addEventListener("change", (ev) => {
    const scenario = getScenario();
    if (!scenario) return;
    scenario.auto_event_on_result = ev.target.value;
  });
}

const EVENT_PRIORITIES = ["critical", "high", "medium", "low", "info"];

function deviceOptionsHtml(selected = "") {
  const options = [`<option value="">Select device</option>`];
  for (const device of state.devices) {
    options.push(
      `<option value="${escapeHtml(device.id)}" ${device.id === selected ? "selected" : ""}>${escapeHtml(device.name)}</option>`
    );
  }
  return options.join("");
}

function speakerOptionsHtml(selected = "") {
  const options = [`<option value="">Select speaker</option>`];
  for (const speaker of state.speakers) {
    options.push(
      `<option value="${escapeHtml(speaker.id)}" ${speaker.id === selected ? "selected" : ""}>${escapeHtml(speaker.name)}</option>`
    );
  }
  return options.join("");
}

function audioClipOptionsHtml(selected = "") {
  const options = [`<option value="">Select audio clip</option>`];
  for (const clip of state.audioClips) {
    options.push(
      `<option value="${escapeHtml(clip.filename)}" ${clip.filename === selected ? "selected" : ""}>${escapeHtml(clip.filename)}</option>`
    );
  }
  return options.join("");
}

function renderSnapshotDeviceList(entries = []) {
  if (!entries.length) return `<div class="inlineMeta">No cameras selected. Snapshots are optional.</div>`;
  return entries.map((entry, i) => {
    const did = typeof entry === "string" ? entry : (entry.device_id || "");
    return `
      <div class="snapshotDeviceRow" data-index="${i}">
        <select class="snapshotDeviceSelect" data-index="${i}">${deviceOptionsHtml(did)}</select>
        <button class="snapshotDeviceRemove" data-index="${i}" type="button" title="Remove camera">&times;</button>
      </div>
    `;
  }).join("");
}

function recordDeviceEntries(cfg) {
  if (Array.isArray(cfg?.device_ids)) {
    return cfg.device_ids.map((entry) => String(entry || "").trim());
  }
  const legacy = String(cfg?.device_id || "").trim();
  return legacy ? [legacy] : [];
}

function recordDeviceIds(cfg) {
  const out = [];
  const seen = new Set();
  for (const did of recordDeviceEntries(cfg)) {
    if (did && !seen.has(did)) {
      seen.add(did);
      out.push(did);
    }
  }
  return out;
}

function renderRecordDeviceList(entries = []) {
  if (!entries.length) {
    return `<div class="inlineMeta">No cameras selected. Add at least one.</div>`;
  }
  return entries.map((did, i) => `
    <div class="snapshotDeviceRow" data-index="${i}">
      <select class="recordDeviceSelect" data-index="${i}">${deviceOptionsHtml(did)}</select>
      <button class="snapshotDeviceRemove recordDeviceRemove" data-index="${i}" type="button" title="Remove camera">&times;</button>
    </div>
  `).join("");
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

function noxInputs() {
  return (state.catalog?.nox?.inputs) || [];
}

function noxAreas() {
  return (state.catalog?.nox?.areas) || [];
}

function noxTioInputs() {
  return (state.catalog?.nox?.tio_inputs) || [];
}

function noxTioAreas() {
  return (state.catalog?.nox?.tio_areas) || [];
}

function noxTioInputOptionsHtml(selectedId = "") {
  const value = selectedId == null ? "" : String(selectedId);
  const blank = `<option value="" ${value === "" ? "selected" : ""}>— Any TIO input —</option>`;
  const items = noxTioInputs().map(i => {
    const v = String(i.id);
    const label = `${i.label || `Input #${i.id}`}${i.state ? ` · ${i.state}` : ""}`;
    return `<option value="${v}"${v === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  return blank + items;
}

function noxTioAreaOptionsHtml(selectedId = "") {
  const value = selectedId == null ? "" : String(selectedId);
  const blank = `<option value="" ${value === "" ? "selected" : ""}>— Any TIO area —</option>`;
  const items = noxTioAreas().map(a => {
    const v = String(a.id);
    const label = `${a.label || `Area #${a.id}`}${a.state ? ` · ${a.state}` : ""}`;
    return `<option value="${v}"${v === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  return blank + items;
}

function noxAnyAreaOptionsHtml(selectedId = "") {
  // Combined dropdown for triggers: Modbus-configured areas + TIO-discovered
  // ones (deduped by id). Used where the source can be either Modbus or TIO.
  const value = selectedId == null ? "" : String(selectedId);
  const blank = `<option value="" ${value === "" ? "selected" : ""}>— Any area —</option>`;

  const seen = new Set();
  const modbusEntries = [];
  for (const a of noxAreas()) {
    seen.add(String(a.area_id));
    modbusEntries.push({
      id: String(a.area_id),
      label: `${a.label || `Area ${a.area_id}`} (#${a.area_id})${a.live?.state ? ` · ${a.live.state}` : ""}`,
    });
  }
  const tioOnly = [];
  for (const a of noxTioAreas()) {
    if (seen.has(String(a.id))) continue;
    tioOnly.push({
      id: String(a.id),
      label: `${a.label || `TIO Area #${a.id}`} (#${a.id})${a.state ? ` · ${a.state}` : ""}`,
    });
  }

  const html = (entries) => entries.map(e =>
    `<option value="${e.id}"${e.id === value ? " selected" : ""}>${escapeHtml(e.label)}</option>`
  ).join("");

  let groups = "";
  if (modbusEntries.length) groups += `<optgroup label="Configured (Modbus)">${html(modbusEntries)}</optgroup>`;
  if (tioOnly.length)       groups += `<optgroup label="TIO-discovered">${html(tioOnly)}</optgroup>`;
  return blank + groups;
}

function noxInputOptionsHtml(selectedModule = "", selectedInput = "") {
  const value = (selectedModule !== "" && selectedInput !== "" && selectedModule != null && selectedInput != null)
    ? `${selectedModule}-${selectedInput}` : "";
  const blank = `<option value="" ${value === "" ? "selected" : ""}>— Any input —</option>`;

  // Group by module for readability when there are many inputs.
  const groups = new Map();
  for (const i of noxInputs()) {
    const key = `Module ${i.module}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const groupHtml = Array.from(groups.entries()).map(([groupLabel, items]) => {
    const opts = items.map(i => {
      const v = `${i.module}-${i.input}`;
      const labelText = i.label
        ? `${i.label} — input ${i.input}`
        : `Input ${i.input} (addr ${i.address})`;
      return `<option value="${v}"${v === value ? " selected" : ""}>${escapeHtml(labelText)}</option>`;
    }).join("");
    return `<optgroup label="${escapeHtml(groupLabel)}">${opts}</optgroup>`;
  }).join("");

  return blank + groupHtml;
}

function noxAreaKindLabel(kind) {
  switch (kind) {
    case "intrusion": return "Intrusion areas (writable)";
    case "virtual":   return "Virtual indicators (read-only)";
    case "adk":       return "ADK / door areas (read-only)";
    default:          return "Unknown / not yet polled";
  }
}

function noxAreaOptionsHtml(selectedAreaId = "", { allowAny = true, writableOnly = false } = {}) {
  const value = selectedAreaId === "" || selectedAreaId == null ? "" : String(selectedAreaId);
  const blank = allowAny
    ? `<option value="" ${value === "" ? "selected" : ""}>— Any area —</option>`
    : `<option value="" ${value === "" ? "selected" : ""}>— Select area —</option>`;

  // Group by kind so users immediately see which areas can actually be controlled.
  const order = ["intrusion", "unknown", "virtual", "adk"];
  const buckets = { intrusion: [], virtual: [], adk: [], unknown: [] };
  for (const a of noxAreas()) {
    buckets[a.kind || "unknown"].push(a);
  }
  const groupHtml = order
    .filter(kind => buckets[kind].length)
    .map(kind => {
      const opts = buckets[kind].map(a => {
        const v = String(a.area_id);
        const stateBit = a.live && a.live.state ? ` · ${a.live.state}` : "";
        const labelText = `${a.label || `Area ${a.area_id}`} (#${a.area_id}${stateBit})`;
        const disabled = writableOnly && !a.writable ? " disabled" : "";
        return `<option value="${v}"${v === value ? " selected" : ""}${disabled}>${escapeHtml(labelText)}</option>`;
      }).join("");
      return `<optgroup label="${escapeHtml(noxAreaKindLabel(kind))}">${opts}</optgroup>`;
    }).join("");

  return blank + groupHtml;
}

function noxSplitInputValue(value) {
  if (!value || typeof value !== "string") return { module: "", input: "" };
  const [m, i] = value.split("-");
  return { module: m || "", input: i || "" };
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

function normalizeOnvifTransition(value) {
  const raw = String(value || "any").trim().toLowerCase();
  if (["became_active", "started", "entered", "active", "true"].includes(raw)) return "became_active";
  if (["became_inactive", "stopped", "left", "inactive", "false"].includes(raw)) return "became_inactive";
  return "any";
}

function onvifTransitionOptionsHtml(value) {
  const current = normalizeOnvifTransition(value);
  const options = [
    ["any", "Any event"],
    ["became_active", "Became active / true"],
    ["became_inactive", "Became inactive / false"],
  ];
  return options.map(([optionValue, label]) => `<option value="${escapeHtml(optionValue)}" ${optionValue === current ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function onvifTransitionSummary(value) {
  const current = normalizeOnvifTransition(value);
  if (current === "became_active") return "when state becomes active";
  if (current === "became_inactive") return "when state becomes inactive";
  return "for any matching event";
}

function compareTriggerPathGroups() {
  const flow = currentFlow();
  const nodes = Array.isArray(flow?.nodes) ? flow.nodes : [];
  const triggerTypes = Array.from(new Set(
    nodes
      .filter((node) => node?.category === "trigger" || String(node?.type || "").startsWith("trigger."))
      .map((node) => String(node?.type || "").trim())
      .filter(Boolean),
  ));

  const commonPaths = [
    "kind",
    "ts",
    "message",
    "device_id",
    "path",
    "method",
    "topic",
    "channel",
    "value",
    "previous_value",
    "extra.some_key",
  ];

  const triggerTypePaths = {
    "trigger.manual": ["manual_kind", "trigger_node_id", "flow_id", "device_id", "method", "path", "topic", "extra.some_key"],
    "trigger.onvif_event": ["device_id", "topic", "state_key", "state_value", "state_transition", "state_changes.0.key", "state_changes.0.state_value", "state_changes.0.transition", "extra.matched_allow_topic", "extra.matched_by", "extra.topic_path", "extra.guessed_topic", "extra.changed.IsMotion", "extra.changed.IsInside"],
    "trigger.device_offline": ["device_id", "status", "message"],
    "trigger.device_back_online": ["device_id", "status", "message"],
    "trigger.ptz_manual_control_started": ["device_id", "pan", "tilt", "zoom", "extra.reason"],
    "trigger.ptz_manual_control_stopped": ["device_id", "pan", "tilt", "zoom", "extra.reason"],
    "trigger.incoming_http_request": ["path", "method", "device_id", "topic", "extra.some_key"],
    "trigger.schedule_active": ["schedule_key", "schedule_name", "active", "previous_active", "weekday", "local_time"],
    "trigger.schedule_inactive": ["schedule_key", "schedule_name", "active", "previous_active", "weekday", "local_time"],
    "trigger.digital_input_changed": ["input_kind", "channel", "value", "previous_value", "label", "extra.channel", "extra.value", "extra.previous_value"],
    "trigger.analog_input_above": ["input_kind", "channel", "value", "previous_value", "delta", "label", "extra.channel", "extra.value", "extra.previous_value"],
    "trigger.analog_input_below": ["input_kind", "channel", "value", "previous_value", "delta", "label", "extra.channel", "extra.value", "extra.previous_value"],
    "trigger.physical_output_changed": ["target_kind", "channel", "value", "previous_value", "label", "extra.target_kind", "extra.channel", "extra.value", "extra.previous_value"],
    "trigger.speaker_audio_played": ["speaker_id", "speaker_name", "audio_type", "clip_filename", "message"],
  };

  const dedupePaths = (values) => Array.from(new Set(values.filter(Boolean)));
  const groups = [
    {
      key: "common",
      title: triggerTypes.length ? "Useful paths" : "Common examples",
      paths: dedupePaths(commonPaths),
    },
  ];

  triggerTypes.forEach((type) => {
    const paths = dedupePaths(triggerTypePaths[type] || []);
    if (!paths.length) return;
    groups.push({
      key: type,
      title: nodeDef(type)?.label || type.replace(/^trigger\./, "").replaceAll("_", " "),
      paths,
    });
  });

  return groups;
}

function renderCompareTriggerPathHelp(prefix, value) {
  const groups = compareTriggerPathGroups();
  const currentValue = String(value || "").trim();

  return `
    <div class="compareTriggerPathHelp setVariableTemplateHelp mt-8">
      <div class="setVariableTemplateHelpTitle">Available trigger paths</div>
      <div class="setVariableTemplateHelpText">Paths are relative to the trigger object. Click to insert. Use <strong>extra.changed.IsMotion</strong>, not <strong>trigger.extra.changed.IsMotion</strong>.</div>
      <div class="compareTriggerPathGroups">
        ${groups.map((group) => `
          <div class="compareTriggerPathGroup">
            <div class="compareTriggerPathGroupTitle">${escapeHtml(group.title)}</div>
            <div class="setVariableTemplateHelpChips">
              ${group.paths.map((path) => `
                <button
                  class="setVariableTemplateChip compareTriggerPathChip ${path === currentValue ? "is-active" : ""}"
                  type="button"
                  data-trigger-path-insert="${escapeHtml(prefix)}"
                  data-trigger-path-value="${escapeHtml(path)}"
                >${escapeHtml(path)}</button>
              `).join("")}
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
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

  const input = `<input id="cfg_${prefix}_value" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder)}" list="variableKeysList" />`;
  if (sourceType !== "trigger") return input;
  return `${input}${renderCompareTriggerPathHelp(prefix, value)}`;
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

  if (node?.type === "action.fire" && kind === "output") {
    if (port === "true") return "TRUE";
    if (port === "false") return "FALSE";
    if (port.startsWith("choice:")) return port.slice(7).toUpperCase();
  }

  return "";
}

function portUiLabel(nodeId, kind, handle) {
  const node = currentFlow()?.nodes.find((item) => item.id === nodeId);
  return displayPortLabel(node, kind, handle) || handle;
}

function isNodeInvalid(node) {
  const cfg = node.config || {};
  const deviceIds = new Set(state.devices.map((d) => d.id));
  const variableKeys = new Set(currentPublicVariables().map((v) => v.key));
  const scheduleKeys = new Set(currentSchedules().map((s) => s.key));

  switch (node.type) {
    case "trigger.onvif_event":
    case "trigger.device_offline":
    case "trigger.device_back_online":
    case "trigger.ptz_manual_control_started":
    case "trigger.ptz_manual_control_stopped":
    case "action.record":
    case "action.stop_recording": {
      const ids = recordDeviceIds(cfg);
      for (const did of ids) {
        if (did && !deviceIds.has(did)) return "Unknown device";
      }
      break;
    }
    case "trigger.schedule_active":
    case "trigger.schedule_inactive":
    case "condition.schedule_active":
      if (cfg.schedule_key && !scheduleKeys.has(cfg.schedule_key)) return "Unknown schedule";
      break;
    case "condition.compare":
      if (cfg.left_source === "variable" && cfg.left_value && !variableKeys.has(cfg.left_value)) return "Unknown variable";
      if (cfg.right_source === "variable" && cfg.right_value && !variableKeys.has(cfg.right_value)) return "Unknown variable";
      break;
    case "operator.set_variable":
      if (cfg.variable_key && !variableKeys.has(cfg.variable_key)) return "Unknown variable";
      if (cfg.value_source === "variable" && cfg.value && !variableKeys.has(cfg.value)) return "Unknown variable";
      break;
    case "operator.template":
      if (cfg.variable_key && !variableKeys.has(cfg.variable_key)) return "Unknown variable";
      break;
    case "trigger.speaker_audio_played": {
      const speakerIds = new Set(state.speakers.map((s) => s.id));
      if (cfg.speaker_id && !speakerIds.has(cfg.speaker_id)) return "Unknown speaker";
      break;
    }
  }
  return null;
}

function nodePreview(node) {
  const cfg = node.config || {};

  switch (node.type) {
    case "trigger.onvif_event": {
      const device = state.devices.find((item) => item.id === cfg.device_id);
      return `${device?.name || cfg.device_id || "device"} → ${cfg.topic || "topic"} · ${onvifTransitionSummary(cfg.transition)}`;
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

    case "trigger.digital_input_changed": {
      const toLabel = (cfg.changed_to && cfg.changed_to !== "any") ? ` → ${cfg.changed_to}` : "";
      return `When ${physicalLabel("digital", cfg.channel || "1")} changes${toLabel} · now ${physicalLiveValueText("digital", cfg.channel || "1")}`;
    }

    case "trigger.analog_input_above":
      return `${physicalLabel("analog", cfg.channel || "1")} > ${formatAnalogThreshold(cfg.threshold)} V · now ${physicalLiveValueText("analog", cfg.channel || "1")}`;

    case "trigger.analog_input_below":
      return `${physicalLabel("analog", cfg.channel || "1")} < ${formatAnalogThreshold(cfg.threshold)} V · now ${physicalLiveValueText("analog", cfg.channel || "1")}`;

    case "trigger.physical_output_changed": {
      const targetKind = String(cfg.target_kind || "output").trim().toLowerCase() === "relay" ? "relay" : "output";
      const channel = cfg.channel || "1";
      return `When ${physicalLabel(targetKind, channel)} changes · now ${physicalLiveValueText(targetKind, channel)}`;
    }

    case "trigger.speaker_audio_played": {
      const speaker = state.speakers.find(s => s.id === cfg.speaker_id);
      const speakerLabel = speaker?.name || cfg.speaker_id || "any speaker";
      const audioType = String(cfg.audio_type || "any").trim().toLowerCase();
      const typeLabel = audioType === "clip" ? "clip" : audioType === "voice" ? "voice" : "clip or voice";
      return `When ${typeLabel} played on ${speakerLabel}`;
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

    case "trigger.door":
      return cfg.name ? `"${cfg.name}"` : "Door (unnamed)";

    case "action.record": {
      const ids = recordDeviceIds(cfg);
      let label;
      if (!ids.length) {
        label = "camera";
      } else if (ids.length === 1) {
        const device = state.devices.find((item) => item.id === ids[0]);
        label = device?.name || ids[0];
      } else {
        label = `${ids.length} cameras`;
      }
      return `${label} · start · -${formatSecondsLabel(cfg.before_seconds ?? 10)}`;
    }

    case "action.stop_recording": {
      const ids = recordDeviceIds(cfg);
      let label;
      if (!ids.length) {
        label = "camera";
      } else if (ids.length === 1) {
        const device = state.devices.find((item) => item.id === ids[0]);
        label = device?.name || ids[0];
      } else {
        label = `${ids.length} cameras`;
      }
      return `${label} · stop`;
    }

    case "action.log_message":
      return cfg.message || "Log message";

    case "action.contribute": {
      const targetLabel = _scenariosCache.find(s => s.id === cfg.target_id)?.name || "scenario";
      return `→ ${targetLabel}${(cfg.snapshot_entries || []).length ? ` (${cfg.snapshot_entries.length} cam)` : ""}`;
    }

    case "action.fire": {
      const targetLabel = _scenariosCache.find(s => s.id === cfg.target_id)?.name || "scenario";
      return `Analyse Scenario: ${targetLabel}`;
    }

    case "action.flush": {
      const targetLabel = _scenariosCache.find(s => s.id === cfg.target_id)?.name || "scenario";
      return `Flush Scenario: ${targetLabel}`;
    }

    case "action.submit_event":
      return `${cfg.event_name || "Event"} · ${cfg.priority || "medium"}`;

    case "action.play_audio": {
      const speaker = state.speakers.find(s => s.id === cfg.speaker_id);
      const speakerLabel = speaker?.name || "speaker";
      const clipLabel = cfg.clip_filename || "clip";
      return `${clipLabel} → ${speakerLabel}`;
    }

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

let _saveViewportTimer = 0;

function saveViewport() {
  const id = currentFlow()?.id;
  if (!id) return;
  const scroller = el("flowBoardScroller");
  if (!scroller || scroller.clientWidth === 0) return;
  try {
    const cache = JSON.parse(localStorage.getItem("flowViewports") || "{}");
    cache[id] = {
      zoom: state.zoom,
      panX: state.panX,
      panY: state.panY,
    };
    localStorage.setItem("flowViewports", JSON.stringify(cache));
  } catch (_) { /* quota / private mode */ }
}

function saveViewportDebounced() {
  clearTimeout(_saveViewportTimer);
  _saveViewportTimer = setTimeout(saveViewport, 200);
}

function restoreOrFitViewport() {
  const id = currentFlow()?.id;
  let saved = null;
  try {
    const cache = JSON.parse(localStorage.getItem("flowViewports") || "{}");
    saved = id && cache[id];
  } catch (_) { /* ignore */ }
  if (saved && typeof saved.panX === "number") {
    _zoomTarget = saved.zoom;
    state.panX = saved.panX;
    state.panY = saved.panY;
    applyZoom(saved.zoom);
  } else {
    zoomToFit();
  }
}

function centerBoardViewport() {
  const scroller = el("flowBoardScroller");
  const board = el("flowBoard");
  const nodesBox = el("flowNodes");
  const z = state.zoom || 1;

  if (!scroller || !board || !nodesBox) return;

  const nodeEls = [...nodesBox.querySelectorAll(".flowNode")];
  const vw = scroller.clientWidth;
  const vh = scroller.clientHeight;

  if (!nodeEls.length) {
    state.panX = vw / 2;
    state.panY = vh / 2;
    applyTransform();
    drawEdges();
    return;
  }

  const bounds = getNodeBounds(nodeEls);
  const cx = (bounds.minLeft + bounds.maxRight) / 2;
  const cy = (bounds.minTop + bounds.maxBottom) / 2;

  state.panX = vw / 2 - cx * z;
  state.panY = vh / 2 - cy * z;
  applyTransform();
  drawEdges();
}

function getNodeBounds(nodeEls) {
  let minLeft = Infinity, minTop = Infinity;
  let maxRight = -Infinity, maxBottom = -Infinity;

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

  return { minLeft, minTop, maxRight, maxBottom };
}

function zoomToFit() {
  const scroller = el("flowBoardScroller");
  const nodesBox = el("flowNodes");
  if (!scroller || !nodesBox) { applyZoom(1); return; }

  const nodeEls = [...nodesBox.querySelectorAll(".flowNode")];
  if (!nodeEls.length) { applyZoom(1); centerBoardViewport(); return; }

  const bounds = getNodeBounds(nodeEls);
  const padding = 60;
  const contentW = bounds.maxRight - bounds.minLeft + padding * 2;
  const contentH = bounds.maxBottom - bounds.minTop + padding * 2;

  const viewW = scroller.clientWidth;
  const viewH = scroller.clientHeight;

  let fitZoom = Math.min(viewW / contentW, viewH / contentH);
  fitZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fitZoom));
  fitZoom = Math.min(fitZoom, 1.5);

  _zoomTarget = fitZoom;

  const cx = (bounds.minLeft + bounds.maxRight) / 2;
  const cy = (bounds.minTop + bounds.maxBottom) / 2;

  state.panX = viewW / 2 - cx * fitZoom;
  state.panY = viewH / 2 - cy * fitZoom;
  applyZoom(fitZoom);
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

      saveViewport();
      state.selectedSavedFlowId = flow.id;
      state.draft = deepClone(flow);
      clearEditorSelection();
      state.connecting = null;
      state.connectionCursor = null;

      clearDirty();
      clearTestResult();
      renderAll();
      window.requestAnimationFrame(restoreOrFitViewport);
      setStatus(`Loaded flow "${flow.name}".`);
    });
  });
}

function handleNewFlow() {
  if (!confirmDiscard()) return;

  saveViewport();
  state.selectedSavedFlowId = null;
  state.draft = starterFlow();
  clearEditorSelection();
  state.connecting = null;
  state.connectionCursor = null;

  clearDirty();
  clearTestResult();
  renderAll();
  window.requestAnimationFrame(zoomToFit);
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
    window.requestAnimationFrame(zoomToFit);
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

  const categoryOrder = ["trigger", "condition", "operator", "action"];
  const sortedEntries = [...groups.entries()].sort((a, b) => {
    const ai = categoryOrder.indexOf(a[0]);
    const bi = categoryOrder.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  box.innerHTML = sortedEntries.map(([category, items]) => {
    const meta = CATEGORY_META[category] || { label: category, color: "#888" };
    return `
    <div class="paletteGroup" data-category="${escapeHtml(category)}">
      <div class="paletteGroupHead">
        <span class="paletteCatBadge" style="background:${meta.color}22; color:${meta.color};">${escapeHtml(meta.label)}</span>
        <span class="paletteCatCount">${items.length}</span>
      </div>
      <div class="paletteGroupBody">
        ${items.map((item) => `
          <button class="paletteItem" type="button" data-type="${escapeHtml(item.type)}">
            <span class="paletteItemDot" style="background:${meta.color};"></span>
            <div class="paletteItemText">
              <div class="paletteItemTitle">${escapeHtml(item.label)}</div>
              <div class="paletteItemSub">${escapeHtml(item.description || "")}</div>
            </div>
          </button>
        `).join("")}
      </div>
    </div>
  `}).join("");

  box.querySelectorAll(".paletteItem").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedPaletteType = button.dataset.type;
      state.selectedNodeId = null;
      state.selectedEdgeId = null;
      renderInspector();
    });

    button.setAttribute("draggable", "true");
    button.addEventListener("dragstart", (ev) => {
      state.paletteDrag = button.dataset.type;
      ev.dataTransfer.effectAllowed = "copy";
      ev.dataTransfer.setData("text/plain", button.dataset.type);
      button.classList.add("palette-dragging");
    });
    button.addEventListener("dragend", () => {
      state.paletteDrag = null;
      button.classList.remove("palette-dragging");
      el("flowBoardScroller")?.classList.remove("drop-target-active");
    });
  });
}

function addNodeFromPalette(type) {
  const flow = currentFlow();
  const def = nodeDef(type);
  if (!flow || !def) return;

  const boardScroller = el("flowBoardScroller");
  const vw = boardScroller?.clientWidth || 400;
  const vh = boardScroller?.clientHeight || 300;
  const x = (vw / 2 - state.panX) / state.zoom;
  const y = (vh / 2 - state.panY) / state.zoom;

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

function duplicatedNodePosition(flow, sourceNode) {
  const baseX = Number(sourceNode?.x) || 0;
  const baseY = Number(sourceNode?.y) || 0;
  const stepX = 36;
  const stepY = 28;

  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const x = Math.max(20, baseX + stepX * attempt);
    const y = Math.max(20, baseY + stepY * attempt);
    const occupied = (flow?.nodes || []).some((item) => Math.abs((Number(item?.x) || 0) - x) < 8 && Math.abs((Number(item?.y) || 0) - y) < 8);
    if (!occupied) {
      return { x, y };
    }
  }

  return {
    x: Math.max(20, baseX + stepX),
    y: Math.max(20, baseY + stepY),
  };
}

function duplicateNodeById(nodeId) {
  const flow = currentFlow();
  const node = flow?.nodes.find((item) => item.id === nodeId);
  if (!flow || !node) return null;

  const position = duplicatedNodePosition(flow, node);
  const copy = {
    ...deepClone(node),
    id: makeId("node"),
    x: position.x,
    y: position.y,
  };

  flow.nodes.push(copy);
  selectNode(copy.id);
  markDirty();
  renderAll();
  setStatus(`Duplicated node "${displayNodeTitle(node) || node.label}".`);
  return copy;
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
    saveViewport();
    state.scheduleBlockResizeObserver?.disconnect();
    state.scheduleBlockResizeObserver = null;
    boardWrap?.classList.add("hidden");
    boardStatusLine?.classList.add("hidden");
    scheduleWorkspace.classList.remove("hidden");
    scheduleWorkspace.innerHTML = renderSchedulePlannerWorkspace(schedule, state.selectedScheduleIndex);
    bindScheduleWorkspace(state.selectedScheduleIndex);
    return;
  }

  const wasHidden = boardWrap?.classList.contains("hidden");
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
    const ports = nodeEffectivePorts(node, def);
    const meta = CATEGORY_META[node.category] || CATEGORY_META.action;
    const tag = recordNodeTag(node);
    const invalidReason = isNodeInvalid(node);

    return `
      <div class="flowNode ${node.category} ${node.id === state.selectedNodeId ? "selected" : ""} ${invalidReason ? "invalid" : ""}" data-node-id="${escapeHtml(node.id)}" style="left:${Number(node.x) || 0}px; top:${Number(node.y) || 0}px;">
        <div class="flowNodeTop">
          <div>
            <div class="flowNodeLabel">${escapeHtml(displayNodeTitle(node) || node.label)}</div>
            <div class="flowNodeType">${escapeHtml(meta.label)}</div>
          </div>
          ${invalidReason ? `<span class="nodeBadge invalidBadge" title="${escapeHtml(invalidReason)}">⚠</span>` : ""}
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
                  <span class="flowBranchLabel ${node.type === "action.fire" ? "neutral" : (port === "true" ? "then" : port === "false" ? "else" : port === "ready" ? "ready" : "neutral")}">
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
          x: (ev.clientX - rect.left) / state.zoom,
          y: (ev.clientY - rect.top) / state.zoom,
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
      button.disabled = true;
      setStatus(`Running manual trigger…`);
      try {
        await triggerManualNode(button.dataset.runNodeId);
      } catch { }
      button.disabled = false;
    });

    button.addEventListener("mousedown", (ev) => {
      ev.stopPropagation();
    });
  });

  window.requestAnimationFrame(() => {
    drawEdges();
    if (wasHidden) {
      restoreOrFitViewport();
    }
  });
}

/* ── Zoom helpers ──────────────────────────────────── */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2;
let _zoomRaf = 0;
let _zoomTarget = 1;
let _zoomAnchor = null;        /* { cx, cy } */

function applyTransform() {
  const board = el("flowBoard");
  if (!board) return;
  board.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;

  /* Infinite grid tied to pan + zoom */
  const scroller = el("flowBoardScroller");
  if (scroller) {
    const z = state.zoom;
    const majorSize = 72 * z;
    const minorSize = 18 * z;
    const ox = state.panX;
    const oy = state.panY;
    scroller.style.backgroundImage = [
      `linear-gradient(var(--flow-grid-major) 1px, transparent 1px)`,
      `linear-gradient(90deg, var(--flow-grid-major) 1px, transparent 1px)`,
      `linear-gradient(var(--flow-grid-minor) 1px, transparent 1px)`,
      `linear-gradient(90deg, var(--flow-grid-minor) 1px, transparent 1px)`,
    ].join(",");
    scroller.style.backgroundSize = `${majorSize}px ${majorSize}px, ${majorSize}px ${majorSize}px, ${minorSize}px ${minorSize}px, ${minorSize}px ${minorSize}px`;
    scroller.style.backgroundPosition = `${ox}px ${oy}px, ${ox}px ${oy}px, ${ox}px ${oy}px, ${ox}px ${oy}px`;
  }
}

function applyZoom(newZoom, ev) {
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
  const board = el("flowBoard");
  const scroller = el("flowBoardScroller");
  if (!board || !scroller) { state.zoom = z; return; }

  const prevZoom = state.zoom;
  state.zoom = z;

  /* Keep zoom centred on pointer (or centre of viewport) */
  if (ev) {
    const rect = scroller.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    /* board point under cursor: bx = (cx - panX) / prevZoom
       new panX so bx stays under cursor: panX_new = cx - bx * z */
    state.panX = cx - (cx - state.panX) / prevZoom * z;
    state.panY = cy - (cy - state.panY) / prevZoom * z;
  } else if (_zoomAnchor) {
    const { cx, cy } = _zoomAnchor;
    state.panX = cx - (cx - state.panX) / prevZoom * z;
    state.panY = cy - (cy - state.panY) / prevZoom * z;
  }

  applyTransform();

  const label = document.getElementById("zoomLabel");
  if (label) label.textContent = `${Math.round(z * 100)}%`;

  drawEdges();
  saveViewportDebounced();
}

/* Smooth animated zoom — lerps toward _zoomTarget each frame */
function _tickZoom() {
  const diff = _zoomTarget - state.zoom;
  if (Math.abs(diff) < 0.002) {
    applyZoom(_zoomTarget);
    _zoomRaf = 0;
    _zoomAnchor = null;
    return;
  }
  applyZoom(state.zoom + diff * 0.25);
  _zoomRaf = requestAnimationFrame(_tickZoom);
}

function smoothZoom(delta, ev) {
  _zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, _zoomTarget + delta));
  if (ev) {
    const scroller = el("flowBoardScroller");
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      _zoomAnchor = {
        cx: ev.clientX - rect.left,
        cy: ev.clientY - rect.top,
      };
    }
  }
  if (!_zoomRaf) _zoomRaf = requestAnimationFrame(_tickZoom);
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

    const sx = (sourceRect.left - boardRect.left + sourceRect.width / 2) / state.zoom;
    const sy = (sourceRect.top - boardRect.top + sourceRect.height / 2) / state.zoom;
    const tx = (targetRect.left - boardRect.left + targetRect.width / 2) / state.zoom;
    const ty = (targetRect.top - boardRect.top + targetRect.height / 2) / state.zoom;

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

      const ax = (anchorRect.left - boardRect.left + anchorRect.width / 2) / state.zoom;
      const ay = (anchorRect.top - boardRect.top + anchorRect.height / 2) / state.zoom;
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

  if (state.selectedScenarioIndex != null) {
    const scenario = currentSelectedScenario();
    if (!scenario) {
      state.selectedScenarioIndex = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = `${scenario.name || "scenario"} settings`;
    }

    box.innerHTML = renderScenarioInspector(scenario, state.selectedScenarioIndex);
    bindScenarioInspector(state.selectedScenarioIndex);
    restoreInspectorFocusState(focusState);
    return;
  }

  if (state.selectedPaletteType) {
    const def = nodeDef(state.selectedPaletteType);
    if (!def) {
      state.selectedPaletteType = null;
      renderInspector();
      return;
    }

    if (el("inspectorSubtext")) {
      el("inspectorSubtext").textContent = "Node reference (read-only)";
    }

    const ports = def.ports || { inputs: [], outputs: [] };
    const inputList = (ports.inputs || []).map((p) => escapeHtml(p)).join(", ") || "none";
    const outputList = (ports.outputs || []).map((p) => escapeHtml(p)).join(", ") || "none";

    box.innerHTML = `
      <div class="inspectorCard">
        <div class="inspectorTitle">${escapeHtml(def.label)}</div>
        <div class="inspectorHint">${escapeHtml(def.category)}</div>
        ${def.description ? `<div class="inspectorHint mt-10">${escapeHtml(def.description)}</div>` : ""}
        <div class="fieldGrid mt-10">
          <div class="full">
            <label>Type</label>
            <input value="${escapeHtml(def.type)}" readonly />
          </div>
          <div class="full">
            <label>Inputs</label>
            <input value="${escapeHtml(inputList)}" readonly />
          </div>
          <div class="full">
            <label>Outputs</label>
            <input value="${escapeHtml(outputList)}" readonly />
          </div>
        </div>
      </div>
      <div class="inspectorCard">
        <div class="inspectorHint">Drag this node from the sidebar onto the canvas to add it to the flow.</div>
      </div>
    `;

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
          ${scheduleRowsForSchedule(schedule).map((row) => renderScheduleDayLane(schedule, index, row)).join("")}
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

  const { dayKey, dayLabel, periods, schedule, row } = selectedDay;
  const selectedPeriodIndex = selectedPeriod?.selection?.dayKey === dayKey ? selectedPeriod.selection.periodIndex : null;
  const isHolidayDay = dayKey === HOLIDAY_DAY_KEY;
  const isSpecialDay = row.kind === "special";
  const specialDates = isSpecialDay ? (row.specialDay?.dates || []) : [];

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
      ${isSpecialDay ? `
        <div class="fieldGrid mt-10">
          <div class="full">
            <label>Special day group name</label>
            <input id="scheduleSpecialDayNameInput" value="${escapeHtml(row.specialDay?.name || "")}" placeholder="Christmas week" />
          </div>
        </div>
        ${renderScheduleSpecialDayCalendar(schedule, index, dayKey, row.specialDay)}
        ${specialDates.length ? "" : `<div class="inlineMeta mt-10">No dates selected yet. Dates in this group override the regular weekday and holiday rows.</div>`}
        <div class="inspectorActionGrid inspectorActionGrid--single mt-10">
          <button class="btn btn-danger" id="btnScheduleSpecialDayDelete" type="button">Delete special day group</button>
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
        <div class="inspectorHint mt-10">Select a day on the planner to edit that day. Special day groups appear below Holidays and override recurring days on their selected dates.</div>
      </div>

      ${renderScheduleManualEditInspector(index)}

      <div class="inspectorCard inspectorActionsCard">
        <div class="inspectorActionHeader">
          <div class="inspectorTitle">Schedule actions</div>
          <div class="inspectorHint">Create a new schedule, add a special-day group, save this one, or delete it.</div>
        </div>
        <div class="schedulePlannerToolbarActions">
            <button class="btn btn-primary" id="btnInspectorAddSchedule" type="button">New</button>
            <button class="btn" id="btnInspectorAddSpecialDay" type="button">Add special day</button>
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
      ...(item?.special_days || []).map((specialDay) => [
        specialDay?.key || "",
        specialDay?.name || "",
        (specialDay?.dates || []).join(","),
        (specialDay?.periods || []).map((period) => `${period.start}-${period.end}`).join(","),
      ]),
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

async function refreshRecordingLimits() {
  try {
    const data = await api("/api/system/recording-limits");
    state.recordingLimits = {
      trigger_max_duration_seconds: Number(data?.trigger_max_duration_seconds || 1800),
      trigger_max_duration_ceiling: Number(data?.trigger_max_duration_ceiling || 86400),
    };
  } catch (_) {
    // Keep last-known values; UI falls back to defaults if never loaded.
  }
}
refreshRecordingLimits();

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
  state.speakers = Array.isArray(catalog?.speakers) ? catalog.speakers : [];
  state.audioClips = Array.isArray(catalog?.audio_clips) ? catalog.audio_clips : [];
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
  state.speakers = Array.isArray(catalog?.speakers) ? catalog.speakers : [];
  state.audioClips = Array.isArray(catalog?.audio_clips) ? catalog.audio_clips : [];
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
    schedule.special_days = normalizeScheduleSpecialDays(schedule.special_days || []);

    const seenSpecialDates = new Map();
    const seenSpecialKeys = new Set();
    schedule.special_days.forEach((specialDay, specialIndex) => {
      if (!specialDay.key || seenSpecialKeys.has(specialDay.key)) {
        throw new Error(`Schedule '${key}' has duplicate special day groups.`);
      }
      seenSpecialKeys.add(specialDay.key);
      specialDay.name = scheduleSpecialDayDisplayName(specialDay, specialIndex);
      specialDay.dates = normalizeScheduleSpecialDayDates(specialDay.dates || []);
      specialDay.periods = normalizeScheduleDayPeriods(specialDay.periods || []);

      for (const dateValue of specialDay.dates) {
        if (seenSpecialDates.has(dateValue)) {
          throw new Error(`Special day date ${dateValue} is already assigned to '${seenSpecialDates.get(dateValue)}'.`);
        }
        seenSpecialDates.set(dateValue, specialDay.name);
      }

      for (const period of specialDay.periods || []) {
        const start = normalizeScheduleTime(period.start, "09:00");
        const end = normalizeScheduleTime(period.end, "17:00");
        if (start === end) {
          throw new Error(`${specialDay.name} active hours cannot start and end at the same time.`);
        }
      }
    });
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
      special_days: normalizeScheduleSpecialDays(schedule.special_days || []).map((specialDay) => ({
        key: specialDay.key,
        name: specialDay.name,
        dates: [...specialDay.dates],
        periods: normalizeSchedulePeriods(specialDay.periods || []),
      })),
    })),
  };
}

function addSchedule() {
  state.schedules.push(normalizeScheduleRecord({
    key: nextScheduleKey(),
    name: `Schedule ${currentSchedules().length + 1}`,
    holiday_calendar: "DK",
    days: emptyScheduleDays(),
    special_days: [],
    is_active: false,
  }));

  if (el("scheduleSearch")) {
    el("scheduleSearch").value = "";
  }

  selectSchedule(currentSchedules().length - 1);
  setSidebarSectionExpanded("schedules", true);
  markSchedulesDirty();
  renderFlowList();
  renderScheduleSidebar();
  renderCanvas();
  renderInspector();
}

function addScheduleSpecialDay(scheduleIndex = state.selectedScheduleIndex) {
  const schedule = currentSchedules()[scheduleIndex];
  if (!schedule) return;

  const specialDay = normalizeScheduleSpecialDayRecord({
    key: nextScheduleSpecialDayKey(schedule),
    name: nextScheduleSpecialDayName(schedule),
    dates: [],
    periods: [],
  }, scheduleSpecialDays(schedule).length);

  schedule.special_days.push(specialDay);
  selectScheduleDay(scheduleIndex, `${SPECIAL_DAY_ROW_PREFIX}${specialDay.key}`);
  state.selectedSchedulePeriod = null;
  markSchedulesDirty();
  renderScheduleSidebar();
  renderCanvas();
  renderInspector();
  setStatus(`Added ${specialDay.name}.`);
}

function removeSchedule(index) {
  if (!currentSchedules()[index]) return;

  state.schedules.splice(index, 1);
  state.selectedScheduleDay = null;
  state.selectedSchedulePeriod = null;

  if (!currentSchedules().length) {
    state.selectedScheduleIndex = null;
    state.selectedSavedFlowId = currentFlow()?.id || null;
  } else {
    state.selectedScheduleIndex = Math.min(index, currentSchedules().length - 1);
  }

  markSchedulesDirty();
  renderFlowList();
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
      renderFlowList();
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

  document.getElementById("btnInspectorAddSchedule")?.addEventListener("click", () => {
    handleAddSchedule();
  });

  document.getElementById("btnInspectorAddSpecialDay")?.addEventListener("click", () => {
    addScheduleSpecialDay(index);
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

  document.getElementById("scheduleSpecialDayNameInput")?.addEventListener("input", (ev) => {
    const selectedDay = getSelectedDayEntry();
    if (!selectedDay || selectedDay.row.kind !== "special") return;

    selectedDay.row.specialDay.name = ev.target.value;
    markSchedulesDirty();

    const rowLabel = document.querySelector(`[data-schedule-day-select="${CSS.escape(selectedDay.dayKey)}"] .scheduleDayLabel`);
    if (rowLabel) {
      rowLabel.textContent = scheduleSpecialDayDisplayName(selectedDay.row.specialDay, selectedDay.row.specialIndex);
    }
  });

  document.getElementById("scheduleSpecialDayNameInput")?.addEventListener("change", () => {
    const selectedDay = getSelectedDayEntry();
    if (!selectedDay || selectedDay.row.kind !== "special") return;

    selectedDay.row.specialDay.name = scheduleSpecialDayDisplayName(selectedDay.row.specialDay, selectedDay.row.specialIndex);
    renderScheduleSidebar();
    renderCanvas();
    renderInspector();
  });

  inspector?.querySelectorAll("[data-schedule-special-calendar-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedDay = getSelectedDayEntry();
      if (!selectedDay || selectedDay.row.kind !== "special") return;

      const offset = Number(button.dataset.scheduleSpecialCalendarNav || 0);
      const mode = String(button.dataset.scheduleSpecialCalendarNavMode || "month");
      const currentMonth = scheduleSpecialDayCalendarMonth(index, selectedDay.dayKey, selectedDay.row.specialDay.dates || []);
      if (mode === "month") {
        setScheduleSpecialDayCalendarMonth(index, selectedDay.dayKey, scheduleShiftMonthKey(currentMonth, offset));
      } else {
        const monthDate = scheduleMonthDateFromKey(currentMonth);
        const nextYear = monthDate.getUTCFullYear() + offset;
        const nextMonthKey = `${nextYear}-${String(monthDate.getUTCMonth() + 1).padStart(2, "0")}`;
        setScheduleSpecialDayCalendarMonth(index, selectedDay.dayKey, nextMonthKey);
      }
      renderInspector();
    });
  });

  inspector?.querySelectorAll("[data-schedule-special-calendar-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedDay = getSelectedDayEntry();
      if (!selectedDay || selectedDay.row.kind !== "special") return;

      setScheduleSpecialDayCalendarView(index, selectedDay.dayKey, button.dataset.scheduleSpecialCalendarView || "days");
      renderInspector();
    });
  });

  inspector?.querySelectorAll("[data-schedule-special-calendar-today]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedDay = getSelectedDayEntry();
      if (!selectedDay || selectedDay.row.kind !== "special") return;

      setScheduleSpecialDayCalendarMonth(index, selectedDay.dayKey, currentScheduleMonthKey());
      setScheduleSpecialDayCalendarView(index, selectedDay.dayKey, "days");
      renderInspector();
    });
  });

  inspector?.querySelectorAll("[data-schedule-special-calendar-month]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedDay = getSelectedDayEntry();
      if (!selectedDay || selectedDay.row.kind !== "special") return;

      const currentMonth = scheduleSpecialDayCalendarMonth(index, selectedDay.dayKey, selectedDay.row.specialDay.dates || []);
      const currentMonthDate = scheduleMonthDateFromKey(currentMonth);
      const yearValue = currentMonthDate.getUTCFullYear();
      const monthIndex = Math.max(0, Math.min(11, Number(button.dataset.scheduleSpecialCalendarMonth || 0)));
      setScheduleSpecialDayCalendarMonth(index, selectedDay.dayKey, `${yearValue}-${String(monthIndex + 1).padStart(2, "0")}`);
      setScheduleSpecialDayCalendarView(index, selectedDay.dayKey, "days");
      renderInspector();
    });
  });

  inspector?.querySelectorAll("[data-schedule-special-calendar-year]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedDay = getSelectedDayEntry();
      if (!selectedDay || selectedDay.row.kind !== "special") return;

      const currentMonth = scheduleSpecialDayCalendarMonth(index, selectedDay.dayKey, selectedDay.row.specialDay.dates || []);
      const currentMonthDate = scheduleMonthDateFromKey(currentMonth);
      const nextYear = Number(button.dataset.scheduleSpecialCalendarYear || currentMonthDate.getUTCFullYear());
      const nextMonthKey = `${nextYear}-${String(currentMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
      setScheduleSpecialDayCalendarMonth(index, selectedDay.dayKey, nextMonthKey);
      setScheduleSpecialDayCalendarView(index, selectedDay.dayKey, "months");
      renderInspector();
    });
  });

  inspector?.querySelectorAll("[data-schedule-special-calendar-date]").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedDay = getSelectedDayEntry();
      if (!selectedDay || selectedDay.row.kind !== "special") return;

      const dateValue = normalizeScheduleDate(button.dataset.scheduleSpecialCalendarDate || "");
      if (!dateValue) return;

      const currentDates = selectedDay.row.specialDay.dates || [];
      if (currentDates.includes(dateValue)) {
        selectedDay.row.specialDay.dates = currentDates.filter((item) => item !== dateValue);
      } else {
        const otherOwner = scheduleDateAssignedElsewhere(selectedDay.schedule, dateValue, selectedDay.row.specialDay.key);
        if (otherOwner) {
          setStatus(`${dateValue} is already assigned to ${scheduleSpecialDayDisplayName(otherOwner)}.`, true);
          return;
        }
        selectedDay.row.specialDay.dates = normalizeScheduleSpecialDayDates([...currentDates, dateValue]);
      }

      markSchedulesDirty();
      renderInspector();
    });
  });

  document.getElementById("btnScheduleSpecialDayDelete")?.addEventListener("click", () => {
    const selectedDay = getSelectedDayEntry();
    if (!selectedDay || selectedDay.row.kind !== "special") return;

    selectedDay.schedule.special_days.splice(selectedDay.row.specialIndex, 1);
    selectScheduleDay(index, HOLIDAY_DAY_KEY);
    state.selectedSchedulePeriod = null;
    markSchedulesDirty();
    renderScheduleSidebar();
    renderCanvas();
    renderInspector();
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
    const nextPeriods = [...scheduleRowPeriods(schedule, selectedDay.dayKey)];
    nextPeriods.splice(periodIndex, 1);
    nextPeriods.push({ start, end });
    const normalizedPeriods = setScheduleRowPeriods(schedule, selectedDay.dayKey, nextPeriods);

    const nextPeriodIndex = normalizedPeriods.findIndex((period) => period.start === start && period.end === end);
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

      const nextPeriods = [...scheduleRowPeriods(selectedDay.schedule, selectedDay.dayKey)];
      nextPeriods.splice(periodIndex, 1);
      setScheduleRowPeriods(selectedDay.schedule, selectedDay.dayKey, nextPeriods);
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

        const nextPeriods = [...scheduleRowPeriods(schedule, dayKey)];
        nextPeriods.splice(periodIndex, 1);
        setScheduleRowPeriods(schedule, dayKey, nextPeriods);
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

      const period = scheduleRowPeriods(schedule, dayKey)?.[periodIndex];
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
          <div class="inspectorTitle">ONVIF event</div>
          <div class="inspectorHint">Choose a topic, then optionally restrict the trigger to active or inactive boolean state transitions when the event provides them.</div>
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
            <div class="full">
              <label>Transition</label>
              <select id="cfg_transition">${onvifTransitionOptionsHtml(cfg.transition || "any")}</select>
              <div class="inlineMeta">Use active or inactive only for stateful ONVIF events that carry boolean values such as motion, inside-area, relays, tamper, or similar analytics states.</div>
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
            <div class="full">
              <span id="manualTriggerStatus" class="muted" style="font-size:0.85em;"></span>
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
            <div class="full">
              <label>Changed to</label>
              <select id="cfg_changed_to">
                <option value="any" ${(cfg.changed_to || "any") === "any" ? "selected" : ""}>Any</option>
                <option value="high" ${cfg.changed_to === "high" ? "selected" : ""}>High</option>
                <option value="low" ${cfg.changed_to === "low" ? "selected" : ""}>Low</option>
              </select>
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

    case "trigger.speaker_audio_played": {
      const audioType = String(cfg.audio_type || "any").trim().toLowerCase();
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Speaker audio played</div>
          <div class="inspectorHint">Triggers when an audio clip or voice message is played on a speaker.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Speaker</label>
              <select id="cfg_speaker_id">
                <option value=""${!cfg.speaker_id ? " selected" : ""}>Any speaker</option>
                ${state.speakers.map(s => `<option value="${escapeHtml(s.id)}"${s.id === cfg.speaker_id ? " selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}
              </select>
            </div>
            <div class="full">
              <label>Audio type</label>
              <select id="cfg_audio_type">
                <option value="any"${audioType === "any" ? " selected" : ""}>Any (clip or voice)</option>
                <option value="clip"${audioType === "clip" ? " selected" : ""}>Audio clip only</option>
                <option value="voice"${audioType === "voice" ? " selected" : ""}>Voice only</option>
              </select>
            </div>
          </div>
        </div>
      `;
      break;
    }

    case "trigger.nox_input_changed": {
      const matchBy = String(cfg.match_by || "modbus").trim().toLowerCase();
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">NOX input changed</div>
          <div class="inspectorHint">Fires when a NOX detector input changes state.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Source</label>
              <select id="cfg_match_by">
                <option value="modbus"${matchBy === "modbus" ? " selected" : ""}>Modbus poller (configured inputs)</option>
                <option value="tio"${matchBy === "tio" ? " selected" : ""}>TIO ASCII push</option>
              </select>
            </div>
            ${matchBy === "modbus" ? `
              <div class="full">
                <label>Input</label>
                <select id="cfg_nox_input">${noxInputOptionsHtml(cfg.module, cfg.input)}</select>
              </div>` : `
              <div class="full">
                <label>TIO input (auto-discovered)</label>
                <select id="cfg_tio_id">${noxTioInputOptionsHtml(cfg.tio_id)}</select>
              </div>`}
          </div>
        </div>
      `;
      break;
    }

    case "trigger.nox_alarm_changed": {
      const scope = String(cfg.scope || "any").trim().toLowerCase();
      const alarmState = String(cfg.alarm_state || "any").trim().toLowerCase();
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">NOX alarm changed</div>
          <div class="inspectorHint">Fires when an alarm bit transitions on a detector or area. Modbus only exposes the alarm bit — not which alarm type from NoxConfig.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Scope</label>
              <select id="cfg_scope">
                <option value="any"${scope === "any" ? " selected" : ""}>Any (input or area)</option>
                <option value="input"${scope === "input" ? " selected" : ""}>Detector input</option>
                <option value="area"${scope === "area" ? " selected" : ""}>Area</option>
              </select>
            </div>
            ${scope === "area" ? `
              <div class="full">
                <label>Area</label>
                <select id="cfg_area_id">${noxAnyAreaOptionsHtml(cfg.area_id)}</select>
              </div>` : ""}
            ${scope === "input" ? `
              <div class="full">
                <label>Input</label>
                <select id="cfg_nox_input">${noxInputOptionsHtml(cfg.module, cfg.input)}</select>
              </div>` : ""}
            <div class="full">
              <label>State</label>
              <select id="cfg_alarm_state">
                <option value="any"${alarmState === "any" ? " selected" : ""}>Any change</option>
                <option value="alarm"${alarmState === "alarm" ? " selected" : ""}>Going into alarm</option>
                <option value="clear"${alarmState === "clear" ? " selected" : ""}>Clearing alarm</option>
              </select>
            </div>
          </div>
        </div>
      `;
      break;
    }

    case "trigger.nox_area_changed": {
      const wantedState = String(cfg.state || "any").trim().toLowerCase();
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">NOX area changed</div>
          <div class="inspectorHint">Fires when a NOX area's state code changes (Modbus poller or TIO push).</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Area</label>
              <select id="cfg_area_id">${noxAnyAreaOptionsHtml(cfg.area_id)}</select>
            </div>
            <div class="full">
              <label>Filter to state (optional)</label>
              <select id="cfg_state">
                <option value="any"${wantedState === "any" ? " selected" : ""}>Any change</option>
                <option value="disarmed"${wantedState === "disarmed" ? " selected" : ""}>disarmed (Frakoblet)</option>
                <option value="armed"${wantedState === "armed" ? " selected" : ""}>armed (Tilkoblet)</option>
                <option value="partly_armed"${wantedState === "partly_armed" ? " selected" : ""}>partly_armed (Delvis tilkoblet)</option>
                <option value="disarmed_exit"${wantedState === "disarmed_exit" ? " selected" : ""}>disarmed_exit (Udgangstid)</option>
                <option value="disarmed_entry"${wantedState === "disarmed_entry" ? " selected" : ""}>disarmed_entry (Indgangstid)</option>
              </select>
            </div>
          </div>
        </div>
      `;
      break;
    }

    case "action.nox_set_area_state":
    case "action.nox_arm_area":
    case "action.nox_disarm_area": {
      // Migrate legacy nodes silently for the UI: show as the unified node.
      let command = String(cfg.command || "").trim().toLowerCase();
      if (!command) {
        if (node.type === "action.nox_arm_area") command = "arm";
        else if (node.type === "action.nox_disarm_area") command = "disarm";
        else command = "arm";
      }
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Set NOX area state</div>
          <div class="inspectorHint">Arm or disarm a NOX area via Modbus FC16. Per the NOX doc, only intrusion-type areas (state codes 0–6) accept writes — ADK doors and virtual indicators are shown disabled.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Area</label>
              <select id="cfg_area_id">${noxAreaOptionsHtml(cfg.area_id, { allowAny: false, writableOnly: true })}</select>
            </div>
            <div class="full">
              <label>Command</label>
              <select id="cfg_command">
                <option value="arm"${command === "arm" ? " selected" : ""}>Arm (Tilkoblet)</option>
                <option value="disarm"${command === "disarm" ? " selected" : ""}>Disarm (Frakoblet)</option>
              </select>
            </div>
          </div>
        </div>
      `;
      break;
    }

    case "action.nox_ack_alarms": {
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Acknowledge NOX alarms</div>
          <div class="inspectorHint">Writes 1 to register 1000 (per NOX Modbus doc §1.8: ack all alarms that the panel allows to be acked).</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
          </div>
        </div>
      `;
      break;
    }

    case "action.nox_tio_send": {
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Send NOX TIO message</div>
          <div class="inspectorHint">Sends a single ASCII line via TCP to the configured TIO send target. The format depends on your NoxConfig virtual-input definition. Templates supported (e.g. {{trigger.id}}).</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional label" />
            </div>
            <div class="full">
              <label>Message</label>
              <input id="cfg_message" value="${escapeHtml(cfg.message || "")}" placeholder="e.g. CMD|RELEASE_DOOR|Garage" />
            </div>
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
            <div class="${leftSource === "physical_input" || leftSource === "trigger" ? "full" : ""}">
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
            <div class="${rightSource === "physical_input" || rightSource === "trigger" ? "full" : ""}">
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

    case "trigger.door": {
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Door</div>
          <div class="inspectorHint">Fires when the matching Door tile on the Control page is opened. Wire the output to whatever should happen (e.g. Activate physical output, Send NOX TIO, Send HTTP request).</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Door name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="e.g. Front door" />
            </div>
          </div>
        </div>
      `;
      break;
    }

    case "action.record":
      {
        const selectedPreset = recordingPresetByName(cfg.preset_name || cfg.name);
        const tagColor = selectedPreset?.color || cfg.color || "#c6a14b";
        const recordEntries = recordDeviceEntries(cfg);
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Start recording</div>
          <div class="inspectorHint">Starts a colored playback marker on one or more cameras using a shared recording tag. Use a Stop recording node later in the flow to end it.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Tag</label>
              <select id="cfg_preset_name">${recordingPresetOptionsHtml(cfg.preset_name || cfg.name || "")}</select>
            </div>
            <div class="full">
              <label>Cameras</label>
              <div id="cfg_record_devices" class="snapshotDeviceList">
                ${renderRecordDeviceList(recordEntries)}
              </div>
              <button class="btn mt-6" id="btnAddRecordDevice" type="button">Add camera</button>
            </div>
            <div>
              <label>Seconds before</label>
              <input id="cfg_before_seconds" type="number" min="0" step="1" value="${escapeHtml(cfg.before_seconds ?? 10)}" />
            </div>
            <div>
              <label>Max duration (sec)</label>
              ${(() => {
                const cap = Math.max(1, Number(state.recordingLimits?.trigger_max_duration_seconds || 1800));
                const current = Number(cfg.max_duration_seconds);
                const value = Number.isFinite(current) && current >= 1 ? Math.min(current, cap) : Math.min(60, cap);
                return `<input id="cfg_max_duration_seconds" type="number" min="1" max="${cap}" step="1" value="${escapeHtml(value)}" />
              <div class="inspectorHint mt-4">Auto-stops the recording after this many seconds if no Stop recording node fires. Capped at ${cap}s by the engine — change the cap in Settings → Storage.</div>`;
              })()}
            </div>
            <div class="full">
              <label>Quality</label>
              ${(() => {
                // Legacy "hd,sd" silently normalises to "hd" — playback
                // always plays the highest available variant, so recording
                // both was wasteful.
                let current = String(cfg.record_variants || "hd").trim().toLowerCase();
                if (current === "hd,sd" || current === "sd,hd") current = "hd";
                const opts = [
                  { value: "hd", label: "HD" },
                  { value: "sd", label: "SD" },
                ];
                return `<select id="cfg_record_variants">${opts.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === current ? " selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}</select>
              <div class="inspectorHint mt-4">The recording engine auto-pulls whatever quality is selected here. HD evidence clips on motion + an SD baseline on continuous is a common pattern.</div>`;
              })()}
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
      {
        const stopEntries = recordDeviceEntries(cfg);
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Stop recording</div>
          <div class="inspectorHint">Stops the most recent in-progress recording marker on one or more cameras.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Cameras</label>
              <div id="cfg_record_devices" class="snapshotDeviceList">
                ${renderRecordDeviceList(stopEntries)}
              </div>
              <button class="btn mt-6" id="btnAddRecordDevice" type="button">Add camera</button>
            </div>
          </div>
        </div>
      `;
      }
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

    case "action.contribute":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Contribute to scenario</div>
          <div class="inspectorHint">Takes camera snapshots and contributes them to a scenario's buffer.</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Scenario</label>
              <select id="cfg_target_id">${scenarioOptionsHtml(cfg.target_id || "")}</select>
            </div>
            <div class="full">
              <label>Snapshot cameras</label>
              <div id="cfg_snapshot_devices" class="snapshotDeviceList">
                ${renderSnapshotDeviceList(cfg.snapshot_entries || [])}
              </div>
              <div class="inlineMeta mt-6">Snapshots are captured and stored in the buffer.</div>
              <button class="btn mt-6" id="btnAddSnapshotDevice" type="button">Add camera</button>
            </div>
          </div>
        </div>
      `;
      break;

    case "action.fire":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Analyse Scenario</div>
          <div class="inspectorHint">Sends the contribution buffer to the AI scenario for analysis.</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Scenario</label>
              <select id="cfg_target_id">${scenarioOptionsHtml(cfg.target_id || "")}</select>
            </div>
          </div>
        </div>
      `;
      break;

    case "action.flush":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Flush Scenario</div>
          <div class="inspectorHint">Clears the scenario's contribution buffer without analysing.</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Scenario</label>
              <select id="cfg_target_id">${scenarioOptionsHtml(cfg.target_id || "")}</select>
            </div>
          </div>
        </div>
      `;
      break;

    case "action.submit_event":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Generate event</div>
          <div class="inspectorHint">Submits an event to the events page. Supports templates like {{trigger.path}}, {{variables.key}}.</div>
          <div class="fieldGrid">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional node label" />
            </div>
            <div class="full">
              <label>Event name</label>
              <input id="cfg_event_name" value="${escapeHtml(cfg.event_name || "Event")}" placeholder="Event" />
            </div>
            <div class="full">
              <label>Priority</label>
              <select id="cfg_priority">
                ${EVENT_PRIORITIES.map(p => `<option value="${p}" ${(cfg.priority || "medium") === p ? "selected" : ""}>${p}</option>`).join("")}
              </select>
            </div>
            <div class="full">
              <label>Details</label>
              <textarea id="cfg_details" rows="4">${escapeHtml(cfg.details || "")}</textarea>
            </div>
            <div class="full">
              <label>Snapshot cameras</label>
              <div id="cfg_snapshot_devices" class="snapshotDeviceList">
                ${renderSnapshotDeviceList(cfg.snapshot_entries || [])}
              </div>
              <div class="inlineMeta mt-6">Optional: attach camera snapshots to the event.</div>
              <button class="btn mt-6" id="btnAddSnapshotDevice" type="button">Add camera</button>
            </div>
          </div>
        </div>
      `;
      break;

    case "action.play_audio":
      body = `
        <div class="inspectorCard">
          <div class="inspectorTitle">Play audio</div>
          <div class="inspectorHint">Plays an MP3/WAV/OGG audio clip through an AXIS network speaker.</div>
          <div class="fieldGrid mt-10">
            <div class="full">
              <label>Name</label>
              <input id="cfg_name" value="${escapeHtml(cfg.name || "")}" placeholder="Optional node label" />
            </div>
            <div class="full">
              <label>Speaker</label>
              <select id="cfg_speaker_id">${speakerOptionsHtml(cfg.speaker_id || "")}</select>
            </div>
            <div class="full">
              <label>Audio clip</label>
              <select id="cfg_clip_filename">${audioClipOptionsHtml(cfg.clip_filename || "")}</select>
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
        <div class="inspectorHint">Duplicate this node or remove it and its connections from the flow.</div>
      </div>
      <div class="inspectorActionGrid inspectorActionGrid--twoUp">
        <button class="btn" id="btnDuplicateNode" type="button">Duplicate node</button>
        <button class="btn btn-danger" id="btnDeleteNode" type="button">Delete node</button>
      </div>
    </div>
  `;
}

function bindNodeInspector(node) {
  document.getElementById("btnDuplicateNode")?.addEventListener("click", () => {
    duplicateNodeById(node.id);
  });

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
      const statusEl = document.getElementById("manualTriggerStatus");
      const btn = document.getElementById("btnRunManualNode");
      if (btn) btn.disabled = true;
      if (statusEl) { statusEl.textContent = "Running…"; statusEl.style.color = "var(--muted)"; }
      setStatus(`Running manual trigger "${node.label}"…`);
      try {
        await triggerManualNode(node.id);
        const doneEl = document.getElementById("manualTriggerStatus");
        if (doneEl) { doneEl.textContent = "Trigger executed successfully."; doneEl.style.color = "var(--success, #4caf50)"; }
      } catch (err) {
        const doneEl = document.getElementById("manualTriggerStatus");
        if (doneEl) { doneEl.textContent = err.message || String(err); doneEl.style.color = "var(--danger)"; }
      } finally {
        const doneBtn = document.getElementById("btnRunManualNode");
        if (doneBtn) doneBtn.disabled = false;
      }
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
    for (const button of document.querySelectorAll("[data-trigger-path-insert]")) {
      button.addEventListener("click", () => {
        const prefix = button.getAttribute("data-trigger-path-insert");
        const value = button.getAttribute("data-trigger-path-value") || "";
        const input = prefix ? document.getElementById(`cfg_${prefix}_value`) : null;
        if (!input) return;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        if (typeof input.setSelectionRange === "function") {
          input.setSelectionRange(value.length, value.length);
        }
      });
    }

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

  // NOX nodes: re-render inspector when scope/match_by change so the right
  // sub-fields (input vs area) appear.
  if (node.type === "trigger.nox_input_changed") {
    document.getElementById("cfg_match_by")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }
  if (node.type === "trigger.nox_alarm_changed") {
    document.getElementById("cfg_scope")?.addEventListener("change", () => {
      applyNodeInspector(node);
      renderInspector();
    });
  }
  if (["trigger.nox_input_changed", "trigger.nox_alarm_changed", "trigger.nox_area_changed",
       "action.nox_set_area_state", "action.nox_arm_area", "action.nox_disarm_area"].includes(node.type)) {
    ["cfg_nox_input", "cfg_area_id", "cfg_command"].forEach(id => {
      document.getElementById(id)?.addEventListener("change", () => {
        applyNodeInspector(node);
        renderCanvas();
      });
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

  if (node.type === "action.record" || node.type === "action.stop_recording") {
    document.getElementById("btnAddRecordDevice")?.addEventListener("click", () => {
      const entries = recordDeviceEntries(node.config);
      entries.push("");
      node.config.device_ids = entries;
      delete node.config.device_id;
      markDirty();
      renderInspector();
    });

    document.querySelectorAll(".recordDeviceRemove").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        const entries = recordDeviceEntries(node.config);
        entries.splice(idx, 1);
        node.config.device_ids = entries;
        delete node.config.device_id;
        markDirty();
        renderInspector();
        renderCanvas();
      });
    });

    document.querySelectorAll(".recordDeviceSelect").forEach(sel => {
      sel.addEventListener("change", () => {
        applyNodeInspector(node);
        renderCanvas();
      });
    });
  }

  if (node.type === "action.contribute" || node.type === "action.submit_event") {
    document.getElementById("btnAddSnapshotDevice")?.addEventListener("click", () => {
      if (!node.config.snapshot_entries) node.config.snapshot_entries = [];
      node.config.snapshot_entries.push({ device_id: "" });
      markDirty();
      renderInspector();
    });

    document.querySelectorAll(".snapshotDeviceRemove").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.index, 10);
        node.config.snapshot_entries.splice(idx, 1);
        markDirty();
        renderInspector();
      });
    });

    document.querySelectorAll(".snapshotDeviceSelect").forEach(sel => {
      sel.addEventListener("change", () => {
        const idx = parseInt(sel.dataset.index, 10);
        if (node.config.snapshot_entries[idx]) {
          node.config.snapshot_entries[idx].device_id = sel.value;
        }
        markDirty();
        renderCanvas();
      });
    });
  }

  if (node.type === "action.fire" || node.type === "action.flush" || node.type === "action.contribute") {
    document.getElementById("cfg_target_id")?.addEventListener("change", () => {
      applyNodeInspector(node);
      markDirty();
      renderCanvas();
      drawEdges();
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
      set("transition");
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
      set("changed_to");
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
    case "trigger.speaker_audio_played":
      set("name");
      set("speaker_id");
      set("audio_type");
      break;
    case "trigger.nox_input_changed":
      set("name");
      set("match_by");
      {
        const inputSel = document.getElementById("cfg_nox_input");
        if (inputSel) {
          const { module, input } = noxSplitInputValue(inputSel.value);
          cfg.module = module;
          cfg.input = input;
        }
        const tioEl = document.getElementById("cfg_tio_id");
        if (tioEl) cfg.tio_id = tioEl.value;
      }
      break;
    case "trigger.nox_alarm_changed":
      set("name");
      set("scope");
      set("alarm_state");
      {
        const inputSel = document.getElementById("cfg_nox_input");
        if (inputSel) {
          const { module, input } = noxSplitInputValue(inputSel.value);
          cfg.module = module;
          cfg.input = input;
        }
        const areaSel = document.getElementById("cfg_area_id");
        if (areaSel) cfg.area_id = areaSel.value;
      }
      break;
    case "trigger.nox_area_changed":
      set("name");
      set("area_id");
      set("state");
      break;
    case "action.nox_set_area_state":
    case "action.nox_arm_area":
    case "action.nox_disarm_area":
      set("name");
      set("area_id");
      set("command");
      // Auto-migrate legacy types to the unified node so they stop accumulating.
      if (node.type !== "action.nox_set_area_state") {
        node.type = "action.nox_set_area_state";
      }
      break;
    case "action.nox_ack_alarms":
      set("name");
      break;
    case "action.nox_tio_send":
      set("name");
      set("message");
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
    case "trigger.door":
      set("name");
      break;
    case "action.record":
      set("preset_name");
      set("before_seconds");
      set("max_duration_seconds");
      set("record_variants");
      {
        const selects = document.querySelectorAll(".recordDeviceSelect");
        if (selects.length) {
          cfg.device_ids = Array.from(selects).map((sel) => String(sel.value || "").trim());
        } else if (!Array.isArray(cfg.device_ids)) {
          cfg.device_ids = recordDeviceEntries(cfg);
        }
        delete cfg.device_id;
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
      {
        const selects = document.querySelectorAll(".recordDeviceSelect");
        if (selects.length) {
          cfg.device_ids = Array.from(selects).map((sel) => String(sel.value || "").trim());
        } else if (!Array.isArray(cfg.device_ids)) {
          cfg.device_ids = recordDeviceEntries(cfg);
        }
        delete cfg.device_id;
      }
      break;
    case "action.log_message":
      set("name");
      set("message");
      break;
    case "action.contribute":
      set("name");
      set("target_id");
      cfg.snapshot_entries = Array.from(document.querySelectorAll(".snapshotDeviceRow")).map(row => {
        const sel = row.querySelector(".snapshotDeviceSelect");
        return { device_id: sel ? sel.value : "" };
      }).filter(e => e.device_id);
      break;
    case "action.fire":
      set("name");
      set("target_id");
      break;
    case "action.flush":
      set("name");
      set("target_id");
      break;
    case "action.submit_event":
      set("name");
      set("event_name");
      set("priority");
      set("details");
      cfg.snapshot_entries = Array.from(document.querySelectorAll(".snapshotDeviceRow")).map(row => {
        const sel = row.querySelector(".snapshotDeviceSelect");
        return { device_id: sel ? sel.value : "" };
      }).filter(e => e.device_id);
      break;
    case "action.play_audio":
      set("name");
      set("speaker_id");
      set("clip_filename");
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
    cfg.before_seconds = Math.max(0, Number(cfg.before_seconds ?? 10) || 0);
    const cap = Math.max(1, Number(state.recordingLimits?.trigger_max_duration_seconds || 1800));
    let maxDur = Math.floor(Number(cfg.max_duration_seconds ?? 0) || 0);
    if (maxDur < 1) maxDur = Math.min(60, cap);
    if (maxDur > cap) maxDur = cap;
    cfg.max_duration_seconds = maxDur;
    // Reflect the clamped value in the input. Skip while it's focused so the
    // user can finish typing without the field snapping mid-keystroke; the
    // value lands on blur via the change event.
    const maxDurInput = document.getElementById("cfg_max_duration_seconds");
    if (maxDurInput && document.activeElement !== maxDurInput) {
      maxDurInput.value = String(maxDur);
    }
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
  state.speakers = Array.isArray(catalog?.speakers) ? catalog.speakers : [];
  state.audioClips = Array.isArray(catalog?.audio_clips) ? catalog.audio_clips : [];
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
  el("scenarioSearch")?.addEventListener("input", renderScenarioSidebar);
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
      startPanX: state.panX,
      startPanY: state.panY,
      moved: false,
    };

    boardScroller.classList.add("panning");
    ev.preventDefault();
  });

  boardScroller?.addEventListener("dragover", (ev) => {
    if (!state.paletteDrag) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    boardScroller.classList.add("drop-target-active");
  });

  boardScroller?.addEventListener("dragleave", (ev) => {
    if (!boardScroller.contains(ev.relatedTarget)) {
      boardScroller.classList.remove("drop-target-active");
    }
  });

  boardScroller?.addEventListener("drop", (ev) => {
    ev.preventDefault();
    boardScroller.classList.remove("drop-target-active");
    const type = state.paletteDrag;
    state.paletteDrag = null;
    if (!type) return;

    const flow = currentFlow();
    const def = nodeDef(type);
    if (!flow || !def) return;

    const rect = el("flowBoard")?.getBoundingClientRect();
    if (!rect) return;

    const x = (ev.clientX - rect.left) / state.zoom;
    const y = (ev.clientY - rect.top) / state.zoom;

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
    state.selectedPaletteType = null;
    markDirty();
    renderAll();
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

  window.addEventListener("resize", drawEdges);

  /* ── Zoom ─────────────────────────────────────────── */
  el("flowBoardScroller")?.addEventListener("wheel", (ev) => {
    ev.preventDefault();

    if (ev.ctrlKey || ev.metaKey) {
      /* Pinch / Ctrl+wheel → zoom */
      const raw = -ev.deltaY * (ev.deltaMode === 1 ? 20 : 1);
      const delta = raw * 0.004 * state.zoom;
      _zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom + delta));
      applyZoom(_zoomTarget, ev);
    } else {
      /* Regular scroll / two-finger pan */
      const dx = ev.deltaX * (ev.deltaMode === 1 ? 20 : 1);
      const dy = ev.deltaY * (ev.deltaMode === 1 ? 20 : 1);
      state.panX -= dx;
      state.panY -= dy;
      applyTransform();
      drawEdges();
      saveViewportDebounced();
    }
  }, { passive: false });

  document.getElementById("zoomIn")?.addEventListener("click", () => {
    _zoomTarget = Math.min(ZOOM_MAX, state.zoom + 0.15);
    if (!_zoomRaf) _zoomRaf = requestAnimationFrame(_tickZoom);
  });
  document.getElementById("zoomOut")?.addEventListener("click", () => {
    _zoomTarget = Math.max(ZOOM_MIN, state.zoom - 0.15);
    if (!_zoomRaf) _zoomRaf = requestAnimationFrame(_tickZoom);
  });
  document.getElementById("zoomReset")?.addEventListener("click", () => zoomToFit());

  window.addEventListener("beforeunload", (ev) => {
    saveViewport();
    if (!state.dirty && !state.publicVariablesDirty && !state.schedulesDirty) return;
    ev.preventDefault();
    ev.returnValue = "";
  });

  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== "d") return;
    if (state.selectedScheduleIndex != null || state.selectedPublicVariableIndex != null || state.selectedRecordingPresetIndex != null) return;

    const target = ev.target;
    if (target instanceof HTMLElement) {
      if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        return;
      }
    }

    if (!state.selectedNodeId) return;
    if (!currentFlow()?.nodes.some((item) => item.id === state.selectedNodeId)) return;

    ev.preventDefault();
    duplicateNodeById(state.selectedNodeId);
  });

  window.addEventListener("mousemove", (ev) => {
    if (state.scheduleDrag) {
      updateScheduleDrag(ev);
      return;
    }

    if (state.pan) {
      const dx = ev.clientX - state.pan.startX;
      const dy = ev.clientY - state.pan.startY;

      state.panX = state.pan.startPanX + dx;
      state.panY = state.pan.startPanY + dy;
      applyTransform();

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        state.pan.moved = true;
      }

      drawEdges();
      saveViewportDebounced();
      return;
    }

    if (state.connecting) {
      const board = el("flowBoard");
      if (board) {
        const rect = board.getBoundingClientRect();
        state.connectionCursor = {
          x: (ev.clientX - rect.left) / state.zoom,
          y: (ev.clientY - rect.top) / state.zoom,
        };
        drawEdges();
      }
    }

    if (!state.drag) return;

    const flow = currentFlow();
    const node = flow?.nodes.find((item) => item.id === state.drag.nodeId);
    if (!node) return;

    const dx = (ev.clientX - state.drag.startX) / state.zoom;
    const dy = (ev.clientY - state.drag.startY) / state.zoom;
    node.x = state.drag.originX + dx;
    node.y = state.drag.originY + dy;

    markDirty();
    renderCanvas();
  });
}

async function init() {
  loadSidebarSectionState();
  bindGlobalEvents();
  _zoomTarget = state.zoom;
  applyZoom(state.zoom);

  try {
    console.log("[init] starting catalog fetch");
    const catalog = await api("/api/flows/catalog");
    state.catalog = catalog;
    state.devices = Array.isArray(catalog?.devices) ? catalog.devices : [];
    state.speakers = Array.isArray(catalog?.speakers) ? catalog.speakers : [];
    state.audioClips = Array.isArray(catalog?.audio_clips) ? catalog.audio_clips : [];
    console.log("[init] catalog loaded, nodes:", catalog?.nodes?.length, "devices:", state.devices.length);

    await loadScenarios();
    console.log("[init] scenarios loaded:", _scenariosCache.length);
    await refreshFlows();
    console.log("[init] flows loaded:", state.flows.length);
    await refreshRecordingPresets(true);
    await refreshSchedules(true);
    await refreshPublicVariables(true);
    await refreshPhysicalState(true);
    startSchedulesPolling();
    startPublicVariablesPolling();
    startPhysicalStatePolling();
    console.log("[init] rendering sidebars");
    renderScenarioSidebar();

    state.draft = state.flows.length ? deepClone(state.flows[0]) : starterFlow();
    state.selectedSavedFlowId = state.draft.id || null;
    console.log("[init] draft set, flow:", state.draft?.name);

    clearDirty();
    clearSchedulesDirty();
    clearPublicVariablesDirty();
    clearTestResult();
    console.log("[init] rendering palette + all");
    renderPalette();
    renderAll();
    window.requestAnimationFrame(restoreOrFitViewport);
    console.log("[init] complete");
  } catch (err) {
    console.error("[init] ERROR:", err);
    setStatus(err.message || String(err), true);
    if (el("inspectorBody")) {
      el("inspectorBody").innerHTML = `<div class="emptyState">Failed to load flows UI: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }
}

init();
