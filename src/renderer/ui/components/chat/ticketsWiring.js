/**
 * What ties a chat's Tickets tab (chat/ticketsTab.js) to the rest of the
 * conversation:
 *
 * - The confirmation cards (chat/ticketSuggestionCard.js). Suggestions from
 *   one moment (the branch and the PR title, several tool calls) arrive one
 *   by one: gathered for a moment, they make one card, and that card waits
 *   for the end of the turn rather than landing in the middle of Claude's
 *   answer.
 * - The Git tab's branch and pull request title, which may name tickets:
 *   each new one is handed to detection.
 * - The session recap a linked ticket is offered as a comment draft.
 *
 * Lifted out of ChatView, whose closure it only reads through the getters
 * below.
 */

'use strict';

const { t } = require('../../../i18n');
const { createSuggestionCard } = require('./ticketSuggestionCard');

const BATCH_MS = 600;

/**
 * @param {object} deps
 * @param {object} deps.api window.electron_api
 * @param {object} deps.ticketsTab the chat's Tickets tab
 * @param {() => object|null} deps.getGitSummary the Git tab's last summary
 * @param {() => object|null} deps.getProject
 * @param {() => string[]} deps.getEditedFiles paths Claude edited in this session
 * @param {(el: HTMLElement) => void} deps.showCard puts a card in the transcript
 * @param {() => boolean} deps.isStreaming
 */
function createTicketsWiring(deps) {
  const { api, ticketsTab } = deps;
  const pending = [];
  let timer = null;
  let destroyed = false;
  let observedBranch = null;
  let observedPrTitle = null;

  /** Every suggestion gathered so far, as one card. Called at the end of a turn too. */
  function flushCards() {
    if (!pending.length || destroyed) return;
    const batch = pending.splice(0);
    deps.showCard(createSuggestionCard(batch, {
      onConfirm: (refs) => ticketsTab.confirm(refs),
      onDismiss: (refs) => ticketsTab.dismiss(refs),
    }));
  }

  ticketsTab.onSuggestions((list) => {
    pending.push(...list);
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!deps.isStreaming()) flushCards();
    }, BATCH_MS);
  });

  /**
   * What this session did, as a markdown comment draft for a linked ticket:
   * branch, the branch's commits, the pull request, the files Claude edited.
   * Only a draft: the user edits it and publishes it themselves.
   */
  function buildRecap() {
    const s = deps.getGitSummary();
    const lines = [t('chat.tickets.recapHeading', { project: deps.getProject()?.name || '' })];
    if (s?.isRepo && s.branch) lines.push(`- ${t('chat.tickets.recapBranch')}: \`${s.branch}\``);
    if (s?.isRepo && !s.onBase && s.commits?.length) {
      lines.push(`- ${t('chat.tickets.recapCommits')}:`);
      for (const c of s.commits.slice(0, 10)) lines.push(`  - \`${c.short}\` ${c.subject}`);
    }
    const pr = s?.pr?.pullRequest;
    if (pr) lines.push(`- ${t('chat.tickets.recapPr')}: [#${pr.number} ${pr.title}](${pr.url})`);
    const files = deps.getEditedFiles().map((f) => f.split(/[\\/]/).pop());
    if (files.length) {
      const shown = files.slice(0, 8).map((f) => `\`${f}\``).join(', ');
      lines.push(`- ${t('chat.tickets.recapFiles', { count: files.length })}: ${shown}${files.length > 8 ? ', …' : ''}`);
    }
    return lines.join('\n');
  }

  /** A new branch or PR title from the Git tab: detection reads each once. */
  function observeGit(summary) {
    if (!summary?.isRepo || !api.issueLinks?.observeText) return;
    const key = ticketsTab.getKey();
    if (summary.branch && summary.branch !== observedBranch) {
      observedBranch = summary.branch;
      api.issueLinks.observeText(key, summary.branch, 'branch', summary.branch).catch(() => {});
    }
    const pr = summary.pr?.pullRequest;
    if (pr?.title && pr.title !== observedPrTitle) {
      observedPrTitle = pr.title;
      api.issueLinks.observeText(key, pr.title, 'pr', `#${pr.number}`).catch(() => {});
    }
  }

  return {
    flushCards,
    buildRecap,
    observeGit,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
    },
  };
}

module.exports = { createTicketsWiring };
