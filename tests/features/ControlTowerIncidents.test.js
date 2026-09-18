const { collectIncidents, mount } = require('../../src/renderer/ui/components/ControlTowerIncidents');
test('shows current failures and sync conflicts, clears recovered workflows and ignores deleted definitions', () => {
  const workflows = [{ id: 'recovered', name: 'Recovered' }, { id: 'failed', name: 'Failed' }];
  const runs = [{ workflowId: 'recovered', status: 'success' }, { workflowId: 'recovered', status: 'failed' }, { workflowId: 'failed', id: 'run', status: 'failed', error: 'oops' }, { workflowId: 'deleted', status: 'failed' }];
  const triggers = [{ workflowId: 'failed', status: 'error', error: 'watch limit' }, { workflowId: 'recovered', status: 'ready' }];
  expect(collectIncidents(workflows, runs, triggers, [{ entityType: 'settings' }]).map(item => item.kind)).toEqual(['trigger', 'run', 'sync']);
});
test('unmount unsubscribes and ignores an outstanding refresh', async () => {
  const previous = window.electron_api; let complete;
  const unsubscribe = jest.fn();
  window.electron_api = { workflow: {
    list: () => new Promise(resolve => { complete = resolve; }), getRecentRuns: async () => ({ success: true, runs: [] }),
    getTriggerStatuses: async () => [], onRunEnd: () => unsubscribe,
  } };
  const host = document.createElement('section'); host.textContent = 'unchanged';
  const cleanup = mount(host); cleanup(); complete({ success: true, workflows: [] });
  await Promise.resolve(); await Promise.resolve();
  expect(unsubscribe).toHaveBeenCalledTimes(1); expect(host.textContent).toBe('unchanged');
  window.electron_api = previous;
});
