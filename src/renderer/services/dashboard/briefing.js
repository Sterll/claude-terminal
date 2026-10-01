/**
 * Dashboard briefing
 *
 * The blocks that open the dashboard: what this week cost and took, what to
 * pick up, what is waiting, and how the last two weeks went. The page used to
 * open on code statistics and contributor lists, numbers that rarely change
 * and never ask anything of the reader; those now sit folded at the bottom.
 *
 * Everything here is built from data the app already collects: git status,
 * GitHub runs and pull requests, time tracking, the Claude transcripts (for
 * sessions and cost) and the TODO scan. Builders are pure and return markup;
 * the async loaders cache per project so the several paints of one dashboard
 * render do not each go back to main.
 */

'use strict';

const { t, getCurrentLanguage } = require('../../i18n');
const { escapeHtml } = require('../../utils');
const { formatDuration } = require('../../utils/format');

const api = window.electron_api;

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_DAYS = 14;
const LOAD_TTL = 30 * 1000;
const TODO_TTL = 5 * 60 * 1000;
// The TODO scan stops at this many matches, so a full count reads "50+".
const TODO_SCAN_CAP = 50;

// ── Dates ───────────────────────────────────────────────────────────────────

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Monday 00:00 of the week holding `now`, local time. */
function weekStart(now = Date.now()) {
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The last `count` local days, oldest first, as YYYY-MM-DD keys. */
function lastDays(count, now = Date.now()) {
  const out = [];
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() - (count - 1));
  for (let i = 0; i < count; i++) {
    out.push(dayKey(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function agoLabel(ms, now = Date.now()) {
  const mins = Math.floor((now - ms) / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (mins < 1) return t('dashboard.sessionRecaps.ago.justNow');
  if (mins < 60) return t('dashboard.sessionRecaps.ago.minutes', { n: mins });
  if (days === 0) return t('dashboard.sessionRecaps.ago.hours', { n: hours });
  if (days === 1) return t('dashboard.sessionRecaps.ago.yesterday');
  return t('dashboard.sessionRecaps.ago.days', { n: days });
}

// ── Formatting ──────────────────────────────────────────────────────────────

function locale() {
  try {
    return getCurrentLanguage() || undefined;
  } catch {
    return undefined;
  }
}

function formatUsd(value) {
  const n = Number(value) || 0;
  return new Intl.NumberFormat(locale(), {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: n >= 100 ? 0 : 2,
  }).format(n);
}

// ── Derived figures ─────────────────────────────────────────────────────────

/**
 * Tracked time since `from`. Recorded sessions are clipped to the window; the
 * session running right now is not recorded yet, so it is recovered from
 * `today`, which counts it.
 *
 * @param {Array<{startTime: string, endTime: string}>} sessions
 * @param {{ today: number }} times - getProjectTimes() result
 */
function timeSince(sessions, times, from, now = Date.now()) {
  const clip = (start) => (sessions || []).reduce((sum, s) => {
    const a = Math.max(new Date(s.startTime).getTime(), start);
    const b = Math.min(new Date(s.endTime).getTime(), now);
    return b > a ? sum + (b - a) : sum;
  }, 0);
  const running = Math.max(0, (times?.today || 0) - clip(startOfDay(now)));
  return clip(from) + running;
}

function commitTime(commit) {
  const ms = new Date(commit?.isoDate || commit?.date).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function commitsSince(commits, from) {
  if (!Array.isArray(commits)) return null;
  return commits.filter(c => (commitTime(c) ?? -1) >= from).length;
}

function commitsByDay(commits) {
  const out = {};
  for (const c of commits || []) {
    const ms = commitTime(c);
    if (ms === null) continue;
    const key = dayKey(ms);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** State of the latest CI run: 'success' | 'failure' | 'running' | null. */
function ciState(workflowRuns) {
  const run = workflowRuns?.runs?.[0];
  if (!run) return null;
  if (run.status === 'in_progress' || run.status === 'queued') return 'running';
  if (run.conclusion === 'success') return 'success';
  if (run.conclusion === 'failure') return 'failure';
  return null;
}

function openPullRequests(pullRequests) {
  return (pullRequests?.pullRequests || []).filter(pr => pr.state === 'open');
}

/**
 * What is waiting on this project, most pressing first.
 *
 * @returns {Array<{ tone: string, text: string, url?: string }>}
 */
function todoItems({ gitInfo = {}, workflowRuns, pullRequests, conflicts = [], todoCount = null }) {
  const items = [];
  if (conflicts.length) {
    items.push({ tone: 'danger', text: t('dashboard.brief.todo.conflicts', { count: conflicts.length }) });
  }
  const run = workflowRuns?.runs?.[0];
  const ci = ciState(workflowRuns);
  if (ci === 'failure') items.push({ tone: 'danger', text: t('dashboard.brief.todo.ciFailed', { name: run.name || 'CI' }), url: run.url || run.html_url });
  else if (ci === 'running') items.push({ tone: 'info', text: t('dashboard.brief.todo.ciRunning', { name: run.name || 'CI' }), url: run.url || run.html_url });

  const files = gitInfo.files || {};
  const changed = (files.staged?.length || 0) + (files.unstaged?.length || 0) + (files.untracked?.length || 0);
  if (changed) items.push({ tone: 'warning', text: t('dashboard.filesChanged', { count: changed }) });

  const ab = gitInfo.aheadBehind || {};
  if (ab.hasRemote && !ab.notTracking) {
    if (ab.ahead > 0) items.push({ tone: 'info', text: t('dashboard.brief.todo.unpushed', { count: ab.ahead }) });
    if (ab.behind > 0) items.push({ tone: 'info', text: t('dashboard.brief.todo.behind', { count: ab.behind }) });
  }

  const prs = openPullRequests(pullRequests);
  if (prs.length) items.push({ tone: 'purple', text: t('dashboard.openPrs', { count: prs.length }), url: prs[0].url || prs[0].html_url });

  if (todoCount) {
    items.push({ tone: 'muted', text: t('dashboard.brief.todo.todos', { count: todoCount >= TODO_SCAN_CAP ? `${TODO_SCAN_CAP}+` : todoCount }) });
  }
  return items;
}

// ── Builders ────────────────────────────────────────────────────────────────

/**
 * @param {Array<{ key?: string, value: string, label: string, tone?: string, pending?: boolean }>} cards
 */
function buildMetricsHtml(cards) {
  return `
    <div class="dash-metrics">
      ${cards.map(c => `
        <div class="dash-metric${c.tone ? ` tone-${c.tone}` : ''}"${c.key ? ` data-metric="${c.key}"` : ''}>
          <div class="dash-metric-value${c.pending ? ' pending' : ''}">${escapeHtml(c.value)}</div>
          <div class="dash-metric-label">${escapeHtml(c.label)}</div>
        </div>`).join('')}
    </div>`;
}

function ciMetric(workflowRuns, pullRequests) {
  const ci = ciState(workflowRuns);
  const prs = openPullRequests(pullRequests).length;
  const value = ci === 'success' ? t('dashboard.brief.ci.success')
    : ci === 'failure' ? t('dashboard.brief.ci.failure')
      : ci === 'running' ? t('dashboard.brief.ci.running')
        : t('dashboard.brief.ci.none');
  const tone = ci === 'success' ? 'success' : ci === 'failure' ? 'danger' : ci === 'running' ? 'info' : null;
  return { key: 'ci', value, label: t('dashboard.openPrs', { count: prs }), tone };
}

function cardHtml(slot, title, body, extraClass = '') {
  return `
    <section class="dash-card${extraClass ? ` ${extraClass}` : ''}" data-dash="${slot}">
      <h3>${escapeHtml(title)}</h3>
      ${body}
    </section>`;
}

function buildTodoHtml(items, { withProject = false } = {}) {
  if (!items.length) {
    return `<div class="dash-empty-line"><span class="dash-dot tone-success"></span>${escapeHtml(t('dashboard.brief.todo.empty'))}</div>`;
  }
  return `
    <ul class="dash-todo-list">
      ${items.map(item => `
        <li class="dash-todo-item${item.url || item.projectIndex !== undefined ? ' clickable' : ''}"
            ${item.url ? `data-url="${escapeHtml(item.url)}"` : ''}
            ${item.projectIndex !== undefined ? `data-project-index="${item.projectIndex}"` : ''}>
          <span class="dash-dot tone-${item.tone}"></span>
          ${withProject && item.project ? `<span class="dash-todo-project">${escapeHtml(item.project)}</span>` : ''}
          <span class="dash-todo-text">${escapeHtml(item.text)}</span>
        </li>`).join('')}
    </ul>`;
}

/** Sessions from `claude.sessions`, newest first. */
function sessionTitle(s) {
  return s.customTitle || s.aiTitle || s.title || s.summary || s.firstPrompt || t('timeline.untitledSession');
}

function buildResumeHtml(sessions, recap) {
  if (sessions === null) {
    return `<div class="dash-placeholder">${escapeHtml(t('common.loading'))}</div>`;
  }
  if (!sessions.length) {
    return `<div class="dash-empty-line">${escapeHtml(t('dashboard.brief.resume.empty'))}</div>`;
  }
  const rows = sessions.map((s, i) => {
    const meta = [agoLabel(new Date(s.modified).getTime())];
    if (s.messageCount) meta.push(t('timeline.messageCount', { count: s.messageCount }));
    if (s.gitBranch) meta.push(s.gitBranch);
    return `
      <div class="dash-resume-row">
        <div class="dash-resume-main">
          <div class="dash-resume-title">${escapeHtml(String(sessionTitle(s)).slice(0, 140))}</div>
          <div class="dash-resume-meta">${escapeHtml(meta.join(' · '))}</div>
        </div>
        <button class="dash-btn${i === 0 ? ' primary' : ''}" data-resume="${escapeHtml(s.sessionId)}">${escapeHtml(t('dashboard.brief.resume.button'))}</button>
      </div>`;
  }).join('');
  const recapHtml = recap?.summary
    ? `<div class="dash-recap"><span class="dash-recap-label">${escapeHtml(t('dashboard.brief.resume.lastRecap'))}</span>${escapeHtml(String(recap.summary).replace(/^•\s*/gm, '').split('\n').filter(Boolean).slice(0, 2).join(' · '))}</div>`
    : '';
  return rows + recapHtml;
}

/**
 * @param {Array<{ date: string, cost: number|null, commits: number }>} days
 */
function buildActivityHtml(days) {
  const maxCost = Math.max(...days.map(d => d.cost || 0), 0.01);
  const maxCommits = Math.max(...days.map(d => d.commits || 0), 1);
  const costKnown = days.some(d => d.cost !== null);
  const bars = days.map(d => {
    const [y, m, dd] = d.date.split('-').map(Number);
    const label = new Date(y, m - 1, dd).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric' });
    const parts = [label];
    if (d.cost !== null) parts.push(formatUsd(d.cost));
    parts.push(t('dashboard.brief.activity.commits', { count: d.commits }));
    return `
      <div class="dash-day" title="${escapeHtml(parts.join(' · '))}">
        <div class="dash-day-bars">
          <div class="dash-day-cost" style="height:${costKnown ? ((d.cost || 0) / maxCost) * 100 : 0}%"></div>
          <div class="dash-day-commits" style="height:${(d.commits / maxCommits) * 100}%"></div>
        </div>
        <div class="dash-day-label">${escapeHtml(label)}</div>
      </div>`;
  }).join('');
  return `
    <div class="dash-legend">
      ${costKnown ? `<span><span class="dash-dot tone-accent"></span>${escapeHtml(t('dashboard.brief.activity.cost'))}</span>` : ''}
      <span><span class="dash-dot tone-purple"></span>${escapeHtml(t('dashboard.brief.activity.commitsLegend'))}</span>
    </div>
    <div class="dash-days">${bars}</div>`;
}

function sparklineHtml(values) {
  const max = Math.max(...values, 0.01);
  return `<div class="dash-spark">${values.map(v => `<span style="height:${Math.max(v > 0 ? 8 : 0, (v / max) * 100)}%"></span>`).join('')}</div>`;
}

// ── Loaders (cached per key) ────────────────────────────────────────────────

const _cache = new Map(); // key -> { at, value, promise }

function cached(key, ttl, load) {
  const entry = _cache.get(key);
  const fresh = entry && 'value' in entry && Date.now() - entry.at < ttl;
  if (!fresh && !entry?.promise) {
    const promise = Promise.resolve()
      .then(load)
      .then(value => {
        _cache.set(key, { at: Date.now(), value });
        return value;
      })
      .catch(err => {
        console.warn(`[Dashboard] ${key} failed:`, err?.message || err);
        _cache.set(key, { at: Date.now(), value: entry?.value ?? null });
        return entry?.value ?? null;
      });
    _cache.set(key, { ...(entry || {}), promise });
  }
  const current = _cache.get(key);
  return {
    value: current && 'value' in current ? current.value : undefined,
    // A load is in flight: the caller should repaint when `ready` settles.
    pending: !!current?.promise && !fresh,
    ready: current?.promise || Promise.resolve(current?.value),
  };
}

function loadProjectCost(projectId) {
  return cached(`cost:${projectId}`, LOAD_TTL, async () => {
    if (!api.cost?.getReport) return null;
    const from = Math.min(weekStart(), startOfDay(Date.now()) - (ACTIVITY_DAYS - 1) * DAY_MS);
    const report = await api.cost.getReport({ from, projectId });
    const byDay = report?.byProject?.[0]?.byDay || {};
    const week = weekStart();
    let weekCost = 0;
    for (const [day, cost] of Object.entries(byDay)) {
      const [y, m, d] = day.split('-').map(Number);
      if (new Date(y, m - 1, d).getTime() >= week) weekCost += cost;
    }
    return { byDay, weekCost };
  });
}

function loadAllProjectsCost() {
  return cached('cost:all', LOAD_TTL, async () => {
    if (!api.cost?.getReport) return null;
    const from = Math.min(weekStart(), startOfDay(Date.now()) - 6 * DAY_MS);
    const report = await api.cost.getReport({ from });
    const week = weekStart();
    const byProject = {};
    let weekTotal = 0;
    for (const p of report?.byProject || []) {
      let weekCost = 0;
      for (const [day, cost] of Object.entries(p.byDay || {})) {
        const [y, m, d] = day.split('-').map(Number);
        if (new Date(y, m - 1, d).getTime() >= week) weekCost += cost;
      }
      weekTotal += weekCost;
      if (p.projectId) byProject[p.projectId] = { byDay: p.byDay || {}, weekCost };
    }
    return { byProject, weekTotal };
  });
}

function loadSessions(project, limit = 3) {
  return cached(`sessions:${project.path}`, LOAD_TTL, async () => {
    const list = await api.claude.sessions(project.path);
    return (Array.isArray(list) ? list : [])
      .filter(s => s?.sessionId && s.modified)
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
      .slice(0, limit);
  });
}

function loadTodoCount(project) {
  return cached(`todos:${project.path}`, TODO_TTL, async () => {
    if (!api.project?.scanTodos) return null;
    const todos = await api.project.scanTodos(project.path);
    return Array.isArray(todos) ? todos.length : null;
  });
}

function loadLatestRecap(projectId) {
  return cached(`recap:${projectId}`, LOAD_TTL, async () => {
    const { getRecaps } = require('../SessionRecapService');
    const recaps = await getRecaps(projectId);
    return recaps?.[0] || null;
  });
}

/** Test hook. */
function _resetCache() {
  _cache.clear();
}

module.exports = {
  DAY_MS,
  ACTIVITY_DAYS,
  startOfDay,
  weekStart,
  dayKey,
  lastDays,
  agoLabel,
  formatUsd,
  formatDuration,
  timeSince,
  commitsSince,
  commitsByDay,
  ciState,
  ciMetric,
  openPullRequests,
  todoItems,
  buildMetricsHtml,
  buildTodoHtml,
  buildResumeHtml,
  buildActivityHtml,
  sparklineHtml,
  cardHtml,
  loadProjectCost,
  loadAllProjectsCost,
  loadSessions,
  loadTodoCount,
  loadLatestRecap,
  _resetCache,
};
