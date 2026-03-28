const { highlight, LANG_MAP } = require('../../src/renderer/utils/syntaxHighlight');

describe('highlight', () => {
  describe('language detection by extension', () => {
    test('js maps to javascript highlighting', () => {
      const result = highlight('const x = 1;', 'js');
      expect(result).toContain('hljs-');
      expect(result).toContain('const');
    });

    test('ts maps to typescript highlighting', () => {
      const result = highlight('interface Foo {}', 'ts');
      expect(result).toContain('hljs-');
      expect(result).toContain('interface');
    });

    test('py maps to python highlighting', () => {
      const result = highlight('def hello():', 'py');
      expect(result).toContain('hljs-');
      expect(result).toContain('def');
    });

    test('lua maps to lua highlighting', () => {
      const result = highlight('local x = 1', 'lua');
      expect(result).toContain('hljs-');
      expect(result).toContain('local');
    });

    test('rs maps to rust highlighting', () => {
      const result = highlight('fn main() {}', 'rs');
      expect(result).toContain('hljs-');
    });

    test('go maps to go highlighting', () => {
      const result = highlight('func main() {}', 'go');
      expect(result).toContain('hljs-');
    });

    test('java maps to java highlighting', () => {
      const result = highlight('public class Foo {}', 'java');
      expect(result).toContain('hljs-');
    });

    test('rb maps to ruby highlighting', () => {
      const result = highlight('def hello; end', 'rb');
      expect(result).toContain('hljs-');
    });

    test('sql maps to sql highlighting', () => {
      const result = highlight('SELECT * FROM users', 'sql');
      expect(result).toContain('hljs-');
    });

    test('css maps to css highlighting', () => {
      const result = highlight('.foo { display: flex; }', 'css');
      expect(result).toContain('hljs-');
    });

    test('html maps to xml highlighting', () => {
      const result = highlight('<div class="test">hello</div>', 'html');
      expect(result).toContain('hljs-');
    });

    test('sh maps to bash highlighting', () => {
      const result = highlight('if [ -f file ]; then echo ok; fi', 'sh');
      expect(result).toContain('hljs-');
    });

    test('yaml maps to yaml highlighting', () => {
      const result = highlight('key: value', 'yaml');
      expect(result).toContain('hljs-');
    });

    test('json maps to json highlighting', () => {
      const result = highlight('{"key": "value"}', 'json');
      expect(result).toContain('hljs-');
    });

    test('md maps to markdown highlighting', () => {
      const result = highlight('# Hello', 'md');
      expect(result).toContain('hljs-');
    });

    test('mjs maps to javascript', () => {
      const result = highlight('const x = 1;', 'mjs');
      expect(result).toContain('hljs-');
    });

    test('cjs maps to javascript', () => {
      const result = highlight('const x = 1;', 'cjs');
      expect(result).toContain('hljs-');
    });

    test('tsx maps to typescript', () => {
      const result = highlight('const x: number = 1;', 'tsx');
      expect(result).toContain('hljs-');
    });

    test('jsx maps to javascript', () => {
      const result = highlight('const x = 1;', 'jsx');
      expect(result).toContain('hljs-');
    });

    test('scss maps to scss', () => {
      const result = highlight('$color: red; .foo { color: $color; }', 'scss');
      expect(result).toContain('hljs-');
    });

    test('less maps to less', () => {
      const result = highlight('@color: red; .foo { color: @color; }', 'less');
      expect(result).toContain('hljs-');
    });

    test('yml maps to yaml', () => {
      const result = highlight('key: value', 'yml');
      expect(result).toContain('hljs-');
    });

    test('bash maps to bash', () => {
      const result = highlight('echo hello', 'bash');
      expect(result).toContain('hljs-');
    });

    test('zsh maps to bash', () => {
      const result = highlight('echo hello', 'zsh');
      expect(result).toContain('hljs-');
    });

    test('bat maps to powershell', () => {
      const result = highlight('Write-Host hello', 'bat');
      expect(result).toContain('hljs-');
    });

    test('ps1 maps to powershell', () => {
      const result = highlight('Write-Host hello', 'ps1');
      expect(result).toContain('hljs-');
    });

    test('htm maps to xml', () => {
      const result = highlight('<p>hello</p>', 'htm');
      expect(result).toContain('hljs-');
    });

    test('xml maps to xml', () => {
      const result = highlight('<root><child/></root>', 'xml');
      expect(result).toContain('hljs-');
    });

    test('cs maps to csharp', () => {
      const result = highlight('public class Foo {}', 'cs');
      expect(result).toContain('hljs-');
    });

    test('cpp maps to cpp', () => {
      const result = highlight('#include <iostream>\nint main() {}', 'cpp');
      expect(result).toContain('hljs-');
    });

    test('c maps to c', () => {
      const result = highlight('int main() { return 0; }', 'c');
      expect(result).toContain('hljs-');
    });

    test('php maps to php', () => {
      const result = highlight('<?php echo "hello"; ?>', 'php');
      expect(result).toContain('hljs-');
    });

    test('diff extension works', () => {
      const result = highlight('+added\n-removed', 'diff');
      expect(result).toContain('hljs-');
    });
  });

  describe('new languages (not in old system)', () => {
    test('kotlin highlighting', () => {
      const result = highlight('fun main() { println("hello") }', 'kt');
      expect(result).toContain('hljs-');
    });

    test('swift highlighting', () => {
      const result = highlight('func hello() -> String { return "hi" }', 'swift');
      expect(result).toContain('hljs-');
    });

    test('csharp has own grammar (not java)', () => {
      const result = highlight('var x = new List<string>();', 'cs');
      expect(result).toContain('hljs-');
    });

    test('powershell is distinct from bash', () => {
      const result = highlight('Get-ChildItem | Where-Object { $_.Name }', 'ps1');
      expect(result).toContain('hljs-');
    });
  });

  describe('unknown language', () => {
    test('unknown extension returns HTML-escaped plain text', () => {
      const result = highlight('const x = 1;', 'xyz');
      expect(result).not.toContain('hljs-');
      expect(result).toBe('const x = 1;');
    });

    test('null extension returns plain escaped text', () => {
      const result = highlight('<script>alert(1)</script>', null);
      expect(result).toContain('&lt;script&gt;');
      expect(result).not.toContain('hljs-');
    });

    test('undefined extension returns plain escaped text', () => {
      const result = highlight('hello', undefined);
      expect(result).toBe('hello');
      expect(result).not.toContain('hljs-');
    });
  });

  describe('token types', () => {
    test('keywords are highlighted', () => {
      const result = highlight('const let var function return', 'js');
      expect(result).toContain('hljs-keyword');
    });

    test('strings are highlighted', () => {
      const result = highlight('const x = "hello";', 'js');
      expect(result).toContain('hljs-string');
    });

    test('comments are highlighted', () => {
      const result = highlight('// this is a comment', 'js');
      expect(result).toContain('hljs-comment');
    });

    test('numbers are highlighted', () => {
      const result = highlight('const x = 42;', 'js');
      expect(result).toContain('hljs-number');
    });

    test('function names are highlighted', () => {
      const result = highlight('function hello() {}', 'js');
      expect(result).toContain('hljs-title');
    });
  });

  describe('HTML escaping', () => {
    test('HTML special chars are escaped for unknown lang', () => {
      const result = highlight('<div class="test">', 'xyz');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).toContain('&quot;');
      expect(result).not.toContain('<div');
    });

    test('hljs output does not contain raw dangerous HTML', () => {
      const result = highlight('<script>alert(1)</script>', 'js');
      expect(result).not.toContain('<script>');
    });
  });

  describe('empty and null input', () => {
    test('empty string returns empty string', () => {
      const result = highlight('', 'js');
      expect(result).toBe('');
    });

    test('null input returns empty string', () => {
      const result = highlight(null, 'js');
      expect(result).toBe('');
    });

    test('undefined input returns empty string', () => {
      const result = highlight(undefined, 'js');
      expect(result).toBe('');
    });
  });

  describe('size limit', () => {
    test('very long input does not throw', () => {
      const longCode = 'const x = 1;\n'.repeat(5000);
      expect(() => highlight(longCode, 'js')).not.toThrow();
    });

    test('input over 50KB is partially highlighted', () => {
      const longCode = 'a'.repeat(60000);
      const result = highlight(longCode, 'js');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('LANG_MAP', () => {
    test('contains all expected aliases', () => {
      const expected = ['js', 'ts', 'py', 'lua', 'html', 'css', 'json', 'yaml', 'sh', 'sql', 'rs', 'go', 'java', 'rb', 'cs', 'cpp', 'c', 'php', 'md', 'diff', 'kt', 'swift'];
      for (const alias of expected) {
        expect(LANG_MAP[alias]).toBeDefined();
      }
    });

    test('full language names also work as passthrough', () => {
      expect(LANG_MAP['javascript']).toBe('javascript');
      expect(LANG_MAP['typescript']).toBe('typescript');
      expect(LANG_MAP['python']).toBe('python');
    });
  });
});
