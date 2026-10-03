/**
 * SSH host IPC: profiles, connections and the Open Remote Project browser.
 *
 * The rule this file exists to keep (design/remote-ssh.md section 4.1): the
 * renderer never chooses a destination. Every handler takes a `profileId` (or,
 * for `ssh-fs`, an `ssh-remote://` URI resolved through `projectTarget`),
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
const { createRemoteFs, isBlockedRemotePath, PUT_LIMIT } = require('../utils/remoteFs');
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

/**
 * The browse writes (mkdir, init, clone) take any absolute path on the host,
 * so they apply the remote blocklist themselves: no directory, repository or
 * clone lands in ~/.ssh, a shell rc path or the CLI's credentials.
 * @param {object} status   the connected status, with the handshake's home
 * @param {string} posix    normalised absolute remote path
 */
function refuseBlockedBrowseWrite(status, posix) {
  const home = status && status.capabilities && status.capabilities.home;
  if (isBlockedRemotePath(posix, home, 'write')) {
    const error = new Error('This remote path is protected and cannot be written from the app');
    error.code = 'REMOTE_PATH_BLOCKED';
    throw error;
  }
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
  refuseBlockedBrowseWrite(await requireConnected(target.profileId), target.remotePath);
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

// ── Remote fs (design/remote-ssh.md section 5.5) ───────────────────────────

/** Text reads are capped here whatever the renderer asks for. */
const FS_READ_DEFAULT = 2 * 1024 * 1024;
const FS_READ_MAX = 8 * 1024 * 1024;
/** Media downloaded to the local cache for a preview. */
const MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const MEDIA_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const MEDIA_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Host states only the user may connect from (mirrors SshHostService). */
const FS_STOPPED_STATES = new Set(['offline', 'authFailed', 'hostKeyUnknown', 'hostKeyChanged', 'unsupported']);

function fsError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

/** A project id as a single directory name, or a hash of it when it is not one. */
function cacheDirName(projectId) {
  const id = String(projectId || '');
  if (/^[A-Za-z0-9_-]{1,100}$/.test(id)) return id;
  return 'p-' + require('crypto').createHash('sha256').update(id).digest('hex').slice(0, 24);
}

/**
 * The `ssh.fs` operations, as a factory so a test can hand it a resolver, a
 * host service and a cache directory of its own.
 *
 * Every path is an ssh-remote:// URI and is authorised here, whatever the
 * renderer already checked:
 *   - `resolveTarget` puts it inside a project registered for that host, after
 *     POSIX normalisation (a `..` above the root throws in remote-path); the
 *     one grant outside a project root is that project's private memory on the
 *     host, `<remote ~/.claude>/projects/<encoded root>/CLAUDE.md` and
 *     `.../memory/`, which is what the Memory editor edits;
 *   - writes fail fast while the host is not connected, then canonicalise the
 *     project root and the target's parent with `cd -P && pwd -P` in one
 *     request, and refuse a parent that resolves outside the root (a symlinked
 *     directory pointing elsewhere), and a write through a symlinked file whose
 *     target does;
 *   - the remote blocklist (`isBlockedRemotePath`) applies to the normalised
 *     path and to its canonical form, against both $HOME and the canonical
 *     $HOME: no write to ~/.ssh, the shell rc files or the CLI's credentials,
 *     and no content read of ~/.ssh or the credentials, even inside a project.
 *
 * @param {object} [deps]
 */
function createSshFs({
  service = sshHostService,
  resolveTarget = (uri) => require('../utils/projectTarget').resolveTarget(uri),
  loadProjects = () => {
    const { projectsFile } = require('../utils/paths');
    return require('../utils/projectTarget').readProjectsFile(projectsFile);
  },
  cacheRoot = () => path.join(require('../utils/paths').dataDir, 'remote-cache'),
  fsImpl = require('fs'),
  now = () => Date.now(),
} = {}) {
  const sessionDirs = require('../../shared/session-dirs');

  function parseUri(uri) {
    if (!remotePath.isRemotePath(uri)) throw fsError('REMOTE_PATH_INVALID', 'Remote fs paths must be ssh-remote:// URIs');
    return remotePath.parse(uri); // throws on a `..` above the root and on control characters
  }

  /** The host's handshake capabilities; a read may connect for them, a write may not. */
  async function capabilitiesFor(profileId, access) {
    let status = service.getStatus(profileId);
    if (access === 'write' && status.state !== 'connected') {
      throw fsError('REMOTE_DISCONNECTED', `Host is not connected (${status.state})`, { reason: 'disconnected', state: status.state });
    }
    if (!status.capabilities || !status.capabilities.home) {
      // A read connects an idle host, as a channel read does; a host that
      // stopped (auth or host key failure, unsupported, user went offline)
      // waits for the user, never for a file view.
      if (FS_STOPPED_STATES.has(status.state)) {
        throw fsError('REMOTE_DISCONNECTED', `Host is not connected (${status.state})`, { reason: 'disconnected', state: status.state });
      }
      status = await service.connect(profileId);
    }
    if (!status || !status.capabilities || !status.capabilities.home) {
      throw fsError('REMOTE_DISCONNECTED', `Host is not connected (${status ? status.state : 'idle'})`, { reason: 'disconnected', state: status ? status.state : 'idle' });
    }
    return status.capabilities;
  }

  /** A path in no project may still be that project's private memory on the host. */
  async function privateMemoryTarget(profileId, posix, capabilities) {
    const projects = await loadProjects();
    for (const project of projects) {
      const parsed = project && remotePath.tryParse(project.path);
      if (!parsed || parsed.profileId !== profileId) continue;
      const dir = sessionDirs.getRemoteSessionsDir(parsed.path, capabilities);
      if (!dir) continue;
      if (posix === `${dir}/CLAUDE.md`) return { project, root: dir, memory: true };
      if (remotePath.isInside(posix, `${dir}/memory`)) return { project, root: `${dir}/memory`, memory: true };
    }
    return null;
  }

  /**
   * @param {string} uri
   * @param {'read'|'write'} access
   * @returns {Promise<{profileId: string, path: string, root: string, project: object, capabilities: object, uri: string}>}
   */
  async function authorize(uri, access) {
    const { profileId, path: posix } = parseUri(uri);
    let resolved = null;
    let notInProject = null;
    try {
      resolved = await resolveTarget(remotePath.format(profileId, posix));
    } catch (e) {
      if (e.code !== 'REMOTE_PATH_NOT_IN_PROJECT') throw e;
      notInProject = e;
    }
    const capabilities = await capabilitiesFor(profileId, access);
    let root;
    let project;
    if (resolved) {
      root = resolved.projectRoot;
      project = resolved.project;
    } else {
      const memory = await privateMemoryTarget(profileId, posix, capabilities);
      if (!memory) throw notInProject;
      root = memory.root;
      project = memory.project;
    }
    if (isBlockedRemotePath(posix, capabilities.home, access)) {
      throw fsError('REMOTE_PATH_BLOCKED', 'This remote path is protected and cannot be accessed from the app');
    }
    return { profileId, path: posix, root, project, capabilities, uri: remotePath.format(profileId, posix) };
  }

  function blockedAnyHome(p, homes, access) {
    return homes.some((h) => h && isBlockedRemotePath(p, h, access));
  }

  /**
   * One request: canonical root, canonical parent and the target's own link.
   * Refuses a write that would land outside the canonical root or on a
   * protected path. `followsLink` is true for a write that goes through a
   * symlinked file (writeFile), whose target must be inside the root too.
   */
  async function checkWrite(fsApi, target, { followsLink = false } = {}) {
    const parent = remotePath.dirname(target.path);
    const { home, entries } = await fsApi.canonicalize([target.root, parent, target.path], { write: true });
    const [rootC, parentC, self] = entries;
    if (!rootC.canonical || !parentC.canonical) throw fsError('REMOTE_PATH_UNRESOLVED', 'Could not resolve the remote path');
    const canonicalTarget = remotePath.join(parentC.canonical, remotePath.basename(target.path));
    const homes = [target.capabilities.home, home];
    if (!remotePath.isInside(canonicalTarget, rootC.canonical)) {
      throw fsError('REMOTE_PATH_OUTSIDE_PROJECT', 'The remote path resolves outside the project through a symlink');
    }
    if (blockedAnyHome(canonicalTarget, homes, 'write')) {
      throw fsError('REMOTE_PATH_BLOCKED', 'This remote path is protected and cannot be accessed from the app');
    }
    if (followsLink && self.link) {
      if (self.link === '?' || !remotePath.isInside(self.link, rootC.canonical) || blockedAnyHome(self.link, homes, 'write')) {
        throw fsError('REMOTE_PATH_OUTSIDE_PROJECT', 'The remote file is a symlink that resolves outside the project');
      }
    }
  }

  /** Before a content read: the canonical file must not be a protected one either. */
  async function checkRead(fsApi, target) {
    const { home, entries } = await fsApi.canonicalize([remotePath.dirname(target.path), target.path]);
    const [parentC, self] = entries;
    const homes = [target.capabilities.home, home];
    const candidates = [];
    if (parentC.canonical) candidates.push(remotePath.join(parentC.canonical, remotePath.basename(target.path)));
    if (self.link && self.link !== '?') candidates.push(self.link);
    if (self.link === '?') throw fsError('REMOTE_PATH_UNRESOLVED', 'The remote file is a symlink that cannot be resolved');
    for (const c of candidates) {
      if (blockedAnyHome(c, homes, 'read')) throw fsError('REMOTE_PATH_BLOCKED', 'This remote path is protected and cannot be accessed from the app');
    }
  }

  const fsFor = (target) => createRemoteFs(service.runner(target.profileId));

  function sameHost(a, b) {
    if (a.profileId !== b.profileId) throw fsError('REMOTE_CROSS_HOST', 'Copying or moving between hosts is not supported');
  }

  // ── Media cache ──

  function mediaDir(projectId) {
    return path.join(cacheRoot(), cacheDirName(projectId), 'media');
  }

  /** Drop cached media older than a week, then the oldest until the cache fits. */
  async function pruneMediaCache() {
    const root = cacheRoot();
    let projectDirs;
    try { projectDirs = await fsImpl.promises.readdir(root); } catch { return; }
    const files = [];
    for (const dir of projectDirs) {
      const media = path.join(root, dir, 'media');
      let names;
      try { names = await fsImpl.promises.readdir(media); } catch { continue; }
      for (const name of names) {
        const full = path.join(media, name);
        try {
          const st = await fsImpl.promises.stat(full);
          if (st.isFile()) files.push({ full, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* gone */ }
      }
    }
    let total = 0;
    const keep = [];
    for (const f of files) {
      if (now() - f.mtimeMs > MEDIA_CACHE_MAX_AGE_MS) {
        await fsImpl.promises.rm(f.full, { force: true }).catch(() => {});
      } else {
        keep.push(f);
        total += f.size;
      }
    }
    keep.sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (total > MEDIA_CACHE_MAX_BYTES && keep.length) {
      const f = keep.shift();
      total -= f.size;
      await fsImpl.promises.rm(f.full, { force: true }).catch(() => {});
    }
  }

  /**
   * Download a media file for a preview: images, video, audio, PDF and 3D
   * models are shown through the existing file:// code paths from
   * `~/.claude-terminal/remote-cache/<projectId>/media/`, so the renderer's
   * CSP never has to admit anything new. Keyed by path, size and mtime, so an
   * unchanged file is downloaded once.
   */
  async function cacheMedia(target) {
    const fsApi = fsFor(target);
    const st = await fsApi.stat(target.path);
    if (!st.isFile) throw fsError('EISDIR', 'Only files can be previewed');
    if (st.size !== null && st.size > MEDIA_MAX_BYTES) {
      throw fsError('ETOOLARGE', `File is too large to preview (${st.size} bytes, limit ${MEDIA_MAX_BYTES})`, { size: st.size, limit: MEDIA_MAX_BYTES });
    }
    await checkRead(fsApi, target);
    const crypto = require('crypto');
    const key = crypto.createHash('sha256').update(`${target.uri}\0${st.size}\0${st.mtimeMs}`).digest('hex').slice(0, 20);
    const base = remotePath.basename(target.path).replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'file';
    const dir = mediaDir(target.project && target.project.id);
    const file = path.join(dir, `${key}-${base}`);
    try {
      const existing = await fsImpl.promises.stat(file);
      if (existing.isFile()) {
        const t = new Date(now());
        await fsImpl.promises.utimes(file, t, t).catch(() => {});
        return { localPath: file, size: existing.size, cached: true };
      }
    } catch { /* not cached yet */ }
    const size = st.size === null ? MEDIA_MAX_BYTES : st.size;
    const res = await fsApi.readFile(target.path, { maxBytes: MEDIA_MAX_BYTES, oneShot: size > PUT_LIMIT, timeoutMs: 5 * 60 * 1000 });
    if (res.truncated) throw fsError('ETOOLARGE', 'File is too large to preview', { limit: MEDIA_MAX_BYTES });
    await fsImpl.promises.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await fsImpl.promises.writeFile(tmp, res.data);
    await fsImpl.promises.rename(tmp, file).catch(async (e) => {
      await fsImpl.promises.rm(tmp, { force: true }).catch(() => {});
      throw e;
    });
    pruneMediaCache().catch(() => {});
    return { localPath: file, size: res.data.length, cached: false };
  }

  /**
   * Run one `ssh.fs` request.
   * @param {object} req  `{ op, path, ... }`
   */
  async function run(req = {}) {
    const op = req.op;
    switch (op) {
      case 'stat': {
        const target = await authorize(req.path, 'read');
        return fsFor(target).stat(target.path);
      }
      case 'readdir': {
        const target = await authorize(req.path, 'read');
        return fsFor(target).readdir(target.path);
      }
      case 'readFile': {
        const target = await authorize(req.path, 'read');
        const fsApi = fsFor(target);
        await checkRead(fsApi, target);
        const maxBytes = Math.min(FS_READ_MAX, Math.max(0, Math.floor(Number(req.maxBytes) || FS_READ_DEFAULT)));
        const res = await fsApi.readFile(target.path, { maxBytes, oneShot: maxBytes > PUT_LIMIT && req.large === true });
        const encoding = req.encoding === 'base64' ? 'base64' : 'utf8';
        return { data: res.data.toString(encoding), encoding, size: res.size, truncated: res.truncated };
      }
      case 'writeFile': {
        const target = await authorize(req.path, 'write');
        const fsApi = fsFor(target);
        await checkWrite(fsApi, target, { followsLink: true });
        if (typeof req.data !== 'string') throw fsError('EINVAL', 'writeFile needs string data');
        const data = Buffer.from(req.data, req.encoding === 'base64' ? 'base64' : 'utf8');
        return fsApi.writeFile(target.path, data);
      }
      case 'mkdir': {
        const target = await authorize(req.path, 'write');
        const fsApi = fsFor(target);
        await checkWrite(fsApi, target);
        await fsApi.mkdir(target.path, { recursive: req.recursive !== false });
        return true;
      }
      case 'rm': {
        const target = await authorize(req.path, 'write');
        if (target.path === target.root) throw fsError('EPERM', 'Refusing to remove the project root');
        const fsApi = fsFor(target);
        await checkWrite(fsApi, target);
        await fsApi.rm(target.path, { recursive: req.recursive === true });
        return true;
      }
      case 'rename':
      case 'copy': {
        const from = await authorize(req.from, op === 'rename' ? 'write' : 'read');
        const to = await authorize(req.to, 'write');
        sameHost(from, to);
        if (op === 'rename' && from.path === from.root) throw fsError('EPERM', 'Refusing to move the project root');
        const fsApi = fsFor(to);
        if (op === 'rename') await checkWrite(fsApi, from);
        else await checkRead(fsApi, from);
        await checkWrite(fsApi, to);
        if (op === 'rename') await fsApi.rename(from.path, to.path);
        else await fsApi.copy(from.path, to.path);
        return true;
      }
      case 'listFiles': {
        const target = await authorize(req.path, 'read');
        return fsFor(target).listFiles(target.path);
      }
      case 'grep': {
        const target = await authorize(req.path, 'read');
        const pattern = typeof req.pattern === 'string' ? req.pattern : '';
        if (!pattern || pattern.length > 500) throw fsError('EINVAL', 'Search pattern must be 1 to 500 characters');
        return fsFor(target).grep(target.path, pattern, { ignoreCase: req.ignoreCase !== false, fixed: true, maxCount: 3 });
      }
      case 'cacheMedia': {
        const target = await authorize(req.path, 'read');
        return cacheMedia(target);
      }
      case 'privatePaths': {
        // Where the CLI keeps this project's private CLAUDE.md and memory on
        // the host. Answered without touching the host beyond the handshake.
        const { profileId, path: posix } = parseUri(req.path);
        const resolved = await resolveTarget(remotePath.format(profileId, posix));
        const capabilities = await capabilitiesFor(profileId, 'read');
        const dir = sessionDirs.getRemoteSessionsDir(resolved.projectRoot, capabilities);
        if (!dir) throw fsError('REMOTE_DISCONNECTED', 'The remote home directory is unknown', { reason: 'disconnected' });
        return {
          sessionsDir: remotePath.format(profileId, dir),
          claudeMd: remotePath.format(profileId, `${dir}/CLAUDE.md`),
          memoryDir: remotePath.format(profileId, `${dir}/memory`),
        };
      }
      default:
        throw fsError('EINVAL', 'Unsupported remote fs operation');
    }
  }

  return { run, authorize, cacheMedia, pruneMediaCache, mediaDir };
}

/** Every remote fs failure crosses the bridge as `{ success: false, error, code, reason }`. */
function fsFailure(e) {
  return {
    success: false,
    error: e && e.message ? e.message : String(e),
    code: e && e.code ? e.code : undefined,
    reason: e && e.reason ? e.reason : (e && e.code === 'REMOTE_DISCONNECTED' ? 'disconnected' : undefined),
  };
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
      refuseBlockedBrowseWrite(await requireConnected(target.profileId), target.remotePath);
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
      refuseBlockedBrowseWrite(await requireConnected(target.profileId), target.remotePath);
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

  // ── Remote fs ─────────────────────────────────────────────────────────────

  // One handler, an allowlisted `op` per call (see createSshFs). Async only:
  // the synchronous renderer fs bridge never serves a remote path, since a
  // sendSync waiting on the network would freeze the window.
  const sshFs = createSshFs();
  ipcMain.handle('ssh-fs', async (_event, request = {}) => {
    try {
      return { success: true, value: await sshFs.run(request) };
    } catch (e) {
      return fsFailure(e);
    }
  });

  // Clone into a new directory on the host, streaming git's progress (see cloneOnHost).
  operations.handle(ipcMain, 'ssh-clone', async (_event, { profileId, url, path: dir } = {}, signal, progress) => (
    cloneOnHost({ profileId, url, path: dir, signal, progress })
  ));
}

module.exports = { registerSshHandlers, isAllowedCloneUrl, cloneOnHost, createSshFs, MEDIA_MAX_BYTES };
