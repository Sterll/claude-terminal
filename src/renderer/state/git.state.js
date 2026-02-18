/**
 * Git State Module
 * Manages git operations state (pull, push, merge, repo status)
 */

const { State } = require('./State');

// Initial state
const initialState = {
  gitOperations: new Map(), // projectId -> { pulling, pushing, lastResult }
  gitRepoStatus: new Map(), // projectId -> { isGitRepo }
  gitWorktrees: new Map() // projectId -> { worktrees[], isWorktree, mainRepoPath }
};

const gitState = new State(initialState);

// ========== Git Operations ==========

/**
 * Get git operation state
 * @param {string} projectId
 * @returns {Object}
 */
function getGitOperation(projectId) {
  return gitState.get().gitOperations.get(projectId) || {
    pulling: false,
    pushing: false,
    merging: false,
    mergeInProgress: false,
    conflicts: [],
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
  const ops = gitState.get().gitOperations;
  const current = ops.get(projectId) || { pulling: false, pushing: false, lastResult: null };
  ops.set(projectId, {
    ...current,
    pulling,
    lastResult: result !== null ? result : current.lastResult
  });
  gitState.setProp('gitOperations', ops);
}

/**
 * Set git push state
 * @param {string} projectId
 * @param {boolean} pushing
 * @param {Object|null} result
 */
function setGitPushing(projectId, pushing, result = null) {
  const ops = gitState.get().gitOperations;
  const current = ops.get(projectId) || { pulling: false, pushing: false, merging: false, mergeInProgress: false, conflicts: [], lastResult: null };
  ops.set(projectId, {
    ...current,
    pushing,
    lastResult: result !== null ? result : current.lastResult
  });
  gitState.setProp('gitOperations', ops);
}

/**
 * Set git merge state
 * @param {string} projectId
 * @param {boolean} merging
 * @param {Object|null} result
 */
function setGitMerging(projectId, merging, result = null) {
  const ops = gitState.get().gitOperations;
  const current = ops.get(projectId) || { pulling: false, pushing: false, merging: false, mergeInProgress: false, conflicts: [], lastResult: null };
  ops.set(projectId, {
    ...current,
    merging,
    mergeInProgress: result?.hasConflicts || false,
    conflicts: result?.conflicts || [],
    lastResult: result !== null ? result : current.lastResult
  });
  gitState.setProp('gitOperations', ops);
}

/**
 * Set merge in progress state (from pull with conflicts)
 * @param {string} projectId
 * @param {boolean} inProgress
 * @param {Array} conflicts
 */
function setMergeInProgress(projectId, inProgress, conflicts = []) {
  const ops = gitState.get().gitOperations;
  const current = ops.get(projectId) || { pulling: false, pushing: false, merging: false, mergeInProgress: false, conflicts: [], lastResult: null };
  ops.set(projectId, {
    ...current,
    mergeInProgress: inProgress,
    conflicts
  });
  gitState.setProp('gitOperations', ops);
}

// ========== Git Repo Status ==========

/**
 * Get git repo status
 * @param {string} projectId
 * @returns {Object}
 */
function getGitRepoStatus(projectId) {
  return gitState.get().gitRepoStatus.get(projectId) || { isGitRepo: false };
}

/**
 * Set git repo status
 * @param {string} projectId
 * @param {boolean} isGitRepo
 */
function setGitRepoStatus(projectId, isGitRepo) {
  const status = gitState.get().gitRepoStatus;
  status.set(projectId, { isGitRepo });
  gitState.setProp('gitRepoStatus', status);
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

// ========== Worktrees ==========

/**
 * Get worktree info for a project
 * @param {string} projectId
 * @returns {Object}
 */
function getWorktreeInfo(projectId) {
  return gitState.get().gitWorktrees.get(projectId) || {
    worktrees: [],
    isWorktree: false,
    mainRepoPath: null
  };
}

/**
 * Set worktree info for a project
 * @param {string} projectId
 * @param {Object} info
 */
function setWorktreeInfo(projectId, info) {
  const worktrees = new Map(gitState.get().gitWorktrees);
  worktrees.set(projectId, info);
  gitState.setProp('gitWorktrees', worktrees);
}

module.exports = {
  gitState,
  getGitOperation,
  setGitPulling,
  setGitPushing,
  setGitMerging,
  setMergeInProgress,
  getGitRepoStatus,
  setGitRepoStatus,
  checkAllProjectsGitStatus,
  getWorktreeInfo,
  setWorktreeInfo
};
