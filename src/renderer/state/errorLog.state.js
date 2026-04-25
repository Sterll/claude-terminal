/**
 * Error Log State Module
 * Manages centralized error log entries in the renderer.
 */

const { State } = require('./State');

const MAX_RENDERER_ENTRIES = 2000;

const initialState = {
  entries: [],
  patternAlerts: [],
  stats: null,
  filter: {
    level: null,    // 'critical' | 'warning' | 'info' | null
    domain: '',
    search: '',
  },
};

const errorLogState = new State(initialState);

// ── API ─────────────────────────────────────────────────────────────────────

function addEntry(entry) {
  const entries = [...errorLogState.get().entries, entry];
  if (entries.length > MAX_RENDERER_ENTRIES) {
    entries.splice(0, entries.length - MAX_RENDERER_ENTRIES);
  }
  errorLogState.setProp('entries', entries);
}

function setEntries(entries) {
  errorLogState.setProp('entries', entries);
}

function addPatternAlert(alert) {
  const alerts = errorLogState.get().patternAlerts;
  const existing = alerts.findIndex(a => a.fingerprint === alert.fingerprint);
  if (existing >= 0) {
    const updated = [...alerts];
    updated[existing] = alert;
    errorLogState.setProp('patternAlerts', updated);
  } else {
    errorLogState.setProp('patternAlerts', [...alerts, alert]);
  }
}

function setPatternAlerts(alerts) {
  errorLogState.setProp('patternAlerts', alerts);
}

function setStats(stats) {
  errorLogState.setProp('stats', stats);
}

function setFilter(filterUpdates) {
  const current = errorLogState.get().filter;
  errorLogState.setProp('filter', { ...current, ...filterUpdates });
}

function clearEntries() {
  errorLogState.set({
    entries: [],
    patternAlerts: [],
    stats: null,
    filter: errorLogState.get().filter,
  });
}

function getFilteredEntries() {
  const { entries, filter } = errorLogState.get();
  let result = entries;

  if (filter.level) {
    result = result.filter(e => e.level === filter.level);
  }
  if (filter.domain) {
    result = result.filter(e => e.domain.includes(filter.domain));
  }
  if (filter.search) {
    const q = filter.search.toLowerCase();
    result = result.filter(e =>
      e.message.toLowerCase().includes(q) ||
      e.domain.toLowerCase().includes(q) ||
      (e.stack && e.stack.toLowerCase().includes(q))
    );
  }

  return result;
}

function getDomains() {
  const domains = new Set();
  for (const e of errorLogState.get().entries) {
    domains.add(e.domain);
  }
  return [...domains].sort();
}

// ── IPC Listeners ───────────────────────────────────────────────────────────

function initErrorLogListeners() {
  const api = window.electron_api;
  if (!api?.errorLog) return;

  if (api.errorLog.onEntry) {
    api.errorLog.onEntry((entry) => {
      addEntry(entry);
    });
  }

  if (api.errorLog.onPatternAlert) {
    api.errorLog.onPatternAlert((alert) => {
      addPatternAlert(alert);
    });
  }

  if (api.errorLog.onCleared) {
    api.errorLog.onCleared(() => {
      clearEntries();
    });
  }
}

module.exports = {
  errorLogState,
  addEntry,
  setEntries,
  addPatternAlert,
  setPatternAlerts,
  setStats,
  setFilter,
  clearEntries,
  getFilteredEntries,
  getDomains,
  initErrorLogListeners,
};
