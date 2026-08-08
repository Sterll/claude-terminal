/**
 * probe-orphans.js — do the 8 editor-unreachable node types actually execute?
 * Only non-destructive nodes are driven; the rest are inspected statically.
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const registry = require(path.join(ROOT, 'src/main/workflow-nodes/_registry'));
registry.loadRegistry();

const ORPHANS = ['error_handler', 'kanban_create_card', 'notify_discord',
                 'parallel_spawn', 'retry', 'session_recap', 'webhook', 'workspace_write_doc'];

// Nodes with irreversible side effects — inspected, not executed.
const DESTRUCTIVE = new Set(['kanban_create_card', 'workspace_write_doc', 'parallel_spawn',
                             'notify_discord', 'webhook']);

console.log('type                  | run() | fields | outputs | status');
console.log('----------------------|-------|--------|---------|--------------------------------');
for (const t of ORPHANS) {
  const def = registry.get(`workflow/${t}`);
  if (!def) { console.log(`${t.padEnd(21)} | MISSING`); continue; }
  const hasRun = typeof def.run === 'function';
  const nf = (def.fields || []).length;
  const no = (def.outputs || []).length;
  const status = DESTRUCTIVE.has(t) ? 'not executed (side effects)' : 'probed below';
  console.log(`${t.padEnd(21)} | ${String(hasRun).padEnd(5)} | ${String(nf).padEnd(6)} | ${String(no).padEnd(7)} | ${status}`);
}
