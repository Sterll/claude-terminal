/**
 * accounts-remove refuses an account an automation still names.
 *
 * An automation pinned to a deleted account fails on its next run, unattended.
 * The check lives in main because the renderer only loads the workflow list
 * once the Workflows tab has been opened.
 */

const mockAccountManager = {
  listAccounts: jest.fn(async () => ({ accounts: [], defaultId: null, liveId: null })),
  removeAccount: jest.fn(async (id) => ({ removed: id })),
};
const mockWorkflows = [];

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}));
jest.mock('../../src/main/services/AccountManager', () => mockAccountManager);
jest.mock('../../src/main/services/UsageService', () => ({ invalidateCredentials: jest.fn() }));
jest.mock('../../src/main/services/WorkflowStorage', () => ({ loadWorkflows: jest.fn(async () => mockWorkflows) }));

const { ipcMain } = require('electron');
const { compileTask } = require('../../src/shared/simple-task');

function loadHandlers() {
  const handlers = {};
  ipcMain.handle.mockImplementation((channel, handler) => { handlers[channel] = handler; });
  require('../../src/main/ipc/accounts.ipc').registerAccountsHandlers();
  return handlers;
}

beforeEach(() => {
  mockWorkflows.length = 0;
  mockAccountManager.removeAccount.mockClear();
});

test('an account an automation names is not removed, and the automations are listed', async () => {
  mockWorkflows.push(
    { id: 'wf-1', ...compileTask({ name: 'Daily recap', simple: { prompt: 'x', account: 'acc-work' } }) },
    { id: 'wf-2', name: 'Graph', graph: { nodes: [{ id: 2, type: 'workflow/claude', properties: { account: 'acc-work' } }] } },
    { id: 'wf-3', ...compileTask({ name: 'Other', simple: { prompt: 'x', account: 'acc-perso' } }) },
  );
  const res = await loadHandlers()['accounts-remove'](null, { id: 'acc-work' });
  expect(res).toMatchObject({ success: false, code: 'ACCOUNT_USED_BY_AUTOMATIONS', automations: ['Daily recap', 'Graph'] });
  expect(mockAccountManager.removeAccount).not.toHaveBeenCalled();
});

test('an account no automation names is removed as before', async () => {
  mockWorkflows.push({ id: 'wf-1', ...compileTask({ name: 'Default', simple: { prompt: 'x', account: '' } }) });
  const res = await loadHandlers()['accounts-remove'](null, { id: 'acc-work' });
  expect(res.success).toBe(true);
  expect(mockAccountManager.removeAccount).toHaveBeenCalledWith('acc-work');
});

test('the read-only check answers before any confirmation, and removes nothing', async () => {
  mockWorkflows.push({ id: 'wf-1', ...compileTask({ name: 'Daily recap', simple: { prompt: 'x', account: 'acc-work' } }) });
  const handlers = loadHandlers();
  expect(await handlers['accounts-automations'](null, { id: 'acc-work' })).toEqual({ success: true, data: ['Daily recap'] });
  expect(await handlers['accounts-automations'](null, { id: 'acc-perso' })).toEqual({ success: true, data: [] });
  expect(mockAccountManager.removeAccount).not.toHaveBeenCalled();
});
