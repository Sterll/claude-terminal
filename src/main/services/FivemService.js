/**
 * FiveM Service
 * Manages FiveM server processes
 */

const path = require('path');
const pty = require('node-pty');

class FivemService {
  constructor() {
    this.processes = new Map(); // Map projectIndex -> pty process
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
   * Start a FiveM server
   * @param {Object} options
   * @param {number} options.projectIndex - Project index
   * @param {string} options.projectPath - Project path
   * @param {string} options.runCommand - Custom run command
   * @returns {Object} - Result object
   */
  start({ projectIndex, projectPath, runCommand }) {
    // Kill existing process if any
    if (this.processes.has(projectIndex)) {
      this.stop({ projectIndex });
    }

    // Use custom command or default
    const command = runCommand || './FXServer.exe +exec server.cfg';

    // Determine working directory
    let workingDir = projectPath;
    if (process.platform === 'win32') {
      // Check if command starts with a drive letter (e.g., C:\...)
      const absPathMatch = command.match(/^([A-Za-z]:\\[^"\s]+(?:\\[^"\s]*)*)/);
      if (absPathMatch) {
        const exePath = absPathMatch[1];
        workingDir = path.dirname(exePath);
      }
    }

    // On Windows, use cmd.exe for better compatibility
    const shellPath = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

    // Spawn using node-pty for proper terminal emulation
    const ptyProcess = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: process.env
    });

    this.processes.set(projectIndex, ptyProcess);

    // Handle data output
    ptyProcess.onData(data => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('fivem-data', { projectIndex, data });
      }
    });

    // Handle exit
    ptyProcess.onExit(({ exitCode }) => {
      this.processes.delete(projectIndex);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('fivem-exit', { projectIndex, code: exitCode });
      }
    });

    return { success: true };
  }

  /**
   * Stop a FiveM server
   * @param {Object} options
   * @param {number} options.projectIndex - Project index
   * @returns {Object} - Result object
   */
  stop({ projectIndex }) {
    const proc = this.processes.get(projectIndex);
    if (proc) {
      try {
        // Send quit command first for graceful shutdown
        proc.write('quit\r');

        // Force kill after timeout if still running
        setTimeout(() => {
          if (this.processes.has(projectIndex)) {
            try {
              proc.kill();
            } catch (e) {}
            this.processes.delete(projectIndex);
          }
        }, 5000);
      } catch (e) {
        console.error('Error stopping FiveM server:', e);
      }
    }
    return { success: true };
  }

  /**
   * Write input to a FiveM server console
   * @param {number} projectIndex
   * @param {string} data
   */
  write(projectIndex, data) {
    const proc = this.processes.get(projectIndex);
    if (proc) {
      proc.write(data);
    }
  }

  /**
   * Resize FiveM terminal
   * @param {number} projectIndex
   * @param {number} cols
   * @param {number} rows
   */
  resize(projectIndex, cols, rows) {
    const proc = this.processes.get(projectIndex);
    if (proc) {
      proc.resize(cols, rows);
    }
  }

  /**
   * Stop all FiveM servers
   */
  stopAll() {
    this.processes.forEach((proc, index) => {
      try {
        proc.write('quit\r');
        setTimeout(() => {
          try { proc.kill(); } catch (e) {}
        }, 2000);
      } catch (e) {}
    });
    this.processes.clear();
  }

  /**
   * Check if a FiveM server is running
   * @param {number} projectIndex
   * @returns {boolean}
   */
  isRunning(projectIndex) {
    return this.processes.has(projectIndex);
  }

  /**
   * Get running server count
   * @returns {number}
   */
  count() {
    return this.processes.size;
  }
}

// Singleton instance
const fivemService = new FivemService();

module.exports = fivemService;
