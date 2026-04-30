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

// ── Sidebar navigation: scrollspy + smooth scroll ─────────────────────────────
(function initSettingsNav() {
  const main = document.getElementById("settingsMain");
  const nav = document.getElementById("settingsNav");
  if (!main || !nav) return;

  const links = Array.from(nav.querySelectorAll(".settingsNavRow"));
  const entries = [];
  for (const link of links) {
    const id = link.getAttribute("href")?.slice(1);
    if (!id) continue;
    const section = document.getElementById(id);
    if (section) entries.push({ id, link, section });
  }
  if (!entries.length) return;

  function setActive(id) {
    for (const e of entries) e.link.classList.toggle("active", e.id === id);
  }

  // Pick the scroll container that's actually scrollable (main on desktop,
  // window on small viewports where the page itself scrolls).
  function getScroller() {
    if (main.scrollHeight > main.clientHeight + 1) return main;
    return window;
  }

  function scrollToSection(section) {
    const scroller = getScroller();
    if (scroller === window) {
      const top = section.getBoundingClientRect().top + window.scrollY - 16;
      window.scrollTo({ top, behavior: "smooth" });
    } else {
      const mainRect = main.getBoundingClientRect();
      const top = section.getBoundingClientRect().top - mainRect.top + main.scrollTop - 16;
      main.scrollTo({ top, behavior: "smooth" });
    }
  }

  for (const { id, link, section } of entries) {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      scrollToSection(section);
      history.replaceState(null, "", `#${id}`);
      setActive(id);
    });
  }

  let ticking = false;
  function updateActive() {
    ticking = false;
    const scroller = getScroller();
    const refTop = scroller === window ? 0 : main.getBoundingClientRect().top;
    const probe = 80;
    let currentId = entries[0].id;
    for (const { id, section } of entries) {
      const offset = section.getBoundingClientRect().top - refTop;
      if (offset <= probe) currentId = id;
      else break;
    }
    setActive(currentId);
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateActive);
  }

  main.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });

  const initialHash = window.location.hash.slice(1);
  const initialEntry = entries.find((e) => e.id === initialHash);
  if (initialEntry) {
    requestAnimationFrame(() => {
      scrollToSection(initialEntry.section);
      setActive(initialHash);
    });
  } else {
    updateActive();
  }
})();

loadAudioClips();

// ── NOX integration ──────────────────────────────────────────────────────────

const noxEnabledEl        = document.getElementById("noxEnabled");
const noxModbusEnabledEl  = document.getElementById("noxModbusEnabled");
const noxModbusHostEl     = document.getElementById("noxModbusHost");
const noxModbusPortEl     = document.getElementById("noxModbusPort");
const noxModbusUnitEl     = document.getElementById("noxModbusUnit");
const noxModbusPollEl     = document.getElementById("noxModbusPoll");
const noxTioEnabledEl     = document.getElementById("noxTioEnabled");
const noxTioHostEl        = document.getElementById("noxTioHost");
const noxTioPortEl        = document.getElementById("noxTioPort");
const noxTioSendEnabledEl = document.getElementById("noxTioSendEnabled");
const noxTioSendHostEl    = document.getElementById("noxTioSendHost");
const noxTioSendPortEl    = document.getElementById("noxTioSendPort");
const noxInputsListEl     = document.getElementById("noxInputsList");
const noxInputsEmptyEl    = document.getElementById("noxInputsEmpty");
const noxAddInputBtn      = document.getElementById("noxAddInputBtn");
const noxSaveBtn          = document.getElementById("noxSaveBtn");
const noxRefreshBtn       = document.getElementById("noxRefreshBtn");
const noxStatusEl         = document.getElementById("noxStatus");
const noxStatusBadgeEl    = document.getElementById("noxStatusBadge");

let noxInputsModel = []; // [{module, input, label}]
let noxAreasModel = [];  // [{area_id, label}]
let noxLastState = null;

function noxFlagsSummary(flags) {
  if (!flags) return "—";
  const parts = [];
  if (flags.alarm) parts.push("ALARM");
  if (flags.sabotage) parts.push("sabotage");
  if (flags.deactivated) parts.push("deactivated");
  parts.push(flags.open ? "open" : "closed");
  if (!flags.defined) parts.push("undefined");
  return parts.join(", ");
}

function noxLiveEntryFor(module, input) {
  if (!noxLastState) return null;
  const inputs = noxLastState.modbus?.inputs || [];
  return inputs.find(e => Number(e.module) === Number(module) && Number(e.input) === Number(input)) || null;
}

function renderNoxInputs() {
  if (!noxInputsListEl) return;
  noxInputsListEl.innerHTML = "";

  if (!noxInputsModel.length) {
    if (noxInputsEmptyEl) {
      noxInputsListEl.appendChild(noxInputsEmptyEl);
      noxInputsEmptyEl.style.display = "";
    }
    return;
  }

  noxInputsModel.forEach((row, idx) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:grid;grid-template-columns:90px 70px 1fr 110px 1fr 32px;gap:8px;align-items:center;";

    const moduleEl = document.createElement("input");
    moduleEl.type = "number"; moduleEl.min = "1"; moduleEl.max = "9999";
    moduleEl.value = row.module ?? "";
    moduleEl.placeholder = "1001";
    moduleEl.addEventListener("change", () => { row.module = Number(moduleEl.value) || 0; renderNoxInputs(); });

    const inputEl = document.createElement("input");
    inputEl.type = "number"; inputEl.min = "0"; inputEl.max = "9";
    inputEl.value = row.input ?? "";
    inputEl.placeholder = "1";
    inputEl.addEventListener("change", () => { row.input = Number(inputEl.value) || 0; renderNoxInputs(); });

    const labelEl = document.createElement("input");
    labelEl.type = "text"; labelEl.placeholder = "Front door PIR";
    labelEl.value = row.label || "";
    labelEl.addEventListener("change", () => { row.label = labelEl.value; });

    const addr = document.createElement("span");
    addr.className = "muted";
    const addrVal = (Number(row.module) || 0) * 10 + (Number(row.input) || 0);
    addr.textContent = addrVal > 0 ? String(addrVal) : "—";

    const stateEl = document.createElement("span");
    stateEl.className = "muted";
    const live = noxLiveEntryFor(row.module, row.input);
    stateEl.textContent = live ? noxFlagsSummary(live.flags) : "—";

    const removeEl = document.createElement("button");
    removeEl.type = "button"; removeEl.className = "btn btn-secondary"; removeEl.textContent = "×";
    removeEl.title = "Remove";
    removeEl.addEventListener("click", () => { noxInputsModel.splice(idx, 1); renderNoxInputs(); });

    wrap.append(moduleEl, inputEl, labelEl, addr, stateEl, removeEl);
    noxInputsListEl.appendChild(wrap);
  });

  if (noxInputsEmptyEl) noxInputsEmptyEl.style.display = "none";
}

function applyNoxConfig(cfg) {
  if (!cfg) return;
  if (noxEnabledEl)       noxEnabledEl.checked = !!cfg.enabled;
  const mb = cfg.modbus || {};
  if (noxModbusEnabledEl) noxModbusEnabledEl.checked = !!mb.enabled;
  if (noxModbusHostEl)    noxModbusHostEl.value = mb.host || "";
  if (noxModbusPortEl)    noxModbusPortEl.value = mb.port ?? 502;
  if (noxModbusUnitEl)    noxModbusUnitEl.value = mb.unit_id ?? 1;
  if (noxModbusPollEl)    noxModbusPollEl.value = mb.poll_seconds ?? 1.0;
  noxInputsModel = (mb.inputs || []).map(i => ({
    module: Number(i.module) || 0,
    input: Number(i.input) || 0,
    label: i.label || "",
  }));
  noxAreasModel = (mb.areas || []).map(a => ({
    area_id: Number(a.area_id) || 0,
    label: a.label || "",
  }));

  const tio = cfg.tio || {};
  if (noxTioEnabledEl)     noxTioEnabledEl.checked = !!tio.enabled;
  if (noxTioHostEl)        noxTioHostEl.value = tio.listen_host || "0.0.0.0";
  if (noxTioPortEl)        noxTioPortEl.value = tio.listen_port ?? 9760;
  if (noxTioSendEnabledEl) noxTioSendEnabledEl.checked = !!tio.send_enabled;
  if (noxTioSendHostEl)    noxTioSendHostEl.value = tio.send_target_host || "";
  if (noxTioSendPortEl)    noxTioSendPortEl.value = tio.send_target_port ?? 9761;

  renderNoxInputs();
  renderNoxAreas();
}

function applyNoxState(state) {
  noxLastState = state || null;
  if (!noxStatusEl) return;

  if (!state) {
    noxStatusEl.textContent = "Loading…";
    return;
  }

  const lines = [];
  if (!state.enabled) {
    lines.push("Disabled.");
  } else {
    if (state.modbus?.enabled) {
      const mb = state.modbus;
      if (mb.connected) {
        lines.push(`Modbus: connected to ${mb.host}:${mb.port}, last poll ${mb.last_poll_at || "—"}`);
      } else {
        lines.push(`Modbus: disconnected${mb.error ? ` — ${mb.error}` : ""}`);
      }
    } else {
      lines.push("Modbus: off");
    }
    if (state.tio?.enabled) {
      const tio = state.tio;
      if (tio.listening) {
        lines.push(`TIO: listening on ${tio.listen_host}:${tio.listen_port}, last message ${tio.last_message_at || "—"}`);
      } else {
        lines.push(`TIO: not listening${tio.error ? ` — ${tio.error}` : ""}`);
      }
    } else {
      lines.push("TIO: off");
    }
  }
  noxStatusEl.textContent = lines.join(" · ");

  if (noxStatusBadgeEl) {
    const ok = state.enabled && (
      (!state.modbus?.enabled || state.modbus.connected) &&
      (!state.tio?.enabled || state.tio.listening)
    );
    noxStatusBadgeEl.textContent = state.enabled ? (ok ? "Connected" : "Issues") : "Disabled";
    noxStatusBadgeEl.style.color = state.enabled
      ? (ok ? "var(--clr-success, #2ecc71)" : "var(--clr-warning, #f39c12)")
      : "";
  }

  renderNoxInputs();
  renderNoxAreas();
}

async function loadNoxConfig() {
  try {
    const data = await api("/api/nox/config", { method: "GET" });
    applyNoxConfig(data?.config);
  } catch (e) {
    if (noxStatusEl) noxStatusEl.textContent = `Error loading config: ${e.message || e}`;
  }
}

async function loadNoxState() {
  try {
    const data = await api("/api/nox/state", { method: "GET" });
    applyNoxState(data?.state);
  } catch (e) {
    if (noxStatusEl) noxStatusEl.textContent = `Error loading status: ${e.message || e}`;
  }
}

function collectNoxConfig() {
  return {
    enabled: !!noxEnabledEl?.checked,
    modbus: {
      enabled: !!noxModbusEnabledEl?.checked,
      host: (noxModbusHostEl?.value || "").trim(),
      port: Number(noxModbusPortEl?.value) || 502,
      unit_id: Number(noxModbusUnitEl?.value) || 1,
      poll_seconds: Number(noxModbusPollEl?.value) || 1.0,
      inputs: noxInputsModel
        .filter(r => r.module > 0 && r.input >= 0 && r.input <= 9)
        .map(r => ({ module: r.module, input: r.input, label: r.label || "" })),
      areas: noxAreasModel
        .filter(r => r.area_id > 0)
        .map(r => ({ area_id: r.area_id, label: r.label || "" })),
    },
    tio: {
      enabled: !!noxTioEnabledEl?.checked,
      listen_host: (noxTioHostEl?.value || "0.0.0.0").trim(),
      listen_port: Number(noxTioPortEl?.value) || 9760,
      send_enabled: !!noxTioSendEnabledEl?.checked,
      send_target_host: (noxTioSendHostEl?.value || "").trim(),
      send_target_port: Number(noxTioSendPortEl?.value) || 9761,
    },
  };
}

noxAddInputBtn?.addEventListener("click", () => {
  noxInputsModel.push({ module: 0, input: 0, label: "" });
  renderNoxInputs();
});

noxSaveBtn?.addEventListener("click", async () => {
  noxSaveBtn.disabled = true;
  if (noxStatusEl) noxStatusEl.textContent = "Saving…";
  try {
    const data = await api("/api/nox/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectNoxConfig()),
    });
    applyNoxConfig(data?.config);
    applyNoxState(data?.state);
    setTimeout(loadNoxState, 1500);
  } catch (e) {
    if (noxStatusEl) noxStatusEl.textContent = `Error: ${e.message || e}`;
  } finally {
    noxSaveBtn.disabled = false;
  }
});

noxRefreshBtn?.addEventListener("click", loadNoxState);

// ── TIO discovered entities + recent messages ────────────────────────────────

const noxTioDiscoveredEl  = document.getElementById("noxTioDiscovered");
const noxTioRecentEl      = document.getElementById("noxTioRecent");
const noxTioRefreshDiscoveredBtn = document.getElementById("noxTioRefreshDiscoveredBtn");

function renderTioDiscovered(state) {
  if (!noxTioDiscoveredEl) return;
  noxTioDiscoveredEl.innerHTML = "";
  const tio = state?.tio || {};
  const inputs = Object.values(tio.inputs || {});
  const areas = Object.values(tio.areas || {});

  if (!inputs.length && !areas.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No TIO messages received yet.";
    noxTioDiscoveredEl.appendChild(empty);
    return;
  }

  if (areas.length) {
    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:600;margin-top:4px;";
    heading.textContent = `Areas (${areas.length})`;
    noxTioDiscoveredEl.appendChild(heading);
    areas.sort((a, b) => Number(a.id) - Number(b.id) || (a.label || "").localeCompare(b.label || ""));
    for (const a of areas) {
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:60px 1fr 120px 1fr;gap:8px;";
      row.append(
        Object.assign(document.createElement("span"), { textContent: `#${a.id}`, className: "muted" }),
        Object.assign(document.createElement("span"), { textContent: a.label || "—" }),
        Object.assign(document.createElement("span"), { textContent: a.state || "—" }),
        Object.assign(document.createElement("span"), { textContent: a.last_seen || "", className: "muted" }),
      );
      noxTioDiscoveredEl.appendChild(row);
    }
  }

  if (inputs.length) {
    const heading = document.createElement("div");
    heading.style.cssText = "font-weight:600;margin-top:8px;";
    heading.textContent = `Inputs (${inputs.length})`;
    noxTioDiscoveredEl.appendChild(heading);
    inputs.sort((a, b) => Number(a.id) - Number(b.id) || (a.label || "").localeCompare(b.label || ""));
    for (const i of inputs) {
      const row = document.createElement("div");
      row.style.cssText = "display:grid;grid-template-columns:60px 1fr 120px 1fr;gap:8px;";
      row.append(
        Object.assign(document.createElement("span"), { textContent: `#${i.id}`, className: "muted" }),
        Object.assign(document.createElement("span"), { textContent: (i.label || "—") + (i.module_input ? ` (${i.module_input})` : "") }),
        Object.assign(document.createElement("span"), { textContent: i.state || "—" }),
        Object.assign(document.createElement("span"), { textContent: i.last_seen || "", className: "muted" }),
      );
      noxTioDiscoveredEl.appendChild(row);
    }
  }
}

function renderTioRecent(state) {
  if (!noxTioRecentEl) return;
  const recent = state?.tio?.recent_messages || [];
  noxTioRecentEl.innerHTML = "";
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No messages yet.";
    noxTioRecentEl.appendChild(empty);
    return;
  }
  // Newest first
  for (const msg of recent.slice().reverse()) {
    const row = document.createElement("div");
    const ts = msg.ts || "";
    const tsShort = ts ? ts.slice(11, 19) : "—";
    const type = msg.type || "?";
    row.textContent = `${tsShort}  [${type.padEnd(5)}]  ${msg.raw || ""}`;
    if (type === "unknown") row.style.color = "var(--clr-warning, #f39c12)";
    noxTioRecentEl.appendChild(row);
  }
}

noxTioRefreshDiscoveredBtn?.addEventListener("click", loadNoxState);

// Hook into existing applyNoxState by calling our renderers whenever state updates.
const _origApplyNoxState = applyNoxState;
applyNoxState = function(state) {
  _origApplyNoxState(state);
  renderTioDiscovered(state);
  renderTioRecent(state);
};

// ── TIO send test ────────────────────────────────────────────────────────────

const noxTioSendMessageEl = document.getElementById("noxTioSendMessage");
const noxTioSendBtn       = document.getElementById("noxTioSendBtn");
const noxTioSendResult    = document.getElementById("noxTioSendResult");

noxTioSendBtn?.addEventListener("click", async () => {
  const message = (noxTioSendMessageEl?.value || "").trim();
  if (!message) {
    if (noxTioSendResult) noxTioSendResult.textContent = "Enter a message to send.";
    return;
  }
  const targetHost = (noxTioSendHostEl?.value || "").trim();
  if (!targetHost) {
    if (noxTioSendResult) noxTioSendResult.textContent = "Enter a TIO send target host first.";
    return;
  }
  if (!confirm(`Send to ${targetHost}:${noxTioSendPortEl?.value || 9761}:\n\n${message}`)) return;

  noxTioSendBtn.disabled = true;
  if (noxTioSendResult) noxTioSendResult.textContent = "Sending…";
  try {
    const data = await api("/api/nox/tio/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        host: targetHost,
        port: Number(noxTioSendPortEl?.value) || 9761,
      }),
    });
    const lines = [
      `→ ${data.host}:${data.port}`,
      `   ${data.message}`,
      `sent_ok: ${data.sent_ok}`,
    ];
    if (data.error) lines.push(`error:   ${data.error}`);
    if (noxTioSendResult) noxTioSendResult.textContent = lines.join("\n");
  } catch (e) {
    if (noxTioSendResult) noxTioSendResult.textContent = `Error: ${e.message || e}`;
  } finally {
    noxTioSendBtn.disabled = false;
  }
});

const noxAckAllBtn = document.getElementById("noxAckAllBtn");
noxAckAllBtn?.addEventListener("click", async () => {
  const formHost = (noxModbusHostEl?.value || "").trim();
  if (!formHost) {
    if (noxWriteResultEl) noxWriteResultEl.textContent = "Enter NOX panel IP first.";
    return;
  }
  if (!confirm("Send 'Acknowledge all alarms' (writes 1 to register 1000)? This is a NOX-documented operation.")) return;
  noxAckAllBtn.disabled = true;
  if (noxWriteResultEl) noxWriteResultEl.textContent = "Writing 1 → register 1000…";
  try {
    const data = await api("/api/nox/test-ack-all-alarms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: formHost,
        port: Number(noxModbusPortEl?.value) || 502,
        unit_id: Number(noxModbusUnitEl?.value) || 1,
      }),
    });
    const lines = [
      `register 1000 ← 1 (ack-all-alarms diagnostic)`,
      `write_ok: ${data.write_ok}`,
    ];
    if (data.error) lines.push(`error:    ${data.error}`);
    if (data.response) {
      lines.push("");
      lines.push("response: " + JSON.stringify(data.response));
    }
    lines.push("");
    if (data.write_ok) {
      lines.push("✓ FC16 write to register 1000 succeeded.");
      lines.push("  This means the Modbus write path itself works — the area-arm reject is");
      lines.push("  almost certainly a per-area permission, not a global Modbus issue.");
    } else {
      lines.push("✖ Even ack-all-alarms is being silently dropped.");
      lines.push("  This points to a global Modbus write permission missing in NoxConfig,");
      lines.push("  or the connecting IP isn't trusted by the panel.");
    }
    if (noxWriteResultEl) noxWriteResultEl.textContent = lines.join("\n");
  } catch (e) {
    if (noxWriteResultEl) noxWriteResultEl.textContent = `Error: ${e.message || e}`;
  } finally {
    noxAckAllBtn.disabled = false;
  }
});

// ── NOX areas ────────────────────────────────────────────────────────────────

const noxAreasListEl       = document.getElementById("noxAreasList");
const noxAreasEmptyEl      = document.getElementById("noxAreasEmpty");
const noxAddAreaBtn        = document.getElementById("noxAddAreaBtn");
const noxDiscoverAreasBtn  = document.getElementById("noxDiscoverAreasBtn");
const noxAreasStatusEl     = document.getElementById("noxAreasStatus");

function noxLiveAreaFor(areaId) {
  if (!noxLastState) return null;
  const areas = noxLastState.modbus?.areas || [];
  return areas.find(a => Number(a.area_id) === Number(areaId)) || null;
}

function renderNoxAreas() {
  if (!noxAreasListEl) return;
  noxAreasListEl.innerHTML = "";

  if (!noxAreasModel.length) {
    if (noxAreasEmptyEl) {
      noxAreasListEl.appendChild(noxAreasEmptyEl);
      noxAreasEmptyEl.style.display = "";
    }
    return;
  }

  noxAreasModel.forEach((row, idx) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:grid;grid-template-columns:80px 1fr 90px 1fr auto 32px;gap:8px;align-items:center;";

    const idEl = document.createElement("input");
    idEl.type = "number"; idEl.min = "1"; idEl.max = "999";
    idEl.value = row.area_id ?? "";
    idEl.placeholder = "1";
    idEl.addEventListener("change", () => { row.area_id = Number(idEl.value) || 0; renderNoxAreas(); });

    const labelEl = document.createElement("input");
    labelEl.type = "text"; labelEl.placeholder = "Beboelse";
    labelEl.value = row.label || "";
    labelEl.addEventListener("change", () => { row.label = labelEl.value; });

    const addrEl = document.createElement("span");
    addrEl.className = "muted";
    addrEl.textContent = (Number(row.area_id) || 0) > 0 ? `addr ${row.area_id}` : "—";

    const stateEl = document.createElement("span");
    const live = noxLiveAreaFor(row.area_id);
    let liveStateText = null;
    if (live) {
      liveStateText = live.state || "—";
      stateEl.textContent = `${liveStateText} (raw 0x${(live.raw || 0).toString(16).padStart(4, "0")})`;
      const ALARM = new Set(["forced_open", "door_held_alarm"]);
      const ARMED = new Set(["armed", "partly_armed"]);
      const WARNING = new Set(["door_held_open", "door_open", "door_held_warning", "off"]);
      const TRANSITIONAL = new Set(["disarmed_exit", "disarmed_exit_wait", "disarmed_entry", "pending"]);
      const NEUTRAL_OK = new Set(["disarmed", "on", "door_closed", "access_granted"]);

      if (ALARM.has(liveStateText)) {
        stateEl.style.color = "var(--clr-danger, #e74c3c)";
        stateEl.style.fontWeight = "600";
      } else if (ARMED.has(liveStateText)) {
        stateEl.style.color = "var(--clr-warning, #f39c12)";
      } else if (WARNING.has(liveStateText)) {
        stateEl.style.color = "var(--clr-warning, #f39c12)";
      } else if (TRANSITIONAL.has(liveStateText)) {
        stateEl.style.color = "var(--clr-info, #4f8cff)";
      } else if (NEUTRAL_OK.has(liveStateText)) {
        stateEl.style.color = "var(--clr-success, #2ecc71)";
      }
    } else {
      stateEl.className = "muted";
      stateEl.textContent = "—";
    }

    // Inline arm / disarm controls — only meaningful when an area_id is set
    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;gap:4px;";
    const armBtn = document.createElement("button");
    armBtn.type = "button"; armBtn.className = "btn btn-secondary";
    armBtn.style.cssText = "padding:4px 10px;font-size:12px;";
    armBtn.textContent = "Arm";
    const disarmBtn = document.createElement("button");
    disarmBtn.type = "button"; disarmBtn.className = "btn btn-secondary";
    disarmBtn.style.cssText = "padding:4px 10px;font-size:12px;";
    disarmBtn.textContent = "Disarm";
    if (!Number(row.area_id)) {
      armBtn.disabled = true;
      disarmBtn.disabled = true;
    } else {
      armBtn.addEventListener("click", () => noxControlArea(row, true));
      disarmBtn.addEventListener("click", () => noxControlArea(row, false));
    }
    controls.append(armBtn, disarmBtn);

    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "btn btn-secondary"; remove.textContent = "×";
    remove.addEventListener("click", () => { noxAreasModel.splice(idx, 1); renderNoxAreas(); });

    wrap.append(idEl, labelEl, addrEl, stateEl, controls, remove);
    noxAreasListEl.appendChild(wrap);
  });

  if (noxAreasEmptyEl) noxAreasEmptyEl.style.display = "none";
}

noxAddAreaBtn?.addEventListener("click", () => {
  noxAreasModel.push({ area_id: 0, label: "" });
  renderNoxAreas();
});

async function noxControlArea(row, arm) {
  const id = Number(row.area_id);
  if (!id) return;
  const verb = arm ? "Arm" : "Disarm";
  const label = row.label ? ` (${row.label})` : "";
  if (!confirm(`${verb} area ${id}${label}?`)) return;
  if (noxAreasStatusEl) noxAreasStatusEl.textContent = `${verb}ing area ${id}…`;
  try {
    const data = await api(`/api/nox/areas/${id}/${arm ? "arm" : "disarm"}`, { method: "POST" });
    if (data.write_ok) {
      const after = data.after?.state || "?";
      if (noxAreasStatusEl) noxAreasStatusEl.textContent = `Area ${id}: ${verb.toLowerCase()}ed (now ${after}).`;
    } else {
      const flags = (data.captured_failure_flags || []).join(", ");
      if (noxAreasStatusEl) {
        noxAreasStatusEl.textContent =
          `Area ${id}: ${verb.toLowerCase()} rejected by NOX${flags ? ` (${flags})` : " (no failure flags captured)"}.`;
      }
    }
    setTimeout(loadNoxState, 600);
  } catch (e) {
    if (noxAreasStatusEl) noxAreasStatusEl.textContent = `${verb} failed: ${e.message || e}`;
  }
}

// ── NOX area write test ──────────────────────────────────────────────────────

const noxWriteAreaIdEl = document.getElementById("noxWriteAreaId");
const noxWriteCodeEl   = document.getElementById("noxWriteCode");
const noxWriteBtn      = document.getElementById("noxWriteBtn");
const noxWriteResultEl = document.getElementById("noxWriteResult");

function refreshNoxWriteAreaOptions() {
  if (!noxWriteAreaIdEl) return;
  const previous = noxWriteAreaIdEl.value;
  noxWriteAreaIdEl.innerHTML = "";
  if (!noxAreasModel.length) {
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "(no areas configured)";
    noxWriteAreaIdEl.appendChild(opt);
    return;
  }
  for (const a of noxAreasModel) {
    if (!a.area_id) continue;
    const opt = document.createElement("option");
    opt.value = String(a.area_id);
    opt.textContent = `Area ${a.area_id}${a.label ? " — " + a.label : ""}`;
    noxWriteAreaIdEl.appendChild(opt);
  }
  if (previous && [...noxWriteAreaIdEl.options].some(o => o.value === previous)) {
    noxWriteAreaIdEl.value = previous;
  }
}

const _origRenderNoxAreas = renderNoxAreas;
renderNoxAreas = function() {
  _origRenderNoxAreas();
  refreshNoxWriteAreaOptions();
};

noxWriteBtn?.addEventListener("click", async () => {
  const areaId = Number(noxWriteAreaIdEl?.value);
  const code = Number(noxWriteCodeEl?.value);
  if (!areaId) {
    if (noxWriteResultEl) noxWriteResultEl.textContent = "Configure an area first.";
    return;
  }
  const formHost = (noxModbusHostEl?.value || "").trim();
  if (!formHost) {
    if (noxWriteResultEl) noxWriteResultEl.textContent = "Enter NOX panel IP first.";
    return;
  }
  const opt = noxWriteAreaIdEl.options[noxWriteAreaIdEl.selectedIndex];
  const codeLabels = {1: "disarm", 5: "arm", 6: "partial-arm"};
  if (!confirm(`Write code ${code} (${codeLabels[code] || "?"}) to area ${areaId} (${opt?.textContent || ""})?`)) return;

  noxWriteBtn.disabled = true;
  if (noxWriteResultEl) noxWriteResultEl.textContent = `Writing ${code} → area ${areaId}…`;

  try {
    const data = await api("/api/nox/test-area-write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        area_id: areaId,
        code,
        host: formHost,
        port: Number(noxModbusPortEl?.value) || 502,
        unit_id: Number(noxModbusUnitEl?.value) || 1,
      }),
    });
    const fmt = s => {
      if (!s) return "n/a";
      const flags = [];
      if (s.fail_blocking_time)     flags.push("blocking");
      if (s.fail_no_rights)         flags.push("no_rights");
      if (s.fail_active_detectors)  flags.push("active_detectors");
      if (s.fail_active_alarms)     flags.push("active_alarms");
      if (s.alarm_active)           flags.push("ALARM");
      const flagStr = flags.length ? ` ⚠ ${flags.join(",")}` : "";
      return `raw=0x${s.raw.toString(16).padStart(4,"0")} code=${s.code} state=${s.state}${flagStr}`;
    };

    const lines = [
      `area ${data.area_id} (addr ${data.address}) ← code ${data.code_written}`,
      `write_ok: ${data.write_ok}` + (data.successful_strategy ? ` (via ${data.successful_strategy})` : ""),
      `before:   ${fmt(data.before)}`,
      `after:    ${fmt(data.after)}`,
    ];

    // Top-level diagnosis if a write was rejected
    if (!data.write_ok && Array.isArray(data.captured_failure_flags) && data.captured_failure_flags.length) {
      lines.push("");
      const reasons = data.captured_failure_flags.map(f => {
        switch (f) {
          case "blocking_time":     return "area is in blocking time";
          case "no_rights":         return "no rights (Modbus user lacks permission)";
          case "active_detectors":  return "detector(s) currently active in this area";
          case "active_alarms":     return "active alarms in this area (ack first)";
          default: return f;
        }
      });
      lines.push(`✖ NOX rejected the write — reason: ${reasons.join(", ")}`);
    } else if (!data.write_ok) {
      lines.push("");
      lines.push("✖ Write didn't take effect, and no failure bits were captured. Possible causes:");
      lines.push("   - Live poller cleared the failure bits before we read them (try again)");
      lines.push("   - Modbus user has no write permission (check NoxConfig)");
      lines.push("   - Area is currently in transitional state");
    }

    if (Array.isArray(data.attempts)) {
      lines.push("");
      lines.push("attempts:");
      for (const a of data.attempts) {
        const protocolStatus = a.protocol_ok ? "ok" : `FAIL (${a.error || "?"})`;
        const rb = a.readback;
        const flags = (a.failure_flags || []).join(",");
        const rbStr = rb
          ? `code=${rb.code} state=${rb.state}${flags ? ` ⚠ ${flags}` : ""}`
          : "no readback";
        lines.push(`  ${a.strategy.padEnd(13)} → protocol ${protocolStatus} → ${rbStr}`);
      }
    }

    if (noxWriteResultEl) noxWriteResultEl.textContent = lines.join("\n");
    setTimeout(loadNoxState, 800);
  } catch (e) {
    if (noxWriteResultEl) noxWriteResultEl.textContent = `Error: ${e.message || e}`;
  } finally {
    noxWriteBtn.disabled = false;
  }
});

refreshNoxWriteAreaOptions();

noxDiscoverAreasBtn?.addEventListener("click", async () => {
  const formHost = (noxModbusHostEl?.value || "").trim();
  if (!formHost) {
    if (noxAreasStatusEl) noxAreasStatusEl.textContent = "Enter NOX panel IP first.";
    return;
  }
  noxDiscoverAreasBtn.disabled = true;
  if (noxAreasStatusEl) noxAreasStatusEl.textContent = "Discovering areas (1–64)…";
  try {
    const data = await api("/api/nox/discover-areas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        max_area_id: 64,
        host: formHost,
        port: Number(noxModbusPortEl?.value) || 502,
        unit_id: Number(noxModbusUnitEl?.value) || 1,
      }),
    });
    const found = data?.found || [];
    let added = 0;
    for (const a of found) {
      if (!noxAreasModel.some(r => Number(r.area_id) === Number(a.area_id))) {
        noxAreasModel.push({ area_id: a.area_id, label: `Area ${a.area_id}` });
        added += 1;
      }
    }
    if (noxAreasStatusEl) {
      noxAreasStatusEl.textContent = `Found ${found.length} defined area(s); added ${added} new (remember to save).`;
    }
    renderNoxAreas();
  } catch (e) {
    if (noxAreasStatusEl) noxAreasStatusEl.textContent = `Discover failed: ${e.message || e}`;
  } finally {
    noxDiscoverAreasBtn.disabled = false;
  }
});

// ── NOX discovery scan ──────────────────────────────────────────────────────

const noxScanStartEl    = document.getElementById("noxScanStart");
const noxScanEndEl      = document.getElementById("noxScanEnd");
const noxScanOnlyDefEl  = document.getElementById("noxScanOnlyDefined");
const noxScanBtn        = document.getElementById("noxScanBtn");
const noxScanAddAllBtn  = document.getElementById("noxScanAddAllBtn");
const noxScanStatusEl   = document.getElementById("noxScanStatus");
const noxScanResultsEl  = document.getElementById("noxScanResults");

let noxScanResults = [];

function isInputAlreadyMonitored(module, input) {
  return noxInputsModel.some(r => Number(r.module) === Number(module) && Number(r.input) === Number(input));
}

function addDiscoveredInput(item) {
  if (isInputAlreadyMonitored(item.module, item.input)) return false;
  noxInputsModel.push({
    module: Number(item.module),
    input: Number(item.input),
    label: `Module ${item.module} input ${item.input}`,
  });
  return true;
}

function renderNoxScanResults() {
  if (!noxScanResultsEl) return;
  noxScanResultsEl.innerHTML = "";

  if (!noxScanResults.length) {
    if (noxScanAddAllBtn) noxScanAddAllBtn.style.display = "none";
    return;
  }

  const newOnes = noxScanResults.filter(r => !isInputAlreadyMonitored(r.module, r.input));
  if (noxScanAddAllBtn) noxScanAddAllBtn.style.display = newOnes.length ? "" : "none";

  noxScanResults.forEach(item => {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:90px 70px 110px 1fr 110px;gap:8px;align-items:center;";

    const module = document.createElement("span");
    module.textContent = `mod ${item.module}`;

    const input = document.createElement("span");
    input.textContent = `in ${item.input}`;

    const addr = document.createElement("span");
    addr.className = "muted";
    addr.textContent = String(item.address);

    const summary = document.createElement("span");
    summary.textContent = noxFlagsSummary(item.flags);
    if (item.flags?.alarm) {
      summary.style.color = "var(--clr-danger, #e74c3c)";
      summary.style.fontWeight = "600";
    }

    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn btn-secondary";
    if (isInputAlreadyMonitored(item.module, item.input)) {
      action.textContent = "Already added";
      action.disabled = true;
    } else {
      action.textContent = "Add to monitored";
      action.addEventListener("click", () => {
        if (addDiscoveredInput(item)) {
          renderNoxInputs();
          renderNoxScanResults();
        }
      });
    }

    row.append(module, input, addr, summary, action);
    noxScanResultsEl.appendChild(row);
  });
}

noxScanBtn?.addEventListener("click", async () => {
  const start = Number(noxScanStartEl?.value) || 1001;
  const end = Number(noxScanEndEl?.value) || 1020;
  const onlyDefined = !!noxScanOnlyDefEl?.checked;

  if (end < start) {
    if (noxScanStatusEl) noxScanStatusEl.textContent = "End module must be ≥ start module.";
    return;
  }

  // Use whatever's in the form right now — works without saving first.
  const formHost = (noxModbusHostEl?.value || "").trim();
  const formPort = Number(noxModbusPortEl?.value);
  const formUnit = Number(noxModbusUnitEl?.value);

  if (!formHost) {
    if (noxScanStatusEl) noxScanStatusEl.textContent = "Enter NOX panel IP first.";
    return;
  }

  noxScanBtn.disabled = true;
  if (noxScanStatusEl) noxScanStatusEl.textContent = `Scanning modules ${start}–${end} on ${formHost}:${formPort || 502}…`;
  noxScanResults = [];
  renderNoxScanResults();

  try {
    const data = await api("/api/nox/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_module: start,
        end_module: end,
        only_defined: onlyDefined,
        host: formHost,
        port: formPort || 502,
        unit_id: Number.isFinite(formUnit) ? formUnit : 1,
      }),
    });
    noxScanResults = data?.found || [];
    const errCount = (data?.errors || []).length;
    const fcUsed = data?.function_code_used;
    const warning = data?.warning;
    const diag = data?.diagnostics || [];
    const errs = data?.errors || [];

    if (noxScanStatusEl) {
      const parts = [];
      if (warning) {
        parts.push(`⚠ ${warning}`);
        if (diag.length) {
          parts.push("Probe results: " + diag.map(d =>
            `FC ${d.function_code === "input" ? "04" : "03"}${d.address ? ` @${d.address}` : ""} → ${d.ok ? "ok" : d.error}`
          ).join("; "));
        }
      } else {
        const fcLabel = fcUsed === "input" ? "FC04 (input registers)" : fcUsed === "holding" ? "FC03 (holding registers)" : "?";
        parts.push(`Found ${noxScanResults.length} input(s) using ${fcLabel}`);
        if (errCount) {
          parts.push(`${errCount} chunk(s) returned errors`);
          // Show the first distinct error so we can see the actual exception code.
          const sample = errs.find(e => e.error) || null;
          if (sample) parts.push(`first error: ${sample.error} @${sample.address}`);
        }
      }
      noxScanStatusEl.textContent = parts.join(" · ");
    }
    renderNoxScanResults();
  } catch (e) {
    if (noxScanStatusEl) noxScanStatusEl.textContent = `Scan failed: ${e.message || e}`;
  } finally {
    noxScanBtn.disabled = false;
  }
});

noxScanAddAllBtn?.addEventListener("click", () => {
  let added = 0;
  for (const item of noxScanResults) {
    if (addDiscoveredInput(item)) added += 1;
  }
  if (noxScanStatusEl && added > 0) {
    const prev = noxScanStatusEl.textContent || "";
    noxScanStatusEl.textContent = `${prev} · added ${added} to monitored list (remember to save).`;
  }
  renderNoxInputs();
  renderNoxScanResults();
});

// ── NOX raw register probe (for area-state block discovery) ──────────────────

const noxProbeStartEl       = document.getElementById("noxProbeStart");
const noxProbeEndEl         = document.getElementById("noxProbeEnd");
const noxProbeFcEl          = document.getElementById("noxProbeFc");
const noxProbeOnlyNonzeroEl = document.getElementById("noxProbeOnlyNonzero");
const noxProbeBtn           = document.getElementById("noxProbeBtn");
const noxProbeSweepBtn      = document.getElementById("noxProbeSweepBtn");
const noxProbeStatusEl      = document.getElementById("noxProbeStatus");
const noxProbeResultsEl     = document.getElementById("noxProbeResults");

const NOX_PROBE_PRESETS = [
  [0, 200], [200, 1000], [5000, 5200], [9000, 9200],
  [20000, 20200], [30000, 30200], [40000, 40200],
  [50000, 50200], [90000, 90200],
];

function findAreaCandidateBlocks(values, expectedCount = 21) {
  // Look for clusters of small-integer registers (value <= 15) where at least
  // `expectedCount/2` registers fall within a span of ~2*expectedCount.
  if (!values.length) return [];
  const small = values.filter(v => v.value <= 15).sort((a, b) => a.address - b.address);
  if (small.length < Math.max(2, Math.floor(expectedCount / 2))) return [];

  const candidates = [];
  const span = expectedCount * 2;
  for (let i = 0; i < small.length; i += 1) {
    const start = small[i].address;
    let count = 0;
    let lastIdx = i;
    for (let j = i; j < small.length && small[j].address - start <= span; j += 1) {
      count += 1;
      lastIdx = j;
    }
    if (count >= Math.max(3, Math.floor(expectedCount / 3))) {
      candidates.push({ start, end: small[lastIdx].address, count });
      i = lastIdx; // skip overlap
    }
  }
  return candidates;
}

function renderProbeResults(values, errors, range, fc) {
  if (!noxProbeResultsEl) return;
  noxProbeResultsEl.innerHTML = "";

  if (!values.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = errors?.length
      ? `${errors.length} chunk(s) returned errors. First: ${errors[0].error} @${errors[0].address}.`
      : "No non-zero registers in this range.";
    noxProbeResultsEl.appendChild(empty);
    return;
  }

  const candidates = findAreaCandidateBlocks(values, 21);
  const flagged = new Set();
  for (const c of candidates) {
    for (const v of values) {
      if (v.address >= c.start && v.address <= c.end && v.value <= 15) flagged.add(v.address);
    }
  }

  if (candidates.length) {
    const hint = document.createElement("div");
    hint.style.color = "var(--clr-warning, #f39c12)";
    hint.style.fontFamily = "inherit";
    hint.textContent = "Possible area-state block(s): " +
      candidates.map(c => `${c.start}–${c.end} (${c.count} small ints)`).join(", ");
    noxProbeResultsEl.appendChild(hint);
  }

  // Show all values, highlighting flagged ones
  for (const v of values) {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:90px 70px 1fr;gap:8px;";
    if (flagged.has(v.address)) {
      row.style.color = "var(--clr-warning, #f39c12)";
      row.style.fontWeight = "600";
    }
    const a = document.createElement("span"); a.textContent = String(v.address);
    const d = document.createElement("span"); d.textContent = String(v.value);
    const h = document.createElement("span"); h.textContent = "0x" + v.value.toString(16).padStart(4, "0");
    row.append(a, d, h);
    noxProbeResultsEl.appendChild(row);
  }
}

async function noxRunProbe(start, end) {
  const formHost = (noxModbusHostEl?.value || "").trim();
  if (!formHost) {
    if (noxProbeStatusEl) noxProbeStatusEl.textContent = "Enter NOX panel IP first.";
    return null;
  }
  const fc = noxProbeFcEl?.value || "holding";
  const onlyNonzero = !!noxProbeOnlyNonzeroEl?.checked;

  if (noxProbeStatusEl) noxProbeStatusEl.textContent = `Probing ${start}–${end} (${fc})…`;

  try {
    const data = await api("/api/nox/probe-registers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_addr: start,
        end_addr: end,
        function_code: fc,
        only_nonzero: onlyNonzero,
        host: formHost,
        port: Number(noxModbusPortEl?.value) || 502,
        unit_id: Number(noxModbusUnitEl?.value) || 1,
      }),
    });
    const values = data?.values || [];
    const errors = data?.errors || [];
    if (noxProbeStatusEl) {
      noxProbeStatusEl.textContent =
        `${start}–${end}: ${values.length} non-zero` +
        (errors.length ? `, ${errors.length} chunk error(s)` : "");
    }
    return { start, end, values, errors };
  } catch (e) {
    if (noxProbeStatusEl) noxProbeStatusEl.textContent = `Probe failed: ${e.message || e}`;
    return null;
  }
}

noxProbeBtn?.addEventListener("click", async () => {
  const start = Number(noxProbeStartEl?.value) || 0;
  const end = Number(noxProbeEndEl?.value) || 200;
  if (end < start) {
    if (noxProbeStatusEl) noxProbeStatusEl.textContent = "End must be ≥ start.";
    return;
  }
  noxProbeBtn.disabled = true;
  const result = await noxRunProbe(start, end);
  noxProbeBtn.disabled = false;
  if (result) renderProbeResults(result.values, result.errors, [start, end], noxProbeFcEl?.value);
});

noxProbeSweepBtn?.addEventListener("click", async () => {
  noxProbeSweepBtn.disabled = true;
  noxProbeBtn.disabled = true;
  if (noxProbeResultsEl) noxProbeResultsEl.innerHTML = "";
  const allValues = [];
  let totalErrors = 0;
  const summaryParts = [];

  for (const [s, e] of NOX_PROBE_PRESETS) {
    const result = await noxRunProbe(s, e);
    if (!result) continue;
    if (result.values.length) {
      summaryParts.push(`${s}–${e}: ${result.values.length}`);
      allValues.push(...result.values);
    }
    totalErrors += result.errors.length;
  }
  if (noxProbeStatusEl) {
    noxProbeStatusEl.textContent =
      `Sweep complete. Non-zero by range: ${summaryParts.length ? summaryParts.join(" · ") : "none found"}` +
      (totalErrors ? ` · ${totalErrors} total chunk error(s)` : "");
  }
  renderProbeResults(allValues, [], null, noxProbeFcEl?.value);

  noxProbeSweepBtn.disabled = false;
  noxProbeBtn.disabled = false;
});

// Preset shortcut buttons.
document.querySelectorAll("[data-nox-probe]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const [s, e] = btn.getAttribute("data-nox-probe").split(",").map(Number);
    if (noxProbeStartEl) noxProbeStartEl.value = s;
    if (noxProbeEndEl) noxProbeEndEl.value = e;
    btn.disabled = true;
    const result = await noxRunProbe(s, e);
    btn.disabled = false;
    if (result) renderProbeResults(result.values, result.errors, [s, e], noxProbeFcEl?.value);
  });
});

if (document.getElementById("nox")) {
  loadNoxConfig().then(loadNoxState);
  setInterval(loadNoxState, 5000);
}
