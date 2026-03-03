/**
 * subworkflow-picker field renderer
 * Renders the Subworkflow node configuration:
 * - Workflow select (from _workflowsListCache)
 * - Input vars textarea
 * - Wait for completion select
 */
const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  type: 'subworkflow-picker',

  render(field, value, node) {
    const props = node.properties || {};
    const workflows =
      (typeof window !== 'undefined' && window._workflowsListCache) || [];

    const optionsList = workflows
      .filter(w => w.id !== (props._workflowId || ''))
      .map(w => `<option value="${esc(w.id)}"${props.workflow === w.id ? ' selected' : ''}>${esc(w.name)}</option>`)
      .join('');

    const waitValue = String(props.waitForCompletion !== false && props.waitForCompletion !== 'false');

    return `<div class="wf-field-group" data-key="workflow">
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.subworkflow.workflowLabel')}</label>
  <span class="wf-field-hint">${t('workflow.subworkflow.workflowHint')}</span>
  <select class="wf-step-edit-input wf-node-prop" data-key="workflow">
    <option value="">${t('workflow.subworkflow.selectWorkflow')}</option>
    ${optionsList}
  </select>
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.subworkflow.inputVarsLabel')}</label>
  <span class="wf-field-hint">${t('workflow.subworkflow.inputVarsHint')}</span>
  <textarea class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="inputVars"
    rows="3" placeholder='{"key": "$node_1.output"}'>${esc(props.inputVars || '')}</textarea>
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.subworkflow.waitLabel')}</label>
  <span class="wf-field-hint">${t('workflow.subworkflow.waitHint')}</span>
  <select class="wf-step-edit-input wf-node-prop" data-key="waitForCompletion">
    <option value="true"${waitValue === 'true' ? ' selected' : ''}>${t('workflow.subworkflow.waitYes')}</option>
    <option value="false"${waitValue === 'false' ? ' selected' : ''}>${t('workflow.subworkflow.waitNo')}</option>
  </select>
</div>
</div>`;
  },

  bind(container, field, node, onChange) {
    // Standard wf-node-prop binding is handled by WorkflowPanel.
    // No extra custom binding needed for this field.
  },
};
