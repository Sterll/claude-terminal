/**
 * Press feedback - a short, soft "give" on every clickable control, so a click
 * reads as a click instead of an instant state swap.
 *
 * One delegated pointerdown listener and one Web Animations API call per
 * press. WAAPI rather than a CSS :active rule because it animates the
 * individual `scale` property: it composes with whatever `transform` the
 * control already uses for its own layout or hover lift, and it plays even on
 * controls whose stylesheet declares a `transition` that would leave a CSS
 * scale snapping. Large surfaces (cards, list rows) give less than small
 * buttons, so a wide row never visibly shrinks.
 *
 * Skipped under reduced motion (OS setting or the app's reduce-motion), inside
 * a terminal, and on text fields, where a press is the start of a selection.
 */

const PRESSABLE = [
  'button', 'a[href]', '[role="button"]', '[role="tab"]', '[role="option"]', '[role="menuitem"]', '[role="radio"]',
  '.nav-tab', '.terminal-tab', '.project-tab', '.settings-tab', '.chat-tab', '.ts-card', '.theme-card',
  '.color-swatch', '.settings-toggle', '.settings-dropdown-trigger', '.settings-dropdown-option',
  '.context-menu-item', '.quick-picker-item', '.project-item', '.folder-item', '.focus-item', '.focus-screen',
  '.wizard-type-card', '.scaffold-card', '.session-card', '.execution-mode-card',
].join(',');

const SKIP = '.xterm, input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"], .chat-input, select';

let reducedQuery = null;

function motionAllowed() {
  if (document.body.classList.contains('reduce-motion')) return false;
  if (!reducedQuery && window.matchMedia) reducedQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  return !reducedQuery?.matches;
}

function depthFor(el) {
  const { width, height } = el.getBoundingClientRect();
  const size = Math.max(width, height);
  if (size > 320) return 0.992;
  if (size > 160) return 0.975;
  return 0.94;
}

function onPointerDown(e) {
  if (e.button !== 0 || !motionAllowed()) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target || target.closest(SKIP)) return;
  const el = target.closest(PRESSABLE);
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' || typeof el.animate !== 'function') return;
  // A press already running is replaced, so rapid clicks never stack scales.
  el._ctPress?.cancel();
  // Drag sources (tabs, project rows) get a brightness pulse instead: their
  // reorder handlers measure rects during the drag, which a scale would skew.
  const frames = el.closest('[draggable="true"]')
    ? [{ filter: 'brightness(1)' }, { filter: 'brightness(1.35)', offset: 0.3 }, { filter: 'brightness(1)' }]
    : [{ scale: '1' }, { scale: String(depthFor(el)), offset: 0.35 }, { scale: '1' }];
  el._ctPress = el.animate(frames, { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
  el._ctPress.onfinish = () => { el._ctPress = null; };
}

function initPressFeedback() {
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
}

module.exports = { initPressFeedback, PRESSABLE };
