/**
 * Each suggestion rule, on its own: what makes it speak, and what keeps it
 * quiet. The engine's gates are covered in discoveryEngine.test.js; these
 * call `condition` and `isUsed` directly with a fake context.
 */

const controlTower = require('../../src/renderer/services/discovery/rules/controlTower.rule');
const repeatedPrompt = require('../../src/renderer/services/discovery/rules/repeatedPrompt.rule');
const commitGenerate = require('../../src/renderer/services/discovery/rules/commitGenerate.rule');
const contextHandoff = require('../../src/renderer/services/discovery/rules/contextHandoff.rule');
const database = require('../../src/renderer/services/discovery/rules/database.rule');
const ticketTracker = require('../../src/renderer/services/discovery/rules/ticketTracker.rule');
const secondAccount = require('../../src/renderer/services/discovery/rules/secondAccount.rule');
const { can } = require('../../src/shared/remote-capabilities');

function memory(initial = {}) {
  let data = initial;
  return { get: () => ({ ...data }), set: (d) => { data = d; }, peek: () => data };
}

function ctx(extra = {}) {
  let clock = 1_000_000;
  return {
    now: () => clock,
    tick: (ms) => { clock += ms; },
    memory: memory(),
    getSetting: () => undefined,
    getAccounts: () => [],
    can,
    joinPath: (...p) => p.join('/'),
    ...extra,
  };
}

describe('controlTower rule', () => {
  test('quiet under three Claude tabs', () => {
    expect(controlTower.condition({ maxClaudeTabs: 2 }, ctx())).toBe(false);
  });

  test('at three, names the count and the split shortcut as bound', () => {
    const verdict = controlTower.condition({ maxClaudeTabs: 3 }, ctx({ splitShortcut: () => 'Ctrl+Alt+V', isSplitInUse: () => false }));
    expect(verdict).toEqual({ params: { count: 3, shortcut: 'Ctrl+Alt+V' } });
  });

  test('someone already splitting the view hears about Control Tower only', () => {
    const verdict = controlTower.condition({ maxClaudeTabs: 4 }, ctx({ isSplitInUse: () => true }));
    expect(verdict.bodyKey).toBe('discovery.rules.controlTower.bodyNoSplit');
  });

  test('retired by having opened Control Tower', () => {
    expect(controlTower.usedWhen).toContain('tab:control-tower');
    expect(controlTower.action).toEqual({ type: 'tab', tab: 'control-tower' });
  });
});

describe('repeatedPrompt rule', () => {
  const long = 'Review the open pull requests on this repository, summarise each one and flag anything that blocks a merge today.';

  test('a long prompt sent three times, far enough apart, is a routine', () => {
    const c = ctx();
    expect(repeatedPrompt.condition({ text: long }, c)).toBe(false);
    c.tick(repeatedPrompt.REPEAT_GAP_MS);
    expect(repeatedPrompt.condition({ text: `  ${long.toUpperCase()} ` }, c)).toBe(false);
    c.tick(repeatedPrompt.REPEAT_GAP_MS);
    expect(repeatedPrompt.condition({ text: long }, c)).toEqual({ params: { count: 3 } });
  });

  test('resending right away (after an error, an interrupt) is not a repeat', () => {
    const c = ctx();
    for (let i = 0; i < 5; i++) {
      expect(repeatedPrompt.condition({ text: long }, c)).toBe(false);
      c.tick(30 * 1000);
    }
  });

  test('short prompts and slash commands are habits, not tasks', () => {
    const c = ctx();
    for (let i = 0; i < 4; i++) {
      expect(repeatedPrompt.condition({ text: 'continue' }, c)).toBe(false);
      expect(repeatedPrompt.condition({ text: `/review ${long}` }, c)).toBe(false);
      c.tick(repeatedPrompt.REPEAT_GAP_MS);
    }
  });

  test('never stores the prompt itself, and keeps a bounded list', () => {
    const c = ctx();
    for (let i = 0; i < repeatedPrompt.MAX_TRACKED + 10; i++) {
      repeatedPrompt.condition({ text: `${long} number ${i}` }, c);
      c.tick(1000);
    }
    const stored = JSON.stringify(c.memory.peek());
    expect(stored).not.toMatch(/pull requests/i);
    expect(Object.keys(c.memory.peek().prompts)).toHaveLength(repeatedPrompt.MAX_TRACKED);
  });

  test('anyone with a workflow already knows automations', async () => {
    const withOne = ctx({ api: { workflow: { list: async () => ({ success: true, workflows: [{ id: 'w' }] }) } } });
    const withNone = ctx({ api: { workflow: { list: async () => ({ success: true, workflows: [] }) } } });
    const broken = ctx({ api: { workflow: { list: async () => { throw new Error('ipc'); } } } });
    expect(await repeatedPrompt.isUsed(withOne)).toBe(true);
    expect(await repeatedPrompt.isUsed(withNone)).toBe(false);
    expect(await repeatedPrompt.isUsed(broken)).toBe(false);
  });
});

describe('commitGenerate rule', () => {
  test('the third hand-typed commit speaks', () => {
    const c = ctx();
    expect(commitGenerate.condition({ generated: false }, c)).toBe(false);
    expect(commitGenerate.condition({ generated: false }, c)).toBe(false);
    expect(commitGenerate.condition({ generated: false }, c)).toBe(true);
  });

  test('generated messages and amends are not counted', () => {
    const c = ctx();
    for (let i = 0; i < 5; i++) {
      expect(commitGenerate.condition({ generated: true }, c)).toBe(false);
      expect(commitGenerate.condition({ generated: false, amend: true }, c)).toBe(false);
    }
    expect(c.memory.peek().manual).toBeUndefined();
  });

  test('points at the generate button, and is retired by using it', () => {
    expect(commitGenerate.action).toEqual({ type: 'tab', tab: 'git', highlight: '#btn-generate-commit' });
    expect(commitGenerate.usedWhen).toEqual(['git:generate-commit']);
  });
});

describe('contextHandoff rule', () => {
  test('quiet below 70 % or without a known window', () => {
    expect(contextHandoff.condition({ ratio: 0.69, limit: 200000 }, ctx())).toBe(false);
    expect(contextHandoff.condition({ ratio: 0.9, limit: 0 }, ctx())).toBe(false);
  });

  test('speaks with the percentage when the handoff is off', () => {
    expect(contextHandoff.condition({ ratio: 0.734, limit: 200000 }, ctx())).toEqual({ params: { percent: 73 } });
  });

  test('quiet, and counted as known, when the handoff is already on', () => {
    const on = ctx({ getSetting: (k) => k === 'contextHandoffEnabled' });
    expect(contextHandoff.condition({ ratio: 0.95, limit: 200000 }, on)).toBe(false);
    expect(contextHandoff.isUsed(on)).toBe(true);
  });

  test('opens the setting itself', () => {
    expect(contextHandoff.action).toEqual({ type: 'setting', tab: 'claude', anchor: 'context-handoff-toggle' });
  });
});

describe('database rule', () => {
  function dirent(name, dir = false) {
    return { name, isFile: () => !dir, isDirectory: () => dir };
  }
  function fakeFs(tree, files = {}) {
    return {
      readdir: jest.fn(async (dir) => {
        if (!tree[dir]) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return tree[dir];
      }),
      readFile: jest.fn(async (file) => {
        if (!(file in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
        return files[file];
      }),
    };
  }
  const project = { id: 'p', name: 'Shop', path: '/w/shop' };

  test('a SQLite file at the root', async () => {
    const c = ctx({ fs: fakeFs({ '/w/shop': [dirent('app.sqlite3'), dirent('src', true)] }) });
    const verdict = await database.condition({ project }, c);
    expect(verdict).toEqual({ params: { file: 'app.sqlite3', project: 'Shop' }, bodyKey: 'discovery.rules.database.bodySqlite' });
  });

  test('a SQLite file in a usual sub-folder', async () => {
    const c = ctx({ fs: fakeFs({ '/w/shop': [dirent('prisma', true)], '/w/shop/prisma': [dirent('dev.db')] }) });
    expect((await database.condition({ project }, c)).params.file).toBe('prisma/dev.db');
  });

  test('a DATABASE_URL in a .env file', async () => {
    const c = ctx({ fs: fakeFs({ '/w/shop': [dirent('.env')] }, { '/w/shop/.env.local': 'PORT=3000\nexport DATABASE_URL=postgres://localhost/shop\n' }) });
    const verdict = await database.condition({ project }, c);
    expect(verdict).toEqual({ params: { file: '.env.local', project: 'Shop' }, bodyKey: 'discovery.rules.database.bodyEnv' });
  });

  test('an empty DATABASE_URL, or one only commented about, is not a database', async () => {
    const c = ctx({ fs: fakeFs({ '/w/shop': [] }, { '/w/shop/.env': '# DATABASE_URL=\nDATABASE_URL=\n' }) });
    expect(await database.condition({ project }, c)).toBe(false);
  });

  test('nothing to see: no file, no env', async () => {
    const c = ctx({ fs: fakeFs({ '/w/shop': [dirent('index.js'), dirent('node_modules', true)] }) });
    expect(await database.condition({ project }, c)).toBe(false);
  });

  test('a remote (SSH) project is never read', async () => {
    const fs = fakeFs({});
    const remote = { id: 'r', name: 'Remote', path: 'ssh-remote://prof/srv/app', remote: { profileId: 'prof', path: '/srv/app' } };
    expect(await database.condition({ project: remote }, ctx({ fs }))).toBe(false);
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  test('a saved connection means the screen is in use', async () => {
    expect(await database.isUsed(ctx({ api: { database: { loadConnections: async () => [{ id: 'c' }] } } }))).toBe(true);
    expect(await database.isUsed(ctx({ api: { database: { loadConnections: async () => [] } } }))).toBe(false);
    expect(await database.isUsed(ctx({ api: { database: { loadConnections: async () => ({ success: false }) } } }))).toBe(false);
  });
});

describe('ticketTracker rule', () => {
  test.each([
    ['eng-123-fix-login', 'ENG-123'],
    ['yanis/eng-42-new-sidebar', 'ENG-42'],
    ['feature/ABC-7', 'ABC-7'],
    ['feature-abc-42-thing', 'ABC-42'],
    ['PROJ-1001', 'PROJ-1001'],
  ])('%s names %s', (branch, key) => {
    expect(ticketTracker.extractTicketKey(branch)).toBe(key);
  });

  test.each(['main', 'HEAD', 'release-2', 'hotfix-3', 'v2-1', 'utf-8', 'feature/login', 'fix-12', 'abc123', ''])('%s names no ticket', (branch) => {
    expect(ticketTracker.extractTicketKey(branch)).toBe(null);
  });

  test('speaks for a ticket branch', async () => {
    const c = ctx({ api: { git: { currentBranch: async () => 'eng-9-crash' } } });
    expect(await ticketTracker.condition({ project: { path: '/p' } }, c)).toEqual({ params: { key: 'ENG-9', branch: 'eng-9-crash' } });
  });

  test('quiet when the branch cannot be read', async () => {
    const c = ctx({ api: { git: { currentBranch: async () => { throw new Error('not a repo'); } } } });
    expect(await ticketTracker.condition({ project: { path: '/p' } }, c)).toBe(false);
  });

  test('a connected tracker, or a visit to Tickets, means it is known', async () => {
    expect(await ticketTracker.isUsed(ctx({ api: { issueTrackers: { connections: async () => ({ ok: true, connections: [{ id: 'l' }] }) } } }))).toBe(true);
    expect(await ticketTracker.isUsed(ctx({ api: { issueTrackers: { connections: async () => ({ ok: true, connections: [] }) } } }))).toBe(false);
    expect(ticketTracker.usedWhen).toContain('tab:tickets');
    expect(ticketTracker.action).toEqual({ type: 'setting', tab: 'tickets' });
  });
});

describe('secondAccount rule', () => {
  const buckets = (...values) => values.map((v, i) => ({ id: `b${i}`, utilization: v }));

  test('quiet under 85 %, or with no figure at all', () => {
    expect(secondAccount.condition({ buckets: buckets(40, 84.4) }, ctx())).toBe(false);
    expect(secondAccount.condition({ buckets: buckets(null, null) }, ctx())).toBe(false);
    expect(secondAccount.condition({}, ctx())).toBe(false);
  });

  test('speaks with the highest figure when there is one account or none', () => {
    expect(secondAccount.condition({ buckets: buckets(30, 91.6) }, ctx({ getAccounts: () => [{ id: 'a' }] }))).toEqual({ params: { percent: 92 } });
    expect(secondAccount.condition({ buckets: buckets(88) }, ctx())).toEqual({ params: { percent: 88 } });
  });

  test('quiet, and counted as known, with two accounts', () => {
    const two = ctx({ getAccounts: () => [{ id: 'a' }, { id: 'b' }] });
    expect(secondAccount.condition({ buckets: buckets(99) }, two)).toBe(false);
    expect(secondAccount.isUsed(two)).toBe(true);
  });

  test('opens the account connection in the Settings', () => {
    expect(secondAccount.action).toEqual({ type: 'setting', tab: 'claude', anchor: 'btn-account-login' });
  });
});
