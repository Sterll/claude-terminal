/**
 * context-usage.js
 * How much of the context window a turn actually occupies.
 *
 * `input_tokens` alone is not it, and the difference is not marginal: the API
 * reports only the *uncached* prefix there, so a long conversation reads as a
 * handful of tokens while a quarter of a million sit in the cache. A real turn
 * from this app:
 *
 *   input_tokens: 2, cache_creation_input_tokens: 1675,
 *   cache_read_input_tokens: 232050
 *
 * The window holds all three. Reading `input_tokens` on its own made the chat's
 * context gauge report "2 / 1000K", which is why this lives in one place used
 * by both the live stream (renderer) and the session replay (main).
 */

'use strict';

const positive = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);

/**
 * @param {object|null|undefined} usage An Anthropic usage object, from either an
 *   SDK result message or a session JSONL line.
 * @returns {number} tokens occupying the context window; 0 when unknown.
 */
function contextTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return positive(usage.input_tokens)
    + positive(usage.cache_read_input_tokens)
    + positive(usage.cache_creation_input_tokens);
}

/**
 * Occupancy read off one message frame — the only usage figure that is an
 * occupancy at all.
 *
 * A single API call's input side *is* what sat in the window when it was made.
 * A turn's total is not: the SDK result message sums every call the turn made,
 * so five tool round-trips over a 300K conversation add up to 1.5M and the
 * gauge reported "1.1M / 1M (109%)" on a window that was never over.
 *
 * Two frames measure the window without an API call behind them:
 *
 * - A compact boundary says what survived (`post_tokens`, camel-cased in the
 *   session file) on CLIs new enough to report it. Nothing with a usage follows
 *   it until the next reply — only the summary and the prompts — so without
 *   this a resume right after /compact opens on the figure from *before* the
 *   compaction.
 * - `/context` answers with a synthetic assistant frame whose usage is all
 *   zeros; its structured twin carries the CLI's own count of the window.
 *
 * Frames from a subagent or a sidechain carry their own separate window, so
 * they measure someone else's context and are skipped rather than mistaken for
 * the main loop's.
 *
 * @param {object|null|undefined} msg An SDK stream message, or a session JSONL
 *   line (same `{ message: { usage } }` shape).
 * @returns {number} tokens in the main loop's window; 0 when the frame does not
 *   measure it.
 */
function contextTokensFromMessage(msg) {
  if (!msg || typeof msg !== 'object') return 0;
  if (msg.parent_tool_use_id || msg.subagent_type || msg.isSidechain) return 0;
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    const meta = msg.compact_metadata || msg.compactMetadata || {};
    return positive(meta.post_tokens) || positive(meta.postTokens);
  }
  return positive(msg.context_usage?.total_tokens)
    || contextTokensFromUsage(msg.message?.usage);
}

module.exports = { contextTokensFromUsage, contextTokensFromMessage };
