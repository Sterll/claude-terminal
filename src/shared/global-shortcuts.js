'use strict';

/**
 * Global shortcut resolution.
 *
 * Turns the stored settings (defaults + user overrides) into the list of
 * accelerators to hand to Electron's `globalShortcut`. Shared with the
 * renderer, which reuses `isUnsafeAccelerator` so the shortcut capture UI
 * rejects the same keys the main process would refuse — and free of any
 * electron import, so the rules that decide what gets grabbed at the OS level
 * can be tested directly.
 */

/**
 * Default keybindings, in Electron accelerator form.
 *
 * `globalPushToTalk` is deliberately unbound. It shipped as `F13`, which froze
 * the keyboard system-wide on Linux (issue #166, see X11_UNSAFE_KEYS), and a
 * global grab has no business existing for a feature the user never configured:
 * binding a key is the opt-in.
 */
const GLOBAL_SHORTCUT_DEFAULTS = {
  globalQuickPicker: 'CommandOrControl+Shift+P',
  globalNewTerminal: 'CommandOrControl+Shift+T',
  globalNewWorktree: 'CommandOrControl+Shift+W',
  globalPushToTalk: null
};

/**
 * Keys that X11 layouts commonly leave unmapped.
 *
 * Electron resolves an accelerator to an X11 keycode through
 * `XKeysymToKeycode`, which returns 0 when the keysym is absent from the
 * current layout — and in X11 keycode 0 is `AnyKey`. The resulting `XGrabKey`
 * then swallows *every* keystroke on the machine rather than one combination,
 * so the keyboard stays dead until the app quits. `register()` returns true
 * throughout: the grab really did succeed, it was just far wider than asked.
 *
 * Node cannot query the XKB layout, so the hazardous keys are refused outright.
 * F13-F24 have no key on a standard board and are missing from the default
 * `pc` symbols map, which is exactly why they look attractive as a global bind.
 */
const X11_UNSAFE_KEYS = new Set([
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18',
  'F19', 'F20', 'F21', 'F22', 'F23', 'F24'
]);

/**
 * Convert a renderer-style key string (`Ctrl+Shift+P`) to an Electron accelerator.
 *
 * @param {string} key
 * @returns {string|null}
 */
function toElectronAccelerator(key) {
  if (!key) return null;
  return key.replace(/Ctrl/gi, 'CommandOrControl')
    .replace(/Meta/gi, 'CommandOrControl');
}

/**
 * Whether grabbing this accelerator risks taking the whole keyboard down.
 *
 * @param {string} accelerator - Electron accelerator form
 * @param {string} platform - `process.platform` value
 * @returns {boolean}
 */
function isUnsafeAccelerator(accelerator, platform) {
  if (platform !== 'linux' || !accelerator) return false;
  const key = String(accelerator).split('+').pop().trim().toUpperCase();
  return X11_UNSAFE_KEYS.has(key);
}

/**
 * Resolve the accelerators to register.
 *
 * An override is honoured only when the id is actually present in the stored
 * overrides: an absent id falls back to the default, while an id present with
 * an empty value means the user unbound it on purpose and nothing is grabbed.
 * Without that distinction clearing a binding silently restored the default.
 *
 * @param {{ overrides?: Object, enabled?: boolean }} config
 * @param {string} [platform] - defaults to the running platform
 * @returns {{ resolved: Array<{ id: string, accelerator: string }>, rejected: Array<{ id: string, accelerator: string, reason: string }> }}
 */
function resolveGlobalShortcuts(config = {}, platform = process.platform) {
  const resolved = [];
  const rejected = [];

  if (config.enabled === false) return { resolved, rejected };

  const overrides = config.overrides || {};

  for (const [id, defaultAccelerator] of Object.entries(GLOBAL_SHORTCUT_DEFAULTS)) {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, id);
    const accelerator = hasOverride
      ? toElectronAccelerator(overrides[id])
      : defaultAccelerator;

    if (!accelerator) continue;

    if (isUnsafeAccelerator(accelerator, platform)) {
      rejected.push({
        id,
        accelerator,
        reason: 'This key is often unmapped on X11, where grabbing it would capture the entire keyboard. Pick another key.'
      });
      continue;
    }

    resolved.push({ id, accelerator });
  }

  return { resolved, rejected };
}

/**
 * Whether a `before-input-event` input is the key press an accelerator names.
 *
 * This is the in-window half of a global shortcut. On a native Wayland session
 * `globalShortcut.register()` returns true and then never fires unless the
 * compositor implements the GlobalShortcuts portal, which GNOME only does from
 * 48 on — so on Ubuntu 24.04 Ctrl+Shift+T did nothing, even with the window
 * focused, because nothing else in the app listened for it. Where the OS grab
 * does work it consumes the key first and the window never sees it.
 *
 * Modifiers must match exactly, so Ctrl+Shift+T does not also answer
 * Ctrl+Alt+Shift+T.
 *
 * @param {string} accelerator - Electron accelerator form
 * @param {{ type?: string, key?: string, code?: string, control?: boolean, meta?: boolean, alt?: boolean, shift?: boolean, isAutoRepeat?: boolean }} input
 * @param {string} [platform] - defaults to the running platform
 * @returns {boolean}
 */
function matchesAccelerator(accelerator, input, platform = process.platform) {
  if (!accelerator || !input || input.type !== 'keyDown' || input.isAutoRepeat) return false;

  const want = { control: false, meta: false, alt: false, shift: false };
  let key = null;
  for (const raw of String(accelerator).split('+')) {
    const part = raw.trim().toLowerCase();
    if (part === 'commandorcontrol' || part === 'cmdorctrl') {
      want[platform === 'darwin' ? 'meta' : 'control'] = true;
    } else if (part === 'control' || part === 'ctrl') {
      want.control = true;
    } else if (part === 'command' || part === 'cmd' || part === 'super' || part === 'meta') {
      want.meta = true;
    } else if (part === 'alt' || part === 'option') {
      want.alt = true;
    } else if (part === 'shift') {
      want.shift = true;
    } else {
      key = part;
    }
  }
  if (!key) return false;

  for (const mod of Object.keys(want)) {
    if (!!input[mod] !== want[mod]) return false;
  }

  // `key` is layout- and shift-dependent (Shift+1 is "!"), `code` is the
  // physical key; a single letter or digit is compared on `code` so Shift does
  // not change what it reads as.
  const code = String(input.code || '');
  if (/^[a-z]$/.test(key)) return code === `Key${key.toUpperCase()}` || String(input.key).toLowerCase() === key;
  if (/^[0-9]$/.test(key)) return code === `Digit${key}` || String(input.key) === key;
  return String(input.key || '').toLowerCase() === key || code.toLowerCase() === key;
}

module.exports = {
  GLOBAL_SHORTCUT_DEFAULTS,
  X11_UNSAFE_KEYS,
  toElectronAccelerator,
  isUnsafeAccelerator,
  matchesAccelerator,
  resolveGlobalShortcuts
};
