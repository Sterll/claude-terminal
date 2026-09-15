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
const applicationRoots = [];
const systemRoots = (process.platform === 'win32'
  ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles || 'C:\\Program Files', process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', process.env.ProgramData || 'C:\\ProgramData']
  : ['/etc', '/bin', '/sbin', '/usr', '/sys', '/proc', '/dev', ...(process.platform === 'darwin' ? ['/Library/System', '/System'] : ['/boot', '/lib', '/lib64'])])
  .map(root => { try { return canonical(root); } catch { return path.resolve(root); } });
const inside = (file, root) => {
  if (process.platform === 'win32') { file = file.toLowerCase(); root = root.toLowerCase(); }
  return file === root || file.startsWith(root + path.sep);
};
function grant(file, { write = true, directory = true } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return;
  const root = canonical(file);
  if (!grants.some(item => item.root === root && item.write === write && item.directory === directory)) grants.push({ root, write, directory });
}
function permitted(file, write = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) return false;
  try {
    const target = canonical(file);
    if (process.platform === 'win32' && file.startsWith('\\\\')) return false;
    // Keep the system-directory protection; packaged application resources are
    // the only read exception (e.g. an installation under Program Files).
    if (systemRoots.some(root => inside(target, root)) && (write || !applicationRoots.some(root => inside(target, root)))) return false;
    // Keep upstream's credential/startup guards when moving I/O into main.
    // A project or dialog grant must not override these boundaries.
    const home = os.homedir();
    const blocked = ['.ssh', '.aws', '.gnupg', '.claude/.credentials.json'].map(name => path.join(home, name));
    if (write) {
      blocked.push(...['.bashrc', '.bash_profile', '.zshrc', '.zshenv', '.profile', '.claude.json'].map(name => path.join(home, name)));
      if (process.platform === 'win32' && process.env.APPDATA) blocked.push(path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup'));
      else if (process.platform === 'darwin') blocked.push(path.join(home, 'Library/LaunchAgents'));
      else blocked.push(path.join(home, '.config/autostart'));
    }
    if (blocked.some(file => inside(target, canonical(file)))) return false;
    return grants.some(item => (!write || item.write) && (target === item.root || item.directory && target.startsWith(item.root + path.sep)));
  } catch { return false; }
}
function install(ipcMain) {
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
  const appRoot = path.resolve(__dirname, '../../..');
  grant(appRoot, { write: false }); applicationRoots.push(canonical(appRoot));
  if (process.resourcesPath) { grant(process.resourcesPath, { write: false }); applicationRoots.push(canonical(process.resourcesPath)); }
  try {
    const projects = JSON.parse(fs.readFileSync(path.join(data, 'projects.json'), 'utf8'));
    for (const project of projects.projects || []) {
      grant(project.path);
      for (const worktree of project.worktrees || []) grant(worktree.path);
    }
  } catch { /* New installations have no projects yet. */ }
  require('./rendererFiles').install(ipcMain, permitted);
  ipcMain.on('fs-authorize', (event, file, write) => { event.returnValue = permitted(file, !!write); });
  ipcMain.on('window-read-data', (event, kind) => {
    const files = { projects: 'projects.json', workflows: 'workflows/definitions.json', settings: 'settings.json' };
    try { event.returnValue = files[kind] ? JSON.parse(fs.readFileSync(path.join(data, files[kind]), 'utf8')) : null; }
    catch { event.returnValue = null; }
  });
}
module.exports = { install, guardWindow, isTrusted, allowMainDocument, allowMicrophone, grant, permitted };
