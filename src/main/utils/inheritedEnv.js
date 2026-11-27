/**
 * The environment this process was started with, for the shells it opens.
 *
 * The Agent SDK sets `process.env.NoDefaultCurrentDirectoryInExePath = "1"`
 * when its module loads, in this process. That is a sound choice for the SDK's
 * own executable lookups, but every terminal tab spawned afterwards inherited
 * it, and with it set `cmd` no longer runs a program from the current
 * directory: `cd shared && GetCommitHash.bat` fails, which is what node-gyp
 * runs to build node-pty's winpty, so `npm run build` broke in the app's own
 * terminals and nowhere else.
 *
 * This module must be required before anything that can load the SDK (it is
 * the first require in main.js), so the snapshot is the user's value.
 */

/** Variables the SDK changes in this process that a user's shell must not inherit. */
const RESTORED_KEYS = ['NoDefaultCurrentDirectoryInExePath'];

const snapshot = Object.fromEntries(RESTORED_KEYS.map((key) => [key, process.env[key]]));

/**
 * `process.env` with the keys above put back to what they were at startup
 * (absent if they were absent), then `extra` on top.
 * @param {Record<string, string>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
function shellEnv(extra) {
  const env = { ...process.env };
  for (const key of RESTORED_KEYS) {
    if (snapshot[key] === undefined) delete env[key];
    else env[key] = snapshot[key];
  }
  return extra ? Object.assign(env, extra) : env;
}

module.exports = { shellEnv, RESTORED_KEYS };
