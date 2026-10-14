/**
 * The Tickets screen, wired to the real IssueTrackerService over the fake
 * test adapter (GitHub Issues-like: `#12` keys, open or closed, only the state
 * writable): what the panel asks for is answered the way main would answer it. Only the markdown renderer is stubbed, since
 * the detail pane's job is to hand it text, not to render mermaid.
 */

'use strict';

jest.mock('../../src/renderer/services/MarkdownRenderer', () => ({
  render: (md) => `<p class="md">${String(md).replace(/</g, '&lt;')}</p>`,
  postProcess: jest.fn(),
  attachInteractivity: jest.fn(),
}));

const mockSettings = { ticketsView: undefined };
jest.mock('../../src/renderer/state/settings.state', () => ({
  getSetting: (key) => mockSettings[key],
  setSetting: jest.fn((key, value) => { mockSettings[key] = value; }),
}));

const fs = require('fs');
// jsdom has no setImmediate global, and the fake clock must not own this one.
const { setImmediate: realImmediate } = require('timers');
const os = require('os');
const path = require('path');
const { t } = require('../../src/renderer/i18n');
const { setSetting } = require('../../src/renderer/state/settings.state');
const panel = require('../../src/renderer/ui/panels/IssuesPanel');
const { createIssueTrackerService } = require('../../src/main/services/IssueTrackerService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const fake = require('../issue-trackers/fake.tracker');
const fixture = require('../issue-trackers/fixtures/fake.fixture');

/** Bridge calls still waiting for the service, see flush(). */
let inflight = 0;

/** window.electron_api.issueTrackers, the way issue-trackers.ipc.js answers. */
function bridgeFor(service) {
  const wrap = (fn, key) => async (...args) => {
    inflight++;
    try {
      const value = await fn(...args);
      return key ? { ok: true, [key]: value } : { ok: true, ...value };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || 'PROVIDER' };
    } finally {
      inflight--;
    }
  };
  return {
    providers: wrap(async () => service.listProviders(), 'providers'),
    connections: wrap(() => service.listConnections(), 'connections'),
    metadata: wrap((id) => service.metadata(id), 'metadata'),
    listIssues: jest.fn(wrap((id, q, c) => service.listIssues(id, q, c))),
    getIssue: wrap((id, key) => service.getIssue(id, key), 'issue'),
    updateIssue: jest.fn(wrap((id, key, patch) => service.updateIssue(id, key, patch), 'issue')),
  };
}

let dir;
let service;
let api;
let deps;
let root;

async function setup({ connect = true } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-issues-panel-'));
  const secrets = new Map();
  service = createIssueTrackerService({
    storePath: path.join(dir, 'issue-trackers.json'),
    secrets: { get: async (a) => secrets.get(a) ?? null, set: async (a, v) => { secrets.set(a, v); }, delete: async (a) => secrets.delete(a) },
    registry: { get: (id) => (id === 'fake' ? fake : null), describe: () => describeTrackers([fake]) },
    fetch: fixture.fetch,
  });
  if (connect) await service.connect('fake', fixture.secret);
  api = { issueTrackers: bridgeFor(service), dialog: { openExternal: jest.fn() } };
  deps = { api, showToast: jest.fn(), openSettings: jest.fn() };
  panel.init(deps);
  document.body.innerHTML = '<div id="tickets-panel-root"></div>';
  root = document.getElementById('tickets-panel-root');
  await panel.loadPanel(root);
}

/**
 * Advance the fake clock, then let real I/O finish: the service reads its
 * store from disk, and those callbacks only run on a real turn of the event
 * loop, which setImmediate (left unfaked) gives them. How many turns that takes
 * depends on the disk, so a fixed count passed here and failed on a slower CI
 * runner: wait instead until no bridge call is pending, then a few more turns
 * for what the answers render. hrtime bounds it, since the fake clock owns Date.
 */
const flush = async (ms = 0) => {
  await jest.advanceTimersByTimeAsync(ms);
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  for (let quiet = 0; quiet < 10 && process.hrtime.bigint() < deadline;) {
    await new Promise((resolve) => realImmediate(resolve));
    quiet = inflight === 0 ? quiet + 1 : 0;
  }
};
// The tickets the list holds: a parent shown only for context is not one of them.
const rowKeys = () => [...root.querySelectorAll('.issues-list > .issue-group .issue-row:not(.context)')].map((r) => r.dataset.key);
const lastQuery = () => api.issueTrackers.listIssues.mock.calls.at(-1)[1];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  mockSettings.ticketsView = undefined;
  setSetting.mockClear();
  panel._reset();
});

afterEach(async () => {
  await flush(); // a write still on its way would land in the next test's panel
  panel._reset();
  jest.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('without a connection it says so and leads to the settings', async () => {
  await setup({ connect: false });
  expect(root.querySelector('.issues-state-title').textContent).toBe(t('tickets.panel.noConnection'));
  expect(root.querySelector('.issues-toolbar').hidden).toBe(true);
  root.querySelector('.issues-open-settings').click();
  expect(deps.openSettings).toHaveBeenCalledWith('tickets');
});

test('a first visit lists every open ticket of the workspace, grouped by status', async () => {
  await setup();
  expect(lastQuery()).toMatchObject({ mine: null, stateCategories: ['backlog', 'todo', 'started'] });
  expect(rowKeys()).toEqual(['#2', '#1', '#4']); // #3 is closed; #4 is a sub-issue of #1, so under it
  expect(root.querySelector('.issues-count').textContent).toBe('3');
  expect(root.querySelector('.issues-reset')).toBeNull();
});

test('"My tickets" narrows to what is assigned to me', async () => {
  await setup();
  root.querySelector('.issues-quick-btn[data-mine="assigned"]').click();
  await flush(200);
  expect(lastQuery().mine).toBe('assigned');
  expect(rowKeys()).toEqual(['#1']);
  expect(root.querySelector('.issues-reset')).not.toBeNull();
});

test('search waits for the typing to stop, then queries once', async () => {
  await setup();
  const calls = api.issueTrackers.listIssues.mock.calls.length;
  const input = root.querySelector('.issues-search');
  for (const text of ['c', 'cr', 'cra', 'crash']) {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(50);
  }
  await flush(300);
  expect(api.issueTrackers.listIssues.mock.calls.length).toBe(calls + 1);
  expect(lastQuery().text).toBe('crash');
  expect(rowKeys()).toEqual(['#1']);
});

test('a status picked in the menu is sent as its state id', async () => {
  await setup();
  root.querySelector('[data-menu="status"]').click();
  const item = [...root.querySelectorAll('.issues-menu-item')].find((b) => b.dataset.value === 'state:done:Closed');
  item.click();
  await flush(200);
  expect(lastQuery().stateIds).toEqual(['closed']);
  expect(rowKeys()).toContain('#3');
  expect(root.querySelector('.issues-menu')).not.toBeNull(); // multi-select stays open
});

test('grouping changes the groups without asking the tracker again', async () => {
  await setup();
  const calls = api.issueTrackers.listIssues.mock.calls.length;
  root.querySelector('[data-menu="groupBy"]').click();
  [...root.querySelectorAll('.issues-menu-item')].find((b) => b.dataset.value === 'assignee').click();
  await flush(200);
  expect(api.issueTrackers.listIssues.mock.calls.length).toBe(calls);
  expect(root.querySelector('.issues-menu')).toBeNull();
  expect(root.querySelector('.issue-group-label').textContent).toBe('Ada Lovelace');
});

test('a tracker without priorities offers no priority filter or grouping', async () => {
  await setup();
  expect(root.querySelector('[data-menu="priority"]')).toBeNull();
  root.querySelector('[data-menu="groupBy"]').click();
  const options = [...root.querySelectorAll('.issues-menu-item')].map((b) => b.dataset.value);
  expect(options).toContain('container');
  expect(options).not.toContain('priority');
});

test('a slower, older answer never replaces a newer one', async () => {
  await setup();
  const real = api.issueTrackers.listIssues.getMockImplementation();
  let releaseSlow;
  api.issueTrackers.listIssues
    .mockImplementationOnce((...args) => new Promise((resolve) => { releaseSlow = () => resolve(real(...args)); }))
    .mockImplementationOnce(real);
  root.querySelector('.issues-quick-btn[data-mine="created"]').click();
  await flush(200);
  root.querySelector('.issues-quick-btn[data-mine="assigned"]').click();
  await flush(200);
  releaseSlow();
  await flush();
  expect(rowKeys()).toEqual(['#1']);
});

test('a row opens its detail; Escape closes it', async () => {
  await setup();
  root.querySelector('.issue-row[data-key="#1"]').click();
  await flush();
  const detail = root.querySelector('.issues-detail');
  expect(detail.hidden).toBe(false);
  expect(detail.querySelector('.issue-detail-title').textContent).toBe('Crash when the tab closes');
  expect(detail.querySelector('.issue-detail-description').textContent).toContain('Body of #1');
  expect(root.querySelector('.issue-row.selected').dataset.key).toBe('#1');

  detail.querySelector('[data-action="open"]').click();
  expect(api.dialog.openExternal).toHaveBeenCalledWith('https://example.com/acme/app/issues/1');

  // In the app the redraw takes the focused row away, so Escape lands on <body>.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(detail.hidden).toBe(true);
});

test('a modal above the screen keeps its own Escape', async () => {
  await setup();
  root.querySelector('.issue-row[data-key="#1"]').click();
  await flush();
  document.body.insertAdjacentHTML('beforeend', '<div id="modal-overlay" class="active"></div>');
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(root.querySelector('.issues-detail').hidden).toBe(false);
});

test('Enter on a focused row opens it, and focus survives the redraw', async () => {
  await setup();
  const row = root.querySelector('.issue-row[data-key="#2"]');
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  expect(root.querySelector('.issue-detail-title').textContent).toBe('Document the adapter contract');
  expect(document.activeElement.dataset.key).toBe('#2');
});

test('a sub-issue in the detail opens in its place', async () => {
  await setup();
  root.querySelector('.issue-row[data-key="#1"]').click();
  await flush();
  root.querySelector('.issue-detail-children .issue-row[data-key="#4"]').click();
  await flush();
  expect(root.querySelector('.issue-detail-title').textContent).toBe('Sub-task of #1');
});

test('a parent shown for context opens like any ticket; a sub-issue\'s detail leads back to it', async () => {
  await setup();
  root.querySelector('[data-menu="groupBy"]').click();
  [...root.querySelectorAll('.issues-menu-item')].find((b) => b.dataset.value === 'assignee').click();
  await flush(200);
  const unassigned = [...root.querySelectorAll('.issue-group')].find((g) => g.querySelector('.issue-group-label')?.textContent === t('tickets.groupBy.noAssignee'));
  const context = unassigned.querySelector('.issue-row.context[data-key="#1"]');
  expect(context.nextElementSibling.dataset).toMatchObject({ key: '#4', depth: '1', last: '' });
  context.click();
  await flush();
  expect(root.querySelector('.issue-detail-title').textContent).toBe('Crash when the tab closes');

  root.querySelector('.issue-detail-children .issue-row[data-key="#4"]').click();
  await flush();
  root.querySelector('.issue-detail-parent .issue-row').click();
  await flush();
  expect(root.querySelector('.issue-detail-title').textContent).toBe('Crash when the tab closes');
});

test('a rejected key is explained, with the way to fix it', async () => {
  await setup();
  api.issueTrackers.listIssues.mockResolvedValueOnce({ ok: false, code: 'AUTH', error: 'x' });
  panel._reset();
  panel.init(deps);
  await panel.loadPanel(root);
  expect(root.querySelector('.issues-state-error').textContent).toContain(t('tickets.errors.auth', { provider: 'Fake Tracker' }));
  root.querySelector('.issues-open-settings').click();
  expect(deps.openSettings).toHaveBeenCalledWith('tickets');
});

test('the view is remembered without the search text', async () => {
  await setup();
  root.querySelector('.issues-quick-btn[data-mine="assigned"]').click();
  const input = root.querySelector('.issues-search');
  input.value = 'crash';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(1000);
  const saved = setSetting.mock.calls.at(-1);
  expect(saved[0]).toBe('ticketsView');
  expect(saved[1]).toMatchObject({ mine: 'assigned', connectionId: expect.stringMatching(/^fake-/) });
  expect(saved[1]).not.toHaveProperty('text');
});

test('leaving the tab stops the refresh; coming back draws at once', async () => {
  await setup();
  panel.cleanup();
  const calls = api.issueTrackers.listIssues.mock.calls.length;
  await flush(5 * 60_000);
  expect(api.issueTrackers.listIssues.mock.calls.length).toBe(calls);

  root.innerHTML = '';
  const back = panel.loadPanel(root);
  expect(rowKeys()).toHaveLength(3); // drawn from memory before the refresh lands
  await back;
});

describe('board and writes', () => {
  /** A drag as Chromium sends it, with a dataTransfer jsdom does not have. */
  function drag(card, column) {
    const dataTransfer = { setData() {}, getData() { return ''; }, effectAllowed: '', dropEffect: '' };
    const fire = (el, type) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      ev.dataTransfer = dataTransfer;
      el.dispatchEvent(ev);
      return ev;
    };
    fire(card, 'dragstart');
    const over = fire(column, 'dragover');
    fire(column, 'drop');
    fire(card, 'dragend');
    return over;
  }
  const column = (key) => [...root.querySelectorAll('.issues-board-column')].find((c) => c.dataset.column === key);
  const cardIn = (colKey, key) => column(colKey).querySelector(`.issue-card[data-key="${key}"]`);

  async function boardSetup() {
    await setup();
    root.querySelector('.issues-layout-btn[data-layout="board"]').click();
    await flush();
  }

  test('the board shows one column per category the tracker uses when its states belong to the whole workspace', async () => {
    await boardSetup();
    expect([...root.querySelectorAll('.issues-board-column')].map((c) => c.dataset.column)).toEqual(['cat:todo', 'cat:done']);
    expect(root.querySelector('[data-menu="groupBy"]')).toBeNull();
    expect(mockSettings.ticketsView).toBeUndefined(); // saved after the debounce
    await flush(1000);
    expect(mockSettings.ticketsView.layout).toBe('board');
  });

  test('dropping a card moves it at once and writes the column\'s state', async () => {
    await boardSetup();
    const over = drag(cardIn('cat:todo', '#2'), column('cat:done'));
    expect(over.defaultPrevented).toBe(true); // the drop is allowed
    expect(cardIn('cat:done', '#2')).not.toBeNull(); // optimistic
    await flush();
    expect(api.issueTrackers.updateIssue).toHaveBeenCalledWith(expect.stringMatching(/^fake-/), '#2', { stateId: 'closed' });
    expect(cardIn('cat:done', '#2')).not.toBeNull();
  });

  test('a refused write puts the card back and says why', async () => {
    await boardSetup();
    api.issueTrackers.updateIssue.mockResolvedValueOnce({ ok: false, code: 'PROVIDER', error: 'Forbidden' });
    drag(cardIn('cat:todo', '#2'), column('cat:done'));
    await flush();
    expect(cardIn('cat:todo', '#2')).not.toBeNull();
    expect(deps.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', title: t('tickets.errors.updateFailed', { key: '#2' }) }));
  });

  test('a moved card stays on the board through a background refresh, even outside the filters', async () => {
    await boardSetup();
    drag(cardIn('cat:todo', '#2'), column('cat:done'));
    await flush();
    Object.defineProperty(root, 'offsetParent', { configurable: true, get: () => document.body });
    jest.spyOn(document, 'hasFocus').mockReturnValue(true);
    await flush(61_000);
    expect(api.issueTrackers.listIssues.mock.calls.at(-1)[1].stateCategories).toEqual(['backlog', 'todo', 'started']);
    expect(cardIn('cat:done', '#2')).not.toBeNull();
    document.hasFocus.mockRestore();
  });

  test('dropping on the column it is already in writes nothing', async () => {
    await boardSetup();
    const over = drag(cardIn('cat:todo', '#2'), column('cat:todo'));
    await flush();
    expect(over.defaultPrevented).toBe(false);
    expect(api.issueTrackers.updateIssue).not.toHaveBeenCalled();
  });

  test('the detail pane changes the state, the one field this tracker writes', async () => {
    await setup();
    root.querySelector('.issue-row[data-key="#1"]').click();
    await flush();
    expect([...root.querySelectorAll('.issue-prop-edit')].map((b) => b.dataset.edit)).toEqual(['state']);
    root.querySelector('.issue-prop-edit[data-edit="state"]').click();
    [...root.querySelectorAll('.issues-menu-item')].find((b) => b.dataset.value === 'closed').click();
    await flush();
    expect(api.issueTrackers.updateIssue.mock.calls.map((c) => c[2])).toEqual([{ stateId: 'closed' }]);
    expect(root.querySelector('.issue-detail-props').textContent).toContain('Closed');
    expect(root.querySelector('.issue-detail-description').textContent).toContain('Body of #1'); // kept from the detail
  });

  test('a tracker that cannot write gets no drag and no edit buttons', async () => {
    const readOnly = { ...fake, capabilities: { ...fake.capabilities, write: [] } };
    await setup();
    panel._reset();
    api.issueTrackers.providers = async () => ({ ok: true, providers: describeTrackers([readOnly]) });
    panel.init(deps);
    await panel.loadPanel(root);
    root.querySelector('.issues-layout-btn[data-layout="board"]').click();
    await flush();
    expect(root.querySelector('.issue-card[draggable="true"]')).toBeNull();
    root.querySelector('.issue-card[data-key="#1"]').click();
    await flush();
    expect(root.querySelector('.issue-prop-edit')).toBeNull();
  });
});

describe('starting a session from a ticket', () => {
  const PROJECTS = [
    { id: 'p-other', name: 'other', path: '/repo/other' },
    { id: 'p-acme', name: 'acme-app', path: '/repo/acme' },
  ];

  async function startSetup({ branchName = null, branches = { local: [], remote: [] } } = {}) {
    await setup();
    panel._reset();
    api.git = {
      branches: jest.fn(async () => branches),
      createBranch: jest.fn(async () => ({ success: true })),
      checkout: jest.fn(async () => ({ success: true })),
    };
    if (branchName) {
      // The fake tracker names no branch: this one does.
      const getIssue = api.issueTrackers.getIssue;
      api.issueTrackers.getIssue = async (...args) => {
        const res = await getIssue(...args);
        return res.ok ? { ...res, issue: { ...res.issue, branchName } } : res;
      };
    }
    deps.getProjects = () => ({ projects: PROJECTS, openedProjectId: 'p-acme' });
    deps.startSession = jest.fn();
    panel.init(deps);
    await panel.loadPanel(root);
    root.querySelector('.issue-row[data-key="#2"]').click();
    await flush();
    root.querySelector('[data-action="start-session"]').click();
  }

  test('the start button only exists when the app can open a session', async () => {
    await setup();
    root.querySelector('.issue-row[data-key="#2"]').click();
    await flush();
    expect(root.querySelector('[data-action="start-session"]')).toBeNull();
  });

  test('the options: the opened project first, and no branch or move the tracker cannot back', async () => {
    await startSetup();
    const dialog = root.querySelector('.issues-start');
    expect([...dialog.querySelectorAll('option')].map((o) => o.value)).toEqual(['p-acme', 'p-other']);
    expect(dialog.querySelector('.issues-start-branch')).toBeNull(); // the tracker names no branch
    expect(dialog.querySelector('.issues-start-move')).toBeNull(); // nor has an "in progress" state
  });

  test('starting opens a chat linked to the ticket, with an unsent draft', async () => {
    await startSetup();
    root.querySelector('[data-action="start-confirm"]').click();
    await flush();
    expect(api.git.createBranch).not.toHaveBeenCalled();
    expect(api.issueTrackers.updateIssue).not.toHaveBeenCalled();
    const [project, opts] = deps.startSession.mock.calls[0];
    expect(project.id).toBe('p-acme');
    expect(opts.initialTickets).toEqual([{ ref: 'fake:#2', connectionId: expect.stringMatching(/^fake-/), title: 'Document the adapter contract' }]);
    expect(opts.draftPrompt).toContain(t('tickets.start.draftIntro', { key: '#2' }));
    expect(opts.draftPrompt).toContain('# #2: Document the adapter contract');
    expect(opts.draftPrompt).toContain('Repository: acme/site');
    expect(opts.draftPrompt).not.toContain('Team:'); // the repository is not called a team
    expect(root.querySelector('.issues-start')).toBeNull();
  });

  test("the tracker's branch is created when git does not have it", async () => {
    await startSetup({ branchName: 'ada/2-docs', branches: { local: ['main'], remote: ['main'] } });
    root.querySelector('[data-action="start-confirm"]').click();
    await flush();
    expect(api.git.branches).toHaveBeenCalledWith({ projectPath: '/repo/acme' });
    expect(api.git.createBranch).toHaveBeenCalledWith({ projectPath: '/repo/acme', branch: 'ada/2-docs' });
    expect(api.git.checkout).not.toHaveBeenCalled();
    expect(deps.showToast).not.toHaveBeenCalled();
  });

  test('an existing branch, local or on the remote, is checked out, whatever language git speaks', async () => {
    for (const branches of [{ local: ['main', 'ada/2-docs'], remote: [] }, { local: ['main'], remote: ['ada/2-docs'] }]) {
      await startSetup({ branchName: 'ada/2-docs', branches });
      root.querySelector('[data-action="start-confirm"]').click();
      await flush();
      expect(api.git.checkout).toHaveBeenCalledWith({ projectPath: '/repo/acme', branch: 'ada/2-docs' });
      expect(api.git.createBranch).not.toHaveBeenCalled();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  test('Escape closes the options without starting anything', async () => {
    await startSetup();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('.issues-start')).toBeNull();
    expect(root.querySelector('.issues-detail').hidden).toBe(false);
    expect(deps.startSession).not.toHaveBeenCalled();
  });
});
