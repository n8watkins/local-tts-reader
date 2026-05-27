// ─── Constants ────────────────────────────────────────────────────────────────
const PIPER_BASE_URL = "http://127.0.0.1:5050";
const MAX_PROFILES   = 5;
const MAX_FAVORITES  = 5;

// ─── Icons (Lucide SVG, inlined) ──────────────────────────────────────────────
const ICON_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
const ICON_TRASH  = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

// ─── State ────────────────────────────────────────────────────────────────────
let profiles      = [];
let activeId      = "";
let favorites     = [];
let deletedVoices = [];
let favsOnly      = false;
let fallback      = true;
let allVoices     = [];    // filenames fetched from server
let voiceSizes    = {};    // { filename: bytes }
let voiceDir      = "";    // absolute path to voices folder on disk
let serverOnline  = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(v) { return parseFloat(v).toFixed(1); }

function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(1) + " GB";
  if (bytes >= 1_000_000)     return Math.round(bytes / 1_000_000) + " MB";
  return Math.round(bytes / 1_000) + " KB";
}

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatVoiceName(filename) {
  if (!filename) return "— None —";
  const base  = filename.replace(/\.onnx$/, "");
  const parts = base.split("-");
  if (parts.length >= 3) {
    const name    = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    const quality = parts[2].charAt(0).toUpperCase() + parts[2].slice(1);
    return `${name} · ${quality}`;
  }
  return base;
}

function qualityFromFilename(filename) {
  const base  = filename.replace(/\.onnx$/, "");
  const parts = base.split("-");
  const tier  = parts[parts.length - 1]?.toLowerCase();
  const map   = { "x_low": "x_low", "low": "low", "medium": "med", "high": "high" };
  return map[tier] || null;
}

function activeProfile() {
  return profiles.find(p => p.id === activeId) || profiles[0] || null;
}

// ─── Persist ──────────────────────────────────────────────────────────────────
// Note: shortcuts are NOT included here — they are written directly in startListening()
// so that a save() call during init() loading never overwrites user-customized bindings.
function save() {
  chrome.storage.local.set({ profiles, activeId, favorites, deletedVoices, favsOnly, fallback });
}

// ─── Custom Alert Modal ───────────────────────────────────────────────────────
function customAlert(message) {
  return new Promise(resolve => {
    const overlay    = document.getElementById("confirm-modal");
    const msgEl      = document.getElementById("modal-msg");
    const confirmBtn = document.getElementById("modal-confirm-btn");
    const cancelBtn  = document.getElementById("modal-cancel-btn");

    msgEl.textContent = message;
    confirmBtn.textContent = "Got it";
    cancelBtn.classList.add("hidden");
    overlay.classList.remove("hidden");

    function cleanup() {
      overlay.classList.add("hidden");
      confirmBtn.textContent = "Delete"; // restore default
      cancelBtn.classList.remove("hidden");
      confirmBtn.removeEventListener("click", onOk);
    }
    function onOk() { cleanup(); resolve(); }
    confirmBtn.addEventListener("click", onOk);
  });
}

// ─── Custom Confirm Modal ─────────────────────────────────────────────────────
function customConfirm(message) {
  return new Promise(resolve => {
    const overlay    = document.getElementById("confirm-modal");
    const msgEl      = document.getElementById("modal-msg");
    const confirmBtn = document.getElementById("modal-confirm-btn");
    const cancelBtn  = document.getElementById("modal-cancel-btn");

    msgEl.textContent = message;
    overlay.classList.remove("hidden");

    function cleanup() {
      overlay.classList.add("hidden");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
    }
    function onConfirm() { cleanup(); resolve(true); }
    function onCancel()  { cleanup(); resolve(false); }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll(".tab").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  document.querySelectorAll(".tab-panel").forEach(p => {
    p.classList.toggle("hidden", p.id !== `tab-${name}`);
  });
  if (name === "voices" && allVoices.length === 0) fetchVoices();
  if (name === "settings") renderSettings();
}

// ─── Server Status ────────────────────────────────────────────────────────────
const serverBadge = document.getElementById("server-badge");

async function checkServerStatus() {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res   = await fetch(`${PIPER_BASE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    serverOnline = res.ok;
  } catch (_) {
    serverOnline = false;
  }

  serverBadge.textContent = serverOnline ? "Piper Online ✓" : "Piper Offline ✗";
  serverBadge.className   = "server-badge " + (serverOnline ? "online" : "offline");

  const settingsStatus = document.getElementById("settings-server-status");
  if (settingsStatus) {
    settingsStatus.textContent = serverOnline ? "Online ✓" : "Offline ✗";
    settingsStatus.style.color = serverOnline ? "#a6e3a1" : "#f38ba8";
  }
}

// ─── Voices — Fetch ───────────────────────────────────────────────────────────
async function fetchVoices() {
  const banner = document.getElementById("voices-offline-banner");

  if (!serverOnline) {
    // Try one more time in case status changed
    await checkServerStatus();
  }

  if (!serverOnline) {
    banner.classList.remove("hidden");
    document.getElementById("voice-grid").innerHTML =
      '<p class="no-items">Start the Piper server to see installed voices.</p>';
    return;
  }

  banner.classList.add("hidden");

  try {
    const res  = await fetch(`${PIPER_BASE_URL}/voices`);
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const data = await res.json();
    allVoices  = data.voices   || [];
    voiceSizes = data.sizes    || {};
    voiceDir   = data.voiceDir || "";

    // Show folder path bar
    const folderBar  = document.getElementById("voices-folder-bar");
    const folderPath = document.getElementById("voices-folder-path");
    if (folderBar && voiceDir) {
      folderPath.textContent = voiceDir;
      folderBar.classList.remove("hidden");
    }

    renderVoices();
    refreshVoiceSelects();
  } catch (err) {
    document.getElementById("voice-grid").innerHTML =
      `<p class="no-items">Failed to load voices: ${err.message}</p>`;
  }
}

// ─── Voices — Render ──────────────────────────────────────────────────────────
function renderVoices() {
  const grid   = document.getElementById("voice-grid");
  const pool   = favsOnly ? allVoices.filter(v => favorites.includes(v)) : allVoices;

  // Favorites first, then alphabetical
  const sorted = [
    ...pool.filter(v =>  favorites.includes(v)).sort(),
    ...pool.filter(v => !favorites.includes(v)).sort()
  ];

  if (sorted.length === 0) {
    grid.innerHTML = favsOnly
      ? '<p class="no-items">No favourites yet. Star a voice to add it here.</p>'
      : '<p class="no-items">No voices installed. Download voices and place them in <code>piper/voices/</code>.</p>';
    return;
  }

  updateFavsCount();
  grid.innerHTML = "";
  for (const v of sorted) {
    const isFav = favorites.includes(v);
    const card  = document.createElement("div");
    card.className = "voice-card";
    card.dataset.voice = v;

    const favBtn = document.createElement("button");
    favBtn.className = "voice-fav-btn" + (isFav ? " is-fav" : "");
    favBtn.textContent = isFav ? "★" : "☆";
    favBtn.title = isFav ? "Remove from favorites" : "Add to favorites";
    favBtn.addEventListener("click", () => toggleFavorite(v));

    const info = document.createElement("div");
    info.className = "voice-card-info";

    const nameEl = document.createElement("span");
    nameEl.className = "voice-card-name";
    nameEl.textContent = (isFav ? "★ " : "") + formatVoiceName(v);

    const quality = qualityFromFilename(v);
    if (quality) {
      const badge = document.createElement("span");
      badge.className = `quality-badge quality-${quality}`;
      badge.textContent = quality === "x_low" ? "x-low" : quality;
      nameEl.appendChild(badge);
    }

    const fileEl = document.createElement("span");
    fileEl.className = "voice-card-file";
    const sizeStr = formatBytes(voiceSizes[v]);
    fileEl.textContent = sizeStr ? `${v}  ·  ${sizeStr}` : v;

    info.appendChild(nameEl);
    info.appendChild(fileEl);

    const btns = document.createElement("div");
    btns.className = "voice-card-btns";

    const testBtn = document.createElement("button");
    testBtn.className = "btn btn-ghost btn-sm";
    testBtn.textContent = "▶ Test";
    testBtn.addEventListener("click", () => testVoice(v, testBtn));

    const delBtn = document.createElement("button");
    delBtn.className = "btn btn-danger btn-sm";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteVoice(v, card));

    btns.appendChild(testBtn);
    btns.appendChild(delBtn);

    card.appendChild(favBtn);
    card.appendChild(info);
    card.appendChild(btns);
    grid.appendChild(card);
  }

  renderDeletedLog();
}

// ─── Voices — Favorites Count ─────────────────────────────────────────────────
function updateFavsCount() {
  const el = document.getElementById("favs-count");
  if (el) el.textContent = `${favorites.length} / ${MAX_FAVORITES} favorites`;
}

// ─── Voices — Favorite Toggle ─────────────────────────────────────────────────
async function toggleFavorite(filename) {
  if (favorites.includes(filename)) {
    favorites = favorites.filter(f => f !== filename);
  } else {
    if (favorites.length >= MAX_FAVORITES) {
      await customAlert(
        `You've reached the ${MAX_FAVORITES}-favorite limit.\n\nUnstar a voice to make room for another.`
      );
      return;
    }
    favorites = [...favorites, filename];
  }
  save();
  renderVoices();
}

// ─── Voices — Test ────────────────────────────────────────────────────────────
function testVoice(filename, btn) {
  const orig = btn.textContent;
  btn.textContent = "Playing…";
  btn.disabled    = true;

  chrome.runtime.sendMessage(
    {
      type:     "test-voice",
      text:     "This is a test of the voice " + formatVoiceName(filename) + ".",
      settings: { voice: filename, rate: 1.0, volume: 1.0 }
    },
    (response) => {
      btn.textContent = orig;
      btn.disabled    = false;
      const runtimeErr = chrome.runtime.lastError;
      if (runtimeErr) return;
      if (response && !response.ok) {
        alert("Test failed: " + (response.error || "Unknown error"));
      }
    }
  );
}

// ─── Voices — Delete ──────────────────────────────────────────────────────────
async function deleteVoice(filename, cardEl) {
  const confirmed = await customConfirm(
    `Delete "${formatVoiceName(filename)}"?\nThis removes the voice file from disk and cannot be undone.`
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`${PIPER_BASE_URL}/voices/${encodeURIComponent(filename)}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server responded ${res.status}`);
    }

    // Update state
    deletedVoices = [
      { filename, displayName: formatVoiceName(filename), deletedAt: new Date().toLocaleDateString() },
      ...deletedVoices.filter(d => d.filename !== filename)
    ];
    favorites = favorites.filter(f => f !== filename);
    for (const p of profiles) { if (p.voice === filename) p.voice = ""; }

    allVoices = allVoices.filter(x => x !== filename);
    save();
    cardEl.remove();
    renderDeletedLog();
    refreshVoiceSelects(); // update dropdowns in open edit forms

    // If grid is now empty, show placeholder
    const grid = document.getElementById("voice-grid");
    if (grid.querySelectorAll(".voice-card").length === 0) renderVoices();

  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

// ─── Voices — Deleted Log ─────────────────────────────────────────────────────
function renderDeletedLog() {
  const section  = document.getElementById("deleted-section");
  const countEl  = document.getElementById("deleted-count");
  const listEl   = document.getElementById("deleted-list");

  if (deletedVoices.length === 0) {
    section.style.display = "none";
    return;
  }

  section.style.display = "";
  countEl.textContent = `(${deletedVoices.length})`;
  listEl.innerHTML = "";

  for (const d of deletedVoices) {
    const row      = document.createElement("div");
    row.className  = "deleted-item";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = d.displayName;

    const dateSpan = document.createElement("span");
    dateSpan.className = "deleted-item-date";
    dateSpan.textContent = d.deletedAt;

    row.appendChild(nameSpan);
    row.appendChild(dateSpan);
    listEl.appendChild(row);
  }
}

// ─── Voices — Open folder ─────────────────────────────────────────────────────
document.getElementById("open-folder-btn").addEventListener("click", () => {
  fetch(`${PIPER_BASE_URL}/voices/open-folder`, { method: "POST" }).catch(() => {});
});

// ─── Voices — Favs-only toggle ────────────────────────────────────────────────
document.getElementById("favs-only-check").addEventListener("change", (e) => {
  favsOnly = e.target.checked;
  save();
  renderVoices();
});

// ─── Profiles — Render ────────────────────────────────────────────────────────
function renderProfiles() {
  const list    = document.getElementById("profile-list");
  const newBtn  = document.getElementById("new-profile-btn");
  const hint    = document.getElementById("profile-count-hint");

  hint.textContent = `${profiles.length} / ${MAX_PROFILES}`;
  newBtn.disabled  = profiles.length >= MAX_PROFILES;

  list.innerHTML = "";

  if (profiles.length === 0) {
    list.innerHTML = '<p class="no-items">No profiles yet. Click "+ New Profile" to get started.</p>';
    return;
  }

  for (const p of profiles) {
    list.appendChild(buildProfileCard(p));
  }
}

function buildProfileCard(profile) {
  const isActive = profile.id === activeId;
  const card = document.createElement("div");
  card.className = "profile-card" + (isActive ? " is-active" : "");
  card.dataset.id = profile.id;

  // ── Header row ──
  const header = document.createElement("div");
  header.className = "profile-card-header";

  // Status button — LEFT side, fixed width, always present
  const statusBtn = document.createElement("button");
  statusBtn.className = "btn btn-sm profile-status-btn" +
    (isActive ? " is-active-state" : " btn-ghost");
  statusBtn.textContent = isActive ? "Active" : "Set Active";
  statusBtn.disabled = isActive;
  if (!isActive) {
    statusBtn.addEventListener("click", () => {
      activeId = profile.id;
      save();
      renderProfiles();
    });
  }

  // Info column: name + meta stacked
  const info = document.createElement("div");
  info.className = "profile-card-info";

  const nameEl = document.createElement("span");
  nameEl.className = "profile-card-name";
  nameEl.textContent = profile.name;

  const meta = document.createElement("span");
  meta.className = "profile-card-meta";
  const voiceLabel = formatVoiceName(profile.voice);
  meta.textContent = `${voiceLabel}  ·  ${fmt(profile.rate)}×  ·  vol ${fmt(profile.volume)}`;

  info.appendChild(nameEl);
  info.appendChild(meta);

  // Icon buttons — RIGHT side
  const btns = document.createElement("div");
  btns.className = "profile-card-btns";

  const editBtn = document.createElement("button");
  editBtn.className = "btn-icon btn-icon-edit";
  editBtn.innerHTML = ICON_PENCIL;
  editBtn.title = "Edit profile";
  editBtn.addEventListener("click", () => toggleEditForm(profile.id, card));

  const delBtn = document.createElement("button");
  delBtn.className = "btn-icon btn-icon-delete";
  delBtn.innerHTML = ICON_TRASH;
  delBtn.disabled = profiles.length <= 1;
  delBtn.title = profiles.length <= 1 ? "Can't delete the only profile" : "Delete profile";
  delBtn.addEventListener("click", () => deleteProfile(profile.id));

  btns.appendChild(editBtn);
  btns.appendChild(delBtn);

  header.appendChild(statusBtn);
  header.appendChild(info);
  header.appendChild(btns);

  // ── Edit form (hidden) ──
  const form = buildProfileEditForm(profile);
  form.classList.add("profile-edit-form", "hidden");

  card.appendChild(header);
  card.appendChild(form);
  return card;
}

function buildProfileEditForm(profile) {
  const form = document.createElement("div");

  const grid = document.createElement("div");
  grid.className = "form-grid";

  // Name
  const nameLbl = label("Name");
  const nameInput = document.createElement("input");
  nameInput.className = "form-input";
  nameInput.type = "text";
  nameInput.maxLength = 40;
  nameInput.value = profile.name;

  // Voice
  const voiceLbl = label("Voice");
  const voiceSel = document.createElement("select");
  voiceSel.className = "form-select profile-voice-sel";
  populateVoiceSelect(voiceSel, profile.voice);

  // Rate
  const rateLbl = label("Speed");
  const rateWrap = document.createElement("div");
  rateWrap.className = "slider-inline";
  const rateSlider = document.createElement("input");
  rateSlider.className = "slider";
  rateSlider.type = "range";
  rateSlider.min = "0.5"; rateSlider.max = "2.5"; rateSlider.step = "0.1";
  rateSlider.value = profile.rate ?? 1.0;
  const rateVal = document.createElement("span");
  rateVal.className = "slider-val";
  rateVal.textContent = fmt(rateSlider.value) + "×";
  rateSlider.addEventListener("input", () => { rateVal.textContent = fmt(rateSlider.value) + "×"; });
  rateWrap.appendChild(rateSlider);
  rateWrap.appendChild(rateVal);

  // Volume
  const volLbl = label("Volume");
  const volWrap = document.createElement("div");
  volWrap.className = "slider-inline";
  const volSlider = document.createElement("input");
  volSlider.className = "slider";
  volSlider.type = "range";
  volSlider.min = "0"; volSlider.max = "2"; volSlider.step = "0.05";
  volSlider.value = profile.volume ?? 1.0;
  const volVal = document.createElement("span");
  volVal.className = "slider-val";
  volVal.textContent = fmt(volSlider.value);
  volSlider.addEventListener("input", () => { volVal.textContent = fmt(volSlider.value); });
  volWrap.appendChild(volSlider);
  volWrap.appendChild(volVal);

  grid.appendChild(nameLbl); grid.appendChild(nameInput);
  grid.appendChild(voiceLbl); grid.appendChild(voiceSel);
  grid.appendChild(rateLbl); grid.appendChild(rateWrap);
  grid.appendChild(volLbl); grid.appendChild(volWrap);

  // Actions
  const actions = document.createElement("div");
  actions.className = "profile-edit-actions";

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }

    if (profiles.some(p => p.id !== profile.id && p.name.toLowerCase() === name.toLowerCase())) {
      nameInput.setCustomValidity("A profile with this name already exists.");
      nameInput.reportValidity();
      nameInput.setCustomValidity("");
      return;
    }

    profile.name   = name;
    profile.voice  = voiceSel.value;
    profile.rate   = parseFloat(rateSlider.value);
    profile.volume = parseFloat(volSlider.value);
    save();
    renderProfiles();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn-ghost btn-sm";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => renderProfiles());

  const testBtn = document.createElement("button");
  testBtn.className = "btn btn-ghost btn-sm";
  testBtn.textContent = "▶ Test";
  testBtn.addEventListener("click", () => {
    testVoice(voiceSel.value || "", testBtn);
  });

  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  actions.appendChild(testBtn);

  form.appendChild(grid);
  form.appendChild(actions);
  return form;
}

function toggleEditForm(profileId, card) {
  const form = card.querySelector(".profile-edit-form");
  if (!form) return;
  form.classList.toggle("hidden");
}

async function deleteProfile(profileId) {
  if (profiles.length <= 1) return;  // button is disabled; guard anyway
  const p = profiles.find(x => x.id === profileId);
  if (!p) return;
  const confirmed = await customConfirm(`Delete profile "${p.name}"?`);
  if (!confirmed) return;
  profiles = profiles.filter(x => x.id !== profileId);
  if (activeId === profileId) activeId = profiles[0].id;
  save();
  renderProfiles();
}

// ─── Profiles — Create form ───────────────────────────────────────────────────
document.getElementById("new-profile-btn").addEventListener("click", async () => {
  if (profiles.length >= MAX_PROFILES) {
    await customAlert(
      `You've reached the ${MAX_PROFILES}-profile limit.\n\nDelete an existing profile to make room for a new one.`
    );
    return;
  }
  document.getElementById("create-profile-form").classList.remove("hidden");
  document.getElementById("cp-name").focus();
});

document.getElementById("cp-cancel-btn").addEventListener("click", () => {
  document.getElementById("create-profile-form").classList.add("hidden");
  document.getElementById("cp-name").value = "";
});

document.getElementById("cp-save-btn").addEventListener("click", () => {
  const nameInput = document.getElementById("cp-name");
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }

  if (profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    nameInput.setCustomValidity("A profile with this name already exists.");
    nameInput.reportValidity();
    nameInput.setCustomValidity("");
    return;
  }

  const newP = {
    id:     uuid(),
    name,
    voice:  document.getElementById("cp-voice").value,
    rate:   parseFloat(document.getElementById("cp-rate").value),
    volume: parseFloat(document.getElementById("cp-volume").value)
  };

  profiles.push(newP);
  if (profiles.length === 1) activeId = newP.id;
  save();

  document.getElementById("create-profile-form").classList.add("hidden");
  document.getElementById("cp-name").value = "";
  renderProfiles();
});

// Create form sliders
["cp-rate", "cp-volume"].forEach(id => {
  const slider = document.getElementById(id);
  const valEl  = document.getElementById(id + "-val");
  slider.addEventListener("input", () => {
    valEl.textContent = fmt(slider.value) + (id === "cp-rate" ? "×" : "");
  });
});

// ─── Shared helpers ───────────────────────────────────────────────────────────
function label(text) {
  const el = document.createElement("label");
  el.className = "form-label";
  el.textContent = text;
  return el;
}

function populateVoiceSelect(sel, selectedVoice) {
  sel.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "— None / use default —";
  sel.appendChild(noneOpt);

  const sorted = [
    ...allVoices.filter(v =>  favorites.includes(v)).sort(),
    ...allVoices.filter(v => !favorites.includes(v)).sort()
  ];

  for (const v of sorted) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = (favorites.includes(v) ? "★ " : "") + formatVoiceName(v);
    if (v === selectedVoice) opt.selected = true;
    sel.appendChild(opt);
  }

  if (selectedVoice && !sel.value) sel.value = "";
}

// Refresh all open profile voice selects (after voices are fetched or one is deleted)
function refreshVoiceSelects() {
  document.querySelectorAll(".profile-voice-sel").forEach(sel => {
    const card = sel.closest(".profile-card");
    if (!card) return;
    const profileId = card.dataset.id;
    const p = profiles.find(x => x.id === profileId);
    if (p) populateVoiceSelect(sel, p.voice);
  });

  // Also refresh the create form's voice select
  const cpVoice = document.getElementById("cp-voice");
  if (cpVoice) populateVoiceSelect(cpVoice, cpVoice.value);
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────
const DEFAULT_SHORTCUTS = { read: "Alt+Shift+R", pause: "Alt+Shift+D" };
let shortcuts = { ...DEFAULT_SHORTCUTS };

function comboFromEvent(e) {
  const parts = [];
  if (e.altKey)   parts.push("Alt");
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  // Use e.code (physical key position) not e.key (character).
  // On non-US keyboards / AltGr active, Alt+R produces e.key="®" — e.code is always "KeyR".
  // Must match the format produced by content.js comboFromEvent.
  if (!["Alt", "Control", "Shift", "Meta"].includes(e.key)) {
    const keyName =
      e.code.startsWith("Key")   ? e.code.slice(3)  :
      e.code.startsWith("Digit") ? e.code.slice(5)  :
      e.code;
    parts.push(keyName);
  }
  return parts.join("+");
}

function renderShortcuts() {
  const readBtn  = document.getElementById("bind-read");
  const pauseBtn = document.getElementById("bind-pause");
  if (readBtn)  readBtn.textContent  = shortcuts.read  || "—";
  if (pauseBtn) pauseBtn.textContent = shortcuts.pause || "—";
}

function startListening(btn, action) {
  if (btn.classList.contains("listening")) return; // already listening — ignore re-click
  btn.textContent = "Press keys…";
  btn.classList.add("listening");

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    // Require at least one of Ctrl/Alt (Chrome extension constraint)
    if (!e.ctrlKey && !e.altKey) return;
    // Require at least one non-modifier key
    if (["Alt", "Control", "Shift", "Meta"].includes(e.key)) return;

    const combo = comboFromEvent(e);
    shortcuts[action] = combo;
    chrome.storage.local.set({ shortcuts });
    btn.classList.remove("listening");
    renderShortcuts();
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("click", onClickOutside, true);
  }

  function onClickOutside(e) {
    if (e.target !== btn) {
      btn.classList.remove("listening");
      renderShortcuts();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("click", onClickOutside, true);
    }
  }

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", onClickOutside, true);
}

document.querySelectorAll(".shortcut-bind-btn").forEach(btn => {
  btn.addEventListener("click", () => startListening(btn, btn.dataset.action));
});

function renderSettings() {
  document.getElementById("fallback-check").checked = fallback;
  renderShortcuts();
}

document.getElementById("fallback-check").addEventListener("change", (e) => {
  fallback = e.target.checked;
  save();
});

// ─── Init ─────────────────────────────────────────────────────────────────────
document.getElementById("page-version").textContent =
  "v" + chrome.runtime.getManifest().version;

async function init() {
  // Migrate old key
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
    fallback:      true,
    shortcuts:     DEFAULT_SHORTCUTS
  });

  if (stored.profiles.length === 0) {
    stored.profiles = [{ id: "default", name: "Profile 1", voice: "", rate: 1.0, volume: 1.0 }];
    stored.activeId = "default";
  }

  // Migrate: rename auto-generated "Default" profile to "Profile 1"
  const defP = stored.profiles.find(p => p.id === "default" && p.name === "Default");
  if (defP) defP.name = "Profile 1";

  profiles      = stored.profiles;
  activeId      = stored.activeId || profiles[0].id;
  favorites     = stored.favorites;
  deletedVoices = stored.deletedVoices;
  favsOnly      = stored.favsOnly;
  fallback      = stored.fallback;
  shortcuts     = stored.shortcuts;

  document.getElementById("favs-only-check").checked = favsOnly;
  updateFavsCount();

  await checkServerStatus();

  renderProfiles();

  // Pre-populate create form's voice select now that we have server status
  if (serverOnline) {
    await fetchVoices();
    populateVoiceSelect(document.getElementById("cp-voice"), "");
  }
}

init();
