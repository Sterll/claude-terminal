/**
 * The card that asks, in the conversation, whether detected tickets belong to
 * this session.
 *
 * Detection only ever suggests (see IssueDetectionService); this card is
 * where the user says yes or no. It lives in the transcript's DOM only: it is
 * not a message, it is never sent to Claude, and the conversation export
 * (built from the message history, not the DOM) never contains it.
 *
 * One card per batch: what one turn, or opening the tab, detected. Each
 * ticket is pre-checked; "Link the selection" confirms the checked ones and
 * dismisses the rest, "Ignore" dismisses them all. Either way the card shrinks
 * to one line that says what happened. A card left unanswered changes
 * nothing: the suggestions stay in the session's Tickets tab.
 */

'use strict';

const { t } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const { sourceLabel } = require('./ticketsTab');

const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1.5a2.5 2.5 0 0 0 0 5V16a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1.5a2.5 2.5 0 0 0 0-5z"/></svg>';

const keyOf = (ref) => ref.slice(ref.indexOf(':') + 1);

/**
 * @param {Array<{ ref: string, title: string|null, source: string, evidence: string|null }>} suggestions
 * @param {{ onConfirm: (refs: string[]) => Promise<any>, onDismiss: (refs: string[]) => Promise<any> }} handlers
 * @returns {HTMLElement}
 */
function createSuggestionCard(suggestions, { onConfirm, onDismiss }) {
  const el = document.createElement('div');
  el.className = 'ticket-suggestion-card';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', t('chat.tickets.cardTitle'));
  el.innerHTML = `
    <div class="ticket-suggestion-head">${ICON}<span>${escapeHtml(t('chat.tickets.cardTitle'))}</span></div>
    <ul class="ticket-suggestion-list">
      ${suggestions.map((s) => `
        <li>
          <label class="ticket-suggestion-item">
            <input type="checkbox" checked data-ref="${escapeHtml(s.ref)}">
            <span class="issue-key">${escapeHtml(keyOf(s.ref))}</span>
            <span class="ticket-suggestion-title">${escapeHtml(s.title || '')}</span>
            <span class="ticket-suggestion-why">${escapeHtml(sourceLabel(s.source))}${s.evidence ? ` · ${escapeHtml(s.evidence)}` : ''}</span>
          </label>
        </li>`).join('')}
    </ul>
    <div class="ticket-suggestion-actions">
      <button type="button" class="btn-sm ticket-suggestion-confirm">${escapeHtml(t('chat.tickets.cardConfirm'))}</button>
      <button type="button" class="btn-sm btn-secondary ticket-suggestion-dismiss">${escapeHtml(t('chat.tickets.cardDismiss'))}</button>
      <span class="ticket-suggestion-note">${escapeHtml(t('chat.tickets.cardNote'))}</span>
    </div>`;

  const all = suggestions.map((s) => s.ref);

  function settle(text) {
    el.classList.add('settled');
    el.innerHTML = `<div class="ticket-suggestion-head">${ICON}<span>${escapeHtml(text)}</span></div>`;
  }

  el.querySelector('.ticket-suggestion-confirm').addEventListener('click', async () => {
    const checked = [...el.querySelectorAll('input[type="checkbox"]')].filter((c) => c.checked).map((c) => c.dataset.ref);
    const rest = all.filter((ref) => !checked.includes(ref));
    el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    if (checked.length) await onConfirm(checked);
    if (rest.length) await onDismiss(rest);
    settle(checked.length
      ? t('chat.tickets.cardLinked', { keys: checked.map(keyOf).join(', ') })
      : t('chat.tickets.cardIgnored'));
  });

  el.querySelector('.ticket-suggestion-dismiss').addEventListener('click', async () => {
    el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    await onDismiss(all);
    settle(t('chat.tickets.cardIgnored'));
  });

  return el;
}

module.exports = { createSuggestionCard };
