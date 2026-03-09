/**
 * Build script for renderer process
 * Bundles renderer.js and all its dependencies into a single file
 */

const esbuild = require('esbuild');
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
  minify: process.env.NODE_ENV === 'production',
  // Don't bundle electron - it's provided by the runtime
  external: ['electron', 'dompurify'],
  // Define to replace process.env references
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  },
  loader: {
    '.js': 'js'
  }
};

async function build() {
  try {
    if (isWatch) {
      const ctx = await esbuild.context(buildOptions);
      await ctx.watch();
      console.log('Watching for changes...');
    } else {
      await esbuild.build(buildOptions);
      console.log('Build complete: dist/renderer.bundle.js');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
