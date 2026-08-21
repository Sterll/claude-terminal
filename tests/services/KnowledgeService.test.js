/**
 * KnowledgeService — global knowledge base + CLAUDE.md injection.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpRoot;
let dataDir;
let claudeDir;

jest.mock('../../src/main/utils/paths', () => {
  const fsMock = require('fs');
  const osMock = require('os');
  const pathMock = require('path');
  const root = fsMock.mkdtempSync(pathMock.join(osMock.tmpdir(), 'ct-knowledge-'));
  return {
    dataDir: pathMock.join(root, 'data'),
    claudeDir: pathMock.join(root, 'claude'),
    _root: root
  };
});

const paths = require('../../src/main/utils/paths');
const KnowledgeService = require('../../src/main/services/KnowledgeService');

beforeAll(() => {
  tmpRoot = paths._root;
  dataDir = paths.dataDir;
  claudeDir = paths.claudeDir;
  fs.mkdirSync(claudeDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(dataDir, 'knowledge'), { recursive: true, force: true });
  fs.rmSync(path.join(claudeDir, 'CLAUDE.md'), { force: true });
});

const claudeMd = () => {
  try {
    return fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf8');
  } catch {
    return '';
  }
};

describe('entries', () => {
  test('creates an entry and reads it back', async () => {
    await KnowledgeService.writeEntry({
      title: 'Dédié OVH',
      content: '# Serveur\nIP 1.2.3.4',
      summary: 'Machine de prod',
      category: 'server',
      aliases: 'le dédié, prod',
      tags: ['infra']
    });

    const { entries } = await KnowledgeService.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].slug).toBe('dedie-ovh');
    expect(entries[0].aliases).toEqual(['le dédié', 'prod']);

    const entry = await KnowledgeService.getEntry('le dédié');
    expect(entry.content).toContain('IP 1.2.3.4');
  });

  test('writing the same title updates instead of duplicating', async () => {
    await KnowledgeService.writeEntry({ title: 'VPS', content: 'v1' });
    await KnowledgeService.writeEntry({ title: 'VPS', content: 'v2' });

    const { entries } = await KnowledgeService.listEntries();
    expect(entries).toHaveLength(1);
    expect((await KnowledgeService.getEntry('VPS')).content).toBe('v2');
  });

  test('renaming carries the body over to the new file', async () => {
    const created = await KnowledgeService.writeEntry({ title: 'Old name', content: 'keep me' });
    await KnowledgeService.writeEntry({ id: created.id, title: 'New name' });

    const entry = await KnowledgeService.getEntry('New name');
    expect(entry.content).toBe('keep me');
    expect(fs.existsSync(path.join(dataDir, 'knowledge', 'entries', 'old-name.md'))).toBe(false);
  });

  test('deletes an entry and its file', async () => {
    await KnowledgeService.writeEntry({ title: 'Temp', content: 'x' });
    expect(await KnowledgeService.deleteEntry('Temp')).toBe(true);
    expect((await KnowledgeService.listEntries()).entries).toHaveLength(0);
    expect(fs.existsSync(path.join(dataDir, 'knowledge', 'entries', 'temp.md'))).toBe(false);
  });

  test('searches titles, aliases and bodies', async () => {
    await KnowledgeService.writeEntry({ title: 'Server A', content: 'runs nginx', aliases: ['alpha'] });
    await KnowledgeService.writeEntry({ title: 'Server B', content: 'runs postgres' });

    expect((await KnowledgeService.searchEntries('nginx')).map(r => r.title)).toEqual(['Server A']);
    expect((await KnowledgeService.searchEntries('alpha')).map(r => r.title)).toEqual(['Server A']);
    expect(await KnowledgeService.searchEntries('')).toEqual([]);
  });
});

describe('CLAUDE.md injection', () => {
  test('pinned entries are inlined, others only indexed', async () => {
    await KnowledgeService.writeEntry({ title: 'Pinned one', content: 'FULL BODY', pinned: true });
    await KnowledgeService.writeEntry({ title: 'Lazy one', content: 'HIDDEN BODY', summary: 'a summary' });

    const md = claudeMd();
    expect(md).toContain('CLAUDE-TERMINAL:KNOWLEDGE:START');
    expect(md).toContain('FULL BODY');
    expect(md).not.toContain('HIDDEN BODY');
    expect(md).toContain('**Lazy one**');
    expect(md).toContain('a summary');
  });

  test('preserves hand-written content around the block', async () => {
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), '# My rules\nkeep this line\n', 'utf8');

    await KnowledgeService.writeEntry({ title: 'Thing', content: 'body', pinned: true });
    expect(claudeMd()).toContain('keep this line');

    await KnowledgeService.deleteEntry('Thing');
    const after = claudeMd();
    expect(after).toContain('keep this line');
    expect(after).not.toContain('CLAUDE-TERMINAL:KNOWLEDGE');
  });

  test('rewrites the block in place instead of appending a second one', async () => {
    await KnowledgeService.writeEntry({ title: 'One', content: 'a', pinned: true });
    await KnowledgeService.writeEntry({ title: 'Two', content: 'b', pinned: true });

    const md = claudeMd();
    expect(md.match(/CLAUDE-TERMINAL:KNOWLEDGE:START/g)).toHaveLength(1);
    expect(md).toContain('One');
    expect(md).toContain('Two');
  });

  test('disabling removes the block without deleting entries', async () => {
    await KnowledgeService.writeEntry({ title: 'Kept', content: 'body', pinned: true });

    await KnowledgeService.setEnabled(false);
    expect(claudeMd()).not.toContain('CLAUDE-TERMINAL:KNOWLEDGE');
    expect((await KnowledgeService.listEntries()).entries).toHaveLength(1);

    await KnowledgeService.setEnabled(true);
    expect(claudeMd()).toContain('body');
  });
});
