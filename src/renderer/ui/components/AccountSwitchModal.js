/**
 * AccountSwitchModal
 * Prompts the user to switch the active Claude OAuth account when the
 * current one hits a usage / rate limit. Returns the chosen account id
 * (or null if the user cancelled / opened the terminal to /login).
 */

const { createModal, showModal, closeModal, showPrompt } = require('./Modal');
const { escapeHtml } = require('../../utils/dom');
const { t } = require('../../i18n');

function formatRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (!d || Number.isNaN(d)) return '';
  const diff = Date.now() - d;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return t('common.justNow') || 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function buildAccountRow(account, isActive) {
  const lastUsed = account.lastUsedAt ? formatRelative(account.lastUsedAt) : '';
  return `
    <button class="account-row${isActive ? ' active' : ''}" data-id="${account.id}" ${isActive ? 'disabled' : ''}>
      <div class="account-row-main">
        <div class="account-row-name">${escapeHtml(account.name)}</div>
        <div class="account-row-meta">${escapeHtml(account.fingerprint?.slice(0, 8) || '')}${lastUsed ? ` &middot; ${escapeHtml(lastUsed)}` : ''}</div>
      </div>
      <div class="account-row-status">${isActive ? escapeHtml(t('accounts.active') || 'Active') : escapeHtml(t('accounts.switch') || 'Switch')}</div>
    </button>
  `;
}

/**
 * Show the switch modal. Returns the id of the account the caller should
 * switch to, or null.
 *
 * @param {Object} opts
 * @param {string} [opts.reason]            Reason text shown above the list.
 * @param {string} [opts.activeAccountId]   Currently active account id (will be flagged).
 */
async function showAccountSwitchModal({ reason, activeAccountId } = {}) {
  const api = window.electron_api;
  const list = await api.accounts.list();
  if (!list.success) {
    console.error('[AccountSwitchModal] list failed:', list.error);
    return null;
  }
  const accounts = list.data.accounts || [];
  const activeId = activeAccountId || list.data.activeId;

  const reasonHtml = reason
    ? `<div class="account-switch-reason">${escapeHtml(reason)}</div>`
    : '';

  const emptyHint = `
    <div class="account-switch-empty">
      <p>${escapeHtml(t('accounts.emptyHint') || 'No saved accounts yet. Open a terminal, run "claude /login", then come back to capture this account.')}</p>
    </div>
  `;

  const listHtml = accounts.length
    ? `<div class="account-switch-list">${accounts.map(a => buildAccountRow(a, a.id === activeId)).join('')}</div>`
    : emptyHint;

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const modal = createModal({
      id: 'account-switch-modal',
      title: t('accounts.switchTitle') || 'Switch Claude account',
      size: 'small',
      content: `
        ${reasonHtml}
        ${listHtml}
        <div class="account-switch-actions">
          <button class="btn btn-secondary" data-extra="capture">${escapeHtml(t('accounts.captureCurrent') || 'Save current as new account')}</button>
        </div>
      `,
      buttons: [
        {
          label: t('common.cancel') || 'Cancel',
          action: 'cancel',
          onClick: (m) => { closeModal(m); finish(null); }
        }
      ],
      onClose: () => finish(null)
    });

    modal.querySelectorAll('.account-row[data-id]').forEach(row => {
      row.onclick = async () => {
        if (row.disabled) return;
        const id = row.dataset.id;
        row.disabled = true;
        const res = await api.accounts.switch(id);
        if (!res.success) {
          row.disabled = false;
          alert(res.error || 'Switch failed');
          return;
        }
        closeModal(modal);
        finish(id);
      };
    });

    const captureBtn = modal.querySelector('[data-extra="capture"]');
    if (captureBtn) {
      captureBtn.onclick = async () => {
        const name = await showPrompt({
          title: t('accounts.captureTitle') || 'Save current account',
          message: t('accounts.captureMessage') || 'Give this account a name. The credentials currently active in ~/.claude/.credentials.json will be saved under this name.',
          placeholder: 'e.g. Personal, Work…'
        });
        if (!name) return;
        const res = await api.accounts.capture(name);
        if (!res.success) {
          alert(res.error || 'Capture failed');
          return;
        }
        closeModal(modal);
        finish(res.data?.id || null);
      };
    }

    showModal(modal);
  });
}

module.exports = { showAccountSwitchModal };
