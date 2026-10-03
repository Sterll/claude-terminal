/** @jest-environment node */
/**
 * Remote (SSH) projects and the local-only parts of the workflow engine and
 * parallel tasks (design/remote-ssh.md section 8): nodes that execute or read
 * on this machine refuse a remote project with the `workflowNodes` reason
 * instead of failing on a URI or falling back to the home directory, the
 * scheduler never watches a remote project, and parallel runs refuse one in
 * main. Local projects are checked alongside, to show they still behave as
 * before.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('chokidar', () => ({
  watch: jest.fn(() => Object.assign(new (require('events').EventEmitter)(), { close: jest.fn() })),
}));

const REFUSED = 'Remote projects are not supported by workflow nodes yet';
const REMOTE_URI = 'ssh-remote://abcd1234/srv/api';

let home;
let localDir;

function writeProjects() {
  fs.mkdirSync(path.join(home, '.claude-terminal'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-terminal', 'projects.json'), JSON.stringify({
    projects: [
      { id: 'local-1', name: 'Local App', path: localDir, type: 'general' },
      { id: 'remote-1', name: 'Remote Api', path: REMOTE_URI, type: 'general', remote: { profileId: 'abcd1234', path: '/srv/api', hostLabel: 'u@build' } },
    ],
  }));
}

const varsFor = (project, extra = {}) => new Map([['ctx', { project, ...extra }]]);
const node = (name) => require(`../../src/main/workflow-nodes/${name}.node.js`);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-wf-remote-'));
  localDir = path.join(home, 'local-app');
  fs.mkdirSync(localDir, { recursive: true });
  jest.spyOn(os, 'homedir').mockReturnValue(home);
  writeProjects();
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('workflow nodes refuse a remote project', () => {
  test('shell: a run context on a remote project, or a picked remote project, is refused before anything runs', async () => {
    const shell = node('shell');
    await expect(shell.run({ command: 'echo hi' }, varsFor(REMOTE_URI))).rejects.toThrow(REFUSED);
    await expect(shell.run({ command: 'echo hi', projectId: 'remote-1' }, varsFor(''))).rejects.toThrow(REFUSED);
    await expect(shell.run({ command: 'echo hi', cwd: REMOTE_URI }, varsFor(''))).rejects.toThrow(REFUSED);
  });

  test('shell: a local project still runs', async () => {
    const out = await node('shell').run({ command: 'echo local-ok' }, varsFor(localDir));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('local-ok');
  });

  test('git: a URI or a remote project id is refused, a missing local cwd keeps its own message', async () => {
    const git = node('git');
    await expect(git.run({ action: 'pull', projectId: REMOTE_URI }, varsFor(''))).rejects.toThrow(REFUSED);
    await expect(git.run({ action: 'pull', projectId: 'remote-1' }, varsFor(''))).rejects.toThrow(REFUSED);
    await expect(git.run({ action: 'pull' }, varsFor(REMOTE_URI))).rejects.toThrow(REFUSED);
    await expect(git.run({ action: 'pull', projectId: path.join(home, 'nowhere') }, varsFor('')))
      .rejects.toThrow('a valid project working directory is required');
  });

  test('file: a remote run context or a URI path is refused, a local read still works', async () => {
    const file = node('file');
    await expect(file.run({ action: 'read', path: 'README.md' }, varsFor(REMOTE_URI))).rejects.toThrow(REFUSED);
    await expect(file.run({ action: 'exists', path: `${REMOTE_URI}/x` }, varsFor(''))).rejects.toThrow(REFUSED);
    fs.writeFileSync(path.join(localDir, 'a.txt'), 'hello');
    const out = await file.run({ action: 'read', path: path.join(localDir, 'a.txt') }, varsFor(localDir));
    expect(JSON.stringify(out)).toContain('hello');
  });

  test('claude: no silent fallback to the home directory for a URI', async () => {
    const chatService = { runSinglePrompt: jest.fn(async () => ({ text: 'ok' })) };
    const claude = node('claude');
    await expect(claude.run({ prompt: 'hi' }, varsFor(REMOTE_URI), null, { chatService })).rejects.toThrow(REFUSED);
    await expect(claude.run({ prompt: 'hi', projectId: 'remote-1' }, varsFor(''), null, { chatService })).rejects.toThrow(REFUSED);
    await expect(claude.run({ prompt: 'hi', cwd: REMOTE_URI }, varsFor(''), null, { chatService })).rejects.toThrow(REFUSED);
    expect(chatService.runSinglePrompt).not.toHaveBeenCalled();
  });

  test('claude: a missing local cwd still falls back to the home directory, as before', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const chatService = { runSinglePrompt: jest.fn(async () => ({ text: 'ok' })) };
    await node('claude').run({ prompt: 'hi', cwd: path.join(home, 'gone') }, varsFor(''), null, { chatService });
    expect(chatService.runSinglePrompt).toHaveBeenCalledWith(expect.objectContaining({ cwd: home }));
  });

  test('terminal: a remote project is refused before anything is sent', async () => {
    const sendFn = jest.fn();
    await expect(node('terminal').run({ action: 'send', projectId: 'remote-1', command: 'ls' }, varsFor(''), null, { sendFn }))
      .rejects.toThrow(REFUSED);
    expect(sendFn).not.toHaveBeenCalled();
    await node('terminal').run({ action: 'send', projectId: 'local-1', command: 'ls' }, varsFor(''), null, { sendFn });
    expect(sendFn).toHaveBeenCalledWith('mcp-terminal:send', expect.objectContaining({ projectId: 'local-1', command: 'ls' }));
  });

  test('session_recap and parallel_spawn refuse a remote project', async () => {
    await expect(node('session_recap').run({ projectId: 'remote-1', sessionId: 's1' }, varsFor(''))).rejects.toThrow(REFUSED);
    await expect(node('parallel_spawn').run({ projectId: 'remote-1', goal: 'do it' }, varsFor(''))).rejects.toThrow(REFUSED);
  });

  test('the refusal carries the capability code and reason key', async () => {
    const err = await node('shell').run({ command: 'echo hi' }, varsFor(REMOTE_URI)).catch(e => e);
    expect(err.code).toBe('REMOTE_UNSUPPORTED');
    expect(err.reasonKey).toBe('ssh.disabled.workflowNodes');
  });

  test('quickaction and kanban card pickers keep remote projects; the other pickers do not', () => {
    const pickerOf = (name) => node(name).fields.find(f => f.type === 'cwd-picker');
    expect(pickerOf('quickaction').allowRemote).toBe(true);
    expect(pickerOf('kanban_create_card').allowRemote).toBe(true);
    for (const name of ['shell', 'git', 'terminal', 'session_recap', 'parallel_spawn']) {
      expect(pickerOf(name).allowRemote).toBeFalsy();
    }
  });
});

describe('WorkflowRunner legacy steps', () => {
  function makeRunner(chatService) {
    const WorkflowRunner = require('../../src/main/services/WorkflowRunner');
    return new WorkflowRunner({ sendFn: jest.fn(), chatService, waitCallbacks: new Map() });
  }

  test('the legacy Claude step refuses a URI instead of running in the home directory', async () => {
    const chatService = { runSinglePrompt: jest.fn(async () => ({ text: 'ok' })) };
    const runner = makeRunner(chatService);
    const vars = varsFor(REMOTE_URI);
    await expect(runner._dispatchStep({ type: 'agent', prompt: 'hi' }, vars, 'run-1', null, null)).rejects.toThrow(REFUSED);
    expect(chatService.runSinglePrompt).not.toHaveBeenCalled();
  });
});

describe('WorkflowScheduler never watches a remote project', () => {
  let scheduler;
  const wf = (id, trigger) => ({ id, enabled: true, trigger });

  beforeEach(() => {
    const Scheduler = require('../../src/main/services/WorkflowScheduler');
    scheduler = new Scheduler();
    scheduler.resolveProjectPath = (id) => (id === 'remote-1' ? REMOTE_URI : id === 'local-1' ? localDir : null);
  });

  afterEach(() => scheduler.destroy());

  test('file_change and git_event skip a remote project with one warning, and report why', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const chokidar = require('chokidar');
    chokidar.watch.mockClear();
    const workflows = [
      wf('files', { type: 'file_change', projectId: 'remote-1' }),
      wf('git', { type: 'git_event', projectId: 'remote-1' }),
      wf('custom', { type: 'file_change', watchPath: `${REMOTE_URI}/src` }),
    ];
    scheduler.reload(workflows);
    scheduler.reload(workflows);

    expect(chokidar.watch).not.toHaveBeenCalled();
    expect(scheduler._fileWatchers.size).toBe(0);
    expect(scheduler._gitWatchers.size).toBe(0);
    const remoteWarnings = warn.mock.calls.filter(c => String(c[0]).includes('not supported by file_change and git_event'));
    expect(remoteWarnings).toHaveLength(3);

    const statuses = scheduler.getTriggerStatuses();
    expect(statuses).toHaveLength(3);
    for (const s of statuses) {
      expect(s.status).toBe('error');
      expect(s.error).toBe('Remote projects are not supported by file_change and git_event triggers yet');
    }
  });

  test('a local project is still watched', () => {
    const chokidar = require('chokidar');
    chokidar.watch.mockClear();
    scheduler.reload([wf('files', { type: 'file_change', projectId: 'local-1' })]);
    expect(chokidar.watch).toHaveBeenCalledTimes(1);
    expect(scheduler._fileWatchers.has('files::local-1')).toBe(true);
  });

  test('a workflow watching a local and a remote project keeps the local watcher', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    scheduler.reload([wf('both', { type: 'file_change', projectIds: ['local-1', 'remote-1'] })]);
    expect([...scheduler._fileWatchers.keys()]).toEqual(['both::local-1']);
  });
});

describe('ParallelTaskService refuses a remote project', () => {
  let service;
  let git;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../src/main/services/ChatService', () => ({}));
    jest.doMock('../../src/main/utils/git', () => {
      const fn = () => jest.fn(async () => ({ success: true }));
      return {
        createWorktree: fn(), removeWorktree: fn(), FORCE_UNLOCK: 2, gitMerge: fn(), gitMergeAbort: fn(),
        gitMergeContinue: fn(), getMergeConflicts: fn(), checkoutBranch: fn(), createBranch: fn(),
        isMergeInProgress: fn(), execGit: fn(), execGitCallback: jest.fn(),
      };
    });
    service = require('../../src/main/services/ParallelTaskService');
    git = require('../../src/main/utils/git');
  });

  afterEach(() => {
    jest.dontMock('../../src/main/services/ChatService');
    jest.dontMock('../../src/main/utils/git');
  });

  test('startRun answers with the reason and starts nothing', async () => {
    const result = await service.startRun({ projectPath: REMOTE_URI, mainBranch: 'main', goal: 'x' });
    expect(result).toEqual({
      success: false,
      error: 'Parallel tasks are not supported for remote projects yet',
      code: 'REMOTE_UNSUPPORTED',
      reasonKey: 'ssh.disabled.parallelTasks',
    });
    expect(service._active.size).toBe(0);
    expect(service._runStates.size).toBe(0);
    expect(git.createWorktree).not.toHaveBeenCalled();
  });

  test('cleanupRun refuses a URI before touching any worktree', async () => {
    const result = await service.cleanupRun('ptask-1-abcd', REMOTE_URI);
    expect(result.success).toBe(false);
    expect(result.code).toBe('REMOTE_UNSUPPORTED');
    expect(git.removeWorktree).not.toHaveBeenCalled();
    expect(git.execGitCallback).not.toHaveBeenCalled();
  });
});

describe('project-type registry', () => {
  test('forProject() answers the general type for a remote project, whatever its record says', () => {
    const registry = require('../../src/project-types/registry');
    registry.discoverAll();
    const remote = { id: 'r', type: 'fivem', path: REMOTE_URI, remote: { profileId: 'abcd1234', path: '/srv/api' } };
    expect(registry.forProject(remote)).toBe(registry.get('standalone'));
    expect(registry.forProject(remote).getMenuItems({})).toBe('');
    expect(registry.forProject(remote).getTerminalPanels({})).toEqual([]);
  });

  test('forProject() is exactly get(project.type) for a local project', () => {
    const registry = require('../../src/project-types/registry');
    registry.discoverAll();
    for (const type of ['fivem', 'webapp', 'general', 'standalone', 'api', undefined]) {
      expect(registry.forProject({ id: 'l', type, path: localDir })).toBe(registry.get(type));
    }
  });
});
