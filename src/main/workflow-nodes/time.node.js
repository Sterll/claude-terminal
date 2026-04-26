'use strict';

module.exports = {
  type:     'workflow/time',
  title:    'Time',
  desc:     'Consulter le time tracking',
  color:    'teal',
  width:    220,
  category: 'data',
  icon:     'clock',

  inputs:  [{ name: 'In', type: 'exec' }],
  // Outputs are rebuilt dynamically via rebuildOutputs()
  outputs: [
    { name: 'Done',  type: 'exec' },
    { name: 'Error', type: 'exec' },
  ],

  props: { action: 'get_today', projectId: '' },

  fields: [
    { type: 'time-config', key: 'action', label: 'wfn.time.label' },
  ],

  badge: (n) => (n.properties.action || 'get_today').replace('get_', '').toUpperCase(),

  dynamic: 'time',

  rebuildOutputs(engine, node) {
    const action = node.properties.action || 'get_today';
    const needsProjectInput = action === 'get_project' || action === 'get_sessions';

    // Rebuild inputs: slot 0 = exec In (always), slot 1 = projectId (optional)
    const hasProjectInput = node.inputs.length > 1 && node.inputs[1]?.name === 'projectId';
    if (needsProjectInput && !hasProjectInput) {
      node.inputs.push({ name: 'projectId', type: 'string', link: null });
    } else if (!needsProjectInput && hasProjectInput) {
      if (node.inputs[1].link != null && engine._removeLink) engine._removeLink(node.inputs[1].link);
      node.inputs.splice(1, 1);
    }

    // Rebuild outputs: clear data outputs (keep exec slots 0 and 1)
    for (let i = 2; i < node.outputs.length; i++) {
      for (const lid of [...node.outputs[i].links]) {
        if (engine._removeLink) engine._removeLink(lid);
      }
    }

    const DATA_OUTPUTS = {
      get_today:        [{ name: 'today',        type: 'number' }, { name: 'week',         type: 'number' }, { name: 'month',        type: 'number' }, { name: 'projects',     type: 'array'  }],
      get_week:         [{ name: 'total',         type: 'number' }, { name: 'days',         type: 'array'  }],
      get_project:      [{ name: 'today',         type: 'number' }, { name: 'week',         type: 'number' }, { name: 'month',        type: 'number' }, { name: 'total',        type: 'number' }, { name: 'sessionCount', type: 'number' }],
      get_all_projects: [{ name: 'projects',      type: 'array'  }, { name: 'count',        type: 'number' }],
      get_sessions:     [{ name: 'sessions',      type: 'array'  }, { name: 'count',        type: 'number' }, { name: 'totalMs',      type: 'number' }],
    };

    node.outputs = [
      { name: 'Done',  type: 'exec', links: [] },
      { name: 'Error', type: 'exec', links: [] },
    ];
    for (const out of (DATA_OUTPUTS[action] || [])) {
      node.outputs.push({ name: out.name, type: out.type, links: [] });
    }
  },

  async run(config, vars) {
    const { getTimeStats } = require('../ipc/time.ipc');

    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    const result = await getTimeStats({
      action:    config.action    || 'get_today',
      projectId: resolveVars(config.projectId || '', vars) || undefined,
      startDate: resolveVars(config.startDate || '', vars) || undefined,
      endDate:   resolveVars(config.endDate   || '', vars) || undefined,
    });

    if (result?.error) throw new Error(result.error);
    return result;
  },
};
