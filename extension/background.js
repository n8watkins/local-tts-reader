// ─── Constants ────────────────────────────────────────────────────────────────
const PIPER_URL = "http://127.0.0.1:5050/tts";
const OFFSCREEN_URL = "offscreen.html";

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
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });

  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play locally generated text-to-speech audio."
  });
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

// ─── TTS Provider: Local Piper ────────────────────────────────────────────────
async function speakWithPiper(text, settings) {
  await ensureOffscreenDocument();

  // First stop any current Piper audio
  chrome.runtime.sendMessage({ type: "stop-audio" }).catch(() => {});

  // Send text to offscreen to handle fetch + playback
  chrome.runtime.sendMessage({
    type: "speak-text",
    text,
    piperUrl: PIPER_URL,
    rate: settings.rate ?? 1.0,
    volume: settings.volume ?? 1.0
  }).catch((err) => {
    console.error("Failed to send message to offscreen:", err);
  });
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
