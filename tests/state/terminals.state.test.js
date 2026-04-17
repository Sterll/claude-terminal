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
  clearAllTerminals,
  generateTabId,
  stripAnsi,
  getTerminalByTabId,
  updateTerminalByTabId,
  touchTerminalActivity,
  deriveTabStatus,
  appendTerminalOutput,
  appendChatMessage,
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

// ── MCP tab orchestration helpers ──

describe('generateTabId', () => {
  test('produces a prefixed, stable-looking id', () => {
    const a = generateTabId('proj_abc');
    expect(a).toMatch(/^tab_proj_abc_\d+_[a-z0-9]+$/);
  });

  test('sanitizes unsafe project ids', () => {
    const id = generateTabId('p/r@j id!');
    expect(id.startsWith('tab_')).toBe(true);
    expect(id).not.toMatch(/[@/! ]/);
  });

  test('falls back to "unknown" for missing project id', () => {
    expect(generateTabId('')).toMatch(/^tab_unknown_/);
    expect(generateTabId(null)).toMatch(/^tab_unknown_/);
  });

  test('produces unique ids on consecutive calls', () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) ids.add(generateTabId('proj'));
    expect(ids.size).toBe(50);
  });
});

describe('stripAnsi', () => {
  test('removes common CSI color codes', () => {
    expect(stripAnsi('\x1B[31mhello\x1B[0m')).toBe('hello');
    expect(stripAnsi('\x1B[1;32mgreen\x1B[0m world')).toBe('green world');
  });

  test('removes OSC sequences (title changes etc.)', () => {
    expect(stripAnsi('\x1B]0;my title\x07ok')).toBe('ok');
  });

  test('is a no-op for clean text', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  test('handles empty / nullish input', () => {
    expect(stripAnsi('')).toBe('');
    expect(stripAnsi(null)).toBe('');
    expect(stripAnsi(undefined)).toBe('');
  });
});

describe('getTerminalByTabId / updateTerminalByTabId', () => {
  test('finds entry by tabId', () => {
    addTerminal(1, { projectIndex: 0, tabId: 'tab_a_1_xx', mode: 'terminal' });
    const found = getTerminalByTabId('tab_a_1_xx');
    expect(found).not.toBeNull();
    expect(found.id).toBe(1);
    expect(found.data.mode).toBe('terminal');
  });

  test('returns null for missing tabId', () => {
    expect(getTerminalByTabId('nope')).toBeNull();
    expect(getTerminalByTabId('')).toBeNull();
    expect(getTerminalByTabId(null)).toBeNull();
  });

  test('updateTerminalByTabId merges fields', () => {
    addTerminal(1, { projectIndex: 0, tabId: 'tab_a_1_xx', status: 'ready' });
    expect(updateTerminalByTabId('tab_a_1_xx', { status: 'working', lastCommand: 'ls' })).toBe(true);
    const td = getTerminalByTabId('tab_a_1_xx').data;
    expect(td.status).toBe('working');
    expect(td.lastCommand).toBe('ls');
  });

  test('updateTerminalByTabId returns false for missing tab', () => {
    expect(updateTerminalByTabId('nope', { x: 1 })).toBe(false);
  });
});

describe('touchTerminalActivity', () => {
  test('sets lastActivityAt on matching entry by internal id', () => {
    addTerminal(1, { projectIndex: 0, tabId: 'tab_a_1_xx' });
    touchTerminalActivity(1);
    expect(getTerminal(1).lastActivityAt).toBeDefined();
  });

  test('sets lastActivityAt by tabId', () => {
    addTerminal(2, { projectIndex: 0, tabId: 'tab_a_2_xx' });
    touchTerminalActivity('tab_a_2_xx');
    expect(getTerminal(2).lastActivityAt).toBeDefined();
  });

  test('is safe when tab is not found', () => {
    expect(() => touchTerminalActivity('nope')).not.toThrow();
  });
});

describe('deriveTabStatus', () => {
  test('returns "done" for missing data', () => {
    expect(deriveTabStatus(undefined)).toBe('done');
    expect(deriveTabStatus(null)).toBe('done');
  });

  test('awaiting_permission wins over everything else', () => {
    expect(deriveTabStatus({ mode: 'chat', pendingPermission: { tool: 'x' }, status: 'ready' })).toBe('awaiting_permission');
  });

  test('error status maps through', () => {
    expect(deriveTabStatus({ mode: 'terminal', status: 'error' })).toBe('error');
  });

  test('loading maps to running', () => {
    expect(deriveTabStatus({ mode: 'terminal', status: 'loading' })).toBe('running');
  });

  test('chat working → running, otherwise idle', () => {
    expect(deriveTabStatus({ mode: 'chat', status: 'working' })).toBe('running');
    expect(deriveTabStatus({ mode: 'chat', status: 'ready' })).toBe('idle');
  });

  test('terminal working → running, otherwise idle', () => {
    expect(deriveTabStatus({ mode: 'terminal', status: 'working' })).toBe('running');
    expect(deriveTabStatus({ mode: 'terminal', status: 'ready' })).toBe('idle');
  });
});

describe('appendTerminalOutput', () => {
  test('strips ANSI and appends with a cursor', () => {
    const td = {};
    appendTerminalOutput(td, '\x1B[31mhi\x1B[0m');
    expect(td.outputBuffer).toHaveLength(1);
    expect(td.outputBuffer[0].text).toBe('hi');
    expect(td.outputBuffer[0].cursor).toBe(1);
  });

  test('cursor increases monotonically', () => {
    const td = {};
    appendTerminalOutput(td, 'a');
    appendTerminalOutput(td, 'b');
    appendTerminalOutput(td, 'c');
    expect(td.outputBuffer.map(e => e.cursor)).toEqual([1, 2, 3]);
  });

  test('caps to maxBytes by dropping oldest', () => {
    const td = {};
    const chunk = 'x'.repeat(200);
    appendTerminalOutput(td, chunk, 500);
    appendTerminalOutput(td, chunk, 500);
    appendTerminalOutput(td, chunk, 500);
    // After 600 bytes total with cap 500, oldest entry should be dropped.
    expect(td.outputBuffer.length).toBeLessThan(3);
    expect(td.outputBufferSize).toBeLessThanOrEqual(500);
  });

  test('ignores empty chunks', () => {
    const td = {};
    appendTerminalOutput(td, '');
    appendTerminalOutput(td, null);
    expect(td.outputBuffer).toBeUndefined();
  });
});

describe('appendChatMessage', () => {
  test('stores role/content/cursor/timestamp', () => {
    const td = {};
    appendChatMessage(td, { role: 'user', content: 'hello', tokensUsed: 42 });
    expect(td.chatMessages).toHaveLength(1);
    expect(td.chatMessages[0].role).toBe('user');
    expect(td.chatMessages[0].content).toBe('hello');
    expect(td.chatMessages[0].tokensUsed).toBe(42);
    expect(td.chatMessages[0].cursor).toBe(1);
    expect(typeof td.chatMessages[0].ts).toBe('number');
  });

  test('shares cursor space with appendTerminalOutput', () => {
    const td = {};
    appendTerminalOutput(td, 'a');
    appendChatMessage(td, { role: 'assistant', content: 'b' });
    expect(td.outputBuffer[0].cursor).toBe(1);
    expect(td.chatMessages[0].cursor).toBe(2);
  });
});

// ── Phase 2 patterns: wait + read_output cursor semantics ──
// These tests exercise the exact primitives used by TerminalManager's
// waitForTab / waitForAny / readOutputForTab methods (without pulling in
// xterm and the full component tree).

describe('phase 2 — subscribe-based wait (single tab)', () => {
  function waitForTab(tabId, { targetStatuses = ['idle', 'awaiting_permission', 'error'], timeoutMs = 500 } = {}) {
    return new Promise((resolve) => {
      const found = getTerminalByTabId(tabId);
      if (!found) return resolve({ ok: false, error: 'not found' });
      const matches = (d) => targetStatuses.includes(deriveTabStatus(d));
      if (matches(found.data)) {
        return resolve({ ok: true, tabId, status: deriveTabStatus(found.data), timedOut: false });
      }
      let done = false;
      const unsub = terminalsState.subscribe(() => {
        if (done) return;
        const cur = getTerminalByTabId(tabId);
        if (cur && matches(cur.data)) {
          done = true; clearTimeout(timer); unsub();
          resolve({ ok: true, tabId, status: deriveTabStatus(cur.data), timedOut: false });
        }
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true; unsub();
        const cur = getTerminalByTabId(tabId);
        resolve({ ok: true, tabId, status: cur ? deriveTabStatus(cur.data) : 'done', timedOut: true });
      }, timeoutMs);
    });
  }

  test('resolves immediately when tab already idle', async () => {
    addTerminal(1, { tabId: 'tab_x', status: 'ready', mode: 'terminal' });
    const r = await waitForTab('tab_x', { timeoutMs: 200 });
    expect(r.ok).toBe(true);
    expect(r.status).toBe('idle');
    expect(r.timedOut).toBe(false);
  });

  test('resolves when tab transitions to awaiting_permission', async () => {
    addTerminal(1, { tabId: 'tab_x', status: 'working', mode: 'chat' });
    const p = waitForTab('tab_x', { timeoutMs: 500 });
    setTimeout(() => updateTerminal(1, { pendingPermission: { requestId: 'r1', tool: 'Bash' } }), 20);
    const r = await p;
    expect(r.status).toBe('awaiting_permission');
    expect(r.timedOut).toBe(false);
  });

  test('resolves with timedOut=true when target never reached', async () => {
    addTerminal(1, { tabId: 'tab_x', status: 'working', mode: 'chat' });
    const r = await waitForTab('tab_x', { timeoutMs: 60 });
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe('running');
  });

  test('returns error when tab does not exist', async () => {
    const r = await waitForTab('tab_missing', { timeoutMs: 60 });
    expect(r.ok).toBe(false);
  });
});

describe('phase 2 — subscribe-based wait (any)', () => {
  function waitForAny(tabIds, { targetStatuses = ['idle', 'awaiting_permission', 'error'], timeoutMs = 500 } = {}) {
    return new Promise((resolve) => {
      if (!tabIds.length) return resolve({ ok: false, error: 'empty' });
      const matches = (d) => targetStatuses.includes(deriveTabStatus(d));
      for (const tid of tabIds) {
        const f = getTerminalByTabId(tid);
        if (f && matches(f.data)) return resolve({ ok: true, tabId: tid, status: deriveTabStatus(f.data), timedOut: false });
      }
      let done = false;
      const unsub = terminalsState.subscribe(() => {
        if (done) return;
        for (const tid of tabIds) {
          const f = getTerminalByTabId(tid);
          if (f && matches(f.data)) {
            done = true; clearTimeout(timer); unsub();
            return resolve({ ok: true, tabId: tid, status: deriveTabStatus(f.data), timedOut: false });
          }
        }
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true; unsub();
        resolve({ ok: true, timedOut: true, tabId: null });
      }, timeoutMs);
    });
  }

  test('resolves with first matching tab', async () => {
    addTerminal(1, { tabId: 'tab_a', status: 'working', mode: 'chat' });
    addTerminal(2, { tabId: 'tab_b', status: 'working', mode: 'chat' });
    addTerminal(3, { tabId: 'tab_c', status: 'working', mode: 'chat' });
    const p = waitForAny(['tab_a', 'tab_b', 'tab_c'], { timeoutMs: 500 });
    setTimeout(() => updateTerminal(2, { status: 'ready' }), 20);
    const r = await p;
    expect(r.timedOut).toBe(false);
    expect(r.tabId).toBe('tab_b');
    expect(r.status).toBe('idle');
  });

  test('times out if none transition', async () => {
    addTerminal(1, { tabId: 'tab_a', status: 'working', mode: 'chat' });
    addTerminal(2, { tabId: 'tab_b', status: 'working', mode: 'chat' });
    const r = await waitForAny(['tab_a', 'tab_b'], { timeoutMs: 60 });
    expect(r.timedOut).toBe(true);
  });
});

describe('phase 2 — readOutputForTab cursor pagination', () => {
  function readOutput(tabId, { afterCursor = 0, maxEntries = 200 } = {}) {
    const found = getTerminalByTabId(tabId);
    if (!found) return { ok: false, error: 'not found' };
    const { data } = found;
    const cap = Math.max(1, Math.min(Number(maxEntries) || 200, 1000));
    const after = Number(afterCursor) || 0;
    if (data.mode === 'chat') {
      const all = Array.isArray(data.chatMessages) ? data.chatMessages : [];
      const filtered = all.filter(m => (m.cursor || 0) > after);
      const tail = filtered.slice(-cap);
      const lastCursor = tail.length ? tail[tail.length - 1].cursor : (all.length ? all[all.length - 1].cursor : after);
      return { ok: true, mode: 'chat', messages: tail, lastCursor, truncated: filtered.length > tail.length };
    }
    const all = Array.isArray(data.outputBuffer) ? data.outputBuffer : [];
    const filtered = all.filter(e => (e.cursor || 0) > after);
    const tail = filtered.slice(-cap);
    const lastCursor = tail.length ? tail[tail.length - 1].cursor : (all.length ? all[all.length - 1].cursor : after);
    return { ok: true, mode: 'terminal', entries: tail, lastCursor, truncated: filtered.length > tail.length };
  }

  test('returns terminal entries after cursor', () => {
    const td = { tabId: 'tab_x', mode: 'terminal' };
    addTerminal(1, td);
    appendTerminalOutput(td, 'a');
    appendTerminalOutput(td, 'b');
    appendTerminalOutput(td, 'c');

    const r1 = readOutput('tab_x', { afterCursor: 0 });
    expect(r1.entries).toHaveLength(3);
    expect(r1.lastCursor).toBe(3);

    const r2 = readOutput('tab_x', { afterCursor: 2 });
    expect(r2.entries).toHaveLength(1);
    expect(r2.entries[0].text).toBe('c');
    expect(r2.lastCursor).toBe(3);
  });

  test('honors maxEntries with truncated flag', () => {
    const td = { tabId: 'tab_x', mode: 'terminal' };
    addTerminal(1, td);
    for (let i = 0; i < 10; i++) appendTerminalOutput(td, `line-${i}`);

    const r = readOutput('tab_x', { afterCursor: 0, maxEntries: 3 });
    expect(r.entries).toHaveLength(3);
    expect(r.truncated).toBe(true);
    // Last 3 kept:
    expect(r.entries[0].text).toBe('line-7');
    expect(r.entries[2].text).toBe('line-9');
  });

  test('returns chat messages with shared cursor space', () => {
    const td = { tabId: 'tab_x', mode: 'chat' };
    addTerminal(1, td);
    appendChatMessage(td, { role: 'user', content: 'hi' });
    appendChatMessage(td, { role: 'assistant', content: 'hello' });

    const r = readOutput('tab_x', { afterCursor: 1 });
    expect(r.mode).toBe('chat');
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toBe('hello');
    expect(r.lastCursor).toBe(2);
  });

  test('returns empty when no new entries after cursor', () => {
    const td = { tabId: 'tab_x', mode: 'terminal' };
    addTerminal(1, td);
    appendTerminalOutput(td, 'a');
    const r = readOutput('tab_x', { afterCursor: 10 });
    expect(r.entries).toHaveLength(0);
    expect(r.lastCursor).toBe(1);
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
