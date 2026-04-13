// settings.js — SmartEye Pi Settings page

/* ── Theme ── */
const themeSelectEl = document.getElementById("themeSelect");

function applyTheme(pref) {
  let resolved = pref;
  if (pref === "system") {
    resolved = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", resolved);
}

function initTheme() {
  const stored = localStorage.getItem("theme") || "dark";
  if (themeSelectEl) themeSelectEl.value = stored;
  applyTheme(stored);

  themeSelectEl?.addEventListener("change", () => {
    const val = themeSelectEl.value;
    localStorage.setItem("theme", val);
    applyTheme(val);
  });

  // Listen for OS theme changes when "system" is selected
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (localStorage.getItem("theme") === "system") {
      applyTheme("system");
    }
  });
}

initTheme();

// ── Change Password ───────────────────────────────────────────────────────────

const currentPasswordEl  = document.getElementById("currentPassword");
const newPasswordEl      = document.getElementById("newPassword");
const confirmPasswordEl  = document.getElementById("confirmPassword");
const changePasswordBtn  = document.getElementById("changePasswordBtn");
const passwordStatusEl   = document.getElementById("passwordStatus");

function setPasswordStatus(text, isError) {
  if (!passwordStatusEl) return;
  passwordStatusEl.textContent = text;
  passwordStatusEl.style.color = isError ? "var(--clr-danger, #e74c3c)" : "";
}

changePasswordBtn?.addEventListener("click", async () => {
  const current = currentPasswordEl?.value || "";
  const newPwd  = newPasswordEl?.value || "";
  const confirm = confirmPasswordEl?.value || "";

  if (!current) { setPasswordStatus("Enter your current password.", true); return; }
  if (!newPwd)  { setPasswordStatus("Enter a new password.", true); return; }
  if (newPwd.length < 4) { setPasswordStatus("New password must be at least 4 characters.", true); return; }
  if (newPwd !== confirm) { setPasswordStatus("New passwords do not match.", true); return; }

  changePasswordBtn.disabled = true;
  setPasswordStatus("Changing password…", false);

  try {
    await api("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: current, new_password: newPwd }),
    });
    setPasswordStatus("Password changed successfully.", false);
    currentPasswordEl.value = "";
    newPasswordEl.value = "";
    confirmPasswordEl.value = "";
  } catch (e) {
    setPasswordStatus(`Error: ${e.message || e}`, true);
  } finally {
    changePasswordBtn.disabled = false;
  }
});

const cloudWsUrlEl   = document.getElementById("cloudWsUrl");
const cloudTokenEl   = document.getElementById("cloudToken");
const cloudDeviceIdEl = document.getElementById("cloudDeviceId");
const cloudSaveBtn   = document.getElementById("cloudSaveBtn");
const cloudConnectBtn = document.getElementById("cloudConnectBtn");
const cloudStatusEl  = document.getElementById("cloudStatus");

async function api(url, opts) {
  const res = await fetch(url, opts);
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

function setCloudStatus(text) {
  if (cloudStatusEl) cloudStatusEl.textContent = text;
}

function readCloudForm() {
  const cloud_ws_url   = (cloudWsUrlEl?.value   || "").trim();
  const cloud_token    = (cloudTokenEl?.value    || "").trim();
  const hub_device_id  = (cloudDeviceIdEl?.value || "").trim();

  if (!cloud_ws_url)  throw new Error("Cloud WebSocket URL is required.");
  if (!cloud_token)   throw new Error("Pairing key is required.");
  if (!hub_device_id) throw new Error("Hub device ID is required.");

  return { cloud_ws_url, cloud_token, hub_device_id };
}

function fillCloudForm(cfg) {
  if (!cfg) return;
  if (cloudWsUrlEl)    cloudWsUrlEl.value    = cfg.cloud_ws_url   || "";
  if (cloudTokenEl)    cloudTokenEl.value    = cfg.cloud_token    || "";
  if (cloudDeviceIdEl) cloudDeviceIdEl.value = cfg.hub_device_id  || "";
}

async function loadCloudConfig() {
  try {
    setCloudStatus("Loading…");
    const data = await api("/api/cloud/config", { method: "GET" });
    fillCloudForm(data);
    setCloudStatus(
      data.running
        ? "Connected — connector is running."
        : "Not connected. Paste pairing key and click Connect."
    );
  } catch (e) {
    setCloudStatus(`Error loading settings: ${String(e.message || e)}`);
  }
}

async function saveCloudConfig() {
  const payload = readCloudForm();
  setCloudStatus("Saving…");
  const data = await api("/api/cloud/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  fillCloudForm(data);
  setCloudStatus(
    data.running
      ? "Saved. Connector already running."
      : "Saved. Click Connect to start the connector."
  );
}

async function connectCloud() {
  const payload = readCloudForm();
  setCloudStatus("Connecting…");
  const data = await api("/api/cloud/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  fillCloudForm(data);
  setCloudStatus(
    data.running
      ? "Connected — connector is running."
      : "Connect requested, waiting for connector to start."
  );
}

cloudSaveBtn?.addEventListener("click", async () => {
  try {
    await saveCloudConfig();
  } catch (e) {
    setCloudStatus(`Error: ${String(e.message || e)}`);
  }
});

cloudConnectBtn?.addEventListener("click", async () => {
  try {
    await connectCloud();
  } catch (e) {
    setCloudStatus(`Error: ${String(e.message || e)}`);
  }
});

loadCloudConfig();

// ── Date & Time ───────────────────────────────────────────────────────────────

const timezoneSelect = document.getElementById("timezoneSelect");
const timezoneSaveBtn = document.getElementById("timezoneSaveBtn");
const manualDatetime = document.getElementById("manualDatetime");
const manualDatetimeSaveBtn = document.getElementById("manualDatetimeSaveBtn");
const browserTimeSyncBtn = document.getElementById("browserTimeSyncBtn");
const ntpServerInput = document.getElementById("ntpServerInput");
const ntpSyncBtn = document.getElementById("ntpSyncBtn");
const currentUtcTimeEl = document.getElementById("currentUtcTime");
const datetimeStatusEl = document.getElementById("datetimeStatus");

function setDatetimeStatus(text) {
  if (datetimeStatusEl) datetimeStatusEl.textContent = text;
}

let _currentTimezone = "UTC";
let _lastUtcEpoch = null;   // ms since epoch when time was last set
let _lastSetAt = null;       // performance.now() when time was last set
let _clockTimer = null;

function _formatLocal(utcEpoch) {
  try {
    const d = new Date(utcEpoch);
    return d.toLocaleString("sv-SE", { timeZone: _currentTimezone }).replace("T", " ");
  } catch {
    return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  }
}

function _renderClock() {
  if (!currentUtcTimeEl || _lastUtcEpoch == null) return;
  const elapsed = performance.now() - _lastSetAt;
  const nowEpoch = _lastUtcEpoch + elapsed;
  const display = _formatLocal(nowEpoch);
  const label = _currentTimezone || "UTC";
  currentUtcTimeEl.textContent = `${display} (${label})`;
}

function updateCurrentTime(utcIso, localStr, tz) {
  if (tz) _currentTimezone = tz;
  _lastUtcEpoch = new Date(utcIso).getTime();
  _lastSetAt = performance.now();
  _renderClock();
  if (!_clockTimer) {
    _clockTimer = setInterval(_renderClock, 1000);
  }
}

async function loadDatetime() {
  try {
    const data = await api("/api/system/datetime");
    updateCurrentTime(data.utc, data.local, data.timezone);
    if (timezoneSelect) {
      const tzData = await api("/api/system/timezones");
      timezoneSelect.innerHTML = "";
      for (const tz of tzData.timezones) {
        const opt = document.createElement("option");
        opt.value = tz;
        opt.textContent = tz;
        if (tz === data.timezone) opt.selected = true;
        timezoneSelect.appendChild(opt);
      }
    }
    const ntpData = await api("/api/system/ntp");
    if (ntpServerInput) ntpServerInput.value = ntpData.ntp_server || "pool.ntp.org";
    if (manualDatetime && data.local) {
      manualDatetime.value = data.local.replace(" ", "T");
    }
  } catch (e) {
    setDatetimeStatus(`Error: ${e.message || e}`);
  }
}

timezoneSaveBtn?.addEventListener("click", async () => {
  const tz = timezoneSelect?.value;
  if (!tz) return;
  timezoneSaveBtn.disabled = true;
  setDatetimeStatus("Setting timezone…");
  try {
    await api("/api/system/timezone", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone: tz }),
    });
    setDatetimeStatus(`Timezone set to ${tz}.`);
    const dtData = await api("/api/system/datetime");
    updateCurrentTime(dtData.utc, dtData.local, dtData.timezone);
  } catch (e) {
    setDatetimeStatus(`Error: ${e.message || e}`);
  } finally {
    timezoneSaveBtn.disabled = false;
  }
});

manualDatetimeSaveBtn?.addEventListener("click", async () => {
  const val = manualDatetime?.value;
  if (!val) { setDatetimeStatus("Enter a date and time."); return; }
  manualDatetimeSaveBtn.disabled = true;
  setDatetimeStatus("Setting date…");
  try {
    const result = await api("/api/system/datetime", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datetime: val }),
    });
    updateCurrentTime(result.utc, result.local, result.timezone);
    setDatetimeStatus("Date and time updated.");
  } catch (e) {
    setDatetimeStatus(`Error: ${e.message || e}`);
  } finally {
    manualDatetimeSaveBtn.disabled = false;
  }
});

browserTimeSyncBtn?.addEventListener("click", async () => {
  browserTimeSyncBtn.disabled = true;
  setDatetimeStatus("Setting time and timezone from browser…");
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (browserTz) {
      try {
        await api("/api/system/timezone", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timezone: browserTz }),
        });
        if (timezoneSelect) {
          for (const opt of timezoneSelect.options) {
            opt.selected = opt.value === browserTz;
          }
        }
      } catch {}
    }
    const now = new Date();
    const isoUtc = now.toISOString();
    const result = await api("/api/system/datetime", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ datetime: isoUtc }),
    });
    updateCurrentTime(result.utc, result.local, result.timezone);
    if (manualDatetime && result.local) manualDatetime.value = result.local.replace(" ", "T");
    setDatetimeStatus(`Clock and timezone set from browser (${browserTz || "time only"}).`);
  } catch (e) {
    setDatetimeStatus(`Error: ${e.message || e}`);
  } finally {
    browserTimeSyncBtn.disabled = false;
  }
});

ntpSyncBtn?.addEventListener("click", async () => {
  const server = (ntpServerInput?.value || "").trim() || "pool.ntp.org";
  ntpSyncBtn.disabled = true;
  setDatetimeStatus(`Syncing with ${server}…`);
  try {
    const result = await api("/api/system/ntp-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server }),
    });
    updateCurrentTime(result.utc, result.local, result.timezone);
    setDatetimeStatus(`Synced with ${result.server}. Time updated.`);
  } catch (e) {
    setDatetimeStatus(`Error: ${e.message || e}`);
  } finally {
    ntpSyncBtn.disabled = false;
  }
});

loadDatetime();

// ── System actions ────────────────────────────────────────────────────────────

const systemStatusEl = document.getElementById("systemStatus");
const clearRecordingsBtn = document.getElementById("clearRecordingsBtn");
const rebootBtn = document.getElementById("rebootBtn");
const retentionDaysInput = document.getElementById("retentionDaysInput");
const retentionSaveBtn = document.getElementById("retentionSaveBtn");
const retentionStatusEl = document.getElementById("retentionStatus");

function setSystemStatus(text) {
  if (systemStatusEl) systemStatusEl.textContent = text;
}

function setRetentionStatus(text) {
  if (retentionStatusEl) retentionStatusEl.textContent = text;
}

async function loadRetention() {
  try {
    const data = await api("/api/settings/retention");
    if (retentionDaysInput) retentionDaysInput.value = data.retention_days || 0;
  } catch (e) {
    setRetentionStatus(`Error: ${e.message || e}`);
  }
}

retentionSaveBtn?.addEventListener("click", async () => {
  const days = parseInt(retentionDaysInput?.value || "0", 10);
  if (isNaN(days) || days < 0) {
    setRetentionStatus("Enter a valid number (0 = disabled).");
    return;
  }
  retentionSaveBtn.disabled = true;
  setRetentionStatus("Saving…");
  try {
    await api("/api/settings/retention", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retention_days: days }),
    });
    setRetentionStatus(days > 0 ? `Saved. Recordings older than ${days} day${days === 1 ? "" : "s"} will be deleted.` : "Saved. Auto-deletion disabled.");
  } catch (e) {
    setRetentionStatus(`Error: ${e.message || e}`);
  } finally {
    retentionSaveBtn.disabled = false;
  }
});

loadRetention();

clearRecordingsBtn?.addEventListener("click", async () => {
  if (!window.confirm("Clear all recordings, generated clips, and playback markers? This cannot be undone.")) return;
  clearRecordingsBtn.disabled = true;
  setSystemStatus("Clearing recordings…");
  try {
    const result = await api("/api/playback/recordings", { method: "DELETE" });
    const count = Number(result?.cleared_events || 0);
    setSystemStatus(`Cleared ${count} marker${count === 1 ? "" : "s"}. Recording files are being removed in the background.`);
  } catch (e) {
    setSystemStatus(`Error: ${String(e.message || e)}`);
  } finally {
    clearRecordingsBtn.disabled = false;
  }
});

rebootBtn?.addEventListener("click", async () => {
  if (!window.confirm("Reboot the system now? All active streams and recordings will stop.")) return;
  rebootBtn.disabled = true;
  setSystemStatus("Rebooting…");
  try {
    await api("/api/system/reboot", { method: "POST" });
    setSystemStatus("Reboot command sent. The system will restart shortly.");
  } catch (e) {
    setSystemStatus(`Error: ${String(e.message || e)}`);
    rebootBtn.disabled = false;
  }
});

const restoreDefaultsBtn = document.getElementById("restoreDefaultsBtn");

restoreDefaultsBtn?.addEventListener("click", async () => {
  if (!window.confirm("Restore all settings to factory defaults?\n\nThis will erase all devices, flows, schedules, recordings, and cloud configuration. This cannot be undone.")) return;
  restoreDefaultsBtn.disabled = true;
  setSystemStatus("Restoring defaults…");
  try {
    const result = await api("/api/system/restore-defaults", { method: "POST" });
    setSystemStatus(result.message || "Defaults restored.");
    if (window.confirm("Defaults restored. Reboot now to apply changes?")) {
      setSystemStatus("Rebooting…");
      await api("/api/system/reboot", { method: "POST" });
      setSystemStatus("Reboot command sent. The system will restart shortly.");
      return;
    }
  } catch (e) {
    setSystemStatus(`Error: ${String(e.message || e)}`);
  } finally {
    restoreDefaultsBtn.disabled = false;
  }
});

// ── System logs ───────────────────────────────────────────────────────────────

const logViewer = document.getElementById("logViewer");
const logRefreshBtn = document.getElementById("logRefreshBtn");
const logClearBtn = document.getElementById("logClearBtn");
const logAutoUpdateBtn = document.getElementById("logAutoUpdateBtn");
const logLevelFilter = document.getElementById("logLevelFilter");
const logCatFilter = document.getElementById("logCatFilter");
const logSearchInput = document.getElementById("logSearchInput");
const logSortOrder = document.getElementById("logSortOrder");

let _logPollTimer = null;
let _logAutoUpdate = true;
let _logRawEntries = [];
let _logKnownCategories = new Set();

function _levelClass(level) {
  switch (level) {
    case "ERROR":
    case "CRITICAL":
      return "logError";
    case "WARNING":
      return "logWarn";
    case "DEBUG":
      return "logDebug";
    default:
      return "";
  }
}

function _applyLogFilters(entries) {
  const levelVal = logLevelFilter?.value || "";
  const catVal = logCatFilter?.value || "";
  const searchVal = (logSearchInput?.value || "").trim().toLowerCase();
  const sortVal = logSortOrder?.value || "newest";

  let filtered = entries;

  if (levelVal) {
    filtered = filtered.filter(e => e.level === levelVal);
  }

  if (catVal) {
    filtered = filtered.filter(e => e.cat === catVal);
  }

  if (searchVal) {
    filtered = filtered.filter(e =>
      (e.message || "").toLowerCase().includes(searchVal) ||
      (e.cat || "").toLowerCase().includes(searchVal)
    );
  }

  if (sortVal === "oldest") {
    filtered = [...filtered];
  } else {
    filtered = [...filtered].reverse();
  }

  return filtered;
}

function _updateCategoryDropdown(categories) {
  if (!logCatFilter) return;
  for (const cat of categories) {
    if (_logKnownCategories.has(cat)) continue;
    _logKnownCategories.add(cat);
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = cat;
    logCatFilter.appendChild(opt);
  }
}

function renderLogs(entries) {
  if (!logViewer) return;
  const filtered = _applyLogFilters(entries);
  const frag = document.createDocumentFragment();
  for (const e of filtered) {
    const line = document.createElement("div");
    line.className = "logLine " + _levelClass(e.level);
    const ts = document.createElement("span");
    ts.className = "logTs";
    ts.textContent = (e.ts || "").replace("T", " ").replace(/\+.*$/, "");
    const cat = document.createElement("span");
    cat.className = "logCat";
    cat.textContent = e.cat || "";
    const lvl = document.createElement("span");
    lvl.className = "logLevel";
    lvl.textContent = e.level;
    const msg = document.createElement("span");
    msg.className = "logMsg";
    msg.textContent = e.message;
    line.appendChild(ts);
    line.appendChild(cat);
    line.appendChild(lvl);
    line.appendChild(msg);
    frag.appendChild(line);
  }
  logViewer.innerHTML = "";
  logViewer.appendChild(frag);
  if (_logAutoUpdate && (logSortOrder?.value || "newest") === "newest") {
    logViewer.scrollTop = 0;
  } else if (_logAutoUpdate) {
    logViewer.scrollTop = logViewer.scrollHeight;
  }
}

async function loadLogs() {
  try {
    const data = await api("/api/system/logs?limit=500");
    _logRawEntries = data.entries || [];
    if (data.categories) _updateCategoryDropdown(data.categories);
    renderLogs(_logRawEntries);
  } catch (e) {
    if (logViewer) logViewer.textContent = "Error loading logs: " + (e.message || e);
  }
}

function _rerender() {
  renderLogs(_logRawEntries);
}

logLevelFilter?.addEventListener("change", _rerender);
logCatFilter?.addEventListener("change", _rerender);
logSearchInput?.addEventListener("input", _rerender);
logSortOrder?.addEventListener("change", _rerender);

logRefreshBtn?.addEventListener("click", loadLogs);

logClearBtn?.addEventListener("click", async () => {
  if (!window.confirm("Clear all buffered log entries?")) return;
  try {
    await api("/api/system/logs/clear", { method: "POST" });
    _logRawEntries = [];
    if (logViewer) logViewer.innerHTML = "";
  } catch (e) {
    if (logViewer) logViewer.textContent = "Error: " + (e.message || e);
  }
});

function _startLogPoll() {
  if (_logPollTimer) return;
  loadLogs();
  _logPollTimer = setInterval(loadLogs, 3000);
}

function _stopLogPoll() {
  if (_logPollTimer) {
    clearInterval(_logPollTimer);
    _logPollTimer = null;
  }
}

function _updateAutoBtn() {
  if (!logAutoUpdateBtn) return;
  logAutoUpdateBtn.textContent = _logAutoUpdate ? "Auto-update: ON" : "Auto-update: OFF";
  logAutoUpdateBtn.classList.toggle("btn-primary", _logAutoUpdate);
}

logAutoUpdateBtn?.addEventListener("click", () => {
  _logAutoUpdate = !_logAutoUpdate;
  _updateAutoBtn();
  if (_logAutoUpdate) {
    _startLogPoll();
  } else {
    _stopLogPoll();
  }
});

_updateAutoBtn();
_startLogPoll();

// ── OpenAI API key ────────────────────────────────────────────────────────────

const openaiKeyInput = document.getElementById("openaiKeyInput");
const openaiKeySaveBtn = document.getElementById("openaiKeySaveBtn");
const openaiKeyStatusEl = document.getElementById("openaiKeyStatus");

function setOpenaiStatus(text) {
  if (openaiKeyStatusEl) openaiKeyStatusEl.textContent = text;
}

async function loadOpenaiKey() {
  try {
    const data = await api("/api/settings/openai-key");
    if (data.configured) {
      setOpenaiStatus(`Key configured: ${data.masked_key}`);
      if (openaiKeyInput) openaiKeyInput.placeholder = data.masked_key;
    } else {
      setOpenaiStatus("No API key configured.");
    }
  } catch (e) {
    setOpenaiStatus(`Error: ${e.message || e}`);
  }
}

openaiKeySaveBtn?.addEventListener("click", async () => {
  const key = (openaiKeyInput?.value || "").trim();
  if (!key) {
    setOpenaiStatus("Enter an API key.");
    return;
  }
  openaiKeySaveBtn.disabled = true;
  setOpenaiStatus("Saving…");
  try {
    await api("/api/settings/openai-key", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (openaiKeyInput) openaiKeyInput.value = "";
    setOpenaiStatus("Key saved. AI analysis is now active.");
    await loadOpenaiKey();
  } catch (e) {
    setOpenaiStatus(`Error: ${e.message || e}`);
  } finally {
    openaiKeySaveBtn.disabled = false;
  }
});

loadOpenaiKey();
