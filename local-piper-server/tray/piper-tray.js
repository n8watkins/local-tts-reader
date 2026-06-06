// Cross-platform Piper TTS tray (Windows / macOS / Linux).
//
// One Node codebase replacing the per-OS tray scripts. It shows server status
// as a green/red dot (swapping pre-rendered icon files — no runtime drawing, so
// it ports cleanly), and offers Start/Stop/Open-Voices/Quit. The local server is
// already Node, so the tray reuses the same runtime.
//
//   node tray/piper-tray.js
//
// Robustness: async (non-blocking) health checks, a single-instance lockfile
// with stale-lock recovery, graceful shutdown, and modest crash supervision.
const SysTray = require('systray2').default;
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const TRAY_DIR = __dirname;
const SERVER_DIR = path.dirname(TRAY_DIR); // .../local-piper-server
const ASSETS = path.join(TRAY_DIR, 'assets');
const LOG_DIR = path.join(SERVER_DIR, 'logs');
const PID_FILE = path.join(LOG_DIR, 'piper-tts-server.pid');
const LOCK_FILE = path.join(LOG_DIR, 'piper-tray.lock');
const HOST = '127.0.0.1';
const PORT = 5050;
const isWin = process.platform === 'win32';
const ICON_EXT = isWin ? 'ico' : 'png'; // Windows tray needs .ico; mac/linux use .png
const MAX_RESTARTS = 3;

fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Single instance (portable lockfile + stale-lock recovery) ───────────────
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
(function acquireLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const owner = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      if (owner && owner !== process.pid && isAlive(owner)) {
        console.error(`Piper tray already running (pid ${owner}); exiting.`);
        process.exit(0);
      }
      // else: stale lock from a crashed/killed instance — take it over.
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch { /* non-fatal */ }
})();
const releaseLock = () => {
  try {
    if (fs.existsSync(LOCK_FILE) &&
        parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch { /* ignore */ }
};

// ─── Icons (pre-rendered; just swap which file is shown) ──────────────────────
const iconB64 = (name) => fs.readFileSync(path.join(ASSETS, `${name}.${ICON_EXT}`)).toString('base64');
const ICON_ONLINE = iconB64('online');
const ICON_OFFLINE = iconB64('offline');

// ─── Health (async, never blocks the tray) ───────────────────────────────────
const checkHealth = () => new Promise((resolve) => {
  const req = http.get({ host: HOST, port: PORT, path: '/health', timeout: 1500 }, (res) => {
    res.resume();
    resolve(res.statusCode >= 200 && res.statusCode < 300);
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

// ─── Server lifecycle ────────────────────────────────────────────────────────
const managedPid = () => {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return pid && isAlive(pid) ? pid : null;
  } catch { return null; }
};
function startServer() {
  const out = fs.openSync(path.join(LOG_DIR, 'piper-tts-server.log'), 'a');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR, detached: true, stdio: ['ignore', out, out],
  });
  try { fs.writeFileSync(PID_FILE, String(child.pid)); } catch { /* ignore */ }
  child.unref();
}
function stopServer() {
  const pid = managedPid();
  if (pid) { try { process.kill(pid); } catch { /* ignore */ } }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}
function openVoices() {
  const dir = path.join(SERVER_DIR, 'piper', 'voices');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const opener = isWin ? 'explorer.exe' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  try { spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
}

// ─── Menu ────────────────────────────────────────────────────────────────────
const sep = () => Object.assign({}, SysTray.separator);
const statusItem = { title: 'Piper TTS: checking…', tooltip: '', enabled: false };
const startItem = { title: 'Start Server', tooltip: 'Start the local Piper server', enabled: true };
const stopItem = { title: 'Stop Server', tooltip: 'Stop the managed server', enabled: false };
const voicesItem = { title: 'Open Voices Folder', tooltip: '', enabled: true };
const quitItem = { title: 'Quit', tooltip: '', enabled: true };
const menu = {
  icon: ICON_OFFLINE,
  title: 'Piper TTS',
  tooltip: 'Piper TTS',
  items: [statusItem, sep(), startItem, stopItem, sep(), voicesItem, quitItem],
};
const systray = new SysTray({ menu, debug: false, copyDir: true });

let intendedRunning = false; // user/auto wants it up — gates crash supervision
let restarts = 0;
let lastKey = '';

async function refresh() {
  const online = await checkHealth();
  const managed = managedPid() !== null;

  // Crash supervision: if we wanted it up and it died (not just starting), restart.
  if (intendedRunning && !online && !managed) {
    if (restarts < MAX_RESTARTS) { restarts += 1; startServer(); }
  }
  if (online) restarts = 0;

  const key = `${online}|${managed}`;
  if (key === lastKey) return; // only push to the tray on actual state changes
  lastKey = key;

  statusItem.title = online
    ? (managed ? 'Piper TTS: online' : 'Piper TTS: online (external)')
    : 'Piper TTS: offline';
  startItem.enabled = !online;
  stopItem.enabled = managed;
  menu.icon = online ? ICON_ONLINE : ICON_OFFLINE;
  menu.tooltip = statusItem.title;
  systray.sendAction({ type: 'update-menu', menu }).catch(() => {});
}

systray.onClick((action) => {
  switch (action.item && action.item.title) {
    case 'Start Server': intendedRunning = true; restarts = 0; startServer(); setTimeout(refresh, 800); break;
    case 'Stop Server': intendedRunning = false; stopServer(); setTimeout(refresh, 800); break;
    case 'Open Voices Folder': openVoices(); break;
    case 'Quit': shutdown(); break;
    default: break;
  }
});

function shutdown() {
  releaseLock();
  try { systray.kill(true); } catch { process.exit(0); }
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

systray.ready().then(async () => {
  if (!(await checkHealth())) { intendedRunning = true; startServer(); } // auto-start if offline
  else { intendedRunning = managedPid() !== null; }
  await refresh();
  setInterval(refresh, 2000);
}).catch((err) => {
  console.error('Piper tray failed to start:', (err && err.message) || err);
  releaseLock();
  process.exit(1);
});
