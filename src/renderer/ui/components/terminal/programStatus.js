/**
 * OSC 7501, the Program Status Protocol, from the Claude Code running in a tab.
 *
 * The CLI asks the terminal `OSC 7501 ; ?` at startup and, if it gets an
 * answer starting with `?`, announces its state from then on:
 *
 *   OSC 7501 ; state=<s>:app=claude-code[:id=<task>][:kind=<k>][:progress=<n>][:title=..][:msg=..] ST
 *
 * `state` is working, blocked, done, idle, error, or clear (sent on exit).
 * `kind` qualifies a block: permission (an approval, a sandbox or worker
 * request, a goal proposal), question (input needed), auth (signed out after
 * a failure); a block with no kind is a dialog the user opened. Entries with
 * an `id` are background tasks; the main session has none.
 *
 * That is a structured answer to what the screen scraping in claudeSignals.js
 * guesses at, so it becomes a source of the tab's attention flag: below the
 * hooks when they are active (they see the session from inside), above the
 * screen. A remote tab never gets hook events, so there it is the first one.
 *
 * Answering the probe has a cost the CLI decides on its own: it drops the
 * spinner and the sparkle from its tab title (`noPrefix`), and that prefix is
 * what TerminalManager's working / ready machine, tab naming and initial
 * prompt read. So once a session speaks OSC 7501, the title is handed on with
 * the prefix rebuilt from the state, which is the title the CLI would have set
 * itself, and nothing downstream has to know which of the two it came from.
 *
 * On Windows none of this engages, and nothing changes: ConPTY sits between
 * node-pty and the CLI, answers the DA1 that closes the CLI's probe batch
 * itself, and passes no OSC or DCS reply on to it (checked against the CLI
 * 2.1.316, whose debug log then reads "no reply to OSC 7501 ; ?"). The reply
 * is dropped without a trace, the CLI keeps its title prefix, and titles go
 * through untouched. A remote tab opened from Windows is the same, since its
 * ssh runs in ConPTY too. macOS and Linux PTYs pass the reply straight on.
 *
 * Register it where OSC 52 is: PTY tabs the user drives, never the project
 * type consoles. Anything reaching the terminal can send the sequence, and the
 * worst it can do here is move a status dot.
 */

const PROGRAM_STATUS_OSC = 7501;
const PROBE_REPLY = `\x1b]${PROGRAM_STATUS_OSC};?\x1b\\`;
const BUSY_PREFIX = '◐';  // ◐, the CLI's own first busy frame
const IDLE_PREFIX = '✳';  // ✳
const TITLE_PREFIX_RE = /^\s*[⠁-⣿◐◑✳]\s+/;
const MAX_DATA = 4096;

/**
 * @param {string} data  what follows `7501;`
 * @returns {{probe: true} | {state: string, app: string|null, id: string|undefined, kind: string|null} | null}
 */
function parseProgramStatus(data) {
  if (typeof data !== 'string' || !data || data.length > MAX_DATA) return null;
  if (data.startsWith('?')) return { probe: true };
  const fields = {};
  for (const part of data.split(':')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  if (!fields.state) return null;
  return { state: fields.state, app: fields.app || null, id: fields.id, kind: fields.kind || null };
}

/**
 * The attention flag a main-session status means.
 * @returns {'input'|'error'|null}
 */
function attentionOf(status) {
  if (!status) return null;
  if (status.state === 'error') return 'error';
  if (status.state !== 'blocked') return null;
  if (status.kind === 'permission' || status.kind === 'question') return 'input';
  if (status.kind === 'auth') return 'error';
  return null; // a dialog the user opened in that tab
}

/**
 * Which source sets a PTY tab's attention flag: exactly one, so two of them
 * never overwrite each other.
 * @returns {'hooks'|'osc'|'screen'}
 */
function attentionSource({ hooksActive, remote, programStatus }) {
  if (hooksActive && !remote) return 'hooks';
  return programStatus ? 'osc' : 'screen';
}

/**
 * Take over a terminal's title changes and OSC 7501. `onTitle` gets the title
 * as TerminalManager has always read it, deduplicated; `onStatus` gets each
 * main-session status, and `null` once the CLI clears it on exit.
 *
 * @param {import('@xterm/xterm').Terminal} terminal
 * @param {{ onTitle: (title: string) => void, onStatus?: (status: object|null) => void, reply?: (data: string) => void }} handlers
 * @returns {{ dispose(): void, isActive(): boolean }}
 */
function attachProgramStatus(terminal, { onTitle, onStatus = () => {}, reply = (data) => terminal.input(data, false) }) {
  let rawTitle = '';
  let status = null;
  let lastTitle = '';

  const emit = () => {
    const title = status
      ? `${status.state === 'working' ? BUSY_PREFIX : IDLE_PREFIX} ${rawTitle.replace(TITLE_PREFIX_RE, '').trim() || 'Claude Code'}`
      : rawTitle;
    if (title === lastTitle) return;
    lastTitle = title;
    onTitle(title);
  };

  const titleSub = terminal.onTitleChange((title) => {
    rawTitle = title;
    emit();
  });

  const oscSub = terminal.parser.registerOscHandler(PROGRAM_STATUS_OSC, (data) => {
    const message = parseProgramStatus(data);
    if (!message) return true;
    if (message.probe) {
      reply(PROBE_REPLY);
      return true;
    }
    // Background tasks carry an id. The clear the CLI writes on exit carries
    // nothing but the state, so it is the one message taken without an app.
    if (message.id !== undefined) return true;
    if (message.state === 'clear') {
      if (!status) return true;
      status = null;
    } else if (message.app === 'claude-code') {
      status = message;
    } else {
      return true;
    }
    onStatus(status);
    emit();
    return true;
  });

  return {
    dispose() { titleSub?.dispose?.(); oscSub?.dispose?.(); },
    isActive: () => status !== null,
  };
}

module.exports = {
  PROGRAM_STATUS_OSC,
  PROBE_REPLY,
  parseProgramStatus,
  attentionOf,
  attentionSource,
  attachProgramStatus,
};
