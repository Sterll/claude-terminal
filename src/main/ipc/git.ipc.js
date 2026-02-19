/**
 * Git IPC Handlers
 * Handles git-related IPC communication
 */

const { ipcMain } = require('electron');
const { execGit, getGitInfo, getGitInfoFull, getGitStatusQuick, getGitStatusDetailed, gitPull, gitPush, gitMerge, gitMergeAbort, gitMergeContinue, getMergeConflicts, isMergeInProgress, gitClone, gitStageFiles, gitCommit, getProjectStats, getBranches, getCurrentBranch, checkoutBranch, createBranch, deleteBranch, getCommitHistory, getFileDiff, getCommitDetail, cherryPick, revertCommit, gitUnstageFiles, stashApply, stashDrop, gitStashSave, getWorktrees, createWorktree, removeWorktree, lockWorktree, unlockWorktree, pruneWorktrees, detectWorktree, diffWorktreeBranches } = require('../utils/git');
const { generateCommitMessage } = require('../utils/commitMessageGenerator');
const GitHubAuthService = require('../services/GitHubAuthService');

// Input validators
const isValidCommitHash = (h) => typeof h === 'string' && /^[a-f0-9]{4,64}$/i.test(h);
const isValidBranchName = (b) => typeof b === 'string' && b.length > 0 && b.length < 256 && !/[^a-zA-Z0-9._\-\/]/.test(b) && !b.includes('..');
const isValidStashRef = (r) => typeof r === 'string' && /^stash@\{\d+\}$/.test(r);

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
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    return checkoutBranch(projectPath, branch);
  });

  // Git merge
  ipcMain.handle('git-merge', async (event, { projectPath, branch }) => {
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
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
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    return createBranch(projectPath, branch);
  });

  // Delete a branch
  ipcMain.handle('git-delete-branch', async (event, { projectPath, branch, force }) => {
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    return deleteBranch(projectPath, branch, force);
  });

  // Get paginated commit history
  ipcMain.handle('git-commit-history', async (event, { projectPath, skip, limit, branch, allBranches }) => {
    return getCommitHistory(projectPath, { skip, limit, branch, allBranches });
  });

  // Get file diff
  ipcMain.handle('git-file-diff', async (event, { projectPath, filePath, staged }) => {
    return getFileDiff(projectPath, filePath, staged);
  });

  // Get commit detail
  ipcMain.handle('git-commit-detail', async (event, { projectPath, commitHash }) => {
    if (!isValidCommitHash(commitHash)) return '';
    return getCommitDetail(projectPath, commitHash);
  });

  // Cherry-pick a commit
  ipcMain.handle('git-cherry-pick', async (event, { projectPath, commitHash }) => {
    if (!isValidCommitHash(commitHash)) return { success: false, error: 'Invalid commit hash' };
    return cherryPick(projectPath, commitHash);
  });

  // Revert a commit
  ipcMain.handle('git-revert', async (event, { projectPath, commitHash }) => {
    if (!isValidCommitHash(commitHash)) return { success: false, error: 'Invalid commit hash' };
    return revertCommit(projectPath, commitHash);
  });

  // Unstage files
  ipcMain.handle('git-unstage-files', async (event, { projectPath, files }) => {
    return gitUnstageFiles(projectPath, files);
  });

  // Apply stash
  ipcMain.handle('git-stash-apply', async (event, { projectPath, stashRef }) => {
    if (!isValidStashRef(stashRef)) return { success: false, error: 'Invalid stash reference' };
    return stashApply(projectPath, stashRef);
  });

  // Drop stash
  ipcMain.handle('git-stash-drop', async (event, { projectPath, stashRef }) => {
    if (!isValidStashRef(stashRef)) return { success: false, error: 'Invalid stash reference' };
    return stashDrop(projectPath, stashRef);
  });

  // Save stash
  ipcMain.handle('git-stash-save', async (event, { projectPath, message }) => {
    return gitStashSave(projectPath, message);
  });

  // Generate commit message from file statuses and diff
  ipcMain.handle('git-generate-commit-message', async (event, { projectPath, files, useAi }) => {
    try {
      const path = require('path');
      const fs = require('fs');

      // Build diff context for each file based on its status
      const diffParts = [];

      const trackedFiles = files.filter(f => f.status !== '?');
      const untrackedFiles = files.filter(f => f.status === '?');

      // Tracked files: git diff HEAD
      if (trackedFiles.length > 0) {
        const diff = await execGit(projectPath, ['diff', 'HEAD', '--', ...trackedFiles.map(f => f.path)], 15000);
        if (diff) diffParts.push(diff);
      }

      // Untracked files: read first lines of each to give context
      for (const f of untrackedFiles) {
        try {
          const fullPath = path.join(projectPath, f.path);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            diffParts.push(`--- New directory: ${f.path}/`);
          } else if (stat.size > 500000) {
            diffParts.push(`--- New file: ${f.path} (${(stat.size / 1024).toFixed(0)}KB, binary or large)`);
          } else {
            const content = fs.readFileSync(fullPath, 'utf8').slice(0, 3000);
            diffParts.push(`--- New file: ${f.path}\n+++ ${f.path}\n${content.split('\n').map(l => '+' + l).join('\n')}`);
          }
        } catch (_) {
          diffParts.push(`--- New file: ${f.path}`);
        }
      }

      const diffContent = diffParts.join('\n\n');
      const githubToken = useAi !== false ? await GitHubAuthService.getToken() : null;
      const result = await generateCommitMessage(files, diffContent, githubToken);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  // ========== WORKTREES ==========

  // List worktrees
  ipcMain.handle('git-worktree-list', async (event, { projectPath }) => {
    const worktrees = await getWorktrees(projectPath);
    return { success: true, worktrees };
  });

  // Create worktree
  ipcMain.handle('git-worktree-create', async (event, { projectPath, worktreePath, branch, newBranch, startPoint }) => {
    return createWorktree(projectPath, worktreePath, { branch, newBranch, startPoint });
  });

  // Remove worktree
  ipcMain.handle('git-worktree-remove', async (event, { projectPath, worktreePath, force }) => {
    return removeWorktree(projectPath, worktreePath, force);
  });

  // Lock worktree
  ipcMain.handle('git-worktree-lock', async (event, { projectPath, worktreePath, reason }) => {
    return lockWorktree(projectPath, worktreePath, reason);
  });

  // Unlock worktree
  ipcMain.handle('git-worktree-unlock', async (event, { projectPath, worktreePath }) => {
    return unlockWorktree(projectPath, worktreePath);
  });

  // Prune stale worktrees
  ipcMain.handle('git-worktree-prune', async (event, { projectPath }) => {
    return pruneWorktrees(projectPath);
  });

  // Detect if path is a worktree
  ipcMain.handle('git-worktree-detect', async (event, { projectPath }) => {
    return detectWorktree(projectPath);
  });

  // Diff between worktree branches
  ipcMain.handle('git-worktree-diff', async (event, { projectPath, branch1, branch2, filePath }) => {
    const diff = await diffWorktreeBranches(projectPath, branch1, branch2, filePath);
    return { success: true, diff };
  });
}

module.exports = { registerGitHandlers };
