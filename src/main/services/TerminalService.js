/**
 * Terminal Service
 * Manages PTY terminal processes
 */

const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { execFileSync } = require('child_process');
const terminalCapture = require('./TerminalOutputCapture');
const sshCommand = require('../utils/sshCommand');
const {
  shC,
  terminalShellScript,
  terminalClaudeScript,
  classifyPtyExit,
  sshExitStatus,
  SSH_FAILURE_STATUS,
} = require('../../shared/remote-shell');

/** What `--resume` accepts. Also what keeps a session id from smuggling shell syntax. */
const RESUME_ID_RE = /^[a-f0-9-]{8,64}$/;

/** ssh's own failure status (connection or authentication), which a remote command can also exit with. */
const SSH_FAILURE_EXIT = SSH_FAILURE_STATUS;

/**
 * How long a remote tab whose ssh exited 255 without saying why waits for its
 * host to answer, before the exit is read as a lost connection.
 */
const HOST_PROBE_TIMEOUT_MS = 5000;

/** How much of a remote PTY's latest output is kept to classify an ssh failure. */
const REMOTE_TAIL_BYTES = 4096;

/** tmux session keys a tab may ask for. Anything else gets a generated one. */
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,96}$/;

/**
 * Whether a spawned `claude` should carry `--rc`.
 *
 * Read through the service rather than from settings.json directly, so the
 * managed-settings kill switch and the opt-in rules live in exactly one place.
 * Never throws: a terminal must still open when the setting cannot be read.
 */
function _remoteControlEnabled() {
  try {
    return require('./RemoteControlService').launchesTerminalsConnected();
  } catch (_) {
    return false;
  }
}


class TerminalService {
  constructor() {
    this.terminals = new Map();
    /**
     * Remote terminals whose ssh lost the connection (exit 255), by id, with
     * what they need to come back under the same id. Local terminals never
     * land here.
     */
    this.disconnected = new Map();
    /** Remote terminals whose exit 255 is being checked against their host. */
    this._judging = new Set();
    /**
     * Injectable host liveness check (`probe(profileId)`), for tests. Null
     * means SshHostService.
     */
    this.hostLiveness = null;
    this.terminalId = 0;
    this.mainWindow = null;
    /**
     * Optional callback fired when a PTY exits.
     * Signature: ({ terminalId, exitCode, signal, projectId?, projectPath? }) => void
     * Wired by main.js so workflow triggers can subscribe without creating a
     * circular dep between TerminalService and WorkflowService.
     */
    this.onExitCallback = null;
  }

  /**
   * Set the main window reference for IPC communication
   * @param {BrowserWindow} window
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Send data to renderer safely (checks if window is destroyed)
   * @param {string} channel - IPC channel
   * @param {Object} data - Data to send
   */
  sendToRenderer(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Create a new terminal
   * @param {Object} options
   * @param {string} options.cwd - Working directory
   * @param {boolean} options.runClaude - Whether to run Claude CLI on start
   * @param {boolean} options.skipPermissions - Skip permissions flag for Claude
   * @param {string} options.resumeSessionId - Session ID to resume
   * @param {{file: string, args: string[]}|null} [options.command] - Run this
   *   program instead of the shell. Main-process callers only: the
   *   `terminal-create` IPC handler never forwards it, so the renderer cannot
   *   choose what a PTY runs. Used by the SSH "Verify host" action.
   * @param {Object|null} [options.remote] - A remote (SSH) project's launch
   *   context, resolved in main by the terminal IPC from a registered project
   *   (see `_createRemote`). Never taken from the renderer as-is.
   * @returns {Object} - { success: boolean, id?: number, error?: string }
   */
  create({ cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, accountEnv = null, command = null, remote = null }) {
    const id = ++this.terminalId;
    // A remote project takes its own branch before anything below looks at the
    // local filesystem: its cwd is a URI that never exists here.
    if (remote) return this._createRemote(id, { cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, remote });
    let shellPath = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
    let shellArgs = process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [];

    // Validate and resolve working directory
    let effectiveCwd = os.homedir();
    if (cwd) {
      try {
        if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
          effectiveCwd = cwd;
        } else {
          console.warn(`Terminal cwd does not exist: ${cwd}, using home directory`);
        }
      } catch (e) {
        console.warn(`Error checking cwd: ${e.message}, using home directory`);
      }
    }

    // If running Claude, spawn it directly via cmd.exe /c (no shell banner, no prompt)
    if (runClaude && process.platform === 'win32') {
      const claudeArgs = ['claude'];
      if (resumeSessionId && /^[a-f0-9\-]{8,64}$/.test(resumeSessionId)) {
        claudeArgs.push('--resume', resumeSessionId);
      }
      if (skipPermissions) {
        claudeArgs.push('--dangerously-skip-permissions');
      }
      // Connect this CLI to Remote Control, so the terminal tab shows up on
      // claude.ai alongside the mirrored chat tabs.
      if (_remoteControlEnabled()) {
        claudeArgs.push('--rc');
      }
      shellPath = 'cmd.exe';
      shellArgs = ['/c', ...claudeArgs];
    }

    if (command && typeof command.file === 'string' && Array.isArray(command.args)) {
      shellPath = command.file;
      shellArgs = command.args.map(String);
    }

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: effectiveCwd,
        // A project pinned to an account gets that account's credential store;
        // everything else in ~/.claude stays shared.
        env: accountEnv ? { ...process.env, ...accountEnv } : process.env
      });

      if (!ptyProcess) {
        throw new Error('PTY process creation returned null');
      }
    } catch (error) {
      console.error('Failed to spawn terminal:', error);
      this.sendToRenderer('terminal-error', {
        id,
        error: `Failed to create terminal: ${error.message}`
      });
      return { success: false, error: error.message };
    }

    // node-pty rethrows any socket error that is not EAGAIN or EIO out of its
    // own handler unless the terminal carries an 'error' listener of its own -
    // it counts them and gives up on the rethrow at two, its own included. A
    // read error on the master fd of a shell that has just exited is routine,
    // and uncaught in main it takes the whole app down. Worse on macOS, where
    // it can land while node-pty's exit callback is still queued on an N-API
    // ThreadSafeFunction: that dispatch then fails with a C++ Napi::Error
    // nothing catches, and the app aborts through libc++abi with no JS stack
    // at all. One listener is the whole fix; it also gives us the error.
    ptyProcess.on('error', error => {
      console.warn(`[TerminalService] PTY ${id} socket error:`, error?.message || error);
    });

    // Tag the PTY with project metadata so onExit can reference it.
    // `command` records what was actually launched (shell or Claude CLI), used
    // by terminal_exit_code workflow triggers for commandPattern filtering.
    ptyProcess._meta = {
      projectId:   projectId || null,
      projectPath: projectPath || cwd || null,
      command:     [shellPath, ...(shellArgs || [])].join(' ').trim(),
    };
    // A main-chosen program (the SSH "Verify host" prompt) is app plumbing,
    // not a user terminal: it must not fire terminal_exit_code workflows.
    if (command) ptyProcess._meta.internal = true;

    this.terminals.set(id, ptyProcess);

    const dataDisposable = this._wireOutput(id, ptyProcess);

    // Handle exit
    const exitDisposable = ptyProcess.onExit((evt) => {
      if (ptyProcess._exited) return;
      ptyProcess._exited = true;
      const exitCode = (evt && Number.isFinite(evt.exitCode)) ? evt.exitCode : null;
      const signal   = (evt && evt.signal != null) ? evt.signal : null;
      try { ptyProcess.kill(); } catch (e) {}
      this.terminals.delete(id);
      // Persist whatever the process printed on its way out, before anything
      // can read the log looking for the failure.
      terminalCapture.flush();
      this.sendToRenderer('terminal-exit', { id, exitCode, signal });
      // Fire workflow trigger callback (non-blocking)
      if (typeof this.onExitCallback === 'function' && !ptyProcess._meta?.internal) {
        try {
          this.onExitCallback({
            terminalId:  id,
            exitCode,
            signal,
            projectId:   ptyProcess._meta?.projectId || null,
            projectPath: ptyProcess._meta?.projectPath || null,
            command:     ptyProcess._meta?.command || null,
          });
        } catch (cbErr) {
          console.warn('[TerminalService] onExitCallback error:', cbErr.message);
        }
      }
    });

    // Store disposables for cleanup on kill()
    ptyProcess._disposables = [dataDisposable, exitDisposable];

    // Run Claude CLI on non-Windows platforms
    if (runClaude && process.platform !== 'win32') {
      setTimeout(() => {
        let claudeCmd = 'claude';
        if (resumeSessionId) {
          // Validate session ID format to prevent shell injection via PTY
          if (/^[a-f0-9\-]{8,64}$/.test(resumeSessionId)) {
            claudeCmd += ` --resume ${resumeSessionId}`;
          }
        }
        if (skipPermissions) {
          claudeCmd += ' --dangerously-skip-permissions';
        }
        // See the Windows branch above.
        if (_remoteControlEnabled()) {
          claudeCmd += ' --rc';
        }
        try { ptyProcess.write(claudeCmd + '\r'); } catch (e) {}
      }, 500);
    }

    return { success: true, id };
  }

  /**
   * Forward a PTY's output to the renderer.
   * Adaptive batching to reduce IPC flooding: 4ms flush when idle (responsive
   * typing), 16ms normal, 32ms when flooding.
   * @returns {{dispose: Function}}
   */
  _wireOutput(id, ptyProcess) {
    let buffer = '';
    let flushScheduled = false;
    let lastFlush = Date.now();

    return ptyProcess.onData(data => {
      buffer += data;
      if (!flushScheduled) {
        flushScheduled = true;
        const sinceLastFlush = Date.now() - lastFlush;
        const delay = buffer.length > 10000 ? 32 : sinceLastFlush > 100 ? 4 : 16;
        setTimeout(() => {
          this.sendToRenderer('terminal-data', { id, data: buffer });
          // Persist a rolling tail per project. Buffered and written on its own
          // timer, so this adds no disk I/O to the render path.
          terminalCapture.record(ptyProcess._meta?.projectId, buffer);
          buffer = '';
          flushScheduled = false;
          lastFlush = Date.now();
        }, delay);
      }
    });
  }

  // ── Remote (SSH) terminals ─────────────────────────────────────────────────
  //
  // design/remote-ssh.md section 5.1. A remote tab is node-pty running the
  // system ssh with `-tt`, the profile's flags, `--`, the destination, and one
  // remote command element `/bin/sh -c <q(script)>`. The local process starts
  // in the local home directory: there is no local cwd to check, and no
  // account overlay, since the remote host has its own `claude /login`.
  //
  // ssh exits 255 when the connection or authentication failed. That is not
  // the user typing `exit`, so it is reported as `terminal-disconnected`, the
  // tab stays, and `respawn()` brings it back under the same id once the host
  // is reachable. ssh also passes on the remote command's own status, though,
  // and a remote `exit 255` is an exit: classifyPtyExit() reads ssh's last
  // words to tell them apart, and the host is asked when those settle nothing.
  // A tab that comes back is a Claude tab with `--resume`, or a shell in the
  // same directory (reattached to its tmux session when the profile opted in).

  /** The CLI argv for a remote Claude tab: the same flags and session id check as a local one. */
  _remoteClaudeArgv(ctx) {
    const argv = [ctx.profile && ctx.profile.remoteClaudePath ? ctx.profile.remoteClaudePath : 'claude'];
    if (ctx.resumeSessionId && RESUME_ID_RE.test(ctx.resumeSessionId)) argv.push('--resume', ctx.resumeSessionId);
    if (ctx.skipPermissions) argv.push('--dangerously-skip-permissions');
    if (_remoteControlEnabled()) argv.push('--rc');
    return argv;
  }

  /** The tmux session a shell tab attaches to, or null when tmux does not apply. */
  _remoteTmuxSession(ctx) {
    if (ctx.runClaude || !ctx.profile || ctx.profile.tmuxSessions !== true) return null;
    // Known to be missing: leave tmux out entirely. Unknown (the channel has
    // not connected yet): the script checks for it on the host.
    const tools = ctx.capabilities && Array.isArray(ctx.capabilities.tools) ? ctx.capabilities.tools : null;
    if (tools && !tools.includes('tmux')) return null;
    return `ct-${ctx.sessionKey}`;
  }

  /**
   * The ssh program and argv for a remote tab.
   * @returns {{ file: string, args: string[], tmuxSession: string|null }}
   */
  _remoteSpawnSpec(ctx) {
    const tmuxSession = this._remoteTmuxSession(ctx);
    const script = ctx.runClaude
      ? terminalClaudeScript(ctx.remotePath, this._remoteClaudeArgv(ctx))
      : terminalShellScript(ctx.remotePath, { tmuxSession, path: ctx.capabilities ? ctx.capabilities.path : null });
    const sshArgs = sshCommand.buildSshArgs(ctx.profile, {
      mode: 'pty',
      remoteCommand: [shC(script)],
      platform: ctx.platform || process.platform,
      controlDir: ctx.controlDir || null,
    });
    return { file: ctx.command, args: [...(ctx.prefixArgs || []), ...sshArgs], tmuxSession };
  }

  _createRemote(id, { cwd, runClaude, skipPermissions, resumeSessionId, projectId, projectPath, remote }) {
    const sessionKey = typeof remote.sessionKey === 'string' && SESSION_KEY_RE.test(remote.sessionKey)
      ? remote.sessionKey
      : `t${Date.now().toString(36)}${id}`;
    const ctx = {
      ...remote,
      sessionKey,
      runClaude: Boolean(runClaude),
      skipPermissions: Boolean(skipPermissions),
      resumeSessionId: resumeSessionId && RESUME_ID_RE.test(resumeSessionId) ? resumeSessionId : null,
      projectId: projectId || null,
      projectPath: projectPath || cwd || null,
      cwd: cwd || null,
      size: null,
    };
    return this._spawnRemote(id, ctx);
  }

  _spawnRemote(id, ctx) {
    let spec;
    try {
      if (!ctx.command || !ctx.profile || typeof ctx.remotePath !== 'string') throw new Error('Incomplete remote terminal context');
      spec = this._remoteSpawnSpec(ctx);
    } catch (error) {
      console.error('Failed to build the remote terminal command:', error.message);
      this.sendToRenderer('terminal-error', { id, error: `Failed to create terminal: ${error.message}` });
      return { success: false, error: error.message };
    }

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: (ctx.size && ctx.size.cols) || 120,
        rows: (ctx.size && ctx.size.rows) || 30,
        cwd: os.homedir(),
        env: ctx.env ? { ...process.env, ...ctx.env } : process.env
      });
      if (!ptyProcess) throw new Error('PTY process creation returned null');
    } catch (error) {
      console.error('Failed to spawn remote terminal:', error);
      this.sendToRenderer('terminal-error', { id, error: `Failed to create terminal: ${error.message}` });
      return { success: false, error: error.message };
    }

    // See create(): one listener keeps node-pty from rethrowing a socket error.
    ptyProcess.on('error', error => {
      console.warn(`[TerminalService] PTY ${id} socket error:`, error?.message || error);
    });

    ctx.tmuxSession = spec.tmuxSession;
    ptyProcess._meta = {
      projectId: ctx.projectId,
      projectPath: ctx.projectPath,
      command: [spec.file, ...spec.args].join(' ').trim(),
      remote: { profileId: ctx.profileId || null },
    };
    ptyProcess._remote = ctx;
    ptyProcess._tail = '';

    this.terminals.set(id, ptyProcess);

    const tailDisposable = ptyProcess.onData(data => {
      ptyProcess._tail = (ptyProcess._tail + data).slice(-REMOTE_TAIL_BYTES);
    });
    const dataDisposable = this._wireOutput(id, ptyProcess);

    const exitDisposable = ptyProcess.onExit((evt) => {
      if (ptyProcess._exited) return;
      ptyProcess._exited = true;
      // Windows reports ssh's exit(-1), a session the server ended without
      // an exit status, as -1: read it the way POSIX does, as 255.
      const exitCode = (evt && Number.isFinite(evt.exitCode)) ? sshExitStatus(evt.exitCode) : null;
      const signal   = (evt && evt.signal != null) ? evt.signal : null;
      try { ptyProcess.kill(); } catch (e) {}
      if (this.terminals.get(id) === ptyProcess) this.terminals.delete(id);
      terminalCapture.flush();
      if (exitCode !== SSH_FAILURE_EXIT) {
        this._remoteExited(id, ptyProcess, exitCode, signal);
        return;
      }
      // 255 is ssh's own failure, but also whatever status the remote
      // command chose (`exit 255`). What ssh printed decides first; when it
      // printed nothing that settles it, the host is asked.
      const judged = classifyPtyExit(exitCode, ptyProcess._tail);
      if (judged.verdict === 'exit') {
        this._remoteExited(id, ptyProcess, exitCode, signal);
        return;
      }
      if (judged.verdict === 'lost') {
        this._remoteLost(id, ctx, exitCode, judged.kind);
        return;
      }
      this._judgeByHost(id, ptyProcess, ctx, exitCode, signal);
    });

    ptyProcess._disposables = [tailDisposable, dataDisposable, exitDisposable];
    return { success: true, id };
  }

  /** The remote command ended: the tab closes like a local one, and the workflow trigger fires. */
  _remoteExited(id, ptyProcess, exitCode, signal) {
    this.sendToRenderer('terminal-exit', { id, exitCode, signal });
    if (typeof this.onExitCallback === 'function') {
      try {
        this.onExitCallback({
          terminalId:  id,
          exitCode,
          signal,
          projectId:   ptyProcess._meta?.projectId || null,
          projectPath: ptyProcess._meta?.projectPath || null,
          command:     ptyProcess._meta?.command || null,
        });
      } catch (cbErr) {
        console.warn('[TerminalService] onExitCallback error:', cbErr.message);
      }
    }
  }

  /**
   * The connection dropped, or never came up. Not an exit: the tab stays,
   * main keeps what respawn() needs, and no terminal_exit_code workflow fires.
   */
  _remoteLost(id, ctx, exitCode, kind) {
    this.disconnected.set(id, ctx);
    this.sendToRenderer('terminal-disconnected', { id, exitCode, kind: kind || 'network', profileId: ctx.profileId || null });
  }

  /** The host liveness check: SshHostService, unless a test handed one in. */
  _hostLiveness() {
    if (this.hostLiveness) return this.hostLiveness;
    try {
      return require('./SshHostService');
    } catch (_) {
      return null;
    }
  }

  /**
   * An exit 255 that ssh explained neither way (`LogLevel QUIET`, or its last
   * words never reached the PTY). A host whose channel still answers means the
   * link is fine and 255 was the remote command's own status; a host that is
   * not connected, or does not answer, means the link went. A host this app
   * has not reached yet tells nothing, and is read as a lost connection, the
   * safe side: the overlay offers Close as well as Reconnect.
   */
  _judgeByHost(id, ptyProcess, ctx, exitCode, signal) {
    const liveness = this._hostLiveness();
    if (!liveness || typeof liveness.probe !== 'function' || !ctx.profileId) {
      this._remoteLost(id, ctx, exitCode, 'network');
      return;
    }
    // Only a connected host can vouch for the link; anything else is decided
    // now, without a round trip.
    const status = typeof liveness.getStatus === 'function' ? liveness.getStatus(ctx.profileId) : null;
    if (!status || status.state !== 'connected') {
      this._remoteLost(id, ctx, exitCode, 'network');
      return;
    }
    this._judging.add(id);
    const settle = (verdict) => {
      // Closed while the host was being asked: nothing is left to report.
      if (!this._judging.delete(id)) return;
      if (verdict === 'alive') this._remoteExited(id, ptyProcess, exitCode, signal);
      else this._remoteLost(id, ctx, exitCode, 'network');
    };
    Promise.resolve()
      .then(() => liveness.probe(ctx.profileId, { timeoutMs: HOST_PROBE_TIMEOUT_MS }))
      .then(settle, () => settle('dead'));
  }

  /**
   * Bring a disconnected remote terminal back under the same id, so the
   * renderer's handlers, the tab and its scrollback carry on untouched.
   *
   * @param {number} id
   * @param {object} options
   * @param {object} options.remote  a fresh launch context from the IPC (the
   *   profile may have been edited since)
   * @param {string|null} [options.resumeSessionId]  the conversation a Claude
   *   tab resumes; defaults to the one it was started with
   * @returns {{ success: boolean, id?: number, error?: string }}
   */
  respawn(id, { remote = null, resumeSessionId = null } = {}) {
    const prev = this.disconnected.get(id);
    if (!prev) return { success: false, error: 'This terminal is not waiting to reconnect' };
    if (this.terminals.has(id)) return { success: false, error: 'This terminal is already running' };
    const ctx = {
      ...prev,
      ...(remote || {}),
      // What the tab is, as opposed to how to reach its host: always the original.
      sessionKey: prev.sessionKey,
      remotePath: prev.remotePath,
      runClaude: prev.runClaude,
      skipPermissions: prev.skipPermissions,
      projectId: prev.projectId,
      projectPath: prev.projectPath,
      cwd: prev.cwd,
      size: prev.size,
      resumeSessionId: resumeSessionId && RESUME_ID_RE.test(resumeSessionId) ? resumeSessionId : prev.resumeSessionId,
    };
    this.disconnected.delete(id);
    const result = this._spawnRemote(id, ctx);
    if (!result.success) this.disconnected.set(id, prev);
    return result;
  }

  /**
   * The remote context of a live or disconnected terminal, or null for a
   * local one. Read by the IPC to re-resolve a respawn and to end a closed
   * tab's tmux session.
   */
  remoteContext(id) {
    const term = this.terminals.get(id);
    if (term && term._remote) return term._remote;
    return this.disconnected.get(id) || null;
  }

  /**
   * Write data to a terminal
   * @param {number} id - Terminal ID
   * @param {string} data - Data to write
   */
  write(id, data) {
    const term = this.terminals.get(id);
    if (term) {
      try {
        term.write(data);
      } catch (e) {
        // PTY may have been killed — ignore write errors
      }
    }
  }

  /**
   * Resize a terminal
   * @param {number} id - Terminal ID
   * @param {number} cols - Number of columns
   * @param {number} rows - Number of rows
   */
  resize(id, cols, rows) {
    const term = this.terminals.get(id);
    if (term) {
      // A remote tab respawns at the size it last had.
      if (term._remote) term._remote.size = { cols, rows };
      try {
        term.resize(cols, rows);
      } catch (e) {
        // PTY may have been killed — ignore resize errors
      }
    }
  }

  /**
   * Force-kill a process tree on Windows via taskkill
   * @param {number} pid - Process ID
   */
  _forceKillWindows(pid) {
    if (!pid || typeof pid !== 'number') return;
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000, windowsHide: true });
    } catch (_) {
      // Process may already be dead - that's fine
    }
  }

  /**
   * Kill a terminal
   * @param {number} id - Terminal ID
   */
  kill(id) {
    const term = this.terminals.get(id);
    if (!term) {
      // Closed while its exit 255 was being checked against the host: the
      // check reports nothing once it lands, and the tab is told now.
      if (this._judging.delete(id)) {
        this.sendToRenderer('terminal-exit', { id });
        return;
      }
      // A remote tab waiting to reconnect has no process left, only the
      // context respawn() would use. Closing it drops that, and says so the
      // way a live kill does.
      if (this.disconnected.delete(id)) this.sendToRenderer('terminal-exit', { id });
      return;
    }

    const pid = term.pid;
    term._exited = true;
    this.terminals.delete(id);

    // Notify renderer before disposing listeners
    this.sendToRenderer('terminal-exit', { id });

    // Dispose event listeners before killing to prevent leaks
    if (term._disposables) {
      for (const d of term._disposables) {
        try { d.dispose(); } catch (_) {}
      }
      term._disposables = null;
    }

    try {
      term.kill();
    } catch (e) {
      console.warn(`[Terminal] kill() failed for ${id}:`, e.message);
    }

    // On Windows, ensure the full process tree is dead
    if (process.platform === 'win32') {
      this._forceKillWindows(pid);
    }
  }

  /**
   * Kill all terminals
   */
  killAll() {
    const pids = [];
    this.terminals.forEach((term, id) => {
      pids.push(term.pid);
      // Dispose event listeners before killing
      if (term._disposables) {
        for (const d of term._disposables) {
          try { d.dispose(); } catch (_) {}
        }
        term._disposables = null;
      }
      try { term.kill(); } catch (_) {}
    });
    this.terminals.clear();
    this.disconnected.clear();
    this._judging.clear();

    // Ensure all process trees are dead on Windows
    if (process.platform === 'win32') {
      pids.forEach(pid => this._forceKillWindows(pid));
    }
  }

  /**
   * Get terminal count
   * @returns {number}
   */
  count() {
    return this.terminals.size;
  }

  /**
   * Check if terminal exists
   * @param {number} id
   * @returns {boolean}
   */
  has(id) {
    return this.terminals.has(id);
  }
}

// Singleton instance
const terminalService = new TerminalService();

module.exports = terminalService;
