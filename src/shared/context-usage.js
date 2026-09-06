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

/**
 * @param {object|null|undefined} usage An Anthropic usage object, from either an
 *   SDK result message or a session JSONL line.
 * @returns {number} tokens occupying the context window; 0 when unknown.
 */
function contextTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const n = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : 0);
  return n(usage.input_tokens)
    + n(usage.cache_read_input_tokens)
    + n(usage.cache_creation_input_tokens);
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
  return contextTokensFromUsage(msg.message?.usage);
}

module.exports = { contextTokensFromUsage, contextTokensFromMessage };
