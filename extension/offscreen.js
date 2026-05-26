// Offscreen document: handles Piper TTS fetching and audio playback.
// This runs in a real DOM context, unlike the service worker.

let currentAudio = null;
let currentBlobUrl = null;
let rejectCurrentPlay = null;    // C1: lets stopCurrentAudio() settle a pending playBlob() Promise
let currentDisconnectNodes = null; // stores the active chunk's disconnectNodes so stopCurrentAudio can call it
let audioCtx = null;             // Web Audio API context — reused across chunks for volume boost
let playbackQueue = [];
let isPlaying = false;
let isPaused  = false; // true while audio is paused mid-queue
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
// leaves the queue hanging indefinitely.
const FETCH_TIMEOUT_MS = 30_000;

async function fetchPiperAudio(text, piperUrl, voice = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(piperUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(voice ? { text, voice } : { text }),
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
    currentAudio.playbackRate = Math.max(0.1, Math.min(4.0, rate));

    // Volume via Web Audio API GainNode — allows values > 1.0 for boost.
    // Standard audio.volume is capped at 1.0; GainNode has no upper limit.
    if (!audioCtx || audioCtx.state === "closed") {
      audioCtx = new AudioContext();
    }
    const source = audioCtx.createMediaElementSource(currentAudio);
    const gain   = audioCtx.createGain();
    gain.gain.value = Math.max(0, volume);
    source.connect(gain);
    gain.connect(audioCtx.destination);
    audioCtx.resume().catch(() => {});

    // Disconnect Web Audio nodes after use to prevent accumulating dead nodes
    // on the shared AudioContext across chunks. Each playBlob call creates a
    // new source+gain pair; without disconnect they linger until the context
    // is GC'd, which may never happen during a long session.
    let nodesDisconnected = false;
    function disconnectNodes() {
      if (nodesDisconnected) return;
      nodesDisconnected = true;
      currentDisconnectNodes = null; // clear module-level ref once called
      try { source.disconnect(); } catch (_) {}
      try { gain.disconnect();  } catch (_) {}
    }
    // Expose to stopCurrentAudio() so it can disconnect nodes when stop is
    // called mid-playback (onended/onerror/play.catch won't fire on a pause).
    currentDisconnectNodes = disconnectNodes;

    currentAudio.onended = () => {
      rejectCurrentPlay = null;
      disconnectNodes();
      URL.revokeObjectURL(url);
      currentBlobUrl = null;
      currentAudio = null;
      resolve();
    };

    // C5 fix: e is a plain Event; the actual error lives at e.target.error (MediaError)
    currentAudio.onerror = (e) => {
      rejectCurrentPlay = null;
      disconnectNodes();
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
      disconnectNodes();
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
  // Disconnect Web Audio nodes for the chunk that was just stopped.
  // (disconnectNodes is a closure inside playBlob; we keep a module-level
  //  reference so we can call it from here even when stop fires mid-playback.)
  if (currentDisconnectNodes) {
    currentDisconnectNodes();
    currentDisconnectNodes = null;
  }
}

// ─── Stop and Clear Queue ─────────────────────────────────────────────────────
function stopAll() {
  playbackQueue = [];
  isPlaying = false;
  isPaused  = false;
  stopCurrentAudio();
}

// ─── Sequential Queue Player ──────────────────────────────────────────────────
// Architectural simplification: background.js now does a health-check pre-flight
// and fires speak-text as fire-and-forget, so playQueue no longer needs to call
// sendResponse. It simply plays chunks until done, stopped, or an error occurs.
async function playQueue(chunks, piperUrl, volume, rate, voice, generation) {
  isPlaying = true;
  playbackQueue = [...chunks];

  const live = () => isPlaying && playGeneration === generation;

  while (playbackQueue.length > 0 && live()) {
    const chunk = playbackQueue.shift();

    try {
      const blob = await fetchPiperAudio(chunk, piperUrl, voice);

      if (!live()) break;

      // Between-chunk pause: wait until resume-audio clears the flag
      if (isPaused) {
        await new Promise(resolve => {
          const check = setInterval(() => {
            if (!isPaused || !live()) { clearInterval(check); resolve(); }
          }, 100);
        });
        if (!live()) break;
      }

      await playBlob(blob, volume, rate);

    } catch (err) {
      // V3: check sentinel flag, not message string
      if (err.isStop === true) break; // intentional stop — exit silently

      if (live()) {
        // Real error mid-playback — log and stop (don't continue to next chunk)
        console.error("TTS chunk error:", err);
      }
      break;
    }
  }

  // Only reset isPlaying if we're still the active generation
  if (playGeneration === generation) {
    isPlaying = false;
    isPaused  = false;
    // Notify background so it can update the popup's now-playing indicator
    chrome.runtime.sendMessage({ type: "playback-ended" }).catch(() => {});
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "stop-audio") {
    stopAll();
    return; // no async response needed
  }

  if (message.type === "pause-audio") {
    if (isPlaying) {
      isPaused = true;                             // set regardless of whether a chunk is mid-play
      if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
      }
    }
    return;
  }

  if (message.type === "resume-audio") {
    if (isPaused) {
      isPaused = false;
      if (currentAudio && currentAudio.paused) {
        currentAudio.play().catch(() => {});
      }
      // If currentAudio is null the queue is between chunks; it will check isPaused
      // before calling playBlob and resume naturally.
    }
    return;
  }

  if (message.type === "speak-text") {
    const { text, piperUrl, volume = 1.0, rate = 1.0, voice = "" } = message;

    // Stop previous playback and bump generation so stale queues self-terminate
    stopAll();
    playGeneration++;
    const gen = playGeneration;

    const chunks = splitIntoChunks(text);

    // Fire-and-forget: background.js no longer awaits a response, so respond
    // immediately and let playback run independently. This eliminates the
    // long-lived message channel that Chrome was killing mid-flight.
    playQueue(chunks, piperUrl, volume, rate, voice, gen).catch((err) => {
      console.error("Queue playback error:", err);
    });

    sendResponse({ ok: true });
    return false; // synchronous response already sent — port can close immediately
  }
});
