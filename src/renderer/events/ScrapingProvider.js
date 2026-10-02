/**
 * ScrapingProvider - Bridges existing xterm scraping detection into the EventBus.
 *
 * Limitations vs HooksProvider:
 * - No precise session:start (proxied by first 'working' after idle)
 * - No individual tool:start/tool:end (just claude:working)
 * - No structured data (tool names come from OSC title only)
 * - session:end proxied by terminal exit
 *
 * Runs in one of two modes. On its own (hooks off) it reports every terminal
 * tab. Alongside the hooks provider (`remoteOnly`) it reports only the tabs of
 * remote (SSH) projects: their CLI runs on another host, never reaches the
 * local hook server, and would otherwise produce no events at all. Local tabs
 * keep coming from the hooks, so nothing is reported twice.
 */

const api = window.electron_api;
const { eventBus, EVENT_TYPES } = require('./ClaudeEventBus');
const { isRemoteProject } = require('../../shared/remote-capabilities');

// Track which terminals are in a "session" (working at least once)
const activeSessions = new Set();

let exitUnsubscribe = null;

// Report only remote project tabs (the hooks provider covers the rest).
let remoteOnly = false;

/** Whether this provider speaks for a terminal in the current mode. */
function covers(terminalId) {
  if (!remoteOnly) return true;
  try {
    const { getTerminal } = require('../state');
    return isRemoteProject(getTerminal(terminalId)?.project);
  } catch (e) {
    return false;
  }
}

/**
 * Resolve projectId from a terminal ID.
 */
function resolveFromTerminal(terminalId) {
  try {
    // `../state`: this file is in src/renderer/events. The `../../state` this
    // used to name does not exist, so every scraping event went out with no
    // project at all.
    const { getTerminal } = require('../state');
    const td = getTerminal(terminalId);
    if (td?.project?.id) {
      return {
        projectId: td.project.id,
        projectPath: (td.project.path || '').replace(/\\/g, '/')
      };
    }
  } catch (e) { /* state not ready */ }
  return { projectId: null, projectPath: '' };
}

/**
 * Callback set on TerminalManager. Called with (id, type, data).
 * type: 'working' | 'done' | 'input'
 */
function handleScrapingEvent(terminalId, type, data) {
  if (!covers(terminalId)) return;
  const meta = { ...resolveFromTerminal(terminalId), source: 'scraping' };

  switch (type) {
    case 'working': {
      // First working event = synthetic session start
      if (!activeSessions.has(terminalId)) {
        activeSessions.add(terminalId);
        eventBus.emit(EVENT_TYPES.SESSION_START, { sessionId: null, model: null, synthetic: true }, meta);
      }
      eventBus.emit(EVENT_TYPES.CLAUDE_WORKING, { tool: data?.tool || null }, meta);
      break;
    }
    case 'done': {
      eventBus.emit(EVENT_TYPES.CLAUDE_DONE, {}, meta);
      break;
    }
    case 'input': {
      if (activeSessions.has(terminalId)) {
        eventBus.emit(EVENT_TYPES.PROMPT_SUBMIT, { prompt: null }, meta);
      }
      break;
    }
  }
}

/**
 * Handle terminal exit -> session end
 */
function handleTerminalExit(data) {
  const terminalId = data?.id;
  if (terminalId && activeSessions.has(terminalId)) {
    const meta = { ...resolveFromTerminal(terminalId), source: 'scraping' };
    eventBus.emit(EVENT_TYPES.SESSION_END, { reason: 'exit' }, meta);
    activeSessions.delete(terminalId);
  }
}

/**
 * @param {{remoteOnly?: boolean}} [options] - remoteOnly: run alongside the
 *   hooks provider, for remote project tabs only
 */
function start(options = {}) {
  remoteOnly = Boolean(options.remoteOnly);
  // Set scraping callback on TerminalManager
  try {
    const TerminalManager = require('../ui/components/TerminalManager');
    TerminalManager.setScrapingCallback(handleScrapingEvent);
  } catch (e) {
    console.error('[ScrapingProvider] Failed to set scraping callback:', e);
  }

  // Listen for terminal exits
  exitUnsubscribe = api.terminal.onExit(handleTerminalExit);
  console.debug('[ScrapingProvider] Started');
}

function stop() {
  // Clear scraping callback
  try {
    const TerminalManager = require('../ui/components/TerminalManager');
    TerminalManager.setScrapingCallback(null);
  } catch (e) { /* ignore */ }

  if (exitUnsubscribe) {
    exitUnsubscribe();
    exitUnsubscribe = null;
  }
  activeSessions.clear();
  remoteOnly = false;
  console.debug('[ScrapingProvider] Stopped');
}

module.exports = { start, stop };
