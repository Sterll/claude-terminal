/**
 * End-to-end guard on the save path itself: saveProjectsImmediate must
 * reconcile with the file on disk instead of rewriting it from memory.
 *
 * The regression this pins down: an MCP session wrote 18 kanban tasks to
 * projects.json after the renderer had loaded, and the next renderer save —
 * triggered by nothing more than opening the kanban — wiped them.
 */

const {
  projectsState,
  loadProjects,
  saveProjectsImmediate,
  getKanbanColumns,
  stopExternalWatch,
} = require('../../src/renderer/state/projects.state');

const fsMock = window.electron_nodeModules.fs;

/** Whatever the code last wrote through the atomic write path. */
function lastWrittenPayload() {
  const calls = fsMock.promises.writeFile.mock.calls;
  if (!calls.length) return null;
  return JSON.parse(calls[calls.length - 1][1]);
}

/** Make the mocked filesystem answer with `content` for projects.json. */
function setDiskContent(content) {
  fsMock.promises.access.mockResolvedValue(undefined);
  fsMock.promises.readFile.mockResolvedValue(JSON.stringify(content));
}

const NARVI_TASKS = Array.from({ length: 18 }, (_, i) => ({
  id: `task-${i}`,
  title: `#${i} step`,
  columnId: 'col-todo',
}));

beforeEach(() => {
  jest.clearAllMocks();
  fsMock.promises.mkdir.mockResolvedValue(undefined);
  fsMock.promises.writeFile.mockResolvedValue(undefined);
  fsMock.promises.rename.mockResolvedValue(undefined);
  fsMock.promises.copyFile.mockResolvedValue(undefined);
  fsMock.promises.unlink.mockResolvedValue(undefined);
  fsMock.promises.stat.mockResolvedValue({ mtime: new Date(0), size: 0 });
});

afterEach(() => {
  stopExternalWatch();
});

describe('saveProjectsImmediate merges with the disk', () => {
  test('tasks written by another process survive our save', async () => {
    // The renderer loads a file with no tasks — this becomes its baseline.
    setDiskContent({
      projects: [{ id: 'narvi', name: 'narvi', type: 'standalone', folderId: null, tasks: [] }],
      folders: [],
      rootOrder: ['narvi'],
    });
    await loadProjects();

    // An MCP session then fills the board behind our back.
    setDiskContent({
      projects: [{ id: 'narvi', name: 'narvi', type: 'standalone', folderId: null, tasks: NARVI_TASKS }],
      folders: [],
      rootOrder: ['narvi'],
    });

    // Anything at all triggers a save from our still-empty copy.
    await saveProjectsImmediate();

    const written = lastWrittenPayload();
    expect(written.projects.find(p => p.id === 'narvi').tasks).toHaveLength(18);
  });

  test('a project added by another process is not dropped', async () => {
    setDiskContent({
      projects: [{ id: 'narvi', name: 'narvi', type: 'standalone', folderId: null }],
      folders: [],
      rootOrder: ['narvi'],
    });
    await loadProjects();

    setDiskContent({
      projects: [
        { id: 'narvi', name: 'narvi', type: 'standalone', folderId: null },
        { id: 'wt', name: 'worktree', type: 'standalone', folderId: null, path: '/tmp/wt' },
      ],
      folders: [],
      rootOrder: ['narvi', 'wt'],
    });

    await saveProjectsImmediate();

    const written = lastWrittenPayload();
    expect(written.projects.map(p => p.id)).toContain('wt');
    expect(written.rootOrder).toContain('wt');
  });

  test('our own edit still wins over the disk', async () => {
    setDiskContent({
      projects: [{ id: 'narvi', name: 'narvi', type: 'standalone', folderId: null, tasks: [] }],
      folders: [],
      rootOrder: ['narvi'],
    });
    await loadProjects();

    // We rename locally; meanwhile the disk gains tasks.
    projectsState.set({
      projects: [{ id: 'narvi', name: 'renamed', type: 'standalone', folderId: null, tasks: [] }],
    });
    setDiskContent({
      projects: [{ id: 'narvi', name: 'narvi', type: 'standalone', folderId: null, tasks: NARVI_TASKS }],
      folders: [],
      rootOrder: ['narvi'],
    });

    await saveProjectsImmediate();

    const written = lastWrittenPayload();
    const narvi = written.projects.find(p => p.id === 'narvi');
    expect(narvi.name).toBe('renamed');
    expect(narvi.tasks).toHaveLength(18);
  });

  test('an unreadable disk file does not abort the save', async () => {
    setDiskContent({ projects: [], folders: [], rootOrder: [] });
    await loadProjects();

    projectsState.set({
      projects: [{ id: 'p', name: 'p', type: 'standalone', folderId: null }],
      rootOrder: ['p'],
    });
    fsMock.promises.readFile.mockResolvedValue('{ not json');

    await saveProjectsImmediate();

    expect(lastWrittenPayload().projects.map(p => p.id)).toEqual(['p']);
  });
});

describe('reading the kanban does not write', () => {
  test('getKanbanColumns returns defaults without saving', async () => {
    setDiskContent({
      projects: [{ id: 'p', name: 'p', type: 'standalone', folderId: null }],
      folders: [],
      rootOrder: ['p'],
    });
    await loadProjects();
    fsMock.promises.writeFile.mockClear();

    const cols = getKanbanColumns('p');

    expect(cols).toHaveLength(3);
    expect(fsMock.promises.writeFile).not.toHaveBeenCalled();
  });
});
