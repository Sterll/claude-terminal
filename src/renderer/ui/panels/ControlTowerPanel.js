/**
 * ControlTowerPanel
 * Real-time overview of all running Claude chats across all projects and worktrees.
 * Wires into eventBus (terminal hooks) + chat IPC events + terminalsState.
 */

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');

// ── Internal state ──────────────────────────────────────────────────────────

/** @type {Map<string, AgentInfo>} */
const _agents = new Map();

let _refreshTimer = null;
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

function _getProjectBranch(projectPath) {
  try {
    const { fs } = window.electron_nodeModules;
    const path = window.electron_nodeModules.path;
    const headFile = path.join(projectPath, '.git', 'HEAD');
    if (!fs.existsSync(headFile)) return null;
    const content = fs.readFileSync(headFile, 'utf8').trim();
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
  _agents.forEach(a => { total += (a.cost || 0); });
  // Also count past-session costs accumulated this run
  _sessionCosts.forEach((cost, key) => {
    if (!_agents.has(key)) total += (cost || 0);
  });
  return total;
}

function _activeAgentCount() {
  let count = 0;
  _agents.forEach(a => { if (a.status !== 'DONE' && a.status !== 'ERROR') count++; });
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
    eventBus.on(EVENT_TYPES.SESSION_START, (e) => {
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
          branch: _getProjectBranch(project.path),
          status: 'THINKING',
          currentTool: null,
          currentFile: null,
          startTime: e.timestamp || Date.now(),
          cost: 0,
          totalTokens: 0,
          terminalId,
          chatSessionId: null
        });
      } else {
        const a = _agents.get(key);
        a.status = 'THINKING';
        a.terminalId = terminalId || a.terminalId;
      }
      _render();
    }),

    eventBus.on(EVENT_TYPES.TOOL_START, (e) => {
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
          branch: _getProjectBranch(project.path),
          status: 'RUNNING_TOOL',
          currentTool: e.data?.toolName || null,
          currentFile: _extractFile(e.data?.input),
          startTime: e.timestamp || Date.now(),
          cost: 0,
          totalTokens: 0,
          terminalId: _findTerminalForProject(e.projectId),
          chatSessionId: null
        });
      } else {
        const a = _agents.get(key);
        a.status = 'RUNNING_TOOL';
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
        _render();
      }
    }),

    eventBus.on(EVENT_TYPES.TOOL_ERROR, (e) => {
      if (!e.projectId) return;
      const key = `hooks:${e.projectId}`;
      const a = _agents.get(key);
      if (a) {
        a.status = 'ERROR';
        _render();
      }
    }),

    eventBus.on(EVENT_TYPES.CLAUDE_DONE, (e) => {
      if (!e.projectId) return;
      const key = `hooks:${e.projectId}`;
      const a = _agents.get(key);
      if (a) {
        a.status = 'IDLE';
        _render();
      }
    }),

    eventBus.on(EVENT_TYPES.CLAUDE_WORKING, (e) => {
      if (!e.projectId) return;
      const key = `hooks:${e.projectId}`;
      const a = _agents.get(key);
      if (a && a.status === 'IDLE') {
        a.status = 'THINKING';
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
        chatSessionId: sessionId
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

    // Reset to THINKING only when the USER sends a new message (not for result/assistant replies)
    if (a.status === 'IDLE' && message.type === 'user') {
      a.status = 'THINKING';
      a.currentTool = null;
      a.currentFile = null;
    }

    // Update cost and tokens from result messages — and mark IDLE (turn complete)
    if (message.type === 'result') {
      if (message.total_cost_usd != null) a.cost = message.total_cost_usd;
      if (message.usage) {
        a.totalTokens = (message.usage.input_tokens || 0) + (message.usage.output_tokens || 0);
      }
      a.status = 'IDLE';
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
      a.status = 'IDLE';
      _render();
    }
  });

  _chatDoneUnlistener = api.chat.onDone(({ sessionId, aborted }) => {
    const key = `chat:${sessionId}`;
    const a = _agents.get(key);
    if (a) {
      _sessionCosts.set(key, (_sessionCosts.get(key) || 0) + (a.cost || 0));
      a.status = aborted ? 'ERROR' : 'DONE';
      _pendingPermissions.delete(sessionId);
      _render();
      setTimeout(() => {
        _agents.delete(key);
        _lastResponses.delete(sessionId);
        _expandedResponses.delete(key);
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

function _scanTerminals() {
  try {
    const { terminalsState } = require('../../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    terminals.forEach((td, id) => {
      // Only track Claude terminals (not basic, not fivem/webapp)
      if (td.isBasic || td.type === 'fivem' || td.type === 'webapp') return;

      // Chat mode sessions are tracked via IPC events
      if (td.mode === 'chat') return;

      // Hooks already tracks this project — skip to avoid duplicate
      if (td.project?.id && _agents.has(`hooks:${td.project.id}`)) return;

      const key = `terminal:${id}`;
      console.log('[CT] scanTerminals → key:', key, 'status:', td.status);
      if (!_agents.has(key)) {
        const status = td.status === 'working' ? 'THINKING' : 'IDLE';
        _agents.set(key, {
          id: key,
          type: 'terminal',
          projectName: td.projectName || td.project?.name || 'Unknown',
          projectPath: td.projectPath || td.project?.path || '',
          branch: td.projectPath ? _getProjectBranch(td.projectPath) : null,
          status,
          currentTool: null,
          currentFile: null,
          startTime: td.createdAt || Date.now(),
          cost: 0,
          totalTokens: 0,
          terminalId: id,
          chatSessionId: null
        });
      } else {
        // Update status from terminal state
        const a = _agents.get(key);
        if (a.status !== 'DONE' && a.status !== 'ERROR') {
          if (td.status === 'working') {
            if (a.status === 'IDLE') a.status = 'THINKING';
          } else {
            if (a.status === 'THINKING') a.status = 'IDLE';
          }
        }
        // Update terminalId if it changed
        a.terminalId = id;
      }
    });

    // Remove terminal agents for terminals that no longer exist
    for (const [key, a] of _agents) {
      if (a.type === 'terminal' && key.startsWith('terminal:')) {
        const termId = parseInt(key.split(':')[1], 10);
        if (!terminals.has(termId)) {
          _agents.delete(key);
        }
      }
    }
  } catch { /* ignore */ }
}

// ── Spawn agent modal ────────────────────────────────────────────────────────

function _openSpawnModal() {
  const projects = _getAllProjects();
  if (projects.length === 0) {
    alert(t('controlTower.noProjectsToSpawn'));
    return;
  }

  // Build a simple project picker modal
  const listHtml = projects.map((p, i) =>
    `<div class="ct-spawn-project" data-idx="${i}" style="padding:8px 12px;cursor:pointer;border-radius:6px;display:flex;align-items:center;gap:10px;transition:background 0.15s">
      <div style="width:8px;height:8px;border-radius:50%;background:${p.color || 'var(--accent)'};flex-shrink:0"></div>
      <div>
        <div style="font-size:var(--font-sm);color:var(--text-primary);font-weight:500">${escapeHtml(p.name)}</div>
        <div style="font-size:var(--font-xs);color:var(--text-muted)">${escapeHtml(p.path || '')}</div>
      </div>
    </div>`
  ).join('');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:var(--radius);width:420px;max-height:520px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border-color);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:var(--font-md);font-weight:600;color:var(--text-primary)">${escapeHtml(t('controlTower.spawnTitle'))}</span>
        <button id="ct-spawn-close" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;padding:4px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div style="overflow-y:auto;padding:8px" id="ct-spawn-list">${listHtml}</div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#ct-spawn-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.querySelectorAll('.ct-spawn-project').forEach(el => {
    el.onmouseenter = () => { el.style.background = 'var(--bg-hover)'; };
    el.onmouseleave = () => { el.style.background = ''; };
    el.onclick = () => {
      const idx = parseInt(el.dataset.idx, 10);
      const project = projects[idx];
      overlay.remove();
      _spawnTerminalForProject(project);
    };
  });
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

function _render() {
  const container = document.getElementById('ct-agents-container');
  if (!container) return;

  // Sync terminal state before rendering
  _scanTerminals();

  const agents = Array.from(_agents.values());
  const active = agents.filter(a => a.status !== 'DONE' && a.status !== 'ERROR');
  const done = agents.filter(a => a.status === 'DONE' || a.status === 'ERROR');

  // Update header counters
  const countEl = document.getElementById('ct-active-count');
  const costEl = document.getElementById('ct-total-cost');
  if (countEl) countEl.textContent = _activeAgentCount();
  if (costEl) costEl.textContent = _formatCost(_totalActiveCost());

  if (agents.length === 0) {
    container.innerHTML = _buildEmptyState();
    return;
  }

  // Render active first, then done/error
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
}

// ── Agent actions ────────────────────────────────────────────────────────────

function _focusAgent(agentId) {
  const agent = _agents.get(agentId);
  if (!agent) return;

  // Switch to Claude tab
  const claudeTab = document.querySelector('[data-tab="claude"]');
  if (claudeTab) claudeTab.click();

  if (agent.terminalId != null) {
    try {
      const TerminalManager = require('../components/TerminalManager');
      TerminalManager.setActiveTerminal(agent.terminalId);
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
  _render();
}

// ── Panel lifecycle ──────────────────────────────────────────────────────────

function init(ctx) {
  // ctx not used here but follows panel convention
}

function loadPanel(container) {
  if (!container) return;

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

      <!-- Agent cards -->
      <div class="ct-agents-container" id="ct-agents-container"></div>
    </div>
  `;

  document.getElementById('ct-spawn-btn').onclick = _openSpawnModal;

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
    _scanTerminals();
    _updateTimers();
    // Full re-render only if a status change happened (handled by event bus)
    // Just update timers+cost every tick for performance
  }, 2000);
}

function cleanup() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

module.exports = { init, loadPanel, cleanup };
