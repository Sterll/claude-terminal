/**
 * Database State Module
 * Manages database connections state, query history, and saved queries
 */

const { State } = require('./State');
const { queryHistoryFile, savedQueriesFile } = require('../utils/paths');
const { fs } = window.electron_nodeModules;
const { fileExists } = require('../utils/fs-async');
const fsp = require('../utils/fs-async').fsp;

const MAX_HISTORY = 200;
const MAX_SAVED = 50;
const HISTORY_SAVE_DEBOUNCE = 1000;
const SAVED_SAVE_DEBOUNCE = 500;

let historyDebounceTimer = null;
let savedDebounceTimer = null;
let persistenceLoaded = false;

const initialState = {
  connections: [],           // [{ id, name, type, host, port, database, projectId?, mcpProvisioned, mcpName }]
  activeConnection: null,    // connection id
  connectionStatuses: {},    // { [id]: 'disconnected'|'connecting'|'connected'|'error' }
  schemas: {},               // { [id]: { tables: [...] } }
  queryResults: {},          // { [tabId or connId]: { columns, rows, rowCount, duration, error } }
  currentQuery: '',          // DEPRECATED — kept for migration. Use queryTabs
  queryTabs: [],             // [{ id, name, query }]
  activeQueryTabId: null,    // active tab id
  detectedDatabases: [],     // Auto-detected configs from project scan
  queryHistory: [],          // [{ id, timestamp, sql, connectionId, connectionName, dbType, duration, rowCount, error, success }]
  savedQueries: [],          // [{ id, name, sql, createdAt }]
};

const databaseState = new State(initialState);

// ========== Connections ==========

function getDatabaseConnections() {
  return databaseState.get().connections;
}

function getDatabaseConnection(id) {
  return databaseState.get().connections.find(c => c.id === id);
}

function setDatabaseConnections(connections) {
  databaseState.setProp('connections', connections);
}

function addDatabaseConnection(conn) {
  const connections = [...databaseState.get().connections, conn];
  databaseState.setProp('connections', connections);
}

function updateDatabaseConnection(id, updates) {
  const connections = databaseState.get().connections.map(c =>
    c.id === id ? { ...c, ...updates } : c
  );
  databaseState.setProp('connections', connections);
}

function removeDatabaseConnection(id) {
  const state = databaseState.get();
  const connections = state.connections.filter(c => c.id !== id);
  const connectionStatuses = { ...state.connectionStatuses };
  delete connectionStatuses[id];
  const schemas = { ...state.schemas };
  delete schemas[id];
  const queryResults = { ...state.queryResults };
  delete queryResults[id];

  let activeConnection = state.activeConnection;
  if (activeConnection === id) activeConnection = null;

  databaseState.set({ connections, connectionStatuses, schemas, queryResults, activeConnection });
}

// ========== Active Connection ==========

function getActiveConnection() {
  return databaseState.get().activeConnection;
}

function setActiveConnection(id) {
  databaseState.setProp('activeConnection', id);
}

// ========== Connection Status ==========

function getConnectionStatus(id) {
  return databaseState.get().connectionStatuses[id] || 'disconnected';
}

function setConnectionStatus(id, status) {
  const connectionStatuses = { ...databaseState.get().connectionStatuses, [id]: status };
  databaseState.setProp('connectionStatuses', connectionStatuses);
}

// ========== Schema ==========

function getDatabaseSchema(id) {
  return databaseState.get().schemas[id] || null;
}

function setDatabaseSchema(id, schema) {
  const schemas = { ...databaseState.get().schemas, [id]: schema };
  databaseState.setProp('schemas', schemas);
}

// ========== Query ==========

function getQueryResult(id) {
  return databaseState.get().queryResults[id] || null;
}

function setQueryResult(id, result) {
  const queryResults = { ...databaseState.get().queryResults, [id]: result };
  databaseState.setProp('queryResults', queryResults);
}

function getCurrentQuery() {
  const tab = getActiveQueryTab();
  return tab ? tab.query : databaseState.get().currentQuery;
}

function setCurrentQuery(sql) {
  const tab = getActiveQueryTab();
  if (tab) {
    updateQueryTab(tab.id, { query: sql });
  } else {
    databaseState.setProp('currentQuery', sql);
  }
}

// ========== Query Tabs ==========

function getQueryTabs() {
  return databaseState.get().queryTabs;
}

function getActiveQueryTabId() {
  return databaseState.get().activeQueryTabId;
}

function setActiveQueryTabId(id) {
  databaseState.setProp('activeQueryTabId', id);
}

function addQueryTab(tab) {
  const tabs = [...databaseState.get().queryTabs, tab];
  databaseState.set({ queryTabs: tabs, activeQueryTabId: tab.id });
}

function removeQueryTab(id) {
  const state = databaseState.get();
  const tabs = state.queryTabs.filter(t => t.id !== id);
  let activeId = state.activeQueryTabId;
  if (activeId === id) {
    activeId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
  }
  // Clean up results for this tab
  const queryResults = { ...state.queryResults };
  delete queryResults[id];
  databaseState.set({ queryTabs: tabs, activeQueryTabId: activeId, queryResults });
}

function updateQueryTab(id, updates) {
  const tabs = databaseState.get().queryTabs.map(t =>
    t.id === id ? { ...t, ...updates } : t
  );
  databaseState.setProp('queryTabs', tabs);
}

function getActiveQueryTab() {
  const state = databaseState.get();
  return state.queryTabs.find(t => t.id === state.activeQueryTabId) || null;
}

// ========== Detection ==========

function getDetectedDatabases() {
  return databaseState.get().detectedDatabases;
}

function setDetectedDatabases(detected) {
  databaseState.setProp('detectedDatabases', detected);
}

// ========== Query History ==========

function getQueryHistory() {
  return databaseState.get().queryHistory;
}

function addQueryHistoryEntry(entry) {
  const history = [entry, ...databaseState.get().queryHistory];
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  databaseState.setProp('queryHistory', history);
  _debouncedSaveHistory();
}

function removeQueryHistoryEntry(id) {
  const history = databaseState.get().queryHistory.filter(e => e.id !== id);
  databaseState.setProp('queryHistory', history);
  _debouncedSaveHistory();
}

function clearQueryHistory() {
  databaseState.setProp('queryHistory', []);
  _debouncedSaveHistory();
}

// ========== Saved Queries ==========

function getSavedQueries() {
  return databaseState.get().savedQueries;
}

function addSavedQuery(query) {
  const saved = [...databaseState.get().savedQueries, query];
  if (saved.length > MAX_SAVED) saved.shift();
  databaseState.setProp('savedQueries', saved);
  _debouncedSaveSaved();
}

function removeSavedQuery(id) {
  const saved = databaseState.get().savedQueries.filter(q => q.id !== id);
  databaseState.setProp('savedQueries', saved);
  _debouncedSaveSaved();
}

// ========== Persistence ==========

function _debouncedSaveHistory() {
  clearTimeout(historyDebounceTimer);
  historyDebounceTimer = setTimeout(_saveHistoryImmediate, HISTORY_SAVE_DEBOUNCE);
}

async function _saveHistoryImmediate() {
  clearTimeout(historyDebounceTimer);
  const tmpFile = queryHistoryFile + '.tmp';
  try {
    await fsp.writeFile(tmpFile, JSON.stringify(databaseState.get().queryHistory, null, 2), 'utf8');
    await fsp.rename(tmpFile, queryHistoryFile);
  } catch (e) {
    console.error('[Database] History save failed:', e.message);
    try { await fsp.unlink(tmpFile); } catch (_) {}
  }
}

function _debouncedSaveSaved() {
  clearTimeout(savedDebounceTimer);
  savedDebounceTimer = setTimeout(_saveSavedImmediate, SAVED_SAVE_DEBOUNCE);
}

async function _saveSavedImmediate() {
  clearTimeout(savedDebounceTimer);
  const tmpFile = savedQueriesFile + '.tmp';
  try {
    await fsp.writeFile(tmpFile, JSON.stringify(databaseState.get().savedQueries, null, 2), 'utf8');
    await fsp.rename(tmpFile, savedQueriesFile);
  } catch (e) {
    console.error('[Database] Saved queries save failed:', e.message);
    try { await fsp.unlink(tmpFile); } catch (_) {}
  }
}

async function loadDatabasePersistence() {
  if (persistenceLoaded) return;
  persistenceLoaded = true;

  // Load history
  try {
    if (await fileExists(queryHistoryFile)) {
      const raw = await fsp.readFile(queryHistoryFile, 'utf8');
      if (raw && raw.trim()) {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          databaseState.setProp('queryHistory', data.slice(0, MAX_HISTORY));
        }
      }
    }
  } catch (e) {
    console.warn('[Database] Failed to load history:', e.message);
  }

  // Migrate single-query to tab system
  const currentState = databaseState.get();
  if ((!currentState.queryTabs || currentState.queryTabs.length === 0)) {
    const defaultTab = { id: 'tab-1', name: 'Query 1', query: currentState.currentQuery || '' };
    databaseState.set({ queryTabs: [defaultTab], activeQueryTabId: 'tab-1' });
  }

  // Load saved queries
  try {
    if (await fileExists(savedQueriesFile)) {
      const raw = await fsp.readFile(savedQueriesFile, 'utf8');
      if (raw && raw.trim()) {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          databaseState.setProp('savedQueries', data.slice(0, MAX_SAVED));
        }
      }
    }
  } catch (e) {
    console.warn('[Database] Failed to load saved queries:', e.message);
  }
}

module.exports = {
  databaseState,
  getDatabaseConnections,
  getDatabaseConnection,
  setDatabaseConnections,
  addDatabaseConnection,
  updateDatabaseConnection,
  removeDatabaseConnection,
  getActiveConnection,
  setActiveConnection,
  getConnectionStatus,
  setConnectionStatus,
  getDatabaseSchema,
  setDatabaseSchema,
  getQueryResult,
  setQueryResult,
  getCurrentQuery,
  setCurrentQuery,
  getQueryTabs,
  getActiveQueryTabId,
  setActiveQueryTabId,
  addQueryTab,
  removeQueryTab,
  updateQueryTab,
  getActiveQueryTab,
  getDetectedDatabases,
  setDetectedDatabases,
  getQueryHistory,
  addQueryHistoryEntry,
  removeQueryHistoryEntry,
  clearQueryHistory,
  getSavedQueries,
  addSavedQuery,
  removeSavedQuery,
  loadDatabasePersistence
};
