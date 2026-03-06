'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

module.exports = {
  type:     'workflow/loop',
  title:    'Loop',
  desc:     'Itérer sur une liste',
  color:    'sky',
  width:    210,
  category: 'flow',
  icon:     'loop',

  inputs:  [{ name: 'In', type: 'exec' }, { name: 'items', type: 'array' }],
  outputs: [
    { name: 'Each',  type: 'exec'   },
    { name: 'Done',  type: 'exec'   },
    { name: 'item',  type: 'any'    },
    { name: 'index', type: 'number' },
  ],

  props: { source: 'auto', items: '', mode: 'sequential', maxIterations: '', concurrency: '10', _itemSchema: [] },

  fields: [
    { type: 'loop-config', key: 'source', label: 'wfn.loop.source.label' },
  ],

  badge: (n) => n.properties.mode === 'parallel' ? 'PARALLEL' : (n.properties.source || 'auto').toUpperCase(),
  badgeColor: (n) => n.properties.mode === 'parallel' ? '#f59e0b' : null,

  async run(config, vars, signal) {
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

    let items;
    const source = config.source || 'auto';

    if (source === 'projects') {
      const projFile = path.join(os.homedir(), '.claude-terminal', 'projects.json');
      try {
        const data = JSON.parse(fs.readFileSync(projFile, 'utf8'));
        items = (data.projects || []).map(p => ({ id: p.id, name: p.name, path: p.path, type: p.type || 'general' }));
      } catch {
        items = [];
      }
    } else if (source === 'custom' && config.items) {
      items = resolveVars(config.items, vars);
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch { items = items.split(',').map(s => s.trim()).filter(Boolean); }
      }
    } else {
      // auto: try to find last array in vars
      const over = config.items || config.over || '';
      if (over) {
        const parts = over.replace(/^\$/, '').split('.');
        items = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && items != null; i++) items = items[parts[i]];
      }
      if (!items && vars instanceof Map) {
        // scan vars for most recent array value
        for (const [, v] of [...vars].reverse()) {
          if (Array.isArray(v)) { items = v; break; }
        }
      }
    }

    if (!Array.isArray(items)) items = items != null ? [items] : [];

    const maxIter = config.maxIterations ? parseInt(config.maxIterations, 10) : null;
    if (maxIter && items.length > maxIter) items = items.slice(0, maxIter);

    // In node context the graph engine handles Each/Done routing;
    // here we expose the items array and meta for graph-based usage.
    return { items, count: items.length, success: true };
  },
};
