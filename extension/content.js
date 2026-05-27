// ─── Local TTS Reader — Content Script ───────────────────────────────────────
// Injected into every webpage.
//   1. Keyboard shortcuts → background.js
//   2. Floating "Now Playing" overlay (shadow DOM, bottom-right)

// ─── Shortcuts ────────────────────────────────────────────────────────────────
const DEFAULT_SHORTCUTS = { read: "Alt+Shift+R", pause: "Alt+Shift+D" };
let activeShortcuts = { ...DEFAULT_SHORTCUTS };

chrome.storage.local.get({ shortcuts: DEFAULT_SHORTCUTS }, ({ shortcuts }) => {
  activeShortcuts = shortcuts;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.shortcuts) activeShortcuts = changes.shortcuts.newValue;
});

function comboFromEvent(e) {
  const parts = [];
  if (e.altKey)   parts.push("Alt");
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!["Alt", "Control", "Shift", "Meta"].includes(e.key)) parts.push(key);
  return parts.join("+");
}

// Snapshot selection on mouseup so modifier keys can't clear it before our handler runs
let _lastSelection = "";
document.addEventListener("mouseup",        () => { const s = window.getSelection()?.toString().trim(); if (s) _lastSelection = s; }, true);
document.addEventListener("selectionchange",() => { const s = window.getSelection()?.toString().trim(); if (s) _lastSelection = s; });

// Capture phase — fires before any page keydown handler
document.addEventListener("keydown", (e) => {
  const combo = comboFromEvent(e);

  if (combo === activeShortcuts.read) {
    e.preventDefault();
    const text = window.getSelection()?.toString().trim() || _lastSelection;
    if (!text) { showHint("Select text first"); return; }
    chrome.runtime.sendMessage({ type: "keyboard-read", text });

  } else if (combo === activeShortcuts.pause) {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "keyboard-pause" });
  }
}, true);

// Tell background to stop when this tab navigates away or closes
window.addEventListener("pagehide", () => {
  chrome.runtime.sendMessage({ type: "tab-unloading" });
});

// ─── Overlay ──────────────────────────────────────────────────────────────────
// Uses a closed shadow DOM so page styles can't leak in.
// Re-appends itself if a page framework (e.g. React) removes it from the DOM.

let overlayHost   = null;
let overlayShadow = null;

function buildOverlayDOM(shadow) {
  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
      position: fixed !important;
      bottom: 24px !important;
      right: 24px !important;
      z-index: 2147483647 !important;
      pointer-events: auto !important;
      display: block !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.65);
      white-space: nowrap;
    }
    .btn {
      background: #313244;
      border: 1px solid #45475a;
      border-radius: 7px;
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.15s, border-color 0.15s;
      flex-shrink: 0;
      outline: none;
      padding: 0;
      color: #cdd6f4;
    }
    .btn:hover { background: #45475a; }
    .btn-pp  { color: #a6e3a1; border-color: #3a6a4a; }
    .btn-pp:hover { border-color: #a6e3a1; }
    .btn-close { color: #f38ba8; border-color: #5a3a3a; }
    .btn-close:hover { border-color: #f38ba8; background: #3a1e1e; }
    .lbl {
      font-size: 12px;
      font-weight: 600;
      color: #cdd6f4;
      min-width: 44px;
      text-align: center;
    }
    .hint-bar {
      padding: 9px 14px;
      background: #1e1e2e;
      border: 1px solid #585b70;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      font-size: 12px;
      font-weight: 600;
      color: #a6adc8;
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    }
  `;
  shadow.appendChild(style);
}

function ensureOverlay() {
  // Re-attach if page JS removed us from the DOM
  if (overlayHost && !document.contains(overlayHost)) {
    (document.body || document.documentElement).appendChild(overlayHost);
  }
  if (overlayHost) return overlayShadow;

  overlayHost   = document.createElement("div");
  overlayShadow = overlayHost.attachShadow({ mode: "closed" });
  buildOverlayDOM(overlayShadow);
  (document.body || document.documentElement).appendChild(overlayHost);
  return overlayShadow;
}

function removeOverlay() {
  if (!overlayHost) return;
  overlayHost.remove();
  overlayHost   = null;
  overlayShadow = null;
}

// Show a brief toast (e.g. "Select text first") that auto-dismisses
let _hintTimer = null;
function showHint(msg) {
  const shadow = ensureOverlay();
  shadow.querySelectorAll(".bar, .hint-bar").forEach(el => el.remove());

  const bar = document.createElement("div");
  bar.className = "hint-bar";
  bar.textContent = msg;
  shadow.appendChild(bar);

  clearTimeout(_hintTimer);
  _hintTimer = setTimeout(() => {
    bar.remove();
    if (!shadow.querySelector(".bar")) removeOverlay();
  }, 2000);
}

// Build or update the media-controls bar
function updateOverlay(isPlaying, isPaused) {
  if (!isPlaying && !isPaused) {
    if (overlayHost && !overlayShadow?.querySelector(".hint-bar")) removeOverlay();
    return;
  }

  const shadow = ensureOverlay();
  shadow.querySelectorAll(".hint-bar").forEach(el => el.remove());

  let bar = shadow.querySelector(".bar");
  if (!bar) {
    // ── Build bar structure ──
    const btnPP = document.createElement("button");
    btnPP.className = "btn btn-pp";
    btnPP.title = "Pause";
    btnPP.addEventListener("click", () => chrome.runtime.sendMessage({ type: "keyboard-pause" }));

    const lbl = document.createElement("span");
    lbl.className = "lbl";

    const btnClose = document.createElement("button");
    btnClose.className = "btn btn-close";
    btnClose.title = "Stop";
    btnClose.textContent = "✕";
    btnClose.addEventListener("click", () => chrome.runtime.sendMessage({ type: "stop-all" }));

    bar = document.createElement("div");
    bar.className = "bar";
    bar.append(btnPP, lbl, btnClose);
    shadow.appendChild(bar);
  }

  const btnPP = bar.querySelector(".btn-pp");
  const lbl   = bar.querySelector(".lbl");

  if (isPaused) {
    btnPP.textContent = "▶";
    btnPP.title       = "Resume";
    lbl.textContent   = "Paused";
  } else {
    btnPP.textContent = "⏸";
    btnPP.title       = "Pause";
    lbl.textContent   = "Playing";
  }
}

// Poll every second for playback state
setInterval(() => {
  chrome.runtime.sendMessage({ type: "get-playback-state" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    updateOverlay(resp.isPlaying, resp.isPaused);
  });
}, 1000);
