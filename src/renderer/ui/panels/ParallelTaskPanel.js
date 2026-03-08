/**
 * ParallelTaskPanel
 * Orchestrates multiple concurrent parallel Claude coding runs.
 * Runs appear as a list of cards. New runs are created via modal.
 */

'use strict';

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { getSetting, setSetting } = require('../../state/settings.state');
const {
  parallelTaskState,
  getRuns,
  getRunById,
  addRun,
  removeRun,
  setHistory,
  initParallelListeners,
} = require('../../state/parallelTask.state');

// ─── Module state ─────────────────────────────────────────────────────────────

let ctx = null;
let _initialized = false;
let _unsubscribe = null;
let _runCounter = 0;
let _runNumbers = new Map();
let _runNames = new Map(); // runId → generated short name

// ─── Init & Load ──────────────────────────────────────────────────────────────

function init(context) {
  ctx = context;
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
          New Run
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
            _showToast(cancelRes.error || 'Cancel failed', 'error');
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
            <span class="pt-modal-title">New Parallel Run</span>
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
                <span class="pt-select-value">— select project —</span>
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
              <label class="pm-label">${t('parallel.form.maxTasksLabel')}</label>
              <div class="parallel-agents-control">
                <input
                  type="range"
                  id="pm-agents-slider"
                  class="parallel-agents-slider"
                  min="1" max="10" value="${escapeHtml(String(savedMaxTasks))}" step="1"
                />
                <div class="parallel-agents-display">
                  <span id="pm-agents-value" class="parallel-agents-value">${savedMaxTasks}</span>
                  <span class="parallel-agents-unit">agents</span>
                </div>
              </div>
              <div class="parallel-agents-ticks">
                <span>1</span><span>3</span><span>5</span><span>7</span><span>10</span>
              </div>
            </div>

            <div class="pm-field">
              <label class="pm-label">${t('parallel.form.modelLabel')}</label>
              <div class="pt-select pt-select--full" id="pm-model-select" data-value="claude-sonnet-4-6">
                <div class="pt-select-trigger">
                  <span class="pt-select-value">Sonnet 4.6 — Balanced</span>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M7 10l5 5 5-5z"/></svg>
                </div>
                <div class="pt-select-dropdown">
                  <div class="pt-select-option" data-value="claude-haiku-4-5-20251001">Haiku 4.5 — Fastest</div>
                  <div class="pt-select-option is-selected" data-value="claude-sonnet-4-6">Sonnet 4.6 — Balanced</div>
                  <div class="pt-select-option" data-value="claude-opus-4-6">Opus 4.6 — Most capable</div>
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
                </div>
              </div>
            </div>
          </div>

        </div><!-- /.pt-modal-body -->

        <div class="pt-modal-footer">
          <button class="pt-modal-cancel-btn" id="pt-modal-cancel">Cancel</button>
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

  // Agents slider
  const slider = modalOverlay.querySelector('#pm-agents-slider');
  const valueDisplay = modalOverlay.querySelector('#pm-agents-value');
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

  const maxTasks = parseInt(modalEl?.querySelector('#pm-agents-slider')?.value || '3', 10);
  const model = modalEl?.querySelector('#pm-model-select')?.dataset?.value || 'claude-sonnet-4-6';
  const effort = modalEl?.querySelector('#pm-effort-select')?.dataset?.value || 'high';

  setSetting('parallelMaxAgents', maxTasks);

  const branchResult = await ctx.api.git.currentBranch({ projectPath }).catch(() => null);
  const mainBranch = (branchResult?.branch || branchResult) || 'main';

  const btn = modalEl?.querySelector('#pm-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('parallel.form.startingBtn'); }

  const result = await ctx.api.parallel.startRun({ projectPath, mainBranch, goal, maxTasks, model, effort });

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

  // Generate short display name async via haiku
  if (ctx.api?.chat?.generateTabName) {
    const runId = result.runId;
    ctx.api.chat.generateTabName({ userMessage: goal }).then(res => {
      if (res?.success && res.name) {
        _runNames.set(runId, res.name);
        const nameEl = document.querySelector(`#pt-run-card-${runId} .pt-run-goal-text`);
        if (nameEl) nameEl.textContent = res.name;
      }
    }).catch(() => {});
  }
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
          <p class="pt-empty-runs-title">No parallel runs yet</p>
          <p class="pt-empty-runs-hint">Decompose a feature into independent sub-tasks, each running in its own git worktree</p>
          <button class="pt-empty-runs-cta" id="pt-empty-new-run">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11" height="11">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            New Run
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
      listEl.insertBefore(card, listEl.firstChild);
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
  const displayName = _runNames.get(run.id) || _deriveNameFromGoal(run.goal || '');

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
          Cancel
        </button>
        <button class="pt-run-action-btn pt-run-action-btn--cleanup" data-action="cleanup" data-run-id="${run.id}" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="9" height="9"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
          Cleanup
        </button>
        <button class="pt-run-action-btn pt-run-action-btn--remove" data-action="remove" data-run-id="${run.id}" style="display:none">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="9" height="9"><path d="M18 6L6 18M6 6l12 12"/></svg>
          Remove
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

  const tasks = run.tasks || [];
  const done = tasks.filter(t => t.status === 'done').length;
  const total = tasks.length;
  const isActive = ['decomposing', 'reviewing', 'creating-worktrees', 'running'].includes(run.phase);
  const isFinished = ['done', 'failed', 'cancelled'].includes(run.phase);

  const dot = document.getElementById(`pt-phasedot-${run.id}`);
  if (dot) {
    dot.className = 'pt-run-phase-dot';
    if (isActive) dot.classList.add('running');
    else if (run.phase === 'done') dot.classList.add('done');
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
            <p class="parallel-empty-state-hint">Claude is analyzing your goal and creating independent sub-tasks...</p>
          </div>
        </div>
      `;
    } else if (run.phase === 'failed' && run.error) {
      kanban.innerHTML = `
        <div class="parallel-empty-state parallel-empty-state--error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <div class="parallel-empty-state-text">
            <p class="parallel-empty-state-title">Run failed</p>
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
      // Wire task buttons directly (more reliable than delegation through kanban)
      card.querySelector('.parallel-btn-diff')?.addEventListener('click', () => {
        _handleViewDiff(run.id, task.id);
      });
      card.querySelector('.parallel-btn-terminal')?.addEventListener('click', () => {
        if (task.worktreePath && ctx.openTerminalAtPath) ctx.openTerminalAtPath(task.worktreePath);
      });
    } else {
      _patchTaskCard(card, task);
    }
  });

  kanban.querySelectorAll('[data-task-id]').forEach(card => {
    if (!tasks.find(t => t.id === card.dataset.taskId)) card.remove();
  });
}

// ─── Task card ────────────────────────────────────────────────────────────────

function _buildTaskCard(task) {
  const outputLines = _formatOutput(task.output);
  const statusLabel = t(`parallel.status.${task.status}`) || task.status;
  const isFinished = task.status === 'done' || task.status === 'failed';
  const isRunning = task.status === 'running';

  const idxMatch = task.id && task.id.match(/task-(\d+)/);
  const taskIndex = idxMatch ? String(parseInt(idxMatch[1], 10)).padStart(2, '0') : '--';

  return `
    <div class="parallel-task-card-header">
      <span class="parallel-task-title">
        <span class="parallel-task-index">${taskIndex}</span>
        ${escapeHtml(task.title || task.id)}
      </span>
      <span class="parallel-task-badge badge-${task.status}">${statusLabel}</span>
    </div>
    ${task.description ? `<p class="parallel-task-desc">${escapeHtml(task.description)}</p>` : ''}
    ${task.branch ? `
      <div class="parallel-task-branch">
        <svg viewBox="0 0 16 16" fill="currentColor" width="9" height="9">
          <path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 019 8.5H7.5a1 1 0 000 2h1.25a2.25 2.25 0 110 1.5H7.5a2.5 2.5 0 01-2.5-2.5v-2A2.25 2.25 0 110 5.5a2.25 2.25 0 012.25 2.25v.5h4.25V5.25A2.25 2.25 0 019.5 3.25z"/>
        </svg>
        <code>${escapeHtml(task.branch)}</code>
      </div>
    ` : ''}
    <div class="parallel-task-output-wrap" id="output-wrap-${task.id}">
      <div class="parallel-task-output" id="output-${task.id}"><pre>${escapeHtml(outputLines)}</pre></div>
    </div>
    ${task.error ? `<div class="parallel-task-error">${escapeHtml(task.error)}</div>` : ''}
    <div class="parallel-task-footer" id="footer-${task.id}" style="${isFinished ? '' : 'display:none'}">
      <button class="parallel-btn-sm parallel-btn-diff" data-task-id="${task.id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/></svg>
        ${t('parallel.card.viewDiff')}
      </button>
      <button class="parallel-btn-sm parallel-btn-terminal" data-worktree-path="${escapeHtml(task.worktreePath || '')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><polyline points="4,17 10,11 4,5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        ${t('parallel.card.openTerminal')}
      </button>
    </div>
  `;
}

function _patchTaskCard(card, task) {
  card.className = `parallel-task-card status-${task.status}`;

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

  const footer = card.querySelector(`#footer-${task.id}`);
  if (footer) {
    footer.style.display = (task.status === 'done' || task.status === 'failed') ? '' : 'none';
  }

  let errorEl = card.querySelector('.parallel-task-error');
  if (task.error) {
    if (!errorEl) {
      errorEl = document.createElement('div');
      errorEl.className = 'parallel-task-error';
      const f = card.querySelector('.parallel-task-footer');
      if (f) f.before(errorEl); else card.appendChild(errorEl);
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
          <p class="pt-review-title">Review proposed tasks</p>
          <p class="pt-review-subtitle">${proposed.length} sub-task${proposed.length !== 1 ? 's' : ''} — confirm to launch or request changes</p>
        </div>
      </div>

      <div class="pt-review-task-list">
        ${proposed.map((task, i) => `
          <div class="pt-review-task-item">
            <div class="pt-review-task-num">${String(i).padStart(2, '0')}</div>
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
        <div class="pt-review-feedback-label">Modification request <span class="pt-review-optional">(optional)</span></div>
        <textarea
          id="pt-review-feedback-${rid}"
          class="pt-review-feedback-input"
          placeholder="e.g. « split task 0 into two — one for the model, one for the controller »"
          rows="2"
        ></textarea>
      </div>

      <div class="pt-review-actions">
        <button class="pt-review-btn pt-review-btn--cancel" id="pt-review-cancel-${rid}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M18 6L6 18M6 6l12 12"/></svg>
          Cancel
        </button>
        <button class="pt-review-btn pt-review-btn--refine" id="pt-review-refine-${rid}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          Re-generate
        </button>
        <button class="pt-review-btn pt-review-btn--confirm" id="pt-review-confirm-${rid}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><polyline points="20 6 9 17 4 12"/></svg>
          Launch ${proposed.length} task${proposed.length !== 1 ? 's' : ''}
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
    if (!result.success) _showToast(result.error || 'Confirm failed', 'error');
  });

  document.getElementById(`pt-review-cancel-${rid}`)?.addEventListener('click', async () => {
    await ctx.api.parallel.cancelRun({ runId: rid });
  });

  document.getElementById(`pt-review-refine-${rid}`)?.addEventListener('click', async () => {
    const feedback = document.getElementById(`pt-review-feedback-${rid}`)?.value?.trim();
    if (!feedback) {
      _showToast('Enter a modification request first', 'warning');
      return;
    }
    const btn = document.getElementById(`pt-review-refine-${rid}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Regenerating...'; }
    const result = await ctx.api.parallel.refineRun({ runId: rid, feedback });
    if (!result.success) {
      _showToast(result.error || 'Refine failed', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Re-generate'; }
    }
  });
}

// ─── Merge section ────────────────────────────────────────────────────────────

function _updateRunMerge(run) {
  const mergeSection = document.getElementById(`pt-merge-${run.id}`);
  if (!mergeSection) return;

  if (run.phase !== 'done') {
    mergeSection.style.display = 'none';
    return;
  }

  const doneTasks = (run.tasks || []).filter(t => t.status === 'done');
  if (doneTasks.length === 0) {
    mergeSection.style.display = 'none';
    return;
  }

  mergeSection.style.display = '';
  mergeSection.innerHTML = `
    <div class="parallel-merge-inner">
      <div class="parallel-merge-header">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
          <path d="M6 9v6"/><path d="M18 9V6a2 2 0 00-2-2H8"/><path d="M18 15v3"/>
        </svg>
        <h3 class="parallel-merge-title">${t('parallel.merge.title')}</h3>
      </div>
      <p class="parallel-merge-hint">${t('parallel.merge.hint', { mainBranch: escapeHtml(run.mainBranch) })}</p>
      <div class="parallel-merge-list">
        ${doneTasks.map(task => `
          <div class="parallel-merge-item">
            <div class="parallel-merge-branch-row">
              <code class="parallel-merge-branch">${escapeHtml(task.branch)}</code>
              <button class="parallel-btn-sm parallel-btn-diff" data-task-id="${task.id}">
                ${t('parallel.merge.viewDiff')}
              </button>
            </div>
            <div class="parallel-merge-cmds">
              <code class="parallel-merge-cmd">git checkout ${escapeHtml(run.mainBranch)}</code>
              <code class="parallel-merge-cmd">git merge ${escapeHtml(task.branch)}</code>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // Wire diff buttons directly (innerHTML buttons have no listeners)
  mergeSection.querySelectorAll('.parallel-btn-diff').forEach(btn => {
    const taskId = btn.dataset.taskId;
    btn.addEventListener('click', () => _handleViewDiff(run.id, taskId));
  });
}

// ─── View diff ────────────────────────────────────────────────────────────────

async function _handleViewDiff(runId, taskId) {
  const run = getRunById(runId);
  if (!run) { _showToast('Run not found', 'error'); return; }

  const task = (run.tasks || []).find(t => t.id === taskId);
  if (!task) { _showToast('Task not found', 'error'); return; }
  if (!task.branch) { _showToast('No branch associated with this task', 'error'); return; }

  let result;
  try {
    result = await ctx.api.git.worktreeDiff({
      projectPath: run.projectPath,
      branch1: run.mainBranch,
      branch2: task.branch
    });
  } catch (err) {
    _showToast(err.message || 'Diff failed', 'error');
    return;
  }

  if (!result.success) {
    _showToast(result.error || t('parallel.errors.noDiff'), 'error');
    return;
  }

  if (!result.diff) {
    _showToast('No changes found between branches', 'warning');
    return;
  }

  const diffHtml = _renderDiff(result.diff);
  ctx.showModal(
    `${t('parallel.diff.title')} — ${task.branch}`,
    `<div class="parallel-diff-modal"><pre class="diff-view">${diffHtml}</pre></div>`,
    `<button onclick="document.getElementById('modal-overlay').click()">${t('parallel.diff.close')}</button>`
  );
}

function _renderDiff(diff) {
  return diff
    .split('\n')
    .map(line => {
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${escapeHtml(line)}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${escapeHtml(line)}</span>`;
      if (line.startsWith('@@')) return `<span class="diff-hunk">${escapeHtml(line)}</span>`;
      return escapeHtml(line);
    })
    .join('\n');
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
  if (result.success) {
    setHistory(result.runs || []);
    // Generate short names for history runs that don't have one yet
    if (ctx.api?.chat?.generateTabName) {
      (result.runs || []).forEach(run => {
        if (!_runNames.has(run.id) && run.goal) {
          ctx.api.chat.generateTabName({ userMessage: run.goal }).then(res => {
            if (res?.success && res.name) {
              _runNames.set(run.id, res.name);
              const nameEl = document.querySelector(`#pt-run-card-${run.id} .pt-run-goal-text`);
              if (nameEl) nameEl.textContent = res.name;
            }
          }).catch(() => {});
        }
      });
    }
  }
}

function _deriveNameFromGoal(goal) {
  return goal.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 40);
}

function _formatOutput(output) {
  if (!output) return '';
  return output.split('\n').slice(-20).join('\n');
}

function _showToast(msg, type) {
  if (ctx?.showToast) ctx.showToast(msg, type);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { init, load };
