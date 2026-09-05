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
const discordRpcService = require('./DiscordRpcService');

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
  workflowService.init().catch(err => console.error('[WorkflowService] Init failed:', err.message));

  // Discord Rich Presence (reads its own enabled/showProject prefs from settings.json)
  try { discordRpcService.start(); } catch (e) { console.warn('[Services] DiscordRPC start failed:', e.message); }

  // Provision unified MCP in global Claude settings
  databaseService.provisionGlobalMcp().catch(() => {});

  // Poll for MCP trigger files (quick actions, FiveM, WebApp)
  _startMcpTriggerPolling(mainWindow);
}

// ── MCP trigger file polling ─────────────────────────────────────────────────
// All MCP tools that need async control (start/stop servers, run commands)
// write JSON trigger files. This poller picks them up and executes them.
//
// WHY A WATCHER *AND* A POLL
// --------------------------
// These 7 directories are empty >99.99% of the time, so a flat 2s poll meant
// ~302k readdir() calls a day for nothing. But the cadence sits on the critical
// path of the `tabs` MCP pipeline: `tab_send` / `tab_close` drop a trigger here
// and then wait for the renderer's reply file with a hard 10s timeout
// (RESPONSE_TIMEOUT_MS in resources/mcp-servers/tools/tabs.js), and their tool
// descriptions promise a "~2-5s" round trip. The same dirs also carry Control
// Tower interrupts and quick-action runs, all user-visible. So the poll cannot
// simply be slowed down.
//
// Instead:
//   * fs.watch() on each trigger dir wakes a sweep within ~50ms — this becomes
//     the normal path and is ~40x more responsive than the old fixed 2s.
//   * The interval sweep stays as the safety net for the cases where fs.watch is
//     unreliable (redirected/UNC home directory, some FUSE mounts, a dir deleted
//     and recreated underneath the watcher) and backs off from POLL_MIN_MS to
//     POLL_MAX_MS while nothing shows up. Any find, or any watch event, snaps it
//     back to POLL_MIN_MS.
//
// POLL_MAX_MS is deliberately only 5s. When fs.watch misses an event the safety
// net is the *only* thing that delivers the trigger, and it still has to fit
// inside tab_send's 10s budget. A larger cap would save more syscalls but would
// turn a silent watch failure into a visible tool timeout.

const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 5000;
const WATCH_DEBOUNCE_MS = 50;

let _mcpPollTimer = null;
let _mcpWakeTimer = null;
let _mcpWatchers = [];
let _mcpTriggerDirs = [];
let _mcpPollIntervalMs = POLL_MIN_MS;
let _mcpPollInFlight = false;
let _mcpPollQueued = false;
let _mcpPollStopped = false;
/** Bumped on every start/stop so a timer chain or arm() promise from a previous
 *  generation cannot resurrect itself after teardown. */
let _mcpPollGeneration = 0;
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

/**
 * Drain one trigger directory.
 *
 * The unlink between readFile and handler() is the claim: if two overlapping
 * sweeps read the same file, only the one whose unlink succeeds reaches
 * handler() — the other throws into the catch and skips it. That is what keeps
 * a watch-driven sweep from double-executing a trigger already picked up by the
 * interval sweep.
 *
 * @returns {Promise<number>} number of trigger files consumed (used for backoff)
 */
async function _pollTriggerDirAsync(dir, handler) {
  let processed = 0;
  try {
    const files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      processed++;
      try {
        const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
        await fs.promises.unlink(filePath);
        handler(data);
      } catch (e) {
        try { await fs.promises.unlink(filePath); } catch (_) {}
      }
    }
  } catch (_) {}
  return processed;
}

/**
 * Sweep every trigger directory once, then adjust the safety-net cadence.
 * Re-entrant calls (watch event landing mid-sweep) are collapsed into a single
 * follow-up sweep rather than running concurrently.
 */
async function _runMcpPollPass() {
  if (_mcpPollStopped) return;
  if (_mcpPollInFlight) { _mcpPollQueued = true; return; }
  _mcpPollInFlight = true;
  try {
    let found = 0;
    for (const { dir, handler } of _mcpTriggerDirs) {
      found += await _pollTriggerDirAsync(dir, handler);
    }
    _mcpPollIntervalMs = found > 0
      ? POLL_MIN_MS
      : Math.min(_mcpPollIntervalMs + POLL_MIN_MS, POLL_MAX_MS);
  } finally {
    _mcpPollInFlight = false;
    if (_mcpPollQueued && !_mcpPollStopped) {
      _mcpPollQueued = false;
      setImmediate(() => { _runMcpPollPass(); });
    }
  }
}

/** Re-arm the safety-net timer at the current (possibly backed-off) cadence. */
function _scheduleMcpPoll(generation) {
  if (_mcpPollStopped || generation !== _mcpPollGeneration) return;
  _mcpPollTimer = setTimeout(async () => {
    await _runMcpPollPass();
    _scheduleMcpPoll(generation);
  }, _mcpPollIntervalMs);
}

/** A trigger dir changed → sweep almost immediately and reset the backoff. */
function _wakeMcpPoll() {
  if (_mcpPollStopped) return;
  _mcpPollIntervalMs = POLL_MIN_MS;
  if (_mcpWakeTimer) return; // already scheduled — debounce bursts
  _mcpWakeTimer = setTimeout(() => {
    _mcpWakeTimer = null;
    _runMcpPollPass();
  }, WATCH_DEBOUNCE_MS);
}

/**
 * Create the trigger dirs (fs.watch cannot attach to a path that does not exist)
 * and attach one watcher per dir. Every failure is non-fatal: that directory
 * simply falls back to the interval sweep.
 */
async function _armMcpWatchers() {
  for (const { dir } of _mcpTriggerDirs) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      // persistent:false — these must never be the reason the process stays alive.
      const watcher = fs.watch(dir, { persistent: false }, () => _wakeMcpPoll());
      watcher.on('error', () => { /* watcher died — the interval sweep still covers this dir */ });
      _mcpWatchers.push(watcher);
    } catch (_) { /* no watcher for this dir; interval sweep only */ }
  }
}

function _startMcpTriggerPolling(mainWindow) {
  const dataDir = path.join(require('os').homedir(), '.claude-terminal');

  // Idempotent: a second initializeServices() must not leave the previous timer
  // chain and 7 fs.watch handles orphaned.
  _stopMcpTriggerPolling();

  _mcpPollStopped = false;
  _mcpPollIntervalMs = POLL_MIN_MS;
  _mcpTriggerDirs = [
    // Quick actions
    { dir: path.join(dataDir, 'quickactions', 'triggers'), handler: (data) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (data.type === 'changed' && data.projectId) {
        mainWindow.webContents.send('quickaction:changed', data);
        console.log(`[Services] MCP quick action ${data.mutation}: ${data.actionName || '?'} on ${data.projectId}`);
      } else if (data.projectId && data.command) {
        mainWindow.webContents.send('quickaction:run', data);
        console.log(`[Services] MCP quick action: ${data.actionName} on ${data.projectId}`);
      }
    } },

    // FiveM
    { dir: path.join(dataDir, 'fivem', 'triggers'), handler: (data) => {
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
    } },

    // WebApp
    { dir: path.join(dataDir, 'webapp', 'triggers'), handler: (data) => {
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
    } },

    // Parallel tasks
    { dir: path.join(dataDir, 'parallel', 'triggers'), handler: (data) => {
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
    } },

    // Control Tower - terminal interrupt
    // The renderer holds the project->terminal mapping, so we forward there.
    { dir: path.join(dataDir, 'terminal', 'triggers'), handler: (data) => {
      if (data.type !== 'interrupt' || !data.projectId) return;
      console.log(`[Services] MCP interrupt: ${data.projectId}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('control-tower:interrupt', { projectId: data.projectId });
      }
    } },

    // Terminal MCP tools (create, send, close)
    { dir: path.join(dataDir, 'terminals', 'triggers'), handler: (data) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (data.action === 'create') {
        console.log(`[Services] MCP terminal create: ${data.projectName} (${data.mode || 'terminal'})`);
        mainWindow.webContents.send('mcp-terminal:create', data);
      } else if (data.action === 'send') {
        console.log(`[Services] MCP terminal send: "${data.command}" to ${data.projectName}`);
        mainWindow.webContents.send('mcp-terminal:send', data);
      } else if (data.action === 'close') {
        console.log(`[Services] MCP terminal close: ${data.projectName}`);
        mainWindow.webContents.send('mcp-terminal:close', data);
      }
    } },

    // Tabs MCP tools (orchestration with stable tabIds + request/response).
    // Actions: create, send, close, status, permission. The renderer handles
    // them and writes back to `tabs/responses/<requestId>.json`.
    { dir: path.join(dataDir, 'tabs', 'triggers'), handler: (data) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!data.action || !data.requestId) return;
      console.log(`[Services] MCP tab ${data.action}: req=${data.requestId} tabId=${data.tabId || '-'}`);
      mainWindow.webContents.send(`mcp-tab:${data.action}`, data);
    } },
  ];

  // Watchers first (they create the dirs), then the safety-net timer. Both are
  // best-effort: if _armMcpWatchers() rejects, the interval sweep still runs.
  const generation = ++_mcpPollGeneration;
  _armMcpWatchers().catch(() => {}).then(() => _scheduleMcpPoll(generation));
}

/** Stop the trigger poll: timers cleared, watchers closed. */
function _stopMcpTriggerPolling() {
  _mcpPollStopped = true;
  _mcpPollQueued = false;
  _mcpPollGeneration++;
  if (_mcpPollTimer) { clearTimeout(_mcpPollTimer); _mcpPollTimer = null; }
  if (_mcpWakeTimer) { clearTimeout(_mcpWakeTimer); _mcpWakeTimer = null; }
  for (const watcher of _mcpWatchers) {
    try { watcher.close(); } catch (_) {}
  }
  _mcpWatchers = [];
  _mcpTriggerDirs = [];
}

/**
 * Cleanup all services before quit
 */
function cleanupServices() {
  // Runs before the PTYs are killed so the last output reaches disk instead of
  // dying in the flush buffer.
  try { require('./TerminalOutputCapture').shutdown(); } catch (_) { /* non-critical */ }
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
  discordRpcService.destroy();
  databaseService.disconnectAll().catch(() => {});
  _stopMcpTriggerPolling();
  // fs.watch on the artifacts index. Required lazily (same pattern as the
  // explorer watchers below) to keep this module free of an ipc/ dependency.
  try { require('./ArtifactService').stopWatching(); } catch (_) { /* non-critical */ }
  // File explorer chokidar watchers. Required lazily (same pattern as git below)
  // to keep this module free of an ipc/ dependency at load time. Without this the
  // watchers were only ever released by an explicit renderer IPC call, so a quit
  // that skipped it left them open until the process died.
  try {
    require('../ipc/explorer.ipc').stopWatch();
  } catch (e) {
    console.warn('[Services] Explorer watcher cleanup failed:', e.message);
  }
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
