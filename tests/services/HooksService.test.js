// HooksService unit tests — manages Claude hooks in ~/.claude/settings.json
//
// Strategy: mock `fs` at module level so HooksService reads/writes to a
// virtual filesystem controlled by tests. This avoids issues with
// CLAUDE_SETTINGS_PATH being a module-level constant derived from os.homedir().

const path = require('path');
const os = require('os');

// ─── Virtual filesystem ─────────────────────────────────────────────────────
// Store file contents keyed by path. Only the paths HooksService touches.
const mockVirtualFs = new Map();

jest.mock('fs', () => {
  const realFs = jest.requireActual('fs');
  return {
    ...realFs,
    existsSync: jest.fn((p) => mockVirtualFs.has(p)),
    readFileSync: jest.fn((p, enc) => {
      if (!mockVirtualFs.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return mockVirtualFs.get(p);
    }),
    writeFileSync: jest.fn((p, data) => {
      mockVirtualFs.set(p, typeof data === 'string' ? data : data.toString());
    }),
    copyFileSync: jest.fn((src, dest) => {
      if (mockVirtualFs.has(src)) {
        mockVirtualFs.set(dest, mockVirtualFs.get(src));
      }
    }),
    mkdirSync: jest.fn(),
  };
});

// Mock electron
jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app',
  }
}));

const HooksService = require('../../src/main/services/HooksService');

// ─── Test constants ──────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP_PATH = path.join(os.homedir(), '.claude', 'settings.pre-hooks.json');
const HOOK_IDENTIFIER = 'claude-terminal-hook-handler';
const HANDLER_PATH = path.join('/mock/app', 'resources', 'hooks', 'claude-terminal-hook-handler.js');

// The service defines 18 hook definitions
const TOTAL_HOOKS = 18;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeSettings(data) {
  mockVirtualFs.set(SETTINGS_PATH, JSON.stringify(data, null, 2));
}

function readSettings() {
  return JSON.parse(mockVirtualFs.get(SETTINGS_PATH));
}

function isOurHookEntry(entry) {
  if (!entry || !entry.hooks) return false;
  return entry.hooks.some(h => h.type === 'command' && h.command && h.command.includes(HOOK_IDENTIFIER));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVirtualFs.clear();
  // Ensure the handler script "exists" so verifyAndRepairHooks works
  mockVirtualFs.set(HANDLER_PATH, '// handler script');
});

// ==================== installHooks ====================

describe('installHooks', () => {
  test('fresh install (no existing settings.json) creates file with hooks', () => {
    const result = HooksService.installHooks();
    expect(result.success).toBe(true);
    expect(mockVirtualFs.has(SETTINGS_PATH)).toBe(true);

    const settings = readSettings();
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks).length).toBe(TOTAL_HOOKS);

    for (const key of Object.keys(settings.hooks)) {
      const arr = settings.hooks[key];
      expect(Array.isArray(arr)).toBe(true);
      expect(arr.some(e => isOurHookEntry(e))).toBe(true);
    }
  });

  test('existing settings.json without hooks adds hooks section', () => {
    writeSettings({ someOtherSetting: true });

    const result = HooksService.installHooks();
    expect(result.success).toBe(true);

    const settings = readSettings();
    expect(settings.someOtherSetting).toBe(true);
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks).length).toBe(TOTAL_HOOKS);
  });

  test('existing settings.json with user hooks preserves them', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo "user hook"' }],
      matcher: ''
    };
    writeSettings({
      hooks: {
        PreToolUse: [userHook]
      }
    });

    const result = HooksService.installHooks();
    expect(result.success).toBe(true);

    const settings = readSettings();
    const preToolUse = settings.hooks.PreToolUse;
    expect(Array.isArray(preToolUse)).toBe(true);
    expect(preToolUse.length).toBe(2);

    // User hook preserved
    const userHookStillPresent = preToolUse.some(e =>
      e.hooks?.some(h => h.command === 'echo "user hook"')
    );
    expect(userHookStillPresent).toBe(true);

    // Our hook added
    expect(preToolUse.some(e => isOurHookEntry(e))).toBe(true);
  });

  test('already installed is idempotent (replaces old entry)', () => {
    HooksService.installHooks();
    const result = HooksService.installHooks();
    expect(result.success).toBe(true);

    const settings = readSettings();
    for (const key of Object.keys(settings.hooks)) {
      const arr = settings.hooks[key];
      const ourCount = arr.filter(e => isOurHookEntry(e)).length;
      expect(ourCount).toBe(1);
    }
  });

  test('creates backup file before modifying', () => {
    writeSettings({ existing: true });

    HooksService.installHooks();

    expect(mockVirtualFs.has(BACKUP_PATH)).toBe(true);
    const backup = JSON.parse(mockVirtualFs.get(BACKUP_PATH));
    expect(backup.existing).toBe(true);
  });

  test('corrupted settings.json is handled gracefully', () => {
    mockVirtualFs.set(SETTINGS_PATH, '{invalid json!!!');

    const result = HooksService.installHooks();
    expect(result.success).toBe(true);

    const settings = readSettings();
    expect(settings.hooks).toBeDefined();
  });

  test('handles existing hooks as non-array (object) format', () => {
    const singleHookEntry = {
      hooks: [{ type: 'command', command: 'echo "single"' }],
      matcher: ''
    };
    writeSettings({
      hooks: {
        PreToolUse: singleHookEntry
      }
    });

    const result = HooksService.installHooks();
    expect(result.success).toBe(true);

    const settings = readSettings();
    const preToolUse = settings.hooks.PreToolUse;
    expect(Array.isArray(preToolUse)).toBe(true);
    expect(preToolUse.some(e => isOurHookEntry(e))).toBe(true);
    const userPresent = preToolUse.some(e =>
      e.hooks?.some(h => h.command === 'echo "single"')
    );
    expect(userPresent).toBe(true);
  });

  test('hook entries include matcher for hasMatcher hooks', () => {
    HooksService.installHooks();
    const settings = readSettings();

    // PreToolUse has hasMatcher: true
    const preToolUse = settings.hooks.PreToolUse;
    const ourEntry = preToolUse.find(e => isOurHookEntry(e));
    expect(ourEntry.matcher).toBe('');

    // UserPromptSubmit has hasMatcher: false
    const userPrompt = settings.hooks.UserPromptSubmit;
    const ourPromptEntry = userPrompt.find(e => isOurHookEntry(e));
    expect(ourPromptEntry.matcher).toBeUndefined();
  });

  test('hook command includes handler path', () => {
    HooksService.installHooks();
    const settings = readSettings();

    const entry = settings.hooks.PreToolUse.find(e => isOurHookEntry(e));
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toContain('node');
    expect(entry.hooks[0].command).toContain(HOOK_IDENTIFIER);
  });
});

// ==================== removeHooks ====================

describe('removeHooks', () => {
  test('removes only our hooks, preserves user hooks', () => {
    const userHook = {
      hooks: [{ type: 'command', command: 'echo "user"' }],
      matcher: ''
    };
    writeSettings({
      hooks: {
        PreToolUse: [userHook]
      }
    });

    HooksService.installHooks();
    const result = HooksService.removeHooks();
    expect(result.success).toBe(true);

    const settings = readSettings();
    expect(settings.hooks.PreToolUse).toBeDefined();
    const userPresent = settings.hooks.PreToolUse.some(e =>
      e.hooks?.some(h => h.command === 'echo "user"')
    );
    expect(userPresent).toBe(true);

    for (const key of Object.keys(settings.hooks)) {
      const arr = Array.isArray(settings.hooks[key]) ? settings.hooks[key] : [settings.hooks[key]];
      expect(arr.some(e => isOurHookEntry(e))).toBe(false);
    }
  });

  test('no hooks installed is a no-op', () => {
    writeSettings({ someKey: 'value' });

    const result = HooksService.removeHooks();
    expect(result.success).toBe(true);

    const settings = readSettings();
    expect(settings.someKey).toBe('value');
  });

  test('missing settings.json is a no-op', () => {
    const result = HooksService.removeHooks();
    expect(result.success).toBe(true);
  });

  test('removes empty hooks object after removing all hooks', () => {
    HooksService.installHooks();
    HooksService.removeHooks();

    const settings = readSettings();
    expect(settings.hooks).toBeUndefined();
  });

  test('removes hook keys with no remaining entries', () => {
    HooksService.installHooks();
    const settingsBefore = readSettings();
    expect(Object.keys(settingsBefore.hooks).length).toBe(TOTAL_HOOKS);

    HooksService.removeHooks();
    const settingsAfter = readSettings();
    expect(settingsAfter.hooks).toBeUndefined();
  });

  test('handles non-array format during removal', () => {
    HooksService.installHooks();
    const settings = readSettings();
    // Convert to non-array
    settings.hooks.PreToolUse = settings.hooks.PreToolUse[0];
    writeSettings(settings);

    const result = HooksService.removeHooks();
    expect(result.success).toBe(true);
  });
});

// ==================== areHooksInstalled ====================

describe('areHooksInstalled', () => {
  test('all hooks present returns installed true with correct count', () => {
    HooksService.installHooks();

    const status = HooksService.areHooksInstalled();
    expect(status.installed).toBe(true);
    expect(status.count).toBe(TOTAL_HOOKS);
  });

  test('no hooks returns installed false, count 0', () => {
    writeSettings({});

    const status = HooksService.areHooksInstalled();
    expect(status.installed).toBe(false);
    expect(status.count).toBe(0);
  });

  test('partial hooks returns installed false with partial count', () => {
    HooksService.installHooks();
    const settings = readSettings();
    delete settings.hooks.PreToolUse;
    writeSettings(settings);

    const status = HooksService.areHooksInstalled();
    expect(status.installed).toBe(false);
    expect(status.count).toBe(TOTAL_HOOKS - 1);
  });

  test('settings.json does not exist returns not installed', () => {
    const status = HooksService.areHooksInstalled();
    expect(status.installed).toBe(false);
    expect(status.count).toBe(0);
  });

  test('corrupted settings.json returns not installed', () => {
    mockVirtualFs.set(SETTINGS_PATH, 'not json');

    const status = HooksService.areHooksInstalled();
    expect(status.installed).toBe(false);
    expect(status.count).toBe(0);
  });

  test('handles hooks as non-array format', () => {
    HooksService.installHooks();
    const settings = readSettings();
    settings.hooks.PreToolUse = settings.hooks.PreToolUse[0];
    writeSettings(settings);

    const status = HooksService.areHooksInstalled();
    expect(status.count).toBeGreaterThan(0);
  });
});

// ==================== verifyAndRepairHooks ====================

describe('verifyAndRepairHooks', () => {
  test('all hooks present and correct returns ok true, repaired false', () => {
    HooksService.installHooks();

    const result = HooksService.verifyAndRepairHooks();
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(false);
  });

  test('missing hooks are reinstalled', () => {
    HooksService.installHooks();
    const settings = readSettings();
    delete settings.hooks.PreToolUse;
    delete settings.hooks.PostToolUse;
    writeSettings(settings);

    const result = HooksService.verifyAndRepairHooks();
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    expect(result.details).toContain('missing');

    const after = HooksService.areHooksInstalled();
    expect(after.installed).toBe(true);
  });

  test('no hooks at all triggers full reinstall', () => {
    writeSettings({});

    const result = HooksService.verifyAndRepairHooks();
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);

    const status = HooksService.areHooksInstalled();
    expect(status.installed).toBe(true);
  });

  test('handler script missing returns not ok', () => {
    // Remove handler from virtual fs
    mockVirtualFs.delete(HANDLER_PATH);
    HooksService.installHooks();

    const result = HooksService.verifyAndRepairHooks();
    expect(result.ok).toBe(false);
    expect(result.repaired).toBe(false);
    expect(result.details).toContain('Handler script missing');
  });

  test('returns repaired when stale paths are detected', () => {
    HooksService.installHooks();

    // Manually set a hook with a different (stale) path
    const settings = readSettings();
    const staleEntry = {
      hooks: [{ type: 'command', command: 'node "/old/path/claude-terminal-hook-handler.js" PreToolUse' }],
      matcher: ''
    };
    settings.hooks.PreToolUse = [staleEntry];
    writeSettings(settings);

    const result = HooksService.verifyAndRepairHooks();
    expect(result.repaired).toBe(true);
    expect(result.details).toContain('stale path');
  });
});

// ==================== Integration scenarios ====================

describe('install/remove/verify lifecycle', () => {
  test('full lifecycle: install -> verify -> remove -> verify', () => {
    const installResult = HooksService.installHooks();
    expect(installResult.success).toBe(true);

    const verifyResult = HooksService.areHooksInstalled();
    expect(verifyResult.installed).toBe(true);

    const removeResult = HooksService.removeHooks();
    expect(removeResult.success).toBe(true);

    const verifyAfter = HooksService.areHooksInstalled();
    expect(verifyAfter.installed).toBe(false);
    expect(verifyAfter.count).toBe(0);
  });

  test('multiple installs do not duplicate hooks', () => {
    HooksService.installHooks();
    HooksService.installHooks();
    HooksService.installHooks();

    const settings = readSettings();
    for (const key of Object.keys(settings.hooks)) {
      const arr = settings.hooks[key];
      const ourCount = arr.filter(e => isOurHookEntry(e)).length;
      expect(ourCount).toBe(1);
    }
  });

  test('install preserves non-hooks settings', () => {
    writeSettings({
      permissions: { allow: ['Read', 'Write'] },
      systemPrompt: 'Be helpful',
      customKey: 42
    });

    HooksService.installHooks();
    const settings = readSettings();

    expect(settings.permissions).toEqual({ allow: ['Read', 'Write'] });
    expect(settings.systemPrompt).toBe('Be helpful');
    expect(settings.customKey).toBe(42);
    expect(settings.hooks).toBeDefined();
  });

  test('remove preserves non-hooks settings', () => {
    writeSettings({
      permissions: { allow: ['Read'] },
      other: 'data'
    });

    HooksService.installHooks();
    HooksService.removeHooks();

    const settings = readSettings();
    expect(settings.permissions).toEqual({ allow: ['Read'] });
    expect(settings.other).toBe('data');
  });
});
