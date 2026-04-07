/**
 * Git IPC Handlers
 * Handles git-related IPC communication
 */

const { ipcMain } = require('electron');
const { execGit, getGitInfo, getGitInfoFull, getGitStatusQuick, getGitStatusDetailed, gitPull, gitPush, gitPushBranch, gitMerge, gitMergeAbort, gitMergeContinue, getMergeConflicts, isMergeInProgress, gitClone, gitStageFiles, gitCommit, getProjectStats, getBranches, getCurrentBranch, checkoutBranch, createBranch, deleteBranch, getCommitHistory, getFileDiff, getCommitDetail, cherryPick, revertCommit, gitUnstageFiles, stashApply, stashDrop, gitStashSave, getWorktrees, createWorktree, removeWorktree, lockWorktree, unlockWorktree, pruneWorktrees, detectWorktree, diffWorktreeBranches, diffWorktreeBranchesWithStats, deleteRemoteBranch, gitFetch, renameBranch, gitRebase, gitRebaseAbort, gitRebaseContinue, getFileHistory, getCommitFileDiffs, getCommitFileDiff, gitBlame, getTags, createTag, deleteTag, pushTag, pushAllTags, getRemotes, resolveConflict, getBranchOrphanCommitCount, gitDiscardFiles, stashPop, stashShow, gitAmendCommit, isRebaseInProgress, gitReset, searchCommitHistory, addRemote, removeRemote } = require('../utils/git');
const { generateCommitMessage, generateMultiCommitMessages, generateSessionRecap, groupFiles } = require('../utils/commitMessageGenerator');
const GitHubAuthService = require('../services/GitHubAuthService');
const { sendFeaturePing } = require('../services/TelemetryService');

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
    try {
      return await getGitInfo(projectPath);
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Get full git info for dashboard (comprehensive)
  ipcMain.handle('git-info-full', async (event, projectPath) => {
    try {
      return await getGitInfoFull(projectPath);
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Get project statistics (lines of code, etc.)
  ipcMain.handle('project-stats', async (event, projectPath) => {
    try {
      return await getProjectStats(projectPath);
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Git pull
  ipcMain.handle('git-pull', async (event, { projectPath }) => {
    try {
      sendFeaturePing('git:pull');
      return await gitPull(projectPath);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Git push
  ipcMain.handle('git-push', async (event, { projectPath }) => {
    try {
      sendFeaturePing('git:push');
      return await gitPush(projectPath);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Git push a specific branch to origin
  ipcMain.handle('git-push-branch', async (event, { projectPath, branch }) => {
    try {
      sendFeaturePing('git:push');
      return await gitPushBranch(projectPath, branch);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Git status (quick check)
  ipcMain.handle('git-status-quick', async (event, { projectPath }) => {
    try {
      return await getGitStatusQuick(projectPath);
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Get list of branches
  ipcMain.handle('git-branches', async (event, { projectPath }) => {
    try {
      return await getBranches(projectPath, { skipFetch: false });
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Get current branch
  ipcMain.handle('git-current-branch', async (event, { projectPath }) => {
    try {
      return await getCurrentBranch(projectPath);
    } catch (err) {
      return null;
    }
  });

  // Checkout branch
  ipcMain.handle('git-checkout', async (event, { projectPath, branch }) => {
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    try {
      return await checkoutBranch(projectPath, branch);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Git merge
  ipcMain.handle('git-merge', async (event, { projectPath, branch }) => {
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    try {
      return await gitMerge(projectPath, branch);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Git merge abort
  ipcMain.handle('git-merge-abort', async (event, { projectPath }) => {
    try {
      return await gitMergeAbort(projectPath);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Git merge continue
  ipcMain.handle('git-merge-continue', async (event, { projectPath }) => {
    try {
      return await gitMergeContinue(projectPath);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get merge conflicts
  ipcMain.handle('git-merge-conflicts', async (event, { projectPath }) => {
    try {
      return await getMergeConflicts(projectPath);
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Check if merge in progress
  ipcMain.handle('git-merge-in-progress', async (event, { projectPath }) => {
    try {
      return await isMergeInProgress(projectPath);
    } catch (err) {
      return false;
    }
  });

  // Resolve a merge conflict with ours/theirs strategy
  ipcMain.handle('git-resolve-conflict', async (event, { projectPath, filePath, strategy }) => {
    if (!filePath || typeof filePath !== 'string') return { success: false, error: 'Invalid file path' };
    if (strategy !== 'ours' && strategy !== 'theirs') return { success: false, error: 'Invalid strategy' };
    return resolveConflict(projectPath, filePath, strategy);
  });

  // Get orphan commit count for a branch
  ipcMain.handle('git-branch-orphan-commits', async (event, { projectPath, branch }) => {
    if (!isValidBranchName(branch)) return 0;
    return getBranchOrphanCommitCount(projectPath, branch);
  });

  // Git clone (auto-uses GitHub token if available)
  ipcMain.handle('git-clone', async (event, { repoUrl, targetPath }) => {
    // Validate URL scheme to prevent file:// or other dangerous protocols
    if (!repoUrl || typeof repoUrl !== 'string') return { success: false, error: 'Invalid repository URL' };
    const allowed = /^(https?:\/\/|git@[\w.-]+:)/i;
    if (!allowed.test(repoUrl.trim())) return { success: false, error: 'Only https:// and git@ URLs are allowed' };
    try {
      // Get GitHub token if available
      const token = await GitHubAuthService.getTokenForGit();
      return await gitClone(repoUrl, targetPath, { token });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Git status detailed (for changes panel)
  ipcMain.handle('git-status-detailed', async (event, { projectPath }) => {
    try {
      return await getGitStatusDetailed(projectPath);
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Stage specific files
  ipcMain.handle('git-stage-files', async (event, { projectPath, files }) => {
    try {
      return await gitStageFiles(projectPath, files);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Create commit
  ipcMain.handle('git-commit', async (event, { projectPath, message }) => {
    try {
      sendFeaturePing('git:commit');
      return await gitCommit(projectPath, message);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Create a new branch
  ipcMain.handle('git-create-branch', async (event, { projectPath, branch }) => {
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    try {
      return await createBranch(projectPath, branch);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Delete a branch
  ipcMain.handle('git-delete-branch', async (event, { projectPath, branch, force }) => {
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    try {
      return await deleteBranch(projectPath, branch, force);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Get paginated commit history
  ipcMain.handle('git-commit-history', async (event, { projectPath, skip, limit, branch, allBranches }) => {
    try {
      return await getCommitHistory(projectPath, { skip, limit, branch, allBranches });
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Get file diff
  ipcMain.handle('git-file-diff', async (event, { projectPath, filePath, staged }) => {
    try {
      return await getFileDiff(projectPath, filePath, staged);
    } catch (err) {
      return null;
    }
  });

  // Get commit detail
  ipcMain.handle('git-commit-detail', async (event, { projectPath, commitHash }) => {
    if (!isValidCommitHash(commitHash)) return '';
    try {
      return await getCommitDetail(projectPath, commitHash);
    } catch (err) {
      return '';
    }
  });

  // Cherry-pick a commit
  ipcMain.handle('git-cherry-pick', async (event, { projectPath, commitHash }) => {
    if (!isValidCommitHash(commitHash)) return { success: false, error: 'Invalid commit hash' };
    try {
      return await cherryPick(projectPath, commitHash);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Revert a commit
  ipcMain.handle('git-revert', async (event, { projectPath, commitHash }) => {
    if (!isValidCommitHash(commitHash)) return { success: false, error: 'Invalid commit hash' };
    try {
      return await revertCommit(projectPath, commitHash);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Unstage files
  ipcMain.handle('git-unstage-files', async (event, { projectPath, files }) => {
    try {
      return await gitUnstageFiles(projectPath, files);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Apply stash
  ipcMain.handle('git-stash-apply', async (event, { projectPath, stashRef }) => {
    if (!isValidStashRef(stashRef)) return { success: false, error: 'Invalid stash reference' };
    try {
      return await stashApply(projectPath, stashRef);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Drop stash
  ipcMain.handle('git-stash-drop', async (event, { projectPath, stashRef }) => {
    if (!isValidStashRef(stashRef)) return { success: false, error: 'Invalid stash reference' };
    try {
      return await stashDrop(projectPath, stashRef);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Save stash
  ipcMain.handle('git-stash-save', async (event, { projectPath, message }) => {
    try {
      return await gitStashSave(projectPath, message);
    } catch (err) {
      return { success: false, error: err.message };
    }
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

      // Untracked files: read first lines of each to give context (async I/O)
      await Promise.all(untrackedFiles.map(async (f) => {
        try {
          const fullPath = path.join(projectPath, f.path);
          const stat = await fs.promises.stat(fullPath);
          if (stat.isDirectory()) {
            diffParts.push(`--- New directory: ${f.path}/`);
          } else if (stat.size > 500000) {
            diffParts.push(`--- New file: ${f.path} (${(stat.size / 1024).toFixed(0)}KB, binary or large)`);
          } else {
            const content = (await fs.promises.readFile(fullPath, 'utf8')).slice(0, 3000);
            diffParts.push(`--- New file: ${f.path}\n+++ ${f.path}\n${content.split('\n').map(l => '+' + l).join('\n')}`);
          }
        } catch (_) {
          diffParts.push(`--- New file: ${f.path}`);
        }
      }));

      const diffContent = diffParts.join('\n\n');
      const githubToken = useAi !== false ? await GitHubAuthService.getToken() : null;
      const result = await generateCommitMessage(files, diffContent, githubToken);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Generate multi-commit messages (one per file group)
  ipcMain.handle('git-generate-multi-commit', async (event, { projectPath, files, useAi }) => {
    try {
      const path = require('path');
      const fs = require('fs');

      const groups = groupFiles(files);
      const diffs = {};

      for (const g of groups) {
        const diffParts = [];
        const tracked = g.files.filter(f => f.status !== '?');
        const untracked = g.files.filter(f => f.status === '?');

        if (tracked.length > 0) {
          const diff = await execGit(projectPath, ['diff', 'HEAD', '--', ...tracked.map(f => f.path)], 15000);
          if (diff) diffParts.push(diff);
        }

        await Promise.all(untracked.map(async (f) => {
          try {
            const fullPath = path.join(projectPath, f.path);
            const stat = await fs.promises.stat(fullPath);
            if (stat.isDirectory()) {
              diffParts.push(`--- New directory: ${f.path}/`);
            } else if (stat.size > 500000) {
              diffParts.push(`--- New file: ${f.path} (${(stat.size / 1024).toFixed(0)}KB)`);
            } else {
              const content = (await fs.promises.readFile(fullPath, 'utf8')).slice(0, 3000);
              diffParts.push(`--- New file: ${f.path}\n${content.split('\n').map(l => '+' + l).join('\n')}`);
            }
          } catch (_) {
            diffParts.push(`--- New file: ${f.path}`);
          }
        }));

        diffs[g.name] = diffParts.join('\n\n');
      }

      const githubToken = useAi !== false ? await GitHubAuthService.getToken() : null;
      const results = await generateMultiCommitMessages(files, diffs, githubToken);
      return { success: true, commits: results };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Generate session recap via GitHub Models API
  ipcMain.handle('git-generate-session-recap', async (_event, context) => {
    try {
      const githubToken = await GitHubAuthService.getToken();
      return await generateSessionRecap(context, githubToken);
    } catch (e) {
      return { summary: null, source: 'error' };
    }
  });

  // ========== WORKTREES ==========

  // List worktrees
  ipcMain.handle('git-worktree-list', async (event, { projectPath }) => {
    try {
      const worktrees = await getWorktrees(projectPath);
      return { success: true, worktrees };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Create worktree
  ipcMain.handle('git-worktree-create', async (event, { projectPath, worktreePath, branch, newBranch, startPoint }) => {
    try {
      sendFeaturePing('worktree:create');
      return await createWorktree(projectPath, worktreePath, { branch, newBranch, startPoint });
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Remove worktree
  ipcMain.handle('git-worktree-remove', async (event, { projectPath, worktreePath, force }) => {
    try {
      return await removeWorktree(projectPath, worktreePath, force);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Lock worktree
  ipcMain.handle('git-worktree-lock', async (event, { projectPath, worktreePath, reason }) => {
    try {
      return await lockWorktree(projectPath, worktreePath, reason);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Unlock worktree
  ipcMain.handle('git-worktree-unlock', async (event, { projectPath, worktreePath }) => {
    try {
      return await unlockWorktree(projectPath, worktreePath);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Prune stale worktrees
  ipcMain.handle('git-worktree-prune', async (event, { projectPath }) => {
    try {
      return await pruneWorktrees(projectPath);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Detect if path is a worktree
  ipcMain.handle('git-worktree-detect', async (event, { projectPath }) => {
    try {
      return await detectWorktree(projectPath);
    } catch (err) {
      return { isWorktree: false };
    }
  });

  // Diff between worktree branches
  ipcMain.handle('git-worktree-diff', async (event, { projectPath, branch1, branch2, filePath }) => {
    try {
      const diff = await diffWorktreeBranches(projectPath, branch1, branch2, filePath);
      return { success: true, diff };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Diff stats (file list with status, additions, deletions) between worktree branches
  ipcMain.handle('git-worktree-diff-stats', async (event, { projectPath, branch1, branch2 }) => {
    try {
      const files = await diffWorktreeBranchesWithStats(projectPath, branch1, branch2);
      return { success: true, files };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── New git operations ──

  ipcMain.handle('git-delete-remote-branch', async (event, { projectPath, branch, remote }) => {
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    try {
      await deleteRemoteBranch(projectPath, branch, remote);
      sendFeaturePing('git_delete_remote_branch');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-fetch', async (event, { projectPath, remote }) => {
    try {
      await gitFetch(projectPath, remote);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-rename-branch', async (event, { projectPath, oldName, newName }) => {
    if (!isValidBranchName(oldName) || !isValidBranchName(newName)) return { success: false, error: 'Invalid branch name' };
    try {
      await renameBranch(projectPath, oldName, newName);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-rebase', async (event, { projectPath, branch }) => {
    if (!isValidBranchName(branch)) return { success: false, error: 'Invalid branch name' };
    try {
      const output = await gitRebase(projectPath, branch);
      sendFeaturePing('git_rebase');
      return { success: true, output };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-rebase-abort', async (event, { projectPath }) => {
    try {
      await gitRebaseAbort(projectPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-rebase-continue', async (event, { projectPath }) => {
    try {
      await gitRebaseContinue(projectPath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-file-history', async (event, { projectPath, filePath, skip, limit }) => {
    try {
      const commits = await getFileHistory(projectPath, filePath, { skip, limit });
      return { success: true, commits };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-commit-file-diffs', async (event, { projectPath, commitHash }) => {
    if (!isValidCommitHash(commitHash)) return { success: false, error: 'Invalid commit hash' };
    try {
      const files = await getCommitFileDiffs(projectPath, commitHash);
      return { success: true, files };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-commit-file-diff', async (event, { projectPath, commitHash, filePath }) => {
    if (!isValidCommitHash(commitHash)) return { success: false, error: 'Invalid commit hash' };
    try {
      const diff = await getCommitFileDiff(projectPath, commitHash, filePath);
      return { success: true, diff };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-blame', async (event, { projectPath, filePath }) => {
    try {
      const lines = await gitBlame(projectPath, filePath);
      return { success: true, lines };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-tag-list', async (event, { projectPath }) => {
    try {
      const tags = await getTags(projectPath);
      return { success: true, tags };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-tag-create', async (event, { projectPath, name, message, commitHash }) => {
    try {
      await createTag(projectPath, name, message, commitHash);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-tag-delete', async (event, { projectPath, name }) => {
    try {
      await deleteTag(projectPath, name);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-tag-push', async (event, { projectPath, name, remote }) => {
    try {
      if (name) {
        await pushTag(projectPath, name, remote);
      } else {
        await pushAllTags(projectPath, remote);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('git-remotes', async (event, { projectPath }) => {
    try {
      const remotes = await getRemotes(projectPath);
      return { success: true, remotes };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ── New git features ──

  // Discard file changes (git restore / clean)
  ipcMain.handle('git-discard-files', async (event, { projectPath, files }) => {
    if (!Array.isArray(files) || files.length === 0) return { success: false, error: 'No files specified' };
    try {
      sendFeaturePing('git:discard');
      return await gitDiscardFiles(projectPath, files);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Stash pop (atomic apply + drop)
  ipcMain.handle('git-stash-pop', async (event, { projectPath, stashRef }) => {
    if (!isValidStashRef(stashRef)) return { success: false, error: 'Invalid stash reference' };
    try {
      return await stashPop(projectPath, stashRef);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Stash show/preview
  ipcMain.handle('git-stash-show', async (event, { projectPath, stashRef }) => {
    if (!isValidStashRef(stashRef)) return { success: false, error: 'Invalid stash reference' };
    try {
      const diff = await stashShow(projectPath, stashRef);
      return { success: true, diff };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Amend last commit
  ipcMain.handle('git-commit-amend', async (event, { projectPath, message }) => {
    try {
      sendFeaturePing('git:amend');
      return await gitAmendCommit(projectPath, message);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Check if rebase in progress
  ipcMain.handle('git-rebase-in-progress', async (event, { projectPath }) => {
    try {
      return await isRebaseInProgress(projectPath);
    } catch (err) {
      return false;
    }
  });

  // Git reset
  ipcMain.handle('git-reset', async (event, { projectPath, mode, target }) => {
    const allowedModes = ['soft', 'mixed', 'hard'];
    if (mode && !allowedModes.includes(mode)) return { success: false, error: 'Invalid reset mode' };
    try {
      sendFeaturePing('git:reset');
      return await gitReset(projectPath, mode || 'soft', target || 'HEAD~1');
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Search commit history
  ipcMain.handle('git-search-history', async (event, { projectPath, grep, pickaxe, skip, limit, branch, allBranches }) => {
    try {
      return await searchCommitHistory(projectPath, { grep, pickaxe, skip, limit, branch, allBranches });
    } catch (err) {
      return { error: true, message: err.message };
    }
  });

  // Add remote
  ipcMain.handle('git-remote-add', async (event, { projectPath, name, url }) => {
    if (!name || typeof name !== 'string') return { success: false, error: 'Invalid remote name' };
    if (!url || typeof url !== 'string') return { success: false, error: 'Invalid remote URL' };
    try {
      return await addRemote(projectPath, name, url);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Remove remote
  ipcMain.handle('git-remote-remove', async (event, { projectPath, name }) => {
    if (!name || typeof name !== 'string') return { success: false, error: 'Invalid remote name' };
    try {
      return await removeRemote(projectPath, name);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { registerGitHandlers };
