'use strict';

module.exports = {
  type:     'workflow/db',
  title:    'Database',
  desc:     'Requête base de données',
  color:    'orange',
  width:    220,
  category: 'data',
  icon:     'db',

  inputs:  [{ name: 'In', type: 'exec' }],
  outputs: [
    { name: 'Done',     type: 'exec'   },
    { name: 'Error',    type: 'exec'   },
    { name: 'rows',     type: 'array'  },
    { name: 'firstRow', type: 'object' },
    { name: 'rowCount', type: 'number' },
    { name: 'tables',   type: 'array'  },
  ],

  props: { connection: '', query: '', action: 'query' },

  fields: [
    { type: 'db-config', key: 'connection', label: 'wfn.db.label' },
  ],

  badge: (n) => (n.properties.action || 'query').toUpperCase(),

  async run(config, vars, signal, ctx) {
    const resolveVars = (value, vars) => {
      if (typeof value !== 'string') return value;
      return value.replace(/\$([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)/g, (match, key) => {
        const parts = key.split('.');
        let cur = vars instanceof Map ? vars.get(parts[0]) : vars[parts[0]];
        for (let i = 1; i < parts.length && cur != null; i++) cur = cur[parts[i]];
        return cur != null ? String(cur).replace(/[\r\n]+$/, '') : match;
      });
    };

    const databaseService = ctx?.databaseService;
    if (!databaseService) throw new Error('DatabaseService not available');

    const connId = resolveVars(config.connection || '', vars);
    if (!connId) throw new Error('No database connection specified');

    const action = config.action || 'query';

    const connections = await databaseService.loadConnections();
    const connConfig = connections.find(c => c.id === connId);
    if (!connConfig) throw new Error(`Database connection "${connId}" not found`);

    const cred = await databaseService.getCredential(connId);
    // Use a shallow copy to avoid mutating the cached config object
    const connWithCred = { ...connConfig };
    if (cred?.success && cred.password) {
      connWithCred.password = cred.password;
    }

    const connResult = await databaseService.connect(connId, connWithCred);
    // Wipe password from memory as soon as the connection is established
    if (connWithCred.password) connWithCred.password = '';
    if (!connResult?.success) {
      throw new Error(`Database connection failed: ${connResult?.error || 'Unknown error'}`);
    }

    if (action === 'schema') {
      const schema = await databaseService.getSchema(connId, { force: true });
      if (!schema?.success) throw new Error(schema?.error || 'Failed to get schema');
      const tables = schema.tables || [];
      return { tables, tableCount: tables.length };
    }

    if (action === 'tables') {
      const schema = await databaseService.getSchema(connId, { force: true });
      if (!schema?.success) throw new Error(schema?.error || 'Failed to get schema');
      const tables = (schema.tables || []).map(t => t.name || t.table_name || t);
      return { tables, tableCount: tables.length };
    }

    // action === 'query'
    const sql   = resolveVars(config.query || '', vars);
    const limit = parseInt(config.limit, 10) || 100;

    if (!sql.trim()) throw new Error('Empty SQL query');

    const start    = Date.now();
    const result   = await databaseService.executeQuery(connId, sql, limit);
    const duration = Date.now() - start;

    if (result.error) throw new Error(result.error);

    const rows     = result.rows     || [];
    const columns  = result.columns  || [];
    const rowCount = result.rowCount ?? rows.length;
    const firstRow = rows.length > 0 ? rows[0] : null;

    return { rows, columns, rowCount, duration, firstRow };
  },
};
