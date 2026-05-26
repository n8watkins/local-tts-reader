// ─── Constants ────────────────────────────────────────────────────────────────
const PIPER_BASE_URL = "http://127.0.0.1:5050";
const PIPER_URL      = `${PIPER_BASE_URL}/tts`;
const OFFSCREEN_URL  = "offscreen.html";

// ─── Context Menu Setup ───────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "read-selection",
    title: "Read selected text",
    contexts: ["selection"]
  });

  chrome.contextMenus.create({
    id: "stop-reading",
    title: "Stop reading",
    contexts: ["all"]
  });
});

// ─── Offscreen Document Helpers ───────────────────────────────────────────────
// W3 fix: always try to create rather than checking getContexts first.
// Chrome can close an idle offscreen document while getContexts() still returns
// a stale reference to it — sending a message to that stale document produces
// "message channel closed" errors. Attempting createDocument unconditionally and
// swallowing the "Only a single offscreen document" error (which means it is
// genuinely already alive) guarantees we always end up with a live document.
async function ensureOffscreenDocument() {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play locally generated text-to-speech audio."
    });
  } catch (err) {
    // "Only a single offscreen document may be created" → already alive, fine.
    if (!err.message?.includes("Only a single offscreen document")) {
      throw err;
    }
  }
}

// ─── TTS Provider: Browser Native ─────────────────────────────────────────────
async function speakWithBrowser(text, settings) {
  chrome.tts.stop();

  chrome.tts.speak(text, {
    rate: settings.rate ?? 1.0,
    pitch: settings.pitch ?? 1.0,
    volume: settings.volume ?? 1.0,
    enqueue: false,
    onEvent: (event) => {
      if (event.type === "error") {
        console.error("chrome.tts error:", event.errorMessage);
      }
    }
  });
}

// ─── Piper Health Check ───────────────────────────────────────────────────────
// Used by speakWithPiper to confirm the server is reachable before attempting
// playback. A fast 2.5 s timeout avoids blocking the caller for too long.
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

// ─── TTS Provider: Local Piper ────────────────────────────────────────────────
// Architectural fix for "message channel closed" errors:
//
// Previous design held a long-lived chrome.runtime message channel open from
// background.js → offscreen.js until the offscreen document responded after its
// first audio chunk. Chrome can recycle the offscreen document while that channel
// is waiting, killing it and producing the "message channel closed" error.
//
// New design:
//   1. Do a fast /health pre-flight check here in background.js.
//      If offline → throw immediately so the caller can fall back to browser TTS.
//   2. Ensure the offscreen document is alive.
//   3. Fire-and-forget the speak-text message — offscreen plays independently.
//      No long-lived channel, nothing to kill.
async function speakWithPiper(text, settings) {
  const online = await checkPiperOnline();
  if (!online) throw new Error("Piper server is offline");

  await ensureOffscreenDocument();

  // Stop any current playback, then kick off the new one.
  chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});
  chrome.runtime.sendMessage({
    type: "speak-text",
    text,
    piperUrl: PIPER_URL,
    rate:   settings.rate   ?? 1.0,
    volume: settings.volume ?? 1.0
  }).catch((err) => {
    console.error("speak-text delivery failed:", err);
  });
  // No await — offscreen handles playback independently.
}

// ─── Stop All Playback ────────────────────────────────────────────────────────
async function stopAll() {
  // Stop browser TTS
  chrome.tts.stop();

  // Stop Piper audio (if offscreen exists)
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });

    if (existing.length > 0) {
      chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});
    }
  } catch (_) {}
}

// ─── Context Menu Click Handler ───────────────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === "stop-reading") {
    await stopAll();
    return;
  }

  if (info.menuItemId !== "read-selection") return;

  const text = info.selectionText?.trim();
  if (!text) return;

  // Load settings
  const settings = await chrome.storage.local.get({
    engine: "browser",
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    fallbackToBrowser: true
  });

  if (settings.engine === "piper") {
    try {
      await speakWithPiper(text, settings);
    } catch (err) {
      console.error("Piper TTS failed:", err);
      if (settings.fallbackToBrowser) {
        console.log("Falling back to browser TTS");
        await speakWithBrowser(text, settings);
      }
    }
  } else {
    await speakWithBrowser(text, settings);
  }
});

// ─── Messages from Popup ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "stop-all") {
    stopAll().then(() => sendResponse({ ok: true }));
    return true; // async response
  }

  if (message.type === "test-voice") {
    const { engine, text, settings } = message;

    if (engine === "piper") {
      // speakWithPiper throws immediately if Piper is offline (health check),
      // giving accurate test feedback without a long-lived message channel.
      speakWithPiper(text, settings)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    } else {
      speakWithBrowser(text, settings)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    }

    return true;
  }
});
