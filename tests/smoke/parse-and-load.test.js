/**
 * Smoke tests: parse-and-load safety net for everything esbuild never sees.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * CI runs `npm run build:renderer` before `npm test`, so esbuild already acts as a
 * syntax + resolution gate for `src/renderer/`, `src/project-types/` and `renderer.js`.
 * NOTHING plays that role for:
 *   - `src/main/**` and `main.js`  (loaded by Electron at runtime only)
 *   - `remote-ui/*.js`             (shipped as extraResources, served to the PWA)
 *   - `resources/**`               (MCP servers + hook handler, spawned as child processes)
 *   - inline `<script>` blocks in the HTML pages
 *
 * That gap is exactly how a top-level SyntaxError in `remote-ui/app.js` shipped and
 * killed the entire Remote PWA while `npm test` stayed green.
 *
 * These checks use only Node builtins (fs, path, vm) and never `require()` the files
 * under test, so nothing is executed and no heavy module (electron, node-pty, ...) loads.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Recursively collect *.js files under `dir`, skipping node_modules. */
function collectJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

/** Parse `source` without executing it. Returns null on success, or the error message. */
function parseError(source, filename) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script(source, { filename });
    return null;
  } catch (error) {
    return `${error.name}: ${error.message}`;
  }
}

/**
 * Scan `files` for `pattern` (must expose the channel name as capture group 1)
 * and return Map<channel, ["relative/path.js:line", ...]>.
 */
function collectChannels(files, pattern) {
  const found = new Map();
  for (const file of files) {
    const content = read(file);
    const regex = new RegExp(pattern.source, 'g');
    let match;
    while ((match = regex.exec(content)) !== null) {
      const channel = match[1];
      // Skip dynamically-built channel names (`mcp-tab:${data.action}`) - they
      // cannot be matched statically against a literal listener name.
      if (channel.includes('${')) continue;
      const line = content.slice(0, match.index).split('\n').length;
      if (!found.has(channel)) found.set(channel, []);
      found.get(channel).push(`${relative(file)}:${line}`);
    }
  }
  return found;
}

// ── Shared file lists (built once, cheap) ────────────────────────────────────

const REMOTE_UI_DIR = path.join(ROOT, 'remote-ui');

const UNBUNDLED_JS_FILES = [
  ...collectJsFiles(path.join(ROOT, 'src', 'main')),
  path.join(ROOT, 'main.js'),
  ...fs
    .readdirSync(REMOTE_UI_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(REMOTE_UI_DIR, f)),
  ...collectJsFiles(path.join(ROOT, 'resources'))
];

const HTML_PAGES = ['index.html', 'quick-picker.html', 'setup-wizard.html', 'notification.html'];

// ── CHECK 1 - remote-ui scripts must parse TOGETHER in one global scope ──────
//
// `remote-ui/index.html` loads i18n.js then app.js as two CLASSIC (non-module)
// scripts, so they share ONE global scope. The bug that shipped was a `const t`
// in app.js colliding with a global `function t()` in i18n.js -> the whole PWA
// died with "SyntaxError: Identifier 't' has already been declared".
// A per-file `node --check` would NOT catch that. Only concatenation does.

describe('CHECK 1 - remote-ui scripts share one global scope', () => {
  const i18nPath = path.join(REMOTE_UI_DIR, 'i18n.js');
  const appPath = path.join(REMOTE_UI_DIR, 'app.js');
  const swPath = path.join(REMOTE_UI_DIR, 'sw.js');

  test('index.html still loads i18n.js and app.js as classic scripts', () => {
    const html = read(path.join(REMOTE_UI_DIR, 'index.html'));
    // If these ever become type="module" the collision class disappears and this
    // check should be revisited - fail loudly instead of silently passing.
    expect(html).toMatch(/<script\s+src="\/i18n\.js"\s*>/);
    expect(html).toMatch(/<script\s+src="\/app\.js"\s*>/);
    expect(html).not.toMatch(/<script[^>]*type=["']module["'][^>]*src=["']\/(i18n|app)\.js/);
  });

  test('i18n.js + app.js parse together without top-level identifier collisions', () => {
    const combined = `${read(i18nPath)};\n${read(appPath)}`;
    const error = parseError(combined, 'remote-ui/i18n.js+app.js');
    expect(error).toBeNull();
  });

  test('sw.js parses on its own (separate worker scope)', () => {
    expect(parseError(read(swPath), 'remote-ui/sw.js')).toBeNull();
  });

  test('the concatenation strategy actually detects a global redeclaration', () => {
    // Self-test: proves the mechanism above is not vacuously passing.
    // This is the exact shape of the bug that shipped.
    const shipped = 'function t(key) { return key; }';
    const broken = 'const t = document.getElementById("x");';
    expect(parseError(shipped, 'a.js')).toBeNull();
    expect(parseError(broken, 'b.js')).toBeNull();
    expect(parseError(`${shipped};\n${broken}`, 'a.js+b.js')).toMatch(/already been declared/);
  });
});

// ── CHECK 2 - every unbundled JS file must parse ─────────────────────────────
//
// esbuild never touches src/main, main.js, remote-ui or resources. A stray
// SyntaxError there only surfaces at runtime: Electron fails to boot, an MCP
// server child process dies silently, or the hook handler stops reporting.

describe('CHECK 2 - unbundled JS files parse', () => {
  test('the sweep actually covers the expected areas', () => {
    const paths = UNBUNDLED_JS_FILES.map(relative);
    expect(paths).toContain('main.js');
    expect(paths.some((p) => p.startsWith('src/main/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('remote-ui/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('resources/'))).toBe(true);
    expect(paths.every((p) => !p.includes('node_modules'))).toBe(true);
    // Guard against the glob silently collapsing to a handful of files.
    expect(paths.length).toBeGreaterThan(100);
  });

  test('no file has a syntax error', () => {
    const failures = [];
    for (const file of UNBUNDLED_JS_FILES) {
      const error = parseError(read(file), file);
      if (error) failures.push(`${relative(file)} -> ${error}`);
    }
    expect(failures).toEqual([]);
  });
});

// ── CHECK 3 - inline <script> blocks in the HTML pages must parse ────────────
//
// quick-picker.html, setup-wizard.html and notification.html carry their whole
// logic in inline scripts that nothing ever parses. A syntax error in
// setup-wizard.html breaks the 7-step first-launch onboarding - the highest
// stakes screen in the app, and the one the developer never sees again.

describe('CHECK 3 - inline scripts in HTML pages parse', () => {
  /** Extract bodies of <script> tags that have no src= attribute. */
  function extractInlineScripts(html) {
    const blocks = [];
    const regex = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const attributes = match[1];
      if (/\ssrc\s*=/i.test(attributes)) continue; // external file, covered elsewhere
      if (/type\s*=\s*["'](?!(text\/javascript|module|application\/javascript))/i.test(attributes)) {
        continue; // JSON-LD / templates / etc, not JavaScript
      }
      const line = html.slice(0, match.index).split('\n').length;
      blocks.push({ body: match[2], line });
    }
    return blocks;
  }

  test('extraction finds the inline scripts we know about', () => {
    // setup-wizard / quick-picker / notification are inline-script driven.
    // index.html only loads dist/renderer.bundle.js (already covered by esbuild).
    const counts = {};
    for (const page of HTML_PAGES) {
      counts[page] = extractInlineScripts(read(path.join(ROOT, page))).length;
    }
    expect(counts['quick-picker.html']).toBeGreaterThan(0);
    expect(counts['setup-wizard.html']).toBeGreaterThan(0);
    expect(counts['notification.html']).toBeGreaterThan(0);
  });

  test.each(HTML_PAGES)('%s inline scripts have no syntax error', (page) => {
    const file = path.join(ROOT, page);
    const failures = [];
    for (const block of extractInlineScripts(read(file))) {
      const error = parseError(block.body, `${page}:${block.line}`);
      if (error) failures.push(`${page}:${block.line} -> ${error}`);
    }
    expect(failures).toEqual([]);
  });
});

// ── CHECK 4 - IPC channel symmetry, both directions ──────────────────────────
//
// A renamed channel on one side of the bridge is invisible until a user clicks
// the feature. These two checks make a half-renamed channel a test failure.

describe('CHECK 4 - IPC channel symmetry', () => {
  const PRELOAD = path.join(ROOT, 'src', 'main', 'preload.js');
  // Handlers and senders live under src/ (including src/project-types/*/main/*.ipc.js)
  // plus main.js itself, so both sweeps use the same broad file list.
  const MAIN_SIDE_FILES = [...collectJsFiles(path.join(ROOT, 'src')), path.join(ROOT, 'main.js')];

  // ── (a) main -> renderer ──────────────────────────────────────────────────

  /**
   * Channels the main process sends but the preload bridge never listens to.
   * These are DEAD: the payload is emitted and dropped on the floor.
   *
   * Allowlisting is tolerance, not a requirement: if a listener is added the
   * channel simply stops being reported and this test keeps passing. Remove the
   * entry when you fix it, but nothing breaks if you forget.
   */
  const KNOWN_DEAD_SENT_CHANNELS = new Set([
    // src/main/services/TerminalService.js:100 - emitted when node-pty fails to
    // spawn a PTY. No listener in preload.js, so a failed terminal creation shows
    // nothing extra to the user. Low impact because create() also returns
    // { success: false, error }, which TerminalManager already renders.
    // Remove this entry if a listener is ever added.
    'terminal-error'

    // 'settings-changed-externally' and 'workflow-trigger' used to be listed here.
    // Both are now wired in preload.js, so they are locked in by the assertion
    // below: re-breaking either one fails this test.
  ]);

  test('(a) every channel sent to the renderer has a preload listener', () => {
    const sent = collectChannels(
      MAIN_SIDE_FILES,
      /(?:webContents\.send|sendToRenderer)\(\s*['"`]([^'"`]+)['"`]/
    );
    const listened = collectChannels(
      [PRELOAD],
      /(?:createListener\(|ipcRenderer\.on\()\s*['"`]([^'"`]+)['"`]/
    );

    expect(sent.size).toBeGreaterThan(20);
    expect(listened.size).toBeGreaterThan(20);

    const orphans = [];
    for (const [channel, locations] of sent) {
      if (listened.has(channel)) continue;
      if (KNOWN_DEAD_SENT_CHANNELS.has(channel)) continue;
      orphans.push(`'${channel}' sent from ${locations.join(', ')} - no listener in preload.js`);
    }
    expect(orphans).toEqual([]);
  });

  test('(a) allowlisted dead channels are still genuinely sent somewhere', () => {
    // Keeps the allowlist honest: an entry for a channel nobody sends anymore is
    // stale and should be deleted rather than left to hide a future regression.
    const sent = collectChannels(
      MAIN_SIDE_FILES,
      /(?:webContents\.send|sendToRenderer)\(\s*['"`]([^'"`]+)['"`]/
    );
    const stale = [...KNOWN_DEAD_SENT_CHANNELS].filter((channel) => !sent.has(channel));
    expect(stale).toEqual([]);
  });

  // ── (b) renderer -> main ──────────────────────────────────────────────────

  test('(b) every channel invoked from preload has a main-process handler', () => {
    // No allowlist here on purpose: this direction is currently clean (0 orphans),
    // so lock it in. An orphan means an invoke() that rejects at runtime.
    const invoked = collectChannels(
      [PRELOAD],
      /ipcRenderer\.(?:invoke|send)\(\s*['"`]([^'"`]+)['"`]/
    );
    const handled = collectChannels(
      MAIN_SIDE_FILES,
      /ipcMain\.(?:handle|on)\(\s*['"`]([^'"`]+)['"`]/
    );

    expect(invoked.size).toBeGreaterThan(100);
    expect(handled.size).toBeGreaterThan(100);

    const orphans = [];
    for (const [channel, locations] of invoked) {
      if (handled.has(channel)) continue;
      orphans.push(`'${channel}' invoked from ${locations.join(', ')} - no ipcMain handler`);
    }
    expect(orphans).toEqual([]);
  });
});
