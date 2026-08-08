const {
  scheduleToCron, normalizeSimple, buildSimpleGraph, compileTask,
  isSimpleTask, isOnce, validateTask, describeSchedule,
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
    expect(s.schedule.kind).toBe('daily');
    expect(s.notify.desktop).toBe(true);
  });

  it('coerces out-of-range values instead of throwing', () => {
    const s = normalizeSimple({
      schedule: { kind: 'weekly', weekday: 99, day: 999, time: 'garbage' },
      notify: { desktop: false, discord: '  https://x  ' },
    });
    expect(s.schedule.weekday).toBe(6);
    expect(s.schedule.day).toBe(MAX_MONTH_DAY);
    expect(s.schedule.time).toBe('09:00');
    expect(s.notify.desktop).toBe(false);
    expect(s.notify.discord).toBe('https://x');
  });

  it('falls back to the default kind for an unknown one', () => {
    expect(normalizeSimple({ schedule: { kind: 'fortnightly' } }).schedule.kind).toBe('daily');
  });
});

describe('buildSimpleGraph', () => {
  const simple = normalizeSimple({
    prompt: 'Summarize yesterday',
    projectId: 'proj_1',
    cwd: 'E:/repo',
    schedule: { kind: 'daily', time: '09:00' },
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
    simple: { prompt: 'Do the thing', schedule: { kind: 'daily', time: '07:15' } },
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
  const ok = { name: 'X', simple: { prompt: 'p', schedule: { kind: 'daily', time: '09:00' } } };

  it('accepts a complete task', () => {
    expect(validateTask(ok)).toEqual({ valid: true });
  });

  it('rejects a missing name or prompt', () => {
    expect(validateTask({ ...ok, name: '  ' }).errorKey).toBe('automation.error.nameRequired');
    expect(validateTask({ ...ok, simple: { ...ok.simple, prompt: '  ' } }).errorKey)
      .toBe('automation.error.promptRequired');
  });

  it('rejects a one-shot task with no date', () => {
    expect(validateTask({ ...ok, simple: { prompt: 'p', schedule: { kind: 'once', at: '' } } }).errorKey)
      .toBe('automation.error.dateRequired');
  });

  it('rejects an invalid custom cron', () => {
    expect(validateTask({ ...ok, simple: { prompt: 'p', schedule: { kind: 'custom', cron: 'x' } } }).errorKey)
      .toBe('automation.error.scheduleInvalid');
  });
});

describe('isOnce', () => {
  it('only flags one-shot schedules', () => {
    expect(isOnce({ schedule: { kind: 'once' } })).toBe(true);
    expect(isOnce({ schedule: { kind: 'daily' } })).toBe(false);
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
        simple: { prompt: 'preset prompt', schedule: preset.schedule },
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
