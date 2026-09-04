/**
 * Artifact store test suite.
 *
 * Runs against a real temporary data directory rather than a mocked fs: the
 * store's contract is about what survives on disk (idempotence, version
 * numbering, blob round-trip, pruning), and a mocked fs would verify the mock
 * instead of the behaviour.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-artifacts-'));
  // The store resolves its directory once at require time.
  process.env.CT_DATA_DIR = tmpDir;
  jest.resetModules();
  store = require('../../src/shared/artifact-store');
});

afterEach(() => {
  delete process.env.CT_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const html = (body) => `<html><title>Dashboard</title><body>${body}</body></html>`;

describe('saveArtifact', () => {
  it('writes the source to a blob and indexes its metadata', async () => {
    const { artifact, created } = await store.saveArtifact({
      projectId: 'p1', projectName: 'Proj', kind: 'html', title: 'Dashboard', source: html('v1'),
    });

    expect(created).toBe(true);
    expect(artifact).toMatchObject({ kind: 'html', title: 'Dashboard', version: 1, lines: 1 });

    const blob = path.join(tmpDir, 'artifacts', 'blobs', artifact.blob);
    expect(fs.readFileSync(blob, 'utf8')).toBe(html('v1'));
  });

  it('is idempotent: saving identical content twice creates one entry', async () => {
    const first = await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Dashboard', source: html('v1') });
    const second = await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Dashboard', source: html('v1') });

    expect(second.created).toBe(false);
    expect(second.artifact.id).toBe(first.artifact.id);
    expect((await store.listArtifacts({})).total).toBe(1);
  });

  it('numbers a rewrite of the same title as the next version of one artifact', async () => {
    const v1 = await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Dashboard', source: html('v1') });
    const v2 = await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Dashboard', source: html('v2') });

    expect(v2.artifact.version).toBe(2);
    expect(v2.artifact.groupKey).toBe(v1.artifact.groupKey);
  });

  it('keeps the same title in different projects apart', async () => {
    const a = await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Dashboard', source: html('a') });
    const b = await store.saveArtifact({ projectId: 'p2', kind: 'html', title: 'Dashboard', source: html('b') });

    expect(b.artifact.groupKey).not.toBe(a.artifact.groupKey);
    expect(b.artifact.version).toBe(1);
  });

  it('refuses a blob past the size cap instead of filling the store', async () => {
    const huge = 'x'.repeat(store.MAX_BLOB_BYTES + 1);
    const result = await store.saveArtifact({ projectId: 'p1', kind: 'code', title: 'huge.js', source: huge });

    expect(result).toMatchObject({ created: false, skipped: 'too-large' });
    expect((await store.listArtifacts({})).total).toBe(0);
  });

  it('refuses an empty artifact', async () => {
    const result = await store.saveArtifact({ projectId: 'p1', kind: 'code', title: 'empty', source: '   ' });

    expect(result).toMatchObject({ created: false, skipped: 'empty' });
  });
});

describe('published artifacts', () => {
  it('persists the URL, description and favicon a publish carries', async () => {
    const { artifact } = await store.saveArtifact({
      projectId: 'p1',
      kind: 'published',
      lang: 'markdown',
      title: 'audit.md',
      source: '# Audit',
      url: 'https://claude.ai/public/artifacts/abc',
      description: 'Findings from the Q3 audit',
      favicon: '🔍',
      path: '/tmp/audit.md',
    });

    expect(artifact).toMatchObject({
      kind: 'published',
      url: 'https://claude.ai/public/artifacts/abc',
      description: 'Findings from the Q3 audit',
      favicon: '🔍',
      path: '/tmp/audit.md',
    });
    // Markdown publishes keep a .md blob so the folder stays browsable.
    expect(artifact.blob.endsWith('.md')).toBe(true);
  });

  it('omits the published-only fields entirely for other kinds', async () => {
    const { artifact } = await store.saveArtifact({
      projectId: 'p1', kind: 'code', lang: 'js', title: 'a.js', source: 'const a = 1;',
    });

    expect(artifact).not.toHaveProperty('url');
    expect(artifact).not.toHaveProperty('favicon');
    expect(artifact).not.toHaveProperty('description');
  });

  it('carries them through a batch too', async () => {
    const { created } = await store.saveMany([
      { projectId: 'p1', kind: 'published', lang: 'html', title: 'p.html', source: '<p>a</p>', url: 'https://claude.ai/a', favicon: '📊' },
    ]);

    expect(created[0]).toMatchObject({ url: 'https://claude.ai/a', favicon: '📊' });
    expect(created[0].blob.endsWith('.html')).toBe(true);
  });
});

describe('saveMany', () => {
  it('numbers versions correctly when they arrive in one batch', async () => {
    const { created } = await store.saveMany([
      { projectId: 'p1', kind: 'html', title: 'Page', source: html('1') },
      { projectId: 'p1', kind: 'html', title: 'Page', source: html('2') },
      { projectId: 'p1', kind: 'html', title: 'Page', source: html('3') },
    ]);

    expect(created.map(a => a.version)).toEqual([1, 2, 3]);
  });

  it('skips duplicates inside the batch and against what is already stored', async () => {
    await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Page', source: html('1') });

    const { created, skipped } = await store.saveMany([
      { projectId: 'p1', kind: 'html', title: 'Page', source: html('1') }, // already on disk
      { projectId: 'p1', kind: 'html', title: 'Page', source: html('2') },
      { projectId: 'p1', kind: 'html', title: 'Page', source: html('2') }, // dup within batch
    ]);

    expect(created).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it('continues past an oversized entry rather than failing the batch', async () => {
    const { created, skipped } = await store.saveMany([
      { projectId: 'p1', kind: 'code', title: 'huge.js', source: 'x'.repeat(store.MAX_BLOB_BYTES + 1) },
      { projectId: 'p1', kind: 'code', title: 'ok.js', source: 'const a = 1;' },
    ]);

    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('ok.js');
    expect(skipped).toBe(1);
  });

  it('does nothing on an empty batch', async () => {
    await expect(store.saveMany([])).resolves.toEqual({ created: [], skipped: 0 });
  });
});

describe('listArtifacts', () => {
  beforeEach(async () => {
    await store.saveMany([
      { projectId: 'p1', projectName: 'Alpha', kind: 'html', title: 'Page', source: html('1') },
      { projectId: 'p1', projectName: 'Alpha', kind: 'html', title: 'Page', source: html('2') },
      { projectId: 'p2', projectName: 'Beta', kind: 'code', lang: 'python', title: 'parser.py', source: 'a = 1' },
    ]);
  });

  it('filters by project and by kind', async () => {
    expect((await store.listArtifacts({ projectId: 'p2' })).total).toBe(1);
    expect((await store.listArtifacts({ kind: 'html' })).total).toBe(2);
  });

  it('matches a query against title, language and project name', async () => {
    expect((await store.listArtifacts({ query: 'parser' })).total).toBe(1);
    expect((await store.listArtifacts({ query: 'python' })).total).toBe(1);
    expect((await store.listArtifacts({ query: 'alpha' })).total).toBe(2);
  });

  it('collapses version chains to their newest member with latestOnly', async () => {
    const { artifacts } = await store.listArtifacts({ latestOnly: true });

    expect(artifacts).toHaveLength(2);
    const page = artifacts.find(a => a.title === 'Page');
    expect(page.version).toBe(2);
  });

  it('reports the total independently of the page returned', async () => {
    const { artifacts, total } = await store.listArtifacts({ limit: 1 });

    expect(artifacts).toHaveLength(1);
    expect(total).toBe(3);
  });
});

describe('getArtifact', () => {
  it('returns metadata plus the stored source', async () => {
    const { artifact } = await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Page', source: html('body') });

    await expect(store.getArtifact(artifact.id)).resolves.toMatchObject({
      id: artifact.id,
      source: html('body'),
    });
  });

  it('returns null for an unknown id', async () => {
    await expect(store.getArtifact('art-nope')).resolves.toBeNull();
  });

  it('still returns metadata when the blob went missing, so the entry can be cleaned up', async () => {
    const { artifact } = await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Page', source: html('x') });
    fs.unlinkSync(path.join(tmpDir, 'artifacts', 'blobs', artifact.blob));
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const found = await store.getArtifact(artifact.id);

    expect(found.id).toBe(artifact.id);
    expect(found.source).toBe('');
    console.warn.mockRestore();
  });
});

describe('delete', () => {
  it('removes the entry and its blob', async () => {
    const { artifact } = await store.saveArtifact({ projectId: 'p1', kind: 'html', title: 'Page', source: html('x') });

    await expect(store.deleteArtifact(artifact.id)).resolves.toBe(true);
    expect((await store.listArtifacts({})).total).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'artifacts', 'blobs', artifact.blob))).toBe(false);
  });

  it('reports false for an id that is already gone', async () => {
    await expect(store.deleteArtifact('art-nope')).resolves.toBe(false);
  });

  it('deletes by filter', async () => {
    await store.saveMany([
      { projectId: 'p1', kind: 'html', title: 'A', source: html('a') },
      { projectId: 'p1', kind: 'code', title: 'B', source: 'b' },
      { projectId: 'p2', kind: 'html', title: 'C', source: html('c') },
    ]);

    await expect(store.deleteWhere({ projectId: 'p1' })).resolves.toBe(2);
    expect((await store.listArtifacts({})).total).toBe(1);
  });

  it('refuses an unfiltered mass delete', async () => {
    await expect(store.deleteWhere({})).rejects.toThrow(/at least one filter/);
  });
});

describe('getStats', () => {
  it('counts by kind, sums bytes and counts distinct projects', async () => {
    await store.saveMany([
      { projectId: 'p1', kind: 'html', title: 'A', source: 'ab' },
      { projectId: 'p2', kind: 'code', title: 'B', source: 'cde' },
    ]);

    await expect(store.getStats()).resolves.toMatchObject({
      total: 2,
      bytes: 5,
      projects: 2,
      byKind: { html: 1, code: 1, svg: 0, mermaid: 0, file: 0 },
    });
  });
});

describe('resilience', () => {
  it('starts empty rather than throwing when index.json is corrupt', async () => {
    const indexFile = path.join(tmpDir, 'artifacts', 'index.json');
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    fs.writeFileSync(indexFile, '{ not json', 'utf8');
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(store.listArtifacts({})).resolves.toEqual({ artifacts: [], total: 0 });

    console.error.mockRestore();
  });

  it('serializes concurrent writes instead of losing updates', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.saveArtifact({ projectId: 'p1', kind: 'code', title: `f${i}.js`, source: `const a = ${i};` })
      )
    );

    expect((await store.listArtifacts({})).total).toBe(8);
  });
});
