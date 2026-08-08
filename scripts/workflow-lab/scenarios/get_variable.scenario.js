'use strict';

const { assert, EXEC } = require('../sandbox');

/**
 * get_variable has no run(): it is a pure data node with no exec pins, resolved
 * on demand by the runner when something downstream asks for its value. So every
 * scenario here drives a real graph and observes the value through a consumer —
 * there is nothing to call directly.
 */

/**
 * trigger -> log(3) -> log(4), with the get_variable node feeding the `message`
 * data pin of both logs. Two consumers, so we can also see that one node can
 * serve several readers.
 */
function readerGraph(props) {
  return {
    nodes: [
      {
        id: 1, type: 'workflow/trigger', properties: {},
        inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [1] }],
      },
      {
        id: 2, type: 'workflow/get_variable', properties: props,
        inputs: [], outputs: [{ name: 'value', type: 'any', links: [2, 4] }],
      },
      {
        id: 3, type: 'workflow/log', properties: { level: 'info', message: 'NOT SUPPLIED' },
        inputs: [
          { name: 'In',      type: EXEC,     link: 1 },
          { name: 'message', type: 'string', link: 2 },
        ],
        outputs: [{ name: 'Done', type: EXEC, links: [3] }],
      },
      {
        id: 4, type: 'workflow/log', properties: { level: 'info', message: 'NOT SUPPLIED' },
        inputs: [
          { name: 'In',      type: EXEC,     link: 3 },
          { name: 'message', type: 'string', link: 4 },
        ],
        outputs: [{ name: 'Done', type: EXEC, links: [] }],
      },
    ],
    links: [
      [1, 1, 0, 3, 0, EXEC],
      [2, 2, 0, 3, 1, 'string'],
      [3, 3, 0, 4, 0, EXEC],
      [4, 2, 0, 4, 1, 'string'],
    ],
  };
}

module.exports = {
  type: 'get_variable',
  scenarios: [
    {
      name: 'the named variable reaches a downstream node with nothing wired into it',
      async setup(sb) { sb.vars.set('deployTarget', 'prod-eu'); },
      graph: () => readerGraph({ name: 'deployTarget', varType: 'string' }),
      assert(result) {
        assert.strictEqual(result.success, true, result.error);
        assert.strictEqual(result.outputs.node_3.message, 'prod-eu');
      },
    },
    {
      name: 'every reader of the same node sees the same value',
      async setup(sb) { sb.vars.set('deployTarget', 'prod-eu'); },
      graph: () => readerGraph({ name: 'deployTarget', varType: 'string' }),
      assert(result) {
        assert.strictEqual(result.outputs.node_3.message, 'prod-eu');
        assert.strictEqual(result.outputs.node_4.message, 'prod-eu');
      },
    },
    {
      name: 'a var_-prefixed entry is found under its bare name',
      // Trigger payloads and earlier runs store variables under `var_<name>`;
      // the user types the bare name in the node.
      async setup(sb) { sb.vars.set('var_token', 'abc123'); },
      graph: () => readerGraph({ name: 'token', varType: 'string' }),
      assert(result) {
        assert.strictEqual(result.outputs.node_3.message, 'abc123');
      },
    },
    {
      name: 'a non-string variable keeps its type on the way out',
      async setup(sb) { sb.vars.set('report', { failures: 2 }); },
      graph: () => readerGraph({ name: 'report', varType: 'object' }),
      assert(result) {
        assert.deepStrictEqual(result.outputs.node_3.message, { failures: 2 });
      },
    },
    {
      name: 'it never shows up as an executed step — it has no exec pins',
      async setup(sb) { sb.vars.set('deployTarget', 'prod-eu'); },
      graph: () => readerGraph({ name: 'deployTarget', varType: 'string' }),
      assert(result) {
        assert.strictEqual(
          result.outputs.node_2, undefined,
          'a pure data node was recorded as a run step',
        );
        assert.strictEqual(result.outputs.node_3.message, 'prod-eu', 'yet its value must still arrive');
      },
    },
    {
      name: 'an unknown variable resolves to nothing instead of stalling the run',
      graph: () => readerGraph({ name: 'neverDefined', varType: 'string' }),
      assert(result) {
        assert.strictEqual(result.success, true, `run did not complete: ${result.error}`);
        assert.strictEqual(result.outputs.node_3.message, '', 'expected an empty value, got a literal');
      },
    },
    {
      name: 'an empty name is not treated as a wildcard read',
      graph: () => readerGraph({ name: '', varType: 'any' }),
      assert(result) {
        assert.strictEqual(result.success, true, `run did not complete: ${result.error}`);
        assert.strictEqual(result.outputs.node_3.message, '');
      },
    },
    {
      name: 'names are read flat — a dotted path is not traversed into an object',
      async setup(sb) { sb.vars.set('report', { failures: 2 }); },
      graph: () => readerGraph({ name: 'report.failures', varType: 'number' }),
      assert(result) {
        assert.strictEqual(result.success, true, `run did not complete: ${result.error}`);
        assert.strictEqual(
          result.outputs.node_3.message, '',
          'dotted paths now resolve here — the node contract changed',
        );
      },
    },
  ],
};
