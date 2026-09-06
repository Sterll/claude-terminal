/**
 * session-names.json is what the Resume list reads, so a name poisoned by a
 * CLI failure survives there long after the tab it came from is gone. The
 * naming guard cannot reach those — they were written before it existed — so
 * the loader drops them on the way in and rewrites the file once.
 */

// xterm's WebGL addon probes navigator/UA at require time; not exercised here.
jest.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));

let TerminalManager;

beforeAll(() => {
  window.electron_api = {
    ...window.electron_api,
    terminal: {
      create: jest.fn(async () => ({ success: true, id: 1 })),
      input: jest.fn(),
      resize: jest.fn(),
      kill: jest.fn(),
      onData: jest.fn(() => () => {}),
      onExit: jest.fn(() => () => {}),
    },
  };
  ({ TerminalManager } = require('../../src/renderer/ui/components/TerminalManager'));
});

let tm;
let written;

/** Stand the loader up over a fake session-names.json. */
const withNamesOnDisk = (names) => {
  tm = new TerminalManager();
  tm._namesCache = null;
  tm._fsp = {
    readFile: jest.fn(async () => JSON.stringify(names)),
    writeFile: jest.fn(async (_path, data) => { written = JSON.parse(data); }),
  };
  return tm;
};

beforeEach(() => {
  written = null;
  document.body.innerHTML = `
    <div id="terminals-tabs"></div>
    <div id="terminals-container"></div>
    <div id="empty-terminals"></div>
    <div id="terminals-filter"></div>`;
});

describe('_loadSessionNames healing', () => {
  test('drops a generated name that is really a CLI failure', async () => {
    const tm = withNamesOnDisk({
      's1': { name: 'Not logged in · Please run /login', custom: false },
      's2': { name: 'Refonte left menu', custom: false },
    });

    const names = await tm._loadSessionNames();

    expect(names.s1).toBeUndefined();
    expect(names.s2.name).toBe('Refonte left menu');
  });

  test('drops a bare-string entry too — those predate the custom flag', async () => {
    const tm = withNamesOnDisk({ 's1': 'Not logged in · Please run /login' });

    expect(await tm._loadSessionNames()).toEqual({});
  });

  test('keeps a name the user chose, whatever it says', async () => {
    const tm = withNamesOnDisk({
      's1': { name: 'Not logged in · Please run /login', custom: true },
    });

    const names = await tm._loadSessionNames();

    expect(names.s1.name).toBe('Not logged in · Please run /login');
  });

  test('rewrites the file once, and only when something was dropped', async () => {
    const poisoned = withNamesOnDisk({
      's1': { name: 'Not logged in · Please run /login', custom: false },
      's2': { name: 'Refonte left menu', custom: false },
    });
    await poisoned._loadSessionNames();
    expect(poisoned._fsp.writeFile).toHaveBeenCalledTimes(1);
    expect(written).toEqual({ 's2': { name: 'Refonte left menu', custom: false } });

    const clean = withNamesOnDisk({ 's2': { name: 'Refonte left menu', custom: false } });
    await clean._loadSessionNames();
    expect(clean._fsp.writeFile).not.toHaveBeenCalled();
  });

  test('the cache is served on the second call, without re-reading', async () => {
    const tm = withNamesOnDisk({ 's1': { name: 'Refonte left menu', custom: false } });

    await tm._loadSessionNames();
    await tm._loadSessionNames();

    expect(tm._fsp.readFile).toHaveBeenCalledTimes(1);
  });
});
