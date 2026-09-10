/**
 * @doc mention source — reference a workspace KB document.
 * Distinct from @workspace (which attaches the whole workspace context).
 */

const { workspaceState } = require('../../state/workspace.state');

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>'
  + '<polyline points="14,2 14,8 20,8"/>'
  + '<line x1="8" y1="13" x2="16" y2="13"/>'
  + '<line x1="8" y1="17" x2="14" y2="17"/></svg>';

module.exports = {
  id: 'workspaceDoc',
  keyword: '@doc',
  prefix: '?',
  surfaces: ['mention', 'palette'],
  scope: 'workspace',
  label: () => {
    try { return require('../../i18n').t('chat.mentionDoc') || 'Workspace docs'; }
    catch { return 'Workspace docs'; }
  },
  icon: ICON,

  async getData(ctx = {}) {
    const state = workspaceState.get();
    const activeId = state.activeWorkspaceId;
    if (!activeId) return [];

    const local = (state.docs || []).map(d => ({
      id: d.id,
      title: d.title || d.id,
      summary: d.summary || '',
      tags: d.tags || [],
      icon: d.icon || '📄',
      workspaceId: activeId,
      updatedAt: d.updatedAt || 0,
    }));

    const q = String(ctx.query || '').trim();
    if (!q) return local;

    // The loaded index carries titles and summaries only. A query also gets the
    // full-text pass over doc *bodies*, which is where most of a KB actually
    // lives — merged in by id so a doc matching both ways appears once.
    let matches = [];
    try {
      const res = await window.electron_api?.workspace?.searchDocs({ workspaceId: activeId, query: q });
      if (res?.success && Array.isArray(res.results)) matches = res.results;
    } catch {
      // Search is an enhancement over the in-memory index, never a precondition.
    }

    const byId = new Map(local.map(d => [d.id, d]));
    for (const m of matches) {
      const id = m.id || m.docId;
      if (!id) continue;
      const existing = byId.get(id);
      if (existing) {
        if (!existing.summary && m.snippet) existing.summary = m.snippet;
      } else {
        byId.set(id, {
          id,
          title: m.title || id,
          summary: m.snippet || '',
          tags: m.tags || [],
          icon: m.icon || '📄',
          workspaceId: activeId,
          updatedAt: m.updatedAt || 0,
        });
      }
    }
    return [...byId.values()];
  },

  /**
   * A body-only hit has nothing matching in its title or summary, so the default
   * label filter would drop exactly the rows full-text search just earned.
   * Title matches are kept ahead of body-only ones.
   */
  filter(items, query) {
    const q = String(query || '').trim();
    if (!q) return items;
    const registry = require('../MentionSourceRegistry');
    return [...items].sort((a, b) => {
      const am = registry.fuzzyMatch(q, a.title).match ? 1 : 0;
      const bm = registry.fuzzyMatch(q, b.title).match ? 1 : 0;
      return bm - am;
    });
  },

  render(item) {
    return {
      emoji: item.icon,
      icon: ICON,
      label: item.title,
      sublabel: item.summary || (item.tags.length ? item.tags.join(', ') : ''),
    };
  },

  getChipData(item) {
    return {
      type: 'workspaceDoc',
      label: `@${item.title.slice(0, 40)}`,
      data: { docId: item.id, title: item.title, workspaceId: item.workspaceId },
    };
  },

  onSelect(item, consumer, api = {}) {
    if (consumer === 'mention') {
      const chip = this.getChipData(item);
      api.addMentionChip?.(chip.type, chip.data);
      api.closeDropdown?.();
      return;
    }
    const nav = require('./_navigate');
    (async () => {
      document.querySelector('[data-tab="workspace"]')?.click();
      // WorkspacePanel writes `data-docid` (one word), read back as dataset.docid.
      const el = await nav.waitForByData('.workspace-doc-item', 'docid', item.id);
      nav.reveal(el);
      el?.click();
    })();
  },
};
