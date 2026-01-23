/**
 * FiveM State Module
 * Manages FiveM servers and git operations state
 */

const { State } = require('./State');

// Initial state
const initialState = {
  fivemServers: new Map(), // projectIndex -> { status, logs[] }
  fivemErrors: new Map(), // projectIndex -> { errors: [{ timestamp, message, context }], lastError: null }
  gitOperations: new Map(), // projectId -> { pulling, pushing, lastResult }
  gitRepoStatus: new Map() // projectId -> { isGitRepo }
};

const fivemState = new State(initialState);

// ========== FiveM Servers ==========

/**
 * Get FiveM server state
 * @param {number} projectIndex
 * @returns {Object}
 */
function getFivemServer(projectIndex) {
  return fivemState.get().fivemServers.get(projectIndex) || {
    status: 'stopped',
    logs: []
  };
}

/**
 * Set FiveM server status
 * @param {number} projectIndex
 * @param {string} status - 'stopped', 'starting', 'running'
 */
function setFivemServerStatus(projectIndex, status) {
  const servers = fivemState.get().fivemServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [] };
  servers.set(projectIndex, { ...current, status });
  fivemState.setProp('fivemServers', servers);
}

/**
 * Add log to FiveM server
 * @param {number} projectIndex
 * @param {string} data
 */
function addFivemLog(projectIndex, data) {
  const servers = fivemState.get().fivemServers;
  const current = servers.get(projectIndex) || { status: 'stopped', logs: [] };
  const logs = [...current.logs, data];

  // Keep last 10000 characters
  let combinedLogs = logs.join('');
  if (combinedLogs.length > 10000) {
    combinedLogs = combinedLogs.slice(-10000);
  }

  servers.set(projectIndex, {
    ...current,
    logs: [combinedLogs]
  });
  fivemState.setProp('fivemServers', servers);
}

/**
 * Clear FiveM server logs
 * @param {number} projectIndex
 */
function clearFivemLogs(projectIndex) {
  const servers = fivemState.get().fivemServers;
  const current = servers.get(projectIndex);
  if (current) {
    servers.set(projectIndex, { ...current, logs: [] });
    fivemState.setProp('fivemServers', servers);
  }
}

/**
 * Initialize FiveM server tracking
 * @param {number} projectIndex
 */
function initFivemServer(projectIndex) {
  const servers = fivemState.get().fivemServers;
  if (!servers.has(projectIndex)) {
    servers.set(projectIndex, { status: 'stopped', logs: [] });
    fivemState.setProp('fivemServers', servers);
  }
}

/**
 * Remove FiveM server tracking
 * @param {number} projectIndex
 */
function removeFivemServer(projectIndex) {
  const servers = fivemState.get().fivemServers;
  servers.delete(projectIndex);
  fivemState.setProp('fivemServers', servers);
}

// ========== FiveM Errors ==========

// Error patterns for FiveM/Lua
const FIVEM_ERROR_PATTERNS = [
  /SCRIPT ERROR:/i,
  /Error loading script/i,
  /Error running/i,
  /stack traceback:/i,
  /attempt to call/i,
  /attempt to index/i,
  /attempt to compare/i,
  /attempt to concatenate/i,
  /attempt to perform arithmetic/i,
  /bad argument/i,
  /module .* not found/i,
  /syntax error/i,
  /unexpected symbol/i,
  /FATAL ERROR/i,
  /\[ERROR\]/i,
  /lua_run failed/i
];

/**
 * Check if text contains a FiveM error
 * @param {string} text
 * @returns {boolean}
 */
function containsFivemError(text) {
  return FIVEM_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Get FiveM errors for a project
 * @param {number} projectIndex
 * @returns {Object}
 */
function getFivemErrors(projectIndex) {
  return fivemState.get().fivemErrors.get(projectIndex) || {
    errors: [],
    lastError: null
  };
}

/**
 * Add a FiveM error
 * @param {number} projectIndex
 * @param {string} errorMessage - The error message
 * @param {string} context - Surrounding context (previous lines)
 */
function addFivemError(projectIndex, errorMessage, context) {
  const errorsMap = fivemState.get().fivemErrors;
  const current = errorsMap.get(projectIndex) || { errors: [], lastError: null };

  const newError = {
    timestamp: Date.now(),
    message: errorMessage,
    context: context
  };

  // Keep last 10 errors
  const errors = [...current.errors, newError].slice(-10);

  errorsMap.set(projectIndex, {
    errors,
    lastError: newError
  });

  fivemState.setProp('fivemErrors', errorsMap);

  return newError;
}

/**
 * Clear FiveM errors for a project
 * @param {number} projectIndex
 */
function clearFivemErrors(projectIndex) {
  const errorsMap = fivemState.get().fivemErrors;
  errorsMap.set(projectIndex, { errors: [], lastError: null });
  fivemState.setProp('fivemErrors', errorsMap);
}

/**
 * Dismiss the last error (hide the debug button)
 * @param {number} projectIndex
 */
function dismissLastError(projectIndex) {
  const errorsMap = fivemState.get().fivemErrors;
  const current = errorsMap.get(projectIndex);
  if (current) {
    errorsMap.set(projectIndex, { ...current, lastError: null });
    fivemState.setProp('fivemErrors', errorsMap);
  }
}

// ========== Git Operations ==========

/**
 * Get git operation state
 * @param {string} projectId
 * @returns {Object}
 */
function getGitOperation(projectId) {
  return fivemState.get().gitOperations.get(projectId) || {
    pulling: false,
    pushing: false,
    lastResult: null
  };
}

/**
 * Set git pull state
 * @param {string} projectId
 * @param {boolean} pulling
 * @param {Object|null} result
 */
function setGitPulling(projectId, pulling, result = null) {
  const ops = fivemState.get().gitOperations;
  const current = ops.get(projectId) || { pulling: false, pushing: false, lastResult: null };
  ops.set(projectId, {
    ...current,
    pulling,
    lastResult: result !== null ? result : current.lastResult
  });
  fivemState.setProp('gitOperations', ops);
}

/**
 * Set git push state
 * @param {string} projectId
 * @param {boolean} pushing
 * @param {Object|null} result
 */
function setGitPushing(projectId, pushing, result = null) {
  const ops = fivemState.get().gitOperations;
  const current = ops.get(projectId) || { pulling: false, pushing: false, lastResult: null };
  ops.set(projectId, {
    ...current,
    pushing,
    lastResult: result !== null ? result : current.lastResult
  });
  fivemState.setProp('gitOperations', ops);
}

// ========== Git Repo Status ==========

/**
 * Get git repo status
 * @param {string} projectId
 * @returns {Object}
 */
function getGitRepoStatus(projectId) {
  return fivemState.get().gitRepoStatus.get(projectId) || { isGitRepo: false };
}

/**
 * Set git repo status
 * @param {string} projectId
 * @param {boolean} isGitRepo
 */
function setGitRepoStatus(projectId, isGitRepo) {
  const status = fivemState.get().gitRepoStatus;
  status.set(projectId, { isGitRepo });
  fivemState.setProp('gitRepoStatus', status);
}

/**
 * Check all projects git status
 * @param {Array} projects
 * @param {Function} checkFn - Async function to check git status
 */
async function checkAllProjectsGitStatus(projects, checkFn) {
  for (const project of projects) {
    try {
      const result = await checkFn(project.path);
      setGitRepoStatus(project.id, result.isGitRepo);
    } catch (e) {
      setGitRepoStatus(project.id, false);
    }
  }
}

module.exports = {
  fivemState,
  getFivemServer,
  setFivemServerStatus,
  addFivemLog,
  clearFivemLogs,
  initFivemServer,
  removeFivemServer,
  // FiveM errors
  containsFivemError,
  getFivemErrors,
  addFivemError,
  clearFivemErrors,
  dismissLastError,
  // Git operations
  getGitOperation,
  setGitPulling,
  setGitPushing,
  getGitRepoStatus,
  setGitRepoStatus,
  checkAllProjectsGitStatus
};
