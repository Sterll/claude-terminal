'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'chat_message',
  label: t('workflow.trigger.typeChatMessage'),
  fields: [
    {
      type: 'project-select',
      key: 'projectId',
      label: t('workflow.trigger.chatMessageProjectLabel'),
      hint: t('workflow.trigger.chatMessageProjectHint'),
    },
    {
      type: 'select',
      key: 'role',
      label: t('workflow.trigger.chatMessageRoleLabel'),
      default: 'user',
      options: [
        { value: 'user',      label: t('workflow.trigger.chatMessageRoleUser') },
        { value: 'assistant', label: t('workflow.trigger.chatMessageRoleAssistant') },
        { value: 'any',       label: t('workflow.trigger.chatMessageRoleAny') },
      ],
    },
    {
      type: 'text',
      key: 'pattern',
      label: t('workflow.trigger.chatMessagePatternLabel'),
      hint: t('workflow.trigger.chatMessagePatternHint'),
      placeholder: 'deploy|release|fix:.*',
    },
    {
      type: 'select',
      key: 'matchMode',
      label: t('workflow.trigger.chatMessageModeLabel'),
      default: 'regex',
      options: [
        { value: 'contains', label: t('workflow.trigger.chatMessageModeContains') },
        { value: 'regex',    label: t('workflow.trigger.chatMessageModeRegex') },
      ],
    },
  ],
};
