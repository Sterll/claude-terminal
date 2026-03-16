const {
  gitState,
  getGitOperation,
  setGitPulling,
  setGitPushing,
  setGitMerging,
  setMergeInProgress,
  getGitRepoStatus,
  setGitRepoStatus,
  checkAllProjectsGitStatus,
  getWorktreeInfo,
  setWorktreeInfo
} = require('../../src/renderer/state/git.state');

function resetState() {
  gitState.reset({
    gitOperations: new Map(),
    gitRepoStatus: new Map(),
    gitWorktrees: new Map()
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetState();
});

// ── Initial State ──

describe('initial state', () => {
  test('gitOperations is an empty Map', () => {
    expect(gitState.get().gitOperations).toBeInstanceOf(Map);
    expect(gitState.get().gitOperations.size).toBe(0);
  });

  test('gitRepoStatus is an empty Map', () => {
    expect(gitState.get().gitRepoStatus).toBeInstanceOf(Map);
    expect(gitState.get().gitRepoStatus.size).toBe(0);
  });

  test('gitWorktrees is an empty Map', () => {
    expect(gitState.get().gitWorktrees).toBeInstanceOf(Map);
    expect(gitState.get().gitWorktrees.size).toBe(0);
  });
});

// ── getGitOperation ──

describe('getGitOperation', () => {
  test('returns default state for unknown project', () => {
    const op = getGitOperation('unknown-project');
    expect(op).toEqual({
      pulling: false,
      pushing: false,
      merging: false,
      mergeInProgress: false,
      conflicts: [],
      lastResult: null
    });
  });

  test('returns stored state for known project', () => {
    setGitPulling('p1', true);
    const op = getGitOperation('p1');
    expect(op.pulling).toBe(true);
  });
});

// ── setGitPulling ──

describe('setGitPulling', () => {
  test('sets pulling to true', () => {
    setGitPulling('p1', true);
    expect(getGitOperation('p1').pulling).toBe(true);
  });

  test('sets pulling to false', () => {
    setGitPulling('p1', true);
    setGitPulling('p1', false);
    expect(getGitOperation('p1').pulling).toBe(false);
  });

  test('sets result when provided', () => {
    setGitPulling('p1', false, { success: true, message: 'Already up to date' });
    expect(getGitOperation('p1').lastResult).toEqual({ success: true, message: 'Already up to date' });
  });

  test('preserves lastResult when no result provided', () => {
    setGitPulling('p1', false, { success: true });
    setGitPulling('p1', true);
    expect(getGitOperation('p1').lastResult).toEqual({ success: true });
  });

  test('does not affect other project operations', () => {
    setGitPulling('p1', true);
    setGitPulling('p2', false);
    expect(getGitOperation('p1').pulling).toBe(true);
    expect(getGitOperation('p2').pulling).toBe(false);
  });
});

// ── setGitPushing ──

describe('setGitPushing', () => {
  test('sets pushing to true', () => {
    setGitPushing('p1', true);
    expect(getGitOperation('p1').pushing).toBe(true);
  });

  test('sets pushing to false', () => {
    setGitPushing('p1', true);
    setGitPushing('p1', false);
    expect(getGitOperation('p1').pushing).toBe(false);
  });

  test('sets result when provided', () => {
    setGitPushing('p1', false, { success: true });
    expect(getGitOperation('p1').lastResult).toEqual({ success: true });
  });

  test('preserves lastResult when no result provided', () => {
    setGitPushing('p1', false, { success: false, error: 'rejected' });
    setGitPushing('p1', true);
    expect(getGitOperation('p1').lastResult).toEqual({ success: false, error: 'rejected' });
  });

  test('preserves pulling state when setting pushing', () => {
    setGitPulling('p1', true);
    setGitPushing('p1', true);
    expect(getGitOperation('p1').pulling).toBe(true);
    expect(getGitOperation('p1').pushing).toBe(true);
  });
});

// ── setGitMerging ──

describe('setGitMerging', () => {
  test('sets merging to true', () => {
    setGitMerging('p1', true);
    expect(getGitOperation('p1').merging).toBe(true);
  });

  test('sets merging to false', () => {
    setGitMerging('p1', true);
    setGitMerging('p1', false);
    expect(getGitOperation('p1').merging).toBe(false);
  });

  test('sets mergeInProgress and conflicts from result', () => {
    setGitMerging('p1', true, { hasConflicts: true, conflicts: ['file1.js', 'file2.js'] });
    const op = getGitOperation('p1');
    expect(op.mergeInProgress).toBe(true);
    expect(op.conflicts).toEqual(['file1.js', 'file2.js']);
  });

  test('clears mergeInProgress when result has no conflicts', () => {
    setGitMerging('p1', true, { hasConflicts: true, conflicts: ['file.js'] });
    setGitMerging('p1', false, { hasConflicts: false, conflicts: [] });
    const op = getGitOperation('p1');
    expect(op.mergeInProgress).toBe(false);
    expect(op.conflicts).toEqual([]);
  });

  test('sets lastResult when provided', () => {
    const result = { hasConflicts: false, message: 'Merged successfully' };
    setGitMerging('p1', false, result);
    expect(getGitOperation('p1').lastResult).toEqual(result);
  });
});

// ── setMergeInProgress ──

describe('setMergeInProgress', () => {
  test('sets mergeInProgress to true with conflicts', () => {
    setMergeInProgress('p1', true, ['a.js', 'b.js']);
    const op = getGitOperation('p1');
    expect(op.mergeInProgress).toBe(true);
    expect(op.conflicts).toEqual(['a.js', 'b.js']);
  });

  test('clears mergeInProgress', () => {
    setMergeInProgress('p1', true, ['a.js']);
    setMergeInProgress('p1', false, []);
    const op = getGitOperation('p1');
    expect(op.mergeInProgress).toBe(false);
    expect(op.conflicts).toEqual([]);
  });

  test('defaults conflicts to empty array', () => {
    setMergeInProgress('p1', true);
    expect(getGitOperation('p1').conflicts).toEqual([]);
  });

  test('preserves other operation flags', () => {
    setGitPulling('p1', true);
    setMergeInProgress('p1', true, ['conflict.js']);
    expect(getGitOperation('p1').pulling).toBe(true);
    expect(getGitOperation('p1').mergeInProgress).toBe(true);
  });
});

// ── Multiple projects simultaneously ──

describe('multiple projects simultaneously', () => {
  test('tracks operations for multiple projects independently', () => {
    setGitPulling('p1', true);
    setGitPushing('p2', true);
    setGitMerging('p3', true);

    expect(getGitOperation('p1').pulling).toBe(true);
    expect(getGitOperation('p1').pushing).toBe(false);

    expect(getGitOperation('p2').pushing).toBe(true);
    expect(getGitOperation('p2').pulling).toBe(false);

    expect(getGitOperation('p3').merging).toBe(true);
  });

  test('changes to one project do not affect others', () => {
    setGitPulling('p1', true);
    setGitPulling('p2', true);

    setGitPulling('p1', false, { success: true });

    expect(getGitOperation('p1').pulling).toBe(false);
    expect(getGitOperation('p2').pulling).toBe(true);
  });
});

// ── Git Repo Status ──

describe('getGitRepoStatus', () => {
  test('returns default for unknown project', () => {
    expect(getGitRepoStatus('unknown')).toEqual({ isGitRepo: false });
  });

  test('returns stored status', () => {
    setGitRepoStatus('p1', true);
    expect(getGitRepoStatus('p1')).toEqual({ isGitRepo: true });
  });
});

describe('setGitRepoStatus', () => {
  test('sets isGitRepo to true', () => {
    setGitRepoStatus('p1', true);
    expect(getGitRepoStatus('p1').isGitRepo).toBe(true);
  });

  test('sets isGitRepo to false', () => {
    setGitRepoStatus('p1', true);
    setGitRepoStatus('p1', false);
    expect(getGitRepoStatus('p1').isGitRepo).toBe(false);
  });

  test('handles multiple projects', () => {
    setGitRepoStatus('p1', true);
    setGitRepoStatus('p2', false);
    setGitRepoStatus('p3', true);

    expect(getGitRepoStatus('p1').isGitRepo).toBe(true);
    expect(getGitRepoStatus('p2').isGitRepo).toBe(false);
    expect(getGitRepoStatus('p3').isGitRepo).toBe(true);
  });
});

// ── checkAllProjectsGitStatus ──

describe('checkAllProjectsGitStatus', () => {
  test('checks all projects and sets status', async () => {
    const projects = [
      { id: 'p1', path: '/project1' },
      { id: 'p2', path: '/project2' }
    ];
    const checkFn = jest.fn()
      .mockResolvedValueOnce({ isGitRepo: true })
      .mockResolvedValueOnce({ isGitRepo: false });

    await checkAllProjectsGitStatus(projects, checkFn);

    expect(checkFn).toHaveBeenCalledTimes(2);
    expect(checkFn).toHaveBeenCalledWith('/project1');
    expect(checkFn).toHaveBeenCalledWith('/project2');
    expect(getGitRepoStatus('p1').isGitRepo).toBe(true);
    expect(getGitRepoStatus('p2').isGitRepo).toBe(false);
  });

  test('sets false on error', async () => {
    const projects = [{ id: 'p1', path: '/fail' }];
    const checkFn = jest.fn().mockRejectedValue(new Error('fail'));

    await checkAllProjectsGitStatus(projects, checkFn);

    expect(getGitRepoStatus('p1').isGitRepo).toBe(false);
  });

  test('handles empty projects array', async () => {
    const checkFn = jest.fn();
    await checkAllProjectsGitStatus([], checkFn);
    expect(checkFn).not.toHaveBeenCalled();
  });
});

// ── Worktree Info ──

describe('getWorktreeInfo', () => {
  test('returns default for unknown project', () => {
    expect(getWorktreeInfo('unknown')).toEqual({
      worktrees: [],
      isWorktree: false,
      mainRepoPath: null
    });
  });

  test('returns stored info', () => {
    const info = { worktrees: [{ path: '/wt1' }], isWorktree: true, mainRepoPath: '/main' };
    setWorktreeInfo('p1', info);
    expect(getWorktreeInfo('p1')).toEqual(info);
  });
});

describe('setWorktreeInfo', () => {
  test('stores worktree info for a project', () => {
    const info = { worktrees: [{ path: '/wt1' }, { path: '/wt2' }], isWorktree: false, mainRepoPath: null };
    setWorktreeInfo('p1', info);
    expect(getWorktreeInfo('p1')).toEqual(info);
  });

  test('overwrites existing info', () => {
    setWorktreeInfo('p1', { worktrees: [{ path: '/old' }], isWorktree: false, mainRepoPath: null });
    setWorktreeInfo('p1', { worktrees: [{ path: '/new' }], isWorktree: true, mainRepoPath: '/main' });
    expect(getWorktreeInfo('p1').worktrees[0].path).toBe('/new');
    expect(getWorktreeInfo('p1').isWorktree).toBe(true);
  });

  test('handles multiple projects independently', () => {
    setWorktreeInfo('p1', { worktrees: [], isWorktree: true, mainRepoPath: '/a' });
    setWorktreeInfo('p2', { worktrees: [], isWorktree: false, mainRepoPath: null });
    expect(getWorktreeInfo('p1').isWorktree).toBe(true);
    expect(getWorktreeInfo('p2').isWorktree).toBe(false);
  });
});

// ── Subscription notifications ──

describe('subscription notifications', () => {
  test('notifies subscribers on git pull state change', async () => {
    const listener = jest.fn();
    gitState.subscribe(listener);

    setGitPulling('p1', true);

    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies subscribers on git push state change', async () => {
    const listener = jest.fn();
    gitState.subscribe(listener);

    setGitPushing('p1', true);

    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies subscribers on repo status change', async () => {
    const listener = jest.fn();
    gitState.subscribe(listener);

    setGitRepoStatus('p1', true);

    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('notifies subscribers on worktree info change', async () => {
    const listener = jest.fn();
    gitState.subscribe(listener);

    setWorktreeInfo('p1', { worktrees: [], isWorktree: true, mainRepoPath: '/main' });

    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
  });

  test('unsubscribe stops notifications', async () => {
    const listener = jest.fn();
    const unsub = gitState.subscribe(listener);
    unsub();

    setGitPulling('p1', true);

    await new Promise(r => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });
});

// ── Batch updates ──

describe('batch updates', () => {
  test('multiple rapid changes result in single notification', async () => {
    const listener = jest.fn();
    gitState.subscribe(listener);

    setGitPulling('p1', true);
    setGitPushing('p2', true);
    setGitRepoStatus('p3', true);

    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── Reset ──

describe('reset', () => {
  test('clears all state', () => {
    setGitPulling('p1', true);
    setGitRepoStatus('p2', true);
    setWorktreeInfo('p3', { worktrees: [], isWorktree: true, mainRepoPath: '/a' });

    resetState();

    expect(gitState.get().gitOperations.size).toBe(0);
    expect(gitState.get().gitRepoStatus.size).toBe(0);
    expect(gitState.get().gitWorktrees.size).toBe(0);
  });

  test('returns defaults after reset', () => {
    setGitPulling('p1', true);
    resetState();
    expect(getGitOperation('p1').pulling).toBe(false);
  });
});
