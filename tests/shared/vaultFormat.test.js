/**
 * The Obsidian note format (help.obsidian.md: Internal links, Tags,
 * Properties, Daily notes, Templates) as src/shared/vault-format.js reads and
 * writes it.
 */

const fmt = require('../../src/shared/vault-format');

describe('parseFrontmatter', () => {
  test('reads scalars, inline lists and dash lists', () => {
    const { data, body, hasFrontmatter } = fmt.parseFrontmatter(
      '---\ntitle: "Hello: world"\ntags: [projet, idée]\naliases:\n  - Alias un\n  - \'Alias deux\'\ncount: 3\n---\n# Body\n'
    );
    expect(hasFrontmatter).toBe(true);
    expect(data.title).toBe('Hello: world');
    expect(data.tags).toEqual(['projet', 'idée']);
    expect(data.aliases).toEqual(['Alias un', 'Alias deux']);
    expect(data.count).toBe('3');
    expect(body).toBe('# Body\n');
  });

  test('a note without frontmatter is all body', () => {
    const r = fmt.parseFrontmatter('Just text\n---\nnot frontmatter');
    expect(r.hasFrontmatter).toBe(false);
    expect(r.body).toBe('Just text\n---\nnot frontmatter');
  });

  test('accepts CRLF and the `...` terminator', () => {
    const r = fmt.parseFrontmatter('---\r\ntags: a\r\n...\r\nbody');
    expect(r.data.tags).toBe('a');
    expect(r.body).toBe('body');
  });
});

describe('extractLinks', () => {
  test('wikilinks with alias, heading, block and embed', () => {
    const links = fmt.extractLinks('See [[Note A]], [[Note B|the B]], [[Folder/C#Section]], [[D#^abc123]] and ![[image.png]] ![[E]].');
    expect(links.map((l) => l.target)).toEqual(['Note A', 'Note B', 'Folder/C', 'D', 'image.png', 'E']);
    expect(links[1].alias).toBe('the B');
    expect(links[2].subpath).toBe('#Section');
    expect(links[3].subpath).toBe('#^abc123');
    expect(links[4].embed).toBe(true);
  });

  test('a same-note heading link is not an outgoing link', () => {
    expect(fmt.extractLinks('[[#Heading]]')).toEqual([]);
  });

  test('markdown links to notes count, URLs do not, and encoding is decoded', () => {
    const links = fmt.extractLinks('[x](My%20Note.md) [y](https://example.com/a.md) [z](other.txt) [w](sub/n.md#h)');
    expect(links.map((l) => l.target)).toEqual(['My Note.md', 'sub/n.md']);
    expect(links[1].subpath).toBe('#h');
  });

  test('links inside code and comments are ignored', () => {
    const text = 'Real [[A]]\n```\n[[Not B]]\n```\n`[[Not C]]` %%[[Not D]]%% [[E]]';
    expect(fmt.extractLinks(text).map((l) => l.target)).toEqual(['A', 'E']);
  });
});

describe('extractTags', () => {
  test('inline and frontmatter tags, nested, lowercased, numbers alone excluded', () => {
    const tags = fmt.extractTags('Text #Projet/Alpha and #idée, not #1984, not a#b, (#wrapped)', { tags: ['#Front', 'other'] });
    expect(tags.sort()).toEqual(['front', 'idée', 'other', 'projet/alpha', 'wrapped'].sort());
  });

  test('headings and code are not tags', () => {
    expect(fmt.extractTags('# Heading\n`#code`\n```\n#fence\n```\n#real')).toEqual(['real']);
  });
});

describe('normalizeNotePath', () => {
  test.each([
    ['Note', 'Note.md'],
    ['Folder/Note.md', 'Folder/Note.md'],
    ['Folder\\Sub\\Note', 'Folder/Sub/Note.md'],
    ['a//b', 'a/b.md'],
  ])('%s -> %s', (input, out) => {
    expect(fmt.normalizeNotePath(input)).toBe(out);
  });

  test.each([
    '../outside', 'a/../../b', '/etc/passwd', 'C:/Windows/x', '.obsidian/app.json',
    'notes/.trash/x', '.git/config', '', 'a\u0000b', 'line\nbreak', 42, null,
  ])('refuses %p', (input) => {
    expect(fmt.normalizeNotePath(input)).toBeNull();
  });
});

describe('sanitizeNoteTitle', () => {
  test('drops characters Obsidian refuses in note names', () => {
    expect(fmt.sanitizeNoteTitle('Fix: auth/login [WIP] #2 | v2?')).toBe('Fix auth login WIP 2 v2');
    expect(fmt.sanitizeNoteTitle('...hidden')).toBe('hidden');
  });
});

describe('resolveLink', () => {
  const index = fmt.buildLinkIndex([
    'Inbox.md',
    'Projects/Alpha.md',
    'Projects/Beta/Plan.md',
    'Archive/Plan.md',
    'Daily/2026-11-16.md',
    'Deep/Nested/Inbox.md',
  ]);

  test('exact vault path, with or without .md, any case', () => {
    expect(fmt.resolveLink('Projects/Alpha', null, index).path).toBe('Projects/Alpha.md');
    expect(fmt.resolveLink('projects/alpha.md', null, index).path).toBe('Projects/Alpha.md');
  });

  test('bare name', () => {
    expect(fmt.resolveLink('alpha', 'Inbox.md', index)).toEqual({ path: 'Projects/Alpha.md', ambiguous: false });
  });

  test('relative to the linking note first', () => {
    expect(fmt.resolveLink('Plan', 'Projects/Beta/Other.md', index).path).toBe('Projects/Beta/Plan.md');
  });

  test('path suffix', () => {
    expect(fmt.resolveLink('Beta/Plan', null, index).path).toBe('Projects/Beta/Plan.md');
  });

  test('several notes of one name: the shallowest, said to be ambiguous', () => {
    const r = fmt.resolveLink('Plan', 'Inbox.md', index);
    expect(r.path).toBe('Archive/Plan.md');
    expect(r.ambiguous).toBe(true);
    // A name that is also the exact path of a root note is that note, unambiguously.
    expect(fmt.resolveLink('Inbox', 'Daily/2026-11-16.md', index)).toEqual({ path: 'Inbox.md', ambiguous: false });
  });

  test('unknown note', () => {
    expect(fmt.resolveLink('Nope', null, index)).toEqual({ path: null, ambiguous: false });
  });

  test('linkTextFor uses the bare name only when it is unique', () => {
    expect(fmt.linkTextFor('Projects/Alpha.md', index)).toBe('Alpha');
    expect(fmt.linkTextFor('Archive/Plan.md', index)).toBe('Archive/Plan');
  });
});

describe('formatDate / dailyNotePath', () => {
  const d = new Date(2026, 10, 16, 9, 5, 7); // Monday 16 November 2026, 09:05:07

  test('the default daily format', () => {
    expect(fmt.formatDate(d, 'YYYY-MM-DD')).toBe('2026-11-16');
  });

  test('tokens and escaped literals', () => {
    expect(fmt.formatDate(d, 'YY/M/D HH:mm:ss [at] h A')).toBe('26/11/16 09:05:07 at 9 AM');
    expect(fmt.formatDate(d, 'Do [of] MMMM, dddd')).toBe('16th of November, Monday');
    expect(fmt.formatDate(d, 'GGGG-[W]WW')).toBe('2026-W47');
    expect(fmt.formatDate(d, 'DDDD Q E')).toBe('320 4 1');
  });

  test('names follow the locale', () => {
    expect(fmt.formatDate(d, 'D MMMM YYYY, dddd', 'fr')).toBe('16 novembre 2026, lundi');
  });

  test('folder and slashes in the format make folders', () => {
    expect(fmt.dailyNotePath({ folder: '/Journal/', format: 'YYYY/MM-MMMM/YYYY-MM-DD' }, d)).toBe('Journal/2026/11-November/2026-11-16.md');
    expect(fmt.dailyNotePath({}, d)).toBe('2026-11-16.md');
  });

  test('formatUsesNames', () => {
    expect(fmt.formatUsesNames('YYYY-MM-DD')).toBe(false);
    expect(fmt.formatUsesNames('YYYY/MMMM/DD')).toBe(true);
    expect(fmt.formatUsesNames('[Monday] YYYY')).toBe(false);
  });
});

describe('fillTemplate', () => {
  test('title, date, time and custom formats', () => {
    const d = new Date(2026, 10, 16, 14, 30);
    const out = fmt.fillTemplate('# {{title}}\n{{date}} {{time}}\n{{date:dddd D}} {{ time:HH[h]mm }}', {
      title: '2026-11-16', date: d, templatesConfig: { dateFormat: 'DD/MM/YYYY' },
    });
    expect(out).toBe('# 2026-11-16\n16/11/2026 14:30\nMonday 16 14h30');
  });
});

describe('buildFrontmatter', () => {
  test('quotes what YAML would misread and writes lists', () => {
    expect(fmt.buildFrontmatter({ tags: ['claude-terminal', 'session'], source: 'Claude Terminal', date: '2026-11-16', ok: 'yes', empty: '' }))
      .toBe('---\ntags:\n  - claude-terminal\n  - session\nsource: Claude Terminal\ndate: "2026-11-16"\nok: "yes"\n---\n');
  });
});

describe('appendUnderHeading', () => {
  test('creates the heading at the end when absent', () => {
    expect(fmt.appendUnderHeading('# Day\n\nMorning notes\n', '- did a thing', 'Claude Terminal'))
      .toBe('# Day\n\nMorning notes\n\n## Claude Terminal\n\n- did a thing\n');
  });

  test('adds to the end of an existing section, before the next heading', () => {
    const src = '# Day\n\n## Claude Terminal\n\n- first\n\n## Evening\n\ntext\n';
    expect(fmt.appendUnderHeading(src, '- second', 'claude terminal'))
      .toBe('# Day\n\n## Claude Terminal\n\n- first\n\n- second\n\n## Evening\n\ntext\n');
  });

  test('a subheading stays inside its section', () => {
    const src = '## Log\n\n### Sub\n\nx\n\n## Next\n';
    expect(fmt.appendUnderHeading(src, 'y', 'Log')).toBe('## Log\n\n### Sub\n\nx\n\ny\n\n## Next\n');
  });

  test('without a heading, at the end; an empty note gets just the block', () => {
    expect(fmt.appendUnderHeading('abc', 'def')).toBe('abc\n\ndef\n');
    expect(fmt.appendUnderHeading('', 'def', 'H')).toBe('## H\n\ndef\n');
  });

  test('never loses what was there', () => {
    const src = 'a\n## H\nb\n## I\nc';
    const out = fmt.appendUnderHeading(src, 'new', 'H');
    for (const piece of ['a', 'b', 'c', '## H', '## I', 'new']) expect(out).toContain(piece);
  });
});
