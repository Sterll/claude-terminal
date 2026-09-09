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
jest.mock('../../src/renderer/utils/format', () => ({ formatDuration: () => '0m' }));
jest.mock('../../src/project-types/registry', () => ({
  get: jest.fn(() => ({ getDashboardBadge: () => ({ text: '', cssClass: '' }), getDashboardStats: () => '' })),
}));
jest.mock('../../src/renderer/ui/panels/KanbanPanel', () => ({ render: jest.fn() }));
jest.mock('../../src/renderer/events', () => ({
  getActiveProvider: () => 'scraping',
  getDashboardStats: () => ({ hookSessionCount: 0, toolStats: {} }),
}));
jest.mock('../../src/renderer/services/SessionRecapService', () => ({ getRecaps: () => [] }));

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
