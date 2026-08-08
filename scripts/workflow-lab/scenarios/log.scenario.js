'use strict';

const { assert } = require('../sandbox');

/**
 * log is the workflow's only observation point: every other scenario file in
 * this lab uses it to prove which branch ran. So what matters here is that the
 * message it reports is the resolved one, and that it reaches the UI channel.
 */
module.exports = {
  type: 'log',
  scenarios: [
    {
      name: 'the message reaches the UI, not just the return value',
      config: { level: 'warn', message: 'disk almost full' },
      assert(out, sb) {
        assert.strictEqual(out.logged, true);
        const emitted = sb.sentOn('workflow-log');
        assert.ok(emitted, 'nothing was emitted on the workflow-log channel');
        assert.strictEqual(emitted.message, 'disk almost full');
        assert.strictEqual(emitted.level, 'warn');
      },
    },
    {
      name: 'variables are interpolated before the message is emitted',
      async setup(sb) { sb.vars.set('buildId', 42); },
      config: { level: 'info', message: 'build $buildId finished' },
      assert(out, sb) {
        assert.strictEqual(out.message, 'build 42 finished');
        assert.strictEqual(sb.sentOn('workflow-log').message, 'build 42 finished');
      },
    },
    {
      name: 'a dotted path reads into an object variable',
      async setup(sb) { sb.vars.set('repo', { branch: 'main', sha: 'abc123' }); },
      config: { message: 'on $repo.branch at $repo.sha' },
      assert(out) {
        assert.strictEqual(out.message, 'on main at abc123');
      },
    },
    {
      name: 'an interpolated value loses its trailing newline',
      // Values come from shell stdout, which nearly always ends in a newline.
      // Pasting that raw would break every single-line log message.
      async setup(sb) { sb.vars.set('out', 'ok\n'); },
      config: { message: 'result: $out|' },
      assert(out) {
        assert.strictEqual(out.message, 'result: ok|');
      },
    },
    {
      name: 'an unknown variable is left literal instead of blanking the message',
      config: { message: 'value is $nothingHere' },
      assert(out) {
        assert.strictEqual(out.message, 'value is $nothingHere');
      },
    },
    {
      name: 'level defaults to info when unset',
      config: { message: 'plain' },
      assert(out, sb) {
        assert.strictEqual(out.level, 'info');
        assert.strictEqual(sb.sentOn('workflow-log').level, 'info');
      },
    },
    {
      name: 'an empty message still logs, it does not fail the step',
      config: { level: 'debug' },
      assert(out, sb) {
        assert.strictEqual(out.logged, true);
        assert.strictEqual(out.message, '');
        assert.ok(sb.sentOn('workflow-log'), 'an empty message was swallowed entirely');
      },
    },
    {
      name: 'the emitted event carries a timestamp so the log can be ordered',
      config: { message: 'ordered' },
      assert(out, sb) {
        const emitted = sb.sentOn('workflow-log');
        assert.strictEqual(typeof emitted.timestamp, 'number');
        assert.ok(emitted.timestamp > 0, `bogus timestamp: ${emitted.timestamp}`);
      },
    },
  ],
};
