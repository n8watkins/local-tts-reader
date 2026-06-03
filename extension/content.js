// ─── Piper TTS — Content Script ──────────────────────────────────────────────
// Injected into every webpage.
//   1. Keyboard shortcuts → background.js
//   2. Floating "Now Playing" overlay (shadow DOM, bottom-right corner)

// ─── Shortcuts ────────────────────────────────────────────────────────────────
const DEFAULT_SHORTCUTS = { read: "Alt+Shift+R", pause: "Alt+Shift+D", stop: "Alt+Shift+E" };
let activeShortcuts = { ...DEFAULT_SHORTCUTS };

chrome.storage.local.get({ shortcuts: DEFAULT_SHORTCUTS }, ({ shortcuts }) => {
  activeShortcuts = shortcuts;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.shortcuts) activeShortcuts = changes.shortcuts.newValue;
});

// Use e.code (physical key position) not e.key (character).
// On non-US keyboards / AltGr active, Alt+R produces e.key="®" — e.code is always "KeyR".
function comboFromEvent(e) {
  const MODIFIER_CODES = new Set([
    "AltLeft","AltRight","ControlLeft","ControlRight",
    "ShiftLeft","ShiftRight","MetaLeft","MetaRight"
  ]);
  if (MODIFIER_CODES.has(e.code)) return "";  // modifier-only press

  const parts = [];
  if (e.altKey)   parts.push("Alt");
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");

  // "KeyR" → "R",  "Digit1" → "1",  "Space" / "F1" → as-is
  const keyName =
    e.code.startsWith("Key")   ? e.code.slice(3)  :
    e.code.startsWith("Digit") ? e.code.slice(5)  :
    e.code;
  parts.push(keyName);
  return parts.join("+");
}

// Cache last known selection so modifier keys can't clear it before our handler reads it
let _lastSelection = "";
const _snapshotSel = () => {
  const s = window.getSelection()?.toString().trim();
  if (s) _lastSelection = s;
};
document.addEventListener("mouseup",         _snapshotSel, true);
document.addEventListener("selectionchange", _snapshotSel);
document.addEventListener("keyup",           _snapshotSel, true); // keyboard selections (Shift+arrow)

// ─── Local playback state (optimistic — for instant UI updates) ───────────────
let _localPlaying  = false;
let _localPaused   = false;
let _currentVolume = 1.0;

// Capture-phase keydown — fires before any page handler
document.addEventListener("keydown", (e) => {
  // Snapshot selection right now — some pages clear it when a modifier key fires,
  // so we grab it on each keydown to make sure we have the freshest non-empty value.
  const sel = window.getSelection()?.toString().trim();
  if (sel) _lastSelection = sel;

  const combo = comboFromEvent(e);
  if (!combo) return;

  // ── Read / Stop toggle (Alt+Shift+R by default) ──────────────────────────────
  if (combo === activeShortcuts.read) {
    e.preventDefault();
    if (_localPlaying) {
      // Optimistic stop
      _localPlaying = false;
      _localPaused  = false;
      updateOverlay(false, false);
      chrome.runtime.sendMessage({ type: "stop-all" });
    } else {
      const text = window.getSelection()?.toString().trim() || _lastSelection;
      if (!text) { showHint("Select text first"); return; }
      // Optimistic start
      _localPlaying = true;
      _localPaused  = false;
      updateOverlay(true, false);
      chrome.runtime.sendMessage({ type: "keyboard-read", text });
    }

  // ── Pause / Resume (Alt+Shift+D by default) ───────────────────────────────────
  } else if (combo === activeShortcuts.pause) {
    e.preventDefault();
    if (_localPlaying) {
      _localPaused = !_localPaused;
      updateOverlay(_localPlaying, _localPaused); // instant visual feedback
    }
    chrome.runtime.sendMessage({ type: "keyboard-pause" });

  // ── Stop / Exit (Alt+Shift+E by default) ─────────────────────────────────────
  } else if (combo === activeShortcuts.stop) {
    e.preventDefault();
    _localPlaying = false;
    _localPaused  = false;
    updateOverlay(false, false);
    chrome.runtime.sendMessage({ type: "stop-all" });
  }
}, true);

// Stop when this tab navigates away or closes
window.addEventListener("pagehide", () => {
  chrome.runtime.sendMessage({ type: "tab-unloading" });
});

// ─── Overlay ──────────────────────────────────────────────────────────────────
let overlayHost   = null;
let overlayShadow = null;

const OVERLAY_CSS = `
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

  /* ── Main playing bar ── */
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px 7px 12px;
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 999px;
    box-shadow: 0 6px 28px rgba(0,0,0,0.7),
                0 0 0 1px rgba(203,166,247,0.08);
    white-space: nowrap;
    transition: border-color 0.2s;
  }
  .bar:hover { border-color: #6c7086; }

  /* Extension label */
  .brand {
    font-size: 13px;
    line-height: 1;
    color: #cba6f7;
    flex-shrink: 0;
    margin-right: 2px;
  }

  /* Status text */
  .lbl {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #cdd6f4;
    min-width: 46px;
    text-align: left;
    transition: color 0.15s;
  }
  .lbl.paused { color: #f9e2af; }

  .prog {
    width: 42px;
    height: 4px;
    background: #45475a;
    border-radius: 999px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .prog-fill {
    display: block;
    width: 0%;
    height: 100%;
    background: #cba6f7;
    border-radius: inherit;
    transition: width 0.2s ease;
  }

  .prog-fill.is-indeterminate {
    width: 45%;
    animation: tts-progress-pulse 1s ease-in-out infinite alternate;
  }

  @keyframes tts-progress-pulse {
    from { transform: translateX(-70%); }
    to   { transform: translateX(130%); }
  }

  /* Divider */
  .sep {
    width: 1px;
    height: 14px;
    background: #313244;
    flex-shrink: 0;
    margin: 0 2px;
  }

  /* Shared button base */
  .btn {
    background: transparent;
    border: none;
    border-radius: 50%;
    width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    outline: none;
    padding: 0;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s;
  }

  /* Play/Pause button */
  .btn-pp {
    font-size: 14px;
    color: #cba6f7;
  }
  .btn-pp:hover { background: rgba(203,166,247,0.12); }

  /* Volume rocker */
  .btn-vol {
    font-size: 13px;
    font-weight: 700;
    color: #a6adc8;
    width: 20px; height: 20px;
    line-height: 1;
  }
  .btn-vol:hover { background: rgba(166,173,200,0.14); color: #cdd6f4; }

  .vol-val {
    font-size: 11px;
    font-weight: 700;
    color: #a6adc8;
    min-width: 34px;
    text-align: center;
    flex-shrink: 0;
    letter-spacing: 0.01em;
  }

  /* Close / Stop button */
  .btn-close {
    font-size: 10px;
    color: #585b70;
    font-weight: 700;
  }
  .btn-close:hover { background: rgba(243,139,168,0.14); color: #f38ba8; }

  /* ── Hint toast ── */
  .hint-bar {
    padding: 8px 14px;
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 999px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.55);
    font-size: 12px;
    font-weight: 600;
    color: #a6adc8;
    pointer-events: none;
    user-select: none;
    white-space: nowrap;
  }
`;

function ensureOverlay() {
  // Re-attach if a page framework removed our host node
  if (overlayHost && !document.contains(overlayHost)) {
    (document.body || document.documentElement).appendChild(overlayHost);
  }
  if (overlayHost) return overlayShadow;

  overlayHost   = document.createElement("div");
  overlayShadow = overlayHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = OVERLAY_CSS;
  overlayShadow.appendChild(style);

  (document.body || document.documentElement).appendChild(overlayHost);
  return overlayShadow;
}

function removeOverlay() {
  if (!overlayHost) return;
  overlayHost.remove();
  overlayHost = overlayShadow = null;
}

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
  }, 2500);
}

function fmtVol(v) {
  return Math.round((v ?? 1.0) * 100) + "%";
}

function adjustVolume(delta) {
  chrome.runtime.sendMessage({ type: "adjust-volume", delta }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) return;
    _currentVolume = resp.volume;
    // Update volume display immediately without a full re-render
    const bar = overlayShadow?.querySelector(".bar");
    if (bar) {
      const volEl = bar.querySelector(".vol-val");
      if (volEl) volEl.textContent = fmtVol(_currentVolume);
    }
  });
}

function updateOverlay(isPlaying, isPaused, progress = null) {
  if (!isPlaying && !isPaused) {
    if (overlayHost && !overlayShadow?.querySelector(".hint-bar")) removeOverlay();
    return;
  }

  const shadow = ensureOverlay();
  shadow.querySelectorAll(".hint-bar").forEach(el => el.remove());

  let bar = shadow.querySelector(".bar");
  if (!bar) {
    // ── Brand icon ──
    const brand = document.createElement("span");
    brand.className = "brand";
    brand.textContent = "🔊";

    // ── Play/Pause button ──
    const btnPP = document.createElement("button");
    btnPP.className = "btn btn-pp";
    btnPP.addEventListener("click", () => {
      _localPaused = !_localPaused;
      updateOverlay(_localPlaying, _localPaused); // instant update
      chrome.runtime.sendMessage({ type: "keyboard-pause" });
    });

    // ── Status label ──
    const lbl = document.createElement("span");
    lbl.className = "lbl";

    const prog = document.createElement("span");
    prog.className = "prog";
    const progFill = document.createElement("span");
    progFill.className = "prog-fill";
    prog.appendChild(progFill);

    // ── Separator ──
    const sep1 = document.createElement("span");
    sep1.className = "sep";

    // ── Volume rocker: − vol% + ──
    const btnMinus = document.createElement("button");
    btnMinus.className = "btn btn-vol";
    btnMinus.textContent = "−";
    btnMinus.title = "Volume down";
    btnMinus.addEventListener("click", () => adjustVolume(-0.1));

    const volVal = document.createElement("span");
    volVal.className = "vol-val";
    volVal.textContent = fmtVol(_currentVolume);

    const btnPlus = document.createElement("button");
    btnPlus.className = "btn btn-vol";
    btnPlus.textContent = "+";
    btnPlus.title = "Volume up";
    btnPlus.addEventListener("click", () => adjustVolume(0.1));

    // ── Separator ──
    const sep2 = document.createElement("span");
    sep2.className = "sep";

    // ── Stop button ──
    const btnClose = document.createElement("button");
    btnClose.className = "btn btn-close";
    btnClose.title = "Stop";
    btnClose.textContent = "✕";
    btnClose.addEventListener("click", () => {
      _localPlaying = false;
      _localPaused  = false;
      chrome.runtime.sendMessage({ type: "stop-all" });
      removeOverlay();
    });

    bar = document.createElement("div");
    bar.className = "bar";
    bar.append(brand, btnPP, lbl, prog, sep1, btnMinus, volVal, btnPlus, sep2, btnClose);
    shadow.appendChild(bar);
  }

  const btnPP  = bar.querySelector(".btn-pp");
  const lbl    = bar.querySelector(".lbl");
  const volVal = bar.querySelector(".vol-val");
  const progFill = bar.querySelector(".prog-fill");

  // Always refresh volume display
  if (volVal) volVal.textContent = fmtVol(_currentVolume);

  if (progFill) {
    if (progress?.total > 0) {
      const percent = Math.max(0, Math.min(1, progress.percent ?? progress.current / progress.total));
      progFill.classList.remove("is-indeterminate");
      progFill.style.width = Math.round(percent * 100) + "%";
    } else {
      progFill.style.width = "";
      progFill.classList.add("is-indeterminate");
    }
  }

  if (isPaused) {
    btnPP.textContent = "▶";
    btnPP.title       = "Resume";
    lbl.textContent   = "Paused";
    lbl.className     = "lbl paused";
  } else {
    btnPP.textContent = "⏸";
    btnPP.title       = "Pause";
    lbl.textContent   = "Playing";
    lbl.className     = "lbl";
  }
}

// Poll background every second — source of truth, corrects optimistic state if needed
setInterval(() => {
  chrome.runtime.sendMessage({ type: "get-playback-state" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    _localPlaying = resp.isPlaying;
    _localPaused  = resp.isPaused;
    if (resp.volume != null) _currentVolume = resp.volume;
    updateOverlay(resp.isPlaying, resp.isPaused, resp.progress);
  });
}, 1000);
