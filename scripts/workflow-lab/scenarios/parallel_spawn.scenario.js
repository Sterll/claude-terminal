'use strict';

const path = require('path');
const { assert } = require('../sandbox');

/**
 * parallel_spawn is the one node whose real side effect is irreversible-ish and
 * unbounded: ParallelTaskService.startRun() decomposes a goal with a Claude
 * call, creates a git worktree + branch per sub-task, and launches an agent in
 * each. Running that for real would spawn processes and burn tokens.
 *
 * It does NOT need to be skipped, though: the node reaches the service through
 * a lazy `require('../services/ParallelTaskService')` inside run(), so seeding
 * the require cache with a recording double lets every scenario assert the
 * exact payload the node would have handed the orchestrator — which is where
 * all of the node's own logic lives (clamping, allowlisting, project
 * resolution). The real module is never loaded.
 */

const SERVICE_PATH = require.resolve(
  path.join(__dirname, '..', '..', '..', 'src', 'main', 'services', 'ParallelTaskService')
);

/**
 * Replace ParallelTaskService with a recorder. Returns the call log.
 * @param {(opts:Object)=>Object} [reply] what startRun should resolve with
 */
function stubService(sb, reply = () => ({ success: true, runId: 'ptask-lab-1' })) {
  const calls = [];
  require.cache[SERVICE_PATH] = {
    id: SERVICE_PATH, filename: SERVICE_PATH, loaded: true, exports: {
      async startRun(opts) { calls.push(opts); return reply(opts); },
    },
  };
  sb.startRunCalls = calls;
  return calls;
}

/** The single startRun payload the node built. */
function call(sb) {
  assert.ok(sb.startRunCalls, 'the service double was not installed');
  assert.strictEqual(sb.startRunCalls.length, 1, 'expected exactly one startRun call');
  return sb.startRunCalls[0];
}

function seedProject(sb) {
  sb.dataFile('projects.json', {
    projects: [{ id: 'p1', name: 'Demo App', path: sb.dir }], folders: [], rootOrder: ['p1'],
  });
}

module.exports = {
  type: 'parallel_spawn',
  scenarios: [
    {
      name: 'hands the orchestrator a fully defaulted payload and returns its runId',
      async setup(sb) { stubService(sb); },
      config: (sb) => ({ projectId: sb.dir, goal: 'Add dark mode' }),
      assert(out, sb) {
        assert.deepStrictEqual(call(sb), {
          projectPath: sb.dir,
          mainBranch:  'main',
          goal:        'Add dark mode',
          maxTasks:    4,
          autoTasks:   false,
          model:       undefined,
          effort:      undefined,
        });
        assert.deepStrictEqual(out, { runId: 'ptask-lab-1', projectPath: sb.dir, goal: 'Add dark mode' });
      },
    },
    {
      name: 'forwards a custom branch, task count and autoTasks flag',
      async setup(sb) { stubService(sb); },
      config: (sb) => ({ projectId: sb.dir, goal: 'Refactor IPC', mainBranch: 'develop', maxTasks: 6, autoTasks: true }),
      assert(out, sb) {
        const c = call(sb);
        assert.strictEqual(c.mainBranch, 'develop');
        assert.strictEqual(c.maxTasks, 6);
        assert.strictEqual(c.autoTasks, true);
      },
    },
    {
      name: 'caps maxTasks at 10 so a typo cannot spawn 99 worktrees',
      async setup(sb) { stubService(sb); },
      config: (sb) => ({ projectId: sb.dir, goal: 'go', maxTasks: 99 }),
      assert(out, sb) {
        assert.strictEqual(call(sb).maxTasks, 10);
      },
    },
    {
      name: 'floors a negative maxTasks at 1',
      async setup(sb) { stubService(sb); },
      config: (sb) => ({ projectId: sb.dir, goal: 'go', maxTasks: -5 }),
      assert(out, sb) {
        assert.strictEqual(call(sb).maxTasks, 1);
      },
    },
    {
      name: 'treats an unparseable maxTasks as the default of 4',
      async setup(sb) { stubService(sb); },
      config: (sb) => ({ projectId: sb.dir, goal: 'go', maxTasks: '' }),
      assert(out, sb) {
        assert.strictEqual(call(sb).maxTasks, 4);
      },
    },
    {
      name: 'forwards a supported model and effort',
      async setup(sb) { stubService(sb); },
      config: (sb) => ({ projectId: sb.dir, goal: 'go', model: 'opus', effort: 'high' }),
      assert(out, sb) {
        const c = call(sb);
        assert.strictEqual(c.model, 'opus');
        assert.strictEqual(c.effort, 'high');
      },
    },
    {
      name: 'drops an unsupported model and effort rather than passing them through',
      async setup(sb) { stubService(sb); },
      config: (sb) => ({ projectId: sb.dir, goal: 'go', model: 'gpt-4o', effort: 'max' }),
      assert(out, sb) {
        const c = call(sb);
        assert.strictEqual(c.model, undefined);
        assert.strictEqual(c.effort, undefined);
      },
    },
    {
      name: 'interpolates $variables into the goal and branch',
      async setup(sb) {
        stubService(sb);
        sb.vars.set('feature', 'dark mode');
        sb.vars.set('base', 'release/1.3');
      },
      config: (sb) => ({ projectId: sb.dir, goal: '  Implement $feature  ', mainBranch: '$base' }),
      assert(out, sb) {
        const c = call(sb);
        assert.strictEqual(c.goal, 'Implement dark mode');
        assert.strictEqual(c.mainBranch, 'release/1.3');
      },
    },
    {
      name: 'resolves a project by name through projects.json',
      async setup(sb) { stubService(sb); seedProject(sb); },
      config: { projectId: 'Demo App', goal: 'go' },
      assert(out, sb) {
        assert.strictEqual(call(sb).projectPath, sb.dir);
      },
    },
    {
      name: 'uses $ctx.activeProjectId when the picker is empty',
      async setup(sb) {
        stubService(sb);
        seedProject(sb);
        sb.vars.set('ctx', { project: sb.dir, activeProjectId: 'p1' });
      },
      config: { projectId: '', goal: 'go' },
      assert(out, sb) {
        assert.strictEqual(call(sb).projectPath, sb.dir);
      },
    },
    {
      name: 'falls back to the run-context project when the picker is empty',
      async setup(sb) {
        stubService(sb);
        // Exactly the ctx a real WorkflowRunner builds: the project path lives
        // in ctx.project and nothing sets ctx.activeProjectId.
        sb.vars.set('ctx', { project: sb.dir, branch: '', date: '', lastCommit: '', trigger: 'cron' });
      },
      config: { projectId: '', goal: 'go' },
      assert(out, sb) {
        assert.strictEqual(call(sb).projectPath, sb.dir);
      },
    },
    {
      name: 'refuses to spawn a run with no goal',
      async setup(sb) { stubService(sb); },
      config: (sb) => ({ projectId: sb.dir, goal: '   ' }),
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /Goal is required/i);
        assert.strictEqual(sb.startRunCalls.length, 0, 'nothing may be spawned');
      },
    },
    {
      name: 'refuses to spawn a run it cannot locate a project for',
      async setup(sb) { stubService(sb); },
      config: { projectId: 'no-such-project', goal: 'go' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /Project path could not be resolved/i);
        assert.strictEqual(sb.startRunCalls.length, 0, 'nothing may be spawned');
      },
    },
    {
      name: 'surfaces an orchestrator failure as a node error',
      async setup(sb) { stubService(sb, () => ({ success: false, error: 'worktree already exists' })); },
      config: (sb) => ({ projectId: sb.dir, goal: 'go' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /worktree already exists/i);
      },
    },
    {
      name: 'reports a failure with no message rather than resolving silently',
      async setup(sb) { stubService(sb, () => ({ success: false })); },
      config: (sb) => ({ projectId: sb.dir, goal: 'go' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Failed to start parallel run/i);
      },
    },
  ],
};
