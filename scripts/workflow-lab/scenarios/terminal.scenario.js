'use strict';

const fs   = require('fs');
const path = require('path');
const { assert } = require('../sandbox');

/**
 * terminal node — half renderer IPC, half filesystem.
 *
 * `send` is fully observable here: the payload it hands to the renderer over
 * `mcp-terminal:send` is recorded by the sandbox's sendFn, and that payload is
 * the node's entire contribution — nothing types into an xterm from the main
 * process. The scenarios therefore assert the payload shape (the same shape the
 * terminal_send_command MCP tool writes), never "the command ran".
 *
 * `read` tails ~/.claude-terminal/terminals/output/<projectId>.log inside the
 * fake home. The scenarios seed that file themselves, and one of them pins the
 * uncomfortable truth that nothing in the app writes it today: on a stock
 * install `read` returns an empty string.
 */

/** Seed the fake ~/.claude-terminal/projects.json. */
function seedProjects(sb, projects) {
  sb.dataFile('projects.json', { projects, folders: [], rootOrder: projects.map(p => p.id) });
}

/** Seed the captured-output log the MCP tools define for a project. */
function seedOutput(sb, projectId, content) {
  const dir = path.join(sb.home, '.claude-terminal', 'terminals', 'output');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${projectId}.log`), content, 'utf8');
}

/** Everything the node handed to the renderer. */
function sends(sb) {
  return sb.sent.filter(s => s.channel === 'mcp-terminal:send').map(s => s.payload);
}

module.exports = {
  type: 'terminal',
  scenarios: [
    {
      name: 'send hands the command to the renderer on the channel the terminal tools already use',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'Billing API', path: sb.dir }]);
      },
      config: { action: 'send', projectId: 'p-api', command: 'npm run dev' },
      assert(out, sb) {
        assert.deepStrictEqual(sends(sb), [{
          projectId: 'p-api',
          projectName: 'Billing API',
          command: 'npm run dev',
          source: 'workflow',
        }]);
        assert.strictEqual(out.command, 'npm run dev');
        assert.strictEqual(out.projectId, 'p-api');
        assert.strictEqual(out.delivered, true,
          'delivered means "handed to the renderer", never "executed"');
      },
    },
    {
      name: 'send fills every output slot, so a link to `output` never reads undefined',
      async setup(sb) { seedProjects(sb, [{ id: 'p-api', name: 'Billing API', path: sb.dir }]); },
      config: { action: 'send', projectId: 'p-api', command: 'ls' },
      assert(out) {
        assert.deepStrictEqual(Object.keys(out).sort(),
          ['command', 'delivered', 'lines', 'output', 'projectId'].sort());
        assert.strictEqual(out.output, '');
        assert.strictEqual(out.lines, 0);
      },
    },
    {
      name: 'send interpolates $variables into the command',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'Billing API', path: sb.dir }]);
        sb.vars.set('script', 'build');
      },
      config: { action: 'send', projectId: 'p-api', command: 'npm run $script' },
      assert(out, sb) {
        assert.strictEqual(sends(sb)[0].command, 'npm run build');
        assert.strictEqual(out.command, 'npm run build');
      },
    },
    {
      name: 'the project picker itself accepts a $variable',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'Billing API', path: sb.dir }]);
        sb.vars.set('target', 'p-api');
      },
      config: { action: 'send', projectId: '$target', command: 'ls' },
      assert(out) {
        assert.strictEqual(out.projectId, 'p-api');
      },
    },
    {
      name: 'a project can be named instead of referenced by id',
      async setup(sb) { seedProjects(sb, [{ id: 'p-api', name: 'Billing API', path: sb.dir }]); },
      config: { action: 'send', projectId: 'Billing API', command: 'ls' },
      assert(out) {
        assert.strictEqual(out.projectId, 'p-api');
      },
    },
    {
      name: 'an empty picker falls back to the project this run belongs to',
      // The cron case: no "current project" in the UI, only $ctx.project.
      async setup(sb) { seedProjects(sb, [{ id: 'p-ctx', name: 'From context', path: sb.dir }]); },
      config: { action: 'send', projectId: '', command: 'git status' },
      assert(out, sb) {
        assert.strictEqual(out.projectId, 'p-ctx');
        assert.strictEqual(sends(sb)[0].projectName, 'From context');
      },
    },
    {
      name: 'a trailing newline is stripped so the shell does not receive a second empty line',
      async setup(sb) { seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]); },
      config: { action: 'send', projectId: 'p-api', command: 'npm test\n' },
      assert(out, sb) {
        assert.strictEqual(sends(sb)[0].command, 'npm test');
      },
    },
    {
      name: 'read returns the tail of the captured output log',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]);
        seedOutput(sb, 'p-api', 'one\ntwo\nthree\nfour\n');
      },
      config: { action: 'read', projectId: 'p-api', lines: 2 },
      assert(out, sb) {
        assert.strictEqual(out.output, 'three\nfour');
        assert.strictEqual(out.lines, 2);
        assert.strictEqual(sends(sb).length, 0, 'read must not drive the terminal');
        assert.strictEqual(out.delivered, false);
      },
    },
    {
      name: 'read returns the whole log when it is shorter than the requested tail',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]);
        seedOutput(sb, 'p-api', 'only line\n');
      },
      config: { action: 'read', projectId: 'p-api', lines: 50 },
      assert(out) {
        assert.strictEqual(out.output, 'only line');
        assert.strictEqual(out.lines, 1);
      },
    },
    {
      name: 'read caps the tail at 200 lines however large the field says',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]);
        seedOutput(sb, 'p-api', Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
      },
      config: { action: 'read', projectId: 'p-api', lines: 100000 },
      assert(out) {
        assert.strictEqual(out.lines, 200);
        assert.strictEqual(out.output.split('\n')[0], 'line 300');
      },
    },
    {
      name: 'an unparseable line count falls back to 50 rather than reading nothing',
      async setup(sb) {
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]);
        seedOutput(sb, 'p-api', Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n'));
      },
      config: { action: 'read', projectId: 'p-api', lines: 'many' },
      assert(out) {
        assert.strictEqual(out.lines, 50);
      },
    },
    {
      // NOTHING in the app writes terminals/output/*.log today, so on a stock
      // install this is the only outcome `read` can have. Returning '' would
      // feed an empty string onward, and a `read -> analyse` chain would report
      // success having looked at nothing — so it must fail loudly instead.
      name: 'read with no capture file at all fails loudly rather than returning empty',
      async setup(sb) { seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]); },
      config: { action: 'read', projectId: 'p-api' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /not implemented yet/i);
      },
    },
    {
      name: 'an existing but empty capture log reads as empty, which is a real answer',
      async setup(sb) {
        const fs = require('fs'), path = require('path');
        seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]);
        const dir = path.join(sb.home, '.claude-terminal', 'terminals', 'output');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'p-api.log'), '', 'utf8');
      },
      config: { action: 'read', projectId: 'p-api' },
      assert(out) {
        assert.strictEqual(out.output, '');
        assert.strictEqual(out.lines, 0);
      },
    },
    {
      name: 'rejects an unknown action instead of silently doing nothing',
      async setup(sb) { seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]); },
      config: { action: 'teleport', projectId: 'p-api' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /unknown action "teleport"/);
        assert.strictEqual(sb.sent.length, 0);
      },
    },
    {
      name: 'rejects a send with no command',
      async setup(sb) { seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]); },
      config: { action: 'send', projectId: 'p-api', command: '   ' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /no command specified/);
        assert.strictEqual(sb.sent.length, 0, 'a blank command must not reach a terminal');
      },
    },
    {
      name: 'rejects an unknown project rather than guessing a tab',
      async setup(sb) { seedProjects(sb, [{ id: 'p-api', name: 'API', path: sb.dir }]); },
      config: { action: 'send', projectId: 'ghost', command: 'ls' },
      expectThrow: true,
      assert(err, sb) {
        assert.match(err.message, /project "ghost" not found/);
        assert.strictEqual(sb.sent.length, 0);
      },
    },
    {
      name: 'rejects a run with no project at all — first-run install, empty picker',
      // No projects.json written: $ctx.project resolves to a real directory
      // that belongs to no registered project.
      config: { action: 'send', projectId: '', command: 'ls' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /no project selected/);
      },
    },
  ],
};
