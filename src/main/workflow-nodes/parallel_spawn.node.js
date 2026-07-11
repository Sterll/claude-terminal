'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

function resolveVars(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
    const parts = key.split('.');
    let cur = vars instanceof Map ? vars.get(parts[0]) : vars?.[parts[0]];
    for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
    return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
  });
}

function projectsFile() {
  return path.join(os.homedir(), '.claude-terminal', 'projects.json');
}

function findProjectPath(ref, vars) {
  if (!ref) {
    const ctx = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
    ref = ctx.activeProjectId || ctx.projectId || '';
  }
  if (!ref) return null;
  if (fs.existsSync(ref)) return ref;
  try {
    const data = JSON.parse(fs.readFileSync(projectsFile(), 'utf8'));
    const needle = String(ref).toLowerCase();
    const project = (data.projects || []).find(p =>
      p.id === ref ||
      (p.name || '').toLowerCase() === needle ||
      (p.name || '').toLowerCase().includes(needle)
    );
    return project?.path || null;
  } catch {
    return null;
  }
}

module.exports = {
  type:     'workflow/parallel_spawn',
  title:    'Parallel: Spawn Run',
  desc:     'Lance un run parallèle (décompose un goal en sous-tâches)',
  color:    'red',
  width:    240,
  category: 'actions',
  icon:     'parallel',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',  type: 'exec'   },
    { name: 'Error', type: 'exec'   },
    { name: 'runId', type: 'string' },
  ],

  props: {
    projectId:  '',
    goal:       '',
    mainBranch: 'main',
    maxTasks:   4,
    autoTasks:  false,
    model:      '',
    effort:     '',
  },

  fields: [
    { type: 'cwd-picker', key: 'projectId', label: 'wfn.parallel.project.label',
      hint: 'wfn.parallel.project.hint' },
    { type: 'textarea', key: 'goal',       label: 'wfn.parallel.goal.label',
      placeholder: 'Add dark mode to the settings panel' },
    { type: 'text',     key: 'mainBranch', label: 'wfn.parallel.mainBranch.label',
      placeholder: 'main' },
    { type: 'number',   key: 'maxTasks',   label: 'wfn.parallel.maxTasks.label' },
    { type: 'boolean',  key: 'autoTasks',  label: 'wfn.parallel.autoTasks.label' },
    { type: 'select',   key: 'model',      label: 'wfn.parallel.model.label',
      options: ['', 'sonnet', 'opus', 'haiku'] },
    { type: 'select',   key: 'effort',     label: 'wfn.parallel.effort.label',
      options: ['', 'low', 'medium', 'high'] },
  ],

  badge: () => '||',

  async run(config, vars, signal) {
    if (signal?.aborted) throw new Error('Aborted');

    const goal = resolveVars(config.goal || '', vars).trim();
    if (!goal) throw new Error('Goal is required');

    const projectPath = findProjectPath(resolveVars(config.projectId || '', vars), vars);
    if (!projectPath) throw new Error('Project path could not be resolved');

    const mainBranch = resolveVars(config.mainBranch || 'main', vars) || 'main';
    const maxTasks   = Math.max(1, Math.min(10, parseInt(config.maxTasks, 10) || 4));
    const autoTasks  = !!config.autoTasks;

    // Validate model against the supported set; ignore anything else.
    const VALID_MODELS = ['sonnet', 'opus', 'haiku'];
    const model  = VALID_MODELS.includes(config.model) ? config.model : undefined;
    const VALID_EFFORTS = ['low', 'medium', 'high'];
    const effort = VALID_EFFORTS.includes(config.effort) ? config.effort : undefined;

    // NOTE: ParallelTaskService.startRun does not currently accept an
    // AbortSignal, so `signal` cannot be forwarded to cancel an in-flight
    // decomposition. Cancellation of the spawned run is handled separately via
    // ParallelTaskService.cancelRun(runId). We still honour a pre-abort above.
    const ParallelTaskService = require('../services/ParallelTaskService');
    const result = await ParallelTaskService.startRun({
      projectPath, mainBranch, goal, maxTasks, autoTasks, model, effort,
    });

    if (!result.success) throw new Error(result.error || 'Failed to start parallel run');
    return { runId: result.runId, projectPath, goal };
  },
};
