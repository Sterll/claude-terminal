/**
 * WorkflowStorage
 * Persistence layer for workflow definitions and run history.
 * Uses atomic writes (temp + rename) to avoid corruption.
 *
 * Storage layout:
 *   ~/.claude-terminal/workflows/
 *     definitions.json   — workflow YAML/JSON definitions
 *     history.json       — run history (capped at MAX_RUNS_TOTAL)
 *     results/           — large run result payloads (one file per run)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const { withCrossProcessLock } = require('../utils/fileLock');

// ─── Constants ──────────────────────────────────────────────────────────────

const WORKFLOWS_DIR     = path.join(os.homedir(), '.claude-terminal', 'workflows');
const DEFINITIONS_FILE  = path.join(WORKFLOWS_DIR, 'definitions.json');
// Cross-process lock guarding definitions.json (the MCP server mutates the same
// file from another process). The path MUST match the one used by the MCP tool.
const DEFINITIONS_LOCK  = DEFINITIONS_FILE + '.lock';
const HISTORY_FILE      = path.join(WORKFLOWS_DIR, 'history.json');
const RESULTS_DIR       = path.join(WORKFLOWS_DIR, 'results');
const MAX_RUNS_PER_WF   = 50;   // kept per workflow in history
const MAX_RUNS_TOTAL    = 500;  // global cap to avoid unbounded growth
const MAX_FIELD_BYTES   = 256 * 1024; // per-field cap for persisted result payloads

// ─── Per-file write serialization (mutex) ─────────────────────────────────────
// Read-modify-write sequences on shared files (history.json) must not interleave,
// otherwise concurrent runs cause lost updates. We chain every mutation for a given
// file onto a single tail promise so they execute strictly one after another.
const _writeChains = new Map(); // filePath → Promise (tail of the queue)

/**
 * Run `task` exclusively with respect to other tasks queued on the same file.
 * @param {string} filePath
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withFileLock(filePath, task) {
  const prev = _writeChains.get(filePath) || Promise.resolve();
  // Swallow prior errors so one failed task doesn't poison the chain.
  const next = prev.catch(() => {}).then(() => task());
  // Keep the chain tail; clean up when this is the last queued task.
  _writeChains.set(filePath, next);
  next.finally(() => {
    if (_writeChains.get(filePath) === next) _writeChains.delete(filePath);
  });
  return next;
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function ensureDirs() {
  for (const dir of [WORKFLOWS_DIR, RESULTS_DIR]) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
    } catch (e) {
      // ignore if already exists
    }
  }
}

// ─── Atomic write helper ─────────────────────────────────────────────────────

async function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tmp, filePath);
}

// ─── Safe JSON read ───────────────────────────────────────────────────────────

async function safeRead(filePath, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// ─── Workflow definitions ─────────────────────────────────────────────────────

/**
 * @returns {Promise<Object[]>} All saved workflow definitions
 */
async function loadWorkflows() {
  await ensureDirs();
  return await safeRead(DEFINITIONS_FILE, []);
}

/**
 * Read definitions.json for a mutation. Unlike loadWorkflows() this REFUSES to
 * fall back to [] when the file exists but is unreadable/unparseable — starting
 * from [] there would overwrite every other workflow (the same data-loss trap
 * fixed on the MCP side). A missing file (ENOENT) is legitimately empty.
 * @returns {Promise<Object[]>}
 */
async function readDefinitionsStrict() {
  let raw;
  try {
    raw = await fs.promises.readFile(DEFINITIONS_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`Refusing to mutate definitions.json — cannot read it (${e.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Refusing to mutate definitions.json — it is unparseable (${e.message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Refusing to mutate definitions.json — it is not an array');
  }
  return parsed;
}

/**
 * Read-modify-write definitions.json under BOTH the in-process mutex and the
 * cross-process file lock, so neither concurrent main-process writers nor the
 * MCP server can clobber each other's changes.
 * @param {(all: Object[]) => { list: Object[], ret: T }} mutator
 * @returns {Promise<T>}
 */
async function mutateDefinitions(mutator) {
  await ensureDirs();
  return withFileLock(DEFINITIONS_FILE, () =>
    withCrossProcessLock(DEFINITIONS_LOCK, async () => {
      const all = await readDefinitionsStrict();
      const { list, ret } = mutator(all);
      await atomicWrite(DEFINITIONS_FILE, list);
      return ret;
    })
  );
}

/**
 * @param {Object[]} workflows
 */
async function saveWorkflows(workflows) {
  await ensureDirs();
  await withFileLock(DEFINITIONS_FILE, () =>
    withCrossProcessLock(DEFINITIONS_LOCK, () => atomicWrite(DEFINITIONS_FILE, workflows))
  );
}

/**
 * Create or replace a workflow definition.
 * Assigns a stable `id` if not present.
 * @param {Object} workflow
 * @returns {Promise<Object>} Saved workflow with id
 */
async function upsertWorkflow(workflow) {
  if (!workflow.id) {
    workflow = { ...workflow, id: `wf_${crypto.randomUUID().slice(0, 8)}` };
  }
  return mutateDefinitions(all => {
    const idx = all.findIndex(w => w.id === workflow.id);
    if (idx >= 0) all[idx] = workflow;
    else all.push(workflow);
    return { list: all, ret: workflow };
  });
}

/**
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted
 */
async function deleteWorkflow(id) {
  return mutateDefinitions(all => {
    const next = all.filter(w => w.id !== id);
    return { list: next, ret: next.length !== all.length };
  });
}

/**
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
async function getWorkflow(id) {
  return (await loadWorkflows()).find(w => w.id === id) || null;
}

// ─── Run history ──────────────────────────────────────────────────────────────

/**
 * @returns {Promise<Object[]>} All run records (without large payloads)
 */
async function loadHistory() {
  await ensureDirs();
  return await safeRead(HISTORY_FILE, []);
}

/**
 * Append a run record, enforcing per-workflow and global caps.
 * @param {Object} run
 */
async function appendRun(run) {
  return withFileLock(HISTORY_FILE, async () => {
    let all = await loadHistory();

    // Prepend newest first
    all.unshift(run);

    // Per-workflow cap
    const wfRuns = all.filter(r => r.workflowId === run.workflowId);
    if (wfRuns.length > MAX_RUNS_PER_WF) {
      const toRemove = new Set(wfRuns.slice(MAX_RUNS_PER_WF).map(r => r.id));
      all = all.filter(r => !toRemove.has(r.id));
      // Clean up result files
      for (const id of toRemove) cleanResultFile(id);
    }

    // Global cap
    if (all.length > MAX_RUNS_TOTAL) {
      const excess = all.splice(MAX_RUNS_TOTAL);
      for (const r of excess) cleanResultFile(r.id);
    }

    await atomicWrite(HISTORY_FILE, all);
  });
}

/**
 * Update a run record in place (e.g. to finalize status/duration).
 * @param {string} runId
 * @param {Partial<Object>} patch
 * @returns {Promise<Object|null>} Updated run or null
 */
async function updateRun(runId, patch) {
  return withFileLock(HISTORY_FILE, async () => {
    const all = await loadHistory();
    const idx = all.findIndex(r => r.id === runId);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], ...patch };
    await atomicWrite(HISTORY_FILE, all);
    return all[idx];
  });
}

/**
 * Reconcile "running" run records left over from a previous session.
 *
 * appendRun() persists a run with status:'running' BEFORE execution. If the app
 * crashes or quits mid-run, that record is never finalized and stays 'running'
 * forever. At boot no run is actually active (the in-memory _active map is empty),
 * so every history record still marked 'running' is a ghost → mark it 'interrupted'
 * with a finishedAt timestamp.
 *
 * @returns {Promise<{ reconciled: number }>} count of records reconciled
 */
async function reconcileRunningRuns() {
  return withFileLock(HISTORY_FILE, async () => {
    const all = await loadHistory();
    const now = new Date().toISOString();
    let reconciled = 0;
    for (const r of all) {
      if (r && r.status === 'running') {
        r.status = 'interrupted';
        r.finishedAt = r.finishedAt || now;
        reconciled++;
      }
    }
    if (reconciled > 0) await atomicWrite(HISTORY_FILE, all);
    return { reconciled };
  });
}

/**
 * @param {string} workflowId
 * @param {number} [limit]
 * @returns {Promise<Object[]>}
 */
async function getRunsForWorkflow(workflowId, limit = MAX_RUNS_PER_WF) {
  return (await loadHistory())
    .filter(r => r.workflowId === workflowId)
    .slice(0, limit);
}

/**
 * @param {number} [limit]
 * @returns {Promise<Object[]>}
 */
async function getRecentRuns(limit = 20) {
  return (await loadHistory()).slice(0, limit);
}

/**
 * @param {string} runId
 * @returns {Promise<Object|null>}
 */
async function getRun(runId) {
  return (await loadHistory()).find(r => r.id === runId) || null;
}

// ─── Result files (large payloads) ───────────────────────────────────────────

/**
 * Persist a run's step outputs (potentially large) to its own file.
 * @param {string} runId
 * @param {Object} payload
 */
async function saveResultPayload(runId, payload) {
  await ensureDirs();
  const capped = capPayload(payload);
  await atomicWrite(path.join(RESULTS_DIR, `${runId}.json`), capped);
}

/**
 * Recursively cap oversized string/serialized fields in a result payload so a
 * single runaway output (e.g. a huge shell dump) cannot bloat storage.
 * Fields whose serialized size exceeds MAX_FIELD_BYTES are truncated and tagged.
 * @param {any} value
 * @returns {any}
 */
function capPayload(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_FIELD_BYTES) {
      return value.slice(0, MAX_FIELD_BYTES) + '\n… [truncated]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(capPayload);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object') {
        // Guard against a single large nested object serializing past the cap.
        let size;
        try { size = Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch { size = 0; }
        if (size > MAX_FIELD_BYTES) {
          out[k] = { _truncated: true, _note: `[truncated: ${size} bytes exceeded ${MAX_FIELD_BYTES}]` };
          continue;
        }
      }
      out[k] = capPayload(v);
    }
    return out;
  }
  return value;
}

/**
 * @param {string} runId
 * @returns {Promise<Object|null>}
 */
async function loadResultPayload(runId) {
  return await safeRead(path.join(RESULTS_DIR, `${runId}.json`), null);
}

function cleanResultFile(runId) {
  try {
    const f = path.join(RESULTS_DIR, `${runId}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch { /* ignore */ }
}

/**
 * Delete run history for a specific workflow (and result files).
 * @param {string} workflowId
 */
async function deleteRunsForWorkflow(workflowId) {
  return withFileLock(HISTORY_FILE, async () => {
    const all = await loadHistory();
    const toRemove = all.filter(r => r.workflowId === workflowId);
    const next = all.filter(r => r.workflowId !== workflowId);
    await atomicWrite(HISTORY_FILE, next);
    for (const r of toRemove) cleanResultFile(r.id);
  });
}

async function clearAllRuns() {
  return withFileLock(HISTORY_FILE, async () => {
    const all = await loadHistory();
    await atomicWrite(HISTORY_FILE, []);
    for (const r of all) cleanResultFile(r.id);
  });
}

// ─── Cycle detection ──────────────────────────────────────────────────────────

/**
 * Detect dependency cycles using DFS.
 * @param {string} workflowId - The workflow being saved
 * @param {string[]} dependsOn - Workflow IDs it depends on
 * @param {Object[]} allWorkflows - All currently saved workflows
 * @returns {{ hasCycle: boolean, cycle?: string[] }}
 */
function detectCycle(workflowId, dependsOn, allWorkflows) {
  const graph = new Map();
  for (const wf of allWorkflows) {
    graph.set(wf.id, (wf.dependsOn || []).map(d => d.workflow || d));
  }
  // Apply the proposed change
  graph.set(workflowId, (dependsOn || []).map(d => d.workflow || d));

  const visited = new Set();
  const stack   = new Set();

  function dfs(node, path) {
    if (stack.has(node)) return [...path, node];
    if (visited.has(node)) return null;
    visited.add(node);
    stack.add(node);
    for (const neighbor of (graph.get(node) || [])) {
      const cycle = dfs(neighbor, [...path, node]);
      if (cycle) return cycle;
    }
    stack.delete(node);
    return null;
  }

  const cycle = dfs(workflowId, []);
  return cycle ? { hasCycle: true, cycle } : { hasCycle: false };
}

// ─── Graph structure validation ───────────────────────────────────────────────

/**
 * Validate the structural integrity of a workflow's graph before persisting.
 * Rejects malformed graphs but tolerates legacy workflows that carry a steps[]
 * array and no graph at all (those are migrated elsewhere).
 *
 * Checks (only when a graph object is present):
 *   - graph.nodes and graph.links are arrays
 *   - at least one trigger node ('workflow/trigger') exists
 *   - every link's origin (link[1]) and target (link[3]) reference existing nodes
 *
 * @param {Object} workflow
 * @returns {{ valid: boolean, error?: string }}
 */
function validateWorkflowGraph(workflow) {
  if (!workflow || typeof workflow !== 'object') {
    return { valid: false, error: 'Workflow must be an object' };
  }

  const graph = workflow.graph;

  // Legacy workflows (steps[] only, no graph) are valid — migrated on load.
  if (!graph) {
    if (Array.isArray(workflow.steps)) return { valid: true };
    // No graph and no steps: allow empty scaffolding (e.g. a freshly created wf).
    return { valid: true };
  }

  if (!Array.isArray(graph.nodes)) {
    return { valid: false, error: 'Workflow graph.nodes must be an array' };
  }
  if (graph.links != null && !Array.isArray(graph.links)) {
    return { valid: false, error: 'Workflow graph.links must be an array' };
  }

  const hasTrigger = graph.nodes.some(n => n && n.type === 'workflow/trigger');
  if (!hasTrigger) {
    return { valid: false, error: 'Workflow graph must contain a trigger node (workflow/trigger)' };
  }

  const nodeIds = new Set(graph.nodes.map(n => n && n.id));
  for (const link of (graph.links || [])) {
    if (!Array.isArray(link) || link.length < 5) {
      return { valid: false, error: 'Workflow graph contains a malformed link entry' };
    }
    const originId = link[1];
    const targetId = link[3];
    if (!nodeIds.has(originId)) {
      return { valid: false, error: `Workflow link references missing origin node "${originId}"` };
    }
    if (!nodeIds.has(targetId)) {
      return { valid: false, error: `Workflow link references missing target node "${targetId}"` };
    }
  }

  return { valid: true };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Definitions
  loadWorkflows,
  saveWorkflows,
  upsertWorkflow,
  deleteWorkflow,
  getWorkflow,
  // History
  loadHistory,
  appendRun,
  updateRun,
  reconcileRunningRuns,
  getRunsForWorkflow,
  getRecentRuns,
  getRun,
  deleteRunsForWorkflow,
  clearAllRuns,
  // Results
  saveResultPayload,
  loadResultPayload,
  // Validation
  detectCycle,
  validateWorkflowGraph,
  // Constants (exported for tests)
  MAX_RUNS_PER_WF,
  MAX_RUNS_TOTAL,
};
