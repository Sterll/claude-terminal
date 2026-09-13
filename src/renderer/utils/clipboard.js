/**
 * Clipboard access for the renderer.
 *
 * Every copy button in the app used to call `navigator.clipboard.writeText()`
 * directly, and all of them broke at once when main.js started gating
 * permissions with an allowlist: Chromium runs a `clipboard-sanitized-write`
 * check inside writeText(), and a denied check rejects the promise with no
 * visible error. The permission is allowed again, but the web API stays the
 * fallback rather than the primary path — it also rejects when the document
 * does not have focus, which a button click does not always guarantee (a copy
 * fired from a context menu, a toast action, or a devtools-focused window).
 *
 * Electron's own clipboard module, reached over the `app.clipboardWrite` IPC,
 * has neither constraint. So: bridge first, web API second.
 */

/**
 * Write text to the system clipboard.
 * @param {string} text
 * @returns {Promise<boolean>} Whether the write went through
 */
async function copyText(text) {
  if (typeof text !== 'string' || !text) return false;

  const bridge = window.electron_api?.app?.clipboardWrite;
  if (bridge) {
    try {
      await bridge(text);
      return true;
    } catch (_) {
      // Fall through to the web API rather than losing the copy.
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Read text from the system clipboard.
 * @returns {Promise<string>} The clipboard text, or '' when unreadable
 */
async function readText() {
  const bridge = window.electron_api?.app?.clipboardRead;
  if (bridge) {
    try {
      const text = await bridge();
      if (typeof text === 'string') return text;
    } catch (_) {
      // Fall through.
    }
  }

  try {
    return await navigator.clipboard.readText();
  } catch (_) {
    return '';
  }
}

module.exports = { copyText, readText };
