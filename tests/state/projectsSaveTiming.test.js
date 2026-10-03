/**
 * When projects.json is written, and what that means for the other writers.
 *
 * Two things found by driving the real app against a remote host:
 *
 *   - The debounce timer of saveProjects() was never cleared once it fired, so
 *     `_checkExternalWrite()` read "a save of ours is pending" forever after
 *     the first save of the session and ignored every write by another
 *     process (the MCP project and kanban tools, a second window).
 *   - A remote project is opened the moment it is added, and the main process
 *     resolves its URI against projects.json. Inside the 500 ms debounce the
 *     file did not list it yet, so the first requests about it were refused.
 *     flushProjectsSave() writes it now.
 */

const {
  projectsState,
  loadProjects,
  saveProjects,
  flushProjectsSave,
  addProject,
  startExternalWatch,
  stopExternalWatch,
} = require('../../src/renderer/state/projects.state');

const fsMock = window.electron_nodeModules.fs;

function setDisk(content, mtime) {
  fsMock.promises.access.mockResolvedValue(undefined);
  fsMock.promises.readFile.mockResolvedValue(JSON.stringify(content));
  fsMock.promises.stat.mockResolvedValue({ mtime: new Date(mtime), size: JSON.stringify(content).length });
}

const ONE = { id: 'p1', name: 'one', type: 'standalone', folderId: null, path: 'C:\\code\\one' };
const TWO = { id: 'p2', name: 'two', type: 'standalone', folderId: null, path: 'C:\\code\\two' };

beforeEach(() => {
  jest.clearAllMocks();
  fsMock.promises.mkdir.mockResolvedValue(undefined);
  fsMock.promises.writeFile.mockResolvedValue(undefined);
  fsMock.promises.rename.mockResolvedValue(undefined);
  fsMock.promises.copyFile.mockResolvedValue(undefined);
  fsMock.promises.unlink.mockResolvedValue(undefined);
});

afterEach(() => {
  stopExternalWatch();
  jest.useRealTimers();
});

test('a write by another process is still picked up after one of our own saves', async () => {
  jest.useFakeTimers();
  setDisk({ projects: [ONE], folders: [], rootOrder: ['p1'] }, 1000);
  await loadProjects();
  startExternalWatch();
  await jest.advanceTimersByTimeAsync(10);

  saveProjects();
  await jest.advanceTimersByTimeAsync(600);
  expect(fsMock.promises.writeFile).toHaveBeenCalled();

  // An MCP tool adds a project behind our back.
  setDisk({ projects: [ONE, TWO], folders: [], rootOrder: ['p1', 'p2'] }, 2000);
  await jest.advanceTimersByTimeAsync(3100);

  expect(projectsState.get().projects.map((p) => p.id)).toEqual(['p1', 'p2']);
});

test('flushProjectsSave writes a just-added remote project without waiting for the debounce', async () => {
  setDisk({ projects: [], folders: [], rootOrder: [] }, 1000);
  await loadProjects();
  fsMock.promises.writeFile.mockClear();

  const project = addProject({ remote: { profileId: 'abcd1234', path: '/home/dev/app', hostLabel: 'dev@box' } });
  await flushProjectsSave();

  expect(fsMock.promises.writeFile).toHaveBeenCalledTimes(1);
  const written = JSON.parse(fsMock.promises.writeFile.mock.calls[0][1]);
  expect(written.projects.map((p) => p.path)).toContain(project.path);
});

test('a projects.json that does not parse is not reloaded over the projects in memory', async () => {
  jest.useFakeTimers();
  setDisk({ projects: [ONE, TWO], folders: [], rootOrder: ['p1', 'p2'] }, 1000);
  await loadProjects();
  startExternalWatch();
  await jest.advanceTimersByTimeAsync(10);

  // Truncated by a writer that does not rename, or damaged on disk.
  fsMock.promises.readFile.mockResolvedValue('{"projects": [{"id": "p1"');
  fsMock.promises.stat.mockResolvedValue({ mtime: new Date(2000), size: 26 });
  await jest.advanceTimersByTimeAsync(3100);
  expect(projectsState.get().projects.map((p) => p.id)).toEqual(['p1', 'p2']);

  // An empty file is the same case: loadProjects() would start fresh.
  fsMock.promises.readFile.mockResolvedValue('');
  fsMock.promises.stat.mockResolvedValue({ mtime: new Date(2500), size: 0 });
  await jest.advanceTimersByTimeAsync(3100);
  expect(projectsState.get().projects.map((p) => p.id)).toEqual(['p1', 'p2']);

  // Once the file is whole again, the other writer's change is picked up.
  setDisk({ projects: [TWO], folders: [], rootOrder: ['p2'] }, 3000);
  await jest.advanceTimersByTimeAsync(3100);
  expect(projectsState.get().projects.map((p) => p.id)).toEqual(['p2']);
});
