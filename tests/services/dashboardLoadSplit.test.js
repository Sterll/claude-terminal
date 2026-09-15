/**
 * The dashboard load path is split in two: everything readable from this
 * machine, then the GitHub round-trip. The first paint must not wait on the
 * network, and nothing that used to be fetched may go missing.
 */

jest.mock('../../src/renderer/state', () => ({
  projectsState: { get: jest.fn(() => ({ projects: [], openedProjectId: null })), subscribe: jest.fn() },
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
jest.mock('../../src/renderer/utils', () => ({ escapeHtml: (s) => String(s ?? '') }));
jest.mock('../../src/renderer/utils/color', () => ({ sanitizeColor: (c) => c }));
jest.mock('../../src/renderer/utils/format', () => ({ formatDuration: () => '0m', redactUrlCredentials: url => url }));
jest.mock('../../src/project-types/registry', () => ({
  get: jest.fn(() => ({ getDashboardBadge: () => ({ text: '', cssClass: '' }), getDashboardStats: () => '' })),
}));
jest.mock('../../src/renderer/ui/panels/KanbanPanel', () => ({ render: jest.fn() }));
jest.mock('../../src/renderer/events', () => ({
  getActiveProvider: () => 'scraping',
  getDashboardStats: () => ({ hookSessionCount: 0, toolStats: {} }),
}));
jest.mock('../../src/renderer/services/ProjectTimeline', () => ({
  ...jest.requireActual('../../src/renderer/services/ProjectTimeline'),
  collect: jest.fn(async () => ({ events: [], failed: [] })),
}));

jest.mock('../../src/renderer/services/SessionRecapService', () => ({ getRecaps: jest.fn(async () => []) }));

// Order of resolution is what this suite is about, so every call is recorded.
let callLog;

beforeEach(() => {
  callLog = [];
  // DashboardService captures `window.electron_api` at module load, so the
  // object has to be mutated rather than replaced.
  Object.assign(window.electron_api, {
    git: {
      infoFull: jest.fn(async () => {
        callLog.push('git.infoFull');
        return { isGitRepo: true, remoteUrl: 'https://github.com/o/r.git', branch: 'main' };
      }),
      commitHistory: jest.fn(async () => { callLog.push('git.commitHistory'); return []; }),
      workflowRuns: jest.fn(async () => { callLog.push('github.workflowRuns'); return { runs: [] }; }),
    },
    project: {
      stats: jest.fn(async () => { callLog.push('project.stats'); return { files: 1, lines: 2, byExtension: {} }; }),
    },
    github: {
      workflowRuns: jest.fn(async () => { callLog.push('github.workflowRuns'); return { runs: [{ id: 1 }] }; }),
      pullRequests: jest.fn(async () => { callLog.push('github.pullRequests'); return { pullRequests: [{ id: 2 }] }; }),
      isAuthenticated: jest.fn(async () => true),
    },
  });
  window.electron_nodeModules.fs.promises.readdir = jest.fn(async () => {
    callLog.push('fs.readdir');
    return ['package.json'];
  });
  window.electron_nodeModules.fs.promises.readFile = jest.fn(async () => '{}');
  window.electron_nodeModules.fs.promises.access = jest.fn(async () => undefined);
  window.electron_nodeModules.fs.promises.writeFile = jest.fn(async () => undefined);
  window.electron_nodeModules.fs.promises.mkdir = jest.fn(async () => undefined);
  window.electron_nodeModules.fs.promises.stat = jest.fn(async () => ({ mtime: new Date(0), size: 0 }));
});

const DashboardService = require('../../src/renderer/services/DashboardService');

describe('loadLocalDashboardData', () => {
  test('never touches the GitHub API', async () => {
    await DashboardService.loadLocalDashboardData('/tmp/p');

    expect(callLog).not.toContain('github.workflowRuns');
    expect(callLog).not.toContain('github.pullRequests');
  });

  test('returns empty GitHub sections so the page can render without them', async () => {
    const local = await DashboardService.loadLocalDashboardData('/tmp/p');

    expect(local.workflowRuns).toEqual({ runs: [] });
    expect(local.pullRequests).toEqual({ pullRequests: [] });
  });

  test('detects the project type in the same batch as the git calls', async () => {
    const local = await DashboardService.loadLocalDashboardData('/tmp/p');

    // detectProjectType reads the directory; it used to run only after the
    // git calls had all resolved, adding a serial stage for no reason.
    expect(callLog).toContain('fs.readdir');
    expect(local).toHaveProperty('projectType');
  });

  test('lightweight mode skips the 500-commit history', async () => {
    const local = await DashboardService.loadLocalDashboardData('/tmp/p', { lightweight: true });

    expect(callLog).not.toContain('git.commitHistory');
    expect(local.commitHistory30d).toBeNull();
  });
});

describe('loadRemoteDashboardData', () => {
  test('returns null when the project has no GitHub remote', async () => {
    const remote = await DashboardService.loadRemoteDashboardData({ isGitRepo: true, remoteUrl: null });

    expect(remote).toBeNull();
    expect(callLog).not.toContain('github.pullRequests');
  });

  test('returns null when the project is not a git repo at all', async () => {
    expect(await DashboardService.loadRemoteDashboardData({ isGitRepo: false })).toBeNull();
    expect(await DashboardService.loadRemoteDashboardData(null)).toBeNull();
  });
});

describe('loadDashboardData', () => {
  test('still returns both halves, so nothing the dashboard shows is lost', async () => {
    const data = await DashboardService.loadDashboardData('/tmp/p');

    expect(data).toHaveProperty('gitInfo');
    expect(data).toHaveProperty('stats');
    expect(data).toHaveProperty('projectType');
    expect(data).toHaveProperty('commitHistory30d');
    expect(data).toHaveProperty('workflowRuns');
    expect(data).toHaveProperty('pullRequests');
  });

  test('the local calls all happen before the GitHub ones', async () => {
    await DashboardService.loadDashboardData('/tmp/p');

    const firstRemote = callLog.findIndex(c => c.startsWith('github.'));
    const lastLocal = Math.max(
      callLog.lastIndexOf('git.infoFull'),
      callLog.lastIndexOf('project.stats'),
      callLog.lastIndexOf('git.commitHistory'),
    );

    expect(firstRemote).toBeGreaterThan(-1);
    expect(lastLocal).toBeLessThan(firstRemote);
  });
});

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Let IPC mocks and the project-type detector settle without advancing timers.
async function flushPromises() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

describe('dashboard navigation and first paint', () => {
  const { projectsState } = require('../../src/renderer/state');
  const { getRecaps } = require('../../src/renderer/services/SessionRecapService');
  const project = { id: 'p1', name: 'Project one', path: '/tmp/p1', type: 'standalone' };
  const other = { id: 'p2', name: 'Project two', path: '/tmp/p2', type: 'standalone' };
  let container;

  beforeEach(() => {
    jest.useFakeTimers();
    DashboardService.clearAllCache();
    projectsState.get.mockReturnValue({ projects: [project, other], selectedProjectFilter: 0, openedProjectId: null });
    window.electron_api.github.workflowRuns.mockResolvedValue({ runs: [] });
    window.electron_api.github.pullRequests.mockResolvedValue({ pullRequests: [] });
    window.electron_api.github.onRateLimitUpdate = jest.fn();
    getRecaps.mockResolvedValue([]);
    container = document.createElement('div');
    document.body.replaceChildren(container);
  });

  afterEach(() => {
    DashboardService.cleanup();
    DashboardService.stopWorkflowPolling();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('opens the topbar selection without an openedProjectId', async () => {
    await DashboardService.renderDashboard(container, project);

    expect(container.querySelector('h2')?.textContent).toBe(project.name);
    expect(container.querySelector('.dashboard-loading')).toBeNull();
    expect(DashboardService.getCachedData(project.id)?.gitInfo.branch).toBe('main');
  });

  test('folder actions are usable before local data or session recaps resolve', async () => {
    const local = deferred();
    const recaps = deferred();
    window.electron_api.git.infoFull.mockReturnValue(local.promise);
    getRecaps.mockReturnValue(recaps.promise);
    const onOpenFolder = jest.fn();
    const rendering = DashboardService.renderDashboard(container, project, { onOpenFolder });
    await flushPromises();

    expect(container.querySelector('h2')?.textContent).toBe(project.name);
    container.querySelector('#dash-btn-open-folder')?.click();
    expect(onOpenFolder).toHaveBeenCalledWith(project.path);

    local.resolve({ isGitRepo: false });
    recaps.resolve([]);
    await rendering;
  });

  test('a fresh lightweight disk cache paints before the commit history arrives', async () => {
    window.electron_nodeModules.fs.promises.readFile.mockResolvedValue(JSON.stringify({
      _updatedAt: new Date().toISOString(),
      dashboard: {
        gitInfo: { isGitRepo: true, branch: 'cached-branch' },
        stats: { files: 7, lines: 42 },
        projectType: { type: 'node' },
        commitHistory30d: null,
      },
    }));
    await DashboardService.loadAllDiskCaches();
    const history = deferred();
    window.electron_api.git.commitHistory.mockReturnValue(history.promise);
    const rendering = DashboardService.renderDashboard(container, project);
    await flushPromises();

    expect(container.textContent).toContain('cached-branch');
    expect(window.electron_api.git.infoFull).not.toHaveBeenCalled();
    history.resolve([]);
    await rendering;
    expect(container.querySelector('.dashboard-refresh-indicator')).toBeNull();
  });

  test('Git data and history can render while source statistics and GitHub are still loading', async () => {
    const stats = deferred();
    const remote = deferred();
    window.electron_api.project.stats.mockReturnValue(stats.promise);
    window.electron_api.github.workflowRuns.mockReturnValue(remote.promise);
    const rendering = DashboardService.renderDashboard(container, project);
    await flushPromises();

    expect(container.textContent).toContain('main');
    expect(window.electron_api.git.commitHistory).toHaveBeenCalledTimes(1);
    expect(window.electron_api.github.workflowRuns).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.dashboard-refresh-indicator')).not.toBeNull();

    stats.resolve({ files: 7, lines: 42, byExtension: { '.js': { files: 7, lines: 42 } } });
    remote.resolve({ runs: [] });
    await rendering;
    expect(container.querySelector('[data-count-to="42"]')?.textContent).toBe('42');
    expect(parseFloat(container.querySelector('[data-bar-width]')?.style.width)).toBe(100);
    expect(container.querySelector('.dashboard-refresh-indicator')).toBeNull();
  });

  test('a late project response cannot replace the newer topbar selection', async () => {
    const first = deferred();
    window.electron_api.git.infoFull.mockImplementation(path => path === project.path
      ? first.promise : Promise.resolve({ isGitRepo: true, branch: 'second-branch' }));
    const previous = DashboardService.renderDashboard(container, project);
    projectsState.get.mockReturnValue({ projects: [project, other], selectedProjectFilter: 1, openedProjectId: null });
    await DashboardService.renderDashboard(container, other);

    first.resolve({ isGitRepo: true, branch: 'late-first-branch' });
    await previous;
    jest.advanceTimersByTime(250);
    expect(container.querySelector('h2')?.textContent).toBe(other.name);
    expect(container.textContent).toContain('second-branch');
    expect(container.textContent).not.toContain('late-first-branch');
    expect(DashboardService.getCachedData(project.id)?.gitInfo.branch).toBe('late-first-branch');
  });

  test('returning to the overview cancels pending project rendering and recaps', async () => {
    const remote = deferred();
    const recaps = deferred();
    window.electron_api.github.workflowRuns.mockReturnValue(remote.promise);
    getRecaps.mockReturnValue(recaps.promise);
    const rendering = DashboardService.renderDashboard(container, project);
    await flushPromises();
    DashboardService.renderOverview(container, [project, other]);
    remote.resolve({ runs: [] });
    recaps.resolve([{ summary: 'Old project recap', timestamp: Date.now() }]);
    await rendering;
    await flushPromises();
    jest.advanceTimersByTime(250);

    expect(container.querySelectorAll('.overview-card')).toHaveLength(2);
    expect(container.querySelector('#dash-btn-open-folder')).toBeNull();
    expect(container.textContent).not.toContain('Old project recap');
    expect(DashboardService.getCachedData(project.id)?.workflowRuns).toEqual({ runs: [] });
  });

  test('type-only startup caches can render and acquire real data', async () => {
    await DashboardService.loadAllDiskCaches();
    expect(DashboardService.getCachedData(project.id)).toEqual({ projectType: expect.any(Object) });
    await DashboardService.renderDashboard(container, project);

    expect(container.querySelector('.dashboard-error')).toBeNull();
    expect(container.textContent).toContain('main');
    expect(DashboardService.getCachedData(project.id)?.stats.files).toBe(1);
  });

  test('leaving the dashboard prevents late GitHub data from restarting its polling', async () => {
    const remote = deferred();
    window.electron_api.github.workflowRuns.mockReturnValue(remote.promise);
    const rendering = DashboardService.renderDashboard(container, project);
    await flushPromises();
    DashboardService.cancelRender(container);
    remote.resolve({ runs: [{ id: 1, name: 'Build', status: 'in_progress', head_sha: 'abcdef0' }] });
    await rendering;
    jest.advanceTimersByTime(30000);

    expect(window.electron_api.github.workflowRuns).toHaveBeenCalledTimes(1);
    expect(DashboardService.getCachedData(project.id)?.workflowRuns.runs[0].status).toBe('in_progress');
  });

  test('opening a project during preload shares the scan and receives its final data', async () => {
    projectsState.get.mockReturnValue({ projects: [project], selectedProjectFilter: 0, openedProjectId: null });
    window.electron_nodeModules.fs.existsSync.mockReturnValue(true);
    const remote = deferred();
    window.electron_api.github.workflowRuns.mockReturnValue(remote.promise);
    const preloading = DashboardService.preloadAllProjects();
    await flushPromises();
    const firstRender = DashboardService.renderDashboard(container, project);
    const secondRender = DashboardService.renderDashboard(container, project);
    await flushPromises();

    expect(window.electron_api.git.infoFull).toHaveBeenCalledTimes(1);
    expect(window.electron_api.project.stats).toHaveBeenCalledTimes(1);
    expect(window.electron_api.git.commitHistory).toHaveBeenCalledTimes(1);
    expect(window.electron_api.github.workflowRuns).toHaveBeenCalledTimes(1);
    remote.resolve({ runs: [], authenticated: true });
    await Promise.all([firstRender, secondRender]);
    await jest.advanceTimersByTimeAsync(1);
    await preloading;

    expect(container.querySelector('.dashboard-refresh-indicator')).toBeNull();
    expect(DashboardService.getCachedData(project.id)?.workflowRuns.authenticated).toBe(true);
  });

  test('late dashboard data leaves the active Kanban board intact', async () => {
    const remote = deferred();
    window.electron_api.github.workflowRuns.mockReturnValue(remote.promise);
    const rendering = DashboardService.renderDashboard(container, project);
    container.querySelector('[data-view="kanban"]').click();
    await flushPromises();
    const board = container.lastElementChild;
    board.textContent = 'In-progress task edit';
    remote.resolve({ runs: [] });
    await rendering;
    await flushPromises();

    expect(container.lastElementChild).toBe(board);
    expect(container.textContent).toContain('In-progress task edit');
    container.querySelector('[data-view="overview"]').click();
    await flushPromises();
    expect(container.querySelector('h2')?.textContent).toBe(project.name);
  });

  test('a late timeline response cannot replace another project', async () => {
    const Timeline = require('../../src/renderer/services/ProjectTimeline');
    const timeline = deferred();
    Timeline.collect.mockReturnValueOnce(timeline.promise);
    await DashboardService.renderDashboard(container, project);
    container.querySelector('[data-view="timeline"]').click();
    await flushPromises();
    expect(container.querySelector('.timeline-loading')).not.toBeNull();

    await DashboardService.renderDashboard(container, other);
    timeline.resolve({ events: [], failed: [] });
    await flushPromises();
    expect(container.querySelector('h2')?.textContent).toBe(other.name);
    expect(container.querySelector('.timeline-view')).toBeNull();

    await DashboardService.renderDashboard(container, project);
    container.querySelector('[data-view="overview"]').click();
    await flushPromises();
  });

  test('background dashboard data preserves the active timeline and its selected period', async () => {
    const remote = deferred();
    window.electron_api.github.workflowRuns.mockReturnValue(remote.promise);
    const rendering = DashboardService.renderDashboard(container, project);
    container.querySelector('[data-view="timeline"]').click();
    await flushPromises();
    container.querySelector('.timeline-range[data-days="14"]').click();
    await flushPromises();
    const timeline = container.querySelector('.timeline-view');
    remote.resolve({ runs: [] });
    await rendering;
    await flushPromises();

    expect(container.querySelector('.timeline-view')).toBe(timeline);
    expect(container.querySelector('.timeline-range.active').dataset.days).toBe('14');
    container.querySelector('[data-view="overview"]').click();
    await flushPromises();
  });
});
