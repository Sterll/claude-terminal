/**
 * model-pricing.js
 * API list prices, used to put a dollar figure on what a transcript consumed.
 *
 * On a subscription none of this is billed: the figure is what the same tokens
 * would have cost on the API, which is the closest public proxy for how much of
 * a plan's usage limit they drew. That is also what `ccusage` reports, so the
 * two can be compared.
 *
 * Prices are dollars per million tokens, from
 * https://platform.claude.com/docs/en/about-claude/pricing. A cache write costs
 * 1.25x the input price for the 5-minute TTL and 2x for the 1-hour one; a cache
 * read costs 0.1x unless the model publishes its own rate (Fable 5.1, Opus 5.5
 * and Sonnet 5.5 do). Fast mode doubles every rate.
 *
 * Haiku 5.5 is the one model priced by prompt length: a request whose prompt
 * (input, cache writes and cache reads together) is over 100,000 tokens pays
 * its `longPrompt` row for every token kind, output included. That is decided
 * per request, so only a single request can be priced from its own tokens; a
 * sum of several has to say which tier it holds (see costOf).
 *
 * An id this table does not know is priced from its family (an unknown Opus
 * costs what the current Opus costs) and flagged `estimated`, so a model that
 * ships after this file still shows up instead of silently counting as free.
 */

'use strict';

// id -> { input, output, cacheRead?, longPrompt?: { over, input, output, cacheRead } }
const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-mythos-5-1': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-7-sonnet': { input: 3, output: 15 },
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: 0.01,
    longPrompt: { over: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
};

// Family fallback for ids the table does not list yet.
const FAMILY_FALLBACK = [
  [/fable|mythos/, 'claude-fable-5-1'],
  [/opus/, 'claude-opus-5-5'],
  [/sonnet/, 'claude-sonnet-5-5'],
  [/haiku/, 'claude-haiku-5-5'],
];

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;
const FAST_MULTIPLIER = 2;

/**
 * Reduce a transcript model id to a table key: drop the `[1m]` context tag and
 * any `-YYYYMMDD` snapshot suffix.
 * @param {string} model
 * @returns {string}
 */
function normalizeModelId(model) {
  return String(model || '')
    .toLowerCase()
    .replace(/\[.*?\]$/, '')
    .replace(/-\d{8}$/, '')
    .trim();
}

/**
 * The price row for a model, or null when it cannot be placed at all.
 * @param {string} model
 * @param {{ longPrompt?: boolean }} [opts] the long-prompt tier, for a model that has one
 * @returns {{ id: string, input: number, output: number, cacheRead: number, estimated: boolean, longPromptOver: number|null }|null}
 */
function priceFor(model, { longPrompt = false } = {}) {
  const id = normalizeModelId(model);
  if (!id || id === '<synthetic>') return null;
  let key = PRICES[id] ? id : null;
  let estimated = false;
  if (!key) {
    const hit = FAMILY_FALLBACK.find(([re]) => re.test(id));
    if (!hit) return null;
    key = hit[1];
    estimated = true;
  }
  const base = PRICES[key];
  const row = longPrompt && base.longPrompt ? base.longPrompt : base;
  return {
    id: key,
    input: row.input,
    output: row.output,
    cacheRead: row.cacheRead ?? row.input * CACHE_READ,
    estimated,
    longPromptOver: base.longPrompt ? base.longPrompt.over : null,
  };
}

/**
 * Tokens one request's prompt counts toward a long-prompt threshold: every
 * input token, cached or not.
 * @param {{ input?: number, cacheWrite5m?: number, cacheWrite1h?: number, cacheRead?: number }} tokens
 * @returns {number}
 */
function promptTokens(tokens) {
  const t = tokens || {};
  return (t.input || 0) + (t.cacheWrite5m || 0) + (t.cacheWrite1h || 0) + (t.cacheRead || 0);
}

/**
 * Whether one request with these tokens pays `model`'s long-prompt tier.
 * Always false for a model without one.
 * @param {string} model
 * @param {Object} tokens
 * @returns {boolean}
 */
function isLongPrompt(model, tokens) {
  const over = priceFor(model)?.longPromptOver;
  return over != null && promptTokens(tokens) > over;
}

/**
 * Dollar cost of one token bucket.
 *
 * Without `longPrompt`, the bucket is taken to be one request and its tier is
 * read from its own tokens. A bucket that sums several requests must pass it,
 * since the sum of short prompts can cross the threshold none of them did.
 *
 * @param {string} model
 * @param {{ input?: number, output?: number, cacheWrite5m?: number, cacheWrite1h?: number, cacheRead?: number }} tokens
 * @param {{ fast?: boolean, longPrompt?: boolean }} [opts]
 * @returns {number|null} null when the model cannot be priced
 */
function costOf(model, tokens, { fast = false, longPrompt } = {}) {
  const long = longPrompt === undefined ? isLongPrompt(model, tokens) : !!longPrompt;
  const price = priceFor(model, { longPrompt: long });
  if (!price) return null;
  const t = tokens || {};
  const perToken =
    (t.input || 0) * price.input
    + (t.output || 0) * price.output
    + (t.cacheWrite5m || 0) * price.input * CACHE_WRITE_5M
    + (t.cacheWrite1h || 0) * price.input * CACHE_WRITE_1H
    + (t.cacheRead || 0) * price.cacheRead;
  return (perToken / 1e6) * (fast ? FAST_MULTIPLIER : 1);
}

module.exports = { PRICES, normalizeModelId, priceFor, isLongPrompt, costOf };
