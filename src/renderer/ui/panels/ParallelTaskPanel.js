/**
 * ParallelTaskPanel
 * Orchestrates multiple concurrent parallel Claude coding runs.
 * Runs appear as a list of cards. New runs are created via modal.
 */

'use strict';

const { escapeHtml } = require('../../utils');
const { t, onLanguageChange } = require('../../i18n');
const { getSetting, setSetting } = require('../../state/settings.state');
const {
  parallelTaskState,
  getRuns,
  getRunById,
  addRun,
  removeRun,
  initParallelListeners,
} = require('../../state/parallelTask.state');

// ─── Module state ─────────────────────────────────────────────────────────────

let ctx = null;
let _initialized = false;
let _unsubscribe = null;
let _runCounter = 0;
let _runNumbers = new Map();

// ─── Init & Load ──────────────────────────────────────────────────────────────

function init(context) {
  ctx = context;

  // Re-render panel when language changes so translated labels update
  onLanguageChange(() => {
    if (_initialized) {
      _render();
      _updateBoard();
    }
  });
}

async function load() {
  if (!_initialized) {
    _render();
    initParallelListeners();
    _unsubscribe = parallelTaskState.subscribe(() => _updateBoard());
    _initialized = true;
  }

  _loadHistory();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function _render() {
  const container = document.getElementById('tab-tasks');
  if (!container) return;

  container.innerHTML = `
    <div class="parallel-panel">

      <!-- Header -->
      <div class="parallel-header">
        <div class="parallel-header-left">
          <div class="parallel-header-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="20" height="20">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div>
            <h1 class="parallel-header-title">${t('parallel.title')}</h1>
            <p class="parallel-header-subtitle">${t('parallel.subtitle')}</p>
          </div>
        </div>
        <button class="pt-new-run-btn" id="pt-new-run-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11" height="11">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          ${t('parallel.newRunBtn')}
        </button>
      </div>

      <!-- Runs list -->
      <div class="pt-runs-list" id="pt-runs-list"></div>

    </div>
  `;

  _wireEvents();
}

function _wireEvents() {
  // New run button → modal
  document.getElementById('pt-new-run-btn')?.addEventListener('click', _openNewRunModal);

  // Event delegation on runs list
  const runsList = document.getElementById('pt-runs-list');
  if (runsList) {
    runsList.addEventListener('click', async (e) => {
      // Empty state CTA
      if (e.target.closest('#pt-empty-new-run')) {
        _openNewRunModal();
        return;
      }

      // Run toggle button (collapse/expand)
      const toggleBtn = e.target.closest('.pt-run-toggle-btn');
      if (toggleBtn) {
        _toggleRunCard(toggleBtn.dataset.runId);
        return;
      }

      // Action buttons (cancel, cleanup, remove)
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        const { action, runId } = actionBtn.dataset;

        if (action === 'cancel') {
          const cancelRes = await ctx.api.parallel.cancelRun({ runId }).catch(err => ({ success: false, error: err.message }));
          if (cancelRes && !cancelRes.success) {
            _showToast(cancelRes.error || t('parallel.errors.cancelFailed'), 'error');
          }
          return;
        }
        if (action === 'cleanup') {
          const run = getRunById(runId);
          if (!run) return;
          const result = await ctx.api.parallel.cleanupRun({ runId, projectPath: run.projectPath });
          if (result.success) {
            _showToast(t('parallel.cleanup.success'), 'success');
            removeRun(runId);
          } else {
            _showToast(result.error || t('parallel.cleanup.error'), 'error');
          }
          return;
        }
        if (action === 'remove') {
          removeRun(runId);
          ctx.api.parallel.removeHistory({ runId }).catch(() => {});
          return;
        }
      }

      // Task diff / terminal buttons are wired directly on the card elements
    });
  }
}

// ─── New Run Modal ─────────────────────────────────────────────────────────────

function _buildNewRunModal() {
  const savedMaxTasks = getSetting('parallelMaxAgents') || 3;
  const savedAutoTasks = getSetting('parallelAutoTasks') || false;
  return `
    <div class="pt-modal-overlay" id="pt-modal-overlay">
      <div class="pt-modal" role="dialog" aria-modal="true">

        <div class="pt-modal-header">
          <div class="pt-modal-header-left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
            <span class="pt-modal-title">${t('parallel.modal.title')}</span>
          </div>
          <button class="pt-modal-close" id="pt-modal-close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="pt-modal-body">

          <!-- Project -->
          <div class="pm-field">
            <label class="pm-label">${t('parallel.form.projectLabel')}</label>
            <div class="pt-select pt-select--full" id="pm-project-select" data-value="">
              <div class="pt-select-trigger">
                <span class="pt-select-value">${t('parallel.modal.selectProject')}</span>
                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M7 10l5 5 5-5z"/></svg>
              </div>
              <div class="pt-select-dropdown"></div>
            </div>
          </div>

          <!-- Goal -->
          <div class="pm-field pm-field--grow">
            <label class="pm-label" for="pm-goal-input">${t('parallel.form.goalLabel')}</label>
            <textarea
              id="pm-goal-input"
              class="pm-textarea"
              placeholder="${t('parallel.form.goalPlaceholder')}"
              rows="5"
            ></textarea>
          </div>

          <!-- Config row: agents + model + effort -->
          <div class="pm-config-row">
            <div class="pm-field">
              <label class="pm-label">
                ${t('parallel.form.maxTasksLabel')}
                <button class="pm-auto-chip${savedAutoTasks ? ' is-active' : ''}" id="pm-auto-chip" type="button">${t('parallel.auto')}</button>
              </label>
              <div class="parallel-agents-control${savedAutoTasks ? ' is-auto' : ''}" id="pm-agents-control">
                <input
                  type="range"
                  id="pm-agents-slider"
                  class="parallel-agents-slider"
                  min="1" max="10" value="${escapeHtml(String(savedMaxTasks))}" step="1"
                  ${savedAutoTasks ? 'disabled' : ''}
                />
                <div class="parallel-agents-display">
                  <span id="pm-agents-value" class="parallel-agents-value">${savedAutoTasks ? t('parallel.auto') : savedMaxTasks}</span>
                  <span class="parallel-agents-unit" id="pm-agents-unit" ${savedAutoTasks ? 'style="display:none"' : ''}>${t('parallel.agents')}</span>
                </div>
              </div>
              <div class="parallel-agents-ticks" id="pm-agents-ticks" ${savedAutoTasks ? 'style="opacity:0.3"' : ''}>
                <span>1</span><span>3</span><span>5</span><span>7</span><span>10</span>
              </div>
            </div>

            <div class="pm-field">
              <label class="pm-label">${t('parallel.form.modelLabel')}</label>
              <div class="pt-select pt-select--full" id="pm-model-select" data-value="claude-sonnet-4-6">
                <div class="pt-select-trigger">
                  <span class="pt-select-value">${t('parallel.model.sonnet')}</span>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M7 10l5 5 5-5z"/></svg>
                </div>
                <div class="pt-select-dropdown">
                  <div class="pt-select-option" data-value="claude-haiku-4-5-20251001">${t('parallel.model.haiku')}</div>
                  <div class="pt-select-option is-selected" data-value="claude-sonnet-4-6">${t('parallel.model.sonnet')}</div>
                  <div class="pt-select-option" data-value="claude-opus-4-7">${t('parallel.model.opus47')}</div>
                  <div class="pt-select-option" data-value="claude-opus-4-6">${t('parallel.model.opus')}</div>
                </div>
              </div>
            </div>

            <div class="pm-field">
              <label class="pm-label">${t('parallel.form.effortLabel')}</label>
              <div class="pt-select pt-select--full" id="pm-effort-select" data-value="high">
                <div class="pt-select-trigger">
                  <span class="pt-select-value">${t('parallel.effort.high')}</span>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M7 10l5 5 5-5z"/></svg>
                </div>
                <div class="pt-select-dropdown">
                  <div class="pt-select-option" data-value="low">${t('parallel.effort.low')}</div>
                  <div class="pt-select-option" data-value="medium">${t('parallel.effort.medium')}</div>
                  <div class="pt-select-option is-selected" data-value="high">${t('parallel.effort.high')}</div>
                  <div class="pt-select-option" data-value="xhigh">${t('parallel.effort.xhigh')}</div>
                </div>
              </div>
            </div>
          </div>

        </div><!-- /.pt-modal-body -->

        <div class="pt-modal-footer">
          <button class="pt-modal-cancel-btn" id="pt-modal-cancel">${t('common.cancel')}</button>
          <button class="pt-modal-submit-btn" id="pm-start-btn">
            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M8 5v14l11-7z"/></svg>
            ${t('parallel.form.startBtn')}
          </button>
        </div>

      </div>
    </div>
  `;
}

function _openNewRunModal() {
  document.getElementById('pt-modal-overlay')?.remove();

  const panel = document.getElementById('tab-tasks');
  if (!panel) return;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = _buildNewRunModal();
  const modalOverlay = wrapper.firstElementChild;
  panel.appendChild(modalOverlay);

  // Populate project selector
  _populateProjectSelector(modalOverlay);

  // Init custom selects inside modal
  _initCustomSelects(modalOverlay);

  // Auto chip toggle
  const autoChip = modalOverlay.querySelector('#pm-auto-chip');
  const slider = modalOverlay.querySelector('#pm-agents-slider');
  const valueDisplay = modalOverlay.querySelector('#pm-agents-value');
  const unitEl = modalOverlay.querySelector('#pm-agents-unit');
  const controlEl = modalOverlay.querySelector('#pm-agents-control');
  const ticksEl = modalOverlay.querySelector('#pm-agents-ticks');

  const _applyAutoState = (isAuto) => {
    autoChip?.classList.toggle('is-active', isAuto);
    if (slider) slider.disabled = isAuto;
    if (controlEl) controlEl.classList.toggle('is-auto', isAuto);
    if (valueDisplay) valueDisplay.textContent = isAuto ? t('parallel.auto') : (slider?.value || '3');
    if (unitEl) unitEl.style.display = isAuto ? 'none' : '';
    if (ticksEl) ticksEl.style.opacity = isAuto ? '0.3' : '';
    setSetting('parallelAutoTasks', isAuto);
  };

  autoChip?.addEventListener('click', () => {
    _applyAutoState(!autoChip.classList.contains('is-active'));
  });

  if (slider && valueDisplay) {
    slider.addEventListener('input', () => {
      valueDisplay.textContent = slider.value;
      setSetting('parallelMaxAgents', parseInt(slider.value, 10));
    });
  }

  // Close handlers
  modalOverlay.querySelector('#pt-modal-close')?.addEventListener('click', _closeNewRunModal);
  modalOverlay.querySelector('#pt-modal-cancel')?.addEventListener('click', _closeNewRunModal);
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) _closeNewRunModal();
  });

  // Start
  modalOverlay.querySelector('#pm-start-btn')?.addEventListener('click', () => _handleStart(modalOverlay));

  // ESC
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { _closeNewRunModal(); document.removeEventListener('keydown', onKeyDown); }
  };
  document.addEventListener('keydown', onKeyDown);

  // Focus textarea
  setTimeout(() => modalOverlay.querySelector('#pm-goal-input')?.focus(), 50);
}

function _closeNewRunModal() {
  document.getElementById('pt-modal-overlay')?.remove();
}

// ─── Custom select helpers ────────────────────────────────────────────────────

function _initCustomSelects(container) {
  const root = container || document.getElementById('tab-tasks');
  if (!root) return;

  root.querySelectorAll('.pt-select').forEach(sel => {
    const trigger = sel.querySelector('.pt-select-trigger');
    const dropdown = sel.querySelector('.pt-select-dropdown');
    if (!trigger || !dropdown) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = sel.classList.contains('is-open');
      root.querySelectorAll('.pt-select.is-open').forEach(s => s.classList.remove('is-open'));
      if (!isOpen) sel.classList.add('is-open');
    });

    dropdown.addEventListener('click', (e) => {
      const option = e.target.closest('.pt-select-option');
      if (!option) return;
      sel.dataset.value = option.dataset.value;
      sel.querySelector('.pt-select-value').textContent = option.textContent;
      dropdown.querySelectorAll('.pt-select-option').forEach(o => o.classList.remove('is-selected'));
      option.classList.add('is-selected');
      sel.classList.remove('is-open');
    });
  });

  document.addEventListener('click', () => {
    root.querySelectorAll('.pt-select.is-open').forEach(s => s.classList.remove('is-open'));
  });
}

// ─── Start handler ────────────────────────────────────────────────────────────

async function _handleStart(modalEl) {
  const goal = modalEl?.querySelector('#pm-goal-input')?.value?.trim();
  if (!goal) {
    _showToast(t('parallel.errors.noGoal'), 'error');
    return;
  }

  const projectPath = modalEl?.querySelector('#pm-project-select')?.dataset?.value;
  if (!projectPath) {
    _showToast(t('parallel.errors.noProject'), 'error');
    return;
  }

  const autoTasks = modalEl?.querySelector('#pm-auto-chip')?.classList.contains('is-active') || false;
  const maxTasks = autoTasks ? null : parseInt(modalEl?.querySelector('#pm-agents-slider')?.value || '3', 10);
  const model = modalEl?.querySelector('#pm-model-select')?.dataset?.value || 'claude-sonnet-4-6';
  const effort = modalEl?.querySelector('#pm-effort-select')?.dataset?.value || 'high';

  if (!autoTasks) setSetting('parallelMaxAgents', maxTasks);

  // Check if project is a git repository (required for worktree isolation)
  const gitInfo = await ctx.api.git.info(projectPath).catch(() => null);
  if (!gitInfo || !gitInfo.isGitRepo) {
    _showToast(t('parallel.errors.noGit'), 'error');
    return;
  }

  const branchResult = await ctx.api.git.currentBranch({ projectPath }).catch(() => null);
  const mainBranch = (branchResult?.branch || branchResult) || 'main';

  const btn = modalEl?.querySelector('#pm-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('parallel.form.startingBtn'); }

  const result = await ctx.api.parallel.startRun({ projectPath, mainBranch, goal, maxTasks, autoTasks, model, effort });

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M8 5v14l11-7z"/></svg> ${t('parallel.form.startBtn')}`;
  }

  if (!result.success) {
    _showToast(result.error || t('parallel.errors.startFailed'), 'error');
    return;
  }

  addRun({
    id: result.runId,
    projectPath,
    mainBranch,
    goal,
    model,
    effort,
    phase: 'decomposing',
    tasks: [],
    startedAt: Date.now(),
    endedAt: null,
    error: null,
  });

  _closeNewRunModal();
}

// ─── Board update ──────────────────────────────────────────────────────────────

function _updateBoard() {
  const runs = getRuns();
  const listEl = document.getElementById('pt-runs-list');
  if (!listEl) return;

  // Empty state
  if (runs.length === 0) {
    if (!listEl.querySelector('.pt-empty-runs')) {
      listEl.innerHTML = `
        <div class="pt-empty-runs">
          <div class="pt-empty-runs-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="36" height="36">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
          <p class="pt-empty-runs-title">${t('parallel.empty.title')}</p>
          <p class="pt-empty-runs-hint">${t('parallel.empty.hint')}</p>
          <button class="pt-empty-runs-cta" id="pt-empty-new-run">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11" height="11">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            ${t('parallel.newRunBtn')}
          </button>
        </div>
      `;
    }
    return;
  }

  listEl.querySelector('.pt-empty-runs')?.remove();

  // Create cards for new runs (newest at top)
  runs.forEach(run => {
    if (!_runNumbers.has(run.id)) {
      _runNumbers.set(run.id, ++_runCounter);
    }
    let card = document.getElementById(`pt-run-card-${run.id}`);
    if (!card) {
      card = _createRunCard(run);
      if (run._fromHistory) {
        listEl.appendChild(card); // history runs go to bottom
      } else {
        listEl.insertBefore(card, listEl.firstChild); // active runs go to top
      }
    }
    _updateRunCard(run);
  });

  // Remove cards for runs no longer in state
  listEl.querySelectorAll('.pt-run-card').forEach(card => {
    if (!runs.find(r => r.id === card.dataset.runId)) card.remove();
  });
}

function _createRunCard(run) {
  const card = document.createElement('div');
  card.className = 'pt-run-card';
  card.id = `pt-run-card-${run.id}`;
  card.dataset.runId = run.id;

  const num = String(_runNumbers.get(run.id) || 1).padStart(2, '0');
  const displayName = _formatFeatureName(run.featureName) || _deriveNameFromGoal(run.goal || '');

  card.innerHTML = `
    <div class="pt-run-header">
      <div class="pt-run-header-left">
        <span class="pt-run-num">#${num}</span>
        <div class="pt-run-phase-dot" id="pt-phasedot-${run.id}"></div>
        <span class="pt-run-goal-text">${escapeHtml(displayName)}</span>
      </div>
      <div class="pt-run-header-right">
        <span class="pt-run-phase-label" id="pt-phase-label-${run.id}"></span>
        <button class="pt-run-action-btn pt-run-action-btn--cancel" data-action="cancel" data-run-id="${run.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="9" height="9"><path d="M18 6L6 18M6 6l12 12"/></svg>
          ${t('parallel.cancelBtn')}
        </button>
        <button class="pt-run-action-btn pt-run-action-btn--cleanup" data-action="cleanup" data-run-id="${run.id}" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="9" height="9"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          ${t('parallel.cleanupBtn')}
        </button>
        <button class="pt-run-action-btn pt-run-action-btn--remove" data-action="remove" data-run-id="${run.id}" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="9" height="9"><path d="M18 6L6 18M6 6l12 12"/></svg>
          ${t('common.remove')}
        </button>
        <button class="pt-run-toggle-btn" data-run-id="${run.id}" title="Toggle">
          <svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
      </div>
    </div>

    <!-- Progress bar -->
    <div class="pt-run-progress-wrapper" id="pt-progress-${run.id}" style="display:none">
      <div class="pt-run-progress-bar" id="pt-progress-bar-${run.id}"></div>
    </div>

    <!-- Collapsible body -->
    <div class="pt-run-body" id="pt-run-body-${run.id}">
      <div class="pt-run-kanban" id="pt-kanban-${run.id}"></div>
      <div class="pt-run-merge" id="pt-merge-${run.id}" style="display:none"></div>
    </div>
  `;

  return card;
}

function _toggleRunCard(runId) {
  const card = document.getElementById(`pt-run-card-${runId}`);
  if (!card) return;
  const collapsed = card.classList.toggle('is-collapsed');
  const btn = card.querySelector('.pt-run-toggle-btn svg');
  if (btn) btn.style.transform = collapsed ? 'rotate(-90deg)' : '';
}

function _updateRunCard(run) {
  _updateRunHeader(run);
  _updateRunProgress(run);
  _updateRunKanban(run);
  _updateRunMerge(run);
}

function _updateRunHeader(run) {
  const card = document.getElementById(`pt-run-card-${run.id}`);
  if (!card) return;

  // Update display name when featureName arrives
  if (run.featureName) {
    const nameEl = card.querySelector('.pt-run-goal-text');
    const formatted = _formatFeatureName(run.featureName);
    if (nameEl && formatted && nameEl.textContent !== formatted) {
      nameEl.textContent = formatted;
    }
  }

  const tasks = run.tasks || [];
  const done = tasks.filter(t => t.status === 'done').length;
  const total = tasks.length;
  const isActive = ['decomposing', 'reviewing', 'creating-worktrees', 'running', 'merging'].includes(run.phase);
  const isFinished = ['done', 'failed', 'cancelled', 'merged'].includes(run.phase);

  const dot = document.getElementById(`pt-phasedot-${run.id}`);
  if (dot) {
    dot.className = 'pt-run-phase-dot';
    if (isActive) dot.classList.add('running');
    else if (run.phase === 'done' || run.phase === 'merged') dot.classList.add('done');
    else if (isFinished) dot.classList.add('failed');
  }

  const label = document.getElementById(`pt-phase-label-${run.id}`);
  if (label) {
    let text = t(`parallel.phase.${run.phase}`, { done, total }) || run.phase;
    if (run.phase === 'running' && total > 0) text = t('parallel.phase.running', { done, total });
    if (run.error) text = run.error.slice(0, 60);
    label.textContent = text;
    label.className = `pt-run-phase-label phase-${run.phase}`;
  }

  const cancelBtn = card.querySelector('.pt-run-action-btn--cancel');
  const cleanupBtn = card.querySelector('.pt-run-action-btn--cleanup');
  const removeBtn = card.querySelector('.pt-run-action-btn--remove');
  if (cancelBtn) cancelBtn.style.display = isActive ? '' : 'none';
  if (cleanupBtn) cleanupBtn.style.display = isFinished ? '' : 'none';
  if (removeBtn) removeBtn.style.display = isFinished ? '' : 'none';

  card.dataset.phase = run.phase;
}

function _updateRunProgress(run) {
  const wrapper = document.getElementById(`pt-progress-${run.id}`);
  const bar = document.getElementById(`pt-progress-bar-${run.id}`);
  if (!wrapper || !bar) return;

  const tasks = run.tasks || [];
  const total = tasks.length;

  if (total === 0 || run.phase === 'decomposing' || run.phase === 'reviewing') {
    wrapper.style.display = 'none';
    return;
  }

  wrapper.style.display = '';
  const done = tasks.filter(t => ['done', 'failed', 'cancelled'].includes(t.status)).length;
  bar.style.width = `${Math.round((done / total) * 100)}%`;
  bar.className = 'pt-run-progress-bar';
  if (run.phase === 'done') bar.classList.add('done');
  else if (run.phase === 'failed') bar.classList.add('failed');
}

function _updateRunKanban(run) {
  const kanban = document.getElementById(`pt-kanban-${run.id}`);
  if (!kanban) return;

  if (run.phase === 'reviewing') {
    if (!kanban.querySelector('.pt-review-panel')) {
      kanban.innerHTML = _buildReviewPanel(run);
      _wireReviewEvents(run);
    }
    return;
  }

  if (kanban.querySelector('.pt-review-panel')) {
    kanban.innerHTML = '';
  }

  const tasks = run.tasks || [];

  if (tasks.length === 0) {
    if (run.phase === 'decomposing') {
      kanban.innerHTML = `
        <div class="parallel-empty-state">
          <div class="parallel-spinner"></div>
          <div class="parallel-empty-state-text">
            <p class="parallel-empty-state-title">${t('parallel.phase.decomposing')}</p>
            <p class="parallel-empty-state-hint">${t('parallel.decomposing.hint')}</p>
          </div>
        </div>
      `;
    } else if (run.phase === 'failed' && run.error) {
      kanban.innerHTML = `
        <div class="parallel-empty-state parallel-empty-state--error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div class="parallel-empty-state-text">
            <p class="parallel-empty-state-title">${t('parallel.runFailed')}</p>
            <p class="parallel-empty-state-error">${escapeHtml(run.error)}</p>
          </div>
        </div>
      `;
    }
    return;
  }

  tasks.forEach(task => {
    let card = kanban.querySelector(`[data-task-id="${task.id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = `parallel-task-card status-${task.status}`;
      card.dataset.taskId = task.id;
      kanban.appendChild(card);
      card.innerHTML = _buildTaskCard(task);
    } else {
      _patchTaskCard(card, task);
    }
    // Wire buttons (dedup via _wired flag — safe to call on every update)
    _wireTaskCardButtons(card, run, task);
  });

  kanban.querySelectorAll('[data-task-id]').forEach(card => {
    if (!tasks.find(t => t.id === card.dataset.taskId)) card.remove();
  });
}

// ─── Task card ────────────────────────────────────────────────────────────────

/** Wire diff/terminal/expand buttons with dedup flag to prevent duplicate listeners. */
function _wireTaskCardButtons(card, run, task) {
  const diffBtn = card.querySelector('.parallel-btn-diff');
  if (diffBtn && !diffBtn._wired) {
    diffBtn._wired = true;
    diffBtn.addEventListener('click', (e) => { e.stopPropagation(); _handleViewDiff(run.id, task.id); });
  }
  const expandBtn = card.querySelector('.parallel-task-expand');
  if (expandBtn && !expandBtn._wired) {
    expandBtn._wired = true;
    expandBtn.addEventListener('click', () => card.classList.toggle('is-expanded'));
  }
  // Also allow clicking the row itself to toggle
  const row = card.querySelector('.parallel-task-row');
  if (row && !row._wired) {
    row._wired = true;
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      card.classList.toggle('is-expanded');
    });
  }
}

function _buildTaskCard(task) {
  const outputLines = _formatOutput(task.output);
  const statusLabel = t(`parallel.status.${task.status}`) || task.status;
  const isFinished = task.status === 'done' || task.status === 'failed';

  const idxMatch = task.id && task.id.match(/task-(\d+)/);
  const taskIndex = idxMatch ? String(parseInt(idxMatch[1], 10) + 1).padStart(2, '0') : '--';

  return `
    <div class="parallel-task-row">
      <span class="parallel-task-index">${taskIndex}</span>
      <span class="parallel-task-status-dot status-dot-${task.status}"></span>
      <span class="parallel-task-title">${escapeHtml(task.title || task.id)}</span>
      ${task.branch ? `<code class="parallel-task-branch-tag">${escapeHtml(task.branch.split('/').pop())}</code>` : ''}
      <span class="parallel-task-spacer"></span>
      <span class="parallel-task-actions" id="actions-${task.id}" style="${isFinished ? '' : 'display:none'}">
        <button class="parallel-btn-icon parallel-btn-diff" title="${t('parallel.card.viewDiff')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        </button>
      </span>
      <span class="parallel-task-badge badge-${task.status}">${statusLabel}</span>
      <button class="parallel-task-expand" aria-label="Toggle details">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    </div>
    <div class="parallel-task-details">
      ${task.description ? `<p class="parallel-task-desc">${escapeHtml(task.description)}</p>` : ''}
      ${task.branch ? `<div class="parallel-task-branch-full">
        <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10"><path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 019 8.5H7.5a1 1 0 000 2h1.25a2.25 2.25 0 110 1.5H7.5a2.5 2.5 0 01-2.5-2.5v-2A2.25 2.25 0 110 5.5a2.25 2.25 0 012.25 2.25v.5h4.25V5.25A2.25 2.25 0 019.5 3.25z"/></svg>
        <code>${escapeHtml(task.branch)}</code>
      </div>` : ''}
      <div class="parallel-task-output" id="output-${task.id}"><pre>${escapeHtml(outputLines)}</pre></div>
      ${task.error ? `<div class="parallel-task-error">${escapeHtml(task.error)}</div>` : ''}
    </div>
  `;
}

function _patchTaskCard(card, task) {
  card.className = `parallel-task-card status-${task.status}`;

  const dot = card.querySelector('.parallel-task-status-dot');
  if (dot) dot.className = `parallel-task-status-dot status-dot-${task.status}`;

  const badge = card.querySelector('.parallel-task-badge');
  if (badge) {
    badge.textContent = t(`parallel.status.${task.status}`) || task.status;
    badge.className = `parallel-task-badge badge-${task.status}`;
  }

  const outputEl = card.querySelector(`#output-${task.id} pre`);
  if (outputEl) {
    outputEl.textContent = _formatOutput(task.output);
    const outputBox = card.querySelector(`#output-${task.id}`);
    if (outputBox) outputBox.scrollTop = outputBox.scrollHeight;
  }

  const actions = card.querySelector(`#actions-${task.id}`);
  if (actions) {
    actions.style.display = (task.status === 'done' || task.status === 'failed') ? '' : 'none';
  }

  let errorEl = card.querySelector('.parallel-task-error');
  if (task.error) {
    if (!errorEl) {
      errorEl = document.createElement('div');
      errorEl.className = 'parallel-task-error';
      const details = card.querySelector('.parallel-task-details');
      if (details) details.appendChild(errorEl);
    }
    errorEl.textContent = task.error;
  } else if (errorEl) {
    errorEl.remove();
  }
}

// ─── Review panel ─────────────────────────────────────────────────────────────

function _buildReviewPanel(run) {
  const proposed = run.proposedTasks || [];
  const rid = run.id;
  return `
    <div class="pt-review-panel">
      <div class="pt-review-header">
        <div class="pt-review-header-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
          </svg>
        </div>
        <div>
          <p class="pt-review-title">${t('parallel.review.title')}</p>
          <p class="pt-review-subtitle">${t('parallel.review.subtitle', { count: proposed.length })}</p>
        </div>
      </div>

      <div class="pt-review-task-list">
        ${proposed.map((task, i) => `
          <div class="pt-review-task-item">
            <div class="pt-review-task-num">${String(i + 1).padStart(2, '0')}</div>
            <div class="pt-review-task-body">
              <div class="pt-review-task-title">${escapeHtml(task.title)}</div>
              <div class="pt-review-task-desc">${escapeHtml(task.description || '')}</div>
              <div class="pt-review-task-branch">
                <svg viewBox="0 0 16 16" fill="currentColor" width="9" height="9">
                  <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 019 8.5H7.5a1 1 0 000 2h1.25a2.25 2.25 0 110 1.5H7.5a2.5 2.5 0 01-2.5-2.5v-2A2.25 2.25 0 110 5.5a2.25 2.25 0 012.25 2.25v.5h4.25V5.25A2.25 2.25 0 019.5 3.25z"/>
                </svg>
                <code>${escapeHtml(task.branchSuffix || task.title || '')}</code>
              </div>
            </div>
          </div>
        `).join('')}
      </div>

      <div class="pt-review-feedback">
        <div class="pt-review-feedback-label">${t('parallel.review.feedbackLabel')} <span class="pt-review-optional">${t('parallel.review.optional')}</span></div>
        <textarea
          id="pt-review-feedback-${rid}"
          class="pt-review-feedback-input"
          placeholder="${t('parallel.review.feedbackPlaceholder')}"
          rows="2"
        ></textarea>
      </div>

      <div class="pt-review-actions">
        <button class="pt-review-btn pt-review-btn--cancel" id="pt-review-cancel-${rid}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M18 6L6 18M6 6l12 12"/></svg>
          ${t('common.cancel')}
        </button>
        <button class="pt-review-btn pt-review-btn--refine" id="pt-review-refine-${rid}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          ${t('parallel.review.regenerate')}
        </button>
        <button class="pt-review-btn pt-review-btn--confirm" id="pt-review-confirm-${rid}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><polyline points="20 6 9 17 4 12"/></svg>
          ${t('parallel.review.launch', { count: proposed.length })}
        </button>
      </div>
    </div>
  `;
}

function _wireReviewEvents(run) {
  const proposed = run.proposedTasks || [];
  const rid = run.id;

  document.getElementById(`pt-review-confirm-${rid}`)?.addEventListener('click', async () => {
    const result = await ctx.api.parallel.confirmRun({ runId: rid, tasks: proposed });
    if (!result.success) _showToast(result.error || t('parallel.errors.confirmFailed'), 'error');
  });

  document.getElementById(`pt-review-cancel-${rid}`)?.addEventListener('click', async () => {
    await ctx.api.parallel.cancelRun({ runId: rid });
  });

  document.getElementById(`pt-review-refine-${rid}`)?.addEventListener('click', async () => {
    const feedback = document.getElementById(`pt-review-feedback-${rid}`)?.value?.trim();
    if (!feedback) {
      _showToast(t('parallel.review.feedbackRequired'), 'warning');
      return;
    }
    const btn = document.getElementById(`pt-review-refine-${rid}`);
    if (btn) { btn.disabled = true; btn.textContent = t('parallel.review.regenerating'); }
    const result = await ctx.api.parallel.refineRun({ runId: rid, feedback });
    if (!result.success) {
      _showToast(result.error || t('parallel.errors.refineFailed'), 'error');
      if (btn) { btn.disabled = false; btn.textContent = t('parallel.review.regenerate'); }
    }
  });
}

// ─── Merge section ────────────────────────────────────────────────────────────

function _updateRunMerge(run) {
  const mergeSection = document.getElementById(`pt-merge-${run.id}`);
  if (!mergeSection) return;

  const showPhases = ['done', 'merging', 'merged'];
  if (!showPhases.includes(run.phase)) {
    mergeSection.style.display = 'none';
    return;
  }

  const doneTasks = (run.tasks || []).filter(t => t.status === 'done');
  if (doneTasks.length === 0 && run.phase === 'done') {
    mergeSection.style.display = 'none';
    return;
  }

  mergeSection.style.display = '';

  // ── Phase: merging (progress) ─────────────────────────────────
  if (run.phase === 'merging') {
    const p = run.mergeProgress || {};
    const r = run.resolving || null;

    let statusHtml;
    if (r) {
      // Conflict resolution in progress
      statusHtml = `
        <p class="parallel-merge-hint parallel-merge-resolving">
          ${t('parallel.merge.resolvingBranch', { branch: escapeHtml((r.branch || '').split('/').pop()) })}
        </p>
        <p class="parallel-merge-hint">
          ${t('parallel.merge.resolvingConflicts', { attempt: r.attempt || 1, maxAttempts: r.maxAttempts || 2 })}
          — ${t('parallel.merge.resolvingFiles', { count: (r.files || []).length })}
        </p>`;
    } else {
      statusHtml = `
        <p class="parallel-merge-hint">
          ${p.current && p.total ? t('parallel.merge.progress', { current: p.current, total: p.total }) : t('parallel.merge.preparing')}
          ${p.branch ? ` — <code>${escapeHtml(p.branch.split('/').pop())}</code>` : ''}
        </p>`;
    }

    mergeSection.innerHTML = `
      <div class="parallel-merge-inner parallel-merge-merging">
        <div class="parallel-merge-header">
          <div class="parallel-merge-spinner"></div>
          <h3 class="parallel-merge-title">${t('parallel.phase.merging')}</h3>
        </div>
        ${statusHtml}
      </div>`;
    return;
  }

  // ── Phase: merged (result) ────────────────────────────────────
  if (run.phase === 'merged') {
    const mr = run.mergeResult || {};
    const mb = run.mergeBranch || '';
    const hasSkipped = mr.skipped?.length > 0;
    mergeSection.innerHTML = `
      <div class="parallel-merge-inner parallel-merge-done">
        <div class="parallel-merge-header">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--pt-green)" stroke-width="2" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>
          <h3 class="parallel-merge-title">${t('parallel.merge.mergedResult', { count: mr.merged || 0 })} <code>${escapeHtml(mb.split('/').pop() || mb)}</code></h3>
        </div>
        ${hasSkipped ? `<p class="parallel-merge-skipped">${t('parallel.merge.skippedResult', { count: mr.skipped.length })}</p>` : ''}
        <div class="parallel-merge-actions">
          <button class="parallel-merge-btn parallel-merge-btn-diff" id="pt-merge-diff-${run.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            ${t('parallel.merge.viewCombinedDiff')}
          </button>
          <button class="parallel-merge-btn parallel-merge-btn-pr" id="pt-merge-pr-${run.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M6 9v12"/></svg>
            ${t('parallel.merge.createPR')}
          </button>
          <button class="parallel-merge-btn parallel-merge-btn-cancel" id="pt-merge-cancel-${run.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            ${t('parallel.merge.cancel')}
          </button>
        </div>
        <p class="parallel-merge-final-hint">
          ${t('parallel.merge.finalHint', { mainBranch: escapeHtml(run.mainBranch), mergeBranch: escapeHtml(mb) })}
        </p>
      </div>`;

    // Wire combined diff button
    const diffBtn = document.getElementById(`pt-merge-diff-${run.id}`);
    if (diffBtn) {
      diffBtn.addEventListener('click', () => _handleBranchDiff(run.projectPath, run.mainBranch, mb));
    }
    // Wire Create PR button
    const prBtn = document.getElementById(`pt-merge-pr-${run.id}`);
    if (prBtn) {
      const prBtnOriginalHTML = prBtn.innerHTML;
      prBtn.addEventListener('click', async () => {
        prBtn.disabled = true;
        prBtn.textContent = t('parallel.merge.creatingPR');
        try {
          // 1. Get remote URL
          const gitInfo = await ctx.api.git.infoFull(run.projectPath);
          const remoteUrl = gitInfo?.remoteUrl;
          if (!remoteUrl) {
            _showToast(t('parallel.merge.prNoRemote'), 'error');
            prBtn.disabled = false;
            prBtn.innerHTML = prBtnOriginalHTML;
            return;
          }
          // 2. Push merge branch
          const pushResult = await ctx.api.git.pushBranch({ projectPath: run.projectPath, branch: mb });
          if (!pushResult.success) {
            _showToast(pushResult.error || t('parallel.merge.prPushFailed'), 'error');
            prBtn.disabled = false;
            prBtn.innerHTML = prBtnOriginalHTML;
            return;
          }
          // 3. Try GitHub API if authenticated
          const forge = _detectForge(remoteUrl);
          if (forge === 'github') {
            const auth = await ctx.api.github.authStatus();
            if (auth.authenticated) {
              const prTitle = run.featureName || mb;
              const taskList = (run.tasks || []).map(tk => `- ${tk.title}`).join('\n');
              const prBody = `## Parallel Tasks\n\n${taskList}\n\nMerged from \`${mb}\` into \`${run.mainBranch}\``;
              const prResult = await ctx.api.github.createPR({ remoteUrl, title: prTitle, body: prBody, head: mb, base: run.mainBranch });
              if (prResult.success) {
                _showToast(t('parallel.merge.prCreated', { number: prResult.pr.number }), 'success');
                prBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 012 2v7"/><path d="M6 9v12"/></svg> PR #${prResult.pr.number}`;
                prBtn.classList.add('parallel-merge-btn-pr-done');
                prBtn.disabled = false;
                prBtn.onclick = () => ctx.api.dialog.openExternal(prResult.pr.url);
                return;
              }
            }
          }
          // 4. Fallback: open "new PR" page in browser
          const prUrl = _buildNewPRUrl(remoteUrl, forge, run.mainBranch, mb);
          if (prUrl) {
            ctx.api.dialog.openExternal(prUrl);
            _showToast(t('parallel.merge.prOpenedBrowser'), 'success');
          } else {
            _showToast(t('parallel.merge.prPushed'), 'success');
          }
          prBtn.disabled = false;
          prBtn.innerHTML = prBtnOriginalHTML;
        } catch (err) {
          _showToast(err.message || t('parallel.merge.prFailed'), 'error');
          prBtn.disabled = false;
          prBtn.innerHTML = prBtnOriginalHTML;
        }
      });
    }
    // Wire cancel button
    const cancelBtn = document.getElementById(`pt-merge-cancel-${run.id}`);
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        cancelBtn.disabled = true;
        cancelBtn.textContent = t('parallel.merge.cancelling');
        try {
          const result = await ctx.api.parallel.cancelMerge({ runId: run.id });
          if (!result.success) _showToast(result.error || t('parallel.merge.cancelFailed'), 'error');
        } catch (err) {
          _showToast(err.message || t('parallel.merge.cancelFailed'), 'error');
        }
      });
    }
    return;
  }

  // ── Phase: done (auto-merge button + individual diffs) ────────
  mergeSection.innerHTML = `
    <div class="parallel-merge-inner">
      <div class="parallel-merge-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
          <path d="M6 9v6"/><path d="M18 9V6a2 2 0 00-2-2H8"/><path d="M18 15v3"/>
        </svg>
        <h3 class="parallel-merge-title">${t('parallel.merge.title')}</h3>
      </div>
      <button class="parallel-merge-btn parallel-merge-btn-auto" id="pt-merge-auto-${run.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
          <path d="M6 9v6"/><path d="M18 9V6a2 2 0 00-2-2H8"/><path d="M18 15v3"/>
        </svg>
        ${t('parallel.merge.autoMerge', { count: doneTasks.length })}
      </button>
      <div class="parallel-merge-list">
        ${doneTasks.map(task => `
          <div class="parallel-merge-item">
            <code class="parallel-merge-branch">${escapeHtml(task.branch)}</code>
            <button class="parallel-btn-icon parallel-btn-diff" data-task-id="${task.id}" title="${t('parallel.card.viewDiff')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </button>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Wire auto-merge button
  const autoBtn = document.getElementById(`pt-merge-auto-${run.id}`);
  if (autoBtn) {
    autoBtn.addEventListener('click', async () => {
      autoBtn.disabled = true;
      autoBtn.textContent = t('parallel.merge.starting');
      try {
        const result = await ctx.api.parallel.mergeRun({ runId: run.id });
        if (!result.success) _showToast(result.error || t('parallel.merge.mergeFailed'), 'error');
      } catch (err) {
        _showToast(err.message || t('parallel.merge.mergeFailed'), 'error');
      }
    });
  }

  // Wire individual diff buttons
  mergeSection.querySelectorAll('.parallel-btn-diff').forEach(btn => {
    const taskId = btn.dataset.taskId;
    btn.addEventListener('click', () => _handleViewDiff(run.id, taskId));
  });
}

// ─── View diff ────────────────────────────────────────────────────────────────

async function _handleBranchDiff(projectPath, branch1, branch2) {
  const diffParams = { projectPath, branch1, branch2 };
  let statsResult;
  try {
    statsResult = await ctx.api.git.worktreeDiffStats(diffParams);
  } catch (err) {
    _showToast(err.message || t('parallel.diff.failed'), 'error');
    return;
  }
  if (!statsResult.success || !statsResult.files?.length) {
    _showToast(t('parallel.diff.noChanges'), 'warning');
    return;
  }
  _showDiffModal(t('parallel.diff.combinedTitle', { branch: branch2 }), statsResult.files, diffParams);
}

function _showDiffModal(title, files, diffParams) {
  const statusColors = { A: 'add', M: 'mod', D: 'del', R: 'ren' };
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  const fileListHtml = files.map((f, i) => {
    const basename = f.path.split('/').pop();
    const dirname = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    const ext = basename.includes('.') ? basename.split('.').pop().toLowerCase() : '';
    const icon = _diffFileIcon(ext);
    return `
      <div class="pd-file-item ${i === 0 ? 'is-active' : ''}" data-file-idx="${i}" data-file-path="${escapeHtml(f.path)}">
        <span class="pd-file-icon">${icon}</span>
        <div class="pd-file-name-wrap">
          <span class="pd-file-basename">${escapeHtml(basename)}</span>
          ${dirname ? `<span class="pd-file-dirname">${escapeHtml(dirname)}</span>` : ''}
        </div>
        <span class="pd-file-stats">
          ${f.additions ? `<span class="pd-stat-add">+${f.additions}</span>` : ''}
          ${f.deletions ? `<span class="pd-stat-del">-${f.deletions}</span>` : ''}
        </span>
        <span class="pd-file-badge pd-badge-${statusColors[f.status] || 'mod'}">${f.status}</span>
      </div>`;
  }).join('');

  const modalHtml = `
    <div class="pd-split">
      <div class="pd-files">
        <div class="pd-files-header">
          <span class="pd-files-count">${t('parallel.diff.filesCount', { count: files.length })}</span>
          <span class="pd-files-total">
            <span class="pd-stat-add">+${totalAdd}</span>
            <span class="pd-stat-del">-${totalDel}</span>
          </span>
        </div>
        <div class="pd-files-list">${fileListHtml}</div>
      </div>
      <div class="pd-content">
        <div class="pd-content-header" id="pd-content-header">
          <span class="pd-content-path">${escapeHtml(files[0].path)}</span>
          <span class="pd-content-badge" id="pd-content-badge"></span>
        </div>
        <div class="pd-diff-view" id="pd-diff-view"><span class="pd-loading">${t('common.loading')}</span></div>
      </div>
    </div>`;

  ctx.showModal(
    title,
    modalHtml,
    `<button class="modal-btn secondary" onclick="closeModal()">${t('parallel.diff.close')}</button>`
  );

  // Wire file list clicks
  const filesContainer = document.querySelector('.pd-files-list');
  if (filesContainer) {
    filesContainer.addEventListener('click', (e) => {
      const item = e.target.closest('.pd-file-item');
      if (!item) return;
      filesContainer.querySelectorAll('.pd-file-item').forEach(el => el.classList.remove('is-active'));
      item.classList.add('is-active');
      const f = files[parseInt(item.dataset.fileIdx, 10)];
      _loadFileDiff(diffParams, f);
    });
  }

  // Auto-load first file
  _loadFileDiff(diffParams, files[0]);
}

async function _handleViewDiff(runId, taskId) {
  const run = getRunById(runId);
  if (!run) { _showToast(t('parallel.errors.runNotFound'), 'error'); return; }

  const task = (run.tasks || []).find(t => t.id === taskId);
  if (!task) { _showToast(t('parallel.errors.taskNotFound'), 'error'); return; }
  if (!task.branch) { _showToast(t('parallel.errors.noBranch'), 'error'); return; }

  const diffParams = { projectPath: run.projectPath, branch1: run.mainBranch, branch2: task.branch };

  let statsResult;
  try {
    statsResult = await ctx.api.git.worktreeDiffStats(diffParams);
  } catch (err) {
    _showToast(err.message || t('parallel.diff.failed'), 'error');
    return;
  }

  if (!statsResult.success || !statsResult.files?.length) {
    _showToast(t('parallel.diff.noChanges'), 'warning');
    return;
  }

  _showDiffModal(`${t('parallel.diff.title')} — ${task.branch}`, statsResult.files, diffParams);
}

async function _loadFileDiff(diffParams, file) {
  const pathEl = document.querySelector('.pd-content-path');
  const badgeEl = document.getElementById('pd-content-badge');
  const viewer = document.getElementById('pd-diff-view');
  if (!viewer) return;

  if (pathEl) pathEl.textContent = file.path;
  if (badgeEl) {
    const adds = file.additions || 0;
    const dels = file.deletions || 0;
    badgeEl.innerHTML = `${adds ? `<span class="pd-stat-add">+${adds}</span>` : ''}${dels ? `<span class="pd-stat-del">-${dels}</span>` : ''}`;
  }
  viewer.innerHTML = `<span class="pd-loading">${t('common.loading')}</span>`;

  try {
    const result = await ctx.api.git.worktreeDiff({ ...diffParams, filePath: file.path });
    if (!result.success || !result.diff) {
      viewer.innerHTML = `<span class="pd-empty">${t('parallel.diff.noFileChanges')}</span>`;
      return;
    }
    viewer.innerHTML = _renderDiff(result.diff);
  } catch {
    viewer.innerHTML = `<span class="pd-empty">${t('parallel.diff.loadFailed')}</span>`;
  }
}

function _renderDiff(diff) {
  const lines = diff.split('\n');
  let oldLine = 0, newLine = 0;
  const rows = [];

  for (const line of lines) {
    // Skip file headers
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) continue;

    if (line.startsWith('@@')) {
      const m = line.match(/@@ -(\d+)/);
      if (m) { oldLine = parseInt(m[1], 10); }
      const m2 = line.match(/\+(\d+)/);
      if (m2) { newLine = parseInt(m2[1], 10); }
      rows.push(`<div class="diff-row diff-hunk"><span class="diff-ln"></span><span class="diff-ln"></span><span class="diff-gutter"></span><span class="diff-text">${escapeHtml(line)}</span></div>`);
      continue;
    }

    if (line.startsWith('+')) {
      rows.push(`<div class="diff-row diff-add"><span class="diff-ln"></span><span class="diff-ln">${newLine}</span><span class="diff-gutter">+</span><span class="diff-text">${escapeHtml(line.slice(1))}</span></div>`);
      newLine++;
    } else if (line.startsWith('-')) {
      rows.push(`<div class="diff-row diff-del"><span class="diff-ln">${oldLine}</span><span class="diff-ln"></span><span class="diff-gutter">-</span><span class="diff-text">${escapeHtml(line.slice(1))}</span></div>`);
      oldLine++;
    } else {
      // Context line (starts with space or is empty)
      const text = line.startsWith(' ') ? line.slice(1) : line;
      rows.push(`<div class="diff-row diff-ctx"><span class="diff-ln">${oldLine}</span><span class="diff-ln">${newLine}</span><span class="diff-gutter"></span><span class="diff-text">${escapeHtml(text)}</span></div>`);
      oldLine++;
      newLine++;
    }
  }

  return `<div class="diff-table">${rows.join('')}</div>`;
}

function _diffFileIcon(ext) {
  const icons = {
    js: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#f0db4f" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#f0db4f" font-size="8" font-weight="700">JS</text></svg>',
    ts: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#3178c6" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#3178c6" font-size="8" font-weight="700">TS</text></svg>',
    tsx: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#3178c6" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#3178c6" font-size="7" font-weight="700">TX</text></svg>',
    jsx: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#61dafb" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#61dafb" font-size="7" font-weight="700">JX</text></svg>',
    css: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#264de4" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#264de4" font-size="7" font-weight="700">CS</text></svg>',
    json: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#a8b1c2" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#a8b1c2" font-size="6" font-weight="700">{}</text></svg>',
    html: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#e44d26" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#e44d26" font-size="6" font-weight="700">&lt;&gt;</text></svg>',
    md: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#888" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#888" font-size="7" font-weight="700">M</text></svg>',
    py: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#3776ab" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#3776ab" font-size="7" font-weight="700">PY</text></svg>',
    lua: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 3h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2z" stroke="#000080" stroke-width="1.5"/><text x="12" y="16" text-anchor="middle" fill="#000080" font-size="6" font-weight="700">Lua</text></svg>',
  };
  return icons[ext] || '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _populateProjectSelector(container) {
  const sel = container?.querySelector('#pm-project-select');
  if (!sel || !ctx) return;

  const projects = ctx.projectsState?.get()?.projects || [];
  const openedId = ctx.projectsState?.get()?.openedProjectId;
  const filtered = projects.filter(p => p.path);
  const selected = filtered.find(p => p.id === openedId) || filtered[0];

  const dropdown = sel.querySelector('.pt-select-dropdown');
  const valueEl = sel.querySelector('.pt-select-value');
  if (!dropdown) return;

  dropdown.innerHTML = filtered
    .map(p => `<div class="pt-select-option${p.id === openedId ? ' is-selected' : ''}" data-value="${escapeHtml(p.path)}">${escapeHtml(p.name || p.path)}</div>`)
    .join('');

  if (selected) {
    sel.dataset.value = selected.path;
    if (valueEl) valueEl.textContent = selected.name || selected.path;
  }
}

async function _loadHistory() {
  if (!ctx?.api?.parallel) return;
  const projectPath = ctx.projectsState?.get()?.openedProjectId
    ? ctx.projectsState?.get()?.projects?.find(p => p.id === ctx.projectsState?.get()?.openedProjectId)?.path
    : null;
  const result = await ctx.api.parallel.getHistory({ projectPath });
  if (!result.success) return;

  const historyRuns = result.runs || [];
  historyRuns.forEach(run => {
    // Only restore runs that have tasks to show, skip if already active
    if (!getRunById(run.id) && Array.isArray(run.tasks) && run.tasks.length > 0) {
      addRun({ ...run, _fromHistory: true });
    }
  });

}

function _deriveNameFromGoal(goal) {
  return goal.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 40);
}

/** Convert kebab-case featureName to Title Case (e.g. "win-animation" → "Win Animation") */
function _formatFeatureName(name) {
  if (!name) return '';
  return name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function _formatOutput(output) {
  if (!output) return '';
  return output.split('\n').slice(-20).join('\n');
}

function _showToast(msg, type) {
  if (ctx?.showToast) ctx.showToast({ type: type || 'info', title: msg });
}

function _detectForge(remoteUrl) {
  if (!remoteUrl) return null;
  const url = remoteUrl.toLowerCase();
  if (url.includes('github.com')) return 'github';
  if (url.includes('gitlab')) return 'gitlab';
  if (url.includes('bitbucket')) return 'bitbucket';
  return null;
}

function _buildNewPRUrl(remoteUrl, forge, base, head) {
  const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (!match) return null;
  const [, owner, repo] = match;
  const h = encodeURIComponent(head);
  const b = encodeURIComponent(base);
  switch (forge) {
    case 'github': return `https://github.com/${owner}/${repo}/compare/${b}...${h}?expand=1`;
    case 'gitlab': return `https://gitlab.com/${owner}/${repo}/-/merge_requests/new?merge_request[source_branch]=${h}&merge_request[target_branch]=${b}`;
    case 'bitbucket': return `https://bitbucket.org/${owner}/${repo}/pull-requests/new?source=${h}&dest=${b}`;
    default: return null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, load };
