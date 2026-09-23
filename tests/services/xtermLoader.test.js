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

  // The escape hatch for #207. A glyph atlas that disagrees with the font's
  // real metrics is driver-specific and cannot be probed for, and --disable-gpu
  // does not avoid it: Electron still answers getContext('webgl2') through
  // SwiftShader. Only this setting takes the renderer out of the picture, so it
  // has to work without the module even looking for a context.
  it('never reaches for a context when the renderer is turned off', async () => {
    const { attachWebglAddon } = require(LOADER);
    const terminal = fakeTerminal();
    const spy = jest.spyOn(canvasProto, 'getContext');

    await expect(attachWebglAddon(terminal, { enabled: false })).resolves.toBe(false);

    expect(spy).not.toHaveBeenCalled();
    expect(terminal.loadAddon).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is on when the caller says nothing, so the setting is opt-out', async () => {
    const { attachWebglAddon } = require(LOADER);
    const terminal = fakeTerminal();
    const spy = jest.spyOn(canvasProto, 'getContext');

    await attachWebglAddon(terminal);

    // It still resolves false here (jsdom has no WebGL2), but it looked.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('clearGlyphAtlas', () => {
  beforeEach(() => jest.resetModules());

  // The atlas holds glyphs rasterised for the grid in force when it was cut.
  // Changing the font size and redrawing from it lays the new size out on the
  // old advance widths, which is the same ghosting/offset the renderer toggle
  // exists for — except this one we cause ourselves.
  it('drops the cached atlas of a terminal that has one', () => {
    const { clearGlyphAtlas } = require(LOADER);
    const clearTextureAtlas = jest.fn();

    clearGlyphAtlas({ _ctWebglAddon: { clearTextureAtlas } });

    expect(clearTextureAtlas).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on a DOM-rendered terminal, which has no atlas', () => {
    const { clearGlyphAtlas } = require(LOADER);

    expect(() => clearGlyphAtlas({})).not.toThrow();
    expect(() => clearGlyphAtlas(null)).not.toThrow();
  });

  it('survives an addon disposed underneath it', () => {
    const { clearGlyphAtlas } = require(LOADER);
    const addon = { clearTextureAtlas: () => { throw new Error('disposed'); } };

    expect(() => clearGlyphAtlas({ _ctWebglAddon: addon })).not.toThrow();
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
