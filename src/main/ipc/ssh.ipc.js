/**
 * SSH host IPC: profiles, connections and the Open Remote Project browser.
 *
 * The rule this file exists to keep (design/remote-ssh.md section 4.1): the
 * renderer never chooses a destination. Every handler takes a `profileId` (or,
 * in later slices, an `ssh-remote://` URI resolved through `projectTarget`),
 * and main reads host, user, port and every ssh option from its own
 * remote-hosts.json. The only handler that receives host fields is
 * `ssh-profile-save`, which is the profile editor itself, and it validates
 * them and refuses any field it does not know.
 *
 * The browse handlers (`ssh-browse`, `ssh-mkdir`, `ssh-init`, `ssh-clone`) are
 * the documented exception to "inside a registered project": they take a
 * profile and an absolute path, and can only list directories (names and
 * types, never contents), create one, `git init` it, or clone into a new one.
 *
 * Namespaced `ssh`, not `remote`: in this codebase "remote" already means the
 * PWA (remote.ipc.js) and claude.ai Remote Control (remote-control.ipc.js).
 */

'use strict';

const os = require('os');
const path = require('path');
const { ipcMain } = require('electron');
const operations = require('../utils/cancellableOperation');
const sshHostService = require('../services/SshHostService');
const { createRemoteFs } = require('../utils/remoteFs');
const { resolveBrowseTarget } = require('../utils/projectTarget');
const { gitScript, q } = require('../../shared/remote-shell');
const remotePath = require('../../shared/remote-path');

/**
 * Remote clone URLs: https:// and scp-style git@host: only, like the local
 * clone. `ext::`, `file://` and friends are code-execution transports.
 */
function isAllowedCloneUrl(url) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  if (!u || u !== url || u.length > 2048 || u.startsWith('-') || /\s/.test(u) || remotePath.hasControlChars(u)) return false;
  return /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:\d+)?\/\S+$/.test(u) || /^git@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s:-]\S*$/.test(u);
}

/** Every failure crosses the bridge as `{ success: false, error, code }`. */
function failure(e) {
  return { success: false, error: e && e.message ? e.message : String(e), code: e && e.code ? e.code : undefined };
}

/** Make sure the host is connected before a write; the status says why not. */
async function requireConnected(profileId) {
  const status = await sshHostService.connect(profileId);
  if (status.state !== 'connected') {
    const error = new Error(`Host is not connected (${status.state})`);
    error.code = 'REMOTE_DISCONNECTED';
    error.status = status;
    throw error;
  }
  return status;
}

function absolutePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    const error = new Error('Remote path must be absolute');
    error.code = 'REMOTE_PATH_INVALID';
    throw error;
  }
  const normalized = remotePath.toPosix(value);
  if (normalized === '/') {
    const error = new Error('Refusing to use the remote root');
    error.code = 'REMOTE_PATH_INVALID';
    throw error;
  }
  return normalized;
}

/**
 * Clone into a new directory on a host, streaming git's progress. Shared by
 * the Open Remote Project browser (`ssh-clone`) and `git-clone` given an
 * ssh-remote:// destination. The remote host's own credentials (or a
 * forwarded agent) are used: the local GitHub token never goes onto a remote
 * command line, where `ps` would show it, nor into its environment. The URL
 * allowlist applies, and the destination must not exist yet.
 *
 * @param {{ profileId: string, url: string, path: string, signal?: AbortSignal, progress?: Function }} params
 * @returns {Promise<{ success: boolean, path?: string, error?: string }>}
 */
async function cloneOnHost({ profileId, url, path: dir, signal, progress }) {
  if (!isAllowedCloneUrl(url)) return { success: false, error: 'Only https:// and git@ URLs are allowed' };
  const target = await resolveBrowseTarget(profileId, absolutePath(dir));
  await requireConnected(target.profileId);
  const script = [
    `if [ -e ${q(target.remotePath)} ]; then echo 'Destination already exists' >&2; exit 17; fi`,
    'GIT_TERMINAL_PROMPT=0',
    'export GIT_TERMINAL_PROMPT',
    `exec git -c protocol.ext.allow=never clone --progress -- ${q(url)} ${q(target.remotePath)}`,
  ].join('; ');
  const res = await sshHostService.oneShot(target.profileId, script, {
    signal,
    timeoutMs: 30 * 60 * 1000,
    onStderr: (chunk) => {
      const text = chunk.toString('utf8');
      const message = text.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean).pop();
      if (message && progress) progress({ message });
    },
  });
  if (!res.ok) {
    const stderr = res.stderr ? res.stderr.toString('utf8').trim().split(/\r?\n/).slice(-3).join('\n') : '';
    return { success: false, error: res.reason ? `Clone ${res.reason}` : (stderr || `git clone failed with exit code ${res.code}`) };
  }
  return { success: true, path: target.remotePath };
}

function registerSshHandlers() {
  // ── Profiles ──────────────────────────────────────────────────────────────

  ipcMain.handle('ssh-profiles-list', async () => {
    try {
      const profiles = await sshHostService.listProfiles();
      return { success: true, profiles, statuses: sshHostService.getAllStatuses() };
    } catch (e) {
      return failure(e);
    }
  });

  ipcMain.handle('ssh-profile-save', async (_event, profile) => {
    try {
      return { success: true, profile: await sshHostService.saveProfile(profile) };
    } catch (e) {
      return failure(e);
    }
  });

  ipcMain.handle('ssh-profile-delete', async (_event, { profileId } = {}) => {
    try {
      return { success: true, deleted: await sshHostService.deleteProfile(profileId) };
    } catch (e) {
      return failure(e);
    }
  });

  ipcMain.handle('ssh-profile-test', async (_event, { profileId } = {}) => {
    try {
      return { success: true, result: await sshHostService.testProfile(profileId) };
    } catch (e) {
      return failure(e);
    }
  });

  // The identity file picker runs in main and hands back a path only: ~/.ssh
  // stays outside what the renderer may read.
  ipcMain.handle('ssh-pick-identity-file', async (event) => {
    try {
      const { dialog, BrowserWindow } = require('electron');
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        title: 'SSH identity file',
        defaultPath: path.join(os.homedir(), '.ssh'),
        properties: ['openFile', 'showHiddenFiles'],
      });
      return { success: true, path: result.canceled ? null : (result.filePaths[0] || null) };
    } catch (e) {
      return failure(e);
    }
  });

  // "Verify host": OpenSSH's own host key prompt, in a local PTY whose output
  // the profile editor shows. Main builds the argv from the stored profile;
  // `terminal-create` cannot be used for this, on purpose, since it never lets
  // the renderer choose what a PTY runs.
  ipcMain.handle('ssh-verify-host', async (_event, { profileId } = {}) => {
    try {
      const command = await sshHostService.verifyCommand(profileId);
      const res = require('../services/TerminalService').create({ cwd: os.homedir(), command: { file: command.file, args: command.args } });
      if (!res || !res.success) return { success: false, error: (res && res.error) || 'Could not start ssh' };
      return { success: true, id: res.id, destination: command.destination };
    } catch (e) {
      return failure(e);
    }
  });

  // ── Connections ───────────────────────────────────────────────────────────

  ipcMain.handle('ssh-connect', async (_event, { profileId } = {}) => {
    try {
      return { success: true, status: await sshHostService.connect(profileId) };
    } catch (e) {
      return failure(e);
    }
  });

  ipcMain.handle('ssh-disconnect', async (_event, { profileId } = {}) => {
    try {
      return { success: true, status: sshHostService.disconnect(profileId) };
    } catch (e) {
      return failure(e);
    }
  });

  ipcMain.handle('ssh-status', async (_event, { profileId } = {}) => {
    try {
      if (profileId) return { success: true, status: sshHostService.getStatus(profileId) };
      return { success: true, statuses: sshHostService.getAllStatuses() };
    } catch (e) {
      return failure(e);
    }
  });

  // The renderer's `online` event: retry hosts that are waiting out a backoff.
  ipcMain.on('ssh-network-online', () => {
    try { sshHostService.onOnline(); } catch (e) { console.warn('[SSH IPC] online retry failed:', e.message); }
  });

  // ── Open Remote Project browser ───────────────────────────────────────────

  // Directories only: names and types of the subdirectories of `path` (or of
  // the remote home when `path` is empty), plus the canonical path.
  ipcMain.handle('ssh-browse', async (_event, { profileId, path: dir } = {}) => {
    try {
      const target = await resolveBrowseTarget(profileId, dir);
      // Connect first, so a slow handshake (ProxyJump, a heavy login shell)
      // does not eat into the listing's own timeout, and a host that cannot
      // connect answers with its state instead of a generic timeout.
      await requireConnected(target.profileId);
      const fsApi = createRemoteFs(sshHostService.runner(target.profileId));
      const listing = await fsApi.listDirectories(target.remotePath);
      const parent = listing.path === '/' ? null : remotePath.dirname(listing.path);
      return { success: true, path: listing.path, parent, entries: listing.entries, truncated: listing.truncated };
    } catch (e) {
      return failure(e);
    }
  });

  ipcMain.handle('ssh-mkdir', async (_event, { profileId, path: dir } = {}) => {
    try {
      const target = await resolveBrowseTarget(profileId, absolutePath(dir));
      await requireConnected(target.profileId);
      const fsApi = createRemoteFs(sshHostService.runner(target.profileId));
      await fsApi.mkdir(target.remotePath, { recursive: true });
      return { success: true, path: await fsApi.realpathDir(target.remotePath) };
    } catch (e) {
      return failure(e);
    }
  });

  ipcMain.handle('ssh-init', async (_event, { profileId, path: dir } = {}) => {
    try {
      const target = await resolveBrowseTarget(profileId, absolutePath(dir));
      await requireConnected(target.profileId);
      const res = await sshHostService.exec(target.profileId, gitScript(target.remotePath, ['init']), { write: true, timeoutMs: 30000 });
      if (!res.ok) {
        const detail = res.reason || (res.stderr && res.stderr.toString('utf8').trim()) || `exit code ${res.code}`;
        return { success: false, error: `git init failed: ${detail}`, code: res.reason === 'disconnected' ? 'REMOTE_DISCONNECTED' : undefined };
      }
      return { success: true, output: res.stdout.toString('utf8') };
    } catch (e) {
      return failure(e);
    }
  });

  // Clone into a new directory on the host, streaming git's progress (see cloneOnHost).
  operations.handle(ipcMain, 'ssh-clone', async (_event, { profileId, url, path: dir } = {}, signal, progress) => (
    cloneOnHost({ profileId, url, path: dir, signal, progress })
  ));
}

module.exports = { registerSshHandlers, isAllowedCloneUrl, cloneOnHost };
