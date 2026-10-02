/**
 * Quick actions of a remote (SSH) project (design/remote-ssh.md 5.1).
 *
 * A quick action opens a terminal tab and types a command into it, so on a
 * remote project the command runs on the host. Its placeholders follow:
 * $PROJECT_PATH is the path on the host, $HOME is left for the remote shell to
 * expand, and $BRANCH comes from the same status map as for a local project.
 * A local project substitutes exactly as before.
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
      await Promise.resolve();
      jest.advanceTimersByTime(300);
      expect(input).toHaveBeenCalledWith({ id: 501, data: 'make -C /home/yanis/api\r' });
    } finally {
      jest.useRealTimers();
    }
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

  test('a remote project: host path, no branch read, $HOME literal', async () => {
    const fs = require('fs');
    const read = jest.spyOn(fs, 'readFileSync');
    const out = await node.run({ projectId: 'r1', action: 'Show' }, {}, null, { sendFn });
    expect(out.command).toBe('echo /home/yanis/api  $HOME');
    expect(read.mock.calls.some(([p]) => String(p).includes('.git'))).toBe(false);
    expect(sendFn).toHaveBeenCalledWith('mcp-terminal:send', expect.objectContaining({ projectId: 'r1', command: 'echo /home/yanis/api  $HOME' }));
    read.mockRestore();
  });

  test('a local project is substituted as before', async () => {
    const out = await node.run({ projectId: 'l2', action: 'Show' }, {}, null, { sendFn });
    expect(out.command).toBe(`echo ${os.tmpdir()} ${os.homedir()}`);
  });
});
