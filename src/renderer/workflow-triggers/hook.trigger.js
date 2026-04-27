'use strict';

const { t } = require('../i18n');

const HOOK_TYPES = [
  { value: 'PreToolUse',       label: t('workflow.trigger.hookPreToolUse') },
  { value: 'PostToolUse',      label: t('workflow.trigger.hookPostToolUse') },
  { value: 'UserPromptSubmit', label: t('workflow.trigger.hookUserPrompt') },
  { value: 'Notification',     label: t('workflow.trigger.hookNotification') },
  { value: 'Stop',             label: t('workflow.trigger.hookStop') },
];

module.exports = {
  type: 'hook',
  label: t('workflow.trigger.typeHook'),
  fields: [
    {
      type: 'select',
      key: 'hookType',
      label: t('workflow.trigger.hookTypeLabel'),
      hint: t('workflow.trigger.hookTypeHint'),
      options: HOOK_TYPES.map(h => ({ value: h.value, label: h.label })),
    },
    {
      type: 'project-select',
      key: 'projectId',
      label: t('workflow.trigger.hookProjectLabel'),
      hint: t('workflow.trigger.hookProjectHint'),
    },
    {
      type: 'text',
      key: 'toolName',
      label: t('workflow.trigger.hookToolNameLabel'),
      hint: t('workflow.trigger.hookToolNameHint'),
      placeholder: 'Bash, Edit, Write',
    },
  ],
};
