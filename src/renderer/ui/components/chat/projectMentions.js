/**
 * The `@git` and `@todos` mentions: what a chip turns into when the message
 * leaves.
 *
 * Both read the project, not the conversation: `@git` the uncommitted diff,
 * `@todos` the TODO/FIXME scan. A local project reads them exactly as it
 * always did. A remote (SSH) project is read on its host: the project's
 * `ssh-remote://` URI goes to the same `git-status-detailed`, `git-file-diff`
 * and `scan-todos` handlers, which route a URI to the remote git primitives
 * and the remote TODO grep (design/remote-ssh.md 5.4).
 *
 * While the host is not connected a remote mention fails closed: the text
 * Claude gets says the data lives on the host, rather than "no changes" or
 * "no TODOs", which would be a confident wrong answer. The host is not asked
 * then either, since a read would connect it or wait on it. A host that drops
 * during the read is caught the same way, because a remote read that could
 * not reach the host answers like an empty one.
 *
 * The texts are what Claude reads, in English like the rest of the context
 * the chat sends.
 */

const { isRemoteProject } = require('../../../../shared/remote-capabilities');
const remotePath = require('../../../../shared/remote-path');

/** How many changed files `@git` sends a diff for. */
const GIT_FILE_LIMIT = 20;

/** How many TODOs `@todos` lists. */
const TODO_LIMIT = 50;

/**
 * The path the IPC handlers take for `project`: its own for a local project,
 * its `ssh-remote://` URI for a remote one (rebuilt from its `remote` block
 * when the record carries a bare path).
 */
function projectPathOf(project) {
  if (!project) return '';
  if (!isRemoteProject(project) || remotePath.isRemotePath(project.path)) return project.path;
  try {
    return remotePath.format(project.remote.profileId, project.remote.path);
  } catch (_) {
    return project.path;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.api                      window.electron_api (git.statusDetailed, git.fileDiff, project.scanTodos)
 * @param {(project: object) => object|null} deps.getProjectHost  remoteHosts.state's, null for a local project
 */
function createProjectMentions({ api, getProjectHost }) {
  /** What to call a remote project's host in the text Claude reads. */
  function hostLabelOf(project) {
    const host = getProjectHost(project);
    return (host && host.hostLabel) || (project.remote && project.remote.hostLabel) || 'its host';
  }

  /** The host a remote project's data lives on, or null when it can be read now (or the project is local). */
  function unreachableHost(project) {
    if (!isRemoteProject(project)) return null;
    const host = getProjectHost(project);
    if (host && host.state === 'connected') return null;
    return hostLabelOf(project);
  }

  function offline(what, host) {
    return `[${what} of this project live on ${host}, which is not connected. Connect to the host to include them.]`;
  }

  /** `@git`: the diff of every changed file, up to GIT_FILE_LIMIT. */
  async function resolveGit(project) {
    const away = unreachableHost(project);
    if (away) return offline('The git changes', away);
    const projectPath = projectPathOf(project);
    try {
      const status = await api.git.statusDetailed({ projectPath });
      const lost = unreachableHost(project) || (status && status.reason === 'disconnected' ? hostLabelOf(project) : null);
      if (lost) return offline('The git changes', lost);
      if (!status?.success || !status.files?.length) return '[No git changes detected]';
      const diffs = [];
      for (const file of status.files.slice(0, GIT_FILE_LIMIT)) {
        try {
          // fileDiff resolves the diff as a plain string, or
          // { error: true, message } when git could not run. Reading
          // `d.diff` meant this context never carried any diff at all.
          const d = await api.git.fileDiff({ projectPath, filePath: file.path });
          if (typeof d === 'string' && d.trim()) diffs.push(`--- ${file.path} ---\n${d}`);
        } catch (e) { /* skip */ }
      }
      return diffs.length > 0 ? `Git Changes (${status.files.length} files):\n\n${diffs.join('\n\n')}` : '[No diff content available]';
    } catch (e) {
      return '[Error fetching git diff]';
    }
  }

  /** `@todos`: the TODO/FIXME/HACK/XXX scan, up to TODO_LIMIT entries. */
  async function resolveTodos(project) {
    const away = unreachableHost(project);
    if (away) return offline('The TODOs', away);
    try {
      const todos = await api.project.scanTodos(projectPathOf(project));
      // A remote scan that lost its host answers [] like a clean tree.
      const lost = unreachableHost(project);
      if (lost) return offline('The TODOs', lost);
      if (todos?.length > 0) {
        return `TODO Items (${todos.length} found):\n\n${todos.slice(0, TODO_LIMIT).map(t => `${t.type} [${t.file}:${t.line}]: ${t.text}`).join('\n')}`;
      }
      return '[No TODOs found in project]';
    } catch (e) {
      return '[Error scanning TODOs]';
    }
  }

  /**
   * Whether the project may be read for a hint (the composer's rotating
   * placeholder, the follow-up chips) without connecting a host: always for a
   * local project, only while the host is connected for a remote one.
   */
  function mayRead(project) {
    return !unreachableHost(project);
  }

  return { resolveGit, resolveTodos, mayRead };
}

module.exports = { createProjectMentions, projectPathOf, GIT_FILE_LIMIT, TODO_LIMIT };
