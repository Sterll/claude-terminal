'use strict';

const { escapeHtml } = require('../../utils');
const { t, getCurrentLanguage } = require('../../i18n');

// ── Hook types ──────────────────────────────────────────────────────────────

const HOOK_TYPES = [
  { value: 'PreToolUse',        label: 'PreToolUse',        desc: 'Before each tool call' },
  { value: 'PostToolUse',       label: 'PostToolUse',       desc: 'After each tool call' },
  { value: 'PostToolUseFailure',label: 'PostToolUseFailure',desc: 'After a tool call fails' },
  { value: 'Notification',      label: 'Notification',      desc: 'On each notification' },
  { value: 'UserPromptSubmit',  label: 'UserPromptSubmit',  desc: 'On user message submit' },
  { value: 'SessionStart',      label: 'SessionStart',      desc: 'Session start' },
  { value: 'SessionEnd',        label: 'SessionEnd',        desc: 'Session end' },
  { value: 'Stop',              label: 'Stop',              desc: 'When Claude stops' },
  { value: 'SubagentStart',     label: 'SubagentStart',     desc: 'Subagent starts' },
  { value: 'SubagentStop',      label: 'SubagentStop',      desc: 'Subagent stops' },
  { value: 'PreCompact',        label: 'PreCompact',        desc: 'Before context compact' },
  { value: 'PermissionRequest', label: 'PermissionRequest', desc: 'Permission request' },
  { value: 'Setup',             label: 'Setup',             desc: 'Setup phase' },
  { value: 'TeammateIdle',      label: 'TeammateIdle',      desc: 'Teammate idle' },
  { value: 'TaskCompleted',     label: 'TaskCompleted',     desc: 'Task completed' },
  { value: 'ConfigChange',      label: 'ConfigChange',      desc: 'Config changed' },
  { value: 'WorktreeCreate',    label: 'WorktreeCreate',    desc: 'Worktree created' },
  { value: 'WorktreeRemove',    label: 'WorktreeRemove',    desc: 'Worktree removed' },
];

// ── Node output properties (for autocomplete) ──────────────────────────────

const NODE_OUTPUTS = {
  claude:    ['output', 'success'],
  shell:     ['stdout', 'stderr', 'exitCode'],
  git:       ['output', 'success', 'action'],
  http:      ['status', 'ok', 'body'],
  file:      ['content', 'success', 'exists'],
  db:        ['rows', 'columns', 'rowCount', 'duration', 'firstRow'],
  condition: ['result', 'value'],
  wait:      ['waited', 'timedOut'],
  notify:    ['sent', 'message'],
  project:   ['success', 'action'],
  variable:  ['name', 'value', 'action'],
  log:       ['level', 'message', 'logged'],
  loop:      ['items', 'count'],
  transform: ['result'],
  switch:    ['matchedCase'],
  subworkflow: ['outputs', 'status'],
};
// Output field types for richer autocomplete display
const NODE_OUTPUT_TYPES = {
  claude:    { output: 'string', success: 'boolean' },
  shell:     { stdout: 'string', stderr: 'string', exitCode: 'number' },
  git:       { output: 'string', success: 'boolean', action: 'string' },
  http:      { status: 'number', ok: 'boolean', body: 'object' },
  file:      { content: 'string', success: 'boolean', exists: 'boolean' },
  db:        { rows: 'array', columns: 'array', rowCount: 'number', duration: 'number', firstRow: 'object' },
  condition: { result: 'boolean', value: 'any' },
  wait:      { waited: 'boolean', timedOut: 'boolean' },
  notify:    { sent: 'boolean', message: 'string' },
  project:   { success: 'boolean', action: 'string' },
  variable:  { name: 'string', value: 'any', action: 'string' },
  log:       { level: 'string', message: 'string', logged: 'boolean' },
  loop:      { items: 'array', count: 'number' },
  transform: { result: 'any' },
  switch:    { matchedCase: 'string' },
  subworkflow: { outputs: 'object', status: 'string' },
};

// ── SVG icons ───────────────────────────────────────────────────────────────

function svgWorkflow(s = 14) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="6" height="6" rx="1"/><rect x="16" y="3" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><path d="M5 9v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M12 12v3"/></svg>`; }
function svgAgent(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/></svg>`; }
function svgShell() { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`; }
function svgGit() { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>`; }
function svgHttp() { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`; }
function svgNotify() { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`; }
function svgWait() { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`; }
function svgCond() { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`; }
function svgClock(s = 10) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`; }
function svgTimer() { return `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`; }
function svgHook(s = 13) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`; }
function svgChain(s = 13) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`; }
function svgPlay(s = 10) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>`; }
function svgX(s = 12) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>`; }
function svgScope() { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`; }
function svgConc() { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/></svg>`; }
function svgEmpty() { return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="6" height="6" rx="1"/><rect x="16" y="3" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><path d="M5 9v3a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M12 12v3"/></svg>`; }
function svgRuns() { return `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>`; }
function svgClaude(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-7 7v1a7 7 0 0 0 14 0V9a7 7 0 0 0-7-7z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01"/><path d="M15 9h.01"/><path d="M8 18v2a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2"/></svg>`; }
function svgPrompt(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`; }
function svgSkill(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`; }
function svgProject(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`; }
function svgFile(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`; }
function svgDb(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`; }
function svgLoop(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`; }
function svgVariable(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/></svg>`; }
function svgLog(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`; }
function svgTriggerType(s = 10) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`; }
function svgLink(s = 10) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`; }
function svgMode(s = 10) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`; }
function svgEdit(s = 10) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`; }
function svgBranch(s = 10) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`; }
function svgCode(s = 10) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`; }
function svgTrash(s = 12) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`; }
function svgCopy(s = 12) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`; }
function svgTransform(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="m8 7-4 4 4 4"/><path d="m16 7 4 4-4 4"/></svg>`; }
function svgGetVar(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.93 4.93 2.83 2.83"/><path d="m16.24 16.24 2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/></svg>`; }
function svgSwitch(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/><path d="M21 22v-5l-9-9"/></svg>`; }
function svgSubworkflow(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="6" height="6" rx="1"/><rect x="16" y="7" width="6" height="6" rx="1"/><path d="M8 10h8"/><path d="M12 3v4"/><path d="M12 17v4"/></svg>`; }
function svgTeal(s = 11) { return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20"/><path d="M6 8l-4 4 4 4"/><path d="M18 8l4 4-4 4"/></svg>`; }

// ── Step types & field definitions ──────────────────────────────────────────

const GIT_ACTIONS = [
  { value: 'pull',     label: 'Pull',     desc: 'Fetch remote changes' },
  { value: 'push',     label: 'Push',     desc: 'Push local commits' },
  { value: 'commit',   label: 'Commit',   desc: 'Create a commit', extra: [{ key: 'message', label: 'Commit message', placeholder: 'feat: add new feature', mono: true }] },
  { value: 'checkout', label: 'Checkout', desc: 'Switch branch', extra: [{ key: 'branch', label: 'Branch', placeholder: 'main / develop / feature/...', mono: true }] },
  { value: 'merge',    label: 'Merge',    desc: 'Merge branch', extra: [{ key: 'branch', label: 'Source branch', placeholder: 'feature/my-branch', mono: true }] },
  { value: 'stash',    label: 'Stash',    desc: 'Stash changes' },
  { value: 'stash-pop',label: 'Stash Pop',desc: 'Restore stashed changes' },
  { value: 'reset',    label: 'Reset',    desc: 'Discard uncommitted changes' },
];

const WAIT_UNITS = [
  { value: 's', label: 'Seconds' },
  { value: 'm', label: 'Minutes' },
  { value: 'h', label: 'Hours' },
];

const CONDITION_VARS = [
  { value: '$ctx.branch',      label: 'Current branch' },
  { value: '$ctx.exitCode',    label: 'Exit code' },
  { value: '$ctx.project',     label: 'Project name' },
  { value: '$ctx.prevStatus',  label: 'Previous step status' },
  { value: '$env.',            label: 'Environment variable', extra: [{ key: 'envVar', label: 'Name', placeholder: 'NODE_ENV', mono: true }] },
];

const CONDITION_OPS = [
  { value: '==', label: '==', group: 'compare' },
  { value: '!=', label: '!=', group: 'compare' },
  { value: '>',  label: '>',  group: 'compare' },
  { value: '<',  label: '<',  group: 'compare' },
  { value: '>=', label: '>=', group: 'compare' },
  { value: '<=', label: '<=', group: 'compare' },
  { value: 'contains',    label: 'contains',     group: 'text' },
  { value: 'starts_with', label: 'starts with',  group: 'text' },
  { value: 'matches',     label: 'regex',        group: 'text' },
  { value: 'is_empty',     label: 'is empty',      group: 'unary' },
  { value: 'is_not_empty', label: 'is not empty',  group: 'unary' },
];

function buildConditionPreview(variable, op, value, isUnary) {
  if (!variable) return t('workflow.helpers.condition.none');
  if (isUnary) return `${variable} ${op}`;
  return `${variable} ${op} ${value || '?'}`;
}

const STEP_TYPES = [
  { type: 'trigger',   label: 'Trigger',   color: 'success',  icon: svgPlay(11),     desc: 'workflow.nodeDesc.trigger' },
  { type: 'claude',    label: 'Claude',    color: 'accent',   icon: svgClaude(),     desc: 'workflow.nodeDesc.claude',      category: 'action' },
  { type: 'shell',     label: 'Shell',     color: 'info',     icon: svgShell(),      desc: 'workflow.nodeDesc.shell',       category: 'action' },
  { type: 'git',       label: 'Git',       color: 'purple',   icon: svgGit(),        desc: 'workflow.nodeDesc.git',         category: 'action' },
  { type: 'http',      label: 'HTTP',      color: 'cyan',     icon: svgHttp(),       desc: 'workflow.nodeDesc.http',        category: 'action' },
  { type: 'notify',    label: 'Notify',    color: 'warning',  icon: svgNotify(),     desc: 'workflow.nodeDesc.notify',      category: 'action' },
  { type: 'project',   label: 'Project',   color: 'pink',     icon: svgProject(),    desc: 'workflow.nodeDesc.project',     category: 'data' },
  { type: 'file',      label: 'File',      color: 'lime',     icon: svgFile(),       desc: 'workflow.nodeDesc.file',        category: 'data' },
  { type: 'db',        label: 'Database',  color: 'orange',   icon: svgDb(),         desc: 'workflow.nodeDesc.db',          category: 'data' },
  { type: 'time',      label: 'Time',      color: 'teal',     icon: svgClock(),      desc: 'workflow.nodeDesc.time',        category: 'data' },
  { type: 'transform',    label: 'Transform',    color: 'teal',    icon: svgTransform(),    desc: 'workflow.nodeDesc.transform',  category: 'data' },
  { type: 'variable',    label: 'Variable',     color: 'purple',  icon: svgVariable(),    desc: 'workflow.nodeDesc.variable',   category: 'data' },
  { type: 'condition',   label: 'Condition',    color: 'success', icon: svgCond(),         desc: 'workflow.nodeDesc.condition',  category: 'flow' },
  { type: 'loop',        label: 'Loop',         color: 'sky',     icon: svgLoop(),         desc: 'workflow.nodeDesc.loop',       category: 'flow' },
  { type: 'switch',      label: 'Switch',       color: 'pink',    icon: svgSwitch(),       desc: 'workflow.nodeDesc.switch',     category: 'flow' },
  { type: 'subworkflow', label: 'Sub-workflow', color: 'purple',  icon: svgSubworkflow(),  desc: 'workflow.nodeDesc.subworkflow',category: 'flow' },
  { type: 'wait',        label: 'Wait',         color: 'muted',   icon: svgWait(),         desc: 'workflow.nodeDesc.wait',       category: 'flow' },
  { type: 'log',         label: 'Log',          color: 'slate',   icon: svgLog(),          desc: 'workflow.nodeDesc.log',        category: 'flow' },
];

const STEP_FIELDS = {
  shell: [
    { key: 'command', label: 'Command', placeholder: 'npm run build', mono: true },
  ],
  claude: [
    { key: 'mode', label: 'Mode', type: 'claude-mode-tabs' },
    { key: 'prompt', label: 'Prompt', type: 'variable-textarea', showIf: (s) => !s.mode || s.mode === 'prompt' },
    { key: 'agentId', label: 'Agent', type: 'agent-picker', showIf: (s) => s.mode === 'agent' },
    { key: 'skillId', label: 'Skill', type: 'skill-picker', showIf: (s) => s.mode === 'skill' },
    { key: 'prompt', label: 'Additional instructions', placeholder: 'Additional context (optional)', textarea: true, showIf: (s) => s.mode === 'agent' || s.mode === 'skill' },
    { key: 'model', label: 'Model', type: 'model-select' },
    { key: 'effort', label: 'Effort', type: 'effort-select' },
    { key: 'outputSchema', label: 'Structured output', type: 'structured-output' },
  ],
  agent: 'claude',
  git: [
    { key: 'action', label: 'Action', type: 'action-select', actions: GIT_ACTIONS },
  ],
  http: [
    { key: 'method', label: 'Method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
    { key: 'url', label: 'URL', placeholder: 'https://api.example.com/endpoint', mono: true },
    { key: 'headers', label: 'Headers', placeholder: 'Content-Type: application/json', textarea: true, mono: true, showIf: (s) => ['POST', 'PUT', 'PATCH'].includes(s.method) },
    { key: 'body', label: 'Body', placeholder: '{ "key": "value" }', textarea: true, mono: true, showIf: (s) => ['POST', 'PUT', 'PATCH'].includes(s.method) },
  ],
  notify: [
    { key: 'title', label: 'Title', placeholder: 'Build finished' },
    { key: 'message', label: 'Message', placeholder: 'Le build $project est OK', textarea: true },
  ],
  wait: [
    { key: 'duration', label: 'Duration', type: 'duration-picker' },
  ],
  condition: [
    { key: 'condition', label: 'Condition', type: 'condition-builder' },
  ],
};

const STEP_TYPE_ALIASES = { agent: 'claude' };
const findStepType = (type) => {
  const resolved = STEP_TYPE_ALIASES[type] || type;
  return STEP_TYPES.find(x => x.type === resolved) || STEP_TYPES[0];
};

const TRIGGER_CONFIG = {
  cron:        { labelKey: 'workflow.trigger.typeCron',       descKey: 'workflow.helpers.triggerDesc.cron',       icon: svgClock(),  color: 'info',    extra: 'cronPicker' },
  hook:        { labelKey: 'workflow.trigger.typeHook',       descKey: 'workflow.helpers.triggerDesc.hook',       icon: svgHook(),   color: 'accent',  extra: 'hookType' },
  on_workflow: { labelKey: 'workflow.trigger.typeOnWorkflow', descKey: 'workflow.helpers.triggerDesc.onWorkflow', icon: svgChain(),  color: 'purple',  fields: [{ id: 'triggerValue', labelKey: 'workflow.trigger.workflowSourceLabel', placeholder: 'Daily Code Review', mono: false }] },
  manual:      { labelKey: 'workflow.trigger.typeManual',     descKey: 'workflow.helpers.triggerDesc.manual',     icon: svgPlay(),   color: 'success', fields: [] },
  webhook:     { labelKey: 'workflow.trigger.typeWebhook',    descKey: 'workflow.helpers.triggerDesc.webhook',    icon: svgHttp(),   color: 'info',    fields: [] },
};

function getTriggerConfig(type) {
  const cfg = TRIGGER_CONFIG[type] || TRIGGER_CONFIG.manual;
  return {
    ...cfg,
    label: t(cfg.labelKey),
    desc: cfg.descKey ? t(cfg.descKey) : '',
    fields: (cfg.fields || []).map((f) => ({
      ...f,
      label: f.labelKey ? t(f.labelKey) : f.label,
    })),
  };
}

// ── Cron picker ─────────────────────────────────────────────────────────────

const CRON_MODES = [
  { id: 'interval', labelKey: 'workflow.helpers.cron.modeInterval' },
  { id: 'daily',    labelKey: 'workflow.helpers.cron.modeDaily' },
  { id: 'weekly',   labelKey: 'workflow.helpers.cron.modeWeekly' },
  { id: 'monthly',  labelKey: 'workflow.helpers.cron.modeMonthly' },
  { id: 'custom',   labelKey: 'workflow.helpers.cron.modeCustom' },
];

const DAYS_OF_WEEK = [
  { value: 1, labelKey: 'workflow.helpers.cron.dayMonday' },
  { value: 2, labelKey: 'workflow.helpers.cron.dayTuesday' },
  { value: 3, labelKey: 'workflow.helpers.cron.dayWednesday' },
  { value: 4, labelKey: 'workflow.helpers.cron.dayThursday' },
  { value: 5, labelKey: 'workflow.helpers.cron.dayFriday' },
  { value: 6, labelKey: 'workflow.helpers.cron.daySaturday' },
  { value: 0, labelKey: 'workflow.helpers.cron.daySunday' },
];

const INTERVAL_OPTIONS = [
  { value: 5,  label: '5 min' },   { value: 10, label: '10 min' },
  { value: 15, label: '15 min' },  { value: 20, label: '20 min' },
  { value: 30, label: '30 min' },  { value: 60, label: '1 h' },
  { value: 120, label: '2 h' },    { value: 180, label: '3 h' },
  { value: 240, label: '4 h' },    { value: 360, label: '6 h' },
  { value: 480, label: '8 h' },    { value: 720, label: '12 h' },
];

function buildCronFromMode(mode, v) {
  switch (mode) {
    case 'interval': {
      const mins = v.interval || 15;
      if (mins >= 60) return `0 */${mins / 60} * * *`;
      return `*/${mins} * * * *`;
    }
    case 'daily':   return `${v.minute || 0} ${v.hour ?? 8} * * *`;
    case 'weekly':  return `${v.minute || 0} ${v.hour ?? 8} * * ${v.dow ?? 1}`;
    case 'monthly': return `${v.minute || 0} ${v.hour ?? 8} ${v.dom || 1} * *`;
    default: return v.raw || '* * * * *';
  }
}

function parseCronToMode(expr) {
  if (!expr || !expr.trim()) return { mode: 'daily', values: { hour: 8, minute: 0 } };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { mode: 'custom', values: { raw: expr } };
  const [min, hour, dom, mon, dow] = parts;
  if (min.startsWith('*/') && hour === '*' && dom === '*' && mon === '*' && dow === '*') return { mode: 'interval', values: { interval: parseInt(min.slice(2)) } };
  if (min === '0' && hour.startsWith('*/') && dom === '*' && mon === '*' && dow === '*') return { mode: 'interval', values: { interval: parseInt(hour.slice(2)) * 60 } };
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^\d+$/.test(dow)) return { mode: 'weekly', values: { hour: +hour, minute: +min, dow: +dow } };
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*' && dow === '*') return { mode: 'monthly', values: { hour: +hour, minute: +min, dom: +dom } };
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') return { mode: 'daily', values: { hour: +hour, minute: +min } };
  return { mode: 'custom', values: { raw: expr } };
}

function wfDropdown(key, options, selectedValue) {
  const sel = options.find(o => String(o.value) === String(selectedValue)) || options[0];
  return `<div class="wf-cdrop" data-cv="${key}">
    <button class="wf-cdrop-btn" type="button">${escapeHtml(sel.label)}<svg width="8" height="5" viewBox="0 0 8 5" fill="none"><path d="M1 1l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    <div class="wf-cdrop-list">${options.map(o =>
      `<div class="wf-cdrop-item ${String(o.value) === String(selectedValue) ? 'active' : ''}" data-val="${o.value}">${escapeHtml(o.label)}</div>`
    ).join('')}</div>
  </div>`;
}

function bindWfDropdown(container, key, onChange) {
  const drop = container.querySelector(`.wf-cdrop[data-cv="${key}"]`);
  if (!drop) return;
  const btn = drop.querySelector('.wf-cdrop-btn');
  const list = drop.querySelector('.wf-cdrop-list');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.wf-cdrop.open').forEach(d => { if (d !== drop) d.classList.remove('open'); });
    drop.classList.toggle('open');
    if (drop.classList.contains('open')) {
      const active = list.querySelector('.wf-cdrop-item.active');
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
  });
  list.querySelectorAll('.wf-cdrop-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      drop.classList.remove('open');
      btn.firstChild.textContent = item.textContent;
      list.querySelectorAll('.wf-cdrop-item').forEach(it => it.classList.remove('active'));
      item.classList.add('active');
      onChange(item.dataset.val);
    });
  });
  const close = (e) => {
    if (!document.body.contains(drop)) { document.removeEventListener('click', close); return; }
    if (!drop.contains(e.target)) { drop.classList.remove('open'); document.removeEventListener('click', close); }
  };
  document.addEventListener('click', close);
}

function cronOpts() {
  return {
    hour: Array.from({ length: 24 }, (_, i) => ({ value: i, label: String(i).padStart(2, '0') })),
    minute: [0, 15, 30, 45].map(m => ({ value: m, label: String(m).padStart(2, '0') })),
    dow: DAYS_OF_WEEK.map((d) => ({ ...d, label: t(d.labelKey) })),
    dom: Array.from({ length: 28 }, (_, i) => ({ value: i + 1, label: `${i + 1}` })),
    interval: INTERVAL_OPTIONS,
  };
}

function drawCronPicker(container, draft) {
  const parsed = parseCronToMode(draft.triggerValue);
  let cronMode = parsed.mode;
  let cronValues = { ...parsed.values };
  const opts = cronOpts();
  let _prevCloseAll = null;

  const render = () => {
    if (_prevCloseAll) { document.removeEventListener('click', _prevCloseAll); _prevCloseAll = null; }
    let phrase = '';
    switch (cronMode) {
      case 'interval':
        phrase = `<span class="wf-cron-label">${t('workflow.helpers.cron.every')}</span>${wfDropdown('interval', opts.interval, cronValues.interval || 15)}`;
        break;
      case 'daily':
        phrase = `<span class="wf-cron-label">${t('workflow.helpers.cron.everyDayAt')}</span>${wfDropdown('hour', opts.hour, cronValues.hour ?? 8)}<span class="wf-cron-label">h</span>${wfDropdown('minute', opts.minute, cronValues.minute || 0)}`;
        break;
      case 'weekly':
        phrase = `<span class="wf-cron-label">${t('workflow.helpers.cron.every')}</span>${wfDropdown('dow', opts.dow, cronValues.dow ?? 1)}<span class="wf-cron-label">${t('workflow.helpers.cron.at')}</span>${wfDropdown('hour', opts.hour, cronValues.hour ?? 8)}<span class="wf-cron-label">h</span>${wfDropdown('minute', opts.minute, cronValues.minute || 0)}`;
        break;
      case 'monthly':
        phrase = `<span class="wf-cron-label">${t('workflow.helpers.cron.onDay')}</span>${wfDropdown('dom', opts.dom, cronValues.dom || 1)}<span class="wf-cron-label">${t('workflow.helpers.cron.ofMonthAt')}</span>${wfDropdown('hour', opts.hour, cronValues.hour ?? 8)}<span class="wf-cron-label">h</span>${wfDropdown('minute', opts.minute, cronValues.minute || 0)}`;
        break;
      case 'custom':
        phrase = `<input class="wf-input wf-input--mono" id="wf-cron-raw" placeholder="0 8 * * *" value="${escapeHtml(cronValues.raw || draft.triggerValue || '')}">`;
        break;
    }
    const cron = cronMode === 'custom' ? (cronValues.raw || draft.triggerValue || '') : buildCronFromMode(cronMode, cronValues);
    draft.triggerValue = cron;
    container.innerHTML = `
      <div class="wf-cron-modes">${CRON_MODES.map(m => `<button class="wf-cron-mode ${cronMode === m.id ? 'active' : ''}" data-cm="${m.id}">${t(m.labelKey)}</button>`).join('')}</div>
      <div class="wf-cron-phrase">${phrase}</div>
      ${cron ? `<div class="wf-cron-preview"><code>${escapeHtml(cron)}</code></div>` : ''}
    `;
    container.querySelectorAll('[data-cm]').forEach(btn => {
      btn.addEventListener('click', () => {
        cronMode = btn.dataset.cm;
        cronValues = { hour: cronValues.hour ?? 8, minute: cronValues.minute || 0, dow: cronValues.dow ?? 1, dom: cronValues.dom || 1, interval: cronValues.interval || 15 };
        render();
      });
    });
    container.querySelectorAll('.wf-cdrop').forEach(drop => {
      const btn = drop.querySelector('.wf-cdrop-btn');
      const list = drop.querySelector('.wf-cdrop-list');
      const key = drop.dataset.cv;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        container.querySelectorAll('.wf-cdrop.open').forEach(d => { if (d !== drop) d.classList.remove('open'); });
        drop.classList.toggle('open');
        if (drop.classList.contains('open')) { const ai = list.querySelector('.wf-cdrop-item.active'); if (ai) ai.scrollIntoView({ block: 'nearest' }); }
      });
      list.querySelectorAll('.wf-cdrop-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const val = isNaN(+item.dataset.val) ? item.dataset.val : +item.dataset.val;
          cronValues[key] = val;
          drop.classList.remove('open');
          btn.firstChild.textContent = item.textContent;
          list.querySelectorAll('.wf-cdrop-item').forEach(it => it.classList.remove('active'));
          item.classList.add('active');
          draft.triggerValue = buildCronFromMode(cronMode, cronValues);
          const prev = container.querySelector('.wf-cron-preview code');
          if (prev) prev.textContent = draft.triggerValue;
        });
      });
    });
    const closeAll = (e) => { if (!container.contains(e.target)) container.querySelectorAll('.wf-cdrop.open').forEach(d => d.classList.remove('open')); };
    _prevCloseAll = closeAll;
    document.addEventListener('click', closeAll);
    const rawInput = container.querySelector('#wf-cron-raw');
    if (rawInput) {
      rawInput.addEventListener('input', () => {
        cronValues.raw = rawInput.value;
        draft.triggerValue = rawInput.value;
        const prev = container.querySelector('.wf-cron-preview code');
        if (prev) prev.textContent = rawInput.value;
      });
    }
  };
  render();
}

// ── Formatting ──────────────────────────────────────────────────────────────

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t('workflow.helpers.time.justNow');
    if (diffMin < 60) return t('workflow.helpers.time.minutesAgo', { n: diffMin });
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return t('workflow.helpers.time.hoursAgo', { n: diffH });
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) {
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return t('workflow.helpers.time.yesterdayAt', { time });
    }
    if (diffD < 7) return t('workflow.helpers.time.daysAgo', { n: diffD });
    const locale = getCurrentLanguage() === 'fr' ? 'fr-FR' : 'en-US';
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  } catch { return String(iso); }
}

function fmtDuration(val) {
  if (val == null) return '…';
  const s = typeof val === 'number' ? val : parseInt(val);
  if (isNaN(s)) return String(val);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function statusDot(s) { return `<span class="wf-dot wf-dot--${s}"></span>`; }
function statusLabel(s) {
  const map = {
    success: 'workflow.helpers.status.success',
    failed: 'workflow.helpers.status.failed',
    running: 'workflow.helpers.status.running',
    pending: 'workflow.helpers.status.pending',
    cancelled: 'workflow.helpers.status.cancelled',
  };
  return map[s] ? t(map[s]) : s;
}

// ── Autocomplete ────────────────────────────────────────────────────────────

function getAutocompleteSuggestions(graph, currentNodeId, filterText) {
  const suggestions = [];
  const filter = (filterText || '').toLowerCase();
  const ctxVars = [
    { value: '$ctx.project', detail: t('workflow.helpers.autocomplete.ctxProject'), type: 'string' },
    { value: '$ctx.branch', detail: t('workflow.helpers.autocomplete.ctxBranch'), type: 'string' },
    { value: '$ctx.date', detail: t('workflow.helpers.autocomplete.ctxDate'), type: 'string' },
    { value: '$ctx.trigger', detail: t('workflow.helpers.autocomplete.ctxTrigger'), type: 'string' },
  ];
  for (const v of ctxVars) {
    if (v.value.toLowerCase().includes(filter)) suggestions.push({ category: t('workflow.helpers.autocomplete.categoryContext'), label: v.value, value: v.value, detail: v.detail, type: v.type });
  }
  const loopVars = [
    { value: '$item', detail: t('workflow.helpers.autocomplete.loopItemAlias'), type: 'any' },
    { value: '$loop.item', detail: t('workflow.helpers.autocomplete.loopItem'), type: 'any' },
    { value: '$loop.index', detail: t('workflow.helpers.autocomplete.loopIndex'), type: 'number' },
    { value: '$loop.total', detail: t('workflow.helpers.autocomplete.loopTotal'), type: 'number' },
  ];
  for (const v of loopVars) {
    if (v.value.toLowerCase().includes(filter)) suggestions.push({ category: t('workflow.helpers.autocomplete.categoryLoop'), label: v.value, value: v.value, detail: v.detail, type: v.type });
  }
  if (graph && graph._nodes) {
    for (const node of graph._nodes) {
      if (node.id === currentNodeId) continue;
      const nodeType = (node.type || '').replace('workflow/', '');
      if (nodeType === 'trigger') continue;
      const outputs = NODE_OUTPUTS[nodeType];
      if (!outputs) continue;
      const typeMap = NODE_OUTPUT_TYPES[nodeType] || {};
      const nodeLabel = node.properties?._customTitle || node.title || nodeType;
      const prefix = `$node_${node.id}`;
      for (const prop of outputs) {
        const full = `${prefix}.${prop}`;
        const propType = typeMap[prop] || 'any';
        if (full.toLowerCase().includes(filter) || nodeLabel.toLowerCase().includes(filter)) {
          suggestions.push({ category: t('workflow.helpers.autocomplete.categoryNodes'), label: full, value: full, detail: `${nodeLabel} → ${prop}`, type: propType });
        }
      }
    }
  }
  if (graph && graph._nodes) {
    for (const node of graph._nodes) {
      const nodeType = (node.type || '').replace('workflow/', '');
      if (nodeType !== 'variable') continue;
      if (node.properties?.action !== 'set') continue;
      const varName = node.properties?.name;
      if (!varName) continue;
      const full = `$${varName}`;
      const varType = node.properties?.varType || 'any';
      if (full.toLowerCase().includes(filter)) suggestions.push({ category: t('workflow.helpers.autocomplete.categoryVariables'), label: full, value: full, detail: t('workflow.helpers.autocomplete.variableDetail', { type: varType }), type: varType });
    }
  }
  return suggestions;
}

function extractTableFromSQL(sql) {
  if (!sql) return null;
  const match = sql.match(/\bFROM\s+[`"']?(\w+(?:\.\w+)?)[`"']?/i);
  if (!match) return null;
  const name = match[1];
  return name.includes('.') ? name.split('.').pop() : name;
}

function findUpstreamDbNode(graph, startNode) {
  if (!graph || !startNode) return null;
  const visited = new Set();
  const queue = [startNode];
  visited.add(startNode.id);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current.inputs) continue;
    for (const input of current.inputs) {
      if (!input.link) continue;
      const linkInfo = graph.links?.[input.link] || graph._links?.get?.(input.link);
      if (!linkInfo) continue;
      const originNode = graph.getNodeById(linkInfo.origin_id);
      if (!originNode || visited.has(originNode.id)) continue;
      visited.add(originNode.id);
      const originType = (originNode.type || '').replace('workflow/', '');
      if (originType === 'db') return originNode;
      queue.push(originNode);
    }
  }
  return null;
}

async function getDeepAutocompleteSuggestions(graph, currentNodeId, filterText, schemaCache) {
  const suggestions = [];
  if (!graph || !filterText) return suggestions;
  const nodeMatch = filterText.match(/^\$node_(\d+)\.(firstRow|rows)\.(.*)?$/i);
  const loopMatch = filterText.match(/^\$(loop\.item|item)\.(.*)?$/i);
  let dbNode = null;
  let columnFilter = '';
  if (nodeMatch) {
    const sourceNodeId = parseInt(nodeMatch[1], 10);
    columnFilter = (nodeMatch[3] || '').toLowerCase();
    const sourceNode = graph.getNodeById(sourceNodeId);
    if (sourceNode) {
      const sourceType = (sourceNode.type || '').replace('workflow/', '');
      if (sourceType === 'db') dbNode = sourceNode;
    }
  } else if (loopMatch) {
    columnFilter = (loopMatch[2] || '').toLowerCase();
    const currentNode = graph.getNodeById(currentNodeId);
    if (currentNode) dbNode = findUpstreamDbNode(graph, currentNode);
  }
  if (!dbNode) return suggestions;
  const connectionId = dbNode.properties?.connection;
  const sql = dbNode.properties?.query;
  const tableName = extractTableFromSQL(sql);
  if (!connectionId || !tableName) return suggestions;
  await schemaCache.getSchema(connectionId);
  const columns = schemaCache.getColumnsForTable(connectionId, tableName);
  if (!columns || !columns.length) return suggestions;
  for (const col of columns) {
    const colName = col.name || col;
    const colType = col.type || '';
    if (columnFilter && !colName.toLowerCase().includes(columnFilter)) continue;
    const pkBadge = col.primaryKey ? ' 🔑' : '';
    suggestions.push({ category: t('workflow.helpers.autocomplete.categoryDbColumns'), label: colName, value: filterText.substring(0, filterText.lastIndexOf('.') + 1) + colName, detail: `${colType}${pkBadge}` });
  }
  return suggestions;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

function upgradeSelectsToDropdowns(container) {
  container.querySelectorAll('select.wf-step-edit-input, select.wf-node-prop').forEach(sel => {
    if (sel.dataset.upgraded) return;
    sel.dataset.upgraded = '1';
    sel.style.display = 'none';
    const wrapper = document.createElement('div');
    wrapper.className = 'wf-dropdown';
    sel.parentNode.insertBefore(wrapper, sel.nextSibling);
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'wf-dropdown-trigger';
    wrapper.appendChild(trigger);
    const menu = document.createElement('div');
    menu.className = 'wf-dropdown-menu';
    wrapper.appendChild(menu);
    const chevron = `<svg class="wf-dropdown-chevron" width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    function buildOptions() {
      const selected = sel.value;
      const selectedOpt = sel.options[sel.selectedIndex];
      trigger.innerHTML = `<span class="wf-dropdown-text">${selectedOpt ? escapeHtml(selectedOpt.textContent) : ''}</span>${chevron}`;
      if (!selected && selectedOpt && selectedOpt.value === '') trigger.classList.add('wf-dropdown-placeholder');
      else trigger.classList.remove('wf-dropdown-placeholder');
      menu.innerHTML = '';
      Array.from(sel.options).forEach(opt => {
        const item = document.createElement('div');
        item.className = 'wf-dropdown-item' + (opt.value === selected ? ' active' : '');
        item.dataset.value = opt.value;
        item.innerHTML = `<span>${escapeHtml(opt.textContent)}</span>${opt.value === selected ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : ''}`;
        item.addEventListener('click', (e) => { e.stopPropagation(); sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); closeMenu(); buildOptions(); });
        menu.appendChild(item);
      });
    }
    function openMenu() {
      if (wrapper.classList.contains('open')) { closeMenu(); return; }
      document.querySelectorAll('.wf-dropdown.open').forEach(d => d.classList.remove('open'));
      wrapper.classList.add('open');
      const activeItem = menu.querySelector('.wf-dropdown-item.active');
      if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });
    }
    function closeMenu() { wrapper.classList.remove('open'); }
    trigger.addEventListener('click', (e) => { e.stopPropagation(); openMenu(); });
    const outsideHandler = (e) => { if (!wrapper.contains(e.target)) closeMenu(); };
    document.addEventListener('click', outsideHandler, true);
    const escHandler = (e) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('keydown', escHandler, true);
    const cleanupObs = new MutationObserver(() => {
      if (!wrapper.isConnected) { document.removeEventListener('click', outsideHandler, true); document.removeEventListener('keydown', escHandler, true); cleanupObs.disconnect(); }
    });
    cleanupObs.observe(wrapper.parentNode || document.body, { childList: true, subtree: true });
    buildOptions();
  });
}

function setupAutocomplete(container, node, graphService, schemaCache) {
  const fields = container.querySelectorAll('input.wf-node-prop[type="text"], input.wf-node-prop:not([type]), textarea.wf-node-prop, input.wf-field-mono, textarea.wf-field-mono');
  if (!fields.length) return;
  let popup = container.querySelector('.wf-autocomplete-popup');
  if (!popup) { popup = document.createElement('div'); popup.className = 'wf-autocomplete-popup'; popup.style.display = 'none'; container.appendChild(popup); }
  let activeField = null, activeIndex = 0, currentSuggestions = [], dollarPos = -1;
  function hidePopup() { popup.style.display = 'none'; activeField = null; currentSuggestions = []; activeIndex = 0; }
  function insertSuggestion(value) {
    if (!activeField || dollarPos < 0) return;
    const field = activeField;
    const before = field.value.substring(0, dollarPos);
    const after = field.value.substring(field.selectionStart);
    field.value = before + value + after;
    const newPos = dollarPos + value.length;
    field.setSelectionRange(newPos, newPos);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    hidePopup();
    field.focus();
  }
  function renderPopup(suggestions, anchorField) {
    if (!suggestions.length) { hidePopup(); return; }
    currentSuggestions = suggestions;
    activeIndex = 0;
    const groups = {};
    for (const s of suggestions) { if (!groups[s.category]) groups[s.category] = []; groups[s.category].push(s); }
    const TYPE_COLORS = { string:'#c8c8c8', number:'#60a5fa', boolean:'#4ade80', array:'#fb923c', object:'#a78bfa', any:'#6b7280' };
    let html = '';
    for (const [cat, items] of Object.entries(groups)) {
      html += `<div class="wf-ac-category">${escapeHtml(cat)}</div>`;
      for (const item of items) {
        const idx = suggestions.indexOf(item);
        const typeColor = TYPE_COLORS[item.type] || TYPE_COLORS.any;
        const typeBadge = item.type ? `<span class="wf-ac-type" style="color:${typeColor}">${item.type}</span>` : '';
        html += `<div class="wf-ac-item${idx === 0 ? ' active' : ''}" data-idx="${idx}"><span class="wf-ac-label">${escapeHtml(item.label)}</span>${typeBadge}<span class="wf-ac-detail">${escapeHtml(item.detail)}</span></div>`;
      }
    }
    popup.innerHTML = html;
    const rect = anchorField.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    popup.style.top = (rect.bottom - containerRect.top + 2) + 'px';
    popup.style.left = (rect.left - containerRect.left) + 'px';
    popup.style.width = rect.width + 'px';
    popup.style.display = 'block';
    popup.querySelectorAll('.wf-ac-item').forEach(el => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); insertSuggestion(currentSuggestions[parseInt(el.dataset.idx, 10)].value); });
    });
  }
  function updateActiveItem() {
    popup.querySelectorAll('.wf-ac-item').forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    const activeEl = popup.querySelector('.wf-ac-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }
  let deepFetchId = 0;
  fields.forEach(field => {
    if (field.tagName === 'SELECT' || field.type === 'number' || field.type === 'checkbox') return;
    const wrapper = field.parentElement;
    if (!wrapper || wrapper.querySelector('.wf-var-picker-btn')) return;
    wrapper.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'wf-var-picker-btn';
    btn.type = 'button';
    btn.textContent = '{x}';
    btn.title = t('workflow.helpers.autocomplete.insertVariable');
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); showVariablePicker(field, node, graphService, container); });
    wrapper.appendChild(btn);
  });
  fields.forEach(field => {
    field.addEventListener('input', async () => {
      const val = field.value;
      const cursor = field.selectionStart;
      let dPos = -1;
      for (let i = cursor - 1; i >= 0; i--) { const ch = val[i]; if (ch === '$') { dPos = i; break; } if (!/[\w.]/.test(ch)) break; }
      if (dPos < 0) { hidePopup(); return; }
      dollarPos = dPos;
      activeField = field;
      const filterText = val.substring(dPos, cursor);
      const graph = graphService?.graph;
      const dotCount = (filterText.match(/\./g) || []).length;
      if (dotCount >= 2) {
        const fetchId = ++deepFetchId;
        const deepSuggestions = await getDeepAutocompleteSuggestions(graph, node?.id, filterText, schemaCache);
        if (fetchId !== deepFetchId) return;
        if (deepSuggestions.length > 0) { renderPopup(deepSuggestions, field); return; }
      }
      const suggestions = getAutocompleteSuggestions(graph, node?.id, filterText);
      renderPopup(suggestions, field);
    });
    field.addEventListener('keydown', (e) => {
      if (popup.style.display === 'none') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, currentSuggestions.length - 1); updateActiveItem(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); updateActiveItem(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { if (currentSuggestions.length > 0) { e.preventDefault(); insertSuggestion(currentSuggestions[activeIndex].value); } }
      else if (e.key === 'Escape') { e.preventDefault(); hidePopup(); }
    });
    field.addEventListener('blur', () => { setTimeout(() => { if (popup.style.display !== 'none') hidePopup(); }, 150); });
  });
}

// ── Variable picker ─────────────────────────────────────────────────────────

let activeVarPicker = null;

function showVariablePicker(anchorField, node, graphService, panelContainer) {
  hideVariablePicker();
  const graph = graphService?.graph;
  const suggestions = getAutocompleteSuggestions(graph, node?.id, '$');
  if (!suggestions.length) return;
  const groups = {};
  for (const s of suggestions) { if (!groups[s.category]) groups[s.category] = []; groups[s.category].push(s); }
  const picker = document.createElement('div');
  picker.className = 'wf-var-picker';
  const searchWrap = document.createElement('div');
  searchWrap.className = 'wf-var-picker-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = t('workflow.helpers.autocomplete.searchVariable');
  searchWrap.appendChild(searchInput);
  picker.appendChild(searchWrap);
  const catsEl = document.createElement('div');
  catsEl.className = 'wf-var-picker-categories';
  function renderItems(filter) {
    catsEl.innerHTML = '';
    const f = (filter || '').toLowerCase();
    let anyVisible = false;
    for (const [cat, items] of Object.entries(groups)) {
      const filtered = f ? items.filter(i => i.label.toLowerCase().includes(f) || i.detail.toLowerCase().includes(f)) : items;
      if (!filtered.length) continue;
      anyVisible = true;
      const catTitle = document.createElement('div');
      catTitle.className = 'wf-var-picker-cat-title';
      catTitle.textContent = cat;
      catsEl.appendChild(catTitle);
      for (const item of filtered) {
        const row = document.createElement('div');
        row.className = 'wf-var-picker-item';
        row.innerHTML = `<code>${escapeHtml(item.label)}</code><span>${escapeHtml(item.detail)}</span>`;
        row.addEventListener('mousedown', (e) => { e.preventDefault(); insertVariableAtCursor(anchorField, item.value); hideVariablePicker(); });
        catsEl.appendChild(row);
      }
    }
    if (!anyVisible) catsEl.innerHTML = `<div class="wf-var-picker-empty">${escapeHtml(t('workflow.helpers.autocomplete.noVariableFound'))}</div>`;
  }
  renderItems('');
  picker.appendChild(catsEl);
  const rect = anchorField.getBoundingClientRect();
  const containerRect = panelContainer.getBoundingClientRect();
  picker.style.top = (rect.bottom - containerRect.top + 4) + 'px';
  picker.style.left = (rect.left - containerRect.left) + 'px';
  panelContainer.appendChild(picker);
  activeVarPicker = picker;
  searchInput.focus();
  searchInput.addEventListener('input', () => renderItems(searchInput.value));
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideVariablePicker(); anchorField.focus(); } });
  const closeHandler = (e) => {
    if (!picker.contains(e.target) && e.target !== anchorField && !e.target.classList.contains('wf-var-picker-btn')) { hideVariablePicker(); document.removeEventListener('mousedown', closeHandler); }
  };
  setTimeout(() => document.addEventListener('mousedown', closeHandler), 10);
  picker._closeHandler = closeHandler;
}

function hideVariablePicker() {
  if (activeVarPicker) { if (activeVarPicker._closeHandler) document.removeEventListener('mousedown', activeVarPicker._closeHandler); activeVarPicker.remove(); activeVarPicker = null; }
}

function insertVariableAtCursor(field, variable) {
  const start = field.selectionStart || 0;
  const end = field.selectionEnd || 0;
  const before = field.value.substring(0, start);
  const after = field.value.substring(end);
  field.value = before + variable + after;
  const newPos = start + variable.length;
  field.setSelectionRange(newPos, newPos);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  HOOK_TYPES, NODE_OUTPUTS, STEP_TYPES, STEP_FIELDS, STEP_TYPE_ALIASES,
  GIT_ACTIONS, WAIT_UNITS, CONDITION_VARS, CONDITION_OPS,
  TRIGGER_CONFIG, CRON_MODES, getTriggerConfig,
  // Functions
  findStepType, buildConditionPreview,
  drawCronPicker, bindWfDropdown, wfDropdown,
  // Formatting
  fmtTime, fmtDuration, statusDot, statusLabel,
  // SVG icons
  svgWorkflow, svgAgent, svgShell, svgGit, svgHttp, svgNotify, svgWait, svgCond,
  svgClock, svgTimer, svgHook, svgChain, svgPlay, svgX, svgScope, svgConc,
  svgEmpty, svgRuns, svgClaude, svgPrompt, svgSkill, svgProject, svgFile, svgDb,
  svgLoop, svgVariable, svgLog, svgTriggerType, svgLink, svgMode, svgEdit,
  svgBranch, svgCode, svgTrash, svgCopy, svgTransform, svgGetVar, svgSwitch,
  svgSubworkflow, svgTeal,
  // Autocomplete & Schema
  getAutocompleteSuggestions, getDeepAutocompleteSuggestions,
  extractTableFromSQL, findUpstreamDbNode, getLoopPreview: null, // placeholder
  initSmartSQL: null, // placeholder
  // DOM helpers
  upgradeSelectsToDropdowns, setupAutocomplete,
  showVariablePicker, hideVariablePicker, insertVariableAtCursor,
  insertLoopBetween: (gs, link) => gs.insertLoopBetween(link),
};

// These need the schemaCache injected, so we export factory-style
module.exports.getLoopPreview = function getLoopPreview(loopNode, graphService) {
  const { escapeHtml: esc } = require('../../utils');
  const noPreview = { html: '', itemDesc: t('workflow.helpers.loopPreview.currentIterationValue'), schema: null };
  if (!graphService?.graph || !loopNode) return noPreview;
  const graph = graphService.graph;

  // Prefer Items slot (slot 1, data) over In slot (slot 0, exec) for source detection
  const itemsSlot = loopNode.inputs?.[1];
  const inSlot = loopNode.inputs?.[0];
  const activeLink = itemsSlot?.link ?? inSlot?.link;
  if (!activeLink && !inSlot?.link) return { html: `<div class="wf-loop-preview wf-loop-preview--empty"><span class="wf-loop-preview-icon">⚠</span> ${t('workflow.helpers.loopPreview.noNodeConnected')}</div>`, itemDesc: t('workflow.helpers.loopPreview.currentIterationValue') };
  const linkInfo = graph.links?.[activeLink] || graph._links?.get?.(activeLink);
  if (!linkInfo) return noPreview;
  const sourceNode = graph.getNodeById(linkInfo.origin_id);
  if (!sourceNode) return noPreview;
  const sourceType = (sourceNode.type || '').replace('workflow/', '');
  const sourceName = sourceNode.title || sourceType;
  const sourceProps = sourceNode.properties || {};
  let dataType = '', dataDesc = '', itemDesc = t('workflow.helpers.loopPreview.currentIterationValue'), previewItems = [];
  if (sourceType === 'db') {
    const action = sourceProps.action || 'query';
    if (action === 'query') { const table = extractTableFromSQL(sourceProps.query); dataType = 'rows[]'; dataDesc = table ? t('workflow.helpers.loopPreview.dbRowsFrom', { table: `<code>${esc(table)}</code>` }) : t('workflow.helpers.loopPreview.dbQueryResults'); itemDesc = table ? t('workflow.helpers.loopPreview.dbRowWithColumns', { table }) : t('workflow.helpers.loopPreview.dbResultRow'); }
    else if (action === 'tables') { dataType = 'string[]'; dataDesc = t('workflow.helpers.loopPreview.dbTableNames'); itemDesc = t('workflow.helpers.loopPreview.dbTableName'); }
    else if (action === 'schema') { dataType = 'object[]'; dataDesc = t('workflow.helpers.loopPreview.dbTablesWithColumns'); itemDesc = t('workflow.helpers.loopPreview.dbTableObject'); }
  } else if (sourceType === 'project') {
    dataType = 'project[]'; dataDesc = t('workflow.helpers.loopPreview.projects'); itemDesc = t('workflow.helpers.loopPreview.projectObject');
  } else if (sourceType === 'shell') { dataType = 'lines'; dataDesc = t('workflow.helpers.loopPreview.shellStdout'); itemDesc = t('workflow.helpers.loopPreview.shellLine'); }
  else if (sourceType === 'http') { dataType = 'array'; dataDesc = t('workflow.helpers.loopPreview.httpBody'); itemDesc = t('workflow.helpers.loopPreview.httpArrayItem'); }
  else if (sourceType === 'file') { dataType = 'lines'; dataDesc = t('workflow.helpers.loopPreview.fileContent'); itemDesc = t('workflow.helpers.loopPreview.fileLine'); }
  else { dataType = 'auto'; dataDesc = t('workflow.helpers.loopPreview.outputOf', { sourceName: esc(sourceName) }); itemDesc = t('workflow.helpers.loopPreview.outputItem'); }
  const lastOutput = graphService.getNodeOutput(sourceNode.id);
  if (lastOutput) {
    if (Array.isArray(lastOutput)) {
      previewItems = lastOutput;
    } else if (lastOutput && typeof lastOutput === 'object') {
      // Generic scan: find the first array property — works for any node type
      for (const val of Object.values(lastOutput)) {
        if (Array.isArray(val)) { previewItems = val; break; }
      }
    }
  }
  const countText = previewItems.length > 0 ? `<span class="wf-loop-preview-count">${t('workflow.helpers.loopPreview.itemsCount', { n: previewItems.length })}</span>` : '';
  let previewHtml = '';
  if (previewItems.length > 0) {
    const shown = previewItems.slice(0, 5);
    previewHtml = `<div class="wf-loop-preview-list">${shown.map((item, i) => {
      const text = typeof item === 'string' ? item : (item?.name || JSON.stringify(item));
      return `<div class="wf-loop-preview-item"><span class="wf-loop-preview-idx">${i}</span><code>${esc(String(text).substring(0, 60))}</code></div>`;
    }).join('')}${previewItems.length > 5 ? `<div class="wf-loop-preview-more">${t('workflow.helpers.loopPreview.moreItems', { n: previewItems.length - 5 })}</div>` : ''}</div>`;
  }
  // Extract schema from preview items (first object's keys)
  let schema = null;
  if (previewItems.length > 0 && typeof previewItems[0] === 'object' && previewItems[0] !== null && !Array.isArray(previewItems[0])) {
    schema = Object.keys(previewItems[0]);
  }
  return { html: `<div class="wf-loop-preview"><div class="wf-loop-preview-header"><span class="wf-loop-preview-source">${esc(sourceName)}</span><span class="wf-loop-preview-type">${dataType}</span>${countText}</div><div class="wf-loop-preview-desc">${dataDesc}</div>${previewHtml}</div>`, itemDesc, schema };
};

module.exports.initSmartSQL = async function initSmartSQL(container, node, graphService, schemaCache, dbConnectionsCache) {
  const { escapeHtml: esc } = require('../../utils');
  const connectionId = node.properties?.connection;
  const textarea = container.querySelector('.wf-sql-textarea');
  const templateBar = container.querySelector('.wf-sql-templates');
  if (!textarea) return;
  if (dbConnectionsCache) schemaCache.setConnectionConfigs(dbConnectionsCache);
  let sqlPopup = container.querySelector('.wf-sql-ac-popup');
  if (!sqlPopup) { sqlPopup = document.createElement('div'); sqlPopup.className = 'wf-sql-ac-popup'; sqlPopup.style.display = 'none'; container.appendChild(sqlPopup); }
  let acItems = [], acIndex = 0, acStart = -1;
  function hideSqlAc() { sqlPopup.style.display = 'none'; acItems = []; acIndex = 0; }
  function insertSqlAc(text) {
    if (acStart < 0) return;
    const before = textarea.value.substring(0, acStart);
    const after = textarea.value.substring(textarea.selectionStart);
    textarea.value = before + text + after;
    const newPos = acStart + text.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    hideSqlAc();
    textarea.focus();
  }
  function renderSqlAc(items, wordStart) {
    if (!items.length) { hideSqlAc(); return; }
    acItems = items; acIndex = 0; acStart = wordStart;
    sqlPopup.innerHTML = items.map((it, i) =>
      `<div class="wf-sql-ac-item${i === 0 ? ' active' : ''}" data-idx="${i}"><span class="wf-sql-ac-name">${esc(it.name)}</span><span class="wf-sql-ac-type">${esc(it.type || '')}</span></div>`
    ).join('');
    const rect = textarea.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    sqlPopup.style.top = (rect.bottom - containerRect.top + 2) + 'px';
    sqlPopup.style.left = (rect.left - containerRect.left) + 'px';
    sqlPopup.style.width = rect.width + 'px';
    sqlPopup.style.display = 'block';
    sqlPopup.querySelectorAll('.wf-sql-ac-item').forEach(el => {
      el.addEventListener('mousedown', (e) => { e.preventDefault(); insertSqlAc(acItems[parseInt(el.dataset.idx, 10)].name); });
    });
  }
  let tables = [];
  if (connectionId) { try { tables = await schemaCache.getSchema(connectionId) || []; } catch { /* silently fail */ } }
  textarea.addEventListener('input', () => {
    const val = textarea.value;
    const cursor = textarea.selectionStart;
    if (!tables.length) { hideSqlAc(); return; }
    let wordStart = cursor;
    while (wordStart > 0 && /[\w.]/.test(val[wordStart - 1])) wordStart--;
    const word = val.substring(wordStart, cursor).toLowerCase();
    if (!word) { hideSqlAc(); return; }
    const beforeWord = val.substring(0, wordStart).replace(/\s+$/, '').toUpperCase();
    const lastKeyword = beforeWord.match(/(FROM|INTO|UPDATE|JOIN|TABLE)\s*$/i);
    const dotParts = word.split('.');
    let suggestions = [];
    if (dotParts.length === 2) {
      const tableName = dotParts[0];
      const colFilter = dotParts[1];
      const table = tables.find(t => t.name.toLowerCase() === tableName);
      if (table?.columns) suggestions = table.columns.filter(c => (c.name || '').toLowerCase().startsWith(colFilter)).map(c => ({ name: c.name, type: c.type + (c.primaryKey ? ' PK' : '') }));
    } else if (lastKeyword) {
      suggestions = tables.filter(t => t.name.toLowerCase().startsWith(word)).map(t => ({ name: t.name, type: `${t.columns?.length || 0} cols` }));
    } else {
      suggestions = tables.filter(t => t.name.toLowerCase().startsWith(word)).map(t => ({ name: t.name, type: 'table' }));
      if (word.length >= 2) {
        const seen = new Set(suggestions.map(s => s.name));
        for (const table of tables) { for (const col of (table.columns || [])) { const colName = col.name || ''; if (!seen.has(colName) && colName.toLowerCase().startsWith(word)) { seen.add(colName); suggestions.push({ name: colName, type: `${table.name}.${col.type || ''}` }); } } }
      }
    }
    if (suggestions.length > 12) suggestions = suggestions.slice(0, 12);
    renderSqlAc(suggestions, wordStart);
  });
  textarea.addEventListener('keydown', (e) => {
    if (sqlPopup.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); acIndex = Math.min(acIndex + 1, acItems.length - 1); sqlPopup.querySelectorAll('.wf-sql-ac-item').forEach((el, i) => el.classList.toggle('active', i === acIndex)); sqlPopup.querySelector('.wf-sql-ac-item.active')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acIndex = Math.max(acIndex - 1, 0); sqlPopup.querySelectorAll('.wf-sql-ac-item').forEach((el, i) => el.classList.toggle('active', i === acIndex)); }
    else if (e.key === 'Tab' || e.key === 'Enter') { if (acItems.length) { e.preventDefault(); insertSqlAc(acItems[acIndex].name); } }
    else if (e.key === 'Escape') { e.preventDefault(); hideSqlAc(); }
  });
  textarea.addEventListener('blur', () => { setTimeout(() => hideSqlAc(), 150); });
  if (templateBar && tables.length) {
    templateBar.querySelectorAll('.wf-sql-tpl').forEach(btn => {
      btn.addEventListener('click', () => {
        const tpl = btn.dataset.tpl;
        const firstTable = tables[0]?.name || 'table_name';
        let sql = '';
        switch (tpl) {
          case 'select': sql = `SELECT * FROM ${firstTable}\nWHERE \nORDER BY \nLIMIT 100`; break;
          case 'insert': sql = `INSERT INTO ${firstTable} (col1, col2)\nVALUES ('val1', 'val2')`; break;
          case 'update': sql = `UPDATE ${firstTable}\nSET col1 = 'val1'\nWHERE id = `; break;
          case 'delete': sql = `DELETE FROM ${firstTable}\nWHERE id = `; break;
        }
        textarea.value = sql;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        const tablePos = sql.indexOf(firstTable) + firstTable.length;
        textarea.setSelectionRange(tablePos, tablePos);
      });
    });
  }
};
