/**
 * Time Tracking IPC Handler
 *
 * Reads ~/.claude-terminal/timetracking.json and archives from the main process.
 * Used by the workflow engine (WorkflowRunner) to query time stats without
 * needing to go through the renderer state.
 *
 * All duration values are in milliseconds.
 */

'use strict';

const { ipcMain } = require('electron');
const fs   = require('fs');
const path = require('path');
const { formatDuration } = require('../utils/formatDuration');
const os   = require('os');

const TIME_FILE = path.join(os.homedir(), '.claude-terminal', 'timetracking.json');
// Monthly archives, written by src/renderer/services/ArchiveService.js
const ARCHIVE_DIR = path.join(os.homedir(), '.claude-terminal', 'timetracking');
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

// ─── Date helpers (mirrors timeTracking.state.js) ────────────────────────────

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  // Monday = start of week, matching timeTracking.state.js. This used to
  // subtract d.getDay() (Sunday-first), so the workflow `time` node, the
  // time_week MCP tool and the dashboard reported different weeks — and on a
  // Sunday they shared no days at all.
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

/**
 * Format a Date as YYYY-MM-DD in LOCAL time.
 * toISOString() formats in UTC, which disagreed with the local-midnight bucket
 * boundaries and the local dayOfWeek label — east of UTC every bucket was
 * stamped with the previous calendar day.
 */
function localISODate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfMonth(ts) {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function clampDuration(start, end, periodStart, periodEnd) {
  const s = Math.max(start, periodStart);
  const e = Math.min(end, periodEnd);
  return e > s ? e - s : 0;
}

// ─── Data loading ─────────────────────────────────────────────────────────────

let _timeCache = null;
let _timeCacheAt = 0;

async function loadCurrentData() {
  const now = Date.now();
  if (_timeCache && now - _timeCacheAt < 2000) return _timeCache;
  try {
    const raw = await fs.promises.readFile(TIME_FILE, 'utf8');
    _timeCache = JSON.parse(raw);
    _timeCacheAt = now;
    return _timeCache;
  } catch {
    return { version: 3, month: null, global: { sessions: [] }, projects: {} };
  }
}

/**
 * Load a monthly archive (month is 0-based), normalized to
 * { global: sessions[], projects: { [id]: sessions[] } }. Archives come in two
 * shapes: a copy of timetracking.json (v3) and the older globalSessions /
 * projectSessions layout.
 */
async function loadArchive(year, month) {
  const file = path.join(ARCHIVE_DIR, String(year), `${MONTH_NAMES[month]}.json`);
  let data;
  try {
    data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
  const projects = {};
  if (data.globalSessions) {
    for (const [id, p] of Object.entries(data.projectSessions || {})) projects[id] = p.sessions || [];
    return { global: data.globalSessions, projects };
  }
  for (const [id, p] of Object.entries(data.projects || {})) projects[id] = p.sessions || [];
  return { global: data.global?.sessions || [], projects };
}

/**
 * The archive of the previous month when this week started in it, else null.
 * timetracking.json is reset on the 1st, so without this the week total fell
 * back to the days of the new month.
 */
async function loadWeekSpillover(now) {
  const weekStart = startOfWeek(now);
  if (weekStart >= startOfMonth(now)) return null;
  const d = new Date(weekStart);
  return loadArchive(d.getFullYear(), d.getMonth());
}

// ─── Stats computation ───────────────────────────────────────────────────────

/**
 * Compute today/week/month totals from a sessions array.
 * @param {Array} sessions
 * @param {number} now
 * @param {Array} [prevSessions] the archived previous month's sessions, counted
 *   toward the week only (total and month stay the current month's)
 */
function computePeriodTotals(sessions, now, prevSessions = []) {
  const todayStart  = startOfDay(now);
  const weekStart   = startOfWeek(now);
  const monthStart  = startOfMonth(now);
  const todayEnd    = now;

  let today = 0, week = 0, month = 0, total = 0;

  for (const s of sessions) {
    const start = new Date(s.startTime).getTime();
    const end   = new Date(s.endTime).getTime();
    const dur   = s.duration || (end - start);
    total += dur;
    today += clampDuration(start, end, todayStart, todayEnd);
    week  += clampDuration(start, end, weekStart,  todayEnd);
    month += clampDuration(start, end, monthStart, todayEnd);
  }
  for (const s of prevSessions) {
    week += clampDuration(new Date(s.startTime).getTime(), new Date(s.endTime).getTime(), weekStart, todayEnd);
  }

  return { today, week, month, total };
}

// ─── Action handlers ──────────────────────────────────────────────────────────

/**
 * action: 'get_today' — global stats for today, week, month.
 * Returns { today, week, month, todayFormatted, weekFormatted, monthFormatted,
 *           projects: [{ id, name, today, todayFormatted }] }
 */
function handleGetToday(data, prev) {
  const now = Date.now();
  const global = computePeriodTotals(data.global?.sessions || [], now, prev?.global);

  // Build per-project today totals
  const projects = [];
  for (const [id, proj] of Object.entries(data.projects || {})) {
    const t = computePeriodTotals(proj.sessions || [], now, prev?.projects[id]);
    if (t.today > 0) {
      projects.push({ id, today: t.today, todayFormatted: formatDuration(t.today) });
    }
  }
  projects.sort((a, b) => b.today - a.today);

  return {
    today:          global.today,
    week:           global.week,
    month:          global.month,
    todayFormatted: formatDuration(global.today),
    weekFormatted:  formatDuration(global.week),
    monthFormatted: formatDuration(global.month),
    projects,
  };
}

/**
 * action: 'get_week' — per-day breakdown for the current week.
 * Returns { total, totalFormatted, days: [{ date, ms, formatted }] }
 */
function handleGetWeek(data, prev) {
  const now = Date.now();
  const weekStart = startOfWeek(now);
  const sessions = (prev?.global || []).concat(data.global?.sessions || []);

  // Build 7-day buckets
  const days = [];
  for (let i = 0; i < 7; i++) {
    const dayStart = weekStart + i * 86_400_000;
    const dayEnd   = dayStart  + 86_400_000;
    let ms = 0;
    for (const s of sessions) {
      const start = new Date(s.startTime).getTime();
      const end   = new Date(s.endTime).getTime();
      ms += clampDuration(start, end, dayStart, dayEnd);
    }
    const d = new Date(dayStart);
    days.push({
      date:      localISODate(d),
      dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()],
      ms,
      formatted: formatDuration(ms),
    });
  }

  const total = days.reduce((acc, d) => acc + d.ms, 0);
  return { total, totalFormatted: formatDuration(total), days };
}

/**
 * action: 'get_project' — stats for a specific project.
 * Returns { id, today, week, month, total, todayFormatted, weekFormatted,
 *           monthFormatted, totalFormatted, sessionCount }
 */
function handleGetProject(data, projectId, prev) {
  if (!projectId) throw new Error('time node: get_project requires a projectId');
  const now = Date.now();
  const sessions = data.projects?.[projectId]?.sessions || [];
  const t = computePeriodTotals(sessions, now, prev?.projects[projectId]);

  return {
    id:             projectId,
    today:          t.today,
    week:           t.week,
    month:          t.month,
    total:          t.total,
    todayFormatted: formatDuration(t.today),
    weekFormatted:  formatDuration(t.week),
    monthFormatted: formatDuration(t.month),
    totalFormatted: formatDuration(t.total),
    sessionCount:   sessions.length,
  };
}

/**
 * action: 'get_all_projects' — stats for every tracked project.
 * Returns { projects: [{ id, today, week, total, todayFormatted, ... }] }
 * sorted by today desc.
 */
function handleGetAllProjects(data, prev) {
  const now = Date.now();
  const projects = [];

  for (const [id, proj] of Object.entries(data.projects || {})) {
    const t = computePeriodTotals(proj.sessions || [], now, prev?.projects[id]);
    projects.push({
      id,
      today:          t.today,
      week:           t.week,
      month:          t.month,
      total:          t.total,
      todayFormatted: formatDuration(t.today),
      weekFormatted:  formatDuration(t.week),
      monthFormatted: formatDuration(t.month),
      totalFormatted: formatDuration(t.total),
      sessionCount:   (proj.sessions || []).length,
    });
  }

  projects.sort((a, b) => b.today - a.today || b.total - a.total);
  return { projects, count: projects.length };
}

/**
 * action: 'get_sessions' — raw session list, filterable by projectId and date range.
 * config: { projectId?, startDate?, endDate? }
 * Returns { sessions: [...], count, totalMs, totalFormatted }
 */
function handleGetSessions(data, config) {
  const projectId = config.projectId || null;
  const startMs   = config.startDate ? new Date(config.startDate).getTime() : 0;
  const endMs     = config.endDate   ? new Date(config.endDate).getTime()   : Date.now();

  let rawSessions;
  if (projectId) {
    rawSessions = data.projects?.[projectId]?.sessions || [];
  } else {
    rawSessions = data.global?.sessions || [];
  }

  const sessions = rawSessions.filter(s => {
    const start = new Date(s.startTime).getTime();
    const end   = new Date(s.endTime).getTime();
    return end >= startMs && start <= endMs;
  }).map(s => ({
    startTime:  s.startTime,
    endTime:    s.endTime,
    duration:   s.duration || 0,
    formatted:  formatDuration(s.duration || 0),
    source:     s.source || null,
  }));

  const totalMs = sessions.reduce((acc, s) => acc + (s.duration || 0), 0);
  return { sessions, count: sessions.length, totalMs, totalFormatted: formatDuration(totalMs) };
}

// ─── Public API (also used directly by WorkflowRunner) ───────────────────────

/**
 * Query time stats — callable directly from main process without IPC round-trip.
 * @param {Object} config  { action, projectId?, startDate?, endDate? }
 */
async function getTimeStats(config = {}) {
  const data   = await loadCurrentData();
  const action = config.action || 'get_today';
  const prev   = action === 'get_sessions' ? null : await loadWeekSpillover(Date.now());

  switch (action) {
    case 'get_today':        return handleGetToday(data, prev);
    case 'get_week':         return handleGetWeek(data, prev);
    case 'get_project':      return handleGetProject(data, config.projectId, prev);
    case 'get_all_projects': return handleGetAllProjects(data, prev);
    case 'get_sessions':     return handleGetSessions(data, config);
    default:
      throw new Error(`Unknown time action: "${action}"`);
  }
}

// ─── IPC registration ─────────────────────────────────────────────────────────

function registerTimeHandlers() {
  /**
   * 'time:get-stats'
   * Unified entry point for all time tracking queries.
   * @param {Object} config  { action, projectId?, startDate?, endDate? }
   */
  ipcMain.handle('time:get-stats', async (_event, config = {}) => {
    try {
      return await getTimeStats(config);
    } catch (err) {
      return { error: err.message };
    }
  });
}

module.exports = { registerTimeHandlers, getTimeStats };
