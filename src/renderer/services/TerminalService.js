/**
 * Terminal Service
 * Handles terminal creation and management in the renderer
 */

// Use preload API instead of direct ipcRenderer
const api = window.electron_api;
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const {
  terminalsState,
  addTerminal,
  removeTerminal,
  setActiveTerminal: setActiveTerminalState,
  getTerminal,
  getActiveTerminal,
  getTerminals,
  countTerminalsForProject
} = require('../state');
const { getSetting } = require('../state');

/**
 * Terminal theme configuration
 */
const TERMINAL_THEME = {
  background: '#0d0d0d',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#0d0d0d',
  selection: 'rgba(255, 255, 255, 0.2)',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#d7ba7d',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4',
  brightBlack: '#808080',
  brightRed: '#f44747',
  brightGreen: '#6a9955',
  brightYellow: '#d7ba7d',
  brightBlue: '#569cd6',
  brightMagenta: '#c586c0',
  brightCyan: '#4ec9b0',
  brightWhite: '#ffffff'
};

/**
 * Create a new terminal
 * @param {Object} project - Project to open terminal for
 * @param {Object} options
 * @param {boolean} options.runClaude - Run Claude CLI on start
 * @returns {Promise<number>} - Terminal ID
 */
async function createTerminal(project, { runClaude = true } = {}) {
  const skipPermissions = getSetting('skipPermissions');
  const projectIndex = require('../state').getProjectIndex(project.id);

  // Telemetry: track terminal creation
  api.telemetry?.sendFeature({ feature: 'terminal:create', metadata: {} });

  // Create terminal on main process
  const id = await api.terminal.create({
    cwd: project.path,
    runClaude,
    skipPermissions
  });

  // Create xterm instance
  const terminal = new Terminal({
    theme: TERMINAL_THEME,
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: true,
    scrollback: 10000,
    allowTransparency: true
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Store terminal data
  addTerminal(id, {
    terminal,
    fitAddon,
    projectIndex,
    projectName: project.name,
    projectPath: project.path,
    title: project.name,
    lastInput: null,
    waitingForUserInput: false
  });

  return id;
}

/**
 * Mount terminal to DOM element
 * @param {number} id - Terminal ID
 * @param {HTMLElement} container - Container element
 */
function mountTerminal(id, container) {
  const termData = getTerminal(id);
  if (!termData) return;

  termData.terminal.open(container);
  termData.fitAddon.fit();

  // Handle terminal input
  termData.terminal.onData(data => {
    api.terminal.input({ id, data });
    termData.lastInput = data;
  });

  // Send initial size
  api.terminal.resize({
    id,
    cols: termData.terminal.cols,
    rows: termData.terminal.rows
  });
}

/**
 * Fit terminal to container
 * @param {number} id - Terminal ID
 */
function fitTerminal(id) {
  const termData = getTerminal(id);
  if (termData) {
    termData.fitAddon.fit();
    api.terminal.resize({
      id,
      cols: termData.terminal.cols,
      rows: termData.terminal.rows
    });
  }
}

/**
 * Kill a terminal
 * @param {number} id - Terminal ID
 */
function killTerminal(id) {
  const termData = getTerminal(id);
  if (termData) {
    termData.terminal.dispose();
    api.terminal.kill({ id });
    removeTerminal(id);
  }
}

/**
 * Set active terminal
 * @param {number} id - Terminal ID
 */
function setActiveTerminal(id) {
  setActiveTerminalState(id);
  // Focus and fit
  const termData = getTerminal(id);
  if (termData) {
    termData.terminal.focus();
    termData.fitAddon.fit();
  }
}

/**
 * Write data to terminal display (from main process)
 * @param {number} id - Terminal ID
 * @param {string} data - Data to write
 */
function writeToTerminal(id, data) {
  const termData = getTerminal(id);
  if (termData) {
    termData.terminal.write(data);
  }
}

/**
 * Handle terminal exit
 * @param {number} id - Terminal ID
 */
function handleTerminalExit(id) {
  removeTerminal(id);
}

/**
 * Register terminal IPC listeners
 * @param {Function} onDataCallback - Callback for terminal data
 * @param {Function} onExitCallback - Callback for terminal exit
 */
function registerTerminalListeners(onDataCallback, onExitCallback) {
  const unsubData = api.terminal.onData(({ id, data }) => {
    writeToTerminal(id, data);
    if (onDataCallback) {
      onDataCallback(id, data);
    }
  });

  const unsubExit = api.terminal.onExit(({ id }) => {
    handleTerminalExit(id);
    if (onExitCallback) {
      onExitCallback(id);
    }
  });

  return () => {
    if (typeof unsubData === 'function') unsubData();
    if (typeof unsubExit === 'function') unsubExit();
  };
}

/**
 * Filter terminals by project
 * @param {number|null} projectIndex
 * @returns {Array}
 */
function filterTerminalsByProject(projectIndex) {
  const results = [];
  const terminals = getTerminals();

  terminals.forEach((term, id) => {
    if (projectIndex === null || term.projectIndex === projectIndex) {
      results.push({ id, ...term });
    }
  });

  return results;
}

/**
 * Get terminal count for a project
 * @param {number} projectIndex
 * @returns {number}
 */
function getTerminalCountForProject(projectIndex) {
  return countTerminalsForProject(projectIndex);
}

module.exports = {
  TERMINAL_THEME,
  createTerminal,
  mountTerminal,
  fitTerminal,
  killTerminal,
  setActiveTerminal,
  writeToTerminal,
  handleTerminalExit,
  registerTerminalListeners,
  filterTerminalsByProject,
  getTerminalCountForProject,
  getTerminal,
  getActiveTerminal,
  getTerminals
};
