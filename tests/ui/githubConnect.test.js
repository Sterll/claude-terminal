/**
 * Connecting GitHub where it is missing, rather than in Settings: one modal
 * (the Device Flow, else the token form when GitHub refuses to start one), and
 * in each view that needs GitHub one line saying so, with the button, labelled
 * "Reconnect" when the saved login was refused.
 */
jest.mock('../../src/renderer/ui/components/Toast', () => ({ showSuccess: jest.fn(), showToast: jest.fn() }));

const { connectGitHub, onGitHubAuthChanged } = require('../../src/renderer/ui/components/GitHubConnectModal');
const { createGitTab, gitTabHtml, sessionHtml } = require('../../src/renderer/ui/components/chat/gitTab');
const { githubConnectNoticeHtml, githubAuthFailure } = require('../../src/renderer/services/GitTabService');
const Brief = require('../../src/renderer/services/dashboard/briefing');
const Toast = require('../../src/renderer/ui/components/Toast');

const flush = () => new Promise(r => setTimeout(r, 0));
const modal = () => document.getElementById('github-connect-modal');

function mockGitHub(over = {}) {
  const github = {
    startAuth: jest.fn(async () => ({ success: true, device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5 })),
    pollToken: jest.fn(() => new Promise(() => {})),
    cancelAuth: jest.fn(async () => ({ success: true })),
    openAuthUrl: jest.fn(async () => ({ success: true })),
    setToken: jest.fn(async () => ({ success: true, authenticated: true, login: 'octo' })),
    authStatus: jest.fn(async () => ({ success: true, authenticated: true, login: 'octo' })),
    ...over,
  };
  return { github, app: { clipboardWrite: jest.fn(async () => {}) } };
}

afterEach(() => {
  document.body.innerHTML = '';
  Toast.showSuccess.mockClear();
  Toast.showToast.mockClear();
});

describe('connectGitHub', () => {
  test('the Device Flow: the code on screen, copied and GitHub opened, then connected and announced', async () => {
    let authorize;
    const api = mockGitHub({ pollToken: jest.fn(() => new Promise((r) => { authorize = r; })) });
    const heard = jest.fn();
    const off = onGitHubAuthChanged(heard);

    const pending = connectGitHub({ api });
    await flush();
    expect(modal().querySelector('.device-code').textContent).toBe('ABCD-1234');
    modal().querySelector('[data-github="open"]').click();
    await flush();
    expect(api.app.clipboardWrite).toHaveBeenCalledWith('ABCD-1234');
    expect(api.github.openAuthUrl).toHaveBeenCalledWith('https://github.com/login/device');
    expect(api.github.pollToken).toHaveBeenCalledWith({ deviceCode: 'dev', interval: 5 });

    authorize({ success: true });
    await expect(pending).resolves.toMatchObject({ authenticated: true, login: 'octo' });
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ login: 'octo' }));
    expect(Toast.showSuccess).toHaveBeenCalled();
    off();
  });

  test('closing it gives up and stops main from polling', async () => {
    const api = mockGitHub();
    const pending = connectGitHub({ api });
    await flush();
    modal().querySelector('[data-action="cancel"]').click();
    await expect(pending).resolves.toBeNull();
    expect(api.github.cancelAuth).toHaveBeenCalled();
  });

  test('when GitHub will not start a Device Flow, the token form: a refused token is said, a good one connects', async () => {
    const api = mockGitHub({
      startAuth: jest.fn(async () => ({ success: false, error: 'Not Found' })),
      setToken: jest.fn()
        .mockResolvedValueOnce({ success: true, authenticated: false })
        .mockResolvedValueOnce({ success: true, authenticated: true, login: 'octo' }),
    });
    const pending = connectGitHub({ api, reconnect: true });
    await flush();
    expect(modal().querySelector('.modal-header h3').textContent).toBe('Reconnect GitHub');
    const input = modal().querySelector('.github-token-input');
    input.value = 'ghp_bad';
    modal().querySelector('[data-github="token-submit"]').click();
    await flush();
    expect(modal().querySelector('.github-error').hidden).toBe(false);
    expect(input.value).toBe(''); // the token leaves the field whatever the answer

    input.value = 'ghp_good';
    modal().querySelector('[data-github="token-submit"]').click();
    await expect(pending).resolves.toMatchObject({ login: 'octo' });
    expect(api.github.setToken).toHaveBeenLastCalledWith('ghp_good');
  });

  test('two views asking at once share one modal', async () => {
    const api = mockGitHub();
    const a = connectGitHub({ api });
    const b = connectGitHub({ api });
    expect(a).toBe(b);
    await flush();
    expect(document.querySelectorAll('#github-connect-modal')).toHaveLength(1);
    modal().querySelector('[data-action="cancel"]').click();
    await a;
  });
});

describe("the chat's Git tab", () => {
  const branch = (pr) => ({ isRepo: true, root: '/repo', branch: 'feat/x', upstream: 'origin/feat/x', remote: 'origin', ahead: 0, behind: 0, base: 'origin/main', onBase: false, dirty: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, commits: [], pr });

  test('a refused login says so and offers Reconnect, a missing one Connect', () => {
    document.body.innerHTML = gitTabHtml(branch({ authenticated: false, expired: true, createUrl: 'https://x' }), { sessionStartedAt: 0 });
    let btn = document.querySelector('[data-action="connect-github"]');
    expect(btn.textContent).toBe('Reconnect GitHub');
    expect(btn.dataset.expired).toBe('true');
    expect(document.body.textContent).toContain('expired or revoked');

    document.body.innerHTML = gitTabHtml(branch({ authenticated: false, createUrl: 'https://x' }), { sessionStartedAt: 0 });
    btn = document.querySelector('[data-action="connect-github"]');
    expect(btn.textContent).toBe('Connect GitHub');
  });

  test('the session list says it once, Reconnect if any lookup was refused', () => {
    document.body.innerHTML = sessionHtml({ mode: 'session', isRepo: true, workspaces: [], createdPrs: [{ authenticated: false }, { authenticated: false, expired: true }] });
    expect(document.querySelectorAll('[data-action="connect-github"]')).toHaveLength(1);
    expect(document.querySelector('[data-action="connect-github"]').textContent).toBe('Reconnect GitHub');
  });

  test('the button signs in on the spot and reads again; a sign-in elsewhere reads again too', async () => {
    document.body.innerHTML = '<div class="panel"></div>';
    const panelEl = document.querySelector('.panel');
    const api = { git: { sessionSummary: jest.fn(async () => branch({ authenticated: false, expired: true, createUrl: 'https://x' })) }, dialog: { openExternal: jest.fn() } };
    const connect = jest.fn(async () => ({ authenticated: true, login: 'octo' }));
    const tab = createGitTab({ api, panelEl, getCwd: () => '/repo', sessionStartedAt: 0, onAvailable: jest.fn(), openGitScreen: jest.fn(), showToast: jest.fn(), connectGitHub: connect });
    await tab.probe();
    tab.show();
    await flush();
    const reads = api.git.sessionSummary.mock.calls.length;

    panelEl.querySelector('[data-action="connect-github"]').click();
    await flush();
    expect(connect).toHaveBeenCalledWith({ reconnect: true });
    expect(api.git.sessionSummary.mock.calls.length).toBe(reads + 1);

    window.dispatchEvent(new CustomEvent('ct-github-auth-changed', { detail: { authenticated: true } }));
    await flush();
    expect(api.git.sessionSummary.mock.calls.length).toBe(reads + 2);

    tab.destroy();
    window.dispatchEvent(new CustomEvent('ct-github-auth-changed', { detail: null }));
    await flush();
    expect(api.git.sessionSummary.mock.calls.length).toBe(reads + 2);
  });
});

describe('the Git panel', () => {
  test('pull requests and issues without GitHub: the sign-in line instead of a form and "No pull requests"', () => {
    expect(githubConnectNoticeHtml({ success: true, authenticated: false, pullRequests: [] }, 'prs')).toContain('Connect GitHub to see and create');
    expect(githubConnectNoticeHtml({ success: true, authenticated: false, expired: true, issues: [] }, 'issues')).toContain('Reconnect GitHub');
    expect(githubConnectNoticeHtml({ success: true, authenticated: true, pullRequests: [] }, 'prs')).toBe('');
    // Not a GitHub remote at all, or nothing read yet: nothing to connect.
    expect(githubConnectNoticeHtml({ success: false, error: 'Not a GitHub repository' }, 'prs')).toBe('');
    expect(githubConnectNoticeHtml(null, 'prs')).toBe('');
  });

  test('a write refused for want of a login: one toast with the button, not "Bad credentials"', () => {
    expect(githubAuthFailure({ success: false, error: 'Bad credentials', code: 'GITHUB_TOKEN_EXPIRED' })).toBe(true);
    expect(Toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', action: 'Reconnect GitHub' }));
    expect(githubAuthFailure({ success: false, error: 'Validation Failed' })).toBe(false);
    expect(Toast.showToast).toHaveBeenCalledTimes(1);
  });
});

describe('the dashboard briefing', () => {
  const runs = { success: true, authenticated: false, runs: [] };
  const prs = { success: true, authenticated: false, pullRequests: [] };

  test('one line to connect GitHub, with its button, instead of an empty "all clear"', () => {
    const items = Brief.todoItems({ gitInfo: {}, workflowRuns: runs, pullRequests: prs });
    expect(items.filter(i => i.connectGitHub)).toHaveLength(1);
    document.body.innerHTML = Brief.buildTodoHtml(items);
    expect(document.querySelector('.dash-todo-item [data-action="connect-github"]').textContent).toBe('Connect GitHub');

    const expired = Brief.todoItems({ gitInfo: {}, workflowRuns: { ...runs, expired: true }, pullRequests: prs });
    expect(expired[0]).toMatchObject({ connectGitHub: true, expired: true });
  });

  test('the CI card says GitHub is not connected rather than "No CI"', () => {
    expect(Brief.ciMetric(runs, prs)).toMatchObject({ value: '-', label: 'GitHub not connected' });
    expect(Brief.ciMetric({ runs: [], authenticated: true }, { pullRequests: [], authenticated: true }).label).not.toBe('GitHub not connected');
  });

  test('a project not on GitHub asks for nothing', () => {
    const items = Brief.todoItems({ gitInfo: {}, workflowRuns: { runs: [], notGitHub: true }, pullRequests: { pullRequests: [], notGitHub: true } });
    expect(items.some(i => i.connectGitHub)).toBe(false);
  });
});

describe('Settings, GitHub account card', () => {
  test('nothing GitHub sends back is put in the page unescaped', () => {
    // The display name is free text on GitHub: "<img src=x>" as a name used
    // to render as an image in Settings.
    const source = require('fs').readFileSync(require('path').join(__dirname, '../../src/renderer/ui/panels/SettingsPanel.js'), 'utf8');
    const raw = source.match(/\$\{githubStatus\.(name|login|avatar_url)[^}]*\}/g) || [];
    expect(raw).toEqual([]);
  });
});
