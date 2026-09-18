'use strict';

// The sandboxed preload has no filesystem access. Keep the compatibility API
// small, with authorization on every path in the main process.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
/** Mirrored in `src/main/preload.js`; see the note there. */
const PATH_METHODS = ['join', 'dirname', 'basename', 'relative', 'resolve', 'extname', 'normalize', 'isAbsolute'];
const operations = {
  exists: [false], readFile: [false], readdir: [false], stat: [false], access: [false],
  writeFile: [true], mkdir: [true], rm: [true], unlink: [true],
  copyFile: [false, true], rename: [true, true],
};
function serialize(method, value, args) {
  const entry = item => ({ name: item.name, directory: item.isDirectory(), file: item.isFile() });
  if (method === 'stat') return { ...entry(value), size: value.size, mtime: value.mtime };
  if (method === 'readdir' && args[1]?.withFileTypes) return value.map(entry);
  return value;
}
function validate(permitted, method, args) {
  if (!Object.hasOwn(operations, method) || !Array.isArray(args)) throw new Error('Unsupported filesystem operation');
  operations[method].forEach((write, index) => {
    if (!permitted(args[index], write)) throw Object.assign(new Error('Access denied: path is outside authorized project/app data'), { code: 'EACCES' });
  });
  // readFile accepts open flags, including flags that truncate files. The read
  // grant must never let those options turn a read into a write.
  if (method === 'readFile' && args[1]?.flag !== undefined && !['r', 'rs', 'sr'].includes(args[1].flag)) {
    throw Object.assign(new Error('readFile requires a read-only flag'), { code: 'EACCES' });
  }
}
function failure(error) { return { ok: false, error: { message: error.message, code: error.code } }; }
function install(ipcMain, permitted) {
  ipcMain.on('renderer-bootstrap', event => {
    event.returnValue = { homedir: os.homedir(), platform: process.platform, resourcesPath: process.resourcesPath || '',
      appRoot: path.resolve(__dirname, '../../..'), sep: path.sep,
      env: { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, APPDATA: process.env.APPDATA } };
  });
  ipcMain.on('renderer-path', (event, method, args) => {
    try {
      // Pure string operations, no filesystem access, so no path grant is
      // required — but the list still has to match the one the preload
      // exposes, or a renderer call lands on `undefined` and throws. Kept in
      // agreement by tests/security/rendererBridgeSurface.test.js.
      if (!PATH_METHODS.includes(method) || !Array.isArray(args)) throw new Error('Unsupported path operation');
      event.returnValue = { ok: true, value: path[method](...args) };
    } catch (error) { event.returnValue = failure(error); }
  });
  ipcMain.on('renderer-fs-sync', (event, method, args) => {
    try {
      validate(permitted, method, args);
      event.returnValue = { ok: true, value: serialize(method, fs[method + 'Sync'](...args), args) };
    } catch (error) { event.returnValue = failure(error); }
  });
  ipcMain.handle('renderer-fs', async (_event, method, args) => {
    try {
      validate(permitted, method, args);
      if (method === 'exists') throw new Error('Use access for asynchronous existence checks');
      return { ok: true, value: serialize(method, await fs.promises[method](...args), args) };
    } catch (error) { return failure(error); }
  });
}
module.exports = { install, PATH_METHODS };
