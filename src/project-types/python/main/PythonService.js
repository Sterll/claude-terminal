/**
 * Python Service
 * Detects Python environment info (version, venv, deps, entry point)
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

class PythonService {
  /**
   * Detect Python environment info for a project
   * @param {string} projectPath
   * @returns {Object} { pythonVersion, venvPath, projectType, dependencies, mainEntry }
   */
  detectInfo(projectPath) {
    const result = {
      pythonVersion: null,
      venvPath: null,
      projectType: null,
      dependencies: 0,
      mainEntry: null
    };

    result.pythonVersion = this._detectVersion(projectPath);
    result.venvPath = this._detectVenv(projectPath);
    result.projectType = this._detectProjectType(projectPath);
    result.dependencies = this._countDependencies(projectPath, result.projectType);
    result.mainEntry = this._detectEntryPoint(projectPath);

    return result;
  }

  /**
   * Detect Python version
   */
  _detectVersion(projectPath) {
    const commands = ['python --version', 'python3 --version', 'py --version'];
    for (const cmd of commands) {
      try {
        const output = execSync(cmd, {
          cwd: projectPath,
          timeout: 5000,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
        const match = output.match(/Python\s+([\d.]+)/i);
        if (match) return match[1];
      } catch (e) {
        // Try next command
      }
    }
    return null;
  }

  /**
   * Detect virtual environment
   */
  _detectVenv(projectPath) {
    const candidates = ['.venv', 'venv', 'env'];
    for (const dir of candidates) {
      const venvDir = path.join(projectPath, dir);
      const cfgPath = path.join(venvDir, 'pyvenv.cfg');
      if (fs.existsSync(cfgPath)) {
        return dir;
      }
    }
    return null;
  }

  /**
   * Detect project type / package manager
   */
  _detectProjectType(projectPath) {
    if (fs.existsSync(path.join(projectPath, 'pyproject.toml'))) {
      try {
        const content = fs.readFileSync(path.join(projectPath, 'pyproject.toml'), 'utf8');
        if (content.includes('[tool.poetry]')) return 'poetry';
        if (content.includes('[tool.hatch]')) return 'hatch';
        if (content.includes('[build-system]')) return 'pyproject';
      } catch (e) {}
      return 'pyproject';
    }
    if (fs.existsSync(path.join(projectPath, 'Pipfile'))) return 'pipenv';
    if (fs.existsSync(path.join(projectPath, 'requirements.txt'))) return 'pip';
    if (fs.existsSync(path.join(projectPath, 'setup.py'))) return 'setuptools';
    return null;
  }

  /**
   * Count dependencies
   */
  _countDependencies(projectPath, projectType) {
    try {
      if (projectType === 'pip' || !projectType) {
        const reqPath = path.join(projectPath, 'requirements.txt');
        if (fs.existsSync(reqPath)) {
          const lines = fs.readFileSync(reqPath, 'utf8').split('\n');
          return lines.filter(l => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('-')).length;
        }
      }
      if (projectType === 'poetry' || projectType === 'pyproject' || projectType === 'hatch') {
        const tomlPath = path.join(projectPath, 'pyproject.toml');
        if (fs.existsSync(tomlPath)) {
          const content = fs.readFileSync(tomlPath, 'utf8');
          // Count lines in [project.dependencies] or [tool.poetry.dependencies]
          const depsMatch = content.match(/\[(?:project\.dependencies|tool\.poetry\.dependencies)\]([\s\S]*?)(?:\[|$)/);
          if (depsMatch) {
            const lines = depsMatch[1].split('\n');
            return lines.filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('=')).length;
          }
          // Fallback: count dependencies array
          const arrayMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
          if (arrayMatch) {
            const items = arrayMatch[1].split('\n');
            return items.filter(l => l.trim() && l.includes('"')).length;
          }
        }
      }
      if (projectType === 'pipenv') {
        const pipfilePath = path.join(projectPath, 'Pipfile');
        if (fs.existsSync(pipfilePath)) {
          const content = fs.readFileSync(pipfilePath, 'utf8');
          const packagesMatch = content.match(/\[packages\]([\s\S]*?)(?:\[|$)/);
          if (packagesMatch) {
            const lines = packagesMatch[1].split('\n');
            return lines.filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('=')).length;
          }
        }
      }
    } catch (e) {}
    return 0;
  }

  /**
   * Detect main entry point
   */
  _detectEntryPoint(projectPath) {
    const candidates = ['main.py', 'app.py', 'run.py', 'manage.py', '__main__.py', 'cli.py'];
    for (const file of candidates) {
      if (fs.existsSync(path.join(projectPath, file))) {
        return file;
      }
    }
    // Check src/ directory
    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir)) {
      for (const file of ['main.py', '__main__.py', 'app.py']) {
        if (fs.existsSync(path.join(srcDir, file))) {
          return `src/${file}`;
        }
      }
    }
    return null;
  }
}

const pythonService = new PythonService();
module.exports = pythonService;
