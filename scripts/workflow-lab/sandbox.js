/**
 * sandbox.js — isolated environment for executing workflow nodes for real.
 *
 * DEV TOOL ONLY. `scripts/` is not in electron-builder's `files` allowlist, so
 * nothing here ships in the app.
 *
 * Nodes touch the filesystem, git, sqlite, HTTP and the user's data directory.
 * Running them against the real machine would be destructive and
 * non-reproducible, so every sandbox gets:
 *   - its own temp working directory
 *   - a fake HOME, so ~/.claude-terminal and ~/.claude are throwaway
 *   - on-demand git repo / sqlite db / local HTTP server
 *   - recording stubs for chatService, sendFn, databaseService, workflowService
 *
 * The fake HOME is installed by overriding USERPROFILE/HOME before any node
 * module is required, because os.homedir() reads those env vars on each call.
 */

'use strict';

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const http    = require('http');
const assert  = require('assert');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

let _seq = 0;

/**
 * @typedef {Object} Sandbox
 * @property {string} dir       throwaway working directory
 * @property {string} home      fake home directory
 * @property {Map}    vars      workflow variables handed to run()
 * @property {Object} ctx       the ctx object nodes receive
 * @property {Array}  sent      every sendFn(channel, payload) call, in order
 */

/**
 * Create an isolated sandbox.
 * Always pair with `sb.cleanup()` (the lab runner does it in a finally).
 * @returns {Sandbox}
 */
function createSandbox(label = 'node') {
  const id   = `wflab-${process.pid}-${_seq++}`;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${id}-`));
  const dir  = path.join(base, 'work');
  const home = path.join(base, 'home');

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude-terminal'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

  const prevEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME        = home;

  const sent    = [];
  const servers = [];
  const prompts = [];

  const sb = {
    label, dir, home, sent, prompts,
    vars: new Map([['ctx', { project: dir }]]),

    /** Write a fixture file under the sandbox working dir. */
    file(rel, content = '') {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return p;
    },

    /** Read a file back from the sandbox working dir. */
    read(rel) {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    },

    exists(rel) {
      return fs.existsSync(path.join(dir, rel));
    },

    /** Write a JSON file into the fake ~/.claude-terminal. */
    dataFile(name, obj) {
      const p = path.join(home, '.claude-terminal', name);
      fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
      return p;
    },

    /** Initialise a git repo in the working dir with one commit. */
    gitRepo() {
      const git = (...args) => execFileSync('git', args, {
        cwd: dir,
        stdio: 'pipe',
        env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_SYSTEM: '' },
      }).toString();
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'lab@example.invalid');
      git('config', 'user.name', 'Workflow Lab');
      // Pin line endings in the repo's LOCAL config. This helper isolates
      // GIT_CONFIG_GLOBAL but the node's own spawnGit() does not, so on a
      // machine with core.autocrlf=true the two disagreed about whether a
      // checked-out file was modified — making a working stash look broken.
      git('config', 'core.autocrlf', 'false');
      git('config', 'core.eol', 'lf');
      sb.file('README.md', '# sandbox\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'initial');
      return { git, dir };
    },

    /** Create an sqlite file with a `items` table, return its path. */
    sqlite(name = 'test.db') {
      let Database;
      try { Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3')); }
      catch { return null; }
      const p  = path.join(dir, name);
      const db = new Database(p);
      db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)');
      db.exec("INSERT INTO items (name, qty) VALUES ('alpha', 3), ('beta', 7)");
      db.close();
      return p;
    },

    /**
     * Start a local HTTP server. Returns its base URL.
     * NOTE: nodes that call assertSafeUrl reject loopback addresses, so this is
     * only usable by nodes without an SSRF guard — that asymmetry is itself
     * something the lab reports.
     */
    async http(handler) {
      const server = http.createServer(handler);
      await new Promise(res => server.listen(0, '127.0.0.1', res));
      servers.push(server);
      return `http://127.0.0.1:${server.address().port}`;
    },

    /** The ctx object WorkflowRunner passes to node.run(). */
    ctx: {
      runId: 'lab-run',
      sendFn: (channel, payload) => sent.push({ channel, payload }),
      waitCallbacks: new Map(),
      chatService: {
        async runSinglePrompt(opts) {
          prompts.push(opts);
          return { output: 'stub claude output', success: true };
        },
      },
      databaseService: null,
      workflowService: null,
    },

    /** Find the first recorded sendFn call on a channel. */
    sentOn(channel) {
      return sent.find(s => s.channel === channel)?.payload ?? null;
    },

    async cleanup() {
      for (const s of servers) await new Promise(res => s.close(res));
      process.env.USERPROFILE = prevEnv.USERPROFILE;
      process.env.HOME        = prevEnv.HOME;
      // Windows holds brief locks on files a child git process just touched, so
      // a single rmSync leaves the odd directory behind. Retry a few times
      // before giving up; sweepStaleSandboxes() catches whatever still escapes.
      for (let attempt = 0; attempt < 4; attempt++) {
        try { fs.rmSync(base, { recursive: true, force: true }); return; }
        catch { await new Promise(res => setTimeout(res, 50 * (attempt + 1))); }
      }
    },
  };

  return sb;
}

// ── Execution helpers ────────────────────────────────────────────────────────

/**
 * Execute a single node's run() against a sandbox.
 * @param {string} type   short type, e.g. 'shell'
 * @param {Object} config node properties
 * @param {Sandbox} sb
 * @returns {Promise<Object>} whatever run() returned
 */
async function runNode(type, config, sb, { signal } = {}) {
  const registry = require(path.join(ROOT, 'src/main/workflow-nodes/_registry'));
  registry.loadRegistry();
  const def = registry.get(`workflow/${type}`);
  if (!def) throw new Error(`No node definition for "${type}"`);
  if (typeof def.run !== 'function') throw new Error(`Node "${type}" has no run()`);
  return def.run(config, sb.vars, signal ?? new AbortController().signal, sb.ctx);
}

const EXEC = -1;

/** Build a `trigger -> <type>` two-node graph, for control-flow nodes. */
function simpleGraph(type, properties, extraNodes = [], extraLinks = []) {
  return {
    nodes: [
      {
        id: 1, type: 'workflow/trigger', properties: {},
        inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [1] }],
      },
      {
        id: 2, type: `workflow/${type}`, properties,
        inputs: [{ name: 'In', type: EXEC, link: 1 }],
        outputs: [{ name: 'Done', type: EXEC, links: [] }, { name: 'Error', type: EXEC, links: [] }],
      },
      ...extraNodes,
    ],
    links: [[1, 1, 0, 2, 0, EXEC], ...extraLinks],
  };
}

/**
 * Run a full graph through the real WorkflowRunner.
 * Required for control-flow nodes (loop, condition, switch, retry,
 * error_handler, subworkflow) whose behaviour lives in the runner, not run().
 */
async function runGraph(graph, sb) {
  const WorkflowRunner = require(path.join(ROOT, 'src/main/services/WorkflowRunner'));
  const runner = new WorkflowRunner({
    sendFn: sb.ctx.sendFn,
    chatService: sb.ctx.chatService,
    waitCallbacks: sb.ctx.waitCallbacks,
    projectTypeRegistry: {},
    databaseService: sb.ctx.databaseService,
    workflowService: sb.ctx.workflowService,
  });
  const run = { id: 'lab-run', workflowId: 'lab-wf', status: 'running', steps: [], triggerData: { source: 'manual' } };
  return runner.execute({ id: 'lab-wf', name: 'lab', graph }, run, new AbortController(), sb.vars);
}

/**
 * Delete sandbox directories left behind by earlier runs.
 *
 * cleanup() retries, but a directory whose files are still locked at process
 * exit survives anyway. Without this sweep the temp folder accumulates a few
 * strays on every run, forever.
 *
 * @param {number} maxAgeMs only remove directories older than this
 * @returns {number} how many were removed
 */
function sweepStaleSandboxes(maxAgeMs = 60 * 60 * 1000) {
  const tmp = os.tmpdir();
  let removed = 0;
  let entries;
  try { entries = fs.readdirSync(tmp); } catch { return 0; }

  for (const name of entries) {
    if (!name.startsWith('wflab-')) continue;
    const p = path.join(tmp, name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs < maxAgeMs) continue;
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    } catch { /* still locked — next run will get it */ }
  }
  return removed;
}

module.exports = { createSandbox, runNode, runGraph, simpleGraph, sweepStaleSandboxes, assert, EXEC };
