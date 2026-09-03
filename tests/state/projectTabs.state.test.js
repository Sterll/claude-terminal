// Open project tabs.
//
// The tab list is addressed by project id while the active project is an index
// into `projects`, so the interesting cases are the ones where those two views
// have to agree: closing the active tab, reordering by drag, and restoring a
// list saved by a previous run.

const {
  projectsState,
  restoreOpenProjectIds,
  isProjectOpen,
  getOpenProjects,
  openProjectTab,
  closeProjectTab,
  moveProjectTab,
  setSelectedProjectFilter,
} = require('../../src/renderer/state/projects.state');

const PROJECTS = [
  { id: 'p1', name: 'one', path: '/tmp/one' },
  { id: 'p2', name: 'two', path: '/tmp/two' },
  { id: 'p3', name: 'three', path: '/tmp/three' },
  { id: 'p4', name: 'four', path: '/tmp/four' },
];

function reset(override = {}) {
  projectsState.set({
    projects: PROJECTS.map(p => ({ ...p })),
    folders: [],
    rootOrder: PROJECTS.map(p => p.id),
    selectedProjectFilter: null,
    openedProjectId: null,
    openProjectIds: [],
    ...override,
  });
}

const openIds = () => projectsState.get().openProjectIds;

beforeEach(() => {
  jest.clearAllMocks();
  reset();
  window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
  window.electron_nodeModules.fs.readFileSync.mockReturnValue('{}');
  window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
  window.electron_nodeModules.fs.renameSync.mockImplementation(() => {});
});

describe('openProjectTab', () => {
  test('gives the project a tab and makes it active', () => {
    openProjectTab('p2');

    expect(openIds()).toEqual(['p2']);
    expect(isProjectOpen('p2')).toBe(true);
    expect(projectsState.get().selectedProjectFilter).toBe(1);
  });

  test('opening the same project twice does not duplicate the tab', () => {
    openProjectTab('p2');
    openProjectTab('p2');

    expect(openIds()).toEqual(['p2']);
  });

  test('activate:false gives a tab without stealing focus', () => {
    openProjectTab('p1');
    openProjectTab('p3', { activate: false });

    expect(openIds()).toEqual(['p1', 'p3']);
    expect(projectsState.get().selectedProjectFilter).toBe(0);
  });

  test('an unknown id opens nothing', () => {
    openProjectTab('nope');

    expect(openIds()).toEqual([]);
  });
});

describe('setSelectedProjectFilter', () => {
  test('selecting a project also gives it a tab', () => {
    setSelectedProjectFilter(2);

    expect(openIds()).toEqual(['p3']);
    expect(projectsState.get().selectedProjectFilter).toBe(2);
  });

  test('clearing the filter opens nothing', () => {
    setSelectedProjectFilter(null);

    expect(openIds()).toEqual([]);
    expect(projectsState.get().selectedProjectFilter).toBe(null);
  });
});

describe('closeProjectTab', () => {
  test('closing an inactive tab leaves the active project alone', () => {
    reset({ openProjectIds: ['p1', 'p2', 'p3'], selectedProjectFilter: 0 });

    expect(closeProjectTab('p3')).toBe(null);
    expect(openIds()).toEqual(['p1', 'p2']);
    expect(projectsState.get().selectedProjectFilter).toBe(0);
  });

  test('closing the active tab moves focus to its right', () => {
    reset({ openProjectIds: ['p1', 'p2', 'p3'], selectedProjectFilter: 1 });

    // p2 closes, so the tab the eye is already on is p3
    expect(closeProjectTab('p2')).toBe(2);
    expect(openIds()).toEqual(['p1', 'p3']);
    expect(projectsState.get().selectedProjectFilter).toBe(2);
  });

  test('closing the last tab falls back to its left', () => {
    reset({ openProjectIds: ['p1', 'p2'], selectedProjectFilter: 1 });

    expect(closeProjectTab('p2')).toBe(0);
    expect(projectsState.get().selectedProjectFilter).toBe(0);
  });

  test('closing the only tab leaves nothing active', () => {
    reset({ openProjectIds: ['p2'], selectedProjectFilter: 1 });

    expect(closeProjectTab('p2')).toBe(null);
    expect(openIds()).toEqual([]);
    expect(projectsState.get().selectedProjectFilter).toBe(null);
  });

  test('closing a project with no tab is a no-op', () => {
    reset({ openProjectIds: ['p1'], selectedProjectFilter: 0 });

    expect(closeProjectTab('p4')).toBe(null);
    expect(openIds()).toEqual(['p1']);
  });
});

describe('moveProjectTab', () => {
  test('moves a tab to a later position', () => {
    reset({ openProjectIds: ['p1', 'p2', 'p3'] });

    moveProjectTab('p1', 2);

    expect(openIds()).toEqual(['p2', 'p3', 'p1']);
  });

  test('moves a tab to an earlier position', () => {
    reset({ openProjectIds: ['p1', 'p2', 'p3'] });

    moveProjectTab('p3', 0);

    expect(openIds()).toEqual(['p3', 'p1', 'p2']);
  });

  test('a target past the end lands at the end rather than dropping the tab', () => {
    reset({ openProjectIds: ['p1', 'p2', 'p3'] });

    moveProjectTab('p1', 99);

    expect(openIds()).toEqual(['p2', 'p3', 'p1']);
  });

  test('a negative target lands at the front', () => {
    reset({ openProjectIds: ['p1', 'p2', 'p3'] });

    moveProjectTab('p3', -5);

    expect(openIds()).toEqual(['p3', 'p1', 'p2']);
  });

  test('moving a project that has no tab changes nothing', () => {
    reset({ openProjectIds: ['p1', 'p2'] });

    moveProjectTab('p4', 0);

    expect(openIds()).toEqual(['p1', 'p2']);
  });
});

describe('restoreOpenProjectIds', () => {
  test('restores the saved order', () => {
    restoreOpenProjectIds(['p3', 'p1']);

    expect(openIds()).toEqual(['p3', 'p1']);
    expect(getOpenProjects().map(p => p.name)).toEqual(['three', 'one']);
  });

  test('drops ids of projects that no longer exist', () => {
    restoreOpenProjectIds(['p1', 'deleted-since', 'p2']);

    expect(openIds()).toEqual(['p1', 'p2']);
  });

  test('ignores anything that is not a list', () => {
    reset({ openProjectIds: ['p1'] });

    restoreOpenProjectIds(undefined);
    restoreOpenProjectIds('p2');

    expect(openIds()).toEqual(['p1']);
  });
});

describe('getOpenProjects', () => {
  test('returns the projects in tab order, not in project order', () => {
    reset({ openProjectIds: ['p4', 'p1'] });

    expect(getOpenProjects().map(p => p.id)).toEqual(['p4', 'p1']);
  });

  test('skips ids with no matching project instead of returning holes', () => {
    reset({ openProjectIds: ['p1', 'ghost', 'p2'] });

    expect(getOpenProjects().map(p => p.id)).toEqual(['p1', 'p2']);
  });
});
