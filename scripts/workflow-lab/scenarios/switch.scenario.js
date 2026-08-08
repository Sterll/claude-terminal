'use strict';

const { assert, EXEC } = require('../sandbox');

/**
 * switch builds one exec output per case, plus a trailing `default` port, and
 * the runner routes to the matched slot. run() alone only reports a slot number;
 * whether execution actually lands there lives in WorkflowRunner, so these drive
 * the real runner and check which branch's log node ran.
 */

/**
 * trigger -> switch, with one log node hung off every case port and off default.
 * Log node ids are 10 + slotIndex, so `default` is 10 + cases.length.
 */
function switchGraph(properties) {
  const cases = (properties.cases || '').split(',').map(c => c.trim()).filter(Boolean);
  const ports = [...cases, 'default'];

  const outputs = ports.map((name, i) => ({ name, type: EXEC, links: [100 + i] }));
  const logs    = ports.map((name, i) => ({
    id: 10 + i, type: 'workflow/log',
    properties: { level: 'info', message: `took ${name}` },
    inputs:  [{ name: 'In', type: EXEC, link: 100 + i }],
    outputs: [{ name: 'Done', type: EXEC, links: [] }],
  }));
  const caseLinks = ports.map((name, i) => [100 + i, 2, i, 10 + i, 0, EXEC]);

  return {
    nodes: [
      {
        id: 1, type: 'workflow/trigger', properties: {},
        inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [1] }],
      },
      { id: 2, type: 'workflow/switch', properties, inputs: [{ name: 'In', type: EXEC, link: 1 }], outputs },
      ...logs,
    ],
    links: [[1, 1, 0, 2, 0, EXEC], ...caseLinks],
  };
}

/** Which port(s) actually executed, by name. */
function portsTaken(result, properties) {
  const ports = [...(properties.cases || '').split(',').map(c => c.trim()).filter(Boolean), 'default'];
  return ports.filter((_, i) => result.outputs?.[`node_${10 + i}`] != null);
}

module.exports = {
  type: 'switch',
  scenarios: [
    {
      name: 'a value matching a case executes that case and nothing else',
      async setup(sb) { sb.vars.set('env', 'staging'); },
      graph: () => switchGraph({ variable: '$env', cases: 'dev,staging,prod' }),
      assert(result) {
        assert.deepStrictEqual(portsTaken(result, { cases: 'dev,staging,prod' }), ['staging']);
      },
    },
    {
      name: 'the first case is reachable, not skipped by an off-by-one slot',
      async setup(sb) { sb.vars.set('env', 'dev'); },
      graph: () => switchGraph({ variable: '$env', cases: 'dev,staging,prod' }),
      assert(result) {
        assert.deepStrictEqual(portsTaken(result, { cases: 'dev,staging,prod' }), ['dev']);
      },
    },
    {
      name: 'the last case is reachable, not swallowed by the default port',
      async setup(sb) { sb.vars.set('env', 'prod'); },
      graph: () => switchGraph({ variable: '$env', cases: 'dev,staging,prod' }),
      assert(result) {
        assert.deepStrictEqual(portsTaken(result, { cases: 'dev,staging,prod' }), ['prod']);
      },
    },
    {
      name: 'a value matching no case falls through to default',
      async setup(sb) { sb.vars.set('env', 'canary'); },
      graph: () => switchGraph({ variable: '$env', cases: 'dev,staging,prod' }),
      assert(result) {
        assert.deepStrictEqual(portsTaken(result, { cases: 'dev,staging,prod' }), ['default']);
        assert.strictEqual(result.outputs.node_2.matchedCase, 'default');
      },
    },
    {
      name: 'an unresolved variable falls through to default instead of stalling the run',
      graph: () => switchGraph({ variable: '$neverDefined', cases: 'dev,prod' }),
      assert(result) {
        assert.strictEqual(result.success, true, `run did not complete: ${result.error}`);
        assert.deepStrictEqual(portsTaken(result, { cases: 'dev,prod' }), ['default']);
      },
    },
    {
      name: 'no variable configured routes to default rather than matching an empty case',
      graph: () => switchGraph({ variable: '', cases: 'dev,prod' }),
      assert(result) {
        assert.strictEqual(result.success, true, `run did not complete: ${result.error}`);
        assert.deepStrictEqual(portsTaken(result, { cases: 'dev,prod' }), ['default']);
      },
    },
    {
      name: 'with no cases at all everything reaches the lone default port',
      async setup(sb) { sb.vars.set('env', 'prod'); },
      graph: () => switchGraph({ variable: '$env', cases: '' }),
      assert(result) {
        assert.deepStrictEqual(portsTaken(result, { cases: '' }), ['default']);
      },
    },
    {
      name: 'a numeric variable matches the case the user typed as text',
      async setup(sb) { sb.vars.set('status', 404); },
      graph: () => switchGraph({ variable: '$status', cases: '200,404,500' }),
      assert(result) {
        assert.deepStrictEqual(portsTaken(result, { cases: '200,404,500' }), ['404']);
      },
    },
    {
      name: 'whitespace around a case does not stop it matching',
      async setup(sb) { sb.vars.set('env', 'prod'); },
      graph: () => switchGraph({ variable: '$env', cases: ' dev , prod ' }),
      assert(result) {
        assert.deepStrictEqual(portsTaken(result, { cases: ' dev , prod ' }), ['prod']);
      },
    },
    {
      name: 'a duplicated case value fires the first port only, never both',
      async setup(sb) { sb.vars.set('env', 'prod'); },
      graph: () => switchGraph({ variable: '$env', cases: 'prod,staging,prod' }),
      assert(result) {
        const taken = portsTaken(result, { cases: 'prod,staging,prod' });
        assert.strictEqual(taken.length, 1, `${taken.length} ports executed: ${taken.join(', ')}`);
        assert.strictEqual(result.outputs.node_10 != null, true, 'the first matching port did not run');
        assert.strictEqual(result.outputs.node_12, undefined, 'the duplicate port also ran');
      },
    },
    {
      name: 'exactly one port runs — never several, never none',
      async setup(sb) { sb.vars.set('env', 'staging'); },
      graph: () => switchGraph({ variable: '$env', cases: 'dev,staging,prod' }),
      assert(result) {
        const taken = portsTaken(result, { cases: 'dev,staging,prod' });
        assert.strictEqual(taken.length, 1, `ports executed: ${taken.join(', ') || 'none'}`);
      },
    },
    {
      name: 'the matched case is reported on the step output for the run log',
      async setup(sb) { sb.vars.set('env', 'staging'); },
      graph: () => switchGraph({ variable: '$env', cases: 'dev,staging,prod' }),
      assert(result) {
        assert.strictEqual(result.outputs.node_2.value, 'staging');
        assert.strictEqual(result.outputs.node_2.matchedCase, 'staging');
        assert.strictEqual(result.outputs.node_2.success, true);
      },
    },
  ],
};
