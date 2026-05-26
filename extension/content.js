// ─── Local TTS Reader — Content Script ───────────────────────────────────────
// Injected into every webpage. Listens for the user's configured key combos
// and tells the background to read/stop or pause/resume.

const DEFAULT_SHORTCUTS = { read: "Alt+Shift+R", pause: "Alt+Shift+D" };
let activeShortcuts = { ...DEFAULT_SHORTCUTS };

function comboFromEvent(e) {
  const parts = [];
  if (e.altKey)   parts.push("Alt");
  if (e.ctrlKey)  parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey)  parts.push("Meta");
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (!["Alt", "Control", "Shift", "Meta"].includes(e.key)) parts.push(key);
  return parts.join("+");
}

// Load saved shortcuts from storage, then attach listener
chrome.storage.local.get({ shortcuts: DEFAULT_SHORTCUTS }, ({ shortcuts }) => {
  activeShortcuts = shortcuts;
});

// Re-read shortcuts whenever user changes them in Settings (page stays open)
chrome.storage.onChanged.addListener((changes) => {
  if (changes.shortcuts) {
    activeShortcuts = changes.shortcuts.newValue;
  }
});

document.addEventListener("keydown", (e) => {
  const combo = comboFromEvent(e);
  if (combo === activeShortcuts.read) {
    e.preventDefault();
    // Read the selection right here — content scripts have full page access,
    // so we never need scripting/executeScript in the background.
    const text = window.getSelection()?.toString().trim() || "";
    chrome.runtime.sendMessage({ type: "keyboard-read", text });
  } else if (combo === activeShortcuts.pause) {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "keyboard-pause" });
  }
});
