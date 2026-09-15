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

const { resolveVars, resolveDeep } = require('../../src/shared/workflow-variables');
const { evalCondition } = require('../../src/shared/workflow-condition');

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
    test('returns true for empty condition', async () => {
      const vars = new Map();
      expect(await evalCondition('', vars)).toBe(true);
    });

    test('returns true for null condition', async () => {
      const vars = new Map();
      expect(await evalCondition(null, vars)).toBe(true);
    });

    test('returns true for whitespace-only condition', async () => {
      const vars = new Map();
      expect(await evalCondition('   ', vars)).toBe(true);
    });
  });

  describe('boolean literals', () => {
    test('"true" literal returns true', async () => {
      const vars = new Map();
      expect(await evalCondition('true', vars)).toBe(true);
    });

    test('"false" literal returns false', async () => {
      const vars = new Map();
      expect(await evalCondition('false', vars)).toBe(false);
    });

    test('variable resolving to "true" returns true', async () => {
      const vars = new Map([['flag', 'true']]);
      expect(await evalCondition('$flag', vars)).toBe(true);
    });

    test('variable resolving to "false" returns false', async () => {
      const vars = new Map([['flag', 'false']]);
      expect(await evalCondition('$flag', vars)).toBe(false);
    });
  });

  describe('== operator', () => {
    test('string equality', async () => {
      const vars = new Map();
      expect(await evalCondition('hello == hello', vars)).toBe(true);
    });

    test('string inequality', async () => {
      const vars = new Map();
      expect(await evalCondition('hello == world', vars)).toBe(false);
    });

    test('numeric equality with strings', async () => {
      const vars = new Map();
      expect(await evalCondition('5 == 5', vars)).toBe(true);
    });

    test('numeric equality different representations', async () => {
      const vars = new Map();
      expect(await evalCondition('5.0 == 5', vars)).toBe(true);
    });

    test('with resolved variables', async () => {
      const vars = new Map([['status', 'ok']]);
      expect(await evalCondition('$status == ok', vars)).toBe(true);
    });
  });

  describe('!= operator', () => {
    test('string inequality returns true', async () => {
      const vars = new Map();
      expect(await evalCondition('hello != world', vars)).toBe(true);
    });

    test('string equality returns false', async () => {
      const vars = new Map();
      expect(await evalCondition('hello != hello', vars)).toBe(false);
    });

    test('numeric inequality', async () => {
      const vars = new Map();
      expect(await evalCondition('3 != 5', vars)).toBe(true);
    });
  });

  describe('> operator', () => {
    test('greater than with numbers', async () => {
      const vars = new Map();
      expect(await evalCondition('10 > 5', vars)).toBe(true);
    });

    test('not greater than', async () => {
      const vars = new Map();
      expect(await evalCondition('3 > 5', vars)).toBe(false);
    });

    test('equal values return false', async () => {
      const vars = new Map();
      expect(await evalCondition('5 > 5', vars)).toBe(false);
    });

    test('non-numeric strings return false', async () => {
      const vars = new Map();
      expect(await evalCondition('abc > xyz', vars)).toBe(false);
    });
  });

  describe('< operator', () => {
    test('less than with numbers', async () => {
      const vars = new Map();
      expect(await evalCondition('3 < 10', vars)).toBe(true);
    });

    test('not less than', async () => {
      const vars = new Map();
      expect(await evalCondition('10 < 3', vars)).toBe(false);
    });
  });

  describe('>= operator', () => {
    test('greater than or equal when greater', async () => {
      const vars = new Map();
      expect(await evalCondition('10 >= 5', vars)).toBe(true);
    });

    test('greater than or equal when equal', async () => {
      const vars = new Map();
      expect(await evalCondition('5 >= 5', vars)).toBe(true);
    });

    test('not greater than or equal', async () => {
      const vars = new Map();
      expect(await evalCondition('3 >= 5', vars)).toBe(false);
    });
  });

  describe('<= operator', () => {
    test('less than or equal when less', async () => {
      const vars = new Map();
      expect(await evalCondition('3 <= 5', vars)).toBe(true);
    });

    test('less than or equal when equal', async () => {
      const vars = new Map();
      expect(await evalCondition('5 <= 5', vars)).toBe(true);
    });

    test('not less than or equal', async () => {
      const vars = new Map();
      expect(await evalCondition('10 <= 5', vars)).toBe(false);
    });
  });

  describe('contains operator', () => {
    test('string contains substring', async () => {
      const vars = new Map();
      expect(await evalCondition('hello world contains world', vars)).toBe(true);
    });

    test('string does not contain substring', async () => {
      const vars = new Map();
      expect(await evalCondition('hello contains xyz', vars)).toBe(false);
    });

    test('contains is case-sensitive', async () => {
      const vars = new Map();
      expect(await evalCondition('Hello contains hello', vars)).toBe(false);
    });
  });

  describe('starts_with operator', () => {
    test('string starts with prefix', async () => {
      const vars = new Map();
      expect(await evalCondition('hello world starts_with hello', vars)).toBe(true);
    });

    test('string does not start with prefix', async () => {
      const vars = new Map();
      expect(await evalCondition('hello starts_with world', vars)).toBe(false);
    });
  });

  describe('ends_with operator', () => {
    test('string ends with suffix', async () => {
      const vars = new Map();
      expect(await evalCondition('hello world ends_with world', vars)).toBe(true);
    });

    test('string does not end with suffix', async () => {
      const vars = new Map();
      expect(await evalCondition('hello ends_with world', vars)).toBe(false);
    });
  });

  describe('matches operator (regex)', () => {
    test('matches valid regex', async () => {
      const vars = new Map();
      expect(await evalCondition('abc123 matches [a-z]+\\d+', vars)).toBe(true);
    });

    test('does not match regex', async () => {
      const vars = new Map();
      expect(await evalCondition('hello matches ^\\d+$', vars)).toBe(false);
    });

    test('invalid regex does not throw, returns false', async () => {
      const vars = new Map();
      expect(await evalCondition('test matches [invalid(', vars)).toBe(false);
    });

    test('ReDoS protection: very long input returns false', async () => {
      const vars = new Map();
      const longStr = 'a'.repeat(20000);
      expect(await evalCondition(`${longStr} matches a+`, vars)).toBe(false);
    });

    test('input at exactly 10000 chars is allowed (limit is >10000)', async () => {
      const vars = new Map();
      const str10k = 'a'.repeat(10000);
      // Code checks left.length > 10_000 (strict), so exactly 10000 passes through
      expect(await evalCondition(`${str10k} matches a+`, vars)).toBe(true);
    });
  });

  describe('is_empty / is_not_empty operators', () => {
    test('empty string is_empty returns true', async () => {
      const vars = new Map([['val', '']]);
      expect(await evalCondition('$val is_empty', vars)).toBe(true);
    });

    test('"null" string is_empty returns true', async () => {
      const vars = new Map();
      expect(await evalCondition('null is_empty', vars)).toBe(true);
    });

    test('"undefined" string is_empty returns true', async () => {
      const vars = new Map();
      expect(await evalCondition('undefined is_empty', vars)).toBe(true);
    });

    test('"[]" is_empty returns true', async () => {
      const vars = new Map();
      expect(await evalCondition('[] is_empty', vars)).toBe(true);
    });

    test('"{}" is_empty returns true', async () => {
      const vars = new Map();
      expect(await evalCondition('{} is_empty', vars)).toBe(true);
    });

    test('non-empty value is_empty returns false', async () => {
      const vars = new Map();
      expect(await evalCondition('hello is_empty', vars)).toBe(false);
    });

    test('non-empty value is_not_empty returns true', async () => {
      const vars = new Map();
      expect(await evalCondition('hello is_not_empty', vars)).toBe(true);
    });

    test('non-empty value is_not_empty with variable returns true', async () => {
      const vars = new Map([['val', 'data']]);
      expect(await evalCondition('$val is_not_empty', vars)).toBe(true);
    });

    test('null literal is_not_empty returns false', async () => {
      const vars = new Map();
      expect(await evalCondition('null is_not_empty', vars)).toBe(false);
    });
  });

  describe('truthy check (no operator)', () => {
    test('non-empty string is truthy', async () => {
      const vars = new Map();
      expect(await evalCondition('hello', vars)).toBe(true);
    });

    test('"0" is falsy', async () => {
      const vars = new Map();
      expect(await evalCondition('0', vars)).toBe(false);
    });

    test('"null" is falsy', async () => {
      const vars = new Map();
      expect(await evalCondition('null', vars)).toBe(false);
    });

    test('"undefined" is falsy', async () => {
      const vars = new Map();
      expect(await evalCondition('undefined', vars)).toBe(false);
    });

    test('resolved variable truthy', async () => {
      const vars = new Map([['val', 'something']]);
      expect(await evalCondition('$val', vars)).toBe(true);
    });
  });

  describe('edge cases', () => {
    test('unrecognized operator defaults to false (via truthy for no-match)', async () => {
      // "a XYZOP b" - won't match binary regex, falls through to truthy
      // "a XYZOP b" is non-empty and not 0/null/undefined -> truthy
      const vars = new Map();
      expect(await evalCondition('a XYZOP b', vars)).toBe(true);
    });

    test('numeric comparison: string "5" vs number 5', async () => {
      const vars = new Map([['num', 5]]);
      expect(await evalCondition('$num == 5', vars)).toBe(true);
    });

    test('comparison with variables on both sides', async () => {
      const vars = new Map([['a', 'hello'], ['b', 'hello']]);
      expect(await evalCondition('$a == $b', vars)).toBe(true);
    });

    test('float comparison', async () => {
      const vars = new Map();
      expect(await evalCondition('3.14 > 2.71', vars)).toBe(true);
    });

    test('negative number comparison', async () => {
      const vars = new Map();
      expect(await evalCondition('-1 < 0', vars)).toBe(true);
    });
  });
});
