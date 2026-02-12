/**
 * UsageService
 * Fetches Claude Code usage by running /usage command
 */

const pty = require('node-pty');
const os = require('os');

// Cache
let usageData = null;
let lastFetch = null;
let fetchInterval = null;
let isFetching = false;

/**
 * Parse usage output - extract percentages from ANSI output
 * @param {string} output - Raw terminal output
 * @returns {Object} - Parsed usage data
 */
function parseUsageOutput(output) {
  const data = {
    timestamp: new Date().toISOString(),
    session: null,
    weekly: null,
    sonnet: null
  };

  try {
    // Clean ANSI codes
    const clean = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

    // Find percentages near keywords
    // Pattern: "Current session" followed by percentage
    const sessionMatch = clean.match(/Current session[\s\S]{0,100}?(\d+(?:\.\d+)?)\s*%/i);
    if (sessionMatch) {
      data.session = parseFloat(sessionMatch[1]);
    }

    // Pattern: "Sonnet" followed by percentage (parse BEFORE weekly to avoid overlap)
    const sonnetMatch = clean.match(/Sonnet[^%\n]{0,60}?(\d+(?:\.\d+)?)\s*%/i);
    if (sonnetMatch) {
      data.sonnet = parseFloat(sonnetMatch[1]);
    }

    // Pattern: "Current week" or "Weekly" - same line percentage only, or "all models"
    const weeklyMatch = clean.match(/Current week[^\n]{0,50}?all models[^\n]{0,50}?(\d+(?:\.\d+)?)\s*%/i) ||
                        clean.match(/Current week[^\n]{0,80}?(\d+(?:\.\d+)?)\s*%/i) ||
                        clean.match(/Weekly[^\n]{0,80}?(\d+(?:\.\d+)?)\s*%/i);
    if (weeklyMatch) {
      data.weekly = parseFloat(weeklyMatch[1]);
    }

    // Fallback: find all percentages in order for any missing values
    const allPercents = clean.match(/(\d+(?:\.\d+)?)\s*%/g);
    if (allPercents && allPercents.length >= 1) {
      if (data.session === null) data.session = parseFloat(allPercents[0]);
      if (data.weekly === null && allPercents.length >= 2) data.weekly = parseFloat(allPercents[1]);
      if (data.sonnet === null && allPercents.length >= 3) data.sonnet = parseFloat(allPercents[2]);
    }

    // console.log('[Usage] Parsed:', data);
  } catch (e) {
    console.error('[Usage] Parse error:', e.message);
  }

  return data;
}

/**
 * Fetch usage data
 * @returns {Promise<Object>}
 */
function fetchUsage() {
  return new Promise((resolve, reject) => {
    if (isFetching) {
      return resolve(usageData);
    }

    isFetching = true;
    let output = '';
    let phase = 'waiting_cmd'; // waiting_cmd -> waiting_claude -> waiting_usage -> done
    let resolved = false;

    // console.log('[Usage] Starting fetch...');

    let proc;
    try {
      proc = pty.spawn('cmd.exe', [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (spawnError) {
      console.error('[Usage] Failed to spawn cmd.exe:', spawnError.message);
      isFetching = false;
      return reject(new Error(`PTY spawn failed: ${spawnError.message}`));
    }

    if (!proc) {
      isFetching = false;
      return reject(new Error('PTY spawn returned null'));
    }

    // Timeout - kill and parse what we have
    const timeout = setTimeout(() => {
      if (!resolved) {
        // console.log('[Usage] Timeout - parsing available data');
        finish();
      }
    }, 25000);

    function finish() {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      isFetching = false;

      try { proc.kill(); } catch (e) {}

      const parsed = parseUsageOutput(output);
      if (parsed.session !== null || parsed.weekly !== null) {
        usageData = parsed;
        lastFetch = new Date();
        resolve(parsed);
      } else {
        reject(new Error('Could not parse usage data'));
      }
    }

    proc.onData((data) => {
      output += data;

      // Phase 1: Wait for CMD prompt, then start Claude
      if (phase === 'waiting_cmd' && output.includes('>')) {
        phase = 'waiting_claude';
        // console.log('[Usage] CMD ready, starting Claude...');
        proc.write('claude --dangerously-skip-permissions\r');
      }

      // Phase 2: Wait for Claude to be ready (logo appears), then send /usage
      if (phase === 'waiting_claude' && output.includes('Claude Code')) {
        phase = 'waiting_usage';
        // console.log('[Usage] Claude ready, sending /usage...');
        setTimeout(() => {
          proc.write('/usage');
          setTimeout(() => proc.write('\t'), 300);
          setTimeout(() => proc.write('\r'), 500);
        }, 1500);
      }

      // Phase 3: Wait for usage data, then finish
      if (phase === 'waiting_usage') {
        // Look for percentage in output (indicates usage displayed)
        const hasData = output.includes('% used') ||
                       (output.includes('Current session') && output.match(/\d+%/));

        if (hasData) {
          phase = 'done';
          // console.log('[Usage] Got usage data');
          // Wait a bit for complete output then finish
          setTimeout(finish, 2000);
        }
      }
    });

    proc.onExit(() => {
      if (!resolved) {
        finish();
      }
    });
  });
}

/**
 * Start periodic fetching
 * @param {number} intervalMs - Interval (default: 5 minutes)
 */
function startPeriodicFetch(intervalMs = 300000) {
  const { isMainWindowVisible } = require('../windows/MainWindow');

  // Initial fetch after short delay (only if visible)
  setTimeout(() => {
    if (isMainWindowVisible()) {
      fetchUsage().catch(e => console.error('[Usage]', e.message));
    }
  }, 5000);

  // Periodic fetch (only if visible)
  if (fetchInterval) clearInterval(fetchInterval);
  fetchInterval = setInterval(() => {
    if (isMainWindowVisible()) {
      fetchUsage().catch(e => console.error('[Usage]', e.message));
    } else {
      // console.log('[Usage] Skipping fetch - window hidden');
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
    // console.log('[Usage] Window shown, refreshing stale data...');
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
