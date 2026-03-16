const {
  settingsState,
  getEditorCommand,
  EDITOR_OPTIONS,
  getSettings,
  getSetting,
  updateSettings,
  setSetting,
  loadSettings,
  saveSettings,
  saveSettingsImmediate,
  resetSettings,
  isNotificationsEnabled,
  toggleNotifications,
  onSaveFlush
} = require('../../src/renderer/state/settings.state');

describe('getEditorCommand', () => {
  test('"code" returns "code"', () => {
    expect(getEditorCommand('code')).toBe('code');
  });

  test('"cursor" returns "cursor"', () => {
    expect(getEditorCommand('cursor')).toBe('cursor');
  });

  test('"webstorm" returns "webstorm"', () => {
    expect(getEditorCommand('webstorm')).toBe('webstorm');
  });

  test('"idea" returns "idea"', () => {
    expect(getEditorCommand('idea')).toBe('idea');
  });

  test('unknown editor falls back to "code"', () => {
    expect(getEditorCommand('unknown')).toBe('code');
  });

  test('null falls back to "code"', () => {
    expect(getEditorCommand(null)).toBe('code');
  });
});

describe('EDITOR_OPTIONS', () => {
  test('has 4 items', () => {
    expect(EDITOR_OPTIONS).toHaveLength(4);
  });

  test('each item has value and label', () => {
    EDITOR_OPTIONS.forEach(opt => {
      expect(opt).toHaveProperty('value');
      expect(opt).toHaveProperty('label');
      expect(typeof opt.value).toBe('string');
      expect(typeof opt.label).toBe('string');
    });
  });
});

describe('getSettings', () => {
  test('returns an object with default keys', () => {
    const settings = getSettings();
    expect(settings).toHaveProperty('editor');
    expect(settings).toHaveProperty('accentColor');
    expect(settings).toHaveProperty('language');
    expect(settings).toHaveProperty('notificationsEnabled');
    expect(settings).toHaveProperty('closeAction');
    expect(settings).toHaveProperty('compactProjects');
    expect(settings).toHaveProperty('customPresets');
  });
});

describe('getSetting', () => {
  test('editor defaults to "code"', () => {
    expect(getSetting('editor')).toBe('code');
  });

  test('accentColor defaults to "#d97706"', () => {
    expect(getSetting('accentColor')).toBe('#d97706');
  });

  test('notificationsEnabled defaults to true', () => {
    expect(getSetting('notificationsEnabled')).toBe(true);
  });

  test('unknown key returns undefined', () => {
    expect(getSetting('nonexistent')).toBeUndefined();
  });

  test('shortcut default is a string containing Shift+P', () => {
    const shortcut = getSetting('shortcut');
    expect(typeof shortcut).toBe('string');
    expect(shortcut).toContain('Shift+P');
  });

  test('shortcut default uses Ctrl or Cmd prefix', () => {
    const shortcut = getSetting('shortcut');
    const hasValidPrefix = shortcut.startsWith('Ctrl+') || shortcut.startsWith('Cmd+');
    expect(hasValidPrefix).toBe(true);
  });

  test('defaultTerminalMode defaults to "terminal"', () => {
    expect(getSetting('defaultTerminalMode')).toBe('terminal');
  });

  test('chatModel defaults to null', () => {
    expect(getSetting('chatModel')).toBeNull();
  });
});

// ── New tests below ──

// Helper to store and restore defaults between tests
const defaultSettingsSnapshot = { ...getSettings() };

function resetSettingsState() {
  settingsState.set({ ...defaultSettingsSnapshot });
}

// ── loadSettings ──

describe('loadSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSettingsState();
  });

  test('loads valid JSON from settings file', async () => {
    window.electron_nodeModules.fs.existsSync.mockReturnValue(true);
    window.electron_nodeModules.fs.promises.readFile.mockResolvedValue(
      JSON.stringify({ editor: 'cursor', accentColor: '#ff0000' })
    );

    await loadSettings();

    expect(getSetting('editor')).toBe('cursor');
    expect(getSetting('accentColor')).toBe('#ff0000');
  });

  test('merges saved settings with defaults', async () => {
    window.electron_nodeModules.fs.existsSync.mockReturnValue(true);
    window.electron_nodeModules.fs.promises.readFile.mockResolvedValue(
      JSON.stringify({ editor: 'webstorm' })
    );

    await loadSettings();

    // Custom value loaded
    expect(getSetting('editor')).toBe('webstorm');
    // Default value preserved
    expect(getSetting('notificationsEnabled')).toBe(true);
    expect(getSetting('accentColor')).toBe('#d97706');
  });

  test('handles missing file gracefully', async () => {
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);

    await loadSettings();
    // Defaults should remain
    expect(getSetting('editor')).toBe('code');
  });

  test('handles corrupted JSON — falls back to backup', async () => {
    window.electron_nodeModules.fs.existsSync
      .mockReturnValueOnce(true) // settings file exists
      .mockReturnValueOnce(true); // backup file exists
    window.electron_nodeModules.fs.promises.readFile
      .mockRejectedValueOnce(new Error('Parse error')) // main file fails
      .mockResolvedValueOnce(JSON.stringify({ editor: 'idea' })); // backup works

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await loadSettings();

    expect(getSetting('editor')).toBe('idea');
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  test('handles corrupted main and backup gracefully', async () => {
    window.electron_nodeModules.fs.existsSync
      .mockReturnValueOnce(true) // settings file exists
      .mockReturnValueOnce(true); // backup file exists
    window.electron_nodeModules.fs.promises.readFile
      .mockRejectedValueOnce(new Error('Parse error'))
      .mockRejectedValueOnce(new Error('Backup also corrupt'));

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await loadSettings();
    // Should not throw — defaults remain
    expect(getSetting('editor')).toBeDefined();
    consoleSpy.mockRestore();
  });

  test('handles empty file content', async () => {
    window.electron_nodeModules.fs.existsSync.mockReturnValue(true);
    window.electron_nodeModules.fs.promises.readFile.mockResolvedValue('   ');

    await loadSettings();
    // Defaults should remain
    expect(getSetting('editor')).toBe('code');
  });
});

// ── saveSettings / saveSettingsImmediate ──

describe('saveSettingsImmediate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetSettingsState();
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
    window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.renameSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.copyFileSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.unlinkSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('writes settings JSON to temp file', () => {
    saveSettingsImmediate();
    expect(window.electron_nodeModules.fs.writeFileSync).toHaveBeenCalled();
    const callArgs = window.electron_nodeModules.fs.writeFileSync.mock.calls[0];
    expect(callArgs[0]).toContain('.tmp');
    const written = JSON.parse(callArgs[1]);
    expect(written.editor).toBe('code');
  });

  test('renames temp file to settings file', () => {
    saveSettingsImmediate();
    expect(window.electron_nodeModules.fs.renameSync).toHaveBeenCalled();
  });

  test('backs up existing file before writing', () => {
    window.electron_nodeModules.fs.existsSync.mockReturnValue(true);
    saveSettingsImmediate();
    expect(window.electron_nodeModules.fs.copyFileSync).toHaveBeenCalled();
  });

  test('notifies save listeners on success', () => {
    const listener = jest.fn();
    const unsub = onSaveFlush(listener);
    saveSettingsImmediate();
    expect(listener).toHaveBeenCalledWith({ success: true });
    unsub();
  });

  test('notifies save listeners on error', () => {
    window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {
      throw new Error('Disk full');
    });
    const listener = jest.fn();
    const unsub = onSaveFlush(listener);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    saveSettingsImmediate();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    consoleSpy.mockRestore();
    unsub();
  });
});

describe('saveSettings (debounced)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetSettingsState();
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
    window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.renameSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('does not write immediately', () => {
    saveSettings();
    expect(window.electron_nodeModules.fs.writeFileSync).not.toHaveBeenCalled();
  });

  test('writes after debounce period (500ms)', () => {
    saveSettings();
    jest.advanceTimersByTime(500);
    expect(window.electron_nodeModules.fs.writeFileSync).toHaveBeenCalled();
  });

  test('multiple calls within debounce only write once', () => {
    saveSettings();
    saveSettings();
    saveSettings();
    jest.advanceTimersByTime(500);
    expect(window.electron_nodeModules.fs.writeFileSync).toHaveBeenCalledTimes(1);
  });
});

// ── setSetting ──

describe('setSetting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetSettingsState();
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
    window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.renameSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('updates specific setting value', () => {
    setSetting('editor', 'cursor');
    expect(getSetting('editor')).toBe('cursor');
  });

  test('triggers save', () => {
    setSetting('editor', 'cursor');
    jest.advanceTimersByTime(500);
    expect(window.electron_nodeModules.fs.writeFileSync).toHaveBeenCalled();
  });

  test('preserves other settings', () => {
    const originalColor = getSetting('accentColor');
    setSetting('editor', 'webstorm');
    expect(getSetting('accentColor')).toBe(originalColor);
  });
});

// ── updateSettings ──

describe('updateSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetSettingsState();
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
    window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.renameSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('updates multiple settings at once', () => {
    updateSettings({ editor: 'idea', accentColor: '#00ff00' });
    expect(getSetting('editor')).toBe('idea');
    expect(getSetting('accentColor')).toBe('#00ff00');
  });

  test('triggers save', () => {
    updateSettings({ editor: 'cursor' });
    jest.advanceTimersByTime(500);
    expect(window.electron_nodeModules.fs.writeFileSync).toHaveBeenCalled();
  });
});

// ── resetSettings ──

describe('resetSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetSettingsState();
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
    window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.renameSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('resets all settings to defaults', () => {
    setSetting('editor', 'cursor');
    setSetting('accentColor', '#ff0000');
    resetSettings();
    expect(getSetting('editor')).toBe('code');
    expect(getSetting('accentColor')).toBe('#d97706');
  });

  test('triggers save after reset', () => {
    resetSettings();
    jest.advanceTimersByTime(500);
    expect(window.electron_nodeModules.fs.writeFileSync).toHaveBeenCalled();
  });
});

// ── Setting getters ──

describe('setting default values', () => {
  beforeEach(() => {
    resetSettingsState();
  });

  test('language defaults to null (auto-detect)', () => {
    expect(getSetting('language')).toBeNull();
  });

  test('closeAction defaults to "ask"', () => {
    expect(getSetting('closeAction')).toBe('ask');
  });

  test('compactProjects defaults to true', () => {
    expect(getSetting('compactProjects')).toBe(true);
  });

  test('customPresets defaults to empty array', () => {
    expect(getSetting('customPresets')).toEqual([]);
  });

  test('aiCommitMessages defaults to true', () => {
    expect(getSetting('aiCommitMessages')).toBe(true);
  });

  test('hooksEnabled defaults to false', () => {
    expect(getSetting('hooksEnabled')).toBe(false);
  });

  test('hooksConsentShown defaults to false', () => {
    expect(getSetting('hooksConsentShown')).toBe(false);
  });

  test('enable1MContext defaults to false', () => {
    expect(getSetting('enable1MContext')).toBe(false);
  });

  test('effortLevel defaults to "high"', () => {
    expect(getSetting('effortLevel')).toBe('high');
  });

  test('remoteEnabled defaults to false', () => {
    expect(getSetting('remoteEnabled')).toBe(false);
  });

  test('remotePort defaults to 3712', () => {
    expect(getSetting('remotePort')).toBe(3712);
  });

  test('restoreTerminalSessions defaults to true', () => {
    expect(getSetting('restoreTerminalSessions')).toBe(true);
  });

  test('showDotfiles defaults to true', () => {
    expect(getSetting('showDotfiles')).toBe(true);
  });

  test('showTabModeToggle defaults to true', () => {
    expect(getSetting('showTabModeToggle')).toBe(true);
  });

  test('skipPermissions defaults to false', () => {
    expect(getSetting('skipPermissions')).toBe(false);
  });

  test('shortcuts defaults to empty object', () => {
    expect(getSetting('shortcuts')).toEqual({});
  });

  test('pinnedTabs defaults to array with expected tabs', () => {
    const tabs = getSetting('pinnedTabs');
    expect(Array.isArray(tabs)).toBe(true);
    expect(tabs).toContain('claude');
    expect(tabs).toContain('git');
    expect(tabs).toContain('dashboard');
  });

  test('parallelMaxAgents defaults to 3', () => {
    expect(getSetting('parallelMaxAgents')).toBe(3);
  });

  test('telemetryEnabled defaults to false', () => {
    expect(getSetting('telemetryEnabled')).toBe(false);
  });

  test('enableFollowupSuggestions defaults to true', () => {
    expect(getSetting('enableFollowupSuggestions')).toBe(true);
  });

  test('autoClaudeMdUpdate defaults to true', () => {
    expect(getSetting('autoClaudeMdUpdate')).toBe(true);
  });
});

// ── Notifications ──

describe('isNotificationsEnabled / toggleNotifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    resetSettingsState();
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
    window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.renameSync.mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('isNotificationsEnabled returns true by default', () => {
    expect(isNotificationsEnabled()).toBe(true);
  });

  test('toggleNotifications disables when enabled', () => {
    toggleNotifications();
    expect(isNotificationsEnabled()).toBe(false);
  });

  test('toggleNotifications re-enables when disabled', () => {
    toggleNotifications();
    toggleNotifications();
    expect(isNotificationsEnabled()).toBe(true);
  });
});

// ── onSaveFlush ──

describe('onSaveFlush', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSettingsState();
    window.electron_nodeModules.fs.existsSync.mockReturnValue(false);
    window.electron_nodeModules.fs.writeFileSync.mockImplementation(() => {});
    window.electron_nodeModules.fs.renameSync.mockImplementation(() => {});
  });

  test('listener is called on successful save', () => {
    const listener = jest.fn();
    const unsub = onSaveFlush(listener);
    saveSettingsImmediate();
    expect(listener).toHaveBeenCalledWith({ success: true });
    unsub();
  });

  test('unsubscribe removes listener', () => {
    const listener = jest.fn();
    const unsub = onSaveFlush(listener);
    unsub();
    saveSettingsImmediate();
    expect(listener).not.toHaveBeenCalled();
  });

  test('multiple listeners all receive notification', () => {
    const listener1 = jest.fn();
    const listener2 = jest.fn();
    const unsub1 = onSaveFlush(listener1);
    const unsub2 = onSaveFlush(listener2);
    saveSettingsImmediate();
    expect(listener1).toHaveBeenCalled();
    expect(listener2).toHaveBeenCalled();
    unsub1();
    unsub2();
  });
});

// ── Subscription notifications ──

describe('subscription notifications', () => {
  beforeEach(() => {
    resetSettingsState();
  });

  test('notifies on setting change', async () => {
    const listener = jest.fn();
    settingsState.subscribe(listener);
    settingsState.setProp('editor', 'cursor');
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
    const state = listener.mock.calls[0][0];
    expect(state.editor).toBe('cursor');
  });

  test('batches multiple rapid updates', async () => {
    const listener = jest.fn();
    settingsState.subscribe(listener);
    settingsState.setProp('editor', 'cursor');
    settingsState.setProp('accentColor', '#ff0000');
    settingsState.setProp('language', 'en');
    await new Promise(r => setTimeout(r, 0));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
