import { DurableObject } from 'cloudflare:workers';

// One object per workflow (imports) or IP (hourly quota), never one global lock.
export class HubCounter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK(id = 1), period TEXT, value INTEGER NOT NULL)');
  }
  consume(limit, initial = 0, period = 'all') {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('INSERT OR IGNORE INTO counter VALUES (1, ?, ?)', period, Math.max(0, Number(initial) || 0));
      sql.exec('UPDATE counter SET period = ?, value = 0 WHERE period != ?', period, period);
      const rows = sql.exec('UPDATE counter SET value = value + 1 WHERE value < ? RETURNING value', limit).toArray();
      return rows.length ? rows[0].value : null;
    });
  }
  value(initial = 0) {
    const rows = this.ctx.storage.sql.exec('SELECT value FROM counter WHERE id = 1').toArray();
    return rows[0]?.value ?? initial;
  }
}
