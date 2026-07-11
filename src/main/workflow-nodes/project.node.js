'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

module.exports = {
  type:     'workflow/project',
  title:    'Project',
  desc:     'Cibler ou lister des projets',
  color:    'pink',
  width:    220,
  category: 'data',
  icon:     'project',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',     type: 'exec'  },
    { name: 'Error',    type: 'exec'  },
    { name: 'projects', type: 'array' },
  ],

  props: { projectId: '', action: 'set_context' },

  fields: [
    { type: 'project-config', key: 'action', label: 'wfn.project.label' },
  ],

  badge: (n) => (n.properties.action || 'set_context').toUpperCase().replace('_', ' '),

  async run(config, vars, signal, ctx) {
    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    const action    = config.action    || 'set_context';
    const projectId = config.projectId || '';
    const varCtx    = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});

    if (action === 'list') {
      const projFile = path.join(os.homedir(), '.claude-terminal', 'projects.json');
      try {
        const data = JSON.parse(fs.readFileSync(projFile, 'utf8'));
        const projects = (data.projects || []).map(p => ({
          id:   p.id,
          name: p.name,
          path: p.path,
          type: p.type || 'general',
        }));
        return { projects, count: projects.length, success: true };
      } catch {
        return { projects: [], count: 0, success: true };
      }
    }

    if (action === 'set_context') {
      if (projectId) varCtx.activeProjectId = projectId;
      if (vars instanceof Map) vars.set('ctx', varCtx);
      return { success: true, action, projectId };
    }

    // For open/build/install/test — delegate to renderer via sendFn
    if (ctx?.sendFn) {
      ctx.sendFn('workflow-project-action', { action, projectId: projectId || varCtx.activeProjectId || '' });
    }
    return { success: true, action, projectId };
  },
};
