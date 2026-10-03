/**
 * Quick actions of a remote (SSH) project (design/remote-ssh.md 5.1).
 *
 * A quick action opens a terminal tab and types a command into it, so on a
 * remote project the command runs on the host. Its placeholders follow:
 * $PROJECT_PATH is the path on the host, $HOME is left for the remote shell to
 * expand, and $BRANCH is read on the host through the remote git primitives
 * while it is connected, and is empty only while it is not. A local project
 * substitutes exactly as before.
 *
 * The same rules hold for the workflow node that runs a quick action, which
 * must also not try to read `.git/HEAD` out of a URI.
 */

jest.mock('../../src/renderer/ui/components/Modal', () => ({
  createModal: jest.fn(), showModal: jest.fn(), closeModal: jest.fn(),
}));

const os = require('os');

const REMOTE = {
  id: 'r1',
  name: 'api',
  type: 'general',
  path: 'ssh-remote://abcd1234/home/yanis/api',
  remote: { profileId: 'abcd1234', path: '/home/yanis/api', hostLabel: 'yanis@build' },
};
const LOCAL = { id: 'l1', name: 'app', type: 'standalone', path: 'C:\\code\\app' };

describe('QuickActions placeholder substitution', () => {
  let qa;

  beforeEach(() => {
    jest.resetModules();
    window.electron_nodeModules.os = { ...window.electron_nodeModules.os, homedir: () => 'C:\\Users\\me' };
    const { QuickActions } = require('../../src/renderer/ui/components/QuickActions');
    qa = new QuickActions();
    qa.setGitRepoStatus(new Map([['l1', { branch: 'main' }], ['r1', { branch: 'feature/x' }]]));
  });

  const COMMAND = 'cd $PROJECT_PATH && echo $PROJECT_NAME $BRANCH $HOME';

  test('a local project is substituted exactly as before', () => {
    expect(qa._substituteVariables(COMMAND, LOCAL)).toBe('cd C:\\code\\app && echo app main C:\\Users\\me');
  });

  test('a remote project gets its host path and leaves $HOME literal', () => {
    expect(qa._substituteVariables(COMMAND, REMOTE)).toBe('cd /home/yanis/api && echo api feature/x $HOME');
  });

  test('a remote project without a remote block falls back to the path in its URI', () => {
    const bare = { id: 'r2', name: 'svc', path: 'ssh-remote://abcd1234/srv/svc' };
    expect(qa._substituteVariables('ls $PROJECT_PATH $HOME', bare)).toBe('ls /srv/svc $HOME');
  });

  test('a remote command is typed once the host has answered, not on a timer', async () => {
    jest.useFakeTimers();
    try {
      let dataCb = null;
      const input = jest.fn();
      qa._api = {
        terminal: {
          input,
          onData: (cb) => { dataCb = cb; return () => { dataCb = null; }; },
          onExit: () => () => {},
        },
      };
      const { projectsState } = require('../../src/renderer/state/projects.state');
      projectsState.set({ ...projectsState.get(), projects: [{ ...REMOTE, quickActions: [{ id: 'qa1', name: 'Build', command: 'make -C $PROJECT_PATH' }] }] });
      qa.setTerminalCallback(async () => 501);

      await qa.executeQuickAction(projectsState.get().projects[0], 'qa1');
      jest.advanceTimersByTime(5000);
      expect(input).not.toHaveBeenCalled();

      dataCb({ id: 501, data: 'Welcome to build\r\n$ ' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      jest.advanceTimersByTime(300);
      expect(input).toHaveBeenCalledWith({ id: 501, data: 'make -C /home/yanis/api\r' });
    } finally {
      jest.useRealTimers();
    }
  });

  /** Run a remote quick action whose command uses $BRANCH, with the host in `state`. */
  async function runRemoteBranchAction(state, currentBranch) {
    jest.useFakeTimers();
    try {
      const hosts = require('../../src/renderer/state/remoteHosts.state');
      hosts._resetForTests();
      hosts.remoteHostsState.set({ profiles: [{ id: 'abcd1234', host: 'build', user: 'yanis' }], loaded: true, statuses: {} });
      hosts.applyHostStatus({ profileId: 'abcd1234', state });
      let dataCb = null;
      const input = jest.fn();
      qa._api = {
        terminal: {
          input,
          onData: (cb) => { dataCb = cb; return () => { dataCb = null; }; },
          onExit: () => () => {},
        },
        git: { currentBranch },
      };
      // The startup sweep leaves a remote project with no branch in the map.
      qa.setGitRepoStatus(new Map([['r1', { isGitRepo: false }]]));
      const { projectsState } = require('../../src/renderer/state/projects.state');
      projectsState.set({ ...projectsState.get(), projects: [{ ...REMOTE, quickActions: [{ id: 'qa2', name: 'Deploy', command: 'deploy $BRANCH' }] }] });
      qa.setTerminalCallback(async () => 502);
      await qa.executeQuickAction(projectsState.get().projects[0], 'qa2');
      dataCb({ id: 502, data: '$ ' });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      jest.advanceTimersByTime(300);
      return input;
    } finally {
      jest.useRealTimers();
    }
  }

  test('$BRANCH of a remote project is read on its host while it is connected', async () => {
    const currentBranch = jest.fn(async () => 'feature/remote');
    const input = await runRemoteBranchAction('connected', currentBranch);
    expect(currentBranch).toHaveBeenCalledWith({ projectPath: REMOTE.path });
    expect(input).toHaveBeenCalledWith({ id: 502, data: 'deploy feature/remote\r' });
  });

  test('$BRANCH is empty while the host is not connected, and the host is not asked', async () => {
    const currentBranch = jest.fn(async () => 'feature/remote');
    const input = await runRemoteBranchAction('reconnecting', currentBranch);
    expect(currentBranch).not.toHaveBeenCalled();
    expect(input).toHaveBeenCalledWith({ id: 502, data: 'deploy \r' });
  });

  test('a local project still takes $BRANCH from the status map, synchronously', () => {
    expect(qa._substituteVariables('git push origin $BRANCH', LOCAL)).toBe('git push origin main');
  });
});

describe('quickaction workflow node', () => {
  let node, sendFn;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../src/main/workflow-nodes/_projects', () => ({
      findProjectRecord: (ref) => [REMOTE_RECORD, LOCAL_RECORD].find((p) => p.id === ref) || null,
      projectLabel: (p) => p.name,
    }));
    node = require('../../src/main/workflow-nodes/quickaction.node');
    sendFn = jest.fn();
  });

  afterEach(() => jest.dontMock('../../src/main/workflow-nodes/_projects'));

  const REMOTE_RECORD = { ...REMOTE, quickActions: [{ id: 'a', name: 'Show', command: 'echo $PROJECT_PATH $BRANCH $HOME' }] };
  const LOCAL_RECORD = { id: 'l2', name: 'here', path: os.tmpdir(), quickActions: [{ id: 'b', name: 'Show', command: 'echo $PROJECT_PATH $HOME' }] };

  /** The host service and git.js the node reaches for a remote project. */
  function mockHost(state, branch) {
    const getCurrentBranch = jest.fn(async () => branch);
    jest.doMock('../../src/main/services/SshHostService', () => ({ getStatus: () => ({ state }) }));
    jest.doMock('../../src/main/utils/git', () => ({ getCurrentBranch }));
    node = require('../../src/main/workflow-nodes/quickaction.node');
    return getCurrentBranch;
  }

  afterEach(() => {
    jest.dontMock('../../src/main/services/SshHostService');
    jest.dontMock('../../src/main/utils/git');
  });

  test('a remote project whose host is not connected: host path, no branch, $HOME literal, no .git read', async () => {
    const getCurrentBranch = mockHost('reconnecting', 'main');
    const fs = require('fs');
    const read = jest.spyOn(fs, 'readFileSync');
    const out = await node.run({ projectId: 'r1', action: 'Show' }, {}, null, { sendFn });
    expect(out.command).toBe('echo /home/yanis/api  $HOME');
    expect(getCurrentBranch).not.toHaveBeenCalled();
    expect(read.mock.calls.some(([p]) => String(p).includes('.git'))).toBe(false);
    expect(sendFn).toHaveBeenCalledWith('mcp-terminal:send', expect.objectContaining({ projectId: 'r1', command: 'echo /home/yanis/api  $HOME' }));
    read.mockRestore();
  });

  test('a remote project whose host is connected: $BRANCH is read on the host by URI', async () => {
    const getCurrentBranch = mockHost('connected', 'release/2');
    const out = await node.run({ projectId: 'r1', action: 'Show' }, {}, null, { sendFn });
    expect(getCurrentBranch).toHaveBeenCalledWith(REMOTE.path);
    expect(out.command).toBe('echo /home/yanis/api release/2 $HOME');
  });

  test('a remote branch read that fails leaves $BRANCH empty rather than failing the node', async () => {
    const getCurrentBranch = mockHost('connected', null);
    getCurrentBranch.mockRejectedValueOnce(new Error('boom'));
    const out = await node.run({ projectId: 'r1', action: 'Show' }, {}, null, { sendFn });
    expect(out.command).toBe('echo /home/yanis/api  $HOME');
  });

  test('a local project is substituted as before', async () => {
    const out = await node.run({ projectId: 'l2', action: 'Show' }, {}, null, { sendFn });
    expect(out.command).toBe(`echo ${os.tmpdir()} ${os.homedir()}`);
  });
});
