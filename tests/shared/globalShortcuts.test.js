const {
  GLOBAL_SHORTCUT_DEFAULTS,
  toElectronAccelerator,
  isUnsafeAccelerator,
  resolveGlobalShortcuts
} = require('../../src/shared/global-shortcuts');

const ids = (result) => result.resolved.map(r => r.id);
const accelerators = (result) => result.resolved.map(r => r.accelerator);

describe('global shortcut defaults', () => {
  test('every default carries a modifier', () => {
    // A modifier-less global grab catches every keystroke on X11 when the key
    // turns out to be unmapped (issue #166).
    for (const [id, accelerator] of Object.entries(GLOBAL_SHORTCUT_DEFAULTS)) {
      if (!accelerator) continue;
      expect(accelerator.includes('+')).toBe(true);
      expect(id).toBeTruthy();
    }
  });

  test('no default is a key X11 commonly leaves unmapped', () => {
    for (const accelerator of Object.values(GLOBAL_SHORTCUT_DEFAULTS)) {
      if (!accelerator) continue;
      expect(isUnsafeAccelerator(accelerator, 'linux')).toBe(false);
    }
  });

  test('push-to-talk is unbound by default', () => {
    expect(GLOBAL_SHORTCUT_DEFAULTS.globalPushToTalk).toBeNull();
  });
});

describe('toElectronAccelerator', () => {
  test('maps Ctrl and Meta to CommandOrControl', () => {
    expect(toElectronAccelerator('Ctrl+Shift+P')).toBe('CommandOrControl+Shift+P');
    expect(toElectronAccelerator('Meta+K')).toBe('CommandOrControl+K');
  });

  test('empty input yields null', () => {
    expect(toElectronAccelerator('')).toBeNull();
    expect(toElectronAccelerator(null)).toBeNull();
    expect(toElectronAccelerator(undefined)).toBeNull();
  });
});

describe('isUnsafeAccelerator', () => {
  test('F13-F24 are unsafe on linux', () => {
    for (const key of ['F13', 'F16', 'F24']) {
      expect(isUnsafeAccelerator(key, 'linux')).toBe(true);
      expect(isUnsafeAccelerator(`CommandOrControl+${key}`, 'linux')).toBe(true);
    }
  });

  test('keys a standard layout maps are safe', () => {
    expect(isUnsafeAccelerator('F12', 'linux')).toBe(false);
    expect(isUnsafeAccelerator('CommandOrControl+Shift+P', 'linux')).toBe(false);
  });

  test('other platforms resolve these keys natively', () => {
    expect(isUnsafeAccelerator('F13', 'win32')).toBe(false);
    expect(isUnsafeAccelerator('F13', 'darwin')).toBe(false);
  });

  test('case and stray whitespace do not slip through', () => {
    expect(isUnsafeAccelerator('f13', 'linux')).toBe(true);
    expect(isUnsafeAccelerator('CommandOrControl+ f13 ', 'linux')).toBe(true);
  });

  test('empty accelerator is not unsafe', () => {
    expect(isUnsafeAccelerator('', 'linux')).toBe(false);
    expect(isUnsafeAccelerator(null, 'linux')).toBe(false);
  });
});

describe('resolveGlobalShortcuts', () => {
  test('no settings yields the bound defaults', () => {
    const result = resolveGlobalShortcuts({}, 'linux');
    expect(ids(result)).toEqual([
      'globalQuickPicker',
      'globalNewTerminal',
      'globalNewWorktree'
    ]);
    expect(result.rejected).toEqual([]);
  });

  test('the master toggle registers nothing', () => {
    const result = resolveGlobalShortcuts({ enabled: false }, 'linux');
    expect(result.resolved).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  test('an override replaces the default and is converted', () => {
    const result = resolveGlobalShortcuts(
      { overrides: { globalQuickPicker: 'Ctrl+Alt+K' } },
      'darwin'
    );
    expect(accelerators(result)).toContain('CommandOrControl+Alt+K');
    expect(accelerators(result)).not.toContain('CommandOrControl+Shift+P');
  });

  test('an empty override unbinds instead of restoring the default', () => {
    const result = resolveGlobalShortcuts(
      { overrides: { globalQuickPicker: '' } },
      'darwin'
    );
    expect(ids(result)).not.toContain('globalQuickPicker');
    expect(ids(result)).toContain('globalNewTerminal');
  });

  test('null and undefined overrides also unbind', () => {
    for (const value of [null, undefined]) {
      const result = resolveGlobalShortcuts(
        { overrides: { globalNewTerminal: value } },
        'darwin'
      );
      expect(ids(result)).not.toContain('globalNewTerminal');
    }
  });

  test('an unsafe override is rejected on linux, with a reason', () => {
    const result = resolveGlobalShortcuts(
      { overrides: { globalPushToTalk: 'F13' } },
      'linux'
    );
    expect(ids(result)).not.toContain('globalPushToTalk');
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({
      id: 'globalPushToTalk',
      accelerator: 'F13'
    });
    expect(result.rejected[0].reason).toMatch(/keyboard/i);
  });

  test('the same override is honoured off linux', () => {
    const result = resolveGlobalShortcuts(
      { overrides: { globalPushToTalk: 'F13' } },
      'win32'
    );
    expect(ids(result)).toContain('globalPushToTalk');
    expect(result.rejected).toEqual([]);
  });

  test('one rejected binding does not drop the others', () => {
    const result = resolveGlobalShortcuts(
      { overrides: { globalQuickPicker: 'F14' } },
      'linux'
    );
    expect(ids(result)).toEqual(['globalNewTerminal', 'globalNewWorktree']);
    expect(result.rejected.map(r => r.id)).toEqual(['globalQuickPicker']);
  });
});
