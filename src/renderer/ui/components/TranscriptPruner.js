/**
 * Keeps the mounted transcript bounded.
 *
 * Interaction latency in the chat scales with the number of mounted elements,
 * not with what is visible: measured on a 68k-node transcript, revealing the
 * pane costs ~1.4s of main-thread work and a keystroke waits ~1s for its
 * frame — with the exact same figures whether animations run or not, and
 * `content-visibility` does not help because style recalc still walks every
 * element. At ~5k nodes the same interactions cost 149ms / 29ms.
 *
 * So: when the user is pinned to the bottom (the only state in which the top
 * of the transcript is out of reach anyway), everything beyond the newest
 * `floor` entries is detached into an in-memory store, represented by a
 * marker row at the top. Scrolling back up remounts the store chunk by chunk
 * before the reader gets there, mirroring the disk-history pager that resumed
 * sessions already use; the two compose because the disk pager inserts above
 * this marker and the remounts insert below it, which is exactly document
 * order (disk pages are older than pruned entries).
 *
 * The detached nodes keep their listeners and dataset, so remounting restores
 * them byte-for-byte. Memory is unchanged by design — the nodes exist either
 * way; only the rendering cost of keeping them mounted is shed.
 */

/** Entries the pruner must never absorb: the pagers' own top-of-list rows. */
const SKIP_CLASSES = ['chat-history-top', 'chat-pruned-top'];

function createTranscriptPruner({
  messagesEl,
  isPinnedToBottom,
  translate,
  cap = 300,
  floor = 250,
  chunk = 100,
  remountPx = 600,
}) {
  const store = []; // detached entries, oldest first
  let suspended = false;
  let scheduled = false;
  let destroyed = false;

  const marker = document.createElement('div');
  marker.className = 'chat-history-top chat-pruned-top';

  const observer = new MutationObserver(schedulePrune);

  function _isSkippable(el) {
    return SKIP_CLASSES.some((c) => el.classList?.contains(c));
  }

  function _updateMarker() {
    if (store.length === 0) {
      marker.remove();
      return;
    }
    marker.textContent = translate('chat.olderMessages', { count: store.length });
    if (!marker.isConnected) {
      // Below the disk pager's row if there is one, above everything else.
      const historyTop = messagesEl.querySelector('.chat-history-top:not(.chat-pruned-top)');
      if (historyTop) historyTop.after(marker);
      else messagesEl.prepend(marker);
    }
  }

  function schedulePrune() {
    if (scheduled || suspended || destroyed) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      prune();
    }, 0);
  }

  function prune() {
    if (suspended || destroyed) return;
    // Pruning while the user reads upward would yank content they are heading
    // for; pinned-to-bottom is the only state where the top is unreachable.
    if (!isPinnedToBottom()) return;

    const entries = Array.from(messagesEl.children).filter((el) => !_isSkippable(el));
    if (entries.length <= cap) return;

    const excess = entries.length - floor;
    for (let i = 0; i < excess; i++) {
      store.push(entries[i]);
      entries[i].remove();
    }
    _updateMarker();
  }

  /** Remount the newest pruned chunk just below the marker, keeping the
   *  viewport still. One chunk per call; the next scroll event pulls more. */
  function remountChunk() {
    if (store.length === 0) return;
    const batch = store.splice(-chunk);
    const beforeHeight = messagesEl.scrollHeight;
    const beforeTop = messagesEl.scrollTop;
    const frag = document.createDocumentFragment();
    for (const el of batch) frag.appendChild(el);
    _updateMarker(); // marker must exist (or vanish) before we anchor on it
    if (marker.isConnected) marker.after(frag);
    else messagesEl.prepend(frag);
    messagesEl.scrollTop = beforeTop + (messagesEl.scrollHeight - beforeHeight);
  }

  /** Call from the transcript's scroll handler. */
  function onScroll() {
    if (suspended || destroyed || store.length === 0) return;
    if (messagesEl.scrollTop <= remountPx) remountChunk();
  }

  /** Everything back in the DOM — in-chat search walks the mounted tree. */
  function mountAll() {
    while (store.length > 0) {
      const batch = store.splice(-chunk);
      const frag = document.createDocumentFragment();
      for (const el of batch) frag.appendChild(el);
      if (marker.isConnected) marker.after(frag);
      else messagesEl.prepend(frag);
    }
    _updateMarker();
  }

  function suspend() {
    suspended = true;
  }

  function resume() {
    suspended = false;
    schedulePrune();
  }

  function observe() {
    observer.observe(messagesEl, { childList: true });
    schedulePrune();
  }

  function destroy() {
    destroyed = true;
    observer.disconnect();
    marker.remove();
    store.length = 0;
  }

  return {
    observe, onScroll, mountAll, suspend, resume, destroy,
    /** Test seams. */
    prune, remountChunk,
    get prunedCount() { return store.length; },
    get markerEl() { return marker; },
  };
}

module.exports = { createTranscriptPruner };
