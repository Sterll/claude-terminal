/**
 * "Open in editor" must either open the editor or say why it did not.
 *
 * The old handler spawned the editor, returned `{ success: true }`, and
 * attached an `error` listener that logged to the main process console. A
 * missing binary raises that error asynchronously, so the answer was already
 * on its way back before anything knew the launch had failed, and the bridge
 * was `send` anyway, which discards it. The user's experience of an editor
 * that is not on PATH was a button that did nothing at all.
 *
 * On macOS that is the *default* state of a fresh VS Code install: `code` only
 * reaches PATH once the user runs "Shell Command: Install 'code' in PATH" by
 * hand. So darwin also gets a fallback to the application bundle, which is
 * installed by definition.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

// Prefixed `mock*` so Jest's hoisting of jest.mock() lets the factory close
// over them.
const mockSpawnState = { calls: [], child: null };

jest.mock('child_process', () => ({
  spawn: (...args) => {
    const { EventEmitter: EE } = require('events');
    mockSpawnState.calls.push(args);
    const child = new EE();
    child.unref = jest.fn();
    mockSpawnState.child = child;
    return child;
  },
}));

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), on: jest.fn(), removeHandler: jest.fn() },
  dialog: {},
  shell: {},
  app: { getPath: () => '/tmp', getVersion: () => '0.0.0' },
  clipboard: {},
  BrowserWindow: { fromWebContents: jest.fn() },
}));
jest.mock('../../src/main/utils/rendererSecurity', () => ({ grant: jest.fn(), install: jest.fn() }));
jest.mock('../../src/main/services/UpdaterService', () => ({}));

const dialogIpc = require('../../src/main/ipc/dialog.ipc');

// `openInEditor` is internal; reach it through the registered `handle`.
const { ipcMain } = require('electron');
const handlers = {};
ipcMain.handle.mockImplementation((channel, handler) => { handlers[channel] = handler; });
ipcMain.on.mockImplementation(() => {});
dialogIpc.registerDialogHandlers();
const openInEditor = (params) => handlers['open-in-editor']({}, params);

const realPlatform = process.platform;
function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

let tmpBin;
let originalPath;

beforeAll(() => {
  tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-editor-'));
  originalPath = process.env.PATH;
});

afterAll(() => {
  setPlatform(realPlatform);
  process.env.PATH = originalPath;
  fs.rmSync(tmpBin, { recursive: true, force: true, maxRetries: 5 });
});

beforeEach(() => {
  mockSpawnState.calls.length = 0;
  process.env.PATH = tmpBin;
});

/** Put an executable of that name on the PATH the resolver walks. */
function installShim(name) {
  const p = path.join(tmpBin, name);
  fs.writeFileSync(p, '#!/bin/sh\n');
  fs.chmodSync(p, 0o755);
  return p;
}

describe('darwin', () => {
  beforeEach(() => setPlatform('darwin'));

  test('a missing CLI shim falls back to the application bundle', async () => {
    const promise = openInEditor({ editor: 'code', path: '/p/a.js' });
    mockSpawnState.child.emit('spawn');
    mockSpawnState.child.emit('close', 0);
    await expect(promise).resolves.toEqual({ success: true, editor: 'code' });

    expect(mockSpawnState.calls[0][0]).toBe('/usr/bin/open');
    expect(mockSpawnState.calls[0][1]).toEqual(['-a', 'Visual Studio Code', '/p/a.js']);
  });

  test('an installed CLI shim is used directly, bundle untouched', async () => {
    installShim('code');

    const promise = openInEditor({ editor: 'code', path: '/p/a.js' });
    mockSpawnState.child.emit('spawn');
    await expect(promise).resolves.toEqual({ success: true, editor: 'code' });

    expect(mockSpawnState.calls[0][0]).toBe('code');
    expect(mockSpawnState.calls[0][1]).toEqual(['/p/a.js']);
  });

  test('an editor with no bundle mapping is still spawned, so the caller gets a real error', async () => {
    const promise = openInEditor({ editor: 'my-editor', path: '/p/a.js' });
    mockSpawnState.child.emit('error', Object.assign(new Error('spawn my-editor ENOENT'), { code: 'ENOENT' }));

    await expect(promise).resolves.toEqual(
      expect.objectContaining({ success: false, editor: 'my-editor' })
    );
    expect(mockSpawnState.calls[0][0]).toBe('my-editor');
  });

  test('a bundle that is not installed is reported, not swallowed', async () => {
    const promise = openInEditor({ editor: 'zed', path: '/p/a.js' });
    mockSpawnState.child.emit('spawn');
    mockSpawnState.child.emit('close', 1);

    await expect(promise).resolves.toEqual(
      expect.objectContaining({ success: false, editor: 'zed' })
    );
  });
});

describe('every platform', () => {
  beforeEach(() => setPlatform('linux'));

  test('a launch failure comes back as success:false', async () => {
    const promise = openInEditor({ editor: 'code', path: '/p/a.js' });
    mockSpawnState.child.emit('error', new Error('spawn code ENOENT'));

    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toContain('ENOENT');
  });

  test('a launch that starts comes back as success:true', async () => {
    const promise = openInEditor({ editor: 'code', path: '/p/a.js' });
    mockSpawnState.child.emit('spawn');

    await expect(promise).resolves.toEqual({ success: true, editor: 'code' });
  });

  test('the child is unreferenced so it cannot hold the event loop open', async () => {
    const promise = openInEditor({ editor: 'code', path: '/p/a.js' });
    const child = mockSpawnState.child;
    child.emit('spawn');
    await promise;

    expect(child.unref).toHaveBeenCalled();
  });

  test('a missing path is refused without spawning anything', async () => {
    await expect(openInEditor({ editor: 'code', path: '' })).resolves.toEqual(
      expect.objectContaining({ success: false })
    );
    expect(mockSpawnState.calls).toHaveLength(0);
  });

  test('a path with shell metacharacters is still refused', async () => {
    await expect(openInEditor({ editor: 'code', path: '/p/a.js; rm -rf /' })).resolves.toEqual(
      expect.objectContaining({ success: false })
    );
    expect(mockSpawnState.calls).toHaveLength(0);
  });
});
