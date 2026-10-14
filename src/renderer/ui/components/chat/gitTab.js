/**
 * The chat's Git tab: where this session's branch stands.
 *
 * Beside Changes, not instead of it. Changes is what Claude edited in this
 * session; Git is the repository's side: branch and its drift from upstream,
 * the base it is measured against, uncommitted files, the branch's own
 * commits, and its pull request with checks and reviews.
 *
 * Everything comes from one read-only call (`git.sessionSummary`, served by
 * SessionGitService). It is first read when the chat is first on screen
 * (`probeWhenOnScreen`), so tabs restored at startup cost nothing until they
 * are looked at. Then when the tab is shown, every 30 s while it stays shown
 * and the window is focused, and shortly after a tool result, since a tool is
 * what commits and pushes.
 *
 * The pull requests' checks are this session's CI, so they are also told to
 * the tab button (`onCiStatus`), which shows them without the tab open. That
 * is the one thing read while hidden: every 15 s while a check runs, at most
 * every 30 s after a tool result (it may have pushed).
 *
 * Nothing is read while the chat is off screen, its Git tab open or not: a
 * session in a background tab or another project costs nothing, and catches
 * up as soon as it is back.
 *
 * A session that worked in its own worktrees shows those instead
 * (`git.sessionOverview`, read from its transcript): its pull requests as one
 * list, a verdict each, grouped by what needs the user and what waits on
 * someone else (chat/sessionPrs.js), then its worktrees, folded. Reading the
 * project folder alone gave every session of a project the same branch and
 * the same pull request. A new tab, or a session that never left the folder,
 * still shows the folder.
 *
 * The rows that need the user are counted on the tab button (`onAttention`),
 * beside the CI dot.
 */

'use strict';

const { t, getCurrentLanguage } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const { formatRelativeTimeIntl } = require('../../../utils/format');
const {
  GROUPS, prVerdict, rowsOf, groupRows, attentionCount, noticesOf, repoLabeller, verdictText, groupLabel,
  conflictsPrompt, behindPrompt, reviewPrompt,
} = require('./sessionPrs');

const POLL_MS = 30_000;
const TICK_MS = 15_000;
const STALE_DEBOUNCE_MS = 1500;
const FRESH_MS = 10_000;

const ICONS = {
  branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11.5 8.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
  pr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4"/><path d="M13 3l-2 3 2 3"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};

function prStateLabel(pr) {
  if (pr.state === 'merged') return t('chat.git.prMerged');
  if (pr.state === 'closed') return t('chat.git.prClosed');
  return pr.draft ? t('chat.git.prDraft') : t('chat.git.prOpen');
}

function syncHtml(s) {
  if (!s.branch) return `<span class="session-git-muted">${escapeHtml(t('chat.git.detached', { sha: s.head || '' }))}</span>`;
  if (!s.upstream) return `<span class="session-git-warn">${escapeHtml(t('chat.git.unpublished'))}</span>`;
  if (!s.ahead && !s.behind) return `<span class="session-git-muted">${escapeHtml(t('chat.git.upToDate', { upstream: s.upstream }))}</span>`;
  return `<span class="session-git-drift" title="${escapeHtml(s.upstream)}">
      <span class="session-git-pill${s.ahead ? ' accent' : ''}">↑ ${s.ahead}</span>
      <span class="session-git-pill${s.behind ? ' warn' : ''}">↓ ${s.behind}</span>
      <span class="session-git-muted">${escapeHtml(s.upstream)}</span>
    </span>`;
}

function dirtyHtml(dirty) {
  const total = dirty.staged + dirty.unstaged + dirty.untracked;
  if (!total && !dirty.conflicts) return `<span class="session-git-muted">${escapeHtml(t('chat.git.clean'))}</span>`;
  return `
    <span>${escapeHtml(t('chat.git.dirty', { count: total }))}</span>
    <span class="session-git-muted">${escapeHtml(t('chat.git.dirtyDetail', { staged: dirty.staged, unstaged: dirty.unstaged, untracked: dirty.untracked }))}</span>
    ${dirty.conflicts ? `<span class="session-git-pill fail">${escapeHtml(t('chat.git.conflicts', { count: dirty.conflicts }))}</span>` : ''}`;
}

/** One line's worth: the count, its breakdown on hover. */
function dirtyShortHtml(dirty = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }) {
  const total = dirty.staged + dirty.unstaged + dirty.untracked;
  if (!total && !dirty.conflicts) return `<span class="session-git-muted">${escapeHtml(t('chat.git.clean'))}</span>`;
  const detail = t('chat.git.dirtyDetail', { staged: dirty.staged, unstaged: dirty.unstaged, untracked: dirty.untracked });
  return `<span title="${escapeHtml(detail)}">${escapeHtml(t('chat.git.dirty', { count: total }))}</span>
    ${dirty.conflicts ? `<span class="session-git-pill fail">${escapeHtml(t('chat.git.conflicts', { count: dirty.conflicts }))}</span>` : ''}`;
}

function checksHtml(checks) {
  if (!checks.total) return `<span class="session-git-muted">${escapeHtml(t('chat.git.noChecks'))}</span>`;
  return [
    checks.success ? `<span class="session-git-pill ok">✓ ${escapeHtml(t('chat.git.checksOk', { count: checks.success }))}</span>` : '',
    checks.failure ? `<span class="session-git-pill fail">✕ ${escapeHtml(t('chat.git.checksFailed', { count: checks.failure }))}</span>` : '',
    checks.pending ? `<span class="session-git-pill warn">◷ ${escapeHtml(t('chat.git.checksPending', { count: checks.pending }))}</span>` : '',
  ].join('');
}

/** Every pull request a summary shows: the folder's, or each worktree's and the ones the session created. */
function pullRequestsOf(s) {
  if (!s?.isRepo) return [];
  const entries = s.mode === 'session' ? [...s.workspaces.map((ws) => ws.pr), ...s.createdPrs] : [s.pr];
  return entries.map((entry) => entry?.pullRequest).filter(Boolean);
}

/**
 * Where this session's CI stands, over its open pull requests: failing as
 * soon as one check fails, else running while one runs, else passed. Null
 * without an open pull request that has checks.
 */
function ciStatus(s) {
  const totals = { success: 0, failure: 0, pending: 0 };
  for (const pr of pullRequestsOf(s)) {
    if (pr.state !== 'open' || !pr.checks) continue;
    totals.success += pr.checks.success;
    totals.failure += pr.checks.failure;
    totals.pending += pr.checks.pending;
  }
  const state = totals.failure ? 'failure' : totals.pending ? 'pending' : totals.success ? 'success' : null;
  return state ? { state, ...totals } : null;
}

/** "✕ 1 failed · ◷ 2 running", the tab button's tooltip. */
function ciStatusText(ci) {
  if (!ci) return '';
  return [
    ci.failure ? `✕ ${t('chat.git.checksFailed', { count: ci.failure })}` : '',
    ci.pending ? `◷ ${t('chat.git.checksPending', { count: ci.pending })}` : '',
    ci.success ? `✓ ${t('chat.git.checksOk', { count: ci.success })}` : '',
  ].filter(Boolean).join(' · ');
}

/**
 * What goes into the composer for a failed check: which check, which pull
 * request, and the end of its log. In English, like every prompt the app
 * writes for Claude. Not sent: the user reads it and sends it.
 */
function fixPrompt({ pr, check, logs, dir = null }) {
  const branch = pr.headRef ? ` (branch \`${pr.headRef}\`)` : '';
  const lines = [`The CI check "${check.name}" failed on pull request #${pr.number}${branch} of ${pr.repo}.`];
  if (dir) lines.push(`The branch is checked out in \`${dir}\`.`);
  lines.push('');
  if (logs) {
    const fence = logs.includes('```') ? '````' : '```';
    lines.push('The end of its log:', fence, logs.trimEnd(), fence);
  } else {
    lines.push(`Its log could not be retrieved: ${check.url || 'see the pull request'}.`);
  }
  lines.push('', 'Find the cause and fix it.');
  return lines.join('\n');
}

function runningHtml(running) {
  if (!running?.length) return '';
  return `<ul class="session-git-running">${running.map((c) => `
    <li>
      <span class="session-git-spinner" aria-hidden="true"></span>
      <button type="button" class="session-git-link" data-action="open-check" data-url="${escapeHtml(c.url || '')}">${escapeHtml(c.name)}</button>
      ${c.step ? `<span class="session-git-muted" title="${escapeHtml(c.step.name || '')}">${c.step.number}/${c.step.total}${c.step.name ? ` · ${escapeHtml(c.step.name)}` : ''}</span>` : ''}
    </li>`).join('')}</ul>`;
}

/** Failed checks; an open pull request's Actions jobs get a button that hands the log to this session. */
function failingHtml(p) {
  if (!p.checks.failing.length) return '';
  return `<ul class="session-git-failing">${p.checks.failing.map((c, i) => `
    <li>
      <button type="button" class="session-git-link" data-action="open-check" data-index="${i}" data-url="${escapeHtml(c.url || '')}">${escapeHtml(c.name)}</button>
      ${c.jobId && p.state === 'open' ? `<button type="button" class="session-git-fix" data-action="fix-check" data-pr-url="${escapeHtml(p.url || '')}" data-index="${i}">${escapeHtml(t('ci.fixIt'))}</button>` : ''}
    </li>`).join('')}</ul>`;
}

function reviewsHtml(reviews) {
  if (reviews.changesRequested) return `<span class="session-git-pill fail">${escapeHtml(t('chat.git.changesRequested'))}</span>`;
  if (reviews.approved) return `<span class="session-git-pill ok">${escapeHtml(t('chat.git.approved', { count: reviews.approved }))}</span>`;
  return `<span class="session-git-muted">${escapeHtml(t('chat.git.reviewPending'))}</span>`;
}

/**
 * The folder's pull request, in the single-branch view. An open one says
 * where it stands in one line, the same verdict a row of the session list
 * gives (chat/sessionPrs.js).
 * @param {object} s the summary
 * @param {(text: string) => string} [decorateTitle] decorates the title (chips, links): a hook for the features that read it
 */
function prSectionHtml(s, decorateTitle) {
  const head = `<h4 class="session-git-section-title">${ICONS.pr}${escapeHtml(t('chat.git.prTitle'))}</h4>`;
  if (s.onBase || !s.branch) return `<section class="session-git-section">${head}<p class="session-git-muted">${escapeHtml(t('chat.git.prOnBase'))}</p></section>`;
  const pr = s.pr;
  if (!pr) return `<section class="session-git-section">${head}<p class="session-git-muted">${escapeHtml(t('chat.git.prNoGitHub'))}</p></section>`;
  if (!pr.authenticated) {
    return `<section class="session-git-section">${head}
      <p class="session-git-muted">${escapeHtml(t('chat.git.prLoginNeeded'))}</p>
      <div class="session-git-actions"><button type="button" class="btn-sm btn-secondary" data-action="connect-github">${escapeHtml(t('chat.git.prConnect'))}</button></div>
    </section>`;
  }
  if (!pr.pullRequest && pr.ssoRequired) {
    const org = pr.ssoRequired.org || pr.ssoRequired.repo;
    return `<section class="session-git-section">${head}
      <p class="session-git-muted">${escapeHtml(t('chat.git.prSsoBlocked', { org }))}</p>
      <div class="session-git-actions"><button type="button" class="btn-sm btn-secondary" data-action="authorize-sso" data-url="${escapeHtml(pr.ssoRequired.url || '')}">${escapeHtml(t('chat.git.prSsoAuthorize', { org }))}</button></div>
    </section>`;
  }
  if (!pr.pullRequest && (pr.unreachable || pr.error)) {
    const text = pr.unreachable ? t('chat.git.prUnreachable', { repo: pr.unreachable }) : t('chat.git.prLookupFailed', { error: pr.error });
    return `<section class="session-git-section">${head}<p class="session-git-muted">${escapeHtml(text)}</p></section>`;
  }
  if (!pr.pullRequest) {
    return `<section class="session-git-section">${head}
      <p class="session-git-muted">${escapeHtml(t('chat.git.prNone'))}</p>
      ${pr.createUrl ? `<div class="session-git-actions"><button type="button" class="btn-sm btn-secondary" data-action="create-pr" data-url="${escapeHtml(pr.createUrl)}">${escapeHtml(t('chat.git.prCreate'))}</button></div>` : ''}
    </section>`;
  }
  const p = pr.pullRequest;
  const title = decorateTitle ? decorateTitle(p.title) : escapeHtml(p.title);
  const v = prVerdict(p, s);
  const verdictLine = v.group === 'done' ? '' : `<div class="session-git-verdict-line">
        ${statusHtml(v)}
        <span class="session-git-verdict ${v.group}">${escapeHtml(verdictText(v))}</span>
        ${actionHtml({ pr: p, ws: s, verdict: v }, { inline: true })}
      </div>`;
  return `<section class="session-git-section">${head}
    <div class="session-git-pr">
      <div class="session-git-pr-title">
        <button type="button" class="session-git-link" data-action="open-pr" data-url="${escapeHtml(p.url || '')}">#${p.number}</button>
        <span class="session-git-pr-text">${title}</span>
      </div>
      ${verdictLine}
      <div class="session-git-pills">
        <span class="session-git-pill state ${escapeHtml(p.draft && p.state === 'open' ? 'draft' : p.state)}">${escapeHtml(prStateLabel(p))}</span>
        ${p.createdHere ? `<span class="session-git-pill accent">${escapeHtml(t('chat.git.createdHere'))}</span>` : ''}
        ${checksHtml(p.checks)}
        ${reviewsHtml(p.reviews)}
      </div>
      ${labelsHtml(p.labels)}
      ${runningHtml(p.checks.running)}
      ${failingHtml(p)}
    </div>
  </section>`;
}

function commitsHtml(s, sessionStartedAt) {
  const label = s.onBase ? t('chat.git.commitsRecent') : t('chat.git.commitsBranch', { base: s.base || '' });
  const language = getCurrentLanguage();
  const rows = s.commits.map((c) => {
    const ms = Date.parse(c.date);
    const ours = Number.isFinite(ms) && ms >= sessionStartedAt;
    return `<li class="session-git-commit">
      <span class="session-git-sha">${escapeHtml(c.short)}</span>
      <span class="session-git-subject">${escapeHtml(c.subject)}</span>
      ${ours ? `<span class="session-git-pill accent">${escapeHtml(t('chat.git.thisSession'))}</span>` : ''}
      <span class="session-git-muted session-git-when" title="${escapeHtml(c.author)}">${escapeHtml(formatRelativeTimeIntl(c.date, { language }))}</span>
    </li>`;
  }).join('');
  return `<section class="session-git-section">
    <h4 class="session-git-section-title">${escapeHtml(label)} <span class="session-git-count">${s.commits.length}</span></h4>
    ${rows ? `<ul class="session-git-commits">${rows}</ul>` : `<p class="session-git-muted">${escapeHtml(t('chat.git.noCommits'))}</p>`}
  </section>`;
}

/** The whole tab for one summary. Pure, so it is tested on its own. */
function gitTabHtml(s, { sessionStartedAt = Date.now(), decoratePrTitle = null } = {}) {
  const canPush = !!s.branch && (!s.upstream || s.ahead > 0);
  return `<div class="chat-git">
    <section class="session-git-section session-git-branch-card">
      <div class="session-git-branch">
        ${ICONS.branch}
        <span class="session-git-branch-name">${escapeHtml(s.branch || s.head || '')}</span>
        ${s.worktree ? `<span class="session-git-pill">${escapeHtml(t('chat.git.worktree'))}</span>` : ''}
        ${s.base && !s.onBase ? `<span class="session-git-muted">${escapeHtml(t('chat.git.onBase', { base: s.base }))}</span>` : ''}
        <span class="session-git-spacer"></span>
        <button type="button" class="session-git-icon-btn" data-action="refresh" title="${escapeHtml(t('chat.git.refresh'))}" aria-label="${escapeHtml(t('chat.git.refresh'))}">${ICONS.refresh}</button>
      </div>
      <div class="session-git-line">${syncHtml(s)}</div>
      <div class="session-git-line">${dirtyHtml(s.dirty)}</div>
      <div class="session-git-actions">
        ${canPush ? `<button type="button" class="btn-sm session-git-primary" data-action="push">${escapeHtml(s.upstream ? t('chat.git.push') : t('chat.git.publish'))}</button>` : ''}
        <button type="button" class="btn-sm btn-secondary" data-action="open-git">${escapeHtml(t('chat.git.openGit'))}</button>
      </div>
    </section>
    ${prSectionHtml(s, decoratePrTitle)}
    ${commitsHtml(s, sessionStartedAt)}
  </div>`;
}

// ── A session's pull requests, as one list (chat/sessionPrs.js) ──

/** The verdict's mark, coloured by its group. */
function statusHtml(v) {
  if (v.code === 'ciRunning') return '<span class="session-git-status waiting"><span class="session-git-spinner"></span></span>';
  const glyph = {
    conflicts: '⇄', ciFailed: '✕', changesRequested: '✎', unpushed: '↑', unpublished: '↑', noPr: '+', behind: '↓',
    stacked: '↳', reviewRequested: '◷', reviewRequired: '◷', blocked: '⊘', computing: '…', draft: '◌', open: '○',
    ready: '✓', merged: '✓', closed: '✕',
  }[v.code] || '•';
  return `<span class="session-git-status ${v.group}${v.code === 'closed' ? ' closed' : ''}" aria-hidden="true">${glyph}</span>`;
}

/** "✕ 1 ◷ 2 ✓ 9": an open pull request's checks, in the row. */
function ciMiniHtml(checks) {
  if (!checks?.total) return '';
  const parts = [
    checks.failure ? `<span class="fail">✕ ${checks.failure}</span>` : '',
    checks.pending ? `<span class="warn">◷ ${checks.pending}</span>` : '',
    checks.success ? `<span class="ok">✓ ${checks.success}</span>` : '',
  ].filter(Boolean);
  return parts.length ? `<span class="session-git-ci" title="${escapeHtml(ciStatusText({ failure: checks.failure, pending: checks.pending, success: checks.success }))}">${parts.join(' ')}</span>` : '';
}

/**
 * The button that does what the verdict asks. Inline (the single-branch
 * view), push and Fix it already have their own place, so only the ones
 * that write a prompt are added.
 */
function actionHtml(row, { inline = false } = {}) {
  const { pr, ws, verdict: v } = row;
  const button = (action, label, attrs = '') => `<button type="button" class="session-git-fix" data-action="${action}"${attrs}>${escapeHtml(label)}</button>`;
  const prAttr = pr ? ` data-pr-url="${escapeHtml(pr.url || '')}"` : '';
  switch (v.code) {
    case 'unpushed': return !inline && ws && !ws.removed ? button('push', t('chat.git.push')) : '';
    case 'unpublished': return inline ? '' : button('push', t('chat.git.action.publish'));
    case 'noPr': return inline || !ws?.pr?.createUrl ? '' : button('create-pr', t('chat.git.action.createPr'), ` data-url="${escapeHtml(ws.pr.createUrl)}"`);
    case 'conflicts': return button('resolve', t('chat.git.action.resolve'), prAttr);
    case 'behind': return button('update-branch', t('chat.git.action.update'), prAttr);
    case 'changesRequested': return button('address-review', t('chat.git.action.addressReview'), prAttr);
    case 'ciFailed': {
      if (inline) return '';
      const index = pr.checks.failing.findIndex((c) => c.jobId);
      return index >= 0 ? button('fix-check', t('ci.fixIt'), `${prAttr} data-index="${index}"`) : '';
    }
    default: return '';
  }
}

function reviewsDetailHtml(pr) {
  const decisions = pr.reviews?.decisions || [];
  const by = (state) => decisions.filter((d) => d.state === state).map((d) => d.user).join(', ');
  const parts = [
    by('CHANGES_REQUESTED') ? `<span class="session-git-pill fail">${escapeHtml(t('chat.git.detail.changesBy', { users: by('CHANGES_REQUESTED') }))}</span>` : '',
    by('APPROVED') ? `<span class="session-git-pill ok">${escapeHtml(t('chat.git.detail.approvedBy', { users: by('APPROVED') }))}</span>` : '',
    pr.requestedReviewers?.length ? `<span class="session-git-pill warn">${escapeHtml(t('chat.git.detail.requestedFrom', { users: pr.requestedReviewers.join(', ') }))}</span>` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('') : `<span class="session-git-muted">${escapeHtml(t('chat.git.detail.noReview'))}</span>`;
}

/** Where the branch is: its name and base, the worktree, and what is not pushed or committed. */
function branchDetailHtml({ pr, ws }) {
  const name = ws?.branch || pr?.headRef || '';
  const base = pr?.baseRef ? ` → <span class="session-git-mono">${escapeHtml(pr.baseRef)}</span>` : '';
  const parts = [`<span><span class="session-git-mono">${escapeHtml(name)}</span>${base}</span>`];
  if (ws) {
    parts.push(`<span class="session-git-muted session-git-mono" title="${escapeHtml(ws.dir || '')}">${escapeHtml(ws.label || t('chat.git.projectFolder'))}</span>`);
    if (ws.removed) parts.push(`<span class="session-git-pill">${escapeHtml(t('chat.git.removedWorktree'))}</span>`);
    else parts.push(syncHtml(ws), dirtyShortHtml(ws.dirty));
  }
  return parts.join('');
}

/**
 * A pull request's GitHub labels, each in its own colour. The colour is
 * checked again here (six hex digits) before it goes into a style attribute:
 * main already drops anything else, but this is the line that writes it.
 */
function labelsHtml(labels) {
  if (!labels?.length) return '';
  return `<div class="session-git-labels">${labels.map((label) => {
    const color = /^[0-9a-f]{6}$/i.test(label.color || '') ? ` style="--label-color: #${label.color}"` : '';
    return `<span class="session-git-label"${color}>${escapeHtml(label.name)}</span>`;
  }).join('')}</div>`;
}

const detailLine = (label, html) => `<div class="session-git-detail-line"><span class="session-git-detail-label">${escapeHtml(label)}</span><div class="session-git-detail-value">${html}</div></div>`;

function rowDetailHtml(row) {
  const { pr } = row;
  const lines = [];
  if (pr) {
    if (pr.checks?.total) {
      lines.push(detailLine(t('chat.git.detail.checks'), `<div class="session-git-pills">${checksHtml(pr.checks)}</div>${runningHtml(pr.checks.running)}${failingHtml(pr)}`));
    }
    if (pr.state === 'open') lines.push(detailLine(t('chat.git.detail.reviews'), reviewsDetailHtml(pr)));
    if (pr.labels?.length) lines.push(detailLine(t('chat.git.detail.labels'), labelsHtml(pr.labels)));
    if (pr.stackedOn) {
      lines.push(detailLine(t('chat.git.detail.stack'), `<button type="button" class="session-git-link" data-action="open-pr" data-url="${escapeHtml(pr.stackedOn.url || '')}">#${pr.stackedOn.number}</button>`));
    }
  }
  lines.push(detailLine(t('chat.git.detail.branch'), branchDetailHtml(row)));
  if (row.createdHere) lines.push(`<div class="session-git-pills"><span class="session-git-pill accent">${escapeHtml(t('chat.git.createdHere'))}</span></div>`);
  return `<div class="session-git-row-detail">${lines.join('')}</div>`;
}

function rowHtml(row, { label, view, decoratePrTitle }) {
  const { pr, ws, verdict: v } = row;
  const open = view.expanded.has(row.key);
  const title = pr
    ? (decoratePrTitle ? decoratePrTitle(pr.title || '') : escapeHtml(pr.title || ''))
    : `<span class="session-git-mono">${escapeHtml(ws.branch || '')}</span>`;
  const repo = pr ? label(pr.repo) : '';
  const dirty = ws && !ws.removed && ws.dirty ? ws.dirty.staged + ws.dirty.unstaged + ws.dirty.untracked : 0;
  return `<li class="session-git-row${open ? ' expanded' : ''}" data-key="${escapeHtml(row.key)}" data-group="${v.group}"${row.wsIndex !== null ? ` data-ws="${row.wsIndex}"` : ''}>
      <div class="session-git-row-line" data-action="toggle-row">
        <button type="button" class="session-git-chevron" data-action="toggle-row" aria-expanded="${open}" aria-label="${escapeHtml(t('chat.git.details'))}">${ICONS.chevron}</button>
        ${statusHtml(v)}
        ${repo ? `<span class="session-git-repo">${escapeHtml(repo)}</span>` : ''}
        ${pr ? `<button type="button" class="session-git-link session-git-num" data-action="open-pr" data-url="${escapeHtml(pr.url || '')}">#${pr.number}</button>` : ''}
        <span class="session-git-row-title">${title}</span>
        ${pr?.stackedOn && v.code !== 'stacked' ? `<span class="session-git-pill">${escapeHtml(t('chat.git.stackedOn', { number: pr.stackedOn.number }))}</span>` : ''}
        ${dirty ? `<span class="session-git-dirty" title="${escapeHtml(t('chat.git.dirty', { count: dirty }))}">±${dirty}</span>` : ''}
        ${pr?.state === 'open' ? ciMiniHtml(pr.checks) : ''}
        <span class="session-git-verdict ${v.group}">${escapeHtml(verdictText(v))}</span>
        ${actionHtml(row)}
      </div>
      ${open ? rowDetailHtml(row) : ''}
    </li>`;
}

function groupHtml(group, rows, ctx) {
  if (!rows.length) return '';
  const { view } = ctx;
  const foldable = group === 'done' && view.filter !== 'done';
  const folded = foldable && !view.doneOpen;
  const name = `<span class="session-git-group-dot"></span>${escapeHtml(groupLabel(group))} <span class="session-git-count">${rows.length}</span>`;
  const head = foldable
    ? `<h5 class="session-git-group-title ${group}"><button type="button" class="session-git-group-toggle" data-action="toggle-done" aria-expanded="${!folded}">${ICONS.chevron}${name}</button></h5>`
    : `<h5 class="session-git-group-title ${group}">${name}</h5>`;
  const body = folded
    ? `<button type="button" class="session-git-done-summary" data-action="toggle-done">${escapeHtml(t('chat.git.doneCollapsed', { count: rows.length }))} <span class="session-git-muted">${rows.map((r) => (r.pr ? `#${r.pr.number}` : '')).filter(Boolean).join(', ')}</span></button>`
    : `<ul class="session-git-rows">${rows.map((row) => rowHtml(row, ctx)).join('')}</ul>`;
  return `<section class="session-git-group${folded ? ' folded' : ''}" data-group="${group}">${head}${body}</section>`;
}

function chipsHtml(groups, total, filter) {
  const chip = (value, label, count) => `<button type="button" class="session-git-chip${value ? ` ${value}` : ''}${filter === value ? ' active' : ''}" data-action="filter" data-group="${value || ''}" aria-pressed="${filter === value}">${escapeHtml(label)} <span class="session-git-chip-count">${count}</span></button>`;
  return `<div class="session-git-chips">
      ${chip(null, t('chat.git.filterAll'), total)}
      ${GROUPS.filter((g) => groups[g].length || filter === g).map((g) => chip(g, groupLabel(g), groups[g].length)).join('')}
    </div>`;
}

function noticeHtml(n) {
  switch (n.kind) {
    case 'login': return `<div class="session-git-notice"><span>${escapeHtml(t('chat.git.noticeLogin'))}</span><button type="button" class="btn-sm btn-secondary" data-action="connect-github">${escapeHtml(t('chat.git.prConnect'))}</button></div>`;
    case 'sso': return `<div class="session-git-notice"><span>${escapeHtml(t('chat.git.prSsoBlocked', { org: n.org }))}</span><button type="button" class="btn-sm btn-secondary" data-action="authorize-sso" data-url="${escapeHtml(n.url)}">${escapeHtml(t('chat.git.prSsoAuthorize', { org: n.org }))}</button></div>`;
    case 'unreachable': return `<div class="session-git-notice"><span>${escapeHtml(t('chat.git.prUnreachable', { repo: n.repo }))}</span></div>`;
    default: return `<div class="session-git-notice"><span>${escapeHtml(t('chat.git.prLookupFailed', { error: n.error }))}</span></div>`;
  }
}

/** Every worktree the session used, one line each, folded by default: the rows already say what needs doing. */
function worktreesHtml(workspaces, view) {
  if (!workspaces.length) return '';
  const head = `<h5 class="session-git-group-title"><button type="button" class="session-git-group-toggle" data-action="toggle-worktrees" aria-expanded="${view.worktreesOpen}">${ICONS.chevron}${escapeHtml(t('chat.git.sessionWorktrees'))} <span class="session-git-count">${workspaces.length}</span></button></h5>`;
  if (!view.worktreesOpen) return `<section class="session-git-group session-git-worktrees folded">${head}</section>`;
  const rows = workspaces.map((ws, i) => {
    const canPush = !ws.removed && !!ws.branch && (!ws.upstream || ws.ahead > 0);
    return `<li class="session-git-wt" data-ws="${i}">
        ${ICONS.branch}
        <span class="session-git-mono session-git-wt-branch">${escapeHtml(ws.branch || ws.head || '')}</span>
        <span class="session-git-muted session-git-mono session-git-wt-place" title="${escapeHtml(ws.dir || '')}">${escapeHtml(ws.label || t('chat.git.projectFolder'))}</span>
        ${ws.removed ? `<span class="session-git-pill">${escapeHtml(t('chat.git.removedWorktree'))}</span>` : `${syncHtml(ws)}${dirtyShortHtml(ws.dirty)}`}
        ${canPush ? `<button type="button" class="session-git-fix" data-action="push">${escapeHtml(ws.upstream ? t('chat.git.push') : t('chat.git.action.publish'))}</button>` : ''}
      </li>`;
  }).join('');
  return `<section class="session-git-group session-git-worktrees">${head}<ul class="session-git-rows">${rows}</ul></section>`;
}

const defaultView = () => ({ filter: null, expanded: new Set(), doneOpen: false, worktreesOpen: false });

/**
 * The tab for a session that worked in its own worktrees: its pull requests
 * by verdict, what needs the user first; then its worktrees, folded.
 * `view` is the tab's: the filter, the rows expanded, what is unfolded.
 */
function sessionHtml(o, { decoratePrTitle = null, view = defaultView() } = {}) {
  const rows = rowsOf(o);
  const groups = groupRows(rows);
  const filter = view.filter && groups[view.filter]?.length ? view.filter : null;
  const ctx = { label: repoLabeller(rows), view: { ...view, filter }, decoratePrTitle };
  const prCount = rows.filter((r) => r.pr).length;
  const notices = noticesOf(o);
  const list = rows.length
    ? `${chipsHtml(groups, rows.length, filter)}${(filter ? [filter] : GROUPS).map((g) => groupHtml(g, groups[g], ctx)).join('')}`
    : `<p class="session-git-muted session-git-empty">${escapeHtml(t('chat.git.noPullRequests'))}</p>`;
  return `<div class="chat-git chat-git-session">
    <div class="session-git-head">
      <h4 class="session-git-section-title">${ICONS.pr}${escapeHtml(t('chat.git.pullRequests'))} <span class="session-git-count">${prCount}</span></h4>
      <span class="session-git-spacer"></span>
      <button type="button" class="btn-sm btn-secondary" data-action="open-git">${escapeHtml(t('chat.git.openGit'))}</button>
      <button type="button" class="session-git-icon-btn" data-action="refresh" title="${escapeHtml(t('chat.git.refresh'))}" aria-label="${escapeHtml(t('chat.git.refresh'))}">${ICONS.refresh}</button>
    </div>
    ${notices.map(noticeHtml).join('')}
    ${list}
    ${worktreesHtml(o.workspaces, view)}
  </div>`;
}

/**
 * @param {object} deps
 * @param {object} deps.api window.electron_api
 * @param {HTMLElement} deps.panelEl the tab's panel
 * @param {() => string} deps.getCwd the session's working directory
 * @param {() => string|null} [deps.getSessionId] the CLI session id, once known: its transcript says which worktrees it used
 * @param {number} deps.sessionStartedAt commits after this are marked as this session's
 * @param {() => void} deps.onAvailable called once the folder turns out to be a repository
 * @param {() => void} deps.openGitScreen
 * @param {(subTab: string) => void} deps.openSettings
 * @param {(opts: object) => void} deps.showToast
 * @param {(title: string) => string} [deps.decoratePrTitle]
 * @param {(summary: object) => void} [deps.onSummary] every summary read: a hook for the features that read branches and PR titles
 * @param {(ci: object|null) => void} [deps.onCiStatus] the session's CI, see ciStatus(), each time it changes
 * @param {(count: number) => void} [deps.onAttention] how many rows need the user, each time it changes
 * @param {() => boolean} [deps.isOnScreen] whether the session is on screen: nothing is read while it is not. Always, when left out
 * @param {(text: string) => void} [deps.fillComposer] puts a prompt in this session's composer
 */
function createGitTab(deps) {
  const { api, panelEl } = deps;
  let summary = null;
  let loadedAt = 0;
  let stale = true;
  let visible = false;
  let destroyed = false;
  let available = false;
  let seq = 0;
  let inFlight = 0;
  let pollTimer = null;
  let staleTimer = null;
  let ciKey = '';
  let attention = null;
  let probed = false;
  let screenObserver = null;
  // The list's own state, kept across reads: a re-read every 30 s must not
  // fold what the user unfolded.
  const view = defaultView();

  async function load() {
    if (destroyed) return;
    probed = true;
    const mine = ++seq;
    inFlight++;
    let res;
    try {
      const sessionId = deps.getSessionId?.() || null;
      res = sessionId && api.git.sessionOverview
        ? await api.git.sessionOverview({ projectPath: deps.getCwd(), sessionId })
        : await api.git.sessionSummary({ projectPath: deps.getCwd() });
    } catch (err) {
      res = { isRepo: false, error: err.message };
    } finally {
      inFlight--;
    }
    if (destroyed || mine !== seq) return;
    summary = res;
    loadedAt = Date.now();
    stale = false;
    reportCi();
    reportAttention();
    if (summary?.mode === 'session') {
      // A reader of branches and titles gets every one the session has.
      for (const ws of summary.workspaces) deps.onSummary?.(ws);
      for (const entry of summary.createdPrs) {
        if (entry.pullRequest) deps.onSummary?.({ isRepo: true, branch: entry.pullRequest.headRef || null, pr: entry });
      }
    } else {
      deps.onSummary?.(summary);
    }
    if (summary?.isRepo && !available) {
      available = true;
      deps.onAvailable?.();
      pollTimer = setInterval(tick, TICK_MS);
    }
    if (visible) render();
  }

  function reportCi() {
    const ci = ciStatus(summary);
    const key = ci ? `${ci.state}:${ci.success}:${ci.failure}:${ci.pending}` : '';
    if (key === ciKey) return;
    ciKey = key;
    deps.onCiStatus?.(ci);
  }

  function reportAttention() {
    const count = summary?.isRepo ? attentionCount(summary) : 0;
    if (count === attention) return;
    attention = count;
    deps.onAttention?.(count);
  }

  const onScreen = () => (deps.isOnScreen ? !!deps.isOnScreen() : true);

  /** Only on screen. Shown: every 30 s. Hidden: while a check runs or after a tool result. */
  function tick() {
    if (destroyed || inFlight || !document.hasFocus() || !onScreen()) return;
    const due = Date.now() - loadedAt >= POLL_MS - TICK_MS / 2;
    const running = ciKey.startsWith('pending');
    if (visible ? running || due : running || (stale && due)) load();
  }

  /**
   * The chat is on screen again: the first read if it never had one, else
   * what changed while it was away, now rather than at the next tick.
   */
  function cameOnScreen() {
    if (destroyed || inFlight) return;
    if (!probed) {
      load();
      return;
    }
    const age = Date.now() - loadedAt;
    if (visible ? stale || age > FRESH_MS : ciKey.startsWith('pending') || (stale && age >= POLL_MS - TICK_MS / 2)) load();
  }

  function render() {
    if (!summary) {
      panelEl.innerHTML = `<div class="session-git-state">${escapeHtml(t('chat.git.loading'))}</div>`;
      return;
    }
    if (!summary.isRepo) {
      panelEl.innerHTML = `<div class="session-git-state">${escapeHtml(t('chat.git.notRepo'))}</div>`;
      return;
    }
    panelEl.innerHTML = summary.mode === 'session'
      ? sessionHtml(summary, { decoratePrTitle: deps.decoratePrTitle, view })
      : gitTabHtml(summary, { sessionStartedAt: deps.sessionStartedAt, decoratePrTitle: deps.decoratePrTitle });
  }

  /** The branch a click acts on: a row's or a line's worktree in the session view, else the only one. */
  function targetOf(el) {
    if (summary?.mode !== 'session') return summary;
    const card = el.closest('[data-ws]');
    return card ? summary.workspaces[Number(card.dataset.ws)] || null : null;
  }

  async function fixCheck(button) {
    const pr = pullRequestsOf(summary).find((p) => p.url === button.dataset.prUrl);
    const check = pr?.checks.failing[Number(button.dataset.index)];
    if (!check?.jobId || !deps.fillComposer) return;
    const ws = targetOf(button);
    button.disabled = true;
    let logs = null;
    try {
      const res = await api.github.jobLogs(`https://${new URL(pr.url).host}/${pr.repo}`, check.jobId);
      logs = res?.logs || null;
    } catch {
      // No log: the prompt points at the check instead.
    }
    if (destroyed) return;
    button.disabled = false;
    deps.fillComposer(fixPrompt({ pr, check, logs, dir: summary.mode === 'session' ? ws?.dir || null : null }));
  }

  /** Conflicts, a base to bring in, a review to address: a prompt for this session, from the row's pull request. */
  async function draftPrompt(button) {
    const pr = pullRequestsOf(summary).find((p) => p.url === button.dataset.prUrl);
    if (!pr || !deps.fillComposer) return;
    const ws = targetOf(button);
    const dir = summary.mode === 'session' ? ws?.dir || null : null;
    const action = button.dataset.action;
    if (action === 'resolve') {
      deps.fillComposer(conflictsPrompt({ pr, dir }));
      return;
    }
    if (action === 'update-branch') {
      deps.fillComposer(behindPrompt({ pr, dir }));
      return;
    }
    button.disabled = true;
    let comments = null;
    try {
      const res = await api.github.prComments({ remoteUrl: `https://${new URL(pr.url).host}/${pr.repo}`, pullNumber: pr.number });
      if (res?.success && res.authenticated !== false && !res.error) comments = res.comments || [];
    } catch {
      // No comments: the prompt points at the pull request instead.
    }
    if (destroyed) return;
    button.disabled = false;
    deps.fillComposer(reviewPrompt({ pr, comments, dir }));
  }

  function toggle(set, key) {
    if (set.has(key)) set.delete(key);
    else set.add(key);
  }

  async function push(button) {
    const target = targetOf(button);
    if (!target?.branch) return;
    button.disabled = true;
    const projectPath = summary.mode === 'session' ? target.dir : deps.getCwd();
    const res = target.upstream
      ? await api.git.push({ projectPath })
      : await api.git.pushBranch({ projectPath, branch: target.branch });
    if (destroyed) return;
    deps.showToast(res?.success
      ? { type: 'success', title: t('chat.git.pushed') }
      : { type: 'error', title: t('chat.git.pushFailed'), message: res?.error || '' });
    await load();
  }

  function onClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el || !summary) return;
    switch (el.dataset.action) {
      case 'refresh': load(); break;
      case 'push': push(el); break;
      case 'fix-check': fixCheck(el); break;
      case 'resolve':
      case 'update-branch':
      case 'address-review':
        draftPrompt(el);
        break;
      case 'toggle-row': {
        const key = el.closest('[data-key]')?.dataset.key;
        if (key) toggle(view.expanded, key);
        render();
        break;
      }
      case 'filter':
        view.filter = el.dataset.group || null;
        render();
        break;
      case 'toggle-done':
        view.doneOpen = !view.doneOpen;
        render();
        break;
      case 'toggle-worktrees':
        view.worktreesOpen = !view.worktreesOpen;
        render();
        break;
      case 'open-git': deps.openGitScreen(); break;
      case 'connect-github': deps.openSettings('github'); break;
      // Every link carries its own URL: the same handler serves every row.
      case 'create-pr':
      case 'authorize-sso':
      case 'open-pr':
      case 'open-check':
        if (el.dataset.url) api.dialog.openExternal(el.dataset.url);
        break;
      default:
    }
  }
  panelEl.addEventListener('click', onClick);

  return {
    /** Find out once, quietly, whether there is a repository to show. */
    probe: () => load(),

    /**
     * The probe, held until `el` (the chat) is first on screen, then a catch-up
     * each time it comes back. Without IntersectionObserver, the probe at once.
     * @param {HTMLElement} el
     */
    probeWhenOnScreen(el) {
      if (destroyed || screenObserver) return;
      if (typeof IntersectionObserver !== 'function' || !el) {
        load();
        return;
      }
      screenObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) cameOnScreen();
      });
      screenObserver.observe(el);
    },

    show() {
      visible = true;
      render();
      if (stale || Date.now() - loadedAt > FRESH_MS) load();
    },

    hide() {
      visible = false;
    },

    /** A tool just finished: it may have committed, pushed or edited. Off screen, read once back. */
    markStale() {
      stale = true;
      if (!visible || !onScreen()) return;
      clearTimeout(staleTimer);
      staleTimer = setTimeout(load, STALE_DEBOUNCE_MS);
    },

    /** The branch the session worked on last, for the features that read it. */
    getSummary: () => (summary?.mode === 'session' ? summary.workspaces[0] || null : summary),

    destroy() {
      destroyed = true;
      screenObserver?.disconnect();
      clearInterval(pollTimer);
      clearTimeout(staleTimer);
      panelEl.removeEventListener('click', onClick);
    },
  };
}

module.exports = { createGitTab, gitTabHtml, sessionHtml, ciStatus, ciStatusText, fixPrompt };
