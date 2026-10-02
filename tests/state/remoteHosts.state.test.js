/**
 * The renderer's mirror of SSH hosts (design/remote-ssh.md section 6).
 *
 * What matters most here is what does NOT happen: loading the profiles, the
 * startup restore and a boot-time tab selection never connect a host. A host
 * connects when the user opens one of its projects or clicks its badge.
 */

const fs = require('fs');
const path = require('path');

const PROFILE = { id: 'abcd1234', label: 'Build', host: 'build.example.com', user: 'yanis', port: 22 };

function makeSshApi(overrides = {}) {
  const listeners = [];
  return {
    listeners,
    listProfiles: jest.fn(async () => ({ success: true, profiles: [PROFILE], statuses: [] })),
    connect: jest.fn(async (profileId) => ({ success: true, status: { profileId, state: 'connected', detail: null, retryAt: null, capabilities: null } })),
    disconnect: jest.fn(async (profileId) => ({ success: true, status: { profileId, state: 'idle', detail: null, retryAt: null, capabilities: null } })),
    networkOnline: jest.fn(),
    saveProfile: jest.fn(async (p) => ({ success: true, profile: { ...p, id: p.id || 'newid123' } })),
    deleteProfile: jest.fn(async () => ({ success: true, deleted: true })),
    testProfile: jest.fn(async () => ({ success: true, result: { ok: true } })),
    onStatusChanged: jest.fn((cb) => { listeners.push(cb); return () => {}; }),
    ...overrides,
  };
}

let hosts;
let projects;
let ssh;

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  ssh = makeSshApi();
  window.electron_api.ssh = ssh;
  projects = require('../../src/renderer/state/projects.state');
  hosts = require('../../src/renderer/state/remoteHosts.state');
  projects.projectsState.set({ projects: [], folders: [], rootOrder: [], selectedProjectFilter: null, openedProjectId: null, openProjectIds: [] });
});

afterEach(() => {
  hosts._resetForTests();
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  delete window.electron_api.ssh;
});

const remoteProject = (id = 'r1', profileId = PROFILE.id, dir = '/home/yanis/api') => ({
  id, name: path.posix.basename(dir), type: 'general', folderId: null,
  path: `ssh-remote://${profileId}${dir}`,
  remote: { profileId, path: dir, hostLabel: 'yanis@build.example.com' },
});

describe('loading', () => {
  test('lists profiles and statuses, never connects', async () => {
    ssh.listProfiles.mockResolvedValueOnce({ success: true, profiles: [PROFILE], statuses: [{ profileId: PROFILE.id, state: 'reconnecting', detail: { attempt: 2 }, retryAt: 5 }] });
    await hosts.loadRemoteHosts();
    hosts.watchRemoteHosts();
    expect(hosts.getHostProfiles()).toEqual([PROFILE]);
    expect(hosts.getHostStatus(PROFILE.id).state).toBe('reconnecting');
    expect(hosts.getHostStatus('zzzz9999').state).toBe('idle');
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  test('an unreadable store keeps the previous list and records the error', async () => {
    await hosts.loadRemoteHosts();
    ssh.listProfiles.mockResolvedValueOnce({ success: false, code: 'REMOTE_HOSTS_UNREADABLE', error: 'bad json' });
    await hosts.loadRemoteHosts();
    expect(hosts.getHostProfiles()).toEqual([PROFILE]);
    expect(hosts.remoteHostsState.get().error).toEqual({ code: 'REMOTE_HOSTS_UNREADABLE', message: 'bad json' });
  });

  test('status broadcasts are folded in, and the window online event reaches main', async () => {
    await hosts.loadRemoteHosts();
    hosts.watchRemoteHosts();
    ssh.listeners[0]({ profileId: PROFILE.id, state: 'authFailed', detail: { kind: 'auth' } });
    expect(hosts.getHostStatus(PROFILE.id).state).toBe('authFailed');
    window.dispatchEvent(new Event('online'));
    expect(ssh.networkOnline).toHaveBeenCalledTimes(1);
  });
});

describe('getProjectHost', () => {
  test('null for a local project', async () => {
    await hosts.loadRemoteHosts();
    expect(hosts.getProjectHost({ id: 'l', path: 'C:\\code\\app' })).toBeNull();
  });

  test('a known profile gives its label and state', async () => {
    await hosts.loadRemoteHosts();
    const host = hosts.getProjectHost(remoteProject());
    expect(host).toMatchObject({ profileId: PROFILE.id, remotePath: '/home/yanis/api', hostLabel: 'yanis@build.example.com', state: 'idle' });
  });

  test('a project synced from a machine whose profile is not here is unconfigured', async () => {
    await hosts.loadRemoteHosts();
    const host = hosts.getProjectHost(remoteProject('r2', 'zzzz9999'));
    expect(host.state).toBe('unconfigured');
    expect(host.hostLabel).toBe('yanis@build.example.com');
    expect(host.profile).toBeNull();
  });

  test('before the profiles load, an unknown profile is not reported as unconfigured', () => {
    expect(hosts.getProjectHost(remoteProject('r2', 'zzzz9999')).state).toBe('idle');
  });
});

describe('connecting', () => {
  test('opening a remote project connects an idle host', async () => {
    await hosts.loadRemoteHosts();
    await hosts.connectProjectHost(remoteProject());
    expect(ssh.connect).toHaveBeenCalledWith(PROFILE.id);
    expect(hosts.getHostStatus(PROFILE.id).state).toBe('connected');
  });

  test.each(['authFailed', 'hostKeyUnknown', 'hostKeyChanged', 'unsupported', 'connecting', 'connected'])('opening a project does not reconnect a host in %s', async (state) => {
    await hosts.loadRemoteHosts();
    hosts.applyHostStatus({ profileId: PROFILE.id, state });
    await hosts.connectProjectHost(remoteProject());
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  test('opening a local project or one with an unknown host connects nothing', async () => {
    await hosts.loadRemoteHosts();
    await hosts.connectProjectHost({ id: 'l', path: '/srv/local' });
    await hosts.connectProjectHost(remoteProject('r2', 'zzzz9999'));
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  test('an explicit connect retries a stopped state', async () => {
    await hosts.loadRemoteHosts();
    hosts.applyHostStatus({ profileId: PROFILE.id, state: 'authFailed' });
    await hosts.connectHost(PROFILE.id);
    expect(ssh.connect).toHaveBeenCalledWith(PROFILE.id);
  });
});

describe('startup restore', () => {
  test('restoring open tabs and the last selection connects nothing', async () => {
    const remote = remoteProject();
    projects.projectsState.set({ projects: [remote, { id: 'l1', name: 'local', path: '/srv/local', type: 'standalone', folderId: null }], rootOrder: ['r1', 'l1'] });
    // initializeState(): load, watch, restore the tab list.
    await hosts.loadRemoteHosts();
    hosts.watchRemoteHosts();
    projects.restoreOpenProjectIds(['r1', 'l1']);
    // renderer.js session restore: lastOpenedProjectId, then the first open tab.
    projects.setSelectedProjectFilter(0);
    projects.openProjectTab('r1');
    await jest.runOnlyPendingTimersAsync();
    expect(ssh.connect).not.toHaveBeenCalled();
  });

  test('the session restore loop in renderer.js skips remote projects before any fs probe', () => {
    // The loop lives in the renderer entry point, which cannot be loaded in
    // jsdom. Pin its guard instead: a remote project must be skipped before
    // fileExists() is asked about its URI or a tab is created for it.
    const src = fs.readFileSync(path.join(__dirname, '../../renderer.js'), 'utf8');
    const loop = src.slice(src.indexOf('// Restore terminal sessions from previous run'));
    const guard = loop.indexOf('if (isRemoteProject(project)) continue;');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(loop.indexOf('await fileExists(project.path)'));
    expect(guard).toBeLessThan(loop.indexOf('TerminalManager.createTerminal(project'));
    const sweep = src.slice(src.indexOf('async function checkAllProjectsGitStatus'));
    expect(sweep.indexOf('isRemoteProject(project)')).toBeLessThan(sweep.indexOf('api.git.statusQuick'));
  });
});

describe('idle disconnect', () => {
  test('a connected host no open project uses is disconnected after ten minutes', async () => {
    await hosts.loadRemoteHosts();
    hosts.watchRemoteHosts();
    hosts.applyHostStatus({ profileId: PROFILE.id, state: 'connected' });
    jest.advanceTimersByTime(hosts.IDLE_DISCONNECT_MS - 1000);
    expect(ssh.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2000);
    expect(ssh.disconnect).toHaveBeenCalledWith(PROFILE.id);
  });

  test('an open project, or a dialog holding the host, keeps it connected', async () => {
    projects.projectsState.set({ projects: [remoteProject()], rootOrder: ['r1'], openProjectIds: ['r1'] });
    await hosts.loadRemoteHosts();
    hosts.watchRemoteHosts();
    hosts.applyHostStatus({ profileId: PROFILE.id, state: 'connected' });
    jest.advanceTimersByTime(hosts.IDLE_DISCONNECT_MS * 2);
    expect(ssh.disconnect).not.toHaveBeenCalled();

    projects.projectsState.set({ openProjectIds: [] });
    const release = hosts.holdHost(PROFILE.id);
    jest.advanceTimersByTime(hosts.IDLE_DISCONNECT_MS * 2);
    expect(ssh.disconnect).not.toHaveBeenCalled();
    release();
    jest.advanceTimersByTime(hosts.IDLE_DISCONNECT_MS + 1);
    expect(ssh.disconnect).toHaveBeenCalledWith(PROFILE.id);
  });
});

describe('profiles go through main', () => {
  test('save sends the fields and reloads the list', async () => {
    const res = await hosts.saveHostProfile({ host: 'x.example.com' });
    expect(res.success).toBe(true);
    expect(ssh.saveProfile).toHaveBeenCalledWith({ host: 'x.example.com' });
    expect(ssh.listProfiles).toHaveBeenCalled();
  });

  test('hostLabelOf prefers the alias, and shows a non-default port', () => {
    expect(hosts.hostLabelOf({ sshConfigAlias: 'box', host: 'h' })).toBe('box');
    expect(hosts.hostLabelOf({ host: 'h', user: 'u', port: 2222 })).toBe('u@h:2222');
    expect(hosts.hostLabelOf({ host: 'h', port: 22 })).toBe('h');
  });
});
