/**
 * The Git changes panel of a remote (SSH) project whose host is away
 * (design/remote-ssh.md section 6).
 *
 * "Not a git repository" would be a lie there: the repository is fine, the
 * connection is not. The panel shows a "reconnecting to <host>" banner when
 * git answers with reason 'disconnected', or straight away when the host is
 * already known to be reconnecting, and loads the changes on its own once the
 * host is connected again. A local project's panel is unchanged.
 */

jest.mock('../../src/renderer/ui/components/Modal', () => ({
  createModal: jest.fn(), showModal: jest.fn(), closeModal: jest.fn(),
}));

const { GitChangesPanel } = require('../../src/renderer/ui/panels/GitChangesPanel');
const { remoteHostsState, applyHostStatus, _resetForTests } = require('../../src/renderer/state/remoteHosts.state');

const PROFILE = { id: 'abcd1234', host: 'build.example.com', user: 'yanis', port: 22 };
const REMOTE = {
  id: 'r1', name: 'api', type: 'general', path: 'ssh-remote://abcd1234/home/yanis/api',
  remote: { profileId: 'abcd1234', path: '/home/yanis/api', hostLabel: 'yanis@build.example.com' },
};
const LOCAL = { id: 'l1', name: 'app', type: 'standalone', path: 'C:\\code\\app' };

const IDS = [
  'btn-close-changes', 'btn-commit-selected', 'btn-discard-selected', 'btn-generate-commit', 'btn-generate-pr',
  'btn-git-reset', 'btn-refresh-changes', 'btn-smart-commit', 'changes-count', 'commit-count', 'filter-btn-changes',
  'git-amend-checkbox', 'git-changes-list', 'git-changes-project', 'git-changes-stats', 'git-commit-message', 'git-select-all',
];

function mount() {
  document.body.innerHTML = `<div><div id="git-changes-panel" class="active"></div></div>${IDS.map((id) => {
    if (id === 'git-commit-message') return `<textarea id="${id}"></textarea>`;
    if (id === 'git-select-all' || id === 'git-amend-checkbox') return `<input type="checkbox" id="${id}">`;
    return `<div id="${id}"></div>`;
  }).join('')}`;
}

function makePanel(project, api) {
  return new GitChangesPanel(null, {
    api,
    showToast: jest.fn(),
    showGitToast: jest.fn(),
    getCurrentFilterProjectId: () => project.id,
    getProject: (id) => (id === project.id ? project : null),
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  _resetForTests();
  remoteHostsState.set({ profiles: [PROFILE], loaded: true, statuses: {} });
  mount();
});

describe('remote project', () => {
  test("reason 'disconnected' shows the reconnecting banner, not 'Not a git repository'", async () => {
    applyHostStatus({ profileId: 'abcd1234', state: 'connected' });
    const api = { git: {
      statusDetailed: jest.fn(async () => ({ success: false, error: 'The remote host is not connected', reason: 'disconnected' })),
      infoFull: jest.fn(async () => ({ isGitRepo: false, disconnected: true })),
    } };
    const panel = makePanel(REMOTE, api);
    await panel.loadGitChanges();
    const list = document.getElementById('git-changes-list');
    const banner = list.querySelector('.git-remote-banner');
    expect(banner).not.toBeNull();
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('yanis@build.example.com');
    expect(list.textContent).not.toMatch(/not a git repository/i);
  });

  test('a host already reconnecting gets the banner without asking it anything', async () => {
    applyHostStatus({ profileId: 'abcd1234', state: 'reconnecting' });
    const api = { git: { statusDetailed: jest.fn(), infoFull: jest.fn() } };
    const panel = makePanel(REMOTE, api);
    await panel.loadGitChanges();
    expect(document.querySelector('#git-changes-list .git-remote-banner')).not.toBeNull();
    expect(api.git.statusDetailed).not.toHaveBeenCalled();
  });

  test('a host that needs the user names its state instead of promising a reconnect', async () => {
    applyHostStatus({ profileId: 'abcd1234', state: 'authFailed' });
    const panel = makePanel(REMOTE, { git: { statusDetailed: jest.fn(), infoFull: jest.fn() } });
    await panel.loadGitChanges();
    const banner = document.querySelector('#git-changes-list .git-remote-banner');
    expect(banner.dataset.state).toBe('authFailed');
    expect(banner.querySelector('.ssh-state-dot.state-authFailed')).not.toBeNull();
  });

  test('the changes load on their own once the host is connected again', async () => {
    applyHostStatus({ profileId: 'abcd1234', state: 'reconnecting' });
    const api = { git: {
      statusDetailed: jest.fn(async () => ({ success: true, files: [{ path: 'src/a.js', status: 'M', staged: false, additions: 1, deletions: 0 }] })),
      infoFull: jest.fn(async () => ({ isGitRepo: true, stashes: [] })),
    } };
    const panel = makePanel(REMOTE, api);
    await panel.loadGitChanges();
    expect(api.git.statusDetailed).not.toHaveBeenCalled();

    applyHostStatus({ profileId: 'abcd1234', state: 'connected' });
    await flush();
    await flush();
    expect(api.git.statusDetailed).toHaveBeenCalledWith({ projectPath: REMOTE.path });
    const list = document.getElementById('git-changes-list');
    expect(list.querySelector('.git-remote-banner')).toBeNull();
    expect(list.innerHTML).toContain('src/a.js');
  });
});

describe('local project', () => {
  test('a failed status still reads as before, with no banner', async () => {
    const api = { git: {
      statusDetailed: jest.fn(async () => ({ success: false, error: 'Not a git repository' })),
      infoFull: jest.fn(async () => ({ isGitRepo: false })),
    } };
    const panel = makePanel(LOCAL, api);
    await panel.loadGitChanges();
    const list = document.getElementById('git-changes-list');
    expect(list.querySelector('.git-remote-banner')).toBeNull();
    expect(list.textContent).toContain('Not a git repository');
  });
});
