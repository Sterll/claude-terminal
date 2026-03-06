const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const WorkflowMarketplace = require('./WorkflowMarketplacePanel');
const { getAgents } = require('../../services/AgentService');
const { getSkills } = require('../../services/SkillService');
const { getGraphService, resetGraphService } = require('../../services/WorkflowGraphEngine');
const { projectsState } = require('../../state/projects.state');
const { schemaCache } = require('../../services/WorkflowSchemaCache');
const { showContextMenu } = require('../components/ContextMenu');
const { showConfirm } = require('../components/Modal');
const { createChatView } = require('../components/ChatView');
const nodeRegistry = require('../../services/NodeRegistry');
const fieldRegistry = require('../../workflow-fields/_registry');

const {
  // Constants
  HOOK_TYPES, NODE_OUTPUTS, STEP_TYPES, STEP_FIELDS, STEP_TYPE_ALIASES,
  GIT_ACTIONS, WAIT_UNITS, CONDITION_VARS, CONDITION_OPS,
  TRIGGER_CONFIG, CRON_MODES,
  // Functions
  findStepType, buildConditionPreview, getTriggerConfig,
  drawCronPicker, bindWfDropdown, wfDropdown,
  // Formatting
  fmtTime, fmtDuration, statusDot, statusLabel,
  // SVG icons
  svgWorkflow, svgAgent, svgShell, svgGit, svgHttp, svgNotify, svgWait, svgCond,
  svgClock, svgTimer, svgHook, svgChain, svgPlay, svgX, svgScope, svgConc,
  svgEmpty, svgRuns, svgClaude, svgPrompt, svgSkill, svgProject, svgFile, svgDb,
  svgLoop, svgVariable, svgLog, svgTriggerType, svgLink, svgMode, svgEdit,
  svgBranch, svgCode, svgTrash, svgCopy, svgTransform, svgGetVar, svgSwitch,
  svgSubworkflow, svgTeal,
  // Autocomplete & Schema
  getLoopPreview, initSmartSQL,
  // DOM helpers
  upgradeSelectsToDropdowns, setupAutocomplete,
  insertLoopBetween,
} = require('./WorkflowHelpers');

let ctx = null;

const state = {
  workflows: [],
  runs: [],
  activeTab: 'workflows',  // 'workflows' | 'runs' | 'hub'
  viewingRunId: null,       // track which run detail is open
};

const _agentLogs = new Map(); // stepId → [{ type, text, ts }]
const MAX_LOG_ENTRIES = 50;

let _activeEditorWorkflowId = null; // tracks current open editor's workflowId

let _panelInitialized = false;

function init(context) {
  ctx = context;
  WorkflowMarketplace.init(context);
}

async function load() {
  const inEditor = !!document.querySelector('#workflow-panel .wf-editor');

  if (!_panelInitialized) {
    renderPanel();
    _panelInitialized = true;
    await refreshData();
    renderContent();
    registerLiveListeners();
    return;
  }

  // Panel already built — refresh data silently
  await refreshData();

  // If the editor is open, don't touch the DOM: preserve the editing session + AI chat
  if (!inEditor) {
    renderContent();
  }
}

const api = window.electron_api?.workflow;

/** Fetch workflows + recent runs from backend */
async function refreshData() {
  try {
    const [wfRes, runRes] = await Promise.all([
      api?.list(),
      api?.getRecentRuns(50),
    ]);
    if (wfRes?.success) {
      state.workflows = wfRes.workflows;
      window._workflowsListCache = wfRes.workflows; // for trigger-config & subworkflow-picker field renderers
    }
    if (runRes?.success) state.runs = runRes.runs;
  } catch (e) {
    console.error('[WorkflowPanel] Failed to load data:', e);
  }
}

let listenersRegistered = false;
/** Register real-time event listeners for live run updates */
function registerLiveListeners() {
  if (listenersRegistered || !api) return;
  listenersRegistered = true;

  api.onRunStart(({ run }) => {
    state.runs.unshift(run);
    // Clear previous run outputs for fresh tooltip data
    try { getGraphService().clearRunOutputs(); } catch (_) {}
    renderContent();
  });

  api.onRunEnd(({ runId, status, duration }) => {
    const run = state.runs.find(r => r.id === runId);
    if (run) {
      run.status = status;
      run.duration = duration;
    }
    // Clear all agent logs for this run's steps
    for (const step of (run?.steps || [])) _agentLogs.delete(step.id);
    // If viewing this run's detail, re-render it fully (with final outputs)
    if (state.viewingRunId === runId) {
      renderRunDetail(document.getElementById('wf-content'), run);
    } else {
      renderContent();
    }
  });

  const _stepStartTimes = new Map(); // stepId → Date.now()

  api.onStepUpdate(({ runId, stepId, status, output }) => {
    const run = state.runs.find(r => r.id === runId);
    if (run) {
      const step = run.steps?.find(s => s.id === stepId);
      if (step) {
        step.status = status;
        if (output) step.output = output;
      }
    }

    // Track step timing
    if (status === 'running') {
      _stepStartTimes.set(stepId, Date.now());
    }

    // Update canvas node status for live visualization
    try {
      const graphService = getGraphService();
      if (graphService) {
        // Find the graph node matching this stepId
        const graphNode = graphService._nodes?.find(n =>
          n.properties?.stepId === stepId || `node_${n.id}` === stepId
        );
        if (graphNode) {
          // Map runner status to canvas status
          const canvasStatus = status === 'retrying' ? 'running' : status;
          graphService.setNodeStatus(graphNode.id, canvasStatus);

          // Store duration on completion
          if (status === 'success' || status === 'failed' || status === 'skipped') {
            const startTime = _stepStartTimes.get(stepId);
            if (startTime) {
              graphNode._runDuration = Date.now() - startTime;
              _stepStartTimes.delete(stepId);
            }
          }

          // Store error
          if (status === 'failed' && output?.error) {
            graphNode._runError = output.error;
          }

          // Store step output for tooltips and Last Run tab
          if (output && status === 'success') {
            graphService.setNodeOutput(graphNode.id, output);
          }
        }
      }
    } catch (_) { /* ignore */ }

    // Incremental update if viewing this run's detail, otherwise full re-render
    if (state.viewingRunId === runId) {
      _updateStepInDetail(runId, stepId, status, output);
    } else {
      renderContent();
    }

    // Clean up agent logs when step finishes
    if (status === 'success' || status === 'failed' || status === 'skipped') {
      _agentLogs.delete(stepId);
    }
  });

  // MCP graph edit tools signal a reload after modifying definitions.json directly
  api.onListUpdated(({ workflows }) => {
    if (workflows) state.workflows = workflows;
    renderContent();

    // If the editor is open, reload the live graph from the updated definition
    const graphService = getGraphService();
    if (graphService) {
      const editorEl = document.querySelector('.wf-editor');
      if (_activeEditorWorkflowId && workflows) {
        const updated = workflows.find(w => w.id === _activeEditorWorkflowId);
        if (updated) graphService.loadFromWorkflow(updated);
      }
    }
  });

  // Live loop progress — update loop step output as iterations complete
  api.onLoopProgress(({ runId, stepId, loopOutput }) => {
    const run = state.runs.find(r => r.id === runId);
    if (!run) return;
    const step = run.steps?.find(s => s.id === stepId);
    if (step) step.output = loopOutput;
    // Update loop step in detail view without full re-render
    if (state.viewingRunId === runId) {
      _updateLoopStepInDetail(stepId, loopOutput, run);
    }
  });

  // Live streaming logs for Claude/agent nodes
  api.onAgentMessage(({ runId, stepId, message }) => {
    if (!message) return;
    const entries = _agentLogs.get(stepId) || [];

    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          const detail = block.input?.file_path || block.input?.command || block.input?.pattern || '';
          entries.push({ type: 'tool', text: detail ? `${block.name}: ${detail}` : block.name, ts: Date.now() });
        }
        if (block.type === 'text' && block.text) {
          entries.push({ type: 'text', text: block.text.slice(0, 200), ts: Date.now() });
        }
      }
    }
    while (entries.length > MAX_LOG_ENTRIES) entries.shift();
    _agentLogs.set(stepId, entries);
    _scheduleLogUpdate(stepId);
  });
}

/* ─── Step accordion toggle bindings ─────────────────────────────────────── */

/** Bind click-to-expand/collapse for a loop's iteration accordion and child steps */
function _bindLoopAccordion(stepEl) {
  // Single delegated listener on stepEl covers all iter-headers and child-steps
  if (stepEl._loopAccordionBound) return;
  stepEl._loopAccordionBound = true;

  stepEl.addEventListener('click', (e) => {
    // Iteration header → toggle iteration steps visibility
    const header = e.target.closest('.wf-loop-iter-header');
    if (header && stepEl.contains(header)) {
      e.stopPropagation();
      const iter = header.closest('.wf-loop-iter');
      if (!iter) return;
      const stepsEl = iter.querySelector('.wf-loop-iter-steps');
      if (!stepsEl) return;
      const visible = stepsEl.style.display !== 'none';
      stepsEl.style.display = visible ? 'none' : 'block';
      iter.classList.toggle('expanded', !visible);
      return;
    }

    // Child step with output → toggle output visibility
    const childEl = e.target.closest('.wf-loop-child-step.has-output');
    if (childEl && stepEl.contains(childEl)) {
      e.stopPropagation();
      const outputEl = childEl.nextElementSibling;
      if (!outputEl || !outputEl.classList.contains('wf-loop-child-output')) return;
      const visible = outputEl.style.display !== 'none';
      outputEl.style.display = visible ? 'none' : 'block';
      childEl.classList.toggle('expanded', !visible);
    }
  });
}

/** Bind click-to-expand/collapse for a single run step element */
function _bindStepToggle(stepEl) {
  if (stepEl._stepToggleBound) return;
  stepEl._stepToggleBound = true;

  const isLoop = stepEl.querySelector('.wf-loop-iterations') != null;

  if (isLoop) {
    const iterationsEl = stepEl.querySelector('.wf-loop-iterations');
    stepEl.addEventListener('click', (e) => {
      // Only react to clicks on the direct step header (not on nested iter-headers)
      const header = e.target.closest('.wf-run-step-header');
      if (!header) return;
      if (!stepEl.contains(header)) return;
      // Ignore if the click came from inside the iterations panel itself
      if (iterationsEl && iterationsEl.contains(e.target)) return;
      if (!iterationsEl) return;
      const visible = iterationsEl.style.display !== 'none';
      iterationsEl.style.display = visible ? 'none' : 'block';
      stepEl.classList.toggle('expanded', !visible);
    });
    _bindLoopAccordion(stepEl);
  } else {
    const outputEl = stepEl.querySelector('.wf-run-step-output');
    stepEl.addEventListener('click', (e) => {
      const header = e.target.closest('.wf-run-step-header');
      if (!header || !stepEl.contains(header)) return;
      if (!outputEl) return;
      const visible = outputEl.style.display !== 'none';
      outputEl.style.display = visible ? 'none' : 'block';
      stepEl.classList.toggle('expanded', !visible);
    });
  }
}

/* ─── Live loop progress updater ─────────────────────────────────────────── */

function _updateLoopStepInDetail(stepId, loopOutput, run) {
  const stepEl = document.querySelector(`.wf-run-step[data-step-id="${stepId}"]`);
  if (!stepEl) return;

  // Update iteration badge (×N done / total)
  const done = loopOutput.done || (loopOutput.items || []).length;
  const total = loopOutput.count || done;
  const badge = stepEl.querySelector('.wf-loop-iter-badge');
  if (badge) badge.textContent = `×${done}/${total}`;

  // Rebuild the iterations accordion with current data
  const totalRunDuration = (run.steps || []).reduce((s, st) => s + (st.duration || 0), 0) || 1;
  const step = run.steps?.find(s => s.id === stepId);
  if (!step) return;
  step.output = loopOutput;

  const existingAccordion = stepEl.querySelector('.wf-loop-iterations');
  const newHtml = buildLoopIterationsHtml(step, totalRunDuration);
  if (newHtml) {
    const tmp = document.createElement('div');
    tmp.innerHTML = newHtml;
    const newAccordion = tmp.firstElementChild;
    if (existingAccordion) {
      // Preserve open/closed state of existing iterations
      existingAccordion.querySelectorAll('.wf-loop-iter').forEach((el, i) => {
        if (!el.classList.contains('collapsed')) {
          newAccordion?.querySelectorAll('.wf-loop-iter')[i]?.classList.remove('collapsed');
        }
      });
      existingAccordion.replaceWith(newAccordion);
    } else {
      stepEl.querySelector('.wf-run-step-header')?.after(newAccordion);
    }
    // Re-bind all accordion toggle events (header + inner iterations + child steps)
    _bindStepToggle(stepEl);
  }
}

/* ─── Live log throttled DOM updater ─────────────────────────────────────── */

let _logTimer = null;
const _pendingLogs = new Set();

function _scheduleLogUpdate(stepId) {
  _pendingLogs.add(stepId);
  if (_logTimer) return;
  _logTimer = requestAnimationFrame(() => {
    _logTimer = null;
    for (const sid of _pendingLogs) _updateLiveLogDOM(sid);
    _pendingLogs.clear();
  });
}

function _updateLiveLogDOM(stepId) {
  const container = document.querySelector(`.wf-live-log[data-step-id="${stepId}"]`);
  if (!container) return;
  const entries = _agentLogs.get(stepId) || [];
  container.innerHTML = entries.map(e =>
    `<div class="wf-log-entry wf-log-entry--${e.type}">` +
    (e.type === 'tool' ? `<span class="wf-log-icon">\u2699</span>` : '') +
    `<span class="wf-log-text">${escapeHtml(e.text)}</span></div>`
  ).join('');
  container.scrollTop = container.scrollHeight;
}

/** Incremental update of a single step in the detail view (avoids full re-render) */
function _updateStepInDetail(runId, stepId, status, output) {
  const run = state.runs.find(r => r.id === runId);
  if (!run) return;
  const stepIdx = run.steps?.findIndex(s => s.id === stepId);
  if (stepIdx === -1) return;

  const stepEl = document.querySelector(`.wf-run-step[data-step-id="${stepId}"]`);
  if (!stepEl) {
    const detailCol = document.getElementById('wf-detail-col');
    if (detailCol) renderRunDetailInCol(detailCol, run);
    return;
  }

  // Update status class
  stepEl.className = stepEl.className.replace(/wf-run-step--\w+/g, '');
  stepEl.classList.add(`wf-run-step--${status}`);
  if (status === 'failed') stepEl.classList.add('wf-run-step--error-highlight');

  // Update status icon
  const iconEl = stepEl.querySelector('.wf-run-step-status-icon');
  if (iconEl) {
    iconEl.textContent = status === 'success' ? '\u2713' : status === 'failed' ? '\u2717' : status === 'skipped' ? '\u2013' : '\u2026';
  }

  // Add/remove live log container
  const existingLog = stepEl.querySelector('.wf-live-log');
  if (status === 'running' && !existingLog) {
    const logEl = document.createElement('div');
    logEl.className = 'wf-live-log';
    logEl.dataset.stepId = stepId;
    stepEl.querySelector('.wf-run-step-header')?.after(logEl);
  } else if (status !== 'running' && existingLog) {
    existingLog.remove();
  }

  // Show output when step completes
  if ((status === 'success' || status === 'failed') && output != null) {
    let outputEl = stepEl.querySelector('.wf-run-step-output');
    if (!outputEl) {
      outputEl = document.createElement('div');
      outputEl.className = 'wf-run-step-output';
      outputEl.innerHTML = `<pre class="wf-run-step-pre">${escapeHtml(formatStepOutput(output))}</pre>`;
      stepEl.appendChild(outputEl);
      // Add chevron if missing
      if (!stepEl.querySelector('.wf-run-step-chevron')) {
        const header = stepEl.querySelector('.wf-run-step-header');
        header?.insertAdjacentHTML('beforeend', '<svg class="wf-run-step-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>');
        header.style.cursor = 'pointer';
        header.addEventListener('click', () => {
          const visible = outputEl.style.display !== 'none';
          outputEl.style.display = visible ? 'none' : 'block';
          stepEl.classList.toggle('expanded', !visible);
        });
      }
    }
  }
}

/* ─── Panel shell ──────────────────────────────────────────────────────────── */

function renderPanel() {
  const el = document.getElementById('workflow-panel');
  if (!el) return;

  el.innerHTML = `
    <div class="wf-panel">
      <div class="wf-topbar">
        <div class="wf-topbar-tabs">
          <button class="wf-tab active" data-wftab="workflows">
            ${t('workflow.workflowsTab')} <span class="wf-badge">3</span>
          </button>
          <button class="wf-tab" data-wftab="runs">
            ${t('workflow.runsTab')} <span class="wf-badge">4</span>
          </button>
          <button class="wf-tab wf-tab--hub" id="wf-tab-hub">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            ${t('workflow.hubTab')}
          </button>
        </div>
        <button class="wf-create-btn" id="wf-btn-new">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
          ${t('common.new')}
        </button>
      </div>
      <div class="wf-content" id="wf-content"></div>
    </div>
  `;

  el.querySelector('#wf-btn-new').addEventListener('click', () => openEditor());

  // Hub tab opens modal instead of switching content
  el.querySelector('#wf-tab-hub').addEventListener('click', () => {
    WorkflowMarketplace.open();
  });

  el.querySelectorAll('.wf-tab:not(.wf-tab--hub)').forEach(tab => {
    tab.addEventListener('click', () => {
      el.querySelectorAll('.wf-tab:not(.wf-tab--hub)').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeTab = tab.dataset.wftab;
      renderContent();
    });
  });
}

function renderContent() {
  state.viewingRunId = null;
  const el = document.getElementById('wf-content');
  if (!el) return;
  _activeEditorWorkflowId = null;
  // Update badge counts
  const panel = document.getElementById('workflow-panel');
  if (panel) {
    const badges = panel.querySelectorAll('.wf-badge');
    if (badges[0]) badges[0].textContent = state.workflows.length;
    if (badges[1]) badges[1].textContent = state.runs.length;
  }
  if (state.activeTab === 'workflows') renderWorkflowList(el);
  else if (state.activeTab === 'runs') renderRunHistory(el);
}

/* ─── Workflow list ────────────────────────────────────────────────────────── */

function renderWorkflowList(el) {
  if (!state.workflows.length) {
    el.innerHTML = `
      <div class="wf-empty">
        <div class="wf-empty-glyph">${svgWorkflow(36)}</div>
        <p class="wf-empty-title">${t('workflow.list.emptyTitle')}</p>
        <p class="wf-empty-sub">${t('workflow.list.emptySub')}</p>
        <button class="wf-create-btn" id="wf-empty-new">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
          ${t('workflow.list.createBtn')}
        </button>
      </div>
    `;
    el.querySelector('#wf-empty-new').addEventListener('click', () => openEditor());
    return;
  }

  // Sort: favorites first, then by last run date
  const sorted = [...state.workflows].sort((a, b) => {
    if (a.favorite && !b.favorite) return -1;
    if (!a.favorite && b.favorite) return 1;
    const aRun = state.runs.find(r => r.workflowId === a.id);
    const bRun = state.runs.find(r => r.workflowId === b.id);
    return (bRun?.startedAt || 0) - (aRun?.startedAt || 0);
  });
  const listDiv = document.createElement('div');
  listDiv.className = 'wf-list';
  listDiv.innerHTML = sorted.map(wf => cardHtml(wf)).join('');
  el.replaceChildren(listDiv);

  // Single delegated click handler for the whole list
  listDiv.addEventListener('click', async (e) => {
    const card = e.target.closest('.wf-card[data-id]');
    if (!card) return;
    const id = card.dataset.id;

    if (e.target.closest('.wf-card-fav')) {
      e.stopPropagation();
      const wf = state.workflows.find(w => w.id === id);
      if (!wf) return;
      wf.favorite = !wf.favorite;
      await api?.save({ ...wf });
      renderContent();
      return;
    }
    if (e.target.closest('.wf-card-run')) { e.stopPropagation(); triggerWorkflow(id); return; }
    if (e.target.closest('.wf-card-stop')) {
      e.stopPropagation();
      const runId = e.target.closest('.wf-card-stop').dataset.runId;
      if (runId) api?.cancel(runId);
      return;
    }
    if (e.target.closest('.wf-card-edit')) { e.stopPropagation(); openEditor(id); return; }
    if (e.target.closest('.wf-switch')) { e.stopPropagation(); return; }
    openDetail(id);
  });

  listDiv.addEventListener('change', (e) => {
    const toggle = e.target.closest('.wf-card-toggle');
    if (!toggle) return;
    e.stopPropagation();
    const id = toggle.closest('.wf-card[data-id]')?.dataset.id;
    if (id) toggleWorkflow(id, toggle.checked);
  });

  listDiv.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.wf-card[data-id]');
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    const id = card.dataset.id;
    const wf = state.workflows.find(w => w.id === id);
    if (!wf) return;
    showContextMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: t('workflow.contextMenu.edit'), icon: svgEdit(), onClick: () => openEditor(id) },
        { label: t('workflow.contextMenu.runNow'), icon: svgPlay(12), onClick: () => triggerWorkflow(id) },
        { label: t('workflow.contextMenu.duplicate'), icon: svgCopy(), onClick: () => duplicateWorkflow(id) },
        { separator: true },
        { label: t('workflow.contextMenu.delete'), icon: svgTrash(), danger: true, onClick: () => confirmDeleteWorkflow(id, wf.name) },
      ],
    });
  });
}

function cardHtml(wf) {
  const lastRun = state.runs.find(r => r.workflowId === wf.id);
  const cfg = getTriggerConfig(wf.trigger?.type);
  const runCount = state.runs.filter(r => r.workflowId === wf.id).length;
  const successCount = state.runs.filter(r => r.workflowId === wf.id && r.status === 'success').length;

  return `
    <div class="wf-card ${wf.enabled ? '' : 'wf-card--off'}" data-id="${wf.id}">
      <div class="wf-card-accent wf-card-accent--${cfg.color}"></div>
      <div class="wf-card-body">
        <div class="wf-card-top">
          <div class="wf-card-title-row">
            <button class="wf-card-fav ${wf.favorite ? 'wf-card-fav--active' : ''}" title="${wf.favorite ? t('workflow.favorites.remove') : t('workflow.favorites.add')}">
              <svg width="12" height="12" viewBox="0 0 24 24" ${wf.favorite ? 'fill="currentColor"' : 'fill="none"'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </button>
            <span class="wf-card-name">${escapeHtml(wf.name)}</span>
            ${!wf.enabled ? `<span class="wf-card-paused">${t('workflow.paused')}</span>` : ''}
          </div>
          <div class="wf-card-top-right">
            ${lastRun ? `<span class="wf-status-pill wf-status-pill--${lastRun.status}">${statusDot(lastRun.status)}${statusLabel(lastRun.status)}</span>` : ''}
            <label class="wf-switch"><input type="checkbox" class="wf-card-toggle" ${wf.enabled ? 'checked' : ''}><span class="wf-switch-track"></span></label>
          </div>
        </div>
        <div class="wf-card-pipeline">
          ${(wf.steps || []).map((s, i) => {
            const info = findStepType((s.type || '').split('.')[0]);
            const stepStatus = lastRun ? (lastRun.steps?.[i]?.status || '') : '';
            return `<div class="wf-pipe-step ${stepStatus ? 'wf-pipe-step--' + stepStatus : ''}" title="${escapeHtml(s.type || '')}">
              <span class="wf-chip wf-chip--${info.color}">${info.icon}</span>
              <span class="wf-pipe-label">${escapeHtml(info.label)}</span>
            </div>${i < wf.steps.length - 1 ? '<span class="wf-pipe-arrow"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span>' : ''}`;
          }).join('')}
        </div>
        <div class="wf-card-footer">
          <span class="wf-trigger-tag wf-trigger-tag--${cfg.color}">
            ${cfg.icon}
            ${escapeHtml(cfg.label)}
            ${wf.trigger?.value ? `<code>${escapeHtml(wf.trigger.value)}</code>` : ''}
            ${wf.hookType ? `<code>${escapeHtml(wf.hookType)}</code>` : ''}
          </span>
          <div class="wf-card-stats">
            ${runCount > 0 ? `<span class="wf-card-stat">${svgRuns()} ${runCount} run${runCount > 1 ? 's' : ''}</span>` : ''}
            ${runCount > 0 ? `<span class="wf-card-stat wf-card-stat--rate">${Math.round(successCount / runCount * 100)}%</span>` : ''}
            ${lastRun ? `<span class="wf-card-stat">${svgClock(9)} ${fmtDuration(lastRun.duration)}</span>` : ''}
          </div>
          <button class="wf-card-edit" title="${t('workflow.editBtn')}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          ${lastRun?.status === 'running'
            ? `<button class="wf-card-stop" data-run-id="${lastRun.id}" title="${t('workflow.stopTitle')}"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg> <span>${t('workflow.stop')}</span></button>`
            : `<button class="wf-card-run" title="${t('workflow.runTitle')}">${svgPlay(11)} <span>${t('workflow.run')}</span></button>`
          }
        </div>
      </div>
    </div>
  `;
}

/* ─── Run history helpers ──────────────────────────────────────────────────── */

function buildTimelineHtml(steps) {
  const total = steps.reduce((s, st) => s + (st.duration || 0), 0) || 1;
  return steps
    .filter(s => s.duration > 0 || s.status === 'running')
    .map(s => {
      const sType = (s.type || '').split('.')[0];
      const pct = Math.max(1, Math.round(((s.duration || 0) / total) * 100));
      return `<div class="wf-run-timeline-seg wf-run-timeline-seg--${sType}" style="width:${pct}%" title="${sType}"></div>`;
    })
    .join('');
}

function buildLoopIterationsHtml(step, totalRunDuration) {
  const loopOutput = step.output;
  if (!loopOutput || !Array.isArray(loopOutput.items)) return '';

  const chevronSvg = `<svg class="wf-loop-iter-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  const itersHtml = loopOutput.items.map((iterOutputs, idx) => {
    const item = iterOutputs?._item;
    let itemLabel = t('workflow.runMeta.iterationLabel', { n: idx + 1 });
    if (item && typeof item === 'object') {
      if (item.name && item.path) itemLabel = `\uD83D\uDCC1 ${escapeHtml(item.name)} \xB7 ${escapeHtml(item.path)}`;
      else if (item.name) itemLabel = `\uD83D\uDCC1 ${escapeHtml(item.name)}`;
      else itemLabel = `${idx + 1} \xB7 ${escapeHtml(JSON.stringify(item).slice(0, 40))}`;
    } else if (typeof item === 'string') {
      itemLabel = `${idx + 1} \xB7 ${escapeHtml(item.slice(0, 50))}`;
    }

    const childEntries = Object.entries(iterOutputs || {}).filter(([k]) => k !== '_item');
    const hasFailed = childEntries.some(([, v]) => v?._status === 'failed');
    const hasRunning = childEntries.some(([, v]) => v?._status === 'running');
    const iterStatus = hasFailed ? 'failed' : hasRunning ? 'running' : 'success';
    const iterStatusIcon = iterStatus === 'success' ? '\u2713' : iterStatus === 'failed' ? '\u2717' : '\u2026';

    const childStepsHtml = childEntries.map(([nodeId, nodeOutput]) => {
      const childStatus = nodeOutput?._status || 'success';
      const childType = (nodeOutput?._type || nodeId.replace('node_', '')).split('.')[0];
      const childInfo = findStepType(childType);
      const childDur = nodeOutput?._duration || 0;
      const childPct = totalRunDuration > 0 ? Math.max(1, Math.round((childDur / totalRunDuration) * 100)) : 2;
      const hasOut = nodeOutput != null && Object.keys(nodeOutput).filter(k => !k.startsWith('_')).length > 0;
      const childChevron = hasOut ? `<svg class="wf-loop-child-chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>` : '';
      return `
        <div class="wf-loop-child-step wf-loop-child-step--${childStatus}${hasOut ? ' has-output' : ''}" data-node-id="${escapeHtml(nodeId)}" data-iter="${idx}">
          <span class="wf-chip wf-chip--${childInfo.color}">${childInfo.icon}</span>
          <span class="wf-loop-child-type">${escapeHtml(childInfo.label || childType)}</span>
          <div class="wf-loop-child-timing"><div class="wf-loop-child-timing-bar" style="width:${childPct}%"></div></div>
          <span class="wf-loop-child-dur">${fmtDuration(childDur)}</span>
          <span class="wf-loop-child-status">${childStatus === 'success' ? '\u2713' : childStatus === 'failed' ? '\u2717' : childStatus === 'skipped' ? '\u2013' : '\u2026'}</span>
          ${childChevron}
        </div>
        ${hasOut ? `<div class="wf-loop-child-output" style="display:none"><pre class="wf-run-step-pre">${escapeHtml(formatStepOutput(nodeOutput))}</pre></div>` : ''}
      `;
    }).join('');

    return `
      <div class="wf-loop-iter wf-loop-iter--${iterStatus}" data-iter-idx="${idx}">
        <div class="wf-loop-iter-header">
          <span class="wf-loop-iter-num">${idx + 1}</span>
          <span class="wf-loop-iter-item">${itemLabel}</span>
          <span class="wf-loop-iter-status">${iterStatusIcon}</span>
          ${chevronSvg}
        </div>
        <div class="wf-loop-iter-steps" style="display:none">${childStepsHtml}</div>
      </div>
    `;
  }).join('');

  return `<div class="wf-loop-iterations" style="display:none">${itersHtml}</div>`;
}

function buildRunCardHtml(run) {
  const wf = state.workflows.find(w => w.id === run.workflowId);
  const statusLabels = {
    success: `\u25CF ${t('workflow.helpers.status.success')}`,
    failed: `\u2717 ${t('workflow.helpers.status.failed')}`,
    running: `\u27F3 ${t('workflow.helpers.status.running')}`,
    cancelled: `\u2013 ${t('workflow.helpers.status.cancelled')}`,
    pending: `\u2026 ${t('workflow.helpers.status.pending')}`,
  };
  const statusLabel_ = statusLabels[run.status] || run.status;

  const pipelineHtml = (run.steps || []).map((s, i) => {
    const sType = (s.type || s.name || '').split('.')[0];
    const info = findStepType(sType);
    const statusIcon = s.status === 'success' ? '\u2713' : s.status === 'failed' ? '\u2717' : s.status === 'skipped' ? '\u2013' : s.status === 'running' ? '\u2026' : '';
    const isLoop = sType === 'loop';
    const loopCount = isLoop && s.output?.count ? `<span class="wf-run-pipe-loop-count">\xD7${s.output.count}</span>` : '';
    const connector = i < (run.steps || []).length - 1 ? '<div class="wf-run-pipe-connector"></div>' : '';
    return `<div class="wf-run-pipe-step wf-run-pipe-step--${s.status}">
      <span class="wf-run-pipe-icon wf-chip wf-chip--${info.color}">${info.icon}</span>
      <span class="wf-run-pipe-name">${escapeHtml(info.label || sType)}</span>
      ${loopCount}
      ${statusIcon ? `<span class="wf-run-pipe-status">${statusIcon}</span>` : ''}
    </div>${connector}`;
  }).join('');

  const isRunning = run.status === 'running';
  return `
    <div class="wf-run-card wf-run-card--${run.status}" data-run-id="${run.id}">
      <div class="wf-run-card-accent"></div>
      <div class="wf-run-card-body">
        <div class="wf-run-card-top">
          <span class="wf-run-card-name">${escapeHtml(wf?.name || t('workflow.runMeta.deletedLabel'))}</span>
          <div class="wf-run-card-top-right">
            <span class="wf-run-card-status">${statusLabel_}</span>
            ${isRunning ? `<button class="wf-run-stop-btn" data-run-id="${run.id}" title="${t('workflow.runMeta.stopTitle')}">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </button>` : ''}
          </div>
        </div>
        <div class="wf-run-card-meta">${fmtTime(run.startedAt)} \xB7 ${fmtDuration(run.duration)} \xB7 ${escapeHtml(run.trigger)}</div>
        <div class="wf-run-card-pipeline">${pipelineHtml}</div>
      </div>
    </div>
  `;
}

/* ─── Run history ──────────────────────────────────────────────────────────── */

function renderRunHistory(el) {
  const INITIAL_LIMIT = 20;
  const showAll = el._showAllRuns || false;
  const runs = showAll ? state.runs : state.runs.slice(0, INITIAL_LIMIT);
  const hasMore = state.runs.length > INITIAL_LIMIT && !showAll;

  el.innerHTML = `
    <div class="wf-history-layout">
      <div class="wf-runs-list">
        <div class="wf-runs-list-header">
          <span class="wf-runs-list-count">${state.runs.length} run${state.runs.length !== 1 ? 's' : ''}</span>
          <button class="wf-runs-clear" id="wf-clear-runs" title="${t('workflow.history.clearTitle')}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            ${t('workflow.history.clearBtn')}
          </button>
        </div>
        <div class="wf-runs-list-scroll">
          ${!state.runs.length ? `<div class="wf-empty"><p class="wf-empty-title">${t('workflow.history.emptyTitle')}</p><p class="wf-empty-sub">${t('workflow.history.emptySub')}</p></div>` : ''}
          ${runs.map(buildRunCardHtml).join('')}
          ${hasMore ? `<div class="wf-runs-show-more" id="wf-show-more-runs">${t('workflow.history.showMore', { n: state.runs.length - INITIAL_LIMIT })}</div>` : ''}
        </div>
      </div>
      <div class="wf-run-detail-col" id="wf-detail-col">
        <div class="wf-run-detail-empty">
          <span class="wf-run-detail-empty-icon">\u27F3</span>
          <span class="wf-run-detail-empty-text">${t('workflow.history.selectRun')}</span>
        </div>
      </div>
    </div>
  `;

  // Restore previously selected run detail
  if (state.viewingRunId) {
    const run = state.runs.find(r => r.id === state.viewingRunId);
    if (run) {
      const detailCol = el.querySelector('#wf-detail-col');
      renderRunDetailInCol(detailCol, run);
      el.querySelector(`.wf-run-card[data-run-id="${run.id}"]`)?.classList.add('wf-run-card--selected');
    }
  }

  // Single delegated listener for run cards and stop buttons
  const scrollEl = el.querySelector('.wf-runs-list-scroll');
  if (scrollEl) {
    scrollEl.addEventListener('click', async (e) => {
      const stopBtn = e.target.closest('.wf-run-stop-btn[data-run-id]');
      if (stopBtn) { e.stopPropagation(); await api?.cancel(stopBtn.dataset.runId); return; }

      const card = e.target.closest('.wf-run-card[data-run-id]');
      if (!card) return;
      const run = state.runs.find(r => r.id === card.dataset.runId);
      if (!run) return;
      scrollEl.querySelectorAll('.wf-run-card').forEach(c => c.classList.remove('wf-run-card--selected'));
      card.classList.add('wf-run-card--selected');
      const detailCol = el.querySelector('#wf-detail-col');
      if (detailCol) renderRunDetailInCol(detailCol, run);
    });
  }

  // Clear all runs
  el.querySelector('#wf-clear-runs')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const confirmed = await showConfirm({
      title: t('workflow.history.clearTitle'),
      message: t('workflow.history.clearMessage', { n: state.runs.length }),
      confirmLabel: t('workflow.history.clearBtn'),
      danger: true,
    });
    if (!confirmed) return;
    await api?.clearAllRuns();
    state.runs = [];
    state.viewingRunId = null;
    renderContent();
  });

  // Show more
  el.querySelector('#wf-show-more-runs')?.addEventListener('click', () => {
    el._showAllRuns = true;
    renderRunHistory(el);
  });
}

/* ─── Run Detail View ──────────────────────────────────────────────────── */

function renderRunDetailInCol(col, run) {
  state.viewingRunId = run.id;
  const wf = state.workflows.find(w => w.id === run.workflowId);
  const steps = run.steps || [];
  const totalDuration = steps.reduce((s, st) => s + (st.duration || 0), 0) || 1;
  const chevronSvg = `<svg class="wf-run-step-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  const stepsHtml = steps.map((step, i) => {
    const sType = (step.type || step.name || '').split('.')[0];
    const info = findStepType(sType);
    const isLoop = sType === 'loop';
    const hasOutput = step.output != null;
    const isFailed = step.status === 'failed';
    const isRunningAgent = step.status === 'running' && (sType === 'claude' || sType === 'agent');
    const errorMsg = isFailed && step.error ? step.error : (isFailed && typeof step.output === 'string' && step.output.length < 500 ? step.output : null);
    const pct = Math.max(2, Math.round(((step.duration || 0) / totalDuration) * 100));
    const loopCount = isLoop && step.output?.count ? step.output.count : 0;
    const loopBadge = isLoop && loopCount ? `<span class="wf-loop-iter-badge">\xD7${loopCount}</span>` : '';
    const loopAccordion = isLoop ? buildLoopIterationsHtml(step, totalDuration) : '';
    const outputSection = isLoop
      ? loopAccordion
      : (hasOutput ? `<div class="wf-run-step-output" style="display:${isFailed ? 'block' : 'none'}"><pre class="wf-run-step-pre">${escapeHtml(formatStepOutput(step.output))}</pre></div>` : '');
    const canExpand = isLoop ? loopCount > 0 : hasOutput;

    return `
      <div class="wf-run-step wf-run-step--${step.status}${isFailed ? ' wf-run-step--error-highlight' : ''}" data-step-idx="${i}" data-step-id="${step.id}">
        <div class="wf-run-step-header">
          <span class="wf-run-step-num">${i + 1}</span>
          <span class="wf-run-step-icon wf-chip wf-chip--${info.color}">${info.icon}</span>
          <span class="wf-run-step-name">${escapeHtml(step.id || step.type || '')}</span>
          <span class="wf-run-step-type">${escapeHtml(info.label || sType).toUpperCase()}</span>
          <div class="wf-run-step-timing"><div class="wf-run-step-timing-bar" style="width:${pct}%"></div></div>
          <span class="wf-run-step-dur">${fmtDuration(step.duration)}</span>
          ${loopBadge}
          <span class="wf-run-step-status-icon">${step.status === 'success' ? '\u2713' : step.status === 'failed' ? '\u2717' : step.status === 'skipped' ? '\u2013' : '\u2026'}</span>
          ${canExpand ? chevronSvg : ''}
        </div>
        ${isRunningAgent ? `<div class="wf-live-log" data-step-id="${step.id}"></div>` : ''}
        ${errorMsg ? `<div class="wf-run-step-error"><span class="wf-run-step-error-label">${t('workflow.errorLabel')}</span> ${escapeHtml(errorMsg)}</div>` : ''}
        ${outputSection}
      </div>
    `;
  }).join('');

  col.innerHTML = `
    <div class="wf-run-detail">
      <div class="wf-run-detail-header-new">
        <div class="wf-run-detail-title-row">
          <span class="wf-run-detail-name">${escapeHtml(wf?.name || t('workflow.runMeta.workflowDeleted'))}</span>
          <div class="wf-run-detail-actions">
            ${run.status === 'running'
              ? `<button class="wf-run-stop-btn wf-run-stop-btn--detail" id="wf-run-stop">
                   <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
                   ${t('workflow.stop')}
                 </button>`
              : (wf ? `<button class="wf-run-detail-rerun" id="wf-run-rerun">${svgPlay(10)} ${t('workflow.runMeta.rerun')}</button>` : '')
            }
            <span class="wf-status-pill wf-status-pill--${run.status}">${statusDot(run.status)}${statusLabel(run.status)}</span>
          </div>
        </div>
        <div class="wf-run-detail-meta">
          ${svgClock(9)} ${fmtTime(run.startedAt)}
          <span style="margin:0 5px;opacity:.25">\xB7</span>
          ${svgTimer()} ${fmtDuration(run.duration)}
          <span style="margin:0 5px;opacity:.25">\xB7</span>
          <span class="wf-run-trigger-tag" style="font-size:10px">${escapeHtml(run.trigger)}</span>
        </div>
        <div class="wf-run-detail-timeline">${buildTimelineHtml(steps)}</div>
      </div>
      <div class="wf-run-detail-steps">${stepsHtml}</div>
    </div>
  `;

  // Re-run button
  col.querySelector('#wf-run-rerun')?.addEventListener('click', async () => {
    if (run.workflowId) await triggerWorkflow(run.workflowId);
  });

  // Stop button (detail header)
  col.querySelector('#wf-run-stop')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await api?.cancel(run.id);
  });

  // Toggle step outputs / loop accordion
  col.querySelectorAll('.wf-run-step').forEach(stepEl => _bindStepToggle(stepEl));

  // Populate existing live logs
  for (const [stepId, entries] of _agentLogs) {
    if (entries.length > 0) _updateLiveLogDOM(stepId);
  }
}

/** Legacy alias — called by onRunEnd when viewing a run, forwards to new col-based renderer */
function renderRunDetail(el, run) {
  // If the 2-col layout is active, render in the detail column
  const detailCol = document.getElementById('wf-detail-col');
  if (detailCol) {
    renderRunDetailInCol(detailCol, run);
    return;
  }
  // Fallback: re-render full history (handles edge cases)
  renderContent();
}

function formatStepOutput(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/* ─── Node Graph Editor ─────────────────────────────────────────────────── */

// Cache for DB connections (loaded from disk via IPC, independent of Database panel state)
window._dbConnectionsCache = null;
async function loadDbConnections() {
  try {
    window._dbConnectionsCache = await window.electron_api.database.loadConnections() || [];
  } catch { window._dbConnectionsCache = []; }
}

// Node type → color mapping for diagram cards
const WF_NODE_COLORS = {
  trigger: '#22c55e', claude: '#a78bfa', shell: '#60a5fa', git: '#f97316',
  http: '#06b6d4', db: '#f59e0b', file: '#e2e8f0', notify: '#ec4899',
  wait: '#94a3b8', log: '#64748b', condition: '#eab308', loop: '#8b5cf6',
  variable: '#10b981',
};

/**
 * Transform a plain-text workflow diagram code block into a visual card.
 * Handles lines like: [Trigger Manuel], ↓, [DB Query] → SELECT * FROM users
 */
function _renderWfDiagramBlock(block, text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    if (line === '↓' || line === '→') {
      items.push({ type: 'arrow' });
      continue;
    }
    // Match [Node Name] → description  OR  [Node Name]
    const m = line.match(/^\[([^\]]+)\](?:\s*→\s*(.+))?$/);
    if (m) {
      const label = m[1];
      const detail = m[2] || null;
      // Guess node type from label
      const lc = label.toLowerCase();
      let nodeType = 'variable';
      for (const t of Object.keys(WF_NODE_COLORS)) {
        if (lc.includes(t)) { nodeType = t; break; }
      }
      items.push({ type: 'node', label, detail, nodeType });
    } else {
      // Plain text line inside a step (e.g. detail continuation)
      if (items.length && items[items.length - 1].type === 'node' && !items[items.length - 1].detail) {
        items[items.length - 1].detail = line;
      }
    }
  }

  if (!items.some(i => i.type === 'node')) return; // nothing to render

  const rows = items.map(item => {
    if (item.type === 'arrow') {
      return `<div class="wf-diag-arrow">↓</div>`;
    }
    const color = WF_NODE_COLORS[item.nodeType] || '#94a3b8';
    const detail = item.detail ? `<span class="wf-diag-detail" title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</span>` : '';
    return `<div class="wf-diag-node" style="--node-color:${color}">
      <span class="wf-diag-dot"></span>
      <span class="wf-diag-label">${escapeHtml(item.label)}</span>
      ${detail}
    </div>`;
  }).join('');

  // Hide original code block chrome (header + pre) and replace with diagram
  block.style.background = 'none';
  block.style.border = 'none';
  block.style.padding = '0';
  block.innerHTML = `<div class="wf-diag-card">${rows}</div>`;
}

function openEditor(workflowId = null) {
  _activeEditorWorkflowId = workflowId;
  const wf = workflowId ? state.workflows.find(w => w.id === workflowId) : null;
  const editorDraft = {
    name: wf?.name || '',
    scope: wf?.scope || 'current',
    concurrency: wf?.concurrency || 'skip',
    dirty: false,
    variables: (wf?.variables || []).map(v => ({ ...v })), // abstract variable definitions
  };

  // ── Render editor into the panel ──
  const panel = document.getElementById('workflow-panel');
  if (!panel) return;

  // Pre-load DB connections from disk (async, used by DB node properties)
  loadDbConnections();

  // Pre-load node registry (async, used by generic field renderer)
  nodeRegistry.loadNodeRegistry().catch(e => console.warn('[WorkflowPanel] nodeRegistry load error:', e));

  // Load all custom field renderers (synchronous, idempotent)
  fieldRegistry.loadAll();

  const graphService = getGraphService();

  // Store previous panel content for restore
  const prevContent = panel.innerHTML;
  const nodeTypes = STEP_TYPES.filter(st => st.type !== 'trigger');

  // ── Build editor HTML ──
  panel.innerHTML = `
    <div class="wf-editor">
      <div class="wf-editor-toolbar">
        <!-- Left: navigation + name -->
        <div class="wf-editor-toolbar-left">
          <button class="wf-editor-back" id="wf-ed-back">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
            ${t('workflow.back')}
          </button>
          <div class="wf-editor-toolbar-sep"></div>
          <input class="wf-editor-name wf-input" id="wf-ed-name" value="${escapeHtml(editorDraft.name)}" placeholder="${t('workflow.untitled')}…" />
          <span class="wf-editor-dirty" id="wf-ed-dirty" style="display:none" title="${t('workflow.editor.unsavedChanges')}"></span>
        </div>

        <!-- Center: history + zoom -->
        <div class="wf-editor-toolbar-center">
          <div class="wf-editor-history">
            <button class="wf-ed-hist-btn" id="wf-ed-undo" title="Undo (Ctrl+Z)" disabled>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
            </button>
            <button class="wf-ed-hist-btn" id="wf-ed-redo" title="Redo (Ctrl+Y)" disabled>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
            </button>
          </div>
          <div class="wf-editor-toolbar-sep"></div>
          <div class="wf-editor-zoom">
            <button id="wf-ed-zoom-out" title="Zoom out (−)">−</button>
            <span id="wf-ed-zoom-label">100%</span>
            <button id="wf-ed-zoom-in" title="Zoom in (+)">+</button>
            <button id="wf-ed-zoom-reset" title="Reset zoom (1:1)">1:1</button>
            <button id="wf-ed-zoom-fit" title="${t('workflow.fitView')} (F)">${t('workflow.fitView')}</button>
          </div>
          <div class="wf-editor-toolbar-sep"></div>
          <button class="wf-ed-hist-btn" id="wf-ed-comment" title="${t('workflow.addComment')}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="13" y2="12"/></svg>
          </button>
          <button class="wf-ed-hist-btn" id="wf-ed-minimap" title="${t('workflow.toggleMinimap')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          </button>
        </div>

        <!-- Right: actions -->
        <div class="wf-editor-toolbar-right">
          <button class="wf-editor-btn wf-editor-btn--run" id="wf-ed-run" title="${t('workflow.runTitle')}">
            <span class="wf-btn-icon"><svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg></span>
            ${t('workflow.run')}
          </button>
          <button class="wf-editor-btn wf-editor-btn--ai" id="wf-ed-ai" title="${t('workflow.aiBuilderTitle')}">
            <span class="wf-btn-icon wf-btn-icon--ai"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg></span>
            AI
          </button>
          <button class="wf-editor-btn wf-editor-btn--primary" id="wf-ed-save" title="${t('workflow.save')} (Ctrl+S)">
            <span class="wf-btn-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></span>
            ${t('workflow.save')}
          </button>
        </div>
      </div>
      <div class="wf-editor-body">
        <div class="wf-editor-left-panel">
          <div class="wf-lp-tabs">
            <button class="wf-lp-tab active" data-lp-tab="nodes">${t('workflow.nodesTab')}</button>
            <button class="wf-lp-tab" data-lp-tab="vars">${t('workflow.editor.variablesTab')}</button>
          </div>
          <div class="wf-lp-content" data-lp-content="nodes">
            <div class="wf-editor-palette" id="wf-ed-palette">
              ${[
                { key: 'action', title: t('workflow.editor.palette.actions') },
                { key: 'data',   title: t('workflow.editor.palette.data') },
                { key: 'flow',   title: t('workflow.editor.palette.flow') },
              ].map(cat => {
                const items = nodeTypes.filter(st => st.category === cat.key);
                if (!items.length) return '';
                return `<div class="wf-palette-title"><span>${cat.title}</span></div>` +
                  items.map(st => `
                    <div class="wf-palette-item" data-node-type="workflow/${st.type}" data-color="${st.color}" title="${st.desc}" draggable="true">
                      <span class="wf-palette-icon wf-chip wf-chip--${st.color}">${st.icon}</span>
                      <span class="wf-palette-label">${st.label}</span>
                    </div>
                  `).join('');
              }).join('')}
            </div>
          </div>
          <div class="wf-lp-content" data-lp-content="vars" style="display:none">
            <div class="wf-vars-panel" id="wf-vars-panel">
              <div class="wf-vars-panel-header">
                <button class="wf-vars-add-btn" id="wf-vars-add" title="${t('workflow.editor.addVariable')}">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
              </div>
              <div class="wf-vars-list" id="wf-vars-list">
                <div class="wf-vars-empty">
                  <svg class="wf-vars-empty-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                  <span class="wf-vars-empty-text">${t('workflow.editor.varsEmpty')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="wf-editor-canvas-wrap" id="wf-ed-canvas-wrap">
          <canvas id="wf-litegraph-canvas"></canvas>
        </div>
        <div class="wf-editor-properties" id="wf-ed-properties">
          <div class="wf-props-empty">
            <div class="wf-props-empty-icon-wrap">
              <svg class="wf-props-empty-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/></svg>
            </div>
            <div class="wf-props-empty-title">${t('workflow.properties')}</div>
            <p class="wf-props-empty-text">${t('workflow.editor.selectNode')}</p>
          </div>
        </div>
      </div>
      <div class="wf-editor-statusbar">
        <span class="wf-sb-section" id="wf-ed-nodecount"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg> 0 ${t('workflow.nodeLabel')}s</span>
        <span class="wf-sb-section wf-sb-selection" id="wf-ed-selection" style="display:none"></span>
        <span class="wf-sb-sep"></span>
        <span class="wf-sb-section wf-sb-name" id="wf-ed-sb-name">${escapeHtml(editorDraft.name) || t('workflow.untitled')}</span>
        <span class="wf-sb-section wf-sb-dirty" id="wf-ed-sb-dirty" style="display:none">${t('workflow.modified')}</span>
        <span class="wf-sb-spacer"></span>
        <span class="wf-sb-section" id="wf-ed-zoom-pct">100%</span>
      </div>
      <div class="wf-ai-panel" id="wf-ai-panel" style="display:none">
        <div class="wf-ai-panel-header">
          <span class="wf-ai-panel-title">${t('workflow.aiBuilderTitle')}</span>
          <button class="wf-ai-panel-close" id="wf-ai-panel-close" title="${t('common.close')}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="wf-ai-panel-chat" id="wf-ai-panel-chat"></div>
      </div>
    </div>
  `;

  // ── Init LiteGraph canvas ──
  const canvasWrap = panel.querySelector('#wf-ed-canvas-wrap');
  const canvasEl = panel.querySelector('#wf-litegraph-canvas');
  canvasEl.width = canvasWrap.offsetWidth;
  canvasEl.height = canvasWrap.offsetHeight;

  graphService.init(canvasEl);

  // ── Left panel tab switching ──
  panel.querySelectorAll('.wf-lp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.lpTab;
      panel.querySelectorAll('.wf-lp-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      panel.querySelectorAll('.wf-lp-content').forEach(c => {
        c.style.display = c.dataset.lpContent === target ? '' : 'none';
      });
    });
  });

  // Load or create empty
  if (wf) {
    graphService.loadFromWorkflow(wf);
  } else {
    graphService.createEmpty();
  }

  // ── Status bar updates ──
  const updateStatusBar = () => {
    const count = graphService.getNodeCount();
    const selCount = graphService.getSelectedCount();
    const countEl = panel.querySelector('#wf-ed-nodecount');
    const selEl = panel.querySelector('#wf-ed-selection');
    const zoomEl = panel.querySelector('#wf-ed-zoom-pct');
    const zoomLabel = panel.querySelector('#wf-ed-zoom-label');
    const sbName = panel.querySelector('#wf-ed-sb-name');
    const sbDirty = panel.querySelector('#wf-ed-sb-dirty');
    const toolbarDirty = panel.querySelector('#wf-ed-dirty');
    const undoBtn = panel.querySelector('#wf-ed-undo');
    const redoBtn = panel.querySelector('#wf-ed-redo');
    if (countEl) countEl.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg> ${count} ${t('workflow.nodeLabel')}${count !== 1 ? 's' : ''}`;
    if (selEl) {
      if (selCount > 0) {
        selEl.textContent = t('workflow.selectedCount', { n: selCount });
        selEl.style.display = '';
      } else {
        selEl.style.display = 'none';
      }
    }
    const pct = Math.round(graphService.getZoom() * 100);
    if (zoomEl) zoomEl.textContent = `${pct}%`;
    if (zoomLabel) zoomLabel.textContent = `${pct}%`;
    if (sbName) sbName.textContent = editorDraft.name || t('workflow.untitled');
    if (sbDirty) sbDirty.style.display = editorDraft.dirty ? '' : 'none';
    if (toolbarDirty) toolbarDirty.style.display = editorDraft.dirty ? '' : 'none';
    if (undoBtn) undoBtn.disabled = !graphService.canUndo();
    if (redoBtn) redoBtn.disabled = !graphService.canRedo();
  };
  updateStatusBar();

  // Wire history changes → status bar update
  graphService.onHistoryChanged = updateStatusBar;

  // ── Resize observer ──
  const resizeObs = new ResizeObserver(() => {
    if (canvasWrap && canvasEl) {
      graphService.resize(canvasWrap.offsetWidth, canvasWrap.offsetHeight);
      updateStatusBar();
    }
  });
  resizeObs.observe(canvasWrap);

  // ── Generic field renderer (registry-driven) ──────────────────────────────
  /**
   * Génère le HTML des champs depuis la définition de node registry.
   * @param {Array} fields - Tableau de définitions de champs
   * @param {Object} props - Propriétés actuelles du node
   * @param {Object} node - Le node LiteGraph courant
   * @returns {string} HTML généré
   */
  function _renderFieldsFromDef(fields, props, node) {
    return fields.map(field => {
      // Gérer conditional fields (showIf déjà hydraté en fonction par NodeRegistry)
      if (field.showIf && typeof field.showIf === 'function') {
        if (!field.showIf(props)) return '';
      }
      if (field.showIf && typeof field.showIf === 'string') {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('props', 'return (' + field.showIf + ')(props)');
          if (!fn(props)) return '';
        } catch { /* show anyway */ }
      }

      // Inline custom field (render/bind définis directement dans le field)
      if (field.type === 'custom' && typeof field.render === 'function') {
        try {
          return field.render(field, props, node);
        } catch (e) {
          console.warn('[WorkflowPanel] custom field render error', field.key, e);
          return '';
        }
      }

      // Essayer le field renderer custom d'abord
      const customRenderer = fieldRegistry.get(field.type);
      if (customRenderer) {
        return customRenderer.render(field, props[field.key] ?? '', node);
      }

      // Renderers built-in
      const value = props[field.key] ?? (field.default ?? '');
      const key = field.key;
      // tField: translate if value looks like an i18n key (word chars + dots), else use raw
      const tField = v => (v && /^[\w]+\.[\w.]+$/.test(v)) ? t(v) : (v || '');
      const label = tField(field.label || field.key);

      switch (field.type) {
        case 'text':
          return `<div class="wf-step-edit-field">
            <label class="wf-step-edit-label">${escapeHtml(label)}</label>
            ${field.hint ? `<span class="wf-field-hint">${escapeHtml(tField(field.hint))}</span>` : ''}
            <input class="wf-step-edit-input wf-node-prop${field.mono ? ' wf-field-mono' : ''}"
              data-key="${key}" value="${escapeHtml(String(value))}"
              placeholder="${escapeHtml(field.placeholder || '')}" />
          </div>`;

        case 'textarea':
          return `<div class="wf-step-edit-field">
            <label class="wf-step-edit-label">${escapeHtml(label)}</label>
            ${field.hint ? `<span class="wf-field-hint">${escapeHtml(tField(field.hint))}</span>` : ''}
            <textarea class="wf-step-edit-input wf-node-prop${field.mono ? ' wf-field-mono' : ''}"
              data-key="${key}" rows="${field.rows || 3}"
              placeholder="${escapeHtml(field.placeholder || '')}">${escapeHtml(String(value))}</textarea>
          </div>`;

        case 'select': {
          const options = (field.options || []).map(opt => {
            const optVal = typeof opt === 'object' ? opt.value : opt;
            const optLabel = tField(typeof opt === 'object' ? opt.label : opt);
            return `<option value="${escapeHtml(String(optVal))}" ${String(value) === String(optVal) ? 'selected' : ''}>${escapeHtml(String(optLabel))}</option>`;
          }).join('');
          return `<div class="wf-step-edit-field">
            <label class="wf-step-edit-label">${escapeHtml(label)}</label>
            ${field.hint ? `<span class="wf-field-hint">${escapeHtml(tField(field.hint))}</span>` : ''}
            <select class="wf-step-edit-input wf-node-prop" data-key="${key}">${options}</select>
          </div>`;
        }

        case 'toggle':
          return `<div class="wf-step-edit-field" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" class="wf-node-prop" data-key="${key}"
              id="wf-toggle-${key}" ${value ? 'checked' : ''} style="width:auto;margin:0" />
            <label for="wf-toggle-${key}" style="margin:0;cursor:pointer;font-size:var(--font-xs)">${escapeHtml(label)}</label>
          </div>`;

        case 'hint':
          return `<div class="wf-step-edit-field">
            <span class="wf-field-hint">${escapeHtml(tField(field.text || field.label || ''))}</span>
          </div>`;

        default:
          // Type inconnu, render comme text
          return `<div class="wf-step-edit-field">
            <label class="wf-step-edit-label">${escapeHtml(label)}</label>
            <input class="wf-step-edit-input wf-node-prop" data-key="${key}" value="${escapeHtml(String(value))}" />
          </div>`;
      }
    }).join('');
  }

  // ── Properties panel rendering ──
  const renderProperties = (node) => {
    const propsEl = panel.querySelector('#wf-ed-properties');
    if (!propsEl) return;

    if (!node) {
      // Show workflow options when no node selected
      propsEl.innerHTML = `
        <div class="wf-props-section">
          <div class="wf-props-header wf-props-header--workflow">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            <div class="wf-props-header-text">
              <div class="wf-props-title">${t('workflow.config')}</div>
              <div class="wf-props-subtitle">${t('workflow.configSubtitle')}</div>
            </div>
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">${svgScope()} ${t('workflow.scopeLabel')}</label>
            <span class="wf-field-hint">${t('workflow.scopeHint')}</span>
            <select class="wf-step-edit-input wf-props-input" data-prop="scope">
              <option value="current" ${editorDraft.scope === 'current' ? 'selected' : ''}>${t('workflow.scopeCurrent')}</option>
              <option value="specific" ${editorDraft.scope === 'specific' ? 'selected' : ''}>${t('workflow.scopeSpecific')}</option>
              <option value="all" ${editorDraft.scope === 'all' ? 'selected' : ''}>${t('workflow.scopeAll')}</option>
            </select>
          </div>
          <div class="wf-step-edit-field">
            <label class="wf-step-edit-label">${svgConc()} ${t('workflow.concurrencyLabel')}</label>
            <span class="wf-field-hint">${t('workflow.concurrencyHint')}</span>
            <select class="wf-step-edit-input wf-props-input" data-prop="concurrency">
              <option value="skip" ${editorDraft.concurrency === 'skip' ? 'selected' : ''}>${t('workflow.concurrencySkip')}</option>
              <option value="queue" ${editorDraft.concurrency === 'queue' ? 'selected' : ''}>${t('workflow.concurrencyQueue')}</option>
              <option value="parallel" ${editorDraft.concurrency === 'parallel' ? 'selected' : ''}>${t('workflow.concurrencyParallel')}</option>
            </select>
          </div>
        </div>
      `;
      // Upgrade native selects to custom dropdowns
      upgradeSelectsToDropdowns(propsEl);
      // Bind workflow option inputs
      propsEl.querySelectorAll('.wf-props-input').forEach(input => {
        input.addEventListener('change', () => {
          editorDraft[input.dataset.prop] = input.value;
          editorDraft.dirty = true;
        });
      });
      return;
    }

    // Show node properties
    const nodeType = node.type.replace('workflow/', '');
    const typeInfo = findStepType(nodeType) || { label: nodeType, color: 'muted', icon: '' };
    const props = node.properties || {};
    // Inject current workflowId so trigger-config field can build the webhook URL
    props._workflowId = workflowId || '';

    let fieldsHtml = '';

    // ── Moteur générique (registry-driven) ──────────────────────────────────
    const nodeDef = nodeRegistry.get(node.type);
    if (nodeDef && nodeDef.fields && nodeDef.fields.length > 0) {
      fieldsHtml = _renderFieldsFromDef(nodeDef.fields, props, node);
    }

    const customTitle = node.properties._customTitle || '';
    const nodeStepId = `node_${node.id}`;

    // Check for last run data
    const runOutput = graphService?.getNodeOutput?.(node.id);
    const hasRunData = runOutput != null || node._runStatus;
    const activeTab = propsEl._activeTab || 'properties';

    // Build Last Run tab HTML
    let lastRunHtml = '';
    if (hasRunData && activeTab === 'lastrun') {
      const status = node._runStatus || 'unknown';
      const statusCol = { success:'#22c55e', failed:'#ef4444', running:'#f59e0b', skipped:'#6b7280' }[status] || '#888';
      const duration = node._runDuration != null ? `${node._runDuration}ms` : '-';
      const error = node._runError || '';

      let outputsHtml = '';
      if (runOutput && typeof runOutput === 'object') {
        const entries = Object.entries(runOutput);
        outputsHtml = entries.map(([k, v]) => {
          let display, typeLabel;
          if (v === null || v === undefined) { display = 'null'; typeLabel = 'null'; }
          else if (typeof v === 'string') { display = v.length > 200 ? escapeHtml(v.slice(0, 197)) + '...' : escapeHtml(v); typeLabel = 'string'; }
          else if (typeof v === 'number') { display = String(v); typeLabel = 'number'; }
          else if (typeof v === 'boolean') { display = String(v); typeLabel = 'boolean'; }
          else if (Array.isArray(v)) { display = `Array[${v.length}]`; typeLabel = 'array'; }
          else { display = JSON.stringify(v, null, 2); if (display.length > 200) display = display.slice(0, 197) + '...'; display = escapeHtml(display); typeLabel = 'object'; }
          const typeColor = { string:'#c8c8c8', number:'#60a5fa', boolean:'#4ade80', array:'#fb923c', object:'#a78bfa', null:'#6b7280' }[typeLabel] || '#888';
          return `<div class="wf-lastrun-entry">
            <div class="wf-lastrun-key"><code>${escapeHtml(k)}</code><span class="wf-lastrun-type" style="color:${typeColor}">${typeLabel}</span></div>
            <pre class="wf-lastrun-value">${display}</pre>
          </div>`;
        }).join('');
      }

      lastRunHtml = `
        <div class="wf-lastrun-content">
          <div class="wf-lastrun-status-row">
            <span class="wf-lastrun-status-dot" style="background:${statusCol}"></span>
            <span class="wf-lastrun-status-label" style="color:${statusCol}">${status}</span>
            <span class="wf-lastrun-duration">${duration}</span>
          </div>
          ${error ? `<div class="wf-lastrun-error"><span class="wf-lastrun-error-label">${t('workflow.errorLabel')}</span><pre class="wf-lastrun-error-msg">${escapeHtml(error)}</pre></div>` : ''}
          ${outputsHtml ? `<div class="wf-lastrun-section"><div class="wf-lastrun-section-title">${t('workflow.outputs')}</div>${outputsHtml}</div>` : `<div class="wf-lastrun-empty">${t('workflow.noOutputData')}</div>`}
        </div>`;
    }

    propsEl.innerHTML = `
      <div class="wf-props-section" data-node-color="${typeInfo.color}">
        <div class="wf-props-header">
          <span class="wf-chip wf-chip--${typeInfo.color}">${typeInfo.icon}</span>
          <div class="wf-props-header-text">
            <div class="wf-props-title">${typeInfo.label}</div>
            <div class="wf-props-subtitle">${t(typeInfo.desc)}</div>
          </div>
          <span class="wf-props-badge wf-props-badge--${typeInfo.color}">${nodeType.toUpperCase()}</span>
        </div>
        ${hasRunData ? `
        <div class="wf-props-tabs">
          <button class="wf-props-tab ${activeTab === 'properties' ? 'active' : ''}" data-tab="properties">${t('workflow.properties')}</button>
          <button class="wf-props-tab ${activeTab === 'lastrun' ? 'active' : ''}" data-tab="lastrun">${t('workflow.lastRun')}</button>
        </div>` : ''}
        ${activeTab === 'lastrun' ? lastRunHtml : `
        ${nodeType !== 'trigger' ? `<div class="wf-node-id-badge"><code>$${nodeStepId}</code> <span>${t('workflow.editor.nodeIdHint')}</span></div>` : ''}
        ${nodeType !== 'trigger' ? `
        <div class="wf-step-edit-field">
          <label class="wf-step-edit-label">${svgEdit()} ${t('workflow.customName')}</label>
          <input class="wf-step-edit-input wf-node-prop" data-key="_customTitle" value="${escapeHtml(customTitle)}" placeholder="${typeInfo.label}" />
        </div>` : ''}
        ${fieldsHtml}
        ${nodeType !== 'trigger' ? `
        <div class="wf-props-divider"></div>
        <button class="wf-props-delete" id="wf-props-delete-node">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          ${t('workflow.deleteNode')}
        </button>` : ''}
        `}
      </div>
    `;

    // ── Bind tab switching ──
    propsEl.querySelectorAll('.wf-props-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        propsEl._activeTab = tab.dataset.tab;
        renderProperties(node);
      });
    });

    // Upgrade native selects to custom dropdowns
    upgradeSelectsToDropdowns(propsEl);

    // ── Bind custom field renderers ──────────────────────────────────────────
    if (nodeDef && nodeDef.fields) {
      const onChange = (key, newValue) => {
        node.properties[key] = newValue;
        editorDraft.dirty = true;
        graphService.canvas?.setDirty?.(true, true);
      };
      nodeDef.fields.forEach(field => {
        // Inline custom field — bind directement depuis le field
        if (field.type === 'custom' && typeof field.bind === 'function') {
          try {
            field.bind(propsEl, field, node, (newValue) => onChange(field.key, newValue));
          } catch (e) {
            console.warn('[WorkflowPanel] custom field bind error', field.key, e);
          }
          return;
        }
        const customRenderer = fieldRegistry.get(field.type);
        if (!customRenderer?.bind) return;
        const container = propsEl.querySelector(`[data-key="${field.key}"]`)?.closest('.wf-field-group');
        if (!container) return;
        customRenderer.bind(container, field, node, (newValue) => onChange(field.key, newValue));
      });
    }

    // ── Bind property inputs ──
    let _propSnapshotTimer = null;
    propsEl.querySelectorAll('.wf-node-prop').forEach(input => {
      const handler = () => {
        const key = input.dataset.key;
        // Support toggle (checkbox) fields from the generic renderer
        const val = input.type === 'checkbox' ? input.checked : input.value;
        node.properties[key] = val;
        editorDraft.dirty = true;
        // Update widget display in node
        if (node.widgets) {
          const w = node.widgets.find(w => w.name === key || w.name.toLowerCase() === key.toLowerCase());
          if (w) w.value = val;
        }
        graphService.canvas.setDirty(true, true);
        // Invalidate schema cache when DB connection changes
        if (key === 'connection') {
          schemaCache.invalidate(val);
        }
        // Re-render properties if field affects visibility (trigger type, method, action, mode, connection)
        if (['triggerType', 'method', 'action', 'mode', 'connection', 'projectId'].includes(key)) {
          renderProperties(node);
        }
        // Rebuild Variable pins when action changes (adaptive Get/Set like Unreal)
        if (key === 'action' && node.type === 'workflow/variable') {
          // Sync the widget combo
          const aw = node.widgets?.find(w => w.key === 'action');
          if (aw) aw.value = val;
          graphService._rebuildVariablePins(node);
        }
        // Rebuild Time outputs when action changes
        if (key === 'action' && node.type === 'workflow/time') {
          const aw = node.widgets?.find(w => w.key === 'action');
          if (aw) aw.value = val;
          graphService._rebuildTimeOutputs(node);
        }
        // Refresh pin type on get_variable when varType changes
        if (key === 'varType' && node._updatePinType) {
          node._updatePinType();
        }
        // Debounced snapshot so rapid typing doesn't flood the history
        clearTimeout(_propSnapshotTimer);
        _propSnapshotTimer = setTimeout(() => graphService.pushSnapshot(), 600);
      };
      input.addEventListener('input', handler);
      input.addEventListener('change', handler);
    });

    // ── Autocomplete for $variable references ──
    setupAutocomplete(propsEl, node, graphService, schemaCache);

    // ── Initialize Smart SQL for DB nodes ──
    if (nodeType === 'db') {
      initSmartSQL(propsEl, node, graphService, schemaCache, _dbConnectionsCache).catch(e => console.warn('[SmartSQL] init error:', e));
    }

    // Delete node button
    const deleteBtn = propsEl.querySelector('#wf-props-delete-node');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        graphService.graph.remove(node);
        editorDraft.dirty = true;
        renderProperties(null);
        updateStatusBar();
        graphService.canvas.setDirty(true, true);
      });
    }

    // Custom title update (sync to node title)
    const titleInput = propsEl.querySelector('[data-key="_customTitle"]');
    if (titleInput) {
      titleInput.addEventListener('input', () => {
        node.properties._customTitle = titleInput.value;
        node.title = titleInput.value || typeInfo.label;
        editorDraft.dirty = true;
        graphService.canvas.setDirty(true, true);
      });
    }

    // ── Switch case editor ──
    const _syncSwitchCases = () => {
      const rows = propsEl.querySelectorAll('.wf-switch-case-input');
      const cases = Array.from(rows).map(r => r.value.trim()).filter(Boolean);
      node.properties.cases = cases.join(',');
      // Sync widget
      if (node.widgets) {
        const w = node.widgets.find(w => w.key === 'cases');
        if (w) w.value = node.properties.cases;
      }
      editorDraft.dirty = true;
      graphService.canvas._rebuildSwitchOutputs(node);
      graphService.canvas.setDirty(true, true);
      graphService.pushSnapshot();
    };
    // Bind case inputs
    propsEl.querySelectorAll('.wf-switch-case-input').forEach(input => {
      input.addEventListener('change', _syncSwitchCases);
    });
    // Delete case buttons
    propsEl.querySelectorAll('.wf-switch-case-del').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.wf-switch-case-row')?.remove();
        _syncSwitchCases();
        renderProperties(node);
      });
    });
    // Add case button
    const addCaseBtn = propsEl.querySelector('#wf-switch-add-case');
    if (addCaseBtn) {
      addCaseBtn.addEventListener('click', () => {
        const cases = (node.properties.cases || '').split(',').map(c => c.trim()).filter(Boolean);
        cases.push(`case${cases.length + 1}`);
        node.properties.cases = cases.join(',');
        if (node.widgets) {
          const w = node.widgets.find(w => w.key === 'cases');
          if (w) w.value = node.properties.cases;
        }
        editorDraft.dirty = true;
        graphService.canvas._rebuildSwitchOutputs(node);
        graphService.canvas.setDirty(true, true);
        graphService.pushSnapshot();
        renderProperties(node);
      });
    }

    // ── Transform operation picker ──
    propsEl.querySelectorAll('.wf-transform-op-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        node.properties.operation = btn.dataset.op;
        // Sync widget
        if (node.widgets) {
          const w = node.widgets.find(w => w.key === 'operation');
          if (w) w.value = btn.dataset.op;
        }
        editorDraft.dirty = true;
        graphService.canvas.setDirty(true, true);
        renderProperties(node);
      });
    });

    // ── Variable browser — click to fill name ──
    propsEl.querySelectorAll('.wf-var-browser-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const nameInput = propsEl.querySelector('[data-key="name"]');
        if (nameInput) {
          nameInput.value = btn.dataset.varname;
          node.properties.name = btn.dataset.varname;
          editorDraft.dirty = true;
          graphService.canvas.setDirty(true, true);
        }
      });
    });
  };

  // ── Graph events ──
  graphService.onNodeSelected = (node) => {
    renderProperties(node);
    updateStatusBar();
  };

  graphService.onNodeDeselected = () => {
    renderProperties(null);
  };

  graphService.onGraphChanged = () => {
    editorDraft.dirty = true;
    updateStatusBar();
  };

  // ── Variables panel (Blueprint-style) ──────────────────────────────────────
  // Abstract variable definitions live in editorDraft.variables (not as graph nodes).
  // Clicking a variable inserts a workflow/variable node with name pre-filled.
  const VAR_TYPE_COLORS = {
    string:  '#c8c8c8',
    number:  '#60a5fa',
    boolean: '#4ade80',
    array:   '#fb923c',
    object:  '#a78bfa',
    any:     '#6b7280',
  };
  const VAR_TYPE_LIST = ['string', 'number', 'boolean', 'array', 'object', 'any'];

  const varsList = panel.querySelector('#wf-vars-list');

  /** Generate a unique variable name */
  function nextVarName() {
    const names = new Set(editorDraft.variables.map(v => v.name));
    let i = 1;
    while (names.has(`var${i}`)) i++;
    return `var${i}`;
  }

  /** Also used by the AI chat context injection */
  function collectGraphVariables() {
    return editorDraft.variables;
  }

  function updateVarsPanel() {
    if (!varsList) return;
    const vars = editorDraft.variables;
    if (!vars.length) {
      varsList.innerHTML = `
        <div class="wf-vars-empty">
          <svg class="wf-vars-empty-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
          <span class="wf-vars-empty-text">${t('workflow.editor.varsEmpty')}</span>
        </div>`;
      return;
    }
    varsList.innerHTML = vars.map((v, idx) => {
      const color = VAR_TYPE_COLORS[v.varType] || VAR_TYPE_COLORS.any;
      return `
        <div class="wf-var-item" data-var-idx="${idx}" style="--var-color:${color}" title="${t('workflow.editor.insertVariableNode')}">
          <span class="wf-var-dot" style="background:${color}"></span>
          <span class="wf-var-name">${escapeHtml(v.name)}</span>
          <span class="wf-var-type-badge" style="--var-color:${color}">${v.varType || 'any'}</span>
        </div>
      `;
    }).join('');

    // Bind clicks → insert a workflow/variable node with this name
    varsList.querySelectorAll('.wf-var-item').forEach(item => {
      item.addEventListener('click', () => {
        const idx = parseInt(item.dataset.varIdx, 10);
        const v = editorDraft.variables[idx];
        if (!v) return;
        const canvas = graphService.canvas;
        if (!canvas) return;
        const cx = (-canvas.ds.offset[0] + canvasWrap.offsetWidth / 2) / canvas.ds.scale;
        const cy = (-canvas.ds.offset[1] + canvasWrap.offsetHeight / 2) / canvas.ds.scale;
        const node = graphService.addNode('workflow/variable', [cx - 100, cy - 30]);
        if (node) {
          node.properties.name = v.name;
          node.properties.varType = v.varType || 'any';
          node.properties.action = 'get';
          // Update widget value to match
          const actionW = node.widgets?.find(w => w.key === 'action');
          if (actionW) actionW.value = 'get';
          const nameW = node.widgets?.find(w => w.key === 'name');
          if (nameW) nameW.value = v.name;
          graphService._rebuildVariablePins(node);
          graphService._markDirty();
        }
      });

      // Right-click → edit inline
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const idx = parseInt(item.dataset.varIdx, 10);
        openVarEditor(idx);
      });
    });
  }
  updateVarsPanel();

  /** Open floating popover editor for a variable definition */
  function openVarEditor(idx) {
    const v = editorDraft.variables[idx];
    if (!v) return;

    // Remove any existing popover
    const old = panel.querySelector('.wf-var-popover-backdrop');
    if (old) old.remove();

    const isNew = !v._persisted;
    v._persisted = true;

    const backdrop = document.createElement('div');
    backdrop.className = 'wf-var-popover-backdrop';
    backdrop.innerHTML = `
      <div class="wf-var-popover">
        <div class="wf-var-popover-header">
          <span class="wf-var-popover-title">${isNew ? t('workflow.varEditor.newTitle') : t('workflow.varEditor.editTitle')}</span>
          <button class="wf-var-popover-close" title="${t('common.close')}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="wf-var-popover-body">
          <div class="wf-var-popover-field">
            <label class="wf-var-popover-label">${t('workflow.varEditor.name')}</label>
            <input class="wf-var-popover-input" id="wf-vp-name" value="${escapeHtml(v.name)}" placeholder="myVariable" spellcheck="false" autocomplete="off" />
          </div>
          <div class="wf-var-popover-field">
            <label class="wf-var-popover-label">${t('workflow.varEditor.type')}</label>
            <div class="wf-var-popover-types">
              ${VAR_TYPE_LIST.map(t => {
                const c = VAR_TYPE_COLORS[t];
                return `<button class="wf-var-popover-type-btn ${(v.varType || 'any') === t ? 'active' : ''}" data-type="${t}" style="--type-color:${c}">
                  <span class="wf-var-popover-type-dot" style="background:${c}"></span>
                  ${t}
                </button>`;
              }).join('')}
            </div>
          </div>
        </div>
        <div class="wf-var-popover-footer">
          <button class="wf-var-popover-delete" id="wf-vp-delete">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            ${t('workflow.contextMenu.delete')}
          </button>
          <button class="wf-var-popover-save" id="wf-vp-save">${t('workflow.save')}</button>
        </div>
      </div>
    `;

    // Insert into the editor (not body — stays within workflow scope)
    panel.querySelector('.wf-editor').appendChild(backdrop);

    const pop = backdrop.querySelector('.wf-var-popover');
    const nameInput = backdrop.querySelector('#wf-vp-name');

    // Focus
    requestAnimationFrame(() => {
      nameInput.focus();
      nameInput.select();
    });

    // Type buttons
    backdrop.querySelectorAll('.wf-var-popover-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        backdrop.querySelectorAll('.wf-var-popover-type-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        v.varType = btn.dataset.type;
      });
    });

    // Close
    const close = () => {
      backdrop.classList.add('closing');
      setTimeout(() => backdrop.remove(), 120);
    };

    // Save
    const save = () => {
      const newName = (nameInput.value || '').trim();
      if (newName) {
        v.name = newName;
        editorDraft.dirty = true;
      }
      updateVarsPanel();
      close();
    };

    backdrop.querySelector('.wf-var-popover-close').addEventListener('click', () => {
      // If new and name is still default, revert
      if (isNew && !nameInput.value.trim()) {
        editorDraft.variables.splice(idx, 1);
      }
      save();
    });
    backdrop.querySelector('#wf-vp-save').addEventListener('click', save);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') close();
      e.stopPropagation();
    });
    nameInput.addEventListener('keyup', (e) => e.stopPropagation());

    // Delete
    backdrop.querySelector('#wf-vp-delete').addEventListener('click', () => {
      editorDraft.variables.splice(idx, 1);
      editorDraft.dirty = true;
      updateVarsPanel();
      close();
    });

    // Click backdrop to close
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) save();
    });
  }

  // Bouton + → add a new abstract variable definition
  const varsAddBtn = panel.querySelector('#wf-vars-add');
  if (varsAddBtn) {
    varsAddBtn.addEventListener('click', () => {
      const name = nextVarName();
      editorDraft.variables.push({ name, varType: 'string' });
      editorDraft.dirty = true;
      updateVarsPanel();
      openVarEditor(editorDraft.variables.length - 1);
    });
  }

  // ── Auto-loop suggestion ──
  graphService.onArrayToSingleConnection = (link, sourceNode, targetNode) => {
    // Remove any existing suggestion popup
    const old = panel.querySelector('.wf-loop-suggest');
    if (old) old.remove();

    // Position popup at the midpoint of the link (converted from graph coords to screen)
    const originPos = graphService.getOutputPinPos(sourceNode.id, link.origin_slot);
    const targetPos = graphService.getInputPinPos(targetNode.id, link.target_slot);
    const mx = (originPos[0] + targetPos[0]) / 2;
    const my = (originPos[1] + targetPos[1]) / 2;
    const screenPos = graphService.graphToScreen(mx, my);
    const canvasRect = graphService.canvasElement.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    const popup = document.createElement('div');
    popup.className = 'wf-loop-suggest';
    popup.style.left = (canvasRect.left - panelRect.left + screenPos[0]) + 'px';
    popup.style.top = (canvasRect.top - panelRect.top + screenPos[1] + 10) + 'px';
    popup.innerHTML = `
      <div class="wf-loop-suggest-text">${t('workflow.loopSuggest.text')}</div>
      <div class="wf-loop-suggest-actions">
        <button class="wf-loop-suggest-btn wf-loop-suggest-btn--yes">${t('workflow.loopSuggest.insert')}</button>
        <button class="wf-loop-suggest-btn wf-loop-suggest-btn--no">${t('common.ignore')}</button>
      </div>
    `;
    panel.appendChild(popup);

    // Auto-dismiss after 6s
    const autoDismiss = setTimeout(() => popup.remove(), 6000);

    popup.querySelector('.wf-loop-suggest-btn--no').addEventListener('click', () => {
      clearTimeout(autoDismiss);
      popup.remove();
    });

    popup.querySelector('.wf-loop-suggest-btn--yes').addEventListener('click', () => {
      clearTimeout(autoDismiss);
      popup.remove();
      insertLoopBetween(graphService, link);
      editorDraft.dirty = true;
      updateStatusBar();
    });
  };

  // ── Toolbar events ──
  // Back
  panel.querySelector('#wf-ed-back').addEventListener('click', () => {
    resizeObs.disconnect();
    resetGraphService();
    renderPanel();
    renderContent();
  });

  // Name input
  panel.querySelector('#wf-ed-name').addEventListener('input', (e) => {
    editorDraft.name = e.target.value;
    editorDraft.dirty = true;
  });

  // Zoom
  panel.querySelector('#wf-ed-zoom-in').addEventListener('click', () => {
    graphService.setZoom(graphService.getZoom() * 1.2);
    updateStatusBar();
  });
  panel.querySelector('#wf-ed-zoom-out').addEventListener('click', () => {
    graphService.setZoom(graphService.getZoom() / 1.2);
    updateStatusBar();
  });
  panel.querySelector('#wf-ed-zoom-reset')?.addEventListener('click', () => {
    graphService.setZoom(1);
    updateStatusBar();
  });
  panel.querySelector('#wf-ed-zoom-fit').addEventListener('click', () => {
    graphService.zoomToFit();
    updateStatusBar();
  });

  // Comment zone
  panel.querySelector('#wf-ed-comment')?.addEventListener('click', () => {
    const s = graphService._scale || 1;
    const ox = graphService._offsetX || 0;
    const oy = graphService._offsetY || 0;
    const cx = (-ox / s) + 200;
    const cy = (-oy / s) + 100;
    graphService.addComment([cx, cy], [300, 200], t('workflow.commentDefault'));
    updateStatusBar();
  });

  // Minimap toggle
  panel.querySelector('#wf-ed-minimap')?.addEventListener('click', () => {
    graphService.toggleMinimap();
  });

  // Undo / Redo
  panel.querySelector('#wf-ed-undo').addEventListener('click', () => {
    graphService.undo();
    updateStatusBar();
  });
  panel.querySelector('#wf-ed-redo').addEventListener('click', () => {
    graphService.redo();
    updateStatusBar();
  });

  // ── Shared save logic ──
  const saveWorkflow = async () => {
    const data = graphService.serializeToWorkflow();
    if (!data) return false;
    const workflow = {
      ...(workflowId ? { id: workflowId } : {}),
      name: editorDraft.name,
      enabled: wf?.enabled ?? true,
      trigger: data.trigger,
      ...(data.trigger.type === 'hook' ? { hookType: data.hookType } : {}),
      scope: editorDraft.scope,
      concurrency: editorDraft.concurrency,
      graph: data.graph,
      steps: data.steps,
      variables: editorDraft.variables.filter(v => v.name),
    };
    const res = await api.save(workflow);
    if (res?.success) {
      editorDraft.dirty = false;
      updateStatusBar();
      await refreshData();
      if (!workflowId && res.id) {
        workflowId = res.id;
        _activeEditorWorkflowId = res.id;
      }
      return true;
    }
    return false;
  };

  // Save
  panel.querySelector('#wf-ed-save').addEventListener('click', saveWorkflow);

  // Run — always save before triggering to persist graph changes
  // Once the run starts, button becomes a Stop button until the run ends.
  let _edRunId = null; // track running run launched from editor

  function _setEdRunBtn(running, runId) {
    const btn = panel.querySelector('#wf-ed-run');
    if (!btn) return;
    if (running) {
      _edRunId = runId || null;
      btn.classList.add('wf-editor-btn--stop');
      btn.classList.remove('wf-editor-btn--run');
      btn.disabled = false;
      btn.title = t('workflow.stopTitle');
      btn.innerHTML = `<span class="wf-btn-icon"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></span>${t('workflow.stop')}`;
    } else {
      _edRunId = null;
      btn.classList.remove('wf-editor-btn--stop');
      btn.classList.add('wf-editor-btn--run');
      btn.disabled = false;
      btn.title = t('workflow.runTitle');
      btn.innerHTML = `<span class="wf-btn-icon"><svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg></span>${t('workflow.run')}`;
    }
  }

  // Check if a run for this workflow is already in progress when editor opens
  if (workflowId) {
    const existingRun = state.runs.find(r => r.workflowId === workflowId && r.status === 'running');
    if (existingRun) _setEdRunBtn(true, existingRun.id);
  }

  panel.querySelector('#wf-ed-run').addEventListener('click', async () => {
    const btn = panel.querySelector('#wf-ed-run');
    // If already running, act as Stop
    if (_edRunId) {
      api?.cancel(_edRunId);
      return;
    }
    btn.disabled = true;
    btn.textContent = t('workflow.saving');
    try {
      const ok = await saveWorkflow();
      if (!ok) {
        console.warn('[Workflow] Save failed, cannot run');
        btn.disabled = false;
        btn.innerHTML = '<span class="wf-btn-icon"><svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg></span>Run';
        return;
      }
      if (workflowId) {
        btn.textContent = t('workflow.starting');
        await triggerWorkflow(workflowId);
        // Button will be updated by onRunStart listener below
      }
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = '<span class="wf-btn-icon"><svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 9,5 2,9"/></svg></span>Run';
    }
  });

  // Listen to run lifecycle to update editor run/stop button
  if (api && workflowId) {
    api.onRunStart(({ run }) => {
      if (run?.workflowId === workflowId) _setEdRunBtn(true, run.id);
    });
    api.onRunEnd(({ runId, status }) => {
      if (runId === _edRunId) _setEdRunBtn(false);
    });
  }

  // ── AI Workflow Builder ──
  const aiPanel = panel.querySelector('#wf-ai-panel');
  const aiPanelChat = panel.querySelector('#wf-ai-panel-chat');
  let aiChatInitialized = false;

  const WORKFLOW_SYSTEM_PROMPT = `You are an expert workflow architect built into the Workflow Builder of Claude Terminal. You build production-quality, robust automation workflows — not just functional ones.

Claude Terminal is an Electron desktop app for managing development projects. It includes a visual workflow editor (LiteGraph.js) for automating tasks: git, shell commands, AI tasks, HTTP requests, file operations, databases, notifications, and more.

YOUR ONLY ROLE: help the user build and modify the workflow currently open in the visual editor, using the MCP tools available. You do nothing else — no code help, no project advice, nothing outside of workflow building.

QUALITY STANDARD — every workflow you build must be:
- Robust: every fallible node (shell/http/git/db/claude/file/transform) must have its Error slot connected
- Observable: use Log nodes at key steps (start, end, errors, loop iterations)
- Clean: descriptive node titles, variables for repeated values, auto_layout after building
- Efficient: prefer data pins over $var syntax; prefer transform over shell for data manipulation; use haiku model for simple AI tasks

AVAILABLE MCP TOOLS:
- workflow_get_graph(workflow) — read current nodes and links (ALWAYS call first)
- workflow_get_variables(workflow) — list all variables defined in the workflow
- workflow_add_node(workflow, type, properties, title) — add a node (omit pos, call auto_layout after)
- workflow_connect_nodes(workflow, from_node, from_slot, to_node, to_slot) — connect two nodes
- workflow_update_node(workflow, node_id, properties, title) — update node properties or title
- workflow_delete_node(workflow, node_id) — delete a node and its connections
- workflow_add_variable(workflow, name, varType) — declare a workflow-level variable (string|number|boolean|array|object|any)
- workflow_auto_layout(workflow) — auto-arrange all nodes cleanly (call after adding nodes)

The "workflow" parameter is the name shown in the editor toolbar.

PIN SYSTEM (Blueprint-style typed data pins):
Each node has exec pins (flow control) AND data pins (typed values).
Exec pins connect flow: input slot0=In, output slot0=Done/True, slot1=Error/False.
Data pins carry typed values and are connected separately from exec pins.
Prefer data pin connections over $var string references — they are more reliable and visual.
You do NOT need $node_X.stdout syntax when using data pin connections.

NODE TYPES:

workflow/trigger — Entry point (always first, always required)
  triggerType: manual | cron | hook | on_workflow | webhook
  triggerValue: cron expression e.g. "0 9 * * 1-5" (weekdays at 9am)
  hookType: PreToolUse | PostToolUse | UserPromptSubmit | Notification | Stop
  webhook: triggered by external HTTP POST via cloud relay (GitHub, Stripe, Slack, etc.)
    The request body is available as $trigger.payload (e.g. $trigger.payload.event)
  Exec outputs: slot0=Start

workflow/claude — AI task (prefer haiku for simple summaries, sonnet for reasoning, opus for complex)
  mode: prompt | agent | skill
  prompt (supports $vars), model: "haiku" | "sonnet" | "opus"
  effort: low | medium | high | max (controls extended thinking)
  maxTurns (default 30), cwd (working directory)
  skillId (skill name when mode=skill)
  outputSchema (array of {name, type} for structured JSON output — use this for extracting structured data)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: output (string, slot2)

workflow/shell — Terminal command
  command (supports $vars), projectId or cwd for working directory
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: stdout (slot2), stderr (slot3), exitCode (slot4)
  TIP: set a descriptive title so the graph is readable

workflow/git — Git operation
  action: pull | push | commit | checkout | merge | stash | stash-pop | reset
  branch, message (for commit)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: output (string, slot2)

workflow/http — HTTP request
  method: GET | POST | PUT | PATCH | DELETE
  url, headers (JSON string e.g. '{"Authorization":"Bearer $token"}'), body (JSON string)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: body (object, slot2), status (number, slot3), ok (boolean, slot4)
  TIP: after http, use a Condition on ok==true to branch on success vs failure

workflow/db — SQL query
  connection (connection name from Claude Terminal), query (SQL with $vars)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: rows (array, slot2), rowCount (number, slot3), firstRow (object, slot4)

workflow/file — File operation
  action: read | write | append | copy | delete | exists | move | list
  path, content (for write/append), destination (for copy/move)
  pattern (glob for list e.g. "**/*.ts"), recursive (bool), type (files|dirs|all)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: content (slot2), exists (slot3), files (array, slot4), count (slot5)
  list: connect files array (slot4) to Loop node Items (slot1) to process each file

workflow/notify — Desktop notification
  title, message
  Exec output: slot0=Done

workflow/wait — Pause execution
  duration: "5s" | "2m" | "1h"
  Exec output: slot0=Done

workflow/log — Log a message (use liberally for observability)
  level: debug | info | warn | error
  message (supports $vars — e.g. "Processing $loop.index: $loop.item.name")
  Exec output: slot0=Done

workflow/condition — Conditional branch
  variable (dot-path), operator: == | != | > | < | >= | <= | contains | starts_with | ends_with | matches | is_empty | is_not_empty
  value
  Exec outputs: slot0=TRUE path, slot1=FALSE path

workflow/loop — Iterate over an array
  source: auto | projects | files | custom
  items ($var pointing to an array)
  Exec outputs: slot0=Each (first node INSIDE the loop body), slot1=Done (first node AFTER the loop)
  Data outputs: item (slot2), index (slot3)
  CRITICAL: nodes inside the loop body connect to Loop slot0 (Each), NOT to each other's exec output flowing back to trigger. The loop body nodes form an internal chain connected via their own exec slots. The LAST node in the loop body does NOT connect back to the Loop node.

workflow/variable — Store/modify a variable
  action: set | get | increment | append
  name, value (supports $vars)
  Exec output: slot0=Done
  Data output: value (slot1)

workflow/get_variable — Read a variable (pure data node — NO exec pins at all)
  name: variable name, varType: string | number | boolean | array | object | any
  Data output: value (slot0)
  CRITICAL: this node has ZERO exec pins. Never try to connect exec slots to/from it. Connect its slot0 data output directly to any data input of another node.

workflow/transform — Data transformation (prefer over shell for data processing)
  operation: map | filter | find | reduce | pluck | count | sort | unique | flatten | json_parse | json_stringify
  input ($var or data pin), expression (JS expression: item=element, index=position, acc=accumulator for reduce)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: result (slot2)
  Examples: filter → "item.status === 'active'", pluck → "name", map → "item.name.toUpperCase()"

workflow/subworkflow — Trigger another workflow
  workflow (name or ID), inputVars (JSON object of variables to pass)
  waitForCompletion: true | false (default true)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: outputs (object, slot2)

workflow/switch — Multi-branch routing
  variable ($var to evaluate), cases (comma-separated e.g. "success,warning,error")
  Exec outputs: slot0=first case, slot1=second, ..., last slot=default
  No data outputs

workflow/project — Project context or list
  action: list | set_context | open | build | install | test
  projectId (not needed for list)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs: projects (array, slot2) — for action=list only
  TIP: project list → Loop is the canonical pattern to iterate all projects

workflow/time — Read time tracking data
  action: get_today | get_week | get_project | get_all_projects | get_sessions
  projectId (for get_project — can also be connected via data input pin slot1)
  startDate, endDate (ISO strings, for get_sessions)
  Exec outputs: slot0=Done, slot1=Error
  Data outputs:
    get_today: today=slot2 (ms), week=slot3, month=slot4, projects=slot5 (array)
    get_week: total=slot2 (ms), days=slot3 (array [{date, dayOfWeek, ms, formatted}])
    get_project: today=slot2, week=slot3, month=slot4, total=slot5, sessionCount=slot6
    get_all_projects: projects=slot2 (sorted by today desc), count=slot3
    get_sessions: sessions=slot2, count=slot3, totalMs=slot4
  TIP: get_all_projects → Loop → get_project per-project is the standard reporting pattern
  TIP: divide ms by 3600000 for hours

DATA PIN SLOT REFERENCE (for workflow_connect_nodes):
Data pin slots start AFTER exec slots (exec input=slot0, exec outputs=slot0/slot1):
  shell: stdout=slot2, stderr=slot3, exitCode=slot4
  db: rows=slot2, rowCount=slot3, firstRow=slot4
  http: body=slot2, status=slot3, ok=slot4
  file: content=slot2, exists=slot3, files=slot4, count=slot5
  loop: item=slot2, index=slot3
  variable: value=slot1
  get_variable: value=slot0 (only slot — no exec)
  claude: output=slot2
  transform: result=slot2
  subworkflow: outputs=slot2
  project: projects=slot2
  time/get_today: today=slot2, week=slot3, month=slot4, projects=slot5
  time/get_week: total=slot2, days=slot3
  time/get_project: today=slot2, week=slot3, month=slot4, total=slot5, sessionCount=slot6
  time/get_all_projects: projects=slot2, count=slot3
  time/get_sessions: sessions=slot2, count=slot3, totalMs=slot4

$VAR SYNTAX (works in property strings when data pins aren't used):
$ctx.project, $ctx.branch — project context
$trigger.payload, $trigger.payload.field — webhook payload
$loop.item, $loop.index — loop iteration
$node_X.stdout, $node_X.body, $node_X.rows — node outputs by ID

PRODUCTION PATTERNS:

Error handling (connect Error slot of every fallible node):
  [Shell/HTTP/Git/...] slot1(Error) → [Log level=error, message="Step failed"] → [Notify title="Workflow error"]

Loop body (3-node example inside a loop):
  [Loop] slot0(Each) → [Log "Processing $loop.item.name"] slot0 → [Shell command="..."] slot0 → [Notify]
  [Loop] slot1(Done) → [Log "All items processed"]
  NEVER connect the last loop-body node back to the Loop. The runtime handles iteration automatically.

HTTP + Condition guard:
  [HTTP GET] slot0 → [Condition ok==true] slot0(TRUE) → [next step]
                                          slot1(FALSE) → [Log error] → [Notify]

Cron report:
  [Trigger cron] → [Time get_all_projects] → [Loop] → [Time get_project (connect item.id→projectId pin)]
                                                      → [Claude summarize] → [Log]
                                             [Loop Done] → [Notify "Report ready"]

COMMON MISTAKES TO AVOID:
- ❌ Connecting exec pins to get_variable (it has none — data only)
- ❌ Leaving Error slots disconnected (always handle errors)
- ❌ Using $node_X.stdout when a data pin connection is cleaner
- ❌ Using sonnet/opus for simple text formatting (haiku is sufficient and faster)
- ❌ Connecting loop body's last node back to the Loop node (infinite loop)
- ❌ Forgetting to call workflow_auto_layout after building (graph looks messy)

APPROACH:
1. ALWAYS call workflow_get_graph first to see the current state
2. For empty graphs: briefly confirm the plan with a diagram BEFORE building
3. Build in logical order: trigger → main flow → error handlers → layout
4. Add descriptive titles to nodes (title parameter in workflow_add_node)
5. Connect each node immediately after adding it
6. Add Log nodes at key steps for observability
7. Always handle Error slots — connect them to a Log+Notify chain
8. Call workflow_auto_layout at the end to clean up the visual layout
9. Reply in the user's language (French if they write in French)
10. NEVER discuss anything outside of workflow building

DIAGRAM FORMAT (MANDATORY):
Whenever you describe, summarize, plan, or show a workflow — use this exact format:

\`\`\`
[Node Name] → key detail
↓
[Node Name] → key detail
  ↳ ERROR → [Log] → [Notify]
↓
[Node Name] → key detail
\`\`\`

Rules:
- One line per node: [Node Name] → most relevant property
- Separate nodes with ↓ on its own line
- Show error branches with ↳ ERROR → indented
- Show loop body with indented lines under [Loop]
- NEVER use bullet points or prose to describe node structure
- Always show this diagram when asked "what does this do", "show the graph", or after any modification`;

  panel.querySelector('#wf-ed-ai').addEventListener('click', () => {
    const isOpen = aiPanel.style.display !== 'none';
    if (isOpen) {
      aiPanel.style.display = 'none';
      panel.querySelector('#wf-ed-ai').classList.remove('active');
      return;
    }
    aiPanel.style.display = 'flex';
    panel.querySelector('#wf-ed-ai').classList.add('active');

    if (!aiChatInitialized) {
      aiChatInitialized = true;
      const homeDir = window.electron_nodeModules?.os?.homedir() || '';
      const aiProject = { path: homeDir };
      const wfName = editorDraft.name || (workflowId ? state.workflows.find(w => w.id === workflowId)?.name : null) || null;

      // Inject existing variables from editorDraft into the system prompt
      let varsContext = '';
      if (editorDraft.variables.length > 0) {
        varsContext = '\n\nEXISTING VARIABLES IN THIS WORKFLOW:\n' +
          editorDraft.variables.map(v => `- ${v.name} (${v.varType || 'any'})`).join('\n') +
          '\nUse workflow/variable nodes with these names to get/set them.';
      }

      const promptWithContext = wfName
        ? `${WORKFLOW_SYSTEM_PROMPT}\n\nCURRENT WORKFLOW: "${wfName}" — this is the workflow open in the editor right now. Always use this name as the "workflow" parameter in your tool calls.${varsContext}`
        : WORKFLOW_SYSTEM_PROMPT;
      createChatView(aiPanelChat, aiProject, {
        systemPrompt: promptWithContext,
        skipPermissions: true,
        initialPrompt: null,
      });

      // MutationObserver: transform workflow diagram code blocks into visual cards
      const wfGraphObserver = new MutationObserver(() => {
        aiPanelChat.querySelectorAll('.chat-code-block:not([data-wf-rendered])').forEach(block => {
          const code = block.querySelector('code');
          if (!code) return;
          const text = code.textContent || '';
          // Detect workflow diagram pattern: lines with [Node] or ↓ arrows
          if (!text.includes('↓') && !/ → /.test(text)) return;
          block.setAttribute('data-wf-rendered', '1');
          _renderWfDiagramBlock(block, text);
        });
      });
      wfGraphObserver.observe(aiPanelChat, { childList: true, subtree: true });
    }
    // Focus the chat input so Enter works immediately
    setTimeout(() => {
      const chatInput = aiPanelChat.querySelector('.chat-input');
      if (chatInput) chatInput.focus();
    }, 80);
  });

  // Re-focus chat input when clicking anywhere inside the AI panel
  aiPanel.addEventListener('click', (e) => {
    if (e.target.closest('.wf-ai-panel-close')) return;
    const chatInput = aiPanelChat.querySelector('.chat-input');
    if (chatInput && document.activeElement !== chatInput && !e.target.closest('button, a, input, select, textarea')) {
      chatInput.focus();
    }
  });

  // Prevent keyboard events bubbling out of the AI panel to the LiteGraph canvas handlers
  aiPanel.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });
  aiPanel.addEventListener('keyup', (e) => {
    e.stopPropagation();
  });

  panel.querySelector('#wf-ai-panel-close').addEventListener('click', () => {
    aiPanel.style.display = 'none';
    panel.querySelector('#wf-ed-ai').classList.remove('active');
  });

  // ── Palette clicks ──
  panel.querySelectorAll('.wf-palette-item').forEach(item => {
    item.addEventListener('click', () => {
      const typeName = item.dataset.nodeType;
      // Add node at center of current viewport
      const canvas = graphService.canvas;
      const cx = (-canvas.ds.offset[0] + canvasWrap.offsetWidth / 2) / canvas.ds.scale;
      const cy = (-canvas.ds.offset[1] + canvasWrap.offsetHeight / 2) / canvas.ds.scale;
      graphService.addNode(typeName, [cx - 90, cy - 30]);
    });
  });

  // ── Keyboard shortcuts in editor ──
  const editorKeyHandler = (e) => {
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    // Delete / Backspace — delete selected nodes
    if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput) {
      graphService.deleteSelected();
      return;
    }
    // Ctrl+Z — Undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      graphService.undo();
      updateStatusBar();
      return;
    }
    // Ctrl+Y or Ctrl+Shift+Z — Redo
    if (((e.ctrlKey || e.metaKey) && e.key === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')) {
      e.preventDefault();
      graphService.redo();
      updateStatusBar();
      return;
    }
    // Ctrl+A — Select all
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !inInput) {
      e.preventDefault();
      graphService.selectAll();
      updateStatusBar();
      return;
    }
    // Ctrl+D — Duplicate selected
    if ((e.ctrlKey || e.metaKey) && e.key === 'd' && !inInput) {
      e.preventDefault();
      graphService.duplicateSelected();
      updateStatusBar();
      return;
    }
    // F — Fit all nodes
    if (e.key === 'f' && !inInput && !e.ctrlKey && !e.metaKey) {
      graphService.zoomToFit();
      updateStatusBar();
      return;
    }
    // C — Add comment zone
    if (e.key === 'c' && !inInput && !e.ctrlKey && !e.metaKey) {
      const s = graphService._scale || 1;
      const ox = graphService._offsetX || 0;
      const oy = graphService._offsetY || 0;
      const cx = (-ox / s) + 200;
      const cy = (-oy / s) + 100;
      graphService.addComment([cx, cy], [300, 200], t('workflow.commentDefault'));
      updateStatusBar();
      return;
    }
    // M — Toggle minimap
    if (e.key === 'm' && !inInput && !e.ctrlKey && !e.metaKey) {
      graphService.toggleMinimap();
      return;
    }
  };
  document.addEventListener('keydown', editorKeyHandler);

  // Cleanup keyboard handler when leaving editor
  const origBack = panel.querySelector('#wf-ed-back');
  if (origBack) {
    const origHandler = origBack.onclick;
    origBack.addEventListener('click', () => {
      document.removeEventListener('keydown', editorKeyHandler);
    }, { once: true });
  }

} // end openEditor

// Legacy: removed old wizard code. The old openBuilder function has been replaced
// by the node graph editor above.
/* ─── Detail ───────────────────────────────────────────────────────────────── */

function openDetail(id) {
  const wf = state.workflows.find(w => w.id === id);
  if (!wf) return;
  const runs = state.runs.filter(r => r.workflowId === id);
  const cfg = getTriggerConfig(wf.trigger?.type);
  const runningRun = runs.find(r => r.status === 'running');

  const overlay = document.createElement('div');
  overlay.className = 'wf-overlay';
  overlay.innerHTML = `
    <div class="wf-modal wf-modal--detail">
      <div class="wf-modal-hd">
        <div class="wf-modal-hd-left">
          <span class="wf-detail-dot ${runs[0]?.status || ''}"></span>
          <span class="wf-modal-title">${escapeHtml(wf.name)}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${runningRun
            ? `<button class="wf-btn-danger wf-btn-sm" id="wf-run-now-stop" data-run-id="${runningRun.id}"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" style="margin-right:4px"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>${t('workflow.stop')}</button>`
            : `<button class="wf-btn-primary wf-btn-sm" id="wf-run-now">${svgPlay()} ${t('workflow.launchBtn')}</button>`
          }
          <button class="wf-btn-ghost wf-btn-sm" id="wf-edit">${t('workflow.editBtn')}</button>
          <button class="wf-modal-x" id="wf-det-close">${svgX(12)}</button>
        </div>
      </div>
      <div class="wf-modal-bd wf-detail-bd">
        <div class="wf-detail-meta">
          <div class="wf-detail-meta-item">
            <span class="wf-detail-meta-icon wf-chip wf-chip--${cfg.color}">${cfg.icon}</span>
            <div>
              <div class="wf-detail-meta-label">${t('workflow.triggerLabel')}</div>
              <div class="wf-detail-meta-val">${cfg.label}${wf.trigger?.value ? ` · <code>${escapeHtml(wf.trigger.value)}</code>` : ''}${wf.hookType ? ` · <code>${escapeHtml(wf.hookType)}</code>` : ''}</div>
            </div>
          </div>
          <div class="wf-detail-meta-item">
            <span class="wf-detail-meta-icon wf-chip wf-chip--muted">${svgScope()}</span>
            <div>
              <div class="wf-detail-meta-label">${t('workflow.scopeMeta')}</div>
              <div class="wf-detail-meta-val">${escapeHtml(wf.scope || 'current')}</div>
            </div>
          </div>
          <div class="wf-detail-meta-item">
            <span class="wf-detail-meta-icon wf-chip wf-chip--muted">${svgConc()}</span>
            <div>
              <div class="wf-detail-meta-label">${t('workflow.concurrencyLabel')}</div>
              <div class="wf-detail-meta-val">${escapeHtml(wf.concurrency || 'skip')}</div>
            </div>
          </div>
        </div>

        <div class="wf-detail-section">
          <div class="wf-detail-sec-title">${t('workflow.sequence')}</div>
          <div class="wf-detail-steps">
            ${(wf.steps || []).map((s, i) => {
              const info = findStepType((s.type || '').split('.')[0]);
              return `
                <div class="wf-det-step">
                  <span class="wf-det-step-n">${i + 1}</span>
                  <span class="wf-chip wf-chip--${info.color}">${info.icon}</span>
                  <span class="wf-det-step-type">${escapeHtml(s.type || '')}</span>
                  <span class="wf-det-step-id">\$${escapeHtml(s.id || '')}</span>
                  ${s.condition ? `<span class="wf-det-step-cond">if</span>` : ''}
                </div>
                ${i < wf.steps.length - 1 ? '<div class="wf-det-connector"></div>' : ''}
              `;
            }).join('')}
          </div>
        </div>

        ${runs.length ? `
          <div class="wf-detail-section">
            <div class="wf-detail-sec-title">${t('workflow.lastRuns')}</div>
            ${runs.slice(0, 3).map(run => `
              <div class="wf-run wf-run--sm">
                <div class="wf-run-bar wf-run-bar--${run.status}"></div>
                <div class="wf-run-body">
                  <div class="wf-run-top">
                    <span class="wf-status-pill wf-status-pill--${run.status}">${statusLabel(run.status)}</span>
                    <span class="wf-run-meta-inline">${svgClock()} ${fmtTime(run.startedAt)} · ${svgTimer()} ${fmtDuration(run.duration)}</span>
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('#wf-det-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#wf-edit').addEventListener('click', () => { overlay.remove(); openEditor(id); });
  overlay.querySelector('#wf-run-now')?.addEventListener('click', () => { triggerWorkflow(id); overlay.remove(); });
  overlay.querySelector('#wf-run-now-stop')?.addEventListener('click', e => { const runId = e.currentTarget.dataset.runId; if (runId) api?.cancel(runId); overlay.remove(); });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

/* ─── Actions ──────────────────────────────────────────────────────────────── */

async function saveWorkflow(draft, existingId) {
  if (!api) return;
  const workflow = {
    ...(existingId ? { id: existingId } : {}),
    name: draft.name,
    enabled: true,
    trigger: {
      type: draft.trigger,
      value: draft.triggerValue || '',
    },
    ...(draft.trigger === 'hook' ? { hookType: draft.hookType } : {}),
    scope: draft.scope,
    concurrency: draft.concurrency,
    steps: draft.steps,
  };
  const res = await api.save(workflow);
  if (res?.success) {
    await refreshData();
    renderContent();
  }
}

async function triggerWorkflow(id) {
  if (!api) return;
  // Pass the currently opened project path so the runner has a valid cwd
  const pState = projectsState.get();
  const openedProject = (pState.projects || []).find(p => p.id === pState.openedProjectId);
  const projectPath = openedProject?.path || '';
  await api.trigger(id, { projectPath });
  // Live listener will update UI when run starts
}

async function toggleWorkflow(id, enabled) {
  if (!api) return;
  const res = await api.enable(id, enabled);
  if (res?.success) {
    const wf = state.workflows.find(w => w.id === id);
    if (wf) wf.enabled = enabled;
  }
}

async function confirmDeleteWorkflow(id, name) {
  if (!api) return;
  // Simple confirmation via a small modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'wf-confirm-overlay';
  overlay.innerHTML = `
    <div class="wf-confirm-box">
      <div class="wf-confirm-title">${svgTrash(16)} ${t('workflow.deleteConfirm.title')}</div>
      <div class="wf-confirm-text">${t('workflow.deleteConfirm.message', { name: `<strong>${escapeHtml(name || t('workflow.deleteConfirm.thisWorkflow'))}</strong>` })}</div>
      <div class="wf-confirm-actions">
        <button class="wf-confirm-btn wf-confirm-btn--cancel">${t('common.cancel')}</button>
        <button class="wf-confirm-btn wf-confirm-btn--delete">${t('workflow.contextMenu.delete')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('.wf-confirm-btn--cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('.wf-confirm-btn--delete').addEventListener('click', async () => {
    overlay.remove();
    const res = await api.delete(id);
    if (res?.success) {
      state.workflows = state.workflows.filter(w => w.id !== id);
      renderContent();
    }
  });
}

async function duplicateWorkflow(id) {
  if (!api) return;
  const wf = state.workflows.find(w => w.id === id);
  if (!wf) return;
  const copy = {
    name: wf.name + t('workflow.duplicateSuffix'),
    enabled: false,
    trigger: { ...wf.trigger },
    scope: wf.scope,
    concurrency: wf.concurrency,
    steps: JSON.parse(JSON.stringify(wf.steps || [])),
  };
  const res = await api.save(copy);
  if (res?.success) {
    await refreshData();
    renderContent();
  }
}


module.exports = { init, load };
