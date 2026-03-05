/**
 * WorktreesDashboard
 * Global view of all active worktrees across all registered git projects.
 */

'use strict';

// ══════════════════════════════════════════════
// PURE HELPERS — exported for unit tests
// ══════════════════════════════════════════════

/**
 * Normalise a path for comparison (forward slashes).
 * @param {string} p
 * @returns {string}
 */
function normPath(p) {
  return (p || '').replace(/\\/g, '/');
}

/**
 * Group scan results by main repo path, deduplicating repos that appear
 * multiple times (e.g. when each worktree is also a registered project).
 *
 * @param {Array<{project: Object, worktrees: Array}>} scanResults
 * @returns {Array<{repoName, repoPath, worktrees[]}>}
 */
function groupWorktreesByRepo(scanResults) {
  const byMainPath = new Map();

  for (const { project, worktrees } of scanResults) {
    if (!worktrees || worktrees.length === 0) continue;

    const mainWt = worktrees.find(w => w.isMain) || worktrees[0];
    const mainPath = normPath(mainWt.path);

    if (!byMainPath.has(mainPath)) {
      byMainPath.set(mainPath, { repoName: project.name, repoPath: mainPath, worktrees: [] });
    }

    const group = byMainPath.get(mainPath);
    for (const wt of worktrees) {
      const wtNorm = normPath(wt.path);
      if (!group.worktrees.find(e => normPath(e.path) === wtNorm)) {
        group.worktrees.push(wt);
      }
    }
  }

  return [...byMainPath.values()];
}

/**
 * Find the registered project whose path matches a given worktree path.
 * @param {string} worktreePath
 * @param {Array} projects
 * @returns {Object|null}
 */
function matchProjectToWorktree(worktreePath, projects) {
  const norm = normPath(worktreePath);
  return projects.find(p => normPath(p.path) === norm) || null;
}

// ── Stubs — implemented in Task 6 ──
function load() {}
function cleanup() {}

module.exports = { groupWorktreesByRepo, matchProjectToWorktree, load, cleanup };
