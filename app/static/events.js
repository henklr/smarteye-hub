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

    // Meta line: flow name + scenario badge + timestamp
    let metaParts = [];
    if (event.flow_name) {
      metaParts.push(`<span>${escapeHtml(event.flow_name)}</span>`);
    }
    if (event.scenario_name) {
      metaParts.push(`<span class="eventBadge">${escapeHtml(event.scenario_name)}</span>`);
    }
    metaParts.push(`<span>${escapeHtml(formatTimestamp(event.ts))}</span>`);

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
          <div class="eventIndicator"></div>
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
        ${snapshotsHtml}
        ${recordingsHtml}
      </div>
    `;
  }

  function renderEvents(events) {
    const list = el("eventsList");
    const empty = el("eventsEmpty");

    if (!events.length) {
      list.innerHTML = "";
      list.appendChild(empty);
      empty.style.display = "";
      return;
    }

    if (empty) empty.style.display = "none";

    const sorted = [...events].sort((a, b) => {
      if (!a.acknowledged && b.acknowledged) return -1;
      if (a.acknowledged && !b.acknowledged) return 1;
      return (b.ts || "").localeCompare(a.ts || "");
    });

    list.innerHTML = sorted.map(renderEventRow).join("");
    bindEventActions();
    bindSnapshotThumbs();
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
    document.querySelectorAll(".eventSnapshotThumb").forEach((img) => {
      img.addEventListener("click", () => {
        const fullSrc = img.dataset.full;
        if (!fullSrc) return;
        const lightbox = el("eventsLightbox");
        const lbImg = el("eventsLightboxImg");
        if (lightbox && lbImg) {
          lbImg.src = fullSrc;
          lightbox.classList.remove("hidden");
          lightbox.setAttribute("aria-hidden", "false");
        }
      });
    });
  }

  function closeLightbox() {
    const lightbox = el("eventsLightbox");
    if (lightbox) {
      lightbox.classList.add("hidden");
      lightbox.setAttribute("aria-hidden", "true");
    }
    const lbImg = el("eventsLightboxImg");
    if (lbImg) lbImg.src = "";
  }

  let allEvents = [];

  async function loadEvents() {
    try {
      const resp = await fetch("/api/events");
      if (!resp.ok) return;
      const data = await resp.json();
      allEvents = data.items || [];
      renderEvents(allEvents);
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
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  loadEvents();
  startSSE();
})();
