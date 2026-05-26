// ─── Constants ────────────────────────────────────────────────────────────────
const PIPER_BASE_URL = "http://127.0.0.1:5050";

// ─── DOM References ───────────────────────────────────────────────────────────
const profileNameEl  = document.getElementById("profile-name");
const profileVoiceEl = document.getElementById("profile-voice");
const prevBtn        = document.getElementById("prev-profile-btn");
const nextBtn        = document.getElementById("next-profile-btn");
const addProfileBtn  = document.getElementById("add-profile-btn");
const rateSlider     = document.getElementById("rate-slider");
const rateValue      = document.getElementById("rate-value");
const volumeSlider   = document.getElementById("volume-slider");
const volumeValue    = document.getElementById("volume-value");
const testBtn        = document.getElementById("test-btn");
const stopBtn        = document.getElementById("stop-btn");
const testError      = document.getElementById("test-error");
const statusDot      = document.getElementById("status-dot");
const settingsBtn    = document.getElementById("settings-btn");

// ─── State ────────────────────────────────────────────────────────────────────
let profiles  = [];
let activeIdx = 0;   // index into profiles[]

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(v) { return parseFloat(v).toFixed(1); }

function formatVoiceName(filename) {
  if (!filename) return "No voice set — open Settings";
  const base  = filename.replace(/\.onnx$/, "");
  const parts = base.split("-");
  if (parts.length >= 3) {
    const name    = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    const quality = parts[2].charAt(0).toUpperCase() + parts[2].slice(1);
    return `${name} · ${quality}`;
  }
  return base;
}

function activeProfile() { return profiles[activeIdx] ?? null; }

// ─── UI Sync ──────────────────────────────────────────────────────────────────
function updateProfileUI() {
  const p = activeProfile();

  if (!p) {
    profileNameEl.textContent  = "No profiles";
    profileVoiceEl.textContent = "Open Settings to create one";
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    rateSlider.disabled   = true;
    volumeSlider.disabled = true;
    testBtn.disabled = true;
    return;
  }

  profileNameEl.textContent  = p.name;
  profileVoiceEl.textContent = formatVoiceName(p.voice);

  rateSlider.value   = p.rate   ?? 1.0;
  volumeSlider.value = p.volume ?? 1.0;
  rateValue.textContent   = fmt(rateSlider.value) + "×";
  volumeValue.textContent = fmt(volumeSlider.value);

  const multi = profiles.length > 1;
  prevBtn.disabled = !multi;
  nextBtn.disabled = !multi;
  rateSlider.disabled   = false;
  volumeSlider.disabled = false;
  testBtn.disabled = false;
}

// ─── Persist ──────────────────────────────────────────────────────────────────
function saveProfile() {
  const p = activeProfile();
  if (!p) return;
  p.rate   = parseFloat(rateSlider.value);
  p.volume = parseFloat(volumeSlider.value);
  chrome.storage.local.set({ profiles, activeId: p.id });
}

// ─── Profile Navigation ───────────────────────────────────────────────────────
prevBtn.addEventListener("click", () => {
  if (profiles.length <= 1) return;
  activeIdx = (activeIdx - 1 + profiles.length) % profiles.length;
  updateProfileUI();
  chrome.storage.local.set({ activeId: profiles[activeIdx].id });
});

nextBtn.addEventListener("click", () => {
  if (profiles.length <= 1) return;
  activeIdx = (activeIdx + 1) % profiles.length;
  updateProfileUI();
  chrome.storage.local.set({ activeId: profiles[activeIdx].id });
});

// ─── Quick Add Profile ────────────────────────────────────────────────────────
addProfileBtn.addEventListener("click", () => {
  const name = prompt("New profile name:");
  if (!name?.trim()) return;

  const base = activeProfile() ?? { voice: "", rate: 1.0, volume: 1.0 };
  const newP = {
    id:     crypto.randomUUID(),
    name:   name.trim(),
    voice:  base.voice,
    rate:   base.rate,
    volume: base.volume
  };
  profiles.push(newP);
  activeIdx = profiles.length - 1;
  chrome.storage.local.set({ profiles, activeId: newP.id });
  updateProfileUI();
});

// ─── Sliders ──────────────────────────────────────────────────────────────────
rateSlider.addEventListener("input", () => {
  rateValue.textContent = fmt(rateSlider.value) + "×";
  saveProfile();
});

volumeSlider.addEventListener("input", () => {
  volumeValue.textContent = fmt(volumeSlider.value);
  saveProfile();
});

// ─── Settings ─────────────────────────────────────────────────────────────────
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// ─── Test Voice ───────────────────────────────────────────────────────────────
testBtn.addEventListener("click", () => {
  const p = activeProfile();
  testBtn.textContent = "Playing…";
  testBtn.disabled    = true;

  chrome.runtime.sendMessage(
    {
      type:     "test-voice",
      text:     "This is a local text to speech test.",
      settings: {
        voice:  p?.voice  || "",
        rate:   parseFloat(rateSlider.value),
        volume: parseFloat(volumeSlider.value)
      }
    },
    (response) => {
      testBtn.textContent = "▶ Test";
      testBtn.disabled    = false;
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) { showError("Extension error: " + runtimeErr.message); return; }
      if (response && !response.ok) showError(response.error || "Test failed.");
    }
  );
});

// ─── Stop ─────────────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop-all" });
});

// ─── Error Display ────────────────────────────────────────────────────────────
let errTimer = null;
function showError(msg) {
  testError.textContent = msg;
  testError.classList.remove("hidden");
  clearTimeout(errTimer);
  errTimer = setTimeout(() => testError.classList.add("hidden"), 5000);
}

// ─── Piper Status ─────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res   = await fetch(`${PIPER_BASE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      statusDot.className = "status-dot online";
      statusDot.title     = "Piper online";
      return;
    }
  } catch (_) {}
  statusDot.className = "status-dot offline";
  statusDot.title     = "Piper offline";
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  document.getElementById("app-version").textContent =
    "v" + chrome.runtime.getManifest().version;

  const stored = await chrome.storage.local.get({
    profiles: [],
    activeId: ""
  });

  // Bootstrap default profile
  if (stored.profiles.length === 0) {
    stored.profiles = [{ id: "default", name: "Default", voice: "", rate: 1.0, volume: 1.0 }];
    stored.activeId = "default";
    await chrome.storage.local.set({ profiles: stored.profiles, activeId: stored.activeId });
  }

  profiles  = stored.profiles;
  const idx = profiles.findIndex(p => p.id === stored.activeId);
  activeIdx = idx >= 0 ? idx : 0;

  updateProfileUI();
  checkStatus();
}

init();
