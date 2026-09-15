/** @jest-environment node */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportTable } = require('../../src/main/utils/exportTable');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-export-')); });
afterEach(() => fs.rmSync(dir, { force: true, recursive: true }));
test('CSV escapes headers and rows, and JSON preserves typed values', async () => {
  const columns = ['name,quoted', 'value'], rows = [{ 'name,quoted': 'line\rbreak"', value: 42 }, { 'name,quoted': null, value: false }];
  const csv = path.join(dir, 'data.csv');
  await exportTable({ filePath: csv, columns, rows, format: 'csv' });
  expect(fs.readFileSync(csv, 'utf8')).toBe('\uFEFF"name,quoted",value\r\n"line\rbreak""",42\r\n,false\r\n');
  const json = path.join(dir, 'data.json'); await exportTable({ filePath: json, columns, rows, format: 'json' });
  expect(JSON.parse(fs.readFileSync(json, 'utf8'))).toEqual(rows);
});
test('cancelling a running export preserves the destination and retry writes all rows', async () => {
  const filePath = path.join(dir, 'data.json'); fs.writeFileSync(filePath, 'original');
  const controller = new AbortController(), rows = Array.from({ length: 10000 }, (_, id) => ({ id }));
  await expect(exportTable({ filePath, columns: ['id'], rows, format: 'json', signal: controller.signal, progress: () => controller.abort() })).rejects.toThrow();
  expect(fs.readFileSync(filePath, 'utf8')).toBe('original');
  expect(fs.readdirSync(dir)).toEqual(['data.json']);
  await exportTable({ filePath, columns: ['id'], rows, format: 'json' });
  expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(rows);
});
