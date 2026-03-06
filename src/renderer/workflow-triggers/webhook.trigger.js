'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'webhook',
  label: t('workflow.webhook.label'),
  fields: [
    {
      type: 'hint',
      key: '_wh_hint',
      text: t('workflow.trigger.webhookHint'),
    },
  ],
};
