/**
 * One spelling for a keyboard shortcut.
 *
 * A binding is stored as text the user can edit ("Ctrl+Shift+K") and matched
 * against a KeyboardEvent, so both sides are reduced to the same normal form:
 * lower case, modifiers first in a fixed order, and the arrow/space aliases
 * spelled the short way. Without the fixed modifier order "shift+ctrl+k" and
 * "ctrl+shift+k" are different strings for the same chord.
 */

function normalizeStoredKey(key) {
  if (!key) return '';
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

function eventToNormalizedKey(e) {
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
 * The split-view shortcuts and their defaults. ShortcutsManager offers them for
 * rebinding like the other app shortcuts; the terminal key handler reads them
 * here so it can step aside for whatever the user bound them to. xterm answers
 * Ctrl+letter, Ctrl+Alt+letter and Alt+letter with control characters, so a
 * binding it did not let through would land in the shell as ^D or ESC ^S.
 */
const SPLIT_SHORTCUTS = {
  splitRight: 'Ctrl+Shift+D',
  splitDown: 'Ctrl+Shift+S',
};

/**
 * Whether a key event is one of the split shortcuts, as currently bound.
 * @param {KeyboardEvent} e
 * @param {Object} [customShortcuts] - the `shortcuts` setting
 */
function isSplitShortcut(e, customShortcuts) {
  if (!e || !e.key) return false;
  const custom = customShortcuts || {};
  const pressed = eventToNormalizedKey(e);
  return Object.keys(SPLIT_SHORTCUTS).some((id) => {
    const bound = normalizeStoredKey(custom[id] || SPLIT_SHORTCUTS[id]);
    return bound !== '' && bound === pressed;
  });
}

module.exports = { normalizeStoredKey, eventToNormalizedKey, SPLIT_SHORTCUTS, isSplitShortcut };
