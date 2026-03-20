/**
 * Skill Service
 * Handles skill loading and management
 */

const { BaseService } = require('../core/BaseService');
const { parseFrontmatter } = require('../utils/frontmatter');
const { skillsAgentsState } = require('../state');
const { t } = require('../i18n');
const { skillsDir } = require('../utils/paths');

class SkillService extends BaseService {
  constructor(api, container) {
    super(api, container);
    this._skillsDir = skillsDir;
    this._pluginsDir = this.api.path.join(this.api.os.homedir(), '.claude', 'plugins');
    this._installedPluginsFile = this.api.path.join(this._pluginsDir, 'installed_plugins.json');
  }

  async loadSkills() {
    const skills = [];
    const localSkills = await this._loadSkillsFromDir(this._skillsDir, 'local', 'Local');
    skills.push(...localSkills);
    const pluginSkills = await this._loadPluginSkills();
    skills.push(...pluginSkills);
    skillsAgentsState.setProp('skills', skills);
    return skills;
  }

  getSkills() {
    return skillsAgentsState.get().skills;
  }

  getSkill(id) {
    return skillsAgentsState.get().skills.find(s => s.id === id);
  }

  async readSkillContent(id) {
    const skill = this.getSkill(id);
    if (!skill) return null;
    const skillFile = this.api.path.join(skill.path, 'SKILL.md');
    try {
      return await this.api.fs.promises.readFile(skillFile, 'utf8');
    } catch (e) {
      console.error('Error reading skill:', e);
      return null;
    }
  }

  getSkillFiles(id) {
    const skill = this.getSkill(id);
    if (!skill) return [];
    const files = [];
    try {
      this.api.fs.readdirSync(skill.path).forEach(file => {
        const filePath = this.api.path.join(skill.path, file);
        const stat = this.api.fs.statSync(filePath);
        files.push({ name: file, path: filePath, isDirectory: stat.isDirectory(), size: stat.size });
      });
    } catch (e) {
      console.error('Error reading skill files:', e);
    }
    return files;
  }

  async deleteSkill(id) {
    const skill = this.getSkill(id);
    if (!skill) return false;
    try {
      await this.api.fs.promises.rm(skill.path, { recursive: true, force: true });
      await this.loadSkills();
      return true;
    } catch (e) {
      console.error('Error deleting skill:', e);
      return false;
    }
  }

  openSkillInExplorer(id) {
    const skill = this.getSkill(id);
    if (skill) {
      this.api.dialog.openInExplorer(skill.path);
    }
  }

  // ── Private ──

  async _loadSkillsFromDir(dir, source = 'local', sourceLabel = 'Local') {
    const skills = [];
    try { await this.api.fs.promises.access(dir); } catch { return skills; }

    try {
      const items = await this.api.fs.promises.readdir(dir);
      for (const item of items) {
        const itemPath = this.api.path.join(dir, item);
        try {
          const stat = await this.api.fs.promises.stat(itemPath);
          if (stat.isDirectory()) {
            const skillFile = this.api.path.join(itemPath, 'SKILL.md');
            try {
              const content = await this.api.fs.promises.readFile(skillFile, 'utf8');
              const { metadata, body } = parseFrontmatter(content);
              const nameMatch = body.match(/^#\s+(.+)/m);
              skills.push({
                id: `${source}:${item}`,
                name: metadata.name || (nameMatch ? nameMatch[1] : item),
                description: metadata.description || t('common.noDescription'),
                userInvocable: metadata['user-invocable'] === 'true',
                path: itemPath, source, sourceLabel,
                isPlugin: source !== 'local'
              });
            } catch { /* SKILL.md doesn't exist */ }
          }
        } catch { /* Can't stat */ }
      }
    } catch (e) {
      console.error(`Error loading skills from ${dir}:`, e);
    }
    return skills;
  }

  async _loadPluginSkills() {
    const skills = [];
    try { await this.api.fs.promises.access(this._installedPluginsFile); } catch { return skills; }

    try {
      const rawData = await this.api.fs.promises.readFile(this._installedPluginsFile, 'utf8');
      const installedData = JSON.parse(rawData);
      const plugins = installedData.plugins || {};

      for (const [pluginKey, installations] of Object.entries(plugins)) {
        const [pluginName] = pluginKey.split('@');
        for (const install of installations) {
          if (!install.installPath) continue;
          try { await this.api.fs.promises.access(install.installPath); } catch { continue; }

          let pluginMeta = { name: pluginName };
          const pluginJsonPath = this.api.path.join(install.installPath, '.claude-plugin', 'plugin.json');
          try {
            pluginMeta = JSON.parse(await this.api.fs.promises.readFile(pluginJsonPath, 'utf8'));
          } catch { /* ignore */ }

          const pluginSkillsDir = this.api.path.join(install.installPath, 'skills');
          const pluginSkills = await this._loadSkillsFromDir(pluginSkillsDir, pluginKey, pluginMeta.name || pluginName);
          skills.push(...pluginSkills);
        }
      }
    } catch (e) {
      console.error('Error loading plugin skills:', e);
    }
    return skills;
  }
}

// ── Lazy singleton + legacy exports ──

let _instance = null;

function _getInstance() {
  if (!_instance) {
    const { getApiProvider, getContainer } = require('../core');
    _instance = new SkillService(getApiProvider(), getContainer());
  }
  return _instance;
}

module.exports = {
  SkillService,
  getInstance: _getInstance,
  loadSkills: (...a) => _getInstance().loadSkills(...a),
  getSkills: (...a) => _getInstance().getSkills(...a),
  getSkill: (...a) => _getInstance().getSkill(...a),
  readSkillContent: (...a) => _getInstance().readSkillContent(...a),
  getSkillFiles: (...a) => _getInstance().getSkillFiles(...a),
  deleteSkill: (...a) => _getInstance().deleteSkill(...a),
  openSkillInExplorer: (...a) => _getInstance().openSkillInExplorer(...a),
};
