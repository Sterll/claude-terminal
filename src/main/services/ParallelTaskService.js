/**
 * ParallelTaskService
 * Orchestrates parallel Claude coding tasks using git worktrees.
 * Flow: decompose goal → create worktrees → run Claude sessions in parallel → report results
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { createWorktree, removeWorktree } = require('../utils/git');
const chatService = require('./ChatService');

const HISTORY_FILE = path.join(os.homedir(), '.claude-terminal', 'parallel-runs.json');
const MAX_HISTORY = 20;

class ParallelTaskService {
  constructor() {
    /** @type {Map<string, { abortControllers: Map<string, AbortController> }>} */
    this._active = new Map();
    this._mainWindow = null;
  }

  setMainWindow(mainWindow) {
    this._mainWindow = mainWindow;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start a parallel run. Returns immediately with runId; executes async.
   */
  async startRun({ projectPath, mainBranch, goal, maxTasks = 4, model, effort }) {

    const runId = `ptask-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    this._active.set(runId, { abortControllers: new Map() });

    // Fire and forget — errors are caught internally
    this._executeRun({ runId, projectPath, mainBranch, goal, maxTasks, model, effort })
      .catch(err => {
        console.error('[ParallelTaskService] Unexpected run error:', err);
        this._send('parallel-run-status', { runId, phase: 'failed', error: err.message });
        this._active.delete(runId);
      });

    return { success: true, runId };
  }

  cancelRun(runId) {
    const active = this._active.get(runId);
    if (!active) return { success: false, error: 'Run not found or already finished' };

    for (const [, ac] of active.abortControllers) {
      try { ac.abort(); } catch (_) {}
    }
    this._active.delete(runId);
    this._send('parallel-run-status', { runId, phase: 'cancelled' });
    return { success: true };
  }

  cancelAllRuns() {
    for (const [runId] of this._active) {
      this.cancelRun(runId);
    }
  }

  async cleanupRun(runId, projectPath) {
    const worktreeBase = this._worktreeBase(runId);
    try {
      if (fs.existsSync(worktreeBase)) {
        const entries = fs.readdirSync(worktreeBase);
        for (const entry of entries) {
          const worktreePath = path.join(worktreeBase, entry);
          await removeWorktree(projectPath, worktreePath, true).catch(() => {});
        }
        fs.rmSync(worktreeBase, { recursive: true, force: true });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  getHistory(projectPath) {
    try {
      if (!fs.existsSync(HISTORY_FILE)) return [];
      const all = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      return Array.isArray(all)
        ? all.filter(r => !projectPath || r.projectPath === projectPath)
        : [];
    } catch (_) {
      return [];
    }
  }

  // ─── Private orchestration ──────────────────────────────────────────────────

  async _executeRun({ runId, projectPath, mainBranch, goal, maxTasks, model, effort }) {
    // ── Phase 1: Decompose ───────────────────────────────────────────────────
    this._send('parallel-run-status', { runId, phase: 'decomposing' });

    let tasks;
    try {
      tasks = await this._decomposeTasks({ runId, projectPath, goal, maxTasks, model, effort });
    } catch (err) {
      this._send('parallel-run-status', { runId, phase: 'failed', error: `Decomposition failed: ${err.message}` });
      this._active.delete(runId);
      return;
    }

    if (!tasks || tasks.length === 0) {
      this._send('parallel-run-status', { runId, phase: 'failed', error: 'No tasks generated' });
      this._active.delete(runId);
      return;
    }

    // ── Phase 2: Create worktrees (sequential to avoid git lock contention) ──
    this._send('parallel-run-status', { runId, phase: 'creating-worktrees' });

    const worktreeBase = this._worktreeBase(runId);

    // Ensure the parent directory for worktrees exists
    try {
      fs.mkdirSync(worktreeBase, { recursive: true });
    } catch (mkdirErr) {
      this._send('parallel-run-status', { runId, phase: 'failed', error: `Failed to create worktree directory: ${mkdirErr.message}` });
      this._active.delete(runId);
      return;
    }

    const enrichedTasks = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskId = `task-${i}`;
      const suffix = this._sanitizeBranchSuffix(task.branchSuffix || task.title);
      const branch = `${mainBranch}-parallel-${suffix}`;
      const worktreePath = path.join(worktreeBase, taskId);

      // Emit task card immediately
      this._send('parallel-task-update', {
        runId, taskId,
        status: 'creating',
        title: task.title,
        description: task.description,
        branch,
        worktreePath,
        error: null
      });

      // Check abort
      if (!this._active.has(runId)) return;

      const result = await createWorktree(projectPath, worktreePath, {
        newBranch: branch,
        startPoint: mainBranch
      });

      if (result.success) {
        this._send('parallel-task-update', { runId, taskId, status: 'pending', branch, worktreePath });
        enrichedTasks.push({ ...task, id: taskId, branch, worktreePath });
      } else {
        this._send('parallel-task-update', {
          runId, taskId, status: 'failed', branch, worktreePath,
          error: result.error || 'Failed to create worktree'
        });
        // Still continue with other tasks
        enrichedTasks.push({ ...task, id: taskId, branch, worktreePath, failed: true });
      }
    }

    // ── Phase 3: Run tasks in parallel ───────────────────────────────────────
    if (!this._active.has(runId)) return;
    this._send('parallel-run-status', { runId, phase: 'running' });

    const runnable = enrichedTasks.filter(t => !t.failed);
    await Promise.allSettled(
      runnable.map(task =>
        this._runTask({ runId, task, model, effort })
      )
    );

    // ── Phase 4: Done ────────────────────────────────────────────────────────
    const endedAt = Date.now();
    this._send('parallel-run-status', { runId, phase: 'done', endedAt });
    this._active.delete(runId);

    // Persist lightweight summary
    this._appendHistory({
      id: runId,
      projectPath,
      mainBranch,
      goal,
      phase: 'done',
      taskCount: tasks.length,
      startedAt: parseInt(runId.split('-')[1], 10),
      endedAt
    });
  }

  async _decomposeTasks({ projectPath, goal, maxTasks, model, effort }) {
    const prompt = this._buildDecomposePrompt(goal, maxTasks);

    // Run decomposition — parse JSON from the text output (more reliable than structured output)
    const result = await chatService.runSinglePrompt({
      cwd: projectPath,
      prompt,
      model: model || 'claude-sonnet-4-6',
      effort: effort || 'high',
      maxTurns: 10,
      permissionMode: 'bypassPermissions',
    });

    if (!result.success && !result.output) {
      throw new Error(result.error || 'Decomposition failed');
    }

    // Extract JSON from the output — Claude wraps it in a markdown code block or outputs raw JSON
    const output = result.output || '';
    const taskList = this._parseTasksFromOutput(output);
    if (!Array.isArray(taskList) || taskList.length === 0) {
      throw new Error(`Could not parse task list from Claude output. Raw output: ${output.slice(0, 500)}`);
    }

    // Validate and cap at maxTasks
    const validated = taskList.slice(0, maxTasks).map(t => ({
      title: String(t.title || 'Task').slice(0, 50),
      description: String(t.description || ''),
      branchSuffix: String(t.branchSuffix || t.title || 'task').slice(0, 30),
      prompt: String(t.prompt || ''),
    })).filter(t => t.prompt.length > 0);

    if (validated.length === 0) {
      throw new Error('No valid tasks found in decomposition output');
    }

    return validated;
  }

  /**
   * Parse a tasks array from Claude's text output.
   * Handles: raw JSON, JSON in ```json code block, JSON in ``` block.
   */
  _parseTasksFromOutput(output) {
    if (!output) return null;

    // Try to extract JSON from code block first
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : output.trim();

    // Try parsing the extracted string as JSON
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    } catch (_) {
      // Fall through to regex extraction
    }

    // Last resort: find a JSON array anywhere in the output
    const arrayMatch = output.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {}
    }

    // Find a JSON object with a tasks array
    const objectMatch = output.match(/\{[\s\S]*?"tasks"[\s\S]*?\}/);
    if (objectMatch) {
      try {
        const parsed = JSON.parse(objectMatch[0]);
        if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
      } catch (_) {}
    }

    return null;
  }

  async _runTask({ runId, task, model, effort }) {
    const active = this._active.get(runId);
    if (!active) return;

    const ac = new AbortController();
    active.abortControllers.set(task.id, ac);

    this._send('parallel-task-update', {
      runId, taskId: task.id, status: 'running',
      branch: task.branch, worktreePath: task.worktreePath
    });

    try {
      await chatService.runSinglePrompt({
        cwd: task.worktreePath,
        prompt: task.prompt,
        model: model || 'claude-sonnet-4-6',
        effort: effort || 'high',
        maxTurns: 50,
        permissionMode: 'bypassPermissions',
        signal: ac.signal,
        onOutput: (chunk) => {
          this._send('parallel-task-output', { runId, taskId: task.id, chunk });
        }
      });

      this._send('parallel-task-update', {
        runId, taskId: task.id, status: 'done',
        branch: task.branch, worktreePath: task.worktreePath
      });
    } catch (err) {
      const cancelled = err.name === 'AbortError' || err.message === 'Aborted' || err.message?.includes('abort');
      this._send('parallel-task-update', {
        runId, taskId: task.id,
        status: cancelled ? 'cancelled' : 'failed',
        branch: task.branch, worktreePath: task.worktreePath,
        error: cancelled ? null : err.message
      });
    } finally {
      if (active) active.abortControllers.delete(task.id);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  _buildDecomposePrompt(goal, maxTasks) {
    return `You are a senior software architect helping decompose a feature into parallel implementation tasks.

Feature goal: ${goal}

Decompose this into ${maxTasks} or fewer INDEPENDENT sub-tasks that can be implemented simultaneously without conflicting file edits (no two tasks should write to the same file).

Rules:
- Each sub-task must be independently implementable in isolation
- Each sub-task's "prompt" must be fully self-contained with all necessary context for Claude Code
- The prompt should instruct Claude to make ONLY the changes relevant to that sub-task, then stop
- branchSuffix must be lowercase-kebab-case, max 30 chars (e.g. "add-jwt-middleware")
- title must be concise (max 50 chars)
- description is one sentence describing the outcome

IMPORTANT: Do not use any tools or read any files. Based solely on the feature description above, respond immediately with a JSON array.

Return ONLY a JSON array of task objects, no other text. Each object must have these fields:
- title: string (max 50 chars)
- description: string (one sentence)
- branchSuffix: string (lowercase-kebab-case, max 30 chars)
- prompt: string (self-contained implementation prompt for Claude Code)

Example format:
[
  {
    "title": "Add JWT middleware",
    "description": "Create JWT validation middleware for Express routes.",
    "branchSuffix": "add-jwt-middleware",
    "prompt": "Create a JWT authentication middleware in src/middleware/auth.js that validates Bearer tokens using the jsonwebtoken package. Export it as a default function. Do not modify any other files."
  }
]`;
  }

  _sanitizeBranchSuffix(raw) {
    return (raw || 'task')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30) || 'task';
  }

  _worktreeBase(runId) {
    return path.join(os.homedir(), '.claude-terminal', 'worktrees', runId);
  }

  _send(channel, data) {
    if (this._mainWindow && !this._mainWindow.isDestroyed()) {
      this._mainWindow.webContents.send(channel, data);
    }
  }

  _appendHistory(summary) {
    try {
      const dir = path.dirname(HISTORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let all = [];
      if (fs.existsSync(HISTORY_FILE)) {
        try { all = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) {}
      }
      if (!Array.isArray(all)) all = [];
      all.unshift(summary);
      all = all.slice(0, MAX_HISTORY);
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(all, null, 2), 'utf8');
    } catch (err) {
      console.error('[ParallelTaskService] Failed to save history:', err.message);
    }
  }
}

module.exports = new ParallelTaskService();
