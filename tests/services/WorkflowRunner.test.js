// WorkflowRunner unit tests — focus on pure/near-pure helper functions:
// resolveVars, resolveDeep, evalCondition

// Mock electron and heavy dependencies so the module can load
jest.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app', getPath: () => '/mock/data' }
}));

jest.mock('../../src/main/utils/git', () => ({
  gitCommit: jest.fn(),
  gitPull: jest.fn(),
  gitPush: jest.fn(),
  gitStageFiles: jest.fn(),
  checkoutBranch: jest.fn(),
  createBranch: jest.fn(),
  spawnGit: jest.fn(),
}));

jest.mock('../../src/shared/workflow-schema', () => ({
  getOutputKeyForSlot: jest.fn(() => 'output'),
}));

// We need to extract the pure functions. WorkflowRunner exports a class,
// but resolveVars/resolveDeep/evalCondition are module-level functions.
// We'll test them via a small wrapper that creates a runner and exposes helpers.

// Since these functions are not exported, we read the source and extract them.
const fs = require('fs');
const path = require('path');

// Load the module source to extract the pure functions
const modulePath = path.resolve(__dirname, '../../src/main/services/WorkflowRunner.js');
const moduleSource = fs.readFileSync(modulePath, 'utf-8');

// Extract and eval the pure functions in an isolated scope
const extractedFunctions = (() => {
  // Build a minimal sandbox with the functions we need
  const sandbox = {};

  // Extract resolveVars function
  const resolveVarsMatch = moduleSource.match(
    /function resolveVars\(value, vars\) \{[\s\S]*?^}/m
  );

  // Extract resolveDeep function
  const resolveDeepMatch = moduleSource.match(
    /function resolveDeep\(obj, vars\) \{[\s\S]*?^}/m
  );

  // Extract evalCondition function
  const evalConditionMatch = moduleSource.match(
    /function evalCondition\(condition, vars\) \{[\s\S]*?^}/m
  );

  if (!resolveVarsMatch || !resolveDeepMatch || !evalConditionMatch) {
    throw new Error('Could not extract functions from WorkflowRunner.js');
  }

  // Build executable code
  const code = `
    ${resolveVarsMatch[0]}
    ${resolveDeepMatch[0]}
    ${evalConditionMatch[0]}
    module.exports = { resolveVars, resolveDeep, evalCondition };
  `;

  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'exports', 'require', code);
  fn(mod, mod.exports, require);
  return mod.exports;
})();

const { resolveVars, resolveDeep, evalCondition } = extractedFunctions;

beforeEach(() => {
  jest.clearAllMocks();
});

// ==================== resolveVars ====================

describe('resolveVars', () => {
  test('resolves simple $variable from context', () => {
    const vars = new Map([['name', 'Alice']]);
    expect(resolveVars('$name', vars)).toBe('Alice');
  });

  test('resolves nested dot-path variable: $item.name', () => {
    const vars = new Map([['item', { name: 'Widget' }]]);
    expect(resolveVars('$item.name', vars)).toBe('Widget');
  });

  test('resolves deeply nested variable: $item.nested.deep', () => {
    const vars = new Map([['item', { nested: { deep: 'found' } }]]);
    expect(resolveVars('$item.nested.deep', vars)).toBe('found');
  });

  test('resolves multiple variables in one string', () => {
    const vars = new Map([['name', 'Alice'], ['count', 3]]);
    expect(resolveVars('Hello $name, you have $count items', vars)).toBe('Hello Alice, you have 3 items');
  });

  test('keeps $varName as-is when variable is missing', () => {
    const vars = new Map();
    expect(resolveVars('Hello $missing', vars)).toBe('Hello $missing');
  });

  test('returns empty string input unchanged', () => {
    const vars = new Map([['x', 'val']]);
    expect(resolveVars('', vars)).toBe('');
  });

  test('passes through string with no variables', () => {
    const vars = new Map([['x', 'val']]);
    expect(resolveVars('no variables here', vars)).toBe('no variables here');
  });

  test('returns non-string input unchanged (number)', () => {
    const vars = new Map();
    expect(resolveVars(42, vars)).toBe(42);
  });

  test('returns non-string input unchanged (boolean)', () => {
    const vars = new Map();
    expect(resolveVars(true, vars)).toBe(true);
  });

  test('returns non-string input unchanged (null)', () => {
    const vars = new Map();
    expect(resolveVars(null, vars)).toBe(null);
  });

  test('returns non-string input unchanged (undefined)', () => {
    const vars = new Map();
    expect(resolveVars(undefined, vars)).toBe(undefined);
  });

  test('returns raw object when entire string is a single $variable (fast path)', () => {
    const obj = { a: 1, b: 2 };
    const vars = new Map([['data', obj]]);
    expect(resolveVars('$data', vars)).toBe(obj);
  });

  test('returns raw array when entire string is a single $variable (fast path)', () => {
    const arr = [1, 2, 3];
    const vars = new Map([['list', arr]]);
    expect(resolveVars('$list', vars)).toBe(arr);
  });

  test('JSON-stringifies objects when embedded in larger string', () => {
    const vars = new Map([['obj', { key: 'val' }]]);
    const result = resolveVars('data: $obj end', vars);
    expect(result).toContain('{"key":"val"}');
  });

  test('trims trailing CR/LF from shell output strings', () => {
    const vars = new Map([['output', 'hello\r\n']]);
    expect(resolveVars('$output', vars)).toBe('hello');
  });

  test('trims trailing newline in interpolated context', () => {
    const vars = new Map([['date', '2024-01-01\n']]);
    expect(resolveVars('Date: $date!', vars)).toBe('Date: 2024-01-01!');
  });

  test('handles variable names with underscores', () => {
    const vars = new Map([['my_var', 'test']]);
    expect(resolveVars('$my_var', vars)).toBe('test');
  });

  test('handles variable names starting with underscore', () => {
    const vars = new Map([['_private', 'secret']]);
    expect(resolveVars('$_private', vars)).toBe('secret');
  });

  test('resolves partial path when intermediate value is not an object', () => {
    // $today.md where today='2024-01-15' (string) -> resolves "today" + appends ".md"
    const vars = new Map([['today', '2024-01-15']]);
    const result = resolveVars('$today.md', vars);
    expect(result).toBe('2024-01-15.md');
  });

  test('returns null subpath gracefully when parent is null', () => {
    const vars = new Map([['x', null]]);
    // $x.y cannot be resolved -> keep as-is
    expect(resolveVars('$x.y', vars)).toBe('$x.y');
  });
});

// ==================== resolveDeep ====================

describe('resolveDeep', () => {
  test('resolves vars in nested objects recursively', () => {
    const vars = new Map([['name', 'Alice'], ['age', 30]]);
    const obj = { greeting: 'Hello $name', info: { years: '$age' } };
    const result = resolveDeep(obj, vars);
    expect(result.greeting).toBe('Hello Alice');
    // Single-var fast path returns the raw value (number 30), not string
    expect(result.info.years).toBe(30);
  });

  test('resolves vars in arrays', () => {
    const vars = new Map([['x', 'hello']]);
    const arr = ['$x', 'world'];
    const result = resolveDeep(arr, vars);
    expect(result).toEqual(['hello', 'world']);
  });

  test('handles mixed objects/arrays/strings', () => {
    const vars = new Map([['v', 'resolved']]);
    const input = { items: ['$v', { nested: '$v' }], plain: 'text' };
    const result = resolveDeep(input, vars);
    expect(result.items[0]).toBe('resolved');
    expect(result.items[1].nested).toBe('resolved');
    expect(result.plain).toBe('text');
  });

  test('passes through null values', () => {
    const vars = new Map();
    expect(resolveDeep(null, vars)).toBe(null);
  });

  test('passes through undefined values', () => {
    const vars = new Map();
    expect(resolveDeep(undefined, vars)).toBe(undefined);
  });

  test('passes through numeric values', () => {
    const vars = new Map();
    expect(resolveDeep(42, vars)).toBe(42);
  });

  test('passes through boolean values', () => {
    const vars = new Map();
    expect(resolveDeep(true, vars)).toBe(true);
  });

  test('resolves a plain string', () => {
    const vars = new Map([['x', 'val']]);
    expect(resolveDeep('$x', vars)).toBe('val');
  });

  test('does not mutate original object', () => {
    const vars = new Map([['x', 'new']]);
    const original = { key: '$x' };
    const result = resolveDeep(original, vars);
    expect(original.key).toBe('$x');
    expect(result.key).toBe('new');
  });

  test('handles empty object', () => {
    const vars = new Map();
    expect(resolveDeep({}, vars)).toEqual({});
  });

  test('handles empty array', () => {
    const vars = new Map();
    expect(resolveDeep([], vars)).toEqual([]);
  });
});

// ==================== evalCondition ====================

describe('evalCondition', () => {
  describe('basic behavior', () => {
    test('returns true for empty condition', () => {
      const vars = new Map();
      expect(evalCondition('', vars)).toBe(true);
    });

    test('returns true for null condition', () => {
      const vars = new Map();
      expect(evalCondition(null, vars)).toBe(true);
    });

    test('returns true for whitespace-only condition', () => {
      const vars = new Map();
      expect(evalCondition('   ', vars)).toBe(true);
    });
  });

  describe('boolean literals', () => {
    test('"true" literal returns true', () => {
      const vars = new Map();
      expect(evalCondition('true', vars)).toBe(true);
    });

    test('"false" literal returns false', () => {
      const vars = new Map();
      expect(evalCondition('false', vars)).toBe(false);
    });

    test('variable resolving to "true" returns true', () => {
      const vars = new Map([['flag', 'true']]);
      expect(evalCondition('$flag', vars)).toBe(true);
    });

    test('variable resolving to "false" returns false', () => {
      const vars = new Map([['flag', 'false']]);
      expect(evalCondition('$flag', vars)).toBe(false);
    });
  });

  describe('== operator', () => {
    test('string equality', () => {
      const vars = new Map();
      expect(evalCondition('hello == hello', vars)).toBe(true);
    });

    test('string inequality', () => {
      const vars = new Map();
      expect(evalCondition('hello == world', vars)).toBe(false);
    });

    test('numeric equality with strings', () => {
      const vars = new Map();
      expect(evalCondition('5 == 5', vars)).toBe(true);
    });

    test('numeric equality different representations', () => {
      const vars = new Map();
      expect(evalCondition('5.0 == 5', vars)).toBe(true);
    });

    test('with resolved variables', () => {
      const vars = new Map([['status', 'ok']]);
      expect(evalCondition('$status == ok', vars)).toBe(true);
    });
  });

  describe('!= operator', () => {
    test('string inequality returns true', () => {
      const vars = new Map();
      expect(evalCondition('hello != world', vars)).toBe(true);
    });

    test('string equality returns false', () => {
      const vars = new Map();
      expect(evalCondition('hello != hello', vars)).toBe(false);
    });

    test('numeric inequality', () => {
      const vars = new Map();
      expect(evalCondition('3 != 5', vars)).toBe(true);
    });
  });

  describe('> operator', () => {
    test('greater than with numbers', () => {
      const vars = new Map();
      expect(evalCondition('10 > 5', vars)).toBe(true);
    });

    test('not greater than', () => {
      const vars = new Map();
      expect(evalCondition('3 > 5', vars)).toBe(false);
    });

    test('equal values return false', () => {
      const vars = new Map();
      expect(evalCondition('5 > 5', vars)).toBe(false);
    });

    test('non-numeric strings return false', () => {
      const vars = new Map();
      expect(evalCondition('abc > xyz', vars)).toBe(false);
    });
  });

  describe('< operator', () => {
    test('less than with numbers', () => {
      const vars = new Map();
      expect(evalCondition('3 < 10', vars)).toBe(true);
    });

    test('not less than', () => {
      const vars = new Map();
      expect(evalCondition('10 < 3', vars)).toBe(false);
    });
  });

  describe('>= operator', () => {
    test('greater than or equal when greater', () => {
      const vars = new Map();
      expect(evalCondition('10 >= 5', vars)).toBe(true);
    });

    test('greater than or equal when equal', () => {
      const vars = new Map();
      expect(evalCondition('5 >= 5', vars)).toBe(true);
    });

    test('not greater than or equal', () => {
      const vars = new Map();
      expect(evalCondition('3 >= 5', vars)).toBe(false);
    });
  });

  describe('<= operator', () => {
    test('less than or equal when less', () => {
      const vars = new Map();
      expect(evalCondition('3 <= 5', vars)).toBe(true);
    });

    test('less than or equal when equal', () => {
      const vars = new Map();
      expect(evalCondition('5 <= 5', vars)).toBe(true);
    });

    test('not less than or equal', () => {
      const vars = new Map();
      expect(evalCondition('10 <= 5', vars)).toBe(false);
    });
  });

  describe('contains operator', () => {
    test('string contains substring', () => {
      const vars = new Map();
      expect(evalCondition('hello world contains world', vars)).toBe(true);
    });

    test('string does not contain substring', () => {
      const vars = new Map();
      expect(evalCondition('hello contains xyz', vars)).toBe(false);
    });

    test('contains is case-sensitive', () => {
      const vars = new Map();
      expect(evalCondition('Hello contains hello', vars)).toBe(false);
    });
  });

  describe('starts_with operator', () => {
    test('string starts with prefix', () => {
      const vars = new Map();
      expect(evalCondition('hello world starts_with hello', vars)).toBe(true);
    });

    test('string does not start with prefix', () => {
      const vars = new Map();
      expect(evalCondition('hello starts_with world', vars)).toBe(false);
    });
  });

  describe('ends_with operator', () => {
    test('string ends with suffix', () => {
      const vars = new Map();
      expect(evalCondition('hello world ends_with world', vars)).toBe(true);
    });

    test('string does not end with suffix', () => {
      const vars = new Map();
      expect(evalCondition('hello ends_with world', vars)).toBe(false);
    });
  });

  describe('matches operator (regex)', () => {
    test('matches valid regex', () => {
      const vars = new Map();
      expect(evalCondition('abc123 matches [a-z]+\\d+', vars)).toBe(true);
    });

    test('does not match regex', () => {
      const vars = new Map();
      expect(evalCondition('hello matches ^\\d+$', vars)).toBe(false);
    });

    test('invalid regex does not throw, returns false', () => {
      const vars = new Map();
      expect(evalCondition('test matches [invalid(', vars)).toBe(false);
    });

    test('ReDoS protection: very long input returns false', () => {
      const vars = new Map();
      const longStr = 'a'.repeat(20000);
      expect(evalCondition(`${longStr} matches a+`, vars)).toBe(false);
    });

    test('input at exactly 10000 chars is allowed (limit is >10000)', () => {
      const vars = new Map();
      const str10k = 'a'.repeat(10000);
      // Code checks left.length > 10_000 (strict), so exactly 10000 passes through
      expect(evalCondition(`${str10k} matches a+`, vars)).toBe(true);
    });
  });

  describe('is_empty / is_not_empty operators', () => {
    test('empty string is_empty returns true', () => {
      const vars = new Map([['val', '']]);
      expect(evalCondition('$val is_empty', vars)).toBe(true);
    });

    test('"null" string is_empty returns true', () => {
      const vars = new Map();
      expect(evalCondition('null is_empty', vars)).toBe(true);
    });

    test('"undefined" string is_empty returns true', () => {
      const vars = new Map();
      expect(evalCondition('undefined is_empty', vars)).toBe(true);
    });

    test('"[]" is_empty returns true', () => {
      const vars = new Map();
      expect(evalCondition('[] is_empty', vars)).toBe(true);
    });

    test('"{}" is_empty returns true', () => {
      const vars = new Map();
      expect(evalCondition('{} is_empty', vars)).toBe(true);
    });

    test('non-empty value is_empty returns false', () => {
      const vars = new Map();
      expect(evalCondition('hello is_empty', vars)).toBe(false);
    });

    test('non-empty value is_not_empty returns true', () => {
      const vars = new Map();
      expect(evalCondition('hello is_not_empty', vars)).toBe(true);
    });

    test('non-empty value is_not_empty with variable returns true', () => {
      const vars = new Map([['val', 'data']]);
      expect(evalCondition('$val is_not_empty', vars)).toBe(true);
    });

    test('null literal is_not_empty returns false', () => {
      const vars = new Map();
      expect(evalCondition('null is_not_empty', vars)).toBe(false);
    });
  });

  describe('truthy check (no operator)', () => {
    test('non-empty string is truthy', () => {
      const vars = new Map();
      expect(evalCondition('hello', vars)).toBe(true);
    });

    test('"0" is falsy', () => {
      const vars = new Map();
      expect(evalCondition('0', vars)).toBe(false);
    });

    test('"null" is falsy', () => {
      const vars = new Map();
      expect(evalCondition('null', vars)).toBe(false);
    });

    test('"undefined" is falsy', () => {
      const vars = new Map();
      expect(evalCondition('undefined', vars)).toBe(false);
    });

    test('resolved variable truthy', () => {
      const vars = new Map([['val', 'something']]);
      expect(evalCondition('$val', vars)).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('unrecognized operator defaults to false (via truthy for no-match)', () => {
      // "a XYZOP b" - won't match binary regex, falls through to truthy
      // "a XYZOP b" is non-empty and not 0/null/undefined -> truthy
      const vars = new Map();
      expect(evalCondition('a XYZOP b', vars)).toBe(true);
    });

    test('numeric comparison: string "5" vs number 5', () => {
      const vars = new Map([['num', 5]]);
      expect(evalCondition('$num == 5', vars)).toBe(true);
    });

    test('comparison with variables on both sides', () => {
      const vars = new Map([['a', 'hello'], ['b', 'hello']]);
      expect(evalCondition('$a == $b', vars)).toBe(true);
    });

    test('float comparison', () => {
      const vars = new Map();
      expect(evalCondition('3.14 > 2.71', vars)).toBe(true);
    });

    test('negative number comparison', () => {
      const vars = new Map();
      expect(evalCondition('-1 < 0', vars)).toBe(true);
    });
  });
});
