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

// ── Line walks and session listings (design/remote-ssh.md section 5.3) ──────

/** Forward line walks read this much per round trip. */
const READ_LINES_CHUNK = 1024 * 1024;

/** A line as `readline` (crlfDelay: Infinity) would hand it over: no `\r` before the break. */
function decodeLine(buf) {
  const end = buf.length > 0 && buf[buf.length - 1] === 0x0D ? buf.length - 1 : buf.length;
  return buf.toString('utf8', 0, end);
}

/**
 * Walk a file's lines from the start through any `readRange(p, start, length)`,
 * one chunk per call, the way `readline` walks a local stream: a line that
 * spans two chunks is joined before it is decoded (so a multi-byte character
 * is never cut), an empty line is handed over as '', and the last line is
 * handed over even without a final newline. `onLine` returning true stops the
 * walk.
 *
 * @param {(p: string, start: number, length: number) => Promise<Buffer>} readRange
 * @param {string} p
 * @param {(line: string) => boolean|void} onLine
 * @param {{chunkBytes?: number}} [options]
 */
async function readLinesVia(readRange, p, onLine, { chunkBytes = READ_LINES_CHUNK } = {}) {
  const size = Math.max(1, Math.floor(chunkBytes));
  let position = 0;
  let pending = [];
  let pendingLen = 0;
  for (;;) {
    const chunk = await readRange(p, position, size);
    if (!chunk || chunk.length === 0) break;
    position += chunk.length;
    let start = 0;
    let idx = chunk.indexOf(0x0A, start);
    while (idx !== -1) {
      let line = chunk.subarray(start, idx);
      if (pendingLen > 0) {
        line = Buffer.concat([...pending, line], pendingLen + line.length);
        pending = [];
        pendingLen = 0;
      }
      if (onLine(decodeLine(line)) === true) return;
      start = idx + 1;
      idx = chunk.indexOf(0x0A, start);
    }
    if (start < chunk.length) {
      pending.push(chunk.subarray(start));
      pendingLen += chunk.length - start;
    }
    if (chunk.length < size) break;
  }
  if (pendingLen > 0) onLine(decodeLine(Buffer.concat(pending, pendingLen)));
}

/**
 * What one session listing request collects per transcript.
 *
 * - `maxFiles` newest `*.jsonl` by mtime (`ls -t`). A listing shows the fifty
 *   most recent sessions, so the head of the mtime order is all it can use.
 * - `headLines` / `headBytes`: the start of each file, where the first prompt,
 *   the session id and the sidechain flag are. A head cut by the byte cap is
 *   reported so the reader drops its partial last line.
 * - `tailBytes`: the end of each file, filtered on the host. Every line
 *   containing one of `tailAll` (the title lines) and the last `tailLastCount`
 *   lines containing `tailLast` (the timestamped ones) are sent with their
 *   line number, which is all a title-and-last-activity scan of the tail looks
 *   at. The first line of a tail that does not start at the beginning of the
 *   file is cut in half and is skipped, as the local tail read skips it.
 * - `indexFile` / `indexBytes`: the CLI's sessions-index.json, when present.
 */
const SESSION_LISTING = Object.freeze({
  maxFiles: 150,
  headLines: 30,
  headBytes: 64 * 1024,
  tailBytes: 128 * 1024,
  tailAll: Object.freeze(['-title"']),
  tailLast: '"timestamp"',
  tailLastCount: 3,
  indexFile: 'sessions-index.json',
  indexBytes: 2 * 1024 * 1024,
  timeoutMs: 30000,
  maxBuffer: 16 * 1024 * 1024,
});

/** A fixed string for an awk `index()` call, as an awk -v assignment. */
function awkVar(name, value) {
  if (typeof value !== 'string' || !value || value.includes('\\')) throw fsError('EINVAL', 'Listing patterns must be non-empty and free of backslashes');
  return `-v ${name}=${q(value)}`;
}

function intOption(value, name) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) throw fsError('EINVAL', `Invalid listing option: ${name}`);
  return n;
}

/** The one-line script behind listSessionFiles. */
function sessionListingScript(dir, opts) {
  const maxFiles = intOption(opts.maxFiles, 'maxFiles');
  const headLines = intOption(opts.headLines, 'headLines');
  const headBytes = intOption(opts.headBytes, 'headBytes');
  const tailBytes = intOption(opts.tailBytes, 'tailBytes');
  const lastCount = intOption(opts.tailLastCount, 'tailLastCount');
  const indexBytes = intOption(opts.indexBytes, 'indexBytes');
  const tailAll = Array.isArray(opts.tailAll) ? opts.tailAll : [];
  const vars = [awkVar('pl', opts.tailLast), ...tailAll.map((p, i) => awkVar(`pa${i}`, p))];
  const allTest = tailAll.length ? tailAll.map((_, i) => `index($0,pa${i})>0`).join('||') : '0';
  const awk = [
    'NR==1&&sk==1{next}',
    `${allTest}{print NR "\\t" $0; next}`,
    `index($0,pl)>0{c++; r[c%${lastCount}]=NR "\\t" $0}`,
    'END{for(i in r) print r[i]}',
  ].join(' ');
  if (opts.indexFile && !/^[A-Za-z0-9._-]+$/.test(opts.indexFile)) throw fsError('EINVAL', 'Invalid index file name');
  const index = opts.indexFile
    ? `if [ -f ${q('./' + opts.indexFile)} ]; then head -c ${indexBytes} ${q('./' + opts.indexFile)} 2>/dev/null | tr -d '\\000'; fi`
    : ':';
  const perFile = [
    '[ -f "./$f" ] || continue',
    'sz=$(( $(wc -c <"./$f") ))',
    'set -- $(ct_stat "./$f" 2>/dev/null)',
    'mt=$2',
    '[ -n "$mt" ] || mt=-',
    "printf '%s\\0%s %s\\0' \"$f\" \"$sz\" \"$mt\"",
    `head -n ${headLines} "./$f" 2>/dev/null | tr -d '\\000' | head -c ${headBytes}`,
    "printf '\\0'",
    `if [ "$sz" -gt ${tailBytes} ]; then sk=1; else sk=0; fi`,
    `tail -c ${tailBytes} "./$f" 2>/dev/null | tr -d '\\000' | awk -v sk="$sk" ${vars.join(' ')} ${q(awk)}`,
    "printf '\\0'",
  ].join('; ');
  return [
    cdOrFail(dir),
    "s=$(ct_stat . 2>/dev/null) || s='- -'",
    "printf '%s\\0' \"$s\"",
    index,
    "printf '\\0'",
    `ls -t 2>/dev/null | grep -e '\\.jsonl$' | head -n ${maxFiles} | while IFS= read -r f; do ${perFile}; done`,
    ':',
  ].join('; ');
}

/**
 * Parse the listing output: `<dir stat>\0<index>\0` then, per file,
 * `<name>\0<size> <mtime>\0<head>\0<tail hints>\0`.
 *
 * @param {Buffer} buffer
 * @param {object} [opts]
 * @returns {{dirMtimeMs: number|null, index: string|null, files: Array<{name: string, size: number|null, mtimeMs: number|null, head: string, headTruncated: boolean, hints: Array<{n: number, text: string}>}>}}
 */
function parseSessionListing(buffer, opts = SESSION_LISTING) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      parts.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  const text = (b) => (b ? b.toString('utf8') : '');
  const [dirStat] = parseStatLines(text(parts[0]));
  const indexText = parts.length > 1 ? text(parts[1]) : '';
  const headCap = opts.headBytes || SESSION_LISTING.headBytes;
  const files = [];
  for (let i = 2; i + 3 < parts.length; i += 4) {
    const name = text(parts[i]);
    if (!name) continue;
    const [{ size = null, mtimeMs = null } = {}] = parseStatLines(text(parts[i + 1]));
    const headBuf = parts[i + 2];
    const hints = [];
    for (const raw of text(parts[i + 3]).split('\n')) {
      const tab = raw.indexOf('\t');
      if (tab <= 0) continue;
      const n = Number(raw.slice(0, tab));
      if (!Number.isInteger(n)) continue;
      hints.push({ n, text: raw.slice(tab + 1).replace(/\r$/, '') });
    }
    hints.sort((a, b) => a.n - b.n);
    files.push({ name, size, mtimeMs, head: text(headBuf), headTruncated: headBuf.length >= headCap, hints });
  }
  return {
    dirMtimeMs: dirStat ? dirStat.mtimeMs : null,
    index: indexText || null,
    files,
  };
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

  /**
   * Read a file, capped at `maxBytes`. `oneShot` sends the transfer through a
   * one-shot exec instead of a channel lane, for files over PUT_LIMIT: a lane
   * busy streaming a large file would hold up every request queued behind it.
   */
  async function readFile(p, { maxBytes = DEFAULT_READ_LIMIT, timeoutMs = 30000, oneShot = false } = {}) {
    assertAbsolute(p);
    const cap = Math.max(0, Math.floor(maxBytes));
    const script = `f=${q(p)}; [ -e "$f" ] || exit 2; [ -d "$f" ] && exit 4; [ -r "$f" ] || exit 13; printf '%s\\n' "$(( $(wc -c <"$f") ))"; head -c ${cap} "$f"`;
    const viaOneShot = oneShot && typeof runner.oneShot === 'function';
    const raw = viaOneShot
      ? await runner.oneShot(assertOneLine(script), { timeoutMs, maxBuffer: cap + 64 })
      : await exec(script, { timeoutMs, maxBuffer: cap + 64 });
    const res = unwrap(raw, 'read');
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

  /** Walk a file's lines forward, in chunks of `chunkBytes` (see readLinesVia). */
  function readLines(p, onLine, options) {
    assertAbsolute(p);
    return readLinesVia(readRange, p, onLine, options);
  }

  /**
   * One request describing every transcript of a sessions directory: what a
   * session listing needs from each file without reading any of them whole.
   * See SESSION_LISTING for the shape; a missing directory throws ENOENT.
   */
  async function listSessionFiles(dir, options = {}) {
    assertAbsolute(dir);
    const opts = { ...SESSION_LISTING, ...options };
    const res = unwrap(await exec(sessionListingScript(dir, opts), { timeoutMs: opts.timeoutMs, maxBuffer: opts.maxBuffer }), 'session listing');
    return parseSessionListing(res.stdout, opts);
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

  /**
   * Canonical forms of several paths in one request, for the containment and
   * blocklist checks of the `ssh.fs` IPC (design/remote-ssh.md section 5.5).
   *
   * For each path: `canonical` is `cd -P && pwd -P` of its nearest existing
   * ancestor directory with the rest of the path appended, so a path that does
   * not exist yet still canonicalises through every symlink above it; `link`
   * is null when the path itself is not a symlink, its `realpath` when it is,
   * and '?' when that cannot be resolved (dangling, or no `realpath` on the
   * host). `home` is the canonical $HOME, since a blocklist written against
   * $HOME misses ~/.ssh reached through a symlinked home.
   *
   * @param {string[]} paths absolute POSIX paths
   * @param {{write?: boolean, timeoutMs?: number}} [options] `write` makes the
   *        request fail fast while the host is not connected, like the write it guards
   * @returns {Promise<{home: string|null, entries: Array<{canonical: string|null, link: string|null}>}>}
   */
  async function canonicalize(paths, { write = false, timeoutMs = 10000 } = {}) {
    if (!Array.isArray(paths) || paths.length === 0) throw fsError('EINVAL', 'canonicalize needs at least one path');
    for (const p of paths) assertAbsolute(p);
    const script = [
      `ct_canon() { p=$1; s=; while [ ! -d "$p" ]; do s="/\${p##*/}$s"; p=\${p%/*}; [ -n "$p" ] || p=/; done; c=$(cd -P -- "$p" 2>/dev/null && pwd -P) || c=; printf '%s\\t%s\\n' "$c" "$s"; }`,
      `ct_link() { if [ -L "$1" ]; then r=$(realpath -- "$1" 2>/dev/null) || r=; printf '%s\\n' "\${r:-?}"; else printf '\\n'; fi; }`,
      "h=$(cd -P -- \"$HOME\" 2>/dev/null && pwd -P) || h=",
      "printf '%s\\n' \"$h\"",
      `for f in ${paths.map((p) => q(p)).join(' ')}; do ct_canon "$f"; ct_link "$f"; done`,
      ':',
    ].join('; ');
    const res = unwrap(await exec(script, { timeoutMs, write }), 'canonicalize');
    const lines = res.stdout.toString('utf8').split('\n');
    // A canonical path with a newline in it (a symlink target can hold one)
    // would shift every line after it: refuse rather than misread.
    if (lines.length !== paths.length * 2 + 2) throw fsError('EREMOTEFAIL', 'Remote canonicalize answered in an unexpected shape');
    const clean = (value) => {
      if (!value || !value.startsWith('/')) return null;
      try { return normalizeAbsolute(value); } catch { return null; }
    };
    const entries = [];
    for (let i = 0; i < paths.length; i++) {
      const canonLine = lines[1 + i * 2];
      const linkLine = lines[2 + i * 2];
      if (canonLine === undefined || linkLine === undefined) throw fsError('EREMOTEFAIL', 'Remote canonicalize answered short');
      // The appended part comes from a q()-checked path and holds no tab.
      const tab = canonLine.lastIndexOf('\t');
      const base = tab === -1 ? canonLine : canonLine.slice(0, tab);
      const rest = tab === -1 ? '' : canonLine.slice(tab + 1);
      entries.push({
        canonical: base ? clean(base + rest) : null,
        link: linkLine === '' ? null : (linkLine === '?' ? '?' : (clean(linkLine) || '?')),
      });
    }
    return { home: clean(lines[0]), entries };
  }

  /**
   * One listing of several directories, for the explorer poller: the names
   * and kinds of every entry of each directory (hidden ones included), in a
   * single request however many directories are expanded. A directory that
   * is gone or unreadable is reported as `missing`.
   *
   * @param {string[]} dirs absolute POSIX paths
   * @returns {Promise<Map<string, {missing: boolean, entries: Array<{name: string, isDirectory: boolean}>}>>}
   */
  async function listDirs(dirs, { timeoutMs = 15000, maxBytes = LIST_MAX_BYTES } = {}) {
    if (!Array.isArray(dirs) || dirs.length === 0) return new Map();
    for (const d of dirs) assertAbsolute(d);
    const script = [
      `for d in ${dirs.map((d) => q(d)).join(' ')}; do printf '%s\\0' "$d"; if cd -- "$d" 2>/dev/null; then ${GLOB_ENTRIES}; for f do if [ -d "$f" ]; then printf 'd/%s\\0' "$f"; else printf 'f/%s\\0' "$f"; fi; done; else printf 'x/\\0'; fi; printf '\\0'; done`,
      ':',
    ].join('; ');
    const res = unwrap(await exec(script, { timeoutMs, maxBuffer: maxBytes }), 'list');
    const parts = res.stdout.toString('utf8').split('\0');
    const out = new Map();
    let i = 0;
    while (i < parts.length) {
      const dir = parts[i++];
      if (!dir) continue;
      const entry = { missing: false, entries: [] };
      while (i < parts.length && parts[i] !== '') {
        const rec = parts[i++];
        if (rec === 'x/') { entry.missing = true; continue; }
        const slash = rec.indexOf('/');
        if (slash === -1) continue;
        const name = rec.slice(slash + 1);
        if (!name || name === '.' || name === '..') continue;
        entry.entries.push({ name, isDirectory: rec.slice(0, slash) === 'd' });
      }
      i++; // the empty record closing this directory
      out.set(dir, entry);
    }
    return out;
  }

  return {
    stat, exists, readdir, listDirectories, realpathDir, readFile, readRange, readLines,
    listSessionFiles, writeFile, mkdir, rm, rename, copy, listFiles, grep, canonicalize, listDirs,
  };
}

/** Normalise an absolute POSIX path (collapse `//`, resolve `.` and `..`). */
function normalizeAbsolute(p) {
  return require('../../shared/remote-path').toPosix(p);
}

module.exports = {
  createRemoteFs,
  isBlockedRemotePath,
  parseListing,
  readLinesVia,
  sessionListingScript,
  parseSessionListing,
  SESSION_LISTING,
  PUT_LIMIT,
};
