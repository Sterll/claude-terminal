/**
 * Central tool registry — single source of truth for Claude Agent SDK tools.
 *
 * Every tool is described by its category, icon, display-info extractor
 * (what to show in a compact card header), and friendliness flag.
 *
 * Consumers: ChatView (chat cards, perm cards, subagent mini-tools),
 * SessionReplayPanel (timeline icons, param rows), TerminalManager
 * (autocomplete), SettingsPanel (permission lists).
 */

// ── Shared SVG icons ──────────────────────────────────────────────────────
const ICONS = {
  file:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>',
  edit:     '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v12zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4-4 4z"/></svg>',
  search:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  web:      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
  agent:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>',
  question: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>',
  plan:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',
  clock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  bell:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>',
  branch:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  skill:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  generic:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>',
};

// ── Detail extractors ─────────────────────────────────────────────────────
const detailFns = {
  filePath:       (i) => i.file_path || i.path || '',
  bash:           (i) => i.command || '',
  pattern:        (i) => i.pattern || '',
  agent:          (i) => i.description || i.subagent_type || '',
  wakeup:         (i) => {
    const s = i.delaySeconds;
    const pretty = s != null ? (s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`) : '';
    return [pretty, i.reason].filter(Boolean).join(' — ');
  },
  cronCreate:     (i) => i.schedule || i.name || '',
  cronId:         (i) => i.name || i.id || '',
  worktree:       (i) => i.branch || i.path || '',
  notification:   (i) => i.title || i.message || '',
  bgTask:         (i) => i.task_id || i.shell_id || i.taskId || i.command || '',
  query:          (i) => i.query || '',
  skill:          (i) => i.skill || i.name || '',
  url:            (i) => i.url || '',
  generic:        (i) => i.file_path || i.path || i.command || i.query || '',
};

// ── Specialized card renderers ───────────────────────────────────────────
// Return a full HTML string to replace the generic tool card, or null to
// fall back to the generic card. Called on content_block_stop once the
// tool input JSON has fully arrived.

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function formatDuration(secs) {
  if (secs == null || !isFinite(secs)) return '';
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return mr ? `${h}h ${mr}m` : `${h}h`;
}

// ── Background task store (Monitor / TaskOutput / TaskStop / bg Bash) ───
// Shared across tool calls so cards for the same taskId stay in sync.
const bgTaskStore = {
  _map: new Map(),
  _subs: new Set(),
  get(taskId) {
    return this._map.get(taskId) || null;
  },
  all() {
    return Array.from(this._map.values());
  },
  update(taskId, patch) {
    if (!taskId) return null;
    const current = this._map.get(taskId) || {
      taskId,
      outputs: [],
      status: 'running',
      startedAt: Date.now(),
    };
    const next = { ...current, ...patch };
    if (patch && typeof patch.output === 'string' && patch.output.length) {
      next.outputs = [...(current.outputs || []), patch.output];
      delete next.output;
    }
    this._map.set(taskId, next);
    this._subs.forEach((fn) => { try { fn(taskId, next); } catch (_) { /* ignore */ } });
    return next;
  },
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  },
};

// Tiny copy button (delegated click handler lives in ChatView).
// Uses data-copy attribute carrying base64-encoded payload to avoid
// HTML escaping issues in multi-line outputs.
function copyBtn(text, label) {
  if (!text) return '';
  let b64 = '';
  try {
    b64 = (typeof window !== 'undefined' && window.btoa)
      ? window.btoa(unescape(encodeURIComponent(String(text))))
      : '';
  } catch (_) { b64 = ''; }
  return `<button type="button" class="chat-copy-btn" data-copy-b64="${b64}" title="${escHtml(label || 'Copy')}" aria-label="${escHtml(label || 'Copy')}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
  </button>`;
}

function formatTaskIdShort(taskId) {
  if (!taskId) return '';
  const s = String(taskId);
  return s.length > 12 ? s.slice(0, 8) + '…' : s;
}

function tailLines(text, max) {
  if (!text) return '';
  const lines = String(text).split('\n');
  return lines.slice(-max).join('\n');
}

const BG_ACTION_LABELS = {
  TaskOutput: 'Fetch output',
  TaskStop: 'Stop task',
  Monitor: 'Monitor',
};

function renderBgTaskCard(toolName, input, overrideState) {
  const taskId = (input && (input.task_id || input.shell_id)) || '';
  const state = overrideState || bgTaskStore.get(taskId) || {};
  const command = state.command || '';
  const status = state.status || 'running';
  const action = BG_ACTION_LABELS[toolName] || toolName || 'Background task';

  const accumulated = (state.outputs || []).join('\n');
  const tail = accumulated ? tailLines(accumulated, 10) : '';
  const outputHtml = tail
    ? `<pre class="chat-bgtask-output">${escHtml(tail)}</pre>`
    : '';

  const stoppedInfo = state.stoppedAt
    ? `<span class="chat-bgtask-meta">stopped</span>`
    : state.status === 'done'
      ? `<span class="chat-bgtask-meta">done</span>`
      : '';

  const cmdHtml = command
    ? `<div class="chat-bgtask-cmd" title="${escHtml(command)}"><code>${escHtml(command.slice(0, 140))}${command.length > 140 ? '…' : ''}</code>${copyBtn(command, 'Copy command')}</div>`
    : '';

  const outputHeader = accumulated
    ? `<div class="chat-bgtask-output-header">
        <span>output (tail)</span>
        ${copyBtn(accumulated, 'Copy full output')}
      </div>`
    : '';

  return `
    <div class="chat-special-card chat-bgtask-card chat-bgtask-card--${escHtml(status)}" data-bg-task-id="${escHtml(taskId)}" data-bg-tool="${escHtml(toolName)}">
      <div class="chat-special-icon">${ICONS.activity}</div>
      <div class="chat-special-body">
        <div class="chat-special-title">
          <span class="chat-bgtask-action">${escHtml(action)}</span>
          ${taskId ? `<code class="chat-bgtask-id" title="${escHtml(taskId)}">${escHtml(formatTaskIdShort(taskId))}</code>` : ''}
          <span class="chat-bgtask-status chat-bgtask-status--${escHtml(status)}">${escHtml(status)}</span>
          ${stoppedInfo}
        </div>
        ${cmdHtml}
        ${outputHeader}
        ${outputHtml}
      </div>
    </div>
  `;
}

const renderers = {
  ScheduleWakeup(input) {
    const delay = Number(input.delaySeconds) || 0;
    const wakeAt = Date.now() + delay * 1000;
    const reason = input.reason || '';
    return `
      <div class="chat-special-card chat-wakeup-card" data-wakeup-at="${wakeAt}">
        <div class="chat-special-icon">${ICONS.clock}</div>
        <div class="chat-special-body">
          <div class="chat-special-title">
            <span class="chat-wakeup-label">Wakeup scheduled</span>
            <span class="chat-wakeup-countdown" data-countdown>in ${escHtml(formatDuration(delay))}</span>
          </div>
          ${reason ? `<div class="chat-special-desc">${escHtml(reason)}</div>` : ''}
        </div>
      </div>
    `;
  },

  CronCreate(input) {
    const schedule = input.schedule || input.cron || '';
    const name = input.name || '';
    const fullPrompt = input.prompt || '';
    const promptPreview = fullPrompt.slice(0, 160);
    return `
      <div class="chat-special-card chat-cron-card">
        <div class="chat-special-icon">${ICONS.clock}</div>
        <div class="chat-special-body">
          <div class="chat-special-title">
            <span class="chat-cron-name">${escHtml(name || 'New cron')}</span>
            ${schedule ? `<code class="chat-cron-schedule">${escHtml(schedule)}</code>` : ''}
            ${fullPrompt ? copyBtn(fullPrompt, 'Copy prompt') : ''}
          </div>
          ${promptPreview ? `<div class="chat-special-desc">${escHtml(promptPreview)}${fullPrompt.length > 160 ? '…' : ''}</div>` : ''}
        </div>
      </div>
    `;
  },

  EnterWorktree(input) {
    const branch = input.branch || '';
    const path = input.path || '';
    return `
      <div class="chat-special-card chat-worktree-card chat-worktree--enter">
        <div class="chat-special-icon">${ICONS.branch}</div>
        <div class="chat-special-body">
          <div class="chat-special-title">
            <span class="chat-worktree-label">Entered worktree</span>
            ${branch ? `<span class="chat-worktree-branch">${escHtml(branch)}</span>` : ''}
          </div>
          ${path ? `<div class="chat-special-desc" title="${escHtml(path)}">${escHtml(path)}</div>` : ''}
        </div>
      </div>
    `;
  },

  ExitWorktree(input) {
    const branch = input.branch || '';
    return `
      <div class="chat-special-card chat-worktree-card chat-worktree--exit">
        <div class="chat-special-icon">${ICONS.branch}</div>
        <div class="chat-special-body">
          <div class="chat-special-title">
            <span class="chat-worktree-label">Exited worktree</span>
            ${branch ? `<span class="chat-worktree-branch">${escHtml(branch)}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  },

  PushNotification(input) {
    const title = input.title || 'Notification';
    const message = input.message || input.body || '';
    return `
      <div class="chat-special-card chat-notification-card">
        <div class="chat-special-icon">${ICONS.bell}</div>
        <div class="chat-special-body">
          <div class="chat-notification-title">${escHtml(title)}</div>
          ${message ? `<div class="chat-notification-message">${escHtml(message)}</div>` : ''}
        </div>
      </div>
    `;
  },

  Monitor(input)     { return renderBgTaskCard('Monitor', input || {}); },
  TaskOutput(input)  { return renderBgTaskCard('TaskOutput', input || {}); },
  TaskStop(input)    { return renderBgTaskCard('TaskStop', input || {}); },
};

// ── Result-enriched renderers (replace card after tool_result) ──────────
// Called with the parsed tool_result output + original input. Return HTML
// or null to keep the existing card untouched.
const resultRenderers = {
  CronList(output, input) {
    let crons = [];
    if (Array.isArray(output)) crons = output;
    else if (output && Array.isArray(output.crons)) crons = output.crons;
    else if (output && Array.isArray(output.items)) crons = output.items;
    if (!crons.length) return null;
    const rows = crons.slice(0, 20).map((c) => {
      const name = c.name || c.id || '';
      const schedule = c.schedule || c.cron || '';
      const enabled = c.enabled === false ? 'disabled' : 'enabled';
      return `
        <div class="chat-cronlist-row">
          <span class="chat-cronlist-name">${escHtml(name)}</span>
          ${schedule ? `<code class="chat-cron-schedule">${escHtml(schedule)}</code>` : ''}
          <span class="chat-cronlist-state chat-cronlist-state--${enabled}">${enabled}</span>
        </div>
      `;
    }).join('');
    const more = crons.length > 20 ? `<div class="chat-cronlist-more">+ ${crons.length - 20} more</div>` : '';
    return `
      <div class="chat-special-card chat-cron-card">
        <div class="chat-special-icon">${ICONS.clock}</div>
        <div class="chat-special-body">
          <div class="chat-special-title">
            <span>Cron list</span>
            <span class="chat-bgtask-meta">${crons.length} cron${crons.length === 1 ? '' : 's'}</span>
          </div>
          <div class="chat-cronlist-rows">${rows}${more}</div>
        </div>
      </div>
    `;
  },
};

// ── Tool definitions ─────────────────────────────────────────────────────
// { category, icon, detail, friendly?, render? }
// friendly = tool has a nicely-structured session-replay card
// render  = custom HTML renderer for the chat card (replaces generic card)
const TOOL_DEFS = {
  // File
  Read:              { category: 'file',     icon: ICONS.file,     detail: detailFns.filePath, friendly: true },
  Write:             { category: 'file',     icon: ICONS.edit,     detail: detailFns.filePath, friendly: true },
  Edit:              { category: 'file',     icon: ICONS.edit,     detail: detailFns.filePath, friendly: true },
  MultiEdit:         { category: 'file',     icon: ICONS.edit,     detail: detailFns.filePath, friendly: true },
  NotebookEdit:      { category: 'file',     icon: ICONS.edit,     detail: detailFns.filePath, friendly: true },

  // Terminal
  Bash:              { category: 'terminal', icon: ICONS.terminal, detail: detailFns.bash,     friendly: true },

  // Search
  Glob:              { category: 'search',   icon: ICONS.search,   detail: detailFns.pattern,  friendly: true },
  Grep:              { category: 'search',   icon: ICONS.search,   detail: detailFns.pattern,  friendly: true },

  // Web
  WebFetch:          { category: 'web',      icon: ICONS.web,      detail: detailFns.url,      friendly: true },
  WebSearch:         { category: 'web',      icon: ICONS.web,      detail: detailFns.query,    friendly: true },

  // Agent / subagent
  Task:              { category: 'agent',    icon: ICONS.agent,    detail: detailFns.agent,    friendly: true },
  Agent:             { category: 'agent',    icon: ICONS.agent,    detail: detailFns.agent,    friendly: true },

  // Plan / interaction
  AskUserQuestion:   { category: 'plan',     icon: ICONS.question, detail: (i) => i.question || '', friendly: true },
  EnterPlanMode:     { category: 'plan',     icon: ICONS.plan,     detail: () => '' },
  ExitPlanMode:      { category: 'plan',     icon: ICONS.plan,     detail: () => '' },
  TodoWrite:         { category: 'plan',     icon: ICONS.plan,     detail: () => '', friendly: true },

  // Schedule
  ScheduleWakeup:    { category: 'schedule', icon: ICONS.clock,    detail: detailFns.wakeup,     render: renderers.ScheduleWakeup },
  CronCreate:        { category: 'schedule', icon: ICONS.clock,    detail: detailFns.cronCreate, render: renderers.CronCreate },
  CronDelete:        { category: 'schedule', icon: ICONS.clock,    detail: detailFns.cronId },
  CronList:          { category: 'schedule', icon: ICONS.clock,    detail: () => '', renderResult: resultRenderers.CronList },

  // Worktree
  EnterWorktree:     { category: 'worktree', icon: ICONS.branch,   detail: detailFns.worktree,   render: renderers.EnterWorktree },
  ExitWorktree:      { category: 'worktree', icon: ICONS.branch,   detail: detailFns.worktree,   render: renderers.ExitWorktree },

  // Background tasks
  Monitor:           { category: 'bgtask',   icon: ICONS.activity, detail: detailFns.bgTask, render: renderers.Monitor },
  TaskOutput:        { category: 'bgtask',   icon: ICONS.activity, detail: detailFns.bgTask, render: renderers.TaskOutput },
  TaskStop:          { category: 'bgtask',   icon: ICONS.activity, detail: detailFns.bgTask, render: renderers.TaskStop },

  // Notifications
  PushNotification:  { category: 'notify',   icon: ICONS.bell,     detail: detailFns.notification, render: renderers.PushNotification },

  // Skills / discovery
  Skill:             { category: 'skill',    icon: ICONS.skill,    detail: detailFns.skill },
  ToolSearch:        { category: 'skill',    icon: ICONS.skill,    detail: detailFns.query },

  // MCP discovery
  ListMcpResourcesTool: { category: 'other', icon: ICONS.generic,  detail: () => '' },
  ReadMcpResourceTool:  { category: 'other', icon: ICONS.generic,  detail: detailFns.url },
};

// ── Category → RGB (for border-left / chips) ─────────────────────────────
const CATEGORY_COLORS = {
  file:     '34,197,94',
  terminal: '245,158,11',
  search:   '167,139,250',
  web:      '6,182,212',
  agent:    '249,115,22',
  plan:     '217,119,6',
  schedule: '236,72,153',
  worktree: '139,92,246',
  bgtask:   '14,165,233',
  notify:   '250,204,21',
  skill:    '251,191,36',
  other:    '100,100,110',
};

// ── Public API ───────────────────────────────────────────────────────────

function getToolDef(toolName) {
  return TOOL_DEFS[toolName] || null;
}

function getToolCategory(toolName) {
  const def = TOOL_DEFS[toolName];
  if (def) return def.category;
  if (typeof toolName === 'string' && toolName.startsWith('mcp__')) return 'mcp';
  return 'other';
}

function getCategoryColor(cat) {
  return CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
}

function getToolIcon(toolName) {
  const def = TOOL_DEFS[toolName];
  if (def) return def.icon;
  return ICONS.generic;
}

function getToolDisplayInfo(toolName, input) {
  if (!input) return '';
  const def = TOOL_DEFS[toolName];
  if (def && typeof def.detail === 'function') {
    try { return def.detail(input) || ''; } catch (_) { return ''; }
  }
  // MCP or unknown tool → best-effort generic fallback
  return detailFns.generic(input) || '';
}

function isFriendlyTool(toolName) {
  const def = TOOL_DEFS[toolName];
  return !!(def && def.friendly);
}

function hasCustomRenderer(toolName) {
  const def = TOOL_DEFS[toolName];
  return !!(def && typeof def.render === 'function');
}

function renderToolCardHtml(toolName, input) {
  const def = TOOL_DEFS[toolName];
  if (!def || typeof def.render !== 'function') return null;
  try { return def.render(input || {}); } catch (_) { return null; }
}

function hasResultRenderer(toolName) {
  const def = TOOL_DEFS[toolName];
  return !!(def && typeof def.renderResult === 'function');
}

function renderToolResultHtml(toolName, output, input) {
  const def = TOOL_DEFS[toolName];
  if (!def || typeof def.renderResult !== 'function') return null;
  try { return def.renderResult(output, input || {}); } catch (_) { return null; }
}

function escapeHtmlMinimal(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * Pretty tool-name for display (handles MCP namespace: `mcp__server__tool`).
 * Returns HTML (caller should NOT re-escape).
 */
function formatToolName(toolName) {
  if (!toolName) return '';
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const server = parts[1] || 'mcp';
    const rawTool = parts.slice(2).join('_');
    const prettyTool = rawTool
      .split('_')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return `<span class="chat-tool-mcp-badge" title="MCP · ${escapeHtmlMinimal(server)}">${escapeHtmlMinimal(server)}</span><span class="chat-tool-name-text">${escapeHtmlMinimal(prettyTool || rawTool)}</span>`;
  }
  return `<span class="chat-tool-name-text">${escapeHtmlMinimal(toolName)}</span>`;
}

// Built-in tools list for settings/autocomplete (stable, ordered)
const BUILTIN_TOOLS = Object.keys(TOOL_DEFS);

module.exports = {
  TOOL_DEFS,
  CATEGORY_COLORS,
  BUILTIN_TOOLS,
  getToolDef,
  getToolCategory,
  getCategoryColor,
  getToolIcon,
  getToolDisplayInfo,
  isFriendlyTool,
  hasCustomRenderer,
  renderToolCardHtml,
  hasResultRenderer,
  renderToolResultHtml,
  renderBgTaskCard,
  bgTaskStore,
  formatToolName,
  formatDuration,
};
