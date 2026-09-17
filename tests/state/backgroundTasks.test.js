// backgroundTasks state — the cross-session registry behind the tasks panel.
//
// The behaviour worth pinning down is reconciliation: each `background_tasks_changed`
// payload describes a single session, so syncing must never touch another
// session's running tasks, and a task that vanishes without a bookend must be
// recorded as ended-with-unknown-outcome rather than as a success.

const store = require('../../src/renderer/state/backgroundTasks.state');
const {
  taskStarted, taskEnded, syncLive, claimSession, resolveOwner, listTasks,
  listTasksForOwner, clearFinished, getTask, load, flushSync, reset, MAX_FINISHED,
} = store;

beforeEach(() => reset());

describe('taskStarted', () => {
  test('records a running task', () => {
    taskStarted({ taskId: 't1', sessionId: 's1', taskType: 'shell', description: 'npm test' });

    expect(getTask('t1')).toMatchObject({
      taskId: 't1', sessionId: 's1', type: 'shell', description: 'npm test', status: 'running',
    });
  });

  test('infers the subagent type when the CLI omits taskType', () => {
    taskStarted({ taskId: 't1', sessionId: 's1', subagentType: 'Explore' });

    expect(getTask('t1')).toMatchObject({ type: 'subagent', agentType: 'Explore' });
  });

  test('keeps the original start time when a task is announced twice', () => {
    taskStarted({ taskId: 't1', sessionId: 's1' });
    const first = getTask('t1').startedAt;

    taskStarted({ taskId: 't1', sessionId: 's1' });

    // Duration must measure the task, not the last event about it.
    expect(getTask('t1').startedAt).toBe(first);
  });

  test('ignores a payload with no task id', () => {
    taskStarted({ sessionId: 's1' });
    expect(listTasks()).toHaveLength(0);
  });
});

describe('taskEnded', () => {
  test('settles with the reported status and usage', () => {
    taskStarted({ taskId: 't1', sessionId: 's1' });
    taskEnded({ taskId: 't1', sessionId: 's1', status: 'failed', usage: { total_tokens: 120 } });

    expect(getTask('t1')).toMatchObject({ status: 'failed', usage: { total_tokens: 120 } });
    expect(getTask('t1').endedAt).toEqual(expect.any(Number));
  });

  test('defaults to completed when the bookend carries no status', () => {
    taskStarted({ taskId: 't1', sessionId: 's1' });
    taskEnded({ taskId: 't1', sessionId: 's1' });

    expect(getTask('t1').status).toBe('completed');
  });

  test('keeps a bookend for a task whose start was never seen', () => {
    // Joining a session late is normal; the record is still real history.
    taskEnded({ taskId: 't9', sessionId: 's1', status: 'completed', description: 'ran earlier' });

    expect(getTask('t9')).toMatchObject({ status: 'completed', description: 'ran earlier' });
  });

  test('does not lose fields the start carried and the end omits', () => {
    taskStarted({ taskId: 't1', sessionId: 's1', subagentType: 'Explore', description: 'search' });
    taskEnded({ taskId: 't1', sessionId: 's1', status: 'completed' });

    expect(getTask('t1')).toMatchObject({ agentType: 'Explore', description: 'search' });
  });
});

describe('syncLive', () => {
  test('settles a running task missing from its session live set', () => {
    taskStarted({ taskId: 't1', sessionId: 's1' });

    syncLive('s1', []);

    // The outcome is genuinely unknown — it must not read as success.
    expect(getTask('t1').status).toBe('ended');
    expect(getTask('t1').endedAt).toEqual(expect.any(Number));
  });

  test('leaves a task alone while it is still in the set', () => {
    taskStarted({ taskId: 't1', sessionId: 's1' });

    syncLive('s1', [{ taskId: 't1' }]);

    expect(getTask('t1').status).toBe('running');
  });

  test('never touches another session', () => {
    // Each payload describes one session; treating it as global would wipe
    // every other session's running work.
    taskStarted({ taskId: 't1', sessionId: 's1' });
    taskStarted({ taskId: 't2', sessionId: 's2' });

    syncLive('s1', []);

    expect(getTask('t1').status).toBe('ended');
    expect(getTask('t2').status).toBe('running');
  });

  test('does not resurrect an already-settled task', () => {
    taskStarted({ taskId: 't1', sessionId: 's1' });
    taskEnded({ taskId: 't1', sessionId: 's1', status: 'failed' });

    syncLive('s1', []);

    expect(getTask('t1').status).toBe('failed');
  });

  test('ignores a sync with no session id', () => {
    taskStarted({ taskId: 't1', sessionId: 's1' });
    syncLive(null, []);
    expect(getTask('t1').status).toBe('running');
  });
});

describe('listTasks', () => {
  test('puts running tasks before finished ones', () => {
    taskStarted({ taskId: 'done', sessionId: 's1' });
    taskEnded({ taskId: 'done', sessionId: 's1', status: 'completed' });
    taskStarted({ taskId: 'live', sessionId: 's1' });

    expect(listTasks().map(t => t.taskId)).toEqual(['live', 'done']);
  });
});

describe('pruning', () => {
  test('caps finished history without evicting running work', () => {
    taskStarted({ taskId: 'live', sessionId: 's1' });
    for (let i = 0; i < MAX_FINISHED + 10; i++) {
      taskStarted({ taskId: `t${i}`, sessionId: 's1' });
      taskEnded({ taskId: `t${i}`, sessionId: 's1', status: 'completed' });
    }

    const all = listTasks();
    expect(all.filter(t => t.status !== 'running')).toHaveLength(MAX_FINISHED);
    // A list that forgets live work would be worse than a long one.
    expect(getTask('live').status).toBe('running');
  });
});


describe('owners', () => {
  test('files a task under the owner its session was claimed by', () => {
    claimSession('tab-1', 's1');
    taskStarted({ taskId: 't1', sessionId: 's1' });

    expect(listTasksForOwner('tab-1').map(t => t.taskId)).toEqual(['t1']);
  });

  test('re-stamps tasks when the link lands after them', () => {
    // The CLI can report a task before the tab has linked the id it used.
    taskStarted({ taskId: 't1', sessionId: 's1' });
    claimSession('tab-1', 's1');

    expect(listTasksForOwner('tab-1').map(t => t.taskId)).toEqual(['t1']);
  });

  test('keeps a tab whole across the ids it runs under', () => {
    // A handle per ChatView, a uuid from the CLI, another handle after an
    // account switch — one history all the same.
    claimSession('tab-1', 'chat-a');
    taskStarted({ taskId: 't1', sessionId: 'chat-a' });
    claimSession('tab-1', 'uuid-a');
    taskStarted({ taskId: 't2', sessionId: 'uuid-a' });
    claimSession('tab-1', 'chat-b');
    taskStarted({ taskId: 't3', sessionId: 'chat-b' });

    expect(listTasksForOwner('tab-1').map(t => t.taskId).sort()).toEqual(['t1', 't2', 't3']);
  });

  test('merges two owners that turn out to be the same tab', () => {
    // Claiming ahead of the file, then discovering the id already had a home.
    taskStarted({ taskId: 'old', sessionId: 'uuid-a' });
    claimSession('uuid-a', 'uuid-a');
    claimSession('tab-1', 'uuid-a');

    expect(listTasksForOwner('tab-1').map(t => t.taskId)).toEqual(['old']);
    expect(listTasksForOwner('uuid-a')).toEqual([]);
  });

  test('answers the owner a session is already known by', () => {
    claimSession('tab-1', 's1');

    expect(resolveOwner('s1')).toBe('tab-1');
    // An id nobody claimed must read as unknown, so a caller mints its own.
    expect(resolveOwner('s2')).toBeNull();
  });

  test('keeps one tab out of another tab\'s list', () => {
    claimSession('tab-1', 's1');
    claimSession('tab-2', 's2');
    taskStarted({ taskId: 't1', sessionId: 's1' });
    taskStarted({ taskId: 't2', sessionId: 's2' });

    expect(listTasksForOwner('tab-1').map(t => t.taskId)).toEqual(['t1']);
    expect(listTasksForOwner('tab-2').map(t => t.taskId)).toEqual(['t2']);
  });

  test('carries the owner through the end bookend', () => {
    claimSession('tab-1', 's1');
    taskStarted({ taskId: 't1', sessionId: 's1' });
    taskEnded({ taskId: 't1', sessionId: 's1', status: 'completed' });

    expect(listTasksForOwner('tab-1').map(t => t.taskId)).toEqual(['t1']);
  });
});

describe('clearFinished', () => {
  test('drops finished tasks and keeps running ones', () => {
    claimSession('tab-1', 's1');
    taskStarted({ taskId: 'done', sessionId: 's1' });
    taskEnded({ taskId: 'done', sessionId: 's1', status: 'completed' });
    taskStarted({ taskId: 'live', sessionId: 's1' });

    expect(clearFinished('tab-1')).toBe(1);
    // A clear that stopped reporting live work would be a lie, not a tidy-up.
    expect(listTasksForOwner('tab-1').map(t => t.taskId)).toEqual(['live']);
  });

  test('leaves another tab\'s history alone', () => {
    claimSession('tab-1', 's1');
    claimSession('tab-2', 's2');
    taskEnded({ taskId: 'mine', sessionId: 's1', status: 'completed' });
    taskEnded({ taskId: 'theirs', sessionId: 's2', status: 'completed' });

    clearFinished('tab-1');

    expect(getTask('mine')).toBeNull();
    expect(getTask('theirs')).not.toBeNull();
  });

  test('clears every tab when no owner is named', () => {
    taskEnded({ taskId: 'a', sessionId: 's1', status: 'completed' });
    taskEnded({ taskId: 'b', sessionId: 's2', status: 'completed' });

    expect(clearFinished()).toBe(2);
    expect(listTasks()).toHaveLength(0);
  });
});

describe('persistence', () => {
  // Built the same way the store builds it: hardcoding a posix path reads as
  // a rename to the wrong file on Windows, where `path.join` uses backslashes.
  const { backgroundTasksFile: FILE } = require('../../src/renderer/utils/paths');
  const fsMock = window.electron_nodeModules.fs;
  const written = () => {
    const call = fsMock.promises.writeFile.mock.calls.at(-1)
      || fsMock.writeFileSync.mock.calls.at(-1);
    return call ? JSON.parse(call[1]) : null;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fsMock.promises.readFile.mockResolvedValue('');
    fsMock.promises.mkdir.mockResolvedValue();
    fsMock.promises.writeFile.mockResolvedValue();
    fsMock.promises.rename.mockResolvedValue();
    fsMock.promises.copyFile.mockResolvedValue();
  });

  const onDisk = (data) => fsMock.promises.readFile.mockResolvedValue(JSON.stringify(data));

  test('an unreadable registry is never overwritten', async () => {
    // Absent is a legitimate first run. Truncated or corrupt is not: the store
    // is a read-modify-write of the whole collection, so answering it with an
    // empty registry would rewrite the file with this run alone.
    fsMock.promises.readFile.mockResolvedValue('{"version":1,"tasks":[{"taskId"');

    await load();

    claimSession('tab-1', 's1');
    taskStarted({ taskId: 't1', sessionId: 's1' });
    await new Promise(r => setTimeout(r, 700));
    flushSync();

    expect(fsMock.promises.writeFile).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(fsMock.promises.rename).not.toHaveBeenCalled();
  });

  test('an empty registry file counts as unreadable, not as absent', async () => {
    // A save only ever writes a complete document, so zero bytes is a
    // truncated write rather than a legitimate empty state.
    fsMock.promises.readFile.mockResolvedValue('');

    await load();
    taskStarted({ taskId: 't1', sessionId: 's1' });
    await new Promise(r => setTimeout(r, 700));

    expect(fsMock.promises.writeFile).not.toHaveBeenCalled();
  });

  test('writes the registry after a task is recorded', async () => {
    claimSession('tab-1', 's1');
    taskStarted({ taskId: 't1', sessionId: 's1', description: 'npm test' });

    await new Promise(r => setTimeout(r, 700)); // past the save debounce

    const saved = written();
    expect(saved.tasks.map(t => t.taskId)).toEqual(['t1']);
    expect(saved.owners).toEqual({ s1: 'tab-1' });
  });

  test('flushSync writes through a temp file, not over the real one', () => {
    claimSession('tab-1', 's1');
    taskStarted({ taskId: 't1', sessionId: 's1' });

    flushSync();

    // A half-written registry would be worse than a slightly stale one.
    const [tmpPath] = fsMock.writeFileSync.mock.calls.at(-1);
    expect(tmpPath).toMatch(/\.tmp$/);
    expect(fsMock.renameSync).toHaveBeenCalledWith(tmpPath, FILE);
  });

  test('reads last run\'s history back', async () => {
    onDisk({
      version: 1,
      savedAt: new Date(1_700_000_000_000).toISOString(),
      tasks: [{ taskId: 'old', sessionId: 's1', ownerKey: 'tab-1', status: 'completed', startedAt: 1, endedAt: 2 }],
      owners: { s1: 'tab-1' },
    });

    await load();

    expect(listTasksForOwner('tab-1').map(t => t.taskId)).toEqual(['old']);
  });

  test('settles a task the file still shows as running', async () => {
    const savedAt = 1_700_000_000_000;
    onDisk({
      version: 1,
      savedAt: new Date(savedAt).toISOString(),
      tasks: [{ taskId: 'zombie', sessionId: 's1', ownerKey: 'tab-1', status: 'running', startedAt: savedAt - 5000, endedAt: null }],
      owners: { s1: 'tab-1' },
    });

    await load();

    // Nothing survives the process that ran it, and nobody recorded how it
    // went — so it ended, with an unknown outcome, when the app went away.
    expect(getTask('zombie')).toMatchObject({ status: 'ended', endedAt: savedAt });
  });

  test('lets this run\'s record win over the file', async () => {
    taskStarted({ taskId: 't1', sessionId: 's1', description: 'live' });
    onDisk({
      version: 1,
      savedAt: new Date().toISOString(),
      tasks: [{ taskId: 't1', sessionId: 's1', ownerKey: 's1', status: 'completed', description: 'stale', startedAt: 1, endedAt: 2 }],
      owners: {},
    });

    await load();

    expect(getTask('t1')).toMatchObject({ status: 'running', description: 'live' });
  });

  test('gives a tab back the history it had under an older id', async () => {
    onDisk({
      version: 1,
      savedAt: new Date().toISOString(),
      tasks: [{ taskId: 'old', sessionId: 'chat-a', ownerKey: 'chat-a', status: 'completed', startedAt: 1, endedAt: 2 }],
      owners: { 'chat-a': 'chat-a', 'uuid-a': 'chat-a' },
    });

    await load();
    // What a restored tab resumes on is the CLI uuid, never the old handle.
    const owner = resolveOwner('uuid-a');

    expect(owner).toBe('chat-a');
    expect(listTasksForOwner(owner).map(t => t.taskId)).toEqual(['old']);
  });

  test('merges the file into an owner a tab claimed before it landed', async () => {
    // The tab does not wait for the read, so it mints its own owner first.
    claimSession('uuid-a', 'uuid-a');
    onDisk({
      version: 1,
      savedAt: new Date().toISOString(),
      tasks: [{ taskId: 'old', sessionId: 'chat-a', ownerKey: 'chat-a', status: 'completed', startedAt: 1, endedAt: 2 }],
      owners: { 'chat-a': 'chat-a', 'uuid-a': 'chat-a' },
    });

    await load();

    // One tab, one history, whichever way the race went.
    expect(listTasksForOwner('uuid-a').map(t => t.taskId)).toEqual(['old']);
    expect(listTasksForOwner('chat-a')).toEqual([]);
  });

  test('ignores a file it cannot vouch for', async () => {
    onDisk({ version: 99, tasks: [{ taskId: 'x', status: 'completed' }] });

    await load();

    expect(listTasks()).toHaveLength(0);
  });

  test('forgets aliases whose owner no longer holds a task', async () => {
    claimSession('tab-1', 's1');
    taskEnded({ taskId: 't1', sessionId: 's1', status: 'completed' });
    claimSession('tab-2', 's2');

    flushSync();

    // Otherwise the map is the one thing in here with no bound at all.
    expect(written().owners).toEqual({ s1: 'tab-1' });
  });
});
