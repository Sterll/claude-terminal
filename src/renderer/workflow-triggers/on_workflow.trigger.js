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
    // WorkflowScheduler.onWorkflowComplete has always read trigger.statusFilter
    // (:184), but nothing ever wrote it, so chaining was stuck on 'any'.
    // Values must match the scheduler's branches exactly: any | success | failed.
    {
      type: 'select',
      key: 'statusFilter',
      label: t('workflow.trigger.onWorkflowStatusLabel'),
      hint: t('workflow.trigger.onWorkflowStatusHint'),
      options: [
        { value: 'any',     label: t('workflow.trigger.onWorkflowStatusAny') },
        { value: 'success', label: t('workflow.trigger.onWorkflowStatusSuccess') },
        { value: 'failed',  label: t('workflow.trigger.onWorkflowStatusFailed') },
      ],
    },
  ],
};
