const {
  scheduleToCron, normalizeSimple, buildSimpleGraph, compileTask,
  isSimpleTask, isOnce, validateTask, describeSchedule, buildTrigger, isEventKind, nextRunForTask,
  MAX_MONTH_DAY, TASK_PRESETS,
} = require('../../src/shared/simple-task');

const { validateWorkflowGraph } = require('../../src/main/services/WorkflowStorage');
const { parseCron } = require('../../src/shared/cron');

describe('scheduleToCron', () => {
  it('compiles each schedule kind', () => {
    expect(scheduleToCron({ kind: 'hourly',  time: '00:20' })).toBe('20 * * * *');
    expect(scheduleToCron({ kind: 'daily',   time: '09:30' })).toBe('30 9 * * *');
    expect(scheduleToCron({ kind: 'weekly',  time: '17:00', weekday: 5 })).toBe('0 17 * * 5');
    expect(scheduleToCron({ kind: 'monthly', time: '09:00', day: 1 })).toBe('0 9 1 * *');
    expect(scheduleToCron({ kind: 'custom',  cron: '*/15 * * * *' })).toBe('*/15 * * * *');
  });

  it('pins a one-shot schedule to its exact minute', () => {
    expect(scheduleToCron({ kind: 'once', at: '2026-08-14T18:45' })).toBe('45 18 14 8 *');
  });

  it('produces expressions the scheduler can parse', () => {
    for (const s of [
      { kind: 'hourly', time: '00:05' },
      { kind: 'daily', time: '23:59' },
      { kind: 'weekly', time: '06:00', weekday: 0 },
      { kind: 'monthly', time: '12:00', day: 28 },
      { kind: 'once', at: '2026-12-31T23:59' },
    ]) {
      expect(() => parseCron(scheduleToCron(s))).not.toThrow();
    }
  });

  it('caps monthly tasks at day 28 so short months never skip', () => {
    expect(scheduleToCron({ kind: 'monthly', time: '09:00', day: 31 }))
      .toBe(`0 9 ${MAX_MONTH_DAY} * *`);
  });

  it('returns null for incomplete or invalid input', () => {
    expect(scheduleToCron({ kind: 'once', at: '' })).toBeNull();
    expect(scheduleToCron({ kind: 'custom', cron: 'nope' })).toBeNull();
    expect(scheduleToCron({ kind: 'custom', cron: '' })).toBeNull();
    expect(scheduleToCron({ kind: 'bogus' })).toBeNull();
    expect(scheduleToCron(null)).toBeNull();
  });
});

describe('normalizeSimple', () => {
  it('fills in a complete payload from nothing', () => {
    const s = normalizeSimple(undefined);
    expect(s.prompt).toBe('');
    expect(s.when.kind).toBe('daily');
    expect(s.notify.desktop).toBe(true);
  });

  it('coerces out-of-range values instead of throwing', () => {
    const s = normalizeSimple({
      when: { kind: 'weekly', weekday: 99, day: 999, time: 'garbage' },
      notify: { desktop: false, discord: '  https://x  ' },
    });
    expect(s.when.weekday).toBe(6);
    expect(s.when.day).toBe(MAX_MONTH_DAY);
    expect(s.when.time).toBe('09:00');
    expect(s.notify.desktop).toBe(false);
    expect(s.notify.discord).toBe('https://x');
  });

  it('falls back to the default kind for an unknown one', () => {
    expect(normalizeSimple({ when: { kind: 'fortnightly' } }).when.kind).toBe('daily');
  });

  it('accepts an event kind', () => {
    expect(normalizeSimple({ when: { kind: 'git' } }).when.kind).toBe('git');
  });

  it('migrates the legacy `schedule` key onto `when`', () => {
    // Tasks saved before event triggers existed used `schedule`. There is no
    // migration step anywhere else, so normalizeSimple is the only thing
    // standing between an old task and a silent reset to the daily default.
    const s = normalizeSimple({ schedule: { kind: 'weekly', weekday: 5, time: '17:30' } });
    expect(s.when.kind).toBe('weekly');
    expect(s.when.weekday).toBe(5);
    expect(s.when.time).toBe('17:30');
  });

  it('prefers `when` when a payload somehow carries both', () => {
    const s = normalizeSimple({ when: { kind: 'git' }, schedule: { kind: 'monthly' } });
    expect(s.when.kind).toBe('git');
  });

  it('coerces unknown event filter values to their defaults', () => {
    const s = normalizeSimple({ when: { kind: 'git', gitEvent: 'nope', exitCode: 'x', status: 'y' } });
    expect(s.when.gitEvent).toBe('any');
    expect(s.when.exitCode).toBe('error');
    expect(s.when.status).toBe('any');
  });
});

describe('buildTrigger', () => {
  const withKind = (kind, extra = {}) =>
    buildTrigger(normalizeSimple({ projectId: 'proj-1', when: { kind, ...extra } }));

  it('compiles a schedule to a cron trigger', () => {
    expect(withKind('daily', { time: '09:00' })).toEqual({ type: 'cron', value: '0 9 * * *' });
  });

  // Every key below has to match what WorkflowScheduler reads; a key it does
  // not recognise is ignored silently rather than reported.
  it('builds a git_event trigger scoped to the project', () => {
    expect(withKind('git', { gitEvent: 'push' })).toEqual({
      type: 'git_event', value: '', projectId: 'proj-1', eventFilter: 'push',
    });
  });

  it('builds a file_change trigger with the watcher defaults', () => {
    expect(withKind('file_change', { patterns: 'src/**/*.js' })).toEqual({
      type: 'file_change', value: '', projectId: 'proj-1',
      patterns: 'src/**/*.js', events: 'all', debounceMs: 500,
    });
  });

  it('builds a terminal_exit_code trigger', () => {
    expect(withKind('command_fails', { exitCode: 'error' })).toEqual({
      type: 'terminal_exit_code', value: '', projectId: 'proj-1', codeFilter: 'error',
    });
  });

  it('builds a claude_session_end trigger', () => {
    expect(withKind('session_end', { status: 'error' })).toEqual({
      type: 'claude_session_end', value: '', projectId: 'proj-1', statusFilter: 'error',
    });
  });

  it('builds a project_opened trigger', () => {
    expect(withKind('project_open')).toEqual({
      type: 'project_opened', value: '', projectId: 'proj-1',
    });
  });

  it('falls back to an unrecognised filter default rather than passing it through', () => {
    expect(withKind('git', { gitEvent: 'nonsense' }).eventFilter).toBe('any');
  });
});

describe('buildSimpleGraph', () => {
  const simple = normalizeSimple({
    prompt: 'Summarize yesterday',
    projectId: 'proj_1',
    cwd: 'E:/repo',
    when: { kind: 'daily', time: '09:00' },
  });

  it('produces a trigger -> claude -> notify chain', () => {
    const { graph, trigger } = buildSimpleGraph(simple, 'Daily');
    expect(trigger).toEqual({ type: 'cron', value: '0 9 * * *' });
    expect(graph.nodes.map(n => n.type)).toEqual([
      'workflow/trigger', 'workflow/claude', 'workflow/notify',
    ]);
    expect(graph.links).toEqual([
      [1, 1, 0, 2, 0, -1],
      [2, 2, 0, 3, 0, -1],
    ]);
    expect(graph.last_node_id).toBe(3);
    expect(graph.last_link_id).toBe(2);
  });

  it('drops the notify node when every channel is off', () => {
    const quiet = normalizeSimple({ ...simple, notify: { desktop: false, discord: '' } });
    const { graph } = buildSimpleGraph(quiet, 'Quiet');
    expect(graph.nodes.map(n => n.type)).toEqual(['workflow/trigger', 'workflow/claude']);
    expect(graph.links).toEqual([[1, 1, 0, 2, 0, -1]]);
    expect(graph.nodes[1].outputs[0].links).toEqual([]);
  });

  it('leaves the Claude Error pin unconnected so failures surface as failed runs', () => {
    const { graph } = buildSimpleGraph(simple, 'Daily');
    const claude = graph.nodes.find(n => n.type === 'workflow/claude');
    expect(claude.outputs[1].name).toBe('Error');
    expect(claude.outputs[1].links).toEqual([]);
  });

  it('writes both cwd and projectId onto the Claude node', () => {
    const { graph } = buildSimpleGraph(simple, 'Daily');
    const claude = graph.nodes.find(n => n.type === 'workflow/claude');
    expect(claude.properties.cwd).toBe('E:/repo');
    expect(claude.properties.projectId).toBe('proj_1');
    expect(claude.properties.prompt).toBe('Summarize yesterday');
  });

  it('references the Claude step output in the notification body', () => {
    const { graph } = buildSimpleGraph(simple, 'Daily');
    const notify = graph.nodes.find(n => n.type === 'workflow/notify');
    expect(notify.properties.message).toBe('$node_2.output');
    expect(notify.properties.channels).toBe('desktop');
  });

  it('omits the result reference when includeResult is off', () => {
    const s = normalizeSimple({ ...simple, notify: { desktop: true, includeResult: false } });
    const { graph } = buildSimpleGraph(s, 'Daily');
    expect(graph.nodes.find(n => n.type === 'workflow/notify').properties.message).toBe('');
  });

  it('adds a discord channel line when a webhook is configured', () => {
    const s = normalizeSimple({ ...simple, notify: { desktop: true, discord: 'https://hook' } });
    const { graph } = buildSimpleGraph(s, 'Daily');
    expect(graph.nodes.find(n => n.type === 'workflow/notify').properties.channels)
      .toBe('desktop\ndiscord=https://hook');
  });

  it('mirrors non-trigger nodes into steps[]', () => {
    const { steps } = buildSimpleGraph(simple, 'Daily');
    expect(steps.map(s => s.type)).toEqual(['claude', 'notify']);
    expect(steps[0].id).toBe('node_2');
    expect(steps[0]._nodeId).toBe(2);
  });
});

describe('compileTask', () => {
  const task = {
    id: 'wf_abc',
    name: '  Daily summary  ',
    simple: { prompt: 'Do the thing', when: { kind: 'daily', time: '07:15' } },
  };

  it('produces a workflow the storage validator accepts', () => {
    const wf = compileTask(task);
    expect(validateWorkflowGraph(wf)).toEqual({ valid: true });
  });

  it('trims the name and marks the workflow as simple mode', () => {
    const wf = compileTask(task);
    expect(wf.name).toBe('Daily summary');
    expect(wf.mode).toBe('simple');
    expect(isSimpleTask(wf)).toBe(true);
    expect(wf.trigger).toEqual({ type: 'cron', value: '15 7 * * *' });
  });

  it('is idempotent — recompiling a compiled task yields the same graph', () => {
    const once  = compileTask(task);
    const twice = compileTask(once);
    expect(twice.graph).toEqual(once.graph);
    expect(twice.trigger).toEqual(once.trigger);
    expect(twice.simple).toEqual(once.simple);
  });

  it('defaults an unnamed task rather than persisting an empty name', () => {
    expect(compileTask({ name: '   ', simple: {} }).name).toBe('Task');
  });

  it('omits the id when creating so storage assigns one', () => {
    expect(compileTask({ name: 'New', simple: {} })).not.toHaveProperty('id');
  });

  it('leaves a hand-built workflow unrecognised as a task', () => {
    expect(isSimpleTask({ name: 'graph', graph: {} })).toBe(false);
    expect(isSimpleTask({ mode: 'simple' })).toBe(false);
    expect(isSimpleTask(null)).toBe(false);
  });
});

describe('validateTask', () => {
  const ok = { name: 'X', simple: { prompt: 'p', when: { kind: 'daily', time: '09:00' } } };

  it('accepts a complete task', () => {
    expect(validateTask(ok)).toEqual({ valid: true });
  });

  it('rejects a missing name or prompt', () => {
    expect(validateTask({ ...ok, name: '  ' }).errorKey).toBe('automation.error.nameRequired');
    expect(validateTask({ ...ok, simple: { ...ok.simple, prompt: '  ' } }).errorKey)
      .toBe('automation.error.promptRequired');
  });

  it('rejects a one-shot task with no date', () => {
    expect(validateTask({ ...ok, simple: { prompt: 'p', when: { kind: 'once', at: '' } } }).errorKey)
      .toBe('automation.error.dateRequired');
  });

  it('rejects an invalid custom cron', () => {
    expect(validateTask({ ...ok, simple: { prompt: 'p', when: { kind: 'custom', cron: 'x' } } }).errorKey)
      .toBe('automation.error.scheduleInvalid');
  });
});

describe('isOnce', () => {
  it('only flags one-shot schedules', () => {
    expect(isOnce({ when: { kind: 'once' } })).toBe(true);
    expect(isOnce({ when: { kind: 'daily' } })).toBe(false);
    expect(isOnce(undefined)).toBe(false);
  });
});

describe('describeSchedule', () => {
  it('returns an i18n key plus params for each kind', () => {
    expect(describeSchedule({ kind: 'daily', time: '09:00' }))
      .toEqual({ key: 'automation.schedule.desc.daily', params: { time: '09:00' } });
    expect(describeSchedule({ kind: 'hourly', time: '00:05' }).params.minute).toBe('05');
    expect(describeSchedule({}).key).toBe('automation.schedule.desc.none');
  });
});

describe('TASK_PRESETS', () => {
  it('every preset compiles into a valid workflow', () => {
    for (const preset of TASK_PRESETS) {
      const wf = compileTask({
        name: preset.id,
        simple: { prompt: 'preset prompt', when: preset.schedule },
      });
      expect(validateWorkflowGraph(wf)).toEqual({ valid: true });
      expect(() => parseCron(wf.trigger.value)).not.toThrow();
    }
  });

  it('has unique ids and complete i18n key sets', () => {
    const ids = TASK_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of TASK_PRESETS) {
      expect(p.titleKey).toMatch(/^automation\.preset\./);
      expect(p.descKey).toMatch(/^automation\.preset\./);
      expect(p.promptKey).toMatch(/^automation\.preset\./);
    }
  });
});

describe('event tasks end to end', () => {
  it('compiles into a workflow the storage validator accepts', () => {
    for (const kind of ['git', 'file_change', 'command_fails', 'session_end', 'project_open']) {
      const wf = compileTask({
        name: kind,
        simple: { prompt: 'do it', projectId: 'proj-1', when: { kind } },
      });
      expect(validateWorkflowGraph(wf)).toEqual({ valid: true });
      expect(wf.trigger.type).not.toBe('cron');
    }
  });

  it('mirrors the trigger onto the trigger node so the advanced editor agrees', () => {
    const wf = compileTask({
      name: 'On push',
      simple: { prompt: 'x', projectId: 'proj-1', when: { kind: 'git', gitEvent: 'push' } },
    });
    const node = wf.graph.nodes.find(n => n.type === 'workflow/trigger');
    expect(node.properties.triggerType).toBe('git_event');
    expect(node.properties.eventFilter).toBe('push');
    expect(node.properties.projectId).toBe('proj-1');
  });

  it('has no next run, because an event is not a clock', () => {
    const wf = compileTask({
      name: 'On push',
      simple: { prompt: 'x', projectId: 'proj-1', when: { kind: 'git' } },
    });
    expect(nextRunForTask({ ...wf, enabled: true })).toBeNull();
  });

  it('refuses to save a repository-watched event with no project', () => {
    // WorkflowScheduler installs nothing when projectId is empty and says
    // nothing about it, so the task would look armed and never fire.
    for (const kind of ['git', 'file_change']) {
      const res = validateTask({ name: 'x', simple: { prompt: 'p', when: { kind } } });
      expect(res.valid).toBe(false);
      expect(res.errorKey).toBe('automation.error.projectRequired');
    }
  });

  it('allows the events that are not scoped to a repository', () => {
    for (const kind of ['command_fails', 'session_end', 'project_open']) {
      expect(validateTask({ name: 'x', simple: { prompt: 'p', when: { kind } } }))
        .toEqual({ valid: true });
    }
  });

  it('only treats one-shot schedules as one-shot', () => {
    expect(isOnce({ when: { kind: 'git' } })).toBe(false);
    expect(isEventKind('git')).toBe(true);
    expect(isEventKind('daily')).toBe(false);
  });
});
