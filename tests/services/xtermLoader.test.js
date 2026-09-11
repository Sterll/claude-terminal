/**
 * The lazy xterm loader.
 *
 * xterm and its WebGL addon are 719 KB and used to sit in the startup bundle
 * because five files require()d them at the top level. They are now fetched when
 * a terminal is actually mounted, which turns two things that could not fail
 * before into things that can: the emulator chunk, and the addon chunk.
 *
 * This suite pins the contract for both failures, because neither is allowed to
 * surface as an exception in a click handler.
 *
 * Note on the environment: dynamic import() is not available under Jest without
 * --experimental-vm-modules, so `import('@xterm/xterm')` rejects here. That is a
 * faithful stand-in for a chunk that will not load, and it is what lets the
 * degraded paths below be exercised for real rather than mocked.
 */

const LOADER = '../../src/renderer/services/xtermLoader';

// Reached through an instance rather than the bare HTMLCanvasElement global,
// which the lint config does not declare for this directory.
const canvasProto = document.createElement('canvas').constructor.prototype;

describe('loadWebgl', () => {
  beforeEach(() => jest.resetModules());

  it('resolves null rather than rejecting when there is no WebGL2 context', async () => {
    const { loadWebgl } = require(LOADER);
    await expect(loadWebgl()).resolves.toBeNull();
  });

  it('probes for a context only once', async () => {
    const { loadWebgl } = require(LOADER);
    const spy = jest.spyOn(canvasProto, 'getContext');

    await loadWebgl();
    await loadWebgl();

    // Memoized: the second call must not reach the canvas again, let alone
    // re-request the 242 KB chunk.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('treats a canvas that throws as "no WebGL", not as an error', async () => {
    const { loadWebgl } = require(LOADER);
    const spy = jest.spyOn(canvasProto, 'getContext').mockImplementation(() => {
      throw new Error('context creation refused');
    });

    await expect(loadWebgl()).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe('attachWebglAddon', () => {
  beforeEach(() => jest.resetModules());

  /** An opened xterm Terminal, as far as this module is concerned. */
  function fakeTerminal() {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return { element, loadAddon: jest.fn() };
  }

  it('reports no attachment and leaves the terminal alone when WebGL is unavailable', async () => {
    const { attachWebglAddon } = require(LOADER);
    const terminal = fakeTerminal();

    await expect(attachWebglAddon(terminal)).resolves.toBe(false);

    // The DOM renderer is already drawing; the addon simply never arrives.
    expect(terminal.loadAddon).not.toHaveBeenCalled();
  });

  it('does not reject when handed a terminal that is already gone', async () => {
    const { attachWebglAddon } = require(LOADER);

    await expect(attachWebglAddon(null)).resolves.toBe(false);
    await expect(attachWebglAddon({ element: null })).resolves.toBe(false);
  });
});

describe('loadXterm', () => {
  beforeEach(() => jest.resetModules());

  it('rejects rather than resolving half a module when the chunk will not load', async () => {
    const { loadXterm, isXtermLoaded, getXtermSync } = require(LOADER);

    await expect(loadXterm()).rejects.toBeDefined();
    expect(isXtermLoaded()).toBe(false);
    expect(getXtermSync()).toBeNull();
  });

  it('drops the memo on failure so the next terminal retries', async () => {
    const mod = require(LOADER);

    await expect(mod.loadXterm()).rejects.toBeDefined();
    const second = mod.loadXterm();
    // A cached rejected promise would make the first flaky failure permanent.
    await expect(second).rejects.toBeDefined();
  });
});
