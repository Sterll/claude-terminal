/**
 * Build script for renderer process
 * Bundles renderer.js and all its dependencies into a single file
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: [path.join(__dirname, '..', 'renderer.js')],
  bundle: true,
  outfile: path.join(__dirname, '..', 'dist', 'renderer.bundle.js'),
  platform: 'browser',
  target: 'chrome120', // Electron uses Chromium
  format: 'iife',
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

async function build() {
  try {
    if (isWatch) {
      const [jsCtx, cssCtx] = await Promise.all([
        esbuild.context(buildOptions),
        esbuild.context(cssBuildOptions),
      ]);
      await Promise.all([jsCtx.watch(), cssCtx.watch()]);
      console.log('Watching for changes...');
    } else {
      await Promise.all([
        esbuild.build(buildOptions),
        esbuild.build(mermaidBuildOptions),
        esbuild.build(pdfViewerBuildOptions),
        esbuild.build(threeViewerBuildOptions),
        esbuild.build(cssBuildOptions),
      ]);
      // Copy pdf.js worker to dist/ for runtime loading
      const workerSrc = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs');
      const workerDest = path.join(__dirname, '..', 'dist', 'pdf.worker.min.mjs');
      fs.copyFileSync(workerSrc, workerDest);

      console.log('Build complete: dist/renderer.bundle.js + dist/mermaid.bundle.js + dist/pdf-viewer.bundle.js + dist/three-viewer.bundle.js + dist/styles.bundle.css + dist/pdf.worker.min.mjs');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
