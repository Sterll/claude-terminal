/**
 * Tolerant name resolution (_nameMatch.js) and its wiring into projects.js.
 *
 * The point is voice control: speech-to-text returns "marvel quiz", never
 * "marvel-quiz". These tests pin both halves of the contract — loose enough to
 * resolve a spoken name, strict enough never to guess the target of a delete.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const nameMatch = require('../../resources/mcp-servers/tools/_nameMatch.js');

describe('normalize', () => {
  test('folds case, accents and every kind of separator', () => {
    expect(nameMatch.normalize('Marvel-Quiz')).toBe('marvel quiz');
    expect(nameMatch.normalize('marvel_quiz')).toBe('marvel quiz');
    expect(nameMatch.normalize('  Marvel   Quiz  ')).toBe('marvel quiz');
    expect(nameMatch.normalize('Créé-Été')).toBe('cree ete');
  });

  test('survives null and undefined', () => {
    expect(nameMatch.normalize(null)).toBe('');
    expect(nameMatch.normalize(undefined)).toBe('');
  });
});

describe('resolve', () => {
  const items = [
    { id: 'p1', name: 'marvel-quiz' },
    { id: 'p2', name: 'spacebot' },
    { id: 'p3', name: 'ClaudeTerminal' },
  ];
  const names = (p) => [p.id, p.name];

  const resolve = (q, list = items) => nameMatch.resolve(q, list, names);

  test('matches an id exactly and reports the id tier', () => {
    const r = resolve('p2');
    expect(r.match.name).toBe('spacebot');
    expect(r.tier).toBe('id');
  });

  test('resolves a spoken name with a space to the hyphenated project', () => {
    expect(resolve('marvel quiz').match.name).toBe('marvel-quiz');
    expect(resolve('Marvel Quiz').match.name).toBe('marvel-quiz');
    expect(resolve('MARVEL   QUIZ').match.name).toBe('marvel-quiz');
  });

  test('absorbs a transcription slip', () => {
    const r = resolve('marvelle quiz');
    expect(r.match.name).toBe('marvel-quiz');
    expect(r.tier).toBe('fuzzy');
  });

  test('finds a project named inside a longer spoken phrase', () => {
    expect(resolve('claude terminal').match.name).toBe('ClaudeTerminal');
  });

  test('refuses to arbitrate between equally good candidates', () => {
    const ambiguous = [
      { id: 'a1', name: 'api-client' },
      { id: 'a2', name: 'api-server' },
    ];

    const r = nameMatch.resolve('api', ambiguous, names);
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(2);
  });

  test('ambiguity at a strict tier does not fall through to a looser one', () => {
    // Both start with "api"; a looser tier must not be allowed to pick a winner.
    const ambiguous = [
      { id: 'a1', name: 'api' },
      { id: 'a2', name: 'api-server' },
    ];

    const r = nameMatch.resolve('api', ambiguous, names);
    // "api" is an exact match for one and a prefix of the other: exact tier wins
    // with a single hit, which is correct and unambiguous.
    expect(r.match.name).toBe('api');
    expect(r.tier).toBe('exact');
  });

  test('does not fuzzy-guess on very short queries', () => {
    const r = nameMatch.resolve('mrv', [{ id: 'x', name: 'marvel-quiz' }], names);
    expect(r.match).toBeNull();
  });

  test('returns nothing for an unrelated query', () => {
    const r = resolve('totally-unrelated-thing');
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(0);
  });

  test('handles an empty query and an empty list', () => {
    expect(resolve('').match).toBeNull();
    expect(nameMatch.resolve('anything', [], names).match).toBeNull();
  });
});

describe('boundedLevenshtein', () => {
  test('measures small edits', () => {
    expect(nameMatch.boundedLevenshtein('marvel', 'marvel', 3)).toBe(0);
    expect(nameMatch.boundedLevenshtein('marvel', 'marvle', 3)).toBe(2);
  });

  test('bails out past the bound instead of computing the full distance', () => {
    expect(nameMatch.boundedLevenshtein('abc', 'zzzzzzzzzz', 2)).toBeGreaterThan(2);
  });
});

// -- Wiring into the project tools --------------------------------------------

describe('projects.js resolution boundary', () => {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-projects-'));
  let projects;

  beforeAll(() => {
    process.env.CT_DATA_DIR = DATA_DIR;
    fs.writeFileSync(
      path.join(DATA_DIR, 'projects.json'),
      JSON.stringify({
        projects: [
          { id: 'p1', name: 'marvel-quiz', path: 'E:\\Perso\\marvel-quiz', type: 'webapp' },
          { id: 'p2', name: 'spacebot', path: 'E:\\Perso\\spacebot', type: 'discord' },
        ],
        folders: [],
        rootOrder: ['p1', 'p2'],
      }),
      'utf8'
    );
    projects = require('../../resources/mcp-servers/tools/projects.js');
  });

  afterAll(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const textOf = (r) => r.content[0].text;

  test('a read tool accepts a spoken project name', async () => {
    const out = textOf(await projects.handle('project_info', { project: 'marvel quiz' }));
    expect(out).toContain('marvel-quiz');
  });

  test('project_delete refuses an approximate name and names the near miss', async () => {
    const res = await projects.handle('project_delete', { project: 'marvel quiz' });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No exact project/i);
    expect(textOf(res)).toContain('marvel-quiz');

    // And the project is still there.
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8'));
    expect(saved.projects).toHaveLength(2);
  });

  test('an unrelated name still reports a plain not-found', async () => {
    const res = await projects.handle('project_info', { project: 'nothing-like-this' });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
  });
});
