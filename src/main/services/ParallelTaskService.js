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
const { createWorktree, removeWorktree, gitMerge, gitMergeAbort, getMergeConflicts, checkoutBranch, createBranch, isMergeInProgress, execGit } = require('../utils/git');
const chatService = require('./ChatService');

const HISTORY_FILE = path.join(os.homedir(), '.claude-terminal', 'parallel-runs.json');
const MAX_HISTORY = 20;

class ParallelTaskService {
  constructor() {
    /** @type {Map<string, { abortControllers: Map<string, AbortController> }>} */
    this._active = new Map();
    /** @type {Map<string, { projectPath, mainBranch, goal, model, effort, startedAt, tasks: Map }>} */
    this._runStates = new Map();
    this._mainWindow = null;
  }

  setMainWindow(mainWindow) {
    this._mainWindow = mainWindow;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start a parallel run. Returns immediately with runId; executes async.
   */
  async startRun({ projectPath, mainBranch, goal, maxTasks = 4, autoTasks = false, model, effort }) {

    const runId = `ptask-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const startedAt = parseInt(runId.split('-')[1], 10);
    this._active.set(runId, { abortControllers: new Map() });
    this._runStates.set(runId, { projectPath, mainBranch, goal, model, effort, startedAt, tasks: new Map() });

    // Fire and forget — errors are caught internally
    this._executeRun({ runId, projectPath, mainBranch, goal, maxTasks, autoTasks, model, effort })
      .catch(err => {
        console.error('[ParallelTaskService] Unexpected run error:', err);
        this._send('parallel-run-status', { runId, phase: 'failed', error: err.message });
        this._active.delete(runId);
        const state = this._runStates.get(runId);
        if (state && state.tasks.size > 0) {
          this._appendHistory({ id: runId, projectPath: state.projectPath, mainBranch: state.mainBranch, goal: state.goal, phase: 'failed', startedAt: state.startedAt, endedAt: Date.now(), error: err.message });
        } else {
          this._runStates.delete(runId);
        }
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
    const state = this._runStates.get(runId);
    if (state && state.tasks.size > 0) {
      this._appendHistory({ id: runId, projectPath: state.projectPath, mainBranch: state.mainBranch, goal: state.goal, phase: 'cancelled', startedAt: state.startedAt, endedAt: Date.now() });
    } else {
      this._runStates.delete(runId);
    }
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
      // Collect branch names from history before removing worktrees
      const branches = [];
      const history = this.getHistory();
      const run = history.find(r => r.id === runId);
      if (run?.tasks) {
        for (const task of run.tasks) {
          if (task.branch) branches.push(task.branch);
        }
      }

      // Remove worktrees
      if (fs.existsSync(worktreeBase)) {
        const entries = fs.readdirSync(worktreeBase);
        for (const entry of entries) {
          const worktreePath = path.join(worktreeBase, entry);
          await removeWorktree(projectPath, worktreePath, true).catch(() => {});
        }
        fs.rmSync(worktreeBase, { recursive: true, force: true });
      }

      // Delete associated branches
      for (const branch of branches) {
        await new Promise(resolve => {
          require('child_process').execFile('git', ['-c', `safe.directory=${projectPath.replace(/\\/g, '/')}`, 'branch', '-D', branch], { cwd: projectPath, timeout: 10000 }, () => resolve());
        });
      }

      // Remove from disk history
      this.removeFromHistory(runId);

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  removeFromHistory(runId) {
    try {
      if (!fs.existsSync(HISTORY_FILE)) return { success: true };
      let all = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (!Array.isArray(all)) return { success: true };
      all = all.filter(r => r.id !== runId);
      const tmp = HISTORY_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
      fs.renameSync(tmp, HISTORY_FILE);
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

  async _executeRun({ runId, projectPath, mainBranch, goal, maxTasks, autoTasks, model, effort }) {
    let tasks;
    let featureName = null;
    let feedback = null;

    // ── Phase 1 (+1b loop): Decompose → Review → Refine ─────────────────────
    while (true) {
      this._send('parallel-run-status', { runId, phase: 'decomposing' });

      try {
        const decomposed = await this._decomposeTasks({ projectPath, goal, maxTasks, autoTasks, model, effort, feedback });
        tasks = decomposed.tasks;
        featureName = decomposed.featureName;
      } catch (err) {
        this._send('parallel-run-status', { runId, phase: 'failed', error: `Decomposition failed: ${err.message}` });
        this._active.delete(runId);
        this._runStates.delete(runId); // no tasks to persist
        return;
      }

      if (!tasks || tasks.length === 0) {
        this._send('parallel-run-status', { runId, phase: 'failed', error: 'No tasks generated' });
        this._active.delete(runId);
        return;
      }

      // Store featureName for history persistence
      const runState = this._runStates.get(runId);
      if (runState && featureName) runState.featureName = featureName;

      // Pause for user review
      this._send('parallel-run-status', { runId, phase: 'reviewing', proposedTasks: tasks, featureName });

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
      this._runStates.delete(runId); // no tasks to persist
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

    this._appendHistory({
      id: runId,
      projectPath,
      mainBranch,
      goal,
      phase: 'done',
      startedAt: parseInt(runId.split('-')[1], 10),
      endedAt,
    });
  }

  async _decomposeTasks({ projectPath, goal, maxTasks, autoTasks, model, effort, feedback }) {
    const prompt = this._buildDecomposePrompt(goal, maxTasks, autoTasks, feedback);

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

    // Validate and cap at maxTasks (skip cap if autoTasks — Claude decided)
    const featureName = this._sanitizeBranchSuffix(String(result.featureName || '').slice(0, 20)) || null;
    const cappedList = autoTasks ? taskList : taskList.slice(0, maxTasks);
    const validated = cappedList.map(t => ({
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
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: [
            '## Parallel Task Mode',
            '',
            'You are working on a single isolated sub-task inside a dedicated git worktree.',
            'This is a fully autonomous execution — there is no human to interact with.',
            '',
            'RULES:',
            '- Implement the task completely and autonomously. Do NOT ask questions or request clarification.',
            '- Do NOT use AskUserQuestion, EnterPlanMode, or ExitPlanMode — they are disabled.',
            '- Make all necessary decisions yourself using best judgment.',
            '- Write clean, working code. Commit your changes when done with a descriptive message. Never mention AI, Claude, or any assistant in commit messages or code comments.',
            '- If something is ambiguous, pick the most reasonable approach and proceed.',
            '- Be concise in your output — focus on implementation, not explanation.',
            '- You have full permissions (bypassPermissions) — use tools freely without hesitation.',
          ].join('\n'),
        },
        disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
        signal: ac.signal,
        onOutput: (chunk) => {
          this._send('parallel-task-output', { runId, taskId: task.id, chunk });
        }
      });

      // Auto-commit any uncommitted changes so git diff branch1...branch2 works
      await this._autoCommitWorktree(task.worktreePath, task.title);

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

  // ─── Merge ──────────────────────────────────────────────────────────────────

  /**
   * Merge all task branches into a unified branch `parallel/{feature}/all`.
   * Resolves conflicts via Claude agent when possible, skips on failure.
   */
  async mergeRun(runId) {
    // Load run from disk history
    const history = this.getHistory();
    const run = history.find(r => r.id === runId);
    if (!run) return { success: false, error: 'Run not found in history' };

    const { projectPath, mainBranch, featureName, model, effort } = run;
    const doneTasks = (run.tasks || []).filter(t => t.status === 'done' && t.branch);
    if (doneTasks.length === 0) return { success: false, error: 'No completed tasks to merge' };

    const featureSlug = this._sanitizeBranchSuffix(featureName || 'feature').slice(0, 20);
    const mergeBranch = `parallel/${featureSlug}/all`;

    // Emit merging phase
    this._send('parallel-run-status', { runId, phase: 'merging', mergeBranch });

    try {
      // Checkout main branch first
      const coResult = await checkoutBranch(projectPath, mainBranch);
      if (!coResult.success) {
        this._send('parallel-run-status', { runId, phase: 'done', error: `Failed to checkout ${mainBranch}: ${coResult.error}` });
        return { success: false, error: coResult.error };
      }

      // Create the unified branch
      const brResult = await createBranch(projectPath, mergeBranch);
      if (!brResult.success) {
        // Branch may already exist — try checkout instead
        const co2 = await checkoutBranch(projectPath, mergeBranch);
        if (!co2.success) {
          this._send('parallel-run-status', { runId, phase: 'done', error: `Failed to create branch ${mergeBranch}` });
          return { success: false, error: `Failed to create branch: ${brResult.error}` };
        }
      }

      const merged = [];
      const skipped = [];

      for (let i = 0; i < doneTasks.length; i++) {
        const task = doneTasks[i];

        // Emit progress
        this._send('parallel-run-status', {
          runId, phase: 'merging', mergeBranch,
          mergeProgress: { current: i + 1, total: doneTasks.length, branch: task.branch }
        });

        // Attempt merge
        const mergeResult = await gitMerge(projectPath, task.branch);
        if (mergeResult.success) {
          merged.push(task.branch);
          continue;
        }

        // Conflict — try auto-resolve with Claude
        if (mergeResult.hasConflicts) {
          const resolved = await this._resolveConflicts(projectPath, task.branch, model || 'claude-sonnet-4-6', effort || 'high');
          if (resolved) {
            merged.push(task.branch);
            continue;
          }
        }

        // Failed — abort and skip
        await gitMergeAbort(projectPath).catch(() => {});
        skipped.push({ branch: task.branch, error: mergeResult.error || 'Merge failed' });
      }

      // Emit merged phase
      this._send('parallel-run-status', {
        runId, phase: 'merged', mergeBranch,
        mergeResult: { merged: merged.length, skipped }
      });

      // Update history on disk
      this._updateHistoryPhase(runId, 'merged', { mergeBranch });

      return { success: true, mergeBranch, merged: merged.length, skipped };
    } catch (err) {
      this._send('parallel-run-status', { runId, phase: 'done', error: `Merge failed: ${err.message}` });
      return { success: false, error: err.message };
    }
  }

  /**
   * Cancel a completed merge: delete merge branch, task branches, worktrees, and history.
   * Full cleanup — everything related to this run is removed.
   */
  async cancelMerge(runId) {
    const history = this.getHistory();
    const run = history.find(r => r.id === runId);
    if (!run) return { success: false, error: 'Run not found' };

    const { projectPath, mainBranch, mergeBranch } = run;

    try {
      // Checkout main so we can delete the merge branch (can't delete current branch)
      const coResult = await checkoutBranch(projectPath, mainBranch);
      if (!coResult.success) {
        console.error('[cancelMerge] checkout failed:', coResult.error);
      }

      // Delete merge branch — use array args to avoid parsing issues
      if (mergeBranch) {
        const delResult = await execGit(projectPath, ['branch', '-D', mergeBranch], 10000);
        if (delResult === null) {
          // Force delete via raw command if normal delete fails
          console.warn('[cancelMerge] branch -D failed, retrying with execFile');
          await new Promise(resolve => {
            require('child_process').execFile('git', ['branch', '-D', mergeBranch], { cwd: projectPath, timeout: 10000 }, (err) => {
              if (err) console.error('[cancelMerge] force delete failed:', err.message);
              resolve();
            });
          });
        }
      }

      // Full cleanup: worktrees + task branches + history removal
      await this.cleanupRun(runId, projectPath);

      // Notify renderer
      this._send('parallel-run-status', { runId, phase: 'cancelled' });

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Try to resolve merge conflicts via Claude agent.
   * Returns true if conflicts were resolved, false otherwise.
   */
  async _resolveConflicts(projectPath, branchName, model, effort) {
    try {
      const conflicts = await getMergeConflicts(projectPath);
      if (conflicts.length === 0) return true;

      await chatService.runSinglePrompt({
        cwd: projectPath,
        prompt: `Resolve the merge conflicts from merging branch "${branchName}". Conflicted files: ${conflicts.join(', ')}. Read each file, resolve all conflict markers, then run: git add -A && git commit --no-edit`,
        model,
        effort,
        maxTurns: 20,
        permissionMode: 'bypassPermissions',
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: [
            '## Merge Conflict Resolution',
            '',
            'You are resolving git merge conflicts in a repository.',
            '',
            'RULES:',
            '- Read each conflicted file and resolve the conflict markers (<<<<<<, ======, >>>>>>)',
            '- Keep ALL changes from both sides — integrate both features',
            '- After resolving all files, stage them with git add -A and complete the merge with git commit --no-edit',
            '- Do NOT discard functionality from either side',
            '- Be concise, focus on correct resolution',
            '- Never mention AI or Claude in commit messages',
          ].join('\n'),
        },
        disallowedTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
      });

      // Check if conflicts are actually resolved
      const remaining = await getMergeConflicts(projectPath);
      if (remaining.length === 0 && !(await isMergeInProgress(projectPath))) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Update a run's phase in the history file without deleting runState.
   */
  _updateHistoryPhase(runId, phase, extra = {}) {
    try {
      if (!fs.existsSync(HISTORY_FILE)) return;
      const all = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      const idx = all.findIndex(r => r.id === runId);
      if (idx >= 0) {
        all[idx] = { ...all[idx], phase, ...extra };
        const tmp = HISTORY_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
        fs.renameSync(tmp, HISTORY_FILE);
      }
    } catch (_) {}
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Auto-commit any uncommitted changes in a worktree so branch diff works.
   * Non-blocking — silently skips if nothing to commit.
   */
  _autoCommitWorktree(worktreePath, taskTitle) {
    return new Promise((resolve) => {
      // git add -A && git diff --cached --quiet || git commit -m "..."
      // If diff --cached --quiet exits 0 = nothing staged, skip commit
      const msg = `feat: ${(taskTitle || 'task').slice(0, 60)}`;
      const cmd = `git add -A && (git diff --cached --quiet || git commit -m "${msg.replace(/"/g, '\\"')}")`;
      require('child_process').exec(cmd, { cwd: worktreePath, timeout: 15000 }, (err) => {
        if (err) console.log(`[ParallelTaskService] Auto-commit skipped: ${err.message}`);
        resolve();
      });
    });
  }

  _buildDecomposePrompt(goal, maxTasks, autoTasks, feedback) {
    const taskCountInstruction = autoTasks
      ? `Decompose this into the OPTIMAL number of INDEPENDENT sub-tasks (typically 2–5, never more than 8 — use your judgment to pick the right granularity for this goal)`
      : `Decompose this into ${maxTasks} or fewer INDEPENDENT sub-tasks`;

    return `You are a senior software architect helping decompose a feature into parallel implementation tasks.

Feature goal: ${goal}${feedback ? `\n\nRevision request from the user: ${feedback}\n\nRevise the task breakdown according to this feedback.` : ''}

${taskCountInstruction} that can be implemented simultaneously without conflicting file edits (no two tasks should write to the same file).

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
    // Track task state for persistence on run end
    if (channel === 'parallel-task-update') {
      const { runId, taskId, ...rest } = data;
      const state = this._runStates.get(runId);
      if (state) {
        const existing = state.tasks.get(taskId) || {};
        state.tasks.set(taskId, { ...existing, id: taskId, ...rest });
      }
    }
  }

  _appendHistory({ id: runId, projectPath, mainBranch, goal, phase, startedAt, endedAt, error }) {
    try {
      const state = this._runStates.get(runId);
      // Persist tasks without the output field (too large, not useful after the fact)
      const tasks = state
        ? [...state.tasks.values()].map(({ output, ...t }) => t)
        : [];

      const entry = {
        id: runId,
        projectPath,
        mainBranch,
        goal,
        featureName: state?.featureName || null,
        model: state?.model || null,
        effort: state?.effort || null,
        phase,
        startedAt,
        endedAt,
        error: error || null,
        tasks,
      };

      const dir = path.dirname(HISTORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let all = [];
      if (fs.existsSync(HISTORY_FILE)) {
        try { all = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (_) {}
      }
      if (!Array.isArray(all)) all = [];

      // Replace existing entry if same runId, otherwise prepend
      const existingIdx = all.findIndex(r => r.id === runId);
      if (existingIdx >= 0) {
        all[existingIdx] = entry;
      } else {
        all.unshift(entry);
      }
      all = all.slice(0, MAX_HISTORY);

      // Atomic write
      const tmp = HISTORY_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8');
      fs.renameSync(tmp, HISTORY_FILE);

      this._runStates.delete(runId);
    } catch (err) {
      console.error('[ParallelTaskService] Failed to save history:', err.message);
    }
  }
}

module.exports = new ParallelTaskService();
