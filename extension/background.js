// ─── Constants ────────────────────────────────────────────────────────────────
const PIPER_BASE_URL = "http://127.0.0.1:5050";
const PIPER_URL      = `${PIPER_BASE_URL}/tts`;
const OFFSCREEN_URL  = "offscreen.html";

// ─── Context Menu Builder ─────────────────────────────────────────────────────
// Rebuilds context menus from stored profiles. Called on install and whenever
// profiles change.
async function rebuildMenus() {
  await chrome.contextMenus.removeAll();

  const { profiles = [], activeId = "" } =
    await chrome.storage.local.get(["profiles", "activeId"]);

  // Main read item — uses the active profile
  chrome.contextMenus.create({
    id:       "read-selection",
    title:    "Read selected text",
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
    contexts: ["all"]
  });
}

chrome.runtime.onInstalled.addListener(() => rebuildMenus());

// Rebuild whenever profiles or activeId change (popup saved new data)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.profiles || changes.activeId) rebuildMenus();
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
  chrome.tts.stop();
  chrome.tts.speak(text, {
    rate:   settings.rate   ?? 1.0,
    pitch:  1.0,
    volume: Math.min(1, settings.volume ?? 1.0), // browser TTS capped at 1
    enqueue: false,
    onEvent: (e) => { if (e.type === "error") console.error("tts error:", e.errorMessage); }
  });
}

// ─── Piper Health Check ───────────────────────────────────────────────────────
async function checkPiperOnline() {
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res   = await fetch(`${PIPER_BASE_URL}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (_) {
    return false;
  }
}

// ─── Piper TTS ───────────────────────────────────────────────────────────────
async function speakWithPiper(text, settings) {
  const online = await checkPiperOnline();
  if (!online) throw new Error("Piper server is offline");

  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});
  chrome.runtime.sendMessage({
    type:    "speak-text",
    text,
    piperUrl: PIPER_URL,
    rate:    settings.rate   ?? 1.0,
    volume:  settings.volume ?? 1.0,
    voice:   settings.voice  || ""
  }).catch((err) => console.error("speak-text delivery failed:", err));
}

// ─── Stop All ────────────────────────────────────────────────────────────────
async function stopAll() {
  chrome.tts.stop();
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (existing.length > 0) chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});
  } catch (_) {}
}

// ─── Speak with profile settings (Piper → browser fallback) ──────────────────
async function speakText(text, settings) {
  try {
    await speakWithPiper(text, settings);
  } catch (err) {
    console.error("Piper failed:", err.message);
    const { fallback = true } = await chrome.storage.local.get("fallback");
    if (fallback) {
      console.log("Falling back to browser TTS");
      speakWithBrowser(text, settings);
    }
  }
}

// ─── Context Menu Click Handler ───────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "stop-reading") { await stopAll(); return; }

  const text = info.selectionText?.trim();
  if (!text) return;

  let { profiles = [], activeId = "" } =
    await chrome.storage.local.get(["profiles", "activeId"]);

  // If a specific profile was chosen from the submenu, switch to it
  if (info.menuItemId.startsWith("profile-")) {
    activeId = info.menuItemId.replace("profile-", "");
    await chrome.storage.local.set({ activeId });
    rebuildMenus();
  }

  const profile = profiles.find(p => p.id === activeId) || profiles[0];
  if (!profile) return;

  await speakText(text, profile);
});

// ─── Messages from Popup ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "stop-all") {
    stopAll().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "test-voice") {
    const { text, settings } = message;
    speakWithPiper(text, settings)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});
