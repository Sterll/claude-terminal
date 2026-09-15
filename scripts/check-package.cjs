'use strict';
// Check the actual artifact with its bundled runtime, including native module loading.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pkg = require('../package.json');
function findArchive(dir, depth = 0) {
  if (depth > 5) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.name === 'app.asar') return file;
    if (entry.isDirectory()) { const found = findArchive(file, depth + 1); if (found) return found; }
  }
}
const archive = findArchive(path.resolve(__dirname, '../build'));
if (!archive) throw new Error('No packaged app.asar found');
const resources = path.dirname(archive);
const executable = process.platform === 'darwin'
  ? path.join(resources, '../MacOS/Claude Terminal')
  : path.join(resources, '..', process.platform === 'win32' ? 'Claude Terminal.exe' : pkg.name);
const script = `
  const fs = require('node:fs'), path = require('node:path'), resources = process.argv[1];
  for (const file of ['app.asar/src/main/preload.js', 'app.asar/src/shared/workflow-condition.js',
    'app.asar/dist/pdf-viewer.bundle.js', 'mcp-servers/claude-terminal-mcp.js',
    'mcp-servers/shared/database-credentials.js', 'mcp-servers/shared/workflow-condition.js',
    'mcp-servers/workflow-nodes/condition.node.js']) {
    if (!fs.existsSync(path.join(resources, file))) throw new Error('Missing ' + file);
  }
  const modulePath = name => path.join(resources, 'app.asar/node_modules', name);
  const db = new (require(modulePath('better-sqlite3')))(':memory:');
  if (db.prepare('select 42 as value').get().value !== 42) throw new Error('SQLite failed');
  db.close();
  require(modulePath('keytar'));
  require(modulePath('node-pty'));
  console.log('PASS packaged resources and native modules');
`;
execFileSync(executable, ['-e', script, resources], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 30000 });
