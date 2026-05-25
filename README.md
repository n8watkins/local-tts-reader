# Local TTS Reader

A Chrome extension that lets you highlight text on any webpage, right-click it, and have it read aloud — either using your browser's built-in voice or a fully local [Piper TTS](https://github.com/rhasspy/piper) model running on your machine.

No cloud APIs. No subscriptions. No data leaves your computer (in Piper mode).

---

## What's in this repo

```
local-tts-reader/
├── extension/              Chrome Manifest V3 extension
│   ├── manifest.json
│   ├── background.js       Service worker: context menu, routing
│   ├── offscreen.html      Offscreen document (required for audio in MV3)
│   ├── offscreen.js        Fetches Piper audio + plays it
│   ├── popup.html          Settings popup UI
│   ├── popup.js
│   ├── popup.css
│   └── icons/
│
└── local-piper-server/     Local Node.js TTS server
    ├── server.js           Express server, calls Piper, returns WAV
    ├── package.json
    ├── README.md           Detailed Piper setup instructions
    ├── piper/
    │   ├── piper.exe       ← you download this
    │   └── voices/
    │       ├── *.onnx      ← you download these
    │       └── *.onnx.json
    └── output/             Temp files (auto-cleaned)
```

---

## Quick Start

### Step 1 — Load the Chrome Extension

1. Open Chrome and go to: `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this project

The extension is now active. You'll see a 🔊 icon in your toolbar.

### Step 2 — Test browser-native TTS (no server needed)

1. Go to any webpage
2. Highlight some text
3. Right-click → **Read selected text**
4. Your browser reads it aloud

To stop: right-click anywhere → **Stop reading**

That's the MVP. It works immediately with no setup.

---

## Upgrading to Local Piper TTS

For a fully local, higher-quality voice, follow the [Piper server setup](local-piper-server/README.md).

**Short version:**

```bash
cd local-piper-server
npm install

# Then download piper.exe and a voice model (see README.md in that folder)

npm start
```

Once the server is running at `http://127.0.0.1:5050`:

1. Click the 🔊 extension icon in Chrome
2. Change **TTS Engine** to **Local Piper**
3. The popup will show **Online ✓** when the server is reachable
4. Highlight text → right-click → **Read selected text**

---

## Features

| Feature | Browser Mode | Piper Mode |
|---------|-------------|------------|
| No install needed | ✅ | ❌ needs server |
| Fully local | Depends on OS | ✅ always |
| Voice quality | OS default | ✅ Piper voices |
| Rate control | ✅ | ✅ |
| Pitch control | ✅ | ❌ N/A |
| Volume control | ✅ | ✅ |
| Long text chunking | ✅ | ✅ |
| Stop reading | ✅ | ✅ |
| Offline fallback | — | ✅ optional |

---

## How It Works

```
You highlight text
   ↓
Right-click → "Read selected text"
   ↓
background.js (service worker)
   ↓                     ↓
Browser mode          Piper mode
   ↓                     ↓
chrome.tts.speak()    → offscreen.js
                          ↓
                      POST /tts → local-piper-server/server.js
                          ↓
                      Piper.exe generates WAV
                          ↓
                      WAV returned → Audio() plays it
```

Chrome Manifest V3 service workers can't use the DOM or play audio, so Piper audio playback goes through an **offscreen document** — a hidden page that can use `new Audio()` normally.

---

## Popup Settings

Click the 🔊 icon to open the settings popup:

- **TTS Engine** — switch between Browser Voice and Local Piper
- **Rate** — playback speed (0.5× to 2.5×)
- **Pitch** — voice pitch, browser mode only (0.5× to 2.0×)
- **Volume** — output volume (0–100%)
- **Piper Server** — shows Online/Offline status
- **Fallback** — if Piper is offline, automatically use browser voice
- **Test Voice** — play a test phrase with current settings
- **Stop Reading** — stop any active playback

Settings are saved automatically via `chrome.storage.local`.

---

## Long Text

Long selections are automatically split into sentence chunks (~350 chars each) and played sequentially. This means:

- Playback starts quickly (first chunk)
- Remaining chunks are fetched and queued
- "Stop reading" cancels the entire queue

---

## Troubleshooting

**Right-click menu doesn't appear**  
→ Make sure the extension is loaded and enabled in `chrome://extensions`

**Browser voice sounds robotic**  
→ This is your OS's TTS engine. Try the Piper server for better quality.

**Piper status shows "Offline"**  
→ Run `npm start` inside `local-piper-server/`. The server must be running.

**No audio plays in Piper mode**  
→ Check the browser console (F12 → Console) for errors. Common issues: server not running, missing voice model, Piper not found.

**Audio is cut off**  
→ The text was split into chunks. If a chunk failed, playback moves to the next. Check the console for errors.

---

## Roadmap

- [x] Browser-native TTS MVP
- [x] Stop reading
- [x] Local Piper server integration
- [x] Offscreen document audio playback
- [x] Popup settings UI
- [x] Long-text chunking
- [x] Offline fallback to browser voice
- [ ] Voice selector (multiple Piper voices)
- [ ] Windows tray helper (auto-start server)
- [ ] Keyboard shortcut to trigger reading
- [ ] Reading progress indicator
- [ ] Pause/resume support

---

## Credits

- [Piper TTS](https://github.com/rhasspy/piper) — fast, local neural TTS
- [Piper voices on Hugging Face](https://huggingface.co/rhasspy/piper-voices)
- Chrome Extensions Manifest V3 Offscreen Documents API
