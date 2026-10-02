/**
 * Git Utilities
 * Helper functions for git operations in the main process
 */

const { execFile, execFileSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Track all active git child processes for cleanup on app quit
const _activeProcesses = new Set();

// Cache safeDirArgs results per cwd (avoids statSync/readFileSync on every git call)
const _safeDirCache = new Map();
const SAFE_DIR_CACHE_TTL = 30000;

// Defence in depth: the `ext::` transport runs an arbitrary shell command on fetch/push.
// Disable it globally so no code path can reach it, even with a malicious remote URL.
const HARDENING_ARGS = ['-c', 'protocol.ext.allow=never'];

/**
 * Build safe.directory args array for git
 * Includes worktree parent repo when a .git file (not dir) points to a parent.
 * @param {string} cwd - Working directory
 * @returns {string[]} - Args array ['-c', 'safe.directory=...', ...]
 */
function safeDirArgs(cwd) {
  const cached = _safeDirCache.get(cwd);
  if (cached && Date.now() - cached.time < SAFE_DIR_CACHE_TTL) return cached.args;

  const cwdNorm = cwd.replace(/\\/g, '/');
  const args = ['-c', `safe.directory=${cwdNorm}`];
  try {
    const gitPath = path.join(cwd, '.git');
    const stat = fs.statSync(gitPath);
    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = fs.readFileSync(gitPath, 'utf8').trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        const gitDir = path.resolve(cwd, match[1]);
        // Parent repo is typically two levels up from the worktree gitdir
        // e.g. gitdir points to /repo/.git/worktrees/<name>
        const parentRepo = path.resolve(gitDir, '..', '..', '..').replace(/\\/g, '/');
        if (parentRepo !== cwdNorm) {
          args.push('-c', `safe.directory=${parentRepo}`);
        }
      }
    }
  } catch (_) {
    // Not a worktree or .git doesn't exist - ignore
  }

  // Evict old entries to prevent unbounded growth
  if (_safeDirCache.size > 100) _safeDirCache.clear();
  _safeDirCache.set(cwd, { args, time: Date.now() });
  return args;
}

// ── Failure reporting ───────────────────────────────────────────────────────
//
// execGit() historically collapsed four very different outcomes into a bare
// `null`: the directory is gone, git exited non-zero, git had to be killed on
// timeout, or **git is not installed at all**. Every one of the 69 git IPC
// handlers then read that null as "clean repo, no branches, no commits", so a
// machine without git on PATH rendered a perfectly healthy-looking empty repo.
//
// execGitResult() below is the real primitive and reports which of the four it
// was; execGit() is a thin compatibility wrapper over it so the existing
// callers keep their string|null contract untouched.

/** Reasons a git invocation can fail, most specific first. */
const GIT_FAILURE_MESSAGES = {
  enoent: 'Git is not installed or not available on PATH',
  timeout: 'Git command timed out',
  nodir: 'Directory not found',
  badargs: 'Git command was built incorrectly',
  // Remote (SSH) projects only: the host's connection is down. Never produced
  // for a local path.
  disconnected: 'The remote host is not connected',
};

/** Failures caused by the environment rather than by the repository state. */
const ENVIRONMENT_FAILURES = new Set(['enoent', 'timeout']);

// ENOENT is a global condition: on a machine without git every single call
// fails the same way, which would flood the error log with hundreds of
// identical entries per dashboard load. Log it at most once per window.
const ENOENT_LOG_INTERVAL_MS = 60000;
let _lastEnoentLog = 0;

/** Lazily resolved so a missing/broken error log can never break a git call. */
let _errorLogModule;
function _errorLog() {
  if (_errorLogModule === undefined) {
    try {
      _errorLogModule = require('../services/ErrorLogService');
    } catch (_) {
      _errorLogModule = null;
    }
  }
  return _errorLogModule;
}

/**
 * Short, log-safe label for a git invocation: the subcommand plus at most one
 * more positional token. Keeps user paths and branch names out of the log.
 * @param {string[]} argsArray
 * @returns {string}
 */
function _commandLabel(argsArray) {
  const positional = argsArray.filter(a => typeof a === 'string' && !a.startsWith('-'));
  return positional.slice(0, 2).join(' ') || 'git';
}

/**
 * Human-readable reason a git invocation failed.
 * @param {{reason?: string, error?: string}} result - An execGitResult() result
 * @returns {string}
 */
function describeGitFailure(result) {
  if (!result) return 'Git command failed';
  if (GIT_FAILURE_MESSAGES[result.reason]) return GIT_FAILURE_MESSAGES[result.reason];
  const stderr = typeof result.error === 'string' ? result.error.trim() : '';
  return stderr || 'Git command failed';
}

/**
 * True when the failure means "git could not run", as opposed to "the repo
 * says no". Only these two are worth telling the user about.
 * @param {{reason?: string}} result - An execGitResult() result
 * @returns {boolean}
 */
function isGitUnavailable(result) {
  return !!result && ENVIRONMENT_FAILURES.has(result.reason);
}

/**
 * Build the `{ isGitRepo: false }` payload, enriched when git itself is the
 * problem. The extra fields are additive: consumers that only read `isGitRepo`
 * behave exactly as before.
 * @param {{reason?: string, error?: string}} [result] - An execGitResult() result
 * @returns {{isGitRepo: false, gitUnavailable?: boolean, unavailableReason?: string, message?: string}}
 */
function notAGitRepo(result) {
  // A remote host that is down says nothing about the repository: say so, so
  // the UI can show "reconnecting" instead of "not a git repository".
  if (result && result.reason === 'disconnected') {
    return { isGitRepo: false, disconnected: true, reason: 'disconnected', message: describeGitFailure(result) };
  }
  if (!isGitUnavailable(result)) return { isGitRepo: false };
  return {
    isGitRepo: false,
    gitUnavailable: true,
    unavailableReason: result.reason,
    message: describeGitFailure(result),
  };
}

/** Record the failures that are actionable; stay silent on routine ones. */
function _logGitFailure(cwd, argsArray, reason, error) {
  const log = _errorLog();
  if (!log) return;
  try {
    if (reason === 'enoent') {
      const now = Date.now();
      if (now - _lastEnoentLog < ENOENT_LOG_INTERVAL_MS) return;
      _lastEnoentLog = now;
      log.logWarning('git', GIT_FAILURE_MESSAGES.enoent, {
        context: { command: _commandLabel(argsArray), cwd },
      });
    } else if (reason === 'timeout') {
      log.logWarning('git', `git ${_commandLabel(argsArray)} timed out`, {
        context: { command: _commandLabel(argsArray), cwd, error },
      });
    }
    // 'exit' and 'nodir' are ordinary control flow (no upstream, no tags, a
    // folder that is simply not a repo) - logging them would be pure noise.
  } catch (_) {
    // Logging must never break a git call.
  }
}

// ── Remote (SSH) projects ───────────────────────────────────────────────────
//
// A project path that is an `ssh-remote://` URI runs its git on the remote
// host, through the persistent command channel of its host profile
// (design/remote-ssh.md section 5.4). The fork happens in the primitives
// below, *before* the local `fs.existsSync` bail-out, so every function in this
// file serves both kinds with the same result contracts. For a local path
// nothing here runs: the local code path is byte for byte what it was, which
// tests/utils/gitLocalArgv.test.js pins against a recorded argv snapshot.
//
// - The remote command is `[ -d <dir> ] || exit 96; cd -- <dir> &&
//   GIT_TERMINAL_PROMPT=0 exec git -c protocol.ext.allow=never <args...>`,
//   every argument quoted by remote-shell's q(). safe.directory is not added:
//   it is a local Windows ownership workaround that reads `.git` with fs.
// - Failures map onto the local reasons: a missing directory is 'nodir', exit
//   127 is 'enoent', the transport being down is 'disconnected' (new, remote
//   only), a timeout is 'timeout'.
// - Read-only commands are cached for 2 s per (host, directory, argv), and
//   concurrent identical reads share one request, so the Git panel and the
//   file explorer polling the same status do not each pay a round trip. Any
//   write on the host drops that host's cache, before and after it runs.
// - Every request is registered, so killAllGitProcesses() at quit cancels them.

const remotePath = require('../../shared/remote-path');
const remoteShell = require('../../shared/remote-shell');

const REMOTE_READ_TTL_MS = 2000;
const REMOTE_CACHE_MAX = 500;

/** Subcommands that never change the repository. */
const READ_ONLY_COMMANDS = new Set([
  'status', 'rev-parse', 'log', 'diff', 'show', 'describe', 'rev-list', 'shortlog', 'ls-files',
  'grep', 'blame', 'diff-tree', 'merge-base', 'cat-file', 'for-each-ref', 'ls-tree', 'show-ref',
  'name-rev', 'var', 'version', 'check-ignore',
]);

const BRANCH_LIST_FLAG = /^(-r|-a|-l|-v|-vv|--all|--remotes|--list|--show-current|--verbose|--no-color|--format=.*|--sort=.*|--merged(=.*)?|--no-merged(=.*)?|--contains(=.*)?|--points-at(=.*)?)$/;

/**
 * True when a git argv only reads the repository. Anything not recognised is
 * a write: a write fails fast while the host reconnects and is never
 * replayed, a read waits for the connection, so guessing "read" wrongly is
 * the dangerous direction.
 * @param {string[]} args
 * @returns {boolean}
 */
function isReadOnlyGitCommand(args) {
  if (!Array.isArray(args)) return false;
  let i = 0;
  while (i < args.length && (args[i] === '-c' || args[i] === '-C')) i += 2;
  const verb = args[i];
  const rest = args.slice(i + 1);
  if (READ_ONLY_COMMANDS.has(verb)) return true;
  switch (verb) {
    case 'branch': return rest.every((a) => BRANCH_LIST_FLAG.test(a));
    case 'remote': return rest.length === 0 || ['-v', 'get-url', 'show'].includes(rest[0]);
    case 'stash': return rest[0] === 'list' || rest[0] === 'show';
    case 'tag': return rest.length === 0 || rest.includes('-l') || rest.includes('--list');
    case 'worktree': return rest[0] === 'list';
    case 'config': return rest.some((a) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a));
    default: return false;
  }
}

let _remoteExecutorOverride = null;
let _remoteNow = () => Date.now();
const _remoteReadCache = new Map();   // key -> { at, result } | { pending }
const _remoteGenerations = new Map(); // profileId -> number, bumped by every write
const _remoteControllers = new Set(); // AbortControllers of in-flight remote requests

/**
 * How a remote request reaches its host: resolve the URI (profile known, path
 * inside a registered project, or this throws) then run one script on the
 * profile's channel. Injectable for tests.
 */
function _remoteExecutor() {
  if (_remoteExecutorOverride) return _remoteExecutorOverride;
  return {
    resolve: (uri) => require('./projectTarget').resolveTarget(uri),
    exec: (target, script, options) => require('../services/SshHostService').exec(target.profileId, script, options),
    isConnected: (profileId) => require('../services/SshHostService').getStatus(profileId).state === 'connected',
  };
}

function _toText(value) {
  if (value === null || value === undefined) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function _toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value === null || value === undefined ? '' : String(value), 'utf8');
}

/**
 * Map a channel result onto the local reasons.
 * @returns {{ ok: boolean, code: number|null, stdout: string, stderr: string, stdoutBuffer: Buffer, reason: string|null, error: string|null }}
 */
function _mapRemoteResult(res) {
  const stdoutBuffer = _toBuffer(res && res.stdout);
  const stdout = stdoutBuffer.toString('utf8');
  const stderr = _toText(res && res.stderr);
  const code = res && typeof res.code === 'number' ? res.code : null;
  if (res && res.ok) return { ok: true, code: 0, stdout, stderr, stdoutBuffer, reason: null, error: null };
  const transport = res && res.reason;
  let reason;
  let error = null;
  if (transport === 'disconnected') reason = 'disconnected';
  else if (transport === 'timeout') reason = 'timeout';
  else if (transport === 'cancelled') { reason = 'cancelled'; error = 'Operation cancelled'; }
  else if (transport === 'maxbuffer') { reason = 'exit'; error = 'Git output exceeded the buffer limit'; }
  else if (transport === 'invalid') { reason = 'badargs'; error = (res && res.error) || null; }
  else if (transport) reason = 'exit';
  else if (code === remoteShell.NODIR_EXIT) reason = 'nodir';
  else if (code === 127) reason = 'enoent';
  else reason = 'exit';
  if (error === null) {
    const text = stderr.trim();
    if (text && reason !== 'nodir') error = text;
    else if (reason === 'exit' && code !== null) error = `git exited with code ${code}`;
    else error = GIT_FAILURE_MESSAGES[reason] || 'Git command failed';
  }
  return { ok: false, code, stdout, stderr, stdoutBuffer, reason, error };
}

function _remoteFailure(reason, error) {
  return { ok: false, code: null, stdout: '', stderr: '', stdoutBuffer: Buffer.alloc(0), reason, error: error || GIT_FAILURE_MESSAGES[reason] || 'Git command failed' };
}

/** One request, no cache: resolve, build, run, map. Never rejects. */
async function _remoteRunUncached(uri, build, { readOnly, timeout, maxBuffer, signal }) {
  if (signal && signal.aborted) return _remoteFailure('cancelled', 'Operation cancelled');
  const executor = _remoteExecutor();
  let target;
  try {
    target = await executor.resolve(uri);
  } catch (e) {
    // Unknown profile, a path outside every registered project, an unreadable
    // projects.json: fail closed, the way a local path that does not exist does.
    return _remoteFailure('nodir', e && e.message);
  }
  if (!target || target.kind !== 'remote') return _remoteFailure('nodir');
  let script;
  try {
    script = build(target.remotePath, target);
  } catch (e) {
    return _remoteFailure('badargs', e && e.message);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  _remoteControllers.add(controller);
  // A cancel must answer now, whether or not the transport notices the signal.
  const cancelled = new Promise((resolve) => {
    controller.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }), { once: true });
  });
  let res;
  try {
    res = await Promise.race([
      Promise.resolve().then(() => executor.exec(target, script, { write: !readOnly, timeoutMs: timeout, maxBuffer, signal: controller.signal })),
      cancelled,
    ]);
  } catch (e) {
    res = { ok: false, reason: 'disconnected', error: e && e.message };
  } finally {
    _remoteControllers.delete(controller);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  if (controller.signal.aborted && !(res && res.ok)) res = { ok: false, reason: 'cancelled' };
  return _mapRemoteResult(res);
}

/** A write is about to run (or just ran) on this host: nothing cached for it is current any more. */
function _invalidateRemoteHost(profileId) {
  if (!profileId) return;
  _remoteGenerations.set(profileId, (_remoteGenerations.get(profileId) || 0) + 1);
  const prefix = `${profileId}\u0000`;
  for (const key of [..._remoteReadCache.keys()]) {
    if (key.startsWith(prefix)) _remoteReadCache.delete(key);
  }
}

function _copyResult(result) {
  return { ...result };
}

/**
 * Run a script for a remote project path, with the read cache.
 * @param {string} uri
 * @param {object} spec
 * @param {Array}  [spec.cacheKey]  identity of a cacheable read; omit to never cache
 * @param {boolean} spec.readOnly
 * @param {(dir: string, target: object) => string} spec.build
 * @param {number} spec.timeout
 * @param {number} [spec.maxBuffer]
 * @param {AbortSignal} [spec.signal]
 */
function _remoteRun(uri, { cacheKey, readOnly, build, timeout, maxBuffer = 1024 * 1024, signal }) {
  const parsed = remotePath.tryParse(uri);
  const profileId = parsed ? parsed.profileId : null;
  const options = { readOnly, timeout, maxBuffer, signal };
  if (!readOnly) {
    _invalidateRemoteHost(profileId);
    return _remoteRunUncached(uri, build, options).then((result) => {
      _invalidateRemoteHost(profileId);
      return result;
    });
  }
  // A caller with its own signal may cancel; sharing its request would cancel
  // everyone else's too.
  if (!parsed || !cacheKey || signal) return _remoteRunUncached(uri, build, options);

  const key = `${profileId}\u0000${parsed.path}\u0000${JSON.stringify(cacheKey)}`;
  const hit = _remoteReadCache.get(key);
  if (hit) {
    if (hit.pending) return hit.pending.then(_copyResult);
    if (_remoteNow() - hit.at < REMOTE_READ_TTL_MS) return Promise.resolve(_copyResult(hit.result));
    _remoteReadCache.delete(key);
  }
  if (_remoteReadCache.size >= REMOTE_CACHE_MAX) _remoteReadCache.clear();
  const generation = _remoteGenerations.get(profileId) || 0;
  const entry = {};
  entry.pending = _remoteRunUncached(uri, build, options).then((result) => {
    if (_remoteReadCache.get(key) === entry) {
      // Only an answer from the repository is worth keeping ("not a repo" is
      // one); a timeout or a dropped connection must be retried, and a write
      // that started meanwhile makes the answer stale.
      const answered = result.ok || result.reason === 'exit';
      if (answered && (_remoteGenerations.get(profileId) || 0) === generation) {
        _remoteReadCache.set(key, { at: _remoteNow(), result });
      } else {
        _remoteReadCache.delete(key);
      }
    }
    return result;
  });
  _remoteReadCache.set(key, entry);
  return entry.pending.then(_copyResult);
}

/** git on the host of a remote project path. */
function _remoteGit(uri, argsArray, { timeout, maxBuffer, signal } = {}) {
  return _remoteRun(uri, {
    cacheKey: argsArray,
    readOnly: isReadOnlyGitCommand(argsArray),
    build: (dir) => remoteShell.gitScript(dir, argsArray),
    timeout,
    maxBuffer,
    signal,
  });
}

/**
 * `execFile('git', ...)` with the callback contract, routed like the two
 * primitives. For a local path this is exactly
 * `execFile('git', [...prefix, ...args], { cwd, ...options }, callback)`, the
 * call the worktree commands, countLinesOfCode and ParallelTaskService used to
 * make directly; for a remote path it is the same git command on the host,
 * with an Error carrying `code` (the exit status, or the reason) and `reason`.
 *
 * @param {string} cwd
 * @param {string[]|(() => string[])} localPrefix  argv before the git command, local only (safe.directory)
 * @param {string[]} args
 * @param {object} options     execFile options, minus cwd
 * @param {Function} callback  (error, stdout, stderr)
 */
function execGitCallback(cwd, localPrefix, args, options, callback) {
  if (remotePath.isRemotePath(cwd)) {
    _remoteGit(cwd, args, { timeout: options.timeout || 120000, maxBuffer: options.maxBuffer || 1024 * 1024 }).then((r) => {
      if (r.ok) { callback(null, r.stdout, r.stderr); return; }
      const error = new Error(r.error || 'Git command failed');
      error.code = r.code !== null ? r.code : r.reason;
      error.reason = r.reason;
      callback(error, r.stdout, r.stderr);
    });
    return null;
  }
  const prefix = typeof localPrefix === 'function' ? localPrefix() : localPrefix;
  return execFile('git', [...prefix, ...args], { cwd, ...options }, callback);
}

// ── Remote project scans: stats, TODOs, untracked heads ─────────────────────

/** Extensions countLinesOfCode counts, local and remote alike. */
const LOC_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.vue', '.py', '.lua', '.css', '.scss', '.html', '.json', '.md', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.php', '.rb', '.swift', '.kt'];
const LOC_IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', 'vendor'];

const STATS_MARK_ENTRIES = '@@CT-STATS-ENTRIES@@';
const STATS_MARK_PACKAGE = '@@CT-STATS-PACKAGE@@';
const STATS_MARK_LINES = '@@CT-STATS-LINES@@';
const REMOTE_STATS_TTL_MS = 60000;
const REMOTE_STATS_MAX_FILES = 20000;
const _remoteStatsCache = new Map(); // uri -> { at, result }

/** The one-line script behind remote project stats (exported for the real-sh test). */
function remoteStatsScript(dir) {
  const { q, requireDir, NODIR_EXIT } = remoteShell;
  const extPattern = `\\.(${LOC_EXTENSIONS.map((e) => e.slice(1)).join('|')})$`;
  const prune = LOC_IGNORED_DIRS.map((d) => `! -path ${q(`*/${d}/*`)}`).join(' ');
  return remoteShell.script(
    requireDir(dir),
    `cd -- ${q(dir)} || exit ${NODIR_EXIT}`,
    `printf '%s\\n' ${q(STATS_MARK_ENTRIES)}`,
    'ls -A 2>/dev/null | head -n 2000',
    `printf '%s\\n' ${q(STATS_MARK_PACKAGE)}`,
    'if [ -f package.json ]; then head -c 262144 package.json; fi',
    `printf '\\n%s\\n' ${q(STATS_MARK_LINES)}`,
    `{ if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -c core.quotePath=false ls-files; else find . -type f ${prune}; fi; } 2>/dev/null | grep -i -E ${q(extPattern)} | head -n ${REMOTE_STATS_MAX_FILES} | tr '\\n' '\\000' | xargs -0 wc -l 2>/dev/null`,
    'exit 0',
  );
}

/** Parse the output of remoteStatsScript() into countLinesOfCode's shape plus the type-detection extras. */
function parseRemoteStats(stdout) {
  const text = String(stdout || '');
  const entriesAt = text.indexOf(`${STATS_MARK_ENTRIES}\n`);
  const packageAt = text.indexOf(`\n${STATS_MARK_PACKAGE}\n`);
  const linesAt = text.lastIndexOf(`\n${STATS_MARK_LINES}\n`);
  const result = { total: 0, files: 0, byExtension: {}, rootEntries: [], packageDeps: [] };
  if (entriesAt < 0 || packageAt < entriesAt || linesAt < packageAt) return result;

  result.rootEntries = text.slice(entriesAt + STATS_MARK_ENTRIES.length + 1, packageAt).split('\n').filter(Boolean);

  const pkgText = text.slice(packageAt + STATS_MARK_PACKAGE.length + 2, linesAt);
  if (pkgText.trim()) {
    try {
      const pkg = JSON.parse(pkgText);
      result.packageDeps = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
    } catch (_) { /* unreadable package.json: no dependency markers */ }
  }

  for (const line of text.slice(linesAt + STATS_MARK_LINES.length + 2).split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const name = match[2].replace(/^\.\//, '');
    // `wc` prints a "total" per batch xargs runs; no counted file can be called
    // that, since every one of them carries an extension.
    if (name === 'total') continue;
    const ext = path.posix.extname(name).toLowerCase();
    if (!LOC_EXTENSIONS.includes(ext)) continue;
    // The local count is content.split('\n').length, one more than wc's
    // newline count; keep the two kinds of project comparable.
    const lines = parseInt(match[1], 10) + 1;
    result.total += lines;
    result.files++;
    if (!result.byExtension[ext]) result.byExtension[ext] = { files: 0, lines: 0 };
    result.byExtension[ext].files++;
    result.byExtension[ext].lines += lines;
  }
  return result;
}

/** Remote lines of code, root listing and package.json deps, in one request, cached for a minute. */
async function _remoteProjectStats(uri) {
  const cached = _remoteStatsCache.get(uri);
  if (cached && _remoteNow() - cached.at < REMOTE_STATS_TTL_MS) return { ...cached.result };
  const r = await _remoteRun(uri, { readOnly: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024, build: remoteStatsScript });
  if (!r.ok) return { total: 0, files: 0, byExtension: {}, rootEntries: [], packageDeps: [], reason: r.reason };
  const result = parseRemoteStats(r.stdout);
  if (_remoteStatsCache.size >= 100) _remoteStatsCache.clear();
  _remoteStatsCache.set(uri, { at: _remoteNow(), result });
  return { ...result };
}

const TODO_MAX_LINES = 400;

/**
 * Candidate TODO lines of a remote project: `git grep` (tracked and untracked,
 * .gitignore honoured), or `grep -rnI` outside a repository. The caller
 * classifies them with its own regexes, exactly as for a local scan.
 *
 * @param {string} uri
 * @param {object} options
 * @param {string[]} options.extensions  e.g. ['.js', '.py']
 * @param {string[]} options.ignoreDirs
 * @param {number}   [options.maxDepth]  directories below the root, as the local scan
 * @returns {Promise<{ ok: boolean, reason: string|null, error?: string, lines: Array<{ file: string, line: number, text: string }> }>}
 */
async function grepTodoCandidates(uri, { extensions, ignoreDirs, maxDepth = 5 } = {}) {
  const { q, requireDir, NODIR_EXIT } = remoteShell;
  const exts = (extensions || []).filter((e) => /^\.[A-Za-z0-9]+$/.test(e));
  const dirs = (ignoreDirs || []).filter((d) => /^[A-Za-z0-9_.-]+$/.test(d));
  const pattern = '(TODO|FIXME|HACK|XXX)';
  const build = (dir) => {
    const gitSpecs = [...exts.map((e) => q(`*${e}`)), ...dirs.map((d) => q(`:(exclude,glob)**/${d}/**`))].join(' ');
    const grepSpecs = [...exts.map((e) => `--include=${q(`*${e}`)}`), ...dirs.map((d) => `--exclude-dir=${q(d)}`)].join(' ');
    return remoteShell.script(
      requireDir(dir),
      `cd -- ${q(dir)} || exit ${NODIR_EXIT}`,
      `{ if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git -c core.quotePath=false grep -n -I -i --untracked -E -e ${q(pattern)} -- ${gitSpecs}; else grep -rnI -i -E -e ${q(pattern)} ${grepSpecs} .; fi; } 2>/dev/null | cut -c 1-2000 | head -n ${TODO_MAX_LINES}`,
      'exit 0',
    );
  };
  const r = await _remoteRun(uri, { cacheKey: ['@todos', ...exts, '|', ...dirs], readOnly: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, build });
  if (!r.ok) return { ok: false, reason: r.reason, error: r.error, lines: [] };
  const lines = [];
  for (const raw of r.stdout.split('\n')) {
    const match = raw.match(/^(.+?):(\d+):(.*)$/);
    if (!match) continue;
    const file = match[1].replace(/^\.\//, '');
    if (file.split('/').length - 1 > maxDepth) continue;
    lines.push({ file, line: parseInt(match[2], 10), text: match[3] });
  }
  return { ok: true, reason: null, lines };
}

const HEAD_MAX_PATHS = 200;

/** A relative path a remote head read may name: inside the work tree, nothing the quoting refuses. */
function _isSafeRelativePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || remotePath.hasControlChars(p)) return false;
  return !p.split('/').some((segment) => segment === '..');
}

/**
 * First bytes of untracked files in a remote work tree, in one request, for
 * commit-message generation. Mirrors the local stat + readFile: a directory,
 * a file over `sizeLimit`, or the first `maxBytes` bytes of a file.
 *
 * @param {string} uri
 * @param {string[]} relPaths  paths relative to the work tree
 * @param {object} [options]
 * @returns {Promise<Map<string, { kind: 'dir'|'file'|'large'|'missing', size?: number, content?: string }>>}
 */
async function readUntrackedHeads(uri, relPaths, { maxBytes = 3000, sizeLimit = 500000, signal } = {}) {
  const out = new Map();
  const wanted = (relPaths || []).filter(_isSafeRelativePath).slice(0, HEAD_MAX_PATHS);
  for (const p of relPaths || []) out.set(p, { kind: 'missing' });
  if (wanted.length === 0) return out;
  const { q, requireDir, NODIR_EXIT } = remoteShell;
  const build = (dir) => remoteShell.script(
    requireDir(dir),
    `cd -- ${q(dir)} || exit ${NODIR_EXIT}`,
    'i=0',
    `for f in ${wanted.map((p) => q(p)).join(' ')}; do if [ -d "./$f" ]; then printf 'D %s\\n' "$i"; elif [ -f "./$f" ]; then s=$(wc -c < "./$f" 2>/dev/null | tr -d ' '); [ -n "$s" ] || s=0; if [ "$s" -gt ${Number(sizeLimit)} ]; then printf 'L %s %s\\n' "$i" "$s"; else n=$s; [ "$n" -gt ${Number(maxBytes)} ] && n=${Number(maxBytes)}; printf 'F %s %s %s\\n' "$i" "$s" "$n"; head -c "$n" "./$f" 2>/dev/null; printf '\\n'; fi; else printf 'M %s\\n' "$i"; fi; i=$((i+1)); done`,
  );
  const r = await _remoteRun(uri, { readOnly: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, signal, build });
  if (!r.ok) return out;
  const buf = r.stdoutBuffer;
  let pos = 0;
  while (pos < buf.length) {
    const eol = buf.indexOf(0x0a, pos);
    if (eol < 0) break;
    const header = buf.slice(pos, eol).toString('utf8').split(' ');
    pos = eol + 1;
    const index = parseInt(header[1], 10);
    const name = wanted[index];
    if (name === undefined) break;
    if (header[0] === 'D') out.set(name, { kind: 'dir' });
    else if (header[0] === 'L') out.set(name, { kind: 'large', size: parseInt(header[2], 10) || 0 });
    else if (header[0] === 'M') out.set(name, { kind: 'missing' });
    else if (header[0] === 'F') {
      const size = parseInt(header[2], 10) || 0;
      const n = parseInt(header[3], 10) || 0;
      // A file that changed size between the two reads would misalign every
      // following record: stop there, the rest stay "missing".
      if (buf[pos + n] !== 0x0a) break;
      out.set(name, { kind: 'file', size, content: buf.slice(pos, pos + n).toString('utf8') });
      pos += n + 1;
    } else {
      break;
    }
  }
  return out;
}

/**
 * Ask git for the worktrees of the remote projects of a profile, so the path
 * resolver learns their roots (it calls this once when a remote path is in no
 * registered project). Bounded: a few projects, and only while connected.
 * @param {string} profileId
 * @param {string[]} projectUris
 */
async function discoverRemoteWorktrees(profileId, projectUris) {
  // Only on an open connection: resolving a path must never be what makes the
  // app connect to a host, nor wait on one that is down.
  const executor = _remoteExecutor();
  if (typeof executor.isConnected === 'function' && !executor.isConnected(profileId)) return;
  const uris = (projectUris || []).filter((u) => {
    const parsed = remotePath.tryParse(u);
    return parsed && parsed.profileId === profileId;
  }).slice(0, 5);
  await Promise.all(uris.map((uri) => getWorktrees(uri).catch(() => [])));
}

/** Cancel every in-flight remote git request. */
function _cancelRemoteRequests() {
  if (_remoteControllers.size === 0) return 0;
  const count = _remoteControllers.size;
  for (const controller of [..._remoteControllers]) {
    try { controller.abort(); } catch (_) { /* already settled */ }
  }
  _remoteControllers.clear();
  return count;
}

/**
 * Execute a git command and report *why* it failed.
 * This is the primitive; execGit() is the string|null wrapper over it.
 * @param {string} cwd - Working directory
 * @param {string|string[]} args - Git command arguments as array (preferred) or space-separated string (simple commands only)
 * @param {number} timeout - Timeout in ms (default: 10000)
 * @returns {Promise<{ok: boolean, output: string, reason: 'enoent'|'timeout'|'exit'|'nodir'|null, error: string|null}>}
 */
function execGitResult(cwd, args, timeout = 10000, signal) {
  if (signal?.aborted) return Promise.resolve({ ok: false, output: '', reason: 'cancelled', error: 'Operation cancelled' });
  // The string form splits naively on spaces. Quotes are NOT honoured: they stay
  // inside the argv entry, and any value containing a space becomes several
  // arguments. It is kept only for fixed commands with no interpolation
  // ('status --porcelain'); pass an array for anything else.
  //
  // A quote in the string form is always a bug, and used to be a silent one -
  // `blame --porcelain "${filePath}"` sent git a path that literally began with
  // a quote, so blame, file history and per-file commit diffs returned nothing
  // for every file, and tag creation failed outright on Windows because `"` is
  // not a legal filename character there. Refuse it loudly instead.
  if (typeof args === 'string' && /["']/.test(args)) {
    const error = `git args contain a quote in the string form, which is not honoured: ${args}. Pass an array.`;
    console.error('[git]', error);
    return Promise.resolve({ ok: false, output: '', reason: 'badargs', error });
  }
  const argsArray = Array.isArray(args) ? args : args.split(' ');

  // Remote (SSH) project: same contract, run on the host. Decided before the
  // existsSync bail-out, which a URI would always fail.
  if (remotePath.isRemotePath(cwd)) {
    return _remoteGit(cwd, argsArray, { timeout, maxBuffer: 1024 * 1024, signal }).then((r) => {
      if (r.ok) return { ok: true, output: r.stdout.trimEnd(), reason: null, error: null };
      _logGitFailure(cwd, argsArray, r.reason, r.error);
      return { ok: false, output: '', reason: r.reason, error: r.error };
    });
  }

  return new Promise((resolve) => {
    // Early bail if directory doesn't exist (e.g. projects synced from another machine)
    if (!fs.existsSync(cwd)) {
      resolve({ ok: false, output: '', reason: 'nodir', error: GIT_FAILURE_MESSAGES.nodir });
      return;
    }

    let settled = false;
    const fail = (reason, error) => {
      if (settled) return;
      settled = true;
      _logGitFailure(cwd, argsArray, reason, error);
      resolve({ ok: false, output: '', reason, error: error || describeGitFailure({ reason }) });
    };

    const fullArgs = [...safeDirArgs(cwd), ...HARDENING_ARGS, ...argsArray];
    const child = execFile('git', fullArgs, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      _activeProcesses.delete(child);
      if (error) {
        // error.code is the exit status for a normal failure, or an errno
        // string ('ENOENT') when the binary could not be spawned at all.
        fail(error.code === 'ENOENT' ? 'enoent' : 'exit', (stderr || error.message || '').trim());
        return;
      }
      if (settled) return;
      settled = true;
      resolve({ ok: true, output: stdout.trimEnd(), reason: null, error: null });
    });

    _activeProcesses.add(child);

    // Manual timeout with explicit kill (exec timeout doesn't kill the process)
    const timer = setTimeout(() => {
      _activeProcesses.delete(child);
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000);
      fail('timeout', `${GIT_FAILURE_MESSAGES.timeout} after ${timeout}ms`);
    }, timeout);

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      _activeProcesses.delete(child);
      fail(err && err.code === 'ENOENT' ? 'enoent' : 'exit', err && err.message);
    });
  });
}

/**
 * Execute a git command in a specific directory using execFile (no shell injection)
 * Thin wrapper over execGitResult() - use that one when you need the failure reason.
 * @param {string} cwd - Working directory
 * @param {string|string[]} args - Git command arguments as array (preferred) or space-separated string (simple commands only)
 * @param {number} timeout - Timeout in ms (default: 10000)
 * @returns {Promise<string|null>} - Command output or null on error
 */
function execGit(cwd, args, timeout = 10000, signal) {
  return execGitResult(cwd, args, timeout, signal).then(result => (result.ok ? result.output : null));
}

/**
 * Execute a git command returning { success, output, error } using execFile (no shell injection)
 * @param {string} cwd - Working directory
 * @param {string[]} args - Git command arguments as array
 * @param {Object} opts - Options (maxBuffer, timeout)
 * @returns {Promise<{success: boolean, output?: string, error?: string, reason?: 'enoent'|'timeout'|'exit'|'nodir'}>}
 */
function spawnGit(cwd, args, opts = {}) {
  const { maxBuffer = 1024 * 1024, timeout = 15000 } = opts;
  if (remotePath.isRemotePath(cwd)) {
    return _remoteGit(cwd, args, { timeout, maxBuffer }).then((r) => {
      if (r.ok) return { success: true, output: r.stdout || r.stderr || '' };
      _logGitFailure(cwd, args, r.reason, r.error);
      return { success: false, error: r.error || describeGitFailure({ reason: r.reason }), reason: r.reason };
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    // `reason` is additive - existing callers only read success/output/error.
    const fail = (reason, error) => {
      if (settled) return;
      settled = true;
      _logGitFailure(cwd, args, reason, error);
      resolve({ success: false, error: error || describeGitFailure({ reason }), reason });
    };

    // Early bail if directory doesn't exist (e.g. projects synced from another machine)
    if (!fs.existsSync(cwd)) { fail('nodir', GIT_FAILURE_MESSAGES.nodir); return; }
    const fullArgs = [...safeDirArgs(cwd), ...HARDENING_ARGS, ...args];
    const child = execFile('git', fullArgs, { cwd, encoding: 'utf8', maxBuffer, timeout }, (error, stdout, stderr) => {
      if (timer) clearTimeout(timer);
      _activeProcesses.delete(child);
      if (error) {
        fail(error.code === 'ENOENT' ? 'enoent' : 'exit', stderr || error.message);
      } else if (!settled) {
        settled = true;
        resolve({ success: true, output: stdout || stderr || '' });
      }
    });

    _activeProcesses.add(child);

    const timer = setTimeout(() => {
      _activeProcesses.delete(child);
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 1000);
      fail('timeout', GIT_FAILURE_MESSAGES.timeout);
    }, timeout);

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      _activeProcesses.delete(child);
      fail(err && err.code === 'ENOENT' ? 'enoent' : 'exit', err && err.message);
    });
  });
}

/**
 * Parse git status porcelain output into categorized files
 * @param {string} status - Git status --porcelain output
 * @returns {Object} - Categorized files
 */
function parseGitStatus(status) {
  const files = {
    staged: [],
    unstaged: [],
    untracked: [],
    all: []
  };

  if (!status) return files;

  status.split('\n').forEach(line => {
    if (!line.trim()) return;

    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const filePath = line.slice(3);

    let type = 'modified';
    let category = 'unstaged';

    // Staged changes (index)
    if (indexStatus !== ' ' && indexStatus !== '?') {
      if (indexStatus === 'A') type = 'added';
      else if (indexStatus === 'D') type = 'deleted';
      else if (indexStatus === 'R') type = 'renamed';
      else if (indexStatus === 'M') type = 'modified';
      files.staged.push({ type, file: filePath });
    }

    // Unstaged changes (work tree)
    if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
      if (workTreeStatus === 'D') type = 'deleted';
      else type = 'modified';
      files.unstaged.push({ type, file: filePath });
    }

    // Untracked files
    if (indexStatus === '?' && workTreeStatus === '?') {
      files.untracked.push({ type: 'untracked', file: filePath });
    }

    // All files for backwards compatibility
    files.all.push({ type, file: filePath });
  });

  return files;
}

/**
 * Get ahead/behind status relative to remote
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Current branch name
 * @param {boolean} skipFetch - Skip fetching from remote (faster, uses local data)
 * @returns {Promise<Object>} - { ahead, behind, remote }
 */
async function getAheadBehind(projectPath, branch, skipFetch = false) {
  // Try to fetch with a short timeout (3s) - don't block if network is slow/offline
  if (!skipFetch) {
    await execGit(projectPath, 'fetch --quiet', 3000).catch(() => {});
  }

  // Get the upstream tracking branch
  const upstream = await execGit(projectPath, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
  if (!upstream) {
    // No upstream set, check if remote origin exists
    const remoteUrl = await execGit(projectPath, 'remote get-url origin');
    if (remoteUrl) {
      // Remote exists but branch is not tracking - still has remote
      return { ahead: 0, behind: 0, remote: null, hasRemote: true, notTracking: true };
    }
    return { ahead: 0, behind: 0, remote: null, hasRemote: false };
  }

  // Get ahead/behind counts
  const counts = await execGit(projectPath, ['rev-list', '--left-right', '--count', `${branch}...${upstream}`]);
  if (!counts) {
    return { ahead: 0, behind: 0, remote: upstream, hasRemote: true };
  }

  const [ahead, behind] = counts.split('\t').map(n => parseInt(n, 10) || 0);
  return { ahead, behind, remote: upstream, hasRemote: true };
}

/**
 * Get list of all branches (local and remote)
 * @param {string} projectPath - Path to the project
 * @param {Object} options
 * @param {boolean} options.skipFetch - Skip fetching from remote (default: true)
 * @returns {Promise<Object>} - Object with local and remote branch arrays
 */
async function getBranches(projectPath, options = {}) {
  const { skipFetch = true } = options;

  // Get local branches
  const localOutput = await execGit(projectPath, 'branch --format=%(refname:short)');
  const local = localOutput ? localOutput.split('\n').filter(b => b.trim()) : [];

  // Only fetch if explicitly requested (avoids network blocking on dashboard load)
  if (!skipFetch) {
    await execGit(projectPath, 'fetch --all --prune', 5000).catch(() => {});
  }
  const remoteOutput = await execGit(projectPath, 'branch -r --format=%(refname:short)');
  const remote = remoteOutput
    ? remoteOutput.split('\n')
        .filter(b => b.trim())
        .filter(b => !b.includes('HEAD')) // Exclude HEAD pointer
        .map(b => b.replace(/^origin\//, '')) // Remove origin/ prefix for display
        .filter(b => !local.includes(b)) // Exclude branches already in local
    : [];

  return { local, remote };
}

/**
 * Get current branch name
 * @param {string} projectPath - Path to the project
 * @returns {Promise<string|null>} - Current branch name or null
 */
async function getCurrentBranch(projectPath) {
  const branch = await execGit(projectPath, 'rev-parse --abbrev-ref HEAD');
  return branch || null;
}

/**
 * Checkout a branch
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch name to checkout
 * @returns {Promise<Object>} - Result object with success/error
 */
async function checkoutBranch(projectPath, branch) {
  const result = await spawnGit(projectPath, ['checkout', branch]);
  if (!result.success) return result;
  return { success: true, output: result.output || `Switched to branch '${branch}'` };
}

/**
 * Get list of stashes
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - List of stash entries
 */
async function getStashes(projectPath) {
  const output = await execGit(projectPath, 'stash list --format=%gd|%s|%ar');
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).map(line => {
    const [ref, message, date] = line.split('|');
    return { ref, message, date };
  });
}

/**
 * Get latest tag
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object|null>} - Tag info or null
 */
async function getLatestTag(projectPath) {
  const tag = await execGit(projectPath, 'describe --tags --abbrev=0');
  if (!tag) return null;

  const tagDate = await execGit(projectPath, ['log', '-1', '--format=%ar', tag]);
  const commitsBehind = await execGit(projectPath, ['rev-list', `${tag}..HEAD`, '--count']);

  return {
    name: tag,
    date: tagDate,
    commitsBehind: parseInt(commitsBehind, 10) || 0
  };
}

/**
 * Get recent commits
 * @param {string} projectPath - Path to the project
 * @param {number} count - Number of commits to get
 * @returns {Promise<Array>} - List of commits
 */
async function getRecentCommits(projectPath, count = 5) {
  const output = await execGit(projectPath, ['log', `-${count}`, '--format=%h|%s|%an|%ar']);
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).map(line => {
    const [hash, message, author, date] = line.split('|');
    return { hash, message, author, date };
  });
}

/**
 * Get contributors stats
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - List of contributors
 */
async function getContributors(projectPath) {
  // Use a 5s timeout - shortlog can be slow on large repos
  const output = await execGit(projectPath, 'shortlog -sn --all --no-merges', 5000);
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).slice(0, 5).map(line => {
    const match = line.trim().match(/^\s*(\d+)\s+(.+)$/);
    if (!match) return null;
    return { commits: parseInt(match[1], 10), name: match[2] };
  }).filter(Boolean);
}

/**
 * Get total commit count
 * @param {string} projectPath - Path to the project
 * @returns {Promise<number>} - Total commits
 */
async function getTotalCommits(projectPath) {
  const count = await execGit(projectPath, 'rev-list --count HEAD');
  return parseInt(count, 10) || 0;
}

/**
 * Get git info for a project (branch, last commit, changed files)
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Git info object
 */
async function getGitInfo(projectPath) {
  const branchResult = await execGitResult(projectPath, 'rev-parse --abbrev-ref HEAD');
  if (!branchResult.ok || !branchResult.output) return notAGitRepo(branchResult);
  const branch = branchResult.output;

  const lastCommit = await execGit(projectPath, ['log', '-1', '--format=%H|%s|%an|%ar']);
  const status = await execGit(projectPath, 'status --porcelain');

  let commit = null;
  if (lastCommit) {
    const [hash, message, author, date] = lastCommit.split('|');
    commit = { hash: hash?.slice(0, 7), message, author, date };
  }

  const files = parseGitStatus(status);

  return { isGitRepo: true, branch, commit, files: files.all };
}

/**
 * Get comprehensive git info for dashboard
 * @param {string} projectPath - Path to the project
 * @param {Object} options - Options
 * @param {boolean} options.skipFetch - Skip fetching from remote (default: true for speed)
 * @returns {Promise<Object>} - Complete git info
 */
async function getGitInfoFull(projectPath, options = {}) {
  const { skipFetch = true } = options;

  const branchResult = await execGitResult(projectPath, 'rev-parse --abbrev-ref HEAD');
  if (!branchResult.ok || !branchResult.output) return notAGitRepo(branchResult);
  const branch = branchResult.output;

  // Batch 1: Fast local queries (index only, no network)
  const [
    lastCommitRaw,
    statusRaw,
    remoteUrl,
    totalCommits
  ] = (await Promise.allSettled([
    execGit(projectPath, ['log', '-1', '--format=%H|%s|%an|%ar']),
    execGit(projectPath, 'status --porcelain'),
    execGit(projectPath, 'remote get-url origin'),
    getTotalCommits(projectPath)
  ])).map(r => r.status === 'fulfilled' ? r.value : null);

  // Batch 2: Heavier queries (may involve refs traversal, but still local)
  const [
    aheadBehind,
    branches,
    recentCommits,
    stashes,
    latestTag,
    contributors
  ] = (await Promise.allSettled([
    getAheadBehind(projectPath, branch, skipFetch),
    getBranches(projectPath),
    getRecentCommits(projectPath, 5),
    getStashes(projectPath),
    getLatestTag(projectPath),
    getContributors(projectPath)
  ])).map(r => r.status === 'fulfilled' ? r.value : null);

  let commit = null;
  if (lastCommitRaw) {
    const [hash, message, author, date] = lastCommitRaw.split('|');
    commit = { hash: hash?.slice(0, 7), fullHash: hash, message, author, date };
  }

  const files = parseGitStatus(statusRaw);

  return {
    isGitRepo: true,
    branch,
    commit,
    files,
    aheadBehind,
    branches,
    stashes,
    latestTag,
    recentCommits,
    contributors,
    totalCommits,
    remoteUrl: remoteUrl || null
  };
}

/**
 * Quick git status check
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Status object
 */
async function getGitStatusQuick(projectPath) {
  const result = await spawnGit(projectPath, ['status', '--porcelain']);
  if (!result.success) return notAGitRepo(result);
  const stdout = result.output;
  return {
    isGitRepo: true,
    hasChanges: stdout.trim().length > 0,
    changesCount: stdout.trim().split('\n').filter(l => l).length
  };
}

/**
 * Execute git pull
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error/conflicts
 */
async function gitPull(projectPath) {
  const result = await spawnGit(projectPath, ['pull', '--rebase', '--stat']);
  if (!result.success) {
    const conflicts = await getMergeConflicts(projectPath);
    if (conflicts.length > 0) {
      return { success: false, hasConflicts: true, conflicts, error: 'Merge conflicts detected. Resolve conflicts or abort merge.' };
    }
    return result;
  }
  const output = result.output || 'Already up to date.';
  // Parse stat summary line: "3 files changed, 10 insertions(+), 2 deletions(-)"
  const stats = {};
  const statMatch = output.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/);
  if (statMatch) {
    stats.filesChanged = parseInt(statMatch[1]) || 0;
    stats.insertions = parseInt(statMatch[2]) || 0;
    stats.deletions = parseInt(statMatch[3]) || 0;
  }
  return { success: true, output, stats };
}

/**
 * Execute git push
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
async function gitPush(projectPath) {
  const result = await spawnGit(projectPath, ['push']);
  if (!result.success) {
    if (result.error && result.error.includes('Everything up-to-date')) {
      return { success: true, output: 'Everything up-to-date.' };
    }
    return result;
  }
  return { success: true, output: result.output || 'Push successful.' };
}

/**
 * Push a specific branch to origin
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch name to push
 * @returns {Promise<Object>} - Result object with success/error
 */
async function gitPushBranch(projectPath, branch) {
  const result = await spawnGit(projectPath, ['push', '-u', 'origin', branch]);
  if (!result.success) {
    if (result.error && result.error.includes('Everything up-to-date')) {
      return { success: true, output: 'Everything up-to-date.' };
    }
    return result;
  }
  return { success: true, output: result.output || 'Push successful.' };
}

/**
 * Execute git merge
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch to merge into current branch
 * @returns {Promise<Object>} - Result object with success/error/conflicts
 */
async function gitMerge(projectPath, branch) {
  const result = await spawnGit(projectPath, ['merge', branch]);
  if (!result.success) {
    const conflicts = await getMergeConflicts(projectPath);
    if (conflicts.length > 0) {
      return { success: false, hasConflicts: true, conflicts, error: 'Merge conflicts detected. Resolve conflicts or abort merge.' };
    }
    return result;
  }
  return { success: true, output: result.output || 'Merge successful.' };
}

/**
 * Abort current merge
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
async function gitMergeAbort(projectPath) {
  const result = await spawnGit(projectPath, ['merge', '--abort']);
  if (!result.success) return result;
  return { success: true, output: 'Merge aborted.' };
}

/**
 * Continue merge after resolving conflicts
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Result object with success/error
 */
async function gitMergeContinue(projectPath) {
  const result = await spawnGit(projectPath, ['merge', '--continue']);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Merge completed.' };
}

/**
 * Get list of files with merge conflicts
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - List of conflicted files
 */
async function getMergeConflicts(projectPath) {
  const output = await execGit(projectPath, 'diff --name-only --diff-filter=U');
  if (!output) return [];
  return output.split('\n').filter(f => f.trim());
}

/**
 * Check if there's a merge in progress
 * @param {string} projectPath - Path to the project
 * @returns {Promise<boolean>} - True if merge in progress
 */
async function isMergeInProgress(projectPath) {
  // Remote: ask git itself rather than stat a local path. MERGE_HEAD only
  // exists during a merge, and rev-parse resolves it in worktrees as well.
  if (remotePath.isRemotePath(projectPath)) {
    const result = await execGitResult(projectPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
    return result.ok && result.output.length > 0;
  }
  // Use git rev-parse to find the correct git dir (works for both regular repos and worktrees)
  const gitDir = await execGit(projectPath, 'rev-parse --git-dir');
  if (!gitDir) return false;
  const resolvedGitDir = path.resolve(projectPath, gitDir);
  const mergeHead = path.join(resolvedGitDir, 'MERGE_HEAD');
  return fs.existsSync(mergeHead);
}

/**
 * Clone a git repository
 * @param {string} repoUrl - URL of the repository to clone
 * @param {string} targetPath - Path where to clone the repo
 * @param {Object} options - Optional settings
 * @param {string} options.token - GitHub token for private repos
 * @param {Function} options.onProgress - Callback for progress updates
 * @returns {Promise<Object>} - Result object with success/error
 */
function gitClone(repoUrl, targetPath, options = {}) {
  return require('./projectCreation').clone(repoUrl, targetPath, options)
    .catch(error => ({ success: false, cancelled: !!options.signal?.aborted, error: options.signal?.aborted ? 'Operation cancelled' : error.message }));
}

/**
 * Count lines of code in a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Lines count by type
 */
async function countLinesOfCode(projectPath) {
  const extensions = LOC_EXTENSIONS;

  // Remote: one request on the host, never one per file.
  if (remotePath.isRemotePath(projectPath)) return _remoteProjectStats(projectPath);

  // Try git ls-files first (fast, reads from index)
  const gitResult = await new Promise((resolve) => {
    execGitCallback(projectPath, () => safeDirArgs(projectPath), ['ls-files'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 50, timeout: 10000 }, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim().split('\n').filter(f => f.trim()));
    });
  });

  if (gitResult && gitResult.length > 0) {
    return countLinesFromFileList(projectPath, gitResult, extensions);
  }

  // Fallback: filesystem scan for non-git projects
  return countLinesFromFilesystem(projectPath, extensions);
}

async function countLinesFromFileList(projectPath, fileList, extensions) {
  const path = require('path');
  const fs = require('fs').promises;

  // Filter files by extension
  const sourceFiles = fileList.filter(f => {
    const ext = path.extname(f).toLowerCase();
    return extensions.includes(ext);
  });

  let totalLines = 0;
  let totalFiles = 0;
  const byExtension = {};

  // Process files in batches of 50 to avoid blocking
  const BATCH_SIZE = 50;
  for (let i = 0; i < sourceFiles.length; i += BATCH_SIZE) {
    const batch = sourceFiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (relPath) => {
      const fullPath = path.join(projectPath, relPath);
      const content = await fs.readFile(fullPath, 'utf8');
      return { relPath, lines: content.split('\n').length };
    }));

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { relPath, lines } = result.value;
      totalLines += lines;
      totalFiles++;

      const ext = path.extname(relPath).toLowerCase();
      if (!byExtension[ext]) byExtension[ext] = { files: 0, lines: 0 };
      byExtension[ext].files++;
      byExtension[ext].lines += lines;
    }
  }

  return { total: totalLines, files: totalFiles, byExtension };
}

async function countLinesFromFilesystem(projectPath, extensions) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';

    if (isWin) {
      // Build PowerShell script as a single -Command argument via execFile (no shell interpolation)
      const extList = extensions.map(e => `'${e}'`).join(', ');
      const psCommand = [
        `$extensions = @(${extList});`,
        `$files = Get-ChildItem -LiteralPath ${JSON.stringify(projectPath)} -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $extensions -contains $_.Extension -and $_.FullName -notmatch 'node_modules|vendor|dist|build|cache|stream|\\.git' };`,
        '$totalLines = 0; $totalFiles = 0; $byExt = @{};',
        'foreach ($file in $files) { try { $lines = (Get-Content $file.FullName -ErrorAction SilentlyContinue | Measure-Object -Line).Lines; $totalLines += $lines; $totalFiles++; $ext = $file.Extension; if (-not $byExt.ContainsKey($ext)) { $byExt[$ext] = @{files=0;lines=0} }; $byExt[$ext].files++; $byExt[$ext].lines += $lines; } catch {} }',
        '$result = @{total=$totalLines;files=$totalFiles;byExtension=@{}}; foreach ($key in $byExt.Keys) { $result.byExtension[$key] = $byExt[$key] }; $result | ConvertTo-Json -Compress',
      ].join(' ');

      execFile('powershell', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 30000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve({ total: 0, files: 0, byExtension: {} });
          return;
        }
        try {
          const result = JSON.parse(stdout.trim());
          resolve({
            total: result.total || 0,
            files: result.files || 0,
            byExtension: result.byExtension || {}
          });
        } catch (e) {
          resolve({ total: 0, files: 0, byExtension: {} });
        }
      });
    } else {
      // Use execFile with array args to avoid shell injection via projectPath
      const nameArgs = extensions.flatMap(ext => ['-name', `*${ext}`]);
      // Interleave -o between name patterns: -name "*.js" -o -name "*.ts" ...
      const namePattern = nameArgs.reduce((acc, arg, i) => {
        if (i > 0 && i % 2 === 0) acc.push('-o');
        acc.push(arg);
        return acc;
      }, []);

      const findArgs = [
        projectPath, '-type', 'f',
        '(', ...namePattern, ')',
        '-not', '-path', '*/node_modules/*',
        '-not', '-path', '*/.git/*',
        '-not', '-path', '*/dist/*',
        '-not', '-path', '*/build/*',
        '-not', '-path', '*/vendor/*',
      ];

      execFile('find', findArgs, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 15000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve({ total: 0, files: 0, byExtension: {} });
          return;
        }
        // Count lines by reading file list from find output
        const files = stdout.trim().split('\n').slice(0, 1000);
        if (!files.length) { resolve({ total: 0, files: 0, byExtension: {} }); return; }
        execFile('wc', ['-l', ...files], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 10, timeout: 15000 }, (err, wcOut) => {
          if (err || !wcOut.trim()) { resolve({ total: 0, files: 0, byExtension: {} }); return; }
          const lines = wcOut.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          const match = lastLine.match(/(\d+)/);
          resolve({
            total: match ? parseInt(match[1], 10) : 0,
            files: files.length,
            byExtension: {}
          });
        });
      });
    }
  });
}

/**
 * Get project statistics (file count, size, etc.)
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Project stats
 */
async function getProjectStats(projectPath) {
  const linesData = await countLinesOfCode(projectPath);

  if (remotePath.isRemotePath(projectPath)) {
    // Remote extras: the root listing and package.json dependencies feed the
    // dashboard's project-type badge, which cannot read the host's files.
    return {
      lines: linesData.total,
      files: linesData.files,
      byExtension: linesData.byExtension,
      remote: true,
      rootEntries: linesData.rootEntries || [],
      packageDeps: linesData.packageDeps || [],
      ...(linesData.reason ? { reason: linesData.reason } : {}),
    };
  }

  return {
    lines: linesData.total,
    files: linesData.files,
    byExtension: linesData.byExtension
  };
}

/**
 * Parse git diff --numstat output into a Map of filePath -> { additions, deletions }
 * @param {string|null} output - Raw numstat output
 * @returns {Map<string, {additions: number, deletions: number}>}
 */
function parseDiffNumstat(output) {
  const map = new Map();
  if (!output) return map;
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (match) {
      map.set(match[3], {
        additions: match[1] === '-' ? 0 : parseInt(match[1], 10) || 0,
        deletions: match[2] === '-' ? 0 : parseInt(match[2], 10) || 0
      });
    }
  }
  return map;
}

/**
 * Get detailed git status with file additions/deletions
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Object>} - Detailed status with files
 */
async function getGitStatusDetailed(projectPath) {
  try {
    // Get status + all diff stats in parallel (3 commands instead of N*2)
    const [statusResult, allDiffRaw, allStagedRaw] = await Promise.all([
      execGitResult(projectPath, 'status --porcelain'),
      execGit(projectPath, 'diff --numstat'),
      execGit(projectPath, 'diff --cached --numstat')
    ]);

    if (!statusResult.ok) {
      // "git could not run" and "this folder is not a repo" used to be the same
      // message here, which is what made a missing git look like a clean repo.
      if (isGitUnavailable(statusResult)) {
        return {
          success: false,
          error: describeGitFailure(statusResult),
          gitUnavailable: true,
          unavailableReason: statusResult.reason,
        };
      }
      if (statusResult.reason === 'disconnected') {
        return { success: false, error: describeGitFailure(statusResult), reason: 'disconnected' };
      }
      return { success: false, error: 'Not a git repository' };
    }
    const statusOutput = statusResult.output;

    const diffMap = parseDiffNumstat(allDiffRaw);
    const stagedMap = parseDiffNumstat(allStagedRaw);
    const files = [];

    if (statusOutput.trim()) {
      const lines = statusOutput.split('\n').filter(l => l.trim());

      for (const line of lines) {
        const indexStatus = line[0];
        const workTreeStatus = line[1];
        const filePath = line.slice(3);

        // Determine the status code to show
        let status = 'M';
        if (indexStatus === '?' || workTreeStatus === '?') status = '?';
        else if (indexStatus === 'A' || workTreeStatus === 'A') status = 'A';
        else if (indexStatus === 'D' || workTreeStatus === 'D') status = 'D';
        else if (indexStatus === 'R' || workTreeStatus === 'R') status = 'R';
        else if (indexStatus === 'M' || workTreeStatus === 'M') status = 'M';

        // Lookup diff stats from pre-fetched maps (O(1) per file)
        const diff = diffMap.get(filePath) || { additions: 0, deletions: 0 };
        const staged = stagedMap.get(filePath) || { additions: 0, deletions: 0 };
        const additions = diff.additions + staged.additions;
        const deletions = diff.deletions + staged.deletions;

        files.push({
          path: filePath,
          status,
          staged: indexStatus !== ' ' && indexStatus !== '?',
          additions,
          deletions
        });
      }
    }

    return { success: true, files };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Stage specific files
 * @param {string} projectPath - Path to the project
 * @param {string[]} files - List of file paths to stage
 * @returns {Promise<Object>} - Result object
 */
async function gitStageFiles(projectPath, files) {
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };
  const result = await spawnGit(projectPath, ['add', '--', ...files]);
  if (!result.success) return result;
  return { success: true, output: `Staged ${files.length} file(s)` };
}

/**
 * Create a commit
 * @param {string} projectPath - Path to the project
 * @param {string} message - Commit message
 * @returns {Promise<Object>} - Result object
 */
async function gitCommit(projectPath, message) {
  if (!message || !message.trim()) return { success: false, error: 'Commit message is required' };
  const result = await spawnGit(projectPath, ['commit', '-m', message]);
  if (!result.success) {
    if (result.error && result.error.includes('nothing to commit')) {
      return { success: false, error: 'Nothing to commit (no staged files)' };
    }
    return result;
  }
  return { success: true, output: result.output || 'Commit created' };
}

/**
 * Create a new branch and switch to it
 * @param {string} projectPath - Path to the project
 * @param {string} branchName - Name of the new branch
 * @returns {Promise<Object>} - Result object with success/error
 */
async function createBranch(projectPath, branchName) {
  const result = await spawnGit(projectPath, ['checkout', '-b', branchName]);
  if (!result.success) return result;
  return { success: true, output: result.output || `Switched to a new branch '${branchName}'` };
}

/**
 * Delete a local branch
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch name to delete
 * @param {boolean} force - Use -D instead of -d (force delete unmerged branch)
 * @returns {Promise<Object>} - Result object with success/error
 */
async function deleteBranch(projectPath, branch, force = false) {
  const flag = force ? '-D' : '-d';
  const result = await spawnGit(projectPath, ['branch', flag, branch]);
  if (!result.success) return result;
  return { success: true, output: result.output || `Deleted branch ${branch}` };
}

/**
 * Get paginated commit history
 * @param {string} projectPath - Path to the project
 * @param {Object} options - Options
 * @param {number} options.skip - Number of commits to skip
 * @param {number} options.limit - Number of commits to return
 * @param {string} options.branch - Branch to get history for (optional)
 * @param {boolean} options.allBranches - Show commits from all branches
 * @returns {Promise<Array>} - List of commits
 */
async function getCommitHistory(projectPath, { skip = 0, limit = 30, branch = '', allBranches = false } = {}) {
  const RS = '%x1e'; // Record Separator to avoid conflicts with commit messages
  const format = `%H${RS}%h${RS}%s${RS}%an${RS}%ae${RS}%ar${RS}%aI${RS}%P${RS}%D`;
  const output = await execGit(projectPath, [
    'log', `--skip=${skip}`, `-${limit}`, `--format=${format}`,
    ...(allBranches ? ['--all'] : []),
    ...(branch ? [branch] : []),
  ], 15000);
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.split('\x1e');
    const [fullHash, hash, message, author, email, date, isoDate, parentStr, decorations] = parts;
    const parents = parentStr ? parentStr.trim().split(' ').filter(Boolean) : [];
    return { fullHash, hash, message, author, email, date, isoDate, parents, decorations: decorations || '' };
  });
}

/**
 * Get diff for a specific file, distinguishing "no changes" from "diff failed".
 * An empty diff and a diff that could not be produced are the same string, so
 * callers that show it to the user need this variant to render an error state.
 * @param {string} projectPath - Path to the project
 * @param {string} filePath - File path
 * @param {boolean} staged - Whether to get staged diff
 * @returns {Promise<{ok: boolean, diff: string, reason: string|null, error: string|null}>}
 */
async function getFileDiffResult(projectPath, filePath, staged = false) {
  const args = ['diff'];
  if (staged) args.push('--cached');
  args.push('--', filePath);
  const result = await execGitResult(projectPath, args, 10000);
  if (!result.ok) return { ok: false, diff: '', reason: result.reason, error: describeGitFailure(result) };
  return { ok: true, diff: result.output || '', reason: null, error: null };
}

/**
 * Get diff for a specific file (empty string on failure)
 * Prefer getFileDiffResult() when the caller must tell "no changes" from "diff failed".
 * @param {string} projectPath - Path to the project
 * @param {string} filePath - Relative path of the file
 * @param {boolean} staged - Diff the index instead of the work tree
 * @returns {Promise<string>} - Diff output
 */
async function getFileDiff(projectPath, filePath, staged = false) {
  const result = await getFileDiffResult(projectPath, filePath, staged);
  return result.ok ? result.diff : '';
}

/**
 * Get commit detail (show --stat), distinguishing an empty result from a failure.
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Commit hash
 * @returns {Promise<{ok: boolean, detail: string, reason: string|null, error: string|null}>}
 */
async function getCommitDetailResult(projectPath, commitHash) {
  const result = await execGitResult(projectPath, ['show', '--stat', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %aI%n%n    %s%n%n    %b', commitHash], 10000);
  if (!result.ok) return { ok: false, detail: '', reason: result.reason, error: describeGitFailure(result) };
  return { ok: true, detail: result.output || '', reason: null, error: null };
}

/**
 * Get commit detail (show --stat)
 * Prefer getCommitDetailResult() when the caller must render a failure state.
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Commit hash
 * @returns {Promise<string>} - Commit detail output
 */
async function getCommitDetail(projectPath, commitHash) {
  const result = await getCommitDetailResult(projectPath, commitHash);
  return result.ok ? result.detail : '';
}

/**
 * Cherry-pick a commit
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Commit hash to cherry-pick
 * @returns {Promise<Object>} - Result object
 */
async function cherryPick(projectPath, commitHash) {
  const result = await spawnGit(projectPath, ['cherry-pick', commitHash]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Cherry-pick successful.' };
}

/**
 * Revert a commit
 * @param {string} projectPath - Path to the project
 * @param {string} commitHash - Commit hash to revert
 * @returns {Promise<Object>} - Result object
 */
async function revertCommit(projectPath, commitHash) {
  const result = await spawnGit(projectPath, ['revert', '--no-edit', commitHash]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Revert successful.' };
}

/**
 * Unstage specific files
 * @param {string} projectPath - Path to the project
 * @param {string[]} files - List of file paths to unstage
 * @returns {Promise<Object>} - Result object
 */
async function gitUnstageFiles(projectPath, files) {
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };
  const result = await spawnGit(projectPath, ['restore', '--staged', '--', ...files]);
  if (!result.success) return result;
  return { success: true, output: `Unstaged ${files.length} file(s)` };
}

/**
 * Apply a stash
 * @param {string} projectPath - Path to the project
 * @param {string} stashRef - Stash reference (e.g., stash@{0})
 * @returns {Promise<Object>} - Result object
 */
async function stashApply(projectPath, stashRef) {
  const result = await spawnGit(projectPath, ['stash', 'apply', stashRef]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Stash applied.' };
}

/**
 * Drop a stash
 * @param {string} projectPath - Path to the project
 * @param {string} stashRef - Stash reference (e.g., stash@{0})
 * @returns {Promise<Object>} - Result object
 */
async function stashDrop(projectPath, stashRef) {
  const result = await spawnGit(projectPath, ['stash', 'drop', stashRef]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Stash dropped.' };
}

/**
 * Save changes to a stash
 * @param {string} projectPath - Path to the project
 * @param {string} message - Optional stash message
 * @returns {Promise<Object>} - Result object
 */
async function gitStashSave(projectPath, message) {
  const args = (message && message.trim())
    ? ['stash', 'push', '-m', message.trim()]
    : ['stash'];
  const result = await spawnGit(projectPath, args);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Stash saved.' };
}

// ========== WORKTREES ==========

/**
 * `force` value for removeWorktree() that also overrides a worktree lock,
 * i.e. `git worktree remove -f -f`.
 */
const FORCE_UNLOCK = 2;

/**
 * Parse git worktree list --porcelain output
 * @param {string} output - Porcelain output from git worktree list
 * @returns {Array} - List of worktree objects
 */
function parseWorktreeListOutput(output) {
  if (!output) return [];

  const worktrees = [];
  let current = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.slice(9).trim() };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line.startsWith('locked')) {
      current.locked = true;
      const reason = line.slice(7).trim();
      if (reason) current.lockReason = reason;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    } else if (line === '' && current.path) {
      worktrees.push(current);
      current = {};
    }
  }
  if (current.path) worktrees.push(current);

  // Mark the first entry as the main worktree
  if (worktrees.length > 0) worktrees[0].isMain = true;

  return worktrees;
}

/**
 * The POSIX path a remote worktree argument names. It must be a URI on the
 * project's own host: a worktree of a repository cannot live on another
 * machine, and a bare path would be read as local by every other layer.
 * @param {string} projectPath - ssh-remote:// URI of the project
 * @param {string} worktreePath - ssh-remote:// URI of the worktree
 * @returns {string}
 */
function _remoteWorktreeArg(projectPath, worktreePath) {
  const project = remotePath.parse(projectPath);
  const tree = remotePath.tryParse(worktreePath);
  if (!tree || tree.profileId !== project.profileId) {
    throw new Error('Worktree path must be on the same remote host as the project');
  }
  if (tree.path === '/') throw new Error('Refusing to use the remote root as a worktree');
  return tree.path;
}

/**
 * Tell the remote path resolver that these directories are worktrees of one
 * repository, so a terminal, chat or git call opened in one of them resolves
 * like the project it belongs to (design/remote-ssh.md section 5.4). Main-side
 * only: the roots come from git's own answers, never from the renderer.
 */
function _noteRemoteWorktreeRoots(profileId, roots) {
  try {
    const target = require('./projectTarget');
    if (typeof target.noteWorktreeRoots === 'function') target.noteWorktreeRoots(profileId, roots);
  } catch (_) { /* resolution simply stays limited to registered projects */ }
}

/**
 * List all worktrees for a repository
 * @param {string} projectPath - Path to any worktree or the main repo
 * @returns {Promise<Array>} - List of worktree objects
 */
async function getWorktrees(projectPath) {
  const output = await execGit(projectPath, 'worktree list --porcelain');
  const worktrees = parseWorktreeListOutput(output);
  if (!remotePath.isRemotePath(projectPath)) return worktrees;

  // Remote: git answers with POSIX paths on the host. Hand them back as URIs on
  // the same host, so no layer can mistake one for a local folder.
  const { profileId } = remotePath.parse(projectPath);
  const wrapped = [];
  for (const tree of worktrees) {
    if (typeof tree.path !== 'string' || !tree.path.startsWith('/')) continue;
    try {
      wrapped.push({ ...tree, path: remotePath.format(profileId, remotePath.toPosix(tree.path)) });
    } catch (_) { /* a path the URI form cannot carry is left out */ }
  }
  _noteRemoteWorktreeRoots(profileId, wrapped.map((tree) => remotePath.parse(tree.path).path));
  return wrapped;
}

/**
 * Create a new worktree
 * @param {string} projectPath - Path to the main repo or existing worktree
 * @param {string} worktreePath - Path for the new worktree
 * @param {Object} options
 * @param {string} options.branch - Existing branch to check out
 * @param {string} options.newBranch - Name for a new branch to create
 * @param {string} options.startPoint - Start point for new branch (commit/branch)
 * @returns {Promise<Object>} - { success, error?, output? }
 */
function createWorktree(projectPath, worktreePath, options = {}) {
  return new Promise((resolve) => {
    const { branch, newBranch, startPoint } = options;
    const remote = remotePath.isRemotePath(projectPath);
    let treeArg = worktreePath;
    if (remote) {
      try { treeArg = _remoteWorktreeArg(projectPath, worktreePath); } catch (e) { resolve({ success: false, error: e.message }); return; }
    }
    const args = ['worktree', 'add'];

    if (newBranch) {
      args.push('-b', newBranch, treeArg);
      if (startPoint) args.push(startPoint);
    } else if (branch) {
      args.push(treeArg, branch);
    } else {
      args.push(treeArg);
    }

    execGitCallback(projectPath, () => safeDirArgs(projectPath), args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        if (remote) {
          const { profileId, path: projectDir } = remotePath.parse(projectPath);
          _noteRemoteWorktreeRoots(profileId, [projectDir, treeArg]);
        }
        resolve({ success: true, output: stderr || stdout || 'Worktree created' });
      }
    });
  });
}

/** The worktree argument as git on the right machine reads it, or an error result. */
function _worktreeTarget(projectPath, worktreePath) {
  if (!remotePath.isRemotePath(projectPath)) return { arg: worktreePath };
  try {
    return { arg: _remoteWorktreeArg(projectPath, worktreePath) };
  } catch (e) {
    return { error: { success: false, error: e.message } };
  }
}

/**
 * Remove a worktree
 *
 * git wants one `--force` to remove a worktree with uncommitted changes and a
 * *second* one to override a lock (`worktree remove -f -f`). That lock is not
 * always the user's: `worktree add` locks the new worktree with the reason
 * "initializing" while it sets it up, so an add that was interrupted leaves the
 * lock behind - a worktree nothing can remove until someone passes -f -f.
 * @param {string} projectPath - Path to the main repo
 * @param {string} worktreePath - Path of the worktree to remove
 * @param {boolean|number} force - true for a dirty worktree, FORCE_UNLOCK to also override a lock
 * @returns {Promise<Object>}
 */
function removeWorktree(projectPath, worktreePath, force = false) {
  return new Promise((resolve) => {
    const tree = _worktreeTarget(projectPath, worktreePath);
    if (tree.error) { resolve(tree.error); return; }
    const level = Math.min(force === true ? 1 : Math.max(0, Math.floor(Number(force) || 0)), FORCE_UNLOCK);
    const args = ['worktree', 'remove'];
    for (let i = 0; i < level; i++) args.push('--force');
    args.push(tree.arg);
    execGitCallback(projectPath, () => safeDirArgs(projectPath), args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: stdout || 'Worktree removed' });
      }
    });
  });
}

/**
 * Lock a worktree
 * @param {string} projectPath - Path to the main repo
 * @param {string} worktreePath - Path of the worktree to lock
 * @param {string} reason - Optional lock reason
 * @returns {Promise<Object>}
 */
function lockWorktree(projectPath, worktreePath, reason = '') {
  return new Promise((resolve) => {
    const tree = _worktreeTarget(projectPath, worktreePath);
    if (tree.error) { resolve(tree.error); return; }
    const args = ['worktree', 'lock'];
    if (reason) args.push('--reason', reason);
    args.push(tree.arg);
    execGitCallback(projectPath, () => safeDirArgs(projectPath), args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: 'Worktree locked' });
      }
    });
  });
}

/**
 * Unlock a worktree
 * @param {string} projectPath - Path to the main repo
 * @param {string} worktreePath - Path of the worktree to unlock
 * @returns {Promise<Object>}
 */
function unlockWorktree(projectPath, worktreePath) {
  return new Promise((resolve) => {
    const tree = _worktreeTarget(projectPath, worktreePath);
    if (tree.error) { resolve(tree.error); return; }
    execGitCallback(projectPath, () => safeDirArgs(projectPath), ['worktree', 'unlock', tree.arg], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: 'Worktree unlocked' });
      }
    });
  });
}

/**
 * Prune stale worktree entries
 * @param {string} projectPath - Path to the main repo
 * @returns {Promise<Object>}
 */
function pruneWorktrees(projectPath) {
  return new Promise((resolve) => {
    execGitCallback(projectPath, () => safeDirArgs(projectPath), ['worktree', 'prune'], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
      } else {
        resolve({ success: true, output: 'Worktrees pruned' });
      }
    });
  });
}

/**
 * Detect if a path is a worktree (not the main repo)
 * @param {string} projectPath - Path to check
 * @returns {Promise<Object>} - { isWorktree, mainRepoPath? }
 */
async function detectWorktree(projectPath) {
  const [gitDir, commonDir] = await Promise.all([
    execGit(projectPath, 'rev-parse --git-dir'),
    execGit(projectPath, 'rev-parse --git-common-dir')
  ]);

  if (!gitDir || !commonDir) return { isWorktree: false };

  // Remote: the two directories are POSIX paths on the host, resolved against
  // the remote directory with POSIX rules (path.resolve is win32 here), and the
  // main repository comes back as a URI on the same host.
  if (remotePath.isRemotePath(projectPath)) {
    const { profileId, path: dir } = remotePath.parse(projectPath);
    const absolute = (p) => (p.startsWith('/') ? path.posix.normalize(p) : path.posix.join(dir, p));
    const normGit = absolute(gitDir).replace(/\/+$/, '');
    const normCommon = absolute(commonDir).replace(/\/+$/, '');
    if (normGit === normCommon) return { isWorktree: false };
    try {
      return { isWorktree: true, mainRepoPath: remotePath.format(profileId, path.posix.dirname(normCommon)) };
    } catch (_) {
      return { isWorktree: false };
    }
  }

  const normGit = path.resolve(projectPath, gitDir).replace(/\\/g, '/');
  const normCommon = path.resolve(projectPath, commonDir).replace(/\\/g, '/');

  if (normGit !== normCommon) {
    const mainRepoPath = path.dirname(normCommon);
    return { isWorktree: true, mainRepoPath };
  }

  return { isWorktree: false };
}

/**
 * Get diff between two branches (for worktree comparison)
 * @param {string} projectPath - Path to any worktree of the repo
 * @param {string} branch1 - First branch name
 * @param {string} branch2 - Second branch name
 * @param {string} filePath - Optional specific file to diff
 * @returns {Promise<string>} - Diff output
 */
async function diffWorktreeBranches(projectPath, branch1, branch2, filePath = '') {
  const args = ['diff', `${branch1}...${branch2}`];
  if (filePath) args.push('--', filePath);
  const diff = await execGit(projectPath, args, 15000);
  if (diff === null) throw new Error(`git diff failed for ${branch1}...${branch2}`);
  return diff;
}

/**
 * Get diff stats (file list with status, additions, deletions) between two branches.
 * @param {string} projectPath
 * @param {string} branch1
 * @param {string} branch2
 * @returns {Promise<Array<{path: string, status: string, additions: number, deletions: number}>>}
 */
async function diffWorktreeBranchesWithStats(projectPath, branch1, branch2) {
  const [numstatRaw, nameStatusRaw] = await Promise.all([
    execGit(projectPath, ['diff', '--numstat', `${branch1}...${branch2}`], 15000),
    execGit(projectPath, ['diff', '--name-status', `${branch1}...${branch2}`], 15000),
  ]);

  const numstat = parseDiffNumstat(numstatRaw);

  // Parse name-status: "M\tpath" or "R100\told\tnew"
  const statusMap = new Map();
  if (nameStatusRaw) {
    for (const line of nameStatusRaw.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const code = (parts[0] || '').charAt(0); // M, A, D, R, C
      const filePath = parts.length >= 3 ? parts[2] : parts[1]; // renamed: use new path
      if (filePath) statusMap.set(filePath, code);
    }
  }

  const files = [];
  for (const [filePath, stats] of numstat) {
    files.push({
      path: filePath,
      status: statusMap.get(filePath) || 'M',
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }

  return files;
}

/**
 * Resolve a merge conflict for a specific file using ours/theirs strategy
 * @param {string} projectPath - Path to the project
 * @param {string} filePath - Path to the conflicted file
 * @param {string} strategy - 'ours' or 'theirs'
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function resolveConflict(projectPath, filePath, strategy) {
  if (strategy !== 'ours' && strategy !== 'theirs') {
    return { success: false, error: 'Invalid strategy. Use "ours" or "theirs".' };
  }
  const checkoutResult = await spawnGit(projectPath, ['checkout', `--${strategy}`, '--', filePath]);
  if (!checkoutResult.success) return checkoutResult;
  const stageResult = await spawnGit(projectPath, ['add', '--', filePath]);
  return stageResult;
}

/**
 * Get number of commits unique to a branch (not on any other branch)
 * @param {string} projectPath - Path to the project
 * @param {string} branch - Branch name
 * @returns {Promise<number>} - Number of orphan commits
 */
async function getBranchOrphanCommitCount(projectPath, branch) {
  // Get commits on this branch that are not reachable from any other branch
  const output = await execGit(projectPath, ['log', branch, '--not', '--remotes', '--exclude=' + branch, '--branches', '--oneline'], 10000);
  if (!output) return 0;
  return output.split('\n').filter(l => l.trim()).length;
}

/**
 * Kill all active git child processes.
 * Called during app shutdown to prevent orphaned git processes.
 */
function killAllGitProcesses() {
  // Remote requests run on a host, not in a local child: cancelling them is
  // what stops them (the channel kills the remote process group).
  const remote = _cancelRemoteRequests();
  if (remote > 0) console.log(`[Git] Cancelled ${remote} remote git request(s)`);
  if (_activeProcesses.size === 0) return;
  console.log(`[Git] Killing ${_activeProcesses.size} active git process(es)`);
  for (const child of _activeProcesses) {
    const pid = child.pid;
    try { child.kill('SIGTERM'); } catch (_) {}
    // On Windows, use synchronous taskkill to ensure the process tree is dead before app exits
    if (process.platform === 'win32' && pid) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true });
      } catch (_) {}
    }
  }
  _activeProcesses.clear();
}

// ── Delete remote branch ──

async function deleteRemoteBranch(projectPath, branch, remote = 'origin') {
  return execGit(projectPath, ['push', remote, '--delete', branch], 30000);
}

// ── Dedicated fetch ──

async function gitFetch(projectPath, remote = 'origin') {
  return execGit(projectPath, ['fetch', remote, '--prune'], 30000);
}

// ── Branch rename ──

async function renameBranch(projectPath, oldName, newName) {
  return execGit(projectPath, ['branch', '-m', oldName, newName]);
}

// ── Rebase ──

async function gitRebase(projectPath, branch) {
  return execGit(projectPath, ['rebase', branch], 60000);
}

async function gitRebaseAbort(projectPath) {
  return execGit(projectPath, 'rebase --abort');
}

async function gitRebaseContinue(projectPath) {
  return execGit(projectPath, 'rebase --continue');
}

// ── File history ──

async function getFileHistory(projectPath, filePath, options = {}) {
  const { skip = 0, limit = 30 } = options;
  const output = await execGit(projectPath, ['log', `--skip=${skip}`, '-n', String(limit), '--pretty=format:%H|%an|%aI|%s', '--', filePath], 15000);
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    // No quote stripping here any more. It used to compensate for the literal
    // quotes --pretty=format:"..." left in the output, and would now eat a real
    // trailing quote off a commit subject, which is the last field.
    const parts = line.split('|');
    return { hash: parts[0], author: parts[1], date: parts[2], message: parts.slice(3).join('|') };
  });
}

// ── Commit file-by-file diffs ──

async function getCommitFileDiffs(projectPath, commitHash) {
  // Get list of changed files with stats
  const statsOutput = await execGit(projectPath, ['diff-tree', '--no-commit-id', '-r', '--numstat', commitHash], 15000);
  const files = [];
  if (statsOutput) {
    for (const line of statsOutput.split('\n').filter(Boolean)) {
      const match = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (match) {
        files.push({
          additions: match[1] === '-' ? 0 : parseInt(match[1]) || 0,
          deletions: match[2] === '-' ? 0 : parseInt(match[2]) || 0,
          path: match[3]
        });
      }
    }
  }
  return files;
}

async function getCommitFileDiff(projectPath, commitHash, filePath) {
  const output = await execGit(projectPath, ['diff', `${commitHash}~1`, commitHash, '--', filePath], 15000);
  return output || '';
}

// ── Git blame ──

async function gitBlame(projectPath, filePath) {
  const output = await execGit(projectPath, ['blame', '--porcelain', '--', filePath], 30000);
  if (!output) return [];
  const lines = [];
  let current = null;
  const commits = {};
  for (const line of output.split('\n')) {
    const headerMatch = line.match(/^([a-f0-9]{40})\s+(\d+)\s+(\d+)/);
    if (headerMatch) {
      current = { hash: headerMatch[1], origLine: parseInt(headerMatch[2]), finalLine: parseInt(headerMatch[3]) };
      if (!commits[current.hash]) commits[current.hash] = {};
      continue;
    }
    if (current && line.startsWith('author ')) commits[current.hash].author = line.slice(7);
    if (current && line.startsWith('author-time ')) commits[current.hash].timestamp = parseInt(line.slice(12));
    if (current && line.startsWith('summary ')) commits[current.hash].summary = line.slice(8);
    if (current && line.startsWith('\t')) {
      lines.push({
        line: current.finalLine,
        hash: current.hash,
        author: commits[current.hash]?.author || '',
        timestamp: commits[current.hash]?.timestamp || 0,
        summary: commits[current.hash]?.summary || '',
        content: line.slice(1)
      });
      current = null;
    }
  }
  return lines;
}

// ── Tags ──

async function getTags(projectPath) {
  const output = await execGit(projectPath, 'tag -l --sort=-creatordate --format=%(refname:short)|%(creatordate:iso-strict)|%(subject)');
  if (!output) return [];
  return output.split('\n').filter(Boolean).map(line => {
    const [name, date, ...msgParts] = line.split('|');
    return { name, date, message: msgParts.join('|') };
  });
}

async function createTag(projectPath, name, message, commitHash) {
  if (message) {
    return execGit(projectPath, ['tag', '-a', name, '-m', message, ...(commitHash ? [commitHash] : [])]);
  }
  return execGit(projectPath, ['tag', name, ...(commitHash ? [commitHash] : [])]);
}

async function deleteTag(projectPath, name) {
  return execGit(projectPath, ['tag', '-d', name]);
}

async function pushTag(projectPath, name, remote = 'origin') {
  return execGit(projectPath, ['push', remote, name], 30000);
}

async function pushAllTags(projectPath, remote = 'origin') {
  return execGit(projectPath, ['push', remote, '--tags'], 30000);
}

// ── Discard file changes (git restore) ──

/**
 * Discard working-tree changes for specific files
 * @param {string} projectPath - Path to the project
 * @param {string[]} files - List of file paths to discard
 * @returns {Promise<Object>} - Result object
 */
/**
 * Split `git status --porcelain -z` output into tracked and untracked paths.
 *
 * -z is what makes this correct, not a stylistic choice. Without it git quotes
 * and C-escapes any path that is not plain ASCII (core.quotePath is on by
 * default), so reading the path as `line.substring(3)` handed back something
 * wrapped in literal quotes; the stat that followed failed, the error was
 * swallowed, and the file was silently not discarded. -z also removes the
 * trailing-space guesswork and makes a newline inside a filename harmless.
 *
 * Records are NUL-terminated as "XY <path>". A rename or copy emits a second,
 * bare record holding the original path, with no status prefix - it has to be
 * consumed here rather than read as another entry, or its first two characters
 * would be taken for a status code.
 *
 * @param {string|null} statusOutput
 * @returns {{tracked: string[], untracked: string[]}}
 */
function parsePorcelainZ(statusOutput) {
  const untracked = [];
  const tracked = [];
  if (!statusOutput) return { tracked, untracked };

  const records = statusOutput.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record || record.length < 4) continue;
    const status = record.substring(0, 2);
    const filePath = record.substring(3);
    if (status[0] === 'R' || status[0] === 'C') i++; // skip the original path
    if (status === '??') {
      untracked.push(filePath);
    } else {
      tracked.push(filePath);
    }
  }
  return { tracked, untracked };
}

async function gitDiscardFiles(projectPath, files) {
  if (!files || files.length === 0) return { success: false, error: 'No files specified' };

  const statusOutput = await execGit(projectPath, ['status', '--porcelain', '-z', '--', ...files]);
  const { tracked: trackedFiles, untracked: untrackedFiles } = parsePorcelainZ(statusOutput);

  // Discard tracked file changes with git restore
  if (trackedFiles.length > 0) {
    const result = await spawnGit(projectPath, ['restore', '--', ...trackedFiles]);
    if (!result.success) return result;
  }

  // Remote: the untracked paths go through `git clean` on the host, which
  // removes files and directories alike and never reaches outside the work
  // tree. The local branch below keeps its fs removal unchanged.
  if (remotePath.isRemotePath(projectPath)) {
    if (untrackedFiles.length > 0) {
      const clean = await spawnGit(projectPath, ['clean', '-f', '-d', '--', ...untrackedFiles]);
      if (!clean.success) return clean;
    }
    return { success: true, output: `Discarded ${files.length} file(s)` };
  }

  // Remove untracked files with git clean
  for (const f of untrackedFiles) {
    try {
      const fullPath = path.join(projectPath, f);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
    } catch (_) { /* ignore cleanup errors */ }
  }

  return { success: true, output: `Discarded ${files.length} file(s)` };
}

// ── Stash pop (atomic apply + drop) ──

/**
 * Pop a stash (apply + drop atomically)
 * @param {string} projectPath - Path to the project
 * @param {string} stashRef - Stash reference (e.g., stash@{0})
 * @returns {Promise<Object>} - Result object
 */
async function stashPop(projectPath, stashRef) {
  const result = await spawnGit(projectPath, ['stash', 'pop', stashRef]);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Stash popped.' };
}

// ── Stash show/preview ──

/**
 * Show stash diff (preview before applying)
 * @param {string} projectPath - Path to the project
 * @param {string} stashRef - Stash reference
 * @returns {Promise<string>} - Diff output
 */
async function stashShow(projectPath, stashRef) {
  const output = await execGit(projectPath, ['stash', 'show', '-p', stashRef], 15000);
  return output || '';
}

// ── Amend commit ──

/**
 * Amend the last commit with new message and/or staged changes
 * @param {string} projectPath - Path to the project
 * @param {string} [message] - New commit message (if null, keeps original)
 * @returns {Promise<Object>} - Result object
 */
async function gitAmendCommit(projectPath, message) {
  const args = ['commit', '--amend'];
  if (message && message.trim()) {
    args.push('-m', message.trim());
  } else {
    args.push('--no-edit');
  }
  const result = await spawnGit(projectPath, args);
  if (!result.success) return result;
  return { success: true, output: result.output || 'Commit amended.' };
}

// ── Rebase detection ──

/**
 * Check if there's a rebase in progress
 * @param {string} projectPath - Path to the project
 * @returns {Promise<boolean>} - True if rebase in progress
 */
async function isRebaseInProgress(projectPath) {
  // Remote: `git rev-parse --git-path` names the two rebase directories
  // (worktree-aware), and the host checks whether either exists, in one request.
  if (remotePath.isRemotePath(projectPath)) {
    const result = await _remoteRun(projectPath, {
      cacheKey: ['@rebase-in-progress'],
      readOnly: true,
      timeout: 10000,
      build: (dir) => remoteShell.script(
        remoteShell.requireDir(dir),
        `cd -- ${remoteShell.q(dir)} || exit ${remoteShell.NODIR_EXIT}`,
        'm=$(git rev-parse --git-path rebase-merge 2>/dev/null) && a=$(git rev-parse --git-path rebase-apply 2>/dev/null) && { [ -e "$m" ] || [ -e "$a" ]; }',
      ),
    });
    return result.ok;
  }
  const gitDir = await execGit(projectPath, 'rev-parse --git-dir');
  if (!gitDir) return false;
  const resolvedGitDir = path.resolve(projectPath, gitDir);
  // Interactive rebase
  const rebaseMerge = path.join(resolvedGitDir, 'rebase-merge');
  if (fs.existsSync(rebaseMerge)) return true;
  // Non-interactive rebase (git rebase --apply)
  const rebaseApply = path.join(resolvedGitDir, 'rebase-apply');
  return fs.existsSync(rebaseApply);
}

// ── Git reset ──

/**
 * Reset HEAD to a previous commit
 * @param {string} projectPath - Path to the project
 * @param {string} mode - Reset mode: 'soft', 'mixed', or 'hard'
 * @param {string} [target] - Reset target (default: HEAD~1)
 * @returns {Promise<Object>} - Result object
 */
async function gitReset(projectPath, mode = 'soft', target = 'HEAD~1') {
  const allowedModes = ['soft', 'mixed', 'hard'];
  if (!allowedModes.includes(mode)) return { success: false, error: 'Invalid reset mode' };
  const result = await spawnGit(projectPath, ['reset', `--${mode}`, target]);
  if (!result.success) return result;
  return { success: true, output: result.output || `Reset ${mode} to ${target}` };
}

// ── History search ──

/**
 * Search commit history by message (--grep) or content changes (-S pickaxe)
 * @param {string} projectPath - Path to the project
 * @param {Object} options
 * @param {string} [options.grep] - Search in commit messages
 * @param {string} [options.pickaxe] - Search for changes adding/removing string (-S)
 * @param {number} [options.skip] - Skip N commits
 * @param {number} [options.limit] - Max results
 * @param {string} [options.branch] - Branch to search
 * @param {boolean} [options.allBranches] - Search all branches
 * @returns {Promise<Array>} - List of matching commits
 */
async function searchCommitHistory(projectPath, options = {}) {
  const { grep, pickaxe, skip = 0, limit = 30, branch = '', allBranches = false } = options;
  if (!grep && !pickaxe) return [];

  const RS = '%x1e';
  const format = `%H${RS}%h${RS}%s${RS}%an${RS}%ae${RS}%ar${RS}%aI${RS}%P${RS}%D`;
  const args = ['log', `--skip=${skip}`, `-${limit}`, `--format=${format}`];

  if (grep) {
    args.push(`--grep=${grep}`, '-i');
  }
  if (pickaxe) {
    args.push(`-S${pickaxe}`);
  }
  if (allBranches) {
    args.push('--all');
  }
  if (branch) {
    args.push(branch);
  }

  const output = await execGit(projectPath, args, 15000);
  if (!output) return [];
  return output.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.split('\x1e');
    const [fullHash, hash, message, author, email, date, isoDate, parentStr, decorations] = parts;
    const parents = parentStr ? parentStr.trim().split(' ').filter(Boolean) : [];
    return { fullHash, hash, message, author, email, date, isoDate, parents, decorations: decorations || '' };
  });
}

// ── Remote management ──

/**
 * Add a remote
 * @param {string} projectPath
 * @param {string} name - Remote name
 * @param {string} url - Remote URL
 * @returns {Promise<Object>}
 */
async function addRemote(projectPath, name, url) {
  const result = await spawnGit(projectPath, ['remote', 'add', name, url]);
  if (!result.success) return result;
  return { success: true, output: `Remote '${name}' added.` };
}

/**
 * Remove a remote
 * @param {string} projectPath
 * @param {string} name - Remote name
 * @returns {Promise<Object>}
 */
async function removeRemote(projectPath, name) {
  const result = await spawnGit(projectPath, ['remote', 'remove', name]);
  if (!result.success) return result;
  return { success: true, output: `Remote '${name}' removed.` };
}

// ── Remotes ──

async function getRemotes(projectPath) {
  const output = await execGit(projectPath, 'remote -v');
  if (!output) return [];
  const map = new Map();
  for (const line of output.split('\n').filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
    if (match) {
      if (!map.has(match[1])) map.set(match[1], { name: match[1], fetchUrl: '', pushUrl: '' });
      const remote = map.get(match[1]);
      if (match[3] === 'fetch') remote.fetchUrl = match[2];
      if (match[3] === 'push') remote.pushUrl = match[2];
    }
  }
  return Array.from(map.values());
}

module.exports = {
  parseGitStatus,
  parseDiffNumstat,
  execGit,
  execGitResult,
  // Defined here but never exported, so git.node.js destructured `undefined`
  // and its merge / stash / stash-pop / reset actions all threw
  // "spawnGit is not a function" the moment they ran.
  spawnGit,
  describeGitFailure,
  isGitUnavailable,
  killAllGitProcesses,
  getGitInfo,
  getGitInfoFull,
  getGitStatusQuick,
  getGitStatusDetailed,
  gitPull,
  gitPush,
  gitPushBranch,
  gitMerge,
  gitMergeAbort,
  gitMergeContinue,
  getMergeConflicts,
  isMergeInProgress,
  gitClone,
  gitStageFiles,
  gitCommit,
  countLinesOfCode,
  getProjectStats,
  getBranches,
  getCurrentBranch,
  checkoutBranch,
  createBranch,
  deleteBranch,
  getCommitHistory,
  getFileDiff,
  getFileDiffResult,
  getCommitDetail,
  getCommitDetailResult,
  cherryPick,
  revertCommit,
  gitUnstageFiles,
  stashApply,
  stashDrop,
  gitStashSave,
  parseWorktreeListOutput,
  parsePorcelainZ,
  getWorktrees,
  createWorktree,
  removeWorktree,
  FORCE_UNLOCK,
  lockWorktree,
  unlockWorktree,
  pruneWorktrees,
  detectWorktree,
  diffWorktreeBranches,
  diffWorktreeBranchesWithStats,
  // New operations
  deleteRemoteBranch,
  gitFetch,
  renameBranch,
  gitRebase,
  gitRebaseAbort,
  gitRebaseContinue,
  getFileHistory,
  getCommitFileDiffs,
  getCommitFileDiff,
  gitBlame,
  getTags,
  createTag,
  deleteTag,
  pushTag,
  pushAllTags,
  getRemotes,
  resolveConflict,
  getBranchOrphanCommitCount,
  // New git features
  gitDiscardFiles,
  stashPop,
  stashShow,
  gitAmendCommit,
  isRebaseInProgress,
  gitReset,
  searchCommitHistory,
  addRemote,
  removeRemote,
  // Remote (SSH) projects
  execGitCallback,
  isReadOnlyGitCommand,
  remoteStatsScript,
  parseRemoteStats,
  grepTodoCandidates,
  readUntrackedHeads,
  discoverRemoteWorktrees,
  /** Test seams: inject the remote executor and the clock, reset the caches. */
  _remoteInternals: {
    setExecutor(executor) { _remoteExecutorOverride = executor || null; },
    setNow(fn) { _remoteNow = fn || (() => Date.now()); },
    reset() {
      _remoteReadCache.clear();
      _remoteGenerations.clear();
      _remoteStatsCache.clear();
      _remoteControllers.clear();
    },
    pending: () => _remoteControllers.size,
  },
};
