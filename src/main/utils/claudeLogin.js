/**
 * Claude sign-in, driven from the app.
 *
 * `claude auth login` already does all of it: it opens the browser, waits for
 * the redirect on localhost, and when that redirect never comes (another
 * browser, another profile, a blocked port) it prints the manual URL and reads
 * the `code#state` that page shows, one line at a time from stdin. So nothing
 * here speaks OAuth. It runs the command over plain pipes, hands the URL to the
 * caller and writes the code back.
 *
 * What it relies on in the CLI's output (2.1.260):
 *
 *   If the browser didn't open, visit: <url, wrapped in an OSC 8 hyperlink>
 *   Paste code here if prompted >
 *   Login successful.                                  stdout, exit 0
 *   Invalid code. Please make sure the full code ...   stderr, still waiting
 *   Login failed: <reason>                             stderr, exit 1
 *
 * Where the credentials land is the environment's business, not this
 * module's: see loginEnv().
 */

const { spawn } = require('child_process');

// Long enough to sign in through SSO or fetch a code from another machine;
// short enough that a forgotten modal does not leave a CLI listening for days.
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 3000;

// A base URL or a key in the app's environment would change what the CLI does
// with the token it is about to receive: ANTHROPIC_BASE_URL wins over the
// credential store, so the fresh OAuth token would be sent to that host.
const SCRUBBED_ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

// OSC (hyperlinks, titles) and CSI (colours, cursor) sequences.
const TERMINAL_CODES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripTerminalCodes(text) {
  return String(text).replace(TERMINAL_CODES, '');
}

/**
 * The sign-in URL in what the CLI has printed so far, or null.
 *
 * Only complete lines count: output arrives in chunks, and a URL cut at a chunk
 * boundary would open a page that answers with an OAuth error.
 * @param {string} output - raw stdout, terminal codes included
 * @returns {string|null}
 */
function findLoginUrl(output) {
  const lines = stripTerminalCodes(output).split(/\r?\n/);
  lines.pop();
  for (const line of lines) {
    const match = line.match(/https:\/\/\S+/);
    if (match) return match[0];
  }
  return null;
}

/**
 * The environment a sign-in runs under.
 *
 * CLAUDE_SECURESTORAGE_CONFIG_DIR picks the credential store the CLI writes,
 * Keychain entry included, so the login lands where the account will be read
 * from later. CLAUDE_CONFIG_DIR is where it records who signed in
 * (`oauthAccount` in `.claude.json`): pointed anywhere but a scratch directory,
 * that would relabel the account of whatever config it lands in.
 *
 * @param {Object} base - usually process.env
 * @param {{ storeDir: string, configDir: string }} dirs
 */
function loginEnv(base, { storeDir, configDir }) {
  const env = { ...base };
  for (const key of SCRUBBED_ENV) delete env[key];
  env.CLAUDE_CONFIG_DIR = configDir;
  env.CLAUDE_SECURESTORAGE_CONFIG_DIR = storeDir;
  return env;
}

function loginError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Why the CLI said no, from its stderr.
 * @param {string} stderr
 * @param {number|null} exitCode
 */
function failureMessage(stderr, exitCode) {
  const lines = stripTerminalCodes(stderr).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const failed = lines.filter(l => /^Login failed:/i.test(l)).pop();
  if (failed) return failed;
  if (lines.length) return lines[lines.length - 1];
  return `Sign-in exited with code ${exitCode}.`;
}

/**
 * Run `<command> [...commandArgs] auth login --claudeai`.
 *
 * @param {Object} opts
 * @param {string} opts.command - the Claude Code binary
 * @param {string[]} [opts.commandArgs] - inserted before `auth login`
 * @param {Object} opts.env - see loginEnv()
 * @param {(url: string) => void} [opts.onUrl] - once, when the URL is printed
 * @param {() => void} [opts.onInvalidCode] - the CLI refused a pasted code and
 *   is waiting for another one
 * @param {number} [opts.timeoutMs]
 * @returns {{ result: Promise<void>, submitCode: (code: string) => boolean, cancel: () => void }}
 *   `result` rejects with `code` set to LOGIN_FAILED, LOGIN_CANCELLED,
 *   LOGIN_TIMEOUT or LOGIN_SPAWN_FAILED.
 */
function runLogin({ command, commandArgs = [], env, onUrl, onInvalidCode, timeoutMs = LOGIN_TIMEOUT_MS }) {
  let stdout = '';
  let stderr = '';
  let urlSent = false;
  let refusals = 0;
  let stopReason = null;
  let settled = false;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const child = spawn(command, [...commandArgs, 'auth', 'login', '--claudeai'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  let killTimer = null;

  function settle(err) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    if (err) rejectResult(err);
    else resolveResult();
  }

  function stop(reason) {
    if (settled || stopReason) return;
    stopReason = reason;
    child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    if (killTimer.unref) killTimer.unref();
  }

  // Writing a code just as the CLI exits raises EPIPE on the pipe; the exit
  // is what reports the outcome.
  child.stdin.on('error', () => {});

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (urlSent) return;
    const url = findLoginUrl(stdout);
    if (!url) return;
    urlSent = true;
    onUrl?.(url);
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    const seen = (stripTerminalCodes(stderr).match(/Invalid code/gi) || []).length;
    if (seen > refusals) {
      refusals = seen;
      onInvalidCode?.();
    }
  });

  child.on('error', (err) => {
    settle(loginError(`Could not start Claude Code to sign in: ${err.message}`, 'LOGIN_SPAWN_FAILED'));
  });

  child.on('close', (exitCode) => {
    if (stopReason === 'cancelled') return settle(loginError('Sign-in cancelled.', 'LOGIN_CANCELLED'));
    if (stopReason === 'timeout') return settle(loginError('Sign-in timed out.', 'LOGIN_TIMEOUT'));
    if (exitCode === 0) return settle(null);
    settle(loginError(failureMessage(stderr, exitCode), 'LOGIN_FAILED'));
  });

  return {
    result,
    submitCode(code) {
      const line = String(code ?? '').trim();
      if (settled || stopReason || !line) return false;
      child.stdin.write(`${line}\n`);
      return true;
    },
    cancel() {
      stop('cancelled');
    },
  };
}

module.exports = {
  runLogin,
  loginEnv,
  findLoginUrl,
  stripTerminalCodes,
  LOGIN_TIMEOUT_MS,
};
