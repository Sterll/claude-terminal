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
const CloudPanel = require('./CloudPanel');
const ConnectivityPanel = require('./ConnectivityPanel');
const WorkspacePanel = require('./WorkspacePanel');
const ErrorLogPanel = require('./ErrorLogPanel');
const FilesPanel = require('./FilesPanel');
const ArtifactsPanel = require('./ArtifactsPanel');

// WorkflowPanel, DatabasePanel, ControlTowerPanel, SessionReplayPanel and
// ParallelTaskPanel are deliberately absent: they are code-split and reached
// through the _LAZY_PANELS map in renderer.js, which import()s them the first
// time their tab is opened. Naming one here would put it back in the startup
// bundle — this index is CommonJS, so a require() is a side effect esbuild
// cannot shake out even when nothing reads the binding.

module.exports = {
  FilesPanel,
  MemoryEditor,
  GitChangesPanel,
  ShortcutsManager,
  SettingsPanel,
  SkillsAgentsPanel,
  PluginsPanel,
  MarketplacePanel,
  McpPanel,
  CloudPanel,
  ConnectivityPanel,
  WorkspacePanel,
  ErrorLogPanel,
  ArtifactsPanel,
};
