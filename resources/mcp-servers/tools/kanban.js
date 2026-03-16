'use strict';

/**
 * Kanban Tools Module for Claude Terminal MCP
 *
 * Provides tools to read and manage the kanban board of any project.
 * Reads/writes CT_DATA_DIR/projects.json with atomic writes.
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:kanban] ${args.join(' ')}\n`);
}

// -- Constants ----------------------------------------------------------------

const DEFAULT_COLUMNS = [
  { id: 'col-todo',       title: 'To Do',      color: '#3b82f6', order: 0 },
  { id: 'col-inprogress', title: 'In Progress', color: '#f59e0b', order: 1 },
  { id: 'col-done',       title: 'Done',        color: '#22c55e', order: 2 },
];

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function loadProjects() {
  const file = path.join(getDataDir(), 'projects.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading projects.json:', e.message);
  }
  return { projects: [], folders: [], rootOrder: [] };
}

function saveProjects(data) {
  const file = path.join(getDataDir(), 'projects.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function findProjectInData(data, nameOrId) {
  return data.projects.find(p =>
    p.id === nameOrId ||
    (p.name || '').toLowerCase().includes(nameOrId.toLowerCase()) ||
    path.basename(p.path || '').toLowerCase() === nameOrId.toLowerCase()
  );
}

function getColumns(project) {
  const cols = project.kanbanColumns;
  if (cols && cols.length > 0) return [...cols].sort((a, b) => a.order - b.order);
  return [...DEFAULT_COLUMNS];
}

function findColumn(project, colRef) {
  const cols = getColumns(project);
  return cols.find(c =>
    c.id === colRef ||
    c.title.toLowerCase() === colRef.toLowerCase() ||
    c.title.toLowerCase().includes(colRef.toLowerCase())
  );
}

function findTask(project, taskRef) {
  return (project.tasks || []).find(t =>
    t.id === taskRef ||
    t.title.toLowerCase() === taskRef.toLowerCase() ||
    t.title.toLowerCase().includes(taskRef.toLowerCase())
  );
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// -- Formatters ---------------------------------------------------------------

function formatTask(task, cols) {
  const col = cols.find(c => c.id === task.columnId);
  const colName = col ? col.title : task.columnId;
  const priorityTag = task.priority ? ` [${task.priority.toUpperCase()}]` : '';
  const lines = [`• [${colName}]${priorityTag} ${task.title}`];
  if (task.description) lines.push(`  Description: ${task.description}`);
  if (task.dueDate) lines.push(`  Due: ${task.dueDate}`);
  if (task.worktreePath) lines.push(`  Worktree: ${task.worktreePath}`);
  if (task.sessionIds && task.sessionIds.length) lines.push(`  Sessions: ${task.sessionIds.length}`);
  if (task.labels && task.labels.length) lines.push(`  Labels: ${task.labels.length} label(s)`);
  lines.push(`  ID: ${task.id}`);
  return lines.join('\n');
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'kanban_list_tasks',
    description: 'List kanban tasks for a project. Optionally filter by column. Shows title, column, description, worktree, and session count.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        column:  { type: 'string', description: 'Optional column id or title to filter tasks' },
      },
      required: ['project'],
    },
  },
  {
    name: 'kanban_add_task',
    description: 'Create a new kanban task in a project. Adds to the specified column (or the first column by default).',
    inputSchema: {
      type: 'object',
      properties: {
        project:     { type: 'string', description: 'Project name, folder name, or ID' },
        title:       { type: 'string', description: 'Task title' },
        column:      { type: 'string', description: 'Column id or title (default: first column)' },
        description: { type: 'string', description: 'Optional task description' },
        priority:    { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'], description: 'Priority level: p0 (critical), p1 (high), p2 (medium), p3 (low)' },
        dueDate:     { type: 'string', description: 'Due date in YYYY-MM-DD format' },
      },
      required: ['project', 'title'],
    },
  },
  {
    name: 'kanban_update_task',
    description: 'Update a kanban task fields: title, description, worktree path, priority, or due date.',
    inputSchema: {
      type: 'object',
      properties: {
        project:     { type: 'string', description: 'Project name, folder name, or ID' },
        task:        { type: 'string', description: 'Task id or title (substring match)' },
        title:       { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        worktreePath:{ type: 'string', description: 'Linked git worktree path (empty string to unlink)' },
        priority:    { type: 'string', enum: ['p0', 'p1', 'p2', 'p3', ''], description: 'Priority level (empty string to remove)' },
        dueDate:     { type: 'string', description: 'Due date in YYYY-MM-DD format (empty string to remove)' },
      },
      required: ['project', 'task'],
    },
  },
  {
    name: 'kanban_move_task',
    description: 'Move a kanban task to a different column.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        task:    { type: 'string', description: 'Task id or title (substring match)' },
        column:  { type: 'string', description: 'Target column id or title' },
      },
      required: ['project', 'task', 'column'],
    },
  },
  {
    name: 'kanban_delete_task',
    description: 'Delete a kanban task permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        task:    { type: 'string', description: 'Task id or title (substring match)' },
      },
      required: ['project', 'task'],
    },
  },
  {
    name: 'kanban_list_columns',
    description: 'List the kanban columns of a project with their task counts.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'kanban_add_column',
    description: 'Add a new column to a project\'s kanban board.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        title:   { type: 'string', description: 'Column title' },
        color:   { type: 'string', description: 'Column color as hex (e.g. #8b5cf6). Default: #888888' },
      },
      required: ['project', 'title'],
    },
  },
  {
    name: 'kanban_search',
    description: 'Search kanban tasks across a project by title or description content.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        query:   { type: 'string', description: 'Search term (case-insensitive substring match)' },
      },
      required: ['project', 'query'],
    },
  },
  {
    name: 'kanban_filter',
    description: 'Filter kanban tasks by priority, due date, or column.',
    inputSchema: {
      type: 'object',
      properties: {
        project:      { type: 'string', description: 'Project name, folder name, or ID' },
        priority:     { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'], description: 'Filter by priority level' },
        overdue:      { type: 'boolean', description: 'Filter tasks past their due date' },
        has_due_date: { type: 'boolean', description: 'Filter tasks with (true) or without (false) a due date' },
        column:       { type: 'string', description: 'Filter by column id or title' },
      },
      required: ['project'],
    },
  },
  {
    name: 'kanban_stats',
    description: 'Get kanban board statistics: task counts per column, priorities distribution, overdue count.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
      },
      required: ['project'],
    },
  },
  {
    name: 'kanban_archive',
    description: 'Archive all completed tasks (in the Done column) from the kanban board. Archived tasks are stored separately.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        column:  { type: 'string', description: 'Column to archive from (default: "Done")' },
      },
      required: ['project'],
    },
  },
  {
    name: 'kanban_bulk_move',
    description: 'Move multiple kanban tasks to a target column at once.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        tasks:   { type: 'string', description: 'Comma-separated task IDs or titles' },
        column:  { type: 'string', description: 'Target column id or title' },
      },
      required: ['project', 'tasks', 'column'],
    },
  },
  {
    name: 'kanban_delete_column',
    description: 'Delete a kanban column. Tasks in this column are moved to the first available column.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        column:  { type: 'string', description: 'Column id or title to delete' },
      },
      required: ['project', 'column'],
    },
  },
  {
    name: 'kanban_rename_column',
    description: 'Rename a kanban column.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name, folder name, or ID' },
        column:  { type: 'string', description: 'Current column name or ID' },
        title:   { type: 'string', description: 'New title for the column' },
      },
      required: ['project', 'column', 'title'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok   = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    // ── kanban_list_tasks ────────────────────────────────────────────────────
    if (name === 'kanban_list_tasks') {
      if (!args.project) return fail('Missing required parameter: project');
      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const cols = getColumns(p);
      let tasks = (p.tasks || []);

      if (args.column) {
        const col = findColumn(p, args.column);
        if (!col) {
          const names = cols.map(c => `"${c.title}"`).join(', ');
          return fail(`Column "${args.column}" not found. Available: ${names}`);
        }
        tasks = tasks.filter(t => t.columnId === col.id);
      }

      if (!tasks.length) {
        const name_ = p.name || path.basename(p.path || '?');
        return ok(args.column ? `No tasks in column "${args.column}" for ${name_}.` : `No tasks in ${name_}.`);
      }

      const sorted = [...tasks].sort((a, b) => {
        const colA = cols.findIndex(c => c.id === a.columnId);
        const colB = cols.findIndex(c => c.id === b.columnId);
        if (colA !== colB) return colA - colB;
        return (a.order ?? 0) - (b.order ?? 0);
      });

      const pname = p.name || path.basename(p.path || '?');
      const header = `Kanban tasks for ${pname} (${sorted.length}):\n${'─'.repeat(40)}`;
      const body = sorted.map(t => formatTask(t, cols)).join('\n\n');
      return ok(`${header}\n\n${body}`);
    }

    // ── kanban_add_task ──────────────────────────────────────────────────────
    if (name === 'kanban_add_task') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.title)   return fail('Missing required parameter: title');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      // Ensure columns exist
      if (!p.kanbanColumns || p.kanbanColumns.length === 0) {
        p.kanbanColumns = [...DEFAULT_COLUMNS];
      }

      const cols = getColumns(p);
      let col;
      if (args.column) {
        col = findColumn(p, args.column);
        if (!col) {
          const names = cols.map(c => `"${c.title}"`).join(', ');
          return fail(`Column "${args.column}" not found. Available: ${names}`);
        }
      } else {
        col = cols[0];
      }

      if (!p.tasks) p.tasks = [];
      const order = p.tasks.filter(t => t.columnId === col.id).length;
      const now   = Date.now();
      const task  = {
        id:          generateId('task'),
        title:       args.title.trim(),
        description: args.description || '',
        labels:      [],
        columnId:    col.id,
        worktreePath: null,
        sessionIds:  [],
        priority:    args.priority || null,
        dueDate:     args.dueDate || null,
        order,
        createdAt:   now,
        updatedAt:   now,
      };

      p.tasks.push(task);
      saveProjects(data);

      return ok(`Task created in column "${col.title}":\n  "${task.title}"\n  ID: ${task.id}`);
    }

    // ── kanban_update_task ───────────────────────────────────────────────────
    if (name === 'kanban_update_task') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.task)    return fail('Missing required parameter: task');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      const task = findTask(p, args.task);
      if (!task) return fail(`Task "${args.task}" not found in ${p.name || path.basename(p.path || '?')}.`);

      const updates = [];
      if (args.title !== undefined) {
        task.title = args.title.trim();
        updates.push('title');
      }
      if (args.description !== undefined) {
        task.description = args.description;
        updates.push('description');
      }
      if (args.worktreePath !== undefined) {
        task.worktreePath = args.worktreePath || null;
        updates.push('worktreePath');
      }
      if (args.priority !== undefined) {
        task.priority = args.priority || null;
        updates.push('priority');
      }
      if (args.dueDate !== undefined) {
        task.dueDate = args.dueDate || null;
        updates.push('dueDate');
      }

      if (!updates.length) return fail('No updates provided. Specify title, description, worktreePath, priority, or dueDate.');

      task.updatedAt = Date.now();
      saveProjects(data);

      return ok(`Task updated (${updates.join(', ')}):\n  "${task.title}"\n  ID: ${task.id}`);
    }

    // ── kanban_move_task ─────────────────────────────────────────────────────
    if (name === 'kanban_move_task') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.task)    return fail('Missing required parameter: task');
      if (!args.column)  return fail('Missing required parameter: column');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      const task = findTask(p, args.task);
      if (!task) return fail(`Task "${args.task}" not found in ${p.name || path.basename(p.path || '?')}.`);

      const col = findColumn(p, args.column);
      if (!col) {
        const cols = getColumns(p);
        const names = cols.map(c => `"${c.title}"`).join(', ');
        return fail(`Column "${args.column}" not found. Available: ${names}`);
      }

      if (task.columnId === col.id) {
        return ok(`Task "${task.title}" is already in column "${col.title}".`);
      }

      const prevColId = task.columnId;
      const newOrder  = (p.tasks || []).filter(t => t.columnId === col.id).length;

      // Shift orders in source column
      for (const t of (p.tasks || [])) {
        if (t.columnId === prevColId && t.order > task.order) t.order -= 1;
      }

      task.columnId  = col.id;
      task.order     = newOrder;
      task.updatedAt = Date.now();
      saveProjects(data);

      const cols = getColumns(p);
      const prevCol = cols.find(c => c.id === prevColId);
      return ok(`Task moved:\n  "${task.title}"\n  ${prevCol ? prevCol.title : prevColId} → ${col.title}`);
    }

    // ── kanban_delete_task ───────────────────────────────────────────────────
    if (name === 'kanban_delete_task') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.task)    return fail('Missing required parameter: task');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      const task = findTask(p, args.task);
      if (!task) return fail(`Task "${args.task}" not found in ${p.name || path.basename(p.path || '?')}.`);

      const title = task.title;
      p.tasks = (p.tasks || []).filter(t => t.id !== task.id);
      saveProjects(data);

      return ok(`Task deleted: "${title}"`);
    }

    // ── kanban_list_columns ──────────────────────────────────────────────────
    if (name === 'kanban_list_columns') {
      if (!args.project) return fail('Missing required parameter: project');
      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const cols  = getColumns(p);
      const tasks = p.tasks || [];
      const pname = p.name || path.basename(p.path || '?');

      const lines = cols.map(c => {
        const count = tasks.filter(t => t.columnId === c.id).length;
        return `  ${c.title} (${count} task${count !== 1 ? 's' : ''})  [id: ${c.id}]`;
      });

      return ok(`Kanban columns for ${pname} (${cols.length}):\n${lines.join('\n')}`);
    }

    // ── kanban_add_column ────────────────────────────────────────────────────
    if (name === 'kanban_add_column') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.title)   return fail('Missing required parameter: title');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      if (!p.kanbanColumns || p.kanbanColumns.length === 0) {
        p.kanbanColumns = [...DEFAULT_COLUMNS];
      }

      const maxOrder = Math.max(...p.kanbanColumns.map(c => c.order ?? 0), -1);
      const col = {
        id:    generateId('col'),
        title: args.title.trim(),
        color: args.color || '#888888',
        order: maxOrder + 1,
      };

      p.kanbanColumns.push(col);
      saveProjects(data);

      return ok(`Column created:\n  "${col.title}"  [id: ${col.id}]`);
    }

    // ── kanban_search ─────────────────────────────────────────────────────
    if (name === 'kanban_search') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.query)   return fail('Missing required parameter: query');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const cols  = getColumns(p);
      const tasks = p.tasks || [];
      const query = args.query.toLowerCase();

      const matches = tasks.filter(t =>
        t.title.toLowerCase().includes(query) ||
        (t.description || '').toLowerCase().includes(query)
      );

      const pname = p.name || path.basename(p.path || '?');
      if (!matches.length) return ok(`No tasks matching "${args.query}" in ${pname}.`);

      const header = `Search results for "${args.query}" in ${pname} (${matches.length}):\n${'─'.repeat(40)}`;
      const body   = matches.map(t => formatTask(t, cols)).join('\n\n');
      return ok(`${header}\n\n${body}`);
    }

    // ── kanban_filter ─────────────────────────────────────────────────────
    if (name === 'kanban_filter') {
      if (!args.project) return fail('Missing required parameter: project');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const cols  = getColumns(p);
      let tasks = p.tasks || [];
      const filters = [];

      // Filter by priority
      if (args.priority) {
        tasks = tasks.filter(t => t.priority === args.priority);
        filters.push(`priority=${args.priority.toUpperCase()}`);
      }

      // Filter by overdue
      if (args.overdue === true) {
        const today = new Date().toISOString().slice(0, 10);
        tasks = tasks.filter(t => t.dueDate && t.dueDate < today);
        filters.push('overdue');
      }

      // Filter by has_due_date
      if (args.has_due_date === true) {
        tasks = tasks.filter(t => !!t.dueDate);
        filters.push('has due date');
      } else if (args.has_due_date === false) {
        tasks = tasks.filter(t => !t.dueDate);
        filters.push('no due date');
      }

      // Filter by column
      if (args.column) {
        const col = findColumn(p, args.column);
        if (!col) {
          const names = cols.map(c => `"${c.title}"`).join(', ');
          return fail(`Column "${args.column}" not found. Available: ${names}`);
        }
        tasks = tasks.filter(t => t.columnId === col.id);
        filters.push(`column="${col.title}"`);
      }

      const pname = p.name || path.basename(p.path || '?');
      if (!filters.length) return fail('No filters provided. Specify priority, overdue, has_due_date, or column.');
      if (!tasks.length) return ok(`No tasks matching filters (${filters.join(', ')}) in ${pname}.`);

      const header = `Filtered tasks in ${pname} [${filters.join(', ')}] (${tasks.length}):\n${'─'.repeat(40)}`;
      const body   = tasks.map(t => formatTask(t, cols)).join('\n\n');
      return ok(`${header}\n\n${body}`);
    }

    // ── kanban_stats ──────────────────────────────────────────────────────
    if (name === 'kanban_stats') {
      if (!args.project) return fail('Missing required parameter: project');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found. Use project_list to see available projects.`);

      const cols  = getColumns(p);
      const tasks = p.tasks || [];
      const pname = p.name || path.basename(p.path || '?');
      const today = new Date().toISOString().slice(0, 10);

      // Tasks per column
      const perColumn = cols.map(c => {
        const count = tasks.filter(t => t.columnId === c.id).length;
        return `  ${c.title}: ${count}`;
      });

      // Tasks per priority
      const priorities = ['p0', 'p1', 'p2', 'p3'];
      const perPriority = priorities.map(pr => {
        const count = tasks.filter(t => t.priority === pr).length;
        return `  ${pr.toUpperCase()}: ${count}`;
      });
      const noPriority = tasks.filter(t => !t.priority).length;

      // Overdue
      const overdueCount = tasks.filter(t => t.dueDate && t.dueDate < today).length;

      // Oldest and newest
      let oldest = null;
      let newest = null;
      for (const t of tasks) {
        if (!oldest || (t.createdAt && t.createdAt < oldest.createdAt)) oldest = t;
        if (!newest || (t.createdAt && t.createdAt > newest.createdAt)) newest = t;
      }

      const lines = [
        `Kanban statistics for ${pname}`,
        '─'.repeat(40),
        `Total tasks: ${tasks.length}`,
        '',
        'Tasks per column:',
        ...perColumn,
        '',
        'Tasks per priority:',
        ...perPriority,
        `  No priority: ${noPriority}`,
        '',
        `Overdue tasks: ${overdueCount}`,
      ];

      if (oldest) {
        const oldDate = new Date(oldest.createdAt).toISOString().slice(0, 10);
        lines.push(`Oldest task: "${oldest.title}" (${oldDate})`);
      }
      if (newest) {
        const newDate = new Date(newest.createdAt).toISOString().slice(0, 10);
        lines.push(`Newest task: "${newest.title}" (${newDate})`);
      }

      return ok(lines.join('\n'));
    }

    // ── kanban_archive ────────────────────────────────────────────────────
    if (name === 'kanban_archive') {
      if (!args.project) return fail('Missing required parameter: project');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      const cols       = getColumns(p);
      const columnName = args.column || 'Done';
      const col        = findColumn(p, columnName);
      if (!col) {
        const names = cols.map(c => `"${c.title}"`).join(', ');
        return fail(`Column "${columnName}" not found. Available: ${names}`);
      }

      const tasks     = p.tasks || [];
      const toArchive = tasks.filter(t => t.columnId === col.id);
      if (!toArchive.length) return ok(`No tasks in column "${col.title}" to archive.`);

      // Initialize archived tasks array if needed
      if (!p.archivedTasks) p.archivedTasks = [];

      // Archive each task with a timestamp
      const now = Date.now();
      for (const t of toArchive) {
        t.archivedAt = now;
        p.archivedTasks.push(t);
      }

      // Remove archived tasks from active list
      const archivedIds = new Set(toArchive.map(t => t.id));
      p.tasks = tasks.filter(t => !archivedIds.has(t.id));
      saveProjects(data);

      return ok(`Archived ${toArchive.length} task${toArchive.length !== 1 ? 's' : ''} from column "${col.title}".`);
    }

    // ── kanban_bulk_move ──────────────────────────────────────────────────
    if (name === 'kanban_bulk_move') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.tasks)   return fail('Missing required parameter: tasks');
      if (!args.column)  return fail('Missing required parameter: column');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      const col = findColumn(p, args.column);
      if (!col) {
        const cols = getColumns(p);
        const names = cols.map(c => `"${c.title}"`).join(', ');
        return fail(`Column "${args.column}" not found. Available: ${names}`);
      }

      const refs    = args.tasks.split(',').map(s => s.trim()).filter(Boolean);
      const results = [];
      let movedCount = 0;

      for (const ref of refs) {
        const task = findTask(p, ref);
        if (!task) {
          results.push(`  FAIL: "${ref}" — task not found`);
          continue;
        }
        if (task.columnId === col.id) {
          results.push(`  SKIP: "${task.title}" — already in "${col.title}"`);
          continue;
        }

        const prevColId = task.columnId;
        const newOrder  = (p.tasks || []).filter(t => t.columnId === col.id).length;

        // Shift orders in source column
        for (const t of (p.tasks || [])) {
          if (t.columnId === prevColId && t.order > task.order) t.order -= 1;
        }

        task.columnId  = col.id;
        task.order     = newOrder;
        task.updatedAt = Date.now();
        movedCount++;
        results.push(`  OK: "${task.title}" → "${col.title}"`);
      }

      saveProjects(data);

      const header = `Bulk move to "${col.title}" — ${movedCount}/${refs.length} moved:`;
      return ok(`${header}\n${results.join('\n')}`);
    }

    // ── kanban_delete_column ──────────────────────────────────────────────
    if (name === 'kanban_delete_column') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.column)  return fail('Missing required parameter: column');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      // Ensure columns exist
      if (!p.kanbanColumns || p.kanbanColumns.length === 0) {
        p.kanbanColumns = [...DEFAULT_COLUMNS];
      }

      const col = findColumn(p, args.column);
      if (!col) {
        const names = p.kanbanColumns.map(c => `"${c.title}"`).join(', ');
        return fail(`Column "${args.column}" not found. Available: ${names}`);
      }

      if (p.kanbanColumns.length <= 1) {
        return fail('Cannot delete the last remaining column.');
      }

      // Find first column that is not the one being deleted (by order)
      const remaining = p.kanbanColumns
        .filter(c => c.id !== col.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const fallbackCol = remaining[0];

      // Move orphaned tasks to fallback column
      const tasks = p.tasks || [];
      let movedCount = 0;
      for (const t of tasks) {
        if (t.columnId === col.id) {
          t.columnId  = fallbackCol.id;
          t.order     = tasks.filter(x => x.columnId === fallbackCol.id && x.id !== t.id).length;
          t.updatedAt = Date.now();
          movedCount++;
        }
      }

      // Remove column
      p.kanbanColumns = p.kanbanColumns.filter(c => c.id !== col.id);
      saveProjects(data);

      let msg = `Column "${col.title}" deleted.`;
      if (movedCount > 0) {
        msg += `\n  ${movedCount} task${movedCount !== 1 ? 's' : ''} moved to "${fallbackCol.title}".`;
      }
      return ok(msg);
    }

    // ── kanban_rename_column ──────────────────────────────────────────────
    if (name === 'kanban_rename_column') {
      if (!args.project) return fail('Missing required parameter: project');
      if (!args.column)  return fail('Missing required parameter: column');
      if (!args.title)   return fail('Missing required parameter: title');

      const data = loadProjects();
      const p = findProjectInData(data, args.project);
      if (!p) return fail(`Project "${args.project}" not found.`);

      // Ensure columns exist
      if (!p.kanbanColumns || p.kanbanColumns.length === 0) {
        p.kanbanColumns = [...DEFAULT_COLUMNS];
      }

      // Find the actual column object in p.kanbanColumns (not a copy)
      const col = p.kanbanColumns.find(c =>
        c.id === args.column ||
        c.title.toLowerCase() === args.column.toLowerCase() ||
        c.title.toLowerCase().includes(args.column.toLowerCase())
      );
      if (!col) {
        const names = p.kanbanColumns.map(c => `"${c.title}"`).join(', ');
        return fail(`Column "${args.column}" not found. Available: ${names}`);
      }

      const oldTitle = col.title;
      col.title = args.title.trim();
      saveProjects(data);

      return ok(`Column renamed:\n  "${oldTitle}" → "${col.title}"  [id: ${col.id}]`);
    }

    return fail(`Unknown kanban tool: ${name}`);

  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Kanban error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
