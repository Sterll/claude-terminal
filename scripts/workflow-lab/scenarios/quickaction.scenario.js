'use strict';

const os = require('os');
const { assert } = require('../sandbox');

/**
 * quickaction node — resolve a saved command, hand it to a terminal tab.
 *
 * The interesting surface is substitution. A quick action written in the UI may
 * contain $PROJECT_PATH, $BRANCH, $PROJECT_NAME, $HOME or a project env var,
 * and the workflow engine has its own $variable syntax on top. If the two
 * disagree, a command that works when clicked breaks when a workflow runs it —
 * silently, because nothing here waits for an exit code. These scenarios pin
 * both alphabets and their precedence.
 *
 * Delivery itself is a single recorded sendFn call: the node never spawns
 * anything, so "ran" is out of its reach and out of scope for these asserts.
 */

function seedProjects(sb, projects) {
  sb.dataFile('projects.json', { projects, folders: [], rootOrder: projects.map(p => p.id) });
}

function sends(sb) {
  return sb.sent.filter(s => s.channel === 'mcp-terminal:send').map(s => s.payload);
}

const BUILD = { id: 'qa-1', name: 'Build', command: 'npm run build', icon: 'build' };
const DEV   = { id: 'qa-2', name: 'Dev Server', command: 'npm run dev', icon: 'play' };

module.exports = {
  type: 'quickaction',
  scenarios: [
    {
      name: 'runs a quick action by name and reports the command it resolved',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'Billing API', path: sb.dir, quickActions: [BUILD, DEV] }]);
      },
      config: { projectId: 'p-api', action: 'Build' },
      assert(out, sb) {
        assert.deepStrictEqual(out, { command: 'npm run build' });
        assert.deepStrictEqual(sends(sb), [{
          projectId: 'p-api',
          projectName: 'Billing API',
          command: 'npm run build',
          actionId: 'qa-1',
          actionName: 'Build',
          source: 'workflow-quickaction',
        }]);
      },
    },
    {
      name: 'accepts the action id as well as its name',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir, quickActions: [BUILD, DEV] }]);
      },
      config: { projectId: 'p-api', action: 'qa-2' },
      assert(out) {
        assert.strictEqual(out.command, 'npm run dev');
      },
    },
    {
      name: 'matches the action name case-insensitively',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir, quickActions: [DEV] }]);
      },
      config: { projectId: 'p-api', action: 'dev server' },
      assert(out) {
        assert.strictEqual(out.command, 'npm run dev');
      },
    },
    {
      name: 'substitutes $PROJECT_PATH and $PROJECT_NAME exactly as the UI does',
      async setup(sb) {
        seedProjects(sb, [{
          id: 'p-api', name: 'Billing API', path: sb.dir,
          quickActions: [{ id: 'qa', name: 'Ship', command: 'deploy "$PROJECT_NAME" --root $PROJECT_PATH' }],
        }]);
      },
      config: { projectId: 'p-api', action: 'Ship' },
      assert(out, sb) {
        assert.strictEqual(out.command, `deploy "Billing API" --root ${sb.dir}`);
      },
    },
    {
      name: 'substitutes $HOME',
      async setup(sb) {
        seedProjects(sb, [{
          id: 'p-api', name: 'API', path: sb.dir,
          quickActions: [{ id: 'qa', name: 'Cache', command: 'du -sh $HOME/.cache' }],
        }]);
      },
      config: { projectId: 'p-api', action: 'Cache' },
      assert(out, sb) {
        assert.strictEqual(out.command, `du -sh ${os.homedir()}/.cache`);
        assert.strictEqual(os.homedir(), sb.home, 'the sandbox home override must be in effect');
      },
    },
    {
      name: 'substitutes $BRANCH from the checked-out repository',
      async setup(sb) {
        sb.gitRepo();   // creates a repo on `main`
        seedProjects(sb, [{
          id: 'p-api', name: 'API', path: sb.dir,
          quickActions: [{ id: 'qa', name: 'Push', command: 'git push origin $BRANCH' }],
        }]);
      },
      config: { projectId: 'p-api', action: 'Push' },
      assert(out) {
        assert.strictEqual(out.command, 'git push origin main');
      },
    },
    {
      name: '$BRANCH outside a repository becomes empty rather than a literal',
      async setup(sb) {
        seedProjects(sb, [{
          id: 'p-api', name: 'API', path: sb.dir,
          quickActions: [{ id: 'qa', name: 'Push', command: 'echo [$BRANCH]' }],
        }]);
      },
      config: { projectId: 'p-api', action: 'Push' },
      assert(out) {
        assert.strictEqual(out.command, 'echo []');
      },
    },
    {
      name: "substitutes the project's custom env vars",
      async setup(sb) {
        seedProjects(sb, [{
          id: 'p-api', name: 'API', path: sb.dir,
          envVars: { API_URL: 'https://staging.example.com' },
          quickActions: [{ id: 'qa', name: 'Smoke', command: 'curl $API_URL/health' }],
        }]);
      },
      config: { projectId: 'p-api', action: 'Smoke' },
      assert(out) {
        assert.strictEqual(out.command, 'curl https://staging.example.com/health');
      },
    },
    {
      name: 'a project env var wins over the built-in of the same name, as in the UI',
      async setup(sb) {
        seedProjects(sb, [{
          id: 'p-api', name: 'API', path: sb.dir,
          envVars: { BRANCH: 'pinned-branch' },
          quickActions: [{ id: 'qa', name: 'Push', command: 'git push origin $BRANCH' }],
        }]);
      },
      config: { projectId: 'p-api', action: 'Push' },
      assert(out) {
        assert.strictEqual(out.command, 'git push origin pinned-branch');
      },
    },
    {
      name: 'workflow variables interpolate into the command too, and rank below the quick-action tokens',
      async setup(sb) {
        sb.vars.set('tag', 'v1.2.3');
        sb.vars.set('PROJECT_NAME', 'should-not-win');
        seedProjects(sb, [{
          id: 'p-api', name: 'Billing API', path: sb.dir,
          quickActions: [{ id: 'qa', name: 'Tag', command: 'release $PROJECT_NAME $tag' }],
        }]);
      },
      config: { projectId: 'p-api', action: 'Tag' },
      assert(out) {
        assert.strictEqual(out.command, 'release Billing API v1.2.3');
      },
    },
    {
      name: 'the action name field itself accepts a $variable',
      async setup(sb) {
        sb.vars.set('which', 'Build');
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir, quickActions: [BUILD, DEV] }]);
      },
      config: { projectId: 'p-api', action: '$which' },
      assert(out) {
        assert.strictEqual(out.command, 'npm run build');
      },
    },
    {
      name: 'an empty project picker falls back to the project this run belongs to',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-ctx', name: 'From context', path: sb.dir, quickActions: [BUILD] }]);
      },
      config: { projectId: '', action: 'Build' },
      assert(out, sb) {
        assert.strictEqual(sends(sb)[0].projectId, 'p-ctx');
        assert.strictEqual(out.command, 'npm run build');
      },
    },
    {
      name: 'an unknown action name fails and lists what the project actually has',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir, quickActions: [BUILD, DEV] }]);
      },
      config: { projectId: 'p-api', action: 'Deploy' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /Quick action "Deploy" not found/);
        assert.match(err.message, /Available: Build, Dev Server/);
        assert.strictEqual(sb.sent.length, 0);
      },
    },
    {
      name: 'a project with no quick actions says so instead of failing obscurely',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]);
      },
      config: { projectId: 'p-api', action: 'Build' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Available: none/);
      },
    },
    {
      name: 'an unknown project fails rather than running the command somewhere else',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir, quickActions: [BUILD] }]);
      },
      config: { projectId: 'ghost', action: 'Build' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /project "ghost" not found/);
        assert.strictEqual(sb.sent.length, 0);
      },
    },
    {
      name: 'a missing action name is a configuration error, not an empty command',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir, quickActions: [BUILD] }]);
      },
      config: { projectId: 'p-api', action: '' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /no action name configured/);
      },
    },
    {
      name: 'a quick action saved with an empty command is refused, not sent as a bare newline',
      async setup(sb) {
        seedProjects(sb, [{
          id: 'p-api', name: 'API', path: sb.dir,
          quickActions: [{ id: 'qa', name: 'Broken', command: '   ' }],
        }]);
      },
      config: { projectId: 'p-api', action: 'Broken' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /has no command/);
        assert.strictEqual(sb.sent.length, 0);
      },
    },
  ],
};
