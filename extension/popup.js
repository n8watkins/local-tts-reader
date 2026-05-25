// ─── DOM References ───────────────────────────────────────────────────────────
const engineSelect     = document.getElementById("engine-select");
const piperStatusSec   = document.getElementById("piper-status-section");
const piperStatusBadge = document.getElementById("piper-status-badge");
const piperHint        = document.getElementById("piper-hint");
const fallbackSec      = document.getElementById("fallback-section");
const pitchSection     = document.getElementById("pitch-section");
const rateSlider       = document.getElementById("rate-slider");
const rateValue        = document.getElementById("rate-value");
const pitchSlider      = document.getElementById("pitch-slider");
const pitchValue       = document.getElementById("pitch-value");
const volumeSlider     = document.getElementById("volume-slider");
const volumeValue      = document.getElementById("volume-value");
const fallbackCheck    = document.getElementById("fallback-checkbox");
const testBtn          = document.getElementById("test-btn");
const stopBtn          = document.getElementById("stop-btn");
const testError        = document.getElementById("test-error"); // V4: error display

const PIPER_URL = "http://127.0.0.1:5050";
const DEFAULTS = {
  engine: "browser",
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
  fallbackToBrowser: true
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(val) {
  return parseFloat(val).toFixed(1);
}

function applyEngineUI(engine) {
  const isPiper = engine === "piper";

  // Show/hide Piper-specific sections
  piperStatusSec.classList.toggle("hidden", !isPiper);
  fallbackSec.classList.toggle("hidden", !isPiper);

  // Pitch only applies to browser TTS
  pitchSection.classList.toggle("hidden", isPiper);

  if (isPiper) {
    // C7 fix: scheduleStatusCheck() debounces rapid engine-toggle clicks so
    // multiple concurrent fetch sequences don't race on the badge.
    scheduleStatusCheck();
  }
}

// ─── Piper Status Check ───────────────────────────────────────────────────────
// C7 fix: statusCheckTimeout is now actually wired up for debouncing.
// Previously declared but never assigned, allowing rapid engine toggles to
// fire concurrent fetch sequences that would race on badge text/class updates.
let statusCheckTimeout = null;

function scheduleStatusCheck(delayMs = 300) {
  clearTimeout(statusCheckTimeout);
  statusCheckTimeout = setTimeout(doCheckPiperStatus, delayMs);
}

async function doCheckPiperStatus() {
  piperStatusBadge.textContent = "Checking…";
  piperStatusBadge.className = "status-badge";

  // C9 fix: hoist timer1 to outer scope so we can clearTimeout in the catch
  // block. Previously the timer was scoped inside try{} and never cleared when
  // the fetch threw for a non-abort reason, leaking a live timer per check.
  let timer1 = null;

  try {
    const controller = new AbortController();
    timer1 = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(`${PIPER_URL}/health`, {
      signal: controller.signal
    });

    clearTimeout(timer1);

    if (res.ok) {
      setOnline();
    } else {
      setOffline();
    }
  } catch (_) {
    clearTimeout(timer1); // C9 fix: always clear, even on non-abort throws

    // /health may not exist on older server versions — try a HEAD on the root
    // V1 fix: hoist timer2 so clearTimeout runs in catch, not just on success.
    // Same pattern as the C9 fix for timer1 above.
    let timer2 = null;
    try {
      const controller2 = new AbortController();
      timer2 = setTimeout(() => controller2.abort(), 2500);

      await fetch(`${PIPER_URL}/`, {
        method: "HEAD",
        signal: controller2.signal
      });

      clearTimeout(timer2);
      setOnline();
    } catch (_2) {
      clearTimeout(timer2); // V1 fix: always clear, even on non-abort throws
      setOffline();
    }
  }
}

function setOnline() {
  piperStatusBadge.textContent = "Online ✓";
  piperStatusBadge.className = "status-badge online";
  piperHint.classList.add("hidden");
}

function setOffline() {
  piperStatusBadge.textContent = "Offline ✗";
  piperStatusBadge.className = "status-badge offline";
  piperHint.classList.remove("hidden");
}

// ─── Save Settings ────────────────────────────────────────────────────────────
function saveSettings() {
  chrome.storage.local.set({
    engine: engineSelect.value,
    rate: parseFloat(rateSlider.value),
    pitch: parseFloat(pitchSlider.value),
    volume: parseFloat(volumeSlider.value),
    fallbackToBrowser: fallbackCheck.checked
  });
}

// ─── Load Settings ────────────────────────────────────────────────────────────
async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULTS);

  engineSelect.value      = settings.engine;
  rateSlider.value        = settings.rate;
  pitchSlider.value       = settings.pitch;
  volumeSlider.value      = settings.volume;
  fallbackCheck.checked   = settings.fallbackToBrowser;

  rateValue.textContent   = fmt(settings.rate);
  pitchValue.textContent  = fmt(settings.pitch);
  volumeValue.textContent = fmt(settings.volume);

  applyEngineUI(settings.engine);
}

// ─── Event Listeners ──────────────────────────────────────────────────────────
engineSelect.addEventListener("change", () => {
  applyEngineUI(engineSelect.value);
  saveSettings();
});

rateSlider.addEventListener("input", () => {
  rateValue.textContent = fmt(rateSlider.value);
  saveSettings();
});

pitchSlider.addEventListener("input", () => {
  pitchValue.textContent = fmt(pitchSlider.value);
  saveSettings();
});

volumeSlider.addEventListener("input", () => {
  volumeValue.textContent = fmt(volumeSlider.value);
  saveSettings();
});

fallbackCheck.addEventListener("change", saveSettings);

// ─── Test Error Display ───────────────────────────────────────────────────────
let testErrorTimer = null;

function showTestError(msg) {
  if (!testError) return;
  testError.textContent = msg;
  testError.classList.remove("hidden");
  clearTimeout(testErrorTimer);
  testErrorTimer = setTimeout(() => testError.classList.add("hidden"), 5000);
}

// ─── Test Voice ───────────────────────────────────────────────────────────────
testBtn.addEventListener("click", () => {
  const engine = engineSelect.value;
  const settings = {
    rate: parseFloat(rateSlider.value),
    pitch: parseFloat(pitchSlider.value),
    volume: parseFloat(volumeSlider.value)
  };

  testBtn.textContent = "Playing…";
  testBtn.disabled = true;

  // V4 fix: callback now accepts and checks the response object.
  // Previously declared () => {} with no params — {ok:false, error:…} was
  // silently discarded and the user saw no indication of failure.
  chrome.runtime.sendMessage(
    {
      type: "test-voice",
      engine,
      text: "This is a local text to speech test.",
      settings
    },
    (response) => {
      testBtn.textContent = "Test Voice";
      testBtn.disabled = false;

      if (response && !response.ok) {
        showTestError(response.error || "Test failed — check the console for details.");
      }
    }
  );
});

// ─── Stop Reading ─────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop-all" });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
