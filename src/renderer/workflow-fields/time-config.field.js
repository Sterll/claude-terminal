/**
 * time-config field renderer
 * Renders the Time node configuration:
 * - Action select
 * - Project ID input (conditional: get_project / get_sessions)
 * - Date range inputs (conditional: get_sessions)
 * - Output hints block
 */
const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderConditionals(action, props, nodeId) {
  const id = nodeId != null ? nodeId : 'X';
  const needsProject = action === 'get_project';
  const needsDates = action === 'get_sessions';

  const projectField = (needsProject || needsDates) ? `
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.time.projectIdLabel')}${needsDates ? t('workflow.time.optional') : ''}</label>
  <span class="wf-field-hint">${needsDates ? t('workflow.time.sessionsProjectHint') : t('workflow.time.projectIdHint')}</span>
  <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="projectId"
    value="${esc(props.projectId || '')}" placeholder="${needsDates ? '' : '$ctx.project'}" />
</div>` : '';

  const dateFields = needsDates ? `
<div class="wf-field-row">
  <div class="wf-step-edit-field wf-field-half">
    <label class="wf-step-edit-label">${t('workflow.time.startDate')}</label>
    <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="startDate"
      type="date" value="${esc(props.startDate || '')}" />
  </div>
  <div class="wf-step-edit-field wf-field-half">
    <label class="wf-step-edit-label">${t('workflow.time.endDate')}</label>
    <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="endDate"
      type="date" value="${esc(props.endDate || '')}" />
  </div>
</div>` : '';

  // Output hints per action
  let outputItems = '';
  if (action === 'get_today') {
    outputItems = `
  <code>$node_${esc(String(id))}.today</code> <span>${t('workflow.time.msToday')}</span>
  <code>$node_${esc(String(id))}.week</code> <span>${t('workflow.time.msWeek')}</span>
  <code>$node_${esc(String(id))}.month</code> <span>${t('workflow.time.msMonth')}</span>
  <code>$node_${esc(String(id))}.projects</code> <span>${t('workflow.time.projectsToday')}</span>`;
  } else if (action === 'get_week') {
    outputItems = `
  <code>$node_${esc(String(id))}.total</code> <span>${t('workflow.time.msTotalWeek')}</span>
  <code>$node_${esc(String(id))}.days</code> <span>${t('workflow.time.weekDays')}</span>`;
  } else if (action === 'get_project') {
    outputItems = `
  <code>$node_${esc(String(id))}.today</code> <span>${t('workflow.time.msToday')}</span>
  <code>$node_${esc(String(id))}.week</code> <span>${t('workflow.time.msWeek')}</span>
  <code>$node_${esc(String(id))}.total</code> <span>${t('workflow.time.msTotal')}</span>
  <code>$node_${esc(String(id))}.sessionCount</code> <span>${t('workflow.time.sessionCount')}</span>`;
  } else if (action === 'get_all_projects') {
    outputItems = `
  <code>$node_${esc(String(id))}.projects</code> <span>${t('workflow.time.allProjectsArr')}</span>
  <code>$node_${esc(String(id))}.count</code> <span>${t('workflow.time.projectCount')}</span>`;
  } else if (action === 'get_sessions') {
    outputItems = `
  <code>$node_${esc(String(id))}.sessions</code> <span>${t('workflow.time.sessionsArr')}</span>
  <code>$node_${esc(String(id))}.count</code> <span>${t('workflow.time.sessionCount')}</span>
  <code>$node_${esc(String(id))}.totalMs</code> <span>${t('workflow.time.totalMs')}</span>`;
  }

  const hintsBlock = `<div class="wf-db-output-hint wf-time-output-hints">
  <div class="wf-db-output-title">${t('workflow.time.availableOutputs')}</div>
  <div class="wf-db-output-items">${outputItems}</div>
</div>`;

  return `${projectField}${dateFields}${hintsBlock}`;
}

module.exports = {
  type: 'time-config',

  render(field, value, node) {
    const props = node.properties || {};
    const action = props.action || 'get_today';

    return `<div class="wf-field-group" data-key="action">
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.time.actionLabel')}</label>
  <span class="wf-field-hint">${t('workflow.time.actionHint')}</span>
  <select class="wf-step-edit-input wf-node-prop wf-time-action-select" data-key="action">
    <option value="get_today"${action === 'get_today' ? ' selected' : ''}>${t('workflow.time.actionToday')}</option>
    <option value="get_week"${action === 'get_week' ? ' selected' : ''}>${t('workflow.time.actionWeek')}</option>
    <option value="get_project"${action === 'get_project' ? ' selected' : ''}>${t('workflow.time.actionProject')}</option>
    <option value="get_all_projects"${action === 'get_all_projects' ? ' selected' : ''}>${t('workflow.time.actionAllProjects')}</option>
    <option value="get_sessions"${action === 'get_sessions' ? ' selected' : ''}>${t('workflow.time.actionSessions')}</option>
  </select>
</div>
<div class="wf-time-conditional">
${renderConditionals(action, props, node.id)}
</div>
</div>`;
  },

  bind(container, field, node, onChange) {
    const actionSel = container.querySelector('.wf-time-action-select');
    if (!actionSel) return;

    actionSel.addEventListener('change', () => {
      const action = actionSel.value;
      node.properties.action = action;
      onChange(action);

      const condDiv = container.querySelector('.wf-time-conditional');
      if (condDiv) {
        condDiv.innerHTML = renderConditionals(action, node.properties || {}, node.id);

        // Bind new inputs
        condDiv.querySelectorAll('.wf-node-prop').forEach(el => {
          const key = el.dataset.key;
          if (!key) return;
          el.addEventListener('input', () => { node.properties[key] = el.value; });
          el.addEventListener('change', () => { node.properties[key] = el.value; });
        });
      }
    });
  },
};
