// The parallel tasks board used to be drawn only on run-state changes, and a
// project with no run produces none: the screen stayed blank. Opening the tab
// must show the empty state on its own.

jest.mock('../../src/renderer/state/parallelTask.state', () => ({
  parallelTaskState: { subscribe: jest.fn(() => () => {}) },
  getRuns: jest.fn(() => []),
  getRunById: jest.fn(() => null),
  addRun: jest.fn(),
  removeRun: jest.fn(),
  initParallelListeners: jest.fn(),
}));
jest.mock('../../src/renderer/services/ModelCatalogClient', () => ({ get: jest.fn(() => ({})), subscribe: jest.fn() }));

const ParallelTaskPanel = require('../../src/renderer/ui/panels/ParallelTaskPanel');

test('opening the tab with no run shows the empty state', async () => {
  document.body.innerHTML = '<div id="tab-tasks"></div>';
  ParallelTaskPanel.init({
    api: { parallel: { getHistory: jest.fn(async () => ({ success: true, runs: [] })) } },
    projectsState: { get: () => ({ projects: [{ path: '/p' }], selectedProjectFilter: 0 }) },
  });
  await ParallelTaskPanel.load();
  await new Promise(resolve => setTimeout(resolve, 0));

  expect(document.querySelector('#pt-runs-list .pt-empty-runs')).not.toBeNull();
  expect(document.getElementById('pt-empty-new-run')).not.toBeNull();
});
