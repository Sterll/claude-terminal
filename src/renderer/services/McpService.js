/**
 * MCP Service
 * Handles MCP server management in the renderer
 */

const { BaseService } = require('../core/BaseService');
const { t } = require('../i18n');
const {
  getMcps, getMcp, setMcps, addMcp, updateMcp, removeMcp,
  getMcpProcess, setMcpProcessStatus, addMcpLog, clearMcpLogs,
  setSelectedMcp, initMcpProcess
} = require('../state');
const { claudeConfigFile, legacyMcpsFile } = require('../utils/paths');

class McpService extends BaseService {
  /**
   * Ids of the global servers this panel is responsible for, as of the last
   * load or save. saveMcps() only deletes from ~/.claude.json what is in here,
   * so a server added to the file by someone else is never our deletion.
   * @type {Set<string>}
   */
  _knownIds = new Set();

  async loadMcps() {
    let mcps = [];
    const fsp = this.api.fs.promises;
    try {
      let configExists = false;
      try { await fsp.access(claudeConfigFile); configExists = true; } catch {}
      if (configExists) {
        const config = JSON.parse(await fsp.readFile(claudeConfigFile, 'utf8'));

        if (config.mcpServers) {
          mcps = Object.entries(config.mcpServers).map(([id, sc]) => {
            const mcp = { id, name: id, type: sc.type || 'stdio', enabled: true, scope: 'global' };
            if (sc.type === 'http') { mcp.url = sc.url; }
            else { mcp.command = sc.command; mcp.args = sc.args || []; mcp.env = sc.env || {}; }
            return mcp;
          });
        }

        if (config.projects) {
          Object.entries(config.projects).forEach(([projectPath, pc]) => {
            if (pc.mcpServers && Object.keys(pc.mcpServers).length > 0) {
              Object.entries(pc.mcpServers).forEach(([id, sc]) => {
                if (!mcps.find(m => m.id === id)) {
                  const mcp = { id, name: id, type: sc.type || 'stdio', enabled: true, scope: 'project', projectPath };
                  if (sc.type === 'http') { mcp.url = sc.url; }
                  else { mcp.command = sc.command; mcp.args = sc.args || []; mcp.env = sc.env || {}; }
                  mcps.push(mcp);
                }
              });
            }
          });
        }
      }

      if (mcps.length === 0) {
        let legacyExists = false;
        try { await fsp.access(legacyMcpsFile); legacyExists = true; } catch {}
        if (legacyExists) {
          const legacyMcps = JSON.parse(await fsp.readFile(legacyMcpsFile, 'utf8'));
          if (Array.isArray(legacyMcps)) {
            mcps = legacyMcps;
            await this.saveMcps(mcps);
            await fsp.unlink(legacyMcpsFile);
          }
        }
      }
    } catch (e) {
      console.error('Error loading MCPs:', e);
    }

    this._knownIds = new Set(mcps.filter(mcp => mcp.scope !== 'project').map(mcp => mcp.id));

    setMcps(mcps);
    mcps.forEach(mcp => initMcpProcess(mcp.id));
    return mcps;
  }

  /**
   * Write the global MCP servers back to ~/.claude.json.
   *
   * `mcps` is the full global set as the panel knows it, so an entry that is
   * gone from the list is a deletion and has to be removed from the file. But
   * the file is not ours: the CLI owns it and writes it continuously, and
   * `config.mcpServers = {}` used to mean any server that appeared between
   * loadMcps() and this save — installed by `claude mcp add`, pulled from the
   * cloud, written by another window — was silently dropped.
   *
   * So the deletions are computed against what is on disk *now* rather than
   * against what was on disk when the panel loaded: remove the ids we manage
   * and no longer have, keep everything else verbatim.
   */
  async saveMcps(mcps) {
    const fsp = this.api.fs.promises;
    try {
      let config = {};
      try {
        config = JSON.parse(await fsp.readFile(claudeConfigFile, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error('~/.claude.json is not a JSON object');
      }

      const globalMcps = mcps.filter(mcp => mcp.scope !== 'project');
      const keptIds = new Set(globalMcps.map(mcp => mcp.id));

      const existing = (config.mcpServers && typeof config.mcpServers === 'object')
        ? config.mcpServers
        : {};
      const next = {};
      for (const [id, serverConfig] of Object.entries(existing)) {
        // Entries the panel showed and the user removed go; the rest stays.
        if (!keptIds.has(id) && this._knownIds.has(id)) continue;
        next[id] = serverConfig;
      }

      globalMcps.forEach(mcp => {
        if (mcp.type === 'http') {
          next[mcp.id] = { type: 'http', url: mcp.url };
        } else {
          next[mcp.id] = { type: 'stdio', command: mcp.command, args: mcp.args || [], env: mcp.env || {} };
        }
      });

      config.mcpServers = next;

      const tmpFile = claudeConfigFile + '.tmp';
      await fsp.writeFile(tmpFile, JSON.stringify(config, null, 2));
      await fsp.rename(tmpFile, claudeConfigFile);

      this._knownIds = keptIds;
    } catch (e) {
      console.error('Error saving MCPs:', e);
    }
  }

  async startMcp(id) {
    const mcp = getMcp(id);
    if (!mcp) return { success: false, error: t('mcp.notFound') };

    setMcpProcessStatus(id, 'starting');
    addMcpLog(id, 'info', t('mcp.starting', { name: mcp.name }));

    try {
      if (mcp.type === 'http') {
        setMcpProcessStatus(id, 'running');
        addMcpLog(id, 'info', t('mcp.httpAvailable', { url: mcp.url }));
        return { success: true };
      }

      const result = await this.api.mcp.start({ id, command: mcp.command, args: mcp.args, env: mcp.env });
      if (result.success) {
        setMcpProcessStatus(id, 'running');
        addMcpLog(id, 'info', t('mcp.started'));
      } else {
        setMcpProcessStatus(id, 'error');
        addMcpLog(id, 'stderr', result.error || t('mcp.startFailed'));
      }
      return result;
    } catch (e) {
      setMcpProcessStatus(id, 'error');
      addMcpLog(id, 'stderr', e.message);
      return { success: false, error: e.message };
    }
  }

  async stopMcp(id) {
    const mcp = getMcp(id);
    addMcpLog(id, 'info', t('mcp.stopping'));

    try {
      if (mcp && mcp.type === 'http') {
        setMcpProcessStatus(id, 'stopped');
        addMcpLog(id, 'info', t('mcp.disconnected'));
        return { success: true };
      }

      const result = await this.api.mcp.stop({ id });
      setMcpProcessStatus(id, 'stopped');
      addMcpLog(id, 'info', t('mcp.stopped'));
      return result;
    } catch (e) {
      addMcpLog(id, 'stderr', e.message);
      return { success: false, error: e.message };
    }
  }

  registerMcpListeners(onOutputCallback, onExitCallback) {
    this.api.mcp.onOutput(({ id, type, data }) => {
      addMcpLog(id, type, data);
      if (onOutputCallback) onOutputCallback(id, type, data);
    });

    this.api.mcp.onExit(({ id, code }) => {
      setMcpProcessStatus(id, 'stopped');
      addMcpLog(id, 'info', t('mcp.exitedWithCode', { code }));
      if (onExitCallback) onExitCallback(id, code);
    });
  }

  async createMcp(config) {
    const mcp = {
      id: config.id || `mcp-${Date.now()}`,
      name: config.name || config.id,
      command: config.command,
      args: config.args || [],
      env: config.env || {},
      enabled: true
    };
    addMcp(mcp);
    initMcpProcess(mcp.id);
    await this.saveMcps(getMcps());
    return mcp;
  }

  async updateMcpConfig(id, updates) {
    updateMcp(id, updates);
    await this.saveMcps(getMcps());
  }

  async deleteMcp(id) {
    const process = getMcpProcess(id);
    if (process.status === 'running') await this.stopMcp(id);
    removeMcp(id);
    await this.saveMcps(getMcps());
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function _getInstance() {
  if (!_instance) {
    const { getApiProvider, getContainer } = require('../core');
    _instance = new McpService(getApiProvider(), getContainer());
  }
  return _instance;
}

module.exports = {
  McpService,
  getInstance: _getInstance,
  loadMcps: (...a) => _getInstance().loadMcps(...a),
  saveMcps: (...a) => _getInstance().saveMcps(...a),
  startMcp: (...a) => _getInstance().startMcp(...a),
  stopMcp: (...a) => _getInstance().stopMcp(...a),
  registerMcpListeners: (...a) => _getInstance().registerMcpListeners(...a),
  createMcp: (...a) => _getInstance().createMcp(...a),
  updateMcpConfig: (...a) => _getInstance().updateMcpConfig(...a),
  deleteMcp: (...a) => _getInstance().deleteMcp(...a),
  // Re-exported state helpers (unchanged)
  getMcps, getMcp, getMcpProcess, clearMcpLogs, setSelectedMcp
};
