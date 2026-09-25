// The Redis command list shared by the query tab, the MCP server and the editor's completion

const { REDIS_COMMANDS, REDIS_SUBCOMMANDS, isRedisCommandAllowed, tokenizeRedisCommand } = require('../../src/shared/redis-commands');

describe('isRedisCommandAllowed', () => {
  test('allows data commands in any case', () => {
    expect(isRedisCommandAllowed('get', ['k'])).toBe(true);
    expect(isRedisCommandAllowed('HSCAN', ['h', '0'])).toBe(true);
    expect(isRedisCommandAllowed('json.get', ['doc'])).toBe(true);
  });

  test('refuses anything that administers the server or runs code on it', () => {
    for (const cmd of ['flushdb', 'flushall', 'config', 'shutdown', 'debug', 'eval', 'evalsha', 'script', 'function', 'module', 'acl', 'client', 'replicaof', 'migrate', 'save', 'bgsave']) {
      expect(isRedisCommandAllowed(cmd, [])).toBe(false);
    }
  });

  test('a command family is allowed only for its read-only members', () => {
    expect(isRedisCommandAllowed('memory', ['usage', 'k'])).toBe(true);
    expect(isRedisCommandAllowed('MEMORY', ['PURGE'])).toBe(false);
    expect(isRedisCommandAllowed('memory', [])).toBe(false);
    expect(isRedisCommandAllowed('object', ['encoding', 'k'])).toBe(true);
    expect(isRedisCommandAllowed('xinfo', ['stream', 's'])).toBe(true);
  });

  test('every command family is in the catalog, and names are unique', () => {
    const names = REDIS_COMMANDS.map(c => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const family of Object.keys(REDIS_SUBCOMMANDS)) expect(names).toContain(family.toUpperCase());
  });
});

describe('tokenizeRedisCommand', () => {
  test('keeps quoted arguments whole', () => {
    expect(tokenizeRedisCommand('SET greeting "hello world"')).toEqual(['SET', 'greeting', 'hello world']);
    expect(tokenizeRedisCommand("SET k 'a;b'")).toEqual(['SET', 'k', 'a;b']);
  });

  test('refuses an unbalanced quote', () => {
    expect(() => tokenizeRedisCommand('SET k "open')).toThrow('Unbalanced quotes in Redis command');
  });
});
