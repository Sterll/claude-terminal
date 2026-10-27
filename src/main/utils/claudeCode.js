/**
 * Claude Code on this machine: is it installed, and which binary a terminal
 * tab should run.
 *
 * The chat never needed an installed CLI: it runs the binary the Agent SDK
 * ships (sdkCli.js), and so does account sign-in. Terminal tabs did, because
 * they ran a bare `claude` and let the shell find it, so on a machine where
 * Claude Code was never installed every Claude terminal tab died on
 * "'claude' is not recognized". resolveTerminalClaude() keeps that bare
 * `claude` whenever the shell can find one, uses an installed binary the PATH
 * does not reach yet (the native installer adds ~/.local/bin to the user PATH,
 * which this process inherited before the install), and falls back to the
 * SDK's binary only when there is nothing else.
 *
 * installClaudeCode() runs Anthropic's official installer, the same one-liner
 * the Claude Code docs give, and is only ever started by an explicit click.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { runCommand } = require('./runCommand');
const { getSdkCliPath } = require('./sdkCli');

const INSTALL_URL_PS1 = 'https://claude.ai/install.ps1';
const INSTALL_URL_SH = 'https://claude.ai/install.sh';
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_TIMEOUT_MS = 15000;
// A PATH walk is a few dozen stats; a terminal opening is not the place to
// repeat it on every tab, and an install invalidates it explicitly.
const CACHE_TTL_MS = 15000;

// OSC (hyperlinks, titles) and CSI (colours, cursor) sequences.
const TERMINAL_CODES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

let cache = null;

function isWindows() {
  return process.platform === 'win32';
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (isWindows()) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `claude` as the shell would find it on this process's PATH, or null.
 * On Windows only the extensions a native or npm install produces are tried,
 * in cmd.exe's PATHEXT order.
 */
function findOnPath(env = process.env) {
  const rawPath = env.PATH || env.Path || '';
  const dirs = rawPath.split(path.delimiter).map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const names = isWindows() ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutableFile(file)) return file;
    }
  }
  return null;
}

/** Where the official installers and npm put the CLI, most likely first. */
function knownInstallPaths(home = os.homedir(), env = process.env) {
  if (isWindows()) {
    const out = [path.join(home, '.local', 'bin', 'claude.exe')];
    if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'claude.cmd'));
    return out;
  }
  return [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
  ];
}

/**
 * The installed Claude Code, if any.
 * @returns {{ file: string, onPath: boolean } | null}
 */
function findInstalled() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  let value = null;
  const onPath = findOnPath();
  if (onPath) value = { file: onPath, onPath: true };
  else {
    const known = knownInstallPaths().find(isExecutableFile);
    if (known) value = { file: known, onPath: false };
  }
  cache = { at: Date.now(), value };
  return value;
}

function invalidate() {
  cache = null;
}

/**
 * What a local Claude terminal tab should launch.
 *
 *   path     `claude` is on the PATH: launch it by name, exactly as before
 *   install  installed where the PATH does not reach yet: launch it by path
 *   bundled  not installed: the Agent SDK's binary, with its updater off,
 *            since that binary is replaced by app updates, not by itself
 *   missing  nothing anywhere: launch `claude` by name, and the shell says so
 *
 * @returns {{ source: 'path'|'install'|'bundled'|'missing', file: string|null, env: Object|null }}
 */
function resolveTerminalClaude() {
  const installed = findInstalled();
  if (installed && installed.onPath) return { source: 'path', file: null, env: null };
  if (installed) return { source: 'install', file: installed.file, env: null };
  const bundled = getSdkCliPath();
  if (bundled) return { source: 'bundled', file: bundled, env: { DISABLE_AUTOUPDATER: '1' } };
  return { source: 'missing', file: null, env: null };
}

/** `claude --version` of one binary, or null. Never rejects. */
function readVersion(file) {
  return new Promise(resolve => {
    const done = (error, stdout) => {
      const match = !error && /(\d+\.\d+\.\d+)/.exec(String(stdout || ''));
      resolve(match ? match[1] : null);
    };
    const options = { timeout: VERSION_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' };
    if (isWindows() && /\.(cmd|bat)$/i.test(file)) {
      // A batch shim only runs through cmd.exe; /s keeps the quoted path whole.
      execFile('cmd.exe', ['/d', '/s', '/c', `""${file}" --version"`], { ...options, windowsVerbatimArguments: true }, done);
    } else {
      execFile(file, ['--version'], options, done);
    }
  });
}

/**
 * What the setup wizard shows.
 * @returns {Promise<{ installed: boolean, path: string|null, onPath: boolean, version: string|null, bundledVersion: string|null }>}
 */
async function getStatus() {
  invalidate();
  const installed = findInstalled();
  const bundled = getSdkCliPath();
  const [version, bundledVersion] = await Promise.all([
    installed ? readVersion(installed.file) : null,
    bundled ? readVersion(bundled) : null,
  ]);
  return {
    installed: !!installed,
    path: installed ? installed.file : null,
    onPath: !!(installed && installed.onPath),
    version,
    bundledVersion,
  };
}

/** The official installer, as the Claude Code docs give it. */
function installerCommand() {
  if (isWindows()) {
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        // Windows PowerShell 5.1 can still default to TLS 1.0 on older builds.
        `[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; irm ${INSTALL_URL_PS1} | iex`,
      ],
    };
  }
  return { file: '/bin/bash', args: ['-c', `set -o pipefail; curl -fsSL ${INSTALL_URL_SH} | bash`] };
}

/**
 * Put the directory of a binary found off the PATH on this process's PATH, so
 * terminals, and the shells they start, reach `claude` without a restart.
 */
function exposeOnPath(file) {
  const dir = path.dirname(file);
  const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  const current = process.env[key] || '';
  const same = isWindows() ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  if (current.split(path.delimiter).some(entry => same(entry, dir))) return;
  process.env[key] = current ? `${dir}${path.delimiter}${current}` : dir;
}

let installing = null;

/**
 * Run the official installer, streaming its output.
 * A second call while one runs joins it rather than starting another.
 * @param {{ onProgress?: (text: string) => void }} [options]
 * @returns {Promise<{ success: boolean, error?: string, status: Object }>}
 */
function installClaudeCode({ onProgress } = {}) {
  if (installing) return installing;
  const { file, args } = installerCommand();
  installing = (async () => {
    let error = null;
    try {
      await runCommand(file, args, {
        cwd: os.homedir(),
        timeoutMs: INSTALL_TIMEOUT_MS,
        onProgress: text => onProgress?.(String(text).replace(TERMINAL_CODES, '')),
      });
    } catch (e) {
      error = String(e?.message || e).replace(TERMINAL_CODES, '').trim() || 'The installer failed';
    }
    const status = await getStatus();
    if (status.installed && !status.onPath) exposeOnPath(status.path);
    if (!error && !status.installed) error = 'The installer finished but Claude Code was not found afterwards';
    return error ? { success: false, error, status } : { success: true, status };
  })().finally(() => { installing = null; });
  return installing;
}

module.exports = {
  findOnPath,
  knownInstallPaths,
  findInstalled,
  invalidate,
  resolveTerminalClaude,
  readVersion,
  getStatus,
  installerCommand,
  installClaudeCode,
  exposeOnPath,
};
