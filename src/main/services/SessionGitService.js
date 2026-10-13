'use strict';
/**
 * Where a session's branch stands: everything behind the chat's Git tab, in
 * one call so the renderer does not chain a dozen IPC requests per refresh.
 *
 * Read-only. Branch, upstream and drift, the base the branch is measured
 * against, uncommitted files, the branch's own commits, and its pull request
 * with checks and reviews.
 *
 * Every git call here is one that fails as ordinary control flow (no
 * upstream, no origin/HEAD, not a repo), which `execGit` answers with null and
 * does not log. A tab polled every 30 s must not fill the error log.
 */

const fsp = require('fs').promises;
const path = require('path');
const { execGit, parseGitStatus } = require('../utils/git');
const github = require('./GitHubAuthService');
const sessionActivity = require('./SessionActivityService');

const COMMIT_LIMIT = 30;
const RECENT_ON_BASE = 10;
const SEP = '\x1f';
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const MAX_WORKSPACES = 6;
const MAX_DIRS = 100;
const TOP_CACHE_MS = 5 * 60 * 1000;
const MAX_PROGRESS_JOBS = 4;

/** `git log` lines as commits. */
function parseLog(output) {
  if (!output) return [];
  return output.split('\n').filter(Boolean).map((line) => {
    const [sha, short, subject, author, date] = line.split(SEP);
    return { sha, short, subject, author, date };
  });
}

/** name → fetch URL, from `git remote -v`. */
function parseRemotes(output) {
  const remotes = {};
  for (const line of (output || '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m) remotes[m[1]] = m[2];
  }
  return remotes;
}

/** The web host of a remote URL, for the "create a pull request" link. */
function remoteHost(url) {
  if (typeof url !== 'string') return null;
  if (/^https?:\/\//i.test(url)) {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }
  const ssh = /^[^@]+@([^:]+):/.exec(url);
  return ssh ? ssh[1] : null;
}

/**
 * The branch the session's branch is measured against.
 *
 * A branch that tracks a remote is measured against that remote's main: a
 * branch pushed to a fork is based on the fork's main, and measuring it
 * against origin/main (the upstream) would list every commit the fork has
 * that upstream does not.
 *
 * A branch not published yet tracks nothing, so every remote's main and the
 * local main are candidates, and the closest one wins: the base the branch
 * has the fewest commits on top of. A handful of `rev-list --count`, only for
 * an unpublished branch.
 */
async function findBase(cwd, remote, branch) {
  const preferred = async (r) => {
    const head = await execGit(cwd, ['for-each-ref', '--format=%(symref:short)', `refs/remotes/${r}/HEAD`]);
    if (head) return head;
    const refs = [`refs/remotes/${r}/main`, `refs/remotes/${r}/master`];
    const found = ((await execGit(cwd, ['for-each-ref', '--format=%(refname)', ...refs])) || '').split('\n').filter(Boolean);
    const first = refs.find((ref) => found.includes(ref));
    return first ? first.replace(/^refs\/remotes\//, '') : null;
  };

  if (remote) {
    const base = await preferred(remote);
    if (base) return base;
  }

  const remotes = ((await execGit(cwd, ['remote'])) || '').split('\n').filter(Boolean);
  const candidates = [];
  for (const r of ['origin', ...remotes.filter((x) => x !== 'origin')]) {
    if (!remotes.includes(r)) continue;
    const base = await preferred(r);
    if (base && !candidates.includes(base)) candidates.push(base);
  }
  const local = ((await execGit(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/master'])) || '').split('\n').filter(Boolean);
  for (const name of ['main', 'master']) if (local.includes(name) && name !== branch) candidates.push(name);
  if (candidates.length <= 1 || !branch) return candidates[0] || null;

  let best = null;
  for (const base of candidates) {
    const count = parseInt((await execGit(cwd, ['rev-list', '--count', `${base}..HEAD`])) || '', 10);
    if (Number.isFinite(count) && (!best || count < best.count)) best = { base, count };
  }
  return best ? best.base : candidates[0];
}

/**
 * Counts by outcome, plus the checks still running and the ones that failed.
 * A check GitHub Actions ran carries its job id: its steps and its log are
 * read through it. Another app's check (a linter bot, a deploy) has neither.
 */
function summarizeChecks(checkRuns) {
  const checks = { total: 0, success: 0, failure: 0, pending: 0, skipped: 0, failing: [], running: [] };
  for (const run of checkRuns || []) {
    checks.total++;
    const jobId = run.app === 'github-actions' && run.id ? run.id : null;
    if (run.status !== 'completed') {
      checks.pending++;
      checks.running.push({ name: run.name, url: run.url || null, jobId, step: null });
    } else if (['success', 'neutral'].includes(run.conclusion)) checks.success++;
    else if (['skipped', 'cancelled', 'stale'].includes(run.conclusion)) checks.skipped++;
    else {
      checks.failure++;
      checks.failing.push({ name: run.name, url: run.url || null, jobId });
    }
  }
  return checks;
}

/**
 * Which step each running job is on, shown as "5/8". One request per job, so
 * only the first few: a matrix can run dozens.
 */
async function addStepProgress(owner, repo, checks) {
  const jobs = checks.running.filter((c) => c.jobId).slice(0, MAX_PROGRESS_JOBS);
  await Promise.all(jobs.map(async (check) => {
    const res = await github.getWorkflowJob(owner, repo, check.jobId);
    const steps = res?.job?.steps || [];
    const current = steps.find((st) => st.status === 'in_progress') || steps.find((st) => st.status !== 'completed');
    if (current) check.step = { number: current.number, total: steps.length, name: current.name };
  }));
  return checks;
}

async function checksOf(owner, repo, headSha) {
  if (!headSha) return summarizeChecks([]);
  const res = await github.getCheckRuns(owner, repo, headSha);
  return addStepProgress(owner, repo, summarizeChecks(res.checkRuns));
}

/** Each reviewer's latest decision; plain comments do not override a decision. */
function summarizeReviews(reviews) {
  const latest = new Map();
  for (const review of reviews || []) {
    if (!review.user) continue;
    if (review.state === 'COMMENTED' && latest.has(review.user)) continue;
    latest.set(review.user, review.state);
  }
  const decisions = [...latest.entries()].map(([user, state]) => ({ user, state }));
  return {
    approved: decisions.filter((d) => d.state === 'APPROVED').length,
    changesRequested: decisions.filter((d) => d.state === 'CHANGES_REQUESTED').length,
    decisions,
  };
}

/**
 * The branch's pull request, looked for on the repository the branch is
 * pushed to, then on origin. An open one wins over a closed or merged one.
 */
async function findPullRequest(cwd, branch, remote, base) {
  const remotes = parseRemotes(await execGit(cwd, ['remote', '-v']));
  const pushRemote = remote && remotes[remote] ? remote : remotes.origin ? 'origin' : null;
  if (!pushRemote) return null;
  const pushRepo = github.parseGitHubRemote(remotes[pushRemote]);
  if (!pushRepo) return null;

  const repos = [];
  for (const name of [pushRemote, 'origin']) {
    const parsed = remotes[name] && github.parseGitHubRemote(remotes[name]);
    if (parsed && !repos.some((r) => r.owner === parsed.owner && r.repo === parsed.repo)) repos.push(parsed);
  }

  const baseBranch = base ? base.replace(/^[^/]+\//, '') : 'main';
  const host = remoteHost(remotes[pushRemote]) || 'github.com';
  const createUrl = `https://${host}/${pushRepo.owner}/${pushRepo.repo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}?expand=1`;

  let found = null;
  // Why a repository could not be searched. "No pull request" would be a guess
  // then: GitHub answers 403 to a token not authorized for an organization's
  // SAML SSO, 404 to one the organization never approved.
  let blocked = null;
  for (const repo of repos) {
    const res = await github.getPullRequestsForBranch(repo.owner, repo.repo, pushRepo.owner, branch);
    if (!res.authenticated) return { authenticated: false, createUrl };
    const name = `${repo.owner}/${repo.repo}`;
    if (!blocked) {
      if (res.ssoRequired) blocked = { ssoRequired: { ...res.ssoRequired, repo: name } };
      else if (res.notFound) blocked = { unreachable: name };
      else if (res.error) blocked = { error: res.error, repo: name };
    }
    const best = res.pullRequests.find((pr) => pr.state === 'open') || res.pullRequests[0];
    if (best && (!found || (found.pr.state !== 'open' && best.state === 'open'))) found = { repo, pr: best };
    if (found?.pr.state === 'open') break;
  }
  if (!found) return { authenticated: true, createUrl, pullRequest: null, ...blocked };

  const { repo, pr } = found;
  const [checks, reviews] = await Promise.all([
    checksOf(repo.owner, repo.repo, pr.headSha),
    github.getPullRequestReviews(repo.owner, repo.repo, pr.number),
  ]);
  return {
    authenticated: true,
    createUrl,
    pullRequest: {
      ...pr,
      repo: `${repo.owner}/${repo.repo}`,
      checks,
      reviews: summarizeReviews(reviews.reviews),
    },
  };
}

/**
 * @param {string} cwd the session's working directory
 * @param {{ withPullRequest?: boolean }} [opts]
 */
async function summary(cwd, { withPullRequest = true } = {}) {
  if (typeof cwd !== 'string' || !cwd) return { isRepo: false };
  const root = await execGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) return { isRepo: false };

  const [branchRaw, head, statusOut, gitDir, commonDir] = await Promise.all([
    execGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    execGit(cwd, ['rev-parse', '--short', 'HEAD']),
    execGit(cwd, ['status', '--porcelain']),
    execGit(cwd, ['rev-parse', '--git-dir']),
    execGit(cwd, ['rev-parse', '--git-common-dir']),
  ]);
  const detached = branchRaw === 'HEAD';
  const branch = detached ? null : branchRaw;

  const files = parseGitStatus(statusOut || '');
  const conflicts = (statusOut || '').split('\n').filter((l) => CONFLICT_CODES.has(l.slice(0, 2))).length;
  const worktree = !!(gitDir && commonDir && path.resolve(cwd, gitDir) !== path.resolve(cwd, commonDir));

  let upstream = null;
  let remote = null;
  let ahead = 0;
  let behind = 0;
  if (branch) {
    const ref = await execGit(cwd, ['for-each-ref', '--format=%(upstream:short)%00%(upstream:remotename)', `refs/heads/${branch}`]);
    if (ref) {
      const [u, r] = ref.split('\0');
      upstream = u || null;
      remote = r || null;
    }
    if (upstream) {
      const counts = await execGit(cwd, ['rev-list', '--left-right', '--count', `${branch}...${upstream}`]);
      if (counts) [ahead, behind] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
    }
  }

  const base = await findBase(cwd, remote, branch);
  const onBase = !branch || !base || base === branch || base.endsWith(`/${branch}`);
  const format = `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI`;
  const commits = parseLog(onBase
    ? await execGit(cwd, ['log', format, '-n', String(RECENT_ON_BASE)])
    : await execGit(cwd, ['log', format, '-n', String(COMMIT_LIMIT), `${base}..HEAD`]));

  const pr = withPullRequest && branch && !onBase ? await findPullRequest(cwd, branch, remote, base) : null;

  return {
    isRepo: true,
    root,
    branch,
    detached,
    head,
    worktree,
    upstream,
    remote,
    ahead,
    behind,
    base,
    onBase,
    dirty: {
      staged: files.staged.length,
      unstaged: files.unstaged.length,
      untracked: files.untracked.length,
      conflicts,
    },
    commits,
    pr,
  };
}

// ── A session's own worktrees ──────────────────────────────────────────────

/** dir → { top, at }: which worktree of the project a directory belongs to, or null. */
const topCache = new Map();

async function realpathOrNull(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/**
 * The real path of a directory that may no longer exist: its closest existing
 * ancestor resolved, the rest appended. On macOS /var is /private/var, so a
 * removed worktree's path only compares with the project's once resolved.
 */
async function realpathLoose(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    const real = await realpathOrNull(cur);
    if (real) return path.join(real, ...rest);
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/** The worktree a directory sits in and its repository's common git dir, both real paths. */
async function locateDir(dir) {
  const top = await execGit(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const common = await execGit(top, ['rev-parse', '--git-common-dir']);
  if (!common) return null;
  const [realTop, realCommon] = await Promise.all([realpathOrNull(top), realpathOrNull(path.resolve(top, common))]);
  return realTop && realCommon ? { top: realTop, common: realCommon } : null;
}

const MAX_TRACKED_CHECK = 200;

/**
 * Whether the session changed a file git tracks in the project folder. Notes
 * and analyses it wrote there are untracked and say nothing about the
 * folder's branch: counting them put an unrelated, merged pull request in
 * every session that had written a note.
 */
async function editedTrackedFile(projectPath, top, edits) {
  const roots = [...new Set([top, path.resolve(projectPath)])];
  const rel = [];
  for (const { file } of edits || []) {
    const root = roots.find((r) => file.startsWith(r + path.sep));
    if (root) rel.push(path.relative(root, file));
    if (rel.length >= MAX_TRACKED_CHECK) break;
  }
  if (!rel.length) return false;
  return !!(await execGit(top, ['ls-files', '--', ...rel]));
}

/**
 * The worktrees of this project's repository the session worked in, newest
 * first. The project folder counts only when the session changed a file git
 * tracks there: every session starts with its cwd in it, and the notes it
 * writes there are not work on the folder's branch.
 */
async function workspacesOf(projectPath, activity) {
  const project = await locateDir(projectPath);
  if (!project) return [];
  const tops = new Map();
  const removed = [];
  for (const { dir, at, kinds, branch } of activity.dirs.slice(0, MAX_DIRS)) {
    let hit = topCache.get(dir);
    if (!hit || Date.now() - hit.at > TOP_CACHE_MS) {
      const where = await locateDir(dir);
      hit = { top: where && where.common === project.common ? where.top : null, at: Date.now() };
      topCache.set(dir, hit);
    }
    if (!hit.top) {
      // A worktree it entered and that has since been removed: its branch
      // still names a pull request. Only one inside the project's folder.
      const real = await realpathLoose(dir);
      if (branch && kinds.includes('enter') && real.startsWith(project.top + path.sep) && !(await realpathOrNull(real))) {
        removed.push({ dir: real, at, branch, removed: true, isRoot: false, label: path.relative(project.top, real) });
      }
      continue;
    }
    const entry = tops.get(hit.top) || { at: 0, kinds: new Set() };
    entry.at = Math.max(entry.at, at);
    kinds.forEach((k) => entry.kinds.add(k));
    tops.set(hit.top, entry);
  }
  const rootWorked = tops.get(project.top)?.kinds.has('edit') && await editedTrackedFile(projectPath, project.top, activity.edits);
  const live = [...tops.entries()]
    .filter(([top]) => top !== project.top || rootWorked)
    .map(([top, e]) => ({ dir: top, at: e.at, isRoot: top === project.top, label: top === project.top ? null : path.relative(project.top, top) }));
  return [...live, ...removed].sort((a, b) => b.at - a.at).slice(0, MAX_WORKSPACES);
}

/** A pull request the session created, looked up by number. */
async function createdPullRequest(p) {
  const repo = `${p.owner}/${p.repo}`;
  const res = await github.getPullRequest(p.owner, p.repo, p.number);
  const base = { url: p.url, number: p.number, repo };
  if (!res.authenticated) return { ...base, authenticated: false };
  if (!res.pullRequest) {
    if (res.ssoRequired) return { ...base, authenticated: true, pullRequest: null, ssoRequired: { ...res.ssoRequired, repo } };
    if (res.notFound) return { ...base, authenticated: true, pullRequest: null, unreachable: repo };
    return { ...base, authenticated: true, pullRequest: null, error: res.error || 'unknown', repo };
  }
  const pr = res.pullRequest;
  const [checks, reviews] = await Promise.all([
    checksOf(p.owner, p.repo, pr.headSha),
    github.getPullRequestReviews(p.owner, p.repo, pr.number),
  ]);
  return {
    ...base,
    authenticated: true,
    pullRequest: { ...pr, repo, checks, reviews: summarizeReviews(reviews.reviews) },
  };
}

/**
 * What one session did in git: the worktrees it used, each with its branch
 * and that branch's pull request, and the pull requests it created that no
 * shown worktree carries. Without a transcript to read (a new tab, a session
 * from elsewhere), or when the session never left the project folder, it is
 * the project folder's summary, as before.
 *
 * @param {{ projectPath: string, sessionId?: string|null }} params
 * @param {{ activity?: { read: Function } }} [deps]
 */
async function overview({ projectPath, sessionId = null } = {}, { activity = sessionActivity } = {}) {
  if (typeof projectPath !== 'string' || !projectPath) return { isRepo: false };
  const act = sessionId ? await activity.read(projectPath, sessionId).catch(() => null) : null;
  const spaces = act ? await workspacesOf(projectPath, act) : [];
  if (!spaces.length && !act?.prs?.length) return { ...(await summary(projectPath)), mode: 'project' };

  const workspaces = [];
  for (const ws of spaces) {
    if (ws.removed) {
      // Nothing left on disk to read: the branch and its pull request, looked up from the project folder.
      workspaces.push({ ...ws, isRepo: true, pr: await findPullRequest(projectPath, ws.branch, null, null) });
      continue;
    }
    const s = await summary(ws.dir);
    if (s.isRepo) workspaces.push({ ...s, dir: ws.dir, isRoot: ws.isRoot, label: ws.label, at: ws.at });
  }
  const created = new Set(act.prs.map((p) => p.url.toLowerCase()));
  for (const ws of workspaces) {
    const pr = ws.pr?.pullRequest;
    if (pr?.url && created.has(pr.url.toLowerCase())) pr.createdHere = true;
  }
  const shown = new Set(workspaces.map((w) => w.pr?.pullRequest?.url?.toLowerCase()).filter(Boolean));
  const createdPrs = [];
  for (const p of [...act.prs].reverse()) {
    if (!shown.has(p.url.toLowerCase())) createdPrs.push(await createdPullRequest(p));
  }
  return { isRepo: true, mode: 'session', workspaces, createdPrs };
}

module.exports = {
  summary,
  overview,
  _internals: { parseLog, parseRemotes, remoteHost, summarizeChecks, addStepProgress, summarizeReviews, workspacesOf, topCache },
};
