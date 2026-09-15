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

test('streams a large response to disk with a bounded preview and cleans cancelled staging files', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-http-disk-'));
  const file = path.join(dir, 'response.bin');
  server.removeAllListeners('request');
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x61);
  server.on('request', (_req, res) => { res.writeHead(418, { 'Content-Length': bytes.length }); res.end(bytes); });
  try {
    const result = await api.sendRequest({ url: origin, saveToPath: file });
    expect(result).toMatchObject({ status: 418, size: bytes.length, savedPath: file, previewTruncated: true });
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(64 * 1024);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    fs.writeFileSync(file, 'previous');
    const controller = new AbortController();
    const cancelled = await api.sendRequest({ url: origin, saveToPath: file, signal: controller.signal, onProgress: () => controller.abort() });
    expect(cancelled.cancelled).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
    expect(fs.readdirSync(dir)).toEqual(['response.bin']);
    expect((await api.sendRequest({ url: origin, saveToPath: path.join(dir, 'missing', 'response') })).error).toBeTruthy();
    expect(fs.readdirSync(dir)).toEqual(['response.bin']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
