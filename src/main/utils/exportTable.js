'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const csv = value => { const text = value == null ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; };
async function exportTable({ filePath, format, columns, rows, signal, progress }) {
  if (!['csv', 'json'].includes(format) || !Array.isArray(columns) || !Array.isArray(rows)) throw new Error('Invalid table export');
  signal?.throwIfAborted();
  const temporary = path.join(path.dirname(filePath), `.ct-export-${randomUUID()}.tmp`);
  async function* chunks() {
    yield format === 'csv' ? '\uFEFF' + columns.map(csv).join(',') + '\r\n' : '[\n';
    let batch = '', lastProgress = 0;
    for (let index = 0; index < rows.length; index++) {
      signal?.throwIfAborted();
      const row = rows[index];
      batch += format === 'csv' ? columns.map(col => csv(row[col])).join(',') + '\r\n' :
        (index ? ',\n' : '') + JSON.stringify(Object.fromEntries(columns.map(col => [col, row[col]])));
      if (batch.length >= 65536 || index % 256 === 255) {
        yield batch; batch = '';
        if (Date.now() - lastProgress >= 150) { progress?.({ completed: index + 1, total: rows.length }); lastProgress = Date.now(); }
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    if (batch) yield batch;
    if (format === 'json') yield '\n]\n';
  }
  try {
    await pipeline(Readable.from(chunks()), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    signal?.throwIfAborted();
    await fs.promises.rename(temporary, filePath);
    return { success: true, filePath, rows: rows.length };
  } finally { await fs.promises.rm(temporary, { force: true }); }
}
module.exports = { exportTable };
