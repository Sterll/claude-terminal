'use strict';

/**
 * Settings & App Control Tools Module for Claude Terminal MCP
 *
 * Provides settings read/write, notification sending, and app info tools.
 * Data is in CT_DATA_DIR/settings.json.
 */

const fs = require('fs');
const path = require('path');
const { loadProjects } = require('./_projectsCache');

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:settings] ${args.join(' ')}\n`);
}

// -- Data access --------------------------------------------------------------

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

// All settings from settings.state.js - kept in sync
const KNOWN_SETTINGS = new Set([
  // Editor & UI
  'editor',
  'customEditorCommand',
  'accentColor',
  'language',
  'compactProjects',
  'showDotfiles',
  'showTabModeToggle',
  'pinnedTabs',
  'activeTab',
  'tabsOrder',

  // Terminal & Chat
  'defaultTerminalMode',
  'chatModel',
  'effortLevel',
  'enable1MContext',
  'maxTurns',
  'restoreTerminalSessions',
  'tabRenameOnSlashCommand',
  'aiTabNaming',
  'enableFollowupSuggestions',
  'enhancePrompts',
  'autoClaudeMdUpdate',

  // Shortcuts
  'shortcut',
  'shortcuts',
  'globalShortcuts',
  'globalShortcutsEnabled',
  'terminalShortcuts',

  // Notifications
  'notificationsEnabled',
  'closeAction',

  // Quick actions
  'customPresets',

  // AI features
  'aiCommitMessages',

  // Hooks
  'hooksEnabled',
  'hooksConsentShown',

  // Remote control
  'remoteEnabled',
  'remotePort',
  'remoteSelectedIp',
  'remotePersistentPin',

  // File explorer
  'explorerIgnorePatterns',

  // Time tracking
  'dailyGoal',

  // Parallel tasks
  'parallelMaxAgents',

  // Agent colors
  'agentColors',

  // Cloud sync
  'cloudServerUrl',
  'cloudAutoConnect',
  'cloudAutoSync',
  'cloudSyncSettings',
  'cloudSyncProjects',
  'cloudSyncTimeTracking',
  'cloudSyncConversations',
  'cloudSyncSkills',
  'cloudSyncMcpConfigs',
  'cloudSyncKeybindings',
  'cloudSyncMemory',
  'cloudSyncHooksConfig',
  'cloudSyncPlugins',
  'cloudAutoUploadProjects',
  'cloudExcludeSensitiveFiles',

  // GitHub Enterprise
  'githubApiUrl',
  'githubHostname',

  // Telemetry (read-only via MCP)
  'telemetryEnabled',
  'telemetryCategories',
  'telemetryConsentShown',
]);

// Sensitive settings - readable but NOT writable via MCP
const READONLY_SETTINGS = new Set([
  'skipPermissions',        // Security: bypasses Claude permissions
  'cloudApiKey',            // Credentials
  'remotePersistentPinValue', // Auth PIN
  'telemetryEnabled',       // Privacy: user must opt-in via UI
  'telemetryUuid',          // Privacy: tracking ID
  'telemetryCategories',    // Privacy
  'telemetryConsentShown',  // Privacy
  'hooksConsentShown',      // Consent state
]);

function loadSettings() {
  const file = path.join(getDataDir(), 'settings.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('Error reading settings.json:', e.message);
  }
  return {};
}

function saveSettings(data) {
  const dir = getDataDir();
  if (!dir) throw new Error('CT_DATA_DIR not set');

  const file = path.join(dir, 'settings.json');
  const tmpFile = file + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, file);
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

function formatSettingValue(key, value) {
  if (value === null || value === undefined) return '(not set)';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'settings_get',
    description: 'Get Claude Terminal settings. Returns all settings or a specific key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Specific setting key to read (e.g. "accentColor", "language", "editor"). Omit to return all settings.' },
      },
    },
  },
  {
    name: 'settings_set',
    description: 'Update a Claude Terminal setting. Changes take effect after app reload.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Setting key to update (e.g. "accentColor", "language", "editor")' },
        value: { description: 'New value for the setting (string, number, boolean, or array)' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'notification_send',
    description: 'Send a desktop notification via Claude Terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body text' },
        type: { type: 'string', enum: ['info', 'success', 'warning', 'error'], description: 'Notification type (default: info)' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'app_info',
    description: 'Get Claude Terminal app info: version, platform, uptime, data directory, project count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'settings_get') {
      const settings = loadSettings();
      const allKeys = new Set([...KNOWN_SETTINGS, ...READONLY_SETTINGS]);

      if (args.key) {
        const key = args.key;
        if (!allKeys.has(key)) {
          return fail(`Unknown setting key "${key}". Use settings_get without a key to see all available settings.`);
        }
        const value = settings[key];
        const ro = READONLY_SETTINGS.has(key) ? ' (read-only)' : '';
        return ok(`${key}: ${formatSettingValue(key, value)}${ro}`);
      }

      // Return all settings grouped by category
      const lines = [];
      for (const key of KNOWN_SETTINGS) {
        const value = settings[key];
        lines.push(`  ${key}: ${formatSettingValue(key, value)}`);
      }
      if (READONLY_SETTINGS.size > 0) {
        lines.push('');
        lines.push('Read-only settings:');
        for (const key of READONLY_SETTINGS) {
          const value = settings[key];
          lines.push(`  ${key}: ${formatSettingValue(key, value)}`);
        }
      }

      return ok(`Claude Terminal Settings:\n${'─'.repeat(40)}\n${lines.join('\n')}`);
    }

    if (name === 'settings_set') {
      if (!args.key) return fail('Missing required parameter: key');
      if (args.value === undefined) return fail('Missing required parameter: value');

      const key = args.key;
      if (READONLY_SETTINGS.has(key)) {
        return fail(`Setting "${key}" is read-only and cannot be modified via MCP. Change it in the Claude Terminal settings UI.`);
      }
      if (!KNOWN_SETTINGS.has(key)) {
        return fail(`Unknown setting key "${key}". Use settings_get without a key to see all available settings.`);
      }

      const settings = loadSettings();
      const oldValue = settings[key];
      settings[key] = args.value;
      saveSettings(settings);

      // Write trigger file so the app knows to reload settings
      const triggerDir = path.join(getDataDir(), 'settings', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `${key}_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        key,
        value: args.value,
        previousValue: oldValue,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok(`Setting "${key}" updated: ${formatSettingValue(key, oldValue)} → ${formatSettingValue(key, args.value)}`);
    }

    if (name === 'notification_send') {
      if (!args.title) return fail('Missing required parameter: title');
      if (!args.body) return fail('Missing required parameter: body');

      const type = args.type || 'info';
      const validTypes = ['info', 'success', 'warning', 'error'];
      if (!validTypes.includes(type)) {
        return fail(`Invalid notification type "${type}". Valid types: ${validTypes.join(', ')}`);
      }

      const triggerDir = path.join(getDataDir(), 'notifications', 'triggers');
      if (!fs.existsSync(triggerDir)) fs.mkdirSync(triggerDir, { recursive: true });

      const triggerFile = path.join(triggerDir, `notification_${Date.now()}.json`);
      fs.writeFileSync(triggerFile, JSON.stringify({
        title: args.title,
        body: args.body,
        type,
        source: 'mcp',
        timestamp: new Date().toISOString(),
      }), 'utf8');

      return ok(`Notification sent: [${type.toUpperCase()}] ${args.title}`);
    }

    if (name === 'app_info') {
      // Read version from package.json
      let version = 'unknown';
      try {
        const pkgPath = path.join(__dirname, '..', '..', 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          version = pkg.version || 'unknown';
        }
      } catch (e) {
        log('Error reading package.json:', e.message);
      }

      // Count projects
      const data = loadProjects();
      const projectCount = (data.projects || []).length;
      const folderCount = (data.folders || []).length;

      const dataDir = getDataDir();
      const uptime = formatUptime(process.uptime());

      let output = `# Claude Terminal\n`;
      output += `${'─'.repeat(40)}\n`;
      output += `  Version: ${version}\n`;
      output += `  Platform: ${process.platform}\n`;
      output += `  Arch: ${process.arch}\n`;
      output += `  Node: ${process.version}\n`;
      output += `  Uptime: ${uptime}\n`;
      output += `  Data dir: ${dataDir || '(not set)'}\n`;
      output += `  Projects: ${projectCount}\n`;
      output += `  Folders: ${folderCount}\n`;

      return ok(output);
    }

    return fail(`Unknown settings tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Settings error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
