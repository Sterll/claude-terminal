'use strict';

const fs   = require('fs');
const path = require('path');
const { assert } = require('../sandbox');

/**
 * session_recap parses a Claude Code transcript out of
 * ~/.claude/projects/<encoded-project-path>/<sessionId>.jsonl and summarises it.
 * The fake $HOME makes that directory disposable, so every scenario seeds a real
 * JSONL fixture and asserts on the recap the node produced.
 *
 * `useAi` defaults to TRUE, which routes through ChatService and spawns the
 * Claude CLI. Every scenario therefore pins `useAi: false` except the last one,
 * which stubs the ChatService module so the AI path can be exercised without a
 * process spawn or a network call.
 */

// Must stay byte-identical to session_recap.node.js::encodeProjectPath, which
// itself mirrors claude.ipc.js::encodeProjectPath. Duplicated on purpose: if the
// app's encoding drifts, these scenarios stop finding the fixture and fail.
function encodeProjectPath(projectPath) {
  const encoded = projectPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 100);
  let hash = 0;
  for (let i = 0; i < projectPath.length; i++) {
    hash = ((hash << 5) - hash + projectPath.charCodeAt(i)) | 0;
  }
  return `${encoded}-${Math.abs(hash).toString(36)}`;
}

function sessionsDir(sb, projectPath = sb.dir) {
  return path.join(sb.home, '.claude', 'projects', encodeProjectPath(projectPath));
}

/** Write a .jsonl transcript into the fake ~/.claude/projects/<encoded>/. */
function seedSession(sb, filename, lines, projectPath = sb.dir) {
  const dir = sessionsDir(sb, projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  const file = path.join(dir, filename);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const T0 = '2026-03-01T10:00:00.000Z';
const T1 = '2026-03-01T10:00:30.000Z';
const T2 = '2026-03-01T10:02:00.000Z';

const userMsg   = (text, ts, extra = {}) => ({ type: 'user', timestamp: ts, message: { content: text }, ...extra });
const toolUse   = (names, ts) => ({
  type: 'assistant', timestamp: ts,
  message: { content: names.map(name => ({ type: 'tool_use', name, input: {} })) },
});

const CHAT_SERVICE_PATH = require.resolve(
  path.join(__dirname, '..', '..', '..', 'src', 'main', 'services', 'ChatService')
);

module.exports = {
  type: 'session_recap',
  scenarios: [
    {
      name: 'summarises a transcript into prompts, tool counts and duration',
      async setup(sb) {
        seedSession(sb, 'sess-1.jsonl', [
          userMsg('Fix the login bug', T0),
          toolUse(['Read', 'Edit'], T1),
          toolUse(['Read'], T1),
          { type: 'user', timestamp: T2, message: { content: [{ type: 'text', text: 'Now run the tests' }] } },
        ]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-1', useAi: false }),
      assert(out) {
        assert.deepStrictEqual(out.prompts, ['Fix the login bug', 'Now run the tests']);
        assert.strictEqual(out.toolCount, 3);
        assert.strictEqual(out.source, 'heuristic');
        // Heuristic recap = the busiest tools, most-used first.
        assert.strictEqual(out.summary, 'Read ×2, Edit ×1');
        assert.strictEqual(out.durationMs, 120_000);
      },
    },
    {
      name: 'ignores subagent (sidechain) turns so the recap reflects the user',
      async setup(sb) {
        seedSession(sb, 'sess-1.jsonl', [
          userMsg('Real request', T0),
          userMsg('Subagent instruction', T1, { isSidechain: true }),
        ]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-1', useAi: false }),
      assert(out) {
        assert.deepStrictEqual(out.prompts, ['Real request']);
      },
    },
    {
      name: 'ignores tool_result turns that carry no user text',
      async setup(sb) {
        seedSession(sb, 'sess-1.jsonl', [
          userMsg('Do the thing', T0),
          { type: 'user', timestamp: T1, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } },
        ]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-1', useAi: false }),
      assert(out) {
        assert.deepStrictEqual(out.prompts, ['Do the thing']);
      },
    },
    {
      name: 'truncates a long prompt to 300 characters',
      async setup(sb) {
        seedSession(sb, 'sess-1.jsonl', [userMsg('x'.repeat(500), T0)]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-1', useAi: false }),
      assert(out) {
        assert.strictEqual(out.prompts[0].length, 300);
      },
    },
    {
      name: 'caps the prompt list at 10 entries',
      async setup(sb) {
        const lines = [];
        for (let i = 0; i < 15; i++) lines.push(userMsg(`prompt ${i}`, T0));
        seedSession(sb, 'sess-1.jsonl', lines);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-1', useAi: false }),
      assert(out) {
        assert.strictEqual(out.prompts.length, 10);
        assert.strictEqual(out.prompts[9], 'prompt 9');
      },
    },
    {
      name: 'skips malformed JSONL lines instead of failing the recap',
      async setup(sb) {
        seedSession(sb, 'sess-1.jsonl', [
          'not json at all',
          '',
          userMsg('Still counted', T0),
          '{"type":"assistant","message":{"content":',
          toolUse(['Bash'], T1),
        ]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-1', useAi: false }),
      assert(out) {
        assert.deepStrictEqual(out.prompts, ['Still counted']);
        assert.strictEqual(out.toolCount, 1);
        assert.strictEqual(out.summary, 'Bash ×1');
      },
    },
    {
      name: 'falls back to a tool count when the session used no tools',
      async setup(sb) {
        seedSession(sb, 'sess-1.jsonl', [userMsg('Just a question', T0)]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-1', useAi: false }),
      assert(out) {
        assert.strictEqual(out.summary, '0 tool uses');
        assert.strictEqual(out.toolCount, 0);
        assert.strictEqual(out.durationMs, 0, 'a single timestamp means no measurable duration');
      },
    },
    {
      name: 'finds the transcript by its embedded sessionId when the filename differs',
      async setup(sb) {
        seedSession(sb, 'renamed-file.jsonl', [
          { ...userMsg('Hello', T0), sessionId: 'sess-embedded' },
          toolUse(['Grep'], T1),
        ]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-embedded', useAi: false }),
      assert(out) {
        assert.strictEqual(out.summary, 'Grep ×1');
      },
    },
    {
      name: 'resolves the project through projects.json when given an id',
      async setup(sb) {
        sb.dataFile('projects.json', {
          projects: [{ id: 'p1', name: 'Demo', path: sb.dir }], folders: [], rootOrder: [],
        });
        seedSession(sb, 'sess-1.jsonl', [userMsg('Hi', T0), toolUse(['Write'], T1)]);
      },
      config: { projectId: 'p1', sessionId: 'sess-1', useAi: false },
      assert(out) {
        assert.strictEqual(out.summary, 'Write ×1');
      },
    },
    {
      name: 'uses $ctx.sessionId when the session field is blank',
      async setup(sb) {
        sb.vars.set('ctx', { project: sb.dir, activeProjectId: sb.dir, sessionId: 'sess-1' });
        seedSession(sb, 'sess-1.jsonl', [userMsg('Hi', T0), toolUse(['Task'], T1)]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: '', useAi: false }),
      assert(out) {
        assert.strictEqual(out.summary, 'Task ×1');
      },
    },
    {
      name: 'falls back to the run-context project when the picker is empty',
      async setup(sb) {
        // The run context a real WorkflowRunner builds: ctx.project holds the
        // project path, and nothing else identifies a project.
        sb.vars.set('ctx', { project: sb.dir, branch: '', date: '', lastCommit: '', trigger: 'manual' });
        seedSession(sb, 'sess-1.jsonl', [userMsg('Hi', T0), toolUse(['Read'], T1)]);
      },
      config: { projectId: '', sessionId: 'sess-1', useAi: false },
      assert(out) {
        assert.strictEqual(out.summary, 'Read ×1');
      },
    },
    {
      name: 'reports a session id with no transcript on disk',
      async setup(sb) { seedSession(sb, 'sess-1.jsonl', [userMsg('Hi', T0)]); },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-does-not-exist', useAi: false }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Session file not found for sess-does-not-exist/i);
      },
    },
    {
      name: 'requires a session id',
      config: (sb) => ({ projectId: sb.dir, sessionId: '', useAi: false }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /sessionId is required/i);
      },
    },
    {
      name: 'requires a resolvable project',
      config: { projectId: 'no-such-project', sessionId: 'sess-1', useAi: false },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /Project path could not be resolved/i);
      },
    },
    {
      name: 'falls back to the heuristic when the AI summariser is unavailable',
      async setup(sb) {
        // Stand in for ChatService so the useAi path runs without spawning the
        // Claude CLI. Restored in assert() — see below.
        sb.prevChatService = require.cache[CHAT_SERVICE_PATH];
        require.cache[CHAT_SERVICE_PATH] = {
          id: CHAT_SERVICE_PATH, filename: CHAT_SERVICE_PATH, loaded: true, exports: {
            async runHaikuPrompt() { throw new Error('lab: Haiku deliberately unavailable'); },
          },
        };
        seedSession(sb, 'sess-1.jsonl', [userMsg('Hi', T0), toolUse(['Read'], T1)]);
      },
      config: (sb) => ({ projectId: sb.dir, sessionId: 'sess-1', useAi: true }),
      assert(out, sb) {
        if (sb.prevChatService) require.cache[CHAT_SERVICE_PATH] = sb.prevChatService;
        else delete require.cache[CHAT_SERVICE_PATH];

        assert.strictEqual(out.source, 'heuristic');
        assert.strictEqual(out.summary, 'Read ×1');
      },
    },
  ],
};
