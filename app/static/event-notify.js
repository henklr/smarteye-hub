(function () {
  "use strict";

  var PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  var PRIORITY_COLORS = {
    critical: "#e53e3e",
    high:     "#dd6b20",
    medium:   "#d69e2e",
    low:      "#38a169",
    info:     "#3182ce"
  };

  // Inject badge span into the Events tab if not present
  var eventsTab = document.querySelector('.tab[href="/events"]');
  var badgeEl = null;
  if (eventsTab) {
    badgeEl = eventsTab.querySelector(".tabBadge");
    if (!badgeEl) {
      badgeEl = document.createElement("span");
      badgeEl.className = "tabBadge";
      eventsTab.appendChild(badgeEl);
    }
  }

  function applyBadge(priority) {
    if (!eventsTab || !badgeEl) return;
    var color = PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium;
    badgeEl.style.setProperty("--badge-color", color);
    eventsTab.classList.add("has-badge");
  }

  function clearBadge() {
    if (!eventsTab) return;
    eventsTab.classList.remove("has-badge");
  }

  // Compute badge from a list of events (show highest unacked priority)
  function refreshBadgeFromEvents(events) {
    var highest = null;
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.acknowledged) continue;
      var p = ev.priority || "medium";
      if (highest === null || (PRIORITY_RANK[p] || 99) < (PRIORITY_RANK[highest] || 99)) {
        highest = p;
      }
      if (highest === "critical") break; // can't go higher
    }
    if (highest) {
      applyBadge(highest);
    } else {
      clearBadge();
    }
  }

  // Expose globally so events.js can call after acknowledge
  window.__smarteyeRefreshEventBadge = function () {
    fetch("/api/events").then(function (r) { return r.json(); }).then(function (data) {
      refreshBadgeFromEvents(data.items || data);
    }).catch(function () {});
  };

  // Initial check – fetch current events to set badge state
  window.__smarteyeRefreshEventBadge();

  // Listen for new events via SSE – show badge immediately
  function startNotifySSE() {
    var src = new EventSource("/api/events/stream");
    src.onmessage = function (e) {
      try {
        var event = JSON.parse(e.data);
        // New event is always unacknowledged, so just upgrade badge if needed
        var p = event.priority || "medium";
        var cur = badgeEl ? badgeEl.style.getPropertyValue("--badge-color") : "";
        // Always apply if no badge yet, or if this is higher priority
        if (!eventsTab.classList.contains("has-badge")) {
          applyBadge(p);
        } else {
          // Check if incoming is higher than current
          for (var key in PRIORITY_COLORS) {
            if (PRIORITY_COLORS[key] === cur) { 
              if ((PRIORITY_RANK[p] || 99) < (PRIORITY_RANK[key] || 99)) {
                applyBadge(p);
              }
              break;
            }
          }
        }
      } catch (_) {
        applyBadge("medium");
      }
    };
    src.onerror = function () {
      src.close();
      setTimeout(startNotifySSE, 10000);
    };
  }

  startNotifySSE();
})();
