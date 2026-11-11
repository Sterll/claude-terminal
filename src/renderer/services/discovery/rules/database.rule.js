/**
 * A project with a database in it: the Database screen can open it.
 *
 * Signal: `project:opened`. Two cheap clues only, read from the project's own
 * folder: a SQLite file (.db, .sqlite, .sqlite3) at the root or in one of a
 * few usual folders, or a DATABASE_URL line in one of its .env files. Not the
 * Database screen's full detection, which also scans package.json and probes
 * local ports: a project that merely depends on `pg` is not a reason to speak.
 *
 * Local projects only. A remote (SSH) project's files are on its host and the
 * Database screen does not detect there (`databaseDetect` in
 * src/shared/remote-capabilities.js), so this never reads anything for one.
 */

const SQLITE_FILE = /\.(db|sqlite|sqlite3)$/i;
const SUBFOLDERS = ['data', 'db', 'database', 'prisma'];
const ENV_FILES = ['.env', '.env.local', '.env.development'];
const DATABASE_URL = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*\S/m;
const MAX_ENV_BYTES = 64 * 1024;

async function findSqliteFile(ctx, dir, depth) {
  let entries;
  try {
    entries = await ctx.fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && SQLITE_FILE.test(entry.name)) return entry.name;
  }
  if (depth > 0) {
    for (const entry of entries) {
      if (entry.isDirectory() && SUBFOLDERS.includes(entry.name.toLowerCase())) {
        const found = await findSqliteFile(ctx, ctx.joinPath(dir, entry.name), depth - 1);
        if (found) return `${entry.name}/${found}`;
      }
    }
  }
  return null;
}

async function envHasDatabaseUrl(ctx, dir) {
  for (const name of ENV_FILES) {
    try {
      const text = await ctx.fs.readFile(ctx.joinPath(dir, name), 'utf8');
      if (DATABASE_URL.test(String(text).slice(0, MAX_ENV_BYTES))) return name;
    } catch {
      // absent: try the next one
    }
  }
  return null;
}

/**
 * @returns {Promise<{ kind: 'sqlite', file: string } | { kind: 'env', file: string } | null>}
 */
async function scanProject(ctx, project) {
  if (!project || !project.path) return null;
  if (!ctx.can(project, 'databaseDetect').ok) return null;
  const sqlite = await findSqliteFile(ctx, project.path, 1);
  if (sqlite) return { kind: 'sqlite', file: sqlite };
  const env = await envHasDatabaseUrl(ctx, project.path);
  if (env) return { kind: 'env', file: env };
  return null;
}

module.exports = {
  id: 'database',
  triggers: ['project:opened'],
  usedWhen: ['tab:database'],
  titleKey: 'discovery.rules.database.title',
  bodyKey: 'discovery.rules.database.bodySqlite',
  action: { type: 'tab', tab: 'database' },

  async condition(payload, ctx) {
    const found = await scanProject(ctx, payload && payload.project);
    if (!found) return false;
    return {
      params: { file: found.file, project: payload.project.name || '' },
      bodyKey: found.kind === 'sqlite' ? 'discovery.rules.database.bodySqlite' : 'discovery.rules.database.bodyEnv',
    };
  },

  /** A saved connection means the screen is already in use. */
  async isUsed(ctx) {
    try {
      const connections = await ctx.api.database.loadConnections();
      return Array.isArray(connections) && connections.length > 0;
    } catch {
      return false;
    }
  },

  scanProject,
  SQLITE_FILE,
  DATABASE_URL,
};
