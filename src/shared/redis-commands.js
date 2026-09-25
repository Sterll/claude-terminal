'use strict';

/**
 * The Redis commands the query tab and the MCP db_query tool will run, with
 * the argument shape the editor's completion shows.
 *
 * One list for three places: DatabaseService and the MCP server each kept
 * their own copy, and the editor had none, so completion could not offer a
 * command without risking one the server would then refuse.
 *
 * Deliberately absent: anything that administers the server or runs code on
 * it (CONFIG, FLUSHDB, FLUSHALL, SHUTDOWN, DEBUG, EVAL, SCRIPT, FUNCTION,
 * MODULE, ACL, CLIENT, REPLICAOF, MIGRATE, SAVE). A command with
 * subcommands is allowed only for the read-only ones listed below it.
 */

const REDIS_COMMANDS = [
  // Keys
  { name: 'EXISTS', args: 'key [key ...]' },
  { name: 'TYPE', args: 'key' },
  { name: 'TTL', args: 'key' },
  { name: 'PTTL', args: 'key' },
  { name: 'EXPIRE', args: 'key seconds', write: true },
  { name: 'PEXPIRE', args: 'key milliseconds', write: true },
  { name: 'EXPIREAT', args: 'key unix-time-seconds', write: true },
  { name: 'PEXPIREAT', args: 'key unix-time-milliseconds', write: true },
  { name: 'PERSIST', args: 'key', write: true },
  { name: 'DEL', args: 'key [key ...]', write: true },
  { name: 'UNLINK', args: 'key [key ...]', write: true },
  { name: 'RENAME', args: 'key newkey', write: true },
  { name: 'RENAMENX', args: 'key newkey', write: true },
  { name: 'COPY', args: 'source destination [REPLACE]', write: true },
  { name: 'TOUCH', args: 'key [key ...]' },
  { name: 'KEYS', args: 'pattern' },
  { name: 'SCAN', args: 'cursor [MATCH pattern] [COUNT count] [TYPE type]' },
  { name: 'RANDOMKEY', args: '' },
  { name: 'DBSIZE', args: '' },
  { name: 'SELECT', args: 'index' },
  { name: 'OBJECT', args: 'ENCODING|FREQ|IDLETIME|REFCOUNT key' },
  { name: 'MEMORY', args: 'USAGE key | STATS' },
  // Strings
  { name: 'GET', args: 'key' },
  { name: 'MGET', args: 'key [key ...]' },
  { name: 'GETRANGE', args: 'key start end' },
  { name: 'STRLEN', args: 'key' },
  { name: 'GETEX', args: 'key [EX seconds | PX ms | PERSIST]', write: true },
  { name: 'GETDEL', args: 'key', write: true },
  { name: 'GETSET', args: 'key value', write: true },
  { name: 'SET', args: 'key value [EX seconds] [NX|XX]', write: true },
  { name: 'SETNX', args: 'key value', write: true },
  { name: 'SETEX', args: 'key seconds value', write: true },
  { name: 'PSETEX', args: 'key milliseconds value', write: true },
  { name: 'MSET', args: 'key value [key value ...]', write: true },
  { name: 'MSETNX', args: 'key value [key value ...]', write: true },
  { name: 'SETRANGE', args: 'key offset value', write: true },
  { name: 'APPEND', args: 'key value', write: true },
  { name: 'INCR', args: 'key', write: true },
  { name: 'INCRBY', args: 'key increment', write: true },
  { name: 'INCRBYFLOAT', args: 'key increment', write: true },
  { name: 'DECR', args: 'key', write: true },
  { name: 'DECRBY', args: 'key decrement', write: true },
  { name: 'GETBIT', args: 'key offset' },
  { name: 'SETBIT', args: 'key offset value', write: true },
  { name: 'BITCOUNT', args: 'key [start end]' },
  // Hashes
  { name: 'HGET', args: 'key field' },
  { name: 'HMGET', args: 'key field [field ...]' },
  { name: 'HGETALL', args: 'key' },
  { name: 'HKEYS', args: 'key' },
  { name: 'HVALS', args: 'key' },
  { name: 'HLEN', args: 'key' },
  { name: 'HSTRLEN', args: 'key field' },
  { name: 'HEXISTS', args: 'key field' },
  { name: 'HRANDFIELD', args: 'key [count [WITHVALUES]]' },
  { name: 'HSCAN', args: 'key cursor [MATCH pattern] [COUNT count]' },
  { name: 'HSET', args: 'key field value [field value ...]', write: true },
  { name: 'HSETNX', args: 'key field value', write: true },
  { name: 'HINCRBY', args: 'key field increment', write: true },
  { name: 'HINCRBYFLOAT', args: 'key field increment', write: true },
  { name: 'HDEL', args: 'key field [field ...]', write: true },
  // Lists
  { name: 'LRANGE', args: 'key start stop' },
  { name: 'LLEN', args: 'key' },
  { name: 'LINDEX', args: 'key index' },
  { name: 'LPOS', args: 'key element [RANK rank] [COUNT n]' },
  { name: 'LPUSH', args: 'key element [element ...]', write: true },
  { name: 'RPUSH', args: 'key element [element ...]', write: true },
  { name: 'LPUSHX', args: 'key element [element ...]', write: true },
  { name: 'RPUSHX', args: 'key element [element ...]', write: true },
  { name: 'LPOP', args: 'key [count]', write: true },
  { name: 'RPOP', args: 'key [count]', write: true },
  { name: 'LSET', args: 'key index element', write: true },
  { name: 'LREM', args: 'key count element', write: true },
  { name: 'LTRIM', args: 'key start stop', write: true },
  { name: 'LINSERT', args: 'key BEFORE|AFTER pivot element', write: true },
  { name: 'LMOVE', args: 'source destination LEFT|RIGHT LEFT|RIGHT', write: true },
  // Sets
  { name: 'SMEMBERS', args: 'key' },
  { name: 'SCARD', args: 'key' },
  { name: 'SISMEMBER', args: 'key member' },
  { name: 'SMISMEMBER', args: 'key member [member ...]' },
  { name: 'SRANDMEMBER', args: 'key [count]' },
  { name: 'SSCAN', args: 'key cursor [MATCH pattern] [COUNT count]' },
  { name: 'SINTER', args: 'key [key ...]' },
  { name: 'SUNION', args: 'key [key ...]' },
  { name: 'SDIFF', args: 'key [key ...]' },
  { name: 'SADD', args: 'key member [member ...]', write: true },
  { name: 'SREM', args: 'key member [member ...]', write: true },
  { name: 'SPOP', args: 'key [count]', write: true },
  { name: 'SMOVE', args: 'source destination member', write: true },
  // Sorted sets
  { name: 'ZRANGE', args: 'key start stop [WITHSCORES]' },
  { name: 'ZREVRANGE', args: 'key start stop [WITHSCORES]' },
  { name: 'ZRANGEBYSCORE', args: 'key min max [WITHSCORES] [LIMIT offset count]' },
  { name: 'ZREVRANGEBYSCORE', args: 'key max min [WITHSCORES] [LIMIT offset count]' },
  { name: 'ZRANGEBYLEX', args: 'key min max [LIMIT offset count]' },
  { name: 'ZCARD', args: 'key' },
  { name: 'ZCOUNT', args: 'key min max' },
  { name: 'ZLEXCOUNT', args: 'key min max' },
  { name: 'ZSCORE', args: 'key member' },
  { name: 'ZMSCORE', args: 'key member [member ...]' },
  { name: 'ZRANK', args: 'key member' },
  { name: 'ZREVRANK', args: 'key member' },
  { name: 'ZSCAN', args: 'key cursor [MATCH pattern] [COUNT count]' },
  { name: 'ZADD', args: 'key score member [score member ...]', write: true },
  { name: 'ZINCRBY', args: 'key increment member', write: true },
  { name: 'ZREM', args: 'key member [member ...]', write: true },
  { name: 'ZPOPMIN', args: 'key [count]', write: true },
  { name: 'ZPOPMAX', args: 'key [count]', write: true },
  { name: 'ZREMRANGEBYRANK', args: 'key start stop', write: true },
  { name: 'ZREMRANGEBYSCORE', args: 'key min max', write: true },
  // Streams
  { name: 'XLEN', args: 'key' },
  { name: 'XRANGE', args: 'key start end [COUNT count]' },
  { name: 'XREVRANGE', args: 'key end start [COUNT count]' },
  { name: 'XINFO', args: 'STREAM|GROUPS key | CONSUMERS key group' },
  { name: 'XADD', args: 'key *|id field value [field value ...]', write: true },
  { name: 'XDEL', args: 'key id [id ...]', write: true },
  { name: 'XTRIM', args: 'key MAXLEN|MINID threshold', write: true },
  // HyperLogLog
  { name: 'PFCOUNT', args: 'key [key ...]' },
  { name: 'PFADD', args: 'key element [element ...]', write: true },
  // RedisJSON (module)
  { name: 'JSON.GET', args: 'key [path ...]' },
  { name: 'JSON.MGET', args: 'key [key ...] path' },
  { name: 'JSON.TYPE', args: 'key [path]' },
  { name: 'JSON.OBJKEYS', args: 'key [path]' },
  { name: 'JSON.ARRLEN', args: 'key [path]' },
  { name: 'JSON.STRLEN', args: 'key [path]' },
  { name: 'JSON.SET', args: 'key path value [NX|XX]', write: true },
  { name: 'JSON.DEL', args: 'key [path]', write: true },
  { name: 'JSON.NUMINCRBY', args: 'key path number', write: true },
  { name: 'JSON.ARRAPPEND', args: 'key path value [value ...]', write: true },
  // Server, read-only
  { name: 'PING', args: '[message]' },
  { name: 'ECHO', args: 'message' },
  { name: 'TIME', args: '' },
  { name: 'INFO', args: '[section]' },
  { name: 'LASTSAVE', args: '' },
];

/** For commands that are families, the members that only read. */
const REDIS_SUBCOMMANDS = {
  object: ['encoding', 'freq', 'idletime', 'refcount', 'help'],
  memory: ['usage', 'stats', 'help'],
  xinfo: ['stream', 'groups', 'consumers', 'help'],
};

const ALLOWED = new Set(REDIS_COMMANDS.map(c => c.name.toLowerCase()));

/**
 * @param {string} command - as typed, any case
 * @param {string[]} [args]
 * @returns {boolean}
 */
function isRedisCommandAllowed(command, args = []) {
  const name = String(command || '').toLowerCase();
  if (!ALLOWED.has(name)) return false;
  const subs = REDIS_SUBCOMMANDS[name];
  return !subs || subs.includes(String(args[0] || '').toLowerCase());
}

/**
 * Split a command line the way redis-cli does, so `SET greeting "hello world"`
 * stores one value rather than `"hello` with a stray `world"` argument.
 * Double quotes take backslash escapes, single quotes are literal.
 */
function tokenizeRedisCommand(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let token = '';
    while (i < line.length && !/\s/.test(line[i])) {
      const ch = line[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < line.length && line[i] !== quote) {
          if (quote === '"' && line[i] === '\\' && i + 1 < line.length) {
            const next = line[++i];
            token += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          } else {
            token += line[i];
          }
          i++;
        }
        if (i >= line.length) throw new Error('Unbalanced quotes in Redis command');
        i++;
      } else {
        token += ch;
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

module.exports = { REDIS_COMMANDS, REDIS_SUBCOMMANDS, isRedisCommandAllowed, tokenizeRedisCommand };
