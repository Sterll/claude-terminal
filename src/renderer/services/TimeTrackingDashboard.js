/**
 * Time Tracking Dashboard Service
 * Renders a detailed time tracking dashboard with charts, stats, and project breakdown
 */

const { projectsState, getGlobalTimes, getProjectTimes, getProjectSessions, getGlobalTrackingData, getSetting, setSetting } = require('../state');
const { escapeHtml } = require('../utils');
const { sanitizeColor } = require('../utils/color');
const { formatDuration, formatDurationLarge } = require('../utils/format');
const { t } = require('../i18n');
const ArchiveService = require('./ArchiveService');

// Current state
let currentPeriod = 'week'; // 'day', 'week', 'month', 'custom'
let currentOffset = 0; // 0 = current period, -1 = previous, etc.
let customStartDate = null;
let customEndDate = null;
let updateInterval = null;
let calendarPopup = null;
let calendarOutsideClickHandler = null;
let calendarEscHandler = null;
let calendarListenerTimer = null;
let goalPopup = null;
let goalOutsideClickHandler = null;

/**
 * Get period label based on current period and offset
 */
function getPeriodLabel() {
  const now = new Date();
  const locale = t('language.code') === 'fr' ? 'fr-FR' : 'en-US';

  if (currentPeriod === 'custom' && customStartDate && customEndDate) {
    const startLabel = customStartDate.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    const endDate = new Date(customEndDate);
    endDate.setDate(endDate.getDate() - 1);
    const endLabel = endDate.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
    return `${startLabel} - ${endLabel}`;
  }

  if (currentPeriod === 'day') {
    const date = new Date(now);
    date.setDate(date.getDate() + currentOffset);
    if (currentOffset === 0) return t('timetracking.today');
    if (currentOffset === -1) return t('timetracking.yesterday');
    return date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  if (currentPeriod === 'week') {
    if (currentOffset === 0) return t('timetracking.thisWeek');
    if (currentOffset === -1) return t('timetracking.lastWeek');
    const weekStart = getWeekStart(currentOffset);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    return `${weekStart.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} - ${weekEnd.toLocaleDateString(locale, { day: 'numeric', month: 'short' })}`;
  }

  if (currentPeriod === 'month') {
    const date = new Date(now.getFullYear(), now.getMonth() + currentOffset, 1);
    if (currentOffset === 0) return t('timetracking.thisMonth');
    if (currentOffset === -1) return t('timetracking.lastMonth');
    return date.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  }

  return '';
}

/**
 * Get the start of a week with offset
 */
function getWeekStart(offset = 0) {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(monday.getDate() - diff + (offset * 7));
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/**
 * Get period boundaries
 */
function getPeriodBoundaries() {
  const now = new Date();
  let periodStart, periodEnd;

  if (currentPeriod === 'custom' && customStartDate && customEndDate) {
    return { periodStart: new Date(customStartDate), periodEnd: new Date(customEndDate) };
  }

  if (currentPeriod === 'day') {
    periodStart = new Date(now);
    periodStart.setDate(periodStart.getDate() + currentOffset);
    periodStart.setHours(0, 0, 0, 0);
    periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + 1);
  } else if (currentPeriod === 'week') {
    periodStart = getWeekStart(currentOffset);
    periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + 7);
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth() + currentOffset, 1);
    periodEnd = new Date(now.getFullYear(), now.getMonth() + currentOffset + 1, 1);
  }

  return { periodStart, periodEnd };
}

/**
 * Get sessions for current period from all projects
 * Merges consecutive sessions from the same project if gap < 30min
 */
async function getSessionsForPeriod() {
  const projects = projectsState.get().projects;
  const { periodStart, periodEnd } = getPeriodBoundaries();
  const allSessions = [];
  const months = ArchiveService.getMonthsInRange(periodStart, periodEnd);

  for (const { year, month } of months) {
    if (ArchiveService.isCurrentMonth(year, month)) {
      // Current month: read from live state
      for (const project of projects) {
        const sessions = getProjectSessions(project.id);
        if (!sessions.length) continue;
        for (const session of sessions) {
          const sessionDate = new Date(session.startTime);
          if (sessionDate >= periodStart && sessionDate < periodEnd) {
            allSessions.push({
              ...session,
              projectId: project.id,
              projectName: project.name,
              projectColor: project.color || '#d97706'
            });
          }
        }
      }
    } else {
      // Past months: read from archive
      const archivedProjects = await ArchiveService.getArchivedAllProjectSessions(year, month);
      for (const [projectId, data] of Object.entries(archivedProjects)) {
        const liveProject = projects.find(p => p.id === projectId);
        for (const session of data.sessions) {
          const sessionDate = new Date(session.startTime);
          if (sessionDate >= periodStart && sessionDate < periodEnd) {
            allSessions.push({
              ...session,
              projectId,
              projectName: liveProject?.name || data.projectName,
              projectColor: liveProject?.color || '#d97706'
            });
          }
        }
      }
    }
  }

  // Sort by start time ascending for merging
  allSessions.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  // Merge consecutive sessions from the same project (gap < 30min)
  const MERGE_GAP = 30 * 60 * 1000; // 30 minutes
  const mergedSessions = [];

  for (const session of allSessions) {
    const last = mergedSessions[mergedSessions.length - 1];

    if (last && last.projectId === session.projectId) {
      const gap = new Date(session.startTime) - new Date(last.endTime);
      if (gap < MERGE_GAP) {
        // Merge: extend the last session
        last.endTime = session.endTime;
        last.duration += session.duration;
        continue;
      }
    }

    mergedSessions.push({ ...session });
  }

  // Sort by start time descending for display
  mergedSessions.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  return { sessions: mergedSessions, periodStart, periodEnd };
}

/**
 * Get global sessions for current period
 */
async function getGlobalSessionsForPeriod() {
  const { periodStart, periodEnd } = getPeriodBoundaries();
  const months = ArchiveService.getMonthsInRange(periodStart, periodEnd);
  let allSessions = [];

  for (const { year, month } of months) {
    if (ArchiveService.isCurrentMonth(year, month)) {
      const globalTracking = getGlobalTrackingData();
      if (globalTracking?.sessions) {
        allSessions = allSessions.concat(globalTracking.sessions);
      }
    } else {
      const archived = await ArchiveService.getArchivedGlobalSessions(year, month);
      allSessions = allSessions.concat(archived);
    }
  }

  return allSessions.filter(session => {
    const sessionDate = new Date(session.startTime);
    return sessionDate >= periodStart && sessionDate < periodEnd;
  });
}

/**
 * Get the total time for current period
 * Uses global counters for current period (more accurate), sessions for past periods
 */
async function getTotalTimeForPeriod() {
  const globalTimes = getGlobalTimes();

  // For current period (offset === 0), use global counters as they're more accurate
  if (currentOffset === 0) {
    if (currentPeriod === 'day') return globalTimes.today;
    if (currentPeriod === 'week') return globalTimes.week;
    if (currentPeriod === 'month') return globalTimes.month;
  }

  // For past periods, calculate from global sessions
  const globalSessions = await getGlobalSessionsForPeriod();
  return globalSessions.reduce((sum, s) => sum + (s.duration || 0), 0);
}

/**
 * Calculate time by project for current period
 */
async function getTimeByProject() {
  const { sessions } = await getSessionsForPeriod();
  const projectTimes = new Map();

  for (const session of sessions) {
    const current = projectTimes.get(session.projectId) || {
      id: session.projectId,
      name: session.projectName,
      color: session.projectColor,
      time: 0,
      sessions: 0
    };
    current.time += session.duration || 0;
    current.sessions += 1;
    projectTimes.set(session.projectId, current);
  }

  return Array.from(projectTimes.values()).sort((a, b) => b.time - a.time);
}

/**
 * Calculate daily data for chart using global sessions
 */
async function getDailyData() {
  const globalSessions = await getGlobalSessionsForPeriod();
  const { periodStart, periodEnd } = getPeriodBoundaries();
  const days = [];
  const locale = t('language.code') === 'fr' ? 'fr-FR' : 'en-US';
  // Get localized short day names
  const getDayName = (date) => date.toLocaleDateString(locale, { weekday: 'short' });

  if (currentPeriod === 'day') {
    // For day view, group by 2-hour blocks (12 bars)
    for (let h = 0; h < 24; h += 2) {
      days.push({
        date: new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate(), h),
        label: `${h}h`,
        time: 0
      });
    }
  } else if (currentPeriod === 'week') {
    // 7 days
    const current = new Date(periodStart);
    while (current < periodEnd) {
      days.push({
        date: new Date(current),
        label: getDayName(current),
        time: 0
      });
      current.setDate(current.getDate() + 1);
    }
  } else if (currentPeriod === 'custom') {
    const totalDays = Math.ceil((periodEnd - periodStart) / (24 * 60 * 60 * 1000));
    if (totalDays <= 31) {
      // One bar per day
      const current = new Date(periodStart);
      while (current < periodEnd) {
        days.push({
          date: new Date(current),
          label: current.getDate().toString(),
          time: 0
        });
        current.setDate(current.getDate() + 1);
      }
    } else {
      // One bar per week
      const current = new Date(periodStart);
      while (current < periodEnd) {
        const weekEnd = new Date(current);
        weekEnd.setDate(weekEnd.getDate() + 7);
        days.push({
          date: new Date(current),
          label: current.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
          time: 0
        });
        current.setDate(current.getDate() + 7);
      }
    }
  } else {
    // Month view - show each day
    const current = new Date(periodStart);
    while (current < periodEnd) {
      days.push({
        date: new Date(current),
        label: current.getDate().toString(),
        time: 0
      });
      current.setDate(current.getDate() + 1);
    }
  }

  // Fill in times from global sessions
  for (const session of globalSessions) {
    const sessionDate = new Date(session.startTime);
    let dayIndex;

    if (currentPeriod === 'day') {
      dayIndex = Math.floor(sessionDate.getHours() / 2);
    } else if (currentPeriod === 'custom' && Math.ceil((periodEnd - periodStart) / (24 * 60 * 60 * 1000)) > 31) {
      dayIndex = Math.floor((sessionDate - periodStart) / (7 * 24 * 60 * 60 * 1000));
    } else {
      dayIndex = Math.floor((sessionDate - periodStart) / (24 * 60 * 60 * 1000));
    }

    if (dayIndex >= 0 && dayIndex < days.length) {
      days[dayIndex].time += session.duration || 0;
    }
  }

  return days;
}

/**
 * Calculate streak (consecutive days with activity)
 */
async function calculateStreak() {
  const globalTracking = getGlobalTrackingData();
  const activeDays = new Set();

  // Current month sessions from live state
  if (globalTracking?.sessions) {
    for (const session of globalTracking.sessions) {
      const date = new Date(session.startTime);
      activeDays.add(date.toDateString());
    }
  }

  // Load previous month archive for cross-month streaks
  const now = new Date();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevSessions = await ArchiveService.getArchivedGlobalSessions(
    prevMonth.getFullYear(), prevMonth.getMonth()
  );
  for (const session of prevSessions) {
    activeDays.add(new Date(session.startTime).toDateString());
  }

  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check if today has activity
  if (activeDays.has(today.toDateString())) {
    streak = 1;
  } else {
    // Check yesterday - if no activity yesterday either, streak is 0
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (!activeDays.has(yesterday.toDateString())) {
      return 0;
    }
    // Start counting from yesterday
    streak = 1;
  }

  // Count consecutive days backwards
  const checkDate = new Date(today);
  if (!activeDays.has(today.toDateString())) {
    checkDate.setDate(checkDate.getDate() - 1);
  }

  while (true) {
    checkDate.setDate(checkDate.getDate() - 1);
    if (activeDays.has(checkDate.toDateString())) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}

/**
 * Get most active project for current period
 */
async function getMostActiveProject() {
  const projectBreakdown = await getTimeByProject();
  if (projectBreakdown.length === 0) return null;

  const top = projectBreakdown[0];
  const projects = projectsState.get().projects;
  const project = projects.find(p => p.id === top.id);

  return project ? { project, time: top.time } : null;
}

/**
 * Calculate average daily time for current period
 */
async function getAverageDailyTime() {
  const dailyData = await getDailyData();
  const activeDays = dailyData.filter(d => d.time > 0);
  if (activeDays.length === 0) return 0;

  const totalTime = activeDays.reduce((sum, d) => sum + d.time, 0);
  return totalTime / activeDays.length;
}

/**
 * Get session count for current period
 */
async function getSessionCount() {
  const globalSessions = await getGlobalSessionsForPeriod();
  return globalSessions.length;
}

/**
 * Get day-specific stats (first/last session times)
 */
async function getDayStats() {
  const globalSessions = await getGlobalSessionsForPeriod();
  if (globalSessions.length === 0) {
    return { firstSession: null, lastSession: null, projectCount: 0 };
  }

  // Sort by start time
  const sorted = [...globalSessions].sort((a, b) =>
    new Date(a.startTime) - new Date(b.startTime)
  );

  const firstSession = new Date(sorted[0].startTime);
  const lastSession = new Date(sorted[sorted.length - 1].endTime);

  // Count unique projects
  const { sessions } = await getSessionsForPeriod();
  const uniqueProjects = new Set(sessions.map(s => s.projectId));

  return { firstSession, lastSession, projectCount: uniqueProjects.size };
}

/**
 * Get total time for the previous equivalent period
 * Day → yesterday, Week → last week, Month → last month
 */
async function getPreviousPeriodTime() {
  if (currentPeriod === 'custom') return null;

  const savedOffset = currentOffset;
  currentOffset = savedOffset - 1;
  const prevTime = await getTotalTimeForPeriod();
  currentOffset = savedOffset;
  return prevTime;
}

/**
 * Close the goal config popup
 */
function closeGoalPopup() {
  if (goalOutsideClickHandler) {
    document.removeEventListener('mousedown', goalOutsideClickHandler);
    goalOutsideClickHandler = null;
  }
  if (goalPopup) {
    goalPopup.remove();
    goalPopup = null;
  }
}

/**
 * Show goal configuration popup
 */
function showGoalConfigPopup(container, anchorEl) {
  if (goalPopup) {
    closeGoalPopup();
    return;
  }

  const currentGoal = getSetting('dailyGoal') || 0;
  const popup = document.createElement('div');
  popup.className = 'tt-goal-popup';
  goalPopup = popup;

  const presets = [
    { label: '2h', value: 120 },
    { label: '4h', value: 240 },
    { label: '6h', value: 360 },
    { label: '8h', value: 480 },
  ];

  popup.innerHTML = `
    <div class="tt-goal-popup-title">${t('timetracking.goalTitle')}</div>
    <div class="tt-goal-popup-desc">${t('timetracking.goalDesc')}</div>
    <div class="tt-goal-input-row">
      <input type="number" class="tt-goal-input" id="tt-goal-input" min="0" max="1440" step="15" value="${currentGoal || ''}" placeholder="0">
      <span class="tt-goal-input-unit">${t('timetracking.goalMinutes')}</span>
    </div>
    <div class="tt-goal-presets">
      ${presets.map(p => `<button class="tt-goal-preset-btn ${currentGoal === p.value ? 'active' : ''}" data-value="${p.value}">${p.label}</button>`).join('')}
    </div>
    <div class="tt-goal-actions">
      <button class="tt-goal-disable-btn" id="tt-goal-disable">${t('timetracking.goalDisable')}</button>
      <button class="tt-goal-apply-btn" id="tt-goal-apply">${t('timetracking.goalApply')}</button>
    </div>
  `;

  anchorEl.appendChild(popup);

  // Preset buttons
  popup.querySelectorAll('.tt-goal-preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = parseInt(btn.dataset.value);
      popup.querySelector('#tt-goal-input').value = val;
      popup.querySelectorAll('.tt-goal-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Input change clears preset active
  popup.querySelector('#tt-goal-input')?.addEventListener('input', () => {
    popup.querySelectorAll('.tt-goal-preset-btn').forEach(b => b.classList.remove('active'));
  });

  // Disable
  popup.querySelector('#tt-goal-disable')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    setSetting('dailyGoal', 0);
    closeGoalPopup();
    await render(container);
  });

  // Apply
  popup.querySelector('#tt-goal-apply')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const val = parseInt(popup.querySelector('#tt-goal-input')?.value) || 0;
    setSetting('dailyGoal', Math.max(0, Math.min(1440, val)));
    closeGoalPopup();
    await render(container);
  });

  // Outside click
  setTimeout(() => {
    goalOutsideClickHandler = (e) => {
      if (goalPopup && !goalPopup.contains(e.target) && !e.target.closest('.tt-goal-btn')) {
        closeGoalPopup();
      }
    };
    document.addEventListener('mousedown', goalOutsideClickHandler);
  }, 0);
}

/**
 * Export time tracking data for the current period
 * @param {'csv'|'json'} format
 */
async function exportData(format) {
  const { sessions, periodStart, periodEnd } = await getSessionsForPeriod();
  const periodLabel = getPeriodLabel();
  const locale = t('language.code') === 'fr' ? 'fr-FR' : 'en-US';
  const dateStr = new Date().toISOString().slice(0, 10);
  const defaultName = `timetracking-${dateStr}.${format}`;

  if (format === 'csv') {
    const header = 'Date,Project,Duration (hours),Duration (formatted),Session Start,Session End';
    const rows = sessions.map(s => {
      const startDate = new Date(s.startTime);
      const endDate = new Date(s.endTime);
      const durationHours = (s.duration / 3600000).toFixed(2);
      const durationFormatted = formatDuration(s.duration);
      return [
        startDate.toLocaleDateString(locale),
        `"${(s.projectName || '').replace(/"/g, '""')}"`,
        durationHours,
        durationFormatted,
        startDate.toISOString(),
        endDate.toISOString()
      ].join(',');
    });

    const csvContent = [header, ...rows].join('\n');
    const filePath = await window.electron_api.dialog.saveFileDialog({
      defaultPath: defaultName,
      title: t('timetracking.exportTitle'),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });

    if (filePath) {
      const { fs } = window.electron_nodeModules;
      await fs.promises.writeFile(filePath, '\uFEFF' + csvContent, 'utf8');
    }
  } else {
    const totalDuration = sessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const jsonData = {
      metadata: {
        exportedAt: new Date().toISOString(),
        period: periodLabel,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        totalSessions: sessions.length,
        totalDuration,
        totalDurationFormatted: formatDuration(totalDuration)
      },
      sessions: sessions.map(s => ({
        project: s.projectName,
        projectId: s.projectId,
        startTime: s.startTime,
        endTime: s.endTime,
        duration: s.duration,
        durationHours: parseFloat((s.duration / 3600000).toFixed(2)),
        durationFormatted: formatDuration(s.duration)
      }))
    };

    const filePath = await window.electron_api.dialog.saveFileDialog({
      defaultPath: defaultName,
      title: t('timetracking.exportTitle'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });

    if (filePath) {
      const { fs } = window.electron_nodeModules;
      await fs.promises.writeFile(filePath, JSON.stringify(jsonData, null, 2), 'utf8');
    }
  }
}

/**
 * Render the time tracking dashboard
 */
async function render(container) {
  const globalTimes = getGlobalTimes();
  const totalPeriodTime = await getTotalTimeForPeriod();
  const { hours, minutes } = formatDurationLarge(totalPeriodTime);
  const projectBreakdown = await getTimeByProject();
  const dailyData = await getDailyData();
  const maxDailyTime = Math.max(...dailyData.map(d => d.time), 1);
  const streak = await calculateStreak();
  const mostActive = await getMostActiveProject();
  const avgDaily = await getAverageDailyTime();
  const sessionCount = await getSessionCount();
  const { sessions: projectSessions } = await getSessionsForPeriod();
  const dayStats = await getDayStats();
  const locale = t('language.code') === 'fr' ? 'fr-FR' : 'en-US';

  // Calculate percentages based on project time breakdown
  const totalProjectTime = projectBreakdown.reduce((sum, p) => sum + p.time, 0);

  // Daily goal
  const dailyGoal = getSetting('dailyGoal') || 0;
  const todayTimeMs = getGlobalTimes().today;
  const goalProgressPercent = dailyGoal > 0 ? Math.min(100, Math.round((todayTimeMs / (dailyGoal * 60000)) * 100)) : 0;
  const goalReached = goalProgressPercent >= 100;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 54; // r=54

  // Period comparison
  const prevPeriodTime = await getPreviousPeriodTime();
  let comparisonHtml = '';
  if (prevPeriodTime !== null && currentPeriod !== 'custom') {
    const delta = totalPeriodTime - prevPeriodTime;
    const deltaPercent = prevPeriodTime > 0 ? Math.round((delta / prevPeriodTime) * 100) : (totalPeriodTime > 0 ? 100 : 0);
    const isPositive = delta >= 0;
    const absDelta = Math.abs(delta);
    const vsLabel = currentPeriod === 'day' ? t('timetracking.vsYesterday')
      : currentPeriod === 'week' ? t('timetracking.vsLastWeek')
      : t('timetracking.vsLastMonth');

    if (absDelta > 60000) {
      comparisonHtml = `
        <div class="tt-comparison ${isPositive ? 'positive' : 'negative'}">
          <span class="tt-comparison-arrow">${isPositive ? '&#x2191;' : '&#x2193;'}</span>
          <span class="tt-comparison-delta">${isPositive ? '+' : '-'}${formatDuration(absDelta)}</span>
          <span class="tt-comparison-percent">(${isPositive ? '+' : ''}${deltaPercent}%)</span>
          <span class="tt-comparison-label">${vsLabel}</span>
        </div>
      `;
    }
  }

  container.innerHTML = `
    <div class="tt-dashboard">
      <!-- Ambient background effects -->
      <div class="tt-ambient">
        <div class="tt-ambient-orb tt-orb-1"></div>
        <div class="tt-ambient-orb tt-orb-2"></div>
        <div class="tt-ambient-orb tt-orb-3"></div>
      </div>

      <!-- Header with period selector -->
      <header class="tt-header">
        <div class="tt-header-left">
          <h1 class="tt-title">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/>
            </svg>
            ${t('timetracking.title')}
          </h1>
          <div class="tt-header-actions">
            <button class="tt-goal-btn" data-action="configure-goal" title="${t('timetracking.configureGoal')}">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
            </button>
            <div class="tt-export-dropdown">
              <button class="tt-export-btn" data-action="export-toggle" title="${t('timetracking.export')}">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                ${t('timetracking.export')}
              </button>
              <div class="tt-export-menu" id="tt-export-menu" style="display:none;">
                <button class="tt-export-option" data-action="export-csv">CSV</button>
                <button class="tt-export-option" data-action="export-json">JSON</button>
              </div>
            </div>
          </div>
        </div>

        <div class="tt-period-nav" style="position: relative;">
          <button class="tt-nav-btn tt-nav-prev" id="tt-prev" ${currentPeriod === 'custom' ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
          <div class="tt-period-label" id="tt-period-label">${getPeriodLabel()}</div>
          <button class="tt-nav-btn tt-nav-next" id="tt-next" ${currentPeriod === 'custom' || currentOffset >= 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          </button>
        </div>

        <div class="tt-period-selector">
          <button class="tt-period-btn ${currentPeriod === 'day' ? 'active' : ''}" data-period="day">${t('timetracking.day')}</button>
          <button class="tt-period-btn ${currentPeriod === 'week' ? 'active' : ''}" data-period="week">${t('timetracking.week')}</button>
          <button class="tt-period-btn ${currentPeriod === 'month' ? 'active' : ''}" data-period="month">${t('timetracking.month')}</button>
        </div>
      </header>

      <!-- Main content grid -->
      <div class="tt-content">
        <!-- Total Time Card - Hero -->
        <div class="tt-card tt-card-hero">
          <div class="tt-hero-content">
            <div class="tt-hero-time">
              <span class="tt-hero-hours">${hours}</span>
              <span class="tt-hero-unit">h</span>
              <span class="tt-hero-minutes">${minutes.toString().padStart(2, '0')}</span>
              <span class="tt-hero-unit">m</span>
            </div>
            <div class="tt-hero-label">${t('timetracking.totalTime')}</div>
            <div class="tt-hero-sublabel">${getPeriodLabel()}</div>
            ${comparisonHtml}
          </div>
          ${dailyGoal > 0 && currentPeriod === 'day' && currentOffset === 0 ? `
          <div class="tt-hero-ring ${goalReached ? 'tt-goal-reached' : ''}">
            <svg viewBox="0 0 120 120">
              <circle class="tt-ring-bg" cx="60" cy="60" r="54" fill="none" stroke-width="6"/>
              <circle class="tt-ring-progress" cx="60" cy="60" r="54" fill="none" stroke-width="6"
                stroke-dasharray="${(goalProgressPercent / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}"
                transform="rotate(-90 60 60)"/>
            </svg>
            <div class="tt-ring-label">
              <span class="tt-ring-value">${goalProgressPercent}%</span>
              <span class="tt-ring-text">${goalReached ? t('timetracking.goalReached') : t('timetracking.ofGoal')}</span>
            </div>
          </div>
          ` : ''}
        </div>

        <!-- Quick Stats -->
        <div class="tt-card tt-card-stats">
          ${currentPeriod === 'day' ? `
          <!-- Day view stats -->
          <div class="tt-stat-item" title="${escapeHtml(t('timetracking.sessionsTooltip'))}">
            <div class="tt-stat-icon tt-stat-sessions">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14h-2v-4H8v-2h2V9h2v2h2v2h-2v4z"/></svg>
            </div>
            <div class="tt-stat-value">${sessionCount}</div>
            <div class="tt-stat-label">${t('timetracking.sessions')}</div>
          </div>
          <div class="tt-stat-item" title="${escapeHtml(t('timetracking.startTooltip'))}">
            <div class="tt-stat-icon tt-stat-start">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
            </div>
            <div class="tt-stat-value">${dayStats.firstSession ? dayStats.firstSession.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '-'}</div>
            <div class="tt-stat-label">${t('timetracking.chartStart')}</div>
          </div>
          <div class="tt-stat-item" title="${escapeHtml(t('timetracking.endTooltip'))}">
            <div class="tt-stat-icon tt-stat-end">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
            </div>
            <div class="tt-stat-value">${dayStats.lastSession ? dayStats.lastSession.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '-'}</div>
            <div class="tt-stat-label">${t('timetracking.chartEnd')}</div>
          </div>
          <div class="tt-stat-item" title="${escapeHtml(t('timetracking.projectsTooltip'))}">
            <div class="tt-stat-icon tt-stat-projects">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
            </div>
            <div class="tt-stat-value">${dayStats.projectCount}</div>
            <div class="tt-stat-label">${t('timetracking.chartProjects')}</div>
          </div>
          ` : `
          <!-- Week/Month view stats -->
          <div class="tt-stat-item" title="${escapeHtml(t('timetracking.streakTooltip'))}">
            <div class="tt-stat-icon tt-stat-streak">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/></svg>
            </div>
            <div class="tt-stat-value">${streak}</div>
            <div class="tt-stat-label">${t('timetracking.streak')}</div>
          </div>
          <div class="tt-stat-item" title="${escapeHtml(t('timetracking.avgTooltip'))}">
            <div class="tt-stat-icon tt-stat-avg">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17h18v2H3v-2zm0-7h18v5H3v-5zm0-4h18v2H3V6z"/></svg>
            </div>
            <div class="tt-stat-value">${formatDuration(avgDaily)}</div>
            <div class="tt-stat-label">${t('timetracking.avgPerDay')}</div>
          </div>
          <div class="tt-stat-item" title="${escapeHtml(t('timetracking.sessionsTooltip'))}">
            <div class="tt-stat-icon tt-stat-sessions">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14h-2v-4H8v-2h2V9h2v2h2v2h-2v4z"/></svg>
            </div>
            <div class="tt-stat-value">${sessionCount}</div>
            <div class="tt-stat-label">${t('timetracking.sessions')}</div>
          </div>
          ${mostActive ? `
          <div class="tt-stat-item tt-stat-project" title="${escapeHtml(t('timetracking.topProjectTooltip'))}">
            <div class="tt-stat-icon" style="background: ${sanitizeColor(mostActive.project.color) || '#d97706'}20; color: ${sanitizeColor(mostActive.project.color) || '#d97706'}">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
            </div>
            <div class="tt-stat-value tt-stat-project-name">${escapeHtml(mostActive.project.name.length > 10 ? mostActive.project.name.substring(0, 10) + '...' : mostActive.project.name)}</div>
            <div class="tt-stat-label">${t('timetracking.topProject')}</div>
          </div>
          ` : `
          <div class="tt-stat-item">
            <div class="tt-stat-icon">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
            </div>
            <div class="tt-stat-value">-</div>
            <div class="tt-stat-label">${t('timetracking.topProject')}</div>
          </div>
          `}
          `}
        </div>

        <!-- Chart Card -->
        <div class="tt-card tt-card-chart">
          <div class="tt-card-header">
            <h3>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/></svg>
              ${t('timetracking.evolution')}
            </h3>
          </div>
          <div class="tt-chart">
            <div class="tt-chart-bars">
              ${dailyData.map((day, i) => `
                <div class="tt-chart-col">
                  <div class="tt-chart-bar-container">
                    ${day.time > 0 ? `
                      <div class="tt-chart-bar" style="height: ${Math.max((day.time / maxDailyTime) * 100, 8)}%">
                        <div class="tt-chart-value">${formatDuration(day.time)}</div>
                      </div>
                    ` : `
                      <div class="tt-chart-bar-empty"></div>
                    `}
                  </div>
                  <div class="tt-chart-label">${day.label}</div>
                </div>
              `).join('')}
            </div>
          </div>
        </div>

        <!-- Projects Breakdown -->
        <div class="tt-card tt-card-projects">
          <div class="tt-card-header">
            <h3>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>
              ${t('timetracking.byProject')}
            </h3>
          </div>
          <div class="tt-projects-list">
            ${projectBreakdown.length === 0 ? `
              <div class="tt-projects-empty">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                <p>${t('timetracking.noActivity')}</p>
              </div>
            ` : projectBreakdown.map((project, i) => {
              const percentage = totalProjectTime > 0 ? (project.time / totalProjectTime) * 100 : 0;
              return `
                <div class="tt-project-item" style="animation-delay: ${i * 50}ms">
                  <div class="tt-project-color" style="background: ${project.color}"></div>
                  <div class="tt-project-info">
                    <div class="tt-project-name">${escapeHtml(project.name)}</div>
                    <div class="tt-project-meta">${project.sessions} session${project.sessions > 1 ? 's' : ''}</div>
                  </div>
                  <div class="tt-project-bar-container">
                    <div class="tt-project-bar" style="width: ${percentage}%; background: ${project.color}"></div>
                  </div>
                  <div class="tt-project-time">${formatDuration(project.time, { showSeconds: true, alwaysShowMinutes: false })}</div>
                  <div class="tt-project-percent">${Math.round(percentage)}%</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Recent Sessions -->
        <div class="tt-card tt-card-sessions">
          <div class="tt-card-header">
            <h3>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
              ${t('timetracking.recentSessions')}
            </h3>
          </div>
          <div class="tt-sessions-list">
            ${projectSessions.length === 0 ? `
              <div class="tt-sessions-empty">
                <p>${t('timetracking.noSession')}</p>
              </div>
            ` : projectSessions.slice(0, 10).map((session, i) => {
              const startDate = new Date(session.startTime);
              const endDate = new Date(session.endTime);
              return `
                <div class="tt-session-item" style="animation-delay: ${i * 30}ms">
                  <div class="tt-session-color" style="background: ${session.projectColor}"></div>
                  <div class="tt-session-project">${escapeHtml(session.projectName)}</div>
                  <div class="tt-session-date">${startDate.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' })}</div>
                  <div class="tt-session-hours">${startDate.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })} - ${endDate.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</div>
                  <div class="tt-session-duration">${formatDuration(session.duration, { showSeconds: true, alwaysShowMinutes: false })}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <!-- Global Summary -->
        <div class="tt-card tt-card-global">
          <div class="tt-card-header">
            <h3>
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              ${t('timetracking.globalSummary')}
            </h3>
          </div>
          <div class="tt-global-grid">
            <div class="tt-global-item ${currentPeriod === 'day' && currentOffset === 0 ? 'active' : ''}">
              <span class="tt-global-label">${t('timetracking.today')}</span>
              <span class="tt-global-value tt-accent">${formatDuration(globalTimes.today, { showSeconds: true, alwaysShowMinutes: false })}</span>
            </div>
            <div class="tt-global-item ${currentPeriod === 'week' && currentOffset === 0 ? 'active' : ''}">
              <span class="tt-global-label">${t('timetracking.thisWeek')}</span>
              <span class="tt-global-value">${formatDuration(globalTimes.week, { showSeconds: true, alwaysShowMinutes: false })}</span>
            </div>
            <div class="tt-global-item ${currentPeriod === 'month' && currentOffset === 0 ? 'active' : ''}">
              <span class="tt-global-label">${t('timetracking.thisMonth')}</span>
              <span class="tt-global-value">${formatDuration(globalTimes.month, { showSeconds: true, alwaysShowMinutes: false })}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Attach event listeners
  attachEventListeners(container);
}

/**
 * Close the calendar popup
 */
function closeCalendarPopup() {
  // Cancel pending listener registration if not yet fired
  if (calendarListenerTimer) {
    clearTimeout(calendarListenerTimer);
    calendarListenerTimer = null;
  }
  // Remove document-level listeners
  if (calendarOutsideClickHandler) {
    document.removeEventListener('mousedown', calendarOutsideClickHandler);
    calendarOutsideClickHandler = null;
  }
  if (calendarEscHandler) {
    document.removeEventListener('keydown', calendarEscHandler);
    calendarEscHandler = null;
  }

  if (calendarPopup) {
    calendarPopup.classList.add('closing');
    setTimeout(() => {
      calendarPopup?.remove();
      calendarPopup = null;
    }, 150);
  }
}

/**
 * Build and show the calendar popup
 */
function showCalendarPopup(container, anchorEl) {
  if (calendarPopup) {
    closeCalendarPopup();
    return;
  }

  const locale = t('language.code') === 'fr' ? 'fr-FR' : 'en-US';
  const isFr = locale === 'fr-FR';
  let calendarMonth = new Date();
  calendarMonth.setDate(1);

  let rangeStart = null;
  let rangeEnd = null;

  const popup = document.createElement('div');
  popup.className = 'tt-calendar-popup';
  calendarPopup = popup;

  function renderCalendarContent() {
    const year = calendarMonth.getFullYear();
    const month = calendarMonth.getMonth();
    const monthLabel = calendarMonth.toLocaleDateString(locale, { month: 'long', year: 'numeric' });

    // Weekday headers
    const weekdays = [];
    const baseDate = new Date(2024, 0, 1); // Monday
    for (let i = 0; i < 7; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      weekdays.push(d.toLocaleDateString(locale, { weekday: 'narrow' }));
    }

    // Days grid
    const firstDay = new Date(year, month, 1);
    let startDow = firstDay.getDay() - 1;
    if (startDow < 0) startDow = 6; // Sunday = 6
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let daysHtml = '';
    // Empty cells before first day
    for (let i = 0; i < startDow; i++) {
      daysHtml += '<button class="tt-calendar-day empty" disabled></button>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const cellDate = new Date(year, month, d);
      cellDate.setHours(0, 0, 0, 0);
      const isToday = cellDate.getTime() === today.getTime();
      const isStart = rangeStart && cellDate.getTime() === rangeStart.getTime();
      const isEnd = rangeEnd && cellDate.getTime() === rangeEnd.getTime();
      const inRange = rangeStart && rangeEnd && cellDate > rangeStart && cellDate < rangeEnd;

      let cls = 'tt-calendar-day';
      if (isToday) cls += ' today';
      if (isStart && isEnd) cls += ' selected range-start range-end';
      else if (isStart) cls += ' selected range-start';
      else if (isEnd) cls += ' selected range-end';
      else if (inRange) cls += ' in-range';

      daysHtml += `<button class="${cls}" data-date="${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}">${d}</button>`;
    }

    // Range info
    let rangeInfoHtml = '';
    if (rangeStart || rangeEnd) {
      const startStr = rangeStart ? rangeStart.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '...';
      const endStr = rangeEnd ? rangeEnd.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : '...';
      rangeInfoHtml = `
        <div class="tt-calendar-range-info">
          <span>${startStr}</span> → <span>${endStr}</span>
        </div>
      `;
    }

    // Shortcuts
    const shortcuts = [
      { label: t('timetracking.today'), period: 'day', offset: 0 },
      { label: t('timetracking.yesterday'), period: 'day', offset: -1 },
      { label: t('timetracking.thisWeek'), period: 'week', offset: 0 },
      { label: t('timetracking.lastWeek'), period: 'week', offset: -1 },
      { label: t('timetracking.thisMonth'), period: 'month', offset: 0 },
      { label: t('timetracking.lastMonth'), period: 'month', offset: -1 },
      { label: t('timetracking.last7days'), period: 'custom', days: 7 },
      { label: t('timetracking.last30days'), period: 'custom', days: 30 },
    ];

    const isActiveShortcut = (s) => {
      if (s.period === 'custom') return false;
      return currentPeriod === s.period && currentOffset === s.offset;
    };

    popup.innerHTML = `
      <div class="tt-calendar-shortcuts">
        ${shortcuts.map(s => `
          <button class="tt-calendar-shortcut-btn ${isActiveShortcut(s) ? 'active' : ''}"
            data-period="${s.period}" data-offset="${s.offset ?? ''}" data-days="${s.days ?? ''}"
          >${s.label}</button>
        `).join('')}
      </div>
      <div class="tt-calendar-main">
        <div class="tt-calendar-header">
          <button class="tt-calendar-nav-btn" id="tt-cal-prev">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
          </button>
          <span class="tt-calendar-header-label">${monthLabel}</span>
          <button class="tt-calendar-nav-btn" id="tt-cal-next">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
          </button>
        </div>
        <div class="tt-calendar-weekdays">
          ${weekdays.map(wd => `<div class="tt-calendar-weekday">${wd}</div>`).join('')}
        </div>
        <div class="tt-calendar-grid">
          ${daysHtml}
        </div>
        ${rangeInfoHtml}
        <button class="tt-calendar-apply-btn" id="tt-cal-apply" ${(!rangeStart || !rangeEnd) ? 'disabled' : ''}>
          ${t('timetracking.apply')}
        </button>
      </div>
    `;

    // Bind events inside popup
    popup.querySelector('#tt-cal-prev')?.addEventListener('click', (e) => {
      e.stopPropagation();
      calendarMonth.setMonth(calendarMonth.getMonth() - 1);
      renderCalendarContent();
    });

    popup.querySelector('#tt-cal-next')?.addEventListener('click', (e) => {
      e.stopPropagation();
      calendarMonth.setMonth(calendarMonth.getMonth() + 1);
      renderCalendarContent();
    });

    // Shortcut buttons
    popup.querySelectorAll('.tt-calendar-shortcut-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const period = btn.dataset.period;
        const offset = btn.dataset.offset !== '' ? parseInt(btn.dataset.offset) : 0;
        const days = btn.dataset.days !== '' ? parseInt(btn.dataset.days) : 0;

        if (period === 'custom' && days > 0) {
          const now = new Date();
          now.setHours(0, 0, 0, 0);
          customStartDate = new Date(now);
          customStartDate.setDate(customStartDate.getDate() - (days - 1));
          customEndDate = new Date(now);
          customEndDate.setDate(customEndDate.getDate() + 1);
          currentPeriod = 'custom';
          currentOffset = 0;
        } else {
          currentPeriod = period;
          currentOffset = offset;
          customStartDate = null;
          customEndDate = null;
        }

        closeCalendarPopup();
        await transitionAndRender(container);
      });
    });

    // Day click
    popup.querySelectorAll('.tt-calendar-day:not(.empty)').forEach(dayBtn => {
      dayBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const dateStr = dayBtn.dataset.date;
        const [y, m, d] = dateStr.split('-').map(Number);
        const clickedDate = new Date(y, m - 1, d);
        clickedDate.setHours(0, 0, 0, 0);

        if (!rangeStart || (rangeStart && rangeEnd)) {
          // Start new range
          rangeStart = clickedDate;
          rangeEnd = null;
        } else {
          // Set end date
          if (clickedDate < rangeStart) {
            rangeEnd = new Date(rangeStart);
            rangeStart = clickedDate;
          } else {
            rangeEnd = clickedDate;
          }
        }
        renderCalendarContent();
      });
    });

    // Apply button
    popup.querySelector('#tt-cal-apply')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (rangeStart && rangeEnd) {
        customStartDate = new Date(rangeStart);
        customEndDate = new Date(rangeEnd);
        customEndDate.setDate(customEndDate.getDate() + 1); // end is exclusive
        currentPeriod = 'custom';
        currentOffset = 0;
        closeCalendarPopup();
        await transitionAndRender(container);
      }
    });
  }

  renderCalendarContent();
  anchorEl.appendChild(popup);

  // Close on outside click
  calendarOutsideClickHandler = (e) => {
    if (calendarPopup && !calendarPopup.contains(e.target) && e.target !== anchorEl.querySelector('.tt-period-label')) {
      closeCalendarPopup();
    }
  };
  calendarListenerTimer = setTimeout(() => {
    calendarListenerTimer = null;
    document.addEventListener('mousedown', calendarOutsideClickHandler);
  }, 0);

  // Close on Escape
  calendarEscHandler = (e) => {
    if (e.key === 'Escape') {
      closeCalendarPopup();
    }
  };
  document.addEventListener('keydown', calendarEscHandler);
}

/**
 * Smooth transition: fade-out existing content, then re-render with fade-in
 */
async function transitionAndRender(container) {
  const content = container.querySelector('.tt-content');
  if (content) {
    content.classList.add('tt-content-exit');
    await new Promise(r => setTimeout(r, 150));
  }
  await render(container);
}

/**
 * Attach event listeners to the dashboard
 */
function attachEventListeners(container) {
  // Period selector buttons
  container.querySelectorAll('.tt-period-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      currentPeriod = btn.dataset.period;
      currentOffset = 0;
      customStartDate = null;
      customEndDate = null;
      closeCalendarPopup();
      await transitionAndRender(container);
    });
  });

  // Period label click → open calendar popup
  container.querySelector('#tt-period-label')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const periodNav = container.querySelector('.tt-period-nav');
    showCalendarPopup(container, periodNav);
  });

  // Goal config button
  container.querySelector('[data-action="configure-goal"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const headerLeft = container.querySelector('.tt-header-left');
    showGoalConfigPopup(container, headerLeft);
  });

  // Export toggle
  container.querySelector('[data-action="export-toggle"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = container.querySelector('#tt-export-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  });

  // Export CSV
  container.querySelector('[data-action="export-csv"]')?.addEventListener('click', async () => {
    container.querySelector('#tt-export-menu').style.display = 'none';
    await exportData('csv');
  });

  // Export JSON
  container.querySelector('[data-action="export-json"]')?.addEventListener('click', async () => {
    container.querySelector('#tt-export-menu').style.display = 'none';
    await exportData('json');
  });

  // Close export menu on outside click
  document.addEventListener('click', (e) => {
    const menu = container.querySelector('#tt-export-menu');
    if (menu && !e.target.closest('.tt-export-dropdown')) {
      menu.style.display = 'none';
    }
  });

  // Navigation buttons
  container.querySelector('#tt-prev')?.addEventListener('click', async () => {
    if (currentPeriod === 'custom') {
      currentPeriod = 'day';
      customStartDate = null;
      customEndDate = null;
      currentOffset = 0;
    }
    currentOffset--;
    await transitionAndRender(container);
  });

  container.querySelector('#tt-next')?.addEventListener('click', async () => {
    if (currentPeriod === 'custom') return;
    if (currentOffset < 0) {
      currentOffset++;
      await transitionAndRender(container);
    }
  });
}

/**
 * Initialize the dashboard with auto-refresh
 */
async function init(container) {
  await render(container);

  // Clear existing interval if any
  if (updateInterval) {
    clearInterval(updateInterval);
  }

  // Update every 30 seconds
  updateInterval = setInterval(async () => {
    // Only update if the container is still in the DOM and visible
    if (container.offsetParent !== null) {
      await render(container);
    }
  }, 30000);
}

/**
 * Cleanup when dashboard is hidden
 */
function cleanup() {
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  closeCalendarPopup();
  closeGoalPopup();
}

module.exports = {
  init,
  render,
  cleanup
};
