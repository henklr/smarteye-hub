import { uid, escapeHtml, apiGet, apiPost, setPath } from "./common.js";

let automations = [];
let scenes = []; // loaded from /api/scenes
let mode = localStorage.getItem("automation_mode") || "builder"; // "builder" | "json"

const statusEl = document.getElementById("status");
const gridEl = document.getElementById("grid");
const builderWrap = document.getElementById("builderWrap");
const editorWrap = document.getElementById("editorWrap");
const editorEl = document.getElementById("editor");
const toggleModeBtn = document.getElementById("toggleModeBtn");

async function loadScenes() {
    try {
        const res = await fetch("/api/scenes");
        if (!res.ok) throw new Error(await res.text());
        scenes = await res.json();
        if (!Array.isArray(scenes)) scenes = [];
    } catch (e) {
        scenes = []; // fallback: empty list
        console.warn("Failed to load scenes:", e);
    }
}
function setOk(msg) {
    statusEl.className = "status ok";
    statusEl.textContent = msg;
}
function setErr(msg) {
    statusEl.className = "status err";
    statusEl.textContent = msg;
}
function clearStatus() {
    statusEl.className = "status";
    statusEl.textContent = "";
}

function normalize() {
    if (!Array.isArray(automations)) automations = [];
    automations.forEach(a => {
        a.id = a.id || uid("auto");
        a.name = a.name || "New automation";
        a.enabled = a.enabled !== false;

        a.conditions = a.conditions || [];
        a.actions = a.actions || [];
    });
}

function syncEditorFromData() {
    editorEl.value = JSON.stringify(automations, null, 2);
}

function syncDataFromEditor() {
    automations = JSON.parse(editorEl.value);
    normalize();
}

function applyMode() {
    if (mode === "json") {
        builderWrap.style.display = "none";
        editorWrap.style.display = "block";
        toggleModeBtn.textContent = "Switch to Builder";
        syncEditorFromData();
    } else {
        builderWrap.style.display = "block";
        editorWrap.style.display = "none";
        toggleModeBtn.textContent = "Switch to JSON";
        renderBuilder();
    }
    localStorage.setItem("automation_mode", mode);
}

function renderBuilder() {
    gridEl.innerHTML = "";

    if (!automations.length) {
        gridEl.innerHTML = `<div class="card"><b>No automations yet.</b><div class="hint">Click “New Automation”.</div></div>`;
        return;
    }

    for (let i = 0; i < automations.length; i++) {
        const a = automations[i];
        const card = document.createElement("div");
        card.className = "card";

        card.innerHTML = `
      <div class="cardHeader">
        <div>
          <div class="title">${escapeHtml(a.name || "Unnamed Automation")}</div>
          <div class="subtitle"><span class="pill">ID: ${escapeHtml(a.id)}</span></div>
        </div>
        <div class="toggle">
          <input type="checkbox" ${a.enabled ? "checked" : ""} data-i="${i}" class="toggleEnabled">
          Enabled
        </div>
      </div>

      <label>Name</label>
      <input type="text" value="${escapeHtml(a.name)}" data-i="${i}" data-path="name" class="field">

      <div class="section">
        <div class="sectionTitle">Conditions (ALL must match)</div>
        <div class="items" id="conds-${i}"></div>
        <div class="row" style="margin-top:10px;">
          <button class="secondary addCondBtn" data-i="${i}">+ Add Condition</button>
        </div>
      </div>

      <div class="section">
        <div class="sectionTitle">Actions</div>
        <div class="items" id="acts-${i}"></div>
        <div class="row" style="margin-top:10px;">
          <button class="secondary addActBtn" data-i="${i}">+ Add Action</button>
        </div>
      </div>

      <div class="row" style="margin-top:12px;">
        <button class="danger deleteBtn" data-i="${i}">Delete</button>
      </div>
    `;

        gridEl.appendChild(card);

        // Conditions
        const condsEl = card.querySelector(`#conds-${i}`);
        const conds = a.conditions || [];
        if (!conds.length) {
            condsEl.innerHTML = `<div class="hint">No conditions.</div>`;
        } else {
            condsEl.innerHTML = "";
            conds.forEach((c, ci) => {
                const item = document.createElement("div");
                item.className = "item";
                item.innerHTML = `
          <div class="itemHeader">
            <strong>Condition</strong>
            <button class="danger removeCondBtn" data-i="${i}" data-ci="${ci}">Remove</button>
          </div>
          <div class="miniRow3">
            <div>
              <label>Field</label>
              <input type="text" placeholder="camera_ip" value="${escapeHtml(c.field ?? "")}" data-i="${i}" data-ci="${ci}" data-key="field" class="condField">
            </div>
            <div>
              <label>Operator</label>
              <select data-i="${i}" data-ci="${ci}" data-key="op" class="condField">
                ${["equals", "not_equals", "contains", "in", "exists"].map(op => `
                  <option value="${op}" ${(c.op ?? "equals") === op ? "selected" : ""}>${op}</option>
                `).join("")}
              </select>
            </div>
            <div>
              <label>Value</label>
              <input type="text" placeholder='172.16.0.100 or ["a","b"]' value="${escapeHtml(c.value ?? "")}" data-i="${i}" data-ci="${ci}" data-key="value" class="condField">
            </div>
          </div>
          <div class="hint">For <span class="code">in</span>, use JSON array like <span class="code">["a","b"]</span>. For <span class="code">exists</span>, value is ignored.</div>
        `;
                condsEl.appendChild(item);
            });
        }

        // Actions
        const actsEl = card.querySelector(`#acts-${i}`);
        const acts = a.actions || [];
        if (!acts.length) {
            actsEl.innerHTML = `<div class="hint">No actions.</div>`;
        } else {
            actsEl.innerHTML = "";
            acts.forEach((act, ai) => {
                const type = act.type || "log";
                const item = document.createElement("div");
                item.className = "item";

                item.innerHTML = `
          <div class="itemHeader">
            <strong>Action</strong>
            <button class="danger removeActBtn" data-i="${i}" data-ai="${ai}">Remove</button>
          </div>

          <label>Type</label>
          <select data-i="${i}" data-ai="${ai}" data-key="type" class="actField">
            ${["log", "webhook", "analyze"].map(t => `<option value="${t}" ${t === type ? "selected" : ""}>${t}</option>`).join("")}
          </select>

          <div class="actFields"></div>
        `;

                actsEl.appendChild(item);

                const fieldsEl = item.querySelector(".actFields");

                if (type === "log") {
                    fieldsEl.innerHTML = `
            <label>Message</label>
            <textarea data-i="${i}" data-ai="${ai}" data-key="message" class="actField"
              placeholder="Face detected on {{camera_ip}} at {{locale_time}}">${escapeHtml(act.message ?? "")}</textarea>
          `;
                } else if (type === "webhook") {
                    fieldsEl.innerHTML = `
            <div class="miniRow">
              <div>
                <label>URL</label>
                <input type="text" data-i="${i}" data-ai="${ai}" data-key="url" class="actField" placeholder="http://..." value="${escapeHtml(act.url ?? "")}">
              </div>
              <div>
                <label>Method</label>
                <select data-i="${i}" data-ai="${ai}" data-key="method" class="actField">
                  ${["POST", "PUT", "PATCH", "GET"].map(m => `<option value="${m}" ${(act.method ?? "POST").toUpperCase() === m ? "selected" : ""}>${m}</option>`).join("")}
                </select>
              </div>
            </div>
            <label>Payload (JSON)</label>
            <textarea data-i="${i}" data-ai="${ai}" data-key="payload_json" class="actField"
              placeholder='{"text":"Alarm {{code}} from {{camera_ip}}"}'>${escapeHtml(act.payload_json ?? JSON.stringify(act.payload ?? {}, null, 2))}</textarea>
            <div class="hint">Payload supports templates. Must be valid JSON.</div>
          `;
                } else if (type === "analyze") {
                    const currentSceneId = act.scene_id || "";

                    fieldsEl.innerHTML = `
          <label>Scene</label>
          <select data-i="${i}" data-ai="${ai}" data-key="scene_id" class="actField">
            <option value="">(select scene)</option>
            ${scenes.map(s => `
              <option value="${escapeHtml(s.id)}" ${s.id === currentSceneId ? "selected" : ""}>
                ${escapeHtml(s.name ? s.name + " — " : "")}${escapeHtml(s.id)}
              </option>
            `).join("")}
          </select>

          <div class="hint">
            Scenes are configured in <a href="/scenes.html">Scenes</a>.
            Automation will run analysis and receive JSON result.
          </div>
        `;
                }
            });
        }
    }

    wireBuilderEvents();
}

function wireBuilderEvents() {
    document.querySelectorAll(".toggleEnabled").forEach(el => {
        el.onchange = (e) => {
            const i = Number(e.target.dataset.i);
            automations[i].enabled = e.target.checked;
            clearStatus();
        };
    });

    document.querySelectorAll(".field").forEach(el => {
        el.oninput = (e) => {
            const i = Number(e.target.dataset.i);
            const path = e.target.dataset.path;
            setPath(automations[i], path, e.target.value);
            clearStatus();
            if (mode === "json") syncEditorFromData();
        };
    });

    document.querySelectorAll(".condField").forEach(el => {
        el.oninput = (e) => {
            const i = Number(e.target.dataset.i);
            const ci = Number(e.target.dataset.ci);
            const key = e.target.dataset.key;
            automations[i].conditions[ci][key] = e.target.value;
            clearStatus();
        };
    });

    document.querySelectorAll(".actField").forEach(el => {
        el.oninput = (e) => {
            const i = Number(e.target.dataset.i);
            const ai = Number(e.target.dataset.ai);
            const key = e.target.dataset.key;

            if (key === "payload_json") {
                automations[i].actions[ai].payload_json = e.target.value;
            } else {
                automations[i].actions[ai][key] = e.target.value;
            }
            clearStatus();
        };

        el.onchange = (e) => {
            const i = Number(e.target.dataset.i);
            const ai = Number(e.target.dataset.ai);
            const key = e.target.dataset.key;

            if (key === "type") {
                const newType = e.target.value;
                automations[i].actions[ai].type = newType;

                if (newType === "log") {
                    automations[i].actions[ai] = { type: "log", message: "" };
                } else if (newType === "webhook") {
                    automations[i].actions[ai] = {
                        type: "webhook",
                        url: "",
                        method: "POST",
                        payload_json: "{}"
                    };
                } else if (newType === "analyze") {
                    automations[i].actions[ai] = {
                        type: "analyze",
                        scene_id: ""
                    };
                }

                renderBuilder();
            }
            clearStatus();
        };
    });

    document.querySelectorAll(".addCondBtn").forEach(btn => {
        btn.onclick = (e) => {
            const i = Number(e.target.dataset.i);
            automations[i].conditions.push({ field: "", op: "equals", value: "" });
            renderBuilder();
        };
    });

    document.querySelectorAll(".removeCondBtn").forEach(btn => {
        btn.onclick = (e) => {
            const i = Number(e.target.dataset.i);
            const ci = Number(e.target.dataset.ci);
            automations[i].conditions.splice(ci, 1);
            renderBuilder();
        };
    });

    document.querySelectorAll(".addActBtn").forEach(btn => {
        btn.onclick = (e) => {
            const i = Number(e.target.dataset.i);
            automations[i].actions.push({ type: "log", message: "" });
            renderBuilder();
        };
    });

    document.querySelectorAll(".removeActBtn").forEach(btn => {
        btn.onclick = (e) => {
            const i = Number(e.target.dataset.i);
            const ai = Number(e.target.dataset.ai);
            automations[i].actions.splice(ai, 1);
            renderBuilder();
        };
    });

    document.querySelectorAll(".deleteBtn").forEach(btn => {
        btn.onclick = (e) => {
            const i = Number(e.target.dataset.i);
            if (!confirm("Delete this automation?")) return;
            automations.splice(i, 1);
            renderBuilder();
            setOk("Deleted (not saved yet). Click Save.");
        };
    });
}

async function loadAutomations() {
    try {
        clearStatus();
        automations = await apiGet("/api/automations");
        normalize();
        applyMode();
        setOk("Loaded ✅");
    } catch (e) {
        setErr("Load failed: " + e.message);
    }
}

async function saveAutomations() {
    try {
        clearStatus();

        // If in JSON mode, parse editor first
        if (mode === "json") {
            syncDataFromEditor();
        }

        for (const a of automations) {
            for (const c of (a.conditions || [])) {
                if (c.op === "in") {
                    try {
                        c.value = JSON.parse(c.value);
                        if (!Array.isArray(c.value)) throw new Error();
                    } catch {
                        throw new Error(`Condition "in" value must be JSON array in "${a.name}"`);
                    }
                }
            }

            for (const act of (a.actions || [])) {
                if (act.type === "webhook") {
                    try {
                        act.payload = JSON.parse(act.payload_json || "{}");
                    } catch {
                        throw new Error(`Webhook payload must be valid JSON in "${a.name}"`);
                    }
                    delete act.payload_json;
                }
            }
        }

        await apiPost("/api/automations", automations);
        setOk("Saved ✅");
        await loadAutomations();
    } catch (e) {
        setErr("Save failed: " + e.message);
    }
}

async function newAutomation() {
    const a = {
        id: uid("auto"),
        name: "New automation",
        enabled: true,
        conditions: [{ field: "code", op: "equals", value: "" }],
        actions: [{ type: "log", message: "Automation fired for {{code}} from {{camera_ip}}" }]
    };
    automations.unshift(a);
    applyMode();
    setOk("Created new automation (not saved yet).");
}

async function sendTestEvent() {
    try {
        clearStatus();
        const event = {
            id: "test-event-" + Date.now(),
            action: "Start",
            code: "FaceDetection",
            camera_ip: "172.16.0.100",
            locale_time: new Date().toISOString()
        };
        await apiPost("/api/automations/test", event);
        setOk("Test event sent ✅ Check docker logs + automation_runs.jsonl");
    } catch (e) {
        setErr("Test failed: " + e.message);
    }
}

toggleModeBtn.onclick = () => {
    mode = (mode === "builder") ? "json" : "builder";
    applyMode();
};

document.getElementById("reloadBtn").onclick = loadAutomations;
document.getElementById("saveBtn").onclick = saveAutomations;
document.getElementById("newBtn").onclick = newAutomation;
document.getElementById("testBtn").onclick = sendTestEvent;

(async () => {
    await loadScenes();
    await loadAutomations();
})();
