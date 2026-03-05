/**
 * WorktreesDashboard
 * Global view of all active worktrees across all registered git projects.
 */

'use strict';

const { t } = require('../../i18n');
const { formatDuration } = require('../../utils/format');
const { escapeHtml } = require('../../utils/dom');
const { getProjectTimes } = require('../../state/timeTracking.state');
const { projectsState } = require('../../state/projects.state');
const Toast = require('../components/Toast');
const { addProject, setOpenedProjectId } = require('../../state');
const { showContextMenu } = require('../components/ContextMenu');
const { showConfirm } = require('../components/Modal');

const api = window.electron_api;

let _scanData = [];
let _autoRefreshTimer = null;
const AUTO_REFRESH_MS = 30_000;

// ══════════════════════════════════════════════
// PURE HELPERS — exported for unit tests
// ══════════════════════════════════════════════

function normPath(p) {
  return (p || '').replace(/\\/g, '/');
}

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

function matchProjectToWorktree(worktreePath, projects) {
  const norm = normPath(worktreePath);
  return projects.find(p => normPath(p.path) === norm) || null;
}

// ══════════════════════════════════════════════
// DATA ENRICHMENT
// ══════════════════════════════════════════════

async function scanAllWorktrees() {
  const projects = projectsState.get().projects || [];
  // Skip worktrees already registered as projects (avoid double-counting)
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

function enrichWithTime(group, projects, openedProjectId) {
  // Derive isCurrent by comparing to the opened project path
  const openedProject = openedProjectId
    ? projects.find(p => p.id === openedProjectId)
    : null;
  const openedPath = openedProject ? normPath(openedProject.path) : null;

  for (const wt of group.worktrees) {
    // isCurrent: this worktree's path matches the currently viewed project
    wt.isCurrent = openedPath ? normPath(wt.path) === openedPath : false;

    // Time tracking: look up project matching this worktree path
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

// ══════════════════════════════════════════════
// LOAD / CLEANUP
// ══════════════════════════════════════════════

async function load() {
  const root = document.getElementById('worktrees-dashboard-root');
  if (!root) return;

  renderLoading(root);

  try {
    const state = projectsState.get();
    const projects = state.projects || [];
    const openedProjectId = state.openedProjectId;
    const groups = await scanAllWorktrees();
    for (const group of groups) {
      await enrichWithStatus(group);
      enrichWithTime(group, projects, openedProjectId);
    }
    _scanData = groups;
    renderDashboard(root, groups);
    clearTimeout(_autoRefreshTimer);
    _autoRefreshTimer = setTimeout(() => load(), AUTO_REFRESH_MS);
  } catch (err) {
    console.error('[WorktreesDashboard] load error:', err);
    root.innerHTML = `<div class="wt-empty">${escapeHtml(err.message)}</div>`;
  }
}

function cleanup() {
  clearTimeout(_autoRefreshTimer);
  _autoRefreshTimer = null;
}

// ══════════════════════════════════════════════
// RENDER
// ══════════════════════════════════════════════

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
    ? `<span class="wt-lock-icon" title="${escapeHtml(t('worktreesDashboard.locked'))}${wt.lockReason ? ': ' + escapeHtml(wt.lockReason) : ''}">🔒</span>`
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

// ══════════════════════════════════════════════
// HANDLERS
// ══════════════════════════════════════════════

function setupHandlers(root) {
  const refreshBtn = root.querySelector('#wt-refresh-btn');
  refreshBtn?.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
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
    !isLocked && { label: t('worktreesDashboard.lock'),       onClick: () => doLock(mainRepoPath, wtPath) },
    isLocked  && { label: t('worktreesDashboard.unlock'),     onClick: () => doUnlock(mainRepoPath, wtPath) },
    { label: t('worktreesDashboard.openFolder'), onClick: () => api.dialog.openInExplorer(wtPath) },
    !isMain   && { label: t('worktreesDashboard.remove'),     onClick: () => doRemove(mainRepoPath, wtPath), danger: true },
  ].filter(Boolean);

  const rect = btnEl.getBoundingClientRect();
  showContextMenu({ x: rect.left, y: rect.bottom + 4, items });
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
  const confirmed = await showConfirm({ title: t('gitTab.removeWorktree'), message: wtPath, danger: true });
  if (!confirmed) return;
  const res = await api.git.worktreeRemove({ projectPath: mainRepoPath, worktreePath: wtPath });
  if (res?.success) { Toast.show(t('gitTab.worktreeRemoved'), 'success'); cleanup(); load(); }
  else Toast.show(res?.error || 'Error', 'error');
}

module.exports = { groupWorktreesByRepo, matchProjectToWorktree, load, cleanup };
