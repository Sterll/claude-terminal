const {
  GLOBAL_SHORTCUT_DEFAULTS,
  toElectronAccelerator,
  isUnsafeAccelerator,
  matchesAccelerator,
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

describe('matchesAccelerator (in-window fallback)', () => {
  const press = (extra) => ({ type: 'keyDown', control: false, meta: false, alt: false, shift: false, ...extra });

  test('Ctrl+Shift+T matches on Linux, whatever case Shift gives the letter', () => {
    expect(matchesAccelerator('CommandOrControl+Shift+T', press({ control: true, shift: true, key: 'T', code: 'KeyT' }), 'linux')).toBe(true);
    expect(matchesAccelerator('CommandOrControl+Shift+T', press({ control: true, shift: true, key: 't', code: 'KeyT' }), 'linux')).toBe(true);
  });

  test('a letter follows the layout, not the physical key (AZERTY swaps W and Z)', () => {
    // Ctrl+Shift+Z is redo; on AZERTY it sits where QWERTY has W.
    expect(matchesAccelerator('CommandOrControl+Shift+W', press({ control: true, shift: true, key: 'Z', code: 'KeyW' }), 'linux')).toBe(false);
    expect(matchesAccelerator('CommandOrControl+Shift+W', press({ control: true, shift: true, key: 'W', code: 'KeyZ' }), 'linux')).toBe(true);
  });

  test('falls back to the physical key when the layout produces no Latin letter', () => {
    expect(matchesAccelerator('CommandOrControl+Shift+T', press({ control: true, shift: true, key: 'Е', code: 'KeyT' }), 'linux')).toBe(true);
    expect(matchesAccelerator('CommandOrControl+Shift+T', press({ control: true, shift: true, key: 'Е', code: 'KeyY' }), 'linux')).toBe(false);
  });

  test('a digit reads through Shift and AZERTY\'s unshifted digit row', () => {
    expect(matchesAccelerator('CommandOrControl+Shift+1', press({ control: true, shift: true, key: '!', code: 'Digit1' }), 'linux')).toBe(true);
    expect(matchesAccelerator('CommandOrControl+1', press({ control: true, key: '&', code: 'Digit1' }), 'linux')).toBe(true);
    expect(matchesAccelerator('CommandOrControl+1', press({ control: true, key: '2', code: 'Digit1' }), 'linux')).toBe(false);
  });

  test('modifiers must match exactly', () => {
    expect(matchesAccelerator('CommandOrControl+Shift+T', press({ control: true, key: 't', code: 'KeyT' }), 'linux')).toBe(false);
    expect(matchesAccelerator('CommandOrControl+Shift+T', press({ control: true, shift: true, alt: true, key: 'T', code: 'KeyT' }), 'linux')).toBe(false);
  });

  test('CommandOrControl is Cmd on macOS, not Ctrl', () => {
    expect(matchesAccelerator('CommandOrControl+Shift+T', press({ meta: true, shift: true, key: 'T', code: 'KeyT' }), 'darwin')).toBe(true);
    expect(matchesAccelerator('CommandOrControl+Shift+T', press({ control: true, shift: true, key: 'T', code: 'KeyT' }), 'darwin')).toBe(false);
  });

  test('ignores key-up, auto-repeat and an unbound accelerator', () => {
    const input = press({ control: true, shift: true, key: 'T', code: 'KeyT' });
    expect(matchesAccelerator('CommandOrControl+Shift+T', { ...input, type: 'keyUp' }, 'linux')).toBe(false);
    expect(matchesAccelerator('CommandOrControl+Shift+T', { ...input, isAutoRepeat: true }, 'linux')).toBe(false);
    expect(matchesAccelerator(null, input, 'linux')).toBe(false);
  });

  test('named keys compare on key, including names the DOM spells differently', () => {
    expect(matchesAccelerator('CommandOrControl+Space', press({ control: true, key: ' ', code: 'Space' }), 'linux')).toBe(true);
    expect(matchesAccelerator('Alt+F9', press({ alt: true, key: 'F9', code: 'F9' }), 'linux')).toBe(true);
    expect(matchesAccelerator('CommandOrControl+Up', press({ control: true, key: 'ArrowUp', code: 'ArrowUp' }), 'linux')).toBe(true);
    expect(matchesAccelerator('Alt+Esc', press({ alt: true, key: 'Escape', code: 'Escape' }), 'linux')).toBe(true);
    expect(matchesAccelerator('CommandOrControl+Up', press({ control: true, key: 'ArrowDown', code: 'ArrowDown' }), 'linux')).toBe(false);
  });
});
