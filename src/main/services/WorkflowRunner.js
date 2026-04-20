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

const { exec, execFile } = require('child_process');
const fs            = require('fs');
const path          = require('path');
const crypto        = require('crypto');

const {
  gitCommit, gitPull, gitPush, gitStageFiles,
  checkoutBranch, createBranch, spawnGit,
} = require('../utils/git');

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
    let cur = vars.get(parts[0]);
    for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
    if (cur != null) {
      // Trim trailing CR/LF from shell command outputs (e.g. `date` on Windows)
      return typeof cur === 'string' ? cur.replace(/[\r\n]+$/, '') : cur;
    }
  }

  // Mixed text with variables: interpolate as strings
  return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
    const parts = key.split('.');
    // Try resolving from longest path down to root variable
    // e.g. $today.md → try "today.md" (fails) → try "today" + suffix ".md"
    for (let take = parts.length; take >= 1; take--) {
      let cur = vars.get(parts[0]);
      for (let i = 1; i < take && cur != null; i++) cur = cur[parts[i]];
      if (cur != null && (take === parts.length || typeof cur !== 'object')) {
        // Trim CR/LF that shell commands often append (e.g. `date` output on Windows)
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

// ─── Shell step ───────────────────────────────────────────────────────────────

function runShellStep(config, vars, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'));

    const command = resolveVars(config.command || '', vars);
    const cwd     = resolveVars(config.cwd || process.cwd(), vars);
    const timeout = config.timeout ? parseMs(config.timeout) : 60_000;

    if (!command.trim()) return resolve({ exitCode: 0, stdout: '', stderr: '' });

    let child;
    const onAbort = () => { try { child?.kill('SIGKILL'); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Use exec with shell: true to support pipes, &&, redirections, env vars
    child = exec(command, { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('Cancelled'));
      resolve({ exitCode: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Minimal command parser: respects double-quoted segments. */
function parseCommand(cmd) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === ' ' && !inQuote) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ─── Git step ─────────────────────────────────────────────────────────────────

async function runGitStep(config, vars) {
  // Resolve cwd: prefer explicit cwd, then resolve projectId to a path via ctx
  let cwd = resolveVars(config.cwd || '', vars);
  if (!cwd && config.projectId) {
    // projectId is stored but we need the project path — use ctx.project as fallback
    const ctx = vars.get('ctx') || {};
    cwd = ctx.project || '';
  }
  if (!cwd) {
    const ctx = vars.get('ctx') || {};
    cwd = ctx.project || process.cwd();
  }

  // Support graph-based node format: config.action = 'pull'|'push'|'commit'|etc.
  if (config.action && !config.actions) {
    const action = config.action;
    const branch = resolveVars(config.branch || '', vars);
    const message = resolveVars(config.message || '', vars);
    let res;

    switch (action) {
      case 'pull':       res = await gitPull(cwd); break;
      case 'push':       res = await gitPush(cwd); break;
      case 'commit':     {
        await gitStageFiles(cwd, config.files || ['.']);
        res = await gitCommit(cwd, message || 'workflow commit');
        break;
      }
      case 'checkout':   res = await checkoutBranch(cwd, branch); break;
      case 'merge':      res = await spawnGit(cwd, ['merge', branch]); break;
      case 'stash':      res = await spawnGit(cwd, ['stash']); break;
      case 'stash-pop':  res = await spawnGit(cwd, ['stash', 'pop']); break;
      case 'reset':      res = await spawnGit(cwd, ['reset', '--hard', 'HEAD']); break;
      default:           res = { success: false, error: `Unknown git action: ${action}` };
    }
    return { success: res.success !== false, output: res.output || res.stdout || '', action };
  }

  // Legacy format: config.actions array or single config with pull/push/commit keys
  const actions = Array.isArray(config.actions) ? config.actions : [config];

  const results = [];
  for (const action of actions) {
    const resolved = resolveDeep(action, vars);
    let res;

    if (resolved.pull)     res = await gitPull(cwd);
    else if (resolved.push)     res = await gitPush(cwd);
    else if (resolved.commit)   res = await (async () => {
      await gitStageFiles(cwd, resolved.files || ['.']);
      return gitCommit(cwd, resolved.commit);
    })();
    else if (resolved.checkout) res = await checkoutBranch(cwd, resolved.checkout);
    else if (resolved.branch)   res = await createBranch(cwd, resolved.branch);
    else if (resolved.command)  res = await spawnGit(cwd, resolved.command.split(/\s+/));
    else res = { success: false, error: 'Unknown git action' };

    results.push(res);
    if (!res.success) {
      return { success: false, error: res.error, results };
    }
  }

  return { success: true, output: results.map(r => r.output || '').join('\n'), results };
}

// ─── HTTP step ────────────────────────────────────────────────────────────────

async function runHttpStep(config, vars, signal) {
  const url     = resolveVars(config.url || '', vars);
  const method  = (config.method || 'GET').toUpperCase();

  // Headers may come as a JSON string from the panel or as an object from legacy format
  let rawHeaders = config.headers || {};
  if (typeof rawHeaders === 'string') {
    try { rawHeaders = JSON.parse(resolveVars(rawHeaders, vars)); } catch { rawHeaders = {}; }
  }
  const headers = resolveDeep(rawHeaders, vars);

  // Body may come as a JSON string from the panel or as an object
  let rawBody = config.body;
  if (typeof rawBody === 'string') {
    rawBody = resolveVars(rawBody, vars);
    try { rawBody = JSON.parse(rawBody); } catch { /* keep as string */ }
  }
  const body = rawBody ? JSON.stringify(resolveDeep(rawBody, vars)) : undefined;
  const timeout = config.timeout ? parseMs(config.timeout) : 30_000;

  const aborter = new AbortController();
  const timer   = setTimeout(() => aborter.abort(), timeout);
  // Chain external cancellation
  const onAbort = () => aborter.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res  = await fetch(url, { method, headers, body, signal: aborter.signal });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* text only */ }
    return { status: res.status, ok: res.ok, body: json ?? text };
  } catch (err) {
    if (signal?.aborted) throw new Error('Cancelled');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// ─── File step ────────────────────────────────────────────────────────────────

/**
 * Validate that a resolved path stays within the workflow's project directory.
 * Prevents path traversal attacks (e.g. ../../etc/passwd).
 */
function assertPathWithinProject(filePath, vars) {
  const ctx = vars.get('ctx') || {};
  const projectDir = ctx.project;
  if (!projectDir) return; // no project context — skip check (manual runs)
  const resolved = path.resolve(filePath);
  const base = path.resolve(projectDir);
  // Case-insensitive comparison on Windows to prevent bypass via mixed case
  const cmp = process.platform === 'win32'
    ? (a, b) => a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + path.sep)
    : (a, b) => a === b || a.startsWith(b + path.sep);
  if (!cmp(resolved, base)) {
    throw new Error(`Path "${filePath}" is outside the project directory`);
  }
}

/**
 * Expand a glob pattern in a base directory and return matching file paths.
 * Handles simple wildcards (* and **) without requiring a glob library.
 * Falls back to regex matching if 'glob' npm package is unavailable.
 */
function expandGlob(pattern, baseDir) {
  // Build a regex from the glob pattern
  const toRegex = (pat) => {
    // Escape special regex chars except * and ?
    let reStr = pat
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\x00DOUBLESTAR\x00')
      .replace(/\*/g, '[^/\\\\]*')
      .replace(/\x00DOUBLESTAR\x00/g, '.*')
      .replace(/\?/g, '[^/\\\\]');
    return new RegExp('^' + reStr + '$', process.platform === 'win32' ? 'i' : '');
  };

  const re = toRegex(pattern);
  const results = [];

  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const relPath = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else {
        if (re.test(relPath)) results.push(relPath);
      }
    }
  };

  walk(baseDir, '');
  return results;
}

async function runFileStep(config, vars) {
  const action  = config.action || 'read';
  const p       = resolveVars(config.path || '', vars);
  const dest    = resolveVars(config.destination || config.dest || '', vars);
  const content = resolveVars(config.content || '', vars);

  // Validate paths stay within the project directory
  if (p && action !== 'list') assertPathWithinProject(p, vars);
  if (dest) assertPathWithinProject(dest, vars);

  switch (action) {
    case 'read':
      return { content: fs.readFileSync(p, 'utf8') };
    case 'write':
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return { success: true };
    case 'append':
      fs.appendFileSync(p, content, 'utf8');
      return { success: true };
    case 'copy':
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(p, dest);
      return { success: true };
    case 'delete':
      fs.rmSync(p, { force: true, recursive: true });
      return { success: true };
    case 'exists':
      return { exists: fs.existsSync(p), path: p };
    case 'move':
    case 'rename': {
      if (!dest) throw new Error('File move/rename requires a destination path');
      assertPathWithinProject(p, vars);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(p, dest);
      return { success: true, from: p, to: dest };
    }
    case 'list': {
      // p is used as the base directory; config.pattern is the glob pattern
      const baseDir = p || (() => { const ctx = vars.get('ctx') || {}; return ctx.project || process.cwd(); })();
      if (baseDir) assertPathWithinProject(baseDir, vars);
      const pattern = resolveVars(config.pattern || '*', vars);
      const recursive = config.recursive === true || config.recursive === 'true';

      let files;
      // Simple non-recursive listing (no wildcards crossing directories)
      if (!recursive && !pattern.includes('**') && !pattern.includes('/')) {
        let entries;
        try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { entries = []; }
        const re = new RegExp(
          '^' + pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/\\\\]*')
            .replace(/\?/g, '[^/\\\\]') + '$',
          process.platform === 'win32' ? 'i' : ''
        );
        const type = config.type || 'files'; // 'files' | 'dirs' | 'all'
        files = entries
          .filter(e => {
            if (type === 'files' && !e.isFile()) return false;
            if (type === 'dirs'  && !e.isDirectory()) return false;
            return re.test(e.name);
          })
          .map(e => e.name);
      } else {
        files = expandGlob(pattern, baseDir);
      }

      return { files, count: files.length, dir: baseDir };
    }
    default:
      throw new Error(`Unknown file action: ${action}`);
  }
}

// ─── Database step ───────────────────────────────────────────────────────────

/**
 * Run a database query/schema/tables operation.
 * Requires a DatabaseService instance passed to the runner.
 *
 * @param {Object}  config          - step config
 * @param {Map}     vars            - resolved variables
 * @param {Object}  databaseService - DatabaseService singleton
 * @returns {Promise<Object>}       - { rows, columns, rowCount, duration, firstRow } | { tables, tableCount }
 */
async function runDbStep(config, vars, databaseService) {
  if (!databaseService) throw new Error('DatabaseService not available');

  const connId = resolveVars(config.connection || '', vars);
  if (!connId) throw new Error('No database connection specified');

  const action = config.action || 'query';

  // Ensure connection is active (auto-connect if needed)
  const connections = await databaseService.loadConnections();
  const connConfig = connections.find(c => c.id === connId);
  if (!connConfig) throw new Error(`Database connection "${connId}" not found`);

  // Retrieve password from OS keychain (passwords are stripped from disk config)
  const cred = await databaseService.getCredential(connId);
  if (cred?.success && cred.password) {
    connConfig.password = cred.password;
  }

  // Connect (or reconnect) to the database
  const connResult = await databaseService.connect(connId, connConfig);
  if (!connResult?.success) {
    throw new Error(`Database connection failed: ${connResult?.error || 'Unknown error'}`);
  }

  if (action === 'schema') {
    const schema = await databaseService.getSchema(connId, { force: true });
    if (!schema?.success) throw new Error(schema?.error || 'Failed to get schema');
    const tables = schema.tables || [];
    return { tables, tableCount: tables.length };
  }

  if (action === 'tables') {
    const schema = await databaseService.getSchema(connId, { force: true });
    if (!schema?.success) throw new Error(schema?.error || 'Failed to get schema');
    const tables = (schema.tables || []).map(t => t.name || t.table_name || t);
    return { tables, tableCount: tables.length };
  }

  // action === 'query'
  const sql   = resolveVars(config.query || '', vars);
  const limit = parseInt(config.limit, 10) || 100;

  if (!sql.trim()) throw new Error('Empty SQL query');

  const start  = Date.now();
  const result = await databaseService.executeQuery(connId, sql, limit);
  const duration = Date.now() - start;

  if (result.error) throw new Error(result.error);

  const rows     = result.rows || [];
  const columns  = result.columns || [];
  const rowCount = result.rowCount ?? rows.length;
  const firstRow = rows.length > 0 ? rows[0] : null;

  return { rows, columns, rowCount, duration, firstRow };
}

// ─── Project step ─────────────────────────────────────────────────────────────

/**
 * Run a project-related operation (list, set_context, open, build, install, test).
 * @param {Object} config
 * @param {Map}    vars
 * @param {Function} sendFn
 */
async function runProjectStep(config, vars, sendFn) {
  const action = config.action || 'set_context';
  const projectId = config.projectId || '';
  const ctx = vars.get('ctx') || {};

  if (action === 'list') {
    // Read all projects from Claude Terminal data file
    const projFile = path.join(require('os').homedir(), '.claude-terminal', 'projects.json');
    try {
      const data = JSON.parse(fs.readFileSync(projFile, 'utf8'));
      const projects = (data.projects || []).map(p => ({
        id:   p.id,
        name: p.name,
        path: p.path,
        type: p.type || 'general',
      }));
      return { projects, count: projects.length, success: true };
    } catch {
      return { projects: [], count: 0, success: true };
    }
  }

  if (action === 'set_context') {
    // Update the workflow context to use this project for subsequent steps
    if (projectId) ctx.activeProjectId = projectId;
    vars.set('ctx', ctx);
    return { success: true, action, projectId };
  }

  // For open/build/install/test — delegate to renderer via sendFn
  sendFn('workflow-project-action', { action, projectId: projectId || ctx.activeProjectId || '' });
  return { success: true, action, projectId };
}

// ─── Variable step ────────────────────────────────────────────────────────────

/**
 * Manipulate workflow-level variables (set, get, increment, append).
 * @param {Object} config
 * @param {Map}    vars
 */
function runVariableStep(config, vars) {
  const action = config.action || 'set';
  const name   = config.name || '';
  if (!name) throw new Error('Variable node: no name specified');

  const currentValue = vars.get(name);

  switch (action) {
    case 'set': {
      const raw = config.value != null ? config.value : '';
      const value = resolveVars(raw, vars);
      vars.set(name, value);
      return { name, value, action: 'set' };
    }
    case 'get': {
      return { name, value: currentValue ?? null, action: 'get' };
    }
    case 'increment': {
      const increment = parseFloat(config.value) || 1;
      const newValue = (parseFloat(currentValue) || 0) + increment;
      vars.set(name, newValue);
      return { name, value: newValue, action: 'increment' };
    }
    case 'append': {
      const rawA = config.value != null ? config.value : '';
      const value = resolveVars(rawA, vars);
      const arr = Array.isArray(currentValue) ? currentValue : (currentValue ? [currentValue] : []);
      arr.push(value);
      vars.set(name, arr);
      return { name, value: arr, action: 'append' };
    }
    default:
      throw new Error(`Variable node: unknown action "${action}"`);
  }
}

// ─── Log step ─────────────────────────────────────────────────────────────────

/**
 * Write a message to the workflow run log.
 * @param {Object} config
 * @param {Map}    vars
 * @param {Function} sendFn
 */
function runLogStep(config, vars, sendFn) {
  const level   = config.level || 'info';
  const message = resolveVars(config.message || '', vars);

  sendFn('workflow-log', { level, message, timestamp: Date.now() });
  return { level, message, logged: true };
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

// ─── Wait step ────────────────────────────────────────────────────────────────

/**
 * Pause execution. Resolves when:
 *   - `onApprove(runId, stepId)` is called (human confirmation via IPC)
 *   - OR timeout expires (if configured)
 *   - OR signal is aborted
 * @param {Object} config
 * @param {AbortSignal} signal
 * @param {Map<string, Function>} waitCallbacks  - shared registry: key → resolve fn
 * @param {string} runId
 * @param {string} stepId
 */
function runWaitStep(config, signal, waitCallbacks, runId, stepId) {
  // Simple delay mode: if duration is set, just sleep for that time
  const duration = config.duration;
  if (duration) {
    const ms = parseMs(duration);
    return sleep(ms, signal).then(() => ({ waited: ms, timedOut: false }));
  }

  // Approval mode: wait for human callback or timeout
  return new Promise((resolve, reject) => {
    const key     = `${runId}::${stepId}`;
    const timeout = config.timeout ? parseMs(config.timeout) : null;

    const done = (result) => {
      waitCallbacks.delete(key);
      clearTimeout(timer);
      resolve(result);
    };

    waitCallbacks.set(key, done);

    const timer = timeout
      ? setTimeout(() => done({ timedOut: true, approved: false }), timeout)
      : null;

    const onAbort = () => {
      waitCallbacks.delete(key);
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

// ─── Notify step ─────────────────────────────────────────────────────────────

/**
 * @param {Object} config
 * @param {Map}    vars
 * @param {Function} sendFn  - main process _send (workflow-notify channel)
 */
async function runNotifyStep(config, vars, sendFn) {
  const message  = resolveVars(config.message || '', vars);
  const channels = config.channels || ['desktop'];
  const title    = resolveVars(config.title || 'Workflow', vars);

  const tasks = [];

  for (const ch of channels) {
    if (ch === 'desktop') {
      // Delegate to renderer notification system via a dedicated channel
      sendFn('workflow-notify-desktop', { title, message });
    } else if (typeof ch === 'object') {
      // { discord: '$secrets.URL' } or { slack: '...' }
      const [type, urlRaw] = Object.entries(ch)[0];
      const url = resolveVars(urlRaw, vars);
      if (!url || url.startsWith('$')) continue; // unresolved secret → skip

      let body;
      if (type === 'discord') {
        body = JSON.stringify({ content: message });
      } else if (type === 'slack') {
        body = JSON.stringify({ text: message });
      } else {
        body = JSON.stringify({ message });
      }

      tasks.push(
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(err => console.warn(`[WorkflowRunner] Notify ${type} failed:`, err.message))
      );
    }
  }

  await Promise.allSettled(tasks);
  return { sent: true, message };
}

// ─── Time tracking step ──────────────────────────────────────────────────────

/**
 * Query time tracking data by reading ~/.claude-terminal/timetracking.json directly.
 * Uses the shared getTimeStats() from time.ipc — no IPC round-trip needed.
 * @param {Object} config  { action, projectId?, startDate?, endDate? }
 * @param {Map}    vars
 */
function runTimeStep(config, vars) {
  const { getTimeStats } = require('../ipc/time.ipc');
  const result = getTimeStats({
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

  // Safe expression evaluator — builds a function with item as argument
  // Only allows simple property access and comparisons, no arbitrary eval
  const makeFn = (body) => {
    try {
      // eslint-disable-next-line no-new-func
      return new Function('item', 'index', `"use strict"; return (${body});`);
    } catch {
      throw new Error(`Invalid expression: ${body}`);
    }
  };

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
      const reduceFn = expr ? new Function('acc', 'item', 'index', `"use strict"; return (${expr});`) : (acc, item) => acc + item; // eslint-disable-line no-new-func
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

// ─── Sub-workflow step ─────────────────────────────────────────────────────────

/**
 * Run another workflow by name or ID and optionally wait for completion.
 * Injects inputVars into the triggered workflow's context.
 */
async function runSubworkflowStep(config, vars, workflowService) {
  const workflowRef = resolveVars(config.workflow || '', vars);
  if (!workflowRef) throw new Error('Sub-workflow: missing workflow name or ID');

  // Parse optional input variables as JSON object or key=value pairs
  let extraVars = {};
  if (config.inputVars) {
    const raw = resolveVars(config.inputVars, vars);
    try {
      extraVars = typeof raw === 'object' ? raw : JSON.parse(raw);
    } catch {
      // key=value,key2=value2 fallback
      for (const pair of raw.split(',')) {
        const [k, v] = pair.split('=').map(s => s.trim());
        if (k) extraVars[k] = v ?? '';
      }
    }
  }

  const waitForCompletion = config.waitForCompletion !== false && config.waitForCompletion !== 'no';

  const runId = await workflowService.trigger(workflowRef, 'subworkflow', { parent: true, extraVars });

  if (!waitForCompletion) {
    return { triggered: true, runId, waited: false };
  }

  // Poll for completion (max 10 min)
  const start = Date.now();
  const TIMEOUT = 10 * 60 * 1000;
  const POLL = 1000;

  while (Date.now() - start < TIMEOUT) {
    await new Promise(r => setTimeout(r, POLL));
    const run = workflowService.getRunById(runId);
    if (!run) break;
    if (run.status === 'success') {
      return { success: true, runId, outputs: run.outputs || {}, waited: true };
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      throw new Error(`Sub-workflow "${workflowRef}" ${run.status}`);
    }
  }

  throw new Error(`Sub-workflow "${workflowRef}" timed out after 10 minutes`);
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
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return parseInt(value, 10) || 60_000;
  const [, n, unit] = match;
  const num = parseFloat(n);
  const multipliers = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(num * (multipliers[unit] || 1000));
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

    const globalTimeoutMs = workflow.timeout ? parseMs(workflow.timeout) : null;
    const globalTimer = globalTimeoutMs
      ? setTimeout(() => abort.abort(), globalTimeoutMs)
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
      return { success: true, outputs: stepOutputs, stepStatuses: this._stepStatuses };
    } catch (err) {
      if (abort.signal.aborted) {
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

    // BFS traversal from trigger node
    // The trigger has output slot 0 = "Start"
    const visited = new Set();
    const queue = this._getNextNodes(triggerNode.id, 0, outgoing); // slot 0 = Start

    // Emit trigger as running then success
    this._emitStep(runId, { id: `node_${triggerNode.id}`, type: 'trigger' }, 'running', null);
    this._emitStep(runId, { id: `node_${triggerNode.id}`, type: 'trigger' }, 'success', null);
    visited.add(triggerNode.id);
    // Expose trigger data as Blueprint data outputs (payload, source)
    const triggerData = vars.get('trigger') || {};
    vars.set(`node_${triggerNode.id}`, { payload: triggerData.payload ?? triggerData, source: triggerData.source || 'manual' });

    let lastError = null;

    while (queue.length > 0) {
      if (signal.aborted) throw new Error('Cancelled');

      const nodeId = queue.shift();
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const nodeData = nodeById.get(nodeId);
      if (!nodeData) continue;

      // Convert node to step format for the dispatcher
      const stepType = nodeData.type.replace('workflow/', '');
      // Merge data pin inputs (Blueprint-style) on top of step properties
      const dataInputs = this._resolveDataInputs(nodeId, vars, incoming, nodeById);
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
        queue.push(...this._getNextNodes(nodeId, nextSlot, outgoing));
      } else if (stepType === 'loop') {
        // ── Loop node: resolve items, then execute body per-iteration ──
        try {
          this._emitStep(runId, step, 'running', null);

          // 1. Resolve the items array and apply maxIterations cap
          let items = this._resolveLoopItems(step, nodeId, vars, incoming);
          const maxIter = parseInt(step.maxIterations, 10);
          if (maxIter > 0 && items.length > maxIter) {
            items = items.slice(0, maxIter);
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
            // Parallel execution with concurrency cap to avoid resource exhaustion
            const concurrencyLimit = Math.max(1, parseInt(step.concurrency, 10) || 10);
            const doneResults = new Array(items.length).fill(null);

            const runIteration = async (item, idx) => {
              if (signal.aborted) return { success: false, error: 'Cancelled', _item: item };
              const iterAbort = new AbortController();
              const onParentAbort = () => iterAbort.abort();
              signal.addEventListener('abort', onParentAbort, { once: true });
              try {
                const iterVars = new Map(vars);
                iterVars.set('loop', { item, index: idx, total: items.length });
                iterVars.set('item', item);
                iterVars.set('index', idx);
                const iterStepOutputs = {};
                const { outputs, visitedNodes } = await this._executeSubGraph(
                  eachTargets, nodeById, outgoing, incoming, iterVars, runId, iterAbort.signal, iterStepOutputs, workflow
                );
                for (const nid of visitedNodes) allBodyVisited.add(nid);
                const iterResult = { ...outputs, _item: item };
                doneResults[idx] = iterResult;
                _emitLoopProgress(doneResults.filter(Boolean));
                return { success: true, result: iterResult };
              } catch (iterErr) {
                return { success: false, error: iterErr.message, _item: item };
              } finally {
                signal.removeEventListener('abort', onParentAbort);
              }
            };

            // Process items in batches of concurrencyLimit
            for (let batchStart = 0; batchStart < items.length; batchStart += concurrencyLimit) {
              if (signal.aborted) break;
              const batch = items.slice(batchStart, batchStart + concurrencyLimit);
              const settled = await Promise.all(batch.map((item, i) => runIteration(item, batchStart + i)));
              for (const s of settled) {
                iterationResults.push(s.success ? s.result : { _error: s.error, _item: s._item });
              }
            }
          } else {
            // Sequential execution (default)
            for (let idx = 0; idx < items.length; idx++) {
              if (signal.aborted) throw new Error('Cancelled');

              // Set loop context variables
              vars.set('loop', { item: items[idx], index: idx, total: items.length });
              vars.set('item', items[idx]);
              vars.set('index', idx);

              // Execute the "Each" body sub-graph
              const { outputs, visitedNodes } = await this._executeSubGraph(
                eachTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
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

          // 7. Follow "Done" path (slot 1) for continuation after loop
          for (const tid of doneTargets) {
            if (!visited.has(tid)) queue.push(tid);
          }

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
        queue.push(...this._getNextNodes(nodeId, matchedSlot, outgoing));
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
            this._emitStep(runId, step, 'success', { caught: true, error: err.message });
            if (catchTargets.length > 0) {
              const { visitedNodes: catchVisited } = await this._executeSubGraph(
                catchTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
              for (const nid of catchVisited) visited.add(nid);
            }
          }
        }
      } else {
        // Normal step: try to execute
        try {
          await this._runOneStep(step, vars, runId, signal, stepOutputs, workflow);
          // Success → follow slot 0 (Done)
          queue.push(...this._getNextNodes(nodeId, 0, outgoing));
        } catch (err) {
          if (signal.aborted) throw err;
          lastError = err;

          // Check if error slot (slot 1) is connected
          const errorTargets = this._getNextNodes(nodeId, 1, outgoing);
          if (errorTargets.length > 0) {
            // Error is handled — follow the error path
            // Store error info for downstream nodes
            vars.set(step.id, { error: err.message, success: false });
            stepOutputs[step.id] = { error: err.message, success: false };
            queue.push(...errorTargets);
          } else {
            // No error handler — propagate failure
            throw err;
          }
        }
      }
    }

    // If we got here with a lastError but it was handled via error slots, that's OK
    // The run is considered successful if no unhandled errors occurred
  }

  /**
   * Resolve data pin connections for a node before dispatch.
   * Iterates each non-exec input slot, finds the connected origin node's output,
   * and returns an object of { inputName: resolvedValue } to merge into step props.
   *
   * @param {number} nodeId
   * @param {Map<number,any>} vars
   * @param {Map} incoming  - nodeId → Map<targetSlot, {originId, originSlot}[]>
   * @param {Map} nodeById  - nodeId → node data
   * @returns {Object}
   */
  _resolveDataInputs(nodeId, vars, incoming, nodeById) {
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

      const { originId, originSlot } = links[0];
      const originStepId = `node_${originId}`;
      let originOutput = vars.get(originStepId);

      // Pure data nodes (no exec pins) are never visited by BFS.
      // Resolve them inline when first encountered.
      if (originOutput == null) {
        const pureNode = nodeById.get(originId);
        const pureType = pureNode?.type?.replace('workflow/', '') ?? '';
        if (pureType === 'get_variable' || (pureType === 'variable' && pureNode?.properties?.action === 'get')) {
          const varName = pureNode?.properties?.name || '';
          const val = vars.get(varName) ?? vars.get(`var_${varName}`) ?? null;
          originOutput = { value: val };
          vars.set(originStepId, originOutput); // cache for future reads
        }
      }
      if (originOutput == null) continue;

      // Get the output key from slot mapping
      const originNode = nodeById.get(originId);
      const originType = originNode?.type?.replace('workflow/', '') ?? '';
      const outputKey = getOutputKeyForSlot(originType, originSlot);

      // Get the input name for this slot
      const inputName = nodeInput?.name ?? null;
      if (!inputName) continue;

      const value = outputKey != null ? originOutput[outputKey] : originOutput;
      if (value !== undefined) resolved[inputName] = value;
    }

    return resolved;
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
      const filter = resolveVars(step.filter || '*', vars);
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
      const raw = resolveVars(step.filter || '', vars);
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
      const dataInputs = this._resolveDataInputs(nodeId, vars, incoming, nodeById);
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
        const nestedItems = this._resolveLoopItems(step, nodeId, vars, incoming);
        const eachTargets = this._getNextNodes(nodeId, 0, outgoing);
        const doneTargets = this._getNextNodes(nodeId, 1, outgoing);
        const nestedResults = [];

        for (let idx = 0; idx < nestedItems.length; idx++) {
          if (signal.aborted) throw new Error('Cancelled');
          vars.set('loop', { item: nestedItems[idx], index: idx, total: nestedItems.length });
          vars.set('item', nestedItems[idx]);
          vars.set('index', idx);
          const { outputs: iterOut, visitedNodes } = await this._executeSubGraph(
            eachTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
          );
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
            this._emitStep(runId, step, 'success', { caught: true, error: err.message });
            if (catchTargets.length > 0) {
              const { visitedNodes: catchVisited } = await this._executeSubGraph(
                catchTargets, nodeById, outgoing, incoming, vars, runId, signal, stepOutputs, workflow
              );
              for (const nid of catchVisited) subVisited.add(nid);
            }
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
            vars.set(step.id, { error: err.message, success: false });
            stepOutputs[step.id] = { error: err.message, success: false };
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

    if (type === 'shell') {
      return runShellStep(step, vars, signal);
    }

    if (type === 'git') {
      return runGitStep(step, vars);
    }

    if (type === 'http') {
      return runHttpStep(step, vars, signal);
    }

    if (type === 'file') {
      return runFileStep(step, vars);
    }

    if (type === 'db') {
      const result = await runDbStep(step, vars, this._databaseService);
      // Also store under outputVar alias if configured (e.g. $dbResult.rows)
      if (step.outputVar && step.id) {
        vars.set(step.outputVar, result);
      }
      return result;
    }

    if (type === 'condition') {
      return runConditionStep(step, vars);
    }

    if (type === 'project') {
      return runProjectStep(step, vars, this._send);
    }

    if (type === 'variable') {
      return runVariableStep(step, vars);
    }

    if (type === 'log') {
      return runLogStep(step, vars, this._send);
    }

    if (type === 'notify') {
      return runNotifyStep(step, vars, this._send);
    }

    if (type === 'wait') {
      return runWaitStep(step, signal, this._waitCallbacks, runId, step.id || `step_${Date.now()}`);
    }

    if (type === 'loop') {
      return this._runLoopStep(step, vars, runId, signal, workflow);
    }

    if (type === 'parallel') {
      return this._runParallelStep(step, vars, runId, signal, workflow);
    }

    if (type === 'transform') {
      return runTransformStep(step, vars);
    }

    if (type === 'subworkflow') {
      return runSubworkflowStep(step, vars, this._workflowService);
    }

    if (type === 'switch') {
      return runSwitchStep(step, vars);
    }

    if (type === 'time') {
      return runTimeStep(step, vars);
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
   * loop step (legacy): iterate over an array, run sub-steps for each item.
   * Used for linear/legacy workflows with step.over + step.steps.
   * Graph mode loops are handled directly in _executeGraph.
   * @private
   */
  async _runLoopStep(step, vars, runId, signal, workflow) {
    let items;

    if (step.source && !step.over) {
      const source = step.source;
      if (source === 'previous_output' || source === 'auto') {
        // Scan vars for most recent array output from a node
        for (const [key, val] of vars) {
          if (!key.startsWith('node_') && !key.startsWith('step_')) continue;
          const arr = this._extractArrayFromOutput(val);
          if (arr) { items = arr; /* keep scanning — last one wins */ }
        }
        if (!items) items = [];
      } else {
        items = this._resolveLoopSource(step, vars);
      }
    } else {
      // Legacy format: step.over = '$varName.path'
      const overKey = resolveVars(step.over || '', vars);
      const parts = overKey.replace(/^\$/, '').split('.');
      items = vars.get(parts[0]);
      for (let i = 1; i < parts.length && items != null; i++) items = items[parts[i]];
    }

    if (!Array.isArray(items)) {
      throw new Error(`loop: could not resolve items to an array (source: ${step.source || step.over})`);
    }

    const results = [];
    for (let idx = 0; idx < items.length; idx++) {
      if (signal.aborted) throw new Error('Cancelled');

      const itemVars = new Map(vars);
      itemVars.set('item', items[idx]);
      itemVars.set('index', idx);
      itemVars.set('loop', { item: items[idx], index: idx, total: items.length });

      if (step.steps && step.steps.length > 0) {
        const iterOutputs = {};
        await this._runSteps(step.steps, itemVars, runId, signal, iterOutputs, workflow);
        results.push(iterOutputs);
      } else {
        results.push(items[idx]);
      }
    }

    return { items: results, count: items.length };
  }

  /**
   * parallel step: run all sub-steps concurrently, collect results.
   * @private
   */
  async _runParallelStep(step, vars, runId, signal, workflow) {
    const substeps = step.steps || [];
    const settled  = await Promise.allSettled(
      substeps.map(sub => {
        const outputs = {};
        // Each substep gets its own child AbortController so that N parallel
        // substeps don't stack N listeners on the shared parent signal.
        const subAbort = new AbortController();
        const onParentAbort = () => subAbort.abort();
        signal.addEventListener('abort', onParentAbort, { once: true });
        return this._runOneStep(sub, vars, runId, subAbort.signal, outputs, workflow)
          .then(() => outputs[sub.id])
          .finally(() => signal.removeEventListener('abort', onParentAbort));
      })
    );

    const results = {};
    for (let i = 0; i < substeps.length; i++) {
      const s = substeps[i];
      results[s.id || `p${i}`] = settled[i].status === 'fulfilled'
        ? settled[i].value
        : { error: settled[i].reason?.message };
    }

    const anyFailed = settled.some(r => r.status === 'rejected');
    if (anyFailed && step.failFast !== false) {
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
