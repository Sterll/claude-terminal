// backgroundTasks state — the cross-session registry behind the tasks panel.
//
// The behaviour worth pinning down is reconciliation: each `background_tasks_changed`
// payload describes a single session, so syncing must never touch another
// session's running tasks, and a task that vanishes without a bookend must be
// recorded as ended-with-unknown-outcome rather than as a success.

const store = require('../../src/renderer/state/backgroundTasks.state');
const {
  taskStarted, taskEnded, syncLive, listTasks, getTask, reset, MAX_FINISHED,
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

