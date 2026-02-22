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

// ── PTY fallback ──

/**
 * Parse a reset time string into an ISO date string
 * @param {string} line - Reset line from usage output
 * @returns {string|null}
 */
function parseResetTime(line) {
  try {
    const match = line.match(/Resets\s+(.+?)(?:\s*\([^)]*\))?\s*$/i);
    if (!match) return null;
    const timeStr = match[1].trim();
    const now = new Date();
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

    const dateMatch = timeStr.match(/(\w{3})\s+(\d{1,2}),?\s*(\d{1,2})(am|pm)/i);
    if (dateMatch) {
      const month = months[dateMatch[1].toLowerCase()];
      if (month === undefined) return null;
      const day = parseInt(dateMatch[2], 10);
      let hour = parseInt(dateMatch[3], 10);
      if (dateMatch[4].toLowerCase() === 'pm' && hour !== 12) hour += 12;
      if (dateMatch[4].toLowerCase() === 'am' && hour === 12) hour = 0;
      const target = new Date(now.getFullYear(), month, day, hour, 0, 0);
      if (target.getTime() < now.getTime() - 86400000) target.setFullYear(target.getFullYear() + 1);
      return target.toISOString();
    }

    const timeOnly = timeStr.match(/^(\d{1,2})(am|pm)$/i);
    if (timeOnly) {
      let hour = parseInt(timeOnly[1], 10);
      if (timeOnly[2].toLowerCase() === 'pm' && hour !== 12) hour += 12;
      if (timeOnly[2].toLowerCase() === 'am' && hour === 12) hour = 0;
      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
      if (target.getTime() < now.getTime()) target.setDate(target.getDate() + 1);
      return target.toISOString();
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Parse usage output from PTY /usage command
 * @param {string} output - Raw terminal output
 * @returns {Object}
 */
function parseUsageOutput(output) {
  const data = {
    timestamp: new Date().toISOString(),
    session: null,
    weekly: null,
    sonnet: null,
    sessionReset: null,
    weeklyReset: null,
    _source: 'pty'
  };

  try {
    const clean = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

    const sessionMatch = clean.match(/Current session[\s\S]{0,100}?(\d+(?:\.\d+)?)\s*%/i);
    if (sessionMatch) data.session = parseFloat(sessionMatch[1]);

    const sonnetMatch = clean.match(/Sonnet[^%\n]{0,60}?(\d+(?:\.\d+)?)\s*%/i);
    if (sonnetMatch) data.sonnet = parseFloat(sonnetMatch[1]);

    const weeklyMatch = clean.match(/Current week[^\n]{0,50}?all models[^\n]{0,50}?(\d+(?:\.\d+)?)\s*%/i) ||
                        clean.match(/Current week[^\n]{0,80}?(\d+(?:\.\d+)?)\s*%/i) ||
                        clean.match(/Weekly[^\n]{0,80}?(\d+(?:\.\d+)?)\s*%/i);
    if (weeklyMatch) data.weekly = parseFloat(weeklyMatch[1]);

    const allPercents = clean.match(/(\d+(?:\.\d+)?)\s*%/g);
    if (allPercents && allPercents.length >= 1) {
      if (data.session === null) data.session = parseFloat(allPercents[0]);
      if (data.weekly === null && allPercents.length >= 2) data.weekly = parseFloat(allPercents[1]);
      if (data.sonnet === null && allPercents.length >= 3) data.sonnet = parseFloat(allPercents[2]);
    }

    const resetLines = clean.match(/Resets?\s+[A-Za-z0-9,\s]+(?:am|pm)/gi);
    if (resetLines) {
      for (const line of resetLines) {
        const parsed = parseResetTime(line);
        if (!parsed) continue;
        if (!data.sessionReset) data.sessionReset = parsed;
        else if (!data.weeklyReset) data.weeklyReset = parsed;
      }
    }
  } catch (e) {
    console.error('[Usage] PTY parse error:', e.message);
  }

  return data;
}

/**
 * Fetch usage data via PTY /usage command (fallback)
 * @returns {Promise<Object>}
 */
function fetchUsageFromPTY() {
  const pty = require('node-pty');
  return new Promise((resolve, reject) => {
    let output = '';
    let phase = 'waiting_cmd';
    let resolved = false;

    let proc;
    try {
      const { getShell } = require('../utils/shell');
      const shell = getShell();
      proc = pty.spawn(shell.path, shell.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (e) {
      return reject(new Error(`PTY spawn failed: ${e.message}`));
    }

    if (!proc) return reject(new Error('PTY spawn returned null'));

    const timeout = setTimeout(() => { if (!resolved) finish(); }, 25000);

    function finish() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      try { proc.kill(); } catch (e) {}

      const parsed = parseUsageOutput(output);
      if (parsed.session !== null || parsed.weekly !== null) {
        resolve(parsed);
      } else {
        reject(new Error('Could not parse PTY usage data'));
      }
    }

    proc.onData((data) => {
      output += data;

      const { matchesShellPrompt } = require('../utils/shell');
      if (phase === 'waiting_cmd' && matchesShellPrompt(output)) {
        phase = 'waiting_claude';
        proc.write('claude --dangerously-skip-permissions\r');
      }

      if (phase === 'waiting_claude' && output.includes('Claude Code')) {
        phase = 'waiting_usage';
        setTimeout(() => {
          proc.write('/usage');
          setTimeout(() => proc.write('\t'), 300);
          setTimeout(() => proc.write('\r'), 500);
        }, 1500);
      }

      if (phase === 'waiting_usage') {
        const hasData = output.includes('% used') ||
                       (output.includes('Current session') && output.match(/\d+%/));
        if (hasData) {
          phase = 'done';
          setTimeout(finish, 2000);
        }
      }
    });

    proc.onExit(() => { if (!resolved) finish(); });
  });
}

// ── Main fetch logic ──

/**
 * Fetch usage data: try API first, fall back to PTY
 * @returns {Promise<Object>}
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
        console.log('[Usage] Fetched via API');
        return data;
      } catch (apiErr) {
        console.log('[Usage] API failed, falling back to PTY:', apiErr.message);
      }
    }

    // Fallback to PTY
    const data = await fetchUsageFromPTY();
    usageData = data;
    lastFetch = new Date();
    console.log('[Usage] Fetched via PTY fallback');
    return data;
  } finally {
    isFetching = false;
  }
}

/**
 * Start periodic fetching
 * @param {number} intervalMs - Interval (default: 5 minutes)
 */
function startPeriodicFetch(intervalMs = 300000) {
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
 * Get cached usage data
 * @returns {Object}
 */
function getUsageData() {
  return {
    data: usageData,
    lastFetch: lastFetch ? lastFetch.toISOString() : null,
    isFetching
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
  const staleMinutes = 5;
  const isStale = !lastFetch || (Date.now() - lastFetch.getTime() > staleMinutes * 60 * 1000);

  if (isStale && !isFetching) {
    fetchUsage().catch(e => console.error('[Usage]', e.message));
  }
}

module.exports = {
  startPeriodicFetch,
  stopPeriodicFetch,
  getUsageData,
  refreshUsage,
  fetchUsage,
  onWindowShow
};
