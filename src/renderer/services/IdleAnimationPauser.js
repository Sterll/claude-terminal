/**
 * Pauses every infinite CSS animation while the window is unfocused.
 *
 * A composited animation forces the compositor to produce a frame on every
 * vsync, and the per-frame cost grows with the size of the document — measured
 * on a 68k-node transcript, a single 13px spinner costs ~30% of a core, and
 * eleven of them cost barely more than one. All the perpetual animations in
 * the app are "still working" indicators (spinners, status-dot pulses, the
 * streaming cursor, the dancing mascot), so freezing them while the user is
 * in another app changes nothing they can act on.
 *
 * Why not CSS? `.background-paused` in base.css already pauses everything on
 * `visibilitychange`, but macOS only reports the document hidden when the
 * window is minimized or fully occluded — a visible-but-unfocused window
 * keeps burning. Extending that class to blur would also pause *entry*
 * animations, and `chat-msg-in` starts at opacity 0: messages streamed into
 * an unfocused-but-visible window would render invisible. Pausing through
 * the Web Animations API instead lets us select exactly the animations whose
 * iteration count is Infinity, across all stylesheets, present and future.
 *
 * Spec note: calling pause()/play() on a CSSAnimation detaches its play
 * state from the `animation-play-state` property. That is safe here because
 * this module only ever touches infinite animations, and it also fires on
 * the blur that precedes every minimize — so the animations it manages are
 * paused-by-API in exactly the states where the CSS class would have paused
 * them.
 */

/** Animations paused by this module, to resume on focus — and nothing else. */
let _paused = new Set();
let _blurred = false;
let _sweepTimer = null;

function _isInfinite(anim) {
  try {
    return anim.effect?.getTiming?.().iterations === Infinity;
  } catch (_) {
    return false;
  }
}

function _sweep() {
  _sweepTimer = null;
  if (!_blurred || typeof document.getAnimations !== 'function') return;
  for (const anim of document.getAnimations()) {
    if (anim.playState === 'running' && _isInfinite(anim)) {
      try {
        anim.pause();
        _paused.add(anim);
      } catch (_) { /* detached or already gone */ }
    }
  }
}

/** An animation that starts while blurred (new spinner in a background turn). */
function _onAnimationStart() {
  if (!_blurred || _sweepTimer) return;
  _sweepTimer = setTimeout(_sweep, 100);
}

function _onBlur() {
  _blurred = true;
  _sweep();
}

function _onFocus() {
  _blurred = false;
  if (_sweepTimer) {
    clearTimeout(_sweepTimer);
    _sweepTimer = null;
  }
  for (const anim of _paused) {
    try {
      anim.play();
    } catch (_) { /* element left the DOM while blurred */ }
  }
  _paused = new Set();
}

function init() {
  window.addEventListener('blur', _onBlur);
  window.addEventListener('focus', _onFocus);
  // Capture phase: animationstart fires on the animated element and this
  // listener must see it regardless of stopPropagation in component code.
  document.addEventListener('animationstart', _onAnimationStart, true);
  // The window can start life unfocused (launched minimized, restored session).
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) _onBlur();
}

/** Test seam: tear down listeners and state. */
function _reset() {
  window.removeEventListener('blur', _onBlur);
  window.removeEventListener('focus', _onFocus);
  document.removeEventListener('animationstart', _onAnimationStart, true);
  if (_sweepTimer) clearTimeout(_sweepTimer);
  _sweepTimer = null;
  _blurred = false;
  _paused = new Set();
}

module.exports = { init, _reset };
