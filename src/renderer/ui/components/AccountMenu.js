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
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');
const {
  getAccounts,
  getDefaultAccount,
  getAccountForProject,
  projectFollowsDefault
} = require('../../state/accounts.state');
const { setProjectAccount, getProjectAccount } = require('../../state/projects.state');

/**
 * Account colours, sharing the Kanban label hues so the app keeps one palette.
 * A fixed list rather than a full colour picker: these are tags to tell two or
 * three accounts apart at a glance, not a design surface, and every value here
 * is known to read against the dark theme.
 */
const ACCOUNT_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280'
];

/**
 * Swatch grid for picking an account colour.
 *
 * @param {Object} opts
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {string|null} opts.current
 * @param {Function} opts.onPick - called with a hex string, or null to clear
 */
function showAccountColorPicker({ x, y, current, onPick }) {
  document.querySelectorAll('.account-color-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'account-color-popover';

  const safeCurrent = sanitizeColor(current);
  popover.innerHTML = `
    ${ACCOUNT_COLORS.map(c => `
      <button type="button" class="account-color-swatch${c === safeCurrent ? ' selected' : ''}"
              data-color="${c}" style="background:${c}" title="${c}"></button>
    `).join('')}
    <button type="button" class="account-color-swatch account-color-swatch--none${safeCurrent ? '' : ' selected'}"
            data-color="" title="${escapeHtml(t('accounts.colorNone') || 'No colour')}"></button>
  `;

  document.body.appendChild(popover);
  const rect = popover.getBoundingClientRect();
  popover.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  popover.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

  const close = () => {
    popover.remove();
    document.removeEventListener('click', onOutside, true);
  };
  const onOutside = (e) => { if (!popover.contains(e.target)) close(); };

  popover.onclick = (e) => {
    const swatch = e.target.closest('.account-color-swatch');
    if (!swatch) return;
    e.stopPropagation();
    close();
    onPick(swatch.dataset.color || null);
  };

  setTimeout(() => document.addEventListener('click', onOutside, true), 0);
}

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
 * The project's running sessions, split by whether a re-binding can move them.
 *
 * A chat tab can be moved: its CLI is closed and respawned on the new account,
 * and the conversation resumes. A terminal tab cannot — the account was
 * resolved when `claude` was launched in it, and only whoever is typing in it
 * can restart that.
 *
 * @param {string} projectId
 * @returns {{chats: Array<Object>, terminals: number}}
 */
function liveSessions(projectId) {
  try {
    const { getProjectIndex, getTerminalsForProject } = require('../../state');
    const index = getProjectIndex(projectId);
    if (index === -1 || index === undefined || index === null) return { chats: [], terminals: 0 };
    const running = getTerminalsForProject(index) || [];
    // A chat tab that has never sent anything has no CLI to move: its first
    // message reads the binding fresh, so it is neither a warning nor a restart.
    const chats = running.filter(term =>
      typeof term.chatView?.switchAccount === 'function' && term.chatView.getSessionId?.());
    return { chats, terminals: running.filter(term => term.mode !== 'chat').length };
  } catch (_) {
    return { chats: [], terminals: 0 };
  }
}

/**
 * Sessions already running for this project.
 * @param {string} projectId
 * @returns {number}
 */
function liveSessionCount(projectId) {
  const { chats, terminals } = liveSessions(projectId);
  return chats.length + terminals;
}

/**
 * Apply a binding change, and carry the running chat tabs over with it.
 *
 * The account is resolved when a CLI is spawned, so the binding alone only
 * decides what the *next* session runs as. This menu used to say so and stop
 * there — which read as a warning but landed as a dead end: after a spend cap
 * the whole point of switching is to carry on in the tab that just stopped,
 * and typing into it went straight back to the account that ran out.
 *
 * Terminal tabs still keep what they were launched with; there is nothing to
 * restart on their behalf.
 *
 * @param {string} projectId
 * @param {string|null} accountId
 * @returns {Promise<boolean>} whether the binding was changed
 */
async function applyProjectAccount(projectId, accountId) {
  const { chats, terminals } = liveSessions(projectId);
  if (chats.length || terminals) {
    const parts = [];
    if (chats.length) parts.push(t('accounts.switchWhileRunningChats', { count: chats.length }));
    if (terminals) parts.push(t('accounts.switchWhileRunning', { count: terminals }));
    const ok = await showConfirm({
      title: t('accounts.switchWhileRunningTitle') || 'Sessions are running',
      // One paragraph: the confirm dialog escapes its message and does not
      // honour line breaks.
      message: parts.join(' ')
    });
    if (!ok) return false;
  }
  setProjectAccount(projectId, accountId);
  // The binding first, so each restart reads the account it is about to run on
  // even if the tab rebuilds its own start options.
  for (const term of chats) {
    try {
      await term.chatView.switchAccount(accountId);
    } catch (err) {
      console.warn('[AccountMenu] chat tab could not be moved:', err?.message);
    }
  }
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

  // Flat, unlike the project menu's side panel: this one is opened from the
  // usage chip, which is already a statement of the current account — the list
  // only has to offer the alternatives.
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

module.exports = {
  showProjectAccountMenu,
  showAccountColorPicker,
  applyProjectAccount,
  liveSessions,
  liveSessionCount,
  ACCOUNT_COLORS
};
