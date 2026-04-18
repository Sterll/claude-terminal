/**
 * @kanban mention source
 * -----------------------------------------------------------------------------
 * Exposes Kanban cards from all projects (current project first) to:
 *   - Chat @kanban mentions (attach a card as context)
 *   - Command Palette (jump to Kanban panel with the card focused)
 * -----------------------------------------------------------------------------
 */

const { projectsState } = require('../../state/projects.state');

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<rect x="3" y="3" width="7" height="18" rx="1"/>'
  + '<rect x="14" y="3" width="7" height="10" rx="1"/>'
  + '<line x1="5" y1="8" x2="8" y2="8"/>'
  + '<line x1="5" y1="12" x2="8" y2="12"/>'
  + '<line x1="16" y1="7" x2="19" y2="7"/></svg>';

/**
 * Flatten all tasks across all projects into mention-ready items.
 * Priority: current-project tasks first, then others (more recently updated first).
 */
function collectTasks(currentProjectId) {
  const { projects } = projectsState.get();
  const items = [];
  for (const project of projects || []) {
    const tasks = project.tasks || [];
    const columns = project.kanbanColumns || [];
    for (const task of tasks) {
      const column = columns.find(c => c.id === task.columnId);
      items.push({
        id: task.id,
        title: task.title || '(untitled)',
        description: task.description || '',
        columnName: column?.name || task.columnId || '',
        columnColor: column?.color || null,
        labels: task.labels || [],
        priority: task.priority || null,
        projectId: project.id,
        projectName: project.name || '',
        updatedAt: task.updatedAt || 0,
        isCurrent: project.id === currentProjectId,
      });
    }
  }
  items.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return items;
}

function buildSublabel(item) {
  const parts = [];
  if (!item.isCurrent) parts.push(item.projectName);
  if (item.columnName) parts.push(item.columnName);
  if (item.priority) parts.push(item.priority);
  return parts.join(' · ');
}

module.exports = {
  id: 'kanban',
  keyword: '@kanban',
  prefix: '$',
  surfaces: ['mention', 'palette'],
  scope: 'global',
  label: () => {
    try { return require('../../i18n').t('chat.mentionKanban') || 'Kanban cards'; }
    catch { return 'Kanban cards'; }
  },
  icon: ICON,

  getData(ctx = {}) {
    const currentProjectId = ctx.project?.id || null;
    return collectTasks(currentProjectId);
  },

  render(item) {
    return {
      icon: ICON,
      label: item.title,
      sublabel: buildSublabel(item),
      badge: item.labels?.length ? String(item.labels.length) : null,
      color: item.columnColor,
    };
  },

  getChipData(item) {
    return {
      type: 'kanban',
      label: `@${item.title.slice(0, 40)}`,
      data: {
        taskId: item.id,
        projectId: item.projectId,
        title: item.title,
        description: item.description,
        column: item.columnName,
        labels: item.labels,
      },
    };
  },

  onSelect(item, consumer, api = {}) {
    if (consumer === 'mention') {
      const chip = this.getChipData(item);
      api.addMentionChip?.(chip.type, chip.data);
      api.closeDropdown?.();
      return;
    }
    if (consumer === 'palette') {
      const kanbanTab = document.querySelector('[data-tab="kanban"]');
      kanbanTab?.click();
      setTimeout(() => {
        const card = document.querySelector(`[data-task-id="${item.id}"]`);
        card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card?.classList.add('kanban-card-focus');
        setTimeout(() => card?.classList.remove('kanban-card-focus'), 1600);
      }, 120);
    }
  },
};
