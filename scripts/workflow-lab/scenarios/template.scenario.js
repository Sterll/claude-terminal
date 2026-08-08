'use strict';

const { assert } = require('../sandbox');

/**
 * template node — the string builder.
 *
 * There is no I/O here, so the whole surface is interpolation: what the node
 * does with a resolved value that is not a string, and what it does with a
 * reference that resolves to nothing. Both have edges that are easy to get
 * wrong silently (an "[object Object]" in a commit message, a literal "$branch"
 * in a Discord notification), so they are pinned rather than assumed.
 *
 * Two of these scenarios pin behaviour inherited from resolveVars that is
 * genuinely asymmetric — a lone unresolved $ref survives, the same $ref inside
 * a sentence collapses to empty. That asymmetry is engine-wide; this node must
 * not quietly disagree with the rest of the workflow, so it is documented here
 * instead of being smoothed over in the node.
 */

module.exports = {
  type: 'template',
  scenarios: [
    {
      name: 'passes literal text through untouched',
      config: { template: 'release notes' },
      assert(out) {
        assert.deepStrictEqual(out, { text: 'release notes' });
      },
    },
    {
      name: 'interpolates a single $variable into a sentence',
      async setup(sb) { sb.vars.set('branch', 'main'); },
      config: { template: 'Deployed $branch to production' },
      assert(out) {
        assert.strictEqual(out.text, 'Deployed main to production');
      },
    },
    {
      name: 'joins two values into one string — the reason this node exists',
      async setup(sb) {
        sb.vars.set('branch', 'release/1.2');
        sb.vars.set('count', 7);
      },
      config: { template: '$branch: $count files changed' },
      assert(out) {
        assert.strictEqual(out.text, 'release/1.2: 7 files changed');
      },
    },
    {
      name: 'resolves a nested reference such as $ctx.project',
      config: { template: 'working in $ctx.project' },
      assert(out, sb) {
        assert.strictEqual(out.text, `working in ${sb.dir}`);
      },
    },
    {
      name: 'renders a numeric variable as its decimal form, not as "[object Object]"',
      async setup(sb) { sb.vars.set('exitCode', 0); },
      config: { template: 'exit=$exitCode' },
      assert(out) {
        assert.strictEqual(out.text, 'exit=0');
      },
    },
    {
      name: 'a template that is exactly one $ref to an array yields JSON, never [object Object]',
      async setup(sb) { sb.vars.set('files', ['a.js', 'b.js']); },
      config: { template: '$files' },
      assert(out) {
        assert.strictEqual(out.text, '["a.js","b.js"]');
      },
    },
    {
      name: 'a lone $ref to an object yields JSON too',
      async setup(sb) { sb.vars.set('meta', { ok: true, n: 2 }); },
      config: { template: '$meta' },
      assert(out) {
        assert.strictEqual(out.text, '{"ok":true,"n":2}');
      },
    },
    {
      name: 'an object referenced inside a sentence contributes nothing rather than a JSON dump',
      async setup(sb) { sb.vars.set('meta', { ok: true }); },
      config: { template: 'meta=[$meta]' },
      assert(out) {
        // resolveVars refuses to splice a parent object into a larger string.
        assert.strictEqual(out.text, 'meta=[]');
      },
    },
    {
      name: 'a variable that resolves to empty renders as empty, not as the literal $ref',
      async setup(sb) { sb.vars.set('note', ''); },
      config: { template: 'note:[$note]' },
      assert(out) {
        assert.strictEqual(out.text, 'note:[]');
      },
    },
    {
      name: 'an UNKNOWN $ref inside a sentence collapses to empty — a typo loses text silently',
      config: { template: 'branch=[$nosuchvar]' },
      assert(out) {
        assert.strictEqual(out.text, 'branch=[]',
          'engine-wide resolveVars behaviour; the template node must not diverge from it');
      },
    },
    {
      name: 'an UNKNOWN $ref alone survives as a literal — the opposite of the case above',
      config: { template: '$nosuchvar' },
      assert(out) {
        assert.strictEqual(out.text, '$nosuchvar',
          'asymmetric by design in resolveVars: a lone unresolved ref is kept so it is visible');
      },
    },
    {
      name: 'multi-line templates keep their line breaks',
      async setup(sb) { sb.vars.set('who', 'ci'); },
      config: { template: 'line one\nby $who' },
      assert(out) {
        assert.strictEqual(out.text, 'line one\nby ci');
      },
    },
    {
      name: 'rejects a missing template instead of emitting an empty string downstream',
      config: {},
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /no template configured/);
      },
    },
    {
      name: 'rejects a whitespace-only template',
      config: { template: '   \n  ' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /no template configured/);
      },
    },
    {
      name: 'rejects a non-string template (a mis-wired data pin)',
      config: { template: 42 },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /no template configured/);
      },
    },
  ],
};
