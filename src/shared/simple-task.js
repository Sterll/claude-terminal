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
 * Event kinds a task can react to, on top of the clock.
 *
 * Only triggers that need at most ONE extra choice are exposed here — the point
 * of simple mode is that the task's own project supplies the scope, so most of
 * these need no configuration at all. Everything richer (hook types, chat
 * patterns, workflow chaining) stays in the advanced editor.
 *
 * `needsProject` marks the ones whose watcher is installed per repository:
 * WorkflowScheduler silently installs nothing when their projectId is empty,
 * so the task must refuse to save rather than look armed and never fire.
 */
const EVENT_KINDS = {
  git:           { trigger: 'git_event',           needsProject: true  },
  file_change:   { trigger: 'file_change',         needsProject: true  },
  command_fails: { trigger: 'terminal_exit_code',  needsProject: false },
  // Both fire once per turn, when Claude stops talking. session_end carries the
  // turn's status, chat_reply carries the reply text — and the pattern filter it
  // enables is what makes the second one worth having on its own.
  session_end:   { trigger: 'claude_session_end',  needsProject: false },
  chat_reply:    { trigger: 'chat_message',        needsProject: false },
  project_open:  { trigger: 'project_opened',      needsProject: false },
};

const EVENT_KIND_NAMES = Object.keys(EVENT_KINDS);
const WHEN_KINDS = [...SCHEDULE_KINDS, ...EVENT_KIND_NAMES];

/** True when this kind fires on an event rather than on the clock. */
function isEventKind(kind) {
  return Object.prototype.hasOwnProperty.call(EVENT_KINDS, kind);
}

/**
 * Monthly tasks are capped at day 28 on purpose: a cron `30 9 31 * *` silently
 * never fires in February, April, June, September and November. Users picking
 * "the 31st" would get a task that looks scheduled but runs 7 times a year.
 */
const MAX_MONTH_DAY = 28;

const DEFAULT_SCHEDULE = {
  kind: 'daily', time: '09:00', weekday: 1, day: 1, at: '', cron: '',
  // Event fields, all optional and only read for their own kind.
  gitEvent: 'any',      // any | commit | push | branch_switch
  exitCode: 'error',    // any | success | error
  status:   'any',      // any | success | error   (claude session end)
  patterns: '',         // file_change glob, empty = everything watched
  pattern:  '',         // chat_reply text filter, empty = every reply
  matchMode: 'contains',// contains | regex
  // WHICH project the event watches. Separate from simple.projectId, which is
  // where Claude runs — "when I push in the API, summarise it in my notes" is a
  // real thing to want.
  //
  // Three states, not two: '' means "not chosen" and falls back to the run
  // project, which is how tasks saved before this field existed keep behaving.
  // ANY_PROJECT is the EXPLICIT "watch everything" — without a distinct value
  // the fallback would silently override the user's choice whenever a run
  // project was set, making "any project" unselectable.
  projectId: '',
};

/** Sentinel for "watch every project", distinct from "not chosen". */
const ANY_PROJECT = '__any__';

const DEFAULT_SIMPLE = {
  prompt:    '',
  projectId: '',
  cwd:       '',
  // '' = inherit the app default. Simple mode should not force a model choice
  // on users who never asked for one; the advanced disclosure exposes it.
  model:     '',
  effort:    '',
  // Named `when` because it now holds either a clock schedule or an event.
  // Tasks saved before events existed carry `schedule`; normalizeSimple migrates.
  when:      { ...DEFAULT_SCHEDULE },
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
  return (simple?.when || simple?.schedule)?.kind === 'once';
}

/**
 * Describe when a task runs, as an i18n key + params.
 * The renderer resolves this with t(); the shared layer stays locale-agnostic.
 * @returns {{ key: string, params: Object }}
 */
function describeSchedule(when) {
  const s = when || {};
  const time = /^\d{1,2}:\d{2}$/.test(s.time || '') ? s.time : DEFAULT_SCHEDULE.time;
  const [, minute] = splitTime(time);
  switch (s.kind) {
    case 'once':    return { key: 'automation.schedule.desc.once',    params: { at: s.at || '' } };
    case 'hourly':  return { key: 'automation.schedule.desc.hourly',  params: { minute: String(minute).padStart(2, '0') } };
    case 'daily':   return { key: 'automation.schedule.desc.daily',   params: { time } };
    case 'weekly':  return { key: 'automation.schedule.desc.weekly',  params: { weekday: clampInt(s.weekday, 0, 6, 1), time } };
    case 'monthly': return { key: 'automation.schedule.desc.monthly', params: { day: clampInt(s.day, 1, MAX_MONTH_DAY, 1), time } };
    case 'custom':  return { key: 'automation.schedule.desc.custom',  params: { cron: s.cron || '' } };

    // Event kinds. The filter is folded into the key so each reads as a real
    // sentence rather than "Git event (commit)".
    case 'git':           return { key: `automation.event.desc.git.${ONE_OF(s.gitEvent, ['any', 'commit', 'push', 'branch_switch'], 'any')}`, params: {} };
    case 'file_change':   return { key: s.patterns ? 'automation.event.desc.fileChangePattern' : 'automation.event.desc.fileChange', params: { patterns: s.patterns || '' } };
    case 'command_fails': return { key: `automation.event.desc.command.${ONE_OF(s.exitCode, ['any', 'success', 'error'], 'error')}`, params: {} };
    case 'session_end':   return { key: `automation.event.desc.session.${ONE_OF(s.status, ['any', 'success', 'error'], 'any')}`, params: {} };
    case 'chat_reply':    return { key: s.pattern ? 'automation.event.desc.chatReplyPattern' : 'automation.event.desc.chatReply', params: { pattern: s.pattern || '' } };
    case 'project_open':  return { key: 'automation.event.desc.projectOpen', params: {} };

    default:        return { key: 'automation.schedule.desc.none',    params: {} };
  }
}

/**
 * Next fire time for a task, or null when it is disabled, event-driven, or has
 * no valid schedule. An event task has no next run by definition.
 */
function nextRunForTask(workflow, from = new Date()) {
  if (!workflow?.enabled) return null;
  const expr = workflow.trigger?.type === 'cron' ? workflow.trigger.value : null;
  return expr ? nextRunAt(expr, from) : null;
}

// ── Trigger construction ────────────────────────────────────────────────────

const ONE_OF = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * Build the workflow `trigger` object for a task.
 *
 * Every key here has to match what WorkflowScheduler reads, exactly — it is the
 * only consumer, and a key it does not recognise is silently ignored rather
 * than reported.
 *
 * @param {Object} simple  a normalized simple payload
 * @returns {Object} trigger
 */
function buildTrigger(simple) {
  const when = simple.when;
  // The event's own project wins; ANY_PROJECT means watch everything, and an
  // unset value falls back to the run project so tasks saved before the two
  // were separated keep behaving exactly as they did.
  const project = when.projectId === ANY_PROJECT
    ? ''
    : (when.projectId || simple.projectId || '');

  switch (when.kind) {
    case 'git':
      return {
        type: 'git_event',
        value: '',
        projectId: project,
        eventFilter: ONE_OF(when.gitEvent, ['any', 'commit', 'push', 'branch_switch'], 'any'),
      };

    case 'file_change':
      return {
        type: 'file_change',
        value: '',
        projectId: project,
        patterns: when.patterns || '',
        events: 'all',
        debounceMs: 500,
      };

    case 'command_fails':
      return {
        type: 'terminal_exit_code',
        value: '',
        projectId: project,
        codeFilter: ONE_OF(when.exitCode, ['any', 'success', 'error'], 'error'),
      };

    case 'session_end':
      return {
        type: 'claude_session_end',
        value: '',
        projectId: project,
        statusFilter: ONE_OF(when.status, ['any', 'success', 'error'], 'any'),
      };

    case 'chat_reply':
      return {
        type: 'chat_message',
        value: '',
        projectId: project,
        role: 'assistant',
        pattern: when.pattern || '',
        // Plain substring unless the user asked for a regex; the scheduler
        // pre-compiles regexes and caps the tested text against ReDoS.
        matchMode: ONE_OF(when.matchMode, ['contains', 'regex'], 'contains'),
      };

    case 'project_open':
      return { type: 'project_opened', value: '', projectId: project };

    default:
      return { type: 'cron', value: scheduleToCron(when) || '' };
  }
}

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * Coerce an arbitrary `simple` payload into a complete, well-typed one.
 * Never throws — unknown kinds fall back to the default schedule.
 *
 * Accepts the legacy `schedule` key: tasks saved before event triggers existed
 * used that name, and there is no migration step anywhere else to do it.
 */
function normalizeSimple(raw) {
  const src      = raw && typeof raw === 'object' ? raw : {};
  const rawWhen  = (src.when && typeof src.when === 'object' ? src.when
                 : src.schedule && typeof src.schedule === 'object' ? src.schedule
                 : {});
  const rawNotif = src.notify && typeof src.notify === 'object' ? src.notify : {};

  const kind = WHEN_KINDS.includes(rawWhen.kind) ? rawWhen.kind : DEFAULT_SCHEDULE.kind;

  return {
    prompt:    typeof src.prompt === 'string' ? src.prompt : '',
    projectId: typeof src.projectId === 'string' ? src.projectId : '',
    cwd:       typeof src.cwd === 'string' ? src.cwd : '',
    model:     typeof src.model  === 'string' ? src.model  : DEFAULT_SIMPLE.model,
    effort:    typeof src.effort === 'string' ? src.effort : DEFAULT_SIMPLE.effort,
    when: {
      kind,
      time:    /^\d{1,2}:\d{2}$/.test(rawWhen.time || '') ? rawWhen.time : DEFAULT_SCHEDULE.time,
      weekday: clampInt(rawWhen.weekday, 0, 6, 1),
      day:     clampInt(rawWhen.day, 1, MAX_MONTH_DAY, 1),
      at:      typeof rawWhen.at === 'string' ? rawWhen.at : '',
      cron:    typeof rawWhen.cron === 'string' ? rawWhen.cron : '',
      gitEvent: ONE_OF(rawWhen.gitEvent, ['any', 'commit', 'push', 'branch_switch'], 'any'),
      exitCode: ONE_OF(rawWhen.exitCode, ['any', 'success', 'error'], 'error'),
      status:   ONE_OF(rawWhen.status,   ['any', 'success', 'error'], 'any'),
      patterns: typeof rawWhen.patterns === 'string' ? rawWhen.patterns : '',
      pattern:  typeof rawWhen.pattern  === 'string' ? rawWhen.pattern  : '',
      matchMode: ONE_OF(rawWhen.matchMode, ['contains', 'regex'], 'contains'),
      projectId: typeof rawWhen.projectId === 'string' ? rawWhen.projectId : '',
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
  const s       = normalizeSimple(simple);
  const trigger = buildTrigger(s);

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
    // The trigger node's properties mirror the trigger object key for key, so
    // opening the task in the advanced editor shows the same configuration.
    properties: {
      ...trigger,
      triggerType:  trigger.type,
      triggerValue: trigger.value || '',
      hookType: 'PostToolUse',
    },
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

  return { trigger, hookType: 'PostToolUse', graph, steps };
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

  const kind = simple.when.kind;

  if (isEventKind(kind)) {
    // WorkflowScheduler installs per-repository watchers for these and bails
    // when projectId is empty — with no warning. Refusing here is the only way
    // the task does not end up looking armed while watching nothing.
    if (EVENT_KINDS[kind].needsProject && !buildTrigger(simple).projectId) {
      return { valid: false, errorKey: 'automation.error.projectRequired' };
    }
    return { valid: true };
  }

  if (kind === 'once' && !parseLocalDateTime(simple.when.at)) {
    return { valid: false, errorKey: 'automation.error.dateRequired' };
  }
  if (!scheduleToCron(simple.when)) {
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
  ANY_PROJECT,
  EVENT_KINDS,
  EVENT_KIND_NAMES,
  WHEN_KINDS,
  isEventKind,
  buildTrigger,
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
