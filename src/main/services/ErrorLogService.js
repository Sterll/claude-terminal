/**
 * ErrorLogService
 * Centralized error collection, classification, and pattern detection.
 * Captures errors from IPC handlers, services, uncaught exceptions/rejections.
 * Forwards entries to the renderer via mainWindow.webContents.send().
 */

const MAX_ENTRIES = 2000;
const PATTERN_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const PATTERN_THRESHOLD = 5; // alert after N occurrences in window

let _entries = [];
let _mainWindow = null;
let _entryId = 0;
let _patternAlerts = new Map(); // fingerprint -> { count, firstSeen, lastSeen, alerted }

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

// ── Internal helpers ────────────────────────────────────────────────────────

function _normalizeMessage(msg) {
  return String(msg)
    .replace(/\b\d+\b/g, 'N')
    .replace(/[0-9a-f]{8,}/gi, 'HASH')
    .replace(/\/[^\s/]+/g, '/PATH')
    .slice(0, 200);
}

function _trackPattern(fingerprint, entry) {
  const now = Date.now();
  let data = _patternAlerts.get(fingerprint);

  if (!data) {
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
};
