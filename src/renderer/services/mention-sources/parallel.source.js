/**
 * @parallel mention source — reference parallel task runs.
 */

const { parallelTaskState } = require('../../state/parallelTask.state');

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>';

module.exports = {
  id: 'parallel',
  keyword: '@parallel',
  prefix: null,
  surfaces: ['mention', 'palette'],
  scope: 'project',
  label: () => {
    try { return require('../../i18n').t('chat.mentionParallel') || 'Parallel runs'; }
    catch { return 'Parallel runs'; }
  },
  icon: ICON,

  getData(ctx = {}) {
    const state = parallelTaskState.get();
    const projectId = ctx.project?.id || null;
    const all = [...(state.runs || []), ...(state.history || [])];
    return all
      .filter(r => !projectId || r.projectId === projectId)
      .map(r => ({
        id: r.runId || r.id,
        goal: r.goal || '(no goal)',
        status: r.status || 'unknown',
        taskCount: (r.tasks || []).length,
        completedTasks: (r.tasks || []).filter(t => t.status === 'completed').length,
        startedAt: r.startedAt || r.createdAt || 0,
      }))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  },

  render(item) {
    return {
      icon: ICON,
      label: item.goal,
      sublabel: `${item.completedTasks}/${item.taskCount} tasks · ${item.status}`,
      badge: item.status === 'running' ? 'live' : null,
    };
  },

  getChipData(item) {
    return {
      type: 'parallel',
      label: `@${item.goal.slice(0, 40)}`,
      data: { runId: item.id, goal: item.goal, status: item.status },
    };
  },

  onSelect(item, consumer, api = {}) {
    if (consumer === 'mention') {
      const chip = this.getChipData(item);
      api.addMentionChip?.(chip.type, chip.data);
      api.closeDropdown?.();
      return;
    }
    document.querySelector('[data-tab="parallel"]')?.click();
    setTimeout(() => {
      const el = document.querySelector(`[data-run-id="${item.id}"]`);
      el?.click();
    }, 150);
  },
};
