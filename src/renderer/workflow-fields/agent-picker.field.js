const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

module.exports = {
  type: 'agent-picker',

  render(field, value, node) {
    const agents =
      (typeof window !== 'undefined' && window._skillsAgentsState?.agents) || [];

    if (!agents.length) {
      return `<div class="wf-field-group" data-key="${escapeAttr(field.key)}">
  <label class="wf-field-label">${escapeHtml(field.label || 'Agent')}</label>
  <div class="wf-agent-grid wf-agent-grid--empty">
    <span class="wf-hint">${t('workflow.claude.noAgents')}</span>
  </div>
</div>`;
    }

    const cards = agents
      .map(a => {
        const isSelected = a.id === value;
        return `<div class="wf-agent-card${isSelected ? ' selected' : ''}" data-id="${escapeAttr(a.id)}" title="${escapeAttr(a.description || '')}">
  <span class="wf-agent-card-name">${escapeHtml(a.name)}</span>
</div>`;
      })
      .join('');

    return `<div class="wf-field-group" data-key="${escapeAttr(field.key)}">
  <label class="wf-field-label">${escapeHtml(field.label || 'Agent')}</label>
  <div class="wf-agent-grid">${cards}</div>
</div>`;
  },

  bind(container, field, node, onChange) {
    container.querySelectorAll('.wf-agent-card').forEach(card => {
      card.addEventListener('click', () => {
        container
          .querySelectorAll('.wf-agent-card')
          .forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        onChange(card.dataset.id);
      });
    });
  },
};
