'use strict';

const fs   = require('fs');
const path = require('path');
const { assert } = require('../sandbox');

/**
 * kanban_create_card mutates ~/.claude-terminal/projects.json — the single file
 * that holds every project, folder and quick action the user has. The sandbox
 * gives it a throwaway $HOME, so the node runs for real and each scenario reads
 * the resulting file back off disk instead of trusting the return value.
 */

/** Read the projects.json the node just rewrote, from the fake home. */
function readProjects(sb) {
  return JSON.parse(fs.readFileSync(path.join(sb.home, '.claude-terminal', 'projects.json'), 'utf8'));
}

/** Seed a projects.json with one project. */
function seed(sb, project = {}) {
  sb.dataFile('projects.json', {
    projects: [{ id: 'p1', name: 'Demo App', path: sb.dir, ...project }],
    folders: [],
    rootOrder: ['p1'],
  });
}

module.exports = {
  type: 'kanban_create_card',
  scenarios: [
    {
      name: 'writes the card into the first column and seeds the default board',
      async setup(sb) { seed(sb); },
      config: { projectId: 'p1', title: 'Ship the installer' },
      assert(out, sb) {
        assert.strictEqual(out.columnId, 'col-todo');
        assert.strictEqual(out.projectId, 'p1');
        assert.strictEqual(out.projectName, 'Demo App');
        assert.strictEqual(out.title, 'Ship the installer');

        const project = readProjects(sb).projects[0];
        assert.strictEqual(project.tasks.length, 1);
        const task = project.tasks[0];
        assert.strictEqual(task.id, out.taskId);
        assert.strictEqual(task.title, 'Ship the installer');
        assert.strictEqual(task.columnId, 'col-todo');
        assert.strictEqual(task.order, 0);
        assert.deepStrictEqual(task.labels, []);
        assert.strictEqual(task.priority, null);
        assert.strictEqual(task.dueDate, null);
        assert.ok(task.createdAt > 0 && task.updatedAt === task.createdAt);
        // A project that had never opened the Kanban board now has one.
        assert.deepStrictEqual(project.kanbanColumns.map(c => c.id),
          ['col-todo', 'col-inprogress', 'col-done']);
      },
    },
    {
      name: 'matches a column by a case-insensitive fragment of its title',
      async setup(sb) { seed(sb); },
      config: { projectId: 'p1', title: 'WIP item', column: 'PROGRESS' },
      assert(out, sb) {
        assert.strictEqual(out.columnId, 'col-inprogress');
        assert.strictEqual(readProjects(sb).projects[0].tasks[0].columnId, 'col-inprogress');
      },
    },
    {
      name: 'honours a custom board and picks the lowest-order column by default',
      async setup(sb) {
        seed(sb, {
          kanbanColumns: [
            { id: 'c-later', title: 'Later',   order: 2 },
            { id: 'c-now',   title: 'Now',     order: 0 },
            { id: 'c-next',  title: 'Next',    order: 1 },
          ],
        });
      },
      config: { projectId: 'p1', title: 'Pick me' },
      assert(out, sb) {
        assert.strictEqual(out.columnId, 'c-now');
      },
    },
    {
      name: 'appends after the existing cards of that column only',
      async setup(sb) {
        seed(sb, {
          kanbanColumns: [
            { id: 'col-todo', title: 'To Do', order: 0 },
            { id: 'col-done', title: 'Done',  order: 1 },
          ],
          tasks: [
            { id: 't1', title: 'a', columnId: 'col-todo', order: 0 },
            { id: 't2', title: 'b', columnId: 'col-done', order: 0 },
            { id: 't3', title: 'c', columnId: 'col-todo', order: 1 },
          ],
        });
      },
      config: { projectId: 'p1', title: 'd', column: 'To Do' },
      assert(out, sb) {
        const tasks = readProjects(sb).projects[0].tasks;
        assert.strictEqual(tasks.length, 4, 'existing cards must survive');
        assert.strictEqual(tasks[3].order, 2);
        assert.deepStrictEqual(tasks.map(t => t.id).slice(0, 3), ['t1', 't2', 't3']);
      },
    },
    {
      name: 'interpolates $variables into the title and description',
      async setup(sb) {
        seed(sb);
        sb.vars.set('feature', 'dark mode');
        sb.vars.set('issue', 42);
      },
      config: { projectId: 'p1', title: 'Add $feature', description: 'Closes #$issue in $ctx.project' },
      assert(out, sb) {
        const task = readProjects(sb).projects[0].tasks[0];
        assert.strictEqual(task.title, 'Add dark mode');
        assert.strictEqual(task.description, `Closes #42 in ${sb.dir}`);
      },
    },
    {
      name: 'stores the priority and due date verbatim',
      async setup(sb) { seed(sb); },
      config: { projectId: 'p1', title: 'Urgent', priority: 'p0', dueDate: '2026-09-01' },
      assert(out, sb) {
        const task = readProjects(sb).projects[0].tasks[0];
        assert.strictEqual(task.priority, 'p0');
        assert.strictEqual(task.dueDate, '2026-09-01');
      },
    },
    {
      name: 'finds the project by a fragment of its name',
      async setup(sb) { seed(sb); },
      config: { projectId: 'demo', title: 'By name' },
      assert(out, sb) {
        assert.strictEqual(out.projectId, 'p1');
      },
    },
    {
      name: 'uses $ctx.activeProjectId when the picker is empty',
      async setup(sb) {
        seed(sb);
        sb.vars.set('ctx', { project: sb.dir, activeProjectId: 'p1' });
      },
      config: { title: 'From context' },
      assert(out, sb) {
        assert.strictEqual(out.projectId, 'p1');
        assert.strictEqual(readProjects(sb).projects[0].tasks.length, 1);
      },
    },
    {
      name: 'refuses a card with no title',
      async setup(sb) { seed(sb); },
      config: { projectId: 'p1', title: '   ' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /Title is required/i);
        assert.strictEqual(readProjects(sb).projects[0].tasks, undefined, 'nothing must be written');
      },
    },
    {
      name: 'refuses to guess a project when none is configured or in context',
      async setup(sb) { seed(sb); },
      config: { title: 'Homeless card' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /No project specified/i);
      },
    },
    {
      name: 'reports an unknown project instead of creating one',
      async setup(sb) { seed(sb); },
      config: { projectId: 'nope-xyz', title: 'Card' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /Project "nope-xyz" not found/i);
        assert.strictEqual(readProjects(sb).projects.length, 1);
      },
    },
    {
      name: 'reports an unknown column and names the ones that exist',
      async setup(sb) { seed(sb); },
      config: { projectId: 'p1', title: 'Card', column: 'Archive' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Column "Archive" not found/i);
        assert.match(err.message, /"To Do".*"In Progress".*"Done"/);
      },
    },
    {
      name: 'reports a missing projects.json as a lookup failure',
      // No seed at all: the data dir exists but holds no projects.json.
      config: { projectId: 'p1', title: 'Card' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /not found/i);
      },
    },
    {
      name: 'survives a projects.json that has no "projects" key',
      async setup(sb) { sb.dataFile('projects.json', { folders: [], rootOrder: [] }); },
      config: { projectId: 'p1', title: 'Card' },
      expectThrow: true,
      assert(err) {
        // A legacy or half-written file should surface as "project not found",
        // not as a TypeError from `data.projects.find`.
        assert.match(err.message, /not found/i);
      },
    },
  ],
};
