/**
 * TranscriptPruner — a two-sided virtual window over the mounted transcript.
 *
 * Interaction latency in the chat scales with the number of mounted elements,
 * not with what is visible: measured on a 68k-node transcript, revealing the
 * pane costs ~1.4s of main-thread work and a keystroke waits ~1s for its
 * frame — with the exact same figures whether animations run or not, and
 * `content-visibility` does not help because style recalc still walks every
 * element. At ~5k nodes the same interactions cost 149ms / 29ms.
 *
 * The first version of this file bounded the transcript on one side only. It
 * detached everything beyond the newest `floor` entries, and only while the
 * user was pinned to the bottom, which left the original pathology reachable:
 * scrolling up to read stopped all pruning, remounted a chunk at a time on the
 * way up, and never shed any of it again, so a reader who walked back through
 * a long session ended up with the whole thing mounted.
 *
 * The window now has two sides and no longer depends on where the user is
 * parked. Given the viewport, entries more than `bufferScreens` above it go to
 * the `above` store and entries that far below go to `below`; both remount
 * before the reader reaches them. Neither store is a cache — the nodes keep
 * their listeners and dataset and remount byte-for-byte, so memory is
 * unchanged by design and only the rendering cost is shed.
 *
 * Geometry is what makes a two-sided window safe, and it is not always
 * available: a hidden pane (`display:none`, a background tab, a collapsed
 * flex parent) reports every offset as 0, and acting on that would detach the
 * whole transcript. When `clientHeight` is 0 the pruner falls back to the
 * original count-based, pinned-only rule, which needs no geometry to be
 * correct. That fallback is the proven path, so nothing regresses where the
 * new one cannot be trusted.
 *
 * Both boundaries carry a marker row, and the markers double as insertion
 * anchors. Disk pages land above `chat-pruned-top`, remounted-older entries
 * just below it, remounted-newer entries just above `chat-pruned-bottom`, and
 * whatever the stream appends while the reader is scrolled up lands after
 * `chat-pruned-bottom` and is absorbed into `below` on the next tick. That is
 * document order at every step, which is what lets this compose with the
 * disk-history pager rather than fight it.
 *
 * The far side of `above` is not kept as nodes at all. A detached entry is
 * still a full Blink tree with its listeners: measured in this document, 10k
 * entries detached-but-kept cost 34 118 bytes each of renderer RSS, against
 * 1 017 bytes for the same entry held as its own `outerHTML`. Past
 * `serializeAfter` detached entries, anything the caller marks inert through
 * `canSerialize` is replaced by that string and rebuilt on remount, which is
 * where the 33x goes.
 *
 * Only `above`, and only with the caller's say-so. `below` is where the stream
 * appends while the reader is scrolled up, so an entry there may still be
 * written to; `above` is strictly older than the viewport and the stream never
 * reaches back into it. And `canSerialize` defaults to refusing, so a card type
 * nobody has vouched for is never silently flattened: rebuilding drops any
 * listener attached to that element, which is fine for a prose turn whose
 * interactions are delegated from the transcript root and wrong for a card that
 * wired its own.
 *
 * There are deliberately no spacer elements. Detaching simply removes the
 * height, and the top remount compensates `scrollTop` by the height it just
 * inserted, so the reader's view never moves. A spacer would keep the
 * scrollbar steadier, but it also means scrolling up into blank space that
 * fills in below the viewport rather than at it — the reader arrives at the
 * marker having seen nothing. Receding-bottom behaviour is how every infinite
 * scroll works and needs no such trick.
 */

/** Entries the pruner must never absorb: the pagers' own top-of-list rows. */
const SKIP_CLASSES = ['chat-history-top', 'chat-pruned-top', 'chat-pruned-bottom'];

function createTranscriptPruner({
  messagesEl,
  isPinnedToBottom,
  translate,
  cap = 300,
  floor = 250,
  chunk = 100,
  remountPx = 600,
  bufferScreens = 2,
  minMounted = 20,
  serializeAfter = 150,
  canSerialize = () => false,
}) {
  // Older entries, oldest first. Each is either the detached element or, past
  // `serializeAfter`, a `{ html }` record it is rebuilt from.
  const above = [];
  const below = []; // detached newer entries, oldest first, always elements
  let suspended = false;
  let scheduled = false;
  let destroyed = false;

  const marker = document.createElement('div');
  marker.className = 'chat-history-top chat-pruned-top';

  const bottomMarker = document.createElement('div');
  bottomMarker.className = 'chat-history-top chat-pruned-bottom';

  const observer = new MutationObserver(onMutation);

  function _isFlattened(rec) {
    return rec !== null && typeof rec === 'object' && typeof rec.html === 'string';
  }

  /**
   * The live node for a stored record, rebuilt from its markup when that is
   * what we kept. Parsed inside a `<template>`, which is inert: its content
   * belongs to a separate document, so nothing in it loads or runs until the
   * node is adopted.
   *
   * @returns {Element|null} null when the markup yielded no element, which
   *   would mean a record was stored for something that was never one.
   */
  function _materialize(rec) {
    if (!_isFlattened(rec)) return rec;
    const tpl = document.createElement('template');
    tpl.innerHTML = rec.html;
    return tpl.content.firstElementChild;
  }

  /**
   * Replace the far end of `above` with its own markup.
   *
   * The newest `serializeAfter` detached entries stay as nodes: they are the
   * ones a scroll is about to ask for, and remounting those byte-for-byte is
   * what keeps the boundary cheap. Everything older is memory nobody is about
   * to look at.
   */
  function _flattenFarAbove() {
    // No guard on `serializeAfter` itself: it is a count of entries to keep as
    // nodes, so 0 means flatten everything detached and a number larger than
    // the store leaves the loop empty. `canSerialize` is the off switch, and it
    // refuses by default.
    const limit = above.length - serializeAfter;
    for (let i = 0; i < limit; i++) {
      const rec = above[i];
      if (_isFlattened(rec)) continue;
      if (!canSerialize(rec)) continue;
      above[i] = { html: rec.outerHTML };
    }
  }

  function _isSkippable(el) {
    return SKIP_CLASSES.some((c) => el.classList?.contains(c));
  }

  /** Mounted entries in document order, markers and pager rows excluded. */
  function _mountedEntries() {
    return Array.from(messagesEl.children).filter((el) => !_isSkippable(el));
  }

  function _updateMarker() {
    if (above.length === 0) {
      marker.remove();
      return;
    }
    marker.textContent = translate('chat.olderMessages', { count: above.length });
    if (!marker.isConnected) {
      // Below the disk pager's row if there is one, above everything else.
      const historyTop = messagesEl.querySelector('.chat-history-top:not(.chat-pruned-top):not(.chat-pruned-bottom)');
      if (historyTop) historyTop.after(marker);
      else messagesEl.prepend(marker);
    }
  }

  function _updateBottomMarker() {
    if (below.length === 0) {
      bottomMarker.remove();
      return;
    }
    bottomMarker.textContent = translate('chat.newerMessages', { count: below.length });
    if (!bottomMarker.isConnected) messagesEl.appendChild(bottomMarker);
  }

  /**
   * Anything the stream appended after the bottom marker belongs to `below`:
   * it is newer than everything already detached there, and leaving it mounted
   * would let the tail grow without bound while the reader is scrolled up.
   */
  function _absorbTail() {
    if (!bottomMarker.isConnected) return;
    let node = bottomMarker.nextSibling;
    while (node) {
      const next = node.nextSibling;
      if (node.nodeType === 1 && !_isSkippable(node)) {
        below.push(node);
        node.remove();
      }
      node = next;
    }
  }

  function onMutation() {
    if (suspended || destroyed) return;
    _absorbTail();
    schedulePrune();
  }

  function schedulePrune() {
    if (scheduled || suspended || destroyed) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      prune();
    }, 0);
  }

  /** True when the pane is laid out and its offsets can be believed. */
  function _hasGeometry() {
    return messagesEl.clientHeight > 0;
  }

  /** Slack kept mounted on each side of the viewport. */
  function _bufferPx() {
    return Math.max(messagesEl.clientHeight * bufferScreens, remountPx + 200);
  }

  /**
   * How many detached entries it takes to cover `px`, using the mounted
   * entries as the only sample available of how tall an entry is.
   *
   * Remounting a fixed count is what makes a two-sided window thrash: the
   * batch is inserted at the boundary, which pushes the viewport that much
   * further from it, so most of what was just mounted lands outside the buffer
   * and the very next prune detaches it again. Remounting the deficit instead
   * — enough to restore the buffer, no more — settles in one pass.
   */
  function _entriesToCover(px) {
    if (px <= 0) return 1;
    const entries = _mountedEntries();
    if (!entries.length) return chunk;
    const first = entries[0];
    const last = entries[entries.length - 1];
    const span = (last.offsetTop + last.offsetHeight) - first.offsetTop;
    const avg = span > 0 ? span / entries.length : 0;
    if (avg <= 0) return chunk;
    return Math.max(1, Math.min(chunk, Math.ceil(px / avg)));
  }

  function prune() {
    if (suspended || destroyed) return;
    _absorbTail();
    if (_hasGeometry()) _pruneByGeometry();
    else _pruneByCount();
    _flattenFarAbove();
  }

  /**
   * The original rule, kept verbatim for the case where geometry is unknown.
   * Pruning while the user reads upward would yank content they are heading
   * for, and without offsets there is no way to tell how far up they are —
   * pinned-to-bottom is the only state where the top is provably unreachable.
   */
  function _pruneByCount() {
    if (!isPinnedToBottom()) return;

    const entries = _mountedEntries();
    if (entries.length <= cap) return;

    const excess = entries.length - floor;
    for (let i = 0; i < excess; i++) {
      above.push(entries[i]);
      entries[i].remove();
    }
    _updateMarker();
  }

  /**
   * Keep the viewport plus `bufferScreens` of slack on each side; detach the
   * rest. Offsets are snapshotted in one pass before anything is removed, so
   * this costs a single layout flush rather than one per entry.
   */
  function _pruneByGeometry() {
    const entries = _mountedEntries();
    if (entries.length <= minMounted) return;

    const viewH = messagesEl.clientHeight;
    // A browser clamps scrollTop to the scrollable range; a stale or
    // out-of-range value here would put the keep window off the end of the
    // transcript and detach everything that is actually on screen.
    const maxTop = Math.max(0, messagesEl.scrollHeight - viewH);
    const viewTop = Math.min(Math.max(messagesEl.scrollTop, 0), maxTop);
    const buffer = _bufferPx();
    const keepTop = viewTop - buffer;
    const keepBottom = viewTop + viewH + buffer;

    const geo = entries.map((el) => ({ el, top: el.offsetTop, h: el.offsetHeight }));

    let first = 0;
    while (first < geo.length && geo[first].top + geo[first].h < keepTop) first++;
    let last = geo.length - 1;
    while (last > first && geo[last].top > keepBottom) last--;

    // A pane that measures oddly must never be able to blank the transcript.
    while (last - first + 1 < minMounted && (first > 0 || last < geo.length - 1)) {
      if (first > 0) first--;
      if (last < geo.length - 1) last++;
    }

    if (first === 0 && last === geo.length - 1) return;

    // Below first: everything it removes is under the viewport, so the view
    // does not move and the measurement for the top pass stays honest.
    // Entries leaving the mounted region are older than whatever is already
    // in `below`, hence unshift rather than push.
    for (let i = geo.length - 1; i > last; i--) {
      below.unshift(geo[i].el);
      geo[i].el.remove();
    }
    _updateBottomMarker();

    // The top pass takes its height out from above the viewport, which would
    // otherwise pull the reader's content up by exactly that much. Chrome's
    // scroll anchoring usually hides this, but it is heuristic and can be
    // opted out of, so compensate explicitly rather than depend on it.
    //
    // The measurement has to span the marker as well: it is inserted above the
    // viewport too, and leaving its height out of the delta is worth a visible
    // jump of one row on the first prune.
    const beforeHeight = messagesEl.scrollHeight;
    const beforeTop = messagesEl.scrollTop;
    for (let i = 0; i < first; i++) {
      above.push(geo[i].el);
      geo[i].el.remove();
    }
    _updateMarker();
    if (first > 0) {
      messagesEl.scrollTop = beforeTop - (beforeHeight - messagesEl.scrollHeight);
    }
  }

  /** Remount the newest pruned entries just below the marker, keeping the
   *  viewport still. One batch per call; the next scroll event pulls more. */
  function remountChunk(count) {
    if (above.length === 0) return;
    const want = count ?? (_hasGeometry() ? _entriesToCover(_bufferPx() - messagesEl.scrollTop) : chunk);
    const batch = above.splice(-want);
    const beforeHeight = messagesEl.scrollHeight;
    const beforeTop = messagesEl.scrollTop;
    const frag = document.createDocumentFragment();
    for (const rec of batch) {
      const el = _materialize(rec);
      if (el) frag.appendChild(el);
    }
    _updateMarker(); // marker must exist (or vanish) before we anchor on it
    if (marker.isConnected) marker.after(frag);
    else messagesEl.prepend(frag);
    messagesEl.scrollTop = beforeTop + (messagesEl.scrollHeight - beforeHeight);
  }

  /** Remount the oldest of the newer entries, just above the bottom marker.
   *  Everything it inserts is below the viewport, so nothing has to move. */
  function remountChunkBelow(count) {
    if (below.length === 0) return;
    const want = count ?? (_hasGeometry() ? _entriesToCover(_bufferPx() - _distanceFromBottom()) : chunk);
    const batch = below.splice(0, want);
    const frag = document.createDocumentFragment();
    for (const el of batch) frag.appendChild(el);
    if (bottomMarker.isConnected) bottomMarker.before(frag);
    else messagesEl.appendChild(frag);
    _updateBottomMarker();
  }

  function _distanceFromBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  }

  /** Call from the transcript's scroll handler. */
  function onScroll() {
    if (suspended || destroyed) return;
    if (above.length > 0 && messagesEl.scrollTop <= remountPx) remountChunk();
    if (below.length > 0 && _distanceFromBottom() <= remountPx) remountChunkBelow();
    // The window has to follow the viewport, not just DOM mutations: a reader
    // scrolling through a transcript nothing is appending to would otherwise
    // never shed what they left behind.
    schedulePrune();
  }

  /** Everything newer back in the DOM, so the bottom is the real bottom.
   *  The scroll-to-bottom affordance needs this before it jumps. */
  function drainBelow() {
    while (below.length > 0) {
      const batch = below.splice(0, chunk);
      const frag = document.createDocumentFragment();
      for (const el of batch) frag.appendChild(el);
      if (bottomMarker.isConnected) bottomMarker.before(frag);
      else messagesEl.appendChild(frag);
    }
    _updateBottomMarker();
  }

  /** Everything back in the DOM — in-chat search walks the mounted tree. */
  function mountAll() {
    while (above.length > 0) {
      const batch = above.splice(-chunk);
      const frag = document.createDocumentFragment();
      for (const rec of batch) {
        const el = _materialize(rec);
        if (el) frag.appendChild(el);
      }
      if (marker.isConnected) marker.after(frag);
      else messagesEl.prepend(frag);
    }
    _updateMarker();
    drainBelow();
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
    bottomMarker.remove();
    above.length = 0;
    below.length = 0;
  }

  return {
    observe, onScroll, mountAll, drainBelow, suspend, resume, destroy,
    /** Test seams. */
    prune, remountChunk, remountChunkBelow,
    get prunedCount() { return above.length; },
    get flattenedCount() { return above.filter(_isFlattened).length; },
    get prunedBelowCount() { return below.length; },
    get markerEl() { return marker; },
    get bottomMarkerEl() { return bottomMarker; },
  };
}

module.exports = { createTranscriptPruner };
