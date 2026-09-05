/**
 * Claude Events Orchestrator
 * Initializes the event bus, selects the active provider (hooks or scraping),
 * and wires consumers (time tracking, notifications, dashboard stats).
 */

const { eventBus, EVENT_TYPES } = require('./ClaudeEventBus');
const HooksProvider = require('./HooksProvider');
const ScrapingProvider = require('./ScrapingProvider');
const SessionRouter = require('./SessionRouter');

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

// ── Dedup for SESSION_END notifications (hooks-only) ──
// 'Stop' fires after EVERY turn (reason:'stop'); 'SessionEnd' fires once when the
// session closes (reason:'end'), usually right after the final Stop. We notify on
// every Stop, and only suppress a SessionEnd that immediately follows a Stop for the
// same project — this avoids a double "done" without dropping per-turn notifications.
const lastDoneNotify = new Map(); // projectId -> timestamp of last Stop notification
const SESSION_END_DEDUP_MS = 4000;

// ── Last-active Claude tab tracking (for multi-tab session ID capture) ──
// projectId -> terminalId (the tab that was most recently focused)
const lastActiveClaudeTab = new Map();

// ── Stuck-'working' watchdog (hooks-only) ──
// The badge only drops back to 'ready' on Stop/SessionEnd. A Claude killed with
// SIGKILL, a worktree removed mid-run, or a machine put to sleep never sends one,
// and the tab pulses for the rest of the app's life. Any further hook traffic on
// the session rearms this, so a single tool call running for half an hour is safe.
const HOOK_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const idleWatchdogs = new Map(); // terminalId -> timeout handle

function clearIdleWatchdog(terminalId) {
  const handle = idleWatchdogs.get(terminalId);
  if (handle) {
    clearTimeout(handle);
    idleWatchdogs.delete(terminalId);
  }
}

function armIdleWatchdog(terminalId, setStatus) {
  clearIdleWatchdog(terminalId);
  idleWatchdogs.set(terminalId, setTimeout(() => {
    idleWatchdogs.delete(terminalId);
    try {
      const { getTerminal } = require('../state/terminals.state');
      if (getTerminal(terminalId)?.status === 'working') setStatus(terminalId, 'ready');
    } catch (e) { /* state not ready */ }
  }, HOOK_IDLE_TIMEOUT_MS));
}

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
      console.debug(`[Events] Tool error: ${e.data?.toolName || 'unknown'}`, e.data?.error || '');
    }),

    // Session end = "Claude is done" → show notification (one per turn).
    // This is the ONLY place we notify to avoid duplicates with claude:done (TaskCompleted).
    // Stop fires per turn and SessionEnd once at the end; see SESSION_END_DEDUP_MS above
    // for how a trailing SessionEnd is collapsed into the preceding Stop notification.
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      if (e.source !== 'hooks') return;
      if (!e.projectId) return;

      const now = Date.now();
      const reason = e.data?.reason;
      // Suppress a SessionEnd (reason:'end') that immediately follows a Stop notification
      // for the same project — they describe the same "Claude is done" moment.
      // Per-turn Stop events are NOT deduped against each other.
      if (reason === 'end') {
        const last = lastDoneNotify.get(e.projectId) || 0;
        if (now - last < SESSION_END_DEDUP_MS) {
          lastDoneNotify.delete(e.projectId);
          return;
        }
      } else {
        // Stop (turn end): remember so a trailing SessionEnd gets deduped
        lastDoneNotify.set(e.projectId, now);
      }

      // NOTE: do NOT delete sessionContext here — wireClaudeMdReviewConsumer (registered
      // later) also reads it on SESSION_END. It is reset on the next SESSION_START, so it
      // never accumulates stale data across sessions (bounded to one entry per project).
      const ctx = sessionContext.get(e.projectId);

      const terminalId = resolveTerminalId(e.projectId, e.sessionId);
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
      const terminalId = resolveTerminalId(e.projectId, e.sessionId);
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
 * Best tab to focus when the notification for an event is clicked.
 *
 * Exact when the session is known. Otherwise any tab of the project, which is a
 * small miss: a notification landing on a neighbouring tab of the same project
 * is a navigation shortcut that fell short, not a claim about what that tab is
 * doing. Status has no such licence — see wireTerminalStatusConsumer.
 *
 * @param {string} projectId
 * @param {string|null} [sessionId]
 */
function resolveTerminalId(projectId, sessionId = null) {
  const exact = sessionId ? SessionRouter.resolve(sessionId, { projectId }) : null;
  if (exact !== null) return exact;
  if (!projectId) return null;
  // Prefer the most recent real Claude terminal (same heuristic as session-id capture),
  // so a notification click lands on the tab that actually finished — not an old/basic one.
  const claudeId = findClaudeTerminalForProject(projectId);
  if (claudeId != null) return claudeId;
  // Fallback: any terminal belonging to the project.
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
      const terminalId = resolveTerminalId(e.projectId, e.sessionId);

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
            autoDismiss: 8000
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
      const terminalId = resolveTerminalId(e.projectId, e.sessionId);
      const tool = e.data?.tool || null;

      const body = tool
        ? `${t('terminals.notifPermission')} — ${tool}`
        : t('terminals.notifPermission');

      const buttons = [
        { label: t('terminals.notifBtnAllow'), action: 'allow', style: 'primary' },
        { label: t('terminals.notifBtnDeny'),  action: 'deny',  style: 'danger'  }
      ];

      // Resolve to 'allow' if the notification can't be shown — otherwise the hook handler
      // blocks for ~30s waiting for a response that will never come (notifications disabled,
      // window focused on the terminal, or notificationFn missing). Mirrors the deduped path above.
      const autoAllow = () => {
        if (!requestId) return;
        try {
          window.electron_api.hooks.resolvePermission(requestId, 'allow');
        } catch (err) {
          console.error('[Events] Failed to auto-resolve unshown permission:', err);
        }
      };

      if (notificationFn) {
        const shown = notificationFn('permission', projectName || 'Claude Terminal', body, terminalId, {
          buttons,
          autoDismiss: 8000,
          meta: { requestId }
        });
        if (!shown) autoAllow();
      } else {
        console.error('[Events] notificationFn not set — auto-allowing permission for requestId=' + requestId);
        autoAllow();
      }
    })
  );
}

// ── Consumer: Terminal Tab Status (hooks-only — forces tab status from hook events) ──
// When hooks are active, the scraping-based status detection may be slow (debounce).
// This consumer provides instant tab status updates from hooks.
//
// Routing is by session id, never by project. Resolving by project put every event
// of a folder on one arbitrary tab, so an idle tab started pulsing whenever
// anything else ran there — a chat tab, a workflow node, a `claude` outside the
// app. An event whose session cannot be tied to a tab is dropped instead.
function wireTerminalStatusConsumer() {
  const setStatus = (terminalId, status) => {
    try {
      const TerminalManager = require('../ui/components/TerminalManager');
      TerminalManager.updateTerminalStatus(terminalId, status);
    } catch (err) { /* TerminalManager not ready */ }
  };

  /**
   * The PTY tab this event belongs to, or null if that cannot be established.
   * Chat tabs are filtered out: they drive their badge from the SDK stream
   * (ChatView.onStatusChange), which is finer-grained than the hooks and already
   * distinguishes thinking from tool calls.
   */
  const terminalTab = (e, { adopt }) => {
    if (e.source !== 'hooks' || !e.projectId || !e.sessionId) return null;
    const terminalId = SessionRouter.resolve(e.sessionId, {
      projectId: e.projectId,
      adopt,
      prefer: lastActiveClaudeTab.get(e.projectId) ?? null
    });
    if (terminalId === null) return null;
    try {
      const { getTerminal } = require('../state/terminals.state');
      const td = getTerminal(terminalId);
      return td && td.mode === 'terminal' ? terminalId : null;
    } catch (err) { return null; }
  };

  consumerUnsubscribers.push(
    // Claude working → set tab to 'working'
    eventBus.on(EVENT_TYPES.CLAUDE_WORKING, (e) => {
      const terminalId = terminalTab(e, { adopt: true });
      if (terminalId === null) return;
      setStatus(terminalId, 'working');
      armIdleWatchdog(terminalId, setStatus);
    }),

    // Still alive: one tool call can run for minutes without another status event,
    // so its completion is what keeps the watchdog from firing mid-work.
    eventBus.on(EVENT_TYPES.TOOL_END, (e) => {
      const terminalId = terminalTab(e, { adopt: false });
      if (terminalId !== null && idleWatchdogs.has(terminalId)) armIdleWatchdog(terminalId, setStatus);
    }),

    // Session end (Stop/SessionEnd) → set tab to 'ready'
    eventBus.on(EVENT_TYPES.SESSION_END, (e) => {
      const terminalId = terminalTab(e, { adopt: false });
      // 'stop' fires after every turn; only 'end' means the process is gone and
      // its tab is free to host the next session.
      if (e.sessionId && e.data?.reason === 'end') SessionRouter.release(e.sessionId);
      if (terminalId === null) return;
      clearIdleWatchdog(terminalId);
      setStatus(terminalId, 'ready');
    }),

    // PreCompact → show compacting notification for terminal-mode projects
    eventBus.on(EVENT_TYPES.COMPACTING, (e) => {
      if (e.source !== 'hooks' || !e.projectId) return;
      const projectName = resolveProjectName(e.projectId);
      if (notificationFn) {
        const { t } = require('../i18n');
        notificationFn('info', projectName || 'Claude Terminal', t('chat.compacting') || 'Compacting conversation...', resolveTerminalId(e.projectId, e.sessionId));
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
      // Session first: a /command typed in one tab must not rename another.
      const terminalId = (e.sessionId ? SessionRouter.resolve(e.sessionId, { projectId: e.projectId }) : null)
        ?? lastActiveClaudeTab.get(e.projectId)
        ?? findClaudeTerminalForProject(e.projectId);
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
      setTimeout(async () => {
        try {
          const { showToast } = require('../ui/components/Toast');
          const { projectsState } = require('../state/projects.state');
          const project = (projectsState.get().projects || []).find(p => p.id === e.projectId);
          if (!project) return;

          const { path: pathModule } = window.electron_nodeModules;
          const { fileExists } = require('../utils/fs-async');
          const claudeMdPath = pathModule.join(project.path, 'CLAUDE.md');

          // Only suggest if CLAUDE.md exists
          if (!(await fileExists(claudeMdPath))) return;

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
              // Open CLAUDE.md in the configured editor
              const { getSetting } = require('../state/settings.state');
              const editor = getSetting('editor') || 'code';
              window.electron_api.dialog.openInEditor({ editor, path: claudeMdPath });
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
    // No more hook traffic to rearm them, and no more Stop to clear them.
    for (const terminalId of [...idleWatchdogs.keys()]) clearIdleWatchdog(terminalId);
    SessionRouter.reset();
  } else if (activeProvider === 'scraping') {
    ScrapingProvider.stop();
  }
  activeProvider = null;
}

// ── Consumer: Session ID Capture (hooks-only — captures Claude session IDs for resume) ──
// A PTY tab has no way to learn the id of the `claude` it launched, so it is
// adopted from the SessionStart hook. Deferred by a beat because the SDK announces
// a chat session's id on its own `init` message: if that lands first the session is
// already spoken for, and no PTY tab should claim it. Only the resume pointer is
// delayed here, nothing the user can see.
const SESSION_ADOPT_DELAY_MS = 1200;

function wireSessionIdCapture() {
  consumerUnsubscribers.push(
    eventBus.on(EVENT_TYPES.SESSION_START, (e) => {
      if (e.source !== 'hooks') return;
      const sessionId = e.data?.sessionId || e.sessionId;
      if (!sessionId || !e.projectId) return;
      const prefer = lastActiveClaudeTab.get(e.projectId) ?? null;
      setTimeout(() => {
        const terminalId = SessionRouter.resolve(sessionId, { projectId: e.projectId, adopt: true, prefer });
        if (terminalId === null) return;
        const { getTerminal, updateTerminal } = require('../state/terminals.state');
        const td = getTerminal(terminalId);
        // Never write over a chat tab: its id comes from the SDK, and repointing it
        // would aim that tab's Resume at somebody else's conversation.
        if (!td || td.mode !== 'terminal' || td.claudeSessionId === sessionId) return;
        updateTerminal(terminalId, { claudeSessionId: sessionId });
        const TerminalSessionService = require('../services/TerminalSessionService');
        TerminalSessionService.saveTerminalSessions();
        console.debug(`[Events] Captured session ID ${sessionId} for terminal ${terminalId}`);
      }, SESSION_ADOPT_DELAY_MS);
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
