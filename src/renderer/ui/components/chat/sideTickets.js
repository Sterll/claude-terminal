/**
 * The side column's Tickets: the tickets this session works on, one line
 * each, beside the conversation. State, key, title, priority, assignee and
 * sub-issues for a linked ticket; a detected one waits under them, dashed,
 * with Link and Ignore right there, since answering it needs nothing more.
 *
 * Everything comes from the Tickets tab (chat/ticketsTab.js): its links, and
 * its cache of each ticket's state, so the tab and the column never read a
 * ticket twice in the same 30 s. A click opens the tab on that ticket, where
 * its state, comments and recap are.
 */

'use strict';

const { t } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const issueView = require('../../panels/issues/issueView');
const { sourceLabel } = require('./ticketsTab');

const ICONS = {
  dismiss: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

/** What is being worked on first, what is over last. A ticket not read yet keeps its place among the open ones. */
const RANK = { started: 0, todo: 1, backlog: 2, done: 3, canceled: 4 };

const keyOf = (ref) => ref.slice(ref.indexOf(':') + 1);

function linkedRowHtml(link, hit) {
  const issue = hit?.issue || null;
  const key = keyOf(link.ref);
  const meta = issue
    ? `<span>${escapeHtml(issue.state.name)}</span>
       ${issueView.priorityIcon(issue.priority)}
       ${issue.assignee ? issueView.avatarHtml(issue.assignee, 'issue-avatar-sm') : ''}
       ${issueView.progressHtml(issue.subIssues)}`
    : `<span>${escapeHtml(hit?.error ? t('chat.tickets.loadFailed') : t('tickets.panel.loading'))}</span>`;
  return `<div class="chat-side-ticket" data-ref="${escapeHtml(link.ref)}" role="button" tabindex="0" title="${escapeHtml(t('chat.side.showInTicketsTab'))}">
      ${issue ? issueView.stateDot(issue.state) : '<span class="issue-state" data-category="backlog"></span>'}
      <div class="chat-side-ticket-main">
        <div class="chat-side-ticket-line">
          <span class="chat-side-ticket-key">${escapeHtml(key)}</span>
          <span class="chat-side-ticket-title">${escapeHtml(issue?.title || link.title || key)}</span>
        </div>
        <div class="chat-side-ticket-meta">${meta}</div>
      </div>
    </div>`;
}

function suggestedRowHtml(link) {
  const key = keyOf(link.ref);
  const why = `${sourceLabel(link.source)}${link.evidence ? ` · ${link.evidence}` : ''}`;
  return `<div class="chat-side-ticket suggested" data-ref="${escapeHtml(link.ref)}" role="button" tabindex="0" title="${escapeHtml(t('chat.side.showInTicketsTab'))}">
      <span class="issue-state" data-category="backlog"></span>
      <div class="chat-side-ticket-main">
        <div class="chat-side-ticket-line">
          <span class="chat-side-ticket-key">${escapeHtml(key)}</span>
          <span class="chat-side-ticket-title">${escapeHtml(link.title || key)}</span>
        </div>
        <div class="chat-side-ticket-meta"><span class="chat-side-ticket-why">${escapeHtml(why)}</span></div>
      </div>
      <div class="chat-side-ticket-actions">
        <button type="button" class="chat-side-ticket-confirm" data-action="confirm">${escapeHtml(t('chat.tickets.confirm'))}</button>
        <button type="button" class="chat-side-ticket-dismiss" data-action="dismiss" title="${escapeHtml(t('chat.tickets.cardDismiss'))}" aria-label="${escapeHtml(t('chat.tickets.cardDismiss'))}">${ICONS.dismiss}</button>
      </div>
    </div>`;
}

/** The linked ones by state, then the suggested ones. */
function ticketRowsOf(links, getIssue) {
  const linked = links
    .filter((l) => l.status === 'linked')
    .map((link, i) => ({ link, hit: getIssue(link.ref), i }))
    .sort((a, b) => (RANK[a.hit?.issue?.state.category] ?? 1) - (RANK[b.hit?.issue?.state.category] ?? 1) || a.i - b.i);
  const suggested = links.filter((l) => l.status === 'suggested');
  return { linked, suggested };
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.bodyEl the section's body
 * @param {(ref: string) => void} deps.onOpen a row: the Tickets tab, on that ticket
 * @param {() => void} deps.onOpenTab the footer's link
 * @param {() => void} deps.onLinkNew the footer's "Link a ticket": the tab's search
 * @param {(ref: string, yes: boolean) => void} deps.onAnswer a suggestion's Link or Ignore
 */
function createSideTickets({ bodyEl, onOpen, onOpenTab, onLinkNew, onAnswer }) {
  function onClick(event) {
    const action = event.target.closest('[data-action]');
    const ref = event.target.closest('.chat-side-ticket')?.dataset.ref || null;
    switch (action?.dataset.action) {
      case 'confirm':
        if (ref) onAnswer(ref, true);
        return;
      case 'dismiss':
        if (ref) onAnswer(ref, false);
        return;
      case 'link-new':
        onLinkNew();
        return;
      case 'open-tab':
        onOpenTab();
        return;
      default:
        if (ref) onOpen(ref);
    }
  }
  function onKey(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!event.target.matches('.chat-side-ticket')) return;
    event.preventDefault();
    onOpen(event.target.dataset.ref);
  }
  bodyEl.addEventListener('click', onClick);
  bodyEl.addEventListener('keydown', onKey);

  return {
    /** What the header and the strip need, without drawing anything. */
    stats(links) {
      return {
        count: links.filter((l) => l.status === 'linked').length,
        suggested: links.filter((l) => l.status === 'suggested').length,
      };
    },
    render(links, getIssue) {
      const { linked, suggested } = ticketRowsOf(links, getIssue);
      const empty = !linked.length && !suggested.length
        ? `<div class="chat-side-empty">${escapeHtml(t('chat.side.noTickets'))}</div>`
        : '';
      bodyEl.innerHTML = `${empty}
        ${linked.map(({ link, hit }) => linkedRowHtml(link, hit)).join('')}
        ${suggested.map(suggestedRowHtml).join('')}
        <div class="chat-side-foot">
          <button type="button" class="chat-side-link" data-action="link-new">${ICONS.plus}${escapeHtml(t('chat.tickets.link'))}</button>
          <button type="button" class="chat-side-link end" data-action="open-tab">${escapeHtml(t('chat.side.openTicketsTab'))}${ICONS.arrow}</button>
        </div>`;
    },
    destroy() {
      bodyEl.removeEventListener('click', onClick);
      bodyEl.removeEventListener('keydown', onKey);
    },
  };
}

module.exports = { createSideTickets, ticketRowsOf };
