/**
 * FiveM Service
 * Manages FiveM server processes
 */

const path = require('path');
const pty = require('node-pty');
const { execFile, execFileSync } = require('child_process');

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

    // Forward all data directly — no echo filtering needed (no shell wrapper).
    // Keep the disposable so we can detach when stopping, otherwise the old
    // PTY would keep streaming data during the 3s graceful-shutdown window
    // and mix into the next run after a restart.
    const dataDisposable = ptyProcess.onData(data => {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('fivem-data', { projectIndex, data });
      }
    });

    // Handle exit
    const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
      try { dataDisposable && dataDisposable.dispose && dataDisposable.dispose(); } catch (e) {}
      try { exitDisposable && exitDisposable.dispose && exitDisposable.dispose(); } catch (e) {}
      ptyProcess.kill();
      // Only emit exit if this PTY is still the registered one — a restart
      // may have already replaced it.
      if (this.processes.get(projectIndex) === ptyProcess) {
        this.processes.delete(projectIndex);
      }
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('fivem-exit', { projectIndex, code: exitCode });
      }
    });

    ptyProcess._disposables = [dataDisposable, exitDisposable];

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
      this.processes.delete(projectIndex);
      // Detach data forwarding immediately so the dying process can't bleed
      // output into the next run after a restart.
      if (Array.isArray(proc._disposables)) {
        for (const d of proc._disposables) {
          try { d && d.dispose && d.dispose(); } catch (e) {}
        }
        proc._disposables = [];
      }
      try {
        // Send quit command first for graceful shutdown
        proc.write('quit\r');

        // Force kill after timeout if still running
        setTimeout(() => {
          this._forceKill(pid);
        }, 3000);
      } catch (e) {
        console.error('Error stopping FiveM server:', e);
        this._forceKill(pid);
      }
    }
    return { success: true };
  }

  /**
   * Force kill a process and all its children
   * @param {number} pid - Process ID
   */
  _forceKill(pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return;

    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/F', '/T', '/PID', String(pid)], (err) => {
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
      try { proc.write('quit\r'); } catch (e) {}
      // Force kill synchronously to ensure process tree is dead before app exits
      this._forceKillSync(pid);
    });
    this.processes.clear();
  }

  /**
   * Synchronous force kill — used during app shutdown to prevent orphaned processes
   * @param {number} pid - Process ID
   */
  _forceKillSync(pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return;
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 5000, windowsHide: true });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch (e) {}
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
   * Build a fxmanifest.lua content string from structured data
   * @param {Object} data
   * @returns {string}
   */
  _buildManifest({ fxVersion = 'cerulean', game = 'gta5', name = '', description = '', version = '1.0.0', author = '', clientScriptsRaw = '', serverScriptsRaw = '', sharedScriptsRaw = '' , dependenciesRaw = '' } = {}) {
    const lines = [];

    // Escape single quotes in Lua string values to prevent Lua injection
    const luaStr = (s) => String(s).replace(/'/g, "\\'");

    lines.push(`fx_version '${luaStr(fxVersion)}'`);
    lines.push(`game '${luaStr(game)}'`);
    lines.push('');

    if (name) lines.push(`name '${luaStr(name)}'`);
    if (description) lines.push(`description '${luaStr(description)}'`);
    if (version) lines.push(`version '${luaStr(version)}'`);
    if (author) lines.push(`author '${luaStr(author)}'`);

    const formatScripts = (raw, key) => {
      const entries = raw.split('\n').map(l => l.trim()).filter(Boolean);
      if (entries.length === 0) return null;
      return `${key} { ${entries.map(e => `'${luaStr(e)}'`).join(', ')} }`;
    };

    const formatDeps = (raw) => {
      const entries = raw.split(/[\n,]/).map(l => l.trim()).filter(Boolean);
      if (entries.length === 0) return null;
      return `dependencies { ${entries.map(e => `'${luaStr(e)}'`).join(', ')} }`;
    };

    const clientLine = formatScripts(clientScriptsRaw, 'client_scripts');
    const serverLine = formatScripts(serverScriptsRaw, 'server_scripts');
    const sharedLine = formatScripts(sharedScriptsRaw, 'shared_scripts');
    const depsLine = formatDeps(dependenciesRaw);

    if (clientLine || serverLine || sharedLine || depsLine) lines.push('');
    if (clientLine) lines.push(clientLine);
    if (serverLine) lines.push(serverLine);
    if (sharedLine) lines.push(sharedLine);
    if (depsLine) lines.push(depsLine);

    return lines.join('\n') + '\n';
  }

  /**
   * Create a new FiveM resource with a template
   * @param {Object} options
   * @returns {Object} - { success, resourcePath } or { success: false, error }
   */
  createResource({ projectPath, name, template = 'client_server', version = '1.0.0', author = '', description = '', dependencies = '' }) {
    const fs = require('fs');

    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return { success: false, error: 'Invalid resource name' };
    }

    const resourcePath = path.join(projectPath, 'resources', name);
    if (fs.existsSync(resourcePath)) {
      return { success: false, error: 'Resource already exists' };
    }

    try {
      fs.mkdirSync(resourcePath, { recursive: true });

      // Build script file lists based on template
      let clientScriptsRaw = '';
      let serverScriptsRaw = '';

      const clientStub = '-- Client script\nlocal PlayerData = {}\n\nAddEventHandler(\'onClientGameTypeStart\', function()\n  -- Resource started\nend)\n';
      const serverStub = '-- Server script\n\nAddEventHandler(\'onResourceStart\', function(resourceName)\n  if GetCurrentResourceName() == resourceName then\n    print("Resource started")\n  end\nend)\n';
      const esxClientStub = '-- ESX Client script\nlocal ESX = exports[\'es_extended\']:getSharedObject()\n\nAddEventHandler(\'onClientGameTypeStart\', function()\n  -- Resource started\nend)\n';
      const esxServerStub = '-- ESX Server script\nlocal ESX = exports[\'es_extended\']:getSharedObject()\n\nAddEventHandler(\'onResourceStart\', function(resourceName)\n  if GetCurrentResourceName() == resourceName then\n    print("Resource started")\n  end\nend)\n';
      const qbClientStub = '-- QB-Core Client script\nlocal QBCore = exports[\'qb-core\']:GetCoreObject()\n\nAddEventHandler(\'onClientGameTypeStart\', function()\n  -- Resource started\nend)\n';
      const qbServerStub = '-- QB-Core Server script\nlocal QBCore = exports[\'qb-core\']:GetCoreObject()\n\nAddEventHandler(\'onResourceStart\', function(resourceName)\n  if GetCurrentResourceName() == resourceName then\n    print("Resource started")\n  end\nend)\n';

      if (template === 'client_server' || template === 'client_only' || template === 'esx' || template === 'qb') {
        fs.mkdirSync(path.join(resourcePath, 'client'), { recursive: true });
        const stub = template === 'esx' ? esxClientStub : template === 'qb' ? qbClientStub : clientStub;
        fs.writeFileSync(path.join(resourcePath, 'client', 'client.lua'), stub);
        clientScriptsRaw = 'client/client.lua';
      }

      if (template === 'client_server' || template === 'server_only' || template === 'esx' || template === 'qb') {
        fs.mkdirSync(path.join(resourcePath, 'server'), { recursive: true });
        const stub = template === 'esx' ? esxServerStub : template === 'qb' ? qbServerStub : serverStub;
        fs.writeFileSync(path.join(resourcePath, 'server', 'server.lua'), stub);
        serverScriptsRaw = 'server/server.lua';
      }

      // Extra deps for ESX/QB templates
      let finalDeps = dependencies;
      if (template === 'esx' && !finalDeps.includes('es_extended')) {
        finalDeps = finalDeps ? `es_extended, ${finalDeps}` : 'es_extended';
      } else if (template === 'qb' && !finalDeps.includes('qb-core')) {
        finalDeps = finalDeps ? `qb-core, ${finalDeps}` : 'qb-core';
      }

      const manifest = this._buildManifest({ name, description, version, author, clientScriptsRaw, serverScriptsRaw, dependenciesRaw: finalDeps });
      fs.writeFileSync(path.join(resourcePath, 'fxmanifest.lua'), manifest);

      return { success: true, resourcePath };
    } catch (e) {
      console.error('Error creating resource:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Read a fxmanifest.lua and return raw content + parsed fields
   * @param {Object} options
   * @returns {Object} - { success, raw, parsed }
   */
  readManifest({ resourcePath }) {
    const fs = require('fs');
    const manifestPath = path.join(resourcePath, 'fxmanifest.lua');

    if (!fs.existsSync(manifestPath)) {
      return { success: false, error: 'No fxmanifest.lua found' };
    }

    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');

      const parsed = {
        fxVersion: '',
        game: 'gta5',
        name: '',
        description: '',
        version: '',
        author: '',
        clientScripts: [],
        serverScripts: [],
        sharedScripts: [],
        dependencies: []
      };

      // Parse single-value fields: key 'value'
      const singleRe = /^(\w+)\s+'([^']+)'/gm;
      let m;
      while ((m = singleRe.exec(raw)) !== null) {
        const [, key, value] = m;
        if (key === 'fx_version') parsed.fxVersion = value;
        else if (key === 'game') parsed.game = value;
        else if (key === 'name') parsed.name = value;
        else if (key === 'description') parsed.description = value;
        else if (key === 'version') parsed.version = value;
        else if (key === 'author') parsed.author = value;
      }

      // Parse array fields: key { 'a', 'b' }
      const arrayRe = /^(\w+)\s*\{([^}]+)\}/gm;
      while ((m = arrayRe.exec(raw)) !== null) {
        const [, key, inner] = m;
        const entries = [...inner.matchAll(/'([^']+)'/g)].map(x => x[1]);
        if (key === 'client_scripts' || key === 'client_script') parsed.clientScripts = entries;
        else if (key === 'server_scripts' || key === 'server_script') parsed.serverScripts = entries;
        else if (key === 'shared_scripts' || key === 'shared_script') parsed.sharedScripts = entries;
        else if (key === 'dependencies' || key === 'dependency') parsed.dependencies = entries;
      }

      return { success: true, raw, parsed };
    } catch (e) {
      console.error('Error reading manifest:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Write a fxmanifest.lua (atomic write)
   * @param {Object} options
   * @returns {Object} - { success } or { success: false, error }
   */
  writeManifest({ resourcePath, data }) {
    const fs = require('fs');
    const manifestPath = path.join(resourcePath, 'fxmanifest.lua');
    const tmpPath = manifestPath + '.tmp';

    try {
      let content;
      if (data.raw !== undefined) {
        content = data.raw;
      } else {
        content = this._buildManifest(data);
      }

      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, manifestPath);

      return { success: true };
    } catch (e) {
      console.error('Error writing manifest:', e);
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      return { success: false, error: e.message };
    }
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
