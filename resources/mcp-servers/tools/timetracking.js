'use strict';

/**
 * Time Tracking Tools Module for Claude Terminal MCP
 *
 * Provides time tracking analytics. Reads from CT_DATA_DIR/timetracking.json
 * and CT_DATA_DIR/timetracking/YYYY/month.json archives.
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:timetracking] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function loadTimeTracking() {
  const file = path.join(getDataDir(), 'timetracking.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading timetracking.json:', e.message);
  }
  return { version: 3, month: '', global: { sessions: [] }, projects: {} };
}

function loadProjects() {
  const file = path.join(getDataDir(), 'projects.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return { projects: [] };
}

// -- Helpers ------------------------------------------------------------------

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function isToday(isoStr) {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

function isThisWeek(isoStr) {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  return d >= startOfWeek;
}

function sumDuration(sessions, filterFn) {
  return sessions
    .filter(s => !filterFn || filterFn(s.startTime || s.endTime))
    .reduce((sum, s) => sum + (s.duration || 0), 0);
}

// -- Archive helpers ----------------------------------------------------------

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

/**
 * Load an archive file for a given year and month (0-based).
 * Archives live at CT_DATA_DIR/timetracking/YYYY/monthname.json.
 * Normalizes both v1 and v3 formats into a consistent shape:
 *   { globalSessions: [], projectSessions: { pid: { projectName, sessions } } }
 */
function loadArchive(year, month) {
  const archiveDir = path.join(getDataDir(), 'timetracking');
  const filePath = path.join(archiveDir, String(year), `${MONTH_NAMES[month]}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeArchive(data);
  } catch (e) {
    log(`Error reading archive ${filePath}:`, e.message);
    return null;
  }
}

/**
 * Normalize archive data to a consistent v1-style shape.
 */
function normalizeArchive(data) {
  if (!data) return null;

  // v3 format: { global: { sessions }, projects: { pid: { sessions } } }
  if (data.version === 3 || (data.global && !data.globalSessions)) {
    const projectSessions = {};
    for (const [pid, pData] of Object.entries(data.projects || {})) {
      if (pData.sessions?.length > 0) {
        projectSessions[pid] = {
          projectName: pData.projectName || pid,
          sessions: pData.sessions
        };
      }
    }
    return {
      globalSessions: data.global?.sessions || [],
      projectSessions
    };
  }

  // v1 format: already has globalSessions / projectSessions
  return {
    globalSessions: data.globalSessions || [],
    projectSessions: data.projectSessions || {}
  };
}

/**
 * Collect all sessions (global + per-project) from the current timetracking.json,
 * optionally filtered by project name and/or date range.
 * Returns an array of { date, startTime, endTime, duration, project } objects.
 */
function collectAllSessions(tt, projectMap, filterProject, startDate, endDate) {
  const results = [];
  const startMs = startDate ? new Date(startDate + 'T00:00:00').getTime() : null;
  const endMs = endDate ? new Date(endDate + 'T23:59:59.999').getTime() : null;

  for (const [pid, pdata] of Object.entries(tt.projects || {})) {
    const projectName = projectMap.get(pid) || pid;

    // Filter by project name if specified
    if (filterProject && projectName.toLowerCase() !== filterProject.toLowerCase() &&
        pid.toLowerCase() !== filterProject.toLowerCase() &&
        !projectName.toLowerCase().includes(filterProject.toLowerCase())) {
      continue;
    }

    for (const s of (pdata.sessions || [])) {
      if (!s.startTime) continue;
      const sessionMs = new Date(s.startTime).getTime();
      if (startMs && sessionMs < startMs) continue;
      if (endMs && sessionMs > endMs) continue;

      results.push({
        date: s.startTime.slice(0, 10),
        startTime: s.startTime,
        endTime: s.endTime || '',
        duration: s.duration || 0,
        project: projectName
      });
    }
  }

  return results;
}

/**
 * Collect sessions from an archive, filtered similarly to collectAllSessions.
 */
function collectArchiveSessions(archive, projectMap, filterProject, startDate, endDate) {
  const results = [];
  if (!archive) return results;
  const startMs = startDate ? new Date(startDate + 'T00:00:00').getTime() : null;
  const endMs = endDate ? new Date(endDate + 'T23:59:59.999').getTime() : null;

  for (const [pid, pdata] of Object.entries(archive.projectSessions || {})) {
    const projectName = projectMap.get(pid) || pdata.projectName || pid;

    if (filterProject && projectName.toLowerCase() !== filterProject.toLowerCase() &&
        pid.toLowerCase() !== filterProject.toLowerCase() &&
        !projectName.toLowerCase().includes(filterProject.toLowerCase())) {
      continue;
    }

    for (const s of (pdata.sessions || [])) {
      if (!s.startTime) continue;
      const sessionMs = new Date(s.startTime).getTime();
      if (startMs && sessionMs < startMs) continue;
      if (endMs && sessionMs > endMs) continue;

      results.push({
        date: s.startTime.slice(0, 10),
        startTime: s.startTime,
        endTime: s.endTime || '',
        duration: s.duration || 0,
        project: projectName
      });
    }
  }

  return results;
}

/**
 * Get the start and end dates of a period relative to now.
 * Returns { start: Date, end: Date } for current and previous period.
 */
function getPeriodRange(period, offset) {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);

  if (period === 'day') {
    start.setDate(now.getDate() - offset);
    start.setHours(0, 0, 0, 0);
    end.setDate(now.getDate() - offset);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'week') {
    const dayOfWeek = now.getDay();
    start.setDate(now.getDate() - dayOfWeek - (offset * 7));
    start.setHours(0, 0, 0, 0);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'month') {
    start.setMonth(now.getMonth() - offset, 1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(start.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
  }

  return { start, end };
}

/**
 * Sum duration of sessions that fall within a date range.
 * Returns total ms and per-project breakdown.
 */
function sumSessionsInRange(sessions, rangeStart, rangeEnd) {
  let total = 0;
  const perProject = new Map();

  for (const s of sessions) {
    if (!s.startTime) continue;
    const t = new Date(s.startTime).getTime();
    if (t >= rangeStart.getTime() && t <= rangeEnd.getTime()) {
      const dur = s.duration || 0;
      total += dur;
      const proj = s.project || 'Unknown';
      perProject.set(proj, (perProject.get(proj) || 0) + dur);
    }
  }

  return { total, perProject };
}

/**
 * Find a project ID by name, basename, or exact ID match.
 */
function findProjectId(projData, query) {
  for (const p of (projData.projects || [])) {
    if (p.id === query ||
      (p.name || '').toLowerCase() === query.toLowerCase() ||
      path.basename(p.path || '').toLowerCase() === query.toLowerCase()) {
      return p.id;
    }
  }
  return null;
}

/**
 * Scan available archive months for a given year.
 * Returns array of { month (0-based), name, filePath } for archives that exist.
 */
function scanArchiveMonths(year) {
  const archiveDir = path.join(getDataDir(), 'timetracking');
  const yearDir = path.join(archiveDir, String(year));
  const found = [];

  if (!fs.existsSync(yearDir)) return found;

  try {
    const files = fs.readdirSync(yearDir);
    for (const file of files) {
      const name = file.replace('.json', '').toLowerCase();
      const monthIndex = MONTH_NAMES.indexOf(name);
      if (monthIndex >= 0) {
        found.push({ month: monthIndex, name: MONTH_NAMES[monthIndex], filePath: path.join(yearDir, file) });
      }
    }
  } catch (e) {
    log(`Error scanning archives for ${year}:`, e.message);
  }

  found.sort((a, b) => a.month - b.month);
  return found;
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'time_today',
    description: 'Get time spent today: total and per project breakdown.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'time_week',
    description: 'Get time spent this week: total and per project breakdown.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'time_project',
    description: 'Get detailed time tracking for a specific project: today, this week, this month, all time, and recent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'time_summary',
    description: 'Get a full time tracking summary: this month stats, top projects, daily breakdown for the last 7 days.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'time_export',
    description: 'Export time tracking data as CSV or JSON. Filterable by project and date range.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['csv', 'json'], description: 'Output format (default: csv)' },
        project: { type: 'string', description: 'Filter by project name (optional)' },
        start_date: { type: 'string', description: 'Start date filter YYYY-MM-DD (optional)' },
        end_date: { type: 'string', description: 'End date filter YYYY-MM-DD (optional)' },
      },
    },
  },
  {
    name: 'time_sessions',
    description: 'List raw time tracking sessions with start/end times and durations. Supports filtering by project and date.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Filter by project name (optional)' },
        date: { type: 'string', description: 'Filter by specific day YYYY-MM-DD (optional)' },
        limit: { type: 'number', description: 'Max sessions to return (default: 20, max: 100)' },
      },
    },
  },
  {
    name: 'time_compare',
    description: 'Compare time spent between two periods (e.g., this week vs last week).',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['day', 'week', 'month'], description: 'Period to compare (default: week)' },
      },
    },
  },
  {
    name: 'time_monthly',
    description: 'Get detailed monthly time tracking statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'Month in YYYY-MM format (defaults to current month)' },
      },
    },
  },
  {
    name: 'time_yearly',
    description: 'Get yearly time tracking overview from monthly archives.',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Year (defaults to current year)' },
      },
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    const tt = loadTimeTracking();
    const projData = loadProjects();
    const projectMap = new Map();
    for (const p of (projData.projects || [])) {
      projectMap.set(p.id, p.name || path.basename(p.path || p.id));
    }

    if (name === 'time_today') {
      const globalToday = sumDuration(tt.global?.sessions || [], isToday);

      const projectLines = [];
      for (const [pid, pdata] of Object.entries(tt.projects || {})) {
        const dur = sumDuration(pdata.sessions || [], isToday);
        if (dur > 0) {
          projectLines.push({ name: projectMap.get(pid) || pid, duration: dur });
        }
      }
      projectLines.sort((a, b) => b.duration - a.duration);

      let output = `Today: ${formatDuration(globalToday)}\n`;
      if (projectLines.length) {
        output += `${'─'.repeat(30)}\n`;
        for (const p of projectLines) {
          output += `  ${p.name}: ${formatDuration(p.duration)}\n`;
        }
      } else {
        output += 'No project activity tracked today.';
      }
      return ok(output);
    }

    if (name === 'time_week') {
      const globalWeek = sumDuration(tt.global?.sessions || [], isThisWeek);

      const projectLines = [];
      for (const [pid, pdata] of Object.entries(tt.projects || {})) {
        const dur = sumDuration(pdata.sessions || [], isThisWeek);
        if (dur > 0) {
          projectLines.push({ name: projectMap.get(pid) || pid, duration: dur });
        }
      }
      projectLines.sort((a, b) => b.duration - a.duration);

      let output = `This week: ${formatDuration(globalWeek)}\n`;
      if (projectLines.length) {
        output += `${'─'.repeat(30)}\n`;
        for (const p of projectLines) {
          output += `  ${p.name}: ${formatDuration(p.duration)}\n`;
        }
      } else {
        output += 'No project activity tracked this week.';
      }
      return ok(output);
    }

    if (name === 'time_project') {
      if (!args.project) return fail('Missing required parameter: project');

      // Find project
      let pid = null;
      for (const p of (projData.projects || [])) {
        if (p.id === args.project ||
          (p.name || '').toLowerCase() === args.project.toLowerCase() ||
          path.basename(p.path || '').toLowerCase() === args.project.toLowerCase()) {
          pid = p.id;
          break;
        }
      }
      if (!pid) return fail(`Project "${args.project}" not found.`);

      const pdata = tt.projects?.[pid];
      if (!pdata || !pdata.sessions?.length) {
        return ok(`No time tracked for ${projectMap.get(pid) || pid}.`);
      }

      const sessions = pdata.sessions;
      const today = sumDuration(sessions, isToday);
      const week = sumDuration(sessions, isThisWeek);
      const total = sumDuration(sessions);

      let output = `# ${projectMap.get(pid) || pid}\n`;
      output += `Today: ${formatDuration(today)}\n`;
      output += `This week: ${formatDuration(week)}\n`;
      output += `This month: ${formatDuration(total)}\n`;
      output += `Sessions: ${sessions.length}\n`;

      // Recent sessions (last 10)
      const recent = sessions
        .filter(s => s.startTime)
        .sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
        .slice(0, 10);

      if (recent.length) {
        output += `\n## Recent Sessions\n`;
        for (const s of recent) {
          const date = new Date(s.startTime).toLocaleString();
          output += `  ${date} — ${formatDuration(s.duration)}\n`;
        }
      }

      return ok(output);
    }

    if (name === 'time_summary') {
      const globalSessions = tt.global?.sessions || [];
      const monthTotal = sumDuration(globalSessions);
      const weekTotal = sumDuration(globalSessions, isThisWeek);
      const todayTotal = sumDuration(globalSessions, isToday);

      let output = `# Time Tracking Summary\n`;
      output += `Month (${tt.month || '?'}): ${formatDuration(monthTotal)}\n`;
      output += `This week: ${formatDuration(weekTotal)}\n`;
      output += `Today: ${formatDuration(todayTotal)}\n`;
      output += `Sessions: ${globalSessions.length}\n`;

      // Top projects this month
      const projectTotals = [];
      for (const [pid, pdata] of Object.entries(tt.projects || {})) {
        const dur = sumDuration(pdata.sessions || []);
        if (dur > 0) {
          projectTotals.push({ name: projectMap.get(pid) || pid, duration: dur });
        }
      }
      projectTotals.sort((a, b) => b.duration - a.duration);

      if (projectTotals.length) {
        output += `\n## Top Projects (this month)\n`;
        for (const p of projectTotals.slice(0, 15)) {
          const pct = monthTotal > 0 ? Math.round((p.duration / monthTotal) * 100) : 0;
          output += `  ${p.name}: ${formatDuration(p.duration)} (${pct}%)\n`;
        }
      }

      // Daily breakdown (last 7 days)
      const dailyMap = new Map();
      for (const s of globalSessions) {
        if (!s.startTime) continue;
        const day = s.startTime.slice(0, 10); // YYYY-MM-DD
        dailyMap.set(day, (dailyMap.get(day) || 0) + (s.duration || 0));
      }

      const days = [...dailyMap.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 7);

      if (days.length) {
        output += `\n## Last 7 Days\n`;
        for (const [day, dur] of days) {
          output += `  ${day}: ${formatDuration(dur)}\n`;
        }
      }

      return ok(output);
    }

    // -- time_export ------------------------------------------------------------

    if (name === 'time_export') {
      const format = args.format || 'csv';
      const filterProject = args.project || null;
      const startDate = args.start_date || null;
      const endDate = args.end_date || null;

      // Collect sessions from current timetracking.json
      let allSessions = collectAllSessions(tt, projectMap, filterProject, startDate, endDate);

      // Also collect from archives if a date range reaches into past months
      if (startDate) {
        const startD = new Date(startDate);
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        // Walk from startDate month to the month before current
        const cursor = new Date(startD.getFullYear(), startD.getMonth(), 1);
        const currentMonthDate = new Date(now.getFullYear(), now.getMonth(), 1);

        while (cursor < currentMonthDate) {
          const archive = loadArchive(cursor.getFullYear(), cursor.getMonth());
          if (archive) {
            const archiveSessions = collectArchiveSessions(archive, projectMap, filterProject, startDate, endDate);
            allSessions = allSessions.concat(archiveSessions);
          }
          cursor.setMonth(cursor.getMonth() + 1);
        }
      }

      // Sort by startTime ascending for export
      allSessions.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

      if (allSessions.length === 0) {
        return ok('No sessions found matching the specified filters.');
      }

      if (format === 'json') {
        const jsonData = allSessions.map(s => ({
          date: s.date,
          project: s.project,
          duration_minutes: Math.round(s.duration / 60000),
          start: s.startTime,
          end: s.endTime
        }));
        return ok(JSON.stringify(jsonData, null, 2));
      }

      // CSV format
      let csv = 'Date,Project,Duration (minutes),Start,End\n';
      for (const s of allSessions) {
        const durationMin = Math.round(s.duration / 60000);
        const projectName = s.project.replace(/,/g, ';'); // escape commas
        csv += `${s.date},${projectName},${durationMin},${s.startTime},${s.endTime}\n`;
      }
      return ok(csv);
    }

    // -- time_sessions ----------------------------------------------------------

    if (name === 'time_sessions') {
      const filterProject = args.project || null;
      const filterDate = args.date || null;
      const limit = Math.min(Math.max(args.limit || 20, 1), 100);

      // Collect sessions from current month
      const startDate = filterDate || null;
      const endDate = filterDate || null;
      let allSessions = collectAllSessions(tt, projectMap, filterProject, startDate, endDate);

      // Sort by startTime descending (most recent first)
      allSessions.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));

      // Apply limit
      const limited = allSessions.slice(0, limit);

      if (limited.length === 0) {
        return ok('No sessions found matching the specified filters.');
      }

      let output = `# Sessions (${limited.length}${allSessions.length > limit ? ` of ${allSessions.length}` : ''})\n\n`;

      for (const s of limited) {
        const startDt = new Date(s.startTime);
        const dateStr = startDt.toLocaleDateString();
        const startTimeStr = startDt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const endTimeStr = s.endTime
          ? new Date(s.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '?';
        output += `  ${dateStr}  ${startTimeStr} - ${endTimeStr}  ${formatDuration(s.duration).padStart(7)}  ${s.project}\n`;
      }

      const totalDuration = limited.reduce((sum, s) => sum + s.duration, 0);
      output += `\n${'─'.repeat(50)}\n`;
      output += `Total: ${formatDuration(totalDuration)} across ${limited.length} session(s)\n`;

      return ok(output);
    }

    // -- time_compare -----------------------------------------------------------

    if (name === 'time_compare') {
      const period = args.period || 'week';
      const periodLabels = { day: 'Today vs Yesterday', week: 'This Week vs Last Week', month: 'This Month vs Last Month' };

      // Get current and previous period ranges
      const current = getPeriodRange(period, 0);
      const previous = getPeriodRange(period, 1);

      // Collect all sessions from current timetracking.json (flat list with project names)
      const allSessions = collectAllSessions(tt, projectMap, null, null, null);

      // Also check archives for the previous period if it spans a different month
      const prevMonth = previous.start.getMonth();
      const prevYear = previous.start.getFullYear();
      const now = new Date();
      if (prevYear !== now.getFullYear() || prevMonth !== now.getMonth()) {
        const archive = loadArchive(prevYear, prevMonth);
        if (archive) {
          const archiveSessions = collectArchiveSessions(archive, projectMap, null, null, null);
          allSessions.push(...archiveSessions);
        }
      }

      const currentStats = sumSessionsInRange(allSessions, current.start, current.end);
      const previousStats = sumSessionsInRange(allSessions, previous.start, previous.end);

      const diff = currentStats.total - previousStats.total;
      const pctChange = previousStats.total > 0
        ? Math.round((diff / previousStats.total) * 100)
        : (currentStats.total > 0 ? 100 : 0);
      const sign = diff >= 0 ? '+' : '';

      let output = `# ${periodLabels[period]}\n\n`;
      output += `Current period:  ${formatDuration(currentStats.total)}\n`;
      output += `Previous period: ${formatDuration(previousStats.total)}\n`;
      output += `Difference:      ${sign}${formatDuration(Math.abs(diff))} (${sign}${pctChange}%)\n`;

      // Per-project comparison
      const allProjects = new Set([
        ...currentStats.perProject.keys(),
        ...previousStats.perProject.keys()
      ]);

      if (allProjects.size > 0) {
        output += `\n## Per Project\n`;
        output += `${'Project'.padEnd(30)} ${'Current'.padStart(10)} ${'Previous'.padStart(10)} ${'Change'.padStart(10)}\n`;
        output += `${'─'.repeat(62)}\n`;

        const projectRows = [];
        for (const proj of allProjects) {
          const cur = currentStats.perProject.get(proj) || 0;
          const prev = previousStats.perProject.get(proj) || 0;
          projectRows.push({ name: proj, current: cur, previous: prev, diff: cur - prev });
        }
        projectRows.sort((a, b) => b.current - a.current);

        for (const row of projectRows) {
          const diffSign = row.diff >= 0 ? '+' : '';
          output += `${row.name.padEnd(30)} ${formatDuration(row.current).padStart(10)} ${formatDuration(row.previous).padStart(10)} ${(diffSign + formatDuration(Math.abs(row.diff))).padStart(10)}\n`;
        }
      }

      return ok(output);
    }

    // -- time_monthly -----------------------------------------------------------

    if (name === 'time_monthly') {
      const now = new Date();
      let targetYear = now.getFullYear();
      let targetMonth = now.getMonth(); // 0-based
      let monthLabel = '';

      if (args.month) {
        const parts = args.month.split('-');
        if (parts.length !== 2) return fail('Invalid month format. Use YYYY-MM (e.g., 2026-03).');
        targetYear = parseInt(parts[0], 10);
        targetMonth = parseInt(parts[1], 10) - 1; // convert to 0-based
        if (isNaN(targetYear) || isNaN(targetMonth) || targetMonth < 0 || targetMonth > 11) {
          return fail('Invalid month format. Use YYYY-MM (e.g., 2026-03).');
        }
      }

      monthLabel = `${MONTH_NAMES[targetMonth].charAt(0).toUpperCase() + MONTH_NAMES[targetMonth].slice(1)} ${targetYear}`;

      // Determine data source: current month from timetracking.json, past months from archives
      const isCurrentMonth = targetYear === now.getFullYear() && targetMonth === now.getMonth();

      let globalSessions = [];
      let projectSessions = {}; // pid -> { projectName, sessions }

      if (isCurrentMonth) {
        globalSessions = tt.global?.sessions || [];
        for (const [pid, pdata] of Object.entries(tt.projects || {})) {
          if (pdata.sessions?.length > 0) {
            projectSessions[pid] = {
              projectName: projectMap.get(pid) || pid,
              sessions: pdata.sessions
            };
          }
        }
      } else {
        const archive = loadArchive(targetYear, targetMonth);
        if (!archive) {
          return ok(`No data found for ${monthLabel}.`);
        }
        globalSessions = archive.globalSessions || [];
        projectSessions = archive.projectSessions || {};
      }

      // Calculate stats
      const totalMs = globalSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
      const sessionCount = globalSessions.length;

      // Daily breakdown
      const dailyMap = new Map();
      for (const s of globalSessions) {
        if (!s.startTime) continue;
        const day = s.startTime.slice(0, 10);
        dailyMap.set(day, (dailyMap.get(day) || 0) + (s.duration || 0));
      }
      const workingDays = dailyMap.size;
      const avgPerDay = workingDays > 0 ? Math.round(totalMs / workingDays) : 0;

      let output = `# ${monthLabel}\n\n`;
      output += `Total time:    ${formatDuration(totalMs)}\n`;
      output += `Working days:  ${workingDays}\n`;
      output += `Avg per day:   ${formatDuration(avgPerDay)}\n`;
      output += `Sessions:      ${sessionCount}\n`;

      // Top projects
      const projectTotals = [];
      for (const [pid, pdata] of Object.entries(projectSessions)) {
        const dur = (pdata.sessions || []).reduce((sum, s) => sum + (s.duration || 0), 0);
        if (dur > 0) {
          const projectName = projectMap.get(pid) || pdata.projectName || pid;
          projectTotals.push({ name: projectName, duration: dur });
        }
      }
      projectTotals.sort((a, b) => b.duration - a.duration);

      if (projectTotals.length) {
        output += `\n## Top Projects\n`;
        for (const p of projectTotals.slice(0, 15)) {
          const pct = totalMs > 0 ? Math.round((p.duration / totalMs) * 100) : 0;
          output += `  ${p.name}: ${formatDuration(p.duration)} (${pct}%)\n`;
        }
      }

      // Daily breakdown (all days, sorted)
      const sortedDays = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      if (sortedDays.length) {
        output += `\n## Daily Breakdown\n`;
        for (const [day, dur] of sortedDays) {
          const dayName = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
          output += `  ${day} (${dayName}): ${formatDuration(dur)}\n`;
        }
      }

      return ok(output);
    }

    // -- time_yearly ------------------------------------------------------------

    if (name === 'time_yearly') {
      const now = new Date();
      const targetYear = args.year || now.getFullYear();

      // Scan for all archive months in the target year
      const archiveMonths = scanArchiveMonths(targetYear);

      // Check if current month belongs to the target year (use live data)
      const isCurrentYear = targetYear === now.getFullYear();

      let grandTotalMs = 0;
      const monthlyData = []; // { month, name, totalMs, projectTotals }
      const yearProjectTotals = new Map(); // projectName -> total ms

      // Process archived months
      for (const am of archiveMonths) {
        // Skip current month in archives if we have live data
        if (isCurrentYear && am.month === now.getMonth()) continue;

        const archive = loadArchive(targetYear, am.month);
        if (!archive) continue;

        const monthTotalMs = (archive.globalSessions || []).reduce((sum, s) => sum + (s.duration || 0), 0);
        grandTotalMs += monthTotalMs;

        const projectTotals = new Map();
        for (const [pid, pdata] of Object.entries(archive.projectSessions || {})) {
          const dur = (pdata.sessions || []).reduce((sum, s) => sum + (s.duration || 0), 0);
          if (dur > 0) {
            const projectName = projectMap.get(pid) || pdata.projectName || pid;
            projectTotals.set(projectName, (projectTotals.get(projectName) || 0) + dur);
            yearProjectTotals.set(projectName, (yearProjectTotals.get(projectName) || 0) + dur);
          }
        }

        const label = MONTH_NAMES[am.month].charAt(0).toUpperCase() + MONTH_NAMES[am.month].slice(1);
        monthlyData.push({ month: am.month, name: label, totalMs: monthTotalMs, projectTotals });
      }

      // Add current month from live data if it's the target year
      if (isCurrentYear) {
        const globalSessions = tt.global?.sessions || [];
        const currentMonthMs = globalSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
        grandTotalMs += currentMonthMs;

        const projectTotals = new Map();
        for (const [pid, pdata] of Object.entries(tt.projects || {})) {
          const dur = (pdata.sessions || []).reduce((sum, s) => sum + (s.duration || 0), 0);
          if (dur > 0) {
            const projectName = projectMap.get(pid) || pid;
            projectTotals.set(projectName, (projectTotals.get(projectName) || 0) + dur);
            yearProjectTotals.set(projectName, (yearProjectTotals.get(projectName) || 0) + dur);
          }
        }

        const label = MONTH_NAMES[now.getMonth()].charAt(0).toUpperCase() + MONTH_NAMES[now.getMonth()].slice(1);
        monthlyData.push({ month: now.getMonth(), name: `${label} (current)`, totalMs: currentMonthMs, projectTotals });
      }

      // Sort months chronologically
      monthlyData.sort((a, b) => a.month - b.month);

      if (monthlyData.length === 0) {
        return ok(`No time tracking data found for ${targetYear}.`);
      }

      let output = `# ${targetYear} Overview\n\n`;
      output += `Total: ${formatDuration(grandTotalMs)}\n`;
      output += `Months with data: ${monthlyData.length}\n`;
      const avgPerMonth = monthlyData.length > 0 ? Math.round(grandTotalMs / monthlyData.length) : 0;
      output += `Average per month: ${formatDuration(avgPerMonth)}\n`;

      // Monthly breakdown
      output += `\n## Monthly Breakdown\n`;
      for (const md of monthlyData) {
        const pct = grandTotalMs > 0 ? Math.round((md.totalMs / grandTotalMs) * 100) : 0;
        output += `  ${md.name.padEnd(20)} ${formatDuration(md.totalMs).padStart(8)} (${String(pct).padStart(2)}%)\n`;
      }

      // Top projects across the year
      const topProjects = [...yearProjectTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);

      if (topProjects.length) {
        output += `\n## Top Projects (${targetYear})\n`;
        for (const [name, dur] of topProjects) {
          const pct = grandTotalMs > 0 ? Math.round((dur / grandTotalMs) * 100) : 0;
          output += `  ${name}: ${formatDuration(dur)} (${pct}%)\n`;
        }
      }

      return ok(output);
    }

    return fail(`Unknown time tracking tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Time tracking error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
