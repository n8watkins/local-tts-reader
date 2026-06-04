// ─── Piper TTS — Content Script ──────────────────────────────────────────────
// Injected into every webpage.
//   1. Selection bridge for Chrome commands
//   2. Floating "Now Playing" overlay (shadow DOM, bottom-right corner)

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
let _runtimeUnavailable = false;
let _playbackPollTimer = null;

function isRuntimeUnavailableError(error) {
  const message = String(error?.message || error || "");
  return /Extension context invalidated|Receiving end does not exist/i.test(message);
}

function isExpectedRuntimeMessageError(error) {
  const message = String(error?.message || error || "");
  return isRuntimeUnavailableError(error) || /message port closed|message channel closed/i.test(message);
}

function markRuntimeUnavailable() {
  _runtimeUnavailable = true;
  if (_playbackPollTimer) {
    clearInterval(_playbackPollTimer);
    _playbackPollTimer = null;
  }
}

function getRuntimeLastError() {
  try {
    return chrome.runtime.lastError || null;
  } catch (error) {
    if (isRuntimeUnavailableError(error)) {
      markRuntimeUnavailable();
      return error;
    }
    console.warn("[Piper TTS] runtime lastError failed", error);
    return error;
  }
}

function safeRuntimeCallback(callback) {
  return (...args) => {
    if (_runtimeUnavailable) return;
    try {
      callback(...args);
    } catch (error) {
      if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
      else console.warn("[Piper TTS] runtime callback failed", error);
    }
  };
}

function sendRuntimeMessage(message, callback) {
  if (_runtimeUnavailable) return;

  try {
    const maybePromise = callback
      ? chrome.runtime.sendMessage(message, safeRuntimeCallback(callback))
      : chrome.runtime.sendMessage(message);

    if (maybePromise?.catch) {
      maybePromise.catch((error) => {
        if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
        else if (!isExpectedRuntimeMessageError(error)) console.warn("[Piper TTS] runtime message failed", error);
      });
    }
  } catch (error) {
    if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
    else if (!isExpectedRuntimeMessageError(error)) console.warn("[Piper TTS] runtime message failed", error);
  }
}

function applyPlaybackState(state) {
  if (!state) return;
  _localPlaying = !!state.isPlaying;
  _localPaused  = !!state.isPaused;
  if (state.volume != null) _currentVolume = state.volume;
  updateOverlay(_localPlaying, _localPaused, state.progress);
}

try {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "playback-state") {
      applyPlaybackState(message.state);
      return;
    }
    if (message.type === "get-selection") {
      const text = window.getSelection()?.toString().trim() || _lastSelection;
      sendResponse({ text });
      return;
    }
    if (message.type === "show-hint") {
      showHint(message.message || "");
    }
  });
} catch (error) {
  if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
  else console.warn("[Piper TTS] runtime listener failed", error);
}

// Stop when this tab navigates away or closes
window.addEventListener("pagehide", () => {
  sendRuntimeMessage({ type: "tab-unloading" });
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
  sendRuntimeMessage({ type: "adjust-volume", delta }, (resp) => {
    const error = getRuntimeLastError();
    if (error) {
      if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
      return;
    }
    if (!resp?.ok) return;
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
      if (!_localPlaying) return;
      _localPaused = !_localPaused;
      updateOverlay(_localPlaying, _localPaused); // instant update
      sendRuntimeMessage({ type: "keyboard-pause" });
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
      sendRuntimeMessage({ type: "stop-all" });
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

// One initial sync; later changes are pushed by background.js via playback-state.
sendRuntimeMessage({ type: "get-playback-state" }, (resp) => {
  const error = getRuntimeLastError();
  if (error) {
    if (isRuntimeUnavailableError(error)) markRuntimeUnavailable();
    return;
  }
  applyPlaybackState(resp);
});
