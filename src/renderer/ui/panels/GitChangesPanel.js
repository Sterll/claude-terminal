/**
 * GitChangesPanel
 * Git staging area with file selection, commit message generation, and commit
 * Extracted from renderer.js
 */

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { getSetting } = require('../../state');
const { createModal, showModal, closeModal } = require('../components/Modal');

const api = window.electron_api;

let showToast = null;
let showGitToast = null;
let getCurrentFilterProjectId = null;
let getEffectiveGitPath = null;
let getProject = null;
let refreshDashboardAsync = null;
let closeBranchDropdown = null;
let closeActionsDropdown = null;
let openGitTab = null;

// DOM elements (acquired lazily)
let gitChangesPanel = null;
let gitChangesList = null;
let gitChangesStats = null;
let gitChangesProject = null;
let gitSelectAll = null;
let gitCommitMessage = null;
let btnCommitSelected = null;
let btnGenerateCommit = null;
let btnSmartCommit = null;
let commitCountSpan = null;
let changesCountBadge = null;
let filterBtnChanges = null;

const gitChangesState = {
  files: [],
  selectedFiles: new Set(),
  projectId: null,
  projectPath: null,
  stashes: []
};

function init(context) {
  showToast = context.showToast;
  showGitToast = context.showGitToast;
  getCurrentFilterProjectId = context.getCurrentFilterProjectId;
  getEffectiveGitPath = context.getEffectiveGitPath || null;
  getProject = context.getProject;
  refreshDashboardAsync = context.refreshDashboardAsync;
  closeBranchDropdown = context.closeBranchDropdown;
  closeActionsDropdown = context.closeActionsDropdown;
  openGitTab = context.openGitTab || null;

  // Acquire DOM elements
  gitChangesPanel = document.getElementById('git-changes-panel');
  gitChangesList = document.getElementById('git-changes-list');
  gitChangesStats = document.getElementById('git-changes-stats');
  gitChangesProject = document.getElementById('git-changes-project');
  gitSelectAll = document.getElementById('git-select-all');
  gitCommitMessage = document.getElementById('git-commit-message');
  btnCommitSelected = document.getElementById('btn-commit-selected');
  btnGenerateCommit = document.getElementById('btn-generate-commit');
  btnSmartCommit = document.getElementById('btn-smart-commit');
  commitCountSpan = document.getElementById('commit-count');
  changesCountBadge = document.getElementById('changes-count');
  filterBtnChanges = document.getElementById('filter-btn-changes');

  setupEventListeners();
}

function setupEventListeners() {
  // Toggle changes panel
  filterBtnChanges.onclick = (e) => {
    e.stopPropagation();
    const isOpen = gitChangesPanel.classList.contains('active');

    if (closeBranchDropdown) closeBranchDropdown();
    if (closeActionsDropdown) closeActionsDropdown();

    if (isOpen) {
      gitChangesPanel.classList.remove('active');
    } else {
      const btnRect = filterBtnChanges.getBoundingClientRect();
      const headerRect = gitChangesPanel.parentElement.getBoundingClientRect();
      const panelWidth = 480;
      let left = btnRect.left - headerRect.left;
      const maxRight = Math.min(headerRect.width, window.innerWidth - headerRect.left);
      if (left + panelWidth > maxRight) {
        left = Math.max(0, maxRight - panelWidth);
      }
      gitChangesPanel.style.left = left + 'px';
      gitChangesPanel.classList.add('active');
      loadGitChanges();
    }
  };

  // Close panel
  document.getElementById('btn-close-changes').onclick = () => {
    gitChangesPanel.classList.remove('active');
  };

  // Refresh changes
  document.getElementById('btn-refresh-changes').onclick = () => {
    loadGitChanges();
  };

  // Close panel when clicking outside
  document.addEventListener('click', (e) => {
    if (!gitChangesPanel.contains(e.target) && !filterBtnChanges.contains(e.target)) {
      gitChangesPanel.classList.remove('active');
    }
  });

  // Select all checkbox
  gitSelectAll.onchange = () => {
    const shouldSelect = gitSelectAll.checked;
    gitChangesState.files.forEach((_, index) => {
      if (shouldSelect) {
        gitChangesState.selectedFiles.add(index);
      } else {
        gitChangesState.selectedFiles.delete(index);
      }
    });
    renderGitChanges();
    updateCommitButton();
  };

  // Commit message input
  gitCommitMessage.oninput = () => {
    updateCommitButton();
  };

  // Generate commit message
  btnGenerateCommit.onclick = async () => {
    if (gitChangesState.selectedFiles.size === 0) {
      showToast({ type: 'warning', title: t('gitChanges.filesRequired'), message: t('gitChanges.selectAtLeastOne'), duration: 3000 });
      return;
    }

    const selectedFiles = Array.from(gitChangesState.selectedFiles)
      .map(i => gitChangesState.files[i])
      .filter(Boolean);

    btnGenerateCommit.disabled = true;
    const btnSpan = btnGenerateCommit.querySelector('span');
    const originalText = btnSpan.textContent;
    btnSpan.textContent = '...';

    try {
      const result = await api.git.generateCommitMessage({
        projectPath: gitChangesState.projectPath,
        files: selectedFiles,
        useAi: getSetting('aiCommitMessages') !== false
      });

      if (result.success && result.message) {
        gitCommitMessage.value = result.message;

        const sourceLabel = result.source === 'ai' ? t('gitChanges.sourceAi') : t('gitChanges.sourceHeuristic');
        showToast({
          type: 'success',
          title: t('gitChanges.generated', { source: sourceLabel }),
          message: result.message,
          duration: 3000
        });

        if (result.groups && result.groups.length > 1) {
          const groupNames = result.groups.map(g => g.name).join(', ');
          setTimeout(() => showToast({
            type: 'info',
            title: t('gitChanges.multipleCommits'),
            message: t('gitChanges.multipleCommitsHint', { count: result.groups.length, names: groupNames }),
            duration: 6000
          }), 500);
        }
      } else {
        showToast({ type: 'error', title: t('gitChanges.errorGenerate'), message: result.error || t('gitChanges.errorGenerateMessage'), duration: 3000 });
      }
    } catch (e) {
      showToast({ type: 'error', title: t('gitChanges.errorGenerate'), message: e.message, duration: 3000 });
    } finally {
      btnGenerateCommit.disabled = false;
      btnSpan.textContent = originalText;
    }
  };

  // Smart Commit - generate multi-commit messages and show modal
  btnSmartCommit.onclick = async () => {
    if (gitChangesState.selectedFiles.size === 0) {
      showToast({ type: 'warning', title: t('gitChanges.filesRequired'), message: t('gitChanges.selectAtLeastOne'), duration: 3000 });
      return;
    }

    const selectedFiles = Array.from(gitChangesState.selectedFiles)
      .map(i => gitChangesState.files[i])
      .filter(Boolean);

    btnSmartCommit.disabled = true;
    const btnSpan = btnSmartCommit.querySelector('span');
    const origText = btnSpan.textContent;
    btnSpan.textContent = t('gitChanges.generating');

    try {
      const result = await api.git.generateMultiCommit({
        projectPath: gitChangesState.projectPath,
        files: selectedFiles,
        useAi: getSetting('aiCommitMessages') !== false
      });

      if (!result.success || !result.commits || result.commits.length <= 1) {
        // Only one group — use normal flow
        if (result.commits && result.commits.length === 1) {
          gitCommitMessage.value = result.commits[0].message;
          showToast({ type: 'info', message: t('gitChanges.generated', { source: result.commits[0].source === 'ai' ? t('gitChanges.sourceAi') : t('gitChanges.sourceHeuristic') }), duration: 3000 });
        }
        return;
      }

      _showSmartCommitModal(result.commits);
    } catch (e) {
      showToast({ type: 'error', title: t('gitChanges.errorGenerate'), message: e.message, duration: 3000 });
    } finally {
      btnSmartCommit.disabled = false;
      btnSpan.textContent = origText;
    }
  };

  // Commit selected files
  btnCommitSelected.onclick = async () => {
    const message = gitCommitMessage.value.trim();
    if (!message) {
      showToast({ type: 'warning', title: t('gitChanges.messageRequired'), message: t('gitChanges.enterCommitMessage'), duration: 3000 });
      return;
    }

    if (gitChangesState.selectedFiles.size === 0) {
      showToast({ type: 'warning', title: t('gitChanges.filesRequired'), message: t('gitChanges.selectAtLeastOne'), duration: 3000 });
      return;
    }

    const selectedPaths = Array.from(gitChangesState.selectedFiles)
      .map(i => gitChangesState.files[i]?.path)
      .filter(Boolean);

    btnCommitSelected.disabled = true;
    btnCommitSelected.innerHTML = `<span class="loading-spinner"></span> ${t('gitChanges.committing')}`;

    try {
      const stageResult = await api.git.stageFiles({
        projectPath: gitChangesState.projectPath,
        files: selectedPaths
      });

      if (!stageResult.success) {
        throw new Error(stageResult.error);
      }

      const commitResult = await api.git.commit({
        projectPath: gitChangesState.projectPath,
        message: message
      });

      if (commitResult.success) {
        showGitToast({
          success: true,
          title: t('gitChanges.commitCreated'),
          message: t('gitChanges.commitFiles', { count: selectedPaths.length }),
          duration: 3000
        });
        gitCommitMessage.value = '';
        loadGitChanges();
        refreshDashboardAsync(gitChangesState.projectId);
      } else {
        throw new Error(commitResult.error);
      }
    } catch (e) {
      showGitToast({
        success: false,
        title: t('gitChanges.commitError'),
        message: e.message,
        duration: 5000
      });
    } finally {
      btnCommitSelected.disabled = false;
      btnCommitSelected.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> <span>${t('ui.commitSelected')}</span> (<span id="commit-count">${gitChangesState.selectedFiles.size}</span>)`;
      // Re-acquire since innerHTML replaced it
      commitCountSpan = document.getElementById('commit-count');
    }
  };
}

async function loadGitChanges() {
  const projectId = getCurrentFilterProjectId();
  if (!projectId) return;

  const project = getProject(projectId);
  if (!project) return;

  gitChangesState.projectId = projectId;
  // Use worktree path if the active tab is a worktree, otherwise use the base project path
  const effectivePath = (getEffectiveGitPath && getEffectiveGitPath()) || project.path;
  gitChangesState.projectPath = effectivePath;
  gitChangesProject.textContent = `- ${project.name}`;

  gitChangesList.innerHTML = `<div class="git-changes-loading">${t('gitChanges.loading')}</div>`;

  try {
    const [status, gitInfo] = await Promise.all([
      api.git.statusDetailed({ projectPath: effectivePath }),
      api.git.infoFull(effectivePath).catch(() => null)
    ]);

    if (!status.success) {
      gitChangesList.innerHTML = `<div class="git-changes-empty"><p>${t('gitChanges.errorStatus', { message: status.error })}</p></div>`;
      return;
    }

    gitChangesState.files = status.files || [];
    gitChangesState.selectedFiles.clear();
    gitChangesState.stashes = gitInfo?.stashes || [];

    renderGitChanges();
    renderStashSection();
    updateChangesCount();
  } catch (e) {
    gitChangesList.innerHTML = `<div class="git-changes-empty"><p>${t('gitChanges.errorStatus', { message: e.message })}</p></div>`;
  }
}

function renderGitChanges() {
  const files = gitChangesState.files;

  if (files.length === 0) {
    gitChangesList.innerHTML = `
      <div class="git-changes-empty">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
        <p>${t('gitChanges.noChanges')}</p>
      </div>
    `;
    gitChangesStats.innerHTML = '';
    return;
  }

  const tracked = [];
  const untracked = [];
  files.forEach((file, index) => {
    if (file.status === '?') {
      untracked.push({ file, index });
    } else {
      tracked.push({ file, index });
    }
  });

  const stats = { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: untracked.length };
  tracked.forEach(({ file }) => {
    if (file.status === 'M') stats.modified++;
    else if (file.status === 'A') stats.added++;
    else if (file.status === 'D') stats.deleted++;
    else if (file.status === 'R') stats.renamed++;
  });

  gitChangesStats.innerHTML = `
    ${stats.modified ? `<span class="git-stat modified">M ${stats.modified}</span>` : ''}
    ${stats.added ? `<span class="git-stat added">A ${stats.added}</span>` : ''}
    ${stats.deleted ? `<span class="git-stat deleted">D ${stats.deleted}</span>` : ''}
    ${stats.renamed ? `<span class="git-stat renamed">R ${stats.renamed}</span>` : ''}
    ${stats.untracked ? `<span class="git-stat untracked">? ${stats.untracked}</span>` : ''}
  `;

  function renderFileItem({ file, index }) {
    const fileName = file.path.split('/').pop();
    const filePath = file.path.split('/').slice(0, -1).join('/');
    const isSelected = gitChangesState.selectedFiles.has(index);

    return `<div class="git-file-item ${isSelected ? 'selected' : ''}" data-index="${index}">
        <div class="git-file-item-row">
          <input type="checkbox" ${isSelected ? 'checked' : ''}>
          <span class="git-file-status ${file.status}">${file.status}</span>
          <div class="git-file-info">
            <div class="git-file-name">${escapeHtml(fileName)}</div>
            ${filePath ? `<div class="git-file-path">${escapeHtml(filePath)}</div>` : ''}
          </div>
          <div class="git-file-diff">
            ${file.additions ? `<span class="additions">+${file.additions}</span>` : ''}
            ${file.deletions ? `<span class="deletions">-${file.deletions}</span>` : ''}
          </div>
          <button class="git-diff-toggle" title="${t('gitChanges.showDiff')}" data-index="${index}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>
        </div>
      </div>`;
  }

  let html = '';

  if (tracked.length > 0) {
    const trackedIndices = tracked.map(t => t.index);
    const allTrackedSelected = trackedIndices.every(i => gitChangesState.selectedFiles.has(i));
    const someTrackedSelected = trackedIndices.some(i => gitChangesState.selectedFiles.has(i));
    html += `<div class="git-changes-section">
      <div class="git-changes-section-header" data-section="tracked">
        <svg class="git-section-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        <input type="checkbox" class="git-section-checkbox" data-section="tracked" ${allTrackedSelected ? 'checked' : ''} ${!allTrackedSelected && someTrackedSelected ? 'data-indeterminate' : ''}>
        <span class="git-section-title">${t('ui.trackedChanges')}</span>
        <span class="git-section-count">${tracked.length}</span>
      </div>
      <div class="git-changes-section-files">
        ${tracked.map(renderFileItem).join('')}
      </div>
    </div>`;
  }

  if (untracked.length > 0) {
    const untrackedIndices = untracked.map(u => u.index);
    const allUntrackedSelected = untrackedIndices.every(i => gitChangesState.selectedFiles.has(i));
    const someUntrackedSelected = untrackedIndices.some(i => gitChangesState.selectedFiles.has(i));
    html += `<div class="git-changes-section">
      <div class="git-changes-section-header" data-section="untracked">
        <svg class="git-section-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg>
        <input type="checkbox" class="git-section-checkbox" data-section="untracked" ${allUntrackedSelected ? 'checked' : ''} ${!allUntrackedSelected && someUntrackedSelected ? 'data-indeterminate' : ''}>
        <span class="git-section-title">${t('ui.untrackedFiles')}</span>
        <span class="git-section-count">${untracked.length}</span>
      </div>
      <div class="git-changes-section-files">
        ${untracked.map(renderFileItem).join('')}
      </div>
    </div>`;
  }

  gitChangesList.innerHTML = html;

  gitChangesList.querySelectorAll('.git-section-checkbox[data-indeterminate]').forEach(cb => {
    cb.indeterminate = true;
    cb.removeAttribute('data-indeterminate');
  });

  gitChangesList.querySelectorAll('.git-file-item').forEach(item => {
    const checkbox = item.querySelector('input[type="checkbox"]');
    const diffToggle = item.querySelector('.git-diff-toggle');
    const index = parseInt(item.dataset.index);

    item.querySelector('.git-file-item-row').onclick = (e) => {
      if (e.target === checkbox || e.target.closest('.git-diff-toggle')) return;
      checkbox.checked = !checkbox.checked;
      toggleFileSelection(index, checkbox.checked);
    };

    checkbox.onchange = () => {
      toggleFileSelection(index, checkbox.checked);
    };

    if (diffToggle) {
      diffToggle.onclick = (e) => {
        e.stopPropagation();
        openDiffModal(index);
      };
    }
  });

  gitChangesList.querySelectorAll('.git-section-checkbox').forEach(cb => {
    cb.onchange = () => {
      const section = cb.dataset.section;
      const items = section === 'tracked' ? tracked : untracked;
      items.forEach(({ index }) => {
        if (cb.checked) {
          gitChangesState.selectedFiles.add(index);
        } else {
          gitChangesState.selectedFiles.delete(index);
        }
      });
      renderGitChanges();
      updateCommitButton();
      updateSelectAllState();
    };
  });

  gitChangesList.querySelectorAll('.git-changes-section-header').forEach(header => {
    header.onclick = (e) => {
      if (e.target.closest('.git-section-checkbox')) return;
      const filesDiv = header.nextElementSibling;
      if (filesDiv) {
        header.classList.toggle('collapsed');
        filesDiv.classList.toggle('collapsed');
      }
    };
  });

  updateSelectAllState();
}

async function openDiffModal(index) {
  const file = gitChangesState.files[index];
  if (!file) return;

  const modalOverlay = document.getElementById('modal-overlay');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const modalFooter = document.getElementById('modal-footer');

  if (!modalOverlay) return;

  if (modalTitle) modalTitle.textContent = file.path;
  if (modalBody) modalBody.innerHTML = '<div class="git-diff-view"><div style="padding:24px;text-align:center;color:var(--text-muted)"><span class="loading-spinner"></span></div></div>';
  if (modalFooter) modalFooter.style.display = 'none';
  modalOverlay.classList.add('active');

  try {
    const diff = await api.git.fileDiff({
      projectPath: gitChangesState.projectPath,
      filePath: file.path,
      staged: file.staged || false
    });

    if (!modalBody) return;
    if (!diff || diff.trim() === '') {
      modalBody.innerHTML = '<p style="color:var(--text-secondary);padding:16px">' + t('gitChanges.noDiff') + '</p>';
      return;
    }

    const lines = diff.split('\n').map(line => {
      const cls = line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : line.startsWith('@@') ? 'diff-hunk' : '';
      return `<div class="diff-line ${cls}">${escapeHtml(line)}</div>`;
    }).join('');
    modalBody.innerHTML = `<div class="git-diff-view"><pre class="git-diff-content">${lines}</pre></div>`;
  } catch (e) {
    if (modalBody) modalBody.innerHTML = `<p style="color:var(--danger);padding:16px">${escapeHtml(e.message)}</p>`;
  }
}

function renderStashSection() {
  // Find or create stash section inside the panel
  let stashSection = gitChangesPanel.querySelector('.git-changes-stash-section');
  if (!stashSection) {
    stashSection = document.createElement('div');
    stashSection.className = 'git-changes-stash-section';
    // Insert before the commit section
    const commitSection = gitChangesPanel.querySelector('.git-commit-section');
    if (commitSection) {
      gitChangesPanel.insertBefore(stashSection, commitSection);
    } else {
      gitChangesPanel.appendChild(stashSection);
    }
  }

  const stashes = gitChangesState.stashes;
  const saveDisabled = gitChangesState.files.length === 0;

  let html = `<div class="git-changes-stash-header">
    <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M20 6h-2.18c.07-.44.18-.88.18-1.34C18 2.99 16.99 2 15.66 2c-.87 0-1.54.5-2.12 1.09L12 4.62l-1.55-1.53C9.88 2.5 9.21 2 8.34 2 7.01 2 6 2.99 6 4.34c0 .46.11.9.18 1.34H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4.34c0-.55.45-1 1-1s1 .45 1 1-.45 1-1 1-1-.45-1-1z"/></svg>
    <span>${t('ui.stashes')}</span>
    <span class="git-changes-stash-count">${stashes.length}</span>
    <button class="git-changes-stash-save-btn" title="${t('gitTab.stashSave')}" ${saveDisabled ? 'disabled' : ''}>
      <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
    </button>
  </div>`;

  if (stashes.length === 0) {
    html += `<div class="git-changes-stash-empty">${t('gitTab.noStashes')}</div>`;
  } else {
    html += `<div class="git-changes-stash-list">`;
    for (const stash of stashes) {
      html += `<div class="git-changes-stash-item" data-ref="${escapeHtml(stash.ref)}">
        <div class="git-changes-stash-info">
          <span class="git-changes-stash-ref">${escapeHtml(stash.ref)}</span>
          <span class="git-changes-stash-msg" title="${escapeHtml(stash.message || '')}">${escapeHtml((stash.message || '').slice(0, 50))}${(stash.message || '').length > 50 ? '…' : ''}</span>
        </div>
        <div class="git-changes-stash-date">${escapeHtml(stash.date || '')}</div>
        <div class="git-changes-stash-actions">
          <button class="git-changes-stash-btn apply" title="${t('gitTab.applyStash')}" data-ref="${escapeHtml(stash.ref)}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          </button>
          <button class="git-changes-stash-btn drop" title="${t('gitTab.dropStash')}" data-ref="${escapeHtml(stash.ref)}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  stashSection.innerHTML = html;

  // Save stash button
  const saveBtn = stashSection.querySelector('.git-changes-stash-save-btn');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      const msg = window.prompt(t('gitTab.stashMessage'), '') ?? null;
      if (msg === null) return; // cancelled
      saveBtn.disabled = true;
      try {
        const result = await api.git.stashSave({ projectPath: gitChangesState.projectPath, message: msg });
        if (result && result.success !== false) {
          showToast({ type: 'success', title: t('gitTab.stashSave'), message: t('gitTab.stashAppliedSuccess'), duration: 3000 });
          await loadGitChanges();
        } else {
          showToast({ type: 'error', title: t('gitTab.stashSave'), message: result?.error || 'Failed', duration: 4000 });
          saveBtn.disabled = false;
        }
      } catch (e) {
        showToast({ type: 'error', title: t('gitTab.stashSave'), message: e.message, duration: 4000 });
        saveBtn.disabled = false;
      }
    };
  }

  // Apply / Drop buttons
  stashSection.querySelectorAll('.git-changes-stash-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const ref = btn.dataset.ref;
      const isApply = btn.classList.contains('apply');
      if (!isApply && !window.confirm(t('gitTab.confirmDropStash', { ref }))) return;
      btn.disabled = true;
      try {
        const result = isApply
          ? await api.git.stashApply({ projectPath: gitChangesState.projectPath, stashRef: ref })
          : await api.git.stashDrop({ projectPath: gitChangesState.projectPath, stashRef: ref });
        if (result?.success !== false) {
          showToast({
            type: 'success',
            title: isApply ? t('gitTab.applyStash') : t('gitTab.dropStash'),
            message: isApply ? t('gitTab.stashAppliedSuccess') : t('gitTab.stashDroppedSuccess'),
            duration: 3000
          });
          await loadGitChanges();
        } else {
          showToast({ type: 'error', title: isApply ? t('gitTab.applyStash') : t('gitTab.dropStash'), message: result?.error || 'Failed', duration: 4000 });
          btn.disabled = false;
        }
      } catch (err) {
        showToast({ type: 'error', title: isApply ? t('gitTab.applyStash') : t('gitTab.dropStash'), message: err.message, duration: 4000 });
        btn.disabled = false;
      }
    };
  });
}

function toggleFileSelection(index, selected) {
  if (selected) {
    gitChangesState.selectedFiles.add(index);
  } else {
    gitChangesState.selectedFiles.delete(index);
  }

  const item = gitChangesList.querySelector(`[data-index="${index}"]`);
  if (item) {
    item.classList.toggle('selected', selected);
  }

  updateSectionCheckboxes();
  updateCommitButton();
  updateSelectAllState();
}

function updateSectionCheckboxes() {
  const files = gitChangesState.files;
  gitChangesList.querySelectorAll('.git-section-checkbox').forEach(cb => {
    const section = cb.dataset.section;
    const indices = [];
    files.forEach((f, i) => {
      if (section === 'tracked' && f.status !== '?') indices.push(i);
      else if (section === 'untracked' && f.status === '?') indices.push(i);
    });
    if (indices.length === 0) return;
    const allSelected = indices.every(i => gitChangesState.selectedFiles.has(i));
    const someSelected = indices.some(i => gitChangesState.selectedFiles.has(i));
    cb.checked = allSelected;
    cb.indeterminate = !allSelected && someSelected;
  });
}

function updateSelectAllState() {
  const total = gitChangesState.files.length;
  const selected = gitChangesState.selectedFiles.size;
  gitSelectAll.checked = total > 0 && selected === total;
  gitSelectAll.indeterminate = selected > 0 && selected < total;
}

function updateCommitButton() {
  const count = gitChangesState.selectedFiles.size;
  if (commitCountSpan) commitCountSpan.textContent = count;
  btnCommitSelected.disabled = count === 0 || !gitCommitMessage.value.trim();
  _updateSmartCommitVisibility();
}

function updateChangesCount() {
  const count = gitChangesState.files.length;
  if (count > 0) {
    changesCountBadge.textContent = count;
    changesCountBadge.style.display = 'inline';
    filterBtnChanges.classList.add('has-changes');
  } else {
    changesCountBadge.style.display = 'none';
    filterBtnChanges.classList.remove('has-changes');
  }
}

async function refreshGitChangesIfOpen() {
  if (gitChangesPanel && gitChangesPanel.classList.contains('active')) {
    await loadGitChanges();
  }
}

function _updateSmartCommitVisibility() {
  if (!btnSmartCommit) return;
  // Show smart commit button only when 2+ selected files span multiple directories
  const selectedFiles = Array.from(gitChangesState.selectedFiles)
    .map(i => gitChangesState.files[i])
    .filter(Boolean);
  if (selectedFiles.length < 2) {
    btnSmartCommit.style.display = 'none';
    return;
  }
  const dirs = new Set(selectedFiles.map(f => {
    const parts = f.path.replace(/\\/g, '/').split('/').filter(p => p !== 'src' && p !== '.');
    return parts.length > 1 ? parts[0] : 'root';
  }));
  btnSmartCommit.style.display = dirs.size > 1 ? '' : 'none';
}

async function _showSmartCommitModal(commits) {
  const groupCards = commits.map((c, i) => {
    const fileList = c.files.map(f => `<div class="sc-file"><span class="git-file-status ${f.status}">${f.status}</span> ${escapeHtml(f.path)}</div>`).join('');
    return `
      <div class="sc-group" data-group-index="${i}">
        <div class="sc-group-header">
          <span class="sc-group-name">${escapeHtml(c.group)}</span>
          <span class="sc-group-count">${c.files.length} file${c.files.length > 1 ? 's' : ''}</span>
          <span class="sc-group-status" data-status="pending"></span>
        </div>
        <div class="sc-group-files">${fileList}</div>
        <textarea class="sc-group-message" rows="2">${escapeHtml(c.message)}</textarea>
        <button class="sc-group-commit btn-primary btn-sm" data-group-index="${i}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          ${t('gitChanges.commitGroup')}
        </button>
      </div>`;
  }).join('');

  const modal = createModal({
    id: 'smart-commit-modal',
    title: t('gitChanges.smartCommitTitle', { count: commits.length }),
    size: 'large',
    content: `
      <div class="sc-container">
        ${groupCards}
      </div>
    `,
    buttons: [
      { label: t('common.cancel'), action: 'cancel' },
      { label: t('gitChanges.commitAll', { count: commits.length }), action: 'confirm', primary: true }
    ]
  });

  showModal(modal);

  // Commit a single group
  async function commitGroup(index) {
    const group = commits[index];
    const el = modal.querySelector(`[data-group-index="${index}"]`);
    const msgEl = el.querySelector('.sc-group-message');
    const btnEl = el.querySelector('.sc-group-commit');
    const statusEl = el.querySelector('.sc-group-status');
    const message = msgEl.value.trim();

    if (!message) return false;

    btnEl.disabled = true;
    statusEl.dataset.status = 'committing';
    statusEl.innerHTML = '<span class="loading-spinner"></span>';

    try {
      const paths = group.files.map(f => f.path);
      const stageResult = await api.git.stageFiles({ projectPath: gitChangesState.projectPath, files: paths });
      if (!stageResult.success) throw new Error(stageResult.error);

      const commitResult = await api.git.commit({ projectPath: gitChangesState.projectPath, message });
      if (!commitResult.success) throw new Error(commitResult.error);

      statusEl.dataset.status = 'done';
      statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="var(--success)" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
      btnEl.style.display = 'none';
      msgEl.disabled = true;
      showToast({ type: 'success', message: t('gitChanges.groupCommitted', { name: group.group }), duration: 2000 });
      return true;
    } catch (e) {
      statusEl.dataset.status = 'error';
      statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="var(--danger)" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
      btnEl.disabled = false;
      showToast({ type: 'error', title: t('gitChanges.commitError'), message: e.message, duration: 4000 });
      return false;
    }
  }

  // Individual commit buttons
  modal.querySelectorAll('.sc-group-commit').forEach(btn => {
    btn.addEventListener('click', () => commitGroup(parseInt(btn.dataset.groupIndex)));
  });

  // Commit All button
  const confirmBtn = modal.querySelector('[data-action="confirm"]');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      confirmBtn.disabled = true;
      let successCount = 0;
      for (let i = 0; i < commits.length; i++) {
        const statusEl = modal.querySelector(`[data-group-index="${i}"] .sc-group-status`);
        if (statusEl && statusEl.dataset.status === 'done') { successCount++; continue; }
        const ok = await commitGroup(i);
        if (ok) successCount++;
      }
      if (successCount === commits.length) {
        showToast({ type: 'success', message: t('gitChanges.allGroupsCommitted', { count: successCount }), duration: 3000 });
        closeModal(modal);
        loadGitChanges();
        if (refreshDashboardAsync) refreshDashboardAsync(gitChangesState.projectId);
      } else {
        confirmBtn.disabled = false;
      }
    });
  }
}

module.exports = { init, loadGitChanges, refreshGitChangesIfOpen };
