/**
 * @jest-environment node
 *
 * project.ipc.js for remote (SSH) projects (design/remote-ssh.md section 5.4).
 *
 * `scan-todos` on a remote project runs one `git grep` (fallback `grep -rnI`)
 * on the host and classifies the candidate lines locally with the very regexes
 * the local scan uses, with the same 50-entry cap. A path that does not
 * resolve (unknown profile, outside every registered project) answers [], the
 * way an unreadable local folder does, and never reaches the host.
 * `project-init-git` initialises on the host; scaffolding refuses a remote
 * destination.
 */

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: { handle: (channel, fn) => mockHandlers.set(channel, fn), on: jest.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}));

const mockResolveTarget = jest.fn();
jest.mock('../../src/main/utils/projectTarget', () => ({
  resolveTarget: (...a) => mockResolveTarget(...a),
  noteWorktreeRoots: jest.fn(),
}));
const mockSecurity = { permitted: jest.fn(() => true), grant: jest.fn() };
jest.mock('../../src/main/utils/rendererSecurity', () => mockSecurity);
const mockScaffold = jest.fn();
jest.mock('../../src/main/utils/projectCreation', () => ({ scaffold: (...a) => mockScaffold(...a) }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../../src/main/utils/git');
const { registerProjectHandlers, scanTodosRemote, classifyTodoLine } = require('../../src/main/ipc/project.ipc');

const URI = 'ssh-remote://abcd1234/home/u/api';
const sender = { id: 1, once: jest.fn(), removeListener: jest.fn(), isDestroyed: () => false, send: jest.fn() };
const invoke = (channel, ...args) => mockHandlers.get(channel)({ sender }, ...args);

function executor(stdout, extra = {}) {
  const exec = jest.fn(async () => ({ ok: true, code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), ...extra }));
  return {
    exec,
    resolve: async (uri) => ({ kind: 'remote', profileId: 'abcd1234', remotePath: '/home/u/api', uri }),
    isConnected: () => true,
  };
}

beforeAll(() => registerProjectHandlers());
beforeEach(() => {
  jest.clearAllMocks();
  git._remoteInternals.reset();
  mockResolveTarget.mockResolvedValue({ kind: 'remote', profileId: 'abcd1234', remotePath: '/home/u/api', uri: URI });
});
afterAll(() => git._remoteInternals.setExecutor(null));

describe('scan-todos on a remote project', () => {
  test('classifies the host\'s grep lines with the local patterns', async () => {
    const ex = executor([
      'src/a.js:3:  // TODO: wire the thing',
      'src/b.py:10:# FIXME(yanis) broken',
      'web/i.html:1:<!-- HACK: legacy -->',
      'web/s.css:4:#todo-list { color: red }',
      'lua/x.lua:2:-- XXX check',
      'c/m.c:7:/* TODO */',
      'notes.md:1:// TODO: wrong extension',
      'a/b/c/d/e/f/deep.js:1:// TODO too deep',
      'garbage line without a number',
    ].join('\n'));
    git._remoteInternals.setExecutor(ex);
    const todos = await invoke('scan-todos', URI);
    expect(todos).toEqual([
      { type: 'TODO', text: 'wire the thing', file: 'src/a.js', line: 3 },
      { type: 'FIXME', text: '(yanis) broken', file: 'src/b.py', line: 10 },
      { type: 'HACK', text: 'legacy', file: 'web/i.html', line: 1 },
      { type: 'XXX', text: 'check', file: 'lua/x.lua', line: 2 },
      { type: 'TODO', text: '(no description)', file: 'c/m.c', line: 7 },
    ]);
    expect(ex.exec).toHaveBeenCalledTimes(1);
    const [, script, options] = ex.exec.mock.calls[0];
    expect(options.write).toBe(false);
    expect(script).toContain("git -c core.quotePath=false grep -n -I -i --untracked -E -e '(TODO|FIXME|HACK|XXX)' -- '*.js'");
    expect(script).toContain("':(exclude,glob)**/node_modules/**'");
    expect(script).toContain("grep -rnI -i -E -e '(TODO|FIXME|HACK|XXX)'");
    expect(script).toContain("--exclude-dir='node_modules'");
  });

  test('stops at 50 entries, like the local scan', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `f.js:${i + 1}:// TODO ${i}`).join('\n');
    git._remoteInternals.setExecutor(executor(lines));
    const todos = await invoke('scan-todos', URI);
    expect(todos).toHaveLength(50);
    expect(todos[49]).toEqual({ type: 'TODO', text: '49', file: 'f.js', line: 50 });
  });

  test('a path that does not resolve answers [] and never reaches the host', async () => {
    const ex = executor('f.js:1:// TODO x');
    git._remoteInternals.setExecutor(ex);
    mockResolveTarget.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'REMOTE_PATH_NOT_IN_PROJECT' }));
    expect(await invoke('scan-todos', 'ssh-remote://abcd1234/etc')).toEqual([]);
    expect(ex.exec).not.toHaveBeenCalled();
  });

  test('a host that cannot answer gives an empty list', async () => {
    git._remoteInternals.setExecutor(executor('', { ok: false, code: null, reason: 'disconnected' }));
    expect(await invoke('scan-todos', URI)).toEqual([]);
  });

  test('scanTodosRemote takes an injected grep', async () => {
    const grep = jest.fn(async () => ({ ok: true, lines: [{ file: 'x.ts', line: 2, text: '// FIXME: y' }] }));
    expect(await scanTodosRemote(URI, { grepTodoCandidates: grep })).toEqual([{ type: 'FIXME', text: 'y', file: 'x.ts', line: 2 }]);
    expect(grep.mock.calls[0][1]).toMatchObject({ maxDepth: 5 });
  });

  test('classifyTodoLine keeps markup and CSS out, as the local scan does', () => {
    expect(classifyTodoLine('<a href="#todo">')).toBeNull();
    expect(classifyTodoLine('#todo-list { }')).toBeNull();
    expect(classifyTodoLine('<!-- TODO: x -->')).toEqual({ type: 'TODO', text: 'x' });
  });
});

describe('scan-todos on a local project is unchanged', () => {
  test('walks the folder and never resolves a remote target', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-todo-local-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.js'), 'x\n// TODO: local one\n');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      fs.writeFileSync(path.join(dir, 'node_modules', 'b.js'), '// TODO: skipped\n');
      const ex = executor('');
      git._remoteInternals.setExecutor(ex);
      expect(await invoke('scan-todos', dir)).toEqual([{ type: 'TODO', text: 'local one', file: 'a.js', line: 2 }]);
      expect(mockResolveTarget).not.toHaveBeenCalled();
      expect(ex.exec).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('project-init-git and project-scaffold', () => {
  test('init runs on the host for a registered remote project, without a local grant check', async () => {
    const ex = executor('Initialized empty Git repository');
    git._remoteInternals.setExecutor(ex);
    expect(await invoke('project-init-git', { projectPath: URI })).toEqual({ success: true });
    expect(mockSecurity.permitted).not.toHaveBeenCalled();
    expect(ex.exec.mock.calls[0][1]).toContain("exec git -c protocol.ext.allow=never 'init'");
    expect(ex.exec.mock.calls[0][2].write).toBe(true);
  });

  test('init refuses a remote path outside every registered project', async () => {
    const ex = executor('');
    git._remoteInternals.setExecutor(ex);
    mockResolveTarget.mockRejectedValueOnce(new Error('Remote path is not inside a registered remote project'));
    await expect(invoke('project-init-git', { projectPath: 'ssh-remote://abcd1234/tmp/x' })).rejects.toThrow('not inside a registered');
    expect(ex.exec).not.toHaveBeenCalled();
  });

  test('scaffolding into a remote destination is refused', async () => {
    const res = await invoke('project-scaffold', { template: 'vite', targetPath: URI });
    expect(res).toMatchObject({ success: false, error: 'Project templates cannot be scaffolded on a remote host' });
    expect(mockScaffold).not.toHaveBeenCalled();
    expect(mockSecurity.permitted).not.toHaveBeenCalled();
  });
});
