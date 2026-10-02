/**
 * An in-memory stand-in for the remote fs `createRemoteFs()` returns, for the
 * session-history readers of claude.ipc.js.
 *
 * Files are held as Buffers under absolute POSIX paths. `listSessionFiles` is
 * a JS rendition of the shell listing in src/main/utils/remoteFs.js (the
 * newest files by mtime, `head -n` capped by bytes, and the title and
 * timestamp lines of the tail, numbered as awk numbers them); the real script
 * is checked against this rendition over a real sh in
 * tests/ipc/claudeRemoteHistory.test.js. Every `readRange` is recorded, so a
 * test can assert which bytes of a transcript were asked for.
 */

'use strict';

const path = require('path');
const { readLinesVia, SESSION_LISTING } = require('../../src/main/utils/remoteFs');

function enoent(p) {
  const error = new Error(`ENOENT: ${p}`);
  error.code = 'ENOENT';
  return error;
}

/** `head -n lines | head -c bytes` */
function headOf(data, lines, bytes) {
  let end = data.length;
  let seen = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0A && ++seen === lines) { end = i + 1; break; }
  }
  return data.subarray(0, Math.min(end, bytes));
}

/** What the awk filter of the listing prints for one file, as `{ n, text }`. */
function tailHints(data, opts) {
  const skip = data.length > opts.tailBytes;
  const tail = data.subarray(Math.max(0, data.length - opts.tailBytes)).toString('utf8');
  const records = tail.split('\n');
  if (records.length && records[records.length - 1] === '') records.pop();
  const hints = [];
  const ring = [];
  records.forEach((record, i) => {
    const n = i + 1;
    if (n === 1 && skip) return;
    if (opts.tailAll.some((p) => record.includes(p))) {
      hints.push({ n, text: record.replace(/\r$/, '') });
      return;
    }
    if (record.includes(opts.tailLast)) {
      ring.push({ n, text: record.replace(/\r$/, '') });
      if (ring.length > opts.tailLastCount) ring.shift();
    }
  });
  return [...hints, ...ring].sort((a, b) => a.n - b.n);
}

function createMemoryRemoteFs() {
  const files = new Map(); // path -> { data: Buffer, mtimeMs }
  const dirs = new Map();  // path -> mtimeMs
  const calls = { readRange: [], listSessionFiles: 0, rm: [] };

  function touchDir(dir, mtimeMs) {
    dirs.set(dir, mtimeMs);
  }

  function writeFile(p, content, mtimeMs) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    files.set(p, { data, mtimeMs });
    touchDir(path.posix.dirname(p), Math.max(dirs.get(path.posix.dirname(p)) || 0, mtimeMs));
  }

  async function stat(p) {
    if (files.has(p)) {
      const f = files.get(p);
      return { type: 'file', isFile: true, isDirectory: false, symlink: false, size: f.data.length, mtimeMs: f.mtimeMs };
    }
    if (dirs.has(p)) return { type: 'directory', isFile: false, isDirectory: true, symlink: false, size: 0, mtimeMs: dirs.get(p) };
    throw enoent(p);
  }

  async function readRange(p, start, length) {
    calls.readRange.push({ path: p, start, length });
    const f = files.get(p);
    if (!f) throw enoent(p);
    return Buffer.from(f.data.subarray(start, start + length));
  }

  async function listSessionFiles(dir, options = {}) {
    calls.listSessionFiles++;
    const opts = { ...SESSION_LISTING, ...options };
    if (!dirs.has(dir)) throw enoent(dir);
    const entries = [...files.entries()]
      .filter(([p]) => path.posix.dirname(p) === dir)
      .map(([p, f]) => ({ name: path.posix.basename(p), ...f }));
    const index = entries.find((e) => e.name === opts.indexFile);
    const listed = entries
      .filter((e) => e.name.endsWith('.jsonl'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, opts.maxFiles)
      .map((e) => {
        const head = headOf(e.data, opts.headLines, opts.headBytes);
        return {
          name: e.name,
          size: e.data.length,
          // `stat %Y`: whole seconds
          mtimeMs: Math.floor(e.mtimeMs / 1000) * 1000,
          head: head.toString('utf8'),
          headTruncated: head.length >= opts.headBytes,
          hints: tailHints(e.data, opts),
        };
      });
    return {
      dirMtimeMs: Math.floor(dirs.get(dir) / 1000) * 1000,
      index: index ? index.data.subarray(0, opts.indexBytes).toString('utf8') : null,
      files: listed,
    };
  }

  async function rm(p) {
    calls.rm.push(p);
    if (!files.delete(p)) throw enoent(p);
    touchDir(path.posix.dirname(p), Date.now());
  }

  return {
    files,
    calls,
    writeFile,
    touchDir,
    // the remote fs surface the readers use
    stat,
    readRange,
    readLines: (p, onLine, options) => readLinesVia(readRange, p, onLine, options),
    listSessionFiles,
    rm,
  };
}

module.exports = { createMemoryRemoteFs, headOf, tailHints };
