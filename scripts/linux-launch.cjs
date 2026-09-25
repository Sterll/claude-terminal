#!/usr/bin/env node
'use strict';

/**
 * Launches Claude Terminal from a source checkout on Linux. This is what the
 * `.desktop` entry written by `scripts/linux-desktop-entry.cjs` runs.
 *
 * It does what `npm start` does, minus the two things that stop `npm start`
 * from working when a desktop environment launches it:
 *
 *   - It does not rely on PATH. A launcher started from the application menu
 *     does not source the shell profile, so an `npm` or `node` installed via
 *     nvm, fnm or volta is simply not there. The entry calls this script with
 *     the absolute node that ran `npm install`, and this script calls the
 *     Electron binary by absolute path.
 *   - It adds `--no-sandbox` when Chromium's SUID sandbox helper cannot work.
 *     npm installs `node_modules/electron/dist/chrome-sandbox` owned by the
 *     user without the setuid bit, and Electron aborts at startup on such a
 *     helper unless unprivileged user namespaces are available (Ubuntu 24.04
 *     restricts them through AppArmor). The packaged AppImage passes the same
 *     flag for the same reason (see LinuxDesktopIntegration.js).
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/** True when chrome-sandbox is root-owned and setuid, i.e. usable as is. */
function sandboxHelperUsable() {
  try {
    const st = fs.statSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'chrome-sandbox'));
    return st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {
    return false;
  }
}

function main() {
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.js')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (build.status !== 0) process.exit(build.status || 1);

  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const args = [ROOT, ...process.argv.slice(2)];
  if (!sandboxHelperUsable() && !args.includes('--no-sandbox')) args.push('--no-sandbox');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Electron derives the Wayland app_id / X11 WM_CLASS from this, and the
  // shell matches it against the .desktop basename to find the icon.
  env.CHROME_DESKTOP = 'claude-terminal.desktop';

  const child = spawn(electron, args, { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code || 0));
}

main();
