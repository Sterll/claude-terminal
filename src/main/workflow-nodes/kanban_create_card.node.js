'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_COLUMNS = [
  { id: 'col-todo',       title: 'To Do',       color: '#3b82f6', order: 0 },
  { id: 'col-inprogress', title: 'In Progress', color: '#f59e0b', order: 1 },
  { id: 'col-done',       title: 'Done',        color: '#22c55e', order: 2 },
];

function resolveVars(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
    const parts = key.split('.');
    let cur = vars instanceof Map ? vars.get(parts[0]) : vars?.[parts[0]];
    for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
    return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
  });
}

function projectsFile() {
  return path.join(os.homedir(), '.claude-terminal', 'projects.json');
}

function loadProjects() {
  const file = projectsFile();
  if (!fs.existsSync(file)) return { projects: [], folders: [], rootOrder: [] };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveProjects(data) {
  const file = projectsFile();
  const tmp  = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function findProject(data, ref) {
  if (!ref) return null;
  const needle = String(ref).toLowerCase();
  return data.projects.find(p =>
    p.id === ref ||
    (p.name || '').toLowerCase() === needle ||
    (p.name || '').toLowerCase().includes(needle) ||
    path.basename(p.path || '').toLowerCase() === needle
  ) || null;
}

function getColumns(project) {
  const cols = project.kanbanColumns;
  if (cols && cols.length > 0) return [...cols].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return [...DEFAULT_COLUMNS];
}

function findColumn(project, ref) {
  const cols = getColumns(project);
  if (!ref) return cols[0];
  const needle = String(ref).toLowerCase();
  return cols.find(c =>
    c.id === ref ||
    c.title.toLowerCase() === needle ||
    c.title.toLowerCase().includes(needle)
  ) || null;
}

function generateId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

module.exports = {
  type:     'workflow/kanban_create_card',
  title:    'Kanban: Create Card',
  desc:     'Crée une carte Kanban dans un projet',
  color:    'purple',
  width:    240,
  category: 'actions',
  icon:     'kanban',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',     type: 'exec'   },
    { name: 'Error',    type: 'exec'   },
    { name: 'taskId',   type: 'string' },
    { name: 'columnId', type: 'string' },
  ],

  props: {
    projectId:   '',
    title:       '',
    description: '',
    column:      '',
    priority:    '',
    dueDate:     '',
  },

  fields: [
    { type: 'cwd-picker', key: 'projectId', label: 'wfn.kanban.project.label',
      hint: 'wfn.kanban.project.hint' },
    { type: 'text',     key: 'title',       label: 'wfn.kanban.title.label',
      placeholder: 'Implement feature X' },
    { type: 'textarea', key: 'description', label: 'wfn.kanban.description.label',
      placeholder: 'Task context or acceptance criteria' },
    { type: 'text',     key: 'column',      label: 'wfn.kanban.column.label',
      hint: 'wfn.kanban.column.hint',
      placeholder: 'To Do' },
    { type: 'select',   key: 'priority',    label: 'wfn.kanban.priority.label',
      options: ['', 'p0', 'p1', 'p2', 'p3'] },
    { type: 'text',     key: 'dueDate',     label: 'wfn.kanban.dueDate.label',
      placeholder: 'YYYY-MM-DD' },
  ],

  badge: () => 'KB',
  drawExtra: (ctx, n) => {
    const title = n.properties.title;
    if (title) {
      ctx.fillStyle = '#888';
      ctx.font = '10px "Cascadia Code","Fira Code",monospace';
      ctx.textAlign = 'left';
      const t = title.length > 28 ? title.slice(0, 28) + '...' : title;
      ctx.fillText('# ' + t, 10, n.size[1] - 6);
    }
  },

  async run(config, vars, signal) {
    if (signal?.aborted) throw new Error('Aborted');

    const title = resolveVars(config.title || '', vars).trim();
    if (!title) throw new Error('Title is required');

    const description = resolveVars(config.description || '', vars);
    const columnRef   = resolveVars(config.column || '', vars);
    const priority    = (config.priority || '').trim() || null;
    const dueDate     = resolveVars(config.dueDate || '', vars).trim() || null;

    // Resolve project
    let projectRef = resolveVars(config.projectId || '', vars);
    const varCtx   = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
    if (!projectRef) projectRef = varCtx.activeProjectId || varCtx.projectId || '';
    if (!projectRef) throw new Error('No project specified (projectId empty, no $ctx.activeProjectId)');

    const data = loadProjects();
    const project = findProject(data, projectRef);
    if (!project) throw new Error(`Project "${projectRef}" not found`);

    if (!project.kanbanColumns || project.kanbanColumns.length === 0) {
      project.kanbanColumns = [...DEFAULT_COLUMNS];
    }

    const col = findColumn(project, columnRef);
    if (!col) {
      const names = getColumns(project).map(c => `"${c.title}"`).join(', ');
      throw new Error(`Column "${columnRef}" not found. Available: ${names}`);
    }

    if (!project.tasks) project.tasks = [];
    const order = project.tasks.filter(t => t.columnId === col.id).length;
    const now   = Date.now();
    const task  = {
      id:           generateId(),
      title,
      description:  description || '',
      labels:       [],
      columnId:     col.id,
      worktreePath: null,
      sessionIds:   [],
      priority,
      dueDate,
      order,
      createdAt:    now,
      updatedAt:    now,
    };

    project.tasks.push(task);
    saveProjects(data);

    return {
      taskId:      task.id,
      columnId:    col.id,
      projectId:   project.id,
      projectName: project.name || path.basename(project.path || ''),
      title:       task.title,
    };
  },
};
