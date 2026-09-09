/**
 * accounts-usage IPC handler.
 *
 * The settings list shows every account's remaining headroom, so the handler
 * has to answer for all of them at once — without turning a rename into one
 * credential-store probe per account, which prompts for the Keychain on macOS.
 */

const mockAccountManager = {
  listAccounts: jest.fn(),
  ensureAccountStore: jest.fn(),
  switchTo: jest.fn(),
  setDefault: jest.fn(),
  captureCurrent: jest.fn(),
  updateAccount: jest.fn(),
  renameAccount: jest.fn(),
  removeAccount: jest.fn(),
  syncActiveFromDisk: jest.fn()
};

const mockUsageService = {
  usageForAccount: jest.fn(),
  invalidateCredentials: jest.fn(),
  refreshUsage: jest.fn(() => Promise.resolve(null))
};

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}));

jest.mock('../../src/main/services/AccountManager', () => mockAccountManager);
jest.mock('../../src/main/services/UsageService', () => mockUsageService);

const { ipcMain } = require('electron');

/**
 * Register the handlers against a freshly evaluated module.
 *
 * The handler remembers which credential stores it has bootstrapped, for the
 * life of the process. Sharing one instance between tests would make each test
 * inherit the previous one's bookkeeping.
 */
function loadHandlers() {
  const handlers = {};
  jest.isolateModules(() => {
    ipcMain.handle.mockImplementation((channel, handler) => { handlers[channel] = handler; });
    require('../../src/main/ipc/accounts.ipc').registerAccountsHandlers();
  });
  return handlers;
}

let handlers;

beforeEach(() => {
  handlers = loadHandlers();
  mockAccountManager.listAccounts.mockReset();
  mockAccountManager.ensureAccountStore.mockReset();
  mockUsageService.usageForAccount.mockReset();

  mockAccountManager.listAccounts.mockResolvedValue({
    accounts: [{ id: 'acct-max', name: 'Max' }, { id: 'acct-team', name: 'Team' }],
    defaultId: 'acct-max',
    liveId: 'acct-max',
    hasCredentials: true
  });
  mockAccountManager.ensureAccountStore.mockResolvedValue('/tmp/store');
  mockUsageService.usageForAccount.mockImplementation(async (id) => ({
    accountId: id,
    data: { buckets: [{ id: 'session', utilization: 12 }] },
    stale: false,
    error: null
  }));
});

describe('accounts-usage', () => {
  test('answers with one entry per account, keyed by id', async () => {
    const res = await handlers['accounts-usage']({}, {});

    expect(res.success).toBe(true);
    expect(Object.keys(res.data).sort()).toEqual(['acct-max', 'acct-team']);
    expect(res.data['acct-team'].accountId).toBe('acct-team');
  });

  test('passes the requested max age through, so refresh can force a fetch', async () => {
    await handlers['accounts-usage']({}, { maxAgeMs: 0 });

    expect(mockUsageService.usageForAccount).toHaveBeenCalledWith('acct-max', 0, false);
  });

  test('the explicit refresh forces every account, not just the focused one', async () => {
    await handlers['accounts-usage']({}, { maxAgeMs: 0, force: true });

    // Without force the fetch trusts the cached token, so an account signed in
    // again outside the app keeps reporting itself signed out.
    expect(mockUsageService.usageForAccount).toHaveBeenCalledWith('acct-max', 0, true);
    expect(mockUsageService.usageForAccount).toHaveBeenCalledWith('acct-team', 0, true);
  });

  test('the explicit refresh re-seeds stores the once-per-run bound had skipped', async () => {
    await handlers['accounts-usage']({}, {});
    mockAccountManager.ensureAccountStore.mockClear();

    await handlers['accounts-usage']({}, { maxAgeMs: 0, force: true });

    expect(mockAccountManager.ensureAccountStore).toHaveBeenCalledTimes(2);
  });

  test('an account whose fetch throws does not blank the others', async () => {
    mockUsageService.usageForAccount.mockImplementation(async (id) => {
      if (id === 'acct-team') throw new Error('keychain denied');
      return { accountId: id, data: { buckets: [] }, stale: false, error: null };
    });

    const res = await handlers['accounts-usage']({}, { maxAgeMs: 0, force: true });

    expect(res.success).toBe(true);
    expect(res.data['acct-max']).toBeTruthy();
    expect(res.data['acct-team'].error).toBe('keychain denied');
  });

  test('bootstraps each credential store once, not on every call', async () => {
    await handlers['accounts-usage']({}, {});
    await handlers['accounts-usage']({}, {});

    // Probing a store costs a Keychain read; the list asks again on every
    // account change, so a second sweep must not re-probe what is already set.
    expect(mockAccountManager.ensureAccountStore).toHaveBeenCalledTimes(2);
  });

  test('a store that cannot be seeded still reports that account', async () => {
    mockAccountManager.ensureAccountStore.mockRejectedValue(new Error('keychain denied'));

    const res = await handlers['accounts-usage']({}, {});

    // Falling over here would blank every account's figures over one that has
    // no store — the others are readable and must still come back.
    expect(res.success).toBe(true);
    expect(Object.keys(res.data)).toHaveLength(2);
  });

  test('an account whose figures are unreadable comes back unreadable, not missing', async () => {
    mockUsageService.usageForAccount.mockImplementation(async (id) => (
      id === 'acct-team'
        ? { accountId: id, data: null, stale: true, error: 'No valid Claude OAuth token' }
        : { accountId: id, data: { buckets: [] }, stale: false, error: null }
    ));

    const res = await handlers['accounts-usage']({}, {});

    // The renderer needs the entry to say "sign in again" — an absent key is
    // indistinguishable from figures that have not arrived yet.
    expect(res.data['acct-team'].error).toBeTruthy();
    expect(res.data['acct-team'].data).toBeNull();
  });
});
