// ─── Constants ────────────────────────────────────────────────────────────────
const PIPER_BASE_URL = "http://127.0.0.1:5050";
const MAX_PROFILES   = 10;
const MAX_FAVORITES  = 5;

// ─── State ────────────────────────────────────────────────────────────────────
let profiles      = [];
let activeId      = "";
let favorites     = [];
let deletedVoices = [];
let favsOnly      = false;
let fallback      = true;
let allVoices     = [];    // filenames fetched from server
let serverOnline  = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(v) { return parseFloat(v).toFixed(1); }

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

function activeProfile() {
  return profiles.find(p => p.id === activeId) || profiles[0] || null;
}

// ─── Persist ──────────────────────────────────────────────────────────────────
function save() {
  chrome.storage.local.set({ profiles, activeId, favorites, deletedVoices, favsOnly, fallback });
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
    const res = await fetch(`${PIPER_BASE_URL}/voices`);
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const { voices } = await res.json();
    allVoices = voices || [];
    renderVoices();
    // Also refresh voice selects in any open profile edit forms
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

    const fileEl = document.createElement("span");
    fileEl.className = "voice-card-file";
    fileEl.textContent = v;

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

// ─── Voices — Favorite Toggle ─────────────────────────────────────────────────
function toggleFavorite(filename) {
  if (favorites.includes(filename)) {
    favorites = favorites.filter(f => f !== filename);
  } else {
    if (favorites.length >= MAX_FAVORITES) {
      alert(`You can have at most ${MAX_FAVORITES} favorite voices. Remove one first.`);
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
  if (!confirm(`Delete "${formatVoiceName(filename)}"?\nThis removes the voice file from disk and cannot be undone.`)) return;

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

  const nameEl = document.createElement("span");
  nameEl.className = "profile-card-name";
  nameEl.textContent = profile.name;
  if (isActive) {
    const badge = document.createElement("span");
    badge.className = "active-badge";
    badge.textContent = "Active";
    nameEl.appendChild(badge);
  }

  const meta = document.createElement("span");
  meta.className = "profile-card-meta";
  const voiceLabel = formatVoiceName(profile.voice);
  meta.textContent = `${voiceLabel}  ·  ${fmt(profile.rate)}×  ·  vol ${fmt(profile.volume)}`;

  const btns = document.createElement("div");
  btns.className = "profile-card-btns";

  if (!isActive) {
    const activateBtn = document.createElement("button");
    activateBtn.className = "btn btn-ghost btn-sm";
    activateBtn.textContent = "Set Active";
    activateBtn.addEventListener("click", () => {
      activeId = profile.id;
      save();
      renderProfiles();
    });
    btns.appendChild(activateBtn);
  }

  const editBtn = document.createElement("button");
  editBtn.className = "btn btn-ghost btn-sm";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => toggleEditForm(profile.id, card));

  const delBtn = document.createElement("button");
  delBtn.className = "btn btn-danger btn-sm";
  delBtn.textContent = "Delete";
  delBtn.disabled = profiles.length <= 1;
  delBtn.title = profiles.length <= 1 ? "Can't delete the only profile" : "";
  delBtn.addEventListener("click", () => deleteProfile(profile.id));

  btns.appendChild(editBtn);
  btns.appendChild(delBtn);

  header.appendChild(nameEl);
  header.appendChild(meta);
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

function deleteProfile(profileId) {
  if (profiles.length <= 1) { alert("Can't delete the only profile."); return; }
  const p = profiles.find(x => x.id === profileId);
  if (!p) return;
  if (!confirm(`Delete profile "${p.name}"?`)) return;
  profiles = profiles.filter(x => x.id !== profileId);
  if (activeId === profileId) activeId = profiles[0].id;
  save();
  renderProfiles();
}

// ─── Profiles — Create form ───────────────────────────────────────────────────
document.getElementById("new-profile-btn").addEventListener("click", () => {
  if (profiles.length >= MAX_PROFILES) {
    alert(`Maximum ${MAX_PROFILES} profiles reached. Delete one to create a new one.`);
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
  const name = document.getElementById("cp-name").value.trim();
  if (!name) { document.getElementById("cp-name").focus(); return; }

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
function renderSettings() {
  document.getElementById("fallback-check").checked = fallback;
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
    fallback:      true
  });

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

  document.getElementById("favs-only-check").checked = favsOnly;

  await checkServerStatus();

  renderProfiles();

  // Pre-populate create form's voice select now that we have server status
  if (serverOnline) {
    await fetchVoices();
    populateVoiceSelect(document.getElementById("cp-voice"), "");
  }
}

init();
