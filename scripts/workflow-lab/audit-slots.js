/**
 * audit-slots.js — R&D harness, part A (static).
 *
 * Machine-checks every workflow node definition against the shared slot tables
 * in src/shared/workflow-schema.js. A mismatch here does not crash: it silently
 * routes the wrong value down a link, which is the worst kind of bug.
 *
 * Usage: node scripts/workflow-lab/audit-slots.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

const registry = require(path.join(ROOT, 'src/main/workflow-nodes/_registry'));
const {
  NODE_DATA_OUTPUTS, NODE_DATA_OUT_OFFSET, DYNAMIC_PIN_NODES, getOutputKeyForSlot,
} = require(path.join(ROOT, 'src/shared/workflow-schema'));

registry.loadRegistry();
const nodes = registry.getAll();

const findings = [];
const add = (type, severity, issue, detail) => findings.push({ type, severity, issue, detail });

// Nodes that build their pins at runtime: their .node.js declares no static
// data outputs and the canvas definition is the authority. WorkflowRunner
// resolves these by pin name, so a schema/def divergence is expected here.
const DYNAMIC_EXEC = DYNAMIC_PIN_NODES;

// trigger is never executed as a step; get_variable is a pure data source
// resolved inline by WorkflowRunner._resolvePureDataNode.
const NO_RUN = new Set(['trigger', 'get_variable']);

for (const def of nodes.sort((a, b) => a.type.localeCompare(b.type))) {
  const short   = def.type.replace('workflow/', '');
  const outputs = def.outputs || [];
  const declared = NODE_DATA_OUTPUTS[short];
  const offset   = NODE_DATA_OUT_OFFSET[short];

  // ── 1. leading exec-output count vs declared offset ────────────────────────
  let execCount = 0;
  for (const o of outputs) {
    if (o.type === 'exec') execCount++;
    else break;
  }
  if (!DYNAMIC_EXEC.has(short)) {
    if (offset === undefined && outputs.length > execCount) {
      add(short, 'HIGH', 'missing NODE_DATA_OUT_OFFSET',
        `has ${outputs.length - execCount} data output(s) but no offset entry -> getOutputKeyForSlot returns null, downstream reads the whole object`);
    } else if (offset !== undefined && offset !== execCount) {
      add(short, 'HIGH', 'offset mismatch',
        `NODE_DATA_OUT_OFFSET=${offset} but node has ${execCount} leading exec output(s) -> slot mapping is shifted by ${offset - execCount}`);
    }
  }

  // ── 2. declared data outputs vs actual outputs array ──────────────────────
  const actualData = outputs.slice(execCount).map(o => ({ name: o.name, type: o.type }));

  if (declared && actualData.length === 0 && !DYNAMIC_EXEC.has(short)) {
    add(short, 'HIGH', 'declared outputs but node exposes none',
      `NODE_DATA_OUTPUTS lists [${declared.map(d => d.name).join(', ')}] but outputs: has no data pins`);
  }
  if (!declared && actualData.length > 0) {
    add(short, 'HIGH', 'data pins with no NODE_DATA_OUTPUTS entry',
      `outputs: exposes [${actualData.map(d => d.name).join(', ')}] but the schema has no entry -> no key mapping`);
  }
  if (declared && actualData.length > 0) {
    if (declared.length !== actualData.length) {
      add(short, 'MED', 'data output count differs',
        `schema declares ${declared.length} ([${declared.map(d => d.name).join(', ')}]), node exposes ${actualData.length} ([${actualData.map(d => d.name).join(', ')}])`);
    }
    const n = Math.min(declared.length, actualData.length);
    for (let i = 0; i < n; i++) {
      if (declared[i].name !== actualData[i].name) {
        add(short, 'HIGH', `data output #${i} name differs`,
          `schema "${declared[i].name}" vs node "${actualData[i].name}"`);
      }
      if (declared[i].type !== actualData[i].type) {
        add(short, 'MED', `data output #${i} type differs`,
          `schema "${declared[i].type}" vs node "${actualData[i].type}" (pin colour + connection validation use this)`);
      }
    }
  }

  // ── 3. round-trip every data slot through getOutputKeyForSlot ─────────────
  if (declared && !DYNAMIC_EXEC.has(short)) {
    declared.forEach((d, i) => {
      const key = getOutputKeyForSlot(short, execCount + i);
      if (key !== d.key) {
        add(short, 'HIGH', `slot ${execCount + i} maps to the wrong key`,
          `expected "${d.key}", getOutputKeyForSlot returned ${JSON.stringify(key)}`);
      }
    });
  }

  // ── 4. props <-> fields reachability ──────────────────────────────────────
  const props  = Object.keys(def.props || {});
  const fields = def.fields || [];
  const fieldKeys = new Set(fields.map(f => f.key).filter(Boolean));

  // Custom composite fields configure several props at once; they are keyed on
  // one prop but legitimately drive others, so they can't be checked this way.
  // The *_ui entries are custom renderers that emit their own data-key inputs
  // for several props at once, so their props are reachable even though no
  // field declares them individually.
  const COMPOSITE = new Set([
    'custom',  // a render() that emits its own data-key inputs for several props
    'claude-config', 'trigger-config', 'db-config', 'loop-config',
    'project-config', 'time-config', 'sql-editor', 'cron-picker', 'cwd-picker',
    'agent-picker', 'skill-picker', 'subworkflow-picker', 'variable-autocomplete',
  ]);
  const hasComposite = fields.some(f => COMPOSITE.has(f.type));

  if (!hasComposite) {
    for (const p of props) {
      if (!fieldKeys.has(p)) {
        add(short, 'LOW', 'prop not exposed by any field', `props.${p} can only be set by hand-editing JSON`);
      }
    }
  }
  for (const k of fieldKeys) {
    if (!props.includes(k) && !COMPOSITE.has(fields.find(f => f.key === k)?.type)) {
      add(short, 'MED', 'field writes an undeclared prop',
        `fields[].key="${k}" has no entry in props: -> the default is undefined until the user touches it`);
    }
  }

  // ── 5. structural sanity ──────────────────────────────────────────────────
  if (!def.title)  add(short, 'LOW', 'missing title', 'node renders untitled in the palette');
  if (!def.category) add(short, 'LOW', 'missing category', 'node may not appear in any palette group');
  if (!NO_RUN.has(short)) {
    if (!(def.inputs || []).some(i => i.type === 'exec')) {
      add(short, 'HIGH', 'no exec input', 'nothing can trigger this node in a graph');
    }
    if (typeof def.run !== 'function') {
      add(short, 'HIGH', 'no run() method', 'falls through to the legacy runner switch or does nothing');
    }
  }
}

// ── Orphan schema entries ───────────────────────────────────────────────────
const known = new Set(nodes.map(d => d.type.replace('workflow/', '')));
for (const t of Object.keys(NODE_DATA_OUTPUTS)) {
  if (!known.has(t)) add(t, 'MED', 'schema entry with no .node.js', 'dead NODE_DATA_OUTPUTS entry');
}
for (const t of Object.keys(NODE_DATA_OUT_OFFSET)) {
  if (!known.has(t)) add(t, 'MED', 'offset entry with no .node.js', 'dead NODE_DATA_OUT_OFFSET entry');
}

// ── Report ──────────────────────────────────────────────────────────────────
const order = { HIGH: 0, MED: 1, LOW: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.type.localeCompare(b.type));

console.log(`Audited ${nodes.length} nodes\n`);
let last = null;
for (const f of findings) {
  if (f.severity !== last) { console.log(`\n===== ${f.severity} =====`); last = f.severity; }
  console.log(`  [${f.type}] ${f.issue}`);
  console.log(`      ${f.detail}`);
}
const counts = findings.reduce((a, f) => (a[f.severity] = (a[f.severity] || 0) + 1, a), {});
console.log(`\n--- ${findings.length} findings: ${JSON.stringify(counts)} ---`);
