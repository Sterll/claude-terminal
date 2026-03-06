'use strict';

const fs   = require('fs');
const path = require('path');

module.exports = {
  type:     'workflow/file',
  title:    'File',
  desc:     'File operation',
  color:    'lime',
  width:    220,
  category: 'data',
  icon:     'file',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',    type: 'exec'   },
    { name: 'Error',   type: 'exec'   },
    { name: 'content', type: 'string' },
    { name: 'files',   type: 'array'  },
    { name: 'exists',  type: 'boolean'},
    { name: 'success', type: 'boolean'},
  ],

  props: { action: 'read', path: '', destination: '', content: '', pattern: '*', recursive: false },

  fields: [
    { type: 'select', key: 'action', label: 'wfn.file.action.label',
      options: [
        { value: 'read',   label: 'wfn.file.action.read' },
        { value: 'write',  label: 'wfn.file.action.write' },
        { value: 'append', label: 'wfn.file.action.append' },
        { value: 'copy',   label: 'wfn.file.action.copy' },
        { value: 'move',   label: 'wfn.file.action.move' },
        { value: 'delete', label: 'wfn.file.action.delete' },
        { value: 'exists', label: 'wfn.file.action.exists' },
        { value: 'list',   label: 'wfn.file.action.list' },
      ] },
    // For non-list actions: path input
    { type: 'text', key: 'path', label: 'wfn.file.path.label', mono: true,
      hint: 'wfn.file.path.hint',
      placeholder: './src/index.js',
      showIf: (p) => p.action !== 'list' },
    // For list action: folder path
    { type: 'text', key: 'path', label: 'wfn.file.folder.label', mono: true,
      hint: 'wfn.file.folder.hint',
      placeholder: './src',
      showIf: (p) => p.action === 'list' },
    { type: 'text', key: 'pattern', label: 'wfn.file.pattern.label', mono: true,
      hint: 'wfn.file.pattern.hint',
      placeholder: '**/*.js',
      showIf: (p) => p.action === 'list' },
    { type: 'select', key: 'type', label: 'wfn.file.type.label',
      options: [
        { value: 'files', label: 'wfn.file.type.files' },
        { value: 'dirs',  label: 'wfn.file.type.dirs' },
        { value: 'all',   label: 'wfn.file.type.all' },
      ],
      showIf: (p) => p.action === 'list' },
    { type: 'toggle', key: 'recursive', label: 'wfn.file.recursive.label',
      showIf: (p) => p.action === 'list' },
    { type: 'text', key: 'destination', label: 'wfn.file.destination.label', mono: true,
      hint: 'wfn.file.destination.hint',
      placeholder: './backup/index.js.bak',
      showIf: (p) => p.action === 'copy' || p.action === 'move' },
    { type: 'textarea', key: 'content', label: 'wfn.file.content.label', mono: true,
      hint: 'wfn.file.content.hint',
      placeholder: "console.log('Hello world');",
      showIf: (p) => p.action === 'write' || p.action === 'append' },
  ],

  badge: (n) => (n.properties.action || 'read').toUpperCase(),

  async run(config, vars) {
    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    const assertPathWithinProject = (filePath, vars) => {
      const ctx = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
      const projectDir = ctx.project;
      if (!projectDir) return;
      const resolved = path.resolve(filePath);
      const base = path.resolve(projectDir);
      const cmp = process.platform === 'win32'
        ? (a, b) => a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(b.toLowerCase() + path.sep)
        : (a, b) => a === b || a.startsWith(b + path.sep);
      if (!cmp(resolved, base)) {
        throw new Error(`Path "${filePath}" is outside the project directory`);
      }
    };

    const expandGlob = (pattern, baseDir) => {
      const toRegex = (pat) => {
        let reStr = pat
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '\x00DOUBLESTAR\x00')
          .replace(/\*/g, '[^/\\\\]*')
          .replace(/\x00DOUBLESTAR\x00/g, '.*')
          .replace(/\?/g, '[^/\\\\]');
        return new RegExp('^' + reStr + '$', process.platform === 'win32' ? 'i' : '');
      };
      const re = toRegex(pattern);
      const results = [];
      const walk = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const relPath = rel ? rel + '/' + entry.name : entry.name;
          if (entry.isDirectory()) {
            walk(path.join(dir, entry.name), relPath);
          } else {
            if (re.test(relPath)) results.push(relPath);
          }
        }
      };
      walk(baseDir, '');
      return results;
    };

    const action  = config.action || 'read';
    const p       = resolveVars(config.path        || '', vars);
    const dest    = resolveVars(config.destination || config.dest || '', vars);
    const content = resolveVars(config.content     || '', vars);

    if (p && action !== 'list') assertPathWithinProject(p, vars);
    if (dest) assertPathWithinProject(dest, vars);

    switch (action) {
      case 'read':
        return { content: fs.readFileSync(p, 'utf8') };
      case 'write':
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, 'utf8');
        return { success: true };
      case 'append':
        fs.appendFileSync(p, content, 'utf8');
        return { success: true };
      case 'copy':
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(p, dest);
        return { success: true };
      case 'delete':
        fs.rmSync(p, { force: true, recursive: true });
        return { success: true };
      case 'exists':
        return { exists: fs.existsSync(p), path: p };
      case 'move':
      case 'rename': {
        if (!dest) throw new Error('File move/rename requires a destination path');
        assertPathWithinProject(p, vars);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(p, dest);
        return { success: true, from: p, to: dest };
      }
      case 'list': {
        const ctx = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
        const baseDir = p || ctx.project || process.cwd();
        if (baseDir) assertPathWithinProject(baseDir, vars);
        const pattern   = resolveVars(config.pattern || '*', vars);
        const recursive = config.recursive === true || config.recursive === 'true';
        let files;
        if (!recursive && !pattern.includes('**') && !pattern.includes('/')) {
          let entries;
          try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch { entries = []; }
          const re = new RegExp(
            '^' + pattern
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '[^/\\\\]*')
              .replace(/\?/g, '[^/\\\\]') + '$',
            process.platform === 'win32' ? 'i' : ''
          );
          const type = config.type || 'files';
          files = entries
            .filter(e => {
              if (type === 'files' && !e.isFile()) return false;
              if (type === 'dirs'  && !e.isDirectory()) return false;
              return re.test(e.name);
            })
            .map(e => e.name);
        } else {
          files = expandGlob(pattern, baseDir);
        }
        return { files, count: files.length, dir: baseDir };
      }
      default:
        throw new Error(`Unknown file action: ${action}`);
    }
  },
};
