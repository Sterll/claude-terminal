/**
 * New-project helpers - the decisions behind the creation dialog, kept free of
 * the DOM and of the file system so they can be tested on their own.
 *
 *   folderNameFor()      the folder a display name becomes
 *   detectProjectType()  a type suggestion from what an existing folder holds
 *   findDuplicate()      the project that already lives at a path
 *   validateDraft()      everything that blocks "Create", as one verdict
 */

/** Characters no file system on the three platforms accepts in a name. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * The folder name for a project called `name`.
 *
 * Loose (create / clone): the name as typed, minus what a file system refuses,
 * so "My App" stays "My App". Strict (templates): npm's package-name rules,
 * which the generators enforce on the folder name ("my-app").
 */
function folderNameFor(name, { strict = false } = {}) {
  let out = String(name || '').normalize('NFKC').trim();
  if (strict) {
    out = out.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-._]+|[-.]+$/g, '').slice(0, 214);
  } else {
    out = out.replace(FORBIDDEN, '-').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
    if (WINDOWS_RESERVED.test(out)) out = `${out}-project`;
  }
  return out || 'project';
}

const WEB_DEPS = ['next', 'nuxt', 'vite', 'react', 'vue', 'svelte', '@sveltejs/kit', 'astro', '@angular/core', 'solid-js', 'gatsby', 'remix', '@remix-run/react'];
const API_DEPS = ['express', 'fastify', 'koa', '@nestjs/core', 'hono', '@hapi/hapi', 'restify', 'elysia'];
const DISCORD_DEPS = ['discord.js', 'eris', 'oceanic.js', 'discord.py', 'nextcord'];

/**
 * Suggest a project type from the entries of a folder (and its package.json,
 * when there is one). Only a suggestion: the dialog preselects it and says
 * why, the user can pick another.
 *
 * @param {string[]} entries  file and folder names at the folder's top level
 * @param {object|null} pkg   parsed package.json, or null
 * @param {string|null} pyDeps  requirements.txt / pyproject.toml text, or null
 * @returns {{ type: string, reason: string }|null}
 */
function detectProjectType(entries, pkg = null, pyDeps = null) {
  const has = (name) => entries.some((e) => e.toLowerCase() === name.toLowerCase());
  if (has('fxmanifest.lua') || has('__resource.lua') || (has('server.cfg') && has('resources'))) {
    return { type: 'fivem', reason: has('server.cfg') ? 'server.cfg' : 'fxmanifest.lua' };
  }
  if (has('server.properties') || has('plugin.yml') || entries.some((e) => /^(paper|spigot|purpur|forge|fabric)[^/]*\.jar$/i.test(e))) {
    return { type: 'minecraft', reason: has('server.properties') ? 'server.properties' : 'plugin.yml' };
  }
  if (pkg && typeof pkg === 'object') {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const hit = (list) => list.find((d) => Object.hasOwn(deps, d));
    const discord = hit(DISCORD_DEPS);
    if (discord) return { type: 'discord', reason: discord };
    const web = hit(WEB_DEPS);
    if (web) return { type: 'webapp', reason: web };
    const api = hit(API_DEPS);
    if (api) return { type: 'api', reason: api };
  }
  const isPython = has('requirements.txt') || has('pyproject.toml') || has('setup.py') || has('Pipfile');
  if (isPython) {
    const text = String(pyDeps || '').toLowerCase();
    if (/\bdiscord(\.py)?\b|\bnextcord\b|\bpy-cord\b/.test(text)) return { type: 'discord', reason: 'discord.py' };
    if (/\b(fastapi|flask|django)\b/.test(text)) return { type: 'api', reason: text.match(/\b(fastapi|flask|django)\b/)[1] };
    return { type: 'python', reason: has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt' };
  }
  return null;
}

/** Comparable form of a local path: forward slashes, no trailing slash, case-folded. */
function comparablePath(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function findDuplicate(projects, targetPath) {
  const wanted = comparablePath(targetPath);
  if (!wanted) return null;
  return (projects || []).find((p) => comparablePath(p.path) === wanted) || null;
}

const REPO_URL = /^(https:\/\/|git@)[^\s]+$/;

/** Name a repository URL suggests for the project ("…/my-repo.git" → "my-repo"). */
function nameFromRepoUrl(url) {
  const m = String(url || '').trim().match(/[/:]([^/:]+?)(\.git)?\/?$/);
  return m ? m[1] : '';
}

/**
 * One verdict for the form. `probe` is what the dialog learned about the
 * relevant path: 'dir' | 'file' | 'missing' | 'denied' | 'unknown'.
 *
 * @returns {{ ok: boolean, error?: string, warning?: string, target?: string }}
 *   error/warning are i18n keys (under newProject.*); target is the folder the
 *   project will live in.
 */
function validateDraft({ source, name, location, repoUrl, template, probe, projects, joinPath }) {
  const trimmedName = String(name || '').trim();
  const loc = String(location || '').trim();
  if (!trimmedName) return { ok: false };
  if (!loc) return { ok: false };
  if (source === 'clone' && !REPO_URL.test(String(repoUrl || '').trim())) {
    return { ok: false, error: repoUrl ? 'newProject.v.badRepoUrl' : undefined };
  }
  if (source === 'scaffold' && !template) return { ok: false, error: 'newProject.v.pickTemplate' };

  const target = source === 'folder'
    ? loc
    : joinPath(loc, folderNameFor(trimmedName, { strict: source === 'scaffold' }));
  const dup = findDuplicate(projects, target);
  if (dup) return { ok: false, error: 'newProject.v.duplicate', errorParams: { name: dup.name }, target };

  if (probe === 'denied') return { ok: false, error: 'newProject.v.pickWithDialog', target };
  if (source === 'folder') {
    if (probe === 'file') return { ok: false, error: 'newProject.v.notAFolder', target };
    if (probe === 'missing') return { ok: true, warning: 'newProject.v.willCreateFolder', target };
    return { ok: true, target };
  }
  // create / clone / scaffold: `probe` describes the target folder itself.
  if (probe === 'dir' || probe === 'file') return { ok: false, error: 'newProject.v.targetExists', errorParams: { path: target }, target };
  return { ok: true, target };
}

module.exports = {
  folderNameFor,
  detectProjectType,
  comparablePath,
  findDuplicate,
  nameFromRepoUrl,
  validateDraft,
  REPO_URL,
};
