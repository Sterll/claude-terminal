/**
 * Database Service
 * Manages database connections, queries, schema, detection and MCP provisioning
 * Supports: SQLite, MySQL, MariaDB, PostgreSQL, MongoDB, Redis
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { dataDir } = require('../utils/paths');

const DATABASES_FILE = path.join(dataDir, 'databases.json');
const KEYTAR_SERVICE = 'claude-terminal-db';

const MAX_CONNECTIONS = 10;
const CONNECTION_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const QUERY_TIMEOUT = 30 * 1000; // 30 seconds

const DESTRUCTIVE_SQL_RE = /^\s*(DROP|DELETE\s+FROM|TRUNCATE|ALTER)\b/i;

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

class DatabaseService {
  constructor() {
    this.connections = new Map(); // id -> { config, client, status, lastUsed }
    this._schemaCache = new Map(); // id -> { tables, timestamp }
    this._cleanupTimer = null;
  }

  /** Start periodic cleanup of idle connections (every 60s) */
  _startCleanupTimer() {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this._evictIdle(), 60000);
    // Don't keep the process alive for this timer
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /** Stop the cleanup timer */
  _stopCleanupTimer() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  /** Evict connections that have been idle beyond CONNECTION_IDLE_TIMEOUT */
  async _evictIdle() {
    const now = Date.now();
    const toEvict = [];
    for (const [id, conn] of this.connections) {
      if (now - conn.lastUsed > CONNECTION_IDLE_TIMEOUT) {
        toEvict.push(id);
      }
    }
    for (const id of toEvict) {
      console.log(`[Database] Evicting idle connection: ${id}`);
      await this.disconnect(id);
    }
    if (this.connections.size === 0) {
      this._stopCleanupTimer();
    }
  }

  /** Touch a connection to keep it alive */
  _touch(id) {
    const conn = this.connections.get(id);
    if (conn) conn.lastUsed = Date.now();
  }

  /**
   * Test a database connection without persisting it
   * @param {Object} config - { type, host, port, database, username, password, filePath, connectionString }
   * @returns {Object} { success, error? }
   */
  async testConnection(config) {
    let client = null;
    try {
      client = await this._createClient(config);
      await this._ping(config.type, client);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    } finally {
      if (client) {
        await this._closeClient(config.type, client).catch(() => {});
      }
    }
  }

  /**
   * Open a persistent connection
   * @param {string} id - Connection ID
   * @param {Object} config - Connection config
   * @returns {Object} { success, error? }
   */
  async connect(id, config) {
    try {
      if (this.connections.has(id)) {
        await this.disconnect(id);
      }
      // Enforce max connections — evict oldest idle if at limit
      if (this.connections.size >= MAX_CONNECTIONS) {
        let oldestId = null, oldestTime = Infinity;
        for (const [cid, conn] of this.connections) {
          if (conn.lastUsed < oldestTime) { oldestTime = conn.lastUsed; oldestId = cid; }
        }
        if (oldestId) {
          console.log(`[Database] Max connections (${MAX_CONNECTIONS}) reached, evicting: ${oldestId}`);
          await this.disconnect(oldestId);
        }
      }
      const client = await this._createClient(config);
      await this._ping(config.type, client);
      this.connections.set(id, { config, client, status: 'connected', lastUsed: Date.now() });
      this._startCleanupTimer();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Close a connection
   * @param {string} id
   * @returns {Object} { success }
   */
  async disconnect(id) {
    const conn = this.connections.get(id);
    if (conn) {
      await this._closeClient(conn.config.type, conn.client).catch(() => {});
      this.connections.delete(id);
      this._schemaCache.delete(id);
    }
    return { success: true };
  }

  /**
   * Close all connections (for app quit)
   */
  async disconnectAll() {
    this._stopCleanupTimer();
    const promises = [];
    for (const [id] of this.connections) {
      promises.push(this.disconnect(id));
    }
    await Promise.allSettled(promises);
  }

  /**
   * Get schema for a connected database
   * @param {string} id - Connection ID
   * @returns {Object} { success, tables?, error? }
   */
  async getSchema(id, { force = false } = {}) {
    const conn = this.connections.get(id);
    if (!conn) return { success: false, error: 'Not connected' };
    this._touch(id);

    // Return cached schema if fresh (2 min TTL)
    const cached = this._schemaCache.get(id);
    if (!force && cached && (Date.now() - cached.timestamp) < 120000) {
      return { success: true, tables: cached.tables };
    }

    try {
      const tables = await this._getSchemaForType(conn.config.type, conn.client, conn.config);
      this._schemaCache.set(id, { tables, timestamp: Date.now() });
      return { success: true, tables };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute a query
   * @param {string} id - Connection ID
   * @param {string} sql - SQL query or MongoDB command
   * @param {number} limit - Max rows (default 100)
   * @returns {Object} { success, columns?, rows?, rowCount?, duration?, error? }
   */
  async executeQuery(id, sql, limit = 100, { allowDestructive = false } = {}) {
    const conn = this.connections.get(id);
    if (!conn) return { success: false, error: 'Not connected' };
    this._touch(id);

    // Block destructive SQL unless explicitly allowed
    if (!allowDestructive && conn.config.type !== 'mongodb' && conn.config.type !== 'redis') {
      if (DESTRUCTIVE_SQL_RE.test(sql)) {
        return { success: false, error: 'Destructive query blocked (DROP, DELETE FROM, TRUNCATE, ALTER). Pass allowDestructive flag to override.' };
      }
    }

    const start = Date.now();
    try {
      const queryPromise = this._executeForType(conn.config.type, conn.client, sql, limit, conn.config);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout (30s)')), QUERY_TIMEOUT)
      );
      const result = await Promise.race([queryPromise, timeoutPromise]);
      result.duration = Date.now() - start;
      result.success = true;
      return result;
    } catch (error) {
      return { success: false, error: error.message, duration: Date.now() - start };
    }
  }

  /**
   * Detect databases in a project directory
   * @param {string} projectPath
   * @returns {Array} detected connection configs
   */
  async detectDatabases(projectPath) {
    const detected = [];

    // 1. Check multiple .env files
    for (const envName of ['.env', '.env.local', '.env.development', '.env.production', '.env.test']) {
      try {
        const envPath = path.join(projectPath, envName);
        if (fs.existsSync(envPath)) {
          const envContent = fs.readFileSync(envPath, 'utf8');
          detected.push(...this._parseEnvForDatabases(envContent, envName));
        }
      } catch (e) { /* ignore */ }
    }

    // 2. Check docker-compose.yml
    try {
      for (const name of ['docker-compose.yml', 'docker-compose.yaml']) {
        const composePath = path.join(projectPath, name);
        if (fs.existsSync(composePath)) {
          const content = fs.readFileSync(composePath, 'utf8');
          detected.push(...this._parseDockerCompose(content));
          break;
        }
      }
    } catch (e) { /* ignore */ }

    // 3. Check for SQLite files
    try {
      const sqliteFiles = this._findSqliteFiles(projectPath, 2);
      for (const filePath of sqliteFiles) {
        detected.push({ type: 'sqlite', name: `SQLite - ${path.basename(filePath)}`, filePath, detectedFrom: 'file' });
      }
    } catch (e) { /* ignore */ }

    // 4. Check prisma/schema.prisma
    try {
      const prismaPath = path.join(projectPath, 'prisma', 'schema.prisma');
      if (fs.existsSync(prismaPath)) {
        const content = fs.readFileSync(prismaPath, 'utf8');
        const prismaDetected = this._parsePrismaSchema(content);
        if (prismaDetected) detected.push(prismaDetected);
      }
    } catch (e) { /* ignore */ }

    // 5. Scan package.json dependencies
    try {
      detected.push(...await this._scanPackageJsonDeps(projectPath));
    } catch (e) { /* ignore */ }

    // 6. Scan ORM config files
    try {
      detected.push(...await this._scanOrmConfigs(projectPath));
    } catch (e) { /* ignore */ }

    // 7. Port scan for running local services
    try {
      detected.push(...await this._scanLocalPorts());
    } catch (e) { /* ignore */ }

    return this._deduplicateDetected(detected);
  }

  // ==================== Persistence ====================

  /**
   * Save connections config to disk (without passwords)
   * @param {Array} connections
   */
  async saveConnections(connections) {
    const dir = path.dirname(DATABASES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Strip passwords before saving
    const safe = connections.map(c => {
      const { password, ...rest } = c;
      return rest;
    });

    const tmpFile = DATABASES_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(safe, null, 2), 'utf8');
    fs.renameSync(tmpFile, DATABASES_FILE);
  }

  /**
   * Load connections config from disk
   * @returns {Array}
   */
  async loadConnections() {
    try {
      if (fs.existsSync(DATABASES_FILE)) {
        return JSON.parse(fs.readFileSync(DATABASES_FILE, 'utf8'));
      }
    } catch (e) {
      console.error('[Database] Error loading connections:', e);
    }
    return [];
  }

  // ==================== Credential Storage ====================

  /**
   * Store password in OS keychain
   * @param {string} id - Connection ID
   * @param {string} password
   */
  async setCredential(id, password) {
    try {
      const keytar = require('keytar');
      await keytar.setPassword(KEYTAR_SERVICE, `db-${id}`, password);
      return { success: true };
    } catch (e) {
      console.error('[Database] Failed to store credential:', e);
      return { success: false, error: e.message };
    }
  }

  /**
   * Retrieve password from OS keychain
   * @param {string} id - Connection ID
   * @returns {Object} { success, password? }
   */
  async getCredential(id) {
    try {
      const keytar = require('keytar');
      const password = await keytar.getPassword(KEYTAR_SERVICE, `db-${id}`);
      return { success: true, password };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Delete credential from OS keychain
   * @param {string} id
   */
  async deleteCredential(id) {
    try {
      const keytar = require('keytar');
      await keytar.deletePassword(KEYTAR_SERVICE, `db-${id}`);
    } catch (e) { /* ignore */ }
  }

  // ==================== MCP Provisioning ====================

  /**
   * Provision the unified claude-terminal MCP in global ~/.claude.json.
   * Called once at app startup. The MCP server reads databases.json itself,
   * so we only need to pass CT_DATA_DIR, NODE_PATH, and DB passwords.
   * @returns {Object} { success }
   */
  async provisionGlobalMcp() {
    try {
      const homeDir = require('os').homedir();
      const claudeFile = path.join(homeDir, '.claude.json');

      let config = {};
      if (fs.existsSync(claudeFile)) {
        try {
          config = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
        } catch (e) { /* start fresh */ }
      }

      if (!config.mcpServers) config.mcpServers = {};

      // Build env vars
      const env = {
        CT_DATA_DIR: dataDir,
        NODE_PATH: this._getNodeModulesPath(),
      };

      // Add password env vars for all connections
      const connections = await this.loadConnections();
      for (const conn of connections) {
        if (conn.type !== 'sqlite' && conn.type !== 'mongodb') {
          const cred = await this.getCredential(conn.id);
          if (cred.success && cred.password) {
            env[`CT_DB_PASS_${conn.id}`] = cred.password;
          }
        }
      }

      config.mcpServers['claude-terminal'] = {
        type: 'stdio',
        command: 'node',
        args: [this._getMcpServerPath()],
        env
      };

      // Clean up old per-connection entries
      for (const key of Object.keys(config.mcpServers)) {
        if (key.startsWith('claude-terminal-db-')) {
          delete config.mcpServers[key];
        }
      }

      const tmpFile = claudeFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmpFile, claudeFile);

      // Cleanup: remove stale entries from ~/.claude/settings.json (migration)
      this._cleanupSettingsJson(homeDir);

      console.log('[Database] Global MCP provisioned in ~/.claude.json');
      return { success: true };
    } catch (error) {
      console.error('[Database] Failed to provision global MCP:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==================== Private: Client Creation ====================

  async _createClient(config) {
    switch (config.type) {
      case 'sqlite': return this._createSqliteClient(config);
      case 'mysql':
      case 'mariadb': return this._createMysqlClient(config);
      case 'postgresql': return this._createPgClient(config);
      case 'mongodb': return this._createMongoClient(config);
      case 'redis': return this._createRedisClient(config);
      default: throw new Error(`Unsupported database type: ${config.type}`);
    }
  }

  _createSqliteClient(config) {
    const Database = require('better-sqlite3');
    const dbPath = config.filePath;
    if (!dbPath || !fs.existsSync(dbPath)) {
      throw new Error(`SQLite file not found: ${dbPath}`);
    }
    return new Database(dbPath, { readonly: false });
  }

  _createMysqlClient(config) {
    const mysql = require('mysql2/promise');
    return mysql.createPool({
      host: config.host || 'localhost',
      port: config.port || 3306,
      user: config.username,
      password: config.password,
      database: config.database,
      connectTimeout: 10000,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0
    });
  }

  async _createPgClient(config) {
    const { Pool } = require('pg');
    const pool = new Pool({
      host: config.host || 'localhost',
      port: config.port || 5432,
      user: config.username,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: 10000,
      max: 5
    });
    // Verify connectivity immediately
    const client = await pool.connect();
    client.release();
    return pool;
  }

  async _createMongoClient(config) {
    const { MongoClient } = require('mongodb');
    const uri = config.connectionString ||
      `mongodb://${config.username ? `${config.username}:${config.password}@` : ''}${config.host || 'localhost'}:${config.port || 27017}/${config.database || ''}`;
    const client = new MongoClient(uri, { connectTimeoutMS: 10000, serverSelectionTimeoutMS: 10000 });
    await client.connect();
    return client;
  }

  async _createRedisClient(config) {
    const Redis = require('ioredis');
    const client = new Redis({
      host: config.host || 'localhost',
      port: config.port || 6379,
      password: config.password || undefined,
      db: config.database || 0,
      connectTimeout: 10000,
      lazyConnect: true
    });
    await client.connect();
    return client;
  }

  // ==================== Private: Ping ====================

  async _ping(type, client) {
    switch (type) {
      case 'sqlite':
        client.prepare('SELECT 1').get();
        break;
      case 'mysql':
      case 'mariadb':
        await client.execute('SELECT 1');
        break;
      case 'postgresql':
        await client.query('SELECT 1');
        break;
      case 'mongodb':
        await client.db('admin').command({ ping: 1 });
        break;
      case 'redis':
        await client.ping();
        break;
    }
  }

  // ==================== Private: Close ====================

  async _closeClient(type, client) {
    if (!client) return;
    switch (type) {
      case 'sqlite':
        client.close();
        break;
      case 'mysql':
      case 'mariadb':
        await client.end();
        break;
      case 'postgresql':
        await client.end();
        break;
      case 'mongodb':
        await client.close();
        break;
      case 'redis':
        client.disconnect();
        break;
    }
  }

  // ==================== Private: Schema ====================

  async _getSchemaForType(type, client, config) {
    switch (type) {
      case 'sqlite': return this._getSqliteSchema(client);
      case 'mysql':
      case 'mariadb': return this._getMysqlSchema(client);
      case 'postgresql': return this._getPgSchema(client);
      case 'mongodb': return this._getMongoSchema(client, config);
      case 'redis': return this._getRedisSchema(client);
      default: return [];
    }
  }

  _getSqliteSchema(db) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return tables.map(t => {
      // Use single-quoted string literal for PRAGMA (safer across SQLite versions)
      const escapedName = "'" + t.name.replace(/'/g, "''") + "'";
      const columns = db.prepare(`PRAGMA table_info(${escapedName})`).all();
      return {
        name: t.name,
        columns: columns.map(c => ({
          name: c.name,
          type: c.type || 'TEXT',
          nullable: !c.notnull,
          primaryKey: !!c.pk,
          defaultValue: c.dflt_value
        }))
      };
    });
  }

  async _getMysqlSchema(client) {
    // Single query to get all columns for all tables at once
    const [rows] = await client.query(
      `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
       FROM information_schema.columns
       WHERE TABLE_SCHEMA = DATABASE()
       ORDER BY TABLE_NAME, ORDINAL_POSITION`
    );
    const tableMap = new Map();
    for (const row of rows) {
      const tableName = row.TABLE_NAME;
      if (!tableMap.has(tableName)) tableMap.set(tableName, []);
      tableMap.get(tableName).push({
        name: row.COLUMN_NAME,
        type: row.COLUMN_TYPE,
        nullable: row.IS_NULLABLE === 'YES',
        primaryKey: row.COLUMN_KEY === 'PRI',
        defaultValue: row.COLUMN_DEFAULT
      });
    }
    return Array.from(tableMap.entries()).map(([name, columns]) => ({ name, columns }));
  }

  async _getPgSchema(client) {
    // Two queries to get everything: all columns + all primary keys
    const [colResult, pkResult] = await Promise.all([
      client.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
         ORDER BY table_name, ordinal_position`
      ),
      client.query(
        `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`
      )
    ]);

    // Build PK lookup: tableName -> Set of PK column names
    const pkMap = new Map();
    for (const row of pkResult.rows) {
      if (!pkMap.has(row.table_name)) pkMap.set(row.table_name, new Set());
      pkMap.get(row.table_name).add(row.column_name);
    }

    // Group columns by table
    const tableMap = new Map();
    for (const c of colResult.rows) {
      if (!tableMap.has(c.table_name)) tableMap.set(c.table_name, []);
      const pks = pkMap.get(c.table_name);
      tableMap.get(c.table_name).push({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        primaryKey: pks ? pks.has(c.column_name) : false,
        defaultValue: c.column_default
      });
    }
    return Array.from(tableMap.entries()).map(([name, columns]) => ({ name, columns }));
  }

  async _getMongoSchema(client, config) {
    const dbName = config.database || 'test';
    const db = client.db(dbName);
    const collections = await db.listCollections().toArray();

    // Sample all collections in parallel (batched to avoid overwhelming the server)
    const BATCH_SIZE = 10;
    const result = [];
    for (let i = 0; i < collections.length; i += BATCH_SIZE) {
      const batch = collections.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(async (col) => {
        const docs = await db.collection(col.name).find().limit(50).toArray();
        const fieldMap = new Map();
        for (const doc of docs) {
          for (const [key, value] of Object.entries(doc)) {
            const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
            if (!fieldMap.has(key)) fieldMap.set(key, new Set());
            fieldMap.get(key).add(type);
          }
        }
        return {
          name: col.name,
          columns: Array.from(fieldMap.entries()).map(([name, types]) => ({
            name,
            type: Array.from(types).join(' | '),
            nullable: types.has('null'),
            primaryKey: name === '_id'
          }))
        };
      }));
      result.push(...batchResults);
    }
    return result;
  }

  async _getRedisSchema(client) {
    const info = await client.info('keyspace');
    const dbInfos = [];
    for (const line of info.split('\r\n')) {
      const m = line.match(/^db(\d+):keys=(\d+)/);
      if (m) dbInfos.push({ dbIndex: parseInt(m[1]), keyCount: parseInt(m[2]) });
    }
    if (dbInfos.length === 0) dbInfos.push({ dbIndex: 0, keyCount: 0 });

    // Each Redis database appears as a "table" with a fixed schema
    return dbInfos.map(({ dbIndex, keyCount }) => ({
      name: `db:${dbIndex}`,
      columns: [
        { name: 'key',   type: 'string', primaryKey: true,  nullable: false },
        { name: 'type',  type: 'string', primaryKey: false, nullable: false },
        { name: 'ttl',   type: 'number', primaryKey: false, nullable: true  },
        { name: 'value', type: 'string', primaryKey: false, nullable: true  }
      ]
    }));
  }

  // ==================== Private: Execute Query ====================

  async _executeForType(type, client, sql, limit, config) {
    switch (type) {
      case 'sqlite': return this._executeSqlite(client, sql, limit);
      case 'mysql':
      case 'mariadb': return this._executeMysql(client, sql, limit);
      case 'postgresql': return this._executePg(client, sql, limit);
      case 'mongodb': return this._executeMongo(client, sql, limit, config);
      case 'redis': return this._executeRedis(client, sql, limit);
      default: throw new Error(`Unsupported type: ${type}`);
    }
  }

  _executeSqlite(db, sql, limit) {
    const trimmed = sql.trim();
    const isSelect = /^SELECT|^PRAGMA|^EXPLAIN|^WITH/i.test(trimmed);
    if (isSelect) {
      const rows = db.prepare(trimmed).all();
      const limited = rows.slice(0, limit);
      const columns = limited.length > 0 ? Object.keys(limited[0]) : [];
      return { columns, rows: limited, rowCount: rows.length };
    } else {
      const info = db.prepare(trimmed).run();
      return { columns: ['changes', 'lastInsertRowid'], rows: [{ changes: info.changes, lastInsertRowid: info.lastInsertRowid }], rowCount: 1 };
    }
  }

  async _executeMysql(client, sql, limit) {
    const [rows, fields] = await client.query(sql);
    if (Array.isArray(rows)) {
      const limited = rows.slice(0, limit);
      const columns = fields ? fields.map(f => f.name) : (limited.length > 0 ? Object.keys(limited[0]) : []);
      return { columns, rows: limited, rowCount: rows.length };
    }
    return { columns: ['affectedRows', 'insertId'], rows: [{ affectedRows: rows.affectedRows, insertId: rows.insertId }], rowCount: 1 };
  }

  async _executePg(client, sql, limit) {
    const result = await client.query(sql);
    if (result.rows) {
      const limited = result.rows.slice(0, limit);
      const columns = result.fields ? result.fields.map(f => f.name) : (limited.length > 0 ? Object.keys(limited[0]) : []);
      return { columns, rows: limited, rowCount: result.rowCount };
    }
    return { columns: ['rowCount'], rows: [{ rowCount: result.rowCount }], rowCount: result.rowCount };
  }

  async _executeMongo(client, sql, limit, config) {
    // Simple MongoDB command parser: db.collection.find({...})
    const dbName = config.database || 'test';
    const db = client.db(dbName);

    const findMatch = sql.match(/^db\.(\w+)\.find\((.*)\)$/s);
    const countMatch = sql.match(/^db\.(\w+)\.countDocuments\((.*)\)$/s);
    const aggregateMatch = sql.match(/^db\.(\w+)\.aggregate\((.*)\)$/s);

    if (findMatch) {
      const collection = findMatch[1];
      const filter = findMatch[2].trim() ? JSON.parse(findMatch[2]) : {};
      const docs = await db.collection(collection).find(filter).limit(limit).toArray();
      const columns = docs.length > 0 ? Object.keys(docs[0]) : [];
      return { columns, rows: docs.map(d => this._serializeMongoDoc(d)), rowCount: docs.length };
    } else if (countMatch) {
      const collection = countMatch[1];
      const filter = countMatch[2].trim() ? JSON.parse(countMatch[2]) : {};
      const count = await db.collection(collection).countDocuments(filter);
      return { columns: ['count'], rows: [{ count }], rowCount: 1 };
    } else if (aggregateMatch) {
      const collection = aggregateMatch[1];
      const pipeline = JSON.parse(aggregateMatch[2]);
      const docs = await db.collection(collection).aggregate(pipeline).limit(limit).toArray();
      const columns = docs.length > 0 ? Object.keys(docs[0]) : [];
      return { columns, rows: docs.map(d => this._serializeMongoDoc(d)), rowCount: docs.length };
    }

    throw new Error('Unsupported MongoDB command. Use: db.collection.find({...}), db.collection.countDocuments({...}), or db.collection.aggregate([...])');
  }

  _serializeMongoDoc(doc) {
    const result = {};
    for (const [key, value] of Object.entries(doc)) {
      if (value && typeof value === 'object' && value.constructor && value.constructor.name === 'ObjectId') {
        result[key] = value.toString();
      } else if (value instanceof Date) {
        result[key] = value.toISOString();
      } else if (typeof value === 'object' && value !== null) {
        result[key] = JSON.stringify(value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  async _executeRedis(client, command, limit) {
    const trimmed = command.trim();

    // Special internal command: _REDIS_SCAN {dbIndex} {limit} {offset} {pattern?}
    const scanMatch = trimmed.match(/^_REDIS_SCAN\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+(.+))?$/);
    if (scanMatch) {
      const dbIndex = parseInt(scanMatch[1]);
      const pageSize = parseInt(scanMatch[2]);
      const offset = parseInt(scanMatch[3]);
      const pattern = scanMatch[4] ? `*${scanMatch[4]}*` : '*';

      await client.select(dbIndex);
      const allKeys = await this._redisGetAllKeys(client, pattern);
      const total = allKeys.length;
      const pageKeys = allKeys.slice(offset, offset + pageSize);

      const rows = await Promise.all(pageKeys.map(async key => {
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
        return { key, type, ttl: ttl < 0 ? null : ttl, value };
      }));

      return { columns: ['key', 'type', 'ttl', 'value'], rows, rowCount: total };
    }

    // Native Redis command (e.g. "GET mykey", "SET foo bar", "KEYS *")
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (!REDIS_ALLOWED_COMMANDS.has(cmd)) {
      throw new Error(`Redis command "${cmd.toUpperCase()}" is not allowed. Only read/write data commands are permitted.`);
    }

    const result = await client[cmd](...args);
    if (Array.isArray(result)) {
      const limited = result.slice(0, limit);
      return { columns: ['value'], rows: limited.map(v => ({ value: v === null ? null : String(v) })), rowCount: result.length };
    }
    return { columns: ['result'], rows: [{ result: result === null ? null : String(result) }], rowCount: 1 };
  }

  async _redisGetAllKeys(client, pattern = '*') {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys.sort();
  }

  // ==================== Private: Detection Parsers ====================

  _parseEnvForDatabases(content, fileName = '.env') {
    const detected = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;

      const eqIndex = trimmed.indexOf('=');
      const key = trimmed.substring(0, eqIndex).trim();
      let value = trimmed.substring(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!value) continue;

      if (key === 'DATABASE_URL') {
        const parsed = this._parseDatabaseUrl(value);
        if (parsed) detected.push({ ...parsed, detectedFrom: `${fileName} (${key})` });
      } else if (key === 'MONGO_URI' || key === 'MONGODB_URI' || key === 'MONGO_URL') {
        detected.push({ type: 'mongodb', name: `MongoDB - ${key}`, connectionString: value, detectedFrom: `${fileName} (${key})` });
      } else if (key === 'REDIS_URL' || key === 'REDIS_URI') {
        const parsed = this._parseDatabaseUrl(value);
        if (parsed) detected.push({ ...parsed, detectedFrom: `${fileName} (${key})` });
      } else if (key === 'REDIS_HOST') {
        detected.push({ type: 'redis', name: 'Redis', host: value, port: 6379, detectedFrom: `${fileName}` });
      }
    }

    return detected;
  }

  _parseDatabaseUrl(url) {
    try {
      const match = url.match(/^(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?):\/\/(?:([^:@]*):?([^@]*)@)?([^:/]+)(?::(\d+))?(?:\/(.+?))?(?:\?.*)?$/);
      if (!match) return null;

      let type = match[1];
      if (type.startsWith('postgres')) type = 'postgresql';
      if (type.startsWith('mongodb')) type = 'mongodb';
      if (type === 'rediss') type = 'redis';

      const defaultPorts = { mysql: 3306, mariadb: 3306, postgresql: 5432, redis: 6379 };

      if (type === 'mongodb') {
        return { type: 'mongodb', name: `MongoDB - ${match[6] || 'default'}`, connectionString: url };
      }

      if (type === 'redis') {
        return {
          type: 'redis',
          name: `Redis - ${match[4]}`,
          host: match[4],
          port: match[5] ? parseInt(match[5]) : 6379,
          password: match[3] || '',
          database: match[6] ? parseInt(match[6]) : 0
        };
      }

      const dbName = match[6] || '';
      return {
        type,
        name: `${type.charAt(0).toUpperCase() + type.slice(1)} - ${dbName}`,
        host: match[4],
        port: match[5] ? parseInt(match[5]) : (defaultPorts[type] || 5432),
        database: dbName,
        username: match[2] || '',
        password: match[3] || ''
      };
    } catch (e) {
      return null;
    }
  }

  _parseDockerCompose(content) {
    const detected = [];

    // Simple regex-based parsing (no YAML dependency)
    const imageMatches = content.matchAll(/image:\s*['"]?(\S+?)['"]?\s*$/gm);
    for (const match of imageMatches) {
      const image = match[1].toLowerCase();
      if (image.includes('postgres')) {
        detected.push({
          type: 'postgresql',
          name: 'PostgreSQL (Docker)',
          host: 'localhost',
          port: 5432,
          database: 'postgres',
          username: 'postgres',
          detectedFrom: 'docker-compose'
        });
      } else if (image.includes('mariadb')) {
        detected.push({ type: 'mariadb', name: 'MariaDB (Docker)', host: 'localhost', port: 3306, database: 'mariadb', username: 'root', detectedFrom: 'docker-compose' });
      } else if (image.includes('mysql')) {
        detected.push({ type: 'mysql', name: 'MySQL (Docker)', host: 'localhost', port: 3306, database: 'mysql', username: 'root', detectedFrom: 'docker-compose' });
      } else if (image.includes('mongo')) {
        detected.push({ type: 'mongodb', name: 'MongoDB (Docker)', connectionString: 'mongodb://localhost:27017', detectedFrom: 'docker-compose' });
      } else if (image.includes('redis')) {
        detected.push({ type: 'redis', name: 'Redis (Docker)', host: 'localhost', port: 6379, detectedFrom: 'docker-compose' });
      }
    }

    return detected;
  }

  async _scanPackageJsonDeps(projectPath) {
    const detected = [];
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return detected;

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Map of npm package → db type (first match wins per type)
    const pkgToType = {
      'pg': 'postgresql', '@types/pg': 'postgresql', 'postgres': 'postgresql', 'pg-native': 'postgresql',
      'mysql2': 'mysql', 'mysql': 'mysql',
      'mariadb': 'mariadb',
      'mongodb': 'mongodb', 'mongoose': 'mongodb',
      'redis': 'redis', 'ioredis': 'redis', '@redis/client': 'redis',
      'better-sqlite3': 'sqlite', 'sqlite3': 'sqlite', 'sqlite': 'sqlite'
    };
    const defaults = {
      postgresql: { host: 'localhost', port: 5432, database: 'postgres', username: 'postgres' },
      mysql:      { host: 'localhost', port: 3306, database: 'mysql', username: 'root' },
      mariadb:    { host: 'localhost', port: 3306, database: 'mariadb', username: 'root' },
      mongodb:    { connectionString: 'mongodb://localhost:27017' },
      redis:      { host: 'localhost', port: 6379 }
    };

    const found = new Set();
    for (const [pkg, type] of Object.entries(pkgToType)) {
      if (allDeps[pkg] && !found.has(type) && defaults[type]) {
        found.add(type);
        detected.push({
          type,
          name: `${type.charAt(0).toUpperCase() + type.slice(1)} (package.json: ${pkg})`,
          ...defaults[type],
          detectedFrom: `package.json (${pkg})`
        });
      }
    }
    return detected;
  }

  async _scanOrmConfigs(projectPath) {
    const detected = [];
    const typeMap = { postgres: 'postgresql', postgresql: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', sqlite: 'sqlite', mongodb: 'mongodb', 'better-sqlite3': 'sqlite' };

    // ormconfig.json
    try {
      const ormPath = path.join(projectPath, 'ormconfig.json');
      if (fs.existsSync(ormPath)) {
        const config = JSON.parse(fs.readFileSync(ormPath, 'utf8'));
        const type = typeMap[config.type];
        if (type) {
          detected.push({
            type,
            name: `${type} (ormconfig.json)`,
            host: config.host || 'localhost',
            port: config.port,
            database: config.database,
            username: config.username,
            detectedFrom: 'ormconfig.json'
          });
        }
      }
    } catch (e) { /* ignore */ }

    // knexfile.js — regex scan only (no eval)
    try {
      const knexPath = path.join(projectPath, 'knexfile.js');
      if (fs.existsSync(knexPath)) {
        const content = fs.readFileSync(knexPath, 'utf8');
        const clientMatch = content.match(/client\s*:\s*['"]([^'"]+)['"]/);
        if (clientMatch) {
          const type = typeMap[clientMatch[1]];
          if (type) {
            const hostMatch = content.match(/host\s*:\s*['"]([^'"]+)['"]/);
            const portMatch = content.match(/port\s*:\s*(\d+)/);
            const dbMatch   = content.match(/database\s*:\s*['"]([^'"]+)['"]/);
            detected.push({
              type,
              name: `${type} (knexfile.js)`,
              host: hostMatch ? hostMatch[1] : 'localhost',
              port: portMatch ? parseInt(portMatch[1]) : undefined,
              database: dbMatch ? dbMatch[1] : '',
              detectedFrom: 'knexfile.js'
            });
          }
        }
      }
    } catch (e) { /* ignore */ }

    return detected;
  }

  async _scanLocalPorts() {
    const net = require('net');
    const detected = [];
    const portsToCheck = [
      { port: 5432, type: 'postgresql', name: 'PostgreSQL', config: { host: 'localhost', port: 5432, database: 'postgres', username: 'postgres' } },
      { port: 3306, type: 'mysql',      name: 'MySQL',      config: { host: 'localhost', port: 3306, database: 'mysql', username: 'root' } },
      { port: 27017,type: 'mongodb',   name: 'MongoDB',    config: { connectionString: 'mongodb://localhost:27017' } },
      { port: 6379,  type: 'redis',     name: 'Redis',      config: { host: 'localhost', port: 6379 } }
    ];

    const checkPort = (port) => new Promise(resolve => {
      const socket = new net.Socket();
      socket.setTimeout(800);
      socket.on('connect', () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
      socket.on('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, '127.0.0.1');
    });

    await Promise.all(portsToCheck.map(async ({ port, type, name, config }) => {
      if (await checkPort(port)) {
        detected.push({ type, name: `${name} (localhost)`, ...config, detectedFrom: `port:${port}` });
      }
    }));
    return detected;
  }

  _deduplicateDetected(detected) {
    const seen = new Set();
    return detected.filter(d => {
      // Key: type + host+port or connectionString
      const key = d.type + ':' + (d.connectionString || `${d.host || ''}:${d.port || ''}:${d.database || ''}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _findSqliteFiles(dir, maxDepth, currentDepth = 0) {
    if (currentDepth >= maxDepth) return [];
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && /\.(db|sqlite|sqlite3)$/i.test(entry.name)) {
          results.push(fullPath);
        } else if (entry.isDirectory() && currentDepth < maxDepth - 1) {
          results.push(...this._findSqliteFiles(fullPath, maxDepth, currentDepth + 1));
        }
      }
    } catch (e) { /* ignore permission errors */ }
    return results;
  }

  _parsePrismaSchema(content) {
    const providerMatch = content.match(/provider\s*=\s*"(\w+)"/);
    if (!providerMatch) return null;

    const provider = providerMatch[1];
    const typeMap = {
      sqlite: 'sqlite',
      postgresql: 'postgresql',
      mysql: 'mysql',
      mongodb: 'mongodb'
    };
    const type = typeMap[provider];
    if (!type) return null;

    return {
      type,
      name: `${provider.charAt(0).toUpperCase() + provider.slice(1)} (Prisma)`,
      detectedFrom: 'prisma/schema.prisma',
      ...(type === 'sqlite' ? {} : { host: 'localhost' })
    };
  }

  // ==================== Private: Path helpers ====================

  _getMcpServerPath() {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'mcp-servers', 'claude-terminal-mcp.js');
    }
    return path.join(__dirname, '..', '..', '..', 'resources', 'mcp-servers', 'claude-terminal-mcp.js');
  }

  _getNodeModulesPath() {
    if (app.isPackaged) {
      // Native modules live in asar.unpacked, pure JS deps stay in the asar.
      // NODE_PATH must include both so require() resolves either location.
      const sep = process.platform === 'win32' ? ';' : ':';
      const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules');
      const asar = path.join(process.resourcesPath, 'app.asar', 'node_modules');
      return unpacked + sep + asar;
    }
    return path.join(__dirname, '..', '..', '..', 'node_modules');
  }

  /**
   * Remove stale claude-terminal / claude-terminal-db-* entries from
   * ~/.claude/settings.json (migration from old provisioning approach).
   */
  _cleanupSettingsJson(homeDir) {
    try {
      const settingsFile = path.join(homeDir, '.claude', 'settings.json');
      if (!fs.existsSync(settingsFile)) return;
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (!settings.mcpServers) return;
      let changed = false;
      for (const key of Object.keys(settings.mcpServers)) {
        if (key === 'claude-terminal' || key.startsWith('claude-terminal-db-')) {
          delete settings.mcpServers[key];
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
      }
    } catch (e) { /* non-critical */ }
  }
}

// Singleton
const databaseService = new DatabaseService();

module.exports = databaseService;
