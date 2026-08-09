'use strict';

/**
 * Automation Tools Module for Claude Terminal MCP
 *
 * Automations (the "Tasks" layer) are workflows with `mode: 'simple'`: the user
 * edits a small `simple` payload — a prompt, when to run it, where — and the
 * whole graph is COMPILED from it by src/shared/simple-task.js.
 *
 * That is why these tools exist instead of pointing agents at workflow_create:
 * a graph built by hand is not an automation, and editing an automation's nodes
 * is pointless because the next save from the UI regenerates them from `simple`.
 * Everything here goes through compileTask(), the exact same function the
 * renderer calls, so an automation created from MCP is byte-identical to one
 * created from the Automations tab.
 *
 * Reading runs, triggering manually and diagnosing failures are NOT duplicated
 * here — an automation is a workflow on disk, so workflow_runs / workflow_trigger
 * / workflow_run_logs / workflow_diagnose already accept its ID.
 *
 * Tools: automation_list, automation_get, automation_create, automation_update,
 *        automation_delete, automation_enable
 */

const path = require('path');

const store = require('./_workflowStore');
const { loadProjects } = require('./_projectsCache');

// Resolve the shared task compiler: packaged app (extraResources) → dev repo.
// Same dual-path shape workflow.js uses for the node registry. Without it the
// module still loads but every tool fails loudly rather than writing a payload
// the app cannot read.
let simpleTask = null;
let simpleTaskError = null;
try {
  // Packaged app: src/shared/ is copied alongside mcp-servers/ as extraResources
  simpleTask = require(path.join(__dirname, '..', 'shared', 'simple-task'));
} catch (_) {
  try {
    // Dev environment: src/shared/ relative to the repo root
    simpleTask = require(path.join(__dirname, '..', '..', '..', 'src', 'shared', 'simple-task'));
  } catch (e) {
    simpleTaskError = e.message;
    process.stderr.write(`[ct-mcp:automation] simple-task unavailable, tools disabled: ${e.message}\n`);
  }
}

function log(...args) {
  process.stderr.write(`[ct-mcp:automation] ${args.join(' ')}\n`);
}

// -- Vocabulary ---------------------------------------------------------------

const CLOCK_KINDS = ['once', 'hourly', 'daily', 'weekly', 'monthly', 'custom'];
const EVENT_WHEN_KINDS = ['git', 'file_change', 'command_fails', 'session_end', 'chat_reply', 'project_open'];
const WHEN_KINDS = [...CLOCK_KINDS, ...EVENT_WHEN_KINDS];

/**
 * True when this event's watcher is installed per repository, so it cannot
 * watch "any project" — the same rule the Automations tab uses to hide the
 * "Any project" option (TasksView.js: anyAllowed = !needsProject).
 */
function needsRealProject(kind) {
  return !!simpleTask.EVENT_KINDS[kind]?.needsProject;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// validateTask returns i18n keys; the MCP layer has no locale, so it speaks its
// own English. Each message says what to pass, not just what is wrong.
const VALIDATION_MESSAGES = {
  'automation.error.nameRequired': 'name is required.',
  'automation.error.promptRequired': 'prompt is required — it is what Claude will be asked to do.',
  'automation.error.projectRequired':
    'This event installs a watcher on one repository, so it needs a specific project: pass `watch_project` '
    + '(or `project`, which it falls back to) as a project name or ID. "any" is not possible for this event.',
  'automation.error.dateRequired': 'when="once" needs `at` as "YYYY-MM-DDTHH:MM" (local time).',
  'automation.error.scheduleInvalid': 'The schedule is incomplete or invalid (check `time`, `day`, `weekday` or `cron`).',
};

// -- Project resolution -------------------------------------------------------

/**
 * Resolve a project name / ID / path to its ID.
 * @returns {{ id: string }|{ error: string }}  '' means "not set", never an error
 */
function resolveProject(value, { allowAny = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return { id: '' };
  if (allowAny && (raw === 'any' || raw === '*' || raw === simpleTask.ANY_PROJECT)) {
    return { id: simpleTask.ANY_PROJECT };
  }

  const projects = loadProjects().projects || [];
  const lower = raw.toLowerCase();
  const match = projects.find(p => p.id === raw)
    || projects.find(p => (p.name || '').toLowerCase() === lower)
    || projects.find(p => (p.path || '').toLowerCase() === lower);

  if (!match) {
    const names = projects.slice(0, 12).map(p => p.name).filter(Boolean).join(', ');
    return { error: `Project "${raw}" not found.${names ? ` Known projects: ${names}` : ''}` };
  }
  return { id: match.id };
}

function projectLabel(id) {
  if (!id) return 'none';
  if (id === simpleTask.ANY_PROJECT) return 'any project';
  const match = (loadProjects().projects || []).find(p => p.id === id);
  return match ? `${match.name} (${id})` : id;
}

// -- Describing ---------------------------------------------------------------

/** Plain-English mirror of describeSchedule(), which returns i18n keys. */
function describeWhen(when) {
  const w = when || {};
  const time = w.time || '09:00';
  switch (w.kind) {
    case 'once':    return `once, on ${w.at || '(no date)'}`;
    case 'hourly':  return `every hour at :${String(simpleTask.splitTime(time)[1]).padStart(2, '0')}`;
    case 'daily':   return `every day at ${time}`;
    case 'weekly':  return `every ${WEEKDAYS[w.weekday] || 'Monday'} at ${time}`;
    case 'monthly': return `on day ${w.day || 1} of each month at ${time}`;
    case 'custom':  return `cron: ${w.cron || '(none)'}`;

    case 'git':
      return w.gitEvent && w.gitEvent !== 'any' ? `on git ${w.gitEvent}` : 'on any git activity';
    case 'file_change':
      return w.patterns ? `when files matching "${w.patterns}" change` : 'when any watched file changes';
    case 'command_fails':
      return `when a terminal command ${({ any: 'finishes', success: 'succeeds', error: 'fails' })[w.exitCode] || 'fails'}`;
    case 'session_end':
      return `when a Claude session ends ${({ any: '(any outcome)', success: 'successfully', error: 'with an error' })[w.status] || '(any outcome)'}`;
    case 'chat_reply':
      return w.pattern
        ? `when a Claude reply ${w.matchMode === 'regex' ? 'matches regex' : 'contains'} "${w.pattern}"`
        : 'when Claude finishes replying';
    case 'project_open':
      return 'when the project is opened';
    default:
      return 'no schedule';
  }
}

function formatDuration(ms) {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function lastRunOf(history, id) {
  return history
    .filter(r => r.workflowId === id)
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))[0] || null;
}

function formatLastRun(run) {
  if (!run) return 'never';
  return `${run.status || 'unknown'} (${formatDuration(run.durationMs || run.duration)}) at ${run.startedAt || '?'}`;
}

// -- Payload building ---------------------------------------------------------

/** Automations only — a hand-built workflow must not be reachable from here. */
function findAutomation(nameOrId) {
  const defs = store.loadDefinitions().filter(simpleTask.isSimpleTask);
  const lower = String(nameOrId || '').toLowerCase();
  return defs.find(w => w.id === nameOrId)
    || defs.find(w => (w.name || '').toLowerCase() === lower)
    || null;
}

/**
 * Merge tool arguments over an existing `simple` payload.
 * Only keys actually present in `args` are touched, so automation_update can
 * change the prompt without resetting the schedule.
 *
 * @returns {{ simple: Object }|{ error: string }}
 */
function buildSimple(args, base) {
  const prev = simpleTask.normalizeSimple(base);
  const has = key => Object.prototype.hasOwnProperty.call(args, key) && args[key] !== undefined && args[key] !== null;

  const simple = {
    ...prev,
    when: { ...prev.when },
    notify: { ...prev.notify },
  };

  if (has('prompt')) simple.prompt = String(args.prompt);
  if (has('cwd')) simple.cwd = String(args.cwd);
  if (has('model')) simple.model = String(args.model);
  if (has('effort')) simple.effort = String(args.effort);

  if (has('project')) {
    const resolved = resolveProject(args.project);
    if (resolved.error) return { error: resolved.error };
    simple.projectId = resolved.id;
  }

  if (has('when')) {
    const kind = String(args.when);
    if (!WHEN_KINDS.includes(kind)) {
      return { error: `Unknown when="${kind}". Use one of: ${WHEN_KINDS.join(', ')}.` };
    }
    simple.when.kind = kind;
  }

  // Clock fields
  if (has('time')) simple.when.time = String(args.time);
  if (has('weekday')) simple.when.weekday = args.weekday;
  if (has('day')) simple.when.day = args.day;
  if (has('at')) simple.when.at = String(args.at);
  if (has('cron')) simple.when.cron = String(args.cron);

  // Event filters
  if (has('git_event')) simple.when.gitEvent = String(args.git_event);
  if (has('exit_code')) simple.when.exitCode = String(args.exit_code);
  if (has('status')) simple.when.status = String(args.status);
  if (has('patterns')) simple.when.patterns = String(args.patterns);
  if (has('pattern')) simple.when.pattern = String(args.pattern);
  if (has('match_mode')) simple.when.matchMode = String(args.match_mode);

  if (has('watch_project')) {
    const resolved = resolveProject(args.watch_project, { allowAny: true });
    if (resolved.error) return { error: resolved.error };
    simple.when.projectId = resolved.id;
  }

  // Caught here rather than left to validateTask, whose generic "needs a
  // project" message would send the caller straight back to "any".
  if (simple.when.projectId === simpleTask.ANY_PROJECT && needsRealProject(simple.when.kind)) {
    return {
      error: `when="${simple.when.kind}" installs a watcher on one repository, so watch_project="any" cannot work. `
        + 'Name the project to watch instead.',
    };
  }

  // Notifications
  if (has('notify_desktop')) simple.notify.desktop = args.notify_desktop !== false;
  if (has('notify_result')) simple.notify.includeResult = args.notify_result !== false;
  if (has('discord_webhook')) simple.notify.discord = String(args.discord_webhook);

  return { simple: simpleTask.normalizeSimple(simple) };
}

/** Human-readable summary of a compiled automation, used by create/update/get. */
function summarize(wf, { history = null } = {}) {
  const s = simpleTask.normalizeSimple(wf.simple);
  const lines = [
    `${wf.name} (${wf.id})`,
    `  Enabled:  ${wf.enabled !== false ? 'yes' : 'no (paused)'}`,
    `  Runs:     ${describeWhen(s.when)}`,
    `  Project:  ${projectLabel(s.projectId)}`,
  ];
  if (s.when.projectId) lines.push(`  Watches:  ${projectLabel(s.when.projectId)}`);
  if (s.cwd) lines.push(`  Cwd:      ${s.cwd}`);
  if (s.model || s.effort) lines.push(`  Model:    ${s.model || 'app default'}${s.effort ? ` (effort: ${s.effort})` : ''}`);

  const channels = [s.notify.desktop ? 'desktop' : null, s.notify.discord ? 'discord' : null].filter(Boolean);
  lines.push(`  Notify:   ${channels.length ? channels.join(' + ') : 'off'}${s.notify.includeResult && channels.length ? ' (includes the result)' : ''}`);

  const nextRun = simpleTask.nextRunForTask(wf);
  if (nextRun) lines.push(`  Next run: ${nextRun.toISOString()}`);

  if (history) lines.push(`  Last run: ${formatLastRun(lastRunOf(history, wf.id))}`);
  return lines.join('\n');
}

// -- Tool definitions ---------------------------------------------------------

// Shared between create and update so the two never drift apart.
const SIMPLE_FIELDS = {
  prompt: { type: 'string', description: 'What Claude is asked to do when the automation fires.' },
  project: { type: 'string', description: 'Project Claude runs in — name, ID or path.' },
  cwd: { type: 'string', description: 'Working directory override. Defaults to the project path.' },
  model: { type: 'string', description: 'Model override, e.g. "claude-opus-5". Empty = the app default.' },
  effort: { type: 'string', description: 'Reasoning effort override: low | medium | high.' },

  when: {
    type: 'string',
    enum: WHEN_KINDS,
    description:
      'When it fires. Clock: once, hourly, daily, weekly, monthly, custom (cron). '
      + 'Events: git, file_change, command_fails, session_end (a Claude turn ended), '
      + 'chat_reply (Claude finished replying — supports a text filter), project_open.',
  },
  time: { type: 'string', description: '"HH:MM" for hourly/daily/weekly/monthly. Default "09:00".' },
  weekday: { type: 'number', description: 'when="weekly": 0=Sunday … 6=Saturday.' },
  day: { type: 'number', description: 'when="monthly": day of month, 1-28 (capped — 29-31 would skip months).' },
  at: { type: 'string', description: 'when="once": "YYYY-MM-DDTHH:MM" in local time.' },
  cron: { type: 'string', description: 'when="custom": a 5-field cron expression.' },

  git_event: { type: 'string', enum: ['any', 'commit', 'push', 'branch_switch'], description: 'when="git": which git activity.' },
  exit_code: { type: 'string', enum: ['any', 'success', 'error'], description: 'when="command_fails": which outcome.' },
  status: { type: 'string', enum: ['any', 'success', 'error'], description: 'when="session_end": which outcome.' },
  patterns: { type: 'string', description: 'when="file_change": glob(s) to watch. Empty = everything watched.' },
  pattern: { type: 'string', description: 'when="chat_reply": only fire when the reply matches this text. Empty = every reply.' },
  match_mode: { type: 'string', enum: ['contains', 'regex'], description: 'How `pattern` is matched. Default "contains".' },
  watch_project: {
    type: 'string',
    description:
      'Which project the EVENT watches — a name or ID, or "any" for all projects. '
      + 'Separate from `project` (where Claude runs): "when I push in the API, write it up in my notes" is a real case. '
      + 'when="git" and when="file_change" install a per-repository watcher, so they need a named project here '
      + '(or in `project`, which they fall back to) and reject "any".',
  },

  notify_desktop: { type: 'boolean', description: 'Desktop notification when the run ends. Default true.' },
  notify_result: { type: 'boolean', description: 'Include Claude\'s answer in the notification. Default true.' },
  discord_webhook: { type: 'string', description: 'Discord webhook URL to also post the result to.' },
};

const tools = [
  {
    name: 'automation_list',
    description:
      'List the automations (the Automations tab): scheduled or event-driven Claude prompts. '
      + 'Shows when each one fires, its project, and its last run. '
      + 'Hand-built graph workflows are not listed here — use workflow_list for those.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only automations attached to this project (name, ID or path).' },
        enabled_only: { type: 'boolean', description: 'Skip paused automations.' },
      },
    },
  },
  {
    name: 'automation_get',
    description: 'Full detail of one automation: its prompt, when it fires, where it runs, and its recent runs.',
    inputSchema: {
      type: 'object',
      properties: {
        automation: { type: 'string', description: 'Automation name or ID' },
      },
      required: ['automation'],
    },
  },
  {
    name: 'automation_create',
    description:
      'Create an automation: a prompt Claude runs on a schedule or on an event. '
      + 'This is what the Automations tab creates — prefer it over workflow_create, which builds a hand-edited graph instead. '
      + 'It takes effect immediately, no restart needed.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name of the automation.' },
        enabled: { type: 'boolean', description: 'Start armed. Default true.' },
        ...SIMPLE_FIELDS,
      },
      required: ['name', 'prompt', 'when'],
    },
  },
  {
    name: 'automation_update',
    description:
      'Change an existing automation. Only the fields passed are modified — updating the prompt leaves the schedule alone. '
      + 'The graph is recompiled from the result, so the change is live immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        automation: { type: 'string', description: 'Automation name or ID' },
        name: { type: 'string', description: 'Rename the automation.' },
        enabled: { type: 'boolean', description: 'Arm or pause it.' },
        ...SIMPLE_FIELDS,
      },
      required: ['automation'],
    },
  },
  {
    name: 'automation_enable',
    description: 'Arm or pause an automation, without changing anything else. A paused automation never fires.',
    inputSchema: {
      type: 'object',
      properties: {
        automation: { type: 'string', description: 'Automation name or ID' },
        enabled: { type: 'boolean', description: 'true to arm, false to pause' },
      },
      required: ['automation', 'enabled'],
    },
  },
  {
    name: 'automation_delete',
    description: 'Delete an automation permanently, along with its run history.',
    inputSchema: {
      type: 'object',
      properties: {
        automation: { type: 'string', description: 'Automation name or ID' },
      },
      required: ['automation'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  if (!simpleTask) {
    return fail(`Automation tools are unavailable: the shared task compiler could not be loaded (${simpleTaskError}).`);
  }

  args = args || {};

  // Saving is the same three steps everywhere: validate, write under the lock,
  // then tell the running app to rearm its scheduler.
  const persist = (task, verb) => {
    const check = simpleTask.validateTask(task);
    if (!check.valid) {
      return { error: VALIDATION_MESSAGES[check.errorKey] || `Invalid automation (${check.errorKey}).` };
    }
    const compiled = simpleTask.compileTask(task);
    try {
      store.upsertDefinition(compiled);
    } catch (e) {
      return { error: e.message };
    }
    const reloaded = store.signalReload();
    log(`${verb} automation "${compiled.name}" (${compiled.id})`);
    return { compiled, reloaded };
  };

  const RELOAD_WARNING =
    '\n\nWarning: saved, but Claude Terminal could not be signalled to reload — '
    + 'it may not pick the change up until it is restarted.';

  try {
    // ── automation_list ──────────────────────────────────────────────────────

    if (name === 'automation_list') {
      let defs = store.loadDefinitions().filter(simpleTask.isSimpleTask);

      if (args.project) {
        const resolved = resolveProject(args.project);
        if (resolved.error) return fail(resolved.error);
        defs = defs.filter(w => simpleTask.normalizeSimple(w.simple).projectId === resolved.id);
      }
      if (args.enabled_only) defs = defs.filter(w => w.enabled !== false);

      if (!defs.length) {
        return ok('No automations configured. Create one with automation_create, or in Claude Terminal > Automations.');
      }

      const history = store.loadHistory();
      const lines = defs.map(w => summarize(w, { history }));
      return ok(
        `Automations (${defs.length}):\n\n${lines.join('\n\n')}\n\n`
        + 'Use the ID with automation_get / automation_update, or with workflow_trigger to run one now.'
      );
    }

    // ── automation_get ───────────────────────────────────────────────────────

    if (name === 'automation_get') {
      const wf = findAutomation(args.automation);
      if (!wf) return fail(`Automation "${args.automation}" not found. Use automation_list to see them.`);

      const s = simpleTask.normalizeSimple(wf.simple);
      const runs = store.loadHistory()
        .filter(r => r.workflowId === wf.id)
        .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
        .slice(0, 5);

      const parts = [
        summarize(wf),
        '',
        'Prompt:',
        s.prompt.split('\n').map(l => `  ${l}`).join('\n'),
      ];

      if (runs.length) {
        parts.push('', `Recent runs (${runs.length}):`);
        for (const r of runs) {
          parts.push(`  ${r.startedAt || '?'} — ${r.status || 'unknown'} (${formatDuration(r.durationMs || r.duration)})`);
        }
        parts.push('', `Use workflow_run_logs with run_id="${runs[0].id || runs[0].runId}" for step-by-step detail.`);
      } else {
        parts.push('', 'Recent runs: none yet.');
      }

      return ok(parts.join('\n'));
    }

    // ── automation_create ────────────────────────────────────────────────────

    if (name === 'automation_create') {
      if (!args.name) return fail('Missing required parameter: name');
      if (!args.prompt) return fail('Missing required parameter: prompt');
      if (!args.when) return fail(`Missing required parameter: when (one of ${WHEN_KINDS.join(', ')})`);

      const built = buildSimple(args, null);
      if (built.error) return fail(built.error);

      const crypto = require('crypto');
      const task = {
        id: `wf_${crypto.randomUUID().slice(0, 8)}`,
        name: String(args.name),
        enabled: args.enabled !== false,
        simple: built.simple,
      };

      const saved = persist(task, 'Created');
      if (saved.error) return fail(saved.error);

      return ok(
        `Automation created.\n\n${summarize(saved.compiled)}`
        + `\n\nRun it now with workflow_trigger workflow="${saved.compiled.id}".`
        + (saved.reloaded ? '' : RELOAD_WARNING)
      );
    }

    // ── automation_update ────────────────────────────────────────────────────

    if (name === 'automation_update') {
      const wf = findAutomation(args.automation);
      if (!wf) return fail(`Automation "${args.automation}" not found. Use automation_list to see them.`);

      const built = buildSimple(args, wf.simple);
      if (built.error) return fail(built.error);

      const task = {
        id: wf.id,
        name: args.name !== undefined ? String(args.name) : wf.name,
        enabled: args.enabled !== undefined ? args.enabled !== false : wf.enabled !== false,
        favorite: wf.favorite,
        simple: built.simple,
      };

      const saved = persist(task, 'Updated');
      if (saved.error) return fail(saved.error);

      return ok(`Automation updated.\n\n${summarize(saved.compiled)}` + (saved.reloaded ? '' : RELOAD_WARNING));
    }

    // ── automation_enable ────────────────────────────────────────────────────

    if (name === 'automation_enable') {
      if (args.enabled === undefined) return fail('Missing required parameter: enabled');
      const wf = findAutomation(args.automation);
      if (!wf) return fail(`Automation "${args.automation}" not found. Use automation_list to see them.`);

      const saved = persist({
        id: wf.id,
        name: wf.name,
        enabled: args.enabled !== false,
        favorite: wf.favorite,
        simple: wf.simple,
      }, args.enabled !== false ? 'Armed' : 'Paused');
      if (saved.error) return fail(saved.error);

      return ok(
        `Automation "${wf.name}" is now ${args.enabled !== false ? 'armed' : 'paused'}.`
        + (args.enabled !== false ? `\nRuns: ${describeWhen(simpleTask.normalizeSimple(wf.simple).when)}` : '')
        + (saved.reloaded ? '' : RELOAD_WARNING)
      );
    }

    // ── automation_delete ────────────────────────────────────────────────────

    if (name === 'automation_delete') {
      const wf = findAutomation(args.automation);
      if (!wf) return fail(`Automation "${args.automation}" not found. Use automation_list to see them.`);

      const runCount = store.loadHistory().filter(r => r.workflowId === wf.id).length;
      try {
        store.removeDefinition(wf.id);
      } catch (e) {
        return fail(e.message);
      }
      // History and result files are cleaned up by the main process, which is
      // their only writer.
      store.signalDeleted(wf.id);

      log(`Deleted automation "${wf.name}" (${wf.id})`);
      return ok(`Automation "${wf.name}" (${wf.id}) deleted.\n${runCount} run record(s) will be cleaned up.`);
    }

    return fail(`Unknown tool: ${name}`);
  } catch (err) {
    log(`Error in ${name}:`, err.message);
    return fail(`Error: ${err.message}`);
  }
}

module.exports = { tools, handle };
