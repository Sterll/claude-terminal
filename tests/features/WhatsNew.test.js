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
    const html = WhatsNew.buildHtml([], 'hello');
    expect(html).toContain('<p>hello</p>');
    expect(html).not.toContain('whatsNew.notesUnavailable');
  });

  test('borrows the chat typography, the only class the markdown rules are scoped to', () => {
    expect(WhatsNew.buildHtml([], 'hello')).toContain('chat-msg-content');
  });
});

describe('tidyNotes', () => {
  const notes = [
    '<div align="center">',
    '',
    '# ⚡ Claude Terminal `v1.3.5`',
    '',
    '**A Redis browser you can actually work in.**',
    '',
    '![Version](https://img.shields.io/badge/release-1.3.5-d97706?style=for-the-badge)',
    '![Windows](https://img.shields.io/badge/Windows-.exe-0078D6) ![macOS](https://img.shields.io/badge/macOS-.dmg-000000)',
    '',
    '</div>',
    '',
    '## Everything else',
    '',
    '![New](https://img.shields.io/badge/New-22c55e)',
    '',
    '- **Sonnet 5.5** in the picker',
  ].join('\n');

  test('drops the title the modal already shows, and the header badges', () => {
    const out = WhatsNew.tidyNotes(notes);
    expect(out).not.toContain('# ⚡');
    expect(out).not.toContain('release-1.3.5');
    expect(out).not.toContain('Windows-.exe');
    expect(out).toContain('**A Redis browser you can actually work in.**');
  });

  test('leaves every section below the header alone, badges included', () => {
    const out = WhatsNew.tidyNotes(notes);
    expect(out).toContain('## Everything else');
    expect(out).toContain('![New](https://img.shields.io/badge/New-22c55e)');
    expect(out).toContain('- **Sonnet 5.5** in the picker');
  });

  test('says nothing rather than an empty section when only chrome was there', () => {
    const html = WhatsNew.buildHtml([], '# Claude Terminal v1\n\n![v](https://img.shields.io/x)');
    expect(html).toContain('whatsNew.notesUnavailable');
  });
});

describe('showReleaseNotes', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="modal"><div id="modal-body"></div><div id="modal-footer"></div></div>';
  });

  const showModal = jest.fn((title, html, footer) => {
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-footer').innerHTML = footer;
  });

  test('opens the wide panel with the notes and an install button', () => {
    const onInstall = jest.fn();
    const closeModal = jest.fn();
    WhatsNew.showReleaseNotes({ version: '1.3.5', notes: 'hello', showModal, closeModal, onInstall });

    expect(document.getElementById('modal').classList.contains('modal--whats-new')).toBe(true);
    expect(document.getElementById('modal-body').textContent).toContain('hello');

    document.getElementById('whats-new-install').click();
    expect(closeModal).toHaveBeenCalled();
    expect(onInstall).toHaveBeenCalled();
  });

  test('offers no install button when there is nothing to install', () => {
    WhatsNew.showReleaseNotes({ version: '1.3.5', notes: 'hello', showModal, closeModal: jest.fn() });
    expect(document.getElementById('whats-new-install')).toBeNull();
    expect(document.getElementById('whats-new-close')).not.toBeNull();
  });
});
