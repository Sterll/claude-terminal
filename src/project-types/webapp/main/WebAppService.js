/**
 * Web App Service
 * Manages dev server processes for web projects
 */

const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { exec } = require('child_process');

// Port detection patterns from dev server output
const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/,
  /(?:listening|running|started|ready)\s+(?:on|at)\s+(?:port\s+)?(\d+)/i,
  /port\s+(\d+)/i
];

class WebAppService {
  constructor() {
    this.processes = new Map(); // projectIndex -> pty process
    this.detectedPorts = new Map(); // projectIndex -> port number
    this.mainWindow = null;
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Start a dev server
   */
  start({ projectIndex, projectPath, devCommand }) {
    if (this.processes.has(projectIndex)) {
      this.stop({ projectIndex });
    }

    const command = devCommand || this._autoDetectCommand(projectPath);
    if (!command) {
      return { success: false, error: 'No dev command configured and none detected' };
    }

    this.detectedPorts.delete(projectIndex);

    const shellPath = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    const shellArgs = process.platform === 'win32' ? ['/c', command] : ['-c', command];

    const ptyProcess = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: projectPath,
      env: { ...process.env, FORCE_COLOR: '1', NODE_ENV: 'development' }
    });

    this.processes.set(projectIndex, ptyProcess);

    ptyProcess.onData(data => {
      // Detect port from output
      this._detectPort(projectIndex, data);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('webapp-data', { projectIndex, data });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.processes.delete(projectIndex);
      this.detectedPorts.delete(projectIndex);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('webapp-exit', { projectIndex, code: exitCode });
      }
    });

    return { success: true, command };
  }

  /**
   * Stop a dev server
   */
  stop({ projectIndex }) {
    const proc = this.processes.get(projectIndex);
    if (proc) {
      const pid = proc.pid;
      try {
        // Send Ctrl+C first for graceful shutdown
        proc.write('\x03');
        setTimeout(() => {
          if (this.processes.has(projectIndex)) {
            this._forceKill(pid);
            this.processes.delete(projectIndex);
          }
        }, 3000);
      } catch (e) {
        this._forceKill(pid);
        this.processes.delete(projectIndex);
      }
    }
    this.detectedPorts.delete(projectIndex);
    return { success: true };
  }

  _forceKill(pid) {
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /F /T /PID ${pid}`, () => {});
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
   * Detect port from dev server output
   * Runs on every data chunk — always takes the latest detected port
   * so restarts with a different port are picked up correctly.
   */
  _detectPort(projectIndex, data) {
    // Strip ANSI escape sequences (CSI, OSC, simple escapes)
    const clean = data
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC sequences
      .replace(/\x1b[@-Z\\-_]|\x1b\[[0-9;]*[A-Za-z]/g, '') // CSI / simple
      .replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');  // other control chars

    let found = null;
    for (const pattern of PORT_PATTERNS) {
      // Use global flag to find ALL matches and take the last one
      const re = new RegExp(pattern.source, 'gi');
      let m;
      while ((m = re.exec(clean)) !== null) {
        const p = parseInt(m[1]);
        if (p > 0 && p < 65536) found = p;
      }
      if (found) break;
    }

    if (found && found !== this.detectedPorts.get(projectIndex)) {
      this.detectedPorts.set(projectIndex, found);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('webapp-port-detected', { projectIndex, port: found });
      }
    }
  }

  /**
   * Auto-detect dev command from package.json
   */
  _autoDetectCommand(projectPath) {
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (!fs.existsSync(pkgPath)) return null;

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const pm = this._detectPackageManager(projectPath);

      if (pkg.scripts?.dev) return `${pm} run dev`;
      if (pkg.scripts?.start) return `${pm} start`;
      if (pkg.scripts?.serve) return `${pm} run serve`;
      return null;
    } catch (e) {
      return null;
    }
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
   * Detect framework from package.json
   */
  detectFramework(projectPath) {
    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (!fs.existsSync(pkgPath)) return null;

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['next']) return { name: 'Next.js', icon: 'next' };
      if (deps['vite'] && deps['react']) return { name: 'React + Vite', icon: 'react' };
      if (deps['vite'] && deps['vue']) return { name: 'Vue + Vite', icon: 'vue' };
      if (deps['vite'] && deps['svelte']) return { name: 'Svelte + Vite', icon: 'svelte' };
      if (deps['vite']) return { name: 'Vite', icon: 'vite' };
      if (deps['react-scripts']) return { name: 'Create React App', icon: 'react' };
      if (deps['@angular/core']) return { name: 'Angular', icon: 'angular' };
      if (deps['nuxt']) return { name: 'Nuxt', icon: 'nuxt' };
      if (deps['@sveltejs/kit']) return { name: 'SvelteKit', icon: 'svelte' };
      if (deps['astro']) return { name: 'Astro', icon: 'astro' };
      if (deps['gatsby']) return { name: 'Gatsby', icon: 'gatsby' };
      if (deps['vue']) return { name: 'Vue', icon: 'vue' };
      if (deps['react']) return { name: 'React', icon: 'react' };
      if (deps['express']) return { name: 'Express', icon: 'node' };
      if (deps['fastify']) return { name: 'Fastify', icon: 'node' };
      if (deps['koa']) return { name: 'Koa', icon: 'node' };

      return { name: 'Node.js', icon: 'node' };
    } catch (e) {
      return null;
    }
  }

  getDetectedPort(projectIndex) {
    return this.detectedPorts.get(projectIndex) || null;
  }

  isRunning(projectIndex) {
    return this.processes.has(projectIndex);
  }

  stopAll() {
    this.processes.forEach((proc, index) => {
      const pid = proc.pid;
      try {
        proc.write('\x03');
        setTimeout(() => this._forceKill(pid), 2000);
      } catch (e) {
        this._forceKill(pid);
      }
    });
    this.processes.clear();
    this.detectedPorts.clear();
  }

  count() {
    return this.processes.size;
  }
}

const webAppService = new WebAppService();
module.exports = webAppService;
