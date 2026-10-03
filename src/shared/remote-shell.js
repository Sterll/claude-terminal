/**
 * Remote shell command construction and ssh failure classification.
 *
 * Every command the app runs on a remote host is built here, from argv-like
 * pieces, and never by concatenating a user value into a string. See
 * design/remote-ssh.md section 7.2.
 *
 * `q()` is the only quoting function. It produces a form that POSIX sh, bash,
 * zsh, dash, ksh, fish and csh/tcsh all parse to the same word:
 *   - the value is wrapped in single quotes;
 *   - every `'` is written as `'\''` and every `\` as `'\\'`, that is, both
 *     outside the quotes. fish treats a backslash inside single quotes as an
 *     escape, so a backslash has to leave them;
 *   - control characters (newline and NUL included) are refused, because csh
 *     cannot hold a newline inside quotes and the channel frames one script
 *     per line.
 *
 * Scripts are always one line, joined with `;` and `&&`. The ssh-side command
 * for PTYs and chat processes is `/bin/sh -c <q(script)>`, so the user's login
 * shell only ever parses a path and one quoted word, and the script itself is
 * always run by `/bin/sh`.
 */

'use strict';

function shellError(message) {
  const error = new Error(message);
  error.code = 'REMOTE_SHELL_INVALID';
  return error;
}

function hasControlChars(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Quote one value as a single shell word.
 * @param {string|number} value
 * @returns {string}
 */
function q(value) {
  if (value === null || value === undefined) throw shellError('Cannot quote an empty value');
  const text = String(value);
  if (hasControlChars(text)) throw shellError('Refusing to quote a value containing a control character');
  let out = "'";
  for (const ch of text) {
    if (ch === "'") out += "'\\''";
    else if (ch === '\\') out += "'\\\\'";
    else out += ch;
  }
  return out + "'";
}

/** Quote every element and join with spaces. */
function qArgs(args) {
  if (!Array.isArray(args)) throw shellError('Arguments must be an array');
  return args.map(q).join(' ');
}

/** Throw unless `script` is a single line. Returns it unchanged. */
function assertOneLine(script) {
  if (typeof script !== 'string' || script.length === 0) throw shellError('Script must be a non-empty string');
  if (/[\r\n]/.test(script)) throw shellError('Remote scripts must be a single line');
  if (script.includes('\0')) throw shellError('Remote scripts cannot contain NUL');
  return script;
}

/** Join script fragments with `; `, asserting the result is one line. */
function script(...parts) {
  return assertOneLine(parts.filter(Boolean).join('; '));
}

/** `cd -- <dir> && <command>` */
function cdAnd(dir, command) {
  return assertOneLine(`cd -- ${q(dir)} && ${command}`);
}

/**
 * Exit status of a remote script whose working directory does not exist, so
 * the caller can tell "no such folder" (`reason: 'nodir'`) from a git failure:
 * `cd` itself exits 1 or 2 depending on the shell, which git also uses.
 */
const NODIR_EXIT = 96;

/** `[ -d <dir> ] || exit 96; ` - the prefix that makes a missing directory recognisable. */
function requireDir(dir) {
  return `[ -d ${q(dir)} ] || exit ${NODIR_EXIT}`;
}

/**
 * Run git in a repository with prompts off and the `ext::` transport refused.
 * A missing directory exits NODIR_EXIT before git runs.
 *
 * `GIT_TERMINAL_PROMPT=0 exec git` exports the assignment into git's
 * environment: POSIX leaves assignments before a special built-in unspecified
 * in general, but bash, dash, busybox ash and ksh all export them for `exec`
 * with a command, which is the only form used here.
 *
 * @param {string} dir      absolute remote path
 * @param {string[]} args   git arguments
 */
function gitScript(dir, args) {
  return assertOneLine(`${requireDir(dir)}; ${cdAnd(dir, `GIT_TERMINAL_PROMPT=0 exec git -c protocol.ext.allow=never ${qArgs(args)}`)}`);
}

/** The one-element remote command handed to ssh for PTYs, chat and one-shot execs. */
function shC(inner) {
  return `/bin/sh -c ${q(assertOneLine(inner))}`;
}

/** Prefix a script with an exported PATH (the login PATH captured at handshake). */
function withPath(pathValue, inner) {
  if (!pathValue) return assertOneLine(inner);
  return script(`PATH=${q(pathValue)}`, 'export PATH', inner);
}

// ── Terminal scripts (design/remote-ssh.md section 5.1) ─────────────────────

/** The user's login shell as /bin/sh sees it once sshd has set SHELL. */
// Split so it is not read as a template placeholder.
const LOGIN_SHELL = '"$' + '{SHELL:-/bin/sh}"';

/** tmux session names the app creates: `ct-` plus a tab key. Checked, so it needs no quoting. */
const TMUX_SESSION_RE = /^ct-[A-Za-z0-9_-]{1,96}$/;

/**
 * The script behind a remote shell tab: enter the directory, then become the
 * user's interactive login shell. With `tmuxSession`, the shell is a tmux
 * session attached or created under that name, so a dropped connection can
 * reattach to the same shell; a host without tmux falls back to the plain
 * login shell rather than failing.
 *
 * A directory that no longer exists fails the `cd` and ends the tab: there is
 * no fallback to the home directory, which would be a shell somewhere the user
 * did not ask for.
 *
 * @param {string} dir  absolute remote path
 * @param {object} [options]
 * @param {string|null} [options.tmuxSession]  `ct-<key>`
 * @param {string|null} [options.path]         login PATH from the handshake, for finding tmux
 * @returns {string} one line, for `shC()`
 */
function terminalShellScript(dir, { tmuxSession = null, path = null } = {}) {
  const shell = `exec ${LOGIN_SHELL} -l`;
  if (!tmuxSession) return cdAnd(dir, shell);
  if (!TMUX_SESSION_RE.test(tmuxSession)) throw shellError('Invalid tmux session name');
  const tmux = `if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s ${tmuxSession}; else ${shell}; fi`;
  return withPath(path, cdAnd(dir, tmux));
}

/**
 * The script behind a remote Claude tab: enter the directory and run the CLI
 * through the user's login shell, so the login PATH finds `claude` (it usually
 * lives in ~/.local/bin, which a bare `/bin/sh -c` does not see). csh and tcsh
 * refuse `-l` together with `-c`, so they get a plain `-c`, which still reads
 * ~/.cshrc where such users set their PATH.
 *
 * @param {string} dir     absolute remote path
 * @param {string[]} argv  the CLI and its arguments, each one quoted with q()
 * @returns {string} one line, for `shC()`
 */
function terminalClaudeScript(dir, argv) {
  if (!Array.isArray(argv) || argv.length === 0) throw shellError('The Claude command line is empty');
  const command = q(qArgs(argv));
  return cdAnd(dir, `case "\${SHELL##*/}" in csh|tcsh) exec "$SHELL" -c ${command};; *) exec ${LOGIN_SHELL} -l -c ${command};; esac`);
}

/** Remove a tab's tmux session (the tab was closed on purpose). Never fails the caller. */
function tmuxKillScript(tmuxSession) {
  if (!TMUX_SESSION_RE.test(tmuxSession)) throw shellError('Invalid tmux session name');
  return `tmux kill-session -t ${tmuxSession} 2>/dev/null; :`;
}

// ── ssh failure classification ──────────────────────────────────────────────

/**
 * Ordered: the first match wins. `hostkey-changed` precedes `hostkey-unknown`
 * because OpenSSH prints "Host key verification failed" in both cases.
 */
const SSH_FAILURE_PATTERNS = [
  ['hostkey-changed', [/REMOTE HOST IDENTIFICATION HAS CHANGED/i, /Host key for .+ has changed/i, /POSSIBLE DNS SPOOFING DETECTED/i]],
  ['hostkey-unknown', [/Host key verification failed/i, /No .*host key is known for/i, /authenticity of host .+ can't be established/i]],
  ['auth', [/Permission denied \(/i, /Permission denied, please try again/i, /Too many authentication failures/i, /No more authentication methods/i, /Authentication failed/i]],
  ['dns', [/Could not resolve hostname/i, /Name or service not known/i, /nodename nor servname provided/i, /No such host is known/i, /Temporary failure in name resolution/i, /No address associated with hostname/i]],
  ['timeout', [/Connection timed out/i, /Operation timed out/i, /timed out during banner exchange/i, /Timeout, server .+ not responding/i]],
  ['refused', [/Connection refused/i]],
  ['network', [/Connection closed by/i, /Connection reset/i, /Broken pipe/i, /Network is unreachable/i, /No route to host/i, /kex_exchange_identification/i, /client_loop: send disconnect/i, /Software caused connection abort/i, /closed by remote host/i, /Host is down/i]],
];

const SSH_FAILURE_KINDS = ['auth', 'hostkey-unknown', 'hostkey-changed', 'dns', 'timeout', 'refused', 'network', 'not-installed'];

/** ssh's own failure status, as a POSIX system reports it. */
const SSH_FAILURE_STATUS = 255;

/**
 * ssh's exit status as a POSIX system reads it.
 *
 * ssh exits with -1 when the server ended the session without sending an exit
 * status: its sshd session was killed, the host went down, sshd was stopped.
 * POSIX truncates that to 255, ssh's own failure code, but Windows keeps the
 * 32-bit value, which node-pty reports as -1 and child_process as 4294967295.
 * Compared with 255 as is, a dropped connection read as an ordinary exit on
 * Windows (seen live: a remote tab closed instead of offering to reconnect).
 * Every comparison with 255 goes through this.
 *
 * @param {number|null|undefined} code
 * @returns {number|null|undefined}
 */
function sshExitStatus(code) {
  return code === -1 || code === 0xffffffff ? SSH_FAILURE_STATUS : code;
}

/**
 * Classify a failed ssh invocation.
 *
 * Exit 255 is ssh's own failure (connection or authentication), any other
 * code is the remote command's. 127 is the remote shell's "command not found".
 *
 * @param {number|null} exitCode
 * @param {string} stderr
 * @returns {string|null} one of SSH_FAILURE_KINDS, or null when nothing ssh-related failed
 */
function classifySshFailure(exitCode, stderr) {
  const text = String(stderr || '');
  const kind = sshTransportFailure(text);
  if (kind) return kind;
  const code = sshExitStatus(exitCode);
  if (code === 127 || /command not found|: not found\s*$/im.test(text)) return 'not-installed';
  if (code === SSH_FAILURE_STATUS) return 'network';
  return null;
}

/**
 * What ssh itself printed about a failed connection, from its diagnostics
 * alone: one of the transport kinds of SSH_FAILURE_PATTERNS, or null. Unlike
 * classifySshFailure, no exit code is consulted, so an exit status the remote
 * command chose is never read as a transport failure.
 *
 * @param {string} text
 * @returns {string|null}
 */
function sshTransportFailure(text) {
  const value = String(text || '');
  for (const [kind, patterns] of SSH_FAILURE_PATTERNS) {
    if (patterns.some((re) => re.test(value))) return kind;
  }
  return null;
}

/** Terminal escape sequences (CSI, OSC, and the two-byte ones), so a line reads as the text it shows. */
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * OpenSSH's last words when an interactive session ends normally: with a PTY
 * and the default LogLevel it prints "Connection to <host> closed." (or
 * "Shared connection to <host> closed." through a ControlMaster) once the
 * remote command has exited, whatever its status. A connection the server
 * dropped prints "Connection to <host> closed by remote host." first, and a
 * broken link or a keepalive timeout dies on a fatal message instead.
 */
const SSH_CLEAN_CLOSE_RE = /(?:^|\s)(?:Shared c|C)onnection to \S+ closed\.$/;

/**
 * Why the ssh of an interactive (PTY) session exited 255, read from the last
 * output of the PTY, which carries ssh's own diagnostics as well as the
 * remote side's.
 *
 * ssh exits 255 when the connection or authentication failed, but it also
 * passes on the remote command's own status, and a remote shell can end with
 * 255 too (`exit 255`, a script that does). That must close the tab like any
 * other exit rather than be taken for a lost connection, or the tab respawns
 * the shell the user just left, again and again.
 *
 * - `exit`: ssh said the session closed normally, so 255 is the remote
 *   command's own status;
 * - `lost` with a kind: ssh printed a transport or authentication failure;
 * - `unknown`: ssh printed neither (`LogLevel QUIET`, or nothing came
 *   through), and the caller has to ask the host.
 *
 * Any other exit code is always `exit`.
 *
 * @param {number|null} exitCode
 * @param {string} tail  the last few KB of the PTY's output
 * @returns {{ verdict: 'exit' } | { verdict: 'lost', kind: string } | { verdict: 'unknown' }}
 */
function classifyPtyExit(exitCode, tail) {
  if (sshExitStatus(exitCode) !== SSH_FAILURE_STATUS) return { verdict: 'exit' };
  const lines = String(tail || '').replace(ANSI_RE, '').split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const before = lines[lines.length - 2] || '';
  if (SSH_CLEAN_CLOSE_RE.test(last) && !/closed by remote host/i.test(before)) return { verdict: 'exit' };
  const kind = sshTransportFailure(lines.join('\n'));
  if (kind) return { verdict: 'lost', kind };
  return { verdict: 'unknown' };
}

/** Kinds after which an automatic retry would be wrong (account lockout, a human must check a key). */
function isTerminalFailure(kind) {
  return kind === 'auth' || kind === 'hostkey-unknown' || kind === 'hostkey-changed';
}

module.exports = {
  q,
  qArgs,
  assertOneLine,
  script,
  cdAnd,
  gitScript,
  requireDir,
  NODIR_EXIT,
  shC,
  withPath,
  terminalShellScript,
  terminalClaudeScript,
  tmuxKillScript,
  TMUX_SESSION_RE,
  classifySshFailure,
  sshExitStatus,
  SSH_FAILURE_STATUS,
  sshTransportFailure,
  classifyPtyExit,
  isTerminalFailure,
  SSH_FAILURE_KINDS,
};
