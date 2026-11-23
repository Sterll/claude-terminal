const { createFileLinkHistory, MOUSE_BACK, MOUSE_FORWARD } = require('../../src/renderer/features/FileLinkHistory');

function setup() {
  const ui = { tab: 'claude', terminal: 7 };
  const showTerminal = jest.fn((id) => { ui.tab = 'claude'; ui.terminal = id; });
  const showFile = jest.fn(() => { ui.tab = 'files'; });
  const history = createFileLinkHistory({
    getActiveTab: () => ui.tab,
    getActiveTerminalId: () => ui.terminal,
    showTerminal,
    showFile,
  });
  const detach = history.attach(document);
  // Simulate the click on a terminal path.
  const jump = (file = '/p/a.md', project = { id: 'p' }) => {
    history.recordJump(file, project);
    ui.tab = 'files';
  };
  return { ui, history, showTerminal, showFile, jump, detach };
}

const key = (k, opts = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true, cancelable: true, ...opts });
  document.body.dispatchEvent(e);
  return e;
};
const mouse = (button) => {
  const e = new MouseEvent('mouseup', { button, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
  return e;
};

describe('FileLinkHistory', () => {
  let ctx;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.detach());

  test('Alt+Left returns to the terminal the path was clicked in, Alt+Right reopens the file', () => {
    ctx.jump('/p/a.md', { id: 'p' });

    const back = key('ArrowLeft');
    expect(back.defaultPrevented).toBe(true);
    expect(ctx.showTerminal).toHaveBeenCalledWith(7);
    expect(ctx.ui.tab).toBe('claude');

    const fwd = key('ArrowRight');
    expect(fwd.defaultPrevented).toBe(true);
    expect(ctx.showFile).toHaveBeenCalledWith('/p/a.md', { id: 'p' });
    expect(ctx.ui.tab).toBe('files');

    // And back again.
    key('ArrowLeft');
    expect(ctx.showTerminal).toHaveBeenCalledTimes(2);
  });

  test('the mouse back and forward buttons do the same', () => {
    ctx.jump();
    expect(mouse(MOUSE_BACK).defaultPrevented).toBe(true);
    expect(ctx.ui.tab).toBe('claude');
    expect(mouse(MOUSE_FORWARD).defaultPrevented).toBe(true);
    expect(ctx.ui.tab).toBe('files');
  });

  test('leaves Alt+arrows alone when there is no step to take', () => {
    // Nothing recorded: the key must reach the terminal.
    expect(key('ArrowLeft').defaultPrevented).toBe(false);
    expect(key('ArrowRight').defaultPrevented).toBe(false);

    // In the terminal right after a jump, Left has nowhere to go.
    ctx.jump();
    ctx.ui.tab = 'claude';
    expect(key('ArrowLeft').defaultPrevented).toBe(false);
    expect(ctx.showTerminal).not.toHaveBeenCalled();
  });

  test('does not hijack the keys once the reader has navigated elsewhere', () => {
    ctx.jump();
    ctx.ui.tab = 'git';
    expect(key('ArrowLeft').defaultPrevented).toBe(false);
    expect(mouse(MOUSE_BACK).defaultPrevented).toBe(false);
  });

  test('ignores modified chords and ordinary clicks', () => {
    ctx.jump();
    expect(key('ArrowLeft', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(key('ArrowLeft', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(mouse(0).defaultPrevented).toBe(false);
    expect(ctx.ui.tab).toBe('files');
  });

  test('a new jump clears the forward history', () => {
    ctx.jump('/p/a.md');
    key('ArrowLeft');
    ctx.jump('/p/b.md');
    key('ArrowLeft');
    key('ArrowRight');
    expect(ctx.showFile).toHaveBeenLastCalledWith('/p/b.md', { id: 'p' });
    ctx.ui.tab = 'claude';
    // Only b was forward; a was dropped by the second jump.
    key('ArrowLeft');
    expect(ctx.history.canGoForward()).toBe(false);
  });
});
