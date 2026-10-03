const { parseFrontmatter } = require('../../src/renderer/utils/frontmatter');

describe('parseFrontmatter', () => {
  describe('valid frontmatter', () => {
    test('parses simple key-value pairs', () => {
      const content = '---\ntitle: Hello World\nauthor: Test\n---\nBody content';
      const result = parseFrontmatter(content);
      expect(result.metadata).toEqual({ title: 'Hello World', author: 'Test' });
      expect(result.body).toBe('Body content');
    });

    test('parses frontmatter with quoted string values', () => {
      const content = '---\ntitle: "Hello: World"\ndesc: \'Single quoted\'\n---\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata.title).toBe('Hello: World');
      expect(result.metadata.desc).toBe('Single quoted');
    });

    test('parses numeric values as strings', () => {
      const content = '---\nversion: 42\npi: 3.14\n---\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata.version).toBe('42');
      expect(result.metadata.pi).toBe('3.14');
    });

    test('parses boolean-like values as strings', () => {
      const content = '---\nenabled: true\ndisabled: false\n---\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata.enabled).toBe('true');
      expect(result.metadata.disabled).toBe('false');
    });

    test('handles values with colons inside quoted strings', () => {
      const content = '---\nurl: "https://example.com"\n---\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata.url).toBe('https://example.com');
    });

    test('handles values with colons unquoted', () => {
      const content = '---\nurl: https://example.com\n---\nBody';
      const result = parseFrontmatter(content);
      // The simple parser splits at first colon only
      expect(result.metadata.url).toBe('https://example.com');
    });
  });

  describe('no frontmatter', () => {
    test('returns empty metadata and full content as body', () => {
      const content = 'Just plain text\nwith multiple lines';
      const result = parseFrontmatter(content);
      expect(result.metadata).toEqual({});
      expect(result.body).toBe(content);
    });

    test('handles content starting with single ---', () => {
      const content = '---\nNo closing delimiter';
      const result = parseFrontmatter(content);
      expect(result.metadata).toEqual({});
      expect(result.body).toBe(content);
    });

    test('handles empty string', () => {
      const result = parseFrontmatter('');
      expect(result.metadata).toEqual({});
      expect(result.body).toBe('');
    });
  });

  describe('empty frontmatter block', () => {
    test('returns empty metadata with empty frontmatter', () => {
      const content = '---\n\n---\nBody content';
      const result = parseFrontmatter(content);
      expect(result.metadata).toEqual({});
      expect(result.body).toBe('Body content');
    });
  });

  describe('body handling', () => {
    test('body preserves content after closing ---', () => {
      const content = '---\nkey: value\n---\nLine 1\nLine 2\nLine 3';
      const result = parseFrontmatter(content);
      expect(result.body).toBe('Line 1\nLine 2\nLine 3');
    });

    test('body can contain --- delimiters', () => {
      const content = '---\nkey: value\n---\nSome text\n---\nMore text after separator';
      const result = parseFrontmatter(content);
      expect(result.body).toContain('---');
      expect(result.body).toContain('More text after separator');
    });

    test('empty body after frontmatter', () => {
      const content = '---\nkey: value\n---\n';
      const result = parseFrontmatter(content);
      expect(result.metadata.key).toBe('value');
      expect(result.body).toBe('');
    });
  });

  describe('whitespace handling', () => {
    test('trims key and value whitespace', () => {
      const content = '---\n  title  :  Hello World  \n---\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata.title).toBe('Hello World');
    });

    test('handles Windows-style line endings (CRLF)', () => {
      const content = '---\r\ntitle: Test\r\n---\r\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata.title).toBe('Test');
      expect(result.body).toBe('Body');
    });
  });

  describe('edge cases', () => {
    test('lines without colons are skipped', () => {
      const content = '---\ntitle: Hello\nno-colon-here\nauthor: Test\n---\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata).toEqual({ title: 'Hello', author: 'Test' });
    });

    test('key-only with empty value', () => {
      const content = '---\nempty:\n---\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata.empty).toBe('');
    });

    test('multiple colons in value - uses first colon as separator', () => {
      const content = '---\ndata: key:value:extra\n---\nBody';
      const result = parseFrontmatter(content);
      expect(result.metadata.data).toBe('key:value:extra');
    });

    test('frontmatter must start at beginning of content', () => {
      const content = 'Some text before\n---\ntitle: Hello\n---\nBody';
      const result = parseFrontmatter(content);
      // Should not parse because --- is not at start
      expect(result.metadata).toEqual({});
    });
  });
});

describe('parseFrontmatter: multi-line values', () => {
  test('a folded block scalar is read, not left as its indicator', () => {
    const content = [
      '---',
      'name: arsenal',
      'description: >-',
      '  Arsenal expert. Helps the user',
      '  understand Arsenal concepts.',
      '',
      '  Use when: the user types /arsenal.',
      'metadata: x',
      '---',
      'Body',
    ].join('\n');
    const { metadata, parsed } = parseFrontmatter(content);
    expect(parsed.description).toBe('Arsenal expert. Helps the user understand Arsenal concepts.\nUse when: the user types /arsenal.');
    // Indented lines holding a colon are not keys of their own.
    expect(Object.keys(metadata)).toEqual(['name', 'description', 'metadata']);
  });

  test('a literal block scalar keeps its line breaks', () => {
    const content = '---\ndescription: |\n  Line one.\n\n  - item\n---\n';
    expect(parseFrontmatter(content).parsed.description).toBe('Line one.\n\n- item');
  });

  test('a block list of tools reads like an inline one', () => {
    const content = '---\nname: a\ntools:\n  - Read\n  - "Grep"\n  - Bash\n---\n';
    expect(parseFrontmatter(content).parsed.tools).toEqual(['Read', 'Grep', 'Bash']);
  });

  test('a plain scalar continued on the next lines is joined', () => {
    const content = '---\ndescription: Reads the docs\n  and answers questions.\n---\n';
    expect(parseFrontmatter(content).parsed.description).toBe('Reads the docs and answers questions.');
  });
});
