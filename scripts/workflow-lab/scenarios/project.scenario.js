'use strict';

/**
 * project node — reads ~/.claude-terminal/projects.json (the sandbox's fake
 * home) for `list`, mutates the shared `ctx` variable for `set_context`, and
 * hands every other action to the renderer over sendFn.
 */

const fs   = require('fs');
const path = require('path');
const { assert } = require('../sandbox');

const SEEDED = {
  projects: [
    { id: 'p-api',  name: 'Billing API', path: 'C:/code/billing', type: 'api'  },
    { id: 'p-site', name: 'Marketing',   path: 'C:/code/site',    type: 'webapp' },
  ],
  folders: [],
  rootOrder: ['p-api', 'p-site'],
};

module.exports = {
  type: 'project',
  scenarios: [
    {
      name: 'list returns every seeded project with its id, name, path and type',
      async setup(sb) { sb.dataFile('projects.json', SEEDED); },
      config: () => ({ action: 'list' }),
      assert(out) {
        assert.strictEqual(out.success, true);
        assert.strictEqual(out.count, 2);
        assert.deepStrictEqual(out.projects, SEEDED.projects);
      },
    },
    {
      name: 'list defaults a project with no type to general',
      async setup(sb) {
        sb.dataFile('projects.json', { projects: [{ id: 'p-x', name: 'Untyped', path: 'C:/code/x' }] });
      },
      config: () => ({ action: 'list' }),
      assert(out) {
        assert.strictEqual(out.projects[0].type, 'general');
      },
    },
    {
      name: 'list drops the bookkeeping fields projects.json carries',
      async setup(sb) {
        sb.dataFile('projects.json', {
          projects: [{
            id: 'p-api', name: 'Billing API', path: 'C:/code/billing', type: 'api',
            quickActions: [{ label: 'dev', command: 'npm run dev' }],
            folderId: 'f-1', pinned: true,
          }],
        });
      },
      config: () => ({ action: 'list' }),
      assert(out) {
        assert.deepStrictEqual(Object.keys(out.projects[0]).sort(), ['id', 'name', 'path', 'type']);
      },
    },
    {
      name: 'list returns an empty list when projects.json has never been written',
      // No dataFile call: the fake ~/.claude-terminal exists but is empty.
      config: () => ({ action: 'list' }),
      assert(out) {
        assert.strictEqual(out.success, true, 'a first-run install should not fail the workflow');
        assert.deepStrictEqual(out.projects, []);
        assert.strictEqual(out.count, 0);
      },
    },
    {
      name: 'list survives a corrupt projects.json instead of throwing',
      async setup(sb) {
        fs.writeFileSync(path.join(sb.home, '.claude-terminal', 'projects.json'), '{ this is not json', 'utf8');
      },
      config: () => ({ action: 'list' }),
      assert(out) {
        assert.strictEqual(out.success, true);
        assert.deepStrictEqual(out.projects, []);
      },
    },
    {
      name: 'set_context records the active project on the shared ctx variable',
      config: () => ({ action: 'set_context', projectId: 'p-api' }),
      assert(out, sb) {
        assert.strictEqual(out.success, true);
        assert.strictEqual(out.action, 'set_context');
        assert.strictEqual(out.projectId, 'p-api');
        assert.strictEqual(sb.vars.get('ctx').activeProjectId, 'p-api',
          'later nodes in the run would not see the project this node selected');
      },
    },
    {
      name: 'set_context leaves the rest of ctx alone',
      config: () => ({ action: 'set_context', projectId: 'p-site' }),
      assert(out, sb) {
        const ctx = sb.vars.get('ctx');
        assert.ok(ctx.project, 'set_context wiped the working directory off ctx');
        assert.strictEqual(ctx.activeProjectId, 'p-site');
      },
    },
    {
      name: 'set_context with no projectId keeps the project already selected',
      async setup(sb) {
        sb.vars.set('ctx', { ...sb.vars.get('ctx'), activeProjectId: 'p-previous' });
      },
      config: () => ({ action: 'set_context', projectId: '' }),
      assert(out, sb) {
        assert.strictEqual(out.success, true);
        assert.strictEqual(sb.vars.get('ctx').activeProjectId, 'p-previous',
          'an empty projectId cleared the active project');
      },
    },
    {
      name: 'open is forwarded to the renderer rather than handled in the main process',
      config: () => ({ action: 'open', projectId: 'p-api' }),
      assert(out, sb) {
        assert.strictEqual(out.success, true);
        const payload = sb.sentOn('workflow-project-action');
        assert.ok(payload, 'nothing was emitted to the renderer');
        assert.deepStrictEqual(payload, { action: 'open', projectId: 'p-api' });
      },
    },
    {
      name: 'a forwarded action falls back to the project set by an earlier set_context',
      async setup(sb) {
        sb.vars.set('ctx', { ...sb.vars.get('ctx'), activeProjectId: 'p-site' });
      },
      config: () => ({ action: 'build' }),
      assert(out, sb) {
        assert.deepStrictEqual(sb.sentOn('workflow-project-action'), { action: 'build', projectId: 'p-site' });
      },
    },
    {
      name: 'an unknown action is forwarded rather than rejected in the main process',
      config: () => ({ action: 'teleport', projectId: 'p-api' }),
      assert(out, sb) {
        // Pinned deliberately: the node validates nothing, so a typo in a
        // workflow silently succeeds and the renderer ignores the message.
        assert.strictEqual(out.success, true);
        assert.deepStrictEqual(sb.sentOn('workflow-project-action'), { action: 'teleport', projectId: 'p-api' });
      },
    },
  ],
};
