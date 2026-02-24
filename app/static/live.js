// live.js (devices + no manual entry; publishes/plays cam1)
const dot = document.getElementById('dot');
const pillText = document.getElementById('pillText');
const statusText = document.getElementById('statusText');

const profilesSel = document.getElementById('profiles');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const video = document.getElementById('video');

const deviceSel = document.getElementById('deviceSel');
const reloadBtn = document.getElementById('reloadDevices');

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

function getWhepUrl() {
  const proto = window.location.protocol;
  const host = window.location.hostname;
  return `${proto}//${host}:8889/cam1/whep`;
}

const whepUrl = getWhepUrl();
document.getElementById('whepUrl').textContent = whepUrl;
document.getElementById('playerUrl').textContent = whepUrl.replace('/whep', '');

function fillCredsFromDevice(d) {
  selectedDevice = d;
  document.getElementById('ip').value = d.ip || "";
  document.getElementById('onvif_port').value = d.onvif_port ?? 80;
  document.getElementById('username').value = d.username || "";
  document.getElementById('password').value = d.password || "";
}

function creds() {
  const ip = document.getElementById('ip').value.trim();
  const onvif_port = parseInt((document.getElementById('onvif_port').value || "80").trim(), 10);
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  return { ip, onvif_port, username, password };
}

function stopWhep() {
  if (pc) {
    try { pc.close(); } catch { }
    pc = null;
  }
  if (video.srcObject) {
    try { video.srcObject.getTracks().forEach(t => t.stop()); } catch { }
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

async function startWhep() {
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

  const res = await fetch(getWhepUrl(), {
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

function profileLabel(p) {
  const parts = [];
  if (p.name) parts.push(p.name);
  if (p.encoding) parts.push(String(p.encoding));
  if (p.width && p.height) parts.push(`${p.width}x${p.height}`);
  return parts.length ? parts.join(" • ") : p.token;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail || res.statusText);
  return data;
}

async function loadDevices() {
  deviceSel.disabled = true;
  deviceSel.innerHTML = `<option>Loading devices…</option>`;
  selectedDevice = null;

  try {
    const data = await api("/api/devices", { method: "GET" });
    devices = data.devices || [];

    deviceSel.innerHTML = "";

    if (!devices.length) {
      deviceSel.innerHTML = `<option>(no devices yet — click Devices)</option>`;
      setStatus("No devices saved. Click Devices to add one.", "warn");
      profilesSel.disabled = true;
      startBtn.disabled = true;
      return;
    }

    for (const d of devices) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${d.name || d.ip} (${d.ip})`;
      deviceSel.appendChild(opt);
    }

    deviceSel.disabled = false;

    // select first
    selectedDevice = devices[0];
    deviceSel.value = selectedDevice.id;
    fillCredsFromDevice(selectedDevice);

    profilesSel.disabled = true;
    startBtn.disabled = true;
    profilesSel.innerHTML = `<option>Select "Fetch profiles"…</option>`;

    setStatus(`Selected: ${selectedDevice.name || selectedDevice.ip}`, "ok");
  } catch (e) {
    deviceSel.innerHTML = `<option>(failed to load devices)</option>`;
    setStatus(`Device load error: ${e?.message || e}`, "bad");
  }
}

deviceSel.addEventListener("change", () => {
  const id = deviceSel.value;
  const d = devices.find(x => x.id === id);
  if (!d) return;

  stopWhep();
  fillCredsFromDevice(d);

  profilesSel.disabled = true;
  startBtn.disabled = true;
  profilesSel.innerHTML = `<option>Select "Fetch profiles"…</option>`;

  setStatus(`Selected: ${d.name || d.ip}`, "ok");
});

reloadBtn.addEventListener("click", () => loadDevices());

document.getElementById('fetch').addEventListener('click', async () => {
  const c = creds();
  if (!c.ip || !c.username || !c.password) return setStatus("Missing device credentials.", "bad");

  setStatus("Fetching profiles…", "warn");
  profilesSel.disabled = true;
  startBtn.disabled = true;
  profilesSel.innerHTML = `<option>Loading…</option>`;

  try {
    const data = await api('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(c)
    });

    const profs = data.profiles || [];
    if (!profs.length) throw new Error("No profiles returned.");

    profilesSel.innerHTML = "";
    for (const p of profs) {
      const opt = document.createElement('option');
      opt.value = p.token;
      opt.textContent = profileLabel(p);
      profilesSel.appendChild(opt);
    }
    profilesSel.disabled = false;
    startBtn.disabled = false;
    setStatus(`Profiles loaded (${profs.length}).`, "ok");
  } catch (e) {
    profilesSel.innerHTML = `<option>Fetch failed</option>`;
    setStatus(`Error: ${e?.message || e}`, "bad");
  }
});

document.getElementById('start').addEventListener('click', async () => {
  const c = creds();
  const profile_token = profilesSel.value;
  if (!profile_token) return setStatus("Select a profile first.", "bad");

  setStatus("Starting…", "warn");
  startBtn.disabled = true;

  try {
    await api('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...c, profile_token })
    });

    await startWhep();
    stopBtn.disabled = false;
    setStatus("Streaming.", "ok");
  } catch (e) {
    stopWhep();
    setStatus(`Error: ${e?.message || e}`, "bad");
  } finally {
    startBtn.disabled = false;
  }
});

document.getElementById('stop').addEventListener('click', async () => {
  setStatus("Stopping…", "warn");
  stopBtn.disabled = true;
  try { await fetch('/api/stop', { method: 'POST' }); } catch { }
  stopWhep();
  setStatus("Stopped.", "warn");
});

setStatus("Loading devices…", "warn");
stopBtn.disabled = true;
loadDevices();