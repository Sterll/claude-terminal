'use strict';

/**
 * Workflow Tools Module for Claude Terminal MCP
 *
 * Provides workflow automation tools. Reads workflow definitions and run history
 * from CT_DATA_DIR/workflows/ directory.
 *
 * Tools: workflow_list, workflow_get, workflow_trigger, workflow_cancel,
 *        workflow_runs, workflow_status, workflow_run_logs, workflow_diagnose,
 *        workflow_add_variable, workflow_get_variables, workflow_rename,
 *        workflow_clone, workflow_export, workflow_import, workflow_delete,
 *        workflow_enable, workflow_test_node
 */

const fs = require('fs');
const path = require('path');

// Resolve node registry: packaged app (extraResources) → dev fallback → graceful skip
let nodeRegistry = null;
try {
  // Packaged app: workflow-nodes/ is copied alongside mcp-servers/ as extraResources
  nodeRegistry = require(path.join(__dirname, '..', 'workflow-nodes', '_registry'));
} catch (_) {
  try {
    // Dev environment: src/main/workflow-nodes/ relative to repo root
    nodeRegistry = require(path.join(__dirname, '..', '..', '..', 'src', 'main', 'workflow-nodes', '_registry'));
  } catch (e) {
    process.stderr.write(`[ct-mcp:workflow] Node registry unavailable, slots will use fallback: ${e.message}\n`);
  }
}
if (nodeRegistry) nodeRegistry.loadRegistry();

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:workflow] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function loadDefinitions() {
  const file = path.join(getDataDir(), 'workflows', 'definitions.json');
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Format may be [{ workflow: {...} }] or [{id, name, ...}]
      return raw.map(entry => entry.workflow || entry);
    }
  } catch (e) {
    log('Error reading definitions.json:', e.message);
  }
  return [];
}

function loadHistory() {
  const file = path.join(getDataDir(), 'workflows', 'history.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading history.json:', e.message);
  }
  return [];
}

function loadRunResult(runId) {
  const file = path.join(getDataDir(), 'workflows', 'results', `${runId}.json`);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading run result:', e.message);
  }
  return null;
}

function signalReload() {
  try {
    const triggerDir = path.join(getDataDir(), 'workflows', 'triggers');
    if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });
    const f = path.join(triggerDir, `reload_${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify({ action: 'reload', source: 'mcp', timestamp: new Date().toISOString() }), 'utf8');
  } catch (e) { log('signalReload error:', e.message); }
}

function findWorkflow(nameOrId) {
  const defs = loadDefinitions();
  return defs.find(w =>
    w.id === nameOrId ||
    w.name.toLowerCase() === nameOrId.toLowerCase()
  );
}

// -- Formatters ---------------------------------------------------------------

function formatTrigger(trigger) {
  if (!trigger) return 'manual';
  if (trigger.type === 'cron') return `cron: ${trigger.value}`;
  if (trigger.type === 'hook') return `hook: ${trigger.hookType || trigger.value}`;
  if (trigger.type === 'on_workflow') return `after: ${trigger.value}`;
  if (trigger.type === 'webhook') return 'webhook (HTTP POST via cloud)';
  return trigger.type || 'manual';
}

function formatDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

function formatStatus(status) {
  const icons = { success: 'OK', failed: 'FAIL', running: 'RUN', cancelled: 'CANCEL', pending: 'WAIT', skipped: 'SKIP', queued: 'QUEUE' };
  return icons[status] || status;
}

/** Find a run in history by ID */
function loadRunFromHistory(runId) {
  const history = loadHistory();
  return history.find(r => r.id === runId) || null;
}

/** Format a single step output into readable text */
function formatStepOutputText(nodeId, stepType, output, indent = '') {
  if (!output || typeof output !== 'object') {
    return output != null ? `${indent}${String(output).slice(0, 500)}` : '';
  }

  const type = stepType || output._type || '';
  const lines = [];

  if (type === 'shell' || type === 'git') {
    if (output.stdout && output.stdout.trim()) {
      lines.push(`${indent}stdout: ${output.stdout.trim().slice(0, 1000)}`);
    }
    if (output.stderr && output.stderr.trim()) {
      lines.push(`${indent}stderr: ${output.stderr.trim().slice(0, 500)}`);
    }
    if (output.exitCode !== undefined) {
      lines.push(`${indent}exit: ${output.exitCode}`);
    }
  } else if (type === 'claude' || type === 'agent') {
    const text = output.text || output.output || output.result || '';
    if (text) lines.push(`${indent}${text.slice(0, 2000)}`);
    if (output.toolCalls && output.toolCalls.length) {
      lines.push(`${indent}tools used: ${output.toolCalls.map(t => t.name || t).join(', ')}`);
    }
  } else if (type === 'http') {
    lines.push(`${indent}status: ${output.status || '?'}`);
    if (output.body) {
      const body = typeof output.body === 'string' ? output.body : JSON.stringify(output.body);
      lines.push(`${indent}body: ${body.slice(0, 500)}`);
    }
  } else if (type === 'condition') {
    lines.push(`${indent}result: ${output.result}`);
    if (output.expression) lines.push(`${indent}expression: ${output.expression}`);
  } else if (type === 'variable') {
    lines.push(`${indent}${output.name} ${output.action || 'set'} = ${JSON.stringify(output.value)}`);
  } else if (type === 'loop') {
    const items = output.items || [];
    const count = output.count || items.length;
    lines.push(`${indent}iterations: ${items.length}/${count}`);
    items.slice(0, 5).forEach((iter, i) => {
      const item = iter._item;
      const label = item?.name || item?.path || (typeof item === 'string' ? item.slice(0, 40) : `item ${i + 1}`);
      const childEntries = Object.entries(iter).filter(([k]) => k !== '_item');
      const failed = childEntries.filter(([, v]) => v?._status === 'failed');
      const status = failed.length ? 'FAIL' : 'OK';
      lines.push(`${indent}  [${i + 1}] ${label} → ${status}`);
      if (failed.length) {
        for (const [nid, v] of failed) {
          const errText = v?.stdout || v?.stderr || v?.output || v?.error || '';
          if (errText) lines.push(`${indent}      ${nid}: ${String(errText).slice(0, 200)}`);
        }
      }
    });
    if (items.length > 5) lines.push(`${indent}  ... and ${items.length - 5} more`);
  } else if (type === 'file') {
    if (output.content) lines.push(`${indent}content: ${String(output.content).slice(0, 300)}`);
    if (output.exists !== undefined) lines.push(`${indent}exists: ${output.exists}`);
  } else if (type === 'db') {
    lines.push(`${indent}rows: ${output.rowCount ?? (output.rows || []).length}`);
    if (output.firstRow) lines.push(`${indent}first row: ${JSON.stringify(output.firstRow).slice(0, 200)}`);
  } else {
    // Generic fallback: print non-private keys
    const entries = Object.entries(output).filter(([k]) => !k.startsWith('_'));
    for (const [k, v] of entries.slice(0, 8)) {
      const val = typeof v === 'string' ? v.slice(0, 300) : JSON.stringify(v).slice(0, 300);
      lines.push(`${indent}${k}: ${val}`);
    }
  }

  return lines.join('\n');
}

// -- Graph helpers -------------------------------------------------------------

function loadWorkflowDef(nameOrId) {
  const defs = loadDefinitions();
  return defs.find(w =>
    w.id === nameOrId ||
    (w.name || '').toLowerCase() === nameOrId.toLowerCase()
  ) || null;
}

function saveWorkflowDef(workflow) {
  // Always repair slot refs before saving so the graph renders correctly in LiteGraph
  if (workflow.graph) repairSlotRefs(workflow.graph);
  const file = path.join(getDataDir(), 'workflows', 'definitions.json');
  let defs = [];
  try { if (fs.existsSync(file)) defs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  const idx = defs.findIndex(w => w.id === workflow.id);
  if (idx >= 0) defs[idx] = workflow;
  else defs.push(workflow);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(defs, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Rebuilds inputs[].link and outputs[].links from the graph.links[] array.
// Fixes legacy workflows where slot references were missing.
function repairSlotRefs(graph) {
  if (!graph || !graph.links) return;
  for (const node of graph.nodes || []) {
    if (node.outputs) for (const o of node.outputs) { if (!Array.isArray(o.links)) o.links = []; }
    if (node.inputs)  for (const i of node.inputs)  { if (i.link === undefined) i.link = null; }
  }
  for (const link of graph.links) {
    const [linkId, fromId, fromSlot, toId, toSlot] = link;
    const src = (graph.nodes || []).find(n => n.id === fromId);
    const dst = (graph.nodes || []).find(n => n.id === toId);
    if (src && src.outputs && src.outputs[fromSlot]) {
      if (!Array.isArray(src.outputs[fromSlot].links)) src.outputs[fromSlot].links = [];
      if (!src.outputs[fromSlot].links.includes(linkId)) src.outputs[fromSlot].links.push(linkId);
    }
    if (dst && dst.inputs && dst.inputs[toSlot]) {
      dst.inputs[toSlot].link = linkId;
    }
  }
}

// ── Auto-layout: topological sort → vertical/horizontal placement ─────────

const LAYOUT_TITLE_H   = 30;
const LAYOUT_SLOT_H    = 22;
const LAYOUT_WIDGET_H  = 28;  // slightly padded for MCP estimation
const LAYOUT_NODE_W    = 200;
const LAYOUT_GAP_X     = 80;  // horizontal gap between columns
const LAYOUT_GAP_Y     = 40;  // vertical gap between nodes in same column
const LAYOUT_ORIGIN_X  = 80;
const LAYOUT_ORIGIN_Y  = 80;

function estimateNodeHeight(node) {
  const inputs  = node.inputs  ? node.inputs.length  : 0;
  const outputs = node.outputs ? node.outputs.length  : 0;
  const slots   = Math.max(inputs, outputs);
  const widgets = node.widgets ? node.widgets.length : 0;
  return LAYOUT_TITLE_H + Math.max(slots * LAYOUT_SLOT_H + widgets * LAYOUT_WIDGET_H + 10, 50);
}

function autoLayoutGraph(graph) {
  const nodes = graph.nodes || [];
  const links = graph.links || [];
  if (!nodes.length) return;

  // Build adjacency: exec links only (type -1 or slot 0/1 for most nodes)
  const children = new Map();  // nodeId → [nodeId]
  const parents  = new Map();  // nodeId → [nodeId]
  for (const n of nodes) { children.set(n.id, []); parents.set(n.id, []); }

  for (const link of links) {
    const [, fromId, , toId] = link;
    if (children.has(fromId) && parents.has(toId)) {
      children.get(fromId).push(toId);
      parents.get(toId).push(fromId);
    }
  }

  // Assign depth via BFS from roots (nodes with no parents)
  const depth = new Map();
  const roots = nodes.filter(n => !parents.get(n.id)?.length);
  // If no clear root, use trigger node or first node
  if (!roots.length) {
    const trigger = nodes.find(n => (n.type || '').includes('trigger'));
    roots.push(trigger || nodes[0]);
  }

  const queue = roots.map(n => ({ id: n.id, d: 0 }));
  const visited = new Set();
  for (const r of queue) { depth.set(r.id, 0); visited.add(r.id); }

  while (queue.length) {
    const { id, d } = queue.shift();
    for (const child of (children.get(id) || [])) {
      const newDepth = d + 1;
      if (!visited.has(child) || (depth.get(child) || 0) < newDepth) {
        depth.set(child, newDepth);
        if (!visited.has(child)) {
          visited.add(child);
          queue.push({ id: child, d: newDepth });
        }
      }
    }
  }

  // Assign disconnected nodes to depth 0
  for (const n of nodes) {
    if (!depth.has(n.id)) depth.set(n.id, 0);
  }

  // Group by depth
  const columns = new Map(); // depth → [node]
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  }

  // Sort depths and place nodes
  const sortedDepths = [...columns.keys()].sort((a, b) => a - b);

  for (const d of sortedDepths) {
    const col = columns.get(d);
    // Sort nodes within column by their original order for stability
    col.sort((a, b) => (a.order || a.id) - (b.order || b.id));

    let y = LAYOUT_ORIGIN_Y;
    const x = LAYOUT_ORIGIN_X + d * (LAYOUT_NODE_W + LAYOUT_GAP_X);

    for (const node of col) {
      const h = estimateNodeHeight(node);
      node.pos = [x, y];
      node.size = [LAYOUT_NODE_W, h - LAYOUT_TITLE_H];
      y += h + LAYOUT_GAP_Y;
    }
  }
}

function nextNodeId(graph) {
  const nodes = (graph && graph.nodes) || [];
  return nodes.length ? Math.max(...nodes.map(n => n.id)) + 1 : 1;
}

function nextLinkId(graph) {
  const links = (graph && graph.links) || [];
  return links.length ? Math.max(...links.map(l => l[0])) + 1 : 1;
}

// Pin type constants (mirror of PIN_TYPES in WorkflowGraphService.js)
// exec=-1 (LiteGraph EVENT), data pins are typed strings
const EXEC = -1;

function slot(name, type) {
  return { name, type, link: null };
}
function outSlot(name, type, i) {
  return { name, type, links: [], slot_index: i };
}
function execIn()  { return [slot('In', EXEC)]; }
function execOut(...names) { return names.map((n, i) => outSlot(n, EXEC, i)); }

// Returns the default inputs/outputs slot definitions for a node type.
// Delegates to the node registry; falls back to Done+Error if type is unknown.
function getNodeSlots(type) {
  const def = nodeRegistry ? nodeRegistry.get(type) : null;
  if (!def) {
    return { inputs: execIn(), outputs: execOut('Done', 'Error') };
  }

  return {
    inputs: def.inputs.map((pin, idx) => ({
      name: pin.name,
      type: pin.type === 'exec' ? EXEC : (pin.type || 'any'),
      link: null,
    })),
    outputs: def.outputs.map((pin, idx) => ({
      name: pin.name,
      type: pin.type === 'exec' ? EXEC : (pin.type || 'any'),
      links: [],
      slot_index: idx,
    })),
  };
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'workflow_list',
    description: 'List all workflows configured in Claude Terminal with their trigger type, enabled status, and last run result.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'workflow_get',
    description: 'Get detailed info about a specific workflow: steps, trigger config, concurrency, dependencies, and recent runs.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'workflow_trigger',
    description: 'Trigger a workflow to run. Returns the run ID. The workflow executes asynchronously — use workflow_runs to check results.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'workflow_cancel',
    description: 'Cancel a running workflow execution.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run ID to cancel' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'workflow_runs',
    description: 'Get run history for a workflow (or all workflows). Shows status, duration, trigger, and step results. Loop steps show iteration count (×N). Child nodes inside loops are not shown as separate steps — they are embedded in the loop step output.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID (omit for all workflows)' },
        limit: { type: 'number', description: 'Max runs to return (default: 10)' },
      },
    },
  },
  {
    name: 'workflow_status',
    description: 'Get currently active (running/queued) workflow executions.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Graph editing tools ────────────────────────────────────────────────────

  {
    name: 'workflow_create',
    description: 'Create a new workflow with an optional initial graph. Returns the new workflow ID. Use this to start building a workflow from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name (required)' },
        trigger_type: { type: 'string', enum: ['manual', 'cron', 'hook', 'on_workflow', 'webhook'], description: 'Trigger type (default: manual). webhook = triggered by external HTTP POST via cloud relay' },
        trigger_value: { type: 'string', description: 'Cron expression or hook type depending on trigger_type' },
        graph: { type: 'object', description: 'Optional full LiteGraph JSON { nodes[], links[] } to set immediately' },
      },
      required: ['name'],
    },
  },
  {
    name: 'workflow_add_node',
    description: 'Add a node to an existing workflow graph. Returns the new node ID. Available types: workflow/trigger, workflow/shell, workflow/claude, workflow/git, workflow/http, workflow/db, workflow/file, workflow/notify, workflow/wait, workflow/log, workflow/condition, workflow/loop, workflow/variable, workflow/get_variable, workflow/transform, workflow/subworkflow, workflow/switch, workflow/project, workflow/time. workflow/get_variable is a pure data node (no exec pins) — connect it directly to any data input pin to supply a variable value. workflow/project with action "list" returns all Claude Terminal projects as an array — connect its Projects output (slot 2) to a Loop node Items input (slot 1) to iterate over projects. Loop node: slot 0 output = Each (body of the loop, connects to first child node), slot 1 output = Done (continues after loop ends). Child nodes inside a loop body are NOT shown as top-level steps in run history — only the loop step itself appears, with an iteration badge. For claude/shell/git nodes, set projectId="__custom__" and cwd="<path>" to use a custom working directory (supports variable interpolation like $item.path). workflow/file actions: read (content→slot2), write, append, copy, delete, exists (exists→slot3), move/rename (use destination property for new path), list (glob→slot4 files array, slot5 count — use properties: { path: "./src", pattern: "**/*.js", recursive: true, type: "files|dirs|all" }). list output files array is ideal to connect to a Loop node to process each file. workflow/time reads Claude Terminal time tracking data — actions: get_today (today=slot2/week=slot3/month=slot4 ms + projects=slot5 array), get_week (total=slot2 ms + days=slot3 array [{date,dayOfWeek,ms,formatted}]), get_project (today=slot2/week=slot3/month=slot4/total=slot5 ms + sessionCount=slot6 — set projectId property OR connect a string data pin to its projectId input slot1), get_all_projects (projects=slot2 array sorted by today desc + count=slot3 — connect projects to Loop Items slot1), get_sessions (sessions=slot2 array + count=slot3 + totalMs=slot4, filterable via startDate/endDate properties, optional projectId input pin slot1). Divide ms by 3600000 for hours. Pattern: get_all_projects→Loop→get_project builds per-project reports. Tip: you can skip pos and call workflow_auto_layout after adding all nodes to arrange them cleanly.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
        type: { type: 'string', description: 'Node type (e.g. workflow/shell, workflow/condition)' },
        pos: {
          type: 'array',
          items: { type: 'number' },
          description: 'Position [x, y] on the canvas. Optional — use workflow_auto_layout after building to arrange all nodes cleanly.',
        },
        properties: { type: 'object', description: 'Node properties (command, prompt, variable, operator, value, etc.)' },
        title: { type: 'string', description: 'Optional custom display title for the node' },
      },
      required: ['workflow', 'type'],
    },
  },
  {
    name: 'workflow_connect_nodes',
    description: 'Connect an output slot of one node to an input slot of another. Slot conventions: most nodes have 1 input (slot 0) and outputs slot0=Done/True, slot1=Error/False. Condition: slot0=TRUE path, slot1=FALSE path. Loop: slot0=Each body (connects to first child node inside the loop), slot1=Done (connects to first node after the loop). IMPORTANT: child nodes inside a loop body must be connected to the Loop\'s slot0 (Each) — they will not appear as top-level steps, only the Loop node does.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
        from_node: { type: 'number', description: 'Origin node ID' },
        from_slot: { type: 'number', description: 'Output slot index (0=Done/True/Start, 1=Error/False/Each)' },
        to_node: { type: 'number', description: 'Target node ID' },
        to_slot: { type: 'number', description: 'Input slot index (almost always 0)' },
      },
      required: ['workflow', 'from_node', 'from_slot', 'to_node', 'to_slot'],
    },
  },
  {
    name: 'workflow_update_node',
    description: 'Update properties or title of an existing node in a workflow graph.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
        node_id: { type: 'number', description: 'Node ID to update' },
        properties: { type: 'object', description: 'Properties to merge into the node (partial update)' },
        title: { type: 'string', description: 'New custom title for the node' },
      },
      required: ['workflow', 'node_id'],
    },
  },
  {
    name: 'workflow_delete_node',
    description: 'Delete a node (and all its connected links) from a workflow graph.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
        node_id: { type: 'number', description: 'Node ID to delete' },
      },
      required: ['workflow', 'node_id'],
    },
  },
  {
    name: 'workflow_add_variable',
    description: 'Add an abstract variable definition to a workflow. Variables are named typed values stored in the Variables panel (separate from graph nodes). Once defined, they can be referenced in workflow/variable and workflow/get_variable nodes by name. Types: string, number, boolean, array, object, any.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
        name: { type: 'string', description: 'Variable name (e.g. "today", "projectList")' },
        varType: { type: 'string', enum: ['string', 'number', 'boolean', 'array', 'object', 'any'], description: 'Variable type (default: any)' },
      },
      required: ['workflow', 'name'],
    },
  },
  {
    name: 'workflow_get_variables',
    description: 'List all variables defined in a workflow. Variables are abstract definitions (name + type) stored in the Variables panel, separate from graph nodes. Also shows which graph nodes reference each variable.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'workflow_get_graph',
    description: 'Get the full graph (nodes + links) of a workflow in a readable format. Use this to understand the current structure before making changes.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'workflow_rename',
    description: 'Rename an existing workflow. Changes the display name of the workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Current workflow name or ID' },
        new_name: { type: 'string', description: 'New name for the workflow' },
      },
      required: ['workflow', 'new_name'],
    },
  },
  {
    name: 'workflow_auto_layout',
    description: 'Auto-arrange all nodes in a workflow graph for clean visual layout. Uses topological sort to place nodes in columns left-to-right following execution flow. Call this after building a workflow to clean up node positions.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
      },
      required: ['workflow'],
    },
  },

  {
    name: 'workflow_run_logs',
    description: 'Get full step-by-step logs and outputs for a specific run. Shows stdout/stderr for shell nodes, Claude agent output, HTTP responses, error details, and loop iteration results. Use this after workflow_runs to get the detailed output of a specific run (identified by its run ID from the run history).',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run ID (e.g. run_abc123). Get it from workflow_runs output.' },
      },
      required: ['run_id'],
    },
  },

  {
    name: 'workflow_diagnose',
    description: 'Analyse a workflow run and diagnose what happened: success/failure cause, error messages, which step failed, loop iteration results, and suggested fixes. Use this to understand why a run failed or to verify a run worked correctly. Combines run history + step outputs for a complete picture.',
    inputSchema: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Run ID to diagnose. Get it from workflow_runs output.' },
      },
      required: ['run_id'],
    },
  },

  // ── Management tools ──────────────────────────────────────────────────────

  {
    name: 'workflow_clone',
    description: 'Duplicate an existing workflow with a new name.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Source workflow name or ID' },
        name: { type: 'string', description: 'Name for the clone' },
      },
      required: ['workflow', 'name'],
    },
  },
  {
    name: 'workflow_export',
    description: 'Export a workflow definition as JSON for sharing or backup.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'workflow_import',
    description: 'Import a workflow from a JSON definition.',
    inputSchema: {
      type: 'object',
      properties: {
        json: { type: 'string', description: 'JSON workflow definition' },
        name: { type: 'string', description: 'Override the workflow name (optional)' },
      },
      required: ['json'],
    },
  },
  {
    name: 'workflow_delete',
    description: 'Delete a workflow permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
      },
      required: ['workflow'],
    },
  },
  {
    name: 'workflow_enable',
    description: 'Enable or disable a workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      required: ['workflow', 'enabled'],
    },
  },
  {
    name: 'workflow_test_node',
    description: 'Test a single workflow node by writing a test trigger. The node will be executed in isolation by Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow: { type: 'string', description: 'Workflow name or ID' },
        node_id: { type: 'number', description: 'The node ID to test' },
      },
      required: ['workflow', 'node_id'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'workflow_list') {
      const defs = loadDefinitions();
      if (!defs.length) return ok('No workflows configured. Create workflows in Claude Terminal > Workflows panel.');

      const history = loadHistory();

      const lines = defs.map(w => {
        const lastRun = history
          .filter(r => r.workflowId === w.id)
          .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0];

        const nodeCount = w.graph?.nodes?.length || (w.steps || []).length || 0;
        const parts = [
          `${w.name} (${w.id})`,
          `  Trigger: ${formatTrigger(w.trigger)}`,
          `  Enabled: ${w.enabled !== false ? 'yes' : 'no'}`,
          `  Nodes: ${nodeCount}`,
        ];

        if (lastRun) {
          parts.push(`  Last run: ${formatStatus(lastRun.status)} (${lastRun.duration || '—'})`);
        } else {
          parts.push('  Last run: never');
        }

        return parts.join('\n');
      });

      return ok(`Workflows (${defs.length}):\n\n${lines.join('\n\n')}\n\nUse the workflow ID (e.g. "${defs[0]?.id}") to reference workflows in other tools.`);
    }

    if (name === 'workflow_get') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      const wf = findWorkflow(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found. Use workflow_list to see available workflows.`);

      const history = loadHistory();
      const runs = history
        .filter(r => r.workflowId === wf.id)
        .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
        .slice(0, 5);

      let output = `# ${wf.name}\n`;
      output += `ID: ${wf.id}\n`;
      output += `Enabled: ${wf.enabled !== false ? 'yes' : 'no'}\n`;
      output += `Trigger: ${formatTrigger(wf.trigger)}\n`;
      output += `Concurrency: ${wf.concurrency || 'skip'}\n`;
      if (wf.scope) output += `Scope: ${wf.scope}\n`;
      if (wf.projectPath) output += `Project: ${wf.projectPath}\n`;

      if (wf.dependsOn && wf.dependsOn.length) {
        output += `Dependencies: ${wf.dependsOn.map(d => `${d.workflow} (max_age: ${d.max_age || '—'})`).join(', ')}\n`;
      }

      // Display graph nodes (LiteGraph format)
      const graphNodes = (wf.graph && wf.graph.nodes) || [];
      const graphLinks = (wf.graph && wf.graph.links) || [];
      if (graphNodes.length) {
        output += `\n## Graph Nodes (${graphNodes.length})\n`;
        for (const node of graphNodes) {
          const ntype = (node.type || '').replace('workflow/', '');
          const title = node.properties?._customTitle ? ` "${node.properties._customTitle}"` : '';
          output += `  [${node.id}] ${ntype}${title}`;
          const props = Object.entries(node.properties || {})
            .filter(([k, v]) => !k.startsWith('_') && v !== '' && v !== null && v !== undefined)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
          if (props.length) output += ` — ${props.slice(0, 4).join(', ')}`;
          output += '\n';
        }
        output += `\n## Links (${graphLinks.length})\n`;
        for (const l of graphLinks) {
          const srcNode = graphNodes.find(n => n.id === l[1]);
          const dstNode = graphNodes.find(n => n.id === l[3]);
          const srcType = (srcNode?.type || '').replace('workflow/', '');
          const dstType = (dstNode?.type || '').replace('workflow/', '');
          const srcOut = srcNode?.outputs?.[l[2]]?.name || `slot${l[2]}`;
          const dstIn  = dstNode?.inputs?.[l[4]]?.name  || `slot${l[4]}`;
          output += `  ${srcType}[${l[1]}].${srcOut} → ${dstType}[${l[3]}].${dstIn}\n`;
        }

        // Show abstract variable definitions
        const abstractVars = wf.variables || [];
        if (abstractVars.length) {
          output += `\n## Variables (${abstractVars.length})\n`;
          for (const v of abstractVars) {
            output += `  ${v.name} (${v.varType || 'any'})\n`;
          }
        }
      } else {
        output += `\nNo graph nodes yet. Use workflow_add_node to start building.\n`;
      }

      if (runs.length) {
        output += `\n## Recent Runs\n`;
        for (const r of runs) {
          const date = r.startedAt ? new Date(r.startedAt).toLocaleString() : '?';
          output += `  ${formatStatus(r.status)} | ${date} | ${r.duration || '—'} | trigger: ${r.trigger || '?'}\n`;
        }
      }

      return ok(output);
    }

    if (name === 'workflow_trigger') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      const wf = findWorkflow(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found. Use workflow_list to see available workflows.`);

      // We can't directly call WorkflowService from the MCP process.
      // Instead, we write a trigger request file that the app picks up.
      const triggerDir = path.join(getDataDir(), 'workflows', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `${wf.id}_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        workflowId: wf.id,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok(`Trigger request sent for workflow "${wf.name}". The app will pick it up and execute it. Use workflow_runs to check results.`);
    }

    if (name === 'workflow_cancel') {
      if (!args.run_id) return fail('Missing required parameter: run_id');
      // Similar to trigger — write cancel request
      const triggerDir = path.join(getDataDir(), 'workflows', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const cancelFile = path.join(triggerDir, `cancel_${args.run_id}_${Date.now()}.json`);
      fs.writeFileSync(cancelFile, JSON.stringify({
        action: 'cancel',
        runId: args.run_id,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok(`Cancel request sent for run "${args.run_id}".`);
    }

    if (name === 'workflow_runs') {
      const limit = Math.min(args.limit || 10, 50);
      const history = loadHistory();

      let runs;
      if (args.workflow) {
        const wf = findWorkflow(args.workflow);
        if (!wf) return fail(`Workflow "${args.workflow}" not found.`);
        runs = history.filter(r => r.workflowId === wf.id);
      } else {
        runs = history;
      }

      runs = runs
        .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
        .slice(0, limit);

      if (!runs.length) return ok('No runs found.');

      const lines = runs.map(r => {
        const date = r.startedAt ? new Date(r.startedAt).toLocaleString() : '?';
        let line = `[${formatStatus(r.status)}] ${r.workflowName || r.workflowId} | ${date} | ${r.duration || '—'}`;
        if (r.trigger) line += ` | trigger: ${r.trigger}`;

        // Step summary
        if (r.steps && r.steps.length) {
          const stepSummary = r.steps.map(s => `${s.id}:${formatStatus(s.status)}`).join(', ');
          line += `\n  Steps: ${stepSummary}`;
        }

        // Error info
        if (r.status === 'failed' && r.steps) {
          const failedStep = r.steps.find(s => s.status === 'failed');
          if (failedStep && failedStep.output) {
            const errLine = String(failedStep.output).split('\n')[0].slice(0, 120);
            line += `\n  Error: ${errLine}`;
          }
        }

        return line;
      });

      const title = args.workflow ? `Runs for "${args.workflow}"` : 'Recent runs (all workflows)';
      return ok(`${title} (${runs.length}):\n\n${lines.join('\n\n')}`);
    }

    if (name === 'workflow_status') {
      const history = loadHistory();
      const active = history.filter(r => r.status === 'running' || r.status === 'pending' || r.status === 'queued');

      if (!active.length) return ok('No active workflow runs.');

      const lines = active.map(r => {
        const date = r.startedAt ? new Date(r.startedAt).toLocaleString() : '?';
        let line = `[${formatStatus(r.status)}] ${r.workflowName || r.workflowId} | started: ${date}`;

        if (r.steps && r.steps.length) {
          const current = r.steps.find(s => s.status === 'running');
          if (current) line += ` | current step: ${current.id} (${current.type})`;
          const done = r.steps.filter(s => s.status === 'success').length;
          line += ` | progress: ${done}/${r.steps.length}`;
        }

        return line;
      });

      return ok(`Active runs (${active.length}):\n\n${lines.join('\n')}`);
    }

    // ── workflow_run_logs ────────────────────────────────────────────────────

    if (name === 'workflow_run_logs') {
      if (!args.run_id) return fail('Missing required parameter: run_id');

      const run = loadRunFromHistory(args.run_id);
      const result = loadRunResult(args.run_id);

      if (!run && !result) return fail(`Run "${args.run_id}" not found. Use workflow_runs to get valid run IDs.`);

      const wfName = run?.workflowName || run?.workflowId || args.run_id;
      const date = run?.startedAt ? new Date(run.startedAt).toLocaleString() : '?';
      let out = `# Run logs: ${wfName}\n`;
      out += `ID: ${args.run_id}\n`;
      out += `Status: ${formatStatus(run?.status || '?')}\n`;
      out += `Date: ${date}\n`;
      out += `Duration: ${run?.duration || '—'}\n`;
      out += `Trigger: ${run?.trigger || '?'}\n\n`;

      // Steps from history (status + type per step)
      const steps = run?.steps || [];

      if (steps.length === 0 && !result) {
        return ok(out + '(No step data available for this run.)');
      }

      // Merge step metadata from history with detailed outputs from result file
      const outputs = result?.outputs || {};

      out += `## Steps (${steps.length})\n\n`;
      for (const step of steps) {
        const statusIcon = step.status === 'success' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'skipped' ? '–' : '…';
        const dur = step.duration ? ` (${formatDuration(step.duration)})` : '';
        out += `### [${statusIcon}] ${step.id} (${step.type || '?'})${dur}\n`;

        if (step.error) {
          out += `Error: ${step.error}\n`;
        }

        // Try to get detailed output from result file, fallback to history output
        const detailOutput = outputs[step.id] || step.output;
        if (detailOutput) {
          const formatted = formatStepOutputText(step.id, step.type, detailOutput, '  ');
          if (formatted) out += `${formatted}\n`;
        }

        out += '\n';
      }

      // If result has outputs not in steps (e.g. loop child nodes)
      const extraNodes = Object.keys(outputs).filter(nid => !steps.find(s => s.id === nid));
      if (extraNodes.length) {
        out += `## Additional node outputs (loop children, etc.)\n\n`;
        for (const nid of extraNodes) {
          const o = outputs[nid];
          const type = o?._type || '';
          out += `### ${nid} (${type})\n`;
          const formatted = formatStepOutputText(nid, type, o, '  ');
          if (formatted) out += `${formatted}\n`;
          out += '\n';
        }
      }

      return ok(out);
    }

    // ── workflow_diagnose ────────────────────────────────────────────────────

    if (name === 'workflow_diagnose') {
      if (!args.run_id) return fail('Missing required parameter: run_id');

      const run = loadRunFromHistory(args.run_id);
      const result = loadRunResult(args.run_id);

      if (!run && !result) return fail(`Run "${args.run_id}" not found. Use workflow_runs to get valid run IDs.`);

      const wfName = run?.workflowName || run?.workflowId || args.run_id;
      const outputs = result?.outputs || {};
      const steps = run?.steps || [];
      const overallStatus = run?.status || 'unknown';

      let out = `# Diagnosis: ${wfName} — ${formatStatus(overallStatus)}\n\n`;

      // ── Summary
      if (overallStatus === 'success') {
        const stepCount = steps.length;
        const loopSteps = steps.filter(s => s.type === 'loop');
        const loopInfo = loopSteps.map(ls => {
          const lo = outputs[ls.id] || ls.output;
          const n = lo?.items?.length ?? lo?.done ?? '?';
          return `${ls.id} ran ${n} iteration(s)`;
        }).join(', ');
        out += `✓ Run completed successfully in ${run?.duration || '—'} with ${stepCount} step(s).\n`;
        if (loopInfo) out += `Loops: ${loopInfo}\n`;
        out += '\n';
      } else if (overallStatus === 'failed') {
        const failedSteps = steps.filter(s => s.status === 'failed');
        out += `✗ Run FAILED after ${run?.duration || '—'}.\n`;
        out += `Failed steps: ${failedSteps.map(s => s.id).join(', ') || '(none identified)'}\n\n`;
      } else if (overallStatus === 'cancelled') {
        const lastRunning = [...steps].reverse().find(s => s.status === 'running' || s.status === 'success');
        out += `– Run was cancelled. Last active step: ${lastRunning?.id || '?'}\n\n`;
      }

      // ── Per-step analysis
      out += `## Step Analysis\n\n`;
      for (const step of steps) {
        const statusIcon = step.status === 'success' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'skipped' ? '–' : '…';
        out += `**[${statusIcon}] ${step.id}** (${step.type || '?'})\n`;

        const detail = outputs[step.id] || step.output;

        if (step.status === 'failed') {
          const errMsg = step.error
            || (step.type === 'shell' && (detail?.stderr || detail?.stdout))
            || (typeof detail === 'string' && detail)
            || '';
          if (errMsg) out += `  → Error: ${String(errMsg).trim().slice(0, 400)}\n`;

          // Suggest fix based on type
          if (step.type === 'shell') {
            const exitCode = detail?.exitCode;
            if (exitCode !== undefined && exitCode !== 0) {
              out += `  → Shell exited with code ${exitCode}. Check the command and working directory.\n`;
            }
          } else if (step.type === 'claude') {
            out += `  → Claude agent failed. Check the prompt, model availability, and CWD.\n`;
          } else if (step.type === 'http') {
            out += `  → HTTP request failed. Check URL, method, headers, and network access.\n`;
          } else if (step.type === 'condition') {
            out += `  → Condition evaluation failed. Check the expression syntax.\n`;
          }
        } else if (step.status === 'success' && step.type === 'loop') {
          const lo = outputs[step.id] || step.output;
          const items = lo?.items || [];
          const failed = items.filter(iter =>
            Object.values(iter).some(v => v?._status === 'failed')
          );
          if (failed.length) {
            out += `  → ${failed.length}/${items.length} iteration(s) had failures inside.\n`;
            for (const iter of failed.slice(0, 3)) {
              const label = iter._item?.name || iter._item?.path || JSON.stringify(iter._item).slice(0, 40);
              const failNodes = Object.entries(iter)
                .filter(([k, v]) => k !== '_item' && v?._status === 'failed')
                .map(([k, v]) => `${k}: ${(v?.stderr || v?.stdout || v?.error || '').slice(0, 100)}`);
              out += `     ${label}: ${failNodes.join('; ')}\n`;
            }
          } else {
            out += `  → All ${items.length} iteration(s) succeeded.\n`;
          }
        } else if (step.status === 'skipped') {
          out += `  → Step was skipped (condition was false or dependency failed).\n`;
        } else if (step.status === 'success') {
          // Brief success summary
          if (step.type === 'shell') {
            out += `  → exit 0`;
            if (detail?.stdout?.trim()) out += `, stdout: ${detail.stdout.trim().slice(0, 80)}`;
            out += '\n';
          } else if (step.type === 'condition') {
            out += `  → took ${detail?.result === true || detail?.result === 'true' ? 'TRUE' : 'FALSE'} branch\n`;
          }
        }
      }

      // ── Overall verdict
      out += `\n## Verdict\n`;
      if (overallStatus === 'success') {
        const hasLoopFailures = steps.some(s => {
          if (s.type !== 'loop') return false;
          const lo = outputs[s.id] || s.output;
          return (lo?.items || []).some(iter => Object.values(iter).some(v => v?._status === 'failed'));
        });
        if (hasLoopFailures) {
          out += `Run completed but some loop iterations had internal failures. Review the loop step details above.\n`;
        } else {
          out += `Run completed successfully. No issues detected.\n`;
        }
      } else if (overallStatus === 'failed') {
        const failedSteps = steps.filter(s => s.status === 'failed');
        if (failedSteps.length) {
          out += `Fix the error in step "${failedSteps[0].id}" (${failedSteps[0].type}) and re-run the workflow.\n`;
          out += `Use workflow_run_logs with run_id="${args.run_id}" for full output details.\n`;
        }
      } else if (overallStatus === 'cancelled') {
        out += `Run was manually cancelled. Re-trigger when ready.\n`;
      }

      return ok(out);
    }

    // ── workflow_get_variables ───────────────────────────────────────────────

    if (name === 'workflow_add_variable') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      if (!args.name) return fail('Missing required parameter: name');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found.`);

      const validTypes = ['string', 'number', 'boolean', 'array', 'object', 'any'];
      const varType = validTypes.includes(args.varType) ? args.varType : 'any';

      if (!wf.variables) wf.variables = [];
      const existing = wf.variables.find(v => v.name === args.name);
      if (existing) {
        existing.varType = varType;
        wf.updatedAt = new Date().toISOString();
        saveWorkflowDef(wf);
        signalReload();
        return ok(`Variable "${args.name}" updated to type "${varType}" in workflow "${wf.name}".`);
      }

      wf.variables.push({ name: args.name, varType });
      wf.updatedAt = new Date().toISOString();
      saveWorkflowDef(wf);
      signalReload();

      log(`Added variable "${args.name}" (${varType}) to workflow ${wf.id}`);
      return ok(`Variable "${args.name}" (${varType}) added to workflow "${wf.name}".\n\nYou can now reference it in workflow/variable nodes (set/get/increment/append) or workflow/get_variable nodes using name="${args.name}".`);
    }

    if (name === 'workflow_get_variables') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found.`);

      // Abstract variable definitions (stored in wf.variables[])
      const abstractVars = wf.variables || [];

      // Also scan graph nodes for variable usage
      const nodes = (wf.graph && wf.graph.nodes) || [];
      const nodeUsage = new Map(); // varName → [{action, nodeId}]
      for (const n of nodes) {
        if (n.type === 'workflow/variable' && n.properties?.name) {
          const vn = n.properties.name;
          if (!nodeUsage.has(vn)) nodeUsage.set(vn, []);
          nodeUsage.get(vn).push({ action: n.properties.action || 'set', nodeId: n.id });
        }
        if (n.type === 'workflow/get_variable' && n.properties?.name) {
          const vn = n.properties.name;
          if (!nodeUsage.has(vn)) nodeUsage.set(vn, []);
          nodeUsage.get(vn).push({ action: 'get (pure)', nodeId: n.id });
        }
      }

      if (!abstractVars.length && !nodeUsage.size) {
        return ok(`No variables in workflow "${wf.name}".\n\nVariables are defined in the Variables panel (not as nodes). When you click a variable in the panel, it creates a workflow/variable node on the canvas.`);
      }

      let out = `# Variables in "${wf.name}"\n\n`;

      if (abstractVars.length) {
        out += `## Defined Variables (${abstractVars.length})\n`;
        for (const v of abstractVars) {
          const usage = nodeUsage.get(v.name);
          out += `  ${v.name} (${v.varType || 'any'})`;
          if (usage) out += ` — used in nodes: ${usage.map(u => `[${u.nodeId}] ${u.action}`).join(', ')}`;
          out += '\n';
        }
        out += '\n';
      }

      // Check for node-only variables (not in abstract defs)
      const abstractNames = new Set(abstractVars.map(v => v.name));
      const orphanVars = [...nodeUsage.entries()].filter(([n]) => !abstractNames.has(n));
      if (orphanVars.length) {
        out += `## Node-only Variables (not in panel — ${orphanVars.length})\n`;
        for (const [varName, usages] of orphanVars) {
          out += `  ${varName} — nodes: ${usages.map(u => `[${u.nodeId}] ${u.action}`).join(', ')}\n`;
        }
        out += '\n';
      }

      out += `Tip: Variables are defined in the Variables panel. Click a variable to insert a workflow/variable node on the canvas. On the node, choose get/set/increment/append.`;
      return ok(out);
    }

    // ── workflow_get_graph ───────────────────────────────────────────────────

    if (name === 'workflow_get_graph') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found. Use workflow_list to see available workflows.`);

      const graph = wf.graph || { nodes: [], links: [] };
      const nodes = graph.nodes || [];
      const links = graph.links || [];

      if (!nodes.length) return ok(`Workflow "${wf.name}" has an empty graph. Use workflow_add_node to start building.`);

      const nodeLines = nodes.map(n => {
        const props = Object.entries(n.properties || {})
          .filter(([k]) => !k.startsWith('_'))
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ');
        const title = n.properties?._customTitle ? ` "${n.properties._customTitle}"` : '';
        return `  Node ${n.id}: ${n.type}${title} @ [${(n.pos || [0,0]).join(',')}]${props ? `\n    props: ${props}` : ''}`;
      });

      // link[link_id, origin_id, origin_slot, target_id, target_slot, type]
      const linkLines = links.map(l =>
        `  Link: node${l[1]} slot${l[2]} → node${l[3]} slot${l[4]}`
      );

      let out = `# Graph: ${wf.name} (${wf.id})\n\n`;
      out += `## Nodes (${nodes.length})\n${nodeLines.join('\n')}\n\n`;
      out += `## Links (${links.length})\n${linkLines.join('\n') || '  (none)'}`;
      return ok(out);
    }

    // ── workflow_create ──────────────────────────────────────────────────────

    if (name === 'workflow_create') {
      if (!args.name) return fail('Missing required parameter: name');

      const crypto = require('crypto');
      const id = `wf_${crypto.randomUUID().slice(0, 8)}`;

      // Build default trigger node
      const triggerType = args.trigger_type || 'manual';
      const triggerSlots = getNodeSlots('workflow/trigger');
      const triggerNode = {
        id: 1,
        type: 'workflow/trigger',
        pos: [100, 100],
        size: [180, 60],
        flags: {},
        order: 1,
        mode: 0,
        inputs: triggerSlots.inputs,
        outputs: triggerSlots.outputs,
        properties: {
          triggerType,
          triggerValue: args.trigger_value || '',
        },
      };

      const graph = args.graph || { nodes: [triggerNode], links: [], groups: [] };

      const workflow = {
        id,
        name: args.name,
        enabled: true,
        trigger: { type: triggerType, value: args.trigger_value || '' },
        graph,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      saveWorkflowDef(workflow);
      signalReload();
      log(`Created workflow "${args.name}" (${id})`);
      return ok(`Workflow "${args.name}" created successfully.\nID: ${id}\nTrigger: ${triggerType}\nNodes: ${graph.nodes.length} (trigger node added at ID 1)\n\nUse workflow_add_node with workflow="${id}" to add more nodes.`);
    }

    // ── workflow_rename ──────────────────────────────────────────────────────

    if (name === 'workflow_rename') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      if (!args.new_name) return fail('Missing required parameter: new_name');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow not found: "${args.workflow}"`);

      const oldName = wf.name;
      wf.name = args.new_name.trim();
      wf.updatedAt = new Date().toISOString();

      saveWorkflowDef(wf);
      signalReload();
      log(`Renamed workflow "${oldName}" → "${wf.name}" (${wf.id})`);
      return ok(`Workflow renamed from "${oldName}" to "${wf.name}" (ID: ${wf.id}).`);
    }

    // ── workflow_auto_layout ────────────────────────────────────────────────

    if (name === 'workflow_auto_layout') {
      if (!args.workflow) return fail('Missing required parameter: workflow');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found.`);
      if (!wf.graph?.nodes?.length) return fail('Workflow has no nodes to layout.');

      autoLayoutGraph(wf.graph);
      wf.updatedAt = new Date().toISOString();
      saveWorkflowDef(wf);
      signalReload();

      const nodeCount = wf.graph.nodes.length;
      log(`Auto-layout applied to "${wf.name}" (${nodeCount} nodes)`);
      return ok(`Auto-layout applied to "${wf.name}" (${nodeCount} nodes).\nNodes have been arranged left-to-right following execution flow.`);
    }

    // ── workflow_add_node ────────────────────────────────────────────────────

    if (name === 'workflow_add_node') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      if (!args.type) return fail('Missing required parameter: type');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found.`);

      const graph = wf.graph || { nodes: [], links: [], groups: [] };
      const nodeId = nextNodeId(graph);

      const slots = getNodeSlots(args.type);
      const node = {
        id: nodeId,
        type: args.type,
        pos: args.pos || [100, 100 + nodeId * 160],
        size: [200, 80],
        flags: {},
        order: nodeId,
        mode: 0,
        inputs: slots.inputs,
        outputs: slots.outputs,
        properties: args.properties || {},
      };
      if (args.title) node.properties._customTitle = args.title;

      graph.nodes = [...(graph.nodes || []), node];
      wf.graph = graph;
      wf.updatedAt = new Date().toISOString();
      saveWorkflowDef(wf);
      signalReload();

      log(`Added node ${nodeId} (${args.type}) to workflow ${wf.id}`);
      return ok(`Node added successfully.\nNode ID: ${nodeId}\nType: ${args.type}\n\nUse this ID (${nodeId}) when connecting nodes with workflow_connect_nodes.\nCall workflow_auto_layout after adding all nodes to arrange them cleanly.`);
    }

    // ── workflow_connect_nodes ───────────────────────────────────────────────

    if (name === 'workflow_connect_nodes') {
      const { workflow: wfArg, from_node, from_slot, to_node, to_slot } = args;
      if (!wfArg) return fail('Missing required parameter: workflow');
      if (from_node == null || from_slot == null || to_node == null || to_slot == null) {
        return fail('Missing required parameters: from_node, from_slot, to_node, to_slot');
      }

      const wf = loadWorkflowDef(wfArg);
      if (!wf) return fail(`Workflow "${wfArg}" not found.`);

      const graph = wf.graph || { nodes: [], links: [], groups: [] };
      const nodes = graph.nodes || [];

      if (!nodes.find(n => n.id === from_node)) return fail(`Node ${from_node} not found in graph.`);
      if (!nodes.find(n => n.id === to_node)) return fail(`Node ${to_node} not found in graph.`);

      // Check duplicate link
      const existing = (graph.links || []).find(l =>
        l[1] === from_node && l[2] === from_slot && l[3] === to_node && l[4] === to_slot
      );
      if (existing) return ok(`Link already exists between node ${from_node} slot ${from_slot} → node ${to_node} slot ${to_slot}.`);

      const linkId = nextLinkId(graph);
      // LiteGraph link format: [link_id, origin_id, origin_slot, target_id, target_slot, type]
      const link = [linkId, from_node, from_slot, to_node, to_slot, -1];
      graph.links = [...(graph.links || []), link];

      // Update outputs[from_slot].links on source node
      const srcNode = nodes.find(n => n.id === from_node);
      if (srcNode) {
        if (!srcNode.outputs) srcNode.outputs = getNodeSlots(srcNode.type).outputs;
        if (srcNode.outputs[from_slot]) {
          if (!srcNode.outputs[from_slot].links) srcNode.outputs[from_slot].links = [];
          if (!srcNode.outputs[from_slot].links.includes(linkId)) {
            srcNode.outputs[from_slot].links.push(linkId);
          }
        }
      }

      // Update inputs[to_slot].link on target node
      const dstNode = nodes.find(n => n.id === to_node);
      if (dstNode) {
        if (!dstNode.inputs) dstNode.inputs = getNodeSlots(dstNode.type).inputs;
        if (dstNode.inputs[to_slot]) {
          dstNode.inputs[to_slot].link = linkId;
        }
      }

      wf.graph = graph;
      wf.updatedAt = new Date().toISOString();
      saveWorkflowDef(wf);
      signalReload();

      log(`Connected node ${from_node}:${from_slot} → node ${to_node}:${to_slot} in workflow ${wf.id}`);
      return ok(`Connection created: node ${from_node} (slot ${from_slot}) → node ${to_node} (slot ${to_slot})`);
    }

    // ── workflow_update_node ─────────────────────────────────────────────────

    if (name === 'workflow_update_node') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      if (args.node_id == null) return fail('Missing required parameter: node_id');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found.`);

      const graph = wf.graph || { nodes: [], links: [] };
      const nodeIdx = (graph.nodes || []).findIndex(n => n.id === args.node_id);
      if (nodeIdx < 0) return fail(`Node ${args.node_id} not found in graph.`);

      const node = graph.nodes[nodeIdx];
      if (args.properties) {
        node.properties = { ...node.properties, ...args.properties };
      }
      if (args.title !== undefined) {
        node.properties._customTitle = args.title;
      }
      graph.nodes[nodeIdx] = node;

      wf.graph = graph;
      wf.updatedAt = new Date().toISOString();
      saveWorkflowDef(wf);
      signalReload();

      log(`Updated node ${args.node_id} in workflow ${wf.id}`);
      return ok(`Node ${args.node_id} updated successfully.`);
    }

    // ── workflow_delete_node ─────────────────────────────────────────────────

    if (name === 'workflow_delete_node') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      if (args.node_id == null) return fail('Missing required parameter: node_id');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found.`);

      const graph = wf.graph || { nodes: [], links: [] };
      const beforeCount = (graph.nodes || []).length;
      graph.nodes = (graph.nodes || []).filter(n => n.id !== args.node_id);
      if (graph.nodes.length === beforeCount) return fail(`Node ${args.node_id} not found in graph.`);

      // Remove all links connected to this node and clean up slot references
      const removedLinkIds = new Set(
        (graph.links || []).filter(l => l[1] === args.node_id || l[3] === args.node_id).map(l => l[0])
      );
      const removedLinks = removedLinkIds.size;
      graph.links = (graph.links || []).filter(l => l[1] !== args.node_id && l[3] !== args.node_id);

      // Clean orphaned link references from remaining nodes' slots
      for (const n of graph.nodes || []) {
        if (n.outputs) {
          for (const out of n.outputs) {
            if (out.links) out.links = out.links.filter(lid => !removedLinkIds.has(lid));
          }
        }
        if (n.inputs) {
          for (const inp of n.inputs) {
            if (removedLinkIds.has(inp.link)) inp.link = null;
          }
        }
      }

      wf.graph = graph;
      wf.updatedAt = new Date().toISOString();
      saveWorkflowDef(wf);
      signalReload();

      log(`Deleted node ${args.node_id} (+ ${removedLinks} links) from workflow ${wf.id}`);
      return ok(`Node ${args.node_id} deleted (${removedLinks} link(s) also removed).`);
    }

    // ── workflow_clone ──────────────────────────────────────────────────────

    if (name === 'workflow_clone') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      if (!args.name) return fail('Missing required parameter: name');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found. Use workflow_list to see available workflows.`);

      const crypto = require('crypto');
      const newId = `wf-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

      // Deep copy the workflow definition
      const cloned = JSON.parse(JSON.stringify(wf));
      cloned.id = newId;
      cloned.name = args.name.trim();
      cloned.createdAt = new Date().toISOString();
      cloned.updatedAt = new Date().toISOString();

      saveWorkflowDef(cloned);
      signalReload();

      log(`Cloned workflow "${wf.name}" → "${cloned.name}" (${newId})`);
      return ok(`Workflow cloned successfully.\nSource: "${wf.name}" (${wf.id})\nClone: "${cloned.name}" (${newId})\nNodes: ${cloned.graph?.nodes?.length || 0}`);
    }

    // ── workflow_export ──────────────────────────────────────────────────────

    if (name === 'workflow_export') {
      if (!args.workflow) return fail('Missing required parameter: workflow');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found. Use workflow_list to see available workflows.`);

      // Strip internal/runtime metadata, keep only the definition
      const exportData = {
        name: wf.name,
        enabled: wf.enabled,
        trigger: wf.trigger,
        graph: wf.graph,
        variables: wf.variables,
        concurrency: wf.concurrency,
        scope: wf.scope,
        dependsOn: wf.dependsOn,
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt,
      };

      // Remove undefined keys
      for (const key of Object.keys(exportData)) {
        if (exportData[key] === undefined) delete exportData[key];
      }

      const json = JSON.stringify(exportData, null, 2);
      log(`Exported workflow "${wf.name}" (${wf.id})`);
      return ok(json);
    }

    // ── workflow_import ──────────────────────────────────────────────────────

    if (name === 'workflow_import') {
      if (!args.json) return fail('Missing required parameter: json');

      let parsed;
      try {
        parsed = JSON.parse(args.json);
      } catch (e) {
        return fail(`Invalid JSON: ${e.message}`);
      }

      // Validate required fields
      if (!parsed.name && !args.name) {
        return fail('Imported workflow must have a "name" field, or provide a name override.');
      }
      if (!parsed.graph && !parsed.nodes) {
        return fail('Imported workflow must have a "graph" field (with nodes and links).');
      }

      const crypto = require('crypto');
      const newId = `wf-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

      // If the JSON has a flat nodes/links structure, wrap it into graph
      const graph = parsed.graph || { nodes: parsed.nodes || [], links: parsed.links || [] };

      const workflow = {
        id: newId,
        name: (args.name || parsed.name).trim(),
        enabled: parsed.enabled !== undefined ? parsed.enabled : true,
        trigger: parsed.trigger || { type: 'manual', value: '' },
        graph,
        variables: parsed.variables,
        concurrency: parsed.concurrency,
        scope: parsed.scope,
        dependsOn: parsed.dependsOn,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Remove undefined keys
      for (const key of Object.keys(workflow)) {
        if (workflow[key] === undefined) delete workflow[key];
      }

      saveWorkflowDef(workflow);
      signalReload();

      log(`Imported workflow "${workflow.name}" (${newId})`);
      return ok(`Workflow imported successfully.\nName: "${workflow.name}"\nID: ${newId}\nNodes: ${graph.nodes?.length || 0}\nLinks: ${graph.links?.length || 0}`);
    }

    // ── workflow_delete ──────────────────────────────────────────────────────

    if (name === 'workflow_delete') {
      if (!args.workflow) return fail('Missing required parameter: workflow');

      const wf = findWorkflow(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found. Use workflow_list to see available workflows.`);

      // Remove from definitions
      const file = path.join(getDataDir(), 'workflows', 'definitions.json');
      let defs = [];
      try {
        if (fs.existsSync(file)) defs = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (_) {}

      defs = defs.filter(entry => {
        const w = entry.workflow || entry;
        return w.id !== wf.id;
      });

      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(defs, null, 2), 'utf8');
      fs.renameSync(tmp, file);

      // Delete run result files for this workflow
      const history = loadHistory();
      const runIds = history.filter(r => r.workflowId === wf.id).map(r => r.id);
      const resultsDir = path.join(getDataDir(), 'workflows', 'results');
      for (const runId of runIds) {
        const resultFile = path.join(resultsDir, `${runId}.json`);
        try {
          if (fs.existsSync(resultFile)) fs.unlinkSync(resultFile);
        } catch (_) {}
      }

      // Remove runs from history
      if (runIds.length) {
        const historyFile = path.join(getDataDir(), 'workflows', 'history.json');
        try {
          const allHistory = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
          const filtered = allHistory.filter(r => r.workflowId !== wf.id);
          const htmp = historyFile + '.tmp';
          fs.writeFileSync(htmp, JSON.stringify(filtered, null, 2), 'utf8');
          fs.renameSync(htmp, historyFile);
        } catch (_) {}
      }

      signalReload();

      log(`Deleted workflow "${wf.name}" (${wf.id}) and ${runIds.length} run result(s)`);
      return ok(`Workflow "${wf.name}" (${wf.id}) deleted permanently.\nRemoved ${runIds.length} run result(s).`);
    }

    // ── workflow_enable ──────────────────────────────────────────────────────

    if (name === 'workflow_enable') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      if (args.enabled === undefined) return fail('Missing required parameter: enabled');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found. Use workflow_list to see available workflows.`);

      wf.enabled = !!args.enabled;
      wf.updatedAt = new Date().toISOString();
      saveWorkflowDef(wf);
      signalReload();

      const state = wf.enabled ? 'enabled' : 'disabled';
      log(`Workflow "${wf.name}" (${wf.id}) ${state}`);
      return ok(`Workflow "${wf.name}" is now ${state}.`);
    }

    // ── workflow_test_node ───────────────────────────────────────────────────

    if (name === 'workflow_test_node') {
      if (!args.workflow) return fail('Missing required parameter: workflow');
      if (args.node_id == null) return fail('Missing required parameter: node_id');

      const wf = loadWorkflowDef(args.workflow);
      if (!wf) return fail(`Workflow "${args.workflow}" not found. Use workflow_list to see available workflows.`);

      const graph = wf.graph || { nodes: [] };
      const node = (graph.nodes || []).find(n => n.id === args.node_id);
      if (!node) return fail(`Node ${args.node_id} not found in workflow "${wf.name}".`);

      const triggerDir = path.join(getDataDir(), 'workflows', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `test_node_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        action: 'test_node',
        workflowId: wf.id,
        nodeId: args.node_id,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      log(`Test trigger written for node ${args.node_id} (${node.type}) in workflow ${wf.id}`);
      return ok(`Test trigger created for node ${args.node_id} (${node.type}) in workflow "${wf.name}".\nClaude Terminal will execute this node in isolation.`);
    }

    return fail(`Unknown workflow tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Workflow error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {
  // Nothing to clean up — we only read files
}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
