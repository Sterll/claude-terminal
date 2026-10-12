/**
 * Tickets for terminal-mode Claude sessions: one button in the session bar,
 * serving the active tab, and a toast for what detection finds in any
 * terminal session. Wired to the real link and tracker services over the
 * fake test adapter.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setImmediate: realImmediate } = require('timers');

const { createTerminalTicketsButton } = require('../../src/renderer/ui/components/terminal/ticketsButton');
const { t } = require('../../src/renderer/i18n');
const { createIssueTrackerService } = require('../../src/main/services/IssueTrackerService');
const { createIssueLinkService } = require('../../src/main/services/IssueLinkService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const fake = require('../issue-trackers/fake.tracker');
const fixture = require('../issue-trackers/fixtures/fake.fixture');

async function waitFor(check) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    try {
      if (check()) return;
    } catch { /* not yet */ }
    await new Promise((r) => realImmediate(r));
  }
}

function wrap(fn, key) {
  return jest.fn(async (...args) => {
    try {
      const value = await fn(...args);
      return key ? { ok: true, [key]: value } : { ok: true, ...value };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || 'PROVIDER' };
    }
  });
}

/** terminals.state as the button reads it. */
function fakeTerminals(terminals, activeTerminal) {
  let value = { terminals: new Map(terminals), activeTerminal };
  const listeners = new Set();
  return {
    get: () => value,
    set: (patch) => { value = { ...value, ...patch }; listeners.forEach((fn) => fn(value)); },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

let dir;
let api;
let links;
let conn;
let changed;
let button;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-term-tickets-'));
  const secrets = new Map();
  const trackers = createIssueTrackerService({
    storePath: path.join(dir, 'issue-trackers.json'),
    secrets: { get: async (a) => secrets.get(a) ?? null, set: async (a, v) => { secrets.set(a, v); }, delete: async (a) => secrets.delete(a) },
    registry: { get: (id) => (id === 'fake' ? fake : null), describe: () => describeTrackers([fake]) },
    fetch: fixture.fetch,
  });
  changed = new Set();
  links = createIssueLinkService({ storePath: path.join(dir, 'issue-links.json'), broadcast: (sessionKey) => changed.forEach((fn) => fn({ sessionKey })) });
  conn = await trackers.connect('fake', fixture.secret);
  api = {
    dialog: { openExternal: jest.fn() },
    issueTrackers: {
      providers: wrap(async () => trackers.listProviders(), 'providers'),
      connections: wrap(() => trackers.listConnections(), 'connections'),
      metadata: wrap((id) => trackers.metadata(id), 'metadata'),
      listIssues: wrap((id, q, c) => trackers.listIssues(id, q, c)),
      getIssue: wrap((id, key) => trackers.getIssue(id, key), 'issue'),
    },
    issueLinks: {
      get: wrap((k) => links.get(k), 'links'),
      link: wrap((k, l, o) => links.link(k, l, o || {}), 'links'),
      confirm: wrap((k, refs) => links.confirm(k, refs), 'links'),
      dismiss: wrap((k, refs) => links.dismiss(k, refs), 'links'),
      rekey: wrap((a, b) => links.rekey(a, b), 'moved'),
      copy: wrap((a, b) => links.copy(a, b), 'copied'),
      onChanged: (fn) => { changed.add(fn); return () => changed.delete(fn); },
    },
  };
  document.body.innerHTML = '<div class="session-actions"><button id="btn-new-terminal"></button></div>';
});

afterEach(() => {
  button?.destroy();
  button = null;
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

const TERMINALS = [
  [1, { mode: 'terminal', name: 'acme-app', claudeSessionId: 'cli-1', project: { id: 'p1' } }],
  [2, { mode: 'terminal', name: 'shell', isBasic: true, project: { id: 'p1' } }],
  [3, { mode: 'chat', name: 'chat tab', claudeSessionId: 'sdk-3', project: { id: 'p1' } }],
  [4, { mode: 'terminal', name: 'background', claudeSessionId: 'cli-4', project: { id: 'p1' } }],
];

function mount(active) {
  const state = fakeTerminals(TERMINALS, active);
  const deps = { api, hostEl: document.querySelector('.session-actions'), terminalsState: state, activateTerminal: jest.fn((id) => state.set({ activeTerminal: id })), showToast: jest.fn() };
  button = createTerminalTicketsButton(deps);
  return { state, deps, btn: document.querySelector('.terminal-tickets-btn'), popover: document.querySelector('.terminal-tickets-popover') };
}

test('shown for a terminal Claude session once a tracker is connected', async () => {
  const { btn } = mount(1);
  await waitFor(() => !btn.hidden);
  expect(btn.hidden).toBe(false);
  expect(document.querySelector('.session-actions').firstElementChild).toBe(btn);
});

test.each([
  ['a basic terminal', 2],
  ['a chat tab, which has its own Tickets tab', 3],
  ['no active tab', null],
])('hidden for %s', async (_label, active) => {
  const { btn } = mount(active);
  await new Promise((r) => setTimeout(r, 50));
  expect(btn.hidden).toBe(true);
});

test('the popover lists the session\'s tickets and follows the active tab', async () => {
  await links.link('cli-1', { ref: 'fake:#1', connectionId: conn.id, title: 'Crash when the tab closes' });
  await links.link('cli-4', { ref: 'fake:#2', connectionId: conn.id, title: 'Document the adapter contract' });
  const { btn, popover, state } = mount(1);
  await waitFor(() => !btn.hidden && btn.querySelector('.chat-tab-badge').textContent === '1');
  btn.click();
  expect(popover.hidden).toBe(false);
  expect(btn.getAttribute('aria-expanded')).toBe('true');
  await waitFor(() => popover.querySelector('.session-tickets-row'));
  expect(popover.querySelector('.session-tickets-row').dataset.ref).toBe('fake:#1');

  state.set({ activeTerminal: 4 });
  expect(popover.hidden).toBe(true); // switching tabs closes it
  await waitFor(() => !btn.hidden);
  btn.click();
  await waitFor(() => popover.querySelector('.session-tickets-row')?.dataset.ref === 'fake:#2');
  expect(popover.querySelector('.session-tickets-row').dataset.ref).toBe('fake:#2');

  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(popover.hidden).toBe(true);
});

test('a detection in a background terminal session is toasted once, and Review brings it forward', async () => {
  const { deps, popover } = mount(1);
  await links.suggest('cli-4', { ref: 'fake:#3', connectionId: conn.id, title: 'x', source: 'tool' });
  await waitFor(() => deps.showToast.mock.calls.length === 1);
  const toast = deps.showToast.mock.calls[0][0];
  expect(toast.title).toBe(t('chat.tickets.detectedInTerminal', { keys: '#3', tab: 'background' }));
  expect(toast.action).toBe(t('chat.tickets.review'));

  await links.link('cli-4', { ref: 'fake:#2', connectionId: conn.id, title: 'Document the adapter contract' }); // another change, same suggestion
  await new Promise((r) => setTimeout(r, 50));
  expect(deps.showToast).toHaveBeenCalledTimes(1);

  toast.onAction();
  expect(deps.activateTerminal).toHaveBeenCalledWith(4);
  expect(popover.hidden).toBe(false);
  await waitFor(() => popover.querySelector('.session-tickets-row.suggested'));
  expect(popover.querySelector('.session-tickets-row.suggested').dataset.ref).toBe('fake:#3');
});

test('a chat session\'s detections are left to its own card', async () => {
  const { deps } = mount(1);
  await links.suggest('sdk-3', { ref: 'fake:#3', connectionId: conn.id, title: 'x', source: 'tool' });
  await new Promise((r) => setTimeout(r, 50));
  expect(deps.showToast).not.toHaveBeenCalled();
});

test('destroy removes the button and the popover', () => {
  mount(1);
  button.destroy();
  button = null;
  expect(document.querySelector('.terminal-tickets-btn')).toBeNull();
  expect(document.querySelector('.terminal-tickets-popover')).toBeNull();
});
