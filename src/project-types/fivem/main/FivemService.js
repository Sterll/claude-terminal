/**
 * FiveM Service
 * Manages FiveM server processes
 */

const path = require('path');
const pty = require('node-pty');
const { exec } = require('child_process');

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
   * Parse a run command into { exe, args, workingDir }
   * Handles: relative paths, absolute paths, quoted paths, paths with spaces
   */
  _parseCommand(command, projectPath) {
    let exe = '';
    let args = [];
    let workingDir = projectPath;

    // Trim and normalize
    const cmd = command.trim();

    // Match quoted exe: "C:\path\to\exe.exe" [args...]
    const quotedMatch = cmd.match(/^"([^"]+)"(.*)/);
    if (quotedMatch) {
      exe = quotedMatch[1];
      const rest = quotedMatch[2].trim();
      args = rest ? rest.split(/\s+/) : [];
      workingDir = path.dirname(exe);
      return { exe, args, workingDir };
    }

    // Match absolute path with drive letter: C:\path\to\exe.exe [args...]
    const absMatch = cmd.match(/^([A-Za-z]:\\[^\s]+)(.*)/);
    if (absMatch) {
      exe = absMatch[1];
      const rest = absMatch[2].trim();
      args = rest ? rest.split(/\s+/) : [];
      workingDir = path.dirname(exe);
      return { exe, args, workingDir };
    }

    // Relative command: split on whitespace, first token is exe
    const parts = cmd.split(/\s+/);
    exe = parts[0];
    args = parts.slice(1);

    // Resolve relative exe against projectPath
    if (!path.isAbsolute(exe)) {
      const resolved = path.resolve(projectPath, exe);
      exe = resolved;
      workingDir = path.dirname(resolved);
    }

    return { exe, args, workingDir };
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

    const command = runCommand || './FXServer.exe +exec server.cfg';
    const { exe, args, workingDir } = this._parseCommand(command, projectPath);

    // Spawn FXServer DIRECTLY (no cmd.exe wrapper) → no shell echo at all
    const ptyProcess = pty.spawn(exe, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workingDir,
      env: process.env
    });

    this.processes.set(projectIndex, ptyProcess);

    // Forward all data directly — no echo filtering needed (no shell wrapper)
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
      const pid = proc.pid;
      try {
        // Send quit command first for graceful shutdown
        proc.write('quit\r');

        // Force kill after timeout if still running
        setTimeout(() => {
          if (this.processes.has(projectIndex)) {
            this._forceKill(pid);
            this.processes.delete(projectIndex);
          }
        }, 3000);
      } catch (e) {
        console.error('Error stopping FiveM server:', e);
        this._forceKill(pid);
        this.processes.delete(projectIndex);
      }
    }
    return { success: true };
  }

  /**
   * Force kill a process and all its children
   * @param {number} pid - Process ID
   */
  _forceKill(pid) {
    if (!pid) return;

    try {
      if (process.platform === 'win32') {
        exec(`taskkill /F /T /PID ${pid}`, (err) => {
          if (err && !err.message.includes('not found')) {
            console.error('taskkill error:', err.message);
          }
        });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch (e) {
      console.error('Force kill error:', e);
    }
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
    this.processes.forEach((proc) => {
      const pid = proc.pid;
      try {
        proc.write('quit\r');
        setTimeout(() => {
          this._forceKill(pid);
        }, 2000);
      } catch (e) {
        this._forceKill(pid);
      }
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

  /**
   * Send a command to a running FiveM server
   * @param {number} projectIndex
   * @param {string} command - Command to execute (e.g., "ensure myresource")
   */
  sendCommand(projectIndex, command) {
    const proc = this.processes.get(projectIndex);
    if (proc) {
      proc.write(command + '\r');
      return { success: true };
    }
    return { success: false, error: 'Server not running' };
  }

  /**
   * Scan resources for a FiveM project
   * @param {string} projectPath - Path to the FiveM server
   * @returns {Object} - List of resources with their status
   */
  scanResources(projectPath) {
    const fs = require('fs');
    const resources = [];
    const ensuredResources = new Set();

    // Parse server.cfg to find ensured resources
    const cfgPath = path.join(projectPath, 'server.cfg');
    if (fs.existsSync(cfgPath)) {
      try {
        const cfgContent = fs.readFileSync(cfgPath, 'utf8');
        const lines = cfgContent.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;

          const match = trimmed.match(/^(ensure|start|restart)\s+(.+)$/i);
          if (match) {
            ensuredResources.add(match[2].trim());
          }
        }
      } catch (e) {
        console.error('Error parsing server.cfg:', e);
      }
    }

    // Scan resources folder
    const resourcesFolders = ['resources', 'resources/[local]', 'resources/[standalone]'];
    const scannedFolders = new Set();

    const mainResourcesPath = path.join(projectPath, 'resources');
    if (fs.existsSync(mainResourcesPath)) {
      try {
        const entries = fs.readdirSync(mainResourcesPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith('[') && entry.name.endsWith(']')) {
            resourcesFolders.push(`resources/${entry.name}`);
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    for (const folder of resourcesFolders) {
      const folderPath = path.join(projectPath, folder);
      if (!fs.existsSync(folderPath)) continue;

      try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          if (entry.name.startsWith('[') && entry.name.endsWith(']')) continue;
          if (scannedFolders.has(entry.name)) continue;

          scannedFolders.add(entry.name);

          const resourcePath = path.join(folderPath, entry.name);
          const hasFxManifest = fs.existsSync(path.join(resourcePath, 'fxmanifest.lua'));
          const hasResourceLua = fs.existsSync(path.join(resourcePath, '__resource.lua'));

          if (hasFxManifest || hasResourceLua) {
            resources.push({
              name: entry.name,
              path: resourcePath,
              category: folder.replace('resources/', '').replace('resources', 'root'),
              ensured: ensuredResources.has(entry.name),
              manifest: hasFxManifest ? 'fxmanifest.lua' : '__resource.lua'
            });
          }
        }
      } catch (e) {
        console.error(`Error scanning ${folder}:`, e);
      }
    }

    resources.sort((a, b) => {
      if (a.ensured !== b.ensured) return b.ensured ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    return { success: true, resources, ensuredCount: ensuredResources.size };
  }
}

// Singleton instance
const fivemService = new FivemService();

module.exports = fivemService;
