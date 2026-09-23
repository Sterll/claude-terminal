/**
 * Resolution of the Claude Code binary shipped with the Agent SDK.
 *
 * As of @anthropic-ai/claude-agent-sdk 0.3 the SDK no longer ships a `cli.js`;
 * it spawns a platform-specific native binary shipped in the optional dependency
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` (e.g. `claude.exe` on
 * Windows). That package is pulled into the asarUnpack closure automatically
 * (resolve-unpack-deps walks optionalDependencies — see electron-builder.config.js).
 *
 * We resolve it explicitly so the spawn behaves identically in dev and in the
 * packaged app.asar.unpacked layout.
 *
 * This lives in a util rather than in ChatService because two callers need the
 * very same binary: ChatService (to run the session) and ChromeBridgeService
 * (to run `--claude-in-chrome-mcp` and `--chrome-native-host`). Both must agree
 * on the path, and ChromeBridgeService must not import ChatService — ChatService
 * imports it.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * Absolute path to the SDK's Claude Code binary.
 *
 * @returns {string|null} The path, or null when the expected binary is missing
 *   (e.g. a musl Linux build). Callers passing this to the SDK as
 *   `pathToClaudeCodeExecutable` should forward the null so the SDK
 *   self-resolves via require.resolve, which handles the glibc/musl split.
 */
function getSdkCliPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const binRelative = path.join('node_modules', '@anthropic-ai', pkg, `claude${ext}`);
  const base = app.isPackaged
    ? app.getAppPath().replace('app.asar', 'app.asar.unpacked')
    : app.getAppPath();
  const binPath = path.join(base, binRelative);
  return fs.existsSync(binPath) ? binPath : null;
}

/**
 * Version of that binary, read from the platform package that ships it.
 *
 * The CLI's model list is compiled into the binary, so this is what a cached
 * model catalog has to be keyed on: an app update that swaps the binary makes
 * every catalog the previous one wrote describe a CLI that is no longer here.
 * The package.json sits next to the binary, in app.asar.unpacked too.
 *
 * @returns {string|null} null when the binary or its manifest cannot be read
 */
function getSdkCliVersion() {
  const binPath = getSdkCliPath();
  if (!binPath) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(binPath), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

module.exports = { getSdkCliPath, getSdkCliVersion };
