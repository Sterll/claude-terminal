'use strict';

/**
 * Database Tools Module for Claude Terminal MCP
 *
 * Provides database access tools. Reads connection configs from
 * CT_DATA_DIR/databases.json and passwords from CT_DB_PASS_{id} env vars.
 *
 * Supports: SQLite, MySQL, MariaDB, PostgreSQL, MongoDB, Redis
 */

const fs = require('fs');
const path = require('path');

const MAX_ROWS = 100;

// -- Redis allowed commands ---------------------------------------------------

const REDIS_ALLOWED_COMMANDS = new Set([
  'get', 'set', 'del', 'keys', 'type', 'info', 'scan', 'select', 'ping',
  'hget', 'hgetall', 'hset', 'hdel', 'hkeys', 'hvals', 'hlen', 'hexists',
  'lrange', 'llen', 'lindex', 'lpush', 'rpush', 'lpop', 'rpop',
  'smembers', 'scard', 'sismember', 'sadd', 'srem',
  'zrange', 'zcard', 'zscore', 'zadd', 'zrem', 'zrangebyscore',
  'exists', 'expire', 'ttl', 'pttl', 'persist', 'rename',
  'dbsize', 'randomkey', 'mget', 'strlen', 'append', 'incr', 'decr',
  'getrange', 'setex', 'setnx', 'mset'
]);

// -- SQL identifier escaping --------------------------------------------------

/**
 * Escape a SQL identifier for SQLite (double-quote escaping).
 * Doubles any embedded double-quotes: my"table → "my""table"
 */
function sqliteId(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * Escape a SQL identifier for MySQL (backtick escaping).
 * Doubles any embedded backticks: my`table → `my``table`
 */
function mysqlId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/**
 * Escape a SQL identifier for PostgreSQL (double-quote escaping).
 */
function pgId(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

// -- Logging ------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[ct-mcp:database] ${args.join(' ')}\n`);
}

// -- Connection pool ----------------------------------------------------------

const connections = new Map(); // id → { client, type }

function getDataDir() {
  return process.env.CT_DATA_DIR || '';
}

function loadConnectionConfigs() {
  const dbFile = path.join(getDataDir(), 'databases.json');
  try {
    if (fs.existsSync(dbFile)) {
      return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    }
  } catch (e) {
    log('Error reading databases.json:', e.message);
  }
  return [];
}

function saveConnectionConfigs(configs) {
  const dbFile = path.join(getDataDir(), 'databases.json');
  const tmpFile = dbFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(configs, null, 2), 'utf8');
  fs.renameSync(tmpFile, dbFile);
}

function generateId() {
  return 'db-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function getPassword(id) {
  // Env var format: CT_DB_PASS_{id} with dots/hyphens replaced
  const envKey = `CT_DB_PASS_${id}`;
  return process.env[envKey] || '';
}

function findConnection(nameOrId) {
  const configs = loadConnectionConfigs();
  // Match by name (case-insensitive) or by id
  return configs.find(c =>
    c.id === nameOrId ||
    c.name.toLowerCase() === nameOrId.toLowerCase()
  );
}

async function getClient(nameOrId) {
  const config = findConnection(nameOrId);
  if (!config) throw new Error(`Connection "${nameOrId}" not found. Use db_list_connections to see available connections.`);

  // Return cached connection if available
  if (connections.has(config.id)) {
    return { client: connections.get(config.id).client, type: config.type, config };
  }

  // Create new connection
  const password = getPassword(config.id);
  const client = await createClient(config, password);
  connections.set(config.id, { client, type: config.type });
  log(`Connected to ${config.type}: ${config.name}`);
  return { client, type: config.type, config };
}

async function createClient(config, password) {
  const type = config.type;

  if (type === 'sqlite') {
    const Database = require('better-sqlite3');
    if (!config.filePath) throw new Error('SQLite connection missing filePath');
    const db = new Database(config.filePath, { readonly: false });
    db.pragma('journal_mode = WAL');
    return db;
  }

  if (type === 'mysql' || type === 'mariadb') {
    const mysql = require('mysql2/promise');
    return await mysql.createConnection({
      host: config.host || 'localhost',
      port: parseInt(config.port || '3306', 10),
      database: config.database,
      user: config.username,
      password,
    });
  }

  if (type === 'postgresql') {
    const { Client } = require('pg');
    const client = new Client({
      host: config.host || 'localhost',
      port: parseInt(config.port || '5432', 10),
      database: config.database,
      user: config.username,
      password,
    });
    await client.connect();
    return client;
  }

  if (type === 'mongodb') {
    const { MongoClient } = require('mongodb');
    const uri = config.connectionString;
    if (!uri) throw new Error('MongoDB connection missing connectionString');
    const mongoClient = new MongoClient(uri);
    await mongoClient.connect();
    const dbName = config.database || new URL(uri).pathname.slice(1) || 'test';
    return { mongoClient, db: mongoClient.db(dbName) };
  }

  if (type === 'redis') {
    const Redis = require('ioredis');
    const client = new Redis({
      host: config.host || 'localhost',
      port: parseInt(config.port || '6379', 10),
      password: password || undefined,
      db: parseInt(config.database || '0', 10),
      connectTimeout: 10000,
      lazyConnect: true,
    });
    await client.connect();
    return client;
  }

  throw new Error(`Unsupported database type: ${type}`);
}

// -- Query execution ----------------------------------------------------------

async function executeQuery(client, type, sql) {
  const trimmed = sql.trim();

  if (type === 'sqlite') {
    const isSelect = /^(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);
    if (isSelect) {
      const rows = client.prepare(trimmed).all().slice(0, MAX_ROWS);
      return formatRows(rows);
    }
    const info = client.prepare(trimmed).run();
    return `Rows affected: ${info.changes}`;
  }

  if (type === 'mysql' || type === 'mariadb') {
    const [rows] = await client.execute(trimmed);
    if (Array.isArray(rows)) return formatRows(rows.slice(0, MAX_ROWS));
    return `Rows affected: ${rows.affectedRows}`;
  }

  if (type === 'postgresql') {
    const result = await client.query(trimmed);
    if (result.rows) return formatRows(result.rows.slice(0, MAX_ROWS));
    return `Rows affected: ${result.rowCount}`;
  }

  if (type === 'mongodb') {
    return 'MongoDB: use db_list_tables and db_describe_table. For queries, use the query tool with MongoDB shell syntax.';
  }

  if (type === 'redis') {
    return await executeRedisCommand(client, sql);
  }

  return 'Unsupported database type';
}

async function executeRedisCommand(client, command) {
  const trimmed = command.trim();

  // Special _REDIS_SCAN command: _REDIS_SCAN {dbIndex} {limit} {pattern?}
  const scanMatch = trimmed.match(/^_REDIS_SCAN\s+(\d+)\s+(\d+)(?:\s+(.+))?$/);
  if (scanMatch) {
    const dbIndex = parseInt(scanMatch[1]);
    const pageSize = parseInt(scanMatch[2]);
    const pattern = scanMatch[3] ? `*${scanMatch[3]}*` : '*';

    await client.select(dbIndex);
    const allKeys = await redisGetAllKeys(client, pattern);
    const pageKeys = allKeys.slice(0, pageSize);

    const rows = [];
    for (const key of pageKeys) {
      const type = await client.type(key);
      const ttl = await client.ttl(key);
      let value = null;
      try {
        if (type === 'string') value = await client.get(key);
        else if (type === 'hash') value = JSON.stringify(await client.hgetall(key));
        else if (type === 'list') value = JSON.stringify(await client.lrange(key, 0, 9));
        else if (type === 'set') value = JSON.stringify(await client.smembers(key));
        else if (type === 'zset') value = JSON.stringify(await client.zrange(key, 0, 9, 'WITHSCORES'));
        else value = `(${type})`;
      } catch { /* ignore */ }
      rows.push({ key, type, ttl: ttl < 0 ? null : ttl, value });
    }

    const header = 'key | type | ttl | value';
    const separator = '─'.repeat(60);
    const lines = rows.map(r => `${r.key} | ${r.type} | ${r.ttl ?? '-'} | ${(r.value || '').slice(0, 100)}`);
    return `${allKeys.length} keys found\n${header}\n${separator}\n${lines.join('\n')}`;
  }

  // Native Redis command
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (!REDIS_ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(`Redis command "${cmd.toUpperCase()}" is not allowed. Allowed: ${[...REDIS_ALLOWED_COMMANDS].join(', ')}`);
  }

  const result = await client[cmd](...args);
  if (result === null) return '(nil)';
  if (Array.isArray(result)) {
    return result.map((v, i) => `${i + 1}) ${v === null ? '(nil)' : String(v)}`).join('\n') || '(empty array)';
  }
  return String(result);
}

async function redisGetAllKeys(client, pattern = '*') {
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys.sort();
}

// -- Schema operations --------------------------------------------------------

async function listTables(client, type, filter) {
  const match = filter
    ? (name) => name.toLowerCase().includes(filter.toLowerCase())
    : () => true;

  if (type === 'sqlite') {
    let tables = client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    tables = tables.filter(t => match(t.name));
    const result = [];
    for (const { name } of tables) {
      const columns = client.prepare(`PRAGMA table_info(${sqliteId(name)})`).all();
      const colStr = columns.map(c => c.name).join(', ');
      result.push(`${name}: ${colStr}`);
    }
    return result.join('\n') || (filter ? `No tables matching "${filter}"` : 'No tables found');
  }

  if (type === 'mysql' || type === 'mariadb') {
    const [tables] = await client.execute('SHOW TABLES');
    const key = Object.keys(tables[0] || {})[0];
    const result = [];
    for (const row of tables) {
      const tableName = row[key];
      if (!match(tableName)) continue;
      const [columns] = await client.execute(`SHOW COLUMNS FROM ${mysqlId(tableName)}`);
      const colStr = columns.map(c => c.Field).join(', ');
      result.push(`${tableName}: ${colStr}`);
    }
    return result.join('\n') || (filter ? `No tables matching "${filter}"` : 'No tables found');
  }

  if (type === 'postgresql') {
    const tablesRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const result = [];
    for (const { table_name: tn } of tablesRes.rows) {
      if (!match(tn)) continue;
      const colRes = await client.query(
        'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
        [tn]
      );
      const colStr = colRes.rows.map(c => c.column_name).join(', ');
      result.push(`${tn}: ${colStr}`);
    }
    return result.join('\n') || (filter ? `No tables matching "${filter}"` : 'No tables found');
  }

  if (type === 'mongodb') {
    let collections = await client.db.listCollections().toArray();
    collections = collections.filter(c => match(c.name));
    return collections.map(c => c.name).join('\n') || (filter ? `No collections matching "${filter}"` : 'No collections found');
  }

  if (type === 'redis') {
    const info = await client.info('keyspace');
    const result = [];
    for (const line of info.split('\r\n')) {
      const m = line.match(/^db(\d+):keys=(\d+),expires=(\d+)/);
      if (m) {
        const name = `db:${m[1]}`;
        if (match(name)) result.push(`${name}: ${m[2]} keys, ${m[3]} expiring`);
      }
    }
    if (result.length === 0) {
      // Show db:0 even if empty
      if (match('db:0')) result.push('db:0: 0 keys');
    }
    return result.join('\n') || (filter ? `No databases matching "${filter}"` : 'No databases found');
  }

  return 'Unsupported database type';
}

async function describeTable(client, type, tableName) {
  if (type === 'sqlite') {
    const columns = client.prepare(`PRAGMA table_info(${sqliteId(tableName)})`).all();
    if (!columns.length) return `Table '${tableName}' not found`;
    const lines = columns.map(c => {
      const parts = [`${c.name} ${c.type}`];
      if (c.pk) parts.push('PRIMARY KEY');
      if (c.notnull) parts.push('NOT NULL');
      if (c.dflt_value !== null) parts.push(`DEFAULT ${c.dflt_value}`);
      return parts.join(' | ');
    });
    return `Table: ${tableName}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  if (type === 'mysql' || type === 'mariadb') {
    const [columns] = await client.execute(`SHOW FULL COLUMNS FROM ${mysqlId(tableName)}`);
    if (!columns.length) return `Table '${tableName}' not found`;
    const lines = columns.map(c => {
      const parts = [`${c.Field} ${c.Type}`];
      if (c.Key === 'PRI') parts.push('PRIMARY KEY');
      if (c.Null === 'NO') parts.push('NOT NULL');
      if (c.Default !== null) parts.push(`DEFAULT ${c.Default}`);
      return parts.join(' | ');
    });
    return `Table: ${tableName}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  if (type === 'postgresql') {
    const result = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default,
              (SELECT EXISTS(
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
                WHERE tc.table_name = c.table_name AND kcu.column_name = c.column_name
                AND tc.constraint_type = 'PRIMARY KEY'
              )) as is_pk
       FROM information_schema.columns c
       WHERE table_name = $1 AND table_schema = 'public'
       ORDER BY ordinal_position`,
      [tableName]
    );
    if (!result.rows.length) return `Table '${tableName}' not found`;
    const lines = result.rows.map(c => {
      const parts = [`${c.column_name} ${c.data_type}`];
      if (c.is_pk) parts.push('PRIMARY KEY');
      if (c.is_nullable === 'NO') parts.push('NOT NULL');
      if (c.column_default) parts.push(`DEFAULT ${c.column_default}`);
      return parts.join(' | ');
    });
    return `Table: ${tableName}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  if (type === 'mongodb') {
    const sample = await client.db.collection(tableName).findOne();
    if (!sample) return `Collection '${tableName}' is empty or does not exist`;
    const fields = Object.entries(sample).map(([key, val]) => `${key}: ${typeof val}`);
    return `Collection: ${tableName} (sample document)\n${'─'.repeat(40)}\n${fields.join('\n')}`;
  }

  if (type === 'redis') {
    // tableName = "db:0", "db:1", etc.
    const dbMatch = tableName.match(/^db:(\d+)$/);
    if (!dbMatch) return `Invalid Redis database name '${tableName}'. Use db:0, db:1, etc.`;
    const dbIndex = parseInt(dbMatch[1]);
    await client.select(dbIndex);
    const dbSize = await client.dbsize();
    const keys = await redisGetAllKeys(client, '*');
    const sampleKeys = keys.slice(0, 20);

    const lines = [];
    for (const key of sampleKeys) {
      const type = await client.type(key);
      const ttl = await client.ttl(key);
      lines.push(`${key} | ${type} | TTL: ${ttl < 0 ? 'none' : ttl + 's'}`);
    }

    let result = `Redis db:${dbIndex}\n${'─'.repeat(40)}\nTotal keys: ${dbSize}\nSchema: key (string) | type (string) | ttl (number) | value (any)`;
    if (lines.length > 0) {
      result += `\n\nSample keys (first ${sampleKeys.length}):\n${lines.join('\n')}`;
    }
    if (dbSize > 20) result += `\n... and ${dbSize - 20} more keys`;
    return result;
  }

  return 'Unsupported database type';
}

// -- Export -------------------------------------------------------------------

async function exportQuery(client, type, sql, format) {
  const trimmed = sql.trim();
  let rows;

  if (type === 'sqlite') {
    rows = client.prepare(trimmed).all().slice(0, MAX_ROWS);
  } else if (type === 'mysql' || type === 'mariadb') {
    const [result] = await client.execute(trimmed);
    rows = Array.isArray(result) ? result.slice(0, MAX_ROWS) : [];
  } else if (type === 'postgresql') {
    const result = await client.query(trimmed);
    rows = (result.rows || []).slice(0, MAX_ROWS);
  } else if (type === 'redis') {
    // For Redis, scan keys and export key/type/ttl/value
    const scanMatch = sql.trim().match(/^_REDIS_SCAN\s+(\d+)\s+(\d+)(?:\s+(.+))?$/);
    if (scanMatch) {
      const dbIndex = parseInt(scanMatch[1]);
      const pageSize = parseInt(scanMatch[2]);
      const pattern = scanMatch[3] ? `*${scanMatch[3]}*` : '*';
      await client.select(dbIndex);
      const allKeys = await redisGetAllKeys(client, pattern);
      const pageKeys = allKeys.slice(0, pageSize);
      rows = [];
      for (const key of pageKeys) {
        const keyType = await client.type(key);
        const ttl = await client.ttl(key);
        let value = null;
        try {
          if (keyType === 'string') value = await client.get(key);
          else if (keyType === 'hash') value = JSON.stringify(await client.hgetall(key));
          else if (keyType === 'list') value = JSON.stringify(await client.lrange(key, 0, -1));
          else if (keyType === 'set') value = JSON.stringify(await client.smembers(key));
          else if (keyType === 'zset') value = JSON.stringify(await client.zrange(key, 0, -1, 'WITHSCORES'));
          else value = `(${keyType})`;
        } catch { /* ignore */ }
        rows.push({ key, type: keyType, ttl: ttl < 0 ? null : ttl, value });
      }
    } else {
      return 'Redis export: use _REDIS_SCAN {dbIndex} {limit} {pattern?} to export keys';
    }
  } else {
    return 'Export not supported for this database type';
  }

  if (!rows || rows.length === 0) return 'No results to export';

  if (format === 'json') {
    return JSON.stringify(rows, null, 2);
  }

  // CSV
  const columns = Object.keys(rows[0]);
  const escape = (v) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map(c => escape(row[c])).join(','));
  }
  return lines.join('\n');
}

// -- Full schema --------------------------------------------------------------

async function getFullSchema(client, type) {
  if (type === 'sqlite') {
    const tables = client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const sections = [];
    for (const { name } of tables) {
      const escaped = sqliteId(name);
      const cols = client.prepare(`PRAGMA table_info(${escaped})`).all();
      const fks = client.prepare(`PRAGMA foreign_key_list(${escaped})`).all();
      const idxs = client.prepare(`PRAGMA index_list(${escaped})`).all();

      let s = `## ${name}\n`;
      s += cols.map(c => {
        const p = [`  ${c.name} ${c.type || 'ANY'}`];
        if (c.pk) p.push('PK');
        if (c.notnull) p.push('NOT NULL');
        if (c.dflt_value !== null) p.push(`DEFAULT ${c.dflt_value}`);
        return p.join(' | ');
      }).join('\n');

      if (fks.length) {
        s += '\n  Foreign Keys:';
        for (const fk of fks) s += `\n    ${fk.from} → ${fk.table}(${fk.to})`;
      }
      if (idxs.length) {
        s += '\n  Indexes:';
        for (const idx of idxs) {
          const iCols = client.prepare(`PRAGMA index_info(${sqliteId(idx.name)})`).all();
          s += `\n    ${idx.name}${idx.unique ? ' (UNIQUE)' : ''}: ${iCols.map(i => i.name).join(', ')}`;
        }
      }
      sections.push(s);
    }
    return sections.join('\n\n') || 'No tables found';
  }

  if (type === 'mysql' || type === 'mariadb') {
    const [tables] = await client.execute('SHOW TABLES');
    const key = Object.keys(tables[0] || {})[0];
    const sections = [];
    for (const row of tables) {
      const tn = row[key];
      const [cols] = await client.execute(`SHOW FULL COLUMNS FROM ${mysqlId(tn)}`);
      const [fksRaw] = await client.execute(
        `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
         WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`, [tn]);
      const [idxsRaw] = await client.execute(`SHOW INDEX FROM ${mysqlId(tn)}`);

      let s = `## ${tn}\n`;
      s += cols.map(c => {
        const p = [`  ${c.Field} ${c.Type}`];
        if (c.Key === 'PRI') p.push('PK');
        if (c.Null === 'NO') p.push('NOT NULL');
        if (c.Default !== null) p.push(`DEFAULT ${c.Default}`);
        return p.join(' | ');
      }).join('\n');

      if (fksRaw.length) {
        s += '\n  Foreign Keys:';
        for (const fk of fksRaw) s += `\n    ${fk.COLUMN_NAME} → ${fk.REFERENCED_TABLE_NAME}(${fk.REFERENCED_COLUMN_NAME})`;
      }

      // Group indexes by name
      const idxMap = new Map();
      for (const idx of idxsRaw) {
        if (!idxMap.has(idx.Key_name)) idxMap.set(idx.Key_name, { unique: !idx.Non_unique, cols: [] });
        idxMap.get(idx.Key_name).cols.push(idx.Column_name);
      }
      if (idxMap.size > 1 || (idxMap.size === 1 && !idxMap.has('PRIMARY'))) {
        s += '\n  Indexes:';
        for (const [name, info] of idxMap) {
          if (name === 'PRIMARY') continue;
          s += `\n    ${name}${info.unique ? ' (UNIQUE)' : ''}: ${info.cols.join(', ')}`;
        }
      }
      sections.push(s);
    }
    return sections.join('\n\n') || 'No tables found';
  }

  if (type === 'postgresql') {
    const tablesRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
    );
    const sections = [];
    for (const { table_name: tn } of tablesRes.rows) {
      const colRes = await client.query(
        `SELECT column_name, data_type, is_nullable, column_default,
                (SELECT EXISTS(
                  SELECT 1 FROM information_schema.table_constraints tc
                  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
                  WHERE tc.table_name = c.table_name AND kcu.column_name = c.column_name
                  AND tc.constraint_type = 'PRIMARY KEY'
                )) as is_pk
         FROM information_schema.columns c
         WHERE table_name = $1 AND table_schema = 'public'
         ORDER BY ordinal_position`, [tn]);

      const fkRes = await client.query(
        `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
         WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'`, [tn]);

      const idxRes = await client.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = 'public'`, [tn]);

      let s = `## ${tn}\n`;
      s += colRes.rows.map(c => {
        const p = [`  ${c.column_name} ${c.data_type}`];
        if (c.is_pk) p.push('PK');
        if (c.is_nullable === 'NO') p.push('NOT NULL');
        if (c.column_default) p.push(`DEFAULT ${c.column_default}`);
        return p.join(' | ');
      }).join('\n');

      if (fkRes.rows.length) {
        s += '\n  Foreign Keys:';
        for (const fk of fkRes.rows) s += `\n    ${fk.column_name} → ${fk.ref_table}(${fk.ref_column})`;
      }

      const nonPkIdx = idxRes.rows.filter(i => !i.indexname.endsWith('_pkey'));
      if (nonPkIdx.length) {
        s += '\n  Indexes:';
        for (const idx of nonPkIdx) {
          const unique = idx.indexdef.includes('UNIQUE') ? ' (UNIQUE)' : '';
          const colMatch = idx.indexdef.match(/\((.+)\)/);
          s += `\n    ${idx.indexname}${unique}: ${colMatch ? colMatch[1] : '?'}`;
        }
      }
      sections.push(s);
    }
    return sections.join('\n\n') || 'No tables found';
  }

  if (type === 'mongodb') {
    const collections = await client.db.listCollections().toArray();
    const sections = [];
    for (const col of collections) {
      const indexes = await client.db.collection(col.name).indexes();
      let s = `## ${col.name}`;
      if (indexes.length > 1) {
        s += '\n  Indexes:';
        for (const idx of indexes) {
          if (idx.name === '_id_') continue;
          const keys = Object.entries(idx.key).map(([k, v]) => `${k}:${v}`).join(', ');
          s += `\n    ${idx.name}${idx.unique ? ' (UNIQUE)' : ''}: ${keys}`;
        }
      }
      sections.push(s);
    }
    return sections.join('\n\n') || 'No collections found';
  }

  if (type === 'redis') {
    const info = await client.info('keyspace');
    const sections = [];
    const dbInfos = [];
    for (const line of info.split('\r\n')) {
      const m = line.match(/^db(\d+):keys=(\d+),expires=(\d+)/);
      if (m) dbInfos.push({ dbIndex: parseInt(m[1]), keys: parseInt(m[2]), expires: parseInt(m[3]) });
    }
    if (dbInfos.length === 0) dbInfos.push({ dbIndex: 0, keys: 0, expires: 0 });

    for (const { dbIndex, keys, expires } of dbInfos) {
      let s = `## db:${dbIndex}\n  Keys: ${keys}, Expiring: ${expires}`;
      s += '\n  Schema: key (string PK) | type (string) | ttl (number) | value (any)';
      if (keys > 0) {
        await client.select(dbIndex);
        const sampleKeys = await redisGetAllKeys(client, '*');
        const sample = sampleKeys.slice(0, 10);
        const typeCounts = {};
        for (const key of sample) {
          const t = await client.type(key);
          typeCounts[t] = (typeCounts[t] || 0) + 1;
        }
        s += `\n  Key types (sample): ${Object.entries(typeCounts).map(([t, c]) => `${t}(${c})`).join(', ')}`;
      }
      sections.push(s);
    }
    return sections.join('\n\n') || 'No Redis databases found';
  }

  return 'Unsupported database type';
}

// -- Stats --------------------------------------------------------------------

async function getStats(client, type) {
  if (type === 'sqlite') {
    const tables = client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const lines = [];
    let totalRows = 0;
    for (const { name } of tables) {
      const row = client.prepare(`SELECT COUNT(*) as cnt FROM ${sqliteId(name)}`).get();
      lines.push(`${name}: ${row.cnt.toLocaleString()} rows`);
      totalRows += row.cnt;
    }
    const pageSize = client.pragma('page_size', { simple: true });
    const pageCount = client.pragma('page_count', { simple: true });
    const sizeBytes = pageSize * pageCount;
    const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
    return `Database size: ${sizeMB} MB\nTotal rows: ${totalRows.toLocaleString()}\nTables: ${tables.length}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  if (type === 'mysql' || type === 'mariadb') {
    const [tables] = await client.execute('SHOW TABLES');
    const key = Object.keys(tables[0] || {})[0];
    const lines = [];
    let totalRows = 0;
    for (const row of tables) {
      const tn = row[key];
      const [cnt] = await client.execute(`SELECT COUNT(*) as cnt FROM ${mysqlId(tn)}`);
      const count = Number(cnt[0].cnt);
      lines.push(`${tn}: ${count.toLocaleString()} rows`);
      totalRows += count;
    }
    // DB size
    const [sizeRes] = await client.execute(
      `SELECT SUM(data_length + index_length) as size FROM information_schema.tables WHERE table_schema = DATABASE()`);
    const sizeMB = ((Number(sizeRes[0].size) || 0) / 1024 / 1024).toFixed(2);
    return `Database size: ${sizeMB} MB\nTotal rows: ${totalRows.toLocaleString()}\nTables: ${tables.length}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  if (type === 'postgresql') {
    const tablesRes = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
    const lines = [];
    let totalRows = 0;
    for (const { table_name: tn } of tablesRes.rows) {
      const cnt = await client.query(`SELECT COUNT(*) as cnt FROM ${pgId(tn)}`);
      const count = Number(cnt.rows[0].cnt);
      lines.push(`${tn}: ${count.toLocaleString()} rows`);
      totalRows += count;
    }
    const sizeRes = await client.query("SELECT pg_database_size(current_database()) as size");
    const sizeMB = (Number(sizeRes.rows[0].size) / 1024 / 1024).toFixed(2);
    return `Database size: ${sizeMB} MB\nTotal rows: ${totalRows.toLocaleString()}\nTables: ${tablesRes.rows.length}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  if (type === 'mongodb') {
    const stats = await client.db.stats();
    const collections = await client.db.listCollections().toArray();
    const lines = [];
    let totalDocs = 0;
    for (const col of collections) {
      const count = await client.db.collection(col.name).countDocuments();
      lines.push(`${col.name}: ${count.toLocaleString()} documents`);
      totalDocs += count;
    }
    const sizeMB = ((stats.dataSize || 0) / 1024 / 1024).toFixed(2);
    return `Database size: ${sizeMB} MB\nTotal documents: ${totalDocs.toLocaleString()}\nCollections: ${collections.length}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  if (type === 'redis') {
    const info = await client.info();
    const lines = [];
    let totalKeys = 0;

    // Parse keyspace info
    const keyspaceInfo = await client.info('keyspace');
    for (const line of keyspaceInfo.split('\r\n')) {
      const m = line.match(/^db(\d+):keys=(\d+),expires=(\d+)/);
      if (m) {
        const keys = parseInt(m[2]);
        totalKeys += keys;
        lines.push(`db:${m[1]}: ${keys.toLocaleString()} keys (${m[3]} expiring)`);
      }
    }

    // Parse memory info
    const memMatch = info.match(/used_memory_human:(\S+)/);
    const memory = memMatch ? memMatch[1] : '?';

    // Parse server info
    const versionMatch = info.match(/redis_version:(\S+)/);
    const version = versionMatch ? versionMatch[1] : '?';
    const uptimeMatch = info.match(/uptime_in_seconds:(\d+)/);
    const uptime = uptimeMatch ? Math.floor(parseInt(uptimeMatch[1]) / 3600) + 'h' : '?';

    const dbCount = lines.length || 1;
    if (lines.length === 0) lines.push('db:0: 0 keys');

    return `Redis ${version} | Memory: ${memory} | Uptime: ${uptime}\nTotal keys: ${totalKeys.toLocaleString()}\nDatabases: ${dbCount}\n${'─'.repeat(40)}\n${lines.join('\n')}`;
  }

  return 'Unsupported database type';
}

// -- Formatting ---------------------------------------------------------------

function formatRows(rows) {
  if (!rows || rows.length === 0) return 'No results';
  const columns = Object.keys(rows[0]);
  const header = columns.join(' | ');
  const separator = columns.map(c => '─'.repeat(Math.max(c.length, 3))).join('─┼─');
  const dataLines = rows.map(row => columns.map(c => String(row[c] ?? 'NULL')).join(' | '));
  const truncated = rows.length >= MAX_ROWS ? `\n(Limited to ${MAX_ROWS} rows)` : '';
  return `${header}\n${separator}\n${dataLines.join('\n')}${truncated}`;
}

// -- Tool definitions ---------------------------------------------------------

const tools = [
  {
    name: 'db_list_connections',
    description: 'List all database connections configured in Claude Terminal. Returns connection name, type (sqlite/mysql/postgresql/mongodb/redis), and connection details. Call this first to discover available databases.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'db_list_tables',
    description: 'List tables (or MongoDB collections, or Redis databases) in a database connection, with their column names. Use filter to search by name.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or ID (from db_list_connections)' },
        filter: { type: 'string', description: 'Optional name filter (case-insensitive substring match)' },
      },
      required: ['connection'],
    },
  },
  {
    name: 'db_describe_table',
    description: 'Get detailed schema for a specific table: column names, types, primary keys, nullability, and defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or ID' },
        table: { type: 'string', description: 'Table or collection name' },
      },
      required: ['connection', 'table'],
    },
  },
  {
    name: 'db_query',
    description: 'Execute a SQL query against a database connection. Supports SELECT, INSERT, UPDATE, DELETE. For Redis: use native commands (GET, SET, KEYS, etc.) or _REDIS_SCAN {dbIndex} {limit} {pattern?}. Results limited to 100 rows.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or ID' },
        sql: { type: 'string', description: 'SQL query to execute' },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'db_export',
    description: 'Execute a SQL query and return results as CSV or JSON. Useful for exporting data.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or ID' },
        sql: { type: 'string', description: 'SQL SELECT query to export' },
        format: { type: 'string', enum: ['csv', 'json'], description: 'Output format (default: csv)' },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'db_schema_full',
    description: 'Dump the complete database schema: all tables with columns, types, primary keys, foreign keys, and indexes. Returns everything in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or ID' },
      },
      required: ['connection'],
    },
  },
  {
    name: 'db_stats',
    description: 'Get database statistics: row count per table, total rows, database size, and table count.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or ID' },
      },
      required: ['connection'],
    },
  },
  {
    name: 'db_add_connection',
    description: 'Add a new database connection to Claude Terminal. Supports sqlite, mysql, mariadb, postgresql, mongodb, and redis. The connection is saved and immediately available for use.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the connection (e.g. "My Production DB")' },
        type: { type: 'string', enum: ['sqlite', 'mysql', 'mariadb', 'postgresql', 'mongodb', 'redis'], description: 'Database type' },
        host: { type: 'string', description: 'Hostname (default: localhost). Not needed for sqlite.' },
        port: { type: 'number', description: 'Port number. Defaults: mysql=3306, postgresql=5432, redis=6379. Not needed for sqlite.' },
        database: { type: 'string', description: 'Database name. For redis: DB index (default: 0). Not needed for sqlite.' },
        username: { type: 'string', description: 'Username. Not needed for sqlite or redis.' },
        filePath: { type: 'string', description: 'Path to SQLite file. Required for sqlite type.' },
        connectionString: { type: 'string', description: 'MongoDB connection URI. Required for mongodb type.' },
      },
      required: ['name', 'type'],
    },
  },
  {
    name: 'db_remove_connection',
    description: 'Remove a database connection from Claude Terminal. Closes any active connection and deletes the configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: 'Connection name or ID to remove (from db_list_connections)' },
      },
      required: ['connection'],
    },
  },
];

// -- Tool handler -------------------------------------------------------------

async function handle(name, args) {
  const ok = (text) => ({ content: [{ type: 'text', text }] });
  const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

  try {
    if (name === 'db_list_connections') {
      const configs = loadConnectionConfigs();
      if (!configs.length) return ok('No database connections configured. Add connections in Claude Terminal > Database panel.');

      const lines = configs.map(c => {
        const parts = [`${c.name} (${c.type})`];
        if (c.type === 'sqlite') parts.push(`— ${c.filePath}`);
        else if (c.type === 'mongodb') parts.push(`— ${c.connectionString ? c.connectionString.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') : 'no URI'}`);
        else if (c.type === 'redis') parts.push(`— ${c.host || 'localhost'}:${c.port || '6379'}/db${c.database || '0'}`);
        else parts.push(`— ${c.host || 'localhost'}:${c.port || '?'}/${c.database || '?'}`);
        return parts.join(' ');
      });

      return ok(`Available connections:\n\n${lines.join('\n')}`);
    }

    if (name === 'db_list_tables') {
      if (!args.connection) return fail('Missing required parameter: connection');
      const { client, type } = await getClient(args.connection);
      const result = await listTables(client, type, args.filter);
      return ok(result);
    }

    if (name === 'db_describe_table') {
      if (!args.connection) return fail('Missing required parameter: connection');
      if (!args.table) return fail('Missing required parameter: table');
      const { client, type } = await getClient(args.connection);
      const result = await describeTable(client, type, args.table);
      return ok(result);
    }

    if (name === 'db_query') {
      if (!args.connection) return fail('Missing required parameter: connection');
      if (!args.sql) return fail('Missing required parameter: sql');
      const { client, type } = await getClient(args.connection);
      const result = await executeQuery(client, type, args.sql);
      return ok(result);
    }

    if (name === 'db_export') {
      if (!args.connection) return fail('Missing required parameter: connection');
      if (!args.sql) return fail('Missing required parameter: sql');
      const { client, type } = await getClient(args.connection);
      const result = await exportQuery(client, type, args.sql, args.format || 'csv');
      return ok(result);
    }

    if (name === 'db_schema_full') {
      if (!args.connection) return fail('Missing required parameter: connection');
      const { client, type } = await getClient(args.connection);
      const result = await getFullSchema(client, type);
      return ok(result);
    }

    if (name === 'db_stats') {
      if (!args.connection) return fail('Missing required parameter: connection');
      const { client, type } = await getClient(args.connection);
      const result = await getStats(client, type);
      return ok(result);
    }

    if (name === 'db_add_connection') {
      if (!args.name) return fail('Missing required parameter: name');
      if (!args.type) return fail('Missing required parameter: type');

      const validTypes = ['sqlite', 'mysql', 'mariadb', 'postgresql', 'mongodb', 'redis'];
      if (!validTypes.includes(args.type)) return fail(`Invalid type "${args.type}". Must be one of: ${validTypes.join(', ')}`);

      if (args.type === 'sqlite' && !args.filePath) return fail('SQLite connections require filePath');
      if (args.type === 'mongodb' && !args.connectionString) return fail('MongoDB connections require connectionString');

      const configs = loadConnectionConfigs();
      const existing = configs.find(c => c.name.toLowerCase() === args.name.toLowerCase());
      if (existing) return fail(`A connection named "${args.name}" already exists`);

      const newConfig = {
        id: generateId(),
        name: args.name,
        type: args.type,
      };

      if (args.type === 'sqlite') {
        newConfig.filePath = args.filePath;
      } else if (args.type === 'mongodb') {
        newConfig.connectionString = args.connectionString;
        if (args.database) newConfig.database = args.database;
      } else {
        newConfig.host = args.host || 'localhost';
        if (args.type === 'mysql' || args.type === 'mariadb') newConfig.port = args.port || 3306;
        else if (args.type === 'postgresql') newConfig.port = args.port || 5432;
        else if (args.type === 'redis') newConfig.port = args.port || 6379;
        if (args.database) newConfig.database = args.database;
        if (args.username) newConfig.username = args.username;
      }

      configs.push(newConfig);
      saveConnectionConfigs(configs);
      log(`Added connection: ${newConfig.name} (${newConfig.type})`);

      return ok(`Connection "${newConfig.name}" (${newConfig.type}) added successfully with ID: ${newConfig.id}`);
    }

    if (name === 'db_remove_connection') {
      if (!args.connection) return fail('Missing required parameter: connection');

      const configs = loadConnectionConfigs();
      const idx = configs.findIndex(c =>
        c.id === args.connection ||
        c.name.toLowerCase() === args.connection.toLowerCase()
      );

      if (idx === -1) return fail(`Connection "${args.connection}" not found. Use db_list_connections to see available connections.`);

      const removed = configs[idx];

      // Close cached connection if active
      if (connections.has(removed.id)) {
        try {
          const { client, type } = connections.get(removed.id);
          if (type === 'sqlite') client.close();
          else if (type === 'mysql' || type === 'mariadb') await client.end();
          else if (type === 'postgresql') await client.end();
          else if (type === 'mongodb') await client.mongoClient.close();
          else if (type === 'redis') client.disconnect();
        } catch (e) {
          log(`Error closing connection ${removed.id}: ${e.message}`);
        }
        connections.delete(removed.id);
      }

      configs.splice(idx, 1);
      saveConnectionConfigs(configs);
      log(`Removed connection: ${removed.name} (${removed.type})`);

      return ok(`Connection "${removed.name}" (${removed.type}) removed successfully.`);
    }

    return fail(`Unknown database tool: ${name}`);
  } catch (error) {
    log(`Error in ${name}:`, error.message);
    return fail(`Database error: ${error.message}`);
  }
}

// -- Cleanup ------------------------------------------------------------------

async function cleanup() {
  for (const [id, { client, type }] of connections) {
    try {
      if (type === 'sqlite') client.close();
      else if (type === 'mysql' || type === 'mariadb') await client.end();
      else if (type === 'postgresql') await client.end();
      else if (type === 'mongodb') await client.mongoClient.close();
      else if (type === 'redis') client.disconnect();
      log(`Closed connection: ${id}`);
    } catch (e) {
      log(`Error closing ${id}: ${e.message}`);
    }
  }
  connections.clear();
}

// -- Exports ------------------------------------------------------------------

module.exports = { tools, handle, cleanup };
