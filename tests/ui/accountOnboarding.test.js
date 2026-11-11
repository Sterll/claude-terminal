/**
 * The first-launch prompt: a fresh profile on a machine with no Claude login
 * at all is offered to connect one, once, and the account it connects becomes
 * the default so a plain `claude` in a terminal tab is signed in too.
 */
jest.mock('../../src/renderer/ui/components/Toast', () => ({ showSuccess: jest.fn() }));

const { maybeShowAccountOnboarding } = require('../../src/renderer/ui/components/AccountLoginModal');

const flush = () => new Promise(r => setTimeout(r, 0));

let finishLogin;

function mockApi() {
  const api = {
    login: jest.fn(() => new Promise((resolve) => { finishLogin = resolve; })),
    loginCode: jest.fn(async () => ({ success: true })),
    loginCancel: jest.fn(async () => ({ success: true })),
    setDefault: jest.fn(async () => ({ success: true })),
    onLoginProgress: jest.fn(() => jest.fn()),
  };
  window.electron_api = {
    ...window.electron_api,
    accounts: api,
    dialog: { openExternal: jest.fn() },
    app: { clipboardWrite: jest.fn(async () => {}) },
  };
  return api;
}

function deps(accounts, { done = false, isFreshProfile = true } = {}) {
  const settings = { accountOnboardingDone: done };
  return {
    settings,
    accountsState: { get: () => ({ loaded: true, accounts: [], hasCredentials: false, ...accounts }) },
    getSetting: (k) => settings[k],
    setSetting: jest.fn((k, v) => { settings[k] = v; }),
    isFreshProfile,
  };
}

const modal = () => document.getElementById('account-login-modal');

afterEach(() => { document.body.innerHTML = ''; });

describe('account onboarding', () => {
  test('a fresh profile with no login is asked, and the new account becomes the default', async () => {
    const api = mockApi();
    const d = deps({});
    const pending = maybeShowAccountOnboarding(d);
    await flush();
    expect(modal()).not.toBeNull();
    expect(d.settings.accountOnboardingDone).toBe(true);
    expect(modal().querySelector('[data-action="cancel"]').textContent.trim()).toBe('Later');

    modal().querySelector('[data-action="start"]').click();
    finishLogin({ success: true, data: { id: 'acc-1', name: 'me@example.com' } });
    await expect(pending).resolves.toEqual({ id: 'acc-1', name: 'me@example.com' });
    expect(api.setDefault).toHaveBeenCalledWith('acc-1');
  });

  test('"Later" closes it without making anything the default, and it is not asked again', async () => {
    const api = mockApi();
    const d = deps({});
    const pending = maybeShowAccountOnboarding(d);
    await flush();
    modal().querySelector('[data-action="cancel"]').click();
    await expect(pending).resolves.toBeNull();
    expect(api.setDefault).not.toHaveBeenCalled();

    await expect(maybeShowAccountOnboarding(d)).resolves.toBeNull();
    // One modal opened in all: each one subscribes to the login progress.
    expect(api.onLoginProgress).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a machine-wide login', { hasCredentials: true }, {}],
    ['a saved account', { accounts: [{ id: 'a' }] }, {}],
    ['a profile that already has projects', {}, { isFreshProfile: false }],
  ])('%s is never asked, and is marked done', async (_label, accounts, opts) => {
    mockApi();
    const d = deps(accounts, opts);
    await expect(maybeShowAccountOnboarding(d)).resolves.toBeNull();
    expect(modal()).toBeNull();
    expect(d.settings.accountOnboardingDone).toBe(true);
  });

  test('an account list that could not be read asks again next launch', async () => {
    mockApi();
    const d = deps({ loaded: false });
    await maybeShowAccountOnboarding(d);
    expect(modal()).toBeNull();
    expect(d.setSetting).not.toHaveBeenCalled();
  });
});
