/**
 * @jest-environment node
 *
 * The explorer's watcher for remote (SSH) directories (design/remote-ssh.md
 * section 5.5). chokidar cannot watch a path on another machine, so expanded
 * remote directories are listed in one batched request per host, diffed, and
 * the differences go out as the very `explorer:changes` payloads chokidar's
 * watchers produce. Pinned here, with fake timers:
 *
 *  - the payload shape is chokidar's, key for key;
 *  - nothing is asked while the explorer is hidden or the window unfocused;
 *  - nothing is asked of a host that is not connected, and the first listing
 *    after it comes back reports what changed meanwhile (the resync);
 *  - one request per host per tick, however many directories are expanded;
 *  - inotifywait, when the host has it, replaces the poll;
 *  - explorer.ipc.js routes a URI to the poller and never to chokidar.
 */

const { EventEmitter } = require('events');
const { createRemoteDirPoller, inotifyScript, POLL_MS } = require('../../src/main/utils/remoteDirPoller');
const remotePath = require('../../src/shared/remote-path');

const PID = 'abcd1234';
const uri = (p) => remotePath.format(PID, p);

/** A host whose directory tree is a plain object, edited by the tests. */
function makeHost({ tools = [] } = {}) {
  const service = new EventEmitter();
  service.state = 'connected';
  service.getStatus = jest.fn(() => ({ profileId: PID, state: service.state, capabilities: { home: '/home/y', tools } }));
  service.runner = jest.fn(() => ({}));
  service.oneShot = jest.fn(() => new Promise(() => {}));
  const tree = new Map(); // dir -> Map<name, isDirectory>
  const requests = [];
  const createFs = () => ({
    listDirs: jest.fn(async (dirs) => {
      requests.push(dirs.slice());
      const out = new Map();
      for (const d of dirs) {
        const entries = tree.get(d);
        out.set(d, entries ? { missing: false, entries: [...entries].map(([name, isDirectory]) => ({ name, isDirectory })) } : { missing: true, entries: [] });
      }
      return out;
    }),
  });
  const setState = (state) => {
    service.state = state;
    service.emit('status', { profileId: PID, state });
  };
  return { service, tree, requests, createFs, setState };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('remote directory poller', () => {
  let host, emitted, active, poller;

  beforeEach(() => {
    jest.useFakeTimers();
    host = makeHost();
    host.tree.set('/home/y/api', new Map([['a.txt', false], ['src', true]]));
    host.tree.set('/home/y/api/src', new Map([['index.js', false]]));
    emitted = [];
    active = true;
    poller = createRemoteDirPoller({
      service: host.service,
      authorize: async (u) => ({ profileId: PID, path: remotePath.parse(u).path }),
      isActive: () => active,
      emit: (changes) => emitted.push(changes),
      createFs: host.createFs,
    });
  });

  afterEach(() => {
    poller.dispose();
    jest.useRealTimers();
  });

  test('changes go out in chokidar\'s shape: { type, path, isDirectory } with the child URI', async () => {
    await poller.watch(uri('/home/y/api'));
    await flush(); // baseline
    host.tree.get('/home/y/api').set('new.md', false);
    host.tree.get('/home/y/api').set('lib', true);
    host.tree.get('/home/y/api').delete('a.txt');
    jest.advanceTimersByTime(POLL_MS);
    await flush();
    expect(emitted).toHaveLength(1);
    const changes = emitted[0];
    for (const c of changes) expect(Object.keys(c).sort()).toEqual(['isDirectory', 'path', 'type']);
    expect(changes).toEqual(expect.arrayContaining([
      { type: 'remove', path: uri('/home/y/api/a.txt'), isDirectory: false },
      { type: 'add', path: uri('/home/y/api/new.md'), isDirectory: false },
      { type: 'add', path: uri('/home/y/api/lib'), isDirectory: true },
    ]));
    expect(changes).toHaveLength(3);
  });

  test('one request per host per tick, whatever the number of expanded directories', async () => {
    await poller.watch(uri('/home/y/api'));
    await poller.watch(uri('/home/y/api/src'));
    await flush();
    host.requests.length = 0;
    jest.advanceTimersByTime(POLL_MS);
    await flush();
    expect(host.requests).toEqual([['/home/y/api', '/home/y/api/src']]);
  });

  test('nothing is asked while the explorer is hidden or the window unfocused', async () => {
    active = false;
    await poller.watch(uri('/home/y/api'));
    jest.advanceTimersByTime(POLL_MS * 5);
    await flush();
    expect(host.requests).toHaveLength(0);
    active = true;
    poller.kick();
    await flush();
    expect(host.requests).toHaveLength(1);
  });

  test('polling stops on disconnect and resyncs what changed once the host is back', async () => {
    await poller.watch(uri('/home/y/api'));
    await flush();
    host.requests.length = 0;
    host.setState('reconnecting');
    host.tree.get('/home/y/api').set('while-away.txt', false);
    jest.advanceTimersByTime(POLL_MS * 4);
    await flush();
    expect(host.requests).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    host.setState('connected');
    await flush();
    expect(host.requests).toHaveLength(1);
    expect(emitted).toEqual([[{ type: 'add', path: uri('/home/y/api/while-away.txt'), isDirectory: false }]]);
  });

  test('an unwatched directory is no longer listed, and an empty set stops the timer', async () => {
    await poller.watch(uri('/home/y/api'));
    await flush();
    poller.unwatch(uri('/home/y/api'));
    host.requests.length = 0;
    jest.advanceTimersByTime(POLL_MS * 3);
    await flush();
    expect(host.requests).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a directory of a protected path is never listed', async () => {
    host.tree.set('/home/y/.ssh', new Map([['id_ed25519', false]]));
    await poller.watch(uri('/home/y/.ssh'));
    await flush();
    jest.advanceTimersByTime(POLL_MS);
    await flush();
    expect(host.requests.flat()).not.toContain('/home/y/.ssh');
  });

  test('a renderer that goes away releases its directories', async () => {
    await poller.watch(uri('/home/y/api'), 7);
    await poller.watch(uri('/home/y/api/src'), 8);
    poller.unwatchOwner(7);
    expect([...poller._dirs.keys()]).toEqual([uri('/home/y/api/src')]);
  });
});

describe('inotifywait when the host has it', () => {
  afterEach(() => jest.useRealTimers());

  test('one inotifywait watches the expanded directories and its events trigger a listing', async () => {
    jest.useFakeTimers();
    const host = makeHost({ tools: ['inotifywait'] });
    host.tree.set('/home/y/api', new Map([['a.txt', false]]));
    let onStdout = null;
    host.service.oneShot.mockImplementation((profileId, script, opts) => {
      onStdout = opts.onStdout;
      return new Promise(() => {});
    });
    const emitted = [];
    const poller = createRemoteDirPoller({
      service: host.service,
      authorize: async (u) => ({ profileId: PID, path: remotePath.parse(u).path }),
      isActive: () => true,
      emit: (c) => emitted.push(c),
      createFs: host.createFs,
    });
    await poller.watch(uri('/home/y/api'));
    await flush();
    jest.advanceTimersByTime(600); // the restart debounce
    expect(host.service.oneShot).toHaveBeenCalledTimes(1);
    expect(host.service.oneShot.mock.calls[0][1]).toBe(inotifyScript(['/home/y/api']));
    expect(host.service.oneShot.mock.calls[0][1]).toContain("-- '/home/y/api'");

    // The periodic poll stands down while inotify covers the host.
    host.requests.length = 0;
    jest.advanceTimersByTime(POLL_MS);
    await flush();
    expect(host.requests).toHaveLength(0);

    host.tree.get('/home/y/api').set('b.txt', false);
    onStdout(Buffer.from('/home/y/api/\n'));
    jest.advanceTimersByTime(400);
    await flush();
    expect(host.requests).toHaveLength(1);
    expect(emitted).toEqual([[{ type: 'add', path: uri('/home/y/api/b.txt'), isDirectory: false }]]);
    poller.dispose();
  });
});

describe('explorer.ipc routes remote directories to the poller', () => {
  test('a URI never reaches chokidar, and visibility is what lets it poll', async () => {
    jest.resetModules();
    const handlers = {};
    jest.doMock('electron', () => ({ ipcMain: { on: (c, fn) => { handlers[c] = fn; }, handle: (c, fn) => { handlers[c] = fn; } } }));
    const chokidarWatch = jest.fn();
    jest.doMock('chokidar', () => ({ watch: chokidarWatch }), { virtual: false });
    const host = makeHost();
    jest.doMock('../../src/main/services/SshHostService', () => host.service);
    jest.doMock('../../src/main/utils/projectTarget', () => ({
      resolveTarget: async (u) => ({ kind: 'remote', profileId: PID, remotePath: remotePath.parse(u).path }),
    }));
    const explorer = require('../../src/main/ipc/explorer.ipc');
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true,
      webContents: { send: jest.fn() },
    });
    explorer.registerExplorerHandlers(win);
    const sender = Object.assign(new EventEmitter(), { id: 3, isDestroyed: () => false });
    handlers['explorer:watchDir']({ sender }, uri('/home/y/api'));
    await flush();
    expect(chokidarWatch).not.toHaveBeenCalled();
    const poller = explorer._getRemotePoller();
    expect([...poller._dirs.keys()]).toEqual([uri('/home/y/api')]);
    expect(explorer._isExplorerActive()).toBe(false);
    handlers['explorer:setVisible']({}, true);
    expect(explorer._isExplorerActive()).toBe(true);
    handlers['explorer:unwatchDir']({}, uri('/home/y/api'));
    expect(poller._dirs.size).toBe(0);
    poller.dispose();
  });
});
