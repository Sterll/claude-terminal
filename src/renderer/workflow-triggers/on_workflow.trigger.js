'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'on_workflow',
  label: t('workflow.trigger.typeOnWorkflow'),
  fields: [
    {
      type: 'select',
      key: 'triggerValue',
      label: t('workflow.trigger.workflowSourceLabel'),
      hint: t('workflow.trigger.workflowSourceHint'),
      options: [], // Rempli dynamiquement par le panel
      placeholder: t('workflow.trigger.selectWorkflow'),
    },
  ],
};
