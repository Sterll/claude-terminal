'use strict';

const os = require('os');
const path = require('path');
const { assert } = require('../sandbox');

/**
 * The claude node never talks to a model itself — it normalises its config and
 * hands one options object to ChatService.runSinglePrompt. The sandbox's
 * chatService is a recording stub, so every scenario here asserts on the exact
 * options the node built (sb.prompts[0]) rather than on model output.
 *
 * What is worth pinning: cwd resolution (three fallbacks, the last of which is
 * $HOME), model/effort allowlisting, maxTurns clamping, skill vs agent mode,
 * and the json_schema construction.
 */

/** The single options object the node handed to runSinglePrompt. */
function opts(sb) {
  assert.strictEqual(sb.prompts.length, 1, 'expected exactly one runSinglePrompt call');
  return sb.prompts[0];
}

const fs = require('fs');

/** Seed ~/.claude/agents/<id>.md inside the sandbox's fake home. */
function writeAgentFile(sb, id, model, body) {
  const dir = path.join(sb.home, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`),
    ['---', `name: ${id}`, `model: ${model}`, '---', body, ''].join('\n'), 'utf8');
}

/** Seed the directory layout AgentService also accepts: <id>/AGENT.md. */
function writeAgentDir(sb, id, model, body) {
  const dir = path.join(sb.home, '.claude', 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENT.md'),
    ['---', `name: ${id}`, `model: ${model}`, '---', body, ''].join('\n'), 'utf8');
}

module.exports = {
  type: 'claude',
  scenarios: [
    {
      name: 'runs in the run-context project when no cwd is configured',
      config: { mode: 'prompt', prompt: 'summarise the repo' },
      assert(out, sb) {
        const o = opts(sb);
        assert.strictEqual(o.cwd, sb.dir);
        assert.strictEqual(o.prompt, 'summarise the repo');
        assert.strictEqual(out.output, 'stub claude output');
      },
    },
    {
      name: 'an explicit cwd wins over the run-context project',
      async setup(sb) { sb.file('sub/keep.txt', 'x'); },
      config: (sb) => ({ mode: 'prompt', prompt: 'go', cwd: path.join(sb.dir, 'sub') }),
      assert(out, sb) {
        assert.strictEqual(opts(sb).cwd, path.join(sb.dir, 'sub'));
      },
    },
    {
      name: 'a project picker id is resolved through projects.json',
      async setup(sb) {
        sb.dataFile('projects.json', {
          projects: [{ id: 'p1', name: 'Demo', path: sb.dir }],
          folders: [], rootOrder: [],
        });
        // Clear the context project so only the picker can supply the cwd.
        sb.vars.set('ctx', {});
      },
      config: { mode: 'prompt', prompt: 'go', projectId: 'p1' },
      assert(out, sb) {
        assert.strictEqual(opts(sb).cwd, sb.dir);
      },
    },
    {
      name: 'falls back to $HOME when the configured cwd does not exist',
      config: (sb) => ({ mode: 'prompt', prompt: 'go', cwd: path.join(sb.dir, 'no-such-dir') }),
      assert(out, sb) {
        // Documented (and slightly alarming) behaviour: rather than failing, the
        // node runs the model in the user's home directory.
        assert.strictEqual(opts(sb).cwd, os.homedir());
        assert.strictEqual(os.homedir(), sb.home);
      },
    },
    {
      name: 'interpolates $variables into the prompt',
      async setup(sb) { sb.vars.set('feature', 'dark mode'); },
      config: { mode: 'prompt', prompt: 'Implement $feature in $ctx.project' },
      assert(out, sb) {
        assert.strictEqual(opts(sb).prompt, `Implement dark mode in ${sb.dir}`);
      },
    },
    {
      name: 'a whole-string $ref keeps the raw value and trims trailing newlines',
      async setup(sb) { sb.vars.set('review', 'please review this diff\n\n'); },
      config: { mode: 'prompt', prompt: '$review' },
      assert(out, sb) {
        assert.strictEqual(opts(sb).prompt, 'please review this diff');
      },
    },
    {
      name: 'leaves an unknown $variable untouched instead of blanking the prompt',
      config: { mode: 'prompt', prompt: 'check $missingVar now' },
      assert(out, sb) {
        assert.strictEqual(opts(sb).prompt, 'check $missingVar now');
      },
    },
    {
      name: 'skill mode forwards the skill id',
      config: { mode: 'skill', skillId: 'create-skill', prompt: 'make me a skill' },
      assert(out, sb) {
        assert.deepStrictEqual(opts(sb).skills, ['create-skill']);
      },
    },
    {
      name: 'skill mode with no skill selected forwards no skills',
      config: { mode: 'skill', skillId: '', prompt: 'go' },
      assert(out, sb) {
        assert.strictEqual(opts(sb).skills, undefined);
      },
    },
    {
      name: 'the agent id itself never leaks into the model options',
      async setup(sb) { writeAgentFile(sb, 'code-reviewer', 'sonnet', 'Review carefully.'); },
      config: (sb) => ({ mode: 'agent', agentId: 'code-reviewer', prompt: 'review', cwd: sb.dir }),
      assert(out, sb) {
        const o = opts(sb);
        assert.ok(!('agent' in o) && !('agentId' in o), 'agent id must not leak into the options');
        assert.strictEqual(o.skills, undefined, 'agent mode must not send skills');
        assert.strictEqual(o.prompt, 'review');
      },
    },
    {
      name: 'forwards a model and effort from the canonical lists',
      config: { mode: 'prompt', prompt: 'go', model: 'claude-haiku-4-5', effort: 'high' },
      assert(out, sb) {
        const o = opts(sb);
        assert.strictEqual(o.model, 'claude-haiku-4-5');
        assert.strictEqual(o.effort, 'high');
      },
    },
    {
      name: 'drops an unknown model and effort rather than forwarding them',
      config: { mode: 'prompt', prompt: 'go', model: 'gpt-4o', effort: 'ultra' },
      assert(out, sb) {
        const o = opts(sb);
        assert.strictEqual(o.model, null);
        assert.strictEqual(o.effort, null);
      },
    },
    {
      name: 'accepts a numeric-string maxTurns',
      config: { mode: 'prompt', prompt: 'go', maxTurns: '7' },
      assert(out, sb) {
        assert.strictEqual(opts(sb).maxTurns, 7);
      },
    },
    {
      name: 'falls back to 30 turns when maxTurns is not a positive number',
      config: { mode: 'prompt', prompt: 'go', maxTurns: 0 },
      assert(out, sb) {
        assert.strictEqual(opts(sb).maxTurns, 30);
      },
    },
    {
      name: 'builds a strict json_schema output format from the output schema',
      config: {
        mode: 'prompt', prompt: 'go',
        outputSchema: [
          { name: 'title', type: 'string' },
          { name: 'count', type: 'number' },
          { name: 'tags',  type: 'array'  },
          { name: 'ok',    type: 'boolean' },
        ],
      },
      assert(out, sb) {
        assert.deepStrictEqual(opts(sb).outputFormat, {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              count: { type: 'number' },
              tags:  { type: 'array', items: { type: 'string' } },
              ok:    { type: 'boolean' },
            },
            required: ['title', 'count', 'tags', 'ok'],
            additionalProperties: false,
          },
        });
      },
    },
    {
      name: 'ignores an output schema whose entries have no name',
      config: { mode: 'prompt', prompt: 'go', outputSchema: [{ type: 'string' }, null] },
      assert(out, sb) {
        assert.strictEqual(opts(sb).outputFormat, undefined);
      },
    },
    {
      name: 'refuses to run without a chat service instead of silently doing nothing',
      async setup(sb) { sb.ctx.chatService = null; },
      config: { mode: 'prompt', prompt: 'go' },
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /ChatService not available/i);
      },
    },
    {
      name: 'an empty prompt is still sent — the node does not require one',
      config: { mode: 'prompt', prompt: '' },
      assert(out, sb) {
        // Edge case worth knowing: a node left unconfigured burns a model turn
        // on an empty prompt rather than failing fast.
        assert.strictEqual(opts(sb).prompt, '');
        assert.strictEqual(out.success, true);
      },
    },

    // ── Agent mode ───────────────────────────────────────────────────────────
    // This branch used to only log a warning and run a plain prompt, so picking
    // an agent in the UI changed nothing at all.
    {
      name: 'agent mode runs under the chosen agent system prompt',
      async setup(sb) { writeAgentFile(sb, 'reviewer', 'sonnet', 'You are a strict reviewer.'); },
      config: (sb) => ({ mode: 'agent', agentId: 'reviewer', prompt: 'Review this', cwd: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(opts(sb).systemPrompt, 'You are a strict reviewer.');
        assert.strictEqual(opts(sb).prompt, 'Review this');
      },
    },
    {
      name: 'a directory-style agent is found too',
      async setup(sb) { writeAgentDir(sb, 'terse-bot', 'haiku', 'Be terse.'); },
      config: (sb) => ({ mode: 'agent', agentId: 'terse-bot', prompt: 'x', cwd: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(opts(sb).systemPrompt, 'Be terse.');
      },
    },
    {
      name: 'the agent declared model is used when the node does not override it',
      async setup(sb) { writeAgentFile(sb, 'terse-bot', 'haiku', 'Be terse.'); },
      config: (sb) => ({ mode: 'agent', agentId: 'terse-bot', prompt: 'x', cwd: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(opts(sb).model, 'haiku');
      },
    },
    {
      name: 'an explicit node model wins over the agent one',
      async setup(sb) { writeAgentFile(sb, 'terse-bot', 'haiku', 'Be terse.'); },
      config: (sb) => ({ mode: 'agent', agentId: 'terse-bot', model: 'opus', prompt: 'x', cwd: sb.dir }),
      assert(out, sb) {
        assert.strictEqual(opts(sb).model, 'opus');
      },
    },
    {
      name: 'an agent that does not exist rejects instead of ignoring the choice',
      config: (sb) => ({ mode: 'agent', agentId: 'ghost', prompt: 'x', cwd: sb.dir }),
      expectThrow: true,
      assert(err) { assert.match(err.message, /not found/i); },
    },
    {
      name: 'agent mode with no agent chosen rejects',
      config: (sb) => ({ mode: 'agent', agentId: '', prompt: 'x', cwd: sb.dir }),
      expectThrow: true,
      assert(err) { assert.match(err.message, /no agent/i); },
    },
    {
      name: 'an agent id cannot escape the agents directory',
      config: (sb) => ({ mode: 'agent', agentId: '../../../etc/passwd', prompt: 'x', cwd: sb.dir }),
      expectThrow: true,
      assert(err) { assert.match(err.message, /not found/i); },
    },
  ],
};
