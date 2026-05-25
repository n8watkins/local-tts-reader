/**
 * Local Piper TTS Server
 *
 * Runs on http://127.0.0.1:5050
 * POST /tts  { "text": "..." }  → audio/wav
 * GET  /health                  → 200 OK
 *
 * Requires:
 *   piper/piper.exe
 *   piper/voices/<model>.onnx
 *   piper/voices/<model>.onnx.json
 */

const express = require("express");
const cors    = require("cors");
const fs      = require("fs/promises");
const path    = require("path");
const crypto  = require("crypto");
const { spawn } = require("child_process");

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT       = 5050;
const HOST       = "127.0.0.1"; // localhost only — never expose publicly
const MAX_CHARS  = 8000;        // reasonable limit per request
const TIMEOUT_MS = 60_000;      // kill Piper if it hangs

// Paths — adjust VOICE_MODEL if you use a different voice file
const PIPER_EXE  = path.join(__dirname, "piper", "piper.exe");
const VOICE_DIR  = path.join(__dirname, "piper", "voices");
const OUTPUT_DIR = path.join(__dirname, "output");

// Default voice model (change to match your downloaded .onnx file)
const DEFAULT_VOICE = "en_US-amy-medium.onnx";

// ─── App Setup ────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.3.1" });
});

// ─── Validation Helpers ───────────────────────────────────────────────────────
function validateText(text) {
  if (!text || typeof text !== "string") {
    return "Missing or invalid 'text' field.";
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "Text must not be empty.";
  }
  if (trimmed.length > MAX_CHARS) {
    return `Text is too long (${trimmed.length} chars). Maximum is ${MAX_CHARS}.`;
  }
  return null; // valid
}

// ─── Piper Runner ─────────────────────────────────────────────────────────────
// C10 fix: uses a `settled` flag so the timeout handler and the `close` event
// can both run without a second reject() call on an already-settled Promise.
function runPiper({ inputPath, outputPath, voiceModel }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--model",       path.join(VOICE_DIR, voiceModel),
      "--input-file",  inputPath,
      "--output-file", outputPath
    ];

    let proc;
    try {
      proc = spawn(PIPER_EXE, args);
    } catch (err) {
      return reject(new Error(`Failed to spawn Piper: ${err.message}`));
    }

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    // C10: guard flag prevents double-settle when both timeout and close fire
    let settled = false;
    const settle = (fn, ...args) => {
      if (settled) return;
      settled = true;
      fn(...args);
    };

    // Timeout guard
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      settle(reject, new Error("Piper process timed out."));
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        settle(resolve);
      } else {
        settle(reject, new Error(`Piper exited with code ${code}. Stderr: ${stderr.trim()}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      settle(reject, new Error(`Piper process error: ${err.message}`));
    });
  });
}

// ─── POST /tts ────────────────────────────────────────────────────────────────
app.post("/tts", async (req, res) => {
  const text  = req.body?.text;
  const voice = req.body?.voice ?? DEFAULT_VOICE;

  // Validate text
  const validationError = validateText(text);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  // Sanitize voice — only allow filename-safe characters, must end in .onnx
  const safeVoice = path.basename(voice);
  if (!safeVoice.endsWith(".onnx")) {
    return res.status(400).json({ error: "Voice must be a .onnx filename." });
  }

  const cleanText = text.trim();
  const id        = crypto.randomUUID();
  const inputPath = path.join(OUTPUT_DIR, `${id}.txt`);
  const outputPath = path.join(OUTPUT_DIR, `${id}.wav`);

  const cleanup = () => Promise.allSettled([
    fs.rm(inputPath,  { force: true }),
    fs.rm(outputPath, { force: true })
  ]);

  try {
    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Write text input
    await fs.writeFile(inputPath, cleanText, "utf8");

    // Run Piper
    await runPiper({ inputPath, outputPath, voiceModel: safeVoice });

    // Stream the WAV back
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");

    // C4 fix: accept the err parameter — sendFile calls cb(err) on failure.
    // If headers haven't been sent yet, send an error response; otherwise log
    // the truncation (can't change status after streaming has started).
    res.sendFile(outputPath, { root: "/" }, async (err) => {
      if (err) {
        console.error("[/tts] sendFile error:", err.message);
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to stream audio file." });
        }
        // If headers were already sent the stream was partially written;
        // nothing to do except clean up and let the client handle the truncation.
      }
      await cleanup();
    });

  } catch (err) {
    await cleanup();

    console.error("[/tts] Error:", err.message);

    if (res.headersSent) return;

    // Give useful errors for common setup problems
    if (err.message.includes("spawn") || err.message.includes("ENOENT")) {
      return res.status(500).json({
        error: "Piper executable not found.",
        details: `Expected at: ${PIPER_EXE}`,
        hint: "Download Piper from https://github.com/rhasspy/piper/releases and place piper.exe in the piper/ folder."
      });
    }

    res.status(500).json({
      error: "TTS generation failed.",
      details: err.message
    });
  }
});

// ─── GET /voices  (list available voice models) ───────────────────────────────
app.get("/voices", async (_req, res) => {
  try {
    const files = await fs.readdir(VOICE_DIR);
    const voices = files.filter(f => f.endsWith(".onnx"));
    res.json({ voices });
  } catch (_) {
    res.json({ voices: [] });
  }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`\n🔊 Local Piper TTS Server`);
  console.log(`   Running at http://${HOST}:${PORT}`);
  console.log(`   Health:  GET  http://${HOST}:${PORT}/health`);
  console.log(`   TTS:     POST http://${HOST}:${PORT}/tts`);
  console.log(`   Voices:  GET  http://${HOST}:${PORT}/voices`);
  console.log(`\n   Piper exe: ${PIPER_EXE}`);
  console.log(`   Voice dir: ${VOICE_DIR}`);
  console.log(`   Default voice: ${DEFAULT_VOICE}`);
  console.log(`\n   Press Ctrl+C to stop.\n`);
});
