/**
 * State Module - Central Export
 * Combines all state modules into a unified interface
 */

const { State } = require('./State');
const projectsState = require('./projects.state');
const terminalsState = require('./terminals.state');
const mcpState = require('./mcp.state');
const fivemState = require('./fivem.state');
const gitState = require('./git.state');
const settingsState = require('./settings.state');
const timeTrackingState = require('./timeTracking.state');

// Quick picker state (simple, doesn't need a module)
const quickPickerState = new State({
  isOpen: false,
  selectedIndex: 0,
  filteredProjects: []
});

// Drag & drop state
const dragState = new State({
  dragging: null,      // { type: 'project'|'folder', id: string|number }
  dropTarget: null     // { type: 'folder'|'root', id: string|null }
});

// Context menu state
const contextMenuState = new State({
  visible: false,
  target: null,        // { type: 'project'|'folder'|'empty', id: string|number|null }
  x: 0,
  y: 0
});

// Skills and agents (simple state)
const skillsAgentsState = new State({
  skills: [],
  agents: []
});

/**
 * Initialize all state modules
 */
async function initializeState() {
  await settingsState.loadSettings();
  await projectsState.loadProjects();
  // Initialize time tracking with project state references
  await timeTrackingState.initTimeTracking(projectsState.projectsState);
  // Load FiveM resource shortcuts
  fivemState.loadResourceShortcuts();
  // Lazy require to avoid circular dependency
  // Load skills and agents async in background (not needed for initial render)
  const { loadSkills } = require('../services/SkillService');
  const { loadAgents } = require('../services/AgentService');
  const { loadContextPacks, loadPromptTemplates } = require('../services/ContextPromptService');
  Promise.all([loadSkills(), loadAgents(), loadContextPacks(), loadPromptTemplates()]).catch(e => {
    console.error('Error loading skills/agents/library:', e);
  });
}

/**
 * Get combined application state (for debugging)
 * @returns {Object}
 */
function getAppState() {
  return {
    projects: projectsState.projectsState.get(),
    terminals: terminalsState.terminalsState.get(),
    mcp: mcpState.mcpState.get(),
    fivem: fivemState.fivemState.get(),
    git: gitState.gitState.get(),
    settings: settingsState.settingsState.get(),
    quickPicker: quickPickerState.get(),
    drag: dragState.get(),
    contextMenu: contextMenuState.get(),
    skillsAgents: skillsAgentsState.get()
  };
}

module.exports = {
  // Core
  State,
  initializeState,
  getAppState,

  // Projects
  ...projectsState,

  // Terminals
  ...terminalsState,

  // MCP
  ...mcpState,

  // FiveM
  ...fivemState,

  // Git
  ...gitState,

  // Settings
  ...settingsState,

  // Time Tracking
  ...timeTrackingState,

  // Simple states
  quickPickerState,
  dragState,
  contextMenuState,
  skillsAgentsState
};
