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
 * Make an HTTPS request
 */
function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
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

  console.log('[GitHubAuth] Starting device flow with client_id:', GITHUB_CLIENT_ID);

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

  console.log('[GitHubAuth] Response status:', response.status, 'data:', response.data);

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

  while (true) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));

    const response = await httpsRequest({
      hostname: 'github.com',
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, postData);

    const data = response.data;

    if (data.access_token) {
      return data.access_token;
    }

    if (data.error === 'authorization_pending') {
      // User hasn't authorized yet, keep polling
      continue;
    }

    if (data.error === 'slow_down') {
      // Increase interval
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

module.exports = {
  startDeviceFlow,
  pollForToken,
  getToken,
  setToken,
  deleteToken,
  getAuthStatus,
  getTokenForGit
};
