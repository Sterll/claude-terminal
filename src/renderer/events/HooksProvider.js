/**
 * HooksProvider - Translates Claude Code hook events (via IPC) into normalized EventBus events.
 *
 * Hook pipeline: Claude CLI -> hook script -> HTTP -> HookEventServer -> IPC -> here
 *
 * The hook handler script sends: { hook: "PreToolUse", timestamp, stdin: {...}, cwd: "/path" }
 * - hook: the hook name (argv[2] from the handler script)
 * - stdin: parsed JSON from Claude CLI's stdin (contains tool_name, session_id, etc.)
 * - cwd: process.cwd() of the hook handler (= project path)
 */

const api = window.electron_api;
const { eventBus, EVENT_TYPES } = require('./ClaudeEventBus');

// Session state: normalizedCwd -> { active, startTime }
const sessions = new Map();

let unsubscribe = null;

/**
 * Normalize a path for consistent map keys.
 */
function normalizePath(p) {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Resolve projectId from a cwd path by matching against known projects.
 * @param {string} cwd
 * @returns {{ projectId: string|null, projectPath: string }}
 */
function resolveProject(cwd) {
  if (!cwd) return { projectId: null, projectPath: '' };
  const normalized = normalizePath(cwd);
  try {
    const { projectsState } = require('../state/projects.state');
    const projects = projectsState.get().projects || [];
    for (const p of projects) {
      const pPath = normalizePath(p.path);
      if (pPath && normalized.startsWith(pPath)) {
        return { projectId: p.id, projectPath: pPath };
      }
    }
  } catch (e) { /* state not ready yet */ }
  return { projectId: null, projectPath: normalized };
}

/**
 * Ensure a session is tracked for a given cwd. Emits session:start if first seen.
 */
function ensureSession(cwd, meta) {
  if (!cwd) return;
  const key = normalizePath(cwd);
  if (!sessions.has(key)) {
    sessions.set(key, { active: true, startTime: Date.now() });
    eventBus.emit(EVENT_TYPES.SESSION_START, { sessionId: null, model: null, synthetic: true }, meta);
  }
}

/**
 * Check if there's an active terminal in the app for a given projectId.
 */
function hasActiveTerminal(projectId) {
  if (!projectId) return false;
  try {
    const { terminalsState } = require('../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    for (const [, td] of terminals) {
      if (td.project?.id === projectId) return true;
    }
  } catch (e) { /* state not ready */ }
  return false;
}

/**
 * Map a raw hook event to EventBus emissions.
 * Raw format from handler: { hook: string, timestamp: string, stdin: object|null, cwd: string }
 */
function handleHookEvent(raw) {
  const hookName = raw.hook;
  const stdin = raw.stdin || {};
  const cwd = raw.cwd || stdin.cwd || null;
  const meta = { ...resolveProject(cwd), source: 'hooks' };

  // Skip events from non-project sessions (e.g. /usage monitor, home dir)
  if (!meta.projectId) {
    // Still track session state for cleanup, but don't emit events
    if (hookName === 'SessionStart') sessions.set(normalizePath(cwd), { active: true, startTime: Date.now() });
    if (hookName === 'Stop' || hookName === 'SessionEnd') sessions.delete(normalizePath(cwd));
    return;
  }

  // Skip events from external Claude Code sessions (project exists but no terminal open in the app)
  if (!hasActiveTerminal(meta.projectId)) {
    if (hookName === 'SessionStart') sessions.set(normalizePath(cwd), { active: true, startTime: Date.now() });
    if (hookName === 'Stop' || hookName === 'SessionEnd') sessions.delete(normalizePath(cwd));
    return;
  }

  const toolName = stdin.tool_name || '';

  switch (hookName) {
    case 'SessionStart':
      sessions.set(normalizePath(cwd), { active: true, startTime: Date.now() });
      eventBus.emit(EVENT_TYPES.SESSION_START, {
        sessionId: stdin.session_id || null,
        model: stdin.model || null
      }, meta);
      break;

    case 'Stop':
      eventBus.emit(EVENT_TYPES.SESSION_END, { reason: 'stop' }, meta);
      sessions.delete(normalizePath(cwd));
      break;

    case 'SessionEnd':
      eventBus.emit(EVENT_TYPES.SESSION_END, { reason: 'end' }, meta);
      sessions.delete(normalizePath(cwd));
      break;

    case 'PreToolUse':
      ensureSession(cwd, meta);
      eventBus.emit(EVENT_TYPES.TOOL_START, { toolName: stdin.tool_name || 'unknown' }, meta);
      eventBus.emit(EVENT_TYPES.CLAUDE_WORKING, { toolName: stdin.tool_name || null }, meta);
      break;

    case 'PostToolUse':
      eventBus.emit(EVENT_TYPES.TOOL_END, { toolName: stdin.tool_name || 'unknown' }, meta);
      break;

    case 'PostToolUseFailure':
      eventBus.emit(EVENT_TYPES.TOOL_ERROR, {
        toolName: stdin.tool_name || 'unknown',
        error: stdin.error || null
      }, meta);
      break;

    case 'UserPromptSubmit':
      ensureSession(cwd, meta);
      eventBus.emit(EVENT_TYPES.PROMPT_SUBMIT, { prompt: stdin.prompt || null }, meta);
      break;

    case 'Notification':
      eventBus.emit(EVENT_TYPES.NOTIFICATION, {
        title: stdin.title || 'Claude',
        message: stdin.message || stdin.body || ''
      }, meta);
      break;

    case 'PermissionRequest':
      eventBus.emit(EVENT_TYPES.CLAUDE_PERMISSION, { tool: stdin.tool || stdin.tool_name || null }, meta);
      break;

    case 'SubagentStart':
      eventBus.emit(EVENT_TYPES.SUBAGENT_START, { agentName: stdin.agent_name || stdin.agentName || null }, meta);
      break;

    case 'SubagentStop':
      eventBus.emit(EVENT_TYPES.SUBAGENT_STOP, { agentName: stdin.agent_name || stdin.agentName || null }, meta);
      break;

    case 'TaskCompleted':
      eventBus.emit(EVENT_TYPES.CLAUDE_DONE, { message: stdin.message || null }, meta);
      break;

    // Ignored events
    case 'PreCompact':
    case 'Setup':
    case 'TeammateIdle':
      break;

    default:
      console.debug('[HooksProvider] Unknown hook event:', hookName, raw);
  }
}

function start() {
  if (unsubscribe) return;
  unsubscribe = api.hooks.onEvent(handleHookEvent);
  console.debug('[HooksProvider] Started');
}

function stop() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  sessions.clear();
  console.debug('[HooksProvider] Stopped');
}

module.exports = { start, stop };
