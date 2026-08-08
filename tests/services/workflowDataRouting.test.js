/**
 * Data-link routing regressions.
 *
 * A data link carries a slot INDEX. Resolving that index back to a key of the
 * origin node's output used to go through NODE_DATA_OUTPUTS alone, which broke
 * whenever a node built its pins dynamically or exposed more outputs than the
 * table declared. WorkflowRunner._outputKeyForSlot now trusts the pin name
 * stored in the graph first.
 *
 * Link format: [linkId, originId, originSlot, targetId, targetSlot, type]
 */

jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
}), { virtual: true });

jest.mock('../../src/main/utils/git', () => ({
  gitCommit: jest.fn(), gitPull: jest.fn(), gitPush: jest.fn(),
  gitStageFiles: jest.fn(), checkoutBranch: jest.fn(),
  createBranch: jest.fn(), spawnGit: jest.fn(),
}));

const WorkflowRunner = require('../../src/main/services/WorkflowRunner');

const EXEC = -1;

function makeRunner() {
  return new WorkflowRunner({
    sendFn: () => {}, chatService: null, waitCallbacks: new Map(),
    projectTypeRegistry: {}, databaseService: null, workflowService: null,
  });
}

describe('_outputKeyForSlot', () => {
  const runner = makeRunner();

  it('reads the pin name stored in the graph', () => {
    const node = {
      type: 'workflow/db',
      outputs: [
        { name: 'Done', type: EXEC }, { name: 'Error', type: EXEC },
        { name: 'rows', type: 'array' }, { name: 'firstRow', type: 'object' },
        { name: 'rowCount', type: 'number' },
      ],
    };
    const out = { rows: [{ id: 1 }], firstRow: { id: 1 }, rowCount: 1 };
    expect(runner._outputKeyForSlot(node, 3, out)).toBe('firstRow');
    expect(runner._outputKeyForSlot(node, 4, out)).toBe('rowCount');
  });

  it('resolves pins the shared slot table does not cover', () => {
    // shell exposes timedOut/truncated/killed beyond the classic three.
    const node = {
      type: 'workflow/shell',
      outputs: [
        { name: 'Done', type: EXEC }, { name: 'Error', type: EXEC },
        { name: 'stdout', type: 'string' }, { name: 'stderr', type: 'string' },
        { name: 'exitCode', type: 'number' }, { name: 'timedOut', type: 'boolean' },
      ],
    };
    const out = { stdout: 'x', stderr: '', exitCode: 0, timedOut: true };
    expect(runner._outputKeyForSlot(node, 5, out)).toBe('timedOut');
  });

  it('resolves a node that dropped its exec pins (variable in get mode)', () => {
    // In `get` mode the variable node removes its exec pins, so `value` sits at
    // slot 0 while NODE_DATA_OUT_OFFSET.variable is 1.
    const node = { type: 'workflow/variable', outputs: [{ name: 'value', type: 'any' }] };
    expect(runner._outputKeyForSlot(node, 0, { value: 42 })).toBe('value');
  });

  it('falls back to the shared table when the pin name is not an output key', () => {
    const node = {
      type: 'workflow/claude',
      outputs: [
        { name: 'Done', type: EXEC }, { name: 'Error', type: EXEC },
        { name: 'output', type: 'string' },
      ],
    };
    expect(runner._outputKeyForSlot(node, 2, { output: 'hi', success: true })).toBe('output');
  });

  it('returns null for an unmapped slot so the whole object is passed', () => {
    const node = { type: 'workflow/notify', outputs: [{ name: 'Done', type: EXEC }] };
    expect(runner._outputKeyForSlot(node, 9, { sent: true })).toBeNull();
  });

  it('does not crash on a node with no outputs array', () => {
    expect(runner._outputKeyForSlot({ type: 'workflow/log' }, 0, { logged: true })).toBeNull();
    expect(runner._outputKeyForSlot(undefined, 0, {})).toBeNull();
  });
});

describe('end-to-end data link', () => {
  /** variable(get) --value--> log(message), the shape that used to break. */
  function graph() {
    return {
      nodes: [
        {
          id: 1, type: 'workflow/trigger', properties: {},
          inputs: [], outputs: [{ name: 'Start', type: EXEC, links: [1] }],
        },
        {
          id: 2, type: 'workflow/variable',
          properties: { action: 'get', name: 'greeting' },
          inputs: [],
          outputs: [{ name: 'value', type: 'any', links: [2] }],
        },
        {
          id: 3, type: 'workflow/log',
          properties: { level: 'info', message: '' },
          inputs: [
            { name: 'In', type: EXEC, link: 1 },
            { name: 'message', type: 'string', link: 2 },
          ],
          outputs: [{ name: 'Done', type: EXEC, links: [] }],
        },
      ],
      links: [
        [1, 1, 0, 3, 0, EXEC],
        [2, 2, 0, 3, 1, 'any'],
      ],
    };
  }

  it('passes the variable value, not the wrapper object', async () => {
    const runner = makeRunner();
    const run = { id: 'r1', workflowId: 'wf', status: 'running', steps: [], triggerData: {} };
    const vars = new Map([['greeting', 'hello world']]);

    const result = await runner.execute({ id: 'wf', name: 'wf', graph: graph() }, run,
      new AbortController(), vars);

    expect(result.success).toBe(true);
    const logged = result.outputs.node_3;
    expect(logged.message).toBe('hello world');
    // Before the fix this was the whole {value: ...} object.
    expect(typeof logged.message).toBe('string');
  });
});
