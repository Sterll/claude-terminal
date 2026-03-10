/**
 * Custom field renderer registry for workflow nodes.
 * Fields handle rendering and binding of non-standard property types
 * (agent-picker, skill-picker, cron-picker, variable-autocomplete, sql-editor, etc.)
 */

const { escapeHtml } = require('../utils/dom');

const _fieldRenderers = new Map();

function loadField(type, def) {
  _fieldRenderers.set(type, def);
}

function get(type) {
  return _fieldRenderers.get(type);
}

function has(type) {
  return _fieldRenderers.has(type);
}

/**
 * Loads all built-in field renderers.
 * Must be called explicitly — require() is manual because esbuild bundles
 * the renderer and there is no fs access at runtime.
 */
function loadAll() {
  const files = [
    require('./agent-picker.field'),
    require('./skill-picker.field'),
    require('./cron-picker.field'),
    require('./variable-autocomplete.field'),
    require('./sql-editor.field'),
    // Batch 2 field renderers
    require('./cwd-picker.field'),
    require('./trigger-config.field'),
    require('./claude-config.field'),
    require('./db-config.field'),
    require('./loop-config.field'),
    require('./time-config.field'),
    require('./project-config.field'),
    require('./subworkflow-picker.field'),
  ];
  for (const def of files) {
    if (def && def.type) {
      _fieldRenderers.set(def.type, def);
    }
  }
}

// ─── Shared HTML helpers ────────────────────────────────────────────────────

function escapeAttr(s) {
  return String(s)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { loadAll, loadField, get, has, escapeHtml, escapeAttr };
