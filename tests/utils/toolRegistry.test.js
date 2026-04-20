const {
  TOOL_DEFS,
  BUILTIN_TOOLS,
  getToolCategory,
  getCategoryColor,
  getToolIcon,
  getToolDisplayInfo,
  isFriendlyTool,
  hasCustomRenderer,
  renderToolCardHtml,
  hasResultRenderer,
  renderToolResultHtml,
  renderBgTaskCard,
  bgTaskStore,
  formatToolName,
  formatDuration,
} = require('../../src/renderer/utils/toolRegistry');

describe('toolRegistry / categories', () => {
  test('Agent and Task share the agent category', () => {
    expect(getToolCategory('Agent')).toBe('agent');
    expect(getToolCategory('Task')).toBe('agent');
  });

  test('mcp__ tools fall under mcp category', () => {
    expect(getToolCategory('mcp__foo__bar')).toBe('mcp');
  });

  test('unknown tools fall under other', () => {
    expect(getToolCategory('NonExistent')).toBe('other');
  });

  test('every category has a color', () => {
    const cats = new Set(Object.values(TOOL_DEFS).map((d) => d.category));
    for (const c of cats) {
      expect(getCategoryColor(c)).toMatch(/^\d+,\d+,\d+$/);
    }
  });
});

describe('toolRegistry / display info', () => {
  test('Read extracts file_path', () => {
    expect(getToolDisplayInfo('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
  });

  test('Bash extracts command', () => {
    expect(getToolDisplayInfo('Bash', { command: 'npm test' })).toBe('npm test');
  });

  test('Agent extracts description (subagent routing)', () => {
    expect(getToolDisplayInfo('Agent', { description: 'run tests', subagent_type: 'tester' })).toBe('run tests');
  });

  test('ScheduleWakeup formats delay + reason', () => {
    expect(getToolDisplayInfo('ScheduleWakeup', { delaySeconds: 120, reason: 'poll' })).toBe('2m — poll');
    expect(getToolDisplayInfo('ScheduleWakeup', { delaySeconds: 30 })).toBe('30s');
  });

  test('TaskOutput extracts task_id', () => {
    expect(getToolDisplayInfo('TaskOutput', { task_id: 'abc123' })).toBe('abc123');
  });

  test('empty input returns empty string', () => {
    expect(getToolDisplayInfo('Read', null)).toBe('');
  });
});

describe('toolRegistry / friendly + icons', () => {
  test('Agent is a friendly tool', () => {
    expect(isFriendlyTool('Agent')).toBe(true);
  });

  test('CronDelete is not friendly (no special session-replay card)', () => {
    expect(isFriendlyTool('CronDelete')).toBe(false);
  });

  test('every tool has an SVG icon', () => {
    for (const name of BUILTIN_TOOLS) {
      expect(getToolIcon(name)).toMatch(/<svg/);
    }
  });
});

describe('toolRegistry / custom renderers', () => {
  test('ScheduleWakeup has custom renderer', () => {
    expect(hasCustomRenderer('ScheduleWakeup')).toBe(true);
  });

  test('Read does NOT have custom renderer', () => {
    expect(hasCustomRenderer('Read')).toBe(false);
  });

  test('ScheduleWakeup renderer includes countdown element', () => {
    const html = renderToolCardHtml('ScheduleWakeup', { delaySeconds: 60, reason: 'check build' });
    expect(html).toContain('chat-wakeup-card');
    expect(html).toContain('data-countdown');
    expect(html).toContain('check build');
    expect(html).toMatch(/data-wakeup-at="\d+"/);
  });

  test('EnterWorktree renderer shows branch', () => {
    const html = renderToolCardHtml('EnterWorktree', { branch: 'feat/foo', path: '/tmp/wt' });
    expect(html).toContain('feat/foo');
    expect(html).toContain('/tmp/wt');
  });

  test('PushNotification escapes html in message', () => {
    const html = renderToolCardHtml('PushNotification', { title: 'Hi', message: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('CronCreate shows schedule + truncates long prompt', () => {
    const long = 'a'.repeat(500);
    const html = renderToolCardHtml('CronCreate', { name: 'nightly', schedule: '0 0 * * *', prompt: long });
    expect(html).toContain('nightly');
    expect(html).toContain('0 0 * * *');
    expect(html).toContain('…');
  });

  test('returns null for tools without a renderer', () => {
    expect(renderToolCardHtml('Read', { file_path: '/x' })).toBeNull();
  });
});

describe('toolRegistry / bgTaskStore', () => {
  beforeEach(() => {
    // Reset internal map between tests
    bgTaskStore._map.clear();
    bgTaskStore._subs.clear();
  });

  test('update() creates a new entry with defaults', () => {
    bgTaskStore.update('t1', { command: 'npm test' });
    const s = bgTaskStore.get('t1');
    expect(s.taskId).toBe('t1');
    expect(s.command).toBe('npm test');
    expect(s.status).toBe('running');
    expect(s.outputs).toEqual([]);
  });

  test('update() appends output into outputs array', () => {
    bgTaskStore.update('t1', { output: 'line 1' });
    bgTaskStore.update('t1', { output: 'line 2' });
    const s = bgTaskStore.get('t1');
    expect(s.outputs).toEqual(['line 1', 'line 2']);
    expect(s.output).toBeUndefined();
  });

  test('update() allows status change to stopped', () => {
    bgTaskStore.update('t1', { command: 'x' });
    bgTaskStore.update('t1', { status: 'stopped', stoppedAt: 123 });
    const s = bgTaskStore.get('t1');
    expect(s.status).toBe('stopped');
    expect(s.stoppedAt).toBe(123);
    expect(s.command).toBe('x');
  });

  test('subscribe() fires on update with taskId + state', () => {
    const calls = [];
    const unsub = bgTaskStore.subscribe((taskId, state) => {
      calls.push({ taskId, status: state.status });
    });
    bgTaskStore.update('t2', { command: 'y' });
    expect(calls).toEqual([{ taskId: 't2', status: 'running' }]);
    unsub();
    bgTaskStore.update('t2', { output: 'more' });
    expect(calls).toHaveLength(1);
  });

  test('update() ignores empty taskId', () => {
    expect(bgTaskStore.update('', { command: 'z' })).toBeNull();
    expect(bgTaskStore.all()).toHaveLength(0);
  });
});

describe('toolRegistry / renderBgTaskCard', () => {
  beforeEach(() => {
    bgTaskStore._map.clear();
  });

  test('renders action label and taskId badge', () => {
    const html = renderBgTaskCard('TaskOutput', { task_id: 'abcdefghijklm' });
    expect(html).toContain('Fetch output');
    expect(html).toContain('data-bg-task-id="abcdefghijklm"');
    // truncated form (> 12 chars)
    expect(html).toContain('abcdefgh…');
  });

  test('reflects store state (command + output tail)', () => {
    bgTaskStore.update('x', { command: 'npm start' });
    bgTaskStore.update('x', { output: 'server up on 3000' });
    const html = renderBgTaskCard('TaskOutput', { task_id: 'x' });
    expect(html).toContain('npm start');
    expect(html).toContain('server up on 3000');
  });

  test('stopped state renders stopped class', () => {
    bgTaskStore.update('x', { status: 'stopped', stoppedAt: 1 });
    const html = renderBgTaskCard('TaskStop', { task_id: 'x' });
    expect(html).toContain('chat-bgtask-card--stopped');
  });
});

describe('toolRegistry / result renderers', () => {
  test('CronList has a result renderer', () => {
    expect(hasResultRenderer('CronList')).toBe(true);
  });

  test('Read does not have a result renderer', () => {
    expect(hasResultRenderer('Read')).toBe(false);
  });

  test('CronList renders items from {crons:[...]}', () => {
    const out = { crons: [{ name: 'nightly', schedule: '0 0 * * *', enabled: true }, { name: 'old', schedule: '*/5 * * * *', enabled: false }] };
    const html = renderToolResultHtml('CronList', out, {});
    expect(html).toContain('nightly');
    expect(html).toContain('0 0 * * *');
    expect(html).toContain('chat-cronlist-state--enabled');
    expect(html).toContain('chat-cronlist-state--disabled');
    expect(html).toContain('2 crons');
  });

  test('CronList returns null on empty input', () => {
    expect(renderToolResultHtml('CronList', {}, {})).toBeNull();
    expect(renderToolResultHtml('CronList', { crons: [] }, {})).toBeNull();
  });

  test('CronList tolerates plain array', () => {
    const html = renderToolResultHtml('CronList', [{ name: 'x', schedule: '* * * * *' }], {});
    expect(html).toContain('1 cron');
  });
});

describe('toolRegistry / misc', () => {
  test('formatToolName wraps plain tool names', () => {
    expect(formatToolName('Read')).toContain('Read');
  });

  test('formatToolName renders mcp badge for mcp__server__tool', () => {
    const h = formatToolName('mcp__claude-terminal__project_list');
    expect(h).toContain('chat-tool-mcp-badge');
    expect(h).toContain('claude-terminal');
    expect(h).toContain('Project List');
  });

  test('formatDuration handles s/m/h', () => {
    expect(formatDuration(5)).toBe('5s');
    expect(formatDuration(65)).toBe('1m 5s');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3665)).toBe('1h 1m');
  });
});
