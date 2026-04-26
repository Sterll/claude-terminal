'use strict';

function resolveVars(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
    const parts = key.split('.');
    let cur = vars instanceof Map ? vars.get(parts[0]) : vars?.[parts[0]];
    for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
    return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
  });
}

module.exports = {
  type:     'workflow/workspace_write_doc',
  title:    'Workspace: Write Doc',
  desc:     'Crée ou met à jour un document KB de workspace',
  color:    'teal',
  width:    240,
  category: 'actions',
  icon:     'workspace',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',     type: 'exec'   },
    { name: 'Error',    type: 'exec'   },
    { name: 'docId',    type: 'string' },
    { name: 'filename', type: 'string' },
  ],

  props: {
    workspace: '',
    title:     '',
    content:   '',
    tags:      '',
  },

  fields: [
    { type: 'text',     key: 'workspace', label: 'wfn.workspace.id.label',
      hint: 'wfn.workspace.id.hint',
      placeholder: 'my-workspace' },
    { type: 'text',     key: 'title',     label: 'wfn.workspace.title.label',
      placeholder: 'Architecture notes' },
    { type: 'textarea', key: 'content',   label: 'wfn.workspace.content.label', mono: true,
      placeholder: '# Heading\n\nContent in markdown...' },
    { type: 'text',     key: 'tags',      label: 'wfn.workspace.tags.label',
      hint: 'wfn.workspace.tags.hint',
      placeholder: 'api, backend' },
  ],

  badge: () => 'KB',

  async run(config, vars, signal) {
    if (signal?.aborted) throw new Error('Aborted');

    const wsRef   = resolveVars(config.workspace || '', vars).trim();
    const title   = resolveVars(config.title     || '', vars).trim();
    const content = resolveVars(config.content   || '', vars);
    const tagsRaw = resolveVars(config.tags      || '', vars).trim();

    if (!wsRef) throw new Error('Workspace id or name is required');
    if (!title) throw new Error('Doc title is required');

    const WorkspaceService = require('../services/WorkspaceService');
    const workspace = await WorkspaceService.getWorkspace(wsRef);
    if (!workspace) throw new Error(`Workspace "${wsRef}" not found`);

    const doc = await WorkspaceService.writeDoc(workspace.id, title, content || '');
    if (!doc) throw new Error('Failed to write doc');

    // Attach tags if provided (writeDoc does not support tags directly — patch index)
    if (tagsRaw) {
      const tags = tagsRaw.split(',').map(s => s.trim()).filter(Boolean);
      if (tags.length > 0) {
        try {
          const fs = require('fs');
          const path = require('path');
          const indexPath = path.join(WorkspaceService.workspacesDir, workspace.id, 'docs-index.json');
          const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
          const entry = (data.docs || []).find(d => d.id === doc.id);
          if (entry) {
            entry.tags = Array.from(new Set([...(entry.tags || []), ...tags]));
            const tmp = indexPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, indexPath);
          }
        } catch (e) {
          console.warn('[workspace_write_doc] Failed to attach tags:', e.message);
        }
      }
    }

    return {
      docId:       doc.id,
      filename:    doc.filename,
      workspaceId: workspace.id,
      title:       doc.title,
    };
  },
};
