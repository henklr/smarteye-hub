import { uid, escapeHtml, apiGet, apiPost, setPath } from "./common.js";

let scenes = [];
const grid = document.getElementById("grid");
const status = document.getElementById("status");

function ok(msg) { status.className = "status ok"; status.textContent = msg; }
function err(msg) { status.className = "status err"; status.textContent = msg; }

function render() {
    grid.innerHTML = "";
    if (!scenes.length) {
        grid.innerHTML = `<div class="card"><b>No scenes yet.</b><div class="hint">Click “New Scene”.</div></div>`;
        return;
    }

    scenes.forEach((s, i) => {
        s.snapshots = s.snapshots || {};
        const card = document.createElement("div");
        card.className = "card";

        card.innerHTML = `
  <div class="cardHeader">
    <div>
      <div class="title">${escapeHtml(s.name || "Unnamed Scene")}</div>
      <div class="subtitle"><span class="pill">ID: ${escapeHtml(s.id || "")}</span></div>
    </div>
    <div class="toggle">
      <input
        type="checkbox"
        ${s.enabled !== false ? "checked" : ""}
        data-i="${i}"
        data-k="enabled"
        class="toggleEnabled"
      >
      Enabled
    </div>
  </div>

  <label>Name</label>
  <input type="text" value="${escapeHtml(s.name || "")}" data-i="${i}" data-k="name" class="field">

  <label>Scene ID</label>
  <input type="text" value="${escapeHtml(s.id || "")}" data-i="${i}" data-k="id" class="field">

  <label>Camera IP</label>
  <input
    type="text"
    value="${escapeHtml(s.camera_ip || "")}"
    placeholder="172.16.0.100"
    data-i="${i}"
    data-k="camera_ip"
    class="field"
  >

  <label>Channel</label>
  <input type="number" value="${s.channel || 1}" min="1" data-i="${i}" data-k="channel" class="field">

  <div class="section">
    <div class="sectionTitle">Snapshots</div>

    <label>Snapshot count</label>
    <input
      type="number"
      value="${s.snapshots?.count ?? 5}"
      min="1"
      max="20"
      data-i="${i}"
      data-k="snapshots.count"
      class="field"
    >

    <div class="row">
      <div style="flex:1;">
        <label>Before seconds</label>
        <input
          type="number"
          value="${s.snapshots?.before_seconds ?? 5}"
          min="0"
          max="120"
          data-i="${i}"
          data-k="snapshots.before_seconds"
          class="field"
        >
      </div>
      <div style="flex:1;">
        <label>After seconds</label>
        <input
          type="number"
          value="${s.snapshots?.after_seconds ?? 20}"
          min="0"
          max="300"
          data-i="${i}"
          data-k="snapshots.after_seconds"
          class="field"
        >
      </div>
    </div>

    <label>Selection strategy</label>
    <select data-i="${i}" data-k="snapshots.strategy" class="field">
      ${["evenly_spread", "latest", "earliest"].map(opt => `
        <option value="${opt}" ${(s.snapshots?.strategy || "evenly_spread") === opt ? "selected" : ""}>${opt}</option>
      `).join("")}
    </select>
  </div>

  <div class="section">
    <div class="sectionTitle">Model</div>

    <label>Model</label>
    <input type="text" value="${escapeHtml(s.model || "gpt-5.1")}" data-i="${i}" data-k="model" class="field">

    <label>Prompt</label>
    <textarea
      data-i="${i}"
      data-k="prompt"
      placeholder="Describe what the model should do..."
      class="field"
    >${escapeHtml(s.prompt || "")}</textarea>
  </div>

  <div class="row" style="margin-top:12px;">
    <button class="secondary" data-test="${i}">Test</button>
    <button class="danger" data-del="${i}">Delete</button>
  </div>

  <div class="hint">
    Test uses a fake event. For a real alarm it will use the alarm timestamp and pick snapshots in window.
  </div>
`;

        grid.appendChild(card);
    });

    // wiring inputs
    document.querySelectorAll("input[data-k], textarea[data-k], select[data-k]").forEach(el => {
        el.oninput = (e) => {
            const i = Number(e.target.dataset.i);
            const k = e.target.dataset.k;
            setKey(scenes[i], k, e.target.type === "checkbox" ? e.target.checked : e.target.value);
        };
        el.onchange = el.oninput;
    });

    // delete
    document.querySelectorAll("button[data-del]").forEach(btn => {
        btn.onclick = (e) => {
            const i = Number(e.target.dataset.del);
            if (!confirm("Delete this scene?")) return;
            scenes.splice(i, 1);
            render();
            ok("Deleted (not saved yet). Click Save.");
        };
    });

    // test
    document.querySelectorAll("button[data-test]").forEach(btn => {
        btn.onclick = async (e) => {
            const i = Number(e.target.dataset.test);
            const scene = scenes[i];

            const fakeEvent = {
                id: "test-event-" + Date.now(),
                timestamp: new Date().toISOString(),
                camera_ip: scene.camera_ip,
                channel: scene.channel,
                code: "FaceDetection",
                action: "Start"
            };

            try {
                const result = await apiPost(`/api/scenes/test/${scene.id}`, fakeEvent);
                ok("Test run complete. Check output in dev console (F12)");
                console.log("Scene test result:", result);
            } catch (ex) {
                err("Test failed: " + ex.message);
            }
        };
    });
}

function setKey(obj, keyPath, value) {
    const parts = keyPath.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
        cur = cur[p];
    }
    const last = parts[parts.length - 1];

    // coerce numbers
    if (value !== "" && ["channel", "snapshots.count", "snapshots.before_seconds", "snapshots.after_seconds"].includes(keyPath)) {
        value = Number(value);
    }
    cur[last] = value;
}

async function load() {
    try {
        scenes = await apiGet("/api/scenes");
        if (!Array.isArray(scenes)) scenes = [];
        scenes.forEach(s => {
            s.id = s.id || uid();
            s.name = s.name || "New Scene";
            if (s.enabled === undefined) s.enabled = true;
            s.snapshots = s.snapshots || { count: 5, before_seconds: 5, after_seconds: 20, strategy: "evenly_spread" };
            s.model = s.model || "gpt-5.1";
            s.prompt = s.prompt || "";
        });
        render();
        ok("Loaded!");
    } catch (ex) {
        err("Load failed: " + ex.message);
    }
}

async function save() {
    try {
        await apiPost("/api/scenes", scenes);
        ok("Saved!");
        await load();
    } catch (ex) {
        err("Save failed: " + ex.message);
    }
}

document.getElementById("newBtn").onclick = () => {
    scenes.unshift({
        id: uid(),
        name: "New Scene",
        enabled: true,
        camera_ip: "",
        channel: 1,
        snapshots: { count: 5, before_seconds: 5, after_seconds: 20, strategy: "evenly_spread" },
        model: "gpt-5.1",
        prompt: "Analyze the frames. Return JSON with flag, category, reason."
    });
    render();
    ok("Created new scene (not saved yet).");
};
document.getElementById("reloadBtn").onclick = load;
document.getElementById("saveBtn").onclick = save;

load();
