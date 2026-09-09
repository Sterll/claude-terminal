/**
 * ESLint flat config.
 *
 * Two things this config deliberately does NOT do:
 *
 *   1. Formatting. No Prettier, no indent/quote/semi rules. The codebase is
 *      hand-formatted and consistently so; a reformatting pass would rewrite
 *      most of ~144k lines and bury every `git blame` that currently explains
 *      why something is the way it is. Style stays a review concern.
 *
 *   2. Anything that would need a mass `eslint-disable` sweep to go green.
 *      A lint run that is red on arrival gets ignored, and then it guards
 *      nothing. Rules that would fire widely on existing, working code are set
 *      to 'warn' so they surface in new work without blocking the build;
 *      `npm run lint` fails on errors only.
 *
 * What it is actually for is the third thing: the architectural boundaries that
 * CLAUDE.md describes in prose have, until now, been enforced by nobody. The
 * `no-restricted-syntax` blocks below turn the important ones into build
 * failures. The renderer/electron rule is not hypothetical — five click
 * handlers had been calling `require('electron')` from renderer code, which
 * throws under contextIsolation, and nothing caught it.
 */

'use strict';

const js = require('@eslint/js');

// ── Globals ──────────────────────────────────────────────────────────────────

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  AbortSignal: 'readonly',
  structuredClone: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  requestIdleCallback: 'readonly',
  cancelIdleCallback: 'readonly',
  queueMicrotask: 'readonly',
  MutationObserver: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  CSS: 'readonly',
  NodeFilter: 'readonly',
  Notification: 'readonly',
  MediaRecorder: 'readonly',
  MediaStream: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  Image: 'readonly',
  Audio: 'readonly',
  AudioContext: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  DragEvent: 'readonly',
  Node: 'readonly',
  Element: 'readonly',
  HTMLElement: 'readonly',
  DOMParser: 'readonly',
  XMLHttpRequest: 'readonly',
  WebSocket: 'readonly',
  Worker: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
  getComputedStyle: 'readonly',
  matchMedia: 'readonly',
  performance: 'readonly',
  crypto: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  // CommonJS survives into the renderer: esbuild bundles it away, but the
  // sources are written as CommonJS modules.
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  process: 'readonly',
  globalThis: 'readonly',
};

// ── Shared rule sets ─────────────────────────────────────────────────────────

/**
 * Correctness rules worth failing the build over. Each one has been checked to
 * be clean on the current tree; if one starts firing, it has found something
 * new rather than something pre-existing.
 */
const ERROR_RULES = {
  'no-async-promise-executor': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-binary-expression': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-invalid-regexp': 'error',
  'no-irregular-whitespace': 'error',
  'no-loss-of-precision': 'error',
  'no-obj-calls': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-sparse-arrays': 'error',
  'no-template-curly-in-string': 'warn',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'getter-return': 'error',
};

/**
 * Rules that catch real slips but fire on enough existing code that failing on
 * them today would mean a disable sweep. They still show up in `npm run lint`
 * output, and in an editor, which is where they do their work.
 */
const WARN_RULES = {
  'no-unused-vars': ['warn', {
    args: 'none',
    varsIgnorePattern: '^_',
    // Deliberately swallowed errors are written both as `catch (_)` and as
    // `catch (e)` throughout, and flagging the second spelling produced 278
    // warnings that all wanted the same non-change. Unused *variables* — dead
    // requires in renderer.js, a helper nothing calls any more — are the half
    // of this rule worth reading, and they stay on.
    caughtErrors: 'none',
  }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  // Off, not warn. `async` without `await` is a convention here, not a slip:
  // the MCP tool-module contract in CLAUDE.md specifies `handle: async (...)`,
  // the 321 IPC handlers are uniformly async so callers never have to know
  // which ones happen to be synchronous today, and test mocks mirror the async
  // signature of what they stand in for. 497 warnings, none of them actionable.
  'require-await': 'off',
  'no-fallthrough': 'warn',
  'no-prototype-builtins': 'warn',
  'no-useless-escape': 'warn',
  'no-control-regex': 'off',
  // Both are new in ESLint 10 and both are reasonable advice, but each fires on
  // dozens of existing, working sites (defensive re-assignment; rethrows that
  // predate `Error.cause`). Warn now, promote once the backlog is worked off.
  'no-useless-assignment': 'warn',
  'preserve-caught-error': 'warn',
};

// ── Architectural boundaries ─────────────────────────────────────────────────
//
// These are the rules this config exists for. `no-restricted-imports` only
// understands ESM `import`, and the `no-restricted-modules` rule that covered
// `require()` was removed in ESLint 7, so the boundaries are expressed as
// esquery selectors over the `require()` call instead. That is more precise
// anyway: it matches the exact call shape and nothing else.

const requireOf = (mod) =>
  `CallExpression[callee.name='require'][arguments.0.value='${mod}']`;

/** Node built-ins the renderer must never pull in directly. */
const RENDERER_FORBIDDEN_MODULES = [
  'child_process', 'fs', 'fs/promises', 'os', 'net', 'http', 'https',
  'cluster', 'worker_threads', 'vm', 'dns', 'tls', 'repl',
];

const RENDERER_BOUNDARY = {
  'no-restricted-syntax': ['error',
    {
      selector: requireOf('electron'),
      message:
        "The renderer has no `require` (contextIsolation: true, nodeIntegration: false), " +
        'and esbuild turns this into a runtime `require("electron")` that throws. ' +
        'Use the preload bridge: window.electron_api / this.api.',
    },
    ...RENDERER_FORBIDDEN_MODULES.map((mod) => ({
      selector: requireOf(mod),
      message:
        `Do not require('${mod}') in the renderer. Node access goes through the ` +
        'preload bridge (window.electron_nodeModules for fs/path, an IPC handler ' +
        'otherwise). child_process in particular is deliberately not bridged: the ' +
        'renderer displays model-authored markdown, so a path to process spawning ' +
        'would turn any HTML injection into code execution.',
    })),
    {
      selector: "CallExpression[callee.name='require'][arguments.0.value=/(^|\\/)main\\//]",
      message:
        'The renderer must not reach into src/main/. Cross the boundary through an ' +
        'IPC handler, or put the shared code in src/shared/.',
    },
  ],
};

const MAIN_BOUNDARY = {
  'no-restricted-syntax': ['error',
    {
      selector: "CallExpression[callee.name='require'][arguments.0.value=/(^|\\/)renderer\\//]",
      message:
        'The main process must not require renderer modules. Shared code belongs in ' +
        'src/shared/, which both sides already use (workflow-schema, model-options, ' +
        'permission-modes, artifact-store...).',
    },
  ],
  // A stray `document.` in main-process code is always a mistake, and one that
  // only shows up at runtime in a code path nobody exercised.
  'no-restricted-globals': ['error',
    { name: 'document', message: 'No DOM in the main process.' },
    { name: 'localStorage', message: 'No DOM in the main process.' },
    { name: 'navigator', message: 'No DOM in the main process.' },
  ],
};

// ── Config ───────────────────────────────────────────────────────────────────

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'cloud/**',        // separate package, TypeScript, own toolchain
      'hub-worker/**',   // separate package, Cloudflare Worker
      'flatpak/**',
      'snap/**',
      'website/**',
      'docs/**',
      '**/*.min.js',
      'telemetry-server/**',
    ],
  },

  // ── Main process, MCP servers, build scripts: Node ────────────────────────
  {
    files: [
      'main.js',
      'dev-entry.js',
      'electron-builder.config.js',
      'eslint.config.js',
      'src/main/**/*.js',
      'src/shared/**/*.js',
      'src/project-types/*/main/**/*.js',
      'src/project-types/*/*.js',
      'resources/**/*.js',
      'scripts/**/*.js',
      'build-assets/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: { ...js.configs.recommended.rules, ...ERROR_RULES, ...WARN_RULES },
  },

  // Boundary rules for main only (not for shared/, which both sides import).
  {
    files: ['main.js', 'src/main/**/*.js', 'src/project-types/*/main/**/*.js'],
    rules: MAIN_BOUNDARY,
  },

  // Workflow node files are the one honest exception to "no DOM in main".
  //
  // Each *.node.js exports both an `execute()` that runs in the main process
  // and the config-panel UI for that node. workflow.ipc.js ships the UI half to
  // the renderer as source text (`fn.toString()`), where it is rehydrated with
  // `new Function('return (' + str + ')')()`. So `document` and `window` inside
  // those functions are correct: they only ever run in the renderer.
  {
    files: ['src/main/workflow-nodes/**/*.js'],
    languageOptions: { globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS } },
    rules: { 'no-restricted-globals': 'off' },
  },

  // ── Preload: the bridge itself, so it may touch both worlds ───────────────
  {
    files: ['src/main/preload*.js'],
    rules: { 'no-restricted-globals': 'off' },
  },

  // ── Renderer: browser ─────────────────────────────────────────────────────
  {
    files: [
      'renderer.js',
      'src/renderer/**/*.js',
      'src/project-types/*/renderer/**/*.js',
      'remote-ui/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: BROWSER_GLOBALS,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...ERROR_RULES,
      ...WARN_RULES,
      ...RENDERER_BOUNDARY,
    },
  },

  // The two viewers are the only ESM in the renderer: they are built as
  // separate ESM bundles and pulled in with a dynamic import() at the moment a
  // PDF or a 3D model is opened, so they never enter renderer.bundle.js.
  {
    files: ['src/renderer/viewers/**/*.js'],
    languageOptions: { sourceType: 'module' },
  },

  // remote-ui is a plain browser PWA served over HTTP, not a bundled module:
  // no CommonJS, and no preload bridge to reach for either. `t` and `i18n` come
  // from i18n.js, loaded as its own <script> before app.js, so they are globals
  // here rather than imports.
  {
    files: ['remote-ui/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...BROWSER_GLOBALS,
        require: 'off',
        module: 'off',
        exports: 'off',
        __dirname: 'off',
        process: 'off',
        t: 'readonly',
        i18n: 'readonly',
      },
    },
    rules: { 'no-restricted-syntax': 'off' },
  },

  // i18n.js is where `t` and `i18n` are declared, so it is the one file in
  // remote-ui that legitimately shadows them.
  {
    files: ['remote-ui/i18n.js'],
    rules: { 'no-redeclare': ['error', { builtinGlobals: false }] },
  },

  // The service worker has its own global scope.
  {
    files: ['remote-ui/sw.js'],
    languageOptions: {
      globals: {
        ...BROWSER_GLOBALS,
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        skipWaiting: 'readonly',
        registration: 'readonly',
        require: 'off',
        module: 'off',
        exports: 'off',
      },
    },
  },

  // ── Tests: jsdom + jest ───────────────────────────────────────────────────
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...NODE_GLOBALS,
        ...BROWSER_GLOBALS,
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...ERROR_RULES,
      ...WARN_RULES,
      // A test may legitimately require anything it is testing.
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
    },
  },
];
