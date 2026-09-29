/**
 * The switch offer a usage limit opens in a chat tab.
 *
 * It used to list accounts by name only, so the user picked the next one
 * blind and could land on an account that was spent as well. The account that
 * had run out was the one row that could not be picked, and it wore the
 * accent, so it read as the selected one.
 */
jest.mock('../../src/renderer/state/projects.state', () => ({
  setProjectAccount: jest.fn(),
}));

const { setProjectAccount } = require('../../src/renderer/state/projects.state');
const { showAccountSwitchModal } = require('../../src/renderer/ui/components/AccountSwitchModal');

const h = 3600000;
const at = (ms) => new Date(Date.now() + ms).toISOString();
const session = (utilization, resetsAt = at(2 * h)) =>
  ({ id: 'session', type: 'session', labelKey: 'ui.session', label: null, utilization, resetsAt });
const weekly = (utilization, resetsAt = at(72 * h)) =>
  ({ id: 'weekly', type: 'weekly', labelKey: 'ui.weekly', label: null, utilization, resetsAt });
const scoped = (label, utilization, resetsAt = at(48 * h)) =>
  ({ id: `scoped:${label}`, type: 'scoped', label, labelKey: null, utilization, resetsAt });
const figures = (id, ...buckets) => ({ accountId: id, data: { buckets }, stale: false, error: null });

const ACCOUNTS = [
  { id: 'acc-a', name: 'Personal', fingerprint: 'aaaaaaaa11', color: '#3b82f6' },
  { id: 'acc-b', name: 'Work', fingerprint: 'bbbbbbbb22', color: null },
  { id: 'acc-c', name: 'Team', fingerprint: 'cccccccc33', color: '#22c55e' },
];

const flush = () => new Promise(r => setTimeout(r, 0));

let resolveUsage;

function mockApi({ accounts = ACCOUNTS } = {}) {
  const usage = jest.fn(() => new Promise((resolve) => { resolveUsage = resolve; }));
  window.electron_api = {
    ...window.electron_api,
    accounts: {
      list: jest.fn(async () => ({ success: true, data: { accounts, defaultId: 'acc-a', liveId: 'acc-a' } })),
      usage,
      setDefault: jest.fn(async () => ({ success: true })),
      capture: jest.fn(),
    },
  };
  return usage;
}

async function open(opts = {}) {
  const pending = showAccountSwitchModal({ activeAccountId: 'acc-a', projectId: 'p1', projectName: 'Demo', ...opts });
  await flush();
  const modal = document.getElementById('account-switch-modal');
  const row = (id) => modal.querySelector(`.account-row[data-id="${id}"]`);
  return { pending, modal, row };
}

async function arrive(map) {
  resolveUsage({ success: true, data: map });
  await flush();
}

afterEach(() => {
  document.body.innerHTML = '';
  setProjectAccount.mockClear();
});

describe('account switch offer', () => {
  test('the account that ran out is greyed out from the start, not dressed as selected', async () => {
    mockApi();
    const { row } = await open();
    expect(row('acc-a').disabled).toBe(true);
    expect(row('acc-a').classList.contains('unavailable')).toBe(true);
    expect(row('acc-a').classList.contains('active')).toBe(false);
  });

  test('the others stay pickable while their figures load, and say they are loading', async () => {
    const usage = mockApi();
    const { row } = await open();
    expect(usage).toHaveBeenCalledTimes(1);
    expect(row('acc-b').disabled).toBe(false);
    expect(row('acc-b').querySelector('.account-switch-usage').textContent).toContain('Reading usage');
  });

  test('the figures are asked for fresher than Settings asks, since a limit was just hit', async () => {
    const usage = mockApi();
    await open();
    expect(usage.mock.calls[0][0]).toBeLessThanOrEqual(60 * 1000);
  });

  test('each row shows its bars, and an account whose figures are full is greyed out too', async () => {
    mockApi();
    const { row } = await open();
    await arrive({
      'acc-a': figures('acc-a', session(100), weekly(40)),
      'acc-b': figures('acc-b', session(30), weekly(45)),
      'acc-c': figures('acc-c', session(12), weekly(100, at(3 * h))),
    });

    expect(row('acc-b').querySelectorAll('.usage-item')).toHaveLength(2);
    expect(row('acc-b').disabled).toBe(false);
    expect(row('acc-b').classList.contains('unavailable')).toBe(false);

    expect(row('acc-c').disabled).toBe(true);
    expect(row('acc-c').classList.contains('unavailable')).toBe(true);
    expect(row('acc-c').querySelector('.account-row-status').textContent).toBe('Limit reached');
    expect(row('acc-c').title).toMatch(/^Available again in 2h 5\dmin$/);
  });

  test('a limit scoped to another model does not rule an account out', async () => {
    mockApi();
    const { row } = await open({ model: 'claude-sonnet-5' });
    await arrive({ 'acc-b': figures('acc-b', session(10), weekly(10), scoped('Fable', 100)) });
    expect(row('acc-b').disabled).toBe(false);
  });

  test('a limit scoped to the conversation\'s model does', async () => {
    mockApi();
    const { row } = await open({ model: 'claude-fable-5-1' });
    await arrive({ 'acc-b': figures('acc-b', session(10), weekly(10), scoped('Fable', 100)) });
    expect(row('acc-b').disabled).toBe(true);
    expect(row('acc-b').classList.contains('unavailable')).toBe(true);
  });

  test('an account whose figures could not be read stays pickable and says why', async () => {
    mockApi();
    const { row } = await open();
    await arrive({ 'acc-b': { accountId: 'acc-b', data: null, stale: true, error: 'HTTP 401' } });
    expect(row('acc-b').disabled).toBe(false);
    expect(row('acc-b').querySelector('.account-usage-note').textContent).toContain('Usage unavailable');
  });

  test('a failed sweep clears the loading line rather than calling every account signed out', async () => {
    mockApi();
    const { row } = await open();
    resolveUsage({ success: false, error: 'boom' });
    await flush();
    expect(row('acc-b').querySelector('.account-switch-usage').textContent.trim()).toBe('');
    expect(row('acc-b').disabled).toBe(false);
  });

  test('with every account spent, it says when the first one comes back', async () => {
    mockApi();
    const { modal } = await open();
    await arrive({
      'acc-a': figures('acc-a', session(100, at(4 * h))),
      'acc-b': figures('acc-b', session(100, at(1 * h + 10 * 60000))),
      'acc-c': figures('acc-c', weekly(100, at(50 * h))),
    });
    const note = modal.querySelector('.account-switch-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toMatch(/available again in 1h \d\dmin\.$/);
  });

  test('no time is promised when the account that ran out shows no full bar', async () => {
    mockApi();
    const { modal } = await open();
    await arrive({
      'acc-a': figures('acc-a', session(60)),
      'acc-b': figures('acc-b', session(100)),
      'acc-c': figures('acc-c', weekly(100)),
    });
    const note = modal.querySelector('.account-switch-note');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('Every saved account has hit a limit.');
  });

  test('the note stays hidden while any account can still be picked', async () => {
    mockApi();
    const { modal } = await open();
    await arrive({ 'acc-b': figures('acc-b', session(100)) });
    expect(modal.querySelector('.account-switch-note').hidden).toBe(true);
  });

  test('picking an account re-binds this project and answers with its id', async () => {
    mockApi();
    const { pending, row } = await open();
    await arrive({ 'acc-b': figures('acc-b', session(30)) });
    row('acc-b').click();
    await expect(pending).resolves.toBe('acc-b');
    expect(setProjectAccount).toHaveBeenCalledWith('p1', 'acc-b');
  });

  test('figures that land after the offer was answered touch nothing', async () => {
    mockApi();
    const { pending, row } = await open();
    const bRow = row('acc-b');
    bRow.click();
    await expect(pending).resolves.toBe('acc-b');
    await arrive({ 'acc-b': figures('acc-b', session(100)) });
    expect(bRow.classList.contains('unavailable')).toBe(false);
  });
});
