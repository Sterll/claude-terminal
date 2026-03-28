/**
 * GitHub Authentication Service
 * Handles OAuth Device Flow and token management
 */

const keytar = require('keytar');
const https = require('https');
const { BrowserWindow } = require('electron');

const SERVICE_NAME = 'claude-terminal';
const ACCOUNT_NAME = 'github-token';

// GitHub OAuth App Client ID (public, not a secret for device flow)
// Users can also use their own or a PAT
const GITHUB_CLIENT_ID = 'Ov23liYfl42qwDVVk99l';

// GitHub Enterprise configurable hostnames
let config = {
  apiHostname: 'api.github.com',
  webHostname: 'github.com',
};

// Rate limit state (updated from every API response)
const rateLimitState = {
  remaining: null,
  limit: null,
  reset: null, // Unix timestamp (seconds)
};

function notifyRateLimitUpdate() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('github-rate-limit-update', rateLimitState);
      }
    }
  } catch (e) {
    // Ignore errors during shutdown
  }
}

function getRateLimitState() {
  return { ...rateLimitState };
}

function configure(newConfig) {
  if (newConfig.githubApiUrl) {
    try {
      const url = new URL(newConfig.githubApiUrl);
      config.apiHostname = url.hostname;
    } catch (e) {
      console.error('[GitHubAuth] Invalid API URL:', newConfig.githubApiUrl);
    }
  }
  if (newConfig.githubHostname) {
    config.webHostname = newConfig.githubHostname;
  }
}

/**
 * Make an HTTPS request (follows redirects)
 */
// ETag cache for conditional requests (304 Not Modified = free, no API quota)
const etagCache = new Map();

function httpsRequest(options, postData = null, maxRedirects = 3) {
  const timeout = options.timeout || 15000;

  // Rate limit guard: reject early if quota exhausted
  if (rateLimitState.remaining === 0 && rateLimitState.reset) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < rateLimitState.reset) {
      const resetDate = new Date(rateLimitState.reset * 1000);
      const resetTime = resetDate.toLocaleTimeString();
      return Promise.reject(new Error(`GitHub API rate limit exhausted. Resets at ${resetTime}.`));
    }
  }

  // Inject ETag for conditional requests if available
  const cacheKey = options.etagKey;
  if (cacheKey && etagCache.has(cacheKey)) {
    const cached = etagCache.get(cacheKey);
    options.headers = { ...options.headers, 'If-None-Match': cached.etag };
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      // 304 Not Modified: return cached data (no API quota consumed)
      if (res.statusCode === 304 && cacheKey && etagCache.has(cacheKey)) {
        res.resume(); // drain the response
        return resolve({ status: 200, data: etagCache.get(cacheKey).data, cached: true });
      }

      // Handle redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && maxRedirects > 0) {
        const redirectUrl = new URL(res.headers.location);
        const newOptions = {
          ...options,
          hostname: redirectUrl.hostname,
          path: redirectUrl.pathname + redirectUrl.search,
        };
        // Strip Authorization header on cross-origin redirects to prevent token leakage
        if (redirectUrl.hostname !== options.hostname) {
          const { Authorization, authorization, ...safeHeaders } = newOptions.headers || {};
          newOptions.headers = safeHeaders;
        }
        return httpsRequest(newOptions, postData, maxRedirects - 1).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Track rate limit from response headers
        const rlRemaining = res.headers['x-ratelimit-remaining'];
        const rlLimit = res.headers['x-ratelimit-limit'];
        const rlReset = res.headers['x-ratelimit-reset'];
        if (rlRemaining !== undefined) {
          const prev = rateLimitState.remaining;
          rateLimitState.remaining = parseInt(rlRemaining, 10);
          rateLimitState.limit = parseInt(rlLimit, 10);
          rateLimitState.reset = parseInt(rlReset, 10);
          // Notify renderer when remaining changes significantly (< 10 or every 10 calls)
          if (prev !== rateLimitState.remaining && (rateLimitState.remaining < 10 || rateLimitState.remaining % 10 === 0)) {
            notifyRateLimitUpdate();
          }
        }

        // Raw text mode: skip JSON parsing (used for log downloads)
        if (options.rawText) {
          return resolve({ status: res.statusCode, data });
        }
        try {
          const parsed = JSON.parse(data);
          // Store ETag for future conditional requests
          if (cacheKey && res.headers.etag) {
            etagCache.set(cacheKey, { etag: res.headers.etag, data: parsed });
          }
          resolve({ status: res.statusCode, data: parsed });
        } catch (e) {
          // Parse as form-urlencoded if JSON fails
          const parsed = {};
          data.split('&').forEach(pair => {
            const [key, value] = pair.split('=');
            parsed[decodeURIComponent(key)] = decodeURIComponent(value || '');
          });
          resolve({ status: res.statusCode, data: parsed });
        }
      });
    });
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeout}ms`));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Start the GitHub Device Flow
 * @returns {Promise<Object>} - { device_code, user_code, verification_uri, expires_in, interval }
 */
async function startDeviceFlow() {
  const postData = `client_id=${GITHUB_CLIENT_ID}&scope=repo,workflow`;

  console.debug('[GitHubAuth] Starting device flow');

  const response = await httpsRequest({
    hostname: 'github.com',
    path: '/login/device/code',
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);

  console.debug('[GitHubAuth] Response status:', response.status);

  if (response.status !== 200) {
    throw new Error(response.data.error_description || response.data.error || `GitHub API error: ${response.status}`);
  }

  return response.data;
}

/**
 * Poll for the access token
 * @param {string} deviceCode - The device code from startDeviceFlow
 * @param {number} interval - Polling interval in seconds
 * @returns {Promise<string>} - The access token
 */
async function pollForToken(deviceCode, interval = 5) {
  const postData = `client_id=${GITHUB_CLIENT_ID}&device_code=${deviceCode}&grant_type=urn:ietf:params:oauth:grant-type:device_code`;
  const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes max
  const startTime = Date.now();

  while (true) {
    // Timeout guard
    if (Date.now() - startTime > MAX_DURATION_MS) {
      throw new Error('Authentication expired (10 min). Please try again.');
    }

    await new Promise(resolve => setTimeout(resolve, interval * 1000));

    let response;
    try {
      response = await httpsRequest({
        hostname: 'github.com',
        path: '/login/oauth/access_token',
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, postData);
    } catch (networkError) {
      console.error('[GitHubAuth] Poll network error:', networkError.message);
      // Retry with backoff instead of crashing
      interval = Math.min(interval + 5, 30);
      continue;
    }

    const data = response.data;

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === 'authorization_pending') {
      continue;
    }

    if (data.error === 'slow_down') {
      interval += 5;
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('Code expired. Please try again.');
    }

    if (data.error === 'access_denied') {
      throw new Error('Access denied by user.');
    }

    if (data.error) {
      throw new Error(data.error_description || data.error);
    }
  }
}

/**
 * Get the stored GitHub token
 * @returns {Promise<string|null>}
 */
async function getToken() {
  try {
    return await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  } catch (e) {
    if (process.platform === 'linux') {
      console.error('[GitHub] Credential storage failed. Install libsecret: sudo apt install libsecret-1-dev gnome-keyring');
    }
    console.error('Error getting GitHub token:', e);
    return null;
  }
}

/**
 * Store the GitHub token securely
 * @param {string} token
 */
async function setToken(token) {
  try {
    await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, token);
    return true;
  } catch (e) {
    if (process.platform === 'linux') {
      console.error('[GitHub] Credential storage failed. Install libsecret: sudo apt install libsecret-1-dev gnome-keyring');
    }
    console.error('Error storing GitHub token:', e);
    return false;
  }
}

/**
 * Delete the stored GitHub token
 */
async function deleteToken() {
  try {
    await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
    return true;
  } catch (e) {
    if (process.platform === 'linux') {
      console.error('[GitHub] Credential storage failed. Install libsecret: sudo apt install libsecret-1-dev gnome-keyring');
    }
    console.error('Error deleting GitHub token:', e);
    return false;
  }
}

/**
 * Check if user is authenticated and get user info
 * @returns {Promise<Object|null>} - User info or null
 */
async function getAuthStatus() {
  const token = await getToken();
  if (!token) return { authenticated: false };

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: '/user',
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      }
    });

    if (response.status === 200) {
      return {
        authenticated: true,
        login: response.data.login,
        name: response.data.name,
        avatar_url: response.data.avatar_url
      };
    }

    // Token is invalid, delete it
    await deleteToken();
    return { authenticated: false };
  } catch (e) {
    console.error('Error checking auth status:', e);
    return { authenticated: false };
  }
}

/**
 * Get the token for use in git operations
 * @returns {Promise<string|null>}
 */
async function getTokenForGit() {
  return await getToken();
}

/**
 * Get workflow runs for a repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} perPage - Number of results (default: 5)
 * @returns {Promise<Object>} - Workflow runs data
 */
async function getWorkflowRuns(owner, repo, perPage = 5, page = 1) {
  const token = await getToken();
  if (!token) {
    return { authenticated: false, runs: [] };
  }

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/actions/runs?per_page=${perPage}&page=${page}`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      },
      etagKey: `workflow-runs:${owner}/${repo}`
    });

    if (response.status === 200) {
      const runs = (response.data.workflow_runs || []).map(run => ({
        id: run.id,
        name: run.name,
        status: run.status, // queued, in_progress, completed
        conclusion: run.conclusion, // success, failure, cancelled, skipped, neutral
        branch: run.head_branch,
        commit: run.head_sha?.substring(0, 7),
        commitMessage: run.head_commit?.message?.split('\n')[0] || '',
        event: run.event, // push, pull_request, workflow_dispatch, etc.
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        url: run.html_url,
        actor: run.actor?.login
      }));

      return { authenticated: true, runs, total: response.data.total_count };
    }

    if (response.status === 404) {
      // Repo not found or no Actions
      return { authenticated: true, runs: [], notFound: true };
    }

    return { authenticated: true, runs: [], error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching workflow runs:', e);
    return { authenticated: true, runs: [], error: e.message };
  }
}

/**
 * Parse owner and repo from a git remote URL
 * @param {string} remoteUrl - Git remote URL (https or ssh)
 * @returns {Object|null} - { owner, repo } or null
 */
function parseGitHubRemote(remoteUrl) {
  if (!remoteUrl) return null;

  const escaped = config.webHostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // HTTPS: https://github.com/owner/repo.git (or custom GHE hostname)
  const httpsMatch = remoteUrl.match(new RegExp(escaped + '\\/([^\\/]+)\\/([^\\/\\.]+)'));
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH: git@github.com:owner/repo.git (or custom GHE hostname)
  const sshMatch = remoteUrl.match(new RegExp(escaped + ':([^\\/]+)\\/([^\\/\\.]+)'));
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Get pull requests for a repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number} perPage - Number of results (default: 5)
 * @returns {Promise<Object>} - Pull requests data
 */
async function getPullRequests(owner, repo, perPage = 5, page = 1, state = 'all') {
  const token = await getToken();
  if (!token) {
    return { authenticated: false, pullRequests: [] };
  }

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/pulls?per_page=${perPage}&page=${page}&state=${state}&sort=updated&direction=desc`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      }
    });

    if (response.status === 200) {
      const pullRequests = (response.data || []).map(pr => ({
        id: pr.id,
        number: pr.number,
        title: pr.title,
        state: pr.merged_at ? 'merged' : pr.state, // open, closed, merged
        draft: pr.draft || false,
        author: pr.user?.login,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        url: pr.html_url,
        labels: (pr.labels || []).map(l => ({ name: l.name, color: l.color }))
      }));

      return { authenticated: true, pullRequests };
    }

    if (response.status === 404) {
      return { authenticated: true, pullRequests: [], notFound: true };
    }

    return { authenticated: true, pullRequests: [], error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching pull requests:', e);
    return { authenticated: true, pullRequests: [], error: e.message };
  }
}

/**
 * Create a pull request
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} title - PR title
 * @param {string} body - PR body
 * @param {string} head - Head branch
 * @param {string} base - Base branch
 * @returns {Promise<Object>} - Created PR data
 */
async function createPullRequest(owner, repo, title, body, head, base) {
  const token = await getToken();
  if (!token) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const postData = JSON.stringify({ title, body, head, base });
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/pulls`,
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    if (response.status === 201) {
      const pr = response.data;
      return {
        success: true,
        pr: {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          state: pr.state
        }
      };
    }

    return { success: false, error: response.data.message || `API error: ${response.status}` };
  } catch (e) {
    console.error('Error creating pull request:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Get jobs and steps for a specific workflow run
 */
async function getWorkflowJobs(owner, repo, runId) {
  const token = await getToken();
  if (!token) return { authenticated: false, jobs: [] };

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/actions/runs/${runId}/jobs`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      },
      etagKey: `workflow-jobs:${owner}/${repo}/${runId}`
    });

    if (response.status === 200) {
      const jobs = (response.data.jobs || []).map(job => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        startedAt: job.started_at,
        completedAt: job.completed_at,
        steps: (job.steps || []).map(step => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion
        }))
      }));
      return { authenticated: true, jobs };
    }

    return { authenticated: true, jobs: [], error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching workflow jobs:', e);
    return { authenticated: true, jobs: [], error: e.message };
  }
}

/**
 * Get logs for a specific job (follows 302 redirect to S3)
 */
async function getJobLogs(owner, repo, jobId) {
  const token = await getToken();
  if (!token) return { authenticated: false, logs: null };

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      },
      rawText: true,
      timeout: 30000
    });

    if (response.status === 200 && typeof response.data === 'string') {
      // Strip ANSI escape codes and timestamp prefixes
      const clean = response.data.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm, '');
      const trimmed = clean.length > 4096 ? '...\n' + clean.slice(-4096) : clean;
      return { authenticated: true, logs: trimmed };
    }

    return { authenticated: true, logs: null, error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching job logs:', e);
    return { authenticated: true, logs: null, error: e.message };
  }
}

/**
 * Get check runs (CI status) for a specific commit ref
 */
async function getCheckRuns(owner, repo, ref) {
  const token = await getToken();
  if (!token) return { authenticated: false, checkRuns: [] };

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/commits/${ref}/check-runs`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      },
      etagKey: `check-runs:${owner}/${repo}/${ref}`
    });

    if (response.status === 200) {
      const checkRuns = (response.data.check_runs || []).map(cr => ({
        id: cr.id,
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
        startedAt: cr.started_at,
        completedAt: cr.completed_at,
        url: cr.html_url
      }));
      return { authenticated: true, checkRuns, total: response.data.total_count };
    }

    return { authenticated: true, checkRuns: [], error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching check runs:', e);
    return { authenticated: true, checkRuns: [], error: e.message };
  }
}

/**
 * Merge a pull request
 */
async function mergePullRequest(owner, repo, pullNumber, mergeMethod = 'merge') {
  const token = await getToken();
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const postData = JSON.stringify({ merge_method: mergeMethod });
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    if (response.status === 200) {
      return { success: true, sha: response.data.sha, message: response.data.message };
    }

    return { success: false, error: response.data.message || `API error: ${response.status}` };
  } catch (e) {
    console.error('Error merging pull request:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Get issues for a repository
 */
async function getIssues(owner, repo, perPage = 10, page = 1, state = 'open') {
  const token = await getToken();
  if (!token) return { authenticated: false, issues: [] };

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/issues?per_page=${perPage}&page=${page}&state=${state}&sort=updated&direction=desc`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      },
      etagKey: `issues:${owner}/${repo}:${state}:${page}`
    });

    if (response.status === 200) {
      // Filter out PRs (GitHub API returns PRs as issues too)
      const issues = (response.data || [])
        .filter(item => !item.pull_request)
        .map(issue => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          state: issue.state,
          author: issue.user?.login,
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          url: issue.html_url,
          comments: issue.comments,
          labels: (issue.labels || []).map(l => ({ name: l.name, color: l.color })),
          assignees: (issue.assignees || []).map(a => a.login)
        }));
      return { authenticated: true, issues };
    }

    if (response.status === 404) {
      return { authenticated: true, issues: [], notFound: true };
    }

    return { authenticated: true, issues: [], error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching issues:', e);
    return { authenticated: true, issues: [], error: e.message };
  }
}

/**
 * Create an issue
 */
async function createIssue(owner, repo, title, body, labels = []) {
  const token = await getToken();
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const postData = JSON.stringify({ title, body, labels });
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/issues`,
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    if (response.status === 201) {
      return {
        success: true,
        issue: {
          number: response.data.number,
          title: response.data.title,
          url: response.data.html_url
        }
      };
    }

    return { success: false, error: response.data.message || `API error: ${response.status}` };
  } catch (e) {
    console.error('Error creating issue:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Close an issue
 */
async function closeIssue(owner, repo, issueNumber) {
  const token = await getToken();
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const postData = JSON.stringify({ state: 'closed' });
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/issues/${issueNumber}`,
      method: 'PATCH',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    if (response.status === 200) {
      return { success: true };
    }

    return { success: false, error: response.data.message || `API error: ${response.status}` };
  } catch (e) {
    console.error('Error closing issue:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Get reviews for a pull request
 */
async function getPullRequestReviews(owner, repo, pullNumber) {
  const token = await getToken();
  if (!token) return { authenticated: false, reviews: [] };

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      },
      etagKey: `pr-reviews:${owner}/${repo}/${pullNumber}`
    });

    if (response.status === 200) {
      const reviews = (response.data || []).map(r => ({
        id: r.id,
        user: r.user?.login,
        avatarUrl: r.user?.avatar_url,
        state: r.state,
        body: r.body,
        submittedAt: r.submitted_at,
        htmlUrl: r.html_url
      }));
      return { authenticated: true, reviews };
    }

    return { authenticated: true, reviews: [], error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching PR reviews:', e);
    return { authenticated: true, reviews: [], error: e.message };
  }
}

/**
 * Create a review on a pull request
 * @param {string} event - APPROVE, REQUEST_CHANGES, or COMMENT
 */
async function createPullRequestReview(owner, repo, pullNumber, event, body) {
  const token = await getToken();
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const postData = JSON.stringify({ event, body: body || '' });
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    if (response.status === 200 || response.status === 201) {
      return { success: true, review: { id: response.data.id, state: response.data.state } };
    }

    return { success: false, error: response.data?.message || `API error: ${response.status}` };
  } catch (e) {
    console.error('Error creating PR review:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Get review comments on a pull request
 */
async function getPullRequestComments(owner, repo, pullNumber) {
  const token = await getToken();
  if (!token) return { authenticated: false, comments: [] };

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/pulls/${pullNumber}/comments`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      },
      etagKey: `pr-comments:${owner}/${repo}/${pullNumber}`
    });

    if (response.status === 200) {
      const comments = (response.data || []).map(c => ({
        id: c.id,
        user: c.user?.login,
        body: c.body,
        path: c.path,
        line: c.line,
        createdAt: c.created_at,
        htmlUrl: c.html_url
      }));
      return { authenticated: true, comments };
    }

    return { authenticated: true, comments: [], error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching PR comments:', e);
    return { authenticated: true, comments: [], error: e.message };
  }
}

/**
 * List available workflows for a repository
 */
async function getWorkflows(owner, repo) {
  const token = await getToken();
  if (!token) return { authenticated: false, workflows: [] };

  try {
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/actions/workflows`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      },
      etagKey: `workflows:${owner}/${repo}`
    });

    if (response.status === 200) {
      const workflows = (response.data.workflows || [])
        .filter(w => w.state === 'active')
        .map(w => ({
          id: w.id,
          name: w.name,
          path: w.path,
          state: w.state,
          htmlUrl: w.html_url
        }));
      return { authenticated: true, workflows, total: response.data.total_count };
    }

    return { authenticated: true, workflows: [], error: `API error: ${response.status}` };
  } catch (e) {
    console.error('Error fetching workflows:', e);
    return { authenticated: true, workflows: [], error: e.message };
  }
}

/**
 * Dispatch (trigger) a workflow
 */
async function dispatchWorkflow(owner, repo, workflowId, ref, inputs = {}) {
  const token = await getToken();
  if (!token) return { success: false, error: 'Not authenticated' };

  try {
    const postData = JSON.stringify({ ref, inputs });
    const response = await httpsRequest({
      hostname: config.apiHostname,
      path: `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    // 204 No Content = success
    if (response.status === 204) {
      return { success: true };
    }

    return { success: false, error: response.data?.message || `API error: ${response.status}` };
  } catch (e) {
    console.error('Error dispatching workflow:', e);
    return { success: false, error: e.message };
  }
}

module.exports = {
  startDeviceFlow,
  pollForToken,
  getToken,
  setToken,
  deleteToken,
  getAuthStatus,
  getTokenForGit,
  getWorkflowRuns,
  getWorkflowJobs,
  getJobLogs,
  getPullRequests,
  createPullRequest,
  parseGitHubRemote,
  getCheckRuns,
  mergePullRequest,
  getIssues,
  createIssue,
  closeIssue,
  // New: Rate limit
  getRateLimitState,
  // New: GitHub Enterprise config
  configure,
  // New: PR Reviews
  getPullRequestReviews,
  createPullRequestReview,
  getPullRequestComments,
  // New: Workflow dispatch
  getWorkflows,
  dispatchWorkflow
};
