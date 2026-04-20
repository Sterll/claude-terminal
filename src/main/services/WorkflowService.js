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

// ─── Constants ────────────────────────────────────────────────────────────────

const RUN_STATUS = Object.freeze({
  PENDING:   'pending',
  RUNNING:   'running',
  SUCCESS:   'success',
  FAILED:    'failed',
  CANCELLED: 'cancelled',
  SKIPPED:   'skipped',
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
     * Keyed by workflowId only. Capped at MAX_CACHE_ENTRIES to prevent unbounded growth.
     * Map<workflowId, { completedAt: number, outputs: Object }>
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
  init() {
    const workflows = storage.loadWorkflows();
    this._scheduler.reload(workflows);
    this._startMcpTriggerPoll();
    console.log(`[WorkflowService] Initialized with ${workflows.length} workflow(s)`);
  }

  destroy() {
    this._scheduler.destroy();
    if (this._mcpPollTimer) clearInterval(this._mcpPollTimer);
    for (const [, exec] of this._active) {
      exec.abortController.abort();
    }
    this._active.clear();
  }

  /**
   * Poll for MCP trigger/cancel request files.
   * The MCP process writes JSON files in workflows/triggers/ since it
   * cannot call WorkflowService directly (separate process).
   */
  _startMcpTriggerPoll() {
    const triggersDir = path.join(require('os').homedir(), '.claude-terminal', 'workflows', 'triggers');
    this._mcpPollTimer = setInterval(() => {
      try {
        if (!fs.existsSync(triggersDir)) return;
        const files = fs.readdirSync(triggersDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          const filePath = path.join(triggersDir, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            fs.unlinkSync(filePath);

            if (data.action === 'cancel' && data.runId) {
              this.cancel(data.runId);
              console.log(`[WorkflowService] MCP cancel: ${data.runId}`);
            } else if (data.action === 'reload') {
              // MCP graph edit tools signal a reload after modifying definitions.json directly
              this._scheduler.reload(storage.loadWorkflows());
              this._send('workflow-list-updated', { workflows: storage.loadWorkflows() });
              console.log(`[WorkflowService] MCP reload: definitions refreshed`);
            } else if (data.workflowId) {
              this.trigger(data.workflowId, { trigger: 'mcp' });
              console.log(`[WorkflowService] MCP trigger: ${data.workflowId}`);
            }
          } catch (e) {
            try { fs.unlinkSync(filePath); } catch (_) {}
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

  // ─── Workflow CRUD ───────────────────────────────────────────────────────────

  listWorkflows() {
    const workflows = storage.loadWorkflows();
    // Auto-migrate legacy workflows (steps[] → graph)
    let dirty = false;
    for (let i = 0; i < workflows.length; i++) {
      if (workflows[i].steps && !workflows[i].graph) {
        workflows[i] = migrateStepsToGraph(workflows[i]);
        dirty = true;
      }
    }
    if (dirty) storage.saveWorkflows(workflows);
    return workflows;
  }

  getWorkflow(id) {
    const wf = storage.getWorkflow(id);
    if (wf && wf.steps && !wf.graph) {
      const migrated = migrateStepsToGraph(wf);
      storage.upsertWorkflow(migrated);
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
  saveWorkflow(workflow) {
    const all = storage.loadWorkflows();
    const dependsOn = (workflow.dependsOn || []).map(d => d.workflow || d);

    // Cycle detection
    const { hasCycle, cycle } = storage.detectCycle(workflow.id || '__new__', dependsOn, all);
    if (hasCycle) {
      return {
        success: false,
        error: `Circular dependency detected: ${cycle.join(' → ')}`,
      };
    }

    const saved = storage.upsertWorkflow(workflow);
    // Reload scheduler
    this._scheduler.reload(storage.loadWorkflows());
    return { success: true, workflow: saved };
  }

  /**
   * @param {string} id
   * @returns {{ success: boolean, error?: string }}
   */
  deleteWorkflow(id) {
    const deleted = storage.deleteWorkflow(id);
    if (!deleted) return { success: false, error: 'Workflow not found' };
    storage.deleteRunsForWorkflow(id);
    this._scheduler.reload(storage.loadWorkflows());
    this._resultsCache.delete(id);
    return { success: true };
  }

  /**
   * Toggle enabled state.
   * @param {string} id
   * @param {boolean} enabled
   */
  setEnabled(id, enabled) {
    const wf = storage.getWorkflow(id);
    if (!wf) return { success: false, error: 'Workflow not found' };
    const updated = { ...wf, enabled };
    storage.upsertWorkflow(updated);
    this._scheduler.reload(storage.loadWorkflows());
    return { success: true, workflow: updated };
  }

  // ─── Run history ─────────────────────────────────────────────────────────────

  getRunsForWorkflow(workflowId, limit) {
    return storage.getRunsForWorkflow(workflowId, limit);
  }

  getRecentRuns(limit) {
    return storage.getRecentRuns(limit);
  }

  clearAllRuns() {
    storage.clearAllRuns();
  }

  getRun(runId) {
    return storage.getRun(runId);
  }

  getRunResult(runId) {
    return storage.loadResultPayload(runId);
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
   * @param {string} [opts.source]       - 'manual' | 'cron' | 'hook' | 'on_workflow'
   * @param {string} [opts.projectPath]  - Override project path for context variables
   * @returns {Promise<{ success: boolean, runId?: string, queued?: boolean, error?: string }>}
   */
  async trigger(workflowId, opts = {}) {
    const workflow = storage.getWorkflow(workflowId);
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
        extraVars.set(depId, cached.outputs);
        continue;
      }

      // Check if dep is already running — wait for it
      const running = this._findRunningByWorkflowId(depId);
      if (running) {
        console.log(`[WorkflowService] Waiting for in-flight dependency: ${depId}`);
        const result = await running.promise.catch(() => ({}));
        extraVars.set(depId, result.outputs || {});
        continue;
      }

      // Not running, not cached — trigger it and wait
      inProgress.add(depId);
      const depWorkflow = storage.getWorkflow(depId);
      if (!depWorkflow) {
        console.warn(`[WorkflowService] depends_on workflow not found: ${depId}`);
        continue;
      }

      const { runId } = await this._startRun(depWorkflow, { source: 'depends_on' }, inProgress);
      // Wait for it to finish
      const exec = this._active.get(runId);
      if (exec) {
        const result = await exec.promise.catch(() => ({}));
        extraVars.set(depId, result.outputs || {});
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
    storage.appendRun(run);

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
      .then(result => {
        this._finalizeRun(run, result, workflow);
        resolveExec(result);
      })
      .catch(err => {
        this._finalizeRun(run, { success: false, error: err.message, outputs: {} }, workflow);
        rejectExec(err);
      })
      .finally(() => {
        this._active.delete(runId);
        this._drainQueue(workflow.id);
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
    // 1. Resolve dependencies
    let extraVars = new Map();
    if (workflow.dependsOn?.length) {
      extraVars = await this._resolveDependencies(workflow, new Set(inProgress));
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
    return runner.execute(workflow, run, abortController, extraVars);
  }

  _finalizeRun(run, result, workflow) {
    const now      = Date.now();
    const duration = Math.round((now - new Date(run.startedAt).getTime()) / 1000);
    const status   = result.cancelled
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
    storage.updateRun(run.id, patch);

    // Persist large output payload separately
    if (result.outputs && Object.keys(result.outputs).length) {
      storage.saveResultPayload(run.id, { outputs: result.outputs });
    }

    // Update results cache (only on success), keyed by workflowId for depends_on lookup
    if (status === RUN_STATUS.SUCCESS) {
      this._resultsCache.set(workflow.id, {
        completedAt: now,
        outputs:     result.outputs || {},
      });
      // Evict oldest entries if cache exceeds limit
      if (this._resultsCache.size > MAX_CACHE_ENTRIES) {
        let oldest = null, oldestKey = null;
        for (const [key, val] of this._resultsCache) {
          if (!oldest || val.completedAt < oldest) {
            oldest = val.completedAt;
            oldestKey = key;
          }
        }
        if (oldestKey) this._resultsCache.delete(oldestKey);
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

    // Notify on_workflow triggers
    if (status === RUN_STATUS.SUCCESS || status === RUN_STATUS.FAILED) {
      this._scheduler.onWorkflowComplete(workflow.id, {
        success:    status === RUN_STATUS.SUCCESS,
        outputs:    result.outputs || {},
        workflowId: workflow.id,
      });
    }

    // Send desktop notification on failure
    if (status === RUN_STATUS.FAILED) {
      this._send('workflow-notify-desktop', {
        title:   `Workflow failed: ${workflow.name}`,
        message: result.error || 'An error occurred',
        type:    'error',
      });
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

  _drainQueue(workflowId) {
    const queue = this._queues.get(workflowId);
    if (!queue || !queue.length) return;
    const { opts, resolve } = queue.shift();
    if (!queue.length) this._queues.delete(workflowId);
    const workflow = storage.getWorkflow(workflowId);
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
  getDependencyGraph() {
    const workflows = storage.loadWorkflows();
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
