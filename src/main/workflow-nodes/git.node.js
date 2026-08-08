'use strict';

const { resolveVars } = require('./_registry');

module.exports = {
  type:     'workflow/git',
  title:    'Git',
  desc:     'Git operation',
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

  props: { action: 'pull', branch: '', message: '', files: '', projectId: '' },

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
    { type: 'text', key: 'files', label: 'Files to stage', mono: true,
      hint: 'Comma-separated paths, or "." for all (default)',
      placeholder: '.',
      showIf: (p) => p.action === 'commit' },
  ],

  badge: (n) => (n.properties.action || 'pull').toUpperCase(),

  // Runner call convention: run(config, vars, signal, ctx).
  async run(config, vars, signal) {
    const fs = require('fs');
    const {
      gitCommit, gitPull, gitPush, gitStageFiles,
      checkoutBranch, spawnGit,
    } = require('../utils/git');

    if (signal?.aborted) throw new Error('Aborted');

    // Resolve working directory. Some destructive actions (reset --hard) must
    // NOT fall back to Electron's own cwd — require an explicit, existing
    // project directory instead.
    const varCtx = (vars instanceof Map ? vars.get('ctx') : vars?.ctx) || {};
    // The cwd-picker field stores its value under `projectId`; also accept an
    // explicit `cwd` for backward compatibility.
    let cwd = String(resolveVars(config.cwd || config.projectId || '', vars) ?? '').trim();
    if (!cwd) cwd = varCtx.project || '';

    if (!cwd || !fs.existsSync(cwd)) {
      throw new Error('Git node: a valid project working directory is required (no cwd/projectId resolved)');
    }

    const action  = config.action || 'pull';
    const branch  = String(resolveVars(config.branch  || '', vars) ?? '');
    const message = String(resolveVars(config.message || '', vars) ?? '');

    // Files to stage for commit: comma-separated string, array, or default '.'.
    let files = ['.'];
    if (Array.isArray(config.files)) {
      files = config.files.length ? config.files : ['.'];
    } else if (typeof config.files === 'string' && config.files.trim()) {
      const resolved = String(resolveVars(config.files, vars) ?? '').trim();
      files = resolved ? resolved.split(',').map(s => s.trim()).filter(Boolean) : ['.'];
      if (!files.length) files = ['.'];
    }

    if (signal?.aborted) throw new Error('Aborted');

    let res;
    switch (action) {
      case 'pull':      res = await gitPull(cwd); break;
      case 'push':      res = await gitPush(cwd); break;
      case 'commit': {
        await gitStageFiles(cwd, files);
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
      // Without this, a failed git step logged {success:false, output:''} and
      // nothing else — no pathspec, no conflict message, nothing to act on.
      ...(res.success === false && res.error ? { error: res.error } : {}),
      action,
    };
  },
};
