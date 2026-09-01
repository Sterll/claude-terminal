/**
 * ui_navigate + sidebar tools (resources/mcp-servers/tools/sidebar.js).
 *
 * The tool talks to the running app through trigger/response files under
 * CT_DATA_DIR. Here CT_DATA_DIR points at a temp dir and a stub responder plays
 * the part of the renderer, so the whole request/response round trip is
 * exercised without needing Claude Terminal to be running.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sidebar-'));
process.env.CT_DATA_DIR = DATA_DIR;

const sidebar = require('../../resources/mcp-servers/tools/sidebar.js');

const TRIGGERS = path.join(DATA_DIR, 'tabs', 'triggers');
const RESPONSES = path.join(DATA_DIR, 'tabs', 'responses');

function textOf(result) {
  return result.content[0].text;
}

/**
 * Stand in for the renderer: wait for a trigger to appear, consume it, and write
 * the response the real handler would have written.
 */
function stubRenderer(reply) {
  let stop = false;
  const seen = [];

  const loop = (async () => {
    while (!stop) {
      let files = [];
      try {
        files = fs.readdirSync(TRIGGERS).filter(f => f.endsWith('.json'));
      } catch (_) {}

      for (const file of files) {
        const full = path.join(TRIGGERS, file);
        let trigger;
        try {
          trigger = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (_) {
          continue;
        }
        seen.push(trigger);
        fs.unlinkSync(full);

        fs.mkdirSync(RESPONSES, { recursive: true });
        fs.writeFileSync(
          path.join(RESPONSES, `${trigger.requestId}.json`),
          JSON.stringify(typeof reply === 'function' ? reply(trigger) : reply),
          'utf8'
        );
      }
      await new Promise(r => setTimeout(r, 20));
    }
  })();

  return {
    seen,
    async done() {
      stop = true;
      await loop;
    },
  };
}

afterAll(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('ui_navigate', () => {
  test('is exposed with every real panel plus settings', () => {
    const tool = sidebar.tools.find(t => t.name === 'ui_navigate');

    expect(tool).toBeDefined();
    const targets = tool.inputSchema.properties.tab.enum;
    for (const id of ['claude', 'git', 'tasks', 'control-tower', 'session-replay', 'workspace', 'errorlog', 'settings']) {
      expect(targets).toContain(id);
    }
  });

  test('writes a well-formed trigger and reports the new panel', async () => {
    const stub = stubRenderer(t => ({ ok: true, from: 'claude', to: t.tab, wasHidden: false }));

    const out = textOf(await sidebar.handle('ui_navigate', { tab: 'git' }));
    await stub.done();

    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]).toMatchObject({ action: 'navigate', tab: 'git', source: 'mcp' });
    expect(stub.seen[0].requestId).toMatch(/^req_/);

    expect(out).toContain('Git & version control');
    expect(out).toContain('was on');
  });

  test('warns when the panel is parked in the More menu', async () => {
    const stub = stubRenderer({ ok: true, from: 'claude', to: 'errorlog', wasHidden: true });

    const out = textOf(await sidebar.handle('ui_navigate', { tab: 'errorlog' }));
    await stub.done();

    expect(out).toMatch(/More/);
    expect(out).toMatch(/unpinned/i);
  });

  test('surfaces a renderer-side failure instead of claiming success', async () => {
    const stub = stubRenderer({ ok: false, error: 'Unknown tab "git"', available: ['claude'] });

    const res = await sidebar.handle('ui_navigate', { tab: 'git' });
    await stub.done();

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('Unknown tab');
    expect(textOf(res)).toContain('claude');
  });

  test('rejects an unknown panel without writing a trigger', async () => {
    const before = fs.existsSync(TRIGGERS) ? fs.readdirSync(TRIGGERS).length : 0;

    const res = await sidebar.handle('ui_navigate', { tab: 'not-a-panel' });

    const after = fs.existsSync(TRIGGERS) ? fs.readdirSync(TRIGGERS).length : 0;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/Unknown panel/);
    expect(after).toBe(before);
  });

  test('rejects a missing tab parameter', async () => {
    const res = await sidebar.handle('ui_navigate', {});

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/tab/i);
  });

  test('times out with an actionable message when the app is not running', async () => {
    const res = await sidebar.handle('ui_navigate', { tab: 'dashboard' });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/is the app running/i);

    // Leave no orphan trigger behind for the next test.
    try {
      for (const f of fs.readdirSync(TRIGGERS)) fs.unlinkSync(path.join(TRIGGERS, f));
    } catch (_) {}
  }, 15000);
});

describe('sidebar pinning stays in sync with the renderer', () => {
  test('accepts the panels that were previously rejected', async () => {
    const res = await sidebar.handle('sidebar_set_pinned', {
      pinned: ['git', 'tasks', 'control-tower', 'session-replay', 'workspace', 'errorlog'],
    });

    expect(res.isError).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    for (const id of ['tasks', 'control-tower', 'session-replay', 'workspace', 'errorlog']) {
      expect(saved.pinnedTabs).toContain(id);
    }
  });

  test('always keeps claude pinned', async () => {
    await sidebar.handle('sidebar_set_pinned', { pinned: ['git'] });

    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    expect(saved.pinnedTabs[0]).toBe('claude');
  });

  test('still rejects a genuinely unknown tab id', async () => {
    const res = await sidebar.handle('sidebar_set_pinned', { pinned: ['git', 'made-up'] });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/made-up/);
  });
});
