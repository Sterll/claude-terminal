/**
 * Pauses every infinite CSS animation while the window is unfocused.
 *
 * A composited animation forces the compositor to produce a frame on every
 * vsync, and the per-frame cost grows with the size of the document: measured
 * on a 68k-node transcript, a single 13px spinner costs ~30% of a core, and
 * eleven of them cost barely more than one. All the perpetual animations in
 * the app are "still working" indicators (spinners, status-dot pulses, the
 * streaming cursor, the dancing mascot), so freezing them while the user is
 * in another app changes nothing they can act on.
 *
 * Why not CSS, globally? `.background-paused` in base.css already pauses
 * everything on `visibilitychange`, but macOS only reports the document hidden
 * when the window is minimized or fully occluded, and a visible-but-unfocused
 * window keeps burning. Extending that class to blur would also pause *entry*
 * animations, and `chat-msg-in` starts at opacity 0: messages streamed into an
 * unfocused-but-visible window would render invisible.
 *
 * ── Why this no longer calls document.getAnimations() ───────────────────────
 *
 * It used to, on every blur and on a 100ms debounce after any animation start
 * while blurred. That call is superlinear in document size. Measured in this
 * app's own document, on the machine it ships to:
 *
 *      786 nodes        0 ms
 *    20786 nodes      534 ms
 *    80786 nodes   13 400 ms
 *   200786 nodes   97 000 ms
 *
 * A transcript of the size this module was written for therefore paid ~13 s of
 * frozen main thread *per blur*, which is the "I switch to another app, come
 * back, and the UI is stuck" report. Worse, `animationstart` re-armed the
 * sweep 100ms after each new spinner, so a session left streaming in the
 * background ran 13-second sweeps back to back for as long as it was away.
 * That is where a renderer pegged at a full core for days comes from.
 *
 * So nothing here walks the document any more. An element announces itself
 * through `animationstart`, we read *that element's* computed style to decide
 * whether it is perpetual, and we keep the handful that are. Both the tracking
 * and the pause are then bounded by the number of live spinners rather than by
 * the number of nodes on screen.
 *
 * Pausing is a class rather than `Animation.pause()` for the same reason: the
 * class is applied per element, only to elements whose animations are *all*
 * infinite, so it carries none of the objection that ruled out the global one.
 * It also avoids the spec wrinkle that pause()/play() detaches an animation's
 * play state from `animation-play-state`.
 */

/** Marks one element's perpetual animation as frozen. Defined in base.css. */
const PAUSE_CLASS = 'ct-anim-idle';

/**
 * A document walk is only affordable before the UI exists. `init()` runs at the
 * top of renderer.js, so this is the one moment the document is guaranteed
 * small; the guard is there in case that ever stops being true.
 */
const BOOT_SWEEP_MAX_NODES = 5000;

/** Elements carrying a perpetual animation, and nothing but. */
let _tracked = new Set();
let _blurred = false;

function _isInfinite(anim) {
  try {
    return anim.effect?.getTiming?.().iterations === Infinity;
  } catch (_) {
    return false;
  }
}

/**
 * True when every animation on this element (or pseudo-element) is infinite.
 *
 * "Every", not "any": the pause is a property of the element, so an element
 * running a spinner *and* an entry animation must be left alone rather than
 * frozen at the entry animation's opacity 0.
 *
 * One scoped computed-style read. `animationstart` is dispatched after style
 * has been resolved, so this is answered from the clean style tree and costs
 * nothing like the document walk it replaces.
 */
function _allInfinite(el, pseudo) {
  try {
    const counts = String(getComputedStyle(el, pseudo || null).animationIterationCount || '');
    if (!counts) return false;
    const parts = counts.split(',').map((c) => c.trim()).filter(Boolean);
    return parts.length > 0 && parts.every((c) => c === 'infinite');
  } catch (_) {
    return false;
  }
}

function _pause(el) {
  try { el.classList.add(PAUSE_CLASS); } catch (_) { /* detached */ }
}

function _resume(el) {
  try { el.classList.remove(PAUSE_CLASS); } catch (_) { /* detached */ }
}

function _onAnimationStart(e) {
  const el = e.target;
  if (!el || el.nodeType !== 1) return;
  if (!_allInfinite(el, e.pseudoElement)) return;
  _tracked.add(el);
  // A spinner that appears while the user is away must not run until they
  // come back; this is what the old debounced re-sweep was for.
  if (_blurred) _pause(el);
  // And an element re-entering the document can carry the class from a pause
  // it was detached through. Focus alone would not clear it: _apply() only
  // reaches what is still tracked, and a detached element was dropped there.
  else _resume(el);
}

function _onAnimationEnd(e) {
  // Perpetual animations never end, so this only fires for an element that has
  // stopped being one. Dropping it keeps the set to the live spinners.
  const el = e.target;
  if (!el || el.nodeType !== 1 || !_tracked.has(el)) return;
  _tracked.delete(el);
  _resume(el);
}

/** Walk the set once, dropping what has left the DOM. */
function _apply(fn) {
  for (const el of _tracked) {
    // A spinner whose message was pruned never fires animationend, so the set
    // would grow without bound on a long session without this.
    //
    // Unpause before forgetting it: TranscriptPruner detaches and later
    // re-appends *the same* nodes, so blur (pause) -> prune -> focus (drop,
    // with no resume) -> remount would put a permanently frozen spinner back on
    // screen, with nothing left tracking it to ever thaw it.
    if (!el.isConnected) {
      _resume(el);
      _tracked.delete(el);
      continue;
    }
    fn(el);
  }
}

function _onBlur() {
  _blurred = true;
  _apply(_pause);
}

function _onFocus() {
  _blurred = false;
  _apply(_resume);
}

/**
 * Catch animations already running when this module loads. Only safe because
 * it happens before the UI is built; see BOOT_SWEEP_MAX_NODES.
 */
function _bootSweep() {
  if (typeof document.getAnimations !== 'function') return;
  if (document.querySelectorAll('*').length > BOOT_SWEEP_MAX_NODES) return;
  try {
    for (const anim of document.getAnimations()) {
      const el = anim.effect?.target;
      if (el && el.nodeType === 1 && _isInfinite(anim)) _tracked.add(el);
    }
  } catch (_) { /* not supported */ }
}

function init() {
  window.addEventListener('blur', _onBlur);
  window.addEventListener('focus', _onFocus);
  // Capture phase: these fire on the animated element and this listener must
  // see them regardless of stopPropagation in component code.
  document.addEventListener('animationstart', _onAnimationStart, true);
  document.addEventListener('animationend', _onAnimationEnd, true);
  document.addEventListener('animationcancel', _onAnimationEnd, true);
  _bootSweep();
  // The window can start life unfocused (launched minimized, restored session).
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) _onBlur();
}

/** Test seam: tear down listeners and state. */
function _reset() {
  window.removeEventListener('blur', _onBlur);
  window.removeEventListener('focus', _onFocus);
  document.removeEventListener('animationstart', _onAnimationStart, true);
  document.removeEventListener('animationend', _onAnimationEnd, true);
  document.removeEventListener('animationcancel', _onAnimationEnd, true);
  for (const el of _tracked) _resume(el);
  _blurred = false;
  _tracked = new Set();
}

module.exports = { init, _reset, PAUSE_CLASS };
