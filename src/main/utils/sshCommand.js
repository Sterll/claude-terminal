/**
 * The system OpenSSH client: where it is, and the argv to give it.
 *
 * Remote projects reach their host through the user's own `ssh` binary, never
 * through a JS SSH library (design/remote-ssh.md section 2.1), so
 * `~/.ssh/config`, ProxyJump, agents, hardware keys and `known_hosts` behave
 * exactly as they do in the user's terminal, and the app holds no secret.
 *
 * Every argv this module builds:
 *   - puts `--` immediately before the destination, and refuses a host, alias,
 *     user or jump host that starts with `-` (checked again here even though the
 *     profile store validated it, because an argv is the last line of defence);
 *   - carries `ServerAliveInterval=15` / `ServerAliveCountMax=3`;
 *   - never sets `StrictHostKeyChecking=no` and never redirects
 *     `UserKnownHostsFile`. The one mode that relaxes anything is `verify`,
 *     which sets `StrictHostKeyChecking=ask` so OpenSSH itself shows the
 *     fingerprint in a terminal tab;
 *   - adds `BatchMode=yes` for every non-interactive process (channel, chat,
 *     one-shot), so ssh fails instead of prompting on a pipe nobody reads;
 *   - adds `ControlMaster` / `ControlPath` / `ControlPersist` on POSIX clients
 *     only. Win32-OpenSSH does not implement multiplexing (section 2.2);
 *   - adds `-A` only when the profile opted into agent forwarding.
 *
 * There is no free-form option field: a profile cannot carry `ProxyCommand` or
 * `LocalCommand`, which would be local code execution for anyone able to write
 * remote-hosts.json. Users who need those put them in their own ssh_config.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const HOST_RE = /^[A-Za-z0-9._:[\]-]+$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

const KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

function argvError(message) {
  const error = new Error(message);
  error.code = 'SSH_ARGV_INVALID';
  return error;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Throw unless `value` is a safe host name, IP literal or ssh_config alias. */
function assertHost(value, field = 'host') {
  if (!isNonEmptyString(value)) throw argvError(`${field} is required`);
  if (value.startsWith('-')) throw argvError(`${field} must not start with '-'`);
  if (!HOST_RE.test(value)) throw argvError(`${field} contains characters that are not allowed`);
  return value;
}

function assertUser(value) {
  if (!isNonEmptyString(value)) throw argvError('user is required');
  if (value.startsWith('-')) throw argvError("user must not start with '-'");
  if (!USER_RE.test(value)) throw argvError('user contains characters that are not allowed');
  return value;
}

function assertPort(value) {
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw argvError('port must be an integer between 1 and 65535');
  return port;
}

/** `[user@]host[:port]` items separated by commas, each checked like a destination. */
function assertProxyJump(value) {
  if (!isNonEmptyString(value)) throw argvError('proxyJump is required');
  const items = value.split(',');
  for (const raw of items) {
    const item = raw.trim();
    if (!item || item !== raw) throw argvError('proxyJump items must not be empty or padded');
    if (item.startsWith('-')) throw argvError("proxyJump items must not start with '-'");
    const at = item.lastIndexOf('@');
    if (at !== -1) assertUser(item.slice(0, at));
    assertHost(item.slice(at + 1), 'proxyJump host');
  }
  return value;
}

/** Absolute local path with no control character. */
function assertLocalPath(value, field) {
  if (!isNonEmptyString(value)) throw argvError(`${field} is required`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw argvError(`${field} contains a control character`);
  if (!path.isAbsolute(value)) throw argvError(`${field} must be an absolute path`);
  return value;
}

/** The token after `--`: the ssh_config alias, or the bare host (brackets stripped from an IPv6 literal). */
function destination(profile) {
  if (isNonEmptyString(profile.sshConfigAlias)) return assertHost(profile.sshConfigAlias, 'sshConfigAlias');
  const host = assertHost(profile.host, 'host');
  return /^\[.*\]$/.test(host) ? host.slice(1, -1) : host;
}

/** A short label for logs and the UI: `user@host:port` or the alias. */
function displayDestination(profile) {
  if (!profile) return '';
  if (profile.sshConfigAlias) return profile.sshConfigAlias;
  const user = profile.user ? `${profile.user}@` : '';
  const port = profile.port && profile.port !== 22 ? `:${profile.port}` : '';
  return `${user}${profile.host || ''}${port}`;
}

/** Directory for ControlMaster sockets. */
function controlDir(dataDir) {
  return path.join(dataDir, 'ssh');
}

/** Create the ControlMaster socket directory with mode 0700 (POSIX only). */
function ensureControlDir(dataDir, { platform = process.platform } = {}) {
  if (platform === 'win32') return null;
  const dir = controlDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort, mkdir already asked for 0700 */ }
  return dir;
}

/**
 * The ControlPath option value. `%` in the directory is doubled because ssh
 * expands `%` tokens in it, and a path with whitespace is double-quoted because
 * ssh splits option values on whitespace.
 */
function controlPathValue(dir) {
  const value = `${String(dir).replace(/%/g, '%%')}/cm-%C`;
  if (/["\u0000-\u001f]/.test(value)) throw argvError('ControlPath directory contains a character ssh cannot take');
  return /\s/.test(value) ? `"${value}"` : value;
}

const MODES = new Set(['channel', 'chat', 'oneshot', 'pty', 'verify']);

/**
 * Build the ssh argv for a profile.
 *
 * @param {object} profile  a validated host profile
 * @param {object} options
 * @param {'channel'|'chat'|'oneshot'|'pty'|'verify'} options.mode
 * @param {string[]} [options.remoteCommand]  argv elements after the destination
 * @param {string} [options.platform]         client platform, defaults to process.platform
 * @param {string} [options.controlDir]       ControlPath directory (POSIX clients)
 * @returns {string[]}
 */
function buildSshArgs(profile, { mode, remoteCommand = [], platform = process.platform, controlDir: cmDir = null } = {}) {
  if (!profile || typeof profile !== 'object') throw argvError('A host profile is required');
  if (!MODES.has(mode)) throw argvError(`Unknown ssh mode: ${mode}`);
  const args = [];

  if (mode === 'pty') args.push('-tt');
  else if (mode !== 'verify') args.push('-T');

  if (mode === 'verify') args.push('-o', 'StrictHostKeyChecking=ask');
  else if (mode !== 'pty') args.push('-o', 'BatchMode=yes');

  args.push(...KEEPALIVE);

  if (platform !== 'win32' && cmDir && mode !== 'verify') {
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPathValue(cmDir)}`, '-o', 'ControlPersist=60');
  }

  if (profile.port !== undefined && profile.port !== null && profile.port !== '') args.push('-p', String(assertPort(profile.port)));
  if (isNonEmptyString(profile.user)) args.push('-l', assertUser(profile.user));
  if (isNonEmptyString(profile.identityFile)) args.push('-i', assertLocalPath(profile.identityFile, 'identityFile'));
  if (isNonEmptyString(profile.proxyJump)) args.push('-J', assertProxyJump(profile.proxyJump));
  if (profile.forwardAgent === true) args.push('-A');

  args.push('--', destination(profile));
  if (mode === 'verify') args.push('exit');
  else args.push(...remoteCommand);
  return args;
}

/** argv for a channel lane: `... -- <dest> /bin/sh -s`. */
function channelArgs(profile, options = {}) {
  return buildSshArgs(profile, { ...options, mode: 'channel', remoteCommand: ['/bin/sh', '-s'] });
}

/** argv for a chat CLI process: `... -- <dest> <one remote command element>`. */
function chatArgs(profile, remoteCommand, options = {}) {
  return buildSshArgs(profile, { ...options, mode: 'chat', remoteCommand: [remoteCommand] });
}

/** argv for a one-shot exec (clone, bulk transfer). */
function oneShotArgs(profile, remoteCommand, options = {}) {
  return buildSshArgs(profile, { ...options, mode: 'oneshot', remoteCommand: [remoteCommand] });
}

// ── Binary discovery ─────────────────────────────────────────────────────────

function execFirstLine(file, args, execFileImpl) {
  return new Promise((resolve) => {
    execFileImpl(file, args, { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const line = String(stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(line || null);
    });
  });
}

/**
 * Locate the ssh binary. An override (from remote-hosts.json, never from
 * settings.json) wins when it exists.
 *
 * win32: %SystemRoot%\System32\OpenSSH\ssh.exe, then `where.exe ssh`.
 * elsewhere: /usr/bin/ssh, then `command -v ssh` with the PATH main.js
 * resolved from the login shell at startup.
 *
 * @returns {Promise<string|null>}
 */
async function findSshBinary({
  override = null,
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
  execFileImpl = execFile,
} = {}) {
  if (isNonEmptyString(override) && existsSync(override)) return override;
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    const builtin = path.win32.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe');
    if (existsSync(builtin)) return builtin;
    const found = await execFirstLine('where.exe', ['ssh'], execFileImpl);
    return found && existsSync(found) ? found : null;
  }
  if (existsSync('/usr/bin/ssh')) return '/usr/bin/ssh';
  const found = await execFirstLine('/bin/sh', ['-c', 'command -v ssh'], execFileImpl);
  return found && found.startsWith('/') && existsSync(found) ? found : null;
}

module.exports = {
  HOST_RE,
  USER_RE,
  assertHost,
  assertUser,
  assertPort,
  assertProxyJump,
  assertLocalPath,
  destination,
  displayDestination,
  controlDir,
  ensureControlDir,
  buildSshArgs,
  channelArgs,
  chatArgs,
  oneShotArgs,
  findSshBinary,
};
