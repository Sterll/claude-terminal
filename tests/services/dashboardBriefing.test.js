/**
 * The briefing that opens the dashboard: this week's figures, what to pick up
 * and what is waiting, on the project page and across every project.
 */

const mockProjects = [];

jest.mock('../../src/renderer/state', () => ({
  projectsState: { get: jest.fn(() => ({ projects: mockProjects, openedProjectId: null, folders: [], rootOrder: [] })), subscribe: jest.fn() },
  settingsState: { get: jest.fn(() => ({ githubHostname: 'github.com' })), subscribe: jest.fn() },
  setGitPulling: jest.fn(),
  setGitPushing: jest.fn(),
  setGitMerging: jest.fn(),
  setMergeInProgress: jest.fn(),
  getGitOperation: jest.fn(() => ({ mergeInProgress: false, conflicts: [] })),
  getProjectTimes: jest.fn(() => ({ today: 0, total: 0 })),
  getProjectSessions: jest.fn(() => []),
  getFolder: jest.fn(),
  getProject: jest.fn(),
  countProjectsRecursive: jest.fn(() => 0),
}));
jest.mock('../../src/renderer/ui/components/Modal', () => ({
  showConfirm: jest.fn(), createModal: jest.fn(), showModal: jest.fn(), closeModal: jest.fn(),
}));
jest.mock('../../src/project-types/registry', () => ({
  get: jest.fn(() => ({ getDashboardBadge: () => null, getDashboardStats: () => '' })),
}));
jest.mock('../../src/renderer/ui/panels/KanbanPanel', () => ({ render: jest.fn() }));
jest.mock('../../src/renderer/events', () => ({
  getActiveProvider: () => 'scraping',
  getDashboardStats: () => ({ hookSessionCount: 0, toolStats: {} }),
}));
jest.mock('../../src/renderer/services/SessionRecapService', () => ({
  getRecaps: jest.fn(async () => [{ summary: '• Shipped the cost tab', timestamp: Date.now() }]),
}));

const Brief = require('../../src/renderer/services/dashboard/briefing');
const { getProjectSessions, getProjectTimes } = require('../../src/renderer/state');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const DAY = 24 * 60 * 60 * 1000;

describe('dates and figures', () => {
  test('the week starts on Monday at local midnight', () => {
    const wednesday = new Date(2026, 8, 30, 15, 0).getTime();
    expect(new Date(Brief.weekStart(wednesday))).toEqual(new Date(2026, 8, 28));
    const sunday = new Date(2026, 9, 4, 23, 0).getTime();
    expect(new Date(Brief.weekStart(sunday))).toEqual(new Date(2026, 8, 28));
  });

  test('time since clips recorded sessions and adds the one still running', () => {
    const now = new Date(2026, 8, 30, 12, 0).getTime();
    const from = Brief.weekStart(now);
    const sessions = [
      // Straddles the start of the week: only its second hour counts.
      { startTime: new Date(from - 3600e3).toISOString(), endTime: new Date(from + 3600e3).toISOString() },
      // Earlier today, one hour.
      { startTime: new Date(now - 3 * 3600e3).toISOString(), endTime: new Date(now - 2 * 3600e3).toISOString() },
    ];
    // `today` counts that hour plus 30 minutes of a session not recorded yet.
    const times = { today: 3600e3 + 1800e3 };
    expect(Brief.timeSince(sessions, times, from, now)).toBe(3600e3 + 3600e3 + 1800e3);
  });

  test('commits since a date, and none when the history is not loaded', () => {
    const now = Date.now();
    const commits = [{ isoDate: new Date(now - DAY).toISOString() }, { isoDate: new Date(now - 10 * DAY).toISOString() }];
    expect(Brief.commitsSince(commits, now - 3 * DAY)).toBe(1);
    expect(Brief.commitsSince(null, 0)).toBeNull();
  });

  test('last days ends today', () => {
    const days = Brief.lastDays(14);
    expect(days).toHaveLength(14);
    expect(days[13]).toBe(Brief.dayKey(Date.now()));
  });
});

describe('todoItems', () => {
  test('lists what is waiting, the most pressing first', () => {
    const items = Brief.todoItems({
      gitInfo: {
        files: { staged: ['a'], unstaged: ['b', 'c'], untracked: [] },
        aheadBehind: { hasRemote: true, ahead: 2, behind: 1 },
      },
      workflowRuns: { runs: [{ name: 'CI', status: 'completed', conclusion: 'failure', url: 'https://ci/1' }] },
      pullRequests: { pullRequests: [{ state: 'open', url: 'https://pr/9' }, { state: 'closed' }] },
      conflicts: ['x.js'],
      todoCount: 60,
    });
    expect(items.map(i => i.tone)).toEqual(['danger', 'danger', 'warning', 'info', 'info', 'purple', 'muted']);
    expect(items[1].url).toBe('https://ci/1');
    expect(items[5].url).toBe('https://pr/9');
    expect(items[6].text).toContain('50+');
  });

  test('nothing waiting on a clean, synced project', () => {
    const items = Brief.todoItems({
      gitInfo: { files: {}, aheadBehind: { hasRemote: true, ahead: 0, behind: 0 } },
      workflowRuns: { runs: [{ status: 'completed', conclusion: 'success' }] },
    });
    expect(items).toEqual([]);
  });
});

describe('builders', () => {
  test('resume rows carry the session id and escape titles', () => {
    const html = Brief.buildResumeHtml([
      { sessionId: 's-1', modified: new Date().toISOString(), aiTitle: '<b>hi</b>', messageCount: 4 },
    ], { summary: '• one\n• two' });
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('[data-resume]').dataset.resume).toBe('s-1');
    expect(root.querySelector('.dash-resume-title').textContent).toBe('<b>hi</b>');
    expect(root.querySelector('.dash-recap').textContent).toContain('one · two');
  });

  test('activity hides the cost series until costs are known', () => {
    const html = Brief.buildActivityHtml([{ date: '2026-09-30', cost: null, commits: 3 }]);
    expect(html).not.toContain('tone-accent');
    expect(Brief.buildActivityHtml([{ date: '2026-09-30', cost: 4, commits: 3 }])).toContain('tone-accent');
  });
});

describe('cached loaders', () => {
  beforeEach(() => {
    Brief._resetCache();
    window.electron_api.claude = { sessions: jest.fn(async () => [
      { sessionId: 'old', modified: '2026-09-01T00:00:00Z' },
      { sessionId: 'new', modified: '2026-09-30T00:00:00Z' },
      { sessionId: 'nope' },
    ]) };
  });

  test('one call however many paints ask, newest sessions first', async () => {
    const project = { id: 'p', path: '/p' };
    const first = Brief.loadSessions(project);
    const second = Brief.loadSessions(project);
    expect(first.pending).toBe(true);
    expect(first.value).toBeUndefined();
    await second.ready;
    expect(window.electron_api.claude.sessions).toHaveBeenCalledTimes(1);
    const third = Brief.loadSessions(project);
    expect(third.pending).toBe(false);
    expect(third.value.map(s => s.sessionId)).toEqual(['new', 'old']);
  });
});

describe('dashboard views', () => {
  const DashboardService = require('../../src/renderer/services/DashboardService');
  const project = { id: 'p1', name: 'Alpha', path: '/alpha', type: 'standalone' };
  let container;

  beforeEach(() => {
    Brief._resetCache();
    mockProjects.splice(0, mockProjects.length, project);
    DashboardService.clearAllCache();
    getProjectSessions.mockReturnValue([]);
    getProjectTimes.mockReturnValue({ today: 0, total: 0 });
    Object.assign(window.electron_api, {
      git: {
        infoFull: jest.fn(async () => ({
          isGitRepo: true, branch: 'main', remoteUrl: 'https://github.com/o/r.git',
          files: { staged: [], unstaged: ['a.js'], untracked: [] },
          aheadBehind: { hasRemote: true, ahead: 1, behind: 0 },
          recentCommits: [{ hash: 'abc', message: 'feat: thing', date: '1 hour ago' }],
        })),
        commitHistory: jest.fn(async () => [{ isoDate: new Date().toISOString() }]),
      },
      project: { stats: jest.fn(async () => ({ files: 1, lines: 2, byExtension: {} })), scanTodos: jest.fn(async () => [{}, {}]) },
      github: {
        workflowRuns: jest.fn(async () => ({ runs: [] })),
        pullRequests: jest.fn(async () => ({ pullRequests: [] })),
        isAuthenticated: jest.fn(async () => true),
        onRateLimitUpdate: jest.fn(),
      },
      claude: { sessions: jest.fn(async () => [{ sessionId: 'sess-9', modified: new Date().toISOString(), aiTitle: 'Fix the chart' }]) },
      cost: { getReport: jest.fn(async ({ projectId }) => ({
        byProject: [{ projectId: projectId || 'p1', byDay: { [Brief.dayKey(Date.now())]: 12.5 } }],
      })) },
      dialog: { openExternal: jest.fn() },
    });
    window.electron_nodeModules.fs.promises.readdir = jest.fn(async () => ['package.json']);
    container = document.createElement('div');
    document.body.replaceChildren(container);
  });

  afterEach(() => {
    DashboardService.cleanup();
    DashboardService.stopWorkflowPolling();
  });

  test('the project page opens on the briefing, and Resume reopens the session', async () => {
    const onTaskSessionOpen = jest.fn();
    await DashboardService.renderDashboard(container, project, { onTaskSessionOpen });
    for (let i = 0; i < 5; i++) await flush();

    expect(container.querySelector('.dash-metrics [data-metric="cost"]').textContent).toMatch(/12[.,]50/);
    expect(container.querySelector('.dash-subline').textContent).toContain('main');
    const todo = container.querySelector('[data-dash="todo"]').textContent;
    expect(todo).toMatch(/1/);
    expect(window.electron_api.project.scanTodos).toHaveBeenCalledWith('/alpha');

    container.querySelector('[data-resume="sess-9"]').click();
    expect(onTaskSessionOpen).toHaveBeenCalledWith(project, 'sess-9');

    // What used to open the page is still there, folded.
    expect(container.querySelector('details.dash-more .dashboard-grid')).not.toBeNull();
  });

  test('the overview sums the week and sends waiting items to their project', async () => {
    const onCardClick = jest.fn();
    const data = await DashboardService.loadDashboardData(project);
    DashboardService.renderOverview(container, [project], { dataMap: { p1: data }, timesMap: {}, onCardClick });
    for (let i = 0; i < 5; i++) await flush();

    expect(container.querySelector('.dash-overview')).not.toBeNull();
    expect(container.querySelector('[data-metric="cost"]').textContent).toMatch(/12[.,]50/);
    expect(container.querySelectorAll('.overview-card')).toHaveLength(1);
    const item = container.querySelector('.dash-todo-item[data-project-index="0"]');
    expect(item.textContent).toContain('Alpha');
    item.click();
    expect(onCardClick).toHaveBeenCalledWith(0);
  });
});
