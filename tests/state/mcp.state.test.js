const {
  mcpState,
  getMcps,
  getMcp,
  setMcps,
  addMcp,
  updateMcp,
  removeMcp,
  getMcpProcess,
  setMcpProcessStatus,
  addMcpLog,
  clearMcpLogs,
  getSelectedMcp,
  setSelectedMcp,
  isMcpLogsCollapsed,
  toggleMcpLogsCollapsed,
  initMcpProcess
} = require('../../src/renderer/state/mcp.state');

function resetState() {
  mcpState.reset({
    mcps: [],
    mcpProcesses: {},
    selectedMcp: null,
    mcpLogsCollapsed: false
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetState();
});

// ── Initial State ──

describe('initial state', () => {
  test('mcps is an empty array', () => {
    expect(getMcps()).toEqual([]);
  });

  test('selectedMcp is null', () => {
    expect(getSelectedMcp()).toBeNull();
  });

  test('mcpLogsCollapsed is false', () => {
    expect(isMcpLogsCollapsed()).toBe(false);
  });
});

// ── getMcps / setMcps ──

describe('getMcps / setMcps', () => {
  test('setMcps replaces all MCPs', () => {
    const mcps = [
      { id: 'mcp1', name: 'Server 1', command: 'node server.js' },
      { id: 'mcp2', name: 'Server 2', command: 'python server.py' }
    ];
    setMcps(mcps);
    expect(getMcps()).toHaveLength(2);
    expect(getMcps()[0].name).toBe('Server 1');
  });

  test('setMcps with empty array clears all', () => {
    setMcps([{ id: 'mcp1', name: 'Test' }]);
    setMcps([]);
    expect(getMcps()).toHaveLength(0);
  });
});

// ── getMcp ──

describe('getMcp', () => {
  test('returns MCP by ID', () => {
    setMcps([{ id: 'mcp1', name: 'Server 1' }]);
    expect(getMcp('mcp1')).toEqual({ id: 'mcp1', name: 'Server 1' });
  });

  test('returns undefined for non-existent ID', () => {
    expect(getMcp('nonexistent')).toBeUndefined();
  });
});

// ── addMcp ──

describe('addMcp', () => {
  test('adds an MCP to the list', () => {
    addMcp({ id: 'mcp1', name: 'Server 1', command: 'node server.js' });
    expect(getMcps()).toHaveLength(1);
    expect(getMcps()[0].id).toBe('mcp1');
  });

  test('appends to existing MCPs', () => {
    addMcp({ id: 'mcp1', name: 'First' });
    addMcp({ id: 'mcp2', name: 'Second' });
    expect(getMcps()).toHaveLength(2);
    expect(getMcps()[1].name).toBe('Second');
  });
});

// ── updateMcp ──

describe('updateMcp', () => {
  test('updates MCP properties', () => {
    addMcp({ id: 'mcp1', name: 'Old', command: 'old-cmd' });
    updateMcp('mcp1', { name: 'New', command: 'new-cmd' });
    expect(getMcp('mcp1').name).toBe('New');
    expect(getMcp('mcp1').command).toBe('new-cmd');
  });

  test('preserves properties not in updates', () => {
    addMcp({ id: 'mcp1', name: 'Server', command: 'cmd', env: { KEY: 'val' } });
    updateMcp('mcp1', { name: 'Updated' });
    expect(getMcp('mcp1').command).toBe('cmd');
    expect(getMcp('mcp1').env).toEqual({ KEY: 'val' });
  });

  test('does not affect other MCPs', () => {
    addMcp({ id: 'mcp1', name: 'First' });
    addMcp({ id: 'mcp2', name: 'Second' });
    updateMcp('mcp1', { name: 'Updated' });
    expect(getMcp('mcp2').name).toBe('Second');
  });

  test('updating non-existent MCP has no effect', () => {
    addMcp({ id: 'mcp1', name: 'Test' });
    updateMcp('nonexistent', { name: 'Ghost' });
    expect(getMcps()).toHaveLength(1);
    expect(getMcp('mcp1').name).toBe('Test');
  });
});

// ── removeMcp ──

describe('removeMcp', () => {
  test('removes MCP from list', () => {
    addMcp({ id: 'mcp1', name: 'Server' });
    removeMcp('mcp1');
    expect(getMcps()).toHaveLength(0);
  });

  test('cleans up process state', () => {
    addMcp({ id: 'mcp1', name: 'Server' });
    setMcpProcessStatus('mcp1', 'running');
    removeMcp('mcp1');
    // Process should be cleaned up - getMcpProcess returns default
    expect(getMcpProcess('mcp1')).toEqual({ status: 'stopped', logs: [] });
  });

  test('clears selectedMcp if removed MCP was selected', () => {
    addMcp({ id: 'mcp1', name: 'Server' });
    setSelectedMcp('mcp1');
    removeMcp('mcp1');
    expect(getSelectedMcp()).toBeNull();
  });

  test('does not affect selectedMcp if removed MCP was not selected', () => {
    addMcp({ id: 'mcp1', name: 'First' });
    addMcp({ id: 'mcp2', name: 'Second' });
    setSelectedMcp('mcp2');
    removeMcp('mcp1');
    expect(getSelectedMcp()).toBe('mcp2');
  });

  test('removing non-existent MCP is safe', () => {
    addMcp({ id: 'mcp1', name: 'Test' });
    removeMcp('nonexistent');
    expect(getMcps()).toHaveLength(1);
  });
});

// ── Process Status ──

describe('getMcpProcess', () => {
  test('returns default for unknown process', () => {
    expect(getMcpProcess('unknown')).toEqual({ status: 'stopped', logs: [] });
  });

  test('returns stored process state', () => {
    setMcpProcessStatus('mcp1', 'running');
    expect(getMcpProcess('mcp1').status).toBe('running');
  });
});

describe('setMcpProcessStatus', () => {
  test('sets status for new process', () => {
    setMcpProcessStatus('mcp1', 'starting');
    expect(getMcpProcess('mcp1').status).toBe('starting');
    expect(getMcpProcess('mcp1').logs).toEqual([]);
  });

  test('updates status for existing process', () => {
    setMcpProcessStatus('mcp1', 'starting');
    setMcpProcessStatus('mcp1', 'running');
    expect(getMcpProcess('mcp1').status).toBe('running');
  });

  test('preserves logs when updating status', () => {
    setMcpProcessStatus('mcp1', 'running');
    addMcpLog('mcp1', 'stdout', 'Hello');
    setMcpProcessStatus('mcp1', 'error');
    expect(getMcpProcess('mcp1').logs).toHaveLength(1);
    expect(getMcpProcess('mcp1').status).toBe('error');
  });

  test('supports all status values', () => {
    const statuses = ['stopped', 'starting', 'running', 'error'];
    statuses.forEach((s, i) => {
      setMcpProcessStatus(`mcp${i}`, s);
      expect(getMcpProcess(`mcp${i}`).status).toBe(s);
    });
  });
});

describe('initMcpProcess', () => {
  test('initializes process with stopped status', () => {
    initMcpProcess('mcp1');
    expect(getMcpProcess('mcp1')).toEqual({ status: 'stopped', logs: [] });
  });

  test('does not overwrite existing process', () => {
    setMcpProcessStatus('mcp1', 'running');
    addMcpLog('mcp1', 'stdout', 'test');
    initMcpProcess('mcp1');
    expect(getMcpProcess('mcp1').status).toBe('running');
    expect(getMcpProcess('mcp1').logs).toHaveLength(1);
  });
});

// ── Logs ──

describe('addMcpLog', () => {
  test('adds log entry with timestamp', () => {
    addMcpLog('mcp1', 'stdout', 'Hello World');
    const logs = getMcpProcess('mcp1').logs;
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('stdout');
    expect(logs[0].message).toBe('Hello World');
    expect(typeof logs[0].timestamp).toBe('number');
  });

  test('creates process entry if not exists', () => {
    addMcpLog('mcp1', 'stderr', 'Error');
    expect(getMcpProcess('mcp1').status).toBe('stopped');
    expect(getMcpProcess('mcp1').logs).toHaveLength(1);
  });

  test('appends multiple logs', () => {
    addMcpLog('mcp1', 'stdout', 'Line 1');
    addMcpLog('mcp1', 'stdout', 'Line 2');
    addMcpLog('mcp1', 'stderr', 'Error');
    expect(getMcpProcess('mcp1').logs).toHaveLength(3);
  });

  test('caps logs at 1000 entries', () => {
    for (let i = 0; i < 1005; i++) {
      addMcpLog('mcp1', 'stdout', `Line ${i}`);
    }
    const logs = getMcpProcess('mcp1').logs;
    expect(logs).toHaveLength(1000);
    // The earliest logs should have been removed
    expect(logs[0].message).toBe('Line 5');
    expect(logs[999].message).toBe('Line 1004');
  });

  test('supports info log type', () => {
    addMcpLog('mcp1', 'info', 'Started');
    expect(getMcpProcess('mcp1').logs[0].type).toBe('info');
  });
});

describe('clearMcpLogs', () => {
  test('clears logs for a process', () => {
    addMcpLog('mcp1', 'stdout', 'Line 1');
    addMcpLog('mcp1', 'stdout', 'Line 2');
    clearMcpLogs('mcp1');
    expect(getMcpProcess('mcp1').logs).toEqual([]);
  });

  test('preserves process status', () => {
    setMcpProcessStatus('mcp1', 'running');
    addMcpLog('mcp1', 'stdout', 'test');
    clearMcpLogs('mcp1');
    expect(getMcpProcess('mcp1').status).toBe('running');
  });

  test('does nothing for non-existent process', () => {
    clearMcpLogs('nonexistent');
    // Should not throw, default process stays as default
    expect(getMcpProcess('nonexistent')).toEqual({ status: 'stopped', logs: [] });
  });
});

// ── Selected MCP ──

describe('selectedMcp', () => {
  test('getSelectedMcp returns null by default', () => {
    expect(getSelectedMcp()).toBeNull();
  });

  test('setSelectedMcp sets the selection', () => {
    setSelectedMcp('mcp1');
    expect(getSelectedMcp()).toBe('mcp1');
  });

  test('setSelectedMcp with null clears selection', () => {
    setSelectedMcp('mcp1');
    setSelectedMcp(null);
    expect(getSelectedMcp()).toBeNull();
  });
});

// ── Logs Collapsed ──

describe('logs collapsed', () => {
  test('isMcpLogsCollapsed returns false by default', () => {
    expect(isMcpLogsCollapsed()).toBe(false);
  });

  test('toggleMcpLogsCollapsed toggles to true', () => {
    toggleMcpLogsCollapsed();
    expect(isMcpLogsCollapsed()).toBe(true);
  });

  test('toggleMcpLogsCollapsed toggles back to false', () => {
    toggleMcpLogsCollapsed();
    toggleMcpLogsCollapsed();
    expect(isMcpLogsCollapsed()).toBe(false);
  });
});

// ── Subscription notifications ──

describe('subscription notifications', () => {
  test('notifies on addMcp', async () => {
    const listener = jest.fn();
    mcpState.subscribe(listener);
    addMcp({ id: 'mcp1', name: 'Server' });
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies on removeMcp', async () => {
    addMcp({ id: 'mcp1', name: 'Server' });
    const listener = jest.fn();
    mcpState.subscribe(listener);
    removeMcp('mcp1');
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies on setMcpProcessStatus', async () => {
    const listener = jest.fn();
    mcpState.subscribe(listener);
    setMcpProcessStatus('mcp1', 'running');
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies on addMcpLog', async () => {
    const listener = jest.fn();
    mcpState.subscribe(listener);
    addMcpLog('mcp1', 'stdout', 'test');
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('unsubscribe stops notifications', async () => {
    const listener = jest.fn();
    const unsub = mcpState.subscribe(listener);
    unsub();
    addMcp({ id: 'mcp1', name: 'Test' });
    await new Promise(r => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── Batch updates ──

describe('batch updates', () => {
  test('multiple rapid changes result in single notification', async () => {
    const listener = jest.fn();
    mcpState.subscribe(listener);
    addMcp({ id: 'mcp1', name: 'S1' });
    addMcp({ id: 'mcp2', name: 'S2' });
    setSelectedMcp('mcp1');
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── Reset ──

describe('reset', () => {
  test('clears all state', () => {
    addMcp({ id: 'mcp1', name: 'Server' });
    setMcpProcessStatus('mcp1', 'running');
    addMcpLog('mcp1', 'stdout', 'test');
    setSelectedMcp('mcp1');
    toggleMcpLogsCollapsed();

    resetState();

    expect(getMcps()).toEqual([]);
    expect(getMcpProcess('mcp1')).toEqual({ status: 'stopped', logs: [] });
    expect(getSelectedMcp()).toBeNull();
    expect(isMcpLogsCollapsed()).toBe(false);
  });
});
