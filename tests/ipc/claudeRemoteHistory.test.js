/**
 * @jest-environment node
 *
 * Session history of remote (SSH) projects (design/remote-ssh.md section 5.3).
 *
 * A remote project's transcripts live on its host. claude.ipc.js reads them
 * over the command channel and feeds the same parsers as a local transcript,
 * so the claim to hold is simple: the same transcripts give the same
 * sessions, history, replay, changes and tool output, local or remote. Then
 * the costs: a tail-first history read only asks the host for the tail, and a
 * listing is one request, cached by (profile, project path, directory mtime).
 * And the failure mode: a host that is not connected answers a `disconnected`
 * marker, never an empty list as if there were no history.
 *
 * The remote side is the in-memory adapter of tests/helpers/memoryRemoteFs.js,
 * and once more the real `remoteFs` over a real local sh, which also checks
 * the shell listing against the adapter's rendition of it.
 */

const realOs = require('os');
const fs = require('fs');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-remote-history-'));
global.__CT_TMP_HOME__ = TMP_HOME;

const mockHandlers = new Map();
jest.mock('electron', () => ({
  ipcMain: { handle: (channel, fn) => mockHandlers.set(channel, fn), removeHandler: jest.fn() },
}));
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => global.__CT_TMP_HOME__,
}));

const claudeIpc = require('../../src/main/ipc/claude.ipc');
const { encodeProjectPath } = require('../../src/shared/session-dirs');
const remotePathLib = require('../../src/shared/remote-path');
const { createRemoteFs, parseSessionListing, SESSION_LISTING } = require('../../src/main/utils/remoteFs');
const { createMemoryRemoteFs } = require('../helpers/memoryRemoteFs');
const { SshLane } = require('../../src/main/utils/sshChannel');
const { findSh, toShPath, FAKE_SSH } = require('../helpers/fake-ssh');

claudeIpc.registerClaudeHandlers();
const invoke = (channel, ...args) => mockHandlers.get(channel)({ sender: {} }, ...args);

const LOCAL_PATH = '/tmp/remote-history-local';
const REMOTE_HOME = '/home/yanis';
const REMOTE_PATH = '/home/yanis/api';
const PROFILE = 'abcd1234';
const URI = `ssh-remote://${PROFILE}${REMOTE_PATH}`;
const LOCAL_DIR = path.join(TMP_HOME, '.claude', 'projects', encodeProjectPath(LOCAL_PATH));
const REMOTE_DIR = `${REMOTE_HOME}/.claude/projects/${encodeProjectPath(REMOTE_PATH)}`;

const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const SID_BIG = 'cccccccc-1111-2222-3333-444444444444';
const SID_SIDE = 'dddddddd-1111-2222-3333-444444444444';

// ── Fixture transcripts ─────────────────────────────────────────────────────

let clock = Date.UTC(2026, 8, 1, 10, 0, 0);
const ts = () => new Date((clock += 1000)).toISOString();

const userLine = (sid, i, text) => JSON.stringify({
  type: 'user', uuid: `u-${sid}-${i}`, sessionId: sid, gitBranch: 'main', timestamp: ts(),
  message: { role: 'user', content: text ?? `prompt ${i}` },
});
const assistantLine = (sid, i, extra = {}) => JSON.stringify({
  type: 'assistant', uuid: `a-${sid}-${i}`, sessionId: sid, timestamp: ts(),
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: `thinking ${i}` },
      { type: 'tool_use', id: `t-${sid}-${i}`, name: 'Bash', input: { command: `echo ${i}` } },
      { type: 'text', text: `answer ${i}` },
    ],
    ...extra,
  },
});
const resultLine = (sid, i, output) => JSON.stringify({
  type: 'user', uuid: `r-${sid}-${i}`, sessionId: sid, timestamp: ts(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${sid}-${i}`, content: output ?? `out ${i}` }] },
});
const editCall = (sid, id, file) => JSON.stringify({
  type: 'assistant', sessionId: sid, timestamp: ts(),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }] },
});
const editResult = (sid, id, file) => JSON.stringify({
  type: 'user', sessionId: sid, timestamp: ts(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  toolUseResult: { filePath: file, structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }] },
});

function conversation(sid, turns, fatEvery = 0, fatBytes = 0) {
  const lines = [];
  for (let i = 0; i < turns; i++) {
    lines.push(userLine(sid, i));
    lines.push(assistantLine(sid, i, i === turns - 1 ? { usage: { input_tokens: 5, cache_read_input_tokens: 1234 } } : {}));
    // Fat results only past the first ten turns: a listing reads the head of a
    // transcript up to a byte cap, and these fixtures stay under it
    const fat = fatEvery && i >= 10 && i % fatEvery === 0;
    lines.push(resultLine(sid, i, fat ? `out ${i} ` + 'x'.repeat(fatBytes) : undefined));
  }
  return lines;
}

const TRANSCRIPTS = {
  [`${SID_A}.jsonl`]: [
    ...conversation(SID_A, 12),
    editCall(SID_A, 'e1', '/home/yanis/api/src/a.js'),
    editResult(SID_A, 'e1', '/home/yanis/api/src/a.js'),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the parser', sessionId: SID_A }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My parser fix', sessionId: SID_A }),
    userLine(SID_A, 99, 'one more thing'),
  ].join('\n') + '\n',
  // Renamed: the id is only inside
  'renamed-transcript.jsonl': conversation(SID_B, 3).join('\n') + '\n',
  // Long enough that history must be read from the end
  [`${SID_BIG}.jsonl`]: conversation(SID_BIG, 400, 3, 16000).join('\n') + '\n',
  // A subagent's own transcript: never listed
  [`${SID_SIDE}.jsonl`]: JSON.stringify({ type: 'user', isSidechain: true, sessionId: SID_SIDE, message: { role: 'user', content: 'sub' } }) + '\n' + 'x'.repeat(300) + '\n',
  // Too small to be a conversation
  'tiny.jsonl': '{"type":"user"}\n',
};
const INDEX = JSON.stringify({ entries: [{ sessionId: SID_A, summary: 'Parser work', messageCount: 77 }] });

// Distinct whole-second mtimes, oldest first
const MTIMES = {};
Object.keys(TRANSCRIPTS).forEach((name, i) => { MTIMES[name] = 1790000000 + i * 60; });

function writeLocal() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  for (const [name, body] of Object.entries(TRANSCRIPTS)) {
    const file = path.join(LOCAL_DIR, name);
    fs.writeFileSync(file, body, 'utf8');
    fs.utimesSync(file, MTIMES[name], MTIMES[name]);
  }
  fs.writeFileSync(path.join(LOCAL_DIR, 'sessions-index.json'), INDEX, 'utf8');
}

function memoryHost() {
  const mem = createMemoryRemoteFs();
  for (const [name, body] of Object.entries(TRANSCRIPTS)) mem.writeFile(`${REMOTE_DIR}/${name}`, body, MTIMES[name] * 1000);
  mem.writeFile(`${REMOTE_DIR}/sessions-index.json`, INDEX, 1790000000 * 1000);
  return mem;
}

/** Wire claude.ipc to a remote fs, a host state and a clock. */
function useHost(remoteFs, { state = 'connected', capabilities = { home: REMOTE_HOME }, now = () => 0 } = {}) {
  const status = { state, capabilities };
  const deps = {
    resolveTarget: jest.fn(async (uri) => {
      const { profileId, path: p } = remotePathLib.parse(uri);
      return { kind: 'remote', profileId, remotePath: p, host: 'yanis@build', uri };
    }),
    getStatus: jest.fn(() => status),
    createFs: jest.fn(() => remoteFs),
    now,
  };
  claudeIpc._setRemoteDeps(deps);
  return { deps, status };
}

const withoutCwd = (sessions) => sessions.map(({ cwd, ...rest }) => rest);

beforeAll(writeLocal);
afterAll(() => {
  claudeIpc._setRemoteDeps(null);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

// ── Same results, local or remote ───────────────────────────────────────────

describe('the remote readers give what the local ones give', () => {
  let mem;
  beforeEach(() => {
    mem = memoryHost();
    useHost(mem);
  });

  test('sessions', async () => {
    const local = await claudeIpc.getClaudeSessions(LOCAL_PATH);
    const remote = await claudeIpc.getClaudeSessions(URI);
    expect(local.map(s => s.sessionId).sort()).toEqual([SID_A, SID_B, SID_BIG].sort());
    expect(withoutCwd(remote)).toEqual(withoutCwd(local));
    // A remote session resumes where it lives: the project, on its host
    for (const s of remote) expect(s.cwd).toBe(URI);
    const a = remote.find(s => s.sessionId === SID_A);
    expect(a).toMatchObject({ customTitle: 'My parser fix', aiTitle: 'Fix the parser', summary: 'Parser work', messageCount: 77 });
  });

  test('history, tail-first and sequential, and a fork point', async () => {
    for (const sid of [SID_A, SID_B, SID_BIG]) {
      expect(await claudeIpc.loadSessionHistory(URI, sid)).toEqual(await claudeIpc.loadSessionHistory(LOCAL_PATH, sid));
      expect(await claudeIpc.loadSessionHistory(URI, sid, { limit: 0 })).toEqual(await claudeIpc.loadSessionHistory(LOCAL_PATH, sid, { limit: 0 }));
    }
    const until = `u-${SID_BIG}-7`;
    expect(await claudeIpc.loadSessionHistory(URI, SID_BIG, { limit: 50, until }))
      .toEqual(await claudeIpc.loadSessionHistory(LOCAL_PATH, SID_BIG, { limit: 50, until }));
  });

  test('replay, changes, tool output and export', async () => {
    for (const sid of [SID_A, SID_B]) {
      expect(await claudeIpc.parseSessionReplay(URI, sid)).toEqual(await claudeIpc.parseSessionReplay(LOCAL_PATH, sid));
      expect(await claudeIpc.parseSessionFileChanges(URI, sid)).toEqual(await claudeIpc.parseSessionFileChanges(LOCAL_PATH, sid));
    }
    expect(await claudeIpc.parseSessionReplay(URI, SID_BIG, { offset: 100, limit: 20 }))
      .toEqual(await claudeIpc.parseSessionReplay(LOCAL_PATH, SID_BIG, { offset: 100, limit: 20 }));
    const changes = await claudeIpc.parseSessionFileChanges(URI, SID_A);
    expect(changes.files.map(f => f.path)).toEqual(['/home/yanis/api/src/a.js']);
    expect(await claudeIpc.loadToolResultOutput(URI, SID_BIG, `t-${SID_BIG}-3`))
      .toEqual(await claudeIpc.loadToolResultOutput(LOCAL_PATH, SID_BIG, `t-${SID_BIG}-3`));
    for (const format of ['markdown', 'json']) {
      expect(await claudeIpc.exportSession(URI, SID_A, format)).toEqual(await claudeIpc.exportSession(LOCAL_PATH, SID_A, format));
    }
  });

  test('a renamed transcript is found by the id inside it', async () => {
    const res = await claudeIpc.loadSessionHistory(URI, SID_B);
    expect(res.messages.length).toBeGreaterThan(0);
  });

  test('an unknown or path-like session id finds nothing', async () => {
    expect(await claudeIpc.loadSessionHistory(URI, 'nope')).toEqual({ messages: [], total: 0, truncated: false, contextTokens: 0 });
    expect(await claudeIpc.loadSessionHistory(URI, '../../.ssh/id_ed25519')).toEqual({ messages: [], total: 0, truncated: false, contextTokens: 0 });
  });
});

// ── Costs ───────────────────────────────────────────────────────────────────

describe('what is asked of the host', () => {
  test('a tail-first history read only requests the tail of the transcript', async () => {
    const mem = memoryHost();
    useHost(mem);
    const size = Buffer.byteLength(TRANSCRIPTS[`${SID_BIG}.jsonl`]);
    expect(size).toBeGreaterThan(2 * 1024 * 1024);
    mem.calls.readRange.length = 0;
    const res = await claudeIpc.loadSessionHistory(URI, SID_BIG, { limit: 20 });
    expect(res.truncated).toBe(true);
    const ranges = mem.calls.readRange.filter(r => r.path === `${REMOTE_DIR}/${SID_BIG}.jsonl`);
    expect(ranges.length).toBeGreaterThan(0);
    const lowest = Math.min(...ranges.map(r => r.start));
    // Nothing before the last megabyte, and every range ends inside the file
    expect(lowest).toBeGreaterThan(size - 1024 * 1024);
    for (const r of ranges) expect(r.start + r.length).toBeLessThanOrEqual(size);
  });

  test('a listing is one request, reused while the directory mtime holds', async () => {
    const mem = memoryHost();
    let now = 1000;
    useHost(mem, { now: () => now });
    await claudeIpc.getClaudeSessions(URI);
    await claudeIpc.getClaudeSessions(URI);
    expect(mem.calls.listSessionFiles).toBe(1);

    // A new transcript moves the directory mtime: listed again
    mem.writeFile(`${REMOTE_DIR}/eeeeeeee-1111-2222-3333-444444444444.jsonl`, conversation('eeeeeeee-1111-2222-3333-444444444444', 2).join('\n') + '\n', 1799999999000);
    const after = await claudeIpc.getClaudeSessions(URI);
    expect(mem.calls.listSessionFiles).toBe(2);
    expect(after.map(s => s.sessionId)).toContain('eeeeeeee-1111-2222-3333-444444444444');

    // Same mtime but time has passed: appends to a transcript show up too
    now += 60 * 1000;
    await claudeIpc.getClaudeSessions(URI);
    expect(mem.calls.listSessionFiles).toBe(3);
  });

  test('the cache is per profile and per project path', async () => {
    const mem = memoryHost();
    // A second project of the same host, and the same path on another host
    mem.writeFile(`${REMOTE_HOME}/.claude/projects/${encodeProjectPath('/home/yanis/web')}/${SID_A}.jsonl`, TRANSCRIPTS[`${SID_A}.jsonl`], MTIMES[`${SID_A}.jsonl`] * 1000);
    useHost(mem);
    await claudeIpc.getClaudeSessions(URI);
    await claudeIpc.getClaudeSessions(`ssh-remote://${PROFILE}/home/yanis/web`);
    await claudeIpc.getClaudeSessions(`ssh-remote://zzzz9999${REMOTE_PATH}`);
    expect(mem.calls.listSessionFiles).toBe(3);
  });

  test('a head cut by the byte cap drops only its partial last line', async () => {
    const mem = memoryHost();
    const sid = 'ffffffff-1111-2222-3333-444444444444';
    const body = [userLine(sid, 0, 'first prompt'), resultLine(sid, 0, 'y'.repeat(SESSION_LISTING.headBytes + 10)), userLine(sid, 1)].join('\n') + '\n';
    mem.writeFile(`${REMOTE_DIR}/${sid}.jsonl`, body, 1795000000000);
    useHost(mem);
    const listed = (await claudeIpc.getClaudeSessions(URI)).find(s => s.sessionId === sid);
    // The listing pays the head cap, not the transcript: the first prompt and
    // id are there, the line it cut is not counted
    expect(listed).toMatchObject({ firstPrompt: 'first prompt', messageCount: 1 });
  });

  test('a project that never ran a session lists nothing, without an error', async () => {
    useHost(memoryHost());
    expect(await claudeIpc.getClaudeSessions(`ssh-remote://${PROFILE}/home/yanis/empty`)).toEqual([]);
  });
});

// ── Disconnected, delete, move ──────────────────────────────────────────────

describe('when the host is not connected', () => {
  test("the listing says so, so the UI can say where the history is", async () => {
    const mem = memoryHost();
    useHost(mem, { state: 'reconnecting' });
    expect(await invoke('claude-sessions', URI, { withStatus: true })).toEqual({ sessions: [], disconnected: true, host: 'yanis@build', state: 'reconnecting' });
    // Callers that never asked for the status keep getting an array
    expect(await invoke('claude-sessions', URI)).toEqual([]);
    expect(mem.calls.listSessionFiles).toBe(0);
  });

  test('the readers fail with the disconnected marker, not an empty history', async () => {
    useHost(memoryHost(), { state: 'idle' });
    const res = await invoke('chat-load-history', { projectPath: URI, sessionId: SID_A });
    expect(res).toMatchObject({ success: false, disconnected: true, host: 'yanis@build', messages: [] });
    expect(await invoke('claude-session-replay', { projectPath: URI, sessionId: SID_A })).toMatchObject({ success: false, disconnected: true });
    expect(await invoke('claude-session-changes', { projectPath: URI, sessionId: SID_A })).toMatchObject({ success: false, disconnected: true });
  });

  test('a transport failure mid-listing is reported as disconnected too', async () => {
    const mem = memoryHost();
    mem.listSessionFiles = async () => { throw Object.assign(new Error('Remote session listing failed: disconnected'), { code: 'EREMOTE', reason: 'disconnected' }); };
    useHost(mem);
    expect(await invoke('claude-sessions', URI, { withStatus: true })).toMatchObject({ disconnected: true, sessions: [] });
  });

  test('a local project is answered as before, whatever the hosts do', async () => {
    useHost(memoryHost(), { state: 'idle' });
    const sessions = await invoke('claude-sessions', LOCAL_PATH);
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBe(3);
  });
});

describe('delete and move', () => {
  test('delete runs rm on the host and drops the cached listing', async () => {
    const mem = memoryHost();
    useHost(mem);
    expect((await claudeIpc.getClaudeSessions(URI)).map(s => s.sessionId)).toContain(SID_B);
    const res = await invoke('claude-delete-session', { projectPath: URI, sessionId: SID_B });
    expect(res).toEqual({ success: true });
    expect(mem.calls.rm).toEqual([`${REMOTE_DIR}/renamed-transcript.jsonl`]);
    expect((await claudeIpc.getClaudeSessions(URI)).map(s => s.sessionId)).not.toContain(SID_B);
  });

  test('moving a session is refused for a remote project, with a reason', async () => {
    useHost(memoryHost());
    for (const [from, to] of [[URI, LOCAL_PATH], [LOCAL_PATH, URI]]) {
      const res = await invoke('claude-move-session', { sessionId: SID_A, fromProjectPath: from, toProjectPath: to });
      expect(res).toMatchObject({ success: false, code: 'remote' });
      expect(res.error).toMatch(/remote/);
    }
    // The local transcript did not move
    expect(fs.existsSync(path.join(LOCAL_DIR, `${SID_A}.jsonl`))).toBe(true);
  });
});

// ── Over a real channel ─────────────────────────────────────────────────────

const SH = findSh();
const describeSh = SH ? describe : describe.skip;

describeSh('over the real remoteFs and a real sh', () => {
  jest.setTimeout(60000);
  let lane;
  let hostHome;
  let shHome;
  let realDir;

  beforeAll(async () => {
    hostHome = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-remote-host-'));
    shHome = toShPath(hostHome);
    realDir = path.join(hostHome, '.claude', 'projects', encodeProjectPath(REMOTE_PATH));
    fs.mkdirSync(realDir, { recursive: true });
    for (const [name, body] of Object.entries(TRANSCRIPTS)) {
      const file = path.join(realDir, name);
      fs.writeFileSync(file, body, 'utf8');
      fs.utimesSync(file, MTIMES[name], MTIMES[name]);
    }
    fs.writeFileSync(path.join(realDir, 'sessions-index.json'), INDEX, 'utf8');
    lane = new SshLane({ command: process.execPath, args: [FAKE_SSH], env: { ...process.env, FAKE_SSH_SH: SH } });
    await lane.open();
  });

  afterAll(() => {
    if (lane) lane.close();
    fs.rmSync(hostHome, { recursive: true, force: true });
  });

  function realFs() {
    return createRemoteFs({ exec: (script, opts) => lane.request(script, opts) });
  }

  test('the shell listing matches the in-memory rendition of it', async () => {
    const rfs = realFs();
    const dir = `${shHome}/.claude/projects/${encodeProjectPath(REMOTE_PATH)}`;
    const real = await rfs.listSessionFiles(dir);
    const mem = await memoryHost().listSessionFiles(REMOTE_DIR);
    const shape = (listing) => listing.files.map(({ name, size, mtimeMs, head, headTruncated, hints }) => ({ name, size, mtimeMs, head, headTruncated, hints }));
    expect(shape(real)).toEqual(shape(mem));
    expect(real.index).toBe(INDEX);
  });

  test('sessions and history read over the channel equal the local ones', async () => {
    useHost(realFs(), { capabilities: { home: shHome } });
    const local = await claudeIpc.getClaudeSessions(LOCAL_PATH);
    const remote = await claudeIpc.getClaudeSessions(URI);
    expect(withoutCwd(remote)).toEqual(withoutCwd(local));
    expect(await claudeIpc.loadSessionHistory(URI, SID_BIG, { limit: 30 })).toEqual(await claudeIpc.loadSessionHistory(LOCAL_PATH, SID_BIG, { limit: 30 }));
    expect(await claudeIpc.parseSessionFileChanges(URI, SID_A)).toEqual(await claudeIpc.parseSessionFileChanges(LOCAL_PATH, SID_A));
  });

  test('a missing directory is an empty listing', async () => {
    await expect(realFs().listSessionFiles(`${shHome}/.claude/projects/nothing-here`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('parseSessionListing', () => {
  test('drops nothing but malformed hint lines, and reports a cut head', () => {
    const head = 'x'.repeat(10);
    const NUL = '\u0000';
    const buf = Buffer.from([
      '10 1790000000', '{"entries":[]}',
      'a.jsonl', '500 1790000060', head, '2\t{"t":1}\nbad\n1\t{"t":0}\n',
    ].join(NUL) + NUL, 'utf8');
    const listing = parseSessionListing(buf, { ...SESSION_LISTING, headBytes: 10 });
    expect(listing.dirMtimeMs).toBe(1790000000000);
    expect(listing.index).toBe('{"entries":[]}');
    expect(listing.files).toEqual([{ name: 'a.jsonl', size: 500, mtimeMs: 1790000060000, head, headTruncated: true, hints: [{ n: 1, text: '{"t":0}' }, { n: 2, text: '{"t":1}' }] }]);
  });
});
