const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { config } = require('../dist/config');
const { store } = require('../dist/store/store');
const { entityStore } = require('../dist/cloud/EntityStore');
const { projectManager } = require('../dist/cloud/ProjectManager');
let temporary;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-cloud-safety-'));
  config.dataDir = temporary;
  config.usersDir = path.join(temporary, 'users');
  config.cloudEnabled = true;
  await store.ensureDataDirs();
  await store.createUser('owner', 'test-key');
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

test('all project access rejects traversal, absolute paths and links', async () => {
  for (const name of ['..', '../outside', '/tmp/outside', 'a/b', 'a\\b', '%2e%2e', 'C:\\outside']) {
    assert.throws(() => store.getProjectPath('owner', name));
    await assert.rejects(store.deleteProjectDir('owner', name));
  }
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(config.usersDir, 'owner', 'projects', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.getProjectPath('owner', 'linked'), /Symbolic/);
  await assert.rejects(store.deleteProjectDir('owner', 'linked'));
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('a failed import cannot delete an existing project and always removes its own upload', async () => {
  const project = await store.createProjectDir('owner', 'existing');
  await fs.writeFile(path.join(project, 'keep.txt'), 'keep');
  const upload = path.join(temporary, 'broken.zip');
  await fs.writeFile(upload, 'not a zip');
  await assert.rejects(projectManager.createFromZip('owner', 'existing', upload), error => error.status === 409);
  assert.equal(await fs.readFile(path.join(project, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(fs.access(upload));
  await fs.writeFile(upload, 'not a zip');
  await assert.rejects(projectManager.createFromZip('owner', 'new-project', upload));
  assert.deepEqual(await store.listProjectDirs('owner'), ['existing']);
});

test('concurrent writes using the same base hash produce one conflict', async () => {
  const initial = await entityStore.putEntity('owner', 'settings', { value: 0 });
  const results = await Promise.all([
    entityStore.putEntity('owner', 'settings', { value: 1 }, initial.hash),
    entityStore.putEntity('owner', 'settings', { value: 2 }, initial.hash),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.conflict).length, 1);
});

test('user metadata mutations preserve concurrent independent changes', async () => {
  await Promise.all([
    store.updateUser('owner', user => { user.gitName = 'Example'; }),
    store.updateUser('owner', user => { user.projects.push({ name: 'p', createdAt: 1, lastActivity: null }); }),
  ]);
  const user = await store.getUser('owner');
  assert.equal(user.gitName, 'Example');
  assert.equal(user.projects.length, 1);
});

test('cloud execution is personal; multi-user relay/sync requires execution disabled', async () => {
  await assert.rejects(store.createUser('second', 'another-key'), /one user/);
  config.cloudEnabled = false;
  await store.createUser('second', 'another-key');
  await store.assertCloudIsolation();
  config.cloudEnabled = true;
  await assert.rejects(store.assertCloudIsolation(), /one user/);
});

async function makeZip(file, entries) {
  const archiver = require('archiver');
  const { createWriteStream } = require('node:fs');
  const archive = archiver('zip');
  const output = createWriteStream(file);
  const closed = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
  archive.pipe(output);
  for (const [name, content] of entries) archive.append(content, { name });
  await archive.finalize();
  await closed;
}

test('valid imports publish complete content; extraction limits only clean the temporary directory', async () => {
  const zip = path.join(temporary, 'project.zip');
  await makeZip(zip, [['src/main.js', 'hello'], ['README.md', 'project']]);
  const project = await projectManager.createFromZip('owner', 'valid', zip);
  assert.equal(await fs.readFile(path.join(project, 'src/main.js'), 'utf8'), 'hello');
  const limit = config.maxExpandedBytes;
  config.maxExpandedBytes = 2;
  try {
    await makeZip(zip, [['too-large.txt', 'oversized']]);
    await assert.rejects(projectManager.createFromZip('owner', 'oversized', zip), /limits/);
    assert.deepEqual(await store.listProjectDirs('owner'), ['valid']);
  } finally { config.maxExpandedBytes = limit; }
});

test('failed clones preserve existing projects and clean only their own temporary work', async t => {
  const childProcess = require('node:child_process');
  const original = childProcess.execFile;
  childProcess.execFile = (_command, _args, _options, callback) => callback(new Error('simulated clone failure'));
  t.after(() => { childProcess.execFile = original; });
  const existing = await store.createProjectDir('owner', 'existing');
  await fs.writeFile(path.join(existing, 'keep'), 'keep');
  await assert.rejects(projectManager.createFromClone('owner', 'existing', 'https://example.test/repo'), error => error.status === 409);
  await assert.rejects(projectManager.createFromClone('owner', 'new-project', 'https://example.test/repo'), /clone failure/);
  assert.deepEqual(await store.listProjectDirs('owner'), ['existing']);
  assert.equal(await fs.readFile(path.join(existing, 'keep'), 'utf8'), 'keep');
});


test('imports reject symbolic links before publishing', async () => {
  const archiver = require('archiver');
  const zip = path.join(temporary, 'linked.zip');
  const output = require('node:fs').createWriteStream(zip);
  const archive = archiver('zip');
  const closed = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); archive.on('error', reject); });
  archive.pipe(output);
  archive.symlink('escape', '../outside');
  await archive.finalize(); await closed;
  await assert.rejects(projectManager.createFromZip('owner', 'linked', zip), /links/);
  assert.deepEqual(await store.listProjectDirs('owner'), []);
});
