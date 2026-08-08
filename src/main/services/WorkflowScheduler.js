/**
 * WorkflowScheduler
 * Manages all workflow triggers:
 *   - Cron (setInterval-based, minute-granular)
 *   - Hook events (forwarded from HookEventServer via IPC)
 *   - on_workflow (post-run callbacks)
 *   - Manual (fire-and-forget via IPC)
 *
 * Exposes a single `dispatch(workflowId, triggerData)` callback
 * that is set by WorkflowService.
 */

'use strict';

const path = require('path');
const fs   = require('fs');

// ─── Cron parsing ─────────────────────────────────────────────────────────────

// Shared with the renderer (Tasks view "next run" display) and the IPC
// validator, so validation here can never diverge from what the UI shows.
const { parseCron } = require('../../shared/cron');

// ─── Hook condition evaluation ────────────────────────────────────────────────

/**
 * Very lightweight condition checker for hook combined triggers.
 * Evaluates a string condition against the hook event object.
 * @param {string|undefined} condition
 * @param {Object} hookEvent
 * @returns {boolean}
 */
function evalHookCondition(condition, hookEvent) {
  if (!condition || !condition.trim()) return true;
  // Replace $trigger.xxx with the actual value
  const resolved = condition.replace(/\$trigger\.([a-zA-Z_][\w.]*)/g, (_, path) => {
    const parts = path.split('.');
    let val = hookEvent;
    for (const p of parts) val = val?.[p];
    return val != null ? String(val) : '';
  });
  // Evaluate basic comparisons
  const match = resolved.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) return resolved.trim() !== '' && resolved.trim() !== 'false';
  const [, left, op, right] = match;
  const l = left.trim();
  const r = right.trim();

  switch (op) {
    case '==': return l === r;
    case '!=': return l !== r;
  }

  // Numeric comparison when both sides are numbers, else lexicographic string compare.
  const ln = Number(l);
  const rn = Number(r);
  const bothNumeric = l !== '' && r !== '' && Number.isFinite(ln) && Number.isFinite(rn);
  const a = bothNumeric ? ln : l;
  const b = bothNumeric ? rn : r;

  switch (op) {
    case '>':  return a >  b;
    case '<':  return a <  b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default:   return false;
  }
}

// ─── WorkflowScheduler class ──────────────────────────────────────────────────

class WorkflowScheduler {
  constructor() {
    /** Cron tick interval handle */
    this._cronTimer    = null;
    /** Last tick minute — prevent double-firing within the same minute */
    this._lastTickMin  = -1;
    /** Map<workflowId, cronMatcher> */
    this._cronJobs     = new Map();
    /** Map<workflowId, { watcher, debounceTimer }> — chokidar watchers for file_change triggers */
    this._fileWatchers = new Map();
    /** Map<workflowId, { watcher, lastOffset, fingerprint }> — git_event watchers */
    this._gitWatchers  = new Map();
    /** Loaded workflow definitions — refreshed on every reload() call */
    this._workflows    = [];
    /** Max on_workflow chain depth before we cut the chain (recursion guard) */
    this._maxChainDepth = 10;
    /** Pre-compiled chat_message regexes — Map<workflowId, { re: RegExp|null, pattern, mode }> */
    this._chatRegexes  = new Map();
    /**
     * Callback invoked when a trigger fires.
     * Signature: (workflowId, triggerData) => void
     */
    this.dispatch      = null;
    /**
     * Resolver used to translate a workflow-config projectId into an absolute path.
     * Injected by WorkflowService so Scheduler stays decoupled from storage.
     * Signature: (projectId) => string|null
     */
    this.resolveProjectPath = null;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Load/reload workflow definitions and rebuild cron jobs.
   * @param {Object[]} workflows
   */
  reload(workflows) {
    this._workflows = workflows || [];
    this._rebuildCronJobs();
    this._ensureCronTimer();
    this._rebuildFileWatchers();
    this._rebuildGitWatchers();
    this._rebuildChatRegexes();
  }

  /**
   * Call this when a Claude hook event arrives.
   * Checks all hook-triggered workflows and fires matching ones.
   * @param {Object} hookEvent  { hook: string, stdin?: Object, cwd?: string, timestamp?: string }
   */
  onHookEvent(hookEvent) {
    if (!hookEvent) return;
    // HookEventServer payload uses `hook`; legacy callers may pass `type`.
    const hookType = hookEvent.hook || hookEvent.type;
    const toolName = hookEvent.stdin?.tool_name || null;
    const cwd      = hookEvent.cwd || null;

    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'hook') continue;
      if (trigger.hookType && trigger.hookType !== hookType) continue;

      // Project filter — match the hook's cwd against the configured project path.
      if (trigger.projectId && typeof this.resolveProjectPath === 'function') {
        const projectPath = this.resolveProjectPath(trigger.projectId);
        if (!projectPath || !cwd || !pathsEqual(projectPath, cwd)) continue;
      }

      // Tool name filter (PreToolUse/PostToolUse) — supports comma list + globs.
      if (trigger.toolName && trigger.toolName.trim()) {
        if (!toolName) continue;
        if (!matchesToolName(trigger.toolName, toolName)) continue;
      }

      if (!evalHookCondition(trigger.condition, hookEvent)) continue;

      this.dispatch?.(wf.id, {
        source:    'hook',
        hookType,
        toolName,
        cwd,
        hookEvent,
      });
    }
  }

  /**
   * Call this when a workflow finishes (for on_workflow chaining).
   * @param {string} finishedWorkflowId
   * @param {Object} result  — { success, outputs, … }
   */
  onWorkflowComplete(finishedWorkflowId, result) {
    // Recursion guard: the lineage of workflow ids that led to this completion.
    // WorkflowService may echo _chainLineage / _chainDepth back through the run's
    // triggerData; if absent we start a fresh lineage from the finished workflow.
    const parentLineage = Array.isArray(result?._chainLineage)
      ? result._chainLineage
      : [];
    const parentDepth = Number.isFinite(result?._chainDepth)
      ? result._chainDepth
      : parentLineage.length;

    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'on_workflow') continue;
      // Match by ID (new) or by name (legacy backwards compat)
      if (trigger.value !== finishedWorkflowId) continue;

      // Optional status filter (like claude_session_end): 'any' | 'success' | 'failed'
      const wantedStatus = trigger.statusFilter || 'any';
      if (wantedStatus !== 'any') {
        const finishedOk = result?.success === true;
        if (wantedStatus === 'success' && !finishedOk) continue;
        if (wantedStatus === 'failed'  &&  finishedOk) continue;
      }

      if (!evalHookCondition(trigger.condition, result)) continue;

      // Build the lineage for the workflow we are about to trigger.
      const nextLineage = [...parentLineage, finishedWorkflowId];

      // Depth guard — refuse to keep chaining past the limit.
      if (parentDepth + 1 > this._maxChainDepth) {
        console.warn(
          `[WorkflowScheduler] on_workflow chain depth exceeded (${parentDepth + 1} > ${this._maxChainDepth}); ` +
          `not triggering "${wf.name || wf.id}". Lineage: ${nextLineage.join(' → ')}`
        );
        continue;
      }

      // Cycle guard — the workflow we would trigger already appears in the lineage.
      if (nextLineage.includes(wf.id)) {
        console.warn(
          `[WorkflowScheduler] on_workflow cycle detected; not triggering "${wf.name || wf.id}". ` +
          `Lineage: ${[...nextLineage, wf.id].join(' → ')}`
        );
        continue;
      }

      this.dispatch?.(wf.id, {
        source:        'on_workflow',
        workflow:      finishedWorkflowId,
        trigger:       result,
        _chainDepth:   parentDepth + 1,
        _chainLineage: nextLineage,
      });
    }
  }

  /**
   * Call this when a terminal PTY exits.
   * @param {Object} event  { exitCode: number, signal?: number, projectId?: string, projectPath?: string, terminalId?: number|string }
   */
  onTerminalExit(event) {
    if (!event) return;
    const exitCode = Number.isFinite(event.exitCode) ? event.exitCode : null;
    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'terminal_exit_code') continue;
      // When the user picked "custom", the codeFilter stays "custom" and the
      // actual list lives in customCodes — hand that off to the matcher.
      const filter = trigger.codeFilter === 'custom'
        ? (trigger.customCodes || '')
        : trigger.codeFilter;
      if (!matchesExitCode(filter, exitCode)) continue;
      if (trigger.projectId && trigger.projectId !== event.projectId) continue;

      // Optional command pattern — matches against the spawned shell command.
      if (trigger.commandPattern && trigger.commandPattern.trim()) {
        const command = event.command || '';
        if (!matchesCommandPattern(trigger.commandPattern, command)) continue;
      }

      this.dispatch?.(wf.id, {
        source:      'terminal_exit_code',
        exitCode,
        signal:      event.signal ?? null,
        projectId:   event.projectId || null,
        projectPath: event.projectPath || null,
        terminalId:  event.terminalId ?? null,
        command:     event.command || null,
      });
    }
  }

  /**
   * Call this when a user opens a project in the app.
   * @param {Object} event  { projectId: string, projectPath?: string, projectName?: string }
   */
  onProjectOpened(event) {
    if (!event || !event.projectId) return;
    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'project_opened') continue;
      if (trigger.projectId && trigger.projectId !== event.projectId) continue;

      this.dispatch?.(wf.id, {
        source:      'project_opened',
        projectId:   event.projectId,
        projectPath: event.projectPath || null,
        projectName: event.projectName || null,
      });
    }
  }

  /**
   * Call this when a Claude chat session starts or ends.
   * @param {Object} event  { event: 'start'|'end', sessionId, projectId?, cwd?, status?, error? }
   */
  onChatSessionEvent(event) {
    if (!event || !event.event) return;
    const targetType = event.event === 'start'
      ? 'claude_session_start'
      : 'claude_session_end';

    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== targetType) continue;
      if (trigger.projectId && trigger.projectId !== event.projectId) continue;

      if (targetType === 'claude_session_end') {
        const wanted = trigger.statusFilter || 'any';
        if (wanted !== 'any' && wanted !== event.status) continue;
      }

      this.dispatch?.(wf.id, {
        source:    targetType,
        sessionId: event.sessionId || null,
        projectId: event.projectId || null,
        cwd:       event.cwd || null,
        status:    event.status || null,
        error:     event.error || null,
      });
    }
  }

  /**
   * Stop all timers / teardown.
   */
  destroy() {
    if (this._cronTimer) {
      clearTimeout(this._cronTimer);   // works for both setTimeout and setInterval handles
      clearInterval(this._cronTimer);
      this._cronTimer = null;
    }
    this._cronJobs.clear();
    this._teardownAllFileWatchers();
    this._teardownAllGitWatchers();
    this._workflows = [];
  }

  /**
   * Call this when a chat message (user prompt or assistant reply) is emitted.
   * @param {Object} event  { role: 'user'|'assistant', text: string, projectId?, sessionId? }
   */
  onChatMessage(event) {
    if (!event || !event.text) return;
    // Cap the tested text length — a huge chat payload against a regex is a
    // classic ReDoS vector. 100k chars is far more than any real prompt.
    let text = String(event.text);
    if (text.length > 100_000) text = text.slice(0, 100_000);
    const role = event.role || 'assistant';

    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'chat_message') continue;
      if (trigger.projectId && trigger.projectId !== event.projectId) continue;

      const wantedRole = trigger.role || 'any';
      if (wantedRole !== 'any' && wantedRole !== role) continue;

      const pattern = (trigger.pattern || '').trim();
      if (pattern) {
        const compiled = this._chatRegexes.get(wf.id);
        const mode = compiled?.mode || trigger.matchMode || 'contains';
        let ok = false;
        if (mode === 'regex') {
          // Use the pre-compiled regex; a null re means the pattern was invalid.
          const re = compiled?.re;
          if (!re) continue;
          try { ok = re.test(text); }
          catch (_) { ok = false; }
        } else {
          ok = text.toLowerCase().includes(pattern.toLowerCase());
        }
        if (!ok) continue;
      }

      this.dispatch?.(wf.id, {
        source:    'chat_message',
        role,
        text,
        projectId: event.projectId || null,
        sessionId: event.sessionId || null,
      });
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  _rebuildCronJobs() {
    this._cronJobs.clear();
    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'cron') continue;
      if (!trigger.value) continue;

      try {
        const matcher = parseCron(trigger.value);
        this._cronJobs.set(wf.id, { matcher, name: wf.name });
      } catch (err) {
        console.warn(`[WorkflowScheduler] Bad cron for "${wf.name}": ${err.message}`);
      }
    }
  }

  _rebuildChatRegexes() {
    this._chatRegexes.clear();
    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'chat_message') continue;

      const pattern = (trigger.pattern || '').trim();
      const mode    = trigger.matchMode || 'contains';
      if (!pattern || mode !== 'regex') {
        this._chatRegexes.set(wf.id, { re: null, pattern, mode });
        continue;
      }
      let re = null;
      try {
        re = new RegExp(pattern);
      } catch (err) {
        // Invalid pattern must never throw inside the event loop — disable it.
        console.warn(`[WorkflowScheduler] Invalid chat_message regex for "${wf.name || wf.id}": ${err.message}`);
        re = null;
      }
      this._chatRegexes.set(wf.id, { re, pattern, mode });
    }
  }

  _ensureCronTimer() {
    // No cron jobs left → stop the ticker entirely, don't waste a 60s interval.
    if (this._cronJobs.size === 0) {
      if (this._cronTimer) {
        clearTimeout(this._cronTimer);
        clearInterval(this._cronTimer);
        this._cronTimer = null;
      }
      return;
    }
    if (this._cronTimer) return; // already running
    // Align to next full minute, then tick every 60s
    const now   = Date.now();
    const delay = 60_000 - (now % 60_000);
    // Assign a sentinel immediately to prevent duplicate timers during the delay.
    const handle = setTimeout(() => {
      // Guard against a destroy()/reload() that ran during the initial delay:
      // only promote to an interval if we are still the active timer handle.
      if (this._cronTimer !== handle) return;
      this._tick();
      this._cronTimer = setInterval(() => this._tick(), 60_000);
    }, delay);
    this._cronTimer = handle;
  }

  _tick() {
    const now = new Date();
    // Absolute minute index — robust against 0-59 wraparound / timer drift.
    const minuteIndex = Math.floor(Date.now() / 60_000);

    // Guard: only fire once per minute.
    if (minuteIndex === this._lastTickMin) return;
    this._lastTickMin = minuteIndex;

    for (const [wfId, { matcher }] of this._cronJobs) {
      if (matcher(now)) {
        this.dispatch?.(wfId, {
          source: 'cron',
          firedAt: now.toISOString(),
        });
      }
    }
  }

  // ─── File watchers (file_change trigger) ────────────────────────────────────

  _rebuildFileWatchers() {
    // Snapshot current trigger configs — key them by a stable fingerprint so
    // we reuse existing watchers when nothing changed (avoids storm of
    // file-system teardown/re-setup on every workflow reload).
    const desired = new Map();
    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'file_change') continue;

      const watchPath = this._resolveWatchPath(trigger);
      if (!watchPath) continue;

      desired.set(wf.id, {
        watchPath,
        patterns: (trigger.patterns || '').trim(),
        events:   trigger.events || 'all',
        debounceMs: trigger.debounceMs != null ? Number(trigger.debounceMs) : 500,
      });
    }

    // Tear down watchers no longer needed / whose config changed
    for (const [wfId, entry] of this._fileWatchers) {
      const target = desired.get(wfId);
      const changed = !target || JSON.stringify(target) !== entry.fingerprint;
      if (changed) {
        this._teardownFileWatcher(wfId);
      }
    }

    // Set up new/updated watchers
    for (const [wfId, cfg] of desired) {
      if (this._fileWatchers.has(wfId)) continue; // still alive with same config
      this._setupFileWatcher(wfId, cfg);
    }
  }

  _setupFileWatcher(wfId, cfg) {
    let chokidar;
    try {
      chokidar = require('chokidar');
    } catch (err) {
      console.warn(`[WorkflowScheduler] chokidar unavailable — file_change disabled: ${err.message}`);
      return;
    }

    const targetPattern = cfg.patterns
      ? path.join(cfg.watchPath, cfg.patterns).replace(/\\/g, '/')
      : cfg.watchPath;

    const watcher = chokidar.watch(targetPattern, {
      ignoreInitial: true,
      ignored: /(^|[\/\\])(\.git|node_modules|dist|build|\.next|\.nuxt|target|\.DS_Store)/,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    const acceptedEvents = new Set(
      cfg.events === 'all'
        ? ['add', 'change', 'unlink']
        : cfg.events.split(',').map(s => s.trim()).filter(Boolean)
    );

    let debounceTimer = null;
    const pendingPaths = new Set();
    let lastEventType = null;

    const fireDebounced = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const paths = [...pendingPaths];
        pendingPaths.clear();
        this.dispatch?.(wfId, {
          source:    'file_change',
          eventType: lastEventType,
          path:      paths[0] || null,
          paths,
          watchPath: cfg.watchPath,
        });
      }, cfg.debounceMs);
    };

    const onEvent = (eventType) => (filePath) => {
      if (!acceptedEvents.has(eventType)) return;
      lastEventType = eventType;
      pendingPaths.add(filePath);
      fireDebounced();
    };

    watcher.on('add',    onEvent('add'));
    watcher.on('change', onEvent('change'));
    watcher.on('unlink', onEvent('unlink'));
    watcher.on('error',  (err) => {
      console.warn(`[WorkflowScheduler] file watcher error (${wfId}):`, err.message);
    });

    this._fileWatchers.set(wfId, {
      watcher,
      fingerprint: JSON.stringify(cfg),
      clearDebounce: () => { if (debounceTimer) clearTimeout(debounceTimer); },
    });
  }

  _teardownFileWatcher(wfId) {
    const entry = this._fileWatchers.get(wfId);
    if (!entry) return;
    try { entry.clearDebounce?.(); } catch (_) {}
    try { entry.watcher.close(); } catch (_) {}
    this._fileWatchers.delete(wfId);
  }

  _teardownAllFileWatchers() {
    for (const wfId of [...this._fileWatchers.keys()]) {
      this._teardownFileWatcher(wfId);
    }
  }

  // ─── Git watchers (git_event trigger) ───────────────────────────────────────

  _rebuildGitWatchers() {
    const desired = new Map();
    for (const wf of this._workflows) {
      if (!wf.enabled) continue;
      const trigger = wf.trigger || {};
      if (trigger.type !== 'git_event') continue;

      const repoPath = trigger.projectId && typeof this.resolveProjectPath === 'function'
        ? this.resolveProjectPath(trigger.projectId)
        : null;
      if (!repoPath) continue;

      desired.set(wf.id, {
        repoPath,
        eventFilter: trigger.eventFilter || 'any',
        branch:      (trigger.branch || '').trim(),
        projectId:   trigger.projectId,
      });
    }

    // Tear down obsolete watchers
    for (const [wfId, entry] of this._gitWatchers) {
      const target = desired.get(wfId);
      const changed = !target || JSON.stringify({
        repoPath:    target.repoPath,
        eventFilter: target.eventFilter,
        branch:      target.branch,
      }) !== entry.fingerprint;
      if (changed) this._teardownGitWatcher(wfId);
    }

    // Set up new watchers
    for (const [wfId, cfg] of desired) {
      if (this._gitWatchers.has(wfId)) continue;
      this._setupGitWatcher(wfId, cfg);
    }
  }

  _setupGitWatcher(wfId, cfg) {
    let chokidar;
    try {
      chokidar = require('chokidar');
    } catch (err) {
      console.warn(`[WorkflowScheduler] chokidar unavailable — git_event disabled: ${err.message}`);
      return;
    }

    const headLog = path.join(cfg.repoPath, '.git', 'logs', 'HEAD');
    const remotesDir = path.join(cfg.repoPath, '.git', 'logs', 'refs', 'remotes');

    let lastOffset = 0;
    try { lastOffset = fs.statSync(headLog).size; } catch (_) { /* repo without log yet */ }

    const parseLine = (line) => {
      // format: "<oldSha> <newSha> <name> <email> <ts> <tz>\t<type>[: ...]"
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) return null;
      const descr = line.slice(tabIdx + 1);
      const colon = descr.indexOf(':');
      const kind  = (colon >= 0 ? descr.slice(0, colon) : descr).trim().toLowerCase();
      const rest  = colon >= 0 ? descr.slice(colon + 1).trim() : '';
      return { kind, rest };
    };

    const handleHeadChange = () => {
      let size;
      try { size = fs.statSync(headLog).size; } catch (_) { return; }
      if (size === lastOffset) return; // no change
      if (size < lastOffset) {
        // Log was truncated / rewritten (e.g. `git gc`, reflog expire, fresh clone
        // over the same path). Our old offset is stale — re-read from the start so
        // we don't silently miss the new entries.
        console.warn(`[WorkflowScheduler] git log truncated for ${cfg.repoPath}; re-reading from start`);
        lastOffset = 0;
      }

      let buf;
      try {
        const fd = fs.openSync(headLog, 'r');
        const len = size - lastOffset;
        buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastOffset);
        fs.closeSync(fd);
      } catch (_) {
        return;
      }
      lastOffset = size;

      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        let eventType = null;
        if (parsed.kind === 'commit' || parsed.kind === 'commit (initial)' || parsed.kind === 'commit (amend)') {
          eventType = 'commit';
        } else if (parsed.kind === 'checkout') {
          eventType = 'branch_switch';
        } else if (parsed.kind === 'merge' || parsed.kind === 'pull') {
          eventType = 'commit';
        }
        if (!eventType) continue;
        if (cfg.eventFilter !== 'any' && cfg.eventFilter !== eventType) continue;

        const branch = readCurrentBranch(cfg.repoPath);
        if (cfg.branch && !matchesBranch(cfg.branch, branch)) continue;

        this.dispatch?.(wfId, {
          source:    'git_event',
          eventType,
          message:   parsed.rest,
          branch,
          projectId: cfg.projectId,
          repoPath:  cfg.repoPath,
        });
      }
    };

    const handlePush = (filePath) => {
      if (cfg.eventFilter !== 'any' && cfg.eventFilter !== 'push') return;
      const branch = readCurrentBranch(cfg.repoPath);
      if (cfg.branch && !matchesBranch(cfg.branch, branch)) return;
      this.dispatch?.(wfId, {
        source:    'git_event',
        eventType: 'push',
        message:   path.basename(filePath),
        branch,
        projectId: cfg.projectId,
        repoPath:  cfg.repoPath,
      });
    };

    const watcher = chokidar.watch([headLog, remotesDir], {
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    watcher.on('change', (p) => {
      if (p === headLog || p.endsWith('HEAD')) handleHeadChange();
      else if (p.includes(`${path.sep}remotes${path.sep}`)) handlePush(p);
    });
    watcher.on('add', (p) => {
      if (p.includes(`${path.sep}remotes${path.sep}`)) handlePush(p);
    });
    watcher.on('error', (err) => {
      console.warn(`[WorkflowScheduler] git watcher error (${wfId}):`, err.message);
    });

    this._gitWatchers.set(wfId, {
      watcher,
      fingerprint: JSON.stringify({
        repoPath:    cfg.repoPath,
        eventFilter: cfg.eventFilter,
        branch:      cfg.branch,
      }),
    });
  }

  _teardownGitWatcher(wfId) {
    const entry = this._gitWatchers.get(wfId);
    if (!entry) return;
    try { entry.watcher.close(); } catch (_) {}
    this._gitWatchers.delete(wfId);
  }

  _teardownAllGitWatchers() {
    for (const wfId of [...this._gitWatchers.keys()]) {
      this._teardownGitWatcher(wfId);
    }
  }

  _resolveWatchPath(trigger) {
    // Priority: explicit path > project path > none.
    if (trigger.watchPath && trigger.watchPath.trim()) {
      return trigger.watchPath.trim();
    }
    if (trigger.projectId && typeof this.resolveProjectPath === 'function') {
      return this.resolveProjectPath(trigger.projectId) || null;
    }
    return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true when `exitCode` matches the filter expression.
 * Filter grammar:
 *   ""  | "any"       → always match
 *   "success" | "0"   → match exit 0
 *   "error" | "non-zero" → match any non-zero code
 *   "1,2,127"         → comma-separated list of exact codes
 */
function matchesExitCode(filter, exitCode) {
  if (exitCode == null) return false;
  const raw = (filter == null ? '' : String(filter)).trim().toLowerCase();
  if (!raw || raw === 'any' || raw === '*') return true;
  if (raw === 'success' || raw === '0') return exitCode === 0;
  if (raw === 'error' || raw === 'non-zero' || raw === 'nonzero') return exitCode !== 0;
  // list of exact codes
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (!Number.isNaN(n) && n === exitCode) return true;
  }
  return false;
}

/**
 * Compare two filesystem paths for equality (case-insensitive on Windows).
 */
function pathsEqual(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  const A = norm(a);
  const B = norm(b);
  if (process.platform === 'win32') {
    return A.toLowerCase() === B.toLowerCase();
  }
  return A === B;
}

/**
 * Match a tool name against a comma-separated pattern list.
 * Supports `*` wildcards (e.g. "Bash, Edit, Write" or "mcp__*").
 */
function matchesToolName(pattern, toolName) {
  if (!pattern) return true;
  if (!toolName) return false;
  const parts = pattern.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return true;
  for (const p of parts) {
    if (p === '*') return true;
    if (p === toolName) return true;
    if (p.includes('*')) {
      const re = new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$');
      if (re.test(toolName)) return true;
    }
  }
  return false;
}

/**
 * Match a command string against a regex (preferred) or substring pattern.
 * Pattern starting with `/.../` is treated as a regex.
 */
function matchesCommandPattern(pattern, command) {
  if (!pattern) return true;
  const trimmed = pattern.trim();
  const reMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  if (reMatch) {
    try { return new RegExp(reMatch[1], reMatch[2]).test(command || ''); }
    catch (_) { return false; }
  }
  return (command || '').toLowerCase().includes(trimmed.toLowerCase());
}

/**
 * Match a git branch against an exact name or `/regex/` pattern.
 */
function matchesBranch(pattern, branch) {
  if (!pattern) return true;
  if (!branch) return false;
  const trimmed = pattern.trim();
  const reMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
  if (reMatch) {
    try { return new RegExp(reMatch[1], reMatch[2]).test(branch); }
    catch (_) { return false; }
  }
  return branch === trimmed;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the current branch of a git repo (best-effort, sync).
 * Returns null if the HEAD file is missing or unreadable.
 */
function readCurrentBranch(repoPath) {
  try {
    const head = fs.readFileSync(path.join(repoPath, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s+refs\/heads\/(.+)$/);
    return m ? m[1] : head.slice(0, 12); // detached HEAD → short SHA
  } catch (_) {
    return null;
  }
}

module.exports = WorkflowScheduler;
module.exports.parseCron = parseCron;
