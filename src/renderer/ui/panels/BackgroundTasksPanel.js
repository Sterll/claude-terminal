/**
 * BackgroundTasksPanel
 *
 * Everything the CLI is running in the background, across every chat session,
 * with the history of what already ran.
 *
 * The chat renders its own task cards, but they are per-session and scroll away
 * with the transcript. This panel is the place to answer "what is running right
 * now" without hunting through conversations — and the only place a task
 * started in a tab you have since closed remains visible.
 *
 * Reads `backgroundTasks.state`, which owns the reconciliation between the
 * CLI's two task feeds; the panel is a view, not a source of truth.
 */

'use strict';

const { escapeHtml } = require('../../utils');
const { t } = require('../../i18n');
const { formatDuration } = require('../../utils/format');
const {
  backgroundTasksState,
  listTasks,
  groupTasks,
  getTask,
  clearFinished,
} = require('../../state/backgroundTasks.state');

let _root = null;
let _unsubscribe = null;
// Redrawn on a timer so running durations tick without waiting for state to change.
let _tickTimer = null;
// Collapse state is view-only and deliberately outlives a re-render, so a group
// does not spring open every time a task ticks.
const _collapsed = new Set();

const TICK_MS = 1000;

/** Maps the CLI's task_type onto a short badge label. */
function typeLabel(task) {
  switch (task.type) {
    case 'subagent': return task.agentType || t('tasks.typeAgent') || 'Agent';
    case 'shell': return t('tasks.typeShell') || 'Bash';
    case 'workflow': return task.workflowName || t('tasks.typeWorkflow') || 'Workflow';
    case 'monitor': return t('tasks.typeMonitor') || 'Monitor';
    default: return task.type || t('tasks.typeTask') || 'Task';
  }
}

function statusLabel(status) {
  const key = {
    running: 'tasks.statusRunning',
    completed: 'tasks.statusCompleted',
    failed: 'tasks.statusFailed',
    stopped: 'tasks.statusStopped',
    ended: 'tasks.statusEnded',
  }[status];
  return (key && t(key)) || status;
}

/** Tokens are only known once the end bookend lands — it is the sole carrier. */
function formatTokens(usage) {
  const total = usage?.total_tokens ?? usage?.totalTokens;
  if (typeof total !== 'number') return '';
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : String(total);
}

function elapsedSeconds(task) {
  const end = task.status === 'running' ? Date.now() : (task.endedAt || Date.now());
  return Math.max(0, Math.round((end - task.startedAt) / 1000));
}

function renderTask(task) {
  const running = task.status === 'running';
  const tokens = formatTokens(task.usage);
  const meta = [
    `<span class="bgt-type">${escapeHtml(typeLabel(task))}</span>`,
    `<span class="bgt-status ${escapeHtml(task.status)}">${escapeHtml(statusLabel(task.status))}</span>`,
    `<span class="bgt-elapsed">${escapeHtml(formatDuration(elapsedSeconds(task)))}</span>`,
    tokens ? `<span class="bgt-tokens">${escapeHtml(tokens)} tokens</span>` : '',
  ].filter(Boolean).join('');

  return `
    <div class="bgt-task ${running ? 'running' : 'done'} ${escapeHtml(task.status)}" data-task-id="${escapeHtml(task.taskId)}">
      <div class="bgt-task-main">
        <div class="bgt-desc">${escapeHtml(task.description || typeLabel(task))}</div>
        <div class="bgt-meta">${meta}</div>
      </div>
      ${running ? `
        <button class="bgt-stop" data-task-id="${escapeHtml(task.taskId)}" title="${escapeHtml(t('chat.stopTask') || 'Stop task')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
        </button>` : ''}
    </div>`;
}

function groupLabel(group) {
  if (group.label) return group.label;
  // No workflow name: the run is a chat session. The id is opaque, so a short
  // prefix is all that distinguishes one session's tasks from another's.
  const short = (group.sessionId || '').split('-').pop()?.slice(0, 6) || '?';
  return `${t('tasks.sessionGroup') || 'Session'} ${short}`;
}

function renderGroup(group) {
  const collapsed = _collapsed.has(group.key);
  const tokens = group.totalTokens
    ? `<span class="bgt-group-tokens">${escapeHtml(formatTokens({ total_tokens: group.totalTokens }))} tokens</span>`
    : '';
  const count = group.running
    ? `<span class="bgt-group-running">${group.running}/${group.total}</span>`
    : `<span class="bgt-group-count">${group.total}</span>`;

  return `
    <div class="bgt-group ${group.running ? 'has-running' : ''}" data-group-key="${escapeHtml(group.key)}">
      <button class="bgt-group-head" data-group-key="${escapeHtml(group.key)}" aria-expanded="${!collapsed}">
        <span class="bgt-group-chevron ${collapsed ? 'collapsed' : ''}">&#9662;</span>
        <span class="bgt-group-kind">${escapeHtml(group.kind === 'workflow' ? (t('tasks.typeWorkflow') || 'Workflow') : (t('tasks.typeSession') || 'Session'))}</span>
        <span class="bgt-group-label">${escapeHtml(groupLabel(group))}</span>
        ${count}
        ${tokens}
      </button>
      ${collapsed ? '' : `<div class="bgt-group-body">${group.tasks.map(renderTask).join('')}</div>`}
    </div>`;
}

function render() {
  if (!_root) return;
  const tasks = listTasks();

  if (!tasks.length) {
    _root.innerHTML = `<div class="bgt-empty">${escapeHtml(t('tasks.empty') || 'No background tasks yet.')}</div>`;
    return;
  }

  const groups = groupTasks(tasks);
  const anyFinished = tasks.some(task => task.status !== 'running');

  _root.innerHTML = `
    <div class="bgt-panel">
      <div class="bgt-toolbar">
        <span class="bgt-toolbar-count">${tasks.filter(t2 => t2.status === 'running').length} ${escapeHtml(t('tasks.running') || 'Running')}</span>
        ${anyFinished ? `<button class="bgt-clear">${escapeHtml(t('tasks.clear') || 'Clear')}</button>` : ''}
      </div>
      ${groups.map(renderGroup).join('')}
    </div>`;
}

/**
 * @param {HTMLElement} root Container to render into.
 * @param {object} api The renderer API bridge, for stopping a task.
 */
function loadPanel(root, api) {
  _root = root;
  render();

  if (!_unsubscribe) {
    _unsubscribe = backgroundTasksState.subscribe(() => render());
  }
  // Durations of running tasks are derived from the clock, not from state, so
  // nothing would repaint them without this.
  if (!_tickTimer) {
    _tickTimer = setInterval(() => {
      if (_root && listTasks().some(task => task.status === 'running')) render();
    }, TICK_MS);
  }

  root.onclick = (e) => {
    if (e.target.closest('.bgt-clear')) {
      clearFinished();
      return;
    }
    const head = e.target.closest('.bgt-group-head');
    if (head) {
      const key = head.dataset.groupKey;
      if (_collapsed.has(key)) _collapsed.delete(key); else _collapsed.add(key);
      render();
      return;
    }
    const stop = e.target.closest('.bgt-stop');
    if (!stop) return;
    const task = getTask(stop.dataset.taskId);
    // A task with no session can't be addressed — the stop channel is per session.
    if (!task?.sessionId) return;
    stop.disabled = true;
    try {
      api.chat.stopTask({ sessionId: task.sessionId, taskId: task.taskId });
    } catch (_) {
      stop.disabled = false;
    }
  };
}

function cleanup() {
  if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
  if (_root) { _root.onclick = null; }
  _root = null;
}

module.exports = { loadPanel, cleanup, render };
