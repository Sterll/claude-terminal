/**
 * MCP Service
 * Manages MCP (Model Context Protocol) server processes
 */

const { spawn } = require('child_process');

class McpService {
  constructor() {
    this.processes = new Map(); // Map id -> ChildProcess
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
   * Start an MCP server process
   * @param {Object} options
   * @param {string} options.id - Unique MCP ID
   * @param {string} options.command - Command to run
   * @param {Array} options.args - Command arguments
   * @param {Object} options.env - Environment variables
   * @returns {Object} - Result object
   */
  start({ id, command, args = [], env = {} }) {
    // Kill existing process if any
    if (this.processes.has(id)) {
      this.stop({ id });
    }

    // Merge environment variables
    const processEnv = { ...process.env, ...env };

    // Spawn the process
    const proc = spawn(command, args, {
      env: processEnv,
      shell: true,
      windowsHide: true
    });

    this.processes.set(id, proc);

    // Helper to safely send IPC messages
    const safeSend = (channel, data) => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(channel, data);
      }
    };

    // Handle stdout
    proc.stdout.on('data', (data) => {
      safeSend('mcp-output', { id, type: 'stdout', data: data.toString() });
    });

    // Handle stderr
    proc.stderr.on('data', (data) => {
      safeSend('mcp-output', { id, type: 'stderr', data: data.toString() });
    });

    // Handle exit
    proc.on('exit', (code) => {
      this.processes.delete(id);
      safeSend('mcp-exit', { id, code: code || 0 });
    });

    // Handle error
    proc.on('error', (err) => {
      safeSend('mcp-output', { id, type: 'stderr', data: `Error: ${err.message}` });
      this.processes.delete(id);
      safeSend('mcp-exit', { id, code: 1 });
    });

    return { success: true };
  }

  /**
   * Stop an MCP server process
   * @param {Object} options
   * @param {string} options.id - MCP ID to stop
   * @returns {Object} - Result object
   */
  stop({ id }) {
    const proc = this.processes.get(id);
    if (proc) {
      try {
        // On Windows, use taskkill to kill the process tree
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { shell: true });
        } else {
          proc.kill('SIGTERM');
          // Force kill after timeout
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch (e) {}
          }, 3000);
        }
      } catch (e) {
        console.error('Error stopping MCP process:', e);
      }
      this.processes.delete(id);
    }
    return { success: true };
  }

  /**
   * Stop all MCP processes
   */
  stopAll() {
    this.processes.forEach((proc, id) => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { shell: true });
        } else {
          proc.kill('SIGKILL');
        }
      } catch (e) {}
    });
    this.processes.clear();
  }

  /**
   * Check if an MCP process is running
   * @param {string} id
   * @returns {boolean}
   */
  isRunning(id) {
    return this.processes.has(id);
  }

  /**
   * Get running process count
   * @returns {number}
   */
  count() {
    return this.processes.size;
  }
}

// Singleton instance
const mcpService = new McpService();

module.exports = mcpService;
