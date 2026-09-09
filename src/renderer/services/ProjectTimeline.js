/**
 * ProjectTimeline
 *
 * One chronological reading of everything that happened on a project.
 *
 * The app already records a great deal per project, but each kind of record
 * lives behind its own screen: commits in Git, conversations in Sessions, hours
 * in Time Tracking, runs in Workflows and in Parallel Tasks, published documents
 * in Artifacts. Answering "what happened here last week?" means visiting six
 * screens and reconciling six clocks by hand.
 *
 * So this collects nothing new. Every event below is already persisted
 * somewhere; the work is normalising six different record shapes onto one
 * `{ ts, kind, title, subtitle }` and sorting them together.
 *
 * Design notes:
 *
 *   - The normalisers are pure and exported, because they are the part with
 *     edge cases worth testing (missing timestamps, unfinished runs, sessions
 *     whose title has not been generated yet) and they need no DOM.
 *   - Each source is loaded independently and is allowed to fail on its own.
 *     A project with no git remote, no workflows and no artifacts is the normal
 *     case, not an error, and one broken source must never blank the whole
 *     view. `collect()` reports which sources failed rather than throwing.
 *   - Timestamps are normalised to epoch milliseconds on the way in. Git hands
 *     back ISO strings, the SDK hands back ISO strings, time tracking stores
 *     ISO strings, parallel runs store epoch numbers, and comparing those
 *     directly is how off-by-a-timezone bugs happen.
 */

const api = window.electron_api;
const { getProjectSessions } = require('../state');
const { formatDuration } = require('../utils/format');
const { t } = require('../i18n');

/** Sources, in the order their events tie-break within the same millisecond. */
const KINDS = ['commit', 'session', 'time', 'workflow', 'parallel', 'artifact'];

/** Default window. Two weeks is about as far back as "what happened" stays a useful question. */
const DEFAULT_DAYS = 14;

/** Per-source cap, so one very busy source cannot crowd out the other five. */
const MAX_PER_SOURCE = 150;

// ── Time helpers ─────────────────────────────────────────────────────────────

/**
 * Coerce anything the six sources use as a timestamp into epoch milliseconds.
 *
 * @param {string|number|Date|null|undefined} value
 * @returns {number|null} null when the value is absent or unparseable, which
 *   callers treat as "drop this event" rather than "put it at 1970".
 */
function toEpoch(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/** Local-day key, `YYYY-MM-DD`. Local, not UTC: the user's idea of "Friday" is theirs. */
function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** `HH:MM` in local time. */
function clockTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Heading for a day group: "Today", "Yesterday", or the localised date.
 *
 * Compared by day key rather than by elapsed hours, so 00:30 is still "today"
 * and 23:30 yesterday is still "yesterday" — which is what someone reading a
 * work log means by those words.
 *
 * @param {number} ts
 * @param {number} [now=Date.now()] - injectable for tests
 */
function dayLabel(ts, now = Date.now()) {
  const key = dayKey(ts);
  if (key === dayKey(now)) return t('timeline.today');
  if (key === dayKey(now - 24 * 60 * 60 * 1000)) return t('timeline.yesterday');
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}

// ── Labels ───────────────────────────────────────────────────────────────────
//
// Written as switches over literal t() keys rather than `t('prefix.' + value)`.
// tests/i18n/i18n-usage.test.js only sees literal single-quoted keys, so a
// computed key would be invisible to it and would surface in the UI as a raw
// dot-path the day a locale forgot it. The literal form keeps every key
// greppable and guarded. An unknown value falls back to itself, which reads as
// a slightly technical word rather than as `timeline.status.wat`.

/** @param {string} status - workflow RUN_STATUS or parallel-run phase */
function statusLabel(status) {
  switch (status) {
    case 'success':     return t('timeline.status.success');
    case 'failed':      return t('timeline.status.failed');
    case 'running':     return t('timeline.status.running');
    case 'pending':     return t('timeline.status.pending');
    case 'cancelled':   return t('timeline.status.cancelled');
    case 'skipped':     return t('timeline.status.skipped');
    case 'timeout':     return t('timeline.status.timeout');
    case 'interrupted': return t('timeline.status.interrupted');
    case 'done':        return t('timeline.status.done');
    case 'merged':      return t('timeline.status.merged');
    case 'merging':     return t('timeline.status.merging');
    case 'decomposing': return t('timeline.status.decomposing');
    case 'reviewing':   return t('timeline.status.reviewing');
    default:            return status || '';
  }
}

/** @param {string} kind - one of KINDS */
function kindLabel(kind) {
  switch (kind) {
    case 'commit':   return t('timeline.kind.commit');
    case 'session':  return t('timeline.kind.session');
    case 'time':     return t('timeline.kind.time');
    case 'workflow': return t('timeline.kind.workflow');
    case 'parallel': return t('timeline.kind.parallel');
    case 'artifact': return t('timeline.kind.artifact');
    default:         return kind || '';
  }
}

// ── Normalisers (pure) ───────────────────────────────────────────────────────
//
// Each takes the raw records of one source and returns timeline events. They
// never throw on a malformed record: a record that cannot be placed in time is
// dropped, because an event with no timestamp has no place in a timeline.

/**
 * @typedef {Object} TimelineEvent
 * @property {number} ts        - epoch ms
 * @property {string} kind      - one of KINDS
 * @property {string} title     - the line the user reads
 * @property {string} [subtitle]- secondary line, may be empty
 * @property {'success'|'danger'|'warning'|'muted'} [tone]
 * @property {Object} [ref]     - identifiers for a future click-through
 */

/** @param {Array} commits - records from `git.commitHistory` */
function normalizeCommits(commits) {
  if (!Array.isArray(commits)) return [];
  return commits.reduce((out, c) => {
    const ts = toEpoch(c?.isoDate || c?.date);
    if (ts === null) return out;
    out.push({
      ts,
      kind: 'commit',
      title: String(c.message || '').split('\n')[0] || '(no message)',
      subtitle: [c.author, c.hash].filter(Boolean).join(' · '),
      ref: { hash: c.fullHash || c.hash },
    });
    return out;
  }, []);
}

/** @param {Array} sessions - records from `claude.sessions` */
function normalizeSessions(sessions) {
  if (!Array.isArray(sessions)) return [];
  return sessions.reduce((out, s) => {
    const ts = toEpoch(s?.modified);
    if (ts === null) return out;
    // A session is titled by the user, then by the model, and until either
    // happens the first prompt is the only thing that identifies it.
    const label = s.customTitle || s.aiTitle || s.title || s.summary || s.firstPrompt || '';
    const parts = [];
    if (s.messageCount) parts.push(t('timeline.messageCount', { count: s.messageCount }));
    if (s.gitBranch) parts.push(s.gitBranch);
    out.push({
      ts,
      kind: 'session',
      title: label ? String(label).slice(0, 160) : t('timeline.untitledSession'),
      subtitle: parts.join(' · '),
      ref: { sessionId: s.sessionId },
    });
    return out;
  }, []);
}

/**
 * Time tracking records a session per continuous stretch of work. They are
 * placed at their END, not their start: the timeline reads as a log of things
 * that finished, and a two-hour block is more legible next to the commits it
 * produced than next to the ones that preceded it.
 *
 * @param {Array} sessions - records from `getProjectSessions`
 */
function normalizeTimeSessions(sessions) {
  if (!Array.isArray(sessions)) return [];
  return sessions.reduce((out, s) => {
    const ts = toEpoch(s?.endTime);
    const started = toEpoch(s?.startTime);
    if (ts === null || !Number.isFinite(s?.duration) || s.duration <= 0) return out;
    out.push({
      ts,
      kind: 'time',
      title: t('timeline.workedFor', { duration: formatDuration(s.duration) }),
      subtitle: started === null ? '' : `${clockTime(started)} – ${clockTime(ts)}`,
    });
    return out;
  }, []);
}

/**
 * Workflow runs are stored globally, not per project, and carry the project
 * they ran against as a `projectPath` context variable.
 *
 * @param {Array} runs - records from `workflow.getRecentRuns`
 * @param {string} projectPath
 */
function normalizeWorkflowRuns(runs, projectPath) {
  if (!Array.isArray(runs) || !projectPath) return [];
  const wanted = String(projectPath).replace(/[\\/]+$/, '').toLowerCase();
  return runs.reduce((out, r) => {
    const runPath = String(r?.projectPath || '').replace(/[\\/]+$/, '').toLowerCase();
    if (runPath !== wanted) return out;
    const ts = toEpoch(r.finishedAt) ?? toEpoch(r.startedAt);
    if (ts === null) return out;
    const status = String(r.status || '');
    out.push({
      ts,
      kind: 'workflow',
      title: r.workflowName || r.workflowId || t('timeline.untitledWorkflow'),
      subtitle: [
        statusLabel(status),
        r.trigger,
        Number.isFinite(r.duration) ? formatDuration(r.duration) : '',
      ].filter(Boolean).join(' · '),
      tone: status === 'success' ? 'success'
        : status === 'failed' ? 'danger'
          : status === 'running' ? 'warning' : 'muted',
      ref: { runId: r.id },
    });
    return out;
  }, []);
}

/** @param {Array} runs - records from `parallel.getHistory` */
function normalizeParallelRuns(runs) {
  if (!Array.isArray(runs)) return [];
  return runs.reduce((out, r) => {
    const ts = toEpoch(r?.endedAt) ?? toEpoch(r?.startedAt);
    if (ts === null) return out;
    const phase = String(r.phase || '');
    const taskCount = Array.isArray(r.tasks) ? r.tasks.length : r.taskCount;
    out.push({
      ts,
      kind: 'parallel',
      title: String(r.goal || t('timeline.untitledRun')).slice(0, 160),
      subtitle: [
        statusLabel(phase),
        Number.isFinite(taskCount) ? t('timeline.taskCount', { count: taskCount }) : '',
        r.mainBranch,
      ].filter(Boolean).join(' · '),
      tone: phase === 'merged' || phase === 'done' ? 'success'
        : phase === 'failed' ? 'danger'
          : phase === 'cancelled' ? 'muted' : 'warning',
      ref: { runId: r.id },
    });
    return out;
  }, []);
}

/** @param {Array} artifacts - records from `artifacts.list` */
function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.reduce((out, a) => {
    const ts = toEpoch(a?.createdAt);
    if (ts === null) return out;
    out.push({
      ts,
      kind: 'artifact',
      title: a.title || t('timeline.untitledArtifact'),
      subtitle: [a.subtitle, a.kind, a.lang].filter(Boolean).join(' · '),
      ref: { artifactId: a.id },
    });
    return out;
  }, []);
}

// ── Assembly (pure) ──────────────────────────────────────────────────────────

/**
 * Sort, window and group events into days, newest day first.
 *
 * @param {TimelineEvent[]} events
 * @param {Object} [opts]
 * @param {number} [opts.days=DEFAULT_DAYS] - how far back to keep
 * @param {number} [opts.now=Date.now()]    - injectable for tests
 * @returns {Array<{ key: string, ts: number, events: TimelineEvent[] }>}
 */
function groupByDay(events, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const kept = (events || [])
    .filter(e => e && Number.isFinite(e.ts) && e.ts >= cutoff && e.ts <= now)
    .sort((a, b) => (b.ts - a.ts) || (KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)));

  const groups = [];
  const byKey = new Map();
  for (const event of kept) {
    const key = dayKey(event.ts);
    let group = byKey.get(key);
    if (!group) {
      group = { key, ts: event.ts, events: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.events.push(event);
  }
  return groups;
}

/** Count events per kind, for the filter chips. */
function countByKind(events) {
  const counts = Object.fromEntries(KINDS.map(k => [k, 0]));
  for (const e of events || []) {
    if (e && Object.prototype.hasOwnProperty.call(counts, e.kind)) counts[e.kind]++;
  }
  return counts;
}

/**
 * Render the grouped timeline as Markdown, for pasting into a standup note or
 * a client report. Deliberately plain: no HTML, no custom blocks.
 *
 * @param {Array} groups - output of groupByDay
 * @param {Object} project - { name }
 * @returns {string}
 */
function toMarkdown(groups, project) {
  const lines = [`# ${project?.name || 'Project'} — ${t('timeline.title')}`, ''];
  if (!groups.length) {
    lines.push(t('timeline.empty'));
    return lines.join('\n');
  }
  for (const group of groups) {
    lines.push(`## ${new Date(group.ts).toLocaleDateString()}`, '');
    for (const e of group.events) {
      const label = kindLabel(e.kind);
      const tail = e.subtitle ? ` — ${e.subtitle}` : '';
      lines.push(`- \`${clockTime(e.ts)}\` **${label}** · ${e.title}${tail}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── Collection (IO) ──────────────────────────────────────────────────────────

/**
 * Load every source for a project and normalise the lot.
 *
 * Sources run in parallel and fail independently: the returned `failed` list
 * names the ones that errored so the view can say so, rather than silently
 * showing a shorter timeline than the truth.
 *
 * @param {Object} project - { id, path, name }
 * @param {Object} [opts]
 * @param {Array}  [opts.commitHistory] - reuse the dashboard's already-loaded
 *   500-commit history instead of paying for a second `git log`
 * @returns {Promise<{ events: TimelineEvent[], failed: string[] }>}
 */
async function collect(project, { commitHistory } = {}) {
  const failed = [];

  /** Run one source, attributing a failure to it rather than to the timeline. */
  const source = async (kind, load) => {
    try {
      return await load();
    } catch (e) {
      console.warn(`[Timeline] source "${kind}" failed:`, e && e.message);
      failed.push(kind);
      return [];
    }
  };

  const [commits, sessions, times, workflows, parallels, artifacts] = await Promise.all([
    source('commit', async () => normalizeCommits(
      Array.isArray(commitHistory)
        ? commitHistory
        : await api.git.commitHistory({ projectPath: project.path, skip: 0, limit: 300 })
    )),
    source('session', async () => normalizeSessions(await api.claude.sessions(project.path))),
    // Synchronous and local, but wrapped like the rest so a corrupt store
    // cannot take the view down with it.
    source('time', async () => normalizeTimeSessions(getProjectSessions(project.id))),
    source('workflow', async () => normalizeWorkflowRuns(
      await api.workflow.getRecentRuns(200), project.path
    )),
    source('parallel', async () => normalizeParallelRuns(
      await api.parallel.getHistory({ projectPath: project.path })
    )),
    source('artifact', async () => normalizeArtifacts(
      await api.artifacts.list({ projectId: project.id })
    )),
  ]);

  const events = [commits, sessions, times, workflows, parallels, artifacts]
    .flatMap(list => list.slice(0, MAX_PER_SOURCE));

  return { events, failed };
}

module.exports = {
  KINDS,
  DEFAULT_DAYS,
  collect,
  groupByDay,
  countByKind,
  toMarkdown,
  statusLabel,
  kindLabel,
  // exported for tests
  toEpoch,
  dayKey,
  dayLabel,
  clockTime,
  normalizeCommits,
  normalizeSessions,
  normalizeTimeSessions,
  normalizeWorkflowRuns,
  normalizeParallelRuns,
  normalizeArtifacts,
};
