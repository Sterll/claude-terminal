import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config';

const ALLOWED_ENTITIES = [
  'settings', 'projects', 'timetracking', 'mcp',
  'skills', 'agents', 'memory', 'hooks', 'plugins',
] as const;

export type EntityType = typeof ALLOWED_ENTITIES[number];

export interface EntityEnvelope {
  data: any;
  updatedAt: number;
  hash: string;
}

export interface PutResult {
  ok: boolean;
  conflict?: boolean;
  serverData?: EntityEnvelope;
  updatedAt?: number;
  hash?: string;
}

export type EntityManifest = Record<string, { updatedAt: number; hash: string }>;

function computeHash(data: any): string {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  await fs.promises.writeFile(tmpPath, content, 'utf-8');
  await fs.promises.rename(tmpPath, filePath);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

class EntityStore {
  isValidType(type: string): type is EntityType {
    return ALLOWED_ENTITIES.includes(type as EntityType);
  }

  private entityDir(userName: string): string {
    return path.join(config.usersDir, userName, 'entities');
  }

  private entityPath(userName: string, type: EntityType): string {
    return path.join(this.entityDir(userName), `${type}.json`);
  }

  async getEntity(userName: string, type: EntityType): Promise<EntityEnvelope | null> {
    return readJson<EntityEnvelope>(this.entityPath(userName, type));
  }

  async putEntity(userName: string, type: EntityType, data: any, clientHash?: string): Promise<PutResult> {
    const dir = this.entityDir(userName);
    await fs.promises.mkdir(dir, { recursive: true });

    const filePath = this.entityPath(userName, type);
    const existing = await readJson<EntityEnvelope>(filePath);

    // Conflict check: if client provides a hash expectation and it doesn't match server
    if (clientHash && existing && existing.hash !== clientHash) {
      return { ok: false, conflict: true, serverData: existing };
    }

    const hash = computeHash(data);
    const envelope: EntityEnvelope = {
      data,
      updatedAt: Date.now(),
      hash,
    };

    await writeAtomic(filePath, JSON.stringify(envelope, null, 2));
    return { ok: true, updatedAt: envelope.updatedAt, hash };
  }

  async deleteEntity(userName: string, type: EntityType): Promise<void> {
    try {
      await fs.promises.unlink(this.entityPath(userName, type));
    } catch {
      // File doesn't exist, that's fine
    }
  }

  async getManifest(userName: string): Promise<EntityManifest> {
    const dir = this.entityDir(userName);
    const manifest: EntityManifest = {};

    try {
      const entries = await fs.promises.readdir(dir);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const type = entry.replace('.json', '');
        if (!this.isValidType(type)) continue;

        const envelope = await readJson<EntityEnvelope>(path.join(dir, entry));
        if (envelope) {
          manifest[type] = { updatedAt: envelope.updatedAt, hash: envelope.hash };
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return manifest;
  }
}

export const entityStore = new EntityStore();
