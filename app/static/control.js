(() => {
  "use strict";

  // SSE pushes invalidation messages from the server (NOX state, variables,
  // doors list, tiles). We keep a slow background poll as a safety net in
  // case the SSE connection drops and reconnect handling misses something.
  const FALLBACK_POLL_INTERVAL_MS = 15000;
  const POST_ACTION_REFRESH_DELAYS_MS = [200, 600];
  const SSE_RECONNECT_DELAY_MS = 3000;

  const state = {
    items: [],
    flows: [],
    doors: [],
    publicVariables: [],
    nox: { areas: [], tio_areas: [], configured: false },
    editing: false,
    busyTiles: new Set(),
    tileErrors: {},
    pollTimer: null,
    eventSource: null,
    sseReconnectTimer: null,
  };

  const ICONS = {
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z"/></svg>',
    door: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/><path d="M3 21h18"/><circle cx="15" cy="12" r="0.8" fill="currentColor"/></svg>',
    lightbulb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5.9 1.2.9 2v.3h6.2v-.3c0-.8.3-1.5.9-2A7 7 0 0 0 12 2z"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8z"/><path d="M12 18v4"/></svg>',
    fan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><path d="M12 2a4 4 0 0 1 4 4c0 2-2 4-4 6-2-2-4-4-4-6a4 4 0 0 1 4-4z"/><path d="M2 12a4 4 0 0 1 4-4c2 0 4 2 6 4-2 2-4 4-6 4a4 4 0 0 1-4-4z"/><path d="M22 12a4 4 0 0 1-4 4c-2 0-4-2-6-4 2-2 4-4 6-4a4 4 0 0 1 4 4z"/><path d="M12 22a4 4 0 0 1-4-4c0-2 2-4 4-6 2 2 4 4 4 6a4 4 0 0 1-4 4z"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="14" r="4"/><path d="m10.5 11 9-9"/><path d="m18 5 2 2"/><path d="m15 8 2 2"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m13 2-9 12h7l-2 8 9-12h-7l2-8z"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  };

  const DEFAULT_KIND_ICON = { alarm_area: "shield", door: "door", appliance: "lightbulb" };

  const KIND_LABEL = {
    alarm_area: "Alarm area",
    door: "Door",
    appliance: "Appliance",
  };

  const ICON_OPTIONS = ["shield", "door", "lightbulb", "plug", "fan", "key", "bolt"];

  // ── Utils ────────────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else if (v != null && v !== false) node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json())?.detail || detail; } catch (e) {}
      throw new Error(detail);
    }
    return res.json();
  }

  function debounce(fn, wait) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────────

  async function bootstrap() {
    bindHeaderEvents();
    bindModalEvents();
    try {
      await Promise.all([loadCatalog(), loadControls()]);
    } catch (e) {
      console.warn("Control: bootstrap failed", e);
    }
    render();
    openControlStream();
    startPolling();
    window.addEventListener("beforeunload", () => {
      try { state.eventSource?.close(); } catch (e) {}
    });
  }

  async function loadCatalog() {
    const [flowsRes, doorsRes, varsRes, noxRes] = await Promise.allSettled([
      api("/api/flows"),
      api("/api/doors"),
      api("/api/public-variables"),
      api("/api/nox/state"),
    ]);

    if (flowsRes.status === "fulfilled") {
      state.flows = (flowsRes.value?.items || []).map((f) => ({ id: f.id, name: f.name }));
    }

    if (doorsRes.status === "fulfilled") {
      state.doors = doorsRes.value?.items || [];
    }

    if (varsRes.status === "fulfilled") {
      state.publicVariables = varsRes.value?.items || [];
    }

    if (noxRes.status === "fulfilled") {
      applyNoxState(noxRes.value?.state || {});
    }
  }

  async function loadControls() {
    const res = await api("/api/controls");
    state.items = res.items || [];
  }

  async function saveControls() {
    await api("/api/controls", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: state.items }),
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refreshLiveState, FALLBACK_POLL_INTERVAL_MS);
  }

  function openControlStream() {
    if (state.eventSource) {
      try { state.eventSource.close(); } catch (e) {}
    }
    if (state.sseReconnectTimer) {
      clearTimeout(state.sseReconnectTimer);
      state.sseReconnectTimer = null;
    }
    let es;
    try {
      es = new EventSource("/api/control/stream");
    } catch (e) {
      console.warn("Control: SSE unavailable, falling back to poll only", e);
      return;
    }
    state.eventSource = es;
    es.onmessage = (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      handleStreamMessage(payload);
    };
    es.onerror = () => {
      try { es.close(); } catch (e) {}
      state.eventSource = null;
      // Reconnect with a short delay; the fallback poll keeps the UI alive
      // in the meantime.
      state.sseReconnectTimer = setTimeout(openControlStream, SSE_RECONNECT_DELAY_MS);
    };
  }

  async function handleStreamMessage(payload) {
    const source = payload?.source;
    if (!source || source === "connected") return;
    try {
      if (source === "nox") {
        const res = await api("/api/nox/state");
        applyNoxState(res?.state || {});
      } else if (source === "variables") {
        const res = await api("/api/public-variables");
        state.publicVariables = res?.items || [];
      } else if (source === "doors") {
        const res = await api("/api/doors");
        state.doors = res?.items || [];
      } else if (source === "tiles") {
        const res = await api("/api/controls");
        state.items = res?.items || [];
      }
      renderTilesOnly();
    } catch (e) {
      console.warn(`Control: refresh after SSE (${source}) failed`, e);
    }
  }

  function applyNoxState(nox) {
    state.nox.areas = (nox.modbus?.areas) || [];
    state.nox.tio_areas = Object.entries(nox.tio?.areas || {}).map(([id, info]) => ({
      id, label: info.label || `Area ${id}`, state: info.state,
    }));
    state.nox.configured = !!nox.enabled;
  }

  async function refreshLiveState() {
    try {
      const [varsRes, noxRes] = await Promise.allSettled([
        api("/api/public-variables"),
        api("/api/nox/state"),
      ]);
      if (varsRes.status === "fulfilled") {
        state.publicVariables = varsRes.value?.items || [];
      }
      if (noxRes.status === "fulfilled") {
        applyNoxState(noxRes.value?.state || {});
      }
      renderTilesOnly();
    } catch (e) {
      console.warn("Control: refresh failed", e);
    }
  }

  // ── Header / edit toggle ─────────────────────────────────────────────────────

  function bindHeaderEvents() {
    $("controlEditToggle").addEventListener("click", () => {
      state.editing = !state.editing;
      document.querySelector(".controlPage").classList.toggle("is-editing", state.editing);
      $("controlEditToggle").textContent = state.editing ? "Done" : "Edit";
      $("controlAddBtn").classList.toggle("hidden", !state.editing);
      render();
    });

    $("controlAddBtn").addEventListener("click", () => openTileModal(null));
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function render() {
    renderTilesOnly();
    const empty = state.items.length === 0 && !state.editing;
    $("controlEmpty").classList.toggle("hidden", !empty);
  }

  function renderTilesOnly() {
    const grid = $("controlGrid");
    grid.innerHTML = "";
    for (const item of state.items) {
      grid.appendChild(buildTile(item));
    }
    if (state.editing) {
      grid.appendChild(buildAddCard());
    }
  }

  function buildAddCard() {
    return el(
      "button",
      { class: "tileAddCard", type: "button", onclick: () => openTileModal(null) },
      [
        el("span", { html: ICONS.plus }),
        el("span", { text: "Add tile" }),
      ]
    );
  }

  function buildTile(item) {
    const live = computeLiveState(item);
    const card = el("div", { class: "tile", "data-tile-id": item.id });
    card.classList.add(`tile-${live.cssClass}`);
    if (state.busyTiles.has(item.id)) card.classList.add("tile-busy");
    if (live.incomplete) card.classList.add("tile-incomplete");

    const head = el("div", { class: "tileHead" }, [
      el("div", { class: "tileIcon", html: ICONS[item.icon] || ICONS[DEFAULT_KIND_ICON[item.kind]] || ICONS.bolt }),
      el("div", { class: "tileTitle" }, [
        el("div", { class: "tileLabel", text: item.label }),
        el("div", { class: "tileSubLabel", text: KIND_LABEL[item.kind] || item.kind }),
      ]),
      el("button", {
        class: "tileEditBtn",
        type: "button",
        title: "Configure",
        html: ICONS.pencil,
        onclick: (e) => { e.stopPropagation(); openTileModal(item); },
      }),
    ]);

    const stateRow = el("div", { class: "tileState" }, [
      el("span", { class: `tileStateBadge is-${live.badge}`, text: live.stateLabel }),
      live.subState ? el("span", { class: "tileStateText", text: live.subState }) : null,
    ]);

    card.appendChild(head);
    card.appendChild(stateRow);

    if (live.incomplete) {
      card.appendChild(el("div", { class: "tileIncompleteHint", text: "Not bound. Click the pencil to configure." }));
    }

    const actions = el("div", { class: "tileActions" });
    for (const action of live.actions) {
      const btn = el("button", {
        class: action.primary ? "btn btn-primary" : (action.danger ? "btn btn-danger" : "btn"),
        type: "button",
        text: action.label,
        onclick: () => runAction(item, action.id),
      });
      if (action.disabled) btn.setAttribute("disabled", "");
      actions.appendChild(btn);
    }
    if (live.actions.length) card.appendChild(actions);

    if (state.tileErrors[item.id]) {
      card.appendChild(el("div", { class: "tileError", text: state.tileErrors[item.id] }));
    }

    return card;
  }

  // ── Live-state resolution per tile kind ──────────────────────────────────────

  function computeLiveState(item) {
    if (item.kind === "alarm_area") return liveAlarmArea(item);
    if (item.kind === "door") return liveDoor(item);
    if (item.kind === "appliance") return liveAppliance(item);
    return { stateLabel: "Unknown", badge: "", actions: [], cssClass: "", incomplete: true };
  }

  function classifyAreaKind(code) {
    if (typeof code !== "number" || !Number.isFinite(code)) return "unknown";
    if (code >= 0 && code <= 6) return "intrusion";
    if (code === 7 || code === 8) return "virtual";
    return "adk";
  }

  function findNoxArea(areaId) {
    const numeric = Number(areaId);
    if (!Number.isFinite(numeric)) return null;
    return (state.nox.areas || []).find((a) => Number(a.area_id) === numeric) || null;
  }

  function noxAreaStateLabel(area) {
    if (!area) return { label: "Offline", badge: "" };
    if (area.alarm_active) return { label: "ALARM", badge: "bad" };
    const s = String(area.state || "").toLowerCase();
    if (s.includes("arm") && !s.includes("disarm")) return { label: "Armed", badge: "on" };
    if (s.includes("disarm") || s.includes("off")) return { label: "Disarmed", badge: "warn" };
    if (area.code === 1) return { label: "Disarmed", badge: "warn" };
    if (area.code === 5) return { label: "Armed", badge: "on" };
    if (area.state) return { label: String(area.state), badge: "" };
    return { label: "Unknown", badge: "" };
  }

  function liveAlarmArea(item) {
    const areaId = item.binding?.area_id;
    if (!areaId) {
      return { stateLabel: "Not configured", badge: "", actions: [], cssClass: "", incomplete: true };
    }
    const area = findNoxArea(areaId);
    if (!area) {
      return {
        stateLabel: state.nox.configured ? "No data" : "NOX offline",
        badge: "",
        actions: [],
        cssClass: "error",
      };
    }
    const ls = noxAreaStateLabel(area);
    const isArmed = ls.badge === "on";
    const isAlarm = !!area.alarm_active;
    return {
      stateLabel: ls.label,
      badge: ls.badge,
      subState: area.label || `Area ${areaId}`,
      cssClass: isAlarm ? "alarm" : (isArmed ? "armed" : "disarmed"),
      actions: [
        { id: "arm", label: "Arm", primary: !isArmed, disabled: isArmed },
        { id: "disarm", label: "Disarm", danger: isArmed, disabled: !isArmed && !isAlarm },
        ...(isAlarm ? [{ id: "ack_alarms", label: "Acknowledge", primary: true }] : []),
      ],
    };
  }

  function liveDoor(item) {
    const areaId = item.binding?.area_id;
    const doorRef = item.binding?.door_ref;
    const door = doorRef ? state.doors.find((d) => d.flow_id === doorRef.flow_id && d.node_id === doorRef.node_id) : null;
    if (!areaId && !doorRef) {
      return { stateLabel: "Not configured", badge: "", actions: [], cssClass: "", incomplete: true };
    }
    let stateLabel = "Ready";
    let subState = "";
    let badge = "warn";
    if (areaId) {
      const area = findNoxArea(areaId);
      if (area) {
        const s = String(area.state || "").toLowerCase();
        subState = area.label || `Area ${areaId}`;
        if (s.includes("open")) { stateLabel = "Open"; badge = "on"; }
        else if (s.includes("forced") || s.includes("alarm")) { stateLabel = String(area.state); badge = "bad"; }
        else if (s.includes("locked") || s.includes("closed")) { stateLabel = "Locked"; badge = "warn"; }
        else if (area.state) { stateLabel = String(area.state); }
      } else {
        stateLabel = state.nox.configured ? "No data" : "NOX offline";
        badge = "";
      }
    } else if (door) {
      stateLabel = "Ready";
      subState = door.flow_name ? `via ${door.flow_name}` : "";
    } else if (doorRef) {
      stateLabel = "Door missing";
      badge = "bad";
      subState = "Bound door no longer exists";
    }

    const doorAvailable = !!door;
    const incompleteForOpen = !doorAvailable;
    return {
      stateLabel,
      subState,
      badge,
      cssClass: badge === "on" ? "armed" : (badge === "bad" ? "alarm" : ""),
      actions: doorAvailable ? [{ id: "open_door", label: "Open", primary: true }] : [],
      incomplete: incompleteForOpen,
    };
  }

  function liveAppliance(item) {
    const varKey = item.binding?.state_variable;
    const onFlow = item.binding?.on_flow_id;
    const offFlow = item.binding?.off_flow_id;
    const toggleFlow = item.binding?.toggle_flow_id;

    const hasAction = !!(onFlow || offFlow || toggleFlow);
    if (!varKey && !hasAction) {
      return { stateLabel: "Not configured", badge: "", actions: [], cssClass: "", incomplete: true };
    }

    let isOn = null;
    let subState = "";
    if (varKey) {
      const v = state.publicVariables.find((p) => p.key === varKey);
      if (v) {
        const cv = v.current_value;
        isOn = cv === true || cv === 1 || cv === "1" || (typeof cv === "string" && cv.toLowerCase() === "true");
        subState = v.key;
      } else {
        subState = `Variable ${varKey} (missing)`;
      }
    }

    const actions = [];
    if (onFlow) actions.push({ id: "appliance_on", label: "On", primary: !isOn, disabled: isOn === true });
    if (offFlow) actions.push({ id: "appliance_off", label: "Off", disabled: isOn === false });
    if (toggleFlow && actions.length === 0) actions.push({ id: "appliance_toggle", label: "Toggle", primary: true });
    else if (toggleFlow) actions.push({ id: "appliance_toggle", label: "Toggle" });

    let badge = "";
    let stateLabel = "";
    if (isOn === true) { badge = "on"; stateLabel = "On"; }
    else if (isOn === false) { badge = "warn"; stateLabel = "Off"; }
    else if (varKey) { stateLabel = "Unknown"; }
    else { stateLabel = "Manual"; }

    return {
      stateLabel,
      subState,
      badge,
      cssClass: isOn === true ? "on" : "",
      actions,
      incomplete: !hasAction,
    };
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async function runAction(item, actionId) {
    if (state.busyTiles.has(item.id)) return;
    state.busyTiles.add(item.id);
    delete state.tileErrors[item.id];
    renderTilesOnly();
    try {
      if (item.kind === "alarm_area") {
        if (actionId === "arm") {
          await api(`/api/nox/areas/${encodeURIComponent(item.binding.area_id)}/arm`, { method: "POST" });
        } else if (actionId === "disarm") {
          await api(`/api/nox/areas/${encodeURIComponent(item.binding.area_id)}/disarm`, { method: "POST" });
        } else if (actionId === "ack_alarms") {
          await api("/api/nox/ack-all-alarms", { method: "POST" });
        }
      } else if (item.kind === "door") {
        if (actionId === "open_door") {
          await fireDoor(item.binding.door_ref);
        }
      } else if (item.kind === "appliance") {
        if (actionId === "appliance_on") await fireFlow(item.binding.on_flow_id);
        else if (actionId === "appliance_off") await fireFlow(item.binding.off_flow_id);
        else if (actionId === "appliance_toggle") await fireFlow(item.binding.toggle_flow_id);
      }
      // Live state polls in the background; schedule a few quick refreshes
      // so the UI catches up sooner than the regular poll cadence.
      for (const delay of POST_ACTION_REFRESH_DELAYS_MS) {
        setTimeout(refreshLiveState, delay);
      }
    } catch (e) {
      state.tileErrors[item.id] = e.message || String(e);
    } finally {
      state.busyTiles.delete(item.id);
      renderTilesOnly();
    }
  }

  async function fireFlow(flowId) {
    if (!flowId) throw new Error("No flow bound");
    await api(`/api/flows/run-manual/${encodeURIComponent(flowId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger_payload: { source: "control_page" } }),
    });
  }

  async function fireDoor(doorRef) {
    if (!doorRef || !doorRef.flow_id || !doorRef.node_id) throw new Error("No door bound");
    await api("/api/doors/fire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flow_id: doorRef.flow_id, node_id: doorRef.node_id }),
    });
  }

  // ── Modal ────────────────────────────────────────────────────────────────────

  let currentEdit = null; // null => new tile; otherwise object reference

  function bindModalEvents() {
    document.querySelectorAll("[data-modal-close]").forEach((el) => {
      el.addEventListener("click", closeModal);
    });
    $("tileSaveBtn").addEventListener("click", saveTileFromModal);
    $("tileDeleteBtn").addEventListener("click", deleteTileFromModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("tileModal").classList.contains("hidden")) closeModal();
    });
  }

  function openTileModal(item) {
    currentEdit = item ? { ...item, binding: { ...(item.binding || {}) } } : {
      id: "",
      kind: "alarm_area",
      label: "",
      icon: "shield",
      binding: {},
    };
    $("tileModalTitle").textContent = item ? "Edit tile" : "New tile";
    $("tileDeleteBtn").classList.toggle("hidden", !item);
    renderModalBody();
    $("tileModal").classList.remove("hidden");
    document.body.classList.add("modalOpen");
  }

  function closeModal() {
    $("tileModal").classList.add("hidden");
    document.body.classList.remove("modalOpen");
    currentEdit = null;
  }

  function renderModalBody() {
    const body = $("tileModalBody");
    body.innerHTML = "";

    const kindGrid = el("div", { class: "ctrlField" }, [
      el("label", { text: "Tile type" }),
      buildKindGrid(),
    ]);
    body.appendChild(kindGrid);

    body.appendChild(buildField("Label", el("input", {
      type: "text",
      value: currentEdit.label || "",
      placeholder: kindPlaceholder(currentEdit.kind),
      oninput: (e) => { currentEdit.label = e.target.value; },
    })));

    body.appendChild(buildField("Icon", buildIconSelect()));

    body.appendChild(buildBindingSection());
  }

  function buildKindGrid() {
    const grid = el("div", { class: "ctrlKindGrid" });
    for (const k of ["alarm_area", "door", "appliance"]) {
      const btn = el("button", {
        class: "ctrlKindBtn" + (currentEdit.kind === k ? " is-active" : ""),
        type: "button",
        onclick: () => {
          currentEdit.kind = k;
          if (!currentEdit.icon || ICON_OPTIONS.indexOf(currentEdit.icon) < 0) {
            currentEdit.icon = DEFAULT_KIND_ICON[k];
          }
          // Reset binding when switching kinds
          currentEdit.binding = {};
          renderModalBody();
        },
      }, [
        el("span", { html: ICONS[DEFAULT_KIND_ICON[k]] }),
        el("span", { text: KIND_LABEL[k] }),
      ]);
      grid.appendChild(btn);
    }
    return grid;
  }

  function buildIconSelect() {
    const sel = el("select", {
      onchange: (e) => { currentEdit.icon = e.target.value; },
    });
    for (const ic of ICON_OPTIONS) {
      const opt = el("option", { value: ic, text: ic });
      if (currentEdit.icon === ic) opt.setAttribute("selected", "");
      sel.appendChild(opt);
    }
    return sel;
  }

  function buildField(labelText, control, helpText, helpClass) {
    const wrap = el("div", { class: "ctrlField" }, [
      el("label", { text: labelText }),
      control,
    ]);
    if (helpText) wrap.appendChild(el("div", { class: "ctrlFieldHelp " + (helpClass || ""), text: helpText }));
    return wrap;
  }

  function buildBindingSection() {
    const group = el("div", { class: "ctrlBindingGroup" }, [
      el("div", { class: "ctrlBindingGroupHead", text: "Binding" }),
    ]);

    if (currentEdit.kind === "alarm_area") {
      group.appendChild(buildField(
        "NOX area",
        buildNoxAreaSelect(currentEdit.binding.area_id, (v) => { currentEdit.binding.area_id = v; }, { intrusionOnly: true }),
        state.nox.areas.length === 0 ? "No NOX areas detected. Configure NOX in System &rarr; NOX." : null,
        state.nox.areas.length === 0 ? "warn" : null,
      ));
    } else if (currentEdit.kind === "door") {
      group.appendChild(buildField(
        "Door",
        buildDoorSelect(currentEdit.binding.door_ref, (v) => { currentEdit.binding.door_ref = v; }),
        state.doors.length === 0
          ? "No Door nodes found. Add a Door node to a flow on the Flows page first."
          : "Pulses the configured relay/output when Open is clicked.",
        state.doors.length === 0 ? "warn" : null,
      ));
      group.appendChild(buildField(
        "NOX area for state (optional)",
        buildNoxAreaSelect(currentEdit.binding.area_id, (v) => { currentEdit.binding.area_id = v; }, { allowEmpty: true }),
        "Pick a NOX access-control area to display open/locked state.",
      ));
    } else if (currentEdit.kind === "appliance") {
      group.appendChild(buildField(
        "State variable (optional)",
        buildVariableSelect(currentEdit.binding.state_variable, (v) => { currentEdit.binding.state_variable = v; }),
        "Public variable that reflects on/off state. Used by the on/off badge.",
      ));
      group.appendChild(buildField(
        "Turn-on flow",
        buildFlowSelect(currentEdit.binding.on_flow_id, (v) => { currentEdit.binding.on_flow_id = v; }, { allowEmpty: true }),
        null,
      ));
      group.appendChild(buildField(
        "Turn-off flow",
        buildFlowSelect(currentEdit.binding.off_flow_id, (v) => { currentEdit.binding.off_flow_id = v; }, { allowEmpty: true }),
        null,
      ));
      group.appendChild(buildField(
        "Toggle flow (optional)",
        buildFlowSelect(currentEdit.binding.toggle_flow_id, (v) => { currentEdit.binding.toggle_flow_id = v; }, { allowEmpty: true }),
        "Used when on/off flows are not set, or shown as an extra Toggle button.",
      ));
    }

    return group;
  }

  function buildNoxAreaSelect(currentValue, onChange, opts = {}) {
    const sel = el("select", {
      onchange: (e) => onChange(e.target.value || ""),
    });
    if (opts.allowEmpty || !currentValue) {
      sel.appendChild(el("option", { value: "", text: opts.allowEmpty ? "— None —" : "— Select an area —" }));
    }
    let areas = state.nox.areas || [];
    if (opts.intrusionOnly) {
      areas = areas.filter((a) => {
        const kind = classifyAreaKind(typeof a.code === "number" ? a.code : null);
        return kind === "intrusion" || kind === "unknown";
      });
    }
    for (const a of areas) {
      const id = String(a.area_id);
      const stateText = a.state ? ` · ${a.state}` : "";
      const opt = el("option", { value: id, text: `${a.label || `Area ${id}`} (#${id})${stateText}` });
      if (String(currentValue) === id) opt.setAttribute("selected", "");
      sel.appendChild(opt);
    }
    if (currentValue && !areas.some((a) => String(a.area_id) === String(currentValue))) {
      const orphan = el("option", { value: String(currentValue), text: `Area ${currentValue} (offline)` });
      orphan.setAttribute("selected", "");
      sel.appendChild(orphan);
    }
    return sel;
  }

  function buildFlowSelect(currentValue, onChange, opts = {}) {
    const sel = el("select", { onchange: (e) => onChange(e.target.value || "") });
    sel.appendChild(el("option", { value: "", text: opts.allowEmpty ? "— None —" : "— Select a flow —" }));
    for (const f of state.flows) {
      const opt = el("option", { value: f.id, text: f.name });
      if (currentValue === f.id) opt.setAttribute("selected", "");
      sel.appendChild(opt);
    }
    if (currentValue && !state.flows.some((f) => f.id === currentValue)) {
      const orphan = el("option", { value: currentValue, text: `(missing flow ${currentValue})` });
      orphan.setAttribute("selected", "");
      sel.appendChild(orphan);
    }
    return sel;
  }

  function buildDoorSelect(currentValue, onChange) {
    const sel = el("select", {
      onchange: (e) => {
        const v = e.target.value;
        if (!v) return onChange(null);
        const door = state.doors.find((d) => d.id === v);
        onChange(door ? { flow_id: door.flow_id, node_id: door.node_id } : null);
      },
    });
    sel.appendChild(el("option", { value: "", text: "— Select a door —" }));
    const currentId = currentValue ? `${currentValue.flow_id}:${currentValue.node_id}` : "";
    for (const d of state.doors) {
      const opt = el("option", { value: d.id, text: `${d.name} (${d.flow_name})` });
      if (currentId === d.id) opt.setAttribute("selected", "");
      sel.appendChild(opt);
    }
    if (currentId && !state.doors.some((d) => d.id === currentId)) {
      const orphan = el("option", { value: currentId, text: `(missing door ${currentId})` });
      orphan.setAttribute("selected", "");
      sel.appendChild(orphan);
    }
    return sel;
  }

  function buildVariableSelect(currentValue, onChange) {
    const sel = el("select", { onchange: (e) => onChange(e.target.value || "") });
    sel.appendChild(el("option", { value: "", text: "— None —" }));
    for (const v of state.publicVariables) {
      const opt = el("option", { value: v.key, text: `${v.key} (${v.type})` });
      if (currentValue === v.key) opt.setAttribute("selected", "");
      sel.appendChild(opt);
    }
    if (currentValue && !state.publicVariables.some((v) => v.key === currentValue)) {
      const orphan = el("option", { value: currentValue, text: `${currentValue} (missing)` });
      orphan.setAttribute("selected", "");
      sel.appendChild(orphan);
    }
    return sel;
  }

  function kindPlaceholder(kind) {
    if (kind === "alarm_area") return "e.g. Office alarm";
    if (kind === "door") return "e.g. Front door";
    if (kind === "appliance") return "e.g. Living room lights";
    return "Tile name";
  }

  async function saveTileFromModal() {
    const draft = currentEdit;
    if (!draft) return;
    if (!draft.label || !draft.label.trim()) {
      alert("Label is required.");
      return;
    }
    if (!draft.icon) draft.icon = DEFAULT_KIND_ICON[draft.kind];
    const idx = state.items.findIndex((it) => it.id === draft.id);
    if (idx >= 0) {
      state.items[idx] = draft;
    } else {
      state.items.push(draft);
    }
    try {
      await saveControls();
      // refresh server-canonical IDs
      await loadControls();
      closeModal();
      await loadCatalog();
      render();
    } catch (e) {
      alert(`Save failed: ${e.message || e}`);
    }
  }

  async function deleteTileFromModal() {
    if (!currentEdit?.id) return;
    if (!confirm(`Delete tile "${currentEdit.label}"?`)) return;
    state.items = state.items.filter((it) => it.id !== currentEdit.id);
    try {
      await saveControls();
      closeModal();
      render();
    } catch (e) {
      alert(`Delete failed: ${e.message || e}`);
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", bootstrap);
})();
