const {
  deepEqual,
  mergeEntity,
  mergeEntityList,
  reconcileOrder,
  mergeProjectsData,
  snapshot,
} = require('../../src/renderer/state/projects.merge');

describe('deepEqual', () => {
  test('compares nested structures by value', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  test('distinguishes missing keys from undefined values', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([], {})).toBe(false);
  });
});

describe('mergeEntity', () => {
  test('a field we did not touch takes the disk value', () => {
    const base = { id: 'p1', name: 'narvi', tasks: [] };
    const ours = { id: 'p1', name: 'narvi', tasks: [] };
    const theirs = { id: 'p1', name: 'narvi', tasks: [{ id: 't1' }] };

    expect(mergeEntity(base, ours, theirs).tasks).toEqual([{ id: 't1' }]);
  });

  test('a field we changed stays ours', () => {
    const base = { id: 'p1', name: 'narvi' };
    const ours = { id: 'p1', name: 'narvi-renamed' };
    const theirs = { id: 'p1', name: 'narvi-from-mcp' };

    expect(mergeEntity(base, ours, theirs).name).toBe('narvi-renamed');
  });

  test('a field we cleared on purpose stays cleared', () => {
    const base = { id: 'p1', tasks: [{ id: 't1' }] };
    const ours = { id: 'p1', tasks: [] };
    const theirs = { id: 'p1', tasks: [{ id: 't1' }] };

    expect(mergeEntity(base, ours, theirs).tasks).toEqual([]);
  });

  test('keeps a field only the disk knows about', () => {
    const merged = mergeEntity({ id: 'p1' }, { id: 'p1' }, { id: 'p1', kanbanLabels: ['x'] });
    expect(merged.kanbanLabels).toEqual(['x']);
  });
});

describe('mergeEntityList', () => {
  test('keeps an entity another writer added while we were running', () => {
    const base = [{ id: 'p1' }];
    const ours = [{ id: 'p1' }];
    const theirs = [{ id: 'p1' }, { id: 'wt1', name: 'worktree' }];

    const merged = mergeEntityList(base, ours, theirs);
    expect(merged.map(p => p.id)).toEqual(['p1', 'wt1']);
  });

  test('does not resurrect an entity we deleted', () => {
    const base = [{ id: 'p1' }, { id: 'p2' }];
    const ours = [{ id: 'p1' }];
    const theirs = [{ id: 'p1' }, { id: 'p2' }];

    const merged = mergeEntityList(base, ours, theirs);
    expect(merged.map(p => p.id)).toEqual(['p1']);
  });

  test('keeps an entity we added that the disk has not seen', () => {
    const merged = mergeEntityList([], [{ id: 'new' }], []);
    expect(merged.map(p => p.id)).toEqual(['new']);
  });
});

describe('reconcileOrder', () => {
  test('takes the disk order when we did not reorder', () => {
    const order = reconcileOrder(['a', 'b'], ['a', 'b'], ['b', 'a'], new Set(['a', 'b']));
    expect(order).toEqual(['b', 'a']);
  });

  test('keeps our order when we reordered', () => {
    const order = reconcileOrder(['a', 'b'], ['b', 'a'], ['a', 'b'], new Set(['a', 'b']));
    expect(order).toEqual(['b', 'a']);
  });

  test('drops ids with no surviving entity and appends orphans', () => {
    const order = reconcileOrder(['a'], ['a'], ['a', 'gone'], new Set(['a', 'added']));
    expect(order).toEqual(['a', 'added']);
  });
});

describe('mergeProjectsData — the incident', () => {
  // Reproduces the real data loss: an MCP session added 18 kanban tasks to
  // "narvi" after the renderer had loaded, then any renderer save rewrote the
  // whole file from its stale copy and wiped them.
  const baseline = {
    projects: [
      { id: 'narvi', name: 'narvi', tasks: [], kanbanColumns: [] },
      { id: 'ct', name: 'Claude Terminal', tasks: [] },
    ],
    folders: [],
    rootOrder: ['narvi', 'ct'],
  };

  const memoryCopy = {
    // Same as the baseline: the renderer never learned about the tasks.
    projects: [
      { id: 'narvi', name: 'narvi', tasks: [], kanbanColumns: [] },
      { id: 'ct', name: 'Claude Terminal', tasks: [] },
    ],
    folders: [],
    rootOrder: ['narvi', 'ct'],
  };

  const onDisk = {
    projects: [
      {
        id: 'narvi',
        name: 'narvi',
        tasks: Array.from({ length: 18 }, (_, i) => ({ id: `t${i}`, title: `task ${i}` })),
        kanbanColumns: [{ id: 'col-todo', title: 'To Do', order: 0 }],
      },
      { id: 'ct', name: 'Claude Terminal', tasks: [] },
      { id: 'wt', name: 'bg-agents · snapshot-retention (wt)', path: '/tmp/wt' },
    ],
    folders: [],
    rootOrder: ['narvi', 'ct', 'wt'],
  };

  test('the 18 tasks survive a save from a stale in-memory copy', () => {
    const merged = mergeProjectsData(baseline, memoryCopy, onDisk);
    const narvi = merged.projects.find(p => p.id === 'narvi');

    expect(narvi.tasks).toHaveLength(18);
    expect(narvi.kanbanColumns).toEqual([{ id: 'col-todo', title: 'To Do', order: 0 }]);
  });

  test('the worktree project the renderer never knew about is kept', () => {
    const merged = mergeProjectsData(baseline, memoryCopy, onDisk);

    expect(merged.projects.map(p => p.id)).toContain('wt');
    expect(merged.rootOrder).toContain('wt');
  });

  test('a rename made in the UI still wins over the disk', () => {
    const ours = JSON.parse(JSON.stringify(memoryCopy));
    ours.projects[0].name = 'narvi (renamed here)';

    const merged = mergeProjectsData(baseline, ours, onDisk);
    const narvi = merged.projects.find(p => p.id === 'narvi');

    expect(narvi.name).toBe('narvi (renamed here)');
    // ...without costing the tasks we never touched.
    expect(narvi.tasks).toHaveLength(18);
  });

  test('a project deleted in the UI is not brought back by the merge', () => {
    const ours = { ...memoryCopy, projects: [memoryCopy.projects[0]], rootOrder: ['narvi'] };

    const merged = mergeProjectsData(baseline, ours, onDisk);

    expect(merged.projects.map(p => p.id)).not.toContain('ct');
  });

  test('with nothing on disk our copy is written as-is', () => {
    const merged = mergeProjectsData(baseline, memoryCopy, null);
    expect(merged.projects).toEqual(memoryCopy.projects);
  });

  test('with no baseline the disk is treated as entirely new data', () => {
    const merged = mergeProjectsData(null, { projects: [], folders: [], rootOrder: [] }, onDisk);
    expect(merged.projects).toHaveLength(3);
  });
});

describe('snapshot', () => {
  test('detaches from the source object', () => {
    const src = { projects: [{ id: 'p', tasks: [] }], folders: [], rootOrder: ['p'] };
    const snap = snapshot(src);
    src.projects[0].tasks.push({ id: 't' });

    expect(snap.projects[0].tasks).toEqual([]);
  });
});
