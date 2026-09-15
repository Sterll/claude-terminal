/** @jest-environment node */
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { bundleHandler } = require('../../src/main/utils/syncBundles');
let temporary;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-bundles-')); });
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
const make = (root, kind) => {
  let previous = [];
  const handler = bundleHandler({ root, kind, previous: () => previous, atomicWrite: async (file, content) => {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  } });
  handler.remember = data => { previous = handler.syncMeta(data).bundleEntries; };
  return handler;
};
test.each(['skills', 'agents'])('round-trips %s resources and propagates file/item deletions across two machines', async kind => {
  const a = make(path.join(temporary, 'a'), kind), b = make(path.join(temporary, 'b'), kind);
  const main = kind === 'skills' ? 'SKILL.md' : 'AGENT.md';
  await fs.mkdir(path.join(a.path, 'review', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(a.path, 'review', main), 'definition');
  await fs.writeFile(path.join(a.path, 'review', 'scripts', 'run.sh'), '#!/bin/sh\necho ok', { mode: 0o700 });
  await fs.writeFile(path.join(a.path, 'review', 'asset.bin'), Buffer.from([0, 128, 255]));
  const initial = await a.read(); a.remember(initial); await b.write(initial); b.remember(initial);
  expect(await b.read()).toEqual(initial);
  await fs.unlink(path.join(a.path, 'review', 'asset.bin'));
  const changed = await a.read(); a.remember(changed); await b.write(changed); b.remember(changed);
  await expect(fs.access(path.join(b.path, 'review', 'asset.bin'))).rejects.toThrow();
  expect(await b.read()).toEqual(changed);
  await fs.rm(path.join(a.path, 'review'), { recursive: true });
  const deleted = await a.read(); expect(deleted[0].deleted).toBe(true);
  await b.write(deleted); b.remember(deleted); expect(await b.read()).toEqual(deleted);
});
test('flat markdown agents and invalid paths', async () => {
  const handler = make(temporary, 'agents');
  await handler.write([{ name: 'reviewer.md', format: 'file', content: 'review' }]);
  expect((await handler.read())[0]).toMatchObject({ name: 'reviewer.md', format: 'file', content: 'review' });
  await expect(handler.write([{ name: '../escape', content: 'bad' }])).rejects.toThrow(/path/);
  await expect(handler.write([{ name: 'review', files: { '../escape': { content: 'YQ==' } } }])).rejects.toThrow(/path/);
  await fs.symlink(temporary, path.join(temporary, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(handler.write([{ name: 'linked', content: 'bad' }])).rejects.toThrow(/links/);
});
