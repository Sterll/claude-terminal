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
 * Run git in a repository with prompts off and the `ext::` transport refused.
 * @param {string} dir      absolute remote path
 * @param {string[]} args   git arguments
 */
function gitScript(dir, args) {
  return cdAnd(dir, `GIT_TERMINAL_PROMPT=0; export GIT_TERMINAL_PROMPT; exec git -c protocol.ext.allow=never ${qArgs(args)}`);
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
  for (const [kind, patterns] of SSH_FAILURE_PATTERNS) {
    if (patterns.some((re) => re.test(text))) return kind;
  }
  if (exitCode === 127 || /command not found|: not found\s*$/im.test(text)) return 'not-installed';
  if (exitCode === 255) return 'network';
  return null;
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
  shC,
  withPath,
  classifySshFailure,
  isTerminalFailure,
  SSH_FAILURE_KINDS,
};
