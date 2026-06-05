// ─── Constants ────────────────────────────────────────────────────────────────
// PIPER_BASE_URL and defaultProfile are shared with the React UI (src/shared.js)
// so the server URL and the seed profile can't drift between the two.
import { PIPER_BASE_URL, defaultProfile } from "./src/shared.js";

const PIPER_URL      = `${PIPER_BASE_URL}/tts`;
const OFFSCREEN_URL  = "offscreen.html";

async function getProfileState() {
  const state = await chrome.storage.local.get(["profiles", "activeId"]);
  const profiles = Array.isArray(state.profiles) ? state.profiles : [];
  let activeId = state.activeId || "";

  if (profiles.length === 0) {
    const profile = defaultProfile();
    await chrome.storage.local.set({ profiles: [profile], activeId: profile.id });
    return { profiles: [profile], activeId: profile.id };
  }

  if (!activeId || !profiles.some(p => p.id === activeId)) {
    activeId = profiles[0].id;
    await chrome.storage.local.set({ activeId });
  }

  return { profiles, activeId };
}

// ─── Context Menu Builder ─────────────────────────────────────────────────────
// Rebuilds context menus from stored profiles. Called on install and whenever
// profiles change.
async function rebuildMenus() {
  await chrome.contextMenus.removeAll();

  const { profiles, activeId } = await getProfileState();

  // Main read item — uses the active profile
  chrome.contextMenus.create({
    id:       "read-selection",
    title:    "Read selected text aloud",
    contexts: ["selection"]
  });

  // Per-profile submenu (only shown when there's more than one profile)
  if (profiles.length > 1) {
    chrome.contextMenus.create({
      id:       "read-as",
      title:    "Read as…",
      contexts: ["selection"]
    });
    for (const p of profiles) {
      chrome.contextMenus.create({
        id:       `profile-${p.id}`,
        parentId: "read-as",
        title:    p.name + (p.id === activeId ? " ✓" : ""),
        contexts: ["selection"]
      });
    }
  }

  chrome.contextMenus.create({
    id:       "stop-reading",
    title:    "Stop reading",
    contexts: ["all"],
    visible:  _isPlayingPiper
  });
}

async function setStopMenuVisible(visible) {
  try {
    await chrome.contextMenus.update("stop-reading", { visible });
  } catch (err) {
    // The menu may not exist yet immediately after install or service worker startup.
    if (!err.message?.includes("Cannot find menu item")) {
      console.error("[TTS] setStopMenuVisible failed:", err);
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // Migrate old fallbackToBrowser storage key to fallback (one-time, on install/update)
  const data = await chrome.storage.local.get(["fallback", "fallbackToBrowser"]);
  if (data.fallbackToBrowser !== undefined && data.fallback === undefined) {
    await chrome.storage.local.set({ fallback: data.fallbackToBrowser });
    await chrome.storage.local.remove("fallbackToBrowser");
  }
  await rebuildMenus();
});

// Rebuild whenever profiles or activeId change (popup saved new data).
// Debounced to prevent concurrent rebuilds when both keys change in one save.
let _rebuildTimer = null;
chrome.storage.onChanged.addListener((changes) => {
  if (changes.profiles || changes.activeId) {
    clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(
      () => rebuildMenus().catch(err => console.error("[TTS] rebuildMenus failed:", err)),
      50
    );
  }
});

// ─── Offscreen Document ───────────────────────────────────────────────────────
async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url:           OFFSCREEN_URL,
      reasons:       ["AUDIO_PLAYBACK"],
      justification: "Play locally generated text-to-speech audio."
    });
  } catch (err) {
    if (!err.message?.includes("Only a single offscreen document")) throw err;
  }
}

// ─── Browser TTS ─────────────────────────────────────────────────────────────
function speakWithBrowser(text, settings) {
  const effectiveSettings = settings || {};
  const generation = ++_browserSpeakGeneration;
  _activePiperRequest = null;
  chrome.tts.stop();
  _isPlayingPiper = true;   // reuse the playing flag so popup + keyboard toggle work
  _isPausedPiper  = false;
  _playbackEngine = "browser";
  _currentVolume  = Math.min(1, effectiveSettings.volume ?? 1.0); // browser TTS capped at 1
  _currentRate    = effectiveSettings.rate ?? 1.0;
  _playbackProgress = {
    active: true,
    engine: "browser",
    current: 0,
    total: 0,
    percent: null,
    label: "Browser voice"
  };
  setStopMenuVisible(true);
  notifyPlaybackState();
  chrome.tts.speak(text, {
    rate:   effectiveSettings.rate   ?? 1.0,
    pitch:  1.0,
    volume: _currentVolume,
    enqueue: false,
    onEvent: (e) => {
      if (generation !== _browserSpeakGeneration || _playbackEngine !== "browser") return;
      if (e.type === "end" || e.type === "interrupted" || e.type === "cancelled") {
        _isPlayingPiper = false;
        _isPausedPiper  = false;
        _playbackEngine = null;
        resetProgress();
        setStopMenuVisible(false);
        notifyPlaybackState();
      }
      if (e.type === "error") {
        console.error("tts error:", e.errorMessage);
        _isPlayingPiper = false;
        _isPausedPiper  = false;
        _playbackEngine = null;
        resetProgress();
        setStopMenuVisible(false);
        notifyPlaybackState();
      }
    }
  });
}

// ─── Piper Health Check (5-second cache) ─────────────────────────────────────
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

// ─── Playback State ───────────────────────────────────────────────────────────
let _isPlayingPiper    = false;
let _isPausedPiper     = false;
let _playbackEngine    = null; // "piper" or "browser"
let _playingSourceTabId = null; // tab that triggered the current playback
let _currentVolume     = 1.0;  // cached from active profile; sent to content script overlay
let _currentRate       = 1.0;  // cached from active profile; sent to content script overlay
let _playbackProgress  = { active: false, engine: null, current: 0, total: 0, percent: null, label: "" };
let _activePiperRequest = null;
let _browserSpeakGeneration = 0;

function resetProgress() {
  _playbackProgress = { active: false, engine: null, current: 0, total: 0, percent: null, label: "" };
}

function playbackStateForTab(tabId) {
  return {
    isPlaying: _isPlayingPiper,
    isPaused:  _isPausedPiper,
    volume:    _currentVolume,
    rate:      _currentRate,
    engine:    _playbackEngine,
    progress:  _playbackProgress
  };
}

function sendPlaybackStateToTab(tabId) {
  chrome.tabs.sendMessage(tabId, {
    type: "playback-state",
    state: playbackStateForTab(tabId)
  }).catch(() => {});
}

function notifyPlaybackState(tabId = null) {
  if (tabId != null) {
    sendPlaybackStateToTab(tabId);
    return;
  }

  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError) return;
    for (const tab of tabs) {
      if (tab.id != null) sendPlaybackStateToTab(tab.id);
    }
  });
}

// ─── Piper TTS ───────────────────────────────────────────────────────────────
async function speakWithPiper(text, settings) {
  const online = await checkPiperOnline();
  if (!online) throw new Error("Piper server is offline");

  _browserSpeakGeneration++;
  chrome.tts.stop();
  _activePiperRequest = { text, settings: { ...settings } };
  _isPlayingPiper = true;
  _isPausedPiper  = false;
  _playbackEngine = "piper";
  _currentVolume  = settings.volume ?? 1.0;
  _currentRate    = settings.rate ?? 1.0;
  _playbackProgress = {
    active: true,
    engine: "piper",
    current: 0,
    total: 0,
    percent: 0,
    label: "Starting"
  };
  setStopMenuVisible(true);
  notifyPlaybackState();
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    // Unexpected offscreen creation error — reset flag so the popup/shortcut
    // don't get stuck in "Playing" state forever.
    _isPlayingPiper = false;
    _playbackEngine = null;
    _activePiperRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();
    throw err;
  }
  chrome.runtime.sendMessage({
    type:    "speak-text",
    text,
    piperUrl: PIPER_URL,
    rate:    settings.rate   ?? 1.0,
    volume:  settings.volume ?? 1.0,
    voice:   settings.voice  || ""
  }).catch((err) => {
    console.error("speak-text delivery failed:", err);
    _isPlayingPiper = false; // delivery failed — no playback-ended will ever arrive
    _playbackEngine = null;
    _activePiperRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();
  });
}

// ─── Stop All ────────────────────────────────────────────────────────────────
async function stopAll() {
  _isPlayingPiper    = false;
  _isPausedPiper     = false;
  _playbackEngine    = null;
  _playingSourceTabId = null;
  _activePiperRequest = null;
  _browserSpeakGeneration++;
  resetProgress();
  _piperOnlineCache.expiresAt = 0; // invalidate cache so next read checks fresh
  await setStopMenuVisible(false);
  notifyPlaybackState();
  chrome.tts.stop();
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (existing.length > 0) chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});
  } catch (_) {}
}

// ─── Speak with profile settings (Piper voice or Chrome default) ──────────────
async function speakText(text, settings) {
  const effectiveSettings = settings || {};
  if (!effectiveSettings.voice) {
    speakWithBrowser(text, effectiveSettings);
    return;
  }

  try {
    await speakWithPiper(text, effectiveSettings);
  } catch (err) {
    console.error("Piper failed:", err.message);
    const { fallback = true } = await chrome.storage.local.get("fallback");
    if (fallback) {
      console.log("Falling back to browser TTS");
      speakWithBrowser(text, effectiveSettings);
    }
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getTabSelection(tab) {
  if (!tab?.id) return "";
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "get-selection" });
    return response?.text?.trim() || "";
  } catch (_) {
    return "";
  }
}

function showTabHint(tab, message) {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "show-hint", message }).catch(() => {});
}

async function readSelectionFromActiveTab() {
  if (_isPlayingPiper) {
    await stopAll();
    return;
  }

  const tab = await getActiveTab();
  const text = await getTabSelection(tab);
  if (!text) {
    showTabHint(tab, "Select text first");
    return;
  }

  const { profiles, activeId } = await getProfileState();
  const profile = profiles.find(p => p.id === activeId) || profiles[0];
  if (!profile) return;

  _playingSourceTabId = tab.id;
  await speakText(text, profile);
}

async function togglePauseResume() {
  if (_isPausedPiper) {
    _isPausedPiper = false;
    if (_playbackEngine === "browser") {
      chrome.tts.resume();
    } else {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      }).catch(() => []);
      if (existing.length > 0) chrome.runtime.sendMessage({ type: "resume-audio" }).catch(() => {});
    }
  } else if (_isPlayingPiper) {
    _isPausedPiper = true;
    if (_playbackEngine === "browser") {
      chrome.tts.pause();
    } else {
      const existing = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
      }).catch(() => []);
      if (existing.length > 0) chrome.runtime.sendMessage({ type: "pause-audio" }).catch(() => {});
    }
  }
  notifyPlaybackState();
}

// ─── Context Menu Click Handler ───────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "stop-reading") { await stopAll(); return; }

  const text = info.selectionText?.trim();
  if (!text) return;

  let { profiles, activeId } = await getProfileState();

  // If a specific profile was chosen from the submenu, switch to it and read
  // with the newly selected profile.
  if (info.menuItemId.startsWith("profile-")) {
    activeId = info.menuItemId.replace("profile-", "");
    // Cancel any pending debounced rebuild before our own await so the
    // storage.onChanged listener (which fires when we set activeId below)
    // doesn't schedule a second rebuild that races with the one we're about to do.
    clearTimeout(_rebuildTimer);
    await chrome.storage.local.set({ activeId });
    await rebuildMenus();
    // Also read the selected text with the newly chosen profile
    const selectedProfile = profiles.find(p => p.id === activeId);
    _playingSourceTabId = tab?.id ?? null;
    if (selectedProfile && text) await speakText(text, selectedProfile);
    return;
  }

  const profile = profiles.find(p => p.id === activeId) || profiles[0];
  if (!profile) return;

  _playingSourceTabId = tab?.id ?? null;
  await speakText(text, profile);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "read-selection") {
    readSelectionFromActiveTab().catch(err => console.error("[command:read-selection]", err));
    return;
  }
  if (command === "pause-resume") {
    togglePauseResume().catch(err => console.error("[command:pause-resume]", err));
  }
});

// ─── Messages from Popup / Content Script / Offscreen ────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content script tab is navigating/closing — stop if it was the source tab
  if (message.type === "tab-unloading") {
    if (_playingSourceTabId !== null && sender.tab?.id === _playingSourceTabId) {
      stopAll();
    }
    return;
  }
  // stop-all: fire-and-forget — respond immediately so the popup can close
  // without leaving an open message channel that Chrome will kill mid-flight.
  if (message.type === "stop-all") {
    stopAll();
    sendResponse({ ok: true });
    return; // synchronous — no return true, no dangling channel
  }

  // Offscreen notifies us when queue finishes naturally
  if (message.type === "playback-ended") {
    _isPlayingPiper = false;
    _isPausedPiper  = false;
    _playbackEngine = null;
    _playingSourceTabId = null;
    _activePiperRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();
    return;
  }

  if (message.type === "playback-error") {
    const request = _activePiperRequest;
    _isPlayingPiper = false;
    _isPausedPiper  = false;
    _playbackEngine = null;
    _playingSourceTabId = null;
    _activePiperRequest = null;
    resetProgress();
    setStopMenuVisible(false);
    notifyPlaybackState();

    (async () => {
      const { fallback = true } = await chrome.storage.local.get("fallback");
      if (fallback && request?.text) {
        console.warn("Piper playback failed; falling back to browser TTS:", message.error);
        speakWithBrowser(request.text, request.settings || {});
      } else {
        console.error("Piper playback failed:", message.error);
      }
    })().catch(err => console.error("[playback-error]", err));
    return;
  }

  if (message.type === "playback-progress") {
    const current = Math.max(0, Number(message.current) || 0);
    const total = Math.max(0, Number(message.total) || 0);
    _playbackProgress = {
      active: true,
      engine: message.engine || _playbackEngine || "piper",
      current,
      total,
      percent: typeof message.percent === "number" ? Math.max(0, Math.min(1, message.percent)) : null,
      label: message.label || (total > 0 ? `${current}/${total}` : "")
    };
    notifyPlaybackState();
    return;
  }

  // Content scripts use this once on startup; playback changes are pushed to
  // every tab so the overlay follows the user across normal webpages.
  if (message.type === "get-playback-state") {
    sendResponse(playbackStateForTab(sender.tab?.id));
    return; // synchronous
  }

  if (message.type === "test-voice") {
    const { text, settings = {} } = message;
    if (!settings.voice) {
      speakWithBrowser(text, settings);
      sendResponse({ ok: true });
      return;
    }

    // Use speakWithPiper directly so errors can surface to the popup.
    // Apply the browser-TTS fallback manually here so the popup still gets
    // a meaningful { ok: false } when both Piper and fallback are unavailable.
    speakWithPiper(text, settings)
      .then(() => {
        if (chrome.runtime.lastError) return; // channel already closed — swallow
        sendResponse({ ok: true });
      })
      .catch(async (piperErr) => {
        if (chrome.runtime.lastError) return;
        const { fallback = true } = await chrome.storage.local.get("fallback");
        if (fallback) {
          speakWithBrowser(text, settings);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: piperErr.message });
        }
      });
    return true;
  }

  // Keyboard shortcut: Alt+Shift+R — always START reading with selected text.
  // Stop is handled in the content script (sends stop-all when _localPlaying is true).
  // This avoids the wrong-tab problem where Tab B's poll saw Tab A as "playing"
  // and keyboard-read would stop instead of start.
  if (message.type === "keyboard-read") {
    const text = message.text || "";
    if (!text) return;
    _playingSourceTabId = sender.tab?.id ?? null;
    (async () => {
      const { profiles, activeId } = await getProfileState();
      const profile = profiles.find(p => p.id === activeId) || profiles[0];
      if (profile) await speakText(text, profile);
    })().catch(err => console.error("[keyboard-read]", err));
    return;
  }

  // Overlay rocker: change the CURRENT playback's volume/speed only. These are
  // deliberately NOT written back to the active profile — the profile keeps its
  // saved presets; this just nudges what's playing right now.
  if (message.type === "set-live-volume" || message.type === "set-live-rate") {
    const isVolume = message.type === "set-live-volume";
    const value = isVolume
      ? Math.max(0, Math.min(2.0, message.volume ?? 1.0))
      : Math.max(0.5, Math.min(2.5, message.rate ?? 1.0));

    if (isVolume) _currentVolume = value; else _currentRate = value;

    // Forward to the offscreen Piper player for real-time adjustment. (The
    // browser-TTS engine can't change mid-utterance, so the overlay disables
    // the rocker in that case and won't send these.)
    (async () => {
      try {
        const existing = await chrome.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT"],
          documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
        }).catch(() => []);
        if (existing.length > 0) {
          chrome.runtime.sendMessage(
            isVolume ? { type: "set-volume", volume: value } : { type: "set-rate", rate: value }
          ).catch(() => {});
        }
      } catch (_) {}
    })();

    sendResponse({ ok: true, value });
    return true; // async response
  }

  // Keyboard shortcut: Alt+Shift+D — pause/resume toggle
  if (message.type === "keyboard-pause") {
    togglePauseResume().catch(err => console.error("[keyboard-pause]", err));
    return;
  }
});
