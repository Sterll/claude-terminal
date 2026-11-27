/**
 * Terminal IPC Handlers
 * Handles terminal-related IPC communication
 */

const { ipcMain } = require('electron');
const AccountManager = require('../services/AccountManager');
const terminalService = require('../services/TerminalService');
const { sendFeaturePing } = require('../services/TelemetryService');
const { isRemotePath } = require('../../shared/remote-path');
const terminalShells = require('../utils/terminalShells');

/**
 * The terminal settings, read here rather than taken from the renderer, so no
 * IPC argument ever names the program a PTY or an external terminal runs.
 * An unreadable file only means the defaults: nothing is written from it.
 */
function readTerminalSettings() {
  try {
    const { settingsFile } = require('../utils/paths');
    const fs = require('fs');
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

/**
 * Resolve what a remote (SSH) project's terminal needs, in main, from paths
 * the renderer sent. The renderer never names a host: `resolveTarget` checks
 * that the URI's profile is configured here and that the URI lies inside a
 * project registered in projects.json, and the launch context comes from the
 * profile store (design/remote-ssh.md section 4.1).
 *
 * A remote project with a local cwd is refused: the PTY would be a local
 * shell posing as the remote project.
 *
 * @param {{ cwd?: string, projectPath?: string, sessionKey?: string }} params
 * @returns {Promise<object>} the `remote` context for TerminalService
 */
async function resolveRemoteTerminal({ cwd, projectPath, sessionKey }) {
  if (cwd && !isRemotePath(cwd)) throw new Error('A remote project terminal cannot run in a local directory');
  const uri = isRemotePath(cwd) ? cwd : projectPath;
  const target = await require('../utils/projectTarget').resolveTarget(uri);
  if (target.kind !== 'remote') throw new Error('Not a remote path');
  const launch = await require('../services/SshHostService').ptyLaunch(target.profileId);
  return {
    ...launch,
    remotePath: target.remotePath,
    uri: target.uri,
    ...(typeof sessionKey === 'string' ? { sessionKey } : {}),
  };
}

/**
 * End the tmux session of a remote tab the user closed. Fire and forget: the
 * tab is gone either way, and a host that is not connected keeps the session
 * (it is reattached by nothing, and tmux's own tooling can list it).
 */
function endRemoteTmuxSession(remote) {
  if (!remote || !remote.tmuxSession || !remote.profileId) return;
  try {
    require('../services/SshHostService')
      .killTmuxSession(remote.profileId, remote.tmuxSession)
      .catch(() => { /* host unreachable: nothing more to do */ });
  } catch (_) { /* invalid name: nothing was started under it */ }
}

/**
 * Register terminal IPC handlers
 */
function registerTerminalHandlers() {
  // Create terminal
  ipcMain.handle('terminal-create', async (event, { cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, accountId, sessionKey, claudeCommand }) => {
    try {
      // A remote (ssh-remote://) project runs over ssh. Decided on the paths
      // alone, so a local terminal never reads projects.json or the host store.
      if (isRemotePath(cwd) || isRemotePath(projectPath)) {
        sendFeaturePing('terminal:create');
        const remote = await resolveRemoteTerminal({ cwd, projectPath, sessionKey });
        // No account overlay: the remote host has its own `claude /login`,
        // which is also where a handed-over /login or /design-login lands.
        return terminalService.create({ cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, remote, claudeCommand });
      }
      sendFeaturePing('terminal:create');
      // Resolved here rather than inside create(), which stays synchronous:
      // reading an account's store can hit the Keychain.
      const accountEnv = await AccountManager.accountEnv(accountId || null);
      // The shell picked in Settings, for plain shell tabs. Claude tabs keep
      // the default: on POSIX they type the claude command line into it. Only
      // passed when one is picked, so the default call is the one it always was.
      const shell = runClaude ? null : terminalShells.resolveShell(readTerminalSettings());
      return terminalService.create({ cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, accountEnv, claudeCommand, ...(shell ? { shell } : {}) });
    } catch (error) {
      console.error('[Terminal IPC] Create error:', error);
      return { success: false, error: error.message };
    }
  });

  // Bring a remote terminal back after its connection dropped. The launch
  // context is resolved again, from the path the tab was opened with, so an
  // edited profile or a project removed meanwhile is honoured.
  ipcMain.handle('terminal-respawn', async (event, { id, resumeSessionId } = {}) => {
    try {
      const previous = terminalService.remoteContext(id);
      if (!previous || terminalService.has(id)) {
        return { success: false, error: 'This terminal is not waiting to reconnect' };
      }
      const remote = await resolveRemoteTerminal({ cwd: previous.uri || previous.cwd, projectPath: previous.projectPath });
      return terminalService.respawn(id, { remote, resumeSessionId: resumeSessionId || null });
    } catch (error) {
      console.error('[Terminal IPC] Respawn error:', error);
      return { success: false, error: error.message };
    }
  });

  // What Settings can offer: the shells and terminal applications installed
  // here, and Windows Terminal's profiles. Labels and ids only, no launch.
  ipcMain.handle('terminal-shell-options', async () => {
    try {
      return {
        platform: process.platform,
        shells: terminalShells.detectShells().map(({ id, label, file }) => ({ id, label, file })),
        defaultShell: terminalShells.defaultShellLabel(),
        externalTerminals: terminalShells.detectExternalTerminals(),
        defaultExternalTerminal: terminalShells.defaultExternalTerminalId(),
        terminalProfiles: terminalShells.listWindowsTerminalProfiles(),
      };
    } catch (error) {
      console.error('[Terminal IPC] Shell options error:', error);
      return { platform: process.platform, shells: [], externalTerminals: [], terminalProfiles: [], error: error.message };
    }
  });

  // Open the terminal application chosen in Settings on a local folder. The
  // renderer names the folder, never the program.
  ipcMain.handle('terminal-open-external', async (event, { path: dir } = {}) => {
    try {
      if (isRemotePath(dir)) {
        const { refusal } = require('../../shared/remote-capabilities');
        const r = refusal('openExternalTerminal');
        return { success: false, error: r.message, code: r.code, reasonKey: r.reasonKey };
      }
      sendFeaturePing('terminal:external');
      return await terminalShells.openExternalTerminal(dir, readTerminalSettings());
    } catch (error) {
      console.error('[Terminal IPC] Open external error:', error);
      return { success: false, error: error.message };
    }
  });

  // Terminal input
  ipcMain.on('terminal-input', (event, { id, data }) => {
    terminalService.write(id, data);
  });

  // Terminal resize
  ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
    terminalService.resize(id, cols, rows);
  });

  // Kill terminal
  ipcMain.on('terminal-kill', (event, { id }) => {
    // Read before the kill drops it. Null for every local terminal.
    const remote = typeof terminalService.remoteContext === 'function' ? terminalService.remoteContext(id) : null;
    terminalService.kill(id);
    // Closing the tab is the user ending that shell; quitting the app is not,
    // which is why killAll() leaves tmux sessions alone.
    if (remote) endRemoteTmuxSession(remote);
  });
}

module.exports = { registerTerminalHandlers, resolveRemoteTerminal, readTerminalSettings };
