const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');
const { accountChoices, hasAccountChoice } = require('../utils/accountChoices');

/**
 * Which Claude account a Claude node runs as. Passive: the select carries
 * `wf-node-prop`, so WorkflowPanel's generic loop writes the value back.
 */
module.exports = {
  type: 'account-picker',

  render(field, value) {
    const selected = typeof value === 'string' ? value : '';
    if (!hasAccountChoice(selected)) return '';
    const options = accountChoices(selected).map(c =>
      `<option value="${escapeAttr(c.value)}"${c.value === selected ? ' selected' : ''}>${escapeHtml(c.label)}</option>`).join('');
    return `<div class="wf-step-edit-field wf-field-group" data-key="${escapeAttr(field.key)}">
  <label class="wf-step-edit-label">${escapeHtml(t(field.label || 'automation.form.account'))}</label>
  <select class="wf-step-edit-input wf-node-prop" data-key="${escapeAttr(field.key)}">${options}</select>
</div>`;
  },
};
