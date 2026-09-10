/**
 * @knowledge mention source — Global Knowledge entries.
 * -----------------------------------------------------------------------------
 * Global knowledge is the one store that is in scope for every project, so it
 * belongs in the palette from anywhere. Two IPC calls back it:
 *   - `knowledge.search(q)` when something is typed: it reads entry *bodies*,
 *     which is the whole point — a fact you half-remember is rarely in a title.
 *   - `knowledge.list()` otherwise, for the browse case.
 * The list answer is cached briefly; the search answer never is, since it is
 * already query-specific and the file reads behind it are the expensive part.
 * -----------------------------------------------------------------------------
 */

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3z"/>'
  + '<path d="M5 13.18v4L12 21l7-3.82v-4"/></svg>';

const LIST_TTL = 30_000;
let _listCache = null; // { ts, entries }

async function loadAll() {
  if (_listCache && Date.now() - _listCache.ts < LIST_TTL) return _listCache.entries;
  const res = await window.electron_api?.knowledge?.list();
  const entries = res?.success && Array.isArray(res.entries) ? res.entries : [];
  _listCache = { ts: Date.now(), entries };
  return entries;
}

async function search(query) {
  const res = await window.electron_api?.knowledge?.search(query);
  return res?.success && Array.isArray(res.results) ? res.results : [];
}

/** Collapse a body snippet to something that fits on one palette line. */
function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

module.exports = {
  id: 'knowledge',
  keyword: '@knowledge',
  prefix: null,
  surfaces: ['mention', 'palette'],
  scope: 'global',
  label: () => {
    try { return require('../../i18n').t('chat.mentionKnowledge') || 'Global knowledge'; }
    catch { return 'Global knowledge'; }
  },
  icon: ICON,

  async getData(ctx = {}) {
    const q = String(ctx.query || '').trim();
    const entries = q ? await search(q) : await loadAll();
    return entries.map(e => ({
      id: e.id,
      title: e.title || e.id,
      summary: e.summary || '',
      snippet: e.snippet || '',
      category: e.category || 'other',
      tags: e.tags || [],
      aliases: e.aliases || [],
      pinned: !!e.pinned,
    }));
  },

  /**
   * The search IPC already matched on title, aliases, tags, summary AND body.
   * Re-filtering here on the label alone would throw away exactly the results
   * that make body search worth doing, so a query pass keeps everything and
   * only the browse pass (no query) is left untouched.
   */
  filter(items) {
    return items;
  },

  render(item) {
    const sub = item.summary || oneLine(item.snippet) || item.tags.join(', ');
    return {
      icon: ICON,
      label: item.title,
      sublabel: sub,
      badge: item.pinned ? '📌' : null,
    };
  },

  getChipData(item) {
    return {
      type: 'knowledge',
      label: `@${item.title.slice(0, 40)}`,
      data: { entryId: item.id, title: item.title, summary: item.summary },
    };
  },

  onSelect(item, consumer, api = {}) {
    if (consumer === 'mention') {
      const chip = this.getChipData(item);
      api.addMentionChip?.(chip.type, chip.data);
      api.closeDropdown?.();
      return;
    }
    // Knowledge lives inside the Memory screen, under its own source entry.
    const nav = require('./_navigate');
    (async () => {
      const entry = await nav.openTab('memory', '.memory-source-item[data-source="knowledge"]');
      if (!entry) return;
      entry.click();
      // Entry ids are user-derived slugs, so the card is found by scanning
      // rather than by interpolating one into a selector.
      const card = await nav.waitForByData('.knowledge-card', 'id', item.id);
      nav.reveal(card);
      card?.click();
    })();
  },

  /** Test seam: drop the browse cache. */
  _resetCache() { _listCache = null; },
};
