/**
 * Round-trip regression tests for the renderer graph engine.
 *
 * The editor keeps its own hardcoded NODE_TYPES table, separate from the
 * main-process .node.js registry. These tests pin down what happens to a saved
 * graph containing a node type the editor table does not know about.
 *
 * @jest-environment jsdom
 */

jest.mock('../../src/renderer/i18n', () => ({
  t: (k) => k,
  onLanguageChange: () => {},
  getCurrentLanguage: () => 'en',
}));

// In the app the renderer pulls the node registry over IPC
// (`workflow:get-node-registry`). Serve the real main-process definitions
// synchronously so the fallback path is exercised the same way it is in
// production instead of silently resolving to an empty registry.
jest.mock('../../src/renderer/services/NodeRegistry', () => {
  const mainRegistry = require('../../src/main/workflow-nodes/_registry');
  mainRegistry.loadRegistry();
  return {
    loadNodeRegistry: async () => mainRegistry.getAll(),
    get: (type) => mainRegistry.get(type),
    getAll: () => mainRegistry.getAll(),
    has: (type) => mainRegistry.has(type),
  };
});

const { getGraphService, resetGraphService } = require('../../src/renderer/services/WorkflowGraphEngine');

const EXEC = -1;

/** trigger -> <type> -> log, saved-graph shape. */
function graphWith(middleType) {
  return {
    nodes: [
      {
        id: 1, type: 'workflow/trigger', pos: [0, 0], size: [200, 60],
        properties: { triggerType: 'manual', triggerValue: '' },
        inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [1] }], flags: {},
      },
      {
        id: 2, type: middleType, pos: [300, 0], size: [200, 100],
        properties: { _customTitle: 'middle' },
        inputs: [{ name: 'In', type: EXEC, link: 1 }],
        outputs: [{ name: 'Done', type: EXEC, links: [2] }], flags: {},
      },
      {
        id: 3, type: 'workflow/log', pos: [600, 0], size: [200, 100],
        properties: { level: 'info', message: 'done' },
        inputs: [{ name: 'In', type: EXEC, link: 2 }],
        outputs: [{ name: 'Done', type: EXEC, links: [] }], flags: {},
      },
    ],
    links: [
      [1, 1, 0, 2, 0, EXEC],
      [2, 2, 0, 3, 0, EXEC],
    ],
    comments: [], last_node_id: 3, last_link_id: 2,
  };
}

function roundTrip(middleType) {
  resetGraphService();
  const gs = getGraphService();
  gs.loadFromWorkflow({ graph: graphWith(middleType) });
  return gs.serializeToWorkflow();
}

describe('graph round-trip through the editor', () => {
  afterEach(() => resetGraphService());

  it('preserves a node type the editor knows about', () => {
    const out = roundTrip('workflow/shell');
    expect(out.graph.nodes.map(n => n.type)).toEqual([
      'workflow/trigger', 'workflow/shell', 'workflow/log',
    ]);
    expect(out.graph.links).toHaveLength(2);
  });

  // These 8 types ship a .node.js in the main registry and execute fine, but
  // are absent from the editor's hardcoded NODE_TYPES table.
  const REGISTRY_ONLY = [
    'error_handler', 'kanban_create_card', 'notify_discord', 'parallel_spawn',
    'retry', 'session_recap', 'webhook', 'workspace_write_doc',
  ];

  it.each(REGISTRY_ONLY)('preserves registry-only node type %s', (type) => {
    const out = roundTrip(`workflow/${type}`);
    const types = out.graph.nodes.map(n => n.type);

    expect(types).toContain(`workflow/${type}`);
    // The surrounding chain must survive intact too.
    expect(types).toEqual(['workflow/trigger', `workflow/${type}`, 'workflow/log']);
    expect(out.graph.links).toHaveLength(2);
  });
});
