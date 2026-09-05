/**
 * Loader for the Agent SDK's Remote Control bridge.
 *
 * `@anthropic-ai/claude-agent-sdk/bridge` is the transport Claude Code itself
 * uses for Remote Control: it registers a local session as a "worker" against
 * claude.ai's code-session service (CCR), streams SDKMessages out over HTTP and
 * reads user input back over SSE. Attaching to it is what makes a session show
 * up at claude.ai/code and in the mobile app.
 *
 * TWO REASONS THIS NEEDS A LOADER RATHER THAN A PLAIN `require`
 * -------------------------------------------------------------
 * 1. It ships as `bridge.mjs` — ESM only. The main process is CommonJS on
 *    Node 18 (Electron 28), where `require()` of an ES module throws, so the
 *    only way in is a dynamic `import()`. That returns a promise, hence the
 *    async API here and the memoisation: importing is not free and every chat
 *    session start would otherwise pay for it.
 *
 * 2. The path has to be resolved by hand. A bare specifier would be resolved
 *    relative to this file, which at runtime lives inside `app.asar` — but the
 *    SDK is in the asarUnpack set (see electron-builder.config.js), so the file
 *    is physically in `app.asar.unpacked`. Electron's asar shim covers `fs` and
 *    `require`, not the ESM resolver. Building the path from `app.getAppPath()`
 *    the way `sdkCli.js` does is what makes dev and packaged behave alike.
 *
 * WHY EVERY EXPORT IS CHECKED BEFORE USE
 * --------------------------------------
 * The bridge surface is marked `@alpha` in the SDK's own typings, with an
 * unusually blunt warning: "This is a separate versioning universe from the
 * main query() surface: breaking changes here do NOT bump the package major."
 * A routine `npm update` can therefore remove or rename any of these functions
 * without any version signal. Feature-detecting the whole set and degrading to
 * `null` means that shows up as "Remote Control unavailable" in settings rather
 * than as a crash on the first chat message.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app } = require('electron');

/**
 * The functions we actually call. Anything missing invalidates the whole
 * module: a bridge we can create sessions on but not attach to is not a
 * feature, it is a way to leak server-side sessions.
 */
const REQUIRED_EXPORTS = [
  'attachBridgeSession',
  'createCodeSession',
  'fetchRemoteCredentials',
  'isCredentialsFailure',
  'isCredentialsRejection',
  'isCreateSessionFailure',
];

/** Memoised load. `undefined` = not attempted yet, `null` = unavailable. */
let _module;
let _loading = null;
let _unavailableReason = null;

/** Absolute path to the SDK's bridge entry point, or null when it is absent. */
function getBridgePath() {
  const base = app.isPackaged
    ? app.getAppPath().replace('app.asar', 'app.asar.unpacked')
    : app.getAppPath();
  const p = path.join(base, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'bridge.mjs');
  return fs.existsSync(p) ? p : null;
}

/**
 * Load the bridge module, or null when this SDK build cannot serve it.
 *
 * Never throws: callers are on a chat-session start path where a failure has to
 * degrade into "no mirroring", never into a failed session.
 *
 * @returns {Promise<Object|null>}
 */
async function loadBridge() {
  if (_module !== undefined) return _module;
  if (_loading) return _loading;

  _loading = (async () => {
    const bridgePath = getBridgePath();
    if (!bridgePath) {
      _unavailableReason = 'The Agent SDK in this build ships no bridge module.';
      return null;
    }
    try {
      const mod = await import(pathToFileURL(bridgePath).href);
      const missing = REQUIRED_EXPORTS.filter(name => typeof mod[name] !== 'function');
      if (missing.length) {
        // The alpha surface moved under us. Say which names went, so the next
        // person reading the log knows what to re-map rather than guessing.
        _unavailableReason = `The SDK bridge is missing: ${missing.join(', ')}.`;
        console.warn(`[claudeBridge] ${_unavailableReason}`);
        return null;
      }
      return mod;
    } catch (err) {
      _unavailableReason = `The SDK bridge failed to load: ${err.message}`;
      console.warn(`[claudeBridge] ${_unavailableReason}`);
      return null;
    }
  })().then(mod => {
    _module = mod;
    _loading = null;
    return mod;
  });

  return _loading;
}

/**
 * Why the bridge is unavailable, for the settings panel. Only meaningful after
 * a `loadBridge()` that returned null.
 * @returns {string|null}
 */
function getUnavailableReason() {
  return _unavailableReason;
}

/**
 * The API base the bridge talks to. Overridable through the same environment
 * variable the CLI honours, so a user pointed at a gateway or a staging stack
 * does not get silently sent to production.
 */
function getApiBaseUrl() {
  return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
}

module.exports = {
  loadBridge,
  getBridgePath,
  getUnavailableReason,
  getApiBaseUrl,
};
