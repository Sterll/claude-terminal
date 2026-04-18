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

  getData() {
    const state = workspaceState.get();
    const activeId = state.activeWorkspaceId;
    if (!activeId) return [];
    return (state.docs || []).map(d => ({
      id: d.id,
      title: d.title || d.id,
      summary: d.summary || '',
      tags: d.tags || [],
      icon: d.icon || '📄',
      workspaceId: activeId,
      updatedAt: d.updatedAt || 0,
    }));
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
    document.querySelector('[data-tab="workspace"]')?.click();
    setTimeout(() => {
      const el = document.querySelector(`[data-doc-id="${item.id}"]`);
      el?.click();
    }, 150);
  },
};
