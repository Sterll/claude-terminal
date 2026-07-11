const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

/**
 * variable-autocomplete field
 *
 * Renders a plain text input marked with `.wf-node-prop`. Two things then wire
 * it up automatically inside WorkflowPanel:
 *   - the generic property binding writes the value + flags the draft dirty;
 *   - `setupAutocomplete()` attaches the real `$variable` dropdown (it scans for
 *     `input.wf-node-prop` fields).
 *
 * The previous implementation used a bespoke `.wf-var-input` class (invisible to
 * both systems) and a keyup handler that only ever hid an empty dropdown, so the
 * field was effectively dead. Delegating to the shared machinery makes it live.
 */
module.exports = {
  type: 'variable-autocomplete',

  render(field, value, node) {
    return `<div class="wf-step-edit-field" data-key="${escapeAttr(field.key)}">
  <label class="wf-step-edit-label">${escapeHtml(field.label || field.key)}</label>
  <input type="text" class="wf-step-edit-input wf-node-prop wf-field-mono"
         value="${escapeAttr(value || '')}"
         placeholder="${escapeAttr(t('workflow.variable.placeholder'))}"
         data-key="${escapeAttr(field.key)}" />
</div>`;
  },

  // No custom bind needed: the generic wf-node-prop binding + setupAutocomplete
  // (both run in WorkflowPanel.renderProperties) handle value writes and the
  // $variable dropdown.
  bind() {},
};
