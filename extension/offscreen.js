// Offscreen document: handles Piper TTS fetching and audio playback.
// This runs in a real DOM context, unlike the service worker.

let currentAudio = null;
let currentBlobUrl = null;
let playbackQueue = [];
let isPlaying = false;

// ─── Chunk Splitter ───────────────────────────────────────────────────────────
function splitIntoChunks(text, maxLength = 350) {
  // Split by sentence-ending punctuation
  const sentences = text.match(/[^.!?]+[.!?]+|\S+$/g) || [text];

  const chunks = [];
  let current = "";

  for (const sentence of sentences) {
    const candidate = current ? current + " " + sentence : sentence;
    if (candidate.length > maxLength) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current = candidate;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}

// ─── Fetch Audio from Piper ───────────────────────────────────────────────────
async function fetchPiperAudio(text, piperUrl) {
  const response = await fetch(piperUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  if (!response.ok) {
    let details = "";
    try {
      const body = await response.json();
      details = body.error || "";
    } catch (_) {}
    throw new Error(`Piper server error ${response.status}${details ? ": " + details : ""}`);
  }

  return response.blob();
}

// ─── Play a Single Audio Blob ─────────────────────────────────────────────────
function playBlob(blob, volume = 1.0) {
  return new Promise((resolve, reject) => {
    // Clean up previous
    stopCurrentAudio();

    const url = URL.createObjectURL(blob);
    currentBlobUrl = url;
    currentAudio = new Audio(url);
    currentAudio.volume = Math.max(0, Math.min(1, volume));

    currentAudio.onended = () => {
      URL.revokeObjectURL(url);
      currentBlobUrl = null;
      currentAudio = null;
      resolve();
    };

    currentAudio.onerror = (e) => {
      URL.revokeObjectURL(url);
      currentBlobUrl = null;
      currentAudio = null;
      reject(new Error("Audio playback error: " + e.message));
    };

    currentAudio.play().catch(reject);
  });
}

// ─── Stop Current Audio ───────────────────────────────────────────────────────
function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

// ─── Stop and Clear Queue ─────────────────────────────────────────────────────
function stopAll() {
  playbackQueue = [];
  isPlaying = false;
  stopCurrentAudio();
}

// ─── Sequential Queue Player ──────────────────────────────────────────────────
async function playQueue(chunks, piperUrl, volume) {
  isPlaying = true;
  playbackQueue = [...chunks];

  while (playbackQueue.length > 0 && isPlaying) {
    const chunk = playbackQueue.shift();

    try {
      const blob = await fetchPiperAudio(chunk, piperUrl);
      if (!isPlaying) break; // Stopped while fetching
      await playBlob(blob, volume);
    } catch (err) {
      console.error("TTS chunk error:", err);
      // Continue to next chunk on error rather than stopping entirely
    }
  }

  isPlaying = false;
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "stop-audio") {
    stopAll();
    return;
  }

  if (message.type === "speak-text") {
    const { text, piperUrl, volume = 1.0 } = message;

    // Stop whatever is currently playing
    stopAll();

    // Split into chunks and play sequentially
    const chunks = splitIntoChunks(text);
    playQueue(chunks, piperUrl, volume).catch((err) => {
      console.error("Queue playback error:", err);
    });
  }
});
