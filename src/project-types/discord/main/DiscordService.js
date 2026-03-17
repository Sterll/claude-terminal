/**
 * Discord Bot Service
 * Manages bot processes for Discord projects
 */

const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { execFile, execFileSync } = require('child_process');

// Patterns to detect bot readiness from stdout
const READY_PATTERNS = [
  /ready!?\s*logged\s*in\s*as\s+(.+?)(?:\s*\(|$)/i,
  /bot\s+(?:is\s+)?(?:now\s+)?(?:online|ready|connected)/i,
  /logged\s+in\s+as\s+(.+?)(?:\s*#|\s*\(|$)/i,
  /connected\s+to\s+discord/i,
  /client\s+ready/i,
  /on_ready/i
];

// Patterns to detect guild count
const GUILD_PATTERNS = [
  /serving\s+(\d+)\s+(?:guild|server)s?/i,
  /(\d+)\s+(?:guild|server)s?\s+(?:loaded|found|connected)/i,
  /guilds?:\s*(\d+)/i
];

// Supported Discord libraries
const JS_LIBRARIES = {
  'discord.js': { name: 'discord.js', lang: 'js' },
  'eris': { name: 'Eris', lang: 'js' },
  'oceanic.js': { name: 'Oceanic.js', lang: 'js' },
  'discordeno': { name: 'Discordeno', lang: 'js' }
};

const PY_LIBRARIES = {
  'discord.py': { name: 'discord.py', lang: 'py' },
  'discord': { name: 'discord.py', lang: 'py' },
  'py-cord': { name: 'Pycord', lang: 'py' },
  'nextcord': { name: 'Nextcord', lang: 'py' },
  'disnake': { name: 'Disnake', lang: 'py' },
  'hikari': { name: 'Hikari', lang: 'py' }
};

class DiscordService {
  constructor() {
    this.processes = new Map(); // projectIndex -> pty process
    this.mainWindow = null;
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Start a Discord bot
   */
  start({ projectIndex, projectPath, startCommand }) {
    if (this.processes.has(projectIndex)) {
      this.stop({ projectIndex });
    }

    const command = startCommand || this._autoDetectCommand(projectPath);
    if (!command) {
      return { success: false, error: 'No start command configured and none detected' };
    }

    const shellPath = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

    const ptyProcess = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: projectPath,
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    this.processes.set(projectIndex, ptyProcess);

    ptyProcess.onData(data => {
      // Check for bot ready status
      this._detectStatus(projectIndex, data);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('discord-data', { projectIndex, data });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      ptyProcess.kill();
      this.processes.delete(projectIndex);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('discord-exit', { projectIndex, code: exitCode });
      }
    });

    return { success: true, command };
  }

  /**
   * Stop a Discord bot
   */
  stop({ projectIndex }) {
    const proc = this.processes.get(projectIndex);
    if (proc) {
      const pid = proc.pid;
      this.processes.delete(projectIndex);
      try {
        proc.write('\x03');
        setTimeout(() => {
          this._forceKill(pid);
        }, 3000);
      } catch (e) {
        this._forceKill(pid);
      }
    }
    return { success: true };
  }

  _forceKill(pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return;
    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => {});
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch (e) {
      // ignore
    }
  }

  write(projectIndex, data) {
    const proc = this.processes.get(projectIndex);
    if (proc) proc.write(data);
  }

  resize(projectIndex, cols, rows) {
    const proc = this.processes.get(projectIndex);
    if (proc) proc.resize(cols, rows);
  }

  /**
   * Detect bot ready status from output
   */
  _detectStatus(projectIndex, data) {
    const clean = data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b[@-Z\\-_]|\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');

    let botName = null;
    for (const pattern of READY_PATTERNS) {
      const match = clean.match(pattern);
      if (match) {
        botName = match[1] || null;
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('discord-status-change', {
            projectIndex, status: 'online', botName
          });
        }
        break;
      }
    }

    // Try detecting guild count
    for (const pattern of GUILD_PATTERNS) {
      const match = clean.match(pattern);
      if (match) {
        const guildCount = parseInt(match[1], 10);
        if (!isNaN(guildCount) && this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('discord-status-change', {
            projectIndex, guildCount
          });
        }
        break;
      }
    }
  }

  /**
   * Auto-detect start command
   */
  _autoDetectCommand(projectPath) {
    // Try Node.js project
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const pm = this._detectPackageManager(projectPath);

        if (pkg.scripts?.bot) return `${pm} run bot`;
        if (pkg.scripts?.start) return `${pm} start`;
        if (pkg.scripts?.dev) return `${pm} run dev`;
        if (pkg.main) return `node ${pkg.main}`;

        // Check for common bot entry points
        const entries = ['bot.js', 'index.js', 'main.js', 'src/index.js', 'src/bot.js'];
        for (const entry of entries) {
          if (fs.existsSync(path.join(projectPath, entry))) {
            return `node ${entry}`;
          }
        }
      }
    } catch (e) {}

    // Try Python project
    const pyEntries = ['bot.py', 'main.py', 'run.py', 'app.py'];
    for (const entry of pyEntries) {
      if (fs.existsSync(path.join(projectPath, entry))) {
        return `python ${entry}`;
      }
    }

    return null;
  }

  /**
   * Detect package manager
   */
  _detectPackageManager(projectPath) {
    if (fs.existsSync(path.join(projectPath, 'bun.lockb'))) return 'bun';
    if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  /**
   * Detect which Discord library is used
   */
  detectLibrary(projectPath) {
    // Check package.json (Node.js)
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const [dep, info] of Object.entries(JS_LIBRARIES)) {
          if (deps[dep]) return { ...info, version: deps[dep] };
        }
      }
    } catch (e) {}

    // Check requirements.txt (Python)
    try {
      const reqPath = path.join(projectPath, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        const content = fs.readFileSync(reqPath, 'utf8');
        for (const [dep, info] of Object.entries(PY_LIBRARIES)) {
          if (content.includes(dep)) return { ...info };
        }
      }
    } catch (e) {}

    // Check pyproject.toml
    try {
      const pyprojectPath = path.join(projectPath, 'pyproject.toml');
      if (fs.existsSync(pyprojectPath)) {
        const content = fs.readFileSync(pyprojectPath, 'utf8');
        for (const [dep, info] of Object.entries(PY_LIBRARIES)) {
          if (content.includes(dep)) return { ...info };
        }
      }
    } catch (e) {}

    return null;
  }

  /**
   * Scan source files for slash commands
   */
  scanCommands(projectPath) {
    const commands = [];
    const library = this.detectLibrary(projectPath);
    if (!library) return commands;

    const extensions = library.lang === 'py' ? ['.py'] : ['.js', '.ts', '.mjs'];
    const files = this._getSourceFiles(projectPath, extensions);

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const relPath = path.relative(projectPath, file);

        if (library.lang === 'js') {
          this._scanJsCommands(content, relPath, commands);
        } else {
          this._scanPyCommands(content, relPath, commands);
        }
      } catch (e) {}
    }

    return commands;
  }

  _scanJsCommands(content, file, commands) {
    // SlashCommandBuilder pattern (discord.js)
    const builderPattern = /new\s+SlashCommandBuilder\(\)\s*\.setName\(['"`]([^'"`]+)['"`]\)(?:\s*\.setDescription\(['"`]([^'"`]+)['"`]\))?/g;
    let match;
    while ((match = builderPattern.exec(content)) !== null) {
      commands.push({ name: match[1], description: match[2] || '', file, type: 'slash' });
    }

    // Object literal pattern: { name: 'cmd', description: '...' }
    const objPattern = /(?:name|data)\s*:\s*['"`]([^'"`]+)['"`]\s*,\s*description\s*:\s*['"`]([^'"`]+)['"`]/g;
    while ((match = objPattern.exec(content)) !== null) {
      if (!commands.find(c => c.name === match[1])) {
        commands.push({ name: match[1], description: match[2], file, type: 'slash' });
      }
    }

    // Eris pattern: bot.registerCommand('name', ...)
    const erisPattern = /\.registerCommand\(['"`]([^'"`]+)['"`]/g;
    while ((match = erisPattern.exec(content)) !== null) {
      commands.push({ name: match[1], description: '', file, type: 'prefix' });
    }
  }

  _scanPyCommands(content, file, commands) {
    // @bot.command / @bot.slash_command / @app_commands.command
    const patterns = [
      /@(?:\w+\.)?(?:slash_)?command\(\s*(?:name\s*=\s*)?['"]([^'"]+)['"]/g,
      /@(?:\w+\.)?tree\.command\(\s*(?:name\s*=\s*)?['"]([^'"]+)['"]/g,
      /async\s+def\s+(\w+)\(.*?(?:commands\.Context|Interaction)/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (!commands.find(c => c.name === match[1])) {
          commands.push({ name: match[1], description: '', file, type: 'slash' });
        }
      }
    }
  }

  _getSourceFiles(dir, extensions, depth = 0) {
    if (depth > 4) return [];
    const files = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'venv') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...this._getSourceFiles(full, extensions, depth + 1));
        } else if (extensions.some(ext => entry.name.endsWith(ext))) {
          files.push(full);
        }
      }
    } catch (e) {}
    return files;
  }

  isRunning(projectIndex) {
    return this.processes.has(projectIndex);
  }

  stopAll() {
    this.processes.forEach((proc) => {
      const pid = proc.pid;
      try { proc.write('\x03'); } catch (e) {}
      this._forceKillSync(pid);
    });
    this.processes.clear();
  }

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
}

const discordService = new DiscordService();
module.exports = discordService;
