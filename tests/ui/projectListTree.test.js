/**
 * The project tree is drawn from `children` (display order) but the truth is
 * `parentId` / `folderId`. The two can disagree — legacy files, a cloud merge
 * that takes the cloud's folder wholesale, another process writing the file —
 * and when they do, a subtree must not go missing or be drawn twice.
 */

const { projectsState } = require('../../src/renderer/state/projects.state');
const { ProjectList } = require('../../src/renderer/ui/components/ProjectList');

function setTree({ projects = [], folders = [], rootOrder = [] }) {
  projectsState.set({
    projects, folders, rootOrder,
    selectedProjectFilter: null,
    openedProjectId: null,
    openProjectIds: [],
  });
}

function renderRoot(folderId) {
  const folder = projectsState.get().folders.find(f => f.id === folderId);
  return new ProjectList()._renderFolderHtml(folder, 0, '');
}

// data-folder-id also appears on the folder's colour button, so count the row itself.
const folderRows = (html, id) => html.split(`class="folder-item" data-folder-id="${id}"`).length - 1;

describe('folder tree rendering', () => {
  test('draws a subfolder missing from its parent children array', () => {
    setTree({
      projects: [{ id: 'p1', name: 'Hidden', path: '/h', folderId: 'f2' }],
      folders: [
        { id: 'f1', name: 'Parent', parentId: null, collapsed: false, children: [] },
        { id: 'f2', name: 'Child', parentId: 'f1', collapsed: false, children: ['p1'] },
      ],
      rootOrder: ['f1'],
    });
    const html = renderRoot('f1');
    expect(html).toContain('data-folder-id="f2"');
    expect(html).toContain('data-project-id="p1"');
  });

  test('ignores a stale children entry instead of drawing the subtree twice', () => {
    setTree({
      projects: [{ id: 'p1', name: 'P', path: '/p', folderId: 'f2' }],
      folders: [
        // f1 still lists f2, but f2 has moved under f3.
        { id: 'f1', name: 'Old parent', parentId: null, collapsed: false, children: ['f2'] },
        { id: 'f2', name: 'Moved', parentId: 'f3', collapsed: false, children: ['p1'] },
        { id: 'f3', name: 'New parent', parentId: null, collapsed: false, children: ['f2'] },
      ],
      rootOrder: ['f1', 'f3'],
    });
    expect(folderRows(renderRoot('f1'), 'f2')).toBe(0);
    expect(folderRows(renderRoot('f3'), 'f2')).toBe(1);
  });

  test('draws a subfolder listed in children exactly once', () => {
    setTree({
      projects: [],
      folders: [
        { id: 'f1', name: 'Parent', parentId: null, collapsed: false, children: ['f2'] },
        { id: 'f2', name: 'Child', parentId: 'f1', collapsed: false, children: [] },
      ],
      rootOrder: ['f1'],
    });
    expect(folderRows(renderRoot('f1'), 'f2')).toBe(1);
  });

  test('keeps the children array order for mixed folders and projects', () => {
    setTree({
      projects: [
        { id: 'p1', name: 'First', path: '/a', folderId: 'f1' },
        { id: 'p2', name: 'Last', path: '/b', folderId: 'f1' },
      ],
      folders: [
        { id: 'f1', name: 'Parent', parentId: null, collapsed: false, children: ['p2', 'f2', 'p1'] },
        { id: 'f2', name: 'Child', parentId: 'f1', collapsed: false, children: [] },
      ],
      rootOrder: ['f1'],
    });
    const html = renderRoot('f1');
    expect(html.indexOf('data-project-id="p2"')).toBeLessThan(html.indexOf('data-folder-id="f2"'));
    expect(html.indexOf('data-folder-id="f2"')).toBeLessThan(html.indexOf('data-project-id="p1"'));
  });
});
