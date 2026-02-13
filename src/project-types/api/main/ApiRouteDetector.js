/**
 * API Route Detector
 * Scans project source files to auto-detect API routes/endpoints.
 *
 * Strategy:
 * 1. Detect framework from project files
 * 2. If framework has a native CLI command → run it, parse output
 * 3. Fallback to static analysis (regex-based) for unsupported frameworks
 * 4. Deduplicate & sort
 *
 * Native CLI support:
 * - Flask:    flask routes
 * - Django:   python manage.py show_urls (django-extensions)
 * - Laravel:  php artisan route:list --json
 * - Rails:    rails routes
 * - Fastify:  (static analysis only)
 * - Express:  (static analysis only)
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const SKIP_DIRS = new Set([
  'node_modules', '.venv', 'venv', 'env', '__pycache__', '.git',
  '.next', '.nuxt', 'dist', 'build', '.tox', '.mypy_cache', '.pytest_cache',
  'migrations', 'static', 'templates', 'public', 'assets', 'coverage',
  '.turbo', '.cache', 'tmp', 'temp', '.parcel-cache', '.svelte-kit'
]);

const JS_EXTS = new Set(['.js', '.ts', '.mjs', '.cjs']);
const PY_EXTS = new Set(['.py']);
const PHP_EXTS = new Set(['.php']);
const RB_EXTS = new Set(['.rb']);
const JAVA_EXTS = new Set(['.java', '.kt']);
const ALL_EXTS = new Set([...JS_EXTS, ...PY_EXTS, ...PHP_EXTS, ...RB_EXTS, ...JAVA_EXTS]);
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

class ApiRouteDetector {

  /**
   * Main entry point — async to support native CLI commands
   */
  async detectRoutes(projectPath) {
    // Step 1: detect framework
    const framework = this._detectFramework(projectPath);

    // Step 2: try native CLI route listing
    let routes = null;
    if (framework) {
      try {
        routes = this._tryNativeDetection(projectPath, framework);
      } catch (_) {
        // Native failed, will fallback
      }
    }

    // Step 3: fallback to static analysis
    if (!routes || routes.length === 0) {
      routes = this._staticAnalysis(projectPath);
    }

    // Step 4: deduplicate & sort
    return this._deduplicateAndSort(routes);
  }

  // ═══════════════════════════════════════════════
  //  Framework detection
  // ═══════════════════════════════════════════════

  _detectFramework(projectPath) {
    // Node.js
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['express']) return 'express';
      if (deps['fastify']) return 'fastify';
      if (deps['@nestjs/core']) return 'nestjs';
      if (deps['hono']) return 'hono';
      if (deps['koa']) return 'koa';
    } catch (_) {}

    // Python
    let pyDeps = '';
    try { pyDeps += fs.readFileSync(path.join(projectPath, 'requirements.txt'), 'utf8'); } catch (_) {}
    try { pyDeps += fs.readFileSync(path.join(projectPath, 'pyproject.toml'), 'utf8'); } catch (_) {}
    try { pyDeps += fs.readFileSync(path.join(projectPath, 'Pipfile'), 'utf8'); } catch (_) {}

    if (pyDeps) {
      if (/\bflask\b/i.test(pyDeps)) return 'flask';
      if (/\bdjango\b/i.test(pyDeps)) return 'django';
      if (/\bfastapi\b/i.test(pyDeps)) return 'fastapi';
    }
    if (fs.existsSync(path.join(projectPath, 'manage.py'))) return 'django';

    // PHP / Laravel
    if (fs.existsSync(path.join(projectPath, 'artisan'))) return 'laravel';
    try {
      const composer = JSON.parse(fs.readFileSync(path.join(projectPath, 'composer.json'), 'utf8'));
      const req = { ...composer.require, ...composer['require-dev'] };
      if (req['laravel/framework']) return 'laravel';
    } catch (_) {}

    // Ruby / Rails
    if (fs.existsSync(path.join(projectPath, 'Gemfile'))) {
      try {
        const gemfile = fs.readFileSync(path.join(projectPath, 'Gemfile'), 'utf8');
        if (gemfile.includes('rails')) return 'rails';
        if (gemfile.includes('sinatra')) return 'sinatra';
      } catch (_) {}
    }

    // Java / Spring Boot
    if (fs.existsSync(path.join(projectPath, 'pom.xml'))) {
      try {
        const pom = fs.readFileSync(path.join(projectPath, 'pom.xml'), 'utf8');
        if (pom.includes('spring-boot')) return 'spring';
      } catch (_) {}
    }
    if (fs.existsSync(path.join(projectPath, 'build.gradle')) || fs.existsSync(path.join(projectPath, 'build.gradle.kts'))) {
      try {
        const gradle = fs.readFileSync(
          fs.existsSync(path.join(projectPath, 'build.gradle'))
            ? path.join(projectPath, 'build.gradle')
            : path.join(projectPath, 'build.gradle.kts'),
          'utf8'
        );
        if (gradle.includes('spring-boot')) return 'spring';
      } catch (_) {}
    }

    return null;
  }

  // ═══════════════════════════════════════════════
  //  Native CLI detection
  // ═══════════════════════════════════════════════

  _tryNativeDetection(projectPath, framework) {
    switch (framework) {
      case 'flask': return this._nativeFlask(projectPath);
      case 'django': return this._nativeDjango(projectPath);
      case 'laravel': return this._nativeLaravel(projectPath);
      case 'rails': return this._nativeRails(projectPath);
      default: return null;
    }
  }

  _exec(cmd, cwd) {
    return execSync(cmd, {
      cwd,
      timeout: 15000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      windowsHide: true
    });
  }

  /**
   * Flask: `flask routes` outputs a table like:
   * Endpoint  Methods  Rule
   * --------  -------  ----
   * index     GET      /
   * users     GET      /api/users
   */
  _nativeFlask(projectPath) {
    // Find the Flask app file for FLASK_APP env
    let flaskApp = null;
    for (const candidate of ['app.py', 'wsgi.py', 'run.py', 'main.py', 'application.py']) {
      if (fs.existsSync(path.join(projectPath, candidate))) {
        flaskApp = candidate.replace('.py', '');
        break;
      }
    }
    // Check for app factory in __init__.py
    if (!flaskApp && fs.existsSync(path.join(projectPath, 'app', '__init__.py'))) {
      flaskApp = 'app';
    }
    if (!flaskApp) return null;

    // Determine python command
    const pythonCmd = this._findPython(projectPath);
    const env = { ...process.env, FLASK_APP: flaskApp, PYTHONDONTWRITEBYTECODE: '1' };

    const output = execSync(`${pythonCmd} -m flask routes`, {
      cwd: projectPath, timeout: 15000, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true
    });

    return this._parseFlaskOutput(output);
  }

  _parseFlaskOutput(output) {
    const routes = [];
    const lines = output.split('\n');
    // Skip header lines (Endpoint, dashes)
    let started = false;
    for (const line of lines) {
      if (line.includes('---')) { started = true; continue; }
      if (!started || !line.trim()) continue;

      // Format: "endpoint_name  GET, POST  /path/here"
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 3) {
        const handler = parts[0];
        const methods = parts[1].split(',').map(m => m.trim().toUpperCase()).filter(m => m && m !== 'HEAD' && m !== 'OPTIONS');
        const routePath = parts[2];

        if (routePath === '/static/<path:filename>') continue;

        for (const method of (methods.length ? methods : ['GET'])) {
          routes.push({ method, path: routePath, handler, file: 'flask routes', line: 0 });
        }
      }
    }
    return routes;
  }

  /**
   * Django: `python manage.py show_urls` (django-extensions) outputs:
   * /api/users/  users.views.UserListView  users:user-list
   * Or fallback: parse urls.py statically
   */
  _nativeDjango(projectPath) {
    if (!fs.existsSync(path.join(projectPath, 'manage.py'))) return null;

    const pythonCmd = this._findPython(projectPath);
    try {
      const output = this._exec(`${pythonCmd} manage.py show_urls --format=aligned`, projectPath);
      return this._parseDjangoOutput(output);
    } catch (_) {
      // django-extensions not installed, fallback to static
      return null;
    }
  }

  _parseDjangoOutput(output) {
    const routes = [];
    for (const line of output.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      // Format: /path/  view_module.ViewClass  url-name
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 2 && parts[0].startsWith('/')) {
        const routePath = parts[0].replace(/\/$/, '') || '/';
        const handler = parts[1].split('.').pop();
        routes.push({ method: 'ALL', path: routePath, handler, file: 'django show_urls', line: 0 });
      }
    }
    return routes;
  }

  /**
   * Laravel: `php artisan route:list --json`
   */
  _nativeLaravel(projectPath) {
    if (!fs.existsSync(path.join(projectPath, 'artisan'))) return null;

    try {
      const output = this._exec('php artisan route:list --json', projectPath);
      const data = JSON.parse(output);
      return this._parseLaravelOutput(data);
    } catch (_) {
      return null;
    }
  }

  _parseLaravelOutput(data) {
    const routes = [];
    for (const r of data) {
      const methods = (r.method || 'GET').split('|').filter(m => m && m !== 'HEAD');
      const uri = '/' + (r.uri || '').replace(/^\//, '');
      const handler = r.action ? r.action.split('@').pop().split('\\').pop() : '';

      if (uri.includes('_ignition') || uri.includes('sanctum')) continue;

      for (const method of methods) {
        routes.push({ method: method.toUpperCase(), path: uri, handler, file: 'artisan route:list', line: 0 });
      }
    }
    return routes;
  }

  /**
   * Rails: `rails routes` or `bundle exec rails routes`
   */
  _nativeRails(projectPath) {
    if (!fs.existsSync(path.join(projectPath, 'Gemfile'))) return null;

    let output;
    try {
      output = this._exec('bundle exec rails routes --expanded', projectPath);
    } catch (_) {
      try {
        output = this._exec('rails routes --expanded', projectPath);
      } catch (_2) {
        return null;
      }
    }
    return this._parseRailsOutput(output);
  }

  _parseRailsOutput(output) {
    const routes = [];
    // Expanded format:
    //  --[ Route 1 ]--
    // Prefix     | users
    // Verb       | GET
    // URI        | /users(.:format)
    // Controller#Action | users#index

    let current = {};
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('--[')) {
        if (current.path && current.method) {
          routes.push({ method: current.method, path: current.path, handler: current.handler || '', file: 'rails routes', line: 0 });
        }
        current = {};
        continue;
      }
      const kv = trimmed.match(/^(\w[\w#]*)\s*\|\s*(.+)/);
      if (kv) {
        const key = kv[1].trim().toLowerCase();
        const val = kv[2].trim();
        if (key === 'verb') current.method = val.toUpperCase() || 'GET';
        if (key === 'uri') current.path = val.replace(/\(.*\)/, '').replace(/\/$/, '') || '/';
        if (key.includes('controller')) current.handler = val.split('#').pop();
      }
    }
    // Last route
    if (current.path && current.method) {
      routes.push({ method: current.method, path: current.path, handler: current.handler || '', file: 'rails routes', line: 0 });
    }

    return routes;
  }

  _findPython(projectPath) {
    // Check for venv
    for (const venvDir of ['.venv', 'venv', 'env']) {
      const venvPython = path.join(projectPath, venvDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
      if (fs.existsSync(venvPython)) return `"${venvPython}"`;
    }
    return 'python';
  }

  // ═══════════════════════════════════════════════
  //  Static analysis (fallback)
  // ═══════════════════════════════════════════════

  _staticAnalysis(projectPath) {
    const files = this._collectFiles(projectPath, 0);
    const vars = new Map();
    const imports = new Map();
    const mounts = [];
    const fileContents = new Map();

    // Phase 1: read all files and extract variables
    for (const absPath of files) {
      try {
        const content = fs.readFileSync(absPath, 'utf8');
        const relPath = path.relative(projectPath, absPath).replace(/\\/g, '/');
        fileContents.set(relPath, content);

        const ext = path.extname(absPath).toLowerCase();
        if (JS_EXTS.has(ext)) {
          this._extractVars(content, vars);
          this._extractImports(content, relPath, imports);
        }
      } catch (_) {}
    }

    // Phase 2: extract mounts (vars are already populated from all files)
    for (const [relPath, content] of fileContents) {
      const ext = path.extname(relPath).toLowerCase();
      if (JS_EXTS.has(ext)) {
        this._extractMounts(content, relPath, mounts, vars);
      }
    }

    const filePrefixMap = this._buildFilePrefixMap(imports, mounts, vars, fileContents);

    const routes = [];
    for (const [relPath, content] of fileContents) {
      try {
        const ext = path.extname(relPath).toLowerCase();
        const prefix = filePrefixMap.get(this._stripExt(relPath)) || '';
        if (JS_EXTS.has(ext)) {
          routes.push(...this._parseJsRoutes(content, relPath, vars, prefix));
        } else if (PY_EXTS.has(ext)) {
          routes.push(...this._parsePyRoutes(content, relPath, vars, prefix));
        } else if (PHP_EXTS.has(ext)) {
          routes.push(...this._parsePhpRoutes(content, relPath));
        } else if (RB_EXTS.has(ext)) {
          routes.push(...this._parseRubyRoutes(content, relPath));
        } else if (JAVA_EXTS.has(ext)) {
          routes.push(...this._parseJavaRoutes(content, relPath));
        }
      } catch (_) {}
    }

    return routes;
  }

  // ═══════════════════════════════════════════════
  //  File collection
  // ═══════════════════════════════════════════════

  _collectFiles(dir, depth) {
    if (depth > 8) return [];
    const files = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) files.push(...this._collectFiles(full, depth + 1));
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (ALL_EXTS.has(ext)) files.push(full);
        }
      }
    } catch (_) {}
    return files;
  }

  // ═══════════════════════════════════════════════
  //  Extract metadata (JS/TS)
  // ═══════════════════════════════════════════════

  _extractVars(content, vars) {
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;

      // Pattern 1: const x = 'value'  or  const x = "value"
      const m = t.match(/(?:const|let|var)\s+(\w+)\s*=\s*['"]([^'"]*)['"]\s*[;,]?\s*$/);
      if (m) { vars.set(m[1], m[2]); continue; }

      // Pattern 2: const x = `value` (template literal without interpolation)
      const m2 = t.match(/(?:const|let|var)\s+(\w+)\s*=\s*`([^`$]*)`/);
      if (m2) { vars.set(m2[1], m2[2]); continue; }

      // Pattern 3: const x = process.env.X || 'fallback'  or  ?? 'fallback'
      const m3 = t.match(/(?:const|let|var)\s+(\w+)\s*=\s*.+?(?:\|\||[?][?])\s*['"]([^'"]*)['"]/);
      if (m3) { vars.set(m3[1], m3[2]); continue; }

      // Pattern 4: const x = process.env.X || `fallback`
      const m3b = t.match(/(?:const|let|var)\s+(\w+)\s*=\s*.+?(?:\|\||[?][?])\s*`([^`$]*)`/);
      if (m3b) { vars.set(m3b[1], m3b[2]); continue; }

      // Pattern 5: exports.x = 'value'  or  module.exports.x = 'value'
      const m4 = t.match(/(?:module\.)?exports\.(\w+)\s*=\s*['"]([^'"]*)['"]/);
      if (m4) { vars.set(m4[1], m4[2]); continue; }

      // Pattern 6: x: 'value' (object property, e.g. in config objects)
      const m5 = t.match(/^(\w+)\s*:\s*['"]([^'"]+)['"]\s*[,}]?\s*$/);
      if (m5) { vars.set(m5[1], m5[2]); continue; }

      // Pattern 7: const x = 'a' + 'b'  (string concatenation)
      const m6 = t.match(/(?:const|let|var)\s+(\w+)\s*=\s*((?:['"][^'"]*['"]\s*\+\s*)+['"][^'"]*['"])/);
      if (m6) {
        const val = m6[2].replace(/['"]\s*\+\s*['"]/g, '').replace(/^['"]|['"]$/g, '');
        vars.set(m6[1], val);
        continue;
      }

      // Pattern 8: Simple assignment (no const/let/var) — x = 'value'
      const m7 = t.match(/^(\w+)\s*=\s*['"]([^'"]*)['"]\s*[;,]?\s*$/);
      if (m7 && /^[a-z]/.test(m7[1])) { vars.set(m7[1], m7[2]); }
    }
  }

  _extractImports(content, currentFile, imports) {
    const dir = path.dirname(currentFile);
    for (const line of content.split('\n')) {
      const t = line.trim();

      const req = t.match(/(?:const|let|var)\s+(?:\{[^}]*\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (req && req[2].startsWith('.')) {
        const resolved = path.posix.normalize(dir + '/' + req[2]).replace(/\\/g, '/');
        if (req[1]) {
          imports.set(req[1], this._stripExt(resolved));
        } else {
          const names = t.match(/\{([^}]+)\}/);
          if (names) {
            for (const n of names[1].split(',')) {
              const clean = n.trim().split(/\s+as\s+/).pop().trim();
              if (clean) imports.set(clean, this._stripExt(resolved));
            }
          }
        }
      }

      const imp = t.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
      if (imp && imp[2].startsWith('.')) {
        imports.set(imp[1], this._stripExt(path.posix.normalize(dir + '/' + imp[2]).replace(/\\/g, '/')));
      }

      const impD = t.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
      if (impD && impD[2].startsWith('.')) {
        const resolved = this._stripExt(path.posix.normalize(dir + '/' + impD[2]).replace(/\\/g, '/'));
        for (const n of impD[1].split(',')) {
          const clean = n.trim().split(/\s+as\s+/).pop().trim();
          if (clean) imports.set(clean, resolved);
        }
      }
    }
  }

  _extractMounts(content, filePath, mounts, vars) {
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('/*')) continue;

      // app.use('/prefix', router)  — string literal prefix
      const m1 = t.match(/(\w+)\.use\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*(\w+)/);
      if (m1) {
        mounts.push({ prefix: this._resolveStr(m1[3], vars).replace(/\/$/, ''), varName: m1[4], file: filePath });
        continue;
      }

      // app.use(`${varName}`, router) or app.use(`${varName}/sub`, router) — template literal prefix
      const m1b = t.match(/(\w+)\.use\s*\(\s*`([^`]+)`\s*,\s*(\w+)/);
      if (m1b) {
        mounts.push({ prefix: this._resolveStr(m1b[2], vars).replace(/\/$/, ''), varName: m1b[3], file: filePath });
        continue;
      }

      // app.use(varName, router) or app.use(obj.prop, router) — variable/property prefix
      const m2 = t.match(/(\w+)\.use\s*\(\s*([\w.]+)\s*,\s*(\w+)\s*\)/);
      if (m2 && !['require', 'express', 'app', 'router', 'true', 'false'].includes(m2[2])) {
        let prefixVal = null;
        const prefixExpr = m2[2];

        // Direct variable: app.use(apiPrefix, router)
        if (vars.has(prefixExpr)) {
          prefixVal = vars.get(prefixExpr);
        }
        // Property access: app.use(config.apiPrefix, router) → look up 'apiPrefix' in vars
        else if (prefixExpr.includes('.')) {
          const propName = prefixExpr.split('.').pop();
          if (vars.has(propName)) prefixVal = vars.get(propName);
        }

        if (prefixVal) {
          mounts.push({ prefix: prefixVal.replace(/\/$/, ''), varName: m2[3], file: filePath });
        } else {
          mounts.push({ prefix: '', prefixVar: prefixExpr, varName: m2[3], file: filePath });
        }
        continue;
      }

      // app.use('/prefix', require('./file'))  — inline require with string literal
      const m3 = t.match(/(\w+)\.use\s*\(\s*(['"`])([^'"`]+)\2\s*,\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (m3 && m3[4].startsWith('.')) {
        const resolved = this._stripExt(path.posix.normalize(path.dirname(filePath) + '/' + m3[4]).replace(/\\/g, '/'));
        mounts.push({ prefix: this._resolveStr(m3[3], vars).replace(/\/$/, ''), resolvedFile: resolved, file: filePath });
        continue;
      }

      // app.use(`${varName}`, require('./file'))  — inline require with template literal
      const m3b = t.match(/(\w+)\.use\s*\(\s*`([^`]+)`\s*,\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (m3b && m3b[3].startsWith('.')) {
        const resolved = this._stripExt(path.posix.normalize(path.dirname(filePath) + '/' + m3b[3]).replace(/\\/g, '/'));
        mounts.push({ prefix: this._resolveStr(m3b[2], vars).replace(/\/$/, ''), resolvedFile: resolved, file: filePath });
        continue;
      }

      // app.use(varName, require('./file'))  — inline require with variable/property
      const m4 = t.match(/(\w+)\.use\s*\(\s*([\w.]+)\s*,\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (m4 && m4[3].startsWith('.')) {
        const resolved = this._stripExt(path.posix.normalize(path.dirname(filePath) + '/' + m4[3]).replace(/\\/g, '/'));
        const prefixExpr = m4[2];
        let prefixVal = vars.has(prefixExpr) ? vars.get(prefixExpr) : null;
        if (!prefixVal && prefixExpr.includes('.')) {
          const propName = prefixExpr.split('.').pop();
          if (vars.has(propName)) prefixVal = vars.get(propName);
        }
        if (prefixVal) {
          mounts.push({ prefix: prefixVal.replace(/\/$/, ''), resolvedFile: resolved, file: filePath });
        } else {
          mounts.push({ prefix: '', prefixVar: prefixExpr, resolvedFile: resolved, file: filePath });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════
  //  Build file → prefix map
  // ═══════════════════════════════════════════════

  _buildFilePrefixMap(imports, mounts, vars, fileContents) {
    const map = new Map();
    for (const mount of mounts) {
      // Resolve prefix if it was stored as a variable reference
      let prefix = mount.prefix;
      if (!prefix && mount.prefixVar) {
        prefix = vars.has(mount.prefixVar) ? vars.get(mount.prefixVar).replace(/\/$/, '') : '';
      }

      let targetFile = mount.resolvedFile || null;

      if (!targetFile && mount.varName) {
        targetFile = imports.get(mount.varName);
        if (!targetFile) {
          const varLower = mount.varName.toLowerCase().replace(/router|routes|route|handler|controller/gi, '');
          for (const [relPath] of fileContents) {
            const fileLower = this._stripExt(relPath).split('/').pop().toLowerCase().replace(/router|routes|route|handler|controller/gi, '');
            if (varLower && fileLower && varLower === fileLower) {
              targetFile = this._stripExt(relPath);
              break;
            }
          }
        }
      }

      if (targetFile && prefix) {
        const existing = map.get(targetFile);
        map.set(targetFile, existing ? existing + prefix : prefix);
        if (!fileContents.has(targetFile + '.js') && !fileContents.has(targetFile + '.ts')) {
          map.set(targetFile + '/index', existing ? existing + prefix : prefix);
        }
      }
    }
    return map;
  }

  // ═══════════════════════════════════════════════
  //  Parse JS/TS routes
  // ═══════════════════════════════════════════════

  _parseJsRoutes(content, filePath, vars, filePrefix) {
    const routes = [];
    const lines = content.split('\n');
    let prefix = filePrefix;

    const ctrl = content.match(/@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/);
    if (ctrl) prefix = this._joinPrefix(prefix, ctrl[1]);

    if (!filePrefix) {
      const inlineUse = content.match(/\.use\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*\w*[Rr]outer\b/);
      if (inlineUse) prefix = this._resolveStr(inlineUse[2], vars).replace(/\/$/, '');
    }

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      for (const method of HTTP_METHODS) {
        // Match: router.get('/path', ...) or router.get("/path", ...) or router.get(`${var}/path`, ...)
        const re = new RegExp(`\\b\\w+\\s*\\.\\s*${method}\\s*\\(\\s*(['"\`])(.+?)\\1`, 'i');
        const m = trimmed.match(re);
        if (m) {
          let raw = this._resolveStr(m[2], vars);
          if (this._looksLikePath(raw)) {
            routes.push({ method: method.toUpperCase(), path: this._normPath(prefix, raw), handler: this._extractHandler(trimmed, lines, i), file: filePath, line: i + 1 });
            continue;
          }
        }

        // Match template literals with expressions: router.get(`${apiPrefix}/path`)
        // The first regex may not capture these if the backtick content contains ${}
        const reTpl = new RegExp(`\\b\\w+\\s*\\.\\s*${method}\\s*\\(\\s*\`([^\`]+)\``, 'i');
        const mTpl = trimmed.match(reTpl);
        if (mTpl && !m) {
          let raw = this._resolveStr(mTpl[1], vars);
          if (this._looksLikePath(raw)) {
            routes.push({ method: method.toUpperCase(), path: this._normPath(prefix, raw), handler: this._extractHandler(trimmed, lines, i), file: filePath, line: i + 1 });
          }
        }
      }

      const allMatch = trimmed.match(/\b\w+\s*\.\s*all\s*\(\s*(['"`])(.+?)\1/i);
      if (allMatch) {
        const raw = this._resolveStr(allMatch[2], vars);
        if (this._looksLikePath(raw)) {
          routes.push({ method: 'ALL', path: this._normPath(prefix, raw), handler: this._extractHandler(trimmed, lines, i), file: filePath, line: i + 1 });
        }
      }

      if (/\.route\s*\(\s*\{/.test(trimmed)) {
        const block = lines.slice(i, Math.min(i + 15, lines.length)).join(' ');
        const mm = block.match(/method\s*:\s*['"](\w+)['"]/i);
        const uu = block.match(/url\s*:\s*['"`]([^'"`]+)['"`]/);
        if (mm && uu) {
          routes.push({ method: mm[1].toUpperCase(), path: this._normPath(prefix, this._resolveStr(uu[1], vars)), handler: this._extractBlockHandler(block), file: filePath, line: i + 1 });
        }
      }

      const chain = trimmed.match(/\.route\s*\(\s*(['"`])([^'"`]+)\1\s*\)/);
      if (chain) {
        const rp = this._normPath(prefix, this._resolveStr(chain[2], vars));
        const block = lines.slice(i, Math.min(i + 15, lines.length)).join(' ');
        for (const method of HTTP_METHODS) {
          if (new RegExp(`\\.${method}\\s*\\(`).test(block)) {
            routes.push({ method: method.toUpperCase(), path: rp, handler: 'chained', file: filePath, line: i + 1 });
          }
        }
      }

      const nest = trimmed.match(/@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/);
      if (nest) {
        routes.push({ method: nest[1].toUpperCase(), path: this._normPath(prefix, nest[2] || ''), handler: this._findNextFunction(lines, i + 1), file: filePath, line: i + 1 });
      }

      const hono = trimmed.match(/\.on\s*\(\s*(?:\[([^\]]+)\]|['"](\w+)['"])\s*,\s*['"`]([^'"`]+)['"`]/);
      if (hono) {
        const raw = this._resolveStr(hono[3], vars);
        const methods = hono[1]
          ? (hono[1].match(/['"](\w+)['"]/g) || []).map(m => m.replace(/['"]/g, '').toUpperCase())
          : [hono[2].toUpperCase()];
        for (const m of methods) {
          routes.push({ method: m, path: this._normPath(prefix, raw), handler: this._extractHandler(trimmed, lines, i), file: filePath, line: i + 1 });
        }
      }
    }
    return routes;
  }

  // ═══════════════════════════════════════════════
  //  Parse Python routes
  // ═══════════════════════════════════════════════

  _parsePyRoutes(content, filePath, vars, filePrefix) {
    const routes = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const m = line.trim().match(/^(\w+)\s*=\s*['"]([^'"]+)['"]/);
      if (m) vars.set(m[1], m[2]);
    }

    let prefix = filePrefix;
    const bp = content.match(/(?:Blueprint|APIRouter)\s*\([^)]*(?:url_)?prefix\s*=\s*['"]([^'"]+)['"]/);
    if (bp) prefix = this._joinPrefix(prefix, bp[1]);

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('#')) continue;

      const fast = trimmed.match(/@\w+\.(get|post|put|patch|delete|head|options|api_route)\s*\(\s*['"]([^'"]+)['"]/i);
      if (fast) {
        routes.push({ method: fast[1] === 'api_route' ? 'ALL' : fast[1].toUpperCase(), path: this._normPath(prefix, fast[2]), handler: this._findNextDef(lines, i + 1), file: filePath, line: i + 1 });
        continue;
      }

      const flask = trimmed.match(/@\w+\.route\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*methods\s*=\s*\[([^\]]*)\])?/i);
      if (flask) {
        const rp = this._normPath(prefix, flask[1]);
        const handler = this._findNextDef(lines, i + 1);
        const methods = flask[2] ? (flask[2].match(/['"](\w+)['"]/g) || ["'GET'"]).map(m => m.replace(/['"]/g, '').toUpperCase()) : ['GET'];
        for (const m of methods) routes.push({ method: m, path: rp, handler, file: filePath, line: i + 1 });
        continue;
      }

      const dj = trimmed.match(/(?:re_)?path\s*\(\s*['"]([^'"]*)['"]\s*,\s*(\w[\w.]*)/);
      if (dj) {
        routes.push({ method: 'ALL', path: this._normPath(prefix, '/' + dj[1].replace(/^\^|\/$/g, '')), handler: dj[2].split('.').pop(), file: filePath, line: i + 1 });
      }
    }
    return routes;
  }

  // ═══════════════════════════════════════════════
  //  Parse PHP routes (Laravel-style static)
  // ═══════════════════════════════════════════════

  _parsePhpRoutes(content, filePath) {
    const routes = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

      // Route::get('/path', ...) or Route::post('/path', ...)
      const m = trimmed.match(/Route\s*::\s*(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]/i);
      if (m) {
        const method = m[1].toLowerCase() === 'any' ? 'ALL' : m[1].toUpperCase();
        // Try to extract controller method
        let handler = '';
        const ctrlMatch = trimmed.match(/\[([^,\]]+),\s*['"](\w+)['"]\]/);
        if (ctrlMatch) handler = ctrlMatch[2];
        else {
          const fnMatch = trimmed.match(/function\s*\(/);
          if (fnMatch) handler = 'closure';
        }
        routes.push({ method, path: m[2].startsWith('/') ? m[2] : '/' + m[2], handler, file: filePath, line: i + 1 });
      }

      // Route::match(['GET', 'POST'], '/path', ...)
      const matchRoute = trimmed.match(/Route\s*::\s*match\s*\(\s*\[([^\]]+)\]\s*,\s*['"]([^'"]+)['"]/i);
      if (matchRoute) {
        const methods = matchRoute[1].match(/['"](\w+)['"]/g) || [];
        for (const method of methods) {
          routes.push({ method: method.replace(/['"]/g, '').toUpperCase(), path: matchRoute[2].startsWith('/') ? matchRoute[2] : '/' + matchRoute[2], handler: '', file: filePath, line: i + 1 });
        }
      }

      // Route::resource('/path', Controller)
      const resource = trimmed.match(/Route\s*::\s*(resource|apiResource)\s*\(\s*['"]([^'"]+)['"]/i);
      if (resource) {
        const base = resource[2].startsWith('/') ? resource[2] : '/' + resource[2];
        const isApi = resource[1] === 'apiResource';
        routes.push({ method: 'GET', path: base, handler: 'index', file: filePath, line: i + 1 });
        routes.push({ method: 'POST', path: base, handler: 'store', file: filePath, line: i + 1 });
        routes.push({ method: 'GET', path: base + '/{id}', handler: 'show', file: filePath, line: i + 1 });
        routes.push({ method: 'PUT', path: base + '/{id}', handler: 'update', file: filePath, line: i + 1 });
        routes.push({ method: 'DELETE', path: base + '/{id}', handler: 'destroy', file: filePath, line: i + 1 });
        if (!isApi) {
          routes.push({ method: 'GET', path: base + '/create', handler: 'create', file: filePath, line: i + 1 });
          routes.push({ method: 'GET', path: base + '/{id}/edit', handler: 'edit', file: filePath, line: i + 1 });
        }
      }
    }
    return routes;
  }

  // ═══════════════════════════════════════════════
  //  Parse Ruby routes (Sinatra / Rails routes.rb)
  // ═══════════════════════════════════════════════

  _parseRubyRoutes(content, filePath) {
    const routes = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('#')) continue;

      // Sinatra: get '/path' do ... or post '/path' do ...
      const sinatra = trimmed.match(/^(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/i);
      if (sinatra) {
        routes.push({ method: sinatra[1].toUpperCase(), path: sinatra[2], handler: '', file: filePath, line: i + 1 });
      }

      // Rails routes.rb: get '/path', to: 'controller#action'
      const rails = trimmed.match(/^(get|post|put|patch|delete)\s+['"]([^'"]+)['"]\s*,\s*to:\s*['"]([^'"]+)['"]/i);
      if (rails) {
        routes.push({ method: rails[1].toUpperCase(), path: rails[2], handler: rails[3].split('#').pop(), file: filePath, line: i + 1 });
      }

      // Rails resources :users
      const resources = trimmed.match(/^\s*resources?\s+:(\w+)/);
      if (resources) {
        const base = '/' + resources[1];
        routes.push({ method: 'GET', path: base, handler: 'index', file: filePath, line: i + 1 });
        routes.push({ method: 'POST', path: base, handler: 'create', file: filePath, line: i + 1 });
        routes.push({ method: 'GET', path: base + '/:id', handler: 'show', file: filePath, line: i + 1 });
        routes.push({ method: 'PUT', path: base + '/:id', handler: 'update', file: filePath, line: i + 1 });
        routes.push({ method: 'DELETE', path: base + '/:id', handler: 'destroy', file: filePath, line: i + 1 });
      }
    }
    return routes;
  }

  // ═══════════════════════════════════════════════
  //  Parse Java/Kotlin routes (Spring Boot)
  // ═══════════════════════════════════════════════

  _parseJavaRoutes(content, filePath) {
    const routes = [];
    const lines = content.split('\n');

    // Detect class-level @RequestMapping prefix
    let classPrefix = '';
    const classMapping = content.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
    if (classMapping) classPrefix = classMapping[1];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      // @GetMapping("/path"), @PostMapping, etc.
      const mapping = trimmed.match(/@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:(?:value|path)\s*=\s*)?["']([^"']+)["']/i);
      if (mapping) {
        let method = mapping[1].toUpperCase();
        if (method === 'REQUEST') method = 'ALL';
        const routePath = this._normPath(classPrefix, mapping[2]);
        // Handler = next method name
        let handler = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const fnMatch = lines[j].match(/(?:public|private|protected)?\s+\w+\s+(\w+)\s*\(/);
          if (fnMatch) { handler = fnMatch[1]; break; }
        }
        routes.push({ method, path: routePath, handler, file: filePath, line: i + 1 });
      }

      // @GetMapping without path (maps to class prefix)
      const emptyMapping = trimmed.match(/@(Get|Post|Put|Patch|Delete)Mapping\s*$/i);
      if (emptyMapping) {
        let handler = '';
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const fnMatch = lines[j].match(/(?:public|private|protected)?\s+\w+\s+(\w+)\s*\(/);
          if (fnMatch) { handler = fnMatch[1]; break; }
        }
        routes.push({ method: emptyMapping[1].toUpperCase(), path: classPrefix || '/', handler, file: filePath, line: i + 1 });
      }
    }
    return routes;
  }

  // ═══════════════════════════════════════════════
  //  Deduplication & sorting
  // ═══════════════════════════════════════════════

  _deduplicateAndSort(routes) {
    const seen = new Set();
    const unique = [];
    for (const r of routes) {
      const key = `${r.method}:${r.path}`;
      if (!seen.has(key)) { seen.add(key); unique.push(r); }
    }
    const order = { GET: 0, POST: 1, PUT: 2, PATCH: 3, DELETE: 4, HEAD: 5, OPTIONS: 6, ALL: 7 };
    unique.sort((a, b) => {
      const cmp = a.path.toLowerCase().localeCompare(b.path.toLowerCase());
      return cmp !== 0 ? cmp : (order[a.method] ?? 99) - (order[b.method] ?? 99);
    });
    return unique;
  }

  // ═══════════════════════════════════════════════
  //  Helpers
  // ═══════════════════════════════════════════════

  _resolveStr(str, vars) {
    if (!str) return str;
    if (str.includes('${')) {
      str = str.replace(/\$\{([^}]+)\}/g, (full, expr) => {
        // Simple variable: ${varName}
        const varName = expr.trim();
        if (vars.has(varName)) return vars.get(varName);

        // Case-insensitive lookup
        for (const [key, val] of vars) {
          if (key.toLowerCase() === varName.toLowerCase()) return val;
        }

        // Handle process.env.X
        const envMatch = expr.match(/^process\.env\.(\w+)$/);
        if (envMatch) {
          // Look for the env var name as a key in vars (might have been resolved from .env)
          for (const [key, val] of vars) {
            if (key === envMatch[1]) return val;
          }
        }

        // Truly unresolved — keep as ${varName} for visibility
        return full;
      });
    }
    // Also resolve simple variable references like varName + '/path'
    if (str.includes(' + ')) {
      str = str.split('+').map(part => {
        const cleaned = part.trim().replace(/^['"`]|['"`]$/g, '');
        return vars.has(cleaned) ? vars.get(cleaned) : cleaned;
      }).join('');
    }
    return str;
  }

  _normPath(prefix, routePath) {
    let p = (routePath || '').trim();
    if (!p.startsWith('/')) p = '/' + p;
    const full = prefix ? prefix.replace(/\/$/, '') + p : p;
    let cleaned = full.replace(/\/+/g, '/');
    if (cleaned.length > 1) cleaned = cleaned.replace(/\/$/, '');
    return cleaned || '/';
  }

  _joinPrefix(existing, addition) {
    const a = (existing || '').replace(/\/$/, '');
    let b = (addition || '').trim();
    if (!b.startsWith('/')) b = '/' + b;
    return (a + b).replace(/\/+/g, '/');
  }

  _stripExt(filePath) {
    return filePath.replace(/\.(js|ts|mjs|cjs|jsx|tsx)$/, '');
  }

  _looksLikePath(str) {
    if (!str) return false;
    if (str.startsWith('/') || str === '*') return true;
    // Accept template literal paths that still contain ${...}
    if (str.includes('${') && str.includes('/')) return true;
    // Accept paths that look like URL segments (after variable resolution stripped prefix)
    if (/^[\w\-/:.*{}$]+$/.test(str) && str.includes('/')) return true;
    return false;
  }

  _extractHandler(line, lines, index) {
    const parts = line.split(',');
    for (let k = parts.length - 1; k >= 1; k--) {
      const arg = parts[k].trim().replace(/\)\s*;?\s*$/, '').trim();
      if (['async', 'function', 'req', 'res', 'ctx', 'next', 'err', 'request', 'response', 'c'].includes(arg)) continue;
      if (arg.includes('=>') || arg.includes('function') || arg.includes('{') || arg.includes('(')) continue;
      if (/^[\w.]+$/.test(arg)) return arg.includes('.') ? arg.split('.').pop() : arg;
    }
    for (let j = index; j < Math.min(index + 3, lines.length); j++) {
      const fm = lines[j].match(/(?:async\s+)?function\s+(\w+)/);
      if (fm) return fm[1];
    }
    if (line.includes('=>') || line.includes('function')) return 'handler';
    return '';
  }

  _extractBlockHandler(block) {
    const m = block.match(/handler\s*:\s*(\w+)/);
    return m ? m[1] : 'handler';
  }

  _findNextFunction(lines, start) {
    for (let j = start; j < Math.min(start + 5, lines.length); j++) {
      const m = lines[j].match(/(?:async\s+)?(\w+)\s*\(/);
      if (m && !['constructor', 'if', 'for', 'while', 'switch', 'return'].includes(m[1])) return m[1];
    }
    return '';
  }

  _findNextDef(lines, start) {
    for (let j = start; j < Math.min(start + 5, lines.length); j++) {
      const m = lines[j].match(/(?:async\s+)?def\s+(\w+)/);
      if (m) return m[1];
    }
    return '';
  }
}

module.exports = new ApiRouteDetector();
