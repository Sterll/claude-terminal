/**
 * trigger-config field renderer
 * Renders the full trigger configuration UI:
 * - triggerType select (manual / cron / hook / on_workflow / webhook)
 * - Conditional cron expression input
 * - Conditional hookType select
 * - Conditional workflow source select
 * - Conditional webhook URL display
 */
const { escapeHtml, escapeAttr } = require('./_registry');
const { t } = require('../i18n');

function getHookTypes() {
  return [
    { value: 'PreToolUse',       label: t('workflow.trigger.hookPreToolUse') },
    { value: 'PostToolUse',      label: t('workflow.trigger.hookPostToolUse') },
    { value: 'UserPromptSubmit', label: t('workflow.trigger.hookUserPrompt') },
    { value: 'Notification',     label: t('workflow.trigger.hookNotification') },
    { value: 'Stop',             label: t('workflow.trigger.hookStop') },
  ];
}

async function _getCloudSettings() {
  try {
    const os = window.electron_nodeModules?.os;
    const path = window.electron_nodeModules?.path;
    if (!os || !path) return {};
    const { fileExists, fsp } = require('../utils/fs-async');
    const settingsPath = path.join(os.homedir(), '.claude-terminal', 'settings.json');
    if (!(await fileExists(settingsPath))) return {};
    return JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
  } catch { return {}; }
}

async function _buildWebhookUrl(workflowId) {
  const settings = await _getCloudSettings();
  const cloudUrl = (settings.cloudServerUrl || '').replace(/\/$/, '');
  if (!cloudUrl || !workflowId) return '';
  return `${cloudUrl}/api/webhook/${workflowId}`;
}

async function _renderWebhookSection(workflowId, esc) {
  const settings = await _getCloudSettings();
  const cloudUrl = (settings.cloudServerUrl || '').replace(/\/$/, '');
  const webhookUrl = await _buildWebhookUrl(workflowId);
  let noCloudHtml = '';
  if (!cloudUrl) {
    noCloudHtml = `<span class="wf-field-hint wf-webhook-no-cloud">${t('workflow.webhook.noCloud')}</span>`;
  } else if (!workflowId) {
    noCloudHtml = `<span class="wf-field-hint wf-webhook-no-cloud">${t('workflow.webhook.saveForUrl')}</span>`;
  }
  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.webhook.urlLabel')}</label>
  <span class="wf-field-hint">${t('workflow.webhook.urlHint')}</span>
  ${webhookUrl
    ? `<div class="wf-webhook-url-row">
        <input class="wf-step-edit-input wf-field-mono wf-webhook-url-input" readonly
          value="${esc(webhookUrl)}" />
        <button class="wf-webhook-copy-btn" type="button" data-url="${esc(webhookUrl)}">${t('workflow.webhook.copyBtn')}</button>
      </div>
      <span class="wf-field-hint" style="margin-top:6px">${t('workflow.webhook.payloadHint')}</span>`
    : noCloudHtml
  }
</div>`;
}

function _bindWebhookCopyBtn(root) {
  root.querySelectorAll('.wf-webhook-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = btn.dataset.url;
      if (url && navigator.clipboard) {
        navigator.clipboard.writeText(url).then(() => {
          btn.textContent = t('workflow.webhook.copied');
          setTimeout(() => { btn.textContent = t('workflow.webhook.copyBtn'); }, 2000);
        });
      }
    });
  });
}

module.exports = {
  type: 'trigger-config',

  async render(field, value, node) {
    const props = node.properties || {};
    const triggerType = props.triggerType || 'manual';
    const workflows =
      (typeof window !== 'undefined' && window._workflowsListCache) || [];

    const cronSection = triggerType === 'cron' ? `
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.cronLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.cronHint')}</span>
  <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="triggerValue"
    value="${escapeAttr(props.triggerValue || '')}"
    placeholder="*/5 * * * *" />
</div>` : '';

    const hookSection = triggerType === 'hook' ? `
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.hookTypeLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.hookTypeHint')}</span>
  <select class="wf-step-edit-input wf-node-prop" data-key="hookType">
    ${getHookTypes().map(h =>
      `<option value="${escapeAttr(h.value)}"${props.hookType === h.value ? ' selected' : ''}>${escapeHtml(h.label)}</option>`
    ).join('')}
  </select>
</div>` : '';

    const onWorkflowSection = triggerType === 'on_workflow' ? `
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.workflowSourceLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.workflowSourceHint')}</span>
  <select class="wf-step-edit-input wf-node-prop" data-key="triggerValue">
    <option value=""${!props.triggerValue ? ' selected' : ''}>${t('workflow.trigger.selectWorkflow')}</option>
    ${workflows
      .filter(w => w.id !== (node.properties._workflowId || ''))
      .map(w => `<option value="${escapeAttr(w.id)}"${props.triggerValue === w.id ? ' selected' : ''}>${escapeHtml(w.name)}</option>`)
      .join('')}
  </select>
</div>` : '';

    const webhookSection = triggerType === 'webhook'
      ? await _renderWebhookSection(node.properties._workflowId || '', escapeAttr)
      : '';

    return `<div class="wf-field-group" data-key="triggerType">
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.typeLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.typeHint')}</span>
  <select class="wf-step-edit-input wf-trigger-type-select wf-node-prop" data-key="triggerType">
    <option value="manual"${triggerType === 'manual' ? ' selected' : ''}>${t('workflow.trigger.typeManual')}</option>
    <option value="cron"${triggerType === 'cron' ? ' selected' : ''}>${t('workflow.trigger.typeCron')}</option>
    <option value="hook"${triggerType === 'hook' ? ' selected' : ''}>${t('workflow.trigger.typeHook')}</option>
    <option value="on_workflow"${triggerType === 'on_workflow' ? ' selected' : ''}>${t('workflow.trigger.typeOnWorkflow')}</option>
    <option value="webhook"${triggerType === 'webhook' ? ' selected' : ''}>${t('workflow.trigger.typeWebhook')}</option>
  </select>
</div>
<div class="wf-trigger-conditional">
  ${cronSection}${hookSection}${onWorkflowSection}${webhookSection}
</div>
</div>`;
  },

  bind(container, field, node, onChange) {
    const typeSelect = container.querySelector('.wf-trigger-type-select');
    if (!typeSelect) return;

    // Bind copy button for initial render (if webhook is already selected)
    _bindWebhookCopyBtn(container);

    typeSelect.addEventListener('change', async () => {
      node.properties.triggerType = typeSelect.value;
      onChange(typeSelect.value);

      // Re-render conditional section
      const condDiv = container.querySelector('.wf-trigger-conditional');
      if (!condDiv) return;

      const tType = typeSelect.value;
      const props = node.properties || {};
      const workflows =
        (typeof window !== 'undefined' && window._workflowsListCache) || [];

      function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

      let html = '';
      if (tType === 'cron') {
        html = `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.cronLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.cronHint')}</span>
  <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="triggerValue"
    value="${esc(props.triggerValue || '')}" placeholder="*/5 * * * *" />
</div>`;
      } else if (tType === 'hook') {
        html = `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.hookTypeLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.hookTypeHint')}</span>
  <select class="wf-step-edit-input wf-node-prop" data-key="hookType">
    ${getHookTypes().map(h =>
      `<option value="${esc(h.value)}"${props.hookType === h.value ? ' selected' : ''}>${esc(h.label)}</option>`
    ).join('')}
  </select>
</div>`;
      } else if (tType === 'on_workflow') {
        html = `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.workflowSourceLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.workflowSourceHint')}</span>
  <select class="wf-step-edit-input wf-node-prop" data-key="triggerValue">
    <option value="">${t('workflow.trigger.selectWorkflow')}</option>
    ${workflows.map(w => `<option value="${esc(w.id)}"${props.triggerValue === w.id ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}
  </select>
</div>`;
      } else if (tType === 'webhook') {
        html = await _renderWebhookSection(node.properties._workflowId || '', esc);
      }

      condDiv.innerHTML = html;

      // Re-bind the new inputs
      condDiv.querySelectorAll('.wf-node-prop').forEach(el => {
        const key = el.dataset.key;
        if (!key) return;
        el.addEventListener('change', () => { node.properties[key] = el.value; });
        el.addEventListener('input', () => { node.properties[key] = el.value; });
      });

      // Bind copy button for webhook
      _bindWebhookCopyBtn(condDiv);
    });
  },
};
