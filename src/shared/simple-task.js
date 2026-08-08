/**
 * simple-task.js
 * "Simple mode" for workflows — the Tasks layer.
 *
 * A task is a normal workflow whose `graph` is *generated*, never hand-edited.
 * The user edits a small `simple` payload (what / when / where); everything the
 * scheduler, runner, history and hub already understand is compiled from it.
 *
 *     { mode: 'simple', simple: {...} }  ──compile──>  { trigger, graph, steps }
 *
 * That is the whole trick: zero changes to WorkflowScheduler / WorkflowRunner /
 * WorkflowStorage. A task is indistinguishable from a hand-built workflow once
 * persisted, so "convert to advanced" is just `delete wf.mode`.
 *
 * Shared between main and renderer.
 */

'use strict';

const { nextRunAt, isValidCron } = require('./cron');

// ── Schedule ────────────────────────────────────────────────────────────────

const SCHEDULE_KINDS = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'custom'];

/**
 * Monthly tasks are capped at day 28 on purpose: a cron `30 9 31 * *` silently
 * never fires in February, April, June, September and November. Users picking
 * "the 31st" would get a task that looks scheduled but runs 7 times a year.
 */
const MAX_MONTH_DAY = 28;

const DEFAULT_SCHEDULE = { kind: 'daily', time: '09:00', weekday: 1, day: 1, at: '', cron: '' };

const DEFAULT_SIMPLE = {
  prompt:    '',
  projectId: '',
  cwd:       '',
  // '' = inherit the app default. Simple mode should not force a model choice
  // on users who never asked for one; the advanced disclosure exposes it.
  model:     '',
  effort:    '',
  schedule:  { ...DEFAULT_SCHEDULE },
  notify:    { desktop: true, includeResult: true, discord: '' },
};

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Split "HH:MM" into [hour, minute], falling back to 09:00 on garbage. */
function splitTime(time) {
  const m = String(time ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return [9, 0];
  return [clampInt(m[1], 0, 23, 9), clampInt(m[2], 0, 59, 0)];
}

/** Parse "YYYY-MM-DDTHH:MM" (the value of an <input type="datetime-local">) as LOCAL time. */
function parseLocalDateTime(value) {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compile a schedule descriptor into a 5-field cron expression.
 * @param {Object} schedule
 * @returns {string|null} null when the schedule is incomplete or invalid
 */
function scheduleToCron(schedule) {
  const s = schedule || {};
  const [hour, minute] = splitTime(s.time || DEFAULT_SCHEDULE.time);

  switch (s.kind) {
    case 'once': {
      const d = parseLocalDateTime(s.at);
      if (!d) return null;
      // Pinned to an exact minute of an exact day. The task auto-disables after
      // its first successful run (see isOnce / WorkflowService), so the fact
      // that this expression repeats yearly never matters.
      return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
    }
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly':
      return `${minute} ${hour} * * ${clampInt(s.weekday, 0, 6, 1)}`;
    case 'monthly':
      return `${minute} ${hour} ${clampInt(s.day, 1, MAX_MONTH_DAY, 1)} * *`;
    case 'custom': {
      const expr = String(s.cron || '').trim();
      return expr && isValidCron(expr) ? expr : null;
    }
    default:
      return null;
  }
}

/** True when this task should disable itself after one successful run. */
function isOnce(simple) {
  return simple?.schedule?.kind === 'once';
}

/**
 * Describe a schedule for display, as an i18n key + params.
 * The renderer resolves this with t(); the shared layer stays locale-agnostic.
 * @returns {{ key: string, params: Object }}
 */
function describeSchedule(schedule) {
  const s = schedule || {};
  const time = /^\d{1,2}:\d{2}$/.test(s.time || '') ? s.time : DEFAULT_SCHEDULE.time;
  const [, minute] = splitTime(time);
  switch (s.kind) {
    case 'once':    return { key: 'automation.schedule.desc.once',    params: { at: s.at || '' } };
    case 'hourly':  return { key: 'automation.schedule.desc.hourly',  params: { minute: String(minute).padStart(2, '0') } };
    case 'daily':   return { key: 'automation.schedule.desc.daily',   params: { time } };
    case 'weekly':  return { key: 'automation.schedule.desc.weekly',  params: { weekday: clampInt(s.weekday, 0, 6, 1), time } };
    case 'monthly': return { key: 'automation.schedule.desc.monthly', params: { day: clampInt(s.day, 1, MAX_MONTH_DAY, 1), time } };
    case 'custom':  return { key: 'automation.schedule.desc.custom',  params: { cron: s.cron || '' } };
    default:        return { key: 'automation.schedule.desc.none',    params: {} };
  }
}

/** Next fire time for a task, or null if it is disabled / has no valid schedule. */
function nextRunForTask(workflow, from = new Date()) {
  if (!workflow?.enabled) return null;
  const expr = workflow.trigger?.type === 'cron' ? workflow.trigger.value : null;
  return expr ? nextRunAt(expr, from) : null;
}

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * Coerce an arbitrary `simple` payload into a complete, well-typed one.
 * Never throws — unknown kinds fall back to the default schedule.
 */
function normalizeSimple(raw) {
  const src      = raw && typeof raw === 'object' ? raw : {};
  const rawSched = src.schedule && typeof src.schedule === 'object' ? src.schedule : {};
  const rawNotif = src.notify   && typeof src.notify   === 'object' ? src.notify   : {};

  const kind = SCHEDULE_KINDS.includes(rawSched.kind) ? rawSched.kind : DEFAULT_SCHEDULE.kind;

  return {
    prompt:    typeof src.prompt === 'string' ? src.prompt : '',
    projectId: typeof src.projectId === 'string' ? src.projectId : '',
    cwd:       typeof src.cwd === 'string' ? src.cwd : '',
    model:     typeof src.model  === 'string' ? src.model  : DEFAULT_SIMPLE.model,
    effort:    typeof src.effort === 'string' ? src.effort : DEFAULT_SIMPLE.effort,
    schedule: {
      kind,
      time:    /^\d{1,2}:\d{2}$/.test(rawSched.time || '') ? rawSched.time : DEFAULT_SCHEDULE.time,
      weekday: clampInt(rawSched.weekday, 0, 6, 1),
      day:     clampInt(rawSched.day, 1, MAX_MONTH_DAY, 1),
      at:      typeof rawSched.at === 'string' ? rawSched.at : '',
      cron:    typeof rawSched.cron === 'string' ? rawSched.cron : '',
    },
    notify: {
      desktop:       rawNotif.desktop !== false,
      includeResult: rawNotif.includeResult !== false,
      discord:       typeof rawNotif.discord === 'string' ? rawNotif.discord.trim() : '',
    },
  };
}

// ── Graph synthesis ─────────────────────────────────────────────────────────

const NODE_TRIGGER = 1;
const NODE_CLAUDE  = 2;
const NODE_NOTIFY  = 3;

/**
 * Build the LiteGraph payload for a task.
 *
 * Shape (deliberately minimal — 2 or 3 nodes, one linear exec path):
 *
 *     [trigger cron] ──> [claude prompt] ──Done──> [notify]
 *                                        └─Error──  (unconnected)
 *
 * The Error pin is left dangling on purpose. A connected Error branch would let
 * the run finish as `success` and mask the failure; leaving it open makes the
 * run FAIL, which the card renders in red and which WorkflowService already
 * turns into a desktop notification.
 *
 * `widgets_values` is intentionally omitted: node definitions expose `fields`,
 * not `widgets`, so GraphService rebuilds widgets from `properties` on load
 * (WorkflowGraphEngine.js:998) and properties are the single source of truth.
 *
 * @param {Object} simple  a normalized simple payload
 * @param {string} name    task name, used as the notification title
 */
function buildSimpleGraph(simple, name) {
  const s    = normalizeSimple(simple);
  const cron = scheduleToCron(s.schedule) || '';

  const channels = [
    s.notify.desktop ? 'desktop' : null,
    s.notify.discord ? `discord=${s.notify.discord}` : null,
  ].filter(Boolean);
  const wantsNotify = channels.length > 0;

  const nodes = [];
  const links = [];

  nodes.push({
    id: NODE_TRIGGER,
    type: 'workflow/trigger',
    pos: [80, 180], size: [200, 62],
    properties: { triggerType: 'cron', triggerValue: cron, hookType: 'PostToolUse' },
    inputs:  [],
    outputs: [{ name: 'Start', type: -1, links: [1] }],
    flags: {},
  });

  nodes.push({
    id: NODE_CLAUDE,
    type: 'workflow/claude',
    pos: [400, 180], size: [260, 130],
    properties: {
      mode: 'prompt',
      prompt: s.prompt,
      agentId: '', skillId: '',
      model: s.model,
      effort: s.effort,
      outputSchema: null,
      // Both are written: `cwd` is what claude.node.js executes in, `projectId`
      // is what the advanced editor's project picker reads back.
      projectId: s.projectId,
      cwd: s.cwd,
      maxTurns: 30,
      _customTitle: name || 'Task',
    },
    inputs: [{ name: 'In', type: -1, link: 1 }],
    outputs: [
      { name: 'Done',   type: -1,       links: wantsNotify ? [2] : [] },
      { name: 'Error',  type: -1,       links: [] },
      { name: 'output', type: 'string', links: [] },
      { name: 'result', type: 'any',    links: [] },
    ],
    flags: {},
  });

  links.push([1, NODE_TRIGGER, 0, NODE_CLAUDE, 0, -1]);

  if (wantsNotify) {
    nodes.push({
      id: NODE_NOTIFY,
      type: 'workflow/notify',
      pos: [760, 180], size: [220, 112],
      properties: {
        title: name || 'Task',
        // `$node_2.output` is the Claude step's result (WorkflowRunner stores
        // each step's output under `node_<id>`). A whole-string reference
        // resolves to the raw value; the toast body is line-clamped to 2 lines.
        message: s.notify.includeResult ? `$node_${NODE_CLAUDE}.output` : '',
        channels: channels.join('\n'),
        _customTitle: 'Notify',
      },
      inputs:  [{ name: 'In', type: -1, link: 2 }],
      outputs: [{ name: 'Done', type: -1, links: [] }],
      flags: {},
    });
    links.push([2, NODE_CLAUDE, 0, NODE_NOTIFY, 0, -1]);
  }

  const graph = {
    nodes, links, comments: [],
    last_node_id: nodes[nodes.length - 1].id,
    last_link_id: links.length,
  };

  // Legacy mirror, same derivation as GraphService.serializeToWorkflow().
  const steps = nodes
    .filter(n => n.type !== 'workflow/trigger')
    .map(n => ({
      id: `node_${n.id}`,
      type: n.type.replace('workflow/', ''),
      _nodeId: n.id,
      ...n.properties,
    }));

  return { trigger: { type: 'cron', value: cron }, hookType: 'PostToolUse', graph, steps };
}

/**
 * Compile a task into the full workflow object written to definitions.json.
 * @param {Object} task  { id?, name, enabled?, favorite?, simple }
 */
function compileTask(task) {
  const simple = normalizeSimple(task.simple);
  const name   = String(task.name || '').trim() || 'Task';
  const { trigger, hookType, graph, steps } = buildSimpleGraph(simple, name);

  return {
    ...(task.id ? { id: task.id } : {}),
    name,
    enabled: task.enabled !== false,
    ...(task.favorite ? { favorite: true } : {}),
    mode: 'simple',
    simple,
    trigger,
    hookType,
    scope: 'current',
    concurrency: 'skip',
    graph,
    steps,
    variables: [],
  };
}

/** True when `wf` is a task (simple mode) rather than a hand-built workflow. */
function isSimpleTask(wf) {
  return wf?.mode === 'simple' && !!wf.simple;
}

/** Validate a task before save. @returns {{ valid: boolean, errorKey?: string }} */
function validateTask(task) {
  const name = String(task?.name || '').trim();
  if (!name) return { valid: false, errorKey: 'automation.error.nameRequired' };

  const simple = normalizeSimple(task?.simple);
  if (!simple.prompt.trim()) return { valid: false, errorKey: 'automation.error.promptRequired' };

  if (simple.schedule.kind === 'once' && !parseLocalDateTime(simple.schedule.at)) {
    return { valid: false, errorKey: 'automation.error.dateRequired' };
  }
  if (!scheduleToCron(simple.schedule)) {
    return { valid: false, errorKey: 'automation.error.scheduleInvalid' };
  }
  return { valid: true };
}

// ── Presets ─────────────────────────────────────────────────────────────────

/**
 * Starter tasks shown on the empty state. Titles and prompts are i18n keys —
 * the prompt is what gets sent to Claude, so it must follow the user's locale.
 */
const TASK_PRESETS = [
  {
    id: 'daily-commits',
    icon: 'git',
    titleKey:  'automation.preset.dailyCommits.title',
    descKey:   'automation.preset.dailyCommits.desc',
    promptKey: 'automation.preset.dailyCommits.prompt',
    schedule: { kind: 'daily', time: '09:00' },
  },
  {
    id: 'open-prs',
    icon: 'pr',
    titleKey:  'automation.preset.openPrs.title',
    descKey:   'automation.preset.openPrs.desc',
    promptKey: 'automation.preset.openPrs.prompt',
    schedule: { kind: 'daily', time: '18:00' },
  },
  {
    id: 'todo-scan',
    icon: 'check',
    titleKey:  'automation.preset.todoScan.title',
    descKey:   'automation.preset.todoScan.desc',
    promptKey: 'automation.preset.todoScan.prompt',
    schedule: { kind: 'weekly', weekday: 1, time: '10:00' },
  },
  {
    id: 'weekly-time',
    icon: 'clock',
    titleKey:  'automation.preset.weeklyTime.title',
    descKey:   'automation.preset.weeklyTime.desc',
    promptKey: 'automation.preset.weeklyTime.prompt',
    schedule: { kind: 'weekly', weekday: 5, time: '17:00' },
  },
  {
    id: 'dep-audit',
    icon: 'package',
    titleKey:  'automation.preset.depAudit.title',
    descKey:   'automation.preset.depAudit.desc',
    promptKey: 'automation.preset.depAudit.prompt',
    schedule: { kind: 'monthly', day: 1, time: '09:00' },
  },
  {
    id: 'test-health',
    icon: 'beaker',
    titleKey:  'automation.preset.testHealth.title',
    descKey:   'automation.preset.testHealth.desc',
    promptKey: 'automation.preset.testHealth.prompt',
    schedule: { kind: 'weekly', weekday: 3, time: '14:00' },
  },
];

module.exports = {
  SCHEDULE_KINDS,
  MAX_MONTH_DAY,
  DEFAULT_SCHEDULE,
  DEFAULT_SIMPLE,
  TASK_PRESETS,
  splitTime,
  parseLocalDateTime,
  scheduleToCron,
  describeSchedule,
  nextRunForTask,
  normalizeSimple,
  buildSimpleGraph,
  compileTask,
  isSimpleTask,
  isOnce,
  validateTask,
};
