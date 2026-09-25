#!/usr/bin/env node
'use strict';

/**
 * Adds a source checkout to the Linux application menu. Runs from `postinstall`.
 *
 * `LinuxDesktopIntegration` covers the AppImage only: it keys on
 * `process.env.APPIMAGE`, so someone running from a clone had no menu entry
 * and had to write one by hand, which then pointed at `npm` (absent from a
 * launcher's PATH under nvm), had no Icon= line, and did not pass the
 * `--no-sandbox` a user-owned chrome-sandbox needs.
 *
 * What this writes:
 *   - ~/.local/share/icons/hicolor/512x512/apps/claude-terminal.png, and the
 *     entry's Icon= names it by absolute path, as LinuxDesktopIntegration does,
 *     so the icon shows without waiting on an icon-theme cache refresh.
 *   - ~/.local/share/applications/claude-terminal.desktop, running
 *     scripts/linux-launch.cjs with the node that ran this install. Same
 *     basename as a hand-made /usr/share/applications entry, which the one in
 *     ~/.local therefore shadows.
 *
 * It never overwrites an entry it did not write: an existing file must carry
 * this script's marker, or be a hand-made one targeting this checkout's npm
 * start. An AppImage-managed entry is left to the AppImage.
 *
 * Never fails the install. Skipped off Linux, in CI, when run as root, and
 * when CLAUDE_TERMINAL_NO_DESKTOP_ENTRY is set.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DESKTOP_FILE_NAME = 'claude-terminal.desktop';
const MARKER = 'X-Claude-Terminal-ManagedBy=source';

/** Quote one argument for a desktop entry Exec= line. */
function quoteExecArg(arg) {
  return '"' + arg.replace(/(["`$\\])/g, '\\$1') + '"';
}

function buildDesktopEntry({ nodePath, launcherPath, iconPath }) {
  return [
    '[Desktop Entry]',
    'Name=Claude Terminal',
    'Comment=Terminal for Claude Code projects',
    `Exec=${quoteExecArg(nodePath)} ${quoteExecArg(launcherPath)} %U`,
    `TryExec=${nodePath}`,
    `Icon=${iconPath}`,
    'Terminal=false',
    'Type=Application',
    'Categories=Development;Utility;',
    'StartupWMClass=claude-terminal',
    MARKER,
    '',
  ].join('\n');
}

/** Whether an existing entry is ours to replace. */
function mayReplace(existing) {
  if (existing === null) return true;
  if (existing.includes(MARKER)) return true;
  // A hand-written entry launching a checkout through npm start.
  return /^Name=Claude Terminal\s*$/m.test(existing) && /^Exec=.*\bnpm\b.*\bstart\b/m.test(existing);
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function install({ home, nodePath, root, log }) {
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const appsDir = path.join(dataHome, 'applications');
  const iconDir = path.join(dataHome, 'icons', 'hicolor', '512x512', 'apps');
  const desktopPath = path.join(appsDir, DESKTOP_FILE_NAME);
  const iconPath = path.join(iconDir, 'claude-terminal.png');

  const existing = readOrNull(desktopPath);
  if (!mayReplace(existing)) {
    log(`  ${desktopPath} exists and was not written by this checkout; left alone.`);
    return false;
  }

  fs.mkdirSync(iconDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'assets', 'icon.png'), iconPath);

  const content = buildDesktopEntry({
    nodePath,
    launcherPath: path.join(root, 'scripts', 'linux-launch.cjs'),
    iconPath,
  });
  if (existing !== content) {
    fs.mkdirSync(appsDir, { recursive: true });
    const tmp = `${desktopPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o644 });
    fs.renameSync(tmp, desktopPath);
  }
  execFile('update-desktop-database', [appsDir], () => {});
  execFile('gtk-update-icon-cache', ['-q', '-t', path.join(dataHome, 'icons', 'hicolor')], () => {});
  log(`  Claude Terminal added to the application menu (${desktopPath}).`);
  return true;
}

function main() {
  if (process.platform !== 'linux') return;
  if (process.env.CI || process.env.CLAUDE_TERMINAL_NO_DESKTOP_ENTRY) return;
  if (typeof process.getuid === 'function' && process.getuid() === 0) return;
  try {
    install({ home: os.homedir(), nodePath: process.execPath, root: ROOT, log: console.log });
  } catch (e) {
    console.warn(`  Could not create the application menu entry: ${e.message}`);
  }
}

if (require.main === module) main();

module.exports = { buildDesktopEntry, mayReplace, install, quoteExecArg, MARKER };
