'use strict';

const { assert, EXEC } = require('../sandbox');

/**
 * variable is the workflow's mutable store: set / get / increment / append all
 * live behind one node. Most of it is observable through run() plus the vars
 * Map it writes into. The `get` action is different — it drops its exec pins and
 * becomes a pure data node, so only the runner can show that it still produces
 * a value with nothing wired into it. Those cases use `graph:`.
 */

/** trigger -> log, with node 2 feeding log's `message` data pin. */
function dataFeedGraph(sourceNode) {
  return {
    nodes: [
      {
        id: 1, type: 'workflow/trigger', properties: {},
        inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [1] }],
      },
      sourceNode,
      {
        id: 3, type: 'workflow/log', properties: { level: 'info', message: 'NOT SUPPLIED' },
        inputs: [
          { name: 'In',      type: EXEC,     link: 1 },
          { name: 'message', type: 'string', link: 2 },
        ],
        outputs: [{ name: 'Done', type: EXEC, links: [] }],
      },
    ],
    links: [
      [1, 1, 0, 3, 0, EXEC],
      [2, 2, 0, 3, 1, 'string'],
    ],
  };
}

module.exports = {
  type: 'variable',
  scenarios: [
    {
      name: 'set writes the value into the workflow store, not just its own output',
      config: { action: 'set', name: 'env', value: 'production' },
      assert(out, sb) {
        assert.strictEqual(out.action, 'set');
        assert.strictEqual(out.value, 'production');
        assert.strictEqual(sb.vars.get('env'), 'production');
      },
    },
    {
      name: 'set copies a referenced variable with its type intact, not stringified',
      async setup(sb) { sb.vars.set('count', 3); },
      config: { action: 'set', name: 'copy', value: '$count' },
      assert(out, sb) {
        assert.strictEqual(out.value, 3, 'the number was flattened to a string');
        assert.strictEqual(sb.vars.get('copy'), 3);
      },
    },
    {
      name: 'set interpolates a variable embedded in a larger string',
      async setup(sb) { sb.vars.set('id', 42); },
      config: { action: 'set', name: 'tag', value: 'build-$id' },
      assert(out) {
        assert.strictEqual(out.value, 'build-42');
      },
    },
    {
      name: 'set of an unresolved variable keeps the literal rather than writing undefined',
      config: { action: 'set', name: 'target', value: 'release-$missingVar' },
      assert(out, sb) {
        assert.strictEqual(out.value, 'release-$missingVar');
        assert.strictEqual(sb.vars.get('target'), 'release-$missingVar');
      },
    },
    {
      name: 'get reads the current value without touching the store',
      async setup(sb) { sb.vars.set('env', 'staging'); },
      config: { action: 'get', name: 'env' },
      assert(out, sb) {
        assert.strictEqual(out.value, 'staging');
        assert.strictEqual(out.action, 'get');
        assert.strictEqual(sb.vars.get('env'), 'staging', 'a read modified the variable');
      },
    },
    {
      name: 'get of a variable that was never set yields null, not undefined',
      config: { action: 'get', name: 'neverSet' },
      assert(out, sb) {
        assert.strictEqual(out.value, null);
        assert.strictEqual(sb.vars.has('neverSet'), false, 'reading created the variable');
      },
    },
    {
      name: 'increment of an unset counter starts it at 1',
      config: { action: 'increment', name: 'builds' },
      assert(out, sb) {
        assert.strictEqual(out.value, 1);
        assert.strictEqual(sb.vars.get('builds'), 1);
      },
    },
    {
      name: 'increment adds the configured step to the current value',
      async setup(sb) { sb.vars.set('score', 10); },
      config: { action: 'increment', name: 'score', value: '5' },
      assert(out, sb) {
        assert.strictEqual(out.value, 15);
        assert.strictEqual(sb.vars.get('score'), 15);
      },
    },
    {
      name: 'incrementing by an explicit 0 leaves the counter alone',
      // '0' is falsy — a `|| 1` default here would silently bump the counter.
      async setup(sb) { sb.vars.set('score', 7); },
      config: { action: 'increment', name: 'score', value: '0' },
      assert(out, sb) {
        assert.strictEqual(out.value, 7);
        assert.strictEqual(sb.vars.get('score'), 7);
      },
    },
    {
      name: 'increment counts from zero when the variable holds something non-numeric',
      async setup(sb) { sb.vars.set('score', 'not a number'); },
      config: { action: 'increment', name: 'score', value: '2' },
      assert(out) {
        assert.strictEqual(out.value, 2, `got ${out.value} — a NaN leaked into the counter`);
      },
    },
    {
      name: 'append creates the list when the variable does not exist yet',
      config: { action: 'append', name: 'errors', value: 'boom' },
      assert(out, sb) {
        assert.deepStrictEqual(out.value, ['boom']);
        assert.deepStrictEqual(sb.vars.get('errors'), ['boom']);
      },
    },
    {
      name: 'append extends an existing list without mutating the array it was given',
      async setup(sb) {
        sb.original = ['a'];
        sb.vars.set('items', sb.original);
      },
      config: { action: 'append', name: 'items', value: 'b' },
      assert(out, sb) {
        assert.deepStrictEqual(out.value, ['a', 'b']);
        assert.deepStrictEqual(sb.original, ['a'], 'the caller-owned array was mutated in place');
      },
    },
    {
      name: 'append to a non-list value wraps it instead of throwing it away',
      async setup(sb) { sb.vars.set('items', 'first'); },
      config: { action: 'append', name: 'items', value: 'second' },
      assert(out) {
        assert.deepStrictEqual(out.value, ['first', 'second']);
      },
    },
    {
      name: 'a node with no variable name is rejected instead of writing under ""',
      config: { action: 'set', value: 'orphan' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /name/i);
        assert.strictEqual(sb.vars.has(''), false);
      },
    },
    {
      name: 'an unknown action is rejected rather than silently doing nothing',
      config: { action: 'multiply', name: 'x', value: '2' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /unknown action/i);
      },
    },
    {
      name: 'a get-mode node supplies its value with no exec connection at all',
      async setup(sb) { sb.vars.set('env', 'staging'); },
      graph: () => dataFeedGraph({
        id: 2, type: 'workflow/variable',
        properties: { action: 'get', name: 'env', varType: 'string' },
        inputs: [],
        outputs: [{ name: 'value', type: 'any', links: [2] }],
      }),
      assert(result) {
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.outputs.node_3.message, 'staging');
      },
    },
    {
      name: 'a set-mode node wired only by a data pin never fires its side effect',
      // set/increment/append mutate the store, so they must go through exec flow;
      // resolving them on demand would write variables the user never triggered.
      graph: () => dataFeedGraph({
        id: 2, type: 'workflow/variable',
        properties: { action: 'set', name: 'ghost', value: 'written' },
        inputs: [{ name: 'In', type: EXEC, link: null }, { name: 'value', type: 'any', link: null }],
        outputs: [{ name: 'Done', type: EXEC, links: [] }, { name: 'value', type: 'any', links: [2] }],
      }),
      assert(result) {
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(
          result.outputs.node_3.message, 'NOT SUPPLIED',
          'an unexecuted set node produced a value — its write ran without exec flow',
        );
      },
    },
  ],
};
