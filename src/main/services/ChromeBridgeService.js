/**
 * ChromeBridgeService - "Claude in Chrome" integration.
 *
 * Lets a chat session drive a real Chrome tab (click, type, screenshot, read the
 * DOM, inspect console/network) through the official Claude browser extension —
 * the same capability Claude Desktop and the `claude --chrome` CLI flag expose.
 *
 * HOW THE PIECES FIT
 * ------------------
 * There are three processes, and we own none of the protocol between them:
 *
 *   chat session ──stdio MCP──> `claude --claude-in-chrome-mcp`  (we spawn)
 *                                        │
 *                                        │ bridge (account-paired)
 *                                        ▼
 *   Chrome ──native messaging──> `claude --chrome-native-host`   (Chrome spawns)
 *                                        ▲
 *                                        └── located via a manifest JSON we drop
 *                                            into each browser's NativeMessagingHosts dir
 *
 * The Agent SDK binary we already ship (`@anthropic-ai/claude-agent-sdk-<plat>-<arch>`)
 * implements BOTH subcommands, so the whole feature needs no extra download and
 * no reimplementation of the wire protocol: we register an MCP server and make
 * sure Chrome can find the native host. The 22 browser tools then appear in the
 * session as `mcp__claude-in-chrome__*`.
 *
 * SHARED IDENTITY WITH CLAUDE CODE — WHY WE DON'T OVERWRITE
 * --------------------------------------------------------
 * The extension picks the native-host name, so we cannot invent our own: it must
 * be `com.anthropic.claude_code_browser_extension`, the exact name the Claude
 * Code CLI also uses. If the user runs both, we would be fighting over one file.
 * So `ensureNativeHost()` only writes a manifest that is missing or broken, and
 * otherwise adopts whatever is already there. Any 2.x Claude Code binary speaks
 * the same protocol, so adopting is safe and keeps both installs working.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { dataDir, settingsFile } = require('../utils/paths');
const { getSdkCliPath } = require('../utils/sdkCli');

/** Chrome Web Store id of the official "Claude for Chrome" extension. */
const EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

/** Where the user installs the extension from. */
const EXTENSION_URL = 'https://claude.ai/chrome';

/**
 * Native-messaging host name. Fixed by the extension, not by us — see the
 * "shared identity" note above.
 */
const HOST_NAME = 'com.anthropic.claude_code_browser_extension';

/**
 * MCP server name. Fixed by the CLI: the tool ids it advertises are
 * `mcp__claude-in-chrome__*`, and the system prompt refers to them by that name.
 */
const MCP_SERVER_NAME = 'claude-in-chrome';

/**
 * Chromium-family browsers that can host the extension, with the per-platform
 * locations we need. `nativeMessaging` is where the host manifest goes;
 * `data` is the profile root we scan to detect the extension; `registryKey` is
 * how Windows resolves native hosts (it uses the registry, not a well-known dir).
 */
const BROWSERS = {
  chrome: {
    label: 'Google Chrome',
    macos: { nativeMessaging: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'], data: ['Library', 'Application Support', 'Google', 'Chrome'] },
    linux: { nativeMessaging: ['.config', 'google-chrome', 'NativeMessagingHosts'], data: ['.config', 'google-chrome'] },
    win32: { data: ['Google', 'Chrome', 'User Data'], registryKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts' }
  },
  brave: {
    label: 'Brave',
    macos: { nativeMessaging: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'], data: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'] },
    linux: { nativeMessaging: ['.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'], data: ['.config', 'BraveSoftware', 'Brave-Browser'] },
    win32: { data: ['BraveSoftware', 'Brave-Browser', 'User Data'], registryKey: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts' }
  },
  arc: {
    label: 'Arc',
    macos: { nativeMessaging: ['Library', 'Application Support', 'Arc', 'User Data', 'NativeMessagingHosts'], data: ['Library', 'Application Support', 'Arc', 'User Data'] },
    linux: null,
    win32: { data: ['Arc', 'User Data'], registryKey: 'HKCU\\Software\\ArcBrowser\\Arc\\NativeMessagingHosts' }
  },
  edge: {
    label: 'Microsoft Edge',
    macos: { nativeMessaging: ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'], data: ['Library', 'Application Support', 'Microsoft Edge'] },
    linux: { nativeMessaging: ['.config', 'microsoft-edge', 'NativeMessagingHosts'], data: ['.config', 'microsoft-edge'] },
    win32: { data: ['Microsoft', 'Edge', 'User Data'], registryKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts' }
  },
  chromium: {
    label: 'Chromium',
    macos: { nativeMessaging: ['Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'], data: ['Library', 'Application Support', 'Chromium'] },
    linux: { nativeMessaging: ['.config', 'chromium', 'NativeMessagingHosts'], data: ['.config', 'chromium'] },
    win32: { data: ['Chromium', 'User Data'], registryKey: 'HKCU\\Software\\Chromium\\NativeMessagingHosts' }
  },
  vivaldi: {
    label: 'Vivaldi',
    macos: { nativeMessaging: ['Library', 'Application Support', 'Vivaldi', 'NativeMessagingHosts'], data: ['Library', 'Application Support', 'Vivaldi'] },
    linux: { nativeMessaging: ['.config', 'vivaldi', 'NativeMessagingHosts'], data: ['.config', 'vivaldi'] },
    win32: { data: ['Vivaldi', 'User Data'], registryKey: 'HKCU\\Software\\Vivaldi\\NativeMessagingHosts' }
  },
  opera: {
    label: 'Opera',
    macos: { nativeMessaging: ['Library', 'Application Support', 'com.operasoftware.Opera', 'NativeMessagingHosts'], data: ['Library', 'Application Support', 'com.operasoftware.Opera'] },
    linux: { nativeMessaging: ['.config', 'opera', 'NativeMessagingHosts'], data: ['.config', 'opera'] },
    win32: { data: ['Opera Software', 'Opera Stable'], registryKey: 'HKCU\\Software\\Opera Software\\Opera Stable\\NativeMessagingHosts', useRoaming: true }
  }
};

/**
 * Appended to the session's system prompt when the bridge is on.
 *
 * Kept short on purpose: the MCP tool descriptions already document each tool.
 * What the model cannot infer from them is the ordering constraint
 * (`tabs_context_mcp` first) and that this is the user's real, logged-in
 * browser — which is why it must not act on consequential pages uninvited.
 */
const SYSTEM_PROMPT = `## Claude in Chrome

You can drive the user's Chrome browser through the \`${MCP_SERVER_NAME}\` MCP tools \
(navigate, click and type via \`computer\`, read the DOM via \`read_page\`/\`get_page_text\`, \
inspect \`read_console_messages\` and \`read_network_requests\`).

- Call \`tabs_context_mcp\` once before any other browser tool: the other tools need a tab id from it.
- Work in tabs you created with \`tabs_create_mcp\` where you can, and close what you opened.
- This is the user's real browser, signed into their real accounts. Read freely, but ask \
before anything that sends, buys, deletes, or posts.`;

class ChromeBridgeService {
  constructor() {
    /** Cache for extension detection, which walks profile dirs on disk. */
    this._detection = null;
    this._detectionAt = 0;
    /** Resolved once per app run: installing the host is idempotent. */
    this._hostReady = null;
  }

  // ── Capability & configuration ────────────────────────────────────────────

  /** Chromium native messaging exists on these three; nothing else is supported. */
  isSupported() {
    return ['darwin', 'win32', 'linux'].includes(process.platform);
  }

  /**
   * Whether the user turned the bridge on. The renderer owns settings.json, so
   * we read it rather than hold a copy — same pattern as DiscordRpcService.
   *
   * Defaults to OFF: driving a signed-in browser is a large capability, so it
   * is opt-in rather than something a user discovers after the fact.
   */
  isEnabled() {
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      return s.chromeBridgeEnabled === true;
    } catch {
      return false;
    }
  }

  getExtensionId() { return EXTENSION_ID; }
  getExtensionUrl() { return EXTENSION_URL; }
  getMcpServerName() { return MCP_SERVER_NAME; }
  getSystemPrompt() { return SYSTEM_PROMPT; }

  /** Descriptor for the browser-tool MCP server, or null if we can't serve it. */
  getMcpServerConfig() {
    const cli = getSdkCliPath();
    if (!cli) return null;
    return { type: 'stdio', command: cli, args: ['--claude-in-chrome-mcp'] };
  }

  // ── Browser & extension detection ─────────────────────────────────────────

  /** Per-browser native-messaging dirs for this platform (empty on Windows). */
  _nativeMessagingDirs() {
    const home = os.homedir();
    const key = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win32' : 'linux';
    if (key === 'win32') return [];
    const out = [];
    for (const [id, def] of Object.entries(BROWSERS)) {
      const cfg = def[key];
      if (!cfg?.nativeMessaging?.length) continue;
      out.push({ browser: id, label: def.label, dir: path.join(home, ...cfg.nativeMessaging) });
    }
    return out;
  }

  /**
   * Windows resolves native hosts through the registry, so the manifest can live
   * anywhere stable — we keep it beside our own wrapper.
   */
  _windowsManifestDir() {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'Claude Terminal', 'ChromeNativeHost');
  }

  /** Per-browser profile roots, used to look for the installed extension. */
  _profileRoots() {
    const home = os.homedir();
    const key = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'win32' : 'linux';
    const out = [];
    for (const [id, def] of Object.entries(BROWSERS)) {
      const cfg = def[key];
      if (!cfg?.data?.length) continue;
      const base = key === 'win32'
        ? (cfg.useRoaming
          ? (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'))
          : (process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')))
        : home;
      out.push({ browser: id, label: def.label, dir: path.join(base, ...cfg.data) });
    }
    return out;
  }

  /**
   * Look for the extension across every Chromium profile we know about.
   *
   * Result is cached briefly: this walks a handful of directories and the
   * renderer polls it to render status.
   *
   * @param {boolean} [force] Skip the cache (used right after the user installs).
   * @returns {Promise<{installed: boolean, browser: string|null, label: string|null}>}
   */
  async detectExtension(force = false) {
    if (!force && this._detection && Date.now() - this._detectionAt < 30_000) {
      return this._detection;
    }
    let result = { installed: false, browser: null, label: null };
    for (const { browser, label, dir } of this._profileRoots()) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // browser not installed
      }
      const profiles = entries
        .filter(e => e.isDirectory())
        .filter(e => e.name === 'Default' || e.name.startsWith('Profile '))
        .map(e => e.name);
      for (const profile of profiles) {
        try {
          await fsp.access(path.join(dir, profile, 'Extensions', EXTENSION_ID));
          result = { installed: true, browser, label };
          break;
        } catch { /* not in this profile */ }
      }
      if (result.installed) break;
    }
    this._detection = result;
    this._detectionAt = Date.now();
    return result;
  }

  // ── Native host installation ──────────────────────────────────────────────

  /** Our wrapper script, which execs the bundled binary as the native host. */
  _wrapperPath() {
    return path.join(dataDir, 'chrome', process.platform === 'win32' ? 'chrome-native-host.bat' : 'chrome-native-host');
  }

  /**
   * A manifest counts as usable when it points the extension at an executable
   * that still exists. That is the test for "adopt vs. replace": a Claude Code
   * install satisfies it, a stale path left by an uninstall does not.
   */
  async _manifestIsUsable(manifestPath) {
    try {
      const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      if (parsed?.name !== HOST_NAME || !parsed?.path) return false;
      if (!parsed.allowed_origins?.some(o => o.includes(EXTENSION_ID))) return false;
      await fsp.access(parsed.path, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** The manifest the extension reads to find our native host. */
  _manifestBody(wrapper) {
    return JSON.stringify({
      name: HOST_NAME,
      description: 'Claude Terminal Browser Extension Native Host',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`]
    }, null, 2);
  }

  /** Write the wrapper that Chrome will exec, pointing at our bundled binary. */
  async _writeWrapper(cli) {
    const wrapper = this._wrapperPath();
    await fsp.mkdir(path.dirname(wrapper), { recursive: true });
    const body = process.platform === 'win32'
      ? `@echo off\r\n"${cli}" --chrome-native-host %*\r\n`
      : `#!/bin/sh\n# Chrome native host wrapper - generated by Claude Terminal, do not edit.\nexec "${cli}" --chrome-native-host "$@"\n`;
    await fsp.writeFile(wrapper, body, 'utf8');
    if (process.platform !== 'win32') await fsp.chmod(wrapper, 0o755);
    return wrapper;
  }

  /**
   * The manifest a Windows browser is currently pointed at, or '' when it is
   * pointed at nothing.
   *
   * Windows keeps no well-known directory: the registry key IS the
   * registration, so it is the only thing that can answer "does this browser
   * already reach a working host". Reading it is what makes adoption possible
   * here at all — the file check the other platforms use looks in a directory
   * of ours that Claude Code never writes to, so on Windows it could only ever
   * answer no, and we would overwrite their key every time.
   */
  _readWindowsHostPath(key) {
    return new Promise(resolve => {
      execFile('reg', ['query', `${key}\\${HOST_NAME}`, '/ve'], (err, stdout) => {
        if (err) return resolve('');
        // "    (Default)    REG_SZ    C:\path\to\manifest.json"
        const line = String(stdout).split(/\r?\n/).find(l => l.includes('REG_SZ'));
        resolve(line ? line.slice(line.indexOf('REG_SZ') + 6).trim() : '');
      });
    });
  }

  /** Point one Windows browser's registry key at our manifest. */
  _registerWindowsBrowser(key, manifestPath) {
    return new Promise(resolve => {
      execFile('reg', ['add', `${key}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], err => {
        if (err) console.warn(`[ChromeBridge] Registry registration failed: ${err.message}`);
        resolve(!err);
      });
    });
  }

  /** Drop one Windows browser's registry key. An absent key is not an error. */
  _unregisterWindowsBrowser(key) {
    return new Promise(resolve => {
      execFile('reg', ['delete', `${key}\\${HOST_NAME}`, '/f'], () => resolve());
    });
  }

  /**
   * Browsers actually present on this machine — the ones worth wiring up.
   *
   * Gating on the profile root keeps us from creating config directories for
   * browsers the user does not have: a manifest under a Vivaldi directory we
   * invented ourselves is litter that nothing will ever read.
   *
   * @returns {Promise<string[]>} Browser ids.
   */
  async _installedBrowsers() {
    const found = [];
    for (const { browser, dir } of this._profileRoots()) {
      try {
        await fsp.access(dir);
        found.push(browser);
      } catch { /* not installed */ }
    }
    return found;
  }

  /**
   * Make sure Chrome can reach a native host, installing ours only where none
   * is usable. Idempotent, and memoised for the app's lifetime.
   *
   * @param {boolean} [force] Redo the work even if it already ran.
   * @returns {Promise<{ok: boolean, installed: string[], adopted: string[], error?: string}>}
   *   `installed` are browsers we wrote a manifest for, `adopted` are those
   *   that already had a working one.
   */
  async ensureNativeHost(force = false) {
    if (this._hostReady && !force) return this._hostReady;
    this._hostReady = this._ensureNativeHost().catch(err => {
      console.error('[ChromeBridge] Native host install failed:', err.message);
      return { ok: false, installed: [], adopted: [], error: err.message };
    });
    return this._hostReady;
  }

  async _ensureNativeHost() {
    const empty = { ok: false, installed: [], adopted: [] };
    if (!this.isSupported()) return { ...empty, error: 'unsupported-platform' };

    const cli = getSdkCliPath();
    if (!cli) return { ...empty, error: 'sdk-cli-missing' };

    const browsers = await this._installedBrowsers();
    if (browsers.length === 0) return { ...empty, error: 'no-browser-found' };

    let wrapper = null;
    const installed = [];
    const adopted = [];

    // Windows resolves native hosts through the registry rather than a
    // well-known directory, so the decision is made per browser by reading the
    // key — the same per-browser adopt-or-install decision the other platforms
    // make by reading each browser's manifest, just against the store that
    // actually governs here.
    if (process.platform === 'win32') {
      const manifestPath = path.join(this._windowsManifestDir(), `${HOST_NAME}.json`);
      for (const browser of browsers) {
        const key = BROWSERS[browser]?.win32?.registryKey;
        if (!key) continue;
        const current = await this._readWindowsHostPath(key);
        // Already reaching a working host — Claude Code's, or ours from a
        // previous run. Either speaks the same protocol, so leave it be.
        if (current && await this._manifestIsUsable(current)) {
          adopted.push(browser);
          continue;
        }
        try {
          if (!wrapper) {
            wrapper = await this._writeWrapper(cli);
            await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
            await fsp.writeFile(manifestPath, this._manifestBody(wrapper), 'utf8');
          }
          if (await this._registerWindowsBrowser(key, manifestPath)) installed.push(browser);
        } catch (e) {
          console.warn(`[ChromeBridge] Could not install native host for ${browser}: ${e.message}`);
        }
      }
      const okWin = installed.length + adopted.length > 0;
      if (!okWin) return { ...empty, error: 'install-failed' };
      if (installed.length) console.log(`[ChromeBridge] Installed native host for: ${installed.join(', ')}`);
      return { ok: okWin, installed, adopted };
    }

    const targets = this._nativeMessagingDirs().filter(t => browsers.includes(t.browser));

    for (const t of targets) {
      const manifestPath = path.join(t.dir, `${HOST_NAME}.json`);
      // Adopt a working host rather than fight Claude Code over the file. This
      // is decided per browser: a manifest Claude Code left in Chrome says
      // nothing about Brave, which may still need ours.
      if (await this._manifestIsUsable(manifestPath)) {
        adopted.push(t.browser);
        continue;
      }
      try {
        if (!wrapper) wrapper = await this._writeWrapper(cli);
        await fsp.mkdir(t.dir, { recursive: true });
        await fsp.writeFile(path.join(t.dir, `${HOST_NAME}.json`), this._manifestBody(wrapper), 'utf8');
        installed.push(t.browser);
      } catch (e) {
        console.warn(`[ChromeBridge] Could not install manifest for ${t.browser}: ${e.message}`);
      }
    }

    const ok = installed.length + adopted.length > 0;
    if (!ok) return { ...empty, error: 'install-failed' };
    if (installed.length) console.log(`[ChromeBridge] Installed native host for: ${installed.join(', ')}`);
    return { ok, installed, adopted };
  }

  /**
   * Remove only the manifests we wrote. One left by Claude Code is left alone —
   * turning our toggle off must not break their integration.
   *
   * @returns {Promise<{removed: string[], kept: string[]}>}
   */
  async removeNativeHost() {
    const wrapper = this._wrapperPath();
    const removed = [];
    const kept = [];

    // Windows: the registration is the key, so it is the key that has to be
    // checked before anything is deleted. Blanket-deleting every browser's key
    // is how turning our toggle off used to break a Claude Code install that
    // had never involved us — the key it deleted was theirs.
    if (process.platform === 'win32') {
      const ours = path.join(this._windowsManifestDir(), `${HOST_NAME}.json`);
      for (const [browser, def] of Object.entries(BROWSERS)) {
        const key = def.win32?.registryKey;
        if (!key) continue;
        const current = await this._readWindowsHostPath(key);
        if (!current) continue;
        if (path.normalize(current).toLowerCase() !== path.normalize(ours).toLowerCase()) {
          kept.push(browser);
          continue;
        }
        await this._unregisterWindowsBrowser(key);
        removed.push(browser);
      }
      // The manifest only mattered to the keys that named it.
      if (removed.length) await fsp.unlink(ours).catch(() => {});
      this._hostReady = null;
      return { removed, kept };
    }

    const targets = this._nativeMessagingDirs();
    for (const t of targets) {
      const manifestPath = path.join(t.dir, `${HOST_NAME}.json`);
      try {
        const parsed = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
        if (parsed?.path !== wrapper) { kept.push(t.browser); continue; }
        await fsp.unlink(manifestPath);
        removed.push(t.browser);
      } catch { /* absent or unreadable — nothing to undo */ }
    }
    this._hostReady = null;
    return { removed, kept };
  }

  // ── Session wiring ────────────────────────────────────────────────────────

  /**
   * What a chat session needs to gain the browser tools, or null when the
   * bridge is off or unavailable.
   *
   * Installing the native host is fire-and-forget: the MCP server starts fine
   * without it and only needs it once the model actually reaches for the
   * browser, so a slow filesystem must not delay the session's first token.
   *
   * @returns {{mcpServers: Object, systemPrompt: string}|null}
   */
  getSessionConfig() {
    if (!this.isEnabled() || !this.isSupported()) return null;
    // A detection that has already run and found nothing is a reason not to
    // wire this up: every session would spawn an MCP server that cannot reach
    // a browser, while the appended prompt tells the model it can drive one —
    // so it calls the tools and burns turns on failures. A detection that has
    // never run does not block the session; it is kicked off instead, and the
    // next session gets the benefit.
    if (this._detection && !this._detection.installed) return null;
    if (!this._detection) this.detectExtension().catch(() => {});
    const config = this.getMcpServerConfig();
    if (!config) return null;
    this.ensureNativeHost().catch(() => {});
    return {
      mcpServers: { [MCP_SERVER_NAME]: config },
      systemPrompt: SYSTEM_PROMPT
    };
  }

  // ── Status for the UI ─────────────────────────────────────────────────────

  /**
   * Everything the settings panel renders, in one call.
   *
   * @param {boolean} [force] Bypass the extension-detection cache.
   */
  async getStatus(force = false) {
    const supported = this.isSupported();
    const enabled = this.isEnabled();
    const cli = getSdkCliPath();
    const detection = supported ? await this.detectExtension(force) : { installed: false, browser: null, label: null };
    let host = { ok: false, installed: [], adopted: [] };
    if (supported && enabled) host = await this.ensureNativeHost(force);
    return {
      supported,
      enabled,
      platform: process.platform,
      cliAvailable: Boolean(cli),
      extensionId: EXTENSION_ID,
      extensionUrl: EXTENSION_URL,
      extensionInstalled: detection.installed,
      browser: detection.browser,
      browserLabel: detection.label,
      hostInstalled: host.ok,
      hostAdopted: host.adopted.length > 0 && host.installed.length === 0,
      hostBrowsers: [...host.installed, ...host.adopted],
      hostError: host.error || null
    };
  }
}

module.exports = new ChromeBridgeService();
module.exports.EXTENSION_ID = EXTENSION_ID;
module.exports.HOST_NAME = HOST_NAME;
module.exports.MCP_SERVER_NAME = MCP_SERVER_NAME;
