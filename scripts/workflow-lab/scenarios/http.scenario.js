'use strict';

const { assert } = require('../sandbox');

/**
 * The http node runs every URL through assertSafeUrl, which rejects loopback,
 * RFC-1918 and link-local addresses. That makes the request path untestable
 * against a sandbox server on 127.0.0.1 — and, more importantly, means the node
 * cannot reach a local dev server or anything on the LAN. That is a deliberate
 * SSRF control, so it is pinned here rather than worked around.
 */
module.exports = {
  type: 'http',
  scenarios: [
    {
      name: 'refuses loopback URLs',
      config: { method: 'GET', url: 'http://127.0.0.1:9/nope' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /loopback/i);
      },
    },
    {
      name: 'refuses localhost by name',
      config: { method: 'GET', url: 'http://localhost:3000/api' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /loopback/i);
      },
    },
    {
      name: 'refuses private LAN addresses',
      config: { method: 'GET', url: 'http://192.168.1.10/admin' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /private/i);
      },
    },
    {
      name: 'refuses the cloud metadata endpoint',
      config: { method: 'GET', url: 'http://169.254.169.254/latest/meta-data/' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /link-local/i);
      },
    },
    {
      name: 'refuses a non-http scheme',
      config: { method: 'GET', url: 'file:///etc/passwd' },
      expectThrow: true,
      assert(err) {
        assert.ok(err instanceof Error);
      },
    },
    {
      name: 'rejects an empty URL rather than requesting something arbitrary',
      config: { method: 'GET', url: '' },
      expectThrow: true,
      assert(err) {
        assert.ok(err instanceof Error);
      },
    },
    {
      name: 'interpolates variables into the URL before the safety check',
      async setup(sb) { sb.vars.set('host', '127.0.0.1'); },
      config: { method: 'GET', url: 'http://$host:8080/x' },
      expectThrow: true,
      assert(err) {
        // Proves the guard sees the resolved value, not the literal "$host".
        assert.match(err.message, /loopback|127\.0\.0\.1/i);
      },
    },
  ],
};
