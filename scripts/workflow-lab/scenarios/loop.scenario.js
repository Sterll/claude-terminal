'use strict';

const { assert, EXEC } = require('../sandbox');

/**
 * loop's Each/Done fan-out lives entirely in WorkflowRunner (loop.node.js run()
 * only resolves an item list), so every scenario here drives the real runner.
 *
 * Slots, from loop.node.js:
 *   inputs  0 = In (exec), 1 = items (array)
 *   outputs 0 = Each (exec), 1 = Done (exec), 2 = item, 3 = index
 *
 * Iterations are counted from the `workflow-log` messages a body log node
 * emits: the runner overwrites `outputs.node_<body>` on every iteration, so the
 * outputs map alone cannot tell three iterations from one.
 */

// ── graph helpers ────────────────────────────────────────────────────────────

function builder() {
  const nodes = [];
  const links = [];
  let linkId  = 1;

  const api = {
    trigger(id) {
      nodes.push({
        id, type: 'workflow/trigger', properties: {},
        inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [] }],
      });
      return id;
    },
    log(id, message) {
      nodes.push({
        id, type: 'workflow/log', properties: { level: 'info', message },
        inputs: [
          { name: 'In', type: EXEC, link: null },
          { name: 'message', type: 'string', link: null },
        ],
        outputs: [{ name: 'Done', type: EXEC, links: [] }],
      });
      return id;
    },
    loop(id, properties) {
      nodes.push({
        id, type: 'workflow/loop', properties,
        inputs: [
          { name: 'In', type: EXEC, link: null },
          { name: 'items', type: 'array', link: null },
        ],
        outputs: [
          { name: 'Each',  type: EXEC,     links: [] },
          { name: 'Done',  type: EXEC,     links: [] },
          { name: 'item',  type: 'any',    links: [] },
          { name: 'index', type: 'number', links: [] },
        ],
      });
      return id;
    },
    transform(id, properties) {
      nodes.push({
        id, type: 'workflow/transform', properties,
        inputs: [
          { name: 'In', type: EXEC, link: null },
          { name: 'input', type: 'any', link: null },
        ],
        outputs: [
          { name: 'Done',   type: EXEC,     links: [] },
          { name: 'Error',  type: EXEC,     links: [] },
          { name: 'result', type: 'any',    links: [] },
          { name: 'count',  type: 'number', links: [] },
        ],
      });
      return id;
    },
    /** A transform with an unknown operation — throws, and its Error pin is free. */
    boom(id) {
      return api.transform(id, { operation: 'boom' });
    },
    link(originId, originSlot, targetId, targetSlot = 0) {
      links.push([linkId++, originId, originSlot, targetId, targetSlot, EXEC]);
    },
    build() { return { nodes, links }; },
  };
  return api;
}

/** Every message the log nodes actually emitted, in execution order. */
function logMessages(sb) {
  return sb.sent.filter(s => s.channel === 'workflow-log').map(s => s.payload.message);
}

module.exports = {
  type: 'loop',
  scenarios: [
    {
      name: 'each item runs the body exactly once, in order, with item and index bound',
      graph() {
        const g = builder();
        g.trigger(1);
        g.loop(2, { source: 'custom', items: 'alpha\nbeta\ngamma' });
        g.log(3, 'body:$index:$item');
        g.log(4, 'after-loop');
        g.link(1, 0, 2);      // trigger  -> loop In
        g.link(2, 0, 3);      // loop Each -> body
        g.link(2, 1, 4);      // loop Done -> continuation
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), [
          'body:0:alpha', 'body:1:beta', 'body:2:gamma', 'after-loop',
        ]);
        assert.strictEqual(result.outputs.node_2.count, 3);
        assert.strictEqual(result.outputs.node_2.items.length, 3);
      },
    },
    {
      name: 'an empty list runs the body zero times yet still continues down Done',
      graph() {
        const g = builder();
        g.trigger(1);
        g.loop(2, { source: 'custom', items: '' });
        g.log(3, 'body-ran');
        g.log(4, 'after-loop');
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        g.link(2, 1, 4);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), ['after-loop'], 'body must not run on an empty list');
        assert.strictEqual(result.outputs.node_2.count, 0);
        assert.ok(result.outputs.node_4, 'Done branch must still run');
      },
    },
    {
      name: 'maxIterations caps how many times the body runs',
      graph() {
        const g = builder();
        g.trigger(1);
        g.loop(2, { source: 'custom', items: 'a\nb\nc\nd\ne', maxIterations: '2' });
        g.log(3, 'body:$index');
        g.log(4, 'after-loop');
        g.link(1, 0, 2);
        g.link(2, 0, 3);
        g.link(2, 1, 4);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), ['body:0', 'body:1', 'after-loop']);
        assert.strictEqual(result.outputs.node_2.count, 2, 'the cap must be reflected in the loop output');
      },
    },
    {
      name: 'a nested loop runs its body once per outer x inner pair',
      graph() {
        const g = builder();
        g.trigger(1);
        g.loop(2, { source: 'custom', items: 'a\nb' });          // outer
        g.loop(3, { source: 'custom', items: 'x\ny' });          // inner, on outer Each
        g.log(4, 'pair:$item');
        g.log(5, 'after-outer');
        g.link(1, 0, 2);
        g.link(2, 0, 3);      // outer Each -> inner loop
        g.link(3, 0, 4);      // inner Each -> body
        g.link(2, 1, 5);      // outer Done -> continuation
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), [
          'pair:x', 'pair:y', 'pair:x', 'pair:y', 'after-outer',
        ], '2 outer items x 2 inner items = 4 body runs, then one continuation');
        assert.strictEqual(result.outputs.node_2.count, 2);
        assert.strictEqual(result.outputs.node_3.count, 2);
      },
    },
    {
      name: 'source "auto" iterates the array produced by the upstream node',
      graph() {
        const g = builder();
        g.trigger(1);
        g.transform(2, { operation: 'json_parse', input: '["one","two"]' });
        g.loop(3, { source: 'auto' });
        g.log(4, 'item:$item');
        g.log(5, 'after-loop');
        g.link(1, 0, 2);
        g.link(2, 0, 3);      // transform Done -> loop In (auto reads its output)
        g.link(3, 0, 4);
        g.link(3, 1, 5);
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, true, result.error);
        assert.deepStrictEqual(logMessages(sb), ['item:one', 'item:two', 'after-loop']);
        assert.strictEqual(result.outputs.node_3.count, 2);
      },
    },
    {
      name: 'a throw in the body aborts the run at that iteration and never reaches Done',
      graph() {
        const g = builder();
        g.trigger(1);
        g.loop(2, { source: 'custom', items: 'a\nb\nc' });
        g.log(3, 'iter:$index');
        g.boom(4);            // transform with an unknown operation -> throws
        g.log(5, 'after-loop');
        g.link(1, 0, 2);
        g.link(2, 0, 3);      // Each -> log -> boom
        g.link(3, 0, 4);
        g.link(2, 1, 5);      // Done -> continuation (must never run)
        return g.build();
      },
      assert(result, sb) {
        assert.strictEqual(result.success, false, 'an unhandled body error must fail the run');
        assert.match(result.error, /Unknown transform operation/);
        assert.deepStrictEqual(logMessages(sb), ['iter:0'],
          'the loop must stop at the failing iteration and skip the Done branch');
        assert.strictEqual(result.outputs.node_5, undefined);
      },
    },
  ],
};
