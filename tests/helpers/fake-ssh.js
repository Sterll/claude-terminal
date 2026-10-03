#!/usr/bin/env node
/**
 * A stand-in for the ssh binary, for the channel and host-service tests.
 *
 * Run as a script, it ignores every ssh argument and becomes a local
 * `/bin/sh -s` (Git for Windows' sh.exe on Windows), so the shipped driver runs
 * for real against a real shell. `FAKE_SSH_MODE` selects a failure instead:
 *
 *   ok (default)      exec the local sh
 *   noisy             print rc-file noise, including a ready marker with the
 *                     wrong nonce, then exec the local sh
 *   auth              "Permission denied (publickey)", exit 255
 *   hostkey-unknown   "Host key verification failed", exit 255
 *   hostkey-changed   the REMOTE HOST IDENTIFICATION HAS CHANGED banner, exit 255
 *   timeout           "Connection timed out", exit 255
 *   refused           "Connection refused", exit 255
 *   dns               "Could not resolve hostname", exit 255
 *   nosh              what a Windows sshd with cmd.exe prints, exit 1
 *   die               run the local sh, then die with "Connection reset" and
 *                     exit 255 after FAKE_SSH_DIE_AFTER_MS (default 300)
 *   dropped           as die, but the server ended the session: "closed by
 *                     remote host", then exit(-1), which POSIX reports as 255
 *                     and Windows as 4294967295, like the real Windows OpenSSH
 *
 * `FAKE_SSH_ARGV_FILE`, when set, receives the argv as JSON so a test can
 * assert what the service would have handed to the real ssh.
 *
 * Required as a module, it exports `findSh()` and the script's own path.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function findSh() {
  if (process.env.FAKE_SSH_SH && fs.existsSync(process.env.FAKE_SSH_SH)) return process.env.FAKE_SSH_SH;
  if (process.platform !== 'win32') return fs.existsSync('/bin/sh') ? '/bin/sh' : null;
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    'C:\\Program Files\\Git\\bin\\sh.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\sh.exe',
  ];
  try {
    const git = execFileSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      .split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (git) {
      const root = path.resolve(path.dirname(git), '..');
      candidates.unshift(path.join(root, 'usr', 'bin', 'sh.exe'), path.join(root, 'bin', 'sh.exe'));
    }
  } catch { /* no git on PATH */ }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

/** A local path as the local sh sees it: `C:\x\y` is `/c/x/y` under Git for Windows' msys. */
function toShPath(p) {
  if (process.platform !== 'win32') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

const FAILURES = {
  auth: 'yanis@build.example.com: Permission denied (publickey,password).\r\n',
  'hostkey-unknown': 'No ED25519 host key is known for build.example.com and you have requested strict checking.\r\nHost key verification failed.\r\n',
  'hostkey-changed': [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
    'Host key verification failed.',
    '',
  ].join('\r\n'),
  timeout: 'ssh: connect to host build.example.com port 22: Connection timed out\r\n',
  refused: 'ssh: connect to host build.example.com port 22: Connection refused\r\n',
  dns: 'ssh: Could not resolve hostname build.example.com: Name or service not known\r\n',
};

function shEnv(sh) {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = `${path.dirname(sh)}${path.delimiter}${env[key] || ''}`;
  return env;
}

function main() {
  if (process.env.FAKE_SSH_ARGV_FILE) {
    try { fs.writeFileSync(process.env.FAKE_SSH_ARGV_FILE, JSON.stringify(process.argv.slice(2))); } catch { /* best effort */ }
  }
  const mode = process.env.FAKE_SSH_MODE || 'ok';
  if (FAILURES[mode]) {
    process.stderr.write(FAILURES[mode], () => process.exit(255));
    return;
  }
  if (mode === 'nosh') {
    process.stderr.write("'/bin/sh' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n", () => process.exit(1));
    return;
  }
  const sh = findSh();
  if (!sh) {
    process.stderr.write('fake-ssh: no local sh\n', () => process.exit(127));
    return;
  }
  const start = () => {
    if (mode === 'die' || mode === 'dropped') {
      const child = spawn(sh, ['-s'], { stdio: ['pipe', 'inherit', 'inherit'], env: shEnv(sh), windowsHide: true });
      process.stdin.pipe(child.stdin);
      child.stdin.on('error', () => {});
      setTimeout(() => {
        const last = mode === 'dropped'
          ? 'Connection to fakehost closed by remote host.\r\n'
          : 'client_loop: send disconnect: Connection reset\r\n';
        process.stderr.write(last, () => {
          try { child.kill(); } catch { /* gone */ }
          process.exit(mode === 'dropped' ? -1 : 255);
        });
      }, Number(process.env.FAKE_SSH_DIE_AFTER_MS || 300));
      return;
    }
    const child = spawn(sh, ['-s'], { stdio: 'inherit', env: shEnv(sh), windowsHide: true });
    child.on('exit', (code, signal) => process.exit(code === null ? 255 : code));
  };
  if (mode === 'noisy') {
    // .bashrc echo, a motd, a decoy marker with someone else's nonce, binary junk.
    process.stdout.write('Welcome to fake host\nLast login: never\nCT-READY-0000000000000000 1\n\u0000\u00ff\u0001junk', start);
    return;
  }
  start();
}

if (require.main === module) main();

module.exports = { findSh, toShPath, FAILURES, FAKE_SSH: __filename };
