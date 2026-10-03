/**
 * One file-system facade for local and remote (SSH) project paths.
 *
 * A local path gets exactly what callers used before: the preload's
 * `fs.promises` and `path`, the same objects, so nothing about a local
 * project changes. An `ssh-remote://` URI gets an adapter with the same
 * method names and return shapes, backed by the async `ssh.fs` IPC (design
 * section 5.5), and POSIX path operations from `src/shared/remote-path.js`,
 * since the renderer's `path` is `path.win32` on Windows and would turn
 * `/home/u/x` into `\home\u\x`.
 *
 * The remote adapter is async only. The synchronous bridge
 * (`renderer-fs-sync`) never sees a URI: a `sendSync` that waited on the
 * network would freeze the window. Main authorises every remote path again
 * (inside a registered project, the remote blocklist, symlink containment for
 * writes); nothing here is a security boundary.
 */

const remotePath = require('../../shared/remote-path');

const isRemote = (p) => remotePath.isRemotePath(p);

function _api() {
  return window.electron_api && window.electron_api.ssh;
}

/** One `ssh.fs` request; a failure throws an Error with main's `code` and `reason`. */
async function remoteCall(op, params = {}) {
  const api = _api();
  if (!api || typeof api.fs !== 'function') {
    throw Object.assign(new Error('Remote file access is not available'), { code: 'REMOTE_UNAVAILABLE' });
  }
  const res = await api.fs({ op, ...params });
  if (!res || !res.success) {
    throw Object.assign(new Error((res && res.error) || 'Remote file operation failed'), {
      code: res && res.code,
      reason: res && res.reason,
    });
  }
  return res.value;
}

function _encodingOf(options) {
  if (typeof options === 'string') return options;
  return options && options.encoding ? options.encoding : null;
}

function _base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function _bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function _dirent(entry) {
  return {
    name: entry.name,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    isDirectory: () => entry.type === 'directory',
    isFile: () => entry.type === 'file',
    isSymbolicLink: () => !!entry.symlink,
  };
}

/** `fs.promises`, as far as the file views use it, for ssh-remote:// URIs. */
const remoteFsPromises = Object.freeze({
  async stat(p) {
    const s = await remoteCall('stat', { path: p });
    const mtimeMs = s.mtimeMs || 0;
    return {
      size: s.size || 0,
      mtimeMs,
      mtime: new Date(mtimeMs),
      isDirectory: () => !!s.isDirectory,
      isFile: () => !!s.isFile,
      isSymbolicLink: () => !!s.symlink,
    };
  },
  async access(p) {
    await remoteCall('stat', { path: p });
  },
  /** Names, or dirents with `{ withFileTypes: true }`; one request either way, sizes and mtimes included. */
  async readdir(p, options) {
    const entries = await remoteCall('readdir', { path: p });
    if (options && options.withFileTypes) return entries.map(_dirent);
    return entries.map((e) => e.name);
  },
  /**
   * Text with an encoding, bytes without one. A file larger than the cap
   * (`options.maxBytes`, default and ceiling set in main) throws EFBIG
   * rather than handing back a silently cut file.
   */
  async readFile(p, options) {
    const encoding = _encodingOf(options);
    const text = encoding && encoding !== 'base64';
    const maxBytes = options && typeof options === 'object' ? options.maxBytes : undefined;
    const res = await remoteCall('readFile', { path: p, encoding: text ? 'utf8' : 'base64', maxBytes });
    if (res.truncated) {
      throw Object.assign(new Error(`File is too large to read over SSH (${res.size} bytes)`), { code: 'EFBIG', size: res.size });
    }
    if (text) return res.data;
    if (encoding === 'base64') return res.data;
    return _base64ToBytes(res.data);
  },
  async writeFile(p, data) {
    if (typeof data === 'string') return remoteCall('writeFile', { path: p, data, encoding: 'utf8' });
    return remoteCall('writeFile', { path: p, data: _bytesToBase64(data), encoding: 'base64' });
  },
  async mkdir(p, options) {
    await remoteCall('mkdir', { path: p, recursive: !!(options && options.recursive) });
  },
  async rm(p, options) {
    try {
      await remoteCall('rm', { path: p, recursive: !!(options && options.recursive) });
    } catch (e) {
      if (options && options.force && e.code === 'ENOENT') return;
      throw e;
    }
  },
  async unlink(p) {
    await remoteCall('rm', { path: p, recursive: false });
  },
  async rename(from, to) {
    await remoteCall('rename', { from, to });
  },
  async copyFile(from, to) {
    await remoteCall('copy', { from, to });
  },
});

/** `path`, as far as the file views use it, with POSIX rules on URIs. */
const remotePathApi = Object.freeze({
  sep: '/',
  join: (...parts) => remotePath.join(...parts),
  dirname: (p) => remotePath.dirname(p),
  basename: (p, ext) => remotePath.basename(p, ext),
  extname: (p) => remotePath.extname(p),
  relative: (from, to) => remotePath.relative(from, to),
  normalize: (p) => remotePath.normalize(p),
  resolve: (...parts) => (parts.length === 1 ? remotePath.normalize(parts[0]) : remotePath.join(...parts)),
  isAbsolute: (p) => remotePath.isRemotePath(p),
});

/** The `fs.promises` to use for `p`: the preload's for a local path, the ssh adapter for a URI. */
function fsFor(p) {
  return isRemote(p) ? remoteFsPromises : window.electron_nodeModules.fs.promises;
}

/** The `path` module to use for `p`. */
function pathFor(p) {
  return isRemote(p) ? remotePathApi : window.electron_nodeModules.path;
}

/** `fileExists` for either kind of path. */
async function exists(p) {
  if (!isRemote(p)) return require('./fs-async').fileExists(p);
  try {
    await remoteFsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Copy a directory tree: the local recursive copy, or one `cp -pR` on the host. */
async function copyRecursive(src, dest) {
  if (!isRemote(src) && !isRemote(dest)) return require('./fs-async').copyDirRecursive(src, dest);
  return remoteFsPromises.copyFile(src, dest);
}

/**
 * Every file of a remote tree, relative, in one request (`git ls-files -co
 * --exclude-standard`, else `find`).
 * @returns {Promise<{files: string[], truncated: boolean}>}
 */
function listFiles(rootUri) {
  return remoteCall('listFiles', { path: rootUri });
}

/**
 * Content search over a remote tree in one request (`git grep`, else `grep -r`),
 * at most three matches per file.
 * @returns {Promise<{matches: Array<{file: string, line: number, text: string}>, truncated: boolean}>}
 */
function grep(rootUri, pattern, { ignoreCase = true } = {}) {
  return remoteCall('grep', { path: rootUri, pattern, ignoreCase });
}

/**
 * A local file to preview `p` from. A local path is itself; a remote file is
 * downloaded once (size capped) into ~/.claude-terminal/remote-cache/ and
 * shown from there, so the CSP never has to admit anything new.
 * @returns {Promise<string>}
 */
async function mediaPath(p) {
  if (!isRemote(p)) return p;
  const res = await remoteCall('cacheMedia', { path: p });
  return res.localPath;
}

/** The file:// URL of a local path, the way the viewers have always built it. */
function fileUrl(localPath) {
  return 'file:///' + String(localPath).replace(/\\/g, '/').replace(/^\//, '');
}

/**
 * Where the CLI keeps a remote project's private CLAUDE.md and auto memory on
 * its host, as URIs.
 * @returns {Promise<{sessionsDir: string, claudeMd: string, memoryDir: string}>}
 */
function privatePaths(projectUri) {
  return remoteCall('privatePaths', { path: projectUri });
}

/**
 * Whether a move or copy from `a` to `b` stays on one side: both local, or
 * both on the same host. Anything else would be a transfer between machines.
 */
function sameSide(a, b) {
  if (!isRemote(a) && !isRemote(b)) return true;
  const pa = remotePath.tryParse(a);
  const pb = remotePath.tryParse(b);
  return !!(pa && pb && pa.profileId === pb.profileId);
}

/**
 * A remote absolute POSIX path a remote CLI reported (a tool card's
 * `file_path`), as a URI on the project's host; anything else unchanged.
 * @param {string} p
 * @param {object|null} project
 */
function toProjectUri(p, project) {
  if (!p || typeof p !== 'string' || isRemote(p) || !project || !isRemote(project.path)) return p;
  if (!p.startsWith('/')) return p;
  try {
    return remotePath.format(remotePath.parse(project.path).profileId, p);
  } catch {
    return p;
  }
}

module.exports = {
  isRemote,
  fsFor,
  pathFor,
  exists,
  copyRecursive,
  listFiles,
  grep,
  mediaPath,
  fileUrl,
  privatePaths,
  sameSide,
  toProjectUri,
  remoteFsPromises,
  remotePathApi,
  remoteCall,
};
