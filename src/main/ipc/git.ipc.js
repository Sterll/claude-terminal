/**
 * Git IPC Handlers
 * Handles git-related IPC communication
 */

const { ipcMain } = require('electron');
const { execGit, getGitInfo, getGitInfoFull, getGitStatusQuick, getGitStatusDetailed, gitPull, gitPush, gitMerge, gitMergeAbort, gitMergeContinue, getMergeConflicts, isMergeInProgress, gitClone, gitStageFiles, gitCommit, getProjectStats, getBranches, getCurrentBranch, checkoutBranch, createBranch, deleteBranch, getCommitHistory, getFileDiff, getCommitDetail, cherryPick, revertCommit, gitUnstageFiles, stashApply, stashDrop, gitStashSave } = require('../utils/git');
const { generateCommitMessage } = require('../utils/commitMessageGenerator');
const GitHubAuthService = require('../services/GitHubAuthService');

/**
 * Register git IPC handlers
 */
function registerGitHandlers() {
  // Get git info for dashboard (basic)
  ipcMain.handle('git-info', async (event, projectPath) => {
    return getGitInfo(projectPath);
  });

  // Get full git info for dashboard (comprehensive)
  ipcMain.handle('git-info-full', async (event, projectPath) => {
    return getGitInfoFull(projectPath);
  });

  // Get project statistics (lines of code, etc.)
  ipcMain.handle('project-stats', async (event, projectPath) => {
    return getProjectStats(projectPath);
  });

  // Git pull
  ipcMain.handle('git-pull', async (event, { projectPath }) => {
    return gitPull(projectPath);
  });

  // Git push
  ipcMain.handle('git-push', async (event, { projectPath }) => {
    return gitPush(projectPath);
  });

  // Git status (quick check)
  ipcMain.handle('git-status-quick', async (event, { projectPath }) => {
    return getGitStatusQuick(projectPath);
  });

  // Get list of branches
  ipcMain.handle('git-branches', async (event, { projectPath }) => {
    return getBranches(projectPath, { skipFetch: false });
  });

  // Get current branch
  ipcMain.handle('git-current-branch', async (event, { projectPath }) => {
    return getCurrentBranch(projectPath);
  });

  // Checkout branch
  ipcMain.handle('git-checkout', async (event, { projectPath, branch }) => {
    return checkoutBranch(projectPath, branch);
  });

  // Git merge
  ipcMain.handle('git-merge', async (event, { projectPath, branch }) => {
    return gitMerge(projectPath, branch);
  });

  // Git merge abort
  ipcMain.handle('git-merge-abort', async (event, { projectPath }) => {
    return gitMergeAbort(projectPath);
  });

  // Git merge continue
  ipcMain.handle('git-merge-continue', async (event, { projectPath }) => {
    return gitMergeContinue(projectPath);
  });

  // Get merge conflicts
  ipcMain.handle('git-merge-conflicts', async (event, { projectPath }) => {
    return getMergeConflicts(projectPath);
  });

  // Check if merge in progress
  ipcMain.handle('git-merge-in-progress', async (event, { projectPath }) => {
    return isMergeInProgress(projectPath);
  });

  // Git clone (auto-uses GitHub token if available)
  ipcMain.handle('git-clone', async (event, { repoUrl, targetPath }) => {
    // Get GitHub token if available
    const token = await GitHubAuthService.getTokenForGit();
    return gitClone(repoUrl, targetPath, { token });
  });

  // Git status detailed (for changes panel)
  ipcMain.handle('git-status-detailed', async (event, { projectPath }) => {
    return getGitStatusDetailed(projectPath);
  });

  // Stage specific files
  ipcMain.handle('git-stage-files', async (event, { projectPath, files }) => {
    return gitStageFiles(projectPath, files);
  });

  // Create commit
  ipcMain.handle('git-commit', async (event, { projectPath, message }) => {
    return gitCommit(projectPath, message);
  });

  // Create a new branch
  ipcMain.handle('git-create-branch', async (event, { projectPath, branch }) => {
    return createBranch(projectPath, branch);
  });

  // Delete a branch
  ipcMain.handle('git-delete-branch', async (event, { projectPath, branch, force }) => {
    return deleteBranch(projectPath, branch, force);
  });

  // Get paginated commit history
  ipcMain.handle('git-commit-history', async (event, { projectPath, skip, limit, branch }) => {
    return getCommitHistory(projectPath, { skip, limit, branch });
  });

  // Get file diff
  ipcMain.handle('git-file-diff', async (event, { projectPath, filePath, staged }) => {
    return getFileDiff(projectPath, filePath, staged);
  });

  // Get commit detail
  ipcMain.handle('git-commit-detail', async (event, { projectPath, commitHash }) => {
    return getCommitDetail(projectPath, commitHash);
  });

  // Cherry-pick a commit
  ipcMain.handle('git-cherry-pick', async (event, { projectPath, commitHash }) => {
    return cherryPick(projectPath, commitHash);
  });

  // Revert a commit
  ipcMain.handle('git-revert', async (event, { projectPath, commitHash }) => {
    return revertCommit(projectPath, commitHash);
  });

  // Unstage files
  ipcMain.handle('git-unstage-files', async (event, { projectPath, files }) => {
    return gitUnstageFiles(projectPath, files);
  });

  // Apply stash
  ipcMain.handle('git-stash-apply', async (event, { projectPath, stashRef }) => {
    return stashApply(projectPath, stashRef);
  });

  // Drop stash
  ipcMain.handle('git-stash-drop', async (event, { projectPath, stashRef }) => {
    return stashDrop(projectPath, stashRef);
  });

  // Save stash
  ipcMain.handle('git-stash-save', async (event, { projectPath, message }) => {
    return gitStashSave(projectPath, message);
  });

  // Generate commit message from file statuses and diff
  ipcMain.handle('git-generate-commit-message', async (event, { projectPath, files }) => {
    try {
      // Get diff content for the selected files
      const filePaths = files.map(f => `"${f.path}"`).join(' ');
      const diffContent = await execGit(projectPath, `diff HEAD -- ${filePaths}`, 15000) || '';

      const result = await generateCommitMessage(files, diffContent);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerGitHandlers };
