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

function getProjectsList() {
  return (typeof window !== 'undefined' && window._projectsState?.get?.()?.projects) || [];
}

function renderProjectSelect(key, selected, esc, withAny = true) {
  const projects = getProjectsList();
  const options = projects
    .map(p => `<option value="${esc(p.id)}"${selected === p.id ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('');
  const anyOpt = withAny
    ? `<option value=""${!selected ? ' selected' : ''}>${t('workflow.trigger.anyProject')}</option>`
    : '';
  return `<select class="wf-step-edit-input wf-node-prop" data-key="${esc(key)}">
    ${anyOpt}${options}
  </select>`;
}

function renderFileChangeSection(props, esc) {
  const eventsValue = props.events || 'all';
  const eventsOptions = [
    ['all',    t('workflow.trigger.fileChangeEventAll')],
    ['add',    t('workflow.trigger.fileChangeEventAdd')],
    ['change', t('workflow.trigger.fileChangeEventChange')],
    ['unlink', t('workflow.trigger.fileChangeEventUnlink')],
  ]
    .map(([v, lbl]) => `<option value="${esc(v)}"${eventsValue === v ? ' selected' : ''}>${esc(lbl)}</option>`)
    .join('');

  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.fileChangeProjectLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.fileChangeProjectHint')}</span>
  ${renderProjectSelect('projectId', props.projectId || '', esc, true)}
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.fileChangePathLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.fileChangePathHint')}</span>
  <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="watchPath"
    value="${esc(props.watchPath || '')}" placeholder="/abs/path/to/folder" />
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.fileChangePatternsLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.fileChangePatternsHint')}</span>
  <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="patterns"
    value="${esc(props.patterns || '')}" placeholder="**/*.js" />
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.fileChangeEventsLabel')}</label>
  <select class="wf-step-edit-input wf-node-prop" data-key="events">${eventsOptions}</select>
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.fileChangeDebounceLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.fileChangeDebounceHint')}</span>
  <input type="number" min="0" class="wf-step-edit-input wf-node-prop" data-key="debounceMs"
    value="${esc(props.debounceMs != null ? props.debounceMs : 500)}" placeholder="500" />
</div>`;
}

function renderTerminalExitSection(props, esc) {
  const filter = props.codeFilter || 'any';
  const opts = [
    ['any',     t('workflow.trigger.terminalExitAny')],
    ['success', t('workflow.trigger.terminalExitSuccess')],
    ['error',   t('workflow.trigger.terminalExitError')],
    ['custom',  t('workflow.trigger.terminalExitCustom')],
  ]
    .map(([v, lbl]) => `<option value="${esc(v)}"${filter === v ? ' selected' : ''}>${esc(lbl)}</option>`)
    .join('');

  const customSection = filter === 'custom' ? `
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.terminalExitCustomLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.terminalExitCustomHint')}</span>
  <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="customCodes"
    value="${esc(props.customCodes || '')}" placeholder="1,2,127" />
</div>` : '';

  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.terminalExitFilterLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.terminalExitFilterHint')}</span>
  <select class="wf-step-edit-input wf-trigger-exit-filter wf-node-prop" data-key="codeFilter">${opts}</select>
</div>
${customSection}
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.terminalExitProjectLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.terminalExitProjectHint')}</span>
  ${renderProjectSelect('projectId', props.projectId || '', esc, true)}
</div>`;
}

function renderProjectOpenedSection(props, esc) {
  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.projectOpenedLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.projectOpenedHint')}</span>
  ${renderProjectSelect('projectId', props.projectId || '', esc, true)}
</div>`;
}

function renderClaudeSessionStartSection(props, esc) {
  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.claudeSessionProjectLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.claudeSessionStartHint')}</span>
  ${renderProjectSelect('projectId', props.projectId || '', esc, true)}
</div>`;
}

function renderClaudeSessionEndSection(props, esc) {
  const statusFilter = props.statusFilter || 'any';
  const statuses = [
    { value: 'any',     label: t('workflow.trigger.claudeSessionStatusAny') },
    { value: 'success', label: t('workflow.trigger.claudeSessionStatusSuccess') },
    { value: 'error',   label: t('workflow.trigger.claudeSessionStatusError') },
  ];
  const statusOpts = statuses.map(s =>
    `<option value="${esc(s.value)}"${statusFilter === s.value ? ' selected' : ''}>${esc(s.label)}</option>`
  ).join('');
  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.claudeSessionStatusLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.claudeSessionStatusHint')}</span>
  <select class="wf-step-edit-input wf-node-prop" data-key="statusFilter">${statusOpts}</select>
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.claudeSessionProjectLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.claudeSessionEndHint')}</span>
  ${renderProjectSelect('projectId', props.projectId || '', esc, true)}
</div>`;
}

function renderGitEventSection(props, esc) {
  const eventFilter = props.eventFilter || 'any';
  const events = [
    { value: 'any',           label: t('workflow.trigger.gitEventAny') },
    { value: 'commit',        label: t('workflow.trigger.gitEventCommit') },
    { value: 'push',          label: t('workflow.trigger.gitEventPush') },
    { value: 'branch_switch', label: t('workflow.trigger.gitEventBranchSwitch') },
  ];
  const opts = events.map(e =>
    `<option value="${esc(e.value)}"${eventFilter === e.value ? ' selected' : ''}>${esc(e.label)}</option>`
  ).join('');
  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.gitEventTypeLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.gitEventTypeHint')}</span>
  <select class="wf-step-edit-input wf-node-prop" data-key="eventFilter">${opts}</select>
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.gitEventProjectLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.gitEventProjectHint')}</span>
  ${renderProjectSelect('projectId', props.projectId || '', esc, true)}
</div>`;
}

function renderChatMessageSection(props, esc) {
  const role = props.role || 'user';
  const matchMode = props.matchMode || 'regex';
  const roles = [
    { value: 'user',      label: t('workflow.trigger.chatMessageRoleUser') },
    { value: 'assistant', label: t('workflow.trigger.chatMessageRoleAssistant') },
    { value: 'any',       label: t('workflow.trigger.chatMessageRoleAny') },
  ];
  const modes = [
    { value: 'contains', label: t('workflow.trigger.chatMessageModeContains') },
    { value: 'regex',    label: t('workflow.trigger.chatMessageModeRegex') },
  ];
  const roleOpts = roles.map(r =>
    `<option value="${esc(r.value)}"${role === r.value ? ' selected' : ''}>${esc(r.label)}</option>`
  ).join('');
  const modeOpts = modes.map(m =>
    `<option value="${esc(m.value)}"${matchMode === m.value ? ' selected' : ''}>${esc(m.label)}</option>`
  ).join('');
  return `<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.chatMessageRoleLabel')}</label>
  <select class="wf-step-edit-input wf-node-prop" data-key="role">${roleOpts}</select>
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.chatMessagePatternLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.chatMessagePatternHint')}</span>
  <input class="wf-step-edit-input wf-node-prop wf-field-mono" data-key="pattern"
    value="${esc(props.pattern || '')}" placeholder="deploy|release|fix:.*" />
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.chatMessageModeLabel')}</label>
  <select class="wf-step-edit-input wf-node-prop" data-key="matchMode">${modeOpts}</select>
</div>
<div class="wf-step-edit-field">
  <label class="wf-step-edit-label">${t('workflow.trigger.chatMessageProjectLabel')}</label>
  <span class="wf-field-hint">${t('workflow.trigger.chatMessageProjectHint')}</span>
  ${renderProjectSelect('projectId', props.projectId || '', esc, true)}
</div>`;
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

    const fileChangeSection   = triggerType === 'file_change'        ? renderFileChangeSection(props, escapeAttr)   : '';
    const terminalExitSection = triggerType === 'terminal_exit_code' ? renderTerminalExitSection(props, escapeAttr) : '';
    const projectOpenedSection= triggerType === 'project_opened'     ? renderProjectOpenedSection(props, escapeAttr): '';
    const claudeStartSection  = triggerType === 'claude_session_start'? renderClaudeSessionStartSection(props, escapeAttr): '';
    const claudeEndSection    = triggerType === 'claude_session_end' ? renderClaudeSessionEndSection(props, escapeAttr)  : '';
    const gitEventSection     = triggerType === 'git_event'          ? renderGitEventSection(props, escapeAttr)          : '';
    const chatMessageSection  = triggerType === 'chat_message'       ? renderChatMessageSection(props, escapeAttr)       : '';

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
    <option value="file_change"${triggerType === 'file_change' ? ' selected' : ''}>${t('workflow.trigger.typeFileChange')}</option>
    <option value="terminal_exit_code"${triggerType === 'terminal_exit_code' ? ' selected' : ''}>${t('workflow.trigger.typeTerminalExit')}</option>
    <option value="project_opened"${triggerType === 'project_opened' ? ' selected' : ''}>${t('workflow.trigger.typeProjectOpened')}</option>
    <option value="claude_session_start"${triggerType === 'claude_session_start' ? ' selected' : ''}>${t('workflow.trigger.typeClaudeSessionStart')}</option>
    <option value="claude_session_end"${triggerType === 'claude_session_end' ? ' selected' : ''}>${t('workflow.trigger.typeClaudeSessionEnd')}</option>
    <option value="git_event"${triggerType === 'git_event' ? ' selected' : ''}>${t('workflow.trigger.typeGitEvent')}</option>
    <option value="chat_message"${triggerType === 'chat_message' ? ' selected' : ''}>${t('workflow.trigger.typeChatMessage')}</option>
  </select>
</div>
<div class="wf-trigger-conditional">
  ${cronSection}${hookSection}${onWorkflowSection}${webhookSection}${fileChangeSection}${terminalExitSection}${projectOpenedSection}${claudeStartSection}${claudeEndSection}${gitEventSection}${chatMessageSection}
</div>
</div>`;
  },

  bind(container, field, node, onChange) {
    const typeSelect = container.querySelector('.wf-trigger-type-select');
    if (!typeSelect) return;

    // Bind copy button for initial render (if webhook is already selected)
    _bindWebhookCopyBtn(container);

    // Re-render terminal_exit_code section when filter toggles to/from 'custom'
    // (handles the case where the editor opens with this type already selected).
    const exitFilterInit = container.querySelector('.wf-trigger-exit-filter');
    if (exitFilterInit) {
      exitFilterInit.addEventListener('change', () => {
        const condDiv = container.querySelector('.wf-trigger-conditional');
        if (!condDiv) return;
        node.properties.codeFilter = exitFilterInit.value;
        function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        condDiv.innerHTML = renderTerminalExitSection(node.properties || {}, esc);
        condDiv.querySelectorAll('.wf-node-prop').forEach(el => {
          const key = el.dataset.key;
          if (!key) return;
          el.addEventListener('change', () => { node.properties[key] = el.value; });
          el.addEventListener('input',  () => { node.properties[key] = el.value; });
        });
      });
    }

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
      } else if (tType === 'file_change') {
        html = renderFileChangeSection(props, esc);
      } else if (tType === 'terminal_exit_code') {
        html = renderTerminalExitSection(props, esc);
      } else if (tType === 'project_opened') {
        html = renderProjectOpenedSection(props, esc);
      } else if (tType === 'claude_session_start') {
        html = renderClaudeSessionStartSection(props, esc);
      } else if (tType === 'claude_session_end') {
        html = renderClaudeSessionEndSection(props, esc);
      } else if (tType === 'git_event') {
        html = renderGitEventSection(props, esc);
      } else if (tType === 'chat_message') {
        html = renderChatMessageSection(props, esc);
      }

      condDiv.innerHTML = html;

      // Re-bind the new inputs
      condDiv.querySelectorAll('.wf-node-prop').forEach(el => {
        const key = el.dataset.key;
        if (!key) return;
        const updateProp = () => {
          // coerce numeric fields so debounceMs is stored as number
          const v = el.value;
          if (el.type === 'number') {
            const n = Number(v);
            node.properties[key] = Number.isFinite(n) ? n : v;
          } else {
            node.properties[key] = v;
          }
        };
        el.addEventListener('change', updateProp);
        el.addEventListener('input',  updateProp);
      });

      // Re-render conditional when terminal_exit_code filter toggles to/from 'custom'
      const exitFilter = condDiv.querySelector('.wf-trigger-exit-filter');
      if (exitFilter) {
        exitFilter.addEventListener('change', () => {
          node.properties.codeFilter = exitFilter.value;
          condDiv.innerHTML = renderTerminalExitSection(node.properties || {}, esc);
          // re-wire after inner render
          condDiv.querySelectorAll('.wf-node-prop').forEach(el => {
            const key = el.dataset.key;
            if (!key) return;
            el.addEventListener('change', () => { node.properties[key] = el.value; });
            el.addEventListener('input',  () => { node.properties[key] = el.value; });
          });
        });
      }

      // Bind copy button for webhook
      _bindWebhookCopyBtn(condDiv);
    });
  },
};
