'use strict';
// Run with Electron, not the developer's Node. All files live in a temporary home.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { format } = require('node:util');
const { app, BrowserWindow } = require('electron');

// macOS is the one platform where Node's stdio pipes are asynchronous, so under
// CI every line still queued when this process dies is lost - including the
// error `finish()` prints immediately before `app.exit()`, and everything a
// native abort takes down with it. That is not a detail: the only failure this
// script has ever had arrived as a bare `libc++abi: terminating due to uncaught
// exception of type Napi::Error`, written straight to the fd by the C++
// runtime, with not one of our own lines to say where it happened. Write every
// diagnostic to the descriptor ourselves so nothing depends on the loop turning
// again.
function writeSync(fd, args) {
  const buffer = Buffer.from(format(...args) + '\n');
  for (let offset = 0, attempts = 0; offset < buffer.length && attempts < 10000; attempts++) {
    try {
      offset += fs.writeSync(fd, buffer, offset);
    } catch (error) {
      // EAGAIN is a full non-blocking pipe: the runner drains it in a moment.
      if (error.code !== 'EAGAIN') return;
    }
  }
}
console.log = (...args) => writeSync(1, args);
console.error = (...args) => writeSync(2, args);

const temporary = process.argv[2];
if (!temporary) throw new Error('Run npm run test:runtime so the parent can clean up the profile after Electron exits');
const originalHome = os.homedir;
os.homedir = () => temporary;
app.on('window-all-closed', () => {});
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, file, error) => console.error('Preload failed:', file, error));
  contents.on('console-message', details => {
    if (details.level === 'error') console.error('Renderer:', details.message);
  });
});
app.setPath('userData', path.join(temporary, 'electron'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) { if (Date.now() > deadline) throw new Error(message); await wait(30); }
}
const deadline = setTimeout(() => { console.error('Runtime smoke timed out'); app.exit(1); }, 60000);
let window, scheduler, remote;

// Only the `whenReady()` chain below reports its own failures. Anything thrown
// from a listener, a timer or a native callback reaches Electron's default
// handler instead, which prints and exits - one more queued write for macOS to
// drop. Report it here, while stdout is still ours.
process.on('uncaughtException', error => { console.error('Uncaught exception:', error); finish(1); });
process.on('unhandledRejection', error => { console.error('Unhandled rejection:', error); finish(1); });

app.whenReady().then(async () => {
  console.log('Runtime:', JSON.stringify(process.versions));
  const db = new (require('better-sqlite3'))(':memory:');
  assert.equal(db.prepare('select 42 as value').get().value, 42); db.close();
  assert.equal(typeof require('keytar').getPassword, 'function');
  assert.match(require('marked').marked('**ok**'), /strong/);
  console.log('PASS native SQLite in the main process, keytar load and marked');
  // Exercise a console shell in the PTY; Electron's Windows executable is a GUI binary.
  const windows = process.platform === 'win32';
  const pty = require('node-pty').spawn(windows ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
    windows ? '/d /c echo PTY_SMOKE_OK' : ['-c', 'printf PTY_SMOKE_OK'], {
    cwd: temporary, env: process.env,
  });
  // node-pty rethrows any socket error that is not EAGAIN or EIO out of its own
  // handler unless the terminal carries an 'error' listener of its own, and a
  // read error on the master fd of a shell that has just exited is routine.
  // Uncaught, it lands while node-pty's exit callback is still queued on an
  // N-API ThreadSafeFunction, and that dispatch then fails with a C++
  // Napi::Error nothing catches - the libc++abi abort, with no JS stack.
  pty.on('error', error => console.error('PTY socket error:', error && error.message));
  let output = '';
  pty.onData(chunk => { output += chunk; });
  // Settle on the next tick, not inside node-pty's native frame: anything this
  // test throws while that frame is on the stack aborts the process instead of
  // failing an assertion.
  const exit = await new Promise(resolve => pty.onExit(event => setImmediate(() => resolve(event))));
  assert.equal(exit.exitCode, 0, `PTY exited ${exit.exitCode} (signal ${exit.signal})`);
  assert.match(output, /PTY_SMOKE_OK/);
  console.log('PASS PTY shell round trip');
  const childQuery = require('node:child_process').execFileSync(process.execPath, ['-e', `const db = new (require(${JSON.stringify(require.resolve('better-sqlite3'))}))(':memory:'); console.log(db.prepare('select 42 as value').get().value); db.close();`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.equal(childQuery.trim(), '42');
  console.log('PASS native SQLite in the MCP runtime');

  const Scheduler = require('../src/main/services/WorkflowScheduler');
  scheduler = new Scheduler();
  const events = [];
  scheduler.dispatch = (id, data) => events.push({ id, data });
  const repo = path.join(temporary, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git/logs'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(repo, '.git/logs/HEAD'), '');
  scheduler.resolveProjectPath = () => repo;
  scheduler.reload([
    { id: 'file', enabled: true, trigger: { type: 'file_change', projectId: 'p', patterns: '**/*.js', debounceMs: 20 } },
    { id: 'git', enabled: true, trigger: { type: 'git_event', projectId: 'p', eventFilter: 'any' } },
  ]);
  const watchers = [...scheduler._fileWatchers.values(), ...scheduler._gitWatchers.values()];
  assert.equal(watchers.length, 2);
  await Promise.all(watchers.map(entry => once(entry.watcher, 'ready')));
  // macOS may coalesce the directory's creation with the first write.
  await wait(250);
  fs.writeFileSync(path.join(repo, 'src/ignored.txt'), 'ignore');
  fs.writeFileSync(path.join(repo, 'src/été.js'), 'match');
  fs.appendFileSync(path.join(repo, '.git/logs/HEAD'), 'old new User <u@example.test> 1 +0000\tcommit: smoke\n');
  await until(() => events.some(e => e.id === 'file') && events.some(e => e.id === 'git'), 'File or Git trigger did not fire').catch(error => { console.error('Observed triggers:', events); throw error; });
  assert(events.filter(e => e.id === 'file').every(e => e.data.paths.every(p => p.endsWith('.js'))));
  scheduler.destroy(); scheduler = null;
  console.log('PASS real file/glob and Git watchers');

  // Exercise the shipped lazy viewer with a minimal, two-page PDF.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 5 0 R >>',
    '<< /Length 24 >>\nstream\n0 0 1 rg 10 10 80 80 re f\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const pdfPath = path.join(temporary, 'test.pdf'); fs.writeFileSync(pdfPath, pdf);
  const html = path.join(temporary, 'viewer.html');
  fs.writeFileSync(html, '<style>.file-viewer-pdf-pages{height:500px;overflow:auto}</style><div id="pdf"><div class="file-viewer-pdf-toolbar"></div><div class="file-viewer-pdf-pages"></div></div>');
  window = new BrowserWindow({ show: false, width: 800, height: 700, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadFile(html);
  await window.webContents.executeJavaScript(`import(${JSON.stringify(pathToFileURL(path.resolve(__dirname, '../dist/pdf-viewer.bundle.js')).href)}).then(m => { window.viewer = m.renderPdf(document.querySelector('#pdf'), ${JSON.stringify(pathToFileURL(pdfPath).href)}); })`);
  await until(() => window.webContents.executeJavaScript(`document.querySelectorAll('canvas[data-rendered="1.5"]').length === 2`), 'PDF did not render two pages');
  await window.webContents.executeJavaScript(`document.querySelector('.pdf-next').click(); document.querySelector('.pdf-zoom-in').click();`);
  await until(() => window.webContents.executeJavaScript(`document.querySelector('canvas[data-rendered="2"]') !== null`), 'PDF zoom did not render');
  await window.webContents.executeJavaScript('window.viewer.destroy()');
  window.destroy(); window = null;
  console.log('PASS shipped PDF viewer: open, pages, zoom, close');

  const security = require('../src/main/utils/rendererSecurity');
  const { ipcMain } = require('electron');
  security.install(ipcMain);
  const dataDir = path.join(temporary, '.claude-terminal');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'allowed.txt'), 'allowed');
  fs.writeFileSync(path.join(temporary, 'private.txt'), 'private');
  const fixture = path.join(temporary, 'index.html'); fs.writeFileSync(fixture, '<p>Boundary smoke</p>');
  window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.resolve(__dirname, '../src/main/preload.js') } });
  security.guardWindow(window, fixture);
  await window.loadFile(fixture);
  console.log('Boundary fixture:', window.webContents.getURL(), 'permitted:', security.permitted(path.join(dataDir, 'allowed.txt')));
  const boundary = await window.webContents.executeJavaScript(`(async () => {
    try {
    const fs = window.electron_nodeModules.fs;
    const result = { allowed: fs.readFileSync(${JSON.stringify(path.join(dataDir, 'allowed.txt'))}, 'utf8') };
    try { fs.readFileSync(${JSON.stringify(path.join(temporary, 'private.txt'))}, 'utf8'); } catch { result.denied = true; }
    try { fs.writeFileSync(${JSON.stringify(path.resolve(__dirname, '../package.json'))}, 'blocked'); } catch { result.appWriteDenied = true; }
    const target = ${JSON.stringify(path.join(dataDir, 'async.txt'))};
    await fs.promises.writeFile(target, 'sandbox');
    result.asyncRead = await fs.promises.readFile(target, 'utf8');
    result.file = (await fs.promises.stat(target)).isFile();
    result.nativePath = window.electron_nodeModules.path.join('one', 'two');
    result.nodeUnavailable = typeof require === 'undefined' && typeof process === 'undefined';
    return result;
    } catch (error) { return { error: error.message }; }
  })()`);
  assert.deepEqual(boundary, { allowed: 'allowed', denied: true, appWriteDenied: true, asyncRead: 'sandbox', file: true, nativePath: path.join('one', 'two'), nodeUnavailable: true });
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  window.destroy(); window = null;
  for (const [htmlName, preload, apiName, read] of [
    ['quick-picker.html', 'preload-quickpicker.js', 'pickerAPI', 'readProjects'],
    ['notification.html', 'preload-notification.js', 'notifAPI', 'readSettingsAccentColor'],
  ]) {
    const page = path.join(temporary, htmlName); fs.writeFileSync(page, '<p>Sandbox smoke</p>');
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.resolve(__dirname, '../src/main', preload) } });
    security.guardWindow(window, page); await window.loadFile(page);
    await window.webContents.executeJavaScript(`window.${apiName}.${read}()`);
    window.destroy(); window = null;
  }
  console.log('PASS real preload path grants, read-only app files and sandboxed secondary preloads');

  await require('./chat-scroll-smoke.cjs')(temporary);

  // Stub only unrelated chat/catalog work; HTTP, WS, token and socket lifecycles are real.
  const Module = require('node:module'); const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename.endsWith('RemoteServer.js') && request === './ChatService') return { setRemoteEventCallback() {}, getActiveSessions: () => [] };
    if (parent?.filename.endsWith('RemoteServer.js') && request === './ModelCatalogService') return { getCatalog: async () => ({}) };
    return originalLoad.apply(this, arguments);
  };
  const http = require('node:http'); const createServer = http.createServer; let server;
  http.createServer = (...args) => (server = createServer(...args));
  remote = require('../src/main/services/RemoteServer');
  try {
    remote.start(null, 0);
    http.createServer = createServer;
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const pin = await remote.generatePin();
    const response = await fetch(origin + '/auth', { method: 'POST', body: JSON.stringify({ pin }) });
    const { token } = await response.json(); assert(token);
    const WebSocket = require('ws');
    const connect = async () => {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + '/?token=' + token);
      await once(ws, 'open'); return ws;
    };
    const first = await connect(); first.terminate(); await once(first, 'close');
    const second = await connect(); await wait(100);
    assert.equal(remote.getConnectedClients().length, 1);
    const third = await connect(); await wait(100);
    assert.equal(remote.getConnectedClients().length, 1, 'Old socket removed its replacement');
    const closed = once(third, 'close');
    assert(remote.disconnectClient(token.slice(0, 8))); await closed;
    const rejected = await connect();
    const [code] = await once(rejected, 'close'); assert.equal(code, 4401);
    second.terminate();
    console.log('PASS remote reconnect, socket replacement and explicit revocation');
  } finally { await remote.stop(); remote = null; Module._load = originalLoad; http.createServer = createServer; }
}).then(() => finish(0), error => { console.error(error); finish(1); });

// The first verdict wins: a failure reported by the handlers above can land
// while this is already tearing the fixtures down, and exiting twice loses it.
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  try {
    scheduler?.destroy(); if (remote) await remote.stop(); window?.destroy();
    os.homedir = originalHome;
  } finally { app.exit(code); }
}
