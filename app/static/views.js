// Views: unified Live + Playback page.
// Phase 1 scaffolding — mode switch + persistence. Live and playback logic
// is mounted by views-live.js and views-playback.js in later phases.

const VIEWS_MODE_STORAGE_KEY = "views.mode";
const VALID_MODES = new Set(["live", "playback"]);

const viewsState = {
  mode: "live",
  liveMounted: false,
  playbackMounted: false,
  selectedDevices: new Set(),
};

function getInitialMode() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("mode");
  if (fromUrl && VALID_MODES.has(fromUrl)) return fromUrl;
  try {
    const stored = localStorage.getItem(VIEWS_MODE_STORAGE_KEY);
    if (stored && VALID_MODES.has(stored)) return stored;
  } catch (_) {}
  return "live";
}

function applyModeClass(mode) {
  document.body.dataset.viewsMode = mode;
  document.body.classList.toggle("livePage", mode === "live");
  document.body.classList.toggle("playbackPage", mode === "playback");
}

function applyModeButtons(mode) {
  document.querySelectorAll("[data-views-mode-btn]").forEach((btn) => {
    const active = btn.dataset.viewsModeBtn === mode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function persistMode(mode) {
  try { localStorage.setItem(VIEWS_MODE_STORAGE_KEY, mode); } catch (_) {}
  const url = new URL(window.location.href);
  url.searchParams.set("mode", mode);
  window.history.replaceState({}, "", url);
}

async function setMode(mode) {
  if (!VALID_MODES.has(mode)) return;
  if (viewsState.mode === mode) return;
  const prev = viewsState.mode;
  viewsState.mode = mode;
  applyModeClass(mode);
  applyModeButtons(mode);
  persistMode(mode);
  // Module mount/unmount hooks land in Phase 2/3.
  if (typeof window.viewsLive?.onModeChange === "function") {
    window.viewsLive.onModeChange(mode, prev);
  }
  if (typeof window.viewsPlayback?.onModeChange === "function") {
    window.viewsPlayback.onModeChange(mode, prev);
  }
}

function bindModeSwitch() {
  document.querySelectorAll("[data-views-mode-btn]").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.viewsModeBtn));
  });
}

function init() {
  const mode = getInitialMode();
  viewsState.mode = mode;
  applyModeClass(mode);
  applyModeButtons(mode);
  bindModeSwitch();
  // Expose shared state for the per-mode modules.
  window.views = viewsState;
}

init();
