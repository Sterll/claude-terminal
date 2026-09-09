/**
 * What's new, after the restart.
 *
 * The panel is only useful if it opens for the right launches: once after an
 * update, never on a fresh install, and never twice. That decision is pure
 * arithmetic over two version strings and a flag, so it is the part worth
 * pinning — along with catching up every move when several releases were
 * skipped at once, which is the case the panel exists for.
 */

jest.mock('../../src/renderer/i18n', () => ({ t: (key) => key }));
jest.mock('../../src/renderer/services/markdown', () => ({ render: (md) => `<p>${md}</p>` }));
jest.mock('../../src/renderer/state/settings.state', () => ({
  settingsState: { setProp: jest.fn() },
  saveSettings: jest.fn(),
  getSetting: jest.fn(() => null),
}));

const WhatsNew = require('../../src/renderer/ui/components/WhatsNew');

describe('compareVersions', () => {
  test('orders by component, not lexically', () => {
    // '1.3.10' < '1.3.9' as strings — the trap this exists to avoid.
    expect(WhatsNew.compareVersions('1.3.10', '1.3.9')).toBeGreaterThan(0);
    expect(WhatsNew.compareVersions('1.3.1', '1.3.1')).toBe(0);
    expect(WhatsNew.compareVersions('1.2.18', '1.3.0')).toBeLessThan(0);
  });

  test('treats a missing component as zero', () => {
    expect(WhatsNew.compareVersions('1.3', '1.3.0')).toBe(0);
    expect(WhatsNew.compareVersions('1.3', '1.3.1')).toBeLessThan(0);
  });
});

describe('shouldShow', () => {
  test('opens once per version, then stays shut', () => {
    expect(WhatsNew.shouldShow('1.3.1', '1.3.0', true)).toBe(true);
    expect(WhatsNew.shouldShow('1.3.1', '1.3.1', true)).toBe(false);
  });

  test('stays shut on a fresh install', () => {
    // No version recorded and no projects: nothing to catch up on.
    expect(WhatsNew.shouldShow('1.3.1', null, false)).toBe(false);
  });

  test('opens for a profile that predates the setting', () => {
    // Everyone upgrading into the first build that records a version looks
    // like a fresh install; having projects is what tells them apart.
    expect(WhatsNew.shouldShow('1.3.1', null, true)).toBe(true);
  });

  test('stays shut on a downgrade', () => {
    expect(WhatsNew.shouldShow('1.3.0', '1.3.1', true)).toBe(false);
  });
});

describe('movesBetween', () => {
  test('catches up every version that was skipped', () => {
    const moves = WhatsNew.movesBetween('1.2.18', '1.3.1');
    expect(moves.map(m => m.version)).toEqual(['1.3.0', '1.3.1']);
  });

  test('leaves out what was already seen', () => {
    expect(WhatsNew.movesBetween('1.3.0', '1.3.1').map(m => m.version)).toEqual(['1.3.1']);
  });

  test('leaves out versions ahead of the one running', () => {
    expect(WhatsNew.movesBetween('1.2.18', '1.3.0').map(m => m.version)).toEqual(['1.3.0']);
  });

  test('with nothing recorded, shows everything up to the current version', () => {
    expect(WhatsNew.movesBetween(null, '1.3.1').length).toBe(
      Object.values(WhatsNew.MOVES).flat().length
    );
  });
});

describe('buildHtml', () => {
  const move = { titleKey: 'a.title', bodyKey: 'a.body', action: { type: 'tab', tab: 'files', labelKey: 'a.go' } };

  test('carries the action button so the move can be followed', () => {
    const html = WhatsNew.buildHtml([move], null);
    expect(html).toContain('data-move-action');
    expect(html).toContain('a.go');
  });

  test('says so when the notes could not be fetched, rather than showing a gap', () => {
    const html = WhatsNew.buildHtml([move], null);
    expect(html).toContain('whatsNew.notesUnavailable');
  });

  test('renders the notes when they are there', () => {
    const html = WhatsNew.buildHtml([], '# hello');
    expect(html).toContain('<p># hello</p>');
    expect(html).not.toContain('whatsNew.notesUnavailable');
  });
});
