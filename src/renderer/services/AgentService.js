/**
 * Agent Service
 * Handles agent loading and management
 */

// Use preload API for Node.js modules
const { fs, path } = window.electron_nodeModules;
const { agentsDir } = require('../utils/paths');
const { skillsAgentsState } = require('../state');
const { t } = require('../i18n');

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
 * Load all agents from the agents directory
 * @returns {Array}
 */
async function loadAgents() {
  const agents = [];

  try {
    await fs.promises.access(agentsDir);
    const items = await fs.promises.readdir(agentsDir);

    for (const item of items) {
      const itemPath = path.join(agentsDir, item);

      try {
        const stat = await fs.promises.stat(itemPath);

        // Handle .md files directly in agents directory
        if (stat.isFile() && item.endsWith('.md')) {
          const content = await fs.promises.readFile(itemPath, 'utf8');
          const { metadata } = parseFrontmatter(content);

          const id = item.replace(/\.md$/, '');
          agents.push({
            id,
            name: metadata.name || id,
            description: metadata.description || t('common.noDescription'),
            tools: metadata.tools || '',
            model: metadata.model || 'sonnet',
            path: itemPath
          });
        }
        // Also handle subdirectories with AGENT.md (legacy format)
        else if (stat.isDirectory()) {
          const agentFile = path.join(itemPath, 'AGENT.md');
          try {
            const content = await fs.promises.readFile(agentFile, 'utf8');
            const { metadata } = parseFrontmatter(content);
            const nameMatch = content.match(/^#\s+(.+)/m);

            agents.push({
              id: item,
              name: metadata.name || (nameMatch ? nameMatch[1] : item),
              description: metadata.description || t('common.noDescription'),
              tools: metadata.tools || '',
              model: metadata.model || 'sonnet',
              path: itemPath
            });
          } catch {
            // No AGENT.md in this directory, skip
          }
        }
      } catch {
        // Can't stat, skip
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('Error loading agents:', e);
    }
  }

  // Update state
  skillsAgentsState.setProp('agents', agents);

  return agents;
}

/**
 * Get all loaded agents
 * @returns {Array}
 */
function getAgents() {
  return skillsAgentsState.get().agents;
}

/**
 * Get agent by ID
 * @param {string} id
 * @returns {Object|undefined}
 */
function getAgent(id) {
  return skillsAgentsState.get().agents.find(a => a.id === id);
}

/**
 * Check if agent is a file (new format) or directory (legacy format)
 * @param {Object} agent
 * @returns {boolean}
 */
function isAgentFile(agent) {
  return agent.path.endsWith('.md');
}

/**
 * Read agent content
 * @param {string} id - Agent ID
 * @returns {string|null}
 */
function readAgentContent(id) {
  const agent = getAgent(id);
  if (!agent) return null;

  try {
    if (isAgentFile(agent)) {
      // New format: single .md file
      return fs.readFileSync(agent.path, 'utf8');
    } else {
      // Legacy format: directory with AGENT.md
      const agentFile = path.join(agent.path, 'AGENT.md');
      return fs.readFileSync(agentFile, 'utf8');
    }
  } catch (e) {
    console.error('Error reading agent:', e);
    return null;
  }
}

/**
 * Get agent files
 * @param {string} id - Agent ID
 * @returns {Array}
 */
function getAgentFiles(id) {
  const agent = getAgent(id);
  if (!agent) return [];

  const files = [];
  try {
    if (isAgentFile(agent)) {
      // New format: single file
      const stat = fs.statSync(agent.path);
      files.push({
        name: path.basename(agent.path),
        path: agent.path,
        isDirectory: false,
        size: stat.size
      });
    } else {
      // Legacy format: directory
      fs.readdirSync(agent.path).forEach(file => {
        const filePath = path.join(agent.path, file);
        const stat = fs.statSync(filePath);
        files.push({
          name: file,
          path: filePath,
          isDirectory: stat.isDirectory(),
          size: stat.size
        });
      });
    }
  } catch (e) {
    console.error('Error reading agent files:', e);
  }

  return files;
}

/**
 * Delete an agent
 * @param {string} id - Agent ID
 * @returns {boolean}
 */
async function deleteAgent(id) {
  const agent = getAgent(id);
  if (!agent) return false;

  try {
    if (isAgentFile(agent)) {
      // New format: delete single file
      await fs.promises.unlink(agent.path);
    } else {
      // Legacy format: remove directory recursively
      await fs.promises.rm(agent.path, { recursive: true, force: true });
    }
    await loadAgents(); // Reload
    return true;
  } catch (e) {
    console.error('Error deleting agent:', e);
    return false;
  }
}

/**
 * Open agent in explorer
 * @param {string} id - Agent ID
 */
function openAgentInExplorer(id) {
  const agent = getAgent(id);
  if (agent) {
    // For file agents, open the containing directory
    const targetPath = isAgentFile(agent) ? path.dirname(agent.path) : agent.path;
    window.electron_api.dialog.openInExplorer(targetPath);
  }
}

module.exports = {
  loadAgents,
  getAgents,
  getAgent,
  readAgentContent,
  getAgentFiles,
  deleteAgent,
  openAgentInExplorer
};
