'use strict';

/**
 * Usage & Quota Tools Module for Claude Terminal MCP
 *
 * Provides Claude API usage and quota tools. Reads cached usage data from
 * CT_DATA_DIR/usage.json (polled by the Electron app from the Anthropic API).
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:usage] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function loadUsageData() {
  const file = path.join(getDataDir(), 'usage.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading usage.json:', e.message);
  }
  return null;
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'usage_get',
    description: 'Get current Claude API usage data: tokens consumed, daily limit, percentage used, and reset time.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'usage_refresh',
    description: 'Request a refresh of Claude API usage data. Claude Terminal will fetch the latest usage from the Anthropic API.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// -- Formatting helpers -------------------------------------------------------

function formatNumber(n) {
  if (typeof n !== 'number' || isNaN(n)) return '?';
  return n.toLocaleString('en-US');
}

function formatPercentage(used, limit) {
  if (typeof used !== 'number' || typeof limit !== 'number' || limit === 0) return '?';
  return ((used / limit) * 100).toFixed(1) + '%';
}

function formatTimestamp(ts) {
  if (!ts) return '?';
  try {
    const date = new Date(ts);
    if (isNaN(date.getTime())) return String(ts);
    return date.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch (_) {
    return String(ts);
  }
}

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'usage_get') {
      const raw = loadUsageData();
      if (!raw) {
        return ok('No usage data available. Usage data is refreshed automatically by Claude Terminal.');
      }

      // Navigate flexible structure — data may be nested under .data or at root
      const data = raw.data || raw;
      const dailyUsage = data.dailyUsage || data.daily_usage || data;

      const tokensUsed = dailyUsage.tokensUsed ?? dailyUsage.tokens_used ?? dailyUsage.used;
      const tokenLimit = dailyUsage.tokenLimit ?? dailyUsage.token_limit ?? dailyUsage.limit;
      const resetTime = dailyUsage.resetTime ?? dailyUsage.reset_time ?? dailyUsage.resetsAt ?? dailyUsage.resets_at ?? data.resetTime ?? data.resetsAt;
      const planType = data.planType ?? data.plan_type ?? data.plan ?? raw.planType ?? raw.plan;
      const lastUpdated = raw.lastUpdated ?? raw.last_updated ?? raw.updatedAt ?? raw.timestamp;

      let output = '# Claude API Usage\n';
      output += `${'─'.repeat(40)}\n`;

      if (planType) {
        output += `Plan: ${planType}\n`;
      }

      if (typeof tokensUsed === 'number' && typeof tokenLimit === 'number') {
        output += `Tokens used: ${formatNumber(tokensUsed)} / ${formatNumber(tokenLimit)}\n`;
        output += `Usage: ${formatPercentage(tokensUsed, tokenLimit)}\n`;
      } else if (typeof tokensUsed === 'number') {
        output += `Tokens used: ${formatNumber(tokensUsed)}\n`;
      } else {
        output += 'Tokens: no token data available\n';
      }

      if (resetTime) {
        output += `Resets at: ${formatTimestamp(resetTime)}\n`;
      }

      if (lastUpdated) {
        output += `Last updated: ${formatTimestamp(lastUpdated)}\n`;
      }

      // Show any additional quota fields present in the data
      const bonusTokens = dailyUsage.bonusTokens ?? dailyUsage.bonus_tokens;
      if (typeof bonusTokens === 'number' && bonusTokens > 0) {
        output += `Bonus tokens: ${formatNumber(bonusTokens)}\n`;
      }

      const hasFastMode = data.hasFastMode ?? data.has_fast_mode ?? data.fastMode;
      if (hasFastMode !== undefined) {
        output += `Fast mode: ${hasFastMode ? 'available' : 'not available'}\n`;
      }

      return ok(output);
    }

    if (name === 'usage_refresh') {
      const triggerDir = path.join(getDataDir(), 'usage', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `refresh_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        action: 'refresh',
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok('Usage data refresh requested. Data will be updated shortly.');
    }

    return fail(`Unknown usage tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Usage error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
