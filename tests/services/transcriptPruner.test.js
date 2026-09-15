/**
 * TranscriptPruner — bounds the mounted transcript, remounts on scroll-up,
 * and composes with the disk-history pager without breaking document order.
 */
const { createTranscriptPruner } = require('../../src/renderer/ui/components/TranscriptPruner');

const translate = (key, opts) => `${opts?.count} earlier`;

function entry(i) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.dataset.i = String(i);
  return el;
}

function mountedIds(messagesEl) {
  return Array.from(messagesEl.children)
    .filter((el) => el.dataset.i !== undefined)
    .map((el) => Number(el.dataset.i));
}

describe('TranscriptPruner', () => {
  let messagesEl, pruner, pinned;

  beforeEach(() => {
    messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);
    pinned = true;
    pruner = createTranscriptPruner({
      messagesEl,
      isPinnedToBottom: () => pinned,
      translate,
      cap: 10,
      floor: 6,
      chunk: 3,
      remountPx: 100,
    });
  });

  afterEach(() => {
    pruner.destroy();
    messagesEl.remove();
  });

  test('stays quiet under the cap', () => {
    for (let i = 0; i < 10; i++) messagesEl.appendChild(entry(i));
    pruner.prune();
    expect(mountedIds(messagesEl)).toHaveLength(10);
    expect(pruner.prunedCount).toBe(0);
    expect(pruner.markerEl.isConnected).toBe(false);
  });

  test('over the cap, detaches the oldest down to the floor', () => {
    for (let i = 0; i < 15; i++) messagesEl.appendChild(entry(i));
    pruner.prune();
    expect(mountedIds(messagesEl)).toEqual([9, 10, 11, 12, 13, 14]);
    expect(pruner.prunedCount).toBe(9);
    expect(pruner.markerEl.isConnected).toBe(true);
    expect(messagesEl.firstElementChild).toBe(pruner.markerEl);
    expect(pruner.markerEl.textContent).toBe('9 earlier');
  });

  test('never prunes while the user is scrolled up', () => {
    for (let i = 0; i < 15; i++) messagesEl.appendChild(entry(i));
    pinned = false;
    pruner.prune();
    expect(mountedIds(messagesEl)).toHaveLength(15);
  });

  test('scroll near the top remounts one chunk in order', () => {
    for (let i = 0; i < 15; i++) messagesEl.appendChild(entry(i));
    pruner.prune();

    Object.defineProperty(messagesEl, 'scrollTop', { value: 50, writable: true });
    pruner.onScroll();

    expect(mountedIds(messagesEl)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(pruner.prunedCount).toBe(6);
    // Marker still sits above everything remounted
    expect(messagesEl.firstElementChild).toBe(pruner.markerEl);
  });

  test('draining the store removes the marker', () => {
    for (let i = 0; i < 12; i++) messagesEl.appendChild(entry(i));
    pruner.prune();
    Object.defineProperty(messagesEl, 'scrollTop', { value: 0, writable: true });
    pruner.onScroll();
    pruner.onScroll();
    expect(pruner.prunedCount).toBe(0);
    expect(pruner.markerEl.isConnected).toBe(false);
    expect(mountedIds(messagesEl)).toEqual([...Array(12).keys()]);
  });

  test('mountAll restores everything in document order', () => {
    for (let i = 0; i < 25; i++) messagesEl.appendChild(entry(i));
    pruner.prune();
    pruner.prune(); // idempotent second pass
    pruner.mountAll();
    expect(mountedIds(messagesEl)).toEqual([...Array(25).keys()]);
    expect(pruner.markerEl.isConnected).toBe(false);
  });

  test('suspend blocks pruning until resume', () => {
    jest.useFakeTimers();
    for (let i = 0; i < 15; i++) messagesEl.appendChild(entry(i));
    pruner.suspend();
    pruner.prune();
    expect(mountedIds(messagesEl)).toHaveLength(15);
    pruner.resume();
    jest.runAllTimers();
    expect(mountedIds(messagesEl)).toHaveLength(6);
    jest.useRealTimers();
  });

  test('the disk-history pager rows are never pruned and stay above', () => {
    const historyTop = document.createElement('div');
    historyTop.className = 'chat-history-top';
    messagesEl.appendChild(historyTop);
    for (let i = 0; i < 15; i++) messagesEl.appendChild(entry(i));

    pruner.prune();

    expect(historyTop.isConnected).toBe(true);
    expect(messagesEl.children[0]).toBe(historyTop);
    expect(messagesEl.children[1]).toBe(pruner.markerEl);
    expect(mountedIds(messagesEl)).toEqual([9, 10, 11, 12, 13, 14]);
  });

  test('disk pages inserted above the marker keep order through a remount', () => {
    const historyTop = document.createElement('div');
    historyTop.className = 'chat-history-top';
    messagesEl.appendChild(historyTop);
    for (let i = 100; i < 115; i++) messagesEl.appendChild(entry(i));
    pruner.prune(); // store: 100..108, mounted: 109..114

    // The disk pager prepends an older page at historyTop.nextSibling,
    // exactly like loadEarlier does.
    const anchor = historyTop.nextSibling;
    for (let i = 0; i < 3; i++) messagesEl.insertBefore(entry(i), anchor);

    Object.defineProperty(messagesEl, 'scrollTop', { value: 0, writable: true });
    pruner.onScroll(); // remounts 106..108 below the marker

    // Top to bottom: disk page (oldest), marker, remounted, live tail.
    expect(mountedIds(messagesEl)).toEqual([0, 1, 2, 106, 107, 108, 109, 110, 111, 112, 113, 114]);
    const kids = Array.from(messagesEl.children);
    expect(kids.indexOf(pruner.markerEl)).toBe(4); // after historyTop + 3 disk entries
  });

  test('observer prunes automatically after appends', async () => {
    pruner.observe();
    for (let i = 0; i < 15; i++) messagesEl.appendChild(entry(i));
    await new Promise((r) => setTimeout(r, 5));
    expect(mountedIds(messagesEl)).toHaveLength(6);
  });

  test('destroy detaches the observer and the marker', async () => {
    pruner.observe();
    pruner.destroy();
    for (let i = 0; i < 15; i++) messagesEl.appendChild(entry(i));
    await new Promise((r) => setTimeout(r, 5));
    expect(mountedIds(messagesEl)).toHaveLength(15);
  });
});

// ── The two-sided window ──────────────────────────────────────────────
//
// Everything above runs in plain jsdom, where every offset reads 0, so it
// exercises the count-based fallback. These lay the transcript out by hand
// to reach the geometry path.
//
// The geometry is live rather than snapshotted — offsetTop is derived from
// the element's index among its siblings and scrollHeight from their count —
// because the behaviour under test is precisely how the pruner reacts to the
// heights it removes and puts back. A frozen harness would let a missing
// scroll compensation pass.

const ENTRY_H = 100;
const VIEW_H = 500;

function geoEntry(i) {
  const el = entry(i);
  Object.defineProperty(el, 'offsetHeight', { value: ENTRY_H, configurable: true });
  Object.defineProperty(el, 'offsetTop', {
    configurable: true,
    get() {
      const parent = el.parentNode;
      if (!parent) return 0;
      return Array.prototype.indexOf.call(parent.children, el) * ENTRY_H;
    },
  });
  return el;
}

/** Give the container a viewport and park the reader at `scrollTop`. */
function layout(messagesEl, scrollTop) {
  Object.defineProperty(messagesEl, 'clientHeight', { value: VIEW_H, configurable: true });
  Object.defineProperty(messagesEl, 'scrollHeight', {
    configurable: true,
    get() { return messagesEl.children.length * ENTRY_H; },
  });
  Object.defineProperty(messagesEl, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
}

describe('TranscriptPruner — two-sided window', () => {
  let messagesEl, pruner, pinned;

  beforeEach(() => {
    messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);
    pinned = true;
    pruner = createTranscriptPruner({
      messagesEl,
      isPinnedToBottom: () => pinned,
      translate,
      cap: 10,
      floor: 6,
      chunk: 100,
      remountPx: 600,
      minMounted: 5,
    });
  });

  afterEach(() => {
    pruner.destroy();
    messagesEl.remove();
  });

  /** 100 entries, reader parked over entry 50, geometry live. */
  function parkedMidway() {
    for (let i = 0; i < 100; i++) messagesEl.appendChild(geoEntry(i));
    layout(messagesEl, 5000);
    pinned = false;
  }

  const tick = () => new Promise((r) => setTimeout(r, 5));

  test('keeps the viewport plus a buffer and detaches both sides', () => {
    parkedMidway();

    pruner.prune();

    // buffer = max(500 * 2, 600 + 200) = 1000px, so ten entries either side
    // of a viewport that covers 5000..5500.
    const ids = mountedIds(messagesEl);
    expect(ids[0]).toBe(39);
    expect(ids[ids.length - 1]).toBe(65);
    expect(pruner.prunedCount).toBe(39);
    expect(pruner.prunedBelowCount).toBe(34);
  });

  test('prunes even though the reader is scrolled up — the one-sided regression', () => {
    parkedMidway();

    pruner.prune();

    // The previous pruner returned at its first line here and left all 100
    // mounted, which is how a long session ended up fully remounted.
    expect(mountedIds(messagesEl).length).toBeLessThan(30);
  });

  test('detaching above the viewport leaves the reader looking at the same entry', () => {
    parkedMidway();
    const anchor = messagesEl.children[50]; // the entry under the viewport top

    const offsetInView = anchor.offsetTop - messagesEl.scrollTop;
    pruner.prune();

    expect(anchor.isConnected).toBe(true);
    expect(anchor.offsetTop - messagesEl.scrollTop).toBe(offsetInView);
  });

  test('falls back to the pinned-only rule when the pane is not laid out', () => {
    parkedMidway();
    Object.defineProperty(messagesEl, 'clientHeight', { value: 0, configurable: true });

    pruner.prune();

    // No geometry and not pinned: acting would be guesswork, so it does not.
    expect(mountedIds(messagesEl)).toHaveLength(100);
  });

  test('both markers report their own side and vanish when drained', () => {
    parkedMidway();
    pruner.prune();

    expect(pruner.markerEl.textContent).toBe('39 earlier');
    expect(pruner.bottomMarkerEl.textContent).toBe('34 earlier');
    expect(messagesEl.firstElementChild).toBe(pruner.markerEl);
    expect(messagesEl.lastElementChild).toBe(pruner.bottomMarkerEl);

    pruner.mountAll();

    expect(mountedIds(messagesEl)).toEqual([...Array(100).keys()]);
    expect(pruner.markerEl.isConnected).toBe(false);
    expect(pruner.bottomMarkerEl.isConnected).toBe(false);
  });

  test('a remount is not handed straight back to the next prune', () => {
    parkedMidway();
    pruner.prune();

    messagesEl.scrollTop = 400; // within the remount trigger of the top
    pruner.onScroll();
    const topAfterRemount = mountedIds(messagesEl)[0];
    const aboveAfterRemount = pruner.prunedCount;

    pruner.prune(); // let the window settle

    // Remounting the deficit rather than a fixed chunk is the whole point:
    // a fixed chunk lands outside the buffer and goes straight back.
    expect(topAfterRemount).toBeLessThan(39);
    expect(mountedIds(messagesEl)[0]).toBe(topAfterRemount);
    expect(pruner.prunedCount).toBe(aboveAfterRemount);
  });

  test('scrolling back down remounts the newer entries before the end', () => {
    parkedMidway();
    pruner.prune();
    const before = pruner.prunedBelowCount;

    messagesEl.scrollTop = messagesEl.scrollHeight - VIEW_H - 400;
    pruner.onScroll();

    expect(pruner.prunedBelowCount).toBeLessThan(before);
    const ids = mountedIds(messagesEl);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  test('what streams in while the reader is scrolled up never grows the DOM', async () => {
    parkedMidway();
    pruner.prune();
    pruner.observe();
    const mounted = mountedIds(messagesEl).length;

    for (let i = 100; i < 140; i++) messagesEl.appendChild(geoEntry(i));
    await tick();

    expect(mountedIds(messagesEl).length).toBeLessThanOrEqual(mounted);
    expect(mountedIds(messagesEl).every((id) => id < 100)).toBe(true);
    expect(pruner.prunedBelowCount).toBeGreaterThanOrEqual(74);
  });

  test('drainBelow puts the real bottom back under the scroll-to-bottom jump', () => {
    parkedMidway();
    pruner.prune();

    pruner.drainBelow();

    expect(pruner.prunedBelowCount).toBe(0);
    expect(pruner.bottomMarkerEl.isConnected).toBe(false);
    const ids = mountedIds(messagesEl);
    expect(ids[ids.length - 1]).toBe(99);
  });

  test('a scrollTop past the end cannot blank the transcript', () => {
    parkedMidway();
    messagesEl.scrollTop = 999999;

    pruner.prune();

    const ids = mountedIds(messagesEl);
    expect(ids.length).toBeGreaterThanOrEqual(5);
    expect(ids[ids.length - 1]).toBe(99); // the window clamped to the real end
  });

  test('the disk pager row stays above the older marker', () => {
    const historyTop = document.createElement('div');
    historyTop.className = 'chat-history-top';
    messagesEl.appendChild(historyTop);
    parkedMidway();

    pruner.prune();

    expect(messagesEl.children[0]).toBe(historyTop);
    expect(messagesEl.children[1]).toBe(pruner.markerEl);
  });
});
