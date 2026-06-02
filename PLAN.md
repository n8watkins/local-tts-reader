# Piper TTS — v1.0 Implementation Plan

This document is a complete, self-contained plan for a fresh Claude context.
Start by reading all files listed under "Key files" before touching anything.

---

## Project overview

Chrome MV3 extension + local Node.js server that reads selected text aloud
using Piper TTS (fully offline). Dark Catppuccin Mocha theme throughout.

```
extension/
  manifest.json       v0.9.7 currently
  background.js       Service worker: context menus, routing, message handler
  offscreen.js        Hidden page: fetches WAV from Piper, plays via Web Audio
  popup.html/.js/.css Toolbar popup: profile switcher, sliders, test/stop
  options.html/.js/.css Full settings page (5 tabs: Profiles Voices Settings About Credits)
  icons/

local-piper-server/
  server.js           Express: POST /tts, GET /voices, DELETE /voices/:name,
                      POST /voices/open-folder, GET /health
  package.json
```

Storage schema (chrome.storage.local):
```js
{
  profiles:      [{ id, name, voice, rate, volume }],  // max 5
  activeId:      string,
  favorites:     string[],   // voice filenames, max 5
  deletedVoices: [{ filename, displayName, deletedAt }],
  favsOnly:      boolean,
  fallback:      boolean,    // browser TTS fallback when Piper offline
  shortcuts:     {           // NEW — custom key bindings
    read:  "Alt+Shift+R",   // read/stop toggle
    pause: "Alt+Shift+D"    // pause/resume toggle
  }
}
```

---

## Work items (implement in order)

---

### 1. Bug fix — Popup doesn't enforce MAX_PROFILES = 5

**File:** `extension/popup.js`

In `saveNewProfile()`, add a guard before pushing the new profile:

```js
function saveNewProfile() {
  const name = newProfileInput.value.trim();
  if (!name) { newProfileInput.focus(); return; }

  // ADD THIS:
  if (profiles.length >= 5) {
    newProfileForm.classList.add("hidden");
    newProfileInput.value = "";
    // Show a brief inline error instead of nothing
    showError("You're at the 5-profile limit. Delete one in Settings first.");
    return;
  }
  // ... rest unchanged
}
```

Also guard the `addProfileBtn` click handler — if already at 5, show error and
don't open the form at all:

```js
addProfileBtn.addEventListener("click", () => {
  if (profiles.length >= 5) {
    showError("You're at the 5-profile limit. Delete one in Settings first.");
    return;
  }
  newProfileForm.classList.remove("hidden");
  newProfileInput.focus();
});
```

---

### 2. Bug fix — Popup doesn't check for duplicate profile names

**File:** `extension/popup.js`

In `saveNewProfile()`, after the length check:

```js
if (profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) {
  newProfileInput.setCustomValidity("A profile with this name already exists.");
  newProfileInput.reportValidity();
  newProfileInput.setCustomValidity("");
  return;
}
```

---

### 3. Bug fix — "Read as…" context menu should READ, not just switch

**File:** `extension/background.js`

Currently when the user right-clicks → "Read as… → Profile X", the handler
only sets `activeId` and rebuilds menus — it never reads the selected text.

Fix: after switching, call `speakText` with the selected text:

```js
if (info.menuItemId.startsWith("profile-")) {
  activeId = info.menuItemId.replace("profile-", "");
  clearTimeout(_rebuildTimer);
  await chrome.storage.local.set({ activeId });
  await rebuildMenus();

  // CHANGE: also read the selected text with the newly chosen profile
  const selectedProfile = profiles.find(p => p.id === activeId);
  if (selectedProfile && text) {
    await speakText(text, selectedProfile);
  }
  return;
}
```

Note: `text` is already set at the top of the handler. Move the `const text =
info.selectionText?.trim()` line above the profile-switch block so it's
available there too.

---

### 4. Bug fix — Health check fires on every TTS request (latency)

**File:** `extension/background.js`

Cache the online result for 5 seconds so repeated reads don't pay the
round-trip cost each time:

```js
let _piperOnlineCache = { value: false, expiresAt: 0 };

async function checkPiperOnline() {
  if (Date.now() < _piperOnlineCache.expiresAt) return _piperOnlineCache.value;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res   = await fetch(`${PIPER_BASE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    _piperOnlineCache = { value: res.ok, expiresAt: Date.now() + 5000 };
    return res.ok;
  } catch (_) {
    _piperOnlineCache = { value: false, expiresAt: Date.now() + 2000 };
    return false;
  }
}

// Invalidate cache on stopAll so next read checks fresh
async function stopAll() {
  _piperOnlineCache.expiresAt = 0;
  // ... rest unchanged
}
```

---

### 5. Bug fix — Stale WAV files accumulate if server crashes

**File:** `local-piper-server/server.js`

At startup (just before `app.listen`), clean any leftover `.wav` files from
a previous crashed session:

```js
async function cleanOutputDir() {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const files = await fs.readdir(OUTPUT_DIR);
    await Promise.allSettled(
      files
        .filter(f => f.endsWith(".wav"))
        .map(f => fs.rm(path.join(OUTPUT_DIR, f), { force: true }))
    );
    if (files.length > 0) console.log(`[startup] Cleaned ${files.length} stale WAV file(s).`);
  } catch (_) {}
}

// Call before app.listen:
await cleanOutputDir();
app.listen(PORT, HOST, () => { ... });
```

Make the server entry point `async` or use a top-level async IIFE:
```js
(async () => {
  await cleanOutputDir();
  app.listen(PORT, HOST, () => { ... });
})();
```

---

### 6. Feature — Pause / Resume support in offscreen.js

**File:** `extension/offscreen.js`

Add `isPaused` state and two new message types. The queue loop naturally
suspends while `audio.pause()` is active (because `onended` never fires
while paused), so the fix is straightforward:

```js
let isPaused = false;  // ADD at top with other state vars
```

In the message handler, add:

```js
if (message.type === "pause-audio") {
  if (currentAudio && !currentAudio.paused) {
    currentAudio.pause();
    isPaused = true;
  }
  return;
}

if (message.type === "resume-audio") {
  if (currentAudio && currentAudio.paused && isPaused) {
    isPaused = false;
    currentAudio.play().catch(() => {});
  }
  return;
}
```

In `stopAll()` inside offscreen.js, also reset `isPaused`:
```js
function stopAll() {
  playbackQueue = [];
  isPlaying = false;
  isPaused = false;  // ADD
  stopCurrentAudio();
}
```

Also add a `playback-ended` notification so background can track state:
At the end of `playQueue`, after `if (playGeneration === generation) isPlaying = false;`:
```js
chrome.runtime.sendMessage({ type: "playback-ended" }).catch(() => {});
```

---

### 7. Feature — Now Playing indicator in popup

**File:** `extension/background.js`, `extension/popup.js`, `extension/popup.html`, `extension/popup.css`

**Background — track playing state:**

```js
let _isPlayingPiper = false;

// Set true when speakWithPiper is called:
async function speakWithPiper(text, settings) {
  // ... existing code ...
  _isPlayingPiper = true;
  chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});
  chrome.runtime.sendMessage({ type: "speak-text", ... }).catch(...);
}

// Set false in stopAll:
async function stopAll() {
  _piperOnlineCache.expiresAt = 0;
  _isPlayingPiper = false;
  _isPausedPiper = false;
  // ... existing code ...
}

// Also track pause state:
let _isPausedPiper = false;
```

Handle the `playback-ended` message from offscreen:
```js
if (message.type === "playback-ended") {
  _isPlayingPiper = false;
  _isPausedPiper = false;
  return;
}
```

Handle a `get-playback-state` query from popup:
```js
if (message.type === "get-playback-state") {
  sendResponse({ isPlaying: _isPlayingPiper, isPaused: _isPausedPiper });
  return; // synchronous
}
```

**Popup — visual indicator:**

Add a `playing-indicator` element to `popup.html` between the profile card and sliders:
```html
<div class="playing-bar hidden" id="playing-bar">
  <span class="playing-dot"></span>
  <span class="playing-label" id="playing-label">Playing</span>
</div>
```

In `popup.css`:
```css
.playing-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #1e3a2a;
  border: 1px solid #3a6a4a;
  border-radius: 8px;
  margin-top: -4px;
}
.playing-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #a6e3a1;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.35; }
}
.playing-label { font-size: 12px; color: #a6e3a1; font-weight: 600; }
```

In `popup.js`, poll state every second while popup is open:
```js
async function syncPlaybackState() {
  chrome.runtime.sendMessage({ type: "get-playback-state" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    const bar   = document.getElementById("playing-bar");
    const label = document.getElementById("playing-label");
    if (resp.isPlaying && !resp.isPaused) {
      bar.classList.remove("hidden");
      label.textContent = "Playing";
    } else if (resp.isPaused) {
      bar.classList.remove("hidden");
      label.textContent = "Paused";
    } else {
      bar.classList.add("hidden");
    }
  });
}
// Poll every second
setInterval(syncPlaybackState, 1000);
// Also call on init
syncPlaybackState();
```

---

### 8. Feature — Keyboard shortcuts (rebindable)

This is the biggest feature. It uses a **content script** (not `chrome.commands`)
so bindings are fully controllable from our Settings UI.

#### 8a. New file: `extension/content.js`

```js
// Injected into every page. Listens for the user's configured key combos
// and tells the background to read/stop or pause/resume.

const DEFAULT_SHORTCUTS = { read: "Alt+Shift+R", pause: "Alt+Shift+D" };

function comboFromEvent(e) {
  const parts = [];
  if (e.altKey)   parts.push("Alt");
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!["Alt","Control","Shift","Meta"].includes(e.key)) parts.push(key);
  return parts.join("+");
}

chrome.storage.local.get({ shortcuts: DEFAULT_SHORTCUTS }, ({ shortcuts }) => {
  document.addEventListener("keydown", (e) => {
    const combo = comboFromEvent(e);
    if (combo === shortcuts.read) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "keyboard-read" });
    } else if (combo === shortcuts.pause) {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "keyboard-pause" });
    }
  });
});

// Re-read shortcuts if user changes them while page is open
chrome.storage.onChanged.addListener((changes) => {
  if (changes.shortcuts) location.reload(); // simplest way to reload listeners
  // Alternative: update the shortcuts variable in-place without reload
});
```

#### 8b. `extension/manifest.json` additions

```json
"content_scripts": [
  {
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }
],
"permissions": [...existing..., "tabs"]
```

Note: `tabs` permission is needed to query the active tab's selected text
for the keyboard-read flow (see 8c).

#### 8c. `extension/background.js` — handle keyboard messages

```js
if (message.type === "keyboard-read") {
  // Toggle: if playing → stop; if not → read selected text from active tab
  if (_isPlayingPiper) {
    stopAll();
  } else {
    // Get selected text from the active tab via scripting API
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString().trim() || ""
    });
    const text = result?.result;
    if (!text) return;
    const { profiles = [], activeId = "" } = await chrome.storage.local.get(["profiles","activeId"]);
    const profile = profiles.find(p => p.id === activeId) || profiles[0];
    if (profile) await speakText(text, profile);
  }
  return;
}

if (message.type === "keyboard-pause") {
  if (_isPausedPiper) {
    // Resume
    _isPausedPiper = false;
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (existing.length > 0) chrome.runtime.sendMessage({ type: "resume-audio" }).catch(() => {});
  } else if (_isPlayingPiper) {
    // Pause
    _isPausedPiper = true;
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (existing.length > 0) chrome.runtime.sendMessage({ type: "pause-audio" }).catch(() => {});
  }
  return;
}
```

Also add `"scripting"` to `"permissions"` in manifest.json.

#### 8d. Settings tab — rebind UI

**`extension/options.html`** — inside `#tab-settings`, add a new group:

```html
<div class="settings-group">
  <h3 class="settings-group-title">Keyboard Shortcuts</h3>
  <p class="setting-desc" style="margin-bottom:14px">
    These shortcuts work on any webpage while the extension is active.
    They may conflict with shortcuts used by other extensions or websites —
    we can't guarantee they'll work everywhere.
  </p>

  <div class="shortcut-row">
    <span class="shortcut-label">Read / Stop</span>
    <button class="shortcut-bind-btn" id="bind-read" data-action="read">Alt+Shift+R</button>
  </div>
  <div class="shortcut-row">
    <span class="shortcut-label">Pause / Resume</span>
    <button class="shortcut-bind-btn" id="bind-pause" data-action="pause">Alt+Shift+D</button>
  </div>
</div>
```

**`extension/options.css`** — add:

```css
.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
}
.shortcut-row + .shortcut-row { border-top: 1px solid #313244; }

.shortcut-label {
  font-size: 13px;
  font-weight: 600;
  color: #cdd6f4;
}

.shortcut-bind-btn {
  font-family: "SF Mono", "Fira Code", Consolas, monospace;
  font-size: 12px;
  background: #313244;
  border: 1px solid #45475a;
  border-radius: 6px;
  color: #cba6f7;
  padding: 5px 12px;
  cursor: pointer;
  outline: none;
  min-width: 120px;
  text-align: center;
  transition: border-color 0.15s, background 0.15s;
}
.shortcut-bind-btn:hover { background: #45475a; }
.shortcut-bind-btn.listening {
  border-color: #f9e2af;
  color: #f9e2af;
  background: #3a2e1e;
  animation: blink-border 0.8s ease-in-out infinite;
}
@keyframes blink-border {
  0%, 100% { border-color: #f9e2af; }
  50%       { border-color: #6a5a30; }
}
```

**`extension/options.js`** — add shortcut management to the Settings section:

```js
const DEFAULT_SHORTCUTS = { read: "Alt+Shift+R", pause: "Alt+Shift+D" };
let shortcuts = { ...DEFAULT_SHORTCUTS };

function comboFromEvent(e) {
  const parts = [];
  if (e.altKey)   parts.push("Alt");
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!["Alt","Control","Shift","Meta"].includes(e.key)) parts.push(key);
  return parts.join("+");
}

function renderShortcuts() {
  document.getElementById("bind-read").textContent  = shortcuts.read  || "—";
  document.getElementById("bind-pause").textContent = shortcuts.pause || "—";
}

function startListening(btn, action) {
  btn.textContent = "Press keys…";
  btn.classList.add("listening");

  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    // Require at least one of Ctrl/Alt (Chrome extension constraint)
    if (!e.ctrlKey && !e.altKey) return;
    // Require at least one non-modifier key
    if (["Alt","Control","Shift","Meta"].includes(e.key)) return;

    shortcuts[action] = combo;
    chrome.storage.local.set({ shortcuts });
    renderShortcuts();
    btn.classList.remove("listening");
    document.removeEventListener("keydown", onKey, true);
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
```

Also load shortcuts in the `init()` function:
```js
const storedSC = await chrome.storage.local.get({ shortcuts: DEFAULT_SHORTCUTS });
shortcuts = storedSC.shortcuts;
renderShortcuts();
```

And call `renderShortcuts()` inside `renderSettings()`.

---

### 9. Feature — Voice quality badge on voice cards

**File:** `extension/options.js`

Add a helper to parse the quality tier from the filename:

```js
function qualityFromFilename(filename) {
  const base  = filename.replace(/\.onnx$/, "");
  const parts = base.split("-");
  const tier  = parts[parts.length - 1]?.toLowerCase();
  const map   = { "x_low": "x-low", "low": "low", "medium": "med", "high": "high" };
  return map[tier] || null;
}
```

In `renderVoices()`, after building the `nameEl`, add a quality badge:
```js
const quality = qualityFromFilename(v);
if (quality) {
  const badge = document.createElement("span");
  badge.className = `quality-badge quality-${quality.replace("-","_")}`;
  badge.textContent = quality;
  nameEl.appendChild(badge);
}
```

**`extension/options.css`**:
```css
.quality-badge {
  display: inline-block;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px 5px;
  border-radius: 4px;
  margin-left: 6px;
  vertical-align: middle;
}
.quality-x_low { background: #313244; color: #6c7086; }
.quality-low   { background: #2a2040; color: #cba6f7; }
.quality-med   { background: #1e3a2a; color: #a6e3a1; }
.quality-high  { background: #3a1e2e; color: #f38ba8; }
```

---

### 10. Misc fixes

**Server version consistency** (`local-piper-server/server.js`):
Read version from `package.json` instead of hardcoding it:
```js
const { version } = require("./package.json");
// In /health:
res.json({ status: "ok", version });
```

**Open-folder cross-platform** (`local-piper-server/server.js`):
```js
app.post("/voices/open-folder", (_req, res) => {
  const { platform } = process;
  const cmd = platform === "win32"  ? `explorer.exe "${VOICE_DIR}"` :
              platform === "darwin" ? `open "${VOICE_DIR}"` :
                                      `xdg-open "${VOICE_DIR}"`;
  exec(cmd, () => {});
  res.json({ ok: true });
});
```

---

## Version bump sequence

After all items above are done:
- Bump `manifest.json` to `"1.0.0"`
- Bump `local-piper-server/package.json` to `"1.0.0"`
- Update `server.js` health endpoint to reflect new version (handled by item 10)
- Update `README.md` to document keyboard shortcuts and the Settings rebind UI

---

## Files to read before starting

```
extension/manifest.json
extension/background.js
extension/offscreen.js
extension/popup.html
extension/popup.js
extension/popup.css
extension/options.html
extension/options.js
extension/options.css
local-piper-server/server.js
local-piper-server/package.json
```

The post-commit git hook auto-syncs to Windows on every commit:
`/mnt/c/Users/natha/Projects/Tools/local-tts-reader/`
Chrome loads the extension from the Windows path, so every commit is
immediately testable after clicking "Reload" on chrome://extensions.
