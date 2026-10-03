/**
 * Viewing remote (SSH) files: the Files screen's viewer and the file tab.
 *
 * A remote file is an ssh-remote:// URI. Its text comes over the async
 * ssh.fs IPC, never the synchronous bridge (a sendSync waiting on the network
 * would freeze the window); an image or other media is downloaded once into
 * the local remote-cache and shown from there through the existing file://
 * path, so the CSP never changes; and its live reload is main's stat poll.
 */

jest.mock('../../src/renderer/ui/components/Modal', () => ({
  showConfirm: () => Promise.resolve(false), showModal: () => {}, showPrompt: () => Promise.resolve(null), closeModal: () => {},
}));
jest.mock('../../src/renderer/services/TerminalSessionService', () => ({ saveTerminalSessions: jest.fn(), loadTerminalSessions: jest.fn() }));

const PID = 'abcd1234';
const ROOT = `ssh-remote://${PID}/home/y/api`;
const CACHE_FILE = '/mock/home/.claude-terminal/remote-cache/p-api/media/k1-logo.png';

let sshFs;

function makeApi() {
  sshFs = jest.fn(async (req) => {
    switch (req.op) {
      case 'stat': return { success: true, value: { type: 'file', isFile: true, isDirectory: false, size: 42, mtimeMs: 1 } };
      case 'readFile': return { success: true, value: { data: req.path.endsWith('.md') ? '# Remote readme\n\n![logo](img/logo.png)\n' : 'const x = 1;\n', size: 42, truncated: false } };
      case 'cacheMedia': return { success: true, value: { localPath: CACHE_FILE, size: 7, cached: false } };
      default: return { success: true, value: true };
    }
  });
  const fixed = {
    ssh: { fs: sshFs },
    dialog: {
      openInEditor: jest.fn(async () => ({ success: true })),
      openExternal: jest.fn(),
      watchFile: jest.fn(async () => {}),
      unwatchFile: jest.fn(async () => {}),
      onFileChanged: jest.fn(() => () => {}),
    },
  };
  // Every other namespace answers like an IPC that succeeded.
  const ns = () => new Proxy({}, { get: (_t, m) => (typeof m === 'string' && m.startsWith('on') ? () => () => {} : () => Promise.resolve({ success: true })) });
  return new Proxy(fixed, { get: (target, key) => (key in target ? target[key] : ns()) });
}

function syncCalls() {
  const fsMock = window.electron_nodeModules.fs;
  return Object.keys(fsMock).filter(k => k.endsWith('Sync') && fsMock[k].mock && fsMock[k].mock.calls.length > 0);
}

beforeEach(() => {
  window.electron_api = makeApi();
  for (const fn of Object.values(window.electron_nodeModules.fs)) if (typeof fn === 'function' && fn.mockClear) fn.mockClear();
  for (const fn of Object.values(window.electron_nodeModules.fs.promises)) if (fn.mockClear) fn.mockClear();
});

describe('FileViewer on a remote file', () => {
  let FileViewer, container;
  beforeEach(() => {
    jest.isolateModules(() => { FileViewer = require('../../src/renderer/ui/components/FileViewer'); });
    document.body.innerHTML = '<div id="pane"></div>';
    container = document.getElementById('pane');
    require('../../src/renderer/state/settings.state').setSetting('editor', 'code');
  });

  test('text is read over ssh.fs, shown under its host path, and the sync bridge is never used', async () => {
    await FileViewer.render(container, `${ROOT}/src/app.js`, { project: { id: 'p-api', path: ROOT } });
    expect(sshFs.mock.calls.map(c => c[0])).toEqual([
      { op: 'stat', path: `${ROOT}/src/app.js` },
      { op: 'readFile', path: `${ROOT}/src/app.js`, encoding: 'utf8', maxBytes: undefined },
    ]);
    expect(container.querySelector('.fv-code').textContent).toContain('const x = 1;');
    expect(container.querySelector('.fv-path').getAttribute('title')).toBe('/home/y/api/src/app.js');
    expect(window.electron_nodeModules.fs.promises.readFile).not.toHaveBeenCalled();
    expect(syncCalls()).toEqual([]);
  });

  test('an image comes from the local remote-cache copy, as a file:// URL', async () => {
    await FileViewer.render(container, `${ROOT}/img/logo.png`, { project: { id: 'p-api', path: ROOT } });
    expect(sshFs).toHaveBeenCalledWith({ op: 'cacheMedia', path: `${ROOT}/img/logo.png` });
    expect(container.querySelector('.fv-media img').getAttribute('src')).toBe(`file:///${CACHE_FILE.replace(/^\//, '')}`);
    expect(syncCalls()).toEqual([]);
  });

  test('a preview that cannot be downloaded says why', async () => {
    sshFs.mockImplementationOnce(async () => ({ success: false, code: 'ETOOLARGE', error: 'File is too large to preview' }));
    await FileViewer.render(container, `${ROOT}/img/huge.png`, { project: { id: 'p-api', path: ROOT } });
    expect(container.querySelector('.fv-error').textContent).toContain('too large');
  });

  test('Open in editor hands the URI to main for VS Code (it becomes --remote ssh-remote+...)', async () => {
    await FileViewer.render(container, `${ROOT}/src/app.js`, { project: { id: 'p-api', path: ROOT } });
    container.querySelector('[data-action="open-editor"]').click();
    await new Promise(r => setTimeout(r, 0));
    expect(window.electron_api.dialog.openInEditor).toHaveBeenCalledWith({ editor: 'code', path: `${ROOT}/src/app.js` });
  });

  test('another editor is refused in the renderer and never spawned', async () => {
    require('../../src/renderer/state/settings.state').setSetting('editor', 'webstorm');
    await FileViewer.render(container, `${ROOT}/src/app.js`, { project: { id: 'p-api', path: ROOT } });
    container.querySelector('[data-action="open-editor"]').click();
    await new Promise(r => setTimeout(r, 0));
    expect(window.electron_api.dialog.openInEditor).not.toHaveBeenCalled();
  });
});

describe('openFileTab on a remote file', () => {
  let manager;
  beforeEach(() => {
    jest.resetModules();
    window.electron_api = makeApi();
    document.body.innerHTML = `
      <div id="terminals-tabs"></div>
      <div id="terminals-container"></div>
      <div id="empty-terminals"></div>
      <div id="terminals-filter"><span id="filter-project-name"></span></div>`;
    const { TerminalManager } = require('../../src/renderer/ui/components/TerminalManager');
    manager = new TerminalManager();
  });

  afterEach(() => {
    try { require('../../src/renderer/state/terminals.state').clearAllTerminals(() => {}); } catch (_) { /* best effort */ }
  });

  test('a text file is read over ssh.fs, never through the sync bridge', async () => {
    await manager.openFileTab(`${ROOT}/src/app.js`, { id: 'p-api', path: ROOT });
    expect(sshFs.mock.calls.map(c => c[0].op)).toEqual(['stat', 'readFile']);
    const wrapper = document.querySelector('.file-wrapper');
    expect(wrapper.querySelector('.file-viewer-code').textContent).toContain('const x = 1;');
    expect(wrapper.querySelector('.file-viewer-path').textContent).toBe('/home/y/api/src/app.js');
    expect(syncCalls()).toEqual([]);
  });

  test('an image is shown from the remote-cache copy', async () => {
    await manager.openFileTab(`${ROOT}/img/logo.png`, { id: 'p-api', path: ROOT });
    expect(sshFs.mock.calls.map(c => c[0].op)).toEqual(['stat', 'cacheMedia']);
    const img = document.querySelector('.file-wrapper .file-viewer-media img');
    expect(img.getAttribute('src')).toBe(`file:///${CACHE_FILE.replace(/^\//, '')}`);
    expect(syncCalls()).toEqual([]);
  });

  test('a markdown tab watches the URI (main polls its stat) and does not look up local images', async () => {
    await manager.openFileTab(`${ROOT}/README.md`, { id: 'p-api', path: ROOT });
    expect(window.electron_api.dialog.watchFile).toHaveBeenCalledWith(`${ROOT}/README.md`);
    const body = document.querySelector('.md-viewer-body');
    expect(body.querySelector('img')).toBeNull();
    expect(body.querySelector('.md-viewer-img-alt').textContent).toBe('logo');
    expect(syncCalls()).toEqual([]);
  });
});
