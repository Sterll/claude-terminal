import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';

const pending = new Map<string, Promise<void>>();

// CLI and server share a volume: serialize both within and across processes.
async function lockFile<T>(key: string, task: () => Promise<T>): Promise<T> {
  const directory = path.join(config.dataDir, '.locks');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, crypto.createHash('sha256').update(key).digest('hex'));
  const deadline = Date.now() + 30000;
  let handle;
  for (;;) {
    try {
      handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      break;
    } catch (error: any) {
      if (handle) { await handle.close(); await fs.unlink(file); throw error; }
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Storage lock is busy. Retry, or remove the abandoned lock after stopping all server/CLI processes: ' + file);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try { return await task(); }
  finally { await handle.close(); await fs.unlink(file); }
}

export async function withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const result = (pending.get(key) || Promise.resolve()).then(() => lockFile(key, task));
  const settled = result.then(() => {}, () => {});
  pending.set(key, settled);
  try { return await result; }
  finally { if (pending.get(key) === settled) pending.delete(key); }
}
