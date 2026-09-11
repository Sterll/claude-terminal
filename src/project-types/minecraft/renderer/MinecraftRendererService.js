/**
 * Minecraft Renderer Service
 * Handles Minecraft server management in the renderer process
 */

const api = window.electron_api;
// Loaded on demand — see src/renderer/services/xtermLoader.js. Requiring the
// emulator here made every startup carry it, including startups that never open
// a Minecraft console.
const { loadXterm } = require('../../../renderer/services/xtermLoader');
const {
  getMinecraftServer,
  setMinecraftServerStatus,
  setMinecraftPlayerCount,
  addMinecraftLog,
  clearMinecraftLogs,
  initMinecraftServer
} = require('./MinecraftState');

// Terminal theme for Minecraft console
const MINECRAFT_TERMINAL_THEME = {
  background: '#0d0d0d',
  foreground: '#d4d4d4',
  cursor: '#22c55e',
  cursorAccent: '#0d0d0d',
  selection: 'rgba(255, 255, 255, 0.2)',
  black: '#1e1e1e',
  red: '#f44747',
  green: '#22c55e',
  yellow: '#d7ba7d',
  blue: '#569cd6',
  magenta: '#c586c0',
  cyan: '#4ec9b0',
  white: '#d4d4d4'
};

// Store terminal instances
const minecraftTerminals = new Map(); // projectIndex -> { terminal, fitAddon }

/**
 * Start a Minecraft server
 * @param {number} projectIndex
 * @returns {Promise<Object>}
 */
async function startMinecraftServer(projectIndex) {
  const { projectsState } = require('../../../renderer/state');
  const project = projectsState.get().projects[projectIndex];
  if (!project) return { success: false, error: 'Project not found' };

  initMinecraftServer(projectIndex);
  setMinecraftServerStatus(projectIndex, 'starting');
  clearMinecraftLogs(projectIndex);

  try {
    const result = await api.minecraft.start({
      projectIndex,
      projectPath: project.path,
      minecraftConfig: project.minecraftConfig || {}
    });

    if (!result.success) {
      setMinecraftServerStatus(projectIndex, 'stopped');
    }

    return result;
  } catch (e) {
    setMinecraftServerStatus(projectIndex, 'stopped');
    return { success: false, error: e.message };
  }
}

/**
 * Stop a Minecraft server
 * @param {number} projectIndex
 * @returns {Promise<Object>}
 */
async function stopMinecraftServer(projectIndex) {
  try {
    const result = await api.minecraft.stop({ projectIndex });
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Create a terminal for Minecraft console
 * @param {number} projectIndex
 * @returns {Object} { terminal, fitAddon }
 */
async function createMinecraftTerminal(projectIndex) {
  const { Terminal, FitAddon } = await loadXterm();
  const terminal = new Terminal({
    theme: MINECRAFT_TERMINAL_THEME,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: false,
    disableStdin: false,
    scrollback: 10000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  // Forward input to server
  terminal.onData(data => {
    api.minecraft.input({ projectIndex, data });
  });

  minecraftTerminals.set(projectIndex, { terminal, fitAddon });
  return { terminal, fitAddon };
}

/**
 * Get or create Minecraft terminal
 * @param {number} projectIndex
 * @returns {Object}
 */
async function getMinecraftTerminal(projectIndex) {
  if (!minecraftTerminals.has(projectIndex)) {
    return createMinecraftTerminal(projectIndex);
  }
  return minecraftTerminals.get(projectIndex);
}

/**
 * Mount Minecraft terminal to DOM
 * @param {number} projectIndex
 * @param {HTMLElement} container
 */
async function mountMinecraftTerminal(projectIndex, container) {
  const { terminal, fitAddon } = await getMinecraftTerminal(projectIndex);

  terminal.open(container);
  fitAddon.fit();

  // Write existing logs
  const server = getMinecraftServer(projectIndex);
  if (server.logs.length > 0) {
    terminal.write(server.logs.join(''));
  }

  // Send size to main process
  api.minecraft.resize({
    projectIndex,
    cols: terminal.cols,
    rows: terminal.rows
  });
}

/**
 * Fit Minecraft terminal
 * @param {number} projectIndex
 */
function fitMinecraftTerminal(projectIndex) {
  const termData = minecraftTerminals.get(projectIndex);
  if (termData) {
    termData.fitAddon.fit();
    api.minecraft.resize({
      projectIndex,
      cols: termData.terminal.cols,
      rows: termData.terminal.rows
    });
  }
}

/**
 * Dispose Minecraft terminal
 * @param {number} projectIndex
 */
function disposeMinecraftTerminal(projectIndex) {
  const termData = minecraftTerminals.get(projectIndex);
  if (termData) {
    termData.terminal.dispose();
    minecraftTerminals.delete(projectIndex);
  }
}

/**
 * Register Minecraft IPC listeners
 * @param {Function} onDataCallback
 * @param {Function} onExitCallback
 */
function registerMinecraftListeners(onDataCallback, onExitCallback) {
  api.minecraft.onData(({ projectIndex, data }) => {
    addMinecraftLog(projectIndex, data);

    const termData = minecraftTerminals.get(projectIndex);
    if (termData) {
      termData.terminal.write(data);
    }

    if (onDataCallback) {
      onDataCallback(projectIndex, data);
    }
  });

  api.minecraft.onExit(({ projectIndex, code }) => {
    setMinecraftServerStatus(projectIndex, 'stopped');
    setMinecraftPlayerCount(projectIndex, 0);

    const termData = minecraftTerminals.get(projectIndex);
    if (termData) {
      termData.terminal.write(`\r\n\x1b[33m[Server stopped with code ${code}]\x1b[0m\r\n`);
    }

    if (onExitCallback) {
      onExitCallback(projectIndex, code);
    }
  });

  api.minecraft.onStatus(({ projectIndex, status }) => {
    setMinecraftServerStatus(projectIndex, status);
  });

  api.minecraft.onPlayerCount(({ projectIndex, count }) => {
    setMinecraftPlayerCount(projectIndex, count);
  });
}

/**
 * Get Minecraft server status
 * @param {number} projectIndex
 * @returns {string}
 */
function getMinecraftServerStatus(projectIndex) {
  return getMinecraftServer(projectIndex).status;
}

/**
 * Check if Minecraft server is running
 * @param {number} projectIndex
 * @returns {boolean}
 */
function isMinecraftServerRunning(projectIndex) {
  return getMinecraftServer(projectIndex).status === 'running';
}

module.exports = {
  startMinecraftServer,
  stopMinecraftServer,
  createMinecraftTerminal,
  getMinecraftTerminal,
  mountMinecraftTerminal,
  fitMinecraftTerminal,
  disposeMinecraftTerminal,
  registerMinecraftListeners,
  getMinecraftServerStatus,
  isMinecraftServerRunning,
  getMinecraftServer,
  clearMinecraftLogs
};
