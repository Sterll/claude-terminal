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

    // Unblock review if waiting
    if (active.reviewResolver) {
      active.reviewResolver({ action: 'cancel' });
      active.reviewResolver = null;
    }
    for (const [, ac] of active.abortControllers) {
      try { ac.abort(); } catch (_) {}
    }
    this._active.delete(runId);
    this._send('parallel-run-status', { runId, phase: 'cancelled' });
    return { success: true };
  }

  /**
   * Confirm the proposed tasks and proceed to execution.
   * @param {string} runId
   * @param {Object[]} tasks - confirmed task list (may be the original proposedTasks unchanged)
   */
  confirmRun(runId, tasks) {
    const active = this._active.get(runId);
    if (!active?.reviewResolver) return { success: false, error: 'No pending review' };
    const resolver = active.reviewResolver;
    active.reviewResolver = null;
    resolver({ action: 'confirm', tasks });
    return { success: true };
  }

  /**
   * Request a re-decomposition with user feedback.
   * @param {string} runId
   * @param {string} feedback - natural language modification request
   */
  refineRun(runId, feedback) {
    const active = this._active.get(runId);
    if (!active?.reviewResolver) return { success: false, error: 'No pending review' };
    const resolver = active.reviewResolver;
    active.reviewResolver = null;
    resolver({ action: 'refine', feedback });
    return { success: true };
  }

  /** Pause execution until user confirms or cancels the review. */
  _waitForReview(runId) {
    return new Promise((resolve) => {
      const active = this._active.get(runId);
      if (active) {
        active.reviewResolver = resolve;
      } else {
        resolve({ action: 'cancel' });
      }
    });
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
    let tasks;
    let featureName = null;
    let feedback = null;

    // ── Phase 1 (+1b loop): Decompose → Review → Refine ─────────────────────
    while (true) {
      this._send('parallel-run-status', { runId, phase: 'decomposing' });

      try {
        const decomposed = await this._decomposeTasks({ projectPath, goal, maxTasks, model, effort, feedback });
        tasks = decomposed.tasks;
        featureName = decomposed.featureName;
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

      // Pause for user review
      this._send('parallel-run-status', { runId, phase: 'reviewing', proposedTasks: tasks });

      const decision = await this._waitForReview(runId);

      if (!this._active.has(runId) || decision.action === 'cancel') {
        return; // cancelRun already sent the status + cleaned up
      }

      if (decision.action === 'refine') {
        feedback = decision.feedback;
        continue; // re-decompose with feedback
      }

      // action === 'confirm'
      tasks = decision.tasks || tasks;
      break;
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
    const featureSlug = featureName || this._sanitizeBranchSuffix(goal).slice(0, 20);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskId = `task-${i}`;
      const suffix = this._sanitizeBranchSuffix(task.branchSuffix || task.title);
      const branch = `parallel/${featureSlug}/${suffix}`;
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

  async _decomposeTasks({ projectPath, goal, maxTasks, model, effort, feedback }) {
    const prompt = this._buildDecomposePrompt(goal, maxTasks, feedback);

    // JSON schema for structured output — guarantees valid, parseable JSON without regex hacks
    const outputFormat = {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          featureName: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                branchSuffix: { type: 'string' },
                prompt: { type: 'string' },
              },
              required: ['title', 'description', 'branchSuffix', 'prompt'],
              additionalProperties: false,
            },
          },
        },
        required: ['featureName', 'tasks'],
        additionalProperties: false,
      },
    };

    const result = await chatService.runSinglePrompt({
      cwd: projectPath,
      prompt,
      model: model || 'claude-sonnet-4-6',
      effort: effort || 'high',
      maxTurns: 10,
      permissionMode: 'bypassPermissions',
      outputFormat,
    });

    if (!result.success && !result.output && !result.tasks) {
      throw new Error(result.error || 'Decomposition failed');
    }

    // Structured output: result.tasks is populated directly via Object.assign(result, structured_output)
    // Fallback to text parsing for older SDK versions or if structured output wasn't returned
    let taskList = result.tasks || null;
    if (!taskList) {
      const output = result.output || '';
      taskList = this._parseTasksFromOutput(output);
    }

    if (!Array.isArray(taskList) || taskList.length === 0) {
      throw new Error(`Could not parse task list from Claude output. Raw output: ${(result.output || '').slice(0, 500)}`);
    }

    // Validate and cap at maxTasks
    const featureName = this._sanitizeBranchSuffix(String(result.featureName || '').slice(0, 20)) || null;
    const validated = taskList.slice(0, maxTasks).map(t => ({
      title: String(t.title || 'Task').slice(0, 50),
      description: String(t.description || ''),
      branchSuffix: String(t.branchSuffix || t.title || 'task').slice(0, 30),
      prompt: String(t.prompt || ''),
    })).filter(t => t.prompt.length > 0);

    if (validated.length === 0) {
      throw new Error('No valid tasks found in decomposition output');
    }

    return { tasks: validated, featureName };
  }

  /**
   * Fallback: parse a tasks array from Claude's text output.
   * Used when structured output is unavailable.
   */
  _parseTasksFromOutput(output) {
    if (!output) return null;

    // Strip opening code fence (```json or ```)
    let text = output.replace(/^```(?:json)?\s*\n?/, '').trim();

    // Remove closing fence using lastIndexOf — skips any nested ``` in prompt fields
    const closingFence = text.lastIndexOf('\n```');
    if (closingFence > 0) text = text.slice(0, closingFence).trim();

    // Try direct parse of the cleaned text
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
    } catch (_) {}

    // Find first '[' and parse from there (handles leading prose)
    const arrayStart = text.indexOf('[');
    if (arrayStart >= 0) {
      try {
        const parsed = JSON.parse(text.slice(arrayStart));
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {}
    }

    // Find first '{' for object with tasks array
    const objectStart = text.indexOf('{');
    if (objectStart >= 0) {
      try {
        const parsed = JSON.parse(text.slice(objectStart));
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

  _buildDecomposePrompt(goal, maxTasks, feedback) {
    return `You are a senior software architect helping decompose a feature into parallel implementation tasks.

Feature goal: ${goal}${feedback ? `\n\nRevision request from the user: ${feedback}\n\nRevise the task breakdown according to this feedback.` : ''}

Decompose this into ${maxTasks} or fewer INDEPENDENT sub-tasks that can be implemented simultaneously without conflicting file edits (no two tasks should write to the same file).

Rules:
- Each sub-task must be independently implementable in isolation
- Each sub-task's "prompt" must be fully self-contained with all necessary context for Claude Code
- The prompt should instruct Claude to make ONLY the changes relevant to that sub-task, then stop
- branchSuffix must be lowercase-kebab-case, max 30 chars (e.g. "add-jwt-middleware")
- featureName must be lowercase-kebab-case, max 20 chars, very concise (e.g. "add-2fa", "refactor-auth", "fix-perf")
- title must be concise (max 50 chars)
- description is one sentence describing the outcome

IMPORTANT: Do not use any tools or read any files. Based solely on the feature description above, respond immediately.

Field guide:
- featureName: lowercase-kebab-case, max 20 chars — short name for the whole feature (used as git branch prefix)
- title: task name, max 50 chars
- description: one sentence describing the outcome
- branchSuffix: lowercase-kebab-case, max 30 chars
- prompt: self-contained implementation prompt for Claude Code (include all context needed)`;
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
