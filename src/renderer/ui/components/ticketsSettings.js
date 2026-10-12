/**
 * Settings → Tickets: connect a ticket tracker with a personal API key.
 *
 * One card per provider the build ships, so a new adapter appears here without
 * touching this file. A key is typed here, handed to main once through
 * `issueTrackers.connect`, and cleared from the input whatever the answer:
 * from then on the renderer only ever sees it masked.
 */

'use strict';

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');

function initials(name) {
  const letters = String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase());
  return letters.join('') || '?';
}

/** What to tell the user, by the error code main kept for us. */
function errorMessage(res, providerName) {
  switch (res?.code) {
    case 'AUTH': return t('tickets.settings.errorAuth');
    case 'RATE_LIMITED': return t('tickets.settings.errorRateLimited');
    case 'NETWORK': return t('tickets.settings.errorNetwork', { provider: providerName });
    case 'NOT_FOUND': return t('tickets.settings.errorNotFound');
    default: return t('tickets.settings.errorProvider', { provider: providerName, message: res?.error || '' });
  }
}

function avatarHtml(user) {
  if (user?.avatarUrl) return `<img class="tickets-avatar" src="${escapeHtml(user.avatarUrl)}" alt="">`;
  return `<span class="tickets-avatar" aria-hidden="true">${escapeHtml(initials(user?.name))}</span>`;
}

function connectionHtml(conn, { canTest }) {
  return `
    <div class="tickets-connection" data-connection-id="${escapeHtml(conn.id)}">
      ${avatarHtml(conn.user)}
      <div class="tickets-connection-info">
        <div class="tickets-connection-workspace">${escapeHtml(conn.workspace?.name || conn.id)}</div>
        <div class="tickets-connection-meta">${escapeHtml(t('tickets.settings.connectedAs', {
          user: conn.user?.name || '?',
          key: conn.maskedKey || '••••',
        }))}</div>
      </div>
      ${canTest ? `<button type="button" class="btn-sm btn-secondary tickets-test">${escapeHtml(t('tickets.settings.test'))}</button>` : ''}
      <button type="button" class="btn-sm btn-outline-danger tickets-disconnect">${escapeHtml(t('tickets.settings.disconnect'))}</button>
    </div>`;
}

function providerHtml(provider, connections) {
  const mine = connections.filter((c) => c.provider === provider.id);
  const help = provider.auth?.helpUrl
    ? `<a href="#" class="tickets-help-link" data-url="${escapeHtml(provider.auth.helpUrl)}">${escapeHtml(t('tickets.settings.helpLink', { provider: provider.name }))}</a>`
    : '';
  return `
    <div class="settings-card tickets-provider" data-provider="${escapeHtml(provider.id)}" data-provider-name="${escapeHtml(provider.name)}">
      <div class="tickets-provider-name">${escapeHtml(provider.name)}</div>
      ${mine.map((c) => connectionHtml(c, { canTest: true })).join('')}
      <div class="tickets-connect-form">
        <input type="password" class="tickets-key-input" autocomplete="off" spellcheck="false"
               placeholder="${escapeHtml(t('tickets.settings.keyPlaceholder', { provider: provider.name }))}"
               aria-label="${escapeHtml(t('tickets.settings.keyPlaceholder', { provider: provider.name }))}">
        <button type="button" class="btn-sm tickets-connect">${escapeHtml(mine.length ? t('tickets.settings.connectAnother') : t('tickets.settings.connect'))}</button>
      </div>
      <div class="tickets-provider-foot">
        ${help}
        <span class="tickets-status" role="status" aria-live="polite"></span>
      </div>
    </div>`;
}

/** Connections whose adapter this build no longer has: they can only be removed. */
function unavailableHtml(connections) {
  return `
    <div class="settings-card tickets-provider" data-provider="" data-provider-name="">
      <div class="tickets-provider-name">${escapeHtml(t('tickets.settings.unavailable'))}</div>
      ${connections.map((c) => connectionHtml(c, { canTest: false })).join('')}
      <div class="tickets-provider-foot"><span class="tickets-status" role="status" aria-live="polite"></span></div>
    </div>`;
}

function setStatus(card, text, kind) {
  const el = card?.querySelector('.tickets-status');
  if (!el) return;
  el.textContent = text || '';
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

/**
 * Fill `root` with the provider cards and wire them.
 *
 * @param {HTMLElement} root
 * @param {{ api: object }} deps `api` is `window.electron_api`
 * @returns {Promise<{ refresh: () => Promise<void> }>}
 */
async function mountTicketsSettings(root, { api }) {
  const bridge = api.issueTrackers;

  async function render() {
    root.setAttribute('aria-busy', 'true');
    const [providers, connections] = await Promise.all([bridge.providers(), bridge.connections()]);
    root.removeAttribute('aria-busy');
    const failed = !providers?.ok ? providers : !connections?.ok ? connections : null;
    if (failed) {
      root.innerHTML = `<div class="tickets-empty">${escapeHtml(t('tickets.settings.loadFailed', { message: failed?.error || '' }))}</div>`;
      return;
    }
    if (!providers.providers.length) {
      root.innerHTML = `<div class="tickets-empty">${escapeHtml(t('tickets.settings.noProviders'))}</div>`;
      return;
    }
    const orphaned = connections.connections.filter((c) => !c.available);
    root.innerHTML = providers.providers.map((p) => providerHtml(p, connections.connections)).join('')
      + (orphaned.length ? unavailableHtml(orphaned) : '');
  }

  async function connect(card) {
    const input = card.querySelector('.tickets-key-input');
    const button = card.querySelector('.tickets-connect');
    const key = input.value.trim();
    if (!key) {
      input.focus();
      input.classList.add('error');
      setTimeout(() => input.classList.remove('error'), 1000);
      return;
    }
    button.disabled = true;
    setStatus(card, t('tickets.settings.checking'), 'pending');
    const res = await bridge.connect(card.dataset.provider, key);
    input.value = '';
    if (!res?.ok) {
      button.disabled = false;
      setStatus(card, errorMessage(res, card.dataset.providerName), 'error');
      return;
    }
    const provider = card.dataset.provider;
    await render();
    const fresh = [...root.querySelectorAll('.tickets-provider')].find((el) => el.dataset.provider === provider);
    setStatus(fresh, t('tickets.settings.connected', { workspace: res.connection.workspace.name }), 'ok');
  }

  root.addEventListener('click', async (event) => {
    const target = event.target.closest('button, a');
    if (!target || !root.contains(target)) return;
    const card = target.closest('.tickets-provider');
    const connectionId = target.closest('.tickets-connection')?.dataset.connectionId;

    if (target.matches('.tickets-help-link')) {
      event.preventDefault();
      api.dialog.openExternal(target.dataset.url);
    } else if (target.matches('.tickets-connect')) {
      await connect(card);
    } else if (target.matches('.tickets-test')) {
      target.disabled = true;
      setStatus(card, t('tickets.settings.checking'), 'pending');
      const res = await bridge.test(connectionId);
      target.disabled = false;
      setStatus(card, res?.ok ? t('tickets.settings.testOk') : errorMessage(res, card.dataset.providerName), res?.ok ? 'ok' : 'error');
    } else if (target.matches('.tickets-disconnect')) {
      target.disabled = true;
      const res = await bridge.disconnect(connectionId);
      if (res?.ok) await render();
      else {
        target.disabled = false;
        setStatus(card, errorMessage(res, card.dataset.providerName), 'error');
      }
    }
  });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('.tickets-key-input')) {
      event.preventDefault();
      connect(event.target.closest('.tickets-provider'));
    }
  });

  await render();
  return { refresh: render };
}

module.exports = { mountTicketsSettings };
