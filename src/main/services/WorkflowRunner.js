/**
 * WorkflowRunner
 * Executes a single workflow run: resolves variables, evaluates conditions,
 * dispatches each step type. Fully async, cancellable via AbortController.
 *
 * Step types handled:
 *   agent      — Claude Agent SDK session (bypassPermissions)
 *   shell      — child_process.execFile (no shell injection)
 *   git        — uses git.js helpers
 *   http       — native fetch (Node 18+)
 *   notify     — desktop notification + remote push
 *   wait       — pause for human confirmation or timeout
 *   file       — read / write / copy / delete
 *   db         — database query / schema / tables via DatabaseService
 *   condition  — evaluate expression, expose boolean variable
 *   loop       — iterate over an array variable, execute sub-steps
 *   parallel   — concurrent sub-steps, wait for all
 */

'use strict';

const fs            = require('fs');
const path          = require('path');

// ─── Variable resolution ──────────────────────────────────────────────────────

/**
 * Resolve all $xxx.yyy and $ctx.yyy references in a string value.
 * @param {string} value
 * @param {Map<string, any>} vars  - step outputs + ctx
 * @returns {string}
 */
function resolveVars(value, vars) {
  if (typeof value !== 'string') return value;

  // Fast path: entire string is a single $variable — return raw value (object, array, etc.)
  const singleVarMatch = value.match(/^\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)$/);
  if (singleVarMatch) {
    const parts = singleVarMatch[1].split('.');
    if (vars.has(parts[0])) {
      let cur = vars.get(parts[0]);
      // Walk the property chain.
      //   - null/undefined intermediate → unresolvable, leave verbatim (fall through)
      //   - primitive (non-object) intermediate with remaining parts → the suffix is
      //     literal text (e.g. $today.md) → fall through to mixed-path handler
      //   - OBJECT parent whose leaf property is missing → '' (don't serialize parent)
      let fellThrough = false;
      for (let i = 1; i < parts.length; i++) {
        if (cur == null) { fellThrough = true; break; }
        if (typeof cur !== 'object') { fellThrough = true; break; }
        if (!(parts[i] in cur)) return '';
        cur = cur[parts[i]];
      }
      if (!fellThrough) {
        if (cur == null) return ''; // leaf resolved to null/undefined → empty string
        // Trailing-only CR/LF trim for strings (shell outputs commonly append one).
        // Anchored to the end, so internal newlines in multi-line content are kept.
        return typeof cur === 'string' ? cur.replace(/[\r\n]+$/, '') : cur;
      }
      // fell through → handled by mixed-path replacement below
    }
  }

  // Mixed text with variables: interpolate as strings
  return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
    const parts = key.split('.');
    if (!vars.has(parts[0])) return match; // unknown root → leave verbatim
    // Try resolving from longest path down to root variable
    // e.g. $today.md → try "today.md" (fails) → try "today" + suffix ".md"
    for (let take = parts.length; take >= 1; take--) {
      let cur = vars.get(parts[0]);
      for (let i = 1; i < take && cur != null; i++) cur = cur[parts[i]];
      if (cur != null && (take === parts.length || typeof cur !== 'object')) {
        // Trailing-only CR/LF trim (anchored to end; internal newlines preserved).
        const resolved = typeof cur === 'object' ? JSON.stringify(cur) : String(cur).replace(/[\r\n]+$/, '');
        const suffix = take < parts.length ? '.' + parts.slice(take).join('.') : '';
        return resolved + suffix;
      }
    }
    return match; // nothing resolved
  });
}

/**
 * Deep-resolve all string leaves of an object.
 * @param {any} obj
 * @param {Map<string, any>} vars
 * @returns {any}
 */
function resolveDeep(obj, vars) {
  if (typeof obj === 'string') return resolveVars(obj, vars);
  if (Array.isArray(obj))     return obj.map(v => resolveDeep(v, vars));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveDeep(v, vars);
    return out;
  }
  return obj;
}

// ─── Data pin output schemas (shared source of truth) ────────────────────────
const { getOutputKeyForSlot } = require('../../shared/workflow-schema');

// ─── Safe condition evaluation ────────────────────────────────────────────────

/**
 * Evaluate a condition string against resolved variables.
 * Supports: ==, !=, >, <, >=, <=, true/false literals.
 * No eval() — purely regex-based.
 * @param {string} condition
 * @param {Map<string, any>} vars
 * @returns {boolean}
 */
function evalCondition(condition, vars) {
  if (!condition || condition.trim() === '') return true;

  const resolved = resolveVars(condition, vars);

  // Boolean literals
  if (resolved === 'true')  return true;
  if (resolved === 'false') return false;

  // Unary operators: "value is_empty" / "value is_not_empty"
  const unaryMatch = resolved.match(/^(.+?)\s+(is_empty|is_not_empty)$/);
  if (unaryMatch) {
    const val = unaryMatch[1].trim();
    const isEmpty = val === '' || val === 'null' || val === 'undefined' || val === '[]' || val === '{}';
    return unaryMatch[2] === 'is_empty' ? isEmpty : !isEmpty;
  }

  // Binary operators (left OP right)
  const match = resolved.match(/^(.+?)\s*(==|!=|>=|<=|>|<|contains|starts_with|ends_with|matches)\s+(.+)$/);
  if (!match) {
    // Truthy check (non-empty string / non-zero number)
    const val = resolved.trim();
    if (val === '' || val === '0' || val === 'null' || val === 'undefined') return false;
    return true;
  }

  const [, leftRaw, op, rightRaw] = match;
  const left  = leftRaw.trim();
  const right = rightRaw.trim();

  // Try numeric comparison
  const ln = parseFloat(left);
  const rn = parseFloat(right);
  const numeric = !isNaN(ln) && !isNaN(rn);

  switch (op) {
    case '==': return numeric ? ln === rn : left === right;
    case '!=': return numeric ? ln !== rn : left !== right;
    case '>':  return numeric && ln > rn;
    case '<':  return numeric && ln < rn;
    case '>=': return numeric && ln >= rn;
    case '<=': return numeric && ln <= rn;
    case 'contains':    return left.includes(right);
    case 'starts_with': return left.startsWith(right);
    case 'ends_with':   return left.endsWith(right);
    case 'matches': {
      try {
        if (left.length > 10_000) return false; // ReDoS protection: skip huge strings
        return new RegExp(right).test(left);
      } catch { return false; }
    }
    default:   return false;
  }
}

// ─── Condition step ───────────────────────────────────────────────────────────

function runConditionStep(config, vars) {
  // Build expression from structured fields (variable + operator + value) if no explicit expression
  let expression = config.expression;
  if (!expression && config.variable) {
    const variable = config.variable || '';
    const operator = config.operator || '==';
    const isUnary  = operator === 'is_empty' || operator === 'is_not_empty';
    const value    = config.value ?? '';
    expression = isUnary ? `${variable} ${operator}` : `${variable} ${operator} ${value}`;
  }
  const result = evalCondition(resolveVars(expression || 'true', vars), vars);
  return { result, value: result };
}

// ─── Agent step ───────────────────────────────────────────────────────────────

/**
 * Run a Claude agent session for a workflow step.
 * We delegate to ChatService.startSession() with bypassPermissions
 * and wait for the session to complete (chat-done event).
 *
 * @param {Object}   config
 * @param {Map}      vars
 * @param {AbortSignal} signal
 * @param {Object}   chatService  - main ChatService singleton
 * @param {Function} onMessage    - called with each SDK message (for logging)
 */
/**
 * Build a JSON Schema object from user-defined output fields.
 * @param {Array<{name:string, type:string}>} fields
 * @returns {Object} JSON Schema
 */
function buildJsonSchema(fields) {
  const properties = {};
  const required = [];
  for (const field of fields) {
    if (!field.name) continue;
    required.push(field.name);
    switch (field.type) {
      case 'number':  properties[field.name] = { type: 'number' }; break;
      case 'boolean': properties[field.name] = { type: 'boolean' }; break;
      case 'array':   properties[field.name] = { type: 'array', items: { type: 'string' } }; break;
      case 'object':  properties[field.name] = { type: 'object' }; break;
      default:        properties[field.name] = { type: 'string' }; break;
    }
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

async function runAgentStep(config, vars, signal, chatService, onMessage) {
  const mode     = config.mode || 'prompt';
  const prompt   = resolveVars(config.prompt || '', vars);
  const ctx      = vars.get('ctx') || {};
  const home     = require('os').homedir();
  // Resolve cwd: prefer explicit cwd, then project context (same pattern as git/shell steps)
  let   cwd      = resolveVars(config.cwd || '', vars) || ctx.project || '';
  const model    = config.model || null;
  const VALID_EFFORTS = ['low', 'medium', 'high', 'max'];
  const rawEffort = config.effort || null;
  const effort   = rawEffort && VALID_EFFORTS.includes(rawEffort) ? rawEffort : null;
  const maxTurns = config.maxTurns || 30;

  // Validate cwd exists on disk — fallback to home dir to avoid ENOENT
  if (!cwd || !fs.existsSync(cwd)) {
    console.warn(`[WorkflowRunner] Claude step cwd invalid or missing: "${cwd}", falling back to ${home}`);
    cwd = home;
  }

  if (signal?.aborted) throw new Error('Cancelled');

  // Build options
  const opts = { cwd, prompt, model, effort, maxTurns, signal, onMessage };

  // Skill mode
  if (mode === 'skill' && config.skillId) {
    opts.skills = [config.skillId];
  }

  // Structured output
  if (config.outputSchema && config.outputSchema.length > 0) {
    const validFields = config.outputSchema.filter(f => f.name);
    if (validFields.length > 0) {
      opts.outputFormat = { type: 'json_schema', schema: buildJsonSchema(validFields) };
    }
  }

  return chatService.runSinglePrompt(opts);
}

// ─── Time tracking step ──────────────────────────────────────────────────────

/**
 * Query time tracking data by reading ~/.claude-terminal/timetracking.json directly.
 * Uses the shared getTimeStats() from time.ipc — no IPC round-trip needed.
 * @param {Object} config  { action, projectId?, startDate?, endDate? }
 * @param {Map}    vars
 */
async function runTimeStep(config, vars) {
  const { getTimeStats } = require('../ipc/time.ipc');
  const result = await getTimeStats({
    action:    config.action    || 'get_today',
    projectId: resolveVars(config.projectId || '', vars) || undefined,
    startDate: resolveVars(config.startDate || '', vars) || undefined,
    endDate:   resolveVars(config.endDate   || '', vars) || undefined,
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

// ─── Transform step ───────────────────────────────────────────────────────────

/**
 * Apply a data transformation to an array or value.
 * Supported operations: map, filter, reduce, find, pluck, count, sort, unique, flatten, json_parse, json_stringify
 */
function runTransformStep(config, vars) {
  const operation = config.operation || 'map';
  const inputRaw  = config.input ? resolveVars(config.input, vars) : null;
  const expr      = config.expression ? resolveVars(config.expression, vars) : '';

  // json_parse / json_stringify don't need an array input
  if (operation === 'json_parse') {
    try {
      const parsed = JSON.parse(typeof inputRaw === 'string' ? inputRaw : JSON.stringify(inputRaw));
      return { result: parsed, count: Array.isArray(parsed) ? parsed.length : 1, success: true };
    } catch (e) {
      throw new Error(`json_parse failed: ${e.message}`);
    }
  }
  if (operation === 'json_stringify') {
    return { result: JSON.stringify(inputRaw, null, 2), success: true };
  }

  const input = Array.isArray(inputRaw) ? inputRaw : (inputRaw != null ? [inputRaw] : []);

  // Expressions run in the same hardened vm context transform.node.js uses.
  // The comment that used to sit here claimed this evaluator "only allows
  // simple property access and comparisons, no arbitrary eval" — a bare
  // `new Function` allows exactly arbitrary eval, with full host access. This
  // path is still reachable through _resolvePureDataNode, so it must not be
  // weaker than the node it mirrors. See _registry.compileSandboxed.
  const { compileSandboxed } = require('../workflow-nodes/_registry');
  const makeFn = (body) => compileSandboxed(body, ['item', 'index'], { label: 'transform-expr' });

  let result;
  switch (operation) {
    case 'map':
      result = input.map((item, index) => expr ? makeFn(expr)(item, index) : item);
      break;
    case 'filter':
      result = input.filter((item, index) => expr ? makeFn(expr)(item, index) : true);
      break;
    case 'find':
      result = expr ? input.find((item, index) => makeFn(expr)(item, index)) : input[0];
      break;
    case 'reduce': {
      // expr format: "acc + item.value" — acc starts at 0
      const reduceFn = expr
        ? compileSandboxed(expr, ['acc', 'item', 'index'], { label: 'transform-reduce' })
        : (acc, item) => acc + item;
      result = input.reduce(reduceFn, 0);
      break;
    }
    case 'pluck':
      // expr = property name to extract, e.g. "name" or "user.id"
      result = input.map(item => {
        if (!expr) return item;
        return expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), item);
      });
      break;
    case 'count':
      result = expr ? input.filter((item, index) => makeFn(expr)(item, index)).length : input.length;
      break;
    case 'sort':
      result = [...input].sort((a, b) => {
        if (!expr) return 0;
        const va = expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), a);
        const vb = expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), b);
        return va < vb ? -1 : va > vb ? 1 : 0;
      });
      break;
    case 'unique':
      if (expr) {
        const seen = new Set();
        result = input.filter(item => {
          const key = expr.split('.').reduce((o, k) => (o != null ? o[k] : undefined), item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      } else {
        result = [...new Set(input)];
      }
      break;
    case 'flatten':
      result = input.flat(expr ? parseInt(expr, 10) || 1 : 1);
      break;
    default:
      throw new Error(`Unknown transform operation: ${operation}`);
  }

  return {
    result,
    count: Array.isArray(result) ? result.length : 1,
    success: true,
  };
}

// ─── Switch step ──────────────────────────────────────────────────────────────

/**
 * Evaluate a variable and return which output slot index to follow.
 * Returns { matchedSlot, value } — used by _executeGraph to route the BFS.
 */
function runSwitchStep(config, vars) {
  const value  = resolveVars(config.variable || '', vars);
  const cases  = (config.cases || '').split(',').map(c => c.trim()).filter(Boolean);
  const idx    = cases.findIndex(c => String(value) === String(c));
  // idx = matched case slot, cases.length = default slot
  const matchedSlot = idx >= 0 ? idx : cases.length;
  return { value, matchedCase: idx >= 0 ? cases[idx] : 'default', matchedSlot, success: true };
}

// ─── Time parser ──────────────────────────────────────────────────────────────

function parseMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return 60_000;
  // Tolerate whitespace and an omitted unit, matching wait.node.js. The old
  // pattern required the unit to touch the number, so a step timeout of "5 s"
  // fell through to parseInt and became 5 MILLISECONDS; and
  // `parseInt(value, 10) || 60_000` turned an explicit 0 into a one-minute
  // wait, because 0 is falsy. This feeds retry delays and step/workflow
  // timeouts, so both failures were silent and load-bearing.
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) {
    console.warn(`[WorkflowRunner] Unparseable duration "${value}" — falling back to 60s`);
    return 60_000;
  }
  const num  = parseFloat(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(num * multipliers[unit]);
}

// ─── Main executor ────────────────────────────────────────────────────────────

class WorkflowRunner {
  /**
   * @param {Object} opts
   * @param {Function}          opts.sendFn        - (channel, data) => void, sends to renderer
   * @param {Object}            opts.chatService   - ChatService singleton
   * @param {Map<string, Function>} opts.waitCallbacks - shared wait registry
   * @param {Object}            opts.projectTypeRegistry - { fivem, api, ... } services for native steps
   */
  constructor({ sendFn, chatService, waitCallbacks, projectTypeRegistry = {}, databaseService = null, workflowService = null }) {
    this._send              = sendFn;
    this._chatService       = chatService;
    this._waitCallbacks     = waitCallbacks;
    this._projectTypeRegistry = projectTypeRegistry;
    this._databaseService   = databaseService;
    this._workflowService   = workflowService;

    // Load the node registry once at construction time
    this._nodeRegistry = require('../workflow-nodes/_registry');
    this._nodeRegistry.loadRegistry();
  }

  /**
   * Build the config object passed to a registry node's run() method.
   * Returns a shallow copy of the step's own properties (the node may call
   * resolveVars() itself if it needs variable interpolation).
   * @param {Object} step
   * @returns {Object}
   */
  _resolveStepConfig(step) {
    return { ...(step.properties || {}), ...step };
  }

  /**
   * Execute a single step in isolation (no BFS, no context).
   * Used by the "Test Node" button in the graph editor.
   * @param {Object} step     - step properties (id, type, ...properties)
   * @param {Object} [ctx]    - optional context vars (project path, etc.)
   * @returns {Promise<{ success: boolean, output: any, error?: string, duration: number }>}
   */
  async testStep(step, ctx = {}) {
    const vars = new Map([
      ['ctx', { project: ctx.project || '', date: new Date().toISOString(), trigger: 'test' }],
    ]);
    const abort = new AbortController();
    const start = Date.now();
    try {
      const output = await this._dispatchStep(step, vars, 'test', abort.signal, null);
      return { success: true, output, duration: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: err.message, duration: Date.now() - start };
    }
  }

  /**
   * Execute a full workflow run.
   * Supports both legacy steps[] format and new graph format.
   * @param {Object} workflow
   * @param {Object} run              - run record (has .id, .triggerData, etc.)
   * @param {AbortController} abort
   * @param {Map<string, any>} [extraVars]  - e.g. depends_on results
   * @returns {Promise<{ success: boolean, outputs: Object, error?: string }>}
   */
  async execute(workflow, run, abort, extraVars = new Map()) {
    const vars = new Map([
      // Context variables
      ['ctx', {
        project:    run.projectPath || workflow.scope?.project || '',
        branch:     run.contextBranch  || '',
        date:       new Date().toISOString(),
        lastCommit: run.contextCommit  || '',
        trigger:    run.trigger         || 'manual',
      }],
      ['trigger', run.triggerData || {}],
      // Inject depends_on outputs
      ...extraVars,
    ]);

    const stepOutputs = {};
    this._stepStatuses = new Map(); // Track final step statuses for persistence
    this._runDegraded  = false;     // set when a catch path is taken / retry exhausted
    this._timedOut     = false;     // distinguishes global timeout from user cancel

    const globalTimeoutMs = workflow.timeout ? parseMs(workflow.timeout) : null;
    const globalTimer = globalTimeoutMs
      ? setTimeout(() => { this._timedOut = true; abort.abort(); }, globalTimeoutMs)
      : null;

    try {
      if (workflow.graph && workflow.graph.nodes) {
        // New graph-based execution
        await this._executeGraph(workflow.graph, vars, run.id, abort.signal, stepOutputs, workflow);
      } else {
        // Legacy linear steps execution
        const steps = workflow.steps || [];
        await this._runSteps(steps, vars, run.id, abort.signal, stepOutputs, workflow);
      }
      // A run that recovered from a caught error or exhausted retry is NOT clean success.
      if (this._runDegraded) {
        return {
          success: false,
          degraded: true,
          outputs: stepOutputs,
          stepStatuses: this._stepStatuses,
          error: 'Completed with recovered/handled errors',
        };
      }
      return { success: true, outputs: stepOutputs, stepStatuses: this._stepStatuses };
    } catch (err) {
      if (abort.signal.aborted) {
        // Distinguish a global-timeout abort from a user-initiated cancel.
        if (this._timedOut) {
          return { success: false, timedOut: true, outputs: stepOutputs, stepStatuses: this._stepStatuses, error: 'Timed out' };
        }
        return { success: false, cancelled: true, outputs: stepOutputs, stepStatuses: this._stepStatuses, error: 'Cancelled' };
      }
      return { success: false, outputs: stepOutputs, stepStatuses: this._stepStatuses, error: err.message };
    } finally {
      if (globalTimer) clearTimeout(globalTimer);
    }
  }

  // ─── Graph-based execution ───────────────────────────────────────────────────

  /**
   * Execute a workflow graph using BFS traversal from the trigger node.
   * Follows LiteGraph links and handles Condition node branching.
   *
   * @param {Object} graphData          - LiteGraph serialized graph { nodes[], links[] }
   * @param {Map<string, any>} vars     - Resolved variables
   * @param {string} runId              - Current run ID
   * @param {AbortSignal} signal        - Cancellation signal
   * @param {Object} stepOutputs        - Accumulator for step outputs
   * @param {Object} workflow           - Full workflow object
   */
  async _executeGraph(graphData, vars, runId, signal, stepOutputs, workflow) {
    const { nodes, links } = graphData;
    if (!nodes || !nodes.length) return;

    // Build lookup maps
    const nodeById = new Map();
    for (const node of nodes) {
      nodeById.set(node.id, node);
    }

    // Build adjacency: linkId → link data
    // LiteGraph link format: [link_id, origin_id, origin_slot, target_id, target_slot, type]
    const linkById = new Map();
    if (links) {
      for (const link of links) {
        linkById.set(link[0], {
          id:         link[0],
          originId:   link[1],
          originSlot: link[2],
          targetId:   link[3],
          targetSlot: link[4],
          type:       link[5],
        });
      }
    }

    // Build outgoing connections map: nodeId → Map<slotIndex, targetNodeId[]>
    const outgoing = new Map();
    for (const [, link] of linkById) {
      if (!outgoing.has(link.originId)) outgoing.set(link.originId, new Map());
      const slots = outgoing.get(link.originId);
      if (!slots.has(link.originSlot)) slots.set(link.originSlot, []);
      slots.get(link.originSlot).push(link.targetId);
    }

    // Build incoming connections map: nodeId → Map<targetSlot, {originId, originSlot}[]>
    const incoming = new Map();
    for (const [, link] of linkById) {
      if (!incoming.has(link.targetId)) incoming.set(link.targetId, new Map());
      const slots = incoming.get(link.targetId);
      if (!slots.has(link.targetSlot)) slots.set(link.targetSlot, []);
      slots.get(link.targetSlot).push({ originId: link.originId, originSlot: link.originSlot });
    }

    // Find the trigger node
    const triggerNode = nodes.find(n => n.type === 'workflow/trigger');
    if (!triggerNode) {
      throw new Error('No trigger node found in graph');
    }

    // ── Fan-in / join barrier (topological gating) ───────────────────────────
    // A node with multiple exec predecessors must not run until every predecessor
    // that will ever fire has fired. We track, per node, the set of static exec
    // predecessors and, at runtime, which of them "arrived" (routed exec here) or
    // became "dead" (a predecessor ran but did not route to this node — e.g. an
    // untaken condition/switch branch). A node is ready when every static exec
    // predecessor is accounted for (arrived or dead) and at least one arrived.
    const execPreds = new Map(); // nodeId → Set<originId>  (static exec in-edges to slot 0)
    for (const [, link] of linkById) {
      if (link.targetSlot !== 0) continue; // slot 0 = exec "In"
      const isExec = link.type === -1 || link.type === 'exec' || link.type == null || link.type === '';
      if (!isExec) continue;
      if (!execPreds.has(link.targetId)) execPreds.set(link.targetId, new Set());
      execPreds.get(link.targetId).add(link.originId);
    }
    const arrived   = new Map(); // nodeId → Set<originId> that routed exec here
    const deadPreds = new Map(); // nodeId → Set<originId> that ran but skipped this node

    const _addTo = (map, key, val) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(val);
    };
    // Is a node's join barrier satisfied? (all static exec preds arrived or dead)
    const _isReady = (nodeId) => {
      const preds = execPreds.get(nodeId);
      if (!preds || preds.size <= 1) return true; // single/no predecessor: no barrier
      const arr = arrived.get(nodeId)?.size || 0;
      const dead = deadPreds.get(nodeId)?.size || 0;
      return arr >= 1 && (arr + dead) >= preds.size;
    };

    const visited = new Set();
    const queue = [];

    // Record that `originId` fired exec into each target; enqueue targets whose
    // join barrier is now satisfied.
    const fire = (originId, targets) => {
      for (const tid of targets) {
        _addTo(arrived, tid, originId);
        if (!visited.has(tid) && !queue.includes(tid) && _isReady(tid)) {
          queue.push(tid);
        }
      }
    };
    // Mark that `originId` will NOT fire the given exec target(s) (untaken branch).
    // May unblock a waiting join whose remaining predecessor just went dead.
    const seal = (originId, unfiredTargets) => {
      for (const tid of unfiredTargets) {
        if (!(execPreds.get(tid)?.has(originId))) continue;
        _addTo(deadPreds, tid, originId);
        if (!visited.has(tid) && !queue.includes(tid) && (arrived.get(tid)?.size || 0) >= 1 && _isReady(tid)) {
          queue.push(tid);
        }
      }
    };
    // All exec-successor node IDs of a node across every output slot (for sealing).
    const allExecSuccessors = (nodeId) => {
      const slots = outgoing.get(nodeId);
      if (!slots) return [];
      const out = [];
      for (const [, targets] of slots) out.push(...targets);
      return out;
    };
    // Fire the taken slot(s) and seal all other exec successors as dead.
    const route = (nodeId, takenTargets) => {
      const takenSet = new Set(takenTargets);
      fire(nodeId, takenTargets);
      const unfired = allExecSuccessors(nodeId).filter(t => !takenSet.has(t));
      if (unfired.length) seal(nodeId, unfired);
    };

    // Seed from trigger (slot 0 = "Start")
    // Emit trigger as running then success
    this._emitStep(runId, { id: `node_${triggerNode.id}`, type: 'trigger' }, 'running', null);
    this._emitStep(runId, { id: `node_${triggerNode.id}`, type: 'trigger' }, 'success', null);
    visited.add(triggerNode.id);
    // Expose trigger data as Blueprint data outputs (payload, source)
    const triggerData = vars.get('trigger') || {};
    vars.set(`node_${triggerNode.id}`, { payload: triggerData.payload ?? triggerData, source: triggerData.source || 'manual' });
    route(triggerNode.id, this._getNextNodes(triggerNode.id, 0, outgoing));

    let lastError = null;
    const forced = new Set(); // nodes released despite an unsatisfied barrier

    while (true) {
      if (signal.aborted) throw new Error('Cancelled');

      if (queue.length === 0) {
        // Queue drained — release any join stalled on an unreachable predecessor,
        // otherwise we're genuinely done.
        const stalled = this._pickStalledJoin(execPreds, arrived, deadPreds, visited);
        if (stalled == null) break;
        forced.add(stalled);
        queue.push(stalled);
      }

      const nodeId = queue.shift();
      if (visited.has(nodeId)) continue;
      // Barrier not satisfied and not force-released: skip; it will be re-enqueued
      // by a later fire()/seal() once its predecessors resolve.
      if (!_isReady(nodeId) && !forced.has(nodeId)) continue;
      visited.add(nodeId);

      const nodeData = nodeById.get(nodeId);
      if (!nodeData) continue;

      // Convert node to step format for the dispatcher
      const stepType = nodeData.type.replace('workflow/', '');
      // Merge data pin inputs (Blueprint-style) on top of step properties
      const dataInputs = await this._resolveDataInputs(nodeId, vars, incoming, nodeById);
      const step = {
        id:   `node_${nodeData.id}`,
        type: stepType,
        ...(nodeData.properties || {}),
        ...dataInputs,
      };

      if (stepType === 'condition') {
        // Condition nodes don't fail — they evaluate and branch
        try {
          await this._runOneStep(step, vars, runId, signal, stepOutputs, workflow);
        } catch (err) {
          if (signal.aborted) throw err;
          // Condition eval failed — treat as false
          stepOutputs[step.id] = { result: false, value: false };
        }
        const outputResult = stepOutputs[step.id];
        const condResult = outputResult?.result ?? outputResult?.value ?? true;
        const nextSlot = condResult ? 0 : 1;
        route(nodeId, this._getNextNodes(nodeId, nextSlot, outgoing));
      } else if (stepType === 'loop') {
        // ── Loop node: resolve items, then execute body per-iteration ──
        try {
          this._emitStep(runId, step, 'running', null);

          // 1. Resolve the items array and apply maxIterations cap.
          //    A hard default (1000) guards against runaway loops when the user
          //    left maxIterations unset or invalid.
          let items = this._resolveLoopItems(step, nodeId, vars, incoming);
          const HARD_LOOP_CAP = 1000;
          const parsedMax = parseInt(step.maxIterations, 10);
          const effectiveMax = parsedMax > 0 ? parsedMax : HARD_LOOP_CAP;
          if (items.length > effectiveMax) {
            if (!(parsedMax > 0)) {
              console.warn(`[WorkflowRunner] Loop ${step.id}: ${items.length} items exceeds hard cap ${HARD_LOOP_CAP} (maxIterations unset) — truncating.`);
            }
            items = items.slice(0, effectiveMax);
          }

          // 2. Identify "Each" body nodes (slot 0) and "Done" continuation (slot 1)
          const eachTargets = this._getNextNodes(nodeId, 0, outgoing);
          const doneTargets = this._getNextNodes(nodeId, 1, outgoing);

          // 3. Execute sub-BFS for each item
          const allBodyVisited = new Set();
          const iterationResults = [];
          const isParallel = step.mode === 'parallel';

          // Helper: emit live loop progress after each iteration completes
          const _emitLoopProgress = (doneResults) => {
            const partial = { items: doneResults, count: items.length, done: doneResults.length };
            this._send('workflow-loop-progress', { runId, stepId: step.id, loopOutput: partial });
          };

          if (isParallel && eachTargets.length) {
            // Parallel execution with concurrency cap to avoid resource exhaustion.
            const concurrencyLimit = Math.max(1, parseInt(step.concurrency, 10) || 10);
            const doneResults = new Array(items.length).fill(null);

            // ONE shared child AbortController for the whole parallel loop → a single
            // listener on the parent signal instead of one per iteration.
            const loopAbort = new AbortController();
            const onLoopParentAbort = () => loopAbort.abort();
            signal.addEventListener('abort', onLoopParentAbort, { once: true });

            const runIteration = async (item, idx) => {
              if (loopAbort.signal.aborted) return { success: false, error: 'Cancelled', _item: item };
              try {
                const iterVars = new Map(vars);
                iterVars.set('loop', { item, index: idx, total: items.length });
                iterVars.set('item', item);
                iterVars.set('index', idx);
                const iterStepOutputs = {};
                const { outputs, visitedNodes } = await this._executeSubGraph(
                  eachTargets, nodeById, outgoing, incoming, iterVars, runId, loopAbort.signal, iterStepOutputs, workflow
                );
                for (const nid of visitedNodes) allBodyVisited.add(nid);
                Object.assign(stepOutputs, iterStepOutputs);
                const iterResult = { ...outputs, _item: item };
                doneResults[idx] = iterResult;
                _emitLoopProgress(doneResults.filter(Boolean));
                return { success: true, result: iterResult };
              } catch (iterErr) {
                return { success: false, error: iterErr.message, _item: item };
              }
            };

            try {
              // Process items in batches of concurrencyLimit
              for (let batchStart = 0; batchStart < items.length; batchStart += concurrencyLimit) {
                if (loopAbort.signal.aborted) break;
                const batch = items.slice(batchStart, batchStart + concurrencyLimit);
                const settled = await Promise.all(batch.map((item, i) => runIteration(item, batchStart + i)));
                for (const s of settled) {
                  iterationResults.push(s.success ? s.result : { _error: s.error, _item: s._item });
                }
              }
            } finally {
              signal.removeEventListener('abort', onLoopParentAbort);
            }
          } else {
            // Sequential execution (default).
            // Isolate vars/stepOutputs per iteration (mirroring the parallel mode's
            // `new Map(vars)`) so cached node outputs from iteration N are not read
            // as stale values in iteration N+1.
            for (let idx = 0; idx < items.length; idx++) {
              if (signal.aborted) throw new Error('Cancelled');

              const iterVars = new Map(vars);
              iterVars.set('loop', { item: items[idx], index: idx, total: items.length });
              iterVars.set('item', items[idx]);
              iterVars.set('index', idx);
              const iterStepOutputs = {};

              // Execute the "Each" body sub-graph
              const { outputs, visitedNodes } = await this._executeSubGraph(
                eachTargets, nodeById, outgoing, incoming, iterVars, runId, signal, iterStepOutputs, workflow
              );
              // Surface each iteration's step outputs to the run-level accumulator.
              Object.assign(stepOutputs, iterStepOutputs);
              const iterResult = { ...outputs, _item: items[idx] };
              iterationResults.push(iterResult);
              for (const nid of visitedNodes) allBodyVisited.add(nid);
              _emitLoopProgress([...iterationResults]);
            }
          }

          // 4. Store loop result and emit status (failed if any iteration errored)
          const failedCount = iterationResults.filter(r => r && r._error).length;
          const loopOutput = { items: iterationResults, count: items.length, failedCount };
          vars.set(step.id, loopOutput);
          stepOutputs[step.id] = loopOutput;
          const loopStatus = failedCount > 0 ? 'failed' : 'success';
          this._emitStep(runId, step, loopStatus, loopOutput);

          // 5. Clean up loop context
          vars.delete('loop');
          vars.delete('item');
          vars.delete('index');

          // 6. Mark body nodes as visited so main BFS skips them
          for (const nid of allBodyVisited) visited.add(nid);

          // 7. Follow "Done" path (slot 1) for continuation after loop.
          //    Only the Done targets fire; the Each-body targets were consumed
          //    internally and are already marked visited.
          fire(nodeId, doneTargets);

        } catch (err) {
          if (signal.aborted) throw err;
          lastError = err;
          this._emitStep(runId, step, 'failed', { error: err.message });
          throw err;
        }
      } else if (stepType === 'switch') {
        // Switch node: evaluate variable and follow the matched case slot
        try {
          await this._runOneStep(step, vars, runId, signal, stepOutputs, workflow);
        } catch (err) {
          if (signal.aborted) throw err;
          stepOutputs[step.id] = { matchedSlot: -1, success: false };
        }
        const switchOut = stepOutputs[step.id];
        const matchedSlot = switchOut?.matchedSlot ?? 0;
        route(nodeId, this._getNextNodes(nodeId, matchedSlot, outgoing));
      } else if (stepType === 'error_handler') {
        // Try/catch subgraph
        const tryTargets   = this._getNextNodes(nodeId, 0, outgoing);
        const catchTargets = this._getNextNodes(nodeId, 1, outgoing);
        this._emitStep(runId, step, 'running', null);
        if (tryTargets.length === 0) {
          stepOutputs[step.id] = { caught: false, error: null };
          vars.set(step.id, { caught: false, error: null });
          this._emitStep(runId, step, 'success', { caught: false });
        } else {
          try {
            const { visitedNodes } = await this._executeSubGraph(
              tryTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
            );
            for (const nid of visitedNodes) visited.add(nid);
            stepOutputs[step.id] = { caught: false, error: null };
            vars.set(step.id, { caught: false, error: null });
            this._emitStep(runId, step, 'success', { caught: false });
          } catch (err) {
            if (signal.aborted) throw err;
            const errorInfo = { caught: true, error: err.message, message: err.message };
            stepOutputs[step.id] = errorInfo;
            vars.set(step.id, errorInfo);
            // An error_handler node is an EXPLICIT try/catch wired by the user, so a
            // caught error is handled BY DESIGN → the run is a success at the run
            // level (step shown as 'caught'). We deliberately do NOT mark the run
            // degraded here (that would emit a spurious "Workflow failed" notif for
            // an intentionally-handled error). Only retry-exhaustion marks degraded.
            this._emitStep(runId, step, 'caught', { caught: true, error: err.message });
            if (catchTargets.length > 0) {
              const { visitedNodes: catchVisited } = await this._executeSubGraph(
                catchTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
              for (const nid of catchVisited) visited.add(nid);
            }
          }
        }
      } else if (stepType === 'retry') {
        // Retry TRY subgraph up to maxAttempts with backoff
        const tryTargets  = this._getNextNodes(nodeId, 0, outgoing);
        const failTargets = this._getNextNodes(nodeId, 1, outgoing);
        const maxAttempts = Math.max(1, Number(step.maxAttempts) || 3);
        const baseDelay   = Math.max(0, Number(step.delayMs) || 0);
        const backoff     = step.backoff || 'linear';
        this._emitStep(runId, step, 'running', null);
        if (tryTargets.length === 0) {
          stepOutputs[step.id] = { attempts: 0, error: null };
          vars.set(step.id, { attempts: 0, error: null });
          this._emitStep(runId, step, 'success', { attempts: 0 });
        } else {
          let attempts = 0;
          let lastErr  = null;
          while (attempts < maxAttempts) {
            attempts++;
            try {
              const { visitedNodes } = await this._executeSubGraph(
                tryTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
              for (const nid of visitedNodes) visited.add(nid);
              lastErr = null;
              break;
            } catch (err) {
              if (signal.aborted) throw err;
              lastErr = err;
              if (attempts >= maxAttempts) break;
              const delay = backoff === 'exponential'
                ? baseDelay * Math.pow(2, attempts - 1)
                : backoff === 'linear' ? baseDelay * attempts : baseDelay;
              if (delay > 0) await new Promise(r => setTimeout(r, delay));
            }
          }
          if (lastErr) {
            // Retry exhausted all attempts — this is a failure, not a success.
            const info = { attempts, error: lastErr.message, success: false };
            stepOutputs[step.id] = info;
            vars.set(step.id, info);
            this._runDegraded = true;
            this._emitStep(runId, step, 'failed', { attempts, error: lastErr.message });
            if (failTargets.length > 0) {
              const { visitedNodes: failVisited } = await this._executeSubGraph(
                failTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
              for (const nid of failVisited) visited.add(nid);
            }
          } else {
            const info = { attempts, error: null, success: true };
            stepOutputs[step.id] = info;
            vars.set(step.id, info);
            // Recovered after >1 attempt is distinct from clean first-try success.
            if (attempts > 1) this._runDegraded = true;
            this._emitStep(runId, step, attempts > 1 ? 'recovered' : 'success', { attempts });
          }
        }
      } else {
        // Normal step: try to execute
        try {
          await this._runOneStep(step, vars, runId, signal, stepOutputs, workflow);
          // Success → follow slot 0 (Done); seal the Error slot (slot 1) as dead.
          route(nodeId, this._getNextNodes(nodeId, 0, outgoing));
        } catch (err) {
          if (signal.aborted) throw err;
          lastError = err;

          // Check if error slot (slot 1) is connected
          const errorTargets = this._getNextNodes(nodeId, 1, outgoing);
          if (errorTargets.length > 0) {
            // The Error slot is CONNECTED to a handler branch — the failure is
            // handled BY DESIGN. We route down the error path and keep a 'caught'
            // step status for display, but we DO NOT mark the run degraded: an
            // intentionally-wired error branch is a normal success at the run level
            // (mirrors error_handler catch semantics). Marking degraded here would
            // emit a spurious "Workflow failed" notification for a handled error.
            vars.set(step.id, { error: err.message, success: false, caught: true });
            stepOutputs[step.id] = { error: err.message, success: false, caught: true };
            this._emitStep(runId, step, 'caught', { caught: true, error: err.message });
            route(nodeId, errorTargets);
          } else {
            // No error handler wired — propagate failure (fatal).
            throw err;
          }
        }
      }
    }

    // If we got here with a lastError but it was handled via error slots, that's OK
    // The run is considered successful if no unhandled errors occurred
    void lastError;
  }

  /**
   * When the main queue empties, some join nodes may still be waiting on a
   * predecessor that will never run (its whole upstream branch was pruned by an
   * untaken condition/switch). Such nodes have at least one arrived predecessor
   * but their barrier never completed. To avoid silently dropping them, this
   * releases the "most upstream" stalled node so traversal can resume.
   *
   * When several joins are stalled at once we must release the MOST UPSTREAM one
   * first — force-running a downstream join before its upstream sibling would feed
   * it incomplete data. We rank candidates by topological depth (shortest exec-pred
   * distance from the trigger) ascending, breaking ties by how many of a node's
   * static exec predecessors are already accounted for (arrived+dead) descending,
   * then by smallest id for determinism.
   *
   * @returns {number|null} a node id to force-run, or null if none is stalled.
   * @private
   */
  _pickStalledJoin(execPreds, arrived, deadPreds, visited) {
    // Compute topological depth of every node from the exec-pred graph via a
    // longest-path-free BFS relaxation. Roots (no preds) have depth 0; a node's
    // depth is 1 + the max depth of its predecessors. Bounded iterations guard
    // against pathological/cyclic input.
    const depth = new Map();
    const nodesWithPreds = [...execPreds.keys()];
    // Seed: any node that is a predecessor but has no preds of its own = depth 0.
    const allPredIds = new Set();
    for (const preds of execPreds.values()) for (const p of preds) allPredIds.add(p);
    for (const id of allPredIds) if (!execPreds.has(id)) depth.set(id, 0);

    const maxIters = nodesWithPreds.length + 1;
    for (let iter = 0; iter < maxIters; iter++) {
      let changed = false;
      for (const nodeId of nodesWithPreds) {
        let maxPred = -1;
        for (const p of execPreds.get(nodeId)) {
          const d = depth.has(p) ? depth.get(p) : 0;
          if (d > maxPred) maxPred = d;
        }
        const newDepth = maxPred + 1;
        if (depth.get(nodeId) !== newDepth) { depth.set(nodeId, newDepth); changed = true; }
      }
      if (!changed) break;
    }

    let best = null;
    let bestDepth = Infinity;
    let bestResolved = -1;
    for (const [nodeId, preds] of execPreds) {
      if (visited.has(nodeId)) continue;
      const arr = arrived.get(nodeId)?.size || 0;
      if (arr < 1) continue; // only release joins with at least one arrived pred
      const d = depth.has(nodeId) ? depth.get(nodeId) : preds.size;
      const resolved = arr + (deadPreds.get(nodeId)?.size || 0);
      if (
        d < bestDepth ||
        (d === bestDepth && resolved > bestResolved) ||
        (d === bestDepth && resolved === bestResolved && (best == null || nodeId < best))
      ) {
        best = nodeId;
        bestDepth = d;
        bestResolved = resolved;
      }
    }
    return best;
  }

  // Pure data node types: side-effect-free computations that are never reached by
  // the exec BFS. When a downstream node demands their output we execute them on
  // the fly and cache the result. Nodes with side effects (shell/http/db/file/
  // agent/notify/git/…) are intentionally excluded — they must run via exec flow.
  static get PURE_DATA_TYPES() {
    return new Set(['get_variable', 'variable', 'transform', 'time', 'switch', 'condition']);
  }

  /**
   * Lazily compute the output of a pure data node (no exec pins), caching under
   * `node_<id>` in vars. Returns the output object or null if not resolvable.
   * @private
   */
  async _resolvePureDataNode(originId, vars, nodeById) {
    const originStepId = `node_${originId}`;
    const cached = vars.get(originStepId);
    if (cached != null) return cached;

    const pureNode = nodeById.get(originId);
    const pureType = pureNode?.type?.replace('workflow/', '') ?? '';
    if (!WorkflowRunner.PURE_DATA_TYPES.has(pureType)) return null;

    const step = { id: originStepId, type: pureType, ...(pureNode?.properties || {}) };
    let output = null;
    try {
      switch (pureType) {
        case 'get_variable': {
          const varName = pureNode?.properties?.name || '';
          output = { value: vars.get(varName) ?? vars.get(`var_${varName}`) ?? null };
          break;
        }
        case 'variable':
          // Only the 'get' action is side-effect-free; set/increment/append mutate.
          if ((pureNode?.properties?.action || 'set') === 'get') {
            const varName = pureNode?.properties?.name || '';
            output = { value: vars.get(varName) ?? vars.get(`var_${varName}`) ?? null };
          } else {
            return null;
          }
          break;
        case 'transform': output = runTransformStep(step, vars); break;
        case 'switch':    output = runSwitchStep(step, vars); break;
        case 'condition': output = runConditionStep(step, vars); break;
        case 'time':      output = await runTimeStep(step, vars); break;
        default:          return null;
      }
    } catch (err) {
      console.warn(`[WorkflowRunner] Pure data node ${originStepId} (${pureType}) failed:`, err.message);
      return null;
    }
    if (output != null) vars.set(originStepId, output); // cache for future reads
    return output;
  }

  /**
   * Resolve data pin connections for a node before dispatch.
   * Iterates each non-exec input slot, finds the connected origin node's output,
   * and returns an object of { inputName: resolvedValue } to merge into step props.
   *
   * If multiple data links feed a single input slot, only the first is used (a data
   * input can hold one value); this mirrors LiteGraph's single-value input semantics.
   *
   * @param {number} nodeId
   * @param {Map<string,any>} vars
   * @param {Map} incoming  - nodeId → Map<targetSlot, {originId, originSlot}[]>
   * @param {Map} nodeById  - nodeId → node data
   * @returns {Promise<Object>}
   */
  async _resolveDataInputs(nodeId, vars, incoming, nodeById) {
    const node = nodeById.get(nodeId);
    if (!node || !node.inputs) return {};

    const resolved = {};
    const inSlots = incoming.get(nodeId);
    if (!inSlots) return {};

    for (const [slotIdx, links] of inSlots) {
      if (!links || !links.length) continue;

      // Determine if this slot is an exec slot by checking the slot's declared type
      // LiteGraph serializes exec links with type -1 (EVENT) or string 'exec'
      const nodeInput = node.inputs ? node.inputs[slotIdx] : null;
      // Prefer the slot's own type; fall back to the link type
      const slotType = nodeInput?.type ?? links[0]?.type ?? null;
      const isExec = slotType === -1 || slotType === 'exec' || slotType === null || slotType === '';
      if (isExec) continue;

      // A data input slot carries a single value — use the first connected link.
      const { originId, originSlot } = links[0];
      const originStepId = `node_${originId}`;
      let originOutput = vars.get(originStepId);

      // Pure data nodes (no exec pins) are never visited by BFS — resolve inline.
      if (originOutput == null) {
        originOutput = await this._resolvePureDataNode(originId, vars, nodeById);
      }
      if (originOutput == null) continue;

      // Get the output key for the connected slot
      const originNode = nodeById.get(originId);
      const outputKey = this._outputKeyForSlot(originNode, originSlot, originOutput);

      // Get the input name for this slot
      const inputName = nodeInput?.name ?? null;
      if (!inputName) continue;

      const value = outputKey != null ? originOutput[outputKey] : originOutput;
      if (value !== undefined) resolved[inputName] = value;
    }

    return resolved;
  }

  /**
   * Resolve which key of an origin node's output a connected slot refers to.
   *
   * The pin the user actually wired is the authority: `outputs[slot].name` is
   * carried in the saved graph and, for every node type, matches the property
   * name `run()` returns. Consulting it first keeps this correct even when a
   * node builds its pins dynamically (`variable` in get mode drops its exec
   * pins) or exposes more outputs than the shared slot table declares
   * (`shell.timedOut`, `db.columns`, `file.path`, …).
   *
   * NODE_DATA_OUTPUTS stays as the fallback for graphs saved before pin names
   * were persisted, and for nodes whose pin name differs from the output key.
   *
   * @param {Object} originNode  node as stored in the graph
   * @param {number} originSlot
   * @param {Object} originOutput  what the origin node's run() returned
   * @returns {string|null} key to read, or null to pass the whole object
   */
  _outputKeyForSlot(originNode, originSlot, originOutput) {
    const pinName = originNode?.outputs?.[originSlot]?.name;
    if (pinName && originOutput && typeof originOutput === 'object'
        && Object.prototype.hasOwnProperty.call(originOutput, pinName)) {
      return pinName;
    }
    const originType = originNode?.type?.replace('workflow/', '') ?? '';
    return getOutputKeyForSlot(originType, originSlot);
  }

  /**
   * Get the list of node IDs connected to a specific output slot.
   * @param {number} nodeId
   * @param {number} slotIndex
   * @param {Map} outgoing - adjacency map
   * @returns {number[]}
   */
  _getNextNodes(nodeId, slotIndex, outgoing) {
    const slots = outgoing.get(nodeId);
    if (!slots) return [];
    return slots.get(slotIndex) || [];
  }

  /**
   * Extract an array from a node's output.
   * Handles: plain arrays, { rows: [...] } (DB), { items: [...] }, { content: [...] }.
   * @private
   */
  _extractArrayFromOutput(output) {
    if (!output) return null;
    if (Array.isArray(output)) return output;
    // Generic scan: find any non-empty array property — no hardcoded keys needed
    if (typeof output === 'object') {
      for (const val of Object.values(output)) {
        if (Array.isArray(val) && val.length > 0) return val;
      }
    }
    return null;
  }

  /**
   * Resolve loop items from source config (projects, files, custom).
   * Does NOT handle previous_output/auto — that's done in _resolveLoopItems.
   * @private
   */
  _resolveLoopSource(step, vars) {
    const source = step.source || 'projects';

    if (source === 'projects') {
      // Try explicit _projectsList first, then read from Claude Terminal data
      const cached = vars.get('_projectsList');
      if (cached && Array.isArray(cached) && cached.length > 0) return cached;
      try {
        const projFile = path.join(require('os').homedir(), '.claude-terminal', 'projects.json');
        const data = JSON.parse(fs.readFileSync(projFile, 'utf8'));
        const projects = (data.projects || []).map(p => ({
          id: p.id, name: p.name, path: p.path, type: p.type || 'general',
        }));
        if (projects.length > 0) return projects;
      } catch { /* fall through */ }
      const ctx = vars.get('ctx') || {};
      return [ctx.project].filter(Boolean);
    }

    if (source === 'files') {
      // The graph UI writes the pattern into step.items (aligned with loop.node.js);
      // fall back to the legacy step.filter for backward compatibility.
      const filter = resolveVars(step.items ?? step.filter ?? '*', vars);
      const ctx = vars.get('ctx') || {};
      const baseDir = ctx.project || process.cwd();
      try {
        const glob = require('glob');
        return glob.sync(filter, { cwd: baseDir, nodir: true });
      } catch {
        return fs.readdirSync(baseDir).filter(f => f.includes('.'));
      }
    }

    if (source === 'custom') {
      // The graph UI writes the value into step.items (aligned with loop.node.js);
      // fall back to the legacy step.filter for backward compatibility.
      const raw = resolveVars(step.items ?? step.filter ?? '', vars);
      // If resolveVars returned an array (e.g. $var pointing to a JS array), use it directly
      if (Array.isArray(raw)) return raw;
      // If it's a string that looks like JSON array, try to parse it
      if (typeof raw === 'string' && raw.trimStart().startsWith('[')) {
        try { return JSON.parse(raw); } catch { /* fall through to split */ }
      }
      return raw.split('\n').map(s => s.trim()).filter(Boolean);
    }

    return [];
  }

  /**
   * Resolve items for a Loop node in graph mode.
   * Priority:
   *   1. Items input slot (slot 1) connected → use the origin node's output
   *   2. source === 'previous_output' or 'auto' → predecessor on In slot (slot 0)
   *   3. Other source values → projects, files, custom
   * @private
   */
  _resolveLoopItems(step, nodeId, vars, incoming) {
    // Strategy 1: Check if Items input slot (slot 1) is connected
    const itemsInputs = incoming.get(nodeId)?.get(1) || [];
    if (itemsInputs.length > 0) {
      const { originId } = itemsInputs[0];
      const originStepId = `node_${originId}`;
      const originOutput = vars.get(originStepId);
      const items = this._extractArrayFromOutput(originOutput);
      if (items && items.length > 0) return items;
    }

    // Strategy 2: auto / previous_output → look at predecessor on In slot (slot 0)
    const source = step.source || 'auto';
    if (source === 'auto' || source === 'previous_output') {
      const inInputs = incoming.get(nodeId)?.get(0) || [];
      if (inInputs.length > 0) {
        const { originId } = inInputs[0];
        const originStepId = `node_${originId}`;
        const originOutput = vars.get(originStepId);
        const items = this._extractArrayFromOutput(originOutput);
        if (items) return items;
      }
      // If nothing found, return empty array (don't fall through to source-based)
      return [];
    }

    // Strategy 3: source-based resolution (projects, files, custom)
    return this._resolveLoopSource(step, vars);
  }

  /**
   * Execute a sub-graph for loop body iteration.
   * Performs a mini-BFS from the given start nodes.
   * @private
   */
  async _executeSubGraph(startNodeIds, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow) {
    const subVisited = new Set();
    const subQueue = [...startNodeIds];
    const outputs = {};

    while (subQueue.length > 0) {
      if (signal.aborted) throw new Error('Cancelled');

      const nodeId = subQueue.shift();
      if (subVisited.has(nodeId)) continue;
      subVisited.add(nodeId);

      const nodeData = nodeById.get(nodeId);
      if (!nodeData) continue;

      const stepType = nodeData.type.replace('workflow/', '');
      // Merge data pin inputs (Blueprint-style) on top of step properties
      const dataInputs = await this._resolveDataInputs(nodeId, vars, incoming, nodeById);
      const step = {
        id:   `node_${nodeData.id}`,
        type: stepType,
        ...(nodeData.properties || {}),
        ...dataInputs,
      };

      if (stepType === 'condition') {
        try {
          await this._runOneStep(step, vars, runId, signal, stepOutputs, workflow);
        } catch (err) {
          if (signal.aborted) throw err;
          stepOutputs[step.id] = { result: false, value: false };
        }
        const condResult = stepOutputs[step.id]?.result ?? stepOutputs[step.id]?.value ?? true;
        subQueue.push(...this._getNextNodes(nodeId, condResult ? 0 : 1, outgoing));
      } else if (stepType === 'loop') {
        // Nested loop — resolve items and recurse
        this._emitStep(runId, step, 'running', null);
        let nestedItems = this._resolveLoopItems(step, nodeId, vars, incoming);
        {
          const HARD_LOOP_CAP = 1000;
          const parsedMax = parseInt(step.maxIterations, 10);
          const effectiveMax = parsedMax > 0 ? parsedMax : HARD_LOOP_CAP;
          if (nestedItems.length > effectiveMax) {
            if (!(parsedMax > 0)) {
              console.warn(`[WorkflowRunner] Nested loop ${step.id}: ${nestedItems.length} items exceeds hard cap ${HARD_LOOP_CAP} (maxIterations unset) — truncating.`);
            }
            nestedItems = nestedItems.slice(0, effectiveMax);
          }
        }
        const eachTargets = this._getNextNodes(nodeId, 0, outgoing);
        const doneTargets = this._getNextNodes(nodeId, 1, outgoing);
        const nestedResults = [];

        for (let idx = 0; idx < nestedItems.length; idx++) {
          if (signal.aborted) throw new Error('Cancelled');
          // Isolate per-iteration vars/outputs (avoid stale cached node outputs).
          const iterVars = new Map(vars);
          iterVars.set('loop', { item: nestedItems[idx], index: idx, total: nestedItems.length });
          iterVars.set('item', nestedItems[idx]);
          iterVars.set('index', idx);
          const iterStepOutputs = {};
          const { outputs: iterOut, visitedNodes } = await this._executeSubGraph(
            eachTargets, nodeById, outgoing, incoming, iterVars, runId, signal, iterStepOutputs, workflow
          );
          Object.assign(stepOutputs, iterStepOutputs);
          nestedResults.push(iterOut);
          for (const nid of visitedNodes) subVisited.add(nid);
        }

        const loopOutput = { items: nestedResults, count: nestedItems.length };
        vars.set(step.id, loopOutput);
        stepOutputs[step.id] = loopOutput;
        this._emitStep(runId, step, 'success', loopOutput);
        outputs[step.id] = loopOutput;

        vars.delete('loop');
        vars.delete('item');
        vars.delete('index');

        for (const tid of doneTargets) {
          if (!subVisited.has(tid)) subQueue.push(tid);
        }
      } else if (stepType === 'error_handler') {
        // Nested try/catch inside a subgraph
        const tryTargets   = this._getNextNodes(nodeId, 0, outgoing);
        const catchTargets = this._getNextNodes(nodeId, 1, outgoing);
        this._emitStep(runId, step, 'running', null);
        if (tryTargets.length === 0) {
          stepOutputs[step.id] = { caught: false, error: null };
          vars.set(step.id, { caught: false, error: null });
          this._emitStep(runId, step, 'success', { caught: false });
        } else {
          try {
            const { visitedNodes } = await this._executeSubGraph(
              tryTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
            );
            for (const nid of visitedNodes) subVisited.add(nid);
            stepOutputs[step.id] = { caught: false, error: null };
            vars.set(step.id, { caught: false, error: null });
            this._emitStep(runId, step, 'success', { caught: false });
          } catch (err) {
            if (signal.aborted) throw err;
            const errorInfo = { caught: true, error: err.message, message: err.message };
            stepOutputs[step.id] = errorInfo;
            vars.set(step.id, errorInfo);
            // Explicit error_handler catch = handled by design → not degraded
            // (see the main-graph error_handler branch for the rationale).
            this._emitStep(runId, step, 'caught', { caught: true, error: err.message });
            if (catchTargets.length > 0) {
              const { visitedNodes: catchVisited } = await this._executeSubGraph(
                catchTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
              for (const nid of catchVisited) subVisited.add(nid);
            }
          }
        }
      } else if (stepType === 'retry') {
        const tryTargets  = this._getNextNodes(nodeId, 0, outgoing);
        const failTargets = this._getNextNodes(nodeId, 1, outgoing);
        const maxAttempts = Math.max(1, Number(step.maxAttempts) || 3);
        const baseDelay   = Math.max(0, Number(step.delayMs) || 0);
        const backoff     = step.backoff || 'linear';
        this._emitStep(runId, step, 'running', null);
        if (tryTargets.length === 0) {
          stepOutputs[step.id] = { attempts: 0, error: null };
          vars.set(step.id, { attempts: 0, error: null });
          this._emitStep(runId, step, 'success', { attempts: 0 });
        } else {
          let attempts = 0;
          let lastErr  = null;
          while (attempts < maxAttempts) {
            attempts++;
            try {
              const { visitedNodes } = await this._executeSubGraph(
                tryTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
              for (const nid of visitedNodes) subVisited.add(nid);
              lastErr = null;
              break;
            } catch (err) {
              if (signal.aborted) throw err;
              lastErr = err;
              if (attempts >= maxAttempts) break;
              const delay = backoff === 'exponential'
                ? baseDelay * Math.pow(2, attempts - 1)
                : backoff === 'linear' ? baseDelay * attempts : baseDelay;
              if (delay > 0) await new Promise(r => setTimeout(r, delay));
            }
          }
          if (lastErr) {
            const info = { attempts, error: lastErr.message, success: false };
            stepOutputs[step.id] = info;
            vars.set(step.id, info);
            this._runDegraded = true;
            this._emitStep(runId, step, 'failed', { attempts, error: lastErr.message });
            if (failTargets.length > 0) {
              const { visitedNodes: failVisited } = await this._executeSubGraph(
                failTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
              for (const nid of failVisited) subVisited.add(nid);
            }
          } else {
            const info = { attempts, error: null, success: true };
            stepOutputs[step.id] = info;
            vars.set(step.id, info);
            if (attempts > 1) this._runDegraded = true;
            this._emitStep(runId, step, attempts > 1 ? 'recovered' : 'success', { attempts });
          }
        }
      } else {
        // Normal step
        try {
          await this._runOneStep(step, vars, runId, signal, stepOutputs, workflow);
          subQueue.push(...this._getNextNodes(nodeId, 0, outgoing));
        } catch (err) {
          if (signal.aborted) throw err;
          const errorTargets = this._getNextNodes(nodeId, 1, outgoing);
          if (errorTargets.length > 0) {
            // Error slot connected → handled by design; keep a 'caught' step status
            // for display but do NOT mark the run degraded (see _executeGraph note).
            vars.set(step.id, { error: err.message, success: false, caught: true });
            stepOutputs[step.id] = { error: err.message, success: false, caught: true };
            this._emitStep(runId, step, 'caught', { caught: true, error: err.message });
            subQueue.push(...errorTargets);
          } else {
            throw err;
          }
        }
      }

      outputs[step.id] = stepOutputs[step.id];
    }

    return { outputs, visitedNodes: subVisited };
  }

  /**
   * Recursively execute a list of steps.
   * @private
   */
  async _runSteps(steps, vars, runId, signal, stepOutputs, workflow) {
    for (const step of steps) {
      if (signal.aborted) throw new Error('Cancelled');

      // Evaluate condition
      if (step.condition && !evalCondition(resolveVars(step.condition, vars), vars)) {
        this._emitStep(runId, step, 'skipped', null);
        continue;
      }

      await this._runOneStep(step, vars, runId, signal, stepOutputs, workflow);
    }
  }

  /**
   * Execute one step with retry logic.
   * @private
   */
  async _runOneStep(step, vars, runId, signal, stepOutputs, workflow) {
    const maxAttempts = (step.retry ?? 0) + 1;
    const retryDelay  = step.retry_delay ? parseMs(step.retry_delay) : 5_000;
    const stepTimeout = step.timeout ? parseMs(step.timeout) : null;

    let lastErr;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) throw new Error('Cancelled');

      this._emitStep(runId, step, 'running', null, attempt > 1 ? attempt : undefined);

      // Per-step timeout: chain into a child abort
      let stepAbort = signal;
      let stepTimer;
      let _stepAbortOnParent;
      if (stepTimeout) {
        const controller = new AbortController();
        stepTimer = setTimeout(() => controller.abort(), stepTimeout);
        // Propagate parent cancellation — stored so we can remove it in finally
        _stepAbortOnParent = () => controller.abort();
        signal.addEventListener('abort', _stepAbortOnParent, { once: true });
        stepAbort = controller.signal;
      }

      try {
        const output = await this._dispatchStep(step, vars, runId, stepAbort, workflow);

        if (stepTimer) clearTimeout(stepTimer);
        if (_stepAbortOnParent) signal.removeEventListener('abort', _stepAbortOnParent);

        // Store output under step.id for downstream variable access
        if (step.id) {
          // Annotate with _type so the UI can display the correct step icon/label
          const annotated = output && typeof output === 'object'
            ? { ...output, _type: step.type || '' }
            : output;
          vars.set(step.id, annotated);
          stepOutputs[step.id] = annotated;
        }

        this._emitStep(runId, step, 'success', output);
        return; // success — exit retry loop

      } catch (err) {
        if (stepTimer) clearTimeout(stepTimer);
        if (_stepAbortOnParent) signal.removeEventListener('abort', _stepAbortOnParent);
        lastErr = err;

        if (signal.aborted) throw err; // propagate cancellation immediately

        if (attempt < maxAttempts) {
          this._emitStep(runId, step, 'retrying', { error: err.message, attempt });
          await sleep(retryDelay, signal);
        }
      }
    }

    // All attempts exhausted
    this._emitStep(runId, step, 'failed', { error: lastErr?.message });
    throw lastErr;
  }

  /**
   * Dispatch to the correct step handler.
   * Consults the node registry first; falls back to the legacy inline handlers
   * if the registry has no entry or the entry has no run() method.
   * @private
   */
  async _dispatchStep(step, vars, runId, signal, workflow) {
    const type = step.type || '';

    // ── Registry-based dispatch (Task 9) ─────────────────────────────────────
    // Node files store their type as 'workflow/<name>'; the step arrives here
    // with the prefix already stripped (done in _executeGraph / _runSteps).
    const fullType = `workflow/${type}`;
    const nodeDef  = this._nodeRegistry.get(fullType);

    if (nodeDef && typeof nodeDef.run === 'function') {
      const config = this._resolveStepConfig(step);
      const ctx = {
        chatService:     this._chatService,
        workflowService: this._workflowService,
        databaseService: this._databaseService,
        sendFn:          (channel, data) => this._send(channel, data),
        waitCallbacks:   this._waitCallbacks,
        runId,
      };
      return nodeDef.run(config, vars, signal, ctx);
    }

    // TODO(registry): remove when all node runs are in .node.js
    // ── Built-in universal steps (legacy fallback) ────────────────────────────

    if (type === 'agent' || type === 'claude') {
      return runAgentStep(step, vars, signal, this._chatService, (msg) => {
        this._send('workflow-agent-message', { runId, stepId: step.id, message: msg });
      });
    }

    if (type === 'parallel') {
      return this._runParallelStep(step, vars, runId, signal, workflow);
    }

    if (type === 'get_variable') {
      // Pure getter node — read a named variable from vars
      const varName = step.name || '';
      const value = vars.get(varName) ?? vars.get(`var_${varName}`) ?? null;
      return { value };
    }

    // ── Project-type native steps (fivem.ensure, api.request, …) ─────────────

    const dotIdx = type.indexOf('.');
    if (dotIdx > 0) {
      const prefix  = type.slice(0, dotIdx);
      const subType = type.slice(dotIdx + 1);
      const handler = this._projectTypeRegistry[prefix];
      if (handler?.executeWorkflowStep) {
        return handler.executeWorkflowStep(subType, step, vars, signal);
      }
    }

    throw new Error(`Unknown step type: ${type}`);
  }

  /**
   * parallel step: run all sub-steps concurrently, collect results.
   * @private
   */
  async _runParallelStep(step, vars, runId, signal, workflow) {
    const substeps = step.steps || [];
    const failFast = step.failFast !== false;

    // A single shared child AbortController is propagated to every substep, so we
    // register exactly ONE listener on the parent signal (instead of N). On the
    // first failure in failFast mode we abort it to cancel the in-flight peers.
    const groupAbort = new AbortController();
    const onParentAbort = () => groupAbort.abort();
    signal.addEventListener('abort', onParentAbort, { once: true });

    const outputsByStep = new Array(substeps.length);
    const settled = await Promise.allSettled(
      substeps.map((sub, i) => {
        const outputs = {};
        outputsByStep[i] = outputs;
        return this._runOneStep(sub, vars, runId, groupAbort.signal, outputs, workflow)
          .then(() => outputs[sub.id])
          .catch(err => {
            // In failFast mode, cancel peers as soon as one substep rejects.
            if (failFast && !groupAbort.signal.aborted) groupAbort.abort();
            throw err;
          });
      })
    );
    signal.removeEventListener('abort', onParentAbort);

    const results = {};
    for (let i = 0; i < substeps.length; i++) {
      const s = substeps[i];
      results[s.id || `p${i}`] = settled[i].status === 'fulfilled'
        ? settled[i].value
        : { error: settled[i].reason?.message };
    }

    // If the parent was cancelled, surface that rather than a generic failure.
    if (signal.aborted) throw new Error('Cancelled');

    const anyFailed = settled.some(r => r.status === 'rejected');
    if (anyFailed && failFast) {
      throw new Error('One or more parallel steps failed');
    }

    return results;
  }

  // ─── Event emission ─────────────────────────────────────────────────────────

  _emitStep(runId, step, status, output, attempt) {
    // Track final step status for persistence (overwrite — last status wins)
    if (this._stepStatuses && status !== 'running' && status !== 'retrying') {
      this._stepStatuses.set(step.id, { status, output: this._safeOutput(output) });
    }
    this._send('workflow-step-update', {
      runId,
      stepId:  step.id,
      stepType: step.type,
      status,
      output: this._safeOutput(output),
      attempt,
    });
  }

  _safeOutput(output) {
    if (!output) return null;
    try {
      JSON.stringify(output);
      return output;
    } catch {
      return { _raw: String(output) };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = WorkflowRunner;
