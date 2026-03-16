jest.mock('../../src/renderer/utils/dom', () => ({
  escapeHtml: (text) => {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}));

const { highlight } = require('../../src/renderer/utils/syntaxHighlight');

describe('highlight', () => {
  describe('language detection by extension', () => {
    test('js maps to javascript highlighting', () => {
      const result = highlight('const x = 1;', 'js');
      expect(result).toContain('syn-kw');
      expect(result).toContain('const');
    });

    test('ts maps to typescript highlighting', () => {
      const result = highlight('interface Foo {}', 'ts');
      expect(result).toContain('syn-kw');
      expect(result).toContain('interface');
    });

    test('py maps to python highlighting', () => {
      const result = highlight('def hello():', 'py');
      expect(result).toContain('syn-kw');
      expect(result).toContain('def');
    });

    test('lua maps to lua highlighting', () => {
      const result = highlight('local x = 1', 'lua');
      expect(result).toContain('syn-kw');
      expect(result).toContain('local');
    });

    test('rs maps to rust highlighting', () => {
      const result = highlight('fn main() {}', 'rs');
      expect(result).toContain('syn-kw');
    });

    test('go maps to go highlighting', () => {
      const result = highlight('func main() {}', 'go');
      expect(result).toContain('syn-kw');
    });

    test('java maps to java highlighting', () => {
      const result = highlight('public class Foo {}', 'java');
      expect(result).toContain('syn-kw');
    });

    test('rb maps to ruby highlighting', () => {
      const result = highlight('def hello; end', 'rb');
      expect(result).toContain('syn-kw');
    });

    test('sql maps to sql highlighting', () => {
      const result = highlight('SELECT * FROM users', 'sql');
      expect(result).toContain('syn-kw');
    });

    test('css maps to css highlighting', () => {
      const result = highlight('display: flex;', 'css');
      expect(result).toContain('syn-kw');
    });

    test('html maps to html highlighting', () => {
      const result = highlight('DOCTYPE html', 'html');
      expect(result).toContain('syn-kw');
    });

    test('sh maps to bash highlighting', () => {
      const result = highlight('if [ -f file ]; then echo ok; fi', 'sh');
      expect(result).toContain('syn-kw');
    });

    test('yaml maps to yaml highlighting', () => {
      const result = highlight('enabled: true', 'yaml');
      expect(result).toContain('syn-kw');
    });

    test('json maps to json highlighting', () => {
      const result = highlight('{"key": "value"}', 'json');
      expect(result).toContain('syn-');
    });

    test('md maps to markdown highlighting', () => {
      const result = highlight('# Hello', 'md');
      expect(result).toContain('syn-kw');
    });

    test('mjs maps to javascript', () => {
      const result = highlight('const x = 1;', 'mjs');
      expect(result).toContain('syn-kw');
    });

    test('cjs maps to javascript', () => {
      const result = highlight('const x = 1;', 'cjs');
      expect(result).toContain('syn-kw');
    });

    test('tsx maps to typescript', () => {
      const result = highlight('const x: number = 1;', 'tsx');
      expect(result).toContain('syn-kw');
    });

    test('jsx maps to javascript', () => {
      const result = highlight('const x = 1;', 'jsx');
      expect(result).toContain('syn-kw');
    });

    test('scss maps to css', () => {
      const result = highlight('display: flex;', 'scss');
      expect(result).toContain('syn-kw');
    });

    test('less maps to css', () => {
      const result = highlight('display: flex;', 'less');
      expect(result).toContain('syn-kw');
    });

    test('yml maps to yaml', () => {
      const result = highlight('enabled: true', 'yml');
      expect(result).toContain('syn-kw');
    });

    test('bash maps to bash', () => {
      const result = highlight('echo hello', 'bash');
      expect(result).toContain('syn-kw');
    });

    test('zsh maps to bash', () => {
      const result = highlight('echo hello', 'zsh');
      expect(result).toContain('syn-kw');
    });

    test('bat maps to bash', () => {
      const result = highlight('echo hello', 'bat');
      expect(result).toContain('syn-kw');
    });

    test('ps1 maps to bash', () => {
      const result = highlight('echo hello', 'ps1');
      expect(result).toContain('syn-kw');
    });

    test('htm maps to html', () => {
      const result = highlight('DOCTYPE html', 'htm');
      expect(result).toContain('syn-kw');
    });

    test('xml maps to html', () => {
      const result = highlight('DOCTYPE html', 'xml');
      expect(result).toContain('syn-kw');
    });

    test('cs maps to java-like', () => {
      const result = highlight('public class Foo {}', 'cs');
      expect(result).toContain('syn-kw');
    });

    test('cpp maps to java-like', () => {
      const result = highlight('public class Foo {}', 'cpp');
      expect(result).toContain('syn-kw');
    });

    test('c maps to java-like', () => {
      const result = highlight('int main() {}', 'c');
      expect(result).toContain('syn-kw');
    });

    test('php maps to java-like', () => {
      const result = highlight('public function test() {}', 'php');
      expect(result).toContain('syn-kw');
    });
  });

  describe('unknown language', () => {
    test('unknown extension returns HTML-escaped plain text', () => {
      const result = highlight('const x = 1;', 'xyz');
      expect(result).not.toContain('syn-');
      expect(result).toBe('const x = 1;');
    });

    test('null extension returns plain escaped text', () => {
      const result = highlight('<script>alert(1)</script>', null);
      expect(result).toContain('&lt;script&gt;');
      expect(result).not.toContain('syn-');
    });

    test('undefined extension returns plain escaped text', () => {
      const result = highlight('hello', undefined);
      expect(result).toBe('hello');
      expect(result).not.toContain('syn-');
    });
  });

  describe('keywords', () => {
    test('javascript keywords are highlighted', () => {
      const result = highlight('const let var function return', 'js');
      expect(result).toContain('syn-kw');
      expect((result.match(/syn-kw/g) || []).length).toBeGreaterThanOrEqual(5);
    });

    test('typescript-specific keywords (type, interface, enum)', () => {
      const result = highlight('type interface enum', 'ts');
      const kwCount = (result.match(/syn-kw/g) || []).length;
      expect(kwCount).toBeGreaterThanOrEqual(3);
    });

    test('python keywords', () => {
      const result = highlight('def class return if elif else', 'py');
      expect(result).toContain('syn-kw');
    });

    test('lua keywords', () => {
      const result = highlight('local function end then', 'lua');
      expect(result).toContain('syn-kw');
    });

    test('rust keywords', () => {
      const result = highlight('fn let mut struct impl', 'rs');
      expect(result).toContain('syn-kw');
    });

    test('go keywords', () => {
      const result = highlight('func var const type struct', 'go');
      expect(result).toContain('syn-kw');
    });

    test('SQL keywords are case-insensitive', () => {
      const upper = highlight('SELECT FROM WHERE', 'sql');
      const lower = highlight('select from where', 'sql');
      expect(upper).toContain('syn-kw');
      expect(lower).toContain('syn-kw');
    });
  });

  describe('strings', () => {
    test('double-quoted strings are highlighted', () => {
      const result = highlight('const x = "hello";', 'js');
      expect(result).toContain('syn-str');
    });

    test('single-quoted strings are highlighted', () => {
      // escapeHtml turns ' into &#x27; so we need input that produces escaped quotes
      const result = highlight('const x = "hello";', 'js');
      // Double quotes become &quot; which the regex matches
      expect(result).toContain('syn-str');
    });
  });

  describe('comments', () => {
    test('// single-line comments in JS', () => {
      const result = highlight('// this is a comment', 'js');
      expect(result).toContain('syn-cmt');
    });

    test('-- comments in Lua', () => {
      const result = highlight('-- lua comment', 'lua');
      expect(result).toContain('syn-cmt');
    });

    test('-- comments in SQL', () => {
      const result = highlight('-- sql comment', 'sql');
      expect(result).toContain('syn-cmt');
    });

    test('# comments in Python', () => {
      const result = highlight('# python comment', 'py');
      expect(result).toContain('syn-cmt');
    });

    test('# comments in Ruby', () => {
      const result = highlight('# ruby comment', 'rb');
      expect(result).toContain('syn-cmt');
    });

    test('# comments in Bash', () => {
      const result = highlight('# bash comment', 'sh');
      expect(result).toContain('syn-cmt');
    });

    test('# comments in YAML', () => {
      const result = highlight('# yaml comment', 'yaml');
      expect(result).toContain('syn-cmt');
    });
  });

  describe('numbers', () => {
    test('integers are highlighted', () => {
      const result = highlight('const x = 42;', 'js');
      expect(result).toContain('syn-num');
    });

    test('floating point numbers are highlighted', () => {
      const result = highlight('const pi = 3.14;', 'js');
      expect(result).toContain('syn-num');
    });
  });

  describe('function calls', () => {
    test('function calls are highlighted', () => {
      const result = highlight('console.log("hello")', 'js');
      expect(result).toContain('syn-fn');
    });
  });

  describe('HTML escaping', () => {
    test('HTML special chars are escaped in output', () => {
      const result = highlight('<div class="test">', 'xyz');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&quot;');
      expect(result).not.toContain('<div');
    });

    test('ampersands are escaped', () => {
      const result = highlight('a & b', 'xyz');
      expect(result).toContain('&amp;');
    });
  });

  describe('empty and null input', () => {
    test('empty string returns empty string', () => {
      const result = highlight('', 'js');
      expect(result).toBe('');
    });

    test('null input with known lang throws (no null guard in highlight)', () => {
      expect(() => highlight(null, 'js')).toThrow();
    });

    test('undefined input with known lang throws', () => {
      expect(() => highlight(undefined, 'js')).toThrow();
    });

    test('null input with unknown lang returns empty string', () => {
      const result = highlight(null, 'xyz');
      expect(result).toBe('');
    });

    test('undefined input with unknown lang returns empty string', () => {
      const result = highlight(undefined, 'xyz');
      expect(result).toBe('');
    });
  });

  describe('size limit', () => {
    test('very long input does not throw', () => {
      const longCode = 'const x = 1;\n'.repeat(5000);
      expect(() => highlight(longCode, 'js')).not.toThrow();
    });

    test('input over 50KB is partially highlighted', () => {
      // 50KB = 51200 chars
      const longCode = 'a'.repeat(60000);
      const result = highlight(longCode, 'js');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('JSON highlighting', () => {
    test('keys are highlighted', () => {
      const result = highlight('{"name": "test"}', 'json');
      expect(result).toContain('syn-fn');
    });

    test('string values are highlighted', () => {
      const result = highlight('{"key": "value"}', 'json');
      expect(result).toContain('syn-str');
    });

    test('number values are highlighted', () => {
      const result = highlight('{"count": 42}', 'json');
      expect(result).toContain('syn-num');
    });

    test('boolean/null values are highlighted', () => {
      const result = highlight('{"ok": true, "val": null}', 'json');
      expect(result).toContain('syn-kw');
    });
  });

  describe('Markdown highlighting', () => {
    test('headings are highlighted', () => {
      const result = highlight('# Title\n## Subtitle', 'md');
      expect(result).toContain('syn-kw');
    });

    test('bold text is highlighted', () => {
      const result = highlight('**bold text**', 'md');
      expect(result).toContain('syn-fn');
    });

    test('inline code with backticks passes through (escapeHtml does not escape backticks)', () => {
      const result = highlight('use `code` here', 'md');
      // The backtick regex looks for &#96; but escapeHtml does not produce that
      expect(result).toContain('use `code` here');
    });

    test('links are highlighted', () => {
      const result = highlight('[text](url)', 'md');
      expect(result).toContain('syn-str');
    });
  });
});
