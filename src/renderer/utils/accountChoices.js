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
const { getAccounts, getAccount, getDefaultAccount, getAccountForProject } = require('../state/accounts.state');
const { sanitizeColor } = require('./color');
const { PROJECT_ACCOUNT } = require('../../shared/simple-task');

/** An account's own colour, or the accent when it has none. */
function accountColor(account) {
  return sanitizeColor(account?.color) || 'var(--accent)';
}

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

/**
 * The account an automation will run on, for its card: the account a task's
 * choice resolves to right now, and how it got there. Null when no account is
 * captured, where every choice is the same machine-wide login.
 *
 * @param {string} value      the stored choice
 * @param {string} projectId  the task's project, for PROJECT_ACCOUNT
 * @returns {{ name: string, color: string, title: string, missing: boolean }|null}
 */
function accountBadge(value = '', projectId = '') {
  if (!(getAccounts() || []).length) return null;
  if (value === PROJECT_ACCOUNT) {
    // "Run where it fired" has no project until it fires.
    const account = projectId ? getAccountForProject(projectId) : null;
    return {
      name: account ? account.name : t('automation.form.accountProject'),
      color: accountColor(account),
      title: t('automation.form.accountProject'),
      missing: false,
    };
  }
  if (!value) {
    const def = getDefaultAccount();
    return {
      name: def ? def.name : t('automation.form.accountDefault'),
      color: accountColor(def),
      title: t('automation.form.accountDefault'),
      missing: false,
    };
  }
  const account = getAccount(value);
  return account
    ? { name: account.name, color: accountColor(account), title: t('automation.form.account'), missing: false }
    : { name: t('automation.form.accountMissing'), color: 'var(--danger)', title: t('automation.form.account'), missing: true };
}

/**
 * A recorded account id, for the run history: the run already happened, so
 * this is the account it spent, not a choice to resolve.
 * @param {string} id
 * @returns {{ name: string, color: string }}
 */
function accountLabel(id) {
  const account = getAccount(id);
  return account
    ? { name: account.name, color: accountColor(account) }
    : { name: t('automation.form.accountMissing'), color: 'var(--text-muted)' };
}

module.exports = { accountChoices, hasAccountChoice, accountBadge, accountLabel, accountColor };
