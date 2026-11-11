// The empty states that start something: each one explains the screen, opens
// the panel's existing form or wizard on a click, and creates nothing before.

const REMOTE = { id: 'r1', name: 'api', path: 'ssh-remote://abcd1234/home/dev/api', remote: { profileId: 'abcd1234', path: '/home/dev/api' } };
const LOCAL = { id: 'l1', name: 'shop', path: '/home/dev/shop' };

function flush() { return new Promise(resolve => setTimeout(resolve, 0)); }

describe('Database', () => {
  let projects;
  let api;

  function load() {
    let panel;
    jest.isolateModules(() => {
      jest.doMock('../../src/renderer/state', () => ({
        loadDatabasePersistence: jest.fn(),
        getDatabaseConnections: jest.fn(() => []),
        getDetectedDatabases: jest.fn(() => []),
        setDetectedDatabases: jest.fn(),
        getActiveConnection: jest.fn(() => null),
        getConnectionStatus: jest.fn(() => 'disconnected'),
        getDatabaseConnection: jest.fn(() => null),
        projectsState: { get: () => ({ projects, openedProjectId: projects[0]?.id || null }) },
      }));
      panel = require('../../src/renderer/ui/panels/DatabasePanel');
    });
    api = {
      database: {
        loadConnections: jest.fn(async () => []),
        saveConnections: jest.fn(async () => {}),
        detect: jest.fn(async () => []),
      },
    };
    // The panel's own modal host, as renderer.js provides it.
    const showModal = (title, html, footer = '') => {
      const modal = document.createElement('div');
      modal.className = 'test-modal';
      modal.innerHTML = html + footer;
      document.body.appendChild(modal);
    };
    panel.init({ api, projectsState: { get: () => ({ projects }) }, showToast: jest.fn(), showModal, closeModal: jest.fn() });
    return panel;
  }

  beforeEach(() => {
    document.body.innerHTML = '<div id="database-content"></div>';
  });

  test('explains the screen and opens the connection form only on a click', async () => {
    projects = [LOCAL];
    const panel = load();
    await panel.loadPanel();

    const block = document.querySelector('[data-empty-state="database"]');
    expect(block).not.toBeNull();
    expect(block.querySelector('.empty-guide-purpose').textContent).not.toBe('');
    expect(document.querySelector('.test-modal')).toBeNull();

    document.getElementById('database-empty-add').click();
    expect(document.getElementById('db-form-name')).not.toBeNull();
    // Opening the form saves nothing.
    expect(api.database.saveConnections).not.toHaveBeenCalled();
  });

  test('an engine example pre-selects the type in the form, still unsaved', async () => {
    projects = [LOCAL];
    const panel = load();
    await panel.loadPanel();

    document.getElementById('database-empty-type-postgresql').click();
    const form = document.querySelector('.test-modal');
    expect(form).not.toBeNull();
    expect(form.innerHTML).toContain('postgresql');
    expect(api.database.saveConnections).not.toHaveBeenCalled();
  });

  test('detection runs on a click for a local project', async () => {
    projects = [LOCAL];
    const panel = load();
    await panel.loadPanel();
    expect(api.database.detect).not.toHaveBeenCalled();
    document.getElementById('database-empty-detect').click();
    await flush();
    expect(api.database.detect).toHaveBeenCalledWith({ projectPath: LOCAL.path });
  });

  test('detection is refused with its reason for a remote project, the form stays offered', async () => {
    projects = [REMOTE];
    const panel = load();
    await panel.loadPanel();

    const detect = document.getElementById('database-empty-detect');
    expect(detect.getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('[data-empty-state="database"] .empty-guide-reason')).not.toBeNull();
    detect.click();
    await flush();
    expect(api.database.detect).not.toHaveBeenCalled();
    expect(document.getElementById('database-empty-add').classList.contains('is-disabled')).toBe(false);
  });
});

describe('Control Tower', () => {
  test('with no session, starts one on a click and never before', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/renderer/ui/panels/ControlTowerPanel.js'), 'utf8');
    const start = src.indexOf('function _mountEmptyState(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    // The spawn modal and the project wizard are only reached through onClick.
    expect(body).toMatch(/onClick: \(\) => _openSpawnModal\(\)/);
    expect(body).toMatch(/onClick: \(\) => document\.getElementById\('btn-new-project'\)\?\.click\(\)/);
    expect(body.replace(/onClick: \(\) => [^}]+/g, '')).not.toMatch(/_openSpawnModal\(|createTerminal\(/);
  });
});

describe('Parallel Tasks', () => {
  function load(projectList) {
    let panel;
    jest.isolateModules(() => {
      jest.doMock('../../src/renderer/state/parallelTask.state', () => ({
        parallelTaskState: { subscribe: jest.fn(() => () => {}) },
        getRuns: jest.fn(() => []),
        getRunById: jest.fn(() => null),
        addRun: jest.fn(),
        removeRun: jest.fn(),
        initParallelListeners: jest.fn(),
      }));
      jest.doMock('../../src/renderer/services/ModelCatalogClient', () => ({
        get: jest.fn(() => ({})), subscribe: jest.fn(), getCatalog: jest.fn(() => ({ primary: [{ value: 'sonnet', label: 'Sonnet', resolvedModel: 'claude-sonnet' }], legacy: [] })),
      }));
      panel = require('../../src/renderer/ui/panels/ParallelTaskPanel');
    });
    const api = { parallel: { getHistory: jest.fn(async () => ({ success: true, runs: [] })), startRun: jest.fn() } };
    panel.init({ api, projectsState: { get: () => ({ projects: projectList, selectedProjectFilter: 0 }) } });
    return { panel, api };
  }

  beforeEach(() => { document.body.innerHTML = '<div id="tab-tasks"></div>'; });

  test('an example goal pre-fills the New Run form and starts nothing', async () => {
    const { panel, api } = load([LOCAL]);
    await panel.load();
    await flush();

    expect(document.getElementById('pm-goal-input')).toBeNull();
    document.getElementById('pt-empty-example-tests').click();
    const goal = document.getElementById('pm-goal-input');
    expect(goal).not.toBeNull();
    expect(goal.value.length).toBeGreaterThan(0);
    expect(api.parallel.startRun).not.toHaveBeenCalled();
  });

  test('New Run opens an empty form', async () => {
    const { panel } = load([LOCAL]);
    await panel.load();
    await flush();
    document.getElementById('pt-empty-new-run').click();
    expect(document.getElementById('pm-goal-input').value).toBe('');
  });

  test('a remote project gets the reason, and the examples are not offered as runnable', async () => {
    const { panel } = load([REMOTE]);
    await panel.load();
    await flush();
    const example = document.getElementById('pt-empty-example-docs');
    expect(example.getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('.pt-empty-runs .empty-guide-reason')).not.toBeNull();
    example.click();
    expect(document.getElementById('pm-goal-input')).toBeNull();
  });
});

describe('Git tab, folder that is not a repository', () => {
  function load(project) {
    const git = new Proxy({
      statusDetailed: jest.fn(async () => ({ success: false, error: 'Not a git repository' })),
      commitHistory: jest.fn(async () => []),
      infoFull: jest.fn(async () => null),
    }, { get: (target, key) => target[key] || (target[key] = jest.fn(async () => (/List|remotes|Conflicts/.test(key) ? [] : null))) });
    const apiMock = { git, project: { initGit: jest.fn(async () => ({ success: true })) }, github: { pullRequests: jest.fn(async () => ({})), issues: jest.fn(async () => ({})) } };
    window.electron_api = { ...window.electron_api, ...apiMock };
    let service;
    jest.isolateModules(() => {
      jest.doMock('../../src/renderer/utils/nestedRepos', () => ({
        listNestedRepos: jest.fn(async () => []),
        getSelectedRepo: jest.fn(() => null),
      }));
      jest.doMock('../../src/renderer/state', () => ({
        projectsState: { get: () => ({ projects: [project], folders: [], rootOrder: [project.id], selectedProjectFilter: 0 }), subscribe: jest.fn() },
        getProject: (id) => (id === project.id ? project : null),
        getFolder: () => null,
        getProjectIndex: () => 0,
        getSetting: () => undefined,
      }));
      service = require('../../src/renderer/services/GitTabService');
    });
    return { service, api: apiMock };
  }

  beforeEach(() => {
    jest.resetModules();
    document.body.innerHTML = '<div id="git-sub-content"></div>';
  });

  test('explains what git gives, and runs git init only on a click', async () => {
    const { service, api } = load(LOCAL);
    await service.selectProject(LOCAL.id);
    await flush();

    const block = document.querySelector('[data-empty-state="git-not-a-repo"]');
    expect(block).not.toBeNull();
    expect(block.querySelector('.empty-guide-purpose').textContent).not.toBe('');
    expect(api.project.initGit).not.toHaveBeenCalled();

    document.getElementById('git-empty-init').click();
    await flush();
    expect(api.project.initGit).toHaveBeenCalledWith({ projectPath: LOCAL.path });
  });

  test('Install Git still answers its click once the tab copies its markup', async () => {
    const { service, api } = load(LOCAL);
    window.electron_api.dialog = { openExternal: jest.fn() };
    api.git.statusDetailed.mockResolvedValueOnce({ success: false, error: 'spawn git ENOENT', gitUnavailable: true, unavailableReason: 'enoent' });
    await service.selectProject(LOCAL.id);
    await flush();
    expect(document.querySelector('[data-empty-state="git-not-a-repo"]')).toBeNull();
    document.querySelector('[data-git-install]').click();
    expect(window.electron_api.dialog.openExternal).toHaveBeenCalledWith('https://git-scm.com/downloads');
  });

  test('a host that is away gets no init offer', async () => {
    const { service, api } = load(LOCAL);
    api.git.statusDetailed.mockResolvedValueOnce({ success: false, error: 'Not a git repository', reason: 'disconnected' });
    await service.selectProject(LOCAL.id);
    await flush();
    expect(document.querySelector('[data-empty-state="git-not-a-repo"]')).toBeNull();
  });
});

describe('Dashboard with no project', () => {
  test('explains a project and opens the new-project wizard only on a click', () => {
    let DashboardService;
    jest.isolateModules(() => { DashboardService = require('../../src/renderer/services/DashboardService'); });
    document.body.innerHTML = '<button id="btn-new-project"></button><button id="btn-new-remote-project"></button><div id="dash"></div>';
    const wizard = jest.fn();
    const remote = jest.fn();
    document.getElementById('btn-new-project').addEventListener('click', wizard);
    document.getElementById('btn-new-remote-project').addEventListener('click', remote);

    DashboardService.renderOverview(document.getElementById('dash'), []);
    expect(document.querySelector('[data-empty-state="dashboard"]')).not.toBeNull();
    expect(wizard).not.toHaveBeenCalled();

    document.getElementById('dash-empty-add-project').click();
    expect(wizard).toHaveBeenCalledTimes(1);
    document.getElementById('dash-empty-open-remote').click();
    expect(remote).toHaveBeenCalledTimes(1);
  });
});

describe('Plugins, nothing installed', () => {
  test('opens the catalog on a click; a search with no hit keeps its own message', () => {
    const { PluginsPanel } = require('../../src/renderer/ui/panels/PluginsPanel');
    document.body.innerHTML = '<button class="plugins-sub-tab" data-subtab="discover"></button><div id="plugins-content"></div>';
    const discover = jest.fn();
    document.querySelector('.plugins-sub-tab').addEventListener('click', discover);
    const panel = new PluginsPanel(document.body, {});

    panel._renderInstalled();
    expect(document.querySelector('[data-empty-state="plugins"]')).not.toBeNull();
    expect(discover).not.toHaveBeenCalled();
    document.getElementById('plugins-empty-discover').click();
    expect(discover).toHaveBeenCalledTimes(1);

    panel._state.data.searchQuery = 'nothing-matches';
    panel._renderInstalled();
    expect(document.querySelector('[data-empty-state="plugins"]')).toBeNull();
    expect(document.querySelector('.plugins-empty-state')).not.toBeNull();
  });
});

describe('Workflows, none yet', () => {
  test('a ready-made task opens the simple sheet pre-filled, and nothing is saved', async () => {
    const workflowApi = new Proxy({
      list: jest.fn(async () => ({ success: true, workflows: [] })),
      getRecentRuns: jest.fn(async () => ({ success: true, runs: [] })),
      save: jest.fn(async () => ({ success: true })),
    }, { get: (target, key) => target[key] || (target[key] = jest.fn(() => () => {})) });
    window.electron_api = { ...window.electron_api, workflow: workflowApi };
    document.body.innerHTML = '<div id="workflow-panel"></div>';

    let panel;
    let TasksView;
    jest.isolateModules(() => {
      jest.doMock('../../src/renderer/ui/panels/TasksView', () => ({ render: jest.fn(), openTaskModal: jest.fn(), getTasks: jest.fn(() => []) }));
      TasksView = require('../../src/renderer/ui/panels/TasksView');
      panel = require('../../src/renderer/ui/panels/WorkflowPanel');
    });
    panel.init({});
    await panel.load();
    document.querySelector('[data-wftab="workflows"]').click();
    await flush();

    const block = document.querySelector('[data-empty-state="workflows"]');
    expect(block).not.toBeNull();
    expect(TasksView.openTaskModal).not.toHaveBeenCalled();

    const { TASK_PRESETS } = require('../../src/shared/simple-task');
    document.getElementById(`wf-empty-preset-${TASK_PRESETS[0].id}`).click();
    expect(TasksView.openTaskModal).toHaveBeenCalledTimes(1);
    expect(TasksView.openTaskModal.mock.calls[0][1]).toBeNull();
    expect(TasksView.openTaskModal.mock.calls[0][2]).toEqual(TASK_PRESETS[0]);
    expect(workflowApi.save).not.toHaveBeenCalled();
  });
});
