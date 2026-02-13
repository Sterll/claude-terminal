/**
 * API Renderer Service
 * Handles API server management in the renderer
 */

const api = window.electron_api;
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const {
  getApiServer,
  setApiServerStatus,
  setApiPort,
  addApiLog,
  clearApiLogs,
  initApiServer
} = require('./ApiState');

const API_TERMINAL_THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#c9d1d9',
  cursorAccent: '#0d1117',
  selection: 'rgba(168, 85, 247, 0.3)',
  black: '#161b22',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#a855f7',
  cyan: '#39d353',
  white: '#c9d1d9'
};

const apiTerminals = new Map();

async function startApiServer(projectIndex) {
  const { projectsState } = require('../../../renderer/state');
  const project = projectsState.get().projects[projectIndex];
  if (!project) return { success: false, error: 'Project not found' };

  initApiServer(projectIndex);
  setApiServerStatus(projectIndex, 'starting');

  try {
    const result = await api.api.start({
      projectIndex,
      projectPath: project.path,
      devCommand: project.devCommand
    });

    if (result.success) {
      setApiServerStatus(projectIndex, 'running');
    } else {
      setApiServerStatus(projectIndex, 'stopped');
    }
    return result;
  } catch (e) {
    setApiServerStatus(projectIndex, 'stopped');
    return { success: false, error: e.message };
  }
}

async function stopApiServer(projectIndex) {
  try {
    const result = await api.api.stop({ projectIndex });
    setApiServerStatus(projectIndex, 'stopped');
    setApiPort(projectIndex, null);
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function createApiTerminal(projectIndex) {
  const terminal = new Terminal({
    theme: API_TERMINAL_THEME,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: false,
    disableStdin: false,
    scrollback: 10000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  terminal.onData(data => {
    api.api.input({ projectIndex, data });
  });

  apiTerminals.set(projectIndex, { terminal, fitAddon });
  return { terminal, fitAddon };
}

function getApiTerminal(projectIndex) {
  if (!apiTerminals.has(projectIndex)) {
    return createApiTerminal(projectIndex);
  }
  return apiTerminals.get(projectIndex);
}

function mountApiTerminal(projectIndex, container) {
  const { terminal, fitAddon } = getApiTerminal(projectIndex);
  terminal.open(container);
  fitAddon.fit();

  const server = getApiServer(projectIndex);
  if (server.logs.length > 0) {
    terminal.write(server.logs.join(''));
  }

  api.api.resize({ projectIndex, cols: terminal.cols, rows: terminal.rows });
}

function fitApiTerminal(projectIndex) {
  const termData = apiTerminals.get(projectIndex);
  if (termData) {
    termData.fitAddon.fit();
    api.api.resize({ projectIndex, cols: termData.terminal.cols, rows: termData.terminal.rows });
  }
}

function disposeApiTerminal(projectIndex) {
  const termData = apiTerminals.get(projectIndex);
  if (termData) {
    termData.terminal.dispose();
    apiTerminals.delete(projectIndex);
  }
}

function registerApiListeners(onDataCallback, onExitCallback) {
  api.api.onData(({ projectIndex, data }) => {
    addApiLog(projectIndex, data);

    const termData = apiTerminals.get(projectIndex);
    if (termData) termData.terminal.write(data);

    if (onDataCallback) onDataCallback(projectIndex, data);
  });

  api.api.onExit(({ projectIndex, code }) => {
    setApiServerStatus(projectIndex, 'stopped');
    setApiPort(projectIndex, null);

    const termData = apiTerminals.get(projectIndex);
    if (termData) {
      termData.terminal.write(`\r\n[API server exited with code ${code}]\r\n`);
    }

    if (onExitCallback) onExitCallback(projectIndex, code);
  });

  api.api.onPortDetected(({ projectIndex, port }) => {
    setApiPort(projectIndex, port);
  });
}

module.exports = {
  startApiServer,
  stopApiServer,
  createApiTerminal,
  getApiTerminal,
  mountApiTerminal,
  fitApiTerminal,
  disposeApiTerminal,
  registerApiListeners,
  getApiServer
};
