// permission-modes — the per-conversation mode picker's vocabulary, and its
// mapping onto the stored `executionMode` setting that predates it.

const {
  PERMISSION_MODES,
  permissionModeInfo,
  modeFromSetting,
  settingFromMode,
  isPermissionMode,
} = require('../../src/shared/permission-modes');

describe('modeFromSetting', () => {
  test('maps the legacy executionMode spellings onto SDK modes', () => {
    expect(modeFromSetting('safe')).toBe('default');
    expect(modeFromSetting('auto')).toBe('auto');
    expect(modeFromSetting('dangerous')).toBe('bypassPermissions');
  });

  test('the modes the setting never had are stored under their SDK names', () => {
    expect(modeFromSetting('acceptEdits')).toBe('acceptEdits');
    expect(modeFromSetting('plan')).toBe('plan');
  });

  test('absent or unknown settings fall back to asking first', () => {
    expect(modeFromSetting(undefined)).toBe('default');
    expect(modeFromSetting(null)).toBe('default');
    expect(modeFromSetting('whatever')).toBe('default');
  });
});

describe('settingFromMode', () => {
  test('round-trips every mode through the setting', () => {
    for (const m of PERMISSION_MODES) {
      expect(modeFromSetting(settingFromMode(m.id))).toBe(m.id);
    }
  });
});

describe('PERMISSION_MODES', () => {
  test('only bypass is flagged as dangerous, and it comes last', () => {
    expect(PERMISSION_MODES.filter(m => m.danger).map(m => m.id)).toEqual(['bypassPermissions']);
    expect(PERMISSION_MODES[PERMISSION_MODES.length - 1].id).toBe('bypassPermissions');
  });

  test('validates ids and lands unknown ones on default', () => {
    expect(isPermissionMode('plan')).toBe(true);
    expect(isPermissionMode('yolo')).toBe(false);
    expect(permissionModeInfo('yolo').id).toBe('default');
  });
});
