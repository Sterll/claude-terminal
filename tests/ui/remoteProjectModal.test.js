/**
 * Open Remote Project (design/remote-ssh.md sections 3 and 4.1), driven
 * through a mocked `window.electron_api.ssh`.
 *
 * The properties pinned here are the ones a compromised or careless renderer
 * could break: a saved profile carries no secret field, the browser never
 * shows anything but directories, every browse / clone call names the host by
 * profile id only, and the project it creates is the URI-shaped remote kind.
 */

const PROFILE = { id: 'abcd1234', label: 'Build', host: 'build.example.com', user: 'yanis', port: 22, forwardAgent: false, tmuxSessions: false };

const HOST_KEYS = ['host', 'user', 'port', 'sshConfigAlias', 'proxyJump', 'identityFile', 'hostLabel', 'destination'];

function makeApi({ profiles = [PROFILE] } = {}) {
  const progress = [];
  return {
    progress,
    ssh: {
      listProfiles: jest.fn(async () => ({ success: true, profiles, statuses: [] })),
      saveProfile: jest.fn(async (p) => ({ success: true, profile: { ...p, id: p.id || 'newid123', createdAt: 1 } })),
      deleteProfile: jest.fn(async () => ({ success: true })),
      testProfile: jest.fn(async () => ({ success: true, result: { ok: true, destination: 'yanis@build.example.com', capabilities: { claude: '/usr/bin/claude', claudeVersion: '2.1.280' } } })),
      pickIdentityFile: jest.fn(async () => ({ success: true, path: 'C:\\Users\\y\\.ssh\\id_ed25519' })),
      verifyHost: jest.fn(async () => ({ success: true, id: 7 })),
      connect: jest.fn(async (profileId) => ({ success: true, status: { profileId, state: 'connected', detail: null, retryAt: null, capabilities: null } })),
      disconnect: jest.fn(async (profileId) => ({ success: true, status: { profileId, state: 'idle' } })),
      networkOnline: jest.fn(),
      browse: jest.fn(async (profileId, dir) => ({
        success: true,
        path: dir || '/home/yanis',
        parent: '/home',
        truncated: false,
        // A file sneaking into the answer must not be listed.
        entries: [
          { name: 'api', type: 'directory' },
          { name: 'web', type: 'directory', symlink: true },
          { name: 'secrets.txt', type: 'file' },
        ],
      })),
      mkdir: jest.fn(async (profileId, p) => ({ success: true, path: p })),
      init: jest.fn(async () => ({ success: true, output: 'Initialized' })),
      clone: jest.fn(async (params) => ({ success: true, path: params.path })),
      onStatusChanged: jest.fn(() => () => {}),
    },
    operations: {
      cancel: jest.fn(),
      onProgress: jest.fn((cb) => { progress.push(cb); return () => {}; }),
    },
    terminal: { onExit: jest.fn(() => () => {}), onData: jest.fn(() => () => {}), input: jest.fn(), resize: jest.fn(), kill: jest.fn() },
  };
}

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

let api;
let Modal;
let projects;
let hosts;

beforeEach(async () => {
  jest.resetModules();
  document.body.innerHTML = '';
  api = makeApi();
  window.electron_api = { ...window.electron_api, ...api };
  projects = require('../../src/renderer/state/projects.state');
  hosts = require('../../src/renderer/state/remoteHosts.state');
  projects.projectsState.set({ projects: [], folders: [], rootOrder: [], selectedProjectFilter: null, openedProjectId: null, openProjectIds: [] });
  window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
  await hosts.loadRemoteHosts();
  Modal = require('../../src/renderer/ui/components/RemoteProjectModal');
});

afterEach(() => {
  hosts._resetForTests();
  document.body.innerHTML = '';
});

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const setValue = (sel, value) => { const el = $(sel); el.value = value; el.dispatchEvent(new Event('input')); };

describe('profile editor', () => {
  test('has no password or passphrase field anywhere', () => {
    Modal.openHostEditor({});
    expect($$('input[type="password"]')).toHaveLength(0);
    const fields = $$('[data-field]').map((el) => el.dataset.field);
    expect(fields.sort()).toEqual([...Modal.PROFILE_FIELDS].sort());
    expect(fields.join(' ')).not.toMatch(/pass|secret|key(?!s)/i);
  });

  // design/remote-ssh.md 5.1: the tmux garbage line through Windows OpenSSH is
  // fixed on the host, not by the app, so the hint is the whole fix and must
  // carry the exact line in every language.
  test('the tmux hint gives the escape-time line to add on the host', () => {
    Modal.openHostEditor({});
    const label = $('input[data-field="tmuxSessions"]').closest('label');
    expect(label.textContent).toContain('set -sg escape-time 100');
    for (const lang of ['en', 'fr', 'es', 'id', 'zh-CN', 'pt-BR']) {
      const hint = require(`../../src/renderer/i18n/locales/${lang}.json`).ssh.editor.tmuxSessionsHint;
      expect(hint).toContain('set -sg escape-time 100');
      expect(hint).toContain('~/.tmux.conf');
    }
  });

  test('save goes through IPC with the editor fields only', async () => {
    const onSaved = jest.fn();
    Modal.openHostEditor({ onSaved });
    setValue('[data-field="host"]', 'build.example.com');
    setValue('[data-field="user"]', 'yanis');
    setValue('[data-field="port"]', '2222');
    $('[data-action="pick-identity"]').click();
    await flush();
    $('[data-action="save"]').click();
    await flush();
    expect(api.ssh.saveProfile).toHaveBeenCalledTimes(1);
    const sent = api.ssh.saveProfile.mock.calls[0][0];
    expect(Object.keys(sent).every((k) => Modal.PROFILE_FIELDS.includes(k) || k === 'id')).toBe(true);
    expect(sent).toMatchObject({ host: 'build.example.com', user: 'yanis', port: 2222, identityFile: 'C:\\Users\\y\\.ssh\\id_ed25519', forwardAgent: false });
    expect(sent).not.toHaveProperty('password');
    expect(sent).not.toHaveProperty('passphrase');
    expect(onSaved).toHaveBeenCalled();
  });

  test('a host or an alias is required before anything is sent', async () => {
    Modal.openHostEditor({});
    $('[data-action="save"]').click();
    await flush();
    expect(api.ssh.saveProfile).not.toHaveBeenCalled();
    expect($('.ssh-editor-error').hidden).toBe(false);
  });

  test('a host synced from another machine is prefilled and saved under its id', async () => {
    Modal.openHostEditor({ prefill: { id: 'h7k2m9qa', hostLabel: 'yanis@build.example.com:2222' } });
    expect($('[data-field="host"]').value).toBe('build.example.com');
    expect($('[data-field="user"]').value).toBe('yanis');
    expect($('[data-field="port"]').value).toBe('2222');
    $('[data-action="save"]').click();
    await flush();
    expect(api.ssh.saveProfile.mock.calls[0][0].id).toBe('h7k2m9qa');
  });

  test('save and test reports the result of the test', async () => {
    Modal.openHostEditor({ profile: PROFILE });
    $('.ssh-editor').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(api.ssh.testProfile).toHaveBeenCalledWith(PROFILE.id);
    expect($('.ssh-test-result').classList.contains('is-ok')).toBe(true);
  });
});

describe('remote directory browser', () => {
  async function openBrowser(onProjectCreated = jest.fn()) {
    Modal.openRemoteProjectModal({ profileId: PROFILE.id, onProjectCreated });
    await flush();
    return onProjectCreated;
  }

  test('connects by profile id, then lists directories only', async () => {
    await openBrowser();
    expect(api.ssh.connect).toHaveBeenCalledWith(PROFILE.id);
    expect(api.ssh.browse).toHaveBeenCalledWith(PROFILE.id, '');
    const names = $$('.ssh-dir-item').map((li) => li.dataset.name);
    expect(names).toEqual(['api', 'web']);
    expect(document.body.textContent).not.toContain('secrets.txt');
    expect($('.ssh-path-input').value).toBe('/home/yanis');
  });

  test('entering a folder browses its path on the same profile', async () => {
    await openBrowser();
    $('.ssh-dir-item[data-name="api"]').click();
    await flush();
    expect(api.ssh.browse).toHaveBeenLastCalledWith(PROFILE.id, '/home/yanis/api');
  });

  test('"Open this folder" creates a general project with a URI path and the remote block', async () => {
    const onCreated = await openBrowser();
    $('.ssh-dir-item[data-name="api"]').click();
    await flush();
    $('[data-action="open"]').click();
    await flush();
    const created = projects.projectsState.get().projects;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'general',
      name: 'api',
      path: 'ssh-remote://abcd1234/home/yanis/api',
      remote: { profileId: 'abcd1234', path: '/home/yanis/api', hostLabel: 'yanis@build.example.com' },
    });
    expect(onCreated).toHaveBeenCalledWith(created[0]);
  });

  test('clone calls the remote clone IPC with the profile id and a path, never host strings', async () => {
    const onCreated = await openBrowser();
    $('details.ssh-clone').open = true;
    setValue('[data-input="clone-url"]', 'git@github.com:Sterll/claude-terminal.git');
    expect($('[data-input="clone-folder"]').value).toBe('claude-terminal');
    $('[data-action="clone"]').click();
    await flush();
    expect(api.ssh.clone).toHaveBeenCalledTimes(1);
    const params = api.ssh.clone.mock.calls[0][0];
    expect(params).toMatchObject({ profileId: 'abcd1234', url: 'git@github.com:Sterll/claude-terminal.git', path: '/home/yanis/claude-terminal' });
    expect(typeof params.operationId).toBe('string');
    for (const key of HOST_KEYS) expect(params).not.toHaveProperty(key);
    const [project] = projects.projectsState.get().projects;
    expect(project).toMatchObject({ type: 'general', path: 'ssh-remote://abcd1234/home/yanis/claude-terminal', remote: { profileId: 'abcd1234', path: '/home/yanis/claude-terminal' } });
    expect(onCreated).toHaveBeenCalled();
  });

  test('mkdir and git init name the host by profile id', async () => {
    await openBrowser();
    setValue('[data-input="new-folder"]', 'fresh');
    $('[data-action="mkdir"]').click();
    await flush();
    expect(api.ssh.mkdir).toHaveBeenCalledWith(PROFILE.id, '/home/yanis/fresh');
    $('[data-action="init"]').click();
    await flush();
    expect(api.ssh.init).toHaveBeenCalledWith(PROFILE.id, '/home/yanis/fresh');
    expect(projects.projectsState.get().projects[0].path).toBe('ssh-remote://abcd1234/home/yanis/fresh');
  });

  test('a folder name with a slash is refused before reaching main', async () => {
    await openBrowser();
    setValue('[data-input="new-folder"]', '../escape');
    $('[data-action="mkdir"]').click();
    await flush();
    expect(api.ssh.mkdir).not.toHaveBeenCalled();
  });

  test('a host that does not connect shows its state and lists nothing', async () => {
    api.ssh.connect.mockResolvedValueOnce({ success: true, status: { profileId: PROFILE.id, state: 'hostKeyUnknown', detail: null } });
    await openBrowser();
    expect(api.ssh.browse).not.toHaveBeenCalled();
    expect($('.ssh-browser-status').classList.contains('is-error')).toBe(true);
    expect($('.ssh-browser-status button')).not.toBeNull();
  });

  test('opening an already registered folder reuses the project', async () => {
    projects.addProject({ remote: { profileId: PROFILE.id, path: '/home/yanis', hostLabel: 'x' } });
    const onCreated = await openBrowser();
    $('[data-action="open"]').click();
    await flush();
    expect(projects.projectsState.get().projects).toHaveLength(1);
    expect(onCreated).toHaveBeenCalledWith(projects.projectsState.get().projects[0]);
  });
});

describe('host badge', () => {
  const Badge = () => require('../../src/renderer/ui/components/RemoteHostBadge');
  const remote = (profileId = PROFILE.id) => ({ id: 'r1', name: 'api', path: `ssh-remote://${profileId}/home/yanis/api`, remote: { profileId, path: '/home/yanis/api', hostLabel: 'yanis@elsewhere.example.com' } });

  test('a local project gets no badge at all', () => {
    expect(Badge().buildHostBadgeHtml({ id: 'l', path: 'C:\\code\\app' })).toBe('');
  });

  test.each(['connecting', 'connected', 'reconnecting', 'authFailed', 'hostKeyUnknown'])('reflects %s with a translated tooltip', (state) => {
    hosts.applyHostStatus({ profileId: PROFILE.id, state, detail: state === 'reconnecting' ? { attempt: 3 } : null, retryAt: state === 'reconnecting' ? Date.now() + 4000 : null });
    const host = document.createElement('div');
    host.innerHTML = Badge().buildHostBadgeHtml(remote());
    const badge = host.querySelector('.remote-host-badge');
    expect(badge.classList.contains(`state-${state}`)).toBe(true);
    expect(badge.title).toBeTruthy();
    expect(badge.title).not.toMatch(/ssh\.(status|tooltip)\./);
    expect(badge.textContent).toContain('yanis@build.example.com');
  });

  test('a project whose profile is not on this machine renders the unconfigured state', () => {
    const host = document.createElement('div');
    host.innerHTML = Badge().buildHostBadgeHtml(remote('zzzz9999'));
    const badge = host.querySelector('.remote-host-badge');
    expect(badge.dataset.hostState).toBe('unconfigured');
    expect(badge.title).toContain('yanis@elsewhere.example.com');
  });

  test('clicking the unconfigured badge opens the editor for that id, prefilled from the label', async () => {
    projects.projectsState.set({ projects: [remote('zzzz9999')] });
    await Badge().onHostBadgeClick('r1');
    expect($('[data-field="host"]').value).toBe('elsewhere.example.com');
    $('[data-action="save"]').click();
    await flush();
    expect(api.ssh.saveProfile.mock.calls[0][0].id).toBe('zzzz9999');
    expect(api.ssh.connect).not.toHaveBeenCalled();
  });

  test('projectLocation shows host:path for a remote project, the path otherwise', () => {
    expect(Badge().projectLocation(remote())).toBe('yanis@build.example.com:/home/yanis/api');
    expect(Badge().projectLocation({ path: '/srv/x' })).toBe('/srv/x');
  });
});

describe('Verify host PTY lifecycle', () => {
  test('a modal closed while the verify PTY is starting kills it once it exists', async () => {
    let release;
    api.ssh.verifyHost.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    Modal.openVerifyHost('abcd1234');
    await flush();
    // Opening another dialog closes this one before main has answered.
    Modal.openHostEditor({});
    await flush();
    expect(api.terminal.kill).not.toHaveBeenCalled();
    release({ success: true, id: 7 });
    await flush();
    expect(api.terminal.kill).toHaveBeenCalledWith({ id: 7 });
    expect(api.terminal.onData).not.toHaveBeenCalled();
  });
});

describe('switching views keeps the dialog open', () => {
  // Every view switch replaces the dialog body from inside the click handler,
  // so the clicked button is detached before the click reaches the overlay.
  // The backdrop handler read that as a click outside the dialog and closed
  // it: Edit, Add host, Next, Back and Verify host all dropped the user out
  // of the dialog in the real app.
  const isOpen = () => $('#remote-project-modal').classList.contains('active');

  test('Edit, Back and Next move between views without closing', async () => {
    Modal.openRemoteProjectModal({});
    await flush();
    expect($('.ssh-picker')).not.toBeNull();
    $('.ssh-host-item [data-action="edit"]').click();
    expect(isOpen()).toBe(true);
    expect($('.ssh-editor')).not.toBeNull();
    $('[data-action="cancel"]').click();
    expect(isOpen()).toBe(true);
    expect($('.ssh-picker')).not.toBeNull();
    $('[data-action="next"]').click();
    expect(isOpen()).toBe(true);
    await flush();
    expect($('.ssh-browser')).not.toBeNull();
    $('[data-action="back"]').click();
    expect(isOpen()).toBe(true);
    $('[data-action="add"]').click();
    expect(isOpen()).toBe(true);
    expect($('.ssh-editor')).not.toBeNull();
  });

  test('Verify host from a failed test opens the verification in the same dialog', async () => {
    api.ssh.testProfile.mockImplementation(async () => ({ success: true, result: { ok: false, state: 'hostKeyUnknown', detail: { stderr: 'Host key verification failed.' } } }));
    Modal.openRemoteProjectModal({});
    await flush();
    $('.ssh-host-item [data-action="edit"]').click();
    $('.ssh-editor').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    $('.ssh-test-result [data-action="verify"]').click();
    expect(isOpen()).toBe(true);
    expect($('.ssh-verify')).not.toBeNull();
    await flush();
    expect(api.ssh.verifyHost).toHaveBeenCalledWith(PROFILE.id);
  });

  test('a click on the backdrop itself still closes the dialog', async () => {
    Modal.openRemoteProjectModal({});
    await flush();
    $('#remote-project-modal').click();
    expect(isOpen()).toBe(false);
  });
});
