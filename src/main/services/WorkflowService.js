/**
 * WorkflowService
 * Central orchestrator for the workflow automation system.
 *
 * Responsibilities:
 *   - CRUD workflow definitions (delegates to WorkflowStorage)
 *   - Maintain in-memory execution map (active runs)
 *   - Enforce concurrency policies (skip / queue / parallel) per workflow
 *   - Resolve depends_on chains (lazy, cached, no-double-exec)
 *   - Build context variables ($ctx.branch, $ctx.lastCommit, …)
 *   - Emit real-time events to renderer (workflow-run-*, workflow-step-update)
 *   - Forward scheduler triggers (cron, hooks, on_workflow)
 *   - Expose approve-wait / cancel APIs
 */

'use strict';

const crypto    = require('crypto');
const events    = require('events');
const fs        = require('fs');
const path      = require('path');

const storage   = require('./WorkflowStorage');
const WorkflowRunner    = require('./WorkflowRunner');
const WorkflowScheduler = require('./WorkflowScheduler');
const { getCurrentBranch, getRecentCommits } = require('../utils/git');
const { isSimpleTask, isOnce } = require('../../shared/simple-task');

// ─── Constants ────────────────────────────────────────────────────────────────

const RUN_STATUS = Object.freeze({
  PENDING:   'pending',
  RUNNING:   'running',
  SUCCESS:   'success',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
  SKIPPED:   'skipped',
  TIMEOUT:   'timeout',
  INTERRUPTED: 'interrupted', // ghost run reconciled at boot (crash/quit mid-run)
});

const MAX_CACHE_ENTRIES = 200;

// ─── WorkflowService ──────────────────────────────────────────────────────────

class WorkflowService {
  constructor() {
    /** @type {BrowserWindow|null} */
    this.mainWindow = null;

    /** @type {Map<string, { run, abortController, resolve, reject }>} */
    this._active = new Map();

    /**
     * Per-workflow queues for concurrency=queue.
     * Map<workflowId, Array<() => Promise>>
     */
    this._queues = new Map();

    /**
     * Cache of recent successful run results for depends_on lazy resolution.
     * Keyed by workflowId only, LRU-ordered (delete+set on hit/write moves the entry
     * to the tail; the head is the least-recently-used). Capped at MAX_CACHE_ENTRIES.
     * Map<workflowId, { completedAt: number, outputs: Object }>
     *
     * CAVEAT: depends_on assumes the dependency target is NOT a `parallel`-concurrency
     * workflow. Because the cache is keyed by workflowId alone, two concurrent runs of
     * the same workflow both write here and the last SUCCESS wins — a dependent reading
     * the cache may see either run's outputs. Only the most recent success is retained.
     */
    this._resultsCache = new Map();

    /**
     * Wait step confirmation registry.
     * Map<`${runId}::${stepId}`, resolveFunction>
     */
    this._waitCallbacks = new Map();

    this._scheduler = new WorkflowScheduler();
    this._scheduler.dispatch = (workflowId, triggerData) => {
      this.trigger(workflowId, { triggerData, source: triggerData.source }).catch(err =>
        console.error(`[WorkflowService] Auto-trigger ${workflowId} failed:`, err.message)
      );
    };
    // Scheduler needs to resolve projectId → absolute path for file_change watchers
    this._scheduler.resolveProjectPath = (projectId) => {
      if (!projectId) return null;
      try {
        const projectsFile = path.join(require('os').homedir(), '.claude-terminal', 'projects.json');
        if (!fs.existsSync(projectsFile)) return null;
        const data = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
        const projects = Array.isArray(data) ? data : (data.projects || []);
        const p = projects.find(x => x && x.id === projectId);
        return p?.path || null;
      } catch { return null; }
    };

    this._chatService = null; // set via setDeps()
    this._projectTypeRegistry = {};
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  setMainWindow(win) {
    this.mainWindow = win;
  }

  /**
   * Inject external service dependencies (to avoid circular requires).
   * @param {Object} deps
   * @param {Object} deps.chatService
   * @param {Object} [deps.projectTypeRegistry]
   */
  setDeps({ chatService, projectTypeRegistry = {}, databaseService = null }) {
    this._chatService = chatService;
    this._projectTypeRegistry = projectTypeRegistry;
    this._databaseService = databaseService;
  }

  /**
   * Bootstrap: load workflows, start scheduler.
   * Call once after main window is ready.
   */
  async init() {
    const workflows = await storage.loadWorkflows();

    // Reconcile ghost runs left as 'running' by a previous crash/quit. At boot no
    // run is actually active (_active is empty), so any history record still marked
    // 'running' is stale → mark it 'interrupted'. This is the safety net for a
    // destroy() that could not finalize its writes before the process exited.
    try {
      const { reconciled } = await storage.reconcileRunningRuns();
      if (reconciled > 0) {
        console.log(`[WorkflowService] Reconciled ${reconciled} interrupted run(s) from a previous session`);
      }
    } catch (err) {
      console.warn('[WorkflowService] Run reconciliation failed:', err.message);
    }

    this._scheduler.reload(workflows);
    this._startMcpTriggerPoll();
    console.log(`[WorkflowService] Initialized with ${workflows.length} workflow(s)`);
  }

  /**
   * Shutdown. Aborts every active run and — best-effort within a short timeout —
   * persists a terminal 'cancelled' status so history isn't left showing 'running'.
   *
   * NOTE: the current caller (services/index.js cleanupServices) is synchronous and
   * does NOT await this. The bounded writes below are best-effort; the guaranteed
   * safety net is init()'s reconcileRunningRuns() on the next boot, which flips any
   * still-'running' record to 'interrupted'. Kept async so a future awaiting caller
   * gets clean finalization.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    this._scheduler.destroy();
    if (this._mcpPollTimer) clearInterval(this._mcpPollTimer);

    const runIds = [];
    for (const [runId, exec] of this._active) {
      try { exec.abortController.abort(); } catch { /* ignore */ }
      runIds.push(runId);
    }
    this._active.clear();

    if (runIds.length === 0) return;

    const finishedAt = new Date().toISOString();
    const writes = runIds.map(runId =>
      storage.updateRun(runId, { status: RUN_STATUS.CANCELLED, finishedAt }).catch(() => {})
    );

    // Bound the wait so shutdown never hangs on slow disk I/O (2s cap).
    const timeout = new Promise(resolve => setTimeout(resolve, 2000));
    await Promise.race([Promise.allSettled(writes), timeout]);
  }

  /**
   * Poll for MCP trigger/cancel request files.
   * The MCP process writes JSON files in workflows/triggers/ since it
   * cannot call WorkflowService directly (separate process).
   *
   * All filesystem access here is async (fs.promises). The tick runs on the same
   * thread that serves every IPC handler and drives the window, so the previous
   * existsSync/readdirSync/renameSync/readFileSync pairs stalled the event loop
   * ~28.8k times a day for a directory that is empty virtually all the time.
   *
   * Concurrency: the tick body was already async (it awaits testNode / loadWorkflows),
   * so two ticks could already overlap before this change. The rename-to-'.processing'
   * claim is what makes that safe — the loser of the race gets ENOENT and skips the
   * file — and fs.promises.rename is the same single atomic syscall as renameSync,
   * so that guarantee is unchanged.
   */
  _startMcpTriggerPoll() {
    const triggersDir = path.join(require('os').homedir(), '.claude-terminal', 'workflows', 'triggers');
    const fsp = fs.promises;
    this._mcpPollTimer = setInterval(async () => {
      try {
        // No existsSync() pre-check: readdir throws ENOENT when the directory was
        // never created, and the outer catch swallows it exactly as before — same
        // observable behaviour, one syscall instead of two.
        // Only pick up freshly-written request files; '.processing' files are ones a
        // previous tick claimed but hasn't finished (or crashed mid-handling).
        const files = (await fsp.readdir(triggersDir)).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(triggersDir, file);
          // Claim the request atomically by renaming to '.processing' BEFORE handling.
          // This prevents the next poll tick from picking up the same file, and — unlike
          // the previous "unlink-then-handle" — the request is not lost if we crash: it
          // survives as a '.processing' file for post-mortem/inspection.
          const procPath = filePath + '.processing';
          try {
            await fsp.rename(filePath, procPath);
          } catch (_) {
            // Someone else claimed it (or it vanished) — skip.
            continue;
          }
          try {
            const data = JSON.parse(await fsp.readFile(procPath, 'utf8'));

            if (data.action === 'cancel' && data.runId) {
              this.cancel(data.runId);
              console.log(`[WorkflowService] MCP cancel: ${data.runId}`);
            } else if (data.action === 'reload') {
              // MCP graph edit tools signal a reload after modifying definitions.json directly
              const reloadedWorkflows = await storage.loadWorkflows();
              this._scheduler.reload(reloadedWorkflows);
              this._send('workflow-list-updated', { workflows: reloadedWorkflows });
              console.log(`[WorkflowService] MCP reload: definitions refreshed`);
            } else if (data.action === 'workflow_deleted' && data.workflowId) {
              // The MCP server deleted a workflow's definition (under the shared
              // cross-process lock) and delegates history/result cleanup to us so
              // history.json stays single-writer (main only). Then refresh the UI.
              await storage.deleteRunsForWorkflow(data.workflowId);
              const reloaded = await storage.loadWorkflows();
              this._scheduler.reload(reloaded);
              this._send('workflow-list-updated', { workflows: reloaded });
              console.log(`[WorkflowService] MCP workflow_deleted: ${data.workflowId}`);
            } else if (data.action === 'test_node' && data.workflowId) {
              // Isolated single-node test requested by an MCP tool. Load the
              // workflow, find the node, and run ONLY that node — never the whole
              // graph (the previous behaviour fell through to trigger() below).
              try {
                const wfs = await storage.loadWorkflows();
                const wf = wfs.find(w => w.id === data.workflowId);
                const node = wf?.graph?.nodes?.find(n => String(n.id) === String(data.nodeId));
                if (node) {
                  const step = {
                    id:   node.id,
                    type: String(node.type || '').replace(/^workflow\//, ''),
                    ...(node.properties || {}),
                  };
                  const result = await this.testNode(step, {});
                  console.log(`[WorkflowService] MCP test_node ${data.workflowId}/${data.nodeId}: ${result?.success ? 'ok' : 'fail'}`);
                } else {
                  console.warn(`[WorkflowService] MCP test_node: node ${data.nodeId} not found in ${data.workflowId}`);
                }
              } catch (err) {
                console.warn('[WorkflowService] MCP test_node failed:', err.message);
              }
            } else if (data.workflowId) {
              this.trigger(data.workflowId, { source: 'mcp' });
              console.log(`[WorkflowService] MCP trigger: ${data.workflowId}`);
            }
            // Handled successfully → remove the claimed request.
            try { await fsp.unlink(procPath); } catch (_) {}
          } catch (e) {
            // Malformed/unreadable request — drop the claimed file so it doesn't
            // linger and re-trigger. (A genuine crash mid-handling still leaves the
            // '.processing' file, which is never re-picked-up by the poll.)
            try { await fsp.unlink(procPath); } catch (_) {}
          }
        }
      } catch (_) {}
    }, 3000);
  }

  // ─── IPC bridge ─────────────────────────────────────────────────────────────

  _send(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  // ─── Hook event forwarding ───────────────────────────────────────────────────

  onHookEvent(hookEvent) {
    this._scheduler.onHookEvent(hookEvent);
  }

  /**
   * Forward terminal exit events to the scheduler.
   * @param {Object} event { exitCode, signal?, projectId?, projectPath?, terminalId? }
   */
  onTerminalExit(event) {
    this._scheduler.onTerminalExit(event);
  }

  /**
   * Forward project-open events to the scheduler.
   * @param {Object} event { projectId, projectPath?, projectName? }
   */
  onProjectOpened(event) {
    this._scheduler.onProjectOpened(event);
  }

  /**
   * Forward chat session lifecycle events to the scheduler.
   * @param {Object} event { event: 'start'|'end', sessionId, projectId?, cwd?, status?, error? }
   */
  onChatSessionEvent(event) {
    this._scheduler.onChatSessionEvent(event);
  }

  /**
   * Forward chat message events (user prompt / assistant reply) to the scheduler.
   * @param {Object} event { role, text, projectId?, cwd?, sessionId?, sdkSessionId?, files?, filesText? }
   */
  onChatMessage(event) {
    this._scheduler.onChatMessage(event);
  }

  // ─── Workflow CRUD ───────────────────────────────────────────────────────────

  async listWorkflows() {
    const workflows = await storage.loadWorkflows();
    // Auto-migrate legacy workflows (steps[] → graph)
    let dirty = false;
    for (let i = 0; i < workflows.length; i++) {
      if (workflows[i].steps && !workflows[i].graph) {
        workflows[i] = migrateStepsToGraph(workflows[i]);
        dirty = true;
      }
    }
    if (dirty) await storage.saveWorkflows(workflows);
    return workflows;
  }

  async getWorkflow(id) {
    const wf = await storage.getWorkflow(id);
    if (wf && wf.steps && !wf.graph) {
      const migrated = migrateStepsToGraph(wf);
      await storage.upsertWorkflow(migrated);
      return migrated;
    }
    return wf;
  }

  /**
   * Create or update a workflow definition.
   * Validates cycle-free depends_on before saving.
   * @param {Object} workflow
   * @returns {{ success: boolean, workflow?: Object, error?: string }}
   */
  async saveWorkflow(workflow) {
    const all = await storage.loadWorkflows();
    const dependsOn = (workflow.dependsOn || []).map(d => d.workflow || d);

    // Structural graph validation (nodes/links arrays, trigger present, link
    // origin/target integrity). Legacy steps[]-only workflows are tolerated.
    const structure = storage.validateWorkflowGraph(workflow);
    if (!structure.valid) {
      return { success: false, error: structure.error };
    }

    // Cycle detection
    const { hasCycle, cycle } = storage.detectCycle(workflow.id || '__new__', dependsOn, all);
    if (hasCycle) {
      return {
        success: false,
        error: `Circular dependency detected: ${cycle.join(' → ')}`,
      };
    }

    const saved = await storage.upsertWorkflow(workflow);
    // The definition changed → its cached outputs are stale for depends_on. Drop them.
    if (saved.id) this._resultsCache.delete(saved.id);
    // Reload scheduler
    this._scheduler.reload(await storage.loadWorkflows());
    return { success: true, workflow: saved };
  }

  /**
   * @param {string} id
   * @returns {{ success: boolean, error?: string }}
   */
  async deleteWorkflow(id) {
    const deleted = await storage.deleteWorkflow(id);
    if (!deleted) return { success: false, error: 'Workflow not found' };
    await storage.deleteRunsForWorkflow(id);
    this._scheduler.reload(await storage.loadWorkflows());
    this._resultsCache.delete(id);
    return { success: true };
  }

  /**
   * Toggle enabled state.
   * @param {string} id
   * @param {boolean} enabled
   */
  async setEnabled(id, enabled) {
    const wf = await storage.getWorkflow(id);
    if (!wf) return { success: false, error: 'Workflow not found' };
    const updated = { ...wf, enabled };
    await storage.upsertWorkflow(updated);
    this._scheduler.reload(await storage.loadWorkflows());
    return { success: true, workflow: updated };
  }

  // ─── Run history ─────────────────────────────────────────────────────────────

  async getRunsForWorkflow(workflowId, limit) {
    return await storage.getRunsForWorkflow(workflowId, limit);
  }

  async getRecentRuns(limit) {
    return await storage.getRecentRuns(limit);
  }

  async clearAllRuns() {
    await storage.clearAllRuns();
  }

  async getRun(runId) {
    return await storage.getRun(runId);
  }

  async getRunResult(runId) {
    return await storage.loadResultPayload(runId);
  }

  getActiveRuns() {
    return [...this._active.values()].map(e => ({ ...e.run }));
  }

  // ─── Trigger ─────────────────────────────────────────────────────────────────

  /**
   * Trigger a workflow by id (manual or from scheduler).
   * Enforces concurrency policy.
   * @param {string} workflowId
   * @param {Object} [opts]
   * @param {Object} [opts.triggerData]  - Data attached to the trigger event
   * @param {string} [opts.source]       - 'manual' | 'cron' | 'hook' | 'on_workflow' | 'subworkflow' | 'depends_on'
   * @param {string} [opts.projectPath]  - Override project path for context variables
   * @param {Object|Map} [opts.extraVars] - Initial variables injected into the run's vars at startup
   * @returns {Promise<{ success: boolean, runId?: string, queued?: boolean, error?: string }>}
   */
  async trigger(workflowId, opts = {}) {
    const workflow = await storage.getWorkflow(workflowId);
    if (!workflow) return { success: false, error: 'Workflow not found' };
    if (!workflow.enabled) return { success: false, error: 'Workflow is disabled' };

    const concurrency = workflow.concurrency || 'skip';
    const isRunning   = this._isRunning(workflowId);

    if (isRunning) {
      if (concurrency === 'skip') {
        return { success: false, skipped: true, error: 'Workflow already running (concurrency: skip)' };
      }
      if (concurrency === 'queue') {
        return this._enqueue(workflowId, opts);
      }
      // parallel — fall through to execute
    }

    return this._startRun(workflow, opts);
  }

  /**
   * Cancel a running or queued run.
   * @param {string} runId
   */
  cancel(runId) {
    const exec = this._active.get(runId);
    if (!exec) return { success: false, error: 'Run not found or already finished' };
    exec.abortController.abort();
    return { success: true };
  }

  /**
   * Approve a wait step (resume execution).
   * @param {string} runId
   * @param {string} stepId
   * @param {Object} [data]  - Optional data passed back to the step
   */
  approveWait(runId, stepId, data = {}) {
    const key = `${runId}::${stepId}`;
    const cb  = this._waitCallbacks.get(key);
    if (!cb) return { success: false, error: 'Wait step not found' };
    cb({ approved: true, data });
    return { success: true };
  }

  // ─── Dependency resolution ───────────────────────────────────────────────────

  /**
   * Resolve all depends_on for a workflow.
   * Returns a Map of workflowId → outputs for use as extraVars.
   * Lazy: uses cache if within max_age; triggers run if stale/missing.
   * @param {Object} workflow
   * @param {Set<string>} [inProgress]  - IDs currently being resolved (cycle guard)
   * @returns {Promise<Map<string, any>>}
   */
  async _resolveDependencies(workflow, inProgress = new Set()) {
    const deps    = workflow.dependsOn || [];
    const extraVars = new Map();

    for (const dep of deps) {
      const depId   = dep.workflow;
      const maxAge  = dep.max_age ? parseMs(dep.max_age) : null;

      // Prevent circular wait
      if (inProgress.has(depId)) {
        console.warn(`[WorkflowService] Circular dependency skip: ${depId}`);
        continue;
      }

      // Check cache
      const cached = this._resultsCache.get(depId);
      const isValid = cached && (!maxAge || Date.now() - cached.completedAt < maxAge);

      if (isValid) {
        // LRU touch: re-insert so this entry moves to the tail (most-recently-used).
        this._resultsCache.delete(depId);
        this._resultsCache.set(depId, cached);
        extraVars.set(depId, cached.outputs);
        continue;
      }

      // Check if dep is already running — wait for it
      const running = this._findRunningByWorkflowId(depId);
      if (running) {
        console.log(`[WorkflowService] Waiting for in-flight dependency: ${depId}`);
        let failed = false;
        const result = await running.promise.catch(err => {
          failed = true;
          console.warn(`[WorkflowService] depends_on "${depId}" (in-flight) failed: ${err?.message || err}`);
          return {};
        });
        // Distinguish a failed dependency from a genuinely-empty success: attach a
        // _depFailed flag so a downstream step/condition can react to it, and mark
        // this run degraded so a silent bad-data run isn't reported as clean.
        if (failed) {
          extraVars.set(depId, { _depFailed: true, outputs: {} });
          this._depsDegraded = true;
        } else {
          extraVars.set(depId, result.outputs || {});
        }
        continue;
      }

      // Not running, not cached — trigger it and wait
      inProgress.add(depId);
      const depWorkflow = await storage.getWorkflow(depId);
      if (!depWorkflow) {
        // Missing dependency: warn loudly and expose a failure flag rather than
        // silently injecting nothing (which looked like a successful empty run).
        console.warn(`[WorkflowService] depends_on workflow not found: ${depId} — injecting _depFailed flag`);
        extraVars.set(depId, { _depFailed: true, _reason: 'not_found', outputs: {} });
        this._depsDegraded = true;
        inProgress.delete(depId);
        continue;
      }

      const { runId } = await this._startRun(depWorkflow, { source: 'depends_on' }, inProgress);
      // Wait for it to finish
      const exec = this._active.get(runId);
      if (exec) {
        let failed = false;
        const result = await exec.promise.catch(err => {
          failed = true;
          console.warn(`[WorkflowService] depends_on "${depId}" run failed: ${err?.message || err}`);
          return {};
        });
        if (failed || result?.success === false) {
          extraVars.set(depId, { _depFailed: true, outputs: result?.outputs || {} });
          this._depsDegraded = true;
        } else {
          extraVars.set(depId, result.outputs || {});
        }
      }

      inProgress.delete(depId);
    }

    return extraVars;
  }

  // ─── Core run logic ──────────────────────────────────────────────────────────

  async _startRun(workflow, opts = {}, inProgress = new Set()) {
    const runId      = `run_${crypto.randomUUID().slice(0, 12)}`;
    const startedAt  = new Date().toISOString();
    const source     = opts.source || 'manual';
    const triggerData = opts.triggerData || {};

    // Build context variables
    const projectPath = opts.projectPath || this._resolveProjectPath(workflow) || '';
    const contextVars = await this._buildContext(workflow, projectPath);
    contextVars.projectPath = projectPath; // Pass to runner for ctx.project

    // Build step list from graph or legacy steps — sorted by execution order (BFS)
    let runSteps;
    if (workflow.graph && workflow.graph.nodes) {
      const ordered = this._bfsNodeOrder(workflow.graph);
      runSteps = ordered.map(n => ({
        id:     `node_${n.id}`,
        type:   n.type.replace('workflow/', ''),
        status: RUN_STATUS.PENDING,
        duration: null,
      }));
    } else {
      runSteps = (workflow.steps || []).map(s => ({
        id:     s.id,
        type:   s.type,
        status: RUN_STATUS.PENDING,
        duration: null,
      }));
    }

    const run = {
      id:          runId,
      workflowId:  workflow.id,
      workflowName: workflow.name,
      status:      RUN_STATUS.RUNNING,
      trigger:     source,
      triggerData,
      startedAt,
      duration:    null,
      steps:       runSteps,
      ...contextVars,
    };

    // Persist initial record
    await storage.appendRun(run);

    // Emit to renderer
    this._send('workflow-run-start', { run });

    const abortController = new AbortController();
    // Allow many parallel listeners (loop iterations, per-step timeouts, SDK internals…)
    events.setMaxListeners(200, abortController.signal);

    let resolveExec, rejectExec;
    const promise = new Promise((res, rej) => { resolveExec = res; rejectExec = rej; });

    this._active.set(runId, { run, abortController, promise, resolve: resolveExec, reject: rejectExec });

    // Execute asynchronously
    this._executeRun(workflow, run, abortController, inProgress, opts)
      .then(async result => {
        await this._finalizeRun(run, result, workflow);
        resolveExec(result);
      })
      .catch(async err => {
        await this._finalizeRun(run, { success: false, error: err.message, outputs: {} }, workflow);
        rejectExec(err);
      })
      .finally(async () => {
        this._active.delete(runId);
        await this._drainQueue(workflow.id);
      });

    return { success: true, runId };
  }

  /**
   * Test a single node in isolation (called from graph editor "Test" button).
   * @param {Object} stepData  - { type, ...properties }
   * @param {Object} [ctx]     - context hints (project path, etc.)
   * @returns {Promise<{ success, output, error, duration }>}
   */
  async testNode(stepData, ctx = {}) {
    const runner = new WorkflowRunner({
      sendFn:              () => {},   // no-op: test output returned directly
      chatService:         this._chatService,
      waitCallbacks:       this._waitCallbacks,
      projectTypeRegistry: this._projectTypeRegistry,
      databaseService:     this._databaseService,
      workflowService:     this,
    });
    return runner.testStep(stepData, ctx);
  }

  async _executeRun(workflow, run, abortController, inProgress, opts) {
    // 1. Resolve dependencies.
    //    Seed the cycle guard with THIS workflow's id so a deep chain that loops
    //    back to it (A→B→A) is detected at runtime even if it slipped past the
    //    save-time detectCycle() check.
    let extraVars = new Map();
    let depsDegraded = false;
    if (workflow.dependsOn?.length) {
      const guard = new Set(inProgress);
      guard.add(workflow.id);
      // _depsDegraded is set inside _resolveDependencies when a dependency failed or
      // was not found. Snapshot + reset it around this call so parallel runs don't
      // clobber each other's flag.
      this._depsDegraded = false;
      extraVars = await this._resolveDependencies(workflow, guard);
      depsDegraded = this._depsDegraded === true;
    }

    // 1b. Inject caller-supplied initial variables (e.g. from a subworkflow node).
    //     These are seeded into the run's vars at startup. Object form → per-key
    //     entries; Map form → merged directly. depends_on results take precedence
    //     only if they share a key (added first, so extraVars below can override).
    const initialVars = opts?.extraVars;
    if (initialVars) {
      if (initialVars instanceof Map) {
        for (const [k, v] of initialVars) extraVars.set(k, v);
      } else if (typeof initialVars === 'object') {
        for (const [k, v] of Object.entries(initialVars)) extraVars.set(k, v);
      }
    }

    // 2. Create runner
    const runner = new WorkflowRunner({
      sendFn:              this._send.bind(this),
      chatService:         this._chatService,
      waitCallbacks:       this._waitCallbacks,
      projectTypeRegistry: this._projectTypeRegistry,
      databaseService:     this._databaseService,
      workflowService:     this,
    });

    // 3. Execute
    const result = await runner.execute(workflow, run, abortController, extraVars);

    // If a dependency failed / was missing, the run ran on incomplete inputs — mark
    // it degraded so _finalizeRun records FAILED instead of a misleading SUCCESS.
    if (depsDegraded && result && result.success && !result.cancelled && !result.timedOut) {
      return { ...result, success: false, degraded: true, error: result.error || 'A dependency failed or was not found' };
    }
    return result;
  }

  async _finalizeRun(run, result, workflow) {
    const now      = Date.now();
    const duration = Math.round((now - new Date(run.startedAt).getTime()) / 1000);
    // Order matters: timeout and cancel are distinct terminal states; a run that
    // only "recovered" from handled errors (result.degraded) counts as failed.
    const status   = result.timedOut
      ? RUN_STATUS.TIMEOUT
      : result.cancelled
        ? RUN_STATUS.CANCELLED
        : result.success
          ? RUN_STATUS.SUCCESS
          : RUN_STATUS.FAILED;

    // Build final steps array with statuses and outputs
    const finalSteps = (run.steps || []).map(s => {
      const tracked = result.stepStatuses?.get(s.id);
      if (tracked) {
        return { ...s, status: tracked.status, output: tracked.output };
      }
      // Steps that were never reached remain pending → mark as skipped
      if (s.status === 'pending') return { ...s, status: 'skipped' };
      return s;
    });

    const patch = {
      status,
      duration: `${duration}s`,
      finishedAt: new Date().toISOString(),
      steps: finalSteps,
    };
    await storage.updateRun(run.id, patch);

    // Persist large output payload separately
    if (result.outputs && Object.keys(result.outputs).length) {
      await storage.saveResultPayload(run.id, { outputs: result.outputs });
    }

    // Update results cache (only on the LAST success), keyed by workflowId for
    // depends_on lookup. delete+set keeps LRU insertion order (entry moves to tail).
    if (status === RUN_STATUS.SUCCESS) {
      this._resultsCache.delete(workflow.id);
      this._resultsCache.set(workflow.id, {
        completedAt: now,
        outputs:     result.outputs || {},
      });
      // Evict the least-recently-used entry (Map head) when over the cap.
      if (this._resultsCache.size > MAX_CACHE_ENTRIES) {
        const lruKey = this._resultsCache.keys().next().value;
        if (lruKey !== undefined) this._resultsCache.delete(lruKey);
      }
    }

    // Notify renderer
    this._send('workflow-run-end', {
      runId:      run.id,
      workflowId: run.workflowId,
      status,
      duration:   patch.duration,
      error:      result.error,
    });

    // Notify on_workflow triggers (timeout counts as a non-success completion)
    if (status === RUN_STATUS.SUCCESS || status === RUN_STATUS.FAILED || status === RUN_STATUS.TIMEOUT) {
      this._scheduler.onWorkflowComplete(workflow.id, {
        success:    status === RUN_STATUS.SUCCESS,
        outputs:    result.outputs || {},
        workflowId: workflow.id,
        // Propagate the on_workflow chain lineage so the scheduler's recursion
        // guard (depth/cycle detection) stays effective across chained runs.
        _chainLineage: run.triggerData?._chainLineage,
        _chainDepth:   run.triggerData?._chainDepth,
      });
    }

    // Send desktop notification on failure or timeout
    if (status === RUN_STATUS.FAILED || status === RUN_STATUS.TIMEOUT) {
      this._send('workflow-notify-desktop', {
        title:   `Workflow ${status === RUN_STATUS.TIMEOUT ? 'timed out' : 'failed'}: ${workflow.name}`,
        message: result.error || 'An error occurred',
        type:    'error',
      });
    }

    // One-shot tasks (simple mode, schedule.kind === 'once') disable themselves
    // after they succeed. Their cron expression pins a day-of-month + month, so
    // without this they would fire again a year later.
    if (status === RUN_STATUS.SUCCESS && isSimpleTask(workflow) && isOnce(workflow.simple)) {
      try {
        await this.setEnabled(workflow.id, false);
      } catch (e) {
        console.error(`[WorkflowService] Failed to disable one-shot task ${workflow.id}:`, e.message);
      }
    }
  }

  // ─── Concurrency queue ───────────────────────────────────────────────────────

  _isRunning(workflowId) {
    for (const { run } of this._active.values()) {
      if (run.workflowId === workflowId) return true;
    }
    return false;
  }

  _findRunningByWorkflowId(workflowId) {
    for (const exec of this._active.values()) {
      if (exec.run.workflowId === workflowId) return exec;
    }
    return null;
  }

  _enqueue(workflowId, opts) {
    if (!this._queues.has(workflowId)) this._queues.set(workflowId, []);
    const queue = this._queues.get(workflowId);

    return new Promise((resolve) => {
      queue.push({ opts, resolve });
      // Notify renderer a run is queued
      this._send('workflow-run-queued', { workflowId, queueLength: queue.length });
    });
  }

  async _drainQueue(workflowId) {
    const queue = this._queues.get(workflowId);
    if (!queue || !queue.length) return;
    const { opts, resolve } = queue.shift();
    if (!queue.length) this._queues.delete(workflowId);
    const workflow = await storage.getWorkflow(workflowId);
    if (!workflow || !workflow.enabled) { resolve({ success: false, error: 'Workflow disabled' }); return; }
    this._startRun(workflow, opts)
      .then(resolve)
      .catch(() => resolve({ success: false, error: 'Queue run failed' }));
  }

  // ─── Context variable builders ────────────────────────────────────────────────

  async _buildContext(workflow, projectPath) {
    const vars = {};
    const cwd  = projectPath || this._resolveProjectPath(workflow);
    if (cwd) {
      try {
        vars.contextBranch = await getCurrentBranch(cwd);
        const commits = await getRecentCommits(cwd, 1);
        vars.contextCommit = commits[0]
          ? `${commits[0].hash} ${commits[0].message}`
          : '';
      } catch { /* git info optional */ }
    }
    return vars;
  }

  _resolveProjectPath(workflow) {
    // Scope.project = 'specific' may carry a path in scope.projectPath
    return workflow.scope?.projectPath || null;
  }

  /**
   * BFS from trigger node to get nodes in execution order.
   * Only follows exec links (type === 'exec' or slot 0/1 of non-data outputs).
   */
  _bfsNodeOrder(graph) {
    const { nodes = [], links = [] } = graph;
    if (!nodes.length) return [];

    const trigger = nodes.find(n => n.type === 'workflow/trigger');
    if (!trigger) return nodes.filter(n => n.type !== 'workflow/trigger');

    // Build outgoing exec adjacency: nodeId → Set<targetNodeId>
    const outExec = new Map();
    for (const link of links) {
      // link: [id, originId, originSlot, targetId, targetSlot, type]
      const originId = link[1], targetId = link[3], targetSlot = link[4], type = link[5];
      // Exec links connect to slot 0 (the "In" exec pin) and have type 'exec' or -1
      if (targetSlot === 0 || type === 'exec' || type === -1 || type == null) {
        if (!outExec.has(originId)) outExec.set(originId, new Set());
        outExec.get(originId).add(targetId);
      }
    }

    const visited = new Set();
    const ordered = [];
    const queue = [trigger.id];
    visited.add(trigger.id);

    // Build the set of nodes that are children of any loop (slot 0 = Each body)
    // so we can exclude them from the top-level step list.
    const loopChildNodes = new Set();
    for (const node of nodes) {
      if (node.type === 'workflow/loop') {
        // Collect all nodes reachable via slot 0 (Each body) of this loop
        const bodyQueue = [...(outExec.get(node.id) || [])];
        // outExec only covers slot 0 links (the "Each" path) — but we need to
        // distinguish slot 0 (Each) from slot 1 (Done). Rebuild per-slot map.
        const outSlot0 = new Map();
        for (const link of links) {
          const originId = link[1], targetId = link[3], originSlot = link[2];
          if (originId === node.id && originSlot === 0) {
            if (!outSlot0.has(originId)) outSlot0.set(originId, []);
            outSlot0.get(originId).push(targetId);
          }
        }
        const bodyStart = outSlot0.get(node.id) || [];
        const bodyVisited = new Set();
        const bq = [...bodyStart];
        while (bq.length) {
          const bid = bq.shift();
          if (bodyVisited.has(bid)) continue;
          bodyVisited.add(bid);
          loopChildNodes.add(bid);
          for (const nid of (outExec.get(bid) || [])) {
            if (!bodyVisited.has(nid)) bq.push(nid);
          }
        }
      }
    }

    while (queue.length > 0) {
      const id = queue.shift();
      const node = nodes.find(n => n.id === id);
      if (node && node.type !== 'workflow/trigger' && !loopChildNodes.has(id)) {
        ordered.push(node);
      }
      // Don't traverse into loop body nodes (slot 0 children) — they're not top-level steps
      if (node?.type === 'workflow/loop') {
        // Only follow slot 1 (Done) for the BFS continuation — not slot 0 (Each body)
        for (const link of links) {
          const originId = link[1], targetId = link[3], originSlot = link[2];
          if (originId === id && originSlot === 1 && !visited.has(targetId)) {
            visited.add(targetId);
            queue.push(targetId);
          }
        }
      } else {
        for (const nextId of (outExec.get(id) || [])) {
          if (!visited.has(nextId)) {
            visited.add(nextId);
            queue.push(nextId);
          }
        }
      }
    }

    // Append any unvisited non-child nodes (disconnected) at the end
    for (const n of nodes) {
      if (n.type !== 'workflow/trigger' && !visited.has(n.id) && !loopChildNodes.has(n.id)) {
        ordered.push(n);
      }
    }

    return ordered;
  }

  // ─── Dependency graph for UI ─────────────────────────────────────────────────

  /**
   * Return a simple adjacency list for the UI dependency graph panel.
   * @returns {{ nodes: Object[], edges: Object[] }}
   */
  async getDependencyGraph() {
    const workflows = await storage.loadWorkflows();
    const nodes = workflows.map(wf => ({
      id:      wf.id,
      name:    wf.name,
      enabled: wf.enabled,
    }));
    const edges = [];
    for (const wf of workflows) {
      for (const dep of (wf.dependsOn || [])) {
        edges.push({ from: wf.id, to: dep.workflow || dep, maxAge: dep.max_age });
      }
      // on_workflow trigger
      if (wf.trigger?.type === 'on_workflow') {
        const target = workflows.find(w => w.id === wf.trigger.value || w.name === wf.trigger.value);
        if (target) edges.push({ from: target.id, to: wf.id, type: 'chain' });
      }
    }
    return { nodes, edges };
  }
}

// ─── Legacy migration ─────────────────────────────────────────────────────────

/**
 * Migrate a workflow from the old steps[] format to the new graph format.
 * Creates a LiteGraph-compatible serialized graph without requiring the library.
 * Nodes are arranged in a horizontal chain: Trigger → Step1 → Step2 → ...
 *
 * @param {Object} workflow - Legacy workflow with steps[] but no graph
 * @returns {Object} Migrated workflow with graph field added
 */
function migrateStepsToGraph(workflow) {
  const SPACING_X = 280;
  const START_X = 100;
  const START_Y = 200;

  const steps = workflow.steps || [];
  const nodes = [];
  const links = [];
  let linkId = 1;
  let nodeId = 1;

  // Node type → LiteGraph registered type mapping
  const typeMap = {
    agent: 'workflow/claude',
    claude: 'workflow/claude',
    shell: 'workflow/shell',
    git: 'workflow/git',
    http: 'workflow/http',
    notify: 'workflow/notify',
    wait: 'workflow/wait',
    condition: 'workflow/condition',
  };

  // Create trigger node (ID = 1)
  const triggerNodeId = nodeId++;
  nodes.push({
    id: triggerNodeId,
    type: 'workflow/trigger',
    pos: [START_X, START_Y],
    size: [180, 70],
    properties: {
      triggerType: workflow.trigger?.type || 'manual',
      triggerValue: workflow.trigger?.value || '',
      hookType: workflow.hookType || 'PostToolUse',
    },
    outputs: [{ name: 'Start', type: -1, links: [] }], // EVENT type = -1 in LiteGraph
  });

  // Create step nodes and chain them
  let prevNodeId = triggerNodeId;
  let prevSlot = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const type = typeMap[step.type] || `workflow/${step.type}`;
    const nid = nodeId++;
    const pos = [START_X + SPACING_X * (i + 1), START_Y];

    // Extract properties (remove internal fields)
    const props = { ...step };
    delete props.id;
    delete props.type;
    delete props.condition;
    delete props.retry;
    delete props.retry_delay;
    delete props.timeout;

    // Build node structure
    const isCondition = step.type === 'condition';
    const node = {
      id: nid,
      type,
      pos,
      size: [180, isCondition ? 90 : 80],
      properties: props,
      inputs: [{ name: 'In', type: -1, link: null }],  // ACTION type = -1
      outputs: isCondition
        ? [
            { name: 'True', type: -1, links: [] },
            { name: 'False', type: -1, links: [] },
          ]
        : [
            { name: 'Done', type: -1, links: [] },
            { name: 'Error', type: -1, links: [] },
          ],
    };

    // Create link from previous node to this node
    const lid = linkId++;
    links.push([lid, prevNodeId, prevSlot, nid, 0, -1]);

    // Update link references on nodes
    // Previous node output slot
    const prevNode = nodes.find(n => n.id === prevNodeId);
    if (prevNode && prevNode.outputs && prevNode.outputs[prevSlot]) {
      prevNode.outputs[prevSlot].links.push(lid);
    }
    // Current node input slot
    node.inputs[0].link = lid;

    nodes.push(node);

    // Next link comes from this node's slot 0 (Done / True)
    prevNodeId = nid;
    prevSlot = 0;
  }

  return {
    ...workflow,
    graph: {
      last_node_id: nodeId - 1,
      last_link_id: linkId - 1,
      nodes,
      links,
      groups: [],
      config: {},
      version: 0.4,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 0;
  const m = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!m) return parseInt(value, 10) || 0;
  const mul = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(parseFloat(m[1]) * (mul[m[2]] || 1000));
}

// ─── Singleton export ─────────────────────────────────────────────────────────

module.exports = new WorkflowService();
