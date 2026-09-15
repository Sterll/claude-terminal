/**
 * The pure helpers lifted out of TerminalManager.
 *
 * All of this is scraping: the Claude CLI running inside a PTY announces
 * nothing structured, so its state is read off the screen. That makes these
 * the functions most likely to go quietly wrong when the CLI changes a glyph,
 * and they had no tests at all while they sat mid-file.
 */

const {
  parseClaudeTitle,
  extractTitleFromInput,
  extractTerminalContext,
} = require('../../src/renderer/ui/components/terminal/claudeSignals');
const {
  normalizeStoredKey,
  eventToNormalizedKey,
} = require('../../src/renderer/ui/components/terminal/keyBindings');
const {
  truncateText,
  cleanSessionText,
  groupSessionsByTime,
  formatRelativeTime,
} = require('../../src/renderer/ui/components/terminal/sessionCards');

const SPINNER = '⠇'; // a braille cell, what the CLI animates with
const READY = '✳';   // the eight-spoked asterisk of an idle prompt

describe('parseClaudeTitle', () => {
  test('a braille prefix means still working', () => {
    expect(parseClaudeTitle(`${SPINNER} Thinking about it`)).toEqual({
      state: 'working',
      taskName: 'Thinking about it',
    });
  });

  test('the asterisk prefix means waiting for you', () => {
    expect(parseClaudeTitle(`${READY} Done`)).toEqual({ state: 'ready', taskName: 'Done' });
  });

  test('a known tool name is split off from its arguments', () => {
    expect(parseClaudeTitle(`${SPINNER} Bash npm test`)).toEqual({
      state: 'working',
      tool: 'Bash',
      toolArgs: 'npm test',
    });
  });

  test('an unknown first word stays part of the task name', () => {
    expect(parseClaudeTitle(`${SPINNER} Frobnicating the widget`)).toEqual({
      state: 'working',
      taskName: 'Frobnicating the widget',
    });
  });

  test('the CLI\'s own name is not a task', () => {
    expect(parseClaudeTitle(`${SPINNER} Claude Code`)).toEqual({ state: 'working' });
  });

  test('a title with neither marker reports unknown rather than guessing', () => {
    expect(parseClaudeTitle('bash')).toEqual({ state: 'unknown' });
    expect(parseClaudeTitle('')).toEqual({ state: 'unknown' });
  });
});

describe('extractTitleFromInput', () => {
  test('builds a title from the first few meaningful words', () => {
    expect(extractTitleFromInput('can you please fix the authentication bug'))
      .toBe('Fix Authentication Bug');
  });

  test('keeps accented words, which the stop list is written in too', () => {
    expect(extractTitleFromInput('peux-tu corriger le bug de connexion'))
      .toMatch(/Corriger/);
  });

  test('a slash command is never a title', () => {
    expect(extractTitleFromInput('/resume something')).toBeNull();
  });

  test('too short, or nothing but stop words, yields nothing', () => {
    expect(extractTitleFromInput('hi')).toBeNull();
    expect(extractTitleFromInput('can you please')).toBeNull();
  });

  test('caps the title at four words', () => {
    const title = extractTitleFromInput('refactor authentication module session handling storage layer');
    expect(title.split(' ')).toHaveLength(4);
  });
});

describe('extractTerminalContext', () => {
  /** Minimal stand-in for an xterm buffer holding `lines`. */
  function fakeTerminal(lines) {
    return {
      buffer: {
        active: {
          baseY: 0,
          cursorY: lines.length - 1,
          getLine: (i) => (lines[i] === undefined ? null : {
            translateToString: () => lines[i],
          }),
        },
      },
    };
  }

  test('reads a trailing question out of the screen', () => {
    const ctx = extractTerminalContext(fakeTerminal([
      'running tests',
      'Should I also update the snapshots?',
    ]));
    expect(ctx).toEqual({ type: 'question', text: 'Should I also update the snapshots?' });
  });

  test('recognises a permission prompt', () => {
    const ctx = extractTerminalContext(fakeTerminal([
      'Bash(rm -rf build)',
      'Do you want to allow this command',
    ]));
    expect(ctx.type).toBe('permission');
  });

  test('ignores spinner frames and bare prompt glyphs', () => {
    // Otherwise the "context" is whatever the spinner happened to be drawing.
    expect(extractTerminalContext(fakeTerminal([SPINNER + ' working', '❯', '  ']))).toBeNull();
  });

  test('an empty or absent buffer is not an error', () => {
    expect(extractTerminalContext(null)).toBeNull();
    expect(extractTerminalContext({})).toBeNull();
    expect(extractTerminalContext(fakeTerminal(['']))).toBeNull();
  });
});

describe('key binding normalisation', () => {
  test('modifier order does not change the chord', () => {
    // Without a fixed order these are two different strings for one shortcut.
    expect(normalizeStoredKey('Shift+Ctrl+K')).toBe(normalizeStoredKey('Ctrl+Shift+K'));
    expect(normalizeStoredKey('Ctrl+Shift+K')).toBe('ctrl+shift+k');
  });

  test('case and spacing are irrelevant', () => {
    expect(normalizeStoredKey(' CTRL + ALT + P ')).toBe('ctrl+alt+p');
  });

  test('an empty binding normalises to empty rather than throwing', () => {
    expect(normalizeStoredKey('')).toBe('');
    expect(normalizeStoredKey(null)).toBe('');
  });

  test('an event produces the same spelling a stored binding does', () => {
    const event = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'K' };
    expect(eventToNormalizedKey(event)).toBe(normalizeStoredKey('Ctrl+Shift+K'));
  });

  test('arrows and space use their short names', () => {
    const ev = (key) => ({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key });
    expect(eventToNormalizedKey(ev('ArrowUp'))).toBe('ctrl+up');
    expect(eventToNormalizedKey(ev('ArrowLeft'))).toBe('ctrl+left');
    expect(eventToNormalizedKey(ev(' '))).toBe('ctrl+space');
  });

  test('a modifier pressed alone is not a chord of itself', () => {
    expect(eventToNormalizedKey({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'Control' }))
      .toBe('ctrl');
  });
});

describe('session cards', () => {
  test('truncateText only cuts past the limit, and says that it did', () => {
    expect(truncateText('short', 20)).toBe('short');
    expect(truncateText('a'.repeat(30), 10)).toBe('aaaaaaaaaa...');
    expect(truncateText('', 10)).toBe('');
    expect(truncateText(null, 10)).toBe('');
  });

  test('cleanSessionText strips the command envelope and names the skill', () => {
    const { text, skillName } = cleanSessionText(
      '<command-name>/review</command-name><command-args>src/app.js</command-args>'
    );
    // Nothing is left once the tags go, so the args stand in for the prompt.
    expect(skillName).toBe('review');
    expect(text).toBe('src/app.js');
  });

  test('cleanSessionText drops interruption markers and collapses whitespace', () => {
    const { text } = cleanSessionText('fix   the  bug [Request interrupted by user]');
    expect(text).toBe('fix the bug');
  });

  test('cleanSessionText survives empty and missing input', () => {
    expect(cleanSessionText('')).toEqual({ text: '', skillName: '' });
    expect(cleanSessionText(null)).toEqual({ text: '', skillName: '' });
  });

  test('sessions are bucketed by recency, newest bucket first', () => {
    const now = Date.now();
    const day = 86_400_000;
    const groups = groupSessionsByTime([
      { modified: new Date(now).toISOString() },
      { modified: new Date(now - 10 * day).toISOString() },
      { modified: new Date(now - day).toISOString() },
    ]);

    const order = groups.map((g) => g.sessions.length);
    expect(order.reduce((a, b) => a + b, 0)).toBe(3);
    // Every session landed in exactly one bucket and no bucket is empty.
    expect(groups.every((g) => g.sessions.length > 0)).toBe(true);
  });

  test('an empty list yields no groups', () => {
    expect(groupSessionsByTime([])).toEqual([]);
  });

  test('formatRelativeTime answers for a fresh timestamp', () => {
    expect(typeof formatRelativeTime(new Date().toISOString())).toBe('string');
    expect(formatRelativeTime(new Date().toISOString())).not.toBe('');
  });

  test('an old date is formatted in the active language, for all five of them', () => {
    // The sessions modal carried a second copy of this that read
    // `lang === 'fr' ? 'fr-FR' : 'en-US'`, so Spanish, Indonesian and Chinese
    // users read their session dates in en-US. Both callers now share one
    // implementation; this pins the table it reads.
    const i18n = require('../../src/renderer/i18n');
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const spelling = {};

    for (const lang of ['en', 'fr', 'es', 'id', 'zh-CN']) {
      i18n.setLanguage(lang);
      spelling[lang] = formatRelativeTime(old);
    }
    i18n.setLanguage('en');

    // Each locale renders "day month" its own way, so no two of these agree.
    // en-US is "Jul 17", fr-FR "17 juil.", zh-CN "7月17日".
    expect(new Set(Object.values(spelling)).size).toBe(5);
  });
});
