// PluginService.installPlugin — what happens to installed_plugins.json when it
// cannot be parsed.
//
// That manifest is the only record of every plugin the user has installed.
// Falling back to { plugins: {} } and writing it back uninstalls all of them as
// far as the CLI is concerned, for the sake of installing one. Reading it also
// has to happen before the install directory is wiped and recopied, so a bad
// manifest leaves nothing half-written behind.

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-plugins-'));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => mockHome,
}));

const pluginService = require('../../src/main/services/PluginService');

const pluginsDir = path.join(mockHome, '.claude', 'plugins');
const installedFile = path.join(pluginsDir, 'installed_plugins.json');
const marketplacesFile = path.join(pluginsDir, 'known_marketplaces.json');
const mpLocation = path.join(pluginsDir, 'marketplaces', 'acme');
const installPath = path.join(pluginsDir, 'cache', 'widget@acme');

function seedMarketplace() {
  fs.mkdirSync(path.join(mpLocation, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(mpLocation, 'plugins', 'widget'), { recursive: true });
  fs.writeFileSync(
    path.join(mpLocation, 'plugins', 'widget', 'plugin.json'),
    JSON.stringify({ name: 'widget' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(mpLocation, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ plugins: [{ name: 'widget', version: '1.0.0' }] }),
    'utf8'
  );
  fs.writeFileSync(
    marketplacesFile,
    JSON.stringify({ acme: { installLocation: mpLocation } }),
    'utf8'
  );
}

beforeEach(() => {
  fs.rmSync(pluginsDir, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  seedMarketplace();
});

afterAll(() => {
  fs.rmSync(mockHome, { recursive: true, force: true });
});

describe('installPlugin', () => {
  test('refuses to install over an unparseable manifest, and leaves it alone', async () => {
    fs.writeFileSync(installedFile, '{not valid json!!!', 'utf8');

    const result = await pluginService.installPlugin('acme', 'widget');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/installed_plugins\.json/);
    expect(fs.readFileSync(installedFile, 'utf8')).toBe('{not valid json!!!');
  });

  test('does not copy any files when the manifest is unreadable', async () => {
    fs.writeFileSync(installedFile, '{not valid json!!!', 'utf8');

    await pluginService.installPlugin('acme', 'widget');

    expect(fs.existsSync(installPath)).toBe(false);
  });

  test('keeps the other installed plugins on a successful install', async () => {
    fs.writeFileSync(installedFile, JSON.stringify({
      plugins: {
        'other@acme': [{ installPath: '/somewhere', version: '2.0.0', scope: 'user', marketplace: 'acme' }],
      },
    }), 'utf8');

    const result = await pluginService.installPlugin('acme', 'widget');

    expect(result.success).toBe(true);
    const installed = JSON.parse(fs.readFileSync(installedFile, 'utf8'));
    expect(installed.plugins['other@acme'][0].version).toBe('2.0.0');
    expect(installed.plugins['widget@acme']).toBeDefined();
  });

  test('creates the manifest when there is none', async () => {
    const result = await pluginService.installPlugin('acme', 'widget');

    expect(result.success).toBe(true);
    const installed = JSON.parse(fs.readFileSync(installedFile, 'utf8'));
    expect(installed.plugins['widget@acme'][0].version).toBe('1.0.0');
  });
});

describe('addMarketplace', () => {
  // The `!marketplaces[name]` guard exists to make this idempotent, but it is
  // always true on an empty object - so falling back to {} on a parse failure
  // rewrote known_marketplaces.json with the new entry alone.
  test('refuses to run against an unreadable known_marketplaces.json', async () => {
    fs.writeFileSync(marketplacesFile, '{not valid json!!!', 'utf8');

    const result = await pluginService.addMarketplace('https://example.com/other.git');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/known_marketplaces\.json/);
    expect(fs.readFileSync(marketplacesFile, 'utf8')).toBe('{not valid json!!!');
  });

  test('keeps the marketplaces already registered', async () => {
    // 'acme' is seeded by seedMarketplace(); adding it again must be a no-op
    // that leaves the file intact rather than a rewrite.
    const before = fs.readFileSync(marketplacesFile, 'utf8');

    await pluginService.addMarketplace('https://example.com/acme.git');

    const after = JSON.parse(fs.readFileSync(marketplacesFile, 'utf8'));
    expect(after.acme).toBeDefined();
    expect(JSON.parse(before).acme.installLocation).toBe(after.acme.installLocation);
  });
});
