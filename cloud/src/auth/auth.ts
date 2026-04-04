import crypto from 'crypto';
import { store } from '../store/store';

const API_KEY_PREFIX = 'ctc_';
const API_KEY_LENGTH = 32;

// In-memory index: SHA256(apiKey) -> userName for O(1) lookup
let _keyIndex: Map<string, string> | null = null;

export function generateApiKey(): string {
  const random = crypto.randomBytes(API_KEY_LENGTH).toString('hex');
  return `${API_KEY_PREFIX}${random}`;
}

export function isValidApiKeyFormat(key: string): boolean {
  return typeof key === 'string' && key.startsWith(API_KEY_PREFIX) && key.length === API_KEY_PREFIX.length + API_KEY_LENGTH * 2;
}

export function generateRoomSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/** Build the in-memory hash->userName index from all users. Also migrates plaintext keys to hashed. */
export async function buildKeyIndex(): Promise<void> {
  const index = new Map<string, string>();
  const users = await store.listUsers();
  for (const userName of users) {
    const user = await store.getUser(userName);
    if (!user) continue;

    if (user.apiKeyHash) {
      index.set(user.apiKeyHash, user.name);
    } else if (user.apiKey) {
      // Migrate: hash the plaintext key, store hash, remove plaintext
      const hash = hashApiKey(user.apiKey);
      user.apiKeyHash = hash;
      delete (user as any).apiKey;
      await store.saveUser(userName, user);
      index.set(hash, user.name);
      console.log(`[Auth] Migrated API key to hash for user "${userName}"`);
    }
  }
  _keyIndex = index;
  console.log(`[Auth] Key index built: ${index.size} user(s)`);
}

/** Invalidate cache so next auth call rebuilds it */
export function invalidateKeyIndex(): void {
  _keyIndex = null;
}

export async function authenticateApiKey(key: string): Promise<string | null> {
  if (!isValidApiKeyFormat(key)) return null;

  // Lazy-build index on first call
  if (!_keyIndex) await buildKeyIndex();

  const hash = hashApiKey(key);
  return _keyIndex!.get(hash) || null;
}
