'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'manual',
  label: t('workflow.trigger.typeManual'),
  fields: [
    {
      type: 'hint',
      key: '_manual_hint',
      text: t('workflow.trigger.manualHint'),
    },
  ],
};
