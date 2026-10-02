/**
 * The one place a path decides between "local" and "remote".
 *
 * Every main-process primitive that may serve a remote project (git, fs,
 * session history, terminals) asks `resolveTarget()` and forks on its `kind`.
 * For a local path the answer is `{ kind: 'local', path }` with the path
 * untouched, so the local code path is exactly what it was.
 *
 * For an `ssh-remote://` URI the answer is only ever `kind: 'remote'` when
 * both hold:
 *   - the URI's profile id names a host profile configured on this machine;
 *   - the URI lies inside a project registered in projects.json for that
 *     profile.
 * Anything else throws. A compromised renderer can therefore reach at most the
 * hosts the user configured, inside the folders the user opened
 * (design/remote-ssh.md section 4.1). The directory browser of the Open Remote
 * Project flow is the single exception, and has its own entry point,
 * `resolveBrowseTarget`, which carries no project and is only used for
 * listing directories, mkdir, init and clone.
 *
 * An unreadable projects.json refuses the remote request rather than being
 * read as "no projects": for an authorisation check, fail closed.
 */

'use strict';

const fs = require('fs');
const remotePath = require('../../shared/remote-path');
const { displayDestination } = require('./sshCommand');

function targetError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Read the project list. Absent is an empty list; unreadable throws. */
async function readProjectsFile(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw targetError('PROJECTS_UNREADABLE', `Refusing to resolve a remote path: projects.json could not be read (${e.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw targetError('PROJECTS_UNREADABLE', `Refusing to resolve a remote path: projects.json is unparseable (${e.message})`);
  }
  if (Array.isArray(parsed)) return parsed;
  return parsed && Array.isArray(parsed.projects) ? parsed.projects : [];
}

/** The canonical root of a remote project entry for `profileId`, or null. */
function remoteRootOf(project, profileId) {
  if (!project || typeof project !== 'object') return null;
  const parsed = remotePath.tryParse(project.path);
  if (!parsed || parsed.profileId !== profileId) return null;
  if (project.remote && project.remote.profileId && project.remote.profileId !== profileId) return null;
  return parsed.path;
}

/**
 * Worktrees of remote repositories, learned from git's own answers
 * (`git worktree list`, a successful `git worktree add`) by git.js. A
 * worktree usually sits next to its project, outside every registered root,
 * yet a terminal, a chat or the Git panel opened in it must resolve like the
 * project. Each root maps to the roots of the same repository; a path inside
 * one resolves when one of those is a registered project. Never fed by the
 * renderer, and `/` is never accepted as a root.
 */
function createWorktreeRegistry() {
  const groups = new Map(); // profileId -> Map<root, Set<root>>

  function note(profileId, roots) {
    if (!remotePath.isValidProfileId(profileId) || !Array.isArray(roots)) return;
    const clean = [];
    for (const root of roots) {
      if (typeof root !== 'string' || !root.startsWith('/') || remotePath.hasControlChars(root)) continue;
      let posix;
      try { posix = remotePath.toPosix(root); } catch { continue; }
      if (posix !== '/') clean.push(posix);
    }
    if (clean.length === 0) return;
    if (!groups.has(profileId)) groups.set(profileId, new Map());
    const byRoot = groups.get(profileId);
    const merged = new Set(clean);
    for (const root of clean) for (const other of byRoot.get(root) || []) merged.add(other);
    for (const root of merged) byRoot.set(root, merged);
    if (byRoot.size > 500) byRoot.clear();
  }

  /** The longest known worktree root containing `path`, with the roots of its repository. */
  function lookup(profileId, path) {
    const byRoot = groups.get(profileId);
    if (!byRoot) return null;
    let best = null;
    for (const [root, group] of byRoot) {
      if (remotePath.isInside(path, root) && (!best || root.length > best.root.length)) best = { root, group };
    }
    return best;
  }

  return { note, lookup, clear: () => groups.clear() };
}

/**
 * @param {object} deps
 * @param {(profileId: string) => Promise<object|null>} deps.getProfile
 * @param {() => Promise<object[]>} deps.loadProjects
 * @param {ReturnType<typeof createWorktreeRegistry>} [deps.worktrees]
 * @param {(profileId: string, projectUris: string[]) => Promise<void>} [deps.discoverWorktrees]
 *        asked once when a path is in no registered project, to learn worktree roots
 */
function createTargetResolver({ getProfile, loadProjects, worktrees = null, discoverWorktrees = null }) {
  /** A path inside a known worktree of a registered project: that project, rooted at the worktree. */
  function worktreeMatch(profileId, path, projects) {
    const hit = worktrees.lookup(profileId, path);
    if (!hit) return null;
    for (const project of projects) {
      const root = remoteRootOf(project, profileId);
      if (root !== null && hit.group.has(root)) return { project, root: hit.root };
    }
    return null;
  }

  async function requireProfile(profileId) {
    const profile = await getProfile(profileId);
    if (!profile) throw targetError('REMOTE_PROFILE_UNKNOWN', 'No SSH host profile with this id is configured on this machine');
    return profile;
  }

  /**
   * @param {string} pathOrUri
   * @returns {Promise<{ kind: 'local', path: string } | { kind: 'remote', profileId: string, profile: object, remotePath: string, uri: string, project: object, projectRoot: string, host: string }>}
   */
  async function resolveTarget(pathOrUri) {
    if (!remotePath.isRemotePath(pathOrUri)) return { kind: 'local', path: pathOrUri };
    const { profileId, path } = remotePath.parse(pathOrUri);
    const profile = await requireProfile(profileId);
    const projects = await loadProjects();
    let best = null;
    for (const project of projects) {
      const root = remoteRootOf(project, profileId);
      if (root === null || !remotePath.isInside(path, root)) continue;
      if (!best || root.length > best.root.length) best = { project, root };
    }
    if (!best && worktrees) {
      best = worktreeMatch(profileId, path, projects);
      if (!best && discoverWorktrees) {
        const uris = projects.filter((p) => remoteRootOf(p, profileId) !== null).map((p) => p.path);
        if (uris.length) {
          try { await discoverWorktrees(profileId, uris); } catch { /* nothing learned */ }
          best = worktreeMatch(profileId, path, projects);
        }
      }
    }
    if (!best) throw targetError('REMOTE_PATH_NOT_IN_PROJECT', 'Remote path is not inside a registered remote project');
    return {
      kind: 'remote',
      profileId,
      profile,
      remotePath: path,
      uri: remotePath.format(profileId, path),
      project: best.project,
      projectRoot: best.root,
      host: displayDestination(profile),
    };
  }

  /**
   * The Open Remote Project browser: a profile and an absolute path (or none,
   * for the remote home). No project is required, and callers may only list
   * directories, create one, init or clone with it.
   */
  async function resolveBrowseTarget(profileId, posixPath) {
    if (!remotePath.isValidProfileId(profileId)) throw targetError('REMOTE_PROFILE_UNKNOWN', 'Invalid host profile id');
    const profile = await requireProfile(profileId);
    let normalized = null;
    if (posixPath !== undefined && posixPath !== null && posixPath !== '') {
      if (typeof posixPath !== 'string' || !posixPath.startsWith('/')) throw targetError('REMOTE_PATH_INVALID', 'Remote path must be absolute');
      normalized = remotePath.toPosix(posixPath);
    }
    return { kind: 'remote', browse: true, profileId, profile, remotePath: normalized, host: displayDestination(profile) };
  }

  /** Resolve a project by id: local projects keep their path, remote ones go through resolveTarget. */
  async function resolveProjectTarget(projectId) {
    const projects = await loadProjects();
    const project = projects.find((p) => p && p.id === projectId);
    if (!project) throw targetError('PROJECT_UNKNOWN', 'Unknown project');
    if (!remotePath.isRemotePath(project.path)) return { kind: 'local', path: project.path, project };
    return resolveTarget(project.path);
  }

  return { resolveTarget, resolveBrowseTarget, resolveProjectTarget };
}

let _default = null;
const _worktrees = createWorktreeRegistry();

/** The resolver wired to the real profile store and projects.json. */
function defaultResolver() {
  if (!_default) {
    const { projectsFile } = require('./paths');
    _default = createTargetResolver({
      getProfile: (id) => require('../services/SshHostService').getProfile(id),
      loadProjects: () => readProjectsFile(projectsFile),
      worktrees: _worktrees,
      discoverWorktrees: (profileId, uris) => require('./git').discoverRemoteWorktrees(profileId, uris),
    });
  }
  return _default;
}

module.exports = {
  createTargetResolver,
  createWorktreeRegistry,
  noteWorktreeRoots: (profileId, roots) => _worktrees.note(profileId, roots),
  readProjectsFile,
  resolveTarget: (p) => defaultResolver().resolveTarget(p),
  resolveBrowseTarget: (id, p) => defaultResolver().resolveBrowseTarget(id, p),
  resolveProjectTarget: (id) => defaultResolver().resolveProjectTarget(id),
};
