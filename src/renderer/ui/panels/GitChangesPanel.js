/**
 * GitChangesPanel
 * Git staging area with file selection, commit message generation, and commit
 * Extracted from renderer.js — migrated to OOP (BasePanel)
 */

const { BasePanel } = require('../../core/BasePanel');
const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { getSetting } = require('../../state');
const { createModal, showModal, closeModal } = require('../components/Modal');

class GitChangesPanel extends BasePanel {
  /**
   * @param {HTMLElement|null} el
   * @param {object} options
   * @param {object}   options.api              — IPC bridge (electron_api)
   * @param {object}   options.container        — ServiceContainer
   * @param {Function} options.showToast
   * @param {Function} options.showGitToast
   * @param {Function} options.getCurrentFilterProjectId
   * @param {Function} [options.getEffectiveGitPath]
   * @param {Function} options.getProject
   * @param {Function} options.refreshDashboardAsync
   * @param {Function} options.closeBranchDropdown
   * @param {Function} options.closeActionsDropdown
   * @param {Function} [options.openGitTab]
   */
  constructor(el, options = {}) {
    super(el, options);

    // Callback refs from context
    this._showToast = options.showToast;
    this._showGitToast = options.showGitToast;
    this._getCurrentFilterProjectId = options.getCurrentFilterProjectId;
    this._getEffectiveGitPath = options.getEffectiveGitPath || null;
    this._getProject = options.getProject;
    this._refreshDashboardAsync = options.refreshDashboardAsync;
    this._closeBranchDropdown = options.closeBranchDropdown;
    this._closeActionsDropdown = options.closeActionsDropdown;
    this._openGitTab = options.openGitTab || null;

    // DOM element refs (acquired lazily)
    this._gitChangesPanel = null;
    this._gitChangesList = null;
    this._gitChangesStats = null;
    this._gitChangesProject = null;
    this._gitSelectAll = null;
    this._gitCommitMessage = null;
    this._btnCommitSelected = null;
    this._btnGenerateCommit = null;
    this._btnSmartCommit = null;
    this._commitCountSpan = null;
    this._changesCountBadge = null;
    this._filterBtnChanges = null;

    // Internal state
    this._state = {
      files: [],
      selectedFiles: new Set(),
      projectId: null,
      projectPath: null,
      stashes: []
    };

    // Acquire DOM elements
    this._gitChangesPanel = document.getElementById('git-changes-panel');
    this._gitChangesList = document.getElementById('git-changes-list');
    this._gitChangesStats = document.getElementById('git-changes-stats');
    this._gitChangesProject = document.getElementById('git-changes-project');
    this._gitSelectAll = document.getElementById('git-select-all');
    this._gitCommitMessage = document.getElementById('git-commit-message');
    this._btnCommitSelected = document.getElementById('btn-commit-selected');
    this._btnGenerateCommit = document.getElementById('btn-generate-commit');
    this._btnSmartCommit = document.getElementById('btn-smart-commit');
    this._commitCountSpan = document.getElementById('commit-count');
    this._changesCountBadge = document.getElementById('changes-count');
    this._filterBtnChanges = document.getElementById('filter-btn-changes');

    this._setupEventListeners();
  }

  _setupEventListeners() {
    // Toggle changes panel
    this._filterBtnChanges.onclick = (e) => {
      e.stopPropagation();
      const isOpen = this._gitChangesPanel.classList.contains('active');

      if (this._closeBranchDropdown) this._closeBranchDropdown();
      if (this._closeActionsDropdown) this._closeActionsDropdown();

      if (isOpen) {
        this._gitChangesPanel.classList.remove('active');
      } else {
        const btnRect = this._filterBtnChanges.getBoundingClientRect();
        const headerRect = this._gitChangesPanel.parentElement.getBoundingClientRect();
        const panelWidth = 480;
        let left = btnRect.left - headerRect.left;
        const maxRight = Math.min(headerRect.width, window.innerWidth - headerRect.left);
        if (left + panelWidth > maxRight) {
          left = Math.max(0, maxRight - panelWidth);
        }
        this._gitChangesPanel.style.left = left + 'px';
        this._gitChangesPanel.classList.add('active');
        this.loadGitChanges();
      }
    };

    // Close panel
    document.getElementById('btn-close-changes').onclick = () => {
      this._gitChangesPanel.classList.remove('active');
    };

    // Refresh changes
    document.getElementById('btn-refresh-changes').onclick = () => {
      this.loadGitChanges();
    };

    // Close panel when clicking outside
    this.on(document, 'click', (e) => {
      if (!this._gitChangesPanel.contains(e.target) && !this._filterBtnChanges.contains(e.target)) {
        this._gitChangesPanel.classList.remove('active');
      }
    });

    // Select all checkbox
    this._gitSelectAll.onchange = () => {
      const shouldSelect = this._gitSelectAll.checked;
      this._state.files.forEach((_, index) => {
        if (shouldSelect) {
          this._state.selectedFiles.add(index);
        } else {
          this._state.selectedFiles.delete(index);
        }
      });
      this._renderGitChanges();
      this._updateCommitButton();
    };

    // Commit message input
    this._gitCommitMessage.oninput = () => {
      this._updateCommitButton();
    };

    // Generate commit message
    this._btnGenerateCommit.onclick = async () => {
      if (this._state.selectedFiles.size === 0) {
        this._showToast({ type: 'warning', title: t('gitChanges.filesRequired'), message: t('gitChanges.selectAtLeastOne'), duration: 3000 });
        return;
      }

      const selectedFiles = Array.from(this._state.selectedFiles)
        .map(i => this._state.files[i])
        .filter(Boolean);

      this._btnGenerateCommit.disabled = true;
      const btnSpan = this._btnGenerateCommit.querySelector('span');
      const originalText = btnSpan.textContent;
      btnSpan.textContent = '...';

      try {
        const result = await this.api.git.generateCommitMessage({
          projectPath: this._state.projectPath,
          files: selectedFiles,
          useAi: getSetting('aiCommitMessages') !== false
        });

        if (result.success && result.message) {
          this._gitCommitMessage.value = result.message;

          const sourceLabel = result.source === 'ai' ? t('gitChanges.sourceAi') : t('gitChanges.sourceHeuristic');
          this._showToast({
            type: 'success',
            title: t('gitChanges.generated', { source: sourceLabel }),
            message: result.message,
            duration: 3000
          });

          if (result.groups && result.groups.length > 1) {
            const groupNames = result.groups.map(g => g.name).join(', ');
            setTimeout(() => this._showToast({
              type: 'info',
              title: t('gitChanges.multipleCommits'),
              message: t('gitChanges.multipleCommitsHint', { count: result.groups.length, names: groupNames }),
              duration: 6000
            }), 500);
          }
        } else {
          this._showToast({ type: 'error', title: t('gitChanges.errorGenerate'), message: result.error || t('gitChanges.errorGenerateMessage'), duration: 3000 });
        }
      } catch (e) {
        this._showToast({ type: 'error', title: t('gitChanges.errorGenerate'), message: e.message, duration: 3000 });
      } finally {
        this._btnGenerateCommit.disabled = false;
        btnSpan.textContent = originalText;
      }
    };

    // Smart Commit - generate multi-commit messages and show modal
    this._btnSmartCommit.onclick = async () => {
      if (this._state.selectedFiles.size === 0) {
        this._showToast({ type: 'warning', title: t('gitChanges.filesRequired'), message: t('gitChanges.selectAtLeastOne'), duration: 3000 });
        return;
      }

      const selectedFiles = Array.from(this._state.selectedFiles)
        .map(i => this._state.files[i])
        .filter(Boolean);

      this._btnSmartCommit.disabled = true;
      const btnSpan = this._btnSmartCommit.querySelector('span');
      const origText = btnSpan.textContent;
      btnSpan.textContent = t('gitChanges.generating');

      try {
        const result = await this.api.git.generateMultiCommit({
          projectPath: this._state.projectPath,
          files: selectedFiles,
          useAi: getSetting('aiCommitMessages') !== false
        });

        if (!result.success || !result.commits || result.commits.length <= 1) {
          // Only one group — use normal flow
          if (result.commits && result.commits.length === 1) {
            this._gitCommitMessage.value = result.commits[0].message;
            this._showToast({ type: 'info', message: t('gitChanges.generated', { source: result.commits[0].source === 'ai' ? t('gitChanges.sourceAi') : t('gitChanges.sourceHeuristic') }), duration: 3000 });
          }
          return;
        }

        this._showSmartCommitModal(result.commits);
      } catch (e) {
        this._showToast({ type: 'error', title: t('gitChanges.errorGenerate'), message: e.message, duration: 3000 });
      } finally {
        this._btnSmartCommit.disabled = false;
        btnSpan.textContent = origText;
      }
    };

    // Commit selected files
    this._btnCommitSelected.onclick = async () => {
      const message = this._gitCommitMessage.value.trim();
      if (!message) {
        this._showToast({ type: 'warning', title: t('gitChanges.messageRequired'), message: t('gitChanges.enterCommitMessage'), duration: 3000 });
        return;
      }

      if (this._state.selectedFiles.size === 0) {
        this._showToast({ type: 'warning', title: t('gitChanges.filesRequired'), message: t('gitChanges.selectAtLeastOne'), duration: 3000 });
        return;
      }

      const selectedPaths = Array.from(this._state.selectedFiles)
        .map(i => this._state.files[i]?.path)
        .filter(Boolean);

      this._btnCommitSelected.disabled = true;
      this._btnCommitSelected.innerHTML = `<span class="loading-spinner"></span> ${t('gitChanges.committing')}`;

      try {
        const stageResult = await this.api.git.stageFiles({
          projectPath: this._state.projectPath,
          files: selectedPaths
        });

        if (!stageResult.success) {
          throw new Error(stageResult.error);
        }

        const commitResult = await this.api.git.commit({
          projectPath: this._state.projectPath,
          message: message
        });

        if (commitResult.success) {
          this._showGitToast({
            success: true,
            title: t('gitChanges.commitCreated'),
            message: t('gitChanges.commitFiles', { count: selectedPaths.length }),
            duration: 3000
          });
          this._gitCommitMessage.value = '';
          this.loadGitChanges();
          this._refreshDashboardAsync(this._state.projectId);
        } else {
          throw new Error(commitResult.error);
        }
      } catch (e) {
        this._showGitToast({
          success: false,
          title: t('gitChanges.commitError'),
          message: e.message,
          duration: 5000
        });
      } finally {
        this._btnCommitSelected.disabled = false;
        this._btnCommitSelected.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg> <span>${t('ui.commitSelected')}</span> (<span id="commit-count">${this._state.selectedFiles.size}</span>)`;
        // Re-acquire since innerHTML replaced it
        this._commitCountSpan = document.getElementById('commit-count');
      }
    };
  }

  async loadGitChanges() {
    const projectId = this._getCurrentFilterProjectId();
    if (!projectId) return;

    const project = this._getProject(projectId);
    if (!project) return;

    this._state.projectId = projectId;
    // Use worktree path if the active tab is a worktree, otherwise use the base project path
    const effectivePath = (this._getEffectiveGitPath && this._getEffectiveGitPath()) || project.path;
    this._state.projectPath = effectivePath;
    this._gitChangesProject.textContent = `- ${project.name}`;

    this._gitChangesList.innerHTML = `<div class="git-changes-loading">${t('gitChanges.loading')}</div>`;

    try {
      const [status, gitInfo] = await Promise.all([
        this.api.git.statusDetailed({ projectPath: effectivePath }),
        this.api.git.infoFull(effectivePath).catch(() => null)
      ]);

      if (!status.success) {
        this._gitChangesList.innerHTML = `<div class="git-changes-empty"><p>${t('gitChanges.errorStatus', { message: status.error })}</p></div>`;
        return;
      }

      this._state.files = status.files || [];
      this._state.selectedFiles.clear();
      this._state.stashes = gitInfo?.stashes || [];

      this._renderGitChanges();
      this._renderStashSection();
      this._updateChangesCount();
    } catch (e) {
      this._gitChangesList.innerHTML = `<div class="git-changes-empty"><p>${t('gitChanges.errorStatus', { message: e.message })}</p></div>`;
    }
  }

  _renderGitChanges() {
    const files = this._state.files;

    if (files.length === 0) {
      this._gitChangesList.innerHTML = `
        <div class="git-changes-empty">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
          <p>${t('gitChanges.noChanges')}</p>
        </div>
      `;
      this._gitChangesStats.innerHTML = '';
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

    this._gitChangesStats.innerHTML = `
      ${stats.modified ? `<span class="git-stat modified">M ${stats.modified}</span>` : ''}
      ${stats.added ? `<span class="git-stat added">A ${stats.added}</span>` : ''}
      ${stats.deleted ? `<span class="git-stat deleted">D ${stats.deleted}</span>` : ''}
      ${stats.renamed ? `<span class="git-stat renamed">R ${stats.renamed}</span>` : ''}
      ${stats.untracked ? `<span class="git-stat untracked">? ${stats.untracked}</span>` : ''}
    `;

    const self = this;
    function renderFileItem({ file, index }) {
      const fileName = file.path.split('/').pop();
      const filePath = file.path.split('/').slice(0, -1).join('/');
      const isSelected = self._state.selectedFiles.has(index);

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
      const allTrackedSelected = trackedIndices.every(i => this._state.selectedFiles.has(i));
      const someTrackedSelected = trackedIndices.some(i => this._state.selectedFiles.has(i));
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
      const allUntrackedSelected = untrackedIndices.every(i => this._state.selectedFiles.has(i));
      const someUntrackedSelected = untrackedIndices.some(i => this._state.selectedFiles.has(i));
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

    this._gitChangesList.innerHTML = html;

    this._gitChangesList.querySelectorAll('.git-section-checkbox[data-indeterminate]').forEach(cb => {
      cb.indeterminate = true;
      cb.removeAttribute('data-indeterminate');
    });

    this._gitChangesList.querySelectorAll('.git-file-item').forEach(item => {
      const checkbox = item.querySelector('input[type="checkbox"]');
      const diffToggle = item.querySelector('.git-diff-toggle');
      const index = parseInt(item.dataset.index);

      item.querySelector('.git-file-item-row').onclick = (e) => {
        if (e.target === checkbox || e.target.closest('.git-diff-toggle')) return;
        checkbox.checked = !checkbox.checked;
        this._toggleFileSelection(index, checkbox.checked);
      };

      checkbox.onchange = () => {
        this._toggleFileSelection(index, checkbox.checked);
      };

      if (diffToggle) {
        diffToggle.onclick = (e) => {
          e.stopPropagation();
          this._openDiffModal(index);
        };
      }
    });

    this._gitChangesList.querySelectorAll('.git-section-checkbox').forEach(cb => {
      cb.onchange = () => {
        const section = cb.dataset.section;
        const items = section === 'tracked' ? tracked : untracked;
        items.forEach(({ index }) => {
          if (cb.checked) {
            this._state.selectedFiles.add(index);
          } else {
            this._state.selectedFiles.delete(index);
          }
        });
        this._renderGitChanges();
        this._updateCommitButton();
        this._updateSelectAllState();
      };
    });

    this._gitChangesList.querySelectorAll('.git-changes-section-header').forEach(header => {
      header.onclick = (e) => {
        if (e.target.closest('.git-section-checkbox')) return;
        const filesDiv = header.nextElementSibling;
        if (filesDiv) {
          header.classList.toggle('collapsed');
          filesDiv.classList.toggle('collapsed');
        }
      };
    });

    this._updateSelectAllState();
  }

  async _openDiffModal(index) {
    const file = this._state.files[index];
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
      const diff = await this.api.git.fileDiff({
        projectPath: this._state.projectPath,
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

  _renderStashSection() {
    // Find or create stash section inside the panel
    let stashSection = this._gitChangesPanel.querySelector('.git-changes-stash-section');
    if (!stashSection) {
      stashSection = document.createElement('div');
      stashSection.className = 'git-changes-stash-section';
      // Insert before the commit section
      const commitSection = this._gitChangesPanel.querySelector('.git-commit-section');
      if (commitSection) {
        this._gitChangesPanel.insertBefore(stashSection, commitSection);
      } else {
        this._gitChangesPanel.appendChild(stashSection);
      }
    }

    const stashes = this._state.stashes;
    const saveDisabled = this._state.files.length === 0;

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
            <span class="git-changes-stash-msg" title="${escapeHtml(stash.message || '')}">${escapeHtml((stash.message || '').slice(0, 50))}${(stash.message || '').length > 50 ? '\u2026' : ''}</span>
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
          const result = await this.api.git.stashSave({ projectPath: this._state.projectPath, message: msg });
          if (result && result.success !== false) {
            this._showToast({ type: 'success', title: t('gitTab.stashSave'), message: t('gitTab.stashSavedSuccess'), duration: 3000 });
            await this.loadGitChanges();
          } else {
            this._showToast({ type: 'error', title: t('gitTab.stashSave'), message: result?.error || t('common.errorOccurred'), duration: 4000 });
            saveBtn.disabled = false;
          }
        } catch (e) {
          this._showToast({ type: 'error', title: t('gitTab.stashSave'), message: e.message, duration: 4000 });
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
            ? await this.api.git.stashApply({ projectPath: this._state.projectPath, stashRef: ref })
            : await this.api.git.stashDrop({ projectPath: this._state.projectPath, stashRef: ref });
          if (result?.success !== false) {
            this._showToast({
              type: 'success',
              title: isApply ? t('gitTab.applyStash') : t('gitTab.dropStash'),
              message: isApply ? t('gitTab.stashAppliedSuccess') : t('gitTab.stashDroppedSuccess'),
              duration: 3000
            });
            await this.loadGitChanges();
          } else {
            this._showToast({ type: 'error', title: isApply ? t('gitTab.applyStash') : t('gitTab.dropStash'), message: result?.error || t('common.errorOccurred'), duration: 4000 });
            btn.disabled = false;
          }
        } catch (err) {
          this._showToast({ type: 'error', title: isApply ? t('gitTab.applyStash') : t('gitTab.dropStash'), message: err.message, duration: 4000 });
          btn.disabled = false;
        }
      };
    });
  }

  _toggleFileSelection(index, selected) {
    if (selected) {
      this._state.selectedFiles.add(index);
    } else {
      this._state.selectedFiles.delete(index);
    }

    const item = this._gitChangesList.querySelector(`[data-index="${index}"]`);
    if (item) {
      item.classList.toggle('selected', selected);
    }

    this._updateSectionCheckboxes();
    this._updateCommitButton();
    this._updateSelectAllState();
  }

  _updateSectionCheckboxes() {
    const files = this._state.files;
    this._gitChangesList.querySelectorAll('.git-section-checkbox').forEach(cb => {
      const section = cb.dataset.section;
      const indices = [];
      files.forEach((f, i) => {
        if (section === 'tracked' && f.status !== '?') indices.push(i);
        else if (section === 'untracked' && f.status === '?') indices.push(i);
      });
      if (indices.length === 0) return;
      const allSelected = indices.every(i => this._state.selectedFiles.has(i));
      const someSelected = indices.some(i => this._state.selectedFiles.has(i));
      cb.checked = allSelected;
      cb.indeterminate = !allSelected && someSelected;
    });
  }

  _updateSelectAllState() {
    const total = this._state.files.length;
    const selected = this._state.selectedFiles.size;
    this._gitSelectAll.checked = total > 0 && selected === total;
    this._gitSelectAll.indeterminate = selected > 0 && selected < total;
  }

  _updateCommitButton() {
    const count = this._state.selectedFiles.size;
    if (this._commitCountSpan) this._commitCountSpan.textContent = count;
    this._btnCommitSelected.disabled = count === 0 || !this._gitCommitMessage.value.trim();
    this._updateSmartCommitVisibility();
  }

  _updateChangesCount() {
    const count = this._state.files.length;
    if (count > 0) {
      this._changesCountBadge.textContent = count;
      this._changesCountBadge.style.display = 'inline';
      this._filterBtnChanges.classList.add('has-changes');
    } else {
      this._changesCountBadge.style.display = 'none';
      this._filterBtnChanges.classList.remove('has-changes');
    }
  }

  async refreshGitChangesIfOpen() {
    if (this._gitChangesPanel && this._gitChangesPanel.classList.contains('active')) {
      await this.loadGitChanges();
    }
  }

  _updateSmartCommitVisibility() {
    if (!this._btnSmartCommit) return;
    // Show smart commit button only when 2+ selected files span multiple directories
    const selectedFiles = Array.from(this._state.selectedFiles)
      .map(i => this._state.files[i])
      .filter(Boolean);
    if (selectedFiles.length < 2) {
      this._btnSmartCommit.style.display = 'none';
      return;
    }
    const dirs = new Set(selectedFiles.map(f => {
      const parts = f.path.replace(/\\/g, '/').split('/').filter(p => p !== 'src' && p !== '.');
      return parts.length > 1 ? parts[0] : 'root';
    }));
    this._btnSmartCommit.style.display = dirs.size > 1 ? '' : 'none';
  }

  async _showSmartCommitModal(commits) {
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
    const commitGroup = async (index) => {
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
        const stageResult = await this.api.git.stageFiles({ projectPath: this._state.projectPath, files: paths });
        if (!stageResult.success) throw new Error(stageResult.error);

        const commitResult = await this.api.git.commit({ projectPath: this._state.projectPath, message });
        if (!commitResult.success) throw new Error(commitResult.error);

        statusEl.dataset.status = 'done';
        statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="var(--success)" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        btnEl.style.display = 'none';
        msgEl.disabled = true;
        this._showToast({ type: 'success', message: t('gitChanges.groupCommitted', { name: group.group }), duration: 2000 });
        return true;
      } catch (e) {
        statusEl.dataset.status = 'error';
        statusEl.innerHTML = '<svg viewBox="0 0 24 24" fill="var(--danger)" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
        btnEl.disabled = false;
        this._showToast({ type: 'error', title: t('gitChanges.commitError'), message: e.message, duration: 4000 });
        return false;
      }
    };

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
          this._showToast({ type: 'success', message: t('gitChanges.allGroupsCommitted', { count: successCount }), duration: 3000 });
          closeModal(modal);
          this.loadGitChanges();
          if (this._refreshDashboardAsync) this._refreshDashboardAsync(this._state.projectId);
        } else {
          confirmBtn.disabled = false;
        }
      });
    }
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function init(context) {
  const { getApiProvider, getContainer } = require('../../core');
  _instance = new GitChangesPanel(null, {
    api: getApiProvider(),
    container: getContainer(),
    showToast: context.showToast,
    showGitToast: context.showGitToast,
    getCurrentFilterProjectId: context.getCurrentFilterProjectId,
    getEffectiveGitPath: context.getEffectiveGitPath,
    getProject: context.getProject,
    refreshDashboardAsync: context.refreshDashboardAsync,
    closeBranchDropdown: context.closeBranchDropdown,
    closeActionsDropdown: context.closeActionsDropdown,
    openGitTab: context.openGitTab
  });
}

module.exports = {
  GitChangesPanel,
  init,
  loadGitChanges: (...a) => _instance.loadGitChanges(...a),
  refreshGitChangesIfOpen: (...a) => _instance.refreshGitChangesIfOpen(...a)
};
