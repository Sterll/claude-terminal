'use strict';

const { resolveProjectPath } = require('./_registry');

/**
 * Load a custom agent's system prompt from ~/.claude/agents.
 *
 * Both layouts AgentService enumerates are handled: a flat `<id>.md` and a
 * `<id>/AGENT.md` directory. The YAML frontmatter is stripped — only the body
 * is the system prompt.
 *
 * @param {string} agentId
 * @returns {{ systemPrompt: string, model: string|null }|null}
 */
function loadAgent(agentId) {
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');

  const safeId = String(agentId || '').trim();
  // Never let a configured id walk out of the agents directory.
  if (!safeId || safeId.includes('..') || path.isAbsolute(safeId) || /[\\/]/.test(safeId)) return null;

  const base = path.join(os.homedir(), '.claude', 'agents');
  const candidates = [path.join(base, `${safeId}.md`), path.join(base, safeId, 'AGENT.md')];

  for (const file of candidates) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }

    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    const body  = (match ? match[2] : raw).trim();
    if (!body) return null;

    const modelLine = match && match[1].match(/^model:\s*(.+)$/m);
    return { systemPrompt: body, model: modelLine ? modelLine[1].trim() : null };
  }
  return null;
}

// Shared canonical model / effort option lists (see src/shared/model-options.js).
// Fall back to an identical hard-coded copy if the shared module is unavailable
// (e.g. a load-order timing issue), so validation never silently breaks.
let CLAUDE_MODEL_VALUES;
let EFFORT_VALUES;
try {
  ({ CLAUDE_MODEL_VALUES, EFFORT_VALUES } = require('../../shared/model-options'));
} catch {
  CLAUDE_MODEL_VALUES = ['', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'sonnet', 'opus', 'haiku'];
  EFFORT_VALUES = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
}

module.exports = {
  type:     'workflow/claude',
  title:    'Claude',
  desc:     'Prompt, Agent ou Skill',
  color:    'accent',
  width:    220,
  category: 'actions',
  icon:     'claude',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',   type: 'exec'   },
    { name: 'Error',  type: 'exec'   },
    { name: 'output', type: 'string' },
    { name: 'result', type: 'any'    },
  ],

  props: { mode: 'prompt', prompt: '', agentId: '', skillId: '', model: 'sonnet', effort: 'medium', outputSchema: null, cwd: '', maxTurns: 30, resumeFrom: '' },

  fields: [
    { type: 'claude-config', key: 'mode', label: 'wfn.claude.label' },
    // The claude-config custom field already exposes `cwd`; it does NOT expose
    // maxTurns, so surface it here (backward-compatible, defaults to 30).
    { type: 'number', key: 'maxTurns', label: 'Max turns',
      placeholder: '30' },
    // Automations set this to `$trigger.sdkSessionId` to inherit the context of
    // the conversation that fired them. Surfaced so a task converted to the
    // advanced editor does not carry an invisible setting.
    { type: 'text', key: 'resumeFrom', label: 'Resume session',
      placeholder: '$trigger.sdkSessionId', mono: true },
  ],

  badge: (n) => ({ prompt: 'PROMPT', agent: 'AGENT', skill: 'SKILL' }[n.properties.mode] || 'PROMPT'),

  async run(config, vars, signal, ctx) {
    const chatService = ctx?.chatService;
    if (!chatService) throw new Error('ChatService not available — use the WorkflowRunner to execute Claude nodes');

    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      const singleMatch = value.match(/^\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)$/);
      if (singleMatch) {
        const parts = singleMatch[1].split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        if (cur != null) return typeof cur === 'string' ? cur.replace(/[\r\n]+$/, '') : cur;
      }
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    // resolveVars leaves a reference it cannot satisfy as the literal `$name`,
    // which is right for prose but wrong for a path or an id: a task set to
    // "run where it fired" but run manually would otherwise get the string
    // "$trigger.projectPath" as its cwd and skip every fallback below.
    const resolveRef = (value) => {
      const out = resolveVars(value || '', vars);
      return typeof out === 'string' && out.startsWith('$') ? '' : out;
    };

    const mode    = config.mode   || 'prompt';
    const prompt  = resolveVars(config.prompt || '', vars);
    const varCtx  = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
    const home    = require('os').homedir();
    const fs      = require('fs');

    // Resolution order: explicit cwd → the node's project picker → the run
    // context's project. Without the projectId step, a cron-triggered run (which
    // has no "current project") would ignore the picker and land in $HOME.
    let cwd = resolveRef(config.cwd)
      || resolveProjectPath(config.projectId || '', vars)
      || varCtx.project
      || '';
    if (!cwd || !fs.existsSync(cwd)) {
      console.warn(`[claude.node] cwd invalid or missing: "${cwd}", falling back to ${home}`);
      cwd = home;
    }

    // Non-empty subset of the shared canonical effort/model lists for validation.
    const VALID_EFFORTS = EFFORT_VALUES.filter(Boolean);
    const VALID_MODELS  = CLAUDE_MODEL_VALUES.filter(Boolean);
    const rawEffort     = config.effort || null;
    const effort        = rawEffort && VALID_EFFORTS.includes(rawEffort) ? rawEffort : null;
    const rawModel      = config.model  || null;
    const model         = rawModel && VALID_MODELS.includes(rawModel) ? rawModel : null;
    const parsedTurns   = parseInt(config.maxTurns, 10);
    const maxTurns      = Number.isFinite(parsedTurns) && parsedTurns > 0 ? parsedTurns : 30;

    if (signal?.aborted) throw new Error('Cancelled');

    const opts = { cwd, prompt, model, effort, maxTurns, signal };

    // Continue an existing Claude conversation instead of starting cold — how
    // an automation inherits the context of the session that triggered it.
    // Usually `$trigger.sdkSessionId`; empty (or unresolved, on a manual run)
    // just means a normal one-shot run. ChatService always forks, so the
    // conversation being resumed is read, never written to.
    const resume = resolveRef(config.resumeFrom);
    if (resume) opts.resume = resume;

    if (mode === 'skill' && config.skillId) {
      opts.skills = [config.skillId];
    }

    // Agent mode: run the prompt under the custom agent's system prompt.
    // runSinglePrompt has no notion of a named subagent, so the agent's own
    // markdown body IS the system prompt — which is what the Agent tab has
    // always implied. Previously this branch only logged a warning and ran a
    // plain prompt, so picking an agent changed nothing at all.
    if (mode === 'agent') {
      const agent = config.agentId ? loadAgent(config.agentId) : null;
      if (agent) {
        opts.systemPrompt = agent.systemPrompt;
        // The node's own model selection wins; the agent's is the fallback.
        if (!model && agent.model && VALID_MODELS.includes(agent.model)) {
          opts.model = agent.model;
        }
      } else {
        throw new Error(
          config.agentId
            ? `Agent "${config.agentId}" not found in ~/.claude/agents`
            : 'Agent mode selected but no agent was chosen'
        );
      }
    }

    if (Array.isArray(config.outputSchema) && config.outputSchema.length > 0) {
      const validFields = config.outputSchema.filter(f => f && f.name);
      if (validFields.length > 0) {
        const properties = {};
        const required   = [];
        for (const field of validFields) {
          required.push(field.name);
          switch (field.type) {
            case 'number':  properties[field.name] = { type: 'number'  }; break;
            case 'boolean': properties[field.name] = { type: 'boolean' }; break;
            case 'array':   properties[field.name] = { type: 'array', items: { type: 'string' } }; break;
            case 'object':  properties[field.name] = { type: 'object'  }; break;
            default:        properties[field.name] = { type: 'string'  }; break;
          }
        }
        opts.outputFormat = { type: 'json_schema', schema: { type: 'object', properties, required, additionalProperties: false } };
      }
    }

    return chatService.runSinglePrompt(opts);
  },
};
