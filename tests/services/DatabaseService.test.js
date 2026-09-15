// DatabaseService unit tests — focus on pure/testable methods
// Tests detection parsers, persistence, MCP provisioning logic

const path = require('path');
const fs = require('fs');
const os = require('os');

// Mock electron dependencies
jest.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/mock/app',
    getPath: () => require('os').tmpdir()
  }
}));

// Mock keytar
jest.mock('keytar', () => ({
  setPassword: jest.fn().mockResolvedValue(undefined),
  getPassword: jest.fn().mockResolvedValue('secret123'),
  deletePassword: jest.fn().mockResolvedValue(true)
}), { virtual: true });

// Mock native DB drivers (they won't be available in test env)
jest.mock('better-sqlite3', () => {
  return jest.fn().mockImplementation(() => ({
    prepare: jest.fn().mockReturnValue({
      get: jest.fn().mockReturnValue({ result: 1 }),
      all: jest.fn().mockReturnValue([]),
      run: jest.fn().mockReturnValue({ changes: 0, lastInsertRowid: 0 })
    }),
    close: jest.fn()
  }));
}, { virtual: true });

jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn().mockResolvedValue({
    ping: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([[], []]),
    end: jest.fn().mockResolvedValue(undefined)
  })
}), { virtual: true });

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({ rows: [], fields: [] }),
    end: jest.fn().mockResolvedValue(undefined)
  }))
}), { virtual: true });

jest.mock('mongodb', () => ({
  MongoClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    db: jest.fn().mockReturnValue({
      command: jest.fn().mockResolvedValue({ ok: 1 }),
      listCollections: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
      collection: jest.fn().mockReturnValue({
        find: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }) })
      })
    }),
    close: jest.fn().mockResolvedValue(undefined)
  }))
}), { virtual: true });

// Mock paths module
const mockDataDir = require('path').join(require('os').tmpdir(), 'claude-terminal-test-' + Date.now());
if (!require('fs').existsSync(mockDataDir)) require('fs').mkdirSync(mockDataDir, { recursive: true });
jest.mock('../../src/main/utils/paths', () => ({
  dataDir: mockDataDir
}));

const databaseService = require('../../src/main/services/DatabaseService');

// ==================== Detection Parsers ====================

describe('DatabaseService._parseEnvForDatabases', () => {
  test('detects DATABASE_URL with PostgreSQL', () => {
    const env = 'DATABASE_URL=postgresql://user:pass@localhost:5432/mydb';
    const result = databaseService._parseEnvForDatabases(env);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('postgresql');
    expect(result[0].host).toBe('localhost');
    expect(result[0].port).toBe(5432);
    expect(result[0].database).toBe('mydb');
    expect(result[0].username).toBe('user');
  });

  test('detects DATABASE_URL with MySQL', () => {
    const env = 'DATABASE_URL=mysql://root:secret@db-host:3306/production';
    const result = databaseService._parseEnvForDatabases(env);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('mysql');
    expect(result[0].host).toBe('db-host');
    expect(result[0].database).toBe('production');
  });

  test('detects MONGO_URI', () => {
    const env = 'MONGO_URI=mongodb://localhost:27017/testdb';
    const result = databaseService._parseEnvForDatabases(env);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('mongodb');
    expect(result[0].connectionString).toBe('mongodb://localhost:27017/testdb');
  });

  test('detects MONGODB_URI', () => {
    const env = 'MONGODB_URI=mongodb://user:pass@cluster.example.com/mydb';
    const result = databaseService._parseEnvForDatabases(env);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('mongodb');
  });

  test('ignores comments and empty lines', () => {
    const env = `# This is a comment
PORT=3000
# DATABASE_URL=ignored
NODE_ENV=production`;
    const result = databaseService._parseEnvForDatabases(env);
    expect(result).toHaveLength(0);
  });

  test('handles quoted values', () => {
    const env = `DATABASE_URL="postgresql://user:pass@localhost:5432/mydb"`;
    const result = databaseService._parseEnvForDatabases(env);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('postgresql');
  });

  test('handles single-quoted values', () => {
    const env = `DATABASE_URL='mysql://root:pass@localhost:3306/db'`;
    const result = databaseService._parseEnvForDatabases(env);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('mysql');
  });

  test('detects multiple databases', () => {
    const env = `DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
MONGO_URI=mongodb://localhost:27017/testdb`;
    const result = databaseService._parseEnvForDatabases(env);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('postgresql');
    expect(result[1].type).toBe('mongodb');
  });
});

describe('DatabaseService._parseDatabaseUrl', () => {
  test('parses PostgreSQL URL', () => {
    const result = databaseService._parseDatabaseUrl('postgresql://admin:s3cret@db.example.com:5433/app_db');
    expect(result.type).toBe('postgresql');
    expect(result.host).toBe('db.example.com');
    expect(result.port).toBe(5433);
    expect(result.database).toBe('app_db');
    expect(result.username).toBe('admin');
    expect(result.password).toBe('s3cret');
  });

  test('parses postgres:// (short form)', () => {
    const result = databaseService._parseDatabaseUrl('postgres://user:pass@localhost:5432/db');
    expect(result.type).toBe('postgresql');
  });

  test('parses MySQL URL', () => {
    const result = databaseService._parseDatabaseUrl('mysql://root:pass@127.0.0.1:3306/myapp');
    expect(result.type).toBe('mysql');
    expect(result.host).toBe('127.0.0.1');
    expect(result.port).toBe(3306);
  });

  test('parses MongoDB URL', () => {
    const result = databaseService._parseDatabaseUrl('mongodb://user:pass@mongo.example.com:27017/production');
    expect(result.type).toBe('mongodb');
    expect(result.connectionString).toContain('mongodb://');
  });

  test('handles URL without credentials', () => {
    const result = databaseService._parseDatabaseUrl('postgresql://localhost:5432/testdb');
    expect(result.type).toBe('postgresql');
    expect(result.host).toBe('localhost');
    expect(result.username).toBe('');
  });

  test('handles URL with query params', () => {
    const result = databaseService._parseDatabaseUrl('postgresql://user:pass@host:5432/db?sslmode=require');
    expect(result).not.toBeNull();
    expect(result.database).toBe('db');
  });

  test('returns null for invalid URLs', () => {
    expect(databaseService._parseDatabaseUrl('not-a-url')).toBeNull();
    expect(databaseService._parseDatabaseUrl('')).toBeNull();
    expect(databaseService._parseDatabaseUrl('ftp://something')).toBeNull();
  });
});

describe('DatabaseService._parseDockerCompose', () => {
  test('detects PostgreSQL from docker-compose', () => {
    const yaml = `services:
  db:
    image: postgres:15`;
    const result = databaseService._parseDockerCompose(yaml);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('postgresql');
    expect(result[0].host).toBe('localhost');
    expect(result[0].detectedFrom).toBe('docker-compose');
  });

  test('detects MySQL from docker-compose', () => {
    const yaml = `services:
  database:
    image: mysql:8.0`;
    const result = databaseService._parseDockerCompose(yaml);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('mysql');
  });

  test('detects MariaDB from docker-compose', () => {
    const yaml = `services:
  db:
    image: mariadb:10`;
    const result = databaseService._parseDockerCompose(yaml);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('mariadb');
    expect(result[0].name).toContain('MariaDB');
  });

  test('detects MongoDB from docker-compose', () => {
    const yaml = `services:
  mongo:
    image: mongo:7`;
    const result = databaseService._parseDockerCompose(yaml);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('mongodb');
  });

  test('detects multiple databases', () => {
    const yaml = `services:
  db:
    image: postgres:15
  cache:
    image: redis:7
  mongo:
    image: mongo:7`;
    const result = databaseService._parseDockerCompose(yaml);
    expect(result).toHaveLength(3);
    expect(result.map(d => d.type).sort()).toEqual(['mongodb', 'postgresql', 'redis']);
  });

  test('ignores non-database images', () => {
    const yaml = `services:
  web:
    image: nginx:latest
  app:
    image: node:20`;
    const result = databaseService._parseDockerCompose(yaml);
    expect(result).toHaveLength(0);
  });
});

describe('DatabaseService._parsePrismaSchema', () => {
  test('detects PostgreSQL provider', () => {
    const schema = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}`;
    const result = databaseService._parsePrismaSchema(schema);
    expect(result).not.toBeNull();
    expect(result.type).toBe('postgresql');
    expect(result.detectedFrom).toBe('prisma/schema.prisma');
  });

  test('detects MySQL provider', () => {
    const schema = `datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}`;
    const result = databaseService._parsePrismaSchema(schema);
    expect(result.type).toBe('mysql');
  });

  test('detects SQLite provider', () => {
    const schema = `datasource db {
  provider = "sqlite"
  url      = "file:./dev.db"
}`;
    const result = databaseService._parsePrismaSchema(schema);
    expect(result.type).toBe('sqlite');
  });

  test('detects MongoDB provider', () => {
    const schema = `datasource db {
  provider = "mongodb"
  url      = env("MONGO_URI")
}`;
    const result = databaseService._parsePrismaSchema(schema);
    expect(result.type).toBe('mongodb');
  });

  test('returns null for unknown provider', () => {
    const schema = `datasource db {
  provider = "cockroachdb"
  url      = env("DATABASE_URL")
}`;
    const result = databaseService._parsePrismaSchema(schema);
    expect(result).toBeNull();
  });

  test('returns null for missing provider', () => {
    const schema = `generator client {
  provider = "prisma-client-js"
}`;
    const result = databaseService._parsePrismaSchema(schema);
    expect(result).toBeNull();
  });
});

// ==================== SQLite File Detection ====================

describe('DatabaseService._findSqliteFiles', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), 'db-test-sqlite-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('finds .db files', () => {
    fs.writeFileSync(path.join(tmpDir, 'test.db'), '');
    const result = databaseService._findSqliteFiles(tmpDir, 2);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('test.db');
  });

  test('finds .sqlite files', () => {
    fs.writeFileSync(path.join(tmpDir, 'data.sqlite'), '');
    const result = databaseService._findSqliteFiles(tmpDir, 2);
    expect(result).toHaveLength(1);
  });

  test('finds .sqlite3 files', () => {
    fs.writeFileSync(path.join(tmpDir, 'data.sqlite3'), '');
    const result = databaseService._findSqliteFiles(tmpDir, 2);
    expect(result).toHaveLength(1);
  });

  test('finds files in subdirectories within depth', () => {
    const subDir = path.join(tmpDir, 'data');
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(subDir, 'app.db'), '');
    const result = databaseService._findSqliteFiles(tmpDir, 2);
    expect(result).toHaveLength(1);
  });

  test('ignores files beyond max depth', () => {
    const deep = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deep.db'), '');
    const result = databaseService._findSqliteFiles(tmpDir, 2);
    expect(result).toHaveLength(0);
  });

  test('skips node_modules', () => {
    const nm = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(nm);
    fs.writeFileSync(path.join(nm, 'cache.db'), '');
    const result = databaseService._findSqliteFiles(tmpDir, 2);
    expect(result).toHaveLength(0);
  });

  test('skips dotfiles and dotdirs', () => {
    const hidden = path.join(tmpDir, '.hidden');
    fs.mkdirSync(hidden);
    fs.writeFileSync(path.join(hidden, 'secret.db'), '');
    const result = databaseService._findSqliteFiles(tmpDir, 2);
    expect(result).toHaveLength(0);
  });

  test('returns empty for empty directory', () => {
    const result = databaseService._findSqliteFiles(tmpDir, 2);
    expect(result).toHaveLength(0);
  });
});

// ==================== Persistence ====================

describe('DatabaseService persistence', () => {
  const dbFile = path.join(mockDataDir, 'databases.json');

  afterEach(() => {
    try { fs.unlinkSync(dbFile); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(dbFile + '.tmp'); } catch (e) { /* ignore */ }
  });

  test('saveConnections writes JSON file', async () => {
    const connections = [
      { id: 'db1', name: 'Test', type: 'sqlite', filePath: '/test.db' },
      { id: 'db2', name: 'PG', type: 'postgresql', host: 'localhost' }
    ];
    await databaseService.saveConnections(connections);

    expect(fs.existsSync(dbFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    expect(saved).toHaveLength(2);
    expect(saved[0].id).toBe('db1');
    expect(saved[1].id).toBe('db2');
  });

  test('saveConnections strips passwords', async () => {
    const connections = [
      { id: 'db1', name: 'Test', type: 'mysql', password: 'secret123' }
    ];
    await databaseService.saveConnections(connections);

    const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    expect(saved[0].password).toBeUndefined();
    expect(saved[0].name).toBe('Test');
  });

  test('loadConnections reads saved data', async () => {
    const data = [{ id: 'db1', name: 'Loaded', type: 'sqlite' }];
    fs.writeFileSync(dbFile, JSON.stringify(data), 'utf8');

    const loaded = await databaseService.loadConnections();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('Loaded');
  });

  test('loadConnections returns empty array when file missing', async () => {
    const loaded = await databaseService.loadConnections();
    expect(loaded).toEqual([]);
  });

  test('loadConnections returns empty array on corrupted file', async () => {
    fs.writeFileSync(dbFile, 'not-json{{{', 'utf8');
    const loaded = await databaseService.loadConnections();
    expect(loaded).toEqual([]);
  });
});

// ==================== MCP Provisioning (Global) ====================

describe('DatabaseService MCP provisioning', () => {
  let tmpHome;
  let originalHomedir;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), 'db-test-mcp-' + Date.now());
    fs.mkdirSync(tmpHome, { recursive: true });
    // Mock os.homedir to use our temp dir
    originalHomedir = os.homedir;
    os.homedir = () => tmpHome;
  });

  afterEach(() => {
    os.homedir = originalHomedir;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('provisionGlobalMcp creates claude.json with MCP entry', async () => {
    const result = await databaseService.provisionGlobalMcp();

    expect(result.success).toBe(true);

    const claudeFile = path.join(tmpHome, '.claude.json');
    expect(fs.existsSync(claudeFile)).toBe(true);

    const config = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers['claude-terminal']).toBeDefined();

    const serverConfig = config.mcpServers['claude-terminal'];
    expect(serverConfig.type).toBe('stdio');
    expect(serverConfig.command).toBe(process.execPath);
    expect(serverConfig.env.CT_DATA_DIR).toBeTruthy();
    expect(serverConfig.env.NODE_PATH).toBeTruthy();
  });

  test('provisionGlobalMcp preserves existing mcpServers', async () => {
    const claudeFile = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeFile, JSON.stringify({
      mcpServers: { 'other-server': { command: 'test' } },
      someOtherKey: 'value'
    }), 'utf8');

    await databaseService.provisionGlobalMcp();

    const config = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    expect(config.mcpServers['other-server']).toBeDefined();
    expect(config.mcpServers['claude-terminal']).toBeDefined();
    expect(config.someOtherKey).toBe('value');
  });

  test('provisionGlobalMcp cleans up old per-connection entries', async () => {
    const claudeFile = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeFile, JSON.stringify({
      mcpServers: {
        'claude-terminal-db-old-1': { command: 'old' },
        'claude-terminal-db-old-2': { command: 'old' },
        'keep-this': { command: 'keep' },
      }
    }), 'utf8');

    await databaseService.provisionGlobalMcp();

    const config = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    expect(config.mcpServers['claude-terminal-db-old-1']).toBeUndefined();
    expect(config.mcpServers['claude-terminal-db-old-2']).toBeUndefined();
    expect(config.mcpServers['keep-this']).toBeDefined();
    expect(config.mcpServers['claude-terminal']).toBeDefined();
  });

  test('provisionGlobalMcp handles missing claude.json', async () => {
    // No file exists — should create it
    const result = await databaseService.provisionGlobalMcp();
    expect(result.success).toBe(true);

    const claudeFile = path.join(tmpHome, '.claude.json');
    expect(fs.existsSync(claudeFile)).toBe(true);
  });

  test('provisionGlobalMcp leaves an unparseable claude.json untouched', async () => {
    // ~/.claude.json belongs to the CLI: projects, oauthAccount, per-project
    // mcpServers. Provisioning must give up rather than rewrite it from {},
    // which is what a truncated read (the CLI writing concurrently) would
    // otherwise turn into total config loss.
    const claudeFile = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeFile, '{not valid json!!!', 'utf8');
    const result = await databaseService.provisionGlobalMcp();
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();

    expect(fs.readFileSync(claudeFile, 'utf8')).toBe('{not valid json!!!');
  });

  test('provisionGlobalMcp preserves unrelated top-level keys', async () => {
    const claudeFile = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeFile, JSON.stringify({
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: { '/some/path': { mcpServers: { local: { command: 'x' } } } },
      mcpServers: { other: { command: 'keep-me' } }
    }), 'utf8');

    const result = await databaseService.provisionGlobalMcp();
    expect(result.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    expect(config.oauthAccount.emailAddress).toBe('someone@example.com');
    expect(config.projects['/some/path'].mcpServers.local.command).toBe('x');
    expect(config.mcpServers.other.command).toBe('keep-me');
    expect(config.mcpServers['claude-terminal']).toBeDefined();
  });

  test('provisioning excludes database passwords from the MCP configuration', async () => {
    await databaseService.saveConnections([{ id: 'secure', type: 'mysql', password: 'sensitive-value' }]);
    expect((await databaseService.provisionGlobalMcp()).success).toBe(true);
    const content = fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf8');
    expect(content).not.toContain('CT_DB_PASS');
    expect(content).not.toContain('sensitive-value');
  });

  test('MongoDB URI credentials migrate to the keychain without losing host or database', async () => {
    await databaseService.saveConnections([{ id: 'mongo', type: 'mongodb', connectionString: 'mongodb://user:p%40ss@host1:27017,host2:27017/db?replicaSet=rs' }]);
    const [connection] = await databaseService.loadConnections();
    expect(connection.connectionString).toBe('mongodb://host1:27017,host2:27017/db?replicaSet=rs');
    expect(connection.username).toBe('user');
    expect(require('keytar').setPassword).toHaveBeenCalledWith('claude-terminal-db', 'db-mongo', 'p@ss');
  });

  test('provisionGlobalMcp overwrites previous claude-terminal entry', async () => {
    const claudeFile = path.join(tmpHome, '.claude.json');
    fs.writeFileSync(claudeFile, JSON.stringify({
      mcpServers: { 'claude-terminal': { command: 'old-value', args: ['old'] } }
    }), 'utf8');

    await databaseService.provisionGlobalMcp();

    const config = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
    expect(config.mcpServers['claude-terminal'].command).toBe(process.execPath);
    expect(config.mcpServers['claude-terminal'].args[0]).not.toBe('old');
  });

  test('provisionGlobalMcp returns success false on write error', async () => {
    // Make homedir a file instead of directory to cause error
    const badHome = path.join(os.tmpdir(), 'db-test-badhome-' + Date.now());
    fs.writeFileSync(badHome, 'not a dir', 'utf8');
    os.homedir = () => badHome;

    const result = await databaseService.provisionGlobalMcp();
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();

    fs.unlinkSync(badHome);
  });
});

// ==================== Connection Management ====================

describe('DatabaseService connection management', () => {
  afterEach(async () => {
    await databaseService.disconnectAll();
  });

  test('connect stores connection in map', async () => {
    const config = { type: 'sqlite', filePath: __filename }; // Use this file as a "db" for mock
    const result = await databaseService.connect('test-conn', config);
    expect(result.success).toBe(true);
    expect(databaseService.connections.has('test-conn')).toBe(true);
  });

  test('disconnect removes connection', async () => {
    const config = { type: 'sqlite', filePath: __filename };
    await databaseService.connect('test-conn', config);
    await databaseService.disconnect('test-conn');
    expect(databaseService.connections.has('test-conn')).toBe(false);
  });

  test('disconnect on non-existent connection succeeds', async () => {
    const result = await databaseService.disconnect('nonexistent');
    expect(result.success).toBe(true);
  });

  test('disconnectAll clears all connections', async () => {
    const config = { type: 'sqlite', filePath: __filename };
    await databaseService.connect('conn-1', config);
    await databaseService.connect('conn-2', config);
    expect(databaseService.connections.size).toBe(2);

    await databaseService.disconnectAll();
    expect(databaseService.connections.size).toBe(0);
  });

  test('connect replaces existing connection with same id', async () => {
    const config = { type: 'sqlite', filePath: __filename };
    await databaseService.connect('dup', config);
    await databaseService.connect('dup', config);
    expect(databaseService.connections.size).toBe(1);
  });
});

// ==================== MongoDB Document Serialization ====================

describe('DatabaseService._serializeMongoDoc', () => {
  test('converts Date to ISO string', () => {
    const date = new Date('2024-01-15T10:30:00Z');
    const result = databaseService._serializeMongoDoc({ created: date });
    expect(result.created).toBe('2024-01-15T10:30:00.000Z');
  });

  test('stringifies nested objects', () => {
    const result = databaseService._serializeMongoDoc({ meta: { key: 'value' } });
    expect(result.meta).toBe('{"key":"value"}');
  });

  test('passes primitive values through', () => {
    const result = databaseService._serializeMongoDoc({
      name: 'test',
      age: 25,
      active: true,
      nothing: null
    });
    expect(result.name).toBe('test');
    expect(result.age).toBe(25);
    expect(result.active).toBe(true);
    expect(result.nothing).toBeNull();
  });
});

// ==================== Schema & Query (mocked) ====================

describe('DatabaseService getSchema/executeQuery edge cases', () => {
  test('getSchema returns error when not connected', async () => {
    const result = await databaseService.getSchema('not-connected');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not connected');
  });

  test('executeQuery returns error when not connected', async () => {
    const result = await databaseService.executeQuery('not-connected', 'SELECT 1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not connected');
  });

  test('executeQuery includes duration', async () => {
    const config = { type: 'sqlite', filePath: __filename };
    await databaseService.connect('timed', config);
    const result = await databaseService.executeQuery('timed', 'SELECT 1');
    expect(result.duration).toBeDefined();
    expect(typeof result.duration).toBe('number');
    await databaseService.disconnect('timed');
  });
});

// ==================== Credential Storage ====================

describe('DatabaseService credentials', () => {
  test('setCredential calls keytar', async () => {
    const result = await databaseService.setCredential('db1', 'mypassword');
    expect(result.success).toBe(true);

    const keytar = require('keytar');
    expect(keytar.setPassword).toHaveBeenCalledWith('claude-terminal-db', 'db-db1', 'mypassword');
  });

  test('getCredential retrieves from keytar', async () => {
    const result = await databaseService.getCredential('db1');
    expect(result.success).toBe(true);
    expect(result.password).toBe('secret123');

    const keytar = require('keytar');
    expect(keytar.getPassword).toHaveBeenCalledWith('claude-terminal-db', 'db-db1');
  });
});
