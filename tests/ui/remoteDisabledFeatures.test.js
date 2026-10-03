/**
 * Local-only features and remote (SSH) projects (design/remote-ssh.md
 * section 8): for a remote project the controls render disabled with the
 * capability's reason as tooltip, and a click explains itself instead of
 * failing silently; for a local project the same controls render exactly as
 * they did before remote projects existed.
 *
 * Also spot-checks that the feature paths that read project files (the MCP
 * panel, the Control Tower branch, the dashboard's type section) never reach
 * the local fs or local git for a remote project.
 */

jest.mock('../../src/renderer/ui/components/Toast', () => ({
  showToast: jest.fn(),
  show: jest.fn(),
}));
jest.mock('../../src/renderer/ui/components/ContextMenu', () => ({
  showContextMenu: jest.fn(),
  hideContextMenu: jest.fn(),
}));

const { t } = require('../../src/renderer/i18n');
const Toast = require('../../src/renderer/ui/components/Toast');
const { showContextMenu } = require('../../src/renderer/ui/components/ContextMenu');
const { projectsState } = require('../../src/renderer/state/projects.state');
const { accountsState } = require('../../src/renderer/state/accounts.state');
const { setSetting } = require('../../src/renderer/state/settings.state');
const registry = require('../../src/project-types/registry');
const { BASE_TYPE } = require('../../src/project-types/base-type');

const REMOTE = {
  id: 'r1', name: 'Remote Api', type: 'faketype', path: 'ssh-remote://abcd1234/srv/api',
  remote: { profileId: 'abcd1234', path: '/srv/api', hostLabel: 'u@build' },
};
const LOCAL = { id: 'l1', name: 'Local App', type: 'faketype', path: '/code/app' };

const reason = (feature) => t(require('../../src/shared/remote-capabilities').CAPABILITIES[feature].reasonKey);

function setProjects(projects, selected = null) {
  projectsState.set({
    projects,
    folders: [],
    rootOrder: projects.map(p => p.id),
    selectedProjectFilter: selected,
    openedProjectId: null,
    openProjectIds: [],
  });
}

beforeAll(() => {
  // A type with visible hooks, so hiding them for a remote project shows.
  registry.register({
    ...BASE_TYPE,
    id: 'faketype',
    getMenuItems: () => '<button class="fake-type-menu-item">Start server</button>',
    getSidebarButtons: () => '<button class="fake-type-sidebar-btn">Run</button>',
    getProjectSettings: () => [{ key: 'port', label: 'Port' }],
    getDashboardBadge: () => ({ text: 'Fake', cssClass: 'fake' }),
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  setProjects([LOCAL, REMOTE]);
});

describe('project-type hooks', () => {
  test('a remote project gets the general type whatever its record says; a local one keeps its own', () => {
    expect(registry.forProject(REMOTE).id).toBe('standalone');
    expect(registry.forProject(LOCAL).id).toBe('faketype');
  });
});

describe('project menu (ProjectList)', () => {
  const { ProjectList } = require('../../src/renderer/ui/components/ProjectList');
  const menuOf = (project) => {
    const host = document.createElement('div');
    host.innerHTML = new ProjectList()._buildMenuItemsHtml(project);
    return host;
  };

  test('type actions and per-type settings are hidden for a remote project, shown for a local one', () => {
    expect(menuOf(REMOTE).querySelector('.fake-type-menu-item')).toBeNull();
    expect(menuOf(REMOTE).querySelector('.btn-project-settings')).toBeNull();
    expect(menuOf(LOCAL).querySelector('.fake-type-menu-item')).not.toBeNull();
    expect(menuOf(LOCAL).querySelector('.btn-project-settings')).not.toBeNull();
  });

  test('Open in Explorer is disabled with the reason for a remote project, untouched for a local one', () => {
    const remoteBtn = menuOf(REMOTE).querySelector('.btn-open-folder');
    expect(remoteBtn.classList.contains('is-disabled')).toBe(true);
    expect(remoteBtn.getAttribute('aria-disabled')).toBe('true');
    expect(remoteBtn.title).toBe(reason('openInExplorer'));

    const localBtn = menuOf(LOCAL).querySelector('.btn-open-folder');
    expect(localBtn.className).toBe('more-actions-item btn-open-folder');
    expect(localBtn.hasAttribute('title')).toBe(false);
    expect(localBtn.hasAttribute('aria-disabled')).toBe(false);
  });

  test('a non VS Code editor is disabled for a remote project; VS Code is not', () => {
    setSetting('editor', 'webstorm');
    const webstorm = menuOf(REMOTE).querySelector('.btn-open-editor');
    expect(webstorm.classList.contains('is-disabled')).toBe(true);
    expect(webstorm.title).toBe(reason('openInEditor'));
    expect(menuOf(LOCAL).querySelector('.btn-open-editor').classList.contains('is-disabled')).toBe(false);

    setSetting('editor', 'code');
    expect(menuOf(REMOTE).querySelector('.btn-open-editor').classList.contains('is-disabled')).toBe(false);
  });

  test('the account picker is disabled with the reason for a remote project', () => {
    accountsState.set({
      accounts: [{ id: 'a1', name: 'Work', color: '#3b82f6' }, { id: 'a2', name: 'Home', color: '#22c55e' }],
      defaultId: 'a1', liveId: 'a1', hasCredentials: true, loaded: true,
    });
    const remoteRow = menuOf(REMOTE).querySelector('.btn-remote-disabled');
    expect(remoteRow).not.toBeNull();
    expect(remoteRow.title).toBe(reason('accountBinding'));
    expect(menuOf(REMOTE).querySelector('.btn-project-account')).toBeNull();
    expect(menuOf(LOCAL).querySelector('.btn-project-account')).not.toBeNull();
    expect(menuOf(LOCAL).querySelector('.btn-remote-disabled')).toBeNull();
    accountsState.set({ accounts: [], defaultId: null, liveId: null, hasCredentials: false, loaded: true });
  });
});

describe('account picker (AccountMenu)', () => {
  const { showProjectAccountMenu, applyProjectAccount } = require('../../src/renderer/ui/components/AccountMenu');

  beforeEach(() => {
    accountsState.set({
      accounts: [{ id: 'a1', name: 'Work', color: '#3b82f6' }, { id: 'a2', name: 'Home', color: '#22c55e' }],
      defaultId: 'a1', liveId: 'a1', hasCredentials: true, loaded: true,
    });
  });

  test('a remote project gets the reason instead of the picker', () => {
    showProjectAccountMenu({ projectId: 'r1', x: 0, y: 0 });
    expect(showContextMenu).not.toHaveBeenCalled();
    expect(Toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: reason('accountBinding') }));
  });

  test('a local project still opens the picker', () => {
    showProjectAccountMenu({ projectId: 'l1', x: 0, y: 0 });
    expect(showContextMenu).toHaveBeenCalledTimes(1);
    expect(Toast.showToast).not.toHaveBeenCalled();
  });

  test('binding a remote project is refused, whoever asks', async () => {
    await expect(applyProjectAccount('r1', 'a2')).resolves.toBe(false);
    expect(projectsState.get().projects.find(p => p.id === 'r1').accountId).toBeUndefined();
  });
});

describe('parallel tasks (ParallelTaskPanel)', () => {
  let Panel;

  beforeAll(() => {
    window.electron_api.parallel = new Proxy({}, {
      get: (_t, name) => (String(name).startsWith('on') ? jest.fn(() => () => {}) : jest.fn(async () => ({ success: true, runs: [] }))),
    });
    document.body.innerHTML = '<div id="tab-tasks"></div>';
    Panel = require('../../src/renderer/ui/panels/ParallelTaskPanel');
    Panel.init({ projectsState, api: window.electron_api, showToast: jest.fn() });
  });

  test('with a remote project in the bar, New run is disabled with the reason and refuses with a toast', async () => {
    setProjects([LOCAL, REMOTE], 1);
    await Panel.load();
    const btn = document.getElementById('pt-new-run-btn');
    expect(btn.classList.contains('is-disabled')).toBe(true);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toBe(reason('parallelTasks'));
    btn.click();
    expect(document.getElementById('pt-modal-overlay')).toBeNull();
    expect(Toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: reason('parallelTasks') }));
  });

  test('with a local project in the bar, New run is plain and opens the modal', async () => {
    setProjects([LOCAL, REMOTE], 0);
    Panel.onProjectChanged();
    const btn = document.getElementById('pt-new-run-btn');
    expect(btn.className).toBe('pt-new-run-btn');
    expect(btn.hasAttribute('title')).toBe(false);
    expect(btn.hasAttribute('aria-disabled')).toBe(false);
    btn.click();
    expect(document.getElementById('pt-modal-overlay')).not.toBeNull();
    document.getElementById('pt-modal-close').click();
  });

  test('in sidebar mode the picker lists a remote project disabled with the reason', () => {
    document.body.classList.add('nav-sidebar');
    try {
      setProjects([LOCAL, REMOTE], 1);
      Panel.onProjectChanged();
      document.getElementById('pt-new-run-btn').click();
      const options = [...document.querySelectorAll('#pm-project-current .pt-select-option')];
      const remoteOpt = options.find(o => o.textContent === 'Remote Api');
      const localOpt = options.find(o => o.textContent === 'Local App');
      expect(remoteOpt.classList.contains('is-disabled')).toBe(true);
      expect(remoteOpt.title).toBe(reason('parallelTasks'));
      expect(remoteOpt.dataset.value).toBe('');
      expect(localOpt.dataset.value).toBe('/code/app');
      expect(localOpt.hasAttribute('title')).toBe(false);
      // The remote project is never preselected as the run's target.
      expect(document.getElementById('pm-project-current').dataset.value).toBe('');
      document.getElementById('pt-modal-close').click();
    } finally {
      document.body.classList.remove('nav-sidebar');
    }
  });
});

describe('workflow pickers', () => {
  beforeEach(() => {
    window._projectsState = projectsState;
  });

  test('cwd-picker: a remote project is disabled with the reason, unless the node allows it', () => {
    const field = require('../../src/renderer/workflow-fields/cwd-picker.field');
    const host = document.createElement('div');
    host.innerHTML = field.render({ key: 'projectId', label: '' }, '', { properties: {} });
    const remoteOpt = host.querySelector('option[value="r1"]');
    const localOpt = host.querySelector('option[value="l1"]');
    expect(remoteOpt.disabled).toBe(true);
    expect(remoteOpt.title).toBe(reason('workflowNodes'));
    expect(localOpt.outerHTML).toBe('<option value="l1">Local App</option>');

    host.innerHTML = field.render({ key: 'projectId', label: '', allowRemote: true }, '', { properties: {} });
    expect(host.querySelector('option[value="r1"]').outerHTML).toBe('<option value="r1">Remote Api</option>');
  });

  test('cwd-picker: a node saved with a remote project explains why its run is refused', () => {
    const field = require('../../src/renderer/workflow-fields/cwd-picker.field');
    const host = document.createElement('div');
    host.innerHTML = field.render({ key: 'projectId', label: '' }, '', { properties: { projectId: 'r1' } });
    expect(host.querySelector('.wf-field-hint--remote').textContent).toBe(reason('workflowNodes'));
    host.innerHTML = field.render({ key: 'projectId', label: '' }, '', { properties: { projectId: 'l1' } });
    expect(host.querySelector('.wf-field-hint--remote')).toBeNull();
  });

  test('project-config: a remote project is disabled with the reason', () => {
    const field = require('../../src/renderer/workflow-fields/project-config.field');
    const host = document.createElement('div');
    host.innerHTML = field.render({ key: 'action' }, '', { properties: { action: 'set_context' } });
    expect(host.querySelector('option[value="r1"]').disabled).toBe(true);
    expect(host.querySelector('option[value="r1"]').title).toBe(reason('workflowNodes'));
    expect(host.querySelector('option[value="l1"]').outerHTML).toBe('<option value="l1">Local App</option>');
  });

  test('file_change and git_event list a remote project disabled; other triggers do not', async () => {
    const field = require('../../src/renderer/workflow-fields/trigger-config.field');
    for (const triggerType of ['file_change', 'git_event']) {
      const host = document.createElement('div');
      host.innerHTML = await field.render({ key: 'trigger' }, '', { properties: { triggerType } });
      const opt = host.querySelector('select[data-key="projectId"] option[value="r1"]');
      expect(opt.disabled).toBe(true);
      expect(opt.title).toBe(reason('workflowTriggers'));
    }
    const host = document.createElement('div');
    host.innerHTML = await field.render({ key: 'trigger' }, '', { properties: { triggerType: 'project_opened' } });
    expect(host.querySelector('select[data-key="projectId"] option[value="r1"]').disabled).toBe(false);
  });
});

describe('custom dropdowns and simple tasks', () => {
  test('a remote-disabled option is shown with its reason but cannot be picked; other options are unchanged', () => {
    const { upgradeSelectsToDropdowns } = require('../../src/renderer/ui/panels/WorkflowHelpers');
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = `<select class="wf-node-prop" data-key="projectId">
      <option value="">Current</option>
      <option value="l1">Local App</option>
      <option value="r1" disabled data-remote-disabled="true" title="why">Remote Api</option>
    </select>`;
    const sel = host.querySelector('select');
    const changed = jest.fn();
    sel.addEventListener('change', changed);
    upgradeSelectsToDropdowns(host);

    const items = [...host.querySelectorAll('.wf-dropdown-item')];
    const remoteItem = items.find(i => i.dataset.value === 'r1');
    const localItem = items.find(i => i.dataset.value === 'l1');
    expect(remoteItem.classList.contains('is-disabled')).toBe(true);
    expect(remoteItem.title).toBe('why');
    expect(localItem.className).toBe('wf-dropdown-item');
    expect(localItem.hasAttribute('title')).toBe(false);

    remoteItem.click();
    expect(sel.value).toBe('');
    expect(changed).not.toHaveBeenCalled();
    expect(Toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: 'why' }));

    host.querySelectorAll('.wf-dropdown-item').forEach(i => { if (i.dataset.value === 'l1') i.click(); });
    expect(sel.value).toBe('l1');
    expect(changed).toHaveBeenCalledTimes(1);
    host.remove();
  });

  test('a file change task lists a remote project disabled, and runs only on local projects', () => {
    const TasksView = require('../../src/renderer/ui/panels/TasksView');
    TasksView.openTaskModal({}, { id: 'w1', name: 'Watch', enabled: true, simple: { prompt: 'x', when: { kind: 'file_change', projectIds: [] } } });
    const remoteChip = document.querySelector('.auto-pchip[data-pid="r1"]');
    const localChip = document.querySelector('.auto-pchip[data-pid="l1"]');
    expect(remoteChip.classList.contains('is-disabled')).toBe(true);
    expect(remoteChip.title).toBe(reason('workflowTriggers'));
    expect(localChip.classList.contains('is-disabled')).toBe(false);
    expect(localChip.hasAttribute('title')).toBe(false);

    remoteChip.click();
    expect(Toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: reason('workflowTriggers') }));
    expect(document.querySelector('.auto-pchip[data-pid="r1"]').classList.contains('active')).toBe(false);

    const runOption = document.querySelector('#auto-project option[value="r1"]');
    expect(runOption.disabled).toBe(true);
    expect(runOption.title).toBe(reason('workflowNodes'));
    expect(document.querySelector('#auto-project option[value="l1"]').disabled).toBe(false);
    document.querySelector('.auto-overlay')?.remove();
  });
});

describe('no local fs or git for a remote project', () => {
  test('McpPanel never joins or reads a remote project path, and says which projects it skipped', async () => {
    const fsAsync = require('../../src/renderer/utils/fs-async');
    const existsSpy = jest.spyOn(fsAsync, 'fileExists').mockResolvedValue(false);
    const { McpPanel } = require('../../src/renderer/ui/panels/McpPanel');
    document.body.innerHTML = '<div id="mcp-list"></div>';
    const join = jest.fn((...parts) => require('path').join(...parts));
    const panel = Object.create(McpPanel.prototype);
    panel._state = { mcps: [], mcpProcesses: {} };
    panel._claudeConfigFile = '/mock/home/.claude.json';
    panel._claudeSettingsFile = '/mock/home/.claude/settings.json';
    panel.api = { path: { join } };
    panel._bindMcpCardHandlers = jest.fn();

    await panel._loadLocalMcps();

    const touched = [...existsSpy.mock.calls.map(c => c[0]), ...join.mock.calls.flat()].map(String);
    expect(touched.some(p => p.includes('ssh-remote') || p.includes('srv'))).toBe(false);
    expect(join).toHaveBeenCalledWith('/code/app', '.claude', 'settings.local.json');
    const note = document.querySelector('.mcp-remote-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('Remote Api');
    expect(note.title).toBe(reason('projectMcpConfig'));
    existsSpy.mockRestore();
  });

  test('McpPanel with local projects only renders no note', async () => {
    setProjects([LOCAL]);
    const fsAsync = require('../../src/renderer/utils/fs-async');
    const existsSpy = jest.spyOn(fsAsync, 'fileExists').mockResolvedValue(false);
    const { McpPanel } = require('../../src/renderer/ui/panels/McpPanel');
    document.body.innerHTML = '<div id="mcp-list"></div>';
    const panel = Object.create(McpPanel.prototype);
    panel._state = { mcps: [], mcpProcesses: {} };
    panel._claudeConfigFile = '/mock/home/.claude.json';
    panel._claudeSettingsFile = '/mock/home/.claude/settings.json';
    panel.api = { path: require('path') };
    panel._bindMcpCardHandlers = jest.fn();
    await panel._loadLocalMcps();
    expect(document.querySelector('.mcp-remote-note')).toBeNull();
    expect(panel._remoteSkippedNoteHtml()).toBe('');
    existsSpy.mockRestore();
  });

  test('ControlTowerPanel never reads .git/HEAD for a remote project, nor asks a host that is away', async () => {
    const fsAsync = require('../../src/renderer/utils/fs-async');
    const existsSpy = jest.spyOn(fsAsync, 'fileExists');
    window.electron_api.git = { currentBranch: jest.fn(async () => 'main') };
    const { _getProjectBranch } = require('../../src/renderer/ui/panels/ControlTowerPanel');
    await expect(_getProjectBranch(REMOTE.path)).resolves.toBeNull();
    expect(existsSpy).not.toHaveBeenCalled();
    expect(window.electron_api.git.currentBranch).not.toHaveBeenCalled();
    existsSpy.mockRestore();
  });

  test('database detection refuses a remote project before asking main', async () => {
    const { refuseForRemote } = require('../../src/renderer/ui/components/RemoteHostBadge');
    expect(refuseForRemote(REMOTE, 'databaseDetect')).toBe(true);
    expect(Toast.showToast).toHaveBeenCalledWith(expect.objectContaining({ message: reason('databaseDetect') }));
    Toast.showToast.mockClear();
    expect(refuseForRemote(LOCAL, 'databaseDetect')).toBe(false);
    expect(Toast.showToast).not.toHaveBeenCalled();
  });
});

// Last: it resets the module registry to load CloudPanel with its own mocks.
describe('cloud upload picker (CloudPanel)', () => {
  test('a remote project is listed disabled with the reason and refused on click', async () => {
    jest.resetModules();
    const showModal = jest.fn(({ html }) => {
      const el = document.createElement('div');
      el.innerHTML = html;
      document.body.appendChild(el);
      return { el, close: jest.fn() };
    });
    jest.doMock('../../src/renderer/ui/components/Modal', () => ({ showModal, showConfirm: jest.fn() }));
    jest.doMock('../../src/renderer/ui/components/Toast', () => ({ showToast: jest.fn(), show: jest.fn() }));
    const cloudApi = new Proxy({}, {
      get: (_t, name) => (String(name).startsWith('on') ? jest.fn(() => () => {}) : jest.fn(async () => ({}))),
    });
    window.electron_api.cloud = cloudApi;
    const { projectsState: freshProjects } = require('../../src/renderer/state/projects.state');
    freshProjects.set({ projects: [LOCAL, REMOTE], folders: [], rootOrder: [], selectedProjectFilter: null, openedProjectId: null, openProjectIds: [] });
    const CloudPanel = require('../../src/renderer/ui/panels/CloudPanel');
    document.body.innerHTML = CloudPanel.buildHtml({});
    CloudPanel.setupHandlers({ settings: {}, saveSettings: jest.fn() });

    document.getElementById('cp-upload-project-btn').click();
    const modal = showModal.mock.results[0].value;
    const remoteItem = modal.el.querySelector('.cp-pick-item[data-id="r1"]');
    const localItem = modal.el.querySelector('.cp-pick-item[data-id="l1"]');
    expect(remoteItem.classList.contains('is-disabled')).toBe(true);
    expect(remoteItem.title).toBe(reason('cloudUpload'));
    expect(localItem.className).toBe('cp-pick-item');
    expect(localItem.hasAttribute('title')).toBe(false);

    remoteItem.click();
    await Promise.resolve();
    const FreshToast = require('../../src/renderer/ui/components/Toast');
    expect(FreshToast.show).toHaveBeenCalledWith(reason('cloudUpload'), 'info');
    expect(modal.close).not.toHaveBeenCalled();
    expect(cloudApi.uploadProject).not.toHaveBeenCalled();
    expect(cloudApi.uploadProjectGit).not.toHaveBeenCalled();
    CloudPanel.cleanup();
    jest.dontMock('../../src/renderer/ui/components/Modal');
    jest.dontMock('../../src/renderer/ui/components/Toast');
  });
});
