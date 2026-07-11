'use strict';

const { resolveVars, normalizeExitCode } = require('./_registry');

module.exports = {
  type:     'workflow/shell',
  title:    'Shell',
  desc:     'Commande bash',
  color:    'blue',
  width:    220,
  category: 'actions',
  icon:     'shell',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',     type: 'exec'   },
    { name: 'Error',    type: 'exec'   },
    { name: 'stdout',    type: 'string'  },
    { name: 'stderr',    type: 'string'  },
    { name: 'exitCode',  type: 'number'  },
    { name: 'timedOut',  type: 'boolean' },
    { name: 'truncated', type: 'boolean' },
  ],

  props: { command: '' },

  fields: [
    { type: 'cwd-picker', key: 'projectId', label: 'wfn.shell.projectId.label',
      hint: 'wfn.shell.projectId.hint' },
    { type: 'textarea', key: 'command', label: 'wfn.shell.command.label', mono: true,
      placeholder: 'npm run build' },
  ],

  badge: () => '$',
  drawExtra: (ctx, n) => {
    const MONO = '"Cascadia Code","Fira Code",monospace';
    if (n.properties.command) {
      ctx.fillStyle = '#444';
      ctx.font = `10px ${MONO}`;
      const cmd = n.properties.command.length > 28
        ? n.properties.command.slice(0, 28) + '...'
        : n.properties.command;
      ctx.textAlign = 'left';
      ctx.fillText('$ ' + cmd, 10, n.size[1] - 6);
    }
  },

  // Runner call convention: run(config, vars, signal, ctx).
  //
  // SECURITY NOTE: a Shell node runs an arbitrary user-authored command line.
  // We keep child_process.exec here because the command may legitimately use
  // shell features (pipes, redirects, &&, env expansion). There is no argv to
  // split safely without breaking those. The command is fully user-controlled
  // by design — this node is not exposed to untrusted input. `cwd` is resolved
  // from the workflow project context so the command does not accidentally run
  // in Electron's own working directory.
  async run(config, vars, signal) {
    const { exec } = require('child_process');

    const raw = String(resolveVars(config.command || '', vars) ?? '');
    if (!raw.trim()) throw new Error('No command specified');

    // Resolve cwd from the project context (config.projectId is a stored id,
    // the path lives in ctx.project) with a safe fallback to Electron cwd.
    const varCtx = vars instanceof Map ? (vars.get('ctx') || {}) : (vars?.ctx || {});
    const cwd = (resolveVars(config.cwd || '', vars) || varCtx.project || '') || undefined;

    const MAX_BUFFER = 4 * 1024 * 1024;

    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));

      let child;
      const onAbort = () => { try { child?.kill('SIGKILL'); } catch {} };
      signal?.addEventListener('abort', onAbort, { once: true });

      child = exec(
        raw,
        { cwd, timeout: 60000, encoding: 'utf8', maxBuffer: MAX_BUFFER },
        (err, stdout, stderr) => {
          try {
            if (signal?.aborted) return reject(new Error('Aborted'));
            const { exitCode, timedOut, truncated, killed } = normalizeExitCode(err);
            resolve({
              stdout:   stdout || '',
              stderr:   stderr || '',
              exitCode,
              timedOut,
              truncated,
              killed,
            });
          } finally {
            signal?.removeEventListener('abort', onAbort);
          }
        }
      );
    });
  },
};
