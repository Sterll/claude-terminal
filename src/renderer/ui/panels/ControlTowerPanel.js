/**
 * ControlTowerPanel
 * Real-time overview of all running Claude chats across all projects and worktrees.
 * Wires into eventBus (terminal hooks) + chat IPC events + terminalsState.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');
// Shared modal primitives — role="dialog", aria-modal, labelled close button,
// Escape-to-close, Tab focus trap and body scroll locking.
const { createModal, showModal, closeModal } = require('../components/Modal');

// ── Internal state ──────────────────────────────────────────────────────────

/** @type {Map<string, AgentInfo>} */
const _agents = new Map();

let _refreshTimer = null;
// Root element of the currently rendered panel. The refresh timer watches it so it
// can stop itself if the panel is torn down through a path that never calls
// cleanup() (e.g. Ctrl+, jumping straight into Settings).
let _panelRootEl = null;
let _unsubscribers = [];
let _chatMessageUnlistener = null;
let _chatDoneUnlistener = null;
let _chatErrorUnlistener = null;
let _chatIdleUnlistener = null;
let _chatPermissionUnlistener = null;
let _isLoaded = false;

// Cumulative cost across all sessions this app run
let _sessionCosts = new Map(); // agentKey -> cost

// Pending permission requests per chat session: sessionId -> permission data
const _pendingPermissions = new Map();

// Last assistant response per session (for "show last response")
const _lastResponses = new Map();

// Expanded "last response" state per agent card
const _expandedResponses = new Set();

// Collapsed agent cards (show only header)
const _collapsedAgents = new Set();

// ── Grid view & filters ──
const VIEW_MODE_STORAGE_KEY = 'ct-view-mode';
let _viewMode = (() => {
  try { return localStorage.getItem(VIEW_MODE_STORAGE_KEY) === 'grid' ? 'grid' : 'list'; }
  catch { return 'list'; }
})();
let _filterProject = 'all';
let _filterStatus = 'all';
let _filterText = '';
let _sortMode = 'recent';

// Overlay state: the terminal wrapper currently reparented into the expand modal
let _overlayRestore = null;

/**
 * @typedef {Object} AgentInfo
 * @property {string} id
 * @property {'terminal'|'chat'} type
 * @property {string} projectName
 * @property {string} projectPath
 * @property {string|null} branch
 * @property {'THINKING'|'RUNNING_TOOL'|'WAITING'|'IDLE'|'DONE'|'ERROR'} status
 * @property {string|null} currentTool
 * @property {string|null} currentFile
 * @property {number} startTime
 * @property {number} cost
 * @property {number} totalTokens
 * @property {number|null} terminalId
 * @property {string|null} chatSessionId
 * @property {string|null} sessionName
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function _formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function _formatCost(usd) {
  if (!usd || usd < 0.0001) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

// Hook events deliver timestamps as ISO strings, terminal state as epoch ms —
// normalise to a number so duration math never yields NaN.
function _toEpochMs(ts) {
  if (typeof ts === 'number' && !isNaN(ts)) return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    if (!isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function _formatRelative(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5) return t('controlTower.justNow');
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Timestamp (ms) of the last USER interaction with an agent — keystrokes in
 * the terminal, messages sent to a chat session. Deliberately not output
 * activity: several sessions streaming at once would reshuffle the grid
 * every couple of seconds and make it impossible to focus on one.
 */
function _getLastActivityTs(agent) {
  if (agent.lastUserAt) return agent.lastUserAt;
  try {
    if (agent.terminalId != null) {
      const { terminalsState } = require('../../state/terminals.state');
      const td = terminalsState.get().terminals.get(agent.terminalId);
      if (td?.lastInputAt) return td.lastInputAt;
    }
  } catch { /* ignore */ }
  return agent.startTime || 0;
}

function _extractFile(toolInput) {
  if (!toolInput) return null;
  // Common file-related keys across Claude tools
  const keys = ['path', 'file_path', 'filepath', 'filename', 'file', 'output_file'];
  for (const k of keys) {
    if (toolInput[k] && typeof toolInput[k] === 'string') {
      // Return just the last 2 path segments for readability
      const parts = toolInput[k].replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.slice(-2).join('/');
    }
  }
  // Also check command for shell tools
  if (toolInput.command && typeof toolInput.command === 'string') {
    return toolInput.command.slice(0, 40);
  }
  return null;
}

async function _getProjectBranch(projectPath) {
  try {
    const { fileExists, fsp } = require('../../utils/fs-async');
    const path = window.electron_nodeModules.path;
    const headFile = path.join(projectPath, '.git', 'HEAD');
    if (!await fileExists(headFile)) return null;
    const content = (await fsp.readFile(headFile, 'utf8')).trim();
    if (content.startsWith('ref: refs/heads/')) {
      return content.slice('ref: refs/heads/'.length);
    }
    return content.slice(0, 7); // detached HEAD
  } catch {
    return null;
  }
}

function _resolveProject(projectId) {
  try {
    const { projectsState } = require('../../state/projects.state');
    return (projectsState.get().projects || []).find(p => p.id === projectId) || null;
  } catch { return null; }
}

function _getAllProjects() {
  try {
    const { projectsState } = require('../../state/projects.state');
    return projectsState.get().projects || [];
  } catch { return []; }
}

function _totalActiveCost() {
  let total = 0;
  _agents.forEach(a => { if (!a.hidden) total += (a.cost || 0); });
  // Also count past-session costs accumulated this run
  _sessionCosts.forEach((cost, key) => {
    if (!_agents.has(key)) total += (cost || 0);
  });
  return total;
}

function _activeAgentCount() {
  let count = 0;
  _agents.forEach(a => { if (!a.hidden && a.status !== 'DONE' && a.status !== 'ERROR') count++; });
  return count;
}

// ── Event bus wiring ─────────────────────────────────────────────────────────

function _projectHasChatTerminal(projectId) {
  try {
    const { terminalsState } = require('../../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    for (const [, td] of terminals) {
      if (td.project?.id === projectId && td.mode === 'chat') return true;
    }
  } catch { /* ignore */ }
  return false;
}

function _wireEventBus() {
  let eventBus, EVENT_TYPES;
  try {
    const events = require('../../events/ClaudeEventBus');
    eventBus = events.eventBus;
    EVENT_TYPES = events.EVENT_TYPES;
  } catch { return; }

  _unsubscribers.push(
    eventBus.on(EVENT_TYPES.SESSION_START, async (e) => {
      if (!e.projectId) return;

      // Skip if this project runs in chat mode — covered by chat IPC events
      if (_projectHasChatTerminal(e.projectId)) {
        console.log('[CT] hooks SESSION_START skipped (chat mode):', e.projectId);
        return;
      }

      const project = _resolveProject(e.projectId);
      if (!project) return;

      // Find the terminal for this project to get the terminalId
      const terminalId = _findTerminalForProject(e.projectId);
      const key = `hooks:${e.projectId}`;
      console.log('[CT] hooks SESSION_START → key:', key, '| existing:', _agents.has(key));

      if (!_agents.has(key)) {
        _agents.set(key, {
          id: key,
          type: 'terminal',
          projectName: project.name,
          projectPath: project.path,
          branch: await _getProjectBranch(project.path),
          status: 'THINKING',
          currentTool: null,
          currentFile: null,
          startTime: _toEpochMs(e.timestamp),
          lastEventAt: Date.now(),
          cost: 0,
          totalTokens: 0,
          terminalId,
          chatSessionId: null
        });
      } else {
        const a = _agents.get(key);
        a.status = 'THINKING';
        a.lastEventAt = Date.now();
        a.terminalId = terminalId || a.terminalId;
      }
      _render();
    }),

    eventBus.on(EVENT_TYPES.TOOL_START, async (e) => {
      if (!e.projectId) return;
      if (_projectHasChatTerminal(e.projectId)) return;
      const key = `hooks:${e.projectId}`;
      console.log('[CT] hooks TOOL_START → key:', key, 'tool:', e.data?.toolName);
      if (!_agents.has(key)) {
        // Auto-create if SESSION_START was missed
        const project = _resolveProject(e.projectId);
        if (!project) return;
        _agents.set(key, {
          id: key,
          type: 'terminal',
          projectName: project.name,
          projectPath: project.path,
          branch: await _getProjectBranch(project.path),
          status: 'RUNNING_TOOL',
          currentTool: e.data?.toolName || null,
          currentFile: _extractFile(e.data?.input),
          startTime: _toEpochMs(e.timestamp),
          lastEventAt: Date.now(),
          cost: 0,
          totalTokens: 0,
          terminalId: _findTerminalForProject(e.projectId),
          chatSessionId: null
        });
      } else {
        const a = _agents.get(key);
        a.status = 'RUNNING_TOOL';
        a.lastEventAt = Date.now();
        a.currentTool = e.data?.toolName || a.currentTool;
        a.currentFile = _extractFile(e.data?.input) || a.currentFile;
      }
      _render();
    }),

    eventBus.on(EVENT_TYPES.TOOL_END, (e) => {
      if (!e.projectId) return;
      const key = `hooks:${e.projectId}`;
      const a = _agents.get(key);
      if (a) {
        a.status = 'THINKING';
        a.lastEventAt = Date.now();
        _render();
      }
    }),

    eventBus.on(EVENT_TYPES.TOOL_ERROR, (e) => {
      if (!e.projectId) return;
      const key = `hooks:${e.projectId}`;
      const a = _agents.get(key);
      if (a) {
        a.status = 'ERROR';
        a.lastEventAt = Date.now();
        _render();
      }
    }),

    eventBus.on(EVENT_TYPES.CLAUDE_DONE, (e) => {
      if (!e.projectId) return;
      const key = `hooks:${e.projectId}`;
      const a = _agents.get(key);
      if (a) {
        if (a.status === 'THINKING' || a.status === 'RUNNING_TOOL') a.unseenDone = true;
        a.status = a.unseenDone ? 'DONE' : 'IDLE';
        a.lastEventAt = Date.now();
        _render();
      }
    }),

    eventBus.on(EVENT_TYPES.CLAUDE_WORKING, (e) => {
      if (!e.projectId) return;
      const key = `hooks:${e.projectId}`;
      const a = _agents.get(key);
      if (a && (a.status === 'IDLE' || (a.status === 'DONE' && a.unseenDone))) {
        a.unseenDone = false;
        a.status = 'THINKING';
        a.lastEventAt = Date.now();
        _render();
      }
    }),

    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if (!e.projectId) return;
      const key = `hooks:${e.projectId}`;
      const a = _agents.get(key);
      if (a) {
        // Keep cost for cumulative total, then mark done
        _sessionCosts.set(key, (_sessionCosts.get(key) || 0) + (a.cost || 0));
        a.status = 'DONE';
        _render();
        // Remove after 5s so done sessions don't clog the view
        setTimeout(() => {
          _agents.delete(key);
          _render();
        }, 5000);
      }
    })
  );
}

function _findTerminalForProject(projectId) {
  try {
    const { terminalsState } = require('../../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    let bestId = null;
    for (const [id, td] of terminals) {
      if (td.project?.id === projectId && !td.isBasic) {
        bestId = id;
      }
    }
    return bestId;
  } catch { return null; }
}

// ── Chat IPC wiring ──────────────────────────────────────────────────────────

function _wireChatEvents() {
  const api = window.electron_api;
  if (!api?.chat) return;

  _chatMessageUnlistener = api.chat.onMessage(({ sessionId, message }) => {
    if (!sessionId) return;
    const key = `chat:${sessionId}`;
    console.log('[CT] chat onMessage → key:', key, 'type:', message?.type, '| existing:', _agents.has(key));

    // Ensure agent entry exists
    if (!_agents.has(key)) {
      // Try to find session info from terminalsState chat mode
      const chatInfo = _findChatSession(sessionId);
      // A scan-created placeholder for this tab is superseded by this card
      if (chatInfo?.terminalId != null) {
        for (const [k, v] of _agents) {
          if (k !== key && k.startsWith('chat:') && v.terminalId === chatInfo.terminalId) _agents.delete(k);
        }
      }
      _agents.set(key, {
        id: key,
        type: 'chat',
        projectName: chatInfo?.projectName || 'Chat',
        projectPath: chatInfo?.projectPath || '',
        sessionName: chatInfo?.sessionName || null,
        branch: null,
        status: 'THINKING',
        currentTool: null,
        currentFile: null,
        startTime: Date.now(),
        cost: 0,
        totalTokens: 0,
        terminalId: chatInfo?.terminalId || null,
        chatSessionId: sessionId,
        model: null
      });
    }

    const a = _agents.get(key);
    if (!a) return;

    // Retry project resolution if it failed at creation (timing race)
    if (a.projectName === 'Chat' || !a.projectPath) {
      const chatInfo = _findChatSession(sessionId);
      if (chatInfo && chatInfo.projectName !== 'Chat') {
        a.projectName = chatInfo.projectName;
        a.projectPath = chatInfo.projectPath;
        if (chatInfo.terminalId) a.terminalId = chatInfo.terminalId;
        if (chatInfo.sessionName) a.sessionName = chatInfo.sessionName;
      }
    }

    // Exact model from SDK metadata (init message and per-turn assistant metadata)
    if (message.subtype === 'init' && message.model) {
      a.model = _formatModel(message.model) || a.model;
    }
    if (message.type === 'assistant' && message.message?.model) {
      a.model = _formatModel(message.message.model) || a.model;
    }

    // Reset to THINKING only when the USER sends a new message (not for result/assistant replies)
    if (message.type === 'user') a.lastUserAt = Date.now();
    if ((a.status === 'IDLE' || a.status === 'DONE') && message.type === 'user') {
      a.unseenDone = false;
      a.status = 'THINKING';
      a.currentTool = null;
      a.currentFile = null;
    }

    // Update cost and tokens from result messages — turn complete: stay DONE
    // (green) until the user opens the session from here
    if (message.type === 'result') {
      if (message.total_cost_usd != null) a.cost = message.total_cost_usd;
      if (message.usage) {
        a.totalTokens = (message.usage.input_tokens || 0) + (message.usage.output_tokens || 0);
      }
      if (a.status === 'THINKING' || a.status === 'RUNNING_TOOL') a.unseenDone = true;
      a.status = a.unseenDone ? 'DONE' : 'IDLE';
      a.currentTool = null;
      a.currentFile = null;
    }

    // Track tool usage from assistant messages
    if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          a.status = 'RUNNING_TOOL';
          a.currentTool = block.name || null;
          a.currentFile = _extractFile(block.input) || a.currentFile;
        }
        // Capture last assistant text response
        if (block.type === 'text' && block.text) {
          _lastResponses.set(sessionId, block.text.slice(0, 800));
        }
      }
    }

    // Track usage from assistant turn metadata
    if (message.type === 'assistant' && message.message?.usage) {
      const u = message.message.usage;
      a.totalTokens = (u.input_tokens || 0) + (u.output_tokens || 0);
    }

    _render();
  });

  _chatIdleUnlistener = api.chat.onIdle(({ sessionId }) => {
    const key = `chat:${sessionId}`;
    const a = _agents.get(key);
    if (a) {
      if (a.status === 'THINKING' || a.status === 'RUNNING_TOOL') a.unseenDone = true;
      a.status = a.unseenDone ? 'DONE' : 'IDLE';
      _render();
    }
  });

  _chatDoneUnlistener = api.chat.onDone(({ sessionId, aborted }) => {
    const key = `chat:${sessionId}`;
    const a = _agents.get(key);
    if (a) {
      _sessionCosts.set(key, (_sessionCosts.get(key) || 0) + (a.cost || 0));
      a.status = aborted ? 'ERROR' : 'DONE';
      if (!aborted) a.unseenDone = true;
      _pendingPermissions.delete(sessionId);
      _render();
      // Keep the card while its tab is open — the session ended, but the tab
      // is still there and the grid must mirror the open tabs. Cards without
      // a live tab (unresolved terminal) still expire after 5s.
      setTimeout(() => {
        const cur = _agents.get(key);
        if (!cur) return;
        let tabAlive = false;
        try {
          const { terminalsState } = require('../../state/terminals.state');
          tabAlive = cur.terminalId != null && terminalsState.get().terminals.has(cur.terminalId);
        } catch { /* ignore */ }
        if (!tabAlive) {
          _agents.delete(key);
          _lastResponses.delete(sessionId);
          _expandedResponses.delete(key);
        }
        _render();
      }, 5000);
    }
  });

  _chatErrorUnlistener = api.chat.onError(({ sessionId }) => {
    const key = `chat:${sessionId}`;
    const a = _agents.get(key);
    if (a) {
      a.status = 'ERROR';
      _pendingPermissions.delete(sessionId);
      _render();
    }
  });

  // Listen for permission requests to set WAITING state
  _chatPermissionUnlistener = api.chat.onPermissionRequest((data) => {
    const { sessionId, requestId, toolName, input } = data;
    if (!sessionId) return;

    const key = `chat:${sessionId}`;
    const a = _agents.get(key);
    if (a) {
      a.status = 'WAITING';
      // Store pending permission data for inline actions
      _pendingPermissions.set(sessionId, { requestId, toolName, input, data });
      _render();
    }
  });
}

function _findChatSession(sessionId) {
  try {
    const { terminalsState } = require('../../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    for (const [id, td] of terminals) {
      // claudeSessionId is set by ChatView: updateTerminal(id, { claudeSessionId: sessionId })
      // Also match directly on the terminal id (same format: chat-TIMESTAMP-RANDOM)
      if (td.claudeSessionId === sessionId || id === sessionId) {
        return {
          projectName: td.project?.name || 'Chat',
          projectPath: td.project?.path || '',
          terminalId: id,
          sessionName: td.name || null
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ── Terminals state scan ─────────────────────────────────────────────────────

/**
 * Ensure a chat tab has a card from the moment the tab exists. IPC events
 * drive status/cost once the first message is sent; before that the tab is
 * still an open session and must show up in the grid. The card key follows
 * the IPC session id (td.claudeSessionId) once assigned — stale cards still
 * keyed on this tab are migrated out.
 */
function _ensureChatAgent(terminalId, td) {
  let changed = false;
  const key = `chat:${td.claudeSessionId || terminalId}`;

  // The IPC session id replaces the placeholder key once the first message is
  // sent (and again after a session ends and a new one starts in the same
  // tab) — drop any older card still pointing at this tab.
  for (const [k, a] of _agents) {
    if (k !== key && k.startsWith('chat:') && a.terminalId === terminalId) {
      _agents.delete(k);
      changed = true;
    }
  }

  if (!_agents.has(key)) {
    _agents.set(key, {
      id: key,
      type: 'chat',
      projectName: td.projectName || td.project?.name || 'Chat',
      projectPath: td.projectPath || td.project?.path || '',
      sessionName: td.name || null,
      branch: null,
      status: 'IDLE',
      currentTool: null,
      currentFile: null,
      startTime: _toEpochMs(td.createdAt),
      cost: 0,
      totalTokens: 0,
      terminalId,
      chatSessionId: td.claudeSessionId || null,
      model: null
    });
    return true;
  }

  const a = _agents.get(key);
  a.terminalId = terminalId;
  if (td.claudeSessionId && !a.chatSessionId) a.chatSessionId = td.claudeSessionId;
  // Repair metadata the event handler could not resolve at creation time
  const pn = td.projectName || td.project?.name;
  if (pn && a.projectName !== pn) { a.projectName = pn; changed = true; }
  const pp = td.projectPath || td.project?.path || '';
  if (pp && a.projectPath !== pp) { a.projectPath = pp; changed = true; }
  const name = td.name || null;
  if (a.sessionName !== name) { a.sessionName = name; changed = true; }
  return changed;
}

/**
 * True when the visible tail of the terminal looks like an interactive prompt
 * (permission request, y/n question). The CLI title drops to "ready" while a
 * permission prompt is on screen, so status alone would misread it as idle.
 */
function _bufferTailLooksLikePrompt(td) {
  try {
    const buf = td?.terminal?.buffer?.active;
    if (!buf) return false;
    const lines = [];
    for (let i = buf.length - 1; i >= 0 && lines.length < 8; i--) {
      lines.unshift(buf.getLine(i)?.translateToString(true) || '');
    }
    const tail = lines.join('\n');
    // "❯ 1." matches any numbered option list (permission prompts, questions)
    return /\b(Do you want|Allow|Approve|Proceed\?|yes\/no|y\/n)\b|❯\s*1\./i.test(tail);
  } catch { return false; }
}

/**
 * Derive the Control Tower status for a CLI terminal session from the terminal
 * state plus TerminalManager's scraped substatus (thinking / tool / waiting).
 */
function _deriveTerminalAgentStatus(td, id) {
  if (td.status === 'error') return { status: 'ERROR', tool: null };
  if (td.pendingPermission) return { status: 'WAITING', tool: null };

  let sub = null, tool = null;
  try {
    const TerminalManager = require('../components/TerminalManager');
    sub = TerminalManager.getTerminalSubstatus?.(id) || null;
    tool = TerminalManager.getTerminalLastTool?.(id) || null;
  } catch { /* ignore */ }

  if (sub === 'waiting') return { status: 'WAITING', tool };
  if (td.status === 'working' || td.status === 'loading') {
    return sub === 'tool_calling'
      ? { status: 'RUNNING_TOOL', tool }
      : { status: 'THINKING', tool: null };
  }
  if (_bufferTailLooksLikePrompt(td)) return { status: 'WAITING', tool: null };
  return { status: 'IDLE', tool: null };
}

// Recognise a model reference in terminal output, e.g. "claude-sonnet-4-6",
// "Sonnet 4.6", "fable". Keep in sync with Anthropic model family names.
const MODEL_PATTERN = /(?:claude-)?(fable|opus|sonnet|haiku)(?:[-\s]?([0-9][\d.-]*))?/i;

function _formatModel(raw) {
  if (!raw) return null;
  const m = String(raw).match(MODEL_PATTERN);
  if (!m) return null;
  const family = m[1].toUpperCase();
  const version = (m[2] || '').replace(/-/g, '.').replace(/\.$/, '');
  return version ? `${family} ${version}` : family;
}

/**
 * Best-effort model detection for CLI terminals: take the most recent model
 * mention from the captured output buffer. Chat sessions get the exact model
 * from SDK messages instead.
 */
function _detectTerminalModel(td, sinceCursor = 0) {
  const entries = td?.outputBuffer;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  // Newest mention wins (the model can change mid-session via /model).
  // `sinceCursor` bounds the walk to output that arrived since the last scan:
  // the buffer holds up to 500 KB per terminal, and a session that never names
  // its model would otherwise re-scan all of it on every 2s tick.
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].cursor <= sinceCursor) break;
    const m = (entries[i].text || '').match(MODEL_PATTERN);
    if (m) return _formatModel(m[0]);
  }
  return null;
}

async function _scanTerminals() {
  let changed = false;
  try {
    const { terminalsState } = require('../../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    for (const [id, td] of terminals) {
      // Only track Claude sessions (not basic shells, file viewers, fivem/webapp)
      if (td.isBasic || td.type === 'fivem' || td.type === 'webapp' || td.type === 'file') continue;

      // Chat tabs: IPC events drive status once the first message is sent,
      // but the card must exist as soon as the tab does — every open tab in
      // the Claude view is an open session in the grid.
      if (td.mode === 'chat') {
        // Switched back from terminal mode — drop the stale per-terminal card
        if (_agents.delete(`terminal:${id}`)) changed = true;
        if (_ensureChatAgent(id, td)) changed = true;
        continue;
      }

      const key = `terminal:${id}`;
      // A chat tab switched to terminal mode keeps its chat card otherwise, and
      // that card is frozen: its status comes from SDK events that no longer
      // arrive. Drop it so the tab is represented by its terminal card only.
      for (const [k, a] of _agents) {
        if (k.startsWith('chat:') && a.terminalId === id) {
          _agents.delete(k);
          if (a.chatSessionId) _lastResponses.delete(a.chatSessionId);
          _expandedResponses.delete(k);
          changed = true;
        }
      }
      const derived = _deriveTerminalAgentStatus(td, id);
      if (!_agents.has(key)) {
        _agents.set(key, {
          id: key,
          type: 'terminal',
          projectName: td.projectName || td.project?.name || 'Unknown',
          projectPath: td.projectPath || td.project?.path || '',
          branch: td.projectPath ? await _getProjectBranch(td.projectPath) : null,
          status: derived.status,
          currentTool: derived.tool,
          currentFile: null,
          startTime: _toEpochMs(td.createdAt),
          cost: 0,
          totalTokens: 0,
          terminalId: id,
          chatSessionId: null,
          sessionName: td.name || null,
          model: _detectTerminalModel(td),
          _modelCursor: td.outputCursor ?? (td.outputBuffer?.length || 0),
          _firstSeenAt: Date.now(),
          _realWork: (derived.status === 'THINKING' || derived.status === 'RUNNING_TOOL') && !!td.lastInputAt
        });
        changed = true;
      } else {
        const a = _agents.get(key);
        // Track output flow first — it feeds both model detection and the
        // still-working override below
        const cursor = td.outputCursor ?? (td.outputBuffer?.length || 0);
        if (cursor !== a._modelCursor) {
          const prevCursor = a._modelCursor;
          a._modelCursor = cursor;
          a._lastOutputAt = Date.now();
          const model = _detectTerminalModel(td, prevCursor);
          if (model && model !== a.model) {
            a.model = model;
            changed = true;
          }
        }

        // Sessions restored at app start replay their transcript: the replayed
        // spinner titles set td.status 'working' with nothing actually running,
        // and the replay output looks like activity. Two guards keep them
        // honest: (1) interaction gate — only sessions the user typed in this
        // run get the output override and the sticky-DONE treatment; (2) stale
        // demotion — a genuinely working CLI animates its spinner through the
        // PTY, so "working" with no output for 15s is not working.
        const interacted = !!td.lastInputAt;
        let next = derived;
        let stale = false;
        const lastOut = a._lastOutputAt || a._firstSeenAt || 0;
        if ((next.status === 'THINKING' || next.status === 'RUNNING_TOOL') &&
            lastOut && Date.now() - lastOut > 15000) {
          next = { status: 'IDLE', tool: null };
          stale = true;
        }

        // Real work = the CLI itself reported a working state (scraped title)
        // in a session the user typed in this run. Only real work may later
        // turn green: the output-override below is a display aid, and letting
        // it feed sticky-DONE turned every restored session green at startup.
        if (interacted && !stale &&
            (derived.status === 'THINKING' || derived.status === 'RUNNING_TOOL')) {
          a._realWork = true;
        }

        // Title/status can read idle while output is still streaming (e.g. a
        // subagent working inside the session) — recent output means running.
        if (interacted && !stale &&
            next.status === 'IDLE' && a._lastOutputAt && Date.now() - a._lastOutputAt < 8000) {
          next = (a.status === 'RUNNING_TOOL' || a.status === 'THINKING')
            ? { status: a.status, tool: a.currentTool }
            : { status: 'THINKING', tool: null };
        }

        // A session that just finished stays DONE (green) until the user opens
        // it from here — cleared in _focusAgent/_hostAgentWrapper — or until it
        // starts working again. Stale demotions are not completions.
        const wasWorking = a.status === 'THINKING' || a.status === 'RUNNING_TOOL';
        if (next.status === 'IDLE' && wasWorking && a._realWork && !stale) {
          a.unseenDone = true;
          a._realWork = false;
        }
        if (stale) { a.unseenDone = false; a._realWork = false; }
        if (a.unseenDone) {
          if (next.status === 'IDLE') next = { status: 'DONE', tool: null };
          else if (next.status !== 'DONE') a.unseenDone = false;
        }

        // Terminal agents have no other status source — re-derive every scan
        if (a.status !== next.status || a.currentTool !== next.tool) {
          a.status = next.status;
          a.currentTool = next.tool;
          changed = true;
        }
        // Update terminalId if it changed
        a.terminalId = id;
        // Refresh display metadata so tab renames and project changes show up
        a.projectName = td.projectName || td.project?.name || a.projectName;
        a.projectPath = td.projectPath || td.project?.path || a.projectPath;
        a.sessionName = td.name || null;
      }
    }

    // Hook agents are event-driven; a missed Stop event would otherwise leave
    // them "thinking" forever. Demote to idle after a quiet period (tools can
    // legitimately run long, so they get a much larger budget).
    const now = Date.now();
    for (const [key, a] of _agents) {
      if (!key.startsWith('hooks:')) continue;
      const quiet = now - (a.lastEventAt || a.startTime || now);
      if ((a.status === 'THINKING' && quiet > 180000) ||
          (a.status === 'RUNNING_TOOL' && quiet > 600000)) {
        a.status = 'IDLE';
        a.currentTool = null;
        changed = true;
      }
    }

    // Hook events only identify the project, never the tab. Every open tab
    // already has its own per-terminal card, so a hooks card for a project
    // with open tabs would collapse them into one — hide it instead
    // (external CLI sessions, which have no tab here, keep theirs visible).
    // With exactly one matching tab the hooks card donates its event-driven
    // tool detail; with several we can't tell which tab it belongs to.
    for (const [key, ha] of _agents) {
      if (!key.startsWith('hooks:')) continue;
      const tabs = [];
      for (const [k, a] of _agents) {
        if (!k.startsWith('terminal:')) continue;
        if ((ha.projectPath && a.projectPath === ha.projectPath) ||
            (!ha.projectPath && a.projectName === ha.projectName)) tabs.push(a);
      }
      const hidden = tabs.length > 0;
      if (!!ha.hidden !== hidden) { ha.hidden = hidden; changed = true; }
      if (tabs.length === 1 && ha.status === 'RUNNING_TOOL' && ha.currentTool) {
        const tab = tabs[0];
        if ((tab.status === 'THINKING' || tab.status === 'RUNNING_TOOL') &&
            (tab.currentTool !== ha.currentTool || tab.currentFile !== ha.currentFile)) {
          tab.status = 'RUNNING_TOOL';
          tab.currentTool = ha.currentTool;
          tab.currentFile = ha.currentFile;
          changed = true;
        }
      }
    }

    // Remove agents whose tab was closed
    for (const [key, a] of _agents) {
      if (a.type === 'terminal' && key.startsWith('terminal:')) {
        // Tab ids are numeric for terminals opened as terminals, but a chat tab
        // switched to terminal mode keeps its "chat-<ts>-<rand>" id. parseInt on
        // that yields NaN, so the card was deleted on the very scan that created
        // it and such tabs never appeared in the grid at all.
        const raw = key.slice('terminal:'.length);
        const num = Number(raw);
        if (!terminals.has(raw) && !(Number.isFinite(num) && terminals.has(num))) {
          _agents.delete(key);
          changed = true;
        }
      } else if (key.startsWith('chat:') && a.terminalId != null && !terminals.has(a.terminalId)) {
        _agents.delete(key);
        if (a.chatSessionId) _lastResponses.delete(a.chatSessionId);
        _expandedResponses.delete(key);
        changed = true;
      }
    }
  } catch { /* ignore */ }
  return changed;
}

// ── Spawn agent modal ────────────────────────────────────────────────────────

function _openSpawnModal() {
  const projects = _getAllProjects();
  if (projects.length === 0) {
    alert(t('controlTower.noProjectsToSpawn'));
    return;
  }

  // Project picker built on the shared Modal component, which supplies role="dialog",
  // aria-modal, Escape-to-close, a Tab focus trap and a labelled close button.
  // Entries are <button> so they are reachable by keyboard and by the focus trap.
  const listHtml = projects.map((p, i) =>
    `<button type="button" class="ct-spawn-project" data-idx="${i}" style="width:100%;text-align:left;background:none;border:none;padding:8px 12px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:10px;transition:background 0.15s">
      <span style="width:8px;height:8px;border-radius:50%;background:${p.color || 'var(--accent)'};flex-shrink:0"></span>
      <span>
        <span style="display:block;font-size:var(--font-sm);color:var(--text-primary);font-weight:500">${escapeHtml(p.name)}</span>
        <span style="display:block;font-size:var(--font-xs);color:var(--text-muted)">${escapeHtml(p.path || '')}</span>
      </span>
    </button>`
  ).join('');

  const modal = createModal({
    id: 'ct-spawn-modal',
    title: t('controlTower.spawnTitle'),
    size: 'small',
    content: `<div style="max-height:420px;overflow-y:auto" id="ct-spawn-list">${listHtml}</div>`
  });

  modal.querySelectorAll('.ct-spawn-project').forEach(el => {
    el.onmouseenter = () => { el.style.background = 'var(--bg-hover)'; };
    el.onmouseleave = () => { el.style.background = ''; };
    el.onfocus = () => { el.style.background = 'var(--bg-hover)'; };
    el.onblur = () => { el.style.background = ''; };
    el.onclick = () => {
      const idx = parseInt(el.dataset.idx, 10);
      const project = projects[idx];
      closeModal(modal);
      _spawnTerminalForProject(project);
    };
  });

  showModal(modal);
  // No <input> in this dialog, so showModal's "focus first input" is a no-op —
  // move focus onto the first entry explicitly.
  requestAnimationFrame(() => modal.querySelector('.ct-spawn-project')?.focus());
}

async function _spawnTerminalForProject(project) {
  try {
    const TerminalManager = require('../components/TerminalManager');
    // Switch to claude tab first
    const claudeTab = document.querySelector('[data-tab="claude"]');
    if (claudeTab) claudeTab.click();
    // Set project active
    const { setSelectedProjectFilter } = require('../../state/projects.state');
    const { getProjectIndex } = require('../../state');
    const idx = getProjectIndex(project.id);
    if (idx >= 0) {
      setSelectedProjectFilter(idx);
      TerminalManager.filterByProject(idx);
    }
    await TerminalManager.createTerminal(project, { runClaude: true });
  } catch (e) {
    console.error('[ControlTower] Failed to spawn terminal:', e);
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  THINKING:     '#818cf8',
  RUNNING_TOOL: 'var(--accent)',
  WAITING:      '#f59e0b',
  IDLE:         'var(--text-muted)',
  DONE:         'var(--success)',
  ERROR:        'var(--danger)'
};

const STATUS_LABELS = {
  THINKING:     () => t('controlTower.statusThinking'),
  RUNNING_TOOL: () => t('controlTower.statusRunningTool'),
  WAITING:      () => t('controlTower.statusWaiting'),
  IDLE:         () => t('controlTower.statusIdle'),
  DONE:         () => t('controlTower.statusDone'),
  ERROR:        () => t('controlTower.statusError')
};

function _buildInlineActions(agent) {
  // Only chat sessions can have inline actions (permission requests)
  if (agent.type !== 'chat' || agent.status !== 'WAITING' || !agent.chatSessionId) return '';

  const perm = _pendingPermissions.get(agent.chatSessionId);
  if (!perm) return '';

  const { toolName, input } = perm;

  // AskUserQuestion: show question + option buttons + free text input
  if (toolName === 'AskUserQuestion') {
    // SDK structure: input.questions[0].question + input.questions[0].options[].label
    const firstQ = Array.isArray(input?.questions) ? input.questions[0] : null;
    const question = firstQ?.question ? escapeHtml(firstQ.question) : '';
    const options = Array.isArray(firstQ?.options) ? firstQ.options : [];
    const optionsHtml = options.length > 0
      ? `<div class="ct-question-options">${options.map(opt => {
          const label = typeof opt === 'object' ? (opt.label || '') : String(opt);
          const desc  = typeof opt === 'object' ? (opt.description || '') : '';
          return `<button class="ct-btn ct-btn-option" data-agent-id="${escapeHtml(agent.id)}" data-value="${escapeHtml(label)}">
            <span class="ct-option-label">${escapeHtml(label)}</span>
            ${desc ? `<span class="ct-option-desc">${escapeHtml(desc)}</span>` : ''}
          </button>`;
        }).join('')}</div>`
      : '';
    return `
      <div class="ct-inline-action" data-agent-id="${escapeHtml(agent.id)}">
        ${question ? `<div class="ct-inline-question">${question}</div>` : ''}
        ${optionsHtml}
        <div class="ct-inline-reply-row">
          <input type="text" class="ct-reply-input" placeholder="${escapeHtml(t('controlTower.replyPlaceholder'))}" data-agent-id="${escapeHtml(agent.id)}" />
          <button class="ct-btn ct-btn-approve ct-btn-reply" data-agent-id="${escapeHtml(agent.id)}">
            ${escapeHtml(t('controlTower.sendReply'))}
          </button>
        </div>
      </div>
    `;
  }

  // ExitPlanMode: accept plan button
  if (toolName === 'ExitPlanMode') {
    return `
      <div class="ct-inline-action" data-agent-id="${escapeHtml(agent.id)}">
        <div class="ct-inline-hint">${escapeHtml(t('controlTower.statusWaiting'))}: ${escapeHtml(toolName)}</div>
        <div class="ct-inline-btn-row">
          <button class="ct-btn ct-btn-approve ct-btn-accept-plan" data-agent-id="${escapeHtml(agent.id)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            ${escapeHtml(t('controlTower.acceptPlan'))}
          </button>
          <button class="ct-btn ct-btn-deny ct-btn-deny-plan" data-agent-id="${escapeHtml(agent.id)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
            ${escapeHtml(t('controlTower.deny'))}
          </button>
        </div>
      </div>
    `;
  }

  // Default permission request: show tool detail + Approve / Deny buttons
  const detail = _getPermDetail(toolName, input);
  return `
    <div class="ct-inline-action" data-agent-id="${escapeHtml(agent.id)}">
      <div class="ct-inline-hint">${escapeHtml(toolName)}</div>
      ${detail ? `<div class="ct-inline-question ct-perm-detail"><code>${escapeHtml(detail)}</code></div>` : ''}
      <div class="ct-inline-btn-row">
        <button class="ct-btn ct-btn-approve ct-btn-perm-approve" data-agent-id="${escapeHtml(agent.id)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          ${escapeHtml(t('controlTower.approve'))}
        </button>
        <button class="ct-btn ct-btn-deny ct-btn-perm-deny" data-agent-id="${escapeHtml(agent.id)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
          ${escapeHtml(t('controlTower.deny'))}
        </button>
      </div>
    </div>
  `;
}

function _buildLastResponseSection(agent) {
  if (agent.type !== 'chat' || !agent.chatSessionId) return '';
  const lastResponse = _lastResponses.get(agent.chatSessionId);
  if (!lastResponse) return '';
  return `<div class="ct-response-preview">${escapeHtml(lastResponse)}${lastResponse.length >= 800 ? '…' : ''}</div>`;
}

function _buildReplyInput(agent) {
  if (agent.type !== 'chat' || !agent.chatSessionId) return '';
  if (agent.status !== 'IDLE') return '';
  return `
    <div class="ct-inline-reply-row" style="margin-top:2px">
      <input type="text" class="ct-reply-input ct-reply-idle" placeholder="${escapeHtml(t('controlTower.replyPlaceholder'))}" data-agent-id="${escapeHtml(agent.id)}" />
      <button class="ct-btn ct-btn-approve ct-btn-send-idle" data-agent-id="${escapeHtml(agent.id)}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>
  `;
}

function _buildAgentCard(agent) {
  const elapsed = Date.now() - agent.startTime;
  const duration = _formatDuration(elapsed);
  const statusColor = STATUS_COLORS[agent.status] || 'var(--text-muted)';
  const statusLabel = (STATUS_LABELS[agent.status] || (() => agent.status))();
  const cost = _formatCost(agent.cost);
  const isActive = agent.status !== 'DONE' && agent.status !== 'ERROR';
  const isCollapsed = _collapsedAgents.has(agent.id);

  const activityLine = agent.currentTool
    ? `${escapeHtml(agent.currentTool)}${agent.currentFile ? ` → ${escapeHtml(agent.currentFile)}` : ''}`
    : agent.status === 'THINKING'     ? t('controlTower.activityThinking')
    : agent.status === 'RUNNING_TOOL' ? t('controlTower.activityThinking')
    : agent.status === 'WAITING'      ? t('controlTower.activityWaiting')
    : '—';

  const branchBadge = agent.branch
    ? `<span class="ct-branch-badge">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">
          <line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>
          <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
        ${escapeHtml(agent.branch)}
      </span>`
    : '';

  const pulseClass = (agent.status === 'THINKING' || agent.status === 'RUNNING_TOOL') ? ' ct-status-pulse' : '';
  const waitingClass = agent.status === 'WAITING' ? ' ct-status-waiting' : '';

  // Collapsed compact meta shown inline in header
  const compactMeta = isCollapsed ? `<span class="ct-compact-meta">${escapeHtml(duration)} · ${escapeHtml(cost)}</span>` : '';

  return `
    <div class="ct-agent-card${agent.status === 'DONE' ? ' ct-agent-done' : ''}${agent.status === 'ERROR' ? ' ct-agent-error' : ''}${agent.status === 'WAITING' ? ' ct-agent-waiting' : ''}${isCollapsed ? ' ct-agent-collapsed' : ''}" data-agent-id="${escapeHtml(agent.id)}" style="--ct-status-color:${statusColor}">
      <div class="ct-agent-header">
        <button class="ct-collapse-toggle" data-agent-id="${escapeHtml(agent.id)}" title="${isCollapsed ? 'Expand' : 'Collapse'}">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            ${isCollapsed ? '<polyline points="9 18 15 12 9 6"/>' : '<polyline points="6 9 12 15 18 9"/>'}
          </svg>
        </button>
        <div class="ct-agent-project">
          <span class="ct-project-name">${escapeHtml(agent.projectName)}${agent.sessionName ? `<span class="ct-session-sep"> – </span><span class="ct-session-name">${escapeHtml(agent.sessionName)}</span>` : ''}</span>
          ${branchBadge}
        </div>
        ${compactMeta}
        <span class="ct-status-badge${pulseClass}${waitingClass}" style="--status-color:${statusColor}">
          ${escapeHtml(statusLabel)}
        </span>
      </div>

      ${isCollapsed ? '' : `
      <div class="ct-agent-activity">${activityLine}</div>

      ${_buildLastResponseSection(agent)}
      ${_buildInlineActions(agent)}
      ${_buildReplyInput(agent)}

      <div class="ct-agent-footer">
        <div class="ct-agent-meta">
          <span class="ct-meta-item ct-meta-timer" data-agent-start="${agent.startTime}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0;opacity:0.5">
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
            </svg>
            ${escapeHtml(duration)}
          </span>
          <span class="ct-meta-item ct-meta-cost" data-agent-id="${escapeHtml(agent.id)}">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;opacity:0.5">
              <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
            </svg>
            ${escapeHtml(cost)}
          </span>
          ${agent.totalTokens > 0
            ? `<span class="ct-meta-item ct-meta-tokens">${(agent.totalTokens / 1000).toFixed(1)}k ${t('controlTower.tokens')}</span>`
            : ''}
        </div>
        <div class="ct-agent-actions">
          <button class="ct-btn ct-btn-focus" data-agent-id="${escapeHtml(agent.id)}" title="${escapeHtml(t('controlTower.focus'))}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1"/>
            </svg>
            ${escapeHtml(t('controlTower.focus'))}
          </button>
          ${isActive
            ? `<button class="ct-btn ct-btn-interrupt" data-agent-id="${escapeHtml(agent.id)}" title="${escapeHtml(t('controlTower.interrupt'))}">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                </svg>
                ${escapeHtml(t('controlTower.interrupt'))}
              </button>`
            : ''}
        </div>
      </div>
      `}
    </div>
  `;
}

function _buildEmptyState() {
  return `
    <div class="ct-empty-state">
      <div class="ct-empty-icon">
        <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.25">
          <circle cx="12" cy="12" r="10"/>
          <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
          <line x1="9" y1="9" x2="9.01" y2="9"/>
          <line x1="15" y1="9" x2="15.01" y2="9"/>
        </svg>
      </div>
      <p class="ct-empty-title">${escapeHtml(t('controlTower.emptyTitle'))}</p>
      <p class="ct-empty-desc">${escapeHtml(t('controlTower.emptyDesc'))}</p>
    </div>
  `;
}

// Status filter groups: select value -> agent statuses it matches
const STATUS_FILTER_GROUPS = {
  working: ['THINKING', 'RUNNING_TOOL'],
  waiting: ['WAITING'],
  idle:    ['IDLE'],
  done:    ['DONE'],
  error:   ['ERROR']
};

// DONE ranks above IDLE: an unseen finished session is waiting for review
const STATUS_SORT_PRIORITY = { WAITING: 0, ERROR: 1, RUNNING_TOOL: 2, THINKING: 3, DONE: 4, IDLE: 5 };

function _applyFilters(agents) {
  let out = agents;
  if (_filterProject !== 'all') {
    out = out.filter(a => a.projectName === _filterProject);
  }
  if (_filterStatus !== 'all') {
    const statuses = STATUS_FILTER_GROUPS[_filterStatus] || [];
    out = out.filter(a => statuses.includes(a.status));
  }
  if (_filterText) {
    const q = _filterText.toLowerCase();
    out = out.filter(a =>
      (a.projectName || '').toLowerCase().includes(q) ||
      (a.sessionName || '').toLowerCase().includes(q) ||
      (a.branch || '').toLowerCase().includes(q)
    );
  }
  return out;
}

function _sortAgents(agents) {
  const sorted = [...agents];
  if (_sortMode === 'recent') {
    sorted.sort((a, b) => _getLastActivityTs(b) - _getLastActivityTs(a));
  } else if (_sortMode === 'oldest') {
    sorted.sort((a, b) => _getLastActivityTs(a) - _getLastActivityTs(b));
  } else if (_sortMode === 'project') {
    sorted.sort((a, b) => (a.projectName || '').localeCompare(b.projectName || ''));
  } else if (_sortMode === 'status') {
    sorted.sort((a, b) => (STATUS_SORT_PRIORITY[a.status] ?? 9) - (STATUS_SORT_PRIORITY[b.status] ?? 9));
  }
  return sorted;
}

function _buildGridCard(agent) {
  const statusColor = STATUS_COLORS[agent.status] || 'var(--text-muted)';
  const statusLabel = (STATUS_LABELS[agent.status] || (() => agent.status))();
  const lastTs = _getLastActivityTs(agent);
  const pulseClass = (agent.status === 'THINKING' || agent.status === 'RUNNING_TOOL') ? ' ct-status-pulse' : '';

  const activityLine = agent.currentTool
    ? `${escapeHtml(agent.currentTool)}${agent.currentFile ? ` → ${escapeHtml(agent.currentFile)}` : ''}`
    : agent.status === 'THINKING'     ? t('controlTower.activityThinking')
    : agent.status === 'RUNNING_TOOL' ? t('controlTower.activityThinking')
    : agent.status === 'WAITING'      ? t('controlTower.activityWaiting')
    : '—';

  return `
    <div class="ct-grid-card${agent.status === 'WAITING' ? ' ct-agent-waiting' : ''}${agent.status === 'DONE' ? ' ct-agent-done' : ''}"
         data-agent-id="${escapeHtml(agent.id)}" style="--ct-status-color:${statusColor}"
         role="button" tabindex="0" title="${escapeHtml(agent.projectName)}${agent.sessionName ? ` – ${escapeHtml(agent.sessionName)}` : ''}">
      <div class="ct-grid-card-header">
        <span class="ct-grid-status-dot${pulseClass}" style="--status-color:${statusColor}"></span>
        <span class="ct-grid-title">${escapeHtml(agent.sessionName || agent.projectName)}</span>
      </div>
      ${agent.branch ? `<div class="ct-grid-branch">${escapeHtml(agent.branch)}</div>` : ''}
      ${(() => {
        const preview = _getAgentPreview(agent);
        return preview ? `<div class="ct-grid-thumb"><pre>${escapeHtml(preview)}</pre></div>` : '';
      })()}
      <div class="ct-grid-activity">${activityLine}</div>
      <div class="ct-grid-footer">
        <span class="ct-grid-badge" style="--status-color:${statusColor}">${escapeHtml(statusLabel)}</span>
        ${agent.model ? `<span class="ct-grid-model">${escapeHtml(agent.model)}</span>` : ''}
        <span class="ct-grid-time" data-agent-last="${lastTs}" title="${escapeHtml(t('controlTower.lastActivity'))}: ${escapeHtml(new Date(lastTs).toLocaleString())}">
          ${escapeHtml(_formatRelative(Date.now() - lastTs))}
        </span>
      </div>
    </div>
  `;
}

/**
 * Short live preview for a grid card thumbnail: last assistant text for chat
 * sessions, tail of the live xterm buffer for terminal sessions.
 */
function _getAgentPreview(agent) {
  if (agent.type === 'chat' && agent.chatSessionId) {
    const r = _lastResponses.get(agent.chatSessionId);
    if (r && r.trim()) return r.slice(0, 260);
  }
  if (agent.terminalId != null) {
    try {
      const { terminalsState } = require('../../state/terminals.state');
      const td = terminalsState.get().terminals.get(agent.terminalId);
      const buf = td?.terminal?.buffer?.active;
      if (buf) {
        const lines = [];
        for (let i = buf.length - 1; i >= 0 && lines.length < 6; i--) {
          const text = buf.getLine(i)?.translateToString(true) || '';
          if (lines.length === 0 && !text.trim()) continue; // skip trailing blank rows
          lines.unshift(text);
        }
        const joined = lines.join('\n').trimEnd();
        if (joined.trim()) return joined.slice(-400);
      }
    } catch { /* ignore */ }
  }
  return null;
}

// Simplified status groups for the per-project header counts
const GROUP_DEFS = [
  { statuses: ['THINKING', 'RUNNING_TOOL'], color: '#818cf8',          label: () => t('controlTower.filterWorking') },
  { statuses: ['WAITING'],                  color: '#f59e0b',          label: () => t('controlTower.filterWaiting') },
  { statuses: ['IDLE'],                     color: 'var(--text-muted)', label: () => t('controlTower.filterIdle') },
  { statuses: ['DONE'],                     color: 'var(--success)',    label: () => t('controlTower.filterDone') },
  { statuses: ['ERROR'],                    color: 'var(--danger)',     label: () => t('controlTower.filterError') }
];

function _statusGroupSummary(list) {
  return GROUP_DEFS.map(g => {
    const n = list.filter(a => g.statuses.includes(a.status)).length;
    if (!n) return '';
    return `<span class="ct-group-count" style="--status-color:${g.color}">` +
      `<span class="ct-grid-status-dot"></span>${n} ${escapeHtml(g.label())}</span>`;
  }).filter(Boolean).join('');
}

/**
 * Resolve the project registry entry for a group of agents (path match first,
 * then name) so the group header can offer a "new session" spawn button.
 */
function _resolveProjectForAgents(list) {
  const projects = _getAllProjects();
  for (const a of list) {
    const p = projects.find(p => (a.projectPath && p.path === a.projectPath) || p.name === a.projectName);
    if (p) return p;
  }
  return null;
}

function _buildNoMatchesState() {
  return `<div class="ct-empty-state"><p class="ct-empty-title">${escapeHtml(t('controlTower.noMatches'))}</p></div>`;
}

/**
 * Refresh the project filter dropdown options from the current agent set,
 * preserving the active selection. Only touches the DOM when the set changed.
 */
function _syncProjectFilterOptions(agents) {
  const select = document.getElementById('ct-filter-project');
  if (!select) return;
  const names = [...new Set(agents.map(a => a.projectName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const signature = names.join('\n');
  if (select.dataset.signature === signature) return;
  select.dataset.signature = signature;
  select.innerHTML = `<option value="all">${escapeHtml(t('controlTower.filterAllProjects'))}</option>` +
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  // Restore selection; reset if the project disappeared
  if (_filterProject !== 'all' && !names.includes(_filterProject)) _filterProject = 'all';
  select.value = _filterProject;
}

function _render() {
  const container = document.getElementById('ct-agents-container');
  if (!container) return;

  // Sync terminal state before rendering
  _scanTerminals();

  const agents = Array.from(_agents.values()).filter(a => !a.hidden);

  // Update header counters
  const countEl = document.getElementById('ct-active-count');
  const costEl = document.getElementById('ct-total-cost');
  if (countEl) countEl.textContent = _activeAgentCount();
  if (costEl) costEl.textContent = _formatCost(_totalActiveCost());

  _syncProjectFilterOptions(agents);
  container.classList.toggle('ct-grid-container', _viewMode === 'grid');

  // Keep the focus-view filmstrip in sync with live statuses
  if (_overlayRestore) _renderFilmstrip();

  if (agents.length === 0) {
    container.innerHTML = _buildEmptyState();
    return;
  }

  const filtered = _applyFilters(agents);
  if (filtered.length === 0) {
    container.innerHTML = _buildNoMatchesState();
    return;
  }

  if (_viewMode === 'grid') {
    // Group cards per project; groups keep the active sort order (first agent wins)
    const groups = new Map();
    for (const a of _sortAgents(filtered)) {
      const k = a.projectName || '—';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }
    container.innerHTML = [...groups.entries()].map(([name, list]) => {
      const project = _resolveProjectForAgents(list);
      return `
      <div class="ct-grid-group">
        <div class="ct-grid-group-header">
          <span class="ct-grid-group-name">${escapeHtml(name)}</span>
          <span class="ct-grid-group-counts">${_statusGroupSummary(list)}</span>
          ${project ? `<button class="ct-group-spawn" data-project-id="${escapeHtml(project.id)}" title="${escapeHtml(t('controlTower.newSession'))}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            ${escapeHtml(t('controlTower.newSession'))}
          </button>` : ''}
        </div>
        <div class="ct-grid-group-cards">${list.map(_buildGridCard).join('')}</div>
      </div>
    `;
    }).join('');
    container.querySelectorAll('.ct-grid-card').forEach(card => {
      card.onclick = () => _maximizeAgent(card.dataset.agentId);
      card.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          _maximizeAgent(card.dataset.agentId);
        }
      };
    });
    container.querySelectorAll('.ct-group-spawn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        // dataset stringifies ids — compare loosely against the registry
        const project = _getAllProjects().find(p => String(p.id) === btn.dataset.projectId);
        if (project) _spawnTerminalForProject(project);
      };
    });
    return;
  }

  // List view: active first, then done/error (original ordering)
  const active = filtered.filter(a => a.status !== 'DONE' && a.status !== 'ERROR');
  const done = filtered.filter(a => a.status === 'DONE' || a.status === 'ERROR');
  const allOrdered = [...active, ...done];
  container.innerHTML = allOrdered.map(_buildAgentCard).join('');

  // Attach event handlers
  container.querySelectorAll('.ct-collapse-toggle').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.agentId;
      if (_collapsedAgents.has(id)) _collapsedAgents.delete(id);
      else _collapsedAgents.add(id);
      _render();
    };
  });
  container.querySelectorAll('.ct-btn-focus').forEach(btn => {
    btn.onclick = () => _focusAgent(btn.dataset.agentId);
  });
  container.querySelectorAll('.ct-btn-interrupt').forEach(btn => {
    btn.onclick = () => _interruptAgent(btn.dataset.agentId);
  });

  // Inline action: click an option button (fills the reply and sends it)
  container.querySelectorAll('.ct-btn-option').forEach(btn => {
    btn.onclick = () => _sendReply(btn.dataset.agentId, btn.dataset.value);
  });

  // Inline action: reply to AskUserQuestion
  container.querySelectorAll('.ct-btn-reply').forEach(btn => {
    btn.onclick = () => {
      const agentId = btn.dataset.agentId;
      const input = container.querySelector(`.ct-reply-input[data-agent-id="${CSS.escape(agentId)}"]`);
      if (input) _sendReply(agentId, input.value);
    };
  });
  container.querySelectorAll('.ct-reply-input').forEach(input => {
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (input.classList.contains('ct-reply-idle')) {
          _sendChatMessage(input.dataset.agentId, input.value);
        } else {
          _sendReply(input.dataset.agentId, input.value);
        }
      }
    };
  });

  // Idle reply: send message to active chat session
  container.querySelectorAll('.ct-btn-send-idle').forEach(btn => {
    btn.onclick = () => {
      const agentId = btn.dataset.agentId;
      const input = container.querySelector(`.ct-reply-idle[data-agent-id="${CSS.escape(agentId)}"]`);
      if (input) _sendChatMessage(agentId, input.value);
    };
  });

  // Inline action: approve permission
  container.querySelectorAll('.ct-btn-perm-approve').forEach(btn => {
    btn.onclick = () => _respondPermission(btn.dataset.agentId, true);
  });
  container.querySelectorAll('.ct-btn-perm-deny').forEach(btn => {
    btn.onclick = () => _respondPermission(btn.dataset.agentId, false);
  });

  // Inline action: accept / deny plan (ExitPlanMode)
  container.querySelectorAll('.ct-btn-accept-plan').forEach(btn => {
    btn.onclick = () => _respondPermission(btn.dataset.agentId, true);
  });
  container.querySelectorAll('.ct-btn-deny-plan').forEach(btn => {
    btn.onclick = () => _respondPermission(btn.dataset.agentId, false);
  });

}

function _updateTimers() {
  // Update only timer and cost spans in-place (avoids full re-render)
  const now = Date.now();
  document.querySelectorAll('.ct-meta-timer[data-agent-start]').forEach(el => {
    const start = parseInt(el.dataset.agentStart, 10);
    if (!isNaN(start)) {
      const svg = el.querySelector('svg');
      el.textContent = _formatDuration(now - start);
      if (svg) el.prepend(svg); // restore svg after textContent replace
    }
  });

  // Update header cost
  const costEl = document.getElementById('ct-total-cost');
  if (costEl) costEl.textContent = _formatCost(_totalActiveCost());

  // Update cost per card
  document.querySelectorAll('.ct-meta-cost[data-agent-id]').forEach(el => {
    const agentId = el.dataset.agentId;
    const agent = _agents.get(agentId);
    if (agent) {
      const svg = el.querySelector('svg');
      el.textContent = _formatCost(agent.cost);
      if (svg) el.prepend(svg);
    }
  });

  // Update grid card "last activity" times
  document.querySelectorAll('.ct-grid-time[data-agent-last]').forEach(el => {
    const last = parseInt(el.dataset.agentLast, 10);
    if (!isNaN(last)) el.textContent = _formatRelative(now - last);
  });

  // Refresh grid thumbnails in-place; a card without one yet gets it on the
  // next event-driven full render.
  document.querySelectorAll('.ct-grid-card[data-agent-id] .ct-grid-thumb pre').forEach(pre => {
    const card = pre.closest('.ct-grid-card');
    const agent = card ? _agents.get(card.dataset.agentId) : null;
    if (!agent) return;
    const preview = _getAgentPreview(agent);
    if (preview && preview !== pre.textContent) pre.textContent = preview;
  });
}

// ── Agent actions ────────────────────────────────────────────────────────────

/**
 * Maximize a session inside the Control Tower area: the live terminal wrapper
 * is reparented into the panel's maximized host (hiding the grid) and moved
 * back on close, so the same xterm/chat instance keeps running — no second
 * instance, no lost scrollback.
 */
function _findWrapperForAgent(agent) {
  if (agent.terminalId == null) return null;
  // CSS.escape is missing under jsdom; terminal ids are simple, quote-escaping suffices
  const escapeAttr = (v) => (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
  return document.querySelector(`.terminal-wrapper[data-id="${escapeAttr(String(agent.terminalId))}"]`);
}

function _getTermData(terminalId) {
  try {
    const { getTerminal } = require('../../state/terminals.state');
    return getTerminal(terminalId) || null;
  } catch { return null; }
}

function _fitHosted(termData) {
  if (!termData || termData.mode === 'chat') return;
  try { termData.fitAddon?.fit(); } catch { /* zero-size mid-layout — the retry pass covers it */ }
  // Re-render after the move so the viewport is crisp at the host's size.
  try {
    const term = termData.terminal;
    if (term && term.rows > 0) term.refresh(0, term.rows - 1);
  } catch { /* ignore */ }
}

function _focusHosted(termData) {
  if (!termData) return;
  try {
    if (termData.mode === 'chat') termData.chatView?.focus?.();
    else termData.terminal?.focus();
  } catch { /* ignore */ }
}

function _hostHasFocus() {
  const host = document.getElementById('ct-maximized-host');
  return !!(host && host.contains(document.activeElement));
}

/** Reparent an agent's terminal wrapper into the focus-view host. */
function _hostAgentWrapper(agent, wrapper) {
  _markSeen(agent);
  const host = document.getElementById('ct-maximized-host');
  const termData = _getTermData(agent.terminalId);

  _overlayRestore = {
    wrapper,
    parent: wrapper.parentElement,
    nextSibling: wrapper.nextSibling,
    wasActive: wrapper.classList.contains('active'),
    agentId: agent.id,
    termData
  };

  host.appendChild(wrapper);
  wrapper.classList.add('ct-overlay-hosted');

  const titleEl = document.getElementById('ct-maximized-title');
  if (titleEl) titleEl.textContent = agent.sessionName || agent.projectName;
  _updateMaximizedStatus();
  _renderFilmstrip();

  // Fit and focus are isolated on purpose: a fit() throw on the not-yet-laid-
  // out host used to swallow the focus call too, leaving the keyboard on the
  // grid ("can't type until I switch away and back"). Verify focus landed and
  // retry once after layout settles.
  requestAnimationFrame(() => {
    _fitHosted(termData);
    _focusHosted(termData);
    setTimeout(() => {
      if (!_overlayRestore || _overlayRestore.wrapper !== wrapper) return;
      // Always re-fit once layout has settled — a swallowed fit() failure
      // leaves stale render dimensions even when focus landed fine.
      _fitHosted(termData);
      if (!_hostHasFocus()) _focusHosted(termData);
    }, 150);
  });
}

/** Return the currently hosted wrapper to its home container. */
function _returnWrapperHome() {
  const r = _overlayRestore;
  _overlayRestore = null;
  if (!r || !r.wrapper.isConnected) return;
  r.wrapper.classList.remove('ct-overlay-hosted');
  r.wrapper.classList.toggle('active', r.wasActive);
  if (r.parent && r.parent.isConnected) {
    r.parent.insertBefore(r.wrapper, r.nextSibling && r.nextSibling.isConnected ? r.nextSibling : null);
  }
  if (r.wasActive && r.termData?.fitAddon) {
    requestAnimationFrame(() => { try { r.termData.fitAddon.fit(); } catch { /* ignore */ } });
  }
}

function _maximizeAgent(agentId) {
  const agent = _agents.get(agentId);
  if (!agent) return;

  // Only one maximized session at a time
  if (_overlayRestore) return;

  const maximized = document.getElementById('ct-maximized');
  const host = document.getElementById('ct-maximized-host');
  if (!maximized || !host || !_panelRootEl) return;

  const wrapper = _findWrapperForAgent(agent);
  // No live wrapper to host (e.g. session ended) — fall back to focusing the tab
  if (!wrapper) {
    _focusAgent(agentId);
    return;
  }

  _panelRootEl.classList.add('ct-maximize-mode');
  maximized.hidden = false;
  _hostAgentWrapper(agent, wrapper);
  document.addEventListener('keydown', _onMaximizedKeydown);
}

/** Switch the focus view to another session without leaving it. */
function _swapMaximized(agentId) {
  if (!_overlayRestore || _overlayRestore.agentId === agentId) return;
  const agent = _agents.get(agentId);
  if (!agent) return;
  const wrapper = _findWrapperForAgent(agent);
  if (!wrapper) return;
  _returnWrapperHome();
  _hostAgentWrapper(agent, wrapper);
}

/**
 * Filmstrip: the other sessions of the same project, so you can hop between
 * them without going back to the grid.
 */
function _renderFilmstrip() {
  const strip = document.getElementById('ct-filmstrip');
  if (!strip || !_overlayRestore) return;
  const current = _agents.get(_overlayRestore.agentId);
  if (!current) return;

  const siblings = Array.from(_agents.values()).filter(a =>
    !a.hidden &&
    ((current.projectPath && a.projectPath === current.projectPath) ||
     (!current.projectPath && a.projectName === current.projectName)));

  strip.innerHTML = _sortAgents(siblings).map(a => {
    const color = STATUS_COLORS[a.status] || 'var(--text-muted)';
    const isCurrent = a.id === current.id;
    return `
      <div class="ct-film-card${isCurrent ? ' active' : ''}" data-agent-id="${escapeHtml(a.id)}" role="button" tabindex="0" style="--ct-status-color:${color}">
        <span class="ct-grid-status-dot" style="--status-color:${color}"></span>
        <span class="ct-film-title">${escapeHtml(a.sessionName || a.projectName)}</span>
      </div>
    `;
  }).join('');

  strip.querySelectorAll('.ct-film-card').forEach(card => {
    card.onclick = () => _swapMaximized(card.dataset.agentId);
    card.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _swapMaximized(card.dataset.agentId);
      }
    };
  });
}

/** Inline rename in the focus-view header; shared with the Claude view tabs. */
function _startRenameMaximized() {
  if (!_overlayRestore) return;
  const agent = _agents.get(_overlayRestore.agentId);
  const titleEl = document.getElementById('ct-maximized-title');
  if (!agent || !titleEl || agent.terminalId == null) return;
  if (titleEl.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ct-maximized-title-input';
  input.value = agent.sessionName || '';
  input.placeholder = agent.projectName;
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== agent.sessionName) {
      agent.sessionName = value;
      // Write the shared terminal state first — the scan re-reads names from
      // there — then let TerminalManager update the tab label and persist.
      try {
        const { updateTerminal } = require('../../state/terminals.state');
        updateTerminal(agent.terminalId, { name: value });
      } catch { /* ignore */ }
      try {
        const TerminalManager = require('../components/TerminalManager');
        TerminalManager.updateTerminalTabName(agent.terminalId, value, { custom: true });
      } catch { /* state-only rename still shows in Control Tower */ }
    }
    titleEl.textContent = agent.sessionName || agent.projectName;
    _renderFilmstrip();
    _render();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  };
  input.onblur = () => commit(true);
}

function _onMaximizedKeydown(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    _closeMaximized();
  }
}

/**
 * Return the maximized terminal wrapper to its home container and bring the
 * grid back. Safe to call when nothing is maximized.
 */
function _closeMaximized() {
  document.removeEventListener('keydown', _onMaximizedKeydown);
  _returnWrapperHome();
  const maximized = document.getElementById('ct-maximized');
  if (maximized) maximized.hidden = true;
  _panelRootEl?.classList.remove('ct-maximize-mode');
  _render();
}

/** Keep the maximized header status badge in sync with the agent. */
function _updateMaximizedStatus() {
  if (!_overlayRestore) return;
  const badge = document.getElementById('ct-maximized-status');
  const agent = _agents.get(_overlayRestore.agentId);
  if (!badge || !agent) return;
  const color = STATUS_COLORS[agent.status] || 'var(--text-muted)';
  badge.textContent = (STATUS_LABELS[agent.status] || (() => agent.status))();
  badge.style.setProperty('--status-color', color);
}

/** Opening a session from the Control Tower marks its completion as seen. */
function _markSeen(agent) {
  if (agent && agent.unseenDone) {
    agent.unseenDone = false;
    if (agent.status === 'DONE') agent.status = 'IDLE';
  }
}

function _focusAgent(agentId) {
  const agent = _agents.get(agentId);
  if (!agent) return;
  _markSeen(agent);

  // Switch to Claude tab
  const claudeTab = document.querySelector('[data-tab="claude"]');
  if (claudeTab) claudeTab.click();

  if (agent.terminalId != null) {
    try {
      const TerminalManager = require('../components/TerminalManager');
      // Align the Claude view's project filter with the target session first:
      // filterByProject re-activates the project's last-used tab whenever the
      // current active tab is filtered out, so activating the target BEFORE
      // the filter (or leaving another project's filter on) landed the user
      // on the wrong tab when several terminals were open for the project.
      const project = _getAllProjects().find(p =>
        (agent.projectPath && p.path === agent.projectPath) || p.name === agent.projectName);
      if (project) {
        const { setSelectedProjectFilter } = require('../../state/projects.state');
        const { getProjectIndex } = require('../../state');
        const idx = getProjectIndex(project.id);
        if (idx >= 0) {
          setSelectedProjectFilter(idx);
          TerminalManager.filterByProject(idx);
        }
      }
      TerminalManager.setActiveTerminal(agent.terminalId);
      // The tab click above can trigger deferred view work that re-activates
      // another tab — re-assert the target after it settles.
      requestAnimationFrame(() => {
        try { TerminalManager.setActiveTerminal(agent.terminalId); } catch { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }
}

function _interruptAgent(agentId) {
  const agent = _agents.get(agentId);
  if (!agent) return;

  if (agent.type === 'chat' && agent.chatSessionId) {
    try {
      // FIX: pass { sessionId } object instead of raw string
      window.electron_api.chat.interrupt({ sessionId: agent.chatSessionId });
    } catch { /* ignore */ }
  } else if (agent.terminalId != null) {
    // Send Ctrl+C to the terminal
    try {
      window.electron_api.terminal.input({ id: agent.terminalId, data: '\x03' });
    } catch { /* ignore */ }
  }
}

/**
 * Extract a short human-readable detail from a permission request input.
 * Mirrors ChatView's getToolDisplayInfo but with truncation for compact display.
 */
function _getPermDetail(toolName, input) {
  if (!input) return '';
  const name = (toolName || '').toLowerCase();
  let detail = '';
  if (name === 'bash') detail = input.command || '';
  else if (name === 'read' || name === 'write' || name === 'edit' || name === 'notebookedit') detail = input.file_path || '';
  else if (name === 'grep') detail = input.pattern ? `${input.pattern}${input.path ? ` in ${input.path}` : ''}` : '';
  else if (name === 'glob') detail = input.pattern || '';
  else detail = input.file_path || input.path || input.command || input.query || '';
  // Truncate long values (especially bash commands)
  if (detail.length > 120) detail = detail.slice(0, 117) + '…';
  return detail;
}

/**
 * Respond to a pending permission request (approve or deny).
 */
function _respondPermission(agentId, allow) {
  const agent = _agents.get(agentId);
  if (!agent || !agent.chatSessionId) return;

  const perm = _pendingPermissions.get(agent.chatSessionId);
  if (!perm) return;

  const { requestId } = perm;

  try {
    window.electron_api.chat.respondPermission({
      requestId,
      result: allow
        ? { behavior: 'allow', updatedInput: perm.input }
        : { behavior: 'deny', message: 'Denied from Control Tower' }
    });
  } catch (e) {
    console.error('[ControlTower] Failed to respond to permission:', e);
  }

  // Clear pending permission and revert to THINKING
  _pendingPermissions.delete(agent.chatSessionId);
  agent.status = 'THINKING';
  _render();
}

/**
 * Send a follow-up message to an IDLE chat session.
 */
function _sendChatMessage(agentId, text) {
  if (!text || !text.trim()) return;

  const agent = _agents.get(agentId);
  if (!agent || !agent.chatSessionId) return;

  try {
    window.electron_api.chat.send({ sessionId: agent.chatSessionId, text: text.trim() });
  } catch (e) {
    console.error('[ControlTower] Failed to send chat message:', e);
    return;
  }

  agent.unseenDone = false;
  agent.lastUserAt = Date.now();
  agent.status = 'THINKING';
  agent.currentTool = null;
  _render();
}

/**
 * Send a text reply to an AskUserQuestion permission request.
 */
function _sendReply(agentId, text) {
  if (!text || !text.trim()) return;

  const agent = _agents.get(agentId);
  if (!agent || !agent.chatSessionId) return;

  const perm = _pendingPermissions.get(agent.chatSessionId);
  if (!perm) return;

  try {
    // Match ChatView format: { questions: [...], answers: { "question text": "answer" } }
    const questionsData = perm.input?.questions || [];
    const firstQuestion = questionsData[0]?.question || '';
    const answers = firstQuestion
      ? { [firstQuestion]: text.trim() }
      : { answer: text.trim() };
    window.electron_api.chat.respondPermission({
      requestId: perm.requestId,
      result: {
        behavior: 'allow',
        updatedInput: { questions: questionsData, answers }
      }
    });
    // Notify ChatView so it can collapse the question card with the real answer
    document.dispatchEvent(new CustomEvent('ct-question-answered', {
      detail: { requestId: perm.requestId, questions: questionsData, answers }
    }));
  } catch (e) {
    console.error('[ControlTower] Failed to send reply:', e);
  }

  _pendingPermissions.delete(agent.chatSessionId);
  agent.status = 'THINKING';
  agent.lastUserAt = Date.now();
  _render();
}

// ── Panel lifecycle ──────────────────────────────────────────────────────────

function init(ctx) {
  // ctx not used here but follows panel convention
}

function loadPanel(container) {
  if (!container) return;

  // A maximized wrapper would be destroyed by the innerHTML below — send it home first
  if (_overlayRestore) _closeMaximized();

  container.innerHTML = `
    <div class="ct-panel">
      <!-- Header -->
      <div class="ct-header">
        <div class="ct-header-stats">
          <div class="ct-stat">
            <span class="ct-stat-value" id="ct-active-count">0</span>
            <span class="ct-stat-label">${escapeHtml(t('controlTower.activeAgents'))}</span>
          </div>
          <div class="ct-stat-divider"></div>
          <div class="ct-stat">
            <span class="ct-stat-value" id="ct-total-cost">$0.00</span>
            <span class="ct-stat-label">${escapeHtml(t('controlTower.costToday'))}</span>
          </div>
        </div>
        <button class="ct-spawn-btn" id="ct-spawn-btn" title="${escapeHtml(t('controlTower.spawnTitle'))}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>
          </svg>
          ${escapeHtml(t('controlTower.spawnAgent'))}
        </button>
      </div>

      <!-- Toolbar: view toggle + filters -->
      <div class="ct-toolbar">
        <div class="ct-view-toggle" role="group">
          <button class="ct-view-btn" id="ct-view-list" title="${escapeHtml(t('controlTower.viewList'))}" aria-pressed="${_viewMode === 'list'}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>
            </svg>
          </button>
          <button class="ct-view-btn" id="ct-view-grid" title="${escapeHtml(t('controlTower.viewGrid'))}" aria-pressed="${_viewMode === 'grid'}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>
            </svg>
          </button>
        </div>
        <select class="ct-filter-select" id="ct-filter-project" title="${escapeHtml(t('controlTower.filterAllProjects'))}">
          <option value="all">${escapeHtml(t('controlTower.filterAllProjects'))}</option>
        </select>
        <select class="ct-filter-select" id="ct-filter-status" title="${escapeHtml(t('controlTower.filterAllStatuses'))}">
          <option value="all">${escapeHtml(t('controlTower.filterAllStatuses'))}</option>
          <option value="working">${escapeHtml(t('controlTower.filterWorking'))}</option>
          <option value="waiting">${escapeHtml(t('controlTower.filterWaiting'))}</option>
          <option value="idle">${escapeHtml(t('controlTower.filterIdle'))}</option>
          <option value="done">${escapeHtml(t('controlTower.filterDone'))}</option>
          <option value="error">${escapeHtml(t('controlTower.filterError'))}</option>
        </select>
        <select class="ct-filter-select" id="ct-sort-mode" title="${escapeHtml(t('controlTower.sortRecent'))}">
          <option value="recent">${escapeHtml(t('controlTower.sortRecent'))}</option>
          <option value="oldest">${escapeHtml(t('controlTower.sortOldest'))}</option>
          <option value="project">${escapeHtml(t('controlTower.sortProject'))}</option>
          <option value="status">${escapeHtml(t('controlTower.sortStatus'))}</option>
        </select>
        <input type="text" class="ct-filter-search" id="ct-filter-search" placeholder="${escapeHtml(t('controlTower.searchPlaceholder'))}" />
      </div>

      <!-- Agent cards -->
      <div class="ct-agents-container" id="ct-agents-container"></div>

      <!-- Maximized session (fills the panel; grid hidden while open) -->
      <div class="ct-maximized" id="ct-maximized" hidden>
        <div class="ct-maximized-header">
          <button class="ct-btn ct-maximize-back" id="ct-maximize-back">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
            ${escapeHtml(t('controlTower.backToGrid'))}
          </button>
          <span class="ct-maximized-title" id="ct-maximized-title" title="${escapeHtml(t('controlTower.renameSession'))}"></span>
          <button class="ct-btn" id="ct-maximized-rename" title="${escapeHtml(t('controlTower.renameSession'))}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <span class="ct-status-badge" id="ct-maximized-status"></span>
          <button class="ct-btn" id="ct-maximized-open-claude" title="${escapeHtml(t('controlTower.openInClaude'))}">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1"/></svg>
            ${escapeHtml(t('controlTower.openInClaude'))}
          </button>
        </div>
        <div class="ct-maximized-body">
          <div class="ct-filmstrip" id="ct-filmstrip"></div>
          <div class="ct-overlay-host" id="ct-maximized-host"></div>
        </div>
      </div>
    </div>
  `;

  _panelRootEl = container.querySelector('.ct-panel');

  document.getElementById('ct-spawn-btn').onclick = _openSpawnModal;
  document.getElementById('ct-maximize-back').onclick = _closeMaximized;
  document.getElementById('ct-maximized-rename').onclick = _startRenameMaximized;
  document.getElementById('ct-maximized-title').ondblclick = _startRenameMaximized;
  document.getElementById('ct-maximized-open-claude').onclick = () => {
    const agentId = _overlayRestore?.agentId;
    _closeMaximized();
    if (agentId) _focusAgent(agentId);
  };
  // Safety net: xterm focuses itself when its own area is clicked, but clicks
  // on host padding/gaps would otherwise strand the keyboard outside the
  // hosted session.
  document.getElementById('ct-maximized-host').onmousedown = () => {
    setTimeout(() => {
      if (_overlayRestore && !_hostHasFocus()) _focusHosted(_overlayRestore.termData);
    }, 0);
  };

  // Toolbar wiring — the toolbar lives outside #ct-agents-container so
  // re-renders never rebuild it (keeps focus in the search input).
  const listBtn = document.getElementById('ct-view-list');
  const gridBtn = document.getElementById('ct-view-grid');
  const setViewMode = (mode) => {
    _viewMode = mode;
    try { localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
    listBtn.setAttribute('aria-pressed', String(mode === 'list'));
    gridBtn.setAttribute('aria-pressed', String(mode === 'grid'));
    _render();
  };
  listBtn.onclick = () => setViewMode('list');
  gridBtn.onclick = () => setViewMode('grid');

  const projectSelect = document.getElementById('ct-filter-project');
  projectSelect.onchange = () => { _filterProject = projectSelect.value; _render(); };
  const statusSelect = document.getElementById('ct-filter-status');
  statusSelect.value = _filterStatus;
  statusSelect.onchange = () => { _filterStatus = statusSelect.value; _render(); };
  const sortSelect = document.getElementById('ct-sort-mode');
  sortSelect.value = _sortMode;
  sortSelect.onchange = () => { _sortMode = sortSelect.value; _render(); };
  const searchInput = document.getElementById('ct-filter-search');
  searchInput.value = _filterText;
  searchInput.oninput = () => { _filterText = searchInput.value.trim(); _render(); };

  // Initial render
  _scanTerminals();
  _render();

  // If not already wired, wire events
  if (!_isLoaded) {
    _wireEventBus();
    _wireChatEvents();

    // MCP-triggered interrupt (from control_tower_interrupt MCP tool)
    const api = window.electron_api;
    if (api?.controlTower?.onInterrupt) {
      api.controlTower.onInterrupt(({ projectId }) => {
        for (const [key, agent] of _agents) {
          if (agent.hidden) continue; // per-tab cards handle covered projects
          const agentProjectId = key.startsWith('hooks:') ? key.slice(6) : null;
          const matchesProject = agentProjectId === projectId || agent.projectPath === projectId;
          if (matchesProject && agent.status !== 'DONE' && agent.status !== 'ERROR') {
            _interruptAgent(key);
          }
        }
      });
    }

    _isLoaded = true;
  }

  // Start refresh timer (2s for live timers)
  if (_refreshTimer) clearInterval(_refreshTimer);
  _refreshTimer = setInterval(() => {
    // Defensive self-stop: some tab switches (e.g. SettingsPanel.switchToSettingsTab
    // reached via Ctrl+,) bypass cleanup(). Rather than tick forever against a
    // detached or hidden DOM, the timer cancels itself. loadPanel() runs again on
    // every re-entry into the tab, so it restarts naturally.
    if (!_isPanelLive()) {
      cleanup();
      return;
    }
    // Terminal statuses are polled (no event source) — re-render on change,
    // otherwise just update timers+cost in place for performance
    _scanTerminals().then(changed => { if (changed) _render(); });
    _updateTimers();
    _updateMaximizedStatus();
  }, 2000);
}

/**
 * True while the panel's own DOM is still attached AND rendered.
 * A `display:none` ancestor (how tabs are hidden) yields no client rects and a
 * null offsetParent, so a hidden panel reads as not live.
 */
function _isPanelLive() {
  const el = _panelRootEl;
  if (!el || !el.isConnected) return false;
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

function cleanup() {
  // Never leave a live terminal wrapper stranded in the maximized host
  if (_overlayRestore) _closeMaximized();
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
  _panelRootEl = null;
}

module.exports = { init, loadPanel, cleanup };
