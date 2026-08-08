'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { resolveVars } = require('./_registry');
const { findProjectRecord, projectLabel } = require('./_projects');

/**
 * Run one of a project's quick actions.
 *
 * Quick actions are the commands a user already pinned to a project (Build,
 * Dev, Test…), stored on the project record in ~/.claude-terminal/projects.json
 * under `quickActions`. Re-typing those commands into a `shell` node duplicates
 * them: change the action in the UI and the workflow keeps running the old one.
 * This node reads the single source of truth instead.
 *
 * WHAT THIS CANNOT DO, honestly: a quick action opens a terminal tab and types
 * its command — that is the renderer's job. The command is handed over on the
 * `mcp-terminal:send` channel (same payload as the terminal MCP tool), which is
 * fire-and-forget: no exit code, no output, no confirmation it ran. Use `shell`
 * when you need the result.
 *
 * The `quickaction:run` channel would be the semantically obvious one, but
 * nothing in the renderer listens to it today — the preload exposes
 * `project.onQuickActionRun` and no consumer ever subscribes — so sending there
 * would look right and do nothing.
 *
 * Placeholder substitution mirrors QuickActions._substituteVariables exactly,
 * so a command behaves the same whether a human clicked it or a workflow ran
 * it: $PROJECT_PATH, $PROJECT_NAME, $BRANCH, $HOME, then the project's custom
 * env vars (which win, as in the UI). Workflow variables resolve in the same
 * pass and rank lowest, so a $BRANCH in a quick action can never be shadowed by
 * an unrelated workflow variable of the same name.
 */

/**
 * Current branch of a git working tree, read straight from .git/HEAD.
 *
 * The UI takes this from the git status it already polls; the main process has
 * no such cache here, and spawning `git` for one string would add a process and
 * a 15s timeout to every run. A detached HEAD yields the short sha, matching
 * what the UI shows.
 * @param {string} projectPath
 * @returns {string} branch name, or '' when this is not a repo
 */
function currentBranch(projectPath) {
  if (!projectPath) return '';
  try {
    const head = fs.readFileSync(path.join(projectPath, '.git', 'HEAD'), 'utf8').trim();
    const ref  = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 7);
  } catch {
    return '';
  }
}

/** Flatten the workflow variable container into a plain lookup object. */
function varsToObject(vars) {
  if (vars instanceof Map) return Object.fromEntries(vars);
  return (vars && typeof vars === 'object') ? { ...vars } : {};
}

module.exports = {
  type:     'workflow/quickaction',
  title:    'Quick Action',
  desc:     "Run one of a project's saved quick actions (handed to a terminal tab, not awaited)",
  color:    'orange',
  width:    240,
  category: 'actions',
  icon:     'quickaction',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',    type: 'exec'   },
    { name: 'Error',   type: 'exec'   },
    { name: 'command', type: 'string' },
  ],

  props: { projectId: '', action: '' },

  fields: [
    { type: 'cwd-picker', key: 'projectId', label: 'wfn.quickaction.project.label',
      hint: 'wfn.quickaction.project.hint' },
    { type: 'text', key: 'action', label: 'wfn.quickaction.action.label',
      hint: 'wfn.quickaction.action.hint',
      placeholder: 'Build' },
  ],

  badge: () => 'QA',
  drawExtra: (ctx, n) => {
    const name = n.properties.action;
    if (!name) return;
    ctx.fillStyle = '#888';
    ctx.font = '10px "Cascadia Code","Fira Code",monospace';
    ctx.textAlign = 'left';
    const label = String(name);
    ctx.fillText(label.length > 28 ? label.slice(0, 28) + '...' : label, 10, n.size[1] - 6);
  },

  async run(config, vars, signal, ctx) {
    if (signal?.aborted) throw new Error('Cancelled');

    const projectRef = String(resolveVars(config.projectId || '', vars) ?? '').trim();
    const project    = findProjectRecord(projectRef, vars);
    if (!project) {
      throw new Error(projectRef
        ? `Quick action node: project "${projectRef}" not found in projects.json`
        : 'Quick action node: no project selected, and the run context has none');
    }

    const name = String(resolveVars(config.action || '', vars) ?? '').trim();
    if (!name) throw new Error('Quick action node: no action name configured');

    const actions = Array.isArray(project.quickActions) ? project.quickActions : [];
    const needle  = name.toLowerCase();
    // Exact id, then exact name, then a unique-enough prefix/substring — the
    // same widening the MCP tools and the kanban node use.
    const quickAction =
      actions.find(a => a.id === name) ||
      actions.find(a => (a.name || '').toLowerCase() === needle) ||
      actions.find(a => (a.name || '').toLowerCase().includes(needle));

    if (!quickAction) {
      const available = actions.map(a => a.name).filter(Boolean).join(', ');
      throw new Error(`Quick action "${name}" not found on project "${projectLabel(project)}". Available: ${available || 'none'}`);
    }

    const raw = String(quickAction.command || '');
    if (!raw.trim()) throw new Error(`Quick action "${quickAction.name}" has no command`);

    const scope = {
      ...varsToObject(vars),
      PROJECT_PATH: project.path || '',
      PROJECT_NAME: projectLabel(project),
      BRANCH:       currentBranch(project.path),
      HOME:         os.homedir(),
      ...(project.envVars && typeof project.envVars === 'object' ? project.envVars : {}),
    };

    const command = String(resolveVars(raw, scope) ?? '').replace(/[\r\n]+$/, '');

    if (!ctx?.sendFn) {
      throw new Error('Quick action node: no renderer channel available — a quick action runs in a terminal tab');
    }

    ctx.sendFn('mcp-terminal:send', {
      projectId:   project.id,
      projectName: projectLabel(project),
      command,
      actionId:    quickAction.id || '',
      actionName:  quickAction.name || '',
      source:      'workflow-quickaction',
    });

    return { command };
  },
};
