/** @jest-environment node */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { clone, scaffoldArgs, inStaging } = require('../../src/main/utils/projectCreation');
const { runCommand } = require('../../src/main/utils/runCommand');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-create-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
test('real Git clone preserves existing destinations and removes only its own failed staging directory', async () => {
  const source = path.join(dir, 'source'), target = path.join(dir, 'target');
  fs.mkdirSync(source); execFileSync('git', ['init', source], { stdio: 'ignore' });
  expect((await clone(source, target)).success).toBe(true);
  fs.writeFileSync(path.join(target, 'precious'), 'keep');
  await expect(clone(source, target)).rejects.toThrow(/already exists/);
  expect(fs.readFileSync(path.join(target, 'precious'), 'utf8')).toBe('keep');
  await expect(clone(path.join(dir, 'missing-repo'), path.join(dir, 'failed'))).rejects.toThrow();
  expect(fs.readdirSync(dir).sort()).toEqual(['source', 'target']);
});
test('cancel stops the process before staging cleanup and retry can publish to the same destination', async () => {
  const target = path.join(dir, 'result'); const controller = new AbortController();
  const pending = inStaging(target, controller.signal, async staged => {
    fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'partial'), 'partial');
    await runCommand(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { signal: controller.signal, onProgress: () => controller.abort() });
  });
  await expect(pending).rejects.toThrow();
  expect(fs.readdirSync(dir)).toEqual([]);
  await inStaging(target, null, async staged => { fs.mkdirSync(staged); fs.writeFileSync(path.join(staged, 'complete'), 'complete'); });
  expect(fs.readFileSync(path.join(target, 'complete'), 'utf8')).toBe('complete');
});
test('a destination created by someone else during generation is preserved', async () => {
  const target = path.join(dir, 'appeared');
  await expect(inStaging(target, null, async staged => { fs.mkdirSync(staged); fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'precious'), 'keep'); })).rejects.toThrow(/destination preserved/);
  expect(fs.readdirSync(dir)).toEqual(['appeared']); expect(fs.readFileSync(path.join(target, 'precious'), 'utf8')).toBe('keep');
});
test('only shipped templates and safe package names can select command arguments', () => {
  for (const template of ['react', 'vue', 'svelte', 'nextjs', 'nuxt', 'astro']) expect(scaffoldArgs(template, 'my-app')).toContain('my-app');
  for (const name of ['../escape', 'x&whoami', 'x%PATH%', 'x"', '-argument', 'a b', 'x$(echo)']) expect(() => scaffoldArgs('react', name)).toThrow();
  expect(() => scaffoldArgs('arbitrary-command', 'my-app')).toThrow();
});
