/**
 * Keep the user's keyboard focus and caret where they are across a synchronous
 * UI update that is not theirs.
 *
 * An agent driving tabs over MCP (terminal_create, tab_close, the permission
 * tools) runs code written for a click: it activates tabs, re-runs the project
 * filter, clicks buttons that focus a feedback field. Those paths call focus()
 * as a matter of course, and the field the user was typing in loses its caret
 * between two keystrokes. Wrapping the update here puts focus, and the
 * selection inside the focused field, back exactly where they were.
 *
 * Synchronous on purpose: nothing the user types can be dispatched while `fn`
 * runs, so restoring afterwards is indistinguishable from never having moved.
 * An async update cannot be guarded this way, since the user may legitimately
 * move focus while it is pending; those paths have to avoid focusing instead.
 */

function isTextControl(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number';
}

/**
 * Is the user typing into `el`? A text field, a contenteditable composer, or
 * xterm's helper textarea, which is where a focused terminal takes its keys.
 * @param {Element|null} el
 */
function isTextEntry(el) {
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true';
}

function captureFocus(doc = document) {
  const el = doc.activeElement;
  const snapshot = { el, textSelection: null, ranges: [] };
  if (isTextControl(el)) {
    try { snapshot.textSelection = [el.selectionStart, el.selectionEnd, el.selectionDirection]; } catch (_) { /* input types without a caret */ }
  }
  const sel = doc.getSelection ? doc.getSelection() : null;
  if (sel) {
    for (let i = 0; i < sel.rangeCount; i++) snapshot.ranges.push(sel.getRangeAt(i).cloneRange());
  }
  return snapshot;
}

function sameRanges(sel, ranges) {
  if (sel.rangeCount !== ranges.length) return false;
  for (let i = 0; i < ranges.length; i++) {
    const a = sel.getRangeAt(i);
    const b = ranges[i];
    if (a.startContainer !== b.startContainer || a.startOffset !== b.startOffset
      || a.endContainer !== b.endContainer || a.endOffset !== b.endOffset) return false;
  }
  return true;
}

function restoreFocus(snapshot, doc = document) {
  const { el } = snapshot;
  const hadFocus = el && el !== doc.body && el !== doc.documentElement;

  if (hadFocus) {
    if (el.isConnected && doc.activeElement !== el) {
      try { el.focus({ preventScroll: true }); } catch (_) { /* detached between the checks */ }
    }
  } else if (doc.activeElement && doc.activeElement !== doc.body && typeof doc.activeElement.blur === 'function') {
    // Focus was nowhere (the user had clicked into a transcript): it goes back there.
    doc.activeElement.blur();
  }

  if (isTextControl(el)) {
    // A text control keeps its caret in the element, not in the document
    // selection, and re-adding a document range would pull focus out of it.
    const [start, end, direction] = snapshot.textSelection || [];
    if (typeof start === 'number' && (el.selectionStart !== start || el.selectionEnd !== end)) {
      try { el.setSelectionRange(start, end, direction); } catch (_) { /* not a caret type */ }
    }
    return;
  }

  const sel = doc.getSelection ? doc.getSelection() : null;
  if (!sel || sameRanges(sel, snapshot.ranges)) return;
  if (!snapshot.ranges.every(r => r.startContainer.isConnected && r.endContainer.isConnected)) return;
  sel.removeAllRanges();
  for (const range of snapshot.ranges) sel.addRange(range);
}

/**
 * Run `fn` and put focus and caret back where they were before it.
 * @template T
 * @param {() => T} fn - a synchronous update
 * @param {Document} [doc]
 * @returns {T}
 */
function preserveFocus(fn, doc = document) {
  const snapshot = captureFocus(doc);
  try {
    return fn();
  } finally {
    restoreFocus(snapshot, doc);
  }
}

module.exports = { preserveFocus, captureFocus, restoreFocus, isTextEntry };
