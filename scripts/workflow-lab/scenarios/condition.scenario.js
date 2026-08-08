'use strict';

const { assert, EXEC } = require('../sandbox');

/**
 * condition routes execution down TRUE (slot 0) or FALSE (slot 1). run() alone
 * cannot show that, so these drive the real runner and check which branch's log
 * node actually executed.
 */
function branchGraph(properties) {
  return {
    nodes: [
      {
        id: 1, type: 'workflow/trigger', properties: {},
        inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [1] }],
      },
      {
        id: 2, type: 'workflow/condition', properties,
        inputs: [{ name: 'In', type: EXEC, link: 1 }],
        outputs: [
          { name: 'TRUE', type: EXEC, links: [2] },
          { name: 'FALSE', type: EXEC, links: [3] },
        ],
      },
      {
        id: 3, type: 'workflow/log', properties: { level: 'info', message: 'took TRUE' },
        inputs: [{ name: 'In', type: EXEC, link: 2 }],
        outputs: [{ name: 'Done', type: EXEC, links: [] }],
      },
      {
        id: 4, type: 'workflow/log', properties: { level: 'info', message: 'took FALSE' },
        inputs: [{ name: 'In', type: EXEC, link: 3 }],
        outputs: [{ name: 'Done', type: EXEC, links: [] }],
      },
    ],
    links: [
      [1, 1, 0, 2, 0, EXEC],
      [2, 2, 0, 3, 0, EXEC],
      [3, 2, 1, 4, 0, EXEC],
    ],
  };
}

/** Which branch ran? */
function branchTaken(result) {
  const t = result.outputs?.node_3 != null;
  const f = result.outputs?.node_4 != null;
  if (t && f) return 'BOTH';
  if (t) return 'TRUE';
  if (f) return 'FALSE';
  return 'NEITHER';
}

module.exports = {
  type: 'condition',
  scenarios: [
    {
      name: 'equality that holds routes down TRUE',
      async setup(sb) { sb.vars.set('status', 'ready'); },
      graph: () => branchGraph({ _condMode: 'builder', variable: '$status', operator: '==', value: 'ready' }),
      assert(result) {
        assert.strictEqual(branchTaken(result), 'TRUE');
      },
    },
    {
      name: 'equality that fails routes down FALSE',
      async setup(sb) { sb.vars.set('status', 'busy'); },
      graph: () => branchGraph({ _condMode: 'builder', variable: '$status', operator: '==', value: 'ready' }),
      assert(result) {
        assert.strictEqual(branchTaken(result), 'FALSE');
      },
    },
    {
      name: 'numeric greater-than compares as numbers, not strings',
      async setup(sb) { sb.vars.set('count', 9); },
      // '9' > '10' is true as strings and false as numbers — this pins the intent.
      graph: () => branchGraph({ _condMode: 'builder', variable: '$count', operator: '>', value: '10' }),
      assert(result) {
        assert.strictEqual(branchTaken(result), 'FALSE', '9 > 10 must be false');
      },
    },
    {
      name: 'contains matches a substring',
      async setup(sb) { sb.vars.set('branch', 'feature/login'); },
      graph: () => branchGraph({ _condMode: 'builder', variable: '$branch', operator: 'contains', value: 'feature/' }),
      assert(result) {
        assert.strictEqual(branchTaken(result), 'TRUE');
      },
    },
    {
      name: 'exactly one branch runs, never both',
      async setup(sb) { sb.vars.set('status', 'ready'); },
      graph: () => branchGraph({ _condMode: 'builder', variable: '$status', operator: '==', value: 'ready' }),
      assert(result) {
        assert.notStrictEqual(branchTaken(result), 'BOTH');
        assert.notStrictEqual(branchTaken(result), 'NEITHER');
      },
    },
    {
      name: 'an unresolved variable does not crash the run',
      graph: () => branchGraph({ _condMode: 'builder', variable: '$doesNotExist', operator: '==', value: 'x' }),
      assert(result) {
        assert.notStrictEqual(branchTaken(result), 'NEITHER', 'run stalled on an unknown variable');
      },
    },
  ],
};
