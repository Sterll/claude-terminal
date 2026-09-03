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
