const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

module.exports = {
  type: 'skill-picker',

  render(field, value, node) {
    const skills =
      (typeof window !== 'undefined' && window._skillsAgentsState?.skills) || [];

    if (!skills.length) {
      return `<div class="wf-field-group" data-key="${escapeAttr(field.key)}">
  <label class="wf-field-label">${escapeHtml(field.label || 'Skill')}</label>
  <div class="wf-skill-grid wf-skill-grid--empty">
    <span class="wf-hint">${t('workflow.claude.noSkills')}</span>
  </div>
</div>`;
    }

    const cards = skills
      .map(s => {
        const isSelected = s.id === value;
        return `<div class="wf-skill-card${isSelected ? ' selected' : ''}" data-id="${escapeAttr(s.id)}" title="${escapeAttr(s.description || '')}">
  <span class="wf-skill-card-name">${escapeHtml(s.name)}</span>
</div>`;
      })
      .join('');

    return `<div class="wf-field-group" data-key="${escapeAttr(field.key)}">
  <label class="wf-field-label">${escapeHtml(field.label || 'Skill')}</label>
  <div class="wf-skill-grid">${cards}</div>
</div>`;
  },

  bind(container, field, node, onChange) {
    container.querySelectorAll('.wf-skill-card').forEach(card => {
      card.addEventListener('click', () => {
        container
          .querySelectorAll('.wf-skill-card')
          .forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        onChange(card.dataset.id);
      });
    });
  },
};
