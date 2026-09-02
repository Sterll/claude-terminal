// Session titles come from the transcript, and an id must be searchable.
//
// Claude Code appends `custom-title` / `ai-title` lines as a session runs, so the
// current title sits near the END of the file — which can be hundreds of MB.

const realOs = require('os');
const fs = require('fs');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-session-title-'));

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() }
}));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => global.__CT_TMP_HOME__
}));

global.__CT_TMP_HOME__ = TMP_HOME;

const { getClaudeSessions, readSessionTitle } = require('../../src/main/ipc/claude.ipc');

const PROJECT_PATH = '/tmp/title-demo';
const sessionsDir = () => path.join(TMP_HOME, '.claude', 'projects', PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-'));

/** @param {{sessionId: string, customTitle?: string, aiTitle?: string, padding?: number}} opts */
function writeSession({ sessionId, customTitle, aiTitle, padding = 0 }) {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });

  const lines = [JSON.stringify({
    type: 'user', uuid: 'u-0', sessionId, cwd: PROJECT_PATH, gitBranch: 'main',
    message: { role: 'user', content: 'the opening prompt' }
  })];
  if (aiTitle) lines.push(JSON.stringify({ type: 'ai-title', aiTitle, sessionId }));
  for (let i = 0; i < padding; i++) {
    lines.push(JSON.stringify({
      type: 'assistant', uuid: `a-${i}`, sessionId, cwd: PROJECT_PATH,
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(200) }] }
    }));
  }
  // Titles are re-emitted as the conversation goes: the live one is the last
  if (customTitle) lines.push(JSON.stringify({ type: 'custom-title', customTitle, sessionId }));

  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('readSessionTitle', () => {
  test('prefers custom-title over ai-title', async () => {
    const file = writeSession({ sessionId: 'a1', customTitle: 'Renamed by hand', aiTitle: 'Generated' });
    const { size } = fs.statSync(file);

    expect(await readSessionTitle(file, size)).toEqual({
      customTitle: 'Renamed by hand',
      aiTitle: 'Generated'
    });
  });

  test('falls back to ai-title when the session was never renamed', async () => {
    const file = writeSession({ sessionId: 'a2', aiTitle: 'Only generated' });
    const { size } = fs.statSync(file);

    const { customTitle, aiTitle } = await readSessionTitle(file, size);
    expect(customTitle).toBe('');
    expect(aiTitle).toBe('Only generated');
  });

  test('finds a title far past the head of a long transcript', async () => {
    // ~2000 lines of 200 chars: well beyond the 30-line head scan used elsewhere
    const file = writeSession({ sessionId: 'a3', customTitle: 'Title at the very end', padding: 2000 });
    const { size } = fs.statSync(file);

    expect((await readSessionTitle(file, size)).customTitle).toBe('Title at the very end');
  });

  test('reads only the tail, so a title left behind by a huge body is missed rather than costly', async () => {
    // Title emitted early, then more than 128 KB of body after it
    const dir = sessionsDir();
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'Stale early title', sessionId: 'a4' }),
      ...Array.from({ length: 1200 }, (_, i) => JSON.stringify({
        type: 'assistant', uuid: `a-${i}`, sessionId: 'a4', cwd: PROJECT_PATH,
        message: { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(200) }] }
      }))
    ];
    const file = path.join(dir, 'a4.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const { size } = fs.statSync(file);
    expect(size).toBeGreaterThan(128 * 1024);

    expect((await readSessionTitle(file, size)).customTitle).toBe('');
  });

  test('returns empty titles for an unreadable file', async () => {
    expect(await readSessionTitle(path.join(sessionsDir(), 'nope.jsonl'), 10)).toEqual({
      customTitle: '', aiTitle: ''
    });
  });
});

describe('getClaudeSessions', () => {
  test('carries the transcript title alongside the opening prompt', async () => {
    writeSession({ sessionId: 'b1', customTitle: 'Renamed by hand', aiTitle: 'Generated' });

    const sessions = await getClaudeSessions(PROJECT_PATH);
    const session = sessions.find(s => s.sessionId === 'b1');

    expect(session.title).toBe('Renamed by hand');
    expect(session.customTitle).toBe('Renamed by hand');
    expect(session.aiTitle).toBe('Generated');
    // The opening prompt is still there, it just stops being the label
    expect(session.firstPrompt).toBe('the opening prompt');
  });

  test('leaves title empty when the transcript has none', async () => {
    // padding clears the 200-byte floor that skips empty/aborted sessions
    writeSession({ sessionId: 'b2', padding: 1 });

    const sessions = await getClaudeSessions(PROJECT_PATH);
    expect(sessions.find(s => s.sessionId === 'b2').title).toBe('');
  });
});
