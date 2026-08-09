/**
 * MCP automation tools.
 *
 * These write definitions.json from OUTSIDE the Electron main process, so the
 * things worth guarding are: the payload has to be exactly what compileTask()
 * produces (anything else is invisible to the Automations tab), the validation
 * has to refuse what the UI refuses, and the graph tools must not be allowed to
 * edit a generated graph.
 *
 * CT_DATA_DIR is set before the requires on purpose: _projectsCache and
 * _workflowStore resolve it at module load.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-automation-test-'));
process.env.CT_DATA_DIR = DATA_DIR;

const automation = require('../../resources/mcp-servers/tools/automation');
const workflowTools = require('../../resources/mcp-servers/tools/workflow');
const store = require('../../resources/mcp-servers/tools/_workflowStore');
const projectsCache = require('../../resources/mcp-servers/tools/_projectsCache');
const { isSimpleTask, normalizeSimple } = require('../../src/shared/simple-task');

const DEFS = path.join(DATA_DIR, 'workflows', 'definitions.json');

const call = (name, args) => automation.handle(name, args);
const textOf = res => res.content[0].text;

function writeDefs(defs) {
  fs.mkdirSync(path.dirname(DEFS), { recursive: true });
  fs.writeFileSync(DEFS, JSON.stringify(defs, null, 2), 'utf8');
}

function readDefs() {
  return JSON.parse(fs.readFileSync(DEFS, 'utf8'));
}

beforeAll(() => {
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify({
    projects: [
      { id: 'proj-a', name: 'Alpha', path: '/tmp/alpha' },
      { id: 'proj-b', name: 'Beta', path: '/tmp/beta' },
    ],
    folders: [], rootOrder: [],
  }));
});

beforeEach(() => {
  writeDefs([]);
  projectsCache.invalidate();
});

afterAll(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const create = (over = {}) => call('automation_create', {
  name: 'Test', prompt: 'Do the thing.', when: 'daily', time: '09:00', project: 'Alpha', ...over,
});

// ── What lands on disk ──

describe('automation_create → definitions.json', () => {
  test('writes a payload the app recognises as an automation', async () => {
    const res = await create();
    expect(res.isError).toBeFalsy();

    const [wf] = readDefs();
    expect(isSimpleTask(wf)).toBe(true);
    expect(wf.mode).toBe('simple');
    expect(wf.name).toBe('Test');
    expect(wf.enabled).toBe(true);
    expect(wf.simple.prompt).toBe('Do the thing.');
    expect(wf.simple.projectId).toBe('proj-a');
  });

  test('compiles the trigger the scheduler reads, not just the payload', async () => {
    await create({ when: 'weekly', weekday: 5, time: '17:30' });
    expect(readDefs()[0].trigger).toEqual({ type: 'cron', value: '30 17 * * 5' });
  });

  test('generates the trigger → claude → notify graph', async () => {
    await create();
    const types = readDefs()[0].graph.nodes.map(n => n.type);
    expect(types).toEqual(['workflow/trigger', 'workflow/claude', 'workflow/notify']);
  });

  test('drops the notify node when every channel is off', async () => {
    await create({ notify_desktop: false });
    const types = readDefs()[0].graph.nodes.map(n => n.type);
    expect(types).toEqual(['workflow/trigger', 'workflow/claude']);
  });

  test('resolves a project by name, id or path', async () => {
    for (const [value, expected] of [['Beta', 'proj-b'], ['proj-b', 'proj-b'], ['/tmp/beta', 'proj-b']]) {
      writeDefs([]);
      await create({ project: value });
      expect(readDefs()[0].simple.projectId).toBe(expected);
    }
  });

  test('signals the main process so the change is live without a restart', async () => {
    await create();
    const signals = fs.readdirSync(path.join(DATA_DIR, 'workflows', 'triggers'));
    expect(signals.some(f => f.startsWith('reload_'))).toBe(true);
  });

  test('keeps other definitions intact', async () => {
    writeDefs([{ id: 'wf_other', name: 'Other', enabled: true, trigger: { type: 'manual', value: '' } }]);
    await create();
    expect(readDefs().map(d => d.name).sort()).toEqual(['Other', 'Test']);
  });
});

// ── Refusals: the UI's rules, enforced here too ──

describe('automation_create validation', () => {
  const rejects = async (over, fragment) => {
    const res = await create(over);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(fragment);
    expect(readDefs()).toHaveLength(0);
  };

  test('requires a prompt', () => rejects({ prompt: undefined }, 'prompt'));
  test('requires a known when kind', () => rejects({ when: 'whenever' }, 'Unknown when'));
  test('requires a date for once', () => rejects({ when: 'once' }, 'YYYY-MM-DDTHH:MM'));
  test('requires a valid cron for custom', () => rejects({ when: 'custom', cron: 'nope' }, 'incomplete or invalid'));
  test('rejects an unknown project by name', () => rejects({ project: 'Nope' }, 'not found'));

  test('requires a project for per-repository events', () =>
    rejects({ when: 'git', project: undefined }, 'specific project'));

  test('rejects watch_project="any" for per-repository events, and says why', () =>
    rejects({ when: 'git', watch_project: 'any' }, 'cannot work'));

  test('allows watch_project="any" for events that are not per-repository', async () => {
    const res = await create({ when: 'chat_reply', watch_project: 'any' });
    expect(res.isError).toBeFalsy();
    expect(readDefs()[0].trigger.projectId).toBe('');
  });

  test('caps a monthly day at 28 rather than skipping short months', async () => {
    await create({ when: 'monthly', day: 31, time: '08:00' });
    expect(readDefs()[0].trigger.value).toBe('0 8 28 * *');
  });
});

// ── Partial updates ──

describe('automation_update', () => {
  test('changing the prompt leaves the schedule alone', async () => {
    await create({ when: 'weekly', weekday: 5, time: '17:30' });
    const res = await call('automation_update', { automation: 'Test', prompt: 'Something else.' });
    expect(res.isError).toBeFalsy();

    const wf = readDefs()[0];
    expect(wf.simple.prompt).toBe('Something else.');
    expect(wf.trigger).toEqual({ type: 'cron', value: '30 17 * * 5' });
  });

  test('changing the schedule leaves the prompt alone', async () => {
    await create();
    await call('automation_update', { automation: 'Test', when: 'hourly' });

    const wf = readDefs()[0];
    expect(wf.simple.prompt).toBe('Do the thing.');
    expect(wf.trigger.value).toBe('0 * * * *');
  });

  test('switches a clock automation to an event and rebuilds the trigger', async () => {
    await create();
    await call('automation_update', { automation: 'Test', when: 'session_end', status: 'error' });

    expect(readDefs()[0].trigger).toEqual({
      type: 'claude_session_end', value: '', projectId: 'proj-a', statusFilter: 'error',
    });
  });

  test('adds a chat_reply text filter', async () => {
    await create({ when: 'chat_reply' });
    await call('automation_update', { automation: 'Test', pattern: 'ready', match_mode: 'regex' });

    const { trigger } = readDefs()[0];
    expect(trigger.pattern).toBe('ready');
    expect(trigger.matchMode).toBe('regex');
    expect(trigger.role).toBe('assistant');
  });

  test('keeps the same id, so run history stays attached', async () => {
    await create();
    const id = readDefs()[0].id;
    await call('automation_update', { automation: 'Test', name: 'Renamed' });

    const wf = readDefs()[0];
    expect(wf.id).toBe(id);
    expect(wf.name).toBe('Renamed');
    expect(readDefs()).toHaveLength(1);
  });

  test('reports a missing automation instead of creating one', async () => {
    const res = await call('automation_update', { automation: 'Ghost', prompt: 'x' });
    expect(res.isError).toBe(true);
    expect(readDefs()).toHaveLength(0);
  });
});

// ── Enable / delete ──

describe('automation_enable and automation_delete', () => {
  test('pausing flips enabled without touching the payload', async () => {
    await create();
    const before = normalizeSimple(readDefs()[0].simple);

    await call('automation_enable', { automation: 'Test', enabled: false });
    const wf = readDefs()[0];
    expect(wf.enabled).toBe(false);
    expect(normalizeSimple(wf.simple)).toEqual(before);
  });

  test('delete removes only its own entry and asks for history cleanup', async () => {
    writeDefs([{ id: 'wf_other', name: 'Other', enabled: true, trigger: { type: 'manual', value: '' } }]);
    await create();

    const res = await call('automation_delete', { automation: 'Test' });
    expect(res.isError).toBeFalsy();
    expect(readDefs().map(d => d.name)).toEqual(['Other']);

    const signals = fs.readdirSync(path.join(DATA_DIR, 'workflows', 'triggers'));
    expect(signals.some(f => f.startsWith('deleted_'))).toBe(true);
  });
});

// ── The two layers stay separate ──

describe('automations vs graph workflows', () => {
  const GRAPH_WF = {
    id: 'wf_graph', name: 'Hand Built', enabled: true, trigger: { type: 'manual', value: '' },
    graph: { nodes: [{ id: 1, type: 'workflow/trigger', properties: {}, inputs: [], outputs: [] }], links: [] },
  };

  test('automation_list ignores hand-built workflows', async () => {
    writeDefs([GRAPH_WF]);
    expect(textOf(await call('automation_list', {}))).toContain('No automations configured');
  });

  test('automation_update refuses to touch a hand-built workflow', async () => {
    writeDefs([GRAPH_WF]);
    const res = await call('automation_update', { automation: 'Hand Built', prompt: 'x' });
    expect(res.isError).toBe(true);
    expect(readDefs()[0]).toEqual(GRAPH_WF);
  });

  test.each([
    ['workflow_add_node', { type: 'workflow/shell' }],
    ['workflow_update_node', { node_id: 2, properties: { prompt: 'hijacked' } }],
    ['workflow_delete_node', { node_id: 2 }],
    ['workflow_connect_nodes', { from_node: 1, from_slot: 0, to_node: 2, to_slot: 0 }],
    ['workflow_auto_layout', {}],
    ['workflow_add_variable', { name: 'v', value: '1' }],
  ])('%s refuses an automation — its graph is regenerated', async (tool, extra) => {
    await create();
    const before = JSON.stringify(readDefs()[0].graph);

    const res = await workflowTools.handle(tool, { workflow: 'Test', ...extra });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('automation_update');
    expect(JSON.stringify(readDefs()[0].graph)).toBe(before);
  });

  test('the graph tools still work on a hand-built workflow', async () => {
    writeDefs([GRAPH_WF]);
    const res = await workflowTools.handle('workflow_add_node', { workflow: 'Hand Built', type: 'workflow/shell' });
    expect(res.isError).toBeFalsy();
    expect(readDefs()[0].graph.nodes).toHaveLength(2);
  });

  test('workflow_list tags automations so they are not mistaken for graphs', async () => {
    writeDefs([GRAPH_WF]);
    await create();
    const out = textOf(await workflowTools.handle('workflow_list', {}));
    expect(out).toMatch(/Test \(wf_\w+\)\s+\[automation\]/);
    expect(out).toContain('Hand Built (wf_graph)\n');
    expect(out).not.toMatch(/Hand Built \(wf_graph\)\s+\[automation\]/);
  });
});

// ── The store is the only writer protocol ──

describe('_workflowStore', () => {
  test('refuses to write when definitions.json is unparseable, rather than erasing it', () => {
    fs.writeFileSync(DEFS, '{ not json', 'utf8');
    expect(() => store.upsertDefinition({ id: 'x', name: 'X' })).toThrow(/unparseable/);
    expect(fs.readFileSync(DEFS, 'utf8')).toBe('{ not json');
  });

  test('releases the lock after a failed write, so the next call is not wedged', () => {
    fs.writeFileSync(DEFS, '{ not json', 'utf8');
    expect(() => store.upsertDefinition({ id: 'x', name: 'X' })).toThrow();
    expect(fs.existsSync(DEFS + '.lock')).toBe(false);

    writeDefs([]);
    expect(() => store.upsertDefinition({ id: 'x', name: 'X' })).not.toThrow();
  });
});
