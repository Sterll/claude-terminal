'use strict';

/**
 * db node — exercised against a real sqlite file through the real
 * DatabaseService.
 *
 * The node needs `ctx.databaseService`. Only two of the methods it calls are
 * app-level plumbing that cannot exist in a sandbox: `loadConnections()` reads
 * ~/.claude-terminal/databases.json and `getCredential()` reads the OS
 * keychain. Those two are supplied in memory; everything the scenarios actually
 * make claims about — connect, executeQuery, getSchema, the destructive-SQL
 * guard — is the shipping implementation.
 */

const path = require('path');
const { assert } = require('../sandbox');

const ROOT = path.join(__dirname, '..', '..', '..');
const DB_SERVICE = path.join(ROOT, 'src', 'main', 'services', 'DatabaseService');

const CONN_ID = 'lab-db';

/**
 * Give the sandbox a fresh DatabaseService that knows about one connection.
 * @param {Object} sb
 * @param {Object} conn connection config (needs at least id, type, filePath)
 */
function attachDatabaseService(sb, conn) {
  // The module exports a singleton; take its class so each scenario is isolated.
  const DatabaseServiceClass = require(DB_SERVICE).constructor;
  const svc = new DatabaseServiceClass();
  svc.loadConnections = async () => [conn];
  svc.getCredential   = async () => ({ success: true, password: null });
  sb.ctx.databaseService = svc;
  return svc;
}

/**
 * Seed a sqlite db (items: 2 rows) and wire a service around it.
 *
 * better-sqlite3 is a native module rebuilt for Electron's ABI by
 * `npm install` (electron-rebuild), so it cannot be loaded by a plain `node`
 * process. Run the lab through Electron to exercise these:
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/workflow-lab/run-lab.js --only=db
 */
function seedSqlite(sb) {
  let filePath;
  try {
    filePath = sb.sqlite();
  } catch (err) {
    if (/NODE_MODULE_VERSION/.test(err.message)) {
      throw new Error(
        'better-sqlite3 is built for Electron\'s ABI and cannot load under plain node. Run: '
        + 'ELECTRON_RUN_AS_NODE=1 npx electron scripts/workflow-lab/run-lab.js --only=db'
      );
    }
    throw err;
  }
  if (!filePath) throw new Error('better-sqlite3 is not installed — the db node cannot be exercised');
  attachDatabaseService(sb, { id: CONN_ID, name: 'Lab SQLite', type: 'sqlite', filePath });
  return filePath;
}

module.exports = {
  type: 'db',
  scenarios: [
    {
      name: 'a SELECT returns the seeded rows with their columns and a firstRow',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'SELECT id, name, qty FROM items ORDER BY id', limit: 100 }),
      assert(out) {
        assert.strictEqual(out.rowCount, 2);
        assert.strictEqual(out.rows.length, 2);
        assert.deepStrictEqual(out.columns, ['id', 'name', 'qty']);
        assert.deepStrictEqual(out.firstRow, { id: 1, name: 'alpha', qty: 3 });
        assert.strictEqual(typeof out.duration, 'number');
      },
    },
    {
      name: 'limit truncates the rows returned but rowCount still reports the full result size',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'SELECT * FROM items ORDER BY id', limit: 1 }),
      assert(out) {
        assert.strictEqual(out.rows.length, 1, 'limit did not truncate the rows');
        assert.strictEqual(out.rowCount, 2,
          'rowCount should describe the query result, not the truncated page');
        assert.strictEqual(out.firstRow.name, 'alpha');
      },
    },
    {
      name: 'an empty result set yields no rows, a zero rowCount and a null firstRow',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'SELECT * FROM items WHERE qty > 1000' }),
      assert(out) {
        assert.deepStrictEqual(out.rows, []);
        assert.strictEqual(out.rowCount, 0);
        assert.strictEqual(out.firstRow, null, 'firstRow should be null, not undefined, on an empty result');
        assert.deepStrictEqual(out.columns, []);
      },
    },
    {
      name: 'workflow variables are interpolated into the SQL before it runs',
      async setup(sb) {
        seedSqlite(sb);
        sb.vars.set('minQty', 5);
      },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'SELECT name FROM items WHERE qty > $minQty' }),
      assert(out) {
        assert.strictEqual(out.rowCount, 1, 'the $minQty filter was not applied');
        assert.strictEqual(out.firstRow.name, 'beta');
      },
    },
    {
      name: 'a syntactically invalid query rejects instead of returning an empty result',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'SELCT * FROM items' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /syntax error|SELCT/i, `unhelpful error: ${err.message}`);
      },
    },
    {
      name: 'querying a table that does not exist rejects with the database error',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'SELECT * FROM ghosts' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /no such table/i, `unhelpful error: ${err.message}`);
      },
    },
    {
      name: 'a destructive statement is blocked before it reaches the database',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'DELETE FROM items' }),
      expectThrow: true,
      async assert(err, sb) {
        assert.match(err.message, /destructive/i, `unexpected error: ${err.message}`);
        const check = await sb.ctx.databaseService.executeQuery(CONN_ID, 'SELECT COUNT(*) AS n FROM items');
        assert.strictEqual(check.rows[0].n, 2, 'rows were deleted despite the guard');
      },
    },
    {
      name: 'an empty query rejects rather than running nothing successfully',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'query', query: '   ' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /empty sql/i);
      },
    },
    {
      name: 'the tables action lists the tables in the database',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'tables' }),
      assert(out) {
        assert.deepStrictEqual(out.tables, ['items']);
        assert.strictEqual(out.tableCount, 1);
      },
    },
    {
      name: 'the schema action describes each table column',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: CONN_ID, action: 'schema' }),
      assert(out) {
        assert.strictEqual(out.tableCount, 1);
        const items = out.tables[0];
        assert.strictEqual(items.name, 'items');
        assert.deepStrictEqual(items.columns.map(c => c.name), ['id', 'name', 'qty']);
        assert.strictEqual(items.columns[0].primaryKey, true, 'id should be reported as the primary key');
      },
    },
    {
      name: 'a connection id that is not configured rejects',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: 'not-a-connection', action: 'query', query: 'SELECT 1' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /not found/i);
      },
    },
    {
      name: 'no connection at all rejects instead of guessing one',
      async setup(sb) { seedSqlite(sb); },
      config: () => ({ connection: '', action: 'query', query: 'SELECT 1' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /no database connection/i);
      },
    },
    {
      name: 'a sqlite file that is missing reports a connection failure, not an empty result',
      async setup(sb) {
        attachDatabaseService(sb, {
          id: CONN_ID, name: 'Missing', type: 'sqlite',
          filePath: path.join(sb.dir, 'does-not-exist.db'),
        });
      },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'SELECT 1' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /connection failed/i, `unexpected error: ${err.message}`);
        assert.match(err.message, /not found/i, 'the failure should name the missing file');
      },
    },
    {
      name: 'the node refuses to run without a database service wired in',
      async setup(sb) { sb.ctx.databaseService = null; },
      config: () => ({ connection: CONN_ID, action: 'query', query: 'SELECT 1' }),
      expectThrow: true,
      assert(err) {
        assert.match(err.message, /DatabaseService not available/i);
      },
    },
  ],
};
