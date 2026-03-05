/**
 * Claude Events Orchestrator
 * Initializes the event bus, selects the active provider (hooks or scraping),
 * and wires consumers (time tracking, notifications, dashboard stats).
 */

const { eventBus, EVENT_TYPES } = require('./ClaudeEventBus');
const HooksProvider = require('./HooksProvider');
const ScrapingProvider = require('./ScrapingProvider');

let activeProvider = null; // 'hooks' | 'scraping'
let consumerUnsubscribers = [];

// Reference to the app's showNotification function (set by renderer.js via setNotificationFn)
let notificationFn = null;

// ── Dashboard stats (hooks-only, accumulated per app lifetime) ──
const toolStats = new Map(); // toolName -> { count, errors }
let hookSessionCount = 0;

// ── Per-project session context for rich notifications (hooks-only) ──
// projectId -> { toolCount, toolNames: Set, lastToolName, startTime, notified }
const sessionContext = new Map();

// ── Last-active Claude tab tracking (for multi-tab session ID capture) ──
// projectId -> terminalId (the tab that was most recently focused)
const lastActiveClaudeTab = new Map();

// ── Consumer: Time Tracking (hooks-only — scraping uses existing direct calls in TerminalManager) ──
function wireTimeTrackingConsumer() {
  const { heartbeat, stopProject } = require('../state/timeTracking.state');

  consumerUnsubscribers.push(
    eventBus.on(EVENT_TYPES.SESSION_START, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      heartbeat(e.projectId, 'hooks');
    }),
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      stopProject(e.projectId);
    }),
    eventBus.on(EVENT_TYPES.TOOL_START, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      heartbeat(e.projectId, 'hooks');
    }),
    eventBus.on(EVENT_TYPES.TOOL_END, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      heartbeat(e.projectId, 'hooks');
    })
  );
}

// ── Consumer: Notifications (hooks-only — scraping uses existing callbacks.onNotification in TerminalManager) ──
function wireNotificationConsumer() {
  const api = window.electron_api;
  const { t } = require('../i18n');

  consumerUnsubscribers.push(
    // Init session context on session start
    eventBus.on(EVENT_TYPES.SESSION_START, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      sessionContext.set(e.projectId, { toolCount: 0, toolNames: new Set(), toolCounts: new Map(), prompts: [], lastToolName: null, startTime: Date.now(), notified: false });
    }),

    // Accumulate tool usage (also auto-init context if SESSION_START was missed)
    eventBus.on(EVENT_TYPES.TOOL_START, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      if (!sessionContext.has(e.projectId)) {
        sessionContext.set(e.projectId, { toolCount: 0, toolNames: new Set(), toolCounts: new Map(), prompts: [], lastToolName: null, startTime: Date.now(), notified: false });
      }
      const ctx = sessionContext.get(e.projectId);
      ctx.toolCount++;
      ctx.lastToolName = e.data?.toolName || null;
      if (e.data?.toolName) ctx.toolNames.add(e.data.toolName);
      const toolName = e.data?.toolName;
      if (toolName) {
        ctx.toolCounts.set(toolName, (ctx.toolCounts.get(toolName) || 0) + 1);
      }
    }),

    // Log tool errors
    eventBus.on(EVENT_TYPES.TOOL_ERROR, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      console.warn(`[Events] Tool error: ${e.data?.toolName || 'unknown'}`, e.data?.error || '');
    }),

    // Session end = definitive "Claude is done" → show notification
    // This is the ONLY place we notify to avoid duplicates with claude:done (TaskCompleted)
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if (e.source !== 'hooks') return;
      const ctx = sessionContext.get(e.projectId);
      // Clean up regardless
      sessionContext.delete(e.projectId);

      const terminalId = resolveTerminalId(e.projectId);
      const projectName = resolveProjectName(e.projectId);

      const body = (ctx && ctx.toolCount > 0)
        ? buildNotificationBody(ctx, t)
        : t('terminals.notifDone');

      // Use the app's showNotification (checks notificationsEnabled + smart focus check)
      if (notificationFn) {
        notificationFn('done', projectName || 'Claude Terminal', body, terminalId);
      } else {
        // Fallback: direct call
        if (document.hasFocus()) return;
        api.notification.show({
          type: 'done',
          title: projectName || 'Claude Terminal',
          body,
          terminalId: terminalId || undefined,
          autoDismiss: 8000,
          labels: { show: t('terminals.notifBtnShow') }
        });
      }
    })
  );
}

/**
 * Build a rich notification body from session context.
 */
function buildNotificationBody(ctx, t) {
  if (ctx.toolCount > 0) {
    const uniqueTools = [...ctx.toolNames].slice(0, 3).join(', ');
    const extra = ctx.toolNames.size > 3 ? ` +${ctx.toolNames.size - 3}` : '';
    return t('terminals.notifToolsDone', { count: ctx.toolCount }) + ` (${uniqueTools}${extra})`;
  }
  return t('terminals.notifDone');
}

/**
 * Resolve project name from projectId.
 */
function resolveProjectName(projectId) {
  if (!projectId) return null;
  try {
    const { projectsState } = require('../state/projects.state');
    const project = (projectsState.get().projects || []).find(p => p.id === projectId);
    return project?.name || null;
  } catch (e) { return null; }
}

/**
 * Try to find an active terminal for a project so notification click can switch to it.
 */
function resolveTerminalId(projectId) {
  if (!projectId) return null;
  try {
    const { terminalsState } = require('../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    for (const [id, td] of terminals) {
      if (td.project?.id === projectId) return id;
    }
  } catch (e) { /* ignore */ }
  return null;
}

/**
 * Find the most recently created Claude terminal for a project.
 * Uses latest-terminal-ID heuristic (IDs are monotonically incrementing integers).
 * When a project has only one Claude terminal, this is unambiguous.
 * TODO: improve correlation for multi-terminal same-project edge case
 * @param {string} projectId
 * @returns {number|null} terminal ID or null
 */
function findClaudeTerminalForProject(projectId) {
  try {
    const { terminalsState } = require('../state/terminals.state');
    const terminals = terminalsState.get().terminals;
    let bestId = null;
    let bestNumericId = -1;
    for (const [id, td] of terminals) {
      if (td.project?.id !== projectId) continue;
      if (td.mode !== 'terminal') continue;
      if (td.isBasic) continue;
      if (id > bestNumericId) { bestNumericId = id; bestId = id; }
    }
    return bestId;
  } catch (e) { return null; }
}

// ── Consumer: Dashboard Stats (hooks-only) ──
function wireDashboardStatsConsumer() {
  consumerUnsubscribers.push(
    eventBus.on(EVENT_TYPES.TOOL_END, (e) => {
      if (e.source !== 'hooks') return;
      const name = e.data?.toolName || 'unknown';
      if (!toolStats.has(name)) toolStats.set(name, { count: 0, errors: 0 });
      toolStats.get(name).count++;
    }),
    eventBus.on(EVENT_TYPES.TOOL_ERROR, (e) => {
      if (e.source !== 'hooks') return;
      const name = e.data?.toolName || 'unknown';
      if (!toolStats.has(name)) toolStats.set(name, { count: 0, errors: 0 });
      toolStats.get(name).errors++;
    }),
    eventBus.on(EVENT_TYPES.SESSION_START, (e) => {
      if (e.source === 'hooks') hookSessionCount++;
    })
  );
}

// ── Consumer: Attention Needed (hooks-only — AskUserQuestion, PermissionRequest) ──
// These events mean Claude is waiting for user input — notify immediately.
// Dedup: AskUserQuestion triggers both PreToolUse AND PermissionRequest, so we
// use a short cooldown per project to avoid double notifications.
function wireAttentionConsumer() {
  const { t } = require('../i18n');

  const lastAttentionNotif = new Map(); // projectId -> timestamp
  const DEDUP_MS = 5000;

  // Tool name (case-insensitive) → { type, i18nKey }
  const attentionTools = {
    'askuserquestion': { type: 'question', key: 'notifQuestion' },
    'exitplanmode':    { type: 'plan',     key: 'notifPlan' },
  };

  function shouldNotify(projectId) {
    const last = lastAttentionNotif.get(projectId) || 0;
    if (Date.now() - last < DEDUP_MS) return false;
    lastAttentionNotif.set(projectId, Date.now());
    return true;
  }

  consumerUnsubscribers.push(
    // AskUserQuestion / ExitPlanMode → Claude needs user attention
    eventBus.on(EVENT_TYPES.TOOL_START, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      const toolName = e.data?.toolName || '';
      const match = attentionTools[toolName.toLowerCase()];
      if (!match) return;
      if (!shouldNotify(e.projectId)) return;

      const projectName = resolveProjectName(e.projectId);
      const terminalId = resolveTerminalId(e.projectId);

      if (notificationFn) {
        notificationFn(match.type, projectName || 'Claude Terminal', t(`terminals.${match.key}`), terminalId);
      }
    }),

    // PermissionRequest → Claude needs permission (skipped if question already notified)
    eventBus.on(EVENT_TYPES.CLAUDE_PERMISSION, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      if (!shouldNotify(e.projectId)) return;

      const projectName = resolveProjectName(e.projectId);
      const terminalId = resolveTerminalId(e.projectId);

      if (notificationFn) {
        notificationFn('permission', projectName || 'Claude Terminal', t('terminals.notifPermission'), terminalId);
      }
    })
  );
}

// ── Consumer: Terminal Tab Status (hooks-only — forces tab status from hook events) ──
// When hooks are active, the scraping-based status detection may be slow (debounce).
// This consumer provides instant tab status updates from hooks.
function wireTerminalStatusConsumer() {
  consumerUnsubscribers.push(
    // Claude working → set tab to 'working'
    eventBus.on(EVENT_TYPES.CLAUDE_WORKING, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      const terminalId = resolveTerminalId(e.projectId);
      if (!terminalId) return;
      try {
        const TerminalManager = require('../ui/components/TerminalManager');
        TerminalManager.updateTerminalStatus(terminalId, 'working');
      } catch (err) { /* TerminalManager not ready */ }
    }),

    // Session end (Stop/SessionEnd) → set tab to 'ready'
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      const terminalId = resolveTerminalId(e.projectId);
      if (!terminalId) return;
      try {
        const TerminalManager = require('../ui/components/TerminalManager');
        TerminalManager.updateTerminalStatus(terminalId, 'ready');
      } catch (err) { /* TerminalManager not ready */ }
    }),

    // PreCompact → show compacting notification for terminal-mode projects
    eventBus.on(EVENT_TYPES.COMPACTING, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      const projectName = resolveProjectName(e.projectId);
      if (notificationFn) {
        const { t } = require('../i18n');
        notificationFn('info', projectName || 'Claude Terminal', t('chat.compacting') || 'Compacting conversation...', resolveTerminalId(e.projectId));
      }
    })
  );
}

/**
 * Record which Claude terminal tab is currently active for a project.
 * Called by TerminalManager.setActiveTerminal whenever a Claude tab is focused.
 * Used by wireTabRenameConsumer to route events to the correct tab.
 * @param {string} projectId
 * @param {number} terminalId
 */
function notifyTabActivated(projectId, terminalId) {
  if (!projectId || terminalId == null) return;
  lastActiveClaudeTab.set(projectId, terminalId);
}

// ── Consumer: Tab Rename on Slash Command (hooks-only) ──
// When tabRenameOnSlashCommand is enabled and a slash command is submitted,
// renames the active terminal tab to the full command text (truncated to 40 chars).
function wireTabRenameConsumer() {
  const MAX_TAB_NAME_LEN = 40;
  consumerUnsubscribers.push(
    eventBus.on(EVENT_TYPES.PROMPT_SUBMIT, (e) => {
      if (e.source !== 'hooks') return;
      if (!e.projectId) return;
      const prompt = e.data?.prompt;
      if (!prompt || !prompt.trimStart().startsWith('/')) return;
      const { getSetting } = require('../state/settings.state');
      if (!getSetting('tabRenameOnSlashCommand')) return;
      const terminalId = lastActiveClaudeTab.get(e.projectId) ?? findClaudeTerminalForProject(e.projectId);
      if (!terminalId) return;
      const name = prompt.length > MAX_TAB_NAME_LEN
        ? prompt.slice(0, MAX_TAB_NAME_LEN - 1) + '\u2026'
        : prompt;
      try {
        const TerminalManager = require('../ui/components/TerminalManager');
        TerminalManager.updateTerminalTabName(terminalId, name);
      } catch (err) { /* TerminalManager not ready */ }
    })
  );
}

// ── Consumer: Session Recap (hooks-only — generates AI summary after session ends) ──
function wireSessionRecapConsumer() {
  consumerUnsubscribers.push(
    // Collect user prompts into session context
    eventBus.on(EVENT_TYPES.PROMPT_SUBMIT, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      const ctx = sessionContext.get(e.projectId);
      if (!ctx) return;
      const prompt = e.data?.prompt;
      if (prompt && ctx.prompts.length < 5) {
        ctx.prompts.push(prompt);
      }
    }),

    // On session end: generate recap if session was meaningful
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      const ctx = sessionContext.get(e.projectId);
      // Skip trivial sessions (< 2 tool uses)
      if (!ctx || ctx.toolCount < 2) return;

      const durationMs = Date.now() - (ctx.startTime || Date.now());
      const enrichedCtx = {
        toolCounts: Object.fromEntries(ctx.toolCounts),
        prompts: ctx.prompts || [],
        durationMs,
        toolCount: ctx.toolCount
      };

      // Non-blocking async call
      try {
        const SessionRecapService = require('../services/SessionRecapService');
        SessionRecapService.handleSessionEnd(e.projectId, enrichedCtx).catch(err => {
          console.warn('[Events] SessionRecap error:', err.message);
        });
      } catch (err) {
        console.warn('[Events] SessionRecapService not available:', err.message);
      }
    })
  );
}

// ── Debug: wildcard listener (disabled by default to avoid log spam) ──
// Enable via: window.__CLAUDE_EVENT_DEBUG = true
function wireDebugListener() {
  consumerUnsubscribers.push(
    eventBus.on('*', (e) => {
      if (window.__CLAUDE_EVENT_DEBUG) {
        console.debug(`[EventBus] ${e.type} (${e.source})`, e.data);
      }
    })
  );
}

/**
 * Start the specified provider.
 */
function activateProvider(mode) {
  if (mode === 'hooks') {
    HooksProvider.start();
  } else {
    ScrapingProvider.start();
  }
  activeProvider = mode;
}

/**
 * Stop the currently active provider.
 */
function deactivateProvider() {
  if (activeProvider === 'hooks') {
    HooksProvider.stop();
  } else if (activeProvider === 'scraping') {
    ScrapingProvider.stop();
  }
  activeProvider = null;
}

// ── Consumer: Session ID Capture (hooks-only — captures Claude session IDs for resume) ──
function wireSessionIdCapture() {
  consumerUnsubscribers.push(
    eventBus.on(EVENT_TYPES.SESSION_START, (e) => {
      if (e.source !== 'hooks') return;
      if (!e.data?.sessionId) return;
      if (!e.projectId) return;
      const terminalId = findClaudeTerminalForProject(e.projectId);
      if (!terminalId) return;
      const { updateTerminal } = require('../state/terminals.state');
      updateTerminal(terminalId, { claudeSessionId: e.data.sessionId });
      const TerminalSessionService = require('../services/TerminalSessionService');
      TerminalSessionService.saveTerminalSessions();
      console.debug(`[Events] Captured session ID ${e.data.sessionId} for terminal ${terminalId}`);
    })
  );
}

/**
 * Initialize the Claude event system.
 * Reads hooksEnabled setting, activates the right provider, wires consumers.
 */
function initClaudeEvents() {
  const { getSetting } = require('../state/settings.state');
  const hooksEnabled = getSetting('hooksEnabled');

  // Wire consumers (they stay active regardless of provider)
  // NOTE: wireSessionRecapConsumer must be registered BEFORE wireNotificationConsumer
  // because both listen to SESSION_END and the notification consumer deletes sessionContext.
  wireTimeTrackingConsumer();
  wireSessionRecapConsumer();
  wireNotificationConsumer();
  wireAttentionConsumer();
  wireDashboardStatsConsumer();
  wireTerminalStatusConsumer();
  wireSessionIdCapture();
  wireTabRenameConsumer();
  wireDebugListener();

  // Activate provider
  activateProvider(hooksEnabled ? 'hooks' : 'scraping');

  console.log(`[Events] Initialized with provider: ${activeProvider}`);
}

/**
 * Switch provider at runtime (e.g., when toggling hooks in settings).
 * Consumers remain wired - only the provider changes.
 * @param {'hooks'|'scraping'} mode
 */
function switchProvider(mode) {
  if (mode === activeProvider) return;
  deactivateProvider();
  activateProvider(mode);
  console.log(`[Events] Switched to provider: ${mode}`);
}

/**
 * @returns {'hooks'|'scraping'|null}
 */
function getActiveProvider() {
  return activeProvider;
}

/**
 * @returns {import('./ClaudeEventBus').ClaudeEventBus}
 */
function getEventBus() {
  return eventBus;
}

/**
 * Get accumulated dashboard stats (hooks-only data).
 */
function getDashboardStats() {
  return {
    toolStats: Object.fromEntries(toolStats),
    hookSessionCount
  };
}

/**
 * Set the notification function (called from renderer.js to share its showNotification).
 * @param {Function} fn - (type, title, body, terminalId) => void
 */
function setNotificationFn(fn) {
  notificationFn = fn;
}

module.exports = {
  initClaudeEvents,
  switchProvider,
  getActiveProvider,
  getEventBus,
  getDashboardStats,
  setNotificationFn,
  notifyTabActivated,
  EVENT_TYPES
};
