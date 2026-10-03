/**
 * terminal-commands.js
 * Claude CLI slash commands that only run in its interactive terminal UI.
 *
 * The chat drives the CLI headless, through the Agent SDK, and the CLI answers
 * every `local-jsx` command there with "/x isn't available in this
 * environment". Most of those act on the conversation (`/model`, `/rename`,
 * `/plan`...) and the chat has its own controls for them. The ones listed here
 * act on the machine or the account instead, so running them in a separate
 * terminal does exactly what the user asked: `/design-login`, which
 * `/design consent` sends the user to after a 403, is why this exists.
 *
 * Left out on purpose: anything the CLI also runs headless (`/config`, `/mcp`,
 * `/import`, `/usage-credits`...), since the chat already gets an answer for
 * those, and `/remote-control`, which the chat handles itself.
 *
 * Shared by the renderer, which decides to hand a command off, and the main
 * process, which re-validates it before it reaches a shell: the command line is
 * built from user input and run through `cmd.exe /c` or a POSIX shell.
 */

'use strict';

const TERMINAL_COMMANDS = Object.freeze([
  // Account
  'design-login',
  'login',
  'logout',
  'upgrade',
  'privacy-settings',
  // Setup of things outside the conversation
  'install-github-app',
  'web-setup',
  'remote-env',
  'setup-bedrock',
  'setup-vertex',
  'cloud-plugins',
  // Configuration screens
  'permissions',
  'hooks',
  'plugin',
  'memory',
  'status',
  'mobile',
]);

const COMMAND_SET = new Set(TERMINAL_COMMANDS);

/**
 * An argument the shell cannot read as anything but a word: no spaces,
 * quotes, redirections, separators, variables or globs.
 */
const SAFE_ARG = /^[A-Za-z0-9._:@/=+-]+$/;
const MAX_ARGS = 8;

/**
 * Recognise a terminal-only command in what the user typed.
 *
 * @param {string} text - the composer's content
 * @returns {{ name: string, args: string[], valid: boolean } | null} null when
 *   it is not one of TERMINAL_COMMANDS; `valid: false` when it is, but an
 *   argument could not be passed to a shell safely
 */
function parseTerminalCommand(text) {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!match || !COMMAND_SET.has(match[1])) return null;
  const args = (match[2] || '').split(/\s+/).filter(Boolean);
  const valid = args.length <= MAX_ARGS && args.every(a => SAFE_ARG.test(a));
  return { name: match[1], args, valid };
}

/**
 * The argv to append to `claude`, or null when the command must not run.
 *
 * @param {string} text - `/name arg...`, as parseTerminalCommand accepts it
 * @returns {string[]|null}
 */
function terminalCommandArgv(text) {
  const parsed = parseTerminalCommand(text);
  if (!parsed || !parsed.valid) return null;
  return [`/${parsed.name}`, ...parsed.args];
}

module.exports = {
  TERMINAL_COMMANDS,
  parseTerminalCommand,
  terminalCommandArgv,
};
