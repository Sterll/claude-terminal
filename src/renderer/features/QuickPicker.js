/**
 * Command Palette (Extended Quick Picker)
 * Unified search across projects, commands, sessions, git branches, MCP servers
 */

const { escapeHtml, debounce } = require('../utils/dom');
const { projectsState, mcpState } = require('../state');
const { t } = require('../i18n');
const registry = require('../../project-types/registry');

// ── Icons ──────────────────────────────────────────────────────────────────
const ICON = {
  project: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z"/></svg>',
  command: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 3l2.3 2.3-2.89 2.87 1.42 1.42L18.7 6.7 21 9V3h-6zM3 9l2.3-2.3 2.87 2.89 1.42-1.42L6.7 5.3 9 3H3v6zm6 12l-2.3-2.3 2.89-2.87-1.42-1.42L5.3 17.3 3 15v6h6zm12-6l-2.3 2.3-2.87-2.89-1.42 1.42 2.89 2.87L15 21h6v-6z"/></svg>',
  session: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>',
  branch: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 12c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6.5V18c0 1.1.9 2 2 2s2-.9 2-2v-4c0-.55-.22-1.05-.59-1.41A9.02 9.02 0 0 0 7 9.5zm10 0V10c-1.66 0-3-1.34-3-3H9c0 2.42-1.72 4.44-4 4.9V13a9 9 0 0 1 5.5-1.73V16c0 1.1.9 2 2 2s2-.9 2-2v-2.27c1.53.26 3 1.14 3 2.27h2c0-2.9-2.41-5.24-5.5-5.73V9.5h.5z"/></svg>',
  mcp: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>',
  action: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V8h16v11zM6 10h2v2H6zm0 4h8v2H6zm4-4h8v2h-8z"/></svg>',
  git: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 12c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM7 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm3.17-7.5C10.5 10.1 11 11.5 12 12.5V17c0 1.1.9 2 2 2s2-.9 2-2v-4.5c1.03-.97 1.5-2.35 1.5-3.5H15c0 1.66-1.34 3-3 3S9 10.66 9 9H7c0 1.15.47 2.53 1.5 3.5H6.17A8.956 8.956 0 0 1 7 9.5V6.07A8.97 8.97 0 0 0 7 6V5.5H5V9c0 .66.07 1.3.17 1.93l-1.11.85a.5.5 0 0 0-.12.61l1 1.73c.12.21.37.28.58.2l1.3-.52c.43.33.9.61 1.41.82l.19 1.37c.04.24.24.41.47.41h2c.23 0 .43-.17.47-.41l.19-1.37c.51-.21.98-.49 1.41-.82l1.3.52c.22.08.47 0 .58-.2l1-1.73a.5.5 0 0 0-.12-.61l-1.11-.85c.1-.63.17-1.27.17-1.93V5.5h-2V6c0 .17-.02.33-.03.5H10.17z"/></svg>',
  newProject: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3v-3h2v3h3v2z"/></svg>',
  dashboard: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>',
  memory: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 9H9v6h6V9zm-2 4h-2v-2h2v2zm8-2V9h-2V7c0-1.1-.9-2-2-2h-2V3h-2v2h-2V3H9v2H7c-1.1 0-2 .9-2 2v2H3v2h2v2H3v2h2v2c0 1.1.9 2 2 2h2v2h2v-2h2v2h2v-2h2c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>',
};

// ── Prefix → mode map ─────────────────────────────────────────────────────
const PREFIX_MAP = {
  '>': 'commands',
  '@': 'branches',
  '#': 'sessions',
  '~': 'mcp',
  '!': 'actions',
};

// ── Internal state ────────────────────────────────────────────────────────
const quickPickerState = {
  isOpen: false,
  selectedIndex: 0,
  flatItems: [],
  query: '',
  mode: 'all',
  asyncData: {
    branches: null,      // null = not loaded, string[] = loaded
    currentBranch: null,
    sessions: null,
    branchesLoading: false,
    sessionsLoading: false,
    branchesError: false,
    sessionsError: false,
  },
};

// ── Async loaders ─────────────────────────────────────────────────────────
async function loadBranches(projectPath, onDone) {
  if (!projectPath || quickPickerState.asyncData.branchesLoading) return;
  quickPickerState.asyncData.branchesLoading = true;
  quickPickerState.asyncData.branchesError = false;
  try {
    const [result, current] = await Promise.all([
      window.electron_api.git.branches({ projectPath }),
      window.electron_api.git.currentBranch({ projectPath }),
    ]);
    const local = result?.local || [];
    const remote = (result?.remote || []).filter(r => !local.includes(r));
    quickPickerState.asyncData.branches = [...local, ...remote];
    quickPickerState.asyncData.currentBranch = current || null;
  } catch {
    quickPickerState.asyncData.branches = [];
    quickPickerState.asyncData.currentBranch = null;
    quickPickerState.asyncData.branchesError = true;
  }
  quickPickerState.asyncData.branchesLoading = false;
  onDone();
}

async function loadSessions(projectPath, onDone) {
  if (!projectPath || quickPickerState.asyncData.sessionsLoading) return;
  quickPickerState.asyncData.sessionsLoading = true;
  quickPickerState.asyncData.sessionsError = false;
  try {
    const sessions = await window.electron_api.claude.sessions(projectPath);
    // Sort by date desc, keep top 8
    const sorted = Array.isArray(sessions)
      ? sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, 8)
      : [];
    quickPickerState.asyncData.sessions = sorted;
  } catch {
    quickPickerState.asyncData.sessions = [];
    quickPickerState.asyncData.sessionsError = true;
  }
  quickPickerState.asyncData.sessionsLoading = false;
  onDone();
}

// ── Built-in commands ─────────────────────────────────────────────────────
function getBuiltinCommands() {
  return [
    {
      id: 'cmd-settings',
      label: t('quickPicker.cmd.settings'),
      hint: 'Ctrl+,',
      icon: ICON.settings,
      action: () => document.querySelector('[data-tab="settings"]')?.click(),
    },
    {
      id: 'cmd-new-project',
      label: t('quickPicker.cmd.newProject'),
      hint: 'Ctrl+N',
      icon: ICON.newProject,
      action: () => document.getElementById('btn-new-project')?.click(),
    },
    {
      id: 'cmd-git',
      label: t('quickPicker.cmd.openGit'),
      icon: ICON.git,
      action: () => document.querySelector('[data-tab="git"]')?.click(),
    },
    {
      id: 'cmd-mcp',
      label: t('quickPicker.cmd.openMcp'),
      icon: ICON.mcp,
      action: () => document.querySelector('[data-tab="mcp"]')?.click(),
    },
    {
      id: 'cmd-skills',
      label: t('quickPicker.cmd.openSkills'),
      icon: ICON.action,
      action: () => document.querySelector('[data-tab="skills"]')?.click(),
    },
    {
      id: 'cmd-agents',
      label: t('quickPicker.cmd.openAgents'),
      icon: ICON.session,
      action: () => document.querySelector('[data-tab="agents"]')?.click(),
    },
    {
      id: 'cmd-dashboard',
      label: t('quickPicker.cmd.openDashboard'),
      icon: ICON.dashboard,
      action: () => document.querySelector('[data-tab="dashboard"]')?.click(),
    },
    {
      id: 'cmd-memory',
      label: t('quickPicker.cmd.openMemory'),
      icon: ICON.memory,
      action: () => document.querySelector('[data-tab="memory"]')?.click(),
    },
    {
      id: 'cmd-new-terminal',
      label: t('quickPicker.cmd.newTerminal'),
      hint: 'Ctrl+T',
      icon: ICON.terminal,
      action: () => document.querySelector('.new-terminal-btn, [data-action="new-terminal"]')?.click(),
    },
  ];
}

// ── Fuzzy matching ────────────────────────────────────────────────────────

/**
 * Fuzzy match query against a string.
 * Returns { match, score, indices } where indices are matched char positions in str.
 */
function fuzzyMatch(query, str) {
  if (!query) return { match: true, score: 0, indices: [] };
  const q = query.toLowerCase();
  const s = str.toLowerCase();
  const indices = [];
  let qi = 0, score = 0, consecutive = 0;

  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (q[qi] === s[si]) {
      indices.push(si);
      consecutive++;
      score += consecutive * 2;
      // word-boundary bonus (space, dash, slash, dot, underscore)
      if (si === 0 || /[\s\-_/\\.]/.test(s[si - 1])) score += 8;
      qi++;
    } else {
      consecutive = 0;
    }
  }

  if (qi < q.length) return { match: false, score: 0, indices: [] };
  if (indices[0] === 0) score += 15; // starts-with bonus
  score -= (indices[indices.length - 1] || 0) * 0.3; // penalty for late matches
  return { match: true, score, indices };
}

/**
 * Wrap matched character positions with <mark class="qp-hl">.
 * Consecutive matched chars share one <mark> tag.
 */
function highlightStr(str, indices) {
  if (!indices || indices.length === 0) return escapeHtml(str);
  const set = new Set(indices);
  let html = '', inMark = false;
  for (let i = 0; i < str.length; i++) {
    const ch = escapeHtml(str[i]);
    if (set.has(i)) {
      if (!inMark) { html += '<mark class="qp-hl">'; inMark = true; }
      html += ch;
    } else {
      if (inMark) { html += '</mark>'; inMark = false; }
      html += ch;
    }
  }
  if (inMark) html += '</mark>';
  return html;
}

/**
 * Score an item against the query (tries label first, then sublabel).
 * Returns { match, score, labelHtml } — labelHtml is null when only sublabel matched.
 */
function scoreItem(q, label, sublabel) {
  if (!q) return { match: true, score: 0, labelHtml: null };
  const lm = fuzzyMatch(q, label);
  if (lm.match) return { match: true, score: lm.score, labelHtml: highlightStr(label, lm.indices) };
  if (sublabel) {
    const sm = fuzzyMatch(q, sublabel);
    if (sm.match) return { match: true, score: sm.score * 0.7, labelHtml: null };
  }
  return { match: false, score: 0, labelHtml: null };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function formatRelativeTime(isoDate) {
  if (!isoDate) return '';
  const diff = Date.now() - new Date(isoDate).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}j`;
}

function detectMode(value) {
  const prefix = value?.[0];
  if (prefix && PREFIX_MAP[prefix]) {
    return { mode: PREFIX_MAP[prefix], query: value.slice(1).trimStart() };
  }
  return { mode: 'all', query: value || '' };
}

// ── Badge label helper (i18n) ──────────────────────────────────────────────
function getBadgeLabel(badgeKey) {
  const labels = {
    current: t('quickPicker.badge.current') || 'current',
    running: t('quickPicker.badge.running') || 'running',
  };
  return labels[badgeKey] || badgeKey;
}

// ── Sections builder ──────────────────────────────────────────────────────
function buildSections(query, mode, currentProject) {
  const q = query.toLowerCase();
  const sections = [];

  // — Projects —
  if (mode === 'all' || mode === 'projects') {
    const defaultIcon = ICON.project;
    const items = projectsState.get().projects.map(p => {
      const { match, score, labelHtml } = scoreItem(q, p.name, p.path);
      if (!match) return null;
      const typeHandler = registry.get(p.type);
      const rawIcon = typeHandler?.icon || defaultIcon;
      const icon = (typeof rawIcon === 'string' && rawIcon.trim().startsWith('<svg') && !/<script|<foreignObject|on\w+\s*=/i.test(rawIcon))
        ? rawIcon : defaultIcon;
      return { type: 'project', id: p.id, label: p.name, labelHtml, sublabel: p.path, icon, score, data: p };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    if (items.length > 0) sections.push({ key: 'projects', label: t('quickPicker.section.projects'), items });
  }

  // — Quick Actions (current project) —
  if ((mode === 'all' || mode === 'actions') && currentProject) {
    const items = (currentProject.quickActions || []).map(a => {
      const label = a.label || a.name || '';
      const { match, score, labelHtml } = scoreItem(q, label, a.command);
      if (!match) return null;
      const rawIcon = a.icon;
      const icon = (typeof rawIcon === 'string' && rawIcon.trim().startsWith('<svg') && !/<script|<foreignObject|on\w+\s*=/i.test(rawIcon))
        ? rawIcon : ICON.action;
      return { type: 'action', id: `action-${label}`, label, labelHtml, sublabel: a.command || '', icon, score, data: { action: a, projectPath: currentProject.path } };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    if (items.length > 0) sections.push({ key: 'actions', label: t('quickPicker.section.quickActions'), items });
  }

  // — Commands —
  if (mode === 'all' || mode === 'commands') {
    const items = getBuiltinCommands().map(c => {
      const { match, score, labelHtml } = scoreItem(q, c.label, c.hint);
      if (!match) return null;
      return { type: 'command', id: c.id, label: c.label, labelHtml, hint: c.hint || '', icon: c.icon, score, data: c };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    if (items.length > 0) sections.push({ key: 'commands', label: t('quickPicker.section.commands'), items });
  }

  // — Git branches (current project, async) —
  if ((mode === 'all' || mode === 'branches') && currentProject) {
    const { branches, currentBranch, branchesLoading, branchesError } = quickPickerState.asyncData;
    if (branchesLoading) {
      sections.push({ key: 'branches', label: t('quickPicker.section.branches'), loading: true, items: [] });
    } else if (branchesError) {
      sections.push({ key: 'branches', label: t('quickPicker.section.branches'), error: true, items: [] });
    } else if (branches !== null) {
      const items = branches.map(b => {
        const { match, score, labelHtml } = scoreItem(q, b, null);
        if (!match) return null;
        return {
          type: 'branch', id: `branch-${b}`, label: b, labelHtml,
          sublabel: b === currentBranch ? t('quickPicker.branch.current') : '',
          badge: b === currentBranch ? 'current' : null,
          icon: ICON.branch, score,
          data: { branch: b, projectPath: currentProject.path },
        };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      if (items.length > 0 || mode === 'branches') {
        sections.push({ key: 'branches', label: t('quickPicker.section.branches'), items });
      }
    }
  }

  // — Recent sessions (current project, async) —
  if ((mode === 'all' || mode === 'sessions') && currentProject) {
    const { sessions, sessionsLoading, sessionsError } = quickPickerState.asyncData;
    if (sessionsLoading) {
      sections.push({ key: 'sessions', label: t('quickPicker.section.sessions'), loading: true, items: [] });
    } else if (sessionsError) {
      sections.push({ key: 'sessions', label: t('quickPicker.section.sessions'), error: true, items: [] });
    } else if (sessions !== null) {
      const items = sessions.map(s => {
        const label = s.summary || s.firstPrompt || s.sessionId;
        const { match, score, labelHtml } = scoreItem(q, label, s.sessionId);
        if (!match) return null;
        return {
          type: 'session', id: `session-${s.sessionId}`, label, labelHtml,
          sublabel: formatRelativeTime(s.modified),
          badge: s.messageCount ? String(s.messageCount) : null,
          icon: ICON.session, score, data: s,
        };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
      if (items.length > 0 || mode === 'sessions') {
        sections.push({ key: 'sessions', label: t('quickPicker.section.sessions'), items });
      }
    }
  }

  // — MCP Servers —
  if (mode === 'all' || mode === 'mcp') {
    const { mcps, mcpProcesses } = mcpState.get();
    const items = (mcps || []).map(m => {
      const label = m.name || m.id;
      const { match, score, labelHtml } = scoreItem(q, label, m.command);
      if (!match) return null;
      const proc = (mcpProcesses || {})[m.id];
      return {
        type: 'mcp', id: `mcp-${m.id}`, label, labelHtml,
        sublabel: m.command || '',
        badge: proc?.status === 'running' ? 'running' : null,
        icon: ICON.mcp, score, data: m,
      };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    if (items.length > 0) sections.push({ key: 'mcp', label: t('quickPicker.section.mcp'), items });
  }

  return sections;
}

// ── Selection update (no re-render) ──────────────────────────────────────
function updateSelection(list, newIndex) {
  const oldIndex = quickPickerState.selectedIndex;
  if (newIndex === oldIndex) return;
  quickPickerState.selectedIndex = newIndex;
  const items = list.querySelectorAll('.quick-picker-item:not(.quick-picker-skeleton):not(.quick-picker-error)');
  items.forEach(el => {
    const idx = parseInt(el.dataset.flatIndex, 10);
    el.classList.toggle('selected', idx === newIndex);
  });
  const selected = list.querySelector('.quick-picker-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// ── List renderer ─────────────────────────────────────────────────────────
const MAX_VISIBLE = 50;

function renderList(list, handlers, picker, currentProject) {
  const { mode, query } = detectMode(quickPickerState.query);
  quickPickerState.mode = mode;

  const sections = buildSections(query, mode, currentProject);

  // Build flat item list for keyboard navigation
  const flatItems = [];
  sections.forEach(s => s.items.forEach(item => flatItems.push(item)));

  // Cap visible items to avoid heavy DOM with many projects
  const totalCount = flatItems.length;
  let truncated = false;
  if (totalCount > MAX_VISIBLE) {
    const visibleSet = new Set(flatItems.slice(0, MAX_VISIBLE));
    sections.forEach(s => { s.items = s.items.filter(i => visibleSet.has(i)); });
    flatItems.length = MAX_VISIBLE;
    truncated = true;
  }
  quickPickerState.flatItems = flatItems;

  const hasContent = flatItems.length > 0 || sections.some(s => s.loading);
  const hasError = sections.some(s => s.error);

  if (!hasContent && !hasError) {
    // Show "no results" with query context
    const escapedQuery = escapeHtml(query);
    const noResultMsg = query
      ? (t('quickPicker.noResultFor') || 'No results for "{query}"').replace('{query}', escapedQuery)
      : t('quickPicker.noResult');
    const hintMsg = query ? `<p class="quick-picker-empty-hint">${t('quickPicker.searchHint') || ''}</p>` : '';
    list.innerHTML = `
      <div class="quick-picker-empty">
        ${ICON.empty}
        <p>${noResultMsg}</p>
        ${hintMsg}
      </div>`;
    return;
  }

  list.innerHTML = sections.map(section => {
    if (section.loading) {
      return `
        <div class="quick-picker-section-header">${escapeHtml(section.label)}</div>
        ${[0, 1, 2].map(i => `
          <div class="quick-picker-item quick-picker-skeleton">
            <div class="quick-picker-skeleton-icon"></div>
            <div class="quick-picker-item-info">
              <div class="quick-picker-skeleton-bar" style="width:${[55, 70, 45][i]}%"></div>
              <div class="quick-picker-skeleton-bar quick-picker-skeleton-bar--sm" style="width:${[35, 50, 30][i]}%"></div>
            </div>
          </div>`).join('')}`;
    }
    if (section.error) {
      return `
        <div class="quick-picker-section-header">${escapeHtml(section.label)}</div>
        <div class="quick-picker-item quick-picker-error">
          <div class="quick-picker-item-icon">${ICON.error}</div>
          <div class="quick-picker-item-info">
            <div class="quick-picker-item-name">${t('quickPicker.loadError') || 'Failed to load'}</div>
          </div>
        </div>`;
    }
    if (section.items.length === 0) return '';

    return `
      <div class="quick-picker-section-header">${escapeHtml(section.label)}</div>
      ${section.items.map(item => {
        const idx = flatItems.indexOf(item);
        const isSelected = idx === quickPickerState.selectedIndex;
        const badgeLabel = item.badge ? getBadgeLabel(item.badge) : '';
        return `
          <div class="quick-picker-item ${isSelected ? 'selected' : ''}" data-flat-index="${idx}">
            <div class="quick-picker-item-icon">${item.icon}</div>
            <div class="quick-picker-item-info">
              <div class="quick-picker-item-name">${item.labelHtml || escapeHtml(item.label)}</div>
              ${item.sublabel ? `<div class="quick-picker-item-path">${escapeHtml(item.sublabel)}</div>` : ''}
            </div>
            ${item.badge ? `<span class="quick-picker-badge quick-picker-badge-${item.type === 'session' ? 'count' : item.badge}">${escapeHtml(badgeLabel)}</span>` : ''}
            ${item.hint ? `<kbd class="quick-picker-hint">${escapeHtml(item.hint)}</kbd>` : ''}
          </div>`;
      }).join('')}`;
  }).join('');

  // "More results" indicator when truncated
  if (truncated) {
    list.innerHTML += `<div class="quick-picker-more">${(t('quickPicker.moreResults') || '{count} more results...').replace('{count}', totalCount - MAX_VISIBLE)}</div>`;
  }

  // Scroll selected into view
  const selected = list.querySelector('.quick-picker-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// ── Item activation ───────────────────────────────────────────────────────
function activateItem(item, handlers, picker) {
  if (!item) return;
  closeQuickPicker(picker);

  switch (item.type) {
    case 'project':
      handlers.onSelectProject?.(item.data);
      break;
    case 'command':
      item.data.action?.();
      break;
    case 'branch':
      window.electron_api?.git?.checkout({ projectPath: item.data.projectPath, branch: item.data.branch });
      break;
    case 'session':
      // Open the Claude sessions panel; TODO: open specific session
      document.querySelector('[data-tab="claude"]')?.click();
      break;
    case 'mcp':
      document.querySelector('[data-tab="mcp"]')?.click();
      break;
    case 'action':
      if (item.data.action?.command && item.data.projectPath) {
        window.electron_api?.terminal?.input?.({ command: item.data.action.command, projectPath: item.data.projectPath });
      }
      break;
  }
}

// ── Open ──────────────────────────────────────────────────────────────────
/**
 * Open the command palette.
 * @param {HTMLElement} container
 * @param {Function|Object} optionsOrOnSelect - legacy: onSelect callback; new: options object
 *   options.onSelectProject {Function} - called when a project item is selected
 *   options.currentProject  {Object}   - current active project (for context-aware sections)
 */
function openQuickPicker(container, optionsOrOnSelect) {
  let handlers, currentProject;

  // Backward-compat: old API was openQuickPicker(container, onSelectFn)
  if (typeof optionsOrOnSelect === 'function') {
    handlers = { onSelectProject: optionsOrOnSelect };
    currentProject = null;
  } else {
    handlers = optionsOrOnSelect || {};
    currentProject = handlers.currentProject || null;
  }

  // Guard: if already open, just focus the existing picker
  if (quickPickerState.isOpen) {
    const existingInput = container.querySelector('.quick-picker-input');
    if (existingInput) existingInput.focus();
    return null;
  }

  quickPickerState.isOpen = true;
  quickPickerState.selectedIndex = 0;
  quickPickerState.query = '';
  quickPickerState.mode = 'all';
  quickPickerState.flatItems = [];
  quickPickerState.asyncData = {
    branches: null,
    currentBranch: null,
    sessions: null,
    branchesLoading: false,
    sessionsLoading: false,
    branchesError: false,
    sessionsError: false,
  };

  const picker = document.createElement('div');
  picker.className = 'quick-picker-overlay';
  picker.innerHTML = `
    <div class="quick-picker">
      <div class="quick-picker-search">
        ${ICON.search}
        <input type="text" class="quick-picker-input" placeholder="${t('quickPicker.placeholder')}" autofocus>
        <span class="quick-picker-shortcut">Esc</span>
      </div>
      <div class="quick-picker-list"></div>
      <div class="quick-picker-footer">
        <span class="quick-picker-footer-modes">
          <span class="quick-picker-footer-mode" data-prefix=">"><kbd>&gt;</kbd>${t('quickPicker.mode.commands')}</span>
          <span class="quick-picker-footer-mode" data-prefix="@"><kbd>@</kbd>${t('quickPicker.mode.branches')}</span>
          <span class="quick-picker-footer-mode" data-prefix="#"><kbd>#</kbd>${t('quickPicker.mode.sessions')}</span>
          <span class="quick-picker-footer-mode" data-prefix="~"><kbd>~</kbd>${t('quickPicker.mode.mcp')}</span>
        </span>
        <span><kbd>↑↓</kbd> ${t('quickPicker.nav.navigate')} &nbsp;<kbd>↵</kbd> ${t('quickPicker.nav.open')}</span>
      </div>
    </div>
  `;

  container.appendChild(picker);

  const input = picker.querySelector('.quick-picker-input');
  const list = picker.querySelector('.quick-picker-list');
  const rerender = () => renderList(list, handlers, picker, currentProject);

  // Event delegation on the list container (attached once, not per render)
  list.addEventListener('mouseenter', (e) => {
    const item = e.target.closest('.quick-picker-item:not(.quick-picker-skeleton):not(.quick-picker-error)');
    if (!item) return;
    const idx = parseInt(item.dataset.flatIndex, 10);
    if (!isNaN(idx)) updateSelection(list, idx);
  }, true); // capture phase for mouseenter delegation

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.quick-picker-item:not(.quick-picker-skeleton):not(.quick-picker-error)');
    if (!item) return;
    const idx = parseInt(item.dataset.flatIndex, 10);
    if (!isNaN(idx)) activateItem(quickPickerState.flatItems[idx], handlers, picker);
  });

  // Footer mode prefixes — click to pre-fill
  picker.querySelectorAll('.quick-picker-footer-mode').forEach(el => {
    el.addEventListener('click', () => {
      const prefix = el.dataset.prefix;
      input.value = prefix;
      quickPickerState.query = prefix;
      quickPickerState.selectedIndex = 0;
      rerender();
      input.focus();
    });
  });

  // Start async loads if we have a current project
  if (currentProject?.path) {
    loadBranches(currentProject.path, rerender);
    loadSessions(currentProject.path, rerender);
  }

  rerender();

  // Debounced search to avoid flicker with many items
  const debouncedRerender = debounce(() => {
    quickPickerState.selectedIndex = 0;
    rerender();
  }, 150);

  input.oninput = () => {
    quickPickerState.query = input.value;
    debouncedRerender();
  };

  input.onkeydown = (e) => {
    const { flatItems } = quickPickerState;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        updateSelection(list, Math.min(quickPickerState.selectedIndex + 1, flatItems.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        updateSelection(list, Math.max(quickPickerState.selectedIndex - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        activateItem(flatItems[quickPickerState.selectedIndex], handlers, picker);
        break;
      case 'Escape':
        e.preventDefault();
        closeQuickPicker(picker);
        break;
    }
  };

  picker.onclick = (e) => {
    if (e.target === picker) closeQuickPicker(picker);
  };

  requestAnimationFrame(() => {
    picker.classList.add('active');
    input.focus();
  });

  return picker;
}

// ── Close ─────────────────────────────────────────────────────────────────
function closeQuickPicker(picker) {
  quickPickerState.isOpen = false;
  picker.classList.remove('active');
  setTimeout(() => picker.parentNode?.removeChild(picker), 200);
}

function isQuickPickerOpen() {
  return quickPickerState.isOpen;
}

module.exports = { openQuickPicker, closeQuickPicker, isQuickPickerOpen, quickPickerState };
