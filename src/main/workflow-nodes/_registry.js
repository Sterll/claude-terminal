// src/main/workflow-nodes/_registry.js
'use strict';

const fs   = require('fs');
const path = require('path');

const _nodes = new Map();
let _loaded  = false;

function loadRegistry() {
  if (_loaded) return;
  _loaded = true;
  const dir = __dirname;
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith('_') || !file.endsWith('.node.js')) continue;
    try {
      const def = require(path.join(dir, file));
      if (!def.type) { console.warn(`[NodeRegistry] ${file} missing 'type'`); continue; }
      _nodes.set(def.type, def);
    } catch (e) {
      console.error(`[NodeRegistry] Failed to load ${file}:`, e.message);
    }
  }
}

function get(type)   { return _nodes.get(type) || null; }
function getAll()    { return [..._nodes.values()]; }
function has(type)   { return _nodes.has(type); }
function getTypes()  { return [..._nodes.keys()]; }

/**
 * Resolve a project reference (id, name fragment, or absolute path) to a
 * filesystem path. Falls back to the run context's active project when `ref`
 * is empty.
 *
 * Nodes that expose a project picker store `projectId`, which is meaningless
 * to the filesystem — without this, a project-scoped node triggered by cron
 * (where there is no "current project") silently runs in the home directory.
 *
 * @param {string} ref
 * @param {Map|Object} vars
 * @returns {string|null}
 */
function resolveProjectPath(ref, vars) {
  if (!ref) {
    const ctx = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
    // `ctx.project` is the run's own project path and is the ONLY one of these
    // WorkflowRunner actually sets (see _buildVars); activeProjectId is written
    // solely by the `project` node. Without it the documented "falls back to
    // the run context" promise never held, and a project-scoped or
    // cron-triggered workflow with an empty picker hard-failed.
    ref = ctx.activeProjectId || ctx.projectId || ctx.project || '';
  }
  if (!ref) return null;
  if (fs.existsSync(ref)) return ref;
  try {
    const file = path.join(require('os').homedir(), '.claude-terminal', 'projects.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const needle = String(ref).toLowerCase();
    const p = (data.projects || []).find(pr =>
      pr.id === ref || (pr.name || '').toLowerCase().includes(needle)
    );
    return p?.path || null;
  } catch {
    return null;
  }
}

/**
 * Shared HTML escaping utility for node render() functions.
 * Centralised here to avoid duplication across every .node.js file.
 * @param {*} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Read a value from the vars container by key path.
 * Supports Map, plain object and nested access ($a.b.c).
 * @param {Map|Object|null|undefined} vars
 * @param {string[]} parts   - already-split key path
 * @returns {*} the resolved leaf value, or undefined
 */
function _lookup(vars, parts) {
  if (vars == null) return undefined;
  let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
  for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
  return cur;
}

/**
 * Robust variable resolution for node config templates.
 *
 * - Handles `vars` being null / undefined / a plain object / a Map.
 * - Supports nested access `$a.b.c`.
 * - When the whole string is a single `$ref` and it resolves to a non-string
 *   value (array/object/number/boolean), the raw value is returned (not a
 *   stringified copy) so downstream nodes receive real data.
 * - When a `$ref` inside a larger string resolves to an object, an empty
 *   string is substituted for the leaf (never a JSON dump of a parent object).
 * - Unresolved references are left untouched (`$foo` stays `$foo`).
 * - CR/LF are NOT trimmed globally — that is left to individual nodes (shell).
 *
 * @param {*} template
 * @param {Map|Object|null|undefined} vars
 * @returns {*}
 */
function resolveVars(template, vars) {
  if (typeof template !== 'string') return template;

  const RE = /\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g;

  // Fast path: the entire string is a single variable reference.
  const single = template.match(/^\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)$/);
  if (single) {
    const val = _lookup(vars, single[1].split('.'));
    if (val === undefined) return template; // unresolved — keep literal
    return val; // raw value (string, number, array, object, ...)
  }

  return template.replace(RE, (match, key) => {
    const val = _lookup(vars, key.split('.'));
    if (val == null) return '';                       // resolved-but-empty leaf
    if (typeof val === 'object') return '';            // never dump parent objects
    return String(val);
  });
}

/**
 * Validate a URL string for outbound requests (SSRF guard).
 * Only http/https is allowed. Loopback, link-local and RFC-1918 private
 * address ranges are rejected. Hostnames that are not literal IPs are allowed
 * (DNS may still resolve to a private IP — this is a best-effort static guard).
 *
 * @param {string} urlString
 * @returns {URL} the parsed URL when safe
 * @throws {Error} when the URL is unsafe or malformed
 */
function assertSafeUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Blocked URL protocol "${url.protocol}" (only http/https allowed)`);
  }

  let host = url.hostname.toLowerCase();
  // Strip IPv6 brackets if present
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  // Loopback / localhost
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') {
    throw new Error(`Blocked request to loopback address "${host}"`);
  }

  // IPv4 literal checks
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some(n => n > 255)) throw new Error(`Invalid IP address "${host}"`);
    const [a, b] = o;
    if (a === 127) throw new Error(`Blocked request to loopback address "${host}"`);       // 127.0.0.0/8
    if (a === 10) throw new Error(`Blocked request to private address "${host}"`);          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) throw new Error(`Blocked request to private address "${host}"`); // 172.16.0.0/12
    if (a === 192 && b === 168) throw new Error(`Blocked request to private address "${host}"`);          // 192.168.0.0/16
    if (a === 169 && b === 254) throw new Error(`Blocked request to link-local address "${host}"`);       // 169.254.0.0/16
  }

  // IPv6 loopback / unique-local / link-local literals
  if (host.includes(':')) {
    if (host === '::1') throw new Error(`Blocked request to loopback address "${host}"`);
    if (/^f[cd][0-9a-f]{2}:/.test(host)) throw new Error(`Blocked request to private address "${host}"`); // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(host)) throw new Error(`Blocked request to link-local address "${host}"`); // fe80::/10
  }

  return url;
}

/**
 * Normalize an exec (child_process) error into a numeric exit code plus flags.
 * @param {Error|null|undefined} err  - the error passed by exec/execFile callback
 * @returns {{ exitCode: number, timedOut: boolean, truncated: boolean, killed: boolean }}
 */
function normalizeExitCode(err) {
  if (!err) return { exitCode: 0, timedOut: false, truncated: false, killed: false };
  const timedOut  = err.killed === true && err.signal === 'SIGTERM' && err.code == null
    ? true
    : /timed?\s*out/i.test(String(err.message || ''));
  const truncated = /maxBuffer|stdout maxBuffer|ENOBUFS/i.test(String(err.message || ''));
  const killed    = err.killed === true || err.signal != null;
  let exitCode;
  if (typeof err.code === 'number') exitCode = err.code;
  else if (typeof err.status === 'number') exitCode = err.status;
  else exitCode = killed || timedOut ? 124 : 1; // 124 = conventional timeout code
  return { exitCode, timedOut, truncated, killed };
}

module.exports = {
  loadRegistry, get, getAll, has, getTypes, esc,
  resolveVars, assertSafeUrl, normalizeExitCode, resolveProjectPath,
};
