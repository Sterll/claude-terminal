/**
 * The side column's Branches: every branch this session worked on, one line
 * each, beside the conversation. Where it is (a worktree, the project folder,
 * a worktree since removed), how far it is from its upstream, what is not
 * committed, and its pull request as a chip: coloured by the Git tab's
 * verdict, marked with its CI.
 *
 * Nothing is read here. The rows come from what the Git tab already read
 * (gitTab's `onOverview`), so the column follows the tab's own cadence and
 * costs no git or GitHub call of its own. A click opens the Git tab on that
 * branch, where the actions are; the chip opens the pull request.
 */

'use strict';

const { t } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const { prVerdict, branchVerdict, workspacesOf, verdictText } = require('./sessionPrs');

const ICONS = {
  branch: '<svg class="chat-side-branch-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11.5 8.5"/></svg>',
  failed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  passed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
  merged: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>',
  pr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

/** Rows that need the user first, then what waits, then ready; a branch with nothing to say before what is done. */
const RANK = { action: 0, waiting: 1, ready: 2, none: 3, done: 4 };
const rankOf = (row) => RANK[row.verdict?.group || 'none'];

/**
 * One row per branch: each worktree the session used (or the project folder),
 * then the pull requests it opened from somewhere else. A row's `key` is the
 * Git tab's own (sessionPrs.rowsOf), so the tab can point at the same one.
 */
function branchRowsOf(s) {
  if (!s?.isRepo) return [];
  const rows = [];
  const seen = new Set();
  for (const ws of workspacesOf(s)) {
    const pr = ws.pr?.pullRequest || null;
    if (pr?.url) seen.add(pr.url);
    rows.push({
      key: pr ? pr.url || `#${pr.number}` : `branch:${ws.dir || ws.branch}`,
      branch: ws.branch || null,
      ws,
      pr,
      verdict: pr ? prVerdict(pr, ws) : branchVerdict(ws),
    });
  }
  for (const entry of s.mode === 'session' ? s.createdPrs : []) {
    const pr = entry.pullRequest;
    if (!pr || seen.has(pr.url)) continue;
    rows.push({ key: pr.url || `#${pr.number}`, branch: pr.headRef || null, ws: null, pr, verdict: prVerdict(pr) });
  }
  // Stable: rows of one rank keep the session's order, the latest worktree first.
  return rows.map((row, i) => ({ row, i })).sort((a, b) => rankOf(a.row) - rankOf(b.row) || a.i - b.i).map(({ row }) => row);
}

/** The chip's mark: the CI of an open pull request, else what became of it. */
function chipIcon(pr) {
  if (pr.state === 'merged') return ICONS.merged;
  if (pr.state === 'closed') return ICONS.failed;
  const checks = pr.checks;
  if (checks?.failure) return ICONS.failed;
  if (checks?.pending) return '<span class="chat-side-ci-running" aria-hidden="true"></span>';
  if (checks?.success) return ICONS.passed;
  return ICONS.pr;
}

function placeHtml(ws) {
  if (!ws) return '';
  const place = ws.isRoot ? t('chat.git.projectFolder') : t('chat.side.worktree');
  const removed = ws.removed ? ` · ${escapeHtml(t('chat.git.removedWorktree'))}` : '';
  return `<span title="${escapeHtml(ws.dir || '')}">${escapeHtml(place)}${removed}</span>`;
}

function driftHtml(ws) {
  if (!ws || ws.removed || !ws.upstream) return '';
  const parts = [ws.ahead ? `↑${ws.ahead}` : '', ws.behind ? `↓${ws.behind}` : ''].filter(Boolean);
  return parts.length ? `<span title="${escapeHtml(ws.upstream)}">${parts.join(' ')}</span>` : '';
}

function dirtyHtml(ws) {
  if (!ws || ws.removed || !ws.dirty) return '';
  const count = ws.dirty.staged + ws.dirty.unstaged + ws.dirty.untracked;
  if (!count) return '';
  return `<span class="chat-side-branch-dirty" title="${escapeHtml(t('chat.git.dirty', { count }))}">±${count}</span>`;
}

function rowHtml(row) {
  const { ws, pr, verdict: v } = row;
  const name = row.branch || (ws?.head ? t('chat.git.detached', { sha: ws.head }) : '');
  const verdict = v ? escapeHtml(verdictText(v)) : '';
  const chip = pr
    ? `<button type="button" class="chat-side-pr ${v.group}" data-action="open-pr" data-url="${escapeHtml(pr.url || '')}" title="${verdict}">${chipIcon(pr)}#${pr.number}</button>`
    : '';
  return `<div class="chat-side-branch${ws?.removed ? ' removed' : ''}" data-key="${escapeHtml(row.key)}" role="button" tabindex="0" title="${escapeHtml(t('chat.side.showInGitTab'))}">
      ${ICONS.branch}
      <div class="chat-side-branch-main">
        <div class="chat-side-branch-line">
          <span class="chat-side-branch-name">${escapeHtml(name)}</span>
          ${chip}
        </div>
        <div class="chat-side-branch-meta">
          ${placeHtml(ws)}${driftHtml(ws)}${dirtyHtml(ws)}
          ${v ? `<span class="chat-side-verdict ${v.group}">${verdict}</span>` : ''}
        </div>
      </div>
    </div>`;
}

function branchesHtml(rows) {
  return `${rows.map(rowHtml).join('')}
    <div class="chat-side-foot">
      <button type="button" class="chat-side-link end" data-action="open-tab">${escapeHtml(t('chat.side.openGitTab'))}${ICONS.arrow}</button>
    </div>`;
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.bodyEl the section's body
 * @param {(key: string) => void} deps.onOpen a row: the Git tab, on that branch
 * @param {() => void} deps.onOpenTab the footer's link
 * @param {(url: string) => void} deps.openExternal a pull request chip
 */
function createSideGit({ bodyEl, onOpen, onOpenTab, openExternal }) {
  function onClick(event) {
    const action = event.target.closest('[data-action]');
    if (action?.dataset.action === 'open-pr') {
      if (action.dataset.url) openExternal(action.dataset.url);
      return;
    }
    if (action?.dataset.action === 'open-tab') {
      onOpenTab();
      return;
    }
    const row = event.target.closest('.chat-side-branch');
    if (row) onOpen(row.dataset.key);
  }
  function onKey(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!event.target.matches('.chat-side-branch')) return;
    event.preventDefault();
    onOpen(event.target.dataset.key);
  }
  bodyEl.addEventListener('click', onClick);
  bodyEl.addEventListener('keydown', onKey);

  return {
    /** What the header and the strip need, without drawing anything. */
    stats(overview) {
      const rows = branchRowsOf(overview);
      return { count: rows.length, attention: rows.filter((r) => r.verdict?.group === 'action').length };
    },
    render(overview) {
      bodyEl.innerHTML = branchesHtml(branchRowsOf(overview));
    },
    destroy() {
      bodyEl.removeEventListener('click', onClick);
      bodyEl.removeEventListener('keydown', onKey);
    },
  };
}

module.exports = { createSideGit, branchRowsOf };
