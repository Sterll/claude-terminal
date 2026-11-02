/**
 * Reordering tabs must not force a synchronous layout per pointer move.
 *
 * `dragover` fires on every pointer move for the whole drag. The handlers
 * these tests cover used to write first (clear a marker class off every tab,
 * or set the drop indicator's `top`) and measure second, with
 * getBoundingClientRect(). A read that follows a write cannot be answered from
 * the cached layout, so the browser re-laid-out the entire document, every
 * event, with the chat transcript and the file tree in it. The work queues
 * behind the pointer and the window stays unresponsive for seconds after the
 * drag ends.
 *
 * What is pinned here is the property that fixes it: while the drop position
 * has not changed, the handler writes nothing at all. Most events in a drag
 * are that case, because a tab is many pixels wide.
 */

const { ProjectBar } = require('../../src/renderer/ui/components/ProjectBar');

/** Count every class mutation on the bar, whoever makes it. */
function countClassWrites(root) {
  const counter = { n: 0 };
  for (const el of root.querySelectorAll('.project-tab')) {
    for (const method of ['add', 'remove', 'toggle']) {
      const original = el.classList[method].bind(el.classList);
      el.classList[method] = (...args) => { counter.n++; return original(...args); };
    }
  }
  return counter;
}

function dragOver(el, clientX) {
  const e = new Event('dragover', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: el, configurable: true });
  e.clientX = clientX;
  e.dataTransfer = { dropEffect: '', effectAllowed: '', setData() {} };
  el.dispatchEvent(e);
  return e;
}

let bar;
let root;

beforeEach(() => {
  document.body.innerHTML = '<div class="project-tabs" id="project-tabs"></div>';
  root = document.getElementById('project-tabs');
  root.innerHTML = `
    <div class="project-tab" data-project-id="a"></div>
    <div class="project-tab" data-project-id="b"></div>
    <div class="project-tab" data-project-id="c"></div>`;

  // jsdom gives every element a zero rect; the handler needs a width to pick a
  // side, so each tab gets a 100px slot of its own.
  [...root.querySelectorAll('.project-tab')].forEach((el, i) => {
    el.getBoundingClientRect = () => ({ left: i * 100, width: 100, right: i * 100 + 100, top: 0, height: 32, bottom: 32 });
  });

  bar = new ProjectBar(root);
  bar._initDragReorder();
  bar._dragProjectId = 'a';
});

test('repeated dragover on the same half of the same tab writes nothing', () => {
  const tabB = root.querySelector('[data-project-id="b"]');

  dragOver(tabB, 120); // left half of b: one write to place the marker
  const writes = countClassWrites(root);

  for (let i = 0; i < 20; i++) dragOver(tabB, 120 + i);

  expect(writes.n).toBe(0);
  expect(tabB.classList.contains('drop-before')).toBe(true);
});

test('crossing the midpoint moves the marker, and only then', () => {
  const tabB = root.querySelector('[data-project-id="b"]');
  dragOver(tabB, 120);

  const writes = countClassWrites(root);
  dragOver(tabB, 180); // right half now
  const afterCross = writes.n;

  for (let i = 0; i < 10; i++) dragOver(tabB, 180 + i);

  expect(tabB.classList.contains('drop-after')).toBe(true);
  expect(tabB.classList.contains('drop-before')).toBe(false);
  // The crossing itself writes; everything after it is free.
  expect(afterCross).toBeGreaterThan(0);
  expect(writes.n).toBe(afterCross);
});

test('moving to another tab clears the previous marker without sweeping the bar', () => {
  const tabB = root.querySelector('[data-project-id="b"]');
  const tabC = root.querySelector('[data-project-id="c"]');
  dragOver(tabB, 120);

  const writes = countClassWrites(root);
  dragOver(tabC, 220);

  expect(tabB.classList.contains('drop-before')).toBe(false);
  expect(tabC.classList.contains('drop-before')).toBe(true);
  // One clear on the old anchor plus one add on the new one. The version this
  // replaces cleared all three tabs on every single event.
  expect(writes.n).toBe(2);
});

test('hovering the dragged tab itself leaves no marker behind', () => {
  const tabA = root.querySelector('[data-project-id="a"]');
  const tabB = root.querySelector('[data-project-id="b"]');
  dragOver(tabB, 120);

  dragOver(tabA, 20);

  expect(tabB.classList.contains('drop-before')).toBe(false);
  expect(tabA.className).toBe('project-tab');
});

test('every measurement happens before the first mutation', () => {
  const tabB = root.querySelector('[data-project-id="b"]');
  const order = [];
  const rect = tabB.getBoundingClientRect;
  tabB.getBoundingClientRect = (...a) => { order.push('read'); return rect(...a); };
  const add = tabB.classList.add.bind(tabB.classList);
  tabB.classList.add = (...a) => { order.push('write'); return add(...a); };

  dragOver(tabB, 120);

  expect(order).toEqual(['read', 'write']);
});

describe('dropping a terminal tab on a split pane', () => {
  const { createSplitLayout } = require('../../src/renderer/ui/components/terminal/splitLayout');
  let container;
  let layout;
  let reads;

  beforeEach(() => {
    document.body.innerHTML = '<div id="terminals-container"></div>';
    container = document.getElementById('terminals-container');
    reads = 0;
    container.getBoundingClientRect = () => { reads++; return { left: 0, top: 0, width: 1200, height: 800 }; };
    for (const id of [1, 2]) {
      const w = document.createElement('div');
      w.className = 'terminal-wrapper';
      w.dataset.id = id;
      container.appendChild(w);
    }
    layout = createSplitLayout({
      getContainer: () => container,
      getActiveTerminal: () => 1,
      ownerOf: () => 'p1',
      canSplit: () => ({ ok: true }),
      resolveId: (text) => Number(text),
      activate: () => {},
      t: (k) => k,
      measure: () => ({ width: 1200, height: 800 }),
    });
    layout.apply();
    layout.beginTabDrag(2);
  });

  afterEach(() => layout.destroy());

  function paneDragOver(clientX, clientY) {
    const e = new Event('dragover', { bubbles: true, cancelable: true });
    e.clientX = clientX;
    e.clientY = clientY;
    e.dataTransfer = { dropEffect: '' };
    container.dispatchEvent(e);
  }

  /** Every style and class write on the drop indicator. */
  function countOverlayWrites() {
    const overlay = container.querySelector('.split-drop-overlay');
    const counter = { n: 0 };
    const style = overlay.style;
    for (const prop of ['left', 'top', 'width', 'height']) {
      let value = style[prop];
      Object.defineProperty(style, prop, { configurable: true, get: () => value, set: (v) => { counter.n++; value = v; } });
    }
    for (const method of ['add', 'remove', 'toggle']) {
      const original = overlay.classList[method].bind(overlay.classList);
      overlay.classList[method] = (...args) => { counter.n++; return original(...args); };
    }
    const hidden = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
    Object.defineProperty(overlay, 'hidden', { configurable: true, get() { return hidden.get.call(this); }, set(v) { counter.n++; hidden.set.call(this, v); } });
    return counter;
  }

  test('measures the panes once per drag, not once per pointer move', () => {
    for (let i = 0; i < 30; i++) paneDragOver(1100 + i, 300 + i);
    expect(reads).toBe(1);
  });

  test('repeated dragover in the same zone writes nothing', () => {
    paneDragOver(1150, 400); // right edge: one placement
    const writes = countOverlayWrites();
    for (let i = 0; i < 20; i++) paneDragOver(1150 + (i % 5), 400 + i);
    expect(writes.n).toBe(0);
  });

  test('changing zone writes, and only then', () => {
    paneDragOver(1150, 400);
    const writes = countOverlayWrites();
    paneDragOver(40, 400); // left edge now
    const afterCross = writes.n;
    for (let i = 0; i < 10; i++) paneDragOver(40 + i, 400);
    expect(afterCross).toBeGreaterThan(0);
    expect(writes.n).toBe(afterCross);
  });
});
