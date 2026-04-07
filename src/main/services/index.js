/**
 * Main Process Services - Central Export
 */

const fs = require('fs');
const path = require('path');
const terminalService = require('./TerminalService');
const mcpService = require('./McpService');
const fivemService = require('./FivemService');
const webAppService = require('../../project-types/webapp/main/WebAppService');
const apiService = require('../../project-types/api/main/ApiService');
const updaterService = require('./UpdaterService');
const chatService = require('./ChatService');
const hooksService = require('./HooksService');
const hookEventServer = require('./HookEventServer');
const minecraftService = require('../../project-types/minecraft/main/MinecraftService');
const remoteServer = require('./RemoteServer');
const workflowService = require('./WorkflowService');
const databaseService = require('./DatabaseService');
const parallelTaskService = require('./ParallelTaskService');

/**
 * Initialize all services with main window reference
 * @param {BrowserWindow} mainWindow
 */
function initializeServices(mainWindow) {
  terminalService.setMainWindow(mainWindow);
  mcpService.setMainWindow(mainWindow);
  fivemService.setMainWindow(mainWindow);
  webAppService.setMainWindow(mainWindow);
  apiService.setMainWindow(mainWindow);
  updaterService.setMainWindow(mainWindow);
  chatService.setMainWindow(mainWindow);
  hookEventServer.setMainWindow(mainWindow);
  minecraftService.setMainWindow(mainWindow);
  remoteServer.setMainWindow(mainWindow); // auto-starts if remoteEnabled

  // Workflow service: inject deps + init scheduler
  workflowService.setMainWindow(mainWindow);
  workflowService.setDeps({ chatService, databaseService });
  workflowService.init();

  // Provision unified MCP in global Claude settings
  databaseService.provisionGlobalMcp().catch(() => {});

  // Poll for MCP trigger files (quick actions, FiveM, WebApp)
  _startMcpTriggerPolling(mainWindow);
}

// ── MCP trigger file polling ─────────────────────────────────────────────────
// All MCP tools that need async control (start/stop servers, run commands)
// write JSON trigger files. This poller picks them up and executes them.

let _mcpPollTimer = null;
let _projectsCache = null;
let _projectsCacheTime = 0;
const PROJECTS_CACHE_TTL = 10000;

function _resolveProjectIndex(projectId) {
  const now = Date.now();
  if (!_projectsCache || now - _projectsCacheTime > PROJECTS_CACHE_TTL) {
    const projFile = path.join(require('os').homedir(), '.claude-terminal', 'projects.json');
    try {
      _projectsCache = JSON.parse(fs.readFileSync(projFile, 'utf8')).projects || [];
      _projectsCacheTime = now;
    } catch (_) { return -1; }
  }
  return _projectsCache.findIndex(p => p.id === projectId);
}

async function _pollTriggerDirAsync(dir, handler) {
  try {
    const files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        await fs.promises.unlink(filePath);
        handler(data);
      } catch (e) {
        try { await fs.promises.unlink(filePath); } catch (_) {}
      }
    }
  } catch (_) {}
}

function _startMcpTriggerPolling(mainWindow) {
  const dataDir = path.join(require('os').homedir(), '.claude-terminal');

  _mcpPollTimer = setInterval(async () => {
    // Quick actions
    await _pollTriggerDirAsync(path.join(dataDir, 'quickactions', 'triggers'), (data) => {
      if (data.projectId && data.command && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('quickaction:run', data);
        console.log(`[Services] MCP quick action: ${data.actionName} on ${data.projectId}`);
      }
    });

    // FiveM
    await _pollTriggerDirAsync(path.join(dataDir, 'fivem', 'triggers'), (data) => {
      if (!data.projectId) return;
      const projectIndex = _resolveProjectIndex(data.projectId);
      if (projectIndex < 0) return;

      if (data.type === 'start') {
        console.log(`[Services] MCP FiveM start: ${data.projectId}`);
        fivemService.start({ projectIndex, projectPath: data.projectPath, runCommand: data.runCommand });
      } else if (data.type === 'stop') {
        console.log(`[Services] MCP FiveM stop: ${data.projectId}`);
        fivemService.stop({ projectIndex });
      } else if (data.type === 'command' && data.command) {
        console.log(`[Services] MCP FiveM command: "${data.command}" on ${data.projectId}`);
        fivemService.sendCommand(projectIndex, data.command);
      }
    });

    // WebApp
    await _pollTriggerDirAsync(path.join(dataDir, 'webapp', 'triggers'), (data) => {
      if (!data.projectId) return;
      const projectIndex = _resolveProjectIndex(data.projectId);
      if (projectIndex < 0) return;

      if (data.type === 'start') {
        console.log(`[Services] MCP WebApp start: ${data.projectId}`);
        webAppService.start({ projectIndex, projectPath: data.projectPath, devCommand: data.devCommand });
      } else if (data.type === 'stop') {
        console.log(`[Services] MCP WebApp stop: ${data.projectId}`);
        webAppService.stop({ projectIndex });
      }
    });

    // Parallel tasks
    await _pollTriggerDirAsync(path.join(dataDir, 'parallel', 'triggers'), (data) => {
      if (data.action === 'start' && data.projectPath && data.goal) {
        console.log(`[Services] MCP parallel start: "${data.goal}"`);
        parallelTaskService.startRun({
          projectPath: data.projectPath,
          mainBranch: data.mainBranch || 'main',
          goal: data.goal,
          maxTasks: data.maxTasks || 4,
          autoTasks: data.autoTasks || false,
          model: data.model,
          effort: data.effort,
        });
      } else if (data.action === 'cancel' && data.runId) {
        console.log(`[Services] MCP parallel cancel: ${data.runId}`);
        parallelTaskService.cancelRun(data.runId);
      } else if (data.action === 'cleanup' && data.runId) {
        console.log(`[Services] MCP parallel cleanup: ${data.runId}`);
        parallelTaskService.cleanupRun(data.runId, data.projectPath);
      } else if (data.action === 'merge' && data.runId) {
        console.log(`[Services] MCP parallel merge: ${data.runId}`);
        parallelTaskService.mergeRun(data.runId);
      }
    });

    // Control Tower - terminal interrupt
    // The renderer holds the project->terminal mapping, so we forward there.
    await _pollTriggerDirAsync(path.join(dataDir, 'terminal', 'triggers'), (data) => {
      if (data.type !== 'interrupt' || !data.projectId) return;
      console.log(`[Services] MCP interrupt: ${data.projectId}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('control-tower:interrupt', { projectId: data.projectId });
      }
    });
  }, 2000);
}

/**
 * Cleanup all services before quit
 */
function cleanupServices() {
  terminalService.killAll();
  mcpService.stopAll();
  fivemService.stopAll();
  webAppService.stopAll();
  apiService.stopAll();
  minecraftService.stopAll();
  chatService.closeAll();
  chatService.destroy();
  hookEventServer.stop();
  remoteServer.stop();
  workflowService.destroy();
  databaseService.disconnectAll().catch(() => {});
  if (_mcpPollTimer) clearInterval(_mcpPollTimer);
  // Kill any active git child processes (clone, pull, push, etc.)
  const { killAllGitProcesses } = require('../utils/git');
  killAllGitProcesses();
}

module.exports = {
  terminalService,
  mcpService,
  fivemService,
  webAppService,
  apiService,
  updaterService,
  chatService,
  hooksService,
  hookEventServer,
  minecraftService,
  remoteServer,
  workflowService,
  initializeServices,
  cleanupServices
};
