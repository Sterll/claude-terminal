/**
 * The wire that makes an MCP project mutation show up in a running app.
 *
 * projects.json is the source of truth and the renderer polls it, so the app
 * was never *wrong* — it was stale for as long as the sweep took, and on the
 * paths that only reload state (no repaint) it stayed stale until a restart.
 * These tests pin the half that lives outside the renderer: the trigger file
 * every mutating project tool now drops for the main process to forward.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-proj-refresh-'));
const TRIGGER_DIR = path.join(DATA_DIR, 'projects', 'triggers');
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-proj-target-'));

let projects;

function writeProjects(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify(data), 'utf8');
}

function readTriggers() {
  if (!fs.existsSync(TRIGGER_DIR)) return [];
  return fs.readdirSync(TRIGGER_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(TRIGGER_DIR, f), 'utf8')));
}

function clearTriggers() {
  if (!fs.existsSync(TRIGGER_DIR)) return;
  for (const f of fs.readdirSync(TRIGGER_DIR)) fs.rmSync(path.join(TRIGGER_DIR, f), { force: true });
}

beforeAll(() => {
  process.env.CT_DATA_DIR = DATA_DIR;
  projects = require('../../resources/mcp-servers/tools/projects.js');
});

afterAll(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  writeProjects({
    projects: [{ id: 'p1', name: 'spacebot', path: 'E:\Perso\spacebot', type: 'general' }],
    folders: [],
    rootOrder: ['p1'],
  });
  clearTriggers();
});

const textOf = (r) => r.content[0].text;

test('project_create announces the new project', async () => {
  const res = await projects.handle('project_create', { path: PROJECT_DIR, name: 'brand-new' });
  expect(res.isError).toBeFalsy();

  const [trigger, ...rest] = readTriggers();
  expect(rest).toHaveLength(0);
  expect(trigger.action).toBe('changed');
  expect(trigger.mutation).toBe('create');
  expect(trigger.projectName).toBe('brand-new');
  expect(trigger.projectId).toMatch(/^proj-/);
});

test('project_update announces the edit', async () => {
  const res = await projects.handle('project_update', { project: 'spacebot', color: '#d97706' });
  expect(res.isError).toBeFalsy();

  const [trigger] = readTriggers();
  expect(trigger.mutation).toBe('update');
  expect(trigger.projectId).toBe('p1');
});

test('project_delete announces the removal', async () => {
  const res = await projects.handle('project_delete', { project: 'spacebot' });
  expect(res.isError).toBeFalsy();

  const [trigger] = readTriggers();
  expect(trigger.mutation).toBe('delete');
  expect(trigger.projectId).toBe('p1');
  expect(trigger.projectName).toBe('spacebot');
});

test('a refused mutation announces nothing', async () => {
  const res = await projects.handle('project_update', { project: 'does-not-exist', color: '#fff' });
  expect(res.isError).toBe(true);
  expect(readTriggers()).toHaveLength(0);
});

test('project_create on an already-registered path changes nothing and says nothing', async () => {
  await projects.handle('project_create', { path: PROJECT_DIR, name: 'first' });
  clearTriggers();

  const res = await projects.handle('project_create', { path: PROJECT_DIR, name: 'again' });
  expect(res.isError).toBe(true);
  expect(textOf(res)).toMatch(/already exists/i);
  expect(readTriggers()).toHaveLength(0);
});

test('two mutations in the same millisecond keep two distinct trigger files', async () => {
  await projects.handle('project_update', { project: 'spacebot', color: '#111111' });
  await projects.handle('project_update', { project: 'spacebot', name: 'spacebot-2' });

  // Same Date.now() is entirely possible here; the random suffix is what stops
  // the second write from overwriting the first and losing an event.
  expect(readTriggers()).toHaveLength(2);
});

describe('the main process forwards that directory', () => {
  const servicesIndex = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'main', 'services', 'index.js'), 'utf8');

  test('projects/triggers is one of the watched dirs', () => {
    expect(servicesIndex).toContain("path.join(dataDir, 'projects', 'triggers')");
  });

  test('both actions reach the renderer', () => {
    expect(servicesIndex).toContain("'mcp-project:changed'");
    expect(servicesIndex).toContain("'mcp-project:open'");
  });

  test('preload exposes the listeners, or nothing can subscribe', () => {
    const preload = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'main', 'preload.js'), 'utf8');
    expect(preload).toContain("onProjectsChanged: createListener('mcp-project:changed')");
    expect(preload).toContain("onProjectOpen: createListener('mcp-project:open')");
  });

  test('the renderer subscribes to both', () => {
    const rendererIndex = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'renderer', 'index.js'), 'utf8');
    expect(rendererIndex).toContain('onProjectsChanged');
    expect(rendererIndex).toContain('onProjectOpen');
  });
});
