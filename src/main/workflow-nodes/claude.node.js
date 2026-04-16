'use strict';

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

  props: { mode: 'prompt', prompt: '', agentId: '', skillId: '', model: 'sonnet', effort: 'medium', outputSchema: null },

  fields: [
    { type: 'claude-config', key: 'mode', label: 'wfn.claude.label' },
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

    let cwd = resolveVars(config.cwd || '', vars) || varCtx.project || '';
    if (!cwd || !fs.existsSync(cwd)) {
      console.warn(`[claude.node] cwd invalid or missing: "${cwd}", falling back to ${home}`);
      cwd = home;
    }

    const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    const rawEffort     = config.effort || null;
    const effort        = rawEffort && VALID_EFFORTS.includes(rawEffort) ? rawEffort : null;
    const model         = config.model  || null;
    const maxTurns      = config.maxTurns || 30;

    if (signal?.aborted) throw new Error('Cancelled');

    const opts = { cwd, prompt, model, effort, maxTurns, signal };

    if (mode === 'skill' && config.skillId) {
      opts.skills = [config.skillId];
    }

    if (config.outputSchema && config.outputSchema.length > 0) {
      const validFields = config.outputSchema.filter(f => f.name);
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
