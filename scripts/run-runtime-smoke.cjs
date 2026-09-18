'use strict';
// Chromium holds profile files open on Windows: the parent owns their cleanup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-runtime-~'));
try {
  const result = spawnSync(require('electron'), [path.join(__dirname, process.argv.includes('--upgrade') ? 'upgrade-smoke.cjs' : 'runtime-smoke.cjs'), temporary], {
    stdio: 'inherit', timeout: 90000,
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
