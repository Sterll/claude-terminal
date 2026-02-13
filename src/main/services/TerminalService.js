/**
 * Terminal Service
 * Manages PTY terminal processes
 */

const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { execSync } = require('child_process');

class TerminalService {
  constructor() {
    this.terminals = new Map();
    this.terminalId = 0;
    this.mainWindow = null;
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
   * @returns {Object} - { success: boolean, id?: number, error?: string }
   */
  create({ cwd, runClaude, skipPermissions, resumeSessionId }) {
    const id = ++this.terminalId;
    let shellPath = process.platform === 'win32' ? 'powershell.exe' : 'bash';
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
      if (resumeSessionId) {
        claudeArgs.push('--resume', resumeSessionId);
      }
      if (skipPermissions) {
        claudeArgs.push('--dangerously-skip-permissions');
      }
      shellPath = 'cmd.exe';
      shellArgs = ['/c', ...claudeArgs];
    }

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(shellPath, shellArgs, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: effectiveCwd,
        env: process.env
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

    this.terminals.set(id, ptyProcess);

    // Handle data output - adaptive batching to reduce IPC flooding
    // 4ms flush when idle (responsive typing), 16ms normal, 32ms when flooding
    let buffer = '';
    let flushScheduled = false;
    let lastFlush = Date.now();

    ptyProcess.onData(data => {
      buffer += data;
      if (!flushScheduled) {
        flushScheduled = true;
        const sinceLastFlush = Date.now() - lastFlush;
        const delay = buffer.length > 10000 ? 32 : sinceLastFlush > 100 ? 4 : 16;
        setTimeout(() => {
          this.sendToRenderer('terminal-data', { id, data: buffer });
          buffer = '';
          flushScheduled = false;
          lastFlush = Date.now();
        }, delay);
      }
    });

    // Handle exit
    ptyProcess.onExit(() => {
      this.terminals.delete(id);
      this.sendToRenderer('terminal-exit', { id });
    });

    // Run Claude CLI on non-Windows platforms
    if (runClaude && process.platform !== 'win32') {
      setTimeout(() => {
        let claudeCmd = 'claude';
        if (resumeSessionId) {
          claudeCmd += ` --resume ${resumeSessionId}`;
        }
        if (skipPermissions) {
          claudeCmd += ' --dangerously-skip-permissions';
        }
        ptyProcess.write(claudeCmd + '\r');
      }, 500);
    }

    return { success: true, id };
  }

  /**
   * Write data to a terminal
   * @param {number} id - Terminal ID
   * @param {string} data - Data to write
   */
  write(id, data) {
    const term = this.terminals.get(id);
    if (term) {
      term.write(data);
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
      term.resize(cols, rows);
    }
  }

  /**
   * Force-kill a process tree on Windows via taskkill
   * @param {number} pid - Process ID
   */
  _forceKillWindows(pid) {
    if (!pid) return;
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { timeout: 5000, windowsHide: true });
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
    if (!term) return;

    const pid = term.pid;
    this.terminals.delete(id);

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
      try { term.kill(); } catch (_) {}
    });
    this.terminals.clear();

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
