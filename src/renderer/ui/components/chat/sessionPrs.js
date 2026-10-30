/**
 * A session's pull requests as one list, each with one verdict: what it
 * needs from the user, or what it waits on.
 *
 * The Git tab used to draw a card per worktree with its pull request nested
 * inside, then a second section for the pull requests no card carried. With
 * seven of them, finding the red one meant reading seven cards, and nothing
 * said which were blocked or on what. Here a row is a pull request (or a
 * branch that needs one), and its verdict is the first rule of prVerdict()
 * that applies: what needs the user first, then what waits on someone else,
 * then ready, then done.
 *
 * Pure: rows, verdicts, groups and the prompts the action buttons put in the
 * composer. The tab (gitTab.js) draws them, keeps the filter and what is
 * expanded, and handles clicks.
 */

'use strict';

const { t, getCurrentLanguage } = require('../../../i18n');
const { formatRelativeTimeIntl } = require('../../../utils/format');

const GROUPS = ['action', 'waiting', 'ready', 'done'];

/** Order inside a group. Precedence is prVerdict()'s, this is only how rows line up. */
const CODE_ORDER = [
  'conflicts', 'ciFailed', 'changesRequested', 'unpushed', 'behind', 'unpublished', 'noPr',
  'ciRunning', 'stacked', 'reviewRequested', 'reviewRequired', 'blocked', 'computing', 'draft', 'open',
  'ready',
  'merged', 'closed',
];

const NO_CHECKS = { total: 0, success: 0, failure: 0, pending: 0, failing: [], running: [] };

const verdict = (group, code, params = {}) => ({ group, code, params });

/**
 * A pull request's verdict. `ws` is the worktree its branch is checked out
 * in, when there is one: commits not pushed yet come first, since every
 * check and review is about the pushed head.
 */
function prVerdict(pr, ws = null) {
  if (pr.state === 'merged') return verdict('done', 'merged', { at: pr.mergedAt || pr.updatedAt || null });
  if (pr.state === 'closed') return verdict('done', 'closed');
  const local = ws && !ws.removed ? ws : null;
  if (local?.upstream && local.ahead > 0) return verdict('action', 'unpushed', { count: local.ahead });

  const state = pr.mergeableState || null;
  const base = pr.baseRef || 'main';
  const checks = pr.checks || NO_CHECKS;
  const reviews = pr.reviews || { approved: 0, changesRequested: 0, decisions: [] };
  if (state === 'dirty') return verdict('action', 'conflicts', { base });
  if (checks.failure) return verdict('action', 'ciFailed', { count: checks.failure, name: checks.failing?.[0]?.name || null });
  if (reviews.changesRequested) {
    const users = reviews.decisions.filter((d) => d.state === 'CHANGES_REQUESTED').map((d) => d.user);
    return verdict('action', 'changesRequested', { users });
  }
  if (state === 'behind') return verdict('action', 'behind', { base });

  if (pr.stackedOn) return verdict('waiting', 'stacked', { number: pr.stackedOn.number });
  if (checks.pending) {
    const running = checks.running?.find((c) => c.step) || checks.running?.[0] || null;
    return verdict('waiting', 'ciRunning', { count: checks.pending, name: running?.name || null, step: running?.step || null });
  }
  if (pr.draft) return verdict('waiting', 'draft');
  if (pr.requestedReviewers?.length) return verdict('waiting', 'reviewRequested', { users: pr.requestedReviewers });
  if (state === 'blocked') return verdict('waiting', reviews.approved ? 'blocked' : 'reviewRequired');
  if (state === 'unknown') return verdict('waiting', 'computing');
  // clean, unstable (a check that is not required failed: counted above), has_hooks.
  if (state || reviews.approved) return verdict('ready', 'ready');
  return verdict('waiting', 'open');
}

/**
 * A worktree without a pull request: a row only when it needs something.
 * A branch with no commit of its own, or the base itself, has nothing to
 * propose.
 */
function branchVerdict(ws) {
  if (ws.removed || !ws.branch || ws.onBase || !ws.commits?.length) return null;
  if (!ws.upstream) return verdict('action', 'unpublished');
  if (ws.ahead > 0) return verdict('action', 'unpushed', { count: ws.ahead });
  const lookup = ws.pr;
  if (lookup?.authenticated && lookup.pullRequest === null && lookup.createUrl && !lookup.ssoRequired && !lookup.unreachable && !lookup.error) {
    return verdict('action', 'noPr');
  }
  return null;
}

/** The worktrees a summary shows: the session's, or the folder as the only one. */
function workspacesOf(s) {
  if (!s?.isRepo) return [];
  return s.mode === 'session' ? s.workspaces : [{ ...s, dir: null, isRoot: true, label: null }];
}

/**
 * Every row of a summary: a pull request each (its worktree's, or one the
 * session opened elsewhere), and the worktrees that need a pull request or
 * a push. `wsIndex` is the worktree an action runs in.
 */
function rowsOf(s) {
  if (!s?.isRepo) return [];
  const rows = [];
  workspacesOf(s).forEach((ws, wsIndex) => {
    const pr = ws.pr?.pullRequest;
    if (pr) {
      rows.push({ kind: 'pr', key: pr.url || `#${pr.number}`, pr, ws, wsIndex, createdHere: !!pr.createdHere, verdict: prVerdict(pr, ws) });
      return;
    }
    const v = branchVerdict(ws);
    if (v) rows.push({ kind: 'branch', key: `branch:${ws.dir || ws.branch}`, pr: null, ws, wsIndex, verdict: v });
  });
  for (const entry of s.mode === 'session' ? s.createdPrs : []) {
    const pr = entry.pullRequest;
    if (pr) rows.push({ kind: 'pr', key: pr.url || `#${pr.number}`, pr, ws: null, wsIndex: null, createdHere: true, verdict: prVerdict(pr) });
  }
  return rows;
}

const updatedAt = (row) => Date.parse(row.pr?.updatedAt || '') || 0;

/**
 * A stacked row right under the one it sits on, when both are in the same
 * group: "Waits on #66" above #66 itself read backwards.
 */
function stackOrder(list) {
  const byNumber = new Map(list.filter((r) => r.pr).map((r) => [`${r.pr.repo}#${r.pr.number}`, r]));
  const parentOf = (r) => (r.pr?.stackedOn ? byNumber.get(`${r.pr.repo}#${r.pr.stackedOn.number}`) || null : null);
  const out = [];
  const placed = new Set();
  const place = (row) => {
    if (placed.has(row)) return;
    placed.add(row);
    out.push(row);
    for (const child of list) if (parentOf(child) === row) place(child);
  };
  for (const row of list) if (!parentOf(row)) place(row);
  for (const row of list) place(row); // a loop of stacks, should GitHub ever describe one
  return out;
}

/** Rows by group, most pressing first inside each, then the latest updated, stacks kept together. */
function groupRows(rows) {
  const groups = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const row of rows) groups[row.verdict.group].push(row);
  for (const [group, list] of Object.entries(groups)) {
    list.sort((a, b) => CODE_ORDER.indexOf(a.verdict.code) - CODE_ORDER.indexOf(b.verdict.code) || updatedAt(b) - updatedAt(a));
    groups[group] = stackOrder(list);
  }
  return groups;
}

/** How many rows need the user: the number on the tab button. */
function attentionCount(s) {
  return rowsOf(s).filter((row) => row.verdict.group === 'action').length;
}

/**
 * Why a pull request could not be looked up, once per cause: the list shows
 * these above the rows instead of a muted line in every card.
 */
function noticesOf(s) {
  const lookups = [
    ...workspacesOf(s).map((ws) => ws.pr),
    ...(s?.mode === 'session' ? s.createdPrs : []),
  ].filter((entry) => entry && !entry.pullRequest);
  const notices = [];
  const seen = new Set();
  const add = (key, notice) => {
    if (seen.has(key)) return;
    seen.add(key);
    notices.push(notice);
  };
  for (const entry of lookups) {
    if (entry.authenticated === false) add('login', { kind: 'login' });
    else if (entry.ssoRequired) add(`sso:${entry.ssoRequired.org || entry.ssoRequired.repo}`, { kind: 'sso', org: entry.ssoRequired.org || entry.ssoRequired.repo, url: entry.ssoRequired.url || '' });
    else if (entry.unreachable) add(`unreachable:${entry.unreachable}`, { kind: 'unreachable', repo: entry.unreachable });
    else if (entry.error) add(`error:${entry.repo || ''}:${entry.error}`, { kind: 'error', error: entry.error });
  }
  return notices;
}

/**
 * The repository tag of a row: only when the session's pull requests span
 * several, and then the shortest name that tells them apart (the owner, for
 * a fork and its upstream).
 */
function repoLabeller(rows) {
  const repos = [...new Set(rows.map((r) => r.pr?.repo).filter(Boolean))];
  if (repos.length < 2) return () => '';
  const sameName = new Set(repos.map((r) => r.split('/')[1])).size === 1;
  return (repo) => (!repo ? '' : sameName ? repo.split('/')[0] : repo);
}

const listOf = (users) => (users || []).join(', ');

/** The verdict as the row says it. */
function verdictText(v) {
  const p = v.params;
  switch (v.code) {
    case 'unpushed': return t('chat.git.verdict.unpushed', { count: p.count });
    case 'unpublished': return t('chat.git.verdict.unpublished');
    case 'noPr': return t('chat.git.verdict.noPr');
    case 'conflicts': return t('chat.git.verdict.conflicts', { base: p.base });
    case 'ciFailed': return p.count === 1 && p.name ? t('chat.git.verdict.ciFailedOne', { name: p.name }) : t('chat.git.verdict.ciFailedMany', { count: p.count });
    case 'changesRequested': return t('chat.git.verdict.changesRequested', { users: listOf(p.users) });
    case 'behind': return t('chat.git.verdict.behind', { base: p.base });
    case 'stacked': return t('chat.git.verdict.stacked', { number: p.number });
    case 'ciRunning':
      if (p.name && p.step) return t('chat.git.verdict.ciStep', { name: p.name, number: p.step.number, total: p.step.total });
      return p.name ? t('chat.git.verdict.ciRunning', { name: p.name }) : t('chat.git.checksPending', { count: p.count });
    case 'draft': return t('chat.git.prDraft');
    case 'reviewRequested': return t('chat.git.verdict.reviewRequested', { users: listOf(p.users) });
    case 'reviewRequired': return t('chat.git.verdict.reviewRequired');
    case 'blocked': return t('chat.git.verdict.blocked');
    case 'computing': return t('chat.git.verdict.computing');
    case 'open': return t('chat.git.prOpen');
    case 'ready': return t('chat.git.verdict.ready');
    case 'merged': return p.at
      ? t('chat.git.verdict.merged', { when: formatRelativeTimeIntl(p.at, { language: getCurrentLanguage() }) })
      : t('chat.git.prMerged');
    case 'closed': return t('chat.git.prClosed');
    default: return '';
  }
}

function groupLabel(group) {
  switch (group) {
    case 'action': return t('chat.git.groupAction');
    case 'waiting': return t('chat.git.groupWaiting');
    case 'ready': return t('chat.git.groupReady');
    default: return t('chat.git.groupDone');
  }
}

// ── Prompts for the composer ──
// In English, like every prompt the app writes for Claude, and only drafts:
// the user reads them and sends them.

function intro(pr, what, dir) {
  const branch = pr.headRef ? ` (branch \`${pr.headRef}\`)` : '';
  const lines = [`Pull request #${pr.number}${branch} of ${pr.repo} ${what}`];
  if (dir) lines.push(`The branch is checked out in \`${dir}\`.`);
  return lines;
}

/** Conflicts with the base: merged in, so nothing already pushed is rewritten. */
function conflictsPrompt({ pr, dir = null }) {
  const base = pr.baseRef || 'main';
  return [
    ...intro(pr, `has conflicts with its base \`${base}\`.`, dir),
    '',
    `Fetch the latest \`${base}\`, merge it into the branch, resolve the conflicts, check that the tests still pass, and push.`,
  ].join('\n');
}

function behindPrompt({ pr, dir = null }) {
  const base = pr.baseRef || 'main';
  return [
    ...intro(pr, `is behind its base \`${base}\`, and the repository wants it up to date before it can merge.`, dir),
    '',
    `Fetch the latest \`${base}\`, merge it into the branch, check that the tests still pass, and push.`,
  ].join('\n');
}

const MAX_REVIEW_COMMENTS = 30;
const quote = (text) => String(text || '').trim().split('\n').map((line) => `> ${line}`).join('\n');

/**
 * What the reviewers asked for: each request for changes, then the comments
 * on the code (the latest few, in file order). `comments` is null when they
 * could not be read.
 */
function reviewPrompt({ pr, comments = null, dir = null }) {
  const lines = [...intro(pr, 'has changes requested.', dir)];
  const requests = (pr.reviews?.decisions || []).filter((d) => d.state === 'CHANGES_REQUESTED');
  for (const d of requests) {
    lines.push('', d.body?.trim() ? `@${d.user} wrote:\n${quote(d.body)}` : `@${d.user} requested changes without a summary.`);
  }
  if (comments === null) {
    lines.push('', `The comments on the code could not be retrieved: ${pr.url || 'see the pull request'}.`);
  } else if (comments.length) {
    const latest = [...comments]
      .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
      .slice(0, MAX_REVIEW_COMMENTS)
      .sort((a, b) => String(a.path).localeCompare(String(b.path)) || (a.line || 0) - (b.line || 0));
    lines.push('', 'Comments on the code:');
    for (const c of latest) {
      const where = c.path ? `\`${c.path}${c.line ? `:${c.line}` : ''}\`` : 'general';
      lines.push(`- ${where}, @${c.user}:`, quote(c.body).replace(/^/gm, '  '));
    }
  }
  lines.push('', 'Address this feedback, then push.');
  return lines.join('\n');
}

module.exports = {
  GROUPS,
  prVerdict,
  branchVerdict,
  workspacesOf,
  rowsOf,
  groupRows,
  attentionCount,
  noticesOf,
  repoLabeller,
  verdictText,
  groupLabel,
  conflictsPrompt,
  behindPrompt,
  reviewPrompt,
};
