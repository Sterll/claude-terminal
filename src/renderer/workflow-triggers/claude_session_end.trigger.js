'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'claude_session_end',
  label: t('workflow.trigger.typeClaudeSessionEnd'),
  fields: [
    {
      type: 'project-select',
      key: 'projectId',
      label: t('workflow.trigger.claudeSessionProjectLabel'),
      hint: t('workflow.trigger.claudeSessionEndHint'),
    },
    {
      type: 'select',
      key: 'statusFilter',
      label: t('workflow.trigger.claudeSessionStatusLabel'),
      hint: t('workflow.trigger.claudeSessionStatusHint'),
      default: 'any',
      options: [
        { value: 'any',     label: t('workflow.trigger.claudeSessionStatusAny') },
        { value: 'success', label: t('workflow.trigger.claudeSessionStatusSuccess') },
        { value: 'error',   label: t('workflow.trigger.claudeSessionStatusError') },
      ],
    },
  ],
};
