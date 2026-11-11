/**
 * AccountLoginModal
 *
 * Connects a Claude account without leaving the app: Claude Code's own
 * `auth login` runs in main, straight into a credential store of the new
 * account's, and this modal is its front end. The browser opens by itself and
 * finishes the sign-in when it can; the link and the code field are for when
 * it cannot, or when the account to add is signed in in another browser.
 *
 * The machine-wide login is left alone, which is the difference with "Save
 * current account": that one needs `claude /login` to replace it first.
 *
 * With `reconnect`, the same sign-in renews a saved account whose login was
 * lost (a refused refresh, a sign-out elsewhere) instead of adding one: no
 * name to ask for, and main refuses a sign-in that lands on another account.
 *
 * With `onboarding`, it is the first-launch prompt shown when the machine has
 * no Claude login at all: worded as a welcome, "Later" instead of "Cancel",
 * and the account it signs in becomes the default, since nothing else would
 * put it in the machine-wide store the CLI in a terminal tab reads.
 *
 * Resolves with the account's summary, or null if the user gave up.
 */

const { createModal, showModal, closeModal } = require('./Modal');
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

/**
 * What to tell the user about a failed sign-in or capture. Main answers in
 * English; the one refusal a user is expected to meet, an account saved twice,
 * comes back with a code so it can be said in their language.
 * @param {{ error?: string, code?: string, accountName?: string }|null} res
 * @param {string} fallback
 */
function accountErrorMessage(res, fallback) {
  if (res?.code === 'ACCOUNT_DUPLICATE') return t('accounts.duplicate', { name: res.accountName || '' });
  if (res?.code === 'ACCOUNT_MISMATCH') return t('accounts.reconnectMismatch', { name: res.accountName || '' });
  return res?.error || fallback;
}

/**
 * @param {{ reconnect?: { id: string, name: string }, onboarding?: boolean }} [opts]
 */
function showAccountLoginModal({ reconnect = null, onboarding = false } = {}) {
  const api = window.electron_api;

  return new Promise((resolve) => {
    let running = false;
    let done = false;
    let unsubscribe = null;

    const finish = (account) => {
      if (done) return;
      done = true;
      if (unsubscribe) unsubscribe();
      // Closing the modal is giving up: the CLI would otherwise keep waiting
      // for a redirect nobody is going to send.
      if (running) api.accounts.loginCancel();
      resolve(account);
    };

    const modal = createModal({
      id: 'account-login-modal',
      title: reconnect
        ? t('accounts.reconnectTitle', { name: reconnect.name })
        : t(onboarding ? 'accounts.onboardingTitle' : 'accounts.loginTitle'),
      size: 'small',
      content: `
        <div class="account-switch-scope">${escapeHtml(reconnect
          ? t('accounts.reconnectIntro', { name: reconnect.name })
          : t(onboarding ? 'accounts.onboardingIntro' : 'accounts.loginIntro'))}</div>
        <div class="form-group"${reconnect ? ' hidden' : ''}>
          <label for="account-login-name">${escapeHtml(t('accounts.loginNameLabel'))}</label>
          <input type="text" id="account-login-name" autocomplete="off" placeholder="${escapeHtml(t('accounts.loginNamePlaceholder'))}">
        </div>
        <div class="account-login-link" hidden>
          <div class="account-switch-scope">${escapeHtml(t('accounts.loginBrowserHint'))}</div>
          <div class="form-group input-with-button">
            <input type="text" class="account-login-url" readonly>
            <button type="button" class="btn-browse" data-login="open">${escapeHtml(t('accounts.loginOpen'))}</button>
            <button type="button" class="btn-browse" data-login="copy">${escapeHtml(t('accounts.loginCopy'))}</button>
          </div>
          <div class="form-group">
            <label for="account-login-code">${escapeHtml(t('accounts.loginCodeLabel'))}</label>
            <div class="input-with-button">
              <input type="text" id="account-login-code" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(t('accounts.loginCodePlaceholder'))}">
              <button type="button" class="btn-browse" data-login="submit">${escapeHtml(t('accounts.loginSubmit'))}</button>
            </div>
          </div>
        </div>
        <div class="account-switch-note account-login-status" hidden></div>
        <div class="account-login-error" role="alert" hidden></div>
      `,
      buttons: [
        {
          label: onboarding ? t('accounts.onboardingLater') : t('common.cancel'),
          action: 'cancel',
          onClick: (m) => { closeModal(m); finish(null); }
        },
        {
          label: t('accounts.loginStart'),
          action: 'start',
          primary: true,
          onClick: () => start()
        }
      ],
      onClose: () => finish(null)
    });

    const nameInput = modal.querySelector('#account-login-name');
    const linkEl = modal.querySelector('.account-login-link');
    const urlInput = modal.querySelector('.account-login-url');
    const codeInput = modal.querySelector('#account-login-code');
    const submitBtn = modal.querySelector('[data-login="submit"]');
    const startBtn = modal.querySelector('[data-action="start"]');
    const statusEl = modal.querySelector('.account-login-status');
    const errorEl = modal.querySelector('.account-login-error');

    const setStatus = (text) => {
      statusEl.textContent = text || '';
      statusEl.hidden = !text;
    };
    const setError = (text) => {
      errorEl.textContent = text || '';
      errorEl.hidden = !text;
    };

    unsubscribe = api.accounts.onLoginProgress((event) => {
      if (!running || !event) return;
      if (event.type === 'url') {
        urlInput.value = event.url;
        linkEl.hidden = false;
        setStatus(t('accounts.loginWaiting'));
        codeInput.focus();
      } else if (event.type === 'invalid-code') {
        submitBtn.disabled = false;
        setStatus(t('accounts.loginWaiting'));
        setError(t('accounts.loginInvalidCode'));
        codeInput.select();
      }
    });

    async function start() {
      if (running || done) return;
      running = true;
      startBtn.disabled = true;
      nameInput.disabled = true;
      setError('');
      setStatus(t('accounts.loginStarting'));

      const res = reconnect
        ? await api.accounts.reconnect(reconnect.id)
        : await api.accounts.login(nameInput.value.trim());
      running = false;
      if (done) return;

      if (res?.success && onboarding && res.data?.id) {
        // The first account on a machine with no login is the one everything
        // runs as: putting it in the machine-wide store is what makes a plain
        // `claude` in a terminal tab signed in too.
        const def = await api.accounts.setDefault(res.data.id);
        if (!def?.success) console.warn('[AccountLoginModal] could not make the new account the default:', def?.error);
      }

      if (res?.success) {
        const { showSuccess } = require('./Toast');
        showSuccess(t(reconnect ? 'accounts.reconnectSuccess' : 'accounts.loginSuccess', { name: res.data?.name || '' }));
        closeModal(modal);
        finish(res.data || null);
        return;
      }
      // Back to the first step, so "Sign in" starts a fresh attempt: the CLI
      // that printed the link has exited, and its code would be refused.
      linkEl.hidden = true;
      urlInput.value = '';
      codeInput.value = '';
      submitBtn.disabled = false;
      startBtn.disabled = false;
      nameInput.disabled = false;
      setStatus('');
      if (res?.code !== 'LOGIN_CANCELLED') setError(accountErrorMessage(res, t('accounts.loginError')));
    }

    async function submitCode() {
      const code = codeInput.value.trim();
      if (!running || !code) return;
      submitBtn.disabled = true;
      setError('');
      setStatus(t('accounts.loginChecking'));
      await api.accounts.loginCode(code);
    }

    submitBtn.onclick = submitCode;
    codeInput.onkeydown = (e) => {
      if (e.key === 'Enter') submitCode();
    };
    nameInput.onkeydown = (e) => {
      if (e.key === 'Enter') start();
    };
    modal.querySelector('[data-login="open"]').onclick = () => {
      if (urlInput.value) api.dialog.openExternal(urlInput.value);
    };
    modal.querySelector('[data-login="copy"]').onclick = async () => {
      if (!urlInput.value) return;
      await api.app.clipboardWrite(urlInput.value);
      setStatus(t('accounts.loginCopied'));
    };

    showModal(modal);
  });
}

/**
 * First-launch prompt: offer to connect a Claude account when the machine has
 * none, neither saved here nor signed in through `claude /login`.
 *
 * Asked once, on a fresh profile only. `accountOnboardingDone` is set
 * whatever the answer, and also when an account is already there or the
 * profile already has projects, so a user who signs out later, or who has
 * been running Claude Code on an API key (no OAuth login either), is not met
 * with it after an update; Settings, Accounts is where that is fixed.
 *
 * @param {{ accountsState: Object, getSetting: Function, setSetting: Function, isFreshProfile: boolean }} deps
 * @returns {Promise<Object|null>} the connected account, or null
 */
async function maybeShowAccountOnboarding({ accountsState, getSetting, setSetting, isFreshProfile }) {
  if (getSetting('accountOnboardingDone')) return null;
  const { loaded, accounts = [], hasCredentials } = accountsState.get();
  // Not loaded means the list could not be read, which says nothing about
  // whether there is an account: ask again next launch.
  if (!loaded) return null;
  setSetting('accountOnboardingDone', true);
  if (!isFreshProfile || accounts.length > 0 || hasCredentials !== false) return null;
  return showAccountLoginModal({ onboarding: true });
}

module.exports = { showAccountLoginModal, maybeShowAccountOnboarding, accountErrorMessage };
