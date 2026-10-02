/**
 * The remote half of the command channel: a POSIX sh script sent over stdin
 * each time a lane opens, never written to disk on the remote host, versioned
 * with the app so the two sides cannot disagree. See design/remote-ssh.md
 * sections 2.3 and 9 (why this instead of an installed agent).
 *
 * The lane runs `ssh ... -- <dest> /bin/sh -s` and writes
 * `CT_NONCE=<hex>\n` followed by DRIVER. The whole driver is one `{ ... }`
 * group, so the shell has parsed all of it before it prints the ready marker.
 * The client sends nothing else until it has seen that marker, which is what
 * keeps a shell that reads its script in blocks (older dash) from swallowing
 * request bytes into its parser buffer: by then the only bytes it could have
 * buffered are the driver's own.
 *
 * Protocol, one request in flight per lane:
 *
 *   client -> REQ <id>\n<one-line script>\n
 *   client -> PUT <id> <bytes>\n<base64 lines>\n.\n<one-line script>\n
 *             (the script runs with the decoded bytes on stdin)
 *   client -> PATH <id>\n<value>\n   (export PATH for later requests)
 *   client -> BYE\n
 *   driver -> PID <id> <pid>\n        (the request's process group leader)
 *   driver -> RES <id> <exit> <stdoutBytes> <stderrBytes>\n<stdout><stderr>
 *
 * Responses are length-prefixed, so they are binary safe. `set -m` puts each
 * request in its own process group when the shell supports it, which is what
 * lets a cancellation reach the `git` a request started and not only its
 * subshell. The original umask is restored for each request: the driver's own
 * `umask 077` protects its temp directory, not the user's files.
 *
 * Helpers the driver defines for the scripts it runs (requests are subshells
 * of the driver, so they inherit its functions and variables):
 *   ct_timeout <secs> <cmd...>   run a command with a time limit
 *   ct_stat <paths...>           "<size> <mtime seconds>" per path, lstat
 *   ct_statL <paths...>          same, following symlinks
 *   $CT_B64                      the base64 decoder found, or empty
 */

'use strict';

/* eslint-disable no-template-curly-in-string -- these are shell parameter expansions (${TMPDIR:-/tmp}), not template literals */

const { q } = require('../../shared/remote-shell');

const PROTOCOL_VERSION = 1;

const DRIVER = [
  '{',
  'CT_UM=$(umask)',
  'umask 077',
  'CT_D=$(mktemp -d "${TMPDIR:-/tmp}/ct.XXXXXX" 2>/dev/null) || CT_D=',
  'if [ -z "$CT_D" ] || [ ! -d "$CT_D" ]; then',
  '  CT_D="${TMPDIR:-/tmp}/ct.$$"',
  '  mkdir -m 700 "$CT_D" 2>/dev/null || { printf \'\\nCT-FAIL-%s tmpdir\\n\' "$CT_NONCE"; exit 97; }',
  'fi',
  'trap \'rm -rf "$CT_D"\' EXIT',
  "trap 'exit 129' HUP",
  "trap 'exit 130' INT",
  "trap 'exit 143' TERM",
  'CT_B64=',
  "for CT_C in 'base64 -d' 'base64 -D' 'openssl base64 -d'; do",
  '  if [ "$(printf \'eA==\\n\' | $CT_C 2>/dev/null)" = x ]; then CT_B64=$CT_C; break; fi',
  'done',
  // GNU/busybox `stat -c` or BSD `stat -f`, decided once. Probing per call
  // would cost a process, and guessing wrong is worse: GNU reads `-f` as
  // "file system status" and prints something else entirely.
  'if stat -c %s / >/dev/null 2>&1; then CT_STF=gnu; elif stat -f %z / >/dev/null 2>&1; then CT_STF=bsd; else CT_STF=; fi',
  'ct_stat() {',
  '  case $CT_STF in',
  "    gnu) stat -c '%s %Y' -- \"$@\" ;;",
  "    bsd) stat -f '%z %m' -- \"$@\" ;;",
  '    *) return 1 ;;',
  '  esac',
  '}',
  'ct_statL() {',
  '  case $CT_STF in',
  "    gnu) stat -L -c '%s %Y' -- \"$@\" ;;",
  "    bsd) stat -L -f '%z %m' -- \"$@\" ;;",
  '    *) return 1 ;;',
  '  esac',
  '}',
  'ct_timeout() {',
  '  CT_TS=$1; shift',
  '  "$@" &',
  '  CT_TP=$!',
  '  ( sleep "$CT_TS"; kill -TERM "$CT_TP" 2>/dev/null ) >/dev/null 2>&1 </dev/null &',
  '  CT_TW=$!',
  '  wait "$CT_TP"; CT_TR=$?',
  '  kill "$CT_TW" 2>/dev/null',
  '  return "$CT_TR"',
  '}',
  'ct_run() {',
  '  ( umask "$CT_UM"; eval "$CT_S" ) >"$CT_D/o" 2>"$CT_D/e" <"$2" &',
  '  CT_P=$!',
  '  printf \'PID %s %s\\n\' "$1" "$CT_P"',
  '  wait "$CT_P"; CT_X=$?',
  '  printf \'RES %s %s %s %s\\n\' "$1" "$CT_X" "$(( $(wc -c <"$CT_D/o") ))" "$(( $(wc -c <"$CT_D/e") ))"',
  '  cat "$CT_D/o" "$CT_D/e"',
  '  rm -f "$CT_D/o" "$CT_D/e" "$CT_D/p" "$CT_D/p64"',
  '}',
  '{ set -m; } 2>/dev/null',
  `printf '\\nCT-READY-%s %s\\n' "$CT_NONCE" ${PROTOCOL_VERSION}`,
  "while IFS=' ' read -r CT_OP CT_ID CT_N; do",
  '  case $CT_OP in',
  '    REQ)',
  '      IFS= read -r CT_S || break',
  '      ct_run "$CT_ID" /dev/null ;;',
  '    PUT)',
  '      while IFS= read -r CT_L; do',
  '        [ "$CT_L" = . ] && break',
  '        printf \'%s\\n\' "$CT_L"',
  '      done >"$CT_D/p64"',
  '      IFS= read -r CT_S || break',
  '      if [ -z "$CT_B64" ]; then',
  '        CT_S=\'echo "no base64 decoder (base64 or openssl) on this host" >&2; exit 96\'',
  '      elif ! $CT_B64 <"$CT_D/p64" >"$CT_D/p" 2>/dev/null || [ "$(( $(wc -c <"$CT_D/p") ))" != "$CT_N" ]; then',
  '        CT_S=\'echo "upload was corrupted in transit" >&2; exit 95\'',
  '      fi',
  '      [ -f "$CT_D/p" ] || : >"$CT_D/p"',
  '      ct_run "$CT_ID" "$CT_D/p" ;;',
  '    PATH)',
  '      IFS= read -r CT_V || break',
  '      PATH=$CT_V; export PATH',
  '      printf \'RES %s 0 0 0\\n\' "$CT_ID" ;;',
  '    BYE) break ;;',
  '    *) printf \'ERR %s\\n\' "$CT_ID" ;;',
  '  esac',
  'done',
  'exit 0',
  '}',
  '',
].join('\n');

/** The full stdin preamble for a lane: the nonce assignment, then the driver. */
function driverPreamble(nonce) {
  if (!/^[0-9a-f]{16,64}$/.test(String(nonce))) throw new Error('Driver nonce must be lowercase hex');
  return `CT_NONCE=${nonce}\n${DRIVER}`;
}

/** Process-group kill for a request, sent on a sibling lane. Falls back to the pid when there is no group. */
function killScript(pgid) {
  const id = Number(pgid);
  if (!Number.isInteger(id) || id <= 1) throw new Error('Refusing to signal an invalid process group');
  return `kill -TERM -- -${id} 2>/dev/null || kill -TERM ${id} 2>/dev/null; :`;
}

// ── Handshake ────────────────────────────────────────────────────────────────

const ENV_PROBE = 'echo __CT_ENV_BEGIN__; env; echo __CT_ENV_END__';
const TOOLS = ['base64', 'inotifywait', 'tmux', 'realpath', 'git'];

/**
 * One-line script run on lane 0 right after the ready marker. It answers in
 * tab-separated `key\tvalue` lines and, as a side effect inside its own
 * subshell only, switches PATH to the login shell's so `git` and `claude`
 * resolve the way they do in the user's terminal. The lane exports that PATH
 * afterwards with a PATH op.
 *
 * `/bin/sh -s` reads no rc file, so the login PATH is captured from
 * `"$SHELL" -l -c` under a 5 s timeout. csh and tcsh refuse `-l` combined with
 * `-c`, hence the non-login retry.
 *
 * @param {object} [options]
 * @param {string|null} [options.claudePath]  profile override for the claude binary
 */
function handshakeScript({ claudePath = null } = {}) {
  const claudeLookup = claudePath ? `CT_CL=${q(claudePath)}; [ -x "$CT_CL" ] || CT_CL=` : 'CT_CL=$(command -v claude 2>/dev/null)';
  const parts = [
    'printf \'os\\t%s\\n\' "$(uname -s 2>/dev/null)"',
    'printf \'arch\\t%s\\n\' "$(uname -m 2>/dev/null)"',
    'printf \'home\\t%s\\n\' "$HOME"',
    'printf \'shell\\t%s\\n\' "${SHELL:-}"',
    'printf \'user\\t%s\\n\' "$(id -un 2>/dev/null)"',
    'printf \'b64\\t%s\\n\' "$CT_B64"',
    'CT_E=$(mktemp 2>/dev/null) || CT_E="${TMPDIR:-/tmp}/ct-env.$$"',
    `ct_timeout 5 "\${SHELL:-/bin/sh}" -l -c ${q(ENV_PROBE)} >"$CT_E" 2>/dev/null </dev/null`,
    `grep -q __CT_ENV_END__ "$CT_E" 2>/dev/null || ct_timeout 5 "\${SHELL:-/bin/sh}" -c ${q(ENV_PROBE)} >"$CT_E" 2>/dev/null </dev/null`,
    'CT_LP=$(sed -n \'/^__CT_ENV_BEGIN__$/,/^__CT_ENV_END__$/s/^PATH=//p\' "$CT_E" 2>/dev/null | head -n 1)',
    'CT_CC=$(sed -n \'/^__CT_ENV_BEGIN__$/,/^__CT_ENV_END__$/s/^CLAUDE_CONFIG_DIR=//p\' "$CT_E" 2>/dev/null | head -n 1)',
    'rm -f "$CT_E"',
    'if [ -n "$CT_LP" ]; then PATH=$CT_LP; export PATH; printf \'loginPath\\t1\\n\'; fi',
    'printf \'path\\t%s\\n\' "$PATH"',
    'printf \'claudeConfigDir\\t%s\\n\' "$CT_CC"',
    'printf \'git\\t%s\\n\' "$(git --version 2>/dev/null)"',
    claudeLookup,
    'printf \'claude\\t%s\\n\' "$CT_CL"',
    'if [ -n "$CT_CL" ]; then printf \'claudeVersion\\t%s\\n\' "$(ct_timeout 10 "$CT_CL" --version 2>/dev/null </dev/null | head -n 1)"; fi',
    `for CT_T in ${TOOLS.join(' ')}; do command -v "$CT_T" >/dev/null 2>&1 && printf 'has\\t%s\\n' "$CT_T"; done`,
    ':',
  ];
  return parts.join('; ');
}

/** Login shells whose `-c` parses a path and one q()-quoted word the way sh does. */
const SUPPORTED_SHELLS = new Set([
  'sh', 'bash', 'rbash', 'zsh', 'dash', 'ksh', 'ksh93', 'mksh', 'lksh', 'oksh', 'pdksh',
  'ash', 'yash', 'posh', 'busybox', 'fish', 'csh', 'tcsh',
]);

function isSupportedLoginShell(shell) {
  if (!shell) return true; // sshd without SHELL runs the account's shell; /bin/sh semantics apply
  const name = String(shell).split('/').pop().replace(/\.exe$/i, '').replace(/[\d.]+$/, '');
  return SUPPORTED_SHELLS.has(name);
}

/**
 * Parse the handshake output into a capabilities object.
 * @param {string} text
 */
function parseHandshake(text) {
  const caps = {
    protocol: PROTOCOL_VERSION,
    os: '', arch: '', home: '', shell: '', user: '', path: '', loginPath: false,
    claudeConfigDir: '', git: '', claude: '', claudeVersion: '', base64: '',
    tools: [],
  };
  for (const line of String(text).split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const key = line.slice(0, tab);
    const value = line.slice(tab + 1).replace(/\r$/, '');
    switch (key) {
      case 'os': caps.os = value; break;
      case 'arch': caps.arch = value; break;
      case 'home': caps.home = value; break;
      case 'shell': caps.shell = value; break;
      case 'user': caps.user = value; break;
      case 'b64': caps.base64 = value; break;
      case 'loginPath': caps.loginPath = true; break;
      case 'path': caps.path = value; break;
      case 'claudeConfigDir': caps.claudeConfigDir = value; break;
      case 'git': caps.git = value; break;
      case 'claude': caps.claude = value; break;
      case 'claudeVersion': caps.claudeVersion = value; break;
      case 'has': if (value && !caps.tools.includes(value)) caps.tools.push(value); break;
      default: break;
    }
  }
  caps.loginShellSupported = isSupportedLoginShell(caps.shell);
  return caps;
}

module.exports = {
  PROTOCOL_VERSION,
  DRIVER,
  driverPreamble,
  killScript,
  handshakeScript,
  parseHandshake,
  isSupportedLoginShell,
};
