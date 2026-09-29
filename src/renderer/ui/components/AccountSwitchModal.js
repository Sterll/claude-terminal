/**
 * AccountSwitchModal
 *
 * Offered when a session hits a usage / rate limit. Accounts are chosen per
 * project, so the fix is to re-bind *this* project to another account rather
 * than swap a global one out from under every other tab — which is what this
 * used to do, and what would now interrupt work that had nothing to do with
 * the limit.
 *
 * Each row carries that account's usage figures, and an account that cannot
 * take the conversation is greyed out and refuses the click: the one that
 * just ran out, and any other whose figures show a limit this conversation
 * needs is full. The choice used to be made on names alone, which is how a
 * switch landed on an account that was spent too.
 *
 * Returns the chosen account id, or null if the user cancelled.
 */

const { createModal, showModal, closeModal, showPrompt } = require('./Modal');
const { escapeHtml } = require('../../utils/dom');
const { sanitizeColor } = require('../../utils/color');
const { t } = require('../../i18n');
const { setProjectAccount } = require('../../state/projects.state');
const { buildAccountUsageHtml, blockingLimit, formatBucketReset } = require('./accountUsage');

// How old an account's figures may be before the offer asks again. Settings
// accepts five minutes because it redraws on every rename; here the question
// is whether an account can take a turn right now, and five minutes is enough
// to go from 97% to full. One call per account, once per limit hit.
const USAGE_MAX_AGE_MS = 60 * 1000;

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

// The account that hit the limit is greyed out from the start, while the
// others wait on their figures: it is unavailable whatever those say.
function buildAccountRow(account, isLimited) {
  const lastUsed = account.lastUsedAt ? formatRelative(account.lastUsedAt) : '';
  const color = sanitizeColor(account.color);
  const dot = color
    ? `<span class="account-row-dot" style="background:${color}"></span>`
    : '<span class="account-row-dot account-row-dot--none"></span>';
  return `
    <button class="account-row${isLimited ? ' unavailable' : ''}" data-id="${escapeHtml(account.id)}" ${isLimited ? 'disabled' : ''}>
      ${dot}
      <div class="account-row-main">
        <div class="account-row-name">${escapeHtml(account.name)}</div>
        <div class="account-row-meta">${escapeHtml(account.fingerprint?.slice(0, 8) || '')}${lastUsed ? ` &middot; ${escapeHtml(lastUsed)}` : ''}</div>
      </div>
      <div class="account-row-status">${isLimited ? escapeHtml(t('accounts.limited') || 'Limit reached') : escapeHtml(t('accounts.useForProject') || 'Use here')}</div>
      <div class="account-switch-usage">${buildAccountUsageHtml(null)}</div>
    </button>
  `;
}

/**
 * Grey a row out and say when it comes back, if the figures know.
 * @param {HTMLButtonElement} row
 * @param {Object|null} bucket - the limit holding it, when known
 */
function markUnavailable(row, bucket) {
  row.disabled = true;
  row.classList.add('unavailable');
  const status = row.querySelector('.account-row-status');
  if (status) status.textContent = t('accounts.limited') || 'Limit reached';
  const until = bucket ? formatBucketReset(bucket) : '';
  if (until) row.title = t('accounts.limitedUntil', { time: until });
}

/**
 * Offer to move this project onto another account. Returns the chosen account
 * id, or null.
 *
 * @param {Object} opts
 * @param {string} [opts.reason]            Reason text shown above the list.
 * @param {string} [opts.activeAccountId]   The account that hit the limit.
 * @param {string} [opts.projectId]         Project to re-bind. Without it the
 *                                          choice falls back to the default
 *                                          account, since there is nothing to
 *                                          pin the decision to.
 * @param {string} [opts.projectName]
 * @param {string} [opts.model]             Model the conversation runs on,
 *                                          which decides whether a limit
 *                                          scoped to one model applies.
 */
async function showAccountSwitchModal({ reason, activeAccountId, projectId = null, projectName = '', model = null } = {}) {
  const api = window.electron_api;
  const list = await api.accounts.list();
  if (!list.success) {
    console.error('[AccountSwitchModal] list failed:', list.error);
    return null;
  }
  const accounts = list.data.accounts || [];
  const limitedId = activeAccountId || list.data.defaultId;

  const scopeHtml = projectId
    ? `<div class="account-switch-scope">${escapeHtml(t('accounts.rebindScope', { project: projectName || projectId }))}</div>`
    : `<div class="account-switch-scope">${escapeHtml(t('accounts.rebindScopeDefault') || 'This will change the default account.')}</div>`;

  const reasonHtml = reason
    ? `<div class="account-switch-reason">${escapeHtml(reason)}</div>`
    : '';

  const emptyHint = `
    <div class="account-switch-empty">
      <p>${escapeHtml(t('accounts.emptyHint') || 'No saved accounts yet. Open a terminal, run "claude /login", then come back to capture this account.')}</p>
    </div>
  `;

  const listHtml = accounts.length
    ? `<div class="account-switch-list">${accounts.map(a => buildAccountRow(a, a.id === limitedId)).join('')}</div>`
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
      title: projectId
        ? (t('accounts.rebindTitle') || 'Run this project on another account')
        : (t('accounts.switchTitle') || 'Switch Claude account'),
      size: 'small',
      content: `
        ${reasonHtml}
        ${scopeHtml}
        ${listHtml}
        <div class="account-switch-note" hidden></div>
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
        // Re-bind this project only. Every other tab keeps running on the
        // account it was already using; nothing else is interrupted by a limit
        // that was not theirs.
        if (projectId) {
          setProjectAccount(projectId, id);
        } else {
          const res = await api.accounts.setDefault(id);
          if (!res.success) {
            row.disabled = false;
            alert(res.error || 'Switch failed');
            return;
          }
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
        // A freshly captured account is only useful here if the project moves
        // onto it — otherwise the limit stands and the session cannot resume.
        if (projectId && res.data?.id) setProjectAccount(projectId, res.data.id);
        closeModal(modal);
        finish(res.data?.id || null);
      };
    }

    showModal(modal);

    // Figures come after the list rather than before it: the sweep waits on
    // every account's API call, up to five seconds each, and the offer is what
    // the user is waiting on. A row stays clickable while its figures load.
    // Rows are never reordered once they arrive, since that would move the one
    // under the pointer.
    if (accounts.length && typeof api.accounts.usage === 'function') {
      api.accounts.usage(USAGE_MAX_AGE_MS).then((res) => {
        if (resolved) return;
        paintUsage(res?.success ? (res.data || {}) : null);
      }).catch((err) => {
        console.warn('[AccountSwitchModal] usage failed:', err?.message);
        if (!resolved) paintUsage(null);
      });
    }

    /** @param {Object|null} usageById - null when the sweep itself failed */
    function paintUsage(usageById) {
      const blockers = [];
      let selectable = 0;
      for (const row of modal.querySelectorAll('.account-row[data-id]')) {
        const id = row.dataset.id;
        const usage = usageById?.[id];
        const slot = row.querySelector('.account-switch-usage');
        // A failed sweep says nothing about any account, so the rows lose
        // their loading line rather than claiming every one is signed out.
        if (slot) slot.innerHTML = usageById ? buildAccountUsageHtml(usage) : '';
        const bucket = blockingLimit(usage, { model });
        if (!bucket && id !== limitedId) {
          selectable += 1;
          continue;
        }
        markUnavailable(row, bucket);
        blockers.push(bucket);
      }
      // Nowhere to go, so say when that changes: it is the only thing left to
      // decide on. Unknown figures leave a row selectable, so this never
      // fires over an account that merely could not be read.
      const note = modal.querySelector('.account-switch-note');
      if (!note || selectable || !blockers.length) return;
      // A time only when every account has one: an account that ran out
      // without a full bar to show for it could be back at any moment.
      const known = blockers.every(b => b && formatBucketReset(b));
      const first = known
        ? blockers.slice().sort((a, b) => new Date(a.resetsAt) - new Date(b.resetsAt))[0]
        : null;
      note.textContent = first
        ? t('accounts.allLimitedUntil', { time: formatBucketReset(first) })
        : (t('accounts.allLimited') || 'Every saved account has hit a limit.');
      note.hidden = false;
    }
  });
}

module.exports = { showAccountSwitchModal };
