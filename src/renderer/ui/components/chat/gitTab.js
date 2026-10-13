/**
 * The chat's Git tab: where this session's branch stands.
 *
 * Beside Changes, not instead of it. Changes is what Claude edited in this
 * session; Git is the repository's side: branch and its drift from upstream,
 * the base it is measured against, uncommitted files, the branch's own
 * commits, and its pull request with checks and reviews.
 *
 * Everything comes from one read-only call (`git.sessionSummary`, served by
 * SessionGitService). It is fetched when the tab is shown, every 30 s while it
 * stays shown and the window is focused, and shortly after a tool result,
 * since a tool is what commits and pushes.
 *
 * The pull requests' checks are this session's CI, so they are also told to
 * the tab button (`onCiStatus`), which shows them without the tab open. That
 * is the one thing read while hidden, and only for the session on screen:
 * every 15 s while a check runs, at most every 30 s after a tool result
 * (it may have pushed). A session in a background tab costs nothing.
 *
 * A session that worked in its own worktrees shows those instead
 * (`git.sessionOverview`, read from its transcript): a card per worktree with
 * its branch and pull request, then the pull requests it opened that no card
 * carries. Reading the project folder alone gave every session of a project
 * the same branch and the same pull request. A new tab, or a session that
 * never left the folder, still shows the folder.
 */

'use strict';

const { t, getCurrentLanguage } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const { formatRelativeTimeIntl } = require('../../../utils/format');

const POLL_MS = 30_000;
const TICK_MS = 15_000;
const STALE_DEBOUNCE_MS = 1500;
const FRESH_MS = 10_000;

const ICONS = {
  branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11.5 8.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
  pr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4"/><path d="M13 3l-2 3 2 3"/></svg>',
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
 * @param {object} pr the summary's `pr` field
 * @param {(text: string) => string} [decorateTitle] decorates the title (chips, links): a hook for the features that read it
 */
function prSectionHtml(s, decorateTitle, { heading = true } = {}) {
  const head = heading ? `<h4 class="session-git-section-title">${ICONS.pr}${escapeHtml(t('chat.git.prTitle'))}</h4>` : '';
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
  return `<section class="session-git-section">${head}
    <div class="session-git-pr">
      <div class="session-git-pr-title">
        <button type="button" class="session-git-link" data-action="open-pr" data-url="${escapeHtml(p.url || '')}">#${p.number}</button>
        <span class="session-git-pr-text">${title}</span>
      </div>
      <div class="session-git-pills">
        <span class="session-git-pill state ${escapeHtml(p.draft && p.state === 'open' ? 'draft' : p.state)}">${escapeHtml(prStateLabel(p))}</span>
        ${p.createdHere ? `<span class="session-git-pill accent">${escapeHtml(t('chat.git.createdHere'))}</span>` : ''}
        ${checksHtml(p.checks)}
        ${reviewsHtml(p.reviews)}
      </div>
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

/** One worktree the session used: its branch, where it stands, and its pull request. */
function workspaceHtml(ws, index, decoratePrTitle) {
  const canPush = !ws.removed && !!ws.branch && (!ws.upstream || ws.ahead > 0);
  const place = ws.label || t('chat.git.projectFolder');
  const body = ws.removed
    ? ''
    : `<div class="session-git-line">${syncHtml(ws)}</div>
      <div class="session-git-line">${dirtyHtml(ws.dirty)}</div>
      ${!ws.onBase && ws.base ? `<div class="session-git-line session-git-muted">${escapeHtml(t('chat.git.commitsCount', { count: ws.commits.length, base: ws.base }))}</div>` : ''}`;
  return `<section class="session-git-section session-git-branch-card session-git-workspace" data-ws="${index}">
      <div class="session-git-branch">
        ${ICONS.branch}
        <span class="session-git-branch-name">${escapeHtml(ws.branch || ws.head || '')}</span>
        ${ws.removed ? `<span class="session-git-pill">${escapeHtml(t('chat.git.removedWorktree'))}</span>` : ''}
        ${ws.base && !ws.onBase ? `<span class="session-git-muted">${escapeHtml(t('chat.git.onBase', { base: ws.base }))}</span>` : ''}
      </div>
      <div class="session-git-place" title="${escapeHtml(ws.dir || '')}">${escapeHtml(place)}</div>
      ${body}
      ${canPush ? `<div class="session-git-actions"><button type="button" class="btn-sm session-git-primary" data-action="push">${escapeHtml(ws.upstream ? t('chat.git.push') : t('chat.git.publish'))}</button></div>` : ''}
      <div class="session-git-ws-pr">${prSectionHtml(ws, decoratePrTitle)}</div>
    </section>`;
}

/**
 * The tab for one session that worked in its own worktrees: a card per
 * worktree, newest first, then the pull requests it opened that no card
 * carries (their worktree removed, or opened on another repository).
 */
function sessionHtml(o, { decoratePrTitle = null } = {}) {
  const created = o.createdPrs.map((entry, i) => `<div class="session-git-created" data-created="${i}">
      ${prSectionHtml({ branch: entry.pullRequest?.headRef || '-', onBase: false, pr: entry }, decoratePrTitle, { heading: false })}
    </div>`).join('');
  return `<div class="chat-git chat-git-session">
    <div class="session-git-head">
      <h4 class="session-git-section-title">${escapeHtml(t('chat.git.sessionWorktrees'))} <span class="session-git-count">${o.workspaces.length}</span></h4>
      <span class="session-git-spacer"></span>
      <button type="button" class="btn-sm btn-secondary" data-action="open-git">${escapeHtml(t('chat.git.openGit'))}</button>
      <button type="button" class="session-git-icon-btn" data-action="refresh" title="${escapeHtml(t('chat.git.refresh'))}" aria-label="${escapeHtml(t('chat.git.refresh'))}">${ICONS.refresh}</button>
    </div>
    ${o.workspaces.map((ws, i) => workspaceHtml(ws, i, decoratePrTitle)).join('')}
    ${created ? `<section class="session-git-section">
      <h4 class="session-git-section-title">${ICONS.pr}${escapeHtml(t('chat.git.createdPrs'))} <span class="session-git-count">${o.createdPrs.length}</span></h4>
      ${created}
    </section>` : ''}
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
 * @param {() => boolean} [deps.isOnScreen] whether the session is the one on screen: only then is it read while hidden
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

  async function load() {
    if (destroyed) return;
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

  /** Shown: every 30 s. Hidden: only the session on screen, while a check runs or after a tool result. */
  function tick() {
    if (destroyed || inFlight || !document.hasFocus()) return;
    const due = Date.now() - loadedAt >= POLL_MS - TICK_MS / 2;
    const running = ciKey.startsWith('pending');
    if (visible ? running || due : deps.isOnScreen?.() && (running || (stale && due))) load();
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
      ? sessionHtml(summary, { decoratePrTitle: deps.decoratePrTitle })
      : gitTabHtml(summary, { sessionStartedAt: deps.sessionStartedAt, decoratePrTitle: deps.decoratePrTitle });
  }

  /** The branch a click acts on: a worktree card in the session view, else the only one. */
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
      case 'open-git': deps.openGitScreen(); break;
      case 'connect-github': deps.openSettings('github'); break;
      // Every link carries its own URL: the same handler serves each worktree card.
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

    show() {
      visible = true;
      render();
      if (stale || Date.now() - loadedAt > FRESH_MS) load();
    },

    hide() {
      visible = false;
    },

    /** A tool just finished: it may have committed, pushed or edited. */
    markStale() {
      stale = true;
      if (!visible) return;
      clearTimeout(staleTimer);
      staleTimer = setTimeout(load, STALE_DEBOUNCE_MS);
    },

    /** The branch the session worked on last, for the features that read it. */
    getSummary: () => (summary?.mode === 'session' ? summary.workspaces[0] || null : summary),

    destroy() {
      destroyed = true;
      clearInterval(pollTimer);
      clearTimeout(staleTimer);
      panelEl.removeEventListener('click', onClick);
    },
  };
}

module.exports = { createGitTab, gitTabHtml, sessionHtml, ciStatus, ciStatusText, fixPrompt };
