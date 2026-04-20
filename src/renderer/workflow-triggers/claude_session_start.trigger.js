'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'claude_session_start',
  label: t('workflow.trigger.typeClaudeSessionStart'),
  fields: [
    {
      type: 'project-select',
      key: 'projectId',
      label: t('workflow.trigger.claudeSessionProjectLabel'),
      hint: t('workflow.trigger.claudeSessionStartHint'),
    },
  ],
};
