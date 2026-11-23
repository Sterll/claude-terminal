/**
 * Back / forward for the jump a clicked terminal path makes into the Files
 * screen.
 *
 * Clicking a path in a terminal takes the reader to another screen. Browsers
 * taught everyone how to undo that: Alt+Left, or the "back" thumb button on the
 * mouse. This keeps a small history of those jumps and answers both gestures,
 * plus Alt+Right and the "forward" button to go to the file again.
 *
 * Deliberately narrow: only the terminal -> file jump is recorded, and a
 * gesture is only consumed when there is a step to take *from the place the
 * reader is now*. Anywhere else Alt+Left / Alt+Right reach the terminal (or
 * whatever has focus) untouched.
 *
 * The listeners are registered in the capture phase because xterm consumes
 * keydown on its own textarea before a bubbling document listener would see it.
 */

const MAX_ENTRIES = 50;

// MouseEvent.button for the side buttons. Chromium reports X11 buttons 8/9
// and the Windows XBUTTON1/2 as these.
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

/**
 * @param {Object} deps
 * @param {() => string} deps.getActiveTab - current sidebar tab id ('claude', 'files', ...)
 * @param {() => any} deps.getActiveTerminalId
 * @param {(terminalId: any) => void} deps.showTerminal
 * @param {(filePath: string, project: Object|null) => void} deps.showFile
 */
function createFileLinkHistory({ getActiveTab, getActiveTerminalId, showTerminal, showFile }) {
  /** @type {{ terminalId: any }[]} */
  let back = [];
  /** @type {{ filePath: string, project: Object|null }[]} */
  let forward = [];
  /** The file the last jump landed on; back only applies while it is on screen. */
  let current = null;

  /**
   * Record a jump from the active terminal to a file.
   * @param {string} filePath
   * @param {Object|null} project
   */
  function recordJump(filePath, project = null) {
    back.push({ terminalId: getActiveTerminalId() });
    if (back.length > MAX_ENTRIES) back.shift();
    forward = [];
    current = { filePath, project };
  }

  function canGoBack() {
    return back.length > 0 && !!current && getActiveTab() === 'files';
  }

  function canGoForward() {
    return forward.length > 0 && getActiveTab() === 'claude';
  }

  /** @returns {boolean} whether a step was taken */
  function goBack() {
    if (!canGoBack()) return false;
    const entry = back.pop();
    forward.push(current);
    current = null;
    showTerminal(entry.terminalId);
    return true;
  }

  /** @returns {boolean} whether a step was taken */
  function goForward() {
    if (!canGoForward()) return false;
    const entry = forward.pop();
    back.push({ terminalId: getActiveTerminalId() });
    current = entry;
    showFile(entry.filePath, entry.project);
    return true;
  }

  function onKeyDown(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    let done = false;
    if (e.key === 'ArrowLeft') done = goBack();
    else if (e.key === 'ArrowRight') done = goForward();
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onMouseUp(e) {
    let done = false;
    if (e.button === MOUSE_BACK) done = goBack();
    else if (e.button === MOUSE_FORWARD) done = goForward();
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /**
   * Start listening on a document.
   * @param {Document} doc
   * @returns {() => void} stop listening
   */
  function attach(doc) {
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('mouseup', onMouseUp, true);
    return () => {
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('mouseup', onMouseUp, true);
    };
  }

  return { recordJump, goBack, goForward, canGoBack, canGoForward, attach };
}

module.exports = { createFileLinkHistory, MOUSE_BACK, MOUSE_FORWARD };
