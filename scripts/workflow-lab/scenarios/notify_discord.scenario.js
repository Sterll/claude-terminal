'use strict';

const { assert } = require('../sandbox');

/**
 * notify_discord has no assertSafeUrl call: it relies entirely on a hardcoded
 * allowlist regex — `^https://(discord|discordapp)\.com/api/webhooks/`. That
 * regex IS the security control, so it is what these scenarios pin.
 *
 * The accepted path cannot be exercised without POSTing to Discord for real, so
 * the two "accepted" scenarios stop at the very next guard instead: an empty
 * payload throws before fetch() is reached. That proves the host was allowed
 * without a single packet leaving the process.
 */

const OK_URL = 'https://discord.com/api/webhooks/123456789/abcdefTOKEN';

module.exports = {
  type: 'notify_discord',
  scenarios: [
    {
      name: 'requires a webhook URL',
      config: { webhookUrl: '', content: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /webhook URL is required/i);
      },
    },
    {
      name: 'refuses a webhook on a host that is not Discord',
      config: { webhookUrl: 'https://evil.example/api/webhooks/1/token', content: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Invalid Discord webhook URL/i);
      },
    },
    {
      name: 'refuses a lookalike domain that merely starts with discord.com',
      config: { webhookUrl: 'https://discord.com.evil.example/api/webhooks/1/token', content: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Invalid Discord webhook URL/i);
      },
    },
    {
      name: 'refuses a subdomain of discord.com',
      config: { webhookUrl: 'https://cdn.discord.com/api/webhooks/1/token', content: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Invalid Discord webhook URL/i);
      },
    },
    {
      name: 'refuses plain http even on the real Discord host',
      config: { webhookUrl: 'http://discord.com/api/webhooks/1/token', content: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Invalid Discord webhook URL/i);
      },
    },
    {
      name: 'refuses a Discord URL outside the /api/webhooks/ path',
      config: { webhookUrl: 'https://discord.com/api/channels/1/messages', content: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Invalid Discord webhook URL/i);
      },
    },
    {
      name: 'resolves $variables in the URL before applying the allowlist',
      async setup(sb) { sb.vars.set('hook', 'https://evil.example/api/webhooks/1/token'); },
      config: { webhookUrl: '$hook', content: 'hi' },
      expectThrow: true,
      assert(err) {
        // The guard must see the resolved value, not the literal "$hook".
        assert.match(err.message, /Invalid Discord webhook URL/i);
      },
    },
    {
      name: 'refuses a URL whose $variable never resolved',
      config: { webhookUrl: '$hookUrl', content: 'hi' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Invalid Discord webhook URL/i);
      },
    },
    {
      name: 'accepts discord.com — and then refuses to POST an empty payload',
      config: { webhookUrl: OK_URL, content: '', title: '', description: '' },
      expectThrow: true,
      assert(err) {
        // Reaching the payload check proves the allowlist accepted the host.
        assert.match(err.message, /requires content or embed/i);
      },
    },
    {
      name: 'accepts the legacy discordapp.com host',
      config: { webhookUrl: 'https://discordapp.com/api/webhooks/1/token', content: '' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /requires content or embed/i);
      },
    },
    {
      name: 'trims surrounding whitespace before checking the URL',
      config: { webhookUrl: `   ${OK_URL}   `, content: '' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /requires content or embed/i);
      },
    },
    {
      name: 'a username alone is not a payload — Discord would reject it',
      config: { webhookUrl: OK_URL, username: 'Claude Terminal' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /requires content or embed/i);
      },
    },
    {
      name: 'a message whose $variables all resolve to empty is treated as no payload',
      async setup(sb) { sb.vars.set('body', ''); },
      config: { webhookUrl: OK_URL, content: '$body' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /requires content or embed/i);
      },
    },
  ],
};
