'use strict';

/**
 * Tolerant name resolution for MCP tools.
 *
 * Exists for voice control: speech-to-text never returns "marvel-quiz", it
 * returns "marvel quiz", "Marvel Quiz" or "marvelle quiz". Exact matching makes
 * every spoken project name fail.
 *
 * Resolution walks tiers from strictest to loosest and stops at the FIRST tier
 * that produces candidates. Within a tier, more than one candidate means
 * ambiguous — never guess, hand the candidates back so the caller can ask.
 * Falling through on ambiguity would let a looser tier silently pick a winner.
 *
 * Not exported as a tool module: the `_` prefix keeps the MCP loader from
 * registering it (no `tools` / `handle` export).
 */

/**
 * Fold a spoken or typed name into a comparable form: lowercase, no accents,
 * every separator (space, hyphen, underscore, dot, slash) treated the same.
 */
function normalize(str) {
  return String(str == null ? '' : str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Levenshtein distance, abandoned as soon as it exceeds `max`. */
function boundedLevenshtein(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowBest = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowBest) rowBest = curr[j];
    }
    if (rowBest > max) return max + 1;
    const swap = prev; prev = curr; curr = swap;
  }
  return prev[b.length];
}

/** How far apart two normalized names may be and still be the same thing. */
function fuzzyTolerance(query) {
  if (query.length < 4) return 0;      // too short to guess safely
  return Math.max(1, Math.floor(query.length / 5));
}

/**
 * Resolve `query` against `items`.
 *
 * @param {string} query
 * @param {Array<object>} items
 * @param {(item: object) => Array<string|undefined>} getNames
 *        Every name an item answers to. The first entry is treated as an exact
 *        identifier (ids are never fuzzy-matched).
 * @returns {{match: object|null, tier: string|null, candidates: Array<object>}}
 *          `candidates` is non-empty only when the outcome was ambiguous.
 */
function resolve(query, items, getNames) {
  const raw = String(query == null ? '' : query).trim();
  if (!raw || !Array.isArray(items) || !items.length) {
    return { match: null, tier: null, candidates: [] };
  }

  // Tier 0: identifier. Exact, case-sensitive, never fuzzy.
  for (const item of items) {
    const [id] = getNames(item);
    if (id && id === raw) return { match: item, tier: 'id', candidates: [] };
  }

  const needle = normalize(raw);
  if (!needle) return { match: null, tier: null, candidates: [] };

  const entries = items.map(item => ({
    item,
    names: getNames(item).filter(Boolean).map(normalize).filter(Boolean),
  }));

  const tiers = [
    ['exact', (names) => names.some(n => n === needle)],
    ['prefix', (names) => names.some(n => n.startsWith(needle))],
    // Reverse containment ("open the marvel quiz project" -> "marvel-quiz")
    // only for names long enough to be meaningful; a 1-2 char name would
    // otherwise match almost any phrase.
    ['contains', (names) => names.some(n => n.includes(needle) || (n.length >= 3 && needle.includes(n)))],
    ['fuzzy', (names) => {
      const tolerance = fuzzyTolerance(needle);
      if (!tolerance) return false;
      return names.some(n => boundedLevenshtein(n, needle, tolerance) <= tolerance);
    }],
  ];

  for (const [tier, test] of tiers) {
    const hits = entries.filter(e => test(e.names));
    if (hits.length === 1) return { match: hits[0].item, tier, candidates: [] };
    // Two or more at this tier: genuinely ambiguous. Stop rather than let a
    // looser tier arbitrate.
    if (hits.length > 1) return { match: null, tier, candidates: hits.map(h => h.item) };
  }

  return { match: null, tier: null, candidates: [] };
}

module.exports = { normalize, boundedLevenshtein, resolve };
