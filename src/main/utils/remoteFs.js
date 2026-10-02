/**
 * File-system operations on a remote host, as one-line scripts over the
 * command channel (design/remote-ssh.md sections 4.2 and 5.5).
 *
 * This is the main-process adapter later slices build on: the directory
 * browser of the Open Remote Project flow, the `ssh.fs` IPC, session history
 * readers and the explorer poller. It takes absolute POSIX paths and does no
 * containment checking of its own: callers resolve and authorise a path with
 * `projectTarget` first, and the remote blocklist (`isBlockedRemotePath`) is
 * exported here so every caller applies the same one.
 *
 * Every user value reaches the remote shell through `q()` as a positional
 * parameter (`set -- <q(path)>`), and every path operand follows `--`.
 *
 * Errors are thrown as Error objects with a Node-like `code`: ENOENT, ENOTDIR,
 * EISDIR, EEXIST, EACCES, ETOOLARGE, or EREMOTE with a `reason` of
 * 'disconnected' | 'timeout' | 'cancelled' | 'maxbuffer' when the transport,
 * not the file system, failed.
 */

'use strict';

const crypto = require('crypto');
const { q, assertOneLine } = require('../../shared/remote-shell');

/** Writes up to this size travel inline over the channel; larger ones use a one-shot exec. */
const PUT_LIMIT = 256 * 1024;
const DEFAULT_READ_LIMIT = 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5000;
const LIST_MAX_BYTES = 4 * 1024 * 1024;

const EXIT_CODES = { 2: 'ENOENT', 3: 'ENOTDIR', 4: 'EISDIR', 13: 'EACCES', 17: 'EEXIST' };

const TYPE_NAMES = { f: 'file', d: 'directory', l: 'symlink', ld: 'directory', o: 'other' };

function fsError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function assertAbsolute(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) throw fsError('EINVAL', 'Remote path must be absolute');
  q(p); // throws on control characters
  return p;
}

/** Turn a channel result into either its stdout or a thrown, classified error. */
function unwrap(result, what) {
  if (result.reason) {
    throw fsError('EREMOTE', `Remote ${what} failed: ${result.reason}`, { reason: result.reason });
  }
  if (result.ok) return result;
  const mapped = EXIT_CODES[result.code];
  const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
  if (mapped) throw fsError(mapped, `${mapped}: remote ${what}${stderr ? ` (${stderr})` : ''}`);
  throw fsError('EREMOTEFAIL', `Remote ${what} failed with exit code ${result.code}${stderr ? `: ${stderr}` : ''}`, { exitCode: result.code });
}

/**
 * Paths a remote write must never touch, and reads of the credential files,
 * mirroring the local renderer blocklist (design section 5.5).
 *
 * @param {string} p      absolute, normalised POSIX path
 * @param {string} home   the remote $HOME from the handshake
 * @param {'read'|'write'} access
 */
function isBlockedRemotePath(p, home, access) {
  if (!home || typeof p !== 'string') return false;
  const h = home.replace(/\/+$/, '');
  const under = (root) => p === root || p.startsWith(root + '/');
  if (under(`${h}/.ssh`)) return true;
  if (under(`${h}/.claude/.credentials.json`)) return true;
  if (access === 'write') {
    const rc = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin',
      '.kshrc', '.cshrc', '.tcshrc', '.login', '.config/fish', '.gnupg', '.aws', '.netrc', '.pam_environment'];
    if (rc.some((name) => under(`${h}/${name}`))) return true;
  }
  return false;
}

/** Shell fragment classifying "$f" into one of f, d, l, ld, o in `$t`. */
const CLASSIFY = 'if [ -L "$f" ]; then if [ -d "$f" ]; then t=ld; else t=l; fi; elif [ -d "$f" ]; then t=d; elif [ -f "$f" ]; then t=f; else t=o; fi';

/** Shell fragment: replace "$@" with the existing entries of the current directory, hidden ones included. */
const GLOB_ENTRIES = 'set -- .[!.]* ..?* *; for f do shift; if [ -e "$f" ] || [ -L "$f" ]; then set -- "$@" "$f"; fi; done';

function cdOrFail(dir, { physical = false } = {}) {
  const flag = physical ? '-P ' : '';
  return `cd ${flag}-- ${q(dir)} 2>/dev/null || { if [ -e ${q(dir)} ]; then exit 3; fi; exit 2; }`;
}

function parseStatLines(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [size, mtime] = line.trim().split(/\s+/);
    return {
      size: /^\d+$/.test(size) ? Number(size) : null,
      mtimeMs: /^\d+$/.test(mtime) ? Number(mtime) * 1000 : null,
    };
  });
}

/** Parse "<type>/<name>\0 ... \0\0<stat lines>" into entries. */
function parseListing(buffer, maxEntries) {
  const text = buffer.toString('utf8');
  const end = text.indexOf('\0\0');
  const head = end === -1 ? text : text.slice(0, end + 1);
  const tail = end === -1 ? '' : text.slice(end + 2);
  const records = head.split('\0').filter(Boolean);
  const stats = parseStatLines(tail);
  const aligned = stats.length === records.length;
  const entries = [];
  for (let i = 0; i < records.length && entries.length < maxEntries; i++) {
    const slash = records[i].indexOf('/');
    if (slash === -1) continue;
    const code = records[i].slice(0, slash);
    const name = records[i].slice(slash + 1);
    if (!name || name === '.' || name === '..') continue;
    entries.push({
      name,
      type: TYPE_NAMES[code] || 'other',
      symlink: code === 'l' || code === 'ld',
      size: aligned ? stats[i].size : null,
      mtimeMs: aligned ? stats[i].mtimeMs : null,
    });
  }
  return { entries, truncated: records.length > maxEntries };
}

/** A literal string as a POSIX basic regular expression. */
function escapeBre(text) {
  return text.replace(/[\\.[\]*^$]/g, '\\$&');
}

function randomSuffix() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * @param {object} runner
 * @param {(script: string, opts?: object) => Promise<object>} runner.exec      channel request
 * @param {(script: string, opts?: object) => Promise<object>} [runner.oneShot] one-shot exec with stdin
 */
function createRemoteFs(runner) {
  if (!runner || typeof runner.exec !== 'function') throw new Error('createRemoteFs needs an exec function');
  const exec = (script, opts) => runner.exec(assertOneLine(script), opts);

  async function stat(p, { follow = true } = {}) {
    assertAbsolute(p);
    const st = follow ? 'ct_statL "$f" 2>/dev/null || ct_stat "$f" 2>/dev/null' : 'ct_stat "$f" 2>/dev/null';
    const script = `f=${q(p)}; [ -e "$f" ] || [ -L "$f" ] || exit 2; ${CLASSIFY}; printf '%s\\n' "$t"; ${st} || echo '- -'`;
    const res = unwrap(await exec(script, { timeoutMs: 10000 }), 'stat');
    const [code, statLine = ''] = res.stdout.toString('utf8').split('\n');
    const [{ size, mtimeMs } = {}] = parseStatLines(statLine);
    const type = TYPE_NAMES[code] || 'other';
    return {
      type,
      symlink: code === 'l' || code === 'ld',
      size: size ?? null,
      mtimeMs: mtimeMs ?? null,
      isFile: type === 'file',
      isDirectory: type === 'directory',
    };
  }

  async function exists(p) {
    try { await stat(p, { follow: false }); return true; } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  }

  /** Names, types, sizes and mtimes of a directory in one round trip. */
  async function readdir(dir, { maxEntries = DEFAULT_MAX_ENTRIES, timeoutMs = 15000 } = {}) {
    assertAbsolute(dir);
    const script = [
      cdOrFail(dir),
      GLOB_ENTRIES,
      `for f do ${CLASSIFY}; printf '%s/%s\\0' "$t" "$f"; done`,
      "printf '\\0'",
      'if [ $# -gt 0 ]; then ct_stat "$@" 2>/dev/null; fi',
      ':',
    ].join('; ');
    const res = unwrap(await exec(script, { timeoutMs, maxBuffer: LIST_MAX_BYTES }), 'readdir');
    return parseListing(res.stdout, maxEntries).entries;
  }

  /**
   * Directories only, for the Open Remote Project browser: canonical path of
   * `dir` (or of $HOME when `dir` is empty) and its subdirectories. Never reads
   * a file's contents.
   */
  async function listDirectories(dir, { maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    const cd = dir ? cdOrFail(assertAbsolute(dir), { physical: true }) : 'cd -P -- "$HOME" 2>/dev/null || exit 2';
    const script = [
      cd,
      'pwd -P',
      "printf '\\0'",
      GLOB_ENTRIES,
      `for f do if [ -d "$f" ]; then if [ -L "$f" ]; then t=ld; else t=d; fi; printf '%s/%s\\0' "$t" "$f"; fi; done`,
      "printf '\\0'",
      ':',
    ].join('; ');
    const res = unwrap(await exec(script, { timeoutMs: 15000, maxBuffer: LIST_MAX_BYTES }), 'browse');
    const text = res.stdout;
    const sep = text.indexOf(0);
    const canonical = text.subarray(0, sep === -1 ? text.length : sep).toString('utf8').replace(/\n$/, '');
    const { entries, truncated } = parseListing(text.subarray(sep + 1), maxEntries);
    return {
      path: canonical,
      entries: entries.filter((e) => e.type === 'directory').map((e) => ({ name: e.name, type: 'directory', symlink: e.symlink })),
      truncated,
    };
  }

  /** Canonical path of an existing directory (`cd -P && pwd -P`). */
  async function realpathDir(dir) {
    assertAbsolute(dir);
    const res = unwrap(await exec(`${cdOrFail(dir, { physical: true })}; pwd -P`, { timeoutMs: 10000 }), 'realpath');
    return res.stdout.toString('utf8').replace(/\n$/, '');
  }

  /** Read a file, capped at `maxBytes`. */
  async function readFile(p, { maxBytes = DEFAULT_READ_LIMIT, timeoutMs = 30000 } = {}) {
    assertAbsolute(p);
    const cap = Math.max(0, Math.floor(maxBytes));
    const script = `f=${q(p)}; [ -e "$f" ] || exit 2; [ -d "$f" ] && exit 4; [ -r "$f" ] || exit 13; printf '%s\\n' "$(( $(wc -c <"$f") ))"; head -c ${cap} "$f"`;
    const res = unwrap(await exec(script, { timeoutMs, maxBuffer: cap + 64 }), 'read');
    const nl = res.stdout.indexOf(10);
    const size = Number(res.stdout.subarray(0, nl).toString('latin1'));
    const data = Buffer.from(res.stdout.subarray(nl + 1));
    return { data, size, truncated: size > data.length };
  }

  /** `length` bytes starting at byte `start`. */
  async function readRange(p, start, length, { timeoutMs = 30000 } = {}) {
    assertAbsolute(p);
    const from = Math.max(0, Math.floor(start));
    const len = Math.max(0, Math.floor(length));
    const script = `f=${q(p)}; [ -e "$f" ] || exit 2; [ -d "$f" ] && exit 4; tail -c +${from + 1} "$f" | head -c ${len}`;
    const res = unwrap(await exec(script, { timeoutMs, maxBuffer: len + 64 }), 'read');
    return Buffer.from(res.stdout);
  }

  /**
   * Write a file atomically (temp file + mv) in the target's directory. An
   * existing file's mode is kept by copying it first; a symlink is written
   * through, in place, rather than replaced by a regular file.
   */
  async function writeFile(p, data, { timeoutMs = 60000 } = {}) {
    assertAbsolute(p);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const tmp = `${p}.ct-tmp-${randomSuffix()}`;
    const script = [
      `f=${q(p)}`,
      `t=${q(tmp)}`,
      'd=$(dirname -- "$f")',
      '[ -d "$d" ] || exit 2',
      '[ -d "$f" ] && exit 4',
      'if [ -L "$f" ]; then cat >"$f"; exit $?; fi',
      'if [ -e "$f" ]; then cp -p -- "$f" "$t" 2>/dev/null || :; fi',
      'if cat >"$t" && mv -f -- "$t" "$f"; then exit 0; fi',
      'rm -f -- "$t"',
      'exit 1',
    ].join('; ');
    if (buf.length <= PUT_LIMIT) {
      unwrap(await runner.exec(script, { timeoutMs, input: buf, write: true }), 'write');
      return { bytes: buf.length };
    }
    if (typeof runner.oneShot !== 'function') throw fsError('ETOOLARGE', 'File is too large to write over the channel');
    unwrap(await runner.oneShot(script, { timeoutMs, input: buf }), 'write');
    return { bytes: buf.length };
  }

  async function mkdir(p, { recursive = true } = {}) {
    assertAbsolute(p);
    const script = recursive
      ? `f=${q(p)}; if [ -e "$f" ] && [ ! -d "$f" ]; then exit 17; fi; mkdir -p -- "$f"`
      : `f=${q(p)}; [ -e "$f" ] && exit 17; mkdir -- "$f"`;
    unwrap(await exec(script, { timeoutMs: 10000, write: true }), 'mkdir');
  }

  async function rm(p, { recursive = false } = {}) {
    assertAbsolute(p);
    if (p === '/' || /^\/+$/.test(p)) throw fsError('EPERM', 'Refusing to remove the remote root');
    const script = `f=${q(p)}; [ -e "$f" ] || [ -L "$f" ] || exit 2; rm ${recursive ? '-rf' : '-f'} -- "$f"`;
    unwrap(await exec(script, { timeoutMs: 60000, write: true }), 'rm');
  }

  async function rename(from, to) {
    assertAbsolute(from); assertAbsolute(to);
    const script = `a=${q(from)}; b=${q(to)}; [ -e "$a" ] || [ -L "$a" ] || exit 2; [ -d "$b" ] && exit 17; mv -f -- "$a" "$b"`;
    unwrap(await exec(script, { timeoutMs: 30000, write: true }), 'rename');
  }

  async function copy(from, to) {
    assertAbsolute(from); assertAbsolute(to);
    const script = `a=${q(from)}; b=${q(to)}; [ -e "$a" ] || exit 2; [ -e "$b" ] && exit 17; cp -pR -- "$a" "$b"`;
    unwrap(await exec(script, { timeoutMs: 120000, write: true }), 'copy');
  }

  /** Every file under `root`, relative: `git ls-files` in a work tree, `find` otherwise. */
  async function listFiles(root, { maxBytes = LIST_MAX_BYTES } = {}) {
    assertAbsolute(root);
    const cap = Math.max(1, Math.floor(maxBytes));
    const script = [
      cdOrFail(root),
      `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -co --exclude-standard -z 2>/dev/null; else find . -type f -print0 2>/dev/null; fi | head -c ${cap}`,
    ].join('; ');
    const res = unwrap(await exec(script, { timeoutMs: 30000, maxBuffer: cap + 64 }), 'list');
    const parts = res.stdout.toString('utf8').split('\0');
    const truncated = res.stdout.length >= cap;
    if (truncated) parts.pop(); // last record may be cut
    return {
      files: parts.filter(Boolean).map((f) => f.replace(/^\.\//, '')),
      truncated,
    };
  }

  /** Content search, capped: `git grep` in a work tree, `grep -r` otherwise. */
  async function grep(root, pattern, { ignoreCase = true, fixed = true, maxCount = 3, maxBytes = 512 * 1024 } = {}) {
    assertAbsolute(root);
    if (typeof pattern !== 'string' || !pattern) throw fsError('EINVAL', 'Search pattern is required');
    const cap = Math.max(1, Math.floor(maxBytes));
    const n = Math.max(1, Math.floor(maxCount));
    const flags = `${ignoreCase ? ' -i' : ''}${fixed ? ' -F' : ' -E'}`;
    // Some GNU grep builds (3.0, as shipped with Git for Windows) abort on
    // `-i -F` together, so a case-insensitive fixed string is sent to plain
    // grep as an escaped basic regex instead. git grep has its own engine.
    const grepFallback = fixed && ignoreCase
      ? `grep -rnI -i -m ${n} -e ${q(escapeBre(pattern))} . 2>/dev/null`
      : `grep -rnI${flags} -m ${n} -e ${q(pattern)} . 2>/dev/null`;
    const script = [
      cdOrFail(root),
      `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git grep -n -I --untracked${flags} --max-count=${n} -e ${q(pattern)} 2>/dev/null; else ${grepFallback}; fi | head -c ${cap}`,
    ].join('; ');
    const res = unwrap(await exec(script, { timeoutMs: 30000, maxBuffer: cap + 64 }), 'grep');
    const lines = res.stdout.toString('utf8').split('\n');
    const truncated = res.stdout.length >= cap;
    if (truncated) lines.pop();
    const matches = [];
    for (const line of lines) {
      const m = /^(.+?):(\d+):(.*)$/.exec(line);
      if (m) matches.push({ file: m[1].replace(/^\.\//, ''), line: Number(m[2]), text: m[3] });
    }
    return { matches, truncated };
  }

  return {
    stat, exists, readdir, listDirectories, realpathDir, readFile, readRange,
    writeFile, mkdir, rm, rename, copy, listFiles, grep,
  };
}

module.exports = {
  createRemoteFs,
  isBlockedRemotePath,
  parseListing,
  PUT_LIMIT,
};
