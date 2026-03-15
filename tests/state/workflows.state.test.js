const {
  workflowsState,
  getWorkflows,
  setWorkflows,
  getWorkflow,
  upsertWorkflow,
  removeWorkflow,
  updateWorkflowEnabled,
  getRuns,
  setRuns,
  getRunsForWorkflow,
  prependRun,
  patchRun,
  patchRunStep,
  getActiveRuns,
  addActiveRun,
  removeActiveRun,
  getSelectedId,
  setSelectedId,
  getSelectedRunId,
  setSelectedRunId,
} = require('../../src/renderer/state/workflows.state');

function resetState() {
  workflowsState.reset({
    workflows: [],
    runs: [],
    activeRuns: [],
    selectedId: null,
    selectedRunId: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetState();
});

// ── Initial State ──

describe('initial state', () => {
  test('workflows is an empty array', () => {
    expect(getWorkflows()).toEqual([]);
  });

  test('runs is an empty array', () => {
    expect(getRuns()).toEqual([]);
  });

  test('activeRuns is an empty array', () => {
    expect(getActiveRuns()).toEqual([]);
  });

  test('selectedId is null', () => {
    expect(getSelectedId()).toBeNull();
  });

  test('selectedRunId is null', () => {
    expect(getSelectedRunId()).toBeNull();
  });
});

// ── Workflows CRUD ──

describe('getWorkflows / setWorkflows', () => {
  test('setWorkflows replaces all workflows', () => {
    const wfs = [
      { id: 'wf1', name: 'Build', enabled: true },
      { id: 'wf2', name: 'Deploy', enabled: false }
    ];
    setWorkflows(wfs);
    expect(getWorkflows()).toHaveLength(2);
    expect(getWorkflows()[0].name).toBe('Build');
  });

  test('setWorkflows with empty array clears all', () => {
    setWorkflows([{ id: 'wf1', name: 'Test' }]);
    setWorkflows([]);
    expect(getWorkflows()).toHaveLength(0);
  });
});

describe('getWorkflow', () => {
  test('returns workflow by ID', () => {
    setWorkflows([{ id: 'wf1', name: 'Build' }]);
    expect(getWorkflow('wf1')).toEqual({ id: 'wf1', name: 'Build' });
  });

  test('returns null for non-existent ID', () => {
    expect(getWorkflow('nonexistent')).toBeNull();
  });
});

describe('upsertWorkflow', () => {
  test('adds new workflow if ID not found', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build', enabled: true });
    expect(getWorkflows()).toHaveLength(1);
    expect(getWorkflow('wf1').name).toBe('Build');
  });

  test('updates existing workflow if ID matches', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build', enabled: true });
    upsertWorkflow({ id: 'wf1', name: 'Build v2', enabled: false });
    expect(getWorkflows()).toHaveLength(1);
    expect(getWorkflow('wf1').name).toBe('Build v2');
    expect(getWorkflow('wf1').enabled).toBe(false);
  });

  test('does not affect other workflows', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build' });
    upsertWorkflow({ id: 'wf2', name: 'Deploy' });
    upsertWorkflow({ id: 'wf1', name: 'Build Updated' });
    expect(getWorkflows()).toHaveLength(2);
    expect(getWorkflow('wf2').name).toBe('Deploy');
  });
});

describe('removeWorkflow', () => {
  test('removes workflow by ID', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build' });
    removeWorkflow('wf1');
    expect(getWorkflows()).toHaveLength(0);
  });

  test('does nothing for non-existent ID', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build' });
    removeWorkflow('nonexistent');
    expect(getWorkflows()).toHaveLength(1);
  });

  test('only removes matching workflow', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build' });
    upsertWorkflow({ id: 'wf2', name: 'Deploy' });
    removeWorkflow('wf1');
    expect(getWorkflows()).toHaveLength(1);
    expect(getWorkflow('wf2').name).toBe('Deploy');
  });
});

describe('updateWorkflowEnabled', () => {
  test('enables a workflow', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build', enabled: false });
    updateWorkflowEnabled('wf1', true);
    expect(getWorkflow('wf1').enabled).toBe(true);
  });

  test('disables a workflow', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build', enabled: true });
    updateWorkflowEnabled('wf1', false);
    expect(getWorkflow('wf1').enabled).toBe(false);
  });
});

// ── Run History ──

describe('getRuns / setRuns', () => {
  test('setRuns replaces all runs', () => {
    const runs = [
      { id: 'r1', workflowId: 'wf1', status: 'success' },
      { id: 'r2', workflowId: 'wf1', status: 'failed' }
    ];
    setRuns(runs);
    expect(getRuns()).toHaveLength(2);
  });

  test('setRuns with empty array clears all', () => {
    setRuns([{ id: 'r1', workflowId: 'wf1' }]);
    setRuns([]);
    expect(getRuns()).toHaveLength(0);
  });
});

describe('getRunsForWorkflow', () => {
  test('filters runs by workflow ID', () => {
    setRuns([
      { id: 'r1', workflowId: 'wf1', status: 'success' },
      { id: 'r2', workflowId: 'wf2', status: 'success' },
      { id: 'r3', workflowId: 'wf1', status: 'failed' }
    ]);
    const runs = getRunsForWorkflow('wf1');
    expect(runs).toHaveLength(2);
    expect(runs.every(r => r.workflowId === 'wf1')).toBe(true);
  });

  test('returns empty array for unknown workflow', () => {
    expect(getRunsForWorkflow('nonexistent')).toEqual([]);
  });
});

describe('prependRun', () => {
  test('adds run at the beginning', () => {
    setRuns([{ id: 'r1', workflowId: 'wf1' }]);
    prependRun({ id: 'r2', workflowId: 'wf1' });
    const runs = getRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe('r2');
    expect(runs[1].id).toBe('r1');
  });

  test('caps runs at 200', () => {
    const initial = Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`, workflowId: 'wf1'
    }));
    setRuns(initial);
    prependRun({ id: 'new', workflowId: 'wf1' });
    const runs = getRuns();
    expect(runs).toHaveLength(200);
    expect(runs[0].id).toBe('new');
    // Last original run should be dropped
    expect(runs.find(r => r.id === 'r199')).toBeUndefined();
  });
});

describe('patchRun', () => {
  test('updates run by ID', () => {
    setRuns([{ id: 'r1', workflowId: 'wf1', status: 'running' }]);
    patchRun('r1', { status: 'success', duration: 5000 });
    const run = getRuns().find(r => r.id === 'r1');
    expect(run.status).toBe('success');
    expect(run.duration).toBe(5000);
  });

  test('preserves existing properties', () => {
    setRuns([{ id: 'r1', workflowId: 'wf1', status: 'running' }]);
    patchRun('r1', { status: 'success' });
    expect(getRuns()[0].workflowId).toBe('wf1');
  });

  test('does not affect other runs', () => {
    setRuns([
      { id: 'r1', workflowId: 'wf1', status: 'running' },
      { id: 'r2', workflowId: 'wf1', status: 'pending' }
    ]);
    patchRun('r1', { status: 'success' });
    expect(getRuns().find(r => r.id === 'r2').status).toBe('pending');
  });

  test('patching non-existent run leaves state unchanged', () => {
    setRuns([{ id: 'r1', workflowId: 'wf1' }]);
    patchRun('nonexistent', { status: 'failed' });
    expect(getRuns()).toHaveLength(1);
  });
});

describe('patchRunStep', () => {
  test('updates a step within a run', () => {
    setRuns([{
      id: 'r1',
      workflowId: 'wf1',
      steps: [
        { id: 's1', status: 'pending', output: null },
        { id: 's2', status: 'pending', output: null }
      ]
    }]);
    patchRunStep('r1', 's1', { status: 'success', output: 'done' });
    const run = getRuns().find(r => r.id === 'r1');
    expect(run.steps[0].status).toBe('success');
    expect(run.steps[0].output).toBe('done');
    expect(run.steps[1].status).toBe('pending');
  });

  test('preserves step properties not in patch', () => {
    setRuns([{
      id: 'r1', workflowId: 'wf1',
      steps: [{ id: 's1', status: 'running', command: 'npm test' }]
    }]);
    patchRunStep('r1', 's1', { status: 'success' });
    expect(getRuns()[0].steps[0].command).toBe('npm test');
  });

  test('patching non-existent step leaves run unchanged', () => {
    setRuns([{
      id: 'r1', workflowId: 'wf1',
      steps: [{ id: 's1', status: 'pending' }]
    }]);
    patchRunStep('r1', 'nonexistent', { status: 'failed' });
    expect(getRuns()[0].steps[0].status).toBe('pending');
  });

  test('handles run without steps array', () => {
    setRuns([{ id: 'r1', workflowId: 'wf1' }]);
    patchRunStep('r1', 's1', { status: 'success' });
    // Should not throw; steps treated as empty
    expect(getRuns()[0].steps).toEqual([]);
  });
});

// ── Active Runs ──

describe('active runs', () => {
  test('addActiveRun adds to list', () => {
    addActiveRun({ id: 'r1', workflowId: 'wf1' });
    expect(getActiveRuns()).toHaveLength(1);
    expect(getActiveRuns()[0].id).toBe('r1');
  });

  test('multiple active runs', () => {
    addActiveRun({ id: 'r1', workflowId: 'wf1' });
    addActiveRun({ id: 'r2', workflowId: 'wf2' });
    expect(getActiveRuns()).toHaveLength(2);
  });

  test('removeActiveRun removes by ID', () => {
    addActiveRun({ id: 'r1', workflowId: 'wf1' });
    addActiveRun({ id: 'r2', workflowId: 'wf2' });
    removeActiveRun('r1');
    expect(getActiveRuns()).toHaveLength(1);
    expect(getActiveRuns()[0].id).toBe('r2');
  });

  test('removing non-existent active run is safe', () => {
    addActiveRun({ id: 'r1', workflowId: 'wf1' });
    removeActiveRun('nonexistent');
    expect(getActiveRuns()).toHaveLength(1);
  });
});

// ── Selection ──

describe('selection', () => {
  test('getSelectedId returns null by default', () => {
    expect(getSelectedId()).toBeNull();
  });

  test('setSelectedId sets selection', () => {
    setSelectedId('wf1');
    expect(getSelectedId()).toBe('wf1');
  });

  test('setSelectedId with null clears', () => {
    setSelectedId('wf1');
    setSelectedId(null);
    expect(getSelectedId()).toBeNull();
  });

  test('getSelectedRunId returns null by default', () => {
    expect(getSelectedRunId()).toBeNull();
  });

  test('setSelectedRunId sets selection', () => {
    setSelectedRunId('r1');
    expect(getSelectedRunId()).toBe('r1');
  });

  test('setSelectedRunId with null clears', () => {
    setSelectedRunId('r1');
    setSelectedRunId(null);
    expect(getSelectedRunId()).toBeNull();
  });
});

// ── Subscription notifications ──

describe('subscription notifications', () => {
  test('notifies on workflow add', async () => {
    const listener = jest.fn();
    workflowsState.subscribe(listener);
    upsertWorkflow({ id: 'wf1', name: 'Build' });
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies on run prepend', async () => {
    const listener = jest.fn();
    workflowsState.subscribe(listener);
    prependRun({ id: 'r1', workflowId: 'wf1' });
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies on selection change', async () => {
    const listener = jest.fn();
    workflowsState.subscribe(listener);
    setSelectedId('wf1');
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('unsubscribe stops notifications', async () => {
    const listener = jest.fn();
    const unsub = workflowsState.subscribe(listener);
    unsub();
    upsertWorkflow({ id: 'wf1', name: 'Test' });
    await new Promise(r => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── Batch updates ──

describe('batch updates', () => {
  test('multiple rapid changes result in single notification', async () => {
    const listener = jest.fn();
    workflowsState.subscribe(listener);
    upsertWorkflow({ id: 'wf1', name: 'Build' });
    prependRun({ id: 'r1', workflowId: 'wf1' });
    setSelectedId('wf1');
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── Reset ──

describe('reset', () => {
  test('clears all state', () => {
    upsertWorkflow({ id: 'wf1', name: 'Build' });
    prependRun({ id: 'r1', workflowId: 'wf1' });
    addActiveRun({ id: 'r1', workflowId: 'wf1' });
    setSelectedId('wf1');
    setSelectedRunId('r1');

    resetState();

    expect(getWorkflows()).toEqual([]);
    expect(getRuns()).toEqual([]);
    expect(getActiveRuns()).toEqual([]);
    expect(getSelectedId()).toBeNull();
    expect(getSelectedRunId()).toBeNull();
  });
});
