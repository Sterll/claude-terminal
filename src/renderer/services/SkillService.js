/**
 * Skill Service
 * Handles skill loading and management
 */

// Use preload API for Node.js modules
const { fs, path, os } = window.electron_nodeModules;
const { skillsDir } = require('../utils/paths');
const { skillsAgentsState } = require('../state');
const { t } = require('../i18n');

// Plugins directory
const pluginsDir = path.join(os.homedir(), '.claude', 'plugins');
const installedPluginsFile = path.join(pluginsDir, 'installed_plugins.json');

/**
 * Parse YAML frontmatter from markdown content
 * @param {string} content - Markdown content
 * @returns {Object} - { metadata, body }
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { metadata: {}, body: content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const metadata = {};

  // Simple YAML parsing for key: value pairs
  yamlStr.split('\n').forEach(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      // Remove quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      metadata[key] = value;
    }
  });

  return { metadata, body };
}

/**
 * Load skills from a directory
 * @param {string} dir - Directory to scan
 * @param {string} source - Source identifier ('local' or plugin name)
 * @param {string} sourceLabel - Human readable source label
 * @returns {Array}
 */
async function loadSkillsFromDir(dir, source = 'local', sourceLabel = 'Local') {
  const skills = [];

  try {
    await fs.promises.access(dir);
  } catch {
    return skills;
  }

  try {
    const items = await fs.promises.readdir(dir);
    for (const item of items) {
      const itemPath = path.join(dir, item);

      try {
        const stat = await fs.promises.stat(itemPath);
        if (stat.isDirectory()) {
          const skillFile = path.join(itemPath, 'SKILL.md');

          try {
            const content = await fs.promises.readFile(skillFile, 'utf8');
            const { metadata, body } = parseFrontmatter(content);
            const nameMatch = body.match(/^#\s+(.+)/m);

            skills.push({
              id: `${source}:${item}`,
              name: metadata.name || (nameMatch ? nameMatch[1] : item),
              description: metadata.description || t('common.noDescription'),
              userInvocable: metadata['user-invocable'] === 'true',
              path: itemPath,
              source,
              sourceLabel,
              isPlugin: source !== 'local'
            });
          } catch {
            // SKILL.md doesn't exist, skip
          }
        }
      } catch {
        // Can't stat, skip
      }
    }
  } catch (e) {
    console.error(`Error loading skills from ${dir}:`, e);
  }

  return skills;
}

/**
 * Load skills from installed plugins
 * @returns {Array}
 */
async function loadPluginSkills() {
  const skills = [];

  try {
    await fs.promises.access(installedPluginsFile);
  } catch {
    return skills;
  }

  try {
    const rawData = await fs.promises.readFile(installedPluginsFile, 'utf8');
    const installedData = JSON.parse(rawData);
    const plugins = installedData.plugins || {};

    for (const [pluginKey, installations] of Object.entries(plugins)) {
      const [pluginName] = pluginKey.split('@');

      for (const install of installations) {
        const installPath = install.installPath;
        if (!installPath) continue;

        try {
          await fs.promises.access(installPath);
        } catch {
          continue;
        }

        // Load plugin metadata
        let pluginMeta = { name: pluginName };
        const pluginJsonPath = path.join(installPath, '.claude-plugin', 'plugin.json');
        try {
          const metaRaw = await fs.promises.readFile(pluginJsonPath, 'utf8');
          pluginMeta = JSON.parse(metaRaw);
        } catch { /* ignore */ }

        // Load skills from plugin's skills directory
        const pluginSkillsDir = path.join(installPath, 'skills');
        const sourceLabel = pluginMeta.name || pluginName;
        const pluginSkills = await loadSkillsFromDir(pluginSkillsDir, pluginKey, sourceLabel);
        skills.push(...pluginSkills);
      }
    }
  } catch (e) {
    console.error('Error loading plugin skills:', e);
  }

  return skills;
}

/**
 * Load all skills from all sources
 * @returns {Array}
 */
async function loadSkills() {
  const skills = [];

  // Load local skills
  const localSkills = await loadSkillsFromDir(skillsDir, 'local', 'Local');
  skills.push(...localSkills);

  // Load plugin skills
  const pluginSkills = await loadPluginSkills();
  skills.push(...pluginSkills);

  // Update state
  skillsAgentsState.setProp('skills', skills);

  return skills;
}

/**
 * Get all loaded skills
 * @returns {Array}
 */
function getSkills() {
  return skillsAgentsState.get().skills;
}

/**
 * Get skill by ID
 * @param {string} id
 * @returns {Object|undefined}
 */
function getSkill(id) {
  return skillsAgentsState.get().skills.find(s => s.id === id);
}

/**
 * Read skill content
 * @param {string} id - Skill ID
 * @returns {string|null}
 */
function readSkillContent(id) {
  const skill = getSkill(id);
  if (!skill) return null;

  const skillFile = path.join(skill.path, 'SKILL.md');
  try {
    return fs.readFileSync(skillFile, 'utf8');
  } catch (e) {
    console.error('Error reading skill:', e);
    return null;
  }
}

/**
 * Get skill files
 * @param {string} id - Skill ID
 * @returns {Array}
 */
function getSkillFiles(id) {
  const skill = getSkill(id);
  if (!skill) return [];

  const files = [];
  try {
    fs.readdirSync(skill.path).forEach(file => {
      const filePath = path.join(skill.path, file);
      const stat = fs.statSync(filePath);
      files.push({
        name: file,
        path: filePath,
        isDirectory: stat.isDirectory(),
        size: stat.size
      });
    });
  } catch (e) {
    console.error('Error reading skill files:', e);
  }

  return files;
}

/**
 * Delete a skill
 * @param {string} id - Skill ID
 * @returns {boolean}
 */
async function deleteSkill(id) {
  const skill = getSkill(id);
  if (!skill) return false;

  try {
    // Remove directory recursively
    await fs.promises.rm(skill.path, { recursive: true, force: true });
    await loadSkills(); // Reload
    return true;
  } catch (e) {
    console.error('Error deleting skill:', e);
    return false;
  }
}

/**
 * Open skill in explorer
 * @param {string} id - Skill ID
 */
function openSkillInExplorer(id) {
  const skill = getSkill(id);
  if (skill) {
    window.electron_api.dialog.openInExplorer(skill.path);
  }
}

module.exports = {
  loadSkills,
  getSkills,
  getSkill,
  readSkillContent,
  getSkillFiles,
  deleteSkill,
  openSkillInExplorer
};
