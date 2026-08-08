'use strict';

const { assert } = require('../sandbox');

module.exports = {
  type: 'transform',
  scenarios: [
    {
      name: 'map applies an expression to every item',
      async setup(sb) { sb.vars.set('nums', [1, 2, 3]); },
      config: { operation: 'map', input: '$nums', expression: 'item * 2' },
      assert(out) {
        assert.deepStrictEqual(out.result, [2, 4, 6]);
        assert.strictEqual(out.count, 3);
      },
    },
    {
      name: 'filter keeps only matching items',
      async setup(sb) { sb.vars.set('nums', [1, 2, 3, 4, 5]); },
      config: { operation: 'filter', input: '$nums', expression: 'item % 2 === 0' },
      assert(out) {
        assert.deepStrictEqual(out.result, [2, 4]);
        assert.strictEqual(out.count, 2);
      },
    },
    {
      name: 'find returns the first match, not an array',
      async setup(sb) { sb.vars.set('nums', [1, 5, 9]); },
      config: { operation: 'find', input: '$nums', expression: 'item > 3' },
      assert(out) {
        assert.strictEqual(out.result, 5);
      },
    },
    {
      name: 'reduce folds with the configured initial value',
      async setup(sb) { sb.vars.set('nums', [1, 2, 3, 4]); },
      config: { operation: 'reduce', input: '$nums', expression: 'acc + item', initialValue: '0' },
      assert(out) {
        assert.strictEqual(out.result, 10);
      },
    },
    {
      name: 'pluck extracts one field from each object',
      async setup(sb) { sb.vars.set('rows', [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]); },
      config: { operation: 'pluck', input: '$rows', expression: 'name' },
      assert(out) {
        assert.deepStrictEqual(out.result, ['a', 'b']);
      },
    },
    {
      name: 'count returns the length',
      async setup(sb) { sb.vars.set('rows', ['a', 'b', 'c']); },
      config: { operation: 'count', input: '$rows' },
      assert(out) {
        assert.strictEqual(out.result, 3);
      },
    },
    {
      name: 'unique removes duplicates',
      async setup(sb) { sb.vars.set('rows', ['a', 'b', 'a', 'c', 'b']); },
      config: { operation: 'unique', input: '$rows' },
      assert(out) {
        assert.deepStrictEqual([...out.result].sort(), ['a', 'b', 'c']);
      },
    },
    {
      name: 'flatten collapses one level of nesting',
      async setup(sb) { sb.vars.set('rows', [[1, 2], [3], [4, 5]]); },
      config: { operation: 'flatten', input: '$rows' },
      assert(out) {
        assert.deepStrictEqual(out.result, [1, 2, 3, 4, 5]);
      },
    },
    {
      name: 'a non-array input does not take down the run silently',
      async setup(sb) { sb.vars.set('notAList', 'plain string'); },
      config: { operation: 'map', input: '$notAList', expression: 'item * 2' },
      assert(out) {
        // Either it coerces sensibly or it reports failure — what it must not do
        // is return a bogus result while claiming success.
        if (out.success === true) {
          assert.ok(Array.isArray(out.result), `success with non-array result: ${JSON.stringify(out.result)}`);
        }
      },
    },
  ],
};
