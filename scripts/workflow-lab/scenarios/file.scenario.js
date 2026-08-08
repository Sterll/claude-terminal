'use strict';

const path = require('path');
const { assert } = require('../sandbox');

module.exports = {
  type: 'file',
  scenarios: [
    {
      name: 'read returns the file content',
      async setup(sb) { sb.file('notes.txt', 'sandbox content'); },
      config: (sb) => ({ action: 'read', path: path.join(sb.dir, 'notes.txt') }),
      assert(out) {
        assert.strictEqual(out.content, 'sandbox content');
      },
    },
    {
      name: 'write creates the file on disk',
      config: (sb) => ({ action: 'write', path: path.join(sb.dir, 'out/created.txt'), content: 'written by lab' }),
      assert(out, sb) {
        assert.ok(sb.exists('out/created.txt'), 'file was not created');
        assert.strictEqual(sb.read('out/created.txt'), 'written by lab');
      },
    },
    {
      name: 'append adds to an existing file',
      async setup(sb) { sb.file('log.txt', 'first\n'); },
      config: (sb) => ({ action: 'append', path: path.join(sb.dir, 'log.txt'), content: 'second\n' }),
      assert(out, sb) {
        assert.strictEqual(sb.read('log.txt'), 'first\nsecond\n');
      },
    },
    {
      name: 'exists reports true and false correctly',
      async setup(sb) { sb.file('there.txt', 'x'); },
      config: (sb) => ({ action: 'exists', path: path.join(sb.dir, 'there.txt') }),
      assert(out) {
        assert.strictEqual(out.exists, true);
      },
    },
    {
      name: 'exists on a missing path returns false rather than throwing',
      config: (sb) => ({ action: 'exists', path: path.join(sb.dir, 'nope.txt') }),
      assert(out) {
        assert.strictEqual(out.exists, false);
      },
    },
    {
      name: 'list globs matching files and counts them',
      async setup(sb) {
        sb.file('src/a.js', '');
        sb.file('src/b.js', '');
        sb.file('src/c.txt', '');
      },
      config: (sb) => ({ action: 'list', path: path.join(sb.dir, 'src'), pattern: '**/*.js', recursive: true, type: 'files' }),
      assert(out) {
        assert.ok(Array.isArray(out.files), 'files should be an array');
        assert.strictEqual(out.count, 2, `expected 2 .js files, got ${out.count}`);
      },
    },
    {
      name: 'globstar matches files at the root as well as nested ones',
      async setup(sb) {
        sb.file('root.js', '');
        sb.file('a/one.js', '');
        sb.file('a/b/two.js', '');
        sb.file('a/skip.txt', '');
      },
      config: (sb) => ({ action: 'list', path: sb.dir, pattern: '**/*.js', recursive: true, type: 'files' }),
      assert(out) {
        const names = out.files.map(f => f.replace(/\\/g, '/')).sort();
        assert.deepStrictEqual(names, ['a/b/two.js', 'a/one.js', 'root.js'].sort(),
          `globstar missed files: ${JSON.stringify(names)}`);
      },
    },
    {
      name: 'a non-recursive plain pattern stays in the top directory',
      async setup(sb) {
        sb.file('top.js', '');
        sb.file('sub/deep.js', '');
      },
      config: (sb) => ({ action: 'list', path: sb.dir, pattern: '*.js', recursive: false, type: 'files' }),
      assert(out) {
        assert.deepStrictEqual(out.files.map(String), ['top.js']);
      },
    },
    {
      name: 'copy duplicates a file and leaves the original',
      async setup(sb) { sb.file('orig.txt', 'dup me'); },
      config: (sb) => ({ action: 'copy', path: path.join(sb.dir, 'orig.txt'), destination: path.join(sb.dir, 'copy.txt') }),
      assert(out, sb) {
        assert.ok(sb.exists('orig.txt'), 'original disappeared');
        assert.strictEqual(sb.read('copy.txt'), 'dup me');
      },
    },
    {
      name: 'move renames and removes the source',
      async setup(sb) { sb.file('from.txt', 'moving'); },
      config: (sb) => ({ action: 'move', path: path.join(sb.dir, 'from.txt'), destination: path.join(sb.dir, 'to.txt') }),
      assert(out, sb) {
        assert.ok(!sb.exists('from.txt'), 'source still present after move');
        assert.strictEqual(sb.read('to.txt'), 'moving');
      },
    },
    {
      name: 'delete removes the file',
      async setup(sb) { sb.file('doomed.txt', 'x'); },
      config: (sb) => ({ action: 'delete', path: path.join(sb.dir, 'doomed.txt') }),
      assert(out, sb) {
        assert.ok(!sb.exists('doomed.txt'), 'file was not deleted');
      },
    },
    {
      name: 'read on a missing file rejects instead of returning empty content',
      config: (sb) => ({ action: 'read', path: path.join(sb.dir, 'ghost.txt') }),
      expectThrow: true,
      assert(err) {
        assert.ok(err instanceof Error, 'should reject with an Error');
      },
    },
  ],
};
