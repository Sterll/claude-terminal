/**
 * MCP State Module
 * Manages MCP (Model Context Protocol) servers state
 */

const { State } = require('./State');

// Initial state
const initialState = {
  mcps: [],
  mcpProcesses: {}, // Map id -> { status, logs[] }
  selectedMcp: null,
  mcpLogsCollapsed: false
};

const mcpState = new State(initialState);

/**
 * Get all MCPs
 * @returns {Array}
 */
function getMcps() {
  return mcpState.get().mcps;
}

/**
 * Get MCP by ID
 * @param {string} id
 * @returns {Object|undefined}
 */
function getMcp(id) {
  return mcpState.get().mcps.find(m => m.id === id);
}

/**
 * Set MCPs list
 * @param {Array} mcps
 */
function setMcps(mcps) {
  mcpState.setProp('mcps', mcps);
}

/**
 * Add an MCP
 * @param {Object} mcp
 */
function addMcp(mcp) {
  const mcps = [...mcpState.get().mcps, mcp];
  mcpState.setProp('mcps', mcps);
}

/**
 * Update an MCP
 * @param {string} id
 * @param {Object} updates
 */
function updateMcp(id, updates) {
  const mcps = mcpState.get().mcps.map(m =>
    m.id === id ? { ...m, ...updates } : m
  );
  mcpState.setProp('mcps', mcps);
}

/**
 * Remove an MCP
 * @param {string} id
 */
function removeMcp(id) {
  const state = mcpState.get();
  const mcps = state.mcps.filter(m => m.id !== id);
  const mcpProcesses = { ...state.mcpProcesses };
  delete mcpProcesses[id];

  let selectedMcp = state.selectedMcp;
  if (selectedMcp === id) {
    selectedMcp = null;
  }

  mcpState.set({ mcps, mcpProcesses, selectedMcp });
}

/**
 * Get MCP process state
 * @param {string} id
 * @returns {Object}
 */
function getMcpProcess(id) {
  return mcpState.get().mcpProcesses[id] || { status: 'stopped', logs: [] };
}

/**
 * Set MCP process status
 * @param {string} id
 * @param {string} status - 'stopped', 'starting', 'running', 'error'
 */
function setMcpProcessStatus(id, status) {
  const mcpProcesses = { ...mcpState.get().mcpProcesses };
  if (!mcpProcesses[id]) {
    mcpProcesses[id] = { status, logs: [] };
  } else {
    mcpProcesses[id] = { ...mcpProcesses[id], status };
  }
  mcpState.setProp('mcpProcesses', mcpProcesses);
}

/**
 * Add log entry to MCP process
 * @param {string} id
 * @param {string} type - 'stdout', 'stderr', 'info'
 * @param {string} message
 */
function addMcpLog(id, type, message) {
  const mcpProcesses = mcpState.get().mcpProcesses;
  if (!mcpProcesses[id]) {
    mcpProcesses[id] = { status: 'stopped', logs: [] };
  }

  const proc = mcpProcesses[id];
  proc.logs.push({ type, message, timestamp: Date.now() });

  // Keep last 1000 log entries
  if (proc.logs.length > 1000) {
    proc.logs.splice(0, proc.logs.length - 1000);
  }

  // Notify subscribers (uses rAF batching from State base class)
  mcpState._notify();
}

/**
 * Clear MCP logs
 * @param {string} id
 */
function clearMcpLogs(id) {
  const mcpProcesses = { ...mcpState.get().mcpProcesses };
  if (mcpProcesses[id]) {
    mcpProcesses[id] = { ...mcpProcesses[id], logs: [] };
    mcpState.setProp('mcpProcesses', mcpProcesses);
  }
}

/**
 * Get selected MCP ID
 * @returns {string|null}
 */
function getSelectedMcp() {
  return mcpState.get().selectedMcp;
}

/**
 * Set selected MCP
 * @param {string|null} id
 */
function setSelectedMcp(id) {
  mcpState.setProp('selectedMcp', id);
}

/**
 * Get logs collapsed state
 * @returns {boolean}
 */
function isMcpLogsCollapsed() {
  return mcpState.get().mcpLogsCollapsed;
}

/**
 * Toggle logs collapsed state
 */
function toggleMcpLogsCollapsed() {
  mcpState.setProp('mcpLogsCollapsed', !mcpState.get().mcpLogsCollapsed);
}

/**
 * Initialize MCP process tracking
 * @param {string} id
 */
function initMcpProcess(id) {
  const mcpProcesses = { ...mcpState.get().mcpProcesses };
  if (!mcpProcesses[id]) {
    mcpProcesses[id] = { status: 'stopped', logs: [] };
    mcpState.setProp('mcpProcesses', mcpProcesses);
  }
}

module.exports = {
  mcpState,
  getMcps,
  getMcp,
  setMcps,
  addMcp,
  updateMcp,
  removeMcp,
  getMcpProcess,
  setMcpProcessStatus,
  addMcpLog,
  clearMcpLogs,
  getSelectedMcp,
  setSelectedMcp,
  isMcpLogsCollapsed,
  toggleMcpLogsCollapsed,
  initMcpProcess
};
