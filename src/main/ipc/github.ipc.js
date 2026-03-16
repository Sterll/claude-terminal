/**
 * GitHub IPC Handlers
 * Handles GitHub authentication IPC communication
 */

const { ipcMain, shell } = require('electron');
const GitHubAuthService = require('../services/GitHubAuthService');

// Store active polling sessions
const pollingSessions = new Map();

/**
 * Register GitHub IPC handlers
 */
function registerGitHubHandlers() {
  // Start device flow
  ipcMain.handle('github-start-auth', async () => {
    // console.log('[GitHub IPC] github-start-auth called');
    try {
      const deviceFlow = await GitHubAuthService.startDeviceFlow();
      // console.log('[GitHub IPC] Device flow started:', deviceFlow);
      return { success: true, ...deviceFlow };
    } catch (e) {
      console.error('[GitHub IPC] Error starting device flow:', e);
      return { success: false, error: e.message };
    }
  });

  // Open verification URL in browser
  ipcMain.handle('github-open-auth-url', async (event, url) => {
    shell.openExternal(url);
    return { success: true };
  });

  // Poll for token (runs in background)
  ipcMain.handle('github-poll-token', async (event, { deviceCode, interval }) => {
    try {
      const token = await GitHubAuthService.pollForToken(deviceCode, interval);
      await GitHubAuthService.setToken(token);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Get auth status
  ipcMain.handle('github-auth-status', async () => {
    try {
      const status = await GitHubAuthService.getAuthStatus();
      return { success: true, ...status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Logout
  ipcMain.handle('github-logout', async () => {
    try {
      await GitHubAuthService.deleteToken();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Set token manually (for PAT)
  ipcMain.handle('github-set-token', async (event, token) => {
    try {
      await GitHubAuthService.setToken(token);
      const status = await GitHubAuthService.getAuthStatus();
      return { success: true, ...status };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Get token for git operations
  ipcMain.handle('github-get-token', async () => {
    try {
      const token = await GitHubAuthService.getTokenForGit();
      return { success: true, token };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Get workflow runs for a repository
  ipcMain.handle('github-workflow-runs', async (event, { remoteUrl }) => {
    // console.log('[GitHub IPC] Fetching workflow runs for:', remoteUrl);
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      // console.log('[GitHub IPC] Parsed remote:', parsed);
      if (!parsed) {
        return { success: false, error: 'Not a GitHub repository' };
      }

      const result = await GitHubAuthService.getWorkflowRuns(parsed.owner, parsed.repo);
      // console.log('[GitHub IPC] Workflow runs result:', result);
      return { success: true, ...result, owner: parsed.owner, repo: parsed.repo };
    } catch (e) {
      console.error('[GitHub IPC] Error:', e);
      return { success: false, error: e.message };
    }
  });

  // Create a pull request
  ipcMain.handle('github-create-pr', async (event, { remoteUrl, title, body, head, base }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) {
        return { success: false, error: 'Not a GitHub repository' };
      }
      return await GitHubAuthService.createPullRequest(parsed.owner, parsed.repo, title, body, head, base);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Get jobs and steps for a specific workflow run
  ipcMain.handle('github-workflow-jobs', async (event, { remoteUrl, runId }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) return { success: false, error: 'Not a GitHub repository' };
      const result = await GitHubAuthService.getWorkflowJobs(parsed.owner, parsed.repo, runId);
      return { success: true, ...result };
    } catch (e) {
      console.error('[GitHub IPC] Error fetching workflow jobs:', e);
      return { success: false, error: e.message };
    }
  });

  // Get logs for a specific job
  ipcMain.handle('github-job-logs', async (event, { remoteUrl, jobId }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) return { success: false, error: 'Not a GitHub repository' };
      const result = await GitHubAuthService.getJobLogs(parsed.owner, parsed.repo, jobId);
      return { success: true, ...result };
    } catch (e) {
      console.error('[GitHub IPC] Error fetching job logs:', e);
      return { success: false, error: e.message };
    }
  });

  // Get pull requests for a repository (with pagination)
  ipcMain.handle('github-pull-requests', async (event, { remoteUrl, perPage, page, state }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) {
        return { success: false, error: 'Not a GitHub repository' };
      }

      const result = await GitHubAuthService.getPullRequests(parsed.owner, parsed.repo, perPage || 5, page || 1, state || 'all');
      return { success: true, ...result, owner: parsed.owner, repo: parsed.repo };
    } catch (e) {
      console.error('[GitHub IPC] Error:', e);
      return { success: false, error: e.message };
    }
  });

  // Get workflow runs with pagination
  ipcMain.handle('github-workflow-runs-paginated', async (event, { remoteUrl, perPage, page }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) return { success: false, error: 'Not a GitHub repository' };
      const result = await GitHubAuthService.getWorkflowRuns(parsed.owner, parsed.repo, perPage || 5, page || 1);
      return { success: true, ...result, owner: parsed.owner, repo: parsed.repo };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Get check runs (CI status) for a commit
  ipcMain.handle('github-check-runs', async (event, { remoteUrl, ref }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) return { success: false, error: 'Not a GitHub repository' };
      const result = await GitHubAuthService.getCheckRuns(parsed.owner, parsed.repo, ref);
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Merge a pull request
  ipcMain.handle('github-merge-pr', async (event, { remoteUrl, pullNumber, mergeMethod }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) return { success: false, error: 'Not a GitHub repository' };
      return await GitHubAuthService.mergePullRequest(parsed.owner, parsed.repo, pullNumber, mergeMethod);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Get issues
  ipcMain.handle('github-issues', async (event, { remoteUrl, perPage, page, state }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) return { success: false, error: 'Not a GitHub repository' };
      const result = await GitHubAuthService.getIssues(parsed.owner, parsed.repo, perPage || 10, page || 1, state || 'open');
      return { success: true, ...result, owner: parsed.owner, repo: parsed.repo };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Create issue
  ipcMain.handle('github-create-issue', async (event, { remoteUrl, title, body, labels }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) return { success: false, error: 'Not a GitHub repository' };
      return await GitHubAuthService.createIssue(parsed.owner, parsed.repo, title, body, labels);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Close issue
  ipcMain.handle('github-close-issue', async (event, { remoteUrl, issueNumber }) => {
    try {
      const parsed = GitHubAuthService.parseGitHubRemote(remoteUrl);
      if (!parsed) return { success: false, error: 'Not a GitHub repository' };
      return await GitHubAuthService.closeIssue(parsed.owner, parsed.repo, issueNumber);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { registerGitHubHandlers };
