const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

test('pagination, atomic import counts, admin edits and hourly quota', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-hub-'));
  let mf;
  try {
    execFileSync(process.execPath, [path.resolve(__dirname, '../node_modules/wrangler/bin/wrangler.js'), 'deploy', '--dry-run', '--outdir', temporary], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(temporary, 'wrangler.log') }, stdio: 'pipe',
    });
    mf = new Miniflare(convertV4MiniflareOptions({ modules: true, modulesRoot: temporary, scriptPath: path.join(temporary, 'index.js'), compatibilityDate: '2026-09-15',
      kvNamespaces: ['WORKFLOWS_HUB'], durableObjects: { HUB_COUNTERS: { className: 'HubCounter', useSQLite: true } }, bindings: { ADMIN_SECRET: 'local-fixture-only' } }));
    const kv = await mf.getKVNamespace('WORKFLOWS_HUB');
    // More than one configured KV page, including a legacy import count.
    for (let i = 0; i < 105; i++) await kv.put('wf:' + i, JSON.stringify({ id: String(i), name: 'w' + i, description: 'test', tags: [], imports: 7 }));
    const listing = await (await mf.dispatchFetch('http://example.test/workflows')).json();
    assert.equal(listing.total, 105);
    const responses = await Promise.all(Array.from({ length: 20 }, () => mf.dispatchFetch('http://example.test/workflows/0/import', { method: 'POST' })));
    assert(responses.every(response => response.status === 200));
    const counts = await Promise.all(responses.map(response => response.json()));
    assert.equal(new Set(counts.map(result => result.imports)).size, 20);
    await mf.dispatchFetch('http://example.test/workflows/0', { method: 'PUT', headers: { 'X-Admin-Secret': 'local-fixture-only' }, body: JSON.stringify({ description: 'updated', imports: 0 }) });
    const workflow = await (await mf.dispatchFetch('http://example.test/workflows/0')).json();
    assert.equal(workflow.imports, 27); assert.equal(workflow.description, 'updated');
    const submissions = await Promise.all(Array.from({ length: 12 }, () => mf.dispatchFetch('http://example.test/workflows', {
      method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify({ name: 'new', description: 'test' }),
    })));
    assert.equal(submissions.filter(response => response.status === 201).length, 5);
    assert.equal(submissions.filter(response => response.status === 429).length, 7);
  } finally { if (mf) await mf.dispose(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
