/** @jest-environment node */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let mockDir;
const mockVault = new Map();
jest.mock('keytar', () => ({
  getPassword: jest.fn(async (service, account) => mockVault.get(service + account) || null),
  setPassword: jest.fn(async (service, account, value) => { mockVault.set(service + account, value); })
}));
jest.mock('../../src/main/utils/paths', () => ({ get dataDir() { return mockDir; } }));
const backups = require('../../src/main/utils/secretBackups');
beforeEach(() => { mockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-secret-upgrade-')); mockVault.clear(); });
afterEach(() => fs.rmSync(mockDir, { force: true, recursive: true }));
test('encrypts old credentials before redacting backups and can recover the exact original', async () => {
  const file = path.join(mockDir, 'databases.json.bak');
  const original = JSON.stringify([{ id: 'mongo', type: 'mongodb', connectionString: 'mongodb://alice:old%40pass@host1,host2/db?replicaSet=rs', label: 'keep' }]);
  fs.writeFileSync(file, original);
  expect(await backups.secureFile(file, 'databases')).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))[0]).toMatchObject({ id: 'mongo', username: 'alice', connectionString: 'mongodb://host1,host2/db?replicaSet=rs', label: 'keep' });
  const archives = fs.readdirSync(backups.directory()).filter(name => name.endsWith('.ctbackup'));
  expect(archives).toHaveLength(1);
  const archive = path.join(backups.directory(), archives[0]);
  expect(fs.readFileSync(archive, 'utf8')).not.toContain('old%40pass');
  expect(await backups.readArchive(archive)).toEqual({ file, original });
  expect(await backups.secureFile(file, 'databases')).toBe(false);
  const envelope = JSON.parse(fs.readFileSync(archive, 'utf8')); envelope.data = Buffer.alloc(32).toString('base64');
  fs.writeFileSync(archive, JSON.stringify(envelope));
  await expect(backups.readArchive(archive)).rejects.toThrow();
});
test('vault failures preserve the plaintext file and never substitute a weak key', async () => {
  const file = path.join(mockDir, 'databases.json.bak'), original = '[{"id":"db","password":"only-copy"}]';
  fs.writeFileSync(file, original);
  require('keytar').setPassword.mockRejectedValueOnce(new Error('Keychain locked'));
  await expect(backups.secureFile(file, 'databases')).rejects.toThrow('Keychain locked');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
});
test('migration isolates malformed backups, scopes managed MCP secrets and preserves other settings', async () => {
  const home = path.join(mockDir, 'home'); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json.bak'), '{broken');
  const file = path.join(home, '.claude', 'settings.pre-hooks.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: ['keep'] }, mcpServers: {
    'claude-terminal': { env: { CT_DB_PASS_id: 'remove', CT_DATA_DIR: '/keep' } }, other: { env: { CT_DB_PASS_id: 'not-ours' } }
  } }));
  const report = await backups.migrate(home, mockDir);
  expect(report.secured).toBe(1); expect(report.errors).toHaveLength(1);
  expect(fs.readFileSync(path.join(home, '.claude.json.bak'), 'utf8')).toBe('{broken');
  const sanitized = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(sanitized.hooks.Stop).toEqual(['keep']);
  expect(sanitized.mcpServers['claude-terminal'].env).toEqual({ CT_DATA_DIR: '/keep' });
  expect(sanitized.mcpServers.other.env.CT_DB_PASS_id).toBe('not-ours');
});
