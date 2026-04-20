/**
 * WorkflowGraphEngine — Custom canvas-based graph editor
 * Replaces LiteGraph.js with a zero-dependency Blueprint-style node editor.
 *
 * Architecture:
 *   GraphModel       — nodes, links, typed pins, serialize/configure
 *   GraphRenderer    — Blueprint-style tinted headers, pins, widgets, links
 *   GraphInteraction — pan, zoom, drag nodes, drag links, selection, hit testing
 */

'use strict';

const {
  NODE_COLORS, PIN_TYPES, TYPE_COMPAT,
  NODE_DATA_OUTPUTS, NODE_DATA_OUT_OFFSET,
  getNodeColors, isValidConnection,
} = require('../../shared/workflow-schema');
const nodeRegistry = require('./NodeRegistry');
const { t } = require('../i18n');

// ── Constants ────────────────────────────────────────────────────────────────

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO = '"Cascadia Code", "Fira Code", monospace';
const TITLE_H = 30;
const SLOT_H = 22;
const WIDGET_H = 24;
const PIN_R = 4.5;
const DIAMOND_R = 5;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const GRID_SIZE = 20;
const MAX_HISTORY = 50;

const STATUS_COLORS = {
  running: '#f59e0b', success: '#22c55e',
  failed: '#ef4444',  skipped: '#6b7280',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const _hexRgbaCache = new Map();
function hexToRgba(hex, a) {
  const key = hex + a;
  if (_hexRgbaCache.has(key)) return _hexRgbaCache.get(key);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const result = `rgba(${r},${g},${b},${a})`;
  _hexRgbaCache.set(key, result);
  return result;
}

// Module-level constant — avoids re-creating a Set on every _drawNode call
const UNTESTABLE_NODE_TYPES = new Set(['trigger', 'loop', 'condition', 'switch', 'subworkflow', 'wait', 'get_variable']);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawDiamond(ctx, cx, cy, size) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - size);
  ctx.lineTo(cx + size, cy);
  ctx.lineTo(cx, cy + size);
  ctx.lineTo(cx - size, cy);
  ctx.closePath();
}

function drawBadge(ctx, text, x, y, color) {
  ctx.font = `700 8px ${FONT}`;
  const tw = ctx.measureText(text).width;
  const bx = x - tw - 10;
  roundRect(ctx, bx, y, tw + 10, 14, 3);
  ctx.fillStyle = hexToRgba(color, 0.12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.textAlign = 'center';
  ctx.fillText(text, bx + (tw + 10) / 2, y + 10.5);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
}

function computeNodeHeight(node) {
  const inputSlots = node.inputs ? node.inputs.length : 0;
  const outputSlots = node.outputs ? node.outputs.length : 0;
  const slots = Math.max(inputSlots, outputSlots);
  const widgetH = (node.widgets ? node.widgets.length : 0) * (WIDGET_H + 4);
  return Math.max(slots * SLOT_H + widgetH + 10, 50);
}

// ═══════════════════════════════════════════════════════════════════════════════
// NODE TYPE DEFINITIONS (declarative registry)
// ═══════════════════════════════════════════════════════════════════════════════

function addDataOutputDefs(defs, nodeType) {
  const dataOuts = NODE_DATA_OUTPUTS[nodeType] || [];
  for (const d of dataOuts) defs.push({ name: d.name, type: d.type });
  return defs;
}

const NODE_TYPES = {
  'workflow/trigger': {
    title: 'Trigger', desc: t('workflow.nodeDesc.trigger'),
    inputs: [],
    outputs: addDataOutputDefs([{ name: 'Start', type: 'exec' }], 'trigger'),
    props: { triggerType: 'manual', triggerValue: '', hookType: 'PostToolUse' },
    widgets: [],
    width: 200, removable: false,
    badge: (n) => (n.properties.triggerType || 'manual').toUpperCase(),
  },
  'workflow/claude': {
    title: 'Claude', desc: t('workflow.nodeDesc.claude'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: addDataOutputDefs([{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], 'claude'),
    props: { mode: 'prompt', prompt: '', agentId: '', skillId: '', model: 'sonnet', effort: 'medium', outputSchema: null },
    widgets: [
      { type: 'combo', name: 'Mode', key: 'mode', values: ['prompt', 'agent', 'skill'] },
      { type: 'text', name: 'Prompt', key: 'prompt' },
      { type: 'combo', name: 'Model', key: 'model', values: ['sonnet', 'haiku', 'opus', 'claude-opus-4-6'] },
      { type: 'combo', name: 'Effort', key: 'effort', values: ['low', 'medium', 'high', 'max'] },
    ],
    width: 220,
    badge: (n) => ({ prompt: 'PROMPT', agent: 'AGENT', skill: 'SKILL' }[n.properties.mode] || 'PROMPT'),
  },
  'workflow/shell': {
    title: 'Shell', desc: t('workflow.nodeDesc.shell'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: addDataOutputDefs([{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], 'shell'),
    props: { command: '' },
    widgets: [{ type: 'text', name: 'Command', key: 'command' }],
    width: 220,
    drawExtra: (ctx, n) => {
      if (n.properties.command) {
        ctx.fillStyle = '#444';
        ctx.font = `10px ${MONO}`;
        const cmd = n.properties.command.length > 28 ? n.properties.command.slice(0, 28) + '...' : n.properties.command;
        ctx.textAlign = 'left';
        ctx.fillText('$ ' + cmd, 10, n.size[1] - 6);
      }
    },
  },
  'workflow/git': {
    title: 'Git', desc: t('workflow.nodeDesc.git'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: addDataOutputDefs([{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], 'git'),
    props: { action: 'pull', branch: '', message: '' },
    widgets: [{ type: 'combo', name: 'Action', key: 'action', values: ['pull', 'push', 'commit', 'checkout', 'merge', 'stash', 'stash-pop', 'reset'] }],
    width: 200,
    badge: (n) => (n.properties.action || 'pull').toUpperCase(),
  },
  'workflow/http': {
    title: 'HTTP', desc: t('workflow.nodeDesc.http'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: addDataOutputDefs([{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], 'http'),
    props: { method: 'GET', url: '', headers: '', body: '' },
    widgets: [
      { type: 'combo', name: 'Method', key: 'method', values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { type: 'text', name: 'URL', key: 'url' },
      { type: 'text', name: 'Headers', key: 'headers' },
      { type: 'text', name: 'Body', key: 'body' },
    ],
    width: 220,
    badge: (n) => n.properties.method || 'GET',
    badgeColor: (n) => ({ GET: '#22c55e', POST: '#3b82f6', PUT: '#f59e0b', PATCH: '#a78bfa', DELETE: '#ef4444' }[n.properties.method] || '#22d3ee'),
  },
  'workflow/notify': {
    title: 'Notify', desc: t('workflow.nodeDesc.notify'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: [{ name: 'Done', type: 'exec' }],
    props: { title: '', message: '' },
    widgets: [{ type: 'text', name: 'Title', key: 'title' }, { type: 'text', name: 'Message', key: 'message' }],
    width: 200,
  },
  'workflow/wait': {
    title: 'Wait', desc: t('workflow.nodeDesc.wait'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: [{ name: 'Done', type: 'exec' }],
    props: { mode: 'duration', duration: '5s', timeout: '' },
    widgets: [
      { type: 'combo', name: 'Mode', key: 'mode', values: ['duration', 'approval'] },
      { type: 'text', name: 'Duration', key: 'duration' },
      { type: 'text', name: 'Timeout', key: 'timeout' },
    ],
    width: 200,
    badge: (n) => n.properties.mode === 'approval' ? 'APPROVAL' : (n.properties.duration || '5s').toUpperCase(),
  },
  'workflow/condition': {
    title: 'Condition', desc: t('workflow.nodeDesc.condition'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: [{ name: 'TRUE', type: 'exec' }, { name: 'FALSE', type: 'exec' }],
    props: { conditionMode: 'builder', variable: '', operator: '==', value: '', expression: '' },
    widgets: [
      { type: 'combo', name: 'Mode', key: 'conditionMode', values: ['builder', 'expression'] },
      { type: 'text', name: 'Variable', key: 'variable' },
      { type: 'combo', name: 'Operator', key: 'operator', values: ['==', '!=', '>', '<', '>=', '<=', 'contains', 'starts_with', 'matches', 'is_empty', 'is_not_empty'] },
      { type: 'text', name: 'Value', key: 'value' },
      { type: 'text', name: 'Expression', key: 'expression' },
    ],
    width: 220,
    drawExtra: (ctx, n) => {
      const slotH = SLOT_H;
      ctx.font = `700 8px ${FONT}`;
      ctx.fillStyle = 'rgba(74,222,128,.12)';
      roundRect(ctx, n.size[0] - 38, slotH * 0 + 2, 26, 13, 3);
      ctx.fill();
      ctx.fillStyle = '#4ade80'; ctx.textAlign = 'center';
      ctx.fillText('TRUE', n.size[0] - 25, slotH * 0 + 12);
      ctx.fillStyle = 'rgba(239,68,68,.12)';
      roundRect(ctx, n.size[0] - 43, slotH * 1 + 2, 31, 13, 3);
      ctx.fill();
      ctx.fillStyle = '#ef4444'; ctx.textAlign = 'center';
      ctx.fillText('FALSE', n.size[0] - 27, slotH * 1 + 12);
    },
  },
  'workflow/project': {
    title: 'Project', desc: t('workflow.nodeDesc.project'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: [{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }, { name: 'Projects', type: 'array' }],
    props: { projectId: '', projectName: '', action: 'set_context' },
    widgets: [
      { type: 'combo', name: 'Action', key: 'action', values: ['list', 'set_context', 'open', 'build', 'install', 'test'] },
      { type: 'text', name: 'Project', key: 'projectName' },
    ],
    width: 220,
    badge: (n) => (n.properties.action || 'set_context').toUpperCase().replace('_', ' '),
  },
  'workflow/file': {
    title: 'File', desc: t('workflow.nodeDesc.file'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: addDataOutputDefs([{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], 'file'),
    props: { action: 'read', path: '', destination: '', content: '', pattern: '*', recursive: false },
    widgets: [
      { type: 'combo', name: 'Action', key: 'action', values: ['read', 'write', 'append', 'copy', 'delete', 'exists', 'move', 'list'] },
      { type: 'text', name: 'Path', key: 'path' },
    ],
    width: 220,
    badge: (n) => (n.properties.action || 'read').toUpperCase(),
  },
  'workflow/db': {
    title: 'Database', desc: t('workflow.nodeDesc.db'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: addDataOutputDefs([{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], 'db'),
    props: { connection: '', query: '', action: 'query' },
    widgets: [
      { type: 'combo', name: 'Action', key: 'action', values: ['query', 'schema', 'tables'] },
      { type: 'text', name: 'Query', key: 'query' },
    ],
    width: 220,
    badge: (n) => (n.properties.action || 'query').toUpperCase(),
  },
  'workflow/loop': {
    title: 'Loop', desc: t('workflow.nodeDesc.loop'),
    inputs: [{ name: 'In', type: 'exec' }, { name: 'items', type: 'array' }],
    outputs: addDataOutputDefs([{ name: 'Each', type: 'exec' }, { name: 'Done', type: 'exec' }], 'loop'),
    props: { source: 'auto', items: '', mode: 'sequential', maxIterations: '', _itemSchema: [] },
    widgets: [
      { type: 'combo', name: 'Source', key: 'source', values: ['auto', 'projects', 'files', 'custom'] },
      { type: 'text', name: 'Items', key: 'items' },
      { type: 'combo', name: 'Mode', key: 'mode', values: ['sequential', 'parallel'] },
      { type: 'text', name: 'Max items', key: 'maxIterations' },
    ],
    width: 210,
    badge: (n) => n.properties.mode === 'parallel' ? 'PARALLEL' : (n.properties.source || 'auto').toUpperCase(),
    badgeColor: (n) => n.properties.mode === 'parallel' ? '#f59e0b' : null,
  },
  'workflow/variable': {
    title: 'Set Variable', desc: t('workflow.nodeDesc.variable'),
    inputs: [{ name: 'In', type: 'exec' }, { name: 'value', type: 'any' }],
    outputs: [{ name: 'Done', type: 'exec' }, { name: 'value', type: 'any' }],
    props: { action: 'set', name: '', value: '' },
    widgets: [
      { type: 'combo', name: 'Action', key: 'action', values: ['set', 'get', 'increment', 'append'] },
      { type: 'text', name: 'Name', key: 'name' },
    ],
    width: 200,
    dynamic: 'variable',
    badge: (n) => (n.properties.action || 'set').toUpperCase(),
    getTitle: (n) => {
      const a = n.properties.action || 'set';
      const nm = n.properties.name;
      if (a === 'get') return nm ? `Get ${nm}` : 'Get Variable';
      if (a === 'set') return nm ? `Set ${nm}` : 'Set Variable';
      if (a === 'increment') return nm ? `++ ${nm}` : 'Increment';
      if (a === 'append') return nm ? `Append ${nm}` : 'Append';
      return 'Variable';
    },
    drawExtra: (ctx, n) => {
      if (n.properties.name) {
        ctx.fillStyle = '#555';
        ctx.font = `10px ${MONO}`;
        ctx.textAlign = 'left';
        ctx.fillText('$' + n.properties.name, 10, n.size[1] - 6);
      }
    },
  },
  'workflow/log': {
    title: 'Log', desc: t('workflow.nodeDesc.log'),
    inputs: [{ name: 'In', type: 'exec' }, { name: 'message', type: 'string' }],
    outputs: [{ name: 'Done', type: 'exec' }],
    props: { level: 'info', message: '' },
    widgets: [
      { type: 'combo', name: 'Level', key: 'level', values: ['debug', 'info', 'warn', 'error'] },
      { type: 'text', name: 'Message', key: 'message' },
    ],
    width: 200,
    badge: (n) => (n.properties.level || 'info').toUpperCase(),
    badgeColor: (n) => ({ debug: '#94a3b8', info: '#60a5fa', warn: '#fbbf24', error: '#ef4444' }[n.properties.level]),
  },
  'workflow/transform': {
    title: 'Transform', desc: t('workflow.nodeDesc.transform'),
    inputs: [{ name: 'In', type: 'exec' }, { name: 'input', type: 'any' }],
    outputs: addDataOutputDefs([{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], 'transform'),
    props: { operation: 'map', input: '', expression: '', outputVar: '' },
    widgets: [
      { type: 'combo', name: 'Operation', key: 'operation', values: ['map', 'filter', 'reduce', 'find', 'pluck', 'count', 'sort', 'unique', 'flatten', 'json_parse', 'json_stringify'] },
      { type: 'text', name: 'Input', key: 'input' },
      { type: 'text', name: 'Expression', key: 'expression' },
      { type: 'text', name: 'Output var', key: 'outputVar' },
    ],
    width: 230,
    badge: (n) => (n.properties.operation || 'map').toUpperCase(),
  },
  'workflow/subworkflow': {
    title: 'Sub-workflow', desc: t('workflow.nodeDesc.subworkflow'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: addDataOutputDefs([{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], 'subworkflow'),
    props: { workflow: '', inputVars: '', waitForCompletion: true },
    widgets: [
      { type: 'text', name: 'Workflow', key: 'workflow' },
      { type: 'text', name: 'Input vars', key: 'inputVars' },
      { type: 'combo', name: 'Wait', key: 'waitForCompletion', values: ['yes', 'no'] },
    ],
    width: 220,
    badge: (n) => n.properties.workflow ? n.properties.workflow.slice(0, 12).toUpperCase() : 'WORKFLOW',
  },
  'workflow/time': {
    title: 'Time', desc: t('workflow.nodeDesc.time'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: [{ name: 'Done', type: 'exec' }, { name: 'Error', type: 'exec' }], // rebuilt dynamically
    props: { action: 'get_today', projectId: '' },
    widgets: [
      { type: 'combo', name: 'Action', key: 'action', values: ['get_today', 'get_week', 'get_project', 'get_all_projects', 'get_sessions'] },
      { type: 'text', name: 'Project ID', key: 'projectId' },
    ],
    width: 220, dynamic: 'time',
    badge: (n) => (n.properties.action || 'get_today').replace('get_', '').toUpperCase(),
  },
  'workflow/switch': {
    title: 'Switch', desc: t('workflow.nodeDesc.switch'),
    inputs: [{ name: 'In', type: 'exec' }],
    outputs: [{ name: 'default', type: 'exec' }], // rebuilt dynamically
    props: { variable: '', cases: 'case1,case2,case3' },
    widgets: [
      { type: 'text', name: 'Variable', key: 'variable' },
      { type: 'text', name: 'Cases', key: 'cases' },
    ],
    width: 220, dynamic: 'switch',
    badge: (n) => (n.properties.variable || '$var').slice(0, 14),
  },
  'workflow/get_variable': {
    title: 'Get Variable', desc: t('workflow.nodeDesc.getVariable'),
    inputs: [],
    outputs: [{ name: 'value', type: 'any' }],
    props: { name: '', varType: 'any' },
    widgets: [],
    width: 150, resizable: false,
    getTitle: (n) => n.properties.name || 'Get Variable',
    drawExtra: (ctx, n) => {
      const t = n.properties.varType || 'any';
      const pc = (PIN_TYPES[t] || PIN_TYPES.any).color;
      ctx.fillStyle = pc; ctx.globalAlpha = 0.55;
      ctx.fillRect(0, 0, 3, n.size[1]);
      ctx.globalAlpha = 1;
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// WORKFLOW GRAPH ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

class WorkflowGraphEngine {
  constructor() {
    // ── Model ──
    this._nodes = [];         // flat array of node objects
    this._nodeMap = new Map(); // id → node (O(1) lookup)
    this._links = new Map();  // linkId → { id, origin_id, origin_slot, target_id, target_slot, type }
    this._nextNodeId = 1;
    this._nextLinkId = 1;
    this._animatingCount = 0; // nodes currently animating (test running or run running)

    // ── Canvas ──
    this.canvasElement = null;
    this._ctx = null;
    this._animFrame = null;
    this._dirty = true;

    // ── Viewport ──
    this._scale = 1;
    this._offsetX = 0;
    this._offsetY = 0;

    // ── Interaction state ──
    this._selectedNodes = new Set();  // node id set
    this._dragging = null;            // { type: 'node'|'pan'|'link'|'box'|'comment'|'comment-resize', ... }
    this._hoveredNode = null;
    this._hoveredPin = null;          // { node, slotIndex, isOutput, slot }
    this._hoveredLink = null;         // link id or null

    // ── Clipboard ──
    this._clipboard = null;           // { nodes, links } serialized

    // ── Comments ──
    this._comments = [];              // { id, pos:[x,y], size:[w,h], title, color }
    this._nextCommentId = 1;

    // ── Minimap ──
    this._showMinimap = true;

    // ── History ──
    this._undoStack = [];
    this._redoStack = [];
    this._historyPaused = false;

    // ── Run outputs ──
    this._lastRunOutputs = new Map();

    // ── Callbacks ──
    this.onNodeSelected = null;
    this.onNodeDeselected = null;
    this.onGraphChanged = null;
    this.onHistoryChanged = null;
    this.onArrayToSingleConnection = null;

    // ── Compatibility shims ──
    this.graph = this._createGraphShim();
    this.canvas = this._createCanvasShim();

    // Précharger la registry async (non-bloquant, pour que addNode() ait les defs)
    nodeRegistry.loadNodeRegistry().catch(e =>
      console.warn('[GraphEngine] NodeRegistry load failed:', e.message)
    );
  }

  // ═══ LIFECYCLE ═══════════════════════════════════════════════════════════════

  init(canvasElement) {
    this.canvasElement = canvasElement;
    this._ctx = canvasElement.getContext('2d');

    // Event listeners
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseUp = this._handleMouseUp.bind(this);
    this._onWheel = this._handleWheel.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onDblClick = this._handleDblClick.bind(this);
    this._onCtxMenu = this._handleContextMenu.bind(this);

    canvasElement.addEventListener('mousedown', this._onMouseDown);
    canvasElement.addEventListener('mousemove', this._onMouseMove);
    canvasElement.addEventListener('mouseup', this._onMouseUp);
    canvasElement.addEventListener('wheel', this._onWheel, { passive: false });
    canvasElement.addEventListener('dblclick', this._onDblClick);
    canvasElement.addEventListener('contextmenu', this._onCtxMenu);
    window.addEventListener('keydown', this._onKeyDown);

    this._startRenderLoop();

    return this;
  }

  destroy() {
    if (this._animFrame) { cancelAnimationFrame(this._animFrame); this._animFrame = null; }
    if (this.canvasElement) {
      this.canvasElement.removeEventListener('mousedown', this._onMouseDown);
      this.canvasElement.removeEventListener('mousemove', this._onMouseMove);
      this.canvasElement.removeEventListener('mouseup', this._onMouseUp);
      this.canvasElement.removeEventListener('wheel', this._onWheel);
      this.canvasElement.removeEventListener('dblclick', this._onDblClick);
      this.canvasElement.removeEventListener('contextmenu', this._onCtxMenu);
      window.removeEventListener('keydown', this._onKeyDown);
    }
    this._nodes = [];
    this._links.clear();
    this._comments = [];
    this.canvasElement = null;
    this._ctx = null;
    this.onNodeSelected = null;
    this.onNodeDeselected = null;
    this.onGraphChanged = null;
  }

  resize(width, height) {
    if (!this.canvasElement) return;
    this.canvasElement.width = width;
    this.canvasElement.height = height;
    this._dirty = true;
  }

  _markDirty() {
    this._dirty = true;
    // Restart render loop if it was stopped due to inactivity
    if (!this._animFrame && this.canvasElement) this._startRenderLoop();
  }

  /** Render loop — throttled to 30fps, auto-stops after 4s idle */
  _startRenderLoop() {
    const FRAME_MS = 1000 / 30;
    let lastFrameTime = 0;
    let idleFrames = 0;
    const loop = (now) => {
      if (this._animatingCount > 0) this._dirty = true;

      if (this._dirty && (now - lastFrameTime >= FRAME_MS)) {
        this._render();
        this._dirty = false;
        lastFrameTime = now;
        idleFrames = 0;
      } else if (!this._dirty) {
        idleFrames++;
      }

      if (idleFrames > 120) { this._animFrame = null; return; }
      this._animFrame = requestAnimationFrame(loop);
    };
    this._animFrame = requestAnimationFrame(loop);
  }

  // ═══ NODE MANAGEMENT ════════════════════════════════════════════════════════

  addNode(typeName, pos) {
    const def = NODE_TYPES[typeName] || nodeRegistry.get(typeName);
    if (!def) return null;

    const id = this._nextNodeId++;
    const node = {
      id,
      type: typeName,
      title: def.title,
      pos: pos ? [...pos] : [200, 200],
      size: [def.width || 200, 0],
      properties: { ...def.props },
      inputs: (def.inputs || []).map(s => ({ name: s.name, type: s.type, link: null })),
      outputs: (def.outputs || []).map(s => ({ name: s.name, type: s.type, links: [] })),
      widgets: (def.widgets || []).map(w => ({
        type: w.type,
        name: w.name,
        key: w.key,
        value: def.props[w.key] !== undefined ? def.props[w.key] : (w.values ? w.values[0] : ''),
        options: { values: w.values },
        disabled: false,
      })),
      removable: def.removable !== false,
      resizable: def.resizable !== false,
      is_selected: false,
      flags: {},
      _runStatus: null,
      _testState: null,
      _testResult: null,
      _outputSchema: null,
    };

    // Dynamic rebuild : use node def's rebuildOutputs if available, else fallback
    if (def.dynamic) {
      if (def.rebuildOutputs) {
        def.rebuildOutputs(this, node);
      } else if (def.dynamic === 'switch') {
        this._rebuildSwitchOutputs(node);
      } else if (def.dynamic === 'time') {
        this._rebuildTimeOutputs(node);
      } else if (def.dynamic === 'variable') {
        this._rebuildVariablePins(node);
      }
    }

    node.size[1] = computeNodeHeight(node);
    this._nodes.push(node);
    this._nodeMap.set(node.id, node);

    // Select the new node
    this._selectNode(node, false);
    this._markDirty();
    this._notifyChanged();
    this.pushSnapshot();
    return node;
  }

  _rebuildSwitchOutputs(node) {
    // Clear existing links from these outputs
    for (const out of node.outputs) {
      for (const lid of out.links) this._links.delete(lid);
    }
    node.outputs = [];
    const cases = (node.properties.cases || '').split(',').map(c => c.trim()).filter(Boolean);
    for (const c of cases) node.outputs.push({ name: c, type: 'exec', links: [] });
    node.outputs.push({ name: 'default', type: 'exec', links: [] });
    node.size[1] = computeNodeHeight(node);
  }

  _rebuildTimeOutputs(node) {
    const action = node.properties.action || 'get_today';
    const needsProjectInput = action === 'get_project' || action === 'get_sessions';

    // ── Rebuild inputs ──────────────────────────────────────────────────────
    // slot 0 = exec In (always), slot 1 = projectId (optional)
    const hasProjectInput = node.inputs.length > 1 && node.inputs[1]?.name === 'projectId';
    if (needsProjectInput && !hasProjectInput) {
      // Add projectId input
      node.inputs.push({ name: 'projectId', type: 'string', link: null });
    } else if (!needsProjectInput && hasProjectInput) {
      // Remove projectId input and its link
      if (node.inputs[1].link != null) this._removeLink(node.inputs[1].link);
      node.inputs.splice(1, 1);
    }

    // ── Rebuild outputs ─────────────────────────────────────────────────────
    // Clear data output links (keep exec slots 0 and 1 intact)
    for (let i = 2; i < node.outputs.length; i++) {
      for (const lid of [...node.outputs[i].links]) this._removeLink(lid);
    }
    node.outputs = [
      { name: 'Done', type: 'exec', links: [] },
      { name: 'Error', type: 'exec', links: [] },
    ];
    const DATA_OUTPUTS = {
      get_today:        [{ name: 'today',        type: 'number' }, { name: 'week',         type: 'number' }, { name: 'month',        type: 'number' }, { name: 'projects',     type: 'array'  }],
      get_week:         [{ name: 'total',         type: 'number' }, { name: 'days',         type: 'array'  }],
      get_project:      [{ name: 'today',         type: 'number' }, { name: 'week',         type: 'number' }, { name: 'month',        type: 'number' }, { name: 'total',        type: 'number' }, { name: 'sessionCount', type: 'number' }],
      get_all_projects: [{ name: 'projects',      type: 'array'  }, { name: 'count',        type: 'number' }],
      get_sessions:     [{ name: 'sessions',      type: 'array'  }, { name: 'count',        type: 'number' }, { name: 'totalMs',      type: 'number' }],
    };
    for (const out of (DATA_OUTPUTS[action] || [])) {
      node.outputs.push({ name: out.name, type: out.type, links: [] });
    }
    node.size[1] = computeNodeHeight(node);
  }

  _rebuildVariablePins(node) {
    const action = node.properties.action || 'set';

    // Clear all existing links
    for (const inp of node.inputs) {
      if (inp.link != null) this._removeLink(inp.link);
    }
    for (const out of node.outputs) {
      for (const lid of [...out.links]) this._removeLink(lid);
    }

    if (action === 'get') {
      // Pure node: no exec pins, just data output
      node.inputs = [];
      node.outputs = [{ name: 'value', type: 'any', links: [] }];
    } else if (action === 'set' || action === 'append') {
      // Exec + data input for the value + data output
      node.inputs = [
        { name: 'In', type: 'exec', link: null },
        { name: 'value', type: 'any', link: null },
      ];
      node.outputs = [
        { name: 'Done', type: 'exec', links: [] },
        { name: 'value', type: 'any', links: [] },
      ];
    } else {
      // increment: exec only, no data input needed
      node.inputs = [{ name: 'In', type: 'exec', link: null }];
      node.outputs = [
        { name: 'Done', type: 'exec', links: [] },
        { name: 'value', type: 'any', links: [] },
      ];
    }

    node.size[1] = computeNodeHeight(node);
    this._markDirty();
  }

  deleteSelected() {
    const toRemove = this._nodes.filter(n => this._selectedNodes.has(n.id) && n.removable !== false);
    for (const node of toRemove) this._removeNode(node);
    this._selectedNodes.clear();
    this._markDirty();
    this._notifyChanged();
    this.pushSnapshot();
  }

  _removeNode(node) {
    // Remove all links connected to this node
    for (const input of node.inputs) {
      if (input.link != null) this._removeLink(input.link);
    }
    for (const output of node.outputs) {
      for (const lid of [...output.links]) this._removeLink(lid);
    }
    const idx = this._nodes.indexOf(node);
    if (idx >= 0) this._nodes.splice(idx, 1);
    this._nodeMap.delete(node.id);
  }

  _removeLink(linkId) {
    const link = this._links.get(linkId);
    if (!link) return;
    // Clean references from source output
    const srcNode = this._getNodeById(link.origin_id);
    if (srcNode && srcNode.outputs[link.origin_slot]) {
      const arr = srcNode.outputs[link.origin_slot].links;
      const i = arr.indexOf(linkId);
      if (i >= 0) arr.splice(i, 1);
    }
    // Clean reference from target input
    const dstNode = this._getNodeById(link.target_id);
    if (dstNode && dstNode.inputs[link.target_slot]) {
      if (dstNode.inputs[link.target_slot].link === linkId) {
        dstNode.inputs[link.target_slot].link = null;
      }
    }
    this._links.delete(linkId);
  }

  _getNodeById(id) {
    return this._nodeMap.get(id) || null;
  }

  selectAll() {
    for (const n of this._nodes) {
      n.is_selected = true;
      this._selectedNodes.add(n.id);
    }
    this._markDirty();
    this._notifyChanged();
  }

  getSelectedCount() {
    return this._selectedNodes.size;
  }

  getNodeCount() {
    return this._nodes.length;
  }

  duplicateSelected() {
    if (!this._selectedNodes.size) return;
    const newNodes = [];
    for (const id of this._selectedNodes) {
      const node = this._getNodeById(id);
      if (!node) continue;
      const copy = this.addNode(node.type, [node.pos[0] + 40, node.pos[1] + 40]);
      if (!copy) continue;
      Object.assign(copy.properties, JSON.parse(JSON.stringify(node.properties)));
      // Sync widget values
      for (let i = 0; i < copy.widgets.length; i++) {
        if (node.widgets[i]) copy.widgets[i].value = node.widgets[i].value;
      }
      newNodes.push(copy);
    }
    if (newNodes.length) {
      this._deselectAll();
      for (const n of newNodes) this._selectNode(n, true);
      this._markDirty();
      this.pushSnapshot();
    }
  }

  // ═══ SELECTION ══════════════════════════════════════════════════════════════

  _selectNode(node, additive) {
    if (!additive) {
      for (const n of this._nodes) n.is_selected = false;
      this._selectedNodes.clear();
    }
    node.is_selected = true;
    this._selectedNodes.add(node.id);
    if (this.onNodeSelected) this.onNodeSelected(node);
  }

  _deselectAll() {
    for (const n of this._nodes) n.is_selected = false;
    this._selectedNodes.clear();
    if (this.onNodeDeselected) this.onNodeDeselected();
  }

  _toggleSelect(node) {
    if (this._selectedNodes.has(node.id)) {
      node.is_selected = false;
      this._selectedNodes.delete(node.id);
    } else {
      node.is_selected = true;
      this._selectedNodes.add(node.id);
      if (this.onNodeSelected) this.onNodeSelected(node);
    }
  }

  // ═══ LINKS ═════════════════════════════════════════════════════════════════

  _addLink(originId, originSlot, targetId, targetSlot) {
    const srcNode = this._getNodeById(originId);
    const dstNode = this._getNodeById(targetId);
    if (!srcNode || !dstNode) return null;
    const srcSlot = srcNode.outputs[originSlot];
    const dstSlot = dstNode.inputs[targetSlot];
    if (!srcSlot || !dstSlot) return null;

    // Validate type compatibility
    const srcType = srcSlot.type === -1 ? 'exec' : (srcSlot.type || 'any');
    const dstType = dstSlot.type === -1 ? 'exec' : (dstSlot.type || 'any');
    if (!isValidConnection(srcType, dstType)) return null;

    // Remove existing link on target input (single connection per input)
    if (dstSlot.link != null) this._removeLink(dstSlot.link);

    const linkId = this._nextLinkId++;
    const link = {
      id: linkId,
      origin_id: originId,
      origin_slot: originSlot,
      target_id: targetId,
      target_slot: targetSlot,
      type: srcType,
    };
    this._links.set(linkId, link);
    srcSlot.links.push(linkId);
    dstSlot.link = linkId;

    // Detect array→single connection (suggest auto-loop insertion)
    if (srcType === 'array' && dstType !== 'array' && dstType !== 'any' && this.onArrayToSingleConnection) {
      this.onArrayToSingleConnection(link, srcNode, dstNode);
    }

    this._notifyChanged();
    this.pushSnapshot();
    return link;
  }

  // ═══ PIN POSITIONS ═════════════════════════════════════════════════════════

  _getOutputPinPos(node, slotIndex) {
    return [node.pos[0] + node.size[0], node.pos[1] + TITLE_H + (slotIndex + 0.5) * SLOT_H];
  }

  _getInputPinPos(node, slotIndex) {
    return [node.pos[0], node.pos[1] + TITLE_H + (slotIndex + 0.5) * SLOT_H];
  }

  /** Public: get pin position in graph coords */
  getOutputPinPos(nodeId, slotIndex) {
    const node = this._getNodeById(nodeId);
    return node ? this._getOutputPinPos(node, slotIndex) : [0, 0];
  }

  getInputPinPos(nodeId, slotIndex) {
    const node = this._getNodeById(nodeId);
    return node ? this._getInputPinPos(node, slotIndex) : [0, 0];
  }

  /** Convert graph coordinates to screen coordinates */
  graphToScreen(gx, gy) {
    return [
      gx * this._scale + this._offsetX,
      gy * this._scale + this._offsetY,
    ];
  }

  // ═══ SERIALIZATION ═════════════════════════════════════════════════════════

  _serialize() {
    const nodes = this._nodes.map(n => {
      const sn = {
        id: n.id,
        type: n.type,
        pos: [...n.pos],
        size: [...n.size],
        properties: JSON.parse(JSON.stringify(n.properties)),
        inputs: (n.inputs || []).map(s => ({
          name: s.name,
          type: s.type === 'exec' ? -1 : s.type,
          link: s.link,
        })),
        outputs: (n.outputs || []).map(s => ({
          name: s.name,
          type: s.type === 'exec' ? -1 : s.type,
          links: [...s.links],
          slot_index: undefined, // LiteGraph compat
        })),
        flags: n.flags || {},
      };
      // Store widget values as flat array (LiteGraph format)
      if (n.widgets && n.widgets.length) {
        sn.widgets_values = n.widgets.map(w => w.value);
      }
      return sn;
    });

    const links = [];
    for (const [, link] of this._links) {
      const type = link.type === 'exec' ? -1 : link.type;
      links.push([link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot, type]);
    }

    const comments = this._comments.map(c => ({
      id: c.id, pos: [...c.pos], size: [...c.size], title: c.title, color: c.color,
    }));

    return { nodes, links, comments, last_node_id: this._nextNodeId, last_link_id: this._nextLinkId };
  }

  _configure(data) {
    this._nodes = [];
    this._nodeMap.clear();
    this._links.clear();
    this._selectedNodes.clear();
    this._comments = [];
    this._animatingCount = 0;

    if (!data) return;

    // Load comments
    if (Array.isArray(data.comments)) {
      for (const c of data.comments) {
        this._comments.push({
          id: c.id, pos: [...c.pos], size: [...c.size],
          title: c.title || 'Comment', color: c.color || '#f59e0b',
        });
        if (c.id >= this._nextCommentId) this._nextCommentId = c.id + 1;
      }
    }

    // Repair slot refs first
    this._repairSlotRefs(data);

    // Load nodes
    for (const sn of (data.nodes || [])) {
      const def = NODE_TYPES[sn.type];
      if (!def) continue;

      // Build node from serialized data
      const node = {
        id: sn.id,
        type: sn.type,
        title: def.title,
        pos: sn.pos ? [...sn.pos] : [200, 200],
        size: sn.size ? [...sn.size] : [def.width || 200, 0],
        properties: sn.properties ? JSON.parse(JSON.stringify(sn.properties)) : { ...def.props },
        inputs: (sn.inputs || []).map(s => ({
          name: s.name,
          type: s.type === -1 ? 'exec' : (s.type || 'exec'),
          link: s.link != null ? s.link : null,
        })),
        outputs: (() => {
          const saved = (sn.outputs || []).map(s => ({
            name: s.name,
            type: s.type === -1 ? 'exec' : (s.type || 'exec'),
            links: Array.isArray(s.links) ? [...s.links] : [],
          }));
          // Add any outputs from the type definition that are missing in the saved data
          const defOuts = def.outputs || [];
          for (let i = saved.length; i < defOuts.length; i++) {
            saved.push({ name: defOuts[i].name, type: defOuts[i].type, links: [] });
          }
          return saved;
        })(),
        widgets: (def.widgets || []).map(w => ({
          type: w.type,
          name: w.name,
          key: w.key,
          value: sn.properties?.[w.key] !== undefined ? sn.properties[w.key] : (w.values ? w.values[0] : ''),
          options: { values: w.values },
          disabled: false,
        })),
        removable: def.removable !== false,
        resizable: def.resizable !== false,
        is_selected: false,
        flags: sn.flags || {},
        _runStatus: null,
        _testState: null,
        _testResult: null,
        _outputSchema: null,
      };

      // Restore widget values from serialized flat array
      if (sn.widgets_values && node.widgets) {
        for (let i = 0; i < Math.min(sn.widgets_values.length, node.widgets.length); i++) {
          node.widgets[i].value = sn.widgets_values[i];
        }
      }

      // Recompute height to fit all slots
      const h = computeNodeHeight(node);
      if (node.size[1] < h) node.size[1] = h;

      this._nodes.push(node);
      this._nodeMap.set(node.id, node);
      if (sn.id >= this._nextNodeId) this._nextNodeId = sn.id + 1;
    }

    // Load links
    for (const la of (data.links || [])) {
      const [id, fromId, fromSlot, toId, toSlot, type] = la;
      const link = {
        id,
        origin_id: fromId,
        origin_slot: fromSlot,
        target_id: toId,
        target_slot: toSlot,
        type: type === -1 ? 'exec' : (type || 'any'),
      };
      this._links.set(id, link);
      if (id >= this._nextLinkId) this._nextLinkId = id + 1;
    }

    // Migrate old Variable nodes: add missing data pins non-destructively
    for (const node of this._nodes) {
      if (node.type !== 'workflow/variable') continue;
      const action = node.properties.action || 'set';
      const hasDataIn = node.inputs.some(i => i.name === 'value' && i.type === 'any');
      const hasDataOut = node.outputs.some(o => o.name === 'value' && o.type === 'any');
      if ((action === 'set' || action === 'append') && !hasDataIn) {
        node.inputs.push({ name: 'value', type: 'any', link: null });
      }
      if (action !== 'get' && !hasDataOut) {
        node.outputs.push({ name: 'value', type: 'any', links: [] });
      }
      node.size[1] = computeNodeHeight(node);
    }

    this._markDirty();
  }

  _repairSlotRefs(data) {
    if (!data || !Array.isArray(data.links)) return;
    for (const node of data.nodes || []) {
      if (node.outputs) for (const o of node.outputs) { if (!Array.isArray(o.links)) o.links = []; }
      if (node.inputs) for (const i of node.inputs) { if (i.link === undefined) i.link = null; }
    }
    for (const link of data.links) {
      const [linkId, fromId, fromSlot, toId, toSlot] = link;
      const src = (data.nodes || []).find(n => n.id === fromId);
      const dst = (data.nodes || []).find(n => n.id === toId);
      if (src && src.outputs && src.outputs[fromSlot]) {
        if (!Array.isArray(src.outputs[fromSlot].links)) src.outputs[fromSlot].links = [];
        if (!src.outputs[fromSlot].links.includes(linkId)) src.outputs[fromSlot].links.push(linkId);
      }
      if (dst && dst.inputs && dst.inputs[toSlot]) {
        dst.inputs[toSlot].link = linkId;
      }
    }
  }

  serializeToWorkflow() {
    const data = this._serialize();
    const triggerNode = this._nodes.find(n => n.type === 'workflow/trigger');
    const trigger = triggerNode ? (() => {
      const p = triggerNode.properties || {};
      const out = {
        type:  p.triggerType || 'manual',
        value: p.triggerValue || '',
      };
      // Trigger-type-specific fields — only include when relevant so the
      // saved payload stays tidy and matches what WorkflowScheduler inspects.
      if (out.type === 'hook' && p.hookType) out.hookType = p.hookType;
      if (out.type === 'file_change') {
        if (p.projectId)           out.projectId   = p.projectId;
        if (p.watchPath)           out.watchPath   = p.watchPath;
        if (p.patterns)            out.patterns    = p.patterns;
        if (p.events)              out.events      = p.events;
        if (p.debounceMs != null)  out.debounceMs  = Number(p.debounceMs) || 500;
      }
      if (out.type === 'terminal_exit_code') {
        out.codeFilter = p.codeFilter || 'any';
        if (out.codeFilter === 'custom' && p.customCodes) out.customCodes = p.customCodes;
        if (p.projectId) out.projectId = p.projectId;
      }
      if (out.type === 'project_opened') {
        if (p.projectId) out.projectId = p.projectId;
      }
      if (out.type === 'claude_session_start') {
        if (p.projectId) out.projectId = p.projectId;
      }
      if (out.type === 'claude_session_end') {
        if (p.projectId) out.projectId = p.projectId;
        if (p.statusFilter) out.statusFilter = p.statusFilter;
      }
      return out;
    })() : { type: 'manual', value: '' };
    const hookType = triggerNode ? triggerNode.properties.hookType : 'PostToolUse';

    const steps = [];
    for (const node of data.nodes) {
      if (node.type === 'workflow/trigger') continue;
      steps.push({
        id: `node_${node.id}`,
        type: node.type.replace('workflow/', ''),
        _nodeId: node.id,
        ...node.properties,
      });
    }

    return { trigger, hookType, graph: data, steps };
  }

  loadFromWorkflow(workflow) {
    if (workflow.graph) {
      this._configure(workflow.graph);
    } else if (workflow.steps) {
      this._migrateLegacySteps(workflow);
    }
    this._undoStack = [];
    this._redoStack = [];
    this.pushSnapshot();
    this._markDirty();
  }

  createEmpty() {
    this._historyPaused = true;
    this._nodes = [];
    this._links.clear();
    this._selectedNodes.clear();
    this._comments = [];
    this._nextNodeId = 1;
    this._nextLinkId = 1;
    this._nextCommentId = 1;

    const trigger = this.addNode('workflow/trigger', [100, 200]);
    if (trigger) trigger.removable = false;

    this._scale = 1;
    this._offsetX = 0;
    this._offsetY = 0;
    this._historyPaused = false;
    this._undoStack = [];
    this._redoStack = [];
    this.pushSnapshot();
    this._markDirty();
  }

  _migrateLegacySteps(workflow) {
    this._nodes = [];
    this._links.clear();
    this._nextNodeId = 1;
    this._nextLinkId = 1;
    this._historyPaused = true;

    const SPACING_X = 280;
    const trigger = this.addNode('workflow/trigger', [100, 200]);
    if (trigger) {
      trigger.removable = false;
      trigger.properties.triggerType = workflow.trigger?.type || 'manual';
      trigger.properties.triggerValue = workflow.trigger?.value || '';
      trigger.properties.hookType = workflow.hookType || workflow.trigger?.hookType || 'PostToolUse';
      // Restore trigger-specific fields for new trigger types
      const wt = workflow.trigger || {};
      if (wt.projectId)          trigger.properties.projectId   = wt.projectId;
      if (wt.watchPath)          trigger.properties.watchPath   = wt.watchPath;
      if (wt.patterns)           trigger.properties.patterns    = wt.patterns;
      if (wt.events)             trigger.properties.events      = wt.events;
      if (wt.debounceMs != null) trigger.properties.debounceMs  = wt.debounceMs;
      if (wt.codeFilter)         trigger.properties.codeFilter  = wt.codeFilter;
      if (wt.customCodes)        trigger.properties.customCodes = wt.customCodes;
      if (wt.statusFilter)       trigger.properties.statusFilter = wt.statusFilter;
    }

    let prevNode = trigger;
    for (let i = 0; i < (workflow.steps || []).length; i++) {
      const step = workflow.steps[i];
      const typeName = `workflow/${step.type === 'agent' ? 'claude' : step.type}`;
      const node = this.addNode(typeName, [100 + SPACING_X * (i + 1), 200]);
      if (!node) continue;
      Object.assign(node.properties, step);
      delete node.properties.id;
      delete node.properties.type;
      // Sync widgets
      for (const w of node.widgets) {
        if (node.properties[w.key] !== undefined) w.value = node.properties[w.key];
      }
      if (prevNode) this._addLink(prevNode.id, 0, node.id, 0);
      prevNode = node;
    }
    this._historyPaused = false;
  }

  // ═══ INSERT LOOP BETWEEN ════════════════════════════════════════════════════

  /**
   * Insert a loop node between two connected nodes (array→single auto-loop).
   * @param {object} link  — { id, origin_id, origin_slot, target_id, target_slot }
   */
  insertLoopBetween(link) {
    const srcNode = this._getNodeById(link.origin_id);
    const dstNode = this._getNodeById(link.target_id);
    if (!srcNode || !dstNode) return;

    // Calculate midpoint position
    const [sx, sy] = this._getOutputPinPos(srcNode, link.origin_slot);
    const [dx, dy] = this._getInputPinPos(dstNode, link.target_slot);
    const mx = (sx + dx) / 2;
    const my = (sy + dy) / 2;

    // Remove existing link
    this._removeLink(link.id);

    // Create loop node at midpoint
    const loopNode = this.addNode('workflow/loop', [mx - 100, my - 30]);
    if (!loopNode) return;
    loopNode.properties.source = 'auto';

    // Connect: source → loop In (slot 0), loop Each (output 0) → target
    this._addLink(srcNode.id, link.origin_slot, loopNode.id, 0);
    this._addLink(loopNode.id, 0, dstNode.id, link.target_slot);

    this._markDirty();
    this._notifyChanged();
    this.pushSnapshot();
  }

  // ═══ UNDO / REDO ══════════════════════════════════════════════════════════

  pushSnapshot() {
    if (this._historyPaused) return;
    const snap = JSON.stringify(this._serialize());
    if (this._undoStack.length > 0 && this._undoStack[this._undoStack.length - 1] === snap) return;
    this._undoStack.push(snap);
    if (this._undoStack.length > MAX_HISTORY) this._undoStack.shift();
    this._redoStack = [];
    if (this.onHistoryChanged) this.onHistoryChanged();
  }

  canUndo() { return this._undoStack.length > 1; }
  canRedo() { return this._redoStack.length > 0; }

  undo() {
    if (!this.canUndo()) return;
    const current = JSON.stringify(this._serialize());
    this._redoStack.push(current);
    this._undoStack.pop();
    this._applySnapshot(this._undoStack[this._undoStack.length - 1]);
    if (this.onHistoryChanged) this.onHistoryChanged();
  }

  redo() {
    if (!this.canRedo()) return;
    const next = this._redoStack.pop();
    this._undoStack.push(next);
    this._applySnapshot(next);
    if (this.onHistoryChanged) this.onHistoryChanged();
  }

  _applySnapshot(snap) {
    this._historyPaused = true;
    try {
      this._configure(JSON.parse(snap));
      this._deselectAll();
      this._notifyChanged();
    } finally {
      this._historyPaused = false;
    }
  }

  // ═══ ZOOM ═════════════════════════════════════════════════════════════════

  getZoom() { return this._scale; }

  setZoom(scale) {
    this._scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    this._markDirty();
  }

  zoomToFit(padding = 60) {
    if (!this._nodes.length) {
      this._scale = 1;
      this._offsetX = 0;
      this._offsetY = 0;
      this._markDirty();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this._nodes) {
      if (n.pos[0] < minX) minX = n.pos[0];
      if (n.pos[1] < minY) minY = n.pos[1];
      if (n.pos[0] + n.size[0] > maxX) maxX = n.pos[0] + n.size[0];
      if (n.pos[1] + n.size[1] + TITLE_H > maxY) maxY = n.pos[1] + n.size[1] + TITLE_H;
    }
    const bw = maxX - minX + padding * 2;
    const bh = maxY - minY + padding * 2;
    const vw = this.canvasElement.width;
    const vh = this.canvasElement.height;
    const scale = Math.min(vw / bw, vh / bh, 1.5);
    this._scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
    this._offsetX = -(minX - padding) * this._scale;
    this._offsetY = -(minY - padding) * this._scale;
    this._markDirty();
  }

  // ═══ OUTPUT TRACKING ══════════════════════════════════════════════════════

  setNodeOutput(nodeId, output) {
    this._lastRunOutputs.set(nodeId, output);
    const node = this._getNodeById(nodeId);
    if (!node || !output) return;
    const schema = this._extractItemSchema(output);
    if (schema?.length) {
      node._outputSchema = schema;
      // Propagate to downstream Loop nodes
      for (const out of node.outputs) {
        for (const lid of out.links) {
          const link = this._links.get(lid);
          if (!link) continue;
          const target = this._getNodeById(link.target_id);
          if (target?.type === 'workflow/loop') {
            this._applyLoopSchema(target, schema);
          }
        }
      }
    }
  }

  getNodeOutput(nodeId) { return this._lastRunOutputs.get(nodeId) || null; }
  clearRunOutputs() { this._lastRunOutputs.clear(); }

  setNodeStatus(nodeId, status) {
    const node = this._getNodeById(nodeId);
    if (node) {
      if (node._runStatus !== 'running' && status === 'running') this._animatingCount++;
      else if (node._runStatus === 'running' && status !== 'running') this._animatingCount--;
      node._runStatus = status;
      this._markDirty();
    }
  }

  clearAllStatuses() {
    for (const n of this._nodes) {
      if (n._runStatus === 'running') this._animatingCount--;
      n._runStatus = null;
    }
    this._markDirty();
  }

  _extractItemSchema(output) {
    if (Array.isArray(output) && output.length > 0 && typeof output[0] === 'object' && output[0] !== null) {
      return Object.keys(output[0]);
    }
    if (output && typeof output === 'object') {
      // Generic scan: find any array property containing objects — no hardcoded keys needed
      for (const arr of Object.values(output)) {
        if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
          return Object.keys(arr[0]);
        }
      }
    }
    return null;
  }

  _applyLoopSchema(node, schema) {
    // Remove dynamic outputs beyond base 4 (Each, Done, item, index)
    while (node.outputs.length > 4) {
      const out = node.outputs.pop();
      for (const lid of out.links) this._removeLink(lid);
    }
    node.properties._itemSchema = schema;
    for (const key of schema) {
      node.outputs.push({ name: 'item.' + key, type: 'any', links: [] });
    }
    node.size[1] = computeNodeHeight(node);
    this._markDirty();
  }

  // ═══ NOTIFICATIONS ════════════════════════════════════════════════════════

  _notifyChanged() {
    if (this.onGraphChanged) this.onGraphChanged();
    this._markDirty();
  }

  // ═══ RENDERING ════════════════════════════════════════════════════════════

  _render() {
    const ctx = this._ctx;
    const W = this.canvasElement.width;
    const H = this.canvasElement.height;

    // Clear
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(this._offsetX, this._offsetY);
    ctx.scale(this._scale, this._scale);

    this._drawGrid(ctx, W, H);
    this._drawComments(ctx);
    this._drawLinks(ctx);
    for (const node of this._nodes) this._drawNode(ctx, node);

    // Draw rubber-band link during drag
    if (this._dragging?.type === 'link') {
      const d = this._dragging;
      const slotType = d.slot?.type === -1 ? 'exec' : (d.slot?.type || 'any');
      const linkColor = (PIN_TYPES[slotType] || PIN_TYPES.any).color;
      ctx.save();
      ctx.strokeStyle = linkColor;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.8;
      // Bezier curve
      const dx = Math.abs(d.curX - d.startX) * 0.5;
      ctx.beginPath();
      if (d.isOutput) {
        ctx.moveTo(d.startX, d.startY);
        ctx.bezierCurveTo(d.startX + dx, d.startY, d.curX - dx, d.curY, d.curX, d.curY);
      } else {
        ctx.moveTo(d.startX, d.startY);
        ctx.bezierCurveTo(d.startX - dx, d.startY, d.curX + dx, d.curY, d.curX, d.curY);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    // Draw selection box
    if (this._dragging?.type === 'box') {
      const d = this._dragging;
      ctx.save();
      ctx.strokeStyle = 'rgba(245,158,11,0.5)';
      ctx.fillStyle = 'rgba(245,158,11,0.05)';
      ctx.lineWidth = 1;
      const x = Math.min(d.startX, d.curX);
      const y = Math.min(d.startY, d.curY);
      const w = Math.abs(d.curX - d.startX);
      const h = Math.abs(d.curY - d.startY);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    ctx.restore();

    // Pin tooltip (drawn in screen space, after ctx.restore)
    if (this._hoveredPin && !this._dragging) {
      this._drawPinTooltip(ctx);
    }

    // Minimap (drawn in screen space, after ctx.restore)
    if (this._showMinimap && this._nodes.length > 1) {
      this._drawMinimap(ctx, W, H);
    }
  }

  _drawPinTooltip(ctx) {
    const hp = this._hoveredPin;
    if (!hp) return;

    const { node, slotIndex, isOutput, slot } = hp;
    const pinType = slot.type === -1 ? 'exec' : (slot.type || 'any');
    const pinColor = (PIN_TYPES[pinType] || PIN_TYPES.any).color;

    // Build tooltip lines
    const lines = [];
    const pinName = slot.name || (isOutput ? `out ${slotIndex}` : `in ${slotIndex}`);

    if (isOutput) {
      lines.push({ text: pinName, color: pinColor, bold: true });
      lines.push({ text: pinType, color: pinColor, dim: true });
      // Last run value
      const nodeType = (node.type || '').replace('workflow/', '');
      const nodeId = `node_${node.id}`;
      const output = this._lastRunOutputs.get(nodeId);
      if (output != null) {
        const offset = NODE_DATA_OUT_OFFSET[nodeType] ?? 0;
        const dataIdx = slotIndex - offset;
        const dataDef = NODE_DATA_OUTPUTS[nodeType];
        if (dataDef && dataIdx >= 0 && dataIdx < dataDef.length) {
          const key = dataDef[dataIdx].key;
          const val = output[key] ?? output;
          lines.push({ text: this._truncateValue(val), color: '#888', mono: true });
        } else if (pinType === 'exec') {
          // No value for exec pins
        } else {
          lines.push({ text: this._truncateValue(output), color: '#888', mono: true });
        }
      } else {
        if (pinType !== 'exec') lines.push({ text: t('workflow.noDataYet'), color: '#555', dim: true });
      }
    } else {
      // Input pin
      lines.push({ text: pinName, color: pinColor, bold: true });
      lines.push({ text: t('workflow.expects', { type: pinType }), color: pinColor, dim: true });
      // Show connected source
      if (slot.link != null) {
        const link = this._links.get(slot.link);
        if (link) {
          const srcNode = this._getNodeById(link.origin_id);
          if (srcNode) {
            const srcSlot = srcNode.outputs?.[link.origin_slot];
            const srcName = srcNode._customTitle || srcNode.title || srcNode.type?.replace('workflow/', '') || '?';
            const srcPin = srcSlot?.name || `out ${link.origin_slot}`;
            lines.push({ text: `\u2190 ${srcName}.${srcPin}`, color: '#aaa' });
          }
        }
      }
    }

    if (!lines.length) return;

    // Compute pin position in screen coords
    const [gpx, gpy] = isOutput
      ? this._getOutputPinPos(node, slotIndex)
      : this._getInputPinPos(node, slotIndex);
    const sx = gpx * this._scale + this._offsetX;
    const sy = gpy * this._scale + this._offsetY;

    // Measure tooltip
    ctx.save();
    const pad = 8;
    const lineH = 16;
    ctx.font = `500 11px ${FONT}`;
    let maxW = 0;
    for (const line of lines) {
      const f = line.mono ? `11px ${MONO}` : (line.bold ? `600 11px ${FONT}` : `500 11px ${FONT}`);
      ctx.font = f;
      maxW = Math.max(maxW, ctx.measureText(line.text).width);
    }
    const tipW = maxW + pad * 2;
    const tipH = lines.length * lineH + pad * 2 - 4;

    // Position: offset from pin
    let tipX = isOutput ? sx + 14 : sx - tipW - 14;
    let tipY = sy - tipH / 2;

    // Clamp to viewport
    const W = this.canvasElement.width;
    const H = this.canvasElement.height;
    if (tipX + tipW > W - 4) tipX = sx - tipW - 14;
    if (tipX < 4) tipX = sx + 14;
    if (tipY < 4) tipY = 4;
    if (tipY + tipH > H - 4) tipY = H - tipH - 4;

    // Draw background
    roundRect(ctx, tipX, tipY, tipW, tipH, 6);
    ctx.fillStyle = 'rgba(20,20,22,0.95)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Draw lines
    let y = tipY + pad + 10;
    for (const line of lines) {
      ctx.font = line.mono ? `11px ${MONO}` : (line.bold ? `600 11px ${FONT}` : `500 11px ${FONT}`);
      ctx.globalAlpha = line.dim ? 0.5 : 0.9;
      ctx.fillStyle = line.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(line.text, tipX + pad, y);
      y += lineH;
    }

    ctx.restore();
  }

  _truncateValue(val) {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'string') {
      const single = val.replace(/\n/g, '\\n');
      return single.length > 80 ? single.slice(0, 77) + '...' : single;
    }
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) return `Array[${val.length}]`;
    if (typeof val === 'object') {
      const keys = Object.keys(val);
      if (keys.length <= 3) return `{ ${keys.join(', ')} }`;
      return `{ ${keys.slice(0, 3).join(', ')}, +${keys.length - 3} }`;
    }
    return String(val).slice(0, 80);
  }

  _drawGrid(ctx, vpW, vpH) {
    const s = this._scale;
    const startX = (-this._offsetX / s);
    const startY = (-this._offsetY / s);
    const endX = startX + vpW / s;
    const endY = startY + vpH / s;

    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 0.5;
    const gs = GRID_SIZE;

    const fromX = Math.floor(startX / gs) * gs;
    const fromY = Math.floor(startY / gs) * gs;

    ctx.beginPath();
    for (let x = fromX; x < endX; x += gs) {
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
    }
    for (let y = fromY; y < endY; y += gs) {
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
    }
    ctx.stroke();
  }

  _drawLinks(ctx) {
    for (const [, link] of this._links) {
      const srcNode = this._getNodeById(link.origin_id);
      const dstNode = this._getNodeById(link.target_id);
      if (!srcNode || !dstNode) continue;

      const [sx, sy] = this._getOutputPinPos(srcNode, link.origin_slot);
      const [ex, ey] = this._getInputPinPos(dstNode, link.target_slot);

      const pinType = link.type === 'exec' ? 'exec' : (link.type || 'any');
      const color = (PIN_TYPES[pinType] || PIN_TYPES.any).color;

      // Detect active link: src completed/running → dst running
      const srcStatus = srcNode._runStatus;
      const dstStatus = dstNode._runStatus;
      const isActive = (srcStatus === 'success' || srcStatus === 'running') && dstStatus === 'running';

      const isHovered = this._hoveredLink && this._hoveredLink.id === link.id;

      ctx.save();

      if (isHovered) {
        // Highlight hovered link
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 3.5;
        ctx.globalAlpha = 1;
        ctx.shadowColor = '#ef4444';
        ctx.shadowBlur = 10;

        const dx = Math.abs(ex - sx) * 0.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx + dx, sy, ex - dx, ey, ex, ey);
        ctx.stroke();

        // Small X icon at midpoint
        const mx = (sx + ex) / 2, my = (sy + ey) / 2;
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(mx, my, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(mx - 3, my - 3); ctx.lineTo(mx + 3, my + 3);
        ctx.moveTo(mx + 3, my - 3); ctx.lineTo(mx - 3, my + 3);
        ctx.stroke();
      } else if (isActive) {
        // Animated flow pulse along bezier
        const t = (performance.now() % 1500) / 1500;
        const accentColor = getNodeColors(dstNode).accent;
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.9;

        const dx = Math.abs(ex - sx) * 0.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx + dx, sy, ex - dx, ey, ex, ey);
        ctx.stroke();

        // Animated dot traveling along the bezier
        const bt = t;
        const invT = 1 - bt;
        const p0x = sx, p0y = sy;
        const p1x = sx + dx, p1y = sy;
        const p2x = ex - dx, p2y = ey;
        const p3x = ex, p3y = ey;
        const dotX = invT*invT*invT*p0x + 3*invT*invT*bt*p1x + 3*invT*bt*bt*p2x + bt*bt*bt*p3x;
        const dotY = invT*invT*invT*p0y + 3*invT*invT*bt*p1y + 3*invT*bt*bt*p2y + bt*bt*bt*p3y;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
        ctx.fillStyle = accentColor;
        ctx.shadowColor = accentColor;
        ctx.shadowBlur = 8;
        ctx.fill();

        this._markDirty(); // keep animating
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.7;

        const dx = Math.abs(ex - sx) * 0.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx + dx, sy, ex - dx, ey, ex, ey);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawNode(ctx, node) {
    const c = getNodeColors(node);
    const x = node.pos[0];
    const y = node.pos[1];
    const w = node.size[0];
    const h = node.size[1];
    const r = 8;

    // ── Skipped nodes → dim ──
    const isSkipped = node._runStatus === 'skipped';
    if (isSkipped) { ctx.save(); ctx.globalAlpha = 0.35; }

    // ── Title bar (accent-tinted) ──
    ctx.fillStyle = '#141416';
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + TITLE_H);
    ctx.lineTo(x, y + TITLE_H);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();

    // Accent tint overlay
    ctx.fillStyle = hexToRgba(c.accent, 0.18);
    ctx.fill();

    // Top accent stripe (2px)
    ctx.fillStyle = c.accent;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + 2);
    ctx.lineTo(x, y + 2);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // Title dot (accent glow)
    ctx.save();
    ctx.shadowColor = c.accent;
    ctx.shadowBlur = 4;
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(x + 12, y + TITLE_H * 0.5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Title text
    const def = NODE_TYPES[node.type];
    const titleText = (def?.getTitle ? def.getTitle(node) : null) || node.title;
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = node.is_selected ? '#fff' : '#bbb';
    ctx.textAlign = 'left';
    ctx.fillText(titleText, x + 22, y + TITLE_H * 0.5 + 4);

    // ── Body ──
    ctx.fillStyle = '#101012';
    ctx.beginPath();
    ctx.moveTo(x, y + TITLE_H);
    ctx.lineTo(x + w, y + TITLE_H);
    ctx.lineTo(x + w, y + TITLE_H + h - r);
    ctx.quadraticCurveTo(x + w, y + TITLE_H + h, x + w - r, y + TITLE_H + h);
    ctx.lineTo(x + r, y + TITLE_H + h);
    ctx.quadraticCurveTo(x, y + TITLE_H + h, x, y + TITLE_H + h - r);
    ctx.lineTo(x, y + TITLE_H);
    ctx.closePath();
    ctx.fill();

    // Accent gradient at top of body
    const grad = ctx.createLinearGradient(x, y + TITLE_H, x, y + TITLE_H + 18);
    grad.addColorStop(0, c.accentDim);
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y + TITLE_H, w, 18);

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,.04)';
    ctx.lineWidth = 0.5;
    roundRect(ctx, x, y, w, TITLE_H + h, r);
    ctx.stroke();

    // Run status bar (left edge)
    if (node._runStatus && STATUS_COLORS[node._runStatus]) {
      ctx.fillStyle = STATUS_COLORS[node._runStatus];
      ctx.fillRect(x, y + TITLE_H, 2.5, h);
    }

    // Selection outline
    if (node.is_selected) {
      ctx.strokeStyle = hexToRgba(c.accent, 0.35);
      ctx.lineWidth = 1.5;
      roundRect(ctx, x - 0.5, y - 0.5, w + 1, TITLE_H + h + 1, r);
      ctx.stroke();
    }

    // ── Pins ──
    const bodyY = y + TITLE_H;
    this._drawPins(ctx, node, bodyY);

    // ── Widgets ──
    this._drawWidgets(ctx, node, bodyY, c);

    // ── Badge ──
    if (def?.badge) {
      const badgeText = def.badge(node);
      const badgeColor = def.badgeColor ? def.badgeColor(node) || c.accent : c.accent;
      drawBadge(ctx, badgeText, x + w - 6, y + 7, badgeColor);
    }

    // ── Custom drawing ──
    if (def?.drawExtra) {
      ctx.save();
      ctx.translate(x, bodyY);
      def.drawExtra(ctx, node);
      ctx.restore();
    }

    // ── Test button ──
    const nodeType = (node.type || '').replace('workflow/', '');
    if (!UNTESTABLE_NODE_TYPES.has(nodeType)) {
      this._drawTestButton(ctx, node, x, y, w);
    }

    // ── Running pulse glow ──
    if (node._runStatus === 'running') {
      const pulse = (Math.sin(performance.now() / 400) + 1) / 2; // 0..1 oscillation
      ctx.save();
      ctx.shadowColor = c.accent;
      ctx.shadowBlur = 8 + pulse * 12;
      ctx.strokeStyle = hexToRgba(c.accent, 0.3 + pulse * 0.4);
      ctx.lineWidth = 2;
      roundRect(ctx, x - 1, y - 1, w + 2, TITLE_H + h + 2, r + 1);
      ctx.stroke();
      ctx.restore();
      this._markDirty(); // keep animating
    }

    // ── Status badge (top-right) ──
    if (node._runStatus === 'success' || node._runStatus === 'failed') {
      const bx = x + w - 6;
      const by = y + 6;
      const br = 7;
      const isOk = node._runStatus === 'success';
      const badgeCol = isOk ? '#22c55e' : '#ef4444';
      ctx.save();
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fillStyle = '#0d0d0d';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(badgeCol, 0.15);
      ctx.fill();
      ctx.strokeStyle = badgeCol;
      ctx.lineWidth = 1.5;
      if (isOk) {
        // Checkmark
        ctx.beginPath();
        ctx.moveTo(bx - 3, by);
        ctx.lineTo(bx - 0.5, by + 2.5);
        ctx.lineTo(bx + 3.5, by - 2.5);
        ctx.stroke();
      } else {
        // X mark
        ctx.beginPath();
        ctx.moveTo(bx - 2.5, by - 2.5);
        ctx.lineTo(bx + 2.5, by + 2.5);
        ctx.moveTo(bx + 2.5, by - 2.5);
        ctx.lineTo(bx - 2.5, by + 2.5);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Restore skipped opacity
    if (isSkipped) ctx.restore();

    // Separator line
    ctx.fillStyle = 'rgba(255,255,255,.03)';
    ctx.fillRect(x, y + TITLE_H - 1, w, 1);
  }

  _drawPins(ctx, node, bodyY) {
    const w = node.size[0];
    const x = node.pos[0];
    const hp = this._hoveredPin;
    const isDraggingLink = this._dragging?.type === 'link';
    const dragSlotType = isDraggingLink ? (this._dragging.slot?.type === -1 ? 'exec' : (this._dragging.slot?.type || 'any')) : null;

    ctx.save();
    ctx.font = `500 11px ${FONT}`;
    ctx.textBaseline = 'middle';

    // Output pins (right side)
    if (node.outputs) {
      for (let i = 0; i < node.outputs.length; i++) {
        const slot = node.outputs[i];
        const pinType = slot.type === -1 ? 'exec' : (slot.type || 'any');
        const isExec = pinType === 'exec';
        const py = bodyY + (i + 0.5) * SLOT_H;
        const px = x + w;
        const hasLinks = slot.links && slot.links.length > 0;
        const isHovered = hp && hp.node === node && hp.slotIndex === i && hp.isOutput;
        // During link drag, dim incompatible pins
        const isCompat = isDraggingLink && !this._dragging.isOutput ? isValidConnection(pinType, dragSlotType) : true;
        const dimmed = isDraggingLink && !isCompat;

        ctx.save();
        if (dimmed) ctx.globalAlpha = 0.2;

        if (isExec) {
          drawDiamond(ctx, px, py, isHovered ? DIAMOND_R + 2 : DIAMOND_R);
          if (hasLinks || isHovered) {
            ctx.fillStyle = isHovered ? '#fff' : '#ccc'; ctx.fill();
            if (isHovered) { ctx.shadowColor = '#fff'; ctx.shadowBlur = 8; ctx.fill(); }
          } else { ctx.strokeStyle = '#888'; ctx.lineWidth = 1.5; ctx.stroke(); }
          // Exec label
          const eName = slot.name || '';
          if (eName) {
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#888';
            ctx.globalAlpha = isHovered ? 0.8 : 0.5;
            ctx.textAlign = 'right';
            ctx.fillText(eName, x + w - 12, py);
          }
        } else {
          const pinColor = (PIN_TYPES[pinType] || PIN_TYPES.any).color;
          const r = isHovered ? PIN_R + 2 : PIN_R;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          if (hasLinks || isHovered) {
            if (isHovered) { ctx.shadowColor = pinColor; ctx.shadowBlur = 12; }
            ctx.fillStyle = pinColor; ctx.fill();
            ctx.shadowBlur = 0;
          } else {
            ctx.strokeStyle = hexToRgba(pinColor, 0.6); ctx.lineWidth = 1.5; ctx.stroke();
          }
          // Label: name + type
          const label = slot.name || '';
          if (label) {
            ctx.shadowBlur = 0;
            ctx.fillStyle = pinColor;
            ctx.globalAlpha = isHovered ? 1 : 0.7;
            ctx.textAlign = 'right';
            ctx.fillText(label, x + w - 12, py - 4);
            // Type badge
            ctx.globalAlpha = isHovered ? 0.5 : 0.3;
            ctx.font = `400 9px ${FONT}`;
            ctx.fillText(pinType, x + w - 12, py + 7);
            ctx.font = `500 11px ${FONT}`;
          }
        }
        ctx.restore();
      }
    }

    // Input pins (left side)
    if (node.inputs) {
      for (let i = 0; i < node.inputs.length; i++) {
        const slot = node.inputs[i];
        const pinType = slot.type === -1 ? 'exec' : (slot.type || 'any');
        const isExec = pinType === 'exec';
        const py = bodyY + (i + 0.5) * SLOT_H;
        const px = x;
        const hasLink = slot.link != null;
        const isHovered = hp && hp.node === node && hp.slotIndex === i && !hp.isOutput;
        const isCompat = isDraggingLink && this._dragging.isOutput ? isValidConnection(dragSlotType, pinType) : true;
        const dimmed = isDraggingLink && !isCompat;

        ctx.save();
        if (dimmed) ctx.globalAlpha = 0.2;

        if (isExec) {
          drawDiamond(ctx, px, py, isHovered ? DIAMOND_R + 2 : DIAMOND_R);
          if (hasLink || isHovered) {
            ctx.fillStyle = isHovered ? '#fff' : '#ccc'; ctx.fill();
            if (isHovered) { ctx.shadowColor = '#fff'; ctx.shadowBlur = 8; ctx.fill(); }
          } else { ctx.strokeStyle = '#888'; ctx.lineWidth = 1.5; ctx.stroke(); }
          // Exec label
          const eName = slot.name || '';
          if (eName) {
            ctx.shadowBlur = 0;
            ctx.fillStyle = '#888';
            ctx.globalAlpha = isHovered ? 0.8 : 0.5;
            ctx.textAlign = 'left';
            ctx.fillText(eName, x + 12, py);
          }
        } else {
          const pinColor = (PIN_TYPES[pinType] || PIN_TYPES.any).color;
          const r = isHovered ? PIN_R + 2 : PIN_R;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          if (hasLink || isHovered) {
            if (isHovered) { ctx.shadowColor = pinColor; ctx.shadowBlur = 12; }
            ctx.fillStyle = pinColor; ctx.fill();
            ctx.shadowBlur = 0;
          } else {
            ctx.strokeStyle = hexToRgba(pinColor, 0.6); ctx.lineWidth = 1.5; ctx.stroke();
          }
          // Label: name + type
          const label = slot.name || '';
          if (label) {
            ctx.shadowBlur = 0;
            ctx.fillStyle = pinColor;
            ctx.globalAlpha = isHovered ? 1 : 0.7;
            ctx.textAlign = 'left';
            ctx.fillText(label, x + 12, py - 4);
            // Type badge
            ctx.globalAlpha = isHovered ? 0.5 : 0.3;
            ctx.font = `400 9px ${FONT}`;
            ctx.fillText(pinType, x + 12, py + 7);
            ctx.font = `500 11px ${FONT}`;
          }
        }
        ctx.restore();
      }
    }

    ctx.restore();
  }

  _drawWidgets(ctx, node, bodyY, colors) {
    if (!node.widgets || !node.widgets.length) return;
    if (this._scale < 0.5) return; // hide widgets when zoomed out

    const x = node.pos[0];
    const w = node.size[0];
    const margin = 10;
    const innerW = w - margin * 2;
    const slotArea = Math.max(node.inputs?.length || 0, node.outputs?.length || 0) * SLOT_H;
    let posY = bodyY + slotArea + 4;

    ctx.save();

    for (const widget of node.widgets) {
      if (widget.disabled) ctx.globalAlpha = 0.4;

      // Background pill
      roundRect(ctx, x + margin, posY, innerW, WIDGET_H, 6);
      ctx.fillStyle = '#0c0c0e';
      ctx.fill();
      ctx.strokeStyle = '#1a1a1e';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Label (left)
      ctx.fillStyle = '#555';
      ctx.font = `500 9.5px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(widget.name, x + margin + 8, posY + WIDGET_H * 0.65);

      if (widget.type === 'combo') {
        // Value pill
        const valStr = String(widget.value || '');
        ctx.font = `600 9.5px ${FONT}`;
        const valW = ctx.measureText(valStr).width;
        const pillW = valW + 12;
        const pillX = x + w - margin - pillW - 4;
        const pillY = posY + 3;
        const pillH = WIDGET_H - 6;
        roundRect(ctx, pillX, pillY, pillW, pillH, 4);
        ctx.fillStyle = hexToRgba(colors.accent, 0.1);
        ctx.fill();
        ctx.fillStyle = colors.accent;
        ctx.textAlign = 'center';
        ctx.fillText(valStr, pillX + pillW / 2, posY + WIDGET_H * 0.65);
        // Chevron
        ctx.fillStyle = '#444';
        ctx.font = `8px ${FONT}`;
        ctx.textAlign = 'right';
        ctx.fillText('\u25BE', x + w - margin - 3, posY + WIDGET_H * 0.6);
      } else if (widget.type === 'text' || widget.type === 'string') {
        if (widget.value) {
          let valStr = String(widget.value);
          const maxChars = Math.floor((innerW - 80) / 5.5);
          if (valStr.length > maxChars && maxChars > 3) valStr = valStr.substring(0, maxChars) + '\u2026';
          ctx.fillStyle = '#9a9a9a';
          ctx.font = `10px ${MONO}`;
          ctx.textAlign = 'right';
          ctx.fillText(valStr, x + w - margin - 6, posY + WIDGET_H * 0.65);
        } else {
          ctx.fillStyle = '#333';
          ctx.font = `italic 9px ${FONT}`;
          ctx.textAlign = 'right';
          ctx.fillText('\u2014', x + w - margin - 6, posY + WIDGET_H * 0.65);
        }
      } else if (widget.type === 'toggle') {
        const pillW = 20, pillH = 10;
        const pillX = x + w - margin - pillW - 6;
        const pillY = posY + (WIDGET_H - pillH) / 2;
        roundRect(ctx, pillX, pillY, pillW, pillH, 5);
        ctx.fillStyle = widget.value ? hexToRgba(colors.accent, 0.25) : '#1a1a1e';
        ctx.fill();
        const dotX = widget.value ? pillX + pillW - 5 : pillX + 5;
        ctx.beginPath();
        ctx.arc(dotX, pillY + pillH / 2, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = widget.value ? colors.accent : '#3a3a40';
        ctx.fill();
      }

      if (widget.disabled) ctx.globalAlpha = 1;
      posY += WIDGET_H + 4;
    }

    ctx.restore();
  }

  _drawTestButton(ctx, node, nx, ny, nw) {
    const btnW = 20, btnH = 14;
    const btnX = nx + nw - btnW - 4;
    const btnY = ny + TITLE_H * 0.5 - btnH * 0.5;
    const ts = node._testState || 'idle';

    const btnColor = ts === 'running' ? '#f59e0b' : ts === 'success' ? '#22c55e' : ts === 'error' ? '#ef4444' : 'rgba(255,255,255,0.08)';
    ctx.fillStyle = btnColor;
    ctx.globalAlpha = ts === 'idle' ? 0.7 : 0.9;
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, 3);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.fillStyle = ts === 'idle' ? '#aaa' : '#fff';
    ctx.font = `bold 8px ${FONT}`;
    ctx.textAlign = 'center';
    if (ts === 'running') {
      const t = Math.floor(Date.now() / 300) % 3;
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = i === t ? 1 : 0.3;
        ctx.beginPath();
        ctx.arc(btnX + 5 + i * 5, btnY + btnH * 0.5, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else {
      const icon = ts === 'success' ? '\u2713' : ts === 'error' ? '\u2715' : '\u25B6';
      ctx.fillText(icon, btnX + btnW * 0.5, btnY + btnH * 0.5 + 3);
    }
    ctx.textAlign = 'left';

    // Store bounds for hit testing
    node._testBtnBounds = { x: btnX, y: btnY, w: btnW, h: btnH };
  }

  // ═══ INTERACTION ══════════════════════════════════════════════════════════

  _screenToCanvas(sx, sy) {
    return [(sx - this._offsetX) / this._scale, (sy - this._offsetY) / this._scale];
  }

  _getMousePos(e) {
    const rect = this.canvasElement.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  _hitTestNode(cx, cy) {
    // Iterate in reverse (top-most first)
    for (let i = this._nodes.length - 1; i >= 0; i--) {
      const n = this._nodes[i];
      if (cx >= n.pos[0] && cx <= n.pos[0] + n.size[0] &&
          cy >= n.pos[1] && cy <= n.pos[1] + TITLE_H + n.size[1]) {
        return n;
      }
    }
    return null;
  }

  _hitTestPin(cx, cy) {
    const threshold = 10;
    for (const node of this._nodes) {
      // Check output pins
      if (node.outputs) {
        for (let i = 0; i < node.outputs.length; i++) {
          const [px, py] = this._getOutputPinPos(node, i);
          if (Math.abs(cx - px) < threshold && Math.abs(cy - py) < threshold) {
            return { node, slotIndex: i, isOutput: true, slot: node.outputs[i] };
          }
        }
      }
      // Check input pins
      if (node.inputs) {
        for (let i = 0; i < node.inputs.length; i++) {
          const [px, py] = this._getInputPinPos(node, i);
          if (Math.abs(cx - px) < threshold && Math.abs(cy - py) < threshold) {
            return { node, slotIndex: i, isOutput: false, slot: node.inputs[i] };
          }
        }
      }
    }
    return null;
  }

  _hitTestTestButton(cx, cy) {
    for (const node of this._nodes) {
      const b = node._testBtnBounds;
      if (b && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
        return node;
      }
    }
    return null;
  }

  _hitTestLink(cx, cy) {
    const threshold = 8;
    for (const [, link] of this._links) {
      const srcNode = this._getNodeById(link.origin_id);
      const dstNode = this._getNodeById(link.target_id);
      if (!srcNode || !dstNode) continue;
      const [sx, sy] = this._getOutputPinPos(srcNode, link.origin_slot);
      const [ex, ey] = this._getInputPinPos(dstNode, link.target_slot);
      const dx = Math.abs(ex - sx) * 0.5;
      // Sample ~20 points along the bezier and check distance
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const inv = 1 - t;
        const bx = inv*inv*inv*sx + 3*inv*inv*t*(sx+dx) + 3*inv*t*t*(ex-dx) + t*t*t*ex;
        const by = inv*inv*inv*sy + 3*inv*inv*t*sy      + 3*inv*t*t*ey      + t*t*t*ey;
        const dist = Math.hypot(cx - bx, cy - by);
        if (dist < threshold) return link;
      }
    }
    return null;
  }

  _handleMouseDown(e) {
    const [sx, sy] = this._getMousePos(e);
    const [cx, cy] = this._screenToCanvas(sx, sy);

    // Middle-click or Space+click → pan
    if (e.button === 1) {
      this._dragging = { type: 'pan', startSX: sx, startSY: sy, startOX: this._offsetX, startOY: this._offsetY };
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    // Check test button
    const testNode = this._hitTestTestButton(cx, cy);
    if (testNode) {
      this._runTestNode(testNode);
      return;
    }

    // Check pins first (for link dragging)
    const pin = this._hitTestPin(cx, cy);
    if (pin) {
      const [px, py] = pin.isOutput
        ? this._getOutputPinPos(pin.node, pin.slotIndex)
        : this._getInputPinPos(pin.node, pin.slotIndex);
      this._dragging = {
        type: 'link',
        fromNode: pin.node,
        fromSlot: pin.slotIndex,
        isOutput: pin.isOutput,
        slot: pin.slot,
        startX: px,
        startY: py,
        curX: cx,
        curY: cy,
      };
      return;
    }

    // Check comment resize edges
    const resizeComment = this._hitTestCommentEdge(cx, cy);
    if (resizeComment) {
      this._dragging = {
        type: 'comment-resize', comment: resizeComment,
        startCX: cx, startCY: cy,
        origW: resizeComment.size[0], origH: resizeComment.size[1],
      };
      return;
    }

    // Check comment headers (drag)
    const headerComment = this._hitTestCommentHeader(cx, cy);
    if (headerComment) {
      const contained = new Map();
      for (const n of this._nodes) {
        if (this._isNodeInsideComment(n, headerComment)) {
          contained.set(n.id, [...n.pos]);
        }
      }
      this._dragging = {
        type: 'comment', comment: headerComment,
        startCX: cx, startCY: cy,
        origX: headerComment.pos[0], origY: headerComment.pos[1],
        nodeStarts: contained,
      };
      return;
    }

    // Check nodes
    const node = this._hitTestNode(cx, cy);
    if (node) {
      if (e.shiftKey) {
        this._toggleSelect(node);
      } else if (!this._selectedNodes.has(node.id)) {
        this._selectNode(node, false);
      }
      // Start node drag
      this._dragging = {
        type: 'node',
        startCX: cx,
        startCY: cy,
        nodeStarts: new Map(),
      };
      // Store initial positions of all selected nodes
      for (const id of this._selectedNodes) {
        const n = this._getNodeById(id);
        if (n) this._dragging.nodeStarts.set(id, [...n.pos]);
      }
      // Bring clicked node to top
      const idx = this._nodes.indexOf(node);
      if (idx >= 0) {
        this._nodes.splice(idx, 1);
        this._nodes.push(node);
      }
      this._markDirty();
      return;
    }

    // Click on link → delete it
    const clickedLink = this._hitTestLink(cx, cy);
    if (clickedLink) {
      this._removeLink(clickedLink.id);
      this._hoveredLink = null;
      this._markDirty();
      this._notifyChanged();
      this.pushSnapshot();
      return;
    }

    // Empty space → deselect and start box selection
    this._deselectAll();
    this._dragging = {
      type: 'box',
      startX: cx,
      startY: cy,
      curX: cx,
      curY: cy,
    };
    this._markDirty();
  }

  _handleMouseMove(e) {
    const [sx, sy] = this._getMousePos(e);
    const [cx, cy] = this._screenToCanvas(sx, sy);

    // ── Hover tracking (always) ──
    if (!this._dragging) {
      const oldHover = this._hoveredPin;
      this._hoveredPin = this._hitTestPin(cx, cy);
      // Link hover
      const oldLinkHover = this._hoveredLink;
      this._hoveredLink = !this._hoveredPin ? this._hitTestLink(cx, cy) : null;
      if (oldHover !== this._hoveredPin || oldLinkHover !== this._hoveredLink) this._markDirty();
      // Cursor hint
      if (this.canvasElement) {
        if (this._hoveredPin) this.canvasElement.style.cursor = 'crosshair';
        else if (this._hoveredLink) this.canvasElement.style.cursor = 'pointer';
        else if (this._hitTestNode(cx, cy)) this.canvasElement.style.cursor = 'grab';
        else if (this._hitTestCommentEdge(cx, cy)) this.canvasElement.style.cursor = 'nwse-resize';
        else if (this._hitTestCommentHeader(cx, cy)) this.canvasElement.style.cursor = 'move';
        else this.canvasElement.style.cursor = 'default';
      }
      return;
    }
    const d = this._dragging;

    if (d.type === 'pan') {
      this._offsetX = d.startOX + (sx - d.startSX);
      this._offsetY = d.startOY + (sy - d.startSY);
      this._markDirty();
    } else if (d.type === 'node') {
      const dx = cx - d.startCX;
      const dy = cy - d.startCY;
      for (const [id, startPos] of d.nodeStarts) {
        const n = this._getNodeById(id);
        if (n) {
          n.pos[0] = startPos[0] + dx;
          n.pos[1] = startPos[1] + dy;
        }
      }
      this._markDirty();
    } else if (d.type === 'link') {
      d.curX = cx;
      d.curY = cy;
      // Track hover target during link drag
      this._hoveredPin = this._hitTestPin(cx, cy);
      this._markDirty();
    } else if (d.type === 'comment') {
      const dx = cx - d.startCX;
      const dy = cy - d.startCY;
      d.comment.pos[0] = d.origX + dx;
      d.comment.pos[1] = d.origY + dy;
      // Move contained nodes
      for (const [nId, startPos] of d.nodeStarts) {
        const n = this._getNodeById(nId);
        if (n) { n.pos[0] = startPos[0] + dx; n.pos[1] = startPos[1] + dy; }
      }
      this._markDirty();
    } else if (d.type === 'comment-resize') {
      d.comment.size[0] = Math.max(120, d.origW + (cx - d.startCX));
      d.comment.size[1] = Math.max(60, d.origH + (cy - d.startCY));
      this._markDirty();
    } else if (d.type === 'box') {
      d.curX = cx;
      d.curY = cy;
      // Update selection
      const minX = Math.min(d.startX, cx);
      const minY = Math.min(d.startY, cy);
      const maxX = Math.max(d.startX, cx);
      const maxY = Math.max(d.startY, cy);
      this._selectedNodes.clear();
      for (const n of this._nodes) {
        const inside = n.pos[0] + n.size[0] > minX && n.pos[0] < maxX &&
                       n.pos[1] + TITLE_H + n.size[1] > minY && n.pos[1] < maxY;
        n.is_selected = inside;
        if (inside) this._selectedNodes.add(n.id);
      }
      this._markDirty();
    }
  }

  _handleMouseUp(e) {
    if (!this._dragging) return;
    const d = this._dragging;

    if (d.type === 'node') {
      // Snap to grid
      for (const id of this._selectedNodes) {
        const n = this._getNodeById(id);
        if (n) {
          n.pos[0] = Math.round(n.pos[0] / GRID_SIZE) * GRID_SIZE;
          n.pos[1] = Math.round(n.pos[1] / GRID_SIZE) * GRID_SIZE;
        }
      }
      this.pushSnapshot();
      this._notifyChanged();
    } else if (d.type === 'comment' || d.type === 'comment-resize') {
      this.pushSnapshot();
      this._notifyChanged();
    } else if (d.type === 'link') {
      // Try to connect
      const [sx, sy] = this._getMousePos(e);
      const [cx, cy] = this._screenToCanvas(sx, sy);
      const target = this._hitTestPin(cx, cy);
      if (target && target.isOutput !== d.isOutput) {
        if (d.isOutput) {
          this._addLink(d.fromNode.id, d.fromSlot, target.node.id, target.slotIndex);
        } else {
          this._addLink(target.node.id, target.slotIndex, d.fromNode.id, d.fromSlot);
        }
      }
    } else if (d.type === 'box') {
      if (this._selectedNodes.size > 0 && this.onNodeSelected) {
        const first = this._getNodeById([...this._selectedNodes][0]);
        if (first) this.onNodeSelected(first);
      }
    }

    this._dragging = null;
    this._markDirty();
  }

  _handleWheel(e) {
    e.preventDefault();
    const [sx, sy] = this._getMousePos(e);
    const [cx, cy] = this._screenToCanvas(sx, sy);

    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this._scale * factor));

    // Zoom towards mouse position
    this._offsetX = sx - cx * newScale;
    this._offsetY = sy - cy * newScale;
    this._scale = newScale;
    this._markDirty();
  }

  _handleKeyDown(e) {
    // Only handle if canvas is focused or no other input is focused
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.contentEditable === 'true')) return;
    if (!this.canvasElement) return;
    // Skip if canvas is not visible (e.g. another tab is active, tab-content is display:none)
    if (!this.canvasElement.offsetParent) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      this.deleteSelected();
      e.preventDefault();
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey) this.redo(); else this.undo();
    } else if (e.key === 'y' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.redo();
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.selectAll();
    } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._copySelected();
    } else if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._pasteClipboard();
    } else if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.duplicateSelected();
    }
  }

  _handleDblClick(e) {
    const [sx, sy] = this._getMousePos(e);
    const [cx, cy] = this._screenToCanvas(sx, sy);

    // Double-click on comment header → edit title
    const comment = this._hitTestCommentHeader(cx, cy);
    if (comment) {
      this._showInlineInput(comment.title || '', (val) => {
        comment.title = val;
        this._markDirty();
        this._notifyChanged();
        this.pushSnapshot();
      });
      return;
    }

    const node = this._hitTestNode(cx, cy);
    if (node) {
      this._handleWidgetClick(node, cx, cy);
    }
  }

  _handleWidgetClick(node, cx, cy) {
    if (!node.widgets?.length) return;
    const bodyY = node.pos[1] + TITLE_H;
    const slotArea = Math.max(node.inputs?.length || 0, node.outputs?.length || 0) * SLOT_H;
    let widgetY = bodyY + slotArea + 4;

    for (const widget of node.widgets) {
      if (widget.disabled) { widgetY += WIDGET_H + 4; continue; }
      if (cy >= widgetY && cy <= widgetY + WIDGET_H && cx >= node.pos[0] + 10 && cx <= node.pos[0] + node.size[0] - 10) {
        this._editWidget(node, widget);
        return;
      }
      widgetY += WIDGET_H + 4;
    }
  }

  _editWidget(node, widget) {
    if (widget.type === 'combo') {
      this._showComboDropdown(node, widget);
    } else if (widget.type === 'text' || widget.type === 'string') {
      this._showInlineInput(widget.value || '', (val) => {
        widget.value = val;
        if (widget.key) node.properties[widget.key] = val;
        if (node.type === 'workflow/switch' && widget.key === 'cases') {
          this._rebuildSwitchOutputs(node);
        }
        if (node.type === 'workflow/variable' && widget.key === 'action') {
          this._rebuildVariablePins(node);
        }
        if (node.type === 'workflow/time' && widget.key === 'action') {
          this._rebuildTimeOutputs(node);
        }
        this._markDirty();
        this._notifyChanged();
        this.pushSnapshot();
      }, widget.name);
    } else if (widget.type === 'toggle') {
      widget.value = !widget.value;
      if (widget.key) node.properties[widget.key] = widget.value;
      this._markDirty();
      this._notifyChanged();
      this.pushSnapshot();
    }
  }

  _showComboDropdown(node, widget) {
    const values = widget.options?.values || [];
    if (!values.length) return;

    // Create HTML dropdown overlay
    const container = this.canvasElement.parentElement;
    if (!container) return;

    // Compute screen position of widget
    const bodyY = node.pos[1] + TITLE_H;
    const slotArea = Math.max(node.inputs?.length || 0, node.outputs?.length || 0) * SLOT_H;
    let wY = bodyY + slotArea + 4;
    for (const w of node.widgets) {
      if (w === widget) break;
      wY += WIDGET_H + 4;
    }

    const screenX = node.pos[0] * this._scale + this._offsetX + 10;
    const screenY = wY * this._scale + this._offsetY;

    const dropdown = document.createElement('div');
    dropdown.className = 'wf-engine-dropdown';
    dropdown.style.cssText = `position:absolute;left:${screenX}px;top:${screenY + WIDGET_H * this._scale}px;z-index:9999;
      background:#1a1a1e;border:1px solid #2d2d2d;border-radius:6px;padding:4px 0;min-width:120px;
      box-shadow:0 4px 16px rgba(0,0,0,0.5);max-height:200px;overflow-y:auto;`;

    for (const val of values) {
      const opt = document.createElement('div');
      opt.textContent = val;
      opt.style.cssText = `padding:6px 12px;cursor:pointer;font:500 11px ${FONT};color:${val === widget.value ? '#f59e0b' : '#ccc'};`;
      opt.addEventListener('mouseenter', () => { opt.style.background = '#252525'; });
      opt.addEventListener('mouseleave', () => { opt.style.background = 'none'; });
      opt.addEventListener('click', () => {
        widget.value = val;
        if (widget.key) node.properties[widget.key] = val;
        if (node.type === 'workflow/switch' && widget.key === 'cases') {
          this._rebuildSwitchOutputs(node);
        }
        if (node.type === 'workflow/variable' && widget.key === 'action') {
          this._rebuildVariablePins(node);
        }
        if (node.type === 'workflow/time' && widget.key === 'action') {
          this._rebuildTimeOutputs(node);
        }
        dropdown.remove();
        this._markDirty();
        this._notifyChanged();
        this.pushSnapshot();
      });
      dropdown.appendChild(opt);
    }

    container.appendChild(dropdown);

    // Close on click outside
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
  }

  // ═══ COPY / PASTE ═══════════════════════════════════════════════════════

  _copySelected() {
    if (!this._selectedNodes.size) return;
    const nodeIds = new Set(this._selectedNodes);
    const nodes = this._nodes.filter(n => nodeIds.has(n.id)).map(n => ({
      id: n.id, type: n.type, pos: [...n.pos], size: [...n.size],
      properties: JSON.parse(JSON.stringify(n.properties)),
      widgets_values: n.widgets ? n.widgets.map(w => w.value) : [],
    }));
    // Capture links between selected nodes
    const links = [];
    for (const [, link] of this._links) {
      if (nodeIds.has(link.origin_id) && nodeIds.has(link.target_id)) {
        links.push({ ...link });
      }
    }
    this._clipboard = { nodes, links };
  }

  _pasteClipboard() {
    if (!this._clipboard?.nodes?.length) return;
    const idMap = new Map();
    const newNodes = [];

    this._deselectAll();
    this._historyPaused = true;

    for (const sn of this._clipboard.nodes) {
      const node = this.addNode(sn.type, [sn.pos[0] + 40, sn.pos[1] + 40]);
      if (!node) continue;
      Object.assign(node.properties, JSON.parse(JSON.stringify(sn.properties)));
      for (let i = 0; i < Math.min(sn.widgets_values.length, node.widgets.length); i++) {
        node.widgets[i].value = sn.widgets_values[i];
      }
      if (node.type === 'workflow/switch') this._rebuildSwitchOutputs(node);
      if (node.type === 'workflow/time') this._rebuildTimeOutputs(node);
      idMap.set(sn.id, node.id);
      newNodes.push(node);
    }

    // Recreate links between pasted nodes
    for (const link of this._clipboard.links) {
      const newFrom = idMap.get(link.origin_id);
      const newTo = idMap.get(link.target_id);
      if (newFrom && newTo) this._addLink(newFrom, link.origin_slot, newTo, link.target_slot);
    }

    this._historyPaused = false;
    this._deselectAll();
    for (const n of newNodes) this._selectNode(n, true);
    this._markDirty();
    this._notifyChanged();
    this.pushSnapshot();
  }

  // ═══ CONTEXT MENU ══════════════════════════════════════════════════════

  _handleContextMenu(e) {
    e.preventDefault();
    const [sx, sy] = this._getMousePos(e);
    const [cx, cy] = this._screenToCanvas(sx, sy);

    // Determine what was right-clicked
    const node = this._hitTestNode(cx, cy);
    const comment = this._hitTestCommentHeader(cx, cy) || this._hitTestCommentBody(cx, cy);

    const items = [];

    if (node) {
      // ── Node context menu ──
      items.push({ label: 'Duplicate', icon: '⧉', action: () => {
        this._deselectAll();
        this._selectNode(node, false);
        this.duplicateSelected();
      }});
      items.push({ label: 'Disconnect All', icon: '⊘', action: () => {
        for (const inp of node.inputs) { if (inp.link != null) this._removeLink(inp.link); }
        for (const out of node.outputs) { for (const lid of [...out.links]) this._removeLink(lid); }
        this._markDirty(); this._notifyChanged(); this.pushSnapshot();
      }});
      if (node.removable !== false) {
        items.push({ type: 'sep' });
        items.push({ label: 'Delete', icon: '✕', danger: true, action: () => {
          this._removeNode(node);
          this._selectedNodes.delete(node.id);
          if (this.onNodeDeselected) this.onNodeDeselected();
          this._markDirty(); this._notifyChanged(); this.pushSnapshot();
        }});
      }
    } else if (comment) {
      // ── Comment context menu ──
      items.push({ label: 'Rename', icon: '✎', action: () => {
        this._showInlineInput(comment.title || '', (val) => {
          comment.title = val;
          this._markDirty(); this._notifyChanged(); this.pushSnapshot();
        });
      }});
      items.push({ label: 'Change Color', icon: '●', submenu: [
        { label: 'Orange',  color: '#f59e0b' },
        { label: 'Blue',    color: '#3b82f6' },
        { label: 'Green',   color: '#22c55e' },
        { label: 'Red',     color: '#ef4444' },
        { label: 'Purple',  color: '#a78bfa' },
        { label: 'Cyan',    color: '#22d3ee' },
        { label: 'Pink',    color: '#f472b6' },
        { label: 'Gray',    color: '#6b7280' },
      ].map(c => ({ label: c.label, swatch: c.color, action: () => {
        comment.color = c.color;
        this._markDirty(); this._notifyChanged(); this.pushSnapshot();
      }}))});
      items.push({ type: 'sep' });
      items.push({ label: 'Delete Comment', icon: '✕', danger: true, action: () => {
        this.deleteComment(comment.id);
      }});
    } else {
      // ── Canvas context menu (empty space) ──
      const categories = [
        { label: 'Actions', types: ['claude', 'shell', 'git', 'http', 'notify'] },
        { label: 'Data',    types: ['file', 'db', 'variable', 'transform'] },
        { label: 'Flow',    types: ['condition', 'loop', 'switch', 'wait', 'log', 'subworkflow'] },
      ];
      for (const cat of categories) {
        items.push({ label: cat.label, submenu: cat.types.map(t => {
          const def = NODE_TYPES['workflow/' + t];
          if (!def) return null;
          return { label: def.title, desc: def.desc, action: () => {
            this.addNode('workflow/' + t, [cx, cy]);
          }};
        }).filter(Boolean)});
      }
      items.push({ type: 'sep' });
      items.push({ label: 'Add Comment', icon: '▬', action: () => {
        this.addComment([cx, cy], [300, 200]);
      }});
    }

    this._showContextMenu(e.clientX, e.clientY, items);
  }

  _showInlineInput(currentValue, onConfirm, placeholder) {
    document.querySelectorAll('.wf-inline-input-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'wf-inline-input-overlay';
    overlay.style.cssText = `position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.4);`;

    const box = document.createElement('div');
    box.style.cssText = `background:#1a1a1e;border:1px solid #333;border-radius:10px;padding:16px;min-width:300px;
      box-shadow:0 12px 40px rgba(0,0,0,0.7);`;

    if (placeholder) {
      const label = document.createElement('div');
      label.textContent = placeholder;
      label.style.cssText = `color:#888;font:500 11px ${FONT};margin-bottom:8px;`;
      box.appendChild(label);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentValue;
    input.style.cssText = `width:100%;background:#111;border:1px solid #444;border-radius:6px;padding:8px 10px;
      color:#e0e0e0;font:500 13px ${FONT};outline:none;box-sizing:border-box;`;
    input.addEventListener('focus', () => { input.style.borderColor = '#f59e0b'; });
    input.addEventListener('blur', () => { input.style.borderColor = '#444'; });

    const close = () => overlay.remove();

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = input.value.trim();
        if (val) { close(); onConfirm(val); }
      } else if (e.key === 'Escape') {
        close();
      }
    });

    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });

    box.appendChild(input);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  }

  _hitTestCommentBody(cx, cy) {
    for (let i = this._comments.length - 1; i >= 0; i--) {
      const c = this._comments[i];
      if (cx >= c.pos[0] && cx <= c.pos[0] + c.size[0] &&
          cy >= c.pos[1] && cy <= c.pos[1] + c.size[1]) {
        return c;
      }
    }
    return null;
  }

  _showContextMenu(screenX, screenY, items) {
    // Remove any existing menu
    document.querySelectorAll('.wf-ctx-menu').forEach(el => el.remove());

    const menu = document.createElement('div');
    menu.className = 'wf-ctx-menu';
    menu.style.cssText = `position:fixed;left:${screenX}px;top:${screenY}px;z-index:99999;
      background:#1a1a1e;border:1px solid #333;border-radius:8px;padding:4px 0;min-width:170px;
      box-shadow:0 8px 32px rgba(0,0,0,0.6);font:500 12px ${FONT};`;

    const buildItems = (container, list) => {
      for (const item of list) {
        if (item.type === 'sep') {
          const sep = document.createElement('div');
          sep.style.cssText = 'height:1px;background:#2d2d2d;margin:4px 8px;';
          container.appendChild(sep);
          continue;
        }
        if (item.submenu) {
          // Submenu parent
          const row = document.createElement('div');
          row.style.cssText = `padding:7px 12px;cursor:default;color:#ccc;display:flex;align-items:center;justify-content:space-between;position:relative;`;
          row.innerHTML = `<span>${item.icon ? item.icon + ' ' : ''}${item.label}</span><span style="color:#555;font-size:10px">▸</span>`;
          row.addEventListener('mouseenter', () => {
            row.style.background = '#252525';
            // Show submenu
            let sub = row.querySelector('.wf-ctx-sub');
            if (!sub) {
              sub = document.createElement('div');
              sub.className = 'wf-ctx-sub';
              sub.style.cssText = `position:absolute;left:100%;top:-4px;
                background:#1a1a1e;border:1px solid #333;border-radius:8px;padding:4px 0;min-width:150px;
                box-shadow:0 8px 32px rgba(0,0,0,0.6);`;
              buildItems(sub, item.submenu);
              row.appendChild(sub);
            }
            sub.style.display = 'block';
          });
          row.addEventListener('mouseleave', () => {
            row.style.background = 'none';
            const sub = row.querySelector('.wf-ctx-sub');
            if (sub) sub.style.display = 'none';
          });
          container.appendChild(row);
          continue;
        }

        const row = document.createElement('div');
        const color = item.danger ? '#ef4444' : item.swatch ? item.swatch : '#ccc';
        row.style.cssText = `padding:7px 12px;cursor:pointer;color:${color};display:flex;align-items:center;gap:8px;`;
        let html = '';
        if (item.swatch) {
          html += `<span style="width:10px;height:10px;border-radius:50%;background:${item.swatch};display:inline-block;flex-shrink:0;"></span>`;
        } else if (item.icon) {
          html += `<span style="width:14px;text-align:center;opacity:0.6">${item.icon}</span>`;
        }
        html += `<span>${item.label}</span>`;
        if (item.desc) html += `<span style="color:#555;font-size:10px;margin-left:auto">${item.desc}</span>`;
        row.innerHTML = html;
        row.addEventListener('mouseenter', () => { row.style.background = '#252525'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
        row.addEventListener('click', () => {
          menu.remove();
          document.removeEventListener('mousedown', closeHandler);
          if (item.action) item.action();
        });
        container.appendChild(row);
      }
    };

    buildItems(menu, items);

    // Clamp to viewport
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (screenX - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (screenY - rect.height) + 'px';

    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);
  }

  // ═══ COMMENTS (group zones) ═════════════════════════════════════════════

  addComment(pos, size, title, color) {
    const id = this._nextCommentId++;
    const comment = {
      id,
      pos: pos || [100, 100],
      size: size || [300, 200],
      title: title || 'Comment',
      color: color || '#f59e0b',
    };
    this._comments.push(comment);
    this._markDirty();
    this._notifyChanged();
    this.pushSnapshot();
    return comment;
  }

  deleteComment(commentId) {
    const idx = this._comments.findIndex(c => c.id === commentId);
    if (idx >= 0) {
      this._comments.splice(idx, 1);
      this._markDirty();
      this._notifyChanged();
      this.pushSnapshot();
    }
  }

  getComments() { return this._comments; }

  _isNodeInsideComment(node, comment) {
    const nx = node.pos[0], ny = node.pos[1];
    const cx = comment.pos[0], cy = comment.pos[1];
    return nx >= cx && ny >= cy + 28 &&
           nx + node.size[0] <= cx + comment.size[0] &&
           ny + TITLE_H + node.size[1] <= cy + comment.size[1];
  }

  _hitTestCommentHeader(cx, cy) {
    for (let i = this._comments.length - 1; i >= 0; i--) {
      const c = this._comments[i];
      if (cx >= c.pos[0] && cx <= c.pos[0] + c.size[0] &&
          cy >= c.pos[1] && cy <= c.pos[1] + 28) {
        return c;
      }
    }
    return null;
  }

  _hitTestCommentEdge(cx, cy) {
    const margin = 12;
    for (let i = this._comments.length - 1; i >= 0; i--) {
      const c = this._comments[i];
      const rx = c.pos[0] + c.size[0];
      const ry = c.pos[1] + c.size[1];
      if (Math.abs(cx - rx) < margin && Math.abs(cy - ry) < margin) {
        return c;
      }
    }
    return null;
  }

  _drawComments(ctx) {
    for (const c of this._comments) {
      const x = c.pos[0], y = c.pos[1], w = c.size[0], h = c.size[1];
      const col = c.color || '#f59e0b';

      // Background
      ctx.save();
      roundRect(ctx, x, y, w, h, 6);
      ctx.fillStyle = hexToRgba(col, 0.06);
      ctx.fill();

      // Border
      ctx.strokeStyle = hexToRgba(col, 0.2);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Header bar
      ctx.fillStyle = hexToRgba(col, 0.12);
      ctx.beginPath();
      ctx.moveTo(x + 6, y);
      ctx.lineTo(x + w - 6, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + 6);
      ctx.lineTo(x + w, y + 28);
      ctx.lineTo(x, y + 28);
      ctx.lineTo(x, y + 6);
      ctx.quadraticCurveTo(x, y, x + 6, y);
      ctx.closePath();
      ctx.fill();

      // Title
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.8;
      ctx.font = `600 11px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText(c.title || 'Comment', x + 10, y + 18);
      ctx.globalAlpha = 1;

      // Resize handle (bottom-right)
      ctx.fillStyle = hexToRgba(col, 0.3);
      ctx.beginPath();
      ctx.moveTo(x + w, y + h);
      ctx.lineTo(x + w - 10, y + h);
      ctx.lineTo(x + w, y + h - 10);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }
  }

  // ═══ MINIMAP ════════════════════════════════════════════════════════════

  toggleMinimap() { this._showMinimap = !this._showMinimap; this._markDirty(); }

  _drawMinimap(ctx, vpW, vpH) {
    const mapW = 160, mapH = 100, padding = 12;
    const mapX = vpW - mapW - padding;
    const mapY = vpH - mapH - padding;

    // Compute bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this._nodes) {
      if (n.pos[0] < minX) minX = n.pos[0];
      if (n.pos[1] < minY) minY = n.pos[1];
      if (n.pos[0] + n.size[0] > maxX) maxX = n.pos[0] + n.size[0];
      if (n.pos[1] + n.size[1] + TITLE_H > maxY) maxY = n.pos[1] + n.size[1] + TITLE_H;
    }
    const graphW = maxX - minX + 80;
    const graphH = maxY - minY + 80;
    const sx = mapW / graphW;
    const sy = mapH / graphH;
    const s = Math.min(sx, sy);

    // Background
    ctx.save();
    ctx.globalAlpha = 0.85;
    roundRect(ctx, mapX - 1, mapY - 1, mapW + 2, mapH + 2, 6);
    ctx.fillStyle = '#0d0d0f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Clip to minimap
    ctx.beginPath();
    ctx.rect(mapX, mapY, mapW, mapH);
    ctx.clip();

    const ox = mapX + (mapW - graphW * s) / 2 - (minX - 40) * s;
    const oy = mapY + (mapH - graphH * s) / 2 - (minY - 40) * s;

    // Draw links — single batched stroke
    ctx.strokeStyle = 'rgba(255,255,255,.1)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (const [, link] of this._links) {
      const src = this._nodeMap.get(link.origin_id);
      const dst = this._nodeMap.get(link.target_id);
      if (!src || !dst) continue;
      ctx.moveTo(ox + (src.pos[0] + src.size[0]) * s, oy + (src.pos[1] + TITLE_H * 0.5) * s);
      ctx.lineTo(ox + dst.pos[0] * s, oy + (dst.pos[1] + TITLE_H * 0.5) * s);
    }
    ctx.stroke();

    // Draw nodes
    for (const n of this._nodes) {
      const c = getNodeColors(n);
      const nx = ox + n.pos[0] * s;
      const ny = oy + n.pos[1] * s;
      const nw = Math.max(n.size[0] * s, 3);
      const nh = Math.max((n.size[1] + TITLE_H) * s, 2);
      ctx.fillStyle = n.is_selected ? c.accent : hexToRgba(c.accent, 0.5);
      ctx.fillRect(nx, ny, nw, nh);
    }

    // Draw viewport rectangle
    const vx1 = -this._offsetX / this._scale;
    const vy1 = -this._offsetY / this._scale;
    const vx2 = vx1 + vpW / this._scale;
    const vy2 = vy1 + vpH / this._scale;
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      ox + vx1 * s, oy + vy1 * s,
      (vx2 - vx1) * s, (vy2 - vy1) * s,
    );

    ctx.restore();
  }

  // ═══ TEST NODE ════════════════════════════════════════════════════════════

  _runTestNode(node) {
    if (node._testState === 'running') return;
    const api = window.electron_api;
    if (!api?.workflow?.testNode) return;

    node._testState = 'running';
    node._testResult = null;
    this._animatingCount++;
    this._markDirty();

    const step = { id: `node_${node.id}`, type: (node.type || '').replace('workflow/', ''), ...(node.properties || {}) };
    api.workflow.testNode(step, {}).then(result => {
      this._animatingCount--;
      node._testState = result.success ? 'success' : 'error';
      node._testResult = result;
      this._markDirty();
      setTimeout(() => { node._testState = 'idle'; this._markDirty(); }, 5000);
      if (result.success && result.output) this.setNodeOutput(node.id, result.output);
    }).catch(err => {
      this._animatingCount--;
      node._testState = 'error';
      node._testResult = { success: false, error: err.message };
      this._markDirty();
      setTimeout(() => { node._testState = 'idle'; this._markDirty(); }, 5000);
    });
  }

  // ═══ COMPATIBILITY SHIMS ══════════════════════════════════════════════════

  _createGraphShim() {
    const engine = this;
    return {
      get _nodes() { return engine._nodes; },
      get links() {
        // Return as object keyed by linkId for compat
        const obj = {};
        for (const [id, link] of engine._links) obj[id] = link;
        return obj;
      },
      getNodeById(id) { return engine._getNodeById(id); },
      serialize() { return engine._serialize(); },
      configure(data) { engine._configure(data); },
      add(node) { engine._nodes.push(node); engine._markDirty(); },
      remove(node) { engine._removeNode(node); engine._markDirty(); },
      removeLink(linkId) { engine._removeLink(linkId); engine._markDirty(); },
      clear() { engine._nodes = []; engine._links.clear(); engine._selectedNodes.clear(); },
      setDirtyCanvas() { engine._markDirty(); },
      getNodes() { return engine._nodes; },
    };
  }

  _createCanvasShim() {
    const engine = this;
    return {
      ds: {
        get scale() { return engine._scale; },
        set scale(v) { engine._scale = v; },
        get offset() { return [engine._offsetX, engine._offsetY]; },
        set offset(v) { if (Array.isArray(v)) { engine._offsetX = v[0]; engine._offsetY = v[1]; } },
        get min_scale() { return MIN_ZOOM; },
        get max_scale() { return MAX_ZOOM; },
        reset() { engine._scale = 1; engine._offsetX = 0; engine._offsetY = 0; },
        convertOffsetToCanvas(pos) { return engine.graphToScreen(pos[0], pos[1]); },
      },
      get selected_nodes() {
        const obj = {};
        for (const id of engine._selectedNodes) {
          const n = engine._getNodeById(id);
          if (n) obj[id] = n;
        }
        return obj;
      },
      selectNode(node) { engine._selectNode(node, false); },
      selectNodes(nodes) {
        engine._deselectAll();
        for (const n of (nodes || [])) { n.is_selected = true; engine._selectedNodes.add(n.id); }
        if (nodes?.length && engine.onNodeSelected) engine.onNodeSelected(nodes[0]);
      },
      deselectAllNodes() { engine._deselectAll(); },
      setDirty() { engine._markDirty(); },
      setDirtyCanvas() { engine._markDirty(); },
      resize(w, h) { engine.resize(w, h); },
      get node_dragged() { return engine._dragging?.type === 'node'; },
      _rebuildSwitchOutputs(node) { engine._rebuildSwitchOutputs(node); },
      _rebuildTimeOutputs(node) { engine._rebuildTimeOutputs(node); },
    };
  }
}

// ═══ SINGLETON ══════════════════════════════════════════════════════════════

let instance = null;

function getGraphService() {
  if (!instance) instance = new WorkflowGraphEngine();
  if (typeof window !== 'undefined') window._workflowGraphService = instance;
  return instance;
}

function resetGraphService() {
  if (instance) instance.destroy();
  instance = null;
}

module.exports = {
  getGraphService,
  resetGraphService,
  WorkflowGraphEngine,
  NODE_COLORS,
};
