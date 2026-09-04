// ModelCatalogService — the tiering, caching and degradation rules behind the
// chat model picker.
//
// Strategy: mock `fs` so the disk cache lives in a Map instead of the real
// ~/.claude-terminal, and drive the class export (not the module singleton) so
// each test starts from a clean instance.

const mockVirtualFs = new Map();

jest.mock('fs', () => {
  const realFs = jest.requireActual('fs');
  return {
    ...realFs,
    readFileSync: jest.fn((p, enc) => {
      const key = String(p);
      if (!mockVirtualFs.has(key)) {
        const err = new Error(`ENOENT: no such file or directory, open '${key}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return mockVirtualFs.get(key);
    }),
    writeFileSync: jest.fn((p, data) => { mockVirtualFs.set(String(p), data); }),
    renameSync: jest.fn((from, to) => {
      mockVirtualFs.set(String(to), mockVirtualFs.get(String(from)));
      mockVirtualFs.delete(String(from));
    }),
    existsSync: jest.fn((p) => mockVirtualFs.has(String(p))),
    mkdirSync: jest.fn(),
  };
});

const {
  ModelCatalogService,
  CACHE_FILE,
  TTL_MS,
} = require('../../src/main/services/ModelCatalogService');
const { LEGACY_MODELS } = require('../../src/shared/model-options');

const CLI_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
];

// The service rewrites labels and descriptions on the way out (see
// normalizeModelRow), so assertions compare model identity rather than the
// whole row — otherwise every label tweak breaks unrelated cache tests.
const CLI_VALUES = ['default', 'claude-fable-5-1[1m]', 'sonnet'];

function makeService() {
  const svc = new ModelCatalogService();
  svc._reset();
  return svc;
}

beforeEach(() => {
  mockVirtualFs.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

describe('fetching', () => {
  test('builds both tiers from the CLI payload', async () => {
    const svc = makeService();
    svc.setFetcher(async () => ({
      models: CLI_MODELS,
    }));

    const catalog = await svc.getCatalog();

    expect(catalog.source).toBe('cli');
    expect(catalog.primary.map(m => m.value)).toEqual(CLI_VALUES);
    expect(catalog.stale).toBe(false);
  });

  test('keeps a superseded model in the legacy tier', async () => {
    const svc = makeService();
    svc.setFetcher(async () => ({ models: CLI_MODELS }));

    const catalog = await svc.getCatalog();

    // Fable 5.1 replacing Fable 5 in the CLI menu does not make Fable 5 the
    // same model — it becomes legacy, and "More models" is where it belongs.
    expect(catalog.legacy.find(m => m.value === 'claude-fable-5')).toBeDefined();
    expect(catalog.legacy.find(m => m.value === 'claude-opus-4-7')).toBeDefined();
  });

  test('drops a legacy model the CLI is still serving', async () => {
    const svc = makeService();
    // An older CLI that still advertises Fable 5 as current.
    svc.setFetcher(async () => ({
      models: [{ value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable' }],
    }));

    const catalog = await svc.getCatalog();

    // Listing it in both tiers would read as two separate models.
    expect(catalog.legacy.find(m => m.value === 'claude-fable-5')).toBeUndefined();
  });

  test('collapses concurrent callers onto a single spawn', async () => {
    const svc = makeService();
    const fetcher = jest.fn(async () => ({ models: CLI_MODELS }));
    svc.setFetcher(fetcher);

    await Promise.all([svc.getCatalog(), svc.getCatalog(), svc.getCatalog()]);

    // Several tabs opening their picker at once must not each start a CLI.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('serves a fresh cache without re-fetching', async () => {
    const svc = makeService();
    const fetcher = jest.fn(async () => ({ models: CLI_MODELS }));
    svc.setFetcher(fetcher);

    await svc.getCatalog();
    await svc.getCatalog();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('refresh: true bypasses a fresh cache', async () => {
    const svc = makeService();
    const fetcher = jest.fn(async () => ({ models: CLI_MODELS }));
    svc.setFetcher(fetcher);

    await svc.getCatalog();
    await svc.getCatalog({ refresh: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('degradation', () => {
  test('falls back to the static tier when the CLI fails and nothing is cached', async () => {
    const svc = makeService();
    svc.setFetcher(async () => { throw new Error('spawn ENOENT'); });

    const catalog = await svc.getCatalog();

    expect(catalog.source).toBe('fallback');
    expect(catalog.primary.length).toBeGreaterThan(0);
    expect(catalog.legacy.length).toBeGreaterThan(0);
  });

  test('an empty model list counts as a failure, not an empty menu', async () => {
    const svc = makeService();
    svc.setFetcher(async () => ({ models: [] }));

    expect((await svc.getCatalog()).source).toBe('fallback');
  });

  test('keeps a stale cache rather than downgrading to the fallback', async () => {
    const svc = makeService();
    let fail = false;
    svc.setFetcher(async () => {
      if (fail) throw new Error('CLI gone');
      return { models: CLI_MODELS };
    });

    await svc.getCatalog();
    // Age the cache past its TTL so the next call re-fetches.
    svc._cache.fetchedAt = Date.now() - (TTL_MS + 1000);
    fail = true;

    const catalog = await svc.getCatalog();

    // Stale-but-real beats a static list that never knew this account.
    expect(catalog.source).toBe('cache');
    expect(catalog.primary.map(m => m.value)).toEqual(CLI_VALUES);
    expect(catalog.stale).toBe(true);
  });

  test('falls back when no fetcher has been injected', async () => {
    const svc = makeService();
    expect((await svc.getCatalog()).source).toBe('fallback');
  });
});

describe('ingestInitResult', () => {
  test('fills the catalog from a live session, no fetch needed', async () => {
    const svc = makeService();
    const fetcher = jest.fn();
    svc.setFetcher(fetcher);

    svc.ingestInitResult({ models: CLI_MODELS });
    const catalog = await svc.getCatalog();

    expect(fetcher).not.toHaveBeenCalled();
    expect(catalog.primary.map(m => m.value)).toEqual(CLI_VALUES);
  });

  test('ignores an empty payload instead of blanking a good cache', async () => {
    const svc = makeService();
    svc.ingestInitResult({ models: CLI_MODELS });

    svc.ingestInitResult({ models: [] });
    svc.ingestInitResult(null);
    svc.ingestInitResult({});

    expect((await svc.getCatalog()).primary.map(m => m.value)).toEqual(CLI_VALUES);
  });
});

describe('disk cache', () => {
  test('persists atomically via a temp file', async () => {
    const fs = require('fs');
    const svc = makeService();
    svc.setFetcher(async () => ({ models: CLI_MODELS }));

    await svc.getCatalog();

    // temp + rename: a half-written catalog would be parsed as corrupt later.
    expect(fs.writeFileSync).toHaveBeenCalledWith(`${CACHE_FILE}.tmp`, expect.any(String), 'utf8');
    expect(fs.renameSync).toHaveBeenCalledWith(`${CACHE_FILE}.tmp`, CACHE_FILE);
    expect(mockVirtualFs.has(CACHE_FILE)).toBe(true);
  });

  test('restores from disk so a cold launch skips the fallback', async () => {
    mockVirtualFs.set(CACHE_FILE, JSON.stringify({
      primary: CLI_MODELS,
      fetchedAt: Date.now(),
    }));

    const svc = makeService();
    const fetcher = jest.fn();
    svc.setFetcher(fetcher);

    const catalog = await svc.getCatalog();

    expect(fetcher).not.toHaveBeenCalled();
    expect(catalog.source).toBe('cache');
    expect(catalog.primary.map(m => m.value)).toEqual(CLI_VALUES);
  });

  test('treats a corrupt cache as absent', async () => {
    mockVirtualFs.set(CACHE_FILE, '{ not json');

    const svc = makeService();
    svc.setFetcher(async () => { throw new Error('offline'); });

    expect((await svc.getCatalog()).source).toBe('fallback');
  });

  test('ignores a cache missing its timestamp', async () => {
    mockVirtualFs.set(CACHE_FILE, JSON.stringify({ primary: CLI_MODELS }));

    const svc = makeService();
    svc.setFetcher(async () => { throw new Error('offline'); });

    expect((await svc.getCatalog()).source).toBe('fallback');
  });

  test('a write failure does not fail the call', async () => {
    const fs = require('fs');
    fs.writeFileSync.mockImplementationOnce(() => { throw new Error('EACCES'); });

    const svc = makeService();
    svc.setFetcher(async () => ({ models: CLI_MODELS }));

    const catalog = await svc.getCatalog();

    expect(catalog.source).toBe('cli');
    expect(catalog.primary.map(m => m.value)).toEqual(CLI_VALUES);
  });
});

describe('shape', () => {
  test('always exposes what the picker renders', async () => {
    const svc = makeService();
    svc.setFetcher(async () => ({ models: CLI_MODELS }));

    const catalog = await svc.getCatalog();

    expect(Array.isArray(catalog.primary)).toBe(true);
    expect(Array.isArray(catalog.legacy)).toBe(true);
    expect(['cli', 'cache', 'fallback']).toContain(catalog.source);
  });

  test('serves normalized rows, so no consumer has to strip prices itself', async () => {
    const svc = makeService();
    svc.setFetcher(async () => ({
      models: [{
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet',
        description: 'Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok',
      }],
    }));

    const [row] = (await svc.getCatalog()).primary;

    expect(row.displayName).toBe('Sonnet 5');
    expect(row.description).toBe('Efficient for routine tasks');
  });

  test('normalizes a cache written before the rules existed', async () => {
    // Normalization runs on read, so a catalog persisted by an older build
    // still renders correctly without a cache bust.
    mockVirtualFs.set(CACHE_FILE, JSON.stringify({
      primary: [{ value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest · $1/$5 per Mtok' }],
      fetchedAt: Date.now(),
    }));

    const svc = makeService();
    const [row] = (await svc.getCatalog()).primary;

    expect(row.displayName).toBe('Haiku 4.5');
    expect(row.description).toBe('Fastest');
  });

  test('the fallback still carries a usable legacy tier', async () => {
    const svc = makeService();
    const catalog = await svc.getCatalog();

    expect(catalog.legacy.length).toBeGreaterThan(0);
    expect(catalog.legacy.length).toBeLessThanOrEqual(LEGACY_MODELS.length);
    expect(catalog.fetchedAt).toBeNull();
  });
});
