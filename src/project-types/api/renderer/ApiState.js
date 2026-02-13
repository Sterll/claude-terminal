/**
 * API State Module
 * Manages API server state + detected routes + test history
 */

const { State } = require('../../../renderer/state/State');

const initialState = {
  apiServers: new Map(),  // projectIndex -> { status, logs[], port, framework }
  apiRoutes: new Map(),   // projectIndex -> Array<{method, path, handler, file, line}>
  apiHistory: new Map()   // projectIndex -> Array<{request, response, timestamp}>
};

const apiState = new State(initialState);

// ===== Server state =====

function getApiServer(projectIndex) {
  return apiState.get().apiServers.get(projectIndex) || {
    status: 'stopped',
    logs: [],
    port: null,
    framework: null
  };
}

function setApiServerStatus(projectIndex, status) {
  const servers = apiState.get().apiServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [], port: null, framework: null };
  servers.set(projectIndex, { ...current, status });
  apiState.setProp('apiServers', servers);
}

function setApiPort(projectIndex, port) {
  const servers = apiState.get().apiServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [], port: null, framework: null };
  servers.set(projectIndex, { ...current, port });
  apiState.setProp('apiServers', servers);
}

function setApiFramework(projectIndex, framework) {
  const servers = apiState.get().apiServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [], port: null, framework: null };
  servers.set(projectIndex, { ...current, framework });
  apiState.setProp('apiServers', servers);
}

function addApiLog(projectIndex, data) {
  const servers = apiState.get().apiServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [], port: null, framework: null };
  const logs = [...current.logs, data];
  let combined = logs.join('');
  if (combined.length > 10000) combined = combined.slice(-10000);
  servers.set(projectIndex, { ...current, logs: [combined] });
  apiState.setProp('apiServers', servers);
}

function clearApiLogs(projectIndex) {
  const servers = apiState.get().apiServers;
  const current = servers.get(projectIndex);
  if (current) {
    servers.set(projectIndex, { ...current, logs: [] });
    apiState.setProp('apiServers', servers);
  }
}

function initApiServer(projectIndex) {
  const servers = apiState.get().apiServers;
  if (!servers.has(projectIndex)) {
    servers.set(projectIndex, { status: 'stopped', logs: [], port: null, framework: null });
    apiState.setProp('apiServers', servers);
  }
}

function removeApiServer(projectIndex) {
  const servers = apiState.get().apiServers;
  servers.delete(projectIndex);
  apiState.setProp('apiServers', servers);
}

// ===== Routes state =====

function getApiRoutes(projectIndex) {
  return apiState.get().apiRoutes.get(projectIndex) || [];
}

function setApiRoutes(projectIndex, routes) {
  const map = apiState.get().apiRoutes;
  map.set(projectIndex, routes);
  apiState.setProp('apiRoutes', map);
}

// ===== History state =====

function getApiHistory(projectIndex) {
  return apiState.get().apiHistory.get(projectIndex) || [];
}

function addApiHistoryEntry(projectIndex, entry) {
  const map = apiState.get().apiHistory;
  const current = map.get(projectIndex) || [];
  // Keep last 50 entries
  const updated = [entry, ...current].slice(0, 50);
  map.set(projectIndex, updated);
  apiState.setProp('apiHistory', map);
}

function clearApiHistory(projectIndex) {
  const map = apiState.get().apiHistory;
  map.set(projectIndex, []);
  apiState.setProp('apiHistory', map);
}

module.exports = {
  apiState,
  getApiServer,
  setApiServerStatus,
  setApiPort,
  setApiFramework,
  addApiLog,
  clearApiLogs,
  initApiServer,
  removeApiServer,
  getApiRoutes,
  setApiRoutes,
  getApiHistory,
  addApiHistoryEntry,
  clearApiHistory
};
