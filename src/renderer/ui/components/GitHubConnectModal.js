/**
 * GitHubConnectModal
 *
 * Connect (or reconnect) GitHub from the view that needs it, instead of
 * sending the user to Settings and leaving them to find their way back.
 *
 * It tries GitHub's Device Flow first (`github.startAuth` / `pollToken`, a code
 * to paste on github.com). When GitHub refuses to start one, which it does
 * for an OAuth app it does not know or one with the Device Flow turned off,
 * it offers the personal access token form Settings uses, the same field and
 * the same "How to create a token?" link. Either way the token is stored in
 * main and never comes back to the renderer.
 *
 * Every view that offers it listens for `ct-github-auth-changed` (see
 * onGitHubAuthChanged), so connecting from one refreshes the others too.
 * Opened once at a time: a second caller gets the same pending promise.
 */

const { createModal, showModal, closeModal } = require('./Modal');
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

const AUTH_CHANGED_EVENT = 'ct-github-auth-changed';
const TOKEN_HELP_URL = 'https://github.com/settings/tokens/new?scopes=repo,workflow&description=Claude%20Terminal';

let pending = null;

/** Say that GitHub's login changed, so every view that depends on it reads again. */
function notifyGitHubAuthChanged(status) {
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT, { detail: status || null }));
}

/**
 * @param {(status: object|null) => void} listener
 * @returns {() => void} unsubscribe
 */
function onGitHubAuthChanged(listener) {
  const handler = (e) => listener(e.detail);
  window.addEventListener(AUTH_CHANGED_EVENT, handler);
  return () => window.removeEventListener(AUTH_CHANGED_EVENT, handler);
}

/** "Connect GitHub", or "Reconnect GitHub" when the saved login was refused. */
function connectLabel(expired) {
  return t(expired ? 'github.connect.reconnect' : 'github.connect.connect');
}

/**
 * The one button a view shows. Its click is the view's to handle (it calls
 * connectGitHub and reads again), through `data-action`.
 * @param {{ expired?: boolean, action?: string, className?: string }} [opts]
 */
function connectButtonHtml({ expired = false, action = 'connect-github', className = 'btn-sm btn-secondary' } = {}) {
  return `<button type="button" class="${escapeHtml(className)}" data-action="${escapeHtml(action)}" data-expired="${expired ? 'true' : 'false'}">${escapeHtml(connectLabel(expired))}</button>`;
}

/**
 * Open the sign-in. Resolves with the auth status once connected
 * (`{ authenticated: true, login, ... }`), or null if the user gave up.
 * @param {{ reconnect?: boolean, api?: Object }} [opts]
 * @returns {Promise<Object|null>}
 */
function connectGitHub({ reconnect = false, api = window.electron_api } = {}) {
  if (pending) return pending;
  pending = new Promise((resolve) => {
    let done = false;
    let polling = false;

    const finish = (status) => {
      if (done) return;
      done = true;
      pending = null;
      // Closing is giving up: main would otherwise keep polling for a code
      // nobody is going to enter, and store the token if someone did.
      if (polling && !status) api.github.cancelAuth?.();
      resolve(status);
    };

    const modal = createModal({
      id: 'github-connect-modal',
      title: connectLabel(reconnect),
      size: 'small',
      content: `
        <div class="account-switch-scope">${escapeHtml(t(reconnect ? 'github.connect.reconnectIntro' : 'github.connect.intro'))}</div>
        <div class="github-connect-body"><div class="github-waiting"><span class="btn-spinner"></span> ${escapeHtml(t('github.connect.starting'))}</div></div>
      `,
      buttons: [{ label: t('common.cancel'), action: 'cancel', onClick: (m) => { closeModal(m); finish(null); } }],
      onClose: () => finish(null),
    });
    const body = modal.querySelector('.github-connect-body');

    async function connected() {
      const status = await api.github.authStatus();
      if (done) return;
      if (!status?.authenticated) {
        // Stored, but GitHub does not accept it: say so where the user is.
        showTokenForm(t('settings.githubTokenInvalid'));
        return;
      }
      const { showSuccess } = require('./Toast');
      showSuccess(t('github.connect.success', { login: status.login || '' }));
      notifyGitHubAuthChanged(status);
      closeModal(modal);
      finish(status);
    }

    function showTokenForm(error = '') {
      polling = false;
      body.innerHTML = `
        <div class="account-switch-note">${escapeHtml(t('github.connect.tokenIntro'))}</div>
        <div class="github-token-form">
          <div class="github-token-input-group">
            <input type="password" class="github-token-input" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off" spellcheck="false">
            <button type="button" class="btn-github-connect" data-github="token-submit">${escapeHtml(t('settings.githubConnect'))}</button>
          </div>
          <div class="github-token-help"><a href="#" data-github="token-help">${escapeHtml(t('settings.githubTokenHelp'))}</a></div>
        </div>
        <div class="github-error" role="alert"${error ? '' : ' hidden'}>${escapeHtml(error)}</div>
      `;
      const input = body.querySelector('.github-token-input');
      const submit = body.querySelector('[data-github="token-submit"]');
      const errorEl = body.querySelector('.github-error');
      const send = async () => {
        const token = input.value.trim();
        if (!token) { input.focus(); return; }
        submit.disabled = true;
        errorEl.hidden = true;
        const res = await api.github.setToken(token);
        if (done) return;
        input.value = '';
        submit.disabled = false;
        if (res?.success && res.authenticated) {
          await connected();
          return;
        }
        errorEl.textContent = t('settings.githubTokenInvalid');
        errorEl.hidden = false;
        input.focus();
      };
      submit.onclick = send;
      input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
      body.querySelector('[data-github="token-help"]').onclick = (e) => {
        e.preventDefault();
        api.github.openAuthUrl(TOKEN_HELP_URL);
      };
      input.focus();
    }

    async function startDeviceFlow() {
      let flow;
      try {
        flow = await api.github.startAuth();
      } catch (err) {
        flow = { success: false, error: err.message };
      }
      if (done) return;
      if (!flow?.success || !flow.user_code || !flow.device_code) {
        showTokenForm();
        return;
      }

      body.innerHTML = `
        <div class="github-device-flow">
          <div class="device-code-section">
            <div class="device-code-label">${escapeHtml(t('github.connect.codeLabel'))}</div>
            <div class="device-code">${escapeHtml(flow.user_code)}</div>
          </div>
          <div class="device-flow-steps">
            <a href="#" class="device-flow-link" data-github="open">${escapeHtml(t('github.connect.open'))}</a>
          </div>
          <div class="github-waiting"><span class="btn-spinner"></span> ${escapeHtml(t('github.connect.waiting'))}</div>
          <div class="github-error" role="alert" hidden></div>
          <div class="github-token-help"><a href="#" data-github="use-token">${escapeHtml(t('github.connect.useToken'))}</a></div>
        </div>
      `;
      body.querySelector('[data-github="open"]').onclick = async (e) => {
        e.preventDefault();
        try { await api.app.clipboardWrite(flow.user_code); } catch { /* the code is on screen */ }
        api.github.openAuthUrl(flow.verification_uri || 'https://github.com/login/device');
      };
      body.querySelector('[data-github="use-token"]').onclick = (e) => {
        e.preventDefault();
        api.github.cancelAuth?.();
        showTokenForm();
      };

      polling = true;
      const res = await api.github.pollToken({ deviceCode: flow.device_code, interval: flow.interval || 5 });
      if (done || !polling) return;
      polling = false;
      if (res?.success) {
        await connected();
        return;
      }
      if (res?.code === 'GITHUB_AUTH_CANCELLED') return;
      // `.github-waiting` is display:flex, which `hidden` would not override.
      body.querySelector('.github-waiting')?.remove();
      const errorEl = body.querySelector('.github-error');
      if (errorEl) {
        errorEl.textContent = res?.error || t('github.connect.failed');
        errorEl.hidden = false;
      }
    }

    showModal(modal);
    startDeviceFlow();
  });
  return pending;
}

module.exports = {
  connectGitHub,
  connectButtonHtml,
  connectLabel,
  onGitHubAuthChanged,
  notifyGitHubAuthChanged,
  AUTH_CHANGED_EVENT,
};
