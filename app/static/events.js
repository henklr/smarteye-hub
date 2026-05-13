(function () {
  "use strict";

  const el = (id) => document.getElementById(id);
  let eventsPageClosing = false;
  let eventsLoadController = null;
  let eventsSource = null;
  let eventsReconnectTimer = 0;

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.appendChild(document.createTextNode(str || ""));
    return div.innerHTML;
  }

  function formatTimestamp(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  function relativeTime(iso) {
    if (!iso) return "";
    try {
      const now = Date.now();
      const then = new Date(iso).getTime();
      const diff = Math.max(0, now - then);
      const s = Math.floor(diff / 1000);
      if (s < 60) return "just now";
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.floor(h / 24);
      if (d < 7) return `${d}d ago`;
      return formatTimestamp(iso);
    } catch {
      return iso;
    }
  }

  function renderEventRow(event) {
    const acked = event.acknowledged;
    const cls = acked ? "eventRow acknowledged" : "eventRow unacknowledged";
    const name = event.name || event.message || "Event";
    const priority = event.priority || "medium";

    // Meta line: priority badge + flow name + scenario badge + timestamp
    let metaParts = [];
    metaParts.push(`<span class="priorityBadge priority-${escapeHtml(priority)}">${escapeHtml(priority)}</span>`);
    if (event.flow_name) {
      metaParts.push(`<span>${escapeHtml(event.flow_name)}</span>`);
    }
    if (event.scenario_name) {
      metaParts.push(`<span class="eventBadge">${escapeHtml(event.scenario_name)}</span>`);
    }
    metaParts.push(`<span class="eventTimeRel" title="${escapeHtml(formatTimestamp(event.ts))}">${escapeHtml(relativeTime(event.ts))}</span>`);

    // Details
    let detailsHtml = "";
    if (event.details) {
      detailsHtml = `<div class="eventDetails">${escapeHtml(event.details)}</div>`;
    }

    // Trigger info
    let triggerHtml = "";
    if (event.trigger_info) {
      triggerHtml = `<div class="eventTrigger"><strong>Trigger:</strong> ${escapeHtml(event.trigger_info)}</div>`;
    }

    // AI Analysis
    let analysisHtml = "";
    if (event.analysis) {
      const trimmedAnalysis = event.analysis.trim();
      const isError = trimmedAnalysis.startsWith("[Error:");
      analysisHtml = `
        <div class="eventAnalysis${isError ? " is-error" : ""}">
          <div class="eventAnalysisLabel">${isError ? "Error" : "AI Analysis"}</div>
          <div class="eventAnalysisBody">${escapeHtml(trimmedAnalysis)}</div>
        </div>
      `;
    }

    // Snapshots
    let snapshotsHtml = "";
    if (event.snapshots && event.snapshots.length) {
      const thumbs = event.snapshots.map((snap) => {
        const label = snap.device_name || snap.device_id || "";
        if (snap.snapshot) {
          return `<img class="eventSnapshotThumb" src="${escapeHtml(snap.snapshot)}" data-full="${escapeHtml(snap.snapshot)}" alt="Snapshot from ${escapeHtml(label)}" title="${escapeHtml(label)}" />`;
        }
        return `<div class="eventSnapshotMissing" title="${escapeHtml(label)}">No snapshot</div>`;
      }).join("");
      snapshotsHtml = `<div class="eventSnapshots">${thumbs}</div>`;
    }

    // Recording references
    let recordingsHtml = "";
    if (event.recording_refs && event.recording_refs.length) {
      const links = event.recording_refs.map((ref) => {
        const label = ref.device_name || ref.device_id || "Camera";
        // recording_id is the event_id stored by the recording engine, which
        // is also the clip id. When present, deep-link straight to that clip
        // via the new /playback page; otherwise filter by camera.
        const recId = ref.recording_id || ref.event_id || ref.id || "";
        const cameraParam = ref.device_id ? `?camera=cam-${encodeURIComponent(ref.device_id)}` : "";
        const hash = recId ? `#${encodeURIComponent(recId)}` : "";
        return `<a class="eventRecordingLink" href="/playback${cameraParam}${hash}" title="View recording for ${escapeHtml(label)}">&#9654; ${escapeHtml(label)}</a>`;
      }).join("");
      recordingsHtml = `<div class="eventRecordings">${links}</div>`;
    }

    const hasBody = triggerHtml || analysisHtml || detailsHtml || snapshotsHtml || recordingsHtml;
    const bodyHtml = hasBody ? `<div class="eventBody">${triggerHtml}${analysisHtml}${detailsHtml}${snapshotsHtml}${recordingsHtml}</div>` : "";


    return `
      <div class="${cls}" data-event-id="${escapeHtml(event.id)}" data-ts="${escapeHtml(event.ts || "")}">
        <div class="eventHeader">
          <div class="eventIndicator priority-${escapeHtml(priority)}"></div>
          <div class="eventHeaderBody">
            <div class="eventName">${escapeHtml(name)}</div>
            <div class="eventMeta">
              ${metaParts.join('<span class="eventMetaSep">&middot;</span>')}
            </div>
          </div>
          <div class="eventActions">
            ${!acked ? `<button class="btn btnAck" data-event-id="${escapeHtml(event.id)}" type="button">Ack</button>` : ""}
            <button class="btn btn-danger btnArchive" data-event-id="${escapeHtml(event.id)}" type="button">Archive</button>
          </div>
        </div>
        ${bodyHtml}
      </div>
    `;
  }

  const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

  function sortEvents(events) {
    const mode = el("eventsSort")?.value || "newest";

    return [...events].sort((a, b) => {
      // Always keep unacknowledged above acknowledged
      if (!a.acknowledged && b.acknowledged) return -1;
      if (a.acknowledged && !b.acknowledged) return 1;

      if (mode === "priority") {
        const pa = PRIORITY_ORDER[a.priority || "medium"] ?? 2;
        const pb = PRIORITY_ORDER[b.priority || "medium"] ?? 2;
        if (pa !== pb) return pa - pb;
        return (b.ts || "").localeCompare(a.ts || "");
      }

      if (mode === "oldest") {
        return (a.ts || "").localeCompare(b.ts || "");
      }

      // newest (default)
      return (b.ts || "").localeCompare(a.ts || "");
    });
  }

  let _renderAbort = null;

  function renderEventsProgressive(events) {
    const list = el("eventsList");
    const empty = el("eventsEmpty");

    if (_renderAbort) { _renderAbort.abort = true; }
    const token = { abort: false };
    _renderAbort = token;

    if (!events.length) {
      list.innerHTML = "";
      list.appendChild(empty);
      empty.style.display = "";
      return;
    }

    if (empty) empty.style.display = "none";
    list.innerHTML = "";

    const sorted = sortEvents(events);
    const loading = document.createElement("div");
    loading.className = "eventsLoadingBar";
    loading.innerHTML = '<div class="eventsLoadingSpinner"></div><span>Loading events\u2026</span>';
    list.appendChild(loading);

    let i = 0;
    function renderNext() {
      if (token.abort) return;
      if (i >= sorted.length) {
        loading.remove();
        _renderAbort = null;
        return;
      }
      const tmp = document.createElement("div");
      tmp.innerHTML = renderEventRow(sorted[i]);
      const row = tmp.firstElementChild;
      row.classList.add("fadeIn");
      list.insertBefore(row, loading);
      i++;
      loading.querySelector("span").textContent = `Loading events\u2026 (${i}/${sorted.length})`;
      bindSingleRowActions(row);
      requestAnimationFrame(() => setTimeout(renderNext, 30));
    }
    renderNext();
  }

  function bindSingleRowActions(row) {
    // Expand/collapse on click (skip buttons, links, images)
    row.addEventListener("click", (e) => {
      if (e.target.closest("button, a, img")) return;
      row.classList.toggle("is-expanded");
    });

    row.querySelectorAll(".btnAck").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const eventId = btn.dataset.eventId;
        try {
          const resp = await fetch(`/api/events/${encodeURIComponent(eventId)}/acknowledge`, { method: "POST" });
          if (resp.ok) {
            const data = await resp.json();
            const idx = allEvents.findIndex(e => e.id === eventId);
            if (idx !== -1) {
              allEvents[idx] = data.event || { ...allEvents[idx], acknowledged: true };
              updateSummary();
              applyFilters();
              if (window.__smarteyeRefreshEventBadge) window.__smarteyeRefreshEventBadge();
            }
          }
        } catch (err) {
          console.error("Acknowledge failed:", err);
        }
      });
    });
    row.querySelectorAll(".btnArchive").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const eventId = btn.dataset.eventId;
        try {
          const resp = await fetch(`/api/events/${encodeURIComponent(eventId)}/archive`, { method: "POST" });
          if (resp.ok) {
            allEvents = allEvents.filter(e => e.id !== eventId);
            updateSummary();
            updateFlowFilter();
            applyFilters();
            if (window.__smarteyeRefreshEventBadge) window.__smarteyeRefreshEventBadge();
          }
        } catch (err) {
          console.error("Archive failed:", err);
        }
      });
    });
    row.querySelectorAll(".eventSnapshots").forEach((container) => {
      const imgs = Array.from(container.querySelectorAll(".eventSnapshotThumb"));
      const srcs = imgs.map(img => img.dataset.full).filter(Boolean);
      imgs.forEach((img, i) => {
        img.addEventListener("click", () => {
          if (srcs.length) openLightbox(srcs, i);
        });
      });
    });
  }

  let _lbSnapshots = [];
  let _lbIndex = 0;

  function openLightbox(snapshots, index) {
    _lbSnapshots = snapshots;
    _lbIndex = index;
    showLightboxImage();
    const lightbox = el("eventsLightbox");
    if (lightbox) {
      lightbox.classList.remove("hidden");
      lightbox.setAttribute("aria-hidden", "false");
    }
  }

  function showLightboxImage() {
    const lbImg = el("eventsLightboxImg");
    if (lbImg && _lbSnapshots[_lbIndex]) {
      lbImg.src = _lbSnapshots[_lbIndex];
    }
    const prev = el("eventsLightboxPrev");
    const next = el("eventsLightboxNext");
    if (prev) prev.disabled = _lbIndex <= 0;
    if (next) next.disabled = _lbIndex >= _lbSnapshots.length - 1;
    if (prev) prev.style.display = _lbSnapshots.length <= 1 ? "none" : "";
    if (next) next.style.display = _lbSnapshots.length <= 1 ? "none" : "";
  }

  function lightboxNav(dir) {
    const newIdx = _lbIndex + dir;
    if (newIdx < 0 || newIdx >= _lbSnapshots.length) return;
    _lbIndex = newIdx;
    showLightboxImage();
  }

  function closeLightbox() {
    const lightbox = el("eventsLightbox");
    if (lightbox) {
      lightbox.classList.add("hidden");
      lightbox.setAttribute("aria-hidden", "true");
    }
    const lbImg = el("eventsLightboxImg");
    if (lbImg) lbImg.src = "";
    _lbSnapshots = [];
    _lbIndex = 0;
  }

  let allEvents = [];

  /* ── Sound alert ─────────────────────────────────────────────────────── */

  let soundEnabled = localStorage.getItem("events_sound") === "true";

  function updateSoundBtn() {
    const btn = el("btnToggleSound");
    const iconOn = el("soundIconOn");
    const iconOff = el("soundIconOff");
    if (!btn) return;
    btn.classList.toggle("is-active", soundEnabled);
    if (iconOn) iconOn.classList.toggle("hidden", !soundEnabled);
    if (iconOff) iconOff.classList.toggle("hidden", soundEnabled);
  }

  function playAlertSound() {
    if (!soundEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.stop(ctx.currentTime + 0.35);
    } catch { /* ignore audio errors */ }
  }

  el("btnToggleSound")?.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem("events_sound", String(soundEnabled));
    updateSoundBtn();
  });
  updateSoundBtn();

  /* ── Expand / Collapse all ──────────────────────────────────────────── */

  let allExpanded = false;

  el("btnExpandAll")?.addEventListener("click", () => {
    allExpanded = !allExpanded;
    document.querySelectorAll(".eventRow").forEach((row) => {
      row.classList.toggle("is-expanded", allExpanded);
    });
    const btn = el("btnExpandAll");
    if (btn) btn.classList.toggle("is-active", allExpanded);
  });

  /* ── Sidebar section toggles ─────────────────────────────────────────── */

  document.querySelectorAll(".eventsSidebarToggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const block = btn.closest(".eventsSidebarBlock");
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!expanded));
      block.classList.toggle("is-collapsed", expanded);
    });
  });

  /* ── Clickable summary stats ─────────────────────────────────────────── */

  document.querySelectorAll("[data-filter-action]").forEach((stat) => {
    stat.addEventListener("click", () => {
      const action = stat.dataset.filterAction;
      if (!action) return;
      const [type, value] = action.split(":");

      // If clicking "Total", reset everything
      if (type === "status" && value === "all") {
        resetAllFilters();
        return;
      }

      // Reset all filters first, then apply the clicked one
      const statusAll = document.querySelector('input[name="statusFilter"][value="all"]');
      if (statusAll) statusAll.checked = true;
      document.querySelectorAll('input[name="priorityFilter"]').forEach((cb) => { cb.checked = true; });
      const flowAll = document.querySelector('input[name="flowFilter"][value="__all__"]');
      if (flowAll) flowAll.checked = true;
      const timeAll = document.querySelector('input[name="timeFilter"][value="all"]');
      if (timeAll) timeAll.checked = true;
      const searchInput = el("eventsSearchInput");
      if (searchInput) searchInput.value = "";

      if (type === "status") {
        const radio = document.querySelector(`input[name="statusFilter"][value="${value}"]`);
        if (radio) radio.checked = true;
      } else if (type === "priority") {
        document.querySelectorAll('input[name="priorityFilter"]').forEach((cb) => {
          cb.checked = cb.value === value;
        });
      }
      applyFilters();
    });
  });

  /* ── Filter state ────────────────────────────────────────────────────── */

  function getActiveFilters() {
    const statusEl = document.querySelector('input[name="statusFilter"]:checked');
    const status = statusEl ? statusEl.value : "all";

    const priorities = Array.from(document.querySelectorAll('input[name="priorityFilter"]:checked'))
      .map((cb) => cb.value);

    const flowEl = document.querySelector('input[name="flowFilter"]:checked');
    const flow = flowEl ? flowEl.value : "__all__";

    const timeEl = document.querySelector('input[name="timeFilter"]:checked');
    const time = timeEl ? timeEl.value : "all";

    const search = (el("eventsSearchInput")?.value || "").trim().toLowerCase();

    return { status, priorities, flow, time, search };
  }

  function isFiltered(filters) {
    if (filters.status !== "all") return true;
    if (filters.priorities.length < 5) return true;
    if (filters.flow !== "__all__") return true;
    if (filters.time !== "all") return true;
    if (filters.search) return true;
    return false;
  }

  function getTimeCutoff(range) {
    if (range === "all") return 0;
    const now = Date.now();
    if (range === "1h") return now - 3600000;
    if (range === "24h") return now - 86400000;
    if (range === "7d") return now - 604800000;
    return 0;
  }

  function filterEvents(events) {
    const { status, priorities, flow, time, search } = getActiveFilters();
    const cutoff = getTimeCutoff(time);

    return events.filter((ev) => {
      if (status === "unacknowledged" && ev.acknowledged) return false;
      if (status === "acknowledged" && !ev.acknowledged) return false;

      const prio = ev.priority || "medium";
      if (priorities.length && !priorities.includes(prio)) return false;

      if (flow !== "__all__" && ev.flow_name !== flow) return false;

      if (cutoff && ev.ts) {
        try { if (new Date(ev.ts).getTime() < cutoff) return false; } catch {}
      }

      if (search) {
        const name = (ev.name || ev.message || "").toLowerCase();
        const details = (ev.details || "").toLowerCase();
        const flowName = (ev.flow_name || "").toLowerCase();
        const scenario = (ev.scenario_name || "").toLowerCase();
        if (!name.includes(search) && !details.includes(search) && !flowName.includes(search) && !scenario.includes(search)) return false;
      }

      return true;
    });
  }

  function applyFilters() {
    const filters = getActiveFilters();
    const filtered = filterEvents(allEvents);
    renderEventsProgressive(filtered);
    updateFilterBar(filters, filtered);
  }

  const STAT_COLORS = {
    "status:unacknowledged": { color: "#c8a020",   border: "rgba(160,125,34,0.5)" },
    "priority:critical":     { color: "#e53e3e",   border: "rgba(229,62,62,0.5)" },
    "priority:high":         { color: "#dd6b20",   border: "rgba(221,107,32,0.5)" },
    "priority:medium":       { color: "#d69e2e",   border: "rgba(214,158,46,0.5)" },
    "priority:low":          { color: "#38a169",   border: "rgba(56,161,105,0.5)" },
  };

  document.querySelectorAll("[data-filter-action]").forEach((stat) => {
    const cfg = STAT_COLORS[stat.dataset.filterAction];
    if (!cfg) return;
    stat.style.setProperty("border-color", cfg.border, "important");
    const countEl = stat.querySelector(".eventsSumCount");
    if (countEl) countEl.style.color = cfg.color;
  });

  function updateFilterBar(filters, filtered) {
    const bar = el("eventsFilterBar");
    const label = el("eventsFilterBarLabel");
    if (!bar) return;

    const active = isFiltered(filters);
    bar.classList.toggle("hidden", !active);
    if (active && label) {
      const parts = [];
      if (filters.status !== "all") parts.push(filters.status);
      if (filters.priorities.length < 5) parts.push(`${filters.priorities.length} priorities`);
      if (filters.flow !== "__all__") parts.push(`flow: ${filters.flow}`);
      if (filters.time !== "all") parts.push(filters.time);
      if (filters.search) parts.push(`"${filters.search}"`);
      label.textContent = `Filtered: ${parts.join(" \u00b7 ")} \u2014 ${filtered.length} result${filtered.length !== 1 ? "s" : ""}`;
    }
  }

  function resetAllFilters() {
    const statusAll = document.querySelector('input[name="statusFilter"][value="all"]');
    if (statusAll) statusAll.checked = true;

    document.querySelectorAll('input[name="priorityFilter"]').forEach((cb) => { cb.checked = true; });

    const flowAll = document.querySelector('input[name="flowFilter"][value="__all__"]');
    if (flowAll) flowAll.checked = true;

    const timeAll = document.querySelector('input[name="timeFilter"][value="all"]');
    if (timeAll) timeAll.checked = true;

    const searchInput = el("eventsSearchInput");
    if (searchInput) searchInput.value = "";

    applyFilters();
  }

  // Wire up filter inputs
  document.querySelectorAll('input[name="statusFilter"]').forEach((r) => r.addEventListener("change", applyFilters));
  document.querySelectorAll('input[name="priorityFilter"]').forEach((cb) => cb.addEventListener("change", applyFilters));
  document.querySelectorAll('input[name="timeFilter"]').forEach((r) => r.addEventListener("change", applyFilters));
  el("eventsSearchInput")?.addEventListener("input", applyFilters);
  el("eventsSort")?.addEventListener("change", applyFilters);
  el("eventsFilterBarReset")?.addEventListener("click", resetAllFilters);

  /* ── Summary stats ───────────────────────────────────────────────────── */

  function updateSummary() {
    const total = allEvents.length;
    const unacked = allEvents.filter((e) => !e.acknowledged).length;
    const byCrit = allEvents.filter((e) => e.priority === "critical").length;
    const byHigh = allEvents.filter((e) => e.priority === "high").length;
    const byMed = allEvents.filter((e) => (e.priority || "medium") === "medium").length;
    const byLow = allEvents.filter((e) => e.priority === "low").length;

    const set = (id, v) => { const e = el(id); if (e) e.textContent = v; };
    set("sumTotal", total);
    set("sumUnacked", unacked);
    set("sumCritical", byCrit);
    set("sumHigh", byHigh);
    set("sumMedium", byMed);
    set("sumLow", byLow);

    // Pulse the unacked count if > 0
    const unackedEl = el("sumUnacked");
    if (unackedEl) {
      unackedEl.closest(".eventsSumStat")?.classList.toggle("has-events", unacked > 0);
    }
  }

  /* ── Flow filter population ──────────────────────────────────────────── */

  function updateFlowFilter() {
    const group = el("flowFilterGroup");
    if (!group) return;

    const selectedEl = document.querySelector('input[name="flowFilter"]:checked');
    const currentVal = selectedEl ? selectedEl.value : "__all__";

    const flows = [...new Set(allEvents.map((e) => e.flow_name).filter(Boolean))].sort();

    let html = '<label class="eventsFilterOption"><input type="radio" name="flowFilter" value="__all__"' +
      (currentVal === "__all__" ? " checked" : "") + ' /> All flows</label>';

    for (const f of flows) {
      const escaped = f.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const count = allEvents.filter((e) => e.flow_name === f).length;
      const checked = currentVal === f ? " checked" : "";
      html += `<label class="eventsFilterOption"><input type="radio" name="flowFilter" value="${escaped}"${checked} /> ${escaped} <span class="eventsFilterCount">(${count})</span></label>`;
    }

    group.innerHTML = html;
    group.querySelectorAll('input[name="flowFilter"]').forEach((r) => r.addEventListener("change", applyFilters));
  }

  /* ── Relative time refresh ───────────────────────────────────────────── */

  setInterval(() => {
    document.querySelectorAll(".eventRow[data-ts]").forEach((row) => {
      const ts = row.dataset.ts;
      if (!ts) return;
      const span = row.querySelector(".eventTimeRel");
      if (span) span.textContent = relativeTime(ts);
    });
  }, 30000);

  async function loadEvents() {
    if (eventsPageClosing) return;
    const list = el("eventsList");
    const empty = el("eventsEmpty");
    if (empty) empty.style.display = "none";
    if (_renderAbort) { _renderAbort.abort = true; _renderAbort = null; }
    list.innerHTML = '<div class="eventsLoadingBar"><div class="eventsLoadingSpinner"></div><span>Loading events\u2026</span></div>';
    if (eventsLoadController) eventsLoadController.abort();
    eventsLoadController = new AbortController();
    const controller = eventsLoadController;
    try {
      const resp = await fetch("/api/events", { cache: "no-store", signal: controller.signal });
      if (!resp.ok) return;
      const data = await resp.json();
      if (eventsPageClosing) return;
      allEvents = data.items || [];
      updateSummary();
      updateFlowFilter();
      applyFilters();
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.error("Failed to load events:", err);
    } finally {
      if (eventsLoadController === controller) eventsLoadController = null;
    }
  }

  function addEventToList(event) {
    allEvents.push(event);
    updateSummary();
    updateFlowFilter();
    applyFilters();
    playAlertSound();

    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-event-id="${event.id}"]`);
      if (row) {
        row.classList.add("flash");
        row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }

  function startSSE() {
    if (eventsPageClosing || eventsSource) return;

    eventsSource = new EventSource("/api/events/stream");
    eventsSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        addEventToList(event);
      } catch (err) {
        console.error("SSE parse error:", err);
      }
    };
    eventsSource.onerror = () => {
      stopSSE();
      if (!eventsPageClosing) {
        eventsReconnectTimer = setTimeout(startSSE, 5000);
      }
    };
  }

  function stopSSE() {
    if (eventsReconnectTimer) {
      clearTimeout(eventsReconnectTimer);
      eventsReconnectTimer = 0;
    }
    if (eventsSource) {
      eventsSource.close();
      eventsSource = null;
    }
  }

  function disposeEventsPage() {
    eventsPageClosing = true;
    stopSSE();
    if (eventsLoadController) {
      eventsLoadController.abort();
      eventsLoadController = null;
    }
    if (_renderAbort) {
      _renderAbort.abort = true;
      _renderAbort = null;
    }
  }

  window.addEventListener("pagehide", disposeEventsPage);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    eventsPageClosing = false;
    loadEvents();
    startSSE();
  });

  // ── Init ──

  el("btnAcknowledgeAll")?.addEventListener("click", async () => {
    try {
      const resp = await fetch("/api/events/acknowledge-all", { method: "POST" });
      if (resp.ok) {
        allEvents.forEach(e => { e.acknowledged = true; });
        updateSummary();
        applyFilters();
        if (window.__smarteyeRefreshEventBadge) window.__smarteyeRefreshEventBadge();
      }
    } catch (err) {
      console.error("Acknowledge all failed:", err);
    }
  });

  el("btnClearAll")?.addEventListener("click", async () => {
    if (!confirm("Archive all events? They will be moved to the archive.")) return;
    try {
      const resp = await fetch("/api/events/archive-all", { method: "POST" });
      if (resp.ok) {
        allEvents = [];
        updateSummary();
        updateFlowFilter();
        applyFilters();
        if (window.__smarteyeRefreshEventBadge) window.__smarteyeRefreshEventBadge();
      }
    } catch (err) {
      console.error("Archive all failed:", err);
    }
  });

  el("eventsLightboxBackdrop")?.addEventListener("click", closeLightbox);
  el("eventsLightboxClose")?.addEventListener("click", closeLightbox);
  el("eventsLightboxPrev")?.addEventListener("click", () => lightboxNav(-1));
  el("eventsLightboxNext")?.addEventListener("click", () => lightboxNav(1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const archive = el("archiveOverlay");
      if (archive && !archive.classList.contains("hidden")) {
        archive.classList.add("hidden");
        return;
      }
      const lb = el("eventsLightbox");
      if (lb && !lb.classList.contains("hidden")) {
        closeLightbox();
      } else if (isFiltered(getActiveFilters())) {
        resetAllFilters();
      }
    }
    if (e.key === "ArrowLeft") lightboxNav(-1);
    if (e.key === "ArrowRight") lightboxNav(1);
  });

  /* ── Archive viewer ──────────────────────────────────────────────────── */

  function renderArchiveRow(ev) {
    const name = ev.name || ev.message || "Event";
    const priority = ev.priority || "medium";
    const ts = formatTimestamp(ev.ts);
    const archivedAt = ev.archived_at ? formatTimestamp(ev.archived_at) : "";
    const flow = ev.flow_name ? escapeHtml(ev.flow_name) : "";

    const priorityColors = {
      critical: "#e53e3e", high: "#dd6b20", medium: "#d69e2e", low: "#38a169", info: "#3182ce"
    };
    const color = priorityColors[priority] || "#888";

    return `<div class="archiveRow" data-event-id="${escapeHtml(ev.id)}">
      <div class="archiveRowIndicator" style="background:${color}"></div>
      <div class="archiveRowBody">
        <div class="archiveRowName">${escapeHtml(name)}</div>
        <div class="archiveRowMeta">
          <span class="priorityBadge priority-${escapeHtml(priority)}" style="font-size:10px;padding:1px 5px">${escapeHtml(priority)}</span>
          ${flow ? `<span>${flow}</span>` : ""}
          <span>${escapeHtml(ts)}</span>
          ${archivedAt ? `<span>archived ${escapeHtml(archivedAt)}</span>` : ""}
        </div>
      </div>
      <div class="archiveRowActions">
        <button class="btn btnRestore" data-event-id="${escapeHtml(ev.id)}" type="button">Restore</button>
        <button class="btn btn-danger btnPermDelete" data-event-id="${escapeHtml(ev.id)}" type="button">Delete</button>
      </div>
    </div>`;
  }

  async function loadArchive() {
    const list = el("archiveList");
    const empty = el("archiveEmpty");
    if (!list) return;
    list.innerHTML = '<div class="eventsLoadingBar"><div class="eventsLoadingSpinner"></div><span>Loading archive\u2026</span></div>';
    try {
      const resp = await fetch("/api/events/archived");
      if (!resp.ok) return;
      const data = await resp.json();
      const items = (data.items || []).reverse(); // newest first
      if (!items.length) {
        list.innerHTML = "";
        if (empty) { list.appendChild(empty); empty.style.display = ""; }
        return;
      }
      if (empty) empty.style.display = "none";
      list.innerHTML = items.map(renderArchiveRow).join("");
      bindArchiveActions();
    } catch (err) {
      console.error("Failed to load archive:", err);
      list.innerHTML = '<div style="padding:16px;color:var(--muted)">Failed to load archive.</div>';
    }
  }

  function bindArchiveActions() {
    document.querySelectorAll(".btnRestore").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const eventId = btn.dataset.eventId;
        try {
          const resp = await fetch(`/api/events/archived/${encodeURIComponent(eventId)}/restore`, { method: "POST" });
          if (resp.ok) {
            btn.closest(".archiveRow")?.remove();
            // Reload live events to pick up restored event
            await loadEvents();
          }
        } catch (err) {
          console.error("Restore failed:", err);
        }
      });
    });
    document.querySelectorAll(".btnPermDelete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const eventId = btn.dataset.eventId;
        try {
          const resp = await fetch(`/api/events/archived/${encodeURIComponent(eventId)}`, { method: "DELETE" });
          if (resp.ok) {
            btn.closest(".archiveRow")?.remove();
          }
        } catch (err) {
          console.error("Permanent delete failed:", err);
        }
      });
    });
  }

  el("btnViewArchive")?.addEventListener("click", () => {
    const overlay = el("archiveOverlay");
    if (overlay) {
      overlay.classList.remove("hidden");
      loadArchive();
    }
  });

  el("archiveClose")?.addEventListener("click", () => {
    el("archiveOverlay")?.classList.add("hidden");
  });

  el("archiveOverlay")?.addEventListener("click", (e) => {
    if (e.target === el("archiveOverlay")) {
      el("archiveOverlay")?.classList.add("hidden");
    }
  });

  loadEvents();
  startSSE();
})();
