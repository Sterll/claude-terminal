/** @jest-environment node */
const http = require('http');
const { once } = require('events');
const api = require('../../src/project-types/api/main/ApiTester');
let server, origin;
beforeEach(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/large') { res.end('x'.repeat(128 * 1024)); return; }
    if (req.url === '/slow') {
      const timer = setInterval(() => res.write('x'), 10); res.on('close', () => clearInterval(timer)); return;
    }
    res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
test('preserves normal responses and rejects oversized bodies', async () => {
  expect(await api.sendRequest({ url: origin })).toMatchObject({ status: 200, body: '{"ok":true}' });
  expect(await api.sendRequest({ url: origin + '/large', maxBytes: 1024 })).toMatchObject({ status: 0, error: expect.stringMatching(/size limit/) });
});
test('total deadline interrupts a continuously streaming server', async () => {
  expect(await api.sendRequest({ url: origin + '/slow', timeoutMs: 100 })).toMatchObject({ status: 0, error: expect.stringMatching(/time limit/) });
});
test('explicit cancellation closes the request', async () => {
  const controller = new AbortController();
  const pending = api.sendRequest({ url: origin + '/slow', signal: controller.signal });
  controller.abort(); expect(await pending).toMatchObject({ status: 0, error: 'Request cancelled' });
});
