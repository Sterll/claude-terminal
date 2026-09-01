/**
 * session_search / session_recap (resources/mcp-servers/tools/sessions.js).
 *
 * The tools read ~/.claude/projects at call time, so os.homedir() is redirected
 * to a temp tree of hand-built JSONL fixtures. That makes the filtering rules
 * testable in isolation: tool output must not match, sidechains and the tab
 * naming session must be excluded, synthetic markers must not count as things
 * the user said.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-sessions-'));

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => global.__CT_FAKE_HOME__ };
});
global.__CT_FAKE_HOME__ = HOME;

const sessions = require('../../resources/mcp-servers/tools/sessions.js');

// -- Fixture helpers ----------------------------------------------------------

const PROJECT = 'E:\\Fixture\\Alpha';

function encode(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function projectDir(projectPath = PROJECT) {
  return path.join(HOME, '.claude', 'projects', encode(projectPath));
}

let clock = Date.parse('2026-08-01T10:00:00.000Z');
function nextStamp() {
  clock += 60000;
  return new Date(clock).toISOString();
}

const base = (sessionId, extra = {}) => ({
  sessionId,
  cwd: PROJECT,
  gitBranch: 'main',
  timestamp: nextStamp(),
  ...extra,
});

const userMsg = (sessionId, text, extra) =>
  ({ ...base(sessionId, extra), type: 'user', message: { role: 'user', content: text } });

const assistantMsg = (sessionId, text) =>
  ({ ...base(sessionId), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const assistantTool = (sessionId, name, input, id) =>
  ({ ...base(sessionId), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input, id }] } });

const toolResult = (sessionId, id, output) =>
  ({ ...base(sessionId), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output }] } });

/** JSONL files under 200 bytes are skipped, so pad short fixtures. */
function writeSession(sessionId, entries, projectPath = PROJECT) {
  const dir = projectDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const padded = [...entries, { type: 'padding', filler: 'x'.repeat(300) }];
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    padded.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );
}

function textOf(result) {
  return result.content[0].text;
}

beforeAll(() => {
  // A real conversation: the term appears in what was actually said.
  writeSession('sess-real', [
    userMsg('sess-real', 'on doit corriger le bug FLUXCAPACITOR avant la release'),
    assistantTool('sess-real', 'Edit', { file_path: 'E:\\Fixture\\Alpha\\src\\fix.js' }, 't1'),
    toolResult('sess-real', 't1', 'ok'),
    assistantMsg('sess-real', 'Corrigé dans src/fix.js, je lance les tests.'),
  ]);

  // The term exists ONLY inside tool output — must not be reported as a hit.
  writeSession('sess-tooloutput', [
    userMsg('sess-tooloutput', 'lance le build stp'),
    assistantTool('sess-tooloutput', 'Bash', { command: 'npm run build' }, 't2'),
    toolResult('sess-tooloutput', 't2', 'warning: FLUXCAPACITOR deprecated in vendor lib'),
    assistantMsg('sess-tooloutput', 'Build terminé.'),
  ]);

  // The tab-naming session replays every prompt opening — pure machinery.
  writeSession('sess-naming', [
    userMsg('sess-naming', 'Title for: "on doit corriger le bug FLUXCAPACITOR avant"'),
    assistantMsg('sess-naming', 'Bug FLUXCAPACITOR'),
  ]);

  // Subagent transcript: excluded like session_list already does.
  writeSession('sess-sidechain', [
    userMsg('sess-sidechain', 'analyse FLUXCAPACITOR en profondeur', { isSidechain: true }),
    assistantMsg('sess-sidechain', 'rapport interne'),
  ]);
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

// -- session_search -----------------------------------------------------------

describe('session_search', () => {
  test('finds the term in what was actually said', async () => {
    const out = textOf(await sessions.handle('session_search', { query: 'FLUXCAPACITOR' }));

    expect(out).toContain('sess-real');
    expect(out).toContain('Found 1 session');
  });

  test('ignores a term that only appears in tool output', async () => {
    const out = textOf(await sessions.handle('session_search', { query: 'FLUXCAPACITOR' }));

    expect(out).not.toContain('sess-tooloutput');
  });

  test('excludes the tab naming session and sidechains', async () => {
    const out = textOf(await sessions.handle('session_search', { query: 'FLUXCAPACITOR' }));

    expect(out).not.toContain('sess-naming');
    expect(out).not.toContain('sess-sidechain');
  });

  test('reports the real project path, not the encoded folder name', async () => {
    const out = textOf(await sessions.handle('session_search', { query: 'FLUXCAPACITOR' }));

    expect(out).toContain(PROJECT);
    expect(out).not.toContain(encode(PROJECT));
  });

  test('requires every term of a multi-word query', async () => {
    const hit = textOf(await sessions.handle('session_search', { query: 'bug FLUXCAPACITOR' }));
    expect(hit).toContain('sess-real');

    const miss = textOf(await sessions.handle('session_search', { query: 'FLUXCAPACITOR licorne' }));
    expect(miss).toContain('No conversation found');
  });

  test('says so plainly when nothing matches', async () => {
    const out = textOf(await sessions.handle('session_search', { query: 'zzznotherezzz' }));

    expect(out).toContain('No conversation found');
    expect(out).toMatch(/Scanned \d+ session file/);
  });

  test('rejects an empty query', async () => {
    const res = await sessions.handle('session_search', { query: '   ' });

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/query/i);
  });

  test('discloses when it stopped early instead of pretending full coverage', async () => {
    const out = textOf(await sessions.handle('session_search', { query: 'bug', limit: 1 }));

    // Either it found everything, or it must say what it skipped.
    if (/Stopped at/.test(out)) {
      expect(out).toMatch(/were not searched/);
    }
    expect(out).toMatch(/scanned \d+\/\d+ file/);
  });
});

// -- session_recap ------------------------------------------------------------

describe('session_recap', () => {
  test('reports the goal, the outcome and the files touched', async () => {
    const out = textOf(await sessions.handle('session_recap', {
      project_path: PROJECT,
      session_id: 'sess-real',
    }));

    expect(out).toContain('sess-real');
    expect(out).toContain('corriger le bug FLUXCAPACITOR');
    expect(out).toContain('src\\fix.js');
    expect(out).toContain('Edit×1');
    expect(out).toContain('Where it stopped');
  });

  test('stays compact enough to be read out loud', async () => {
    const out = textOf(await sessions.handle('session_recap', {
      project_path: PROJECT,
      session_id: 'sess-real',
    }));

    expect(out.length).toBeLessThan(4000);
  });

  test('labels the timespan rather than implying time worked', async () => {
    const out = textOf(await sessions.handle('session_recap', {
      project_path: PROJECT,
      session_id: 'sess-real',
    }));

    expect(out).toContain('first to last message');
    expect(out).not.toMatch(/^Duration:/m);
  });

  test('falls back to the most recent session when no id is given', async () => {
    const out = textOf(await sessions.handle('session_recap', { project_path: PROJECT }));

    expect(out).toMatch(/^# Recap: sess-/m);
  });

  test('handles an unknown session id without throwing', async () => {
    const out = textOf(await sessions.handle('session_recap', {
      project_path: PROJECT,
      session_id: 'nope',
    }));

    expect(out).toMatch(/not found/i);
  });

  test('requires a project path', async () => {
    const res = await sessions.handle('session_recap', {});

    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/project path/i);
  });
});

// -- Robustness ---------------------------------------------------------------

describe('malformed input', () => {
  test('a corrupt JSONL line does not break the scan', async () => {
    const dir = projectDir();
    fs.writeFileSync(
      path.join(dir, 'sess-corrupt.jsonl'),
      [
        '{ this is not json at all',
        JSON.stringify(userMsg('sess-corrupt', 'le mot MAGNETRON est ici')),
        '',
        '{"truncated":',
        JSON.stringify({ type: 'padding', filler: 'y'.repeat(300) }),
      ].join('\n'),
      'utf8'
    );

    const out = textOf(await sessions.handle('session_search', { query: 'MAGNETRON' }));
    expect(out).toContain('sess-corrupt');
  });
});
