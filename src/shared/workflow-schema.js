/**
 * workflow-schema.js
 * Single source of truth for workflow node types, pins, colors, and slot mappings.
 * Consumed by: GraphService (renderer), WorkflowRunner (main), MCP tools, WorkflowPanel.
 */

'use strict';

// ── Node accent colors ──────────────────────────────────────────────────────
const NODE_COLORS = {
  trigger:      { bg: '#101012', border: '#1c1c20', accent: '#4ade80', accentDim: 'rgba(74,222,128,.06)' },
  claude:       { bg: '#101012', border: '#1c1c20', accent: '#f59e0b', accentDim: 'rgba(245,158,11,.06)' },
  shell:        { bg: '#101012', border: '#1c1c20', accent: '#60a5fa', accentDim: 'rgba(96,165,250,.06)' },
  git:          { bg: '#101012', border: '#1c1c20', accent: '#a78bfa', accentDim: 'rgba(167,139,250,.06)' },
  http:         { bg: '#101012', border: '#1c1c20', accent: '#22d3ee', accentDim: 'rgba(34,211,238,.06)' },
  notify:       { bg: '#101012', border: '#1c1c20', accent: '#fbbf24', accentDim: 'rgba(251,191,36,.06)' },
  wait:         { bg: '#101012', border: '#1c1c20', accent: '#6b7280', accentDim: 'rgba(107,114,128,.06)' },
  condition:    { bg: '#101012', border: '#1c1c20', accent: '#4ade80', accentDim: 'rgba(74,222,128,.06)' },
  project:      { bg: '#101012', border: '#1c1c20', accent: '#f472b6', accentDim: 'rgba(244,114,182,.06)' },
  file:         { bg: '#101012', border: '#1c1c20', accent: '#a3e635', accentDim: 'rgba(163,230,53,.06)' },
  db:           { bg: '#101012', border: '#1c1c20', accent: '#fb923c', accentDim: 'rgba(251,146,60,.06)' },
  loop:         { bg: '#101012', border: '#1c1c20', accent: '#38bdf8', accentDim: 'rgba(56,189,248,.06)' },
  variable:     { bg: '#101012', border: '#1c1c20', accent: '#c084fc', accentDim: 'rgba(192,132,252,.06)' },
  get_variable: { bg: '#101012', border: '#1c1c20', accent: '#c084fc', accentDim: 'rgba(192,132,252,.06)' },
  log:          { bg: '#101012', border: '#1c1c20', accent: '#94a3b8', accentDim: 'rgba(148,163,184,.06)' },
  transform:    { bg: '#101012', border: '#1c1c20', accent: '#2dd4bf', accentDim: 'rgba(45,212,191,.06)' },
  subworkflow:  { bg: '#101012', border: '#1c1c20', accent: '#818cf8', accentDim: 'rgba(129,140,248,.06)' },
  switch:       { bg: '#101012', border: '#1c1c20', accent: '#f87171', accentDim: 'rgba(248,113,113,.06)' },
  time:         { bg: '#101012', border: '#1c1c20', accent: '#34d399', accentDim: 'rgba(52,211,153,.06)' },
};

// ── Pin type system ──────────────────────────────────────────────────────────
const PIN_TYPES = {
  exec:    { color: '#707070' },
  string:  { color: '#c8c8c8' },
  number:  { color: '#60a5fa' },
  boolean: { color: '#4ade80' },
  array:   { color: '#fb923c' },
  object:  { color: '#a78bfa' },
  any:     { color: '#6b7280' },
};

// Connection compatibility: exec↔exec only, data types can widen to 'any'
const TYPE_COMPAT = {
  exec:    new Set(['exec']),
  string:  new Set(['string', 'any']),
  number:  new Set(['number', 'any', 'boolean']),
  boolean: new Set(['boolean', 'any', 'number']),
  array:   new Set(['array', 'any']),
  object:  new Set(['object', 'any']),
  any:     new Set(['any', 'string', 'number', 'boolean', 'array', 'object']),
};

// ── Data output descriptors ──────────────────────────────────────────────────
// node type → ordered list of { name, type, key }
// 'key' = property name in runtime output object
const NODE_DATA_OUTPUTS = {
  trigger:      [{ name: 'payload',  type: 'object',  key: 'payload' },
                 { name: 'source',   type: 'string',  key: 'source' }],
  claude:       [{ name: 'output',   type: 'string',  key: 'output' }],
  shell:        [{ name: 'stdout',   type: 'string',  key: 'stdout' },
                 { name: 'stderr',   type: 'string',  key: 'stderr' },
                 { name: 'exitCode', type: 'number',  key: 'exitCode' }],
  git:          [{ name: 'output',   type: 'string',  key: 'output' }],
  http:         [{ name: 'body',     type: 'object',  key: 'body' },
                 { name: 'status',   type: 'number',  key: 'status' },
                 { name: 'ok',       type: 'boolean', key: 'ok' }],
  db:           [{ name: 'rows',     type: 'array',   key: 'rows' },
                 { name: 'rowCount', type: 'number',  key: 'rowCount' },
                 { name: 'firstRow', type: 'object',  key: 'firstRow' }],
  file:         [{ name: 'content',  type: 'string',  key: 'content' },
                 { name: 'exists',   type: 'boolean', key: 'exists' },
                 { name: 'files',    type: 'array',   key: 'files' },
                 { name: 'count',    type: 'number',  key: 'count' }],
  variable:     [{ name: 'value',    type: 'any',     key: 'value' }],
  get_variable: [{ name: 'value',    type: 'any',     key: 'value' }],
  condition:    [{ name: 'result',   type: 'boolean', key: 'result' }],
  switch:       [{ name: 'value',    type: 'string',  key: 'value' }],
  transform:    [{ name: 'result',   type: 'any',     key: 'result' }],
  subworkflow:  [{ name: 'outputs',  type: 'object',  key: 'outputs' }],
  loop:         [{ name: 'item',     type: 'any',     key: 'item' },
                 { name: 'index',    type: 'number',  key: 'index' }],
  project:      [{ name: 'projects', type: 'array',   key: 'projects' }],
  time:         [{ name: 'today',    type: 'number',  key: 'today' },
                 { name: 'week',     type: 'number',  key: 'week' },
                 { name: 'month',    type: 'number',  key: 'month' },
                 { name: 'projects', type: 'array',   key: 'projects' }],
  parallel_spawn:     [{ name: 'runId',       type: 'string',  key: 'runId' }],
  session_recap:      [{ name: 'summary',     type: 'string',  key: 'summary' },
                       { name: 'source',      type: 'string',  key: 'source' },
                       { name: 'toolCount',   type: 'number',  key: 'toolCount' },
                       { name: 'durationMs',  type: 'number',  key: 'durationMs' },
                       { name: 'prompts',     type: 'array',   key: 'prompts' }],
  kanban_create_card: [{ name: 'taskId',      type: 'string',  key: 'taskId' },
                       { name: 'columnId',    type: 'string',  key: 'columnId' },
                       { name: 'projectId',   type: 'string',  key: 'projectId' },
                       { name: 'projectName', type: 'string',  key: 'projectName' },
                       { name: 'title',       type: 'string',  key: 'title' }],
  workspace_write_doc:[{ name: 'docId',       type: 'string',  key: 'docId' },
                       { name: 'filename',    type: 'string',  key: 'filename' },
                       { name: 'workspaceId', type: 'string',  key: 'workspaceId' },
                       { name: 'title',       type: 'string',  key: 'title' }],
  notify_discord:     [{ name: 'status',      type: 'number',  key: 'status' },
                       { name: 'ok',          type: 'boolean', key: 'ok' }],
  webhook:            [{ name: 'statusCode',  type: 'number',  key: 'statusCode' },
                       { name: 'body',        type: 'string',  key: 'body' },
                       { name: 'truncated',   type: 'boolean', key: 'truncated' }],
  error_handler:      [{ name: 'error',       type: 'string',  key: 'error' },
                       { name: 'caught',      type: 'boolean', key: 'caught' }],
  retry:              [{ name: 'attempts',    type: 'number',  key: 'attempts' },
                       { name: 'error',       type: 'string',  key: 'error' }],
};

// node type → slot index of first data output (after exec slots)
const NODE_DATA_OUT_OFFSET = {
  trigger: 1, claude: 2, shell: 2, git: 2, http: 2, db: 2, file: 2,
  notify: 1, wait: 1, log: 1, condition: 2, loop: 2, project: 2,
  variable: 1, transform: 2, subworkflow: 2,
  // NOTE: 'switch' has a dynamic number of exec outputs (one per case + default),
  // so its data-output slot index cannot be a fixed offset. It is intentionally
  // omitted here; getOutputKeyForSlot() returns null for switch (no data mapping).
  get_variable: 0, time: 2,
  // All of the following have exactly two exec outputs (Done/Error or TRY/CATCH,
  // TRY/FAIL) before their data slots, so the data-output offset is 2.
  parallel_spawn: 2, session_recap: 2, kanban_create_card: 2,
  workspace_write_doc: 2, notify_discord: 2, webhook: 2,
  error_handler: 2, retry: 2,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNodeColors(node) {
  const type = (node.type || '').replace('workflow/', '');
  return NODE_COLORS[type] || NODE_COLORS.wait;
}

function getOutputKeyForSlot(nodeType, slotIndex) {
  // Types with a dynamic exec-slot count (e.g. switch) have no fixed data offset;
  // don't guess a mapping — return null so callers fall back to the whole output.
  const offset  = NODE_DATA_OUT_OFFSET[nodeType];
  if (offset == null) return null;
  const dataIdx = slotIndex - offset;
  const outputs = NODE_DATA_OUTPUTS[nodeType];
  if (!outputs || dataIdx < 0 || dataIdx >= outputs.length) return null;
  return outputs[dataIdx].key;
}

function isValidConnection(outType, inType) {
  if (outType === inType) return true;
  const compat = TYPE_COMPAT[outType];
  return compat ? compat.has(inType) : false;
}

// ── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  NODE_COLORS,
  PIN_TYPES,
  TYPE_COMPAT,
  NODE_DATA_OUTPUTS,
  NODE_DATA_OUT_OFFSET,
  getNodeColors,
  getOutputKeyForSlot,
  isValidConnection,
};
