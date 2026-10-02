/**
 * What a remote (SSH) project can do.
 *
 * One policy table, read by the renderer to grey a control and explain why,
 * by main-side IPC guards to refuse with the same reason, and by workflow
 * nodes and MCP tools. design/remote-ssh.md section 8 lists the features that
 * cannot work remotely in this iteration; each one becomes a row here in the
 * slice that wires it, so a feature is never disabled silently in one place
 * and enabled in another.
 *
 * A local project is never affected: `can()` answers `{ ok: true }` for it
 * without looking at the table, which keeps every local code path unchanged.
 *
 * A row is `{ remote: false, reasonKey }`, where `reasonKey` is an i18n key
 * the renderer resolves for the tooltip. A feature with no row is allowed:
 * remote support grows feature by feature, and the URI form of a remote
 * project path already makes every unported code path fail closed (see
 * design/remote-ssh.md section 3.2).
 */

'use strict';

const { isRemotePath } = require('./remote-path');

/** @type {Record<string, { remote: boolean, reasonKey: string }>} */
const CAPABILITIES = Object.freeze({
  // Local OS integrations: there is no local folder to show or to hand to an
  // editor. VS Code over Remote-SSH comes with the Files slice.
  openInExplorer: Object.freeze({ remote: false, reasonKey: 'ssh.disabled.openInExplorer' }),
  openInEditor: Object.freeze({ remote: false, reasonKey: 'ssh.disabled.openInEditor' }),
  // The remote host has its own `claude /login`; a local account overlay means
  // nothing there.
  accountBinding: Object.freeze({ remote: false, reasonKey: 'ssh.disabled.accountBinding' }),
  // Cloud upload zips a local folder.
  cloudUpload: Object.freeze({ remote: false, reasonKey: 'ssh.disabled.cloudUpload' }),
  // Not ported yet. Without these rows a remote project would open a local
  // shell in the home directory (TerminalService falls back to it when the cwd
  // does not exist), which is acting on local data rather than failing closed.
  // The terminal and chat slices remove them.
  terminals: Object.freeze({ remote: false, reasonKey: 'ssh.disabled.notYet' }),
  chat: Object.freeze({ remote: false, reasonKey: 'ssh.disabled.notYet' }),
});

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
  const row = table[feature];
  if (!row || row.remote !== false) return { ok: true };
  return { ok: false, reasonKey: row.reasonKey };
}

module.exports = { CAPABILITIES, isRemoteProject, can };
