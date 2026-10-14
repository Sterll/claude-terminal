/**
 * Settings → Tickets. The key is the thing to get right: it goes to main once,
 * leaves the input whatever the answer, and is only ever shown masked. Provider
 * and workspace names come from the network, so they are escaped like any
 * other untrusted text.
 */

'use strict';

const { mountTicketsSettings } = require('../../src/renderer/ui/components/ticketsSettings');
const { t } = require('../../src/renderer/i18n');

const TRACKER = {
  id: 'fake',
  name: 'Fake Tracker',
  auth: { type: 'apiKey', helpUrl: 'https://example.com/settings/tokens' },
  capabilities: { priority: false, labels: true, estimate: false, comments: true, write: [] },
};

const CONNECTION = {
  id: 'fake-abc',
  provider: 'fake',
  providerName: 'Fake Tracker',
  workspace: { id: 'acme', name: 'Acme', url: 'https://example.com/acme' },
  user: { id: 'u-ada', name: 'Ada Lovelace', avatarUrl: null },
  connectedAt: '2026-10-09T09:00:00.000Z',
  maskedKey: 'fake_••••0000',
  available: true,
};

function makeApi({ providers = [TRACKER], connections = [] } = {}) {
  const state = { connections: [...connections] };
  return {
    state,
    dialog: { openExternal: jest.fn() },
    issueTrackers: {
      providers: jest.fn(async () => ({ ok: true, providers })),
      connections: jest.fn(async () => ({ ok: true, connections: state.connections })),
      connect: jest.fn(async () => {
        state.connections = [CONNECTION];
        return { ok: true, connection: CONNECTION };
      }),
      disconnect: jest.fn(async (id) => {
        state.connections = state.connections.filter((c) => c.id !== id);
        return { ok: true };
      }),
      test: jest.fn(async () => ({ ok: true, connection: CONNECTION })),
    },
  };
}

let root;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  root = document.getElementById('root');
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const card = () => root.querySelector('.tickets-provider[data-provider="fake"]');
const status = () => card().querySelector('.tickets-status');

test('draws one card per provider, with its help link', async () => {
  await mountTicketsSettings(root, { api: makeApi() });
  expect(root.querySelectorAll('.tickets-provider')).toHaveLength(1);
  expect(card().querySelector('.tickets-provider-name').textContent).toBe('Fake Tracker');
  expect(card().querySelector('.tickets-connection')).toBeNull();
  expect(card().querySelector('.tickets-connect').textContent).toBe(t('tickets.settings.connect'));
});

test('a connected workspace shows its user and the masked key', async () => {
  await mountTicketsSettings(root, { api: makeApi({ connections: [CONNECTION] }) });
  const conn = card().querySelector('.tickets-connection');
  expect(conn.querySelector('.tickets-connection-workspace').textContent).toBe('Acme');
  expect(conn.querySelector('.tickets-connection-meta').textContent).toContain('fake_••••0000');
  expect(conn.querySelector('.tickets-avatar').textContent).toBe('AL');
  expect(card().querySelector('.tickets-connect').textContent).toBe(t('tickets.settings.connectAnother'));
});

test('connect sends the key once, clears the input, and shows the new workspace', async () => {
  const api = makeApi();
  await mountTicketsSettings(root, { api });
  card().querySelector('.tickets-key-input').value = '  fake_secret_key  ';
  card().querySelector('.tickets-connect').click();
  await flush();
  await flush();
  expect(api.issueTrackers.connect).toHaveBeenCalledWith('fake', 'fake_secret_key');
  expect(root.innerHTML).not.toContain('fake_secret_key');
  expect(card().querySelector('.tickets-connection-workspace').textContent).toBe('Acme');
  expect(status().textContent).toBe(t('tickets.settings.connected', { workspace: 'Acme' }));
  expect(status().dataset.kind).toBe('ok');
});

test('Enter in the key field connects too', async () => {
  const api = makeApi();
  await mountTicketsSettings(root, { api });
  const input = card().querySelector('.tickets-key-input');
  input.value = 'fake_secret_key';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  expect(api.issueTrackers.connect).toHaveBeenCalledTimes(1);
});

test('an empty key sends nothing', async () => {
  const api = makeApi();
  await mountTicketsSettings(root, { api });
  card().querySelector('.tickets-connect').click();
  await flush();
  expect(api.issueTrackers.connect).not.toHaveBeenCalled();
  expect(card().querySelector('.tickets-key-input').classList.contains('error')).toBe(true);
});

test.each([
  ['AUTH', () => t('tickets.settings.errorAuth')],
  ['RATE_LIMITED', () => t('tickets.settings.errorRateLimited')],
  ['NETWORK', () => t('tickets.settings.errorNetwork', { provider: 'Fake Tracker' })],
  ['PROVIDER', () => t('tickets.settings.errorProvider', { provider: 'Fake Tracker', message: 'Boom' })],
])('a %s failure is explained, and the key still leaves the input', async (code, expected) => {
  const api = makeApi();
  api.issueTrackers.connect.mockResolvedValueOnce({ ok: false, code, error: 'Boom' });
  await mountTicketsSettings(root, { api });
  card().querySelector('.tickets-key-input').value = 'fake_wrong';
  card().querySelector('.tickets-connect').click();
  await flush();
  expect(card().querySelector('.tickets-key-input').value).toBe('');
  expect(card().querySelector('.tickets-connect').disabled).toBe(false);
  expect(status().textContent).toBe(expected());
  expect(status().dataset.kind).toBe('error');
});

test('disconnect removes the connection', async () => {
  const api = makeApi({ connections: [CONNECTION] });
  await mountTicketsSettings(root, { api });
  card().querySelector('.tickets-disconnect').click();
  await flush();
  await flush();
  expect(api.issueTrackers.disconnect).toHaveBeenCalledWith('fake-abc');
  expect(card().querySelector('.tickets-connection')).toBeNull();
});

test('test reports whether the stored key still works', async () => {
  const api = makeApi({ connections: [CONNECTION] });
  await mountTicketsSettings(root, { api });
  card().querySelector('.tickets-test').click();
  await flush();
  expect(api.issueTrackers.test).toHaveBeenCalledWith('fake-abc');
  expect(status().textContent).toBe(t('tickets.settings.testOk'));

  api.issueTrackers.test.mockResolvedValueOnce({ ok: false, code: 'AUTH', error: 'x' });
  card().querySelector('.tickets-test').click();
  await flush();
  expect(status().textContent).toBe(t('tickets.settings.errorAuth'));
});

test('the help link opens the provider page outside the app', async () => {
  const api = makeApi();
  await mountTicketsSettings(root, { api });
  card().querySelector('.tickets-help-link').click();
  expect(api.dialog.openExternal).toHaveBeenCalledWith('https://example.com/settings/tokens');
});

test('names from the network are escaped', async () => {
  const hostile = {
    ...CONNECTION,
    workspace: { ...CONNECTION.workspace, name: '<img src=x onerror="window.pwned=1">' },
    user: { ...CONNECTION.user, name: '<b>Ada</b>' },
  };
  await mountTicketsSettings(root, { api: makeApi({ connections: [hostile] }) });
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelector('b')).toBeNull();
  expect(card().querySelector('.tickets-connection-workspace').textContent).toBe(hostile.workspace.name);
});

test('a connection whose tracker is gone can still be removed', async () => {
  const orphan = { ...CONNECTION, id: 'jira-1', provider: 'jira', providerName: 'jira', available: false };
  await mountTicketsSettings(root, { api: makeApi({ connections: [orphan] }) });
  const cards = root.querySelectorAll('.tickets-provider');
  expect(cards).toHaveLength(2);
  expect(cards[1].querySelector('.tickets-test')).toBeNull();
  expect(cards[1].querySelector('.tickets-disconnect')).not.toBeNull();
});

test('a load failure is said, not swallowed', async () => {
  const api = makeApi();
  api.issueTrackers.connections.mockResolvedValueOnce({ ok: false, error: 'Refusing to modify issue-trackers.json' });
  await mountTicketsSettings(root, { api });
  expect(root.textContent).toContain('Refusing to modify issue-trackers.json');
});
