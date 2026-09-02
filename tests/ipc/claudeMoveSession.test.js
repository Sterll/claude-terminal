// Moving a session between projects.
//
// A session is a transcript plus, usually, a sibling directory holding subagent
// transcripts, workflow scripts and tool results. Both have to travel, and the
// source must not be dropped until the copy is verified.

const realOs = require('os');
const fs = require('fs');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-move-session-'));

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() }
}));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => global.__CT_TMP_HOME__
}));

global.__CT_TMP_HOME__ = TMP_HOME;

const { moveSession, findStraySidecars, getClaudeSessions } = require('../../src/main/ipc/claude.ipc');

const ALPHA = '/tmp/proj-alpha';
const BETA = '/tmp/proj-beta';
const GAMMA = '/tmp/proj-gamma';
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

const encode = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const dirFor = (p) => path.join(TMP_HOME, '.claude', 'projects', encode(p));
const transcript = (p, sid = SID) => path.join(dirFor(p), `${sid}.jsonl`);
const sidecar = (p, sid = SID) => path.join(dirFor(p), sid);

function writeSession(projectPath, sid = SID, lines = 6) {
  const dir = dirFor(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const body = Array.from({ length: lines }, (_, i) => JSON.stringify({
    type: i === 0 ? 'user' : 'assistant', uuid: `u-${i}`, sessionId: sid, cwd: projectPath,
    gitBranch: 'main',
    message: i === 0
      ? { role: 'user', content: 'a prompt long enough to clear the size floor '.repeat(4) }
      : { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] }
  }));
  fs.writeFileSync(transcript(projectPath, sid), body.join('\n') + '\n');
}

function writeSidecar(projectPath, sid = SID) {
  const dir = path.join(sidecar(projectPath, sid), 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-abc.jsonl'), '{"type":"user"}\n');
  fs.mkdirSync(path.join(sidecar(projectPath, sid), 'workflows', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(sidecar(projectPath, sid), 'workflows', 'scripts', 'wf.js'), 'export const meta = {}\n');
}

beforeEach(() => {
  fs.rmSync(path.join(TMP_HOME, '.claude'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('moveSession', () => {
  test('moves the transcript and removes it from the source', async () => {
    writeSession(ALPHA);
    const before = fs.readFileSync(transcript(ALPHA), 'utf8');

    const result = await moveSession(SID, ALPHA, BETA);

    expect(result.success).toBe(true);
    expect(fs.existsSync(transcript(BETA))).toBe(true);
    expect(fs.existsSync(transcript(ALPHA))).toBe(false);
    expect(fs.readFileSync(transcript(BETA), 'utf8')).toBe(before);
  });

  test('leaves no .moving temp file behind', async () => {
    writeSession(ALPHA);
    await moveSession(SID, ALPHA, BETA);

    expect(fs.readdirSync(dirFor(BETA)).filter(f => f.endsWith('.moving'))).toEqual([]);
  });

  test('takes the sidecar directory with it', async () => {
    writeSession(ALPHA);
    writeSidecar(ALPHA);

    const result = await moveSession(SID, ALPHA, BETA);

    expect(result.movedSidecar).toBe(true);
    expect(fs.existsSync(sidecar(ALPHA))).toBe(false);
    expect(fs.readFileSync(path.join(sidecar(BETA), 'subagents', 'agent-abc.jsonl'), 'utf8'))
      .toBe('{"type":"user"}\n');
    expect(fs.existsSync(path.join(sidecar(BETA), 'workflows', 'scripts', 'wf.js'))).toBe(true);
  });

  test('a session without a sidecar moves fine', async () => {
    writeSession(ALPHA);
    const result = await moveSession(SID, ALPHA, BETA);

    expect(result.success).toBe(true);
    expect(result.movedSidecar).toBe(false);
  });

  test('creates the target project directory when it has none yet', async () => {
    writeSession(ALPHA);
    expect(fs.existsSync(dirFor(GAMMA))).toBe(false);

    expect((await moveSession(SID, ALPHA, GAMMA)).success).toBe(true);
    expect(fs.existsSync(transcript(GAMMA))).toBe(true);
  });

  test('the moved session shows up in the target project listing', async () => {
    writeSession(ALPHA);
    await moveSession(SID, ALPHA, BETA);

    expect((await getClaudeSessions(BETA)).map(s => s.sessionId)).toContain(SID);
    expect(await getClaudeSessions(ALPHA)).toEqual([]);
  });

  test('refuses when the target already holds that session, keeping both intact', async () => {
    writeSession(ALPHA);
    writeSession(BETA);
    const targetBefore = fs.readFileSync(transcript(BETA), 'utf8');

    const result = await moveSession(SID, ALPHA, BETA);

    expect(result).toMatchObject({ success: false, code: 'collision' });
    expect(fs.existsSync(transcript(ALPHA))).toBe(true);
    expect(fs.readFileSync(transcript(BETA), 'utf8')).toBe(targetBefore);
  });

  test('refuses an unknown session', async () => {
    writeSession(ALPHA);
    expect(await moveSession('nope', ALPHA, BETA)).toMatchObject({ success: false, code: 'not-found' });
  });

  test('refuses a move onto the same project', async () => {
    writeSession(ALPHA);
    const result = await moveSession(SID, ALPHA, ALPHA);

    expect(result).toMatchObject({ success: false, code: 'same-project' });
    expect(fs.existsSync(transcript(ALPHA))).toBe(true);
  });

  test('refuses incomplete arguments', async () => {
    expect(await moveSession('', ALPHA, BETA)).toMatchObject({ success: false, code: 'bad-request' });
    expect(await moveSession(SID, ALPHA, '')).toMatchObject({ success: false, code: 'bad-request' });
  });

  test('reports sidecars left behind in other projects', async () => {
    writeSession(ALPHA);
    // The same session also ran under GAMMA at some point
    writeSidecar(GAMMA);

    const result = await moveSession(SID, ALPHA, BETA);

    expect(result.success).toBe(true);
    expect(result.warnings).toContain('left-sidecars:1');
    // They belong to the runs that happened there, so they stay put
    expect(fs.existsSync(sidecar(GAMMA))).toBe(true);
  });

  test('says nothing about strays when there are none', async () => {
    writeSession(ALPHA);
    writeSidecar(ALPHA);

    expect((await moveSession(SID, ALPHA, BETA)).warnings).toEqual([]);
  });
});

describe('findStraySidecars', () => {
  test('finds sidecars outside the ignored directories', async () => {
    writeSession(ALPHA);
    writeSidecar(GAMMA);

    expect(await findStraySidecars(SID, [dirFor(ALPHA)])).toEqual([sidecar(GAMMA)]);
    expect(await findStraySidecars(SID, [dirFor(ALPHA), dirFor(GAMMA)])).toEqual([]);
  });
});
