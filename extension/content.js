// ─── Local TTS Reader — Content Script ───────────────────────────────────────
// Injected into every webpage.
//   1. Keyboard shortcuts → background.js
//   2. Floating "Now Playing" overlay on the page

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

// Cache the last known selection so Alt/Shift key-down can't clear it before
// our handler runs. Updated on mouseup and selectionchange.
let _lastSelection = "";
document.addEventListener("mouseup", () => {
  const sel = window.getSelection()?.toString().trim() || "";
  if (sel) _lastSelection = sel;
});
document.addEventListener("selectionchange", () => {
  const sel = window.getSelection()?.toString().trim() || "";
  if (sel) _lastSelection = sel;  // only overwrite when we have something real
});

// Use CAPTURE phase so we intercept keydown before any page handler can
// call stopPropagation() or interfere with the event.
document.addEventListener("keydown", (e) => {
  const combo = comboFromEvent(e);

  if (combo === activeShortcuts.read) {
    e.preventDefault();
    // Prefer live selection; fall back to cached selection from before modifier keys were pressed
    const text = window.getSelection()?.toString().trim() || _lastSelection;
    if (!text) {
      showHint("Select text first");
      return;
    }
    chrome.runtime.sendMessage({ type: "keyboard-read", text });

  } else if (combo === activeShortcuts.pause) {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "keyboard-pause" });
  }
}, true); // ← capture phase

// ─── Now Playing Overlay ──────────────────────────────────────────────────────
let overlayHost   = null;
let overlayShadow = null;

function ensureOverlay() {
  if (overlayHost) return overlayShadow;

  overlayHost = document.createElement("div");
  overlayHost.id = "__local-tts-overlay__";
  Object.assign(overlayHost.style, {
    position:      "fixed",
    bottom:        "24px",
    right:         "24px",
    zIndex:        "2147483647",
    pointerEvents: "auto",
  });

  overlayShadow = overlayHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: #1e1e2e;
      border: 1px solid #3a6a4a;
      border-radius: 12px;
      box-shadow: 0 4px 28px rgba(0,0,0,0.6);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      font-weight: 600;
      color: #a6e3a1;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: border-color 0.15s, background 0.15s;
    }
    .bar:hover { background: #252538; border-color: #a6e3a1; }
    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #a6e3a1;
      flex-shrink: 0;
    }
    .dot.pulse { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .hint-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      background: #1e1e2e;
      border: 1px solid #585b70;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      font-weight: 600;
      color: #a6adc8;
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    }
    .sub { font-size: 11px; font-weight: 400; color: #6c7086; }
  `;

  overlayShadow.appendChild(style);
  document.documentElement.appendChild(overlayHost);
  return overlayShadow;
}

function removeOverlay() {
  if (!overlayHost) return;
  overlayHost.remove();
  overlayHost   = null;
  overlayShadow = null;
}

// Show a brief informational toast (e.g. "Select text first") that auto-dismisses
let _hintTimer = null;
function showHint(msg) {
  const shadow = ensureOverlay();
  // Remove any existing bar so the hint stands alone
  shadow.querySelectorAll(".bar, .hint-bar").forEach(el => el.remove());

  const bar = document.createElement("div");
  bar.className = "hint-bar";
  bar.textContent = msg;
  shadow.appendChild(bar);

  clearTimeout(_hintTimer);
  _hintTimer = setTimeout(() => {
    bar.remove();
    // If no playing bar took over, tear down the host too
    if (!shadow.querySelector(".bar")) removeOverlay();
  }, 2000);
}

function updateOverlay(isPlaying, isPaused) {
  if (!isPlaying && !isPaused) {
    if (overlayHost && !overlayHost.shadowRoot?.querySelector(".hint-bar")) {
      removeOverlay();
    }
    return;
  }

  const shadow = ensureOverlay();
  // Remove hint if a real playback bar is taking over
  shadow.querySelectorAll(".hint-bar").forEach(el => el.remove());

  let bar = shadow.querySelector(".bar");
  if (!bar) {
    const dot   = document.createElement("span");
    dot.className = "dot pulse";

    const label = document.createElement("span");
    label.className = "lbl";

    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = "· click to stop";

    bar = document.createElement("div");
    bar.className = "bar";
    bar.append(dot, label, sub);
    bar.addEventListener("click", () => chrome.runtime.sendMessage({ type: "stop-all" }));
    shadow.appendChild(bar);
  }

  const dot   = bar.querySelector(".dot");
  const label = bar.querySelector(".lbl");
  if (isPaused) {
    dot.classList.remove("pulse");
    label.textContent = "Paused";
  } else {
    dot.classList.add("pulse");
    label.textContent = "Playing";
  }
}

// Poll background every second for playback state
setInterval(() => {
  chrome.runtime.sendMessage({ type: "get-playback-state" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    updateOverlay(resp.isPlaying, resp.isPaused);
  });
}, 1000);
