// Offscreen document: handles Piper TTS fetching and audio playback.
// This runs in a real DOM context, unlike the service worker.

let currentAudio = null;
let currentBlobUrl = null;
let rejectCurrentPlay = null; // C1: lets stopCurrentAudio() settle a pending playBlob() Promise
let playbackQueue = [];
let isPlaying = false;
let playGeneration = 0; // incremented on each new speak request; stale queues self-terminate

// ─── Chunk Splitter ───────────────────────────────────────────────────────────
function splitIntoChunks(text, maxLength = 350) {
  // C3 fix: was \S+$ (matched only the final word); [^.!?]+$ captures the full
  // trailing clause so unpunctuated text like "Hello world. No period here" keeps
  // all trailing words instead of dropping everything but "here".
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];

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
// V2 fix: 30s per-chunk timeout so a server that accepts TCP but stalls never
// leaves background.js's await hanging indefinitely. 30s is half of Piper's own
// 60s process timeout, giving the server time to do its work without blocking forever.
const FETCH_TIMEOUT_MS = 30_000;

async function fetchPiperAudio(text, piperUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(piperUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer); // always clear, whether fetch succeeded, failed, or aborted
  }

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
// C1: stores its own reject in rejectCurrentPlay so stopCurrentAudio() can
//     settle the Promise immediately when stop is called mid-playback.
// C5: reads MediaError from e.target.error instead of the undefined e.message.
// C6: accepts rate and applies it via audio.playbackRate.
function playBlob(blob, volume = 1.0, rate = 1.0) {
  return new Promise((resolve, reject) => {
    // Settle any prior pending playBlob (guard against concurrent calls)
    stopCurrentAudio();

    // Register our reject so stopCurrentAudio can settle this Promise
    rejectCurrentPlay = reject;

    const url = URL.createObjectURL(blob);
    currentBlobUrl = url;
    currentAudio = new Audio(url);
    currentAudio.volume = Math.max(0, Math.min(1, volume));
    currentAudio.playbackRate = Math.max(0.1, Math.min(4.0, rate)); // C6

    currentAudio.onended = () => {
      rejectCurrentPlay = null;
      URL.revokeObjectURL(url);
      currentBlobUrl = null;
      currentAudio = null;
      resolve();
    };

    // C5 fix: e is a plain Event; the actual error lives at e.target.error (MediaError)
    currentAudio.onerror = (e) => {
      rejectCurrentPlay = null;
      URL.revokeObjectURL(url);
      currentBlobUrl = null;
      currentAudio = null;
      const mediaErr = e.target?.error;
      const msg =
        mediaErr?.message ||
        (mediaErr?.code != null ? `MediaError code ${mediaErr.code}` : null) ||
        "unknown audio error";
      reject(new Error("Audio playback error: " + msg));
    };

    currentAudio.play().catch((err) => {
      rejectCurrentPlay = null;
      reject(err);
    });
  });
}

// ─── Stop Current Audio ───────────────────────────────────────────────────────
// C1 fix: explicitly rejects the pending playBlob() Promise before clearing
// audio state, so await playBlob() in playQueue() always settles on stop.
function stopCurrentAudio() {
  if (rejectCurrentPlay) {
    const r = rejectCurrentPlay;
    rejectCurrentPlay = null;
    // V3 fix: use a sentinel property instead of string comparison so browser
    // DOMExceptions with coincidentally matching messages are never misidentified.
    const stopErr = new Error("Playback stopped");
    stopErr.isStop = true;
    r(stopErr); // settles the pending playBlob Promise
  }
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
// C2 fix: accepts sendResponse and reports after the first chunk result so the
//         background service worker can detect server-down errors and trigger
//         the browser-voice fallback.
// Uses playGeneration to detect when a newer speak request has superseded this one.
async function playQueue(chunks, piperUrl, volume, rate, sendResponse, generation) {
  isPlaying = true;
  playbackQueue = [...chunks];
  let responded = false;

  const live = () => isPlaying && playGeneration === generation;

  while (playbackQueue.length > 0 && live()) {
    const chunk = playbackQueue.shift();

    try {
      const blob = await fetchPiperAudio(chunk, piperUrl);

      // C2: report first-chunk success so background's speakWithPiper() can resolve
      if (!responded) {
        sendResponse({ ok: true });
        responded = true;
      }

      if (!live()) break;

      await playBlob(blob, volume, rate); // C6: rate forwarded

    } catch (err) {
      // V3 fix: check the sentinel flag, not the message string. Any browser
      // DOMException or future refactor that produces a matching message string
      // would previously be misidentified as an intentional stop.
      const wasStopped = err.isStop === true;

      if (!responded && !wasStopped) {
        // C2: first chunk failed for a real reason (server down, bad response, etc.)
        // Report to background so the fallback can trigger.
        //
        // W1 fix: only send {ok:false} if the session is still live. If the user
        // stopped us and the in-flight fetch later aborts or errors (e.g. the
        // 30-second AbortController fires), !live() is true and we must NOT send
        // a failure response — doing so would cause background.js to trigger the
        // browser-voice fallback even though the user deliberately stopped reading.
        if (live()) {
          sendResponse({ ok: false, error: err.message });
          responded = true;
        }
        break;
      }

      if (!wasStopped) {
        // V5 fix: break instead of continuing. Silently skipping failed chunks
        // left users with partial audio and no fallback (background already got
        // {ok:true} after chunk 1). Break on first post-chunk-1 error instead.
        console.error("TTS chunk error:", err);
        break;
      }
      // wasStopped: live() will be false, loop exits naturally via while condition
    }
  }

  // Only reset isPlaying if we're still the active generation
  if (playGeneration === generation) {
    isPlaying = false;
  }

  // Safety net: ensure sendResponse is always called (e.g. empty chunk list)
  if (!responded) {
    sendResponse({ ok: true });
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "stop-audio") {
    stopAll();
    return; // no async response needed
  }

  if (message.type === "speak-text") {
    // C6 fix: destructure rate (was missing — slider setting was silently dropped)
    const { text, piperUrl, volume = 1.0, rate = 1.0 } = message;

    // Stop previous playback and bump generation so stale queues self-terminate
    stopAll();
    playGeneration++;
    const gen = playGeneration;

    const chunks = splitIntoChunks(text);
    playQueue(chunks, piperUrl, volume, rate, sendResponse, gen).catch((err) => {
      console.error("Queue playback error:", err);
    });

    return true; // async response — Chrome keeps the message port open
  }
});
