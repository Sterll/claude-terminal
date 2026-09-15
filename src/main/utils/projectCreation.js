'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const { runCommand } = require('./runCommand');
async function inStaging(targetPath, signal, action) {
  if (await fs.lstat(targetPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Folder already exists');
  const parent = path.dirname(targetPath); await fs.mkdir(parent, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(parent, '.ct-create-'));
  const staged = path.join(temporary, path.basename(targetPath));
  try {
    signal?.throwIfAborted();
    await action(staged, temporary);
    signal?.throwIfAborted();
    if (await fs.lstat(targetPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Folder appeared during creation; destination preserved');
    await fs.rename(staged, targetPath);
    return { success: true, path: targetPath };
  } finally { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
async function clone(repoUrl, targetPath, { token, signal, onProgress } = {}) {
  let url = repoUrl, authorization;
  if (/^https?:\/\//i.test(repoUrl)) {
    const parsed = new URL(repoUrl);
    if (parsed.username || parsed.password) authorization = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
    else if (token && parsed.protocol === 'https:') authorization = `x-access-token:${token}`;
    parsed.username = ''; parsed.password = ''; url = parsed.href;
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (authorization) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${new URL(url).origin}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = 'Authorization: Basic ' + Buffer.from(authorization).toString('base64');
  }
  return inStaging(targetPath, signal, staged => runCommand('git', ['-c', 'protocol.ext.allow=never', 'clone', '--progress', '--', url, staged], { env, signal, onProgress }));
}
function scaffoldArgs(template, name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,213}$/.test(name)) throw new Error('Use a lowercase project name with letters, digits, dots, hyphens or underscores');
  const vite = { react: 'react-ts', vue: 'vue-ts', svelte: 'svelte-ts' };
  if (Object.hasOwn(vite, template)) return ['create', 'vite@latest', name, '--', '--template', vite[template], '--no-interactive'];
  if (template === 'nextjs') return ['exec', '--yes', '--', 'create-next-app@latest', name, '--ts', '--eslint', '--app', '--src-dir', '--no-tailwind', '--import-alias', '@/*', '--yes', '--use-npm'];
  if (template === 'nuxt') return ['create', 'nuxt@latest', name, '--', '--template', 'v4', '--no-install', '--no-modules', '--packageManager', 'npm', '--gitInit=false'];
  if (template === 'astro') return ['create', 'astro@latest', name, '--', '--template', 'minimal', '--skip-houston', '--no-install', '--no-git', '--yes'];
  throw new Error('Unknown project template');
}
async function scaffold(template, targetPath, { signal, onProgress } = {}) {
  const args = scaffoldArgs(template, path.basename(targetPath));
  return inStaging(targetPath, signal, (_staged, cwd) => {
    const options = { cwd, signal, onProgress, env: { ...process.env, npm_config_yes: 'true', CI: 'true' } };
    // Windows npm is a .cmd shim. All arguments here are fixed flags or the
    // validated package name, so cmd expansion cannot accept shell metacharacters.
    return process.platform === 'win32'
      ? runCommand(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ' + args.map(arg => `"${arg}"`).join(' ')], options)
      : runCommand('npm', args, options);
  });
}
module.exports = { clone, scaffold, scaffoldArgs, inStaging };
