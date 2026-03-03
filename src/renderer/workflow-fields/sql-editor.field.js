const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

module.exports = {
  type: 'sql-editor',

  render(field, value, node) {
    return `<div class="wf-field-group" data-key="${escapeAttr(field.key)}">
  <label class="wf-field-label">${escapeHtml(field.label || 'SQL')}</label>
  <textarea class="wf-textarea wf-sql-textarea" rows="5" data-key="${escapeAttr(field.key)}"
            placeholder="SELECT * FROM table WHERE id = {{id}}">${escapeHtml(value || '')}</textarea>
  <div class="wf-sql-hints">
    <span class="wf-hint">${t('workflow.sql.tip')}</span>
  </div>
</div>`;
  },

  bind(container, field, node, onChange) {
    const ta = container.querySelector('.wf-sql-textarea');
    if (!ta) return;
    ta.addEventListener('input', () => onChange(ta.value));
  },
};
