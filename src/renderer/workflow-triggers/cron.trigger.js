'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'cron',
  label: t('workflow.trigger.typeCron'),
  fields: [
    {
      type: 'cron-picker',
      key: 'triggerValue',
      label: t('workflow.trigger.cronLabel'),
      placeholder: '*/5 * * * *',
      hint: t('workflow.trigger.cronHint'),
    },
  ],
};
