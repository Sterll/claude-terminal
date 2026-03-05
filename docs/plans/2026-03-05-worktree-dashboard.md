# Worktree Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a global "Worktrees" sidebar tab showing all active worktrees across all registered projects, with branch, dirty file count, lock status, and time tracked today.

**Architecture:** New panel `WorktreesDashboard.js` follows existing patterns (CloudPanel, GitChangesPanel). On tab activation, scans all git projects via existing IPC (`git-worktree-list` + `git-status-quick`) in parallel. Groups by main repo path to deduplicate repos. Matches worktrees to projects for time lookup. No new IPC required.

**Tech Stack:** Vanilla JS, `window.electron_api` (existing IPC), `getProjectTimes` (time tracking state), `formatDuration` (utils/format.js), `t()` (i18n), existing `showContextMenu` + `showConfirm` + `Toast` components.

---

### Task 1: i18n keys

**Files:**
- Modify: `src/renderer/i18n/locales/fr.json`
- Modify: `src/renderer/i18n/locales/en.json`

**Step 1: Add French keys**

In `fr.json`, add a top-level `"worktreesDashboard"` section (anywhere, keep alphabetical if possible):

```json
"worktreesDashboard": {
  "title": "Worktrees",
  "refresh": "Rafraîchir",
  "summary": "{repos} repos · {total} worktrees",
  "noProjects": "Aucun projet git enregistré",
  "noWorktrees": "Aucune worktree active",
  "current": "actif",
  "dirtyCount": "{count} modifié(s)",
  "clean": "Propre",
  "timeToday": "{time} auj.",
  "open": "Ouvrir",
  "lock": "Verrouiller",
  "unlock": "Déverrouiller",
  "remove": "Supprimer",
  "openFolder": "Ouvrir dossier",
  "locked": "Verrouillé"
}
```

Also add in the existing `"ui"` section:
```json
"tabWorktrees": "Worktrees"
```

**Step 2: Add English keys**

In `en.json`, add the same structure:

```json
"worktreesDashboard": {
  "title": "Worktrees",
  "refresh": "Refresh",
  "summary": "{repos} repos · {total} worktrees",
  "noProjects": "No git projects registered",
  "noWorktrees": "No active worktrees",
  "current": "active",
  "dirtyCount": "{count} modified",
  "clean": "Clean",
  "timeToday": "{time} today",
  "open": "Open",
  "lock": "Lock",
  "unlock": "Unlock",
  "remove": "Remove",
  "openFolder": "Open folder",
  "locked": "Locked"
}
```

Also add in `"ui"`:
```json
"tabWorktrees": "Worktrees"
```

**Step 3: Commit**

```bash
git add src/renderer/i18n/locales/fr.json src/renderer/i18n/locales/en.json
git commit -m "feat(i18n): add worktrees dashboard translation keys"
```

---

### Task 2: HTML — nav tab + panel div

**Files:**
- Modify: `index.html`

**Step 1: Add nav tab button**

In `index.html`, after the `<button class="nav-tab" data-tab="git"...>` block (lines 137–142), insert — still in the "Outils" separator section:

```html
        <button class="nav-tab" data-tab="worktrees" title="Worktrees">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <path d="M13 3a3 3 0 0 1 3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3m-1 8.05V23h2V11.05c-.33.05-.66.1-1 .1s-.67-.05-1-.1M5 3a3 3 0 0 1 3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3A3 3 0 0 1 5 3m0 8c.34 0 .67-.05 1-.1V17H4V11.05c.33.05.66.1 1 .1m14-8a3 3 0 0 1 3 3 3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3m0 8c.34 0 .67-.05 1-.1V17h-2v-5.95c.33.05.66.1 1 .1"/>
          </svg>
          <span data-i18n="ui.tabWorktrees">Worktrees</span>
        </button>
```

**Step 2: Add panel div**

Inside the `<div class="content">` area (around line 232), add before the git tab-content div:

```html
      <!-- Worktrees Dashboard Tab -->
      <div class="tab-content" id="tab-worktrees">
        <div id="worktrees-dashboard-root"></div>
      </div>
```

**Step 3: Add CSS link**

In `<head>`, after the last existing `<link rel="stylesheet" href="styles/...css">`:

```html
    <link rel="stylesheet" href="styles/worktrees.css">
```

**Step 4: Commit**

```bash
git add index.html
git commit -m "feat(html): add worktrees tab and panel div"
```

---

### Task 3: CSS styles

**Files:**
- Create: `styles/worktrees.css`

**Step 1: Create the file**

```css
/* =====================================================================
   Worktrees Dashboard
   ===================================================================== */

.worktrees-dashboard {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-primary);
}

/* ── Header ── */
.wt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.wt-header-left h2 {
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 2px;
}

.wt-summary {
  font-size: var(--font-xs);
  color: var(--text-secondary);
}

.wt-refresh-btn {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: var(--font-xs);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: color .15s, border-color .15s;
}
.wt-refresh-btn:hover { color: var(--text-primary); border-color: var(--accent); }
.wt-refresh-btn.spinning svg { animation: wt-spin 0.8s linear infinite; }
@keyframes wt-spin { to { transform: rotate(360deg); } }

/* ── Content area ── */
.wt-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ── Empty state ── */
.wt-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: var(--font-sm);
  padding: 60px 0;
}

/* ── Repo group card ── */
.wt-repo-group {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  overflow: hidden;
}

.wt-repo-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.wt-repo-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}

.wt-repo-name {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wt-repo-path {
  font-size: var(--font-2xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

/* ── Worktree item ── */
.wt-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-color);
  transition: background .1s;
}
.wt-item:last-child { border-bottom: none; }
.wt-item:hover { background: var(--bg-hover); }
.wt-item.is-current { background: var(--accent-dim); }

.wt-item-icon {
  color: var(--text-muted);
  font-size: 0.7rem;
  flex-shrink: 0;
  width: 12px;
  text-align: center;
}
.wt-item.is-main .wt-item-icon { color: var(--accent); }

.wt-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.wt-item-branch {
  font-size: var(--font-sm);
  color: var(--text-primary);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
}

.wt-branch-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wt-badge-current {
  font-size: var(--font-2xs);
  background: var(--accent);
  color: #000;
  border-radius: 3px;
  padding: 1px 5px;
  flex-shrink: 0;
  font-weight: 600;
}

.wt-lock-icon {
  font-size: 0.7rem;
  color: var(--warning);
  flex-shrink: 0;
  cursor: default;
}

.wt-item-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}

.wt-dirty-badge {
  color: var(--warning);
}
.wt-dirty-badge.clean { color: var(--text-muted); }

.wt-time { color: var(--text-muted); white-space: nowrap; }

/* ── Actions ── */
.wt-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity .15s;
}
.wt-item:hover .wt-item-actions { opacity: 1; }

.wt-action-btn {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  font-size: var(--font-xs);
  cursor: pointer;
  transition: color .1s, border-color .1s;
  white-space: nowrap;
}
.wt-action-btn:hover { color: var(--text-primary); border-color: var(--accent); }

.wt-action-menu-btn {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 2px 6px;
  cursor: pointer;
  font-size: var(--font-sm);
  line-height: 1;
  transition: color .1s, border-color .1s;
}
.wt-action-menu-btn:hover { color: var(--text-primary); border-color: var(--accent); }

/* ── Skeleton loader ── */
.wt-skeleton {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  overflow: hidden;
}
.wt-skeleton-header {
  height: 38px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}
.wt-skeleton-row {
  height: 40px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  padding: 0 14px;
  gap: 10px;
}
.wt-skeleton-row:last-child { border-bottom: none; }
.wt-skeleton-line {
  height: 10px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--bg-tertiary) 25%, var(--bg-hover) 50%, var(--bg-tertiary) 75%);
  background-size: 200% 100%;
  animation: wt-shimmer 1.4s infinite;
}
@keyframes wt-shimmer { to { background-position: -200% 0; } }
```

**Step 2: Commit**

```bash
git add styles/worktrees.css
git commit -m "feat(css): add worktrees dashboard styles"
```

---

### Task 4: Unit tests for pure data helpers

**Files:**
- Create: `tests/panels/worktreesDashboard.test.js`

The panel will export two pure functions: `groupWorktreesByRepo` and `matchProjectToWorktree`.

**Step 1: Write the failing tests**

```js
// tests/panels/worktreesDashboard.test.js
'use strict';

const { groupWorktreesByRepo, matchProjectToWorktree } = require('../../src/renderer/ui/panels/WorktreesDashboard');

describe('groupWorktreesByRepo', () => {
  it('groups worktrees that share the same main repo path', () => {
    const results = [
      {
        project: { id: 'p1', path: '/repos/app', name: 'app' },
        worktrees: [
          { path: '/repos/app', branch: 'main', isMain: true },
          { path: '/repos/app-feat', branch: 'feat/x', isMain: false }
        ]
      },
      {
        project: { id: 'p2', path: '/repos/app-feat', name: 'app-feat' },
        worktrees: [
          { path: '/repos/app', branch: 'main', isMain: true },
          { path: '/repos/app-feat', branch: 'feat/x', isMain: false }
        ]
      }
    ];
    const groups = groupWorktreesByRepo(results);
    expect(groups).toHaveLength(1);
    expect(groups[0].repoPath).toBe('/repos/app');
    expect(groups[0].worktrees).toHaveLength(2);
  });

  it('returns separate groups for different repos', () => {
    const results = [
      { project: { id: 'p1', path: '/repos/a', name: 'a' }, worktrees: [{ path: '/repos/a', branch: 'main', isMain: true }] },
      { project: { id: 'p2', path: '/repos/b', name: 'b' }, worktrees: [{ path: '/repos/b', branch: 'main', isMain: true }] }
    ];
    expect(groupWorktreesByRepo(results)).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(groupWorktreesByRepo([])).toEqual([]);
  });

  it('skips entries with no worktrees', () => {
    const results = [
      { project: { id: 'p1', path: '/repos/a', name: 'a' }, worktrees: [] }
    ];
    expect(groupWorktreesByRepo(results)).toHaveLength(0);
  });
});

describe('matchProjectToWorktree', () => {
  const projects = [
    { id: 'p1', path: '/repos/app' },
    { id: 'p2', path: '/repos/app-feat', isWorktree: true }
  ];

  it('finds a project by exact path', () => {
    expect(matchProjectToWorktree('/repos/app-feat', projects)?.id).toBe('p2');
  });

  it('normalises backslashes for Windows paths', () => {
    expect(matchProjectToWorktree('\\repos\\app', projects)?.id).toBe('p1');
  });

  it('returns null when no project matches', () => {
    expect(matchProjectToWorktree('/repos/unknown', projects)).toBeNull();
  });
});
```

**Step 2: Run to confirm failure**

```bash
npm test -- --testPathPattern=worktreesDashboard --no-coverage
```

Expected: `Cannot find module '../../src/renderer/ui/panels/WorktreesDashboard'`

**Step 3: Commit**

```bash
git add tests/panels/worktreesDashboard.test.js
git commit -m "test(worktrees): add failing unit tests for data helpers"
```

---

### Task 5: WorktreesDashboard.js — pure helpers (make tests pass)

**Files:**
- Create: `src/renderer/ui/panels/WorktreesDashboard.js`

**Step 1: Create with pure helpers + stubs**

```js
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

// ── Stubs (implemented in Task 6) ──
function load() {}
function cleanup() {}

module.exports = { groupWorktreesByRepo, matchProjectToWorktree, load, cleanup };
```

**Step 2: Run tests — expect PASS**

```bash
npm test -- --testPathPattern=worktreesDashboard --no-coverage
```

Expected: 7 tests PASS.

**Step 3: Commit**

```bash
git add src/renderer/ui/panels/WorktreesDashboard.js
git commit -m "feat(worktrees): add pure data helpers, tests passing"
```

---

### Task 6: WorktreesDashboard.js — scan, render, actions

**Files:**
- Modify: `src/renderer/ui/panels/WorktreesDashboard.js`

Replace the entire file with the full implementation. Keep the two pure helpers at the top unchanged.

**Step 1: Add imports and state after the module docstring**

```js
'use strict';

const { t } = require('../../i18n');
const { formatDuration } = require('../../utils/format');
const { escapeHtml } = require('../../utils/dom');
const { getProjectTimes } = require('../../state/timeTracking.state');
const { projectsState } = require('../../state/projects.state');
const Toast = require('../components/Toast');

const api = window.electron_api;

let _scanData = [];
let _autoRefreshTimer = null;
const AUTO_REFRESH_MS = 30_000;
```

**Step 2: Add `scanAllWorktrees()` after the pure helpers**

```js
async function scanAllWorktrees() {
  const projects = projectsState.get().projects || [];
  // Don't re-scan worktrees that are themselves registered as projects
  const gitProjects = projects.filter(p => p.path && !p.isWorktree);
  if (gitProjects.length === 0) return [];

  const results = await Promise.allSettled(
    gitProjects.map(async project => {
      try {
        const res = await api.git.worktreeList({ projectPath: project.path });
        if (!res?.success || !res.worktrees?.length) return null;
        return { project, worktrees: res.worktrees };
      } catch { return null; }
    })
  );

  return groupWorktreesByRepo(
    results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value)
  );
}
```

**Step 3: Add `enrichWithStatus()` and `enrichWithTime()`**

```js
async function enrichWithStatus(group) {
  const enriched = await Promise.allSettled(
    group.worktrees.map(async wt => {
      try {
        const res = await api.git.statusQuick({ projectPath: wt.path });
        return { ...wt, dirtyCount: res?.changesCount || 0 };
      } catch { return { ...wt, dirtyCount: 0 }; }
    })
  );
  group.worktrees = enriched
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

function enrichWithTime(group, projects) {
  for (const wt of group.worktrees) {
    const proj = matchProjectToWorktree(wt.path, projects);
    if (proj) {
      const times = getProjectTimes(proj.id);
      wt.timeToday = times.today || null;
      wt.linkedProjectId = proj.id;
    } else {
      wt.timeToday = null;
      wt.linkedProjectId = null;
    }
  }
}
```

**Step 4: Add `load()` and `cleanup()`**

```js
async function load() {
  const root = document.getElementById('worktrees-dashboard-root');
  if (!root) return;

  renderLoading(root);

  try {
    const projects = projectsState.get().projects || [];
    const groups = await scanAllWorktrees();
    for (const group of groups) {
      await enrichWithStatus(group);
      enrichWithTime(group, projects);
    }
    _scanData = groups;
    renderDashboard(root, groups);
  } catch (err) {
    root.innerHTML = `<div class="wt-empty">${escapeHtml(err.message)}</div>`;
  }

  clearTimeout(_autoRefreshTimer);
  _autoRefreshTimer = setTimeout(() => load(), AUTO_REFRESH_MS);
}

function cleanup() {
  clearTimeout(_autoRefreshTimer);
  _autoRefreshTimer = null;
}
```

**Step 5: Add render functions**

```js
function renderLoading(root) {
  root.innerHTML = `
    <div class="worktrees-dashboard">
      ${buildHeader(null)}
      <div class="wt-content">
        ${[0, 1].map(() => `
          <div class="wt-skeleton">
            <div class="wt-skeleton-header"></div>
            ${[0, 1, 2].map(() => `
              <div class="wt-skeleton-row">
                <div class="wt-skeleton-line" style="width:55%"></div>
                <div class="wt-skeleton-line" style="width:18%;margin-left:auto"></div>
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>
    </div>`;
}

function renderDashboard(root, groups) {
  const totalWorktrees = groups.reduce((n, g) => n + g.worktrees.length, 0);
  const summary = groups.length > 0
    ? t('worktreesDashboard.summary', { repos: groups.length, total: totalWorktrees })
    : null;

  root.innerHTML = `
    <div class="worktrees-dashboard">
      ${buildHeader(summary)}
      <div class="wt-content" id="wt-content">
        ${groups.length === 0
          ? `<div class="wt-empty">${escapeHtml(t('worktreesDashboard.noWorktrees'))}</div>`
          : groups.map(g => buildGroupHtml(g)).join('')}
      </div>
    </div>`;
  setupHandlers(root);
}

function buildHeader(summary) {
  return `
    <div class="wt-header">
      <div class="wt-header-left">
        <h2>${escapeHtml(t('worktreesDashboard.title'))}</h2>
        ${summary ? `<div class="wt-summary">${escapeHtml(summary)}</div>` : ''}
      </div>
      <button class="wt-refresh-btn" id="wt-refresh-btn">
        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12">
          <path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 0 0-8 8 8 8 0 0 0 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18a6 6 0 0 1-6-6 6 6 0 0 1 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
        </svg>
        ${escapeHtml(t('worktreesDashboard.refresh'))}
      </button>
    </div>`;
}

function buildGroupHtml(group) {
  const shortPath = group.repoPath.split('/').slice(-2).join('/');
  return `
    <div class="wt-repo-group">
      <div class="wt-repo-header">
        <span class="wt-repo-dot"></span>
        <span class="wt-repo-name">${escapeHtml(group.repoName)}</span>
        <span class="wt-repo-path" title="${escapeHtml(group.repoPath)}">${escapeHtml(shortPath)}</span>
      </div>
      ${group.worktrees.map(wt => buildWorktreeItemHtml(wt)).join('')}
    </div>`;
}

function buildWorktreeItemHtml(wt) {
  const branchDisplay = wt.detached
    ? `(${(wt.head || '').substring(0, 7)})`
    : (wt.branch || 'unknown');

  const lockHtml = wt.locked
    ? `<span class="wt-lock-icon" title="${escapeHtml(t('worktreesDashboard.locked') + (wt.lockReason ? ': ' + wt.lockReason : ''))}">🔒</span>`
    : '';

  const dirtyHtml = wt.dirtyCount > 0
    ? `<span class="wt-dirty-badge">${escapeHtml(t('worktreesDashboard.dirtyCount', { count: wt.dirtyCount }))}</span>`
    : `<span class="wt-dirty-badge clean">${escapeHtml(t('worktreesDashboard.clean'))}</span>`;

  const timeHtml = wt.timeToday
    ? `<span class="wt-time">${escapeHtml(t('worktreesDashboard.timeToday', { time: formatDuration(wt.timeToday, { compact: true }) }))}</span>`
    : `<span class="wt-time">—</span>`;

  const openBtn = !wt.isCurrent
    ? `<button class="wt-action-btn wt-open-btn" data-wt-path="${escapeHtml(wt.path)}">${escapeHtml(t('worktreesDashboard.open'))}</button>`
    : '';

  return `
    <div class="wt-item ${wt.isCurrent ? 'is-current' : ''} ${wt.isMain ? 'is-main' : ''}"
         data-wt-path="${escapeHtml(wt.path)}">
      <span class="wt-item-icon">${wt.isMain ? '◉' : '○'}</span>
      <div class="wt-item-main">
        <div class="wt-item-branch">
          <span class="wt-branch-name">${escapeHtml(branchDisplay)}</span>
          ${wt.isCurrent ? `<span class="wt-badge-current">${escapeHtml(t('worktreesDashboard.current'))}</span>` : ''}
          ${lockHtml}
        </div>
        <div class="wt-item-meta">${dirtyHtml}${timeHtml}</div>
      </div>
      <div class="wt-item-actions">
        ${openBtn}
        <button class="wt-action-menu-btn wt-menu-btn"
                data-wt-path="${escapeHtml(wt.path)}"
                data-wt-main="${wt.isMain ? '1' : '0'}"
                data-wt-locked="${wt.locked ? '1' : '0'}">···</button>
      </div>
    </div>`;
}
```

**Step 6: Add `setupHandlers()` and action handlers**

```js
function setupHandlers(root) {
  root.querySelector('#wt-refresh-btn')?.addEventListener('click', () => {
    cleanup();
    load();
  });

  root.querySelector('#wt-content')?.addEventListener('click', (e) => {
    const openBtn = e.target.closest('.wt-open-btn');
    const menuBtn = e.target.closest('.wt-menu-btn');
    if (openBtn) { handleOpen(openBtn.dataset.wtPath); return; }
    if (menuBtn) { handleMenu(menuBtn); return; }
  });
}

function handleOpen(wtPath) {
  const { addProject, setOpenedProjectId } = require('../state');
  const projects = projectsState.get().projects;
  const norm = normPath(wtPath);
  let proj = projects.find(p => normPath(p.path) === norm);
  if (!proj) {
    const name = norm.split('/').pop();
    proj = addProject({ name, path: wtPath, type: 'standalone', isWorktree: true });
  }
  setOpenedProjectId(proj.id);
  document.querySelector('[data-tab="claude"]')?.click();
}

function handleMenu(btnEl) {
  const { showContextMenu } = require('../components/ContextMenu');
  const wtPath = btnEl.dataset.wtPath;
  const isLocked = btnEl.dataset.wtLocked === '1';
  const isMain = btnEl.dataset.wtMain === '1';

  let mainRepoPath = null;
  for (const group of _scanData) {
    if (group.worktrees.find(w => normPath(w.path) === normPath(wtPath))) {
      mainRepoPath = group.repoPath;
      break;
    }
  }
  if (!mainRepoPath) return;

  const items = [
    !isLocked && { label: t('worktreesDashboard.lock'),       action: () => doLock(mainRepoPath, wtPath) },
    isLocked  && { label: t('worktreesDashboard.unlock'),     action: () => doUnlock(mainRepoPath, wtPath) },
    { label: t('worktreesDashboard.openFolder'), action: () => api.dialog.openInExplorer(wtPath) },
    !isMain   && { label: t('worktreesDashboard.remove'),     action: () => doRemove(mainRepoPath, wtPath), danger: true },
  ].filter(Boolean);

  const rect = btnEl.getBoundingClientRect();
  showContextMenu(items, { x: rect.left, y: rect.bottom + 4 });
}

async function doLock(mainRepoPath, wtPath) {
  const res = await api.git.worktreeLock({ projectPath: mainRepoPath, worktreePath: wtPath });
  if (res?.success) { Toast.show(t('gitTab.worktreeLocked'), 'success'); cleanup(); load(); }
  else Toast.show(res?.error || 'Error', 'error');
}

async function doUnlock(mainRepoPath, wtPath) {
  const res = await api.git.worktreeUnlock({ projectPath: mainRepoPath, worktreePath: wtPath });
  if (res?.success) { Toast.show(t('gitTab.worktreeUnlocked'), 'success'); cleanup(); load(); }
  else Toast.show(res?.error || 'Error', 'error');
}

async function doRemove(mainRepoPath, wtPath) {
  const { showConfirm } = require('../components/Modal');
  const confirmed = await showConfirm({ title: t('gitTab.removeWorktree'), message: wtPath, danger: true });
  if (!confirmed) return;
  const res = await api.git.worktreeRemove({ projectPath: mainRepoPath, worktreePath: wtPath });
  if (res?.success) { Toast.show(t('gitTab.worktreeRemoved'), 'success'); cleanup(); load(); }
  else Toast.show(res?.error || 'Error', 'error');
}
```

**Step 7: Update module.exports**

```js
module.exports = { groupWorktreesByRepo, matchProjectToWorktree, load, cleanup };
```

**Step 8: Run tests — still PASS**

```bash
npm test -- --testPathPattern=worktreesDashboard --no-coverage
```

Expected: 7 tests PASS.

**Step 9: Commit**

```bash
git add src/renderer/ui/panels/WorktreesDashboard.js
git commit -m "feat(worktrees): implement scan, render, and action handlers"
```

---

### Task 7: Wire up — register panel + tab dispatch

**Files:**
- Modify: `src/renderer/ui/panels/index.js`
- Modify: `renderer.js`

**Step 1: Add to panels index**

In `src/renderer/ui/panels/index.js`, add:

```js
const WorktreesDashboard = require('./WorktreesDashboard');
```

And add `WorktreesDashboard` to `module.exports`.

**Step 2: Import in renderer.js**

On line 100, extend the destructure:

```js
const { MemoryEditor, GitChangesPanel, ShortcutsManager, SettingsPanel, SkillsAgentsPanel,
        PluginsPanel, MarketplacePanel, McpPanel, WorkflowPanel, DatabasePanel, CloudPanel,
        WorktreesDashboard } = require('./src/renderer/ui/panels');
```

**Step 3: Add tab dispatch**

In the `tab.onclick` handler in `renderer.js` (around line 2320), add:

```js
if (tabId === 'worktrees') WorktreesDashboard.load();
if (tabId !== 'worktrees') WorktreesDashboard.cleanup();
```

**Step 4: Commit**

```bash
git add src/renderer/ui/panels/index.js renderer.js
git commit -m "feat(worktrees): wire panel to sidebar tab navigation"
```

---

### Task 8: Build + full test suite

**Step 1: Build renderer**

```bash
npm run build:renderer
```

Expected: No errors, `dist/renderer.bundle.js` updated.

**Step 2: Run full test suite**

```bash
npm test
```

Expected: All prior tests pass + 7 new worktrees tests pass.

**Step 3: Smoke test — start the app**

```bash
npm start
```

Manual checklist:
- [ ] "Worktrees" tab appears in sidebar between Git and Database
- [ ] Clicking it shows skeleton cards, then repo groups
- [ ] Each worktree shows: branch name, dirty file count, time (or `—`), lock icon if locked
- [ ] Current worktree (matching open project path) shows `[actif]` badge and accent-dim background
- [ ] "Ouvrir" button switches to Claude tab and selects the project
- [ ] `···` menu opens with lock/unlock/remove/open folder
- [ ] Refresh button rescans and updates the view
- [ ] Switching away from the tab stops the auto-refresh timer

**Step 4: Commit any fix**

If minor corrections are needed after smoke test:
```bash
git add -p
git commit -m "fix(worktrees): post-smoke corrections"
```
