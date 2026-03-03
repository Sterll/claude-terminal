/**
 * project-config field renderer
 * Renders the Project node configuration:
 * - Action select
 * - Project select (conditional: when action !== 'list')
 * - Info hint (when action === 'list')
 */
const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderProjectSection(action, props) {
  if (action === 'list') {
    return `<div class="wf-step-edit-field">
  <span class="wf-field-hint">${t('workflow.project.listHint')}</span>
</div>`;
  }
  const projects =
    (typeof window !== 'undefined' && window._projectsState?.get?.()?.projects) || [];
  const optionsList = projects
    .map(p => `<option value="${esc(p.id)}"${props.projectId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.project.projectLabel')}</label>
  <span class="wf-field-hint">${t('workflow.project.projectHint')}</span>
  <select class="wf-step-edit-input wf-node-prop wf-project-select" data-key="projectId">
    <option value="">${t('workflow.project.selectProject')}</option>
    ${optionsList}
  </select>
</div>`;
}

module.exports = {
  type: 'project-config',

  render(field, value, node) {
    const props = node.properties || {};
    const action = props.action || 'list';

    return `<div class="wf-field-group" data-key="action">
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.project.actionLabel')}</label>
  <span class="wf-field-hint">${t('workflow.project.actionHint')}</span>
  <select class="wf-step-edit-input wf-node-prop wf-project-action-select" data-key="action">
    <option value="list"${action === 'list' ? ' selected' : ''}>${t('workflow.project.actionList')}</option>
    <option value="set_context"${action === 'set_context' ? ' selected' : ''}>${t('workflow.project.actionSetContext')}</option>
    <option value="open"${action === 'open' ? ' selected' : ''}>${t('workflow.project.actionOpen')}</option>
    <option value="build"${action === 'build' ? ' selected' : ''}>${t('workflow.project.actionBuild')}</option>
    <option value="install"${action === 'install' ? ' selected' : ''}>${t('workflow.project.actionInstall')}</option>
    <option value="test"${action === 'test' ? ' selected' : ''}>${t('workflow.project.actionTest')}</option>
  </select>
</div>
<div class="wf-project-conditional">
${renderProjectSection(action, props)}
</div>
</div>`;
  },

  bind(container, field, node, onChange) {
    const actionSel = container.querySelector('.wf-project-action-select');
    if (!actionSel) return;

    actionSel.addEventListener('change', () => {
      const action = actionSel.value;
      node.properties.action = action;
      onChange(action);

      const condDiv = container.querySelector('.wf-project-conditional');
      if (condDiv) {
        condDiv.innerHTML = renderProjectSection(action, node.properties || {});

        // Bind project select if present
        const projSel = condDiv.querySelector('.wf-project-select');
        if (projSel) {
          projSel.addEventListener('change', () => { node.properties.projectId = projSel.value; });
        }
      }
    });

    // Bind initial project select
    const projSel = container.querySelector('.wf-project-select');
    if (projSel) {
      projSel.addEventListener('change', () => { node.properties.projectId = projSel.value; });
    }
  },
};
