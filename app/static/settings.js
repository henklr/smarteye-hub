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

// ── SmartEye Dashboard registration ──────────────────────────────────────────

const dashboardBackendUrlEl   = document.getElementById("dashboardBackendUrl");
const dashboardKeyEl          = document.getElementById("dashboardKey");
const dashboardMacAddressEl   = document.getElementById("dashboardMacAddress");
const dashboardConnectBtn     = document.getElementById("dashboardConnectBtn");
const dashboardUnregisterBtn  = document.getElementById("dashboardUnregisterBtn");
const dashboardStatusEl       = document.getElementById("dashboardStatus");

function setDashboardStatus(text, isError) {
  if (!dashboardStatusEl) return;
  dashboardStatusEl.textContent = text;
  dashboardStatusEl.style.color = isError ? "var(--clr-danger, #e74c3c)" : "";
}

function applyDashboardStatus(data) {
  if (!data) return;
  if (dashboardMacAddressEl) {
    dashboardMacAddressEl.textContent = data.mac_address || "—";
  }
  if (dashboardBackendUrlEl) {
    if (data.backend_url) {
      dashboardBackendUrlEl.value = data.backend_url;
    } else if (!dashboardBackendUrlEl.value) {
      dashboardBackendUrlEl.value = data.default_backend_url || "https://dashboard.smarteye.dk";
    }
  }
  if (dashboardUnregisterBtn) {
    dashboardUnregisterBtn.style.display = data.registered ? "" : "none";
  }
  if (dashboardConnectBtn) {
    dashboardConnectBtn.textContent = data.registered ? "Re-connect with new key" : "Connect to dashboard";
  }
  if (data.registered) {
    setDashboardStatus(
      data.running
        ? `Registered at ${data.backend_url} — streaming.`
        : `Registered at ${data.backend_url} — reconnecting…`,
      false
    );
  } else {
    setDashboardStatus("Not registered. Enter the dashboard URL and registration key.", false);
  }
}

async function loadDashboardStatus() {
  try {
    const data = await api("/api/dashboard/status", { method: "GET" });
    applyDashboardStatus(data);
  } catch (e) {
    setDashboardStatus(`Error: ${String(e.message || e)}`, true);
  }
}

dashboardConnectBtn?.addEventListener("click", async () => {
  const backend_url = (dashboardBackendUrlEl?.value || "").trim();
  const key = (dashboardKeyEl?.value || "").trim();
  if (!backend_url) { setDashboardStatus("Dashboard URL is required.", true); return; }
  if (!key) { setDashboardStatus("Registration key is required.", true); return; }

  dashboardConnectBtn.disabled = true;
  setDashboardStatus("Registering…", false);
  try {
    const data = await api("/api/dashboard/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend_url, key }),
    });
    if (dashboardKeyEl) dashboardKeyEl.value = "";
    applyDashboardStatus(data);
    // Give the connector a moment to come up before refreshing.
    setTimeout(loadDashboardStatus, 1500);
  } catch (e) {
    setDashboardStatus(`Error: ${String(e.message || e)}`, true);
  } finally {
    dashboardConnectBtn.disabled = false;
  }
});

dashboardUnregisterBtn?.addEventListener("click", async () => {
  if (!confirm("Disconnect this device from the SmartEye Dashboard? The administrator will need to issue a new registration key to reconnect.")) {
    return;
  }
  dashboardUnregisterBtn.disabled = true;
  try {
    const data = await api("/api/dashboard/unregister", { method: "POST" });
    applyDashboardStatus(data);
  } catch (e) {
    setDashboardStatus(`Error: ${String(e.message || e)}`, true);
  } finally {
    dashboardUnregisterBtn.disabled = false;
  }
});

loadDashboardStatus();
// Auto-refresh status periodically so the user sees live connector state.
setInterval(loadDashboardStatus, 10000);

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

const recordingPathSelect = document.getElementById("recordingPathSelect");
const recordingPathSaveBtn = document.getElementById("recordingPathSaveBtn");
const recordingPathWarning = document.getElementById("recordingPathWarning");
const recordingPathStatusEl = document.getElementById("recordingPathStatus");

const _RECORDING_SUBDIR = "/recordings";

function setRecordingPathStatus(text, isError) {
  if (!recordingPathStatusEl) return;
  recordingPathStatusEl.textContent = text;
  recordingPathStatusEl.style.color = isError ? "var(--clr-danger, #e74c3c)" : "";
}

function _updateRecordingPathWarning(path) {
  if (recordingPathWarning) {
    recordingPathWarning.style.display = path ? "none" : "block";
  }
}

async function _populateDriveDropdown(currentPath) {
  if (!recordingPathSelect) return;
  // Keep the "None" option, clear the rest
  recordingPathSelect.innerHTML = '<option value="">None (recordings disabled)</option>';
  try {
    const data = await api("/api/storage/devices");
    for (const dev of data.devices || []) {
      const model = dev.model || dev.name;
      for (const p of dev.partitions) {
        if (!p.mountpoint) continue;
        const recPath = p.mountpoint + _RECORDING_SUBDIR;
        const size = _formatSize(p.size);
        const opt = document.createElement("option");
        opt.value = recPath;
        opt.textContent = `${model} — ${p.mountpoint} (${size})`;
        if (recPath === currentPath) opt.selected = true;
        recordingPathSelect.appendChild(opt);
      }
    }
  } catch {}
  // If current path isn't "" and wasn't matched, add it as a custom entry
  if (currentPath && !recordingPathSelect.value) {
    const opt = document.createElement("option");
    opt.value = currentPath;
    opt.textContent = currentPath;
    opt.selected = true;
    recordingPathSelect.appendChild(opt);
  }
  _updateRecordingPathWarning(recordingPathSelect.value);
}

async function loadRetention() {
  try {
    const data = await api("/api/settings/retention");
    if (retentionDaysInput) retentionDaysInput.value = data.retention_days || 0;
    await _populateDriveDropdown(data.recording_path || "");
  } catch (e) {
    setRetentionStatus(`Error: ${e.message || e}`);
  }
}

recordingPathSaveBtn?.addEventListener("click", async () => {
  const path = recordingPathSelect?.value || "";
  recordingPathSaveBtn.disabled = true;
  setRecordingPathStatus("Saving…", false);
  try {
    await api("/api/settings/recording-path", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recording_path: path }),
    });
    _updateRecordingPathWarning(path);
    setRecordingPathStatus(path ? `Recordings will be stored on ${path}` : "Storage cleared — recordings disabled.", !path);
  } catch (e) {
    setRecordingPathStatus(`Error: ${e.message || e}`, true);
  } finally {
    recordingPathSaveBtn.disabled = false;
  }
});

recordingPathSelect?.addEventListener("change", () => {
  _updateRecordingPathWarning(recordingPathSelect.value);
});

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

const clearRecordingsBtn = document.getElementById("clearRecordingsBtn");
const clearRecordingsStatus = document.getElementById("clearRecordingsStatus");
function setClearRecordingsStatus(msg) {
  if (clearRecordingsStatus) clearRecordingsStatus.textContent = msg || "";
}
clearRecordingsBtn?.addEventListener("click", async () => {
  if (!window.confirm("Delete ALL recordings, clips, and timeline markers? This cannot be undone.")) return;
  clearRecordingsBtn.disabled = true;
  setClearRecordingsStatus("Deleting…");
  try {
    const result = await api("/api/playback/recordings", { method: "DELETE" });
    const count = result?.cleared_events ?? 0;
    setClearRecordingsStatus(`Deleted. ${count} marker${count === 1 ? "" : "s"} cleared. Recording resumed.`);
  } catch (e) {
    setClearRecordingsStatus(`Error: ${String(e.message || e)}`);
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

// ── Storage (NVMe) ────────────────────────────────────────────────────────────

const storageContent = document.getElementById("storageContent");
const storageStatusEl = document.getElementById("storageStatus");
const storageRefreshBtn = document.getElementById("storageRefreshBtn");

function setStorageStatus(text, isError, spinning) {
  if (!storageStatusEl) return;
  const spin = spinning ? '<span class="storageSpinner"></span> ' : '';
  storageStatusEl.innerHTML = spin + text;
  storageStatusEl.style.color = isError ? "var(--clr-danger, #e74c3c)" : "";
}

function _formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function _renderStorageDevices(devices) {
  if (!storageContent) return;
  if (!devices.length) {
    storageContent.innerHTML = '<span class="muted">No NVMe drives detected.</span>';
    return;
  }

  let html = "";
  for (const dev of devices) {
    const model = dev.model || dev.name;
    const size = _formatSize(dev.size);
    html += `<div style="border:1px solid var(--clr-border, #333);border-radius:8px;padding:14px;margin-bottom:12px;">`;
    html += `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">`;
    html += `<div><strong>${model}</strong> <span class="muted">(${dev.name}, ${size})</span></div>`;
    html += `</div>`;

    if (dev.partitions.length) {
      html += `<div style="margin-top:10px;">`;
      for (const p of dev.partitions) {
        const pSize = _formatSize(p.size);
        const fs = p.fstype || "unformatted";
        const mp = p.mountpoint;
        html += `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px;">`;
        html += `<span>/dev/${p.name}</span>`;
        html += `<span class="muted">${pSize}, ${fs}</span>`;
        if (mp) {
          html += `<span style="color:var(--clr-ok, #27ae60);">mounted at ${mp}</span>`;
          html += `<button class="btn btn-mini" onclick="_storageUnmount('${mp}')">Unmount</button>`;
        } else {
          html += `<span class="muted">not mounted</span>`;
          html += `<button class="btn btn-mini" onclick="_storageMount('${p.name}')">Mount</button>`;
        }
        html += `</div>`;
        if (mp && p.fsused != null && p.fsavail != null) {
          const total = p.fsused + p.fsavail;
          const pct = total > 0 ? Math.round((p.fsused / total) * 100) : 0;
          const usedStr = _formatSize(p.fsused);
          const availStr = _formatSize(p.fsavail);
          const barColor = pct > 90 ? 'var(--clr-danger, #e74c3c)' : pct > 70 ? '#f39c12' : 'var(--clr-ok, #27ae60)';
          html += `<div style="margin-top:6px;max-width:400px;">`;
          html += `<div style="display:flex;justify-content:space-between;font-size:0.85em;margin-bottom:3px;">`;
          html += `<span>${usedStr} used</span><span>${availStr} free</span>`;
          html += `</div>`;
          html += `<div style="height:8px;background:var(--clr-border, #333);border-radius:4px;overflow:hidden;">`;
          html += `<div style="height:100%;width:${pct}%;background:${barColor};border-radius:4px;transition:width .3s;"></div>`;
          html += `</div>`;
          html += `<div class="muted" style="font-size:0.8em;margin-top:2px;">${pct}% used</div>`;
          html += `</div>`;
        }
      }
      html += `</div>`;
    } else {
      html += `<div class="muted" style="margin-top:8px;">No partitions. Format this drive to use it.</div>`;
    }

    html += `<div style="margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">`;
    html += `<label style="margin:0;">Mount path:</label>`;
    html += `<input type="text" id="mountPath_${dev.name}" value="/mnt/nvme" style="width:160px;" />`;
    html += `<button class="btn btn-danger btn-mini" onclick="_storageFormat('${dev.name}')">Format &amp; mount</button>`;
    html += `</div>`;

    html += `</div>`;
  }
  storageContent.innerHTML = html;
}

async function loadStorageDevices() {
  if (storageContent) storageContent.innerHTML = '<span class="muted"><span class="storageSpinner"></span> Scanning for drives…</span>';
  setStorageStatus("", false);
  try {
    const data = await api("/api/storage/devices");
    _renderStorageDevices(data.devices || []);
  } catch (e) {
    if (storageContent) storageContent.innerHTML = '<span class="muted">Error loading storage info.</span>';
    setStorageStatus(`Error: ${e.message || e}`, true);
  }
}

window._storageFormat = async function(device) {
  const mountInput = document.getElementById("mountPath_" + device);
  const mountPath = (mountInput?.value || "/mnt/nvme").trim();
  if (!confirm(`Format /dev/${device}? This will ERASE ALL DATA on the drive and create a single ext4 partition mounted at ${mountPath}.`)) return;
  setStorageStatus("Formatting… this may take a moment", false, true);
  try {
    await api("/api/storage/format", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device, mount_path: mountPath }),
    });
    setStorageStatus("Drive formatted and mounted successfully.", false);
    await loadStorageDevices();
  } catch (e) {
    setStorageStatus(`Error: ${e.message || e}`, true);
  }
};

window._storageMount = async function(partition) {
  const devName = partition.replace(/p\d+$/, "");
  const mountInput = document.getElementById("mountPath_" + devName);
  const mountPath = (mountInput?.value || "/mnt/nvme").trim();
  setStorageStatus("Mounting…", false, true);
  try {
    await api("/api/storage/mount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partition, mount_path: mountPath }),
    });
    setStorageStatus("Partition mounted.", false);
    await loadStorageDevices();
  } catch (e) {
    setStorageStatus(`Error: ${e.message || e}`, true);
  }
};

window._storageUnmount = async function(mountPath) {
  if (!confirm(`Unmount ${mountPath}?`)) return;
  setStorageStatus("Unmounting…", false, true);
  try {
    await api("/api/storage/unmount", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mount_path: mountPath }),
    });
    setStorageStatus("Partition unmounted.", false);
    await loadStorageDevices();
  } catch (e) {
    setStorageStatus(`Error: ${e.message || e}`, true);
  }
};

storageRefreshBtn?.addEventListener("click", loadStorageDevices);

loadStorageDevices();

// ── Cameras ───────────────────────────────────────────────────────────────────

const cameraListEl              = document.getElementById("cameraList");
const cameraFormEl              = document.getElementById("cameraForm");
const cameraNameEl              = document.getElementById("cameraName");
const cameraIpEl                = document.getElementById("cameraIp");
const cameraOnvifPortEl         = document.getElementById("cameraOnvifPort");
const cameraUsernameEl          = document.getElementById("cameraUsername");
const cameraPasswordEl          = document.getElementById("cameraPassword");
const cameraProfileSel          = document.getElementById("cameraProfile");
const cameraRecordingProfileSel = document.getElementById("cameraRecordingProfile");
const cameraFetchProfilesBtn    = document.getElementById("cameraFetchProfilesBtn");
const addCameraBtn              = document.getElementById("addCameraBtn");
const saveCameraBtn             = document.getElementById("saveCameraBtn");
const cancelCameraBtn           = document.getElementById("cancelCameraBtn");
const cameraStatusEl            = document.getElementById("cameraStatus");

let _editingCameraId = null;
let _lastCameraProfiles = [];
let _camerasCache = [];

function setCameraStatus(text) {
  if (cameraStatusEl) cameraStatusEl.textContent = text || "";
}

function _profileLabel(p) {
  const parts = [];
  if (p.name) parts.push(p.name);
  if (p.encoding) parts.push(String(p.encoding));
  if (p.width && p.height) parts.push(`${p.width}x${p.height}`);
  if (p.recommended) parts.push("recommended");
  else if (p.browser_compatible === false) parts.push("not browser-safe");
  return parts.length ? parts.join(" • ") : p.token;
}

function _setProfileSelect(sel, msg = "Fetch profiles first…") {
  if (!sel) return;
  sel.disabled = true;
  sel.innerHTML = `<option>${escapeH(msg)}</option>`;
}

function renderCameraList(cameras) {
  if (!cameraListEl) return;
  if (!cameras.length) {
    cameraListEl.innerHTML = '<span class="muted">No cameras configured.</span>';
    return;
  }
  cameraListEl.innerHTML = cameras.map((d) => {
    const ready = !!d.profile_token;
    const badge = ready ? "READY" : "SETUP";
    const sub = [d.ip, d.profile_label || d.profile_token || "no profile"].filter(Boolean).join(" · ");
    return `
      <div class="settingsListRow" style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--clr-border, #333);">
        <div style="min-width:0;">
          <strong>${escapeH(d.name || d.ip || d.id)}</strong>
          <span class="muted" style="margin-left:8px;font-size:11px;">${escapeH(badge)}</span>
          <div class="muted" style="margin-top:2px;font-size:12px;">${escapeH(sub)}</div>
        </div>
        <div style="display:flex;gap:6px;flex:0 0 auto;">
          <button class="btn btn-mini" onclick="window._editCamera('${escapeH(d.id)}')">Edit</button>
          <button class="btn btn-mini btn-danger" onclick="window._deleteCamera('${escapeH(d.id)}')">Delete</button>
        </div>
      </div>
    `;
  }).join("");
}

async function loadCameras() {
  try {
    const data = await api("/api/devices");
    _camerasCache = Array.isArray(data?.devices) ? data.devices : [];
    renderCameraList(_camerasCache);
  } catch (e) {
    setCameraStatus(`Error: ${e.message || e}`);
  }
}

function showCameraForm(camera) {
  _editingCameraId = camera ? camera.id : null;
  _lastCameraProfiles = [];
  if (cameraNameEl)        cameraNameEl.value        = camera?.name        || "";
  if (cameraIpEl)          cameraIpEl.value          = camera?.ip          || "";
  if (cameraOnvifPortEl)   cameraOnvifPortEl.value   = camera?.onvif_port  || "80";
  if (cameraUsernameEl)    cameraUsernameEl.value    = camera?.username    || "";
  if (cameraPasswordEl)    cameraPasswordEl.value    = "";
  _setProfileSelect(cameraProfileSel);
  _setProfileSelect(cameraRecordingProfileSel);
  if (cameraFormEl) cameraFormEl.style.display = "";
  setCameraStatus(camera ? "Editing camera. Re-enter password and re-fetch profiles to change them." : "Fill details, then Fetch profiles before saving.");
}

function hideCameraForm() {
  _editingCameraId = null;
  _lastCameraProfiles = [];
  if (cameraFormEl) cameraFormEl.style.display = "none";
  setCameraStatus("");
}

function _readCameraCreds() {
  const ip = (cameraIpEl?.value || "").trim();
  const onvif_port = parseInt((cameraOnvifPortEl?.value || "80").trim(), 10);
  const username = (cameraUsernameEl?.value || "").trim();
  const password = cameraPasswordEl?.value || "";
  if (!ip) throw new Error("IP is required.");
  if (!username) throw new Error("Username is required.");
  if (!password) throw new Error("Password is required.");
  if (!Number.isFinite(onvif_port) || onvif_port <= 0) throw new Error("Invalid ONVIF port.");
  return { ip, onvif_port, username, password };
}

async function fetchCameraProfiles() {
  setCameraStatus("Fetching profiles…");
  _setProfileSelect(cameraProfileSel, "Loading…");
  _setProfileSelect(cameraRecordingProfileSel, "Loading…");

  const creds = _readCameraCreds();
  const data = await api("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(creds),
  });
  const profs = data?.profiles || [];
  if (!profs.length) throw new Error("No profiles returned.");

  _lastCameraProfiles = profs;

  const populate = (sel) => {
    sel.innerHTML = "";
    for (const p of profs) {
      const opt = document.createElement("option");
      opt.value = p.token;
      opt.textContent = _profileLabel(p);
      sel.appendChild(opt);
    }
    sel.disabled = false;
  };
  populate(cameraProfileSel);
  populate(cameraRecordingProfileSel);

  if (_editingCameraId) {
    const d = _camerasCache.find((x) => x.id === _editingCameraId);
    if (d?.profile_token) cameraProfileSel.value = d.profile_token;
    if (d?.recording_profile_token) cameraRecordingProfileSel.value = d.recording_profile_token;
  }

  const recommended = profs.find((p) => p.recommended);
  if (recommended && !cameraProfileSel.value) cameraProfileSel.value = recommended.token;

  // Default recording profile to highest resolution if not already set.
  const highestRes = [...profs].sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)))[0];
  if (highestRes && !cameraRecordingProfileSel.value) cameraRecordingProfileSel.value = highestRes.token;

  setCameraStatus(recommended
    ? `Profiles loaded (${profs.length}). Recommended H264 profile selected for live.`
    : `Profiles loaded (${profs.length}), but no browser-safe H264 profile was found.`);
}

addCameraBtn?.addEventListener("click", () => showCameraForm(null));
cancelCameraBtn?.addEventListener("click", hideCameraForm);

cameraFetchProfilesBtn?.addEventListener("click", async () => {
  try {
    await fetchCameraProfiles();
  } catch (e) {
    _setProfileSelect(cameraProfileSel, "Fetch failed");
    _setProfileSelect(cameraRecordingProfileSel, "Fetch failed");
    setCameraStatus(`Error: ${e.message || e}`);
  }
});

saveCameraBtn?.addEventListener("click", async () => {
  try {
    const name = (cameraNameEl?.value || "").trim();
    if (!name) throw new Error("Name is required.");
    const creds = _readCameraCreds();
    const profile_token = cameraProfileSel?.disabled ? null : (cameraProfileSel?.value || null);
    if (!profile_token) throw new Error("Select a live stream profile before saving.");
    const recording_profile_token = cameraRecordingProfileSel?.disabled ? null : (cameraRecordingProfileSel?.value || null);

    const selectedLive = _lastCameraProfiles.find((p) => p.token === profile_token);
    const selectedRec = _lastCameraProfiles.find((p) => p.token === recording_profile_token);
    const profile_label = selectedLive ? _profileLabel(selectedLive) : (cameraProfileSel?.selectedOptions?.[0]?.textContent || profile_token);
    const recording_profile_label = recording_profile_token
      ? (selectedRec ? _profileLabel(selectedRec) : (cameraRecordingProfileSel?.selectedOptions?.[0]?.textContent || recording_profile_token))
      : null;

    const payload = { name, ...creds, profile_token, profile_label, recording_profile_token, recording_profile_label };

    setCameraStatus("Saving…");
    if (_editingCameraId) {
      await api(`/api/devices/${encodeURIComponent(_editingCameraId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await api(`/api/devices/${encodeURIComponent(_editingCameraId)}/refresh-stream`, { method: "POST" });
      setCameraStatus("Camera updated.");
    } else {
      await api("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setCameraStatus("Camera added.");
    }
    hideCameraForm();
    await loadCameras();
  } catch (e) {
    setCameraStatus(`Error: ${e.message || e}`);
  }
});

window._editCamera = function (id) {
  const d = _camerasCache.find((x) => x.id === id);
  if (d) showCameraForm(d);
};

window._deleteCamera = async function (id) {
  const d = _camerasCache.find((x) => x.id === id);
  const label = d?.name || d?.ip || id;
  if (!confirm(`Delete camera "${label}"?`)) return;
  try {
    await api(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (_editingCameraId === id) hideCameraForm();
    await loadCameras();
    setCameraStatus("Camera deleted.");
  } catch (e) {
    setCameraStatus(`Error: ${e.message || e}`);
  }
};

loadCameras();

// ── System load ───────────────────────────────────────────────────────────────

const _loadCpuValueEl = document.getElementById("loadCpuValue");
const _loadCpuBarEl   = document.getElementById("loadCpuBar");
const _loadMemValueEl = document.getElementById("loadMemValue");
const _loadMemBarEl   = document.getElementById("loadMemBar");

function _loadStatusClass(pct) {
  if (!Number.isFinite(pct)) return "";
  if (pct >= 85) return "is-critical";
  if (pct >= 65) return "is-warn";
  return "";
}

function _setLoadBar(barEl, pct) {
  if (!barEl) return;
  const clamped = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  barEl.style.width = `${clamped}%`;
  barEl.classList.remove("is-warn", "is-critical");
  const cls = _loadStatusClass(clamped);
  if (cls) barEl.classList.add(cls);
}

async function refreshSystemLoad() {
  try {
    const data = await api("/api/system/load");
    const cpuFrac = Number(data?.load_pct_1m);
    const cpuPct = Number.isFinite(cpuFrac) ? Math.round(cpuFrac * 100) : null;
    const cpuCount = Number(data?.cpu_count) || null;
    const l1 = Number(data?.load?.["1m"] || 0);
    const l5 = Number(data?.load?.["5m"] || 0);
    const l15 = Number(data?.load?.["15m"] || 0);
    if (_loadCpuValueEl) {
      _loadCpuValueEl.textContent = cpuPct != null
        ? `${cpuPct}%${cpuCount ? ` of ${cpuCount} core${cpuCount === 1 ? "" : "s"}` : ""} · ${l1.toFixed(2)}, ${l5.toFixed(2)}, ${l15.toFixed(2)}`
        : "—";
    }
    _setLoadBar(_loadCpuBarEl, cpuPct ?? 0);

    const memFrac = Number(data?.memory?.used_pct);
    const memPct = Number.isFinite(memFrac) ? Math.round(memFrac * 100) : null;
    const totalKb = Number(data?.memory?.total_kb) || 0;
    const totalGb = totalKb / 1024 / 1024;
    const usedGb = totalGb * (Number.isFinite(memFrac) ? memFrac : 0);
    if (_loadMemValueEl) {
      _loadMemValueEl.textContent = memPct != null
        ? `${memPct}% · ${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB`
        : "—";
    }
    _setLoadBar(_loadMemBarEl, memPct ?? 0);
  } catch (_) {
    if (_loadCpuValueEl) _loadCpuValueEl.textContent = "unavailable";
    if (_loadMemValueEl) _loadMemValueEl.textContent = "unavailable";
  }
}

refreshSystemLoad();
setInterval(refreshSystemLoad, 5000);

// ── AXIS Speakers ─────────────────────────────────────────────────────────────

const speakerListEl      = document.getElementById("speakerList");
const speakerFormEl      = document.getElementById("speakerForm");
const speakerNameEl      = document.getElementById("speakerName");
const speakerIpEl        = document.getElementById("speakerIp");
const speakerUsernameEl  = document.getElementById("speakerUsername");
const speakerPasswordEl  = document.getElementById("speakerPassword");
const addSpeakerBtn      = document.getElementById("addSpeakerBtn");
const saveSpeakerBtn     = document.getElementById("saveSpeakerBtn");
const cancelSpeakerBtn   = document.getElementById("cancelSpeakerBtn");
const speakerStatusEl    = document.getElementById("speakerStatus");

let _editingSpeakerId = null;

function setSpeakerStatus(text) {
  if (speakerStatusEl) speakerStatusEl.textContent = text;
}

function renderSpeakerList(speakers) {
  if (!speakerListEl) return;
  if (!speakers.length) {
    speakerListEl.innerHTML = '<span class="muted">No speakers configured.</span>';
    return;
  }
  speakerListEl.innerHTML = speakers.map(s => `
    <div class="settingsListRow" style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--clr-border, #333);">
      <div>
        <strong>${escapeH(s.name)}</strong>
        <span class="muted" style="margin-left:8px;">${escapeH(s.ip)}</span>
      </div>
      <div style="display:flex;gap:6px;">
        <button class="btn btn-mini" onclick="window._testSpeaker('${escapeH(s.id)}')">Test</button>
        <button class="btn btn-mini" onclick="window._editSpeaker('${escapeH(s.id)}')">Edit</button>
        <button class="btn btn-mini btn-danger" onclick="window._deleteSpeaker('${escapeH(s.id)}')">Delete</button>
      </div>
    </div>
  `).join("");
}

function escapeH(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

async function loadSpeakers() {
  try {
    const data = await api("/api/speakers");
    renderSpeakerList(data.speakers || []);
  } catch (e) {
    setSpeakerStatus(`Error: ${e.message || e}`);
  }
}

function showSpeakerForm(speaker) {
  _editingSpeakerId = speaker ? speaker.id : null;
  if (speakerNameEl)     speakerNameEl.value     = speaker?.name     || "";
  if (speakerIpEl)       speakerIpEl.value       = speaker?.ip       || "";
  if (speakerUsernameEl) speakerUsernameEl.value = speaker?.username || "";
  if (speakerPasswordEl) speakerPasswordEl.value = speaker?.password || "";
  if (speakerFormEl) speakerFormEl.style.display = "";
}

function hideSpeakerForm() {
  _editingSpeakerId = null;
  if (speakerFormEl) speakerFormEl.style.display = "none";
}

addSpeakerBtn?.addEventListener("click", () => showSpeakerForm(null));
cancelSpeakerBtn?.addEventListener("click", hideSpeakerForm);

saveSpeakerBtn?.addEventListener("click", async () => {
  const payload = {
    name:     (speakerNameEl?.value     || "").trim(),
    ip:       (speakerIpEl?.value       || "").trim(),
    username: (speakerUsernameEl?.value || "").trim(),
    password: (speakerPasswordEl?.value || "").trim(),
  };
  if (!payload.name || !payload.ip || !payload.username || !payload.password) {
    setSpeakerStatus("All fields are required.");
    return;
  }
  try {
    if (_editingSpeakerId) {
      await api(`/api/speakers/${_editingSpeakerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSpeakerStatus("Speaker updated.");
    } else {
      await api("/api/speakers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSpeakerStatus("Speaker added.");
    }
    hideSpeakerForm();
    await loadSpeakers();
  } catch (e) {
    setSpeakerStatus(`Error: ${e.message || e}`);
  }
});

window._editSpeaker = async function(id) {
  try {
    const data = await api("/api/speakers");
    const speaker = (data.speakers || []).find(s => s.id === id);
    if (speaker) showSpeakerForm(speaker);
  } catch (e) {
    setSpeakerStatus(`Error: ${e.message || e}`);
  }
};

window._deleteSpeaker = async function(id) {
  if (!confirm("Delete this speaker?")) return;
  try {
    await api(`/api/speakers/${id}`, { method: "DELETE" });
    setSpeakerStatus("Speaker deleted.");
    await loadSpeakers();
  } catch (e) {
    setSpeakerStatus(`Error: ${e.message || e}`);
  }
};

window._testSpeaker = async function(id) {
  setSpeakerStatus("Testing connection…");
  try {
    await api(`/api/speakers/${id}/test`, { method: "POST" });
    setSpeakerStatus("Connection successful.");
  } catch (e) {
    setSpeakerStatus(`Connection failed: ${e.message || e}`);
  }
};

loadSpeakers();

// ── Audio Clips ───────────────────────────────────────────────────────────────

const audioClipListEl   = document.getElementById("audioClipList");
const audioClipUploadEl = document.getElementById("audioClipUpload");
const audioClipStatusEl = document.getElementById("audioClipStatus");

function setAudioClipStatus(text) {
  if (audioClipStatusEl) audioClipStatusEl.textContent = text;
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function renderAudioClipList(clips) {
  if (!audioClipListEl) return;
  if (!clips.length) {
    audioClipListEl.innerHTML = '<span class="muted">No audio clips uploaded.</span>';
    return;
  }
  audioClipListEl.innerHTML = clips.map(c => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--clr-border, #333);">
      <div>
        <strong>${escapeH(c.filename)}</strong>
        <span class="muted" style="margin-left:8px;">${formatBytes(c.size)}</span>
      </div>
      <button class="btn btn-mini btn-danger" onclick="window._deleteAudioClip('${escapeH(c.filename)}')">Delete</button>
    </div>
  `).join("");
}

async function loadAudioClips() {
  try {
    const data = await api("/api/audio-clips");
    renderAudioClipList(data.clips || []);
  } catch (e) {
    setAudioClipStatus(`Error: ${e.message || e}`);
  }
}

audioClipUploadEl?.addEventListener("change", async () => {
  const file = audioClipUploadEl.files?.[0];
  if (!file) return;
  setAudioClipStatus("Uploading…");
  try {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/audio-clips", { method: "POST", body: form });
    if (res.status === 401) { window.location.href = "/login"; return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || res.statusText);
    }
    setAudioClipStatus(`Uploaded: ${file.name}`);
    await loadAudioClips();
  } catch (e) {
    setAudioClipStatus(`Upload failed: ${e.message || e}`);
  } finally {
    audioClipUploadEl.value = "";
  }
});

window._deleteAudioClip = async function(filename) {
  if (!confirm(`Delete audio clip "${filename}"?`)) return;
  try {
    await api(`/api/audio-clips/${encodeURIComponent(filename)}`, { method: "DELETE" });
    setAudioClipStatus("Audio clip deleted.");
    await loadAudioClips();
  } catch (e) {
    setAudioClipStatus(`Error: ${e.message || e}`);
  }
};

loadAudioClips();
