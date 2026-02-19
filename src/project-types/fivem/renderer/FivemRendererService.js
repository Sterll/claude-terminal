/**
 * FiveM Service
 * Handles FiveM server management in the renderer
 */

// Use preload API instead of direct ipcRenderer
const api = window.electron_api;
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const {
  getFivemServer,
  setFivemServerStatus,
  addFivemLog,
  clearFivemLogs,
  initFivemServer,
  getProject,
  getProjectIndex,
  containsFivemError,
  addFivemError,
  getFivemErrors,
  clearFivemErrors
} = require('../../../renderer/state');

// Buffer for capturing complete lines (last N lines per project)
const logBuffers = new Map(); // projectIndex -> string[]
const LOG_BUFFER_SIZE = 50; // Keep last 50 lines for context

// Line accumulator for incomplete lines (data arrives in chunks)
const lineAccumulators = new Map(); // projectIndex -> string (partial line being built)

// Error collection state - waits for complete error with stack trace
const errorStates = new Map(); // projectIndex -> { collecting: boolean, lines: [], timeout: null, lastErrorHash: string }

// Time to wait for more error lines before finalizing
const ERROR_COLLECT_TIMEOUT = 500; // ms

// Terminal theme for FiveM console
const FIVEM_TERMINAL_THEME = {
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
  white: '#d4d4d4'
};

// Store terminal instances for FiveM consoles
const fivemTerminals = new Map();

/**
 * Start a FiveM server
 * @param {number} projectIndex
 * @returns {Promise<Object>}
 */
async function startFivemServer(projectIndex) {
  const { projectsState } = require('../../../renderer/state');
  const project = projectsState.get().projects[projectIndex];
  if (!project) return { success: false, error: 'Project not found' };

  // Dispose any existing terminal so xterm starts fresh on restart
  disposeFivemTerminal(projectIndex);

  initFivemServer(projectIndex);
  clearFivemErrors(projectIndex);
  setFivemServerStatus(projectIndex, 'starting');

  try {
    const result = await api.fivem.start({
      projectIndex,
      projectPath: project.path,
      runCommand: project.runCommand
    });

    if (result.success) {
      setFivemServerStatus(projectIndex, 'running');
    } else {
      setFivemServerStatus(projectIndex, 'stopped');
    }

    return result;
  } catch (e) {
    setFivemServerStatus(projectIndex, 'stopped');
    return { success: false, error: e.message };
  }
}

/**
 * Stop a FiveM server
 * @param {number} projectIndex
 * @returns {Promise<Object>}
 */
async function stopFivemServer(projectIndex) {
  try {
    const result = await api.fivem.stop({ projectIndex });
    setFivemServerStatus(projectIndex, 'stopped');
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Create a terminal for FiveM console
 * @param {number} projectIndex
 * @returns {Object} - Terminal and fitAddon
 */
function createFivemTerminal(projectIndex) {
  const terminal = new Terminal({
    theme: FIVEM_TERMINAL_THEME,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: false,
    disableStdin: false,
    scrollback: 10000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Handle input to FiveM console
  terminal.onData(data => {
    api.fivem.input({ projectIndex, data });
  });

  fivemTerminals.set(projectIndex, { terminal, fitAddon });

  return { terminal, fitAddon };
}

/**
 * Get or create FiveM terminal
 * @param {number} projectIndex
 * @returns {Object}
 */
function getFivemTerminal(projectIndex) {
  if (!fivemTerminals.has(projectIndex)) {
    return createFivemTerminal(projectIndex);
  }
  return fivemTerminals.get(projectIndex);
}

/**
 * Mount FiveM terminal to DOM
 * @param {number} projectIndex
 * @param {HTMLElement} container
 */
function mountFivemTerminal(projectIndex, container) {
  const { terminal, fitAddon } = getFivemTerminal(projectIndex);

  terminal.open(container);
  fitAddon.fit();

  // Send size
  api.fivem.resize({
    projectIndex,
    cols: terminal.cols,
    rows: terminal.rows
  });
}

/**
 * Fit FiveM terminal
 * @param {number} projectIndex
 */
function fitFivemTerminal(projectIndex) {
  const termData = fivemTerminals.get(projectIndex);
  if (termData) {
    termData.fitAddon.fit();
    api.fivem.resize({
      projectIndex,
      cols: termData.terminal.cols,
      rows: termData.terminal.rows
    });
  }
}

/**
 * Dispose FiveM terminal
 * @param {number} projectIndex
 */
function disposeFivemTerminal(projectIndex) {
  const termData = fivemTerminals.get(projectIndex);
  if (termData) {
    termData.terminal.dispose();
    fivemTerminals.delete(projectIndex);
  }
}

/**
 * Process incoming data into complete lines
 * @param {number} projectIndex
 * @param {string} data
 * @returns {string[]} Complete lines
 */
function processDataToLines(projectIndex, data) {
  // Get or create accumulator for partial lines
  let partial = lineAccumulators.get(projectIndex) || '';
  partial += data;

  // Split by newlines, keeping track of incomplete last line
  const parts = partial.split(/\r?\n/);

  // Last part might be incomplete (no newline at end)
  const incompleteLine = parts.pop() || '';
  lineAccumulators.set(projectIndex, incompleteLine);

  // Return complete lines (non-empty)
  return parts.filter(line => line.trim());
}

/**
 * Add complete lines to log buffer
 * @param {number} projectIndex
 * @param {string[]} lines
 */
function addLinesToBuffer(projectIndex, lines) {
  if (!logBuffers.has(projectIndex)) {
    logBuffers.set(projectIndex, []);
  }
  const buffer = logBuffers.get(projectIndex);
  buffer.push(...lines);

  // Keep only last N lines
  while (buffer.length > LOG_BUFFER_SIZE) {
    buffer.shift();
  }
}

/**
 * Get context from log buffer
 * @param {number} projectIndex
 * @returns {string}
 */
function getLogContext(projectIndex) {
  const buffer = logBuffers.get(projectIndex) || [];
  return buffer.join('\n');
}

/**
 * Clean ANSI codes from text
 * @param {string} text
 * @returns {string}
 */
function cleanAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Check if a line looks like part of an error/stack trace
 * @param {string} line
 * @returns {boolean}
 */
function isErrorRelatedLine(line) {
  const clean = cleanAnsi(line);
  return /SCRIPT ERROR:|Error loading|Error running|\[ERROR\]|FATAL ERROR|stack traceback:|attempt to|bad argument|module .* not found|syntax error|unexpected symbol|^\s*@|^\s*\d+:|^\s*in function|^\s*\.\.\.$/i.test(clean);
}

/**
 * Simple hash for deduplication
 * @param {string} str
 * @returns {string}
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Process lines for error detection
 * @param {number} projectIndex
 * @param {string[]} lines
 * @param {Function} onErrorCallback
 */
function processLinesForErrors(projectIndex, lines, onErrorCallback) {
  if (!errorStates.has(projectIndex)) {
    errorStates.set(projectIndex, {
      collecting: false,
      lines: [],
      timeout: null,
      lastErrorHash: ''
    });
  }

  const state = errorStates.get(projectIndex);

  for (const line of lines) {
    const clean = cleanAnsi(line);

    // Check if this starts a new error
    if (/SCRIPT ERROR:|Error loading|Error running|\[ERROR\]|FATAL ERROR/i.test(clean)) {
      // If we were collecting, finalize the previous error first
      if (state.collecting && state.lines.length > 0) {
        finalizeError(projectIndex, onErrorCallback);
      }

      // Start collecting new error
      state.collecting = true;
      state.lines = [clean];

      // Reset timeout
      if (state.timeout) clearTimeout(state.timeout);
      state.timeout = setTimeout(() => finalizeError(projectIndex, onErrorCallback), ERROR_COLLECT_TIMEOUT);
    }
    // If we're collecting, add related lines
    else if (state.collecting) {
      if (isErrorRelatedLine(line) || state.lines.length < 20) {
        state.lines.push(clean);
        // Extend timeout
        if (state.timeout) clearTimeout(state.timeout);
        state.timeout = setTimeout(() => finalizeError(projectIndex, onErrorCallback), ERROR_COLLECT_TIMEOUT);
      } else {
        // Non-error line, finalize
        finalizeError(projectIndex, onErrorCallback);
      }
    }
  }
}

/**
 * Finalize collected error and emit it
 * @param {number} projectIndex
 * @param {Function} onErrorCallback
 */
function finalizeError(projectIndex, onErrorCallback) {
  const state = errorStates.get(projectIndex);
  if (!state || !state.collecting || state.lines.length === 0) return;

  // Clear timeout
  if (state.timeout) {
    clearTimeout(state.timeout);
    state.timeout = null;
  }

  // Build error message
  const errorMessage = state.lines.join('\n');

  // Check for duplicate (same error within short time)
  const hash = simpleHash(errorMessage.substring(0, 200));
  if (hash === state.lastErrorHash) {
    state.collecting = false;
    state.lines = [];
    return;
  }
  state.lastErrorHash = hash;

  // Get context (lines before the error)
  const context = getLogContext(projectIndex);

  // Add error to state
  const error = addFivemError(projectIndex, errorMessage, context);

  // Callback
  if (onErrorCallback) {
    onErrorCallback(projectIndex, error);
  }

  // Reset state
  state.collecting = false;
  state.lines = [];
}

// Store error callback for use in processLinesForErrors
let globalErrorCallback = null;

/**
 * Register FiveM IPC listeners
 * @param {Function} onDataCallback - Callback for FiveM data
 * @param {Function} onExitCallback - Callback for FiveM exit
 * @param {Function} onErrorCallback - Callback when error is detected
 */
function registerFivemListeners(onDataCallback, onExitCallback, onErrorCallback) {
  globalErrorCallback = onErrorCallback;

  api.fivem.onData(({ projectIndex, data }) => {
    addFivemLog(projectIndex, data);

    // Write to terminal if exists
    const termData = fivemTerminals.get(projectIndex);
    if (termData) {
      termData.terminal.write(data);
    }

    // Process data into complete lines
    const completeLines = processDataToLines(projectIndex, data);

    // Add complete lines to buffer
    if (completeLines.length > 0) {
      addLinesToBuffer(projectIndex, completeLines);

      // Process lines for error detection
      processLinesForErrors(projectIndex, completeLines, onErrorCallback);
    }

    if (onDataCallback) {
      onDataCallback(projectIndex, data);
    }
  });

  api.fivem.onExit(({ projectIndex, code }) => {
    setFivemServerStatus(projectIndex, 'stopped');

    // Finalize any pending error
    const state = errorStates.get(projectIndex);
    if (state && state.collecting) {
      finalizeError(projectIndex, onErrorCallback);
    }

    // Clear buffers on exit
    logBuffers.delete(projectIndex);
    lineAccumulators.delete(projectIndex);
    errorStates.delete(projectIndex);

    const termData = fivemTerminals.get(projectIndex);
    if (termData) {
      termData.terminal.write(`\r\n[Server exited with code ${code}]\r\n`);
    }

    // Dispose the terminal so it's recreated fresh on next start
    disposeFivemTerminal(projectIndex);

    if (onExitCallback) {
      onExitCallback(projectIndex, code);
    }
  });
}

/**
 * Get FiveM server status
 * @param {number} projectIndex
 * @returns {string}
 */
function getFivemServerStatus(projectIndex) {
  return getFivemServer(projectIndex).status;
}

/**
 * Check if FiveM server is running
 * @param {number} projectIndex
 * @returns {boolean}
 */
function isFivemServerRunning(projectIndex) {
  return getFivemServer(projectIndex).status === 'running';
}

module.exports = {
  startFivemServer,
  stopFivemServer,
  createFivemTerminal,
  getFivemTerminal,
  mountFivemTerminal,
  fitFivemTerminal,
  disposeFivemTerminal,
  registerFivemListeners,
  getFivemServerStatus,
  isFivemServerRunning,
  getFivemServer,
  clearFivemLogs,
  getFivemErrors
};
