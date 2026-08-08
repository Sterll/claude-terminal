'use strict';

const { assert } = require('../sandbox');

/**
 * The notify node has two halves:
 *   - the desktop channel, which is pure IPC (ctx.sendFn) and fully observable;
 *   - the discord/slack/other channels, which POST to a webhook.
 *
 * Every webhook URL goes through assertSafeUrl, so the outbound half is pinned
 * the same way http.scenario.js does it — with addresses the guard must refuse.
 * Nothing here can reach the network: a blocked URL returns before fetch() is
 * ever called, and an unresolved `$var` URL is skipped before that.
 *
 * The parsing of `channels` is the interesting surface: it accepts a newline or
 * comma separated string, `type=url` pairs, and a legacy array form.
 */

/** Every desktop payload the node emitted, in order. */
function desktopPayloads(sb) {
  return sb.sent.filter(s => s.channel === 'workflow-notify-desktop').map(s => s.payload);
}

module.exports = {
  type: 'notify',
  scenarios: [
    {
      name: 'emits one desktop notification carrying the title and message',
      config: { title: 'Build', message: 'All green', channels: 'desktop' },
      assert(out, sb) {
        assert.deepStrictEqual(sb.sentOn('workflow-notify-desktop'), { title: 'Build', message: 'All green' });
        assert.deepStrictEqual(out, { sent: true, message: 'All green' });
      },
    },
    {
      name: 'defaults to the desktop channel when channels is blank',
      config: { title: 'T', message: 'M', channels: '' },
      assert(out, sb) {
        assert.strictEqual(desktopPayloads(sb).length, 1);
      },
    },
    {
      name: 'defaults the title to "Workflow" when none is configured',
      config: { message: 'done' },
      assert(out, sb) {
        assert.strictEqual(sb.sentOn('workflow-notify-desktop').title, 'Workflow');
      },
    },
    {
      name: 'interpolates $variables into the title and the message',
      async setup(sb) { sb.vars.set('branch', 'main'); },
      config: { title: 'Build $branch', message: '$ctx.project built on $branch' },
      assert(out, sb) {
        const p = sb.sentOn('workflow-notify-desktop');
        assert.strictEqual(p.title, 'Build main');
        assert.strictEqual(p.message, `${sb.dir} built on main`);
        assert.strictEqual(out.message, p.message);
      },
    },
    {
      name: 'blanks a $variable that resolves to nothing rather than printing the literal',
      async setup(sb) { sb.vars.set('empty', ''); },
      config: { message: 'result: [$empty]' },
      assert(out, sb) {
        assert.strictEqual(sb.sentOn('workflow-notify-desktop').message, 'result: []');
      },
    },
    {
      name: 'parses a newline channel list and matches channel names case-insensitively',
      config: { message: 'hi', channels: 'DESKTOP\n' },
      assert(out, sb) {
        assert.strictEqual(desktopPayloads(sb).length, 1);
      },
    },
    {
      name: 'accepts a comma separated channel list',
      config: { message: 'hi', channels: 'desktop, desktop' },
      assert(out, sb) {
        assert.strictEqual(desktopPayloads(sb).length, 2);
      },
    },
    {
      name: 'accepts the legacy array channel form',
      config: { message: 'hi', channels: ['desktop'] },
      assert(out, sb) {
        assert.strictEqual(desktopPayloads(sb).length, 1);
      },
    },
    {
      name: 'a blocked webhook URL does not abort the desktop notification',
      // 127.0.0.1 is refused by assertSafeUrl, so no request leaves the process;
      // the node logs a warning and still resolves.
      config: { message: 'ship it', channels: 'desktop\ndiscord=http://127.0.0.1:1/hook' },
      assert(out, sb) {
        assert.strictEqual(out.sent, true);
        assert.strictEqual(desktopPayloads(sb).length, 1);
        assert.strictEqual(sb.sent.length, 1, 'the blocked channel must not emit anything');
      },
    },
    {
      name: 'a LAN webhook URL is refused too — notify cannot reach a local dev server',
      config: { message: 'hi', channels: 'slack=http://192.168.1.20/services/x' },
      assert(out, sb) {
        assert.strictEqual(out.sent, true);
        assert.strictEqual(sb.sent.length, 0);
      },
    },
    {
      name: 'the legacy array form is guarded as well',
      config: { message: 'hi', channels: [{ discord: 'http://10.1.2.3/hook' }] },
      assert(out, sb) {
        assert.strictEqual(out.sent, true);
        assert.strictEqual(sb.sent.length, 0);
      },
    },
    {
      name: 'skips a channel whose URL is still an unresolved $variable',
      config: { message: 'hi', channels: 'discord=$hookUrl' },
      assert(out, sb) {
        // Proves no request is attempted with a literal "$hookUrl" host.
        assert.strictEqual(out.sent, true);
        assert.strictEqual(sb.sent.length, 0);
      },
    },
    {
      name: 'ignores a channel declared with an empty URL',
      config: { message: 'hi', channels: 'desktop\ndiscord=' },
      assert(out, sb) {
        assert.strictEqual(desktopPayloads(sb).length, 1);
        assert.strictEqual(sb.sent.length, 1);
      },
    },
    {
      name: 'an empty message is still delivered rather than dropped',
      config: { title: 'Heads up', message: '' },
      assert(out, sb) {
        assert.deepStrictEqual(sb.sentOn('workflow-notify-desktop'), { title: 'Heads up', message: '' });
        assert.strictEqual(out.message, '');
      },
    },
  ],
};
