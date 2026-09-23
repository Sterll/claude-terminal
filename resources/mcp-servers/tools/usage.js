'use strict';

/**
 * Usage & Quota Tools Module for Claude Terminal MCP
 *
 * Provides Claude usage and quota tools. Reads cached usage data from
 * CT_DATA_DIR/usage.json, which UsageService in the app mirrors after each
 * fetch, and requests a re-fetch by dropping a file in
 * CT_DATA_DIR/usage/triggers/, which the same service watches.
 *
 * Both halves of that contract were missing until recently: nothing wrote
 * usage.json, so usage_get always answered "no data", and nothing read the
 * trigger directory, so usage_refresh reported a refresh that never happened.
 * The shape read below is the service's own: a list of limit buckets carrying
 * a utilization percentage, not the token counts this file used to look for,
 * which the usage API stopped reporting.
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
    description: 'Get current Claude usage: one bar per limit the plan exposes (session, weekly, per-model), how full each is, and when it resets.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'usage_refresh',
    description: 'Ask Claude Terminal to re-fetch usage from the Anthropic API. Returns immediately; call usage_get again a few seconds later.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// -- Formatting helpers -------------------------------------------------------

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

/**
 * `[####------]  42%`
 *
 * The bar is clamped, the number is not — the same split updateUsageBar makes
 * in the titlebar chip, and for the same reason: past 100% the figure is the
 * interesting part, and printing 137% as 100% hides exactly the case worth
 * seeing.
 */
function bar(percent) {
  const pct = Math.round(percent);
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return `[${'#'.repeat(filled)}${'-'.repeat(10 - filled)}] ${String(pct).padStart(3)}%`;
}

/**
 * The plan-wide buckets carry a key rather than a name, because the app
 * translates them. Here there is no locale to translate into.
 */
function bucketLabel(bucket) {
  if (bucket.label) return bucket.label;
  if (bucket.type === 'session') return 'Session';
  if (bucket.type === 'weekly') return 'Weekly';
  return bucket.id || 'Limit';
}

/**
 * How old the figures may be before they are called stale.
 *
 * Mirrors DATA_STALE_AFTER in UsageService. `raw.stale` alone is not enough:
 * it is a snapshot taken when the file was written, and the poller stops with
 * the window minimised, so hours-old numbers would otherwise be served with no
 * marker at all — the very case the app's own staleness window exists to catch.
 */
const DATA_STALE_AFTER = 10 * 60 * 1000;

function isStale(raw) {
  if (raw.stale) return true;
  if (!raw.lastFetch) return true;
  const t = new Date(raw.lastFetch).getTime();
  if (isNaN(t)) return true;
  return Date.now() - t > DATA_STALE_AFTER;
}

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'usage_get') {
      const raw = loadUsageData();
      if (!raw) {
        return ok('No usage data available yet. Claude Terminal writes this file after its first successful fetch; if it stays absent, the app is signed out or its usage poller is not running.');
      }

      const buckets = Array.isArray(raw.buckets) ? raw.buckets : [];
      let output = '# Claude usage\n';
      // Named, because only the focused account is mirrored: a session bound to
      // a different account would otherwise read this as its own quota.
      output += `Account: ${raw.accountId || '(machine-wide login)'}\n`;
      output += `${'-'.repeat(46)}\n`;

      if (buckets.length === 0) {
        output += 'No limits reported for this account.\n';
      }
      for (const b of buckets) {
        if (typeof b.utilization !== 'number') continue;
        output += `${bucketLabel(b).padEnd(18)} ${bar(b.utilization)}`;
        output += b.resetsAt ? `   resets ${formatTimestamp(b.resetsAt)}\n` : '\n';
      }

      if (raw.extraUsage) {
        output += `\nExtra usage beyond the plan: ${JSON.stringify(raw.extraUsage)}\n`;
      }

      output += `\nLast fetch: ${formatTimestamp(raw.lastFetch)}\n`;
      if (isStale(raw)) {
        output += `STALE - these figures are not confirmed current${raw.error ? `: ${raw.error}` : '.'}\n`;
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

      // Careful what this promises: the MCP server is registered globally in
      // ~/.claude.json, so it runs whether or not Claude Terminal is open, and
      // with the app closed nothing consumes the request. Claiming otherwise
      // would be the same false assurance this tool was fixed for.
      return ok('Refresh requested. If Claude Terminal is running it consumes this request and rewrites usage.json within a few seconds — call usage_get again and compare its "Last fetch". If the app is closed the request simply waits, and usage_get keeps serving the last mirrored figures marked STALE. Note the refresh does not re-read the credential store, so it will not recover an account signed out from outside the app.');
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
