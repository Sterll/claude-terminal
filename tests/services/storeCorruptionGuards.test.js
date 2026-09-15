// The load -> mutate -> save contract, for the three stores that share it.
//
// All of them used to answer a parse failure with an empty collection, and all
// of them write the whole collection back on the next edit. So one unreadable
// byte in the index turned the next install, the next document or the next link
// into a wipe of everything that came before it. The payloads survive on disk
// in each case - skill directories, .md documents - but nothing lists them any
// more, which from the user's chair is the same thing.

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-stores-'));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => mockHome,
}));

const MarketplaceService = require('../../src/main/services/MarketplaceService');
const WorkspaceService = require('../../src/main/services/WorkspaceService');

const dataDir = path.join(mockHome, '.claude-terminal');
const manifestFile = path.join(dataDir, 'marketplace.json');

beforeEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(mockHome, { recursive: true, force: true });
});

// ── MarketplaceService: ~/.claude-terminal/marketplace.json ──────────────────

describe('marketplace manifest', () => {
  test('an unreadable manifest is refused, not replaced', () => {
    fs.writeFileSync(manifestFile, '{not valid json!!!', 'utf8');

    expect(() => MarketplaceService.getInstalled()).toThrow(/unparseable/i);
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe('{not valid json!!!');
  });

  test('a manifest that is not an object is refused too', () => {
    fs.writeFileSync(manifestFile, '["nope"]', 'utf8');

    expect(() => MarketplaceService.getInstalled()).toThrow(/not a JSON object/i);
  });

  test('an absent manifest is still an empty install list', () => {
    expect(MarketplaceService.getInstalled()).toEqual([]);
  });

  test('uninstalling cannot run against an unreadable manifest', () => {
    fs.writeFileSync(manifestFile, '{not valid json!!!', 'utf8');

    expect(() => MarketplaceService.uninstallSkill('some-skill')).toThrow(/unparseable/i);
    expect(fs.readFileSync(manifestFile, 'utf8')).toBe('{not valid json!!!');
  });
});

// ── WorkspaceService: <workspace>/docs-index.json and links.json ─────────────

describe('workspace indices', () => {
  const workspaceId = 'ws-1';
  const workspaceDir = path.join(dataDir, 'workspaces', workspaceId);

  function seedWorkspace() {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }

  test('an unreadable docs index is refused, not replaced', async () => {
    seedWorkspace();
    const indexPath = path.join(workspaceDir, 'docs-index.json');
    fs.writeFileSync(indexPath, '{not valid json!!!', 'utf8');

    await expect(
      WorkspaceService.writeDoc(workspaceId, 'New doc', '# hi')
    ).rejects.toThrow(/unparseable/i);

    expect(fs.readFileSync(indexPath, 'utf8')).toBe('{not valid json!!!');
  });

  test('an unreadable links index is refused, not replaced', async () => {
    seedWorkspace();
    const linksPath = path.join(workspaceDir, 'links.json');
    fs.writeFileSync(linksPath, '{not valid json!!!', 'utf8');

    await expect(
      WorkspaceService.addLink(workspaceId, {
        sourceType: 'project', sourceId: 'a',
        targetType: 'project', targetId: 'b',
        label: 'depends-on',
      })
    ).rejects.toThrow(/unparseable/i);

    expect(fs.readFileSync(linksPath, 'utf8')).toBe('{not valid json!!!');
  });

  test('absent indices still mean "nothing yet"', async () => {
    seedWorkspace();

    await expect(WorkspaceService.getWorkspaceDocsIndex(workspaceId)).resolves.toEqual([]);
    await expect(WorkspaceService.getWorkspaceLinks(workspaceId)).resolves.toEqual([]);
  });

  test('a readable index survives a write', async () => {
    seedWorkspace();
    await WorkspaceService.writeDoc(workspaceId, 'First', 'one');
    await WorkspaceService.writeDoc(workspaceId, 'Second', 'two');

    const docs = await WorkspaceService.getWorkspaceDocsIndex(workspaceId);
    expect(docs.map(d => d.title).sort()).toEqual(['First', 'Second']);
  });
});
