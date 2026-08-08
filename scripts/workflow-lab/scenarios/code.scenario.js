'use strict';

const { assert } = require('../sandbox');

module.exports = {
  type: 'code',
  scenarios: [
    {
      name: 'returns the value the snippet returns',
      config: { code: 'return 6 * 7;' },
      assert(out) {
        assert.strictEqual(out.result, 42);
      },
    },
    {
      name: 'reads workflow variables through the vars argument',
      async setup(sb) {
        sb.vars.set('branch', 'main');
        sb.vars.set('count', 3);
      },
      config: { code: 'return `${vars.branch}:${vars.count}`;' },
      assert(out) {
        assert.strictEqual(out.result, 'main:3');
      },
    },
    {
      name: 'joins two values into a sentence — the case that had no node',
      async setup(sb) {
        sb.vars.set('project', 'ClaudeTerminal');
        sb.vars.set('failures', 2);
      },
      config: { code: 'return `${vars.project}: ${vars.failures} test(s) failing`;' },
      assert(out) {
        assert.strictEqual(out.result, 'ClaudeTerminal: 2 test(s) failing');
      },
    },
    {
      name: 'receives a piped data input',
      config: { code: 'return input.map(x => x * 2);', input: [1, 2, 3] },
      assert(out) {
        assert.deepStrictEqual(out.result, [2, 4, 6]);
      },
    },
    {
      name: 'resolves a $variable typed into the input field',
      async setup(sb) { sb.vars.set('rows', [{ id: 1 }, { id: 2 }]); },
      config: { code: 'return input.length;', input: '$rows' },
      assert(out) {
        assert.strictEqual(out.result, 2);
      },
    },
    {
      name: 'runs multiple statements, not just one expression',
      config: { code: 'const a = 2;\nconst b = 3;\nif (a > b) return "a";\nreturn "b";' },
      assert(out) {
        assert.strictEqual(out.result, 'b');
      },
    },
    {
      name: 'stores the result in the configured output variable',
      config: { code: 'return { ok: true };', outputVar: 'summary' },
      assert(out, sb) {
        assert.deepStrictEqual(sb.vars.get('summary'), { ok: true });
      },
    },
    {
      name: 'can build an object the rest of the graph can read',
      async setup(sb) { sb.vars.set('n', 4); },
      config: { code: 'return { doubled: vars.n * 2, label: "n=" + vars.n };' },
      assert(out) {
        assert.deepStrictEqual(out.result, { doubled: 8, label: 'n=4' });
      },
    },
    {
      name: 'an empty snippet rejects instead of silently returning nothing',
      config: { code: '   ' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /no code/i);
      },
    },
    {
      name: 'a syntax error is reported, not swallowed',
      config: { code: 'return (((;' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /code/i);
      },
    },
    {
      name: 'a runtime error is reported with its message',
      config: { code: 'return nope.field;' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /nope/);
      },
    },
    {
      name: 'an infinite loop is cut off rather than hanging the run',
      config: { code: 'while (true) {}' },
      expectThrow: true,
      timeoutMs: 8000,
      assert(err) {
        assert.match(err.message, /timed out/i);
      },
    },
    {
      // The vm context is not a security boundary, but the documented
      // hardening must hold: the host realm stays unreachable.
      name: 'cannot reach require from inside the sandbox',
      config: { code: 'return typeof require;' },
      assert(out) {
        assert.strictEqual(out.result, 'undefined');
      },
    },
    {
      name: 'cannot reach process from inside the sandbox',
      config: { code: 'return typeof process;' },
      assert(out) {
        assert.strictEqual(out.result, 'undefined');
      },
    },
    {
      // `({}).constructor.constructor` still resolves — to the SANDBOX's
      // Function, not the host's. Code compiled through it therefore runs in
      // the sandbox realm and still cannot see the host. That re-rooting, not
      // the cleared globals, is what actually contains this node.
      name: 'code compiled at runtime is still confined to the sandbox realm',
      config: { code: 'try { return String(({}).constructor.constructor("return typeof process")()); } catch (e) { return "blocked"; }' },
      assert(out) {
        assert.ok(['undefined', 'blocked'].includes(out.result),
          `sandbox escape reached the host: got ${JSON.stringify(out.result)}`);
      },
    },
    {
      name: 'a runtime-compiled escape cannot read the host filesystem either',
      config: { code: 'try { return String(({}).constructor.constructor("return typeof require")()); } catch (e) { return "blocked"; }' },
      assert(out) {
        assert.ok(['undefined', 'blocked'].includes(out.result),
          `require reachable from the sandbox: got ${JSON.stringify(out.result)}`);
      },
    },
    {
      name: 'returned values are host objects, not sandbox-realm ones',
      config: { code: 'return [1, 2, 3];' },
      assert(out) {
        assert.ok(Array.isArray(out.result));
        assert.ok(out.result instanceof Array,
          'result kept a sandbox prototype — downstream instanceof checks would fail');
      },
    },
    {
      name: 'a non-serialisable variable is dropped rather than breaking the run',
      async setup(sb) {
        const circular = { name: 'loop' };
        circular.self = circular;
        sb.vars.set('circular', circular);
        sb.vars.set('fine', 'ok');
      },
      config: { code: 'return [typeof vars.circular, vars.fine];' },
      assert(out) {
        assert.deepStrictEqual(out.result, ['undefined', 'ok']);
      },
    },
  ],
};
