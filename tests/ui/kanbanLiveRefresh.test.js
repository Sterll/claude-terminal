/**
 * Kanban board — refresh on writes that did not come from the board.
 *
 * projects.json has several writers: the MCP kanban tools (a Claude session
 * filing its own tasks) and ParallelTaskService. projects.state reloads the
 * file when another process touches it, but the board used to be rebuilt only
 * by its own event handlers, so those tasks stayed invisible until the user
 * navigated away from the dashboard and back.
 */

const { projectsState, getTasks } = require('../../src/renderer/state');
const KanbanPanel = require('../../src/renderer/ui/panels/KanbanPanel');

/** State notifications are batched through requestAnimationFrame. */
const flush = () => new Promise(resolve => setTimeout(resolve, 5));

const COLUMNS = [
  { id: 'col-todo', title: 'To Do', color: '#3b82f6', order: 0 },
  { id: 'col-done', title: 'Done', color: '#22c55e', order: 1 },
];

const task = (id, title, columnId = 'col-todo') => ({
  id, title, description: '', labels: [], columnId,
  worktreePath: null, sessionIds: [], order: 0,
  createdAt: 1, updatedAt: 1,
});

/** Replace the project wholesale, the way a reload from disk does. */
function writeFromAnotherProcess(tasks) {
  const { projects } = projectsState.get();
  projectsState.set({
    projects: projects.map(p => (p.id === 'p1' ? { ...p, tasks } : p)),
  });
}

const titles = (container) =>
  Array.from(container.querySelectorAll('.kanban-card-title')).map(el => el.textContent.trim());

describe('kanban board live refresh', () => {
  let container;
  let project;

  beforeEach(() => {
    project = {
      id: 'p1', name: 'narvi', path: '/tmp/narvi', type: 'standalone', folderId: null,
      kanbanColumns: COLUMNS, kanbanLabels: [], tasks: [task('t1', 'first')],
    };
    projectsState.set({ projects: [project], folders: [], rootOrder: ['p1'] });

    container = document.createElement('div');
    document.body.appendChild(container);
    KanbanPanel.render(container, project);
  });

  afterEach(() => {
    container.remove();
    projectsState.set({ projects: [], folders: [], rootOrder: [] });
  });

  test('renders the tasks it was given', () => {
    expect(titles(container)).toEqual(['first']);
  });

  test('picks up a task written by another process', async () => {
    writeFromAnotherProcess([task('t1', 'first'), task('t2', 'from an MCP session')]);
    await flush();

    expect(titles(container)).toEqual(['first', 'from an MCP session']);
  });

  test('picks up a task moved to another column', async () => {
    writeFromAnotherProcess([task('t1', 'first', 'col-done')]);
    await flush();

    const done = container.querySelector('[data-col-id="col-done"]');
    expect(done.textContent).toContain('first');
  });

  test('keeps following after a refresh it triggered itself', async () => {
    writeFromAnotherProcess([task('t1', 'first'), task('t2', 'second')]);
    await flush();
    writeFromAnotherProcess([task('t1', 'first'), task('t2', 'second'), task('t3', 'third')]);
    await flush();

    expect(titles(container)).toEqual(['first', 'second', 'third']);
  });

  test('ignores state changes that leave the board identical', async () => {
    const board = container.querySelector('.kanban-board');
    projectsState.set({ selectedProjectFilter: 0 });
    await flush();

    // Same element: nothing was rebuilt, so an open drag or focus survives.
    expect(container.querySelector('.kanban-board')).toBe(board);
  });

  test('stops following once the board leaves the DOM', async () => {
    container.remove();
    writeFromAnotherProcess([task('t1', 'first'), task('t2', 'second')]);
    await flush();

    // The detached board is not rebuilt, and state still holds the new task.
    expect(titles(container)).toEqual(['first']);
    expect(getTasks('p1')).toHaveLength(2);
  });
});
