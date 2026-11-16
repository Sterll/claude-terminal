/**
 * src/shared/vault-store.js against a real vault on disk: scanning, the
 * containment rules, reading with backlinks, and the two writes (a new note,
 * the daily note), which may only ever add.
 *
 * @jest-environment node
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../src/shared/vault-store');

let root;
let outside;

function write(rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-vault-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'SECRET');
  write('.obsidian/app.json', JSON.stringify({ newFileLocation: 'folder', newFileFolderPath: 'Inbox', userIgnoreFilters: ['Private/', '/^Drafts\\//'] }));
  write('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Journal', format: 'YYYY-MM-DD', template: 'Templates/Daily' }));
  write('.obsidian/templates.json', JSON.stringify({ folder: 'Templates', dateFormat: 'DD/MM/YYYY' }));
  write('.obsidian/core-plugins.json', JSON.stringify({ 'daily-notes': true }));
  write('Home.md', '---\naliases: [Accueil]\ntags: [hub]\n---\n# Home\nSee [[Projects/Alpha]] and [[Ideas|my ideas]] and [[Missing note]]. #index');
  write('Projects/Alpha.md', 'Alpha project. Back to [[Home]]. #projet/alpha');
  write('Ideas.md', 'An idea about rate limiting.\nLinks [[Alpha]].');
  write('Templates/Daily.md', '# {{title}}\nCreated {{date}}\n\n## Morning\n');
  write('Private/Diary.md', 'excluded by the user');
  write('Drafts/x.md', 'excluded by regex');
  write('.trash/old.md', 'deleted');
  write('notes.txt', 'not a note');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('vault settings follow .obsidian, with defaults for what is missing', async () => {
  const s = await store.readVaultSettings(root);
  expect(s.isObsidian).toBe(true);
  expect(s.newFileLocation).toBe('folder');
  expect(s.newFileFolderPath).toBe('Inbox');
  expect(s.daily).toEqual({ folder: 'Journal', format: 'YYYY-MM-DD', template: 'Templates/Daily', enabled: true });
  expect(s.templates.dateFormat).toBe('DD/MM/YYYY');
  expect(s.templates.timeFormat).toBe('HH:mm');
  expect(s.useMarkdownLinks).toBe(false);
});

test('an unreadable settings file means defaults, and is left alone', async () => {
  write('.obsidian/daily-notes.json', '{ broken');
  const s = await store.readVaultSettings(root);
  expect(s.daily.format).toBe('YYYY-MM-DD');
  expect(fs.readFileSync(path.join(root, '.obsidian/daily-notes.json'), 'utf8')).toBe('{ broken');
});

test('a plain folder of markdown works too', async () => {
  fs.rmSync(path.join(root, '.obsidian'), { recursive: true });
  const s = await store.readVaultSettings(root);
  expect(s.isObsidian).toBe(false);
  expect(s.newFileLocation).toBe('root');
});

test('the scan skips dot folders, excluded paths, other files and symlinks', async () => {
  fs.symlinkSync(outside, path.join(root, 'linked'));
  const index = new store.VaultIndex(root);
  await index.refresh();
  expect([...index.notes.keys()].sort()).toEqual(['Home.md', 'Ideas.md', 'Projects/Alpha.md', 'Templates/Daily.md']);
});

test('search by name, alias, tag, and recent notes for an empty query', async () => {
  const index = new store.VaultIndex(root);
  await index.refresh();
  expect(index.search('alpha')[0].path).toBe('Projects/Alpha.md');
  expect(index.search('accueil')[0].path).toBe('Home.md');
  expect(index.search('#projet').map((n) => n.path)).toEqual(['Projects/Alpha.md']);
  expect(index.search('').length).toBe(4);
});

test('content search returns the matching line', async () => {
  const index = new store.VaultIndex(root);
  await index.refresh();
  const { results } = await index.searchContent('rate limiting');
  expect(results.map((r) => r.path)).toEqual(['Ideas.md']);
  expect(results[0].line).toBe('An idea about rate limiting.');
});

test('a note with its links resolved and its backlinks', async () => {
  const index = new store.VaultIndex(root);
  await index.refresh();
  const note = await store.readNote(index, 'Home');
  expect(note.aliases).toEqual(['Accueil']);
  expect(note.tags.sort()).toEqual(['hub', 'index']);
  expect(note.links.map((l) => [l.target, l.path])).toEqual([
    ['Projects/Alpha', 'Projects/Alpha.md'],
    ['Ideas', 'Ideas.md'],
    ['Missing note', null],
  ]);
  expect(note.backlinks).toEqual(['Projects/Alpha.md']);
  expect((await store.readNote(index, 'Projects/Alpha.md')).backlinks.sort()).toEqual(['Home.md', 'Ideas.md']);
  expect(index.stats().unresolved).toBe(1);
});

test('nothing outside the vault can be read', async () => {
  fs.symlinkSync(outside, path.join(root, 'linked'));
  const index = new store.VaultIndex(root);
  await index.refresh();
  for (const p of ['../' + path.basename(outside) + '/secret', '/etc/hosts', '.obsidian/app.json', 'linked/secret', '.trash/old']) {
    expect(await store.readNote(index, p)).toBeNull();
  }
});

test('a refresh only re-reads notes that changed', async () => {
  const index = new store.VaultIndex(root);
  await index.refresh();
  const before = index.notes.get('Ideas.md');
  write('Home.md', 'Changed, no more links. #index');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'Home.md'), later, later);
  await index.refresh();
  expect(index.notes.get('Ideas.md')).toBe(before);
  expect(index.backlinksOf('Projects/Alpha.md')).toEqual(['Ideas.md']);
});

test('a new note goes to the default folder and never replaces one', async () => {
  const index = new store.VaultIndex(root);
  await index.refresh();
  const a = await store.createNote(index, { title: 'Session: auth fix', content: 'Body', frontmatter: { tags: ['claude-terminal'] } });
  expect(a.path).toBe('Inbox/Session auth fix.md');
  expect(fs.readFileSync(path.join(root, 'Inbox/Session auth fix.md'), 'utf8')).toBe('---\ntags:\n  - claude-terminal\n---\nBody\n');
  const b = await store.createNote(index, { title: 'Session: auth fix', content: 'Other' });
  expect(b.path).toBe('Inbox/Session auth fix 1.md');
  expect(fs.readFileSync(path.join(root, 'Inbox/Session auth fix.md'), 'utf8')).toContain('Body');
  const c = await store.createNote(index, { title: 'At root', folder: '' });
  expect(c.path).toBe('At root.md');
  await expect(store.createNote(index, { title: 'x', folder: '../escape' })).rejects.toThrow('Invalid folder');
  await expect(store.createNote(index, { title: 'x', folder: '.obsidian' })).rejects.toThrow('Invalid folder');
});

test('the daily note is created from its template, then appended to', async () => {
  const index = new store.VaultIndex(root);
  const date = new Date(2026, 10, 16, 14, 30);
  const first = await store.appendToDaily(index, { text: '- first entry', heading: 'Claude Terminal', date });
  expect(first).toEqual({ path: 'Journal/2026-11-16.md', created: true });
  const second = await store.appendToDaily(index, { text: '- second entry', heading: 'Claude Terminal', date });
  expect(second.created).toBe(false);
  expect(fs.readFileSync(path.join(root, 'Journal/2026-11-16.md'), 'utf8')).toBe(
    '# 2026-11-16\nCreated 16/11/2026\n\n## Morning\n\n## Claude Terminal\n\n- first entry\n\n- second entry\n'
  );
  // No temp file left behind.
  expect(fs.readdirSync(path.join(root, 'Journal'))).toEqual(['2026-11-16.md']);
});

test('the daily note keeps what the user wrote in it meanwhile', async () => {
  const index = new store.VaultIndex(root);
  const date = new Date(2026, 10, 16);
  await store.appendToDaily(index, { text: 'A', heading: 'Log', date });
  const file = path.join(root, 'Journal/2026-11-16.md');
  fs.appendFileSync(file, '\nTyped by hand in Obsidian\n');
  await store.appendToDaily(index, { text: 'B', heading: 'Log', date });
  const text = fs.readFileSync(file, 'utf8');
  expect(text).toContain('Typed by hand in Obsidian');
  expect(text).toContain('A');
  expect(text).toContain('B');
});

test('a named daily format reuses an existing English-named note', async () => {
  write('.obsidian/daily-notes.json', JSON.stringify({ format: 'D MMMM YYYY' }));
  write('16 November 2026.md', 'existing');
  const index = new store.VaultIndex(root);
  const r = await store.appendToDaily(index, { text: 'x', date: new Date(2026, 10, 16), locale: 'fr' });
  expect(r).toEqual({ path: '16 November 2026.md', created: false });
});

test('a daily folder that escapes the vault is refused', async () => {
  write('.obsidian/daily-notes.json', JSON.stringify({ folder: '../out' }));
  const index = new store.VaultIndex(root);
  await expect(store.appendToDaily(index, { text: 'x' })).rejects.toThrow();
});
