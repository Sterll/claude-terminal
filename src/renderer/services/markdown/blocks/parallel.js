/**
 * Parallel task block renderers: run detail card, run list, suggestion card.
 *
 * Syntax:
 *   ```parallel-run        → single run detail card
 *   ```parallel-runs       → list of run summaries
 *   ```parallel-suggest    → interactive suggestion card (accept/decline)
 */

const { escapeHtml } = require('../../../utils');

// ── Phase display helpers ──

const PHASE_CLASSES = {
  done: 'success', merged: 'success', failed: 'danger', cancelled: 'muted',
  running: 'info', decomposing: 'info', reviewing: 'warning',
  'creating-worktrees': 'info', merging: 'info',
};

const PHASE_LABELS = {
  done: 'Done', merged: 'Merged', failed: 'Failed', cancelled: 'Cancelled',
  running: 'Running', decomposing: 'Decomposing', reviewing: 'Reviewing',
  'creating-worktrees': 'Setup', merging: 'Merging',
};

const TASK_STATUS_ICONS = {
  done: '<span class="cpr-task-icon done">+</span>',
  failed: '<span class="cpr-task-icon failed">X</span>',
  running: '<span class="cpr-task-icon running">&gt;</span>',
  pending: '<span class="cpr-task-icon pending">.</span>',
  creating: '<span class="cpr-task-icon creating">~</span>',
  cancelled: '<span class="cpr-task-icon cancelled">-</span>',
};

// ── Parallel Run Detail ──

function renderParallelRunBlock(code) {
  const lines = code.split('\n');
  let id = '', goal = '', phase = '', feature = '', mainBranch = '';
  let model = '', effort = '', started = '', duration = '', mergeBranch = '', error = '';
  const tasks = [];
  let inTasks = false;
  let currentTask = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === '---' || trimmed.toLowerCase() === 'tasks:') { inTasks = true; continue; }

    if (!inTasks) {
      const m = trimmed.match(/^(\w[\w\s-]*):\s*(.+)/i);
      if (m) {
        const key = m[1].toLowerCase().replace(/\s+/g, '');
        const val = m[2].trim();
        if (key === 'id') id = val;
        else if (key === 'goal') goal = val;
        else if (key === 'phase') phase = val;
        else if (key === 'feature') feature = val;
        else if (key === 'mainbranch' || key === 'main-branch') mainBranch = val;
        else if (key === 'model') model = val;
        else if (key === 'effort') effort = val;
        else if (key === 'started') started = val;
        else if (key === 'duration') duration = val;
        else if (key === 'mergebranch' || key === 'merge-branch') mergeBranch = val;
        else if (key === 'error') error = val;
      }
    } else {
      // Task line: [+] Title | branch | status
      const taskMatch = trimmed.match(/^\[(.)\]\s*(.+)/);
      if (taskMatch) {
        const statusChar = taskMatch[1];
        const rest = taskMatch[2];
        const parts = rest.split('|').map(s => s.trim());
        const statusMap = { '+': 'done', 'X': 'failed', '>': 'running', '.': 'pending', '~': 'creating', '-': 'cancelled' };
        currentTask = {
          title: parts[0] || '',
          branch: parts[1] || '',
          status: statusMap[statusChar] || 'pending',
        };
        tasks.push(currentTask);
      } else if (trimmed.startsWith('-') && trimmed.includes('|')) {
        // Alternate format: - Title | branch | status
        const parts = trimmed.slice(1).split('|').map(s => s.trim());
        tasks.push({
          title: parts[0] || '',
          branch: parts[1] || '',
          status: parts[2] || 'pending',
        });
      }
    }
  }

  if (!id && !goal) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  const phaseClass = PHASE_CLASSES[phase] || 'info';
  const phaseLabel = PHASE_LABELS[phase] || phase || 'unknown';
  const shortId = id.includes('-') ? '#' + id.split('-')[1] : id;

  // Header
  let html = `<div class="cpr-card">`;
  html += `<div class="cpr-header">`;
  html += `<span class="cpr-phase-badge ${phaseClass}">${escapeHtml(phaseLabel)}</span>`;
  if (shortId) html += `<span class="cpr-id">${escapeHtml(shortId)}</span>`;
  html += `<span class="cpr-goal">${escapeHtml(goal)}</span>`;
  html += `</div>`;

  // Meta row
  const metaItems = [];
  if (feature) metaItems.push(`<span class="cpr-meta-item"><span class="cpr-meta-label">Feature:</span> ${escapeHtml(feature)}</span>`);
  if (model) metaItems.push(`<span class="cpr-meta-item">${escapeHtml(model)}</span>`);
  if (effort) metaItems.push(`<span class="cpr-meta-item">${escapeHtml(effort)}</span>`);
  if (duration && duration !== 'N/A') metaItems.push(`<span class="cpr-meta-item">${escapeHtml(duration)}</span>`);
  if (started && started !== 'N/A') metaItems.push(`<span class="cpr-meta-item">${escapeHtml(started)}</span>`);
  if (metaItems.length > 0) {
    html += `<div class="cpr-meta">${metaItems.join('')}</div>`;
  }

  // Tasks
  if (tasks.length > 0) {
    const done = tasks.filter(t => t.status === 'done').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    let summary = `${done}/${tasks.length} done`;
    if (failed > 0) summary += `, ${failed} failed`;

    html += `<div class="cpr-tasks-header">${escapeHtml(summary)}</div>`;
    html += `<div class="cpr-tasks">`;
    for (const task of tasks) {
      const icon = TASK_STATUS_ICONS[task.status] || TASK_STATUS_ICONS.pending;
      html += `<div class="cpr-task ${escapeHtml(task.status)}">`;
      html += icon;
      html += `<span class="cpr-task-title">${escapeHtml(task.title)}</span>`;
      if (task.branch) {
        const shortBranch = task.branch.replace(/^parallel\/[^/]+\//, '');
        html += `<span class="cpr-task-branch">${escapeHtml(shortBranch)}</span>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Merge branch
  if (mergeBranch) {
    html += `<div class="cpr-merge"><span class="cpr-meta-label">Merge:</span> <code>${escapeHtml(mergeBranch)}</code></div>`;
  }

  // Error
  if (error) {
    html += `<div class="cpr-error">${escapeHtml(error)}</div>`;
  }

  html += `</div>`;
  return html;
}

// ── Parallel Runs List ──

function renderParallelRunsBlock(code) {
  const runs = [];
  let current = null;

  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { if (current) { runs.push(current); current = null; } continue; }

    // Run header: [PHASE] #id or phase badge
    const headerMatch = trimmed.match(/^\[(\w+)\]\s*#?(.+)/);
    if (headerMatch) {
      if (current) runs.push(current);
      current = { phase: headerMatch[1].toLowerCase(), id: headerMatch[2].trim(), goal: '', tasks: '', duration: '', branches: '', error: '' };
      continue;
    }

    if (current) {
      const kvMatch = trimmed.match(/^(\w[\w\s]*):\s*(.+)/i);
      if (kvMatch) {
        const key = kvMatch[1].toLowerCase().replace(/\s+/g, '');
        const val = kvMatch[2].trim();
        if (key === 'goal') current.goal = val;
        else if (key === 'tasks') current.tasks = val;
        else if (key === 'duration') current.duration = val;
        else if (key === 'started') current.started = val;
        else if (key === 'mergebranch' || key === 'merge-branch') current.mergeBranch = val;
        else if (key === 'branches') current.branches = val;
        else if (key === 'error') current.error = val;
      }
    }
  }
  if (current) runs.push(current);

  if (runs.length === 0) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  let html = `<div class="cpr-list">`;
  for (const run of runs) {
    const phaseClass = PHASE_CLASSES[run.phase] || 'info';
    const phaseLabel = PHASE_LABELS[run.phase] || run.phase || '?';

    html += `<div class="cpr-list-item">`;
    html += `<div class="cpr-list-header">`;
    html += `<span class="cpr-phase-badge ${phaseClass}">${escapeHtml(phaseLabel)}</span>`;
    html += `<span class="cpr-list-goal">${escapeHtml(run.goal || run.id)}</span>`;
    html += `</div>`;

    const details = [];
    if (run.tasks) details.push(run.tasks);
    if (run.duration && run.duration !== 'N/A') details.push(run.duration);
    if (details.length > 0) {
      html += `<div class="cpr-list-meta">${escapeHtml(details.join(' | '))}</div>`;
    }
    if (run.error) {
      html += `<div class="cpr-error">${escapeHtml(run.error)}</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

// ── Parallel Suggest Card ──

function renderParallelSuggestBlock(code) {
  let goal = '';
  const tasks = [];

  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const kvMatch = trimmed.match(/^(\w[\w\s-]*):\s*(.+)/i);
    if (kvMatch) {
      const key = kvMatch[1].toLowerCase().replace(/\s+/g, '');
      if (key === 'goal') goal = kvMatch[2].trim();
      continue;
    }

    // Task lines: - Task description
    if (trimmed.startsWith('-')) {
      const taskText = trimmed.slice(1).trim();
      if (taskText) tasks.push(taskText);
    }
  }

  if (!goal) return `<pre><code>${escapeHtml(code)}</code></pre>`;

  let html = `<div class="cps-card">`;
  html += `<div class="cps-header">`;
  html += `<svg class="cps-icon" viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z"/></svg>`;
  html += `<span class="cps-title">Parallel execution suggested</span>`;
  html += `</div>`;

  html += `<div class="cps-goal">${escapeHtml(goal)}</div>`;

  if (tasks.length > 0) {
    html += `<div class="cps-tasks">`;
    for (const task of tasks) {
      html += `<div class="cps-task-item">${escapeHtml(task)}</div>`;
    }
    html += `</div>`;
  }

  html += `<div class="cps-actions">`;
  html += `<button class="cps-btn cps-btn-parallel" data-parallel-action="accept" data-parallel-goal="${escapeHtml(goal)}">Use Parallel Mode</button>`;
  html += `<button class="cps-btn cps-btn-normal" data-parallel-action="decline" data-parallel-goal="${escapeHtml(goal)}">Continue Normally</button>`;
  html += `</div>`;

  html += `</div>`;
  return html;
}

module.exports = {
  renderParallelRunBlock,
  renderParallelRunsBlock,
  renderParallelSuggestBlock,
};
