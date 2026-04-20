'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'project_opened',
  label: t('workflow.trigger.typeProjectOpened'),
  fields: [
    {
      type: 'project-select',
      key: 'projectId',
      label: t('workflow.trigger.projectOpenedLabel'),
      hint: t('workflow.trigger.projectOpenedHint'),
    },
  ],
};
