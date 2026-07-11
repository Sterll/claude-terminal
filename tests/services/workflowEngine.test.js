// Regression tests for the WorkflowRunner graph engine.
// Builds mini graphs by hand ({nodes, links}) and drives execute().
//
// Link format (LiteGraph): [linkId, originId, originSlot, targetId, targetSlot, type]
// Exec links use type -1. Slot 0 = exec In / Done, slot 1 = Error (or loop Done).

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });

// git utils are required at module load — stub them out.
jest.mock('../../src/main/utils/git', () => ({
  gitCommit: jest.fn(), gitPull: jest.fn(), gitPush: jest.fn(),
  gitStageFiles: jest.fn(), checkoutBranch: jest.fn(),
  createBranch: jest.fn(), spawnGit: jest.fn(),
}));

const WorkflowRunner = require('../../src/main/services/WorkflowRunner');

// ── helpers ──────────────────────────────────────────────────────────────────

const EXEC = -1;

function makeRunner(sendFn = () => {}) {
  return new WorkflowRunner({
    sendFn,
    chatService: null,
    waitCallbacks: new Map(),
    projectTypeRegistry: {},
    databaseService: null,
    workflowService: null,
  });
}

// A trigger node (exec-only) with a single Start output on slot 0.
function triggerNode(id = 1) {
  return {
    id,
    type: 'workflow/trigger',
    properties: {},
    inputs: [],
    outputs: [{ name: 'Start', type: 'exec', links: [] }],
  };
}

// Generic exec node: In(0) + optional Error(1) on inputs, Done(0) + Error(1) outputs.
function execNode(id, type, properties = {}) {
  return {
    id,
    type: `workflow/${type}`,
    properties,
    inputs: [{ name: 'In', type: 'exec', link: null }],
    outputs: [
      { name: 'Done', type: 'exec', links: [] },
      { name: 'Error', type: 'exec', links: [] },
    ],
  };
}

let _linkId = 100;
function execLink(originId, originSlot, targetId, targetSlot = 0) {
  return [_linkId++, originId, originSlot, targetId, targetSlot, EXEC];
}

function makeRun(overrides = {}) {
  return {
    id: 'run_test',
    trigger: 'manual',
    triggerData: {},
    projectPath: '',
    ...overrides,
  };
}

beforeEach(() => { _linkId = 100; jest.clearAllMocks(); });

// ── Loop custom source regression ─────────────────────────────────────────────

describe('loop node with custom source reads step.items', () => {
  test('produces one iteration per newline item and follows Done path', async () => {
    const sent = [];
    const runner = makeRunner((ch, data) => sent.push({ ch, data }));

    // trigger -> loop(custom, items="a\nb\nc")
    //   loop Each(slot0) -> log
    //   loop Done(slot1) -> log(final)
    const trigger = triggerNode(1);
    const loop = {
      id: 2,
      type: 'workflow/loop',
      properties: { source: 'custom', items: 'a\nb\nc' },
      inputs: [
        { name: 'In', type: 'exec', link: null },
        { name: 'items', type: 'any', link: null },
      ],
      outputs: [
        { name: 'Each', type: 'exec', links: [] },
        { name: 'Done', type: 'exec', links: [] },
      ],
    };
    const bodyLog  = execNode(3, 'log', { message: 'iter $index' });
    const finalLog = execNode(4, 'log', { message: 'loop finished' });

    const graph = {
      nodes: [trigger, loop, bodyLog, finalLog],
      links: [
        execLink(1, 0, 2, 0),  // trigger -> loop In
        execLink(2, 0, 3, 0),  // loop Each -> bodyLog
        execLink(2, 1, 4, 0),  // loop Done -> finalLog
      ],
    };

    const workflow = { graph };
    const result = await runner.execute(workflow, makeRun(), new AbortController());

    expect(result.success).toBe(true);

    // The loop output records 3 items.
    const loopOut = result.outputs['node_2'];
    expect(loopOut).toBeTruthy();
    expect(loopOut.count).toBe(3);
    expect(loopOut.items).toHaveLength(3);

    // Body log ran (3 iterations, but node_3 output overwritten each time) and
    // the Done continuation (node_4) ran once.
    expect(result.outputs['node_4']).toBeTruthy();
    expect(result.outputs['node_4'].logged).toBe(true);
  });

  test('empty custom items yields zero iterations but still completes', async () => {
    const runner = makeRunner();
    const trigger = triggerNode(1);
    const loop = {
      id: 2,
      type: 'workflow/loop',
      properties: { source: 'custom', items: '' },
      inputs: [
        { name: 'In', type: 'exec', link: null },
        { name: 'items', type: 'any', link: null },
      ],
      outputs: [
        { name: 'Each', type: 'exec', links: [] },
        { name: 'Done', type: 'exec', links: [] },
      ],
    };
    const finalLog = execNode(3, 'log', { message: 'done' });
    const graph = {
      nodes: [trigger, loop, finalLog],
      links: [execLink(1, 0, 2, 0), execLink(2, 1, 3, 0)],
    };

    const result = await runner.execute({ graph }, makeRun(), new AbortController());
    expect(result.success).toBe(true);
    expect(result.outputs['node_2'].count).toBe(0);
    expect(result.outputs['node_3']).toBeTruthy();
  });
});

// ── Error-slot handling regression ────────────────────────────────────────────

describe('error slot handling', () => {
  test('unhandled throw fails the run', async () => {
    const runner = makeRunner();
    const trigger = triggerNode(1);
    // variable node with no name throws inside run()
    const bad = execNode(2, 'variable', { action: 'set', name: '', value: 'x' });
    const graph = {
      nodes: [trigger, bad],
      links: [execLink(1, 0, 2, 0)],
    };
    const result = await runner.execute({ graph }, makeRun(), new AbortController());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no name specified/i);
  });

  test('throw with Error slot connected does NOT fail the run', async () => {
    const runner = makeRunner();
    const trigger = triggerNode(1);
    const bad     = execNode(2, 'variable', { action: 'set', name: '', value: 'x' });
    const handler = execNode(3, 'log', { message: 'handled' });
    const graph = {
      nodes: [trigger, bad, handler],
      links: [
        execLink(1, 0, 2, 0), // trigger -> bad
        execLink(2, 1, 3, 0), // bad Error(slot 1) -> handler
      ],
    };
    const result = await runner.execute({ graph }, makeRun(), new AbortController());
    // Error slot wired = handled by design → run succeeds (not degraded).
    expect(result.success).toBe(true);
    // The failing node was recorded as caught, and the handler ran.
    expect(result.outputs['node_2'].caught).toBe(true);
    expect(result.outputs['node_3']).toBeTruthy();
    expect(result.outputs['node_3'].logged).toBe(true);
  });
});

// ── Fan-in / join barrier regression ──────────────────────────────────────────

describe('fan-in join barrier', () => {
  test('a node with two exec predecessors runs exactly once, after both', async () => {
    const executionOrder = [];
    const runner = makeRunner((ch, data) => {
      if (ch === 'workflow-step-update' && data.status === 'success') {
        executionOrder.push(data.stepId);
      }
    });

    // trigger -> A ; trigger -> B ; A -> C ; B -> C  (diamond join at C)
    const trigger = triggerNode(1);
    const A = execNode(2, 'log', { message: 'A' });
    const B = execNode(3, 'log', { message: 'B' });
    const C = execNode(4, 'log', { message: 'C' });

    // C must accept two exec inputs on slot 0.
    C.inputs = [{ name: 'In', type: 'exec', link: null }];

    const graph = {
      nodes: [trigger, A, B, C],
      links: [
        execLink(1, 0, 2, 0), // trigger -> A
        execLink(1, 0, 3, 0), // trigger -> B
        execLink(2, 0, 4, 0), // A -> C
        execLink(3, 0, 4, 0), // B -> C
      ],
    };

    const result = await runner.execute({ graph }, makeRun(), new AbortController());
    expect(result.success).toBe(true);

    // C ran exactly once.
    const cRuns = executionOrder.filter(id => id === 'node_4');
    expect(cRuns).toHaveLength(1);

    // C ran only after both A and B.
    const idxA = executionOrder.indexOf('node_2');
    const idxB = executionOrder.indexOf('node_3');
    const idxC = executionOrder.indexOf('node_4');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });
});

// ── testStep on simple registry nodes ─────────────────────────────────────────

describe('testStep dispatches simple nodes via the registry', () => {
  test('log node returns logged output', async () => {
    const runner = makeRunner();
    const out = await runner.testStep({ id: 'n', type: 'log', level: 'info', message: 'hi $ctx.trigger' });
    expect(out.success).toBe(true);
    expect(out.output.logged).toBe(true);
    expect(out.output.message).toContain('test'); // ctx.trigger === 'test'
  });

  test('variable set node stores and returns the value', async () => {
    const runner = makeRunner();
    const out = await runner.testStep({ id: 'n', type: 'variable', action: 'set', name: 'foo', value: 'bar' });
    expect(out.success).toBe(true);
    expect(out.output.value).toBe('bar');
    expect(out.output.action).toBe('set');
  });

  test('transform map operation runs', async () => {
    const runner = makeRunner();
    const out = await runner.testStep({
      id: 'n', type: 'transform', operation: 'map',
      input: '$nums', expression: 'item * 2',
    }, {});
    // $nums is not defined in test ctx → input null → empty array → result []
    expect(out.success).toBe(true);
    expect(Array.isArray(out.output.result)).toBe(true);
  });

  test('variable node with missing name reports failure', async () => {
    const runner = makeRunner();
    const out = await runner.testStep({ id: 'n', type: 'variable', action: 'set', name: '' });
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/no name specified/i);
  });
});
