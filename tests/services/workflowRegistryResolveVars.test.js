// Regression tests for the ROBUST resolveVars exported by the node registry
// (src/main/workflow-nodes/_registry.js). Distinct from the WorkflowRunner copy:
// this one accepts null/undefined/plain-object/Map stores and never dumps a
// parent object when a leaf is missing.

const { resolveVars } = require('../../src/main/workflow-nodes/_registry');

describe('registry resolveVars', () => {
  describe('single-reference fast path returns raw value', () => {
    test('$x pointing to an array returns the array itself', () => {
      const arr = [1, 2, 3];
      const vars = new Map([['list', arr]]);
      expect(resolveVars('$list', vars)).toBe(arr);
    });

    test('$x pointing to an object returns the object itself', () => {
      const obj = { a: 1 };
      const vars = new Map([['data', obj]]);
      expect(resolveVars('$data', vars)).toBe(obj);
    });

    test('$x pointing to a number returns the number', () => {
      const vars = new Map([['n', 42]]);
      expect(resolveVars('$n', vars)).toBe(42);
    });

    test('$a.b.c nested reference returns the leaf value', () => {
      const vars = new Map([['a', { b: { c: 'deep' } }]]);
      expect(resolveVars('$a.b.c', vars)).toBe('deep');
    });

    test('unresolved single ref stays literal', () => {
      const vars = new Map();
      expect(resolveVars('$missing', vars)).toBe('$missing');
    });
  });

  describe('leaf missing inside a larger string => empty, never a JSON dump', () => {
    test('object parent with missing leaf substitutes empty string', () => {
      const vars = new Map([['obj', { present: 'yes' }]]);
      // $obj.absent is inside a larger string → object never dumped, leaf empty
      expect(resolveVars('value=[$obj.absent]', vars)).toBe('value=[]');
    });

    test('reference to an object inside a larger string yields empty (no dump)', () => {
      const vars = new Map([['obj', { key: 'val' }]]);
      const result = resolveVars('data: $obj end', vars);
      expect(result).toBe('data:  end');
      expect(result).not.toContain('key');
    });

    test('resolved-but-null leaf yields empty string in larger string', () => {
      const vars = new Map([['x', null]]);
      // Use a non-word delimiter so $x is the whole reference (b would extend it).
      expect(resolveVars('a-$x-b', vars)).toBe('a--b');
    });
  });

  describe('various vars container shapes', () => {
    test('null vars leaves references literal', () => {
      expect(resolveVars('$foo', null)).toBe('$foo');
    });

    test('undefined vars leaves references literal', () => {
      expect(resolveVars('$foo', undefined)).toBe('$foo');
    });

    test('plain object store resolves single ref', () => {
      expect(resolveVars('$name', { name: 'Alice' })).toBe('Alice');
    });

    test('plain object store resolves nested ref', () => {
      expect(resolveVars('$user.role', { user: { role: 'admin' } })).toBe('admin');
    });

    test('Map store resolves interpolated reference', () => {
      const vars = new Map([['name', 'Bob']]);
      expect(resolveVars('Hi $name!', vars)).toBe('Hi Bob!');
    });
  });

  describe('pass-through', () => {
    test('non-string input returned unchanged', () => {
      expect(resolveVars(123, new Map())).toBe(123);
      expect(resolveVars(null, new Map())).toBe(null);
      const obj = { a: 1 };
      expect(resolveVars(obj, new Map())).toBe(obj);
    });

    test('string with no references is unchanged', () => {
      expect(resolveVars('plain text', new Map([['x', 'y']]))).toBe('plain text');
    });

    test('unknown reference inside larger string becomes empty (null leaf)', () => {
      // _lookup returns undefined for unknown root; the replace callback treats
      // val == null as empty string in the mixed-string branch.
      const vars = new Map([['known', 'k']]);
      expect(resolveVars('$known-$unknown', vars)).toBe('k-');
    });
  });
});
