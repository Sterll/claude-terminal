/**
 * Slot parity between the two pin builders.
 *
 * Pins for the same node are constructed from two different sources:
 *   - the canvas, from NODE_DATA_OUTPUTS  (WorkflowGraphEngine.addDataOutputDefs)
 *   - the MCP graph builder, from def.outputs (mcp-servers/tools/workflow.js getNodeSlots)
 * and the runner maps slot -> key through the same table.
 *
 * A saved link is just a slot index, so if the two orders diverge the same link
 * means different things on each side and the wrong value is routed with no
 * error. This test is the guard rail: it failed on `db`, `file`, `shell`,
 * `transform`, `subworkflow`, `claude` and `http` before they were aligned.
 */

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });

const registry = require('../../src/main/workflow-nodes/_registry');
const {
  NODE_DATA_OUTPUTS, NODE_DATA_OUT_OFFSET, DYNAMIC_PIN_NODES, getOutputKeyForSlot,
} = require('../../src/shared/workflow-schema');

registry.loadRegistry();

/** Split a node's outputs into leading exec pins and trailing data pins. */
function splitOutputs(def) {
  const outputs = def.outputs || [];
  let exec = 0;
  for (const o of outputs) {
    if (o.type === 'exec') exec++;
    else break;
  }
  return { exec, data: outputs.slice(exec) };
}

const allDefs = registry.getAll()
  .map(def => ({ def, type: def.type.replace('workflow/', '') }))
  .sort((a, b) => a.type.localeCompare(b.type));

const staticDefs = allDefs.filter(({ type }) => !DYNAMIC_PIN_NODES.has(type));

describe('node registry loads', () => {
  it('exposes every .node.js file', () => {
    expect(allDefs.length).toBeGreaterThanOrEqual(27);
  });
});

describe.each(staticDefs.map(d => [d.type, d.def]))('%s', (type, def) => {
  const { exec, data } = splitOutputs(def);

  it('declares its data pins in NODE_DATA_OUTPUTS, in the same order', () => {
    if (!data.length) {
      expect(NODE_DATA_OUTPUTS[type]).toBeUndefined();
      return;
    }
    expect(NODE_DATA_OUTPUTS[type]).toBeDefined();
    expect(NODE_DATA_OUTPUTS[type].map(d => d.name)).toEqual(data.map(d => d.name));
  });

  it('declares matching pin types', () => {
    if (!data.length) return;
    expect(NODE_DATA_OUTPUTS[type].map(d => d.type)).toEqual(data.map(d => d.type));
  });

  it('has an offset equal to its leading exec-pin count', () => {
    if (!data.length) return;
    expect(NODE_DATA_OUT_OFFSET[type]).toBe(exec);
  });

  it('round-trips every data slot back to its own key', () => {
    if (!data.length) return;
    NODE_DATA_OUTPUTS[type].forEach((d, i) => {
      expect(getOutputKeyForSlot(type, exec + i)).toBe(d.key);
    });
  });
});

describe('schema table hygiene', () => {
  const known = new Set(allDefs.map(d => d.type));

  it('has no NODE_DATA_OUTPUTS entry without a node file', () => {
    expect(Object.keys(NODE_DATA_OUTPUTS).filter(t => !known.has(t))).toEqual([]);
  });

  it('has no NODE_DATA_OUT_OFFSET entry without a node file', () => {
    expect(Object.keys(NODE_DATA_OUT_OFFSET).filter(t => !known.has(t))).toEqual([]);
  });

  it('gives every declared data output a key', () => {
    for (const [type, outs] of Object.entries(NODE_DATA_OUTPUTS)) {
      for (const o of outs) {
        expect(typeof o.key).toBe('string');
        expect(o.key.length).toBeGreaterThan(0);
        expect(typeof o.name).toBe('string');
        expect(typeof o.type).toBe('string');
      }
      // A table entry with no offset can never be resolved.
      expect(NODE_DATA_OUT_OFFSET[type] ?? (DYNAMIC_PIN_NODES.has(type) ? 0 : undefined))
        .toBeDefined();
    }
  });
});

describe('structural sanity of every node', () => {
  it.each(allDefs.map(d => [d.type, d.def]))('%s is wired up', (type, def) => {
    expect(def.title).toBeTruthy();
    expect(def.category).toBeTruthy();

    // trigger is the entry point (never executed as a step); get_variable is a
    // pure data source resolved inline by WorkflowRunner._resolvePureDataNode,
    // so neither carries a run() nor an exec input.
    const NO_RUN = new Set(['trigger', 'get_variable']);
    if (!NO_RUN.has(type)) {
      expect(typeof def.run).toBe('function');
      expect((def.inputs || []).some(i => i.type === 'exec')).toBe(true);
    }
  });
});
