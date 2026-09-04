#!/usr/bin/env node
/**
 * Launch the app against a throwaway HOME.
 *
 * Every path the app owns hangs off os.homedir() — ~/.claude-terminal for
 * projects, settings and accounts, ~/.claude for sessions and credentials —
 * and paths.js has no environment override. os.homedir() follows $HOME on
 * POSIX, so pointing HOME at a scratch directory isolates all of it at once,
 * plus Electron's own userData, which is what gives this instance its own
 * single-instance lock instead of stealing focus from another test run.
 *
 *   node scripts/dev-sandbox.js [name] [-- extra electron args]
 *
 * NOT isolated: the macOS login Keychain, which is per-user and ignores HOME.
 * Reading it is what lets a sandbox capture an existing account without a
 * fresh login. Writing it is another matter — see the warning printed below.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const passthrough = sep === -1 ? [] : argv.slice(sep + 1);
const name = (sep === -1 ? argv[0] : argv.slice(0, sep)[0]) || 'default';

if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
  console.error(`Invalid sandbox name: ${name}`);
  process.exit(1);
}

const realHome = os.homedir();
const sandboxRoot = path.join(realHome, '.claude-terminal-sandboxes');
const sandboxHome = path.join(sandboxRoot, name);

// A sandbox that resolved to the real home would quietly defeat the point.
if (path.resolve(sandboxHome) === path.resolve(realHome)) {
  console.error('Refusing to run: sandbox HOME resolves to the real home.');
  process.exit(1);
}

for (const dir of [sandboxHome, path.join(sandboxHome, '.claude'), path.join(sandboxHome, '.claude-terminal')]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const repoRoot = path.join(__dirname, '..');
const electron = require(path.join(repoRoot, 'node_modules', 'electron'));

console.log(`
  Sandbox     ${sandboxHome}
  Isolated    projects, settings, accounts, sessions, time tracking,
              Electron userData (so its own single-instance lock)
  Shared      the macOS login Keychain — per-user, ignores HOME

  Capturing an account here reads your real Keychain entry, which is how a
  fresh sandbox gets credentials without a login. But "Make default" writes
  that same entry, so it reaches back into your real login: bind projects to
  test, and leave the default alone.

  Delete with: rm -rf ${sandboxHome}
`);

const child = spawn(electron, [repoRoot, ...passthrough], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOME: sandboxHome,
    // Belt and braces: the CLI reads this directly rather than via homedir.
    CLAUDE_CONFIG_DIR: path.join(sandboxHome, '.claude'),
    // The app is launched from a shell that has one; a sandbox HOME has no
    // rc files, so pass the resolved PATH through rather than lose it.
    PATH: process.env.PATH,
  },
});

child.on('exit', (code) => process.exit(code ?? 0));
