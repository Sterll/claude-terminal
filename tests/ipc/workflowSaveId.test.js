/**
 * workflow-save id validation.
 *
 * The handler used to require a non-empty string id, which rejected every
 * creation path: the graph editor omits the id and reads res.id back, and so
 * does the Automations sheet. Storage assigns the id — the handler's job is
 * only to refuse a malformed one.
 */

const mockHandlers = new Map();
const mockSaved = [];

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => mockHandlers.set(channel, fn),
    on:     (channel, fn) => mockHandlers.set(channel, fn),
  },
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' },
  BrowserWindow: { getAllWindows: () => [] },
}), { virtual: true });

// Only saveWorkflow matters here; a Proxy answers every other method the
// handler registration touches without listing them all.
jest.mock('../../src/main/services/WorkflowService', () => new Proxy({
  saveWorkflow: async (wf) => {
    mockSaved.push(wf);
    return { success: true, id: wf.id || 'wf_assigned' };
  },
}, {
  get: (target, prop) => (prop in target ? target[prop] : () => {}),
}));

const { registerWorkflowHandlers } = require('../../src/main/ipc/workflow.ipc');

beforeAll(() => registerWorkflowHandlers({ send: () => {} }));
beforeEach(() => { mockSaved.length = 0; });

const save = (workflow) => mockHandlers.get('workflow-save')(null, { workflow });

describe('workflow-save', () => {
  it('accepts a workflow with no id — that is a create', async () => {
    const res = await save({ name: 'New task', steps: [] });
    expect(res.success).toBe(true);
    expect(mockSaved).toHaveLength(1);
  });

  it('returns the id storage assigned so the caller can adopt it', async () => {
    const res = await save({ name: 'New task', steps: [] });
    expect(typeof res.id).toBe('string');
    expect(res.id.length).toBeGreaterThan(0);
  });

  it('accepts a workflow with an existing id — that is an update', async () => {
    const res = await save({ id: 'wf_abc123', name: 'Existing', steps: [] });
    expect(res.success).toBe(true);
    expect(mockSaved[0].id).toBe('wf_abc123');
  });

  it('still rejects a malformed id rather than letting garbage through', async () => {
    for (const id of ['', '   ', 42, null, {}, []]) {
      const res = await save({ id, name: 'Bad', steps: [] });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/non-empty string/);
    }
    expect(mockSaved).toHaveLength(0);
  });

  it('still rejects a non-object payload', async () => {
    for (const wf of [null, undefined, 'nope', 7, []]) {
      const res = await save(wf);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/expected an object/);
    }
  });
});
