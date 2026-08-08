'use strict';

const { assert } = require('../sandbox');

/**
 * Like `http`, the webhook node runs its URL through assertSafeUrl, so the
 * request path cannot be exercised against sb.http() on 127.0.0.1 — and the
 * node genuinely cannot post to a Slack-compatible receiver on the LAN. These
 * scenarios pin the guard rather than defeating it; none of them reaches the
 * network (every rejection happens before lib.request()).
 *
 * The last scenario asserts something the node does NOT currently do — see the
 * comment there.
 */
module.exports = {
  type: 'webhook',
  scenarios: [
    {
      name: 'refuses to run with no URL at all',
      config: { url: '', text: 'hello' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Missing webhook URL/i);
      },
    },
    {
      name: 'refuses loopback by IP',
      config: { url: 'http://127.0.0.1:9/hook', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /loopback/i);
      },
    },
    {
      name: 'refuses loopback by name',
      config: { url: 'http://localhost:3000/hook', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /loopback/i);
      },
    },
    {
      name: 'refuses IPv6 loopback',
      config: { url: 'http://[::1]:8080/hook', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /loopback/i);
      },
    },
    {
      name: 'refuses an RFC-1918 /8 address',
      config: { url: 'http://10.0.0.5/services/T000/B000/xxx', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /private/i);
      },
    },
    {
      name: 'refuses an RFC-1918 /12 address',
      config: { url: 'http://172.20.5.5/hook', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /private/i);
      },
    },
    {
      name: 'refuses a home-router /16 address',
      config: { url: 'https://192.168.0.1/hook', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /private/i);
      },
    },
    {
      name: 'refuses the cloud metadata endpoint',
      config: { url: 'http://169.254.169.254/latest/meta-data/iam/', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /link-local/i);
      },
    },
    {
      name: 'refuses a non-http scheme',
      config: { url: 'file:///etc/passwd', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /protocol/i);
      },
    },
    {
      name: 'refuses a malformed URL instead of posting somewhere arbitrary',
      config: { url: 'hooks.slack.com/services/x', text: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Invalid URL/i);
      },
    },
    {
      name: 'interpolates $variables into the URL before the safety check',
      async setup(sb) { sb.vars.set('slackHook', 'http://127.0.0.1:9/services/x'); },
      config: { url: '$slackHook', text: 'build done' },
      expectThrow: true,
      assert(err) {
        // The `text`, `username` and `icon` fields are all interpolated, and the
        // placeholder for `text` in the UI is literally "$ctx.project build
        // completed", so a user reasonably expects `$slackHook` to work in the
        // URL field too — that is how the http node behaves.
        // If this fails with `Invalid URL: $slackHook`, the URL field is the one
        // field the node forgets to resolve.
        assert.match(err.message, /loopback|127\.0\.0\.1/i);
      },
    },
  ],
};
