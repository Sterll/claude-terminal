/**
 * The dashboard of a remote (SSH) project (design/remote-ssh.md sections 5.4
 * and 5.5).
 *
 * - Its disk cache lives on this machine, under
 *   ~/.claude-terminal/remote-cache/<projectId>/dashboard.json: nothing is ever
 *   written into a repository on the host.
 * - Its project type comes from the root listing and package.json
 *   dependencies that the remote stats request brings back, with the same
 *   markers as a local project; fs is never asked about a URI.
 * - While its host is not connected the dashboard shows the last known data
 *   with a note and asks the host nothing; it renders again by itself once the
 *   host connects.
 * - The briefing at the top asks the host for sessions and TODOs only while it
 *   is connected, says where the history lives otherwise, and withholds the
 *   cost figure (the `costReport` row): this machine's transcripts say nothing
 *   about a remote project.
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
jest.mock('../../src/project-types/registry', () => {
  const get = jest.fn(() => ({ getDashboardBadge: () => ({ text: '', cssClass: '' }), getDashboardStats: () => '' }));
  return { get, forProject: jest.fn((p) => get(p && p.type)) };
});
jest.mock('../../src/renderer/ui/panels/KanbanPanel', () => ({ render: jest.fn() }));
jest.mock('../../src/renderer/events', () => ({
  getActiveProvider: () => 'scraping',
  getDashboardStats: () => ({ hookSessionCount: 0, toolStats: {} }),
}));
jest.mock('../../src/renderer/services/SessionRecapService', () => ({ getRecaps: jest.fn(async () => []) }));

const nodePath = require('path');
const state = require('../../src/renderer/state');
const { remoteHostsState, applyHostStatus, _resetForTests } = require('../../src/renderer/state/remoteHosts.state');

const REMOTE = {
  id: 'r1', name: 'api', type: 'general', path: 'ssh-remote://abcd1234/home/yanis/api',
  remote: { profileId: 'abcd1234', path: '/home/yanis/api', hostLabel: 'yanis@build' },
};
const LOCAL = { id: 'l1', name: 'app', type: 'standalone', path: '/code/app' };
const HOME = nodePath.join(nodePath.sep, 'home', 'me');
const CACHE_FILE = nodePath.join(HOME, '.claude-terminal', 'remote-cache', 'r1', 'dashboard.json');

let fsp;

beforeEach(() => {
  jest.clearAllMocks();
  state.projectsState.get.mockImplementation(() => ({ projects: [REMOTE, LOCAL], openedProjectId: null }));
  window.electron_nodeModules.os = { ...window.electron_nodeModules.os, homedir: () => HOME };
  fsp = window.electron_nodeModules.fs.promises;
  fsp.readdir = jest.fn(async () => { throw new Error('fs must not be asked about a remote project'); });
  fsp.readFile = jest.fn(async (file) => {
    if (file === CACHE_FILE) return JSON.stringify({ _version: 1, _updatedAt: new Date(0).toISOString(), dashboard: { gitInfo: { isGitRepo: true, branch: 'cached-branch' }, stats: { lines: 7, files: 1, byExtension: {} } } });
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  fsp.writeFile = jest.fn(async () => undefined);
  fsp.mkdir = jest.fn(async () => undefined);
  Object.assign(window.electron_api, {
    git: {
      infoFull: jest.fn(async () => ({ isGitRepo: true, branch: 'main', remoteUrl: null })),
      commitHistory: jest.fn(async () => []),
    },
    project: {
      stats: jest.fn(async () => ({ lines: 40, files: 2, byExtension: {}, remote: true, rootEntries: ['package.json', 'src'], packageDeps: ['react'] })),
    },
    github: { workflowRuns: jest.fn(), pullRequests: jest.fn(), isAuthenticated: jest.fn(async () => false), onRateLimitUpdate: jest.fn() },
    claude: { sessions: jest.fn(async () => [{ sessionId: 'rs-1', modified: new Date().toISOString(), aiTitle: 'On the host' }]) },
    cost: { getReport: jest.fn(async ({ projectId }) => ({ byProject: [{ projectId: projectId || 'l1', byDay: { [require('../../src/renderer/services/dashboard/briefing').dayKey(Date.now())]: 9 } }] })) },
  });
  window.electron_api.project.scanTodos = jest.fn(async () => [{}, {}, {}]);
  require('../../src/renderer/services/dashboard/briefing')._resetCache();
  _resetForTests();
  remoteHostsState.set({ profiles: [{ id: 'abcd1234', host: 'build', user: 'yanis' }], loaded: true, statuses: {} });
});

const DashboardService = require('../../src/renderer/services/DashboardService');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('remote project type', () => {
  test('comes from the listing and dependencies, with the local markers', () => {
    expect(DashboardService.detectRemoteProjectType({ rootEntries: ['package.json'], packageDeps: ['react'] })).toMatchObject({ type: 'react' });
    expect(DashboardService.detectRemoteProjectType({ rootEntries: ['Cargo.toml', 'src'], packageDeps: [] })).toMatchObject({ type: 'rust' });
    expect(DashboardService.detectRemoteProjectType({ rootEntries: ['init.lua'], packageDeps: [] })).toMatchObject({ type: 'lua' });
    expect(DashboardService.detectRemoteProjectType({ rootEntries: ['README'], packageDeps: [] })).toBeNull();
    expect(DashboardService.detectRemoteProjectType(null)).toBeNull();
  });
});

describe('disk cache location', () => {
  test('a remote project caches under remote-cache on this machine, a local one in its folder as before', () => {
    expect(DashboardService.getDiskCachePath(REMOTE.path)).toBe(CACHE_FILE);
    expect(DashboardService.getDiskCachePath(LOCAL.path)).toBe(nodePath.join('/code/app', '.claude-terminal'));
  });

  test('a remote path that is no registered project has no cache file', () => {
    expect(DashboardService.getDiskCachePath('ssh-remote://abcd1234/elsewhere')).toBeNull();
  });
});

describe('dashboard of a remote project', () => {
  test('while the host is away: last known data, a note, and no request to the host', async () => {
    applyHostStatus({ profileId: 'abcd1234', state: 'reconnecting' });
    DashboardService.invalidateCache('r1');
    const container = document.createElement('div');
    await DashboardService.renderDashboard(container, REMOTE, {});
    const note = container.querySelector('.dashboard-remote-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('yanis@build');
    expect(container.innerHTML).toContain('cached-branch');
    expect(window.electron_api.git.infoFull).not.toHaveBeenCalled();
    expect(window.electron_api.project.stats).not.toHaveBeenCalled();
    expect(fsp.readdir).not.toHaveBeenCalled();
    DashboardService.cancelRender(container);
  });

  test('renders again once the host connects, and caches locally under remote-cache', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      applyHostStatus({ profileId: 'abcd1234', state: 'connecting' });
      DashboardService.invalidateCache('r1');
      const container = document.createElement('div');
      await DashboardService.renderDashboard(container, REMOTE, {});
      expect(window.electron_api.git.infoFull).not.toHaveBeenCalled();

      applyHostStatus({ profileId: 'abcd1234', state: 'connected' });
      for (let i = 0; i < 20; i++) { jest.advanceTimersByTime(20); await Promise.resolve(); }
      await jest.runOnlyPendingTimersAsync();
      for (let i = 0; i < 5; i++) await jest.runOnlyPendingTimersAsync();

      expect(window.electron_api.git.infoFull).toHaveBeenCalledWith(REMOTE.path);
      expect(window.electron_api.project.stats).toHaveBeenCalledWith(REMOTE.path);
      expect(container.querySelector('.dashboard-remote-note')).toBeNull();
      expect(DashboardService.getCachedData('r1').projectType).toMatchObject({ type: 'react' });
      expect(fsp.readdir).not.toHaveBeenCalled();
      expect(fsp.mkdir).toHaveBeenCalledWith(nodePath.dirname(CACHE_FILE), { recursive: true });
      expect(fsp.writeFile).toHaveBeenCalledWith(CACHE_FILE, expect.any(String), 'utf-8');
      DashboardService.cancelRender(container);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a remote project recorded with another type: the type section comes from forProject, with a note saying why', async () => {
    const registry = require('../../src/project-types/registry');
    const typed = { ...REMOTE, id: 'r2', type: 'fivem' };
    applyHostStatus({ profileId: 'abcd1234', state: 'reconnecting' });
    DashboardService.invalidateCache('r2');
    const container = document.createElement('div');
    await DashboardService.renderDashboard(container, typed, {});
    expect(registry.forProject).toHaveBeenCalledWith(typed);
    const note = container.querySelector('.dashboard-remote-type-note');
    expect(note).not.toBeNull();
    expect(note.title).toBe(require('../../src/renderer/i18n').t('ssh.disabled.typeDashboards'));
    expect(fsp.readdir).not.toHaveBeenCalled();
    expect(window.electron_api.git.infoFull).not.toHaveBeenCalled();
    DashboardService.cancelRender(container);
  });

  test('a general remote project has no type note', async () => {
    applyHostStatus({ profileId: 'abcd1234', state: 'reconnecting' });
    DashboardService.invalidateCache('r1');
    const container = document.createElement('div');
    await DashboardService.renderDashboard(container, REMOTE, {});
    expect(container.querySelector('.dashboard-remote-type-note')).toBeNull();
    DashboardService.cancelRender(container);
  });

  test('briefing while the host is away: no session or TODO request, history on the host, no cost', async () => {
    applyHostStatus({ profileId: 'abcd1234', state: 'reconnecting' });
    DashboardService.invalidateCache('r1');
    const container = document.createElement('div');
    await DashboardService.renderDashboard(container, REMOTE, {});
    for (let i = 0; i < 5; i++) await flush();
    expect(window.electron_api.claude.sessions).not.toHaveBeenCalled();
    expect(window.electron_api.project.scanTodos).not.toHaveBeenCalled();
    expect(window.electron_api.cost.getReport).not.toHaveBeenCalled();
    const { t } = require('../../src/renderer/i18n');
    expect(container.querySelector('[data-dash="resume"]').textContent).toContain(t('ssh.terminal.historyOnHost', { host: 'yanis@build' }));
    const cost = container.querySelector('.dash-metrics [data-metric="cost"]');
    expect(cost.textContent).toContain('-');
    expect(cost.title).toBe(t('ssh.disabled.costReport'));
    DashboardService.cancelRender(container);
  });

  test('briefing once connected: sessions and TODOs come from the host by URI, cost stays withheld', async () => {
    applyHostStatus({ profileId: 'abcd1234', state: 'connected' });
    DashboardService.invalidateCache('r1');
    const container = document.createElement('div');
    await DashboardService.renderDashboard(container, REMOTE, {});
    for (let i = 0; i < 10; i++) await flush();
    expect(window.electron_api.claude.sessions).toHaveBeenCalledWith(REMOTE.path);
    expect(window.electron_api.project.scanTodos).toHaveBeenCalledWith(REMOTE.path);
    expect(window.electron_api.cost.getReport).not.toHaveBeenCalled();
    expect(container.querySelector('[data-resume="rs-1"]')).not.toBeNull();
    expect(container.querySelector('.dash-metrics [data-metric="cost"]').title).toBe(require('../../src/renderer/i18n').t('ssh.disabled.costReport'));
    // The activity chart shows commits only, not a $0 cost series.
    expect(container.querySelector('[data-dash="activity"] .tone-accent')).toBeNull();
    DashboardService.cancelRender(container);
  });

  test('overview card of a remote project withholds its cost, a local one keeps it', async () => {
    const container = document.createElement('div');
    DashboardService.renderOverview(container, [REMOTE, LOCAL], { dataMap: {}, timesMap: {} });
    for (let i = 0; i < 5; i++) await flush();
    DashboardService.renderOverview(container, [REMOTE, LOCAL], { dataMap: {}, timesMap: {} });
    const [remoteCard, localCard] = container.querySelectorAll('.overview-card');
    expect(remoteCard.querySelector('.dash-card-stats > div').title).toBe(require('../../src/renderer/i18n').t('ssh.disabled.costReport'));
    expect(remoteCard.querySelector('.dash-card-value').textContent).toBe('-');
    expect(localCard.querySelector('.dash-card-stats > div').title).toBe('');
    expect(localCard.querySelector('.dash-card-value').textContent).toMatch(/9/);
  });

  test('the header shows where a remote project lives, and Open folder says why it cannot', async () => {
    // It used to print the raw ssh-remote://<profile id>/... URI, copy that,
    // and offer an Open folder button that only answered with a toast.
    applyHostStatus({ profileId: 'abcd1234', state: 'reconnecting' });
    DashboardService.invalidateCache('r1');
    const container = document.createElement('div');
    await DashboardService.renderDashboard(container, REMOTE, {});
    expect(container.querySelector('.dash-path code').textContent).toBe('yanis@build:/home/yanis/api');
    const openFolder = container.querySelector('#dash-btn-open-folder');
    expect(openFolder.getAttribute('aria-disabled')).toBe('true');
    expect(openFolder.classList.contains('is-disabled')).toBe(true);
    expect(openFolder.title).toBeTruthy();
    DashboardService.cancelRender(container);

    DashboardService.invalidateCache('l1');
    const local = document.createElement('div');
    fsp.readdir = jest.fn(async () => ['package.json']);
    await DashboardService.renderDashboard(local, LOCAL, {});
    await flush();
    expect(local.querySelector('.dash-path code').textContent).toBe(LOCAL.path);
    const localOpen = local.querySelector('#dash-btn-open-folder');
    expect(localOpen.hasAttribute('aria-disabled')).toBe(false);
    expect(localOpen.className).toBe('btn-secondary');
    expect(localOpen.hasAttribute('title')).toBe(false);
    DashboardService.cancelRender(local);
  });

  test('a local project loads exactly as before', async () => {
    DashboardService.invalidateCache('l1');
    const container = document.createElement('div');
    fsp.readdir = jest.fn(async () => ['package.json']);
    await DashboardService.renderDashboard(container, LOCAL, {});
    await flush();
    expect(window.electron_api.git.infoFull).toHaveBeenCalledWith(LOCAL.path);
    expect(container.querySelector('.dashboard-remote-note')).toBeNull();
    expect(container.querySelector('.dashboard-remote-type-note')).toBeNull();
    expect(fsp.readdir).toHaveBeenCalledWith(LOCAL.path);
    DashboardService.cancelRender(container);
  });
});
