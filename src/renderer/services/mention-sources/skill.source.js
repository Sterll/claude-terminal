/**
 * @skill mention source — attach a skill (SKILL.md) as context,
 * or open the skill in palette mode.
 */

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
  + '<path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>';

module.exports = {
  id: 'skill',
  keyword: '@skill',
  prefix: '!',
  surfaces: ['mention', 'palette'],
  scope: 'global',
  label: () => {
    try { return require('../../i18n').t('chat.mentionSkill') || 'Skills'; }
    catch { return 'Skills'; }
  },
  icon: ICON,

  getData() {
    const skills = window._skillsAgentsState?.skills || [];
    return skills.map(s => ({
      id: s.name || s.id,
      name: s.name || s.id,
      description: s.description || '',
      source: s.source || 'local',
      path: s.path || '',
    }));
  },

  render(item) {
    return {
      icon: ICON,
      label: item.name,
      sublabel: item.description || item.source,
      badge: item.source && item.source !== 'local' ? item.source : null,
    };
  },

  getChipData(item) {
    return {
      type: 'skill',
      label: `@${item.name}`,
      data: { skillId: item.id, name: item.name, path: item.path },
    };
  },

  onSelect(item, consumer, api = {}) {
    if (consumer === 'mention') {
      const chip = this.getChipData(item);
      api.addMentionChip?.(chip.type, chip.data);
      api.closeDropdown?.();
      return;
    }
    document.querySelector('[data-tab="skills"]')?.click();
    setTimeout(() => {
      const el = document.querySelector(`[data-skill-id="${item.id}"]`);
      el?.click();
    }, 150);
  },
};
