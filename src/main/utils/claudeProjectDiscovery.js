'use strict';

/**
 * The folders this machine already ran Claude Code in, for the first-launch
 * import (ProjectImportModal): someone who has used Claude Code before has
 * their history under `~/.claude/projects/<encoded cwd>/`, and a fresh profile
 * here would otherwise open on an empty project list.
 *
 * The directory name cannot be decoded: every character that is not a letter
 * or a digit became a dash (`session-dirs.encodeProjectPath`), so
 * `E--Perso-my-app` is `E:\Perso\my-app` or `E:\Perso\my\app` alike. The real
 * path is the `cwd` field the CLI writes on every message line, read from the
 * tail of the newest transcript (and from its head if the tail has none),
 * never more than TAIL_BYTES / HEAD_BYTES of a file.
 *
 * Kept: folders that still exist, are not the home folder itself, not a
 * temporary folder, not the folder the app is installed in, not inside this
 * app's data directory (parallel-run worktrees live there), and not a git
 * worktree (`.claude/worktrees/...`, or
 * any folder whose `.git` file points into a repository's `worktrees/`):
 * those belong to a project, they are not one.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 64 * 1024;
/** Transcripts of one directory tried, newest first, before giving it up. */
const FILES_PER_DIR = 3;

const isWin = process.platform === 'win32';

/** Comparable form of a local path: resolved, no trailing separator, case-folded on Windows. */
function pathKey(p) {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  return isWin ? resolved.toLowerCase() : resolved;
}

function isInside(child, parent) {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c === p || c.startsWith(p + path.sep) || (isWin && c.startsWith(p + '/'));
}

/**
 * Read `length` bytes at `position`, or less at the end of the file.
 * @returns {Promise<string>}
 */
async function readSlice(filePath, position, length) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * The cwd and last message time of one transcript, reading its tail first.
 * The last lines carry the cwd the file is filed under now, since the CLI
 * moves a transcript when its session's cwd changes.
 * @returns {Promise<{ cwd: string|null, lastActivity: number|null }>}
 */
async function readTranscriptCwd(filePath, size) {
  let cwd = null;
  let lastActivity = null;

  const scan = (text, { fromEnd, dropFirst }) => {
    const lines = text.split('\n');
    if (dropFirst) lines.shift(); // started mid-line
    if (!fromEnd) lines.pop(); // may stop mid-line
    if (fromEnd) lines.reverse();
    for (const line of lines) {
      if (cwd && lastActivity) return;
      if (!line.includes('"cwd"') && !line.includes('"timestamp"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof obj.cwd === 'string' && obj.cwd) cwd = obj.cwd;
      if (!lastActivity && fromEnd && obj.timestamp) {
        const ms = Date.parse(obj.timestamp);
        if (Number.isFinite(ms)) lastActivity = ms;
      }
    }
  };

  try {
    const start = Math.max(0, size - TAIL_BYTES);
    scan(await readSlice(filePath, start, Math.min(size, TAIL_BYTES)), { fromEnd: true, dropFirst: start > 0 });
    if (!cwd && size > TAIL_BYTES) {
      scan(await readSlice(filePath, 0, HEAD_BYTES), { fromEnd: false, dropFirst: false });
    }
  } catch { /* unreadable transcript: no cwd */ }
  return { cwd, lastActivity };
}

/** A linked git worktree: `.git` is a file pointing into `<common>/worktrees/<name>`. */
async function isLinkedWorktree(dir) {
  try {
    const content = await fs.promises.readFile(path.join(dir, '.git'), 'utf8');
    return /^gitdir:.*[\\/]worktrees[\\/][^\\/]+\s*$/m.test(content);
  } catch {
    return false; // a directory, or no .git at all
  }
}

/**
 * Why a cwd is not offered, or null when it is.
 * @returns {Promise<string|null>}
 */
async function exclusionReason(cwd, { home, appDataDir, tmpDir, appInstallDir }) {
  if (!path.isAbsolute(cwd)) return 'relative';
  if (pathKey(cwd) === pathKey(home)) return 'home';
  if (isInside(cwd, appDataDir)) return 'app-data';
  if (isInside(cwd, tmpDir)) return 'temp';
  // The app's own folder: the cwd a session falls back to when it has none.
  if (appInstallDir && isInside(cwd, appInstallDir)) return 'app-install';
  if (/[\\/]\.claude[\\/]worktrees([\\/]|$)/i.test(cwd)) return 'worktree';
  try {
    const stat = await fs.promises.stat(cwd);
    if (!stat.isDirectory()) return 'missing';
  } catch {
    return 'missing';
  }
  if (await isLinkedWorktree(cwd)) return 'worktree';
  return null;
}

/**
 * The folders Claude Code was used in on this machine, most recent first.
 *
 * @param {{ home?: string, tmpDir?: string, appInstallDir?: string, exclude?: string[] }} [opts]
 *   `exclude`: paths already registered as projects, left out
 * @returns {Promise<Array<{ path: string, name: string, lastActivity: number, sessionCount: number }>>}
 */
async function discoverClaudeProjectFolders({
  home = os.homedir(),
  tmpDir = os.tmpdir(),
  appInstallDir = path.dirname(process.execPath),
  exclude = [],
} = {}) {
  const root = path.join(home, '.claude', 'projects');
  const context = {
    home,
    appDataDir: path.join(home, '.claude-terminal'),
    tmpDir,
    appInstallDir,
  };
  const excluded = new Set(exclude.filter(p => typeof p === 'string' && p).map(pathKey));

  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return []; // never used Claude Code here
    throw err;
  }

  const byPath = new Map();
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);

    let transcripts = [];
    try {
      const names = (await fs.promises.readdir(dir)).filter(n => n.endsWith('.jsonl'));
      for (const name of names) {
        try {
          const stat = await fs.promises.stat(path.join(dir, name));
          if (stat.isFile() && stat.size > 0) transcripts.push({ file: path.join(dir, name), size: stat.size, mtime: stat.mtimeMs });
        } catch { /* gone since the listing */ }
      }
    } catch { continue; }
    if (!transcripts.length) continue;
    transcripts.sort((a, b) => b.mtime - a.mtime);

    let found = null;
    for (const t of transcripts.slice(0, FILES_PER_DIR)) {
      const { cwd, lastActivity } = await readTranscriptCwd(t.file, t.size);
      if (cwd) { found = { cwd, lastActivity: lastActivity || t.mtime }; break; }
    }
    if (!found) continue;

    const key = pathKey(found.cwd);
    if (excluded.has(key)) continue;
    const previous = byPath.get(key);
    if (previous) {
      // Two directories can resolve to one folder (a path renamed back, two
      // spellings of a drive letter): one row, both counts.
      previous.sessionCount += transcripts.length;
      previous.lastActivity = Math.max(previous.lastActivity, found.lastActivity);
      continue;
    }
    if (await exclusionReason(found.cwd, context)) continue;
    byPath.set(key, {
      path: found.cwd,
      name: path.basename(found.cwd.replace(/[\\/]+$/, '')) || found.cwd,
      lastActivity: found.lastActivity,
      sessionCount: transcripts.length,
    });
  }

  return [...byPath.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

module.exports = {
  discoverClaudeProjectFolders,
  readTranscriptCwd,
  _internals: { exclusionReason, isLinkedWorktree, pathKey },
};
