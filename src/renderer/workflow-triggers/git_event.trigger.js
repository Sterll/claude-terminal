'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'git_event',
  label: t('workflow.trigger.typeGitEvent'),
  fields: [
    {
      type: 'project-select',
      key: 'projectId',
      label: t('workflow.trigger.gitEventProjectLabel'),
      hint: t('workflow.trigger.gitEventProjectHint'),
    },
    {
      type: 'select',
      key: 'eventFilter',
      label: t('workflow.trigger.gitEventTypeLabel'),
      hint: t('workflow.trigger.gitEventTypeHint'),
      default: 'any',
      options: [
        { value: 'any',          label: t('workflow.trigger.gitEventAny') },
        { value: 'commit',       label: t('workflow.trigger.gitEventCommit') },
        { value: 'push',         label: t('workflow.trigger.gitEventPush') },
        { value: 'branch_switch',label: t('workflow.trigger.gitEventBranchSwitch') },
      ],
    },
  ],
};
