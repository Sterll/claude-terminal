/**
 * Git repositories in the sub-folders of a project that is not one itself.
 *
 * A project can be a plain folder grouping several repositories (x/a, x/b,
 * x/c...), each with its own .git, added as one project so it is simpler to
 * work on together. Nothing at its root answers git, so every git surface
 * used to say "not a git repository" for it. This module finds those
 * repositories (`git-nested-repos` in main) and remembers which one the user
 * is looking at, per project, so the Git tab, the Changes panel and the
 * toolbar's pull / push / branch buttons all work on the same one.
 *
 * A project whose root is a repository has no nested repositories here, even
 * if some sub-folder holds another: its own repository is the one shown.
 */

const SELECTION_STORAGE_KEY = 'ct.nestedRepoSelection';
const CACHE_TTL_MS = 30 * 1000;

/** projectId -> { path, at, repos } once answered, { path, promise } while asking */
const _cache = new Map();
/** projectId -> repository path the user picked */
const _selected = _loadSelection();
const _listeners = new Set();

function _api() {
  return window.electron_api;
}

function _loadSelection() {
  try {
    const raw = JSON.parse(localStorage.getItem(SELECTION_STORAGE_KEY) || '{}');
    return new Map(Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([, v]) => typeof v === 'string'));
  } catch {
    return new Map();
  }
}

function _saveSelection() {
  try { localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(Object.fromEntries(_selected))); } catch { /* ignore */ }
}

/**
 * Ask main. An answer that says nothing about the folder (host away, git not
 * installed) is not cached, so the next look asks again.
 * @returns {Promise<{ repos: Array, cacheable: boolean }>}
 */
async function _fetch(project) {
  const api = _api();
  if (!api?.git?.nestedRepos) return { repos: [], cacheable: false };
  const root = await api.git.statusQuick({ projectPath: project.path }).catch(() => null);
  if (!root) return { repos: [], cacheable: false };
  if (root.isGitRepo) return { repos: [], cacheable: true };
  if (root.disconnected || root.gitUnavailable) return { repos: [], cacheable: false };
  const res = await api.git.nestedRepos({ projectPath: project.path }).catch(() => null);
  if (!res || !res.ok) return { repos: [], cacheable: false };
  return { repos: Array.isArray(res.repos) ? res.repos : [], cacheable: true };
}

/**
 * The repositories in the project's sub-folders, `[]` when its root is one
 * (or when there are none).
 * @param {{ id: string, path: string }} project
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<Array<{ name: string, path: string, branch: string|null, upstream: string|null, ahead: number, behind: number, changes: number }>>}
 */
function listNestedRepos(project, { force = false } = {}) {
  if (!project?.id || !project.path) return Promise.resolve([]);
  const hit = _cache.get(project.id);
  if (hit && hit.path === project.path) {
    if (hit.promise) return hit.promise;
    if (!force && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.repos);
  }
  // The previous listing stays readable while the new one is asked for, so
  // getSelectedRepoPath() does not fall back to the root in between.
  const entry = { path: project.path, repos: hit && hit.path === project.path ? hit.repos : undefined };
  entry.promise = _fetch(project).then(({ repos, cacheable }) => {
    if (_cache.get(project.id) === entry) {
      if (cacheable) _cache.set(project.id, { path: project.path, at: Date.now(), repos });
      else _cache.delete(project.id);
    }
    return repos;
  }, () => {
    if (_cache.get(project.id) === entry) _cache.delete(project.id);
    return [];
  });
  _cache.set(project.id, entry);
  return entry.promise;
}

/** The last answer for a project, without asking: `[]` when there is none yet. */
function getCachedNestedRepos(projectId) {
  const hit = _cache.get(projectId);
  return hit && Array.isArray(hit.repos) ? hit.repos : [];
}

/**
 * The repository a project's git surfaces work on: the one picked, if it is
 * still there, else the first one.
 * @param {string} projectId
 * @param {Array} [repos] - defaults to the cached listing
 */
function getSelectedRepo(projectId, repos = getCachedNestedRepos(projectId)) {
  if (!repos.length) return null;
  const picked = _selected.get(projectId);
  return repos.find((r) => r.path === picked) || repos[0];
}

/** Synchronous form for callers that only need the path, `null` when the project has no nested repositories. */
function getSelectedRepoPath(projectId) {
  return getSelectedRepo(projectId)?.path || null;
}

/** Pick the repository a project's git surfaces work on, and tell them. */
function selectRepo(projectId, repoPath) {
  if (!projectId || typeof repoPath !== 'string') return;
  if (_selected.get(projectId) === repoPath) return;
  _selected.set(projectId, repoPath);
  _saveSelection();
  for (const fn of [..._listeners]) {
    try { fn(projectId, repoPath); } catch (e) { console.error('[nestedRepos] listener failed:', e); }
  }
}

/**
 * Be told when the picked repository of a project changes.
 * @param {(projectId: string, repoPath: string) => void} fn
 * @returns {() => void} unsubscribe
 */
function onSelectionChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Mark a project's listing stale, so the next look asks main again. The
 * listing itself stays readable until then, for getSelectedRepoPath().
 */
function invalidateNestedRepos(projectId) {
  for (const [id, hit] of _cache) {
    if (projectId && id !== projectId) continue;
    if (hit.promise) continue;
    hit.at = 0;
  }
}

module.exports = {
  listNestedRepos,
  getCachedNestedRepos,
  getSelectedRepo,
  getSelectedRepoPath,
  selectRepo,
  onSelectionChange,
  invalidateNestedRepos,
};
