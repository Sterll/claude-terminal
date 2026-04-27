'use strict';

const { t } = require('../i18n');

module.exports = {
  type: 'terminal_exit_code',
  label: t('workflow.trigger.typeTerminalExit'),
  fields: [
    {
      type: 'select',
      key: 'codeFilter',
      label: t('workflow.trigger.terminalExitFilterLabel'),
      hint: t('workflow.trigger.terminalExitFilterHint'),
      options: [
        { value: 'any',      label: t('workflow.trigger.terminalExitAny') },
        { value: 'success',  label: t('workflow.trigger.terminalExitSuccess') },
        { value: 'error',    label: t('workflow.trigger.terminalExitError') },
        { value: 'custom',   label: t('workflow.trigger.terminalExitCustom') },
      ],
    },
    {
      type: 'text',
      key: 'customCodes',
      label: t('workflow.trigger.terminalExitCustomLabel'),
      hint: t('workflow.trigger.terminalExitCustomHint'),
      placeholder: '1,2,127',
    },
    {
      type: 'project-select',
      key: 'projectId',
      label: t('workflow.trigger.terminalExitProjectLabel'),
      hint: t('workflow.trigger.terminalExitProjectHint'),
    },
    {
      type: 'text',
      key: 'commandPattern',
      label: t('workflow.trigger.terminalExitCommandLabel'),
      hint: t('workflow.trigger.terminalExitCommandHint'),
      placeholder: 'claude',
    },
  ],
};
