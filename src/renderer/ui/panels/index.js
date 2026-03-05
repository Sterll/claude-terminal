/**
 * UI Panels - Central Export
 * Tab-level panel views extracted from renderer.js
 */

const MemoryEditor = require('./MemoryEditor');
const GitChangesPanel = require('./GitChangesPanel');
const ShortcutsManager = require('./ShortcutsManager');
const SettingsPanel = require('./SettingsPanel');
const SkillsAgentsPanel = require('./SkillsAgentsPanel');
const PluginsPanel = require('./PluginsPanel');
const MarketplacePanel = require('./MarketplacePanel');
const McpPanel = require('./McpPanel');
const WorkflowPanel = require('./WorkflowPanel');
const DatabasePanel = require('./DatabasePanel');
const CloudPanel = require('./CloudPanel');
const WorktreesDashboard = require('./WorktreesDashboard');

module.exports = {
  MemoryEditor,
  GitChangesPanel,
  ShortcutsManager,
  SettingsPanel,
  SkillsAgentsPanel,
  PluginsPanel,
  MarketplacePanel,
  McpPanel,
  WorkflowPanel,
  DatabasePanel,
  CloudPanel,
  WorktreesDashboard
};
