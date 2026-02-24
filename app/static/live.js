// live.js — select saved device; start only if it has a saved profile_token

const dot = document.getElementById('dot');
const pillText = document.getElementById('pillText');
const statusText = document.getElementById('statusText');

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const video = document.getElementById('video');

const deviceSel = document.getElementById('deviceSel');
const reloadBtn = document.getElementById('reloadDevices');
const profileLabelEl = document.getElementById('profileLabel');

const whepEl = document.getElementById('whepUrl');
const playerEl = document.getElementById('playerUrl');

let pc = null;
let devices = [];
let selectedDevice = null;

function setPill(state, text) {
  pillText.textContent = text;
  dot.className = "dot";
  if (state === "ok") dot.classList.add("ok");
  else if (state === "bad") dot.classList.add("bad");
}

function setStatus(msg, state = "warn") {
  statusText.textContent = msg;
  setPill(state, msg.slice(0, 40));
}

function getWhepUrl(deviceId) {
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return `${proto}//${host}:8889/cam-${encodeURIComponent(deviceId)}/whep`;
}

function updateUrls() {
  const pathCodeEl = document.getElementById("pathCode");

  if (!selectedDevice || !selectedDevice.id) {
    if (whepEl) whepEl.textContent = "(select a device)";
    if (playerEl) playerEl.textContent = "(select a device)";
    if (pathCodeEl) pathCodeEl.textContent = "(select a device)";
    return;
  }

  const path = `cam-${selectedDevice.id}`;
  const whepUrl = getWhepUrl(selectedDevice.id);
  const playerUrl = whepUrl.replace(/\/whep$/, '');

  if (pathCodeEl) pathCodeEl.textContent = path;
  if (whepEl) whepEl.textContent = whepUrl;
  if (playerEl) playerEl.textContent = playerUrl;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}

  if (!res.ok) {
    const detail = data?.detail || text || res.statusText;
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  if (data === null) throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
  return data;
}

function stopWhep() {
  if (pc) {
    try { pc.close(); } catch {}
    pc = null;
  }
  if (video.srcObject) {
    try { video.srcObject.getTracks().forEach(t => t.stop()); } catch {}
    video.srcObject = null;
  }
}

function waitIceGatheringComplete(pc, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const t = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }, timeoutMs);

    function onChange() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

async function startWhepForSelectedDevice() {
  if (!selectedDevice?.id) throw new Error("No device selected.");

  stopWhep();
  pc = new RTCPeerConnection();

  pc.ontrack = (e) => { video.srcObject = e.streams[0]; };

  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === "connected") setStatus("Streaming.", "ok");
    else if (st === "failed" || st === "disconnected") setStatus(`WebRTC ${st}.`, "bad");
  };

  pc.addTransceiver("video", { direction: "recvonly" });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGatheringComplete(pc, 2000);

  const res = await fetch(getWhepUrl(selectedDevice.id), {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription.sdp,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`WHEP failed (${res.status}): ${t || res.statusText}`);
  }

  const answerSdp = await res.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
}

function setSelectedDevice(d) {
  selectedDevice = d || null;

  stopWhep();
  stopBtn.disabled = true;

  const ready = !!(selectedDevice && selectedDevice.profile_token);
  profileLabelEl.textContent =
    selectedDevice?.profile_label ||
    (selectedDevice?.profile_token ? selectedDevice.profile_token : "(none)");

  startBtn.disabled = !ready;

  updateUrls();

  if (!selectedDevice) {
    setStatus("No device selected.", "warn");
  } else if (!ready) {
    setStatus("Device not ready: select & save a profile in Devices.", "warn");
  } else {
    setStatus(`Ready: ${selectedDevice.name || selectedDevice.ip}`, "ok");
  }
}

async function loadDevices() {
  deviceSel.disabled = true;
  deviceSel.innerHTML = `<option>Loading…</option>`;
  setSelectedDevice(null);

  try {
    const data = await api("/api/devices", { method: "GET" });
    devices = data.devices || [];

    deviceSel.innerHTML = "";

    if (!devices.length) {
      deviceSel.innerHTML = `<option>(no devices — add one in Devices)</option>`;
      setStatus("No devices saved. Go to Devices.", "warn");
      return;
    }

    for (const d of devices) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${d.name || d.ip} (${d.ip})`;
      deviceSel.appendChild(opt);
    }

    deviceSel.disabled = false;
    deviceSel.value = devices[0].id;
    setSelectedDevice(devices[0]);
  } catch (e) {
    deviceSel.innerHTML = `<option>(failed to load devices)</option>`;
    setStatus(`Device load error: ${e?.message || e}`, "bad");
  }
}

deviceSel.addEventListener("change", () => {
  const d = devices.find(x => x.id === deviceSel.value);
  setSelectedDevice(d || null);
});

reloadBtn.addEventListener("click", () => loadDevices());

startBtn.addEventListener("click", async () => {
  if (!selectedDevice) return setStatus("Select a device first.", "bad");
  if (!selectedDevice.profile_token) return setStatus("Device not ready: save a profile in Devices.", "bad");

  setStatus("Starting…", "warn");
  startBtn.disabled = true;

  try {
    await api("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ip: selectedDevice.ip,
        onvif_port: selectedDevice.onvif_port ?? 80,
        username: selectedDevice.username,
        password: selectedDevice.password,
        profile_token: selectedDevice.profile_token,
        device_id: selectedDevice.id
      })
    });

    await startWhepForSelectedDevice();
    stopBtn.disabled = false;
    setStatus("Streaming.", "ok");
  } catch (e) {
    stopWhep();
    setStatus(`Error: ${e?.message || e}`, "bad");
  } finally {
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", async () => {
  setStatus("Stopping…", "warn");
  stopBtn.disabled = true;
  try { await fetch("/api/stop", { method: "POST" }); } catch {}
  stopWhep();
  setStatus("Stopped.", "warn");
});

setStatus("Loading…", "warn");
stopBtn.disabled = true;
updateUrls();
loadDevices();