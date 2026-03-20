/**
 * Agent Service
 * Handles agent loading and management
 */

const { BaseService } = require('../core/BaseService');
const { parseFrontmatter } = require('../utils/frontmatter');
const { skillsAgentsState } = require('../state');
const { t } = require('../i18n');
const { agentsDir } = require('../utils/paths');

class AgentService extends BaseService {
  constructor(api, container) {
    super(api, container);
    this._agentsDir = agentsDir;
  }

  async loadAgents() {
    const agents = [];
    try {
      await this.api.fs.promises.access(this._agentsDir);
      const items = await this.api.fs.promises.readdir(this._agentsDir);

      for (const item of items) {
        const itemPath = this.api.path.join(this._agentsDir, item);
        try {
          const stat = await this.api.fs.promises.stat(itemPath);
          if (stat.isFile() && item.endsWith('.md')) {
            const content = await this.api.fs.promises.readFile(itemPath, 'utf8');
            const { metadata } = parseFrontmatter(content);
            const id = item.replace(/\.md$/, '');
            agents.push({
              id, name: metadata.name || id,
              description: metadata.description || t('common.noDescription'),
              tools: metadata.tools || '', model: metadata.model || 'sonnet',
              path: itemPath
            });
          } else if (stat.isDirectory()) {
            const agentFile = this.api.path.join(itemPath, 'AGENT.md');
            try {
              const content = await this.api.fs.promises.readFile(agentFile, 'utf8');
              const { metadata } = parseFrontmatter(content);
              const nameMatch = content.match(/^#\s+(.+)/m);
              agents.push({
                id: item, name: metadata.name || (nameMatch ? nameMatch[1] : item),
                description: metadata.description || t('common.noDescription'),
                tools: metadata.tools || '', model: metadata.model || 'sonnet',
                path: itemPath
              });
            } catch { /* No AGENT.md */ }
          }
        } catch { /* Can't stat */ }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Error loading agents:', e);
    }

    skillsAgentsState.setProp('agents', agents);
    return agents;
  }

  getAgents() {
    return skillsAgentsState.get().agents;
  }

  getAgent(id) {
    return skillsAgentsState.get().agents.find(a => a.id === id);
  }

  isAgentFile(agent) {
    return agent.path.endsWith('.md');
  }

  async readAgentContent(id) {
    const agent = this.getAgent(id);
    if (!agent) return null;
    try {
      if (this.isAgentFile(agent)) {
        return await this.api.fs.promises.readFile(agent.path, 'utf8');
      }
      return await this.api.fs.promises.readFile(this.api.path.join(agent.path, 'AGENT.md'), 'utf8');
    } catch (e) {
      console.error('Error reading agent:', e);
      return null;
    }
  }

  getAgentFiles(id) {
    const agent = this.getAgent(id);
    if (!agent) return [];
    const files = [];
    try {
      if (this.isAgentFile(agent)) {
        const stat = this.api.fs.statSync(agent.path);
        files.push({ name: this.api.path.basename(agent.path), path: agent.path, isDirectory: false, size: stat.size });
      } else {
        this.api.fs.readdirSync(agent.path).forEach(file => {
          const filePath = this.api.path.join(agent.path, file);
          const stat = this.api.fs.statSync(filePath);
          files.push({ name: file, path: filePath, isDirectory: stat.isDirectory(), size: stat.size });
        });
      }
    } catch (e) {
      console.error('Error reading agent files:', e);
    }
    return files;
  }

  async deleteAgent(id) {
    const agent = this.getAgent(id);
    if (!agent) return false;
    try {
      if (this.isAgentFile(agent)) {
        await this.api.fs.promises.unlink(agent.path);
      } else {
        await this.api.fs.promises.rm(agent.path, { recursive: true, force: true });
      }
      await this.loadAgents();
      return true;
    } catch (e) {
      console.error('Error deleting agent:', e);
      return false;
    }
  }

  openAgentInExplorer(id) {
    const agent = this.getAgent(id);
    if (agent) {
      const targetPath = this.isAgentFile(agent) ? this.api.path.dirname(agent.path) : agent.path;
      this.api.dialog.openInExplorer(targetPath);
    }
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function _getInstance() {
  if (!_instance) {
    const { getApiProvider, getContainer } = require('../core');
    _instance = new AgentService(getApiProvider(), getContainer());
  }
  return _instance;
}

module.exports = {
  AgentService,
  getInstance: _getInstance,
  loadAgents: (...a) => _getInstance().loadAgents(...a),
  getAgents: (...a) => _getInstance().getAgents(...a),
  getAgent: (...a) => _getInstance().getAgent(...a),
  readAgentContent: (...a) => _getInstance().readAgentContent(...a),
  getAgentFiles: (...a) => _getInstance().getAgentFiles(...a),
  deleteAgent: (...a) => _getInstance().deleteAgent(...a),
  openAgentInExplorer: (...a) => _getInstance().openAgentInExplorer(...a),
};
