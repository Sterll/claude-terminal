/**
 * Getting a lost login back from where it is noticed: the chat's Reconnect
 * button (reconnectForConversation) and the startup warning about signed-out
 * accounts (warnSignedOutAccounts).
 */
jest.mock('../../src/renderer/ui/components/Toast', () => ({ showSuccess: jest.fn(), showToast: jest.fn() }));

const {
  reconnectForConversation,
  warnSignedOutAccounts,
} = require('../../src/renderer/ui/components/AccountLoginModal');

const flush = () => new Promise(r => setTimeout(r, 0));
const WORK = { id: 'work', name: 'Work' };
const PERSO = { id: 'perso', name: 'Perso' };

let finishLogin;

function mockApi(extra = {}) {
  const api = {
    login: jest.fn(() => new Promise((resolve) => { finishLogin = resolve; })),
    reconnect: jest.fn(() => new Promise((resolve) => { finishLogin = resolve; })),
    loginCode: jest.fn(async () => ({ success: true })),
    loginCancel: jest.fn(async () => ({ success: true })),
    setDefault: jest.fn(async () => ({ success: true })),
    onLoginProgress: jest.fn(() => jest.fn()),
    ...extra,
  };
  window.electron_api = {
    ...window.electron_api,
    accounts: api,
    dialog: { openExternal: jest.fn() },
    app: { clipboardWrite: jest.fn(async () => {}) },
  };
  return api;
}

function fakeState({ accounts = [WORK, PERSO], liveId = null, defaultId = null } = {}) {
  const byId = new Map(accounts.map(a => [a.id, a]));
  return {
    getAccount: (id) => byId.get(id) || null,
    getAccounts: () => accounts,
    getUsageAccountForProject: () => ({ account: byId.get(liveId) || byId.get(defaultId) || null, isDefault: true }),
    accountsState: { get: () => ({ accounts, liveId, defaultId }) },
  };
}

const modal = () => document.getElementById('account-login-modal');
const start = () => modal().querySelector('[data-action="start"]').click();

afterEach(() => { document.body.innerHTML = ''; });

describe('reconnecting from a conversation', () => {
  test('a conversation bound to an account reconnects that account, and leaves the default alone', async () => {
    const api = mockApi();
    const pending = reconnectForConversation({ accountId: 'work', state: fakeState({ liveId: 'perso' }) });
    await flush();
    expect(modal().textContent).toContain('Work');
    start();
    expect(api.reconnect).toHaveBeenCalledWith('work');
    finishLogin({ success: true, data: WORK });
    await expect(pending).resolves.toEqual(WORK);
    expect(api.setDefault).not.toHaveBeenCalled();
  });

  test('an unbound one reconnects the account holding the machine-wide login and writes it back there', async () => {
    const api = mockApi();
    const pending = reconnectForConversation({ accountId: null, projectId: 'p1', state: fakeState({ liveId: 'perso', defaultId: 'work' }) });
    await flush();
    start();
    expect(api.reconnect).toHaveBeenCalledWith('perso');
    finishLogin({ success: true, data: PERSO });
    await pending;
    expect(api.setDefault).toHaveBeenCalledWith('perso');
  });

  test('with no saved account it signs a new one in and makes it the default', async () => {
    const api = mockApi();
    const pending = reconnectForConversation({ accountId: null, state: fakeState({ accounts: [] }) });
    await flush();
    start();
    expect(api.login).toHaveBeenCalled();
    finishLogin({ success: true, data: { id: 'new', name: 'me@example.com' } });
    await pending;
    expect(api.setDefault).toHaveBeenCalledWith('new');
  });

  test('giving up changes nothing', async () => {
    const api = mockApi();
    const pending = reconnectForConversation({ accountId: null, state: fakeState({ liveId: 'perso' }) });
    await flush();
    modal().querySelector('[data-action="cancel"]').click();
    await expect(pending).resolves.toBeNull();
    expect(api.setDefault).not.toHaveBeenCalled();
  });
});

describe('the startup warning about signed-out accounts', () => {
  test('warns about the accounts something runs on, each with its Reconnect button', async () => {
    const spare = { id: 'spare', name: 'Spare' };
    const bound = { id: 'bound', name: 'Bound' };
    mockApi({
      usage: jest.fn(async () => ({
        success: true,
        data: {
          work: { signedOut: true },
          spare: { signedOut: true },
          bound: { signedOut: true },
          perso: { signedOut: false },
        },
      })),
    });
    const toast = jest.fn();
    const reported = await warnSignedOutAccounts({
      state: fakeState({ accounts: [WORK, PERSO, spare, bound], defaultId: 'work', liveId: 'perso' }),
      getProjectsForAccount: (id) => (id === 'bound' ? [{ id: 'p1' }] : []),
      toast,
    });
    expect(reported.map(a => a.id)).toEqual(['work', 'bound']);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast.mock.calls[0][0]).toMatchObject({ type: 'warning', action: 'Reconnect', duration: 0 });
    expect(toast.mock.calls[0][0].title).toContain('Work');

    toast.mock.calls[0][0].onAction();
    await flush();
    expect(modal()).not.toBeNull();
  });

  test('says nothing when every account answers, or when there is none', async () => {
    const usage = jest.fn(async () => ({ success: true, data: { work: { signedOut: false } } }));
    mockApi({ usage });
    const toast = jest.fn();
    await warnSignedOutAccounts({ state: fakeState({ accounts: [WORK], defaultId: 'work' }), getProjectsForAccount: () => [], toast });
    await warnSignedOutAccounts({ state: fakeState({ accounts: [] }), getProjectsForAccount: () => [], toast });
    expect(toast).not.toHaveBeenCalled();
    expect(usage).toHaveBeenCalledTimes(1);
  });

  test('a failed usage sweep says nothing about anyone', async () => {
    mockApi({ usage: jest.fn(async () => ({ success: false, error: 'boom' })) });
    const toast = jest.fn();
    const reported = await warnSignedOutAccounts({ state: fakeState({ defaultId: 'work' }), getProjectsForAccount: () => [], toast });
    expect(reported).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });
});
