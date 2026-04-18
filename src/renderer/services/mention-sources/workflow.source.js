/**
 * @workflow mention source — reference workflow definitions in chat / palette.
 */

const { workflowsState } = require('../../state/workflows.state');

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/>'
  + '<path d="M7 6h10M6 8l5 8M18 8l-5 8"/></svg>';

module.exports = {
  id: 'workflow',
  keyword: '@workflow',
  prefix: '%',
  surfaces: ['mention', 'palette'],
  scope: 'global',
  label: () => {
    try { return require('../../i18n').t('chat.mentionWorkflow') || 'Workflows'; }
    catch { return 'Workflows'; }
  },
  icon: ICON,

  getData() {
    const workflows = workflowsState.get().workflows || [];
    return workflows.map(w => ({
      id: w.id,
      name: w.name || '(unnamed)',
      description: w.description || '',
      enabled: !!w.enabled,
      triggerType: w.trigger?.type || null,
      stepCount: (w.steps || w.nodes || []).length,
    }));
  },

  render(item) {
    const parts = [];
    if (item.triggerType) parts.push(item.triggerType);
    if (item.stepCount) parts.push(`${item.stepCount} nodes`);
    return {
      icon: ICON,
      label: item.name,
      sublabel: parts.join(' · ') || item.description,
      badge: item.enabled ? 'on' : null,
    };
  },

  getChipData(item) {
    return {
      type: 'workflow',
      label: `@${item.name.slice(0, 40)}`,
      data: { workflowId: item.id, name: item.name, triggerType: item.triggerType },
    };
  },

  onSelect(item, consumer, api = {}) {
    if (consumer === 'mention') {
      const chip = this.getChipData(item);
      api.addMentionChip?.(chip.type, chip.data);
      api.closeDropdown?.();
      return;
    }
    document.querySelector('[data-tab="workflows"]')?.click();
    setTimeout(() => {
      const el = document.querySelector(`[data-workflow-id="${item.id}"]`);
      el?.click();
    }, 150);
  },
};
