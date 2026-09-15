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

module.exports = { normalizeStoredKey, eventToNormalizedKey };
