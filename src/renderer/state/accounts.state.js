/**
 * Accounts State Module
 *
 * A mirror of the main process account list, kept in the renderer so views can
 * resolve a project's account synchronously. ProjectBar and ProjectList redraw
 * on every terminal stat change; an IPC round-trip per tab to colour it would
 * be a round-trip per tab per redraw.
 *
 * The main process owns the data — this module never writes it, it only asks
 * for a refresh and republishes what comes back.
 */

const { State } = require('./State');
const { getProjectAccount } = require('./projects.state');

const initialState = {
  accounts: [],
  defaultId: null,   // Account used by projects with no binding of their own
  liveId: null,      // Account owning the machine-wide store (`claude /login`)
  hasCredentials: false,
  loaded: false
};

const accountsState = new State(initialState);

let _accountIndex = null;

function _invalidateIndex() {
  _accountIndex = null;
}

function _getAccountIndex() {
  if (!_accountIndex) {
    _accountIndex = new Map();
    for (const a of accountsState.get().accounts) _accountIndex.set(a.id, a);
  }
  return _accountIndex;
}

const _origSet = accountsState.set.bind(accountsState);
accountsState.set = function (patch) { _invalidateIndex(); _origSet(patch); };

/**
 * Pull the account list from the main process.
 * @returns {Promise<void>}
 */
async function loadAccounts() {
  const api = window.electron_api?.accounts;
  if (!api) return;
  try {
    const res = await api.list();
    if (!res?.success) return;
    const { accounts = [], defaultId = null, liveId = null, hasCredentials = false } = res.data || {};
    accountsState.set({ accounts, defaultId, liveId, hasCredentials, loaded: true });
  } catch (_) {
    // Leave the previous list in place: a blank one would silently repaint
    // every tab as unbound.
  }
}

/**
 * Subscribe to main-process account changes. Returns the unsubscribe function.
 * @returns {Function}
 */
function watchAccounts() {
  const api = window.electron_api?.accounts;
  if (!api?.onChanged) return () => {};
  return api.onChanged((payload) => {
    if (!payload) return loadAccounts();
    const { accounts = [], defaultId = null, liveId = null, hasCredentials = false } = payload;
    accountsState.set({ accounts, defaultId, liveId, hasCredentials, loaded: true });
  });
}

/**
 * @param {string|null} accountId
 * @returns {Object|null}
 */
function getAccount(accountId) {
  if (!accountId) return null;
  return _getAccountIndex().get(accountId) || null;
}

/**
 * The account a project actually runs as: its own binding, else the default.
 * @param {string} projectId
 * @returns {Object|null}
 */
function getAccountForProject(projectId) {
  const bound = getProjectAccount(projectId);
  return getAccount(bound) || getAccount(accountsState.get().defaultId);
}

/**
 * Whether a project runs on the default account rather than one of its own.
 * The tab renders the colour either way; the menu uses this for its checkmark.
 * @param {string} projectId
 * @returns {boolean}
 */
function projectFollowsDefault(projectId) {
  return !getProjectAccount(projectId);
}

/**
 * The account whose usage figures apply to a project, and whether it got there
 * by falling back.
 *
 * An unbound project runs against the machine-wide store, so the honest answer
 * is whichever account owns that store — `liveId` — not the default. The two
 * normally agree, since setDefault writes the default into it; they diverge
 * after a manual `claude /login`, and naming the default then would attribute
 * the numbers to an account that did not produce them.
 *
 * @param {string|null} projectId
 * @returns {{account: Object|null, isDefault: boolean}}
 */
function getUsageAccountForProject(projectId) {
  const bound = projectId ? getProjectAccount(projectId) : null;
  if (bound) {
    const account = getAccount(bound);
    if (account) return { account, isDefault: false };
  }
  const { liveId, defaultId } = accountsState.get();
  return { account: getAccount(liveId) || getAccount(defaultId), isDefault: true };
}

function getAccounts() {
  return accountsState.get().accounts;
}

function getDefaultAccount() {
  return getAccount(accountsState.get().defaultId);
}

module.exports = {
  accountsState,
  loadAccounts,
  watchAccounts,
  getAccount,
  getAccounts,
  getAccountForProject,
  getDefaultAccount,
  projectFollowsDefault,
  getUsageAccountForProject
};
