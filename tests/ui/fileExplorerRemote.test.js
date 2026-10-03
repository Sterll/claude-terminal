/**
 * The file explorer on a remote (SSH) project root (design/remote-ssh.md
 * section 5.5).
 *
 * Node identity stays the path, so a remote tree's nodes are ssh-remote://
 * URIs and every fs call under them goes through the async ssh.fs facade.
 * Pinned here:
 *  - the synchronous fs bridge is never called for a URI;
 *  - a directory is one ssh.fs request, a name search one listing and a
 *    content search one grep (never a read per file);
 *  - a move, a paste or a drop between a local and a remote root is refused
 *    with a toast;
 *  - Reveal in Explorer is disabled for a remote file, Open in editor only
 *    for editors outside the VS Code family;
 *  - a remote root whose host is not connected is not loaded (selection
 *    alone must not connect), and Connect is an explicit button;
 *  - the explorer tells main it is on screen only when a remote root is
 *    shown, and the git badges poll a remote root every 30 s.
 */

jest.mock('../../src/renderer/ui/components/Toast', () => ({ showToast: jest.fn(), showError: jest.fn() }));
jest.mock('../../src/renderer/ui/components/ContextMenu', () => ({ showContextMenu: jest.fn() }));

const Toast = require('../../src/renderer/ui/components/Toast');
const { showContextMenu } = require('../../src/renderer/ui/components/ContextMenu');
const { t } = require('../../src/renderer/i18n');
const { remoteHostsState } = require('../../src/renderer/state/remoteHosts.state');
const { setSetting } = require('../../src/renderer/state/settings.state');
const { FileExplorer } = require('../../src/renderer/ui/components/FileExplorer');

const PID = 'abcd1234';
const ROOT = `ssh-remote://${PID}/home/y/api`;
const LOCAL = '/local/app';

const REMOTE_DIRS = {
  '/home/y/api': [
    { name: 'src', type: 'directory', symlink: false, size: 4096, mtimeMs: 1 },
    { name: 'README.md', type: 'file', symlink: false, size: 10, mtimeMs: 2 },
    { name: 'node_modules', type: 'directory', symlink: false, size: 4096, mtimeMs: 3 },
  ],
  '/home/y/api/src': [
    { name: 'index.js', type: 'file', symlink: false, size: 20, mtimeMs: 4 },
  ],
};

let sshFs, api;
const flush = async (ms = 0) => {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, ms));
};
const sshOps = () => sshFs.mock.calls.map(c => c[0].op);

function setHost(state) {
  remoteHostsState.set({
    profiles: [{ id: PID, host: 'build.example.com', user: 'y' }],
    statuses: { [PID]: { profileId: PID, state, capabilities: state === 'connected' ? { home: '/home/y' } : null } },
    loaded: true,
    error: null,
  });
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="file-explorer-panel" style="display:none">
      <div id="fe-search-container"><input id="fe-search-input"></div>
      <div id="file-explorer-tree"></div>
    </div>`;
  sshFs = jest.fn(async (req) => {
    const posix = req.path ? req.path.replace(`ssh-remote://${PID}`, '') : '';
    switch (req.op) {
      case 'readdir': return { success: true, value: REMOTE_DIRS[posix] || [] };
      case 'listFiles': return { success: true, value: { files: ['README.md', 'src/index.js', 'node_modules/x/readme.md'], truncated: false } };
      case 'grep': return { success: true, value: { matches: [
        { file: 'src/index.js', line: 3, text: 'const needle = 1' },
        { file: 'src/index.js', line: 9, text: 'needle()' },
        { file: 'README.md', line: 1, text: '# needle' },
      ], truncated: false } };
      default: return { success: true, value: true };
    }
  });
  api = {
    ...window.electron_api,
    ssh: { fs: sshFs, connect: jest.fn(async () => ({ success: true, status: { profileId: PID, state: 'connected', capabilities: { home: '/home/y' } } })) },
    git: { statusDetailed: jest.fn(async () => ({ success: true, files: [{ path: 'src/index.js', status: 'M', staged: false }] })) },
    explorer: { watchDir: jest.fn(), unwatchDir: jest.fn(), setVisible: jest.fn() },
    dialog: { openInExplorer: jest.fn(), openInEditor: jest.fn(async () => ({ success: true })) },
  };
  window.electron_api = api;
  for (const fn of Object.values(window.electron_nodeModules.fs)) if (typeof fn === 'function' && fn.mockClear) fn.mockClear();
  for (const fn of Object.values(window.electron_nodeModules.fs.promises)) if (fn.mockClear) fn.mockClear();
  Toast.showToast.mockClear();
  showContextMenu.mockClear();
  setHost('connected');
  setSetting('editor', 'code');
});

function syncCalls() {
  const fsMock = window.electron_nodeModules.fs;
  return Object.keys(fsMock).filter(k => k.endsWith('Sync') && fsMock[k].mock && fsMock[k].mock.calls.length > 0);
}

function openExplorer(root = ROOT) {
  const fe = new FileExplorer();
  fe.setRootPath(root);
  fe.show();
  fe.render();
  return fe;
}

describe('reading a remote tree', () => {
  test('a directory is one ssh.fs request, nodes are URIs, and the sync bridge is never used', async () => {
    const fe = openExplorer();
    await flush();
    expect(sshOps()).toEqual(['readdir']);
    const paths = [...document.querySelectorAll('.fe-node')].map(n => n.dataset.path);
    expect(paths).toEqual([`${ROOT}/src`, `${ROOT}/README.md`]); // node_modules ignored, dirs first

    document.querySelector(`.fe-node[data-path="${ROOT}/src"]`).click();
    await flush();
    expect(sshOps()).toEqual(['readdir', 'readdir']);
    expect(api.explorer.watchDir).toHaveBeenCalledWith(`${ROOT}/src`);
    expect(document.querySelector(`.fe-node[data-path="${ROOT}/src/index.js"]`)).not.toBeNull();
    expect(syncCalls()).toEqual([]);
    expect(window.electron_nodeModules.fs.promises.readFile).not.toHaveBeenCalled();
    fe.destroy();
  });

  test('name search is one listing on the host, filtered like the local walk', async () => {
    const fe = openExplorer();
    await flush();
    sshFs.mockClear();
    fe._searchQuery = 'readme';
    fe._performSearch();
    await flush(100);
    await flush(100);
    expect(sshOps()).toEqual(['listFiles']);
    expect(fe._searchResults.map(r => r.path)).toEqual([`${ROOT}/README.md`]);
    fe.destroy();
  });

  test('content search is one grep on the host, never a read per file', async () => {
    const fe = openExplorer();
    await flush();
    sshFs.mockClear();
    fe._contentSearchQuery = 'needle';
    fe._performContentSearch();
    await flush(150);
    await flush(150);
    expect(sshOps()).toEqual(['grep']);
    expect(fe._contentSearchResults).toEqual([
      { name: 'index.js', path: `${ROOT}/src/index.js`, matches: [{ line: 3, text: 'const needle = 1' }, { line: 9, text: 'needle()' }] },
      { name: 'README.md', path: `${ROOT}/README.md`, matches: [{ line: 1, text: '# needle' }] },
    ]);
    expect(window.electron_nodeModules.fs.promises.readFile).not.toHaveBeenCalled();
    expect(syncCalls()).toEqual([]);
    fe.destroy();
  });

  test('watcher changes for remote paths re-read the parent with POSIX rules', async () => {
    const fe = openExplorer();
    await flush();
    sshFs.mockClear();
    await fe.applyWatcherChanges([{ type: 'add', path: `${ROOT}/new.txt`, isDirectory: false }]);
    expect(sshFs).toHaveBeenCalledWith({ op: 'readdir', path: ROOT });
    fe.destroy();
  });

  test('git badges map the host\'s POSIX paths onto the URIs', async () => {
    const fe = openExplorer();
    await flush();
    document.querySelector(`.fe-node[data-path="${ROOT}/src"]`).click();
    await flush();
    await fe._refreshGitStatus();
    fe.render();
    const node = document.querySelector(`.fe-node[data-path="${ROOT}/src/index.js"]`);
    expect(node.querySelector('.fe-git-status').textContent).toBe('M');
    fe.destroy();
  });
});

describe('local and remote roots never mix', () => {
  test('a move, a paste or a drop between a local root and a remote one is refused with a toast', async () => {
    const fe = openExplorer(LOCAL);
    fe.setExtraRoots([LOCAL, ROOT]);
    await fe._moveItems([`${LOCAL}/a.txt`], `${ROOT}/src`);
    fe._copiedPaths = [`${ROOT}/README.md`];
    await fe._pasteCopiedFiles(`${LOCAL}/lib`);
    expect(Toast.showToast).toHaveBeenCalledTimes(2);
    expect(Toast.showToast).toHaveBeenLastCalledWith({ type: 'info', message: t('ssh.disabled.crossRootTransfer') });
    expect(sshOps().filter(op => op !== 'readdir')).toEqual([]);
    expect(window.electron_nodeModules.fs.promises.rename).not.toHaveBeenCalled();
    expect(window.electron_nodeModules.fs.promises.copyFile).not.toHaveBeenCalled();

    // A drag from the local tree dropped on a remote folder.
    fe.render();
    await flush();
    fe._draggedPaths = [`${LOCAL}/a.txt`];
    const tree = document.getElementById('file-explorer-tree');
    tree.insertAdjacentHTML('beforeend', `<div class="fe-node" data-path="${ROOT}/src" data-is-dir="true" id="drop-here"></div>`);
    const drop = new Event('drop', { bubbles: true });
    drop.preventDefault = () => {};
    document.getElementById('drop-here').dispatchEvent(drop);
    expect(Toast.showToast).toHaveBeenCalledTimes(3);
    fe.destroy();
  });

  test('a move inside the remote tree goes through ssh.fs rename', async () => {
    const fe = openExplorer();
    await flush();
    sshFs.mockImplementation(async (req) => {
      if (req.op === 'stat') return { success: false, code: 'ENOENT', error: 'ENOENT' };
      if (req.op === 'readdir') return { success: true, value: [] };
      return { success: true, value: true };
    });
    await fe._moveItems([`${ROOT}/README.md`], `${ROOT}/src`);
    expect(sshFs).toHaveBeenCalledWith({ op: 'rename', from: `${ROOT}/README.md`, to: `${ROOT}/src/README.md` });
    expect(Toast.showToast).not.toHaveBeenCalled();
    fe.destroy();
  });
});

describe('context menu on a remote file', () => {
  function menuItems(fe, filePath) {
    fe._showFileContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0 }, filePath, false);
    return showContextMenu.mock.calls[showContextMenu.mock.calls.length - 1][0].items;
  }

  test('Reveal in Explorer is disabled with its reason', async () => {
    const fe = openExplorer();
    await flush();
    const reveal = menuItems(fe, `${ROOT}/README.md`).find(i => i.label === t('ui.openInExplorer'));
    expect(reveal).toMatchObject({ disabled: true, title: t('ssh.disabled.openInExplorer') });
    fe.destroy();
  });

  test('Open in editor is offered for VS Code and disabled with a tooltip for other editors', async () => {
    const fe = openExplorer();
    await flush();
    const label = t('fileExplorer.openInEditor');
    expect(menuItems(fe, `${ROOT}/README.md`).find(i => i.label === label).disabled).toBeFalsy();
    setSetting('editor', 'webstorm');
    expect(menuItems(fe, `${ROOT}/README.md`).find(i => i.label === label)).toMatchObject({ disabled: true, title: t('ssh.disabled.openInEditor') });
    fe.destroy();
  });

  test('a local file keeps an enabled Reveal in Explorer', () => {
    const fe = openExplorer(LOCAL);
    const reveal = menuItems(fe, `${LOCAL}/a.txt`).find(i => i.label === t('ui.openInExplorer'));
    expect(reveal.disabled).toBeFalsy();
    expect(reveal.title).toBeUndefined();
    fe.destroy();
  });
});

describe('host state and visibility', () => {
  test('a remote root whose host is not connected is not loaded; Connect is explicit', async () => {
    setHost('idle');
    const fe = openExplorer();
    await flush();
    expect(sshFs).not.toHaveBeenCalled();
    expect(api.git.statusDetailed).not.toHaveBeenCalled();
    const btn = document.querySelector('.fe-remote-connect');
    expect(btn).not.toBeNull();
    btn.click();
    await flush();
    expect(api.ssh.connect).toHaveBeenCalledWith(PID);
    fe.destroy();
  });

  test('main is told the explorer is on screen only while a remote root is shown', () => {
    const local = openExplorer(LOCAL);
    local.hide();
    expect(api.explorer.setVisible).not.toHaveBeenCalled();
    local.destroy();

    const fe = openExplorer();
    expect(api.explorer.setVisible).toHaveBeenLastCalledWith(true);
    fe.hide();
    expect(api.explorer.setVisible).toHaveBeenLastCalledWith(false);
    fe.destroy();
  });

  test('a remote root polls git every 30 s, a local one every 10 s', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const fe = openExplorer();
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 30000);
    fe.destroy();
    const local = openExplorer(LOCAL);
    expect(spy).toHaveBeenLastCalledWith(expect.any(Function), 10000);
    local.destroy();
    spy.mockRestore();
  });
});
