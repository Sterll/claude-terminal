/**
 * Remote (SSH) projects in the projects state (design/remote-ssh.md 3.2).
 *
 * The URI is the project's identity, so it is deduped exactly and
 * case-sensitively, and every local probe that would only ever fail on it
 * (the missing-path sweep, the account binding) leaves it alone. The local
 * rules next to it must not move.
 */

const {
  projectsState,
  addProject,
  getProject,
  getProjectAccount,
  checkMissingPaths,
  isPathMissing,
} = require('../../src/renderer/state/projects.state');

const PROFILE = 'abcd1234';

function resetState() {
  projectsState.set({ projects: [], folders: [], rootOrder: [], selectedProjectFilter: null, openedProjectId: null, openProjectIds: [] });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  resetState();
  window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
  window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('addProject with a remote block', () => {
  test('creates a general project with a URI path and the remote block', () => {
    const project = addProject({ remote: { profileId: PROFILE, path: '/home/yanis/api', hostLabel: 'yanis@build.example.com' } });
    expect(project).toMatchObject({
      type: 'general',
      name: 'api',
      path: 'ssh-remote://abcd1234/home/yanis/api',
      remote: { profileId: PROFILE, path: '/home/yanis/api', hostLabel: 'yanis@build.example.com' },
      folderId: null,
    });
    expect(projectsState.get().rootOrder).toContain(project.id);
  });

  test('the type is always general and the path is rebuilt from the remote block', () => {
    const project = addProject({
      type: 'fivem',
      path: 'C:\\somewhere\\local',
      accountId: 'acc-1',
      remote: { profileId: PROFILE, path: '/srv//app/./x/..', hostLabel: 'box' },
    });
    expect(project.type).toBe('general');
    expect(project.path).toBe('ssh-remote://abcd1234/srv/app');
    expect(project.remote.path).toBe('/srv/app');
    expect(project.accountId).toBeUndefined();
  });

  test('a URI path alone is enough', () => {
    const project = addProject({ path: 'ssh-remote://abcd1234/home/yanis/web' });
    expect(project).toMatchObject({ type: 'general', remote: { profileId: PROFILE, path: '/home/yanis/web', hostLabel: '' } });
  });

  test('adding the same URI twice returns the existing project', () => {
    const first = addProject({ remote: { profileId: PROFILE, path: '/home/yanis/api' } });
    const second = addProject({ path: 'ssh-remote://abcd1234/home/yanis/api/' });
    expect(second).toBe(first);
    expect(projectsState.get().projects).toHaveLength(1);
  });

  test('/home/A and /home/a on the same profile are two projects', () => {
    const upper = addProject({ remote: { profileId: PROFILE, path: '/home/A' } });
    const lower = addProject({ remote: { profileId: PROFILE, path: '/home/a' } });
    expect(upper).not.toBe(lower);
    expect(projectsState.get().projects.map(p => p.path)).toEqual(['ssh-remote://abcd1234/home/A', 'ssh-remote://abcd1234/home/a']);
  });

  test('the same path on two profiles is two projects', () => {
    const a = addProject({ remote: { profileId: PROFILE, path: '/srv/app' } });
    const b = addProject({ remote: { profileId: 'zzzz9999', path: '/srv/app' } });
    expect(a).not.toBe(b);
  });

  test.each([
    [{ remote: { profileId: 'BAD', path: '/srv' } }],
    [{ remote: { profileId: PROFILE, path: 'relative/dir' } }],
    [{ remote: { profileId: PROFILE, path: '/' } }],
    [{ remote: { profileId: PROFILE, path: '/srv/\nx' } }],
    [{ remote: { profileId: PROFILE, path: '/../etc' } }],
    [{ path: 'ssh-remote://nothing' }],
  ])('refuses %j', (data) => {
    expect(addProject(data)).toBeNull();
    expect(projectsState.get().projects).toHaveLength(0);
  });

  test('a remote project never dedupes against a local one', () => {
    const local = addProject({ path: '/home/yanis/api' });
    const remote = addProject({ remote: { profileId: PROFILE, path: '/home/yanis/api' } });
    expect(remote).not.toBe(local);
    expect(projectsState.get().projects).toHaveLength(2);
  });
});

describe('local dedupe is unchanged', () => {
  test('case and separators still fold for local paths', () => {
    const first = addProject({ path: 'C:\\Code\\App' });
    expect(addProject({ path: 'c:/code/app/' })).toBe(first);
    expect(first.type).toBe('standalone');
    expect(first.remote).toBeUndefined();
  });
});

describe('checkMissingPaths', () => {
  test('never flags a remote project, and never probes its URI', async () => {
    const access = window.electron_nodeModules.fs.promises.access;
    access.mockImplementation(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    const local = addProject({ path: '/gone/local' });
    const remote = addProject({ remote: { profileId: PROFILE, path: '/home/yanis/api' } });
    await checkMissingPaths();
    expect(isPathMissing(local.id)).toBe(true);
    expect(isPathMissing(remote.id)).toBe(false);
    expect(access.mock.calls.map(([p]) => p)).not.toContain(remote.path);
    access.mockReset();
  });
});

describe('getProjectAccount', () => {
  test('a remote project has no account binding, even a synced one', () => {
    const remote = addProject({ remote: { profileId: PROFILE, path: '/srv/x' } });
    projectsState.set({ projects: projectsState.get().projects.map(p => (p.id === remote.id ? { ...p, accountId: 'acc-1' } : p)) });
    expect(getProject(remote.id).accountId).toBe('acc-1');
    expect(getProjectAccount(remote.id)).toBeNull();
  });

  test('a local project keeps its binding', () => {
    const local = addProject({ path: '/srv/local', accountId: 'acc-2' });
    expect(getProjectAccount(local.id)).toBe('acc-2');
  });
});
