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

// ─── Constants ──────────────────────────────────────────────────────────────

const WORKFLOWS_DIR     = path.join(os.homedir(), '.claude-terminal', 'workflows');
const DEFINITIONS_FILE  = path.join(WORKFLOWS_DIR, 'definitions.json');
const HISTORY_FILE      = path.join(WORKFLOWS_DIR, 'history.json');
const RESULTS_DIR       = path.join(WORKFLOWS_DIR, 'results');
const MAX_RUNS_PER_WF   = 50;   // kept per workflow in history
const MAX_RUNS_TOTAL    = 500;  // global cap to avoid unbounded growth

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
 * @param {Object[]} workflows
 */
async function saveWorkflows(workflows) {
  await ensureDirs();
  await atomicWrite(DEFINITIONS_FILE, workflows);
}

/**
 * Create or replace a workflow definition.
 * Assigns a stable `id` if not present.
 * @param {Object} workflow
 * @returns {Promise<Object>} Saved workflow with id
 */
async function upsertWorkflow(workflow) {
  const all = await loadWorkflows();
  if (!workflow.id) {
    workflow = { ...workflow, id: `wf_${crypto.randomUUID().slice(0, 8)}` };
  }
  const idx = all.findIndex(w => w.id === workflow.id);
  if (idx >= 0) {
    all[idx] = workflow;
  } else {
    all.push(workflow);
  }
  await saveWorkflows(all);
  return workflow;
}

/**
 * @param {string} id
 * @returns {Promise<boolean>} true if deleted
 */
async function deleteWorkflow(id) {
  const all = await loadWorkflows();
  const next = all.filter(w => w.id !== id);
  if (next.length === all.length) return false;
  await saveWorkflows(next);
  return true;
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
}

/**
 * Update a run record in place (e.g. to finalize status/duration).
 * @param {string} runId
 * @param {Partial<Object>} patch
 * @returns {Promise<Object|null>} Updated run or null
 */
async function updateRun(runId, patch) {
  const all = await loadHistory();
  const idx = all.findIndex(r => r.id === runId);
  if (idx < 0) return null;
  all[idx] = { ...all[idx], ...patch };
  await atomicWrite(HISTORY_FILE, all);
  return all[idx];
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
  await atomicWrite(path.join(RESULTS_DIR, `${runId}.json`), payload);
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
  const all = await loadHistory();
  const toRemove = all.filter(r => r.workflowId === workflowId);
  const next = all.filter(r => r.workflowId !== workflowId);
  await atomicWrite(HISTORY_FILE, next);
  for (const r of toRemove) cleanResultFile(r.id);
}

async function clearAllRuns() {
  const all = await loadHistory();
  await atomicWrite(HISTORY_FILE, []);
  for (const r of all) cleanResultFile(r.id);
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
  // Constants (exported for tests)
  MAX_RUNS_PER_WF,
  MAX_RUNS_TOTAL,
};
