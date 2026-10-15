/**
 * The "Connect an account" modal: the front end of `claude auth login`.
 *
 * Main runs the CLI and reports the URL and refused codes as progress events;
 * the modal shows the link, forwards the code, and must stop the CLI when the
 * user walks away, or it keeps listening for a redirect nobody will send.
 */
jest.mock('../../src/renderer/ui/components/Toast', () => ({ showSuccess: jest.fn() }));

const { showSuccess } = require('../../src/renderer/ui/components/Toast');
const { showAccountLoginModal } = require('../../src/renderer/ui/components/AccountLoginModal');

const LOGIN_URL = 'https://claude.ai/oauth/authorize?code=true&state=abc';
const flush = () => new Promise(r => setTimeout(r, 0));

let progress;
let finishLogin;

function mockApi() {
  progress = null;
  const api = {
    login: jest.fn(() => new Promise((resolve) => { finishLogin = resolve; })),
    loginCode: jest.fn(async () => ({ success: true, data: true })),
    loginCancel: jest.fn(async () => ({ success: true })),
    onLoginProgress: jest.fn((cb) => { progress = cb; return jest.fn(); }),
  };
  window.electron_api = {
    ...window.electron_api,
    accounts: api,
    dialog: { openExternal: jest.fn() },
    app: { clipboardWrite: jest.fn(async () => {}) },
  };
  return api;
}

function open() {
  const pending = showAccountLoginModal();
  const modal = document.getElementById('account-login-modal');
  const $ = (sel) => modal.querySelector(sel);
  return { pending, modal, $ };
}

afterEach(() => {
  document.body.innerHTML = '';
  showSuccess.mockClear();
});

describe('account login modal', () => {
  test('nothing starts until the user asks to sign in', () => {
    const api = mockApi();
    open();
    expect(api.login).not.toHaveBeenCalled();
  });

  test('signs in under the typed name, shows the link and forwards the code', async () => {
    const api = mockApi();
    const { pending, $ } = open();
    $('#account-login-name').value = '  Work  ';
    $('[data-action="start"]').click();
    expect(api.login).toHaveBeenCalledWith('Work');
    expect($('.account-login-link').hidden).toBe(true);

    progress({ type: 'url', url: LOGIN_URL });
    expect($('.account-login-link').hidden).toBe(false);
    expect($('.account-login-url').value).toBe(LOGIN_URL);

    $('[data-login="open"]').click();
    expect(window.electron_api.dialog.openExternal).toHaveBeenCalledWith(LOGIN_URL);

    $('#account-login-code').value = ' code#state ';
    $('[data-login="submit"]').click();
    expect(api.loginCode).toHaveBeenCalledWith('code#state');

    finishLogin({ success: true, data: { id: 'acc-1', name: 'Work' } });
    await expect(pending).resolves.toEqual({ id: 'acc-1', name: 'Work' });
    expect(showSuccess).toHaveBeenCalled();
    expect(api.loginCancel).not.toHaveBeenCalled();
  });

  test('a refused code says so and lets the user paste again', async () => {
    mockApi();
    const { $ } = open();
    $('[data-action="start"]').click();
    progress({ type: 'url', url: LOGIN_URL });
    $('#account-login-code').value = 'half-a-code';
    $('[data-login="submit"]').click();
    expect($('[data-login="submit"]').disabled).toBe(true);

    progress({ type: 'invalid-code' });
    expect($('[data-login="submit"]').disabled).toBe(false);
    expect($('.account-login-error').hidden).toBe(false);
  });

  test('a failed sign-in shows why and allows another attempt', async () => {
    const api = mockApi();
    const { $ } = open();
    $('[data-action="start"]').click();
    progress({ type: 'url', url: LOGIN_URL });
    finishLogin({ success: false, error: 'Login failed: Token exchange failed', code: 'LOGIN_FAILED' });
    await flush();

    expect($('.account-login-error').textContent).toBe('Login failed: Token exchange failed');
    expect($('.account-login-link').hidden).toBe(true);
    expect($('[data-action="start"]').disabled).toBe(false);
    $('[data-action="start"]').click();
    expect(api.login).toHaveBeenCalledTimes(2);
  });

  test('closing the modal mid sign-in stops the CLI', async () => {
    const api = mockApi();
    const { pending, $ } = open();
    $('[data-action="start"]').click();
    $('[data-action="cancel"]').click();
    expect(api.loginCancel).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBeNull();
  });

  test('closing it before signing in has nothing to stop', async () => {
    const api = mockApi();
    const { pending, $ } = open();
    $('[data-action="cancel"]').click();
    await expect(pending).resolves.toBeNull();
    expect(api.loginCancel).not.toHaveBeenCalled();
  });
});
