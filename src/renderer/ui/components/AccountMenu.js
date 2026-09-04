/**
 * AccountMenu
 *
 * The "which Claude account does this project run as" picker, shared by the
 * project tab's context menu and the usage bar. One builder rather than two:
 * the guard below is the kind of thing that gets added to one entry point and
 * forgotten in the other.
 */

const { showContextMenu } = require('./ContextMenu');
const { showConfirm } = require('./Modal');
const { sanitizeColor } = require('../../utils/color');
const { t } = require('../../i18n');
const {
  getAccounts,
  getDefaultAccount,
  projectFollowsDefault
} = require('../../state/accounts.state');
const { setProjectAccount, getProjectAccount } = require('../../state/projects.state');

/**
 * ContextMenu injects `icon` as raw HTML, so the colour goes through
 * sanitizeColor before it reaches a style attribute.
 */
function dot(color) {
  const safe = sanitizeColor(color);
  return safe
    ? `<span class="context-menu-dot" style="background:${safe}"></span>`
    : '<span class="context-menu-dot context-menu-dot--none"></span>';
}

/**
 * Sessions already running for this project, which keep the account they
 * started with.
 * @param {string} projectId
 * @returns {number}
 */
function liveSessionCount(projectId) {
  try {
    const { getProjectIndex, getTerminalsForProject } = require('../../state');
    const index = getProjectIndex(projectId);
    if (index === -1 || index === undefined || index === null) return 0;
    return (getTerminalsForProject(index) || []).length;
  } catch (_) {
    return 0;
  }
}

/**
 * Apply a binding change, warning first when it cannot take effect yet.
 *
 * The account is resolved when a CLI is spawned, so a running session keeps
 * the one it started with. Saying so beats letting the user believe a live
 * session just moved — the same reason settings refuses to delete an account
 * that projects still point at instead of silently re-homing them.
 *
 * @param {string} projectId
 * @param {string|null} accountId
 * @returns {Promise<boolean>} whether the binding was changed
 */
async function applyProjectAccount(projectId, accountId) {
  const live = liveSessionCount(projectId);
  if (live > 0) {
    const ok = await showConfirm({
      title: t('accounts.switchWhileRunningTitle') || 'Sessions are running',
      message: t('accounts.switchWhileRunning', { count: live })
    });
    if (!ok) return false;
  }
  setProjectAccount(projectId, accountId);
  return true;
}

/**
 * Show the account picker for a project.
 *
 * A checkmark marks the current choice, and the first entry names the account
 * the project falls back to — so the menu states what the project uses, not
 * only what it overrides.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {Function} [opts.onPicked] - called with the chosen account id (or null)
 */
function showProjectAccountMenu({ projectId, x, y, onPicked }) {
  const accounts = getAccounts();
  if (!accounts.length) return;

  const bound = getProjectAccount(projectId);
  const fallback = getDefaultAccount();

  const pick = async (accountId) => {
    if (await applyProjectAccount(projectId, accountId) && onPicked) onPicked(accountId);
  };

  const items = [{
    label: fallback
      ? t('accounts.useDefaultNamed', { name: fallback.name })
      : t('accounts.useDefault'),
    icon: projectFollowsDefault(projectId) ? '&#10003;' : dot(fallback?.color),
    onClick: () => pick(null),
  }, { separator: true }];

  for (const account of accounts) {
    items.push({
      label: account.name,
      icon: bound === account.id ? '&#10003;' : dot(account.color),
      onClick: () => pick(account.id),
    });
  }

  showContextMenu({ x, y, items, target: projectId });
}

module.exports = { showProjectAccountMenu, applyProjectAccount, liveSessionCount };
