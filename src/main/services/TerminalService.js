/**
 * Terminal Service
 * Manages PTY terminal processes
 */

const os = require('os');
const pty = require('node-pty');

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
   * Create a new terminal
   * @param {Object} options
   * @param {string} options.cwd - Working directory
   * @param {boolean} options.runClaude - Whether to run Claude CLI on start
   * @param {boolean} options.skipPermissions - Skip permissions flag for Claude
   * @param {string} options.resumeSessionId - Session ID to resume
   * @returns {number} - Terminal ID
   */
  create({ cwd, runClaude, skipPermissions, resumeSessionId }) {
    const id = ++this.terminalId;
    const shellPath = process.platform === 'win32' ? 'powershell.exe' : 'bash';

    const ptyProcess = pty.spawn(shellPath, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: cwd || os.homedir(),
      env: process.env
    });

    this.terminals.set(id, ptyProcess);

    // Handle data output
    ptyProcess.onData(data => {
      this.mainWindow?.webContents.send('terminal-data', { id, data });
    });

    // Handle exit
    ptyProcess.onExit(() => {
      this.terminals.delete(id);
      this.mainWindow?.webContents.send('terminal-exit', { id });
    });

    // Run Claude CLI if requested
    if (runClaude) {
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

    return id;
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
   * Kill a terminal
   * @param {number} id - Terminal ID
   */
  kill(id) {
    const term = this.terminals.get(id);
    if (term) {
      term.kill();
      this.terminals.delete(id);
    }
  }

  /**
   * Kill all terminals
   */
  killAll() {
    this.terminals.forEach(term => term.kill());
    this.terminals.clear();
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
