(function () {
  "use strict";

  const el = (id) => document.getElementById(id);

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
    metaParts.push(`<span>${escapeHtml(formatTimestamp(event.ts))}</span>`);

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
        const ts = ref.timestamp ? `&t=${encodeURIComponent(ref.timestamp)}` : "";
        return `<a class="eventRecordingLink" href="/playback?device=${encodeURIComponent(ref.device_id)}${ts}" title="View recording for ${escapeHtml(label)}">&#9654; ${escapeHtml(label)}</a>`;
      }).join("");
      recordingsHtml = `<div class="eventRecordings">${links}</div>`;
    }

    return `
      <div class="${cls}" data-event-id="${escapeHtml(event.id)}">
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
            <button class="btn btn-danger btnDelete" data-event-id="${escapeHtml(event.id)}" type="button">Delete</button>
          </div>
        </div>
        ${triggerHtml}
        ${analysisHtml}
        ${detailsHtml}
        ${snapshotsHtml}
        ${recordingsHtml}
      </div>
    `;
  }

  function sortEvents(events) {
    return [...events].sort((a, b) => {
      if (!a.acknowledged && b.acknowledged) return -1;
      if (a.acknowledged && !b.acknowledged) return 1;
      return (b.ts || "").localeCompare(a.ts || "");
    });
  }

  let _renderAbort = null;

  function renderEvents(events) {
    const list = el("eventsList");
    const empty = el("eventsEmpty");

    if (_renderAbort) { _renderAbort.abort = true; _renderAbort = null; }

    if (!events.length) {
      list.innerHTML = "";
      list.appendChild(empty);
      empty.style.display = "";
      return;
    }

    if (empty) empty.style.display = "none";

    const sorted = sortEvents(events);
    list.innerHTML = sorted.map(renderEventRow).join("");
    bindEventActions();
    bindSnapshotThumbs();
  }

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
    row.querySelectorAll(".btnAck").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const eventId = btn.dataset.eventId;
        try {
          await fetch(`/api/events/${encodeURIComponent(eventId)}/acknowledge`, { method: "POST" });
          await loadEvents();
        } catch (err) {
          console.error("Acknowledge failed:", err);
        }
      });
    });
    row.querySelectorAll(".btnDelete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const eventId = btn.dataset.eventId;
        try {
          await fetch(`/api/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
          await loadEvents();
        } catch (err) {
          console.error("Delete failed:", err);
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

  function bindEventActions() {
    document.querySelectorAll(".btnAck").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const eventId = btn.dataset.eventId;
        try {
          await fetch(`/api/events/${encodeURIComponent(eventId)}/acknowledge`, { method: "POST" });
          await loadEvents();
        } catch (err) {
          console.error("Acknowledge failed:", err);
        }
      });
    });

    document.querySelectorAll(".btnDelete").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const eventId = btn.dataset.eventId;
        try {
          await fetch(`/api/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
          await loadEvents();
        } catch (err) {
          console.error("Delete failed:", err);
        }
      });
    });
  }

  function bindSnapshotThumbs() {
    document.querySelectorAll(".eventSnapshots").forEach((container) => {
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

  async function loadEvents() {
    const list = el("eventsList");
    const empty = el("eventsEmpty");
    if (empty) empty.style.display = "none";
    if (_renderAbort) { _renderAbort.abort = true; _renderAbort = null; }
    list.innerHTML = '<div class="eventsLoadingBar"><div class="eventsLoadingSpinner"></div><span>Loading events\u2026</span></div>';
    try {
      const resp = await fetch("/api/events");
      if (!resp.ok) return;
      const data = await resp.json();
      allEvents = data.items || [];
      renderEventsProgressive(allEvents);
      updateHeaderSub();
    } catch (err) {
      console.error("Failed to load events:", err);
    }
  }

  function updateHeaderSub() {
    const sub = el("eventsHeaderSub");
    if (!sub) return;
    const unacked = allEvents.filter((e) => !e.acknowledged).length;
    if (unacked > 0) {
      sub.textContent = `${unacked} unacknowledged event${unacked !== 1 ? "s" : ""} \u00b7 ${allEvents.length} total`;
    } else if (allEvents.length > 0) {
      sub.textContent = `${allEvents.length} event${allEvents.length !== 1 ? "s" : ""}, all acknowledged.`;
    } else {
      sub.textContent = "AI-analyzed security events from your flows.";
    }
  }

  function addEventToList(event) {
    allEvents.push(event);
    renderEvents(allEvents);
    updateHeaderSub();

    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-event-id="${event.id}"]`);
      if (row) {
        row.classList.add("flash");
        row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    });
  }

  function startSSE() {
    const evtSource = new EventSource("/api/events/stream");
    evtSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        addEventToList(event);
      } catch (err) {
        console.error("SSE parse error:", err);
      }
    };
    evtSource.onerror = () => {
      evtSource.close();
      setTimeout(startSSE, 5000);
    };
  }

  // ── Init ──

  el("btnAcknowledgeAll")?.addEventListener("click", async () => {
    try {
      await fetch("/api/events/acknowledge-all", { method: "POST" });
      await loadEvents();
    } catch (err) {
      console.error("Acknowledge all failed:", err);
    }
  });

  el("btnClearAll")?.addEventListener("click", async () => {
    if (!confirm("Clear all events? This cannot be undone.")) return;
    try {
      await fetch("/api/events", { method: "DELETE" });
      await loadEvents();
    } catch (err) {
      console.error("Clear all failed:", err);
    }
  });

  el("eventsLightboxBackdrop")?.addEventListener("click", closeLightbox);
  el("eventsLightboxClose")?.addEventListener("click", closeLightbox);
  el("eventsLightboxPrev")?.addEventListener("click", () => lightboxNav(-1));
  el("eventsLightboxNext")?.addEventListener("click", () => lightboxNav(1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") lightboxNav(-1);
    if (e.key === "ArrowRight") lightboxNav(1);
  });

  loadEvents();
  startSSE();
})();
