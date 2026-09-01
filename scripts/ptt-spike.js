/**
 * Push-to-talk spike.
 *
 * Answers three questions before we build the voice feature:
 *   1. Does a globalShortcut still fire while a fullscreen game holds focus?
 *   2. Which accelerators survive (games swallow some, the OS reserves others)?
 *   3. Can an always-on-top overlay be seen on top of that game?
 *
 * Run:   npx electron scripts/ptt-spike.js
 * Quit:  Ctrl+Shift+F12, or Ctrl+C in the terminal.
 *
 * Every hit is appended to ~/.claude-terminal/ptt-spike.log so the results
 * survive alt-tabbing in and out of a game.
 */

const { app, globalShortcut, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

// F13-F24 are the interesting ones for gamers: no game binds them, and any
// gaming mouse/keyboard can map a side button to them.
const CANDIDATES = [
  'F13',
  'F14',
  'Ctrl+Shift+V',
  'Alt+V',
  'Ctrl+Alt+Space',
  'Ctrl+Shift+Space'
];

const QUIT_ACCELERATOR = 'Ctrl+Shift+F12';
const LOG_FILE = path.join(os.homedir(), '.claude-terminal', 'ptt-spike.log');

const hits = new Map();
let overlay = null;
let flashTimer = null;

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.appendFileSync(LOG_FILE, stamped + '\n');
  } catch (err) {
    console.error('Could not write to log file:', err.message);
  }
}

function createOverlay() {
  // Put the overlay on the primary display, top center, out of the way of
  // most game HUDs.
  const { bounds } = screen.getPrimaryDisplay();
  const width = 320;
  const height = 64;

  overlay = new BrowserWindow({
    width,
    height,
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + 40),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    // focusable:false is what keeps the game from losing focus when we show it.
    focusable: false,
    hasShadow: false,
    show: false
  });

  // 'screen-saver' is the highest level Electron exposes; anything lower loses
  // to a fullscreen game.
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.setIgnoreMouseEvents(true);

  const html = `
    <html>
      <body style="margin:0;font-family:Segoe UI,sans-serif;background:transparent;">
        <div id="box" style="
          margin:0 auto;padding:12px 20px;border-radius:8px;
          background:rgba(13,13,13,0.92);border:1px solid #d97706;
          color:#e0e0e0;font-size:15px;text-align:center;
          opacity:0;transition:opacity 120ms;">
          <span id="label"></span>
        </div>
      </body>
    </html>`;

  overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  // showInactive, never show() - show() would pull focus away from the game.
  overlay.once('ready-to-show', () => overlay.showInactive());
}

function flash(text) {
  if (!overlay || overlay.isDestroyed()) return;
  // Driven from main so the overlay needs no nodeIntegration.
  const payload = JSON.stringify(text);
  overlay.webContents.executeJavaScript(`
    (() => {
      document.getElementById('label').textContent = ${payload};
      const box = document.getElementById('box');
      box.style.opacity = '1';
      clearTimeout(window.__t);
      window.__t = setTimeout(() => { box.style.opacity = '0'; }, 900);
    })();
  `).catch(() => {});
  clearTimeout(flashTimer);
  // Re-assert the always-on-top level: some games reset the z-order when they
  // take exclusive fullscreen, and this is exactly what we want to detect.
  flashTimer = setTimeout(() => {
    if (overlay && !overlay.isDestroyed()) {
      overlay.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 50);
}

function printSummary() {
  log('--- SUMMARY ---');
  for (const accelerator of CANDIDATES) {
    const count = hits.get(accelerator) || 0;
    const verdict = count > 0 ? `OK (${count} hits)` : 'NEVER FIRED';
    log(`  ${accelerator.padEnd(18)} ${verdict}`);
  }
  log(`Full log: ${LOG_FILE}`);
}

app.whenReady().then(() => {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch (_) {}

  log('=== PTT spike started ===');
  log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`);

  createOverlay();

  for (const accelerator of CANDIDATES) {
    hits.set(accelerator, 0);
    let registered = false;
    try {
      registered = globalShortcut.register(accelerator, () => {
        const count = (hits.get(accelerator) || 0) + 1;
        hits.set(accelerator, count);
        log(`HIT  ${accelerator}  (#${count})`);
        flash(`${accelerator}  -  hit #${count}`);
      });
    } catch (err) {
      log(`REGISTER FAILED  ${accelerator}: ${err.message}`);
      continue;
    }
    log(registered
      ? `registered  ${accelerator}`
      : `TAKEN BY ANOTHER APP  ${accelerator}`);
  }

  globalShortcut.register(QUIT_ACCELERATOR, () => {
    log(`quit requested via ${QUIT_ACCELERATOR}`);
    printSummary();
    app.quit();
  });

  log('');
  log('Now alt-tab into your game and press each key a few times.');
  log(`Come back and press ${QUIT_ACCELERATOR} to print the summary.`);
  log('');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// No windows to keep alive besides the overlay - never auto-quit.
app.on('window-all-closed', (e) => e.preventDefault());
