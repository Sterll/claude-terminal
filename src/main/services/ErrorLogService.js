/**
 * ErrorLogService
 * Centralized error collection, classification, and pattern detection.
 * Captures errors from IPC handlers, services, uncaught exceptions/rejections,
 * and every console.error / console.warn emitted by the main process.
 * Forwards entries to the renderer via mainWindow.webContents.send().
 */

const util = require('util');

const MAX_ENTRIES = 2000;
const MAX_PATTERNS = 500; // fingerprints tracked at once (same cap discipline as MAX_ENTRIES)
const PATTERN_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PATTERN_THRESHOLD = 5; // alert after N occurrences in window

/**
 * console methods we mirror into the log, mapped to their entry level.
 *
 * `console.error` maps to 'warning', not 'critical': the main process has 208
 * console.error sites and the large majority are caught-and-degraded paths, not
 * app-breaking failures. 'critical' stays reserved for uncaughtException and
 * unhandledRejection, so the panel's critical count still means "the app
 * actually broke" rather than "something logged".
 */
const CONSOLE_LEVELS = { error: 'warning', warn: 'warning' };
/** Domain used when a console message carries no `[Prefix]`. */
const CONSOLE_FALLBACK_DOMAIN = 'console';

let _entries = [];
let _mainWindow = null;
let _entryId = 0;
let _patternAlerts = new Map(); // fingerprint -> { count, firstSeen, lastSeen, alerted }
let _consoleTarget = null; // console object currently patched (null = not installed)
let _originalConsole = null; // { error, warn } originals, for uninstall
let _inConsoleCapture = false; // re-entrancy guard: breaks console -> log -> console loops

// ── Public API ──────────────────────────────────────────────────────────────

function setMainWindow(win) {
  _mainWindow = win;
}

/**
 * Log an error entry.
 * @param {'critical'|'warning'|'info'} level
 * @param {string} domain - e.g. 'ipc:git', 'service:workflow', 'mcp', 'uncaught'
 * @param {string} message
 * @param {Object} [opts]
 * @param {string} [opts.stack]
 * @param {Object} [opts.context] - extra structured data
 */
function log(level, domain, message, opts = {}) {
  const entry = {
    id: ++_entryId,
    timestamp: Date.now(),
    level,
    domain,
    message: String(message).slice(0, 2000),
    stack: opts.stack ? String(opts.stack).slice(0, 4000) : null,
    context: opts.context || null,
  };

  _entries.push(entry);
  if (_entries.length > MAX_ENTRIES) {
    _entries = _entries.slice(-MAX_ENTRIES);
  }

  // Pattern detection
  const fingerprint = `${domain}::${_normalizeMessage(message)}`;
  _trackPattern(fingerprint, entry);

  // Forward to renderer
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send('errorlog:entry', entry);
  }
}

function logCritical(domain, message, opts) { log('critical', domain, message, opts); }
function logWarning(domain, message, opts) { log('warning', domain, message, opts); }
function logInfo(domain, message, opts) { log('info', domain, message, opts); }

/**
 * Wrap an IPC handler with automatic error logging.
 * @param {string} channel - IPC channel name
 * @param {Function} handler
 * @returns {Function}
 */
function wrapIpcHandler(channel, handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      const domain = `ipc:${channel.split('-')[0]}`;
      logWarning(domain, `${channel}: ${error.message}`, {
        stack: error.stack,
        context: { channel },
      });
      throw error;
    }
  };
}

function getEntries(filters = {}) {
  let result = _entries;

  if (filters.level) {
    result = result.filter(e => e.level === filters.level);
  }
  if (filters.domain) {
    result = result.filter(e => e.domain.includes(filters.domain));
  }
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter(e =>
      e.message.toLowerCase().includes(q) ||
      e.domain.toLowerCase().includes(q) ||
      (e.stack && e.stack.toLowerCase().includes(q))
    );
  }
  if (filters.since) {
    result = result.filter(e => e.timestamp >= filters.since);
  }

  return result;
}

function getPatternAlerts() {
  const now = Date.now();
  const alerts = [];
  for (const [fp, data] of _patternAlerts) {
    if (data.count >= PATTERN_THRESHOLD && (now - data.firstSeen) <= PATTERN_WINDOW_MS) {
      alerts.push({
        fingerprint: fp,
        count: data.count,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
        domain: fp.split('::')[0],
        message: fp.split('::').slice(1).join('::'),
      });
    }
  }
  return alerts.sort((a, b) => b.count - a.count);
}

function clear() {
  _entries = [];
  _entryId = 0;
  _patternAlerts.clear();
  if (_mainWindow && !_mainWindow.isDestroyed()) {
    _mainWindow.webContents.send('errorlog:cleared');
  }
}

function getStats() {
  const now = Date.now();
  const last1h = _entries.filter(e => (now - e.timestamp) <= 3600000);
  const byCritical = last1h.filter(e => e.level === 'critical').length;
  const byWarning = last1h.filter(e => e.level === 'warning').length;
  const byInfo = last1h.filter(e => e.level === 'info').length;

  const domains = {};
  for (const e of last1h) {
    domains[e.domain] = (domains[e.domain] || 0) + 1;
  }

  return {
    total: _entries.length,
    last1h: last1h.length,
    critical: byCritical,
    warning: byWarning,
    info: byInfo,
    domains,
    patternAlerts: getPatternAlerts().length,
  };
}

function exportForBugReport() {
  return {
    exportedAt: new Date().toISOString(),
    stats: getStats(),
    patternAlerts: getPatternAlerts(),
    entries: _entries.slice(-500),
  };
}

// ── Process-level error capture ─────────────────────────────────────────────

function installGlobalHandlers() {
  process.on('uncaughtException', (error) => {
    logCritical('uncaught', error.message, { stack: error.stack });
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : null;
    logWarning('unhandled-rejection', msg, { stack });
  });
}

/**
 * Mirror console.error / console.warn into the log.
 *
 * The main process degrades gracefully in ~40 places with a caught error and a
 * console.error / console.warn. Those are invisible in a packaged app, so the
 * panel used to permanently read "everything is fine". This wraps (never
 * replaces) the console methods:
 *   - the original method is always called first, with the exact same arguments,
 *     so stdout/stderr output and formatting are unchanged;
 *   - a re-entrancy guard makes any console call emitted *while* capturing (by
 *     this service, by webContents.send, by util.format on an exotic object)
 *     fall straight through to the original - no infinite recursion;
 *   - anything thrown by the capture path is swallowed: logging must never break
 *     the caller;
 *   - entries go through log(), so the MAX_ENTRIES cap bounds a log storm.
 *
 * Idempotent. Call as early as possible in the bootstrap.
 * @param {Object} [target=console] - console object to patch (injectable for tests)
 * @returns {boolean} true if it installed, false if already installed
 */
function installConsoleCapture(target = console) {
  if (_consoleTarget) return false;

  _consoleTarget = target;
  _originalConsole = {};

  for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    _originalConsole[method] = original;

    target[method] = function capturedConsoleMethod(...args) {
      // 1. Original behaviour, untouched and first, so output ordering is preserved.
      original.apply(this, args);

      // 2. Mirror into the log - guarded against recursion and against throwing.
      if (_inConsoleCapture) return;
      _inConsoleCapture = true;
      try {
        log(level, _domainFromConsoleArgs(args), _messageFromConsoleArgs(args), {
          stack: _stackFromConsoleArgs(args),
          context: { source: `console.${method}` },
        });
      } catch (_) {
        // Never let error logging break the code that was reporting an error.
      } finally {
        _inConsoleCapture = false;
      }
    };
  }

  return true;
}

/** Restore the original console methods (used by tests / teardown). */
function uninstallConsoleCapture() {
  if (!_consoleTarget) return false;
  for (const [method, original] of Object.entries(_originalConsole)) {
    _consoleTarget[method] = original;
  }
  _consoleTarget = null;
  _originalConsole = null;
  _inConsoleCapture = false;
  return true;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * Format console arguments the way console itself would, except that Error
 * arguments collapse to "Name: message" - their stack is carried separately in
 * entry.stack instead of being inlined and eating the 2000-char message budget.
 */
function _messageFromConsoleArgs(args) {
  const printable = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : a));
  return util.format(...printable);
}

/** First stack found among the arguments, if any. */
function _stackFromConsoleArgs(args) {
  const err = args.find(a => a instanceof Error && a.stack);
  return err ? err.stack : null;
}

/**
 * Derive a domain from the codebase's `[Prefix]` convention:
 *   '[ChatService] failed'  -> 'chatservice'
 *   '[Terminal IPC] boom'   -> 'terminal-ipc'
 *   'no prefix here'        -> 'console'
 * The prefix must start with a letter, so bracketed dates/numbers/[object Object]
 * cannot mint junk domains.
 */
function _domainFromConsoleArgs(args) {
  const first = args.find(a => typeof a === 'string');
  const match = /^\s*\[([A-Za-z][^\]\r\n]{0,48})\]/.exec(first || '');
  if (!match) return CONSOLE_FALLBACK_DOMAIN;

  const slug = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || CONSOLE_FALLBACK_DOMAIN;
}

function _normalizeMessage(msg) {
  return String(msg)
    .replace(/\b\d+\b/g, 'N')
    .replace(/[0-9a-f]{8,}/gi, 'HASH')
    // Windows paths: without this every distinct backslash path (and every
    // temp/worktree directory) minted its own permanent fingerprint.
    .replace(/[A-Za-z]:\\/g, 'DRIVE\\')
    .replace(/\\[^\s\\/]+/g, '\\PATH')
    .replace(/\/[^\s/]+/g, '/PATH')
    .slice(0, 200);
}

/**
 * Keep the fingerprint map bounded, mirroring the MAX_ENTRIES discipline.
 * Drops fingerprints whose window has expired first (they can never alert
 * again as-is), then evicts the least-recently-seen ones.
 */
function _prunePatterns() {
  if (_patternAlerts.size <= MAX_PATTERNS) return;

  const now = Date.now();
  for (const [fp, data] of _patternAlerts) {
    if (now - data.lastSeen > PATTERN_WINDOW_MS) _patternAlerts.delete(fp);
  }

  if (_patternAlerts.size <= MAX_PATTERNS) return;

  const oldestFirst = [..._patternAlerts.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  const excess = _patternAlerts.size - MAX_PATTERNS;
  for (let i = 0; i < excess; i++) {
    _patternAlerts.delete(oldestFirst[i][0]);
  }
}

function _trackPattern(fingerprint, entry) {
  const now = Date.now();
  let data = _patternAlerts.get(fingerprint);

  if (!data) {
    _prunePatterns(); // only a new fingerprint can grow the map
    data = { count: 0, firstSeen: now, lastSeen: now, alerted: false };
    _patternAlerts.set(fingerprint, data);
  }

  // Reset window if too old
  if (now - data.firstSeen > PATTERN_WINDOW_MS) {
    data.count = 0;
    data.firstSeen = now;
    data.alerted = false;
  }

  data.count++;
  data.lastSeen = now;
  _patternAlerts.set(fingerprint, data);

  // Send pattern alert to renderer
  if (data.count >= PATTERN_THRESHOLD && !data.alerted) {
    data.alerted = true;
    if (_mainWindow && !_mainWindow.isDestroyed()) {
      _mainWindow.webContents.send('errorlog:pattern-alert', {
        fingerprint,
        count: data.count,
        domain: entry.domain,
        message: entry.message,
      });
    }
  }
}

module.exports = {
  setMainWindow,
  log,
  logCritical,
  logWarning,
  logInfo,
  wrapIpcHandler,
  getEntries,
  getPatternAlerts,
  getStats,
  clear,
  exportForBugReport,
  installGlobalHandlers,
  installConsoleCapture,
  uninstallConsoleCapture,
};
