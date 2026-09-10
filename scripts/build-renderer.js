/**
 * Build script for renderer process
 *
 * renderer.js and everything it reaches become dist/renderer.bundle.js plus a
 * set of dist/chunk-*.js, then the handful of standalone ESM bundles below
 * (mermaid, KaTeX, the PDF viewer, the 3D viewer) that are fetched only when
 * something on screen needs them.
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

// Renderer bundle. ESM with code splitting rather than one IIFE, so the five
// heaviest panels (see _LAZY_PANELS in renderer.js) can be import()ed the
// first time their tab is opened instead of being parsed and evaluated at
// every startup. Splitting is what keeps that safe: a standalone bundle per
// panel would carry its own copy of the observable state modules, the DI
// container and i18n, and a subscription would then fire on one copy while
// the UI reads the other. One graph means one instance of each shared module,
// hoisted into the shared chunks esbuild emits.
//
// index.html loads the entry as <script type="module">, which the CSP already
// allows (script-src 'self'). Nothing about the CSP changes for this.
//
// chunkNames stays flat in dist/ on purpose: dynamic imports resolve against
// the importing chunk's own URL, and the lazy mermaid/KaTeX loaders in
// src/renderer/services/markdown/postProcess.js ask for './mermaid.bundle.js'
// relative to it. A chunks/ subdirectory would silently 404 both of them.
const buildOptions = {
  entryPoints: [{ in: path.join(__dirname, '..', 'renderer.js'), out: 'renderer.bundle' }],
  bundle: true,
  outdir: path.join(__dirname, '..', 'dist'),
  splitting: true,
  chunkNames: 'chunk-[hash]',
  platform: 'browser',
  target: 'chrome120', // Electron uses Chromium
  format: 'esm',
  sourcemap: true,
  minify: true,
  // Don't bundle electron - it's provided by the runtime
  external: ['electron'],
  // Define to replace process.env references
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  },
  loader: {
    '.js': 'js'
  }
};

// Separate mermaid bundle (ESM, lazy-loaded at runtime)
const mermaidBuildOptions = {
  entryPoints: [path.join(__dirname, '..', 'node_modules', 'mermaid', 'dist', 'mermaid.core.mjs')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'mermaid.bundle.js'),
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
};

// KaTeX bundle (ESM, lazy-loaded when the chat renders math)
// Kept out of renderer.bundle.js: postProcess.js only *executed* require('katex')
// lazily, but esbuild still resolved it statically and shipped ~270 KB eagerly.
const katexBuildOptions = {
  entryPoints: [path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.mjs')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'katex.bundle.js'),
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
};

// PDF viewer bundle (ESM, lazy-loaded when opening a PDF)
const pdfViewerBuildOptions = {
  entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'viewers', 'pdf-viewer.js')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'pdf-viewer.bundle.js'),
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
};

// Three.js 3D viewer bundle (ESM, lazy-loaded when opening a 3D model)
const threeViewerBuildOptions = {
  entryPoints: [path.join(__dirname, '..', 'src', 'renderer', 'viewers', 'three-viewer.js')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'three-viewer.bundle.js'),
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
};

// CSS bundle (all 27 stylesheets into one minified file)
const cssBuildOptions = {
  entryPoints: [path.join(__dirname, '..', 'styles', 'index.css')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'styles.bundle.css'),
  minify: true,
};

// Non-default locales are read at runtime from dist/locales/ instead of being
// bundled (src/renderer/i18n/index.js). Only English ships inside
// renderer.bundle.js, as the fallback locale t() needs synchronously.
// Keep in sync with SUPPORTED_LANGUAGES in src/renderer/i18n/index.js, minus
// 'en': a locale missing here is selectable in the picker but silently renders
// English, because readLocaleFile() finds nothing in dist/locales/.
const LAZY_LOCALES = ['fr', 'es', 'id', 'zh-CN'];

/**
 * Drop the previous build's chunks. Their names are content-hashed, so
 * without this every edit leaves another orphan behind in dist/ — and
 * electron-builder ships dist/**\/* wholesale into the installer.
 */
function cleanStaleChunks() {
  const dist = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(dist)) return;
  for (const name of fs.readdirSync(dist)) {
    if (/^chunk-[A-Z0-9]+\.js(\.map)?$/.test(name)) fs.rmSync(path.join(dist, name), { force: true });
  }
}

function copyLazyLocales() {
  const srcDir = path.join(__dirname, '..', 'src', 'renderer', 'i18n', 'locales');
  const destDir = path.join(__dirname, '..', 'dist', 'locales');
  fs.mkdirSync(destDir, { recursive: true });
  for (const code of LAZY_LOCALES) {
    fs.copyFileSync(path.join(srcDir, `${code}.json`), path.join(destDir, `${code}.json`));
  }
}

async function build() {
  try {
    if (isWatch) {
      // Once, not per rebuild: esbuild rewrites the chunks it still needs, and
      // a stale one in a dev session costs disk, not correctness.
      cleanStaleChunks();
      copyLazyLocales();
      const [jsCtx, cssCtx] = await Promise.all([
        esbuild.context(buildOptions),
        esbuild.context(cssBuildOptions),
      ]);
      await Promise.all([jsCtx.watch(), cssCtx.watch()]);
      console.log('Watching for changes...');
    } else {
      cleanStaleChunks();
      await Promise.all([
        esbuild.build(buildOptions),
        esbuild.build(mermaidBuildOptions),
        esbuild.build(katexBuildOptions),
        esbuild.build(pdfViewerBuildOptions),
        esbuild.build(threeViewerBuildOptions),
        esbuild.build(cssBuildOptions),
      ]);
      // Copy pdf.js worker to dist/ for runtime loading
      const workerSrc = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
      const workerDest = path.join(__dirname, '..', 'dist', 'pdf.worker.min.mjs');
      fs.copyFileSync(workerSrc, workerDest);

      copyLazyLocales();

      console.log('Build complete: dist/renderer.bundle.js + dist/chunk-*.js + dist/mermaid.bundle.js + dist/katex.bundle.js + dist/pdf-viewer.bundle.js + dist/three-viewer.bundle.js + dist/styles.bundle.css + dist/pdf.worker.min.mjs + dist/locales/{' + LAZY_LOCALES.join(',') + '}.json');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
