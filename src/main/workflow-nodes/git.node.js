'use strict';

module.exports = {
  type:     'workflow/git',
  title:    'Git',
  desc:     'Opération git',
  color:    'purple',
  width:    200,
  category: 'actions',
  icon:     'git',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',   type: 'exec'   },
    { name: 'Error',  type: 'exec'   },
    { name: 'output', type: 'string' },
  ],

  props: { action: 'pull', branch: '', message: '' },

  fields: [
    { type: 'cwd-picker', key: 'projectId', label: 'wfn.git.projectId.label',
      hint: 'wfn.git.projectId.hint' },
    { type: 'select', key: 'action', label: 'wfn.git.action.label',
      options: [
        { value: 'pull',      label: 'wfn.git.action.pull' },
        { value: 'push',      label: 'wfn.git.action.push' },
        { value: 'commit',    label: 'wfn.git.action.commit' },
        { value: 'checkout',  label: 'wfn.git.action.checkout' },
        { value: 'merge',     label: 'wfn.git.action.merge' },
        { value: 'stash',     label: 'wfn.git.action.stash' },
        { value: 'stash-pop', label: 'wfn.git.action.stashpop' },
        { value: 'reset',     label: 'wfn.git.action.reset' },
      ] },
    { type: 'text', key: 'message', label: 'wfn.git.message.label', mono: true,
      hint: 'wfn.git.message.hint',
      placeholder: 'feat(auth): add password reset',
      showIf: (p) => p.action === 'commit' },
    { type: 'text', key: 'branch', label: 'wfn.git.branch.label', mono: true,
      hint: 'wfn.git.branch.hint',
      placeholder: 'feature/my-branch',
      showIf: (p) => ['checkout','merge'].includes(p.action) },
  ],

  badge: (n) => (n.properties.action || 'pull').toUpperCase(),

  // NOTE: runGitStep is not yet exported from WorkflowRunner (module.exports = WorkflowRunner class only).
  // This run() delegates to the git.js utilities directly and will be wired to WorkflowRunner.runGitStep in Task 9.
  async run(config, vars, signal) {
    const {
      gitCommit, gitPull, gitPush, gitStageFiles,
      checkoutBranch, spawnGit,
    } = require('../utils/git');

    // Minimal inline var resolution until WorkflowRunner exports resolveVars
    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    // Resolve working directory from vars context or fallback
    let cwd = resolveVars(config.cwd || '', vars);
    if (!cwd) {
      const ctx = (vars instanceof Map ? vars.get('ctx') : vars?.ctx) || {};
      cwd = ctx.project || process.cwd();
    }

    const action  = config.action || 'pull';
    const branch  = resolveVars(config.branch  || '', vars);
    const message = resolveVars(config.message || '', vars);

    let res;
    switch (action) {
      case 'pull':      res = await gitPull(cwd); break;
      case 'push':      res = await gitPush(cwd); break;
      case 'commit': {
        await gitStageFiles(cwd, config.files || ['.']);
        res = await gitCommit(cwd, message || 'workflow commit');
        break;
      }
      case 'checkout':  res = await checkoutBranch(cwd, branch); break;
      case 'merge':     res = await spawnGit(cwd, ['merge', branch]); break;
      case 'stash':     res = await spawnGit(cwd, ['stash']); break;
      case 'stash-pop': res = await spawnGit(cwd, ['stash', 'pop']); break;
      case 'reset':     res = await spawnGit(cwd, ['reset', '--hard', 'HEAD']); break;
      default:          res = { success: false, error: `Unknown git action: ${action}` };
    }

    return {
      success: res.success !== false,
      output:  res.output || res.stdout || '',
      action,
    };
  },
};
