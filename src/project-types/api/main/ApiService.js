/**
 * API Service
 * Manages backend/API server processes (Node.js + Python frameworks)
 */

const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { exec } = require('child_process');

// Port detection patterns from server output
const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/,
  /(?:listening|running|started|ready|serving)\s+(?:on|at)\s+(?:port\s+)?(\d+)/i,
  /port\s+(\d+)/i,
  /Uvicorn running on .+:(\d+)/i,
  /Development server.*?:(\d+)/i
];

class ApiService {
  constructor() {
    this.processes = new Map(); // projectIndex -> pty process
    this.detectedPorts = new Map(); // projectIndex -> port number
    this.outputBuffers = new Map(); // projectIndex -> accumulated output for port detection
    this.mainWindow = null;
  }

  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * Start an API server
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
    this.outputBuffers.set(projectIndex, '');

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
      this._detectPort(projectIndex, data);

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('api-data', { projectIndex, data });
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.processes.delete(projectIndex);
      this.detectedPorts.delete(projectIndex);
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('api-exit', { projectIndex, code: exitCode });
      }
    });

    return { success: true, command };
  }

  /**
   * Stop an API server
   */
  stop({ projectIndex }) {
    const proc = this.processes.get(projectIndex);
    if (proc) {
      const pid = proc.pid;
      try {
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
    this.outputBuffers.delete(projectIndex);
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
   * Detect port from server output
   */
  _detectPort(projectIndex, data) {
    if (this.detectedPorts.has(projectIndex)) return;

    let buffer = (this.outputBuffers.get(projectIndex) || '') + data;
    const clean = buffer.replace(/\x1b[\[\]()#;?]*[0-9;]*[a-zA-Z@]/g, '');

    if (buffer.length > 2048) buffer = buffer.slice(-2048);
    this.outputBuffers.set(projectIndex, buffer);

    for (const pattern of PORT_PATTERNS) {
      const match = clean.match(pattern);
      if (match) {
        const port = parseInt(match[1]);
        if (port > 0 && port < 65536) {
          this.detectedPorts.set(projectIndex, port);
          this.outputBuffers.delete(projectIndex);
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('api-port-detected', { projectIndex, port });
          }
          break;
        }
      }
    }
  }

  /**
   * Auto-detect dev command
   */
  _autoDetectCommand(projectPath) {
    // Try Node.js first
    const nodeCmd = this._detectNodeCommand(projectPath);
    if (nodeCmd) return nodeCmd;

    // Try Python
    const pyCmd = this._detectPythonCommand(projectPath);
    if (pyCmd) return pyCmd;

    return null;
  }

  _detectNodeCommand(projectPath) {
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

  _detectPythonCommand(projectPath) {
    try {
      // Django
      if (fs.existsSync(path.join(projectPath, 'manage.py'))) {
        return 'python manage.py runserver';
      }
      // FastAPI (check for uvicorn in requirements or imports)
      const reqPath = path.join(projectPath, 'requirements.txt');
      if (fs.existsSync(reqPath)) {
        const reqs = fs.readFileSync(reqPath, 'utf8');
        if (reqs.includes('fastapi') || reqs.includes('uvicorn')) {
          // Try to find the app module
          if (fs.existsSync(path.join(projectPath, 'main.py'))) {
            return 'uvicorn main:app --reload';
          }
          if (fs.existsSync(path.join(projectPath, 'app.py'))) {
            return 'uvicorn app:app --reload';
          }
          return 'uvicorn main:app --reload';
        }
        if (reqs.includes('flask')) {
          if (fs.existsSync(path.join(projectPath, 'app.py'))) {
            return 'flask --app app run --debug';
          }
          return 'flask run --debug';
        }
      }
      // pyproject.toml check
      const tomlPath = path.join(projectPath, 'pyproject.toml');
      if (fs.existsSync(tomlPath)) {
        const toml = fs.readFileSync(tomlPath, 'utf8');
        if (toml.includes('fastapi') || toml.includes('uvicorn')) {
          return 'uvicorn main:app --reload';
        }
        if (toml.includes('flask')) {
          return 'flask run --debug';
        }
        if (toml.includes('django')) {
          return 'python manage.py runserver';
        }
      }
    } catch (e) {}
    return null;
  }

  _detectPackageManager(projectPath) {
    if (fs.existsSync(path.join(projectPath, 'bun.lockb'))) return 'bun';
    if (fs.existsSync(path.join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectPath, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  /**
   * Detect API framework
   */
  detectFramework(projectPath) {
    try {
      // Check Node.js frameworks first
      const pkgPath = path.join(projectPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (deps['express']) return { name: 'Express', icon: 'express' };
        if (deps['fastify']) return { name: 'Fastify', icon: 'fastify' };
        if (deps['@nestjs/core']) return { name: 'NestJS', icon: 'nestjs' };
        if (deps['hono']) return { name: 'Hono', icon: 'hono' };
        if (deps['koa']) return { name: 'Koa', icon: 'koa' };
        if (deps['@hapi/hapi']) return { name: 'Hapi', icon: 'hapi' };
        if (deps['next']) return { name: 'Next.js API', icon: 'next' };
      }

      // Check Python frameworks
      const reqPath = path.join(projectPath, 'requirements.txt');
      const tomlPath = path.join(projectPath, 'pyproject.toml');
      let pythonDeps = '';

      if (fs.existsSync(reqPath)) {
        pythonDeps += fs.readFileSync(reqPath, 'utf8');
      }
      if (fs.existsSync(tomlPath)) {
        pythonDeps += fs.readFileSync(tomlPath, 'utf8');
      }

      if (pythonDeps) {
        if (pythonDeps.includes('fastapi')) return { name: 'FastAPI', icon: 'fastapi' };
        if (pythonDeps.includes('django')) return { name: 'Django', icon: 'django' };
        if (pythonDeps.includes('flask')) return { name: 'Flask', icon: 'flask' };
        if (pythonDeps.includes('starlette')) return { name: 'Starlette', icon: 'starlette' };
        if (pythonDeps.includes('tornado')) return { name: 'Tornado', icon: 'tornado' };
      }

      // Check manage.py for Django
      if (fs.existsSync(path.join(projectPath, 'manage.py'))) {
        return { name: 'Django', icon: 'django' };
      }

      return null;
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
    this.outputBuffers.clear();
  }

  count() {
    return this.processes.size;
  }
}

const apiService = new ApiService();
module.exports = apiService;
