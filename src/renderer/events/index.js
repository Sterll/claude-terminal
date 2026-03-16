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

// ── Dedup set for SESSION_END notifications (hooks-only) ──
// Both Stop and SessionEnd hooks fire SESSION_END — track which projects were
// already notified to avoid showing "done" twice in quick succession.
const notifiedSessions = new Set(); // projectId

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
    // This is the ONLY place we notify to avoid duplicates with claude:done (TaskCompleted).
    // Guard: only fire once per session — Stop and SessionEnd hooks both emit SESSION_END,
    // so the second emission is skipped via notifiedSessions dedup set.
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if (e.source !== 'hooks') return;
      if (!e.projectId) return;
      // Dedup: both Stop and SessionEnd hooks fire SESSION_END — only notify once
      if (notifiedSessions.has(e.projectId)) {
        notifiedSessions.delete(e.projectId);
        return;
      }
      notifiedSessions.add(e.projectId);
      setTimeout(() => notifiedSessions.delete(e.projectId), 10000); // auto-cleanup after 10s
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
    }),

    // Claude's native Notification hook (e.g., /compact progress, system messages)
    // Previously this event was emitted but had no consumer — notifications were silently dropped.
    eventBus.on(EVENT_TYPES.NOTIFICATION, (e) => {
      if (e.source !== 'hooks') return;
      const title = e.data?.title || 'Claude';
      const body = e.data?.message || '';
      if (!body) return;
      const terminalId = resolveTerminalId(e.projectId);
      if (notificationFn) {
        notificationFn('info', title, body, terminalId);
      }
    })
  );
}

/**
 * Build a rich notification body from session context.
 * Shows tool count, unique tool names, and session duration.
 */
function buildNotificationBody(ctx, t) {
  if (ctx.toolCount > 0) {
    const uniqueNames = [...ctx.toolNames];
    const displayed = uniqueNames.slice(0, 3).join(', ');
    const extra = uniqueNames.length > 3 ? ` +${uniqueNames.length - 3}` : '';
    let body = t('terminals.notifToolsDone', { count: ctx.toolCount });
    body += ` (${displayed}${extra})`;
    // Append duration if session lasted more than a few seconds
    if (ctx.startTime) {
      const secs = Math.round((Date.now() - ctx.startTime) / 1000);
      if (secs >= 5) {
        const mins = Math.floor(secs / 60);
        const s = secs % 60;
        body += mins > 0 ? ` • ${mins}m${s > 0 ? s + 's' : ''}` : ` • ${s}s`;
      }
    }
    return body;
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

      // AskUserQuestion: build interactive answer buttons from Claude's options
      // SDK structure: toolInput.questions[0].question + toolInput.questions[0].options[].label
      if (toolName.toLowerCase() === 'askuserquestion' && e.data?.toolInput) {
        const { questions } = e.data.toolInput;
        const firstQ = Array.isArray(questions) ? questions[0] : null;
        const body = firstQ?.question || t(`terminals.${match.key}`);
        const rawOpts = Array.isArray(firstQ?.options) ? firstQ.options.slice(0, 3) : [];
        const buttons = rawOpts.length > 0
          ? [
              ...rawOpts.map((opt, i) => {
                const label = (typeof opt === 'object' ? (opt.label || '') : String(opt)).slice(0, 32);
                const value = typeof opt === 'object' ? (opt.label || String(opt)) : String(opt);
                return { label, action: 'answer', value, style: i === 0 ? 'primary' : 'secondary' };
              }),
              { label: t('terminals.notifBtnOther'), action: 'show', style: 'ghost' }
            ]
          : [{ label: t('terminals.notifBtnShow'), action: 'show', style: 'primary' }];

        if (notificationFn) {
          notificationFn(match.type, projectName || 'Claude Terminal', body, terminalId, {
            buttons,
            autoDismiss: 0 // don't auto-dismiss while waiting for an answer
          });
        }
        return;
      }

      if (notificationFn) {
        notificationFn(match.type, projectName || 'Claude Terminal', t(`terminals.${match.key}`), terminalId);
      }
    }),

    // PermissionRequest → Claude needs permission (Allow / Deny buttons)
    eventBus.on(EVENT_TYPES.CLAUDE_PERMISSION, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      const requestId = e.data?.requestId || null;

      if (!shouldNotify(e.projectId)) {
        // Deduped: a question/plan notification was recently shown for this project.
        // Auto-allow the permission immediately so the hook handler isn't blocked for 30 seconds.
        // (The user is already responding via the question notification or the terminal.)
        if (requestId) {
          try {
            window.electron_api.hooks.resolvePermission(requestId, 'allow');
          } catch (err) {
            console.error('[Events] Failed to auto-resolve deduped permission:', err);
          }
        }
        return;
      }

      const projectName = resolveProjectName(e.projectId);
      const terminalId = resolveTerminalId(e.projectId);
      const tool = e.data?.tool || null;

      const body = tool
        ? `${t('terminals.notifPermission')} — ${tool}`
        : t('terminals.notifPermission');

      const buttons = [
        { label: t('terminals.notifBtnAllow'), action: 'allow', style: 'primary' },
        { label: t('terminals.notifBtnDeny'),  action: 'deny',  style: 'danger'  }
      ];

      if (notificationFn) {
        notificationFn('permission', projectName || 'Claude Terminal', body, terminalId, {
          buttons,
          autoDismiss: requestId ? 0 : 15000, // no auto-dismiss when we can block Claude
          meta: { requestId }
        });
      } else {
        console.error('[Events] notificationFn not set — permission notification lost for requestId=' + requestId);
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

// ── Consumer: Session Recap ──
// For hooks: accumulates data across ALL turns of a conversation (multiple Stop events).
// Recap is generated when the session truly ends (reason:'end') OR after 5min of inactivity.
// For chat: recap is generated immediately when the tab is closed (destroy()).
function wireSessionRecapConsumer() {
  // Own accumulation per project — survives across multiple turns
  // projectId -> { toolCounts: {}, prompts: [], startTime, toolCount }
  const recapCtx = new Map();
  // Debounce timers: after a Stop event, wait 5min before generating (cancel if new turn starts)
  const recapTimers = new Map();
  const DEBOUNCE_MS = 5 * 60 * 1000;

  function callRecapService(projectId, enrichedCtx) {
    try {
      const SessionRecapService = require('../services/SessionRecapService');
      SessionRecapService.handleSessionEnd(projectId, enrichedCtx).catch(err => {
        console.warn('[Events] SessionRecap error:', err.message);
      });
    } catch (err) {
      console.warn('[Events] SessionRecapService not available:', err.message);
    }
  }

  function flushRecap(projectId) {
    const accum = recapCtx.get(projectId);
    recapCtx.delete(projectId);
    if (!accum || accum.toolCount < 2) return;
    callRecapService(projectId, {
      toolCounts: accum.toolCounts,
      prompts: accum.prompts,
      durationMs: Date.now() - accum.startTime,
      toolCount: accum.toolCount
    });
  }

  function cancelTimer(projectId) {
    if (recapTimers.has(projectId)) {
      clearTimeout(recapTimers.get(projectId));
      recapTimers.delete(projectId);
    }
  }

  consumerUnsubscribers.push(
    // New turn starting: cancel pending debounce timer (user is still working)
    eventBus.on(EVENT_TYPES.SESSION_START, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      cancelTimer(e.projectId);
      if (!recapCtx.has(e.projectId)) {
        recapCtx.set(e.projectId, { toolCounts: {}, prompts: [], startTime: Date.now(), toolCount: 0 });
      }
    }),

    // Accumulate user prompts (first 5)
    eventBus.on(EVENT_TYPES.PROMPT_SUBMIT, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      if (!recapCtx.has(e.projectId)) {
        recapCtx.set(e.projectId, { toolCounts: {}, prompts: [], startTime: Date.now(), toolCount: 0 });
      }
      const accum = recapCtx.get(e.projectId);
      const prompt = e.data?.prompt;
      if (prompt && accum.prompts.length < 5) accum.prompts.push(prompt);
    }),

    // Accumulate tool usage across turns
    eventBus.on(EVENT_TYPES.TOOL_START, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      if (!recapCtx.has(e.projectId)) {
        recapCtx.set(e.projectId, { toolCounts: {}, prompts: [], startTime: Date.now(), toolCount: 0 });
      }
      const accum = recapCtx.get(e.projectId);
      const toolName = e.data?.toolName;
      if (toolName) accum.toolCounts[toolName] = (accum.toolCounts[toolName] || 0) + 1;
      accum.toolCount++;
    }),

    // Session end
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if ((e.source !== 'hooks' && e.source !== 'chat') || !e.projectId) return;

      if (e.source === 'chat') {
        // Chat: generate immediately on tab close (data comes from ChatView.destroy())
        if (!e.data?.toolCount || e.data.toolCount < 2) return;
        callRecapService(e.projectId, {
          toolCounts: e.data.toolCounts || {},
          prompts: e.data.prompts || [],
          durationMs: e.data.durationMs || 0,
          toolCount: e.data.toolCount
        });
        return;
      }

      // Hooks: check we have enough data
      const accum = recapCtx.get(e.projectId);
      if (!accum || accum.toolCount < 2) return;

      if (e.data?.reason === 'end') {
        // Real session end (SessionEnd hook): generate immediately
        cancelTimer(e.projectId);
        flushRecap(e.projectId);
      } else {
        // Turn end (Stop hook): debounce — user may send another prompt
        cancelTimer(e.projectId);
        const timerId = setTimeout(() => {
          recapTimers.delete(e.projectId);
          flushRecap(e.projectId);
        }, DEBOUNCE_MS);
        recapTimers.set(e.projectId, timerId);
      }
    })
  );
}

// ── Consumer: CLAUDE.md Review Prompt (hooks-only) ──
// After a significant session (>5 tool calls), show a non-intrusive toast
// suggesting the user review their CLAUDE.md for updates.
function wireClaudeMdReviewConsumer() {
  const { t } = require('../i18n');
  const claudeMdReviewedProjects = new Set();

  consumerUnsubscribers.push(
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      if (claudeMdReviewedProjects.has(e.projectId)) return;

      // Get accumulated context from session recap's own context (read-only)
      const ctx = sessionContext.get(e.projectId);
      if (!ctx || ctx.toolCount < 5) return;

      // Check if this was a real session end, not just a turn end
      if (e.data?.reason !== 'end') return;

      // Debounce: show toast after 3 seconds (after the done notification)
      setTimeout(() => {
        try {
          const { showToast } = require('../ui/components/Toast');
          const { projectsState } = require('../state/projects.state');
          const project = (projectsState.get().projects || []).find(p => p.id === e.projectId);
          if (!project) return;

          const { path: pathModule, fs } = window.electron_nodeModules;
          const claudeMdPath = pathModule.join(project.path, 'CLAUDE.md');

          // Only suggest if CLAUDE.md exists
          try { fs.accessSync(claudeMdPath); } catch { return; }

          claudeMdReviewedProjects.add(e.projectId);
          // Auto-cleanup after 1 hour
          setTimeout(() => claudeMdReviewedProjects.delete(e.projectId), 3600000);

          showToast({
            type: 'info',
            title: t('terminals.claudeMdAnalyze'),
            message: t('terminals.claudeMdAnalyzeDesc', { count: ctx.toolCount }),
            duration: 10000,
            action: t('terminals.claudeMdOpen'),
            onAction: () => {
              // Open CLAUDE.md in the default editor
              window.electron_api.dialog.openInEditor({ filePath: claudeMdPath });
            }
          });
        } catch (err) {
          console.warn('[Events] CLAUDE.md review prompt error:', err.message);
        }
      }, 3000);
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
  wireClaudeMdReviewConsumer();
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
