'use strict';

/**
 * Where a project's transcripts live.
 *
 * Claude Code files a transcript under the directory encoding of the cwd it is
 * running in, and it re-files the whole file when that cwd changes. A session
 * that enters a worktree — `EnterWorktree`, or a worktree tab — therefore moves
 * out of the project's directory and into the worktree's, taking its history
 * with it. Reading only `getProjectSessionsDir(project.path)` made those
 * sessions disappear from the project they belong to, with no way back to them
 * from the app at all.
 *
 * So a project's sessions are the union of its own directory and the
 * directories of its worktrees, and every session carries the cwd it must be
 * resumed in.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Root of Claude Code's per-project transcript directories. */
function claudeProjectsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Encode a project path the way Claude Code names its transcript directory.
 * Every non-alphanumeric character becomes a dash, so the encoding is lossy and
 * cannot be reversed — a directory name only ever tells you what a path would
 * encode to, never what the path was.
 *
 * @param {string} projectPath
 * @returns {string}
 */
function encodeProjectPath(projectPath) {
  const MAX_LEN = 200;
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= MAX_LEN) return encoded;
  // For paths exceeding 200 chars: truncate + append a simple hash
  // (mirrors Claude Code's hMK hash — DJB2-style string hash in base36)
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(i)) | 0;
  }
  return `${encoded.slice(0, MAX_LEN)}-${Math.abs(hash).toString(36)}`;
}

/**
 * The transcript directory for one cwd.
 * @param {string} projectPath
 * @returns {string}
 */
function getProjectSessionsDir(projectPath) {
  return path.join(claudeProjectsRoot(), encodeProjectPath(projectPath));
}

/**
 * The repository's common git directory, from any of its worktrees.
 *
 * In the main checkout `.git` is a directory. In a linked worktree it is a file
 * holding `gitdir: <common>/worktrees/<name>`, so the common directory is two
 * levels up from what it points at.
 *
 * @param {string} repoPath
 * @returns {string|null}
 */
function commonGitDir(repoPath) {
  const dotGit = path.join(repoPath, '.git');
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;

  try {
    const pointer = fs.readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match) return null;
    // <common>/worktrees/<name> -> <common>
    const linked = path.resolve(repoPath, match[1].trim());
    return path.dirname(path.dirname(linked));
  } catch {
    return null;
  }
}

/**
 * Paths of every worktree linked to this repository, excluding `repoPath`.
 *
 * Read from `.git/worktrees/<name>/gitdir` rather than by running
 * `git worktree list`: this is on the path of every session listing, and the
 * files say the same thing without a subprocess. It also works from inside a
 * worktree, and finds worktrees checked out anywhere on disk.
 *
 * @param {string} repoPath
 * @returns {string[]}
 */
function linkedWorktreePaths(repoPath) {
  const common = commonGitDir(repoPath);
  if (!common) return [];

  let entries;
  try {
    entries = fs.readdirSync(path.join(common, 'worktrees'), { withFileTypes: true });
  } catch {
    return []; // repository has no linked worktrees
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      // Points at `<worktree>/.git`, so the worktree is its parent.
      const gitdir = fs.readFileSync(path.join(common, 'worktrees', entry.name, 'gitdir'), 'utf8').trim();
      if (!gitdir) continue;
      const worktreePath = path.dirname(gitdir);
      if (worktreePath && worktreePath !== repoPath) found.push(worktreePath);
    } catch { /* half-written or pruned entry */ }
  }
  return found;
}

// A worktree Claude Code created for itself lives at `<repo>/.claude/worktrees/<name>`,
// which encodes to `<repo dir>--claude-worktrees-<name>`. Matching that prefix is
// what still finds the transcripts of a worktree that has since been removed:
// `git worktree remove` deletes the checkout and the `.git/worktrees` entry, but
// never the conversations that ran there.
const CLAUDE_WORKTREE_INFIX = '--claude-worktrees-';

/**
 * Transcript directories of removed `<repo>/.claude/worktrees/*` worktrees.
 *
 * Only worktrees under the repository itself can be recovered this way. A
 * removed worktree checked out elsewhere encodes to a directory name with
 * nothing left tying it to the project, and the encoding cannot be reversed.
 *
 * @param {string} repoPath
 * @param {Set<string>} known - Directory names already accounted for
 * @returns {Array<{dir: string, name: string}>}
 */
function orphanedWorktreeDirs(repoPath, known) {
  const prefix = encodeProjectPath(repoPath) + CLAUDE_WORKTREE_INFIX;
  let entries;
  try {
    entries = fs.readdirSync(claudeProjectsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(prefix) || entry.name.length === prefix.length) continue;
    if (known.has(entry.name)) continue;
    found.push({
      dir: path.join(claudeProjectsRoot(), entry.name),
      name: entry.name.slice(prefix.length),
    });
  }
  return found;
}

/**
 * Every transcript directory a project's sessions can be in.
 *
 * The project's own directory comes first, then one entry per worktree. A
 * `cwd` of null marks a worktree that no longer exists: its transcripts are
 * still readable, but there is nowhere to resume them except the project root.
 *
 * @param {string} projectPath
 * @returns {Array<{dir: string, cwd: string|null, worktree: string|null, missing: boolean}>}
 */
// Resolving a session's file, listing a project and answering an `@session`
// mention all ask for this within the same interaction, and each answer walks
// `.git/worktrees` and the projects root. A repository with dozens of worktrees
// makes that measurable, so the shape of the layout is held briefly.
const LAYOUT_CACHE_MS = 5000;
const _layoutCache = new Map(); // projectPath -> { at, dirs }

/** Drop the memoized layout, for tests and for a worktree just created. */
function invalidateSessionDirs(projectPath) {
  if (projectPath) _layoutCache.delete(projectPath);
  else _layoutCache.clear();
}

function listProjectSessionDirs(projectPath) {
  const cached = _layoutCache.get(projectPath);
  if (cached && Date.now() - cached.at < LAYOUT_CACHE_MS) return cached.dirs;

  const dirs = [{
    dir: getProjectSessionsDir(projectPath),
    cwd: projectPath,
    worktree: null,
    missing: false,
  }];
  const seen = new Set([path.basename(dirs[0].dir)]);

  for (const worktreePath of linkedWorktreePaths(projectPath)) {
    const name = path.basename(worktreePath);
    const dir = getProjectSessionsDir(worktreePath);
    if (seen.has(path.basename(dir))) continue;
    seen.add(path.basename(dir));
    dirs.push({ dir, cwd: worktreePath, worktree: name, missing: false });
  }

  for (const { dir, name } of orphanedWorktreeDirs(projectPath, seen)) {
    dirs.push({ dir, cwd: null, worktree: name, missing: true });
  }

  _layoutCache.set(projectPath, { at: Date.now(), dirs });
  return dirs;
}

module.exports = {
  claudeProjectsRoot,
  encodeProjectPath,
  getProjectSessionsDir,
  commonGitDir,
  linkedWorktreePaths,
  orphanedWorktreeDirs,
  listProjectSessionDirs,
  invalidateSessionDirs,
  CLAUDE_WORKTREE_INFIX,
};
