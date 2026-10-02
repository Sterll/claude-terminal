/**
 * Git status of remote (SSH) projects outside the Git panel
 * (design/remote-ssh.md section 5.4).
 *
 * renderer.js cannot be loaded in jsdom, so its two rules are pinned on the
 * source, the way tests/state/remoteHosts.state.test.js pins the session
 * restore guard:
 *   - checkProjectGitStatus() leaves a remote project alone unless its host is
 *     connected (a read would otherwise connect it, or wait on it);
 *   - watchRemoteGitStatus() is installed, and fills remote projects in when
 *     their host reaches `connected`.
 * The Control Tower's branch reader is exercised for real: it asks git on the
 * host for a remote project, only while connected, and never reads .git/HEAD
 * out of a URI.
 */

const fs = require('fs');
const path = require('path');

describe('renderer.js git sweep', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../renderer.js'), 'utf8');

  function body(name) {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf('\nfunction ', start + 10);
    const nextAsync = src.indexOf('\nasync function ', start + 10);
    const ends = [next, nextAsync].filter((i) => i > 0);
    return src.slice(start, ends.length ? Math.min(...ends) : undefined);
  }

  test('checkProjectGitStatus returns for a remote project whose host is not connected, before any git call', () => {
    const fn = body('checkProjectGitStatus');
    const guard = fn.indexOf("isRemoteProject(project) && getProjectHost(project)?.state !== 'connected'");
    const firstCall = fn.indexOf('api.git.');
    expect(guard).toBeGreaterThan(-1);
    expect(firstCall).toBeGreaterThan(guard);
  });

  test('watchRemoteGitStatus is installed and re-checks the projects of a host that just connected', () => {
    expect(src).toMatch(/\nwatchRemoteGitStatus\(\);/);
    const fn = body('watchRemoteGitStatus');
    expect(fn).toContain('remoteHostsState.subscribe(');
    expect(fn).toContain("host.state === 'connected' && lastState.get(host.profileId) !== 'connected'");
    expect(fn).toContain('checkProjectGitStatus(project)');
  });

  test('the startup sweep still leaves remote projects out', () => {
    const fn = body('checkAllProjectsGitStatus');
    const skip = fn.indexOf('if (isRemoteProject(project))');
    expect(skip).toBeGreaterThan(-1);
    expect(fn.indexOf('api.git.statusQuick')).toBeGreaterThan(skip);
  });

  test('the worktree modal builds a remote worktree path with POSIX rules', () => {
    const fn = body('openNewWorktreeModal');
    expect(fn).toContain('isRemoteProject(project) ? remotePathLib : window.electron_nodeModules.path');
  });
});

describe('Control Tower branch of a remote project', () => {
  const REMOTE_PATH = 'ssh-remote://abcd1234/home/yanis/api';
  let readFile;

  beforeEach(() => {
    jest.resetModules();
    readFile = jest.fn(async () => 'ref: refs/heads/local-branch\n');
    window.electron_nodeModules.fs.promises.readFile = readFile;
    window.electron_api.git = { currentBranch: jest.fn(async () => 'feature/remote') };
  });

  function load() {
    const { remoteHostsState } = require('../../src/renderer/state/remoteHosts.state');
    remoteHostsState.set({ profiles: [{ id: 'abcd1234', host: 'h' }], loaded: true, statuses: {} });
    return { panel: require('../../src/renderer/ui/panels/ControlTowerPanel'), remoteHostsState };
  }

  test('asks git on the host while connected, never .git/HEAD', async () => {
    const { panel, remoteHostsState } = load();
    remoteHostsState.set({ statuses: { abcd1234: { profileId: 'abcd1234', state: 'connected' } } });
    expect(await panel._getProjectBranch(REMOTE_PATH)).toBe('feature/remote');
    expect(window.electron_api.git.currentBranch).toHaveBeenCalledWith({ projectPath: REMOTE_PATH });
    expect(readFile).not.toHaveBeenCalled();
  });

  test('asks nothing while the host is not connected', async () => {
    const { panel, remoteHostsState } = load();
    remoteHostsState.set({ statuses: { abcd1234: { profileId: 'abcd1234', state: 'reconnecting' } } });
    expect(await panel._getProjectBranch(REMOTE_PATH)).toBeNull();
    expect(window.electron_api.git.currentBranch).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
