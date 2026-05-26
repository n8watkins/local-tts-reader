// ─── DOM References ───────────────────────────────────────────────────────────
const profileSelect    = document.getElementById("profile-select");
const addProfileBtn    = document.getElementById("add-profile-btn");
const renameProfileBtn = document.getElementById("rename-profile-btn");
const delProfileBtn    = document.getElementById("del-profile-btn");

const voiceSelect      = document.getElementById("voice-select");
const favBtn           = document.getElementById("fav-btn");
const delVoiceBtn      = document.getElementById("del-voice-btn");
const favsOnlyCheck    = document.getElementById("favs-only-check");

const rateSlider       = document.getElementById("rate-slider");
const rateValue        = document.getElementById("rate-value");
const volumeSlider     = document.getElementById("volume-slider");
const volumeValue      = document.getElementById("volume-value");

const fallbackCheck    = document.getElementById("fallback-checkbox");
const testBtn          = document.getElementById("test-btn");
const stopBtn          = document.getElementById("stop-btn");
const testError        = document.getElementById("test-error");

const piperBadge       = document.getElementById("piper-status-badge");
const deletedDetails   = document.getElementById("deleted-details");
const deletedCount     = document.getElementById("deleted-count");
const deletedList      = document.getElementById("deleted-list");

const PIPER_URL = "http://127.0.0.1:5050";

// ─── State ────────────────────────────────────────────────────────────────────
let profiles       = [];
let activeId       = "";
let favorites      = [];
let deletedVoices  = [];
let favsOnly       = false;
let fallback       = true;
let allVoices      = []; // fetched from server

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(val) { return parseFloat(val).toFixed(1); }

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatVoiceName(filename) {
  const base  = filename.replace(/\.onnx$/, "");
  const parts = base.split("-");
  if (parts.length >= 3) {
    const name    = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    const quality = parts[2].charAt(0).toUpperCase() + parts[2].slice(1);
    return `${name} · ${quality}`;
  }
  return base;
}

function activeProfile() {
  return profiles.find(p => p.id === activeId) || profiles[0] || null;
}

// ─── Persist ──────────────────────────────────────────────────────────────────
function save() {
  chrome.storage.local.set({ profiles, activeId, favorites, deletedVoices, favsOnly, fallback });
}

// ─── Profiles ─────────────────────────────────────────────────────────────────
function renderProfiles() {
  profileSelect.innerHTML = "";
  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === activeId) opt.selected = true;
    profileSelect.appendChild(opt);
  }
}

function loadProfileIntoUI(profile) {
  if (!profile) return;
  rateSlider.value   = profile.rate;
  volumeSlider.value = profile.volume;
  rateValue.textContent   = fmt(profile.rate);
  volumeValue.textContent = fmt(profile.volume);
  // Set voice in dropdown (may not exist if voice list not yet fetched)
  if (profile.voice) voiceSelect.value = profile.voice;
  updateFavBtn();
}

function saveActiveProfileSettings() {
  const p = activeProfile();
  if (!p) return;
  p.rate   = parseFloat(rateSlider.value);
  p.volume = parseFloat(volumeSlider.value);
  p.voice  = voiceSelect.value;
  save();
}

// ─── Profile CRUD ─────────────────────────────────────────────────────────────
addProfileBtn.addEventListener("click", () => {
  const name = prompt("Profile name:");
  if (!name?.trim()) return;
  const base = activeProfile() || { voice: "", rate: 1.0, volume: 1.0 };
  const newP = { id: uuid(), name: name.trim(), voice: base.voice, rate: base.rate, volume: base.volume };
  profiles.push(newP);
  activeId = newP.id;
  renderProfiles();
  loadProfileIntoUI(newP);
  save();
});

renameProfileBtn.addEventListener("click", () => {
  const p = activeProfile();
  if (!p) return;
  const name = prompt("New name:", p.name);
  if (!name?.trim()) return;
  p.name = name.trim();
  renderProfiles();
  save();
});

delProfileBtn.addEventListener("click", () => {
  if (profiles.length <= 1) { alert("Can't delete the last profile."); return; }
  const p = activeProfile();
  if (!p) return;
  if (!confirm(`Delete profile "${p.name}"?`)) return;
  profiles = profiles.filter(x => x.id !== p.id);
  activeId = profiles[0].id;
  renderProfiles();
  loadProfileIntoUI(activeProfile());
  save();
});

profileSelect.addEventListener("change", () => {
  activeId = profileSelect.value;
  loadProfileIntoUI(activeProfile());
  save();
});

// ─── Voice List ───────────────────────────────────────────────────────────────
function updateFavBtn() {
  const v = voiceSelect.value;
  const isFav = favorites.includes(v);
  favBtn.textContent = isFav ? "★" : "☆";
  favBtn.classList.toggle("active", isFav);
  favBtn.title = isFav ? "Remove from favourites" : "Add to favourites";
}

function renderVoiceList(selectedVoice) {
  const pool = favsOnly ? allVoices.filter(v => favorites.includes(v)) : allVoices;
  const sorted = [
    ...pool.filter(v =>  favorites.includes(v)).sort(),
    ...pool.filter(v => !favorites.includes(v)).sort()
  ];

  voiceSelect.innerHTML = "";

  if (sorted.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = favsOnly ? "No favourites yet" : "No voices installed";
    voiceSelect.appendChild(opt);
  } else {
    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = (favorites.includes(v) ? "★ " : "") + formatVoiceName(v);
      if (v === selectedVoice) opt.selected = true;
      voiceSelect.appendChild(opt);
    }
    if (!voiceSelect.value && sorted.length > 0) {
      // Select first available voice visually, but don't save — the profile's
      // stored voice takes precedence. Saving here would overwrite the profile
      // with an arbitrary default every time the voice list is (re)fetched.
      voiceSelect.value = sorted[0];
    }
  }

  updateFavBtn();
}

async function fetchVoiceList() {
  const current = activeProfile()?.voice || "";
  try {
    const res = await fetch(`${PIPER_URL}/voices`);
    const { voices } = await res.json();
    allVoices = voices;
    renderVoiceList(current);
  } catch (_) {
    voiceSelect.innerHTML = '<option value="">Server offline</option>';
  }
}

voiceSelect.addEventListener("change", () => {
  saveActiveProfileSettings();
  updateFavBtn();
});

favBtn.addEventListener("click", () => {
  const v = voiceSelect.value;
  if (!v) return;
  favorites = favorites.includes(v)
    ? favorites.filter(f => f !== v)
    : [...favorites, v];
  renderVoiceList(v);
  save();
});

delVoiceBtn.addEventListener("click", async () => {
  const v = voiceSelect.value;
  if (!v) return;
  if (!confirm(`Delete "${formatVoiceName(v)}"?\nThis removes the voice file from disk and cannot be undone.`)) return;

  try {
    const res = await fetch(`${PIPER_URL}/voices/${encodeURIComponent(v)}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);

    // Log to deleted list
    deletedVoices = [
      { filename: v, displayName: formatVoiceName(v), deletedAt: new Date().toLocaleDateString() },
      ...deletedVoices.filter(d => d.filename !== v)
    ];

    // Remove from favorites if present
    favorites = favorites.filter(f => f !== v);

    // Clear from any profiles using it
    for (const p of profiles) {
      if (p.voice === v) p.voice = "";
    }

    save();
    allVoices = allVoices.filter(x => x !== v);
    renderVoiceList("");
    renderDeletedLog();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
});

favsOnlyCheck.addEventListener("change", () => {
  favsOnly = favsOnlyCheck.checked;
  renderVoiceList(voiceSelect.value);
  save();
});

// ─── Deleted Voice Log ────────────────────────────────────────────────────────
function renderDeletedLog() {
  if (deletedVoices.length === 0) {
    deletedDetails.style.display = "none";
    return;
  }
  deletedDetails.style.display = "";
  deletedCount.textContent = `(${deletedVoices.length})`;
  deletedList.innerHTML = "";
  for (const d of deletedVoices) {
    const row = document.createElement("div");
    row.className = "deleted-item";
    // Use textContent (not innerHTML) — displayName is derived from a server
    // filename and could contain characters that would be interpreted as HTML.
    const nameSpan = document.createElement("span");
    nameSpan.className = "deleted-name";
    nameSpan.textContent = d.displayName;
    const dateSpan = document.createElement("span");
    dateSpan.textContent = d.deletedAt;
    row.appendChild(nameSpan);
    row.appendChild(dateSpan);
    deletedList.appendChild(row);
  }
}

// ─── Piper Status ─────────────────────────────────────────────────────────────
let statusTimer = null;

function scheduleStatusCheck(delay = 300) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(checkPiperStatus, delay);
}

async function checkPiperStatus() {
  piperBadge.textContent = "Checking…";
  piperBadge.className   = "status-badge";

  let t1 = null;
  try {
    const ctrl = new AbortController();
    t1 = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${PIPER_URL}/health`, { signal: ctrl.signal });
    clearTimeout(t1);
    if (res.ok) { setOnline(); return; }
  } catch (_) { clearTimeout(t1); }

  let t2 = null;
  try {
    const ctrl = new AbortController();
    t2 = setTimeout(() => ctrl.abort(), 2500);
    await fetch(`${PIPER_URL}/`, { method: "HEAD", signal: ctrl.signal });
    clearTimeout(t2);
    setOnline();
  } catch (_) { clearTimeout(t2); setOffline(); }
}

function setOnline()  {
  piperBadge.textContent = "Online ✓";
  piperBadge.className   = "status-badge online";
  fetchVoiceList();
}

function setOffline() {
  piperBadge.textContent = "Offline ✗";
  piperBadge.className   = "status-badge offline";
  voiceSelect.innerHTML  = '<option value="">Server offline</option>';
}

// ─── Sliders ──────────────────────────────────────────────────────────────────
rateSlider.addEventListener("input", () => {
  rateValue.textContent = fmt(rateSlider.value);
  saveActiveProfileSettings();
});

volumeSlider.addEventListener("input", () => {
  volumeValue.textContent = fmt(volumeSlider.value);
  saveActiveProfileSettings();
});

fallbackCheck.addEventListener("change", () => {
  fallback = fallbackCheck.checked;
  save();
});

// ─── Test Error ───────────────────────────────────────────────────────────────
let testErrorTimer = null;

function showTestError(msg) {
  testError.textContent = msg;
  testError.classList.remove("hidden");
  clearTimeout(testErrorTimer);
  testErrorTimer = setTimeout(() => testError.classList.add("hidden"), 5000);
}

// ─── Test Voice ───────────────────────────────────────────────────────────────
testBtn.addEventListener("click", () => {
  const p = activeProfile();
  testBtn.textContent = "Playing…";
  testBtn.disabled    = true;

  chrome.runtime.sendMessage(
    {
      type: "test-voice",
      text: "This is a local text to speech test.",
      settings: {
        voice:  p?.voice  || "",
        rate:   parseFloat(rateSlider.value),
        volume: parseFloat(volumeSlider.value)
      }
    },
    (response) => {
      testBtn.textContent = "Test Voice";
      testBtn.disabled    = false;
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) { showTestError("Extension error: " + runtimeErr.message); return; }
      if (response && !response.ok) showTestError(response.error || "Test failed.");
    }
  );
});

// ─── Stop Reading ─────────────────────────────────────────────────────────────
stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop-all" });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
document.getElementById("app-version").textContent =
  "v" + chrome.runtime.getManifest().version;

async function init() {
  // Migrate old fallbackToBrowser key → fallback (one-time migration for
  // users upgrading from an earlier schema before the key was renamed).
  const rawKeys = await chrome.storage.local.get(["fallback", "fallbackToBrowser"]);
  if (rawKeys.fallbackToBrowser !== undefined && rawKeys.fallback === undefined) {
    await chrome.storage.local.set({ fallback: rawKeys.fallbackToBrowser });
    await chrome.storage.local.remove("fallbackToBrowser");
  }

  const stored = await chrome.storage.local.get({
    profiles:      [],
    activeId:      "",
    favorites:     [],
    deletedVoices: [],
    favsOnly:      false,
    fallback:      true
  });

  // Bootstrap default profile if none exist
  if (stored.profiles.length === 0) {
    stored.profiles = [{ id: "default", name: "Default", voice: "", rate: 1.0, volume: 1.0 }];
    stored.activeId = "default";
  }

  profiles      = stored.profiles;
  activeId      = stored.activeId || profiles[0].id;
  favorites     = stored.favorites;
  deletedVoices = stored.deletedVoices;
  favsOnly      = stored.favsOnly;
  fallback      = stored.fallback;

  favsOnlyCheck.checked  = favsOnly;
  fallbackCheck.checked  = fallback;

  renderProfiles();
  loadProfileIntoUI(activeProfile());
  renderDeletedLog();
  scheduleStatusCheck();
}

init();
