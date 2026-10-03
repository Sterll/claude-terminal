/**
 * What a remote (SSH) project can do.
 *
 * One policy table, read by the renderer to grey a control and explain why,
 * by main-side IPC guards to refuse with the same reason, and by workflow
 * nodes and the scheduler. design/remote-ssh.md section 8 lists the features
 * that cannot work remotely in this iteration, and every row of that table
 * names the capability keys it maps to here; tests/shared/remoteCapabilities
 * reads the document and fails when the two drift apart, so a feature is
 * never disabled silently in one place and enabled in another.
 *
 * A local project is never affected: `can()` answers `{ ok: true }` for it
 * without looking at the table, which keeps every local code path unchanged.
 *
 * A row is `{ remote: false, reasonKey, message }`. `reasonKey` is the i18n
 * key the renderer resolves for the tooltip or toast; `message` is the same
 * reason in English for the main process, whose errors stay in English (see
 * `refusalError()`). A feature with no row is allowed: remote support grows
 * feature by feature, and the URI form of a remote project path already makes
 * every unported code path fail closed (see design/remote-ssh.md section 3.2).
 */

'use strict';

const { isRemotePath } = require('./remote-path');

/** Error code carried by every main-side refusal built from this table. */
const REMOTE_UNSUPPORTED = 'REMOTE_UNSUPPORTED';

function row(reasonKey, message) {
  return Object.freeze({ remote: false, reasonKey, message });
}

/** @type {Record<string, { remote: boolean, reasonKey: string, message: string }>} */
const CAPABILITIES = Object.freeze({
  // Project-type dashboards, run panels, sidebar buttons and type menu items
  // (FiveM, webapp, api, python, minecraft, discord): their services spawn
  // local processes and read local files. Remote projects are created as
  // `general`, and registry.forProject() answers the general type for any
  // remote project, whatever type its record says.
  typeDashboards: row('ssh.disabled.typeDashboards',
    'Project-type dashboards and run panels are not available for remote projects'),
  // Parallel tasks create local worktrees and run local agents in them.
  parallelTasks: row('ssh.disabled.parallelTasks',
    'Parallel tasks are not supported for remote projects yet'),
  // Workflow nodes that execute or read on the local machine (shell, git,
  // file, claude, terminal, session_recap, parallel_spawn). quickaction is not
  // one: it hands its command to a terminal tab, which runs on the host.
  workflowNodes: row('ssh.disabled.workflowNodes',
    'Remote projects are not supported by workflow nodes yet'),
  // file_change and git_event triggers watch a local directory with chokidar.
  workflowTriggers: row('ssh.disabled.workflowTriggers',
    'Remote projects are not supported by file_change and git_event triggers yet'),
  // This app's MCP server and the Claude in Chrome server are local programs
  // the CLI on the host cannot start.
  localMcpTools: row('ssh.chat.localToolsTooltip',
    "This app's MCP tools and Claude in Chrome are not available in a remote chat"),
  // The remote CLI never runs the local hook handler, so hook events (and the
  // hook workflow trigger) never see a remote project; its terminal tabs use
  // the scraping provider instead.
  hooks: row('ssh.disabled.hooks',
    'Claude hooks do not reach this app from a remote host'),
  // Local OS integrations: there is no local folder to show. An editor is
  // refused too, except the VS Code family, which opens the host itself over
  // its Remote-SSH extension: callers that know the editor ask
  // canOpenInEditor(), which lets those through (REMOTE_EDITORS).
  openInExplorer: row('ssh.disabled.openInExplorer',
    'A remote project has no local folder to show'),
  openInEditor: row('ssh.disabled.openInEditor',
    'Only VS Code, Cursor and Windsurf can open a remote project, through their Remote-SSH extension'),
  // Moving or copying between a local tree and a remote one would be a file
  // transfer feature, which this iteration does not have.
  crossRootTransfer: row('ssh.disabled.crossRootTransfer',
    'Moving or copying files between a local project and a remote one is not supported'),
  // The remote host has its own `claude /login`; a local account overlay means
  // nothing there.
  accountBinding: row('ssh.disabled.accountBinding',
    'A remote project uses the Claude login of its host and cannot be bound to a local account'),
  // Cloud upload zips a local folder. Its git variant is refused too (see
  // design/remote-ssh.md section 8 for why).
  cloudUpload: row('ssh.disabled.cloudUpload',
    'Cloud upload zips a local folder, so remote projects cannot be uploaded'),
  // A session is re-filed by moving its transcript between two local
  // directories; a remote transcript lives on its host. (Terminals and chat
  // run over ssh and have no row.)
  sessionMove: row('ssh.disabled.sessionMove',
    'Sessions of remote projects cannot be moved: their transcripts live on the remote host'),
  // A local path handed to the remote CLI names nothing on the host. Files
  // within the inline limits travel as content instead.
  pathAttachment: row('ssh.disabled.pathAttachment',
    'A local file path cannot be attached to a remote chat'),
  // @errors (this app's own error log) and @selection (the local editor
  // selection) are local sources.
  localMentions: row('ssh.disabled.localMentions',
    'The @errors and @selection mentions are local sources and are not offered in a remote chat'),
  // In the Files Overview a remote root stays collapsed until its host is
  // connected, so a dead host never stalls a tree that mixes local and remote.
  overviewAutoExpand: row('ssh.disabled.overviewAutoExpand',
    'A remote root stays collapsed until its host is connected'),
  // The MCP panel lists project-scoped servers from
  // <project>/.claude/settings.local.json, a local file.
  projectMcpConfig: row('ssh.disabled.projectMcpConfig',
    'Project-scoped MCP servers of a remote project live on its host and are not listed'),
  // Database auto-detection reads .env files and SQLite databases in the
  // project folder; a remote SQLite file is not reachable by the local driver.
  databaseDetect: row('ssh.disabled.databaseDetect',
    'Database detection reads local project files and is not available for remote projects'),
  // The claude-terminal MCP server reads local disk: project_info,
  // project_todos and project_stats answer that the project lives on its
  // host, and project_create refuses a remote path.
  mcpProjectTools: row('ssh.disabled.mcpProjectTools',
    'The claude-terminal MCP server reads local disk and cannot read a remote project'),
});

/**
 * Editors that open a remote file themselves: `<editor> --remote
 * ssh-remote+<alias> <path>` through the Remote-SSH extension, which reads
 * the same ~/.ssh/config the app does.
 */
const REMOTE_EDITORS = Object.freeze(['code', 'cursor', 'windsurf']);

/** The command name of an editor setting: `C:\Tools\Code.cmd` and `code` both give `code`. */
function editorFamily(editor) {
  const base = String(editor || '').trim().split(/[\\/]/).pop() || '';
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** True when `project` is a remote project (has a `remote` block or a remote URI path). */
function isRemoteProject(project) {
  if (!project || typeof project !== 'object') return false;
  return Boolean(project.remote && project.remote.profileId) || isRemotePath(project.path);
}

/**
 * @param {object} project
 * @param {string} feature  a key of CAPABILITIES
 * @param {Record<string, { remote: boolean, reasonKey: string }>} [table]  injectable for tests
 * @returns {{ ok: true } | { ok: false, reasonKey: string }}
 */
function can(project, feature, table = CAPABILITIES) {
  if (!isRemoteProject(project)) return { ok: true };
  const entry = table[feature];
  if (!entry || entry.remote !== false) return { ok: true };
  return { ok: false, reasonKey: entry.reasonKey };
}

/**
 * Whether `editor` can open files of `project`. Always for a local project;
 * for a remote one only the VS Code family, over Remote-SSH.
 * @param {object} project
 * @param {string} editor  the editor setting or command
 * @returns {{ ok: true } | { ok: false, reasonKey: string }}
 */
function canOpenInEditor(project, editor) {
  if (!isRemoteProject(project)) return { ok: true };
  if (REMOTE_EDITORS.includes(editorFamily(editor))) return { ok: true };
  return { ok: false, reasonKey: CAPABILITIES.openInEditor.reasonKey };
}

/**
 * The English refusal for a feature, for main-process errors and results.
 * @param {string} feature  a key of CAPABILITIES
 * @returns {{ code: string, feature: string, reasonKey: string, message: string }}
 */
function refusal(feature, table = CAPABILITIES) {
  const entry = table[feature];
  if (!entry) throw new Error(`Unknown remote capability: ${feature}`);
  return { code: REMOTE_UNSUPPORTED, feature, reasonKey: entry.reasonKey, message: entry.message };
}

/**
 * An Error for a feature a remote project cannot use. Carries `code`
 * (REMOTE_UNSUPPORTED), `feature` and `reasonKey`, so a renderer that gets it
 * back can show the translated reason rather than the English message.
 * @param {string} feature  a key of CAPABILITIES
 * @returns {Error}
 */
function refusalError(feature, table = CAPABILITIES) {
  const r = refusal(feature, table);
  const err = new Error(r.message);
  err.code = r.code;
  err.feature = r.feature;
  err.reasonKey = r.reasonKey;
  return err;
}

/**
 * Throw `refusalError(feature)` when any of `paths` is an ssh-remote:// URI:
 * the main-side form of `can()`, for code that holds a path, not a project.
 * Anything that is not a string is ignored.
 * @param {string} feature  a key of CAPABILITIES
 * @param {...*} paths
 */
function assertLocalPaths(feature, ...paths) {
  for (const p of paths) {
    if (typeof p === 'string' && isRemotePath(p)) throw refusalError(feature);
  }
}

/**
 * Whether two project objects are the same project, for deciding which tabs
 * belong to which project.
 *
 * As soon as a remote project is involved the answer is by id: a local
 * `/home/u/app` and a remote project at `/home/u/app` on some host are
 * different projects whatever their paths look like. Two local projects are
 * compared by path, exactly as every tab ownership check did before remote
 * projects existed, so local behaviour does not move.
 *
 * @param {object|null} a
 * @param {object|null} b
 * @returns {boolean}
 */
function sameProject(a, b) {
  if (!a || !b) return false;
  if (isRemoteProject(a) || isRemoteProject(b)) return Boolean(a.id) && a.id === b.id;
  return a.path === b.path;
}

module.exports = {
  CAPABILITIES,
  REMOTE_EDITORS,
  REMOTE_UNSUPPORTED,
  editorFamily,
  isRemoteProject,
  can,
  canOpenInEditor,
  refusal,
  refusalError,
  assertLocalPaths,
  sameProject,
};
