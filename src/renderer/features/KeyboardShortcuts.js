/**
 * Keyboard Shortcuts Feature
 * Handles global keyboard shortcuts in the renderer
 */

const shortcuts = new Map();
let initialized = false;

/**
 * Register a keyboard shortcut
 * @param {string} key - Key combination (e.g., 'Ctrl+N', 'Escape')
 * @param {Function} handler - Handler function
 * @param {Object} options
 * @param {boolean} options.global - Whether shortcut works globally
 * @param {boolean} options.preventDefault - Whether to prevent default
 */
function registerShortcut(key, handler, options = {}) {
  const normalizedKey = normalizeKey(key);
  shortcuts.set(normalizedKey, {
    handler,
    global: options.global !== false,
    preventDefault: options.preventDefault !== false
  });
}

/**
 * Normalize key combination string
 * @param {string} key
 * @returns {string}
 */
function normalizeKey(key) {
  return key
    .toLowerCase()
    .replace(/\s+/g, '')
    .split('+')
    .sort((a, b) => {
      const order = ['ctrl', 'alt', 'shift', 'meta'];
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return 0;
    })
    .join('+');
}

/**
 * Get key combination from event
 * @param {KeyboardEvent} e
 * @returns {string}
 */
function getKeyFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('meta');

  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'arrowup') key = 'up';
  if (key === 'arrowdown') key = 'down';
  if (key === 'arrowleft') key = 'left';
  if (key === 'arrowright') key = 'right';

  if (!['ctrl', 'alt', 'shift', 'meta', 'control'].includes(key)) {
    parts.push(key);
  }

  return parts.join('+');
}

/**
 * Initialize keyboard shortcut handling
 */
function initKeyboardShortcuts() {
  // Prevent multiple initializations
  if (initialized) return;
  initialized = true;

  document.addEventListener('keydown', (e) => {
    // Skip if in input/textarea unless shortcut is global
    const isInInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) ||
                      e.target.isContentEditable;

    const key = getKeyFromEvent(e);
    const shortcut = shortcuts.get(key);

    if (shortcut) {
      if (isInInput && !shortcut.global) return;

      if (shortcut.preventDefault) {
        e.preventDefault();
      }

      shortcut.handler(e);
    }
  });
}

/**
 * Clear all shortcuts
 */
function clearAllShortcuts() {
  shortcuts.clear();
}

/**
 * Get all registered shortcuts
 * @returns {Map} Map of registered shortcuts
 */
function getRegisteredShortcuts() {
  return new Map(shortcuts);
}

module.exports = {
  registerShortcut,
  initKeyboardShortcuts,
  clearAllShortcuts,
  getRegisteredShortcuts,
  getKeyFromEvent,
  normalizeKey
};
