/**
 * The Memory editor and context packs on a remote (SSH) project.
 *
 * A remote project's CLAUDE.md is `<remote path>/CLAUDE.md` on its host, and
 * the CLI's private instructions and auto memory live in the host's own
 * `~/.claude/projects/<encoded>/`, which main names (`privatePaths`) from the
 * handshake. Everything is read and written over the async ssh.fs IPC; the
 * local fs bridge is never asked about a URI, and listing the sidebar never
 * reaches a host that is not connected. A context pack's relative items of a
 * remote project are read on the host too.
 */

jest.mock('../../src/renderer/ui/components/Toast', () => ({ showToast: jest.fn(), showError: jest.fn() }));

const path = require('path');
const Toast = require('../../src/renderer/ui/components/Toast');
const { projectsState } = require('../../src/renderer/state/projects.state');
const { remoteHostsState } = require('../../src/renderer/state/remoteHosts.state');
const { MemoryEditor } = require('../../src/renderer/ui/panels/MemoryEditor');
const { ContextPromptService } = require('../../src/renderer/services/ContextPromptService');

const PID = 'abcd1234';
const ROOT = `ssh-remote://${PID}/home/y/api`;
const PRIVATE_DIR = `ssh-remote://${PID}/home/y/.claude/projects/-home-y-api`;
const REMOTE = { id: 'p-remote', name: 'api', path: ROOT, type: 'general', remote: { profileId: PID, path: '/home/y/api', hostLabel: 'y@build' } };

let sshFs;

function setHost(state) {
  remoteHostsState.set({
    profiles: [{ id: PID, host: 'build', user: 'y' }],
    statuses: { [PID]: { profileId: PID, state, capabilities: state === 'connected' ? { home: '/home/y' } : null } },
    loaded: true,
    error: null,
  });
}

function localFsCalls() {
  const fsMock = window.electron_nodeModules.fs;
  const calls = [];
  for (const [k, fn] of Object.entries(fsMock)) if (fn && fn.mock) for (const c of fn.mock.calls) calls.push([k, c[0]]);
  for (const [k, fn] of Object.entries(fsMock.promises)) if (fn && fn.mock) for (const c of fn.mock.calls) calls.push([`promises.${k}`, c[0]]);
  return calls.filter(([, p]) => typeof p === 'string' && p.startsWith('ssh-remote://'));
}

beforeEach(() => {
  sshFs = jest.fn(async (req) => {
    switch (req.op) {
      case 'privatePaths': return { success: true, value: { sessionsDir: PRIVATE_DIR, claudeMd: `${PRIVATE_DIR}/CLAUDE.md`, memoryDir: `${PRIVATE_DIR}/memory` } };
      case 'stat': return { success: true, value: { type: 'file', isFile: true, isDirectory: false, size: 10, mtimeMs: 1 } };
      case 'readFile': return { success: true, value: { data: `# from ${req.path}\n`, size: 10, truncated: false } };
      case 'readdir': return { success: true, value: [{ name: 'MEMORY.md', type: 'file', size: 10, mtimeMs: 1 }] };
      case 'listFiles': return { success: true, value: { files: ['src/a.js', 'src/deep/b.js', 'node_modules/x.js', 'README.md'], truncated: false } };
      default: return { success: true, value: { bytes: 1 } };
    }
  });
  window.electron_api = { ...window.electron_api, ssh: { fs: sshFs } };
  for (const fn of Object.values(window.electron_nodeModules.fs)) if (fn && fn.mockClear) fn.mockClear();
  for (const fn of Object.values(window.electron_nodeModules.fs.promises)) if (fn.mockClear) fn.mockClear();
  Toast.showToast.mockClear();
  projectsState.set({ projects: [REMOTE], folders: [], rootOrder: [REMOTE.id] });
  setHost('connected');
  document.body.innerHTML = `
    <div id="memory-sources-list"></div>
    <div id="memory-projects-list"></div>
    <h2 id="memory-title"></h2><span id="memory-path"></span>
    <div id="memory-stats"></div>
    <button id="btn-memory-edit"></button><button id="btn-memory-create"></button><button id="btn-memory-template"></button>
    <button id="btn-memory-refresh"></button><button id="btn-memory-open"></button>
    <input id="memory-search-input">
    <div id="memory-content"></div>`;
});

function makeEditor() {
  const api = { path, os: { homedir: () => '/mock/home' }, dialog: { openInExplorer: jest.fn() } };
  const editor = new MemoryEditor(document.body, { api, showToast: jest.fn() });
  return { editor, api };
}

describe('Memory editor on a remote project', () => {
  test('the project CLAUDE.md is read on the host and shown by its host path', async () => {
    const { editor } = makeEditor();
    await editor.loadMemoryContent('project', 0);
    expect(sshFs).toHaveBeenCalledWith({ op: 'readFile', path: `${ROOT}/CLAUDE.md`, encoding: 'utf8', maxBytes: undefined });
    expect(document.getElementById('memory-path').textContent).toBe('/home/y/api/CLAUDE.md');
    expect(localFsCalls()).toEqual([]);
  });

  test('the private instructions and the auto memory come from the host\'s ~/.claude/projects', async () => {
    const { editor } = makeEditor();
    await editor.loadMemoryContent('project-private', 0);
    expect(sshFs).toHaveBeenCalledWith({ op: 'privatePaths', path: ROOT });
    expect(sshFs).toHaveBeenCalledWith(expect.objectContaining({ op: 'readFile', path: `${PRIVATE_DIR}/CLAUDE.md` }));
    await editor.loadMemoryContent('project-memory', 0);
    expect(sshFs).toHaveBeenCalledWith({ op: 'readdir', path: `${PRIVATE_DIR}/memory` });
    expect(document.querySelector('.memory-file-card').dataset.file).toBe('MEMORY.md');
    expect(localFsCalls()).toEqual([]);
  });

  test('saving writes the file on the host', async () => {
    const { editor } = makeEditor();
    await editor.loadMemoryContent('project', 0);
    document.getElementById('memory-content').innerHTML = '<textarea id="memory-editor"># edited</textarea>';
    editor._state.isEditing = true;
    await editor.saveMemoryEdit();
    expect(sshFs).toHaveBeenCalledWith({ op: 'writeFile', path: `${ROOT}/CLAUDE.md`, data: '# edited', encoding: 'utf8' });
    expect(window.electron_nodeModules.fs.promises.writeFile).not.toHaveBeenCalled();
  });

  test('the sidebar never asks a host that is not connected', async () => {
    setHost('reconnecting');
    const { editor } = makeEditor();
    editor._state.expandedProjects.add(0);
    await editor.renderMemorySources();
    expect(sshFs).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.memory-child-item')).toHaveLength(3);
  });

  test('"Open in explorer" is refused with the reason for a remote project', async () => {
    const { editor, api } = makeEditor();
    editor.setupMemoryEventListeners();
    editor._state.currentSource = 'project';
    editor._state.currentProject = 0;
    await document.getElementById('btn-memory-open').onclick();
    expect(api.dialog.openInExplorer).not.toHaveBeenCalled();
    expect(Toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'info' }));
  });
});

describe('context packs on a remote project', () => {
  function makeService(pack) {
    const api = { path, fs: window.electron_nodeModules.fs };
    const svc = new ContextPromptService(api, null);
    svc._contextPacks = { global: [pack], projects: {} };
    return svc;
  }

  test('a relative file item is read on the host', async () => {
    const svc = makeService({ id: 'cp1', name: 'Pack', items: [{ type: 'file', path: 'src/a.js' }] });
    const text = await svc.resolveContextPack('cp1', ROOT);
    expect(sshFs).toHaveBeenCalledWith(expect.objectContaining({ op: 'readFile', path: `${ROOT}/src/a.js` }));
    expect(text).toContain('--- src/a.js ---');
    expect(localFsCalls()).toEqual([]);
  });

  test('a relative folder item is one listing on the host, trimmed to its depth', async () => {
    const svc = makeService({ id: 'cp2', name: 'Pack', items: [{ type: 'folder', path: '.', maxDepth: 2 }] });
    const text = await svc.resolveContextPack('cp2', ROOT);
    expect(sshFs.mock.calls.map(c => c[0].op)).toEqual(['listFiles']);
    expect(text).toContain('  src/a.js');
    expect(text).toContain('  README.md');
    expect(text).not.toContain('src/deep/b.js');
    expect(text).not.toContain('node_modules');
  });
});
