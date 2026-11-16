const path = require('path');
const {
  folderNameFor, detectProjectType, findDuplicate, nameFromRepoUrl, validateDraft,
} = require('../../src/renderer/utils/newProject');

describe('folderNameFor', () => {
  test('keeps a display name as typed, minus forbidden characters', () => {
    expect(folderNameFor('My App')).toBe('My App');
    expect(folderNameFor('a/b:c*d?')).toBe('a-b-c-d-');
    expect(folderNameFor('  ..trim me..  ')).toBe('trim me');
    expect(folderNameFor('CON')).toBe('CON-project');
    expect(folderNameFor('')).toBe('project');
  });

  test('strict mode follows npm package-name rules for templates', () => {
    expect(folderNameFor('Mon Super Projet', { strict: true })).toBe('mon-super-projet');
    expect(folderNameFor('Café Déjà-Vu!', { strict: true })).toBe('cafe-deja-vu');
    expect(folderNameFor('--x--', { strict: true })).toBe('x');
  });
});

describe('detectProjectType', () => {
  test('recognises each type from its markers', () => {
    expect(detectProjectType(['fxmanifest.lua'])).toMatchObject({ type: 'fivem' });
    expect(detectProjectType(['server.properties'])).toMatchObject({ type: 'minecraft' });
    expect(detectProjectType(['package.json'], { dependencies: { 'discord.js': '1' } })).toMatchObject({ type: 'discord' });
    expect(detectProjectType(['package.json'], { devDependencies: { vite: '1' } })).toMatchObject({ type: 'webapp', reason: 'vite' });
    expect(detectProjectType(['package.json'], { dependencies: { express: '1' } })).toMatchObject({ type: 'api' });
    expect(detectProjectType(['requirements.txt'], null, 'fastapi==0.1')).toMatchObject({ type: 'api', reason: 'fastapi' });
    expect(detectProjectType(['pyproject.toml'], null, '')).toMatchObject({ type: 'python' });
    expect(detectProjectType(['README.md'])).toBeNull();
  });
});

describe('duplicates and repo names', () => {
  test('findDuplicate ignores case, separators and a trailing slash', () => {
    const projects = [{ name: 'A', path: 'C:\\Code\\App' }];
    expect(findDuplicate(projects, 'c:/code/app/')).toBe(projects[0]);
    expect(findDuplicate(projects, 'c:/code/other')).toBeNull();
  });

  test('nameFromRepoUrl', () => {
    expect(nameFromRepoUrl('https://github.com/me/my-repo.git')).toBe('my-repo');
    expect(nameFromRepoUrl('git@github.com:me/other')).toBe('other');
  });
});

describe('validateDraft', () => {
  const base = { name: 'App', location: '/code', projects: [], joinPath: path.posix.join };

  test('nothing to create without a name or a location', () => {
    expect(validateDraft({ ...base, source: 'create', name: '' }).ok).toBe(false);
    expect(validateDraft({ ...base, source: 'create', location: '' }).ok).toBe(false);
  });

  test('create targets <location>/<name> and refuses an existing folder', () => {
    expect(validateDraft({ ...base, source: 'create', probe: 'missing' })).toMatchObject({ ok: true, target: '/code/App' });
    expect(validateDraft({ ...base, source: 'create', probe: 'dir' })).toMatchObject({ ok: false, error: 'newProject.v.targetExists' });
  });

  test('templates use the strict folder name', () => {
    expect(validateDraft({ ...base, source: 'scaffold', name: 'My App', template: 'react', probe: 'missing' }).target).toBe('/code/my-app');
    expect(validateDraft({ ...base, source: 'scaffold', probe: 'missing' }).error).toBe('newProject.v.pickTemplate');
  });

  test('a duplicate is caught before any clone starts', () => {
    const v = validateDraft({ ...base, source: 'clone', repoUrl: 'https://x/y.git', probe: 'missing', projects: [{ name: 'Old', path: '/code/App' }] });
    expect(v).toMatchObject({ ok: false, error: 'newProject.v.duplicate', errorParams: { name: 'Old' } });
  });

  test('a malformed repo URL blocks clone', () => {
    expect(validateDraft({ ...base, source: 'clone', repoUrl: 'ftp://x', probe: 'missing' })).toMatchObject({ ok: false, error: 'newProject.v.badRepoUrl' });
  });

  test('existing folder: a missing path is a warning, a file an error, an ungranted path explained', () => {
    expect(validateDraft({ ...base, source: 'folder', location: '/x', probe: 'missing' })).toMatchObject({ ok: true, warning: 'newProject.v.willCreateFolder' });
    expect(validateDraft({ ...base, source: 'folder', location: '/x', probe: 'file' })).toMatchObject({ ok: false, error: 'newProject.v.notAFolder' });
    expect(validateDraft({ ...base, source: 'folder', location: '/x', probe: 'denied' })).toMatchObject({ ok: false, error: 'newProject.v.pickWithDialog' });
  });
});
