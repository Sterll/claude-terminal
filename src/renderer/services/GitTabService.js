/**
 * Git Tab Service
 * Handles the full Git tab: changes, history, pull requests, branches, stashes
 */

const api = window.electron_api;
const { projectsState, getProject, getFolder, getProjectIndex } = require('../state');
const { escapeHtml } = require('../utils');
const { t } = require('../i18n');
const Toast = require('../ui/components/Toast');

// ========== STATE ==========
let selectedProject = null;
let selectedProjectId = null;
let currentSubTab = 'changes';
let operationLock = false;

// Data caches
let changesData = null;
let branchesData = null;
let currentBranch = null;
let aheadBehind = null;
let stashesData = null;
let historyData = [];
let historyPage = 0;
let prsData = null;
let remoteUrl = null;

// History filter state
let historyBranchFilter = '';
let historyAuthorFilter = '';
let historyAllBranches = false;

// Merge conflict state
let mergeInProgress = false;
let conflictFiles = [];

// ========== HELPERS ==========
function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

function getStatusIcon(status) {
  switch (status) {
    case 'A': return '<span class="git-status-badge added">A</span>';
    case 'M': return '<span class="git-status-badge modified">M</span>';
    case 'D': return '<span class="git-status-badge deleted">D</span>';
    case 'R': return '<span class="git-status-badge renamed">R</span>';
    case '?': return '<span class="git-status-badge untracked">?</span>';
    default: return '<span class="git-status-badge">' + escapeHtml(status) + '</span>';
  }
}

function fileBasename(filePath) {
  return filePath.split('/').pop() || filePath;
}

function fileDir(filePath) {
  const parts = filePath.split('/');
  parts.pop();
  return parts.join('/');
}

async function withLock(fn) {
  if (operationLock) return;
  operationLock = true;
  try {
    await fn();
  } finally {
    operationLock = false;
  }
}

// ========== DATA LOADING ==========

async function loadAllData(project) {
  selectedProject = project;
  const path = project.path;

  // Reset history filters on project switch
  historyBranchFilter = '';
  historyAuthorFilter = '';
  historyAllBranches = false;
  historyHasMore = true;
  historyLoadingMore = false;
  if (historyScrollObserver) { historyScrollObserver.disconnect(); historyScrollObserver = null; }

  const [changes, history, gitInfoFull] = await Promise.all([
    api.git.statusDetailed({ projectPath: path }),
    api.git.commitHistory({ projectPath: path, skip: 0, limit: 50 }),
    api.git.infoFull(path)
  ]);

  changesData = changes;
  branchesData = gitInfoFull?.branches || { local: [], remote: [] };
  currentBranch = gitInfoFull?.branch || null;
  stashesData = gitInfoFull?.stashes || [];
  aheadBehind = gitInfoFull?.aheadBehind || { ahead: 0, behind: 0, hasRemote: false };
  remoteUrl = gitInfoFull?.remoteUrl || null;
  historyData = history || [];
  historyPage = 0;
  historyHasMore = historyData.length >= 50;

  // Check merge in progress
  mergeInProgress = await api.git.mergeInProgress({ projectPath: path });
  if (mergeInProgress) {
    conflictFiles = await api.git.mergeConflicts({ projectPath: path });
  } else {
    conflictFiles = [];
  }

  if (remoteUrl) {
    api.github.pullRequests(remoteUrl).then(result => {
      prsData = result;
      const badge = document.getElementById('git-pr-badge');
      if (badge && result?.pullRequests) {
        const openCount = result.pullRequests.filter(pr => pr.state === 'open').length;
        badge.textContent = openCount;
        badge.style.display = openCount > 0 ? '' : 'none';
      }
    }).catch(() => {});
  }
}

async function refreshChanges() {
  if (!selectedProject) return;
  changesData = await api.git.statusDetailed({ projectPath: selectedProject.path });
  const badge = document.getElementById('git-changes-badge');
  if (badge && changesData?.files) {
    badge.textContent = changesData.files.length;
    badge.style.display = changesData.files.length > 0 ? '' : 'none';
  }
  // Refresh merge state
  mergeInProgress = await api.git.mergeInProgress({ projectPath: selectedProject.path });
  if (mergeInProgress) {
    conflictFiles = await api.git.mergeConflicts({ projectPath: selectedProject.path });
  } else {
    conflictFiles = [];
  }
}

async function refreshBranches() {
  if (!selectedProject) return;
  const [branches, branch] = await Promise.all([
    api.git.branches({ projectPath: selectedProject.path }),
    api.git.currentBranch({ projectPath: selectedProject.path })
  ]);
  branchesData = branches;
  currentBranch = branch;
}

// ========== RENDERING ==========

function renderGitTab() {
  renderSidebar();
  renderSubTabContent();
}

function renderSidebar() {
  renderProjectsList();
  renderQuickActions();
  renderBranches();
  renderStashes();
}

function countFolderProjects(folder, folders, projects) {
  let count = 0;
  for (const childId of (folder.children || [])) {
    const childFolder = folders.find(f => f.id === childId);
    if (childFolder) count += countFolderProjects(childFolder, folders, projects);
    else if (projects.find(p => p.id === childId)) count++;
  }
  return count;
}

function renderProjectsList() {
  const list = document.getElementById('git-projects-list');
  if (!list) return;

  const state = projectsState.get();
  const { projects, folders, rootOrder } = state;

  if (!projects || projects.length === 0) {
    list.innerHTML = '<div class="git-sidebar-empty">No projects</div>';
    return;
  }

  function renderFolderItem(folder, depth) {
    const indent = depth * 16;
    const projectCount = countFolderProjects(folder, folders, projects);
    const isCollapsed = folder.collapsed;

    const folderIcon = folder.icon
      ? `<span class="git-folder-emoji">${folder.icon}</span>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>`;

    const colorDot = folder.color
      ? `<span class="git-folder-color" style="background:${folder.color}"></span>`
      : '';

    let childrenHtml = '';
    for (const childId of (folder.children || [])) {
      const childFolder = folders.find(f => f.id === childId);
      if (childFolder) {
        childrenHtml += renderFolderItem(childFolder, depth + 1);
      } else {
        const childProject = projects.find(p => p.id === childId);
        if (childProject) childrenHtml += renderProjectItem(childProject, depth + 1);
      }
    }

    return `<div class="git-folder-item" data-folder-id="${escapeAttr(folder.id)}">
      <div class="git-folder-header" style="padding-left:${8 + indent}px">
        <span class="git-folder-chevron ${isCollapsed ? 'collapsed' : ''}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        </span>
        ${colorDot}
        <span class="git-folder-icon">${folderIcon}</span>
        <span class="git-folder-name">${escapeHtml(folder.name)}</span>
        <span class="git-folder-count">${projectCount}</span>
      </div>
      <div class="git-folder-children ${isCollapsed ? 'collapsed' : ''}">
        ${childrenHtml}
      </div>
    </div>`;
  }

  function renderProjectItem(project, depth) {
    const indent = depth * 16;
    const isActive = selectedProjectId === project.id;

    const iconHtml = project.icon
      ? `<span class="git-project-emoji">${project.icon}</span>`
      : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>`;

    const colorDot = project.color
      ? `<span class="git-folder-color" style="background:${project.color}"></span>`
      : '';

    const pathParts = project.path ? project.path.replace(/\\/g, '/').split('/') : [];
    const shortPath = pathParts.length > 2 ? '.../' + pathParts.slice(-2).join('/') : project.path || '';

    return `<div class="git-project-item ${isActive ? 'active' : ''}" data-project-id="${escapeAttr(project.id)}" style="padding-left:${indent}px">
      <div class="git-project-icon">${colorDot}${iconHtml}</div>
      <div class="git-project-info">
        <div class="git-project-name">${escapeHtml(project.name)}</div>
        <div class="git-project-path">${escapeHtml(shortPath)}</div>
      </div>
    </div>`;
  }

  let html = '';
  for (const itemId of (rootOrder || [])) {
    const folder = folders.find(f => f.id === itemId);
    if (folder) {
      html += renderFolderItem(folder, 0);
    } else {
      const project = projects.find(p => p.id === itemId);
      if (project) html += renderProjectItem(project, 0);
    }
  }

  list.innerHTML = html;

  // Delegated click handler for project list
  list.onclick = (e) => {
    const header = e.target.closest('.git-folder-header');
    if (header) {
      e.stopPropagation();
      const chevron = header.querySelector('.git-folder-chevron');
      const children = header.nextElementSibling;
      if (chevron && children) {
        chevron.classList.toggle('collapsed');
        children.classList.toggle('collapsed');
      }
      return;
    }
    const item = e.target.closest('.git-project-item[data-project-id]');
    if (item) selectProjectById(item.dataset.projectId);
  };
}

async function selectProjectById(projectId) {
  const project = getProject(projectId);
  if (!project) return;

  selectedProjectId = projectId;

  // Update active state in sidebar
  document.querySelectorAll('#git-projects-list .git-project-item').forEach(el => el.classList.remove('active'));
  const active = document.querySelector(`#git-projects-list .git-project-item[data-project-id="${projectId}"]`);
  if (active) active.classList.add('active');

  // Show loading
  const content = document.getElementById('git-sub-content');
  if (content) content.innerHTML = '<div class="git-loading"><div class="spinner"></div></div>';

  try {
    await loadAllData(project);

    // Update badges
    const changesBadge = document.getElementById('git-changes-badge');
    if (changesBadge && changesData?.files) {
      changesBadge.textContent = changesData.files.length;
      changesBadge.style.display = changesData.files.length > 0 ? '' : 'none';
    }

    renderGitTab();
  } catch (e) {
    if (content) content.innerHTML = `<div class="git-empty-state"><p>${t('gitTab.notGitRepo')}</p></div>`;
  }
}

function renderQuickActions() {
  const container = document.getElementById('git-quick-actions');
  if (!container) return;

  if (!selectedProject) {
    container.innerHTML = '';
    return;
  }

  const aheadText = aheadBehind?.ahead > 0 ? `<span class="git-badge ahead">${aheadBehind.ahead}↑</span>` : '';
  const behindText = aheadBehind?.behind > 0 ? `<span class="git-badge behind">${aheadBehind.behind}↓</span>` : '';

  container.innerHTML = `
    <div class="git-quick-actions-row">
      <button class="git-action-btn" id="git-btn-pull" ${!aheadBehind?.hasRemote ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="M17 11l-5 5-5-5"/></svg>
        ${t('gitTab.pull')} ${behindText}
      </button>
      <button class="git-action-btn" id="git-btn-push" ${!aheadBehind?.hasRemote ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21V9"/><path d="M7 14l5-5 5 5"/></svg>
        ${t('gitTab.push')} ${aheadText}
      </button>
      <button class="git-action-btn" id="git-btn-fetch" ${!aheadBehind?.hasRemote ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        ${t('gitTab.fetch')}
      </button>
    </div>
    <div class="git-branch-display">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
      <span>${escapeHtml(currentBranch || 'HEAD')}</span>
      ${aheadBehind?.hasRemote ? `<span class="git-sync-status">${aheadBehind.ahead === 0 && aheadBehind.behind === 0 ? '✓' : ''}</span>` : '<span class="git-no-remote">no remote</span>'}
    </div>
  `;

  document.getElementById('git-btn-pull')?.addEventListener('click', handlePull);
  document.getElementById('git-btn-push')?.addEventListener('click', handlePush);
  document.getElementById('git-btn-fetch')?.addEventListener('click', handleFetch);
}

function buildBranchTree(branches) {
  const tree = { _branches: [] };
  for (const branch of branches) {
    const parts = branch.split('/');
    if (parts.length === 1) {
      tree._branches.push(branch);
    } else {
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        const prefix = parts[i];
        if (!node[prefix]) node[prefix] = { _branches: [] };
        node = node[prefix];
      }
      node._branches.push(branch);
    }
  }
  return tree;
}

function renderBranchTreeNode(node, type, depth) {
  let html = '';
  const indent = depth * 14;

  // Render sub-folders first
  const folders = Object.keys(node).filter(k => k !== '_branches').sort();
  for (const folder of folders) {
    const subNode = node[folder];
    const count = countBranchesInNode(subNode);
    html += `<div class="git-branch-folder">
      <div class="git-branch-folder-header" style="padding-left:${8 + indent}px">
        <span class="git-branch-folder-chevron">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        </span>
        <span class="git-branch-folder-name">${escapeHtml(folder)}/</span>
        <span class="git-branch-folder-count">${count}</span>
      </div>
      <div class="git-branch-folder-children">
        ${renderBranchTreeNode(subNode, type, depth + 1)}
      </div>
    </div>`;
  }

  // Render branches
  for (const branch of (node._branches || [])) {
    const isCurrent = branch === currentBranch;
    const shortName = branch.includes('/') ? branch.split('/').pop() : branch;
    const isLocal = type === 'local';

    html += `<div class="git-branch-item ${isCurrent ? 'current' : ''} ${!isLocal ? 'remote' : ''}" data-branch="${escapeAttr(branch)}" data-type="${type}" style="padding-left:${8 + indent}px">
      <span class="git-branch-name">${isCurrent ? '<span class="git-branch-dot">●</span> ' : ''}${escapeHtml(shortName)}</span>
      <div class="git-branch-actions">
        ${!isCurrent && isLocal ? `<button class="git-branch-action-btn checkout" title="Checkout"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button>` : ''}
        ${!isCurrent && isLocal ? `<button class="git-branch-action-btn merge" title="${t('gitTab.mergeBranch')}"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg></button>` : ''}
        ${!isCurrent && isLocal ? `<button class="git-branch-action-btn delete" title="${t('common.delete')}"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>` : ''}
        ${!isLocal ? `<button class="git-branch-action-btn checkout" title="Checkout"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></button>` : ''}
      </div>
    </div>`;
  }

  return html;
}

function countBranchesInNode(node) {
  let count = (node._branches || []).length;
  for (const key of Object.keys(node)) {
    if (key !== '_branches') count += countBranchesInNode(node[key]);
  }
  return count;
}

function renderBranches() {
  const container = document.getElementById('git-branches-list');
  if (!container || !branchesData) {
    if (container) container.innerHTML = '';
    return;
  }

  let html = '';

  // Local branches
  if (branchesData.local?.length > 0) {
    html += `<div class="git-branch-group-label">${t('gitTab.localBranches')}</div>`;
    const localTree = buildBranchTree(branchesData.local);
    html += renderBranchTreeNode(localTree, 'local', 0);
  }

  // Remote branches (strip origin/ prefix for grouping, but keep full name in data-branch)
  if (branchesData.remote?.length > 0) {
    html += `<div class="git-branch-group-label">${t('gitTab.remoteBranches')}</div>`;
    const remoteTree = buildBranchTree(branchesData.remote);
    html += renderBranchTreeNode(remoteTree, 'remote', 0);
  }

  container.innerHTML = html;

  // Delegated click handler for branches
  container.onclick = (e) => {
    const header = e.target.closest('.git-branch-folder-header');
    if (header) {
      e.stopPropagation();
      const chevron = header.querySelector('.git-branch-folder-chevron');
      const children = header.nextElementSibling;
      if (chevron && children) {
        chevron.classList.toggle('collapsed');
        children.classList.toggle('collapsed');
      }
      return;
    }
    const btn = e.target.closest('.git-branch-action-btn');
    if (btn) {
      e.stopPropagation();
      const branch = btn.closest('.git-branch-item').dataset.branch;
      if (btn.classList.contains('checkout')) handleCheckout(branch);
      else if (btn.classList.contains('merge')) handleMerge(branch);
      else if (btn.classList.contains('delete')) handleDeleteBranch(branch);
    }
  };

  // New branch button
  document.getElementById('git-btn-new-branch')?.addEventListener('click', handleCreateBranch);
}

function renderStashes() {
  const container = document.getElementById('git-stashes-list');
  if (!container) return;

  // Stash save button in header
  const stashHeader = container.closest('.git-sidebar-section')?.querySelector('.git-sidebar-section-title');
  if (stashHeader && !stashHeader.querySelector('.git-stash-save-btn')) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'git-stash-save-btn';
    saveBtn.title = t('gitTab.stashSave');
    saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
    saveBtn.onclick = handleStashSave;
    stashHeader.appendChild(saveBtn);
  }

  if (!stashesData || stashesData.length === 0) {
    container.innerHTML = `<div class="git-sidebar-empty">${t('gitTab.noStashes')}</div>`;
    return;
  }

  let html = '';
  for (const stash of stashesData) {
    html += `<div class="git-stash-item" data-ref="${escapeAttr(stash.ref)}">
      <div class="git-stash-info">
        <span class="git-stash-ref">${escapeHtml(stash.ref)}</span>
        <span class="git-stash-msg">${escapeHtml(stash.message)}</span>
        <span class="git-stash-date">${escapeHtml(stash.date)}</span>
      </div>
      <div class="git-stash-actions">
        <button class="git-stash-btn apply" title="${t('gitTab.applyStash')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        </button>
        <button class="git-stash-btn drop" title="${t('gitTab.dropStash')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </div>
    </div>`;
  }

  container.innerHTML = html;

  // Delegated click handler for stashes
  container.onclick = (e) => {
    const btn = e.target.closest('.git-stash-btn');
    if (!btn) return;
    const ref = btn.closest('.git-stash-item').dataset.ref;
    if (btn.classList.contains('apply')) handleStashApply(ref);
    else if (btn.classList.contains('drop')) handleStashDrop(ref);
  };
}

function renderSubTabContent() {
  const content = document.getElementById('git-sub-content');
  if (!content || !selectedProject) return;

  // Merge conflict banner
  let bannerHtml = '';
  if (mergeInProgress) {
    const conflictCount = conflictFiles.length;
    const canContinue = conflictCount === 0;
    bannerHtml = `<div class="git-merge-banner">
      <div class="git-merge-banner-content">
        <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
        <span class="git-merge-banner-text">
          <strong>${t('gitTab.mergeInProgress')}</strong> — ${t('gitTab.conflictsDetected').replace('{count}', conflictCount)}
        </span>
      </div>
      <div class="git-merge-banner-actions">
        <button class="git-merge-btn abort" id="git-merge-abort-btn">${t('gitTab.abortMerge')}</button>
        <button class="git-merge-btn continue ${canContinue ? '' : 'disabled'}" id="git-merge-continue-btn" ${canContinue ? '' : 'disabled'}>${t('gitTab.continueMerge')}</button>
      </div>
    </div>`;
  }

  // Render the content with optional banner
  let innerHtml = '';
  const tempDiv = document.createElement('div');

  switch (currentSubTab) {
    case 'changes': renderChanges(tempDiv); break;
    case 'history': renderHistory(tempDiv); break;
    case 'pullrequests': renderPullRequests(tempDiv); break;
  }

  content.innerHTML = bannerHtml + tempDiv.innerHTML;

  // Re-bind events based on sub-tab
  switch (currentSubTab) {
    case 'changes': bindChangesEvents(content); break;
    case 'history': bindHistoryEvents(content); break;
    case 'pullrequests': bindPullRequestEvents(content); break;
  }

  // Bind merge banner buttons
  if (mergeInProgress) {
    document.getElementById('git-merge-abort-btn')?.addEventListener('click', handleMergeAbort);
    document.getElementById('git-merge-continue-btn')?.addEventListener('click', handleMergeContinue);
  }
}

// ========== CHANGES SUB-TAB ==========

function renderChanges(container) {
  if (!changesData || !changesData.success) {
    container.innerHTML = `<div class="git-empty-state"><p>${t('gitTab.notGitRepo')}</p></div>`;
    return;
  }

  const files = changesData.files || [];
  const staged = files.filter(f => f.staged);
  const unstaged = files.filter(f => !f.staged && f.status !== '?');
  const untracked = files.filter(f => f.status === '?');

  if (files.length === 0) {
    container.innerHTML = `<div class="git-empty-state git-clean-state">
      <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
      <p>${t('gitTab.noChanges')}</p>
    </div>`;
    return;
  }

  let html = '<div class="git-changes-container">';

  // Conflict files section (when merge in progress)
  if (mergeInProgress && conflictFiles.length > 0) {
    html += `<div class="git-file-section git-conflict-section">
      <div class="git-file-section-header">
        <span class="git-file-section-title git-conflict-title">${t('gitTab.conflictsDetected').replace('{count}', conflictFiles.length)}</span>
      </div>
      <div class="git-file-list">
        ${conflictFiles.map(f => {
          const name = fileBasename(f);
          const dir = fileDir(f);
          return `<div class="git-file-item git-conflict-file" data-path="${escapeAttr(f)}">
            <div class="git-file-info">
              <span class="git-status-badge conflict">C</span>
              <span class="git-file-name">${escapeHtml(name)}</span>
              ${dir ? `<span class="git-file-dir">${escapeHtml(dir)}</span>` : ''}
            </div>
            <div class="git-file-actions">
              <button class="git-file-btn diff-btn" title="${t('gitTab.viewDiff')}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
              </button>
              <button class="git-file-btn open-editor-btn" title="${t('gitTab.openInEditor')}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
              </button>
              <button class="git-file-btn resolve-btn" title="${t('gitTab.markResolved')}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              </button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // Staged section
  html += `<div class="git-file-section">
    <div class="git-file-section-header">
      <span class="git-file-section-title">${t('gitTab.stagedFiles')} (${staged.length})</span>
      ${staged.length > 0 ? `<button class="git-section-btn" id="git-unstage-all">${t('gitTab.unstageAll')}</button>` : ''}
    </div>
    <div class="git-file-list">
      ${staged.length === 0 ? '<div class="git-file-empty">No staged files</div>' : staged.map(f => renderFileItem(f, true)).join('')}
    </div>
  </div>`;

  // Unstaged section
  html += `<div class="git-file-section">
    <div class="git-file-section-header">
      <span class="git-file-section-title">${t('gitTab.unstagedFiles')} (${unstaged.length})</span>
      ${unstaged.length > 0 ? `<button class="git-section-btn" id="git-stage-all-unstaged">${t('gitTab.stageAll')}</button>` : ''}
    </div>
    <div class="git-file-list">
      ${unstaged.length === 0 ? '<div class="git-file-empty">No unstaged changes</div>' : unstaged.map(f => renderFileItem(f, false)).join('')}
    </div>
  </div>`;

  // Untracked section
  if (untracked.length > 0) {
    html += `<div class="git-file-section">
      <div class="git-file-section-header">
        <span class="git-file-section-title">${t('gitTab.untrackedFiles')} (${untracked.length})</span>
        <button class="git-section-btn" id="git-stage-all-untracked">${t('gitTab.stageAll')}</button>
      </div>
      <div class="git-file-list">
        ${untracked.map(f => renderFileItem(f, false)).join('')}
      </div>
    </div>`;
  }

  // Commit form
  html += `<div class="git-commit-form">
    <div class="git-commit-form-header">
      <span>${t('gitTab.commitMessage')}</span>
      <button class="git-generate-btn" id="git-tab-generate-msg">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 2L15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2z"/></svg>
        ${t('gitTab.generateMsg')}
      </button>
    </div>
    <textarea class="git-commit-textarea" id="git-tab-commit-msg" placeholder="${t('gitTab.commitMessage')}" rows="3"></textarea>
    <div class="git-commit-form-actions">
      <button class="git-commit-btn" id="git-tab-commit-btn" ${staged.length === 0 ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        ${t('gitTab.commit')} (${staged.length})
      </button>
    </div>
  </div>`;

  html += '</div>';
  container.innerHTML = html;
}

function renderFileItem(file, isStaged) {
  const dir = fileDir(file.path);
  const name = fileBasename(file.path);
  const diffInfo = file.additions || file.deletions ?
    `<span class="git-file-diff"><span class="git-diff-add">+${file.additions}</span><span class="git-diff-del">-${file.deletions}</span></span>` : '';

  return `<div class="git-file-item" data-path="${escapeAttr(file.path)}" data-staged="${isStaged}">
    <div class="git-file-info">
      ${getStatusIcon(file.status)}
      <span class="git-file-name">${escapeHtml(name)}</span>
      ${dir ? `<span class="git-file-dir">${escapeHtml(dir)}</span>` : ''}
      ${diffInfo}
    </div>
    <div class="git-file-actions">
      <button class="git-file-btn diff-btn" title="${t('gitTab.viewDiff')}">
        <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 19H5V5h7V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>
      </button>
      ${isStaged
        ? `<button class="git-file-btn unstage-btn" title="${t('gitTab.unstageSelected')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 13H5v-2h14v2z"/></svg>
          </button>`
        : `<button class="git-file-btn stage-btn" title="${t('gitTab.stageSelected')}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
          </button>`
      }
    </div>
  </div>`;
}

function bindChangesEvents(container) {
  // Delegated click handler for all changes actions
  container.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    e.stopPropagation();

    const fileItem = btn.closest('.git-file-item');

    // File action buttons
    if (btn.classList.contains('stage-btn') && fileItem) {
      handleStageFiles([fileItem.dataset.path]);
    } else if (btn.classList.contains('unstage-btn') && fileItem) {
      handleUnstageFiles([fileItem.dataset.path]);
    } else if (btn.classList.contains('diff-btn') && fileItem) {
      handleViewDiff(fileItem.dataset.path, fileItem.dataset.staged === 'true');
    } else if (btn.classList.contains('open-editor-btn') && fileItem) {
      const fullPath = window.electron_nodeModules.path.join(selectedProject.path, fileItem.dataset.path);
      api.dialog.openInEditor({ filePath: fullPath });
    } else if (btn.classList.contains('resolve-btn') && fileItem) {
      handleMarkResolved(fileItem.dataset.path);
    }

    // Bulk actions
    if (btn.id === 'git-unstage-all') {
      const staged = (changesData?.files || []).filter(f => f.staged).map(f => f.path);
      if (staged.length > 0) handleUnstageFiles(staged);
    } else if (btn.id === 'git-stage-all-unstaged') {
      const unstaged = (changesData?.files || []).filter(f => !f.staged && f.status !== '?').map(f => f.path);
      if (unstaged.length > 0) handleStageFiles(unstaged);
    } else if (btn.id === 'git-stage-all-untracked') {
      const untracked = (changesData?.files || []).filter(f => f.status === '?').map(f => f.path);
      if (untracked.length > 0) handleStageFiles(untracked);
    } else if (btn.id === 'git-tab-commit-btn') {
      handleCommit();
    } else if (btn.id === 'git-tab-generate-msg') {
      handleGenerateMessage();
    }
  };
}

// ========== HISTORY SUB-TAB ==========

const GRAPH_COLORS = [
  '#06b6d4', // cyan
  '#22c55e', // green
  '#a855f7', // purple
  '#ec4899', // pink
  '#f59e0b', // amber
  '#3b82f6', // blue
  '#ef4444', // red
  '#14b8a6', // teal
  '#f97316', // orange
  '#8b5cf6', // violet
];

const LANE_W = 14;
const ROW_H = 34;
const MAX_LANES = 8;
let historyScrollObserver = null;
let historyLoadingMore = false;
let historyHasMore = true;

/**
 * Graph lane algorithm - tracks which lanes are active across rows.
 * Each lane holds a commit hash that is "expected" to appear in a future row.
 * When a commit appears, it occupies its expected lane and sets up its parents.
 * Capped at MAX_LANES to prevent visual explosion with --all.
 */
function computeGraphLanes(commits) {
  const activeLanes = []; // array of hashes or null
  const result = [];

  for (let idx = 0; idx < commits.length; idx++) {
    const commit = commits[idx];
    const { fullHash, parents } = commit;

    // Find which lane this commit was expected in
    let lane = activeLanes.indexOf(fullHash);
    if (lane === -1) {
      // New branch head - find first empty slot or append (respecting max)
      lane = activeLanes.indexOf(null);
      if (lane === -1) {
        if (activeLanes.length < MAX_LANES) {
          lane = activeLanes.length;
          activeLanes.push(null);
        } else {
          // Over max lanes - reuse lane 0 as fallback
          lane = 0;
        }
      }
    }

    // Snapshot lanes before modification to draw correct pass-through lines
    const lanesBefore = activeLanes.slice();

    // Determine where each parent will go
    const parentLanes = [];
    const isMerge = parents.length > 1;

    if (parents.length === 0) {
      // Root commit - lane dies
      activeLanes[lane] = null;
    } else {
      // First parent inherits current lane
      activeLanes[lane] = parents[0];
      parentLanes.push(lane);

      // Additional parents (merge sources)
      for (let p = 1; p < parents.length; p++) {
        const ph = parents[p];
        let pl = activeLanes.indexOf(ph);
        if (pl === -1) {
          // Try to find an empty slot or append (respecting max)
          pl = activeLanes.indexOf(null);
          if (pl === -1 && activeLanes.length < MAX_LANES) {
            pl = activeLanes.length;
            activeLanes.push(null);
          }
          if (pl !== -1) {
            activeLanes[pl] = ph;
          }
        }
        if (pl !== -1) {
          parentLanes.push(pl);
        }
      }
    }

    // Check for lane convergence: if a hash appears in multiple lanes after
    // first parent assignment, collapse duplicates
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null) continue;
      const first = activeLanes.indexOf(activeLanes[i]);
      if (first !== i) {
        activeLanes[i] = null;
      }
    }

    // Trim trailing null lanes to keep graph compact
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }

    const totalLanes = Math.max(activeLanes.length, lane + 1);

    result.push({
      commit,
      lane,
      isMerge,
      parentLanes,
      lanesBefore,
      lanesAfter: activeLanes.slice(),
      totalLanes
    });
  }

  return result;
}

/**
 * Render one SVG cell for a commit row (IntelliJ-style).
 * Smooth S-curves for merges/forks. Straight verticals for pass-through.
 * Uses lanesBefore/lanesAfter to ensure perfect continuity between rows.
 */
function renderGraphSvg(row, maxLanes, isFirst, isLast) {
  const w = Math.max(maxLanes * LANE_W + 6, 24);
  const cy = ROW_H / 2;
  const laneX = (i) => i * LANE_W + LANE_W / 2 + 2;
  const cx = laneX(row.lane);
  const nodeColor = GRAPH_COLORS[row.lane % GRAPH_COLORS.length];

  let svg = '';

  // Collect all lane indices appearing in before or after
  const allLaneIndices = new Set();
  row.lanesBefore.forEach((h, i) => { if (h !== null) allLaneIndices.add(i); });
  row.lanesAfter.forEach((h, i) => { if (h !== null) allLaneIndices.add(i); });
  allLaneIndices.add(row.lane);

  for (const i of allLaneIndices) {
    if (i === row.lane) continue;
    const color = GRAPH_COLORS[i % GRAPH_COLORS.length];
    const x = laneX(i);
    const existsBefore = i < row.lanesBefore.length && row.lanesBefore[i] !== null;
    const existsAfter = i < row.lanesAfter.length && row.lanesAfter[i] !== null;
    const isMergeSource = row.parentLanes.includes(i) && i !== row.lane;

    if (isMergeSource) {
      // This lane is a merge parent of the current commit
      if (existsBefore && existsAfter) {
        // Lane passes through AND is a merge source - vertical + branch-off curve
        svg += `<line x1="${x}" y1="0" x2="${x}" y2="${ROW_H}" stroke="${color}" stroke-width="2"/>`;
        // Small curve branching from the vertical to the commit node
        svg += `<path d="M${x},${cy - 6} C${x},${cy} ${cx},${cy - 4} ${cx},${cy}" stroke="${color}" stroke-width="2" fill="none"/>`;
      } else if (existsBefore) {
        // Lane ends by merging - smooth S-curve from top to commit node
        svg += `<path d="M${x},0 C${x},${cy * 0.7} ${cx},${cy * 0.3} ${cx},${cy}" stroke="${color}" stroke-width="2" fill="none"/>`;
      } else {
        // Merge source with no top connection - just curve to node
        svg += `<path d="M${x},${cy} L${cx},${cy}" stroke="${color}" stroke-width="2" fill="none"/>`;
      }
    } else if (existsBefore && existsAfter) {
      // Simple pass-through - straight vertical
      svg += `<line x1="${x}" y1="0" x2="${x}" y2="${ROW_H}" stroke="${color}" stroke-width="2"/>`;
    } else if (existsBefore && !existsAfter) {
      // Lane converges/ends - smooth S-curve from top into commit node
      svg += `<path d="M${x},0 C${x},${cy * 0.7} ${cx},${cy * 0.3} ${cx},${cy}" stroke="${color}" stroke-width="2" fill="none"/>`;
    } else if (!existsBefore && existsAfter) {
      // New lane forks out - smooth S-curve from commit node to bottom
      const half = ROW_H - cy;
      svg += `<path d="M${cx},${cy} C${cx},${cy + half * 0.3} ${x},${cy + half * 0.7} ${x},${ROW_H}" stroke="${nodeColor}" stroke-width="2" fill="none"/>`;
    }
  }

  // Commit's own lane - vertical lines above/below the node
  const ownBefore = row.lane < row.lanesBefore.length && row.lanesBefore[row.lane] !== null;
  const ownAfter = row.lane < row.lanesAfter.length && row.lanesAfter[row.lane] !== null;

  if (!isFirst && ownBefore) {
    svg += `<line x1="${cx}" y1="0" x2="${cx}" y2="${cy}" stroke="${nodeColor}" stroke-width="2"/>`;
  }
  if (!isLast && ownAfter) {
    svg += `<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${ROW_H}" stroke="${nodeColor}" stroke-width="2"/>`;
  }

  // Commit node circle - drawn last to be on top
  const r = row.isMerge ? 5 : 4;
  svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${nodeColor}" stroke="var(--bg-primary)" stroke-width="2"/>`;

  return `<svg class="git-graph-svg" width="${w}" height="${ROW_H}" viewBox="0 0 ${w} ${ROW_H}" xmlns="http://www.w3.org/2000/svg">${svg}</svg>`;
}

function renderDecorations(decorationsRaw) {
  if (!decorationsRaw || !decorationsRaw.trim()) return '';
  const refs = decorationsRaw.split(',').map(r => r.trim()).filter(Boolean);
  let html = '<span class="git-decorations">';
  for (const ref of refs) {
    if (ref.startsWith('HEAD -> ')) {
      const branch = ref.replace('HEAD -> ', '');
      html += `<span class="git-deco git-deco-head">${escapeHtml(branch)}</span>`;
    } else if (ref.startsWith('tag: ')) {
      const tag = ref.replace('tag: ', '');
      html += `<span class="git-deco git-deco-tag">${escapeHtml(tag)}</span>`;
    } else if (ref.startsWith('origin/') || ref.includes('/')) {
      html += `<span class="git-deco git-deco-remote">${escapeHtml(ref)}</span>`;
    } else if (ref === 'HEAD') {
      continue; // skip bare HEAD
    } else {
      html += `<span class="git-deco git-deco-branch">${escapeHtml(ref)}</span>`;
    }
  }
  html += '</span>';
  return html;
}

function buildHistoryToolbar(commits) {
  const authors = [...new Set(commits.map(c => c.author))].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const localBranches = branchesData?.local || [];
  const remoteBranches = (branchesData?.remote || []).map(b => 'origin/' + b);

  let html = '<div class="git-history-toolbar">';

  // Branch filter - custom styled
  html += '<div class="git-filter-group">';
  html += `<svg class="git-filter-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;
  html += `<select class="git-history-select" id="git-history-branch-filter">`;
  // Current branch (default) - shown when not filtering by a specific branch or --all
  const currentSelected = !historyAllBranches && !historyBranchFilter ? 'selected' : '';
  html += `<option value="" ${currentSelected}>● ${escapeHtml(currentBranch || 'HEAD')}</option>`;
  html += `<option value="__all__" ${historyAllBranches ? 'selected' : ''}>${t('gitTab.allBranches')}</option>`;
  if (localBranches.length > 0) {
    html += `<optgroup label="${t('gitTab.localBranches')}">`;
    for (const b of localBranches) {
      if (b === currentBranch) continue; // already shown as default option
      const selected = !historyAllBranches && historyBranchFilter === b ? 'selected' : '';
      html += `<option value="${escapeAttr(b)}" ${selected}>${escapeHtml(b)}</option>`;
    }
    html += '</optgroup>';
  }
  if (remoteBranches.length > 0) {
    html += `<optgroup label="${t('gitTab.remoteBranches')}">`;
    for (const b of remoteBranches) {
      const selected = !historyAllBranches && historyBranchFilter === b ? 'selected' : '';
      html += `<option value="${escapeAttr(b)}" ${selected}>${escapeHtml(b)}</option>`;
    }
    html += '</optgroup>';
  }
  html += '</select></div>';

  // Author filter
  if (authors.length > 1) {
    html += '<div class="git-filter-group">';
    html += `<svg class="git-filter-icon" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>`;
    html += `<select class="git-history-select" id="git-history-author-filter">`;
    html += `<option value="">${t('gitTab.allAuthors')} (${authors.length})</option>`;
    for (const a of authors) {
      const count = commits.filter(c => c.author === a).length;
      const selected = historyAuthorFilter === a ? 'selected' : '';
      html += `<option value="${escapeAttr(a)}" ${selected}>${escapeHtml(a)} (${count})</option>`;
    }
    html += '</select></div>';
  }

  // Commit count indicator
  html += `<span class="git-history-count">${commits.length} commits</span>`;

  html += '</div>';
  return html;
}

function renderHistory(container) {
  if (!historyData || historyData.length === 0) {
    container.innerHTML = `<div class="git-empty-state"><p>${t('gitTab.noCommits')}</p></div>`;
    return;
  }

  // Apply author filter client-side
  const filtered = historyAuthorFilter
    ? historyData.filter(c => c.author === historyAuthorFilter)
    : historyData;

  const graphRows = computeGraphLanes(filtered);
  const maxLanes = graphRows.reduce((max, r) => Math.max(max, r.totalLanes), 1);

  let html = '<div class="git-history-container" id="git-history-scroll-container">';
  html += buildHistoryToolbar(historyData);
  html += '<div class="git-history-list">';

  for (let i = 0; i < graphRows.length; i++) {
    const row = graphRows[i];
    const commit = row.commit;
    const isFirst = i === 0;
    const isLast = i === graphRows.length - 1;
    const svgHtml = renderGraphSvg(row, maxLanes, isFirst, isLast);
    const decoHtml = renderDecorations(commit.decorations);

    html += `<div class="git-commit-item" data-hash="${escapeAttr(commit.fullHash)}">
      ${svgHtml}
      <div class="git-commit-main">
        <span class="git-commit-hash">${escapeHtml(commit.hash)}</span>
        ${decoHtml}
        <span class="git-commit-message">${escapeHtml(commit.message)}</span>
      </div>
      <div class="git-commit-meta">
        <span class="git-commit-author">${escapeHtml(commit.author)}</span>
        <span class="git-commit-date">${escapeHtml(commit.date)}</span>
      </div>
      <div class="git-commit-actions">
        <button class="git-commit-action-btn detail" title="${t('gitTab.detail')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
        </button>
        <button class="git-commit-action-btn cherry-pick" title="${t('gitTab.cherryPick')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M17 20.41L18.41 19 15 15.59 13.59 17 17 20.41zM7.5 8H11v5.59L5.59 19 7 20.41l6-6V8h3.5L12 3.5 7.5 8z"/></svg>
        </button>
        <button class="git-commit-action-btn revert" title="${t('gitTab.revert')}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/></svg>
        </button>
      </div>
    </div>`;
  }

  html += '</div>';

  // Infinite scroll sentinel
  if (historyHasMore) {
    html += '<div class="git-history-sentinel" id="git-history-sentinel"><div class="git-history-loading-more"><div class="spinner-small"></div></div></div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

function bindHistoryEvents(container) {
  // Delegated click handler for history actions
  container.onclick = (e) => {
    const btn = e.target.closest('.git-commit-action-btn');
    if (btn) {
      const hash = btn.closest('.git-commit-item').dataset.hash;
      if (btn.classList.contains('detail')) handleCommitDetail(hash);
      else if (btn.classList.contains('cherry-pick')) handleCherryPick(hash);
      else if (btn.classList.contains('revert')) handleRevert(hash);
      return;
    }
  };

  // Branch filter
  const branchSelect = container.querySelector('#git-history-branch-filter');
  if (branchSelect) {
    branchSelect.onchange = async () => {
      const val = branchSelect.value;
      if (val === '__all__') {
        historyBranchFilter = '';
        historyAllBranches = true;
      } else {
        historyBranchFilter = val;
        historyAllBranches = false;
      }
      historyPage = 0;
      historyHasMore = true;
      historyData = await api.git.commitHistory({
        projectPath: selectedProject.path,
        skip: 0,
        limit: 50,
        branch: historyBranchFilter,
        allBranches: historyAllBranches
      });
      if (historyData.length < 50) historyHasMore = false;
      renderSubTabContent();
    };
  }

  // Author filter (client-side only)
  const authorSelect = container.querySelector('#git-history-author-filter');
  if (authorSelect) {
    authorSelect.onchange = () => {
      historyAuthorFilter = authorSelect.value;
      renderSubTabContent();
    };
  }

  // Infinite scroll with IntersectionObserver
  setupHistoryInfiniteScroll();
}

function setupHistoryInfiniteScroll() {
  // Cleanup previous observer
  if (historyScrollObserver) {
    historyScrollObserver.disconnect();
    historyScrollObserver = null;
  }

  const sentinel = document.getElementById('git-history-sentinel');
  if (!sentinel || !historyHasMore) return;

  // Find the scrollable parent (git-sub-content or the main content area)
  const scrollParent = sentinel.closest('.git-sub-content') || sentinel.closest('#git-sub-content') || sentinel.closest('.git-history-container')?.parentElement;

  historyScrollObserver = new IntersectionObserver(async (entries) => {
    const entry = entries[0];
    if (!entry.isIntersecting || historyLoadingMore || !historyHasMore) return;

    historyLoadingMore = true;
    sentinel.style.display = '';

    historyPage++;
    const more = await api.git.commitHistory({
      projectPath: selectedProject.path,
      skip: historyPage * 50,
      limit: 50,
      branch: historyBranchFilter,
      allBranches: historyAllBranches
    });

    if (more && more.length > 0) {
      historyData = historyData.concat(more);
      if (more.length < 50) historyHasMore = false;
      // Re-render the whole list to recompute graph lanes properly
      renderSubTabContent();
    } else {
      historyHasMore = false;
      sentinel.style.display = 'none';
    }

    historyLoadingMore = false;
  }, { threshold: 0.1 });

  historyScrollObserver.observe(sentinel);
}

// ========== PULL REQUESTS SUB-TAB ==========

function renderPullRequests(container) {
  if (!remoteUrl) {
    container.innerHTML = `<div class="git-empty-state"><p>${t('git.noRemote')}</p></div>`;
    return;
  }

  let html = '<div class="git-pr-container">';

  // Create PR form
  html += `<div class="git-pr-form">
    <h3>${t('gitTab.createPR')}</h3>
    <div class="git-pr-field">
      <label>${t('gitTab.prTitle')}</label>
      <input type="text" id="git-pr-title" class="git-pr-input" placeholder="Feature: ...">
    </div>
    <div class="git-pr-field">
      <label>${t('gitTab.prBody')}</label>
      <textarea id="git-pr-body" class="git-pr-textarea" rows="3" placeholder="Description..."></textarea>
    </div>
    <div class="git-pr-field-row">
      <div class="git-pr-field">
        <label>${t('gitTab.baseBranch')}</label>
        <select id="git-pr-base" class="git-pr-select">
          ${(branchesData?.local || []).map(b => `<option value="${escapeAttr(b)}" ${b === 'main' || b === 'master' ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>
      </div>
      <div class="git-pr-field">
        <label>${t('gitTab.headBranch')}</label>
        <select id="git-pr-head" class="git-pr-select">
          ${(branchesData?.local || []).map(b => `<option value="${escapeAttr(b)}" ${b === currentBranch ? 'selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>
      </div>
    </div>
    <button class="git-pr-create-btn" id="git-pr-create-btn">
      <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
      ${t('gitTab.createPR')}
    </button>
  </div>`;

  // PR list
  html += '<div class="git-pr-list">';
  if (prsData?.pullRequests?.length > 0) {
    for (const pr of prsData.pullRequests) {
      const stateClass = pr.state === 'merged' ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
      const stateLabel = pr.draft ? t('gitTab.draftPR') : t(`gitTab.${stateClass}PR`);
      html += `<div class="git-pr-item ${stateClass}" data-url="${escapeAttr(pr.url)}">
        <div class="git-pr-item-main">
          <span class="git-pr-state ${stateClass}">${stateLabel}</span>
          <span class="git-pr-number">#${pr.number}</span>
          <span class="git-pr-title-text">${escapeHtml(pr.title)}</span>
        </div>
        <div class="git-pr-item-meta">
          <span class="git-pr-author">${escapeHtml(pr.author || '')}</span>
          <span class="git-pr-updated">${new Date(pr.updatedAt).toLocaleDateString()}</span>
          ${pr.labels?.length > 0 ? pr.labels.map(l => `<span class="git-pr-label" style="background:#${l.color}20;color:#${l.color};border-color:#${l.color}40">${escapeHtml(l.name)}</span>`).join('') : ''}
        </div>
      </div>`;
    }
  } else {
    html += `<div class="git-empty-state"><p>${t('gitTab.noPullRequests')}</p></div>`;
  }
  html += '</div></div>';

  container.innerHTML = html;
}

function bindPullRequestEvents(container) {
  // Delegated click handler for PR actions
  container.onclick = (e) => {
    if (e.target.closest('#git-pr-create-btn')) {
      handleCreatePR();
      return;
    }
    const item = e.target.closest('.git-pr-item');
    if (item && item.dataset.url) api.dialog.openExternal(item.dataset.url);
  };
}

// ========== OPERATION HANDLERS ==========

async function handleStageFiles(files) {
  await withLock(async () => {
    const result = await api.git.stageFiles({ projectPath: selectedProject.path, files });
    if (result.success) {
      await refreshChanges();
      renderSubTabContent();
      renderSidebar();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleUnstageFiles(files) {
  await withLock(async () => {
    const result = await api.git.unstageFiles({ projectPath: selectedProject.path, files });
    if (result.success) {
      await refreshChanges();
      renderSubTabContent();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleCommit() {
  const msgEl = document.getElementById('git-tab-commit-msg');
  const message = msgEl?.value?.trim();
  if (!message) {
    showToast('Commit message is required', 'error');
    return;
  }

  await withLock(async () => {
    const result = await api.git.commit({ projectPath: selectedProject.path, message });
    if (result.success) {
      showToast('Commit created', 'success');
      if (msgEl) msgEl.value = '';
      await refreshChanges();
      historyData = await api.git.commitHistory({ projectPath: selectedProject.path, skip: 0, limit: 50, branch: historyBranchFilter, allBranches: historyAllBranches });
      historyPage = 0;
      historyHasMore = historyData.length >= 50;
      renderSubTabContent();
      renderSidebar();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleGenerateMessage() {
  if (!selectedProject || !changesData?.files) return;
  const btn = document.getElementById('git-tab-generate-msg');
  if (btn) btn.disabled = true;

  try {
    const result = await api.git.generateCommitMessage({
      projectPath: selectedProject.path,
      files: changesData.files
    });
    if (result.success && result.message) {
      const msgEl = document.getElementById('git-tab-commit-msg');
      if (msgEl) msgEl.value = result.message;
    } else {
      showToast(result.error || 'Failed to generate', 'error');
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleViewDiff(filePath, staged) {
  const diff = await api.git.fileDiff({ projectPath: selectedProject.path, filePath, staged });

  // Show in modal
  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  if (modalTitle) modalTitle.textContent = filePath;
  if (modalBody) {
    if (!diff) {
      modalBody.innerHTML = '<p style="color:var(--text-secondary);padding:16px">No diff available (new or binary file)</p>';
    } else {
      const lines = diff.split('\n').map(line => {
        const cls = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : line.startsWith('@@') ? 'diff-hunk' : '';
        return `<div class="diff-line ${cls}">${escapeHtml(line)}</div>`;
      }).join('');
      modalBody.innerHTML = `<div class="git-diff-view"><pre class="git-diff-content">${lines}</pre></div>`;
    }
  }
  if (modalFooter) modalFooter.style.display = 'none';
  if (modalOverlay) modalOverlay.classList.add('active');
}

async function handleCommitDetail(hash) {
  const detail = await api.git.commitDetail({ projectPath: selectedProject.path, commitHash: hash });

  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  if (modalTitle) modalTitle.textContent = `Commit ${hash.substring(0, 7)}`;
  if (modalBody) {
    modalBody.innerHTML = `<div class="git-diff-view"><pre class="git-diff-content">${escapeHtml(detail)}</pre></div>`;
  }
  if (modalFooter) modalFooter.style.display = 'none';
  if (modalOverlay) modalOverlay.classList.add('active');
}

async function handleCherryPick(hash) {
  if (!confirm(t('gitTab.confirmCherryPick').replace('{hash}', hash.substring(0, 7)))) return;
  await withLock(async () => {
    const result = await api.git.cherryPick({ projectPath: selectedProject.path, commitHash: hash });
    if (result.success) {
      showToast('Cherry-pick successful', 'success');
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleRevert(hash) {
  if (!confirm(t('gitTab.confirmRevert').replace('{hash}', hash.substring(0, 7)))) return;
  await withLock(async () => {
    const result = await api.git.revert({ projectPath: selectedProject.path, commitHash: hash });
    if (result.success) {
      showToast('Revert successful', 'success');
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleLoadMore() {
  if (!selectedProject || historyLoadingMore) return;
  historyLoadingMore = true;
  historyPage++;
  const more = await api.git.commitHistory({
    projectPath: selectedProject.path,
    skip: historyPage * 50,
    limit: 50,
    branch: historyBranchFilter,
    allBranches: historyAllBranches
  });
  if (more && more.length > 0) {
    historyData = historyData.concat(more);
    if (more.length < 50) historyHasMore = false;
    renderSubTabContent();
  } else {
    historyHasMore = false;
  }
  historyLoadingMore = false;
}

async function handlePull() {
  await withLock(async () => {
    showToast(t('git.pulling'), 'info');
    const result = await api.git.pull({ projectPath: selectedProject.path });
    if (result.success) {
      showToast(result.output || 'Pull successful', 'success');
    } else if (result.hasConflicts) {
      showToast(t('gitTab.mergeInProgress'), 'warning');
    } else {
      showToast(result.error, 'error');
    }
    await loadAllData(selectedProject);
    renderGitTab();
  });
}

async function handlePush() {
  await withLock(async () => {
    showToast(t('git.pushing'), 'info');
    const result = await api.git.push({ projectPath: selectedProject.path });
    if (result.success) {
      showToast(result.output || 'Push successful', 'success');
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleFetch() {
  await withLock(async () => {
    showToast('Fetching...', 'info');
    // Fetch is done via infoFull with skipFetch=false
    const info = await api.git.infoFull(selectedProject.path);
    aheadBehind = info?.aheadBehind || aheadBehind;
    renderQuickActions();
    showToast('Fetch complete', 'success');
  });
}

async function handleCheckout(branch) {
  await withLock(async () => {
    const result = await api.git.checkout({ projectPath: selectedProject.path, branch });
    if (result.success) {
      showToast(result.output || `Switched to ${branch}`, 'success');
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleCreateBranch() {
  const name = prompt(t('gitTab.newBranch'));
  if (!name || !name.trim()) return;
  await withLock(async () => {
    const result = await api.git.createBranch({ projectPath: selectedProject.path, branch: name.trim() });
    if (result.success) {
      showToast(result.output || `Created ${name}`, 'success');
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleDeleteBranch(branch) {
  if (!confirm(t('gitTab.deleteBranch').replace('{name}', branch))) return;
  await withLock(async () => {
    const result = await api.git.deleteBranch({ projectPath: selectedProject.path, branch });
    if (result.success) {
      showToast(`Deleted ${branch}`, 'success');
      await refreshBranches();
      renderBranches();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleMerge(branch) {
  if (!confirm(`Merge "${branch}" into "${currentBranch}"?`)) return;
  await withLock(async () => {
    const result = await api.git.merge({ projectPath: selectedProject.path, branch });
    if (result.success) {
      showToast(result.output || 'Merge successful', 'success');
    } else if (result.hasConflicts) {
      showToast(t('gitTab.mergeInProgress'), 'warning');
    } else {
      showToast(result.error, 'error');
    }
    await loadAllData(selectedProject);
    renderGitTab();
  });
}

async function handleMergeAbort() {
  if (!confirm(t('gitTab.abortMerge') + '?')) return;
  await withLock(async () => {
    const result = await api.git.mergeAbort({ projectPath: selectedProject.path });
    if (result.success) {
      showToast('Merge aborted', 'success');
      mergeInProgress = false;
      conflictFiles = [];
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleMergeContinue() {
  await withLock(async () => {
    const result = await api.git.mergeContinue({ projectPath: selectedProject.path });
    if (result.success) {
      showToast('Merge completed', 'success');
      mergeInProgress = false;
      conflictFiles = [];
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleMarkResolved(filePath) {
  await withLock(async () => {
    const result = await api.git.stageFiles({ projectPath: selectedProject.path, files: [filePath] });
    if (result.success) {
      showToast(`${fileBasename(filePath)} ${t('gitTab.markResolved').toLowerCase()}`, 'success');
      await refreshChanges();
      renderSubTabContent();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleStashSave() {
  if (!selectedProject) return;
  const message = prompt(t('gitTab.stashMessage'));
  if (message === null) return; // Cancelled
  await withLock(async () => {
    const result = await api.git.stashSave({ projectPath: selectedProject.path, message: message || '' });
    if (result.success) {
      showToast(t('gitTab.stashSave'), 'success');
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleStashApply(ref) {
  await withLock(async () => {
    const result = await api.git.stashApply({ projectPath: selectedProject.path, stashRef: ref });
    if (result.success) {
      showToast('Stash applied', 'success');
      await loadAllData(selectedProject);
      renderGitTab();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleStashDrop(ref) {
  if (!confirm(t('gitTab.confirmDropStash').replace('{ref}', ref))) return;
  await withLock(async () => {
    const result = await api.git.stashDrop({ projectPath: selectedProject.path, stashRef: ref });
    if (result.success) {
      showToast('Stash dropped', 'success');
      const info = await api.git.infoFull(selectedProject.path);
      stashesData = info?.stashes || [];
      renderStashes();
    } else {
      showToast(result.error, 'error');
    }
  });
}

async function handleCreatePR() {
  const title = document.getElementById('git-pr-title')?.value?.trim();
  const body = document.getElementById('git-pr-body')?.value?.trim() || '';
  const base = document.getElementById('git-pr-base')?.value;
  const head = document.getElementById('git-pr-head')?.value;

  if (!title) {
    showToast('PR title is required', 'error');
    return;
  }

  await withLock(async () => {
    const result = await api.github.createPR({ remoteUrl, title, body, head, base });
    if (result.success) {
      showToast(`PR #${result.pr.number} created`, 'success');
      if (result.pr.url) api.dialog.openExternal(result.pr.url);
      // Refresh PRs
      prsData = await api.github.pullRequests(remoteUrl);
      const content = document.getElementById('git-sub-content');
      if (content && currentSubTab === 'pullrequests') renderPullRequests(content);
    } else {
      showToast(result.error, 'error');
    }
  });
}

// ========== TOAST HELPER ==========
function showToast(message, type = 'info') {
  Toast.showToast({ message, type, duration: 4000 });
}

// ========== INIT & EXPORT ==========

function initGitTab() {
  // Sub-tab navigation
  // Delegated sub-tab navigation
  const subTabContainer = document.querySelector('.git-sub-tabs');
  if (subTabContainer) {
    subTabContainer.onclick = (e) => {
      const tab = e.target.closest('.git-sub-tab');
      if (!tab) return;
      currentSubTab = tab.dataset.subtab;
      subTabContainer.querySelectorAll('.git-sub-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderSubTabContent();
    };
  }
}

module.exports = {
  initGitTab,
  selectProject: selectProjectById,
  renderGitTab,
  renderProjectsList
};
