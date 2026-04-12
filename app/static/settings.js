// settings.js — SmartEye Pi Settings page

const cloudWsUrlEl   = document.getElementById("cloudWsUrl");
const cloudTokenEl   = document.getElementById("cloudToken");
const cloudDeviceIdEl = document.getElementById("cloudDeviceId");
const cloudSaveBtn   = document.getElementById("cloudSaveBtn");
const cloudConnectBtn = document.getElementById("cloudConnectBtn");
const cloudStatusEl  = document.getElementById("cloudStatus");

async function api(url, opts) {
  const res = await fetch(url, opts);
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

// ── System actions ────────────────────────────────────────────────────────────

const systemStatusEl = document.getElementById("systemStatus");
const clearRecordingsBtn = document.getElementById("clearRecordingsBtn");
const rebootBtn = document.getElementById("rebootBtn");

function setSystemStatus(text) {
  if (systemStatusEl) systemStatusEl.textContent = text;
}

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
