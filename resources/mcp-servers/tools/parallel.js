'use strict';

/**
 * Parallel Tasks Tools Module for Claude Terminal MCP
 *
 * Provides tools to manage parallel coding tasks (decompose → worktrees → parallel execution → merge).
 * Reads history from CT_DATA_DIR/parallel-runs.json.
 * Write operations use trigger files picked up by the Electron app.
 *
 * Tools: parallel_list_runs, parallel_run_detail, parallel_start_run,
 *        parallel_cancel_run, parallel_cleanup_run, parallel_merge_run
 */

const fs = require('fs');
const path = require('path');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:parallel] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function getProjectPath() {
  return process.env.CT_PROJECT_PATH || '';
}

function loadHistory() {
  const file = path.join(getDataDir(), 'parallel-runs.json');
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {
    log('Error reading parallel-runs.json:', e.message);
  }
  return [];
}

function findRun(identifier) {
  const history = loadHistory();
  // Match by ID (full or partial) or by goal substring
  return history.find(r =>
    r.id === identifier ||
    r.id.includes(identifier) ||
    (r.goal && r.goal.toLowerCase().includes(identifier.toLowerCase()))
  );
}

function writeTrigger(data) {
  const triggerDir = path.join(getDataDir(), 'parallel', 'triggers');
  if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });
  const triggerFile = path.join(triggerDir, `${data.action}_${Date.now()}.json`);
  fs.writeFileSync(triggerFile, JSON.stringify(data), 'utf8');
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return 'N/A';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  return new Date(timestamp).toLocaleString();
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'parallel_list_runs',
    description: 'List parallel task runs for a project. Shows run ID, goal, phase, task count, duration, and branches. Runs decompose a goal into independent sub-tasks executed in parallel via git worktrees.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project path to filter runs. Defaults to current project.' },
        limit: { type: 'number', description: 'Max runs to return (default: 10)' },
      },
    },
  },
  {
    name: 'parallel_run_detail',
    description: 'Get detailed info about a specific parallel run: goal, phase, all tasks with their status, branches, worktree paths, and errors. Use run ID or goal substring to find a run.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'Run ID (full or partial) or goal substring' },
      },
      required: ['run'],
    },
  },
  {
    name: 'parallel_start_run',
    description: 'Start a new parallel task run. Claude decomposes the goal into independent sub-tasks, creates git worktrees, and executes them in parallel. The run starts asynchronously — use parallel_list_runs to check progress.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Feature description to decompose into parallel tasks' },
        max_tasks: { type: 'number', description: 'Maximum number of parallel tasks (2-10, default: 4)' },
        auto_tasks: { type: 'boolean', description: 'Let Claude decide the optimal number of tasks (overrides max_tasks)' },
        main_branch: { type: 'string', description: 'Base branch for worktrees (default: current branch)' },
        model: { type: 'string', description: 'Claude model to use (default: claude-sonnet-4-6)' },
        effort: { type: 'string', description: 'Effort level: low, medium, high (default: high)' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'parallel_cancel_run',
    description: 'Cancel an active parallel run. Aborts all running tasks immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'Run ID (full or partial) or goal substring' },
      },
      required: ['run'],
    },
  },
  {
    name: 'parallel_cleanup_run',
    description: 'Clean up a completed parallel run: remove git worktrees, delete task branches, and remove from history. Use after merging or when results are no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'Run ID (full or partial) or goal substring' },
      },
      required: ['run'],
    },
  },
  {
    name: 'parallel_merge_run',
    description: 'Merge all completed task branches from a parallel run into a unified branch. Creates a temporary merge worktree, merges branches sequentially, and resolves conflicts via Claude. The merged branch is named parallel/<feature>/all.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'Run ID (full or partial) or goal substring' },
      },
      required: ['run'],
    },
  },
];

// -- Handler ------------------------------------------------------------------

async function handle(name, args) {
  const ok   = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    // ── parallel_list_runs ──────────────────────────────────────────────
    if (name === 'parallel_list_runs') {
      const projectPath = args.project || getProjectPath();
      const limit = Math.min(args.limit || 10, 50);
      const history = loadHistory();

      const filtered = projectPath
        ? history.filter(r => r.projectPath === projectPath)
        : history;

      const runs = filtered.slice(0, limit);

      if (runs.length === 0) {
        return ok(projectPath
          ? `No parallel runs found for project: ${projectPath}`
          : 'No parallel runs found.');
      }

      const lines = runs.map(r => {
        const taskCount = (r.tasks || []).length;
        const done = (r.tasks || []).filter(t => t.status === 'done').length;
        const failed = (r.tasks || []).filter(t => t.status === 'failed').length;
        const duration = r.startedAt && r.endedAt
          ? formatDuration(r.endedAt - r.startedAt)
          : (r.phase === 'running' || r.phase === 'decomposing' || r.phase === 'merging')
            ? 'in progress'
            : 'N/A';

        const phaseTag = `[${(r.phase || '?').toUpperCase()}]`;

        let taskSummary = `${done}/${taskCount} done`;
        if (failed > 0) taskSummary += `, ${failed} failed`;

        let line = `${phaseTag} #${r.id.split('-')[1] || r.id}\n`;
        line += `  Goal: ${r.goal || 'N/A'}\n`;
        line += `  Tasks: ${taskSummary} | Duration: ${duration}\n`;
        line += `  Started: ${formatDate(r.startedAt)}`;
        if (r.mergeBranch) line += `\n  Merge branch: ${r.mergeBranch}`;
        if (r.error) line += `\n  Error: ${r.error}`;
        return line;
      });

      let output = `Parallel runs (${runs.length}/${filtered.length}):\n\n${lines.join('\n\n')}`;

      // Include rich markdown block for display
      output += '\n\nDisplay this result using the following markdown block:\n\n```parallel-runs\n';
      for (const r of runs) {
        const taskCount = (r.tasks || []).length;
        const done = (r.tasks || []).filter(t => t.status === 'done').length;
        const failed = (r.tasks || []).filter(t => t.status === 'failed').length;
        const duration = r.startedAt && r.endedAt ? formatDuration(r.endedAt - r.startedAt) : 'in progress';
        let taskSummary = `${done}/${taskCount} done`;
        if (failed > 0) taskSummary += `, ${failed} failed`;
        output += `[${(r.phase || '?').toUpperCase()}] ${r.id.split('-')[1] || r.id}\n`;
        output += `  Goal: ${r.goal || 'N/A'}\n`;
        output += `  Tasks: ${taskSummary}\n`;
        output += `  Duration: ${duration}\n`;
        if (r.error) output += `  Error: ${r.error}\n`;
        output += '\n';
      }
      output += '```';

      return ok(output);
    }

    // ── parallel_run_detail ─────────────────────────────────────────────
    if (name === 'parallel_run_detail') {
      if (!args.run) return fail('Missing required parameter: run');
      const run = findRun(args.run);
      if (!run) return fail(`Run "${args.run}" not found. Use parallel_list_runs to see available runs.`);

      const duration = run.startedAt && run.endedAt
        ? formatDuration(run.endedAt - run.startedAt)
        : 'N/A';

      const tasks = run.tasks || [];
      const statusIcons = { done: '+', failed: 'X', running: '>', cancelled: '-', pending: '.', creating: '~' };

      // Plain text summary for Claude's context
      let output = `Parallel Run: ${run.id}\n`;
      output += `Goal: ${run.goal || 'N/A'} | Phase: ${run.phase || 'unknown'}\n`;
      output += `Feature: ${run.featureName || 'N/A'} | Duration: ${duration}\n`;
      output += `Model: ${run.model || 'N/A'} | Effort: ${run.effort || 'N/A'}\n`;
      if (run.mergeBranch) output += `Merge branch: ${run.mergeBranch}\n`;
      if (run.error) output += `Error: ${run.error}\n`;
      if (tasks.length > 0) {
        output += `\nTasks (${tasks.length}):\n`;
        for (const task of tasks) {
          output += `  [${statusIcons[task.status] || '?'}] ${task.title || task.id} (${task.status})`;
          if (task.branch) output += ` | ${task.branch}`;
          output += '\n';
        }
      }

      const worktreeBase = path.join(getDataDir(), 'worktrees', run.id);
      const worktreesExist = fs.existsSync(worktreeBase);
      output += `\nWorktrees on disk: ${worktreesExist ? 'yes' : 'cleaned up'}`;

      // Include rich markdown block for display
      output += '\n\nDisplay this result using the following markdown block:\n\n```parallel-run\n';
      output += `id: ${run.id}\n`;
      output += `goal: ${run.goal || 'N/A'}\n`;
      output += `phase: ${run.phase || 'unknown'}\n`;
      if (run.featureName) output += `feature: ${run.featureName}\n`;
      output += `model: ${run.model || 'N/A'}\n`;
      output += `effort: ${run.effort || 'N/A'}\n`;
      output += `duration: ${duration}\n`;
      output += `started: ${formatDate(run.startedAt)}\n`;
      if (run.mergeBranch) output += `merge-branch: ${run.mergeBranch}\n`;
      if (run.error) output += `error: ${run.error}\n`;
      if (tasks.length > 0) {
        output += `---\n`;
        for (const task of tasks) {
          output += `[${statusIcons[task.status] || '?'}] ${task.title || task.id}`;
          if (task.branch) output += ` | ${task.branch}`;
          output += '\n';
        }
      }
      output += '```';

      return ok(output);
    }

    // ── parallel_start_run ──────────────────────────────────────────────
    if (name === 'parallel_start_run') {
      if (!args.goal) return fail('Missing required parameter: goal');

      const projectPath = getProjectPath();
      if (!projectPath) return fail('No project path available (CT_PROJECT_PATH not set). Open a project in Claude Terminal first.');

      const maxTasks = Math.max(2, Math.min(10, args.max_tasks || 4));
      const autoTasks = args.auto_tasks || false;
      const mainBranch = args.main_branch || 'main';
      const model = args.model || undefined;
      const effort = args.effort || undefined;

      writeTrigger({
        action: 'start',
        projectPath,
        mainBranch,
        goal: args.goal,
        maxTasks,
        autoTasks,
        model,
        effort,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      });

      return ok(`Parallel run requested for: "${args.goal}"\n\nThe app will decompose the goal into ${autoTasks ? 'an optimal number of' : `up to ${maxTasks}`} parallel tasks.\nNote: The run requires review/confirmation in the Claude Terminal UI before execution begins.\n\nUse parallel_list_runs to check progress.`);
    }

    // ── parallel_cancel_run ─────────────────────────────────────────────
    if (name === 'parallel_cancel_run') {
      if (!args.run) return fail('Missing required parameter: run');

      // Try to find the run in history to get the full ID
      const run = findRun(args.run);
      const runId = run ? run.id : args.run;

      writeTrigger({
        action: 'cancel',
        runId,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      });

      return ok(`Cancel request sent for run: ${runId}\nUse parallel_list_runs to verify.`);
    }

    // ── parallel_cleanup_run ────────────────────────────────────────────
    if (name === 'parallel_cleanup_run') {
      if (!args.run) return fail('Missing required parameter: run');
      const run = findRun(args.run);
      if (!run) return fail(`Run "${args.run}" not found. Use parallel_list_runs to see available runs.`);

      writeTrigger({
        action: 'cleanup',
        runId: run.id,
        projectPath: run.projectPath,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      });

      return ok(`Cleanup request sent for run: ${run.id}\nThis will remove worktrees, delete task branches, and remove from history.`);
    }

    // ── parallel_merge_run ──────────────────────────────────────────────
    if (name === 'parallel_merge_run') {
      if (!args.run) return fail('Missing required parameter: run');
      const run = findRun(args.run);
      if (!run) return fail(`Run "${args.run}" not found. Use parallel_list_runs to see available runs.`);

      if (run.phase !== 'done') {
        return fail(`Run "${run.id}" is in phase "${run.phase}" — only completed runs (phase=done) can be merged.`);
      }

      const doneTasks = (run.tasks || []).filter(t => t.status === 'done');
      if (doneTasks.length === 0) {
        return fail('No completed tasks to merge in this run.');
      }

      writeTrigger({
        action: 'merge',
        runId: run.id,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      });

      return ok(`Merge request sent for run: ${run.id}\nMerging ${doneTasks.length} completed task branch(es) into a unified branch.\nThis may take a while if conflicts need resolution.\n\nUse parallel_list_runs to check progress.`);
    }

    return fail(`Unknown tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Error: ${error.message}`);
  }
}

async function cleanup() {}

module.exports = { tools, handle, cleanup };
