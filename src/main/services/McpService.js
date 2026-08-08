/**
 * MCP Service
 * Manages MCP (Model Context Protocol) server processes
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_RESTARTS    = 3;
const RESTART_DELAY   = 3000; // ms
const RESTART_WINDOW  = 60000; // ms — reset counter after 60s without crash

// Shell metacharacters — rejected in the command and in every argument
const DANGEROUS_PATTERN = /[;&|`$(){}<>\r\n]/;
// Additional cmd.exe metacharacters, rejected when routing through cmd.exe
const CMD_DANGEROUS_PATTERN = /[%^!"]/;

// Environment variables that are code-execution primitives for a spawned process
const BLOCKED_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'BASH_ENV'
]);

/**
 * Resolve a base path against PATHEXT (Windows only)
 * @param {string} base - Path without extension (or with one already)
 * @returns {string|null} - Existing file path, or null
 */
function resolveWithExtensions(base) {
  if (path.extname(base) && fs.existsSync(base)) return base;
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const ext of extensions) {
    const candidate = base + ext.toLowerCase();
    if (fs.existsSync(candidate)) return candidate;
  }
  return fs.existsSync(base) ? base : null;
}

/**
 * Locate a command on Windows without going through a shell.
 * Needed because spawn() runs the binary directly (shell: false), so PATH and
 * PATHEXT resolution must be done manually.
 * @param {string} command
 * @returns {string|null} - Absolute path to the executable, or null if not found
 */
function resolveWindowsCommand(command) {
  if (path.isAbsolute(command) || /[\\/]/.test(command)) {
    return resolveWithExtensions(command);
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const found = resolveWithExtensions(path.join(dir, command));
    if (found) return found;
  }
  return null;
}

class McpService {
  constructor() {
    this.processes    = new Map(); // Map id -> ChildProcess
    this.configs      = new Map(); // Map id -> { command, args, env }
    this.restarts     = new Map(); // Map id -> { count, windowStart }
    this.mainWindow   = null;
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

    // Validate inputs to prevent shell injection
    if (typeof command !== 'string' || !command.trim()) {
      return { success: false, error: 'Invalid command' };
    }
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
      return { success: false, error: 'Invalid arguments' };
    }
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      return { success: false, error: 'Invalid environment' };
    }
    // Block obvious shell injection characters in the command and in every argument
    if (DANGEROUS_PATTERN.test(command)) {
      console.error(`[MCP] Blocked suspicious command: ${command}`);
      return { success: false, error: 'Command contains disallowed characters' };
    }
    const badArg = args.find(a => DANGEROUS_PATTERN.test(a));
    if (badArg !== undefined) {
      console.error(`[MCP] Blocked suspicious argument: ${badArg}`);
      return { success: false, error: 'Arguments contain disallowed characters' };
    }
    // Reject env keys that would let the caller execute arbitrary code in the child
    const blockedKey = Object.keys(env).find(k => BLOCKED_ENV_KEYS.has(k.toUpperCase()));
    if (blockedKey) {
      console.error(`[MCP] Blocked dangerous environment variable: ${blockedKey}`);
      return { success: false, error: `Environment variable '${blockedKey}' is not allowed` };
    }

    // Merge environment variables
    const processEnv = { ...process.env, ...env };

    // Resolve what to spawn. The process is always spawned without a shell; on
    // Windows the .cmd/.bat launchers (npx.cmd, npm.cmd, ...) cannot be exec'd
    // directly, so they are run through cmd.exe with an explicitly quoted argv.
    const spawnOptions = { env: processEnv, windowsHide: true };
    let spawnCommand = command;
    let spawnArgs = args;

    if (process.platform === 'win32') {
      const resolved = resolveWindowsCommand(command);
      if (!resolved) {
        console.error(`[MCP] Command not found: ${command}`);
        return { success: false, error: `Command not found: ${command}` };
      }
      if (/\.(cmd|bat)$/i.test(resolved)) {
        const cmdBadToken = [resolved, ...args].find(a => CMD_DANGEROUS_PATTERN.test(a));
        if (cmdBadToken !== undefined) {
          console.error(`[MCP] Blocked suspicious cmd.exe token: ${cmdBadToken}`);
          return { success: false, error: 'Arguments contain disallowed characters' };
        }
        const commandLine = [resolved, ...args].map(a => `"${a}"`).join(' ');
        spawnCommand = process.env.ComSpec || 'cmd.exe';
        spawnArgs = ['/d', '/s', '/c', `"${commandLine}"`];
        spawnOptions.windowsVerbatimArguments = true;
      } else {
        spawnCommand = resolved;
      }
    }

    let proc;
    try {
      proc = spawn(spawnCommand, spawnArgs, spawnOptions);
    } catch (error) {
      console.error(`[MCP] Failed to spawn ${command}:`, error.message);
      return { success: false, error: error.message };
    }

    if (!proc || !proc.pid) {
      console.error(`[MCP] Spawn returned no process for ${command}`);
      return { success: false, error: 'Process spawn failed' };
    }

    // Store config for auto-restart
    this.configs.set(id, { command, args, env });
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

    const scheduleRestart = (code) => {
      const now = Date.now();
      const entry = this.restarts.get(id) || { count: 0, windowStart: now };
      // Reset counter if last crash was more than RESTART_WINDOW ago
      if (now - entry.windowStart > RESTART_WINDOW) {
        entry.count = 0;
        entry.windowStart = now;
      }
      if (entry.count < MAX_RESTARTS) {
        entry.count++;
        this.restarts.set(id, entry);
        const delay = RESTART_DELAY * entry.count;
        safeSend('mcp-output', { id, type: 'stderr', data: `[MCP] Process exited (code ${code}), restarting in ${delay / 1000}s (attempt ${entry.count}/${MAX_RESTARTS})...\n` });
        setTimeout(() => {
          if (!this.processes.has(id) && this.configs.has(id)) {
            this.start(this.configs.get(id));
          }
        }, delay);
      } else {
        this.restarts.delete(id);
        this.configs.delete(id);
        safeSend('mcp-output', { id, type: 'stderr', data: `[MCP] Process crashed ${MAX_RESTARTS} times, giving up.\n` });
        safeSend('mcp-exit', { id, code: code || 1 });
      }
    };

    // Handle exit
    proc.on('exit', (code) => {
      this.processes.delete(id);
      // Only auto-restart on unexpected exits (code != 0 and not manually stopped)
      if (code !== 0 && this.configs.has(id)) {
        scheduleRestart(code);
      } else {
        this.configs.delete(id);
        this.restarts.delete(id);
        safeSend('mcp-exit', { id, code: code || 0 });
      }
    });

    // Handle error
    proc.on('error', (err) => {
      safeSend('mcp-output', { id, type: 'stderr', data: `Error: ${err.message}` });
      this.processes.delete(id);
      if (this.configs.has(id)) {
        scheduleRestart(1);
      } else {
        safeSend('mcp-exit', { id, code: 1 });
      }
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
    // Remove config first so auto-restart is suppressed
    this.configs.delete(id);
    this.restarts.delete(id);
    const proc = this.processes.get(id);
    if (proc) {
      try {
        // On Windows, use taskkill to kill the process tree
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { windowsHide: true });
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
    // Clear configs first to suppress auto-restart
    this.configs.clear();
    this.restarts.clear();
    this.processes.forEach((proc, id) => {
      try {
        if (process.platform === 'win32') {
          // Use synchronous taskkill to ensure process tree is dead before app exits
          execFileSync('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], { timeout: 5000, windowsHide: true });
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
