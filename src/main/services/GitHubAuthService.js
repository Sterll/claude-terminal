/**
 * GitHub Authentication Service
 * Handles OAuth Device Flow and token management
 */

const keytar = require('keytar');
const https = require('https');

const SERVICE_NAME = 'claude-terminal';
const ACCOUNT_NAME = 'github-token';

// GitHub OAuth App Client ID (public, not a secret for device flow)
// Users can also use their own or a PAT
const GITHUB_CLIENT_ID = 'Ov23liYfl42qwDVVk99l';

/**
 * Make an HTTPS request (follows redirects)
 */
function httpsRequest(options, postData = null, maxRedirects = 3) {
  const timeout = options.timeout || 15000;
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      // Handle redirects
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location && maxRedirects > 0) {
        const redirectUrl = new URL(res.headers.location);
        const newOptions = {
          ...options,
          hostname: redirectUrl.hostname,
          path: redirectUrl.pathname + redirectUrl.search,
        };
        return httpsRequest(newOptions, postData, maxRedirects - 1).then(resolve).catch(reject);
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
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
  const postData = `client_id=${GITHUB_CLIENT_ID}&scope=repo`;

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
      throw new Error('Authentification expirée (10 min). Veuillez réessayer.');
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
      throw new Error('Le code a expiré. Veuillez réessayer.');
    }

    if (data.error === 'access_denied') {
      throw new Error('Accès refusé par l\'utilisateur.');
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
      hostname: 'api.github.com',
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
async function getWorkflowRuns(owner, repo, perPage = 5) {
  const token = await getToken();
  if (!token) {
    return { authenticated: false, runs: [] };
  }

  try {
    const response = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/actions/runs?per_page=${perPage}`,
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Claude-Terminal'
      }
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

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/github\.com:([^\/]+)\/([^\/\.]+)/);
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
async function getPullRequests(owner, repo, perPage = 5) {
  const token = await getToken();
  if (!token) {
    return { authenticated: false, pullRequests: [] };
  }

  try {
    const response = await httpsRequest({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/pulls?per_page=${perPage}&state=all&sort=updated&direction=desc`,
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
      hostname: 'api.github.com',
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

module.exports = {
  startDeviceFlow,
  pollForToken,
  getToken,
  setToken,
  deleteToken,
  getAuthStatus,
  getTokenForGit,
  getWorkflowRuns,
  getPullRequests,
  createPullRequest,
  parseGitHubRemote
};
