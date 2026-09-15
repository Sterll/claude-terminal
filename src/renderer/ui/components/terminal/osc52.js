/**
 * OSC 52 clipboard writes from inside the PTY.
 *
 * Apps running in the terminal (Claude Code, tmux, a remote SSH session) push
 * text to the system clipboard this way. xterm.js does not implement it, so
 * without this handler those copies are dropped while the inner app still
 * reports success.
 *
 * Register it only on PTY-backed terminals the user drives themselves. Any
 * byte stream reaching a terminal can trigger the sequence, so it stays off
 * the project-type consoles (fivem/webapp/api/minecraft), which pipe output
 * from a server process with no business writing the clipboard. Reads are
 * refused for the same reason: they would let that output exfiltrate whatever
 * the user last copied.
 */

const { copyText } = require('../../../utils/clipboard');

// OSC 52 lets apps inside the PTY (Claude Code, tmux, remote SSH sessions)
// push text to the system clipboard. xterm.js does not implement it, so
// without this handler those copies are silently dropped while the inner
// app still reports success.
//
// Only register this on PTY-backed terminals the user drives themselves. Any
// byte stream reaching a terminal can trigger it, so it is deliberately NOT
// registered on project-type consoles (fivem/webapp/api/minecraft), which pipe
// output from a server process that has no business writing the clipboard.
// Reads are refused for the same reason: they would let that output exfiltrate
// whatever the user last copied.
const OSC52_MAX_PAYLOAD = 1_000_000;

function registerOsc52Handler(terminal) {
  terminal.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(';');
    if (semi === -1) return true;
    const payload = data.slice(semi + 1);
    if (!payload || payload === '?') return true; // clipboard reads not supported
    // xterm allows up to 10 MB per sequence; cap what we will decode and hand
    // to the OS clipboard so a runaway app cannot push megabytes into it.
    if (payload.length > OSC52_MAX_PAYLOAD) return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      copyText(text);
    } catch (e) {
      console.warn('OSC 52 clipboard decode failed:', e.message);
    }
    return true;
  });
}

module.exports = { registerOsc52Handler, OSC52_MAX_PAYLOAD };
