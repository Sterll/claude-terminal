/**
 * Web App Renderer Service
 * Handles dev server management in the renderer
 */

const api = window.electron_api;
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const {
  getWebAppServer,
  setWebAppServerStatus,
  setWebAppPort,
  addWebAppLog,
  clearWebAppLogs,
  initWebAppServer
} = require('./WebAppState');

const WEBAPP_TERMINAL_THEME = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#c9d1d9',
  cursorAccent: '#0d1117',
  selection: 'rgba(56, 139, 253, 0.3)',
  black: '#161b22',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39d353',
  white: '#c9d1d9'
};

const webappTerminals = new Map();

async function startDevServer(projectIndex) {
  const { projectsState } = require('../../../renderer/state');
  const project = projectsState.get().projects[projectIndex];
  if (!project) return { success: false, error: 'Project not found' };

  initWebAppServer(projectIndex);
  setWebAppServerStatus(projectIndex, 'starting');
  setWebAppPort(projectIndex, null); // reset cached port on restart

  try {
    const result = await api.webapp.start({
      projectIndex,
      projectPath: project.path,
      devCommand: project.devCommand
    });

    if (result.success) {
      setWebAppServerStatus(projectIndex, 'running');
    } else {
      setWebAppServerStatus(projectIndex, 'stopped');
    }
    return result;
  } catch (e) {
    setWebAppServerStatus(projectIndex, 'stopped');
    return { success: false, error: e.message };
  }
}

async function stopDevServer(projectIndex) {
  try {
    const result = await api.webapp.stop({ projectIndex });
    setWebAppServerStatus(projectIndex, 'stopped');
    setWebAppPort(projectIndex, null);
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function createWebAppTerminal(projectIndex) {
  const terminal = new Terminal({
    theme: WEBAPP_TERMINAL_THEME,
    fontSize: 13,
    fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: false,
    disableStdin: false,
    scrollback: 10000
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);

  terminal.onData(data => {
    api.webapp.input({ projectIndex, data });
  });

  webappTerminals.set(projectIndex, { terminal, fitAddon });
  return { terminal, fitAddon };
}

function getWebAppTerminal(projectIndex) {
  if (!webappTerminals.has(projectIndex)) {
    return createWebAppTerminal(projectIndex);
  }
  return webappTerminals.get(projectIndex);
}

function mountWebAppTerminal(projectIndex, container) {
  const { terminal, fitAddon } = getWebAppTerminal(projectIndex);
  terminal.open(container);
  fitAddon.fit();

  const server = getWebAppServer(projectIndex);
  if (server.logs.length > 0) {
    terminal.write(server.logs.join(''));
  }

  api.webapp.resize({ projectIndex, cols: terminal.cols, rows: terminal.rows });
}

function fitWebAppTerminal(projectIndex) {
  const termData = webappTerminals.get(projectIndex);
  if (termData) {
    termData.fitAddon.fit();
    api.webapp.resize({ projectIndex, cols: termData.terminal.cols, rows: termData.terminal.rows });
  }
}

function disposeWebAppTerminal(projectIndex) {
  const termData = webappTerminals.get(projectIndex);
  if (termData) {
    termData.terminal.dispose();
    webappTerminals.delete(projectIndex);
  }
}

function registerWebAppListeners(onDataCallback, onExitCallback) {
  api.webapp.onData(({ projectIndex, data }) => {
    addWebAppLog(projectIndex, data);

    const termData = webappTerminals.get(projectIndex);
    if (termData) termData.terminal.write(data);

    if (onDataCallback) onDataCallback(projectIndex, data);
  });

  api.webapp.onExit(({ projectIndex, code }) => {
    setWebAppServerStatus(projectIndex, 'stopped');
    setWebAppPort(projectIndex, null);

    const termData = webappTerminals.get(projectIndex);
    if (termData) {
      termData.terminal.write(`\r\n[Dev server exited with code ${code}]\r\n`);
    }

    if (onExitCallback) onExitCallback(projectIndex, code);
  });

  api.webapp.onPortDetected(({ projectIndex, port }) => {
    setWebAppPort(projectIndex, port);
  });
}

module.exports = {
  startDevServer,
  stopDevServer,
  createWebAppTerminal,
  getWebAppTerminal,
  mountWebAppTerminal,
  fitWebAppTerminal,
  disposeWebAppTerminal,
  registerWebAppListeners,
  getWebAppServer
};
