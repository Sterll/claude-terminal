/**
 * Terminals State Module
 * Manages terminal instances state
 */

const { State } = require('./State');

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
  clearAllTerminals
};
