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

const PIPER_URL    = "http://127.0.0.1:5050";
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
    checkPiperStatus();
  }
}

// ─── Piper Status Check ───────────────────────────────────────────────────────
let statusCheckTimeout = null;

async function checkPiperStatus() {
  piperStatusBadge.textContent = "Checking…";
  piperStatusBadge.className = "status-badge";

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    const res = await fetch(`${PIPER_URL}/health`, {
      signal: controller.signal
    });

    clearTimeout(timer);

    if (res.ok) {
      setOnline();
    } else {
      setOffline();
    }
  } catch (_) {
    // /health may not exist — try a HEAD on the root
    try {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), 2500);

      await fetch(`${PIPER_URL}/`, {
        method: "HEAD",
        signal: controller2.signal
      });

      clearTimeout(timer2);
      setOnline();
    } catch (_2) {
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

  chrome.runtime.sendMessage(
    {
      type: "test-voice",
      engine,
      text: "This is a local text to speech test.",
      settings
    },
    () => {
      testBtn.textContent = "Test Voice";
      testBtn.disabled = false;
    }
  );
});

// ─── Stop Reading ─────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop-all" });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSettings();
