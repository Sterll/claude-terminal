'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'file_change',
  label: t('workflow.trigger.typeFileChange'),
  fields: [
    // The actual form is rendered by trigger-config.field.js;
    // these descriptors remain as metadata for the registry.
    {
      type: 'project-select',
      key: 'projectId',
      label: t('workflow.trigger.fileChangeProjectLabel'),
      hint: t('workflow.trigger.fileChangeProjectHint'),
    },
    {
      type: 'text',
      key: 'watchPath',
      label: t('workflow.trigger.fileChangePathLabel'),
      hint: t('workflow.trigger.fileChangePathHint'),
      placeholder: '',
    },
    {
      type: 'text',
      key: 'patterns',
      label: t('workflow.trigger.fileChangePatternsLabel'),
      hint: t('workflow.trigger.fileChangePatternsHint'),
      placeholder: '**/*.js',
    },
    {
      type: 'select',
      key: 'events',
      label: t('workflow.trigger.fileChangeEventsLabel'),
      options: [
        { value: 'all',    label: t('workflow.trigger.fileChangeEventAll') },
        { value: 'add',    label: t('workflow.trigger.fileChangeEventAdd') },
        { value: 'change', label: t('workflow.trigger.fileChangeEventChange') },
        { value: 'unlink', label: t('workflow.trigger.fileChangeEventUnlink') },
      ],
    },
    {
      type: 'number',
      key: 'debounceMs',
      label: t('workflow.trigger.fileChangeDebounceLabel'),
      hint: t('workflow.trigger.fileChangeDebounceHint'),
      placeholder: '500',
    },
  ],
};
