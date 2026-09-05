/**
 * Settings State Module
 * Manages application settings
 */

// Use preload API for Node.js modules
const { fs } = window.electron_nodeModules;
const { fileExists, atomicWriteJSON } = require('../utils/fs-async');
const fsp = require('../utils/fs-async').fsp;
const { State } = require('./State');
const { settingsFile } = require('../utils/paths');

// Default settings
const defaultSettings = {
  editor: 'code', // 'code', 'cursor', 'webstorm', 'idea', 'custom'
  customEditorCommand: '', // Custom editor command when editor is 'custom'
  shortcut: typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? 'Cmd+Shift+P' : 'Ctrl+Shift+P',
  skipPermissions: false,
  executionMode: 'safe', // 'safe' (default), 'auto' (SDK classifier), 'dangerous' (bypassPermissions)
  accentColor: '#d97706',
  notificationsEnabled: true,
  closeAction: 'ask', // 'ask', 'minimize', 'quit'
  shortcuts: {}, // Custom keyboard shortcuts overrides
  language: null, // null = auto-detect, 'fr' = French, 'en' = English
  compactProjects: true, // Compact project list (only show name when not active)
  customPresets: [], // Custom quick action presets [{name, command, icon}]
  aiCommitMessages: true, // Use Claude Haiku for AI commit messages
  defaultTerminalMode: 'terminal', // 'terminal' or 'chat' - default mode for new Claude terminals
  hooksEnabled: false, // Hooks installed in ~/.claude/settings.json
  hooksConsentShown: false, // User has seen the hooks consent prompt
  chatModel: null, // null = CLI default, or a model id from the catalog (e.g. 'opus[1m]', 'sonnet')
  enable1MContext: false, // Enable 1M token context window via betas flag
  effortLevel: 'high', // Effort level for chat sessions: low, medium, high, xhigh, max
  remoteEnabled: false, // Enable remote control via mobile PWA
  remotePort: 3712, // Port for the remote control WebSocket/HTTP server
  restoreTerminalSessions: true, // Restore terminal tabs from previous session on startup
  remoteSelectedIp: null, // Selected network interface IP for pairing URL (null = auto)
  remotePersistentPin: false, // Use a fixed PIN that never expires
  remotePersistentPinValue: '', // The custom 6-digit PIN value
  showDotfiles: true, // true = show dotfiles in file explorer (default), false = hide them
  explorerIgnorePatterns: [], // Additional ignore patterns for file explorer (user-configured)
  showTabModeToggle: true, // Show Chat/Terminal mode-switch button on terminal tabs
  tabRenameOnSlashCommand: false, // Rename terminal tab to slash command text when submitted
  aiTabNaming: true, // Use AI (Haiku) to generate short tab names from messages
  cloudServerUrl: '', // Cloud relay server URL (e.g. 'https://cloud.example.com')
  cloudApiKey: '', // Cloud API key (e.g. 'ctc_abc123...')
  cloudAutoConnect: true, // Auto-connect to cloud relay on startup
  cloudAutoSync: true, // Auto-sync local changes to cloud
  cloudSyncSettings: true, // Sync app settings
  cloudSyncProjects: true, // Sync project list
  cloudSyncTimeTracking: true, // Sync time tracking + archives
  cloudSyncConversations: true, // Sync chat conversations
  cloudSyncSkills: false, // Sync skills & agents directories (opt-in)
  cloudSyncMcpConfigs: true, // Sync MCP server configs
  cloudSyncKeybindings: true, // Sync keybindings
  cloudSyncMemory: true, // Sync MEMORY.md
  cloudSyncHooksConfig: true, // Sync hooks config
  cloudSyncPlugins: true, // Sync installed plugins list
  cloudAutoUploadProjects: false, // When true, prompt before uploading new projects to cloud (never fires silently)
  cloudExcludeSensitiveFiles: true, // Exclude .env, keys, credentials from cloud sync (default: safe)
  globalShortcuts: {}, // Custom global shortcut overrides: { globalQuickPicker: 'Ctrl+Shift+X', ... }
  globalShortcutsEnabled: true, // Master toggle for OS-level global shortcuts
  terminalShortcuts: {}, // Terminal shortcut toggles (empty = all enabled by default)
  telemetryEnabled: false, // Opt-in anonymous telemetry
  telemetryUuid: null, // Random UUID for anonymous tracking
  telemetryCategories: { app: true, features: true, errors: true }, // Granular event categories
  telemetryConsentShown: false, // Whether consent prompt was shown
  agentColors: {}, // Custom colors per tool/agent name: { 'Grep': '#ff0000', 'my-agent': '#00ff00' }
  enableFollowupSuggestions: true, // Show AI-generated follow-up suggestion chips after Claude responds (uses Haiku)
  enhancePrompts: false, // Opt-in: reformulate prompts via Haiku for better prompt engineering before sending
  // Every tab is pinned by default: the grouped sidebar fits without overflow,
  // so the More menu is now opt-in rather than the default state.
  pinnedTabs: ['claude', 'dashboard', 'files', 'git', 'session-replay', 'tasks', 'artifacts', 'control-tower', 'workspace', 'memory', 'timetracking', 'database', 'skills', 'agents', 'plugins', 'mcp', 'workflows', 'errorlog', 'connectivity'],
  activeTab: 'claude', // Last active sidebar tab (restored on restart)
  openProjectIds: [], // Projects with a tab in the project bar, in tab order (restored on restart)
  navigationMode: null, // 'tabs' | 'sidebar' | null = never chosen, ask once on next launch
  tabsOrder: null, // null = canonical order, otherwise array of all tabIds in custom order
  parallelMaxAgents: 3, // Default number of parallel agents for Parallel Task Manager (1-10)
  maxTurns: null, // null = no limit (SDK/CLI default), or a cap on API round-trips for the whole tab
  autoClaudeMdUpdate: true, // Suggest CLAUDE.md updates after chat sessions
  dailyGoal: 0, // Daily time goal in minutes (0 = disabled)
  githubApiUrl: 'https://api.github.com', // GitHub API base URL (for GitHub Enterprise)
  githubHostname: 'github.com', // GitHub hostname for remote URL detection
  personaName: '', // User's name for persona (optional, injected into chat system prompt)
  personaInstructions: '', // Custom instructions for Claude persona (optional, appended to system prompt)
  discordRpcEnabled: true, // Discord Rich Presence ("Coding in {project} - Claude Terminal")
  discordRpcShowProject: true, // Include the project name in the Discord presence (off = generic)
};

const settingsState = new State({ ...defaultSettings });

/**
 * Get all settings
 * @returns {Object}
 */
function getSettings() {
  return settingsState.get();
}

/**
 * Get a specific setting
 * @param {string} key
 * @returns {*}
 */
function getSetting(key) {
  return settingsState.get()[key];
}

/**
 * Update settings
 * @param {Object} updates
 */
function updateSettings(updates) {
  settingsState.set(updates);
  saveSettings();
}

/**
 * Update a specific setting
 * @param {string} key
 * @param {*} value
 */
function setSetting(key, value) {
  settingsState.setProp(key, value);
  saveSettings();
}

/**
 * Load settings from file, with backup restore on corruption
 */
/**
 * Migrate saved settings from older formats
 * @param {Object} saved - parsed settings object (mutated in place)
 */
function _migrateSettings(saved) {
  // v1.3.0: Rename 'cloud-panel' tab → 'connectivity'
  if (Array.isArray(saved.pinnedTabs)) {
    const idx = saved.pinnedTabs.indexOf('cloud-panel');
    if (idx !== -1) saved.pinnedTabs[idx] = 'connectivity';
  }
  if (Array.isArray(saved.tabsOrder)) {
    const idx = saved.tabsOrder.indexOf('cloud-panel');
    if (idx !== -1) saved.tabsOrder[idx] = 'connectivity';
  }
  if (saved.activeTab === 'cloud-panel') {
    saved.activeTab = 'connectivity';
  }

  // Workspaces, Error Log and Artifacts were never in the default pinned set,
  // so nobody could have deliberately unpinned them. The grouped sidebar has
  // room now.
  if (Array.isArray(saved.pinnedTabs)) {
    for (const id of ['workspace', 'errorlog', 'artifacts']) {
      if (!saved.pinnedTabs.includes(id)) saved.pinnedTabs.push(id);
    }
    // Files is new, so an existing array cannot have deliberately excluded it.
    // Slot it under Dashboard, where it sits in the Project group.
    if (!saved.pinnedTabs.includes('files')) {
      const after = saved.pinnedTabs.indexOf('dashboard');
      saved.pinnedTabs.splice(after === -1 ? saved.pinnedTabs.length : after + 1, 0, 'files');
    }
  }

  // Same for a custom nav order. _applyTabsOrder re-inserts the tabs it knows
  // after the group anchor, so an id missing from the array gets pushed to the
  // bottom of its group — Files would sink below Tasks on any account that has
  // ever reordered the sidebar.
  if (Array.isArray(saved.tabsOrder) && saved.tabsOrder.length && !saved.tabsOrder.includes('files')) {
    const after = saved.tabsOrder.indexOf('dashboard');
    saved.tabsOrder.splice(after === -1 ? saved.tabsOrder.length : after + 1, 0, 'files');
  }
}

/**
 * Read and parse a settings JSON file.
 * Empty or whitespace-only content counts as unreadable: a truncated file is
 * as much a data loss as a corrupt one and must trigger the backup path.
 * @param {string} file
 * @returns {Promise<Object|null>}
 */
async function _readSettingsFile(file) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadSettings() {
  const backupFile = `${settingsFile}.bak`;

  let saved = await _readSettingsFile(settingsFile);
  if (!saved) {
    const fromBackup = await _readSettingsFile(backupFile);
    if (fromBackup) {
      console.warn('Settings file missing, empty or corrupt - restored from backup');
      saved = fromBackup;
    } else if (await fileExists(settingsFile)) {
      console.error('Settings file unreadable and no usable backup - falling back to defaults');
    }
  }

  if (saved) {
    _migrateSettings(saved);
    settingsState.set({ ...defaultSettings, ...saved });
  }
}

/**
 * Listeners notified after a flush (success or error)
 * @type {Array<Function>}
 */
const _saveListeners = [];

/**
 * Register a listener called after each disk flush.
 * Callback receives `{ success: boolean, error?: Error }`.
 * @param {Function} fn
 * @returns {Function} unsubscribe
 */
function onSaveFlush(fn) {
  _saveListeners.push(fn);
  return () => {
    const idx = _saveListeners.indexOf(fn);
    if (idx !== -1) _saveListeners.splice(idx, 1);
  };
}

function _notifySaveListeners(result) {
  for (const fn of _saveListeners) {
    try { fn(result); } catch (_) {}
  }
}

/**
 * Save settings to file (debounced)
 */
let saveSettingsTimer = null;
function saveSettings() {
  clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsImmediate();
  }, 500);
}

/**
 * Save settings to file immediately (no debounce)
 * Uses atomic write: tmp file -> backup old -> rename
 * Flushes are chained so two overlapping saves never interleave their
 * backup/rename steps on the same file.
 */
let _pendingSave = null;
async function saveSettingsImmediate() {
  clearTimeout(saveSettingsTimer);
  const prev = _pendingSave;
  const flush = (async () => {
    if (prev) {
      try { await prev; } catch (_) {}
    }
    return atomicWriteJSON(settingsFile, settingsState.get());
  })();
  _pendingSave = flush;
  try {
    await flush;
    _notifySaveListeners({ success: true });
  } catch (e) {
    console.error('Error saving settings:', e);
    _notifySaveListeners({ success: false, error: e });
  } finally {
    if (_pendingSave === flush) _pendingSave = null;
  }
}

/**
 * Reset settings to defaults
 */
function resetSettings() {
  settingsState.set({ ...defaultSettings });
  saveSettings();
}

/**
 * Get editor command for a given editor type
 * @param {string} editor
 * @returns {string}
 */
function getEditorCommand(editor) {
  if (editor === 'custom') {
    return settingsState.get().customEditorCommand || 'code';
  }
  const commands = {
    code: 'code',
    cursor: 'cursor',
    webstorm: 'webstorm',
    idea: 'idea'
  };
  return commands[editor] || 'code';
}

/**
 * Available editor options
 */
const EDITOR_OPTIONS = [
  { value: 'code', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'webstorm', label: 'WebStorm' },
  { value: 'idea', label: 'IntelliJ IDEA' }
];

/**
 * Get notifications enabled state
 * @returns {boolean}
 */
function isNotificationsEnabled() {
  return settingsState.get().notificationsEnabled;
}

/**
 * Toggle notifications
 */
function toggleNotifications() {
  const current = settingsState.get().notificationsEnabled;
  setSetting('notificationsEnabled', !current);
}

module.exports = {
  settingsState,
  defaultSettings,
  getSettings,
  getSetting,
  updateSettings,
  setSetting,
  loadSettings,
  saveSettings,
  saveSettingsImmediate,
  resetSettings,
  getEditorCommand,
  EDITOR_OPTIONS,
  isNotificationsEnabled,
  toggleNotifications,
  onSaveFlush
};
