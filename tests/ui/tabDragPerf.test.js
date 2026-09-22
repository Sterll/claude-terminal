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
