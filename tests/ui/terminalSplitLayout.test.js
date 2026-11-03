/**
 * The split view: several tabs of one project on screen at once.
 *
 * Two halves are pinned here. The tree itself (split, remove, the minimum
 * pane size, what gets saved and what a saved layout may come back as) is
 * pure, so it is tested without a DOM. The factory is tested against a jsdom
 * container with the same stacked wrappers TerminalManager builds, because
 * the whole design rests on one property: no wrapper ever moves. A pane is a
 * class and four custom properties on a wrapper that stays where it was.
 */

const split = require('../../src/renderer/ui/components/terminal/splitLayout');

const {
  createSplitLayout, leaves, splitLeaf, removeLeaf, computeRects, fitsMinimum,
  ratioBounds, fitToSize, zoneAt, serializeLayout, deserializeLayout, MIN_PANE_WIDTH,
} = split;

global.cancelAnimationFrame = global.cancelAnimationFrame || ((h) => clearTimeout(h));

describe('layout tree', () => {
  const two = splitLeaf({ tab: 1 }, 1, 2, 'right');

  test('splitting a pane puts the new tab on the side asked for', () => {
    expect(two).toEqual({ dir: 'row', ratio: 0.5, a: { tab: 1 }, b: { tab: 2 } });
    expect(splitLeaf({ tab: 1 }, 1, 2, 'top')).toEqual({ dir: 'column', ratio: 0.5, a: { tab: 2 }, b: { tab: 1 } });
  });

  test('splitting a pane of a split nests it, the other panes untouched', () => {
    const three = splitLeaf(two, 2, 3, 'bottom');
    expect(leaves(three)).toEqual([1, 2, 3]);
    expect(three.a).toBe(two.a);
    expect(three.b).toEqual({ dir: 'column', ratio: 0.5, a: { tab: 2 }, b: { tab: 3 } });
  });

  test('removing a pane gives its place to its sibling', () => {
    const three = splitLeaf(two, 2, 3, 'bottom');
    expect(removeLeaf(three, 2)).toEqual({ dir: 'row', ratio: 0.5, a: { tab: 1 }, b: { tab: 3 } });
    expect(removeLeaf(two, 1)).toEqual({ tab: 2 });
    expect(removeLeaf({ tab: 1 }, 1)).toBeNull();
  });

  test('ids are compared as text, a PTY number and a chat string alike', () => {
    expect(leaves(splitLeaf({ tab: 7 }, '7', 'chat-a', 'right'))).toEqual([7, 'chat-a']);
  });

  test('rects tile the container and the handle sits on the split line', () => {
    const { panes, handles } = computeRects(splitLeaf(two, 2, 3, 'bottom'));
    expect(panes).toEqual([
      { id: 1, x: 0, y: 0, w: 0.5, h: 1 },
      { id: 2, x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { id: 3, x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ]);
    expect(handles.map((h) => [h.path, h.dir, h.x, h.y])).toEqual([['b', 'column', 0.5, 0.5], ['', 'row', 0.5, 0]]);
  });

  test('a pane under the minimum size in pixels does not fit', () => {
    expect(fitsMinimum(two, { width: 2 * MIN_PANE_WIDTH, height: 600 })).toBe(true);
    expect(fitsMinimum(two, { width: 2 * MIN_PANE_WIDTH - 20, height: 600 })).toBe(false);
  });

  test('a handle stops where a pane would drop under its minimum, inside 15-85 %', () => {
    const roomy = ratioBounds(two, '', { width: 4000, height: 800 });
    expect(roomy).toEqual({ lo: 0.15, hi: 0.85 });
    const tight = ratioBounds(two, '', { width: 1000, height: 800 });
    expect(tight.lo).toBeCloseTo(MIN_PANE_WIDTH / 1000);
    expect(tight.hi).toBeCloseTo(1 - MIN_PANE_WIDTH / 1000);
    // A window shrunk after the split leaves no legal position: do not move.
    expect(ratioBounds(two, '', { width: 600, height: 800 })).toBeNull();
  });

  test('drawn in a smaller container, a ratio is pulled back to keep both panes at their minimum', () => {
    const wide = { dir: 'row', ratio: 0.85, a: { tab: 1 }, b: { tab: 2 } };
    expect(fitToSize(wide, { width: 4000, height: 800 })).toBe(wide);
    const fitted = fitToSize(wide, { width: 900, height: 800 });
    expect(fitted.ratio).toBeCloseTo(1 - MIN_PANE_WIDTH / 900);
    expect(wide.ratio).toBe(0.85); // the chosen ratio is not rewritten
    // No legal position at all: left as it is rather than made worse.
    expect(fitToSize(wide, { width: 500, height: 800 })).toBe(wide);
  });

  test('the pointer picks an edge near one, the middle elsewhere', () => {
    const rect = { left: 0, top: 0, width: 400, height: 400 };
    expect(zoneAt(rect, 20, 200)).toBe('left');
    expect(zoneAt(rect, 390, 200)).toBe('right');
    expect(zoneAt(rect, 200, 10)).toBe('top');
    expect(zoneAt(rect, 200, 395)).toBe('bottom');
    expect(zoneAt(rect, 200, 200)).toBe('center');
    expect(zoneAt(rect, 500, 200)).toBeNull();
  });
});

describe('saved layouts', () => {
  test('leaves are saved as indices into the saved tabs, whatever the ids', () => {
    const root = splitLeaf(splitLeaf({ tab: 41 }, 41, 'chat-x', 'right'), 'chat-x', 43, 'bottom');
    const order = ['chat-x', 43, 41];
    expect(serializeLayout(root, (id) => order.findIndex((o) => String(o) === String(id)))).toEqual({
      dir: 'row', ratio: 0.5, a: { tab: 2 },
      b: { dir: 'column', ratio: 0.5, a: { tab: 0 }, b: { tab: 1 } },
    });
  });

  test('a tab that is not saved drops out, and one pane left is no layout', () => {
    const root = splitLeaf(splitLeaf({ tab: 1 }, 1, 'file-tab', 'right'), 1, 2, 'bottom');
    const indexOf = (id) => [1, 2].indexOf(id);
    expect(serializeLayout(root, indexOf)).toEqual({ dir: 'column', ratio: 0.5, a: { tab: 0 }, b: { tab: 1 } });
    expect(serializeLayout(splitLeaf({ tab: 1 }, 1, 'file-tab', 'right'), indexOf)).toBeNull();
  });

  test('a saved layout comes back on the restored ids', () => {
    const restored = [101, 'chat-b'];
    const root = deserializeLayout({ dir: 'row', ratio: 0.3, a: { tab: 1 }, b: { tab: 0 } }, (i) => restored[i]);
    expect(root).toEqual({ dir: 'row', ratio: 0.3, a: { tab: 'chat-b' }, b: { tab: 101 } });
  });

  test('anything that does not check out is dropped, not trusted', () => {
    const ids = [1, 2, 3, 4, 5];
    const idAt = (i) => ids[i] ?? null;
    // An index with no tab behind it: its sibling takes the place.
    expect(deserializeLayout({ dir: 'row', ratio: 0.5, a: { tab: 0 }, b: { tab: 9 } }, idAt)).toBeNull();
    // The same tab twice.
    expect(deserializeLayout({ dir: 'row', ratio: 0.5, a: { tab: 0 }, b: { tab: 0 } }, idAt)).toBeNull();
    // A shape this code did not write.
    expect(deserializeLayout({ dir: 'diagonal', a: { tab: 0 }, b: { tab: 1 } }, idAt)).toBeNull();
    expect(deserializeLayout({ tab: '0' }, idAt)).toBeNull();
    // A ratio out of range is clamped rather than crushing a pane.
    expect(deserializeLayout({ dir: 'row', ratio: 0.99, a: { tab: 0 }, b: { tab: 1 } }, idAt).ratio).toBe(0.85);
    // More panes than a layout holds.
    const five = { dir: 'row', ratio: 0.5, a: { dir: 'row', ratio: 0.5, a: { tab: 0 }, b: { tab: 1 } }, b: { dir: 'row', ratio: 0.5, a: { tab: 2 }, b: { dir: 'row', ratio: 0.5, a: { tab: 3 }, b: { tab: 4 } } } };
    expect(deserializeLayout(five, idAt)).toBeNull();
  });
});

describe('createSplitLayout', () => {
  let container, layout, deps, active, terms, size;

  /** Tabs and wrappers stacked the way TerminalManager builds them. */
  function setup(tabs, { first } = {}) {
    document.body.innerHTML = '<div id="terminals-tabs"></div><div id="terminals-container"></div>';
    container = document.getElementById('terminals-container');
    container.getBoundingClientRect = jest.fn(() => ({ left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 }));
    terms = new Map();
    for (const [id, owner, type] of tabs) {
      terms.set(id, { owner, type });
      const tab = document.createElement('div');
      tab.className = 'terminal-tab';
      tab.dataset.id = id;
      document.getElementById('terminals-tabs').appendChild(tab);
      const w = document.createElement('div');
      w.className = 'terminal-wrapper';
      w.dataset.id = id;
      container.appendChild(w);
    }
    size = { width: 1200, height: 800 };
    active = first ?? tabs[0][0];
    deps = {
      getContainer: () => container,
      getActiveTerminal: () => active,
      ownerOf: (id) => terms.get(id)?.owner ?? null,
      canSplit: (id) => {
        const td = terms.get(id);
        return td && !td.type ? { ok: true } : { ok: false, reasonKey: 'terminals.splitUnsupported' };
      },
      resolveId: (text) => [...terms.keys()].find((k) => String(k) === String(text)) ?? null,
      // What TerminalManager.setActiveTerminal does around its own writes.
      activate: jest.fn((id) => {
        layout.willActivate(id, active);
        active = id;
        layout.apply();
      }),
      onChange: jest.fn(),
      notify: jest.fn(),
      t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
      measure: () => size,
    };
    layout = createSplitLayout(deps);
    layout.apply();
  }

  const wrapper = (id) => container.querySelector(`.terminal-wrapper[data-id="${id}"]`);
  const tabEl = (id) => document.querySelector(`.terminal-tab[data-id="${id}"]`);
  const panes = () => [...container.querySelectorAll('.terminal-wrapper.split-pane')].map((w) => w.dataset.id);

  afterEach(() => layout?.destroy());

  test('a split shows both tabs as panes without moving a wrapper', () => {
    setup([[1, 'p1'], ['chat-a', 'p1']]);
    const before = [...container.children];
    expect(layout.split(1, 'chat-a', 'right')).toEqual({ ok: true });
    expect(container.classList.contains('is-split')).toBe(true);
    expect(panes()).toEqual(['1', 'chat-a']);
    for (const w of before) expect(w.parentElement).toBe(container);
    expect(wrapper(1).style.getPropertyValue('--pane-width')).toBe('calc(50% - 3px)');
    expect(wrapper('chat-a').style.getPropertyValue('--pane-left')).toBe('calc(50% + 3px)');
    expect(container.querySelectorAll('.split-handle.row')).toHaveLength(1);
    expect(tabEl('chat-a').classList.contains('in-split')).toBe(true);
    // The new pane takes the focus, and the change is saved.
    expect(deps.activate).toHaveBeenCalledWith('chat-a');
    expect(deps.onChange).toHaveBeenCalled();
  });

  test('a project console cannot be split, and says so', () => {
    setup([[1, 'p1'], [2, 'p1', 'fivem']]);
    expect(layout.split(1, 2, 'right').ok).toBe(false);
    expect(deps.notify).toHaveBeenCalledWith('terminals.splitUnsupported');
    expect(layout.hasLayout('p1')).toBe(false);
  });

  test('a window too small for the minimum pane is refused with a toast, not crushed', () => {
    setup([[1, 'p1'], [2, 'p1']]);
    size = { width: 2 * MIN_PANE_WIDTH - 40, height: 800 };
    expect(layout.split(1, 2, 'right').ok).toBe(false);
    expect(deps.notify).toHaveBeenCalledWith('terminals.splitTooSmall');
    expect(container.classList.contains('is-split')).toBe(false);
    // The same window still has room the other way.
    expect(layout.split(1, 2, 'bottom').ok).toBe(true);
  });

  test('four panes at most', () => {
    setup([[1, 'p1'], [2, 'p1'], [3, 'p1'], [4, 'p1'], [5, 'p1']]);
    size = { width: 4000, height: 4000 };
    layout.split(1, 2, 'right');
    layout.split(1, 3, 'bottom');
    layout.split(2, 4, 'bottom');
    expect(layout.paneCount('p1')).toBe(4);
    expect(layout.split(4, 5, 'right').ok).toBe(false);
    expect(deps.notify).toHaveBeenCalledWith('terminals.splitMaxPanes:{"count":4}');
    expect(layout.canSplitBeside(4, 'right').ok).toBe(false);
  });

  test('tabs of another project are never put in a layout', () => {
    setup([[1, 'p1'], [2, 'p2']]);
    expect(layout.split(1, 2, 'right').ok).toBe(false);
    expect(layout.hasLayout('p1')).toBe(false);
  });

  test('activating a hidden tab puts it in the focused pane; the replaced one is hidden, not closed', () => {
    setup([[1, 'p1'], [2, 'p1'], [3, 'p1']]);
    layout.split(1, 2, 'right');
    deps.activate(1);
    deps.activate(3);
    expect(panes()).toEqual(['2', '3']);
    expect(leaves(layout.getLayout('p1'))).toEqual([3, 2]);
    expect(wrapper(1).classList.contains('split-pane')).toBe(false);
    expect(wrapper(1).style.getPropertyValue('--pane-left')).toBe('');
    expect(tabEl(1).classList.contains('in-split')).toBe(false);
  });

  test('a console shown alone suspends the layout, which comes back with its panes', () => {
    setup([[1, 'p1'], [2, 'p1'], [9, 'p1', 'webapp']]);
    layout.split(1, 2, 'right');
    deps.activate(9);
    expect(container.classList.contains('is-split')).toBe(false);
    expect(panes()).toEqual([]);
    expect(leaves(layout.getLayout('p1'))).toEqual([1, 2]);
    deps.activate(2);
    expect(panes()).toEqual(['1', '2']);
  });

  test('each project keeps its layout: the drawn one follows the active tab', () => {
    setup([[1, 'p1'], [2, 'p1'], [3, 'p2']]);
    layout.split(1, 2, 'right');
    // Switching to a project in simple view: no split class, no pane left over.
    deps.activate(3);
    expect(container.classList.contains('is-split')).toBe(false);
    expect(container.querySelectorAll('.split-handle')).toHaveLength(0);
    expect(wrapper(2).style.getPropertyValue('--pane-width')).toBe('');
    // And back.
    deps.activate(1);
    expect(container.classList.contains('is-split')).toBe(true);
    expect(panes()).toEqual(['1', '2']);
  });

  test('a layout is not drawn while one of its wrappers is filtered out', () => {
    setup([[1, 'p1'], [2, 'p1']]);
    layout.split(1, 2, 'right');
    wrapper(2).style.display = 'none';
    layout.apply();
    expect(container.classList.contains('is-split')).toBe(false);
    expect(layout.isShown(1)).toBe(false);
  });

  test('closing the focused pane focuses its neighbour; the last pane is a simple view again', () => {
    setup([[1, 'p1'], [2, 'p1'], [3, 'p1']]);
    layout.split(1, 2, 'right');
    layout.split(2, 3, 'bottom');
    expect(active).toBe(3);
    expect(layout.removeTab(3)).toBe(2);
    deps.activate(2);
    expect(panes()).toEqual(['1', '2']);
    // A pane that is not the focused one leaves the focus where it is.
    expect(layout.removeTab(1)).toBe(2);
    layout.apply();
    expect(layout.hasLayout('p1')).toBe(false);
    expect(container.classList.contains('is-split')).toBe(false);
    expect(container.querySelector('.split-pane-close')).toBeNull();
  });

  test('a tab in no layout leaves the close path alone', () => {
    setup([[1, 'p1'], [2, 'p1']]);
    expect(layout.removeTab(2)).toBeNull();
    expect(deps.onChange).not.toHaveBeenCalled();
  });

  test('the pane button removes the pane and keeps the tab', () => {
    setup([[1, 'p1'], [2, 'p1']]);
    layout.split(1, 2, 'right');
    wrapper(2).querySelector('.split-pane-close').click();
    expect(layout.hasLayout('p1')).toBe(false);
    expect(active).toBe(1);
    expect(terms.has(2)).toBe(true);
  });

  test('a pane button emptied by a mode switch comes back on the next apply', () => {
    setup([[1, 'p1'], [2, 'p1']]);
    layout.split(1, 2, 'right');
    wrapper(2).innerHTML = '';
    layout.apply();
    expect(wrapper(2).querySelector('.split-pane-close')).not.toBeNull();
  });

  test('exit split view keeps the active tab alone', () => {
    setup([[1, 'p1'], [2, 'p1']]);
    layout.split(1, 2, 'right');
    layout.exitSplit(2);
    expect(layout.hasLayout('p1')).toBe(false);
    expect(panes()).toEqual([]);
    expect(active).toBe(2);
  });

  test('a click in another pane focuses it', () => {
    setup([[1, 'p1'], [2, 'p1']]);
    layout.split(1, 2, 'right');
    const inner = document.createElement('div');
    wrapper(1).appendChild(inner);
    inner.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(active).toBe(1);
  });

  test('the next new tab can be armed to open beside the active one', () => {
    setup([[1, 'p1']]);
    layout.expectNewTab(1, 'bottom');
    terms.set(2, { owner: 'p1' });
    const w = document.createElement('div');
    w.className = 'terminal-wrapper';
    w.dataset.id = 2;
    container.appendChild(w);
    deps.activate(2);
    expect(layout.getLayout('p1')).toEqual({ dir: 'column', ratio: 0.5, a: { tab: 1 }, b: { tab: 2 } });
    // Consumed once: a later tab replaces the focused pane as usual.
    terms.set(3, { owner: 'p1' });
    const w3 = w.cloneNode();
    w3.dataset.id = 3;
    container.appendChild(w3);
    deps.activate(3);
    expect(leaves(layout.getLayout('p1'))).toEqual([1, 3]);
  });

  describe('handles', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const pointer = (el, type, clientX) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX }));

    test('dragging moves the split, measures once, and saves once at the end', () => {
      setup([[1, 'p1'], [2, 'p1']]);
      layout.split(1, 2, 'right');
      deps.onChange.mockClear();
      const handle = container.querySelector('.split-handle');
      container.getBoundingClientRect.mockClear();

      pointer(handle, 'pointerdown', 600);
      pointer(handle, 'pointermove', 700);
      jest.runOnlyPendingTimers();
      pointer(handle, 'pointermove', 720);
      jest.runOnlyPendingTimers();
      expect(layout.getLayout('p1').ratio).toBeCloseTo(0.6);
      expect(deps.onChange).not.toHaveBeenCalled();
      pointer(handle, 'pointerup', 720);

      expect(container.getBoundingClientRect).toHaveBeenCalledTimes(1);
      expect(deps.onChange).toHaveBeenCalledTimes(1);
      expect(wrapper(1).style.getPropertyValue('--pane-width')).toBe('calc(60% - 3px)');
      expect(container.classList.contains('split-resizing')).toBe(false);
    });

    test('a drag stops at the minimum pane size', () => {
      setup([[1, 'p1'], [2, 'p1']]);
      layout.split(1, 2, 'right');
      const handle = container.querySelector('.split-handle');
      pointer(handle, 'pointerdown', 600);
      pointer(handle, 'pointermove', 1190);
      jest.runOnlyPendingTimers();
      pointer(handle, 'pointerup', 1190);
      expect(layout.getLayout('p1').ratio).toBeCloseTo(1 - MIN_PANE_WIDTH / 1200);
    });

    test('a double click puts it back in the middle, the keyboard moves it too', () => {
      setup([[1, 'p1'], [2, 'p1']]);
      layout.split(1, 2, 'right');
      const handle = container.querySelector('.split-handle');
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(layout.getLayout('p1').ratio).toBeCloseTo(0.55);
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      expect(layout.getLayout('p1').ratio).toBeCloseTo(0.5);
    });
  });

  describe('dropping a tab', () => {
    const dragEvent = (type, clientX, clientY) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      e.clientX = clientX;
      e.clientY = clientY;
      e.dataTransfer = { dropEffect: '' };
      return e;
    };

    test('on a pane edge splits that side', () => {
      setup([[1, 'p1'], [2, 'p1']]);
      layout.beginTabDrag(2);
      container.dispatchEvent(dragEvent('dragover', 1150, 400));
      const overlay = container.querySelector('.split-drop-overlay');
      expect(overlay.hidden).toBe(false);
      expect(overlay.style.left).toBe('600px');
      container.dispatchEvent(dragEvent('drop', 1150, 400));
      expect(layout.getLayout('p1')).toEqual({ dir: 'row', ratio: 0.5, a: { tab: 1 }, b: { tab: 2 } });
      expect(overlay.hidden).toBe(true);
    });

    test('in the middle of a pane replaces it; a tab already on screen swaps', () => {
      setup([[1, 'p1'], [2, 'p1'], [3, 'p1']]);
      layout.split(1, 2, 'right');
      layout.beginTabDrag(3);
      container.dispatchEvent(dragEvent('dragover', 300, 400));
      container.dispatchEvent(dragEvent('drop', 300, 400));
      expect(leaves(layout.getLayout('p1'))).toEqual([3, 2]);
      layout.beginTabDrag(2);
      container.dispatchEvent(dragEvent('dragover', 300, 400));
      container.dispatchEvent(dragEvent('drop', 300, 400));
      expect(leaves(layout.getLayout('p1'))).toEqual([2, 3]);
    });

    test('a console is refused on screen and with a toast on drop', () => {
      setup([[1, 'p1'], [2, 'p1', 'fivem']]);
      layout.beginTabDrag(2);
      const over = dragEvent('dragover', 1150, 400);
      container.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      const overlay = container.querySelector('.split-drop-overlay');
      expect(overlay.classList.contains('refused')).toBe(true);
      expect(overlay.textContent).toBe('terminals.splitUnsupported');
      container.dispatchEvent(dragEvent('drop', 1150, 400));
      expect(deps.notify).toHaveBeenCalledWith('terminals.splitUnsupported');
      expect(layout.hasLayout('p1')).toBe(false);
    });

    test('a drag that did not start on a tab is left to whoever else handles it', () => {
      setup([[1, 'p1'], [2, 'p1']]);
      const over = dragEvent('dragover', 1150, 400);
      container.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(false);
      expect(container.querySelector('.split-drop-overlay')).toBeNull();
    });
  });

  describe('persistence', () => {
    test('saves the focused pane with the tree and restores both', () => {
      setup([[1, 'p1'], ['chat-a', 'p1']]);
      layout.split(1, 'chat-a', 'bottom');
      const order = ['chat-a', 1];
      const saved = layout.serializeFor('p1', (id) => order.findIndex((o) => String(o) === String(id)));
      expect(saved).toEqual({ root: { dir: 'column', ratio: 0.5, a: { tab: 1 }, b: { tab: 0 } }, focused: 0 });
      layout.destroy();

      setup([[11, 'p1'], [12, 'p1']]);
      const restored = [12, 11];
      expect(layout.restore('p1', saved, (i) => restored[i])).toBe(12);
      expect(layout.getLayout('p1')).toEqual({ dir: 'column', ratio: 0.5, a: { tab: 11 }, b: { tab: 12 } });
    });

    test('a layout restored into a smaller window is drawn within the minimum, its ratio kept', () => {
      setup([[11, 'p1'], [12, 'p1']]);
      size = { width: 900, height: 800 };
      layout.restore('p1', { root: { dir: 'row', ratio: 0.85, a: { tab: 0 }, b: { tab: 1 } }, focused: 0 }, (i) => [11, 12][i]);
      layout.apply();
      const width = wrapper(12).style.getPropertyValue('--pane-width');
      const pct = parseFloat(width.match(/calc\(([\d.]+)%/)[1]);
      expect(pct / 100 * 900).toBeGreaterThanOrEqual(MIN_PANE_WIDTH - 1);
      expect(layout.getLayout('p1').ratio).toBe(0.85);
    });

    test('a restored index that came back as a console is dropped', () => {
      setup([[11, 'p1'], [12, 'p1', 'webapp']]);
      const saved = { root: { dir: 'row', ratio: 0.5, a: { tab: 0 }, b: { tab: 1 } }, focused: 1 };
      expect(layout.restore('p1', saved, (i) => [11, 12][i])).toBeNull();
      expect(layout.hasLayout('p1')).toBe(false);
    });
  });

  test('destroy removes what it drew and stops listening', () => {
    setup([[1, 'p1'], [2, 'p1']]);
    layout.split(1, 2, 'right');
    layout.beginTabDrag(2);
    layout.destroy();
    expect(container.classList.contains('is-split')).toBe(false);
    expect(container.querySelectorAll('.split-handle, .split-pane-close, .split-pane')).toHaveLength(0);
    const e = new Event('dragover', { bubbles: true, cancelable: true });
    container.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    layout = null;
  });
});
