// parseSessionFileChanges: reconstruct a session's file edits from its transcript.
//
// Claude Code writes the patch it applied next to every edit, as
// `toolUseResult.structuredPatch` — real hunks with exact line numbers. So the
// parser's job is to pair each call with its result and add the numbers up, not
// to re-derive a diff. These tests pin that pairing, the counting, and the
// id-based dedupe that stops a subagent edit landing twice.

const realOs = require('os');
const fs = require('fs');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ct-session-changes-'));

jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn(), removeHandler: jest.fn() }
}));

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => global.__CT_TMP_HOME__
}));

global.__CT_TMP_HOME__ = TMP_HOME;

const { parseSessionFileChanges } = require('../../src/main/ipc/claude.ipc');

const PROJECT_PATH = '/tmp/changes-project';
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const FILE_A = '/tmp/changes-project/a.js';

function sessionsDir() {
  return path.join(TMP_HOME, '.claude', 'projects', PROJECT_PATH.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** A hunk in structuredPatch shape. `lines` carry their own +/-/space prefix. */
function hunk(oldStart, lines, newStart = oldStart) {
  return {
    oldStart,
    oldLines: lines.filter(l => l[0] !== '+').length,
    newStart,
    newLines: lines.filter(l => l[0] !== '-').length,
    lines,
  };
}

/**
 * Write a transcript. Each edit becomes two lines: the assistant's tool_use,
 * then the user line carrying the tool_result and its toolUseResult sibling —
 * which is exactly how Claude Code lays it out.
 */
function writeSession(edits, { sessionId = SESSION_ID } = {}) {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];

  edits.forEach((e, i) => {
    const id = e.id || `t-${i}`;
    lines.push(JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
      ...(e.isSidechain ? { isSidechain: true } : {}),
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: e.name, input: e.input }],
      },
    }));
    if (e.patch === null) return; // an edit whose result never landed
    lines.push(JSON.stringify({
      type: 'user',
      sessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      toolUseResult: {
        filePath: e.input.file_path || e.input.notebook_path,
        structuredPatch: e.patch,
        ...(e.resultType ? { type: e.resultType } : {}),
        ...(e.resultContent !== undefined ? { content: e.resultContent } : {}),
      },
    }));
  });

  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}

// maxRetries because Windows will not unlink a file whose handle has just been
// released — the parser destroys its stream, but the OS can lag a tick behind.
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

afterEach(() => rmDir(sessionsDir()));
afterAll(() => rmDir(TMP_HOME));

describe('parseSessionFileChanges', () => {
  test('returns an empty result when the session file is missing', async () => {
    const res = await parseSessionFileChanges(PROJECT_PATH, 'no-such-session');
    expect(res.files).toEqual([]);
    expect(res.totals.files).toBe(0);
  });

  test('keeps the tool\'s own hunks, line numbers included', async () => {
    writeSession([{
      name: 'Edit',
      input: { file_path: FILE_A, old_string: 'x', new_string: 'y' },
      patch: [hunk(633, ['   const options = {', '-  maxTurns: 100,', '+  ...(maxTurns ? { maxTurns } : {}),', '   includePartial: true,'])],
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ path: FILE_A, additions: 1, deletions: 1, edits: 1 });
    // Exactly what the tool reported — nothing recomputed.
    expect(res.files[0].hunks[0]).toEqual({
      oldStart: 633, oldLines: 3, newStart: 633, newLines: 3,
      lines: ['   const options = {', '-  maxTurns: 100,', '+  ...(maxTurns ? { maxTurns } : {}),', '   includePartial: true,'],
    });
  });

  test('counts additions and deletions across several hunks', async () => {
    writeSession([{
      name: 'Edit',
      input: { file_path: FILE_A, old_string: 'x', new_string: 'y' },
      patch: [
        hunk(10, ['-a', '-b', '+c']),
        hunk(40, [' keep', '+d', '+e']),
      ],
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files[0]).toMatchObject({ additions: 3, deletions: 2 });
    expect(res.files[0].hunks).toHaveLength(2);
  });

  test('accumulates several edits to the same file', async () => {
    writeSession([
      { name: 'Edit', input: { file_path: FILE_A, old_string: 'a', new_string: 'A' }, patch: [hunk(1, ['-a', '+A'])] },
      { name: 'Edit', input: { file_path: FILE_A, old_string: 'b', new_string: 'B' }, patch: [hunk(9, ['-b', '+B'])] },
    ]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ edits: 2, additions: 2, deletions: 2 });
    expect(res.files[0].hunks).toHaveLength(2);
  });

  test('treats a Write that rewrites a file as an ordinary patch', async () => {
    writeSession([{
      name: 'Write',
      resultType: 'update',
      input: { file_path: '/tmp/changes-project/new.txt', content: 'one\ntwo\nthree' },
      patch: [hunk(1, ['+one', '+two', '+three'])],
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files[0]).toMatchObject({ additions: 3, deletions: 0, edits: 1 });
  });

  test('builds the patch for a created file from its content', async () => {
    // A Write that creates a file reports type:"create" with an EMPTY
    // structuredPatch — there was no previous version to diff. Taking that
    // literally showed "+0 -0, no diff available" on every file a session
    // added, which is exactly the file you want to look at.
    writeSession([{
      name: 'Write',
      resultType: 'create',
      resultContent: 'line one\nline two\nline three',
      input: { file_path: '/tmp/changes-project/created.js', content: 'line one\nline two\nline three' },
      patch: [],
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files[0]).toMatchObject({ additions: 3, deletions: 0, edits: 1 });
    expect(res.files[0].hunks).toEqual([{
      oldStart: 0, oldLines: 0, newStart: 1, newLines: 3,
      lines: ['+line one', '+line two', '+line three'],
    }]);
  });

  test('an empty created file yields no hunk', async () => {
    writeSession([{
      name: 'Write',
      resultType: 'create',
      resultContent: '',
      input: { file_path: '/tmp/changes-project/empty.txt', content: '' },
      patch: [],
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files[0]).toMatchObject({ additions: 0, deletions: 0, edits: 1 });
    expect(res.files[0].hunks).toEqual([]);
  });

  test('caps a created file that is enormous', async () => {
    const content = Array.from({ length: 3500 }, (_, i) => `line ${i}`).join('\n');
    writeSession([{
      name: 'Write',
      resultType: 'create',
      resultContent: content,
      input: { file_path: '/tmp/changes-project/huge.txt', content },
      patch: [],
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files[0].hunks[0].lines).toHaveLength(3000);
  });

  test('ignores tools that do not write files', async () => {
    writeSession([
      { name: 'Bash', input: { command: 'ls' }, patch: [hunk(1, ['+nope'])] },
      { name: 'Read', input: { file_path: FILE_A }, patch: [hunk(1, ['+nope'])] },
    ]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files).toEqual([]);
  });

  test('counts a repeated tool_use id once', async () => {
    // A subagent edit reaches the transcript twice: streamed, then in the full
    // assistant message. Without the id guard the edit count doubles.
    const input = { file_path: '/tmp/changes-project/dup.js', old_string: 'o', new_string: 'n' };
    writeSession([
      { name: 'Edit', id: 'same-id', input, patch: null },
      { name: 'Edit', id: 'same-id', input, patch: [hunk(1, ['-o', '+n'])] },
    ]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files[0].edits).toBe(1);
    expect(res.files[0].hunks).toHaveLength(1);
  });

  test('keeps a file whose result never arrived, with zeroed counters', async () => {
    // Session cut mid-call: the file was still touched, so it must not vanish.
    writeSession([{
      name: 'Edit',
      input: { file_path: FILE_A, old_string: 'a', new_string: 'b' },
      patch: null,
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ edits: 1, additions: 0, deletions: 0 });
    expect(res.files[0].hunks).toEqual([]);
  });

  test('flags subagent edits and keeps the last timestamp', async () => {
    writeSession([{
      name: 'Edit',
      isSidechain: true,
      input: { file_path: '/tmp/changes-project/sub.js', old_string: 'x', new_string: 'y' },
      patch: [hunk(1, ['-x', '+y'])],
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files[0].viaSubagent).toBe(true);
    expect(res.files[0].lastEditedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('statsOnly keeps the counters and drops the hunks', async () => {
    writeSession([{
      name: 'Edit',
      input: { file_path: FILE_A, old_string: 'a', new_string: 'b' },
      patch: [hunk(5, ['-a', '+b'])],
    }]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID, { statsOnly: true });
    expect(res.files[0]).toMatchObject({ additions: 1, deletions: 1 });
    expect(res.files[0].hunks).toEqual([]);
  });

  test('sorts files by churn and totals them', async () => {
    writeSession([
      { name: 'Write', input: { file_path: '/tmp/changes-project/small.txt', content: 'a' }, patch: [hunk(1, ['+a'])] },
      { name: 'Write', input: { file_path: '/tmp/changes-project/big.txt', content: 'a\nb\nc\nd' }, patch: [hunk(1, ['+a', '+b', '+c', '+d'])] },
    ]);

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files.map(f => f.path)).toEqual([
      '/tmp/changes-project/big.txt',
      '/tmp/changes-project/small.txt',
    ]);
    expect(res.totals).toMatchObject({ files: 2, additions: 5, deletions: 0, edits: 2 });
  });

  test('ignores a patch whose editing call was never seen', async () => {
    // Only a result line, with no tool_use to tie it to. Trusting the result's
    // own filePath here is what let a Read's patch into the list.
    const dir = sessionsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION_ID}.jsonl`), JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan', content: 'ok' }] },
      toolUseResult: { filePath: FILE_A, structuredPatch: [hunk(3, ['-a', '+b'])] },
    }) + '\n');

    const res = await parseSessionFileChanges(PROJECT_PATH, SESSION_ID);
    expect(res.files).toEqual([]);
  });
});
