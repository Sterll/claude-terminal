'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const trusted = new WeakMap();
let installed = false;

function documentUrl(value) {
  try {
    const url = new URL(value); url.hash = ''; url.search = '';
    // Chromium leaves '~' literal while Node's pathToFileURL encodes it.
    return url.protocol === 'file:' ? pathToFileURL(fileURLToPath(url)).href : url.href;
  }
  catch { return ''; }
}
function guardWindow(window, htmlPath) {
  const expected = pathToFileURL(htmlPath).href;
  trusted.set(window.webContents, expected);
  const block = (event, url) => { if (documentUrl(url) !== expected) event.preventDefault(); };
  window.webContents.on('will-navigate', block);
  window.webContents.on('will-redirect', block);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
function isTrusted(event) {
  return !!event?.senderFrame && event.senderFrame === event.sender?.mainFrame &&
    trusted.has(event.sender) && documentUrl(event.senderFrame.url) === trusted.get(event.sender);
}
function allowMainDocument(webContents, details = {}, origin) {
  const expected = trusted.get(webContents);
  if (!expected?.endsWith('/index.html') || documentUrl(webContents.getURL()) !== expected) return false;
  if (origin && origin !== 'file://' && documentUrl(origin) !== expected) return false;
  if (details.requestingUrl && documentUrl(details.requestingUrl) !== expected) return false;
  if (details.isMainFrame === false) return false;
  return true;
}
function allowMicrophone(webContents, details = {}, origin) {
  if (!allowMainDocument(webContents, details, origin)) return false;
  return details.mediaTypes ? details.mediaTypes.length > 0 && details.mediaTypes.every(type => type === 'audio') : details.mediaType === 'audio';
}

// Resolve existing ancestors too: a new child under a symlink must not escape.
function canonical(file) {
  let cursor = path.resolve(file); const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cursor), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor)); cursor = parent;
    }
  }
}
const grants = [];
function grant(file, { write = true, directory = true } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return;
  const root = canonical(file);
  if (!grants.some(item => item.root === root && item.write === write && item.directory === directory)) grants.push({ root, write, directory });
}
function permitted(file, write = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return false;
  try {
    const target = canonical(file);
    return grants.some(item => (!write || item.write) && (target === item.root || item.directory && target.startsWith(item.root + path.sep)));
  } catch { return false; }
}
function install(ipcMain) {
  // Deliberate: `ipcMain.handle` and `ipcMain.on` are wrapped once, here, so
  // every one of the app's handlers is gated without any of them opting in.
  // Adding the check to each registration site instead would mean a new
  // handler is unguarded by default, which is the wrong way round for a
  // privilege boundary.
  //
  // The cost is that this one function decides reachability for all of them,
  // and a handler that legitimately needs a different sender will fail with a
  // confusing "Untrusted IPC sender" far from its own code. There is no opt-out
  // flag on purpose: if you hit that, register the extra frame through
  // `guardWindow()` so it becomes a trusted document, rather than punching a
  // hole through here.
  if (installed) return; installed = true;
  const wrappers = new WeakMap();
  for (const method of ['handle', 'on']) {
    const register = ipcMain[method].bind(ipcMain);
    ipcMain[method] = (channel, listener) => {
      const wrapped = (event, ...args) => {
      if (!isTrusted(event)) {
        if (method === 'handle') throw new Error('Untrusted IPC sender');
        event.returnValue = false; return;
      }
      return listener(event, ...args);
      };
      if (method === 'on') {
        if (!wrappers.has(listener)) wrappers.set(listener, new Map());
        wrappers.get(listener).set(channel, wrapped);
      }
      return register(channel, wrapped);
    };
  }
  const removeListener = ipcMain.removeListener.bind(ipcMain);
  ipcMain.removeListener = ipcMain.off = (channel, listener) => removeListener(channel, wrappers.get(listener)?.get(channel) || listener);
  const home = os.homedir(), data = path.join(home, '.claude-terminal');
  grant(data); grant(path.join(home, '.claude'));
  grant(path.join(home, '.claude.json'), { directory: false, write: false });
  grant(path.resolve(__dirname, '../../..'), { write: false });
  if (process.resourcesPath) grant(process.resourcesPath, { write: false });
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(data, 'projects.json'), 'utf8'));
    for (const project of projects.projects || []) {
      grant(project.path);
      for (const worktree of project.worktrees || []) grant(worktree.path);
    }
  } catch { /* New installations have no projects yet. */ }
  ipcMain.on('fs-authorize', (event, file, write) => { event.returnValue = permitted(file, !!write); });
  ipcMain.on('window-read-data', (event, kind) => {
    const files = { projects: 'projects.json', workflows: 'workflows/definitions.json', settings: 'settings.json' };
    try { event.returnValue = files[kind] ? JSON.parse(fs.readFileSync(path.join(data, files[kind]), 'utf8')) : null; }
    catch { event.returnValue = null; }
  });
}
module.exports = { install, guardWindow, isTrusted, allowMainDocument, allowMicrophone, grant, permitted };
