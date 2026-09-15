/** @jest-environment node */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
let dir, ipc, asyncHandlers;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-files-'));
  ipc = new EventEmitter(); asyncHandlers = new Map();
  ipc.handle = (name, fn) => asyncHandlers.set(name, fn);
  require('../../src/main/utils/rendererFiles').install(ipc, (file, write) =>
    typeof file === 'string' && file.startsWith(dir + path.sep) && (!write || !file.endsWith('readonly')));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
function sync(method, ...args) { const event = {}; ipc.emit('renderer-fs-sync', event, method, args); return event.returnValue; }
const call = (method, ...args) => asyncHandlers.get('renderer-fs')({}, method, args);
test('sync and async bridge preserve bytes, directory metadata and native error codes', async () => {
  const file = path.join(dir, 'data');
  expect((await call('writeFile', file, new Uint8Array([0, 128, 255]))).ok).toBe(true);
  expect([...sync('readFile', file).value]).toEqual([0, 128, 255]);
  expect((await call('stat', file)).value).toMatchObject({ file: true, directory: false, size: 3 });
  expect(sync('readdir', dir + path.sep, { withFileTypes: true }).value).toEqual([{ name: 'data', file: true, directory: false }]);
  expect((await call('rename', file, file + '-moved')).ok).toBe(true);
  expect(sync('readFile', file).error.code).toBe('ENOENT');
});
test('read-only grants cannot be bypassed with flags, copying or renaming', async () => {
  const file = path.join(dir, 'readonly'); fs.writeFileSync(file, 'keep');
  for (const flag of ['w', 'w+', 'a', 'r+', 2, 512]) {
    expect(sync('readFile', file, { flag }).error.code).toBe('EACCES');
    expect((await call('readFile', file, { flag })).error.code).toBe('EACCES');
  }
  expect(sync('copyFile', file, file).error.code).toBe('EACCES');
  expect((await call('rename', file, path.join(dir, 'other'))).error.code).toBe('EACCES');
  expect(fs.readFileSync(file, 'utf8')).toBe('keep');
  expect(sync('readFile', 1).ok).toBe(false);
  expect(sync('open', file).ok).toBe(false);
  expect(sync('constructor').ok).toBe(false);
});
