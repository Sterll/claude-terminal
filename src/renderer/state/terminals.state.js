/**
 * Terminals State Module
 * Manages terminal instances state
 *
 * Stable tab identifiers:
 * Each terminal entry carries a `tabId` (opaque string `tab_<projectId>_<ts>_<rand>`)
 * that stays stable across mode switches and is the canonical ID used by the
 * MCP orchestration layer. The Map key `id` may be numeric (PTY) or a string
 * (chat) for internal wiring — external consumers should use `tabId`.
 */

const { State } = require('./State');

const ANSI_PATTERN = /\x1B\[[0-9;?]*[A-Za-z]|\x1B\][^\x07]*\x07|\x1B[()][0-9A-Za-z]|\x1B[=>NOPc]/g;

/**
 * Generate a stable tab ID scoped to a project.
 * @param {string} projectId
 * @returns {string}
 */
function generateTabId(projectId) {
  const safeProject = (projectId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'unknown';
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return `tab_${safeProject}_${ts}_${rand}`;
}

/**
 * Strip ANSI escape sequences from a string.
 * @param {string} s
 * @returns {string}
 */
function stripAnsi(s) {
  if (!s) return '';
  return String(s).replace(ANSI_PATTERN, '');
}

// Initial state
const initialState = {
  terminals: new Map(),
  activeTerminal: null,
  detailTerminal: null
};

const terminalsState = new State(initialState);

/**
 * Get all terminals
 * @returns {Map}
 */
function getTerminals() {
  return terminalsState.get().terminals;
}

/**
 * Get a specific terminal
 * @param {number} terminalId
 * @returns {Object|undefined}
 */
function getTerminal(terminalId) {
  return terminalsState.get().terminals.get(terminalId);
}

/**
 * Get active terminal ID
 * @returns {number|null}
 */
function getActiveTerminal() {
  return terminalsState.get().activeTerminal;
}

/**
 * Add a terminal
 * @param {number} id
 * @param {Object} terminalData
 */
function addTerminal(id, terminalData) {
  const terminals = terminalsState.get().terminals;
  terminals.set(id, terminalData);
  terminalsState.set({ terminals, activeTerminal: id });
}

/**
 * Update terminal data
 * @param {number} id
 * @param {Object} updates
 */
function updateTerminal(id, updates) {
  const terminal = getTerminal(id);
  if (terminal) {
    Object.assign(terminal, updates);
    terminalsState.set({ terminals: terminalsState.get().terminals });
  }
}

/**
 * Remove a terminal
 * @param {number} id
 */
function removeTerminal(id) {
  const state = terminalsState.get();
  state.terminals.delete(id);

  let activeTerminal = state.activeTerminal;
  if (activeTerminal === id) {
    // Set to last remaining terminal or null
    const remaining = Array.from(state.terminals.keys());
    activeTerminal = remaining.length > 0 ? remaining[remaining.length - 1] : null;
  }

  terminalsState.set({ terminals: state.terminals, activeTerminal });
}

/**
 * Set active terminal
 * @param {number|null} terminalId
 */
function setActiveTerminal(terminalId) {
  terminalsState.setProp('activeTerminal', terminalId);
}

/**
 * Set detail terminal (for FiveM console in detail view)
 * @param {Object|null} terminal
 */
function setDetailTerminal(terminal) {
  terminalsState.setProp('detailTerminal', terminal);
}

/**
 * Get detail terminal
 * @returns {Object|null}
 */
function getDetailTerminal() {
  return terminalsState.get().detailTerminal;
}

/**
 * Count terminals for a specific project
 * @param {number} projectIndex
 * @returns {number}
 */
function countTerminalsForProject(projectIndex) {
  let count = 0;
  const terminals = terminalsState.get().terminals;
  terminals.forEach(term => {
    if (term.projectIndex === projectIndex) count++;
  });
  return count;
}

/**
 * Get terminal stats for a specific project (total and working count)
 * @param {number} projectIndex
 * @returns {{ total: number, working: number }}
 */
function getTerminalStatsForProject(projectIndex) {
  let total = 0;
  let working = 0;
  const terminals = terminalsState.get().terminals;
  terminals.forEach(term => {
    if (term.projectIndex === projectIndex && term.type !== 'fivem' && term.type !== 'webapp' && !term.isBasic) {
      total++;
      if (term.status === 'working') working++;
    }
  });
  return { total, working };
}

/**
 * Find a terminal entry by its stable tabId.
 * @param {string} tabId
 * @returns {{ id: any, data: Object } | null}
 */
function getTerminalByTabId(tabId) {
  if (!tabId) return null;
  const terminals = terminalsState.get().terminals;
  for (const [id, data] of terminals) {
    if (data && data.tabId === tabId) return { id, data };
  }
  return null;
}

/**
 * Update a terminal entry keyed by tabId.
 * @param {string} tabId
 * @param {Object} updates
 * @returns {boolean} Whether the update was applied.
 */
function updateTerminalByTabId(tabId, updates) {
  const found = getTerminalByTabId(tabId);
  if (!found) return false;
  Object.assign(found.data, updates);
  terminalsState.set({ terminals: terminalsState.get().terminals });
  return true;
}

/**
 * Touch the `lastActivityAt` field of a terminal entry.
 * Safe no-op if the terminal is not found.
 * @param {any} idOrTabId Internal id or tabId.
 */
function touchTerminalActivity(idOrTabId) {
  const now = new Date().toISOString();
  const byId = terminalsState.get().terminals.get(idOrTabId);
  if (byId) {
    byId.lastActivityAt = now;
    terminalsState.set({ terminals: terminalsState.get().terminals });
    return;
  }
  const byTab = getTerminalByTabId(idOrTabId);
  if (byTab) {
    byTab.data.lastActivityAt = now;
    terminalsState.set({ terminals: terminalsState.get().terminals });
  }
}

/**
 * Derive the high-level MCP status for a terminal entry.
 * Returns one of: idle | running | awaiting_permission | awaiting_input | error | done.
 * @param {Object|undefined} td Terminal entry data.
 * @returns {string}
 */
function deriveTabStatus(td) {
  if (!td) return 'done';
  if (td.pendingPermission) return 'awaiting_permission';
  if (td.status === 'error') return 'error';
  if (td.status === 'loading') return 'running';

  if (td.mode === 'chat') {
    if (td.status === 'working') return 'running';
    return 'idle';
  }

  if (td.status === 'working') return 'running';
  return 'idle';
}

/**
 * Append a line to the in-memory output ring buffer for a terminal.
 * Stores stripped (no ANSI) content with a timestamp cursor.
 * Caps at `maxBytes` (default 500KB) by dropping oldest chunks.
 * @param {Object} td Terminal entry data.
 * @param {string} chunk
 * @param {number} maxBytes
 */
function appendTerminalOutput(td, chunk, maxBytes = 500 * 1024) {
  if (!td || !chunk) return;
  const clean = stripAnsi(chunk);
  if (!clean) return;

  if (!Array.isArray(td.outputBuffer)) td.outputBuffer = [];
  if (typeof td.outputBufferSize !== 'number') td.outputBufferSize = 0;
  if (typeof td.outputCursor !== 'number') td.outputCursor = 0;

  const cursor = td.outputCursor + 1;
  td.outputCursor = cursor;
  const entry = { cursor, ts: Date.now(), text: clean };
  td.outputBuffer.push(entry);
  td.outputBufferSize += clean.length;

  while (td.outputBufferSize > maxBytes && td.outputBuffer.length > 1) {
    const dropped = td.outputBuffer.shift();
    td.outputBufferSize -= (dropped.text || '').length;
  }
}

/**
 * Append a structured chat message to the in-memory log of a terminal.
 * @param {Object} td Terminal entry data.
 * @param {{ role: string, content: string, tokensUsed?: number }} msg
 */
function appendChatMessage(td, msg) {
  if (!td || !msg) return;
  if (!Array.isArray(td.chatMessages)) td.chatMessages = [];
  const cursor = (td.outputCursor || 0) + 1;
  td.outputCursor = cursor;
  td.chatMessages.push({
    cursor,
    ts: Date.now(),
    role: msg.role || 'assistant',
    content: typeof msg.content === 'string' ? msg.content : String(msg.content ?? ''),
    ...(typeof msg.tokensUsed === 'number' ? { tokensUsed: msg.tokensUsed } : {}),
  });
}

/**
 * Get terminals for a specific project
 * @param {number} projectIndex
 * @returns {Array}
 */
function getTerminalsForProject(projectIndex) {
  const results = [];
  const terminals = terminalsState.get().terminals;
  terminals.forEach((term, id) => {
    if (term.projectIndex === projectIndex) {
      results.push({ id, ...term });
    }
  });
  return results;
}

/**
 * Kill all terminals for a project
 * @param {number} projectIndex
 * @param {Function} killCallback - Function to call for each terminal to kill
 */
function killTerminalsForProject(projectIndex, killCallback) {
  const terminals = terminalsState.get().terminals;
  terminals.forEach((term, id) => {
    if (term.projectIndex === projectIndex) {
      if (killCallback) killCallback(id);
      removeTerminal(id);
    }
  });
}

/**
 * Clear all terminals
 * @param {Function} killCallback - Function to call for each terminal to kill
 */
function clearAllTerminals(killCallback) {
  const terminals = terminalsState.get().terminals;
  terminals.forEach((term, id) => {
    if (killCallback) killCallback(id);
  });
  terminalsState.set({
    terminals: new Map(),
    activeTerminal: null
  });
}

module.exports = {
  terminalsState,
  getTerminals,
  getTerminal,
  getActiveTerminal,
  addTerminal,
  updateTerminal,
  removeTerminal,
  setActiveTerminal,
  setDetailTerminal,
  getDetailTerminal,
  countTerminalsForProject,
  getTerminalStatsForProject,
  getTerminalsForProject,
  killTerminalsForProject,
  clearAllTerminals,
  // MCP tab orchestration helpers
  generateTabId,
  stripAnsi,
  getTerminalByTabId,
  updateTerminalByTabId,
  touchTerminalActivity,
  deriveTabStatus,
  appendTerminalOutput,
  appendChatMessage,
};
