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
const { createReadStream } = require("fs");
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
const DEFAULT_VOICE = "en_US-ryan-high.onnx";

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
//
// S1 fix: Piper reads text from stdin — there is no --input-file flag.
// Passing an unrecognised flag caused Piper to silently wait for stdin forever,
// hitting our 60 s timeout on every request. Also corrected --output-file →
// --output_file (underscore) to match Piper's actual CLI.
function runPiper({ text, outputPath, voiceModel }) {
  return new Promise((resolve, reject) => {
    const args = [
      "--model",       path.join(VOICE_DIR, voiceModel),
      "--output_file", outputPath          // underscore, not hyphen
    ];

    let proc;
    try {
      proc = spawn(PIPER_EXE, args);
    } catch (err) {
      return reject(new Error(`Failed to spawn Piper: ${err.message}`));
    }

    // Feed text via stdin and close the pipe so Piper knows input is complete
    proc.stdin.write(text, "utf8");
    proc.stdin.end();

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
  const voice = (req.body?.voice && req.body.voice.trim()) || DEFAULT_VOICE;

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

  const cleanText  = text.trim();
  const id         = crypto.randomUUID();
  const outputPath = path.join(OUTPUT_DIR, `${id}.wav`);

  const cleanup = () => Promise.allSettled([
    fs.rm(outputPath, { force: true })
  ]);

  try {
    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Run Piper — text is passed via stdin (S1 fix)
    await runPiper({ text: cleanText, outputPath, voiceModel: safeVoice });

    // Stream the WAV back
    // S2 fix: replaced sendFile (broken on Windows with root:"/") with a plain
    // createReadStream pipe — works on all platforms without path quirks.
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");

    const stream = createReadStream(outputPath);

    stream.on("error", async (err) => {
      console.error("[/tts] stream error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to stream audio file." });
      }
      await cleanup();
    });

    stream.on("close", async () => {
      await cleanup();
    });

    stream.pipe(res);

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

// ─── DELETE /voices/:name  (remove an installed voice) ───────────────────────
app.delete("/voices/:name", async (req, res) => {
  const name = path.basename(req.params.name); // strip any path traversal
  if (!name.endsWith(".onnx")) {
    return res.status(400).json({ error: "Voice name must end in .onnx" });
  }
  const onnxPath = path.join(VOICE_DIR, name);
  const jsonPath  = onnxPath + ".json";
  try {
    await Promise.allSettled([
      fs.rm(onnxPath, { force: true }),
      fs.rm(jsonPath, { force: true })
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
