/**
 * UsageService
 * Fetches Claude usage data via the OAuth API (primary) or PTY /usage command (fallback).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');

// Cache
let usageData = null;
let lastFetch = null;
let fetchInterval = null;
let isFetching = false;
let _onUpdateCallback = null;
let _onLimitCallback = null;
// Staleness tracking: set whenever a fetch attempt fails. `isStale` stays true
// for as long as we keep serving `usageData` that the API refused to confirm,
// so the renderer can badge the numbers instead of showing them as current.
let lastError = null;
let isStale = false;
// De-dupe limit notifications until the next reset window
let _lastLimitNotifiedReset = null;

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

// ── OAuth API (primary) ──

// Token cache to avoid repeated sync I/O
let _tokenCache = null;
let _tokenCacheTime = 0;
const TOKEN_CACHE_TTL = 30000; // 30s

/**
 * Read the OAuth access token from ~/.claude/.credentials.json
 * @returns {string|null}
 */
function readOAuthToken() {
  const now = Date.now();
  if (_tokenCache !== null && now - _tokenCacheTime < TOKEN_CACHE_TTL) {
    return _tokenCache;
  }
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const credPath = path.join(configDir, '.credentials.json');
    if (!fs.existsSync(credPath)) { _tokenCache = null; _tokenCacheTime = now; return null; }
    const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) { _tokenCache = null; _tokenCacheTime = now; return null; }
    // Check expiry
    const expiresAt = creds.claudeAiOauth.expiresAt;
    if (expiresAt && now > expiresAt) {
      console.log('[Usage] OAuth token expired');
      _tokenCache = null; _tokenCacheTime = now;
      return null;
    }
    _tokenCache = token; _tokenCacheTime = now;
    return token;
  } catch (e) {
    _tokenCache = null; _tokenCacheTime = now;
    return null;
  }
}

/**
 * Fetch usage data from the OAuth API
 * @returns {Promise<Object>} Parsed usage data in standard format
 */
function fetchUsageFromAPI(token) {
  return new Promise((resolve, reject) => {
    const url = new URL(USAGE_API_URL);
    const req = https.get({
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': OAUTH_BETA_HEADER
      },
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`API ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try {
          const json = JSON.parse(body);
          resolve({
            timestamp: new Date().toISOString(),
            session: json.five_hour?.utilization ?? null,
            weekly: json.seven_day?.utilization ?? null,
            sonnet: json.seven_day_sonnet?.utilization ?? null,
            opus: json.seven_day_opus?.utilization ?? null,
            sessionReset: json.five_hour?.resets_at ?? null,
            weeklyReset: json.seven_day?.resets_at ?? null,
            sonnetReset: json.seven_day_sonnet?.resets_at ?? null,
            extraUsage: json.extra_usage ?? null,
            _source: 'api'
          });
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
  });
}

// ── Main fetch logic ──

/**
 * Fetch usage data from the OAuth API.
 * There is no second source (the PTY fallback was removed), so a failed fetch
 * marks the cached data stale rather than silently passing it off as fresh.
 * @returns {Promise<Object|null>}
 */
async function fetchUsage() {
  if (isFetching) return usageData;
  isFetching = true;

  try {
    // Try OAuth API first
    const token = readOAuthToken();
    if (token) {
      try {
        const data = await fetchUsageFromAPI(token);
        usageData = data;
        lastFetch = new Date();
        lastError = null;
        isStale = false;
        console.log('[Usage] Fetched via API');
        if (_onUpdateCallback) _onUpdateCallback(data);
        _maybeNotifyLimit(data);
        return data;
      } catch (apiErr) {
        lastError = apiErr.message;
        console.log('[Usage] API request failed:', apiErr.message);
      }
    } else {
      lastError = 'No valid Claude OAuth token (missing or expired ~/.claude/.credentials.json)';
      console.log('[Usage] ' + lastError);
    }

    // PTY fallback removed — launching `claude --dangerously-skip-permissions` just
    // to read usage data is a security risk. Serve cached data, flagged as stale.
    isStale = true;
    if (usageData) {
      console.warn('[Usage] API unavailable, serving STALE cached data:', lastError);
      return usageData;
    }
    console.warn('[Usage] API unavailable and no cached data:', lastError);
    return null;
  } finally {
    isFetching = false;
  }
}

/**
 * Start periodic fetching
 * @param {number} intervalMs - Interval (default: 10 minutes)
 */
function startPeriodicFetch(intervalMs = 600000) {
  const { isMainWindowVisible } = require('../windows/MainWindow');

  setTimeout(() => {
    if (isMainWindowVisible()) {
      fetchUsage().catch(e => console.error('[Usage]', e.message));
    }
  }, 5000);

  if (fetchInterval) clearInterval(fetchInterval);
  fetchInterval = setInterval(() => {
    if (isMainWindowVisible()) {
      fetchUsage().catch(e => console.error('[Usage]', e.message));
    }
  }, intervalMs);
}

/**
 * Stop periodic fetching
 */
function stopPeriodicFetch() {
  if (fetchInterval) {
    clearInterval(fetchInterval);
    fetchInterval = null;
  }
}

/**
 * Get cached usage data.
 * `stale` is true when the last fetch attempt failed — `data` is then whatever
 * the API last confirmed, which may be arbitrarily old.
 * @returns {Object}
 */
function getUsageData() {
  return {
    data: usageData,
    lastFetch: lastFetch ? lastFetch.toISOString() : null,
    isFetching,
    stale: isStale,
    error: lastError
  };
}

/**
 * Staleness of the most recent fetch attempt.
 * @returns {{ stale: boolean, error: string|null, lastFetch: string|null }}
 */
function getFetchState() {
  return {
    stale: isStale,
    error: lastError,
    lastFetch: lastFetch ? lastFetch.toISOString() : null
  };
}

/**
 * Force refresh
 * @returns {Promise<Object>}
 */
function refreshUsage() {
  return fetchUsage();
}

/**
 * Called when window becomes visible - refresh if data is stale
 */
function onWindowShow() {
  const staleMinutes = 10;
  // Renamed to avoid shadowing the module-level `isStale` (fetch-failure flag).
  const isDataOld = !lastFetch || (Date.now() - lastFetch.getTime() > staleMinutes * 60 * 1000);

  if (isDataOld && !isFetching) {
    fetchUsage().catch(e => console.error('[Usage]', e.message));
  }
}

/**
 * Register a callback to receive usage data updates (push model)
 * @param {Function} cb - Called with usage data object
 */
function onUpdate(cb) {
  _onUpdateCallback = cb;
}

/**
 * Register a callback fired when a usage threshold is crossed.
 * Invoked at most once per reset window per scope (session / weekly).
 * @param {Function} cb - cb({ scope, utilization, resetsAt })
 */
function onLimit(cb) {
  _onLimitCallback = cb;
}

const LIMIT_THRESHOLD = 0.95; // 95%

function _maybeNotifyLimit(data) {
  if (!_onLimitCallback || !data) return;
  // Pick the most-pressured bucket
  const candidates = [
    { scope: 'session', utilization: data.session, resetsAt: data.sessionReset },
    { scope: 'weekly',  utilization: data.weekly,  resetsAt: data.weeklyReset  },
    { scope: 'sonnet',  utilization: data.sonnet,  resetsAt: data.sonnetReset  },
  ].filter(c => typeof c.utilization === 'number' && c.utilization >= LIMIT_THRESHOLD);
  if (!candidates.length) return;
  // Most utilized first
  candidates.sort((a, b) => b.utilization - a.utilization);
  const top = candidates[0];
  // De-dupe per reset window
  const key = `${top.scope}:${top.resetsAt || ''}`;
  if (key === _lastLimitNotifiedReset) return;
  _lastLimitNotifiedReset = key;
  try { _onLimitCallback(top); } catch (e) { console.error('[Usage] onLimit cb threw:', e.message); }
}

module.exports = {
  startPeriodicFetch,
  stopPeriodicFetch,
  getUsageData,
  getFetchState,
  refreshUsage,
  fetchUsage,
  onWindowShow,
  onUpdate,
  onLimit
};
