// BackgroundTaskReconciler — the backstop that keeps a background-task card
// from spinning forever when its end bookend never arrives.
//
// The subtlety under test is the race: the live-task set normally drops a task
// slightly *before* its bookend lands, so settling on absence alone would
// mislabel every normal completion. Timers are injected so the grace window is
// exercised deterministically rather than by waiting.

const { BackgroundTaskReconciler, DEFAULT_GRACE_MS } = require('../../src/renderer/services/BackgroundTaskReconciler');

/** Minimal controllable clock: run() fires everything scheduled so far. */
function makeClock() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimer: (fn, ms) => { const id = nextId++; scheduled.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { scheduled.delete(id); },
    run: () => {
      const due = [...scheduled.values()];
      scheduled.clear();
      for (const { fn } of due) fn();
    },
    pendingCount: () => scheduled.size,
    lastDelay: () => [...scheduled.values()].pop()?.ms,
  };
}

function makeReconciler(overrides = {}) {
  const clock = makeClock();
  const settled = [];
  const reconciler = new BackgroundTaskReconciler({
    onSettle: (id) => settled.push(id),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...overrides,
  });
  return { reconciler, clock, settled };
}

describe('sync', () => {
  test('settles a running task that vanished from the live set', () => {
    const { reconciler, clock, settled } = makeReconciler();

    reconciler.sync([], ['task-1']);
    expect(settled).toEqual([]); // not before the grace window

    clock.run();
    expect(settled).toEqual(['task-1']);
  });

  test('leaves a task alone while it is still in the live set', () => {
    const { reconciler, clock, settled } = makeReconciler();

    reconciler.sync(['task-1'], ['task-1']);
    clock.run();

    expect(settled).toEqual([]);
  });

  test('does not stack timers when the same absence repeats', () => {
    const { reconciler, clock } = makeReconciler();

    reconciler.sync([], ['task-1']);
    reconciler.sync([], ['task-1']);
    reconciler.sync([], ['task-1']);

    // Membership changes are frequent; one backstop per task, not one per event.
    expect(clock.pendingCount()).toBe(1);
  });

  test('cancels the backstop when a task returns to the live set', () => {
    const { reconciler, clock, settled } = makeReconciler();

    reconciler.sync([], ['task-1']);
    expect(reconciler.isPending('task-1')).toBe(true);

    reconciler.sync(['task-1'], ['task-1']);
    expect(reconciler.isPending('task-1')).toBe(false);

    clock.run();
    expect(settled).toEqual([]);
  });

  test('handles several tasks independently', () => {
    const { reconciler, clock, settled } = makeReconciler();

    reconciler.sync(['task-2'], ['task-1', 'task-2', 'task-3']);
    clock.run();

    expect(settled.sort()).toEqual(['task-1', 'task-3']);
  });

  test('ignores empty ids rather than scheduling for them', () => {
    const { reconciler, clock } = makeReconciler();

    reconciler.sync([], ['', null, undefined]);

    expect(clock.pendingCount()).toBe(0);
  });

  test('accepts a Set as the live collection', () => {
    const { reconciler, clock, settled } = makeReconciler();

    reconciler.sync(new Set(['task-1']), ['task-1']);
    clock.run();

    expect(settled).toEqual([]);
  });

  test('tolerates missing collections', () => {
    const { reconciler, clock } = makeReconciler();

    expect(() => reconciler.sync(null, null)).not.toThrow();
    expect(clock.pendingCount()).toBe(0);
  });

  test('uses the default grace window unless told otherwise', () => {
    const { reconciler, clock } = makeReconciler();
    reconciler.sync([], ['task-1']);
    expect(clock.lastDelay()).toBe(DEFAULT_GRACE_MS);
  });
});

describe('cancel', () => {
  test('a bookend arriving inside the window wins the race', () => {
    const { reconciler, clock, settled } = makeReconciler();

    // The set drops the task first — the normal ordering.
    reconciler.sync([], ['task-1']);
    // Then its bookend lands and the caller settles it for real.
    reconciler.cancel('task-1');
    clock.run();

    // The backstop must not fire, or it would overwrite the real outcome.
    expect(settled).toEqual([]);
  });

  test('is a no-op for an unknown task', () => {
    const { reconciler } = makeReconciler();
    expect(() => reconciler.cancel('never-seen')).not.toThrow();
  });
});

describe('dispose', () => {
  test('drops every pending backstop', () => {
    const { reconciler, clock, settled } = makeReconciler();

    reconciler.sync([], ['task-1', 'task-2']);
    reconciler.dispose();
    clock.run();

    // A closed tab must not settle cards that no longer exist.
    expect(settled).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
  });
});
