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
    chmodSync: jest.fn(),
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

// The service defines 19 hook definitions
const TOTAL_HOOKS = 19;

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

// ─── Node availability ───────────────────────────────────────────────────────
// findNodeOnPath() walks process.env.PATH with fs.existsSync, which the mock
// above backs with the virtual filesystem. Tests therefore control the answer
// exactly, instead of inheriting whatever the CI machine happens to have.

const FAKE_PATH_DIR = process.platform === 'win32' ? 'C:\\fake\\bin' : '/fake/bin';
const FAKE_NODE = path.join(FAKE_PATH_DIR, process.platform === 'win32' ? 'node.exe' : 'node');

const realPath = process.env.PATH;

/** Make an external `node` discoverable for the current test. */
function giveNode() {
  process.env.PATH = FAKE_PATH_DIR;
  mockVirtualFs.set(FAKE_NODE, '');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVirtualFs.clear();
  // Ensure the handler script "exists" so verifyAndRepairHooks works
  mockVirtualFs.set(HANDLER_PATH, '// handler script');
  // Default to node being absent, so the launcher path is the exercised one
  // unless a test opts in with giveNode().
  process.env.PATH = FAKE_PATH_DIR;
});

afterAll(() => {
  process.env.PATH = realPath;
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

  test('corrupted settings.json is refused, not overwritten', () => {
    // Regression guard: this previously returned success and replaced the
    // user's entire settings.json with a hooks-only file, destroying their
    // permissions / env / model / statusLine.
    mockVirtualFs.set(SETTINGS_PATH, '{invalid json!!!');

    const result = HooksService.installHooks();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/malformed|unreadable/i);

    // Original bytes untouched, so the user can still recover their config
    expect(mockVirtualFs.get(SETTINGS_PATH)).toBe('{invalid json!!!');
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

  test('hook command runs the handler through node when node is available', () => {
    giveNode();
    HooksService.installHooks();
    const settings = readSettings();

    const entry = settings.hooks.PreToolUse.find(e => isOurHookEntry(e));
    expect(entry.hooks[0].type).toBe('command');
    expect(entry.hooks[0].command).toContain('node "');
    expect(entry.hooks[0].command).toContain(HOOK_IDENTIFIER);
    expect(entry.hooks[0].command).toContain('.js');
    expect(entry.hooks[0].command.endsWith(' PreToolUse')).toBe(true);
  });
});

// ==================== node runtime resolution (issue #76) ====================

describe('hook runtime resolution', () => {
  test('finds node on PATH when present', () => {
    giveNode();
    expect(HooksService.findNodeOnPath()).toBe(FAKE_NODE);
  });

  test('returns null when node is nowhere on PATH', () => {
    expect(HooksService.findNodeOnPath()).toBeNull();
  });

  test('an unset PATH is survivable rather than throwing', () => {
    delete process.env.PATH;
    expect(HooksService.findNodeOnPath()).toBeNull();
  });

  test('without node the hooks point at the generated launcher, not at node', () => {
    HooksService.installHooks();
    const command = readSettings().hooks.PreToolUse.find(e => isOurHookEntry(e)).hooks[0].command;

    // The whole point of issue #76: no dependency on an external interpreter.
    expect(command.startsWith('node ')).toBe(false);
    expect(command).toContain(HOOK_IDENTIFIER);
    expect(command.endsWith(' PreToolUse')).toBe(true);
  });

  test('the launcher is named so that isOurHook still recognises the entry', () => {
    // A launcher named anything else would make our own hooks invisible to
    // the installer, which dedups by this substring, and they would pile up.
    expect(HooksService.getLauncherPath()).toContain(HOOK_IDENTIFIER);
  });

  test('installing without node writes the launcher before settings.json', () => {
    HooksService.installHooks();
    const launcher = mockVirtualFs.get(HooksService.getLauncherPath());

    expect(launcher).toBeDefined();
    expect(launcher).toContain('ELECTRON_RUN_AS_NODE=1');
    // The handler must be invoked with the hook name forwarded through.
    expect(launcher).toContain(HOOK_IDENTIFIER + '.js');
    expect(launcher).toMatch(process.platform === 'win32' ? /%1/ : /\$1/);
  });

  test('installing with node available does not write a launcher', () => {
    giveNode();
    HooksService.installHooks();
    expect(mockVirtualFs.has(HooksService.getLauncherPath())).toBe(false);
  });

  test('the POSIX launcher execs so the handler exit code survives', () => {
    if (process.platform === 'win32') return;
    HooksService.installHooks();
    const launcher = mockVirtualFs.get(HooksService.getLauncherPath());

    // PermissionRequest encodes allow/deny as exit 0/2. A launcher that ran
    // the handler as a child without exec could swallow that.
    expect(launcher.startsWith('#!/bin/sh')).toBe(true);
    expect(launcher).toContain('exec "');
  });

  test('a missing launcher is regenerated by the integrity check', () => {
    HooksService.installHooks();
    mockVirtualFs.delete(HooksService.getLauncherPath());

    const result = HooksService.verifyAndRepairHooks();
    expect(result.repaired).toBe(true);
    expect(mockVirtualFs.has(HooksService.getLauncherPath())).toBe(true);
  });

  test('hooks written for one runtime are rewritten when the runtime changes', () => {
    // Installed while node was missing...
    HooksService.installHooks();
    const before = readSettings().hooks.PreToolUse.find(e => isOurHookEntry(e)).hooks[0].command;
    expect(before.startsWith('node ')).toBe(false);

    // ...then the user installs node. The stale launcher command must go.
    giveNode();
    const result = HooksService.verifyAndRepairHooks();
    expect(result.repaired).toBe(true);

    const after = readSettings().hooks.PreToolUse.find(e => isOurHookEntry(e)).hooks[0].command;
    expect(after.startsWith('node "')).toBe(true);
  });

  test('switching runtime does not leave a duplicate hook behind', () => {
    HooksService.installHooks();
    giveNode();
    HooksService.verifyAndRepairHooks();

    const ours = readSettings().hooks.PreToolUse.filter(e => isOurHookEntry(e));
    expect(ours).toHaveLength(1);
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
