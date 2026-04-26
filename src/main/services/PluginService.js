/**
 * Plugin Service
 * Reads Claude Code plugin data from ~/.claude/plugins/
 * Provides catalog, installed plugins, marketplaces, and install counts
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');

/**
 * Strip all ANSI escape sequences from a string
 */
function stripAnsi(str) {
  return str
    .replace(/\x1B\[\??[0-9;]*[a-zA-Z]/g, '')   // CSI sequences [0m, [?25l, etc.
    .replace(/\x1B\][^\x07]*\x07/g, '')           // OSC sequences (title set, etc.)
    .replace(/\x1B\([A-Z]/g, '')                   // Character set
    .replace(/\x1B[=>]/g, '')                       // Keypad modes
    .replace(/\x1B\[[\d;]*m/g, '')                 // SGR (colors)
    .replace(/\x07/g, '')                           // BEL
    .replace(/\r/g, '');                            // Carriage returns
}
const installedFile = path.join(pluginsDir, 'installed_plugins.json');
const marketplacesFile = path.join(pluginsDir, 'known_marketplaces.json');
const installCountsFile = path.join(pluginsDir, 'install-counts-cache.json');
const marketplacesDir = path.join(pluginsDir, 'marketplaces');
const cacheDir = path.join(pluginsDir, 'cache');

/**
 * Get all installed plugins with enriched metadata
 */
async function getInstalledPlugins() {
  try {
    let rawData;
    try {
      rawData = await fs.promises.readFile(installedFile, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }

    const data = JSON.parse(rawData);
    if (!data.plugins) return [];

    const counts = await getInstallCounts();

    // Collect plugin entries for parallel reads
    const pluginEntries = [];
    for (const [key, entries] of Object.entries(data.plugins)) {
      if (!entries || entries.length === 0) continue;
      const entry = entries[0]; // Take first (active) entry
      const [pluginName, marketplace] = key.split('@');
      pluginEntries.push({ key, pluginName, marketplace, entry });
    }

    // Read all plugin metadata and READMEs in parallel
    const results = await Promise.allSettled(pluginEntries.map(async ({ key, pluginName, marketplace, entry }) => {
      // Try to read plugin.json for richer metadata
      let metadata = { name: pluginName, description: '' };
      try {
        const pluginJsonPath = path.join(entry.installPath, '.claude-plugin', 'plugin.json');
        const raw = await fs.promises.readFile(pluginJsonPath, 'utf8');
        metadata = { ...metadata, ...JSON.parse(raw) };
      } catch { /* ignore */ }

      // Try to read README
      let readme = null;
      try {
        readme = await fs.promises.readFile(path.join(entry.installPath, 'README.md'), 'utf8');
      } catch { /* ignore */ }

      // Count skills, agents, commands
      const contents = countPluginContents(entry.installPath);

      return {
        key,
        pluginName,
        marketplace,
        name: metadata.name || pluginName,
        description: metadata.description || '',
        version: entry.version || metadata.version || '',
        author: metadata.author || null,
        homepage: metadata.homepage || metadata.repository || '',
        license: metadata.license || '',
        keywords: metadata.keywords || [],
        scope: entry.scope || 'user',
        installPath: entry.installPath,
        installedAt: entry.installedAt || '',
        lastUpdated: entry.lastUpdated || '',
        gitCommitSha: entry.gitCommitSha || '',
        installs: counts[key] || 0,
        hasReadme: !!readme,
        contents
      };
    }));

    const installed = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    // Sort by name
    installed.sort((a, b) => a.name.localeCompare(b.name));
    return installed;
  } catch (e) {
    console.error('[PluginService] Error reading installed plugins:', e);
    return [];
  }
}

/**
 * Count skills, agents, commands, hooks in a plugin directory
 */
function countPluginContents(pluginPath) {
  const result = { skills: 0, agents: 0, commands: 0, hooks: false };
  try {
    const skillsDir = path.join(pluginPath, 'skills');
    if (fs.existsSync(skillsDir)) {
      result.skills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory()).length;
    }
    const agentsDir = path.join(pluginPath, 'agents');
    if (fs.existsSync(agentsDir)) {
      result.agents = fs.readdirSync(agentsDir)
        .filter(f => f.endsWith('.md')).length;
    }
    const commandsDir = path.join(pluginPath, 'commands');
    if (fs.existsSync(commandsDir)) {
      result.commands = fs.readdirSync(commandsDir)
        .filter(f => f.endsWith('.md')).length;
    }
    const hooksFile = path.join(pluginPath, 'hooks', 'hooks.json');
    result.hooks = fs.existsSync(hooksFile);
  } catch { /* ignore */ }
  return result;
}

/**
 * Get known marketplaces
 */
function getMarketplaces() {
  try {
    if (!fs.existsSync(marketplacesFile)) return [];

    const data = JSON.parse(fs.readFileSync(marketplacesFile, 'utf8'));
    const marketplaces = [];

    for (const [name, info] of Object.entries(data)) {
      let repoUrl = '';
      if (info.source) {
        if (info.source.source === 'github') {
          repoUrl = `https://github.com/${info.source.repo}`;
        } else if (info.source.url) {
          repoUrl = info.source.url;
        }
      }

      // Count plugins in this marketplace
      let pluginCount = 0;
      try {
        const catalogPath = path.join(info.installLocation, '.claude-plugin', 'marketplace.json');
        if (fs.existsSync(catalogPath)) {
          const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
          pluginCount = (catalog.plugins || []).length;
        }
      } catch { /* ignore */ }

      marketplaces.push({
        name,
        repoUrl,
        source: info.source,
        installLocation: info.installLocation,
        lastUpdated: info.lastUpdated || '',
        pluginCount
      });
    }

    return marketplaces;
  } catch (e) {
    console.error('[PluginService] Error reading marketplaces:', e);
    return [];
  }
}

/**
 * Get install counts map
 */
async function getInstallCounts() {
  try {
    const raw = await fs.promises.readFile(installCountsFile, 'utf8');
    const data = JSON.parse(raw);
    const map = {};
    for (const entry of (data.counts || [])) {
      map[entry.plugin] = entry.unique_installs || 0;
    }
    return map;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('[PluginService] Error reading install counts:', e);
    }
    return {};
  }
}

/**
 * Get full marketplace catalog (all available plugins from all marketplaces)
 */
function getCatalog() {
  try {
    const marketplaces = getMarketplaces();
    const counts = getInstallCounts();
    const installed = getInstalledPluginKeys();
    const allPlugins = [];

    for (const mp of marketplaces) {
      try {
        const catalogPath = path.join(mp.installLocation, '.claude-plugin', 'marketplace.json');
        if (!fs.existsSync(catalogPath)) continue;

        const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        for (const plugin of (catalog.plugins || [])) {
          const key = `${plugin.name}@${mp.name}`;
          allPlugins.push({
            key,
            name: plugin.name,
            description: plugin.description || '',
            version: plugin.version || '',
            author: plugin.author || null,
            category: plugin.category || 'other',
            homepage: plugin.homepage || '',
            tags: plugin.tags || [],
            marketplace: mp.name,
            installs: counts[key] || 0,
            installed: installed.has(key),
            hasLsp: !!plugin.lspServers
          });
        }
      } catch { /* ignore */ }
    }

    // Sort by installs descending
    allPlugins.sort((a, b) => b.installs - a.installs);
    return allPlugins;
  } catch (e) {
    console.error('[PluginService] Error reading catalog:', e);
    return [];
  }
}

/**
 * Get set of installed plugin keys
 */
function getInstalledPluginKeys() {
  try {
    if (!fs.existsSync(installedFile)) return new Set();
    const data = JSON.parse(fs.readFileSync(installedFile, 'utf8'));
    return new Set(Object.keys(data.plugins || {}));
  } catch {
    return new Set();
  }
}

/**
 * Get plugin README from marketplace source
 */
async function getPluginReadme(marketplaceName, pluginName) {
  try {
    const mpDir = path.join(marketplacesDir, marketplaceName);

    // Check multiple locations
    const candidates = [
      path.join(mpDir, 'plugins', pluginName, 'README.md'),
      path.join(mpDir, 'external_plugins', pluginName, 'README.md'),
      path.join(mpDir, 'README.md')
    ];

    for (const candidate of candidates) {
      try {
        return await fs.promises.readFile(candidate, 'utf8');
      } catch { /* try next */ }
    }

    // Also check if plugin is installed in cache and has README
    const installed = await getInstalledPlugins();
    const plugin = installed.find(p => p.pluginName === pluginName && p.marketplace === marketplaceName);
    if (plugin) {
      try {
        return await fs.promises.readFile(path.join(plugin.installPath, 'README.md'), 'utf8');
      } catch { /* ignore */ }
    }

    return null;
  } catch (e) {
    console.error('[PluginService] Error reading README:', e);
    return null;
  }
}

/**
 * Install a plugin natively: read marketplace catalog → copy files → register in installed_plugins.json
 */
async function installPlugin(marketplace, pluginName) {
  console.debug(`[PluginService] installPlugin: ${pluginName}@${marketplace}`);

  try {
    // Find marketplace entry
    let marketplacesData = {};
    if (fs.existsSync(marketplacesFile)) {
      try { marketplacesData = JSON.parse(fs.readFileSync(marketplacesFile, 'utf8')); } catch { /* ignore */ }
    }

    const mpInfo = marketplacesData[marketplace];
    if (!mpInfo) {
      return { success: false, error: `Marketplace '${marketplace}' not found. Add it first.` };
    }

    const mpLocation = mpInfo.installLocation;

    // Read marketplace catalog
    const catalogPath = path.join(mpLocation, '.claude-plugin', 'marketplace.json');
    if (!fs.existsSync(catalogPath)) {
      return { success: false, error: `Catalog not found at ${catalogPath}` };
    }

    let catalog;
    try { catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); } catch (e) {
      return { success: false, error: `Failed to parse catalog: ${e.message}` };
    }

    const pluginEntry = (catalog.plugins || []).find(p => p.name === pluginName);
    if (!pluginEntry) {
      return { success: false, error: `Plugin '${pluginName}' not found in marketplace` };
    }

    // Resolve source path (relative to marketplace root)
    const sourcePath = pluginEntry.source
      ? path.resolve(mpLocation, pluginEntry.source)
      : path.join(mpLocation, 'plugins', pluginName);

    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: `Plugin source not found at ${sourcePath}` };
    }

    // Prepare install dir in cache
    const key = `${pluginName}@${marketplace}`;
    const installPath = path.join(cacheDir, key);

    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Copy plugin files (fresh copy)
    if (fs.existsSync(installPath)) {
      fs.rmSync(installPath, { recursive: true, force: true });
    }
    fs.cpSync(sourcePath, installPath, { recursive: true });

    // Update installed_plugins.json atomically
    let installed = { plugins: {} };
    if (fs.existsSync(installedFile)) {
      try { installed = JSON.parse(fs.readFileSync(installedFile, 'utf8')); } catch { /* ignore */ }
    }
    if (!installed.plugins) installed.plugins = {};

    const now = new Date().toISOString();
    const existingEntry = installed.plugins[key]?.[0];
    installed.plugins[key] = [{
      installPath,
      version: pluginEntry.version || '',
      scope: 'user',
      installedAt: existingEntry?.installedAt || now,
      lastUpdated: now,
      gitCommitSha: '',
      marketplace
    }];

    const tmp = installedFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(installed, null, 2), 'utf8');
    fs.renameSync(tmp, installedFile);

    return { success: true };
  } catch (e) {
    console.error('[PluginService] installPlugin error:', e);
    return { success: false, error: e.message };
  }
}


/**
 * Run a /plugin command via Claude CLI PTY (REPL mode)
 * Mirrors the UsageService pattern exactly
 * @param {string} command - The slash command (e.g. "/plugin install marketplace:plugin")
 * @param {string[]} successPatterns - Strings that indicate success
 * @param {string[]} errorPatterns - Strings that indicate failure
 * @param {number} timeoutMs - Timeout in ms
 * @returns {Promise<{success: boolean, error?: string}>}
 */
function runPluginCommand(command, successPatterns, errorPatterns, timeoutMs = 60000) {
  const pty = require('node-pty');

  return new Promise((resolve) => {
    let output = '';
    let commandSentPos = 0; // Position in output when command was sent
    let phase = 'waiting_cmd';
    let resolved = false;
    let promptConfirmed = false; // Track if we already auto-confirmed a prompt

    console.debug(`[PluginService] === Starting command: ${command} ===`);

    let proc;
    try {
      const { getShell } = require('../utils/shell');
      const shell = getShell();
      proc = pty.spawn(shell.path, shell.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: { ...process.env, TERM: 'xterm-256color' }
      });
    } catch (spawnError) {
      console.error('[PluginService] Failed to spawn shell:', spawnError.message);
      return resolve({ success: false, error: `PTY spawn failed: ${spawnError.message}` });
    }

    if (!proc) {
      return resolve({ success: false, error: 'PTY spawn returned null' });
    }

    let pollInterval = null;

    const timeout = setTimeout(() => {
      if (!resolved) {
        const afterCmd = stripAnsi(output.substring(commandSentPos));
        console.debug('[PluginService] TIMEOUT - phase:', phase);
        console.debug('[PluginService] Output after command:', afterCmd.substring(afterCmd.length - 500));
        finish(false, 'Timeout');
      }
    }, timeoutMs);

    function finish(success, error) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (pollInterval) clearInterval(pollInterval);
      console.debug(`[PluginService] === Finished: success=${success}, error=${error || 'none'} ===`);
      try { proc.kill(); } catch {}
      resolve({ success, error });
    }

    // Normalize text for matching: strip ANSI, lowercase, remove all whitespace
    function normalize(str) {
      return stripAnsi(str).toLowerCase().replace(/\s+/g, '');
    }

    // Poll output every second to check for prompts and result patterns
    function startPolling() {
      let outputLenAtConfirm = 0;

      pollInterval = setInterval(() => {
        if (phase !== 'waiting_result' || resolved) return;

        const afterCmd = normalize(output.substring(commandSentPos));
        console.debug(`[PluginService] Poll: ${afterCmd.length} chars, confirmed=${promptConfirmed}`);

        // Auto-confirm prompts (scope selection, y/n confirmations)
        if (!promptConfirmed && (afterCmd.includes('entertoselect') || afterCmd.includes('(y/n)'))) {
          promptConfirmed = true;
          outputLenAtConfirm = afterCmd.length;
          console.debug('[PluginService] Auto-confirming prompt (Enter)...');
          proc.write('\r');
          return;
        }

        // Check error patterns first (compare without spaces)
        for (const pattern of errorPatterns) {
          if (afterCmd.includes(pattern.toLowerCase().replace(/\s+/g, ''))) {
            phase = 'done';
            console.debug(`[PluginService] ERROR: "${pattern}"`);
            setTimeout(finish, 2000, false, `Command failed: ${pattern}`);
            return;
          }
        }

        // Check success patterns (compare without spaces)
        for (const pattern of successPatterns) {
          if (afterCmd.includes(pattern.toLowerCase().replace(/\s+/g, ''))) {
            phase = 'done';
            console.debug(`[PluginService] SUCCESS: "${pattern}"`);
            setTimeout(finish, 2000, true);
            return;
          }
        }

        // After confirming a prompt, if output grew significantly and no error → success
        // This handles cases where CLI doesn't print an explicit success message
        if (promptConfirmed && afterCmd.length > outputLenAtConfirm + 100) {
          phase = 'done';
          console.debug(`[PluginService] SUCCESS (implicit): output grew ${outputLenAtConfirm} → ${afterCmd.length} after confirm`);
          setTimeout(finish, 2000, true);
          return;
        }
      }, 1000);
    }

    proc.onData((data) => {
      output += data;

      // Phase 1: Wait for shell prompt, then start Claude
      const { matchesShellPrompt } = require('../utils/shell');
      if (phase === 'waiting_cmd' && matchesShellPrompt(output)) {
        phase = 'waiting_claude';
        console.debug('[PluginService] Phase: Shell ready, starting Claude...');
        proc.write('claude --dangerously-skip-permissions\r');
      }

      // Phase 2: Wait for Claude to be ready, then send command
      if (phase === 'waiting_claude' && output.includes('Claude Code')) {
        phase = 'sending_command';
        console.debug('[PluginService] Phase: Claude ready, sending command in 1.5s...');
        setTimeout(() => {
          commandSentPos = output.length;
          console.debug(`[PluginService] Phase: Sending "${command}" (pos=${commandSentPos})`);
          proc.write(command);
          setTimeout(() => {
            proc.write('\r');
            phase = 'waiting_result';
            console.debug('[PluginService] Phase: waiting_result — polling started');
            startPolling();
          }, 500);
        }, 1500);
      }
    });

    proc.onExit(() => {
      if (!resolved) {
        console.debug('[PluginService] Process exited, phase:', phase);
        const afterCmd = normalize(output.substring(commandSentPos));
        const success = successPatterns.some(p => afterCmd.includes(p.toLowerCase().replace(/\s+/g, '')));
        finish(success, success ? undefined : 'Process exited');
      }
    });
  });
}

/**
 * Add a marketplace by cloning the git repo natively (no Claude CLI REPL needed).
 * Supports:
 *   - GitHub shorthand: "owner/repo"
 *   - Full GitHub URL: "https://github.com/owner/repo"
 *   - Any git URL: "https://gitlab.com/org/repo.git"
 *   - Branch: "https://github.com/owner/repo#branch"
 */
async function addMarketplace(url) {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  console.debug(`[PluginService] addMarketplace: ${url}`);

  try {
    let cloneUrl = url;
    let name = null;
    let source = null;
    let branch = null;

    // Extract branch suffix (#branch)
    const branchIdx = url.indexOf('#');
    if (branchIdx !== -1) {
      branch = url.substring(branchIdx + 1);
      url = url.substring(0, branchIdx);
    }

    // GitHub shorthand: "owner/repo" (no slashes except one, no protocol)
    const shorthandMatch = url.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
    const githubMatch = url.match(/github\.com[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/i);

    if (shorthandMatch) {
      const [, owner, repo] = shorthandMatch;
      name = `${owner}-${repo}`;
      source = { source: 'github', repo: `${owner}/${repo}` };
      cloneUrl = `https://github.com/${owner}/${repo}`;
    } else if (githubMatch) {
      const [, owner, repo] = githubMatch;
      name = `${owner}-${repo}`;
      source = { source: 'github', repo: `${owner}/${repo}` };
      cloneUrl = url;
    } else {
      // Generic git URL
      name = url.split('/').pop().replace(/\.git$/, '').replace(/[^a-zA-Z0-9_-]/g, '-') || 'marketplace';
      source = { source: 'url', url };
      cloneUrl = url;
    }

    if (branch) cloneUrl += `#${branch}`;

    // Ensure marketplaces directory exists
    if (!fs.existsSync(marketplacesDir)) {
      fs.mkdirSync(marketplacesDir, { recursive: true });
    }

    const targetDir = path.join(marketplacesDir, name);

    // Already cloned → return success (idempotent)
    if (fs.existsSync(targetDir)) {
      return { success: true };
    }

    // Clone the repo (with optional branch)
    const branchFlag = branch ? `--branch "${branch}" ` : '';
    await execAsync(`git clone ${branchFlag}"${cloneUrl}" "${targetDir}"`, { timeout: 120000 });

    // Update known_marketplaces.json atomically
    let marketplaces = {};
    if (fs.existsSync(marketplacesFile)) {
      try { marketplaces = JSON.parse(fs.readFileSync(marketplacesFile, 'utf8')); } catch { /* ignore */ }
    }

    if (!marketplaces[name]) {
      marketplaces[name] = {
        source,
        installLocation: targetDir,
        lastUpdated: new Date().toISOString()
      };
      const tmp = marketplacesFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(marketplaces, null, 2), 'utf8');
      fs.renameSync(tmp, marketplacesFile);
    }

    return { success: true };
  } catch (e) {
    console.error('[PluginService] addMarketplace error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Uninstall a plugin by its key (pluginName@marketplace)
 * Removes from installed_plugins.json and deletes the cache directory
 */
async function uninstallPlugin(pluginKey) {
  console.debug(`[PluginService] uninstallPlugin: ${pluginKey}`);
  try {
    if (!fs.existsSync(installedFile)) {
      return { success: false, error: 'No installed plugins file found' };
    }

    let installed;
    try {
      installed = JSON.parse(fs.readFileSync(installedFile, 'utf8'));
    } catch (e) {
      return { success: false, error: `Failed to parse installed_plugins.json: ${e.message}` };
    }

    if (!installed.plugins || !installed.plugins[pluginKey]) {
      return { success: false, error: `Plugin '${pluginKey}' is not installed` };
    }

    const entry = installed.plugins[pluginKey][0];
    const installPath = entry?.installPath;

    // Remove from manifest
    delete installed.plugins[pluginKey];

    // Atomic write (temp + rename)
    const tmp = installedFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(installed, null, 2), 'utf8');
    fs.renameSync(tmp, installedFile);

    // Delete cache directory (non-fatal if fails)
    if (installPath) {
      try {
        fs.rmSync(installPath, { recursive: true, force: true });
      } catch (e) {
        console.warn(`[PluginService] Could not delete install dir ${installPath}:`, e.message);
      }
    }

    return { success: true };
  } catch (e) {
    console.error('[PluginService] uninstallPlugin error:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Check for updates on all installed plugins
 * Compares installed version with catalog version
 * @returns {Promise<Object>} Map of pluginKey -> { hasUpdate, installedVersion, catalogVersion }
 */
async function checkPluginUpdates() {
  try {
    const installed = await getInstalledPlugins();
    const catalog = getCatalog();
    const results = {};

    for (const plugin of installed) {
      const catalogEntry = catalog.find(c => c.name === plugin.pluginName && c.marketplace === plugin.marketplace);
      if (catalogEntry && catalogEntry.version && plugin.version) {
        const hasUpdate = catalogEntry.version !== plugin.version;
        results[plugin.key] = { hasUpdate, installedVersion: plugin.version, catalogVersion: catalogEntry.version };
      } else {
        results[plugin.key] = { hasUpdate: false };
      }
    }

    return results;
  } catch (e) {
    console.error('[PluginService] checkPluginUpdates error:', e);
    return {};
  }
}

module.exports = {
  getInstalledPlugins,
  getMarketplaces,
  getInstallCounts,
  getCatalog,
  getPluginReadme,
  installPlugin,
  uninstallPlugin,
  addMarketplace,
  checkPluginUpdates
};
