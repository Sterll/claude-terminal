/**
 * Extension discovery against a real temporary HOME.
 *
 * The whole point of this service is that a bad extension cannot break anything
 * outside itself, and that is not something a mocked `fs` proves — the failures
 * worth catching (an unreadable file, a directory where a file should be, a
 * symlink loop) are filesystem behaviour. So these tests build actual
 * directories under a throwaway HOME, the way `tests/e2e/smoke.js` does.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VALID_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 3 7v10z"/></svg>';

let tmpHome;
let homedirSpy;
let service;

/** Write one extension directory under the temporary HOME. */
function writeExtension(dirName, manifest, translations) {
  const dir = path.join(tmpHome, '.claude-terminal', 'project-types', dirName);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(
      path.join(dir, 'project-type.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
      'utf8'
    );
  }
  if (translations) {
    const i18nDir = path.join(dir, 'i18n');
    fs.mkdirSync(i18nDir, { recursive: true });
    for (const [locale, strings] of Object.entries(translations)) {
      fs.writeFileSync(
        path.join(i18nDir, `${locale}.json`),
        typeof strings === 'string' ? strings : JSON.stringify(strings),
        'utf8'
      );
    }
  }
  return dir;
}

/** Write settings.json under the temporary HOME. */
function writeSettings(settings) {
  const dir = path.join(tmpHome, '.claude-terminal');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2),
    'utf8'
  );
}

const manifest = (over = {}) => ({
  manifest: 1,
  id: 'rust',
  name: 'Rust',
  description: 'Cargo-based Rust project',
  color: '#dea584',
  icon: VALID_ICON,
  detect: { files: ['Cargo.toml'] },
  ...over,
});

/** Turn both consent gates on for the given ids. */
const optIn = (...ids) => writeSettings({
  projectTypeExtensionsEnabled: true,
  enabledProjectTypeExtensions: ids,
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-ext-'));
  homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tmpHome);

  jest.resetModules();
  // ErrorLogService reaches for electron; the service only ever calls
  // logWarning on it, so a stub is enough and keeps the assertions about
  // *which* level is used honest.
  jest.doMock('../../src/main/services/ErrorLogService', () => ({
    logWarning: jest.fn(),
    logCritical: jest.fn(),
    logInfo: jest.fn(),
  }));
  service = require('../../src/main/services/ProjectTypeExtensionService');
});

afterEach(() => {
  homedirSpy.mockRestore();
  jest.dontMock('../../src/main/services/ErrorLogService');
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch { /* the retry helper in tests/setup.js handles the Windows case */ }
});

// ── The gate ─────────────────────────────────────────────────────────────────

describe('the setting is off by default', () => {
  it('reports disabled when there is no settings file at all', () => {
    expect(service.readGate()).toEqual({ enabled: false, allowed: [] });
  });

  it('reports disabled when settings.json exists but says nothing about it', async () => {
    writeSettings({ accentColor: '#d97706' });
    expect(service.readGate().enabled).toBe(false);

    writeExtension('rust', manifest());
    const result = await service.listExtensions({ appVersion: '1.3.2' });

    expect(result.enabled).toBe(false);
    // Discovered and listed — so the UI can offer a toggle — but not enabled.
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].status).toBe('disabled');
  });

  it('reports disabled when settings.json is corrupt', () => {
    writeSettings('{ not json');
    expect(service.readGate()).toEqual({ enabled: false, allowed: [] });
  });

  it('needs both gates: the master switch alone is not enough', async () => {
    writeSettings({ projectTypeExtensionsEnabled: true, enabledProjectTypeExtensions: [] });
    writeExtension('rust', manifest());

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.enabled).toBe(true);
    expect(result.extensions[0].status).toBe('disabled');
  });

  it('needs both gates: the per-extension allowlist alone is not enough', async () => {
    writeSettings({ projectTypeExtensionsEnabled: false, enabledProjectTypeExtensions: ['rust'] });
    writeExtension('rust', manifest());

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.enabled).toBe(false);
    expect(result.extensions[0].status).toBe('disabled');
  });

  it('ignores a non-array allowlist rather than trusting it', () => {
    writeSettings({ projectTypeExtensionsEnabled: true, enabledProjectTypeExtensions: 'rust' });
    expect(service.readGate()).toEqual({ enabled: true, allowed: [] });
  });
});

// ── Discovery ────────────────────────────────────────────────────────────────

describe('discovering a valid extension', () => {
  it('loads it, prefixes the id and reports no problems', async () => {
    optIn('rust');
    writeExtension('rust', manifest());

    const result = await service.listExtensions({ appVersion: '1.3.2' });

    expect(result.problems).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    const ext = result.extensions[0];
    expect(ext.id).toBe('rust');
    expect(ext.typeId).toBe('ext-rust');
    expect(ext.name).toBe('Rust');
    expect(ext.icon).toBe(VALID_ICON);
    expect(ext.detect.files).toEqual(['Cargo.toml']);
    expect(ext.status).toBe('enabled');
    expect(ext.dirName).toBe('rust');
  });

  it('reads its translations and keeps only name and description', async () => {
    optIn('rust');
    writeExtension('rust', manifest(), {
      fr: { name: 'Rust', description: 'Projet Rust basé sur Cargo', 'settings.title': 'pwned' },
      'zh-CN': { name: 'Rust', description: '基于 Cargo 的 Rust 项目' },
      de: { name: 'Rust' },
    });

    const [ext] = (await service.listExtensions({ appVersion: '1.3.2' })).extensions;

    expect(ext.translations.fr).toEqual({ name: 'Rust', description: 'Projet Rust basé sur Cargo' });
    expect(ext.translations['zh-CN'].description).toBe('基于 Cargo 的 Rust 项目');
    // Not a supported locale, so never read.
    expect(ext.translations.de).toBeUndefined();
  });

  it('loads an extension with no i18n directory at all', async () => {
    optIn('rust');
    writeExtension('rust', manifest());
    const [ext] = (await service.listExtensions({ appVersion: '1.3.2' })).extensions;
    expect(ext.translations).toEqual({});
  });

  it('survives a corrupt locale file without losing the extension', async () => {
    optIn('rust');
    writeExtension('rust', manifest(), { fr: '{ not json', en: { name: 'Rust' } });

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].translations.en).toEqual({ name: 'Rust' });
    expect(result.extensions[0].translations.fr).toBeUndefined();
  });

  it('ignores loose files beside the extension directories', async () => {
    optIn('rust');
    writeExtension('rust', manifest());
    fs.writeFileSync(path.join(tmpHome, '.claude-terminal', 'project-types', 'README.txt'), 'hi');

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions).toHaveLength(1);
    expect(result.problems).toEqual([]);
  });
});

// ── Failure isolation ────────────────────────────────────────────────────────

describe('a broken extension breaks only itself', () => {
  it('resolves normally when the extensions directory does not exist', async () => {
    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions).toEqual([]);
    // A missing directory is the normal case, not a problem to report.
    expect(result.problems).toEqual([]);
  });

  it('rejects a malformed manifest and keeps the good ones', async () => {
    optIn('rust', 'good', 'alsogood');
    writeExtension('rust', '{ "manifest": 1, "id": "rust"');       // truncated JSON
    writeExtension('good', manifest({ id: 'good', name: 'Good' }));
    writeExtension('alsogood', manifest({ id: 'alsogood', name: 'Also Good' }));

    const result = await service.listExtensions({ appVersion: '1.3.2' });

    expect(result.extensions.map((e) => e.id).sort()).toEqual(['alsogood', 'good']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ id: 'rust', reason: 'unreadable' });
  });

  it('reports a directory with no manifest', async () => {
    optIn('rust');
    writeExtension('empty', undefined);

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions).toEqual([]);
    expect(result.problems[0]).toMatchObject({ id: 'empty', reason: 'no-manifest' });
  });

  it('reports a manifest that is valid JSON but not an object', async () => {
    optIn('rust');
    writeExtension('weird', '"just a string"');

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.problems[0]).toMatchObject({ id: 'weird', reason: 'not-an-object' });
  });

  it('reports a manifest with a bad id or name', async () => {
    optIn('alpha', 'beta');
    writeExtension('alpha', manifest({ id: '../escape' }));
    writeExtension('beta', manifest({ id: 'beta', name: '<script>alert(1)</script>' }));

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    const reasons = Object.fromEntries(result.problems.map((p) => [p.id, p.reason]));
    expect(reasons).toEqual({ alpha: 'bad-id', beta: 'bad-name' });
    expect(result.extensions).toEqual([]);
  });

  it('refuses a manifest larger than the cap instead of reading it', async () => {
    optIn('huge');
    const padded = manifest({ id: 'huge' });
    padded._padding = 'x'.repeat(70 * 1024);
    writeExtension('huge', padded);

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions).toEqual([]);
    expect(result.problems[0]).toMatchObject({ id: 'huge', reason: 'unreadable' });
    expect(result.problems[0].detail).toMatch(/cap is/);
  });

  it('handles a directory where the manifest should be a file', async () => {
    optIn('weird');
    const dir = path.join(tmpHome, '.claude-terminal', 'project-types', 'weird', 'project-type.json');
    fs.mkdirSync(dir, { recursive: true });

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions).toEqual([]);
    expect(result.problems[0].id).toBe('weird');
  });

  it('rejects the second of two extensions claiming the same id', async () => {
    optIn('rust');
    writeExtension('rust-a', manifest());
    writeExtension('rust-b', manifest());

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions).toHaveLength(1);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].reason).toBe('duplicate-id');
  });

  it('logs failures as warnings, never as critical', async () => {
    const errorLog = require('../../src/main/services/ErrorLogService');
    optIn('rust');
    writeExtension('broken', '{{{');

    await service.listExtensions({ appVersion: '1.3.2' });

    expect(errorLog.logWarning).toHaveBeenCalled();
    expect(errorLog.logWarning.mock.calls[0][0]).toBe('project-types');
    // `critical` means "the app broke". A bad file in a folder the user manages
    // is not that, and inflating it would empty the word of meaning.
    expect(errorLog.logCritical).not.toHaveBeenCalled();
  });

  it('still returns a result when the error log itself throws', async () => {
    const errorLog = require('../../src/main/services/ErrorLogService');
    errorLog.logWarning.mockImplementation(() => { throw new Error('log is down'); });
    optIn('rust');
    writeExtension('broken', '{{{');

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.problems).toHaveLength(1);
  });
});

// ── Version compatibility ────────────────────────────────────────────────────

describe('version compatibility', () => {
  it('lists an extension built for a newer app as incompatible, and does not enable it', async () => {
    optIn('futuristic');
    writeExtension('futuristic', manifest({
      id: 'futuristic',
      name: 'Futuristic',
      engines: { claudeTerminal: '>=9.0.0' },
    }));

    const result = await service.listExtensions({ appVersion: '1.3.2' });

    // Surfaced rather than silently dropped: whoever wrote it needs to see why.
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].status).toBe('incompatible');
    expect(result.extensions[0].detail).toContain('>=9.0.0');
    expect(result.problems[0].reason).toBe('incompatible');
    // And crucially it carries no manifest content, so nothing downstream can
    // mistake it for something registerable.
    expect(result.extensions[0].typeId).toBeUndefined();
  });

  it('accepts an extension whose range the running version satisfies', async () => {
    optIn('rust');
    writeExtension('rust', manifest({ engines: { claudeTerminal: '^1.3.0' } }));

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions[0].status).toBe('enabled');
    expect(result.problems).toEqual([]);
  });

  it('treats an unparseable range as unsatisfiable rather than as a wildcard', async () => {
    optIn('rust');
    writeExtension('rust', manifest({ engines: { claudeTerminal: '>=1.0.0 <2.0.0' } }));

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions[0].status).toBe('incompatible');
  });

  it('defaults to compatible when the manifest says nothing', async () => {
    optIn('rust');
    writeExtension('rust', manifest({ engines: undefined }));

    const result = await service.listExtensions({ appVersion: '1.3.2' });
    expect(result.extensions[0].status).toBe('enabled');
    expect(result.extensions[0].engines.claudeTerminal).toBe('*');
  });
});

// ── Directory helper ─────────────────────────────────────────────────────────

describe('ensureExtensionsDir', () => {
  it('creates the directory and reports it', async () => {
    const result = await service.ensureExtensionsDir();
    expect(result.created).toBe(true);
    expect(fs.existsSync(result.dir)).toBe(true);
    expect(result.dir).toBe(service.extensionsDir());
  });

  it('is idempotent', async () => {
    await service.ensureExtensionsDir();
    const second = await service.ensureExtensionsDir();
    expect(second.created).toBe(false);
    expect(second.error).toBeUndefined();
  });
});
