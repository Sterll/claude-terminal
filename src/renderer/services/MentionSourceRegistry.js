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

// ── Shared fuzzy matcher (kept identical to QuickPicker.js to preserve UX) ──
function fuzzyMatch(query, str) {
  if (!query) return { match: true, score: 0, indices: [] };
  const q = query.toLowerCase();
  const s = (str || '').toLowerCase();
  const indices = [];
  let qi = 0, score = 0, consecutive = 0;

  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (q[qi] === s[si]) {
      indices.push(si);
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
  const raw = await Promise.resolve(src.getData(ctx)).catch(() => []);
  const filter = src.filter || defaultFilter;
  const filtered = filter(raw.map(r => ({ ...r, render: () => src.render(r) })), ctx.query);
  const max = opts.max ?? 40;
  return filtered.slice(0, max).map(item => ({
    raw: item,
    ...src.render(item),
  }));
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
  fuzzyMatch,
  defaultFilter,
};
