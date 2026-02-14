/**
 * HooksService
 * Manages Claude Code CLI hooks installation in ~/.claude/settings.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const CLAUDE_SETTINGS_BACKUP_PATH = path.join(os.homedir(), '.claude', 'settings.pre-hooks.json');

// Identifier used to detect our hooks in the config
const HOOK_IDENTIFIER = 'claude-terminal-hook-handler';

// Path to the bundled hook handler script
function getHandlerPath() {
  return path.join(app.getAppPath(), 'resources', 'hooks', 'claude-terminal-hook-handler.js');
}

/**
 * All hooks to install.
 * Hooks with matcher support use matcher: "" (match all).
 * Hooks without matcher support omit the matcher field.
 */
const HOOK_DEFINITIONS = [
  { key: 'PreToolUse', hasMatcher: true },
  { key: 'PostToolUse', hasMatcher: true },
  { key: 'PostToolUseFailure', hasMatcher: true },
  { key: 'Notification', hasMatcher: true },
  { key: 'UserPromptSubmit', hasMatcher: false },
  { key: 'SessionStart', hasMatcher: true },
  { key: 'Stop', hasMatcher: false },
  { key: 'SubagentStart', hasMatcher: true },
  { key: 'SubagentStop', hasMatcher: true },
  { key: 'PreCompact', hasMatcher: true },
  { key: 'SessionEnd', hasMatcher: true },
  { key: 'PermissionRequest', hasMatcher: true },
  { key: 'Setup', hasMatcher: true },
  { key: 'TeammateIdle', hasMatcher: false },
  { key: 'TaskCompleted', hasMatcher: false }
];

/**
 * Read Claude settings.json safely
 * @returns {Object}
 */
function readClaudeSettings() {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to read Claude settings:', e);
  }
  return {};
}

/**
 * Write Claude settings.json
 * @param {Object} settings
 */
function writeClaudeSettings(settings) {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/**
 * Create a backup of current Claude settings
 */
function backupSettings() {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      fs.copyFileSync(CLAUDE_SETTINGS_PATH, CLAUDE_SETTINGS_BACKUP_PATH);
    }
  } catch (e) {
    console.error('Failed to backup Claude settings:', e);
  }
}

/**
 * Build a hook entry for a given hook definition
 * @param {Object} hookDef
 * @returns {Object}
 */
function buildHookEntry(hookDef) {
  const handlerPath = getHandlerPath().replace(/\\/g, '/');
  const entry = {
    hooks: [
      {
        type: 'command',
        command: `node "${handlerPath}" ${hookDef.key}`
      }
    ]
  };
  if (hookDef.hasMatcher) {
    entry.matcher = '';
  }
  return entry;
}

/**
 * Check if a hook entry is one of ours
 * @param {Object} hookEntry
 * @returns {boolean}
 */
function isOurHook(hookEntry) {
  if (!hookEntry || !hookEntry.hooks) return false;
  return hookEntry.hooks.some(h =>
    h.type === 'command' && h.command && h.command.includes(HOOK_IDENTIFIER)
  );
}

/**
 * Install Claude Terminal hooks into ~/.claude/settings.json
 * Non-destructive: appends alongside existing user hooks
 * @returns {{ success: boolean, error?: string }}
 */
function installHooks() {
  try {
    const settings = readClaudeSettings();

    // Create backup before modifying
    backupSettings();

    // Ensure hooks object exists
    if (!settings.hooks) {
      settings.hooks = {};
    }

    for (const hookDef of HOOK_DEFINITIONS) {
      const hookKey = hookDef.key;
      const newEntry = buildHookEntry(hookDef);

      if (!settings.hooks[hookKey]) {
        // No existing hooks for this key - create array with our entry
        settings.hooks[hookKey] = [newEntry];
      } else {
        // Existing hooks - check if ours is already there
        const existing = settings.hooks[hookKey];
        const arr = Array.isArray(existing) ? existing : [existing];

        // Remove any existing hooks of ours (to update path if changed)
        const filtered = arr.filter(entry => !isOurHook(entry));

        // Append our hook
        filtered.push(newEntry);
        settings.hooks[hookKey] = filtered;
      }
    }

    writeClaudeSettings(settings);
    return { success: true };
  } catch (e) {
    console.error('Failed to install hooks:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Remove Claude Terminal hooks from ~/.claude/settings.json
 * Only removes our hooks (detected by HOOK_IDENTIFIER in command string)
 * @returns {{ success: boolean, error?: string }}
 */
function removeHooks() {
  try {
    const settings = readClaudeSettings();

    if (!settings.hooks) {
      return { success: true };
    }

    for (const hookDef of HOOK_DEFINITIONS) {
      const hookKey = hookDef.key;
      if (!settings.hooks[hookKey]) continue;

      const existing = settings.hooks[hookKey];
      const arr = Array.isArray(existing) ? existing : [existing];

      // Filter out our hooks
      const filtered = arr.filter(entry => !isOurHook(entry));

      if (filtered.length === 0) {
        // No hooks left for this key - remove the key entirely
        delete settings.hooks[hookKey];
      } else {
        settings.hooks[hookKey] = filtered;
      }
    }

    // Remove empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeClaudeSettings(settings);
    return { success: true };
  } catch (e) {
    console.error('Failed to remove hooks:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Check if our hooks are currently installed
 * @returns {{ installed: boolean, count: number }}
 */
function areHooksInstalled() {
  try {
    const settings = readClaudeSettings();

    if (!settings.hooks) {
      return { installed: false, count: 0 };
    }

    let count = 0;
    for (const hookDef of HOOK_DEFINITIONS) {
      const hookKey = hookDef.key;
      if (!settings.hooks[hookKey]) continue;

      const existing = settings.hooks[hookKey];
      const arr = Array.isArray(existing) ? existing : [existing];

      if (arr.some(entry => isOurHook(entry))) {
        count++;
      }
    }

    return {
      installed: count === HOOK_DEFINITIONS.length,
      count
    };
  } catch (e) {
    console.error('Failed to check hooks status:', e);
    return { installed: false, count: 0 };
  }
}

/**
 * Verify hooks integrity and repair if needed.
 * Checks:
 * 1. Handler script exists at expected path
 * 2. All 15 hooks are present in ~/.claude/settings.json
 * 3. Paths in hooks match current app location (handles app move/update)
 * Silently reinstalls if anything is wrong.
 * @returns {{ ok: boolean, repaired: boolean, details?: string }}
 */
function verifyAndRepairHooks() {
  try {
    const handlerPath = getHandlerPath();
    const expectedCommand = `node "${handlerPath.replace(/\\/g, '/')}"`;

    // 1. Check handler script exists
    const handlerExists = fs.existsSync(handlerPath);
    if (!handlerExists) {
      return { ok: false, repaired: false, details: 'Handler script missing: ' + handlerPath };
    }

    // 2. Read current hooks from Claude settings
    const settings = readClaudeSettings();
    if (!settings.hooks) {
      // No hooks at all — reinstall
      const result = installHooks();
      return { ok: result.success, repaired: result.success, details: 'No hooks found, reinstalled' };
    }

    // 3. Check each hook: present + correct path
    let missingCount = 0;
    let stalePathCount = 0;

    for (const hookDef of HOOK_DEFINITIONS) {
      const hookKey = hookDef.key;
      const arr = settings.hooks[hookKey];
      if (!arr) {
        missingCount++;
        continue;
      }

      const entries = Array.isArray(arr) ? arr : [arr];
      const ourEntry = entries.find(entry => isOurHook(entry));

      if (!ourEntry) {
        missingCount++;
        continue;
      }

      // Check path is current (app may have moved)
      const cmd = ourEntry.hooks[0].command;
      if (!cmd.includes(expectedCommand)) {
        stalePathCount++;
      }
    }

    if (missingCount === 0 && stalePathCount === 0) {
      return { ok: true, repaired: false };
    }

    // Something is wrong — reinstall (installHooks removes old + adds fresh)
    const result = installHooks();
    const details = [];
    if (missingCount > 0) details.push(`${missingCount} hooks missing`);
    if (stalePathCount > 0) details.push(`${stalePathCount} hooks with stale path`);

    return {
      ok: result.success,
      repaired: result.success,
      details: details.join(', ') + ' — reinstalled'
    };
  } catch (e) {
    console.error('Failed to verify hooks:', e);
    return { ok: false, repaired: false, details: e.message };
  }
}

module.exports = {
  installHooks,
  removeHooks,
  areHooksInstalled,
  verifyAndRepairHooks
};
