/**
 * The choices offered wherever an automation picks the Claude account it runs
 * as: the Automations form and the Claude node of the advanced editor. One
 * list, so the two cannot disagree on what the values mean.
 *
 *   ''               default account (named, so the user sees which one it is)
 *   PROJECT_ACCOUNT  the target project's binding, else the default
 *   <id>             that account
 *
 * A saved id that is no longer in the list stays selectable as "deleted
 * account" rather than silently becoming the default: the run refuses it, and
 * the form should show the same thing the run will complain about.
 */

const { t } = require('../i18n');
const { getAccounts, getDefaultAccount } = require('../state/accounts.state');
const { PROJECT_ACCOUNT } = require('../../shared/simple-task');

/**
 * @param {string} selected  the stored value
 * @returns {Array<{ value: string, label: string }>}
 */
function accountChoices(selected = '') {
  const accounts = getAccounts() || [];
  const def = getDefaultAccount();
  const choices = [
    { value: '', label: def ? `${t('automation.form.accountDefault')} (${def.name})` : t('automation.form.accountDefault') },
    { value: PROJECT_ACCOUNT, label: t('automation.form.accountProject') },
    ...accounts.map(a => ({ value: a.id, label: a.name })),
  ];
  if (selected && !choices.some(c => c.value === selected)) {
    choices.push({ value: selected, label: t('automation.form.accountMissing') });
  }
  return choices;
}

/**
 * Whether the choice is worth showing at all. With no captured account every
 * option means the machine-wide login, so a picker would only be noise — unless
 * a value is already stored, which the user must be able to see and clear.
 * @param {string} selected
 */
function hasAccountChoice(selected = '') {
  return (getAccounts() || []).length > 0 || !!selected;
}

module.exports = { accountChoices, hasAccountChoice };
