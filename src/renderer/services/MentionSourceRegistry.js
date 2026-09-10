/**
 * MentionSourceRegistry
 * -----------------------------------------------------------------------------
 * Pluggable registry that feeds both:
 *   - ChatView @-mention dropdown (surface = 'mention')
 *   - Command Palette / Ctrl+P quick picker (surface = 'palette')
 *
 * A source contract:
 * {
 *   id:       string                unique, e.g. 'kanban'
 *   keyword:  string                chat trigger, e.g. '@kanban'
 *   prefix:   string|null           palette quick prefix, e.g. '$'
 *   label:    () => string          i18n label used in UI
 *   icon:     string                SVG markup (must be sanitizable)
 *   surfaces: string[]              ['mention'] | ['palette'] | ['mention','palette']
 *   scope:    'global' | 'project' | 'workspace'
 *
 *   // Data pipeline
 *   getData(ctx): Promise<item[]>   ctx = { project, workspace, query }
 *   filter?(items, q): item[]       default = fuzzy on .label / .sublabel
 *   score?(item, q): number         default = fuzzy score
 *
 *   // Presentation
 *   render(item): {
 *     icon?: string, emoji?: string, color?: string,
 *     label: string, sublabel?: string, badge?: string
 *   }
 *
 *   // Actions
 *   onSelect(item, consumer, api): void | Promise<void>
 *     consumer = 'mention' | 'palette'
 *     api      = { addMentionChip?, insertText?, openPanel?, closeDropdown? }
 *
 *   // Optional: what to attach to the chat message when picked via @-mention
 *   getChipData?(item): { type, label, data }
 * }
 * -----------------------------------------------------------------------------
 */

const _sources = new Map();

/**
 * Register a source. Later registrations with the same id override previous.
 */
function register(source) {
  if (!source || !source.id) throw new Error('[MentionSourceRegistry] source.id required');
  if (!Array.isArray(source.surfaces) || source.surfaces.length === 0) {
    throw new Error(`[MentionSourceRegistry] ${source.id}: surfaces[] required`);
  }
  _sources.set(source.id, source);
}

function unregister(id) { _sources.delete(id); }

function get(id) { return _sources.get(id) || null; }

function getAll() { return [..._sources.values()]; }

/**
 * Return all sources available for a given surface ('mention' | 'palette').
 */
function forSurface(surface) {
  return getAll().filter(s => s.surfaces.includes(surface));
}

/**
 * Lookup by chat keyword, e.g. '@kanban'.
 */
function byKeyword(keyword) {
  return getAll().find(s => s.keyword === keyword) || null;
}

/**
 * Lookup palette prefix, e.g. '$'.
 */
function byPrefix(prefix) {
  return getAll().find(s => s.prefix === prefix) || null;
}

// ── Diacritic-insensitive folding ────────────────────────────────────────────
//
// Every matcher in the app searches strings the user reads, and those strings
// are translated into five locales — two of which (fr, es) are full of accents.
// Typing "reglage" must find "Réglage" and "telemetrie" must find "Télémétrie",
// otherwise search only works for people who type accents on the first try.
//
// Folding is done per source character rather than on the whole string so the
// match indices can be mapped back onto the *original* text for highlighting.
// A precomposed "é" folds to one char; the decomposed form ("e" + U+0301) folds
// to one char too, with the combining mark contributing nothing — either way the
// returned indices still point into the string the caller is about to render.

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Fold one character: strip its diacritics and lowercase it.
 * May return '' (a bare combining mark) or more than one char (rare ligatures).
 */
function foldChar(ch) {
  return ch.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/**
 * Fold a string for comparison. Index alignment with the input is NOT preserved.
 * @returns {string}
 */
function foldForSearch(str) {
  return String(str == null ? '' : str).normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/**
 * Fold a string, keeping a folded-index → original-index map.
 * @returns {{ folded: string, map: number[] }}
 */
function foldWithMap(str) {
  const src = String(str == null ? '' : str);
  let folded = '';
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const f = foldChar(src[i]);
    for (let k = 0; k < f.length; k++) { folded += f[k]; map.push(i); }
  }
  return { folded, map };
}

/**
 * Case- and diacritic-insensitive substring match.
 * @returns {{ match: boolean, index: number, indices: number[] }}
 *   `indices` are positions in the ORIGINAL string, ready for highlighting.
 */
function substringMatch(query, str) {
  const q = foldForSearch(query).trim();
  if (!q) return { match: true, index: 0, indices: [] };
  const { folded, map } = foldWithMap(str);
  const at = folded.indexOf(q);
  if (at === -1) return { match: false, index: -1, indices: [] };

  // Map the folded range back onto original character positions. Any original
  // char whose folded output falls inside the range is part of the match.
  const first = map[at];
  const last = map[at + q.length - 1];
  const indices = [];
  for (let i = first; i <= last; i++) indices.push(i);
  return { match: true, index: first, indices };
}

// ── Shared fuzzy matcher (kept identical to QuickPicker.js to preserve UX) ──
function fuzzyMatch(query, str) {
  if (!query) return { match: true, score: 0, indices: [] };
  const q = foldForSearch(query);
  const { folded: s, map } = foldWithMap(str);
  const indices = [];
  let qi = 0, score = 0, consecutive = 0;

  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (q[qi] === s[si]) {
      indices.push(map[si]);
      consecutive++;
      score += consecutive * 2;
      if (si === 0 || /[\s\-_/\\.]/.test(s[si - 1])) score += 8;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  if (qi < q.length) return { match: false, score: 0, indices: [] };
  if (indices[0] === 0) score += 15;
  score -= (indices[indices.length - 1] || 0) * 0.3;
  return { match: true, score, indices };
}

/**
 * Default filter + sort. Sources can override with their own `filter`.
 */
function defaultFilter(items, query) {
  const q = (query || '').trim();
  if (!q) return items;
  const out = [];
  for (const item of items) {
    const r = item.render ? item.render() : item;
    const lm = fuzzyMatch(q, r.label || '');
    if (lm.match) { out.push({ item, score: lm.score }); continue; }
    if (r.sublabel) {
      const sm = fuzzyMatch(q, r.sublabel);
      if (sm.match) out.push({ item, score: sm.score * 0.7 });
    }
  }
  return out.sort((a, b) => b.score - a.score).map(x => x.item);
}

/**
 * One-shot query: run a source end-to-end (getData → filter → cap).
 * Returns rendered items: { key, raw, icon, label, sublabel, badge, score }.
 */
async function query(sourceId, ctx = {}, opts = {}) {
  const src = get(sourceId);
  if (!src) return [];
  try { return await runOne(src, ctx, opts.max ?? 40); }
  catch { return []; }
}

/**
 * Run one source end-to-end. Never throws: a source that blows up — in getData,
 * in its own filter, or in render — degrades to zero results for its own group
 * rather than taking down the surface that asked for it.
 */
async function runOne(src, ctx, max) {
  // getData may throw synchronously (a bad destructure on ctx) as easily as it
  // may reject, so the call itself is inside the try, not just its promise.
  const raw = await Promise.resolve().then(() => src.getData(ctx));
  const items = Array.isArray(raw) ? raw : [];
  const filter = src.filter || defaultFilter;
  const decorated = items.map(r => ({ ...r, render: () => src.render(r) }));
  return filter(decorated, ctx.query).slice(0, max).map(item => ({
    raw: item,
    ...src.render(item),
  }));
}

/**
 * Fan out over every source of a surface, streaming each one's results back as
 * soon as it resolves.
 *
 * Two properties the palette depends on:
 *  - a slow source never delays a fast one (each is awaited independently, and
 *    `onSource` fires per source rather than once at the end);
 *  - the whole run is cancellable, so results from a query the user has already
 *    typed past are dropped instead of repainting the list underneath them.
 *
 * @param {string} surface 'palette' | 'mention'
 * @param {object} ctx     { project, workspace, query }
 * @param {object} opts    { onSource(src, items, error), max, filterSource(src) }
 * @returns {{ sources: object[], done: Promise<void>, cancel: () => void }}
 */
function runSources(surface, ctx = {}, opts = {}) {
  const { onSource, max = 40, filterSource } = opts;
  let cancelled = false;

  const sources = forSurface(surface).filter(s => {
    try { return filterSource ? filterSource(s) : true; } catch { return false; }
  });

  const done = Promise.all(sources.map(async (src) => {
    let items, error = null;
    try {
      items = await runOne(src, ctx, max);
    } catch (err) {
      error = err;
      items = [];
    }
    if (cancelled) return;
    try { onSource?.(src, items, error); } catch { /* a consumer bug is not a source bug */ }
  })).then(() => {});

  return { sources, done, cancel() { cancelled = true; } };
}

module.exports = {
  register,
  unregister,
  get,
  getAll,
  forSurface,
  byKeyword,
  byPrefix,
  query,
  runSources,
  fuzzyMatch,
  substringMatch,
  foldForSearch,
  foldWithMap,
  defaultFilter,
};
