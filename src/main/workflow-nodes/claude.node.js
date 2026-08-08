'use strict';

const { resolveProjectPath } = require('./_registry');

// Shared canonical model / effort option lists (see src/shared/model-options.js).
// Fall back to an identical hard-coded copy if the shared module is unavailable
// (e.g. a load-order timing issue), so validation never silently breaks.
let CLAUDE_MODEL_VALUES;
let EFFORT_VALUES;
try {
  ({ CLAUDE_MODEL_VALUES, EFFORT_VALUES } = require('../../shared/model-options'));
} catch {
  CLAUDE_MODEL_VALUES = ['', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'sonnet', 'opus', 'haiku'];
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

  props: { mode: 'prompt', prompt: '', agentId: '', skillId: '', model: 'sonnet', effort: 'medium', outputSchema: null, cwd: '', maxTurns: 30 },

  fields: [
    { type: 'claude-config', key: 'mode', label: 'wfn.claude.label' },
    // The claude-config custom field already exposes `cwd`; it does NOT expose
    // maxTurns, so surface it here (backward-compatible, defaults to 30).
    { type: 'number', key: 'maxTurns', label: 'Max turns',
      placeholder: '30' },
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

    const mode    = config.mode   || 'prompt';
    const prompt  = resolveVars(config.prompt || '', vars);
    const varCtx  = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
    const home    = require('os').homedir();
    const fs      = require('fs');

    // Resolution order: explicit cwd → the node's project picker → the run
    // context's project. Without the projectId step, a cron-triggered run (which
    // has no "current project") would ignore the picker and land in $HOME.
    let cwd = resolveVars(config.cwd || '', vars)
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

    if (mode === 'skill' && config.skillId) {
      opts.skills = [config.skillId];
    }

    // Agent mode: the claude-config field exposes an Agent tab (config.agentId),
    // but ChatService.runSinglePrompt does not currently accept an agent option,
    // so there is no supported way to invoke a named subagent from a workflow
    // step. Rather than crash, fall back to a plain prompt run and warn. If a
    // future runSinglePrompt gains an `agent`/`agentId` parameter, forward it
    // here instead of this fallback.
    if (mode === 'agent' && config.agentId) {
      console.warn(`[claude.node] Agent mode requested (agentId="${config.agentId}") but ChatService.runSinglePrompt does not support agents — running as a plain prompt.`);
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
