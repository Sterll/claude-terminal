/**
 * Renderer Utilities - Central Export
 */

const dom = require('./dom');
const color = require('./color');
const paths = require('./paths');
const format = require('./format');
const fileIcons = require('./fileIcons');

// ── syntaxHighlight is deliberately NOT part of the eager barrel ──
//
// It pulls in highlight.js core plus 25 grammars. This barrel is required at
// boot (src/renderer/index.js), so spreading the module here made every
// session build all 25 grammars before the first frame, even when no code is
// ever highlighted. It is now resolved on first use instead.
//
// `highlight` stays a *synchronous* function: every call site (ChatView,
// TerminalManager, the markdown block builders, DatabasePanel,
// SkillsAgentsPanel) uses its return value inline while building an HTML
// string, so it cannot become a promise without breaking them.
let _syntaxHighlight = null;
function syntaxHighlight() {
  if (!_syntaxHighlight) _syntaxHighlight = require('./syntaxHighlight');
  return _syntaxHighlight;
}

module.exports = {
  ...dom,
  ...color,
  ...paths,
  ...format,
  ...fileIcons,
  /**
   * Apply syntax highlighting to code (loads highlight.js on first call).
   * @param {string} code - Raw code string
   * @param {string} ext - File extension or language name
   * @returns {string} HTML with syntax spans
   */
  highlight: (code, ext) => syntaxHighlight().highlight(code, ext)
};

// Non-enumerable so `{ ...require('./utils') }` (src/renderer/index.js) does
// not trigger the getter and defeat the lazy load. Destructuring and direct
// property access still work.
Object.defineProperty(module.exports, 'LANG_MAP', {
  enumerable: false,
  configurable: true,
  get() {
    return syntaxHighlight().LANG_MAP;
  }
});
