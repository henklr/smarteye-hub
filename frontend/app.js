const api = (path, opts) => fetch(`/api${path}`, opts).then(async r => {
  if (!r.ok) throw new Error(await r.text());
  return r.json();
});

const deviceList = document.getElementById("deviceList");
const addForm = document.getElementById("addForm");
const addStatus = document.getElementById("addStatus");

const streamImg = document.getElementById("streamImg");
const streamStatus = document.getElementById("streamStatus");

const eventsBox = document.getElementById("eventsBox");
const eventsStatus = document.getElementById("eventsStatus");
const clearEventsBtn = document.getElementById("clearEvents");

let selectedDeviceId = null;
let sse = null;
let pollTimer = null;

function setEventsText(lines) {
  eventsBox.textContent = lines.join("\n");
  eventsBox.scrollTop = eventsBox.scrollHeight;
}

function appendEventLine(line) {
  const existing = eventsBox.textContent ? eventsBox.textContent.split("\n") : [];
  existing.push(line);
  setEventsText(existing.slice(-400));
}

async function refreshDevices() {
  const devices = await api("/devices");
  deviceList.innerHTML = "";
  devices.forEach(d => {
    const div = document.createElement("div");
    div.className = "device";
    div.textContent = `${d.name} (${d.host}:${d.port})`;
    div.onclick = () => selectDevice(d.id, d.name);
    deviceList.appendChild(div);
  });
}

async function selectDevice(id, name) {
  selectedDeviceId = id;

  // Stream: use MJPEG endpoint
  streamStatus.textContent = `Watching ${name}…`;
  streamImg.src = `/api/devices/${id}/stream.mjpeg`;

  // Events: start SSE if supported, otherwise poll
  eventsBox.textContent = "";
  eventsStatus.textContent = "Connecting…";

  if (sse) sse.close();
  sse = null;

  try {
    sse = new EventSource(`/api/devices/${id}/events.sse`);
    sse.onmessage = (e) => {
      // some servers use message; we use event:onvif, so handle both
      appendEventLine(e.data);
    };
    sse.addEventListener("onvif", (e) => {
      const obj = JSON.parse(e.data);
      appendEventLine(`${obj.ts} | ${obj.topic || "-"} | ${obj.operation || "-"} | ${JSON.stringify(obj.message)}`);
    });
    sse.onerror = () => {
      eventsStatus.textContent = "SSE failed; falling back to polling.";
      if (sse) sse.close();
      sse = null;
      startPolling();
    };
    eventsStatus.textContent = "Live (SSE).";
    stopPolling();
  } catch {
    startPolling();
  }
}

function startPolling() {
  stopPolling();
  eventsStatus.textContent = "Live (polling).";
  pollTimer = setInterval(async () => {
    if (!selectedDeviceId) return;
    const resp = await api(`/devices/${selectedDeviceId}/events`);
    const lines = resp.events.map(e =>
      `${e.ts} | ${e.topic || "-"} | ${e.operation || "-"} | ${JSON.stringify(e.message)}`
    );
    setEventsText(lines.slice(-200));
  }, 1000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

addForm.onsubmit = async (ev) => {
  ev.preventDefault();
  addStatus.textContent = "Adding…";

  const fd = new FormData(addForm);
  const payload = {
    name: fd.get("name"),
    host: fd.get("host"),
    port: Number(fd.get("port")),
    username: fd.get("username"),
    password: fd.get("password"),
  };

  try {
    await api("/devices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    addStatus.textContent = "Added.";
    addForm.reset();
    await refreshDevices();
  } catch (e) {
    addStatus.textContent = `Error: ${e.message}`;
  }
};

clearEventsBtn.onclick = () => {
  eventsBox.textContent = "";
};

refreshDevices().catch(err => {
  deviceList.textContent = `Failed to load devices: ${err.message}`;
});
