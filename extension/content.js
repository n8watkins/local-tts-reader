// ─── Local TTS Reader — Content Script ───────────────────────────────────────
// Injected into every webpage.
//   1. Keyboard shortcuts → background.js
//   2. Floating "Now Playing" overlay on the page

// ─── Shortcuts ────────────────────────────────────────────────────────────────
const DEFAULT_SHORTCUTS = { read: "Alt+Shift+R", pause: "Alt+Shift+D" };
let activeShortcuts = { ...DEFAULT_SHORTCUTS };

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

chrome.storage.local.get({ shortcuts: DEFAULT_SHORTCUTS }, ({ shortcuts }) => {
  activeShortcuts = shortcuts;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.shortcuts) activeShortcuts = changes.shortcuts.newValue;
});

document.addEventListener("keydown", (e) => {
  const combo = comboFromEvent(e);
  if (combo === activeShortcuts.read) {
    e.preventDefault();
    // Read selection here — content script already has page access, no executeScript needed.
    const text = window.getSelection()?.toString().trim() || "";
    chrome.runtime.sendMessage({ type: "keyboard-read", text });
  } else if (combo === activeShortcuts.pause) {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "keyboard-pause" });
  }
});

// ─── Now Playing Overlay ──────────────────────────────────────────────────────
// Uses shadow DOM so page styles can't leak in or out.
let overlayHost   = null;
let overlayShadow = null;

function ensureOverlay() {
  if (overlayHost) return overlayShadow;

  overlayHost = document.createElement("div");
  overlayHost.id = "__local-tts-overlay__";
  Object.assign(overlayHost.style, {
    position:       "fixed",
    bottom:         "24px",
    right:          "24px",
    zIndex:         "2147483647",
    pointerEvents:  "auto",
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
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #a6e3a1;
      flex-shrink: 0;
    }
    .dot.pulse { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    .hint {
      font-size: 11px;
      font-weight: 400;
      color: #6c7086;
    }
  `;

  const dot   = document.createElement("span");
  dot.className = "dot pulse";

  const label = document.createElement("span");
  label.className = "lbl";
  label.textContent = "Playing";

  const hint  = document.createElement("span");
  hint.className = "hint";
  hint.textContent = "· click to stop";

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.append(dot, label, hint);

  bar.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "stop-all" });
  });

  overlayShadow.append(style, bar);
  document.documentElement.appendChild(overlayHost);
  return overlayShadow;
}

function removeOverlay() {
  if (!overlayHost) return;
  overlayHost.remove();
  overlayHost   = null;
  overlayShadow = null;
}

function updateOverlay(isPlaying, isPaused) {
  if (!isPlaying && !isPaused) { removeOverlay(); return; }

  const shadow = ensureOverlay();
  const dot    = shadow.querySelector(".dot");
  const label  = shadow.querySelector(".lbl");

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
