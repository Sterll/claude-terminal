/**
 * UsageService
 * Fetches Claude Code usage by running /usage command in background
 */

const pty = require('node-pty');
const os = require('os');
const path = require('path');

// Usage data cache
let usageData = null;
let lastFetch = null;
let fetchInterval = null;
let isFetching = false;

// Shell configuration
const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');

/**
 * Parse usage output from Claude CLI
 * @param {string} output - Raw terminal output
 * @returns {Object|null} - Parsed usage data
 */
function parseUsageOutput(output) {
  try {
    const data = {
      raw: output,
      timestamp: new Date().toISOString()
    };

    // Try to extract percentage (e.g., "45% of limit")
    const percentMatch = output.match(/(\d+(?:\.\d+)?)\s*%/);
    if (percentMatch) {
      data.percent = parseFloat(percentMatch[1]);
    }

    // Try to extract tokens (e.g., "1.2M tokens" or "500K tokens")
    const tokenMatches = output.match(/(\d+(?:\.\d+)?)\s*([KMB])?\s*tokens?/gi);
    if (tokenMatches) {
      data.tokens = tokenMatches.map(match => {
        const m = match.match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
        if (m) {
          let value = parseFloat(m[1]);
          const unit = (m[2] || '').toUpperCase();
          if (unit === 'K') value *= 1000;
          else if (unit === 'M') value *= 1000000;
          else if (unit === 'B') value *= 1000000000;
          return Math.round(value);
        }
        return 0;
      });
    }

    // Try to extract cost (e.g., "$12.50" or "12.50 USD")
    const costMatch = output.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:USD|dollars?)?/i);
    if (costMatch) {
      data.cost = parseFloat(costMatch[1]);
    }

    // Try to extract limit info
    const limitMatch = output.match(/limit|quota|remaining|used/gi);
    if (limitMatch) {
      data.hasLimitInfo = true;
    }

    // Extract any "X of Y" patterns (e.g., "500K of 1M")
    const ofMatch = output.match(/(\d+(?:\.\d+)?)\s*([KMB])?\s*(?:of|\/)\s*(\d+(?:\.\d+)?)\s*([KMB])?/i);
    if (ofMatch) {
      let used = parseFloat(ofMatch[1]);
      const usedUnit = (ofMatch[2] || '').toUpperCase();
      if (usedUnit === 'K') used *= 1000;
      else if (usedUnit === 'M') used *= 1000000;

      let total = parseFloat(ofMatch[3]);
      const totalUnit = (ofMatch[4] || '').toUpperCase();
      if (totalUnit === 'K') total *= 1000;
      else if (totalUnit === 'M') total *= 1000000;

      data.used = Math.round(used);
      data.total = Math.round(total);
      data.percent = (used / total) * 100;
    }

    return data;
  } catch (error) {
    console.error('Error parsing usage output:', error);
    return { raw: output, error: error.message };
  }
}

/**
 * Fetch usage data by running claude /usage
 * @returns {Promise<Object>} - Usage data
 */
function fetchUsage() {
  return new Promise((resolve, reject) => {
    if (isFetching) {
      resolve(usageData);
      return;
    }

    isFetching = true;
    let output = '';
    let resolved = false;
    let claudeStarted = false;
    let usageSent = false;

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        isFetching = false;
        ptyProcess.kill();
        reject(new Error('Timeout fetching usage'));
      }
    }, 30000); // 30 second timeout

    ptyProcess.onData((data) => {
      output += data;

      // Detect when claude is ready (prompt appears)
      if (!claudeStarted && (output.includes('>') || output.includes('claude'))) {
        claudeStarted = true;
        // Small delay before sending /usage
        setTimeout(() => {
          if (!usageSent) {
            usageSent = true;
            ptyProcess.write('/usage\r');
          }
        }, 500);
      }

      // Detect when usage output is complete and send exit
      if (usageSent && !resolved) {
        // Look for signs that usage has been displayed
        // Wait a bit for the full output
        setTimeout(() => {
          if (!resolved) {
            ptyProcess.write('/exit\r');
          }
        }, 2000);
      }
    });

    ptyProcess.onExit(() => {
      clearTimeout(timeout);
      if (!resolved) {
        resolved = true;
        isFetching = false;

        // Parse the output
        const parsed = parseUsageOutput(output);
        usageData = parsed;
        lastFetch = new Date();

        resolve(parsed);
      }
    });

    // Start claude
    setTimeout(() => {
      ptyProcess.write('claude\r');
    }, 500);
  });
}

/**
 * Start periodic usage fetching
 * @param {number} intervalMs - Interval in milliseconds (default: 60000 = 1 minute)
 */
function startPeriodicFetch(intervalMs = 60000) {
  // Fetch immediately on start
  fetchUsage().catch(console.error);

  // Then fetch periodically
  if (fetchInterval) {
    clearInterval(fetchInterval);
  }
  fetchInterval = setInterval(() => {
    fetchUsage().catch(console.error);
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
 * @returns {Object|null}
 */
function getUsageData() {
  return {
    data: usageData,
    lastFetch: lastFetch ? lastFetch.toISOString() : null,
    isFetching
  };
}

/**
 * Force refresh usage data
 * @returns {Promise<Object>}
 */
async function refreshUsage() {
  return fetchUsage();
}

module.exports = {
  startPeriodicFetch,
  stopPeriodicFetch,
  getUsageData,
  refreshUsage,
  fetchUsage
};
