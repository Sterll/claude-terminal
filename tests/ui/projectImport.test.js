/**
 * The first-launch import: a fresh profile on a machine where Claude Code was
 * already used is offered those folders as projects, once, all ticked, and
 * only the ones left ticked are added.
 */
jest.mock('../../src/renderer/ui/components/Toast', () => ({ showSuccess: jest.fn() }));

const { maybeShowProjectImport, showProjectImportModal } = require('../../src/renderer/ui/components/ProjectImportModal');
const { showSuccess } = require('../../src/renderer/ui/components/Toast');

const flush = () => new Promise(r => setTimeout(r, 0));

const FOLDERS = [
  { path: 'E:\\work\\recent', name: 'recent', lastActivity: Date.now() - 3600_000, sessionCount: 4 },
  { path: 'E:\\work\\older', name: 'older', lastActivity: Date.now() - 5 * 86400_000, sessionCount: 1 },
  { path: 'E:\\work\\oldest', name: 'oldest', lastActivity: Date.now() - 40 * 86400_000, sessionCount: 2 },
];

function deps({ done = false, isFreshProfile = true, folders = FOLDERS, success = true, projects = [] } = {}) {
  const settings = { projectImportDone: done };
  const list = [...projects];
  const api = { claude: { discoverProjects: jest.fn(async () => (success ? { success: true, folders } : { success: false, error: 'boom' })) } };
  return {
    settings,
    list,
    api,
    getSetting: (k) => settings[k],
    setSetting: jest.fn((k, v) => { settings[k] = v; }),
    isFreshProfile,
    getProjects: () => list,
    addProject: jest.fn((data) => { const p = { id: `p${list.length}`, ...data }; list.push(p); return p; }),
    onAdded: jest.fn(),
  };
}

const modal = () => document.getElementById('project-import-modal');
const rows = () => [...modal().querySelectorAll('.project-import-row')];

afterEach(() => {
  document.body.innerHTML = '';
  showSuccess.mockClear();
});

describe('project import', () => {
  test('lists every folder ticked, most recent first, with its last session', async () => {
    const d = deps();
    const pending = maybeShowProjectImport(d);
    await flush();
    expect(modal()).not.toBeNull();
    expect(d.settings.projectImportDone).toBe(true);
    expect(rows().map(r => r.querySelector('.project-import-name').textContent)).toEqual(['recent', 'older', 'oldest']);
    expect(rows().every(r => r.querySelector('input').checked)).toBe(true);
    expect(rows()[0].querySelector('.project-import-path').textContent).toBe('E:\\work\\recent');
    expect(rows()[0].querySelector('.project-import-date').textContent).toMatch(/^last session /);
    expect(modal().querySelector('[data-action="confirm"]').textContent.trim()).toBe('Add (3)');

    modal().querySelector('[data-action="cancel"]').click();
    await pending;
  });

  test('adds only the folders left ticked, as general projects, and says so', async () => {
    const d = deps();
    const pending = maybeShowProjectImport(d);
    await flush();
    const box = rows()[1].querySelector('input');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modal().querySelector('[data-action="confirm"]').textContent).toBe('Add (2)');

    modal().querySelector('[data-action="confirm"]').click();
    const added = await pending;
    expect(added.map(p => p.path)).toEqual(['E:\\work\\recent', 'E:\\work\\oldest']);
    expect(d.addProject).toHaveBeenCalledWith({ name: 'recent', path: 'E:\\work\\recent', type: 'standalone' });
    expect(d.onAdded).toHaveBeenCalledWith(added);
    expect(showSuccess).toHaveBeenCalledWith('Projects added: 2');
  });

  test('nothing ticked cannot be confirmed', async () => {
    const d = deps();
    const pending = maybeShowProjectImport(d);
    await flush();
    for (const r of rows()) {
      const box = r.querySelector('input');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(modal().querySelector('[data-action="confirm"]').disabled).toBe(true);
    modal().querySelector('[data-action="cancel"]').click();
    await expect(pending).resolves.toEqual([]);
  });

  test('"Not now" adds nothing, and it is not asked again', async () => {
    const d = deps();
    const pending = maybeShowProjectImport(d);
    await flush();
    modal().querySelector('[data-action="cancel"]').click();
    await expect(pending).resolves.toEqual([]);
    expect(d.addProject).not.toHaveBeenCalled();

    await expect(maybeShowProjectImport(d)).resolves.toEqual([]);
    expect(d.api.claude.discoverProjects).toHaveBeenCalledTimes(1);
  });

  test('a profile that already has projects is never asked, and is marked done', async () => {
    const d = deps({ isFreshProfile: false });
    await expect(maybeShowProjectImport(d)).resolves.toEqual([]);
    expect(d.api.claude.discoverProjects).not.toHaveBeenCalled();
    expect(d.settings.projectImportDone).toBe(true);
  });

  test('nothing found shows nothing and is not asked again', async () => {
    const d = deps({ folders: [] });
    await expect(maybeShowProjectImport(d)).resolves.toEqual([]);
    expect(modal()).toBeNull();
    expect(d.settings.projectImportDone).toBe(true);
  });

  test('a discovery that failed asks again next launch', async () => {
    const d = deps({ success: false });
    await expect(maybeShowProjectImport(d)).resolves.toEqual([]);
    expect(modal()).toBeNull();
    expect(d.setSetting).not.toHaveBeenCalled();
  });

  test('a folder added as a project meanwhile is not offered', async () => {
    const d = deps();
    // Main was asked to exclude the projects known at the time; one more
    // arrived while it read (a drop, the MCP tool).
    d.api.claude.discoverProjects.mockImplementation(async () => {
      d.list.push({ id: 'x', path: 'e:/work/older/' });
      return { success: true, folders: FOLDERS };
    });
    const pending = maybeShowProjectImport(d);
    await flush();
    expect(rows().map(r => r.querySelector('.project-import-name').textContent)).toEqual(['recent', 'oldest']);
    modal().querySelector('[data-action="cancel"]').click();
    await pending;
  });

  test('names and paths are escaped', async () => {
    const pending = showProjectImportModal([{ path: 'C:\\<b>x</b>', name: '<img src=x onerror=alert(1)>', lastActivity: Date.now(), sessionCount: 1 }]);
    await flush();
    expect(modal().querySelector('img')).toBeNull();
    expect(modal().querySelector('.project-import-name').textContent).toBe('<img src=x onerror=alert(1)>');
    modal().querySelector('[data-action="cancel"]').click();
    await expect(pending).resolves.toBeNull();
  });
});
