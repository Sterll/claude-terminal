/**
 * The file tree, docked beside the chat.
 *
 * FileExplorer binds to fixed ids (`file-explorer-tree`, `fe-search-*`), so the
 * Files screen and the docked column cannot both hold its markup: whichever one
 * mounts has to empty the other. These tests pin that invariant, plus the two
 * behaviours that differ between the hosts — where a clicked file goes, and
 * whether the session overlay applies.
 */

jest.mock('../../src/renderer/ui/components/FileViewer', () => ({ render: jest.fn() }));
jest.mock('../../src/renderer/ui/components/FileExplorer', () => ({
  setCallbacks: jest.fn(),
  setRootPath: jest.fn(),
  setExtraRoots: jest.fn(),
  setSessionOverlay: jest.fn(),
  resetDomBindings: jest.fn(),
  init: jest.fn(),
  show: jest.fn(),
  hide: jest.fn(),
  render: jest.fn(),
  revealPaths: jest.fn(),
}));
jest.mock('../../src/renderer/state', () => ({ getOpenProjects: () => [] }));
jest.mock('../../src/renderer/i18n', () => ({ t: (key) => key }));

const FileExplorer = require('../../src/renderer/ui/components/FileExplorer');
const FilesPanel = require('../../src/renderer/ui/panels/FilesPanel');

const PROJECT = { id: 'p1', name: 'demo', path: '/tmp/demo' };

let screenHost, dockHost;

beforeEach(() => {
  document.body.innerHTML = '<div id="tab-files"></div><div id="claude-files-dock"></div>';
  screenHost = document.getElementById('tab-files');
  dockHost = document.getElementById('claude-files-dock');
  jest.clearAllMocks();
  // Each test starts from the screen, the panel's default host.
  FilesPanel.loadPanel(screenHost, PROJECT);
});

/** The callbacks FileExplorer was last handed. */
const explorerCallbacks = () => FileExplorer.setCallbacks.mock.calls.at(-1)[0];

describe('the docked column', () => {
  test('takes the tree with it, leaving one markup behind', () => {
    expect(screenHost.querySelector('#file-explorer-tree')).not.toBeNull();

    FilesPanel.mountDock(dockHost, PROJECT);

    expect(document.querySelectorAll('#file-explorer-tree')).toHaveLength(1);
    expect(dockHost.querySelector('#file-explorer-tree')).not.toBeNull();
    expect(screenHost.innerHTML).toBe('');
    expect(FilesPanel.isDocked()).toBe(true);
  });

  test('gives it back when the screen is opened again', () => {
    FilesPanel.mountDock(dockHost, PROJECT);
    FilesPanel.loadPanel(screenHost, PROJECT);

    expect(document.querySelectorAll('#file-explorer-tree')).toHaveLength(1);
    expect(screenHost.querySelector('#file-explorer-tree')).not.toBeNull();
    expect(dockHost.innerHTML).toBe('');
    expect(FilesPanel.isDocked()).toBe(false);
  });

  test('unmounting empties the host and stops the explorer', () => {
    FilesPanel.mountDock(dockHost, PROJECT);
    FilesPanel.unmountDock();

    expect(dockHost.innerHTML).toBe('');
    expect(FileExplorer.hide).toHaveBeenCalled();
    expect(FilesPanel.isDocked()).toBe(false);
  });

  test('rebinds the flag-guarded listeners, since their markup was replaced', () => {
    FileExplorer.resetDomBindings.mockClear();
    FilesPanel.mountDock(dockHost, PROJECT);

    expect(FileExplorer.resetDomBindings).toHaveBeenCalled();
    // Order matters: clearing the flags after init() would be too late.
    const resetOrder = FileExplorer.resetDomBindings.mock.invocationCallOrder[0];
    const initOrder = FileExplorer.init.mock.invocationCallOrder.at(-1);
    expect(resetOrder).toBeLessThan(initOrder);
  });

  test('opens a file as a tab, having no viewer pane of its own', () => {
    const onOpenFileTab = jest.fn();
    FilesPanel.setCallbacks({ onOpenFileTab });
    FilesPanel.mountDock(dockHost, PROJECT);

    explorerCallbacks().onOpenFile('/tmp/demo/index.js');

    expect(onOpenFileTab).toHaveBeenCalledWith('/tmp/demo/index.js');
  });

  test('shows the plain tree: the session overlay belongs to the screen', () => {
    FilesPanel.mountDock(dockHost, PROJECT);

    expect(FileExplorer.setSessionOverlay).toHaveBeenLastCalledWith({ files: null, modifiedOnly: false });
    // Overview is the screen's split too — the column follows the active project.
    expect(FileExplorer.setExtraRoots).toHaveBeenLastCalledWith([]);
  });

  test('renders nothing at all without a project to point at', () => {
    FilesPanel.mountDock(dockHost, null);

    expect(dockHost.innerHTML).toBe('');
    expect(FilesPanel.isDocked()).toBe(false);
  });
});
