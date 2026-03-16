const {
  terminalsState,
  getTerminals,
  getTerminal,
  getActiveTerminal,
  addTerminal,
  updateTerminal,
  removeTerminal,
  setActiveTerminal,
  setDetailTerminal,
  getDetailTerminal,
  countTerminalsForProject,
  getTerminalStatsForProject,
  getTerminalsForProject,
  killTerminalsForProject,
  clearAllTerminals
} = require('../../src/renderer/state/terminals.state');

function resetState() {
  terminalsState.reset({
    terminals: new Map(),
    activeTerminal: null,
    detailTerminal: null
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetState();
});

// ── Initial State ──

describe('initial state', () => {
  test('terminals is an empty Map', () => {
    expect(getTerminals()).toBeInstanceOf(Map);
    expect(getTerminals().size).toBe(0);
  });

  test('activeTerminal is null', () => {
    expect(getActiveTerminal()).toBeNull();
  });

  test('detailTerminal is null', () => {
    expect(getDetailTerminal()).toBeNull();
  });
});

// ── addTerminal ──

describe('addTerminal', () => {
  test('adds terminal to the map', () => {
    addTerminal(1, { projectIndex: 0, type: 'claude', status: 'idle' });
    expect(getTerminals().size).toBe(1);
    expect(getTerminal(1)).toEqual({ projectIndex: 0, type: 'claude', status: 'idle' });
  });

  test('sets added terminal as active', () => {
    addTerminal(1, { projectIndex: 0 });
    expect(getActiveTerminal()).toBe(1);
  });

  test('adding second terminal makes it active', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 0 });
    expect(getActiveTerminal()).toBe(2);
  });

  test('supports different terminal types', () => {
    addTerminal(1, { projectIndex: 0, type: 'claude' });
    addTerminal(2, { projectIndex: 0, type: 'fivem' });
    addTerminal(3, { projectIndex: 0, type: 'webapp' });
    expect(getTerminal(1).type).toBe('claude');
    expect(getTerminal(2).type).toBe('fivem');
    expect(getTerminal(3).type).toBe('webapp');
  });
});

// ── getTerminal ──

describe('getTerminal', () => {
  test('returns terminal by ID', () => {
    addTerminal(42, { projectIndex: 1, name: 'test' });
    expect(getTerminal(42)).toEqual(expect.objectContaining({ projectIndex: 1, name: 'test' }));
  });

  test('returns undefined for non-existent terminal', () => {
    expect(getTerminal(999)).toBeUndefined();
  });
});

// ── updateTerminal ──

describe('updateTerminal', () => {
  test('updates terminal properties', () => {
    addTerminal(1, { projectIndex: 0, status: 'idle', name: 'Term 1' });
    updateTerminal(1, { status: 'working', name: 'Updated' });
    const term = getTerminal(1);
    expect(term.status).toBe('working');
    expect(term.name).toBe('Updated');
  });

  test('does nothing for non-existent terminal', () => {
    updateTerminal(999, { status: 'working' });
    expect(getTerminals().size).toBe(0);
  });

  test('preserves existing properties not in updates', () => {
    addTerminal(1, { projectIndex: 0, status: 'idle', type: 'claude' });
    updateTerminal(1, { status: 'working' });
    expect(getTerminal(1).type).toBe('claude');
    expect(getTerminal(1).projectIndex).toBe(0);
  });
});

// ── removeTerminal ──

describe('removeTerminal', () => {
  test('removes terminal from map', () => {
    addTerminal(1, { projectIndex: 0 });
    removeTerminal(1);
    expect(getTerminals().size).toBe(0);
    expect(getTerminal(1)).toBeUndefined();
  });

  test('sets active to last remaining if active was removed', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 0 });
    addTerminal(3, { projectIndex: 0 });
    // active is 3
    removeTerminal(3);
    // Should be last remaining: 2
    expect(getActiveTerminal()).toBe(2);
  });

  test('sets active to null when all removed', () => {
    addTerminal(1, { projectIndex: 0 });
    removeTerminal(1);
    expect(getActiveTerminal()).toBeNull();
  });

  test('does not change active when removing non-active terminal', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 0 });
    setActiveTerminal(2);
    removeTerminal(1);
    expect(getActiveTerminal()).toBe(2);
  });

  test('removing non-existent terminal is safe', () => {
    addTerminal(1, { projectIndex: 0 });
    removeTerminal(999);
    expect(getTerminals().size).toBe(1);
  });
});

// ── setActiveTerminal ──

describe('setActiveTerminal', () => {
  test('sets active terminal ID', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 0 });
    setActiveTerminal(1);
    expect(getActiveTerminal()).toBe(1);
  });

  test('can set to null', () => {
    addTerminal(1, { projectIndex: 0 });
    setActiveTerminal(null);
    expect(getActiveTerminal()).toBeNull();
  });

  test('can set to non-existent ID (no validation)', () => {
    setActiveTerminal(999);
    expect(getActiveTerminal()).toBe(999);
  });
});

// ── Detail Terminal ──

describe('detail terminal', () => {
  test('setDetailTerminal sets value', () => {
    const detail = { id: 5, type: 'fivem' };
    setDetailTerminal(detail);
    expect(getDetailTerminal()).toEqual(detail);
  });

  test('setDetailTerminal with null clears it', () => {
    setDetailTerminal({ id: 5 });
    setDetailTerminal(null);
    expect(getDetailTerminal()).toBeNull();
  });
});

// ── countTerminalsForProject ──

describe('countTerminalsForProject', () => {
  test('counts terminals for a specific project index', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 0 });
    addTerminal(3, { projectIndex: 1 });
    expect(countTerminalsForProject(0)).toBe(2);
    expect(countTerminalsForProject(1)).toBe(1);
  });

  test('returns 0 for project with no terminals', () => {
    expect(countTerminalsForProject(99)).toBe(0);
  });
});

// ── getTerminalStatsForProject ──

describe('getTerminalStatsForProject', () => {
  test('returns total and working counts', () => {
    addTerminal(1, { projectIndex: 0, type: 'claude', status: 'working', isBasic: false });
    addTerminal(2, { projectIndex: 0, type: 'claude', status: 'idle', isBasic: false });
    addTerminal(3, { projectIndex: 0, type: 'claude', status: 'working', isBasic: false });
    const stats = getTerminalStatsForProject(0);
    expect(stats.total).toBe(3);
    expect(stats.working).toBe(2);
  });

  test('excludes fivem type terminals', () => {
    addTerminal(1, { projectIndex: 0, type: 'claude', status: 'working', isBasic: false });
    addTerminal(2, { projectIndex: 0, type: 'fivem', status: 'working', isBasic: false });
    const stats = getTerminalStatsForProject(0);
    expect(stats.total).toBe(1);
    expect(stats.working).toBe(1);
  });

  test('excludes webapp type terminals', () => {
    addTerminal(1, { projectIndex: 0, type: 'claude', status: 'idle', isBasic: false });
    addTerminal(2, { projectIndex: 0, type: 'webapp', status: 'working', isBasic: false });
    const stats = getTerminalStatsForProject(0);
    expect(stats.total).toBe(1);
    expect(stats.working).toBe(0);
  });

  test('excludes basic terminals', () => {
    addTerminal(1, { projectIndex: 0, type: 'claude', status: 'working', isBasic: false });
    addTerminal(2, { projectIndex: 0, type: 'claude', status: 'working', isBasic: true });
    const stats = getTerminalStatsForProject(0);
    expect(stats.total).toBe(1);
    expect(stats.working).toBe(1);
  });

  test('returns zeros for project with no terminals', () => {
    expect(getTerminalStatsForProject(99)).toEqual({ total: 0, working: 0 });
  });
});

// ── getTerminalsForProject ──

describe('getTerminalsForProject', () => {
  test('returns terminals for a specific project', () => {
    addTerminal(1, { projectIndex: 0, name: 'A' });
    addTerminal(2, { projectIndex: 1, name: 'B' });
    addTerminal(3, { projectIndex: 0, name: 'C' });
    const terms = getTerminalsForProject(0);
    expect(terms).toHaveLength(2);
    expect(terms[0]).toEqual(expect.objectContaining({ id: 1, name: 'A' }));
    expect(terms[1]).toEqual(expect.objectContaining({ id: 3, name: 'C' }));
  });

  test('returns empty array for project with no terminals', () => {
    expect(getTerminalsForProject(99)).toEqual([]);
  });

  test('includes id in returned objects', () => {
    addTerminal(42, { projectIndex: 0 });
    const terms = getTerminalsForProject(0);
    expect(terms[0].id).toBe(42);
  });
});

// ── killTerminalsForProject ──

describe('killTerminalsForProject', () => {
  test('calls callback for each terminal of the project', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 0 });
    addTerminal(3, { projectIndex: 1 });
    const killCb = jest.fn();
    killTerminalsForProject(0, killCb);
    expect(killCb).toHaveBeenCalledTimes(2);
    expect(killCb).toHaveBeenCalledWith(1);
    expect(killCb).toHaveBeenCalledWith(2);
  });

  test('removes terminals for the project', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 0 });
    addTerminal(3, { projectIndex: 1 });
    killTerminalsForProject(0, jest.fn());
    expect(getTerminalsForProject(0)).toHaveLength(0);
    expect(getTerminalsForProject(1)).toHaveLength(1);
  });

  test('works without callback', () => {
    addTerminal(1, { projectIndex: 0 });
    killTerminalsForProject(0, null);
    expect(getTerminals().size).toBe(0);
  });
});

// ── clearAllTerminals ──

describe('clearAllTerminals', () => {
  test('removes all terminals', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 1 });
    clearAllTerminals(jest.fn());
    expect(getTerminals().size).toBe(0);
    expect(getActiveTerminal()).toBeNull();
  });

  test('calls callback for each terminal', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 1 });
    const cb = jest.fn();
    clearAllTerminals(cb);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith(1);
    expect(cb).toHaveBeenCalledWith(2);
  });

  test('works without callback', () => {
    addTerminal(1, { projectIndex: 0 });
    clearAllTerminals(null);
    expect(getTerminals().size).toBe(0);
  });

  test('handles empty state', () => {
    clearAllTerminals(jest.fn());
    expect(getTerminals().size).toBe(0);
  });
});

// ── Subscription notifications ──

describe('subscription notifications', () => {
  test('notifies on terminal add', async () => {
    const listener = jest.fn();
    terminalsState.subscribe(listener);
    addTerminal(1, { projectIndex: 0 });
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies on terminal remove', async () => {
    addTerminal(1, { projectIndex: 0 });
    const listener = jest.fn();
    terminalsState.subscribe(listener);
    removeTerminal(1);
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies on setActiveTerminal', async () => {
    const listener = jest.fn();
    terminalsState.subscribe(listener);
    setActiveTerminal(5);
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('unsubscribe stops notifications', async () => {
    const listener = jest.fn();
    const unsub = terminalsState.subscribe(listener);
    unsub();
    addTerminal(1, { projectIndex: 0 });
    await new Promise(r => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── Batch updates ──

describe('batch updates', () => {
  test('multiple rapid changes result in single notification', async () => {
    const listener = jest.fn();
    terminalsState.subscribe(listener);
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 0 });
    addTerminal(3, { projectIndex: 1 });
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── Reset ──

describe('reset', () => {
  test('clears all terminals and active state', () => {
    addTerminal(1, { projectIndex: 0 });
    addTerminal(2, { projectIndex: 1 });
    setDetailTerminal({ id: 5 });

    resetState();

    expect(getTerminals().size).toBe(0);
    expect(getActiveTerminal()).toBeNull();
    expect(getDetailTerminal()).toBeNull();
  });
});
